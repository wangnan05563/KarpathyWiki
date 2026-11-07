import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';

// T04531：受守卫接口禁止裸 fetch —— 跨包普查锁。
//
// 背景：后端大量写接口挂 guards.requireAuth / requireAdmin，而鉴权凭据是 localStorage 里的
//   Bearer token（不是 Cookie）。前端任何用裸 fetch 打这些接口的调用点，后端都只能把已登录
//   用户当成游客 → 401「未登录或会话已过期」。T03611（Progress.vue 编译请求）与本单
//   （Config.vue 建索引按钮）是同一缺陷类的两次复发：单点修复只写了一条源码结构断言，
//   没有覆盖「全站还有哪些裸 fetch」，所以每次都要靠用户报错才发现。本锁把判定权交给
//   **后端源码**：守卫清单从 api/src/routes/*.ts 现算，新增受守卫接口自动进入监管范围，
//   不需要维护者记得回来改登记表。
//
// 为什么不只在 Config.vue 上加一条断言：那只能钉住这一个调用点，下个视图再写一次裸 fetch
//   仍然静默通过（历史已复发两次）。

const FRONT_SRC = path.resolve(__dirname, '../src');
const API_ROUTES = path.resolve(__dirname, '../../api/src/routes');

function listSourceFiles(dir: string, exts: RegExp): string[] {
  const out: string[] = [];
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) out.push(...listSourceFiles(full, exts));
    else if (exts.test(entry.name)) out.push(full);
  }
  return out.sort();
}

// ── 守卫清单：从后端路由源码现算 ──────────────────────────────────────────────
// 识别 `app.get/post/put/delete('PATH', { ... preHandler: <守卫> ... })`，
// 守卫名涵盖 guards.requireAuth / guards?.requireAdmin / requirePermission(...) /
// authGuard / adminGuard（routes/auth.ts 的包装名）与 readPreHandler（files.ts 的
// 配置条件守卫：auth 启用且 filesReadAuthRequired=true 时要求登录，同样不能裸 fetch）。
const APP_ROUTE_LINE = /(?:^|[^\w$.])(?:app|server)\s*\.\s*(get|post|put|delete|patch)\b/;
const GUARD_IN_BLOCK = /preHandler:\s*(?:guards\??\.(?:requireAuth|requireAdmin|requirePermission\b)|authGuard\b|adminGuard\b|readPreHandler\b|\[)/;

/** 受守卫接口集合，元素形如 `POST /api/search/rebuild`（方法与路径配对，避免 GET 公开/PUT 受保护的同路径误判）。 */
function collectGuardedEndpoints(): Set<string> {
  const guarded = new Set<string>();
  for (const file of listSourceFiles(API_ROUTES, /\.ts$/)) {
    const lines = fs.readFileSync(file, 'utf8').split(/\r?\n/);
    for (let i = 0; i < lines.length; i++) {
      const start = APP_ROUTE_LINE.exec(lines[i]);
      if (!start) continue;
      // 注册块 = 本行起，到下一条路由注册前（preHandler 可能换行写，如 conversations.ts）
      let end = lines.length;
      for (let j = i + 1; j < lines.length; j++) {
        if (APP_ROUTE_LINE.test(lines[j])) { end = j; break; }
      }
      const head = lines.slice(i, i + 2).join(' ');
      const pathMatch = /(?:app|server)\s*\.\s*(get|post|put|delete|patch)(?:<[\s\S]*?>)?\s*\(\s*[`'"]([^`'"]+)[`'"]/.exec(head);
      if (!pathMatch) continue;
      if (!GUARD_IN_BLOCK.test(lines.slice(i, Math.min(end, i + 14)).join('\n'))) continue;
      guarded.add(`${pathMatch[1].toUpperCase()} ${normalizePath(pathMatch[2])}`);
    }
  }
  return guarded;
}

// 前端一律用 `${API_BASE}/xxx` 拼 URL（API_BASE 自带 /api 前缀），所以比对前两侧都要去掉 /api 段，
// 否则候选永远比清单少一段、锁会静默空跑。
function stripApiPrefix(p: string): string {
  return p.startsWith('/api/') ? p.slice(4) : p === '/api' ? '' : p;
}

// 路径归一：去 query、:param 与 ${...} 统一成 * 段；保留单个尾斜杠（用于识别截断形态）
function normalizePath(raw: string): string {
  const noQuery = raw.split('?')[0];
  return noQuery
    .replace(/\$\{[^}]*\}/g, '*')
    .replace(/:[A-Za-z_][A-Za-z0-9_]*/g, '*')
    .replace(/\/{2,}/g, '/');
}

function segments(p: string): string[] {
  return p.split('/').filter(Boolean);
}

// 候选路径与受守卫路径的匹配：两侧都去 /api 前缀后，段数相同且逐段相等（* 通配），
// 另外支持「候选以 / 结尾」的截断形态（`${API_BASE}/media/video/${taskId}` 抽出来是 /media/video/，
// 字符类无法跨过 ${）——按前缀段匹配，宁可多报也不漏报。
function matchesGuarded(candidate: string, guardedPath: string): boolean {
  const c = segments(stripApiPrefix(candidate));
  const g = segments(stripApiPrefix(guardedPath));
  if (c.length === 0 || g.length === 0) return false;
  if (c.length === g.length) {
    return c.every((seg, idx) => seg === '*' || g[idx] === '*' || seg === g[idx]);
  }
  if (candidate.endsWith('/') && g.length > c.length) {
    return c.every((seg, idx) => seg === '*' || g[idx] === '*' || seg === g[idx]);
  }
  return false;
}

// ── 前端裸 fetch 站点 ────────────────────────────────────────────────────────
interface FetchSite {
  /** 相对 frontend/src 的路径 */
  file: string;
  line: number;
  /** 从 fetch 调用点解析到的候选接口路径（已去 /api 前缀） */
  candidates: string[];
  method: string;
}

// 裸 fetch：排除 apiFetch/authFetch（同源字符串里包含它们）、window.fetch 等限定形式
const BARE_FETCH = /(^|[^.\w$])fetch\(/;
const CREDENTIAL_CHANNEL = /apiFetch|authFetch|window\.fetch|globalThis|self\.fetch/;

function collectBareFetchSites(): FetchSite[] {
  const sites: FetchSite[] = [];
  for (const full of listSourceFiles(FRONT_SRC, /\.(ts|vue)$/)) {
    const rel = path.relative(FRONT_SRC, full).replace(/\\/g, '/');
    const lines = fs.readFileSync(full, 'utf8').split(/\r?\n/);
    const src = lines.join('\n');
    for (let i = 0; i < lines.length; i++) {
      if (!BARE_FETCH.test(lines[i]) || CREDENTIAL_CHANNEL.test(lines[i])) continue;
      const after = lines.slice(i, Math.min(lines.length, i + 6)).join('\n');
      sites.push({
        file: rel,
        line: i + 1,
        candidates: resolveUrlCandidates(src, after, i),
        method: /method:\s*['"]([A-Za-z]+)['"]/.exec(after)?.[1].toUpperCase() ?? 'GET',
      });
    }
  }
  return sites;
}

// 从 fetch 调用点解析它实际打到的接口路径。两种形态：
//   ① URL 直接写在 fetch(...) 里（含 options）→ 就地取字面量；
//   ② fetch(变量) → 回溯该变量的赋值语句；赋值若是本文件内函数调用，再进函数体取字面量
//      （Browse.vue 的 `const url = buildSearchUrl()`）。
// 只在「参数是裸标识符」时才回溯，避免把无关行里的接口路径 bleed 成假阳性。
function resolveUrlCandidates(fileSrc: string, after: string, fetchLineIdx: number): string[] {
  const out = new Set<string>();
  for (const p of extractApiPaths(after)) out.add(p);
  const argName = /fetch\(\s*([A-Za-z_$][\w$]*)\s*[,)]/.exec(after.split('\n')[0])?.[1];
  if (!argName) return [...out];
  const before = fileSrc.split('\n').slice(Math.max(0, fetchLineIdx - 15), fetchLineIdx).join('\n');
  const assign = new RegExp(`(?:const|let|var)\\s+${argName}\\s*=([\\s\\S]{0,240})`).exec(before);
  if (!assign) return [...out];
  for (const p of extractApiPaths(assign[1])) out.add(p);
  const fnName = /^\s*(?:await\s+)?([A-Za-z_][\w]*)\(\s*\)\s*;?\s*$/.exec(assign[1].trim())?.[1];
  if (fnName) for (const p of extractApiPaths(extractFunctionBody(fileSrc, fnName))) out.add(p);
  return [...out];
}

// 抽出 `${API_BASE}/xxx` 与 `'/api/xxx'` 两种写法里的接口路径，统一去掉 /api 前缀
function extractApiPaths(text: string): string[] {
  const found = new Set<string>();
  const baseRe = /API_BASE\}\s*\/([A-Za-z0-9_\-/:.]*)/g;
  let m: RegExpExecArray | null;
  while ((m = baseRe.exec(text)) !== null) {
    const p = normalizePath('/' + m[1]);
    if (p !== '/') found.add(p);
  }
  const absRe = /['"`]\/api([A-Za-z0-9_\-/:.]*)['"`]/g;
  while ((m = absRe.exec(text)) !== null) {
    const p = normalizePath('/api' + m[1]);
    if (p !== '/api') found.add(p);
  }
  return [...found];
}

// 取本文件内 `function name(` 起至首个顶格 `}` 的代码体（本项目函数体均为顶格闭合）
function extractFunctionBody(src: string, name: string): string {
  const start = src.search(new RegExp(`function\\s+${name}\\s*\\(`));
  if (start < 0) return '';
  const rest = src.slice(start);
  const end = rest.search(/^\}/m);
  return end < 0 ? rest.slice(0, 3000) : rest.slice(0, end);
}

describe('受守卫接口禁止裸 fetch（T04531 跨包普查锁）', () => {
  const guarded = collectGuardedEndpoints();

  describe('守卫清单解析器自检（清单为空会让下面的锁静默空跑）', () => {
    it('解析出足量受守卫接口', () => {
      expect(guarded.size).toBeGreaterThanOrEqual(90);
    });

    it('本单涉事接口 POST /api/search/rebuild 在清单内', () => {
      expect(guarded.has('POST /api/search/rebuild')).toBe(true);
    });

    it('已知的其他受守卫接口在清单内（覆盖 requireAuth / requireAdmin 两档）', () => {
      expect(guarded.has('GET /api/config')).toBe(true);
      expect(guarded.has('GET /api/threads')).toBe(true);
      expect(guarded.has('GET /api/search/chunks')).toBe(true);
      expect(guarded.has('GET /api/files/tree')).toBe(true); // 配置条件守卫，同样不许裸 fetch
    });

    it('公开接口不在清单内（防止守卫误判造成假阳性）', () => {
      expect(guarded.has('GET /api/search/status')).toBe(false);
      expect(guarded.has('POST /api/search/hybrid')).toBe(false);
      expect(guarded.has('POST /api/auth/login')).toBe(false);
      expect(guarded.has('POST /api/search/rebuild')).toBe(true); // 与 status 同前缀，必须分辨开
    });
  });

  describe('前端裸 fetch 站点必须全部落在无守卫接口上', () => {
    const sites = collectBareFetchSites();

    it('无任何裸 fetch 打到受守卫接口', () => {
      const violations = sites
        .flatMap((s) => s.candidates.map((c) => ({ site: s, c })))
        .filter(({ site, c }) => [...guarded].some((g) => {
          const [method, gPath] = g.split(' ');
          return method === site.method && matchesGuarded(c, gPath);
        }))
        .map(({ site, c }) => `${site.file}:${site.line} ${site.method} ${c}`);
      expect(violations).toEqual([]);
    });

    it('裸 fetch 站点数量/归属文件与登记表一致（新增裸 fetch 必须先过鉴权判定）', () => {
      // 登记表现值来自 T04531 实测普查：全部为「公开接口」或「凭据通道实现本身」。
      // 有意保留的例外：useSSEStream.ts 用变量 URL（无法静态判定）且零调用方，由下一条用例钉住。
      const expected: Record<string, number> = {
        'composables/useSSEStream.ts': 1, // 变量 endpoint，零调用方（见下一条用例）
        'stores/auth.ts': 3,              // authFetch 实现 + login/register 两个公开端点
        'utils/apiBase.ts': 1,            // apiFetch 实现
        'views/Browse.vue': 2,            // POST /search/hybrid、GET /search（均无守卫）
        'views/Config.vue': 1,            // GET /search/status（无守卫；rebuild 已改走 apiFetch）
        'views/DataClean.vue': 1,         // GET /data-clean/diff（无守卫）
        'views/Login.vue': 1,             // GET /auth/bootstrap（无守卫）
      };
      const actual: Record<string, number> = {};
      for (const s of sites) actual[s.file] = (actual[s.file] ?? 0) + 1;
      expect(actual).toEqual(expected);
    });

    it('useSSEStream 仍是零调用方的裸 fetch 实现（一旦接线必须先补鉴权）', () => {
      const importers = listSourceFiles(FRONT_SRC, /\.(ts|vue)$/).filter((f) => {
        if (f.replace(/\\/g, '/').endsWith('composables/useSSEStream.ts')) return false;
        return /from\s+['"][^'"]*useSSEStream['"]/.test(fs.readFileSync(f, 'utf8'));
      });
      expect(importers.map((f) => path.relative(FRONT_SRC, f).replace(/\\/g, '/'))).toEqual([]);
    });

    it('凭据通道本身仍在注入 Bearer（通道失效会让上述全部断言失去意义）', () => {
      const apiBase = fs.readFileSync(path.join(FRONT_SRC, 'utils/apiBase.ts'), 'utf8');
      expect(apiBase).toMatch(/headers\.set\('Authorization',\s*`Bearer \$\{token\}`\)/);
      const authStore = fs.readFileSync(path.join(FRONT_SRC, 'stores/auth.ts'), 'utf8');
      expect(authStore).toMatch(/headers\.set\('Authorization',\s*`Bearer \$\{token\.value\}`\)/);
    });
  });

  describe('T04531 复发现场：AI 服务页建索引请求', () => {
    const src = fs.readFileSync(path.join(FRONT_SRC, 'views/Config.vue'), 'utf8');

    it('rebuild 请求走 apiFetch（注入 Bearer）', () => {
      expect(src).toMatch(/await apiFetch\(`\$\{API_BASE\}\/search\/rebuild`/);
    });

    it('不得退回裸 fetch 打 rebuild', () => {
      expect(src).not.toMatch(/await fetch\(`\$\{API_BASE\}\/search\/rebuild`/);
    });

    it('失败消息同时携带状态码与后端原文（行为面由 config-index-coverage J 条锁）', () => {
      expect(src).toMatch(/HTTP \$\{res\.status\}: \$\{data\.error/);
    });
  });

  describe('T04537 复发现场：图谱缺口分析消耗共享 LLM Key', () => {
    const src = fs.readFileSync(path.join(FRONT_SRC, 'views/Graph.vue'), 'utf8');

    it('后端 analyze 进入受守卫清单（清单由源码现算，未挂守卫会掉出）', () => {
      expect(guarded.has('POST /api/graph/gaps/analyze')).toBe(true);
    });

    it('analyze 请求走 apiFetch（注入 Bearer）', () => {
      expect(src).toMatch(/await apiFetch\(`\$\{API_BASE\}\/graph\/gaps\/analyze`/);
    });

    it('不得退回裸 fetch 打 analyze', () => {
      expect(src).not.toMatch(/await fetch\(`\$\{API_BASE\}\/graph\/gaps\/analyze`/);
    });
  });
});
