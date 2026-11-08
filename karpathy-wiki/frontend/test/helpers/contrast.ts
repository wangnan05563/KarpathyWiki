// T04449：主题对比度实算的公共模块。
// 原先这套解析器/判定函数内联在 test/qa-contrast-pairing.test.ts 里，只能审问答页；
// 口径推广到其余页面时每页都要「列消费点清单 → 逐主题实算」，复制解析器既容易走样
// （阈值、tint 合成口径、主题回落规则不一致会出现同一面两种判定），也让守护失焦。
// 本模块只负责实算，不负责「该审哪些点」——清单仍由各页面测试自己声明（先测后改）。
import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';

export const ROOT = join(__dirname, '..', '..');
export const THEMES_DIR = join(ROOT, 'src/styles/themes');
export const STYLE_CSS = join(ROOT, 'src/style.css');
/** T04469：dark 主题的整套变量写在 tokens.css（不在 styles/themes/ 下），loadThemes() 天然看不见它 */
export const TOKENS_CSS = join(ROOT, 'src/styles/tokens.css');
/** T04467：移动端浅色皮肤的 --m-* 覆盖块（glass 在 style.css :root，light/dark 覆盖都在这个文件） */
export const MOBILE_LIGHT_CSS = join(ROOT, 'src/styles/mobile-light.css');
/** T04524：模态面口径需要 EP 遮罩色——从安装副本现读，不写死数值（升版改了遮罩必须让锁跟着变） */
export const NODE_MODULES = join(ROOT, 'node_modules');

/** AA 正常字号文本 4.5:1；WCAG 1.4.11 非文本控件（描边/图标）3:1 */
export const THRESHOLD = { text: 4.5, ui: 3.0 };

export type Kind = 'text' | 'ui';
export interface AuditRow {
  label: string;
  fg: string;
  bg: string;
  kind: Kind;
}

export interface RGB {
  r: number;
  g: number;
  b: number;
  a: number;
}

export interface ThemeTokens {
  name: string;
  decls: Map<string, string>;
}

export const stripComments = (css: string) => css.replace(/\/\*[\s\S]*?\*\//g, '');

export function parseDecls(css: string): Map<string, string> {
  const out = new Map<string, string>();
  for (const m of css.matchAll(/(--[\w-]+)\s*:\s*([^;]+);/g)) {
    if (!out.has(m[1])) out.set(m[1], m[2].trim());
  }
  return out;
}

/** :root 兜底主题 + styles/themes/ 下每个主题；主题未声明的 token 回落 :root（与浏览器一致） */
export function loadThemes(opts: { mobileSkins?: boolean } = {}): ThemeTokens[] {
  const rootDecl = parseDecls(stripComments(readFileSync(STYLE_CSS, 'utf8')).match(/:root\s*\{([\s\S]*?)\n\}/)![1]);
  const themes: ThemeTokens[] = [{ name: 'default(:root)', decls: new Map(rootDecl) }];
  const files = readdirSync(THEMES_DIR).filter((f) => f.endsWith('.css') && f !== 'index.css').sort();
  for (const f of files) {
    const theme = f.replace(/\.css$/, '');
    const css = readFileSync(join(THEMES_DIR, f), 'utf8');
    const own = new Map<string, string>();
    for (const m of css.matchAll(new RegExp(`\\[data-theme=["']${theme}["']\\]\\s*\\{([\\s\\S]*?)\\n\\}`, 'g'))) {
      for (const [k, v] of parseDecls(stripComments(m[1]))) {
        if (!own.has(k)) own.set(k, v);
      }
    }
    const merged = new Map(own);
    for (const [k, v] of rootDecl) if (!merged.has(k)) merged.set(k, v);
    themes.push({ name: theme, decls: merged });
  }
  // T04467：移动皮肤是运行时切换的两套取值（glass=:root / light=light 块 / light+桌面 dark=暗色覆盖），
  // 与桌面 [data-theme] 主题不是一套命名空间。默认不返回它们：现有 8 主题锁按 loadThemes().length
  // 登记了计数，无条件追加会让 14 把锁同时漂移（T04469 处理 dark 时踩过同一个坑）。
  if (opts.mobileSkins) themes.push(...loadMobileThemes());
  return themes;
}

/** 大括号配平取某个选择器块的全部声明（同名多块合并，先到先得）；移动皮肤块不是 [data-theme] 形状，不能复用 themeBlockDecls */
export function blockDecls(css: string, selector: string): Map<string, string> {
  const own = new Map<string, string>();
  const body = stripComments(css);
  for (let at = body.indexOf(selector); at >= 0; at = body.indexOf(selector, at + 1)) {
    let i = body.indexOf('{', at + selector.length);
    if (i < 0) break;
    let depth = 1;
    const start = ++i;
    while (i < body.length && depth > 0) {
      if (body[i] === '{') depth++;
      else if (body[i] === '}') depth--;
      i++;
    }
    for (const [k, v] of parseDecls(body.slice(start, i - 1))) if (!own.has(k)) own.set(k, v);
  }
  return own;
}

const mergeDecls = (base: Map<string, string>, ...layers: Map<string, string>[]) => {
  const out = new Map(base);
  for (const layer of layers) for (const [k, v] of layer) out.set(k, v);
  return out;
};

/**
 * T04467：移动端三套实际生效取值。
 * - mobile-glass：style.css :root 的 --m-*（MobileShell 未加 theme-light 时的默认皮肤）
 * - mobile-light：:root + mobile-light.css 的 .theme-light 块
 * - mobile-light-dark：浅色块 + html[data-theme="dark"] 覆盖块（桌面暗色联动，T01765）
 * 与 ThemeTokens 同形状，直接喂给 auditThemes/ worstRatio。
 */
export function loadMobileThemes(): ThemeTokens[] {
  const root = parseRootDecls();
  const ml = readFileSync(MOBILE_LIGHT_CSS, 'utf8');
  const light = blockDecls(ml, '.mobile-root.theme-light,');
  const dark = blockDecls(ml, 'html[data-theme="dark"] .mobile-root.theme-light,');
  if (light.size === 0 || dark.size === 0) throw new Error('mobile-light.css 的浅色/暗色覆盖块解析为空');
  return [
    { name: 'mobile-glass', decls: new Map(root) },
    { name: 'mobile-light', decls: mergeDecls(root, light) },
    { name: 'mobile-light-dark', decls: mergeDecls(root, light, dark) },
  ];
}

/** :root 兜底主题的声明（loadThemes() 第一项用的同一份解析） */
export function parseRootDecls(): Map<string, string> {
  return parseDecls(stripComments(readFileSync(STYLE_CSS, 'utf8')).match(/:root\s*\{([\s\S]*?)\n\}/)![1]);
}

/**
 * 大括号配平取出 CSS 里某个 `[data-theme="X"]` 块的**全部**声明（同名多块合并，先到先得）。
 * 为什么不用 loadThemes 里的 `\{([\s\S]*?)\n\}`：那条依赖「块体最后一个 } 单独成行」的书写习惯，
 * 而 tokens.css 的 dark 块中间夹着注释与多行 value，短匹配会在第一个 `}` 处截断 → 漏变量。
 */
export function themeBlockDecls(css: string, theme: string): Map<string, string> {
  const own = new Map<string, string>();
  const re = new RegExp(`\\[data-theme=["']${theme}["']\\]\\s*\\{`, 'g');
  const body = stripComments(css);
  for (const m of body.matchAll(re)) {
    let i = (m.index ?? 0) + m[0].length;
    let depth = 1;
    const start = i;
    while (i < body.length && depth > 0) {
      if (body[i] === '{') depth++;
      else if (body[i] === '}') depth--;
      i++;
    }
    for (const [k, v] of parseDecls(body.slice(start, i - 1))) if (!own.has(k)) own.set(k, v);
  }
  return own;
}

/**
 * T04469：把「不在 styles/themes/ 下的主题」（目前只有 tokens.css 的 dark）合成成一个可审计主题。
 * 为什么不直接把它塞进 loadThemes()：那个函数是 14 把对比度锁的共同主题源，
 * 多一个主题会让 T04449/T04470/T04472 登记死的「8 主题」计数与逐主题最差值同时漂移，
 * 那是另一单（dark 全量纳入口径）该做的事，不该由画布锁顺带触发。
 */
export function loadAuxTheme(name: string, cssFile = TOKENS_CSS, base?: Map<string, string>): ThemeTokens {
  const own = themeBlockDecls(readFileSync(cssFile, 'utf8'), name);
  if (own.size === 0) throw new Error(`tokens.css 里没有 [data-theme="${name}"] 块`);
  const merged = new Map(own);
  for (const [k, v] of base ?? parseRootDecls()) if (!merged.has(k)) merged.set(k, v);
  return { name: `${name}(tokens.css)`, decls: merged };
}

export function hexToRgb(h: string): RGB {
  let x = h.replace('#', '');
  if (x.length === 3) x = x.split('').map((c) => c + c).join('');
  return { r: parseInt(x.slice(0, 2), 16), g: parseInt(x.slice(2, 4), 16), b: parseInt(x.slice(4, 6), 16), a: x.length === 8 ? parseInt(x.slice(6, 8), 16) / 255 : 1 };
}
export const rgbToHex = (c: RGB) => '#' + [c.r, c.g, c.b].map((v) => Math.round(v).toString(16).padStart(2, '0')).join('');

/**
 * 源码里真用过的 CSS 命名色（T04472 取证腿要按「改前原始表达式」实算，`.remove-btn` 原本写的是 `color: white`）。
 * 只登记这张表的成员；新面孔由 resolve 直接报错，绝不静默按黑/白猜一个——猜错就是假达标。
 */
const NAMED_COLORS: Record<string, RGB> = {
  white: { r: 255, g: 255, b: 255, a: 1 },
  black: { r: 0, g: 0, b: 0, a: 1 },
};

/**
 * T04510：只登记 **srgb** 的 `color-mix(in srgb, A [p%], B [q%])`。
 * 按预乘 alpha 混（CSS Color 5 的口径）：`color-mix(in srgb, X 12%, transparent)` 得到「X 的色相 + a=0.12」。
 * 若图省事按非预乘直接混，transparent 的黑底会把 X 一路拉暗（12% 时约 rgb(0.12X)），
 * 那些面的实算会同时骗过「不达标的红」和「达标的绿」——两种假。
 * 其余色彩空间（oklab/oklch/hsl…）、渐变操作数、双边比例不合规：一律抛错，绝不回落成某个颜色
 * （沿用 NAMED_COLORS 的纪律：静默猜色就是把假达标写进主锁）。
 */
const COLOR_MIX_RE = /^color-mix\(\s*in\s+([A-Za-z-]+)\s*,([\s\S]*)\)$/;

/**
 * 取操作数尾部的百分比。只认「以 % 结尾 + 数字段 + 前一个字符是空白 + 前缀括号配平」，
 * 否则 `rgba(0 0 0 / 85%)` 这类把百分比写在括号里的写法会被从中间劈开，得出一个错色。
 */
function splitOperandPercent(part: string): { expr: string; pct: number | null } {
  if (!part.endsWith('%')) return { expr: part, pct: null };
  let k = part.length - 2;
  while (k > 0 && /[\d.]/.test(part[k - 1])) k--;
  const expr = part.slice(0, k).trim();
  const pct = Number(part.slice(k, part.length - 1));
  if (!expr || !/\s/.test(part[k - 1]) || !Number.isFinite(pct)) return { expr: part, pct: null };
  let depth = 0;
  for (const ch of expr) {
    if (ch === '(') depth++;
    else if (ch === ')' && --depth < 0) return { expr: part, pct: null };
  }
  return depth === 0 ? { expr, pct } : { expr: part, pct: null };
}

/** color-mix 的一边：递归 resolve 出实色 + 它登记的百分比；渐变操作数显式报错（端点无法定权） */
function resolveMixOperand(part: string, decls: Map<string, string>, depth: number, expr: string): { c: RGB; pct: number | null } {
  const { expr: sub, pct } = splitOperandPercent(part);
  const r = resolve(sub, decls, depth + 1);
  if ('stops' in r) throw new Error(`color-mix 的操作数是渐变，端点无法定权（表达式：${expr}）`);
  return { c: r.solid, pct };
}

/** 两操作数的权重：单边给比例则另一边取补，双边都给必须和为 100（其余形状不在登记口径内） */
function mixWeights(p1: number | null, p2: number | null, expr: string): [number, number] {
  if (p1 === null && p2 === null) return [0.5, 0.5];
  if (p1 !== null && p2 === null) return [p1 / 100, 1 - p1 / 100];
  if (p1 === null && p2 !== null) return [1 - p2 / 100, p2 / 100];
  const sum = (p1 as number) + (p2 as number);
  if (Math.abs(sum - 100) > 1e-6) throw new Error(`color-mix 双边比例和为 ${sum}%，非 100% 的归一化写法不在口径内（表达式：${expr}）`);
  return [(p1 as number) / 100, (p2 as number) / 100];
}

/** 预乘 alpha 的 srgb 混合：gamma 编码分量直接插值（srgb 空间的定义就是按编码值混） */
function mixSrgb(a: RGB, b: RGB, wa: number, wb: number): RGB {
  const alpha = wa * a.a + wb * b.a;
  if (alpha === 0) return { r: 0, g: 0, b: 0, a: 0 };
  const ch = (x: number, y: number) => (wa * x * a.a + wb * y * b.a) / alpha;
  return { r: ch(a.r, b.r), g: ch(a.g, b.g), b: ch(a.b, b.b), a: alpha };
}

/** 解析 var() 链（含嵌套 fallback）、rgba()/hex、linear-gradient 端点与 srgb 的 color-mix() */
export function resolve(expr: string, decls: Map<string, string>, depth = 0): { solid: RGB } | { stops: RGB[] } {
  const e = expr.trim();
  const varName = e.match(/^var\((--[\w-]+)\)$/);
  if (varName) {
    const v = decls.get(varName[1]);
    if (v === undefined) throw new Error(`token ${varName[1]} 未声明且无 fallback（表达式：${expr}）`);
    return resolve(v, decls, depth + 1);
  }
  // var(--x, <fallback>)：fallback 用括号配平静默取出，支持嵌套
  const open = e.match(/^var\(\s*(--[\w-]+)\s*,/);
  if (open && e.endsWith(')')) {
    const rest = e.slice(e.indexOf(',') + 1, e.length - 1).trim();
    const v = decls.get(open[1]);
    return resolve(v !== undefined ? v : rest, decls, depth + 1);
  }
  if (/^linear-gradient/.test(e)) {
    const inner = e.replace(/^linear-gradient\([^,]*,/, '').replace(/\)$/, '');
    const stops: RGB[] = [];
    for (const part of splitTopLevel(inner)) {
      const c = part.trim().replace(/\s+[-\d.]+%$/, '');
      if (!c || /(?:deg|turn|rad)\b/i.test(part) && !/[#r]/.test(part)) continue;
      const r = resolve(c, decls, depth + 1);
      if ('stops' in r) stops.push(...r.stops);
      else stops.push(r.solid);
    }
    return { stops };
  }
  const rgba = e.match(/^rgba?\(([^)]+)\)$/i);
  if (rgba) {
    const p = rgba[1].split(/[,\s/]+/).filter(Boolean).map(Number);
    return { solid: { r: p[0], g: p[1], b: p[2], a: p.length > 3 ? p[3] : 1 } };
  }
  if (e === 'transparent') return { solid: { r: 0, g: 0, b: 0, a: 0 } };
  if (/^#[0-9a-f]{3,8}$/i.test(e)) return { solid: hexToRgb(e) };
  const named = NAMED_COLORS[e.toLowerCase()];
  if (named) return { solid: named };
  const mix = e.match(COLOR_MIX_RE);
  if (mix) {
    if (mix[1].toLowerCase() !== 'srgb') throw new Error(`color-mix 色彩空间 in ${mix[1]} 不在解析口径内（表达式：${expr}）`);
    const parts = splitTopLevel(mix[2]).map((p) => p.trim());
    if (parts.length !== 2) throw new Error(`color-mix 需要恰好两个操作数，实测 ${parts.length} 个（表达式：${expr}）`);
    const A = resolveMixOperand(parts[0], decls, depth, expr);
    const B = resolveMixOperand(parts[1], decls, depth, expr);
    const [wa, wb] = mixWeights(A.pct, B.pct, expr);
    return { solid: mixSrgb(A.c, B.c, wa, wb) };
  }
  throw new Error(`无法解析颜色表达式：${expr}`);
}

/** 按逗号切分但忽略括号内的逗号（渐变端点里可能嵌 var(...)） */
export function splitTopLevel(s: string): string[] {
  const out: string[] = [];
  let depth = 0;
  let buf = '';
  for (const ch of s) {
    if (ch === '(') depth++;
    else if (ch === ')') depth--;
    if (ch === ',' && depth === 0) {
      out.push(buf);
      buf = '';
      continue;
    }
    buf += ch;
  }
  if (buf) out.push(buf);
  return out;
}

export function composite(fg: RGB, bg: RGB): RGB {
  const a = fg.a;
  return { r: fg.r * a + bg.r * (1 - a), g: fg.g * a + bg.g * (1 - a), b: fg.b * a + bg.b * (1 - a), a: 1 };
}
export function luminance(c: RGB): number {
  const f = (v: number) => {
    const s = v / 255;
    return s <= 0.03928 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4;
  };
  return 0.2126 * f(c.r) + 0.7152 * f(c.g) + 0.0722 * f(c.b);
}
export function contrast(a: RGB, b: RGB): number {
  const l1 = luminance(a);
  const l2 = luminance(b);
  return (Math.max(l1, l2) + 0.05) / (Math.min(l1, l2) + 0.05);
}

/** 前景表达式对「所在面」的最差对比度：渐变面逐端点取最小值 */
export function worstRatio(fgExpr: string, bgExpr: string, decls: Map<string, string>, page: RGB): number {
  const bg = resolve(bgExpr, decls);
  const surfaces = 'stops' in bg ? bg.stops.map((s) => composite(s, page)) : [composite(bg.solid, page)];
  const fg = resolve(fgExpr, decls);
  const fgs = 'stops' in fg ? fg.stops : [fg.solid];
  let worst = Infinity;
  for (const s of surfaces) {
    for (const f of fgs) worst = Math.min(worst, contrast(composite(f, s), s));
  }
  return worst;
}

/**
 * 所在页的可见底：卡片是半透明的，真实落点是 --bg-void 之上（浏览器就是这么合成的）。
 * 直接拿 --bg-card-solid 当不透明底会让深色主题的卡片偏亮，判定随之失真。
 */
export function pageOf(decls: Map<string, string>): RGB {
  const base = resolve('var(--bg-void)', decls);
  const page = 'stops' in base ? base.stops[0] : base.solid;
  const card = resolve('var(--bg-card-solid)', decls);
  if ('stops' in card) throw new Error('卡片面不应是渐变');
  return composite(card.solid, page);
}

export interface MobileSurfaces {
  /** 页面可见底：--m-bg 压在 --bg-void 上（glass 的 --m-bg 是半透明） */
  page: RGB;
  /** 卡片/导航等 --m-surface（半透明，压在 page 上） */
  surface: RGB;
  /** --m-fill / --m-fill-2 等填充层（压在 surface 上） */
  fill: RGB;
  fill2: RGB;
  primarySoft: RGB;
  dangerSoft: RGB;
  warningSoft: RGB;
}

/**
 * T04467：移动端面口径。桌面 pageOf() 找的是 --bg-card-solid / --bg-void，
 * 那是 aurora 卡片的合成链；移动子树根本不消费这两个 token，套用它会把整族实算算偏。
 * 移动端从 --m-bg 起算：page → surface → fill/tint 三层，与组件里的叠放顺序一致。
 */
export function mobileSurfaces(decls: Map<string, string>): MobileSurfaces {
  const solidOf = (expr: string): RGB => {
    const r = resolve(expr, decls);
    if ('stops' in r) throw new Error(`移动端面不应是渐变：${expr}`);
    return r.solid;
  };
  const page = composite(solidOf('var(--m-bg)'), solidOf('var(--bg-void)'));
  const surface = composite(solidOf('var(--m-surface)'), page);
  const layer = (token: string) => composite(solidOf(`var(${token})`), surface);
  return {
    page,
    surface,
    fill: layer('--m-fill'),
    fill2: layer('--m-fill-2'),
    primarySoft: layer('--m-primary-soft'),
    dangerSoft: layer('--m-danger-soft'),
    warningSoft: layer('--m-warning-soft'),
  };
}

export interface AuditFailure {
  theme: string;
  label: string;
  ratio: number;
  threshold: number;
}

/**
 * 逐主题逐面实算，返回全部未达标项（不抛错，由调用方组织断言消息）。
 * margin 默认 0：清单里的行必须自身达标，不允许靠阈值留余量蒙过。
 */
export function auditThemes(rows: AuditRow[], themes: ThemeTokens[] = loadThemes()): AuditFailure[] {
  const failures: AuditFailure[] = [];
  for (const t of themes) {
    const page = pageOf(t.decls);
    for (const row of rows) {
      const r = worstRatio(row.fg, row.bg, t.decls, page);
      if (r < THRESHOLD[row.kind]) failures.push({ theme: t.name, label: row.label, ratio: r, threshold: THRESHOLD[row.kind] });
    }
  }
  return failures;
}

/** 断言用的可读消息：主题 × 面 × 实测/阈值 */
export function formatFailures(failures: AuditFailure[]): string {
  return failures.map((f) => `${f.theme} · ${f.label} = ${f.ratio.toFixed(2)}（需 ≥ ${f.threshold}）`).join('\n  ');
}

/**
 * 前景口径扫描：文件里凡把「强调色裸名」写进 color / border-color / outline-color 都算违规，
 * 除非该表达式被对应的 readable token 包裹（readable 允许把裸名作为自己的 fallback）。
 * 装饰性填充（background / gradient）不受限。
 */
export function findBareForegroundUses(
  src: string,
  opts: { tokens: RegExp; readableWrappers: RegExp[]; declRe?: RegExp },
): string[] {
  // 行首只用 [ \t]*（不是 \s*）：\s 会跨行吞掉换行，CRLF 文件里会把上一条声明的尾巴当缩进，造成漏报。
  const declRe = opts.declRe ?? /^[ \t]*(?:color|border-color|border|outline-color|border-left-color)[ \t]*:[ \t]*(.+);[ \t\r]*$/gm;
  const violations: string[] = [];
  for (const m of src.matchAll(declRe)) {
    const value = m[1];
    if (!opts.tokens.test(value)) continue;
    if (opts.readableWrappers.some((re) => re.test(value))) continue;
    violations.push(value.trim());
  }
  return violations;
}

/** 前景属性：含 border / outline 简写——简写里的颜色同样是看得见的前景 */
export const FOREGROUND_PROPS = /^(?:color|border-color|border-(?:left|right|top|bottom)-color|outline-color|border|border-(?:left|right|top|bottom)|outline)$/;

/**
 * 精确口径扫描（比行锚定版更准，两者互补）：
 * 逐个 var() 引用定位 → 回溯/前进得到它所在的声明 → 只在「前景属性 + 基色 token + 表达式内无 readable」时判违规。
 * 这样能同时避开两类失真：
 *   - `--accent-purple-a15` 这类 tint（按口径是装饰底色）不会被当成基色裸用；
 *   - 单行规则 `.x { color: var(--neon-cyan); }` 与 `border: 1px solid var(--neon-cyan)` 简写不会漏报。
 */

/**
 * 取出 SFC 里**全部** `<style>` 块拼接（Browse.vue 有两个块：一个全局、一个 scoped）。
 * 早期实现用 `lastIndexOf('<style')`，等于只看最后一个块——第一个块里的消费点会同时骗过
 * token 级守卫与逐面清单，只有行级锁能兜住，这是口径扫描的真实盲区。
 */
export function styleText(src: string): string {
  const blocks: string[] = [];
  const re = /<style[^>]*>([\s\S]*?)<\/style>/g;
  for (const m of src.matchAll(re)) blocks.push(m[1]);
  return blocks.join('\n;\n');
}

export function findBareBaseForegroundUses(
  src: string,
  opts: { baseTokens: RegExp[]; readable?: RegExp },
): string[] {
  return [...new Set(listBareBaseForegroundUses(src, opts))];
}

/**
 * 同上的「逐处」版本（不去重）。
 * 去重版适合「有没有违规」的断言，但全站索引锁要的是**每个文件还剩几处**——
 * `.a { color: var(--neon-cyan) }` 与 `.b { color: var(--neon-cyan) }` 是两个真实消费点，
 * 去重后会变成一个，基线数就会失去意义（接入进度按处数只降不升来追踪）。
 */
export function listBareBaseForegroundUses(
  src: string,
  opts: { baseTokens: RegExp[]; readable?: RegExp },
): string[] {
  const readable = opts.readable ?? /--[\w-]+-readable/; // 任意 readable 家族都算包裹：家族配对对不对由数值清单负责，这里只判「有没有裸用基色」
  const css = stripComments(styleText(src));
  const violations: string[] = [];
  for (const m of css.matchAll(/var\(\s*(--[\w-]+)(?![\w-])/g)) {
    const token = m[1];
    const at = m.index ?? 0;
    if (!opts.baseTokens.some((re) => re.test(token))) continue;
    let s = at;
    while (s > 0 && !/[;{}]/.test(css[s - 1])) s--;
    let e = at;
    while (e < css.length && !/[;{}]/.test(css[e])) e++;
    const decl = css.slice(s, e).trim();
    const colon = decl.indexOf(':');
    if (colon < 0) continue;
    const prop = decl.slice(0, colon).trim().replace(/\s+/g, ' ');
    if (!FOREGROUND_PROPS.test(prop)) continue;
    if (readable.test(decl.slice(colon + 1))) continue;
    violations.push(`${prop} → ${decl.slice(colon + 1).replace(/\s+/g, ' ').slice(0, 110)}`);
  }
  return violations;
}

/**
 * 取出某个选择器的规则体（可能有多条同名规则，全部返回）。
 * T04472 用它锁「面与前景成对出现在同一条规则里」——只在文件层面数 token 出现次数，
 * 兜不住「前景接了配对 token、底色仍写原渐变」这类半接入。
 * 口径：先去注释，再按大括号配平取体（SFC 里的 style 块已由 styleText 合并）。
 */
export function ruleBodies(src: string, selector: string): string[] {
  const css = stripComments(styleText(src));
  const escaped = selector.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const out: string[] = [];
  for (const m of css.matchAll(new RegExp(`(?:^|[};{])\\s*${escaped}\\s*\\{`, 'g'))) {
    let i = (m.index ?? 0) + m[0].length;
    let depth = 1;
    const start = i;
    while (i < css.length && depth > 0) {
      if (css[i] === '{') depth++;
      else if (css[i] === '}') depth--;
      i++;
    }
    out.push(css.slice(start, i - 1));
  }
  return out;
}

/** 把前景属性表达式（color / -webkit-text-fill-color）从规则体里取出来 */
export function foregroundOf(body: string): string[] {
  const out: string[] = [];
  for (const m of body.matchAll(/(?:^|;)[ \t\r\n]*(?:-webkit-text-fill-color|color|border-color|outline-color)[ \t]*:[ \t]*([^;]+)/g)) {
    out.push(m[1].trim().replace(/\s+/g, ' '));
  }
  return out;
}

/**
 * T04472：硬白字前景扫描器（listBareBaseForegroundUses 的互补面）。
 * 已有扫描器只认「强调色裸名当前景」，抓不到 `#fff` —— 白字压强调面是方向相反的同一缺陷族：
 * 底色由 --grad-* / tint / 半透明卡片决定，浅底主题里白字直接掉到 1.00:1（文字不可见）。
 * 口径：
 *   - 只看前景属性（集合是 HARD_WHITE_PROPS = FOREGROUND_PROPS ∪ {-webkit-text-fill-color}，
 *     含 border / outline 简写：白色描边同样是看得见的前景）；
 *     background / gradient 里的白色是高亮装饰，不算前景；
 *   - 「硬编码白」= #fff / #ffffff / white / rgba(255,255,255,·)；
 *   - **var() 的 fallback 位不计**（如 `color: var(--menu-active-fg, #fff)`）：真实前景由 token 供给，
 *     各主题已有 --tk-accent-fg 硬门禁与 *-readable 家族负责；这里抓的是「源码里没给所在面
 *     留任何配对线索」的直接白字。
 *   - 白字压纯深底（--bg-void 一类）合法，因此只返回逐处命中，由调用方按文件基线表冻结计数。
 */
export const HARD_WHITE_VALUE = /(?:#(?:fff|ffffff)\b|rgba?\(\s*255\s*,\s*255\s*,\s*255|\bwhite\b)/i;

/**
 * 硬白字扫描的前景属性集 = FOREGROUND_PROPS ∪ {-webkit-text-fill-color}。
 * 为什么不直接往 FOREGROUND_PROPS 里加：那个集合同时服务「基色裸用」扫描（T04449/T04470），
 * 它的逐文件基线数已按现集合冻结，扩集合会让那些基线无端漂移。
 * 而 `-webkit-text-fill-color` 是真实可见前景（图标字/渐变文字兜底），漏判它等于给
 * 「白字压强调面」留一条后门，故本扫描器单列超集。
 */
export const HARD_WHITE_PROPS = /^(?:(?:-webkit-)?text-fill-color|color|border-color|border-(?:left|right|top|bottom)-color|outline-color|border|border-(?:left|right|top|bottom)|outline)$/;

/** 把 var(...) 组（含嵌套与 fallback）整体摘掉：剩下的才是「源码直接写给前景的色值」 */
function stripVarGroups(value: string): string {
  let out = '';
  for (let i = 0; i < value.length; ) {
    if (/^var\(/i.test(value.slice(i))) {
      let depth = 0;
      let j = i;
      for (; j < value.length; j++) {
        if (value[j] === '(') depth++;
        else if (value[j] === ')' && --depth === 0) {
          j++;
          break;
        }
      }
      i = j;
    } else {
      out += value[i];
      i++;
    }
  }
  return out;
}

export function listHardWhiteForegroundUses(src: string): string[] {
  const css = stripComments(styleText(src));
  const hits: string[] = [];
  // 按语法边界（; { }）分段取声明，而不是按行锚定：
  //   - `.a { color: #fff }` 这类单行规则里声明不在行首，行锚定版会漏（ mutation 探针实测出来的盲区）；
  //   - \s 跨行在 CRLF 文件里会吞掉上一条声明的尾巴；`;`/`}` 边界没有这个问题。
  // 属性集合用本扫描器的超集（含 -webkit-text-fill-color 与 border/outline 简写）
  for (const seg of css.split(/[;{}]/)) {
    const colon = seg.indexOf(':');
    if (colon < 0) continue;
    const prop = seg.slice(0, colon).trim().replace(/\s+/g, ' ');
    if (!HARD_WHITE_PROPS.test(prop)) continue;
    const value = seg.slice(colon + 1);
    if (!HARD_WHITE_VALUE.test(value)) continue;
    if (!HARD_WHITE_VALUE.test(stripVarGroups(value))) continue;
    hits.push(`${prop} → ${value.trim().replace(/\s+/g, ' ').slice(0, 110)}`);
  }
  return hits;
}

/**
 * T04509：把「硬编码前景」判定从「白」泛化为「字面色」。
 * 缺陷族的真实定义不是「白字」，而是「前景写死字面色 + 所在面由主题决定」——
 * 深色字（#0b0b12 / #1a1a1a 一类）压 --grad-* / tint / 半透明卡片，在深底主题里同样掉到 1.x:1，
 * 而只认白的 listHardWhiteForegroundUses 扫不到（product 的 --on-cool-fg: #0b0b12 就是实例）。
 *
 * 三条负控制与原扫描器逐条对应（工单第 4 条要求显式保留）：
 *   ① var() 的 fallback 位不计 —— stripVarGroups 括号配平整组摘除（含嵌套）；
 *   ② 装饰底不计 —— 只看前景属性（LITERAL_FG_PROPS），background/gradient 里的字面色是装饰；
 *   ③ 纯深底不计 —— 本扫描器**不判达标**，只出「前景 × 所在面」事实；
 *      是否算缺陷由调用方按逐主题实算决定（压在 --bg-void 一类主题实底上的深色字合法，实算必过）。
 *      这条口径不能压进扫描器本身：扫描器一旦内置「哪些面算深底」的白名单，
 *      就等于把新增主题/改取值的影响面悄悄排除掉，正是本缺陷族最容易被无声吞掉的方式。
 */
export const LITERAL_FG_PROPS = HARD_WHITE_PROPS;

/**
 * 从一条前景声明里取出**完整的**第一个字面色 token。
 * 不能只拿正则命中的片段：`rgba(` 只是 `rgba(29,122,95,0.28)` 的开头，
 * 片段喂给 resolve() 必抛 → 普查会把大量合法落点误记成「不可解析」，缺陷矩阵随之失真。
 * 因此函数式/带括号的写法按括号配平整组取走；同时剥掉 `!important`（它是声明尾巴，不是色）。
 */
export function extractLiteralColor(value: string): string | null {
  const v = value.replace(/!important/i, '');
  for (let i = 0; i < v.length; ) {
    const hex = /^#[0-9a-fA-F]{3,8}\b/.exec(v.slice(i));
    if (hex) return hex[0];
    const named = /^white\b|^black\b/i.exec(v.slice(i));
    if (named && (i === 0 || /[\s,(/]/.test(v[i - 1]))) return named[0];
    if (/^(?:rgb|hsl)a?\s*\(/i.test(v.slice(i))) {
      let depth = 0;
      let j = i;
      for (; j < v.length; j++) {
        if (v[j] === '(') depth++;
        else if (v[j] === ')' && --depth === 0) {
          j++;
          break;
        }
      }
      return v.slice(i, j).replace(/\s+/g, ' ');
    }
    i++;
  }
  return null;
}

export interface LiteralFgSite {
  /** 所在规则的选择器（@media/@keyframes 前缀保留，便于人肉定位） */
  sel: string;
  prop: string;
  value: string;
  /** 命中的完整字面色 token（供报告与实算取 fg 用） */
  literal: string;
  /** 该规则自声明的底色（没有则为 null，由调用方按「继承所在页底」处理） */
  ownBg: string | null;
  /** 选择器里的 `[data-theme="x"]` 限定；有则该落点只在该主题下生效，普查不能拿它去套全主题 */
  themeScoped: string | null;
}

/** 大括号配平拆出所有规则（含 at-rule 内层，@media 保留前缀；@keyframes 的帧同样是真的前景色） */
export function iterRules(css: string): Array<{ sel: string; body: string }> {
  const out: Array<{ sel: string; body: string }> = [];
  let i = 0;
  while (i < css.length) {
    const open = css.indexOf('{', i);
    if (open < 0) break;
    const selRaw = css.slice(i, open).trim().replace(/\s+/g, ' ');
    let depth = 1;
    let j = open + 1;
    while (j < css.length && depth > 0) {
      if (css[j] === '{') depth++;
      else if (css[j] === '}') depth--;
      j++;
    }
    const body = css.slice(open + 1, j - 1);
    if (/^@[\w-]+\s*$/.test(selRaw) || /^@(media|supports|layer)\b/.test(selRaw)) {
      for (const r of iterRules(body)) out.push({ sel: `${selRaw} ▸ ${r.sel}`, body: r.body });
    } else if (/^@/.test(selRaw)) {
      out.push({ sel: selRaw, body });
    } else {
      out.push({ sel: selRaw, body });
    }
    i = j;
  }
  return out;
}

/** 逐处「字面色前景」事实清单（含所在规则与自声明底色），供普查与实算共用 */
export function listLiteralForegroundSites(src: string): LiteralFgSite[] {
  const css = stripComments(styleText(src));
  const hits: LiteralFgSite[] = [];
  for (const { sel, body } of iterRules(css)) {
    const bg = /(?:^|;)\s*(?:background|background-image|background-color)\s*:\s*([^;]+)/i.exec(body);
    const scoped = /\[data-theme=(?:"|')?([\w-]+)/.exec(sel);
    for (const seg of body.split(';')) {
      const colon = seg.indexOf(':');
      if (colon < 0) continue;
      const prop = seg.slice(0, colon).trim().replace(/\s+/g, ' ');
      if (!LITERAL_FG_PROPS.test(prop)) continue;
      const value = seg.slice(colon + 1).trim().replace(/\s+/g, ' ');
      const bare = stripVarGroups(value);
      const literal = extractLiteralColor(bare);
      if (!literal) continue;
      hits.push({
        sel,
        prop,
        value,
        literal,
        ownBg: bg ? bg[1].trim().replace(/\s+/g, ' ') : null,
        themeScoped: scoped ? scoped[1] : null,
      });
    }
  }
  return hits;
}

/** 与硬白字扫描器同形状的字符串版（基线表/断言消息用） */
export function listLiteralForegroundUses(src: string): string[] {
  return listLiteralForegroundSites(src).map((h) => `${h.sel} · ${h.prop} → ${h.value.slice(0, 110)}`);
}

/**
 * T04524：模态面口径。
 * pageOf() 算的是「卡片压在页面底上」——对嵌在页面里的元素正确，但弹窗里的元素不是这个落点：
 * `.el-overlay` 是一层半透明遮罩压住页面，`.el-dialog` 又取半透明的 `--bg-card-solid` 盖在遮罩上。
 * 于是同一个高亮片底下实际有两张面：遮罩合成后的**卡片**（对话框覆盖处）与遮罩合成后的**页底**
 * （卡片没铺满的边角 / 圆角外沿）。两张都算取最差 —— 只算其一会让另一半落点无人管。
 *
 * 遮罩色按「哪条规则真的生效」现读，不在本文件里写死数值：
 *   1. src/styles/modal.css 把 EP 的 `.el-overlay` 底色整个覆盖成 `var(--modal-mask, rgba(4,2,12,.58))`，
 *      而 main.ts 里 modal.css 是最后导入的 —— 同特异性后来者胜，所以渲染出来的**不是** EP 那份
 *      `--el-overlay-color-lighter`（取证时照抄 EP 默认值会把整族判定算偏）。
 *   2. 只有 modal.css 那条覆盖没了，才回落去读 EP 安装副本的变量 —— 届时口径确实该跟着换。
 * 「当前生效的是哪一份」由各条锁显式登记（见 test/contrast-cite-hit-face.test.ts 的 D 组）：
 * 来源悄悄换档必须让锁变红，而不是继续按老遮罩假绿。
 */
export const MODAL_CSS = join(ROOT, 'src/styles/modal.css');
export const EP_OVERLAY_CSS = join(NODE_MODULES, 'element-plus/theme-chalk/el-overlay.css');
export const EP_VAR_CSS = join(NODE_MODULES, 'element-plus/theme-chalk/el-var.css');

export type OverlaySource = 'modal.css' | 'element-plus';

function die(msg: string): never {
  throw new Error(msg);
}

/** 弹窗遮罩表达式与其来源（见文件顶部口径注释） */
export function overlayExpr(): { expr: string; source: OverlaySource } {
  const modalCss = stripComments(readFileSync(MODAL_CSS, 'utf8'));
  const own = /\.el-overlay\s*\{[^}]*background-color:\s*([^;}]+)/.exec(modalCss);
  if (own) {
    const expr = own[1].trim();
    if (!/--modal-mask/.test(expr)) {
      die(`modal.css 的 .el-overlay 底色不再走 --modal-mask（当前是 ${expr}）：模态面口径要重新定`);
    }
    return { expr, source: 'modal.css' };
  }
  const epCss = stripComments(readFileSync(EP_OVERLAY_CSS, 'utf8'));
  if (!/\.el-overlay\s*\{[^}]*background-color:\s*var\(--el-overlay-color-lighter\)/.test(epCss)) {
    die('既不在 modal.css、也不在 element-plus 里找到 .el-overlay 的底色规则：模态面口径失效');
  }
  const epVar = stripComments(readFileSync(EP_VAR_CSS, 'utf8'));
  const m = /--el-overlay-color-lighter:\s*([^;]+)/.exec(epVar);
  if (!m) die('element-plus 主题里找不到 --el-overlay-color-lighter');
  return { expr: m[1].trim(), source: 'element-plus' };
}

/**
 * 弹窗内元素的两张真实落点面：遮罩压卡片合成底、遮罩压页底。
 * theme 用于把 modal.css 里 `[data-theme='X']` 的遮罩减淡覆盖并进来（浅色主题走 rgba(17,17,17,.34)）——
 * 那份声明不在 themes/ 下，loadThemes() 天然看不见它。
 */
export function modalFaces(theme: ThemeTokens): RGB[] {
  const { expr } = overlayExpr();
  const decls = new Map(theme.decls);
  if (theme.name !== 'default(:root)') {
    for (const [k, v] of themeBlockDecls(readFileSync(MODAL_CSS, 'utf8'), theme.name)) decls.set(k, v);
  }
  const overlay = solidOf(expr, decls, `遮罩表达式 ${expr}`);
  return [composite(overlay, pageOf(theme.decls)), composite(overlay, solidOf('var(--bg-void)', theme.decls, '--bg-void'))];
}

function solidOf(expr: string, decls: Map<string, string>, what: string): RGB {
  const r = resolve(expr, decls);
  if ('stops' in r) die(`${what} 解析成了渐变，模态面口径按两端点分别算即可，勿走这里`);
  return r.solid;
}

/** 前景表达式对「多张候选面」的最差对比度：每张面都按 worstRatio 的面/端点口径展开 */
export function worstRatioOnFaces(fgExpr: string, bgExpr: string, decls: Map<string, string>, faces: RGB[]): number {
  let worst = Infinity;
  for (const face of faces) {
    worst = Math.min(worst, worstRatio(fgExpr, bgExpr, decls, face));
  }
  return worst;
}


