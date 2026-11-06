// T04508：编译进行中切换页面后，回来仍要看到实时进度（而不是「已中断」的残影）。
//
// 根因：App.vue 用 v-if 切换视图，切走即卸载 Progress.vue；旧实现把 AbortController
// 放在组件里并在 onBeforeUnmount 中 abort()。后端 routes/compile.ts 把「客户端断连」
// 当作取消（isAborted() break），于是编译真的被中断，切回来只剩 localStorage 快照。
// 修复：编译/续传流改由 stores/compile.ts 持有（同 draftAbortController 的既有手法），
// 卸载组件不再中止请求；状态与快照逐事件落盘。
//
// 这些用例锁的是「流不被切页杀掉」这一行为本身：
//   1. 卸载后事件继续进 store（说明请求还活着）；
//   2. 重新挂载不重发编译请求（否则批量会从头重复编译）；
//   3. 重新挂载不落「已中断」分支（那是刷新场景专用的）；
//   4. 用户显式取消仍然真的中止流（不能被「保持」误伤成取消不掉）。
import { describe, it, expect, beforeEach, vi } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { setActivePinia, createPinia } from 'pinia';
import { mount, flushPromises } from '@vue/test-utils';
import { useCompileStore } from '../src/stores/compile';
import { apiFetch } from '../src/utils/apiBase';
import Progress from '../src/views/Progress.vue';

vi.mock('../src/utils/apiBase', () => ({
  API_BASE: '',
  apiFetch: vi.fn(),
}));
vi.mock('../src/utils/nav', () => ({ gotoView: vi.fn() }));

const mockedFetch = vi.mocked(apiFetch);

function jsonResponse(body: unknown): Response {
  return { ok: true, status: 200, json: async () => body } as unknown as Response;
}

/** 一条「先不结束」的 SSE 流：测试自己决定何时推事件、何时收流 */
function liveSSE() {
  const enc = new TextEncoder();
  let ctl: ReadableStreamDefaultController<Uint8Array> | undefined;
  const body = new ReadableStream<Uint8Array>({ start(c) { ctl = c; } });
  const response = { ok: true, status: 200, body } as unknown as Response;
  // abort 之后消费侧会 cancel 读流，此时 close()/enqueue() 都会抛：
  // 用例里既有「切页后继续推事件」也有「取消后收尾」，这里统一容忍已关闭态
  const push = (eventType: string, data: unknown) => {
    try {
      ctl?.enqueue(enc.encode(`event: ${eventType}\ndata: ${JSON.stringify(data)}\n\n`));
    } catch {
      /* 流已被消费方取消 */
    }
  };
  return {
    response,
    push,
    close: () => {
      try {
        ctl?.close();
      } catch {
        /* 流已被消费方取消 */
      }
    },
  };
}

/**
 * 收流并等到消费侧真正结束。
 * 为什么还要等一个宏任务：streamActive 是在 consumeSSE 的 finally 里复位的，
 * 而读流是跨多轮 Promise 的链，单轮 flushPromises（微任务）走不到那里。
 */
async function closeStream(stream: { close: () => void }): Promise<void> {
  stream.close();
  await new Promise((resolve) => setTimeout(resolve, 20));
  await flushPromises();
}

/** 只挂 Progress 需要的桩，与 compile-batch-snapshot.test.ts 保持一致 */
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

/** 记录每次编译请求携带的 signal，用于断言「切页没 abort」 */function compileSignals(): AbortSignal[] {
  return mockedFetch.mock.calls
    .filter(([url]) => String(url).includes('/compile/batch') || String(url).endsWith('/compile'))
    .map(([, init]) => (init as RequestInit | undefined)?.signal as AbortSignal)
    .filter(Boolean);
}

function batchCompileCalls(): number {
  return mockedFetch.mock.calls.filter(([url]) => String(url).includes('/compile/batch')).length;
}

function startBatchWithLiveStream() {
  const stream = liveSSE();
  mockedFetch.mockImplementation(async (input) => {
    const url = String(input);
    if (url.includes('/ai/presets')) return jsonResponse({ presets: [] });
    if (url.includes('/ai/config')) return jsonResponse({ model: 'test-model' });
    if (url.includes('/compile/runs')) return jsonResponse({ runs: [] });
    if (url.includes('/compile/batch')) return stream.response;
    return jsonResponse({});
  });
  const store = useCompileStore();
  store.prepareBatchCompile(new FormData());
  return { store, stream };
}

describe('编译流切页不中断 (T04508)', () => {
  beforeEach(() => {
    setActivePinia(createPinia());
    localStorage.clear();
    mockedFetch.mockReset();
  });

  it('卸载进度页后事件继续写进 store：请求活着、编译态没被复位', async () => {
    const { store, stream } = startBatchWithLiveStream();
    const wrapper = mountProgress();
    await flushPromises();

    expect(store.streamActive).toBe(true);
    expect(store.isCompiling).toBe(true);

    stream.push('batch_start', { data: { fileCount: 1, rejected: [] } });
    stream.push('file_start', { data: { fileIndex: 0, fileCount: 1, fileName: 'a.doc' } });
    stream.push('progress', { step: 'archive', status: 'running', message: '归档原件', data: { fileIndex: 0 } });
    await flushPromises();
    expect(store.batchGroups).toHaveLength(1);
    expect(store.batchGroups[0].fileName).toBe('a.doc');

    // 关键回归点：切页（v-if 卸载）
    wrapper.unmount();
    const signals = compileSignals();
    expect(signals).toHaveLength(1);
    expect(signals[0].aborted).toBe(false);
    expect(store.streamActive).toBe(true);
    expect(store.isCompiling).toBe(true);

    // 用户不在页面上的这段时间，编译继续推进并留在 store 里
    stream.push('progress', { step: 'extract', status: 'running', message: '抽取中', data: { fileIndex: 0 } });
    await flushPromises();
    expect(store.batchGroups[0].timeline.map((t) => t.step)).toEqual(['archive', 'extract']);
    expect(store.isCompiling).toBe(true);
  });

  it('切回页面续显实时进度：不重发编译请求、也不落到「已中断」', async () => {
    const { store, stream } = startBatchWithLiveStream();
    const first = mountProgress();
    await flushPromises();
    stream.push('batch_start', { data: { fileCount: 1, rejected: [] } });
    stream.push('file_start', { data: { fileIndex: 0, fileCount: 1, fileName: 'a.doc' } });
    stream.push('progress', { step: 'archive', status: 'running', message: '归档原件', data: { fileIndex: 0 } });
    await flushPromises();

    first.unmount();
    stream.push('progress', { step: 'extract', status: 'done', message: '抽取完成', data: { fileIndex: 0 } });
    await flushPromises();

    const again = mountProgress();
    await flushPromises();

    // 重发请求会让批量编译从头再来一遍，这是本单要避免的行为
    expect(batchCompileCalls()).toBe(1);
    expect(store.batchInterrupted).toBe(false);
    expect(store.isCompiling).toBe(true);
    expect(store.errorMessage).toBe('');
    expect(again.text()).toContain('机器人正在编译');
    expect(again.find('.bpb-stub').text()).toBe('false');

    again.unmount();
  });

  it('人不在页面上时编译完成：回来后是结果态而非中断态', async () => {
    const { store, stream } = startBatchWithLiveStream();
    const wrapper = mountProgress();
    await flushPromises();
    stream.push('batch_start', { data: { fileCount: 1, rejected: [] } });
    await flushPromises();

    wrapper.unmount();
    stream.push('file_done', { status: 'done', data: { fileIndex: 0 } });
    stream.push('batch_done', { status: 'done', message: '批量编译完成，共处理 1 个文件' });
    await flushPromises();
    // 服务端发完终止事件就收流；不收流则请求仍在途，streamActive 不该是 false
    await closeStream(stream);

    expect(store.streamActive).toBe(false);
    expect(store.isDone).toBe(true);
    expect(store.batchInterrupted).toBe(false);

    const again = mountProgress();
    await flushPromises();
    expect(batchCompileCalls()).toBe(1);
    expect(again.text()).toContain('批量编译完成');
    again.unmount();
  });

  it('用户显式取消仍然中止在途流（保持功能不能把取消也吃掉）', async () => {
    const { store, stream } = startBatchWithLiveStream();
    const wrapper = mountProgress();
    await flushPromises();
    stream.push('batch_start', { data: { fileCount: 1, rejected: [] } });
    await flushPromises();

    const before = compileSignals();
    expect(before).toHaveLength(1);

    // BatchProgressBar 被桩掉，直接走 store 的取消入口（Progress 的取消按钮就是调它）
    store.cancelCompile();
    await flushPromises();

    expect(before[0].aborted).toBe(true);
    expect(store.streamActive).toBe(false);
    expect(store.isCancelled).toBe(true);
    expect(store.isCompiling).toBe(false);
    wrapper.unmount();
  });

  it('新一轮投递顶掉旧流时，旧流的 reject 不会污染新一轮编译态', async () => {
    const { store, stream } = startBatchWithLiveStream();
    const wrapper = mountProgress();
    await flushPromises();
    expect(store.isCompiling).toBe(true);

    // 重新投递：prepareBatchCompile → reset() → stopStream() 中止上一条流
    const second = liveSSE();
    mockedFetch.mockImplementation(async (input) => {
      const url = String(input);
      if (url.includes('/ai/presets')) return jsonResponse({ presets: [] });
      if (url.includes('/ai/config')) return jsonResponse({ model: 'test-model' });
      if (url.includes('/compile/batch')) return second.response;
      return jsonResponse({});
    });
    store.prepareBatchCompile(new FormData());
    // 不 await：这条流的 promise 只有在服务端收流后才结束，await 会把用例挂死
    void store.runCompileStream(new FormData());
    await flushPromises();

    // 旧流被 abort 后落进 catch，但「自己已不是当前流」→ 不得复位新一轮的 isCompiling
    expect(store.isCompiling).toBe(true);
    expect(store.streamActive).toBe(true);
    expect(compileSignals()[0].aborted).toBe(true);
    expect(compileSignals()[1].aborted).toBe(false);
    await closeStream(stream);
    await closeStream(second);
    wrapper.unmount();
  });

  it('单文件模式同样归 store：卸载不 abort，切回不重发', async () => {
    const stream = liveSSE();
    mockedFetch.mockImplementation(async (input) => {
      const url = String(input);
      if (url.includes('/ai/presets')) return jsonResponse({ presets: [] });
      if (url.includes('/ai/config')) return jsonResponse({ model: 'test-model' });
      if (url.includes('/compile/runs')) return jsonResponse({ runs: [] });
      if (url.endsWith('/compile')) return stream.response;
      return jsonResponse({});
    });
    const store = useCompileStore();
    store.prepareCompile({ type: 'text', content: '一段资料' });
    const wrapper = mountProgress();
    await flushPromises();

    stream.push('progress', { step: 'extract', status: 'running', message: '抽取中' });
    await flushPromises();
    wrapper.unmount();

    expect(compileSignals()).toHaveLength(1);
    expect(compileSignals()[0].aborted).toBe(false);
    expect(store.isCompiling).toBe(true);

    const again = mountProgress();
    await flushPromises();
    expect(compileSignals()).toHaveLength(1);
    expect(again.text()).toContain('机器人正在编译');
    again.unmount();
  });
});

describe('编译流归属的源码约束 (T04508)', () => {
  function progressSource(): string {
    return fs.readFileSync(path.resolve(__dirname, '../src/views/Progress.vue'), 'utf8');
  }
  function storeSource(): string {
    return fs.readFileSync(path.resolve(__dirname, '../src/stores/compile.ts'), 'utf8');
  }

  it('Progress.vue 不再持有 AbortController、也不再在卸载钩里中止编译', () => {
    const src = progressSource();
    // 锁的是「用法」而不是这个词：注释里还会提到旧实现，不能把说明文字也判成回归
    expect(src).not.toMatch(/onBeforeUnmount\s*\(/);
    expect(src).not.toMatch(/import\s*\{[^}]*\bonBeforeUnmount\b[^}]*\}\s*from\s*'vue'/);
    expect(src).not.toMatch(/abortController/);
    expect(src).not.toContain('store.abortCompile()');
  });

  it('流句柄与逐事件落盘都在 store，卸载组件不再影响落盘', () => {
    const src = storeSource();
    expect(src).toContain('streamAbortController');
    const fn = src.slice(src.indexOf('async function runCompileStream('));
    expect(fn.slice(0, 3000)).toContain('await consumeSSE(response, handleStreamEvent');
    expect(fn.slice(0, 3000)).toContain('handleStreamEnd()');
    // 落盘走 store 自己的分发函数，而不是交给组件
    expect(src).toContain('function handleStreamEvent(');
    expect(src).toContain('function persistBatchSnapshot(');
  });

  it('store 不做 UI 副作用：编译流里没有 ElMessage（同 stores/health.ts 口径）', () => {
    expect(storeSource()).not.toContain('ElMessage');
  });
});
