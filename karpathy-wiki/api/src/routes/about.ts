import type { FastifyInstance, FastifyRequest, FastifyReply } from 'fastify';
import fs from 'node:fs/promises';
import fsSync from 'node:fs';
import path from 'node:path';
import { Readable } from 'node:stream';
import { execSync } from 'node:child_process';
import { getApiDir, getResourcePath, IS_SEA } from '../utils/runtime.js';
import type { AppConfig, UpdateConfig } from '../types.js';

// 关于页面路由：提供系统元信息与版本检查。
// 参考 17_xianyu 项目 about 模块设计，适配本项目 Fastify + 外网发布通道由配置驱动的场景。
//   GET /api/about                 返回版本号、构建日期、Git SHA、Node 版本、平台
//   GET /api/about/check-update    检查更新（两条远端通道都未配置时固定返回 has_update=false）
//   GET /api/about/download-update 代理下载更新包（SSRF 白名单 + sha256 回传 + 流式进度）
//
// 设计取舍（T00883 原始口径，T04534 增补 GitHub 通道与版本源修正）：
//   - 版本号权威源是 workspace 根 package.json，不是 api/package.json（T04534 根因）：
//     bump-version.ps1 只写根清单、scripts/config.json 的 publish.version_source 指根清单、
//     build-exe.ps1 与 installer.iss 也读根清单；api/package.json 是子包清单，version 恒为
//     初始值 0.1.0 且从不被 bump，读它会让 /api/about 与 check-update 的 current 永远停在 0.1.0。
//   - 远端通道二选一：manifestUrl 非空 → 管理员自建 manifest JSON（T00883 原语义，优先级更高）；
//     否则 githubRepo 非空 → GitHub Releases latest（T04534 新增，默认通道）；两者都空或
//     enabled=false → 维持"固定 has_update=false"的本地行为，不发起任何外网请求。
//   - SSRF 白名单（结构防护，非 IP 黑名单）：下载代理端点不接受客户端指定 URL，只转发
//     当前生效通道声明的 downloadUrl。manifest 通道的信任根是管理员配置的 manifestUrl；
//     GitHub 通道的信任根是固定主机 api.github.com + owner/repo 形态白名单（见 GITHUB_REPO_RE），
//     资产地址只能来自该仓库的 releases/latest 响应，客户端同样无法注入任意目标。
//     为何不在信任根上做 IP/私网拦截：本项目常自托管于本机/LAN（manifest
//     与更新包与 wiki 同机托管），拦截 127.0.0.1/私网会误伤合法场景；若信任该更新源，
//     其声明的下载端点与其身具同等信任级（完整性由 sha256 校验兜底）。
//     唯一白名单约束是协议：manifestUrl 与 downloadUrl 都必须是 http/https（杜绝 file: 等）。
//   - sha256：manifest 声明 sha256，下载端点通过 X-Update-Sha256 头回传给前端，
//     由前端在收齐字节后用 WebCrypto 校验再触发安装（流式代理阶段无法回滚已发字节）。
//     GitHub Releases API 不返回资产摘要，故该通道 sha256 为空串，前端按既有语义跳过校验。
//   - 构建日期取权威 package.json 的修改时间（bump 即改它，与发版产物同步）
//   - Git SHA 通过 git rev-parse 获取，无 git 环境时返回 unknown
//   - check-update 后端 5 分钟缓存，避免前端高频调用造成不必要计算与重复外网请求

// 定位版本号权威源：从 api 目录向上找与 pnpm-workspace.yaml 同级的 package.json。
// 为什么用 pnpm-workspace.yaml 作标志：它只存在于 workspace 根，是根清单的唯一结构标志，
//   比硬编码包名或"固定上跳一级"更稳健（源文件所在层级变化时不会指错）。
// SEA 模式不做向上查找：exe 目录就是资源根，越界查找会命中安装目录之外的无关清单。
// 找不到时回退 getResourcePath('package.json')，保持非 workspace 部署可用。
function resolveVersionPackagePath(): string {
  if (!IS_SEA) {
    let dir = getApiDir();
    for (let i = 0; i < 4; i++) {
      const candidate = path.join(dir, 'package.json');
      if (fsSync.existsSync(candidate) && fsSync.existsSync(path.join(dir, 'pnpm-workspace.yaml'))) {
        return candidate;
      }
      const parent = path.resolve(dir, '..');
      if (parent === dir) break;
      dir = parent;
    }
  }
  return getResourcePath('package.json');
}

// 路径解析统一走 runtime.ts，兼容开发模式与 SEA 打包模式
const PACKAGE_JSON_PATH = resolveVersionPackagePath();

// 5 分钟缓存：与闲鱼项目一致，避免前端轮询造成不必要计算；也避免每次重复请求远端 manifest
const CHECK_UPDATE_CACHE_TTL_MS = 5 * 60 * 1000;

// 远端 manifest 拉取的 User-Agent：标识更新代理身份
const UPDATE_UA = 'KarpathyWikiUpdate/1.0';

// 版本 manifest 结构：两条远端通道归一化后的同一形状（字符串字段，缺失按空串安全兜底）。
// manifest 通道直接来自 update.manifestUrl 指向的 JSON；GitHub 通道由 releases/latest 映射而来。
// 为什么字段名非缩写：admin 手写配置，用全拼降低拼错概率。
interface UpdateManifest {
  // 远端最新版本号（如 "1.2.3"），与当前版本比较判定是否有更新
  version: string;
  // 更新包下载地址（仅允许 http/https），是下载代理端点的唯一可转发目标
  downloadUrl: string;
  // 更新包的 sha256 十六进制摘要（可选）：前端收齐后校验，防下载损坏/篡改
  sha256: string;
  // 发布/更新日期（可选），透传给前端展示
  publishedAt: string;
}

let checkUpdateCache: { data: CheckUpdateData; ts: number } | null = null;

// check-update 响应结构。
// source 区分数据来源：'local'（两条通道都未配置，固定判定）/'remote'（manifest 通道判定）
//   /'github'（GitHub Releases 通道判定）/'local-fallback'（远端检查失败回退，不草率判定有新版本）。
interface CheckUpdateData {
  current: string;
  latest: string;
  has_update: boolean;
  release_url: string;
  download_url: string;
  sha256: string;
  published_at: string;
  checked_at: string;
  source: 'local' | 'remote' | 'github' | 'local-fallback';
}

// 读取权威 package.json（workspace 根，见 resolveVersionPackagePath）中的版本号。
// 失败时回退 '0.0.0' 保证 UI 不崩。
async function readVersion(): Promise<string> {
  try {
    const raw = await fs.readFile(PACKAGE_JSON_PATH, 'utf8');
    const parsed = JSON.parse(raw) as { version?: string };
    return parsed.version ?? '0.0.0';
  } catch {
    return '0.0.0';
  }
}

// 读取 package.json 的 mtime 作为构建日期（ISO 8601 YYYY-MM-DD)。
// 为什么用 mtime 而非内置 build_info：本项目无构建脚本生成 _build_info，mtime 已足够。
async function readBuildDate(): Promise<string> {
  try {
    const stat = await fs.stat(PACKAGE_JSON_PATH);
    return stat.mtime.toISOString().slice(0, 10);
  } catch {
    return '';
  }
}

// 读取 Git SHA（7 位短哈希）。无 git 环境或非 git 仓库时返回 unknown。
function readGitSha(): string {
  try {
    const sha = execSync('git rev-parse --short HEAD', {
      encoding: 'utf8',
      timeout: 2000,
      stdio: ['ignore', 'pipe', 'ignore'],
    }).trim();
    return sha || 'unknown';
  } catch {
    return 'unknown';
  }
}

// GitHub Releases API 主机固定：仓库名只拼进路径，不接受客户端传入的任意 URL（结构白名单）。
const GITHUB_API_BASE = 'https://api.github.com';

// owner/repo 形态白名单：杜绝 '../'、协议头、查询串等把请求指向 GitHub API 的其它端点。
// 为什么允许 '.'：GitHub 仓库名可含点（如 owner/repo.js），与路径穿越的 '..' 由整段形态区分。
const GITHUB_REPO_RE = /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/;

// 判定当前生效的远端通道：null 表示不发外网请求（维持本地固定判定）。
// 优先级：manifestUrl（管理员显式配置的信任根）> githubRepo（默认发布通道）。
// check-update 与 download-update 共用同一判定，避免两个端点的启用口径漂移。
function updateChannel(cfg: UpdateConfig | undefined): 'manifest' | 'github' | null {
  if (!cfg?.enabled) return null;
  if (cfg.manifestUrl?.trim()) return 'manifest';
  if (cfg.githubRepo?.trim()) return 'github';
  return null;
}

// 字段缺失/类型不符一律安全兜底为空串，两条通道共用。
function str(v: unknown): string {
  return typeof v === 'string' ? v : '';
}

// 拉取远端版本 manifest：按生效通道分派。调用方须先用 updateChannel 判非 null。
async function fetchManifest(cfg: UpdateConfig): Promise<UpdateManifest> {
  return updateChannel(cfg) === 'manifest' ? fetchRemoteManifest(cfg) : fetchGithubRelease(cfg);
}

// 通道一：管理员自建 manifest（update.manifestUrl，T00883 原语义逐字保留）。
// 协议白名单：只允许 http/https，杜绝 file:/data: 等非网络协议（fetch 实际也不支持，显式拦住更清晰）。
// trust-root 语义：manifestUrl 是管理员配置的信任根，不额外做 IP/私网拦截（见文件头设计取舍）。
// 为什么 schedule 超时：网络挂起时若没有超时，check-update 会长时间阻塞前端轮询。
async function fetchRemoteManifest(cfg: UpdateConfig): Promise<UpdateManifest> {
  assertHttpUrl(cfg.manifestUrl);
  const controller = new AbortController();
  const timeoutMs = cfg.timeoutMs ?? 8000;
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetch(cfg.manifestUrl, {
      signal: controller.signal,
      headers: { 'User-Agent': UPDATE_UA },
    });
    if (!res.ok) throw new Error(`manifest HTTP ${res.status}`);
    const data = (await res.json()) as Record<string, unknown>;
    return {
      version: str(data.version),
      downloadUrl: str(data.downloadUrl),
      sha256: str(data.sha256),
      publishedAt: str(data.publishedAt),
    };
  } finally {
    clearTimeout(timer);
  }
}

// 通道二：GitHub Releases latest（T04534 新增，默认通道）。
// 为什么取 releases/latest 而不是 tags：latest 已由 GitHub 排除 draft/prerelease，
//   且带 assets（安装包下载地址）与 published_at，一次请求即可归一化成 UpdateManifest。
// 版本号取 tag_name 原样（本仓 tag 无 v 前缀，资产名里的 v 只是命名前缀，不属版本号）；
//   比较时由 compareVersions 统一剥 ^[vV]，故带不带前缀都能正确判定新旧。
// sha256 留空：GitHub API 不提供资产摘要，前端按既有"声明了才校验"语义跳过（见文件头）。
async function fetchGithubRelease(cfg: UpdateConfig): Promise<UpdateManifest> {
  const repo = (cfg.githubRepo ?? '').trim();
  if (!GITHUB_REPO_RE.test(repo)) throw new Error('invalid githubRepo');
  const controller = new AbortController();
  const timeoutMs = cfg.timeoutMs ?? 8000;
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetch(`${GITHUB_API_BASE}/repos/${repo}/releases/latest`, {
      signal: controller.signal,
      headers: { 'User-Agent': UPDATE_UA, Accept: 'application/vnd.github+json' },
    });
    if (!res.ok) throw new Error(`github releases HTTP ${res.status}`);
    const data = (await res.json()) as Record<string, unknown>;
    // 取第一个带下载地址的资产（本项目 release 只挂一个安装包）；无资产时回退 release 页，
    // 让前端"打开 release 页"分支仍可用，而不是拿到空串后卡在无动作状态。
    const assets = Array.isArray(data.assets) ? data.assets : [];
    let downloadUrl = '';
    for (const asset of assets) {
      const url = str((asset as Record<string, unknown> | null)?.browser_download_url);
      if (url) {
        downloadUrl = url;
        break;
      }
    }
    return {
      version: str(data.tag_name),
      downloadUrl: downloadUrl || str(data.html_url),
      sha256: '',
      publishedAt: str(data.published_at),
    };
  } finally {
    clearTimeout(timer);
  }
}

// 语义化版本号比较：a > b 返回 1，a < b 返回 -1，相等返回 0。
// 为什么自实现而非引入 semver 依赖：本项目遵守"不引入冲突第三方依赖"，且只需要三段数值比较，
//   已满足"是否有新版本"的判定需求。剥离前导 v/V，段缺失视为 0。
function compareVersions(a: string, b: string): number {
  const pa = (a || '').replace(/^[vV]/, '').split('.').map((n) => parseInt(n, 10) || 0);
  const pb = (b || '').replace(/^[vV]/, '').split('.').map((n) => parseInt(n, 10) || 0);
  const len = Math.max(pa.length, pb.length);
  for (let i = 0; i < len; i++) {
    const x = pa[i] || 0;
    const y = pb[i] || 0;
    if (x > y) return 1;
    if (x < y) return -1;
  }
  return 0;
}

// 协议白名单校验：仅允许 http/https URL。非法时上抛，由调用方分类处理。
// 为什么不用 IP 黑名单：信任根模型下，"只能转发 manifest 声明地址"已是结构白名单，
//   对自托管的本机/LAN 更新源做 IP 拦截反而误伤（见文件头设计取舍）。
function assertHttpUrl(raw: string): void {
  let u: URL;
  try {
    u = new URL(raw);
  } catch {
    throw new Error('invalid URL');
  }
  if (u.protocol !== 'http:' && u.protocol !== 'https:') {
    throw new Error('only http/https allowed');
  }
}

// 从 downloadUrl 的 pathname 提取纯 ASCII 文件名（用于 Content-Disposition）。
// 为什么必须只保留 [A-Za-z0-9._-]：文件名会拼进响应头，含引号/分号/换行的原始 basename
//   可伪造或注入 HTTP 头；此处显式白名单化，超长时截断。
function deriveFileName(downloadUrl: string): string {
  try {
    const base = new URL(downloadUrl).pathname.split('/').pop() || '';
    const safe = base.replace(/[^A-Za-z0-9._-]/g, '_').slice(0, 80);
    return safe || 'karpathy-wiki-update.bin';
  } catch {
    return 'karpathy-wiki-update.bin';
  }
}

// 构造本地兜底的 check-update 响应（未启用更新 / 远端检查失败时共用）。
function localData(current: string, source: 'local' | 'local-fallback'): CheckUpdateData {
  return {
    current,
    latest: current,
    has_update: false,
    release_url: '',
    download_url: '',
    sha256: '',
    published_at: '',
    checked_at: new Date().toISOString(),
    source,
  };
}

export function registerAboutRoute(app: FastifyInstance, config: AppConfig): void {
  // GET /api/about：返回系统元信息。所有字段失败时回退安全值，UI 不白屏。
  app.get('/api/about', async (_req: FastifyRequest, reply: FastifyReply) => {
    const [version, buildDate] = await Promise.all([readVersion(), readBuildDate()]);
    const gitSha = readGitSha();

    reply.send({
      product: 'Karpathy Wiki',
      version,
      build_date: buildDate,
      git_sha: gitSha,
      node: process.versions.node,
      platform: process.platform,
    });
  });

  // GET /api/about/check-update：检查更新。缓存 5 分钟减少重复读取与外网请求。
  // 两条远端通道都未配置（enabled=false 或 manifestUrl/githubRepo 均空）→ 固定 has_update=false；
  // 否则按生效通道拉取远端版本对比，最新版高于当前版本才判 has_update=true；
  //   远端检查失败回退 has_update=false（不草率提示更新）。
  app.get('/api/about/check-update', async (_req: FastifyRequest, reply: FastifyReply) => {
    const now = Date.now();
    if (checkUpdateCache && (now - checkUpdateCache.ts) < CHECK_UPDATE_CACHE_TTL_MS) {
      return reply.send(checkUpdateCache.data);
    }

    const current = await readVersion();
    const updateCfg = config.update;
    const channel = updateChannel(updateCfg);

    let data: CheckUpdateData;
    if (channel && updateCfg) {
      try {
        const manifest = await fetchManifest(updateCfg);
        const latest = manifest.version || current;
        const hasUpdate = compareVersions(latest, current) > 0;
        data = {
          current,
          latest,
          has_update: hasUpdate,
          release_url: hasUpdate ? manifest.downloadUrl : '',
          download_url: hasUpdate ? manifest.downloadUrl : '',
          sha256: hasUpdate ? manifest.sha256 : '',
          published_at: manifest.publishedAt || '',
          checked_at: new Date().toISOString(),
          source: channel === 'github' ? 'github' : 'remote',
        };
      } catch {
        data = localData(current, 'local-fallback');
      }
    } else {
      data = localData(current, 'local');
    }

    checkUpdateCache = { data, ts: now };
    return reply.send(data);
  });

  // GET /api/about/download-update：代理下载更新包。
  // SSRF 白名单：客户端无权指定下载目标，端点只转发生效通道声明的 downloadUrl。
  // 返回原始字节流（附 Content-Length 供前端算进度），sha256 经 X-Update-Sha256 头回传，
  //   由前端收齐后校验（流式阶段无法回滚已发字节）。
  app.get('/api/about/download-update', async (_req: FastifyRequest, reply: FastifyReply) => {
    const updateCfg = config.update;
    const channel = updateChannel(updateCfg);
    if (!channel || !updateCfg) {
      return reply.code(409).send({ error: 'update-disabled' });
    }

    let manifest: UpdateManifest;
    try {
      manifest = await fetchManifest(updateCfg);
    } catch (err) {
      return reply.code(502).send({ error: 'manifest-unreachable', message: err instanceof Error ? err.message : String(err) });
    }
    if (!manifest.downloadUrl) {
      return reply.code(409).send({ error: 'no-download-url' });
    }

    // 协议白名单：downloadUrl 与 manifestUrl 一样须为 http/https（结构白名单的第二道闸）
    try {
      assertHttpUrl(manifest.downloadUrl);
    } catch (err) {
      return reply.code(400).send({ error: 'ssrf-blocked', message: err instanceof Error ? err.message : String(err) });
    }

    // 只对"拿到上游响应头"这一阶段限时；此后需流式传输大文件，不能继续用同一超时 abort
    const controller = new AbortController();
    const timeoutMs = updateCfg.timeoutMs ?? 8000;
    const timer = setTimeout(() => controller.abort(), timeoutMs);

    let upstream: Response;
    try {
      upstream = await fetch(manifest.downloadUrl, {
        signal: controller.signal,
        headers: { 'User-Agent': UPDATE_UA },
      });
    } catch (err) {
      clearTimeout(timer);
      return reply.code(502).send({ error: 'download-failed', message: err instanceof Error ? err.message : String(err) });
    }
    clearTimeout(timer);

    if (!upstream.ok || !upstream.body) {
      return reply.code(502).send({ error: 'download-failed', message: `upstream HTTP ${upstream.status}` });
    }

    reply
      .code(200)
      .header('Content-Type', upstream.headers.get('content-type') || 'application/octet-stream')
      .header('Content-Disposition', `attachment; filename="${deriveFileName(manifest.downloadUrl)}"`)
      .header('X-Update-Sha256', manifest.sha256 || '');
    // 透传 Content-Length 让前端能计算精确进度；上游未提供（chunked）时省略，前端按未知总量处理
    const contentLength = upstream.headers.get('content-length');
    if (contentLength) reply.header('Content-Length', contentLength);

    // 用 node:stream 的 Readable 包装 Web ReadableStream，交给 Fastify 逐块转发给客户端
    // 为什么 cast：undici 的 Response.body 泛型参数是 Uint8Array<ArrayBuffer>，与 node:stream/web
    //   的 ReadableStream 在 pipeThrough 上存在 readonly 数组类型协变不兼容，运行时行为一致。
    return reply.send(Readable.fromWeb(upstream.body as import('node:stream/web').ReadableStream));
  });
}

// 工具函数：导出供测试或外部模块复用（按需调用，避免每次启动都执行 git 命令）
export function _readPackageJsonSync(): { version: string; exists: boolean } {
  try {
    if (!fsSync.existsSync(PACKAGE_JSON_PATH)) {
      return { version: '0.0.0', exists: false };
    }
    const raw = fsSync.readFileSync(PACKAGE_JSON_PATH, 'utf8');
    const parsed = JSON.parse(raw) as { version?: string };
    return { version: parsed.version ?? '0.0.0', exists: true };
  } catch {
    return { version: '0.0.0', exists: false };
  }
}