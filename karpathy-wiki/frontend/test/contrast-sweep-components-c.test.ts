// T04470 批次 C：长尾 13 个组件 21 处裸基色前景接入（本单账的最后一批消费点）
//
// 与前六批的关系：视图层（批次 A 68 处）与问答/进度组件（批次 B 74 处）已收口，本批把索引锁
// BASELINE 里剩下的 21 处一次清掉。口径不变——基色（--neon-cyan/--neon-pink/--accent-pink/
// --neon-magenta/--neon-purple/--accent-purple）裸写进 color/border(-color)/outline(-color) 即违规，
// 接入形态一律 var(--<家族>-readable, var(--<基色>[, #hex]))，原 fallback 原样保留。
//
// 本批的两点特殊性（结论都建立在逐主题实算上，不是惯例）：
//  1) 两处 hover 深 tint 面：FloatingChat 建议 chip 与 MessageToolbar 删除按钮。接入 readable 后
//     在 a25 面上仍到不了 4.5（1.31~1.80 → 4.27~4.32），瓶颈是面本身。T04482 把这两处 hover 的
//     淡底从 a25 降到 a12（与本批其余 hover 面同档），逐主题实算 5.0457 / 4.8071，21 点 × 8 主题归零。
//  2) 一处跨家族按面选族：MultimodalOutputCard 的代码字色基名是紫，落点面却是青 tint（a12），
//     留在紫族只有 4.48，改走青族 4.88 达标——延续批次 A2 About 的「按面选族」结论。
import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { ROOT, THRESHOLD, loadThemes, worstRatio, pageOf, listBareBaseForegroundUses, type AuditFailure } from './helpers/contrast';

const THEMES = loadThemes();
// T04530：本文件只审页面级落点——CARD_OVER_PAGE = 卡片压页底（不含弹窗遮罩层）。
// 弹窗内的同一类前景点改由 contrast-modal-internal-face.test.ts 按 modalFaces() 两张落点实算，
// 两套口径不要混用：这里把卡片当最终面，弹窗锁里卡片只是「遮罩压底」之上的一层。
const CARD_OVER_PAGE = 'var(--bg-card-solid)';

interface Point {
  f: string;
  ln: number;
  sel: string;
  /** 落点面：CARD_OVER_PAGE = 规则自身无底（页面级口径取卡片压页底）；其余为块内自声明 tint */
  face: string;
  fg: string;
  bare: string;
  kind: 'text' | 'ui';
}

/** 本批 21 个消费点（处数与 test/contrast-sweep-index.test.ts 起算基线逐文件一致） */
const POINTS: Point[] = [
  { f: 'AttachmentUploader.vue', ln: 213, sel: '.upload-btn:hover', face: 'var(--accent-cyan-a12)', fg: 'var(--accent-readable)', bare: 'var(--neon-cyan)', kind: 'text' },
  { f: 'AttachmentUploader.vue', ln: 233, sel: '.attachment-list.drag-over', face: 'var(--accent-cyan-a10)', fg: 'var(--accent-readable)', bare: 'var(--neon-cyan)', kind: 'ui' },
  { f: 'CitationModal.vue', ln: 131, sel: '.citation-chunk-head', face: CARD_OVER_PAGE, fg: 'var(--accent-readable)', bare: 'var(--neon-cyan)', kind: 'text' },
  { f: 'CitationText.vue', ln: 58, sel: 'sup.cite-ref', face: CARD_OVER_PAGE, fg: 'var(--accent-readable)', bare: 'var(--neon-cyan)', kind: 'ui' },
  { f: 'CitationText.vue', ln: 59, sel: 'sup.cite-ref', face: CARD_OVER_PAGE, fg: 'var(--accent-readable)', bare: 'var(--neon-cyan)', kind: 'text' },
  // T04542：徽章 min-width/min-height 抬到 44px 使 hover 落点由 L108 平移到 L114（blockOfLine
  // 取的是声明行所在块，故指针必须落在 border-color 行而非选择器行）；面/前景/族均未变
  // （本次只加尺寸声明），仅刷新行号指针，实算结论沿用。
  // T05703：去掉徽章常驻外框后，hover 规则由「:hover, :focus-visible 合并块」拆成独立的
  // :hover 块，border-color 声明平移到 L123。声明原文、落点面（无自带淡底）、前景族均未变，
  // 同样只刷新行号指针；本条仍是 CARD_OVER_PAGE 口径的 ui 点。
  { f: 'ContextUsageBadge.vue', ln: 123, sel: '.ctx-badge-inner:hover', face: CARD_OVER_PAGE, fg: 'var(--accent-readable)', bare: 'var(--neon-cyan)', kind: 'ui' },
  // T05745 P3 在 FloatingChat 样式区插入气泡/窄屏规则，原 L941/942 整体平移到 L969/970；
  // 选择器、落点面 a12、前景 readable 族均未变，只刷新行号指针。
  { f: 'FloatingChat.vue', ln: 969, sel: '.suggestion-chip:hover', face: 'var(--accent-purple-a12)', fg: 'var(--purple-readable)', bare: 'var(--neon-purple)', kind: 'ui' },
  { f: 'FloatingChat.vue', ln: 970, sel: '.suggestion-chip:hover', face: 'var(--accent-purple-a12)', fg: 'var(--purple-readable)', bare: 'var(--neon-purple)', kind: 'text' },
  { f: 'FollowupsChips.vue', ln: 70, sel: '.followup-chip:hover:not(:disabled)', face: 'var(--accent-cyan-a12)', fg: 'var(--accent-readable)', bare: 'var(--neon-cyan)', kind: 'ui' },
  { f: 'FollowupsChips.vue', ln: 71, sel: '.followup-chip:hover:not(:disabled)', face: 'var(--accent-cyan-a12)', fg: 'var(--accent-readable)', bare: 'var(--neon-cyan)', kind: 'text' },
  { f: 'GuideButton.vue', ln: 58, sel: '.guide-entry-btn:hover', face: 'var(--accent-cyan-a12)', fg: 'var(--accent-readable)', bare: 'var(--neon-cyan)', kind: 'text' },
  { f: 'GuideButton.vue', ln: 64, sel: '.guide-entry-btn:focus-visible', face: CARD_OVER_PAGE, fg: 'var(--accent-readable)', bare: 'var(--neon-cyan)', kind: 'ui' },
  { f: 'GuideOverlay.vue', ln: 220, sel: '.guide-box', face: CARD_OVER_PAGE, fg: 'var(--accent-readable)', bare: 'var(--neon-cyan)', kind: 'ui' },
  { f: 'GuideOverlay.vue', ln: 266, sel: '.guide-step', face: CARD_OVER_PAGE, fg: 'var(--accent-readable)', bare: 'var(--neon-cyan)', kind: 'text' },
  { f: 'MessageActions.vue', ln: 106, sel: '.action-btn:hover', face: 'var(--accent-cyan-a10)', fg: 'var(--accent-readable)', bare: 'var(--neon-cyan)', kind: 'text' },
  { f: 'MessageActions.vue', ln: 109, sel: '.action-btn.active', face: CARD_OVER_PAGE, fg: 'var(--accent-readable)', bare: 'var(--neon-cyan)', kind: 'text' },
  { f: 'MessageToolbar.vue', ln: 587, sel: '.toolbar-btn.danger-btn:hover', face: 'var(--accent-pink-a12)', fg: 'var(--pink-readable)', bare: 'var(--neon-pink)', kind: 'text' },
  { f: 'MultimodalOutputCard.vue', ln: 267, sel: '.card-body :deep(.markdown-body code)', face: 'var(--accent-cyan-a12)', fg: 'var(--accent-readable)', bare: 'var(--neon-purple)', kind: 'text' },
  { f: 'ThemeSwitcher.vue', ln: 310, sel: '.theme-check', face: CARD_OVER_PAGE, fg: 'var(--accent-readable)', bare: 'var(--neon-cyan)', kind: 'text' },
  { f: 'ThinkingBlock.vue', ln: 85, sel: '.thinking-block', face: 'var(--accent-purple-a04)', fg: 'var(--purple-readable)', bare: 'var(--neon-purple)', kind: 'ui' },
  { f: 'ThinkingBlock.vue', ln: 91, sel: '.thinking-block.live', face: 'var(--accent-purple-a08)', fg: 'var(--purple-readable)', bare: 'var(--neon-purple)', kind: 'ui' },
];

const srcOf = (f: string) => readFileSync(join(ROOT, 'src/components', f), 'utf8');
const FILES = [...new Set(POINTS.map((p) => p.f))];

/** 取某行所在规则块体（把清单声明的落点面钉回源码，防「面被偷抬」） */
function blockOfLine(src: string, ln: number): string {
  // 逐字节定位行首：这些组件文件 EOL 混用（批次 C 里 4 个文件是 CRLF），按「行长+1」推偏移会整体取歪
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

const OWN_TINT_BG = /background[^;]*(?:var\(--accent-[\w-]+-a\d{2}\)|rgba\()/;

const ratioOf = (fg: string, p: Point, t: (typeof THEMES)[number]) => worstRatio(fg, p.face, t.decls, pageOf(t.decls));

/** 接入前口径：两处 hover 在 T04482 降档前用的是 a25 面，基线数不能跟着新面漂移 */
const PRE_FACE: Record<string, string> = {
  'FloatingChat.vue:L969': 'var(--accent-purple-a25)',
  'FloatingChat.vue:L970': 'var(--accent-purple-a25)',
  'MessageToolbar.vue:L587': 'var(--accent-pink-a25)',
};
const preFaceOf = (p: Point) => PRE_FACE[`${p.f}:L${p.ln}`] ?? p.face;

const auditWith = (fgOf: (p: Point) => string, faceOf: (p: Point) => string = (p) => p.face): AuditFailure[] => {
  const out: AuditFailure[] = [];
  for (const t of THEMES) {
    for (const p of POINTS) {
      const r = worstRatio(fgOf(p), faceOf(p), t.decls, pageOf(t.decls));
      if (r < THRESHOLD[p.kind]) out.push({ theme: t.name, label: `${p.f} ${p.sel} [L${p.ln}]`, ratio: r, threshold: THRESHOLD[p.kind] });
    }
  }
  return out;
};

/** 接入前的裸基色事实数（实测，非估算）——本批 21 点 × 8 主题里 74 个组合未达标 */
const BEFORE_FAILURES = auditWith((p) => p.bare, preFaceOf).length;

/** 接入后的未达标格：T04482 降档后必须为空（多一个即回归） */
const AFTER_FAILURES = auditWith((p) => p.fg);

const WRAPPED_LINES: Record<string, Array<{ line: string; count: number }>> = {
  'AttachmentUploader.vue': [
    { line: '  border: 1px dashed var(--accent-readable, var(--neon-cyan, #00f5ff));', count: 1 },
    { line: '  color: var(--accent-readable, var(--neon-cyan, #00f5ff));', count: 1 },
  ],
  'CitationModal.vue': [{ line: '  color: var(--accent-readable, var(--neon-cyan));', count: 1 }],
  'CitationText.vue': [
    { line: '  border: 1px solid var(--accent-readable, var(--neon-cyan, #00f5ff));', count: 1 },
    { line: '  color: var(--accent-readable, var(--neon-cyan, #00f5ff));', count: 1 },
  ],
  'ContextUsageBadge.vue': [{ line: '  border-color: var(--accent-readable, var(--neon-cyan, #00f5ff));', count: 1 }],
  'FloatingChat.vue': [
    { line: '  border-color: var(--purple-readable, var(--neon-purple));', count: 1 },
    { line: '  color: var(--purple-readable, var(--neon-purple));', count: 1 },
  ],
  'FollowupsChips.vue': [
    { line: '  border-color: var(--accent-readable, var(--neon-cyan, #00f5ff));', count: 1 },
    { line: '  color: var(--accent-readable, var(--neon-cyan, #00f5ff));', count: 1 },
  ],
  'GuideButton.vue': [
    { line: '  color: var(--accent-readable, var(--neon-cyan, #00e5ff));', count: 1 },
    { line: '  outline: 2px solid var(--accent-readable, var(--neon-cyan, #00e5ff));', count: 1 },
  ],
  'GuideOverlay.vue': [
    { line: '  border: 2px dashed var(--accent-readable, var(--neon-cyan, #00e5ff));', count: 1 },
    { line: '  color: var(--accent-readable, var(--neon-cyan, #00e5ff));', count: 1 },
  ],
  'MessageActions.vue': [{ line: '  color: var(--accent-readable, var(--neon-cyan, #00f5ff));', count: 2 }],
  'MessageToolbar.vue': [{ line: '  color: var(--pink-readable, var(--neon-pink, #ff006e));', count: 1 }],
  'MultimodalOutputCard.vue': [{ line: '  color: var(--accent-readable, var(--neon-purple, #1554d1));', count: 1 }],
  'ThemeSwitcher.vue': [{ line: '  color: var(--accent-readable, var(--neon-cyan));', count: 1 }],
  'ThinkingBlock.vue': [
    { line: '  border-left-color: var(--purple-readable, var(--neon-purple, #b226ff));', count: 1 },
    { line: '  border-left: 2px solid var(--purple-readable, var(--neon-purple, #b226ff));', count: 1 },
  ],
};

/** 本批逐文件族桶（=21，接错家族/漏接会被点名） */
const FAMILY_COUNTS: Record<string, { accent: number; pink: number; purple: number }> = {
  'AttachmentUploader.vue': { accent: 2, pink: 0, purple: 0 },
  'CitationModal.vue': { accent: 1, pink: 0, purple: 0 },
  'CitationText.vue': { accent: 2, pink: 0, purple: 0 },
  'ContextUsageBadge.vue': { accent: 1, pink: 0, purple: 0 },
  'FloatingChat.vue': { accent: 0, pink: 0, purple: 2 },
  'FollowupsChips.vue': { accent: 2, pink: 0, purple: 0 },
  'GuideButton.vue': { accent: 2, pink: 0, purple: 0 },
  'GuideOverlay.vue': { accent: 2, pink: 0, purple: 0 },
  'MessageActions.vue': { accent: 2, pink: 0, purple: 0 },
  'MessageToolbar.vue': { accent: 0, pink: 1, purple: 0 },
  'MultimodalOutputCard.vue': { accent: 1, pink: 0, purple: 0 },
  'ThemeSwitcher.vue': { accent: 1, pink: 0, purple: 0 },
  'ThinkingBlock.vue': { accent: 0, pink: 0, purple: 2 },
};

/**
 * 装饰性 tint 当前景的本批文件现状（只降不升）。
 * 这类点不在本单口径内（索引锁按基色计数，tint 不算违规），是否纳入口径由 T04468 裁决；
 * 这里冻结现状，是为了让「接入 readable」的过程不许顺手往前景里加新的 tint。
 */
// T04468 裁决后本批 20 处 tint 描边已全部接入 readable，基线归零（新增即红）。
const TINT_BASE: Record<string, number> = {
  'AttachmentUploader.vue': 0,
  'CitationModal.vue': 0,
  'CitationText.vue': 0,
  'ContextUsageBadge.vue': 0,
  'FloatingChat.vue': 0,
  'FollowupsChips.vue': 0,
  'GuideButton.vue': 0,
  'GuideOverlay.vue': 0,
  'MessageActions.vue': 0,
  'MessageToolbar.vue': 0,
  'MultimodalOutputCard.vue': 0,
  'ThemeSwitcher.vue': 0,
  'ThinkingBlock.vue': 0,
};

describe('T04470 批次 C：13 个组件 21 面逐主题实算', () => {
  for (const t of THEMES) {
    it(`${t.name}：21 个消费点全部达 AA`, () => {
      const bad = AFTER_FAILURES.filter((x) => x.theme === t.name);
      expect(bad.map((b) => `${b.label} = ${b.ratio.toFixed(4)}`), `${t.name} 仍有未达标格`).toEqual([]);
    });
  }

  it('21 个格接入 + 两处降档后全部达 AA；残差归零', () => {
    expect(POINTS.length).toBe(21);
    expect(FILES.length).toBe(13);
    expect(BEFORE_FAILURES, '接入前未达标组合数被改动——本批结论建立在这组实测上').toBe(74);
    // 原 14 个残差（T04480 闭掉 macaron 紫一侧 → 13），T04482 把两处 hover 的 a25 面降到 a12 后归零
    expect(AFTER_FAILURES).toEqual([]);
    const repaired = 74 - AFTER_FAILURES.length;
    expect(repaired).toBe(74);
  });

  it('13 个文件的裸基色前景声明全部归零（与索引锁同一口径的规模锁）', () => {
    const baseTokens = [/^--neon-cyan$/, /^--neon-pink$/, /^--accent-pink$/, /^--neon-magenta$/, /^--neon-purple$/, /^--accent-purple$/];
    const bad: string[] = [];
    for (const f of FILES) {
      const n = listBareBaseForegroundUses(srcOf(f), { baseTokens }).length;
      if (n) bad.push(`${f}=${n}`);
    }
    expect(bad, `仍有裸基色前景：${bad.join(' ')}`).toEqual([]);
  });

  it('落点面与源码互证：tint 面块内确有该背景声明，CARD_OVER_PAGE 面块内不得自带淡底（防「面被偷抬」）', () => {
    const bad: string[] = [];
    for (const p of POINTS) {
      const block = blockOfLine(srcOf(p.f), p.ln);
      if (!block) {
        bad.push(`${p.f}:L${p.ln} 规则块没扫到（行号漂移会让整份清单失去意义）`);
        continue;
      }
      if (p.face === CARD_OVER_PAGE) {
        if (OWN_TINT_BG.test(block)) bad.push(`${p.f}:L${p.ln} 记为卡片实底，块内却有淡底声明`);
      } else {
        const bgs = [...block.matchAll(/background[^;]*/g)].map((x) => x[0]);
        const isFace = (b: string) =>
          p.face.startsWith('var(') ? new RegExp(`var\\(${p.face.slice(4, -1)}[,)]`).test(b) : b.includes(p.face);
        if (!bgs.some(isFace)) bad.push(`${p.f}:L${p.ln} 记为 ${p.face}，块内 background 已不是这个面`);
      }
      if (!block.includes(p.fg.slice(4, -1))) bad.push(`${p.f}:L${p.ln} 块内找不到 ${p.fg}`);
    }
    expect(bad, bad.join('\n')).toEqual([]);
  });

  it('接入原文逐条点名（任何一行被回退或改族即红）', () => {
    for (const [f, list] of Object.entries(WRAPPED_LINES)) {
      const lines = srcOf(f).split(/\r?\n/);
      for (const { line, count } of list) {
        const hits = lines.filter((l) => l === line).length;
        expect(hits, `${f} · ${JSON.stringify(line)} 应 ${count} 条，实测 ${hits} 条`).toBe(count);
      }
    }
  });

  it('逐文件族桶点数与本批账一致（合计 21）', () => {
    let total = 0;
    for (const [f, v] of Object.entries(FAMILY_COUNTS)) {
      const batchLines = Object.values(WRAPPED_LINES[f] ?? []);
      const lines = srcOf(f).split(/\r?\n/);
      for (const [fam, n] of Object.entries(v)) {
        const got = batchLines.reduce((s, w) => s + (w.line.includes(`--${fam}-readable`) ? lines.filter((l) => l === w.line).length : 0), 0);
        expect(got, `${f} · 本批 --${fam}-readable 应有 ${n} 处，实测 ${got}`).toBe(n);
        total += n;
      }
    }
    expect(total).toBe(21);
  });

  it('跨家族选族是实算结果：MultimodalOutputCard 代码字色若留在紫族，3 个主题跌破 4.5', () => {
    const p = POINTS.find((x) => x.f === 'MultimodalOutputCard.vue')!;
    expect(p.bare).toBe('var(--neon-purple)');
    expect(p.fg).toBe('var(--accent-readable)'); // 落点面是青 tint a12 → 按面选族（延续批次 A2 About 的结论）
    const purpleFails = THEMES.filter((t) => ratioOf('var(--purple-readable)', p, t) < THRESHOLD.text);
    expect(purpleFails.map((t) => t.name).sort()).toEqual(['creative', 'default(:root)', 'product']);
    expect(Math.min(...THEMES.map((t) => ratioOf('var(--purple-readable)', p, t))).toFixed(4)).toBe('4.4765');
    expect(THEMES.filter((t) => ratioOf('var(--accent-readable)', p, t) < THRESHOLD.text)).toEqual([]);
    // 全批 21 点里只允许这一处跨家族
    const cross = POINTS.filter((x) => {
      const famOfFg = x.fg === 'var(--accent-readable)' ? 'cyan' : x.fg === 'var(--pink-readable)' ? 'pink' : 'purple';
      const famOfBare = x.bare.includes('cyan') ? 'cyan' : x.bare.includes('pink') ? 'pink' : 'purple';
      return famOfFg !== famOfBare;
    });
    expect(cross.map((x) => `${x.f}:L${x.ln}`)).toEqual(['MultimodalOutputCard.vue:L267']);
  });

  it('选族不许随手换：青族 16 点换粉/紫各破 4 点；降档后紫/粉两组换族均不再破', () => {
    const labels = (ps: Point[]) => ps.map((p) => `${p.f}:L${p.ln}`).sort();
    const breaks = (pool: Point[], fam: string) => pool.filter((p) => THEMES.some((t) => ratioOf(`var(--${fam}-readable)`, p, t) < THRESHOLD[p.kind]));
    const cyanPts = POINTS.filter((p) => p.fg === 'var(--accent-readable)');
    const purplePts = POINTS.filter((p) => p.fg === 'var(--purple-readable)');
    expect(cyanPts.length).toBe(16);
    expect(purplePts.length).toBe(4);
    // 4 个「青字压深档青 tint（a10/a12）」的文本点，粉/紫两族在 default/creative/product 三主题同样不够——
    // 两个 a25 描边点按非文本 3.0 也能过，所以不在杀名单里：这正是口径分档的作用范围，混为一谈会虚报严重度。
    const wantCyanBreak = ['AttachmentUploader.vue:L213', 'FollowupsChips.vue:L71', 'GuideButton.vue:L58', 'MultimodalOutputCard.vue:L267'];
    expect(labels(breaks(cyanPts, 'pink'))).toEqual(wantCyanBreak);
    expect(labels(breaks(cyanPts, 'purple'))).toEqual(wantCyanBreak);
    // T04482 降档到 a12 后，原 a25 面上「换族也修不掉」的两格随面一起消失：三族在两组落点均达标。
    expect(labels(breaks(purplePts, 'accent'))).toEqual([]);
    expect(labels(breaks(purplePts, 'pink'))).toEqual([]);
    const pinkPts = POINTS.filter((p) => p.fg === 'var(--pink-readable)');
    expect(pinkPts.length).toBe(1);
    expect(labels(breaks(pinkPts, 'accent'))).toEqual([]);
    expect(labels(breaks(pinkPts, 'purple'))).toEqual([]);
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

  it('降档后的 a12 面对三个 readable 族都达标（残差根因是 a25 面，不是族）', () => {
    // T04482 在 a25 面上实测三族全不达标（3.47~4.42）；降档到 a12 后三族全部 ≥4.64。
    // 这条同时锁住「不改 readable 取值」的结论：族取值一旦被调浅，先红的会是原来的配对族，
    // 但只要某个 alt 族掉线也说明面/取值口径变了，残差需要重评。
    for (const key of ['FloatingChat.vue:L970', 'MessageToolbar.vue:L587']) {
      const p = POINTS.find((x) => `${x.f}:L${x.ln}` === key)!;
      for (const fam of ['var(--accent-readable)', 'var(--pink-readable)', 'var(--purple-readable)']) {
        const fails = THEMES.filter((t) => ratioOf(fam, p, t) < THRESHOLD.text).map((t) => t.name);
        expect(fails, `${key} 按 ${fam} 未达标：${fails.join(',')}`).toEqual([]);
      }
    }
  });
});

describe('T04470 批次 C：装饰性 tint 前景保持基线（本批不改，新增即红）', () => {
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
