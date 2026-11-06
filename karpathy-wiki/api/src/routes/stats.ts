import type { FastifyInstance, FastifyRequest, FastifyReply } from 'fastify';
import fs from 'node:fs/promises';
import path from 'node:path';
import v8 from 'node:v8';
import type { VaultService } from '../vault/vault-service.js';
// T02472 L1：目录分布与总页数必须同一口径，否则「目录合计 227 / 总页面 245」在一页内自相矛盾
import { PAGE_DIRS, isPageFile } from '../vault/page-scope.js';
// O7：缓存命中率/重算耗时与索引同步情况，让容量问题可在页面上直接定位
import { getDerivedCacheStats } from '../utils/derived-cache.js';
import { getIndexSyncInfo } from '../search/indexed-search.js';

// O4：运行态内存快照，供仪表盘/巡检观察驻留内存走向
// 为什么不用 process.memoryUsage.rss 之类带小数：前端按 MB 展示，保留 1 位小数即可
const BYTES_PER_MB = 1024 * 1024;

function toMb(bytes: number): number {
  return Math.round((bytes / BYTES_PER_MB) * 10) / 10;
}

// 活跃资源按类型计数：定时器/套接字异常堆积是「内存缓慢上涨」之外的另一种泄漏信号
function countActiveResources(): Record<string, number> {
  const counts: Record<string, number> = {};
  for (const name of process.getActiveResourcesInfo()) {
    counts[name] = (counts[name] ?? 0) + 1;
  }
  return counts;
}

function collectRuntimeMetrics() {
  const mem = process.memoryUsage();
  const heapLimitBytes = v8.getHeapStatistics().heap_size_limit;
  return {
    pid: process.pid,
    nodeVersion: process.version,
    uptimeSec: Math.round(process.uptime()),
    memoryMb: {
      rss: toMb(mem.rss),
      heapUsed: toMb(mem.heapUsed),
      heapTotal: toMb(mem.heapTotal),
      external: toMb(mem.external),
      arrayBuffers: toMb(mem.arrayBuffers),
      // V8 堆上限：打包版由 build-exe.ps1 的 max-old-space-size 决定
      heapLimit: toMb(heapLimitBytes),
    },
    // 堆占用比越接近 1 越危险；超过 ~0.8 就应视为「该重启/该降并发」的信号
    heapUsedRatio: Number((mem.heapUsed / heapLimitBytes).toFixed(3)),
    resources: countActiveResources(),
    sampledAt: new Date().toISOString(),
  };
}

// 注册统计路由。
//   GET /api/stats   返回仪表盘汇总数据（页数、目录分布、最近编译记录）
// 纯确定性聚合，不调 LLM。
// § link graph 缓存已下沉到 VaultService.buildLinkGraph，此处不再独立缓存。
//   /api/graph 与 /api/stats 共享同一份缓存，避免双倍重算。
// § 只读 GET 限流 300 req/min（P1-4）：Dashboard 一次刷新触发 graph+stats+files 多请求，
//   全局 60/min 易触发 429 影响监控体验

export function registerStatsRoute(app: FastifyInstance, vault: VaultService) {
  app.get('/api/stats', { config: { rateLimit: { max: 300, timeWindow: '1 minute' } } }, async (_request: FastifyRequest, reply: FastifyReply) => {
    try {
      const graph = await vault.buildLinkGraph();
      const vaultPath = vault.getVaultPath();

      // 按目录统计页数：Promise.all 并行 readdir，避免串行 IO 等待
      const pageDirs = PAGE_DIRS;
      const dirCounts: Record<string, number> = {};
      const dirResults = await Promise.all(
        pageDirs.map(async (d) => {
          const dirFull = path.join(vaultPath, d);
          try {
            const entries = await fs.readdir(dirFull);
            return [d, entries.filter((f) => isPageFile(f)).length] as const;
          } catch {
            return [d, 0] as const;
          }
        }),
      );
      for (const [d, count] of dirResults) {
        dirCounts[d] = count;
      }

      // 读取 log.md 末尾若干行作为最近编译记录（简单实现，不解析完整结构）
      let recentLog = '';
      try {
        const logContent = await vault.readFile('log.md');
        // 取最后 500 字符作为最近记录摘要
        recentLog = logContent.slice(-500);
      } catch {
        // log.md 可能还未创建
      }

      reply.send({
        totalPages: graph.nodes.length,
        totalLinks: graph.edges.length,
        dirCounts,
        recentLog,
        process: collectRuntimeMetrics(),
        caches: getDerivedCacheStats(),
        searchIndex: getIndexSyncInfo(),
      });
    } catch (err: unknown) {
      return void reply.code(500).send({
        error: err instanceof Error ? err.message : String(err),
      });
    }
  });
}
