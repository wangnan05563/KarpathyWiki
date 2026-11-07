// T04534：关于页版本号恒为 0.1.0。
// ------------------------------------------------------------------
// 前端侧根因：vite.config.ts 读的是 frontend/package.json（子包清单，version 恒为初始
//   0.1.0、bump-version.ps1 从不写它），注入的 __APP_VERSION__ 因此永远是 0.1.0；
//   About.vue 又优先用这个注入值，后端 /api/about 只作兜底 → UI 恒显 0.1.0。
// 本文件三层守护：
//   A 构建注入源：直接取 vite.config.ts 导出的 define.__APP_VERSION__，断言它等于
//     workspace 根清单版本、且不等于 frontend 子包版本（负控制：两者确实不同，
//     否则"读哪份都绿"，用例失去判别力）。
//   B 兜底渲染：vitest 不注入 define，About.vue 走 /api/about 兜底分支，
//     断言后端修好的版本号能如实渲染到 .version-value。
//   C 检查更新交互：has_update=true 时按钮 surfaced 远端 latest；false 时显示"已是最新"
//     且版本号不受影响（本仓当前真实状态：根清单比 GitHub release 更新）。
// 后端侧的版本源与 GitHub 通道由 api/test/about-version-update.test.ts 守护。
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { mount, flushPromises } from '@vue/test-utils';
import ElementPlus from 'element-plus';
import { apiFetch } from '../src/utils/apiBase';
import About from '../src/views/About.vue';

vi.mock('../src/utils/apiBase', () => ({
  API_BASE: '',
  apiFetch: vi.fn(),
}));

const mockedFetch = vi.mocked(apiFetch);

const FRONTEND_DIR = path.resolve(__dirname, '..');
const ROOT_PKG = JSON.parse(fs.readFileSync(path.resolve(FRONTEND_DIR, '../package.json'), 'utf8')) as { version: string };
const FE_PKG = JSON.parse(fs.readFileSync(path.resolve(FRONTEND_DIR, 'package.json'), 'utf8')) as { version: string };

const GITHUB_LATEST = '0.1.202610301';
const ASSET_URL = `https://github.com/wangnan05563/KarpathyWiki/releases/download/${GITHUB_LATEST}/KarpathyWiki-Setup-v${GITHUB_LATEST}.exe`;

function makeResponse(body: unknown, ok = true, status = 200): Response {
  return { ok, status, json: async () => body } as unknown as Response;
}

// 按 URL 分派：/api/about 给版本元信息，/api/about/check-update 给更新判定
function stubApi(checkUpdate: Record<string, unknown>, aboutVersion = ROOT_PKG.version): void {
  mockedFetch.mockImplementation(async (url) => {
    if (String(url).endsWith('/about')) {
      return makeResponse({ version: aboutVersion, build_date: '2026-11-05', git_sha: 'abc1234', node: '24.0.0', platform: 'win32' });
    }
    if (String(url).endsWith('/about/check-update')) return makeResponse(checkUpdate);
    throw new Error(`unexpected fetch: ${url}`);
  });
}

function mountAbout() {
  return mount(About, {
    global: { plugins: [ElementPlus], stubs: { AppModal: true } },
    attachTo: document.body,
  });
}

function localResponse(current: string): Record<string, unknown> {
  return {
    current, latest: current, has_update: false, release_url: '', download_url: '',
    sha256: '', published_at: '', checked_at: '2026-11-07T00:00:00Z', source: 'local',
  };
}

beforeEach(() => {
  vi.useFakeTimers();
  mockedFetch.mockReset();
});

afterEach(() => {
  vi.useRealTimers();
  document.body.replaceChildren();
});

describe('A · 构建注入的版本号来自 workspace 根清单（T04534 前端根因）', () => {
  it('负控制前提：根清单与 frontend 子包清单 version 确实不同', () => {
    // bump-version.ps1 只写根清单，frontend/package.json 停在初始 0.1.0。
    // 若两者被同步成一样，这条会红，提示本组用例已失去判别力。
    expect(ROOT_PKG.version).not.toBe(FE_PKG.version);
    expect(FE_PKG.version).toBe('0.1.0');
  });

  it('vite define.__APP_VERSION__ 等于根清单版本，不是 frontend 子包的 0.1.0', () => {
    // 为什么起子进程真求值而不是在 vitest 里 import：vitest 的 SSR 变换会把
    // import.meta.url 改写成非 file: 协议，config 里的 readFileSync(new URL(...)) 直接抛
    // ERR_INVALID_URL_SCHEME。用 Node 原生 type-stripping 加载真实 config 才是行为级证据。
    const script = `
const { pathToFileURL } = await import('node:url');
const m = await import(pathToFileURL(process.argv[1] + '/vite.config.ts').href);
process.stdout.write(JSON.stringify(m.default.define));
`;
    const out = execFileSync(process.execPath, ['--input-type=module', '-e', script, FRONTEND_DIR], {
      encoding: 'utf8',
      timeout: 60000,
    });
    const define = JSON.parse(out) as Record<string, string>;
    expect(JSON.parse(define.__APP_VERSION__)).toBe(ROOT_PKG.version);
    expect(JSON.parse(define.__APP_VERSION__)).not.toBe(FE_PKG.version);
  });

  it('源码级锁：vite.config.ts 读的是 ../package.json（回退到 ./package.json 即红）', () => {
    const src = fs.readFileSync(path.resolve(FRONTEND_DIR, 'vite.config.ts'), 'utf8');
    expect(src).toContain("new URL('../package.json', import.meta.url)");
    expect(src).not.toContain("new URL('./package.json', import.meta.url)");
  });
});

describe('B · About 页版本号渲染（define 未注入时走 /api/about 兜底）', () => {
  it('.version-value 显示后端返回的权威版本号，不再恒为 0.1.0', async () => {
    stubApi(localResponse(ROOT_PKG.version));
    const wrapper = mountAbout();
    await flushPromises();
    expect(wrapper.find('.version-value').text()).toBe(ROOT_PKG.version);
    expect(wrapper.find('.version-value').text()).not.toBe('0.1.0');
    wrapper.unmount();
  });

  it('后端 /api/about 失败时不白屏：版本号落到 -- 兜底', async () => {
    mockedFetch.mockRejectedValue(new TypeError('fetch failed'));
    const wrapper = mountAbout();
    await flushPromises();
    expect(wrapper.find('.version-value').text()).toBe('--');
    wrapper.unmount();
  });
});

describe('C · 检查更新交互：远端版本号如实 surfaced，UI 流程不变', () => {
  it('has_update=true：按钮显示远端 latest 与"立即更新"，5s 自动首查生效', async () => {
    stubApi({
      current: '0.0.1', latest: GITHUB_LATEST, has_update: true,
      release_url: ASSET_URL, download_url: ASSET_URL, sha256: '',
      published_at: '2026-10-30T02:26:10Z', checked_at: '2026-11-07T00:00:00Z', source: 'github',
    }, '0.0.1');
    const wrapper = mountAbout();
    await flushPromises();
    // 挂载后 5s 才发起首次自动检查
    expect(mockedFetch.mock.calls.filter((c) => String(c[0]).endsWith('/check-update'))).toHaveLength(0);
    await vi.advanceTimersByTimeAsync(5000);
    await flushPromises();
    const text = wrapper.text();
    expect(text).toContain(GITHUB_LATEST);
    expect(text).toContain('立即更新');
    wrapper.unmount();
  });

  it('has_update=false（本仓真实状态：根清单比 GitHub release 新）：显示"已是最新"，版本号不受影响', async () => {
    stubApi({
      current: ROOT_PKG.version, latest: GITHUB_LATEST, has_update: false,
      release_url: '', download_url: '', sha256: '',
      published_at: '2026-10-30T02:26:10Z', checked_at: '2026-11-07T00:00:00Z', source: 'github',
    });
    const wrapper = mountAbout();
    await flushPromises();
    await vi.advanceTimersByTimeAsync(5000);
    await flushPromises();
    expect(wrapper.text()).toContain('已是最新');
    expect(wrapper.find('.version-value').text()).toBe(ROOT_PKG.version);
    wrapper.unmount();
  });

  it('手动点击"检查更新"立即发起请求，不必等 5s', async () => {
    stubApi(localResponse(ROOT_PKG.version));
    const wrapper = mountAbout();
    await flushPromises();
    const btn = wrapper.findAll('button').find((b) => b.text().includes('检查更新'));
    expect(btn).toBeTruthy();
    await btn!.trigger('click');
    await flushPromises();
    expect(mockedFetch.mock.calls.filter((c) => String(c[0]).endsWith('/check-update'))).toHaveLength(1);
    wrapper.unmount();
  });
});