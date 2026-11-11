// T04560：搜索相关性加权（IDF × 词长）与 snippet 锚点的单元锁。
// ------------------------------------------------------------------
// 缺陷本体：T04458 把中文取词收敛为 2-gram 后，两条检索路径都按 `hits`（命中词项数）排序。
// 2-gram 下这个词数由「查询有多长」决定，不由「页面有多相关」决定：
//   · 高频 gram（知识/页面/检索）与低频 gram 同权，堆得多就排前面；
//   · 一句 12 字的中文问题产出 ~10 个 gram，命中 5 个无关高频 gram 的页面会压过
//     只命中 1 个高区分度词的页面。
// 本文件钉三件事：
//   1) 词权重口径（IDF 在候选集上算、拉丁词长加权、中文 2-gram 恒 1）；
//   2) `hits` 语义不变（仍是命中词项数）——它是展示/断言口径，改语义会连带打穿 R8；
//   3) snippet 锚点取最长命中词（同长取权重高），而不是词表首项。
import { describe, it, expect } from 'vitest';
import path from 'node:path';
import fs from 'node:fs/promises';

import {
  computeTermStats,
  scoreLower,
  pickAnchorIndex,
  termLengthWeight,
} from '../src/utils/search-rank.js';

describe('A · 词长权重：拉丁词越长越具体，中文 2-gram 不加权', () => {
  it('T1 中文 2-gram 恒为 1；拉丁词按 log2 缓增；1–2 字母不加权', () => {
    expect(termLengthWeight('知识')).toBe(1);
    expect(termLengthWeight('ai')).toBe(1);
    // 长度 3 → 1 + log2(2) = 2；长度 9 → 1 + log2(8) = 4
    expect(termLengthWeight('rag')).toBeCloseTo(2, 10);
    expect(termLengthWeight('knowledge')).toBeCloseTo(4, 10);
    // 单调：按长度严格缓增（防止改成某种非单调映射）
    expect(termLengthWeight('knowledge')).toBeGreaterThan(termLengthWeight('term'));
    expect(termLengthWeight('term')).toBeGreaterThan(termLengthWeight('rag'));
  });

  it('T2 带连字符/下划线的标识符按拉丁词处理（取词模块会保留它们）', () => {
    expect(termLengthWeight('rate-limiter')).toBeCloseTo(1 + Math.log2(11), 10);
    // 以非字母数字开头（符号查询回退支的产物）不享受加权
    expect(termLengthWeight('_v')).toBe(1);
  });
});

describe('B · IDF 在候选集上计算：候选里越少见权重越高，且不把常见词压成 0', () => {
  it('T3 df 越小 idf 越大；df=N（每页都有）时 idf 仍为正数', () => {
    const lowers = ['知识库检索', '知识需要沉淀', '知识图谱渲染'];
    const stats = computeTermStats(['检索', '知识', '渲染'], lowers);
    // 检索/渲染 各只在 1 页出现，知识在 3 页出现
    expect(stats.idf.get('检索')!).toBeGreaterThan(stats.idf.get('知识')!);
    expect(stats.idf.get('渲染')).toBeCloseTo(stats.idf.get('检索')!, 10);
    expect(stats.idf.get('知识')!, 'df=N 也不许压成 0（否则整页得 0 分等于丢了相关性）').toBeGreaterThan(0);
  });

  it('T4 词权重 = IDF × 词长权重；空候选集不抛（N 取下限 1）', () => {
    const stats = computeTermStats(['knowledge', '知识'], ['knowledge 知识']);
    expect(stats.weight.get('knowledge')!).toBeCloseTo(stats.idf.get('knowledge')! * 4, 10);
    expect(stats.weight.get('知识')!).toBeCloseTo(stats.idf.get('知识')!, 10);
    expect(() => computeTermStats(['知识'], [])).not.toThrow();
  });

  it('T5 加权打分能翻转「命中词多者在前」：1 个长词 > 2 个高频 gram', () => {
    // 候选集只有两页：A 只命中 obsidian；B 命中知识 + 识库
    const terms = ['obsidian', '知识', '识库'];
    const A = '这里只有 obsidian 一词。';
    const B = '知识库的价值：知识沉淀。';
    const stats = computeTermStats(terms, [A.toLowerCase(), B.toLowerCase()]);
    const a = scoreLower(A.toLowerCase(), terms, stats);
    const b = scoreLower(B.toLowerCase(), terms, stats);

    expect(a.hits, 'hits 仍是命中词项数（1 个词）').toBe(1);
    expect(b.hits, 'hits 仍是命中词项数（2 个词）').toBe(2);
    expect(a.score, '按 hits 排序会让 B 在前；按加权分 A 必须在前').toBeGreaterThan(b.score);
  });
});

describe('C · snippet 锚点：最长命中词优先，同长取权重高者', () => {
  it('T6 同长度时权重高（IDF 大）的词胜出', () => {
    const terms = ['检索', '渲染'];
    // 检索在三页都出现（df=3，近乎虚词），渲染只在两页出现（df=2）
    const lowers = ['渲染方案 检索', '检索方案', '先讲检索再讲渲染'];
    const stats = computeTermStats(terms, lowers);
    expect(stats.weight.get('渲染')!).toBeGreaterThan(stats.weight.get('检索')!);
    const target = '先讲检索再讲渲染';
    expect(pickAnchorIndex(target, terms, stats), '渲染 权重更高，应锚在它上面').toBe(
      target.indexOf('渲染'),
    );
  });

  it('T7 不同长度时长词胜出（即使它在文末、且不是词表首项）', () => {
    const terms = ['ai', 'knowledge'];
    const lower = 'ai 只是前缀，后面才是 knowledge 的正文。'.toLowerCase();
    const stats = computeTermStats(terms, [lower]);
    expect(pickAnchorIndex(lower, terms, stats), '锚点取最长命中词，不是词表首项').toBe(
      lower.indexOf('knowledge'),
    );
  });

  it('T8 无任何命中返回 -1（调用方回退到 0，不许抛）', () => {
    const stats = computeTermStats(['知识'], ['无关内容']);
    expect(pickAnchorIndex('无关内容', ['知识'], stats)).toBe(-1);
  });
});

describe('D · 展示口径：移动端不再显示原始命中数（2-gram 下该数字与相关性不成正比）', () => {
  it('T9 MobileBrowse.vue 的命中徽标是固定文案「相关」，不再插值 h.hits', async () => {
    const file = path.resolve(__dirname, '../../frontend/src/components/mobile/MobileBrowse.vue');
    const src = await fs.readFile(file, 'utf8');
    expect(src, '徽标必须存在（防止顺手删掉整块）').toContain('mb-chip-hit');
    expect(src, '仍在展示命中数字').not.toMatch(/\{\{\s*h\.hits\s*\}\}/);
    expect(src, '固定文案应为「相关」').toMatch(/mb-chip-hit">\s*相关\s*</);
  });
});
