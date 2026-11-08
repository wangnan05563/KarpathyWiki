// T04550 路由级守护：客户端断连只退订，后台作业继续跑到终态；
// 刷新后可凭 jobId 查询状态并从 fromSeq 回放事件。
import { describe, it, expect } from 'vitest';
import Fastify from 'fastify';
import { registerCompileRoute } from '../src/routes/compile.js';
import type { EngineAdapter } from '../src/types.js';
import { NO_TIMER_CHAIN, pollUntil } from './helpers/waitForProgress.js';

function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>((r) => {
    resolve = r;
  });
  return { promise, resolve };
}

describe('compile job 路由 (T04550)', () => {
  it('SSE 断连不中断作业，重连可查快照并回放后继事件', async () => {
    const gate = deferred();
    const adapter = {
      compileFromRaw: async function* () {
        yield { step: 'archive', status: 'done', message: '已存档', data: { path: 'raw/a.md' } };
        await gate.promise;
        yield { step: 'done', status: 'done', message: '编译完成', data: { path: 'raw/a.md' } };
      },
    } as unknown as EngineAdapter;
    const app = Fastify();
    registerCompileRoute(app, adapter);
    await app.listen({ port: 0, host: '127.0.0.1' });
    const address = app.server.address();
    const base = `http://127.0.0.1:${typeof address === 'object' && address ? address.port : 0}`;

    try {
      const controller = new AbortController();
      const res = await fetch(`${base}/api/compile/retry`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ rawPath: 'raw/a.md' }),
        signal: controller.signal,
      });
      expect(res.ok).toBe(true);
      const reader = res.body!.getReader();
      const decoder = new TextDecoder();
      // 首帧是 job 事件，读出 jobId 后立刻模拟刷新断连
      let text = '';
      while (!text.includes('event: job')) {
        const { value, done } = await reader.read();
        if (done) break;
        text += decoder.decode(value, { stream: true });
      }
      const jobId = /"jobId":"([0-9a-f-]{36})"/.exec(text)?.[1];
      expect(jobId).toBeTruthy();
      controller.abort();
      await reader.cancel().catch(() => {});

      // 断连后作业仍在运行
      const running = await (await fetch(`${base}/api/compile/jobs/${jobId}`)).json() as { status: string };
      expect(running.status).toBe('running');

      gate.resolve();
      // 等作业收尾
      const { value: snapshot } = await pollUntil(
        'compile job 收尾',
        async () => await (await fetch(`${base}/api/compile/jobs/${jobId}`)).json() as { status: string },
        (snapshot) => snapshot.status !== 'running',
        NO_TIMER_CHAIN,
      );
      expect(snapshot.status).toBe('done');

      // 从 seq 1 之后的帧回放：done 事件必须还在（断连窗口丢失的帧可补齐）
      const replay = await (await fetch(`${base}/api/compile/jobs/${jobId}/events?fromSeq=2`)).text();
      expect(replay).toContain('event: done');
      expect(replay).toContain('"seq":2');
      // fromSeq 之前的帧不得重复回放（seq1 是客户端断连前已收到的 archive）
      expect(replay).not.toContain('"seq":1');
    } finally {
      await app.close();
    }
  });

  it('显式 cancel 端点能终止运行中的作业', async () => {
    const gate = deferred();
    let cancelled = false;
    const adapter = {
      compileFromRaw: async function* (_rawPath: string) {
        await gate.promise;
        yield { step: 'done', status: 'done', message: '编译完成', data: { path: 'raw/a.md' } };
      },
    } as unknown as EngineAdapter;
    const app = Fastify();
    registerCompileRoute(app, adapter);
    await app.listen({ port: 0, host: '127.0.0.1' });
    const address = app.server.address();
    const base = `http://127.0.0.1:${typeof address === 'object' && address ? address.port : 0}`;

    try {
      const controller = new AbortController();
      const res = await fetch(`${base}/api/compile/retry`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ rawPath: 'raw/a.md' }),
        signal: controller.signal,
      });
      const reader = res.body!.getReader();
      const decoder = new TextDecoder();
      let text = '';
      while (!text.includes('event: job')) {
        const { value, done } = await reader.read();
        if (done) break;
        text += decoder.decode(value, { stream: true });
      }
      const jobId = /"jobId":"([0-9a-f-]{36})"/.exec(text)?.[1];
      expect(jobId).toBeTruthy();

      const cancelledSnap = await (await fetch(`${base}/api/compile/jobs/${jobId}/cancel`, { method: 'POST' })).json() as { status: string };
      expect(cancelledSnap.status).toBe('running');
      cancelled = true;
      gate.resolve();

      const { value: snapshot } = await pollUntil(
        'compile job cancel 收尾',
        async () => await (await fetch(`${base}/api/compile/jobs/${jobId}`)).json() as { status: string },
        (snapshot) => snapshot.status !== 'running',
        NO_TIMER_CHAIN,
      );
      expect(cancelled).toBe(true);
      expect(snapshot.status).toBe('canceled');
      controller.abort();
      await reader.cancel().catch(() => {});
    } finally {
      await app.close();
    }
  });

  it('不存在的作业：状态与事件端点均 404', async () => {
    const app = Fastify();
    registerCompileRoute(app, {} as EngineAdapter);
    try {
      const status = await app.inject({ method: 'GET', url: '/api/compile/jobs/missing' });
      const events = await app.inject({ method: 'GET', url: '/api/compile/jobs/missing/events' });
      const cancel = await app.inject({ method: 'POST', url: '/api/compile/jobs/missing/cancel' });
      expect(status.statusCode).toBe(404);
      expect(events.statusCode).toBe(404);
      expect(cancel.statusCode).toBe(404);
    } finally {
      await app.close();
    }
  });
});
