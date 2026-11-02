// T04067：向量召回必须按 embedding 模型隔离。
// 缺陷：vectorRecall 只按 dim 过滤，模型切换后若新旧模型同维度，旧模型向量仍参与余弦打分
// （不同语义空间的分数混排，排序失真且用户无感）。
import { describe, it, expect, afterEach } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  getIndexDb,
  replacePageChunks,
  savePageVectors,
  vectorRecall,
  listStaleModelPages,
  closeIndexDb,
} from '../src/search/sqlite-index.js';

const createdDirs: string[] = [];

function freshDir(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'wiki-vec-model-'));
  createdDirs.push(dir);
  return dir;
}

afterEach(() => {
  closeIndexDb();
  for (const dir of createdDirs.splice(0)) {
    try {
      fs.rmSync(dir, { recursive: true, force: true });
    } catch {
      /* Windows 句柄释放延迟：临时目录残留不影响断言 */
    }
  }
});

/** 写一页：chunk + 指定模型的向量（v 与 chunk 一一对应） */
function seedPage(dataDir: string, pagePath: string, content: string, vectors: Float32Array[], model: string): void {
  replacePageChunks(dataDir, pagePath, [{ content, heading: null }]);
  savePageVectors(dataDir, pagePath, vectors, model);
}

describe('vectorRecall 按 model 隔离召回（T04067）', () => {
  it('同维度不同模型的旧向量不参与指定模型的召回', () => {
    const dataDir = freshDir();
    // 旧模型 m1 的向量与查询向量「更像」——若不按 model 过滤，它会错误地排在新模型结果前面
    seedPage(dataDir, 'concepts/old.md', '旧模型页面', [new Float32Array([1, 0, 0])], 'm1');
    seedPage(dataDir, 'concepts/new.md', '新模型页面', [new Float32Array([0.9, 0.1, 0])], 'm2');

    const hits = vectorRecall(dataDir, new Float32Array([1, 0, 0]), 10, 'm2');
    expect(hits.map((h) => h.pagePath)).toEqual(['concepts/new.md']);
  });

  it('两模型同维度时 dim 过滤无法区分（缺陷成立的前提条件）', () => {
    const dataDir = freshDir();
    seedPage(dataDir, 'concepts/old.md', '旧模型页面', [new Float32Array([1, 0, 0])], 'm1');
    seedPage(dataDir, 'concepts/new.md', '新模型页面', [new Float32Array([0, 1, 0])], 'm2');

    const dims = new Set(
      getIndexDb(dataDir)
        .prepare('SELECT dim FROM chunk_vecs')
        .all()
        .map((r) => (r as { dim: number }).dim),
    );
    expect(dims).toEqual(new Set([3])); // 同维度 → 旧实现会把两页都召回
    // 按 m2 过滤后只剩新模型页（即使它与查询向量正交、相似度为 0），旧模型页不得出现在结果里
    expect(vectorRecall(dataDir, new Float32Array([1, 0, 0]), 10, 'm2').map((h) => h.pagePath)).toEqual(['concepts/new.md']);
    expect(vectorRecall(dataDir, new Float32Array([1, 0, 0]), 10).map((h) => h.pagePath)).toEqual(['concepts/old.md', 'concepts/new.md']);
  });

  it('不传 model 时保持全量召回（旧调用口径不被静默改变）', () => {
    const dataDir = freshDir();
    seedPage(dataDir, 'concepts/old.md', '旧模型页面', [new Float32Array([1, 0, 0])], 'm1');
    seedPage(dataDir, 'concepts/new.md', '新模型页面', [new Float32Array([0.9, 0.1, 0])], 'm2');

    const hits = vectorRecall(dataDir, new Float32Array([1, 0, 0]), 10);
    expect(hits.map((h) => h.pagePath)).toEqual(['concepts/old.md', 'concepts/new.md']);
  });

  it('model 过滤后按相似度降序返回且不超过 limit', () => {
    const dataDir = freshDir();
    seedPage(dataDir, 'concepts/c1.md', '一', [new Float32Array([0.6, 0.4, 0])], 'm2');
    seedPage(dataDir, 'concepts/c2.md', '二', [new Float32Array([0.98, 0.02, 0])], 'm2');
    seedPage(dataDir, 'concepts/c3.md', '三', [new Float32Array([1, 0, 0])], 'm2');

    const hits = vectorRecall(dataDir, new Float32Array([1, 0, 0]), 2, 'm2');
    expect(hits.map((h) => h.pagePath)).toEqual(['concepts/c3.md', 'concepts/c2.md']);
  });
});

describe('模型切换后的旧向量进入待补清单（T04067）', () => {
  it('列出与当前模型不一致的页面，供懒索引补算', () => {
    const dataDir = freshDir();
    seedPage(dataDir, 'concepts/old.md', '旧模型页面', [new Float32Array([1, 0, 0])], 'm1');
    seedPage(dataDir, 'concepts/new.md', '新模型页面', [new Float32Array([0, 1, 0])], 'm2');

    expect(listStaleModelPages(dataDir, 'm2')).toEqual(['concepts/old.md']);
  });

  it('有 chunk 但从未算过向量的页面也算待补', () => {
    const dataDir = freshDir();
    replacePageChunks(dataDir, 'concepts/novec.md', [{ content: '尚未向量化', heading: null }]);

    expect(listStaleModelPages(dataDir, 'm2')).toEqual(['concepts/novec.md']);
  });

  it('补算中途被打断（同页部分分块仍是旧模型）也要列入待补', () => {
    const dataDir = freshDir();
    replacePageChunks(dataDir, 'concepts/partial.md', [
      { content: '一分块', heading: null },
      { content: '二分块', heading: null },
    ]);
    // 模拟懒索引只补算了第一个分块：第二个分块仍记在旧模型名下
    savePageVectors(dataDir, 'concepts/partial.md', [new Float32Array([0, 1, 0]), new Float32Array([1, 1, 0])], 'm2');
    getIndexDb(dataDir)
      .prepare(`UPDATE chunk_vecs SET model = 'm1' WHERE page_path = ? AND chunk_index = 1`)
      .run('concepts/partial.md');

    expect(listStaleModelPages(dataDir, 'm2')).toEqual(['concepts/partial.md']);
    // 该页仍有可用分块，但按模型过滤后旧模型分块不得参与打分
    const hits = vectorRecall(dataDir, new Float32Array([1, 0, 0]), 10, 'm2');
    expect(hits.map((h) => h.chunkIndex)).toEqual([0]);
  });
});

describe('生产调用点必须把当前模型传进召回（T04067 源码守卫）', () => {
  const SRC = fs.readFileSync(path.resolve(__dirname, '../src/search/hybrid-search.ts'), 'utf8');

  it('hybridSearch 的向量召回带上 embedding.model', () => {
    const callSites = SRC.match(/vectorRecall\(/g) ?? [];
    expect(callSites.length).toBeGreaterThan(0);
    expect(SRC).toMatch(/vectorRecall\(\s*dataDir,\s*qv,\s*\d+,\s*embedding\.model\s*\)/);
  });

  it('懒索引工作清单并入「模型不一致」页面（否则旧向量永不被补算）', () => {
    expect(SRC).toContain('listStaleModelPages(');
  });
});
