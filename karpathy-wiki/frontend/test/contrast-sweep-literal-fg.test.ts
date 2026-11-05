// T04509：桌面「字面色前景压主题决定面」的普查口径与全站锁。
//
// 母单 T04472 只管「白字压强调面」；本单把判定泛化为「前景声明里出现非 var() 的字面色
// （十六进制 / rgb()/rgba() / hsl()/hsla() / 命名色 white|black）」——因为同类缺陷的另一半
// 是「语义色字面量（#8a5a00 / #1d7a5f / #f87171 一类）写死在前景点，压在同族半透明 tint 面上」：
// tint 是字面 alpha，真实底由主题页底合成，浅底主题合成出亮面、深底主题合成出暗面，
// 于是一份「贴着浅底实算出来的中深字面量」在深底主题只剩 2.1~3.5:1（反之亦然）。
//
// 修法沿用 T04472 已验证口径：一个面给一对 token（--on-<面>-fg / --on-<面>-bg），取值逐主题实算；
// 只动这一面，不牵动 --grad-* 本体。描边族（border/outline）属 T04468 的装饰 tint 口径，
// 本单不抢它的裁决，只把当前事实冻结进基线表（只降不升）。
//
// 七条腿：
//   A 取证（改前实况，永久留在仓库说明为什么要改）：26 处按原始表达式逐主题实算；
//   B 普查复算锁：全桌面字面色前景 × 所在面逐主题实算，文本族必须 0 未达标（新增字面文本前景即红）；
//   B2 配对 token 实算：已修落点按 token 表达式逐主题实算必须达 AA（前景接了 token 但取值错也拦得住）；
//   C 成对/接入锁：每个落点同条规则里 -fg 与 -bg 成对出现，且不再含字面文本前景；
//   D 取值定调锁：逐主题登记新 token 取值，新主题漏配即红；
//   E 扫描器口径锁（负控制，必须全绿）：var() fallback 位不计、装饰底不计、达标深底前景只计不误伤，
//     同时全形态字面色（hex/rgb/rgba/hsl/命名色/!important/单行规则）必数——扫描器被改哑即红；
//   F 基线（只降不升）：逐文件字面色前景计数 + 描边族未达标计数两张表，本单已修文件同步钉住。
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  ROOT,
  THRESHOLD,
  iterRules,
  listLiteralForegroundSites,
  loadAuxTheme,
  loadThemes,
  pageOf,
  resolve,
  ruleBodies,
  stripComments,
  styleText,
  worstRatio,
  type AuditFailure,
  type AuditRow,
} from './helpers/contrast';

/** 本单修复对象：文字/图标前景（描边族走 T04468 口径） */
const isTextProp = (prop: string) => /^(color|-webkit-text-fill-color)$/i.test(prop);

interface Site {
  label: string;
  file: string;
  selector: string;
  kind: 'text' | 'ui';
  /** 改前的原始表达式（取证腿用） */
  beforeFg: string;
  beforeBg: string;
  /** 改后取值来源：面配对家族（--on-<face>-fg/-bg）或具名 token（--x-readable） */
  face?: string;
  afterFg?: string;
  afterBg?: string;
  /** 该规则是主题作用域选择器，只在其自身主题下实算（拿它套 9 个主题会凭空造出假缺陷） */
  scoped?: string;
  why: string;
}

const PAGE = 'transparent';

const SITES: Site[] = [
  { label: '进度页·.head-status.is-running', file: 'src/views/Progress.vue', selector: '.head-status.is-running', kind: 'text', beforeFg: '#00f5ff', beforeBg: 'rgba(0, 245, 255, 0.1)', face: 'on-badge-cyan', why: '状态徽章文字 12px（文本 4.5）' },
  { label: '进度页·.head-status.is-success', file: 'src/views/Progress.vue', selector: '.head-status.is-success', kind: 'text', beforeFg: '#4ade80', beforeBg: 'rgba(74, 222, 128, 0.1)', face: 'on-badge-green', why: '同上' },
  { label: '进度页·.head-status.is-danger', file: 'src/views/Progress.vue', selector: '.head-status.is-danger', kind: 'text', beforeFg: '#f87171', beforeBg: 'rgba(248, 113, 113, 0.12)', face: 'on-badge-red', why: '同上' },
  { label: '生效标记·.effect-tag--instant', file: 'src/components/ConfigEffectTag.vue', selector: '.effect-tag--instant', kind: 'text', beforeFg: '#1d7a5f', beforeBg: 'rgba(29, 122, 95, 0.08)', face: 'on-badge-green', why: '生效标记文字 + currentColor 圆点' },
  { label: '生效标记·.effect-tag--reload', file: 'src/components/ConfigEffectTag.vue', selector: '.effect-tag--reload', kind: 'text', beforeFg: '#8a5a00', beforeBg: 'rgba(217, 154, 24, 0.1)', face: 'on-badge-amber', why: '同上' },
  { label: '生效标记·.effect-tag--restart', file: 'src/components/ConfigEffectTag.vue', selector: '.effect-tag--restart', kind: 'text', beforeFg: '#b3261e', beforeBg: 'rgba(179, 38, 30, 0.08)', face: 'on-badge-red', why: '同上' },
  { label: '配置页·.effect-legend-item--instant', file: 'src/views/Config.vue', selector: '.effect-legend-item--instant', kind: 'text', beforeFg: '#1d7a5f', beforeBg: 'rgba(29, 122, 95, 0.08)', face: 'on-badge-green', why: '与 ConfigEffectTag 同语义同族' },
  { label: '配置页·.effect-legend-item--reload', file: 'src/views/Config.vue', selector: '.effect-legend-item--reload', kind: 'text', beforeFg: '#8a5a00', beforeBg: 'rgba(217, 154, 24, 0.1)', face: 'on-badge-amber', why: '同上' },
  { label: '配置页·.effect-legend-item--restart', file: 'src/views/Config.vue', selector: '.effect-legend-item--restart', kind: 'text', beforeFg: '#b3261e', beforeBg: 'rgba(179, 38, 30, 0.08)', face: 'on-badge-red', why: '同上' },
  { label: '配置页·.unsaved-icon', file: 'src/views/Config.vue', selector: '.unsaved-icon', kind: 'text', beforeFg: '#8a5a00', beforeBg: 'rgba(217, 154, 24, 0.18)', face: 'on-disc-amber', why: '圆形图标底（alpha 0.18，比徽章 tint 亮一档）' },
  { label: '配置页·.pending-icon', file: 'src/views/Config.vue', selector: '.pending-icon', kind: 'text', beforeFg: '#d84c5a', beforeBg: 'rgba(220, 76, 90, 0.18)', face: 'on-disc-red', why: '同上' },
  { label: '配置页·.pending-item', file: 'src/views/Config.vue', selector: '.pending-item', kind: 'text', beforeFg: '#c0414e', beforeBg: PAGE, afterFg: 'var(--danger-readable)', afterBg: PAGE, why: '无自声明底，压卡片底（hover 才上红 tint）' },
  { label: '配置导航·.nav-item.is-active', file: 'src/components/ConfigSideNav.vue', selector: '.nav-item.is-active', kind: 'text', beforeFg: '#1554d1', beforeBg: 'rgba(0, 245, 255, 0.08)', face: 'on-badge-cyan', why: '选中态菜单文字（文本 4.5）' },
  { label: '配置导航·.nav-lock', file: 'src/components/ConfigSideNav.vue', selector: '.nav-lock', kind: 'text', beforeFg: '#8a5a00', beforeBg: 'rgba(217, 154, 24, 0.12)', face: 'on-badge-amber', why: '锁定徽章文字 10px（文本 4.5）' },
  { label: '会话侧栏·.delete-btn:hover', file: 'src/components/ConversationSidebar.vue', selector: '.delete-btn:hover', kind: 'text', beforeFg: '#3a0000', beforeBg: 'rgba(255, 80, 80, 0.3)', face: 'on-danger-hover', why: '删除图标（非文本按 3.0 也全线不达）' },
  { label: '会话侧栏·.new-btn', file: 'src/components/ConversationSidebar.vue', selector: '.new-btn', kind: 'text', beforeFg: '#04121a', beforeBg: 'var(--neon-cyan, #00f5ff)', face: 'on-accent-solid', why: '主操作按钮文字（实心主色面随主题换色相）' },
  { label: '三态块·[role=alert] .state-title', file: 'src/components/StateBlock.vue', selector: ".state-block[role='alert'] .state-title", kind: 'text', beforeFg: '#f87171', beforeBg: PAGE, afterFg: 'var(--danger-readable)', afterBg: PAGE, why: '失败态标题 14px（文本 4.5）' },
  { label: '本地备份·.note-warning', file: 'src/components/LocalDataBackupPanel.vue', selector: '.note-warning', kind: 'text', beforeFg: '#d97706', beforeBg: PAGE, afterFg: 'var(--warning-readable)', afterBg: PAGE, why: '警示说明文字（文本 4.5）' },
  { label: '改密框·.fc-error', file: 'src/components/ForceChangePassword.vue', selector: '.fc-error', kind: 'text', beforeFg: '#d03050', beforeBg: PAGE, afterFg: 'var(--danger-readable)', afterBg: PAGE, why: '错误提示 12px（文本 4.5）' },
  { label: '马卡龙·.el-tabs__item:hover', file: 'src/styles/themes/macaron.css', selector: '[data-theme="macaron"] .el-tabs__item:hover', kind: 'text', beforeFg: '#a8e0d8', beforeBg: PAGE, afterFg: 'var(--accent-readable)', afterBg: PAGE, scoped: 'macaron', why: '页签 hover 文字压宿主卡片底（.el-tabs__item 库默认无底）' },
  { label: '马卡龙·.el-tabs__item.is-active', file: 'src/styles/themes/macaron.css', selector: '[data-theme="macaron"] .el-tabs__item.is-active', kind: 'text', beforeFg: '#d4699b', beforeBg: PAGE, afterFg: 'var(--pink-readable)', afterBg: PAGE, scoped: 'macaron', why: '页签选中文字' },
  { label: '作品集·.el-tabs__item:hover', file: 'src/styles/themes/portfolio.css', selector: '[data-theme="portfolio"] .el-tabs__item:hover', kind: 'text', beforeFg: '#c9a961', beforeBg: PAGE, afterFg: 'var(--warning-readable)', afterBg: PAGE, scoped: 'portfolio', why: '金棕页签压白卡片 2.20' },
  { label: '电商·.el-tabs__item:hover', file: 'src/styles/themes/ecommerce.css', selector: '[data-theme="ecommerce"] .el-tabs__item:hover', kind: 'text', beforeFg: '#ff6b35', beforeBg: PAGE, afterFg: 'var(--warning-readable)', afterBg: PAGE, scoped: 'ecommerce', why: '亮橙页签压白卡片 2.84' },
  { label: '电商·.el-tabs__item.is-active', file: 'src/styles/themes/ecommerce.css', selector: '[data-theme="ecommerce"] .el-tabs__item.is-active', kind: 'text', beforeFg: '#ff6b35', beforeBg: PAGE, afterFg: 'var(--warning-readable)', afterBg: PAGE, scoped: 'ecommerce', why: '同上' },
  { label: '产品·.el-button:hover', file: 'src/styles/themes/product.css', selector: '[data-theme="product"] .el-button:not(.el-button--primary):not(.el-button--danger):not(.el-button--success):hover', kind: 'text', beforeFg: '#003322', beforeBg: 'rgba(0, 255, 136, 0.12)', afterFg: 'var(--accent-readable)', afterBg: 'rgba(0, 255, 136, 0.12)', scoped: 'product', why: '深底主题里 0.12 亮绿 tint 合成后仍是暗面，深墨只有 1.08' },
  { label: '商务浅·占位符', file: 'src/styles/themes/light-business.css', selector: '[data-theme="light-business"] .el-input__inner::placeholder', kind: 'text', beforeFg: '#9aa0a6', beforeBg: '#ffffff', afterFg: '#6b7280', afterBg: '#ffffff', scoped: 'light-business', why: '占位符按文本口径计（WCAG 1.4.3），本主题深一档灰达标即留字面' },
];

const ALL_THEMES = [...loadThemes(), loadAuxTheme('dark')];
const themesFor = (s: Site) => (s.scoped ? ALL_THEMES.filter((t) => t.name === s.scoped) : ALL_THEMES);
const afterFg = (s: Site) => s.afterFg ?? `var(--${s.face}-fg)`;
const afterBg = (s: Site) => s.afterBg ?? `var(--${s.face}-bg)`;
const row = (s: Site, fg: string, bg: string): AuditRow => ({ label: `${s.label}｜${fg} × ${bg}`, fg, bg, kind: s.kind });

const src = (f: string) => readFileSync(join(ROOT, f), 'utf8');
/** styleText() 只认 <style> 块：.vue 直接给原文，.css 要包一层，否则 ruleBodies 对主题文件恒返回空（曾据此误判「接入锁失败」） */
const styleSrc = (f: string) => (f.endsWith('.vue') ? src(f) : `<style>${src(f)}</style>`);

/* ---------------------------------------------------------------- 普查口径（腿 B 用） */

const walk = (dir: string, out: string[] = []): string[] => {
  for (const d of readdirSync(join(ROOT, dir), { withFileTypes: true })) {
    const rel = `${dir}/${d.name}`;
    if (d.isDirectory()) walk(rel, out);
    else if (/\.(vue|css)$/.test(rel)) out.push(rel);
  }
  return out;
};
/** 范围按工单：桌面 .vue + src/style.css + src/styles/**；移动端皮肤属 T04467 的独立色板口径 */
const FILES = [...new Set([...walk('src'), 'src/style.css'])].filter((f) => !f.startsWith('src/components/mobile/'));

const clean = (v: string) => v.replace(/!important/i, '').trim().replace(/\s+/g, ' ');

/**
 * Element-Plus 控件的库自带底（实测取自 node_modules/element-plus/theme-chalk/*.css，不是推测）：
 *   .el-button / .el-input / .el-dialog / .el-message / .el-upload-dragger 等 → 白（--el-fill-color-blank / --el-bg-color）
 *   .el-tabs__item → 没有 background，压的是宿主卡片底 —— 按库默认判白会凭空造出「霓虹绿压白底 1.34」这类假缺陷。
 */
const EL_SOLID_WHITE = /\.el-(button|input|textarea|dialog|message|tree|select|cascader|upload-dragger|popover|drawer|card|table|dropdown|alert)/;

/** 同文件内同一控件的其它规则给的底（Element 控件按主类名找） */
function siblingBg(fileText: string, sel: string): string | null {
  const bare = sel.replace(/\[data-theme[^\]]*\]/g, '').replace(/@[\w-]+\s*\([^)]*\)\s*▸/g, '').trim();
  const cls = /\.el-[\w-]+|\.[\w-]+/.exec(bare);
  if (!cls) return null;
  for (const r of iterRules(stripComments(styleText(fileText.endsWith('.vue') ? `<style>${fileText}</style>` : fileText)))) {
    if (!r.sel.includes(cls[0])) continue;
    const m = /(?:^|;)\s*(?:background|background-image|background-color)\s*:\s*([^;]+)/i.exec(r.body);
    if (!m) continue;
    const v = clean(m[1]);
    if (v === 'none' || v === 'transparent') continue;
    return v;
  }
  return null;
}

/** 所在面解析顺序：同条规则 → 同文件同控件 → 库默认白 → 宿主卡片底（继承页底） */
function faceOfSite(fileText: string, sel: string, ownBg: string | null): string {
  const own = ownBg ? clean(ownBg) : '';
  if (own && own !== 'none' && own !== 'transparent') return own;
  const sib = siblingBg(fileText, sel);
  if (sib) return sib;
  if (EL_SOLID_WHITE.test(sel)) return '#ffffff';
  return PAGE;
}

interface CensusRow extends AuditFailure {
  file: string;
  sel: string;
  prop: string;
  literal: string;
  face: string;
}

function census(): { hits: number; textFail: CensusRow[]; strokeFail: CensusRow[]; unparsable: string[] } {
  const byName = new Map(ALL_THEMES.map((t) => [t.name, t]));
  const textFail: CensusRow[] = [];
  const strokeFail: CensusRow[] = [];
  const unparsable: string[] = [];
  let hits = 0;
  for (const f of FILES) {
    const text = readFileSync(join(ROOT, f), 'utf8');
    for (const s of listLiteralForegroundSites(f.endsWith('.vue') ? text : `<style>${text}</style>`)) {
      hits++;
      const face = faceOfSite(text, s.sel, s.ownBg);
      const kind = isTextProp(s.prop) ? 'text' : 'ui';
      // 主题作用域门控：选择器限定 [data-theme="x"] 时只审计 x
      const names = s.themeScoped && byName.has(s.themeScoped) ? [s.themeScoped] : ALL_THEMES.map((t) => t.name);
      for (const name of names.length ? names : []) {
        const t = byName.get(name)!;
        let r: number;
        try {
          resolve(s.literal, t.decls);
          r = worstRatio(s.literal, face, t.decls, pageOf(t.decls));
        } catch (e) {
          unparsable.push(`${f} :: ${s.sel} | ${s.prop}: ${s.value.slice(0, 40)} | ${(e as Error).message.slice(0, 50)}`);
          continue;
        }
        if (r >= THRESHOLD[kind]) continue;
        const rec = { theme: name, label: `${f} :: ${s.sel}`, ratio: r, threshold: THRESHOLD[kind], file: f, sel: s.sel, prop: s.prop, literal: s.literal, face };
        (kind === 'text' ? textFail : strokeFail).push(rec);
      }
    }
  }
  return { hits, textFail, strokeFail, unparsable };
}

/* ---------------------------------------------------------------- 定调表（腿 D 用） */

/** 逐主题登记本单新面的字面取值；某主题缺项 = 该主题沿用 :root 的取值（D1 会去核实确实是继承值） */
const FACE_TOKENS = ['--on-badge-amber-fg', '--on-badge-green-fg', '--on-badge-red-fg', '--on-badge-cyan-fg', '--on-disc-amber-fg', '--on-disc-red-fg', '--on-danger-hover-fg', '--on-accent-solid-fg', '--on-accent-solid-bg', '--danger-readable'] as const;
const FACE_VALUES: Record<string, Record<string, string>> = {
  'default(:root)': {
    '--on-badge-amber-fg': 'var(--warning-readable)',
    '--on-badge-green-fg': '#4ade80',
    '--on-badge-red-fg': '#f87171',
    '--on-badge-cyan-fg': 'var(--accent-readable)',
    '--on-disc-amber-fg': 'var(--text-bright)',
    '--on-disc-red-fg': 'var(--text-bright)',
    '--on-danger-hover-fg': '#ffdcd6',
    '--on-accent-solid-fg': '#04121a',
    '--on-accent-solid-bg': 'var(--neon-cyan, #00f5ff)',
    '--danger-readable': '#ff8a80',
  },
  ecommerce: {
    '--on-badge-green-fg': '#15803d',
    '--on-badge-red-fg': '#b52e2e',
    '--on-danger-hover-fg': '#3a0000',
    '--danger-readable': '#b52e2e',
  },
  enterprise: {
    '--on-badge-green-fg': '#12693b',
    '--on-badge-red-fg': '#b52e2e',
    '--on-danger-hover-fg': '#3a0000',
    '--danger-readable': '#b52e2e',
  },
  'light-business': {
    '--on-badge-green-fg': '#15803d',
    '--on-badge-red-fg': '#b3261e',
    '--on-danger-hover-fg': '#3a0000',
    '--on-accent-solid-fg': '#ffffff',
    '--danger-readable': '#b3261e',
  },
  macaron: {
    '--on-badge-green-fg': '#2f6f4f',
    '--on-badge-red-fg': '#a83a3a',
    '--on-danger-hover-fg': '#3a0000',
    '--danger-readable': '#a83a3a',
  },
  portfolio: {
    '--on-badge-green-fg': '#2f5f3f',
    '--on-badge-red-fg': '#8c1d1d',
    '--on-danger-hover-fg': '#3a0000',
    '--on-accent-solid-fg': '#ffffff',
    // 本主题实心主色 #8b7355 是中调：白字 4.49 / 深墨 4.23，两头都不达 AA → 这一面单独压深（不动 --neon-cyan 本体）
    '--on-accent-solid-bg': '#6d5a42',
    '--danger-readable': '#8c1d1d',
  },
  product: {},
  creative: {},
  // tokens.css 的辅助暗色主题：主蓝 #4d8dff 压在青 tint 上只有 4.31，前景取同色相提亮版
  'dark(tokens.css)': { '--on-badge-cyan-fg': '#9dc0ff' },
};

/**
 * 重普查基线（本单收口时实测，不复用 T04472 的硬白字计数——两张表口径不同）。
 * LITERAL_FG_BASELINE：逐文件「字面色前景命中处数」只降不升；
 * STROKE_FAIL_BASELINE：逐文件「描边族未达标 × 主题条目数」冻结给 T04468 当起点（本单不修，只看不放）。
 */
const LITERAL_FG_BASELINE: Record<string, number> = {
  'src/style.css': 13,
  'src/styles/themes/light-business.css': 22,
  'src/styles/themes/enterprise.css': 8,
  'src/styles/themes/product.css': 8,
  'src/styles/themes/portfolio.css': 7,
  'src/styles/themes/ecommerce.css': 6,
  'src/styles/themes/macaron.css': 6,
  'src/views/Config.vue': 6,
  'src/components/ConfigEffectTag.vue': 3,
  'src/components/ConfigSideNav.vue': 2,
  'src/views/Tunnel.vue': 2,
  'src/components/HealthIssueList.vue': 1,
  'src/components/LocalDataBackupPanel.vue': 1,
  'src/views/Ingest.vue': 1,
  'src/views/Progress.vue': 1,
};
const STROKE_FAIL_BASELINE: Record<string, number> = {
  'src/style.css': 12,
  'src/views/Config.vue': 6,
  'src/styles/themes/macaron.css': 5,
  'src/styles/themes/ecommerce.css': 5,
  'src/styles/themes/portfolio.css': 5,
  'src/styles/themes/light-business.css': 4,
  'src/styles/themes/product.css': 4,
  'src/components/ConfigEffectTag.vue': 3,
  'src/styles/themes/enterprise.css': 3,
  'src/views/Tunnel.vue': 2,
  'src/components/ConfigSideNav.vue': 2,
  'src/components/LocalDataBackupPanel.vue': 1,
  'src/views/Progress.vue': 1,
  'src/components/HealthIssueList.vue': 1,
};
/**
 * 移动端皮肤（src/components/mobile/**）另有 T04467 的独立色板口径：本单普查不含它、也不替它判达标，
 * 只**冻结处数**（只降不升）——「暂不处理」不等于「不看」，否则排除目录会变成第二套无人认领的字面色前景。
 */
const MOBILE_BASELINE: Record<string, number> = {
  'src/components/mobile/MobileListen.vue': 9,
  'src/components/mobile/MobileLogin.vue': 16,
  'src/components/mobile/MobileMe.vue': 4,
  'src/components/mobile/MobileQuery.vue': 5,
  'src/components/mobile/MobileIngest.vue': 3,
  'src/components/mobile/MobileBrowse.vue': 1,
};

describe('T04509 · 取证：改前的字面色前景压主题决定面', () => {
  it(`A · ${SITES.length} 处按原始表达式逐主题实算：存在 ≤1.30 的「文字不可见」面，且未达标条目 ≥ 60`, () => {
    const failures: AuditFailure[] = [];
    for (const s of SITES) failures.push(...audit(s, s.beforeFg, s.beforeBg));
    const worst = Math.min(...failures.map((f) => f.ratio));
    expect(failures.length, '26 处落点在各自适用主题下应全线掉档').toBeGreaterThanOrEqual(60);
    expect(worst, '存在前景与底色几乎同色（≤1.30）才证明这不是「余量差一点」的挑剔').toBeLessThanOrEqual(1.3);
  });

  it('A2 · 清单规模与源码对得上：26 个落点、8 个面家族 + 5 个具名前景 token，每条选择器都还能在文件里找到', () => {
    expect(SITES.length).toBe(26);
    // 面配对家族（--on-<面>-fg/-bg）与「直接接现成 readable token」两类落点，口径不同不能混数
    const faces = new Set(SITES.map((s) => s.face).filter((x): x is string => Boolean(x)));
    const named = new Set(SITES.filter((s) => !s.face).map((s) => s.afterFg as string));
    expect(faces.size, `面家族数量要与定调表对齐：${[...faces].join(' ')}`).toBe(8);
    expect(named.size, `具名前景 token：${[...named].join(' ')}`).toBe(5);
    // 每个面家族都要在定调表里有自己的前景 token（否则落点接的是不存在的面）
    for (const f of faces) expect(FACE_TOKENS, `面 --${f}-fg 未登记进定调表`).toContain(`--${f}-fg`);
    for (const s of SITES) {
      expect(ruleBodies(styleSrc(s.file), s.selector).length, `${s.file} 找不到选择器 ${s.selector}`).toBeGreaterThan(0);
    }
  });
});

function audit(s: Site, fg: string, bg: string): AuditFailure[] {
  const failures: AuditFailure[] = [];
  for (const t of themesFor(s)) {
    const r = worstRatio(fg, bg, t.decls, pageOf(t.decls));
    if (r < THRESHOLD[s.kind]) failures.push({ theme: t.name, label: `${s.label}｜${fg} × ${bg}`, ratio: r, threshold: THRESHOLD[s.kind] });
  }
  return failures;
}

describe('T04509 · 普查复算锁：字面色前景 × 所在面逐主题实算', () => {
  const c = census();
  const msg = (rows: CensusRow[]) => rows.map((r) => `${r.file} :: ${r.sel} | ${r.prop}: ${r.literal} × 面=${r.face} | ${r.theme}=${r.ratio.toFixed(2)}`).join('\n  ');

  it('B · 文本族字面色前景 0 未达标（新写一处字面文本前景而它不达标即红）', () => {
    expect(c.unparsable, `普查口径不该出现「不可解析」（有则说明扫描器遇到口径外表达式会静默漏判）:\n  ${c.unparsable.join('\n  ')}`).toEqual([]);
    expect(c.textFail, `文本族仍有未达标 ${c.textFail.length} 条:\n  ${msg(c.textFail)}`).toEqual([]);
  });

  it('B2 · 已修落点按 token 表达式逐主题实算达 AA（取值接错也拦得住）', () => {
    const failures: AuditFailure[] = [];
    for (const s of SITES) failures.push(...audit(s, afterFg(s), afterBg(s)));
    expect(failures, failures.map((f) => `${f.theme} · ${f.label} = ${f.ratio.toFixed(2)}（需 ≥ ${f.threshold}）`).join('\n  ')).toEqual([]);
  });

  it('B3 · 描边族未达标的**落点数**停在基线（T04468 口径未定，本单不修，但要看得住它不涨）', () => {
    // 基线按「落点」计数（与普查输出一张表），不是「落点 × 主题」——后者会让一个落点在 9 个主题下报 9 次，
    // 基线数字失去意义，主题增删还会自动改动条数（锁会变成随主题数漂移的假锁）。
    const perFile = new Map<string, number>();
    for (const key of new Set(c.strokeFail.map((r) => `${r.file} :: ${r.sel} :: ${r.prop} :: ${r.literal}`))) {
      const f = key.split(' :: ')[0];
      perFile.set(f, (perFile.get(f) ?? 0) + 1);
    }
    for (const [f, n] of Object.entries(STROKE_FAIL_BASELINE)) {
      expect(perFile.get(f) ?? 0, `${f} 描边族未达标条目应从基线 ${n} 只降不升`).toBeLessThanOrEqual(n);
    }
    for (const [f, n] of perFile) {
      if (!(f in STROKE_FAIL_BASELINE)) expect(n, `基线外文件 ${f} 出现描边族未达标 ${n} 条（要先登记进本单定调表再谈新增）`).toBe(0);
    }
  });
});

describe('T04509 · 成对/接入锁', () => {
  for (const s of SITES) {
    if (s.face) {
      it(`${s.label}：同一条规则里同时取 --${s.face}-bg 与 --${s.face}-fg，且前景无字面色`, () => {
        const bodies = ruleBodies(styleSrc(s.file), s.selector);
        const paired = bodies.find((b) => b.includes(`var(--${s.face}-bg)`) && b.includes(`var(--${s.face}-fg)`));
        expect(paired, `${s.file} 的 ${s.selector} 没有把 --${s.face}-bg / -fg 写在同一条规则里（半接入：只换前景、底色还留原字面 tint）`).toBeTruthy();
        for (const fg of bareForegrounds(paired as string)) {
          expect(fg, `${s.label} 的前景仍含字面色：${fg}（判定依据：${s.why}）`).not.toMatch(LITERAL_IN_VALUE);
        }
      });
    } else {
      it(`${s.label}：前景改由 ${s.afterFg} 供给后，该规则不再含字面文本前景`, () => {
        const bodies = ruleBodies(styleSrc(s.file), s.selector);
        const hit = bodies.find((b) => new RegExp(`color:\\s*${s.afterFg!.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}`).test(b));
        expect(hit, `${s.file} 的 ${s.selector} 没有接入 ${s.afterFg}；实测规则体：${JSON.stringify(bodies)}`).toBeTruthy();
        for (const fg of bareForegrounds(hit as string)) {
          // 唯一合法的例外：本主题深一档灰的占位符（字面量但实算达标，见 SITES.why）
          if (fg.trim() === s.afterFg!.trim()) continue;
          expect(fg, `${s.label} 的前景仍含字面色：${fg}`).not.toMatch(LITERAL_IN_VALUE);
        }
      });
    }
  }
});

const LITERAL_IN_VALUE = /#[0-9a-fA-F]{3,8}\b|\brgba?\s*\(|\bhsla?\s*\(|\b(?:white|black)\b/;
/** 只取「前景声明」里 var() 之外的部分：token fallback 位允许留字面值（T04472 口径） */
function bareForegrounds(ruleBody: string): string[] {
  return ruleBody
    .split(';')
    .filter((seg) => /^[ \t]*(?:color|-webkit-text-fill-color)[ \t]*:/i.test(seg))
    .map((seg) => seg.replace(/^[ \t]*(?:color|-webkit-text-fill-color)[ \t]*:/i, ''))
    .map((v) => v.replace(/var\((?:[^()]|\([^()]*\))*\)/g, '').trim())
    .filter((v) => v.length > 0);
}

describe('T04509 · 取值定调锁', () => {
  it('D1 · 逐主题的本单 token 取值与定调一致（未登记的主题必须真的是继承 :root，而不是被别处改写）', () => {
    const root = FACE_VALUES['default(:root)'];
    for (const t of ALL_THEMES) {
      const want = FACE_VALUES[t.name];
      expect(want, `主题 ${t.name} 不在定调表里（新主题要按本单口径登记取值）`).toBeTruthy();
      for (const token of FACE_TOKENS) {
        const expected = want?.[token] ?? root[token];
        expect(expected, `定调表 :root 行漏登记 ${token}`).toBeTruthy();
        expect(t.decls.get(token), `${t.name} · ${token} 的取值与本单定调不一致`).toBe(expected);
      }
    }
  });

  it('D2 · 半透明 tint 面底只此一份取值（前景逐主题覆盖，底不许被某主题另起一套 alpha）', () => {
    const root = ALL_THEMES[0];
    for (const t of ALL_THEMES.slice(1)) {
      for (const bg of ['--on-badge-amber-bg', '--on-badge-green-bg', '--on-badge-red-bg', '--on-badge-cyan-bg', '--on-disc-amber-bg', '--on-disc-red-bg', '--on-danger-hover-bg']) {
        expect(t.decls.get(bg), `${t.name} 覆盖了 ${bg}（同一语义面的 alpha 只该有一份，否则前景逐主题实算的定调失效）`).toBe(root.decls.get(bg));
      }
    }
    // 唯一的例外是实心主色面：它的底随主题换色相，遇到中调色（两头都不达 AA）必须压深——
    // 但只有定调表里登了值的主题可以压，防止「谁看着不顺就压一刀」。
    const pressed = ALL_THEMES.filter((t) => t.decls.get('--on-accent-solid-bg') !== root.decls.get('--on-accent-solid-bg'));
    expect(pressed.map((t) => t.name), `压深实心面的主题要与定调表一致：${pressed.map((t) => t.name).join(' ')}`).toEqual(['portfolio']);
  });
});

describe('T04509 · 扫描器口径（负控制：既不漏判也不误伤）', () => {
  it('E1 · var() 的 fallback 位不计 / 装饰底不计 / 纯深底只计不误伤 —— 三条负控制全绿', () => {
    // ① fallback 位：token 兜底里的字面色不是「前景写死」
    const fallback = ['<style>', '.a { color: var(--text-primary, #f3e9ff); border-color: var(--b, rgba(255,255,255,.4)); }', '</style>'].join('\n');
    expect(listLiteralForegroundSites(fallback), 'var() 的 fallback 位不该算字面色前景').toEqual([]);
    // ② 装饰底：background / gradient 里的色是填充，不是前景
    const deco = ['<style>', '.b { background: linear-gradient(135deg, #fff, #000); background-color: rgba(0, 245, 255, 0.1); }', '</style>'].join('\n');
    expect(listLiteralForegroundSites(deco), '装饰底不该算前景').toEqual([]);
    // ③ 纯深底：深面上的亮字面量会被命中，但普查判定是「达标」——不因此把它从命中集里剔掉（内置豁免会静默放过新主题）
    const deep = ['<style>', '.c { color: #f3e9ff; background: rgba(18, 12, 32, 0.96); }', '</style>'].join('\n');
    expect(listLiteralForegroundSites(deep).length, '深底上的亮字面量要命中（达标与否由逐主题实算决定）').toBe(1);
    expect(census().textFail.filter((r) => r.literal === '#f3e9ff'), '该面实算本就达标，不该出现在未达标清单').toEqual([]);
  });

  it('E2 · 全形态字面色必数：hex/缩写hex/rgb/rgba/hsl/命名色/!important/单行规则 —— 扫描器被改哑即红', () => {
    const fixture = [
      '<style scoped>',
      '.s1 { color: #00f5ff; }',
      '.s2 { color: #fff; }',
      '.s3 { color: rgb(0, 245, 255); }',
      '.s4 { color: rgba(0, 245, 255, 0.8); }',
      '.s5 { color: hsl(180 100% 50%); }',
      '.s6 { color: white; }',
      '.s7 { color: #4ade80 !important; }',
      '.s8 { border-color: #f87171; }',
      '.s9 { -webkit-text-fill-color: rgba(255, 255, 255, 0.42); }',
      '</style>',
    ].join('\n');
    const sites = listLiteralForegroundSites(fixture);
    expect(sites.map((s) => s.sel).sort(), `应数到 9 处，实测 ${sites.length}：${sites.map((s) => s.sel).join(' | ')}`).toEqual(['.s1', '.s2', '.s3', '.s4', '.s5', '.s6', '.s7', '.s8', '.s9']);
    // 每处取到的是「完整色 token」，不是 rgba( 这种前缀——前缀会让 resolve() 抛错、矩阵整列失真
    expect(sites.find((s) => s.sel === '.s4')?.literal).toBe('rgba(0, 245, 255, 0.8)');
    expect(sites.find((s) => s.sel === '.s7')?.literal, '!important 不该粘进 token').toBe('#4ade80');
  });

  it('E3 · 保留的字面文本前景站点实算达标（Ingest .bookmarklet 与 light-business 深档灰，属合法存量）', () => {
    for (const t of ALL_THEMES) {
      const ingest = worstRatio('#fff', 'var(--color-primary, #0f4c81)', t.decls, pageOf(t.decls));
      expect(ingest, `Ingest .bookmarklet 在 ${t.name} 只剩 ${ingest.toFixed(2)}`).toBeGreaterThanOrEqual(THRESHOLD.text);
      // 占位符是「单主题作用域里留下的字面量」：只在本主题下实算，换主题不该拿它去套
      const ph = worstRatio('#6b7280', '#ffffff', t.decls, pageOf(t.decls));
      expect(ph, `light-business 占位符深档灰在 ${t.name} 只剩 ${ph.toFixed(2)}`).toBeGreaterThanOrEqual(THRESHOLD.text);
    }
    expect(census().textFail, '普查里仍有未达标的字面文本前景').toEqual([]);
  });
});

/**
 * 主题文件里**合法留存**的字面文本前景（`prop: literal << selector`）。
 * 准入条件两条，缺一不可：① 选择器带 `[data-theme="x"]`（只在自身主题生效，不会漂移）；
 * ② 逐主题实算达 AA（由 leg B 强制，不达标即红）。
 * 主题调色板本来就该按主题写色值，泛化扫描器不是要把它清空，而是要它**别留下没人算过的落点**——
 * 所以这里是一张有名有姓的清单：新增字面文本前景要么进本表（并保证达标），要么接 token。
 */
const THEME_LITERAL_TEXT_OK: Record<string, string[]> = {
  'src/styles/themes/ecommerce.css': ['color: #5a1a05 << [data-theme="ecommerce"] .el-button:not(.el-button--primary):not(.el-button--danger):not(.el-button--success):hover'],
  'src/styles/themes/enterprise.css': [
    'color: #0c1d4a << [data-theme="enterprise"] .el-button:not(.el-button--primary):not(.el-button--danger):not(.el-button--success):hover',
    'color: #2563eb << [data-theme="enterprise"] .el-tabs__item:hover',
    'color: #2563eb << [data-theme="enterprise"] .el-tabs__item.is-active',
  ],
  'src/styles/themes/light-business.css': [
    'color: #111111 << [data-theme="light-business"] .grad-text',
    '-webkit-text-fill-color: #111111 << [data-theme="light-business"] .grad-text',
    'color: #2b2b2b << [data-theme="light-business"] .el-button:not(.el-button--primary):not(.el-button--danger):not(.el-button--success)',
    'color: #1554d1 << [data-theme="light-business"] .el-button:not(.el-button--primary):not(.el-button--danger):not(.el-button--success):hover',
    'color: #111111 << [data-theme="light-business"] .el-input__wrapper, [data-theme="light-business"] .el-textarea__inner',
    'color: #111111 << [data-theme="light-business"] .el-input__inner',
    'color: #6b7280 << [data-theme="light-business"] .el-input__inner::placeholder',
    'color: #5a5f66 << [data-theme="light-business"] .el-tabs__item',
    'color: #1554d1 << [data-theme="light-business"] .el-tabs__item:hover',
    'color: #1554d1 << [data-theme="light-business"] .el-tabs__item.is-active',
    'color: #2b2b2b << [data-theme="light-business"] .el-tree',
    'color: #111111 << [data-theme="light-business"] .el-dialog__title',
    'color: #2b2b2b << [data-theme="light-business"] .el-dialog__body',
    'color: #111111 << [data-theme="light-business"] .el-message',
    'color: #111111 << [data-theme="light-business"] ::selection',
  ],
  'src/styles/themes/macaron.css': ['color: #831d52 << [data-theme="macaron"] .el-button:not(.el-button--primary):not(.el-button--danger):not(.el-button--success):hover'],
  'src/styles/themes/portfolio.css': [
    'color: #3a2d0a << [data-theme="portfolio"] .el-button:not(.el-button--primary):not(.el-button--danger):not(.el-button--success):hover',
    'color: #1a1a1a << [data-theme="portfolio"] .el-tabs__item.is-active',
  ],
  'src/styles/themes/product.css': [
    'color: #000 << [data-theme="product"] .el-button--primary',
    'color: #00ff88 << [data-theme="product"] .el-tabs__item:hover',
    'color: #ff0080 << [data-theme="product"] .el-tabs__item.is-active',
  ],
};

describe('T04509 · 重普查基线（只降不升）', () => {
  it('F1 · 逐文件字面色前景处数停在基线，本单已修文件不留字面文本前景', () => {
    const seen = new Set<string>();
    for (const [f, n] of Object.entries(LITERAL_FG_BASELINE)) {
      seen.add(f);
      const hits = countLiteralFg(f);
      expect(hits, `${f} 字面色前景应从基线 ${n} 只降不升，实测 ${hits}`).toBeLessThanOrEqual(n);
    }
    const all = [...FILES];
    for (const f of all) {
      if (seen.has(f)) continue;
      if (f.startsWith('src/components/mobile/')) continue;
      expect(countLiteralFg(f), `${f} 出现了基线外的字面色前景`).toBe(0);
    }
    // 已修的桌面组件/页面里不许再留「字面文本前景」（描边族按 T04468 口径留在基线里）；
    // 主题文件允许留字面量，但必须逐条在 THEME_LITERAL_TEXT_OK 里登记（并由 leg B 保证实算达标）。
    for (const f of [...new Set(SITES.map((s) => s.file))]) {
      const leftovers = listLiteralForegroundSites(styleSrc(f)).filter((s) => isTextProp(s.prop));
      const keys = leftovers.map((s) => `${s.prop}: ${s.literal} << ${s.sel}`);
      if (f.startsWith('src/styles/themes/')) {
        const allowed = THEME_LITERAL_TEXT_OK[f] ?? [];
        for (const k of keys) expect(allowed, `${f} 冒出未登记的字面文本前景：${k}（要么接 token，要么进白名单表并实算达标）`).toContain(k);
        // 反向也要成立：白名单里不许留已经消失的条目，否则「改好了」会被过期豁免掩盖（与 F2 同一纪律）
        for (const k of allowed) expect(keys, `${f} 的白名单条目已不存在，要同步删除：${k}`).toContain(k);
        continue;
      }
      expect(keys, `${f} 已修文件仍有字面文本前景（要留必须先进 SITES/基线并实算达标）`).toEqual([]);
    }
  });

  it('F2 · 基线表不许留着已消失的口径（文件不在了要同步删，防止「修完了」被过期基线掩盖）', () => {
    const mobile = walk('src').filter((f) => f.startsWith('src/components/mobile/'));
    for (const f of Object.keys(LITERAL_FG_BASELINE)) expect(FILES, `${f} 已不存在，基线表要同步删除`).toContain(f);
    for (const f of Object.keys(MOBILE_BASELINE)) expect(mobile, `${f} 已不存在，移动端基线要同步删除`).toContain(f);
    // 移动端新文件默认基线 0：要加字面色前景必须先按 T04467 口径进表
    for (const f of mobile) {
      const n = MOBILE_BASELINE[f] ?? 0;
      expect(countLiteralFg(f), `${f} 移动端字面色前景处数应从基线 ${n} 只降不升`).toBeLessThanOrEqual(n);
    }
  });
});

function countLiteralFg(f: string): number {
  const text = readFileSync(join(ROOT, f), 'utf8');
  return listLiteralForegroundSites(f.endsWith('.vue') ? text : `<style>${text}</style>`).length;
}
