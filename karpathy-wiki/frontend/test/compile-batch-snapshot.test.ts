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

function storeSource(): string {
  return fs.readFileSync(path.resolve(__dirname, '../src/stores/compile.ts'), 'utf8');
}

/** 取某个函数/语句块在源码里的片段：从 anchor 起，到下一个 `\n  }` 结束（顶层缩进 2 空格） */
function sliceFn(src: string, anchor: string): string {
  const start = src.indexOf(anchor);
  expect(start).toBeGreaterThan(-1);
  const end = src.indexOf('\n  }', start);
  return src.slice(start, end < 0 ? src.length : end);
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

  it('同会话切页但流已不在（如服务端重启）：标记中断且不重复请求', async () => {
    // T04508 改了这里的语义前提：正常切页不再中止在途流，也就不会走到「已中断」。
    // 仍然会标中断的，是「快照记着在编译、但 store 里这条流已经没了」——
    // 例如服务端重启把连接断了而终止事件没送到。这条腿锁的就是该兜底分支。
    const store = useCompileStore();
    store.prepareBatchCompile(new FormData());
    store.handleEvent('batch_start', { data: { fileCount: 1, rejected: [] } });
    store.handleEvent('file_start', {
      step: 'archive', status: 'running', data: { fileIndex: 0, fileCount: 1, fileName: 'a.doc' },
    });
    // 落一份「当时还在编译」的快照，再把流收掉（模拟流已死、状态停在 running）
    store.persistBatchSnapshot();
    store.stopStream();
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

  it('切页不再靠卸载钩落盘：进度归 store 逐事件持久化 (T04508)', () => {
    // 旧口径是「onBeforeUnmount 先落盘再标记中断」；T04508 后切页根本不中止流，
    // 落盘时机提前到每条事件，卸载钩里再补一次反而会把在途状态误标成中断。
    // 锁的是「用法」而不是这个词：Progress.vue 的注释里还要解释旧实现为什么被删掉
    expect(progressSource()).not.toMatch(/onBeforeUnmount\s*\(/);
    const body = sliceFn(storeSource(), 'async function runCompileStream(');
    expect(body).toContain('consumeSSE(response, handleStreamEvent');
    expect(storeSource()).toMatch(/function handleStreamEvent\([\s\S]*?persistProgress\(\);/);
  });

  it('批量事件逐条落盘，而不是交给不落盘的 store.persistState', () => {
    // T04508：这段判断从 Progress.vue 的 handleSSE 搬进 store 的 persistProgress
    const body = sliceFn(storeSource(), 'function persistProgress()');
    expect(body).toContain('persistBatchSnapshot()');
    expect(body).toContain('persistState()');
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
    // T04508：取消动作本身中止在途流，并把取消态落进快照
    const src = storeSource();
    const body = sliceFn(src, 'function cancelCompile()');
    expect(body).toContain('stopStream()');
    expect(body).toContain('persistProgress()');
    expect(sliceFn(progressSource(), 'function handleBatchCancel()')).toContain('store.cancelCompile()');
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
