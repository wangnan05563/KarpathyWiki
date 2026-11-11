// T05554：批量编译单文件重试成功后 F5 整页刷新仍误报「编译失败」。
// 根因：retryFileGroup 的 consumeSSE 回调直调 handleEvent（忽略 `job` 帧）→ currentJobId/lastStreamSeq
//   仍指向首轮失败作业；finally 只 refreshBatchOutcome() 收敛内存态却不 persistProgress() → 落盘快照
//   停在重试期间最后一次事件的 isCompiling=true。F5 后 restoreBatchSnapshot 误判「仍在编译」→ 续订到
//   首轮失败作业 → applyJobSnapshot failed 分支重贴「编译失败」，分组却都 done。
// 修复守护三件事：
// 1. 重试流走 handleStreamEvent：`job` 帧更新 currentJobId/lastStreamSeq（续订到重试新作业）；
// 2. finally refreshBatchOutcome 后 persistProgress：重试成功落盘 isDone=true，F5 读快照即 done；
// 3. 负控制：重试仍失败保留可重试错误态，F5 续订到重试作业（failed）而非误报完成。
import { describe, it, expect, beforeEach, vi } from 'vitest';
import { setActivePinia, createPinia } from 'pinia';
import { useCompileStore } from '../src/stores/compile';
import { apiFetch } from '../src/utils/apiBase';
import { loadBatchSnapshot } from '../src/utils/compile-batch-snapshot';

vi.mock('../src/utils/apiBase', () => ({ API_BASE: '', apiFetch: vi.fn() }));
const mockedFetch = vi.mocked(apiFetch);

function sseResponse(frames: string[]): Response {
  const enc = new TextEncoder();
  const body = new ReadableStream<Uint8Array>({
    start(c) {
      for (const f of frames) c.enqueue(enc.encode(f));
      c.close();
    },
  });
  return { ok: true, status: 200, body } as unknown as Response;
}

function seedFailedGroup(store: ReturnType<typeof useCompileStore>) {
  store.prepareBatchCompile(new FormData());
  store.handleEvent('batch_start', { data: { fileCount: 1, rejected: [] } });
  store.handleEvent('file_start', { step: 'archive', status: 'running', data: { fileIndex: 0, fileCount: 1, fileName: 'a.doc' } });
  store.handleEvent('file_error', {
    step: 'finalize',
    status: 'error',
    message: '编译失败: LLM API 请求被限流（429）',
    retryable: true,
    data: { fileIndex: 0, fileCount: 1, fileName: 'a.doc', rawPath: 'raw/a.md', retryable: true },
  });
}

const jobFrame = (jobId: string, seq: number) => `event: job\ndata: {"jobId":"${jobId}","seq":${seq}}\n\n`;
const fileDoneFrame = (seq: number) =>
  `event: file_done\ndata: {"step":"done","status":"done","message":"编译完成","data":{"fileIndex":0,"fileCount":1,"fileName":"a.doc"},"seq":${seq}}\n\n`;
const fileErrorFrame = (seq: number) =>
  `event: file_error\ndata: {"step":"finalize","status":"error","message":"编译失败: 503","retryable":true,"data":{"fileIndex":0,"fileCount":1,"fileName":"a.doc","rawPath":"raw/a.md","retryable":true},"seq":${seq}}\n\n`;

describe('compile store - 重试成功后 F5 误报失败修复 (T05554)', () => {
  beforeEach(() => {
    setActivePinia(createPinia());
    localStorage.clear();
    mockedFetch.mockReset();
  });

  it('重试流 job 帧更新 currentJobId/lastStreamSeq（续订到重试新作业，非首轮失败作业）', async () => {
    const store = useCompileStore();
    seedFailedGroup(store);
    // 首轮失败作业已被跟踪；重试是另一个后端作业，job 帧必须把标识切过去
    store.currentJobId = 'job-first-failed';
    store.lastStreamSeq = 24;
    mockedFetch.mockResolvedValue(sseResponse([jobFrame('job-retry', 3), fileDoneFrame(9)]));

    await store.retryFileGroup(0);

    // 旧实现直调 handleEvent 忽略 job 帧 → 这里仍是 job-first-failed / 24
    expect(store.currentJobId).toBe('job-retry');
    expect(store.lastStreamSeq).toBe(9);
  });

  it('重试成功：finally 落盘收敛终态 isDone=true/isCompiling=false（不再停在陈旧 isCompiling=true）', async () => {
    const store = useCompileStore();
    seedFailedGroup(store);
    mockedFetch.mockResolvedValue(sseResponse([jobFrame('job-retry', 3), fileDoneFrame(9)]));

    await store.retryFileGroup(0);

    expect(store.isDone).toBe(true);
    const snap = loadBatchSnapshot();
    expect(snap).not.toBeNull();
    // 旧实现 finally 不落盘 → 快照停在 file_done 那次的 isCompiling=true/isDone=false
    expect(snap!.isDone).toBe(true);
    expect(snap!.isCompiling).toBe(false);
    expect(snap!.errorMessage).toBe('');
    expect(snap!.jobId).toBe('job-retry');
    expect(snap!.groups[0].status).toBe('done');
  });

  it('重试成功后 F5（新 store 读快照）：restore 返回 false、直接 done，不续订首轮失败作业', async () => {
    const store = useCompileStore();
    seedFailedGroup(store);
    store.currentJobId = 'job-first-failed';
    mockedFetch.mockResolvedValue(sseResponse([jobFrame('job-retry', 3), fileDoneFrame(9)]));
    await store.retryFileGroup(0);

    // 模拟 F5：全新 pinia（内存清空），仅 localStorage 快照存活
    setActivePinia(createPinia());
    const fresh = useCompileStore();
    expect(fresh.restoreBatchSnapshot()).toBe(false);
    expect(fresh.isDone).toBe(true);
    expect(fresh.errorMessage).toBe('');
    expect(fresh.batchGroups[0].status).toBe('done');
  });

  it('负控制：重试仍失败——保留可重试错误态，落盘 isDone=false，F5 不误报完成', async () => {
    const store = useCompileStore();
    seedFailedGroup(store);
    mockedFetch.mockResolvedValue(sseResponse([jobFrame('job-retry-failed', 3), fileErrorFrame(9)]));

    await store.retryFileGroup(0);

    const group = store.batchGroups[0];
    expect(group.status).toBe('error');
    expect(group.retryable).toBe(true);
    expect(store.isDone).toBe(false);
    const snap = loadBatchSnapshot();
    expect(snap!.isDone).toBe(false);
    expect(snap!.isCompiling).toBe(false);
    expect(snap!.errorMessage).toContain('仍有 1 个文件失败');
    expect(snap!.jobId).toBe('job-retry-failed');

    // F5：快照非终态 → restore 报「已中断」→ 续订到重试作业（failed），保留真实错误而非假完成
    setActivePinia(createPinia());
    const fresh = useCompileStore();
    expect(fresh.restoreBatchSnapshot()).toBe(true);
    expect(fresh.isDone).toBe(false);
    expect(fresh.currentJobId).toBe('job-retry-failed');
    expect(fresh.batchGroups[0].retryable).toBe(true);
  });
});