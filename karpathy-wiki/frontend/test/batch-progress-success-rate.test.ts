// T05721：进度页不得把「处理完成度 100%」当成功率展示。
// 60 页里 18 成功 42 失败时，头部必须是 30%，且 banner 不能写「全部编译完成」。
import { describe, it, expect, beforeEach, vi } from 'vitest';
import { mount } from '@vue/test-utils';
import { nextTick } from 'vue';
import { setActivePinia, createPinia } from 'pinia';
import BatchProgressBar from '../src/components/BatchProgressBar.vue';
import { useCompileStore } from '../src/stores/compile';

vi.mock('../src/utils/nav', () => ({ gotoView: vi.fn() }));

function mountBar() {
  return mount(BatchProgressBar, {
    global: {
      stubs: {
        'el-button': true,
        'el-icon': true,
        'el-progress': true,
        StateBlock: true,
      },
    },
  });
}

// 直接铺好分组终态：只关心统计口径，不必跑真实 SSE 流
function seed(statuses: Array<'done' | 'error' | 'pending'>, compiling = false): void {
  const store = useCompileStore();
  store.isBatchMode = true;
  store.batchGroups = statuses.map((status, i) => ({
    fileIndex: i,
    fileName: `page-${String(i + 1).padStart(3, '0')}.md`,
    status,
    timeline: [],
    pages: [],
  }));
  store.isCompiling = compiling;
  store.isDone = !compiling && statuses.every((s) => s === 'done');
  store.errorMessage = statuses.includes('error') ? '批量编译部分文件失败' : '';
}

describe('BatchProgressBar - 真实成功率 (T05721)', () => {
  beforeEach(() => {
    setActivePinia(createPinia());
    localStorage.clear();
  });

  it('60 页全成功：显示 100% 与「全部 60 个页面编译成功」', async () => {
    seed(Array(60).fill('done'));
    const wrapper = mountBar();
    await nextTick();

    const text = wrapper.text();
    expect(text).toContain('100%');
    expect(text).toContain('成功率 100%');
    expect(text).toContain('全部 60 个页面编译成功');
    wrapper.unmount();
  });

  it('60 页 18 成功 42 失败：显示 30%，不再谎报 100% / 全部编译完成', async () => {
    seed([
      ...Array<'done'>(18).fill('done'),
      ...Array<'error'>(42).fill('error'),
    ]);
    const wrapper = mountBar();
    await nextTick();

    const text = wrapper.text();
    expect(text).toContain('30%');
    expect(text).toContain('成功率 30%');
    expect(text).toContain('成功 18');
    expect(text).toContain('失败 42');
    expect(text).not.toContain('100%');
    expect(text).not.toContain('全部 60 个页面编译完成');
    wrapper.unmount();
  });

  it('运行中显示处理完成度而非成功率（10/60 完成 → 17%）', async () => {
    seed([
      ...Array<'done'>(10).fill('done'),
      ...Array<'pending'>(50).fill('pending'),
    ], true);
    const wrapper = mountBar();
    await nextTick();

    const text = wrapper.text();
    expect(text).toContain('17%');
    expect(text).toContain('正在编译 10/60 个页面');
    expect(text).not.toContain('成功率 = 成功');
    wrapper.unmount();
  });

  it('头部百分比的 title 说明口径：成功数 / 总页数 × 100', async () => {
    seed([
      ...Array<'done'>(18).fill('done'),
      ...Array<'error'>(42).fill('error'),
    ]);
    const wrapper = mountBar();
    await nextTick();

    const label = wrapper.find('.progress-percentage');
    expect(label.exists()).toBe(true);
    expect(label.attributes('title')).toContain('成功率 = 成功 18 / 总 60 × 100');
    wrapper.unmount();
  });
});
