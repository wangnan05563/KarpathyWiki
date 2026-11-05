// T04095：编译进度页切页/刷新后批量状态丢失。
//
// 根因：store.persistState() 对批量模式直接 return（FormData 不可序列化），
// onBeforeUnmount 也只给单文件模式落盘，于是切回/刷新时只剩历史列表。
// 修复：本页保存可序列化的批量快照，回来后原地展示并如实标记「已中断」。
import { describe, it, expect, beforeEach, vi } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { setActivePinia, createPinia } from 'pinia';
import { mount, flushPromises } from '@vue/test-utils';
import { useCompileStore } from '../src/stores/compile';
import { apiFetch } from '../src/utils/apiBase';
import { saveBatchSnapshot, loadBatchSnapshot, clearBatchSnapshot, BATCH_SNAPSHOT_KEY } from '../src/utils/compile-batch-snapshot';
import BatchProgressBar from '../src/components/BatchProgressBar.vue';
import Progress from '../src/views/Progress.vue';

vi.mock('../src/utils/apiBase', () => ({
  API_BASE: '',
  apiFetch: vi.fn(),
}));
vi.mock('../src/utils/nav', () => ({ gotoView: vi.fn() }));

const mockedFetch = vi.mocked(apiFetch);

function makeResponse(body: unknown, ok = true, status = 200): Response {
  return { ok, status, json: async () => body } as unknown as Response;
}

function progressSource(): string {
  return fs.readFileSync(path.resolve(__dirname, '../src/views/Progress.vue'), 'utf8');
}

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

const runningSnapshot = {
  groups: [
    {
      fileIndex: 0,
      fileName: '已完成的资料.doc',
      status: 'done' as const,
      timeline: [{ step: 'finalize' as const, status: 'done' as const, message: '完成', timestamp: 1 }],
      pages: [{ path: 'concepts/a.md', title: '页面A' }],
    },
    {
      fileIndex: 1,
      fileName: '在途的资料.doc',
      status: 'running' as const,
      timeline: [{ step: 'extract' as const, status: 'running' as const, message: '抽取中', timestamp: 2 }],
      pages: [],
    },
  ],
  fileCount: 2,
  rejected: [{ name: 'bad.txt', reason: '不在白名单' }],
  isCompiling: true,
  isDone: false,
  isCancelled: false,
  errorMessage: '',
  doneMessage: '',
};

describe('批量编译快照读写 (T04095)', () => {
  beforeEach(() => {
    localStorage.clear();
  });

  it('保存后可按原样读回分组、文件数与拒绝列表', () => {
    saveBatchSnapshot(runningSnapshot);

    const loaded = loadBatchSnapshot();
    expect(loaded).not.toBeNull();
    expect(loaded!.fileCount).toBe(2);
    expect(loaded!.groups.map((g) => g.status)).toEqual(['done', 'running']);
    expect(loaded!.rejected).toEqual([{ name: 'bad.txt', reason: '不在白名单' }]);
    expect(loaded!.savedAt).toBeGreaterThan(0);
  });

  it('没有可展示状态的空壳快照不恢复', () => {
    localStorage.setItem(BATCH_SNAPSHOT_KEY, JSON.stringify({
      groups: [], fileCount: 0, rejected: [], isCompiling: false,
      isDone: false, isCancelled: false, errorMessage: '', doneMessage: '', savedAt: 1,
    }));

    expect(loadBatchSnapshot()).toBeNull();
  });

  it('损坏的 JSON 不抛错，按无快照处理', () => {
    localStorage.setItem(BATCH_SNAPSHOT_KEY, '{not-json');

    expect(loadBatchSnapshot()).toBeNull();
  });

  it('清除后读到 null', () => {
    saveBatchSnapshot(runningSnapshot);
    clearBatchSnapshot();

    expect(loadBatchSnapshot()).toBeNull();
  });
});

describe('Progress 恢复批量快照 (T04095)', () => {
  beforeEach(() => {
    setActivePinia(createPinia());
    localStorage.clear();
    mockedFetch.mockReset();
    mockedFetch.mockImplementation(async (input) => {
      const url = String(input);
      if (url.includes('/ai/presets')) return makeResponse({ presets: [] });
      if (url.includes('/ai/config')) return makeResponse({ model: 'test-model' });
      if (url.includes('/compile/runs')) return makeResponse({ runs: [] });
      return makeResponse({});
    });
  });

  it('刷新后带快照进入：恢复分组与进度，不拉历史列表覆盖', async () => {
    saveBatchSnapshot(runningSnapshot);
    const store = useCompileStore();

    const wrapper = mountProgress();
    await flushPromises();

    expect(store.isBatchMode).toBe(true);
    expect(store.batchGroups).toHaveLength(2);
    expect(store.pendingBatchFileCount).toBe(2);
    expect(store.batchRejected).toEqual([{ name: 'bad.txt', reason: '不在白名单' }]);
    expect(store.isCompiling).toBe(false);
    expect(mockedFetch.mock.calls.some(([url]) => String(url).includes('/compile/runs'))).toBe(false);
    // 在途分组留在视图里（由卡片标成已中断），不退回空态
    expect(wrapper.text()).toContain('在途的资料.doc');
    expect(wrapper.find('.bpb-stub').text()).toBe('true');

    wrapper.unmount();
  });

  it('同会话切页回归：内存状态仍在时也标记中断，且不重复请求', async () => {
    const store = useCompileStore();
    store.prepareBatchCompile(new FormData());
    store.handleEvent('batch_start', { data: { fileCount: 1, rejected: [] } });
    store.handleEvent('file_start', {
      step: 'archive', status: 'running', data: { fileIndex: 0, fileCount: 1, fileName: 'a.doc' },
    });
    // 模拟 onBeforeUnmount：先落盘（快照记录 isCompiling=true），再复位编译态
    saveBatchSnapshot({
      ...runningSnapshot,
      groups: [store.batchGroups[0]],
      fileCount: 1,
      rejected: [],
    });
    store.abortCompile();

    const wrapper = mountProgress();
    await flushPromises();

    expect(store.isBatchMode).toBe(true);
    expect(store.batchGroups).toHaveLength(1);
    expect(store.isCompiling).toBe(false);
    expect(wrapper.find('.bpb-stub').text()).toBe('true');
    // 切回不应重放编译请求，也不应急着拉历史列表
    expect(mockedFetch.mock.calls.some(([url]) => String(url).includes('/compile'))).toBe(false);

    wrapper.unmount();
  });

  it('完成态快照恢复后展示结果，不标记中断', async () => {
    saveBatchSnapshot({
      ...runningSnapshot,
      groups: runningSnapshot.groups.map((g) => ({ ...g, status: 'done' as const })),
      isCompiling: false,
      isDone: true,
      doneMessage: '批量编译完成',
    });
    const store = useCompileStore();

    const wrapper = mountProgress();
    await flushPromises();

    expect(store.isDone).toBe(true);
    expect(wrapper.find('.bpb-stub').text()).toBe('false');
    expect(wrapper.text()).toContain('批量编译完成');

    wrapper.unmount();
  });
});

describe('Progress 切走/重置的快照生命周期 (T04095)', () => {
  beforeEach(() => {
    setActivePinia(createPinia());
    localStorage.clear();
  });

  it('onBeforeUnmount 对批量模式也是先落盘再标记中断', () => {
    const src = progressSource();
    const start = src.indexOf('onBeforeUnmount(() =>');
    const body = src.slice(start, src.indexOf('});', start));
    expect(body).toContain('persistBatchSnapshot()');
    expect(body).toContain('batchInterrupted.value = true');
    expect(body).not.toContain('if (store.isCompiling && !store.isBatchMode)');
  });

  it('批量事件逐条落盘，而不是交给不落盘的 store.persistState', () => {
    const src = progressSource();
    const start = src.indexOf('function handleSSE(');
    const body = src.slice(start, src.indexOf('\n}', start));
    expect(body).toContain('persistBatchSnapshot()');
  });

  it('重置入口清掉批量快照，避免下次刷新复活旧批次', () => {
    const src = progressSource();
    for (const fn of ['async function backToRuns()', 'function handleRestart()', 'function handleSingleCancel()']) {
      const start = src.indexOf(fn);
      expect(start).toBeGreaterThan(-1);
      expect(src.slice(start, src.indexOf('\n}', start))).toContain('clearBatchSnapshot()');
    }
  });

  it('已取消的批量仍保留快照，刷新后能看到成果与取消说明', () => {
    const src = progressSource();
    const start = src.indexOf('function handleBatchCancel()');
    const body = src.slice(start, src.indexOf('\n}', start));
    expect(body).toContain('store.cancelCompile()');
    expect(body).toContain('persistBatchSnapshot()');
  });
});

describe('BatchProgressBar 中断态文案 (T04095)', () => {
  beforeEach(() => {
    setActivePinia(createPinia());
    localStorage.clear();
  });

  it('interrupted 时显示已中断与保留进度，且无取消按钮', () => {
    const store = useCompileStore();
    store.isBatchMode = true;
    store.batchGroups = runningSnapshot.groups;

    const wrapper = mount(BatchProgressBar, {
      props: { interrupted: true },
      global: {
        stubs: {
          'el-progress': true,
          'el-button': { template: '<button><slot /></button>' },
          'el-icon': true,
          StateBlock: true,
        },
      },
    });

    expect(wrapper.text()).toContain('编译已中断，完成 1/2 个页面');
    expect(wrapper.text()).toContain('未完成的文件可返回投递页重新提交');
    expect(wrapper.findAll('button').some((b) => b.text().includes('取消编译'))).toBe(false);

    wrapper.unmount();
  });

  it('仍在运行时优先显示运行中，不被历史中断标记压住（重试场景）', () => {
    const store = useCompileStore();
    store.isBatchMode = true;
    store.batchGroups = runningSnapshot.groups;
    store.isCompiling = true;

    const wrapper = mount(BatchProgressBar, {
      props: { interrupted: true },
      global: {
        stubs: {
          'el-progress': true,
          'el-button': { template: '<button><slot /></button>' },
          'el-icon': true,
          StateBlock: true,
        },
      },
    });

    expect(wrapper.text()).toContain('正在编译 1/2 个页面');
    expect(wrapper.findAll('button').some((b) => b.text().includes('取消编译'))).toBe(true);

    wrapper.unmount();
  });
});
