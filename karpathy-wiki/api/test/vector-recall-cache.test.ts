// T04069：向量召回改为「进程内向量矩阵缓存 + 只对 top-K 回表取正文」后的口径锁。
// 核心风险不是算得慢而是算得错——缓存最容易出的错是「库里的向量变了而内存矩阵还是旧的」。
// 因此本文件的重点不是相似度公式（那部分由 vector-recall-model-filter.test.ts 锁），而是：
//   1. 与改造前的暴力扫描逐条一致（含同分并列次序）；
//   2. 任何绕过本模块的裸 SQL 写向量（rebuildIndex 的裸 DELETE、补算/测试里的裸 UPDATE）
//      都必须被 vec_gen 代号发现并重建缓存；
//   3. 关掉缓存、超预算回退、脏 BLOB 三条退路的结果与缓存路径一致（不能出现「降级即换口径」）。
// 隔离纪律（NFR-3）：SQLite 库落 os.tmpdir() 随机目录，用后即焚。
import { describe, it, expect, afterEach } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  getIndexDb,
  replacePageChunks,
  savePageVectors,
  vectorRecall,
  closeIndexDb,
  getVectorCacheStats,
} from '../src/search/sqlite-index.js';

const createdDirs: string[] = [];

function freshDir(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'wiki-vec-cache-'));
  createdDirs.push(dir);
  return dir;
}

afterEach(() => {
  delete process.env.WIKI_VECTOR_CACHE;
  delete process.env.WIKI_VECTOR_CACHE_MAX_MB;
  closeIndexDb(); // 同时释放向量缓存（模块级单例，跨用例必须归零）
  for (const dir of createdDirs.splice(0)) {
    try {
      fs.rmSync(dir, { recursive: true, force: true });
    } catch {
      /* Windows 句柄释放延迟：临时目录残留不影响断言 */
    }
  }
});

type Hit = { pagePath: string; chunkIndex: number; content: string; heading: string | null; similarity: number };

/** 改造前实现的原样复刻（git 8b9f6eb 的 vectorRecall 函数体），只作对照口径存在。
 *  刻意不复用被测代码的任何部分：缓存若算错，这里能暴露而不是跟着错。 */
function bruteForceRecall(dataDir: string, queryVec: Float32Array, limit: number, model?: string): Hit[] {
  const d = getIndexDb(dataDir);
  const base = `
    SELECT c.page_path, c.chunk_index, c.content, c.heading, v.vec, v.dim
    FROM chunk_vecs v JOIN chunks c ON c.page_path = v.page_path AND c.chunk_index = v.chunk_index`;
  const rows = (
    model
      ? d.prepare(`${base} WHERE v.model = ?`).all(model)
      : d.prepare(base).all()
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

function seedPage(dataDir: string, pagePath: string, content: string, vectors: Float32Array[], model = 'm1'): void {
  replacePageChunks(
    dataDir,
    pagePath,
    vectors.map((_, i) => ({ content: `${content} 第${i}块`, heading: i === 0 ? '标题' : null })),
  );
  savePageVectors(dataDir, pagePath, vectors, model);
}

/** 只写向量行（不走 savePageVectors），用于造「长度与声明维度不符」的脏数据 */
function insertRawVectorRow(dataDir: string, pagePath: string, chunkIndex: number, bytes: Buffer, dim: number, model = 'm1'): void {
  getIndexDb(dataDir)
    .prepare('INSERT INTO chunk_vecs (page_path, chunk_index, vec, dim, model) VALUES (?, ?, ?, ?, ?)')
    .run(pagePath, chunkIndex, bytes, dim, model);
}

const Q = new Float32Array([1, 0, 0]);
const NEAR = new Float32Array([0.9, 0.1, 0]);
const MID = new Float32Array([0.5, 0.5, 0]);
const ORTHO = new Float32Array([0, 1, 0]);

describe('vectorRecall 缓存与暴力扫描等价（T04069）', () => {
  it('同分并列也逐条一致：命中集合、次序、相似度、正文全部相等', () => {
    const dataDir = freshDir();
    // 三条完全相同的向量（同分）+ 一条次优 + 一条正交（0 分）：并列次序最能暴露实现差异
    seedPage(dataDir, 'concepts/a.md', 'A', [Q, NEAR, MID]);
    seedPage(dataDir, 'concepts/b.md', 'B', [Q]);
    seedPage(dataDir, 'concepts/c.md', 'C', [Q]);
    seedPage(dataDir, 'concepts/d.md', 'D', [ORTHO]);

    const cached = vectorRecall(dataDir, Q, 10); // 首次调用建缓存
    expect(getVectorCacheStats().rebuilds).toBe(1);
    expect(vectorRecall(dataDir, Q, 10)).toEqual(cached); // 第二次走缓存，结果必须逐字段相同
    expect(bruteForceRecall(dataDir, Q, 10)).toEqual(cached);

    // top-K 截断同样一致（K 落在并列组内部时不能随机吞掉某条）
    for (const k of [1, 2, 3, 4, 5]) {
      expect(vectorRecall(dataDir, Q, k)).toEqual(bruteForceRecall(dataDir, Q, k));
    }
    // 与查询向量同向的三条排在前，正交那条相似度 0 但仍应出现（不足 K 条时零分也要返回）
    expect(cached.slice(0, 3).every((h) => h.similarity === 1)).toBe(true);
    expect(cached.at(-1)).toMatchObject({ pagePath: 'concepts/d.md', chunkIndex: 0, similarity: 0 });
  });

  it('正文取自 chunks 表且与暴力扫描同一条 chunk', () => {
    const dataDir = freshDir();
    seedPage(dataDir, 'concepts/a.md', '甲页', [MID, NEAR, Q]);
    const hits = vectorRecall(dataDir, Q, 3);
    expect(hits[0]).toMatchObject({ pagePath: 'concepts/a.md', chunkIndex: 2, content: '甲页 第2块', heading: null });
  });
});

describe('缓存失效以库内代号为唯一判据（T04069 核心风险）', () => {
  it('裸 UPDATE 改掉某页向量后，下一次召回必须反映新向量', () => {
    const dataDir = freshDir();
    seedPage(dataDir, 'concepts/old.md', '旧', [ORTHO]); // 与查询正交：排最后
    seedPage(dataDir, 'concepts/keep.md', '其它', [MID]);
    const before = vectorRecall(dataDir, Q, 10).map((h) => h.pagePath);
    expect(before[before.length - 1]).toBe('concepts/old.md');

    // 绕过 savePageVectors 的裸写（懒索引/修复脚本/测试都可能这么干）
    getIndexDb(dataDir)
      .prepare('UPDATE chunk_vecs SET vec = ? WHERE page_path = ?')
      .run(Buffer.from(new Float32Array([1, 0, 0]).buffer), 'concepts/old.md');

    const after = vectorRecall(dataDir, Q, 10);
    expect(after[0].pagePath).toBe('concepts/old.md');
    expect(after[0].similarity).toBeCloseTo(1, 6);
    expect(getVectorCacheStats().rebuilds).toBe(2); // 代号变了 → 重建一次
    expect(after).toEqual(bruteForceRecall(dataDir, Q, 10));
  });

  it('裸 DELETE 全表（rebuildIndex 的清空口径）后不得再用旧向量', () => {
    const dataDir = freshDir();
    seedPage(dataDir, 'concepts/a.md', 'A', [Q]);
    expect(vectorRecall(dataDir, Q, 10)).toHaveLength(1);

    getIndexDb(dataDir).exec('DELETE FROM chunk_vecs;');
    expect(vectorRecall(dataDir, Q, 10)).toEqual([]); // 缓存若没发现变更，这里会返回旧命中
  });

  it('补算中途新增的向量当轮可见（懒索引边写边查不能读到旧矩阵）', () => {
    const dataDir = freshDir();
    seedPage(dataDir, 'concepts/first.md', '先', [MID]);
    expect(vectorRecall(dataDir, Q, 10).map((h) => h.pagePath)).toEqual(['concepts/first.md']);

    seedPage(dataDir, 'concepts/later.md', '后', [Q]); // savePageVectors 也改了向量表
    const hits = vectorRecall(dataDir, Q, 10);
    expect(hits.map((h) => h.pagePath)).toEqual(['concepts/later.md', 'concepts/first.md']);
  });

  it('删除整页索引后该页向量退出召回', () => {
    const dataDir = freshDir();
    seedPage(dataDir, 'concepts/a.md', 'A', [Q]);
    seedPage(dataDir, 'concepts/b.md', 'B', [NEAR]);
    expect(vectorRecall(dataDir, Q, 10)).toHaveLength(2);
    getIndexDb(dataDir).exec("DELETE FROM chunk_vecs WHERE page_path = 'concepts/a.md';");
    expect(vectorRecall(dataDir, Q, 10).map((h) => h.pagePath)).toEqual(['concepts/b.md']);
  });

  it('空向量表也被缓存：第二次查询不再读库（重建计数仍为 1）', () => {
    const dataDir = freshDir();
    expect(vectorRecall(dataDir, Q, 10)).toEqual([]);
    expect(vectorRecall(dataDir, Q, 10)).toEqual([]);
    const stats = getVectorCacheStats();
    expect(stats.rebuilds).toBe(1);
    expect(stats.hits).toBe(1);
    expect(stats.bytes).toBe(0);
  });
});

describe('三条退路的结果口径与缓存路径一致（T04069）', () => {
  it('关掉缓存（WIKI_VECTOR_CACHE=0）走逐行扫：结果逐字段相同且不建缓存', () => {
    const dataDir = freshDir();
    seedPage(dataDir, 'concepts/a.md', 'A', [Q, MID]);
    seedPage(dataDir, 'concepts/b.md', 'B', [NEAR]);
    seedPage(dataDir, 'concepts/c.md', 'C', [ORTHO]);

    process.env.WIKI_VECTOR_CACHE = '0';
    const streamed = vectorRecall(dataDir, Q, 10);
    expect(getVectorCacheStats().matrices).toBe(0); // 关闭时一份矩阵都不建
    expect(getVectorCacheStats().rebuilds).toBe(0);

    delete process.env.WIKI_VECTOR_CACHE;
    const cached = vectorRecall(dataDir, Q, 10);
    expect(streamed).toEqual(cached);
    expect(streamed).toEqual(bruteForceRecall(dataDir, Q, 10));
    expect(getVectorCacheStats().matrices).toBe(1);
  });

  it('超出内存预算（WIKI_VECTOR_CACHE_MAX_MB=0）不缓存，但结果仍精确', () => {
    const dataDir = freshDir();
    seedPage(dataDir, 'concepts/a.md', 'A', [Q, MID]);
    seedPage(dataDir, 'concepts/b.md', 'B', [NEAR]);
    process.env.WIKI_VECTOR_CACHE_MAX_MB = '0';

    const first = vectorRecall(dataDir, Q, 10);
    const second = vectorRecall(dataDir, Q, 10);
    expect(first).toEqual(bruteForceRecall(dataDir, Q, 10));
    expect(second).toEqual(first);
    const stats = getVectorCacheStats();
    expect(stats.bytes).toBe(0);
    expect(stats.oversizeScans).toBe(2);
    expect(stats.rebuilds).toBe(0);
  });

  it('维度与查询向量不同的行不参与（与旧 dim 过滤同口径）', () => {
    const dataDir = freshDir();
    seedPage(dataDir, 'concepts/a.md', 'A', [new Float32Array([1, 0, 0, 0])], 'm1'); // 4 维
    expect(vectorRecall(dataDir, Q, 10)).toEqual([]); // 查询是 3 维
    expect(vectorRecall(dataDir, new Float32Array([1, 0, 0, 0]), 10).map((h) => h.pagePath)).toEqual(['concepts/a.md']);
  });

  it('脏 BLOB（长度短于声明维度）只丢该行，不再让整条语义路静默关闭', () => {
    // 旧实现 new Float32Array(buffer, offset, dim) 越界即抛 RangeError，
    // 被 hybridSearch 的 catch 吞成「语义路无结果」——一行坏数据关掉一路检索。
    const dataDir = freshDir();
    seedPage(dataDir, 'concepts/good.md', '好', [Q]);
    // 坏行要有对应 chunk 才能进入召回候选（与 chunks 表 JOIN 后才打分）
    replacePageChunks(dataDir, 'concepts/bad.md', [{ content: '坏', heading: null }]);
    insertRawVectorRow(dataDir, 'concepts/bad.md', 0, Buffer.alloc(8), 3); // 声明 3 维只给 8 字节
    const hits = vectorRecall(dataDir, Q, 10);
    expect(hits.map((h) => h.pagePath)).toEqual(['concepts/good.md']);
    // 对照：旧口径在这一行上直接抛 RangeError（并被 hybridSearch 的 catch 静默降级成「语义路无结果」）
    expect(() => bruteForceRecall(dataDir, Q, 10)).toThrow(RangeError);
  });
});

describe('模型口径在缓存下仍隔离（与 T04067 契约共存）', () => {
  it('两套模型各自缓存互不串用，且都与暴力扫描一致', () => {
    const dataDir = freshDir();
    seedPage(dataDir, 'concepts/m1.md', '模型1', [Q], 'm1');
    seedPage(dataDir, 'concepts/m2.md', '模型2', [NEAR], 'm2');
    seedPage(dataDir, 'concepts/m2b.md', '模型2次', [ORTHO], 'm2');

    const onlyM2 = vectorRecall(dataDir, Q, 10, 'm2');
    expect(onlyM2.map((h) => h.pagePath)).toEqual(['concepts/m2.md', 'concepts/m2b.md']);
    const all = vectorRecall(dataDir, Q, 10); // 不传 model：全量口径
    expect(all.map((h) => h.pagePath)).toEqual(['concepts/m1.md', 'concepts/m2.md', 'concepts/m2b.md']);
    expect(onlyM2).toEqual(bruteForceRecall(dataDir, Q, 10, 'm2'));
    expect(all).toEqual(bruteForceRecall(dataDir, Q, 10));
    expect(getVectorCacheStats().matrices).toBe(2); // 两份矩阵，各按 model 口径
  });

  it('零向量查询（范数为 0）与旧实现同样全部记 0 分并按行序取前 K', () => {
    const dataDir = freshDir();
    seedPage(dataDir, 'concepts/a.md', 'A', [Q, NEAR]);
    seedPage(dataDir, 'concepts/b.md', 'B', [MID]);
    const zero = new Float32Array([0, 0, 0]);
    expect(vectorRecall(dataDir, zero, 2)).toEqual(bruteForceRecall(dataDir, zero, 2));
  });
});

describe('缓存生命周期与建库 DDL（T04069）', () => {
  it('vec_gen 表与三个触发器随 getIndexDb 建出，重复建库不重复建对象', () => {
    const dataDir = freshDir();
    const objects = () =>
      getIndexDb(dataDir)
        .prepare("SELECT type, name FROM sqlite_master WHERE name LIKE 'vec_gen%' ORDER BY name")
        .all() as Array<{ type: string; name: string }>;
    expect(objects().map((o) => `${o.type}:${o.name}`)).toEqual([
      'table:vec_gen',
      'trigger:vec_gen_ad',
      'trigger:vec_gen_ai',
      'trigger:vec_gen_au',
    ]);
    replacePageChunks(dataDir, 'concepts/a.md', [{ content: '甲', heading: null }]); // 无向量：代号不该动
    expect(getIndexDb(dataDir).prepare('SELECT gen FROM vec_gen WHERE id = 1').get()).toBeUndefined();
    getIndexDb(dataDir); // 再次取连接：DDL 幂等
    expect(objects()).toHaveLength(4);
  });

  it('closeIndexDb 释放该进程的向量缓存（避免同名临时目录复用挂着旧矩阵）', () => {
    const dataDir = freshDir();
    seedPage(dataDir, 'concepts/a.md', 'A', [Q]);
    vectorRecall(dataDir, Q, 10);
    expect(getVectorCacheStats().matrices).toBe(1);
    closeIndexDb();
    expect(getVectorCacheStats().matrices).toBe(0);
    expect(getVectorCacheStats().bytes).toBe(0);
    // 重开同一目录后必须重建而不是命中旧缓存
    expect(vectorRecall(dataDir, Q, 10).map((h) => h.pagePath)).toEqual(['concepts/a.md']);
    expect(getVectorCacheStats().rebuilds).toBe(1);
  });
});

describe('向量取数不再物化全表正文（T04069 防退化守卫）', () => {
  const SRC = fs.readFileSync(path.resolve(__dirname, '../src/search/sqlite-index.ts'), 'utf8');

  it('向量扫描 SQL 只取定位键与向量，正文改由 top-K 回表', () => {
    const scan = SRC.match(/function vectorScanSql[\s\S]*?\n}/);
    expect(scan, 'vectorScanSql 不存在').not.toBeNull();
    const sql = scan![0];
    expect(sql).toContain('v.page_path AS page_path');
    expect(sql).toContain('v.vec AS vec');
    expect(sql).not.toMatch(/c\.(content|heading)/);
    // 行序钉死在 chunk_vecs 插入序：换计划就会换并列名次，结果不可复现
    expect(sql).toContain('CROSS JOIN');
    expect(sql).toContain('ORDER BY v.rowid');
  });

  it('回表取正文必须发生在 top-K 之后（否则又退化成全表物化）', () => {
    const recall = SRC.match(/function vectorRecall\([\s\S]*?\n}/);
    expect(recall, 'vectorRecall 不存在').not.toBeNull();
    const body = recall![0];
    expect(body).toContain('recallCandidates(');
    expect(body.indexOf('recallCandidates(')).toBeLessThan(body.indexOf('attachChunkContents('));
  });

  it('缓存失效判据只有库内代号一处，模块内不留第二套脏标记', () => {
    // 2026-11-05：覆盖统计缓存（getIndexWatermark）也来读同一个代号，消费者从 1 个变成 2 个。
    // 「调用次数 ≤2」会随正当消费者增加而误红，所以这里改盯真正的不变量——**读法只有一处**：
    // 除 readVecGen 自身那一行 SELECT，模块内不许再出现直接读 vec_gen 的 SQL（那才是第二套判据）。
    const genReads = SRC.match(/readVecGen\(/g) ?? [];
    expect(genReads.length, 'readVecGen 定义 + 至少一个调用点').toBeGreaterThanOrEqual(2);
    const directGenSql = (SRC.match(/SELECT\s+gen\s+FROM\s+vec_gen/gi) ?? []).length;
    expect(directGenSql, '代号只能经 readVecGen 读，别处再写一份 SELECT 就是第二套脏标记').toBe(1);
    expect(SRC).toMatch(/CREATE TRIGGER IF NOT EXISTS vec_gen_ad AFTER DELETE ON chunk_vecs/);
    expect(SRC).toMatch(/CREATE TRIGGER IF NOT EXISTS vec_gen_au AFTER UPDATE ON chunk_vecs/);
  });
});
