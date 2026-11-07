// LLM 错误友好化工具
// 为什么需要：wiki-harness 抛出的原始错误含完整 HTML（Cloudflare 520 页面），
// 直接透传给前端会让用户看到几十 KB 的 HTML 文本，无法定位问题。

// 已知 LLM provider 故障特征 URL/状态码
// 为什么用映射：不同 provider 故障特征不同，按 provider 分类更精准
const PROVIDER_FAULT_PATTERNS: Record<string, RegExp> = {
  // Cloudflare 5xx 错误页面特征
  cloudflare: /cloudflare|cf-error|Ray ID/i,
  // agnes-ai 服务特征
  agnes: /agnes-ai\.com|apihub\.agnes/i,
};

// T04562：Node fetch 的失败真因藏在 err.cause（如 ECONNRESET/ENOTFOUND），
// 顶层 message 只有一句 "fetch failed"，不递归读 cause 就永远判成 unknown。
interface ErrorNode {
  message?: unknown;
  name?: unknown;
  code?: unknown;
  status?: unknown;
  statusCode?: unknown;
  cause?: unknown;
}

const NETWORK_ERROR_CODES = new Set([
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

// 沿 cause 链收集错误节点，最多 3 层；cause 可能是字符串（如 "connect ECONNRESET"）。
function collectErrorChain(rawErr: unknown): { nodes: ErrorNode[]; causes: string[] } {
  const nodes: ErrorNode[] = [];
  const causes: string[] = [];
  let current: unknown = rawErr;
  for (let depth = 0; depth <= 3 && current !== undefined && current !== null; depth++) {
    if (typeof current === 'string') {
      causes.push(current);
      break;
    }
    if (typeof current !== 'object') {
      causes.push(String(current));
      break;
    }
    nodes.push(current as ErrorNode);
    current = (current as ErrorNode).cause;
  }
  return { nodes, causes };
}

function readNumberCode(value: unknown): number | null {
  if (typeof value === 'number' && Number.isInteger(value) && value >= 100 && value <= 599) return value;
  return null;
}

// 从原始错误（含 cause 链）提取 HTTP 状态码
function extractStatusCode(err: ErrorNode, errMsg: string): number | null {
  const direct = readNumberCode(err.status) ?? readNumberCode(err.statusCode);
  if (direct !== null) return direct;
  // 匹配 "LLM API error 520:" 或 "HTTP 502" 等模式
  const match = errMsg.match(/(?:HTTP|error)\s+(?<code>\d{3})\b/i);
  return match ? Number.parseInt(match.groups!.code, 10) : null;
}

function findNetworkCode(nodes: ErrorNode[], combined: string): string | null {
  for (const node of nodes) {
    if (typeof node.code === 'string' && NETWORK_ERROR_CODES.has(node.code)) return node.code;
  }
  const matched = combined.match(new RegExp(`\\b(${[...NETWORK_ERROR_CODES].join('|')})\\b`));
  return matched ? matched[1] : null;
}

function isNetworkFailure(combined: string): boolean {
  return /fetch failed|network error|socket hang up|other side closed|getaddrinfo/i.test(combined);
}

// 检测错误是否来自特定 provider
function detectProvider(errMsg: string): string | null {
  for (const [provider, pattern] of Object.entries(PROVIDER_FAULT_PATTERNS)) {
    if (pattern.test(errMsg)) return provider;
  }
  return null;
}

// 判断是否为网络超时
function isTimeoutError(errMsg: string): boolean {
  return /timeout|abort|超时|操作超时/i.test(errMsg);
}

// 判断是否为 HTML 错误页面（Cloudflare/Nginx 等反向代理返回）
function isHtmlErrorResponse(errMsg: string): boolean {
  // 为什么用 <!DOCTYPE 或 <html：反向代理错误页面必有这些标识
  return /<!DOCTYPE|<html[\s>]/i.test(errMsg);
}

// 友好化 LLM 错误信息
// 返回结构：{ friendly: 用户可读的简短提示, category: 错误类别, provider: 故障 provider }
export function friendlyLlmError(rawErr: unknown): {
  friendly: string;
  category: 'service_down' | 'timeout' | 'network' | 'auth' | 'rate_limit' | 'request_too_large' | 'unknown';
  provider?: string;
} {
  const { nodes, causes } = collectErrorChain(rawErr);
  const root = nodes[0];
  const ownMessages = nodes
    .map((node) => (typeof node.message === 'string' ? node.message : ''))
    .filter((msg) => msg.length > 0);
  const errMsg = ownMessages[0] || causes[0] || (rawErr === undefined ? '' : String(rawErr));
  // 特征匹配需要整条 cause 链：顶层可能只有 "fetch failed"。
  const combined = [...ownMessages, ...causes].join(' | ');
  const statusCode = extractStatusCode(root ?? {}, combined);
  const provider = detectProvider(combined);

  // 1. 超时类错误（含 AbortError / 操作超时）
  if (isTimeoutError(combined)) {
    return {
      friendly: `LLM 请求超时${provider ? `（${provider} 服务响应超时）` : ''}。可能原因：网络异常或服务端繁忙。建议稍后重试或切换 provider。`,
      category: 'timeout',
      provider: provider ?? undefined,
    };
  }

  // 2. 5xx 服务端错误（Cloudflare 520/502/503 等）
  if (statusCode !== null && statusCode >= 500 && statusCode < 600) {
    const providerName = provider ?? 'LLM 服务';
    return {
      friendly: `${providerName} 端故障（HTTP ${statusCode}）。这是服务端问题，非本地代码错误。建议切换到其他 provider 或稍后重试。`,
      category: 'service_down',
      provider: provider ?? undefined,
    };
  }

  // 3. 401/403 认证错误
  if (statusCode === 401 || statusCode === 403) {
    return {
      friendly: `LLM API 认证失败（HTTP ${statusCode}）。请检查 API Key 是否正确或是否已过期。`,
      category: 'auth',
    };
  }

  // 4. 429 限流
  if (statusCode === 429) {
    return {
      friendly: 'LLM API 请求被限流（429）。请降低请求频率或检查额度。',
      category: 'rate_limit',
    };
  }

  // 5. 413 请求体过大
  if (statusCode === 413) {
    return {
      friendly: 'LLM API 拒绝请求：内容过大（413）。请减少编译的页面数量或缩短单页内容。',
      category: 'request_too_large',
    };
  }

  // 6. 网络层失败：Node fetch 顶层只有 "fetch failed"，真因在 cause.code
  const networkCode = findNetworkCode(nodes, combined);
  if (networkCode !== null || isNetworkFailure(combined)) {
    const reason = networkCode ?? '网络不可达';
    return {
      friendly: `无法连接 LLM 服务（${reason}）。请检查网络/代理是否可达，或稍后重试。`,
      category: 'network',
      provider: provider ?? undefined,
    };
  }

  // 7. HTML 错误页面（无法识别状态码但含 HTML 标签）
  if (isHtmlErrorResponse(combined)) {
    return {
      friendly: `LLM 服务返回了错误页面${provider ? `（${provider}）` : ''}。建议切换 provider 或稍后重试。`,
      category: 'service_down',
      provider: provider ?? undefined,
    };
  }

  // 8. 兜底：截断超长错误信息，保留前 200 字符
  const truncated = errMsg.length > 200 ? errMsg.slice(0, 200) + '...' : errMsg;
  return {
    friendly: truncated,
    category: 'unknown',
  };
}

// T03591：错误是否值得重试（前端据此决定「重试」按钮是否出现）。
// 值得重试：服务端故障 / 超时 / 限流 —— 同样的输入换个时间往往就成。
// 不值得重试：认证失败 / 内容过大 —— 不换配置或不分批，重试多少次都一样。
// unknown 保守判为不可重试；但显式命中 429/连接重置等特征时仍视为可重试，
// 因为 provider 不一定按 `HTTP/error <code>` 的格式报错。
const RETRYABLE_CATEGORIES = new Set(['service_down', 'timeout', 'network', 'rate_limit']);
const RETRYABLE_MESSAGE = /429|rate.?limit|too many requests|temporarily unavailable|ECONNRESET|ECONNREFUSED|socket hang up|ETIMEDOUT|EAI_AGAIN|ENOTFOUND|fetch failed/i;

export function isRetryableLlmError(rawErr: unknown): boolean {
  const { category } = friendlyLlmError(rawErr);
  if (RETRYABLE_CATEGORIES.has(category)) return true;
  if (category === 'auth' || category === 'request_too_large') return false;
  const { nodes, causes } = collectErrorChain(rawErr);
  const errMsg = [
    ...nodes.map((node) => (typeof node.message === 'string' ? node.message : '')),
    ...causes,
  ].join(' | ');
  return RETRYABLE_MESSAGE.test(errMsg);
}
