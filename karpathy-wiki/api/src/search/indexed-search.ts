// O1：把 /api/search 从「每次请求全库 readdir + readFile + 字符串匹配」切到已存在的
// FTS5 chunk 索引，并按文件 mtime 做增量同步。
// 为什么复用 sqlite-index 而不是新造倒排索引：索引表、trigram FTS5 与写入口都已存在，
// 缺的只是「读侧自动建库/增量更新」这条链路（此前 /api/search/status 长期 indexedPages=0）。
// 降级：索引不可用/同步失败时由调用方回退 searchPages，行为与改造前一致。
import fs from 'node:fs/promises';
import path from 'node:path';
// T04503：整页解析走收敛层（绕开 gray-matter 的内容缓存，坏页判定只由字节决定）
import { tryParsePage } from '../utils/frontmatter.js';
import type { VaultService } from '../vault/vault-service.js';
import type { SearchFilter, SearchHit } from '../search-util.js';
import { mapWithConcurrency } from '../utils/async-pool.js';
import { getPageSnapshot } from '../utils/derived-cache.js';
// T04458：与 legacy 扫描、召回层共用同一份取词（整句中文不再当成一个词项）
import { toSearchTerms } from '../utils/query-keywords.js';
// T04560：加权打分与 snippet 锚点与 legacy 路径共用同一实现（否则两路对同一查询排序分叉）
import { computeTermStats, scoreLower, pickAnchorIndex, type TermStats } from '../utils/search-rank.js';
import { keywordRecall, listIndexedPageTimes, removePageIndex } from './sqlite-index.js';
import { indexPage, listVaultPages } from './hybrid-search.js';

const SYNC_INTERVAL_MIN_MS = 5_000;
const SYNC_INTERVAL_MAX_MS = 60_000;
const SYNC_CONCURRENCY = 4;
const SYNC_STAT_CONCURRENCY = 8;
// mtime 与索引写入时间存在毫秒级先后差，留 1 s 容差避免同一文件被反复重索引
const MTIME_TOLERANCE_MS = 1_000;
// 无变化的同步之间隔指数退避（5 s → 60 s 封顶）：mtime 扫描只是 chokidar 监听的兜底，
//   固定 5 s 一次要在高并发下每轮付一次 250 文件的 stat（实测约 400 ms，压测里表现为周期性全局静默）。
let syncIntervalMs = SYNC_INTERVAL_MIN_MS;

export interface IndexSyncInfo {
  indexedPages: number;
  updatedPages: number;
  removedPages: number;
  durationMs: number;
  syncedAt: number;
}

let lastSyncAt = 0;
let lastSyncInfo: IndexSyncInfo = { indexedPages: 0, updatedPages: 0, removedPages: 0, durationMs: 0, syncedAt: 0 };
let syncInFlight: Promise<IndexSyncInfo> | null = null;
// 上一次同步开始时 vault 的写版本号。节流只用于「没人写，只是时间到了」的场景：
//   服务内写入会递增 revision，必须让下一次搜索立即同步，否则刚保存的页面最多 5 s 搜不到。
let lastSyncRevision = -1;

/** 供 /api/search/status 展示的最近同步结果（O7） */
export function getIndexSyncInfo(): IndexSyncInfo {
  return lastSyncInfo;
}

async function runSync(dataDir: string, vault: VaultService, force: boolean): Promise<IndexSyncInfo> {
  const startedAt = Date.now();
  const startRevision = vault.getChangeRevision();
  const pages = await listVaultPages(vault);
  const indexed = listIndexedPageTimes(dataDir);
  const vaultPath = vault.getVaultPath();

  // mtime 取共享页面快照（与 4 个派生缓存同一份遍历）：
  //   各扫各的会在高并发下每 5 s 造成 0.3–1.4 s 的全局静默（压测实测）。
  //   force 表示「外部改动必须立刻见到」，此时连快照一起重扫。
  const snapshot = await getPageSnapshot(vaultPath, startRevision, force);
  const mtimes = await mapWithConcurrency(pages, SYNC_STAT_CONCURRENCY, async (rel) => {
    const fromSnapshot = snapshot.mtimeByRel.get(rel);
    if (fromSnapshot !== undefined) return fromSnapshot;
    try {
      return (await fs.stat(path.join(vaultPath, rel))).mtimeMs;
    } catch {
      return null; // 快照里没有且也 stat 不到：读取期间被删除，交给下方 removed 清理
    }
  });

  const stale: string[] = [];
  for (let i = 0; i < pages.length; i++) {
    const mtimeMs = mtimes[i];
    if (mtimeMs === null) continue;
    const indexedAt = indexed.get(pages[i]);
    if (indexedAt === undefined || mtimeMs > indexedAt + MTIME_TOLERANCE_MS) stale.push(pages[i]);
  }

  await mapWithConcurrency(stale, SYNC_CONCURRENCY, async (rel) => {
    try {
      await indexPage(dataDir, vault, rel);
    } catch {
      // 单页索引失败不影响其他页；下次同步会重试
    }
  });

  const pageSet = new Set(pages);
  let removedPages = 0;
  for (const rel of indexed.keys()) {
    if (pageSet.has(rel)) continue;
    try {
      removePageIndex(dataDir, rel);
      removedPages++;
    } catch {
      // 删除索引失败时保留，下次同步再试
    }
  }

  lastSyncAt = Date.now();
  lastSyncRevision = startRevision;
  // 这轮什么都没变 → 退避；有增删改（说明外部编辑正在发生，或 chokidar 漏了）→ 回到最快档
  syncIntervalMs = stale.length === 0 && removedPages === 0
    ? Math.min(syncIntervalMs * 2, SYNC_INTERVAL_MAX_MS)
    : SYNC_INTERVAL_MIN_MS;
  lastSyncInfo = {
    indexedPages: pages.length - removedPages,
    updatedPages: stale.length,
    removedPages,
    durationMs: lastSyncAt - startedAt,
    syncedAt: lastSyncAt,
  };
  return lastSyncInfo;
}

/**
 * 单飞 + 退避节流同步：并发请求共享同一次同步；vault 自上次同步后没有写入、且上一轮没发现增删改时，
 * 复用上次结果的窗口从 5 s 起指数放大到 60 s（服务写入与 chokidar 变更都会立即绕过该窗口）。
 * 首次调用会建库并索引全量页面（约数百页），之后只处理 mtime 变化的页。
 */
export async function ensureIndexSynced(dataDir: string, vault: VaultService, force = false): Promise<IndexSyncInfo> {
  if (!force && syncInFlight) return syncInFlight;
  if (!force && vault.getChangeRevision() === lastSyncRevision && Date.now() - lastSyncAt < syncIntervalMs) {
    return lastSyncInfo;
  }
  syncInFlight = runSync(dataDir, vault, force).finally(() => { syncInFlight = null; });
  return syncInFlight;
}

interface PageChunks {
  chunks: Array<{ content: string; heading: string | null; index: number }>;
  score: number;
}

// frontmatter 值来自 YAML，可能是数组/对象：String() 会得出 '[object Object]' 这种
// 既不可读又会与用户输入误判的字符串，因此只接受原始值，其余按「不匹配」处理。
function asFilterableString(value: unknown): string {
  if (typeof value === 'string') return value;
  if (typeof value === 'number' || typeof value === 'boolean') return String(value);
  return '';
}

// 与 legacy matchSearchFilter 同一语义：frontmatter 字段过滤
function matchFilter(data: Record<string, unknown>, filter?: SearchFilter): boolean {
  if (!filter) return true;
  if (filter.source && data.source !== filter.source) return false;
  if (filter.status && data.status !== filter.status) return false;
  if (filter.type && asFilterableString(data.type).toLowerCase() !== filter.type.toLowerCase()) return false;
  if (filter.tags && filter.tags.length > 0) {
    const pageTags: string[] = Array.isArray(data.tags) ? data.tags as string[] : [];
    if (!pageTags.some((t) => filter.tags!.includes(t))) return false;
  }
  return true;
}

type RecallRow = ReturnType<typeof keywordRecall>[number];

// FTS 召回按页分块：同一页面的多个 chunk 归并成一个候选页，分数累加
function groupChunksByPage(rows: RecallRow[]): Map<string, PageChunks> {
  const byPage = new Map<string, PageChunks>();
  for (const row of rows) {
    const entry = byPage.get(row.pagePath) ?? { chunks: [], score: 0 };
    entry.chunks.push({ content: row.content, heading: row.heading, index: row.chunkIndex });
    entry.score += row.score;
    byPage.set(row.pagePath, entry);
  }
  return byPage;
}

// 只有带元数据条件时才需要读原文：纯关键词查询不该为每页多付一次 readFile + YAML 解析
function needsFrontmatterFilter(filter?: SearchFilter): boolean {
  if (!filter) return false;
  const { source, status, type, tags } = filter;
  return Boolean(source || status || type || (tags && tags.length > 0));
}

async function matchesFrontmatter(
  vault: VaultService,
  rel: string,
  filter: SearchFilter | undefined,
  badPageSink: Array<{ path: string; reason: string }>,
): Promise<boolean> {
  let raw: string;
  try {
    raw = await vault.readFile(rel);
  } catch {
    return false; // 读取失败：该页不进结果，与改造前口径一致
  }
  // T04503：坏 YAML 走收敛层判定，并汇入与 legacy 扫描同一条记账口径。
  // 改造前这里是 try { matter(...) } catch { return false }——冷读抛、热读拿到 data:{}，
  // 两种读序结论都算「不匹配」，看似无害，实际坏页在索引路径上完全隐形：
  // 同一次检索在 legacy 与索引两条路上，坏页的记账数不一样。
  const parsed = tryParsePage(raw);
  if (!parsed.ok) {
    badPageSink.push({ path: rel, reason: parsed.reason });
    return false;
  }
  return matchFilter(parsed.data, filter);
}

// T04560：锚点取「最长命中词」而非词表首项——中文 2-gram 下首项常是虚词后的首二字，区分度弱，
// 摘要会落到无关过渡句上。逐 chunk 找锚点：先命中的 chunk 未必含最有区分度的词。
function buildSnippet(chunks: PageChunks['chunks'], terms: string[], stats: TermStats): string {
  for (const chunk of chunks) {
    const lower = chunk.content.toLowerCase();
    const idx = pickAnchorIndex(lower, terms, stats);
    if (idx < 0) continue;
    const start = Math.max(0, idx - 30);
    return chunk.content.slice(start, start + 120).replaceAll('\n', ' ');
  }
  return chunks[0]?.content.slice(0, 120).replaceAll('\n', ' ') ?? '';
}

/**
 * 走 FTS5 索引的全文检索。仅处理「有关键词」的查询；纯过滤查询返回 null 由调用方回退。
 * 返回 null 表示索引路径不可用（调用方应回退 legacy），返回数组表示索引路径已完成检索。
 */
export async function searchPagesIndexed(
  dataDir: string,
  vault: VaultService,
  keywords: string,
  limit = 20,
  filter?: SearchFilter,
): Promise<SearchHit[] | null> {
  const terms = toSearchTerms(keywords);
  if (terms.length === 0) return null;

  await ensureIndexSynced(dataDir, vault);
  // 多取候选 chunk，保证同一页面的多个 chunk 不会把 top-20 页面挤掉
  // 传词表而非原句：召回层与下方 hitCount/snippet 必须用同一份词，否则「召回到的页」与「算分的词」会分叉
  const rows = keywordRecall(dataDir, terms.join(' '), Math.max(limit * 20, 200));
  if (rows.length === 0) return [];

  const byPage = groupChunksByPage(rows);

  // 与 legacy 扫描（search-util.searchPages）同一条坏页记账口径：一次检索只打一条，
  // 排查要的是「哪几页坏了 + 一共几页」，而不是逐页刷日志。
  const badPages: Array<{ path: string; reason: string }> = [];
  // T04560：先收集候选页（有命中且过过滤），再统一算 IDF 与分数——IDF 依赖候选集，
  // 边遍历边打分就会用上半截候选集算权重，结果随 chunk 返回顺序漂移。
  const candidates: Array<{ rel: string; entry: PageChunks; combined: string }> = [];
  for (const [rel, entry] of byPage) {
    if (filter?.folder && !rel.startsWith(`${filter.folder}/`)) continue;
    const combined = entry.chunks.map((c) => c.content).join('\n').toLowerCase();
    if (!terms.some((t) => combined.includes(t))) continue;

    if (needsFrontmatterFilter(filter) && !(await matchesFrontmatter(vault, rel, filter, badPages))) continue;

    entry.chunks.sort((a, b) => a.index - b.index);
    candidates.push({ rel, entry, combined });
  }

  if (badPages.length > 0) {
    console.warn('[search-scan] frontmatter 解析失败已跳过', JSON.stringify({
      total: badPages.length,
      sample: badPages.slice(0, 3),
    }));
  }

  // 候选集口径与 legacy 一致（通过过滤且有命中的页），故两路对同一查询给出同一排序（R5）
  const stats = computeTermStats(terms, candidates.map((c) => c.combined));
  const hits: SearchHit[] = candidates.map(({ rel, entry, combined }) => {
    const { score, hits: hitCount } = scoreLower(combined, terms, stats);
    return {
      path: rel,
      title: rel.split('/').pop()?.replace(/\.md$/, '') ?? rel,
      snippet: buildSnippet(entry.chunks, terms, stats),
      hits: hitCount,
      score,
    };
  });

  hits.sort((a, b) => (b.score - a.score) || (b.hits - a.hits) || a.title.localeCompare(b.title));
  return hits.slice(0, limit);
}
