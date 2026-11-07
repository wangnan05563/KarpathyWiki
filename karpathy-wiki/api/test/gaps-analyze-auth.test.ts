import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import Fastify, { type FastifyInstance } from 'fastify';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { VaultService } from '../src/vault/vault-service.js';
import { createIsolationGuards, setupAuthMiddleware } from '../src/middleware/auth.js';
import { registerGapsRoute } from '../src/routes/gaps.js';
import { createSession, clearAllSessions } from '../src/auth/session.js';
import { clearPermissionCache } from '../src/auth/permission-cache.js';
import type { AppConfig } from '../src/types.js';

// T04537：POST /api/graph/gaps/analyze 的鉴权判定锁。
//
// 该端点内部用 getEffectiveApiKey(config) 调 LLM —— 无凭据调用者能让服务端共享 Key 花钱。
// 本锁钉死三档：无凭据 401、普通登录用户放行、管理员放行；另锁 auth 关闭（单租户）仍放行。
// 业务分支用「空 vault → insufficient-data 200」当哨兵：守卫放行后 handler 必然走到该分支，
// 零 LLM 消耗、零写盘，可在 CI 直接断言（analyze 在 insufficient-data 时提前返回、连 Key 都不读）。

const SECRET = 't04537-gaps-guard-secret-16chars';
const SESSION_EXPIRED_TEXT = '未登录或会话已过期';

let tempDir = '';
let vaultDir = '';
let app: FastifyInstance | null = null;

async function buildApp(authEnabled: boolean): Promise<FastifyInstance> {
  const instance = Fastify({ logger: false });
  setupAuthMiddleware(instance, {
    enabled: authEnabled,
    sessionSecret: SECRET,
    permissionCacheTtlMs: 300000,
    publicPaths: [],
  });
  const guards = createIsolationGuards({ enabled: authEnabled, permissionCacheTtlSec: 300 });
  const vault = new VaultService(vaultDir);
  await vault.init();
  // graph.minPages=20 + 空 vault ⇒ pageCount=0 ⇒ 200 insufficient-data（哨兵分支）
  const config = { graph: { minPages: 20 }, llm: {} } as unknown as AppConfig;
  registerGapsRoute(instance, vault, config, guards);
  await instance.ready();
  return instance;
}

function bearerFor(role: 'user' | 'admin'): string {
  return createSession({ userId: `u-${role}`, username: role, role, secret: SECRET }).token;
}

describe('POST /api/graph/gaps/analyze 鉴权判定（T04537）', () => {
  beforeEach(async () => {
    tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'wiki-gaps-auth-'));
    vaultDir = path.join(tempDir, 'vault');
    await fs.mkdir(vaultDir, { recursive: true });
    clearAllSessions();
    clearPermissionCache();
  });

  afterEach(async () => {
    if (app) {
      await app.close();
      app = null;
    }
    clearAllSessions();
    clearPermissionCache();
    await fs.rm(tempDir, { recursive: true, force: true });
  });

  it('不带凭据 → 401（匿名不得消耗服务端共享 LLM Key）', async () => {
    app = await buildApp(true);
    const res = await app.inject({ method: 'POST', url: '/api/graph/gaps/analyze', payload: {} });
    expect(res.statusCode).toBe(401);
    expect(res.json().error).toBe(SESSION_EXPIRED_TEXT);
    expect(res.json().code).toBe('UNAUTHORIZED');
  });

  it('伪造 token → 401（残缺凭据不得放行）', async () => {
    app = await buildApp(true);
    const res = await app.inject({
      method: 'POST',
      url: '/api/graph/gaps/analyze',
      headers: { authorization: 'Bearer forged.token.value' },
      payload: {},
    });
    expect(res.statusCode).toBe(401);
  });

  it('普通登录用户 → 守卫放行，走到业务哨兵（insufficient-data）', async () => {
    app = await buildApp(true);
    const res = await app.inject({
      method: 'POST',
      url: '/api/graph/gaps/analyze',
      headers: { authorization: `Bearer ${bearerFor('user')}` },
      payload: {},
    });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ status: 'insufficient-data', pageCount: 0 });
  });

  it('管理员 → 守卫放行，走到业务哨兵（证明 requireAuth 而非更严档位）', async () => {
    app = await buildApp(true);
    const res = await app.inject({
      method: 'POST',
      url: '/api/graph/gaps/analyze',
      headers: { authorization: `Bearer ${bearerFor('admin')}` },
      payload: {},
    });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ status: 'insufficient-data', pageCount: 0 });
  });

  it('auth 关闭（单租户部署）→ 无 token 也放行，保持既有形态', async () => {
    app = await buildApp(false);
    const res = await app.inject({ method: 'POST', url: '/api/graph/gaps/analyze', payload: {} });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ status: 'insufficient-data', pageCount: 0 });
  });
});
