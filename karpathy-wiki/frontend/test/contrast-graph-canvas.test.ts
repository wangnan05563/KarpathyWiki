// ============================================================
// T04469 + T04513：图谱画布的完整性锁 + 对比度口径锁 + 独立配色档锁
//
// 为什么单开一把锁（而不是并进 contrast-sweep-* 那些「扫 CSS 声明」的锁）：
// 画布上的节点色 / 边色 / 标签色不是 CSS 声明出来的，而是 Graph.vue 的 <script> 用
// getComputedStyle 读变量后交给 vis-network 画到 canvas 上。静态扫描器逐条读
// `<style>` 里的 color:/background: 声明，看不见这条运行时链路 ——
// 于是「sweep 全绿」与「画布配色达标」是两件互不蕴含的事，历史上一缺一漏就是这么来的。
//
// T04513 裁决（方案 2「独立画布配对 token」）在本锁上的增量：
//   决策前的事实：9 个底里 8 个有未达标格（最差 macaron 1.15）。两个结构性成因：
//     ① 边色 --graph-edge 自带 token alpha（0.45/0.35/0.22），可达成对比度被 alpha 封顶，
//        即使把色相压到纯黑也过不了 3.0（色相保序的最优解 k=0.00 仍不足）；
//     ② vis 的边色另叠一层 color.opacity（huge ? 0.25 : 0.5），与 token alpha 相乘。
//   决策：另立 --graph-*-readable 配对档（不透明实色）供画布消费；原始 --graph-* 保留为
//   色相来源（Browse.vue 的时效角标仍把它当底色用），buildEdges 去掉 color.opacity。
//   → 本锁随之从「只负责不许无声变化」升级为「0 缺口 + 防错接 + 防透明度回退」。
//
// 本锁守护的五件事：
//   A. 主题集合完整性：可选主题（useTheme.ts）必须全部落在被审计集合里（含写 tokens.css 的 dark）。
//   B. 声明矩阵：9 个底 × 15 个画布变量逐个有明确来源（本主题自声明 / 显式继承 :root）。
//   C. 运行时链路：兜底表 / getThemeVar 可观测 / 图例点与画布底的真实消费点。
//   D. 数值口径：画布面（--bg-scene）、图例点面（卡片面）、辉光（bg + 'aa'）三张表只降不升，
//      且未达标格必须为空（改后口径 = 达标）。
//   E. 定调表：每个 -readable 要么别名同色相基色，要么是登记过的调深值，且不透明。
//   F. 防错接：目录取色 / 边色只能读 -readable；buildEdges 不得再叠 vis opacity。
//
// 关于 dark：整套画布色板写在 tokens.css（不在 styles/themes/ 下），loadThemes() 看不见它，
// 所以用 loadAuxTheme 单列为第 9 个底。按用户 2026-11-07 裁决，dark **不**并入 loadThemes()：
// 那是 14 把锁的共同主题源，多一个主题会让 T04449/T04470/T04472 冻住的「8 主题」计数与
// 逐主题最差值同时漂移。要纳入 dark 须另开单统一重冻三套基线。
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
  rgbToHex,
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

/** 画布实际消费的 14 个可读档（T04513 新增的配对 token） */
const READABLE_VARS = [
  ...DIRS.map((d) => `--graph-${d}-readable`),
  ...DIRS.map((d) => `--graph-${d}-border-readable`),
  '--graph-edge-readable',
  '--graph-edge-highlight-readable',
];

/** 画布用到的 15 个变量：14 个可读档 + 节点标签（标签本就没有「原色/可读」之分） */
const CANVAS_VARS = [...READABLE_VARS, '--graph-label'];

/** 可读档 → 它对应的原始色相来源（前者是派生，后者是色相单一来源） */
const paletteOf = (v: string) => v.replace(/-readable$/, '');

/** 6 个目录填充可读档：既是节点填充 / 辉光的输入，也是图例点的底色 */
const FILL_VARS = DIRS.map((d) => `--graph-${d}-readable`);
/** 图例点（与 FILL_VARS 同一组色）在 DOM 上，所在面是卡片 */
const LEGEND_VARS = FILL_VARS;

/**
 * 口径分类：只有节点标签是文字（AA 4.5），其余是图形（WCAG 1.4.11 → 3.0）。
 * 这条分类被 D 腿的缺口登记依赖——改动分类等于改判定口径，缺口集会整片变红，
 * 逼迫改的人显式承认「我在换口径」，而不是让同一份色板换个尺子就全绿。
 */
const KIND: Record<string, 'text' | 'ui'> = Object.fromEntries(
  CANVAS_VARS.map((v) => [v, v === '--graph-label' ? 'text' : 'ui']),
);

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
 * 声明矩阵基线（T04513 实算）：除 creative 整套继承 :root（它的画布色就用霓虹原色），
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
 * 改后事实留档（T04513 实算，最差值/3 位小数）：14 个可读档 + 标签各自对画布底色
 * `.graph-canvas-wrapper { background: var(--bg-scene) }` 的最差对比度。
 * 取值口径 = 以色相不变、只降明度搜到的「刚好达标」值（目标 ≥3.05，给 8bit 取整留余量）。
 * D 腿按「只降不升」比对——谁把某格改差，必须同时改这张表（diff 可见，不许悄悄绿）。
 */
const CANVAS_BASELINE: Record<string, Record<string, number>> = {
  'default(:root)': { '--graph-entities-readable': 5.402, '--graph-concepts-readable': 15.292, '--graph-comparisons-readable': 4.504, '--graph-queries-readable': 6.691, '--graph-qa-readable': 9.42, '--graph-solutions-readable': 15.444, '--graph-entities-border-readable': 6.649, '--graph-concepts-border-readable': 16.713, '--graph-comparisons-border-readable': 7.017, '--graph-queries-border-readable': 8.914, '--graph-qa-border-readable': 12.047, '--graph-solutions-border-readable': 16.146, '--graph-edge-readable': 4.504, '--graph-edge-highlight-readable': 15.292, '--graph-label': 17.664 },
  creative: { '--graph-entities-readable': 5.402, '--graph-concepts-readable': 15.292, '--graph-comparisons-readable': 4.504, '--graph-queries-readable': 6.691, '--graph-qa-readable': 9.42, '--graph-solutions-readable': 15.444, '--graph-entities-border-readable': 6.649, '--graph-concepts-border-readable': 16.713, '--graph-comparisons-border-readable': 7.017, '--graph-queries-border-readable': 8.914, '--graph-qa-border-readable': 12.047, '--graph-solutions-border-readable': 16.146, '--graph-edge-readable': 4.504, '--graph-edge-highlight-readable': 15.292, '--graph-label': 17.664 },
  ecommerce: { '--graph-entities-readable': 3.058, '--graph-concepts-readable': 3.12, '--graph-comparisons-readable': 4.689, '--graph-queries-readable': 3.109, '--graph-qa-readable': 3.06, '--graph-solutions-readable': 3.082, '--graph-entities-border-readable': 3.109, '--graph-concepts-border-readable': 3.117, '--graph-comparisons-border-readable': 3.223, '--graph-queries-border-readable': 3.055, '--graph-qa-border-readable': 3.109, '--graph-solutions-border-readable': 3.094, '--graph-edge-readable': 3.058, '--graph-edge-highlight-readable': 3.12, '--graph-label': 16.464 },
  enterprise: { '--graph-entities-readable': 4.718, '--graph-concepts-readable': 3.089, '--graph-comparisons-readable': 4.077, '--graph-queries-readable': 3.357, '--graph-qa-readable': 3.076, '--graph-solutions-readable': 3.088, '--graph-entities-border-readable': 3.357, '--graph-concepts-border-readable': 3.099, '--graph-comparisons-border-readable': 3.138, '--graph-queries-border-readable': 3.06, '--graph-qa-border-readable': 3.098, '--graph-solutions-border-readable': 3.093, '--graph-edge-readable': 4.718, '--graph-edge-highlight-readable': 3.089, '--graph-label': 16.296 },
  'light-business': { '--graph-entities-readable': 6.03, '--graph-concepts-readable': 3.785, '--graph-comparisons-readable': 4.403, '--graph-queries-readable': 5.407, '--graph-qa-readable': 3.11, '--graph-solutions-readable': 3.073, '--graph-entities-border-readable': 4.403, '--graph-concepts-border-readable': 3.072, '--graph-comparisons-border-readable': 3.054, '--graph-queries-border-readable': 3.31, '--graph-qa-border-readable': 3.082, '--graph-solutions-border-readable': 3.071, '--graph-edge-readable': 6.03, '--graph-edge-highlight-readable': 6.03, '--graph-label': 17.463 },
  macaron: { '--graph-entities-readable': 3.05, '--graph-concepts-readable': 3.1, '--graph-comparisons-readable': 3.136, '--graph-queries-readable': 3.109, '--graph-qa-readable': 3.081, '--graph-solutions-readable': 3.051, '--graph-entities-border-readable': 3.109, '--graph-concepts-border-readable': 3.16, '--graph-comparisons-border-readable': 3.075, '--graph-queries-border-readable': 3.094, '--graph-qa-border-readable': 3.164, '--graph-solutions-border-readable': 3.067, '--graph-edge-readable': 3.136, '--graph-edge-highlight-readable': 3.1, '--graph-label': 9.697 },
  portfolio: { '--graph-entities-readable': 3.055, '--graph-concepts-readable': 3.678, '--graph-comparisons-readable': 14.271, '--graph-queries-readable': 3.065, '--graph-qa-readable': 3.859, '--graph-solutions-readable': 3.12, '--graph-entities-border-readable': 3.065, '--graph-concepts-border-readable': 3.076, '--graph-comparisons-border-readable': 8.907, '--graph-queries-border-readable': 3.079, '--graph-qa-border-readable': 3.076, '--graph-solutions-border-readable': 3.103, '--graph-edge-readable': 3.055, '--graph-edge-highlight-readable': 3.055, '--graph-label': 14.271 },
  product: { '--graph-entities-readable': 5.393, '--graph-concepts-readable': 15.179, '--graph-comparisons-readable': 4.557, '--graph-queries-readable': 11.497, '--graph-qa-readable': 10.664, '--graph-solutions-readable': 5.145, '--graph-entities-border-readable': 5.969, '--graph-concepts-border-readable': 15.869, '--graph-comparisons-border-readable': 6.824, '--graph-queries-border-readable': 13.75, '--graph-qa-border-readable': 12.062, '--graph-solutions-border-readable': 7.704, '--graph-edge-readable': 15.179, '--graph-edge-highlight-readable': 5.393, '--graph-label': 20.355 },
  'dark(tokens.css)': { '--graph-entities-readable': 5.787, '--graph-concepts-readable': 6.951, '--graph-comparisons-readable': 4.499, '--graph-queries-readable': 6.665, '--graph-qa-readable': 7.308, '--graph-solutions-readable': 7.282, '--graph-entities-border-readable': 6.951, '--graph-concepts-border-readable': 8.901, '--graph-comparisons-border-readable': 6.871, '--graph-queries-border-readable': 7.815, '--graph-qa-border-readable': 8.901, '--graph-solutions-border-readable': 8.855, '--graph-edge-readable': 5.787, '--graph-edge-highlight-readable': 5.787, '--graph-label': 15.655 },
};

/** 改后事实留档：6 个图例点（可读档）对卡片面（--bg-card-solid 合成到页面底）的最差对比度 */
const LEGEND_BASELINE: Record<string, Record<string, number>> = {
  'default(:root)': { '--graph-entities-readable': 4.923, '--graph-concepts-readable': 13.936, '--graph-comparisons-readable': 4.105, '--graph-queries-readable': 6.098, '--graph-qa-readable': 8.584, '--graph-solutions-readable': 14.075 },
  creative: { '--graph-entities-readable': 4.923, '--graph-concepts-readable': 13.936, '--graph-comparisons-readable': 4.105, '--graph-queries-readable': 6.098, '--graph-qa-readable': 8.584, '--graph-solutions-readable': 14.075 },
  ecommerce: { '--graph-entities-readable': 3.168, '--graph-concepts-readable': 3.232, '--graph-comparisons-readable': 4.858, '--graph-queries-readable': 3.221, '--graph-qa-readable': 3.171, '--graph-solutions-readable': 3.193 },
  enterprise: { '--graph-entities-readable': 5.168, '--graph-concepts-readable': 3.384, '--graph-comparisons-readable': 4.467, '--graph-queries-readable': 3.678, '--graph-qa-readable': 3.37, '--graph-solutions-readable': 3.383 },
  'light-business': { '--graph-entities-readable': 6.52, '--graph-concepts-readable': 4.093, '--graph-comparisons-readable': 4.761, '--graph-queries-readable': 5.847, '--graph-qa-readable': 3.363, '--graph-solutions-readable': 3.323 },
  macaron: { '--graph-entities-readable': 3.273, '--graph-concepts-readable': 3.326, '--graph-comparisons-readable': 3.365, '--graph-queries-readable': 3.336, '--graph-qa-readable': 3.306, '--graph-solutions-readable': 3.274 },
  portfolio: { '--graph-entities-readable': 3.64, '--graph-concepts-readable': 4.383, '--graph-comparisons-readable': 17.005, '--graph-queries-readable': 3.652, '--graph-qa-readable': 4.598, '--graph-solutions-readable': 3.718 },
  product: { '--graph-entities-readable': 5.047, '--graph-concepts-readable': 14.206, '--graph-comparisons-readable': 4.265, '--graph-queries-readable': 10.76, '--graph-qa-readable': 9.98, '--graph-solutions-readable': 4.815 },
  'dark(tokens.css)': { '--graph-entities-readable': 5.412, '--graph-concepts-readable': 6.501, '--graph-comparisons-readable': 4.208, '--graph-queries-readable': 6.233, '--graph-qa-readable': 6.834, '--graph-solutions-readable': 6.81 },
};

/**
 * 改后事实留档：节点辉光 `shadow.color = bg + 'aa'`（可读档六位 hex 尾接 alpha）对画布面的对比度。
 * 这是**留档 + 只降不升**，不并入 D 的达标缺口集：辉光是装饰性光晕，承载分类信息的是节点本体
 * （填充/描边已判），按 1.4.11「理解内容所必需的图形」它不该占用可达性预算；列进缺口只会稀释信号。
 * 换用可读档之后辉光整体变亮了一档，但仍不达标——这符合上面对它的定位。
 */
const GLOW_BASELINE: Record<string, Record<string, number>> = {
  'default(:root)': { '--graph-entities-readable': 2.819, '--graph-concepts-readable': 6.792, '--graph-comparisons-readable': 2.513, '--graph-queries-readable': 3.396, '--graph-qa-readable': 4.484, '--graph-solutions-readable': 6.826 },
  creative: { '--graph-entities-readable': 2.819, '--graph-concepts-readable': 6.792, '--graph-comparisons-readable': 2.513, '--graph-queries-readable': 3.396, '--graph-qa-readable': 4.484, '--graph-solutions-readable': 6.826 },
  ecommerce: { '--graph-entities-readable': 2.197, '--graph-concepts-readable': 2.145, '--graph-comparisons-readable': 2.637, '--graph-queries-readable': 2.189, '--graph-qa-readable': 2.057, '--graph-solutions-readable': 2.098 },
  enterprise: { '--graph-entities-readable': 2.711, '--graph-concepts-readable': 2.118, '--graph-comparisons-readable': 2.435, '--graph-queries-readable': 2.188, '--graph-qa-readable': 2.071, '--graph-solutions-readable': 2.11 },
  'light-business': { '--graph-entities-readable': 3.14, '--graph-concepts-readable': 2.347, '--graph-comparisons-readable': 2.54, '--graph-queries-readable': 2.921, '--graph-qa-readable': 2.111, '--graph-solutions-readable': 2.074 },
  macaron: { '--graph-entities-readable': 2.216, '--graph-concepts-readable': 2.072, '--graph-comparisons-readable': 2.068, '--graph-queries-readable': 2.248, '--graph-qa-readable': 2.076, '--graph-solutions-readable': 2.042 },
  portfolio: { '--graph-entities-readable': 2.02, '--graph-concepts-readable': 2.237, '--graph-comparisons-readable': 5.249, '--graph-queries-readable': 2.026, '--graph-qa-readable': 2.303, '--graph-solutions-readable': 2.055 },
  product: { '--graph-entities-readable': 2.806, '--graph-concepts-readable': 6.821, '--graph-comparisons-readable': 2.561, '--graph-queries-readable': 5.362, '--graph-qa-readable': 5.04, '--graph-solutions-readable': 2.795 },
  'dark(tokens.css)': { '--graph-entities-readable': 3.23, '--graph-concepts-readable': 3.741, '--graph-comparisons-readable': 2.660, '--graph-queries-readable': 3.614, '--graph-qa-readable': 3.848, '--graph-solutions-readable': 3.861 },
};

/**
 * 定调表（T04513 裁决落地的事实登记）：只登记**调深过**的可读档（原始色相保不住 3.0 的那些）；
 * 未登记的项必须逐字写 `var(<同色相基色>)`，即「原色就达标，直接别名」。
 * 这张表让「某主题的某档被改成相邻目录的颜色」这类错接当场变红（E 腿逐值比对），
 * 也让后续调色必须同步登记——不允许出现「表里没登记、值却和基色不一样」的暗改。
 * creative 整套继承 :root，没有本主题声明，故不登记。
 */
const READABLE_OVERRIDES: Record<string, Record<string, string>> = {
  'default(:root)': { '--graph-edge-readable': '#b026ff' },
  ecommerce: {
    '--graph-entities-readable': '#ff5719',
    '--graph-concepts-readable': '#0099d3',
    '--graph-queries-readable': '#f46000',
    '--graph-qa-readable': '#c18501',
    '--graph-solutions-readable': '#17a37e',
    '--graph-entities-border-readable': '#f46000',
    '--graph-concepts-border-readable': '#0098da',
    '--graph-queries-border-readable': '#f36400',
    '--graph-qa-border-readable': '#bd8500',
    '--graph-solutions-border-readable': '#1ea54f',
    '--graph-edge-readable': '#ff5719',
    '--graph-edge-highlight-readable': '#0099d3',
  },
  enterprise: {
    '--graph-concepts-readable': '#0599b2',
    '--graph-qa-readable': '#c27d08',
    '--graph-solutions-readable': '#0e9f6f',
    '--graph-concepts-border-readable': '#0d99ae',
    '--graph-comparisons-border-readable': '#737ff7',
    '--graph-queries-border-readable': '#348cf9',
    '--graph-qa-border-readable': '#b48303',
    '--graph-solutions-border-readable': '#229e71',
    '--graph-edge-readable': '#2563eb',
    '--graph-edge-highlight-readable': '#0599b2',
  },
  'light-business': {
    '--graph-qa-readable': '#d96f20',
    '--graph-solutions-readable': '#2ca064',
    '--graph-concepts-border-readable': '#468fe5',
    '--graph-comparisons-border-readable': '#698bdf',
    '--graph-qa-border-readable': '#d2751b',
    '--graph-solutions-border-readable': '#389f67',
    '--graph-edge-readable': '#1554d1',
  },
  macaron: {
    '--graph-entities-readable': '#ff428d',
    '--graph-concepts-readable': '#389c8e',
    '--graph-comparisons-readable': '#ac73dc',
    '--graph-queries-readable': '#ff417b',
    '--graph-qa-readable': '#cc7a00',
    '--graph-solutions-readable': '#569f39',
    '--graph-entities-border-readable': '#ff417b',
    '--graph-concepts-border-readable': '#2a9c85',
    '--graph-comparisons-border-readable': '#af76d4',
    '--graph-queries-border-readable': '#ff4378',
    '--graph-qa-border-readable': '#c67a00',
    '--graph-solutions-border-readable': '#46a122',
    '--graph-edge-readable': '#ac73dc',
    '--graph-edge-highlight-readable': '#389c8e',
  },
  portfolio: {
    '--graph-entities-readable': '#a08037',
    '--graph-queries-readable': '#8f702c', /* T04569：与 entities #a08037 最近对 ΔE 2.6→6.44 */
    '--graph-entities-border-readable': '#a27f32',
    '--graph-concepts-border-readable': '#958254',
    '--graph-queries-border-readable': '#9f8028',
    '--graph-qa-border-readable': '#958254',
    '--graph-solutions-border-readable': '#6f8d3b',
    '--graph-edge-readable': '#a08037',
    '--graph-edge-highlight-readable': '#a08037',
  },
  product: { '--graph-edge-readable': '#00ff88' },
  'dark(tokens.css)': {
    '--graph-edge-readable': '#4d8dff',
    '--graph-comparisons-readable': '#3b76f6', /* T04569：与 entities 最近对 ΔE 4.62→13.25 */
    '--graph-queries-readable': '#5ab1ff', /* T04569：与 concepts 最近对 ΔE 3.09→16.92 */
  },
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
 * 声明串的「同值」归一：只折叠空白、并把 hex 字面量转小写。
 * 不整体 lower —— CSS 自定义属性名大小写敏感，`var(--graph-Entities)` 是真缺陷，
 * 不能让它被归一掩盖；而 `#FF5719` 与 `#ff5719` 是同一个颜色，不该报漂移。
 */
const normalizeDecl = (s: string) => s.replace(/\s+/g, ' ').trim().replace(/#[0-9a-fA-F]{3,8}\b/g, (m) => m.toLowerCase());

/** 把 token 解析成六位 hex（画布前景必须是不透明实色，渐变一律当场抛错） */
function hexOf(decls: Map<string, string>, expr: string): string {
  const r = resolve(expr, decls);
  if ('stops' in r) throw new Error(`${expr} 解析成渐变，不能作为画布前景`);
  return rgbToHex(r.solid);
}

/**
 * 辉光对比度：复刻 Graph.vue 的 `bg + 'aa'`（可读档解析成六位 hex 后尾接 alpha）再按 alpha 合面实算。
 * 为什么先解析：可读档多数写成 `var(--graph-*)` 别名，直接拿声明串拼 'aa' 会拼成非法颜色。
 * 解析后不是六位 hex（rgba / 颜色名）也当场抛错——vis 会静默丢掉整个 shadow。
 */
function glowRatios(base: Base): Record<string, number> {
  const page = pageOf(base.decls);
  return Object.fromEntries(
    FILL_VARS.map((v) => {
      const raw = hexOf(base.decls, `var(${v})`);
      if (!/^#[0-9a-fA-F]{6}$/.test(raw)) throw new Error(`${base.name} · ${v} 解析后不是 #rrggbb（得到 ${raw}），无法按 bg + 'aa' 实算辉光`);
      return [v, worstRatio(`${raw}aa`, 'var(--bg-scene)', base.decls, page)];
    }),
  );
}

/** 从留档表派生「未达标格」，避免第二份手工清单与表失步 */
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

/** 按大括号配平取出函数体（headRe 要求 function 关键字，注释/模板里的同名文本不会命中） */
function functionBody(src: string, headRe: RegExp, what: string): string {
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
  return src.slice(start, i - 1);
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

describe('C · 运行时链路：兜底可观测 + 消费点接的是可读档', () => {
  it('兜底表键集合 == 15 个画布变量，且逐条解析后等于 :root 的声明值', () => {
    const table = stringObjectLiteral(graphSrc, /const GRAPH_VAR_FALLBACKS[^=]*=/, 'GRAPH_VAR_FALLBACKS 兜底表');
    expect([...table.keys()].sort()).toEqual(ALL15);
    const rootDecl = parseRootDecls();
    for (const [v, fallback] of table) {
      expect(rootDecl.get(v), `:root 里没有 ${v} 的声明，兜底表无从比对`).toBeTruthy();
      // JS 侧要的是**具体色值**（vis 不接受 var() 串），所以比解析值而不是声明串：
      // 否则「:root 写成别名 + 兜底表写死 hex」这对天然正确的关系会被误判成漂移。
      expect(hexOf(rootDecl, `var(${v})`), `${v} 的兜底值 ${fallback} 与 :root 解析值漂移`).toBe(hexOf(rootDecl, fallback));
    }
  });

  it('getThemeVar 里不再写死色值，缺声明会 console.warn（可观测是修复的实质）', () => {
    const body = functionBody(graphSrc, /function getThemeVar\([^)]*\)\s*:\s*string\s*\{/, 'getThemeVar 函数体');
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

  it('6 个图例点按目录顺序消费各自的可读档（错接相邻目录即红）', () => {
    const legendDirs = [...graphSrc.matchAll(/class="legend-dot" style="background: var\(--graph-([\w-]+?)-readable\)/g)].map((m) => m[1]);
    expect(legendDirs, '图例点的取色变量与目录顺序/命名不符：图例是「颜色 → 目录」的唯一图面映射，错一位就会误导读者').toEqual([...DIRS]);
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

  it("节点辉光仍是 bg + 'aa' 拼接式", () => {
    expect(graphSrc, "辉光取色不再是 `bg + 'aa'`：GLOW_BASELINE 的实算口径要按新写法重推").toMatch(/shadow:[\s\S]{0,80}color:\s*bg \+ 'aa'/);
  });
});

describe('D · 数值口径：改后留档 + 只降不升 + 零缺口', () => {
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

  it("节点辉光（bg + 'aa'）6 变量 × 9 底不低于留档表（装饰面：留档不判达标）", () => {
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

  it('未达标格必须为空（三张留档表自身）——T04513 的验收口径就是「0 缺口」', () => {
    expect(underSet(CANVAS_BASELINE, (v) => KIND[v]), '画布留档表里仍有未达 3.0 的可读档：调深没到位').toEqual([]);
    expect(underSet(LEGEND_BASELINE, () => 'ui'), '图例留档表里仍有未达 3.0 的可读档：调深没到位').toEqual([]);
  });

  it('实算缺口集为空（画布 15 格 + 图例 6 格 × 9 底）', () => {
    const now: string[] = [];
    for (const base of BASES) {
      for (const [v, r] of Object.entries(canvasRatios(base))) if (r < THRESHOLD[KIND[v]]) now.push(`${base.name} · ${v}（${r.toFixed(2)}）`);
      for (const [v, r] of Object.entries(legendRatios(base))) if (r < THRESHOLD.ui) now.push(`${base.name} · ${v}（图例，${r.toFixed(2)}）`);
    }
    expect(now, `画布仍有未达标格。调深可读档（保持色相只降明度）后同步三张留档表：\n  ${now.join('\n  ')}`).toEqual([]);
  });

  it('画布上唯一的文字（节点标签）在 9 个底均达 AA 4.5', () => {
    for (const base of BASES) {
      const r = worstRatio('var(--graph-label)', 'var(--bg-scene)', base.decls, pageOf(base.decls));
      expect(r, `${base.name} · --graph-label = ${r.toFixed(2)}`).toBeGreaterThanOrEqual(THRESHOLD.text);
    }
  });
});

describe('E · 定调表：可读档只许「别名同色相基色」或「登记过的调深值」', () => {
  it('本主题声明的可读档与定调表逐字一致（未登记项必须是 var(<同色相基色>)）', () => {
    for (const base of BASES) {
      const own = ownDeclsOf(base);
      const overrides = READABLE_OVERRIDES[base.name] ?? {};
      for (const v of READABLE_VARS) {
        const declared = own.get(v);
        if (declared === undefined) continue; // 整套继承 :root 的底（creative），由下一条解析值断言覆盖
        const expected = overrides[v] ?? `var(${paletteOf(v)})`;
        expect(normalizeDecl(declared), `${base.name} · ${v} 的来源不在定调表里（改色板须同步 READABLE_OVERRIDES）`).toBe(normalizeDecl(expected));
      }
      // 反向：定调表登记了、主题却没自己声明 = 表与实现脱节（creative 不登记，天然跳过）
      for (const v of Object.keys(overrides)) {
        expect(own.has(v), `${base.name} 的定调表登记了 ${v}，但本主题没有声明它`).toBe(true);
      }
    }
  });

  it('解析值：可读档 == 登记的调深值；未登记项 == 同色相基色的解析值', () => {
    for (const base of BASES) {
      const overrides = READABLE_OVERRIDES[base.name] ?? {};
      for (const v of READABLE_VARS) {
        const got = hexOf(base.decls, `var(${v})`);
        const want = hexOf(base.decls, overrides[v] ?? `var(${paletteOf(v)})`);
        expect(got, `${base.name} · ${v} 实际解析成 ${got}，期望 ${want}（错接了别的目录/别的色相来源）`).toBe(want);
      }
    }
  });

  it('可读档必须是不透明实色（alpha 会封顶可达成对比度，正是边色旧缺陷的根因）', () => {
    for (const base of BASES) {
      for (const v of READABLE_VARS) {
        const r = resolve(`var(${v})`, base.decls);
        expect('stops' in r, `${base.name} · ${v} 解析成渐变，画布前景不能是渐变`).toBe(false);
        if ('solid' in r) {
          expect(r.solid.a, `${base.name} · ${v} 带 alpha：token alpha 与 vis opacity 都会直接压低画布对比度`).toBe(1);
        }
      }
    }
  });
});

describe('F · 防错接：目录/边色只读可读档，且不再叠加 vis opacity', () => {
  it('buildEdges 消费可读边色，且不再给边加 color.opacity', () => {
    const body = functionBody(graphSrc, /function buildEdges\([^)]*\)[^{]*\{/, 'buildEdges');
    expect(body, 'buildEdges 又给边色加了 opacity：会与 token 的 alpha/亮度相乘，把对比度封在 3.0 以下').not.toMatch(/\bopacity\s*:/);
    expect(body, 'buildEdges 没有消费 --graph-edge-readable').toMatch(/--graph-edge-readable/);
    expect(body, 'buildEdges 没有消费 --graph-edge-highlight-readable').toMatch(/--graph-edge-highlight-readable/);
    const bare = [...body.matchAll(/getThemeVar\(\s*'(--graph-edge[\w-]*)'/g)].map((m) => m[1]).filter((v) => !/-readable$/.test(v));
    expect(bare, `buildEdges 又读回未调深的边色：${bare.join(', ')}（旧缺陷：对 --bg-scene 仅 1.2~1.7）`).toEqual([]);
  });

  it('目录取色只读可读档（节点本体/描边不许回到裸基色）', () => {
    for (const fn of ['getDirColors', 'getDirBorders']) {
      const body = functionBody(graphSrc, new RegExp(`function ${fn}\\([^)]*\\)[^{]*\\{`), fn);
      const used = [...body.matchAll(/getThemeVar\(\s*'(--graph-[\w-]+)'/g)].map((m) => m[1]);
      const bare = used.filter((v) => !/-readable$/.test(v));
      expect(bare, `${fn} 里出现未调深的基色：${bare.join(', ')}（画布节点会重新掉回不达标配色）`).toEqual([]);
      expect(used.length, `${fn} 的取色项数变了，DIRS 需同步`).toBe(DIRS.length);
    }
  });
});

// ============================================================
// T04569：目录填充色可辨识锁（ΔE76 最近对 ≥ 5）
//
// 与 D 腿的「对画布底对比度（WCAG 1.4.11 ≥ 3.0）」是两条独立尺子：
//   D 腿管「节点色 vs 背景」是否够亮；本腿管「6 类目录彼此」是否够分得开。
// T04513 把 6 色压深达标时收窄了色间距，portfolio 最近一对从 5.3 掉到 2.6、dark 存量 3.1，
// 并排几乎分不出谁是谁。本腿把「最近一对 ΔE ≥ 5」定为可辨识下限，改色板时一并锁住。
// 阈值取任务建议的低档（≥ 5；高档 ≥ 10 留给后续统一重冻基线）：≥ 5 即人眼并排可分辨。
// ============================================================
const DE_THRESHOLD = 5.0;

/** sRGB(#rrggbb) → CIELAB（D65），自实现，不依赖第三方色彩库 */
function srgbToLab(hex: string): [number, number, number] {
  const r = parseInt(hex.slice(1, 3), 16) / 255;
  const g = parseInt(hex.slice(3, 5), 16) / 255;
  const b = parseInt(hex.slice(5, 7), 16) / 255;
  const lin = (c: number) => (c <= 0.04045 ? c / 12.92 : Math.pow((c + 0.055) / 1.055, 2.4));
  const R = lin(r), G = lin(g), B = lin(b);
  const X = (R * 0.4124 + G * 0.3576 + B * 0.1805) / 0.95047;
  const Y = (R * 0.2126 + G * 0.7152 + B * 0.0722) / 1.0;
  const Z = (R * 0.0193 + G * 0.1192 + B * 0.9505) / 1.08883;
  const f = (t: number) => (t > 0.008856 ? Math.cbrt(t) : 7.787 * t + 16 / 116);
  const fx = f(X), fy = f(Y), fz = f(Z);
  return [116 * fy - 16, 500 * (fx - fy), 200 * (fy - fz)];
}

/** 一组 hex 的两两 ΔE76 最近一对（越小越难分辨） */
function nearestDeltaE(hexes: string[]): number {
  let best = Infinity;
  for (let i = 0; i < hexes.length; i++) {
    for (let j = i + 1; j < hexes.length; j++) {
      const [L1, a1, b1] = srgbToLab(hexes[i]);
      const [L2, a2, b2] = srgbToLab(hexes[j]);
      const d = Math.sqrt((L1 - L2) ** 2 + (a1 - a2) ** 2 + (b1 - b2) ** 2);
      if (d < best) best = d;
    }
  }
  return best;
}

describe('G · 目录填充色可辨识（T04569）：同底 6 类目录最近一对 ΔE76 ≥ 5', () => {
  it('每个底的 6 个 --graph-<dir>-readable 两两最近对 ΔE ≥ 5（并排可分辨，不互相吞色）', () => {
    const fails: string[] = [];
    for (const base of BASES) {
      const hexes = DIRS.map((d) => hexOf(base.decls, `var(--graph-${d}-readable)`));
      const de = nearestDeltaE(hexes);
      if (de < DE_THRESHOLD) fails.push(`${base.name}：最近一对 ΔE=${de.toFixed(2)} < ${DE_THRESHOLD}`);
    }
    expect(fails, `以下底的目录填充色彼此太接近，画布节点会难以区分：\n  ${fails.join('\n  ')}`).toEqual([]);
  });
});
