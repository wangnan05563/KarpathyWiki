// T04470 口径推广·批次 A4：问答页（Query.vue 8 处裸基色 + 1 处前组错族回补）。
// 与前五组/A1~A3 同一缺陷族：为深色霓虹底设计的强调色基名（--neon-purple / --neon-magenta /
// --neon-cyan）被直接写进 color / border(-color)，在浅底主题的淡 tint 面上跌破 AA。
//
// 本批三点新内容：
// ① **两个新落点面** `--accent-purple-a18`（联想 chip hover）与 `--accent-magenta-a05`
//    （中间件 trigger hover）此前都不在既有校准样本里，接入前逐主题实算（D:/code/tmp/t04470/a4matrix.log
//    + a4beforeafter.log）：8 个裸基色点 × 各自面/口径，接入前 **28 个「主题 × 面」未达标组合**
//    （最惨 macaron 1.42~2.07、ecommerce 2.25~2.72、portfolio 1.63~2.13），接入后 0 处未达标、
//    全批最差 4.67（紫 readable × 紫 a18 @macaron，连文字口径都过）。
// ② 本批 **8 处全部同族可达标**，没有出现 A2 那种被逼换族的情况——因为本批的文字点本来就落在
//    与自身色相同族的 tint 上（紫字压紫面、magenta 字压 magenta 面）。
// ③ **前组遗留的错族回补**：`.suggestion-chip:hover` 的 color 早在 T04175（a187201）就接成了
//    `--accent-readable`（青族），但它压在**自身** `--accent-purple-a18` 紫面上——当时 portfolio
//    的紫族仍是墨色 tint，实测青 readable × 紫 a18 只有 4.33 < 4.5（该 chip 文字 13px，走文字口径）。
//    这一处不在 163 处裸基色账里（已被 readable 包裹，索引锁看不见），是工单硬条件 2 预判的
//    「落到紫面就会撞上」的真实现场，故按 A2 确立的「按面选族」在本批一并回补为紫族，
//    并把原青族链保留在 fallback 位。T04462 把 portfolio 紫族改成真紫 #6b5b95 后，该面升到 4.91，
//    换族不再是达标刚需，但保留紫族可与 hover 描边同族，故不回退。
//    ⚠ 视觉定调随之变化：chip hover 的文字由青转紫（与 hover 描边同族），需人工目视抽验。
//
// 档位边界（本批实算划出，防止下批「见紫面就无脑换族」）：
//   青 readable × 紫 **a12** 全 8 主题 ≥ 4.5（A3 据此保留青族，结论仍成立）；
//   青 readable × 紫 **a18**：T04462 前 portfolio 4.33 < 4.5 是本批换族触发点；改真紫后全档 ≥ 4.5；
//   青 readable × 紫 **a25** 仍存在跌破，档位原则继续成立。
//   即「是否必须同族」取决于 tint 档位深浅，不是取决于「面叫什么名」——故本文件把三条对照都写成断言常驻。
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
  worstRatio,
  type AuditRow,
} from './helpers/contrast';

const FILE = 'src/views/Query.vue';
const PAGE = '问答页';

const BASE_TOKENS = [
  /^--neon-cyan$/,
  /^--neon-pink$/,
  /^--accent-pink$/,
  /^--neon-magenta$/,
  /^--neon-purple$/,
  /^--accent-purple$/,
];

const PURPLE_A05 = 'var(--accent-purple-a05)';
const PURPLE_A12 = 'var(--accent-purple-a12)';
const PURPLE_A18 = 'var(--accent-purple-a18)';
const PURPLE_A25 = 'var(--accent-purple-a25)';
const MAGENTA_A05 = 'var(--accent-magenta-a05)';
const CYAN_A08 = 'var(--accent-cyan-a08)';
const CARD_SOLID = 'var(--bg-card-solid)';

/** 逐面清单：前 9 行 = 本批 9 个真实消费点，后 2 行 = 叠底方向不确定时的保守下界 */
const AUDIT: AuditRow[] = [
  { label: `${PAGE}·.suggestion-chip:hover [border-color·purple]`, fg: 'var(--purple-readable)', bg: PURPLE_A18, kind: 'ui' },
  { label: `${PAGE}·.suggestion-chip:hover [color·purple（前组错族回补）]`, fg: 'var(--purple-readable)', bg: PURPLE_A18, kind: 'text' },
  { label: `${PAGE}·.search-progress [border-left·accent]`, fg: 'var(--accent-readable)', bg: CYAN_A08, kind: 'ui' },
  { label: `${PAGE}·.output-modes-trigger:hover [border-color·purple]`, fg: 'var(--purple-readable)', bg: PURPLE_A05, kind: 'ui' },
  { label: `${PAGE}·.output-modes-trigger:hover [color·purple]`, fg: 'var(--purple-readable)', bg: PURPLE_A05, kind: 'text' },
  { label: `${PAGE}·.middlewares-trigger:hover [border-color·pink]`, fg: 'var(--pink-readable)', bg: MAGENTA_A05, kind: 'ui' },
  { label: `${PAGE}·.middlewares-trigger:hover [color·pink]`, fg: 'var(--pink-readable)', bg: MAGENTA_A05, kind: 'text' },
  { label: `${PAGE}·.advanced-toggle:hover [color·purple]`, fg: 'var(--purple-readable)', bg: PURPLE_A12, kind: 'text' },
  { label: `${PAGE}·.advanced-toggle.active [color·purple]`, fg: 'var(--purple-readable)', bg: PURPLE_A18, kind: 'text' },
  // —— 保守下界：trigger/toggle 系半透明 tint，实测父容器可能是玻璃卡也可能是不透明弹窗底，两头都钉 ——
  { label: `${PAGE}·.advanced-toggle.active [color·purple·弹窗底下界]`, fg: 'var(--purple-readable)', bg: CARD_SOLID, kind: 'text' },
  { label: `${PAGE}·.middlewares-trigger:hover [color·pink·弹窗底下界]`, fg: 'var(--pink-readable)', bg: CARD_SOLID, kind: 'text' },
];

/**
 * 接入前的裸基色事实（8 个点 × 各自面 / 各自口径）。
 * 这条锁的意义：证明本批不是「顺手活」——把这 8 行退回裸色，8 主题里会实打实红 28 个组合。
 */
const BEFORE: AuditRow[] = [
  { label: 'B1 chip:hover border × 紫a18', fg: 'var(--neon-purple)', bg: PURPLE_A18, kind: 'ui' },
  { label: 'B2 search-progress border-left × 青a08', fg: 'var(--neon-cyan)', bg: CYAN_A08, kind: 'ui' },
  { label: 'B3 output border × 紫a05', fg: 'var(--neon-purple)', bg: PURPLE_A05, kind: 'ui' },
  { label: 'B4 output color × 紫a05', fg: 'var(--neon-purple)', bg: PURPLE_A05, kind: 'text' },
  { label: 'B5 middlewares border × maga05', fg: 'var(--neon-magenta)', bg: MAGENTA_A05, kind: 'ui' },
  { label: 'B6 middlewares color × maga05', fg: 'var(--neon-magenta)', bg: MAGENTA_A05, kind: 'text' },
  { label: 'B7 advanced:hover color × 紫a12', fg: 'var(--neon-purple)', bg: PURPLE_A12, kind: 'text' },
  { label: 'B8 advanced.active color × 紫a18', fg: 'var(--neon-purple)', bg: PURPLE_A18, kind: 'text' },
];
const BEFORE_FAILURES = 28;

/** 本批接入后的源码原文（逐条点名；任何一条被回退即红） */
const WRAPPED_LINES: string[] = [
  '  border-color: var(--purple-readable, var(--neon-purple));',
  '  border-left: 2px solid var(--accent-readable, var(--neon-cyan));',
  '  border-color: var(--purple-readable, var(--neon-purple, #b226ff));',
  '  color: var(--purple-readable, var(--neon-purple, #b226ff));',
  '  border-color: var(--pink-readable, var(--neon-magenta, #ff00ff));',
  '  color: var(--pink-readable, var(--neon-magenta, #ff00ff));',
  '  color: var(--purple-readable, var(--accent-readable, var(--neon-cyan, #00f5ff)));',
];

/** 接入后各家族在本文件的出现次数（含回补点里作为 fallback 保留的青族链，可整文件核对） */
const FAMILY_COUNTS: Record<string, number> = { accent: 33, purple: 11, pink: 6 };
// T04468：18 处 tint 描边已接入 readable；余 2 处是 `var(--border-glass, var(--accent-*-aNN, ...))`
// （--border-glass 恒有定义，aNN 不可达，见 contrast-tint-stroke.test.ts 头注），基线停在 2 防新增。
const TINT_BASELINE = 2;

const famCount = (src: string, fam: string) => (src.match(new RegExp(`--${fam}-readable`, 'g')) || []).length;
const srcOf = () => readFileSync(join(ROOT, FILE), 'utf8');
const rowsOf = () => AUDIT.filter((r) => r.label.startsWith(`${PAGE}·`) && !/下界/.test(r.label));

describe('T04470 批次 A4：逐主题达标', () => {
  it(`8 主题 × ${AUDIT.length} 面（含 2 条保守下界）全部达 AA（文本 4.5 / 非文本 3.0）`, () => {
    const failures = auditThemes(AUDIT, loadThemes());
    expect(failures, formatFailures(failures)).toEqual([]);
  });

  it(`接入前确有 ${BEFORE_FAILURES} 个未达标组合（本批不是顺手活）`, () => {
    const failures = auditThemes(BEFORE, loadThemes());
    expect(failures.length, formatFailures(failures)).toBe(BEFORE_FAILURES);
  });

  it('档位边界成立：青 readable × 紫 a12/a18 全档达标、× 紫 a25 仍跌破（按档判，不是见紫面就换族）', () => {
    const themes = loadThemes();
    const at = (bg: string) =>
      themes.map((t) => ({ th: t.name, v: worstRatio('var(--accent-readable)', bg, t.decls, pageOf(t.decls)) }));
    const a12 = at(PURPLE_A12);
    const a18 = at(PURPLE_A18);
    const a25 = at(PURPLE_A25);
    // a12 全档 ≥ 4.5 → A3 保留青族的结论仍然成立
    expect(Math.min(...a12.map((c) => c.v))).toBeGreaterThanOrEqual(THRESHOLD.text);
    // T04462：紫族 base 由墨色 #1a1a1a 改为 #6b5b95 后 tint 不再把面压黑，
    // a18 也全档达标（最紧 macaron 4.50 / portfolio 4.91）→ 本批不再由 portfolio 触发换族；
    // chip hover 仍保留紫族，是为了与同族 hover 描边保持一致（见文件头 ③）。
    expect(Math.min(...a18.map((c) => c.v)), a18.map((c) => `${c.th}=${c.v.toFixed(2)}`).join(' ')).toBeGreaterThanOrEqual(THRESHOLD.text);
    expect(a18.find((c) => c.th === 'portfolio')!.v, 'portfolio a18 已不再是触发主题').toBeGreaterThanOrEqual(THRESHOLD.text);
    // 档位原则仍成立：再深一档 a25 仍有主题跌破，说明「是否必须同族」取决于面深，不是面名
    const bad = a25.filter((c) => c.v < THRESHOLD.text);
    expect(bad.length, a25.map((c) => `${c.th}=${c.v.toFixed(2)}`).join(' ')).toBeGreaterThanOrEqual(1);
  });

  it('清单规模与本批实现严格对齐（9 个真实点），接入原文逐条点名', () => {
    expect(rowsOf().length).toBe(9);
    const src = srcOf();
    for (const line of WRAPPED_LINES) {
      const hits = src.split(/\r?\n/).filter((l) => l === line).length;
      expect(hits, `应至少有一条 ${JSON.stringify(line)}，实测 ${hits} 条`).toBeGreaterThanOrEqual(1);
    }
    // 三处相同的紫色文字声明（output hover / advanced hover / advanced active）必须一起在场
    expect(src.split(/\r?\n/).filter((l) => l === '  color: var(--purple-readable, var(--neon-purple, #b226ff));').length).toBe(3);
  });

  it('逐族消费点数与账一致（接错家族或漏接会被点名）', () => {
    const src = srcOf();
    for (const [fam, n] of Object.entries(FAMILY_COUNTS)) {
      expect(famCount(src, fam), `${FILE} · --${fam}-readable 应有 ${n} 处`).toBe(n);
    }
  });

  it('回补点专项：chip hover 文字必须以紫族领头、青族链留在 fallback（防被改回青族）', () => {
    const line = srcOf().split(/\r?\n/).find((l) => /--purple-readable, var\(--accent-readable/.test(l)) || '';
    expect(line.trim(), '缺少「紫 readable → 青 readable → 基色」三级 fallback').toMatch(
      /^color: var\(--purple-readable, var\(--accent-readable, var\(--neon-cyan, #00f5ff\)\)\);$/,
    );
  });

  it('包裹表达式括号平衡且行尾分号未丢（防止接入器吃掉字符）', () => {
    const src = srcOf();
    // 只看「像声明」的行：Query.vue 里有注释直接写了 --accent-readable（T04175 的说明），
    // 注释行没有行尾分号是常态，把它算进来会造出一条永远修不掉的假红。
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

describe('T04470 批次 A4：口径守护（基色不得再裸写进前景）', () => {
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

  it('扫描确实覆盖到消费点（防止口径空转）', () => {
    const src = srcOf();
    expect([...src.matchAll(/-readable/g)].length).toBeGreaterThanOrEqual(FAMILY_COUNTS.accent + FAMILY_COUNTS.purple + FAMILY_COUNTS.pink);
  });
});
