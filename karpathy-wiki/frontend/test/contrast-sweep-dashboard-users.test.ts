// T04470 口径推广·批次 A3：首页（Dashboard.vue 6 处）+ 用户管理页（Users.vue 6 处）。
// 与前五组/A1/A2 同一缺陷族：为深色霓虹底设计的强调色基名（--neon-cyan / --neon-magenta /
// --neon-purple）被直接写进 color / border(-color)，在浅底主题的玻璃卡片与淡 tint 面上跌破 AA。
//
// 本批的两点新内容：
// ① **新落点面** `--bg-card`（.glass-card 半透明卡片，本批 12 处里有 7 处坐在它上面：
//    首页 4 处 + 用户页状态数字/次要按钮 hover 3 处）与 **更淡一档的紫 tint**
//    `--accent-purple-a06`（快捷入口基态底）此前都不在既有校准样本里，
//    接入前逐主题实测（D:/code/tmp/t04470/a3matrix.log）：15 个「点 × 面」里 8 主题合计
//    **54 个「主题 × 面」未达标组合**（macaron 15/15、ecommerce/enterprise 14/15、portfolio 10/15、
//    light-business 1/15——那 1 处是 .error-banner 的裸 magenta 压粉 a10 只有 4.01），
//    接入后 0 处未达标、全批最差 4.69（macaron · 快捷入口图标 × 紫 a12 描边面，非文本口径 3.0）。
// ② 首页快捷入口图标（青族）压在**紫** tint 面上——工单硬条件 2 的组合确实出现了，但实测
//    青 readable × 紫 a06/a12 最差 4.89/4.69，连文字口径 4.5 都过（图形口径 3.0 更不用说），
//    故本处保留青族色相。A2 的「紫面文字改紫 readable」前提是**更深一档的紫 a20 面**
//    （粉/青 readable × a20 在 4~5 个主题 < 4.5），由 A2 用例的正向对照锁常驻；
//    不能把那条结论类推到浅档位面——本批用同口径实算证了一遍，避免下批见到紫面就无脑换族。
//
// 口径边界（本批观察到的、不在本单口径内的 1 处）：Users.vue `.field-error :deep(.el-input__wrapper)`
// 的 `box-shadow: 0 0 0 1px var(--neon-magenta) inset` 是错误态输入框描边，视觉上是前景，
// 但本口径的前景属性表（FOREGROUND_PROPS）不含 box-shadow——不静默扩大口径，归 T04468 一并裁决。
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  ROOT,
  auditThemes,
  findBareBaseForegroundUses,
  formatFailures,
  loadThemes,
  type AuditRow,
} from './helpers/contrast';

const FILES = ['src/views/Dashboard.vue', 'src/views/Users.vue'];
const PAGE: Record<string, string> = { 'src/views/Dashboard.vue': '首页', 'src/views/Users.vue': '用户页' };
const BASE_TOKENS = [
  /^--neon-cyan$/,
  /^--neon-pink$/,
  /^--accent-pink$/,
  /^--neon-magenta$/,
  /^--neon-purple$/,
  /^--accent-purple$/,
];
/** .glass-card 的卡片面（半透明，按 pageOf 的合成底参与计算）；DIALOG 为 el-dialog 内容面（style.css .el-dialog 用 --bg-card-solid） */
const GLASS_CARD = 'var(--bg-card)';
const DIALOG = 'var(--bg-card-solid)';
const PURPLE_A06 = 'var(--accent-purple-a06)';
const PURPLE_A12 = 'var(--accent-purple-a12)';

/** 逐面清单：前 12 行 = 本批 12 个真实消费点，后 3 行 = 同一消费点在另一落点面上的保守下界 */
const AUDIT: AuditRow[] = [
  { label: '首页·.welcome-tag [color·accent]', fg: 'var(--accent-readable)', bg: GLASS_CARD, kind: 'text' },
  { label: '首页·.welcome-stats strong [color·pink]', fg: 'var(--pink-readable)', bg: GLASS_CARD, kind: 'text' },
  { label: '首页·.title-bracket [color·pink]', fg: 'var(--pink-readable)', bg: GLASS_CARD, kind: 'text' },
  { label: '首页·.dir-count [color·accent]', fg: 'var(--accent-readable)', bg: GLASS_CARD, kind: 'text' },
  { label: '首页·.shortcut-item:hover [border-color·purple]', fg: 'var(--purple-readable)', bg: PURPLE_A12, kind: 'ui' },
  { label: '首页·.shortcut-icon [color·accent·基态紫 a06 面]', fg: 'var(--accent-readable)', bg: PURPLE_A06, kind: 'ui' },
  { label: '用户页·.status-value [color·accent]', fg: 'var(--accent-readable)', bg: GLASS_CARD, kind: 'text' },
  { label: '用户页·.error-banner [color·pink]', fg: 'var(--pink-readable)', bg: 'var(--accent-pink-a10)', kind: 'text' },
  { label: '用户页·.role-user [color·accent]', fg: 'var(--accent-readable)', bg: 'var(--accent-cyan-a10)', kind: 'text' },
  { label: '用户页·.field-error-text [color·pink]', fg: 'var(--pink-readable)', bg: DIALOG, kind: 'text' },
  { label: '用户页·.neon-btn.secondary:hover [color·accent]', fg: 'var(--accent-readable)', bg: GLASS_CARD, kind: 'text' },
  { label: '用户页·.neon-btn.secondary:hover [border-color·accent]', fg: 'var(--accent-readable)', bg: GLASS_CARD, kind: 'ui' },
  // —— 保守下界：图标 hover 会换到更深的紫 a12；次要按钮同时出现在卡片头与弹窗页脚（面不同），两头都钉 ——
  { label: '首页·.shortcut-icon [color·accent·hover 紫 a12 下界]', fg: 'var(--accent-readable)', bg: PURPLE_A12, kind: 'ui' },
  { label: '用户页·.neon-btn.secondary:hover [color·accent·弹窗底下界]', fg: 'var(--accent-readable)', bg: DIALOG, kind: 'text' },
  { label: '用户页·.neon-btn.secondary:hover [border-color·accent·弹窗底下界]', fg: 'var(--accent-readable)', bg: DIALOG, kind: 'ui' },
];

/** 本批接入后的源码原文（逐条点名；任何一条被回退即红） */
const WRAPPED_LINES: Record<string, string[]> = {
  'src/views/Dashboard.vue': [
    '  color: var(--accent-readable, var(--neon-cyan));',
    '  color: var(--pink-readable, var(--neon-magenta));',
    '  border-color: var(--purple-readable, var(--neon-purple));',
  ],
  'src/views/Users.vue': [
    '  color: var(--accent-readable, var(--neon-cyan));',
    '  color: var(--pink-readable, var(--neon-magenta));',
    '.role-user { color: var(--accent-readable, var(--neon-cyan)); background: var(--accent-cyan-a10); }',
    '  border-color: var(--accent-readable, var(--neon-cyan));',
  ],
};

/**
 * 期望计数：n = 本批消费点处数；readable = 整文件 *-readable 出现次数；
 * fam = 该文件里对应 readable 家族的总出现次数；tint = 装饰性 tint 前景基线（只降不升）。
 */
const EXPECTED: Record<string, { n: number; readable: number; fam: Record<string, number>; tint: number }> = {
  'src/views/Dashboard.vue': { n: 6, readable: 10, fam: { accent: 4, pink: 2, purple: 4 }, tint: 0 },
  // T04904：`.role-guest` 原 `--text-dim` 压紫 a10 在 8 主题只有 2.06~3.29，改接紫 readable
  // → purple 家族 2→3、readable 总数 9→10（本行是本单唯一改动的账目，其余计数不动）。
  'src/views/Users.vue': { n: 6, readable: 10, fam: { accent: 4, pink: 3, purple: 3 }, tint: 0 },
};

/** 改前/改后对照用：12 个消费点的裸基色表达式（与 AUDIT 前 12 行一一对应） */
const BEFORE: { label: string; bare: string; bg: string; kind: 'text' | 'ui' }[] = [
  { label: '首页·.welcome-tag', bare: 'var(--neon-cyan)', bg: GLASS_CARD, kind: 'text' },
  { label: '首页·.welcome-stats strong', bare: 'var(--neon-magenta)', bg: GLASS_CARD, kind: 'text' },
  { label: '首页·.title-bracket', bare: 'var(--neon-magenta)', bg: GLASS_CARD, kind: 'text' },
  { label: '首页·.dir-count', bare: 'var(--neon-cyan)', bg: GLASS_CARD, kind: 'text' },
  { label: '首页·.shortcut-item:hover', bare: 'var(--neon-purple)', bg: PURPLE_A12, kind: 'ui' },
  { label: '首页·.shortcut-icon', bare: 'var(--neon-cyan)', bg: PURPLE_A06, kind: 'ui' },
  { label: '用户页·.status-value', bare: 'var(--neon-cyan)', bg: GLASS_CARD, kind: 'text' },
  { label: '用户页·.error-banner', bare: 'var(--neon-magenta)', bg: 'var(--accent-pink-a10)', kind: 'text' },
  { label: '用户页·.role-user', bare: 'var(--neon-cyan)', bg: 'var(--accent-cyan-a10)', kind: 'text' },
  { label: '用户页·.field-error-text', bare: 'var(--neon-magenta)', bg: DIALOG, kind: 'text' },
  { label: '用户页·.neon-btn.secondary:hover [color]', bare: 'var(--neon-cyan)', bg: GLASS_CARD, kind: 'text' },
  { label: '用户页·.neon-btn.secondary:hover [border]', bare: 'var(--neon-cyan)', bg: GLASS_CARD, kind: 'ui' },
];

const readableRefCount = (src: string) => (src.match(/-readable/g) || []).length;
const famCount = (src: string, fam: string) => (src.match(new RegExp(`--${fam}-readable`, 'g')) || []).length;
const rowsOf = (f: string) => AUDIT.filter((r) => r.label.startsWith(PAGE[f] + '·') && !/下界/.test(r.label));
const tintFgCount = (src: string) => {
  let n = 0;
  for (const l of src.split(/\r?\n/)) {
    const m = /^\s*(?:color|border-color|border(?:-(?:left|right|top|bottom))?|outline(?:-color)?)\s*:\s*([^;]*)/.exec(l);
    if (m && /var\(--accent-[\w-]+-a\d\d/.test(m[1]) && !/-readable/.test(m[1])) n++;
  }
  return n;
};

describe('T04470 批次 A3：逐主题达标', () => {
  it(`8 主题 × ${AUDIT.length} 面（含 3 条保守下界）全部达 AA（文本 4.5 / 非文本 3.0）`, () => {
    const failures = auditThemes(AUDIT, loadThemes());
    expect(failures, formatFailures(failures)).toEqual([]);
  });

  it('改前确实不达标（新落点面 --bg-card / 紫 a06 不在既有样本里，本批是首测）', () => {
    const themes = loadThemes();
    const failures = auditThemes(
      BEFORE.map((b) => ({ label: b.label, fg: b.bare, bg: b.bg, kind: b.kind })),
      themes,
    );
    // 实测 44 个「主题 × 面」未达标组合（macaron 12/12、ecommerce 11/12、enterprise 11/12、
    // portfolio 9/12、light-business 1/12——唯一那处是 .error-banner 的裸 magenta 压粉 a10 只有 4.01；
    // default/creative/product 三个深底主题全过）。
    // 注意这里是 12 个真实消费点，不含 3 条保守下界；下界面（紫 a12 / 弹窗面）改前最差 1.35 同样不达标。
    expect(failures.length, formatFailures(failures)).toBe(44);
  });

  it('青族图形压紫 tint：实测即达标，故保留青族色相（不是靠放宽口径蒙过）', () => {
    // 非文本口径（3.0）与本处的真实判定
    const asUi: AuditRow[] = [
      { label: '青 readable × 紫 a06（图形 3.0）', fg: 'var(--accent-readable)', bg: PURPLE_A06, kind: 'ui' },
      { label: '青 readable × 紫 a12（图形 3.0）', fg: 'var(--accent-readable)', bg: PURPLE_A12, kind: 'ui' },
    ];
    expect(auditThemes(asUi, loadThemes()), '图形口径下青 readable 压紫 tint 应全部达标').toEqual([]);
    // 更强：同一族与面按**文字**口径 4.5 判定也全过（最差 macaron 4.69）——
    // 所以本处不需要 A2 的「紫面一律紫 readable」。A2 那条的前提是更深的紫 a20 面，
    // 由 test/contrast-sweep-help-about.test.ts 的正向对照用例常驻锁住，本批不重复也不类推。
    const asText: AuditRow[] = [
      { label: '青 readable × 紫 a12（文字 4.5）', fg: 'var(--accent-readable)', bg: PURPLE_A12, kind: 'text' },
      { label: '青 readable × 紫 a06（文字 4.5）', fg: 'var(--accent-readable)', bg: PURPLE_A06, kind: 'text' },
    ];
    expect(auditThemes(asText, loadThemes()), formatFailures(auditThemes(asText, loadThemes()))).toEqual([]);
  });

  it('清单规模与两页实现严格对齐（本批 12 处，接入原文逐条点名）', () => {
    expect(AUDIT.length).toBe(15);
    for (const f of FILES) {
      const src = readFileSync(join(ROOT, f), 'utf8');
      const exp = EXPECTED[f];
      expect(rowsOf(f).length, `${f} 清单行数与本批处数不一致`).toBe(exp.n);
      expect(readableRefCount(src), `${f} 的 readable 消费点数与清单不一致`).toBe(exp.readable);
      for (const line of WRAPPED_LINES[f]) {
        const hits = src.split(/\r?\n/).filter((l) => l === line).length;
        expect(hits, `${f} 应至少有一条 ${JSON.stringify(line)}，实测 ${hits} 条`).toBeGreaterThanOrEqual(1);
      }
    }
  });

  it('逐族消费点数与账一致（接错家族或漏接会被点名）', () => {
    for (const f of FILES) {
      const src = readFileSync(join(ROOT, f), 'utf8');
      for (const [fam, n] of Object.entries(EXPECTED[f].fam)) {
        expect(famCount(src, fam), `${f} · --${fam}-readable 应有 ${n} 处`).toBe(n);
      }
    }
  });

  it('包裹表达式括号平衡且行尾未丢（单行规则以 } 收尾，同样不得吃字符）', () => {
    for (const f of FILES) {
      const lines = readFileSync(join(ROOT, f), 'utf8').split(/\r?\n/);
      const bad = lines.filter((l) => /-readable/.test(l) && (l.match(/\(/g) || []).length !== (l.match(/\)/g) || []).length);
      expect(bad, `${f} 有 ${bad.length} 行括号不平衡：${bad.slice(0, 3).join(' | ')}`).toEqual([]);
      const noTail = lines.filter((l) => {
        if (!/-readable/.test(l)) return false;
        return !/[;}]$/.test(l.replace(/\s*!important\s*$/, '').trimEnd());
      });
      expect(noTail, `${f} 有 ${noTail.length} 行 readable 声明丢了行尾：${noTail.slice(0, 3).join(' | ')}`).toEqual([]);
    }
  });
});

describe('T04470 批次 A3：口径守护（基色不得再裸写进前景）', () => {
  for (const f of FILES) {
    it(`${f}：基色 token 只允许作为 *-readable 的 fallback 出现`, () => {
      const src = readFileSync(join(ROOT, f), 'utf8');
      expect(findBareBaseForegroundUses(src, { baseTokens: BASE_TOKENS }), `${f} 存在裸用基色的前景声明`).toEqual([]);
    });

    it(`${f}：行级兜底锁——前景声明里出现基色引用的行必须同时出现 readable`, () => {
      // 逐「声明」判定而不是逐「行」：Users.vue 有单行规则
      // `.role-admin { color: var(--text-bright); background: var(--neon-magenta); }`，
      // 同一行里既有前景声明又有合法底色填充——按行判会把底色误报成裸用基色（本口径不含填充）。
      const bad = readFileSync(join(ROOT, f), 'utf8')
        .split(/\r?\n/)
        .flatMap((l) => l.split(';'))
        .map((seg) => seg.replace(/^[^{]*\{/, '').trim())
        .filter(
          (seg) =>
            /^(?:color|border(?:-color)?|outline(?:-color)?)\s*:/.test(seg) &&
            /var\(--(?:neon-cyan|neon-pink|neon-magenta|neon-purple|accent-pink|accent-purple)\b(?![\w-])/.test(seg) &&
            !/-readable/.test(seg),
        );
      expect(bad, `${f} 有裸用基色的前景声明：${bad.slice(0, 3).join(' | ')}`).toEqual([]);
    });

    it(`${f}：装饰性 tint 前景停在基线，新增即红（改它需 T04468 裁决）`, () => {
      const n = tintFgCount(readFileSync(join(ROOT, f), 'utf8'));
      expect(n, `${f} 装饰 tint 前景应从基线 ${EXPECTED[f].tint} 只降不升`).toBeLessThanOrEqual(EXPECTED[f].tint);
    });
  }
});
