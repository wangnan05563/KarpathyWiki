// 覆盖统计缓存（性能报告 §12.6「新发现」的收口用例）：/api/search/status 每次请求都做一次
//   「全库 readdir + 逐页状态映射 + stale-model LEFT JOIN」，20 并发实测服务端 p50 226 ms，
//   同期其余端点 ≤20 ms——它是当前读路径的头号尾延迟源。这里锁缓存的三条契约：
//   ① 同一状态并发只算一次（单飞），命中记在 O7 登记表上，别让人去猜缓存生效没有；
//   ② 索引一有写入就换键——补算期间「向量覆盖 N/M」必须跟着动，缓存不许把它冻住
//      （纯 TTL / 纯时间桶的实现会在这条红）；
//   ③ 页面增删同样换键（分母来自 vault 清单，不经索引写入）。
// 与 search-status-coverage.test.ts 的分工：那边管「字段与口径对不对」，这边管「同一口径的取数次数与时效」。
import { afterEach, describe, expect, it } from 'vitest';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import { getIndexCoverage } from '../src/search/hybrid-search.js';
import { closeIndexDb, markIndexFailed, replacePageChunks, savePageVectors } from '../src/search/sqlite-index.js';
import { getDerivedCacheStats, resetPageSnapshot } from '../src/utils/derived-cache.js';
import type { VaultService } from '../src/vault/vault-service.js';

/** 与覆盖契约用例同一套桩：getChangeRevision 故意抛错（缓存路径必须容忍，见 getIndexCoverage 的 vaultPageSignature） */
function stubVault(vaultPath: string): VaultService {
  return {
    getVaultPath: () => vaultPath,
    readFile: (rel: string) => fs.readFile(path.join(vaultPath, rel), 'utf8'),
    getChangeRevision: () => {
      throw new Error('stub：本文件不启用后台索引同步');
    },
  } as unknown as VaultService;
}

function chunk(text: string) {
  return [{ content: text, heading: null }];
}

function fakeVec(seed: number): Float32Array {
  const v = new Float32Array(8);
  v[seed % 8] = 1;
  return v;
}

interface Fixture {
  tempRoot: string;
  vaultPath: string;
  dataDir: string;
  vault: VaultService;
}

let current: Fixture | null = null;

async function seed(): Promise<Fixture> {
  const tempRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'wiki-coverage-cache-'));
  const vaultPath = path.join(tempRoot, 'vault');
  const dataDir = path.join(tempRoot, 'data');
  await fs.mkdir(path.join(vaultPath, 'concepts'), { recursive: true });
  const write = (name: string, body: string) => fs.writeFile(path.join(vaultPath, 'concepts', name), body, 'utf8');
  await Promise.all([
    write('covered-a.md', '# alpha\n覆盖页正文 alpha beta gamma\n'),
    write('pending-b.md', '# beta\n待补页正文 beta gamma delta\n'),
    write('unindexed-c.md', '# gamma\n从未入索引页 gamma delta epsilon\n'),
  ]);
  replacePageChunks(dataDir, 'concepts/covered-a.md', chunk('覆盖页正文 alpha beta gamma'));
  savePageVectors(dataDir, 'concepts/covered-a.md', [fakeVec(1)], 'model-a');
  replacePageChunks(dataDir, 'concepts/pending-b.md', chunk('待补页正文 beta gamma delta'));
  current = { tempRoot, vaultPath, dataDir, vault: stubVault(vaultPath) };
  // 直接改盘的夹具要显式失效共享快照（与 misplaced-route.test.ts 同一约定）
  resetPageSnapshot();
  return current;
}

afterEach(async () => {
  if (current) {
    closeIndexDb();
    await fs.rm(current.tempRoot, { recursive: true, force: true });
    current = null;
  }
  resetPageSnapshot();
});

function coverageStats() {
  const entry = getDerivedCacheStats().searchCoverage;
  expect(entry, 'O7 登记表里必须有 searchCoverage，否则命中率无处可查').toBeTruthy();
  return entry;
}

describe('覆盖统计缓存（/api/search/status 的取数次数与时效）', () => {
  it('同一状态下的 20 个并发只真算一次，其余全部单飞命中', async () => {
    const f = await seed();
    const before = coverageStats();
    const results = await Promise.all(Array.from({ length: 20 }, () => getIndexCoverage(f.dataDir, f.vault)));

    // 单飞的计数口径：只算一次 = misses 只 +1；另外 19 个是「等同一枚 in-flight promise」，
    // 不算 hits（hits 只记「键命中已算好的值」），所以时效由下面的顺序请求证明。
    expect(coverageStats().misses - before.misses, '并发同键应共享一次计算').toBe(1);
    expect(coverageStats().hits - before.hits, '并发排队共享 in-flight，不走 hits').toBe(0);
    for (const r of results) {
      expect(r).toBe(results[0]); // 同一个对象：单飞没有各算各的
      expect(r.totalPages).toBe(3);
      expect(r.coveredPages).toBe(1);
      expect(r.pendingPages).toBe(1);
    }

    const after = await getIndexCoverage(f.dataDir, f.vault);
    expect(after, '算完之后同一键直接取缓存').toBe(results[0]);
    expect(coverageStats().hits - before.hits, '顺序复算应命中缓存').toBe(1);
    expect(coverageStats().misses - before.misses, '命中不该再算一次').toBe(1);
  });

  it('索引一有写入就换键：补算失败计入 failedPages，缓存不许把覆盖数冻住', async () => {
    const f = await seed();
    const first = await getIndexCoverage(f.dataDir, f.vault);
    expect(first.failedPages).toBe(0);

    markIndexFailed(f.dataDir, 'concepts/pending-b.md'); // 只动库，不动页面
    const second = await getIndexCoverage(f.dataDir, f.vault);
    expect(second.failedPages, '补算失败必须立刻反映（纯 TTL 缓存在这里会返回旧值）').toBe(1);
    expect(second.pendingPages).toBe(1);
    expect(second.coveredPages).toBe(first.coveredPages);
  });

  it('向量落库同样换键：新页补完向量后 coveredPages +1', async () => {
    const f = await seed();
    const first = await getIndexCoverage(f.dataDir, f.vault);
    expect(first.coveredPages).toBe(1);

    savePageVectors(f.dataDir, 'concepts/pending-b.md', [fakeVec(3)], 'model-a');
    const second = await getIndexCoverage(f.dataDir, f.vault);
    expect(second.coveredPages).toBe(2);
    expect(second.pendingPages).toBe(0);
  });

  it('页面增删不经索引写入，也要换键（分母取 vault 清单）', async () => {
    const f = await seed();
    const first = await getIndexCoverage(f.dataDir, f.vault);
    expect(first.totalPages).toBe(3);

    await fs.writeFile(path.join(f.vaultPath, 'concepts', 'new-d.md'), '# delta\n新页 epsilon zeta\n', 'utf8');
    resetPageSnapshot(); // 夹具不经服务 writeFile、也不经监听，按约定显式失效共享快照
    const second = await getIndexCoverage(f.dataDir, f.vault);
    expect(second.totalPages, '新页要立刻进分母').toBe(4);
    expect(second.unindexedPages).toBe(first.unindexedPages + 1);
  });

  it('model 进键：换了 embedding 模型，旧向量按待补计', async () => {
    const f = await seed();
    const sameModel = await getIndexCoverage(f.dataDir, f.vault, 'model-a');
    // 与当前模型一致时，待补只剩「已切分但没有向量」的 pending-b（covered-a 的向量可比）
    expect(sameModel.staleModelPages).toBe(1);

    const otherModel = await getIndexCoverage(f.dataDir, f.vault, 'model-zzz');
    // 切模型后 covered-a 的旧向量不可比，一并计入——model 不在键里的话这里会拿到 1（旧值）
    expect(otherModel.staleModelPages).toBe(2);
    expect(otherModel.totalPages).toBe(sameModel.totalPages);
    // 反悔再切回来也必须拿到自己的值，而不是别的模型留下的那条缓存
    expect((await getIndexCoverage(f.dataDir, f.vault, 'model-a')).staleModelPages).toBe(1);
    // 不传 model 时判不了，必须是 null（前端据此不渲染「旧模型待补」）
    expect((await getIndexCoverage(f.dataDir, f.vault)).staleModelPages).toBeNull();
  });
});
