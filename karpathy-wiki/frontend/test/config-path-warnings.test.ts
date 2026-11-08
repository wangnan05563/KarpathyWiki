// T04579 页面级验收：定根后失效的绝对路径（T04558 服务端只告警不改写）要在配置页可见。
// ------------------------------------------------------------------
// 为什么挂载真实 Config.vue：源码断言只能证明「模板里写了 v-if」，证明不了
// 「GET /api/config.pathWarnings → 状态 → 顶部警示条 → 重新选择指引」这条链真的通。
// 口径：
//   1) pathWarnings 非空 ⇒ 系统配置页顶部警示条可见，逐条点名字段 / 路径 / 原因；
//   2) pathWarnings 为空或缺省 ⇒ 不显示（不误报）；
//   3) 展示期间与点「重新选择」期间都不得产生任何配置写请求（不自动纠正）。
import 'fake-indexeddb/auto';
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { mount, flushPromises, type VueWrapper } from '@vue/test-utils';
import { nextTick } from 'vue';
import { createPinia, setActivePinia } from 'pinia';
import ElementPlus from 'element-plus';
import Config from '../src/views/Config.vue';
import { useAuthStore } from '../src/stores/auth';

vi.mock('element-plus', async (importOriginal) => {
  const actual = (await importOriginal()) as Record<string, unknown>;
  return {
    ...actual,
    ElMessage: { success: vi.fn(), error: vi.fn(), warning: vi.fn(), info: vi.fn() },
    ElMessageBox: { confirm: vi.fn().mockResolvedValue(true), prompt: vi.fn(), alert: vi.fn() },
  };
});

const CONFIG_FIXTURE = {
  vaultPath: 'E:\\OldVault',
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

const QQ_FIXTURE = {
  noise_rules: { 'NR-1': true },
  privacy_patterns: { phone: '1[3-9]\\d{9}' },
  max_batch_size: 20,
  chunk_threshold: 200,
  extract_model: 'glm-4-plus',
  extract_base_url: '',
  extract_token_budget: 50000,
};

const PATH_WARNINGS = [
  { field: 'vaultPath', path: 'E:\\OldVault', reason: '目录不存在' },
  { field: 'logging.logFilePath', path: 'F:\\logs\\app.log', reason: '上级目录不存在' },
];

function json(body: unknown, ok = true): Response {
  return { ok, status: ok ? 200 : 500, json: async () => body } as unknown as Response;
}

// 只记配置写请求：其它页签 onMounted 的只读请求不参与「不自动纠正」的判定。
let configWrites: string[] = [];

function installFetchStub(pathWarnings: unknown): void {
  configWrites = [];
  vi.stubGlobal(
    'fetch',
    vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      const method = (init?.method ?? 'GET').toUpperCase();
      if (url.includes('/api/config') && method !== 'GET') {
        configWrites.push(`${method} ${url}`);
      }
      if (url.endsWith('/api/config') && method === 'GET') {
        return json({ ...structuredClone(CONFIG_FIXTURE), pathWarnings });
      }
      if (url.endsWith('/api/config/effects')) return json({ items: [] });
      if (url.endsWith('/api/schema')) return json({ content: '' });
      if (url.endsWith('/api/schema/history')) return json({ commits: [], gitEnabled: false });
      if (url.endsWith('/api/prompts')) return json({ prompts: [] });
      if (url.endsWith('/api/qq-ingest/config')) return json({ qq: QQ_FIXTURE });
      if (url.endsWith('/api/ai/presets')) return json({ presets: [] });
      if (url.endsWith('/api/ai/config')) return json({ provider: 'glm', baseUrl: '', model: '', apiKeyMasked: '', apiKeySet: false });
      if (url.endsWith('/api/media/shared')) return json({ image: {}, video: {} });
      if (url.endsWith('/api/media/presets')) return json({ imagePresets: [], videoPresets: [] });
      if (url.endsWith('/api/search/status')) return json({ indexedPages: 0, pendingPages: 0, totalChunks: 0 });
      if (url.endsWith('/api/config/mcp')) {
        return json({ enabled: false, endpointPath: '/mcp', name: 'karpathy-wiki', version: '1.0.0', authenticated: false, userTokenMasked: '', adminTokenMasked: '' });
      }
      return json({});
    }),
  );
}

async function mountConfig(pathWarnings: unknown): Promise<VueWrapper> {
  installFetchStub(pathWarnings);
  setActivePinia(createPinia());
  const auth = useAuthStore();
  auth.token = 'test-token';
  auth.user = {
    id: 'u-t04579',
    username: 'admin',
    role: 'admin',
    enabled: true,
    createdAt: '2026-10-01T00:00:00.000Z',
    updatedAt: '2026-10-01T00:00:00.000Z',
    permissions: [],
  };
  const wrapper = mount(Config, {
    global: {
      plugins: [ElementPlus],
      stubs: { MarkdownRenderer: true, LocalDataBackupPanel: true, ThemeSwitcher: true },
    },
    attachTo: document.body,
  });
  await flushPromises();
  await flushPromises();
  await nextTick();
  return wrapper;
}

function rechooseButtons(wrapper: VueWrapper) {
  return wrapper.findAll('button').filter((b) => b.text() === '重新选择');
}

describe('T04579 配置页展示路径失效告警', () => {
  let wrapper: VueWrapper | null = null;

  beforeEach(() => {
    localStorage.clear();
    sessionStorage.clear();
    while (document.body.firstElementChild) document.body.firstElementChild.remove();
  });

  afterEach(() => {
    wrapper?.unmount();
    wrapper = null;
    vi.unstubAllGlobals();
    vi.clearAllMocks();
  });

  it('pathWarnings 非空：系统配置页顶部警示条可见，逐条点名字段 / 路径 / 原因', async () => {
    wrapper = await mountConfig(PATH_WARNINGS);

    const banner = wrapper.find('[data-testid="path-warning"]');
    expect(banner.exists(), '非空 pathWarnings 必须渲染警示条').toBe(true);
    expect(banner.text()).toContain('2 个路径在磁盘上不存在');
    expect(banner.text()).toContain('知识库目录');
    expect(banner.text()).toContain('E:\\OldVault');
    expect(banner.text()).toContain('目录不存在');
    expect(banner.text()).toContain('日志文件');
    expect(banner.text()).toContain('F:\\logs\\app.log');
    expect(banner.text()).toContain('上级目录不存在');
    expect(rechooseButtons(wrapper)).toHaveLength(2);
    // 只展示不改写：加载完成不应产生任何配置写请求
    expect(configWrites).toEqual([]);
  });

  it('pathWarnings 为空数组：不显示警示条（不误报）', async () => {
    wrapper = await mountConfig([]);
    expect(wrapper.find('[data-testid="path-warning"]').exists()).toBe(false);
  });

  it('后端未返回 pathWarnings（旧版本）：同样不显示警示条', async () => {
    wrapper = await mountConfig(undefined);
    expect(wrapper.find('[data-testid="path-warning"]').exists()).toBe(false);
  });

  it('点「重新选择」给出指引且不写配置；可跳到数据迁移页', async () => {
    wrapper = await mountConfig(PATH_WARNINGS);

    const btn = rechooseButtons(wrapper)[0];
    expect(btn.exists()).toBe(true);
    await btn.trigger('click');
    await nextTick();
    await flushPromises();

    // 指引弹窗说明浏览器不能直接选服务端目录，并给出两条修正路径
    const bodyText = document.body.textContent ?? '';
    expect(bodyText).toContain('重新选择配置路径');
    expect(bodyText).toContain('浏览器无法直接选择服务器上的目录');
    expect(bodyText).toContain('config.json.bak');
    expect(configWrites).toEqual([]);

    const goMigrate = Array.from(document.querySelectorAll('button')).find((b) =>
      (b.textContent ?? '').includes('去数据迁移'),
    );
    expect(goMigrate, '指引弹窗必须有「去数据迁移」入口').toBeTruthy();
    (goMigrate as HTMLButtonElement).click();
    await flushPromises();
    await nextTick();

    const migratePanel = wrapper.find('[role="tabpanel"][aria-label="数据迁移"]');
    expect(migratePanel.exists()).toBe(true);
    expect(migratePanel.isVisible()).toBe(true);
    // 跳转仍是纯前端导航，不落任何配置写
    expect(configWrites).toEqual([]);
  });
});
