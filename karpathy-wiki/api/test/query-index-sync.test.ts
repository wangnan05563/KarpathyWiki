// T04100：问答检索与 /api/search 共用同一索引 status（mtime 增量同步）的回归锁。
// 锁住四件事：
//   A 刚保存、还没被搜索页同步过的新页面——直接读索引看不见，经问答取数后必须可见（同一 getIndexStatus 口径）；
//   B/C 只有真正走语义路时才同步：scopeFilter 与无 embedding 两种关键词场景不得触发（零额外开销）；
//   D 同步失败不阻断问答：仍按现有索引召回，不向调用方抛错；
//   E 不得在问答侧另建第二套同步/缓存。
// 隔离纪律：vault 与索引库都落在 os.tmpdir() 随机目录；embedding 走本机 stub HTTP 服务，不消耗外部额度。
// 模块级状态（同步节流、派生缓存、SQLite 单例）会跨用例泄漏，故每个用例用 vi.resetModules() 取一份干净实例。
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { VaultService } from '../src/vault/vault-service.js';

// 语义坐标：文本按命中词表落到某一维，便于构造「只有新页在该维上」的场景
const AXES: Array<{ dim: number; words: string[] }> = [
  { dim: 0, words: ['远程协作', '在家办公', 'telecommuting', 'productivity'] },
  { dim: 1, words: ['图谱渲染', '力导向', 'layout'] },
  { dim: 2, words: ['增量同步新鲜度', 'fresh-sync'] },
];

function fakeEmbedding(text: string): number[] {
  const vec = [0, 0, 0, 0];
  const axis = AXES.find((a) => a.words.some((w) => text.includes(w)));
  vec[axis ? axis.dim : 3] = 1;
  return vec;
}

let server: http.Server;
let vaultDir = '';
let dataDir = '';
let vault: VaultService;
let syncCalls = 0;
const createdDirs: string[] = [];

const EMB = { baseUrl: '', apiKey: 'test-key', model: 'stub-embed' };

function writePage(relPath: string, body: string): void {
  const abs = path.join(vaultDir, relPath);
  mkdirSync(path.dirname(abs), { recursive: true });
  writeFileSync(abs, body, 'utf8');
}

interface FreshModules {
  retrieveForQuery: typeof import('../src/workflows/query-workflow.js').retrieveForQuery;
  hybridSearch: typeof import('../src/search/hybrid-search.js').hybridSearch;
  indexPage: typeof import('../src/search/hybrid-search.js').indexPage;
  getIndexStatus: typeof import('../src/search/sqlite-index.js').getIndexStatus;
  closeIndexDb: typeof import('../src/search/sqlite-index.js').closeIndexDb;
}

/**
 * 取一份干净的模块实例；sync 为 'noop'/'throw' 时把 indexed-search 换成计数替身，
 * 未指定则保留真实实现（用于 A 组验证真实同步链）。
 */
async function loadFresh(sync?: 'noop' | 'throw'): Promise<FreshModules> {
  vi.resetModules();
  syncCalls = 0;
  if (sync) {
    vi.doMock('../src/search/indexed-search.js', () => ({
      ensureIndexSynced: async () => {
        syncCalls += 1;
        if (sync === 'throw') throw new Error('索引同步失败');
        return { indexedPages: 0, updatedPages: 0, removedPages: 0, durationMs: 0, syncedAt: 0 };
      },
      searchPagesIndexed: async () => [],
      getIndexSyncInfo: () => ({ indexedPages: 0, updatedPages: 0, removedPages: 0, durationMs: 0, syncedAt: 0 }),
    }));
  }
  const qw = await import('../src/workflows/query-workflow.js');
  const hybrid = await import('../src/search/hybrid-search.js');
  const index = await import('../src/search/sqlite-index.js');
  return {
    retrieveForQuery: qw.retrieveForQuery,
    hybridSearch: hybrid.hybridSearch,
    indexPage: hybrid.indexPage,
    getIndexStatus: index.getIndexStatus,
    closeIndexDb: index.closeIndexDb,
  };
}

beforeAll(async () => {
  server = http.createServer((req, res) => {
    let raw = '';
    req.on('data', (c) => (raw += c));
    req.on('end', () => {
      const body = JSON.parse(raw || '{}') as { input?: string[] };
      const data = (body.input ?? []).map((text, index) => ({ index, embedding: fakeEmbedding(text) }));
      res.setHeader('Content-Type', 'application/json');
      res.end(JSON.stringify({ data }));
    });
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  EMB.baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}/v1`;
});

afterAll(async () => {
  await new Promise<void>((resolve) => server.close(() => resolve()));
  for (const dir of createdDirs) {
    try {
      rmSync(dir, { recursive: true, force: true });
    } catch {
      /* 清理失败不影响结果 */
    }
  }
});

beforeEach(() => {
  vaultDir = mkdtempSync(path.join(tmpdir(), 'wiki-qsync-vault-'));
  dataDir = mkdtempSync(path.join(tmpdir(), 'wiki-qsync-index-'));
  createdDirs.push(vaultDir, dataDir);
  vault = new VaultService(vaultDir);
  writePage('concepts/remote-work.md', '# 远程协作\n\n远程协作与在家办公的产出管理经验，涉及 telecommuting 与 productivity 两条主线。');
  writePage('concepts/graph-render.md', '# 图谱渲染\n\n力导向 layout 的性能优化方案，含图谱渲染的批次重算策略。');
});

describe('A · 刚保存的页面：问答取数与搜索页共用同一索引 status', () => {
  it('未经同步时索引里查不到新页；经问答 retrieveForQuery 后同一新页可召回', async () => {
    const m = await loadFresh();
    // 模拟「搜索页早前同步过」的存量库：只索引已有两页
    await m.indexPage(dataDir, vault, 'concepts/remote-work.md', EMB);
    await m.indexPage(dataDir, vault, 'concepts/graph-render.md', EMB);
    const before = m.getIndexStatus(dataDir).indexedPages;

    // 新保存的页面（走应用写盘入口，与用户点保存同一条路径）
    await vault.writeFile('concepts/fresh-page.md', '# 增量同步新鲜度\n\nfresh-sync 场景说明：这一页刚保存，还没被任何搜索请求同步过。');

    // 基线：直接读索引（等价于没有同步的问答语义路）——新页缺席
    const raw = await m.hybridSearch(dataDir, vault, { query: 'fresh-sync 增量同步新鲜度', limit: 5, embedding: EMB });
    expect(raw.hits.map((h) => h.path)).not.toContain('concepts/fresh-page.md');

    // 问答取数：同步后同一查询必须命中新页，且索引 status 覆盖它（与 /api/search 同一口径）
    const hits = await m.retrieveForQuery(vault, 'fresh-sync 增量同步新鲜度', undefined, { embedding: EMB, dataDir });
    const fresh = hits.find((h) => h.path === 'concepts/fresh-page.md');
    expect(fresh).toBeTruthy();
    expect(fresh!.source === 'semantic' || fresh!.source === 'both').toBe(true);
    expect(m.getIndexStatus(dataDir).indexedPages).toBeGreaterThan(before);
    m.closeIndexDb();
  });
});

describe('B/C · 只有语义路才付同步成本', () => {
  it('配了 embedding 的语义路会触发一次同步', async () => {
    const m = await loadFresh('noop');
    await m.retrieveForQuery(vault, '远程协作', undefined, { embedding: EMB, dataDir });
    expect(syncCalls).toBe(1);
    m.closeIndexDb();
  });

  it('FR-12 scopeFilter 走关键词路：不触发同步、也不触达 embedding 服务', async () => {
    const m = await loadFresh('noop');
    const hits = await m.retrieveForQuery(vault, '远程协作', { folder: 'concepts' }, { embedding: EMB, dataDir });
    expect(syncCalls).toBe(0);
    expect(hits.length).toBeGreaterThan(0);
    expect(hits.every((h) => h.source === 'keyword')).toBe(true);
    m.closeIndexDb();
  });

  it('未配置 embedding（老用户）：不触发同步，行为与改造前一致', async () => {
    const m = await loadFresh('noop');
    const hits = await m.retrieveForQuery(vault, '远程协作');
    expect(syncCalls).toBe(0);
    expect(hits.every((h) => h.source === 'keyword')).toBe(true);
    m.closeIndexDb();
  });
});

describe('D · 同步失败不阻断问答', () => {
  // 全量 gate 并行跑 141 个文件时，两次 vi.resetModules() + 动态 import 会超过默认 5s；
  // 本用例只验证「ensureIndexSynced 抛错仍能召回」，一次装载即可，另留 20s 兜底慢盘/CI 抖动。
  it('ensureIndexSynced 抛错时仍按现有索引召回语义命中，且不向调用方抛错', { timeout: 20_000 }, async () => {
    const m = await loadFresh('throw');
    await m.indexPage(dataDir, vault, 'concepts/remote-work.md', EMB);
    m.closeIndexDb();

    const hits = await m.retrieveForQuery(vault, 'telecommuting productivity', undefined, { embedding: EMB, dataDir });
    expect(hits.map((h) => h.path)).toContain('concepts/remote-work.md');
    m.closeIndexDb();
  });
});

// E 组源码守卫：行为用例直接调 retrieveForQuery，看不出「问答侧另建了一套同步」——
// 补充口径 2 禁止第二套同步/缓存，故把接线方式与实现位置一起锁住。
describe('E · 不另建第二套同步（补充口径 2）', () => {
  it('retrieveForQuery 复用 ../search/indexed-search.js 的 ensureIndexSynced', () => {
    const src = readFileSync(path.resolve(__dirname, '../src/workflows/query-workflow.ts'), 'utf8');
    expect(src).toContain("import { ensureIndexSynced } from '../search/indexed-search.js';");
    const helper = src.slice(src.indexOf('export async function retrieveForQuery'), src.indexOf('// query 工作流的工具集'));
    expect(helper).toContain('await ensureIndexSynced(dataDir, vault)');
  });

  it('helper 内没有第二套 mtime/节流/缓存实现', () => {
    const src = readFileSync(path.resolve(__dirname, '../src/workflows/query-workflow.ts'), 'utf8');
    const helper = src.slice(src.indexOf('export async function retrieveForQuery'), src.indexOf('// query 工作流的工具集'));
    for (const banned of ['mtime', 'lastSync', 'Date.parse', 'fs.stat', 'index_status']) {
      expect(helper).not.toContain(banned);
    }
  });

  it('同步失败被吞掉：helper 内 ensureIndexSynced 处于独立 try 且 hybridSearch 仍会执行', () => {
    const src = readFileSync(path.resolve(__dirname, '../src/workflows/query-workflow.ts'), 'utf8');
    const helper = src.slice(src.indexOf('export async function retrieveForQuery'), src.indexOf('// query 工作流的工具集'));
    const at = helper.indexOf('await ensureIndexSynced(dataDir, vault)');
    expect(at).toBeGreaterThan(-1);
    expect(helper.indexOf('await hybridSearch(', at)).toBeGreaterThan(at);
    expect(helper.slice(at, helper.indexOf('await hybridSearch(', at))).toContain('catch');
  });
});

afterEach(() => {
  vi.resetModules();
});
