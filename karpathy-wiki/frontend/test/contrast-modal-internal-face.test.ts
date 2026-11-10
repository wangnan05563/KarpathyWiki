// T04530 —— 弹窗内前景消费点的「模态面」口径锁。
//
// 背景：T04524 把模态面口径写进 helpers，但全站只有引用溯源命中高亮一族接上；
// 其余弹窗内规则仍按「卡片压页底」实算，未把 0.58 遮罩计进落点。
// 工单原描述的「dark 4.57 判过 / 4.21 判红」来自把遮罩压在卡片之上的旧画序；真实 DOM 里
// `.el-dialog` 是 `.el-overlay` 的子节点、画在遮罩之上，遮罩只透过卡片 alpha 渗入（见 helpers 注释），
// 修正后深底 dark 实算 10.17、真正跌破的是 default/creative/product 的题面黄片 4.21~4.27（T04524 已修）。
// 本锁做三件事：
//   1) 把 `src/components/{AppModal,CitationModal,ForceChangePassword}.vue` 与
//      `src/views/{About,Config,DataClean,Health,Progress,Query,Tunnel,Users}.vue` 里
//      **渲染在 AppModal 内部**的前景声明逐条登记（file + selector + property + 声明原文）。
//      完整性由扫描器保证：源码里新增/删除一条弹窗内前景声明而账本没跟上 → 本锁红。
//   2) 每一点按 modalFaces() 两张落点（共用组件再叠页底）取最差；元素自声明面/祖先面色逐条登记并在源码里复核，
//      防「面被偷抬」。修法只允许换前景 token（面优先不动，禁改 --bg-card-solid 本体与遮罩 alpha）。
//      数值锁跑 8 个**可渲染**主题（:root 只是继承兜底，首帧就写 data-theme，与 T04904 同口径）；
//      纯容器分隔描边登记为 decor（WCAG 1.4.11 不覆盖装饰），数值在 B4 留档防漂移。
//   3) 前提锁：遮罩来源必须仍是 modal.css 的 --modal-mask；对话框背景仍取 --bg-card-solid；
//      裸卡片点所在的容器不得自带背景。前提破了，数值锁会按旧遮罩继续假绿，所以前提先红。
//
// 已知限制：本环境无 Playwright/puppeteer，口径是 CSS 层合成实算（与 T04524 同源），不是像素采样；
// 真实渲染的目测缺口如实登记在回传里，本文件不写「已实测渲染」。
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  MODAL_CSS,
  ROOT,
  THRESHOLD,
  composite,
  loadAuxTheme,
  loadThemes,
  modalFaces,
  overlayExpr,
  pageOf,
  resolve,
  ruleBodies,
  stripComments,
  worstRatio,
  type RGB,
  type ThemeTokens,
} from './helpers/contrast';

type Scope = 'modal' | 'shared';
/** decor = 纯容器分隔描边（WCAG 1.4.11 只覆盖控件/必要图形，装饰性分隔不计门槛；数值另登记在 B4） */
type Kind = 'text' | 'ui' | 'decor';

interface Point {
  /** 相对 src/components 或 src/views 的文件名 */
  f: string;
  /** 规范化后的选择器原文（与样式表逐字一致，逗号列表保留原样） */
  sel: string;
  /** 前景属性（color / border / border-color / border-bottom …） */
  prop: string;
  /** 声明原文（值部分，空白已归一）——值被改而账本不跟即红 */
  decl: string;
  /** 用于实算的前景表达式（border 简写里取出颜色段） */
  fg: string;
  /** 前景之下的面层：空数组 = 直接压模态面；多个数组 = 该点可能出现的多种层叠 */
  layers: string[][];
  kind: Kind;
  /** shared = 同一规则也渲染在页面上（再叠一次页底，避免只修弹窗一侧） */
  scope: Scope;
}

const MODAL_FILES = [
  'components/CitationModal.vue',
  'components/ForceChangePassword.vue',
  'views/About.vue',
  'views/Config.vue',
  'views/DataClean.vue',
  'views/Health.vue',
  'views/Progress.vue',
  'views/Query.vue',
  'views/Tunnel.vue',
  'views/Users.vue',
] as const;

/** 76 条弹窗内前景声明（取证脚本逐规则枚举，非手抄） */
const POINTS: Point[] = [
  // ── CitationModal.vue
  { f: 'CitationModal.vue', sel: '.citation-path', prop: 'color', decl: 'var(--text-soft, #888)', fg: 'var(--text-soft, #888)', layers: [[]], kind: 'text', scope: 'modal' },
  { f: 'CitationModal.vue', sel: '.citation-loading, .citation-empty', prop: 'color', decl: 'var(--text-soft, #888)', fg: 'var(--text-soft, #888)', layers: [[]], kind: 'text', scope: 'modal' },
  { f: 'CitationModal.vue', sel: '.citation-chunk', prop: 'border', decl: '1px solid var(--border-color, rgba(128, 128, 128, 0.25))', fg: 'var(--border-color, rgba(128, 128, 128, 0.25))', layers: [[]], kind: 'decor', scope: 'modal' },
  { f: 'CitationModal.vue', sel: '.citation-chunk-head', prop: 'color', decl: 'var(--accent-readable, var(--neon-cyan))', fg: 'var(--accent-readable, var(--neon-cyan))', layers: [[]], kind: 'text', scope: 'modal' },
  { f: 'CitationModal.vue', sel: '.citation-chunk-heading', prop: 'color', decl: 'var(--text-soft, #888)', fg: 'var(--text-soft, #888)', layers: [[]], kind: 'text', scope: 'modal' },
  { f: 'CitationModal.vue', sel: '.citation-chunk-content', prop: 'color', decl: 'var(--text-base)', fg: 'var(--text-base)', layers: [[]], kind: 'text', scope: 'modal' },
  // ── ForceChangePassword.vue
  { f: 'ForceChangePassword.vue', sel: '.fc-tip', prop: 'color', decl: 'var(--text-soft)', fg: 'var(--text-soft)', layers: [[]], kind: 'text', scope: 'modal' },
  { f: 'ForceChangePassword.vue', sel: '.fc-error', prop: 'color', decl: 'var(--danger-readable)', fg: 'var(--danger-readable)', layers: [[]], kind: 'text', scope: 'modal' },
  // ── About.vue
  { f: 'About.vue', sel: '.empty-hint', prop: 'color', decl: 'var(--text-soft)', fg: 'var(--text-soft)', layers: [[]], kind: 'text', scope: 'modal' },
  { f: 'About.vue', sel: '.license-name', prop: 'color', decl: 'var(--text-base)', fg: 'var(--text-base)', layers: [[]], kind: 'text', scope: 'modal' },
  { f: 'About.vue', sel: '.license-name:hover', prop: 'color', decl: 'var(--accent-readable, var(--neon-cyan))', fg: 'var(--accent-readable, var(--neon-cyan))', layers: [['var(--accent-purple-a08)']], kind: 'text', scope: 'modal' },
  { f: 'About.vue', sel: '.license-version', prop: 'color', decl: 'var(--text-soft)', fg: 'var(--text-soft)', layers: [[]], kind: 'text', scope: 'modal' },
  { f: 'About.vue', sel: '.dialog-footer-hint', prop: 'color', decl: 'var(--text-soft)', fg: 'var(--text-soft)', layers: [[]], kind: 'text', scope: 'modal' },
  // ── Config.vue
  { f: 'Config.vue', sel: '.restart-guide-lead', prop: 'color', decl: 'var(--text-soft)', fg: 'var(--text-soft)', layers: [[]], kind: 'text', scope: 'modal' },
  { f: 'Config.vue', sel: '.restart-guide-reason', prop: 'color', decl: 'var(--text-soft)', fg: 'var(--text-soft)', layers: [[]], kind: 'text', scope: 'modal' },
  { f: 'Config.vue', sel: '.restart-guide-notice', prop: 'color', decl: 'var(--warning-readable, var(--warning-accent, var(--warning, #d29922)))', fg: 'var(--warning-readable, var(--warning-accent, var(--warning, #d29922)))', layers: [['var(--warning-accent-soft, rgba(210, 153, 34, 0.1))']], kind: 'text', scope: 'modal' },
  { f: 'Config.vue', sel: '.restart-guide-notice', prop: 'border', decl: '1px solid var(--warning-accent-border, rgba(210, 153, 34, 0.35))', fg: 'var(--warning-accent-border, rgba(210, 153, 34, 0.35))', layers: [['var(--warning-accent-soft, rgba(210, 153, 34, 0.1))']], kind: 'decor', scope: 'modal' },
  { f: 'Config.vue', sel: '.restart-guide-alert', prop: 'color', decl: 'var(--danger-readable, var(--danger, #f85149))', fg: 'var(--danger-readable, var(--danger, #f85149))', layers: [['rgba(248, 81, 73, 0.08)']], kind: 'text', scope: 'modal' },
  { f: 'Config.vue', sel: '.restart-guide-alert', prop: 'border', decl: '1px solid rgba(248, 81, 73, 0.35)', fg: 'rgba(248, 81, 73, 0.35)', layers: [['rgba(248, 81, 73, 0.08)']], kind: 'decor', scope: 'modal' },
  { f: 'Config.vue', sel: '.restart-guide-steps', prop: 'border', decl: '1px solid var(--purple-readable)', fg: 'var(--purple-readable)', layers: [['var(--bg-scene)'], []], kind: 'ui', scope: 'modal' },
  { f: 'Config.vue', sel: '.restart-guide-steps', prop: 'color', decl: 'var(--text-base)', fg: 'var(--text-base)', layers: [['var(--bg-scene)']], kind: 'text', scope: 'modal' },
  { f: 'Config.vue', sel: '.restart-guide-note', prop: 'color', decl: 'var(--text-soft)', fg: 'var(--text-soft)', layers: [[]], kind: 'text', scope: 'modal' },
  { f: 'Config.vue', sel: '.path-guide-lead, .path-guide-current', prop: 'color', decl: 'var(--text-base)', fg: 'var(--text-base)', layers: [[]], kind: 'text', scope: 'modal' },
  { f: 'Config.vue', sel: '.path-guide-steps', prop: 'color', decl: 'var(--text-base)', fg: 'var(--text-base)', layers: [[]], kind: 'text', scope: 'modal' },
  // ── DataClean.vue
  { f: 'DataClean.vue', sel: '.diff-path-a', prop: 'color', decl: 'var(--accent-readable, var(--neon-cyan, #00f5ff))', fg: 'var(--accent-readable, var(--neon-cyan, #00f5ff))', layers: [['var(--bg-scene)']], kind: 'text', scope: 'modal' },
  { f: 'DataClean.vue', sel: '.diff-path-b', prop: 'color', decl: 'var(--pink-readable, var(--accent-pink, #ff6496))', fg: 'var(--pink-readable, var(--accent-pink, #ff6496))', layers: [['var(--bg-scene)']], kind: 'text', scope: 'modal' },
  { f: 'DataClean.vue', sel: '.diff-lines', prop: 'border', decl: '1px solid var(--purple-readable)', fg: 'var(--purple-readable)', layers: [['var(--bg-void)'], []], kind: 'ui', scope: 'modal' },
  { f: 'DataClean.vue', sel: '.diff-line-no', prop: 'color', decl: 'var(--text-soft)', fg: 'var(--text-soft)', layers: [['var(--bg-void)'], ['var(--bg-void)', 'var(--accent-cyan-a10, rgba(0, 255, 200, 0.08))'], ['var(--bg-void)', 'var(--accent-pink-a10, rgba(255, 100, 180, 0.08))']], kind: 'text', scope: 'modal' },
  { f: 'DataClean.vue', sel: '.diff-line-content', prop: 'color', decl: 'var(--text-soft)', fg: 'var(--text-soft)', layers: [['var(--bg-void)']], kind: 'text', scope: 'modal' },
  { f: 'DataClean.vue', sel: '.diff-line-add .diff-line-marker', prop: 'color', decl: 'var(--accent-readable, var(--neon-cyan, #00f5ff))', fg: 'var(--accent-readable, var(--neon-cyan, #00f5ff))', layers: [['var(--bg-void)', 'var(--accent-cyan-a10, rgba(0, 255, 200, 0.08))']], kind: 'text', scope: 'modal' },
  { f: 'DataClean.vue', sel: '.diff-line-add .diff-line-content', prop: 'color', decl: 'var(--accent-readable, var(--neon-cyan, #00f5ff))', fg: 'var(--accent-readable, var(--neon-cyan, #00f5ff))', layers: [['var(--bg-void)', 'var(--accent-cyan-a10, rgba(0, 255, 200, 0.08))']], kind: 'text', scope: 'modal' },
  { f: 'DataClean.vue', sel: '.diff-line-del .diff-line-marker', prop: 'color', decl: 'var(--pink-readable, var(--accent-pink, #ff6496))', fg: 'var(--pink-readable, var(--accent-pink, #ff6496))', layers: [['var(--bg-void)', 'var(--accent-pink-a10, rgba(255, 100, 180, 0.08))']], kind: 'text', scope: 'modal' },
  { f: 'DataClean.vue', sel: '.diff-line-del .diff-line-content', prop: 'color', decl: 'var(--pink-readable, var(--accent-pink, #ff6496))', fg: 'var(--pink-readable, var(--accent-pink, #ff6496))', layers: [['var(--bg-void)', 'var(--accent-pink-a10, rgba(255, 100, 180, 0.08))']], kind: 'text', scope: 'modal' },
  // ── Health.vue
  { f: 'Health.vue', sel: '.estimate-tip, .estimate-basis', prop: 'color', decl: 'var(--text-soft)', fg: 'var(--text-soft)', layers: [[]], kind: 'text', scope: 'modal' },
  { f: 'Health.vue', sel: '.estimate-item', prop: 'border', decl: '1px solid var(--purple-readable)', fg: 'var(--purple-readable)', layers: [['var(--accent-purple-a08)'], []], kind: 'ui', scope: 'modal' },
  { f: 'Health.vue', sel: '.estimate-num', prop: 'color', decl: 'var(--text-bright)', fg: 'var(--text-bright)', layers: [['var(--accent-purple-a08)']], kind: 'text', scope: 'modal' },
  { f: 'Health.vue', sel: '.estimate-label', prop: 'color', decl: 'var(--text-soft)', fg: 'var(--text-soft)', layers: [['var(--accent-purple-a08)']], kind: 'text', scope: 'modal' },
  { f: 'Health.vue', sel: '.estimate-sub', prop: 'color', decl: 'var(--text-soft)', fg: 'var(--text-soft)', layers: [['var(--accent-purple-a08)']], kind: 'text', scope: 'modal' },
  { f: 'Health.vue', sel: '.estimate-basis.is-low-confidence', prop: 'color', decl: 'var(--warning-readable)', fg: 'var(--warning-readable)', layers: [[]], kind: 'text', scope: 'modal' },
  // ── Progress.vue
  { f: 'Progress.vue', sel: '.log-line', prop: 'border-bottom', decl: '1px solid var(--purple-readable)', fg: 'var(--purple-readable)', layers: [[]], kind: 'ui', scope: 'modal' },
  { f: 'Progress.vue', sel: '.log-line.error', prop: 'color', decl: 'var(--pink-readable, var(--neon-magenta))', fg: 'var(--pink-readable, var(--neon-magenta))', layers: [[]], kind: 'text', scope: 'modal' },
  { f: 'Progress.vue', sel: '.log-line.done', prop: 'color', decl: 'var(--accent-readable, var(--neon-cyan))', fg: 'var(--accent-readable, var(--neon-cyan))', layers: [[]], kind: 'text', scope: 'modal' },
  { f: 'Progress.vue', sel: '.log-ts', prop: 'color', decl: 'var(--text-soft)', fg: 'var(--text-soft)', layers: [[]], kind: 'text', scope: 'modal' },
  { f: 'Progress.vue', sel: '.log-step', prop: 'color', decl: 'var(--purple-readable, var(--neon-purple))', fg: 'var(--purple-readable, var(--neon-purple))', layers: [[]], kind: 'text', scope: 'modal' },
  { f: 'Progress.vue', sel: '.log-tool', prop: 'color', decl: 'var(--purple-readable, var(--neon-purple))', fg: 'var(--purple-readable, var(--neon-purple))', layers: [['var(--accent-purple-a15, rgba(176, 38, 255, 0.15))']], kind: 'text', scope: 'modal' },
  { f: 'Progress.vue', sel: '.log-token', prop: 'color', decl: 'var(--text-soft)', fg: 'var(--text-soft)', layers: [[]], kind: 'text', scope: 'modal' },
  { f: 'Progress.vue', sel: '.log-msg', prop: 'color', decl: 'var(--text-base)', fg: 'var(--text-base)', layers: [[]], kind: 'text', scope: 'modal' },
  { f: 'Progress.vue', sel: '.log-err', prop: 'color', decl: 'var(--pink-readable, var(--neon-magenta))', fg: 'var(--pink-readable, var(--neon-magenta))', layers: [[]], kind: 'text', scope: 'modal' },
  // ── Query.vue
  { f: 'Query.vue', sel: '.ib-label', prop: 'color', decl: 'var(--text-base)', fg: 'var(--text-base)', layers: [[]], kind: 'text', scope: 'modal' },
  { f: 'Query.vue', sel: '.ib-slider-value', prop: 'color', decl: 'var(--text-soft)', fg: 'var(--text-soft)', layers: [[]], kind: 'text', scope: 'modal' },
  { f: 'Query.vue', sel: '.ib-qr-item', prop: 'border', decl: '1px solid var(--accent-readable)', fg: 'var(--accent-readable)', layers: [['var(--accent-cyan-a10, rgba(0, 245, 255, 0.1))'], []], kind: 'ui', scope: 'modal' },
  { f: 'Query.vue', sel: '.ib-qr-text', prop: 'color', decl: 'var(--text-base)', fg: 'var(--text-base)', layers: [['var(--accent-cyan-a10, rgba(0, 245, 255, 0.1))']], kind: 'text', scope: 'modal' },
  { f: 'Query.vue', sel: '.ib-qr-del', prop: 'color', decl: 'var(--text-soft)', fg: 'var(--text-soft)', layers: [['var(--accent-cyan-a10, rgba(0, 245, 255, 0.1))']], kind: 'text', scope: 'modal' },
  { f: 'Query.vue', sel: '.ib-qr-del:hover', prop: 'color', decl: 'var(--pink-readable, var(--accent-pink, #ff006e))', fg: 'var(--pink-readable, var(--accent-pink, #ff006e))', layers: [['var(--accent-cyan-a10, rgba(0, 245, 255, 0.1))']], kind: 'text', scope: 'modal' },
  { f: 'Query.vue', sel: '.ib-qr-empty', prop: 'color', decl: 'var(--text-soft)', fg: 'var(--text-soft)', layers: [[]], kind: 'text', scope: 'modal' },
  { f: 'Query.vue', sel: '.video-error-tip', prop: 'border', decl: '1px solid var(--pink-readable)', fg: 'var(--pink-readable)', layers: [['var(--accent-pink-a10, rgba(255, 100, 150, 0.1))'], []], kind: 'ui', scope: 'modal' },
  { f: 'Query.vue', sel: '.video-error-tip', prop: 'color', decl: 'var(--pink-readable, var(--accent-pink, #ff6496))', fg: 'var(--pink-readable, var(--accent-pink, #ff6496))', layers: [['var(--accent-pink-a10, rgba(255, 100, 150, 0.1))']], kind: 'text', scope: 'modal' },
  { f: 'Query.vue', sel: '.video-status-text', prop: 'color', decl: 'var(--text-soft, #888)', fg: 'var(--text-soft, #888)', layers: [[]], kind: 'text', scope: 'modal' },
  { f: 'Query.vue', sel: '.video-tip', prop: 'color', decl: 'var(--text-soft, #888)', fg: 'var(--text-soft, #888)', layers: [[]], kind: 'text', scope: 'modal' },
  { f: 'Query.vue', sel: '.video-download-link', prop: 'color', decl: 'var(--purple-readable, var(--accent-purple, #8a5cf5))', fg: 'var(--purple-readable, var(--accent-purple, #8a5cf5))', layers: [[]], kind: 'text', scope: 'modal' },
  // ── Tunnel.vue
  { f: 'Tunnel.vue', sel: '.wizard-desc', prop: 'color', decl: 'var(--text-soft, #ccc)', fg: 'var(--text-soft, #ccc)', layers: [[]], kind: 'text', scope: 'modal' },
  { f: 'Tunnel.vue', sel: '.auth-url-link', prop: 'color', decl: 'var(--accent-readable, var(--neon-cyan, #00f5ff))', fg: 'var(--accent-readable, var(--neon-cyan, #00f5ff))', layers: [[]], kind: 'text', scope: 'modal' },
  { f: 'Tunnel.vue', sel: '.login-output pre', prop: 'color', decl: 'var(--text-soft, #888)', fg: 'var(--text-soft, #888)', layers: [[]], kind: 'text', scope: 'modal' },
  // ── Users.vue
  { f: 'Users.vue', sel: '.filter-count', prop: 'color', decl: 'var(--text-soft)', fg: 'var(--text-soft)', layers: [[]], kind: 'text', scope: 'shared' },
  { f: 'Users.vue', sel: '.user-name', prop: 'color', decl: 'var(--text-bright)', fg: 'var(--text-bright)', layers: [['var(--el-fill-color-blank, #ffffff)'], ['var(--el-fill-color-lighter, #fafafa)']], kind: 'text', scope: 'shared' },
  { f: 'Users.vue', sel: '.table-empty', prop: 'color', decl: 'var(--text-soft)', fg: 'var(--text-soft)', layers: [['var(--el-fill-color-blank, #ffffff)'], ['var(--el-fill-color-lighter, #fafafa)']], kind: 'text', scope: 'shared' },
  { f: 'Users.vue', sel: '.td-date', prop: 'color', decl: 'var(--text-soft)', fg: 'var(--text-soft)', layers: [['var(--el-fill-color-blank, #ffffff)'], ['var(--el-fill-color-lighter, #fafafa)']], kind: 'text', scope: 'shared' },
  { f: 'Users.vue', sel: '.form-field > label', prop: 'color', decl: 'var(--text-soft)', fg: 'var(--text-soft)', layers: [[]], kind: 'text', scope: 'modal' },
  { f: 'Users.vue', sel: '.field-hint', prop: 'color', decl: 'var(--text-soft)', fg: 'var(--text-soft)', layers: [[]], kind: 'text', scope: 'modal' },
  { f: 'Users.vue', sel: '.field-error-text', prop: 'color', decl: 'var(--pink-readable, var(--neon-magenta))', fg: 'var(--pink-readable, var(--neon-magenta))', layers: [[]], kind: 'text', scope: 'modal' },
  { f: 'Users.vue', sel: '.audit-hint', prop: 'color', decl: 'var(--text-soft)', fg: 'var(--text-soft)', layers: [[]], kind: 'text', scope: 'modal' },
  { f: 'Users.vue', sel: '.neon-btn', prop: 'color', decl: 'var(--on-fire-fg)', fg: 'var(--on-fire-fg)', layers: [['var(--on-fire-bg)']], kind: 'text', scope: 'shared' },
  { f: 'Users.vue', sel: '.neon-btn.secondary', prop: 'color', decl: 'var(--text-soft)', fg: 'var(--text-soft)', layers: [[]], kind: 'text', scope: 'shared' },
  { f: 'Users.vue', sel: '.neon-btn.secondary', prop: 'border', decl: '1px solid var(--purple-readable)', fg: 'var(--purple-readable)', layers: [[]], kind: 'ui', scope: 'shared' },
  { f: 'Users.vue', sel: '.neon-btn.secondary:hover', prop: 'color', decl: 'var(--accent-readable, var(--neon-cyan))', fg: 'var(--accent-readable, var(--neon-cyan))', layers: [[]], kind: 'text', scope: 'shared' },
  { f: 'Users.vue', sel: '.neon-btn.secondary:hover', prop: 'border-color', decl: 'var(--accent-readable, var(--neon-cyan))', fg: 'var(--accent-readable, var(--neon-cyan))', layers: [[]], kind: 'ui', scope: 'shared' },
];

const ALL_THEMES: ThemeTokens[] = [...loadThemes(), loadAuxTheme('dark')];

/**
 * 可渲染主题全集：`default(:root)` 只是继承兜底——首帧 applyTheme 就会写 data-theme，
 * 用户永远看不到「:root 态」（与 T04904 的 RENDERED 口径一致）。它在本锁里会拿 EP 白行
 * 去配深底文字色（.user-name 1.12），那是不可达组合；数值锁按 8 个真实主题算。
 */
const RENDERED = ALL_THEMES.filter((t) => t.name !== 'default(:root)');
/** decor 不计门槛（WCAG 1.4.11 只覆盖控件与必要图形），数值仍登记在 B4 供漂移巡查 */
const need = (p: Point) => (p.kind === 'decor' ? 0 : THRESHOLD[p.kind]);

/** 账本里的 f 是裸文件名；同一文件名在 components/views 下不得重名（重名就该改本锁口径，而不是猜） */
const srcOf = (f: string) => {
  const hits = MODAL_FILES.filter((x) => x.split('/').pop() === f || x === f);
  if (hits.length !== 1) throw new Error(`无法把 ${f} 唯一解析到 MODAL_FILES（命中 ${hits.length}）`);
  return readFileSync(join(ROOT, 'src', hits[0]), 'utf8');
};

const templateText = (src: string) => {
  const m = /<template>([\s\S]*)<\/template>\s*<style/.exec(src);
  return m ? m[1] : '';
};
const modalRanges = (src: string) => {
  const tpl = templateText(src);
  const out: string[] = [];
  for (const m of tpl.matchAll(/<AppModal\b[^>]*>/g)) {
    const start = (m.index ?? 0) + m[0].length;
    const end = tpl.indexOf('</AppModal>', start);
    if (end >= 0) out.push(tpl.slice(start, end));
  }
  return out;
};
const classesOf = (text: string) => {
  const set = new Set<string>();
  for (const m of text.matchAll(/\bclass="([^"]*)"/g)) for (const c of m[1].split(/\s+/)) if (c) set.add(c);
  for (const m of text.matchAll(/:class="([^"]*)"/g)) for (const c of m[1].matchAll(/'([\w-]+)'|"([\w-]+)"/g)) set.add(c[1] || c[2]);
  return set;
};
const styleText = (src: string) => [...src.matchAll(/<style[^>]*>([\s\S]*?)<\/style>/g)].map((m) => m[1]).join('\n;\n');

function* rules(css: string): Generator<{ selector: string; body: string }> {
  let i = 0;
  while (i < css.length) {
    const open = css.indexOf('{', i);
    if (open < 0) return;
    const selector = css.slice(i, open).trim();
    let depth = 1;
    let j = open + 1;
    while (j < css.length && depth > 0) {
      if (css[j] === '{') depth++;
      else if (css[j] === '}') depth--;
      j++;
    }
    const body = css.slice(open + 1, j - 1);
    if (/^@(media|supports)/.test(selector)) yield* rules(body);
    else yield { selector, body };
    i = j;
  }
}

/** 与取证脚本同一口径：AppModal 模板内出现过的 class，其规则里的前景声明 */
const FG_RE = /(?:^|;)\s*(color|border-color|border-(?:left|right|top|bottom)-color|outline-color|border|border-(?:left|right|top|bottom)|outline)\s*:\s*([^;]+)/g;
const COLORISH = /var\(--|#[0-9a-f]{3,8}|rgba?\(/i;

function discover(src: string): Array<{ sel: string; prop: string; decl: string }> {
  const cls = classesOf(modalRanges(src).join('\n'));
  const out: Array<{ sel: string; prop: string; decl: string }> = [];
  for (const { selector, body } of rules(stripComments(styleText(src)))) {
    const sel = selector.replace(/\s+/g, ' ').trim();
    const selClasses = [...sel.matchAll(/\.([\w-]+)/g)].map((m) => m[1]);
    if (!selClasses.length || !selClasses.some((c) => cls.has(c))) continue;
    for (const m of body.matchAll(FG_RE)) {
      const value = m[2].trim().replace(/\s+/g, ' ');
      if (!COLORISH.test(value)) continue;
      out.push({ sel, prop: m[1], decl: value });
    }
  }
  return out;
}

const solidStops = (expr: string, decls: Map<string, string>): RGB[] => {
  const r = resolve(expr, decls);
  return 'stops' in r ? r.stops : [r.solid];
};

/** 层叠面：每条 layer 链按顺序压在每一张模态面上（渐变逐端点展开） */
function surfacesOf(t: ThemeTokens, p: Point): RGB[] {
  const bases = p.scope === 'shared' ? [pageOf(t.decls), ...modalFaces(t)] : modalFaces(t);
  const out: RGB[] = [];
  const walk = (chain: string[], base: RGB) => {
    if (!chain.length) {
      out.push(base);
      return;
    }
    for (const s of solidStops(chain[0], t.decls)) {
      const next = composite(s, base);
      if (chain.length === 1) out.push(next);
      else walk(chain.slice(1), next);
    }
  };
  for (const chain of p.layers) for (const base of bases) walk(chain, base);
  return out;
}

function measure(t: ThemeTokens, p: Point): number {
  let worst = Infinity;
  for (const surface of surfacesOf(t, p)) worst = Math.min(worst, worstRatio(p.fg, 'transparent', t.decls, surface));
  return worst;
}

/* ------------------------------------------------------------------ A 清单 */

describe('T04530 · A 清单落锁（先有清单，再谈数值）', () => {
  it('A1 · 76 条前景声明、10 个文件，逐条 file+selector+property 唯一', () => {
    expect(POINTS.length).toBe(76);
    expect(new Set(POINTS.map((p) => p.f)).size).toBe(10);
    expect(new Set(POINTS.map((p) => `${p.f}::${p.sel}::${p.prop}`)).size).toBe(76);
  });

  it('A2 · 扫描器重新枚举源码 = 账本（新增/删除/改值都会红，不靠人工巡检）', () => {
    const bad: string[] = [];
    for (const f of MODAL_FILES) {
      const got = discover(srcOf(f.split('/').pop() as string));
      const want = POINTS.filter((p) => p.f === f.split('/').pop()).map((p) => ({ sel: p.sel, prop: p.prop, decl: p.decl }));
      const key = (x: { sel: string; prop: string; decl: string }) => `${x.sel}::${x.prop}::${x.decl}`;
      const extra = got.filter((g) => !want.some((w) => key(w) === key(g)));
      const missing = want.filter((w) => !got.some((g) => key(g) === key(w)));
      for (const e of extra) bad.push(`${f} 新出现未登记点：${e.sel} · ${e.prop} = ${e.decl}`);
      for (const m of missing) bad.push(`${f} 账本点已不在源码：${m.sel} · ${m.prop} = ${m.decl}`);
    }
    expect(bad, bad.join('\n')).toEqual([]);
  });

  it('A3 · 每个文件都有条目（AppModal.vue 自身无前景样式，故不在清单内）', () => {
    const counts = Object.fromEntries(MODAL_FILES.map((f) => [f.split('/').pop(), POINTS.filter((p) => p.f === f.split('/').pop()).length]));
    expect(counts).toEqual({
      'CitationModal.vue': 6,
      'ForceChangePassword.vue': 2,
      'About.vue': 5,
      'Config.vue': 11,
      'DataClean.vue': 9,
      'Health.vue': 6,
      'Progress.vue': 9,
      'Query.vue': 12,
      'Tunnel.vue': 3,
      'Users.vue': 13,
    });
    expect(POINTS.filter((p) => p.scope === 'shared').length).toBe(9);
  });
});

/* ------------------------------------------------------------------ B 主锁 */

describe('T04530 · B 主锁：8 个可渲染主题 × 76 点 × 各自落点面取最差', () => {
  it('B1 · 全部达标（文本 4.5 / 控件描边 3.0；decor 不计门槛），任一点跌破即点名主题与选择器', () => {
    const bad: string[] = [];
    for (const t of RENDERED) {
      for (const p of POINTS) {
        const r = measure(t, p);
        if (!(r >= need(p))) bad.push(`${t.name} · ${p.f} ${p.sel} · ${p.prop} = ${Number.isFinite(r) ? r.toFixed(3) : String(r)}（需 ≥ ${need(p)}）`);
      }
    }
    expect(bad, bad.join('\n')).toEqual([]);
  });

  it('B2 · 规模锁：8 主题 × 76 点 = 608 次实算，主题清单逐字固定', () => {
    expect(RENDERED.map((t) => t.name)).toEqual([
      'creative', 'ecommerce', 'enterprise', 'light-business', 'macaron', 'portfolio', 'product', 'dark(tokens.css)',
    ]);
    expect(RENDERED.length * POINTS.length).toBe(608);
  });

  it('B3 · 最差点登记（全站弹窗内受门槛约束的前景最差一档，跌破就会被 B1 抓住）', () => {
    let worst = { label: '', ratio: Infinity };
    for (const t of RENDERED) {
      for (const p of POINTS) {
        if (p.kind === 'decor') continue;
        const r = measure(t, p);
        if (r < worst.ratio) worst = { label: `${t.name} · ${p.f} ${p.sel} · ${p.prop}`, ratio: r };
      }
    }
    expect(worst.label).toBe('product · Query.vue .ib-qr-del:hover · color');
    expect(worst.ratio.toFixed(3)).toBe('4.515');
  });

  it('B4 · 装饰性描边登记：三族容器分隔线的最差读数逐主题可见（不进 AA 门槛，但偷降会被点名）', () => {
    const DECOR = [
      { f: 'CitationModal.vue', sel: '.citation-chunk', prop: 'border' },
      { f: 'Config.vue', sel: '.restart-guide-notice', prop: 'border' },
      { f: 'Config.vue', sel: '.restart-guide-alert', prop: 'border' },
    ];
    const got = DECOR.map((d) => {
      const p = POINTS.find((x) => x.f === d.f && x.sel === d.sel && x.prop === d.prop) as Point;
      expect(p.kind, `${d.f} ${d.sel} 应登记为 decor`).toBe('decor');
      const worst = RENDERED.reduce((min, t) => Math.min(min, measure(t, p)), Infinity);
      return `${d.sel} ${d.prop} = ${worst.toFixed(3)}`;
    });
    expect(got).toEqual([
      '.citation-chunk border = 1.227',
      '.restart-guide-notice border = 1.238',
      '.restart-guide-alert border = 1.472',
    ]);
  });
});

/* ------------------------------------------------------------------ C 面口径前提 */

const BARE_WRAPPERS: Array<{ f: string; sel: string }> = [
  { f: 'CitationModal.vue', sel: '.citation-body' },
  { f: 'CitationModal.vue', sel: '.citation-chunk' },
  { f: 'CitationModal.vue', sel: '.citation-chunk-content' },
  { f: 'Config.vue', sel: '.restart-guide' },
  { f: 'Config.vue', sel: '.path-guide' },
  { f: 'DataClean.vue', sel: '.diff-content' },
  { f: 'Health.vue', sel: '.estimate-body' },
  { f: 'Progress.vue', sel: '.log-list' },
  { f: 'Query.vue', sel: '.ib-settings-body' },
  { f: 'Query.vue', sel: '.video-dialog-body' },
  { f: 'Tunnel.vue', sel: '.wizard-step-content' },
  { f: 'Users.vue', sel: '.modal-form' },
  { f: 'About.vue', sel: '.licenses-list' },
];

describe('T04530 · C 模态面口径前提锁（前提破了，B 腿数字失去意义）', () => {
  it('C1 · 遮罩来源仍是 modal.css 的 --modal-mask（换成 EP 那份说明覆盖被删，B 腿要按新遮罩重定）', () => {
    const { source, expr } = overlayExpr();
    expect(source, `遮罩来源变了，当前表达式：${expr}`).toBe('modal.css');
    expect(/rgba\(4, 2, 12, 0?\.58\)/.exec(expr)?.[0], 'modal.css 的 --modal-mask fallback 变了：面口径要重算').toBeTruthy();
  });

  it('C2 · 对话框容器背景仍取 --bg-card-solid（对话框自身面 = 卡片，遮罩只能透 alpha 渗入）', () => {
    const modal = stripComments(readFileSync(MODAL_CSS, 'utf8'));
    expect(
      /\.app-modal\.el-dialog[^{,]*,[^{]*\{[^}]*background:\s*var\(--bg-card-solid\)/.test(modal),
      'modal.css 的 .app-modal.el-dialog 背景不再取 --bg-card-solid：模态面口径失效',
    ).toBe(true);
  });

  it('C3 · 裸卡片点的容器不得自带背景（自带底就变成「压自声明底」，两张落点全算错）', () => {
    const bad: string[] = [];
    for (const { f, sel } of BARE_WRAPPERS) {
      const bodies = ruleBodies(srcOf(f), sel);
      for (const b of bodies) {
        if (/background/.test(b)) bad.push(`${f} ${sel} 自带了背景：${b.trim().replace(/\s+/g, ' ')}`);
      }
    }
    expect(bad, bad.join('\n')).toEqual([]);
  });

  it('C4 · 登记的自声明面色仍在源码里（面被偷抬/偷降 → 本腿先红）', () => {
    const SURFACE_LOCKS: Array<{ f: string; sel: string; bg: string }> = [
      { f: 'About.vue', sel: '.license-item:hover', bg: 'var(--accent-purple-a08)' },
      { f: 'Config.vue', sel: '.restart-guide-notice', bg: 'var(--warning-accent-soft, rgba(210, 153, 34, 0.1))' },
      { f: 'Config.vue', sel: '.restart-guide-alert', bg: 'rgba(248, 81, 73, 0.08)' },
      { f: 'Config.vue', sel: '.restart-guide-steps', bg: 'var(--bg-scene)' },
      { f: 'DataClean.vue', sel: '.diff-paths', bg: 'var(--bg-scene)' },
      { f: 'DataClean.vue', sel: '.diff-lines', bg: 'var(--bg-void)' },
      { f: 'Health.vue', sel: '.estimate-item', bg: 'var(--accent-purple-a08)' },
      { f: 'Progress.vue', sel: '.log-tool', bg: 'var(--accent-purple-a15, rgba(176, 38, 255, 0.15))' },
      { f: 'Query.vue', sel: '.ib-qr-item', bg: 'var(--accent-cyan-a10, rgba(0, 245, 255, 0.1))' },
      { f: 'Query.vue', sel: '.video-error-tip', bg: 'var(--accent-pink-a10, rgba(255, 100, 150, 0.1))' },
      { f: 'Users.vue', sel: '.neon-btn', bg: 'var(--on-fire-bg)' },
    ];
    const bad: string[] = [];
    for (const { f, sel, bg } of SURFACE_LOCKS) {
      const src = srcOf(f);
      const hit = ruleBodies(src, sel).some((b) => new RegExp(`background(?:-color)?\\s*:\\s*${bg.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}`).test(b.replace(/\s+/g, ' ')));
      if (!hit) bad.push(`${f} ${sel} 的落点面不再是 ${bg}`);
    }
    expect(bad, bad.join('\n')).toEqual([]);
  });

  it('C5 · 自声明面/EP 行面都能解析且不透明（半透明面会把层叠顺序算错）', () => {
    const exprs = [
      'var(--bg-scene)',
      'var(--bg-void)',
      'var(--accent-purple-a08)',
      'var(--accent-cyan-a10, rgba(0, 245, 255, 0.1))',
      'var(--accent-pink-a10, rgba(255, 100, 150, 0.1))',
      'var(--accent-purple-a15, rgba(176, 38, 255, 0.15))',
      'var(--on-fire-bg)',
      'var(--el-fill-color-blank, #ffffff)',
      'var(--el-fill-color-lighter, #fafafa)',
    ];
    const bad: string[] = [];
    for (const t of ALL_THEMES) {
      for (const e of exprs) {
        for (const s of solidStops(e, t.decls)) {
          if (!Number.isFinite(s.r) || !Number.isFinite(s.g) || !Number.isFinite(s.b)) bad.push(`${t.name} ${e} 解析出非有限数`);
          if (e.startsWith('var(--bg-') || e.startsWith('var(--el-') || e.startsWith('var(--on-')) {
            if (s.a !== 1) bad.push(`${t.name} ${e} 解析后 alpha=${s.a}，本锁按不透明面建模`);
          }
        }
      }
    }
    expect(bad, bad.join('\n')).toEqual([]);
  });
});

/* ------------------------------------------------------------------ D 负控制 */

describe('T04530 · D 负控制（必须全绿）', () => {
  it('D1 · 遮罩必须真的进面：遮罩不透明度 > 0.3；半透明卡片两落点精确可分辨；不透明卡片两落点等于卡片', () => {
    const { expr } = overlayExpr();
    for (const t of ALL_THEMES) {
      const faces = modalFaces(t);
      const card = resolve('var(--bg-card-solid)', t.decls);
      expect('stops' in card, `${t.name} 卡片面成了渐变，本锁口径要重定`).toBe(false);
      const c = (card as { solid: RGB }).solid;
      expect(faces).toHaveLength(2);
      if (c.a < 1) {
        expect(faces[0]).not.toEqual(faces[1]);
        for (const f of faces) expect(f).not.toEqual(c);
      } else {
        for (const f of faces) expect(f).toEqual(c);
      }
    }
    // 主题覆盖（浅色减淡）与 :root fallback 都不能把遮罩压到看不见
    for (const t of ALL_THEMES) {
      const decls = new Map(t.decls);
      const overlay = resolve(expr, decls);
      if ('stops' in overlay) continue;
      expect(overlay.solid.a, `${t.name} 遮罩几乎透明（alpha=${overlay.solid.a}）：两张落点失去区分度`).toBeGreaterThan(0.3);
    }
  });

  it('D2 · 608 次实算全部是 [1, 21] 内的有限数（解析器坏了不会静默全绿）', () => {
    let n = 0;
    for (const t of RENDERED) {
      for (const p of POINTS) {
        const r = measure(t, p);
        expect(Number.isFinite(r) && r >= 1 && r <= 21, `${t.name} ${p.f} ${p.sel} 比值异常：${r}`).toBe(true);
        n++;
      }
    }
    expect(n).toBe(608);
  });

  it('D3 · 接错对象自证：把落点面当前景喂回去，比值必然塌到 1 附近（product 是深底，用白字做对照）', () => {
    const t = ALL_THEMES.find((x) => x.name === 'product') as ThemeTokens;
    const p = POINTS.find((x) => x.sel === '.citation-chunk-head') as Point;
    const face = surfacesOf(t, p)[0];
    const r = worstRatio('rgb(255, 255, 255)', 'transparent', t.decls, face); // 对照：白字不会被误判成面
    const swapped = worstRatio(`rgba(${Math.round(face.r)}, ${Math.round(face.g)}, ${Math.round(face.b)}, 1)`, 'transparent', t.decls, face);
    expect(r).toBeGreaterThan(3);
    expect(swapped).toBeLessThan(1.5);
  });

  it('D4 · 恒绿负控制：注入注释/空白不改变扫描结果（扫描器盯声明，不盯格式）', () => {
    const src = srcOf('CitationModal.vue');
    const noisy = src.replace('<style scoped>', '<style scoped>\n/* T04530 负控制：这行注释不应改变枚举 */\n');
    expect(discover(noisy)).toEqual(discover(src));
  });
});
