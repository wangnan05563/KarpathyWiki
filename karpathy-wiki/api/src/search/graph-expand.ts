// T04072 命中页一跳图拓：沿正文 wikilink 出边 + 反向链接取邻居，只返回标题与首段摘要。
// 为什么只给摘要：邻居是「关联参考」而非一手依据，全文留给 LLM 按需 read_page，避免 token 失控。
// 为什么复用 buildLinkGraph：图谱已有 30s TTL 缓存且与 /api/graph、/api/stats 共享，不引入新扫描。
import matter from 'gray-matter';
import type { VaultService } from '../vault/vault-service.js';
import type { QueryGraphExpandConfig } from '../types.js';

// 与 config.ts 默认值保持一致；使用方在配置浅合并后仍用本对象补缺失字段。
export const DEFAULT_GRAPH_EXPAND = {
  enabled: false,
  maxNeighbors: 3,
  charsPerPage: 200,
  totalChars: 900,
} as const;

export type NeighborVia = 'outlink' | 'backlink' | 'both';

export interface NeighborHit {
  path: string;
  title: string;
  snippet: string;
  // 邻居与命中页的链接方向：命中页指向邻居=outlink，邻居指向命中页=backlink
  via: NeighborVia;
}

export interface ResolvedGraphExpandLimits {
  enabled: boolean;
  maxNeighbors: number;
  charsPerPage: number;
  totalChars: number;
}

function positiveInt(value: number | undefined, fallback: number): number {
  return typeof value === 'number' && Number.isFinite(value) && value > 0
    ? Math.floor(value)
    : fallback;
}

// 配置段是浅合并（用户只写 enabled 时其余字段会丢），故逐字段在读取侧补默认值。
export function resolveGraphExpandLimits(config?: QueryGraphExpandConfig): ResolvedGraphExpandLimits {
  return {
    enabled: config?.enabled ?? DEFAULT_GRAPH_EXPAND.enabled,
    maxNeighbors: positiveInt(config?.maxNeighbors, DEFAULT_GRAPH_EXPAND.maxNeighbors),
    charsPerPage: positiveInt(config?.charsPerPage, DEFAULT_GRAPH_EXPAND.charsPerPage),
    totalChars: positiveInt(config?.totalChars, DEFAULT_GRAPH_EXPAND.totalChars),
  };
}

// 标题取首个一级标题，缺省用文件名；摘要取首个非标题正文行并截断。
// 为什么按行取首段：邻居只需提供线索，整段拼接会随页面长度线性膨胀。
export function extractTitleAndSnippet(
  content: string,
  path: string,
  maxChars: number,
): { title: string; snippet: string } {
  const body = matter(content).content;
  const base = path.split('/').pop() ?? path;
  let title = base.replace(/\.md$/i, '');
  let titleFound = false;
  let snippet = '';
  for (const raw of body.split(/\r?\n/)) {
    const line = raw.trim();
    if (!line) continue;
    const heading = /^#{1,6}\s+(.+)$/.exec(line);
    if (heading) {
      if (!titleFound && line.startsWith('# ')) {
        title = heading[1].trim();
        titleFound = true;
      }
      continue;
    }
    // 跳过分隔线与非文本结构（代码围栏、表格行）作为摘要
    if (/^(-{3,}|\*{3,}|```|\|)/.test(line)) continue;
    snippet = line.length > maxChars ? line.slice(0, maxChars) : line;
    break;
  }
  return { title, snippet };
}

// 对命中页求一跳邻居（排除命中页自身），按「共同链接的命中页数」降序、路径升序稳定排序，
// 再按条数/单页/总量三重上限截断。单页读失败直接跳过，不阻断问答。
export async function expandNeighbors(
  vault: VaultService,
  hitPaths: string[],
  config?: QueryGraphExpandConfig,
): Promise<NeighborHit[]> {
  const limits = resolveGraphExpandLimits(config);
  if (!limits.enabled || hitPaths.length === 0) return [];

  const hitSet = new Set(hitPaths);
  const graph = await vault.buildLinkGraph();

  // key=邻居路径；hits 记录它连到了多少个不同命中页（链接权重），out/back 记录方向
  const candidates = new Map<string, { out: boolean; back: boolean; hits: Set<string> }>();
  const record = (path: string) => {
    const existing = candidates.get(path);
    if (existing) return existing;
    const created = { out: false, back: false, hits: new Set<string>() };
    candidates.set(path, created);
    return created;
  };
  for (const edge of graph.edges) {
    if (hitSet.has(edge.from) && !hitSet.has(edge.to)) {
      const rec = record(edge.to);
      rec.out = true;
      rec.hits.add(edge.from);
    } else if (hitSet.has(edge.to) && !hitSet.has(edge.from)) {
      const rec = record(edge.from);
      rec.back = true;
      rec.hits.add(edge.to);
    }
  }

  const ranked = [...candidates.entries()].sort((a, b) => {
    const byWeight = b[1].hits.size - a[1].hits.size;
    if (byWeight !== 0) return byWeight;
    return a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0;
  });

  const out: NeighborHit[] = [];
  let usedChars = 0;
  for (const [path, rec] of ranked) {
    if (out.length >= limits.maxNeighbors) break;
    const remaining = limits.totalChars - usedChars;
    if (remaining <= 0) break;
    let content: string;
    try {
      content = await vault.readFile(path);
    } catch {
      continue;
    }
    const { title, snippet } = extractTitleAndSnippet(
      content,
      path,
      Math.min(limits.charsPerPage, remaining),
    );
    if (!snippet) continue;
    usedChars += snippet.length;
    out.push({
      path,
      title,
      snippet,
      via: rec.out && rec.back ? 'both' : rec.out ? 'outlink' : 'backlink',
    });
  }
  return out;
}
