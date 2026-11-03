import fs from 'node:fs/promises';
import path from 'node:path';
import matter from 'gray-matter';
import type { VaultService } from './vault/vault-service.js';
// T02686：检索侧页面目录取 page-scope 单一来源
import { PAGE_DIRS } from './vault/page-scope.js';

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

// 错误信息压成一行：日志走 JSON.stringify，多行原文会把它撑成一条不可读的长串
function firstLine(err: unknown): string {
  const msg = err instanceof Error ? err.message : String(err);
  return msg.split('\n')[0].slice(0, 160);
}

// 检查页面是否匹配搜索过滤器（frontmatter 过滤）
function matchSearchFilter(
  content: string,
  filter?: SearchFilter,
  terms?: string[],
): { matched: boolean; content?: string } {
  if (!filter?.source && !filter?.status && !filter?.type && !filter?.tags) {
    return { matched: true };
  }
  const parsed = matter(content);
  const fm = parsed.data;
  if (filter?.source && fm.source !== filter.source) return { matched: false };
  if (filter?.status && fm.status !== filter.status) return { matched: false };
  if (filter?.type && String(fm.type ?? '').toLowerCase() !== filter.type.toLowerCase()) return { matched: false };
  if (filter?.tags && filter.tags.length > 0) {
    const pageTags: string[] = Array.isArray(fm.tags) ? fm.tags : [];
    if (!pageTags.some((t) => filter.tags!.includes(t))) return { matched: false };
  }
  // 纯过滤模式（无关键词）
  if (terms?.length === 0) return { matched: true, content: '' };
  return { matched: true, content: parsed.content };
}

// 处理单个页面文件：读取内容、过滤、匹配关键词，返回 SearchHit 或 null
// T04176：badPageSink 收集「frontmatter 解析失败」的页面。为什么必须就地吞掉而不是让它冒出去：
// gray-matter 对坏 YAML 是抛异常（未闭合 flow collection / 重复键 / 值里裸冒号），而带 source、
// status、type、tags 任一过滤条件时每个页面都会过 matter() 一次。此前没人接这个异常——
// 于是全库里只要有一页 frontmatter 写坏，整次扫描连坐中断，问答降级链两级同时失败，
// 用户看到的是「知识库未覆盖此问题」，真实原因却是「有一页 YAML 头坏了」。
// 坏页跳过（无法证明它属于过滤范围），其余页面照常召回；无论扫描是串行还是并发池，口径一致。
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
    filterResult = matchSearchFilter(content, filter, terms);
  } catch (err) {
    badPageSink?.push({ path: rel, reason: firstLine(err) });
    return null;
  }
  if (!filterResult.matched) return null;

  // 纯过滤模式（无关键词）直接返回
  if (filterResult.content === '') {
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
  const hasFilter = filter?.source || filter?.status || filter?.type;
  if (terms.length === 0 && !hasFilter) return [];

  const results: SearchHit[] = [];
  const badPages: Array<{ path: string; reason: string }> = [];

  for (const d of pageDirs) {
    const dirFull = path.join(vault.getVaultPath(), d);
    let entries: string[] = [];
    try {
      entries = await fs.readdir(dirFull);
    } catch {
      continue;
    }
    for (const f of entries) {
      const hit = await processSearchFile(vault, `${d}/${f}`, d, f, terms, filter, badPages);
      if (hit) results.push(hit);
    }
  }

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
