// T04470 口径推广·批次 A2：帮助页（Help.vue 5 处）+ 关于页（About.vue 7 处）。
// 与前五组同一缺陷族；本批第一次撞到工单里的硬条件 2——跨家族配对：
//   帮助页活动锚点 .anchor-item.active 把粉族（--neon-magenta）写在自身 --accent-purple-a20 紫面上，
//   实测粉 readable × 紫 a20 在 ecommerce 4.34 / enterprise 4.37 / macaron 4.44 / portfolio 3.90 /
//   product 4.46 五档全部 < 4.5（青 readable × 紫 a20 同样只有 4.13~4.45），
//   而紫 readable × 紫 a20 最差 macaron 4.61 达标 → 按面选族，此处改用 --purple-readable
//   （活动项色相由品红转紫，与相邻 hover 的青色仍能区分；这是全站第一处跨家族包裹，需目视定调）。
// 其余 11 处为同族接入；关于页 .icon-btn 同时按「玻璃按钮」与「品牌卡不透明底 --bg-scene」两个面审计，
// 取更保守的后者作为下界（实测青 readable × 场景底最差 macaron 4.76，仍达标）。
// 备注：About.vue 的 .head-tag 在当前模板里没有使用者（死样式），本批按口径一并接入，不改结构。
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

const FILES = ['src/views/Help.vue', 'src/views/About.vue'];
const PAGE: Record<string, string> = { 'src/views/Help.vue': '帮助页', 'src/views/About.vue': '关于页' };
const BASE_TOKENS = [
  /^--neon-cyan$/,
  /^--neon-pink$/,
  /^--accent-pink$/,
  /^--neon-magenta$/,
  /^--neon-purple$/,
  /^--accent-purple$/,
];
/** .glass-card 卡片面（半透明，按 pageOf 的合成底参与计算） */
const GLASS_CARD = 'var(--bg-card)';
const GLASS = 'var(--bg-glass)';
const SCENE = 'var(--bg-scene)';

/** 逐面清单：前 12 行 = 本批 12 个真实消费点，后 2 行 = 同一消费点的保守下界面 */
const AUDIT: AuditRow[] = [
  { label: '帮助页·.anchor-item.active [color·purple（按面选族）]', fg: 'var(--purple-readable)', bg: 'var(--accent-purple-a20)', kind: 'text' },
  { label: '帮助页·.note-text.note-warning [border-left-color·pink]', fg: 'var(--pink-readable)', bg: 'var(--accent-pink-a08)', kind: 'ui' },
  { label: '帮助页·.code-lang-badge [color·purple]', fg: 'var(--purple-readable)', bg: GLASS_CARD, kind: 'text' },
  { label: '帮助页·.cell-example [color·purple]', fg: 'var(--purple-readable)', bg: GLASS_CARD, kind: 'text' },
  { label: '帮助页·.local-data-card [border-left·accent]', fg: 'var(--accent-readable)', bg: GLASS_CARD, kind: 'ui' },
  { label: '关于页·.head-tag [color·accent]', fg: 'var(--accent-readable)', bg: GLASS_CARD, kind: 'text' },
  { label: '关于页·.icon-btn:hover [border-color·accent]', fg: 'var(--accent-readable)', bg: GLASS, kind: 'ui' },
  { label: '关于页·.icon-btn:hover [color·accent]', fg: 'var(--accent-readable)', bg: GLASS, kind: 'text' },
  { label: '关于页·.meta-sha [color·purple]', fg: 'var(--purple-readable)', bg: SCENE, kind: 'text' },
  { label: '关于页·.downloading-icon [color·accent]', fg: 'var(--accent-readable)', bg: SCENE, kind: 'text' },
  { label: '关于页·.menu-item:hover .menu-arrow [color·accent]', fg: 'var(--accent-readable)', bg: 'var(--accent-purple-a08)', kind: 'text' },
  { label: '关于页·.license-name:hover [color·accent]', fg: 'var(--accent-readable)', bg: 'var(--accent-purple-a08)', kind: 'text' },
  // —— 保守下界：玻璃按钮实际坐在不透明品牌卡（--bg-scene）之上，叠底方向不确定，两头都钉 ——
  { label: '关于页·.icon-btn:hover [border-color·accent·场景底下界]', fg: 'var(--accent-readable)', bg: SCENE, kind: 'ui' },
  { label: '关于页·.icon-btn:hover [color·accent·场景底下界]', fg: 'var(--accent-readable)', bg: SCENE, kind: 'text' },
];

/** 本批接入后的源码原文（逐条点名；任何一条被回退即红） */
const WRAPPED_LINES: Record<string, string[]> = {
  'src/views/Help.vue': [
    '  color: var(--purple-readable, var(--neon-magenta));',
    '  border-left-color: var(--pink-readable, var(--neon-magenta));',
    '  color: var(--purple-readable, var(--neon-purple));',
    '  color: var(--purple-readable, var(--neon-purple)) !important;',
    '  border-left: 3px solid var(--accent-readable, var(--neon-cyan));',
  ],
  'src/views/About.vue': [
    '  color: var(--accent-readable, var(--neon-cyan));',
    '  border-color: var(--accent-readable, var(--neon-cyan));',
    '  color: var(--purple-readable, var(--neon-purple));',
  ],
};

/**
 * 期望计数：n = 本批消费点处数；fam = 该文件里对应 readable 家族的总出现次数
 * （帮助页的粉/紫族全部来自本批，关于页的青族 6 处也全部来自本批，可整文件核对）；
 * tint = 装饰性 tint 前景基线（只降不升）。
 */
const EXPECTED: Record<string, { n: number; fam: Record<string, number>; tint: number }> = {
  'src/views/Help.vue': { n: 5, fam: { purple: 8, pink: 1 }, tint: 0 },
  'src/views/About.vue': { n: 7, fam: { accent: 6, purple: 5 }, tint: 0 },
};

const famCount = (src: string, fam: string) => (src.match(new RegExp(`--${fam}-readable`, 'g')) || []).length;
const rowsOf = (f: string) => AUDIT.filter((r) => r.label.startsWith(PAGE[f] + '·') && !/下界/.test(r.label));

describe('T04470 批次 A2：逐主题达标', () => {
  it(`8 主题 × ${AUDIT.length} 面（含 2 条保守下界）全部达 AA（文本 4.5 / 非文本 3.0）`, () => {
    const failures = auditThemes(AUDIT, loadThemes());
    expect(failures, formatFailures(failures)).toEqual([]);
  });

  it('跨家族接入的前提成立：粉/青 readable 压紫 a20 确实不达标（否则应保留原色相）', () => {
    const rows: AuditRow[] = [
      { label: '粉 readable × 紫 a20', fg: 'var(--pink-readable)', bg: 'var(--accent-purple-a20)', kind: 'text' },
      { label: '青 readable × 紫 a20', fg: 'var(--accent-readable)', bg: 'var(--accent-purple-a20)', kind: 'text' },
    ];
    const failures = auditThemes(rows, loadThemes());
    // 至少 4 个主题不达标才证明「按面选族」是被数据逼出来的，不是随手换色相
    expect(failures.length, failures.map((f) => `${f.theme}·${f.label}=${f.ratio.toFixed(2)}`).join('\n')).toBeGreaterThanOrEqual(4);
  });

  it('清单规模与两页实现严格对齐（本批 12 处，接入原文逐条点名）', () => {
    for (const f of FILES) {
      const src = readFileSync(join(ROOT, f), 'utf8');
      expect(rowsOf(f).length, `${f} 清单行数与本批处数不一致`).toBe(EXPECTED[f].n);
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

  it('包裹表达式括号平衡且行尾分号未丢（防止接入器吃掉字符）', () => {
    for (const f of FILES) {
      const bad = readFileSync(join(ROOT, f), 'utf8')
        .split(/\r?\n/)
        .filter((l) => /-readable/.test(l) && (l.match(/\(/g) || []).length !== (l.match(/\)/g) || []).length);
      expect(bad, `${f} 有 ${bad.length} 行括号不平衡：${bad.slice(0, 3).join(' | ')}`).toEqual([]);
      const noSemi = readFileSync(join(ROOT, f), 'utf8')
        .split(/\r?\n/)
        .filter((l) => /-readable/.test(l) && !/;\s*$/.test(l.replace(/\s*!important\s*$/, '')));
      expect(noSemi, `${f} 有 ${noSemi.length} 行 readable 声明丢了行尾分号：${noSemi.slice(0, 3).join(' | ')}`).toEqual([]);
    }
  });
});

describe('T04470 批次 A2：口径守护（基色不得再裸写进前景）', () => {
  for (const f of FILES) {
    it(`${f}：基色 token 只允许作为 *-readable 的 fallback 出现`, () => {
      const src = readFileSync(join(ROOT, f), 'utf8');
      expect(findBareBaseForegroundUses(src, { baseTokens: BASE_TOKENS }), `${f} 存在裸用基色的前景声明`).toEqual([]);
    });

    it(`${f}：行级兜底锁——出现基色引用的行必须同时出现 readable`, () => {
      const bad = readFileSync(join(ROOT, f), 'utf8')
        .split(/\r?\n/)
        .filter(
          (l) =>
            /(?:color|border(?:-color)?|outline(?:-color)?)\s*:/.test(l) &&
            /var\(--(?:neon-cyan|neon-pink|neon-magenta|neon-purple|accent-pink|accent-purple)\b(?![\w-])/.test(l) &&
            !/-readable/.test(l),
        );
      expect(bad, `${f} 有裸用基色的行：${bad.slice(0, 3).join(' | ')}`).toEqual([]);
    });

    it(`${f}：装饰性 tint 前景停在基线，新增即红（改它需 T04468 裁决）`, () => {
      const src = readFileSync(join(ROOT, f), 'utf8');
      let n = 0;
      for (const l of src.split(/\r?\n/)) {
        const m = /^\s*(?:color|border-color|border(?:-(?:left|right|top|bottom))?|outline(?:-color)?)\s*:\s*([^;]*)/.exec(l);
        if (m && /var\(--accent-[\w-]+-a\d\d/.test(m[1]) && !/-readable/.test(m[1])) n++;
      }
      expect(n, `${f} 装饰 tint 前景应从基线 ${EXPECTED[f].tint} 只降不升`).toBeLessThanOrEqual(EXPECTED[f].tint);
    });
  }
});
