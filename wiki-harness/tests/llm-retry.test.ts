import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { OpenAICompatibleAdapter, parseRetryAfterMs, networkRetryDelayMs } from '../src/llm/openai-compatible.js';
import { withRetry } from '../src/retry/retry-policy.js';
import type { RetryConfig } from '../src/types.js';

// 真实 HTTP 桩：验证 Layer A 网络重试与 Layer B 的 Retry-After 贯通
function listen(handler: http.RequestListener): Promise<{ url: string; close: () => Promise<void> }> {
  return new Promise((resolve) => {
    const server = http.createServer(handler);
    server.listen(0, '127.0.0.1', () => {
      const { port } = server.address() as AddressInfo;
      resolve({
        url: `http://127.0.0.1:${port}`,
        close: () =>
          new Promise<void>((done) => {
            server.closeAllConnections();
            server.close(() => done());
          }),
      });
    });
  });
}

function makeAdapter(baseUrl: string, timeoutMs?: number): OpenAICompatibleAdapter {
  return new OpenAICompatibleAdapter({
    provider: 'glm',
    baseUrl,
    apiKey: 'test-key',
    model: 'test-model',
    timeoutMs,
  });
}

describe('parseRetryAfterMs', () => {
  it('parses seconds and HTTP-date, rejects garbage', () => {
    assert.equal(parseRetryAfterMs('2'), 2000);
    assert.equal(parseRetryAfterMs('0.5'), 500);
    assert.equal(parseRetryAfterMs(null), null);
    assert.equal(parseRetryAfterMs('not-a-date'), null);
    const future = parseRetryAfterMs(new Date(Date.now() + 5000).toUTCString());
    assert.ok(future !== null && future > 3000 && future <= 5000);
  });
});

describe('networkRetryDelayMs', () => {
  it('is exponential with ±20% jitter (not linear)', () => {
    const originalRandom = Math.random;
    Math.random = () => 0.5; // 抖动系数固定 1.0，便于断言指数序列
    try {
      // 线性实现（base × attempt）在 attempt=3 时会得到 6000，指数实现为 8000
      assert.equal(networkRetryDelayMs(1, 2000), 2000);
      assert.equal(networkRetryDelayMs(2, 2000), 4000);
      assert.equal(networkRetryDelayMs(3, 2000), 8000);
    } finally {
      Math.random = originalRandom;
    }
    const jittered = [networkRetryDelayMs(1, 1000), networkRetryDelayMs(1, 1000), networkRetryDelayMs(1, 1000)];
    for (const delay of jittered) {
      assert.ok(delay >= 800 && delay <= 1200, `抖动应限制在 ±20%，实际 ${delay}`);
    }
  });
});

describe('Layer A network retry', () => {
  it('retries real connection resets with exponential backoff', { timeout: 20_000 }, async () => {
    let connections = 0;
    const server = http.createServer((_req, res) => res.end('{}'));
    server.on('connection', (socket) => {
      connections++;
      socket.destroy();
    });
    const port = await new Promise<number>((resolve) => {
      server.listen(0, '127.0.0.1', () => resolve((server.address() as AddressInfo).port));
    });
    const adapter = makeAdapter(`http://127.0.0.1:${port}`);
    try {
      await assert.rejects(adapter.chat([{ role: 'user', content: 'hi' }]), /fetch failed|socket hang up/i);
      assert.equal(connections, 3, '默认 3 次尝试（1 次初始 + 2 次网络重试）');
    } finally {
      server.closeAllConnections();
      await new Promise<void>((done) => server.close(() => done()));
    }
  });
});

describe('Layer B retry policy against real HTTP errors', () => {
  it('honors 429 Retry-After and succeeds on the next attempt', { timeout: 10_000 }, async () => {
    let requests = 0;
    const stub = await listen((_req, res) => {
      requests++;
      if (requests === 1) {
        res.writeHead(429, { 'content-type': 'application/json', 'retry-after': '1' });
        res.end('{"error":{"message":"rate limit exceeded"}}');
        return;
      }
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ choices: [{ message: { content: 'ok' } }] }));
    });
    const retry: RetryConfig = { maxRetries: 1, baseDelayMs: 1, maxDelayMs: 5000, retryOn: ['rate_limit'] };
    const startedAt = Date.now();
    try {
      const result = await withRetry(() => makeAdapter(stub.url).chat([{ role: 'user', content: 'hi' }]), retry);
      assert.equal(result.content, 'ok');
      assert.equal(requests, 2);
      assert.ok(Date.now() - startedAt >= 950, '429 应遵守 Retry-After: 1 秒');
    } finally {
      await stub.close();
    }
  });

  it('surfaces a classifiable TimeoutError without internal multiplication', { timeout: 10_000 }, async () => {
    let requests = 0;
    const stub = await listen((_req, _res) => {
      requests++; // 故意不响应，触发请求超时
    });
    const adapter = makeAdapter(stub.url, 100);
    try {
      await assert.rejects(adapter.chat([{ role: 'user', content: 'hi' }]), (err: unknown) => {
        assert.ok(err instanceof Error);
        assert.equal(err.name, 'TimeoutError');
        return true;
      });
      assert.equal(requests, 1, 'Layer A 不重试超时，交由 withRetry 决策');
    } finally {
      await stub.close();
    }
  });
});
