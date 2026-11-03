// T04182 索引写入链的 status 口径回归锁（派生自 T04073「向量覆盖 N/M 页」的取证现场）。
// ------------------------------------------------------------------
// 缺陷形态：replacePageChunks() 先 DELETE FROM chunk_vecs 把该页向量删干净，再 upsert index_status，
// 而 ON CONFLICT 分支只写 `attempts = 0, updated_at = excluded.updated_at`——**不重置 status**。
// 于是「重切后从未重算」的页面继续挂着上一轮的 'indexed'：
//   · 设置页「向量覆盖 4/6 页」比真实有向量的 3 页更乐观；
//   · 同一时刻 staleModelPages（按 chunk_vecs 实际有无判定）又把这些页算进「待补」，
//     coveredPages + staleModelPages > totalPages，两个口径互相打脸。
// 本文件锁四层：
//   A) 状态机口径：切分即待补，向量真写进去（savePageVectors）才算覆盖；
//   B) 覆盖统计：coveredPages 与「chunk_vecs 里真有向量的在库页数」同源，与 staleModelPages 可加；
//   C) 不留空洞：重切页必须仍在懒索引清单里，且 updated_at 前移（否则 O1 增量同步会跳过它）；
//   D) 正常写入链不被误伤：带 embedding 的 indexPage/rebuildIndex 最终仍回到 indexed。
// 隔离纪律（NFR-3）：vault/dataDir 全部落在 os.tmpdir() 随机目录；embedding 走本机 stub HTTP 服务，
// 不读真实 key、不消耗任何外部额度。
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import {
  closeIndexDb,
  getIndexDb,
  getIndexStatus,
  listIndexedPageTimes,
  listPageIndexStates,
  listPendingPages,
  listStaleModelPages,
  markIndexFailed,
  removePageIndex,
  replacePageChunks,
  savePageVectors,
} from '../src/search/sqlite-index.js';
import {
  getIndexCoverage,
  indexPage,
  listVaultPages,
  rebuildIndex,
  type EmbeddingConfig,
} from '../src/search/hybrid-search.js';
import type { VaultService } from '../src/vault/vault-service.js';

const MODEL = 'stub-embed';

/** 只读页面目录的最小 vault（覆盖统计只需要 getVaultPath；readFile 供 indexPage 用） */
function stubVault(vaultPath: string): VaultService {
  return {
    getVaultPath: () => vaultPath,
    readFile: (rel: string) => import('node:fs/promises').then((m) => m.readFile(path.join(vaultPath, rel), 'utf8')),
  } as unknown as VaultService;
}

function chunk(text: string): Array<{ content: string; heading: string | null }> {
  return [{ content: text, heading: null }];
}

/** 4 维单位向量：数值本身不参与本单断言，只要「有没有向量」 */
function fakeVec(seed: number): Float32Array {
  const v = new Float32Array(4);
  v[seed % 4] = 1;
  return v;
}

function stateOf(dataDir: string, pagePath: string): { status: string; attempts: number } | undefined {
  return listPageIndexStates(dataDir).get(pagePath);
}

function vecRows(dataDir: string, pagePath: string): number {
  return (
    getIndexDb(dataDir)
      .prepare('SELECT COUNT(*) AS n FROM chunk_vecs WHERE page_path = ?')
      .get(pagePath) as { n: number }
  ).n;
}

function chunkRows(dataDir: string, pagePath: string): number {
  return (
    getIndexDb(dataDir)
      .prepare('SELECT COUNT(*) AS n FROM chunks WHERE page_path = ?')
      .get(pagePath) as { n: number }
  ).n;
}

/** 真值口径：在库页面里「chunk_vecs 确实有行」的页数（本单要求 coveredPages 与它一致）。
 *  页面清单复用 listVaultPages，即覆盖统计分母的同一来源（PAGE_DIRS 单一口径，T02472 约定）。 */
async function pagesWithVectorsInVault(dataDir: string, vaultPath: string): Promise<number> {
  const inVault = new Set(await listVaultPages(stubVault(vaultPath)));
  const rows = getIndexDb(dataDir)
    .prepare('SELECT DISTINCT page_path FROM chunk_vecs')
    .all() as Array<{ page_path: string }>;
  return rows.filter((r) => inVault.has(r.page_path)).length;
}

// ────────────────────────── A/B/C：纯索引层 + 覆盖统计 ──────────────────────────

describe('T04182 重切分必须把 status 退回 pending', () => {
  let dataDir = '';
  const createdDirs: string[] = [];

  beforeEach(() => {
    dataDir = mkdtempSync(path.join(tmpdir(), 'wiki-rechunk-status-'));
    createdDirs.push(dataDir);
  });

  afterEach(() => {
    closeIndexDb();
  });

  afterAll(() => {
    for (const dir of createdDirs) {
      try {
        rmSync(dir, { recursive: true, force: true });
      } catch {
        /* 清理失败不影响结论 */
      }
    }
  });

  it('已 indexed 的页面重新切分：向量清空的同时 status 归 pending、attempts 归零', () => {
    const p = 'concepts/a.md';
    replacePageChunks(dataDir, p, chunk('第一版正文'));
    savePageVectors(dataDir, p, [fakeVec(1)], MODEL);
    expect(stateOf(dataDir, p)?.status).toBe('indexed');

    replacePageChunks(dataDir, p, chunk('第二版正文'));
    // 改动前这里仍是 'indexed'，而 chunk_vecs 已经是 0 行——本断言即本单的回归锁
    expect(stateOf(dataDir, p), '切分后向量已删，status 却仍记 indexed').toEqual({ status: 'pending', attempts: 0 });
    expect(vecRows(dataDir, p)).toBe(0);
    expect(chunkRows(dataDir, p)).toBe(1);
  });

  it('补算失败计数（attempts）不阻碍重切：重切后 attempts=0 且仍为 pending', () => {
    const p = 'concepts/b.md';
    replacePageChunks(dataDir, p, chunk('正文'));
    savePageVectors(dataDir, p, [fakeVec(2)], MODEL);
    markIndexFailed(dataDir, p); // 有向量时只累计次数，不改 status
    expect(stateOf(dataDir, p)).toEqual({ status: 'indexed', attempts: 1 });
    markIndexFailed(dataDir, p);
    markIndexFailed(dataDir, p); // 第 3 次：按既有口径翻回 pending
    expect(stateOf(dataDir, p)).toEqual({ status: 'pending', attempts: 3 });

    replacePageChunks(dataDir, p, chunk('重写后的正文'));
    expect(stateOf(dataDir, p), '重切应重置重试预算').toEqual({ status: 'pending', attempts: 0 });
  });

  it('removePageIndex 后再切分：新建行走 pending 分支，coveredPages 不增长', () => {
    // 本单正文建议的字面复现路径。变异探针 M1 实测：这条只锁 INSERT 分支（索引行已被删干净，
    // upsert 走 INSERT 而非 ON CONFLICT），所以它对「冲突分支不重置 status」这个真实缺陷不敏感——
    // 缺陷的字面复现由上一条（原地重切）与覆盖统计组锁住，两条都要留：一个管新建，一个管重写。
    const a = 'concepts/a.md';
    const b = 'concepts/b.md';
    for (const [i, p] of [a, b].entries()) {
      replacePageChunks(dataDir, p, chunk('正文'));
      savePageVectors(dataDir, p, [fakeVec(i)], MODEL);
    }
    expect(getIndexStatus(dataDir).indexedPages).toBe(2);

    removePageIndex(dataDir, a); // 页面删除：三张表一起清，属「未索引」
    expect(stateOf(dataDir, a)).toBeUndefined();
    expect(getIndexStatus(dataDir).indexedPages).toBe(1);

    replacePageChunks(dataDir, a, chunk('正文')); // 重新切分（关键词路可用，向量待补）
    const status = getIndexStatus(dataDir);
    expect(status.indexedPages, '重切被算成已索引 → 覆盖率虚高').toBe(1);
    expect(status.pendingPages).toBe(1);
    expect(stateOf(dataDir, a)).toEqual({ status: 'pending', attempts: 0 });
  });

  it('重切页仍被懒索引清单捞回：不留「永久 pending 之外」的死角', () => {
    const p = 'concepts/a.md';
    replacePageChunks(dataDir, p, chunk('正文'));
    savePageVectors(dataDir, p, [fakeVec(1)], MODEL);
    replacePageChunks(dataDir, p, chunk('正文 改'));

    expect(listPendingPages(dataDir), '重切页未进待补清单 → 永远不会重算').toContain(p);
    expect(listStaleModelPages(dataDir, MODEL), '重切页未进模型过期清单').toContain(p);
  });

  it('updated_at 随重切前移：O1 增量同步不会把它当「已是最新」跳过', () => {
    const p = 'concepts/a.md';
    replacePageChunks(dataDir, p, chunk('正文'));
    // 人为把索引时间回拨到 2020：真实场景就是「上一轮留下的索引行」。
    // 不用 sleep 等毫秒走针（T02836 禁用例自带等待原语，回拨比等更确定）。
    getIndexDb(dataDir)
      .prepare(`UPDATE index_status SET updated_at = '2020-01-01T00:00:00.000Z' WHERE page_path = ?`)
      .run(p);
    expect(listIndexedPageTimes(dataDir).get(p)).toBe(Date.parse('2020-01-01T00:00:00.000Z'));

    const notBefore = Date.now() - 1000;
    replacePageChunks(dataDir, p, chunk('正文 改'));
    const after = listIndexedPageTimes(dataDir).get(p) ?? 0;
    expect(
      after,
      '重切未写 updated_at → 增量同步按旧时间判定「已是最新」，改版页面永远不再入索引',
    ).toBeGreaterThanOrEqual(notBefore);
  });

  it('多块页面重切：status 只有一份、chunk 行数按新版走', () => {
    const p = 'concepts/multi.md';
    replacePageChunks(dataDir, p, [
      { content: '块一', heading: 'H1' },
      { content: '块二', heading: null },
      { content: '块三', heading: null },
    ]);
    savePageVectors(dataDir, p, [fakeVec(1), fakeVec(2), fakeVec(3)], MODEL);
    expect(vecRows(dataDir, p)).toBe(3);

    replacePageChunks(dataDir, p, [
      { content: '块一 改', heading: 'H1' },
      { content: '块二 改', heading: null },
    ]);
    expect(vecRows(dataDir, p)).toBe(0);
    expect(chunkRows(dataDir, p)).toBe(2);
    expect(stateOf(dataDir, p)?.status).toBe('pending');
  });
});

// ────────────────────────── B：覆盖统计口径（设置页数据来源） ──────────────────────────

describe('T04182 向量覆盖统计与真值一致', () => {
  let tempRoot = '';
  let vaultPath = '';
  let dataDir = '';

  beforeEach(async () => {
    tempRoot = mkdtempSync(path.join(tmpdir(), 'wiki-rechunk-cov-'));
    vaultPath = path.join(tempRoot, 'vault');
    dataDir = path.join(tempRoot, 'data');
    mkdirSync(path.join(vaultPath, 'concepts'), { recursive: true });
    for (const name of ['a.md', 'b.md', 'c.md']) {
      writeFileSync(path.join(vaultPath, 'concepts', name), `# ${name}\n正文 ${name}\n`, 'utf8');
    }
  });

  afterEach(() => {
    closeIndexDb();
    rmSync(tempRoot, { recursive: true, force: true });
  });

  /** 三页全部「切分 + 有向量」：初始覆盖 3/3 */
  function seedIndexed(): void {
    ['a', 'b', 'c'].forEach((n, i) => {
      const p = `concepts/${n}.md`;
      replacePageChunks(dataDir, p, chunk(`正文 ${p}`));
      savePageVectors(dataDir, p, [fakeVec(i)], MODEL);
    });
  }

  it('重切一页后 coveredPages 从 3 归位到 2，且与「真有向量的在库页数」相等', async () => {
    seedIndexed();
    const before = await getIndexCoverage(dataDir, stubVault(vaultPath), MODEL);
    expect(before.totalPages).toBe(3);
    expect(before.coveredPages).toBe(3);
    expect(before.pendingPages).toBe(0);

    replacePageChunks(dataDir, 'concepts/b.md', chunk('正文 concepts/b.md 改'));
    const after = await getIndexCoverage(dataDir, stubVault(vaultPath), MODEL);
    expect(after.coveredPages, '向量已删的页仍计入覆盖').toBe(2);
    expect(after.pendingPages).toBe(1);
    expect(after.coveredPages).toBe(await pagesWithVectorsInVault(dataDir, vaultPath));

    // 改动前的现场即此处报数：covered=3 而真值=2
    expect(after.coveredPages, '覆盖率与真值脱钩').not.toBe(3);
  });

  it('coveredPages 与 staleModelPages 两个口径可加（不再互相矛盾）', async () => {
    seedIndexed();
    replacePageChunks(dataDir, 'concepts/a.md', chunk('正文 concepts/a.md 改'));
    replacePageChunks(dataDir, 'concepts/c.md', chunk('正文 concepts/c.md 改'));

    const cov = await getIndexCoverage(dataDir, stubVault(vaultPath), MODEL);
    // 改动前：covered=3（虚高）+ stale=2 → 5 > totalPages=3，两个口径各说各话
    expect(cov.coveredPages + cov.staleModelPages!, '覆盖数与待补数加起来超过总页数：口径冲突').toBe(cov.totalPages);
    expect(cov.coveredPages).toBe(1);
    expect(cov.staleModelPages).toBe(2);
  });

  it('向量补回后 coveredPages 复位：pending 是中间态而非死态', async () => {
    seedIndexed();
    replacePageChunks(dataDir, 'concepts/a.md', chunk('正文 concepts/a.md 改'));
    const dip = await getIndexCoverage(dataDir, stubVault(vaultPath), MODEL);
    expect(dip.coveredPages).toBe(2);

    savePageVectors(dataDir, 'concepts/a.md', [fakeVec(7)], MODEL);
    const back = await getIndexCoverage(dataDir, stubVault(vaultPath), MODEL);
    expect(back.coveredPages).toBe(3);
    expect(back.pendingPages).toBe(0);
    expect(back.coveredPages).toBe(await pagesWithVectorsInVault(dataDir, vaultPath));
  });

  it(' getIndexStatus 与 getIndexCoverage 同向：旧口径也不再虚报重切页', async () => {
    seedIndexed();
    replacePageChunks(dataDir, 'concepts/b.md', chunk('正文 concepts/b.md 改'));
    const legacy = getIndexStatus(dataDir);
    const cov = await getIndexCoverage(dataDir, stubVault(vaultPath), MODEL);
    expect(legacy.indexedPages).toBe(cov.coveredPages);
    expect(legacy.pendingPages).toBe(cov.pendingPages);
  });
});

// ────────────────────────── D：正常写入链（stub embedding，零外部额度） ──────────────────────────

describe('T04182 带 embedding 的索引链最终仍回到 indexed', () => {
  let server: http.Server;
  const EMB: EmbeddingConfig = { baseUrl: '', apiKey: 'test-key', model: MODEL };
  let tempRoot = '';
  let vaultPath = '';
  let dataDir = '';
  const createdDirs: string[] = [];

  beforeAll(async () => {
    server = http.createServer((req, res) => {
      let raw = '';
      req.on('data', (c) => (raw += c));
      req.on('end', () => {
        const body = JSON.parse(raw || '{}') as { input?: string[] };
        const data = (body.input ?? []).map((text, index) => {
          const v = new Array(4).fill(0);
          v[index % 4] = 1;
          v[(text.length + index) % 4] = 1;
          return { index, embedding: v };
        });
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
        /* 清理失败不影响结论 */
      }
    }
  });

  beforeEach(() => {
    tempRoot = mkdtempSync(path.join(tmpdir(), 'wiki-rechunk-e2e-'));
    createdDirs.push(tempRoot);
    vaultPath = path.join(tempRoot, 'vault');
    dataDir = path.join(tempRoot, 'data');
    mkdirSync(path.join(vaultPath, 'concepts'), { recursive: true });
  });

  afterEach(() => {
    closeIndexDb();
  });

  function writePage(rel: string, body: string): void {
    writeFileSync(path.join(vaultPath, rel), body, 'utf8');
  }

  it('indexPage 带 key：切分产生的 pending 由 savePageVectors 收回 indexed', async () => {
    writePage('concepts/a.md', '# 甲\n远程协作 与 图谱渲染\n');
    await indexPage(dataDir, stubVault(vaultPath), 'concepts/a.md', EMB);
    expect(stateOf(dataDir, 'concepts/a.md')?.status).toBe('indexed');
    expect(vecRows(dataDir, 'concepts/a.md')).toBe(chunkRows(dataDir, 'concepts/a.md'));

    // 改版后重新索引：中间态 pending 之后仍是 indexed，本单改动不影响正常链
    writePage('concepts/a.md', '# 甲\n远程协作 与 图谱渲染 改版\n');
    await indexPage(dataDir, stubVault(vaultPath), 'concepts/a.md', EMB);
    expect(stateOf(dataDir, 'concepts/a.md')?.status).toBe('indexed');
  });

  it('indexPage 无 key：只有关键词路，覆盖统计如实记 pending', async () => {
    writePage('concepts/b.md', '# 乙\n待补页正文\n');
    await indexPage(dataDir, stubVault(vaultPath), 'concepts/b.md', undefined);
    expect(stateOf(dataDir, 'concepts/b.md')).toEqual({ status: 'pending', attempts: 0 });
    const cov = await getIndexCoverage(dataDir, stubVault(vaultPath), MODEL);
    expect(cov.coveredPages).toBe(0);
    expect(cov.pendingPages).toBe(1);
    expect(cov.totalPages).toBe(1);
  });

  it('rebuildIndex：改版页面重建后覆盖页数等于在库页数（含二次重建）', async () => {
    writePage('concepts/a.md', '# 甲\nalpha beta gamma\n');
    writePage('concepts/b.md', '# 乙\nbeta gamma delta\n');
    const first = await rebuildIndex(dataDir, stubVault(vaultPath), EMB);
    expect(first.indexedPages).toBe(2);

    // 外部改文后重建：走的是「先删旧再写新」的同一条 upsert，若 status 不重置则会残留 indexed
    writePage('concepts/a.md', '# 甲\nalpha beta gamma delta epsilon\n');
    writePage('concepts/b.md', '# 乙\nbeta gamma delta epsilon zeta\n');
    const second = await rebuildIndex(dataDir, stubVault(vaultPath), EMB);
    expect(second.indexedPages).toBe(2);
    const cov = await getIndexCoverage(dataDir, stubVault(vaultPath), MODEL);
    expect(cov.coveredPages).toBe(cov.totalPages);
    expect(cov.coveredPages).toBe(await pagesWithVectorsInVault(dataDir, vaultPath));
  });
});

// ────────────────────────── 字面守卫（编译器之外的那半条链） ──────────────────────────

describe('T04182 写入链字面守卫', () => {
  const src = readFileSync(path.resolve(__dirname, '../src/search/sqlite-index.ts'), 'utf8');

  /** 取 replacePageChunks 函数体切片：避免整份文件 toContain 被另一处同形 upsert 蒙过去。
   *  注释先行剥离——本单的解释性注释里就带着 'indexed' 字样，不剥会把守卫读成红。 */
  function body(fnName: string): string {
    const start = src.indexOf(`export function ${fnName}(`);
    expect(start, `${fnName} 已不在 sqlite-index.ts 中`).toBeGreaterThanOrEqual(0);
    const end = src.indexOf('\n}', start);
    expect(end, `${fnName} 函数体边界未找到`).toBeGreaterThan(start);
    return src
      .slice(start, end)
      .replace(/\/\*[\s\S]*?\*\//g, '')
      .split(/\r?\n/)
      .filter((line) => !line.trim().startsWith('//'))
      .join('\n');
  }

  it('切分即待补：replacePageChunks 的 upsert 冲突分支必须重置 status', () => {
    const rechunk = body('replacePageChunks');
    expect(rechunk).toMatch(/DELETE FROM chunk_vecs WHERE page_path/);
    expect(rechunk, '冲突分支不再重置 status → 重切页挂着上一轮的 indexed').toMatch(
      /ON CONFLICT\(page_path\) DO UPDATE SET status = 'pending'/,
    );
  });

  it('收回 indexed 的唯一入口仍是向量落库（savePageVectors），切分侧不得反向写 indexed', () => {
    expect(body('savePageVectors')).toMatch(/SET status = 'indexed'/);
    expect(body('replacePageChunks'), '切分处写 indexed 等于绕过向量校验').not.toMatch(/'indexed'/);
  });
});
