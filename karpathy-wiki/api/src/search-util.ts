import fs from 'node:fs/promises';
import path from 'node:path';
import matter from 'gray-matter';
import type { VaultService } from './vault/vault-service.js';
// T02686：检索侧页面目录取 page-scope 单一来源
import { PAGE_DIRS } from './vault/page-scope.js';
import { DEFAULT_SCAN_CONCURRENCY, mapWithConcurrency } from './utils/async-pool.js';

// 全文检索命中结果
export interface SearchHit {
  path: string;
  title: string;
  snippet: string;
  // 命中关键词数（相关性排序用）
  hits: number;
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
  const parsed = matter(content);
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

// 处理单个页面文件：读取内容、过滤、匹配关键词，返回 SearchHit 或 null
// T04176：badPageSink 收集「frontmatter 解析失败」的页面。为什么必须就地吞掉而不是让它冒出去：
// gray-matter 对坏 YAML 是抛异常（未闭合 flow collection / 重复键 / 值里裸冒号），而带 source、
// status、type、tags 任一过滤条件时每个页面都会过 matter() 一次。mapWithConcurrency 的约定是
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
): Promise<SearchHit | null> {
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
    return { path: rel, title, snippet, hits: 1 };
  }

  const searchContent = filterResult.content || content;
  const lower = searchContent.toLowerCase();
  const hitCount = terms.filter((t) => lower.includes(t)).length;
  if (hitCount === 0) return null;

  const title = f.slice(0, -3);
  const firstIdx = lower.indexOf(terms[0]);
  const start = Math.max(0, firstIdx - 30);
  const snippet = searchContent.slice(start, start + 120).replaceAll('\n', ' ');
  return { path: rel, title, snippet, hits: hitCount };
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
  const terms = keywords.toLowerCase().split(/\s+/).filter(Boolean);
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
  const hits = await mapWithConcurrency(
    candidates,
    DEFAULT_SCAN_CONCURRENCY,
    ({ dir, file }) => processSearchFile(vault, `${dir}/${file}`, dir, file, terms, filter, badPages),
  );
  const results = hits.filter((hit): hit is SearchHit => hit !== null);

  // 一次扫描只打一条：坏页多时逐页 warn 会把日志刷满，排查要的只是「哪几页坏了 + 一共几页」
  if (badPages.length > 0) {
    console.warn('[search-scan] frontmatter 解析失败已跳过', JSON.stringify({
      total: badPages.length,
      sample: badPages.slice(0, 3),
    }));
  }

  results.sort((a, b) => {
    if (b.hits !== a.hits) return b.hits - a.hits;
    return a.title.localeCompare(b.title);
  });
  return results.slice(0, limit);
}
