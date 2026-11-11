import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { OpenAICompatibleAdapter } from '../src/llm/openai-compatible.js';
import { RateLimiter, getSharedRateLimiter, resetSharedRateLimiterForTest } from '../src/llm/rate-limiter.js';

// 可控时钟：sleep 立即推进虚拟时间，使「时间窗口内限流」的断言无需真实等待。
function fakeClock() {
  let t = 0;
  return {
    deps: {
      now: () => t,
      sleep: async (ms: number) => {
        t += ms;
      },
    },
    get time() {
      return t;
    },
  };
}

function makeAdapter(baseUrl: string, rateLimiter?: RateLimiter | null): OpenAICompatibleAdapter {
  return new OpenAICompatibleAdapter(
    { provider: 'glm', baseUrl, apiKey: 'k', model: 'm', timeoutMs: 2000 },
    rateLimiter,
  );
}

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

describe('T04565-A RateLimiter · 缺配置禁用（负控制）', () => {
  it('无 rateLimit 配置时闸门禁用，acquire 立即放行且不做任何节流', async () => {
    const limiter = new RateLimiter(undefined, fakeClock().deps);
    assert.equal(limiter.enabled, false);
    // 立即返回（无虚拟时间推进）
    const clock = fakeClock();
    const l2 = new RateLimiter(undefined, clock.deps);
    for (let i = 0; i < 100; i++) await l2.acquire(99999);
    assert.equal(clock.time, 0, '禁用时不应有任何等待');
    assert.equal(limiter.rateMultiplier, 1);
    assert.equal(limiter.activeRequests, 0);
  });

  it('adapter 未配置 rateLimit 时照常工作（不抛错、行为不变）', { timeout: 10_000 }, async () => {
    const stub = await listen((_req, res) => {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ choices: [{ message: { content: 'ok' } }] }));
    });
    try {
      const result = await makeAdapter(stub.url).chat([{ role: 'user', content: 'hi' }]);
      assert.equal(result.content, 'ok');
    } finally {
      await stub.close();
    }
  });
});

describe('T04565-A RateLimiter · 并发闸', () => {
  it('maxConcurrent=1 时第二个请求必须等第一个 release 后才放行', async () => {
    const limiter = new RateLimiter(
      { enabled: true, maxConcurrent: 1, requestsPerMinute: 10000, tokensPerMinute: 1e9 },
      fakeClock().deps,
    );
    await limiter.acquire();
    assert.equal(limiter.activeRequests, 1);

    let secondDone = false;
    const p2 = limiter.acquire().then(() => {
      secondDone = true;
    });
    // 让出微任务，确认第二个请求被并发闸挡住
    await Promise.resolve();
    assert.equal(secondDone, false, '第二个请求应被并发闸阻塞');

    limiter.release(); // 释放第一个
    await p2;
    assert.equal(secondDone, true);
    assert.equal(limiter.activeRequests, 1, '第二个请求已占槽');
    limiter.release();
    assert.equal(limiter.activeRequests, 0);
  });
});

describe('T04565-A RateLimiter · 令牌桶限制单位时间请求数', () => {
  it('requestsPerMinute=2 时，前 2 次不等待，第 3 次需等约一个窗口', async () => {
    const clock = fakeClock();
    const limiter = new RateLimiter(
      { enabled: true, maxConcurrent: 10, requestsPerMinute: 2, tokensPerMinute: 1e9 },
      clock.deps,
    );
    await limiter.acquire();
    await limiter.acquire();
    assert.equal(clock.time, 0, '窗口内前 2 次应即时放行');

    await limiter.acquire(); // 第 3 次：桶已空，必须等补充
    assert.ok(clock.time >= 30_000, `第 3 次应被节流约 30s，实际虚拟时间 ${clock.time}ms`);
  });

  it('token 预算约束：单请求 token 超过 TPM 时夹到桶容量，不挂死', async () => {
    const clock = fakeClock();
    const limiter = new RateLimiter(
      { enabled: true, maxConcurrent: 10, requestsPerMinute: 1e6, tokensPerMinute: 1000 },
      clock.deps,
    );
    // 请求估算 5000 token > TPM 1000：应最多等一个窗口后放行，而不是无限等待
    await limiter.acquire(5000);
    assert.ok(clock.time <= 60_000, `应在一个窗口内放行，实际 ${clock.time}ms`);
  });
});

describe('T04565-A RateLimiter · 429 自适应降速与恢复', () => {
  it('每次 429 把速率倍率减半（下限 0.1），远离限流后缓慢恢复', async () => {
    const clock = fakeClock();
    const limiter = new RateLimiter(
      { enabled: true, maxConcurrent: 10, requestsPerMinute: 1000, tokensPerMinute: 1e9 },
      clock.deps,
    );
    assert.equal(limiter.rateMultiplier, 1);
    limiter.onRateLimited();
    assert.equal(limiter.rateMultiplier, 0.5);
    limiter.onRateLimited();
    assert.equal(limiter.rateMultiplier, 0.25);

    // 推进虚拟时间超过恢复阈值（fake sleep 同步推进 t），再 acquire 触发 refill 缓慢回升 0.1
    await clock.deps.sleep(31_000);
    await limiter.acquire();
    assert.ok(limiter.rateMultiplier > 0.25, `应缓慢回升，实际 ${limiter.rateMultiplier}`);
  });

  it('429 响应经 adapter 触发降速（rateMultiplier < 1）', { timeout: 10_000 }, async () => {
    const stub = await listen((_req, res) => {
      res.writeHead(429, { 'content-type': 'application/json', 'retry-after': '1' });
      res.end('{"error":{"message":"rate limit"}}');
    });
    const limiter = new RateLimiter(
      { enabled: true, maxConcurrent: 10, requestsPerMinute: 1000, tokensPerMinute: 1e9 },
      fakeClock().deps,
    );
    try {
      await assert.rejects(
        makeAdapter(stub.url, limiter).chat([{ role: 'user', content: 'hi' }]),
        /429|rate limit/i,
      );
      assert.ok(limiter.rateMultiplier < 1, `429 后应降速，实际 ${limiter.rateMultiplier}`);
    } finally {
      await stub.close();
    }
  });
});

describe('T04565-A RateLimiter · 重试请求同样过闸', () => {
  it('网络重试的每次尝试都会 acquire（3 次尝试 → 3 次过闸）', { timeout: 20_000 }, async () => {
    // 桩对象：只统计 acquire 次数，避免真实等待
    let acquires = 0;
    const counted = {
      acquire: async () => {
        acquires++;
      },
      release: () => {},
      onRateLimited: () => {},
      rateMultiplier: 1,
      activeRequests: 0,
    } as unknown as RateLimiter;

    const server = http.createServer((_req, res) => res.end('{}'));
    server.on('connection', (socket) => socket.destroy());
    const port = await new Promise<number>((resolve) =>
      server.listen(0, '127.0.0.1', () => resolve((server.address() as AddressInfo).port)),
    );
    try {
      await assert.rejects(
        makeAdapter(`http://127.0.0.1:${port}`, counted).chat([{ role: 'user', content: 'hi' }]),
        /fetch failed|socket hang up/i,
      );
      assert.equal(acquires, 3, '默认 3 次尝试，每次都应过闸（含重试）');
    } finally {
      server.closeAllConnections();
      await new Promise<void>((done) => server.close(() => done()));
    }
  });
});

describe('T04565-A getSharedRateLimiter · 进程级单例', () => {
  it('无配置返回 null；有配置返回同一实例；reset 后可重建', () => {
    resetSharedRateLimiterForTest();
    assert.equal(getSharedRateLimiter(undefined), null);
    const a = getSharedRateLimiter({ enabled: true, maxConcurrent: 4, requestsPerMinute: 60, tokensPerMinute: 1000 });
    const b = getSharedRateLimiter({ enabled: true, maxConcurrent: 99, requestsPerMinute: 1, tokensPerMinute: 1 });
    assert.ok(a !== null);
    assert.equal(a, b, '全进程应共用同一个闸实例');
    resetSharedRateLimiterForTest();
    assert.equal(getSharedRateLimiter(undefined), null);
  });
});
