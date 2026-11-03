import type { FastifyInstance, FastifyRequest, FastifyReply } from 'fastify';
import type { VaultService } from '../vault/vault-service.js';
import type { WebSearchConfig } from '../types.js';
import type { IsolationGuards } from '../middleware/auth.js';
import { searchPages } from '../search-util.js';
import { createWebSearchTool } from '../tools/web-search.js';
// FR-20 语义搜索：混合检索（FTS5 关键词 + BYOK 向量语义双路 RRF）与索引管理
import { hybridSearch, rebuildIndex, listVaultPages, indexPage, getIndexCoverage, type IndexCoverage } from '../search/hybrid-search.js';
import { getIndexDb, getIndexStatus } from '../search/sqlite-index.js';
// O1：/api/search 优先走 FTS5 索引（自动增量同步），不可用时回退 searchPages
import { ensureIndexSynced, getIndexSyncInfo, searchPagesIndexed } from '../search/indexed-search.js';
// O7：缓存命中率/重算耗时随索引状态一并暴露，便于定位「为什么某个接口忽快忽慢」
import { getDerivedCacheStats } from '../utils/derived-cache.js';

// 注册全文检索路由。
//   GET /api/search?q=关键词&source=&status=&type=  全文检索 + frontmatter 过滤
//   POST /api/search/hybrid { query, embedding? }   FR-20 混合检索（BYOK embedding 随请求携带）
//   POST /api/search/rebuild { embedding? }          重建索引（设置页入口，显示已索引/待补）
//   GET  /api/search/status                          索引状态统计（?model=<向量模型> 另给旧模型待补页数）
//
// source/status/type 按页面 frontmatter 字段过滤（AC-10 / FR-15-3），可与 q 组合使用。
// 当仅提供 source/status/type 而无 q 时，返回所有匹配过滤条件的页面。
//
// T04073：索引未启用（无数据目录）时的覆盖统计零值——与启用分支同一批字段名，
// 前端只需看 enabled 决定渲不渲染，不必再区分两种响应形状。
const EMPTY_COVERAGE: IndexCoverage = {
  totalPages: 0,
  coveredPages: 0,
  pendingPages: 0,
  failedPages: 0,
  unindexedPages: 0,
  staleModelPages: null,
};
//
// 安全（T01771 复核修复）：guards 未传（旧形态）或 auth 关闭（单租户）时行为零变化；
// auth 启用时——chunks 是引用溯源数据源，匿名可读即泄露 vault 页面原文，要求登录；
// rebuild/reindex-page 是触发 embedding 消耗的写操作，要求管理员（与 PUT /api/files 同档）。
export function registerSearchRoute(app: FastifyInstance, vault: VaultService, dataDir?: string, guards?: IsolationGuards) {
  // O1：启动后在后台建库/增量同步，首次搜索无需承担全量索引耗时
  if (dataDir) void ensureIndexSynced(dataDir, vault).catch(() => { /* 同步失败时搜索回退全库扫描 */ });

  app.get('/api/search', { config: { rateLimit: { max: 300, timeWindow: '1 minute' } } }, async (request: FastifyRequest, reply: FastifyReply) => {
    const query = request.query as { q?: string; source?: string; status?: string; type?: string };
    const hasFilter = query.source || query.status || query.type;
    if (!query.q?.trim() && !hasFilter) {
      return void reply.code(400).send({ error: '缺少 q 参数或过滤条件（source/status/type）' });
    }

    try {
      // O1：有关键词时优先走 FTS5 索引（毫秒级）；纯过滤或索引异常回退全库扫描
      const indexed = dataDir
        ? await searchPagesIndexed(dataDir, vault, query.q || '', 20, {
          source: query.source,
          status: query.status,
          type: query.type,
        }).catch(() => null)
        : null;
      const hits = indexed ?? await searchPages(vault, query.q || '', 20, {
        source: query.source,
        status: query.status,
        type: query.type,
      });
      // T04073：本端点只做关键词召回，但必须如实回传 semanticEnabled=false——
      // 前端用同一字段判定「检索模式」，缺字段会让搜索页把关键词结果显示成语义已启用。
      reply.send({ hits, total: hits.length, semanticEnabled: false });
    } catch (err: unknown) {
      return void reply.code(500).send({
        error: err instanceof Error ? err.message : String(err),
      });
    }
  });

  // ── FR-20 混合检索 ──
  // embedding 配置随请求携带（BYOK，与 llmConfig 同模式，密钥不落盘）；
  // 未配置时仅关键词路生效且无报错、无回落（CODING-BYOK 语义）。
  // dataDir 未注入（旧部署形态）时保持原 searchPages 行为零破坏。
  app.post('/api/search/hybrid', async (request: FastifyRequest, reply: FastifyReply) => {
    const body = request.body as {
      query?: string;
      limit?: number;
      embedding?: { baseUrl: string; apiKey: string; model: string };
    } | null;
    if (!body?.query?.trim()) {
      return void reply.code(400).send({ error: '请求体须含 query 字段' });
    }
    if (!dataDir) {
      // 无 SQLite 数据目录（理论不发生，防御降级）：回退关键词全文搜索
      const hits = await searchPages(vault, body.query, 20);
      return reply.send({ hits, total: hits.length, semanticEnabled: false });
    }
    try {
      const result = await hybridSearch(dataDir, vault, {
        query: body.query,
        limit: body.limit ?? 10,
        embedding: body.embedding?.apiKey ? body.embedding : undefined,
      });
      reply.send({ ...result, total: result.hits.length });
    } catch (err: unknown) {
      return void reply.code(500).send({
        error: err instanceof Error ? err.message : String(err),
      });
    }
  });

  // ── FR-20 索引重建（设置页入口）：清空后逐页切分 + embedding，返回已索引/待补统计 ──
  app.post('/api/search/rebuild', { preHandler: guards?.requireAdmin }, async (request: FastifyRequest, reply: FastifyReply) => {
    if (!dataDir) {
      return void reply.code(400).send({ error: '索引功能未启用（缺少数据目录配置）' });
    }
    const body = request.body as { embedding?: { baseUrl: string; apiKey: string; model: string } } | null;
    try {
      // 重建前先全量切分（关键词路立即可用），embedding 按 key 可用性补算
      const status = await rebuildIndex(dataDir, vault, body?.embedding?.apiKey ? body.embedding : undefined);
      reply.send({ status });
    } catch (err: unknown) {
      return void reply.code(500).send({
        error: err instanceof Error ? err.message : String(err),
      });
    }
  });

  // ── FR-20 索引状态（设置页展示：向量覆盖 N/M 页 + 待补/未索引来源区分）──
  // model 由前端按当前 embedding 配置携带（非密钥，仅用于判定「旧模型向量待补」）；缺省时该字段为 null。
  app.get('/api/search/status', async (request: FastifyRequest, reply: FastifyReply) => {
    if (!dataDir) {
      // 与启用分支同一批字段名（含 sync/caches）：前端只按 enabled 决定渲不渲染，不必再分辨两种响应形状
      return reply.send({ enabled: false, totalChunks: 0, ...EMPTY_COVERAGE, sync: getIndexSyncInfo(), caches: getDerivedCacheStats() });
    }
    const model = (request.query as { model?: string }).model?.trim();
    const coverage = await getIndexCoverage(dataDir, vault, model || undefined);
    reply.send({
      enabled: true,
      totalChunks: getIndexStatus(dataDir).totalChunks,
      ...coverage,
      sync: getIndexSyncInfo(),
      caches: getDerivedCacheStats(),
    });
  });

  // ── FR-21 引用溯源：读取某页面的全部 chunk（浮层展示 chunk 原文 + 定位）──
  // 槽位坐标（页面路径）来自 refs；chunk 内容从 SQLite 索引读取，未索引页面返回空
  app.get('/api/search/chunks', { preHandler: guards?.requireAuth }, async (request: FastifyRequest, reply: FastifyReply) => {
    if (!dataDir) {
      return reply.send({ chunks: [] });
    }
    const q = request.query as { path?: string };
    const rel = q.path;
    if (!rel || rel.includes('..')) {
      return void reply.code(400).send({ error: '缺少合法 path 参数' });
    }
    try {
      const d = getIndexDb(dataDir);
      const rows = d.prepare('SELECT chunk_index, content, heading FROM chunks WHERE page_path = ? ORDER BY chunk_index')
        .all(rel) as Array<{ chunk_index: number; content: string; heading: string | null }>;
      reply.send({ path: rel, chunks: rows.map((r) => ({ index: r.chunk_index, content: r.content, heading: r.heading })) });
    } catch (err: unknown) {
      return void reply.code(500).send({
        error: err instanceof Error ? err.message : String(err),
      });
    }
  });

  // ── FR-20 单页重索引（chokidar 变更钩子复用；也供单页修复）──
  app.post('/api/search/reindex-page', { preHandler: guards?.requireAdmin }, async (request: FastifyRequest, reply: FastifyReply) => {
    if (!dataDir) {
      return void reply.code(400).send({ error: '索引功能未启用（缺少数据目录配置）' });
    }
    const body = request.body as { path?: string; embedding?: { baseUrl: string; apiKey: string; model: string } } | null;
    const rel = body?.path;
    if (!rel || rel.includes('..')) {
      return void reply.code(400).send({ error: '请求体须含合法 path 字段' });
    }
    const pages = await listVaultPages(vault);
    if (!pages.includes(rel)) {
      return void reply.code(404).send({ error: `页面不存在: ${rel}` });
    }
    try {
      await indexPage(dataDir, vault, rel, body?.embedding?.apiKey ? body.embedding : undefined);
      reply.send({ ok: true, status: getIndexStatus(dataDir) });
    } catch (err: unknown) {
      return void reply.code(500).send({
        error: err instanceof Error ? err.message : String(err),
      });
    }
  });
}

// §5.2 注册联网搜索路由。
//   POST /api/search/web  { query, limit? }
// 为什么独立路由：query workflow 内的 web_search 是工具调用（LLM 决策），
// 此路由供前端直接调用展示搜索结果（用户主动触发），两条链路共用 createWebSearchTool 工厂。
export function registerWebSearchRoute(app: FastifyInstance, config?: WebSearchConfig) {
  app.post('/api/search/web', async (request: FastifyRequest, reply: FastifyReply) => {
    const body = request.body as { query?: string; limit?: number };
    if (typeof body?.query !== 'string') {
      return void reply.code(400).send({ error: '请求体须含 query 字段' });
    }
    if (!config) {
      return void reply.code(400).send({ error: '搜索功能未配置' });
    }

    // 复用 workflow 工厂：保证路由直调与工具调用行为一致
    const tool = createWebSearchTool(config);
    if (!tool) {
      return void reply.code(400).send({ error: '搜索 API Key 未配置' });
    }

    try {
      const results = await tool.handler({ query: body.query, limit: body.limit });
      reply.send({ results, total: results.length });
    } catch (err: unknown) {
      return void reply.code(500).send({
        error: err instanceof Error ? err.message : String(err),
      });
    }
  });
}
