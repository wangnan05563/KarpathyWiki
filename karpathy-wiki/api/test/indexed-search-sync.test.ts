// O1 增量同步的三条判据（沙箱实测到的行为，落成用例防回归）：
//   1) 服务内写入（vault.writeFile → 变更修订号递增）后，下一次搜索必须立即看到新页，
//      不能等 5 s 节流窗口——用户「保存后搜不到」是最直观的错误。
//   2) 外部改动（Obsidian 直接落盘/删除）不动修订号，靠节流周期兜住：强制同步后必须一致。
//   3) 索引不可用（未建库）时搜索返回空数组，由路由层决定回退，而不是在这里抛。
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import matter from 'gray-matter';

import { VaultService } from '../src/vault/vault-service.js';
import { closeIndexDb } from '../src/search/sqlite-index.js';
import { ensureIndexSynced, searchPagesIndexed } from '../src/search/indexed-search.js';

let tempDir: string;
let vaultDir: string;
let dataDir: string;
let vault: VaultService;

async function writePage(rel: string, body: string): Promise<void> {
  const abs = path.join(vaultDir, ...rel.split('/'));
  await fs.mkdir(path.dirname(abs), { recursive: true });
  await fs.writeFile(abs, matter.stringify(`\n${body}\n`, { title: rel, updated: '2026-11-01' }), 'utf8');
}

beforeAll(async () => {
  tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'kb-indexed-sync-'));
  vaultDir = path.join(tempDir, 'vault');
  dataDir = path.join(tempDir, 'data');
  await fs.mkdir(vaultDir, { recursive: true });
  await fs.mkdir(dataDir, { recursive: true });
  vault = new VaultService(vaultDir);
  await vault.init();
  await writePage('entities/alpha.md', '甲页面，提到 唯一标记ALPHA。');
});

afterAll(async () => {
  closeIndexDb(); // 不关连接时 Windows 会锁住 db 文件，rm 直接 EBUSY
  await fs.rm(tempDir, { recursive: true, force: true });
});

// T04458：查询串只用拉丁标记，不带「唯一标记」这段中文。
// 取词收敛后中文查询会展开成 2-gram（唯一/一标/标记），而三页正文都含「页面/提到」这类共用 bigram，
// 于是「查 beta 的标记」会把 alpha 一并召回——本文件锁的是索引新鲜度（删页/改写后旧内容不再命中），
// 不是中文分词；标记必须在**词项级**唯一，否则 toEqual([]) / toHaveLength(1) 锁的是分词口径而非同步。
// 中文整句召回由 test/search-shared-keywords.test.ts 负责。
describe('O1 索引增量同步', () => {
  it('服务内写入后，下一次搜索立即命中新页（不等 5 s 节流）', async () => {
    await ensureIndexSynced(dataDir, vault);
    expect(await searchPagesIndexed(dataDir, vault, 'ALPHA')).toHaveLength(1);

    await vault.writeFile('entities/beta.md', matter.stringify('\n乙页面，提到 唯一标记BETA。\n', { title: 'beta', updated: '2026-11-01' }));
    const hits = await searchPagesIndexed(dataDir, vault, 'BETA');
    expect(hits?.map((h) => h.path)).toContain('entities/beta.md');
  });

  it('外部删除页面后，强制同步把该页移出索引', async () => {
    await fs.rm(path.join(vaultDir, 'entities', 'beta.md'));
    // 未强制同步前，节流窗口内的读数仍可能含旧页；强制同步后必须为空
    await ensureIndexSynced(dataDir, vault, true);
    expect(await searchPagesIndexed(dataDir, vault, 'BETA')).toEqual([]);
  });

  it('mtime 变化（外部改写）在下一次同步里被重索引，旧内容不再命中', async () => {
    await writePage('entities/gamma.md', '丙页面，关键词 唯一标记GAMMAOLD。');
    // 外部落盘不动修订号，靠同步周期收敛；这里用强制同步表达「下一个周期」
    await ensureIndexSynced(dataDir, vault, true);
    expect(await searchPagesIndexed(dataDir, vault, 'GAMMAOLD')).toHaveLength(1);

    await writePage('entities/gamma.md', '丙页面改写，关键词 唯一标记GAMMANEW。');
    // 判 stale 用的是「文件 mtime 比索引写入时间新 1 s 以上」，同秒内的两次写需要显式推后 mtime
    const abs = path.join(vaultDir, 'entities', 'gamma.md');
    const t = (Date.now() + 5_000) / 1000;
    await fs.utimes(abs, t, t);
    await ensureIndexSynced(dataDir, vault, true);
    expect(await searchPagesIndexed(dataDir, vault, 'GAMMANEW')).toHaveLength(1);
    expect(await searchPagesIndexed(dataDir, vault, 'GAMMAOLD')).toEqual([]);
  });

  it('纯过滤查询（无关键词）返回 null，交给调用方回退', async () => {
    expect(await searchPagesIndexed(dataDir, vault, '   ', 10, { type: 'entity' })).toBeNull();
  });
});
