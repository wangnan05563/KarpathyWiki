// T04562：LLM 错误分类必须读到 fetch failed 的真因（err.cause.code），
// 否则体检修复链只能把「无法连接」报成 unknown，既不可重试也无法指导用户。
import { describe, it, expect } from 'vitest';
import { friendlyLlmError, isRetryableLlmError } from '../src/utils/llm-error.js';

function fetchFailed(cause: unknown): Error {
  const err = new TypeError('fetch failed');
  (err as { cause?: unknown }).cause = cause;
  return err;
}

describe('friendlyLlmError · cause 链', () => {
  it('fetch failed + cause ECONNRESET → network 且文案可操作', () => {
    const err = fetchFailed(Object.assign(new Error('read ECONNRESET'), { code: 'ECONNRESET' }));
    const { friendly, category } = friendlyLlmError(err);
    expect(category).toBe('network');
    expect(friendly).toContain('无法连接 LLM 服务');
    expect(friendly).toContain('ECONNRESET');
  });

  it('fetch failed + 字符串 cause（getaddrinfo ENOTFOUND）→ network', () => {
    const err = fetchFailed('getaddrinfo ENOTFOUND api.example.com');
    expect(friendlyLlmError(err).category).toBe('network');
  });

  it('裸 fetch failed 无 cause → 仍判 network（不落 unknown）', () => {
    expect(friendlyLlmError(new TypeError('fetch failed')).category).toBe('network');
  });

  it('status 字段优先于 message 正则（402 → unknown，不是 5xx）', () => {
    const err = Object.assign(new Error('upstream refused'), { status: 402 });
    expect(friendlyLlmError(err).category).toBe('unknown');
  });

  it('cause 中带 HTTP 状态码也能识别 5xx', () => {
    const err = fetchFailed(new Error('LLM API error 520: origin down'));
    expect(friendlyLlmError(err).category).toBe('service_down');
  });

  it('非 Error 的字符串输入不回归', () => {
    expect(friendlyLlmError('unknown throttle').category).toBe('unknown');
    expect(friendlyLlmError('LLM API error 429: too many requests').category).toBe('rate_limit');
  });
});

describe('isRetryableLlmError · cause 链', () => {
  it('network 可重试', () => {
    const err = fetchFailed(Object.assign(new Error('connect ECONNREFUSED'), { code: 'ECONNREFUSED' }));
    expect(isRetryableLlmError(err)).toBe(true);
  });

  it('401 不可重试（负控制）', () => {
    const err = fetchFailed(new Error('LLM API error 401: unauthorized'));
    expect(friendlyLlmError(err).category).toBe('auth');
    expect(isRetryableLlmError(err)).toBe(false);
  });

  it('413 不可重试（负控制）', () => {
    const err = new Error('LLM API error 413: payload too large');
    expect(friendlyLlmError(err).category).toBe('request_too_large');
    expect(isRetryableLlmError(err)).toBe(false);
  });

  it('超时可重试（TimeoutError 名称命中优先于 ETIMEDOUT 网络码）', () => {
    const err = Object.assign(new Error('LLM 请求超时（100ms）'), { name: 'TimeoutError', code: 'ETIMEDOUT' });
    expect(friendlyLlmError(err).category).toBe('timeout');
    expect(isRetryableLlmError(err)).toBe(true);
  });
});
