import type { RetryConfig } from '../types.js';

export type RetryableErrorType =
  | 'timeout'
  | 'rate_limit'
  | 'network'
  | 'service_down'
  | 'tool_error'
  | 'parse_error'
  | 'unknown';

// 值得重试的底层网络错误码：Node 把真实原因放在 err.cause.code 里
const NETWORK_CODES = new Set([
  'ECONNRESET',
  'ECONNREFUSED',
  'ENOTFOUND',
  'EAI_AGAIN',
  'ETIMEDOUT',
  'ECONNABORTED',
  'EPIPE',
  'EHOSTUNREACH',
  'ENETUNREACH',
  'UND_ERR_SOCKET',
  'UND_ERR_CONNECT_TIMEOUT',
]);

type ErrorMeta = Error & {
  code?: string;
  status?: number;
  statusCode?: number;
  retryAfterMs?: number;
  cause?: unknown;
};

function readStatusCode(err: Error): number | null {
  const meta = err as ErrorMeta;
  const direct = meta.status ?? meta.statusCode;
  if (typeof direct === 'number' && direct >= 100 && direct < 600) return direct;
  // 兼容适配器与历史调用方拼在 message 里的状态码（"LLM API error 520: ..."）
  const match = /(?:LLM API error|HTTP|error)\s+(\d{3})\b/i.exec(err.message);
  return match ? Number.parseInt(match[1], 10) : null;
}

function readNetworkCode(err: unknown, depth = 0): string | null {
  if (!(err instanceof Error) || depth > 3) return null;
  const meta = err as ErrorMeta;
  const code = typeof meta.code === 'string' ? meta.code.toUpperCase() : '';
  if (code && NETWORK_CODES.has(code)) return code;
  return meta.cause ? readNetworkCode(meta.cause, depth + 1) : null;
}

// 错误分类：根据错误特征判断是否属于可重试类型
// 国产 API 错误格式未统一，采用关键词匹配保持兼容；HTTP 状态码优先于文本特征。
// unknown 表示确定性错误（认证失败/参数错误等），withRetry 不会重试。
export function classifyError(err: unknown): RetryableErrorType {
  if (!(err instanceof Error)) return 'unknown';

  // 1) HTTP 状态码：429 限流，5xx 服务端故障，其余 4xx 视为确定性错误
  const status = readStatusCode(err);
  if (status === 429) return 'rate_limit';
  if (status !== null && status >= 500) return 'service_down';
  if (status !== null) return 'unknown';

  const name = err.name.toLowerCase();
  const msg = err.message.toLowerCase();

  // 2) 显式超时/中止类型（Adapter 的 TimeoutError、DOMException AbortError）优先于网络码判断：
  //    两者都可能带 ETIMEDOUT 码，但语义是"本次请求超时"，应与网络抖动区分。
  if (name === 'timeouterror' || name.includes('abort') || name.includes('timeout')) return 'timeout';

  // 3) 网络错误：原生 fetch 只抛 "TypeError: fetch failed"，真实原因在 cause.code
  if (readNetworkCode(err) || /fetch failed|network error|socket hang up|other side closed/i.test(err.message)) {
    return 'network';
  }

  // 4) 文本层面的超时特征
  if (msg.includes('timeout') || msg.includes('etimedout') || msg.includes('aborted')) {
    return 'timeout';
  }

  if (msg.includes('rate_limit') || msg.includes('rate limit') || msg.includes('too many requests')) return 'rate_limit';
  if (name.includes('tool') || msg.includes('tool')) return 'tool_error';
  if (err instanceof SyntaxError || msg.includes('parse') || msg.includes('unexpected token')) return 'parse_error';
  return 'unknown';
}

function readRetryAfterMs(err: unknown): number | null {
  if (!(err instanceof Error)) return null;
  const value = (err as ErrorMeta).retryAfterMs;
  return typeof value === 'number' && Number.isFinite(value) && value >= 0 ? value : null;
}

// 指数退避重试：delay = min(maxDelayMs, baseDelayMs * 2^attempt) + random(0, 1000)
// 抖动（jitter）避免多实例同时重试引发雷群效应。
// 服务端显式给出 retryAfterMs（429 Retry-After）时优先遵守；超过 maxDelayMs 直接抛，
// 避免为了一个远期重试把整个请求挂死。
// signal：用户主动停止时不重试——中止语义优先于网络自愈。
export async function withRetry<T>(fn: () => Promise<T>, config: RetryConfig, signal?: AbortSignal): Promise<T> {
  let lastError: unknown;
  for (let attempt = 0; attempt <= config.maxRetries; attempt++) {
    try {
      return await fn();
    } catch (err) {
      lastError = err;

      if (signal?.aborted) throw err;

      // 空数组表示不重试任何错误（符合常见约定）
      if (config.retryOn.length === 0) {
        throw err;
      }

      const errorType = classifyError(err);
      // errorType 为 'unknown' 或不在 retryOn 列表中时，不重试
      // 类型守卫：先排除 'unknown' 再 includes，避免 TS 类型不兼容
      if (errorType === 'unknown' || !config.retryOn.includes(errorType as Exclude<RetryableErrorType, 'unknown'>)) {
        throw err;
      }

      if (attempt === config.maxRetries) break;

      const retryAfterMs = readRetryAfterMs(err);
      if (retryAfterMs !== null) {
        if (retryAfterMs > config.maxDelayMs) throw err;
        await new Promise(resolve => setTimeout(resolve, retryAfterMs));
        continue;
      }

      const exponentialDelay = Math.min(config.maxDelayMs, config.baseDelayMs * Math.pow(2, attempt));
      const jitter = Math.random() * 1000;
      await new Promise(resolve => setTimeout(resolve, exponentialDelay + jitter));
    }
  }
  throw lastError;
}
