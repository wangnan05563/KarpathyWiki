// T04571：同批共享 Key 端点补鉴权守卫（T04537 普查遗留）。
// 背景：/api/tags/suggest 与 /api/prompts/test-run 都消耗服务端共享 LLM Key，
//   但此前只有 rateLimit、没有 preHandler，匿名请求即可白烧配额；
//   且两处注册函数都不收 guards，默认 createIsolationGuards() 的 enabled=false 会让守卫空转。
// 本锁四件事（每个端点都覆盖）：
//   A 无凭据 → 401，且不进入业务分支（不允许匿名消耗共享 Key）
//   B 档位正确：tags/suggest = requireAuth（普通用户放行）；prompts/test-run = requireAdmin（普通用户 403）
//   C 管理员放行到业务分支（用非法请求体的 400 当哨兵，零 LLM 消耗、零文件写入）
//   D auth 关闭（单租户）→ 无 token 也放行，部署形态零变化
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import Fastify, { type FastifyInstance } from 'fastify';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import type { VaultService } from '../src/vault/vault-service.js';
import type { AppConfig, EngineAdapter } from '../src/types.js';
import { createIsolationGuards, setupAuthMiddleware } from '../src/middleware/auth.js';
import { registerTagsRoute } from '../src/routes/tags.js';
import { registerPromptsRoute } from '../src/routes/prompts.js';
import { createSession, clearAllSessions } from '../src/auth/session.js';
import { clearPermissionCache } from '../src/auth/permission-cache.js';
import { initAuditLog, resetAuditLog, flushAuditLog } from '../src/auth/audit-log.js';

const SECRET = 't04571-guard-secret-16chars';
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
  // 两个哨兵都用「非法请求体」：守卫放行后 handler 首行返回 400，永远走不到 LLM / 写文件
  registerTagsRoute(app, {} as VaultService, {} as AppConfig, guards);
  registerPromptsRoute(app, {} as EngineAdapter, guards, undefined);
  return app;
}

describe('T04571 · 共享 Key 端点鉴权守卫', () => {
  let tempDir = '';
  let app: FastifyInstance | null = null;

  beforeEach(async () => {
    tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 't04571-guard-'));
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

  it('POST /api/tags/suggest：无凭据 → 401，文案与其余受限接口一致', async () => {
    app = await buildApp({ authEnabled: true });
    const res = await app.inject({ method: 'POST', url: '/api/tags/suggest', payload: {} });
    expect(res.statusCode).toBe(401);
    expect(res.json().error).toBe(SESSION_EXPIRED_TEXT);
    expect(res.json().code).toBe('UNAUTHORIZED');
  });

  it('POST /api/tags/suggest：普通登录用户放行（档位 requireAuth），业务哨兵 400', async () => {
    app = await buildApp({ authEnabled: true });
    const session = createSession({ userId: 'u-normal', username: 'bob', role: 'user', secret: SECRET });
    const res = await app.inject({
      method: 'POST',
      url: '/api/tags/suggest',
      headers: { authorization: `Bearer ${session.token}` },
      payload: {},
    });
    expect(res.statusCode).toBe(400);
    expect(res.json().error).toContain('Invalid path');
  });

  it('POST /api/prompts/test-run：无凭据 → 401（匿名不得触发 prompt 覆写 + compile）', async () => {
    app = await buildApp({ authEnabled: true });
    const res = await app.inject({ method: 'POST', url: '/api/prompts/test-run', payload: {} });
    expect(res.statusCode).toBe(401);
    expect(res.json().error).toBe(SESSION_EXPIRED_TEXT);
  });

  it('POST /api/prompts/test-run：普通用户 → 403「权限不足」，与未登录严格区分', async () => {
    app = await buildApp({ authEnabled: true });
    const session = createSession({ userId: 'u-normal', username: 'bob', role: 'user', secret: SECRET });
    const res = await app.inject({
      method: 'POST',
      url: '/api/prompts/test-run',
      headers: { authorization: `Bearer ${session.token}` },
      payload: {},
    });
    expect(res.statusCode).toBe(403);
    expect(res.json().error).toBe('权限不足');
    expect(res.body).not.toContain(SESSION_EXPIRED_TEXT);
  });

  it('POST /api/prompts/test-run：管理员放行到业务校验，非法请求体 400', async () => {
    app = await buildApp({ authEnabled: true });
    const session = createSession({ userId: 'u-admin', username: 'root', role: 'admin', secret: SECRET });
    const res = await app.inject({
      method: 'POST',
      url: '/api/prompts/test-run',
      headers: { authorization: `Bearer ${session.token}` },
      payload: {},
    });
    expect(res.statusCode).toBe(400);
    expect(res.json().error).toContain('promptName');
  });

  it('auth 关闭（单租户）→ 两端点无 token 均放行，形态零变化', async () => {
    app = await buildApp({ authEnabled: false });
    const tags = await app.inject({ method: 'POST', url: '/api/tags/suggest', payload: {} });
    const prompts = await app.inject({ method: 'POST', url: '/api/prompts/test-run', payload: {} });
    expect(tags.statusCode).toBe(400);
    expect(tags.json().error).toContain('Invalid path');
    expect(prompts.statusCode).toBe(400);
    expect(prompts.json().error).toContain('promptName');
  });
});
