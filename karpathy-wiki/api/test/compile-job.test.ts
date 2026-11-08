// T04550 编译作业管理器单测：序号单调、按 fromSeq 回放、断连不影响作业、显式取消才终止。
// 纯内存模块，不依赖 Fastify/vault。
import { describe, it, expect } from 'vitest';
import { CompileJobManager, type CompileJobSink } from '../src/workflows/compile-job.js';

function makeSink(aborted = false) {
  const received: Array<{ event: string; data: unknown; seq: number }> = [];
  let ended = false;
  const sink: CompileJobSink = {
    onEvent: (event, data, seq) => received.push({ event, data, seq }),
    isAborted: () => aborted,
    end: () => {
      ended = true;
    },
  };
  return { sink, received, wasEnded: () => ended };
}

const flush = () => new Promise((r) => setTimeout(r, 0));

describe('CompileJobManager (T04550)', () => {
  it('事件序号单调递增，快照记录 lastSeq', async () => {
    const mgr = new CompileJobManager();
    const snapshot = mgr.start('single', async (ctx) => {
      ctx.emit('progress', { step: 'archive' });
      ctx.emit('progress', { step: 'extract' });
      return { status: 'done' };
    });
    await flush();
    expect(mgr.getSnapshot(snapshot.jobId)).toMatchObject({ status: 'done', lastSeq: 2 });
  });

  it('subscribe(fromSeq) 只回放 seq >= fromSeq 的事件，并继续接收直播', async () => {
    const mgr = new CompileJobManager();
    let release!: () => void;
    const gate = new Promise<void>((r) => {
      release = r;
    });
    let emitMore!: () => void;
    const snapshot = mgr.start('single', async (ctx) => {
      ctx.emit('progress', { step: 'archive' });
      emitMore = () => ctx.emit('done', { step: 'done' });
      await gate;
      return { status: 'done' };
    });

    const { sink, received, wasEnded } = makeSink();
    expect(mgr.subscribe(snapshot.jobId, sink, 2)).toBe(true);
    // seq 1 被 fromSeq 过滤，仅后续直播事件进入
    expect(received).toHaveLength(0);
    emitMore();
    expect(received.map((e) => [e.seq, e.event])).toEqual([[2, 'done']]);
    release();
    await flush();
    expect(wasEnded()).toBe(true);
  });

  it('断连（unsubscribe）不终止作业：作业继续到终态', async () => {
    const mgr = new CompileJobManager();
    let release!: () => void;
    const gate = new Promise<void>((r) => {
      release = r;
    });
    let ctxDone = false;
    const snapshot = mgr.start('batch', async (ctx) => {
      await gate;
      ctxDone = true;
      ctx.emit('batch_done', { step: 'done', status: 'done' });
      return { status: 'done' };
    });

    const first = makeSink();
    mgr.subscribe(snapshot.jobId, first.sink, 0);
    mgr.unsubscribe(snapshot.jobId, first.sink);
    release();
    await flush();

    expect(ctxDone).toBe(true);
    expect(first.received).toHaveLength(0);
    expect(mgr.getSnapshot(snapshot.jobId)?.status).toBe('done');
  });

  it('显式 cancel 让 runner 在检查点退出，终态为 canceled', async () => {
    const mgr = new CompileJobManager();
    let release!: () => void;
    const gate = new Promise<void>((r) => {
      release = r;
    });
    let cancelledSeen = false;
    const snapshot = mgr.start('batch', async (ctx) => {
      await gate;
      cancelledSeen = ctx.cancelled();
      if (cancelledSeen) return { status: 'failed' };
      ctx.emit('batch_done', { step: 'done', status: 'done' });
      return { status: 'done' };
    });

    expect(mgr.cancel(snapshot.jobId)?.status).toBe('running');
    release();
    await flush();

    expect(cancelledSeen).toBe(true);
    expect(mgr.getSnapshot(snapshot.jobId)?.status).toBe('canceled');
  });

  it('终态作业延迟订阅：回放全部事件后立即收流', async () => {
    const mgr = new CompileJobManager();
    const snapshot = mgr.start('retry', async (ctx) => {
      ctx.emit('done', { step: 'done', status: 'done' });
      return { status: 'done' };
    });
    await flush();

    const { sink, received, wasEnded } = makeSink();
    mgr.subscribe(snapshot.jobId, sink, 0);
    expect(received.map((e) => e.seq)).toEqual([1]);
    expect(wasEnded()).toBe(true);
  });

  it('不存在的 jobId 订阅返回 false，查询返回 null', () => {
    const mgr = new CompileJobManager();
    expect(mgr.subscribe('missing', makeSink().sink, 0)).toBe(false);
    expect(mgr.getSnapshot('missing')).toBeNull();
    expect(mgr.cancel('missing')).toBeNull();
  });
});
