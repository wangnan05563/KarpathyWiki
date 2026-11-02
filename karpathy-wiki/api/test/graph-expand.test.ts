// T04072：问答命中页沿 wikilink/反向链接拓一跳的回归锁。
// 覆盖：
//   1. A→B→C 夹具：命中 A 时只拓到一跳 B（C 是二跳，不得进入结果）；
//   2. 出边/反向链接方向标记（via）与「邻居只有摘要、无引用槽位」；
//   3. 条数/单页/总量三重上限，防止 token 失控；
//   4. refs 区分 hit/neighbor 来源（RefSignal.origin）；
//   5. 开关默认关闭（无配置行为与改造前一致）。
// 隔离纪律：vault 落在 os.tmpdir() 随机目录，用后即焚，不触碰真实知识库。
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { VaultService } from '../src/vault/vault-service.js';
import { createQueryTools, upgradeRefs } from '../src/workflows/query-workflow.js';
import { expandNeighbors, resolveGraphExpandLimits } from '../src/search/graph-expand.js';
import type { AnswerChunk, QueryGraphExpandConfig, RefSignal } from '../src/types.js';

interface ToolEntry {
  kind: 'hit' | 'neighbor';
  slot?: number;
  path: string;
  title: string;
  snippet: string;
  via?: 'outlink' | 'backlink' | 'both';
}

const ENABLED: QueryGraphExpandConfig = { enabled: true, maxNeighbors: 3, charsPerPage: 200, totalChars: 900 };

let vaultDir: string;
let vault: VaultService;
const createdDirs: string[] = [];

function writePage(relPath: string, body: string): void {
  const abs = path.join(vaultDir, relPath);
  mkdirSync(path.dirname(abs), { recursive: true });
  writeFileSync(abs, body, 'utf8');
}

// 夹具：a→b→c 两跳链；d、e 反向链接到 a。
function seedVault(): void {
  writePage('concepts/a.md', '# 甲页\n\n甲页正文 alpha 关键词命中。\n\n参见 [[b]]。');
  writePage('concepts/b.md', '# 乙页\n\n乙页正文，描述乙约束。详见 [[c]]。');
  writePage('concepts/c.md', '# 丙页\n\n丙页正文，关键约束在丙。');
  writePage('concepts/d.md', '# 丁页\n\n丁页正文。参见 [[a]]。');
  writePage('concepts/e.md', '# 戊页\n\n戊页正文。参见 [[a]]。');
}

async function runSearch(keywords: string, options: Parameters<typeof createQueryTools>[1]): Promise<ToolEntry[]> {
  const tool = createQueryTools(vault, options).find((t) => t.name === 'search_pages');
  if (!tool) throw new Error('search_pages tool missing');
  return (await tool.handler({ keywords }, {} as never)) as ToolEntry[];
}

beforeEach(() => {
  vaultDir = mkdtempSync(path.join(tmpdir(), 'wiki-graph-expand-'));
  createdDirs.push(vaultDir);
  vault = new VaultService(vaultDir);
  seedVault();
});

afterAll(() => {
  for (const dir of createdDirs) {
    try {
      rmSync(dir, { recursive: true, force: true });
    } catch {
      /* 清理失败不影响结果 */
    }
  }
});

describe('T04072 命中页一跳图拓', () => {
  it('A→B→C 夹具：只拓一跳邻居，二跳页不进结果', async () => {
    const citationSlots: string[] = [];
    const neighborSink: string[] = [];
    const result = await runSearch('alpha', {
      citationSink: citationSlots,
      neighborSink,
      graphExpand: ENABLED,
    });

    const paths = result.map((r) => r.path);
    expect(paths).toContain('concepts/a.md');
    expect(paths).toContain('concepts/b.md');
    expect(paths).not.toContain('concepts/c.md');

    const hit = result.find((r) => r.path === 'concepts/a.md');
    expect(hit?.kind).toBe('hit');
    expect(hit?.slot).toBe(1);

    // 邻居不给 slot（不占 [n] 编号），只给摘要与方向
    const neighbor = result.find((r) => r.path === 'concepts/b.md');
    expect(neighbor?.kind).toBe('neighbor');
    expect(neighbor?.slot).toBeUndefined();
    expect(neighbor?.via).toBe('outlink');
    expect(neighbor?.snippet).toContain('乙页正文');
    expect(neighbor?.snippet).not.toContain('# 乙页');

    expect(citationSlots).toEqual(['concepts/a.md']);
    expect(neighborSink.sort()).toEqual(['concepts/b.md', 'concepts/d.md', 'concepts/e.md']);
  });

  it('反向链接同样参与拓边，且方向标记为 backlink', async () => {
    const neighbors = await expandNeighbors(vault, ['concepts/a.md'], ENABLED);
    const d = neighbors.find((n) => n.path === 'concepts/d.md');
    expect(d).toBeDefined();
    expect(d?.via).toBe('backlink');
    // 标题取页面一级标题，缺省才用文件名
    expect(d?.title).toBe('丁页');
  });

  it('条数与字数上限同时生效（防 token 失控）', async () => {
    const onlyOne = await expandNeighbors(vault, ['concepts/a.md'], {
      enabled: true, maxNeighbors: 1, charsPerPage: 5, totalChars: 1000,
    });
    expect(onlyOne).toHaveLength(1);
    expect(onlyOne[0].snippet.length).toBeLessThanOrEqual(5);

    const capped = await expandNeighbors(vault, ['concepts/a.md'], {
      enabled: true, maxNeighbors: 3, charsPerPage: 10, totalChars: 15,
    });
    expect(capped.length).toBeGreaterThan(0);
    expect(capped.reduce((sum, n) => sum + n.snippet.length, 0)).toBeLessThanOrEqual(15);
  });

  it('refs 区分来源：命中页 origin=hit，邻居 origin=neighbor', async () => {
    async function* source(): AsyncGenerator<AnswerChunk, void, unknown> {
      yield { refs: ['concepts/a.md', 'concepts/b.md'], done: true };
    }
    const chunks: AnswerChunk[] = [];
    for await (const chunk of upgradeRefs(source(), vault, undefined, ['concepts/b.md'])) {
      chunks.push(chunk);
    }
    const signals = chunks[0].refs as RefSignal[];
    expect(signals.find((s) => s.path === 'concepts/a.md')?.origin).toBe('hit');
    expect(signals.find((s) => s.path === 'concepts/b.md')?.origin).toBe('neighbor');
  });

  it('开关默认关闭：不配置 graphExpand 时结果与改造前一致', async () => {
    const citationSlots: string[] = [];
    const neighborSink: string[] = [];
    const result = await runSearch('alpha', { citationSink: citationSlots, neighborSink });
    expect(result.map((r) => r.path)).toEqual(['concepts/a.md']);
    expect(result.every((r) => r.kind === 'hit')).toBe(true);
    expect(neighborSink).toEqual([]);
    expect(resolveGraphExpandLimits(undefined).enabled).toBe(false);
  });

  it('邻居页后续被正式命中时从邻居集合移除（refs 不误标 neighbor）', async () => {
    const citationSlots: string[] = [];
    const neighborSink: string[] = [];
    const options = { citationSink: citationSlots, neighborSink, graphExpand: ENABLED };

    await runSearch('alpha', options);
    expect(neighborSink).toContain('concepts/b.md');

    const second = await runSearch('乙页', options);
    expect(second.find((r) => r.path === 'concepts/b.md')?.kind).toBe('hit');
    expect(citationSlots).toContain('concepts/b.md');
    expect(neighborSink).not.toContain('concepts/b.md');
  });

  it('配置只写 enabled 时，其余上限回落到默认值（浅合并补默认）', () => {
    expect(resolveGraphExpandLimits({ enabled: true })).toEqual({
      enabled: true,
      maxNeighbors: 3,
      charsPerPage: 200,
      totalChars: 900,
    });
  });

  // 接线锁：单测直接调用 createQueryTools/upgradeRefs，覆盖不到 queryWorkflow 里的透传；
  // 这里锁住「两处 createQueryTools 都接配置」「两处 upgradeRefs 都传邻居集合」的源码事实。
  it('接线：两个问答分支都透传图拓配置与邻居集合', () => {
    const src = readFileSync(new URL('../src/workflows/query-workflow.ts', import.meta.url), 'utf8');
    expect(src.match(/graphExpand: options\.appConfig\?\.query\?\.graphExpand,/g)).toHaveLength(2);
    expect(src.match(/vault, options\.appConfig, neighborSink\)\)/g)).toHaveLength(2);
    expect(src).toContain('const neighborSink: string[] = [];');
  });
});
