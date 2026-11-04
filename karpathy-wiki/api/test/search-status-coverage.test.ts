// T04073 检索模式与索引覆盖的响应契约：把「语义路到底开没开、向量到底覆盖了几页」钉在可执行契约上。
// ------------------------------------------------------------------
// 缺陷形态：功能没错，错的是「没说」。未配置 embedding 时语义路静默关闭，接口既不回传判据，
// 设置页也只能显示「已索引 N 页」——而 N 取自 index_status 行数，既不含从未入索引的页面，
// 又把已删除页面的行留在里面，pending 还混着「没配 key」和「补算失败」两种完全不同的原因。
// 于是用户看到「已索引 3 页」会以为检索是全的，实际一半页面连关键词路都搜不到。
//
// 本文件锁三层：
//   A) 字段存在性：GET /api/search 与 /api/search/hybrid 在无 embedding 时都回传 semanticEnabled=false，
//      GET /api/search/status 在启用/未启用两种形状下给出同一批覆盖字段名（前端不必猜形状）；
//   B) 覆盖口径：分母取 vault 页面清单，indexed/pending(补算失败|未尝试)/未索引分别计数，
//      已删除页面不计入向量覆盖——并与 getIndexStatus().indexedPages 对拉，证明「拿行数当分母」确实会算错；
//   C) 跨服务字段名：api 的 IndexCoverage 与前端 types/search.ts 的 SearchIndexStatus 逐字对齐，
//      两侧 tsconfig 互不可见（T02773 同族缺陷），任何一侧改名都会在这里红。
import { describe, it, expect, afterEach } from 'vitest';
import Fastify, { type FastifyInstance, type LightMyRequestResponse, type preHandlerHookHandler } from 'fastify';
import fs from 'node:fs/promises';
import { readFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { registerSearchRoute } from '../src/routes/search.js';
import { getIndexCoverage, type IndexCoverage } from '../src/search/hybrid-search.js';
import {
  closeIndexDb,
  getIndexStatus,
  markIndexFailed,
  replacePageChunks,
  savePageVectors,
} from '../src/search/sqlite-index.js';
import type { VaultService } from '../src/vault/vault-service.js';

/**
 * 覆盖统计里来自 IndexCoverage 的字段（前端 types/search.ts 里另有 enabled/totalChunks 两个包装字段）。
 * `satisfies readonly (keyof IndexCoverage)[]` 让这份名单在**编译期**就绑死在接口上：接口改名/加名而这里没跟上，
 * typecheck:test 直接红（原先名单是 string[]，只能在下面 C) 那条源码文本比对里才发现，且动态取字段要报 TS7053）。
 * 名单要当集合用（含非本接口字段，如 feFields 里的 enabled/totalChunks），所以另开一个 string 视图 `COVERAGE_FIELD_NAMES`。
 */
const COVERAGE_FIELDS = [
  'totalPages',
  'coveredPages',
  'pendingPages',
  'failedPages',
  'unindexedPages',
  'staleModelPages',
] as const satisfies readonly (keyof IndexCoverage)[];

/** 与上同源的 string 视图，供 `includes`/差集这类宽口径比较使用 */
const COVERAGE_FIELD_NAMES: string[] = [...COVERAGE_FIELDS];

/**
 * 只读页面目录 + readFile 的最小 vault。
 * getChangeRevision 故意抛错：registerSearchRoute 会 `void ensureIndexSynced(...).catch()`，
 * 首次同步会把全部页面重新切成 pending，把手工布置的 indexed/failed/未索引 fixture 冲刷掉，
 * 覆盖数字就失去意义。抛错被那两处 catch 接住，本文件因此走「纯 fixture + 关键词回退全库扫描」路径。
 */
function stubVault(vaultPath: string): VaultService {
  return {
    getVaultPath: () => vaultPath,
    readFile: (rel: string) => fs.readFile(path.join(vaultPath, rel), 'utf8'),
    getChangeRevision: () => {
      throw new Error('stub：契约测试不启用后台索引同步');
    },
  } as unknown as VaultService;
}

// 本文件测响应契约与覆盖口径，不测 RBAC（后者由 user-admin-guard.test.ts 覆盖）
const passThrough: preHandlerHookHandler = (_req, _reply, done) => done();
function stubGuards() {
  return { enabled: false, requireAuth: passThrough, requireAdmin: passThrough };
}

function chunk(text: string) {
  return [{ content: text, heading: null }];
}

/** 一页 8 维向量：model 由 savePageVectors 记录，数值本身不参与本单断言 */
function fakeVec(seed: number): Float32Array {
  const v = new Float32Array(8);
  v[seed % 8] = 1;
  return v;
}

interface Fixture {
  tempRoot: string;
  vaultPath: string;
  dataDir: string;
}

/**
 * 4 个在库页面 + 1 个「索引里还留着但文件已删」的幽灵页，覆盖统计的每一种来源各占一格：
 *   covered-a  已切分 + 已算向量（model-a）        → coveredPages
 *   pending-b  已切分、attempts=0                 → pendingPages（没配 key / 还没轮到）
 *   failed-c   已切分、补算失败过 1 次             → pendingPages ∩ failedPages
 *   unindexed-d 从未入索引（index_status 无行）    → unindexedPages
 *   ghost.md    文件已删、索引行为 indexed          → 被分母排除，但 getIndexStatus 仍计入
 */
async function seedFixture(model = 'model-a'): Promise<Fixture> {
  const tempRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'wiki-search-coverage-'));
  const vaultPath = path.join(tempRoot, 'vault');
  const dataDir = path.join(tempRoot, 'data');
  await fs.mkdir(path.join(vaultPath, 'concepts'), { recursive: true });
  const write = (name: string, body: string) => fs.writeFile(path.join(vaultPath, 'concepts', name), body, 'utf8');
  await Promise.all([
    write('covered-a.md', '# alpha\n覆盖页正文 alpha beta gamma\n'),
    write('pending-b.md', '# beta\n待补页正文 beta gamma delta\n'),
    write('failed-c.md', '# gamma\n补算失败页 gamma delta epsilon\n'),
    write('unindexed-d.md', '# delta\n从未入索引页 delta epsilon zeta\n'),
  ]);

  replacePageChunks(dataDir, 'concepts/covered-a.md', chunk('覆盖页正文 alpha beta gamma'));
  savePageVectors(dataDir, 'concepts/covered-a.md', [fakeVec(1)], model);
  replacePageChunks(dataDir, 'concepts/pending-b.md', chunk('待补页正文 beta gamma delta'));
  replacePageChunks(dataDir, 'concepts/failed-c.md', chunk('补算失败页 gamma delta epsilon'));
  markIndexFailed(dataDir, 'concepts/failed-c.md');
  // 幽灵页：只写索引不写文件（等价于「页面被删但索引没清」的历史遗留）
  replacePageChunks(dataDir, 'concepts/ghost.md', chunk('幽灵页 alpha beta'));
  savePageVectors(dataDir, 'concepts/ghost.md', [fakeVec(2)], model);
  return { tempRoot, vaultPath, dataDir };
}

async function json(res: LightMyRequestResponse): Promise<Record<string, unknown>> {
  expect(res.statusCode, `接口返回 ${res.statusCode}：${res.body}`).toBe(200);
  return res.json() as Record<string, unknown>;
}

describe('T04073 检索模式与索引覆盖契约', () => {
  let fixture: Fixture | null = null;
  let app: FastifyInstance | null = null;

  afterEach(async () => {
    await app?.close();
    app = null;
    closeIndexDb();
    if (fixture) {
      await fs.rm(fixture.tempRoot, { recursive: true, force: true });
      fixture = null;
    }
  });

  async function boot(model?: string): Promise<Fixture> {
    fixture = await seedFixture(model ?? 'model-a');
    app = Fastify();
    registerSearchRoute(app, stubVault(fixture.vaultPath), fixture.dataDir, stubGuards());
    await app.ready();
    return fixture;
  }

  // ── A) 字段存在性：semanticEnabled 必须在两个检索端点都回传 ──
  it('GET /api/search 的响应带 semanticEnabled=false（本端点只有关键词路）', async () => {
    await boot();
    const body = await json(await app!.inject({ method: 'GET', url: '/api/search?q=alpha' }));
    expect(body, '缺少 semanticEnabled：前端无法判定检索模式').toHaveProperty('semanticEnabled');
    expect(body.semanticEnabled).toBe(false);
    const hits = body.hits as Array<{ path: string }>;
    expect(Array.isArray(hits)).toBe(true);
    expect(hits.length).toBeGreaterThan(0);
    expect(body.total).toBe(hits.length);
  });

  it('POST /api/search/hybrid 未携带 embedding 时 semanticEnabled=false，关键词路仍有结果', async () => {
    await boot();
    const body = await json(await app!.inject({
      method: 'POST',
      url: '/api/search/hybrid',
      payload: { query: 'alpha' },
    }));
    expect(body.semanticEnabled).toBe(false);
    expect((body.hits as unknown[]).length).toBeGreaterThan(0);
  });

  it('GET /api/search/status 一次性给出全部覆盖字段（不拆成两次请求）', async () => {
    await boot();
    const body = await json(await app!.inject({ method: 'GET', url: '/api/search/status' }));
    expect(body.enabled).toBe(true);
    for (const field of COVERAGE_FIELDS) expect(body, `status 响应缺字段 ${field}`).toHaveProperty(field);
    // 设置页同时展示块数与同步信息：这两个字段名也在这里锁定
    expect(body).toHaveProperty('totalChunks');
    expect(body).toHaveProperty('sync');
    // 旧的 indexedPages 不能再出现：它与 coveredPages 口径不同，同屏并列会让用户读到两个「已索引」
    expect(body, 'indexedPages 与 coveredPages 同屏即歧义').not.toHaveProperty('indexedPages');
  });

  it('索引未启用（无数据目录）时用同一批字段名回零值，前端不必区分两种形状', async () => {
    const tempRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'wiki-search-coverage-off-'));
    fixture = { tempRoot, vaultPath: path.join(tempRoot, 'vault'), dataDir: path.join(tempRoot, 'data') };
    app = Fastify();
    registerSearchRoute(app, stubVault(fixture.vaultPath), undefined, stubGuards());
    await app.ready();
    const body = await json(await app.inject({ method: 'GET', url: '/api/search/status' }));
    expect(body.enabled).toBe(false);
    expect(
      Object.keys(body).sort(),
      '未启用分支的字段名与启用分支不一致：前端需要按形状分支，正是本单要消除的歧义',
    ).toEqual(['enabled', 'totalChunks', 'sync', 'caches', ...COVERAGE_FIELDS].sort());
    for (const field of COVERAGE_FIELDS) {
      expect(body[field], `${field} 未置零`).toBe(field === 'staleModelPages' ? null : 0);
    }
  });

  // ── B) 覆盖口径 ──
  it('分母取 vault 页面清单，pending 拆出补算失败，未入索引单独计数', async () => {
    await boot();
    const coverage = await getIndexCoverage(fixture!.dataDir, stubVault(fixture!.vaultPath));
    expect(coverage.totalPages).toBe(4);
    expect(coverage.coveredPages).toBe(1);
    expect(coverage.pendingPages).toBe(2);
    expect(coverage.failedPages).toBe(1);
    expect(coverage.unindexedPages).toBe(1);
    expect(coverage.staleModelPages).toBeNull();
    // 三种来源互斥且并起来等于分母：漏一类就会有页面在设置页上「凭空消失」
    expect(coverage.coveredPages + coverage.pendingPages + coverage.unindexedPages).toBe(coverage.totalPages);
    expect(coverage.failedPages).toBeLessThanOrEqual(coverage.pendingPages);
  });

  it('已删除页面的索引行不计入向量覆盖：拿 index_status 行数当分母确实会算错', async () => {
    await boot();
    const coverage = await getIndexCoverage(fixture!.dataDir, stubVault(fixture!.vaultPath));
    const legacy = getIndexStatus(fixture!.dataDir);
    // ghost.md 文件已删但索引仍在：旧口径把它算作「已索引」，且总数里看不见未索引页面
    expect(legacy.indexedPages).toBe(2);
    expect(coverage.coveredPages).toBe(1);
    expect(coverage.coveredPages, '向量覆盖数被索引行数虚报').toBeLessThan(legacy.indexedPages);
    expect(coverage.totalPages, '分母混入已删除页面').toBe(4);
  });

  it('GET /api/search/status 与 getIndexCoverage 同一口径（前端显示即后端算的那份）', async () => {
    await boot();
    const coverage = await getIndexCoverage(fixture!.dataDir, stubVault(fixture!.vaultPath));
    const body = await json(await app!.inject({ method: 'GET', url: '/api/search/status' }));
    for (const field of COVERAGE_FIELDS) expect(body[field], `${field} 接口值与计算值不一致`).toBe(coverage[field]);
  });

  it('?model= 决定旧模型待补页数：不传为 null，换了模型即重新计入', async () => {
    await boot('model-a');
    const same = await json(await app!.inject({ method: 'GET', url: '/api/search/status?model=model-a' }));
    // 与当前模型一致：只有「没向量的在库页」待补（pending-b + failed-c），ghost 不在库不计
    expect(same.staleModelPages).toBe(2);
    const switched = await json(await app!.inject({ method: 'GET', url: '/api/search/status?model=model-b' }));
    // 切模型后 covered-a 的向量不可比，一起进入待补
    expect(switched.staleModelPages).toBe(3);
    expect(switched.coveredPages, '切模型不得改动向量覆盖本身（那是历史事实）').toBe(1);
  });

  // ── C) 跨服务字段名锁（编译器看不见的那一半） ──
  it('api IndexCoverage 与前端 SearchIndexStatus 字段名逐字对齐', () => {
    const apiFile = path.resolve(__dirname, '../src/search/hybrid-search.ts');
    const feFile = path.resolve(__dirname, '../../frontend/src/types/search.ts');
    const apiFields = interfaceFields(apiFile, 'IndexCoverage');
    const feFields = interfaceFields(feFile, 'SearchIndexStatus');
    expect(apiFields.slice().sort(), `api 侧字段变化：${apiFile}`).toEqual([...COVERAGE_FIELDS].sort());
    // 前端可以多出接口包装字段，但只能是需要后端一起锁住的这两个
    const extra = feFields.filter((f) => !COVERAGE_FIELD_NAMES.includes(f));
    expect(extra.slice().sort()).toEqual(['enabled', 'totalChunks']);
    for (const field of COVERAGE_FIELDS) expect(feFields, `前端缺字段 ${field}（跨服务错配）`).toContain(field);
  });

  it('后端路由确实把 semanticEnabled 写进检索响应（不是只在类型里加个名）', () => {
    const route = readFileSync(path.resolve(__dirname, '../src/routes/search.ts'), 'utf8');
    const sends = route.split(/\r?\n/).filter((l) => l.includes('semanticEnabled'));
    expect(sends.length, '检索端点里已不再回传 semanticEnabled').toBeGreaterThanOrEqual(2);
    for (const line of sends) {
      expect(line).toMatch(/semanticEnabled/);
    }
  });
});

/** 从源码文本抽取 interface 的字段名（与 cleanup-freed-contract.test.ts 同一口径） */
function interfaceFields(file: string, name: string): string[] {
  const text = readFileSync(file, 'utf8')
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .split(/\r?\n/)
    .filter((line) => !line.trim().startsWith('//'))
    .join('\n');
  const block = new RegExp(`export interface ${name} \\{([\\s\\S]*?)\\n\\}`).exec(text);
  expect(block, `${name} 接口未找到（${file}）`).toBeTruthy();
  return [...block![1].matchAll(/^\s{2}(?:readonly\s+)?([A-Za-z_$][\w$]*)\??\s*:/gm)].map((m) => m[1]);
}
