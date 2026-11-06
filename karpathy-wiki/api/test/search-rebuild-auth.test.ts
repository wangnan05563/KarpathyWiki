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
