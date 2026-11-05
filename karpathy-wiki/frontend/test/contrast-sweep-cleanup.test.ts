// T04470 口径推广·批次 A5：系统清理页（Cleanup.vue 9 处）。
// 与前六批同一缺陷族：为深色霓虹底设计的强调色基名（--neon-magenta / --neon-purple）被直接写进
// color / border(-color)，在浅底主题的粉 tint 与玻璃卡片上跌破 AA。
//
// 本批三点新内容：
// ① **粉 tint 面首次成批出现**：`--accent-pink-a15`（预览横幅 / 撤销按钮 / 旧目录徽标 / 危险模式标签）
//    与 **渐变面** `linear-gradient(pink-a30 → pink-a15)`（危险按钮）此前都不在既有校准样本里。
//    逐主题实算（D:/code/tmp/t04470/a5matrix.log）：9 个裸基色点接入前共 **48 个「主题 × 面」未达标组合**
//    （裸 magenta 压粉 a15 最差 macaron 1.54、压粉渐变最差 1.43；裸紫压玻璃卡 macaron 2.14），
//    接入后 0 处未达标。
// ② **同一面在两种口径下结论相反**：危险按钮的描边坐在粉渐变上，`--pink-readable` 实测
//    非文本口径 3.95~4.39（全档 ≥3.0 过），文字口径却全 8 主题 < 4.5。该点是 1px 描边（WCAG 1.4.11），
//    按 ui 口径判定成立；若同一表达式被当成文字用就会假绿——故本文件把「这条必须留在 ui 口径」写成断言。
// ③ **口径外严重隐患留档（本批不修，后续已由 T04472 修）**：同一按钮的 `color: #fff !important` 是硬编码字面色，
//    不在本单「基色 token」口径内，实测白字 × 粉渐变在 5 个浅底主题只有 **1.08~1.24**（几乎不可见）。
//    本文件当时用一条「事实锁」把它钉在测试里，避免只活在工单正文里被遗忘；T04472 按字面色口径
//    以面级配对 token 修掉后，本文件的该条按预告改成「交接守卫」（见文末用例注释）。
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  ROOT,
  THRESHOLD,
  auditThemes,
  findBareBaseForegroundUses,
  formatFailures,
  loadThemes,
  pageOf,
  ruleBodies,
  worstRatio,
  type AuditRow,
} from './helpers/contrast';

const FILE = 'src/views/Cleanup.vue';
const PAGE = '清理页';

const BASE_TOKENS = [
  /^--neon-cyan$/,
  /^--neon-pink$/,
  /^--accent-pink$/,
  /^--neon-magenta$/,
  /^--neon-purple$/,
  /^--accent-purple$/,
];

const CARD = 'var(--bg-card)';
const CARD_SOLID = 'var(--bg-card-solid)';
const PINK_A15 = 'var(--accent-pink-a15)';
const PINK_GRADIENT = 'linear-gradient(135deg, var(--accent-pink-a30), var(--accent-pink-a15))';

/** 逐面清单：前 9 行 = 本批 9 个真实消费点，后 3 行 = 叠底方向不确定时的保守下界 */
const AUDIT: AuditRow[] = [
  { label: `${PAGE}·.advanced-toggle [color·purple]`, fg: 'var(--purple-readable)', bg: CARD, kind: 'text' },
  { label: `${PAGE}·.preview-banner [color·pink]`, fg: 'var(--pink-readable)', bg: PINK_A15, kind: 'text' },
  { label: `${PAGE}·.banner-undo [border·pink]`, fg: 'var(--pink-readable)', bg: PINK_A15, kind: 'ui' },
  { label: `${PAGE}·.banner-undo [color·pink]`, fg: 'var(--pink-readable)', bg: PINK_A15, kind: 'text' },
  { label: `${PAGE}·.advanced-path [color·purple]`, fg: 'var(--purple-readable)', bg: CARD, kind: 'text' },
  { label: `${PAGE}·.dir-legacy [color·pink]`, fg: 'var(--pink-readable)', bg: PINK_A15, kind: 'text' },
  { label: `${PAGE}·.mode-danger [color·pink]`, fg: 'var(--pink-readable)', bg: PINK_A15, kind: 'text' },
  { label: `${PAGE}·.cleanup-btn.danger [border-color·pink·渐变面]`, fg: 'var(--pink-readable)', bg: PINK_GRADIENT, kind: 'ui' },
  { label: `${PAGE}·.result-errors [color·pink]`, fg: 'var(--pink-readable)', bg: CARD, kind: 'text' },
  // —— 保守下界：未声明底的三点真实叠底可能是玻璃卡也可能是不透明弹窗/卡片实底，两头都钉 ——
  { label: `${PAGE}·.advanced-toggle [color·purple·实底下界]`, fg: 'var(--purple-readable)', bg: CARD_SOLID, kind: 'text' },
  { label: `${PAGE}·.banner-undo [color·pink·实底下界]`, fg: 'var(--pink-readable)', bg: CARD_SOLID, kind: 'text' },
  { label: `${PAGE}·.result-errors [color·pink·实底下界]`, fg: 'var(--pink-readable)', bg: CARD_SOLID, kind: 'text' },
];

/** 接入前的裸基色事实（9 个点 × 各自面 / 各自口径）：证明本批不是「顺手活」 */
const BEFORE: AuditRow[] = [
  { label: 'B636 advanced-toggle × 玻璃卡', fg: 'var(--neon-purple)', bg: CARD, kind: 'text' },
  { label: 'B662 banner × 粉a15', fg: 'var(--neon-magenta)', bg: PINK_A15, kind: 'text' },
  { label: 'B671 undo border × 粉a15', fg: 'var(--neon-magenta)', bg: PINK_A15, kind: 'ui' },
  { label: 'B673 undo color × 粉a15', fg: 'var(--neon-magenta)', bg: PINK_A15, kind: 'text' },
  { label: 'B716 advanced-path × 玻璃卡', fg: 'var(--neon-purple)', bg: CARD, kind: 'text' },
  { label: 'B768 dir-legacy × 粉a15', fg: 'var(--neon-magenta)', bg: PINK_A15, kind: 'text' },
  { label: 'B799 mode-danger × 粉a15', fg: 'var(--neon-magenta)', bg: PINK_A15, kind: 'text' },
  { label: 'B822 danger border × 粉渐变', fg: 'var(--neon-magenta)', bg: PINK_GRADIENT, kind: 'ui' },
  { label: 'B859 result-errors × 玻璃卡', fg: 'var(--neon-magenta)', bg: CARD, kind: 'text' },
];
const BEFORE_FAILURES = 48;

/** 本批接入后的源码原文（逐条点名；任何一条被回退即红） */
const WRAPPED_LINES: Array<{ line: string; count: number }> = [
  { line: '  color: var(--purple-readable, var(--neon-purple));', count: 2 },
  { line: '  color: var(--pink-readable, var(--neon-magenta));', count: 5 },
  { line: '  border: 1px solid var(--pink-readable, var(--neon-magenta));', count: 1 },
  { line: '  border-color: var(--pink-readable, var(--neon-magenta)) !important;', count: 2 },
];

/** 接入后各家族在本文件的出现次数（首组只接了青族 7 处，粉/紫全部来自本批，可整文件核对） */
// pink 8 处 = 本批 7 处 + T04472 为危险态 hover 定向钉住配对着色新增的 1 处（见 Cleanup.vue 特异性注释）。
const FAMILY_COUNTS: Record<string, number> = { accent: 7, purple: 2, pink: 8 };
/** 装饰性 tint 前景基线（只降不升；是否纳入口径属 T04468） */
const TINT_BASELINE = 14;

const famCount = (src: string, fam: string) => (src.match(new RegExp(`--${fam}-readable`, 'g')) || []).length;
const srcOf = () => readFileSync(join(ROOT, FILE), 'utf8');
const rowsOf = () => AUDIT.filter((r) => r.label.startsWith(`${PAGE}·`) && !/下界/.test(r.label));

describe('T04470 批次 A5：逐主题达标', () => {
  it(`8 主题 × ${AUDIT.length} 面（含 3 条保守下界）全部达 AA（文本 4.5 / 非文本 3.0）`, () => {
    const failures = auditThemes(AUDIT, loadThemes());
    expect(failures, formatFailures(failures)).toEqual([]);
  });

  it(`接入前确有 ${BEFORE_FAILURES} 个未达标组合（本批不是顺手活）`, () => {
    const failures = auditThemes(BEFORE, loadThemes());
    expect(failures.length, formatFailures(failures)).toBe(BEFORE_FAILURES);
  });

  it('危险按钮描边必须留在非文本口径：同面同色按文字口径会全档不达标', () => {
    const themes = loadThemes();
    const asUi = auditThemes([{ label: 'ui', fg: 'var(--pink-readable)', bg: PINK_GRADIENT, kind: 'ui' }], themes);
    const asText = auditThemes([{ label: 'text', fg: 'var(--pink-readable)', bg: PINK_GRADIENT, kind: 'text' }], themes);
    expect(asUi, formatFailures(asUi)).toEqual([]);
    // 8/8 主题在文字口径下都不达标 → 这一行的达标结论完全依赖「它是 1px 描边」这个分类，不能漂成文字
    expect(asText.length).toBe(themes.length);
  });

  it('清单规模与本批实现严格对齐（9 个真实点），接入原文逐条点名', () => {
    expect(rowsOf().length).toBe(9);
    const src = srcOf();
    for (const { line, count } of WRAPPED_LINES) {
      const hits = src.split(/\r?\n/).filter((l) => l === line).length;
      expect(hits, `${JSON.stringify(line)} 应 ${count} 条，实测 ${hits} 条`).toBe(count);
    }
  });

  it('逐族消费点数与账一致（接错家族或漏接会被点名）', () => {
    const src = srcOf();
    for (const [fam, n] of Object.entries(FAMILY_COUNTS)) {
      expect(famCount(src, fam), `${FILE} · --${fam}-readable 应有 ${n} 处`).toBe(n);
    }
  });

  it('包裹表达式括号平衡且行尾未丢（防止接入器吃掉字符）', () => {
    const src = srcOf();
    const isDecl = (l: string) => /^\s*(?:color|border|outline|--[\w-]+)[\w-]*\s*:/.test(l);
    const bad = src
      .split(/\r?\n/)
      .filter((l) => isDecl(l) && /-readable/.test(l) && (l.match(/\(/g) || []).length !== (l.match(/\)/g) || []).length);
    expect(bad, `${FILE} 有 ${bad.length} 行括号不平衡：${bad.slice(0, 3).join(' | ')}`).toEqual([]);
    const noTail = src
      .split(/\r?\n/)
      .filter((l) => isDecl(l) && /-readable/.test(l) && !/[;}]$/.test(l.replace(/\s*!important\s*$/, '').trimEnd()));
    expect(noTail, `${FILE} 有 ${noTail.length} 行 readable 声明丢了行尾：${noTail.slice(0, 3).join(' | ')}`).toEqual([]);
  });
});

describe('T04470 批次 A5：口径守护（基色不得再裸写进前景）', () => {
  it(`${FILE}：基色 token 只允许作为 *-readable 的 fallback 出现`, () => {
    expect(findBareBaseForegroundUses(srcOf(), { baseTokens: BASE_TOKENS }), `${FILE} 存在裸用基色的前景声明`).toEqual([]);
  });

  it(`${FILE}：行级兜底锁——按声明判定，前景属性引用基色却无 readable 即红`, () => {
    const bad = srcOf()
      .split(/\r?\n/)
      .flatMap((l) => l.split(';'))
      .map((seg) => seg.replace(/^[^{]*\{/, '').trim())
      .filter(
        (seg) =>
          /^(?:color|border(?:-color)?|outline(?:-color)?)\s*:/.test(seg) &&
          /var\(--(?:neon-cyan|neon-pink|neon-magenta|neon-purple|accent-pink|accent-purple)\b(?![\w-])/.test(seg) &&
          !/-readable/.test(seg),
      );
    expect(bad, `${FILE} 有裸用基色的声明：${bad.slice(0, 3).join(' | ')}`).toEqual([]);
  });

  it(`${FILE}：装饰性 tint 前景停在基线，新增即红（改它需 T04468 裁决）`, () => {
    let n = 0;
    for (const l of srcOf().split(/\r?\n/)) {
      const m = /^\s*(?:color|border-color|border(?:-(?:left|right|top|bottom))?|outline(?:-color)?)\s*:\s*([^;]*)/.exec(l);
      if (m && /var\(--accent-[\w-]+-a\d\d/.test(m[1]) && !/-readable/.test(m[1])) n++;
    }
    expect(n, `${FILE} 装饰 tint 前景应从基线 ${TINT_BASELINE} 只降不升`).toBeLessThanOrEqual(TINT_BASELINE);
  });
});

// 事实留档的后续（原注释③预告的场景已发生）：本批口径只覆盖「基色 token 裸写进前景」，硬编码字面色不在其中，
// 当时只能登记不能修。T04472 按「面级配对 token」口径把它修掉了——危险按钮的前景/底色改走
// --on-danger-tint-fg / --on-danger-tint-bg（浅底族换深墨、深底族保持白字）。
// 按原注释的约定「若这条变红说明有人把它接进了口径——那是修复，请改成断言达标，别删掉」，此处即改为达标断言。
// 数值主锁与逐主题定调在 test/contrast-sweep-hard-white.test.ts（同一落点同一口径）；本文件留最小回归：
// 事实证据不许被删（否则后人不知道为什么要配对）+ 前景不许写回硬编码白 + 配对表达式逐主题达 AA。
describe('T04470 批次 A5：口径外隐患 → 已由 T04472 面级配对修复', () => {
  it('改前事实永久留档：#fff 压粉渐变在 ≥5 个浅底主题跌破 AA（本单不修，是 T04472 的立项依据）', () => {
    const themes = loadThemes();
    const bad = themes
      .map((t) => ({ th: t.name, v: worstRatio('#fff', PINK_GRADIENT, t.decls, pageOf(t.decls)) }))
      .filter((c) => c.v < THRESHOLD.text);
    expect(bad.length, bad.map((b) => `${b.th}=${b.v.toFixed(2)}`).join(' ')).toBeGreaterThanOrEqual(5);
    expect(Math.min(...bad.map((b) => b.v))).toBeLessThan(1.5);
  });

  it('危险按钮常规态已交接给配对 token，且配对表达式 8 主题全达 AA', () => {
    const body = ruleBodies(srcOf(), '.cleanup-btn.danger');
    expect(body.length).toBe(1);
    const [b] = body as [string];
    expect(b).toContain('background: var(--on-danger-tint-bg) !important;');
    expect(b).toContain('color: var(--on-danger-tint-fg) !important;');
    // 硬编码白写回来即红：这一句是「修复不回退」的最小守卫
    expect(/color:\s*#fff/i.test(b), '.cleanup-btn.danger 的前景写回了硬编码白').toBe(false);
    const failures = auditThemes(
      [{ label: `${PAGE}·.cleanup-btn.danger [T04472 配对后]`, fg: 'var(--on-danger-tint-fg)', bg: 'var(--on-danger-tint-bg)', kind: 'text' }],
      loadThemes(),
    );
    expect(failures, formatFailures(failures)).toEqual([]);
  });
});
