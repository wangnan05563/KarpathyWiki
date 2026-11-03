// T04073 配置中心「语义索引」覆盖率展示回归。
// ------------------------------------------------------------------
// 旧展示只写「已索引 N 页 / 待补 M 页」，N 取自 index_status 的行数：
//   · 没有分母——用户不知道库里到底有多少页面，看不出「281 页只索了 40 页」；
//   · 不区分来源——「补算失败（embedding 调用出错）」「压根没配向量模型」「页面从未入索引」三种情况
//     在界面上长得一样，用户无法判断该去配模型、该重建，还是根本没问题。
// 本改动把展示口径换成「向量覆盖 N/M 页」+ 三类来源明细，并让向量模型名参与判定（旧向量待补）。
// 挂载真实 Config.vue：源码断言证明不了「状态端点字段 → ref → 模板文本」这条链真的接上。
import 'fake-indexeddb/auto';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { flushPromises, mount, type VueWrapper } from '@vue/test-utils';
import { nextTick } from 'vue';
import { createPinia, setActivePinia } from 'pinia';
import ElementPlus, { ElMessage } from 'element-plus';
import Config from '../src/views/Config.vue';
import { useAuthStore } from '../src/stores/auth';
import { findTabMeta } from '../src/utils/configTabs';
import { NO_TIMER_CHAIN, waitForProgress } from './helpers/waitForProgress';

vi.mock('element-plus', async (importOriginal) => {
  const actual = (await importOriginal()) as Record<string, unknown>;
  return {
    ...actual,
    ElMessage: { success: vi.fn(), error: vi.fn(), warning: vi.fn(), info: vi.fn() },
    ElMessageBox: { confirm: vi.fn().mockResolvedValue(true), prompt: vi.fn(), alert: vi.fn() },
  };
});

const AI_TAB_LABEL = findTabMeta('ai')?.label ?? '';

const CONFIG_FIXTURE = {
  vaultPath: '/tmp/vault',
  adapter: 'claude',
  llm: { provider: 'glm', baseUrl: 'https://example.invalid/v1', model: 'glm-4', apiKeyRef: 'env:GLM', apiKeySet: true, stream: false },
  budget: { maxSteps: 20, tokenBudget: 200000 },
  server: { host: 'localhost', port: 3000 },
  localOnly: true,
  healthCheck: { staleDays: 30 },
  batch: { allowedExtensions: ['md', 'txt'], maxBatchSize: 50, maxFileSizeMb: 10 },
  logging: { level: 'info', enableRequestLog: true },
  enableSubAgents: false,
};

// 分母 4 页：2 页有向量（covered）、1 页补算失败 3 次（pending + attempts）、1 页从未入索引；
// staleModelPages 只在请求带 model 时才由后端算出（这里给 2，用于断言明细真的渲染）。
const STATUS_FIXTURE = {
  enabled: true,
  totalChunks: 17,
  totalPages: 4,
  coveredPages: 2,
  pendingPages: 1,
  failedPages: 1,
  unindexedPages: 1,
  staleModelPages: 2,
};

function json(body: unknown, ok = true): Response {
  return { ok, status: ok ? 200 : 500, json: async () => body } as unknown as Response;
}

let statusUrls: string[] = [];
let statusFixture = { ...STATUS_FIXTURE };

function installFetchStub(): void {
  statusUrls = [];
  statusFixture = { ...STATUS_FIXTURE };
  vi.stubGlobal(
    'fetch',
    vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      const method = (init?.method ?? 'GET').toUpperCase();
      if (url.includes('/api/search/status')) {
        statusUrls.push(url);
        return json(statusFixture);
      }
      if (url.includes('/api/search/rebuild') && method === 'POST') return json({ status: {} });
      if (url.endsWith('/api/config') && method === 'GET') return json(structuredClone(CONFIG_FIXTURE));
      if (url.endsWith('/api/config/effects')) return json({ items: [] });
      if (url.endsWith('/api/config/mcp')) return json({ enabled: false });
      if (url.endsWith('/api/schema')) return json({ content: '' });
      if (url.endsWith('/api/schema/history')) return json({ commits: [], gitEnabled: false });
      if (url.endsWith('/api/prompts')) return json({ prompts: [] });
      if (url.endsWith('/api/qq-ingest/config')) return json({ qq: {} });
      if (url.endsWith('/api/ai/presets')) return json({ presets: [] });
      if (url.endsWith('/api/ai/config')) return json({ provider: 'glm', baseUrl: '', model: '', apiKeyMasked: '', apiKeySet: false });
      if (url.endsWith('/api/media/shared')) return json({ image: {}, video: {} });
      if (url.endsWith('/api/media/presets')) return json({ imagePresets: [], videoPresets: [] });
      return json({});
    }),
  );
}

async function mountConfigOnAiTab(): Promise<VueWrapper> {
  setActivePinia(createPinia());
  const auth = useAuthStore();
  auth.token = 't04073';
  auth.user = {
    id: 'u-t04073',
    username: 'admin',
    role: 'admin',
    enabled: true,
    createdAt: '2026-10-01T00:00:00.000Z',
    updatedAt: '2026-10-01T00:00:00.000Z',
    permissions: [],
  };
  const wrapper = mount(Config, {
    global: { plugins: [ElementPlus], stubs: { MarkdownRenderer: true, LocalDataBackupPanel: true, ThemeSwitcher: true } },
    attachTo: document.body,
  });
  await flushPromises();
  await flushPromises();
  await nextTick();
  const nav = wrapper.findAll('.nav-item').find((node) => node.text().includes(AI_TAB_LABEL));
  expect(nav, `配置中心导航里必须有「${AI_TAB_LABEL}」`).toBeTruthy();
  await nav!.trigger('click');
  // AI 面板懒挂载 + loadAiConfig 走 IndexedDB（fake-indexeddb 的回调是宏任务）：
  // 只 flushPromises 两轮会停在 loadingAi=true，此时整张表单（含语义索引行）都还没进 DOM。
  // 等待条件就是被测的那块 DOM（T02753：终点可观测一律用公共工具，不裸写时长）；
  // 这条链路没有产品侧定时器，预算取公共出口里同一场景的 NO_TIMER_CHAIN。
  await waitForProgress(
    'AI 面板的语义索引状态行进入 DOM（loadingAi 落定）',
    () => wrapper.find('[data-testid="search-index-status"]').exists(),
    { ...NO_TIMER_CHAIN },
  );
  return wrapper;
}

beforeEach(() => {
  localStorage.clear();
  sessionStorage.clear();
  while (document.body.firstElementChild) document.body.firstElementChild.remove();
  installFetchStub();
});

let wrapper: VueWrapper | null = null;

afterEach(() => {
  wrapper?.unmount();
  wrapper = null;
  vi.unstubAllGlobals();
  vi.clearAllMocks();
});

// 单用例预算：本文件故意真实挂载 Config.vue（源码断言证明不了「状态端点字段 → ref → 模板文本」这条链），
// 而「挂载 → 点导航 → AI 面板懒渲染 → 等状态行进 DOM」实测单条 2.3–5.3s（全套平均 4.1s/条，E 含重建回读最慢），
// 默认 5000ms 正好卡在边界上——并发全套时被抢占就会假失败，故按测量值放大（等待本身仍走 waitForProgress，不是靠放宽预算掩盖）。
const MOUNT_BUDGET_MS = 20_000;

describe('T04073 配置中心向量覆盖展示', () => {
  it('A · 主行给分母：向量覆盖 N/M 页，而不是只报索引表行数', async () => {
    wrapper = await mountConfigOnAiTab();
    const status = wrapper.find('[data-testid="search-index-status"]');
    expect(status.exists()).toBe(true);
    expect(status.text()).toContain('向量覆盖 2/4 页');
    // 旧口径「已索引 2 页」不得回潮：那样子用户看不到 4 页这个分母
    expect(status.text()).not.toMatch(/已索引\s*2\s*页/);
  }, MOUNT_BUDGET_MS);

  it('B · 待补拆三类来源：未索引 / 补算失败 / 向量缺失或属旧模型都点名', async () => {
    wrapper = await mountConfigOnAiTab();
    const detail = wrapper.find('[data-testid="search-index-detail"]');
    expect(detail.exists()).toBe(true);
    expect(detail.text()).toContain('未索引 1 页');
    expect(detail.text()).toContain('向量待补 1 页（补算失败 1 页）');
    expect(detail.text()).toContain('向量缺失或属旧模型 2 页');
  }, MOUNT_BUDGET_MS);

  it('C · 补算失败为 0 时不再谎报「失败」，只剩待补', async () => {
    statusFixture = { ...STATUS_FIXTURE, failedPages: 0 };
    wrapper = await mountConfigOnAiTab();
    const detail = wrapper.find('[data-testid="search-index-detail"]');
    expect(detail.text()).toContain('向量待补 1 页');
    expect(detail.text()).not.toContain('补算失败');
  }, MOUNT_BUDGET_MS);

  it('D · 填了向量模型才请求旧模型口径，且模型名走查询串（不是密钥，可入 URL）', async () => {
    wrapper = await mountConfigOnAiTab();
    statusFixture = { ...STATUS_FIXTURE, staleModelPages: null };
    await wrapper.find('#ai-embedding-model').setValue('bge-m3');
    await flushPromises();
    expect(statusUrls.at(-1)).toContain('/api/search/status?model=bge-m3');
  }, MOUNT_BUDGET_MS);

  it('E · 重建后回读同一条状态契约，成功文案用覆盖率而不是索引行数', async () => {
    wrapper = await mountConfigOnAiTab();
    const before = statusUrls.length;
    statusFixture = { ...STATUS_FIXTURE, coveredPages: 4, pendingPages: 0, failedPages: 0, unindexedPages: 0 };
    await wrapper.find('[data-testid="rebuild-index-btn"]').trigger('click');
    await flushPromises();
    await flushPromises();
    expect(statusUrls.length).toBeGreaterThan(before);
    const success = vi.mocked(ElMessage.success).mock.calls.at(-1)?.[0] ?? '';
    expect(String(success)).toContain('向量覆盖 4/4 页');
  }, MOUNT_BUDGET_MS);
});
