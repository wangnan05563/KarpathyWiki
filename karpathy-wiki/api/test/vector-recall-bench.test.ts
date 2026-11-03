// T04069 验收门禁：万级 chunk 规模下向量路召回延迟 <100ms，且与暴力扫描 top-10 重合率 ≥90%。
// 与 search-p95.test.ts（关键词路 1000 chunk）同族——常驻回归门禁：
// 向量召回再次退化（缓存失效判据算错、每次查询回全表物化正文）即红。
// 造数纪律：全部合成向量（mulberry32 定种随机，逐次可复现），不调用任何 embedding 服务、
// 不占真实额度；库落 os.tmpdir() 随机目录，用后即焚。
// 档位：DIM=256 是常驻档（造数快）；1024 档贴近真实 embedding 维度，
// 由 WIKI_VECTOR_BENCH_1024=1 显式开启（造数与打分成本约 4 倍，本机实测数据在 T04069 回传里）。
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  getIndexDb,
  replacePageChunks,
  savePageVectors,
  vectorRecall,
  closeIndexDb,
  getVectorCacheStats,
} from '../src/search/sqlite-index.js';

const CHUNKS_PER_PAGE = 4;
const PAGES = 2600; // × 4 = 10400 条向量（「万级 chunk」口径）
const DIM = 256;
const MODEL = 'bench-model';
const TOP_K = 10; // 验收口径的重合率比较长度
const SAMPLES = 60;
const BENCH_TIMEOUT_MS = 300_000;

const createdDirs: string[] = [];
let dataDir = '';
/** 定种随机：同一份向量集每次跑都一致，延迟数字才可比 */
function mulberry32(seed: number): () => number {
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

/** 改造前实现的原样复刻（git 8b9f6eb 的 vectorRecall 函数体），作为延迟对照与重合率基准 */
function bruteForceRecall(dir: string, queryVec: Float32Array, limit: number, model?: string) {
  const d = getIndexDb(dir);
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
      return { pagePath: r.page_path, chunkIndex: r.chunk_index, similarity };
    })
    .sort((a, b) => b.similarity - a.similarity)
    .slice(0, limit);
}

function p(values: number[], q: number): number {
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.min(sorted.length - 1, Math.floor(sorted.length * q))];
}

function overlapRate(a: Array<{ pagePath: string; chunkIndex: number }>, b: Array<{ pagePath: string; chunkIndex: number }>): number {
  const keys = new Set(b.map((x) => `${x.pagePath}#${x.chunkIndex}`));
  const shared = a.slice(0, TOP_K).filter((x) => keys.has(`${x.pagePath}#${x.chunkIndex}`)).length;
  return shared / Math.min(TOP_K, a.length);
}

function seedCorpus(dir: string, dim: number, prefix: string): void {
  const rng = mulberry32(20261103);
  for (let i = 0; i < PAGES; i++) {
    const pagePath = `${prefix}/page-${i}.md`;
    replacePageChunks(
      dir,
      pagePath,
      Array.from({ length: CHUNKS_PER_PAGE }, (_, k) => ({
        content: `基准页 ${i} 第 ${k} 节：向量召回与索引缓存的性能对照语料。`,
        heading: `第 ${k} 节`,
      })),
    );
    savePageVectors(dir, pagePath, Array.from({ length: CHUNKS_PER_PAGE }, () => randomVec(rng, dim)), MODEL);
  }
}

/** 查询向量组：若干随机向量 + 一条与库中某向量完全同向的（应当排第一，防止缓存喂出无关结果） */
function queryVectors(dim: number): Float32Array[] {
  const rng = mulberry32(777);
  const list = Array.from({ length: 9 }, () => randomVec(rng, dim));
  const d = getIndexDb(dataDir);
  const first = d
    .prepare('SELECT vec FROM chunk_vecs WHERE dim = ? ORDER BY rowid LIMIT 1')
    .get(dim) as { vec: Buffer };
  list.push(new Float32Array(first.vec.buffer, first.vec.byteOffset, dim)); // 精确命中
  list.push(new Float32Array(dim)); // 全零查询（退化路径）
  return list;
}

/**
 * 一档性能门禁。
 * @param latencyGateMs 热查询 P95 的绝对上限；null 表示本档不断言绝对值（见调用处口径说明）
 */
async function runTier(dim: number, label: string, latencyGateMs = 100): Promise<void> {
  const queries = queryVectors(dim);
  const rssBefore = process.memoryUsage().rss;

  // 冷启动一次：建矩阵（含全量反序列化），随后都应是缓存命中
  const tCold = performance.now();
  vectorRecall(dataDir, queries[0], 20, MODEL);
  const cold = performance.now() - tCold;

  const warmLatencies: number[] = [];
  for (let round = 0; round < SAMPLES; round++) {
    const q = queries[round % queries.length];
    const t0 = performance.now();
    vectorRecall(dataDir, q, 20, MODEL);
    warmLatencies.push(performance.now() - t0);
  }

  // 对照：改造前的全表暴力扫描（同一库、同一进程、同样预热过的 OS 页缓存）
  const bruteLatencies: number[] = [];
  for (const q of queries) {
    const t0 = performance.now();
    bruteForceRecall(dataDir, q, 20, MODEL);
    bruteLatencies.push(performance.now() - t0);
  }

  const stats = getVectorCacheStats();
  const rssAfter = process.memoryUsage().rss;
  console.log(
    `[T04069/${label}] 向量 ${stats.vectors} 条 缓存 ${(stats.bytes / 1024 / 1024).toFixed(1)}MB RSS ${(rssAfter / 1024 / 1024).toFixed(0)}MB(前 ${(rssBefore / 1024 / 1024).toFixed(0)}MB)\n` +
      `  缓存路径 冷重建=${cold.toFixed(1)}ms 热查询 P50=${p(warmLatencies, 0.5).toFixed(1)}ms P95=${p(warmLatencies, 0.95).toFixed(1)}ms max=${Math.max(...warmLatencies).toFixed(1)}ms\n` +
      `  暴力扫描 P50=${p(bruteLatencies, 0.5).toFixed(1)}ms P95=${p(bruteLatencies, 0.95).toFixed(1)}ms（本次采样 ${bruteLatencies.length} 次）` +
      `  门禁 热查询 P95 <${latencyGateMs ?? '∞（本档只断言相对退化与正确性）'}ms`,
  );

  // 验收 1：万级 chunk 下向量路召回延迟 <100ms（默认档 = 256 维，按验收条款原值判定）
  if (latencyGateMs !== null) expect(p(warmLatencies, 0.95)).toBeLessThan(latencyGateMs);
  // 缓存真的在起作用（否则这条门禁就退化成「测暴力扫描够不够快」）
  expect(stats.bytes).toBeGreaterThan(0);
  expect(stats.hits).toBeGreaterThan(0);
  // 同一实现少做了两件事（不再全表反序列化 + 不再全表物化正文），不该更慢
  expect(p(bruteLatencies, 0.5)).toBeGreaterThanOrEqual(p(warmLatencies, 0.5) * 1.2);

  // 验收 2：与暴力扫描 top-10 重合率 ≥90%（精确算法，实测应为 100%）
  let minOverlap = 1;
  for (const q of queries) {
    const fast = vectorRecall(dataDir, q, TOP_K, MODEL);
    const slow = bruteForceRecall(dataDir, q, TOP_K, MODEL);
    minOverlap = Math.min(minOverlap, overlapRate(fast, slow));
    expect(overlapRate(fast, slow)).toBeGreaterThanOrEqual(0.9);
  }
  console.log(`  top-${TOP_K} 与暴力扫描重合率 min=${(minOverlap * 100).toFixed(1)}%（门槛 90%，采样 ${queries.length} 条查询）`);
  // 精确命中那条查询：与库中某向量同向，top-1 相似度必须≈1（防「缓存喂出无关结果」）
  const exact = vectorRecall(dataDir, queries[9], TOP_K, MODEL);
  expect(exact[0].similarity).toBeGreaterThan(0.999);
}

beforeAll(() => {
  dataDir = mkdtempSync(path.join(tmpdir(), 'wiki-bench-vector-'));
  createdDirs.push(dataDir);
  seedCorpus(dataDir, DIM, 'bench');
}, BENCH_TIMEOUT_MS);

afterAll(() => {
  closeIndexDb();
  for (const dir of createdDirs) {
    try {
      rmSync(dir, { recursive: true, force: true });
    } catch {
      /* 清理失败不影响结论 */
    }
  }
});

describe(`T04069 向量召回性能（${PAGES * CHUNKS_PER_PAGE} chunk × ${DIM} 维）`, () => {
  it(`造数落库 ${PAGES * CHUNKS_PER_PAGE} 条同模型向量`, () => {
    const rows = getIndexDb(dataDir)
      .prepare('SELECT COUNT(*) AS n FROM chunk_vecs WHERE model = ? AND dim = ?')
      .get(MODEL, DIM) as { n: number };
    expect(rows.n).toBe(PAGES * CHUNKS_PER_PAGE);
  });

  it('万级 chunk：缓存热查询 P95 <100ms，且 top-10 与暴力扫描重合率 ≥90%', async () => {
    await runTier(DIM, `dim${DIM}`);
  }, BENCH_TIMEOUT_MS);

  // 1024 维档（真实 embedding 量级）：造数与打分成本约 4 倍，按需显式开启；独立页面目录，不与 256 维档互相覆盖
  // 绝对上限这里放宽到 200ms 而不是照抄验收的 100ms：同一条查询在本机安静时 P95=72.8ms，
  // 与并发测试同时跑时 P95=130ms——绝对毫秒数随机器负载浮动，把它写死会让这条档变成「随机红」。
  // 200ms 仍能咬住真正的退化（关掉缓存时暴力扫描 P50≈933ms），验收条款的 100ms 由上面的默认档判定，
  // 本档的绝对值仍然打印出来，人工在安静机器上按验收口径复核。
  it.skipIf(!process.env.WIKI_VECTOR_BENCH_1024)('1024 维档：同口径复测', async () => {
    seedCorpus(dataDir, 1024, 'bench1024');
    await runTier(1024, 'dim1024', 200);
  }, BENCH_TIMEOUT_MS);
});
