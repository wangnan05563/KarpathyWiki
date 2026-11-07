// T04534：关于页版本号恒为 0.1.0 + 检查更新从不查 GitHub。
// ------------------------------------------------------------------
// 三条根因各配一组用例，且每组都带负控制（证明用例真能抓住回归，不是恒绿）：
//   A 版本源：/api/about 与 check-update 的 current 必须来自 workspace 根 package.json，
//     不是 api/package.json。负控制＝断言两份清单的 version 确实不同（bump-version.ps1
//     只写根清单），否则本组用例会退化成"读哪份都绿"。
//   B 通道判定：enabled=false / 两地址都空 → 不发外网请求；manifestUrl 优先于 githubRepo；
//     githubRepo 受 owner/repo 形态白名单约束（穿越/绝对 URL/多段路径一律拒绝且不发出请求）。
//   C GitHub 映射：tag_name→latest、资产→download_url、published_at 透传；无资产回退 release 页；
//      newer/older/带 v 前缀三种版本关系分别判定；HTTP 失败回退 local-fallback 不草率报更新。
// 手法与 routes-tunnel.test.ts 一致：Fastify + inject，不 listen；fetch 全局桩；
//   每个用例 vi.resetModules() 重新 import，隔离 about.ts 的模块级 5 分钟缓存。
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import Fastify, { type FastifyInstance } from 'fastify';
import { getApiDir } from '../src/utils/runtime.js';
import type { AppConfig, UpdateConfig } from '../src/types.js';

const { execSyncMock } = vi.hoisted(() => ({ execSyncMock: vi.fn(() => 'abc1234\n') }));
vi.mock('node:child_process', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:child_process')>();
  return { ...actual, execSync: execSyncMock };
});

const fetchMock = vi.fn();
vi.stubGlobal('fetch', fetchMock);

const GITHUB_REPO = 'wangnan05563/KarpathyWiki';
const GITHUB_LATEST_URL = `https://api.github.com/repos/${GITHUB_REPO}/releases/latest`;
const ASSET_URL = `https://github.com/${GITHUB_REPO}/releases/download/0.1.202610301/KarpathyWiki-Setup-v0.1.202610301.exe`;
const RELEASE_HTML_URL = `https://github.com/${GITHUB_REPO}/releases/tag/0.1.202610301`;

// 权威版本源：与 about.ts 的 resolveVersionPackagePath 独立推导（读 pnpm-workspace.yaml 定位根），
// 避免"用被测代码自己的口径验证被测代码"。
function workspaceRoot(): string {
  let dir = getApiDir();
  for (let i = 0; i < 4; i++) {
    if (fs.existsSync(path.join(dir, 'pnpm-workspace.yaml'))) return dir;
    dir = path.resolve(dir, '..');
  }
  throw new Error('未找到 workspace 根（pnpm-workspace.yaml）');
}

const ROOT_PKG_VERSION = (JSON.parse(fs.readFileSync(path.join(workspaceRoot(), 'package.json'), 'utf8')) as { version: string }).version;
const API_PKG_VERSION = (JSON.parse(fs.readFileSync(path.join(getApiDir(), 'package.json'), 'utf8')) as { version: string }).version;

function jsonResponse(body: unknown, ok = true, status = 200): Response {
  return { ok, status, json: async () => body } as unknown as Response;
}

function githubRelease(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    tag_name: '0.1.202610301',
    // 真实响应里 name 是 release 标题（本项目＝安装包文件名），与 tag_name 不同：
    // 留着它才能证明"取错字段"这类映射缺陷会被用例抓住，而不是靠空串兜底蒙混过关。
    name: 'KarpathyWiki-Setup-v0.1.202610301.exe',
    html_url: RELEASE_HTML_URL,
    published_at: '2026-10-30T02:26:10Z',
    draft: false,
    prerelease: false,
    assets: [{ browser_download_url: ASSET_URL, name: 'KarpathyWiki-Setup-v0.1.202610301.exe' }],
    ...overrides,
  };
}

function cfg(update: UpdateConfig | undefined): AppConfig {
  return { update } as unknown as AppConfig;
}

let app: FastifyInstance | undefined;

async function buildApp(update: UpdateConfig | undefined): Promise<FastifyInstance> {
  // 模块级 checkUpdateCache 会跨用例串味：每个用例重新加载 about.ts 拿到干净缓存
  vi.resetModules();
  const { registerAboutRoute } = await import('../src/routes/about.js');
  const instance = Fastify();
  registerAboutRoute(instance, cfg(update));
  await instance.ready();
  return instance;
}

async function checkUpdate(instance: FastifyInstance): Promise<Record<string, unknown>> {
  const res = await instance.inject({ method: 'GET', url: '/api/about/check-update' });
  expect(res.statusCode).toBe(200);
  return res.json() as Record<string, unknown>;
}

beforeEach(() => {
  fetchMock.mockReset();
  execSyncMock.mockClear();
});

afterEach(async () => {
  if (app) {
    await app.close();
    app = undefined;
  }
});

describe('A · 版本号权威源是 workspace 根 package.json（T04534 根因一/二）', () => {
  it('负控制前提：根清单与 api 子包清单的 version 确实不同，否则本组用例无判别力', () => {
    // bump-version.ps1 只写根清单；api/package.json 停在初始 0.1.0。
    // 若哪天两者被同步成一样，这条会红，提示本组用例已失去判别力（需另造区分手段）。
    expect(ROOT_PKG_VERSION).not.toBe(API_PKG_VERSION);
    expect(API_PKG_VERSION).toBe('0.1.0');
  });

  it('/api/about 返回根清单版本号，不是 api/package.json 的 0.1.0', async () => {
    app = await buildApp(undefined);
    const res = await app.inject({ method: 'GET', url: '/api/about' });
    expect(res.statusCode).toBe(200);
    const body = res.json() as Record<string, unknown>;
    expect(body.version).toBe(ROOT_PKG_VERSION);
    expect(body.version).not.toBe(API_PKG_VERSION);
    expect(body.product).toBe('Karpathy Wiki');
  });

  it('check-update 的 current 同样取根清单；未配置通道时 latest 回落到 current', async () => {
    app = await buildApp(undefined);
    const data = await checkUpdate(app);
    expect(data.current).toBe(ROOT_PKG_VERSION);
    expect(data.latest).toBe(ROOT_PKG_VERSION);
    expect(data.source).toBe('local');
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('构建日期取权威清单的 mtime（与根清单一致，而非 api 子包）', async () => {
    app = await buildApp(undefined);
    const res = await app.inject({ method: 'GET', url: '/api/about' });
    const body = res.json() as Record<string, unknown>;
    const rootMtime = fs.statSync(path.join(workspaceRoot(), 'package.json')).mtime.toISOString().slice(0, 10);
    expect(body.build_date).toBe(rootMtime);
  });
});

describe('B · 通道判定与 SSRF 结构白名单', () => {
  it('enabled=false：即使两个地址都填了也不发外网请求', async () => {
    app = await buildApp({ enabled: false, manifestUrl: 'https://example.test/m.json', githubRepo: GITHUB_REPO });
    const data = await checkUpdate(app);
    expect(data.source).toBe('local');
    expect(data.has_update).toBe(false);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('enabled=true 但 manifestUrl 与 githubRepo 都空：维持本地固定判定', async () => {
    app = await buildApp({ enabled: true, manifestUrl: '', githubRepo: '' });
    const data = await checkUpdate(app);
    expect(data.source).toBe('local');
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('只有 githubRepo：走 GitHub Releases latest，source=github', async () => {
    fetchMock.mockResolvedValue(jsonResponse(githubRelease()));
    app = await buildApp({ enabled: true, manifestUrl: '', githubRepo: GITHUB_REPO });
    const data = await checkUpdate(app);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(fetchMock.mock.calls[0][0]).toBe(GITHUB_LATEST_URL);
    expect(data.source).toBe('github');
    expect(data.latest).toBe('0.1.202610301');
  });

  it('manifestUrl 非空时优先于 githubRepo（T00883 信任根语义不变），source=remote', async () => {
    fetchMock.mockResolvedValue(jsonResponse({ version: '9.9.9', downloadUrl: 'https://example.test/a.bin', sha256: 'ff', publishedAt: '2026-01-01' }));
    app = await buildApp({ enabled: true, manifestUrl: 'https://example.test/m.json', githubRepo: GITHUB_REPO });
    const data = await checkUpdate(app);
    expect(fetchMock.mock.calls[0][0]).toBe('https://example.test/m.json');
    expect(data.source).toBe('remote');
    expect(data.latest).toBe('9.9.9');
    expect(data.has_update).toBe(true);
    expect(data.sha256).toBe('ff');
  });

  it.each([
    '../../evil',
    'https://evil.test/x',
    'owner/repo/extra',
    'owner/',
    '/repo',
    'owner/repo?x=1',
    'owner/repo#frag',
  ])('githubRepo 形态非法（%s）：不发出任何请求，回退 local-fallback', async (repo) => {
    app = await buildApp({ enabled: true, manifestUrl: '', githubRepo: repo });
    const data = await checkUpdate(app);
    expect(fetchMock).not.toHaveBeenCalled();
    expect(data.source).toBe('local-fallback');
    expect(data.has_update).toBe(false);
  });

  it('manifestUrl 非 http/https 时同样拒绝（协议白名单第二道闸未回归）', async () => {
    app = await buildApp({ enabled: true, manifestUrl: 'file:///etc/passwd' });
    const data = await checkUpdate(app);
    expect(fetchMock).not.toHaveBeenCalled();
    expect(data.source).toBe('local-fallback');
  });

  it('download-update：通道未配置 → 409 update-disabled，且不触网', async () => {
    app = await buildApp({ enabled: true, manifestUrl: '', githubRepo: '' });
    const res = await app.inject({ method: 'GET', url: '/api/about/download-update' });
    expect(res.statusCode).toBe(409);
    expect((res.json() as { error: string }).error).toBe('update-disabled');
    expect(fetchMock).not.toHaveBeenCalled();
  });
});

describe('C · GitHub Releases 响应映射与新旧判定', () => {
  it('GitHub 版本更新 → has_update=true，download_url 取资产地址，published_at 透传', async () => {
    fetchMock.mockResolvedValue(jsonResponse(githubRelease({ tag_name: '9.9.9' })));
    app = await buildApp({ enabled: true, manifestUrl: '', githubRepo: GITHUB_REPO });
    const data = await checkUpdate(app);
    expect(data.has_update).toBe(true);
    expect(data.latest).toBe('9.9.9');
    expect(data.download_url).toBe(ASSET_URL);
    expect(data.release_url).toBe(ASSET_URL);
    expect(data.published_at).toBe('2026-10-30T02:26:10Z');
    // GitHub API 不提供资产摘要：sha256 必须是空串，前端据此跳过校验（既有语义）
    expect(data.sha256).toBe('');
  });

  it('GitHub 版本更旧 → has_update=false，但 latest 仍如实等于 GitHub tag（本仓当前真实状态）', async () => {
    // 根清单已被 bump 到 GitHub release 之后：此时"已是最新"是正确判定，
    // 关键断言是 latest 不再被本地回落成 current，证明 GitHub 确实被查到了。
    fetchMock.mockResolvedValue(jsonResponse(githubRelease({ tag_name: '0.0.1' })));
    app = await buildApp({ enabled: true, manifestUrl: '', githubRepo: GITHUB_REPO });
    const data = await checkUpdate(app);
    expect(data.has_update).toBe(false);
    expect(data.latest).toBe('0.0.1');
    expect(data.latest).not.toBe(data.current);
    expect(data.current).toBe(ROOT_PKG_VERSION);
    expect(data.download_url).toBe('');
    expect(data.source).toBe('github');
  });

  it('tag 带 v 前缀也能正确比较（compareVersions 剥 ^[vV]）', async () => {
    fetchMock.mockResolvedValue(jsonResponse(githubRelease({ tag_name: 'v99.0.0' })));
    app = await buildApp({ enabled: true, manifestUrl: '', githubRepo: GITHUB_REPO });
    const data = await checkUpdate(app);
    expect(data.has_update).toBe(true);
    expect(data.latest).toBe('v99.0.0');
  });

  it('release 无资产 → download_url 回退 release 页，前端"打开 release 页"分支仍可用', async () => {
    fetchMock.mockResolvedValue(jsonResponse(githubRelease({ tag_name: '9.9.9', assets: [] })));
    app = await buildApp({ enabled: true, manifestUrl: '', githubRepo: GITHUB_REPO });
    const data = await checkUpdate(app);
    expect(data.has_update).toBe(true);
    expect(data.download_url).toBe(RELEASE_HTML_URL);
  });

  it('资产项缺 browser_download_url → 跳过该项继续找，全缺则回退 release 页', async () => {
    fetchMock.mockResolvedValue(jsonResponse(githubRelease({
      tag_name: '9.9.9',
      assets: [null, { name: 'no-url.exe' }, { browser_download_url: ASSET_URL }],
    })));
    app = await buildApp({ enabled: true, manifestUrl: '', githubRepo: GITHUB_REPO });
    const data = await checkUpdate(app);
    expect(data.download_url).toBe(ASSET_URL);
  });

  it('GitHub 返回 404（仓库无 release）→ local-fallback，不草率报更新', async () => {
    fetchMock.mockResolvedValue(jsonResponse({ message: 'Not Found' }, false, 404));
    app = await buildApp({ enabled: true, manifestUrl: '', githubRepo: GITHUB_REPO });
    const data = await checkUpdate(app);
    expect(data.source).toBe('local-fallback');
    expect(data.has_update).toBe(false);
    expect(data.latest).toBe(ROOT_PKG_VERSION);
  });

  it('网络异常 → local-fallback；缓存让 5 分钟内的第二次调用不再触网', async () => {
    fetchMock.mockRejectedValue(new TypeError('fetch failed'));
    app = await buildApp({ enabled: true, manifestUrl: '', githubRepo: GITHUB_REPO });
    const first = await checkUpdate(app);
    const second = await checkUpdate(app);
    expect(first.source).toBe('local-fallback');
    expect(second).toEqual(first);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('tag_name 缺失 → latest 回落 current，不误报更新', async () => {
    fetchMock.mockResolvedValue(jsonResponse(githubRelease({ tag_name: undefined })));
    app = await buildApp({ enabled: true, manifestUrl: '', githubRepo: GITHUB_REPO });
    const data = await checkUpdate(app);
    expect(data.latest).toBe(ROOT_PKG_VERSION);
    expect(data.has_update).toBe(false);
  });

  it('download-update：GitHub 通道下代理资产字节，X-Update-Sha256 为空串', async () => {
    const payload = Buffer.from('fake-installer-bytes');
    fetchMock.mockImplementation(async (url: string) => {
      if (url === GITHUB_LATEST_URL) return jsonResponse(githubRelease({ tag_name: '9.9.9' }));
      expect(url).toBe(ASSET_URL);
      return {
        ok: true,
        status: 200,
        headers: new Headers({ 'content-type': 'application/octet-stream', 'content-length': String(payload.length) }),
        body: new ReadableStream({
          start(controller) {
            controller.enqueue(new Uint8Array(payload));
            controller.close();
          },
        }),
      } as unknown as Response;
    });
    app = await buildApp({ enabled: true, manifestUrl: '', githubRepo: GITHUB_REPO });
    const res = await app.inject({ method: 'GET', url: '/api/about/download-update' });
    expect(res.statusCode).toBe(200);
    expect(res.headers['x-update-sha256']).toBe('');
    expect(res.headers['content-disposition']).toContain('KarpathyWiki-Setup-v0.1.202610301.exe');
    expect(res.rawPayload.equals(payload)).toBe(true);
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });
});