// T04175 知识问答页「前景可读色配对」守护。
// 背景（缺陷复现口径）：.msg-bubble.user 的底色是主题渐变 --grad-fire，而气泡内的
//   「确认发送」（重新发送入口）按钮取的是「页面底色」口径的 --text-soft + 淡青描边，
//   两套口径叠在同一块面上 → 实测对比度 1.01:1（商务浅白）～2.52:1，用户读作
//   「按钮颜色与主题冲突，看不清楚」；同一页里所有把强调色当前景用的 hover/active 态
//   （工具栏图标、联想追问、代码块徽章、排队取消）在浅底主题上也普遍只有 1.0～2.4:1。
// 本用例把两件事钉住：
//   ① 数值：逐主题（含 :root 默认主题）逐面实算 WCAG 对比度，文本 4.5:1、控件 3:1；
//   ② 口径：这三个问答入口文件里，强调色/警示色当前景必须经 --accent-readable /
//      --warning-readable，不得再把 --neon-cyan / --warning-accent-hover 直接写进
//      color / border-color（装饰性填充不受限）。改一行配色就会在这里红，而不是等用户截图。
import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

const ROOT = join(__dirname, '..');
const THEMES_DIR = join(ROOT, 'src/styles/themes');
const STYLE_CSS = join(ROOT, 'src/style.css');

// 前景配对的消费点（问答页三处入口，含悬浮问答，同一套 token 口径）
const QA_FILES = ['src/views/Query.vue', 'src/components/MessageToolbar.vue', 'src/components/FloatingChat.vue'];

const stripComments = (css: string) => css.replace(/\/\*[\s\S]*?\*\//g, '');

function parseDecls(css: string): Map<string, string> {
  const out = new Map<string, string>();
  for (const m of css.matchAll(/(--[\w-]+)\s*:\s*([^;]+);/g)) {
    if (!out.has(m[1])) out.set(m[1], m[2].trim());
  }
  return out;
}

interface ThemeTokens {
  name: string;
  decls: Map<string, string>;
}

/** :root 兜底主题 + styles/themes/ 下每个主题；主题未声明的 token 回落 :root（与浏览器一致） */
function loadThemes(): ThemeTokens[] {
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

// ---------- 颜色实算 ----------
interface RGB { r: number; g: number; b: number; a: number }

function hexToRgb(h: string): RGB {
  let x = h.replace('#', '');
  if (x.length === 3) x = x.split('').map((c) => c + c).join('');
  return { r: parseInt(x.slice(0, 2), 16), g: parseInt(x.slice(2, 4), 16), b: parseInt(x.slice(4, 6), 16), a: x.length === 8 ? parseInt(x.slice(6, 8), 16) / 255 : 1 };
}
const rgbToHex = (c: RGB) => '#' + [c.r, c.g, c.b].map((v) => Math.round(v).toString(16).padStart(2, '0')).join('');

/** 解析 var() 链（含嵌套 fallback）与 rgba()/hex，返回可用于合成的实色或渐变端点 */
function resolve(expr: string, decls: Map<string, string>, depth = 0): { solid: RGB } | { stops: RGB[] } {
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
function splitTopLevel(s: string): string[] {
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

function composite(fg: RGB, bg: RGB): RGB {
  const a = fg.a;
  return { r: fg.r * a + bg.r * (1 - a), g: fg.g * a + bg.g * (1 - a), b: fg.b * a + bg.b * (1 - a), a: 1 };
}
function luminance(c: RGB): number {
  const f = (v: number) => {
    const s = v / 255;
    return s <= 0.03928 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4;
  };
  return 0.2126 * f(c.r) + 0.7152 * f(c.g) + 0.0722 * f(c.b);
}
function contrast(a: RGB, b: RGB): number {
  const l1 = luminance(a);
  const l2 = luminance(b);
  return (Math.max(l1, l2) + 0.05) / (Math.min(l1, l2) + 0.05);
}

/** 前景表达式对「所在面」的最差对比度：渐变面逐端点取最小值 */
function worstRatio(fgExpr: string, bgExpr: string, decls: Map<string, string>, page: RGB): number {
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

const themes = loadThemes();

/**
 * 审计清单：每行 = 问答页一个真实可见的前景消费点。
 * surface 用「表达式」而不是硬编码色值，主题改 token 会立刻反映到数值上。
 * kind=text 阈值 4.5（AA 正常字号），kind=ui 阈值 3.0（WCAG 1.4.11 非文本控件）。
 */
const AUDIT: Array<{ label: string; fg: string; bg: string; kind: 'text' | 'ui' }> = [
  // —— 本单主诉：用户气泡内的重新发送/取消按钮（T04175 修复前 1.01～2.52:1）——
  { label: '编辑态·确认发送 文字', fg: 'var(--accent-readable)', bg: 'var(--bg-card-solid)', kind: 'text' },
  { label: '编辑态·确认发送 描边', fg: 'var(--accent-readable)', bg: 'var(--bg-card-solid)', kind: 'ui' },
  { label: '编辑态·确认发送 hover', fg: 'var(--accent-readable)', bg: 'var(--accent-cyan-a12)', kind: 'text' },
  { label: '编辑态·取消 文字', fg: 'var(--text-base)', bg: 'var(--bg-card-solid)', kind: 'text' },
  // 描边即按钮可见轮廓（WCAG 1.4.11 按非文本控件 3:1）——用 --text-soft 而不是主题淡边框色，
  // 淡边框（#e6e8ec 级）在白卡片上只有 1.1:1，等于「按钮没有边界」
  { label: '编辑态·取消 描边', fg: 'var(--text-soft)', bg: 'var(--bg-card-solid)', kind: 'ui' },
  { label: '编辑态·取消 hover 描边', fg: 'var(--accent-readable)', bg: 'var(--bg-card-solid)', kind: 'ui' },
  // —— 同页横向排查：强调色当前景的 hover/active 态 ——
  { label: '工具栏图标 hover', fg: 'var(--accent-readable)', bg: 'var(--accent-cyan-a18)', kind: 'text' },
  { label: '工具栏图标 active', fg: 'var(--accent-readable)', bg: 'var(--accent-cyan-a25)', kind: 'text' },
  { label: '工具栏图标 静息', fg: 'var(--text-soft)', bg: 'var(--bg-card-solid)', kind: 'ui' },
  { label: '排队取消 静息文字', fg: 'var(--text-base)', bg: 'var(--bg-card-solid)', kind: 'text' },
  { label: '排队取消 hover', fg: 'var(--accent-readable)', bg: 'var(--bg-card-solid)', kind: 'text' },
  { label: '联想追问 chip 文字', fg: 'var(--accent-readable)', bg: 'var(--accent-cyan-a10)', kind: 'text' },
  { label: '代码块语言徽章', fg: 'var(--accent-readable)', bg: 'var(--accent-cyan-a12)', kind: 'text' },
  { label: '引用角标 [n]', fg: 'var(--accent-readable)', bg: 'var(--accent-cyan-a06)', kind: 'text' },
  { label: '侧栏展开按钮图标', fg: 'var(--accent-readable)', bg: 'var(--accent-cyan-a10)', kind: 'ui' },
  // —— 超时/失败条：琥珀提示文字（修复前浅底主题 1.55～1.71:1）——
  { label: '超时条·提示文字', fg: 'var(--warning-readable)', bg: 'var(--warning-accent-soft)', kind: 'text' },
  { label: '超时条·重发按钮文字', fg: 'var(--warning-accent-ink)', bg: 'var(--warning-accent)', kind: 'text' },
  { label: '超时条·重发按钮 hover', fg: 'var(--warning-accent-ink)', bg: 'var(--warning-accent-hover)', kind: 'text' },
  // —— 编辑框自身（本来就有独立面，留作配对回归锁）——
  { label: '编辑态·输入框文字', fg: 'var(--text-bright)', bg: 'var(--bg-input)', kind: 'text' },
];

const THRESHOLD = { text: 4.5, ui: 3.0 };

/**
 * 所在页的可见底：卡片是半透明的，真实落点是 --bg-void 之上（浏览器就是这么合成的）。
 * 直接拿 --bg-card-solid 当不透明底会让深色主题的卡片偏亮，判定随之失真。
 */
function pageOf(decls: Map<string, string>): RGB {
  const base = resolve('var(--bg-void)', decls);
  const page = 'stops' in base ? base.stops[0] : base.solid;
  const card = resolve('var(--bg-card-solid)', decls);
  if ('stops' in card) throw new Error('卡片面不应是渐变');
  return composite(card.solid, page);
}

describe('T04175 主题 token 解析', () => {
  it('主题清单齐全（防目录变化导致用例空转）', () => {
    expect(themes.length).toBeGreaterThanOrEqual(8);
    expect(themes.map((t) => t.name)).toContain('light-business');
  });

  it('每个主题的 --accent-readable / --warning-readable 都能解析成实色', () => {
    for (const t of themes) {
      for (const token of ['--accent-readable', '--warning-readable']) {
        const r = resolve(`var(${token})`, t.decls);
        if ('stops' in r) throw new Error(`${t.name} 的 ${token} 解析成了渐变`);
        expect(r.solid.a, `${t.name} ${token} 不得是半透明前景`).toBe(1);
      }
    }
  });

  it('浅底主题的 readable 值锁定为实测压暗值（防止被改回原亮色）', () => {
    const hexOf = (name: string, token: string) => {
      const t = themes.find((x) => x.name === name)!;
      const r = resolve(`var(${token})`, t.decls);
      if ('stops' in r) throw new Error('不该是渐变');
      return rgbToHex(r.solid);
    };
    // 取「对最紧的 --accent-cyan-a25 淡底也 ≥4.6:1」的最小压暗值（卡片面普遍 5.1–6.5:1）
    expect(hexOf('ecommerce', '--accent-readable')).toBe('#006b93');
    expect(hexOf('enterprise', '--accent-readable')).toBe('#046e80');
    expect(hexOf('light-business', '--accent-readable')).toBe('#1554d1');
    expect(hexOf('macaron', '--accent-readable')).toBe('#2b7a6e');
    expect(hexOf('portfolio', '--accent-readable')).toBe('#786349');
    // readable 必须比原强调色更暗或相同（浅底主题只允许压暗，不允许提亮成霓虹）
    for (const name of ['ecommerce', 'enterprise', 'light-business', 'macaron', 'portfolio']) {
      const acc = resolve(`var(--accent-readable)`, themes.find((x) => x.name === name)!.decls);
      const cyan = resolve(`var(--neon-cyan)`, themes.find((x) => x.name === name)!.decls);
      if ('stops' in acc || 'stops' in cyan) throw new Error('不该是渐变');
      expect(luminance(acc.solid), `${name} readable 应 ≤ 原强调色亮度`).toBeLessThanOrEqual(luminance(cyan.solid) + 1e-6);
    }
  });
});

describe('T04175 问答页前景对比度（逐主题逐面）', () => {
  for (const t of themes) {
    it(`${t.name}：全部消费点达 WCAG AA`, () => {
      const page = pageOf(t.decls);
      const bad: string[] = [];
      for (const row of AUDIT) {
        // 半透明面（tint）先与页面底合成，再与前景合成
        const ratio = worstRatio(row.fg, row.bg, t.decls, page);
        if (ratio < THRESHOLD[row.kind]) {
          bad.push(`${row.label}(${row.kind}) = ${ratio.toFixed(2)}:1 < ${THRESHOLD[row.kind]}:1`);
        }
      }
      expect(bad, `${t.name} 低对比消费点清单`).toEqual([]);
    });
  }

  it('用户气泡（--grad-fire）仍是渐变面：靠独立操作条面承载按钮，不靠前景色硬扛', () => {
    // 这条锁住「修复路线没有被改回给按钮配前景色」：一旦 .msg-edit-actions 不再自带不透明面，
    // 按钮就又回到 --grad-fire 上，本清单的 4.5:1 判定失去意义。
    for (const f of QA_FILES.slice(0, 1)) {
      const css = readFileSync(join(ROOT, f), 'utf8');
      const start = css.indexOf('.msg-edit-actions {');
      expect(start, '缺少 .msg-edit-actions 规则块').toBeGreaterThanOrEqual(0);
      // 只截本规则块（到最近的块尾），否则后面的 .edit-btn{background:transparent} 会误判
      const block = css.slice(start, css.indexOf('\n}', start));
      expect(block).toMatch(/background:\s*var\(--bg-card-solid/);
      expect(block).not.toMatch(/background:\s*transparent/);
    }
  });
});

describe('T04175 前景口径守护（问答页不得再把强调色直接当前景）', () => {
  const colorDecl = /^\s*(?:color|border-color|--el-button-hover-text-color)\s*:\s*(.+);$/gm;

  for (const f of QA_FILES) {
    it(`${f}：--neon-cyan / --warning-accent-hover 只允许作为 readable 的 fallback 出现`, () => {
      const src = readFileSync(join(ROOT, f), 'utf8');
      const violations: string[] = [];
      for (const m of src.matchAll(colorDecl)) {
        const value = m[1];
        const rawAccent = /var\(\s*--neon-cyan\b/.test(value) && !/--accent-readable/.test(value);
        const rawWarn = /var\(\s*--warning-accent-hover\b/.test(value) && !/--warning-readable/.test(value);
        if (rawAccent || rawWarn) violations.push(`${f} → ${value}`);
      }
      expect(violations).toEqual([]);
    });
  }

  it('扫描确实覆盖到消费点（防止正则失配导致空转）', () => {
    let hits = 0;
    for (const f of QA_FILES) {
      hits += [...readFileSync(join(ROOT, f), 'utf8').matchAll(colorDecl)].filter((m) => m[1].includes('--accent-readable')).length;
    }
    expect(hits).toBeGreaterThanOrEqual(25);
  });

  // 上面的数值用例审「token 口径」，本用例审「选择器 ↔ token 配对」：
  // 只保证「用了 readable」不够，还得保证「用对那个 readable」——
  // 例如超时提示误用 --accent-readable（青）而不是 --warning-readable（琥珀），
  // 数值照样达标，但语义/告警可见性坏了，故此处按选择器逐条锁死。
  const KEY_PAIRINGS: Array<{ file: string; selector: string; mustInclude: string }> = [
    { file: QA_FILES[0], selector: '.timeout-resend-tip', mustInclude: '--warning-readable' },
    { file: QA_FILES[0], selector: '.edit-btn.confirm', mustInclude: '--accent-readable' },
    { file: QA_FILES[0], selector: '.queue-cancel:hover', mustInclude: '--accent-readable' },
    { file: QA_FILES[1], selector: '.toolbar-btn.active', mustInclude: '--accent-readable' },
  ];
  for (const { file, selector, mustInclude } of KEY_PAIRINGS) {
    it(`${selector} 使用 ${mustInclude}`, () => {
      const css = readFileSync(join(ROOT, file), 'utf8');
      const start = css.indexOf(`${selector} {`);
      expect(start, `缺少 ${selector} 规则块`).toBeGreaterThanOrEqual(0);
      const block = css.slice(start, css.indexOf('\n}', start));
      expect(block).toMatch(new RegExp(`:\\s*var\\(\\s*${mustInclude.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\b`));
    });
  }
});
