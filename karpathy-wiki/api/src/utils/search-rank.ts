// T04560：搜索相关性加权与 snippet 锚点的单一来源。
//
// 背景：T04458 把中文取词收敛为 2-gram 后，`hits`（命中词项数）被高频 gram 稀释——
// 高频 gram（页面/知识/检索）与低频 gram 同权，长问句天然 hits 大，`sort by hits` 的相关性直觉失真。
// 两处检索路径（legacy searchPages / indexed searchPagesIndexed）各自打分会让排序分叉，
// 故本模块作为唯一打分与锚点实现，两路共用（对齐 T04458 的单一来源纪律，R5 已锁「两路同排序」）。
//
// 口径（用户 2026-11-12 裁决）：
//  - 相关性 = Σ 命中词权重；词权重 = IDF(词) × 词长权重。
//      * IDF 在「候选页集合」上计算（query-time IDF）：候选里越少见的词权重越高，
//        候选里几乎每页都有的高频虚词 gram 权重越低，从而抵消「长问句 gram 数量虚高」。
//      * 词长权重：拉丁词越长越具体（log2 缓增）；中文 2-gram 恒为 1。
//  - snippet 锚点取「命中词里最长的」（同长取权重/IDF 最高），而非词表首项——
//    中文问句的词表首项常是虚词后的首二字，区分度弱。
//  - `hits` 字段语义**不变**（命中词项数），仅用于展示口径调整（移动端不再显示原始数字）。

export interface TermStats {
  /** 词的 IDF（候选集上） */
  idf: Map<string, number>;
  /** 词权重 = IDF × 词长权重（打分实际使用） */
  weight: Map<string, number>;
}

const LATIN_ONLY_RE = /^[a-z0-9][a-z0-9_-]*$/;

/** 词长权重：拉丁词越长越具体（log2 缓增）；中文 2-gram 与短词恒为 1。 */
export function termLengthWeight(term: string): number {
  if (LATIN_ONLY_RE.test(term) && term.length > 2) {
    return 1 + Math.log2(term.length - 1);
  }
  return 1;
}

/**
 * 在候选页集合上计算 IDF 与词权重。
 * @param terms  取词结果（保序）
 * @param lowers 候选页的可检索小写文本（两路各自传入各自候选页，须为同一批页面才能保证同排序）
 */
export function computeTermStats(terms: string[], lowers: string[]): TermStats {
  const N = Math.max(1, lowers.length);
  const idf = new Map<string, number>();
  const weight = new Map<string, number>();
  for (const term of terms) {
    let df = 0;
    for (const lower of lowers) {
      if (lower.includes(term)) df++;
    }
    // 平滑 IDF：df 越小权重越大；df=N（每页都有）时仍 > 0，不把常见词直接压成 0 权重。
    const idfValue = Math.log(1 + N / (1 + df));
    idf.set(term, idfValue);
    weight.set(term, idfValue * termLengthWeight(term));
  }
  return { idf, weight };
}

/** 单页加权分（Σ 命中词权重）与命中词项数（hits 语义保持为「命中词项数」）。 */
export function scoreLower(lower: string, terms: string[], stats: TermStats): { score: number; hits: number } {
  let score = 0;
  let hits = 0;
  for (const term of terms) {
    if (lower.includes(term)) {
      hits++;
      score += stats.weight.get(term) ?? 0;
    }
  }
  return { score, hits };
}

/**
 * snippet 锚点：返回命中词里「最长」那个词在 lower 中的起始下标（同长取权重最高）；
 * 无任何命中返回 -1（调用方回退到 0 或首词）。
 */
export function pickAnchorIndex(lower: string, terms: string[], stats: TermStats): number {
  let bestIdx = -1;
  let bestLen = -1;
  let bestWeight = -1;
  for (const term of terms) {
    const idx = lower.indexOf(term);
    if (idx < 0) continue;
    const len = term.length;
    const w = stats.weight.get(term) ?? 0;
    if (len > bestLen || (len === bestLen && w > bestWeight)) {
      bestLen = len;
      bestWeight = w;
      bestIdx = idx;
    }
  }
  return bestIdx;
}
