// 全库派生结果（质量扫描/预检/缺口分析）的缓存键与单飞缓存。
// 为什么不用「写入时递增版本号」：vault 目录还可能被 Obsidian/脚本直接改，
//   只有文件系统本身的 mtime/size 能可靠反映变化；写入钩子只覆盖服务的 writeFile 路径。
// 成本：6 个页面目录递归 readdir + 每个 .md 一次 stat（数百次），比 readFile+gray-matter
//   全量解析便宜 1–2 个数量级，换来重扫描接口从秒级降到毫秒级。
import fs from 'node:fs/promises';
import path from 'node:path';
import { PAGE_DIRS } from '../vault/page-scope.js';
import { mapWithConcurrency } from './async-pool.js';
import { compareCodeUnit } from './code-unit-compare.js';

// 签名遍历成本实测（沙箱 405 页副本）：递归 readdir ≈116 ms + 405 次 stat ≈150–270 ms。
// 关键不是并发度而是频率：libuv 线程池默认只有 4 个 worker，一次遍历就把池占满 0.3–1 s，
//   期间所有接口的 readFile/stat 都在排队——遍历时机会传导成全局延迟。
const SIGNATURE_STAT_CONCURRENCY = 16;
// 快照共享窗口：4 个派生缓存 + 搜索索引同步都要同一份全库 (路径, mtime, size)，
// 服务写入与 chokidar 监听都推进 vault 版本号，版本号一变立刻重新遍历；
// 这个窗口只为「监听也看不到」的直接改盘兜底，量级取到与派生缓存 TTL 相同（60 s）。
// 曾取 2 s 实测过：高并发下每 2 s 一次遍历把 load_core_20 的 /api/tags/pending
//   服务端 p50 从 0.9 ms 抬到 1205 ms，整阶段吞吐 162 rps → 20 rps（回归轮实测）。
const SNAPSHOT_MEMO_TTL_MS = 60_000;

// 派生缓存续期的硬龄上限：签名由 (mtime 整秒, size, 路径) 派生，唯一盲区是
//   「同一秒内且字节数不变的直接改盘」。TTL 到期但签名不变时不再全量重算，
//   只把值续到最长 RENEWAL_MAX_AGE_MS，超时则无论签名是否变化都真算一次，
//   给那个盲区兜底。代价：这类极端改动最长延迟 10 分钟可见（服务写入与监听不受影响）。
// 为什么值得：2026-11-01 压测里 60 s TTL 一到期就在请求线程重扫全库，
//   表现为每 ~30 s 一次 2–3 s 的全局静默（/api/tags/pending p50 0.9 ms 但 p99 2.6 s）。
const RENEWAL_MAX_AGE_MS = 600_000;

// FNV-1a 32 位：只用于判断「是否变化」，不用于安全用途
function mix(hash: number, value: number): number {
  let h = hash ^ (value >>> 0);
  h = Math.imul(h, 0x01000193) >>> 0;
  return h;
}

/** 一次全库遍历的产物：签名（缓存键）+ 每页 mtime（索引增量同步判据） */
export interface PageSnapshot {
  signature: string;
  pageCount: number;
  /** rel（`目录/文件名.md`，正斜杠）→ mtimeMs 截断到整毫秒 */
  mtimeByRel: Map<string, number>;
}

async function buildPageSnapshot(vaultPath: string): Promise<PageSnapshot> {
  const absFiles: string[] = [];
  for (const dir of PAGE_DIRS) {
    try {
      const entries = await fs.readdir(path.join(vaultPath, dir), { recursive: true, withFileTypes: true });
      for (const entry of entries) {
        if (!entry.isFile() || !entry.name.endsWith('.md')) continue;
        const parent = (entry as { parentPath?: string; path?: string }).parentPath
          ?? (entry as { path?: string }).path
          ?? path.join(vaultPath, dir);
        absFiles.push(path.join(parent, entry.name));
      }
    } catch {
      // 目录不存在（新库）：该目录不参与签名
    }
  }
  // 顺序参与签名哈希：显式码序比较（与默认 sort 同序），不用 locale 相关比较器
  absFiles.sort(compareCodeUnit);
  const stats = await mapWithConcurrency(absFiles, SIGNATURE_STAT_CONCURRENCY, async (file) => {
    try {
      const stat = await fs.stat(file);
      return { mtime: Math.trunc(stat.mtimeMs), size: stat.size };
    } catch {
      // 读取期间被删除：下一次调用签名自然变化
      return null;
    }
  });
  let hash = 2166136261;
  const mtimeByRel = new Map<string, number>();
  for (let i = 0; i < absFiles.length; i++) {
    const abs = absFiles[i];
    const rel = path.relative(vaultPath, abs).split(path.sep).join('/');
    const stat = stats[i];
    if (stat) {
      mtimeByRel.set(rel, stat.mtime);
      hash = mix(hash, stat.mtime & 0xffffffff);
      hash = mix(hash, stat.size & 0xffffffff);
    }
    // 按码点遍历（for..of 保证代理对不被拆成两段），BMP 字符与原先逐 code unit 取值一致
    for (const ch of abs) hash = mix(hash, ch.codePointAt(0) ?? 0);
  }
  return { signature: `${absFiles.length}-${hash.toString(36)}`, pageCount: absFiles.length, mtimeByRel };
}

let snapshotMemo: {
  vaultPath: string;
  revision: number;
  at: number;
  snapshot: Promise<PageSnapshot>;
} | null = null;

/**
 * 全库页面快照（签名 + mtime），按 (vaultPath, 版本号) + 短 TTL 共享一份遍历。
 * revision 由 VaultService 的写入钩子与文件监听器推进；调用方传 0 时退化为纯 TTL 复用。
 * force 用于「外部改动必须立刻见到」：无视快照复用窗口重新遍历。
 */
export function getPageSnapshot(vaultPath: string, revision = 0, force = false): Promise<PageSnapshot> {
  const memo = snapshotMemo;
  const memoSnapshot = memo?.snapshot;
  if (!force && memoSnapshot && memo?.vaultPath === vaultPath && memo?.revision === revision && Date.now() - (memo?.at ?? 0) < SNAPSHOT_MEMO_TTL_MS) {
    return memoSnapshot;
  }
  const next: NonNullable<typeof snapshotMemo> = {
    vaultPath,
    revision,
    at: Date.now(),
    snapshot: buildPageSnapshot(vaultPath),
  };
  snapshotMemo = next;
  // 遍历失败（极不应发生：内部已逐项兜底）时不要把自己永久留在 memo 里
  next.snapshot.catch(() => {
    if (snapshotMemo === next) snapshotMemo = null;
  });
  return next.snapshot;
}

/**
 * 立即丢弃共享快照，下一次取签名时重新遍历。
 * 正常写入不需要它：服务 writeFile 与 chokidar 监听都会推进 vault 版本号，版本号变化即自动重算。
 * 给「不经服务、也不经监听」的直接改盘（测试夹具、运维脚本）用作显式失效，
 *   否则它们要等满 SNAPSHOT_MEMO_TTL_MS 才看得到自己的改动。
 */
export function resetPageSnapshot(): void {
  snapshotMemo = null;
}

/**
 * 页面集合签名：递归覆盖 PAGE_DIRS 下全部 .md（含错位子目录页面），
 * 以相对路径 + mtimeMs + size 参与哈希。同一 (vaultPath, revision) 窗口内共享一次遍历。
 */
export async function computePageSignature(vaultPath: string, revision = 0): Promise<string> {
  return (await getPageSnapshot(vaultPath, revision)).signature;
}

export interface DerivedCacheStats {
  hits: number;
  misses: number;
  /** TTL 到点但签名未变、因而续期命中的次数（本应重算却被跳过） */
  renewals: number;
  lastComputeMs: number;
  lastSignature: string;
  lastComputedAt: number;
}

export interface NamedDerivedCacheStats extends DerivedCacheStats {
  ttlMs: number;
}

// O7：命名实例登记表。缓存命中率/重算耗时只在这里集中出数，
// 避免每个路由各写一份「我去哪查缓存统计」的私有实现。
const cacheRegistry = new Map<string, DerivedCache<unknown>>();

export function getDerivedCacheStats(): Record<string, NamedDerivedCacheStats> {
  const out: Record<string, NamedDerivedCacheStats> = {};
  for (const [name, cache] of cacheRegistry) {
    out[name] = { ...cache.getStats(), ttlMs: cache.ttlMs };
  }
  return out;
}

/** 按页面签名失效的单飞缓存：同一签名并发请求共享一次计算 */
export class DerivedCache<T> {
  private entry: { signature: string; at: number; computedAt: number; value: T } | null = null;
  private inFlight: Promise<T> | null = null;
  private inFlightSignature = '';
  private readonly stats: DerivedCacheStats = {
    hits: 0, misses: 0, renewals: 0, lastComputeMs: 0, lastSignature: '', lastComputedAt: 0,
  };

  constructor(readonly ttlMs: number, name?: string) {
    if (name) cacheRegistry.set(name, this as unknown as DerivedCache<unknown>);
  }

  async get(signature: string, loader: () => Promise<T>): Promise<T> {
    const cached = this.entry;
    if (cached?.signature === signature) {
      const now = Date.now();
      // TTL 只是「多久必须真算一次」的巡查节奏，不是有效性判据：签名没变还重算，
      //   在压测里就是每过 30–60 s 一次 2–3 s 的请求线程阻塞（见 RENEWAL_MAX_AGE_MS 注释）。
      if (now - cached.at < this.ttlMs || now - cached.computedAt < RENEWAL_MAX_AGE_MS) {
        this.stats.hits++;
        if (now - cached.at >= this.ttlMs) {
          this.stats.renewals++;
          this.entry = { ...cached, at: now };
        }
        return cached.value;
      }
    }
    if (this.inFlight && this.inFlightSignature === signature) return this.inFlight;
    this.stats.misses++;
    const startedAt = Date.now();
    const promise = loader()
      .then((value) => {
        const at = Date.now();
        this.entry = { signature, at, computedAt: at, value };
        this.stats.lastComputeMs = at - startedAt;
        this.stats.lastSignature = signature;
        this.stats.lastComputedAt = at;
        return value;
      })
      .finally(() => {
        if (this.inFlight === promise) this.inFlight = null;
      });
    this.inFlight = promise;
    this.inFlightSignature = signature;
    return promise;
  }

  getStats(): DerivedCacheStats {
    return { ...this.stats };
  }

  clear(): void {
    this.entry = null;
  }
}
