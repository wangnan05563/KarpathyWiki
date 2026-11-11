import fs from 'node:fs/promises';
import path from 'node:path';
// T04503：整页解析走收敛层。直连 matter() 时 gray-matter 的内容缓存会把坏页「吃进去」——
// 同一串字节第一次读抛异常、之后每次「解析成功」并返回空 data，于是坏页在第一轮进 badPageSink 记账、
// 在第二轮变成「过滤不匹配」静默消失。收敛层显式带 options，绕开缓存，判定只由字节决定。
import { parsePage } from './utils/frontmatter.js';
import type { VaultService } from './vault/vault-service.js';
// T02686：检索侧页面目录取 page-scope 单一来源
import { PAGE_DIRS } from './vault/page-scope.js';
import { DEFAULT_SCAN_CONCURRENCY, mapWithConcurrency } from './utils/async-pool.js';
// T04458（裁决：必须共用取词）：与索引路径、召回层共用同一份取词，不再各自按空白切词
import { toSearchTerms } from './utils/query-keywords.js';
// T04560：相关性与 snippet 锚点的单一来源（与索引路径共用，避免两路排序分叉）
import { computeTermStats, scoreLower, pickAnchorIndex, type TermStats } from './utils/search-rank.js';

// 全文检索命中结果
export interface SearchHit {
  path: string;
  title: string;
  snippet: string;
  // 命中关键词数。T04560 起**不再**用作排序主键（保留展示/断言口径）：
  // 2-gram 取词下长问句天然命中项多，按它排序等于奖励「词多」而不是「词准」。
  hits: number;
  // T04560：加权相关性分（Σ 命中词权重 = IDF × 词长权重），排序主键。
  // 纯范围限定（无关键词）的列出分支没有相关性概念，记 0。
  score: number;
}

export interface SearchFilter {
  // 按 frontmatter.source 过滤（如 "qq-chat", "web", "manual"）
  source?: string;
  // 按 frontmatter.status 过滤（如 "draft", "published"）
  status?: string;
  // FR-15-3：按 frontmatter.type 过滤（entity/concept/comparison/query/qa/solution）
  type?: string;
  // FR-12 scopeFilter：按目录/tag 限定检索范围
  // 为什么放 SearchFilter 而非新参数：searchPages 已有多维过滤，scope 是过滤的一种维度
  folder?: string;
  tags?: string[];
}

// T04455：过滤维度的唯一枚举源。
// 起因：外层「空关键词就提前返回」的判据曾自写一份维度清单（source/status/type），
// 而真正执行过滤的 matchSearchFilter 认五维——两处各写一遍就漂了。只传 tags 的范围限定
// （AI 伙伴的 scopeFilter 正是这个形态，query-workflow.ts:85）配上被纯符号提问切空的关键词，
// 外层直接 return []，tags 过滤根本没机会执行：用户看到「没有结果」，真实原因是提前返回。
// folder 同理（它压根不在旧清单里，且旧「纯过滤」识别依赖 frontmatter 的 content==='' 约定，
// 不过 frontmatter 的维度永远进不了那一支）。
type FilterDimension = 'source' | 'status' | 'type' | 'folder' | 'tags';
/** 需要读 frontmatter 才能判定的维度（folder 只看路径，不必为它打开 YAML） */
const FRONTMATTER_DIMENSIONS: FilterDimension[] = ['source', 'status', 'type', 'tags'];

/** 调用方实际给出了哪些维度（空串/undefined 不算给出；`tags: []` 算给出但见下方语义分工） */
function presentDimensions(filter?: SearchFilter): FilterDimension[] {
  const dims: FilterDimension[] = [];
  if (filter?.source) dims.push('source');
  if (filter?.status) dims.push('status');
  if (filter?.type) dims.push('type');
  if (filter?.folder) dims.push('folder');
  // 用 truthy 而非 length：空数组仍是「配置里带了 tags 这个字段」，
  // 关键词检索要照旧走 frontmatter 正文口径（下面 needsFrontmatter），但不构成范围缩小（narrowsToScope）。
  if (filter?.tags) dims.push('tags');
  return dims;
}

/** 这次检索是否需要读每页的 YAML 头 */
export function needsFrontmatter(filter?: SearchFilter): boolean {
  return presentDimensions(filter).some((d) => FRONTMATTER_DIMENSIONS.includes(d));
}

/**
 * 这些维度是否真的把范围缩小了——决定「空关键词时能不能列出页面」。
 * `tags: []`（未配置标签的伙伴）不缩小任何东西：让它通过就等于把整库倒给调用方。
 */
export function narrowsToScope(filter?: SearchFilter): boolean {
  return presentDimensions(filter).some((d) => (d === 'tags' ? (filter?.tags?.length ?? 0) > 0 : true));
}

// 错误信息压成一行：日志走 JSON.stringify，多行原文会把它撑成一条不可读的长串
function firstLine(err: unknown): string {
  const msg = err instanceof Error ? err.message : String(err);
  return msg.split('\n')[0].slice(0, 160);
}

// 检查页面是否匹配搜索过滤器（frontmatter 过滤）
function matchSearchFilter(
  content: string,
  filter?: SearchFilter,
): { matched: boolean; content?: string } {
  if (!needsFrontmatter(filter)) return { matched: true };
  // 故意用严格版 parsePage：坏 YAML 照样抛，让 processSearchFile 外层 catch 把它记进 badPageSink。
  // 这里不能换成 tryParsePage + 「当空元信息继续」——那正是本单要修的「坏页静默不匹配」。
  const parsed = parsePage(content);
  const fm = parsed.data;
  if (filter?.source && fm.source !== filter.source) return { matched: false };
  if (filter?.status && fm.status !== filter.status) return { matched: false };
  if (filter?.type && String(fm.type ?? '').toLowerCase() !== filter.type.toLowerCase()) return { matched: false };
  if (filter?.tags && filter.tags.length > 0) {
    const pageTags: string[] = Array.isArray(fm.tags) ? fm.tags : [];
    if (!pageTags.some((t) => filter.tags!.includes(t))) return { matched: false };
  }
  // T04455：这里不再判「纯过滤模式」。原先靠 `content: ''` 哨兵把信号传给 processSearchFile，
  // 于是「有没有关键词」这件事在两处各表达一遍（还漏掉了不过 frontmatter 的 folder 维度）。
  // 现在只有一个判定点：processSearchFile 直接按 terms.length 决定走列出还是走匹配。
  return { matched: true, content: parsed.content };
}

// T04560：命中页的中间形态。打分需要「候选页集合」上的 IDF，而 IDF 只有在全库扫完之后才知道
// ⇒ 逐页阶段只收集文本，打分/排序统一挪到扫描结束后一次完成（两路共用同一套算法）。
interface ScannedPage {
  path: string;
  title: string;
  /** 参与 snippet 的原文（不是 lower——大小写要按原文展示） */
  searchContent: string;
  /** 参与匹配与打分的 lower 文本 */
  lower: string;
}

type ScanOutcome =
  | { kind: 'listed'; hit: SearchHit }
  | { kind: 'matched'; page: ScannedPage };

// snippet：锚点取「最长命中词」（T04560），而不是词表首项。
// 中文问句的词表首项常是虚词后的首二字（知识/价值里先出现谁全看语序），区分度弱，
// 于是命中页的摘要经常落在一句无关的过渡句上。锚点返回 -1 时（理论不可达：调用前已保证命中）回退 0。
function buildSnippet(searchContent: string, lower: string, terms: string[], stats: TermStats): string {
  const anchor = pickAnchorIndex(lower, terms, stats);
  const start = Math.max(0, (anchor >= 0 ? anchor : 0) - 30);
  return searchContent.slice(start, start + 120).replaceAll('\n', ' ');
}

// 处理单个页面文件：读取内容、过滤、匹配关键词，返回待打分页或（无关键词时）直接可用的列出项
// T04176：badPageSink 收集「frontmatter 解析失败」的页面。为什么必须就地吞掉而不是让它冒出去：
// gray-matter 对坏 YAML 是抛异常（未闭合 flow collection / 重复键 / 值里裸冒号），而带 source、
// status、type、tags 任一过滤条件时每个页面都会过一次整页解析。mapWithConcurrency 的约定是
// 「任意一项失败由调用方在 fn 内处理」，此前没人处理——于是全库里只要有一页 frontmatter 写坏，
// 整次扫描连坐 reject，问答降级链两级同时失败，用户看到的是「知识库未覆盖此问题」，
// 真实原因却是「有一页 YAML 头坏了」。坏页跳过（无法证明它属于过滤范围），其余页面照常召回。
async function processSearchFile(
  vault: VaultService,
  rel: string,
  d: string,
  f: string,
  terms: string[],
  filter?: SearchFilter,
  badPageSink?: Array<{ path: string; reason: string }>,
): Promise<ScanOutcome | null> {
  if (!f.endsWith('.md')) return null;
  let content: string;
  try {
    content = await vault.readFile(rel);
  } catch {
    return null;
  }
  if (filter?.folder && !rel.startsWith(filter.folder + '/')) return null;

  let filterResult: { matched: boolean; content?: string };
  try {
    filterResult = matchSearchFilter(content, filter);
  } catch (err) {
    badPageSink?.push({ path: rel, reason: firstLine(err) });
    return null;
  }
  if (!filterResult.matched) return null;

  // 纯范围限定模式（无关键词）：把限定范围内的页面列出来，而不是按关键词打分。
  // T04455：判据从「matchSearchFilter 有没有回 content:'' 哨兵」改成直接看 terms——
  // 唯一判定点，且不过 frontmatter 的 folder 维度也能走进这一支。
  if (terms.length === 0) {
    const title = f.slice(0, -3);
    const snippet = content.slice(0, 120).replaceAll('\n', ' ');
    return { kind: 'listed', hit: { path: rel, title, snippet, hits: 1, score: 0 } };
  }

  const searchContent = filterResult.content || content;
  const lower = searchContent.toLowerCase();
  // 相关性全 0 命中在这里就丢掉（省一次全库 IDF 之后的打分开销）：
  // 命中判据与打分的「是否命中」必须同源，故用同一个 includes 语义（scoreLower 内部亦然）。
  if (!terms.some((t) => lower.includes(t))) return null;

  return {
    kind: 'matched',
    page: { path: rel, title: f.slice(0, -3), searchContent, lower },
  };
}

// 简单全文搜索：扫描所有页面目录，按关键词匹配标题与正文。
// 垂直切片阶段用最朴素的 includes 匹配，后续可替换为倒排索引或向量化检索。
// query-workflow.ts 的 searchPages 工具与 /api/search 路由共用此实现（DRY）。
// filter 参数支持按 frontmatter source/status 字段过滤（AC-10）。
export async function searchPages(
  vault: VaultService,
  keywords: string,
  limit = 20,
  filter?: SearchFilter,
): Promise<SearchHit[]> {
  const pageDirs = PAGE_DIRS;
  const terms = toSearchTerms(keywords);
  // T04455：与 matchSearchFilter 共用 narrowsToScope（同一份维度枚举）。
  // 原先这里自写了一遍 `filter?.source || filter?.status || filter?.type`，漏掉 tags 与 folder——
  // 只传 tags 的范围限定 + 空关键词于是被提前 return []，用户看到的「没有结果」根本不是检索结果。
  if (terms.length === 0 && !narrowsToScope(filter)) return [];

  // 候选清单按「目录序 + readdir 序」收集，读取阶段交给并发池
  const candidates: Array<{ dir: string; file: string }> = [];
  for (const d of pageDirs) {
    const dirFull = path.join(vault.getVaultPath(), d);
    let entries: string[] = [];
    try {
      entries = await fs.readdir(dirFull);
    } catch {
      continue;
    }
    for (const f of entries) candidates.push({ dir: d, file: f });
  }

  // 这条兜底路径服务「纯过滤查询」与索引不可用时的降级：串行读全库是秒级队头阻塞，
  // 与索引路径同口径走有界并发（O3）
  const badPages: Array<{ path: string; reason: string }> = [];
  const outcomes = await mapWithConcurrency(
    candidates,
    DEFAULT_SCAN_CONCURRENCY,
    ({ dir, file }) => processSearchFile(vault, `${dir}/${file}`, dir, file, terms, filter, badPages),
  );

  // 一次扫描只打一条：坏页多时逐页 warn 会把日志刷满，排查要的只是「哪几页坏了 + 一共几页」
  if (badPages.length > 0) {
    console.warn('[search-scan] frontmatter 解析失败已跳过', JSON.stringify({
      total: badPages.length,
      sample: badPages.slice(0, 3),
    }));
  }

  const listed: SearchHit[] = [];
  const matched: ScannedPage[] = [];
  for (const outcome of outcomes) {
    if (!outcome) continue;
    if (outcome.kind === 'listed') listed.push(outcome.hit);
    else matched.push(outcome.page);
  }

  // 无关键词：列出分支，按标题稳定排序（与打分无关）
  if (terms.length === 0) {
    listed.sort((a, b) => a.title.localeCompare(b.title));
    return listed.slice(0, limit);
  }

  // T04560：IDF 在「本次查询的候选页集合」上算——候选指「通过过滤且有命中」的页，
  // 与索引路径的候选集口径相同（FTS 召回后同样只保留有命中的页），两路因此同排序。
  // 注意：legacy 的 lower 含 frontmatter 原文、索引路径只有正文 chunk，df 的绝对数会有细小差异；
  // 这一步是要收掉「按命中词数排序」的失真，不是要造一套全局词权重，df 差异落在噪声量级。
  // 内存代价：命中页的正文在打分期间同时驻留（只留命中页，不是全库）；这条路径是索引不可用时的
  //   降级 + 纯过滤查询，正常 /api/search 走索引路径不经过这里。
  const stats = computeTermStats(terms, matched.map((p) => p.lower));
  const results: SearchHit[] = matched.map((page) => {
    const { score, hits } = scoreLower(page.lower, terms, stats);
    return {
      path: page.path,
      title: page.title,
      snippet: buildSnippet(page.searchContent, page.lower, terms, stats),
      hits,
      score,
    };
  });

  // 排序：加权分优先（区分度高的词命中者在上），同分退回命中词数，最后标题兜底保证确定性
  results.sort((a, b) => {
    if (b.score !== a.score) return b.score - a.score;
    if (b.hits !== a.hits) return b.hits - a.hits;
    return a.title.localeCompare(b.title);
  });
  return results.slice(0, limit);
}
