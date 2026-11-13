// T04468 裁决实施·收口锁：全站 border 族描边（`border`/`border-color`/四边简写）逐主题实算。
//
// 裁决（2026-11-06）：「装饰性 tint 分隔线/描边算界面状态图形，WCAG 1.4.11 必须 ≥3:1；基线收紧、纳入全站索引」。
// 本文件是这条裁决的**全站账本**：
//  ① tint 描边（值链首变量是 `--accent-*-aNN` 且非 readable）必须为 0——整改后不再允许新增；
//  ② 现存 readable 描边必须逐主题 × 所在面 ≥3:1（非文本 3.0，不放宽）；
//  ③ 扫描器自证：入围数钉死、全部可解析、落点键唯一，防 glob/正则失配把锁变空转。
//
// 与既有账本的边界：
//  - 只计 border 族。`color` 消费 tint 的装饰前景仍冻结在各 sweep 的「只降不升」基线里（T04468 未改其色）。
//  - 字面色描边（hex/rgba 直写）归 contrast-sweep-literal-fg 的 STROKE_FAIL_BASELINE，不在本账。
//  - 移动端 --m-* 描边归 contrast-sweep-mobile 的集合锁，本账不含 mobile 目录。
//  - `var(--border-glass, var(--accent-*-aNN, ...))` 两处（Query .msg-edit/.edit-actions）不计：--border-glass
//    各主题恒有定义且是 `1px solid ...` 简写，该声明于计算值阶段失效（描边实际走 currentColor），aNN 是不可达兜底。
import { describe, expect, it } from 'vitest';
import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import {
  ROOT,
  THRESHOLD,
  loadThemes,
  loadAuxTheme,
  pageOf,
  worstRatio,
  styleText,
  stripComments,
  iterRules,
  type AuditFailure,
} from './helpers/contrast';

const BORDER_PROP = /^(?:border(?:-(?:left|right|top|bottom))?(?:-color)?|outline(?:-color)?)$/;

const walk = (dir: string, out: string[] = []): string[] => {
  for (const d of readdirSync(join(ROOT, dir), { withFileTypes: true })) {
    const rel = `${dir}/${d.name}`;
    if (d.isDirectory()) walk(rel, out);
    else if (rel.endsWith('.vue')) out.push(rel);
  }
  return out;
};
/** 与 contrast-sweep-index 收口锁同范围再补 App.vue；mobile 目录归 T04467 独立口径 */
const FILES = [...walk('src/views'), ...walk('src/components'), 'src/App.vue']
  .filter((f) => !f.startsWith('src/components/mobile/'))
  .sort();

const src = (f: string) => readFileSync(join(ROOT, f), 'utf8');
const clean = (v: string) => v.replace(/!important/i, '').trim().replace(/\s+/g, ' ');

/** 取描边颜色链的**第一个** var()：`1px solid var(...)` 里宽度/线型在前；没有 var 的（none/hex）不入围 */
function firstVar(value: string): string | null {
  const v = clean(value);
  const at = v.search(/var\(/);
  if (at < 0) return null;
  let depth = 0;
  for (let i = at; i < v.length; i++) {
    if (v[i] === '(') depth++;
    else if (v[i] === ')' && --depth === 0) return v.slice(at, i + 1);
  }
  return v.slice(at);
}
const TINT_FIRST = /^var\(\s*--accent-[\w-]+-a\d\d\b/;
const READABLE_FIRST = /^var\(\s*--[\w-]+-readable\b/;

/* ---- 面口径：与 T04509 普查同一链（同规则自声明底 → Element 输入面 → 同控件底 → 库白 → 卡片底） ---- */
const EL_SOLID_WHITE = /\.el-(button|input|textarea|dialog|message|tree|select|cascader|upload-dragger|popover|drawer|card|table|dropdown|alert)/;
function siblingBg(fileCss: string, sel: string): string | null {
  const bare = sel.replace(/\[data-theme[^\]]*\]/g, '').trim();
  const cls = /\.el-[\w-]+|\.[\w-]+/.exec(bare);
  if (!cls) return null;
  for (const r of iterRules(fileCss)) {
    if (!r.sel.includes(cls[0])) continue;
    const m = /(?:^|;)\s*(?:background|background-image|background-color)\s*:\s*([^;]+)/i.exec(r.body);
    if (!m) continue;
    const v = clean(m[1]);
    if (v === 'none' || v === 'transparent') continue;
    return v;
  }
  return null;
}

const EL_INPUT_MARK = '@el-input';
/**
 * Element 输入控件的真实面在库/主题样式里（.el-input__wrapper / .el-textarea__inner 的 background），
 * 页面文件里只有内层 .el-input__inner 的规则，故按主题取实测值（!important 的 wrapper 底，库变量被压过）：
 *   default/creative/dark → style.css:726 rgba(22,10,45,0.3)（creative 与 tokens.css 未覆盖）
 *   其余 → 各主题 css 的 .el-input__wrapper 段（行号见下）
 */
const EL_INPUT_FACE: Record<string, string> = {
  'default(:root)': 'rgba(22, 10, 45, 0.3)',
  creative: 'rgba(22, 10, 45, 0.3)',
  'dark(tokens.css)': 'rgba(22, 10, 45, 0.3)',
  ecommerce: '#ffffff', // themes/ecommerce.css:329
  enterprise: 'rgba(255, 255, 255, 0.9)', // themes/enterprise.css:328
  'light-business': '#ffffff', // themes/light-business.css:363
  macaron: 'rgba(255, 255, 255, 0.8)', // themes/macaron.css:322
  portfolio: 'rgba(255, 252, 247, 0.9)', // themes/portfolio.css:339
  product: 'rgba(0, 0, 0, 0.6)', // themes/product.css:291
};

function faceOf(fileCss: string, sel: string, body: string): string {
  const own = /(?:^|;)\s*(?:background|background-image|background-color)\s*:\s*([^;]+)/i.exec(body);
  if (own) {
    const v = clean(own[1]);
    // 显式 transparent/none：元素自身透到宿主面——同元素基类底已被本条覆盖，不能再回落 sibling
    // （Users .neon-btn.secondary 的 var(--on-fire-bg) 就来自被它自己 transparent 覆盖的 .neon-btn）
    if (v === 'transparent' || v === 'none') return 'var(--bg-card-solid)';
    return v;
  }
  // 状态选择器（:hover/:focus/...）不改 background 时，元素底色由同元素的无状态规则决定；
  // 该规则若写了 transparent，面同样是宿主——不能去 siblingBg 里捞基类（.neon-btn 的 fire 底已被覆盖）
  const baseSel = sel.trim().replace(/(?::(?:hover|focus|focus-visible|active|disabled|first-child|last-child|not\([^)]*\)))+$/g, '');
  if (baseSel !== sel.trim()) {
    const baseRule = iterRules(fileCss).find((r) => r.sel.trim() === baseSel);
    const bm = baseRule && /(?:^|;)\s*(?:background|background-image|background-color)\s*:\s*([^;]+)/i.exec(baseRule.body);
    if (bm) {
      const v = clean(bm[1]);
      return v === 'transparent' || v === 'none' ? 'var(--bg-card-solid)' : v;
    }
  }
  // 内层选择器可能被 :deep(...) 包一层（`:deep(.el-input__inner)`），尾随一个 `)`
  if (/\.el-(?:input__inner|textarea__inner)\)?$/.test(sel.trim())) return EL_INPUT_MARK;
  const sib = siblingBg(fileCss, sel);
  if (sib) return sib;
  if (EL_SOLID_WHITE.test(sel)) return '#ffffff';
  return 'var(--bg-card-solid)';
}

interface StrokeSite {
  file: string;
  sel: string;
  prop: string;
  fg: string;
  bg: string;
}
function collect(): { tint: StrokeSite[]; readable: StrokeSite[] } {
  const tint: StrokeSite[] = [];
  const readable: StrokeSite[] = [];
  for (const f of FILES) {
    const css = stripComments(styleText(src(f)));
    for (const r of iterRules(css)) {
      for (const decl of r.body.split(';')) {
        const m = /^\s*([\w-]+)\s*:\s*(.+)$/.exec(decl);
        if (!m || !BORDER_PROP.test(m[1])) continue;
        const first = firstVar(m[2]);
        if (!first) continue;
        const site = { file: f, sel: r.sel, prop: m[1], fg: first, bg: faceOf(css, r.sel, r.body) };
        if (READABLE_FIRST.test(first)) readable.push(site);
        else if (TINT_FIRST.test(first)) tint.push(site);
      }
    }
  }
  return { tint, readable };
}

const THEMES = [...loadThemes(), loadAuxTheme('dark')];
interface FailRow extends AuditFailure { file: string; sel: string; prop: string; fg: string; bg: string }
function audit(sites: StrokeSite[]): { failures: FailRow[]; unparsable: string[] } {
  const failures: FailRow[] = [];
  const unparsable: string[] = [];
  for (const t of THEMES) {
    const page = pageOf(t.decls);
    for (const s of sites) {
      const bg = s.bg === EL_INPUT_MARK ? EL_INPUT_FACE[t.name] : s.bg;
      if (!bg) {
        unparsable.push(`${s.file}::${s.sel} [${t.name}] 主题 ${t.name} 缺 Element 输入面实测值`);
        continue;
      }
      try {
        const ratio = worstRatio(s.fg, bg, t.decls, page);
        if (ratio < THRESHOLD.ui) failures.push({ ...s, bg, theme: t.name, label: `${s.file}::${s.sel}::${s.prop}`, ratio, threshold: THRESHOLD.ui });
      } catch (e) {
        unparsable.push(`${s.file}::${s.sel} [${t.name}] ${(e as Error).message}`);
      }
    }
  }
  return { failures, unparsable };
}
const siteKey = (s: StrokeSite) => `${s.file} :: ${s.sel} :: ${s.prop} :: ${s.fg}`;

const { tint: TINT, readable: READABLE } = collect();
/** 整改后 readable 描边实测落点数（钉死：只降不升、改名/删规则也会红，防锁空转） */
const READABLE_SITES = 432; // T04462：RefsList .ref-item.web 描边接入 purple-readable（+1）；T04554(bf37a8f)：Browse .fm-error-alert / Health / Skill 新增 3 处 pink-readable 描边（+3）；T05723：Progress .back-to-top border + hover border-color 两处 accent-readable 描边（+2）
const { failures: FAILS, unparsable: UNPARSABLE } = audit(READABLE);

describe('T04468 · 全站 border 族描边：tint 归零 + readable 逐主题 ≥3:1', () => {
  it('A · 扫描器自证：readable 描边落点数钉死、全部可解析、键唯一', () => {
    expect(READABLE.length, 'readable 描边落点数应等于整改后实测（改了规则/改名请同步核账）').toBe(READABLE_SITES);
    // 落点键不要求唯一：@keyframes 两步可给同一 prop 同色（Query neon-pulse 0%/50%），属合法重复
    expect(new Set(READABLE.map((s) => s.file)).size, 'readable 描边应覆盖全站多文件，防 glob 失配').toBeGreaterThanOrEqual(30);
    expect(UNPARSABLE, '口径内表达式必须全部可解析，否则扫描器在静默漏判').toEqual([]);
  });

  it('B · tint 描边全站归零（T04468 裁决：纳入全站索引，新增即红）', () => {
    expect(TINT.map(siteKey), `仍有 border 族消费 --accent-*-aNN：\n  ${TINT.map(siteKey).join('\n  ')}`).toEqual([]);
  });

  it(`C · ${READABLE_SITES} 处 readable 描边 × ${THEMES.length} 主题 × 所在面全部 ≥3:1`, () => {
    expect(FAILS, FAILS.map((f) => `${f.theme} · ${f.label} = ${f.ratio.toFixed(2)}`).join('\n  ')).toEqual([]);
  });
});
