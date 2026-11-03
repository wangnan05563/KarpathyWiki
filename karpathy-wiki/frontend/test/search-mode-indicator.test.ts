// T04073：搜索页「检索模式」常驻展示的挂载回归。
// ------------------------------------------------------------------
// 缺陷形态是「已实现的能力对用户隐形」：未配置 embedding 模型时后端静默关闭语义路
// （hybridSearch 里 embedding.apiKey 缺省即 semanticEnabled=false），命中项全部标 keyword，
// 页面上既有结果又没报错，用户看不出「这次只有关键词在跑」，也等不到去配向量模型的理由。
// 原有的一次性轻提示几秒就消失，本改动把状态落在结果面板上并给直达入口。
// 三条口径要一起锁住，少一条都会让「看起来修好了」蒙混过关：
//   A) semanticEnabled=false → 常驻提示出现，且带「前往 配置中心 → <tab 实名>」入口，点击真的跳到 ai 页签；
//   B) semanticEnabled=true → 只作弱确认，不再出现未启用文案与跳转按钮；
//   C) 带筛选条件的搜索（走 /api/search，本就不含语义路）不得出现该提示——
//      否则会把「没配模型」的锅甩给筛选条件，用户更困惑。
// 提示语里的页签实名必须来自 configTabs 单一来源（术语表 §3 要求路径写成「配置中心 → tab 实名」），
// 所以断言用运行时取到的 label，而不是抄一份字面量。
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { flushPromises, mount, type VueWrapper } from '@vue/test-utils';
import { createPinia, setActivePinia } from 'pinia';
import Browse from '../src/views/Browse.vue';
import { useAuthStore } from '../src/stores/auth';
import { findTabMeta } from '../src/utils/configTabs';

const openConfigTab = vi.fn();
const AI_TAB_LABEL = findTabMeta('ai')?.label ?? '';

vi.mock('../src/utils/apiBase', () => ({
  API_BASE: '/wiki/api',
  downloadVaultFile: vi.fn(),
  apiFetch: vi.fn(async () => ({ ok: true, json: async () => ({}) })),
}));
vi.mock('../src/utils/sse', () => ({ consumeSSE: vi.fn() }));
vi.mock('../src/utils/nav', async () => {
  const actual = await vi.importActual<typeof import('../src/utils/nav')>('../src/utils/nav');
  return { ...actual, gotoView: vi.fn(), openConfigTab: (...args: unknown[]) => openConfigTab(...args) };
});
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
vi.mock('../src/components/DocumentTabs.vue', () => ({ default: { template: '<div class="stub-doc-tabs" />' } }));
vi.mock('../src/components/IconActionButton.vue', () => ({ default: { template: '<button class="stub-icon-action" />' } }));
vi.mock('../src/components/TocTree.vue', () => ({ default: { template: '<div class="stub-toc-tree" />' } }));

// hybrid 路的响应体由用例注入：semanticEnabled  true/false 两种状态各跑一遍
let hybridPayload: { hits: Array<{ path: string; title: string; snippet: string; source: string }>; semanticEnabled: boolean };

function stubFetch() {
  vi.spyOn(globalThis, 'fetch').mockImplementation(async (input: RequestInfo | URL) => {
    const url = String(input);
    const body = url.includes('/search/hybrid')
      ? hybridPayload
      : { hits: [{ path: 'concepts/a.md', title: 'A', snippet: 's', source: 'keyword' }], total: 1, semanticEnabled: false };
    return { ok: true, json: async () => body } as Response;
  });
}

const mounted: VueWrapper[] = [];

async function mountBrowse() {
  const authStore = useAuthStore();
  authStore.token = 't04073';
  authStore.user = {
    id: 'u1',
    username: 'admin',
    role: 'admin',
    enabled: true,
    createdAt: '2026-10-23T00:00:00Z',
    updatedAt: '2026-10-23T00:00:00Z',
  } as never;
  const w = mount(Browse, {
    global: {
      stubs: {
        'el-select': { template: '<div class="stub-select" />' },
        'el-popover': { template: '<span class="stub-popover"><slot name="reference" /><slot /></span>' },
        'el-tree': { template: '<div class="stub-tree" />' },
        'el-button': { template: '<button class="stub-el-btn" type="button"><slot /></button>' },
      },
    },
  });
  await flushPromises();
  mounted.push(w);
  return w;
}

beforeEach(() => {
  setActivePinia(createPinia());
  localStorage.clear();
  sessionStorage.clear();
  vi.clearAllMocks();
  hybridPayload = { hits: [{ path: 'concepts/a.md', title: 'A', snippet: 's', source: 'keyword' }], semanticEnabled: false };
});

// Browse 的 watch(searchQuery) 挂了 400ms 防抖自动搜索：用例结束前把查询词清空并 flush，
// 让那次定时器在组件与 fetch 桩都还在时跑掉，否则拆除后才触发的 doSearch 会命中真实 fetch，
// 走进 catch 里的 ElMessage.error —— 环境已销毁即抛「document is not defined」的未处理拒绝。
afterEach(async () => {
  for (const w of mounted) {
    (w.vm as unknown as { searchQuery: string }).searchQuery = '';
    await flushPromises();
    w.unmount();
  }
  mounted.length = 0;
  vi.restoreAllMocks();
});

describe('T04073 搜索页检索模式常驻展示', () => {
  it('A · 未配 embedding：语义路未启用常驻可见，且给出配置中心直达入口', async () => {
    stubFetch();
    const w = await mountBrowse();
    const vm = w.vm as unknown as { searchQuery: string; doSearch: () => Promise<void> };
    vm.searchQuery = '远程协作';
    await vm.doSearch();
    await flushPromises();

    const badge = w.find('[data-testid="search-mode-badge"]');
    expect(badge.exists()).toBe(true);
    expect(badge.classes()).toContain('keyword-only');
    expect(badge.text()).toContain('语义路：未启用');
    expect(badge.text()).toContain('未配置 embedding 模型');
    // 路径写法与页签实名同源：术语表 §3 要求「配置中心 → <tab 实名>」
    const link = w.find('[data-testid="search-mode-goto-config"]');
    expect(link.text()).toBe(`前往 配置中心 → ${AI_TAB_LABEL}`);

    await link.trigger('click');
    expect(openConfigTab).toHaveBeenCalledWith('ai');
  });

  it('B · 已启用语义路：只做弱确认，不再出现未启用文案与跳转按钮', async () => {
    hybridPayload = {
      hits: [{ path: 'concepts/a.md', title: 'A', snippet: 's', source: 'both' }],
      semanticEnabled: true,
    };
    stubFetch();
    const w = await mountBrowse();
    const vm = w.vm as unknown as { searchQuery: string; doSearch: () => Promise<void> };
    vm.searchQuery = '远程协作';
    await vm.doSearch();
    await flushPromises();

    const badge = w.find('[data-testid="search-mode-badge"]');
    expect(badge.exists()).toBe(true);
    expect(badge.classes()).toContain('hybrid');
    expect(badge.text()).toContain('关键词 + 语义');
    expect(badge.text()).not.toContain('未启用');
    expect(w.find('[data-testid="search-mode-goto-config"]').exists()).toBe(false);
  });

  it('C · 带筛选条件（走 /api/search 的纯关键词路）：不出现语义路提示，避免甩锅给筛选', async () => {
    stubFetch();
    const w = await mountBrowse();
    const vm = w.vm as unknown as {
      searchQuery: string;
      statusFilter: string;
      doSearch: () => Promise<void>;
    };
    vm.searchQuery = '远程协作';
    vm.statusFilter = 'published';
    await vm.doSearch();
    await flushPromises();

    expect(w.find('[data-testid="search-mode-badge"]').exists()).toBe(false);
  });

  it('D · 返回目录后状态清空（下一次搜索前不留残留模式）', async () => {
    stubFetch();
    const w = await mountBrowse();
    const vm = w.vm as unknown as {
      searchQuery: string;
      doSearch: () => Promise<void>;
      clearSearch: () => void;
    };
    vm.searchQuery = '远程协作';
    await vm.doSearch();
    await flushPromises();
    expect(w.find('[data-testid="search-mode-badge"]').exists()).toBe(true);

    vm.clearSearch();
    await flushPromises();
    expect(w.find('[data-testid="search-mode-badge"]').exists()).toBe(false);
  });
});
