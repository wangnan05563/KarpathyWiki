// T04554 真挂载：坏 frontmatter 必须是「用户看得见」的，而不是只在数据层多一个字段。
// 覆盖三条渲染面：
//   1. 浏览页详情：警示条出现，且正文照常渲染（正文仍可读）；
//   2. 体检页：全库坏头计数与可点击清单（点路径 = 跳到该页正文）；
//   3. 零坏页时计数仍可见（0 是有效结论，不是空白）。
import 'fake-indexeddb/auto';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { flushPromises, mount } from '@vue/test-utils';
import ElementPlus from 'element-plus';
import { createPinia, setActivePinia } from 'pinia';
import Browse from '../src/views/Browse.vue';
import Health from '../src/views/Health.vue';
import { useAuthStore } from '../src/stores/auth';
import { gotoView } from '../src/utils/nav';
import { apiFetch } from '../src/utils/apiBase';

vi.mock('../src/utils/apiBase', () => ({
  API_BASE: '/wiki/api',
  downloadVaultFile: vi.fn(),
  apiFetch: vi.fn(),
}));
vi.mock('../src/utils/sse', () => ({ consumeSSE: vi.fn() }));
vi.mock('../src/utils/nav', () => ({ gotoView: vi.fn(), openConfigTab: vi.fn() }));
vi.mock('../src/stores/compile', () => ({
  useCompileStore: () => ({
    draftBatchItems: [],
    draftIsPublishing: false,
    draftProgressMessage: '',
    loadDraftPublishState: vi.fn(),
  }),
}));
vi.mock('../src/services/userConfig', () => ({
  loadEmbeddingConfigForSearch: vi.fn().mockResolvedValue(null),
  loadAiUserConfigForPreset: vi.fn().mockResolvedValue(null),
}));
vi.mock('element-plus', async (importOriginal) => {
  const actual = (await importOriginal()) as any;
  return {
    ...actual,
    ElMessage: { success: vi.fn(), error: vi.fn(), warning: vi.fn(), info: vi.fn() },
    ElMessageBox: { confirm: vi.fn().mockResolvedValue(true), prompt: vi.fn(), alert: vi.fn() },
  };
});
vi.mock('../src/components/DocumentTabs.vue', () => ({ default: { template: '<div class="stub-doc-tabs" />' } }));
vi.mock('../src/components/IconActionButton.vue', () => ({ default: { template: '<button class="stub-icon-action" />' } }));
vi.mock('../src/components/TocTree.vue', () => ({ default: { template: '<div class="stub-toc-tree" />' } }));
vi.mock('../src/components/StateBlock.vue', () => ({
  default: {
    props: ['state', 'emptyTitle', 'emptyDesc', 'compact'],
    template: `<div class="stub-state-block" :data-state="state">{{ emptyTitle }}<slot name="action" /></div>`,
  },
}));

function ok(data: unknown) {
  return { ok: true, status: 200, json: () => Promise.resolve(data) } as any;
}

const REPORT = (frontmatterErrors: Array<{ path: string; reason: string }>) => ({
  orphans: [],
  brokenLinks: [],
  stale: [],
  knowledgeStale: [],
  frontmatterErrors,
});

function seedAuth() {
  const authStore = useAuthStore();
  authStore.token = 't04554';
  authStore.user = {
    id: 'u1',
    username: 'admin',
    role: 'admin',
    enabled: true,
    createdAt: '2026-10-23T00:00:00Z',
    updatedAt: '2026-10-23T00:00:00Z',
  } as never;
}

beforeEach(() => {
  setActivePinia(createPinia());
  localStorage.clear();
  sessionStorage.clear();
  vi.clearAllMocks();
  (apiFetch as any).mockImplementation(async (url: string) => {
    if (url.includes('/health-check/fix/batch/current')) return ok(null);
    if (url.includes('/health-check')) return ok(REPORT([{ path: 'concepts/bad.md', reason: 'bad indentation of a mapping entry' }]));
    if (url.includes('/files/tree')) return ok({ tree: [] });
    if (url.includes('/files/pages')) return ok({ pages: [] });
    if (url.includes('/files?path=')) {
      return ok({
        content: '---\ntitle: 坏页\ntags: [未闭合,\n---\n\n正文仍可读',
        frontmatter: {},
        body: '正文仍可读',
        frontmatter_error: 'bad indentation of a mapping entry',
      });
    }
    return ok({});
  });
});

describe('T04554 · 浏览页详情警示', () => {
  it('坏头页显示警示原因，正文仍渲染', async () => {
    seedAuth();
    sessionStorage.setItem('karpathy:jumpPath', 'concepts/bad.md');
    const wrapper = mount(Browse, {
      global: {
        stubs: {
          'el-select': { template: '<button class="stub-select" />' },
          'el-popover': { template: '<span class="stub-popover"><slot name="reference" /><slot /></span>' },
          'el-tree': { template: '<div class="stub-tree" />' },
          'el-button': { template: '<button class="stub-el-btn" type="button"><slot /></button>' },
        },
      },
    });
    await flushPromises();

    const alertEl = wrapper.find('[data-testid="frontmatter-error-alert"]');
    expect(alertEl.exists(), '坏头页详情必须出现警示条').toBe(true);
    expect(alertEl.text()).toContain('元信息解析失败，正文仍可读');
    expect(alertEl.text()).toContain('bad indentation of a mapping entry');

    const body = wrapper.find('.markdown-body');
    expect(body.exists()).toBe(true);
    expect(body.text()).toContain('正文仍可读');
  });
});

describe('T04554 · 体检页坏头计数', () => {
  it('非零时显示计数 + 可点击清单，点击写入跳转通道', async () => {
    seedAuth();
    const wrapper = mount(Health, { global: { plugins: [createPinia(), ElementPlus] } });
    await flushPromises();

    const bar = wrapper.find('[data-testid="frontmatter-error-bar"]');
    expect(bar.exists(), '计数条必须常驻').toBe(true);
    expect(bar.text()).toContain('本库 1 页元信息解析失败');
    expect(wrapper.find('[data-testid="frontmatter-error-list"]').exists(), '默认折叠').toBe(false);

    await wrapper.find('[data-testid="frontmatter-error-toggle"]').trigger('click');
    const list = wrapper.find('[data-testid="frontmatter-error-list"]');
    expect(list.exists()).toBe(true);
    expect(list.text()).toContain('concepts/bad.md');
    expect(list.text()).toContain('bad indentation of a mapping entry');

    await list.find('.fm-error-path').trigger('click');
    expect(sessionStorage.getItem('karpathy:jumpPath')).toBe('concepts/bad.md');
    expect(gotoView).toHaveBeenCalledWith('browse');
  });

  it('零坏页时计数仍在，用来判断「确实没有」而不是「没检查」', async () => {
    seedAuth();
    (apiFetch as any).mockImplementation(async (url: string) => {
      if (url.includes('/health-check/fix/batch/current')) return ok(null);
      if (url.includes('/health-check')) return ok(REPORT([]));
      return ok({});
    });
    const wrapper = mount(Health, { global: { plugins: [createPinia(), ElementPlus] } });
    await flushPromises();

    const bar = wrapper.find('[data-testid="frontmatter-error-bar"]');
    expect(bar.exists()).toBe(true);
    expect(bar.text()).toContain('本库 0 页元信息解析失败');
    expect(wrapper.find('[data-testid="frontmatter-error-toggle"]').exists()).toBe(false);
  });
});
