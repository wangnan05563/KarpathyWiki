// T04176：把「一句自然语言问题」变成「检索可用的关键词集合」。
//
// 为什么需要：searchPages 的口径是「按空白切词 + 逐词 includes 匹配」。英文问题切出来的是单词，
// 中文问题切完只剩**整句**（中文没有空格），于是「知识库的价值体现在哪里」这种问法要求页面正文
// 逐字包含整句才算命中——真实页面几乎不可能，降级检索必然 0 命中。问答降级链第 2 级直接把整句
// 问题当关键词传进来（queryWithSearchFallback），于是中文问题一律落到兜底文案。
//
// 分词口径与 data-clean/dedup-engine.ts 的 tokenize 保持一致：拉丁词 + 中文 2-gram。
// 为什么不在这里复用那个私有函数：它入参要先 normalizeContent（剥 frontmatter/链接）并返回
// Set 供 Jaccard 相似度用，语义是「页面指纹」；这里要的是「查询词表」，且需要保序与截断。
export interface ExtractKeywordsOptions {
  // 词表上限：每个词都要在全库正文做一次 includes，词数直接决定扫描耗时（O3 并发也救不了 CPU）
  maxTerms?: number;
  // 拉丁词最短长度：单字母（如公式里的 x）噪声大，默认 2
  minLatinLength?: number;
}

// 中文问句里的高频虚词/疑问词用字：含这些字的 2-gram 几乎每页都有，参与打分只会稀释相关性。
// 只收录「语法/疑问」字，不收「一/不/大/中」这类也可能是内容字的，避免把主题词整刀切掉。
const CJK_STOP_CHARS = new Set([
  '的', '了', '是', '在', '和', '与', '或', '就', '都', '而', '为', '么', '怎', '样',
  '哪', '如', '何', '吗', '呢', '吧', '这', '那', '其', '之', '以', '及', '从', '对',
  '把', '被', '请', '能', '可', '有', '没', '要', '会', '我', '你', '他', '她', '它',
]);

const LATIN_WORD_RE = /[a-z0-9][a-z0-9_-]*/g;
// 中文范围与库内其它中文分词点一致（dedup-engine / tags 校验都用 \u4e00-\u9fa5）
const CJK_RUN_RE = /[一-龥]+/g;

/**
 * 从自然语言文本抽取检索关键词，返回 searchPages 可直接使用的空格分隔词串。
 * 抽不出任何词时返回空串——由调用方决定回退策略（不要在这里回退整句，
 * 整句作为单一词项正是本函数要修的缺陷）。
 */
export function extractSearchKeywords(text: string, options: ExtractKeywordsOptions = {}): string {
  const maxTerms = options.maxTerms ?? 24;
  const minLatinLength = options.minLatinLength ?? 2;
  const lower = text.toLowerCase();

  const terms: string[] = [];
  const seen = new Set<string>();
  const push = (term: string): void => {
    if (term.length > 0 && !seen.has(term)) {
      seen.add(term);
      terms.push(term);
    }
  };

  // 1) 拉丁/数字词优先：区分度高于 2-gram，且 searchPages 的 snippet 锚点取第一个词
  for (const word of lower.match(LATIN_WORD_RE) ?? []) {
    if (word.length >= minLatinLength) push(word);
  }

  // 2) 中文按连续串生成 2-gram（跨串不拼接，避免「……问题。答案……」造出假词）
  const cjkGrams: string[] = [];
  const allGrams: string[] = [];
  for (const run of lower.match(CJK_RUN_RE) ?? []) {
    if (run.length === 1) continue;
    for (let i = 0; i + 1 < run.length; i++) {
      const gram = run.slice(i, i + 2);
      allGrams.push(gram);
      if (!CJK_STOP_CHARS.has(gram[0]) && !CJK_STOP_CHARS.has(gram[1])) cjkGrams.push(gram);
    }
  }
  // 去虚词后有内容词就用它们；整句都是虚词（如「这是啥」）时退回全部 2-gram，
  // 保证退化路径仍有召回，而不是返回空串让调用方误判「问题无需检索」
  for (const gram of cjkGrams.length > 0 ? cjkGrams : allGrams) push(gram);

  return terms.slice(0, maxTerms).join(' ');
}
