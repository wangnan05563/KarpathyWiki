// T04578：prompts PUT 与 tags confirm/pending 补鉴权守卫（T04537 普查遗留，T04571 同批未覆盖面）。
// 裁决口径（用户确认「全部需登录」）：
//   PUT /api/prompts/:name  = requireAdmin（覆写 prompts/*.md，错误配置可瘫痪编译链，仅管理员）
//   PUT /api/tags/confirm   = requireAuth（写页面 frontmatter tags，登录用户即可）
//   GET /api/tags/pending   = requireAuth（列出全库待审核页含路径/标签，登录可读）
// 与 T04571 同模式：路由签名必传 guards、index.ts 传 isolationGuards（已接线，无需改 index），
// 禁止默认 enabled=false 空转。本锁每个端点覆盖三档 + 单租户负控制：
//   A 无凭据 → 401，且不进业务分支
//   B 档位正确：prompts PUT 普通用户 403；tags 两端点普通用户放行（requireAuth 而非 requireAdmin）
//   C 管理员/登录用户放行到业务哨兵（非法请求体 400 / 白名单 400 / 空列表 200，零 LLM、零写盘）
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

const SECRET = 't04578-guard-secret-16chars';
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
  // tags/pending 放行后会调 listPendingTagPages → vault.listPendingTagPages()；给空列表桩，
  // 让「登录用户放行」拿到干净 200 哨兵。confirm/prompts 的哨兵都在调 vault/写盘前返回 400。
  const vaultStub = { listPendingTagPages: async () => [] } as unknown as VaultService;
  registerTagsRoute(app, vaultStub, {} as AppConfig, guards);
  registerPromptsRoute(app, {} as EngineAdapter, guards, undefined);
  return app;
}

function bearer(token: string): { authorization: string } {
  return { authorization: `Bearer ${token}` };
}

describe('T04578 · prompts/tags 写读端点鉴权守卫', () => {
  let tempDir = '';
  let app: FastifyInstance | null = null;

  beforeEach(async () => {
    tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 't04578-guard-'));
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

  // ── PUT /api/prompts/:name（requireAdmin）──────────────────────────────
  it('PUT /api/prompts/:name：无凭据 → 401（匿名不得覆写 prompt）', async () => {
    app = await buildApp({ authEnabled: true });
    // 非白名单名：即便守卫被撤，handler 首行 400 返回，探针红腿不会真写 prompt 文件
    const res = await app.inject({ method: 'PUT', url: '/api/prompts/nope.md', payload: {} });
    expect(res.statusCode).toBe(401);
    expect(res.json().error).toBe(SESSION_EXPIRED_TEXT);
    expect(res.json().code).toBe('UNAUTHORIZED');
  });

  it('PUT /api/prompts/:name：普通用户 → 403「权限不足」（档位 requireAdmin，与未登录严格区分）', async () => {
    app = await buildApp({ authEnabled: true });
    const session = createSession({ userId: 'u-normal', username: 'bob', role: 'user', secret: SECRET });
    const res = await app.inject({
      method: 'PUT', url: '/api/prompts/nope.md', headers: bearer(session.token), payload: {},
    });
    expect(res.statusCode).toBe(403);
    expect(res.json().error).toBe('权限不足');
    expect(res.body).not.toContain(SESSION_EXPIRED_TEXT);
  });

  it('PUT /api/prompts/:name：管理员放行到业务校验，非白名单名 400（零写盘哨兵）', async () => {
    app = await buildApp({ authEnabled: true });
    const session = createSession({ userId: 'u-admin', username: 'root', role: 'admin', secret: SECRET });
    const res = await app.inject({
      // 非白名单名 → handler 首行 400，永远走不到 fs.writeFile
      method: 'PUT', url: '/api/prompts/nope.md', headers: bearer(session.token), payload: {},
    });
    expect(res.statusCode).toBe(400);
    expect(res.json().error).toContain('不允许的 prompt 文件名');
  });

  // ── PUT /api/tags/confirm（requireAuth）────────────────────────────────
  it('PUT /api/tags/confirm：无凭据 → 401（匿名不得写页面元数据）', async () => {
    app = await buildApp({ authEnabled: true });
    const res = await app.inject({ method: 'PUT', url: '/api/tags/confirm', payload: {} });
    expect(res.statusCode).toBe(401);
    expect(res.json().error).toBe(SESSION_EXPIRED_TEXT);
  });

  it('PUT /api/tags/confirm：普通登录用户放行（档位 requireAuth，非 requireAdmin），业务哨兵 400', async () => {
    app = await buildApp({ authEnabled: true });
    const session = createSession({ userId: 'u-normal', username: 'bob', role: 'user', secret: SECRET });
    const res = await app.inject({ method: 'PUT', url: '/api/tags/confirm', headers: bearer(session.token), payload: {} });
    // 与 prompts PUT 的 403 形成档位对照：requireAuth 放行普通用户到业务校验
    expect(res.statusCode).toBe(400);
    expect(res.json().error).toContain('Invalid path');
  });

  it('PUT /api/tags/confirm：管理员同样放行到业务哨兵 400', async () => {
    app = await buildApp({ authEnabled: true });
    const session = createSession({ userId: 'u-admin', username: 'root', role: 'admin', secret: SECRET });
    const res = await app.inject({ method: 'PUT', url: '/api/tags/confirm', headers: bearer(session.token), payload: {} });
    expect(res.statusCode).toBe(400);
    expect(res.json().error).toContain('Invalid path');
  });

  // ── GET /api/tags/pending（requireAuth）────────────────────────────────
  it('GET /api/tags/pending：无凭据 → 401（匿名不得读全库待审核路径）', async () => {
    app = await buildApp({ authEnabled: true });
    const res = await app.inject({ method: 'GET', url: '/api/tags/pending' });
    expect(res.statusCode).toBe(401);
    expect(res.json().error).toBe(SESSION_EXPIRED_TEXT);
  });

  it('GET /api/tags/pending：普通登录用户放行（requireAuth），空列表 200', async () => {
    app = await buildApp({ authEnabled: true });
    const session = createSession({ userId: 'u-normal', username: 'bob', role: 'user', secret: SECRET });
    const res = await app.inject({ method: 'GET', url: '/api/tags/pending', headers: bearer(session.token) });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ pages: [] });
  });

  // ── 单租户负控制：auth 关闭 → 三端点无 token 均放行，形态零变化 ──────────
  it('auth 关闭（单租户）→ 三端点无 token 均放行到业务，部署形态零变化', async () => {
    app = await buildApp({ authEnabled: false });
    const prompts = await app.inject({ method: 'PUT', url: '/api/prompts/nope.md', payload: {} });
    const confirm = await app.inject({ method: 'PUT', url: '/api/tags/confirm', payload: {} });
    const pending = await app.inject({ method: 'GET', url: '/api/tags/pending' });
    expect(prompts.statusCode).toBe(400);
    expect(prompts.json().error).toContain('不允许的 prompt 文件名');
    expect(confirm.statusCode).toBe(400);
    expect(confirm.json().error).toContain('Invalid path');
    expect(pending.statusCode).toBe(200);
    expect(pending.json()).toEqual({ pages: [] });
  });
});