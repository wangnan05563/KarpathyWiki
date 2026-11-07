import type { Message, ToolDefinition, LLMResponse, LLMChunk, LLMConfig, ToolCall } from '../types.js';
import type { LLMAdapter } from './llm-adapter.js';

// OpenAI 兼容 API 响应结构（仅取关心的字段，避免 any）
interface OpenAIChatResponse {
  choices: Array<{
    message: {
      content: string | null;
      tool_calls?: ToolCall[];
    };
  }>;
  usage?: { prompt_tokens: number; completion_tokens: number };
}

interface OpenAIStreamChunk {
  choices: Array<{
    delta: {
      content?: string;
      tool_calls?: ToolCall[];
    };
  }>;
}

// 转换为 OpenAI tools 格式：剥离 handler，只保留 schema 描述
function toOpenAITools(tools: ToolDefinition[]) {
  return tools.map(t => ({
    type: 'function' as const,
    function: {
      name: t.name,
      description: t.description,
      parameters: t.parameters,
    },
  }));
}

// 单次 LLM 请求默认超时：60s。可由 LLMConfig.timeoutMs 覆盖。
const DEFAULT_REQUEST_TIMEOUT_MS = 60_000;

// 解析 Retry-After：支持秒数（"30"）与 HTTP-date 两种格式，非法值返回 null。
export function parseRetryAfterMs(value: string | null): number | null {
  if (!value) return null;
  const trimmed = value.trim();
  if (/^\d+(\.\d+)?$/.test(trimmed)) {
    return Math.round(Number.parseFloat(trimmed) * 1000);
  }
  const date = Date.parse(trimmed);
  if (Number.isNaN(date)) return null;
  return Math.max(0, date - Date.now());
}

// Layer A 网络重试退避：baseDelayMs × 2^(attempt-1) 叠加 ±20% 抖动，避免多实例同时重试。
export function networkRetryDelayMs(attempt: number, baseDelayMs: number): number {
  return baseDelayMs * Math.pow(2, attempt - 1) * (0.8 + Math.random() * 0.4);
}

// HTTP 非 2xx 错误：把 status 与 Retry-After 挂到错误对象上，
// 让 withRetry 能按 429/5xx 分类并遵守服务端要求的等待时间。
function createHttpError(status: number, text: string, retryAfterHeader: string | null): Error {
  const err = new Error(`LLM API error ${status}: ${text}`) as Error & {
    status?: number;
    retryAfterMs?: number;
  };
  err.status = status;
  const retryAfterMs = parseRetryAfterMs(retryAfterHeader);
  if (retryAfterMs !== null) err.retryAfterMs = retryAfterMs;
  return err;
}

// OpenAI 兼容适配器：通过 baseUrl + apiKey + model 切换 GLM/Qwen/DeepSeek
// 国产模型普遍兼容 OpenAI API 协议，零依赖原生 fetch 实现
export class OpenAICompatibleAdapter implements LLMAdapter {
  constructor(private config: LLMConfig) {}

  // 网络层错误判定：仅这些错误值得重试（代理抖动/连接重置/DNS 失败/超时）。
  // 与 HTTP 4xx/5xx 区分：后者是确定性错误，重试无意义。
  // 原生 fetch 的真实原因常在 err.cause.code（如 ECONNRESET），message 只有 "fetch failed"。
  private isRetryableNetworkError(err: unknown): boolean {
    const msg = err instanceof Error ? err.message : String(err);
    const code = (err as { code?: string } | null)?.code ?? '';
    const cause = (err as { cause?: unknown } | null)?.cause;
    const causeCode = cause instanceof Error ? ((cause as { code?: string }).code ?? '') : '';
    const pattern = /fetch failed|ECONNRESET|ECONNREFUSED|ENOTFOUND|EAI_AGAIN|ETIMEDOUT|ECONNABORTED|timeout|abort/i;
    return pattern.test(msg) || pattern.test(code) || pattern.test(causeCode);
  }

  // 带指数退避重试的 fetch 封装。
  // 为什么集中于此：本适配器是全部 LLM 请求的出口，HTTP(S) 代理（如 Clash 127.0.0.1:10808）
  // 偶发抖动会触发原生 "fetch failed"，直接抛错会让编译/问答整轮失败；加重试可自愈多数瞬时故障。
  // 每次重试重建 AbortController：复用已 abort 的 signal 会使后续请求立即失败。
  // external signal（FR-22）：用户主动停止时立即终止上游连接，与请求超时 signal 合并；
  // 注意 external 已 abort 时重试循环不生效——用户停止语义优先于网络自愈，不应再发新请求。
  // 退避为 baseDelayMs × 2^(attempt-1) 并叠加 ±20% 抖动（与 withRetry 的指数口径一致）。
  // 请求超时不在此层重试：抛出 TimeoutError 交给 withRetry 统一决策，避免 60s × N 的成倍放大。
  private async fetchWithRetry(
    url: string,
    init: RequestInit,
    externalSignal?: AbortSignal,
    retries = 3,
    baseDelayMs = 2000,
    timeoutMs = DEFAULT_REQUEST_TIMEOUT_MS,
  ): Promise<Response> {
    let lastErr: unknown;
    for (let attempt = 1; attempt <= retries; attempt++) {
      const controller = new AbortController();
      let timedOut = false;
      const timer = setTimeout(() => {
        timedOut = true;
        controller.abort();
      }, timeoutMs);
      // AbortSignal.any 合并超时与外部停止：任一触发即终止请求（Node 20+ 原生支持）
      const merged = externalSignal ? AbortSignal.any([controller.signal, externalSignal]) : controller.signal;
      try {
        const response = await fetch(url, { ...init, signal: merged });
        clearTimeout(timer);
        return response;
      } catch (err) {
        clearTimeout(timer);
        lastErr = err;
        // 用户已停止：不再重试（继续重试会违背"停止即终止"语义，白白消耗用户额度）
        if (externalSignal?.aborted) throw err;
        if (timedOut) {
          const timeoutErr = new Error(`LLM 请求超时（${timeoutMs}ms）`) as Error & { code?: string };
          timeoutErr.name = 'TimeoutError';
          timeoutErr.code = 'ETIMEDOUT';
          throw timeoutErr;
        }
        const retryable = this.isRetryableNetworkError(err);
        if (retryable && attempt < retries) {
          const delay = networkRetryDelayMs(attempt, baseDelayMs);
          await new Promise((r) => setTimeout(r, delay));
          continue;
        }
        throw err;
      }
    }
    throw lastErr;
  }

  async chat(messages: Message[], tools?: ToolDefinition[], signal?: AbortSignal): Promise<LLMResponse> {
    const body: Record<string, unknown> = {
      model: this.config.model,
      messages,
    };
    if (tools && tools.length > 0) {
      body.tools = toOpenAITools(tools);
    }

    // 带重试的网络请求：代理抖动自愈，避免整轮编译/问答因单次网络抖动失败
    const response = await this.fetchWithRetry(`${this.config.baseUrl}/chat/completions`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${this.config.apiKey}`,
      },
      body: JSON.stringify(body),
    }, signal, 3, 2000, this.config.timeoutMs ?? DEFAULT_REQUEST_TIMEOUT_MS);

    if (!response.ok) {
      const text = await response.text();
      throw createHttpError(response.status, text, response.headers.get('retry-after'));
    }

    const data = (await response.json()) as OpenAIChatResponse;
    const message = data.choices[0]?.message;
    if (!message) {
      throw new Error('LLM API returned no choices');
    }

    return {
      content: message.content ?? '',
      tool_calls: message.tool_calls,
      usage: data.usage,
    };
  }

  async *chatStream(messages: Message[], tools?: ToolDefinition[], signal?: AbortSignal): AsyncIterable<LLMChunk> {
    const body: Record<string, unknown> = {
      model: this.config.model,
      messages,
      stream: true,
    };
    if (tools && tools.length > 0) {
      body.tools = toOpenAITools(tools);
    }

    // 带重试的网络请求：代理抖动自愈，避免流式问答因单次网络抖动失败
    const response = await this.fetchWithRetry(`${this.config.baseUrl}/chat/completions`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${this.config.apiKey}`,
      },
      body: JSON.stringify(body),
    }, signal, 3, 2000, this.config.timeoutMs ?? DEFAULT_REQUEST_TIMEOUT_MS);

    if (!response.ok) {
      const text = await response.text();
      throw createHttpError(response.status, text, response.headers.get('retry-after'));
    }

    const reader = response.body?.getReader();
    if (!reader) throw new Error('Response body is not readable');

    const decoder = new TextDecoder();
    let buffer = '';

    // §流式 tool_calls 累积器：OpenAI 流式协议中 tool_calls 是分片返回
    //   第一个分片含 id + function.name + arguments 初始（可能为空串）
    //   后续分片含 function.arguments 增量片段（无 id/name）
    //   必须按 index 累积，流结束时合并为完整 ToolCall[]
    //   为什么用 Map：index 是数字键，Map 保序且查找 O(1)
    const toolCallAccumulator = new Map<number, ToolCall>();

    // SSE 解析：按行分割，data: 前缀为有效载荷，[DONE] 结束
    while (true) {
      // 用户已停止：取消响应体读取，立即终止流（不等下一个 SSE 事件）
      if (signal?.aborted) {
        reader.cancel().catch(() => { /* 流已被销毁时 cancel 抛错，忽略 */ });
        return;
      }
      const { done, value } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });

      const lines = buffer.split('\n');
      // 最后一段可能不完整，留待下次拼接
      buffer = lines.pop() ?? '';

      for (const line of lines) {
        const trimmed = line.trim();
        if (!trimmed || !trimmed.startsWith('data:')) continue;
        const data = trimmed.slice(5).trim();
        if (data === '[DONE]') {
          // 流结束：如有累积的 tool_calls，yield 一次完整数组（delta 为空）
          // 为什么放在 [DONE] 分支：OpenAI 协议保证 [DONE] 是最后一个事件，此时累积完整
          if (toolCallAccumulator.size > 0) {
            const toolCalls = Array.from(toolCallAccumulator.entries())
              .sort(([a], [b]) => a - b)
              .map(([, tc]) => tc);
            yield { delta: '', tool_calls: toolCalls };
          }
          return;
        }

        try {
          const parsed = JSON.parse(data) as OpenAIStreamChunk;
          const delta = parsed.choices?.[0]?.delta;
          if (delta) {
            // 文本增量直接 yield，消费端可即时追加
            if (delta.content) {
              yield { delta: delta.content, tool_calls: undefined };
            }
            // tool_calls 分片累积，不立即 yield
            if (delta.tool_calls) {
              for (const tc of delta.tool_calls) {
                // OpenAI 流式 tool_calls 每项含 index 字段（隐含），用 any 取出
                const idx = (tc as unknown as { index?: number }).index ?? 0;
                const existing = toolCallAccumulator.get(idx);
                if (existing) {
                  // 后续分片：累积 arguments 增量
                  if (tc.function.arguments) {
                    existing.function.arguments += tc.function.arguments;
                  }
                } else {
                  // 首个分片：含 id + name + arguments 初始
                  toolCallAccumulator.set(idx, {
                    id: tc.id,
                    type: 'function',
                    function: {
                      name: tc.function.name,
                      arguments: tc.function.arguments || '',
                    },
                  });
                }
              }
            }
          }
        } catch {
          // 跳过无法解析的 SSE 行，保持流不中断
        }
      }
    }

    // 兜底：若未收到 [DONE] 但流自然结束（如连接断开），仍尝试 yield 累积的 tool_calls
    if (toolCallAccumulator.size > 0) {
      const toolCalls = Array.from(toolCallAccumulator.entries())
        .sort(([a], [b]) => a - b)
        .map(([, tc]) => tc);
      yield { delta: '', tool_calls: toolCalls };
    }
  }

  countTokens(messages: Message[]): number {
    // 国产模型 tokenizer 不公开且不准，用字符数/3 粗略估算
    // 中英文混合场景下 3 字符约等于 1 token 是经验值
    let chars = 0;
    for (const msg of messages) {
      chars += msg.content.length;
      if (msg.tool_calls) {
        for (const tc of msg.tool_calls) {
          chars += tc.function.arguments.length;
        }
      }
    }
    return Math.ceil(chars / 3);
  }
}
