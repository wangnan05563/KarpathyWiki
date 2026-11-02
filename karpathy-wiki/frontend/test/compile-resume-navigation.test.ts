// T04094：恢复成功后必须能回到历史任务列表，且列表状态与后端一致。
//
// 前端侧两处缺口：
// 1. 成功态只有「再投一篇」，没有回历史列表的入口；
// 2. 续传结束后没有刷新 runs，返回列表时仍是点「恢复」之前的旧快照。
// 后端 run-state 的终态回写由 api/test/compile-resume-state.test.ts 守护。
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

function makeResponse(body: unknown, ok = true, status = 200): Response {
  return { ok, status, json: async () => body } as unknown as Response;
}

const STORAGE_KEY = 'wiki:compile:state';

function progressSource(): string {
  return fs.readFileSync(path.resolve(__dirname, '../src/views/Progress.vue'), 'utf8');
}

describe('compile 恢复成功后的列表闭环 (T04094)', () => {
  beforeEach(() => {
    setActivePinia(createPinia());
    localStorage.clear();
  });

  it('reset 清空成功态与持久化快照，showRunsList 的守卫条件全部归位', () => {
    const store = useCompileStore();
    store.handleEvent('done', { step: 'finalize', status: 'done', message: '恢复完成' });
    localStorage.setItem(STORAGE_KEY, JSON.stringify({ isDone: true }));

    store.reset();

    expect(store.isDone).toBe(false);
    expect(store.isCompiling).toBe(false);
    expect(store.errorMessage).toBe('');
    expect(store.isCancelled).toBe(false);
    // 不清快照的话，下次进入 Progress 会把已看完的成功态又恢复出来
    expect(localStorage.getItem(STORAGE_KEY)).toBeNull();
  });

  it('backToRuns：重置视图后重新拉取历史列表', () => {
    const src = progressSource();
    const start = src.indexOf('async function backToRuns()');
    expect(start).toBeGreaterThan(-1);
    const body = src.slice(start, src.indexOf('}', start) + 1);
    expect(body).toContain('store.reset()');
    expect(body).toContain('await store.loadRuns()');
  });

  it('续传成功路径在终态处理之后刷新 runs', () => {
    const src = progressSource();
    const start = src.indexOf('async function startResume(');
    const end = src.indexOf('async function backToRuns()');
    expect(start).toBeGreaterThan(-1);
    expect(end).toBeGreaterThan(start);
    const body = src.slice(start, end);
    const doneIdx = body.indexOf('store.handleStreamEnd()');
    const refreshIdx = body.indexOf('await store.loadRuns()');
    expect(doneIdx).toBeGreaterThan(-1);
    expect(refreshIdx).toBeGreaterThan(doneIdx);
  });

  it('单文件与批量两种成功态都提供回列表入口', () => {
    const src = progressSource();
    const clicks = src.match(/@click="backToRuns"/g) ?? [];
    expect(clicks).toHaveLength(2);
    const labels = src.match(/返回历史编译任务/g) ?? [];
    expect(labels).toHaveLength(2);
  });

  it('组件级：成功态点「返回历史编译任务」→ 回到列表且状态已刷新', async () => {
    const store = useCompileStore();
    store.isDone = true;
    store.doneMessage = '恢复完成';
    store.result = { pages: [], indexUpdated: false };
    mockedFetch.mockImplementation(async (url: string) => {
      if (url.includes('/compile/runs')) {
        return makeResponse({
          runs: [{ runId: 'abcd1234-0000-4000-8000-000000000000', status: 'done', step: 9, tokenUsed: 120, startedAt: '2026-11-01T00:00:00.000Z' }],
        });
      }
      if (url.includes('/ai/presets')) return makeResponse({ presets: [] });
      if (url.includes('/ai/config')) return makeResponse({ model: 'test-model' });
      return makeResponse({});
    });

    const wrapper = mount(Progress, {
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
          BatchProgressBar: true,
          StateBlock: true,
          AppModal: true,
          IconActionButton: true,
        },
      },
    });
    await flushPromises();

    const back = wrapper.findAll('button').find((b) => b.text().includes('返回历史编译任务'));
    expect(back).toBeTruthy();
    await back!.trigger('click');
    await flushPromises();

    expect(store.isDone).toBe(false);
    expect(mockedFetch.mock.calls.some(([url]) => String(url).includes('/compile/runs'))).toBe(true);
    // 回到列表视图：标题在、运行条目在、成功态入口已消失
    expect(wrapper.text()).toContain('历史编译任务');
    expect(wrapper.text()).toContain('abcd1234');
    expect(wrapper.text()).not.toContain('返回历史编译任务');

    wrapper.unmount();
  });
});
