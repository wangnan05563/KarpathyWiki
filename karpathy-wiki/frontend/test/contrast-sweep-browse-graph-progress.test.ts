// T04449 口径推广·第四组：浏览页（Browse.vue）+ 进度页（Progress.vue）+ 图谱页（Graph.vue）。
// 与前三组同一缺陷族：为深色霓虹底设计的强调色基名被直接写进 color / border(-color) / outline，
// 在浅底主题的白卡片与淡 tint 面上跌破 WCAG AA。本组覆盖 117 处「基色当前景」消费点
// （浏览 50 / 进度 31 / 图谱 36）。
//
// 本组顺带暴露并修掉的口径层缺陷：`--purple-readable` 压在 `--accent-purple-a12/a15` tint 面上只有
// 4.34~4.37（6 个主题全中，含深色母主题 default/creative/product），portfolio 的 `--accent-readable`
// 压在紫 tint 面上 4.49——即 T04448 与前两版推广只按**卡片面**校准过这两族，tint 面不在样本里。
// 故本组把两族 readable 二次收紧（浅底压暗 / 深底提亮），并给 product 新建 `--purple-readable` 覆盖。
//
// 口径边界：装饰性 `var(--accent-*-aNN)` 描边按基线冻结（浏览 36 / 进度 17 / 图谱 31），
// 改它需要 T04468 的设计裁决；Graph.vue <script> 里画布取色是硬编码 hex（1 个：#b026ff），
// 落点是 canvas 底色而非主题卡片面，属另一口径，本组不动（由 T04469 跟踪）。
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

const FILES = ['src/views/Browse.vue', 'src/views/Progress.vue', 'src/views/Graph.vue'];
const PAGE: Record<string, string> = { 'src/views/Browse.vue': '浏览页', 'src/views/Progress.vue': '进度页', 'src/views/Graph.vue': '图谱页' };
/** 基色 token（不含 -aNN tint 与 -base 派生）：这些裸写进前景即本口径要抓 */
const BASE_TOKENS = [
  /^--neon-cyan$/,
  /^--neon-pink$/,
  /^--accent-pink$/,
  /^--neon-magenta$/,
  /^--neon-purple$/,
  /^--accent-purple$/,
];
const CARD = 'var(--bg-card-solid)';

/** 逐面清单：fg=接入后的 readable token，bg=该声明所在规则的真实落点面 */
const AUDIT: AuditRow[] = [
  { label: '浏览页· .head-collapse-btn:hover [color·accent]', fg: 'var(--accent-readable)', bg: 'var(--accent-purple-a15)', kind: 'text' },
  { label: '浏览页· .head-collapse-btn:focus-visible [outline·accent]', fg: 'var(--accent-readable)', bg: 'var(--bg-card-solid)', kind: 'ui' },
  { label: '浏览页·.head-expand-float:hover [color·accent]', fg: 'var(--accent-readable)', bg: 'var(--bg-card-solid)', kind: 'text' },
  { label: '浏览页· .head-expand-float:focus-visible [outline·accent]', fg: 'var(--accent-readable)', bg: 'var(--bg-card-solid)', kind: 'ui' },
  { label: '浏览页·.head-tag [color·accent]', fg: 'var(--accent-readable)', bg: 'var(--bg-card-solid)', kind: 'text' },
  { label: '浏览页·.tree-collapse-btn:hover [color·accent]', fg: 'var(--accent-readable)', bg: 'var(--accent-purple-a12)', kind: 'text' },
  { label: '浏览页·.tree-expand-btn:hover [color·accent]', fg: 'var(--accent-readable)', bg: 'var(--bg-card-solid)', kind: 'text' },
  { label: '浏览页·.filter-more-btn:hover [color·accent]', fg: 'var(--accent-readable)', bg: 'var(--accent-purple-a12)', kind: 'text' },
  { label: '浏览页· .filter-more-btn.is-active [color·accent]', fg: 'var(--accent-readable)', bg: 'var(--accent-purple-a12)', kind: 'text' },
  { label: '浏览页·.filter-chip-value [color·accent]', fg: 'var(--accent-readable)', bg: 'var(--bg-card-solid)', kind: 'text' },
  { label: '浏览页·.filter-chip-clear:hover [color·accent]', fg: 'var(--accent-readable)', bg: 'var(--accent-purple-a15)', kind: 'text' },
  { label: '浏览页·.filter-chip-clear-all:hover [color·accent]', fg: 'var(--accent-readable)', bg: 'var(--bg-card-solid)', kind: 'text' },
  { label: '浏览页·.kanban-icon [color·pink]', fg: 'var(--pink-readable)', bg: 'var(--bg-card-solid)', kind: 'text' },
  { label: '浏览页·.kanban-card.active [border-color·pink]', fg: 'var(--pink-readable)', bg: 'var(--accent-pink-a10)', kind: 'ui' },
  { label: '浏览页·.date-icon [color·accent]', fg: 'var(--accent-readable)', bg: 'var(--bg-card-solid)', kind: 'text' },
  { label: '浏览页·.calendar-card.active [border-color·accent]', fg: 'var(--accent-readable)', bg: 'var(--accent-cyan-a10)', kind: 'ui' },
  { label: '浏览页·.search-mode.keyword-only [color·pink]', fg: 'var(--pink-readable)', bg: 'var(--bg-card-solid)', kind: 'text' },
  { label: '浏览页·.search-count [color·accent]', fg: 'var(--accent-readable)', bg: 'var(--bg-card-solid)', kind: 'text' },
  { label: '浏览页·.search-hit-item:hover [border-color·purple]', fg: 'var(--purple-readable)', bg: 'var(--accent-purple-a12)', kind: 'ui' },
  { label: '浏览页·.hit-source-badge.semantic [color·purple]', fg: 'var(--purple-readable)', bg: 'var(--bg-card-solid)', kind: 'text' },
  { label: '浏览页·.hit-source-badge.both [color·accent]', fg: 'var(--accent-readable)', bg: 'var(--bg-card-solid)', kind: 'text' },
  { label: '浏览页·.hit-path [color·accent]', fg: 'var(--accent-readable)', bg: 'var(--bg-card-solid)', kind: 'text' },
  { label: '浏览页·.file-icon [color·accent]', fg: 'var(--accent-readable)', bg: 'var(--bg-card-solid)', kind: 'text' },
  { label: '浏览页·.locate-btn:hover [color·accent]', fg: 'var(--accent-readable)', bg: 'var(--accent-cyan-a12)', kind: 'text' },
  { label: '浏览页· .locate-btn.active [color·accent]', fg: 'var(--accent-readable)', bg: 'var(--accent-cyan-a20)', kind: 'text' },
  { label: '浏览页·.fm-chip strong [color·pink]', fg: 'var(--pink-readable)', bg: 'var(--bg-card-solid)', kind: 'text' },
  { label: '浏览页·.doc-summary-bar .fm-chip strong [color·pink]', fg: 'var(--pink-readable)', bg: 'var(--bg-card-solid)', kind: 'text' },
  { label: '浏览页·.markdown-body :deep(h1) [border-bottom·pink]', fg: 'var(--pink-readable)', bg: 'var(--bg-card-solid)', kind: 'ui' },
  { label: '浏览页·.markdown-body :deep(h2) [color·accent]', fg: 'var(--accent-readable)', bg: 'var(--bg-card-solid)', kind: 'text' },
  { label: '浏览页·.markdown-body :deep(h3) [color·purple]', fg: 'var(--purple-readable)', bg: 'var(--bg-card-solid)', kind: 'text' },
  { label: '浏览页·.markdown-body :deep(code) [color·purple]', fg: 'var(--purple-readable)', bg: 'var(--accent-purple-a15)', kind: 'text' },
  { label: '浏览页·.markdown-body :deep(pre code) [color·accent]', fg: 'var(--accent-readable)', bg: 'var(--bg-card-solid)', kind: 'text' },
  { label: '浏览页·.markdown-body :deep(.wikilink) [color·pink]', fg: 'var(--pink-readable)', bg: 'var(--accent-pink-a10)', kind: 'text' },
  { label: '浏览页·.draft-count [color·accent]', fg: 'var(--accent-readable)', bg: 'var(--bg-card-solid)', kind: 'text' },
  { label: '浏览页·.draft-item:hover [border-color·purple]', fg: 'var(--purple-readable)', bg: 'var(--accent-purple-a12)', kind: 'ui' },
  { label: '浏览页·.draft-item.active [border-color·accent]', fg: 'var(--accent-readable)', bg: 'var(--accent-cyan-a10)', kind: 'ui' },
  { label: '浏览页·.draft-path [color·accent]', fg: 'var(--accent-readable)', bg: 'var(--bg-card-solid)', kind: 'text' },
  { label: '浏览页·.stat-success [color·accent]', fg: 'var(--accent-readable)', bg: 'var(--bg-card-solid)', kind: 'text' },
  { label: '浏览页·.stat-error [color·pink]', fg: 'var(--pink-readable)', bg: 'var(--bg-card-solid)', kind: 'text' },
  { label: '浏览页·.batch-row.status-done [color·accent]', fg: 'var(--accent-readable)', bg: 'var(--bg-card-solid)', kind: 'text' },
  { label: '浏览页·.batch-row.status-error [color·pink]', fg: 'var(--pink-readable)', bg: 'var(--bg-card-solid)', kind: 'text' },
  { label: '浏览页·.batch-row.status-running [color·purple]', fg: 'var(--purple-readable)', bg: 'var(--bg-card-solid)', kind: 'text' },
  { label: '浏览页·.batch-pages [color·accent]', fg: 'var(--accent-readable)', bg: 'var(--bg-card-solid)', kind: 'text' },
  { label: '浏览页· .tag-count-badge [color·accent]', fg: 'var(--accent-readable)', bg: 'var(--accent-cyan-a10)', kind: 'text' },
  { label: '浏览页· .tag-add-icon [color·accent]', fg: 'var(--accent-readable)', bg: 'var(--bg-card-solid)', kind: 'text' },
  { label: '浏览页·.fullscreen-overlay .markdown-body h1 [border-bottom·pink]', fg: 'var(--pink-readable)', bg: 'var(--bg-scene)', kind: 'ui' },
  { label: '浏览页·.fullscreen-overlay .markdown-body h2 [color·accent]', fg: 'var(--accent-readable)', bg: 'var(--bg-scene)', kind: 'text' },
  { label: '浏览页·.fullscreen-overlay .markdown-body h3 [color·purple]', fg: 'var(--purple-readable)', bg: 'var(--bg-scene)', kind: 'text' },
  { label: '浏览页·.fullscreen-overlay .markdown-body code [color·purple]', fg: 'var(--purple-readable)', bg: 'var(--accent-purple-a15)', kind: 'text' },
  { label: '浏览页·.fullscreen-overlay .markdown-body pre code [color·accent]', fg: 'var(--accent-readable)', bg: 'var(--bg-scene)', kind: 'text' },
  { label: '进度页·.head-tag [color·accent]', fg: 'var(--accent-readable)', bg: 'var(--bg-card-solid)', kind: 'text' },
  { label: '进度页·.head-model code [color·accent]', fg: 'var(--accent-readable)', bg: 'var(--bg-card-solid)', kind: 'text' },
  { label: '进度页·.tl-status.done [color·accent]', fg: 'var(--accent-readable)', bg: 'var(--accent-cyan-a15, rgba(0, 245, 255, 0.15))', kind: 'text' },
  { label: '进度页·.tl-status.error [color·pink]', fg: 'var(--pink-readable)', bg: 'var(--accent-pink-a15, rgba(255, 0, 110, 0.15))', kind: 'text' },
  { label: '进度页·.tl-status.running [color·pink]', fg: 'var(--pink-readable)', bg: 'var(--accent-pink-a15, rgba(255, 62, 201, 0.15))', kind: 'text' },
  { label: '进度页·.page-icon [color·accent]', fg: 'var(--accent-readable)', bg: 'var(--bg-card-solid)', kind: 'text' },
  { label: '进度页·.tl-page code [color·purple]', fg: 'var(--purple-readable)', bg: 'var(--accent-purple-a15, rgba(176, 38, 255, 0.15))', kind: 'text' },
  { label: '进度页·.result-title [color·accent]', fg: 'var(--accent-readable)', bg: 'var(--bg-card-solid)', kind: 'text' },
  { label: '进度页·.result-list code [color·purple]', fg: 'var(--purple-readable)', bg: 'var(--accent-purple-a15, rgba(176, 38, 255, 0.15))', kind: 'text' },
  { label: '进度页·.result-meta strong [color·pink]', fg: 'var(--pink-readable)', bg: 'var(--bg-card-solid)', kind: 'text' },
  { label: '进度页·.current-model-bar code [color·accent]', fg: 'var(--accent-readable)', bg: 'var(--accent-cyan-a08, rgba(0, 245, 255, 0.08))', kind: 'text' },
  { label: '进度页· .cache-hit-banner [color·accent]', fg: 'var(--accent-readable)', bg: 'var(--accent-cyan-a08, rgba(0, 245, 255, 0.08))', kind: 'text' },
  { label: '进度页·.title-bracket [color·pink]', fg: 'var(--pink-readable)', bg: 'var(--bg-card-solid)', kind: 'text' },
  { label: '进度页·.run-item:hover [border-color·purple]', fg: 'var(--purple-readable)', bg: 'var(--accent-purple-a12, rgba(176, 38, 255, 0.12))', kind: 'ui' },
  { label: '进度页·.run-id [color·accent]', fg: 'var(--accent-readable)', bg: 'var(--bg-card-solid)', kind: 'text' },
  { label: '进度页·.log-line.error [color·pink]', fg: 'var(--pink-readable)', bg: 'var(--bg-card-solid)', kind: 'text' },
  { label: '进度页·.log-line.done [color·accent]', fg: 'var(--accent-readable)', bg: 'var(--bg-card-solid)', kind: 'text' },
  { label: '进度页·.log-step [color·purple]', fg: 'var(--purple-readable)', bg: 'var(--bg-card-solid)', kind: 'text' },
  { label: '进度页·.log-tool [color·purple]', fg: 'var(--purple-readable)', bg: 'var(--accent-purple-a15, rgba(176, 38, 255, 0.15))', kind: 'text' },
  { label: '进度页·.log-err [color·pink]', fg: 'var(--pink-readable)', bg: 'var(--bg-card-solid)', kind: 'text' },
  { label: '进度页·.rejected-title [color·pink]', fg: 'var(--pink-readable)', bg: 'var(--bg-card-solid)', kind: 'text' },
  { label: '进度页·.rejected-item code [color·purple]', fg: 'var(--purple-readable)', bg: 'var(--accent-purple-a12, rgba(176, 38, 255, 0.12))', kind: 'text' },
  { label: '进度页·.batch-group.running [border-color·pink]', fg: 'var(--pink-readable)', bg: 'var(--bg-card-solid)', kind: 'ui' },
  { label: '进度页·.batch-group-idx [color·accent]', fg: 'var(--accent-readable)', bg: 'var(--bg-card-solid)', kind: 'text' },
  { label: '进度页·.batch-group-status.running [color·pink]', fg: 'var(--pink-readable)', bg: 'var(--accent-pink-a15, rgba(255, 62, 201, 0.15))', kind: 'text' },
  { label: '进度页·.batch-group-status.done [color·accent]', fg: 'var(--accent-readable)', bg: 'var(--accent-cyan-a15, rgba(0, 245, 255, 0.15))', kind: 'text' },
  { label: '进度页·.batch-group-status.error [color·pink]', fg: 'var(--pink-readable)', bg: 'var(--accent-pink-a15, rgba(255, 0, 110, 0.15))', kind: 'text' },
  { label: '进度页·.batch-tl-step [color·purple]', fg: 'var(--purple-readable)', bg: 'var(--bg-card-solid)', kind: 'text' },
  { label: '进度页·.batch-tl-page [color·accent]', fg: 'var(--accent-readable)', bg: 'var(--accent-cyan-a10, rgba(0, 245, 255, 0.1))', kind: 'text' },
  { label: '进度页·.batch-group-error [color·pink]', fg: 'var(--pink-readable)', bg: 'var(--accent-pink-a08, rgba(255, 0, 110, 0.08))', kind: 'text' },
  { label: '进度页·.batch-page-code [color·accent]', fg: 'var(--accent-readable)', bg: 'var(--accent-cyan-a08, rgba(0, 245, 255, 0.08))', kind: 'text' },
  { label: '图谱页·.head-tag [color·accent]', fg: 'var(--accent-readable)', bg: 'var(--bg-card-solid)', kind: 'text' },
  { label: '图谱页·.neon-btn:hover [border-color·accent]', fg: 'var(--accent-readable)', bg: 'var(--bg-card-solid)', kind: 'ui' },
  { label: '图谱页·.neon-btn:hover [color·accent]', fg: 'var(--accent-readable)', bg: 'var(--bg-card-solid)', kind: 'text' },
  { label: '图谱页·.loading-text [color·accent]', fg: 'var(--accent-readable)', bg: 'var(--bg-card-solid)', kind: 'text' },
  { label: '图谱页·.group-count [color·accent]', fg: 'var(--accent-readable)', bg: 'var(--accent-cyan-a10)', kind: 'text' },
  { label: '图谱页·.page-links [color·accent]', fg: 'var(--accent-readable)', bg: 'var(--bg-card-solid)', kind: 'text' },
  { label: '图谱页·.ctx-item:hover [color·accent]', fg: 'var(--accent-readable)', bg: 'var(--accent-purple-a15)', kind: 'text' },
  { label: '图谱页·.ctx-item.ctx-close:hover [color·pink]', fg: 'var(--pink-readable)', bg: 'var(--bg-card-solid)', kind: 'text' },
  { label: '图谱页·.recommend-icon [color·accent]', fg: 'var(--accent-readable)', bg: 'var(--bg-card-solid)', kind: 'text' },
  { label: '图谱页·.recommend-close:hover [border-color·pink]', fg: 'var(--pink-readable)', bg: 'var(--bg-card-solid)', kind: 'ui' },
  { label: '图谱页·.recommend-close:hover [color·pink]', fg: 'var(--pink-readable)', bg: 'var(--bg-card-solid)', kind: 'text' },
  { label: '图谱页·.source-path [color·accent]', fg: 'var(--accent-readable)', bg: 'var(--accent-cyan-a10)', kind: 'text' },
  { label: '图谱页·.recommend-card:hover [border-color·accent]', fg: 'var(--accent-readable)', bg: 'var(--bg-card-solid)', kind: 'ui' },
  { label: '图谱页·.rec-score [color·accent]', fg: 'var(--accent-readable)', bg: 'var(--accent-cyan-a10)', kind: 'text' },
  { label: '图谱页· .gap-active [border-color·accent]', fg: 'var(--accent-readable)', bg: 'var(--bg-card-solid)', kind: 'ui' },
  { label: '图谱页· .gap-active [color·accent]', fg: 'var(--accent-readable)', bg: 'var(--bg-card-solid)', kind: 'text' },
  { label: '图谱页· .entity-active [border-color·pink]', fg: 'var(--pink-readable)', bg: 'var(--bg-card-solid)', kind: 'ui' },
  { label: '图谱页· .entity-active [color·pink]', fg: 'var(--pink-readable)', bg: 'var(--bg-card-solid)', kind: 'text' },
  { label: '图谱页· .all-active [border-color·accent]', fg: 'var(--accent-readable)', bg: 'var(--bg-card-solid)', kind: 'ui' },
  { label: '图谱页· .all-active [color·accent]', fg: 'var(--accent-readable)', bg: 'var(--bg-card-solid)', kind: 'text' },
  { label: '图谱页·.graph-hint b [color·accent]', fg: 'var(--accent-readable)', bg: 'var(--bg-card-solid)', kind: 'text' },
  { label: '图谱页·.gap-title-icon [color·pink]', fg: 'var(--pink-readable)', bg: 'var(--bg-card-solid)', kind: 'text' },
  { label: '图谱页·.gap-close:hover [border-color·pink]', fg: 'var(--pink-readable)', bg: 'var(--bg-card-solid)', kind: 'ui' },
  { label: '图谱页·.gap-close:hover [color·pink]', fg: 'var(--pink-readable)', bg: 'var(--bg-card-solid)', kind: 'text' },
  { label: '图谱页·.gap-count [color·accent]', fg: 'var(--accent-readable)', bg: 'var(--accent-cyan-a10)', kind: 'text' },
  { label: '图谱页·.gap-chip:hover [border-color·pink]', fg: 'var(--pink-readable)', bg: 'var(--bg-card-solid)', kind: 'ui' },
  { label: '图谱页·.gap-chip:hover [color·pink]', fg: 'var(--pink-readable)', bg: 'var(--bg-card-solid)', kind: 'text' },
  { label: '图谱页·.gap-card-meta [color·accent]', fg: 'var(--accent-readable)', bg: 'var(--bg-card-solid)', kind: 'text' },
  { label: '图谱页·.gap-tag:hover [color·accent]', fg: 'var(--accent-readable)', bg: 'var(--bg-card-solid)', kind: 'text' },
  { label: '图谱页·.gap-tag:hover [border-color·accent]', fg: 'var(--accent-readable)', bg: 'var(--bg-card-solid)', kind: 'ui' },
  { label: '图谱页·.gap-pair-tags [color·accent]', fg: 'var(--accent-readable)', bg: 'var(--accent-cyan-a10)', kind: 'text' },
  { label: '图谱页·.seg-control button:hover:not(.active) [color·accent]', fg: 'var(--accent-readable)', bg: 'var(--bg-card-solid)', kind: 'text' },
  { label: '图谱页·.tour-icon [color·accent]', fg: 'var(--accent-readable)', bg: 'var(--bg-card-solid)', kind: 'text' },
  { label: '图谱页·.tour-text b [color·accent]', fg: 'var(--accent-readable)', bg: 'var(--bg-card-solid)', kind: 'text' },
  { label: '图谱页·.tour-close:hover [border-color·accent]', fg: 'var(--accent-readable)', bg: 'var(--bg-card-solid)', kind: 'ui' },
  { label: '图谱页·.tour-close:hover [color·accent]', fg: 'var(--accent-readable)', bg: 'var(--bg-card-solid)', kind: 'text' },
];

const EXPECTED: Record<string, { n: number; readable: number; fam: Record<string, number>; tint: number }> = {
  'src/views/Browse.vue': { n: 50, readable: 50, fam: { accent: 32, pink: 10, purple: 8 }, tint: 36 },
  'src/views/Progress.vue': { n: 31, readable: 31, fam: { accent: 13, pink: 11, purple: 7 }, tint: 17 },
  'src/views/Graph.vue': { n: 36, readable: 36, fam: { accent: 26, pink: 10 }, tint: 31 },
};

/**
 * 只统计本清单覆盖的三族（accent / pink / purple）。
 * T04513 起 Graph.vue 另有 --graph-*-readable 一族（画布配对档，由 test/contrast-graph-canvas.test.ts
 * 独立审计）。把它一并计入会让「消费点数 == 清单行数」失去意义：那 42 处消费点不在本 AUDIT 清单里，
 * 对齐断言就会从「清单与代码互相钉住」退化成「只要数字相等就行」。
 */
const readableRefCount = (src: string) => (src.match(/--(?:accent|pink|purple)-readable/g) || []).length;
const famCount = (src: string, fam: string) => (src.match(new RegExp(`--${fam}-readable`, 'g')) || []).length;
const rowsOf = (f: string) => AUDIT.filter((r) => r.label.startsWith(PAGE[f] + '·'));

describe('T04449 推广第四组：逐主题达标', () => {
  it(`8 主题 × ${AUDIT.length} 面全部达 AA（文本 4.5 / 非文本 3.0）`, () => {
    const failures = auditThemes(AUDIT, loadThemes());
    expect(failures, formatFailures(failures)).toEqual([]);
  });

  it('清单规模与三页实现严格对齐（防止清单与代码脱钩空转）', () => {
    expect(AUDIT.length).toBe(117);
    for (const f of FILES) {
      const src = readFileSync(join(ROOT, f), 'utf8');
      const exp = EXPECTED[f];
      expect(rowsOf(f).length, `${f} 清单行数与总清单不一致`).toBe(exp.n);
      expect(readableRefCount(src), `${f} 的 readable 消费点数与清单不一致`).toBe(exp.readable);
    }
  });

  it('逐族消费点数与审计清单一致（接错家族会被点名）', () => {
    for (const f of FILES) {
      const src = readFileSync(join(ROOT, f), 'utf8');
      for (const [fam, n] of Object.entries(EXPECTED[f].fam)) {
        expect(famCount(src, fam), `${f} · --${fam}-readable 应有 ${n} 处`).toBe(n);
      }
    }
  });

  it('包裹表达式括号平衡（防止接入器吃掉右括号）', () => {
    for (const f of FILES) {
      const bad = readFileSync(join(ROOT, f), 'utf8')
        .split(/\r?\n/)
        .filter((l) => /-readable/.test(l) && (l.match(/\(/g) || []).length !== (l.match(/\)/g) || []).length);
      expect(bad, `${f} 有 ${bad.length} 行括号不平衡：${bad.slice(0, 3).join(' | ')}`).toEqual([]);
    }
  });
});

describe('T04449 推广第四组：口径守护（基色不得再裸写进前景）', () => {
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

describe('T04449 推广第四组：token 层二次收紧（tint 面校准）', () => {
  it('紫/青 readable 压 tint 面不再靠卡片面蒙过', () => {
    const rows2: AuditRow[] = [
      { label: '紫族文字压紫 tint 面', fg: 'var(--purple-readable)', bg: 'var(--accent-purple-a15)', kind: 'text' },
      { label: '紫族文字压更淡紫 tint 面', fg: 'var(--purple-readable)', bg: 'var(--accent-purple-a12)', kind: 'text' },
      { label: '青族文字压紫 tint 面', fg: 'var(--accent-readable)', bg: 'var(--accent-purple-a15)', kind: 'text' },
    ];
    const failures = auditThemes(rows2, loadThemes());
    expect(failures, formatFailures(failures)).toEqual([]);
  });

  it('卡片面仍达标（收紧不能把前两组的落点改坏）', () => {
    const rows3: AuditRow[] = [
      { label: '紫族文字压卡片', fg: 'var(--purple-readable)', bg: CARD, kind: 'text' },
      { label: '青族文字压卡片', fg: 'var(--accent-readable)', bg: CARD, kind: 'text' },
    ];
    const failures = auditThemes(rows3, loadThemes());
    expect(failures, formatFailures(failures)).toEqual([]);
  });
});
