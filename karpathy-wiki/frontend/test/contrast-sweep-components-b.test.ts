// T04470 批次 B：问答与进度相关 13 个组件 74 处裸基色前景接入（组件层首组）
//
// 与前五批视图层的三点差别，本文件的结论全部建立在它们之上：
//  1) 组件是**共享**的，多数规则自身不声明底色 → 落点面沿用首组公共组件口径取卡片实底 CARD；
//     块内自声明 tint 的按 tint 叠页底（worstRatio 自带合成）。
//  2) 两个进度条的 10 个「状态点」不是文本前景：`<span class="progress-status-dot">` 是空元素，
//     规则里的 `color` 只喂 `box-shadow: 0 0 8px currentColor`（CSS 注释原文即这么写）。
//     包成 readable 会让光晕与填充异色——既没修任何可读性问题，又改坏观感。
//     本批做法：把光晕色显式化为 --dot-glow，填充与光晕仍逐条同 token，裸基色前景声明归零。
//  3) SessionStatusIcon 三条前景写成 `var(--m-primary, var(--neon-cyan, ...))`：外层 --m-* 只在
//     mobile-light 皮肤定义（那里 --neon-* 本身已被重映射），桌面取不到才落到基色。
//     所以 readable 必须插在**内层**，外层移动端皮肤优先级不许动（那属 T04467 口径）。
//
// 处数口径与 test/contrast-sweep-index.test.ts 的 BASELINE 一致：64 处包裹 + 10 处状态点 = 74 处。
import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { ROOT, THRESHOLD, loadThemes, worstRatio, pageOf, listBareBaseForegroundUses, type AuditFailure } from './helpers/contrast';

const THEMES = loadThemes();
const CARD = 'var(--bg-card-solid)';

interface Point {
  f: string;
  ln: number;
  sel: string;
  /** 落点面：CARD = 规则自身无底，按首组公共组件口径取卡片实底；其余为块内自声明 tint */
  face: string;
  fg: string;
  bare: string;
  kind: 'text' | 'ui';
}

/** 本批 64 个可包裹消费点（状态点另计，见文件头第 2 条）；选族结论来自 tmp-b-matrix 逐主题实算 */
const POINTS: Point[] = [
  { f: 'BatchProgressBar.vue', ln: 405, sel: '.progress-percentage', face: CARD, fg: 'var(--accent-readable)', bare: 'var(--neon-cyan)', kind: 'text' },
  { f: 'BatchProgressBar.vue', ln: 450, sel: '.awaiting-spinner border-top', face: CARD, fg: 'var(--pink-readable)', bare: 'var(--neon-pink)', kind: 'ui' },
  { f: 'BatchProgressBar.vue', ln: 458, sel: '.awaiting-elapsed', face: CARD, fg: 'var(--pink-readable)', bare: 'var(--neon-pink)', kind: 'text' },
  { f: 'BatchProgressBar.vue', ln: 488, sel: '.success-banner', face: 'var(--accent-cyan-a08)', fg: 'var(--accent-readable)', bare: 'var(--neon-cyan)', kind: 'text' },
  { f: 'BatchProgressBar.vue', ln: 497, sel: '.error-banner', face: 'var(--accent-pink-a08)', fg: 'var(--pink-readable)', bare: 'var(--neon-magenta)', kind: 'text' },
  { f: 'BatchProgressBar.vue', ln: 506, sel: '.cancelled-banner', face: 'var(--accent-pink-a08)', fg: 'var(--pink-readable)', bare: 'var(--neon-pink)', kind: 'text' },
  { f: 'SingleFileProgressBar.vue', ln: 349, sel: '.progress-percentage', face: CARD, fg: 'var(--accent-readable)', bare: 'var(--neon-cyan)', kind: 'text' },
  { f: 'SingleFileProgressBar.vue', ln: 417, sel: '.success-banner', face: 'var(--accent-cyan-a08)', fg: 'var(--accent-readable)', bare: 'var(--neon-cyan)', kind: 'text' },
  { f: 'SingleFileProgressBar.vue', ln: 426, sel: '.error-banner', face: 'var(--accent-pink-a08)', fg: 'var(--pink-readable)', bare: 'var(--neon-magenta)', kind: 'text' },
  { f: 'SingleFileProgressBar.vue', ln: 435, sel: '.cancelled-banner', face: 'var(--accent-pink-a08)', fg: 'var(--pink-readable)', bare: 'var(--neon-pink)', kind: 'text' },
  { f: 'SingleFileProgressBar.vue', ln: 531, sel: '.stage-duration', face: CARD, fg: 'var(--accent-readable)', bare: 'var(--neon-cyan)', kind: 'text' },
  { f: 'MarkdownRenderer.vue', ln: 81, sel: 'h4/h5/h6', face: CARD, fg: 'var(--accent-readable)', bare: 'var(--neon-cyan)', kind: 'text' },
  { f: 'MarkdownRenderer.vue', ln: 124, sel: 'code', face: 'var(--accent-cyan-a10)', fg: 'var(--accent-readable)', bare: 'var(--neon-cyan)', kind: 'text' },
  { f: 'MarkdownRenderer.vue', ln: 153, sel: 'blockquote border-left', face: 'var(--accent-purple-a06)', fg: 'var(--purple-readable)', bare: 'var(--neon-purple)', kind: 'ui' },
  { f: 'MarkdownRenderer.vue', ln: 184, sel: 'th', face: 'var(--accent-cyan-a08)', fg: 'var(--accent-readable)', bare: 'var(--neon-cyan)', kind: 'text' },
  { f: 'MarkdownRenderer.vue', ln: 193, sel: 'a', face: CARD, fg: 'var(--accent-readable)', bare: 'var(--neon-cyan)', kind: 'text' },
  { f: 'MarkdownRenderer.vue', ln: 200, sel: 'a:hover color', face: CARD, fg: 'var(--purple-readable)', bare: 'var(--neon-purple)', kind: 'text' },
  { f: 'MarkdownRenderer.vue', ln: 201, sel: 'a:hover border-bottom', face: CARD, fg: 'var(--purple-readable)', bare: 'var(--neon-purple)', kind: 'ui' },
  { f: 'MarkdownRenderer.vue', ln: 228, sel: 'strong', face: CARD, fg: 'var(--accent-readable)', bare: 'var(--neon-cyan)', kind: 'text' },
  { f: 'MarkdownRenderer.vue', ln: 233, sel: 'em', face: CARD, fg: 'var(--purple-readable)', bare: 'var(--neon-purple)', kind: 'text' },
  { f: 'RefsList.vue', ln: 157, sel: '.refs-list border-left', face: 'var(--accent-cyan-a04)', fg: 'var(--accent-readable)', bare: 'var(--neon-cyan)', kind: 'ui' },
  { f: 'RefsList.vue', ln: 192, sel: '.source-stat.vault', face: 'var(--accent-cyan-a15)', fg: 'var(--accent-readable)', bare: 'var(--neon-cyan)', kind: 'text' },
  { f: 'RefsList.vue', ln: 218, sel: '.ref-item.vault border-left', face: CARD, fg: 'var(--accent-readable)', bare: 'var(--neon-cyan)', kind: 'ui' },
  { f: 'RefsList.vue', ln: 257, sel: '.source-badge.vault', face: 'var(--accent-cyan-a18)', fg: 'var(--accent-readable)', bare: 'var(--neon-cyan)', kind: 'text' },
  { f: 'RefsList.vue', ln: 280, sel: '.sig.on', face: CARD, fg: 'var(--accent-readable)', bare: 'var(--neon-cyan)', kind: 'text' },
  { f: 'RefsList.vue', ln: 327, sel: '.show-more-btn:hover border', face: 'var(--accent-cyan-a06)', fg: 'var(--accent-readable)', bare: 'var(--neon-cyan)', kind: 'ui' },
  { f: 'RefsList.vue', ln: 328, sel: '.show-more-btn:hover color', face: 'var(--accent-cyan-a06)', fg: 'var(--accent-readable)', bare: 'var(--neon-cyan)', kind: 'text' },
  { f: 'HealthIssueList.vue', ln: 255, sel: '.issue-item code', face: 'var(--accent-cyan-a10)', fg: 'var(--accent-readable)', bare: 'var(--neon-cyan)', kind: 'text' },
  { f: 'HealthIssueList.vue', ln: 264, sel: '.broken-target', face: 'var(--accent-pink-a10)', fg: 'var(--pink-readable)', bare: 'var(--neon-magenta)', kind: 'text' },
  { f: 'HealthIssueList.vue', ln: 314, sel: '.neon-btn:hover border', face: CARD, fg: 'var(--accent-readable)', bare: 'var(--neon-cyan)', kind: 'ui' },
  { f: 'HealthIssueList.vue', ln: 316, sel: '.neon-btn:hover color', face: CARD, fg: 'var(--accent-readable)', bare: 'var(--neon-cyan)', kind: 'text' },
  { f: 'HealthIssueList.vue', ln: 340, sel: '.row-badge.done', face: CARD, fg: 'var(--accent-readable)', bare: 'var(--neon-cyan)', kind: 'text' },
  { f: 'HealthIssueList.vue', ln: 350, sel: '.row-badge.failed', face: CARD, fg: 'var(--pink-readable)', bare: 'var(--neon-magenta)', kind: 'text' },
  { f: 'ConversationSidebar.vue', ln: 413, sel: '.search-input:focus border', face: CARD, fg: 'var(--accent-readable)', bare: 'var(--neon-cyan)', kind: 'ui' },
  { f: 'ConversationSidebar.vue', ln: 436, sel: '.conversation-item.active border-left', face: 'var(--accent-cyan-a10)', fg: 'var(--accent-readable)', bare: 'var(--neon-cyan)', kind: 'ui' },
  { f: 'ConversationSidebar.vue', ln: 474, sel: '.conv-action-btn:hover', face: 'var(--accent-cyan-a25)', fg: 'var(--accent-readable)', bare: 'var(--neon-cyan)', kind: 'text' },
  { f: 'ConversationSidebar.vue', ln: 485, sel: '.pin-btn.pin-active', face: 'var(--accent-cyan-a25)', fg: 'var(--accent-readable)', bare: 'var(--neon-cyan)', kind: 'text' },
  { f: 'ConversationSidebar.vue', ln: 539, sel: '.conv-menu-item:hover', face: 'var(--accent-cyan-a25)', fg: 'var(--accent-readable)', bare: 'var(--neon-cyan)', kind: 'text' },
  { f: 'DocumentTabs.vue', ln: 206, sel: '.doc-tab:hover border', face: 'var(--accent-purple-a12)', fg: 'var(--purple-readable)', bare: 'var(--neon-purple)', kind: 'ui' },
  { f: 'DocumentTabs.vue', ln: 212, sel: '.doc-tab.active border', face: 'var(--accent-cyan-a15)', fg: 'var(--accent-readable)', bare: 'var(--neon-cyan)', kind: 'ui' },
  { f: 'DocumentTabs.vue', ln: 219, sel: '.tab-pin', face: CARD, fg: 'var(--pink-readable)', bare: 'var(--neon-magenta)', kind: 'text' },
  { f: 'DocumentTabs.vue', ln: 224, sel: '.doc-tab.drag-over border', face: 'var(--accent-cyan-a18)', fg: 'var(--accent-readable)', bare: 'var(--neon-cyan)', kind: 'ui' },
  { f: 'DocumentTabs.vue', ln: 243, sel: '.tab-close:hover', face: 'var(--accent-pink-a20)', fg: 'var(--pink-readable)', bare: 'var(--neon-magenta)', kind: 'text' },
  { f: 'ModelSelector.vue', ln: 414, sel: '.ms-source.personal color', face: 'rgba(0, 245, 255, 0.08)', fg: 'var(--accent-readable)', bare: 'var(--neon-cyan)', kind: 'text' },
  { f: 'ModelSelector.vue', ln: 415, sel: '.ms-source.personal border', face: 'rgba(0, 245, 255, 0.08)', fg: 'var(--accent-readable)', bare: 'var(--neon-cyan)', kind: 'ui' },
  { f: 'ModelSelector.vue', ln: 475, sel: '.selected .ms-item-model', face: CARD, fg: 'var(--accent-readable)', bare: 'var(--neon-cyan)', kind: 'text' },
  { f: 'ModelSelector.vue', ln: 499, sel: '.ms-loading', face: CARD, fg: 'var(--accent-readable)', bare: 'var(--neon-cyan)', kind: 'text' },
  { f: 'ModelSelector.vue', ln: 511, sel: '.ms-link', face: CARD, fg: 'var(--accent-readable)', bare: 'var(--neon-cyan)', kind: 'text' },
  { f: 'ClarifyCard.vue', ln: 100, sel: '.clarify-icon', face: 'var(--accent-purple-a12)', fg: 'var(--accent-readable)', bare: 'var(--neon-cyan)', kind: 'text' },
  { f: 'ClarifyCard.vue', ln: 144, sel: '.clarify-option:hover border', face: 'var(--accent-purple-a08)', fg: 'var(--purple-readable)', bare: 'var(--neon-purple)', kind: 'ui' },
  { f: 'ClarifyCard.vue', ln: 147, sel: '.clarify-option.recommended border', face: CARD, fg: 'var(--accent-readable)', bare: 'var(--neon-cyan)', kind: 'ui' },
  { f: 'ClarifyCard.vue', ln: 164, sel: '.recommend-tag', face: CARD, fg: 'var(--accent-readable)', bare: 'var(--neon-cyan)', kind: 'text' },
  { f: 'InputToolbar.vue', ln: 177, sel: '.tool-chip:hover', face: 'var(--accent-cyan-a12)', fg: 'var(--accent-readable)', bare: 'var(--neon-cyan)', kind: 'text' },
  { f: 'InputToolbar.vue', ln: 183, sel: '.tool-chip:focus-visible outline', face: CARD, fg: 'var(--accent-readable)', bare: 'var(--neon-cyan)', kind: 'ui' },
  { f: 'InputToolbar.vue', ln: 188, sel: '.tool-chip.active', face: 'var(--accent-cyan-a18)', fg: 'var(--accent-readable)', bare: 'var(--neon-cyan)', kind: 'text' },
  { f: 'SessionStatusIcon.vue', ln: 68, sel: '.ss-running', face: CARD, fg: 'var(--accent-readable)', bare: 'var(--neon-cyan)', kind: 'text' },
  { f: 'SessionStatusIcon.vue', ln: 77, sel: '.ss-error', face: CARD, fg: 'var(--pink-readable)', bare: 'var(--neon-magenta)', kind: 'text' },
  { f: 'SessionStatusIcon.vue', ln: 84, sel: '.ss-unread', face: CARD, fg: 'var(--purple-readable)', bare: 'var(--neon-purple)', kind: 'text' },
  { f: 'TocTree.vue', ln: 61, sel: '.toc-row:hover', face: 'var(--accent-cyan-a12)', fg: 'var(--accent-readable)', bare: 'var(--neon-cyan)', kind: 'text' },
  { f: 'TocTree.vue', ln: 67, sel: '.toc-row.active color', face: 'var(--accent-cyan-a20)', fg: 'var(--accent-readable)', bare: 'var(--neon-cyan)', kind: 'text' },
  { f: 'TocTree.vue', ln: 68, sel: '.toc-row.active border-left', face: 'var(--accent-cyan-a20)', fg: 'var(--accent-readable)', bare: 'var(--neon-cyan)', kind: 'ui' },
  { f: 'TtsController.vue', ln: 70, sel: '.tts-status', face: CARD, fg: 'var(--accent-readable)', bare: 'var(--neon-cyan)', kind: 'text' },
  { f: 'TtsController.vue', ln: 83, sel: '.ctrl-btn', face: 'var(--accent-cyan-a08)', fg: 'var(--accent-readable)', bare: 'var(--neon-cyan)', kind: 'text' },
  { f: 'TtsController.vue', ln: 90, sel: '.ctrl-btn:hover border', face: 'var(--accent-cyan-a20)', fg: 'var(--accent-readable)', bare: 'var(--neon-cyan)', kind: 'ui' },
];

const srcOf = (f: string) => readFileSync(join(ROOT, 'src/components', f), 'utf8');
const FILES = [...new Set(POINTS.map((p) => p.f))];

/**
 * 取某行所在的最近规则块体（花括号内文本）。
 * 用于把「清单声明的落点面」钉回源码——否则面是记在测试里的，源码把 tint 调亮/调暗都没人管，
 * 达标结论会悄悄建立在已经不存在的面上（本批 64 点里 21 点是 tint 面）。
 */
function blockOfLine(src: string, ln: number): string {
  // 逐字节定位行首（源文件是 CRLF，按「长度+1」推偏移会整体错位，块就取歪了）
  const starts: number[] = [0];
  for (let i = 0; i < src.length; i++) if (src[i] === '\n') starts.push(i + 1);
  const off = starts[ln - 1] ?? -1;
  if (off < 0) return '';
  const open = src.lastIndexOf('{', off);
  if (open < 0) return '';
  let depth = 0;
  for (let i = open; i < src.length; i++) {
    if (src[i] === '{') depth++;
    else if (src[i] === '}') {
      depth--;
      if (depth === 0) return src.slice(open + 1, i);
    }
  }
  return '';
}

/** 块内自声明的淡底（tint token 或等价的裸 rgba）：出现即说明这条前景并非坐在卡片实底上 */
const OWN_TINT_BG = /background[^;]*(?:var\(--accent-[\w-]+-a\d{2}\)|rgba\()/;

const ratioOf = (fg: string, p: Point, t: (typeof THEMES)[number]) => worstRatio(fg, p.face, t.decls, pageOf(t.decls));

const auditWith = (fgOf: (p: Point) => string): AuditFailure[] => {
  const out: AuditFailure[] = [];
  for (const t of THEMES) {
    for (const p of POINTS) {
      const r = ratioOf(fgOf(p), p, t);
      if (r < THRESHOLD[p.kind]) out.push({ theme: t.name, label: `${p.f} ${p.sel} [L${p.ln}]`, ratio: r, threshold: THRESHOLD[p.kind] });
    }
  }
  return out;
};

/** 接入前的裸基色事实数（实测，非估算）——证明本批不是「顺手活」 */
const BEFORE_FAILURES = auditWith((p) => p.bare).length;

const WRAPPED_LINES: Record<string, Array<{ line: string; count: number }>> = {
  'BatchProgressBar.vue': [
    { line: "  border-top-color: var(--pink-readable, var(--neon-pink));", count: 1 },
    { line: "  color: var(--accent-readable, var(--neon-cyan));", count: 2 },
    { line: "  color: var(--pink-readable, var(--neon-magenta));", count: 1 },
    { line: "  color: var(--pink-readable, var(--neon-pink));", count: 2 },
  ],
  'ClarifyCard.vue': [
    { line: "  border-color: var(--accent-readable, var(--neon-cyan, #00f5ff));", count: 1 },
    { line: "  border-color: var(--purple-readable, var(--neon-purple, #b026ff));", count: 1 },
    { line: "  color: var(--accent-readable, var(--neon-cyan, #00f5ff));", count: 2 },
  ],
  'ConversationSidebar.vue': [
    { line: "  border-color: var(--accent-readable, var(--neon-cyan, #00f5ff));", count: 1 },
    { line: "  border-left: 2px solid var(--accent-readable, var(--neon-cyan, #00f5ff));", count: 1 },
    { line: "  color: var(--accent-readable, var(--neon-cyan, #00f5ff));", count: 3 },
  ],
  'DocumentTabs.vue': [
    { line: "  border-color: var(--accent-readable, var(--neon-cyan));", count: 2 },
    { line: "  border-color: var(--purple-readable, var(--neon-purple));", count: 1 },
    { line: "  color: var(--pink-readable, var(--neon-magenta));", count: 2 },
  ],
  'HealthIssueList.vue': [
    { line: "  border-color: var(--accent-readable, var(--neon-cyan)) !important;", count: 1 },
    { line: "  color: var(--accent-readable, var(--neon-cyan)) !important;", count: 1 },
    { line: "  color: var(--accent-readable, var(--neon-cyan));", count: 2 },
    { line: "  color: var(--pink-readable, var(--neon-magenta)) !important;", count: 1 },
    { line: "  color: var(--pink-readable, var(--neon-magenta));", count: 1 },
  ],
  'InputToolbar.vue': [
    { line: "  color: var(--accent-readable, var(--neon-cyan, #00f5ff));", count: 2 },
    { line: "  outline: 2px solid var(--accent-readable, var(--neon-cyan, #00f5ff));", count: 1 },
  ],
  'MarkdownRenderer.vue': [
    { line: "  border-bottom-color: var(--purple-readable, var(--neon-purple));", count: 1 },
    { line: "  border-left: 3px solid var(--purple-readable, var(--neon-purple));", count: 1 },
    { line: "  color: var(--accent-readable, var(--neon-cyan));", count: 5 },
    { line: "  color: var(--purple-readable, var(--neon-purple));", count: 2 },
  ],
  'ModelSelector.vue': [
    { line: "  border-color: var(--accent-readable, var(--neon-cyan, #00f5ff));", count: 1 },
    { line: "  color: var(--accent-readable, var(--neon-cyan, #00f5ff));", count: 4 },
  ],
  'RefsList.vue': [
    { line: "  border-color: var(--accent-readable, var(--neon-cyan, #00f5ff));", count: 1 },
    { line: "  border-left-color: var(--accent-readable, var(--neon-cyan, #00f5ff));", count: 1 },
    { line: "  border-left: 3px solid var(--accent-readable, var(--neon-cyan, #00f5ff));", count: 1 },
    { line: "  color: var(--accent-readable, var(--neon-cyan, #00f5ff));", count: 4 },
  ],
  'SessionStatusIcon.vue': [
    { line: "  color: var(--m-danger, var(--pink-readable, var(--neon-magenta, #ff006e)));", count: 1 },
    { line: "  color: var(--m-primary, var(--accent-readable, var(--neon-cyan, #00f5ff)));", count: 1 },
    { line: "  color: var(--m-primary, var(--purple-readable, var(--neon-purple, #b026ff)));", count: 1 },
  ],
  'SingleFileProgressBar.vue': [
    { line: "  color: var(--accent-readable, var(--neon-cyan));", count: 3 },
    { line: "  color: var(--pink-readable, var(--neon-magenta));", count: 1 },
    { line: "  color: var(--pink-readable, var(--neon-pink));", count: 1 },
  ],
  'TocTree.vue': [
    { line: "  border-left: 2px solid var(--accent-readable, var(--neon-cyan));", count: 1 },
    { line: "  color: var(--accent-readable, var(--neon-cyan));", count: 2 },
  ],
  'TtsController.vue': [
    { line: "  border-color: var(--accent-readable, var(--neon-cyan, #00f5ff));", count: 1 },
    { line: "  color: var(--accent-readable, var(--neon-cyan, #00f5ff));", count: 2 },
  ],
};

const FAMILY_COUNTS: Record<string, { accent: number; pink: number; purple: number }> = {
  'BatchProgressBar.vue': { accent: 2, pink: 4, purple: 0 },
  'ClarifyCard.vue': { accent: 3, pink: 0, purple: 1 },
  'ConversationSidebar.vue': { accent: 5, pink: 0, purple: 0 },
  'DocumentTabs.vue': { accent: 2, pink: 2, purple: 1 },
  'HealthIssueList.vue': { accent: 4, pink: 2, purple: 0 },
  'InputToolbar.vue': { accent: 3, pink: 0, purple: 0 },
  'MarkdownRenderer.vue': { accent: 5, pink: 0, purple: 4 },
  'ModelSelector.vue': { accent: 5, pink: 0, purple: 0 },
  'RefsList.vue': { accent: 7, pink: 0, purple: 0 },
  'SessionStatusIcon.vue': { accent: 1, pink: 1, purple: 1 },
  'SingleFileProgressBar.vue': { accent: 3, pink: 2, purple: 0 },
  'TocTree.vue': { accent: 3, pink: 0, purple: 0 },
  'TtsController.vue': { accent: 3, pink: 0, purple: 0 },
};

// T04468 裁决后本批 35 处 tint 描边已全部接入 readable，基线归零（新增即红）。
const TINT_BASE: Record<string, number> = {
  'BatchProgressBar.vue': 0,
  'ClarifyCard.vue': 0,
  'ConversationSidebar.vue': 0,
  'DocumentTabs.vue': 0,
  'HealthIssueList.vue': 0,
  'InputToolbar.vue': 0,
  'MarkdownRenderer.vue': 0,
  'ModelSelector.vue': 0,
  'RefsList.vue': 0,
  'SessionStatusIcon.vue': 0,
  'SingleFileProgressBar.vue': 0,
  'TocTree.vue': 0,
  'TtsController.vue': 0,
};

/** T04468 描边账：13 组件共 35 处 tint 描边接入 readable（同族计数 = 64 点 + 描边，不属审计清单） */
const TINT_STROKES: Record<string, { accent: number; pink: number; purple: number }> = {
  'BatchProgressBar.vue': { accent: 1, pink: 3, purple: 2 },
  'ClarifyCard.vue': { accent: 1, pink: 0, purple: 0 },
  'DocumentTabs.vue': { accent: 0, pink: 0, purple: 3 },
  'HealthIssueList.vue': { accent: 3, pink: 3, purple: 3 },
  'InputToolbar.vue': { accent: 1, pink: 0, purple: 0 },
  'MarkdownRenderer.vue': { accent: 5, pink: 0, purple: 0 },
  'RefsList.vue': { accent: 2, pink: 0, purple: 1 },
  'SingleFileProgressBar.vue': { accent: 1, pink: 2, purple: 2 },
  'TtsController.vue': { accent: 2, pink: 0, purple: 0 },
};
const TINT_STROKE_TOTAL = 35;

describe('T04470 批次 B：13 个组件 64 面逐主题实算达标', () => {
  for (const t of THEMES) {
    it(`${t.name}：64 个消费点全部达 WCAG AA（文本 4.5 / 非文本 3.0）`, () => {
      const bad = auditWith((p) => p.fg).filter((x) => x.theme === t.name);
      expect(bad, `${t.name} 低对比消费点\n${bad.map((b) => `${b.label}=${b.ratio.toFixed(2)}<${b.threshold}`).join('\n')}`).toEqual([]);
    });
  }

  it('清单规模与本批实现严格对齐：13 文件 64 个真实点（+10 状态点 = 74，与本单账一致）', () => {
    expect(POINTS.length).toBe(64);
    expect(FILES.length).toBe(13);
    expect(BEFORE_FAILURES, '接入前未达标组合数被改动——本批结论建立在这组实测上').toBe(241);
  });

  it('选族是逐面实算的结果：9 个青族点若按粉/紫族接必跌破 4.5', () => {
    const cyanPts = POINTS.filter((p) => p.fg === 'var(--accent-readable)');
    const pinkWouldFail = cyanPts.filter((p) => Math.min(...THEMES.map((t) => ratioOf('var(--pink-readable)', p, t))) < THRESHOLD[p.kind]);
    const purpleWouldFail = cyanPts.filter((p) => Math.min(...THEMES.map((t) => ratioOf('var(--purple-readable)', p, t))) < THRESHOLD[p.kind]);
    const labels = pinkWouldFail.map((p) => `${p.f}:L${p.ln}`).sort();
    expect(labels, labels.join(' ')).toEqual([
      'ConversationSidebar.vue:L474',
      'ConversationSidebar.vue:L485',
      'ConversationSidebar.vue:L539',
      'InputToolbar.vue:L177',
      'InputToolbar.vue:L188',
      'RefsList.vue:L192',
      'RefsList.vue:L257',
      'TocTree.vue:L61',
      'TocTree.vue:L67',
    ]);
    // 9 处全是「青字压深档青 tint（a12~a25）」的文本点，粉/紫两族在浅底主题上同样不够——按面留在青族；
    // 两个 a20 描边点（TocTree L68 / TtsController L90）按非文本 3.0 口径粉/紫也能过，故不在杀名单里——
    // 这正是口径分档的作用范围，把它们混为一谈会虚报严重度。
    expect(purpleWouldFail.length).toBe(9);
  });

  it('13 个组件的裸基色前景声明全部归零（规模锁，回退即红）', () => {
    const baseTokens = [/^--neon-cyan$/, /^--neon-pink$/, /^--accent-pink$/, /^--neon-magenta$/, /^--neon-purple$/, /^--accent-purple$/];
    const bad: string[] = [];
    for (const f of FILES) {
      const n = listBareBaseForegroundUses(srcOf(f), { baseTokens }).length;
      if (n) bad.push(`${f}=${n}`);
    }
    expect(bad, `仍有裸基色前景：${bad.join(' ')}`).toEqual([]);
  });

  it('落点面与源码互证：tint 面块内确有该背景声明，CARD 面块内不得自带淡底（防「面被偷抬」）', () => {
    const bad: string[] = [];
    for (const p of POINTS) {
      const block = blockOfLine(srcOf(p.f), p.ln);
      if (!block) {
        bad.push(`${p.f}:L${p.ln} 规则块没扫到（行号漂移会让整份清单失去意义）`);
        continue;
      }
      if (p.face === CARD) {
        if (OWN_TINT_BG.test(block)) bad.push(`${p.f}:L${p.ln} 记为卡片实底，块内却有淡底声明`);
      } else {
        // 面按源码块内 background 声明互证。清单里的 tint 面写作 var(--x)（不带 fallback），
        // 源码可能写作 var(--x, rgba(...))，故 token 名对齐；裸 rgba 面则逐字比。
        const bgs = [...block.matchAll(/background[^;]*/g)].map((x) => x[0]);
        const isFace = (b: string) =>
          p.face.startsWith('var(') ? new RegExp(`var\\(${p.face.slice(4, -1)}[,)]`).test(b) : b.includes(p.face);
        if (!bgs.some(isFace)) bad.push(`${p.f}:L${p.ln} 记为 ${p.face}，块内 background 已不是这个面`);
      }
      // 前景原文确在这条块里（清单行号与消费点绑定，不是只在文件里出现过一次）。
      // 按 token 名比：清单里的 fg 是完整 var(--x) 串，源码写作 var(--x, fallback)，整串比不中。
      if (!block.includes(p.fg.slice(4, -1))) bad.push(`${p.f}:L${p.ln} 块内找不到 ${p.fg}`);
    }
    expect(bad, bad.join('\n')).toEqual([]);
  });

  it('接入原文逐条点名（任何一行被回退即红）', () => {
    for (const [f, list] of Object.entries(WRAPPED_LINES)) {
      const lines = srcOf(f).split(/\r?\n/);
      for (const { line, count } of list) {
        const hits = lines.filter((l) => l === line).length;
        expect(hits, `${f} · ${JSON.stringify(line)} 应 ${count} 条，实测 ${hits} 条`).toBe(count);
      }
    }
  });

  it('逐文件族桶点数与账一致（接错家族或漏接会被点名）', () => {
    for (const [f, v] of Object.entries(FAMILY_COUNTS)) {
      const src = srcOf(f);
      for (const [fam, n] of Object.entries(v)) {
        const got = (src.match(new RegExp(`--${fam}-readable`, 'g')) || []).length;
        const stroke = TINT_STROKES[f]?.[fam as 'accent' | 'pink' | 'purple'] ?? 0;
        expect(got, `${f} · --${fam}-readable 应有 ${n}+${stroke} 处，实测 ${got}`).toBe(n + stroke);
      }
    }
    const total = Object.values(FAMILY_COUNTS).reduce((a, v) => a + v.accent + v.pink + v.purple, 0);
    expect(total).toBe(64);
    const strokes = Object.values(TINT_STROKES).reduce((a, v) => a + v.accent + v.pink + v.purple, 0);
    expect(strokes, 'T04468 描边账与 TINT_BASE 历史基线（35）不再一致').toBe(TINT_STROKE_TOTAL);
  });

  it('包裹表达式括号平衡且行尾未丢（防止接入器吃掉字符）', () => {
    const isDecl = (l: string) => /^\s*(?:color|border|border-\w+-color|outline)(?:-color)?\s*:/.test(l);
    for (const f of FILES) {
      const bad = srcOf(f)
        .split(/\r?\n/)
        .filter((l) => isDecl(l) && /-readable/.test(l) && (l.match(/\(/g) || []).length !== (l.match(/\)/g) || []).length);
      expect(bad, `${f} 有 ${bad.length} 行括号不平衡：${bad.slice(0, 2).join(' | ')}`).toEqual([]);
    }
  });
});

describe('T04470 批次 B：状态点 currentColor 惯用法（10 处，不按文本前景包裹）', () => {
  const DOTS = ['BatchProgressBar.vue', 'SingleFileProgressBar.vue'];
  const GLOW: Record<string, number> = { 'BatchProgressBar.vue': 6, 'SingleFileProgressBar.vue': 5 };

  for (const f of DOTS) {
    it(`${f}：状态点规则内不得再有裸基色 color，光晕色改用 --dot-glow 显式承载`, () => {
      const src = srcOf(f);
      const blocks = [...src.matchAll(/\.progress-status-dot[^{]*\{([^}]*)\}/g)].map((m) => m[1]);
      expect(blocks.length, '状态点规则块没扫到').toBeGreaterThanOrEqual(5);
      const bareColor = blocks.filter((b) => /(^|[;\n])\s*color:\s*var\(--neon-/m.test(b));
      expect(bareColor, `仍有裸基色 color：${bareColor.map((b) => b.trim().slice(0, 40)).join(' | ')}`).toEqual([]);
      const glows = [...src.matchAll(/--dot-glow:\s*var\((--[\w-]+)\)/g)].map((m) => m[1]);
      expect(glows.length, `${f} --dot-glow 声明数`).toBe(GLOW[f]);
      // 光晕与填充逐条同 token：颜色对调（例如 done 点亮成粉）会被这条抓到
      // T04460 后中断态改用真 token --warning（--neon-amber 从未定义），故配对口径不再限定 --neon- 族
      const pairs = [...src.matchAll(/background:\s*var\((--[\w-]+)\);\s*\r?\n\s*--dot-glow:\s*var\((--[\w-]+)\)/g)];
      expect(pairs.length, '填充与光晕的同 token 配对数').toBe(GLOW[f]);
      expect(pairs.every((p) => p[1] === p[2]), `${f} 存在光晕色与填充色不同 token`).toBe(true);
      expect(src).not.toMatch(/box-shadow: 0 0 8px currentColor/);
      expect(src).toMatch(/box-shadow: 0 0 8px var\(--dot-glow\)/);
    });
  }

  it('BatchProgressBar 中断态（琥珀）点同步改走 --dot-glow，否则基块改完后它会失去光晕', () => {
    const block = /\.batch-progress-container\.interrupted \.progress-status-dot \{([^}]*)\}/.exec(srcOf('BatchProgressBar.vue'));
    expect(block, '中断态规则块丢失').not.toBeNull();
    // T04460：原 var(--neon-amber) 是假 token（恒等于 fallback 的霓虹橙），现改走本主题警示色
    expect(block![1]).toMatch(/--dot-glow: var\(--warning\)/);
    expect(block![1]).toMatch(/box-shadow: 0 0 8px var\(--dot-glow\)/);
    expect(block![1]).not.toMatch(/(^|[;\n])\s*color:/);
  });

  it('transition 跟随改写：原按 color 过渡，去掉 color 声明后必须改按 box-shadow 过渡', () => {
    for (const f of DOTS) {
      expect(srcOf(f)).not.toMatch(/transition: background 0\.3s ease, color 0\.3s ease;/);
      expect(srcOf(f)).toMatch(/transition: background 0\.3s ease, box-shadow 0\.3s ease;/);
    }
  });
});

describe('T04470 批次 B：SessionStatusIcon 移动端皮肤优先级不被 readable 顶掉', () => {
  const F = 'SessionStatusIcon.vue';
  it('三条前景的 readable 都在 --m-* 之内层兜底位，外层皮肤变量优先级保持', () => {
    const src = srcOf(F);
    expect(src).toMatch(/color: var\(--m-primary, var\(--accent-readable, var\(--neon-cyan, #00f5ff\)\)\);/);
    expect(src).toMatch(/color: var\(--m-danger, var\(--pink-readable, var\(--neon-magenta, #ff006e\)\)\);/);
    expect(src).toMatch(/color: var\(--m-primary, var\(--purple-readable, var\(--neon-purple, #b026ff\)\)\);/);
  });
});

describe('T04470 批次 B：装饰性 tint 前景保持基线（本批不改，新增即红）', () => {
  for (const [f, n0] of Object.entries(TINT_BASE)) {
    it(`${f}：装饰 tint 前景 ≤ 基线 ${n0}`, () => {
      let n = 0;
      for (const l of srcOf(f).split(/\r?\n/)) {
        const m = /^\s*(?:color|border-color|border(?:-(?:left|right|top|bottom))?|outline(?:-color)?)\s*:\s*([^;]*)/.exec(l);
        if (m && /var\(--accent-[\w-]+-a\d\d/.test(m[1]) && !/-readable/.test(m[1])) n++;
      }
      expect(n, `${f} 装饰 tint 前景应从基线 ${n0} 只降不升，实测 ${n}`).toBeLessThanOrEqual(n0);
    });
  }
});
