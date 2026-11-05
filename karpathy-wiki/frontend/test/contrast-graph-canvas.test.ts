// ============================================================
// T04469：图谱画布配色的完整性锁 + 对比度口径锁
//
// 为什么单开一把锁（而不是并进 contrast-sweep-* 那些「扫 CSS 声明」的锁）：
// 画布上的节点色 / 边色 / 标签色不是 CSS 声明出来的，而是 Graph.vue 的 <script> 用
// getComputedStyle 读变量后交给 vis-network 画到 canvas 上。静态扫描器逐条读
// `<style>` 里的 color:/background: 声明，看不见这条运行时链路 ——
// 于是「sweep 全绿」与「画布配色达标」是两件互不蕴含的事，历史上一缺一漏就是这么来的。
//
// 本单落地的三件事（按单内方案 1/2）：
//   ① 主题集合完整性：可选主题（useTheme.ts）必须全部落在被审计集合里。
//      dark 主题整套画布色板写在 tokens.css（不在 styles/themes/ 下），
//      loadThemes() 天然看不见它 → 此前 14 把对比度锁没有一把审过 dark。
//   ② 声明矩阵：9 个底 × 15 个 --graph-* 逐个有明确来源（本主题自声明 / 显式继承 :root）。
//   ③ 数值口径建立 + 现状登记表：面是 .graph-canvas-wrapper 的 --bg-scene（画布底色），
//      图例点的面是卡片面；节点辉光按 Graph.vue 的 `bg + 'aa'` 拼接实算（装饰面只留档不判达标）。
//      三张表都按「改前事实留档 + 只降不升」冻结。
//   ④ 兜底行为取「日志 + 回落到该变量自己的 :root 值」，不取单里建议的「抛错」：
//      抛错会让整张图画不出来（用户看到空白画布），比串色更糟；warn 已足够可观测。
//
// 明确不在本单做（单内方案 3）：调色（改画布色板 / 提高边的 alpha）是设计定调，
// 已另建【AI回写待审核】单交裁决。所以这里的 C/D 腿只负责「不许无声变化」：
// 谁改了色板，必须同时改下面登记的表 —— 改动在 diff 里可见，而不是悄悄通过。
//
// 为什么不把 dark 直接塞进 loadThemes()：它是 14 把锁的共同主题源，多一个主题会让
// T04449/T04470/T04472 登记死的「8 主题」计数与逐主题最差值同时漂移；那是
// 「dark 全量纳入口径」另一单该做的事，不由画布锁顺带触发。
// ============================================================
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  ROOT,
  STYLE_CSS,
  THEMES_DIR,
  THRESHOLD,
  TOKENS_CSS,
  loadAuxTheme,
  loadThemes,
  pageOf,
  parseRootDecls,
  resolve,
  ruleBodies,
  stripComments,
  themeBlockDecls,
  worstRatio,
} from './helpers/contrast';

const GRAPH_VUE = join(ROOT, 'src/views/Graph.vue');
const USE_THEME_TS = join(ROOT, 'src/composables/useTheme.ts');
const graphSrc = readFileSync(GRAPH_VUE, 'utf8');
const useThemeSrc = readFileSync(USE_THEME_TS, 'utf8');

const DIRS = ['entities', 'concepts', 'comparisons', 'queries', 'qa', 'solutions'] as const;

/** 画布用到的 15 个变量：6 类目录色（填充 + 描边）+ 边 + 高亮边 + 节点标签 */
const CANVAS_VARS = [
  ...DIRS.map((d) => `--graph-${d}`),
  ...DIRS.map((d) => `--graph-${d}-border`),
  '--graph-edge',
  '--graph-edge-highlight',
  '--graph-label',
];

/**
 * 口径分类：只有节点标签是文字（AA 4.5），其余是图形（WCAG 1.4.11 → 3.0）。
 * 这条分类被 D 腿的缺口登记表依赖——改动分类等于改判定口径，登记表会整片变红，
 * 逼迫改的人显式承认「我在换口径」，而不是让同一份色板换个尺子就全绿。
 */
const KIND: Record<string, 'text' | 'ui'> = Object.fromEntries(
  CANVAS_VARS.map((v) => [v, v === '--graph-label' ? 'text' : 'ui']),
);

/** 6 个目录填充色：既是节点填充 / 辉光的输入，也是图例点的底色 */
const FILL_VARS = DIRS.map((d) => `--graph-${d}`);
/** 图例点（与 FILL_VARS 同一组色）在 DOM 上，所在面是卡片 */
const LEGEND_VARS = FILL_VARS;

interface Base {
  name: string;
  decls: Map<string, string>;
  cssFile: string;
  /** 取本底「自己声明了什么」时用的主题名（:root 底特殊处理） */
  theme: string;
}

const BASES: Base[] = loadThemes().map((t) =>
  t.name === 'default(:root)'
    ? { name: t.name, decls: t.decls, cssFile: STYLE_CSS, theme: ':root' }
    : { name: t.name, decls: t.decls, cssFile: join(THEMES_DIR, `${t.name}.css`), theme: t.name },
);
const DARK = loadAuxTheme('dark');
BASES.push({ name: DARK.name, decls: DARK.decls, cssFile: TOKENS_CSS, theme: 'dark' });

/** 被审计底的规范主题名（default(:root) 是不可选的 :root 兜底调色板，单列） */
const AUDITED_THEME_NAMES = BASES.map((b) => b.theme).filter((t) => t !== ':root');

function ownDeclsOf(base: Base): Map<string, string> {
  return base.theme === ':root' ? parseRootDecls() : themeBlockDecls(readFileSync(base.cssFile, 'utf8'), base.theme);
}

const ALL15 = [...CANVAS_VARS].sort();

/**
 * 声明矩阵基线（2026-11-05 实测）：除 creative 整套继承 :root（它的画布色就用霓虹原色），
 * 其余 8 个底各自声明全部 15 个变量。
 * 「整套继承」是合法设计，「部分声明」不是缺陷但必须登记——新增主题/改声明范围时，
 * 这条断言会把新矩阵逼到台面上，避免出现「一半本主题、一半 :root」的双色板来源。
 */
const OWN_BASELINE: Record<string, string[]> = {
  'default(:root)': ALL15,
  creative: [],
  ecommerce: ALL15,
  enterprise: ALL15,
  'light-business': ALL15,
  macaron: ALL15,
  portfolio: ALL15,
  product: ALL15,
  'dark(tokens.css)': ALL15,
};

/**
 * 改前事实留档（2026-11-05 实算，最差值/3 位小数）：15 个画布变量各自对画布底色
 * `.graph-canvas-wrapper { background: var(--bg-scene) }` 的最差对比度。
 * D 腿按「只降不升」比对；未达标格由本表派生（不另抄一份，防两处不同步）。
 */
const CANVAS_BASELINE: Record<string, Record<string, number>> = {
  'default(:root)': { '--graph-entities': 5.402, '--graph-concepts': 15.292, '--graph-comparisons': 4.504, '--graph-queries': 6.691, '--graph-qa': 9.42, '--graph-solutions': 15.444, '--graph-entities-border': 6.649, '--graph-concepts-border': 16.713, '--graph-comparisons-border': 7.017, '--graph-queries-border': 8.914, '--graph-qa-border': 12.047, '--graph-solutions-border': 16.146, '--graph-edge': 1.704, '--graph-edge-highlight': 15.292, '--graph-label': 17.664 },
  creative: { '--graph-entities': 5.402, '--graph-concepts': 15.292, '--graph-comparisons': 4.504, '--graph-queries': 6.691, '--graph-qa': 9.42, '--graph-solutions': 15.444, '--graph-entities-border': 6.649, '--graph-concepts-border': 16.713, '--graph-comparisons-border': 7.017, '--graph-queries-border': 8.914, '--graph-qa-border': 12.047, '--graph-solutions-border': 16.146, '--graph-edge': 1.704, '--graph-edge-highlight': 15.292, '--graph-label': 17.664 },
  ecommerce: { '--graph-entities': 2.737, '--graph-concepts': 2.61, '--graph-comparisons': 4.689, '--graph-queries': 2.232, '--graph-qa': 1.469, '--graph-solutions': 1.897, '--graph-entities-border': 2.232, '--graph-concepts-border': 1.923, '--graph-comparisons-border': 3.223, '--graph-queries-border': 1.832, '--graph-qa-border': 1.32, '--graph-solutions-border': 1.682, '--graph-edge': 1.435, '--graph-edge-highlight': 2.61, '--graph-label': 16.464 },
  enterprise: { '--graph-entities': 4.718, '--graph-concepts': 2.216, '--graph-comparisons': 4.077, '--graph-queries': 3.357, '--graph-qa': 1.96, '--graph-solutions': 2.315, '--graph-entities-border': 3.357, '--graph-concepts-border': 1.65, '--graph-comparisons-border': 2.723, '--graph-queries-border': 2.321, '--graph-qa-border': 1.524, '--graph-solutions-border': 1.755, '--graph-edge': 1.636, '--graph-edge-highlight': 2.216, '--graph-label': 16.296 },
  'light-business': { '--graph-entities': 6.03, '--graph-concepts': 3.785, '--graph-comparisons': 4.403, '--graph-queries': 5.407, '--graph-qa': 2.799, '--graph-solutions': 2.743, '--graph-entities-border': 4.403, '--graph-concepts-border': 2.665, '--graph-comparisons-border': 2.907, '--graph-queries-border': 3.31, '--graph-qa-border': 1.993, '--graph-solutions-border': 1.932, '--graph-edge': 1.403, '--graph-edge-highlight': 6.03, '--graph-label': 17.463 },
  macaron: { '--graph-entities': 1.551, '--graph-concepts': 1.367, '--graph-comparisons': 1.999, '--graph-queries': 1.386, '--graph-qa': 1.277, '--graph-solutions': 1.372, '--graph-entities-border': 1.386, '--graph-concepts-border': 1.146, '--graph-comparisons-border': 1.691, '--graph-queries-border': 1.243, '--graph-qa-border': 1.148, '--graph-solutions-border': 1.178, '--graph-edge': 1.298, '--graph-edge-highlight': 1.367, '--graph-label': 9.697 },
  portfolio: { '--graph-entities': 1.845, '--graph-concepts': 3.678, '--graph-comparisons': 14.271, '--graph-queries': 1.617, '--graph-qa': 3.859, '--graph-solutions': 3.12, '--graph-entities-border': 1.617, '--graph-concepts-border': 2.693, '--graph-comparisons-border': 8.907, '--graph-queries-border': 1.349, '--graph-qa-border': 2.693, '--graph-solutions-border': 2.048, '--graph-edge': 1.225, '--graph-edge-highlight': 1.845, '--graph-label': 14.271 },
  product: { '--graph-entities': 5.393, '--graph-concepts': 15.179, '--graph-comparisons': 4.557, '--graph-queries': 11.497, '--graph-qa': 10.664, '--graph-solutions': 5.145, '--graph-entities-border': 5.969, '--graph-concepts-border': 15.869, '--graph-comparisons-border': 6.824, '--graph-queries-border': 13.75, '--graph-qa-border': 12.062, '--graph-solutions-border': 7.704, '--graph-edge': 2.993, '--graph-edge-highlight': 5.393, '--graph-label': 20.355 },
  'dark(tokens.css)': { '--graph-entities': 5.787, '--graph-concepts': 6.951, '--graph-comparisons': 5.029, '--graph-queries': 6.665, '--graph-qa': 7.308, '--graph-solutions': 7.282, '--graph-entities-border': 6.951, '--graph-concepts-border': 8.901, '--graph-comparisons-border': 6.871, '--graph-queries-border': 7.815, '--graph-qa-border': 8.901, '--graph-solutions-border': 8.855, '--graph-edge': 1.747, '--graph-edge-highlight': 5.787, '--graph-label': 15.655 },
};

/** 改前事实留档：6 个图例点对卡片面（--bg-card-solid 合成到页面底）的最差对比度 */
const LEGEND_BASELINE: Record<string, Record<string, number>> = {
  'default(:root)': { '--graph-entities': 4.923, '--graph-concepts': 13.936, '--graph-comparisons': 4.105, '--graph-queries': 6.098, '--graph-qa': 8.584, '--graph-solutions': 14.075 },
  creative: { '--graph-entities': 4.923, '--graph-concepts': 13.936, '--graph-comparisons': 4.105, '--graph-queries': 6.098, '--graph-qa': 8.584, '--graph-solutions': 14.075 },
  ecommerce: { '--graph-entities': 2.835, '--graph-concepts': 2.704, '--graph-comparisons': 4.858, '--graph-queries': 2.312, '--graph-qa': 1.522, '--graph-solutions': 1.965 },
  enterprise: { '--graph-entities': 5.168, '--graph-concepts': 2.428, '--graph-comparisons': 4.467, '--graph-queries': 3.678, '--graph-qa': 2.148, '--graph-solutions': 2.537 },
  'light-business': { '--graph-entities': 6.52, '--graph-concepts': 4.093, '--graph-comparisons': 4.761, '--graph-queries': 5.847, '--graph-qa': 3.026, '--graph-solutions': 2.967 },
  macaron: { '--graph-entities': 1.664, '--graph-concepts': 1.466, '--graph-comparisons': 2.145, '--graph-queries': 1.487, '--graph-qa': 1.37, '--graph-solutions': 1.472 },
  portfolio: { '--graph-entities': 2.199, '--graph-concepts': 4.383, '--graph-comparisons': 17.005, '--graph-queries': 1.926, '--graph-qa': 4.598, '--graph-solutions': 3.718 },
  product: { '--graph-entities': 5.047, '--graph-concepts': 14.206, '--graph-comparisons': 4.265, '--graph-queries': 10.76, '--graph-qa': 9.98, '--graph-solutions': 4.815 },
  'dark(tokens.css)': { '--graph-entities': 5.412, '--graph-concepts': 6.501, '--graph-comparisons': 4.703, '--graph-queries': 6.233, '--graph-qa': 6.834, '--graph-solutions': 6.81 },
};

/**
 * 改前事实留档：节点辉光 `shadow.color = bg + 'aa'`（= 填充色 alpha 0.667）对画布面的对比度。
 * 单内方案 2 点名要算这条（拼接透明度要先 alpha 合面）——这里是**留档 + 只降不升**，
 * 不并入 D3 的达标缺口集：辉光是装饰性光晕，承载分类信息的是节点本体（填充/描边已判），
 * 按 1.4.11「理解内容所必需的图形」它不该占用可达性预算；把它列进缺口只会稀释信号。
 */
const GLOW_BASELINE: Record<string, Record<string, number>> = {
  'default(:root)': { '--graph-entities': 2.819, '--graph-concepts': 6.792, '--graph-comparisons': 2.513, '--graph-queries': 3.396, '--graph-qa': 4.484, '--graph-solutions': 6.826 },
  creative: { '--graph-entities': 2.819, '--graph-concepts': 6.792, '--graph-comparisons': 2.513, '--graph-queries': 3.396, '--graph-qa': 4.484, '--graph-solutions': 6.826 },
  ecommerce: { '--graph-entities': 1.998, '--graph-concepts': 1.934, '--graph-comparisons': 2.637, '--graph-queries': 1.719, '--graph-qa': 1.298, '--graph-solutions': 1.573 },
  enterprise: { '--graph-entities': 2.711, '--graph-concepts': 1.742, '--graph-comparisons': 2.435, '--graph-queries': 2.188, '--graph-qa': 1.585, '--graph-solutions': 1.783 },
  'light-business': { '--graph-entities': 3.14, '--graph-concepts': 2.347, '--graph-comparisons': 2.54, '--graph-queries': 2.921, '--graph-qa': 1.973, '--graph-solutions': 1.942 },
  macaron: { '--graph-entities': 1.337, '--graph-concepts': 1.232, '--graph-comparisons': 1.563, '--graph-queries': 1.241, '--graph-qa': 1.177, '--graph-solutions': 1.234 },
  portfolio: { '--graph-entities': 1.488, '--graph-concepts': 2.237, '--graph-comparisons': 5.249, '--graph-queries': 1.369, '--graph-qa': 2.303, '--graph-solutions': 2.055 },
  product: { '--graph-entities': 2.806, '--graph-concepts': 6.821, '--graph-comparisons': 2.561, '--graph-queries': 5.362, '--graph-qa': 5.04, '--graph-solutions': 2.795 },
  'dark(tokens.css)': { '--graph-entities': 3.23, '--graph-concepts': 3.741, '--graph-comparisons': 2.895, '--graph-queries': 3.614, '--graph-qa': 3.848, '--graph-solutions': 3.861 },
};

/** 留档表按 3 位小数四舍五入过，比对容差 0.001（等于允许末位取整，不允许真实劣化） */
const EPS = 0.001;

function canvasRatios(base: Base): Record<string, number> {
  const page = pageOf(base.decls);
  return Object.fromEntries(CANVAS_VARS.map((v) => [v, worstRatio(`var(${v})`, 'var(--bg-scene)', base.decls, page)]));
}

function legendRatios(base: Base): Record<string, number> {
  const page = pageOf(base.decls);
  return Object.fromEntries(LEGEND_VARS.map((v) => [v, worstRatio(`var(${v})`, 'var(--bg-card-solid)', base.decls, page)]));
}

/**
 * 辉光对比度：复刻 Graph.vue 的 `bg + 'aa'`（6 位 hex 尾接 alpha）后再按 alpha 合面实算。
 * 取值不是 hex 就当场抛错——拼接式透明度只有「#rrggbb」这一种写法能拼出合法颜色，
 * 主题里写成 rgba(...) / 颜色名会得到非法串，vis 静默丢掉整个 shadow（B 腿另有断言守这条）。
 */
function glowRatios(base: Base): Record<string, number> {
  const page = pageOf(base.decls);
  return Object.fromEntries(
    FILL_VARS.map((v) => {
      const raw = (base.decls.get(v) ?? '').trim();
      if (!/^#[0-9a-fA-F]{6}$/.test(raw)) throw new Error(`${base.name} · ${v} = '${raw}' 不是 #rrggbb，无法按 bg + 'aa' 实算辉光`);
      return [v, worstRatio(`${raw}aa`, 'var(--bg-scene)', base.decls, page)];
    }),
  );
}

/** 从留档表派生「改前未达标格」，避免第二份手工清单与表失步 */
function underSet(baseline: Record<string, Record<string, number>>, kindOf: (v: string) => 'text' | 'ui'): string[] {
  const out: string[] = [];
  for (const [theme, row] of Object.entries(baseline)) {
    for (const [v, r] of Object.entries(row)) if (r < THRESHOLD[kindOf(v)]) out.push(`${theme} · ${v}`);
  }
  return out.sort();
}

/** 从 SFC 源码里按大括号配平取出一个对象字面量的字符串项 */
function stringObjectLiteral(src: string, headRe: RegExp, what: string): Map<string, string> {
  const m = src.match(headRe);
  if (!m) throw new Error(`Graph.vue 里找不到 ${what}`);
  let i = (m.index ?? 0) + m[0].length;
  let depth = 1;
  const start = i;
  while (i < src.length && depth > 0) {
    if (src[i] === '{') depth++;
    else if (src[i] === '}') depth--;
    i++;
  }
  const out = new Map<string, string>();
  for (const e of src.slice(start, i - 1).matchAll(/'(--[\w-]+)'\s*:\s*'([^']*)'/g)) {
    if (!out.has(e[1])) out.set(e[1], e[2]);
  }
  return out;
}

describe('A · 主题集合完整性：可选主题不得逃出画布审计口径', () => {
  it('useTheme.ts 的 ThemeName 联合类型与 THEMES 切换器条目一致', () => {
    const union = useThemeSrc.match(/export type ThemeName\s*=([\s\S]*?);/);
    expect(union, 'useTheme.ts 里找不到 ThemeName 联合类型').toBeTruthy();
    const unionKeys = [...union![1].matchAll(/'([\w-]+)'/g)].map((m) => m[1]).sort();
    const metaKeys = [...useThemeSrc.matchAll(/^\s*key: '([\w-]+)'/gm)].map((m) => m[1]).sort();
    expect(metaKeys).toEqual(unionKeys);
  });

  it('每个可选主题都有可审计的色板（dark 整套写在 tokens.css 那种逃逸即红）', () => {
    const union = useThemeSrc.match(/export type ThemeName\s*=([\s\S]*?);/)!;
    const selectable = [...union[1].matchAll(/'([\w-]+)'/g)].map((m) => m[1]).sort();
    // 被审计集合 = 可选主题 ∪ :root 兜底调色板（不可选，但它是「继承」的落点，必须一起算）
    expect([...AUDITED_THEME_NAMES].sort()).toEqual(selectable);
    const missing = selectable.filter((t) => !AUDITED_THEME_NAMES.includes(t));
    expect(missing, `这些可选主题没有进入画布审计口径：${missing.join(', ')}（新主题若把色板写在 themes/ 之外，需在 BASES 里补一路）`).toEqual([]);
  });

  it('不存在「有调色板但 useTheme 不认账」的主题（反向逃逸同样红）', () => {
    const union = useThemeSrc.match(/export type ThemeName\s*=([\s\S]*?);/)!;
    const selectable = new Set([...union[1].matchAll(/'([\w-]+)'/g)].map((m) => m[1]));
    const fileThemes = readdirSync(THEMES_DIR)
      .filter((f) => f.endsWith('.css') && f !== 'index.css')
      .map((f) => f.replace(/\.css$/, ''));
    const tokensThemes = [...stripComments(readFileSync(TOKENS_CSS, 'utf8')).matchAll(/\[data-theme=["']([\w-]+)["']\]/g)].map((m) => m[1]);
    const orphans = [...new Set([...fileThemes, ...tokensThemes])].filter((t) => !selectable.has(t)).sort();
    expect(orphans, `这些主题有调色板但不在 ThemeName 里：${orphans.join(', ')}——要么接入可选集合，要么删掉调色板`).toEqual([]);
  });
});

describe('B · 声明矩阵：9 个底 × 15 个画布变量逐个有明确来源', () => {
  it('每格都可解析（未声明且无 fallback 时 helpers 会抛错，这里只负责把行列摆全）', () => {
    for (const base of BASES) {
      const page = pageOf(base.decls);
      for (const v of CANVAS_VARS) {
        expect(() => worstRatio(`var(${v})`, 'var(--bg-scene)', base.decls, page), `${base.name} · ${v}`).not.toThrow();
      }
    }
  });

  it('自声明 vs 继承 :root 的矩阵与留档一致', () => {
    for (const base of BASES) {
      const own = [...ownDeclsOf(base).keys()].filter((k) => CANVAS_VARS.includes(k)).sort();
      expect(own, `${base.name} 的画布变量声明集合与留档不符（新增主题/改声明范围需同步 OWN_BASELINE）`).toEqual(OWN_BASELINE[base.name]);
    }
  });

  it('整套继承 :root 的底，:root 必须真的声明全部 15 个（否则继承来的是 undefined）', () => {
    const rootOwn = [...parseRootDecls().keys()].filter((k) => CANVAS_VARS.includes(k)).sort();
    for (const [name, own] of Object.entries(OWN_BASELINE)) {
      if (own.length === 0 && name !== 'default(:root)') {
        expect(rootOwn, `${name} 整套继承 :root，但 :root 声明不全`).toEqual(ALL15);
      }
    }
  });

  it('画布底色 --bg-scene 在每个底都不透明（登记表的面模型依赖这一点）', () => {
    for (const base of BASES) {
      const r = resolve('var(--bg-scene)', base.decls);
      expect('stops' in r, `${base.name} 的 --bg-scene 变成了渐变，画布面不再是单色，需重推登记表`).toBe(false);
      if ('solid' in r) expect(r.solid.a, `${base.name} 的 --bg-scene 变成半透明：画布底会透出页面底，面模型要改`).toBe(1);
    }
  });
});

describe('C · 静默兜底改可观测 + 消费点接入', () => {
  it('兜底表键集合 == 15 个画布变量，且逐条等于 :root 的声明值', () => {
    const table = stringObjectLiteral(graphSrc, /const GRAPH_VAR_FALLBACKS[^=]*=/, 'GRAPH_VAR_FALLBACKS 兜底表');
    expect([...table.keys()].sort()).toEqual(ALL15);
    const rootDecl = parseRootDecls();
    for (const [v, fallback] of table) {
      const declared = (rootDecl.get(v) ?? '').replace(/\s+/g, ' ').trim();
      expect(declared, `:root 里没有 ${v} 的声明，兜底表无从比对`).toBeTruthy();
      // 兜底值必须与 :root 逐字同值：否则「变量没声明」时画布出现的是一种颜色，
      // 登记表算出来的是另一种，锁就失去了预测力。
      expect(fallback.replace(/\s+/g, ' ').trim(), `${v} 的兜底值与 :root 声明漂移`).toBe(declared);
    }
  });

  it('getThemeVar 里不再写死色值，缺声明会 console.warn（可观测是修复的实质）', () => {
    const m = graphSrc.match(/function getThemeVar\([^)]*\)\s*:\s*string\s*\{/);
    expect(m, '找不到 getThemeVar 函数体').toBeTruthy();
    let i = (m!.index ?? 0) + m![0].length;
    let depth = 1;
    const start = i;
    while (i < graphSrc.length && depth > 0) {
      if (graphSrc[i] === '{') depth++;
      else if (graphSrc[i] === '}') depth--;
      i++;
    }
    const body = graphSrc.slice(start, i - 1);
    expect(body).toMatch(/GRAPH_VAR_FALLBACKS/);
    expect(body).toMatch(/console\.warn\(/);
    // 函数体内出现任何 hex / rgba 字面量 = 又回到「一个颜色兜住所有变量」的老写法
    const literals = body.match(/#[0-9a-fA-F]{3,8}\b|rgba?\(/g);
    expect(literals, `getThemeVar 里写死了色值兜底：${literals?.join(', ')}`).toBeNull();
    // 提示必须去重：getDirColors()/getDirBorders() 在 buildNodes 里逐节点调用，
    // 缺声明时不去重 = 上千节点刷上万条警告，控制台淹掉后这条「可观测」就白做了。
    expect(body, '缺声明提示未去重（逐节点调用会刷屏）').toMatch(/warnedMissingVars\.has\(name\)/);
    expect((body.match(/console\.warn\(/g) ?? []).length, 'getThemeVar 里应当只有一条提示语句').toBe(1);
  });

  it('CSS 侧图例点不得引入 var(--graph-x, #hex) 这种第二套静默兜底', () => {
    const cssFallback = graphSrc.match(/var\(\s*--graph-[\w-]+\s*,/g);
    expect(cssFallback, `图例/样式里存在带 fallback 的 var(--graph-*)：${cssFallback?.join(', ')}——静默兜底只允许留在 GRAPH_VAR_FALLBACKS 一处`).toBeNull();
    const legendDots = graphSrc.match(/class="legend-dot"/g) ?? [];
    expect(legendDots.length, '图例点数量变了，LEGEND_VARS 需同步').toBe(LEGEND_VARS.length);
  });

  it('画布取色消费点 == 15 个变量，且画布底仍走 var(--bg-scene)', () => {
    const used = [...new Set([...graphSrc.matchAll(/getThemeVar\(\s*'(--graph-[\w-]+)'/g)].map((m) => m[1]))].sort();
    expect(used, 'getThemeVar 实际消费的变量集合与登记表不符（新增变量必须先登记口径）').toEqual(ALL15);
    const wrapper = ruleBodies(graphSrc, '.graph-canvas-wrapper');
    expect(wrapper.length, '找不到 .graph-canvas-wrapper 规则').toBeGreaterThan(0);
    expect(
      wrapper.some((b) => /background:\s*var\(--bg-scene\)/.test(b)),
      '画布底色不再是 var(--bg-scene)：对比面变了，CANVAS_BASELINE 整表作废需重推',
    ).toBe(true);
  });

  it("节点辉光仍是 bg + 'aa' 拼接式，且填充色为 #rrggbb（拼接才合法）", () => {
    expect(graphSrc, "辉光取色不再是 `bg + 'aa'`：GLOW_BASELINE 与 6 位 hex 约束要按新口径重推").toMatch(/shadow:[\s\S]{0,80}color:\s*bg \+ 'aa'/);
    for (const base of BASES) {
      for (const v of FILL_VARS) {
        const raw = (base.decls.get(v) ?? '').trim();
        expect(raw, `${base.name} · ${v} 写成 rgba()/颜色名时，+'aa' 拼出的是非法颜色，vis 会静默丢掉整个辉光`).toMatch(/^#[0-9a-fA-F]{6}$/);
      }
    }
  });
});

describe('D · 数值口径：改前留档 + 只降不升 + 缺口登记', () => {
  it('画布 15 变量 × 9 底的实算值不低于留档表（调色只许变好，变坏即红）', () => {
    const diffs: string[] = [];
    for (const base of BASES) {
      const row = CANVAS_BASELINE[base.name];
      expect(row, `留档表缺少底 ${base.name}`).toBeTruthy();
      const now = canvasRatios(base);
      for (const v of CANVAS_VARS) {
        if (now[v] < row[v] - EPS) diffs.push(`${base.name} · ${v}：${now[v].toFixed(3)} < 留档 ${row[v]}（对比度下降）`);
      }
    }
    expect(diffs, diffs.join('\n  ')).toEqual([]);
  });

  it('图例点 6 变量 × 9 底的实算值不低于留档表', () => {
    const diffs: string[] = [];
    for (const base of BASES) {
      const row = LEGEND_BASELINE[base.name];
      expect(row, `留档表缺少底 ${base.name}`).toBeTruthy();
      const now = legendRatios(base);
      for (const v of LEGEND_VARS) {
        if (now[v] < row[v] - EPS) diffs.push(`${base.name} · ${v}：${now[v].toFixed(3)} < 留档 ${row[v]}`);
      }
    }
    expect(diffs, diffs.join('\n  ')).toEqual([]);
  });

  it('节点辉光（bg + \'aa\'）6 变量 × 9 底不低于留档表（装饰面：留档不判达标）', () => {
    const diffs: string[] = [];
    for (const base of BASES) {
      const row = GLOW_BASELINE[base.name];
      expect(row, `辉光留档表缺少底 ${base.name}`).toBeTruthy();
      const now = glowRatios(base);
      for (const v of FILL_VARS) {
        if (now[v] < row[v] - EPS) diffs.push(`${base.name} · ${v}：${now[v].toFixed(3)} < 留档 ${row[v]}`);
      }
    }
    expect(diffs, diffs.join('\n  ')).toEqual([]);
  });

  it('未达标格集合 == 改前登记的缺口（新缺口与「顺手改达标」都必须先动这张表）', () => {
    const expected = [
      ...underSet(CANVAS_BASELINE, (v) => KIND[v]),
      ...underSet(LEGEND_BASELINE, () => 'ui'),
    ].sort();
    const now: string[] = [];
    for (const base of BASES) {
      for (const [v, r] of Object.entries(canvasRatios(base))) if (r < THRESHOLD[KIND[v]]) now.push(`${base.name} · ${v}`);
      for (const [v, r] of Object.entries(legendRatios(base))) if (r < THRESHOLD.ui) now.push(`${base.name} · ${v}`);
    }
    now.sort();
    expect(now, `缺口登记与现状不一致。\n新增缺口需配套设计裁决；已消除的缺口说明色板被改过——本单口径不合并调色，请走画布色板裁决单。\n现状：${now.join(' | ')}`).toEqual(expected);
  });

  it('画布上唯一的文字（节点标签）在 9 个底均达 AA 4.5', () => {
    for (const base of BASES) {
      const r = worstRatio('var(--graph-label)', 'var(--bg-scene)', base.decls, pageOf(base.decls));
      expect(r, `${base.name} · --graph-label = ${r.toFixed(2)}`).toBeGreaterThanOrEqual(THRESHOLD.text);
    }
  });
});
