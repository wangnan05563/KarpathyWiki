import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import Fastify, { type FastifyInstance } from 'fastify';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import type { VaultService } from '../src/vault/vault-service.js';
import { createIsolationGuards, setupAuthMiddleware } from '../src/middleware/auth.js';
import { registerSearchRoute } from '../src/routes/search.js';
import { createSession, clearAllSessions } from '../src/auth/session.js';
import { clearPermissionCache } from '../src/auth/permission-cache.js';
import { closeIndexDb } from '../src/search/sqlite-index.js';
import { initAuditLog, resetAuditLog, flushAuditLog } from '../src/auth/audit-log.js';

// T04531：POST /api/search/rebuild 的 401 到底是谁发的 —— 服务端判定行为锁。
//
// 现场报障是「用户已登录，点建索引却提示『索引重建失败：未登录或会话已过期』」。
// 该文案逐字来自后端 requireAdmin 的 401 响应体，前端 apiErrorMessage 原样透出，
// 所以「会话过期」四个字既可能是真实失效，也可能是前端根本没带 token。
// 本锁把两种情形钉死，防止以后只改前端文案掩盖真因，也防止有人反过来放松守卫：
//   ① 不带凭据 → 401 且文案就是报障文案（证明根因在客户端未携带 Bearer）；
//   ② 带合法 token → 绝不出现该文案（守卫放行，走到业务分支）；
//   ③ 非管理员带 token → 403「权限不足」，与「未登录」严格区分（前端必须分别透出）；
//   ④ auth 关闭（单租户部署）→ 无 token 也放行，保持既有形态。
// 业务分支用 dataDir=undefined 的「索引功能未启用」400 当哨兵：守卫放行后必然命中它，
// 零 embedding 消耗、零 vault 写入，可在 CI 直接断言。

const SECRET = 't04531-rebuild-guard-secret-16ch';
const SESSION_EXPIRED_TEXT = '未登录或会话已过期';

async function buildApp(opts: { authEnabled: boolean }): Promise<FastifyInstance> {
  const app = Fastify({ logger: false });
  setupAuthMiddleware(app, {
    enabled: opts.authEnabled,
    sessionSecret: SECRET,
    permissionCacheTtlMs: 300000,
    publicPaths: [],
  });
  const guards = createIsolationGuards({ enabled: opts.authEnabled, permissionCacheTtlSec: 300 });
  // vault 仅在真正检索时被消费；本用例只打 rebuild，守卫拒绝或 dataDir 缺失都会提前返回
  registerSearchRoute(app, {} as unknown as VaultService, undefined, guards);
  return app;
}

describe('POST /api/search/rebuild 鉴权判定（T04531）', () => {
  let tempDir = '';
  let app: FastifyInstance | null = null;

  beforeEach(async () => {
    tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'wiki-rebuild-guard-'));
    clearAllSessions();
    clearPermissionCache();
    resetAuditLog();
    await initAuditLog(path.join(tempDir, 'audit.log'));
  });

  afterEach(async () => {
    if (app) {
      await app.close();
      app = null;
    }
    clearAllSessions();
    clearPermissionCache();
    await flushAuditLog();
    resetAuditLog();
    await fs.rm(tempDir, { recursive: true, force: true });
  });

  it('不带凭据 → 401 且文案正是报障文案（根因：前端未携带 Bearer，而非会话真的过期）', async () => {
    app = await buildApp({ authEnabled: true });
    const res = await app.inject({ method: 'POST', url: '/api/search/rebuild', payload: {} });
    expect(res.statusCode).toBe(401);
    expect(res.json().error).toBe(SESSION_EXPIRED_TEXT);
    expect(res.json().code).toBe('UNAUTHORIZED');
  });

  it('伪造 token 同样 401（不得凭残缺凭据放行）', async () => {
    app = await buildApp({ authEnabled: true });
    const res = await app.inject({
      method: 'POST',
      url: '/api/search/rebuild',
      headers: { authorization: 'Bearer forged.token.value' },
      payload: {},
    });
    expect(res.statusCode).toBe(401);
  });

  it('管理员带 token → 守卫放行，绝不出现「未登录或会话已过期」', async () => {
    app = await buildApp({ authEnabled: true });
    const session = createSession({ userId: 'u-admin', username: 'root', role: 'admin', secret: SECRET });
    const res = await app.inject({
      method: 'POST',
      url: '/api/search/rebuild',
      headers: { authorization: `Bearer ${session.token}` },
      payload: {},
    });
    expect(res.statusCode).not.toBe(401);
    expect(res.body).not.toContain(SESSION_EXPIRED_TEXT);
    // dataDir 未注入 → 业务分支的 400 哨兵，反证 handler 已执行
    expect(res.statusCode).toBe(400);
    expect(res.json().error).toContain('索引功能未启用');
  });

  it('普通登录用户 → 403「权限不足」，与未登录严格区分（前端不得把 403 说成会话过期）', async () => {
    app = await buildApp({ authEnabled: true });
    const session = createSession({ userId: 'u-normal', username: 'bob', role: 'user', secret: SECRET });
    const res = await app.inject({
      method: 'POST',
      url: '/api/search/rebuild',
      headers: { authorization: `Bearer ${session.token}` },
      payload: {},
    });
    expect(res.statusCode).toBe(403);
    expect(res.json().error).toBe('权限不足');
    expect(res.body).not.toContain(SESSION_EXPIRED_TEXT);
  });

  it('游客 token → 403（重建是写操作，游客档不放行）', async () => {
    app = await buildApp({ authEnabled: true });
    const session = createSession({ userId: 'u-guest', username: 'guester', role: 'guest', secret: SECRET });
    const res = await app.inject({
      method: 'POST',
      url: '/api/search/rebuild',
      headers: { authorization: `Bearer ${session.token}` },
      payload: {},
    });
    expect(res.statusCode).toBe(403);
  });

  it('auth 关闭（单租户本地部署）→ 无 token 也放行到业务分支，形态零变化', async () => {
    app = await buildApp({ authEnabled: false });
    const res = await app.inject({ method: 'POST', url: '/api/search/rebuild', payload: {} });
    expect(res.statusCode).toBe(400);
    expect(res.json().error).toContain('索引功能未启用');
  });

  it('读端点 /api/search/status 不受影响（修 rebuild 不能顺手把公开状态查询锁死）', async () => {
    app = await buildApp({ authEnabled: true });
    const res = await app.inject({ method: 'GET', url: '/api/search/status' });
    expect(res.statusCode).toBe(200);
    expect(res.json().enabled).toBe(false);
  });
});

// ── 验收条款「修复后需确保正常登录用户可成功触发索引重建」的端到端腿 ──────────────
// 上面用 dataDir=undefined 只证明「守卫放行、handler 开始执行」，证明不了重建真的做完。
// 本腿注入真实 dataDir + 三页小 vault，跑完 rebuild 再查一次关键词，断言页面确实可检。
// 零配额：请求体不带 embedding.apiKey → indexPage 在切分后即返回，不碰 embedding 服务
// （hybrid-search.ts:121 `if (!embedding?.apiKey) return`），因此可安全进 CI。
describe('POST /api/search/rebuild 端到端可做（T04531 验收条款）', () => {
  let tempRoot = '';
  let dataDir = '';
  let app: FastifyInstance | null = null;

  beforeEach(async () => {
    tempRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'wiki-rebuild-e2e-'));
    dataDir = path.join(tempRoot, 'data');
    const vaultPath = path.join(tempRoot, 'vault');
    await fs.mkdir(path.join(vaultPath, 'concepts'), { recursive: true });
    await Promise.all([
      fs.writeFile(path.join(vaultPath, 'concepts', 'a.md'), '# 甲\n可检出关键词 t04531needlealpha\n', 'utf8'),
      fs.writeFile(path.join(vaultPath, 'concepts', 'b.md'), '# 乙\n另一页 t04531needlebeta\n', 'utf8'),
      fs.writeFile(path.join(vaultPath, 'concepts', 'c.md'), '# 丙\n第三页 t04531needlegamma\n', 'utf8'),
    ]);
    clearAllSessions();
    clearPermissionCache();
    resetAuditLog();
    await initAuditLog(path.join(tempRoot, 'audit.log'));

    const vault = {
      getVaultPath: () => vaultPath,
      readFile: (rel: string) => fs.readFile(path.join(vaultPath, rel), 'utf8'),
      // 后台增量同步依赖版本签名；这里故意不提供，走「同步失败回退全库扫描」的既有容错
    } as unknown as VaultService;

    app = Fastify({ logger: false });
    setupAuthMiddleware(app, { enabled: true, sessionSecret: SECRET, permissionCacheTtlMs: 300000, publicPaths: [] });
    const guards = createIsolationGuards({ enabled: true, permissionCacheTtlSec: 300 });
    registerSearchRoute(app, vault, dataDir, guards);
  });

  afterEach(async () => {
    if (app) {
      await app.close();
      app = null;
    }
    clearAllSessions();
    clearPermissionCache();
    await flushAuditLog();
    resetAuditLog();
    closeIndexDb();
    await fs.rm(tempRoot, { recursive: true, force: true });
  });

  // 无 embedding key 的重建（BYOK 未配置，与本锁的零配额约束一致）：
  // indexPage 只做「切分入库」就返回，向量从未写入，所以 index_status 全部停在 'pending'。
  // 因此 indexedPages 为 0 是设计结果而非失败——断言按这个口径写，
  // 「成功触发」的真相是 chunk 入库 + 关键词立刻可检（设置页那句「向量覆盖 0/3 页」同理）。
  it('管理员 token 触发重建 → 200 且三页确实入库、关键词可检', async () => {
    const session = createSession({ userId: 'u-admin', username: 'root', role: 'admin', secret: SECRET });
    const res = await app!.inject({
      method: 'POST',
      url: '/api/search/rebuild',
      headers: { authorization: `Bearer ${session.token}` },
      payload: {},
    });
    expect(res.statusCode).toBe(200);
    expect(res.body).not.toContain(SESSION_EXPIRED_TEXT);
    const status = res.json().status as { indexedPages: number; pendingPages: number; totalChunks: number };
    expect(status.totalChunks).toBeGreaterThanOrEqual(3);
    expect(status.pendingPages).toBe(3);
    expect(status.indexedPages).toBe(0);

    // 重建完必须真的可用于检索，否则「成功触发」只是 200 空壳
    const hit = await app!.inject({ method: 'GET', url: '/api/search?q=t04531needlealpha' });
    expect(hit.statusCode).toBe(200);
    const hits = hit.json().hits as Array<{ path?: string; title?: string }>;
    expect(JSON.stringify(hits)).toContain('a.md');
    expect(JSON.stringify(hits)).not.toContain('b.md');
  });
});
