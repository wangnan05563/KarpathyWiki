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
export function loadThemes(): ThemeTokens[] {
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
  return themes;
}

export function hexToRgb(h: string): RGB {
  let x = h.replace('#', '');
  if (x.length === 3) x = x.split('').map((c) => c + c).join('');
  return { r: parseInt(x.slice(0, 2), 16), g: parseInt(x.slice(2, 4), 16), b: parseInt(x.slice(4, 6), 16), a: x.length === 8 ? parseInt(x.slice(6, 8), 16) / 255 : 1 };
}
export const rgbToHex = (c: RGB) => '#' + [c.r, c.g, c.b].map((v) => Math.round(v).toString(16).padStart(2, '0')).join('');

/** 解析 var() 链（含嵌套 fallback）与 rgba()/hex，返回可用于合成的实色或渐变端点 */
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
