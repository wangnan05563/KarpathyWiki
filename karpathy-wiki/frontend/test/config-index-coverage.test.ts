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
import { STORAGE_KEYS } from '../src/constants/storageKeys';
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

// 指定状态码的响应：401/403 的文案区分只能靠真实状态码，用 json(body,false) 会被固化成 500
function httpJson(body: unknown, status: number, badJson = false): Response {
  return {
    ok: status < 400,
    status,
    // badJson 复现反向代理/网关返回 HTML 的情形：.json() 抛 SyntaxError，
    // 用于证明错误分支不会把「解析失败」当成病因（盖掉真实状态码）
    json: async () => {
      if (badJson) throw new SyntaxError('Unexpected token < in JSON at position 0');
      return body;
    },
  } as unknown as Response;
}

let statusUrls: string[] = [];
let statusFixture: Record<string, unknown> = { ...STATUS_FIXTURE };
// 重建端点的应答形状（默认成功）：T04531 的 F/G/H/I/J 各按需要改造
let rebuildResponse: { body: unknown; status: number; badJson?: boolean } = { body: { status: {} }, status: 200 };
// T04531：重建请求的 Authorization 头实测留痕。
// 为什么记原始 init.headers 而不是只记 URL：本文件的静态对照测试（auth-guarded-endpoint-fetch）
// 只能证明 Config.vue 源码写了 apiFetch，证明不了「运行时真的把 Bearer 带上了」——
// 而用户报的正是运行时 401。故这里抓真实出站的请求头，把最后一环变成行为断言。
let rebuildRequests: { method: string; authorization: string | null; contentType: string | null }[] = [];

function installFetchStub(): void {
  statusUrls = [];
  rebuildRequests = [];
  statusFixture = { ...STATUS_FIXTURE };
  rebuildResponse = { body: { status: {} }, status: 200 };
  vi.stubGlobal(
    'fetch',
    vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      const method = (init?.method ?? 'GET').toUpperCase();
      if (url.includes('/api/search/status')) {
        statusUrls.push(url);
        return json(statusFixture);
      }
      if (url.includes('/api/search/rebuild') && method === 'POST') {
        // apiFetch 传进来的是 Headers 实例；用 new Headers() 归一，裸对象/数组写法也能读
        const headers = new Headers(init?.headers);
        rebuildRequests.push({
          method,
          authorization: headers.get('authorization'),
          contentType: headers.get('content-type'),
        });
        return httpJson(rebuildResponse.body, rebuildResponse.status, rebuildResponse.badJson);
      }
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
  // T04531：真实登录态必须同时落 localStorage。
  // 线上「登录 → 刷新页面」后，token 的权威来源是 auth store 持久化的 STORAGE_KEYS.AUTH_TOKEN
  // （store 里的 ref 只是内存副本）；重建请求走 apiFetch，它只读 localStorage。
  // 只赋 Pinia token 的旧夹具等于把「已登录」写成半个状态，正好看不见本次缺陷——
  // 那样 add 出来的 Authorization 断言会在一个不真实的场景里跑。
  localStorage.setItem(STORAGE_KEYS.AUTH_TOKEN, 't04073');
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

  // ── T04531：建索引按钮的登录态误报（已登录点重建 → 「未登录或会话已过期」） ──
  // 上一条 E 只证明「点按钮会发重建请求」，没证明「请求带凭据」——而这正是缺陷本体。
  it('F · 重建请求真的携带 Bearer：已登录点按钮不再被后端当游客', async () => {
    wrapper = await mountConfigOnAiTab();
    await wrapper.find('[data-testid="rebuild-index-btn"]').trigger('click');
    await flushPromises();
    expect(rebuildRequests.length, '点击建索引必须发出 POST /api/search/rebuild').toBe(1);
    // 回归点：旧写法用裸 fetch，这里读到的是 null —— 后端因此走到 requireAuth/requireAdmin 的
    // 「无凭据」分支返回 401，前端把服务器真话原样透出成「会话过期」
    expect(rebuildRequests[0].authorization).toBe('Bearer t04073');
    // apiFetch 用 new Headers(init.headers) 合并调用方头：Content-Type 不能被注入逻辑吃掉
    expect(rebuildRequests[0].contentType).toContain('application/json');
  }, MOUNT_BUDGET_MS);

  it('G · 未登录（无持久化 token）时不带 Authorization：不伪造凭据，也不误报成功', async () => {
    wrapper = await mountConfigOnAiTab();
    // 夹具里 localStorage 与 Pinia 同时给了 token；这里只清 localStorage，
    // 复现「刷新后 restoreSession 还没跑完」的窗口——重建仍应诚实裸发，而不是发出空 Bearer
    localStorage.removeItem(STORAGE_KEYS.AUTH_TOKEN);
    await wrapper.find('[data-testid="rebuild-index-btn"]').trigger('click');
    await flushPromises();
    expect(rebuildRequests.length).toBe(1);
    expect(rebuildRequests[0].authorization ?? '').not.toMatch(/^Bearer\s*$/);
  }, MOUNT_BUDGET_MS);

  it('H · 后端 403 权限不足透成「权限不足」，不再冒充会话问题', async () => {
    wrapper = await mountConfigOnAiTab();
    // ai 页签对非管理员可见（adminOnly:false），这条路径真实可点。
    // 本条锁的是需求「返回真实原因」这一验收面：403 文案必须落在权限语义上，
    // 任何把失败统一说成「会话已过期」的改法都会在这里变红。
    rebuildResponse = { body: { error: '权限不足' }, status: 403 };
    await wrapper.find('[data-testid="rebuild-index-btn"]').trigger('click');
    await flushPromises();
    const error = vi.mocked(ElMessage.error).mock.calls.at(-1)?.[0] ?? '';
    expect(String(error)).toContain('索引重建失败：权限不足');
    expect(String(error)).not.toContain('未登录');
  }, MOUNT_BUDGET_MS);

  it('I · 真·会话失效（带 token 仍 401）仍如实报会话过期，并清理失效 token', async () => {
    wrapper = await mountConfigOnAiTab();
    rebuildResponse = { body: { error: '未登录或会话已过期', code: 'UNAUTHORIZED' }, status: 401 };
    await wrapper.find('[data-testid="rebuild-index-btn"]').trigger('click');
    await flushPromises();
    const error = vi.mocked(ElMessage.error).mock.calls.at(-1)?.[0] ?? '';
    expect(String(error)).toContain('未登录或会话已过期');
    // apiFetch 的 401 收口：本次带了 token 却 401 → 本地失效 token 必须被清掉，
    // 否则刷新后仍拿旧 token 反复撞 401（该清理只在 token 存在时触发，G 条的裸发不会误清）
    expect(localStorage.getItem(STORAGE_KEYS.AUTH_TOKEN)).toBeNull();
  }, MOUNT_BUDGET_MS);

  it('J · 错误体不是 JSON（反代 502）：状态码不丢，也不把解析异常当病因', async () => {
    wrapper = await mountConfigOnAiTab();
    // 这条才真正锁住「res.json().catch(() => ({})) + HTTP <code> 前缀」这一改动：
    // 旧写法 await res.json() 在非 JSON 响应上直接抛 SyntaxError，
    // 用户看到的是「Unexpected token < in JSON…」，真实故障（网关 502）被彻底盖掉
    rebuildResponse = { body: null, status: 502, badJson: true };
    await wrapper.find('[data-testid="rebuild-index-btn"]').trigger('click');
    await flushPromises();
    const error = vi.mocked(ElMessage.error).mock.calls.at(-1)?.[0] ?? '';
    expect(String(error)).toContain('网关错误');
    expect(String(error)).not.toMatch(/Unexpected token|JSON/);
  }, MOUNT_BUDGET_MS);
});
