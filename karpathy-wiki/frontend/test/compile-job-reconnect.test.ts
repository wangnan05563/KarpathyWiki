// T04550：前端按 jobId 重连。守护三件事：
// 1. jobId/lastSeq 随快照持久化，刷新后能恢复；
// 2. 重连先查作业快照，再从 lastSeq+1 续订事件（不重复、不漏帧）；
// 3. 取消改为显式 POST /api/compile/jobs/:jobId/cancel，不再靠断连。
import { describe, it, expect, beforeEach, vi } from 'vitest';
import { setActivePinia, createPinia } from 'pinia';
import { useCompileStore } from '../src/stores/compile';
import { apiFetch } from '../src/utils/apiBase';
import { saveBatchSnapshot } from '../src/utils/compile-batch-snapshot';

vi.mock('../src/utils/apiBase', () => ({
  API_BASE: '',
  apiFetch: vi.fn(),
}));

const mockedFetch = vi.mocked(apiFetch);
const STORAGE_KEY = 'wiki:compile:state';

function sseResponse(chunks: string[]): Response {
  const encoder = new TextEncoder();
  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      for (const chunk of chunks) controller.enqueue(encoder.encode(chunk));
      controller.close();
    },
  });
  return { ok: true, status: 200, body: stream } as unknown as Response;
}

function jsonResponse(body: unknown): Response {
  return { ok: true, status: 200, json: async () => body } as unknown as Response;
}

function seedPersistedState(jobId: string, lastSeq: number): void {
  localStorage.setItem(STORAGE_KEY, JSON.stringify({
    timeline: [],
    isCompiling: true,
    isDone: false,
    isCancelled: false,
    errorMessage: '',
    doneMessage: '',
    currentRunId: '',
    stageTimings: {},
    compileStartedAt: 1,
    pendingPayloadType: null,
    pendingPayloadContent: null,
    jobId,
    lastSeq,
  }));
}

describe('compile store - 服务端 job 重连 (T04550)', () => {
  beforeEach(() => {
    setActivePinia(createPinia());
    localStorage.clear();
    mockedFetch.mockReset();
  });

  it('loadPersistedState 恢复 jobId 与 lastSeq', () => {
    seedPersistedState('job-1', 7);
    const store = useCompileStore();

    expect(store.loadPersistedState()).toBe(true);
    expect(store.currentJobId).toBe('job-1');
    expect(store.lastStreamSeq).toBe(7);
  });

  it('批量快照同样恢复 jobId（批量没有 runId resume 通道）', () => {
    saveBatchSnapshot({
      groups: [],
      fileCount: 2,
      rejected: [],
      isCompiling: true,
      isDone: false,
      isCancelled: false,
      errorMessage: '',
      doneMessage: '',
      jobId: 'job-batch',
      lastSeq: 9,
    });
    const store = useCompileStore();

    expect(store.restoreBatchSnapshot()).toBe(true);
    expect(store.isBatchMode).toBe(true);
    expect(store.currentJobId).toBe('job-batch');
    expect(store.lastStreamSeq).toBe(9);
  });

  it('重连：先查快照，再从 lastSeq+1 续订并收敛终态', async () => {
    seedPersistedState('job-1', 7);
    const store = useCompileStore();
    store.loadPersistedState();
    mockedFetch
      .mockResolvedValueOnce(jsonResponse({ jobId: 'job-1', status: 'running', lastSeq: 7 }))
      .mockResolvedValueOnce(sseResponse([
        'event: job\ndata: {"jobId":"job-1","status":"running"}\n\n',
        'event: done\ndata: {"step":"finalize","status":"done","message":"编译完成","seq":8}\n\n',
      ]));

    const ok = await store.reconnectCompileJob();

    expect(ok).toBe(true);
    expect(store.isDone).toBe(true);
    expect(store.isCompiling).toBe(false);
    expect(store.lastStreamSeq).toBe(8);
    expect(mockedFetch.mock.calls[0][0]).toBe('/compile/jobs/job-1');
    expect(mockedFetch).toHaveBeenNthCalledWith(
      2,
      '/compile/jobs/job-1/events?fromSeq=8',
      expect.objectContaining({ signal: expect.any(AbortSignal) }),
    );
  });

  it('作业已过期（404）：重连返回 false，交给既有中断口径', async () => {
    seedPersistedState('gone', 3);
    const store = useCompileStore();
    store.loadPersistedState();
    mockedFetch.mockResolvedValueOnce({ ok: false, status: 404, json: async () => ({}) } as unknown as Response);

    expect(await store.reconnectCompileJob()).toBe(false);
  });

  it('取消走显式 cancel 端点，而不是仅 abort 连接', async () => {
    seedPersistedState('job-1', 7);
    const store = useCompileStore();
    store.loadPersistedState();
    mockedFetch.mockResolvedValueOnce(jsonResponse({ jobId: 'job-1', status: 'running' }));

    store.cancelCompile();
    await Promise.resolve();

    expect(store.isCancelled).toBe(true);
    expect(mockedFetch).toHaveBeenCalledWith(
      '/compile/jobs/job-1/cancel',
      { method: 'POST' },
    );
  });
});
