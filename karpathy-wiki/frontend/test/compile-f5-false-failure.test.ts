// T05079：批量编译进行中按 F5 整页刷新，导航 teardown 使在途 SSE fetch 以 TypeError
// 「network error」（非 AbortError）拒绝，被 runCompileStream catch 当致命错误落盘成
// isCompiling=false + errorMessage 的「假终态」快照。但服务端「断连不取消」，作业实际已跑完。
// 旧实现 restoreBatchSnapshot 因快照 isCompiling=false 返回 false → batchInterrupted=false →
// Progress.vue 续订守卫不触发 → 展示假失败「编译失败 network error」。
//
// 修复守护三件事：
// 1. 留有 jobId 且非用户确认终态（done/cancelled）的快照，恢复后按「已中断」上报 → 触发续订；
// 2. 续订查到后端 done（终态帧回放 / 被裁剪两条路径）都收敛 isDone 并清掉假错误与中断标记；
// 3. 负控制：用户取消 / 已完成 / 无 jobId 的历史错误快照不触发续订，保留既有展示。
import { describe, it, expect, beforeEach, vi } from 'vitest';
import { setActivePinia, createPinia } from 'pinia';
import { mount, flushPromises } from '@vue/test-utils';
import { useCompileStore } from '../src/stores/compile';
import { apiFetch } from '../src/utils/apiBase';
import { saveBatchSnapshot } from '../src/utils/compile-batch-snapshot';
import Progress from '../src/views/Progress.vue';

vi.mock('../src/utils/apiBase', () => ({
  API_BASE: '',
  apiFetch: vi.fn(),
}));
vi.mock('../src/utils/nav', () => ({ gotoView: vi.fn() }));

const mockedFetch = vi.mocked(apiFetch);

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

// F5 teardown 落盘的「假终态」快照：#1 已完成、#2 卡在 running，errorMessage=network error，
// isCompiling=false（被 catch 复位），但 jobId/lastSeq 仍在 —— 后端作业其实已 done。
const teardownSnapshot = {
  groups: [
    {
      fileIndex: 0,
      fileName: '已完成的资料.md',
      status: 'done' as const,
      timeline: [{ step: 'finalize' as const, status: 'done' as const, message: '完成', timestamp: 1 }],
      pages: [{ path: 'concepts/a.md', title: '页面A' }],
    },
    {
      fileIndex: 1,
      fileName: '在途的资料.md',
      status: 'running' as const,
      timeline: [{ step: 'extract' as const, status: 'running' as const, message: '抽取中', timestamp: 2 }],
      pages: [],
    },
  ],
  fileCount: 2,
  rejected: [],
  isCompiling: false,
  isDone: false,
  isCancelled: false,
  errorMessage: 'network error',
  doneMessage: '',
  jobId: 'job-f5',
  lastSeq: 17,
};

describe('compile store - F5 误报失败修复 (T05079)', () => {
  beforeEach(() => {
    setActivePinia(createPinia());
    localStorage.clear();
    mockedFetch.mockReset();
  });

  it('teardown 假终态快照（isCompiling=false + jobId）恢复后标记中断，触发续订', () => {
    saveBatchSnapshot(teardownSnapshot);
    const store = useCompileStore();

    // 旧实现这里返回 false（快照 isCompiling=false）→ 续订守卫不触发 → 假失败。
    expect(store.restoreBatchSnapshot()).toBe(true);
    expect(store.isBatchMode).toBe(true);
    expect(store.currentJobId).toBe('job-f5');
    expect(store.lastStreamSeq).toBe(17);
    // 假错误此刻仍在内存里，等续订查到后端真实终态再清（见下一条）
    expect(store.errorMessage).toBe('network error');
  });

  it('续订到已完成作业（终态帧回放）：收敛 done 并清掉假错误与中断标记', async () => {
    saveBatchSnapshot(teardownSnapshot);
    const store = useCompileStore();
    expect(store.restoreBatchSnapshot()).toBe(true);
    store.batchInterrupted = true; // Progress.vue 据返回值落标识
    mockedFetch
      .mockResolvedValueOnce(jsonResponse({ jobId: 'job-f5', status: 'done', message: '批量编译完成' }))
      .mockResolvedValueOnce(sseResponse([
        'event: file_done\ndata: {"step":"finalize","status":"done","data":{"fileIndex":1},"seq":25}\n\n',
        'event: batch_done\ndata: {"status":"done","message":"批量编译完成","seq":27}\n\n',
      ]));

    expect(await store.reconnectCompileJob()).toBe(true);

    expect(store.isDone).toBe(true);
    expect(store.isCompiling).toBe(false);
    expect(store.errorMessage).toBe('');
    expect(store.batchInterrupted).toBe(false);
    expect(store.batchGroups[1].status).toBe('done');
    expect(store.lastStreamSeq).toBe(27);
    expect(mockedFetch.mock.calls[0][0]).toBe('/compile/jobs/job-f5');
    expect(mockedFetch.mock.calls[1][0]).toBe('/compile/jobs/job-f5/events?fromSeq=18');
  });

  it('续订到已完成作业（终态帧被裁剪）：快照收敛 done、清假错误并收口在途分组', async () => {
    saveBatchSnapshot(teardownSnapshot);
    const store = useCompileStore();
    expect(store.restoreBatchSnapshot()).toBe(true);
    store.batchInterrupted = true;
    mockedFetch
      .mockResolvedValueOnce(jsonResponse({ jobId: 'job-f5', status: 'done', message: '批量编译完成' }))
      // 回放缓冲已裁剪掉 batch_done/file_done，只剩一条非终态 progress 帧
      .mockResolvedValueOnce(sseResponse([
        'event: progress\ndata: {"step":"generate_page","status":"running","data":{"fileIndex":1},"seq":20}\n\n',
      ]));

    expect(await store.reconnectCompileJob()).toBe(true);

    expect(store.isDone).toBe(true);
    expect(store.errorMessage).toBe('');
    expect(store.batchInterrupted).toBe(false);
    // 终态帧被裁剪时分组停在 running，由 applyJobSnapshot 收敛为 done
    expect(store.batchGroups[1].status).toBe('done');
  });

  it('负控制：用户已取消的快照不触发续订（保留取消态）', () => {
    saveBatchSnapshot({ ...teardownSnapshot, isCancelled: true, errorMessage: '' });
    const store = useCompileStore();

    expect(store.restoreBatchSnapshot()).toBe(false);
    expect(store.isCancelled).toBe(true);
  });

  it('负控制：已完成快照不触发续订', () => {
    saveBatchSnapshot({
      ...teardownSnapshot,
      isDone: true,
      errorMessage: '',
      doneMessage: '批量编译完成',
      groups: teardownSnapshot.groups.map((g) => ({ ...g, status: 'done' as const })),
    });
    const store = useCompileStore();

    expect(store.restoreBatchSnapshot()).toBe(false);
    expect(store.isDone).toBe(true);
  });

  it('负控制：无 jobId 的历史错误快照不触发续订（无法续订，保留既有展示）', () => {
    saveBatchSnapshot({ ...teardownSnapshot, jobId: undefined, errorMessage: '真实编译失败' });
    const store = useCompileStore();

    expect(store.restoreBatchSnapshot()).toBe(false);
    expect(store.errorMessage).toBe('真实编译失败');
  });
});

describe('Progress 挂载 wiring - F5 后续订展示后端真实结果 (T05079)', () => {
  beforeEach(() => {
    setActivePinia(createPinia());
    localStorage.clear();
    mockedFetch.mockReset();
  });

  function mountProgress() {
    return mount(Progress, {
      global: {
        stubs: {
          'el-button': { template: '<button><slot /></button>' },
          'el-icon': true,
          'el-tag': true,
          'el-select': true,
          'el-option': true,
          'el-timeline': true,
          'el-timeline-item': true,
          SingleFileProgressBar: true,
          BatchProgressBar: { props: ['interrupted'], template: '<div class="bpb-stub">{{ String(interrupted) }}</div>' },
          StateBlock: true,
          AppModal: true,
          IconActionButton: true,
        },
      },
    });
  }

  it('F5 后挂载：teardown 快照触发续订，展示后端 done 而非 network error 失败', async () => {
    saveBatchSnapshot(teardownSnapshot);
    mockedFetch.mockImplementation(async (input) => {
      const url = String(input);
      if (url.includes('/ai/presets')) return jsonResponse({ presets: [] });
      if (url.includes('/ai/config')) return jsonResponse({ model: 'test-model' });
      if (url.includes('/compile/jobs/job-f5/events')) {
        return sseResponse([
          'event: file_done\ndata: {"step":"finalize","status":"done","data":{"fileIndex":1},"seq":25}\n\n',
          'event: batch_done\ndata: {"status":"done","message":"批量编译完成","seq":27}\n\n',
        ]);
      }
      if (url.includes('/compile/jobs/job-f5')) return jsonResponse({ status: 'done', message: '批量编译完成' });
      if (url.includes('/compile/runs')) return jsonResponse({ runs: [] });
      return jsonResponse({});
    });
    const store = useCompileStore();

    const wrapper = mountProgress();
    // 续订是 fire-and-forget（Progress.vue 不 await），多轮 flush 排空 GET→SSE 微任务
    await flushPromises();
    await flushPromises();
    await flushPromises();

    expect(store.isDone).toBe(true);
    expect(store.errorMessage).toBe('');
    // 续订确实发生（而不是落到「原地展示既有分组」的假失败分支）
    expect(mockedFetch.mock.calls.some(([url]) => String(url).includes('/compile/jobs/job-f5'))).toBe(true);
    expect(wrapper.text()).not.toContain('network error');

    wrapper.unmount();
  });
});