// T04186：批量补算期「边写边查」不再每次整目录重建向量矩阵。
// 库内代号（vec_gen）仍是唯一失效判据，增量只是「本进程记得住是谁改的」时重建的等价快路径。
// 因此本文件的断言依次是：
//   1. 等价性——增量结果与「整目录重建」「改造前暴力扫描」逐条一致（含同分并列次序）；
//   2. 退回口径——旁路裸 SQL、账本超限、内存预算超出三种情形必须退回重建/逐行扫，
//      宁可慢也不能把旧行留在矩阵里（多一行、少一行、重复一行都算召回错误）；
//   3. 收益——补算期查询总耗时相对「每轮整目录重建」显著下降，稳态热查询 P95 仍 <100ms。
// 隔离纪律（NFR-3）：库落 os.tmpdir() 随机目录，用后即焚；向量全部定种合成，不碰 embedding 服务。
import { describe, it, expect, afterEach } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  getIndexDb,
  replacePageChunks,
  savePageVectors,
  removePageIndex,
  vectorRecall,
  closeIndexDb,
  resetVectorCache,
  getVectorCacheStats,
} from '../src/search/sqlite-index.js';

const createdDirs: string[] = [];

function freshDir(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'wiki-vec-inc-'));
  createdDirs.push(dir);
  return dir;
}

afterEach(() => {
  delete process.env.WIKI_VECTOR_CACHE;
  delete process.env.WIKI_VECTOR_CACHE_MAX_MB;
  closeIndexDb(); // 同时释放向量缓存与写入记账（模块级单例，跨用例必须归零）
  for (const dir of createdDirs.splice(0)) {
    try {
      fs.rmSync(dir, { recursive: true, force: true });
    } catch {
      /* Windows 句柄释放延迟：临时目录残留不影响断言 */
    }
  }
});

type Hit = { pagePath: string; chunkIndex: number; content: string; heading: string | null; similarity: number };

/** 改造前实现的原样复刻（与 vector-recall-cache.test.ts 同一份口径）。
 *  刻意不复用被测代码：缓存若算错，这里能暴露而不是跟着错。 */
function bruteForceRecall(dataDir: string, queryVec: Float32Array, limit: number, model?: string): Hit[] {
  const d = getIndexDb(dataDir);
  const base = `
    SELECT c.page_path, c.chunk_index, c.content, c.heading, v.vec, v.dim
    FROM chunk_vecs v JOIN chunks c ON c.page_path = v.page_path AND c.chunk_index = v.chunk_index`;
  const rows = (
    model ? d.prepare(`${base} WHERE v.model = ?`).all(model) : d.prepare(base).all()
  ) as Array<{ page_path: string; chunk_index: number; content: string; heading: string | null; vec: Buffer; dim: number }>;
  if (rows.length === 0) return [];
  const dim = queryVec.length;
  return rows
    .filter((r) => r.dim === dim)
    .map((r) => {
      const v = new Float32Array(r.vec.buffer, r.vec.byteOffset, r.dim);
      let dot = 0;
      let nq = 0;
      let nv = 0;
      for (let i = 0; i < dim; i++) {
        dot += queryVec[i] * v[i];
        nq += queryVec[i] * queryVec[i];
        nv += v[i] * v[i];
      }
      const similarity = nq > 0 && nv > 0 ? dot / (Math.sqrt(nq) * Math.sqrt(nv)) : 0;
      return { pagePath: r.page_path, chunkIndex: r.chunk_index, content: r.content, heading: r.heading, similarity };
    })
    .sort((a, b) => b.similarity - a.similarity)
    .slice(0, limit);
}

/** 旧实现每轮的代价：清空缓存后查一次 = 整目录重建再打分（增量方案的等价性对照基准） */
function rebuiltRecall(dataDir: string, queryVec: Float32Array, limit: number, model?: string): Hit[] {
  resetVectorCache();
  return vectorRecall(dataDir, queryVec, limit, model);
}

/** 写入序列定种随机：同一份语料每次跑都一致，耗时数字才可比 */
function mulberry32(seed: number) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function randomVec(rng: () => number, dim: number): Float32Array {
  const v = new Float32Array(dim);
  for (let i = 0; i < dim; i++) v[i] = rng() * 2 - 1;
  return v;
}

function seedPage(dataDir: string, pagePath: string, vectors: Float32Array[], model = 'm1'): void {
  replacePageChunks(
    dataDir,
    pagePath,
    vectors.map((_, i) => ({ content: `${pagePath} 第${i}块`, heading: i === 0 ? '标题' : null })),
  );
  savePageVectors(dataDir, pagePath, vectors, model);
}

const keyOf = (h: Hit) => `${h.pagePath}#${h.chunkIndex}`;

function p(vals: number[], q: number): number {
  const s = [...vals].sort((a, b) => a - b);
  return s[Math.min(s.length - 1, Math.floor(s.length * q))];
}

const Q = new Float32Array([1, 0, 0]);
const NEAR = new Float32Array([0.9, 0.1, 0]);
const ORTHO = new Float32Array([0, 1, 0]);

describe('补算期增量与重建/暴力扫描逐条等价（T04186）', () => {
  it('边补算边查：每轮结果与暴力扫描一致，整个补算期矩阵只建过一次', () => {
    const dataDir = freshDir();
    const rng = mulberry32(20261104);
    for (let i = 0; i < 12; i++) seedPage(dataDir, `seed/page-${i}.md`, [randomVec(rng, 3), randomVec(rng, 3)]);

    vectorRecall(dataDir, Q, 10); // 首次：该付的全量重建
    expect(getVectorCacheStats().rebuilds).toBe(1);

    for (let i = 0; i < 10; i++) {
      seedPage(dataDir, `backfill/page-${i}.md`, [randomVec(rng, 3), randomVec(rng, 3)]);
      const got = vectorRecall(dataDir, Q, 10);
      expect(got, `第 ${i} 轮增量结果与暴力扫描不一致`).toEqual(bruteForceRecall(dataDir, Q, 10));
      // 重复行是最隐蔽的增量缺陷（同一行既在保留段又被追加一次）
      expect(new Set(got.map(keyOf)).size).toBe(got.length);
    }
    const stats = getVectorCacheStats();
    expect(stats.rebuilds).toBe(1); // 十轮补算没有再重建一次
    expect(stats.incrementalPages).toBe(10); // 十页改动确实由增量消化（否则这条门禁只是在比重建快慢）
    // 最终态与「此刻整目录重建」逐条一致
    expect(vectorRecall(dataDir, Q, 10)).toEqual(rebuiltRecall(dataDir, Q, 10));
  });

  it('整页重写（先删后插）不留下旧向量，也不产生重复行', () => {
    const dataDir = freshDir();
    seedPage(dataDir, 'a.md', [Q]);
    seedPage(dataDir, 'b.md', [NEAR]);
    expect(vectorRecall(dataDir, Q, 10).map((h) => h.pagePath)).toEqual(['a.md', 'b.md']);

    seedPage(dataDir, 'a.md', [ORTHO]); // 同一路径整页重算：0 分应当退到最后
    const after = vectorRecall(dataDir, Q, 10);
    expect(after.map((h) => h.pagePath)).toEqual(['b.md', 'a.md']);
    expect(after.at(-1)!.similarity).toBe(0);
    expect(new Set(after.map(keyOf)).size).toBe(after.length);
    expect(after).toEqual(bruteForceRecall(dataDir, Q, 10));
    expect(getVectorCacheStats().incrementalPages).toBe(1); // 一次重算 = 一个待同步页面（删+插合住一次增量）
    expect(after).toEqual(rebuiltRecall(dataDir, Q, 10)); // 对照会清缓存与计数，所以读数都在它之前

    seedPage(dataDir, 'a.md', [Q]); // 再改回去：连续改写同一页不能把上一版的行留成两份（rebuiltRecall 后缓存已热，这次仍走增量）
    const again = vectorRecall(dataDir, Q, 10);
    expect(again.filter((h) => h.pagePath === 'a.md')).toHaveLength(1);
    expect(getVectorCacheStats().incrementalPages).toBe(1);
    expect(again).toEqual(rebuiltRecall(dataDir, Q, 10));
  });

  it('交错重写多页后，同分并列次序仍等于按 rowid 全表重扫的次序', () => {
    // 三条完全相同的向量（全同分）：并列名次完全由行序决定，最能暴露增量与重建的次序差异。
    // 改写次序 a → b → a，最终 rowid：c < b(新) < a(新) → 期望 c, b, a
    const dataDir = freshDir();
    seedPage(dataDir, 'c.md', [Q]);
    seedPage(dataDir, 'b.md', [Q]);
    seedPage(dataDir, 'a.md', [Q]);
    expect(vectorRecall(dataDir, Q, 10).map((h) => h.pagePath)).toEqual(['c.md', 'b.md', 'a.md']);

    seedPage(dataDir, 'a.md', [Q]);
    vectorRecall(dataDir, Q, 10);
    seedPage(dataDir, 'b.md', [Q]);
    vectorRecall(dataDir, Q, 10);
    seedPage(dataDir, 'a.md', [Q]);
    const got = vectorRecall(dataDir, Q, 10);
    expect(got.map((h) => h.pagePath)).toEqual(['c.md', 'b.md', 'a.md']);
    expect(getVectorCacheStats().rebuilds).toBe(1); // 三条同分向量的次序差异，靠的全是增量没有重建
    expect(got).toEqual(rebuiltRecall(dataDir, Q, 10));
    expect(got).toEqual(bruteForceRecall(dataDir, Q, 10));
  });

  it('删除整页索引后该页向量退出召回（增量路径同样摘得干净）', () => {
    const dataDir = freshDir();
    seedPage(dataDir, 'a.md', [Q]);
    seedPage(dataDir, 'b.md', [NEAR]);
    vectorRecall(dataDir, Q, 10);

    removePageIndex(dataDir, 'a.md');
    const got = vectorRecall(dataDir, Q, 10);
    expect(got.map((h) => h.pagePath)).toEqual(['b.md']);
    const stats = getVectorCacheStats();
    expect(stats.rebuilds).toBe(1); // 摘除该页没有付出重建
    expect(stats.incrementalPages).toBe(1);
    expect(got).toEqual(rebuiltRecall(dataDir, Q, 10));
  });

  it('旁路裸 SQL 混在本进程写入之间：账对不上就退回整目录重建', () => {
    const dataDir = freshDir();
    seedPage(dataDir, 'keep.md', [NEAR]);
    vectorRecall(dataDir, Q, 10);
    const rebuildsBefore = getVectorCacheStats().rebuilds;

    seedPage(dataDir, 'mine.md', [ORTHO]); // 本进程写的：记在账上
    getIndexDb(dataDir) // 旁路裸写：代号多推一格，账里没有
      .prepare('UPDATE chunk_vecs SET vec = ? WHERE page_path = ?')
      .run(Buffer.from(new Float32Array([1, 0, 0]).buffer), 'keep.md');

    const got = vectorRecall(dataDir, Q, 10);
    const stats = getVectorCacheStats();
    expect(stats.rebuilds).toBe(rebuildsBefore + 1); // 增量被放弃，付了一次全量重建
    expect(stats.incrementalPages).toBe(0);
    expect(got[0].pagePath).toBe('keep.md'); // 裸改的向量必须生效（旧矩阵留着就是读到过期数据）
    expect(got).toEqual(bruteForceRecall(dataDir, Q, 10));
  });

  it('补算批量超过账本上限：放弃增量，退回整目录重建且结果仍正确', () => {
    const dataDir = freshDir();
    const rng = mulberry32(4242);
    seedPage(dataDir, 'seed/0.md', [randomVec(rng, 3)]);
    vectorRecall(dataDir, Q, 10);
    expect(getVectorCacheStats().rebuilds).toBe(1);

    // 一次补 401 页且中间不查询：账本已满，继续攒增量没有意义（下一次查询按老口径重建）
    for (let i = 0; i < 401; i++) seedPage(dataDir, `bulk/page-${i}.md`, [randomVec(rng, 3)]);
    const got = vectorRecall(dataDir, Q, 10);
    const stats = getVectorCacheStats();
    expect(stats.rebuilds).toBe(2);
    expect(stats.incrementalPages).toBe(0);
    expect(got).toEqual(bruteForceRecall(dataDir, Q, 10));

    // 重建之后账本重新开张：后续补算继续吃增量的收益
    seedPage(dataDir, 'bulk/after.md', [randomVec(rng, 3)]);
    expect(vectorRecall(dataDir, Q, 10)).toEqual(bruteForceRecall(dataDir, Q, 10));
    expect(getVectorCacheStats().rebuilds).toBe(2);
    expect(getVectorCacheStats().incrementalPages).toBe(1);
  });

  it('模型隔离在增量路径同样成立：补算进来的行只进自己那套模型的矩阵', () => {
    // 两套模型 = 两个不可比的向量空间（T04067 口径）。增量把所有待同步页面一次性摊到目录下的
    // 每一份矩阵上，靠的是按 key 的 model/dim 过滤——过滤写错就会串空间，分数看着更高但语义是错的。
    const dataDir = freshDir();
    seedPage(dataDir, 'a.md', [NEAR], 'm1');
    seedPage(dataDir, 'b.md', [Q], 'm2');
    vectorRecall(dataDir, Q, 10, 'm1');
    vectorRecall(dataDir, Q, 10, 'm2'); // 两份矩阵都建好，之后的补算只能走增量
    expect(getVectorCacheStats().rebuilds).toBe(2);

    seedPage(dataDir, 'c.md', [ORTHO], 'm1');
    seedPage(dataDir, 'd.md', [Q], 'm2');
    const m1 = vectorRecall(dataDir, Q, 10, 'm1');
    expect(m1.map((h) => h.pagePath)).toEqual(['a.md', 'c.md']); // d.md 属另一套模型，不得混进来
    expect(m1).toEqual(bruteForceRecall(dataDir, Q, 10, 'm1'));
    const m2 = vectorRecall(dataDir, Q, 10, 'm2');
    expect(m2.map((h) => h.pagePath)).toEqual(['b.md', 'd.md']);
    expect(m2).toEqual(bruteForceRecall(dataDir, Q, 10, 'm2'));
    expect(getVectorCacheStats().rebuilds).toBe(2); // 两份矩阵都靠增量更新，没有退回重建
  });

  it('增量不得突破内存预算：超出即退回逐行扫，结果仍与暴力扫描一致', () => {
    // 预算 1MB；每条 256 维向量的缓存占用 = 256×4+8+4 = 1044 字节。
    // 先建 600 条（626KB）→ 再补 452 条（合计 1052 条 ≈ 1.10MB）：增量后必然超预算，
    // 此时必须放弃增量、退回原有的「超预算不缓存」退路，而不是让矩阵悄悄长过上限。
    const dataDir = freshDir();
    const rng = mulberry32(9001);
    const seedVecs = () => [randomVec(rng, 256), randomVec(rng, 256), randomVec(rng, 256), randomVec(rng, 256)];
    for (let i = 0; i < 150; i++) seedPage(dataDir, `base/page-${i}.md`, seedVecs());
    process.env.WIKI_VECTOR_CACHE_MAX_MB = '1';

    const query = randomVec(rng, 256);
    const warm = vectorRecall(dataDir, query, 10);
    const built = getVectorCacheStats();
    expect(built.rebuilds).toBe(1); // 600 条 626KB，仍在预算内
    expect(built.bytes).toBeGreaterThan(0);

    for (let i = 0; i < 113; i++) seedPage(dataDir, `grow/page-${i}.md`, seedVecs()); // +452 条
    const got = vectorRecall(dataDir, query, 10);
    const stats = getVectorCacheStats();
    expect(stats.bytes).toBeLessThanOrEqual(stats.budgetBytes); // 上限守住了
    expect(stats.oversizeScans).toBeGreaterThan(0); // 走的是逐行扫退路
    expect(stats.incrementalPages).toBe(0); // 增量被判定做不了，没有硬塞
    expect(got).toEqual(bruteForceRecall(dataDir, query, 10));
  });
});

describe('补算期查询耗时（T04186 验收条款）', () => {
  it('每写一页查一次：增量总耗时低于「每轮整目录重建」一倍以上，稳态热查询 P95 <100ms', () => {
    const dataDir = freshDir();
    const rng = mulberry32(20260101);
    const seedVecs = () => [randomVec(rng, 128), randomVec(rng, 128), randomVec(rng, 128), randomVec(rng, 128)];
    for (let i = 0; i < 800; i++) seedPage(dataDir, `base/page-${i}.md`, seedVecs()); // 3200 条向量
    const query = randomVec(rng, 128);
    const ROUNDS = 30;

    // 腿 A = 改造前的口径：每轮写入后清掉缓存再查，每一次查询都要付整目录重建
    resetVectorCache();
    vectorRecall(dataDir, query, 20); // 预热：两条腿都不把「本来的第一次全量」算进对照
    const rebuildMs: number[] = [];
    for (let i = 0; i < ROUNDS; i++) {
      seedPage(dataDir, `rebuild/page-${i}.md`, seedVecs());
      resetVectorCache();
      const t = performance.now();
      vectorRecall(dataDir, query, 20);
      rebuildMs.push(performance.now() - t);
    }

    // 腿 B = 增量：起始库比腿 A 多 30 页，每轮同样要对全库打分，
    // 省掉的只有「反序列化整库建矩阵」这一项——差异只来自增量，不来自少干活
    const rebuildsBefore = getVectorCacheStats().rebuilds;
    const incrementalMs: number[] = [];
    for (let i = 0; i < ROUNDS; i++) {
      seedPage(dataDir, `incr/page-${i}.md`, seedVecs());
      const t = performance.now();
      vectorRecall(dataDir, query, 20);
      incrementalMs.push(performance.now() - t);
    }
    const stats = getVectorCacheStats();
    expect(stats.rebuilds - rebuildsBefore).toBe(0); // 补算期一次都没重建
    expect(stats.incrementalPages).toBe(ROUNDS); // 三十页改动全部由增量消化

    const totalA = rebuildMs.reduce((a, b) => a + b, 0);
    const totalB = incrementalMs.reduce((a, b) => a + b, 0);
    console.log(
      `[T04186] 补算期 3200+ 条向量、每轮「写一页 + 查一次」（limit=20）：\n` +
        `  整目录重建 P50=${p(rebuildMs, 0.5).toFixed(1)}ms P95=${p(rebuildMs, 0.95).toFixed(1)}ms 合计=${totalA.toFixed(1)}ms\n` +
        `  增量同步   P50=${p(incrementalMs, 0.5).toFixed(1)}ms P95=${p(incrementalMs, 0.95).toFixed(1)}ms 合计=${totalB.toFixed(1)}ms` +
        `  省 ${(((totalA - totalB) / totalA) * 100).toFixed(1)}%\n`,
    );
    expect(totalB * 2).toBeLessThan(totalA); // 门禁只要求快一倍；本机实测约一个数量级
    expect(p(incrementalMs, 0.95)).toBeLessThan(100);

    // 稳态（补算结束、不再写入）：热查询 P95 仍按 T04069 的 100ms 口径判定
    const hotMs: number[] = [];
    for (let i = 0; i < 30; i++) {
      const t = performance.now();
      vectorRecall(dataDir, query, 20);
      hotMs.push(performance.now() - t);
    }
    expect(getVectorCacheStats().hits).toBeGreaterThanOrEqual(30);
    expect(p(hotMs, 0.95)).toBeLessThan(100);
    expect(vectorRecall(dataDir, query, 20)).toEqual(bruteForceRecall(dataDir, query, 20));
  }, 180_000);
});
