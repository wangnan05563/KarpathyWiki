import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { withRetry, classifyError } from '../src/retry/retry-policy.js';
import type { RetryConfig } from '../src/types.js';

const fastRetry: RetryConfig = { maxRetries: 3, baseDelayMs: 1, maxDelayMs: 10, retryOn: ['timeout', 'rate_limit'] };

describe('classifyError', () => {
  it('should classify timeout errors', () => {
    assert.equal(classifyError(new Error('request timeout')), 'timeout');
  });

  it('should classify rate_limit errors', () => {
    assert.equal(classifyError(new Error('429 rate limit exceeded')), 'rate_limit');
  });

  it('should classify unknown errors', () => {
    assert.equal(classifyError(new Error('something else')), 'unknown');
  });

  it('classifies real fetch failures (with/without cause) as network', () => {
    assert.equal(classifyError(new TypeError('fetch failed')), 'network');
    const withCause = new TypeError('fetch failed', {
      cause: Object.assign(new Error('read ECONNRESET'), { code: 'ECONNRESET' }),
    });
    assert.equal(classifyError(withCause), 'network');
  });

  it('classifies AbortError as timeout (Layer A 60s abort must hit retryOn)', () => {
    const abortErr = new DOMException('This operation was aborted', 'AbortError');
    assert.equal(classifyError(abortErr), 'timeout');
    const timeoutErr = Object.assign(new Error('LLM 请求超时（100ms）'), { name: 'TimeoutError', code: 'ETIMEDOUT' });
    assert.equal(classifyError(timeoutErr), 'timeout');
  });

  it('classifies HTTP 5xx as service_down and 4xx as non-retryable', () => {
    assert.equal(classifyError(new Error('LLM API error 520: <html>cloudflare</html>')), 'service_down');
    assert.equal(classifyError(Object.assign(new Error('boom'), { status: 503 })), 'service_down');
    assert.equal(classifyError(new Error('LLM API error 401: unauthorized')), 'unknown');
    assert.equal(classifyError(new Error('LLM API error 429: rate limited')), 'rate_limit');
  });

  it('keeps SyntaxError as parse_error (negative control)', () => {
    assert.equal(classifyError(new SyntaxError('Unexpected token < in JSON')), 'parse_error');
  });
});

describe('withRetry', () => {
  it('should return result on first success', async () => {
    let calls = 0;
    const result = await withRetry(async () => {
      calls++;
      return 'success';
    }, fastRetry);
    assert.equal(result, 'success');
    assert.equal(calls, 1);
  });

  it('should retry on timeout and eventually succeed', async () => {
    let calls = 0;
    const result = await withRetry(async () => {
      calls++;
      if (calls < 2) throw new Error('timeout');
      return 'success';
    }, fastRetry);
    assert.equal(result, 'success');
    assert.equal(calls, 2);
  });

  it('should not retry on non-retryable errors', async () => {
    let calls = 0;
    await assert.rejects(
      withRetry(async () => {
        calls++;
        throw new Error('validation error');
      }, fastRetry),
      /validation error/,
    );
    assert.equal(calls, 1);
  });

  it('should exhaust retries and throw', async () => {
    let calls = 0;
    await assert.rejects(
      withRetry(async () => {
        calls++;
        throw new Error('timeout');
      }, fastRetry),
      /timeout/,
    );
    assert.equal(calls, 4); // 1 initial + 3 retries
  });

  it('should not retry when retryOn is empty', async () => {
    let calls = 0;
    const noRetry: RetryConfig = { ...fastRetry, retryOn: [] };
    await assert.rejects(
      withRetry(async () => {
        calls++;
        throw new Error('timeout');
      }, noRetry),
    );
    assert.equal(calls, 1);
  });

  it('should honor retryAfterMs (429 Retry-After) instead of exponential backoff', async () => {
    let calls = 0;
    const startedAt = Date.now();
    const rateLimited = Object.assign(new Error('LLM API error 429: rate limited'), {
      status: 429,
      retryAfterMs: 150,
    });
    const result = await withRetry(
      async () => {
        calls++;
        if (calls === 1) throw rateLimited;
        return 'ok';
      },
      { maxRetries: 2, baseDelayMs: 1, maxDelayMs: 1000, retryOn: ['rate_limit'] },
    );
    assert.equal(result, 'ok');
    assert.equal(calls, 2);
    assert.ok(Date.now() - startedAt >= 140, '应至少等待 Retry-After 指定的时长');
  });

  it('should not retry when retryAfterMs exceeds maxDelayMs', async () => {
    let calls = 0;
    await assert.rejects(
      withRetry(
        async () => {
          calls++;
          throw Object.assign(new Error('LLM API error 429: rate limited'), { status: 429, retryAfterMs: 60_000 });
        },
        { maxRetries: 3, baseDelayMs: 1, maxDelayMs: 1000, retryOn: ['rate_limit'] },
      ),
    );
    assert.equal(calls, 1);
  });

  it('should not retry after the external signal is aborted', async () => {
    let calls = 0;
    const controller = new AbortController();
    controller.abort();
    await assert.rejects(
      withRetry(
        async () => {
          calls++;
          throw new Error('request timeout');
        },
        fastRetry,
        controller.signal,
      ),
    );
    assert.equal(calls, 1);
  });
});
