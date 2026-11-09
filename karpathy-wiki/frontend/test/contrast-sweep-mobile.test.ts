// T04467：*-readable 口径推广到移动端独立皮肤。
// 移动端不是桌面 aurora 的子集：glass（:root 的 --m-*）、light（.theme-light 覆盖块）、
// light+桌面 dark（html[data-theme="dark"] 再覆盖）是三套实际生效取值，必须逐套实算。
// 口径：AA 正文 4.5:1；1.4.11 非文本状态图形 3:1。不按字号放宽（移动端正文 15px / 提示 12px
// 都按正常字号 4.5 审，仅“大字”才可 3:1，本页没有 >=18.66px 粗体或 >=24px 正文的放行项）。
import { describe, expect, it } from 'vitest';
import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import {
  ROOT,
  THRESHOLD,
  loadThemes,
  mobileSurfaces,
  worstRatio,
  resolve,
  composite,
  contrast,
  parseRootDecls,
  styleText,
  stripComments,
  iterRules,
  listLiteralForegroundSites,
  type AuditFailure,
  type AuditRow,
  type RGB,
  type ThemeTokens,
} from './helpers/contrast';

const MOBILE_DIR = join(ROOT, 'src/components/mobile');
const MOBILE_FILES = readdirSync(MOBILE_DIR).filter((f) => f.endsWith('.vue')).sort();
/** MobileLogin 是独立常暗页（深色渐变+深色卡片），不消费 glass/light 皮肤，单独一套面口径审计 */
const THEMED_PAGES = MOBILE_FILES.filter((f) => f !== 'MobileLogin.vue');

const themes = loadThemes({ mobileSkins: true }).filter((t) => t.name.startsWith('mobile-'));

type Stage = 'void' | 'page' | 'surface';
interface MobileRow extends AuditRow {
  /** bg 表达式合成前的底层：--m-bg→void、--m-surface→page、fill/tint→surface */
  over?: Stage;
}

function baseOf(decls: Map<string, string>, stage: Stage): RGB {
  const s = mobileSurfaces(decls);
  if (stage === 'void') {
    const v = resolve('var(--bg-void)', decls);
    if ('stops' in v) throw new Error('--bg-void 不应是渐变');
    return v.solid;
  }
  return stage === 'page' ? s.page : s.surface;
}

function auditMobile(rows: MobileRow[]): AuditFailure[] {
  const failures: AuditFailure[] = [];
  for (const t of themes) {
    for (const row of rows) {
      const ratio = worstRatio(row.fg, row.bg, t.decls, baseOf(t.decls, row.over ?? 'surface'));
      if (ratio < THRESHOLD[row.kind]) {
        failures.push({ theme: t.name, label: row.label, ratio, threshold: THRESHOLD[row.kind] });
      }
    }
  }
  return failures;
}

const fmt = (rows: AuditFailure[]) =>
  rows.map((f) => `${f.theme} · ${f.label} = ${f.ratio.toFixed(2)}（需 ≥ ${f.threshold}）`).join('\n  ');

/** 皮肤变量本身的语义配对：组件都按这些 token 消费，token 自身不达标时下面的逐页扫描只会重复报错 */
const TOKEN_ROWS: MobileRow[] = [
  { label: '正文 / 页面底', fg: 'var(--m-text)', bg: 'var(--m-bg)', over: 'void', kind: 'text' },
  { label: '正文 / 卡片面', fg: 'var(--m-text)', bg: 'var(--m-surface)', over: 'page', kind: 'text' },
  { label: '次文本 / 卡片面', fg: 'var(--m-text-2)', bg: 'var(--m-surface)', over: 'page', kind: 'text' },
  { label: '次文本 / 填充面', fg: 'var(--m-text-2)', bg: 'var(--m-fill)', over: 'surface', kind: 'text' },
  { label: '三级文本 / 卡片面', fg: 'var(--m-text-3)', bg: 'var(--m-surface)', over: 'page', kind: 'text' },
  { label: '三级文本 / 填充面', fg: 'var(--m-text-3)', bg: 'var(--m-fill)', over: 'surface', kind: 'text' },
  { label: '弱化文本 / 卡片面', fg: 'var(--m-muted)', bg: 'var(--m-surface)', over: 'page', kind: 'text' },
  { label: '弱化文本 / 填充面', fg: 'var(--m-muted)', bg: 'var(--m-fill)', over: 'surface', kind: 'text' },
  { label: '主色文字 / 卡片面', fg: 'var(--m-primary)', bg: 'var(--m-surface)', over: 'page', kind: 'text' },
  { label: '主色文字 / 主色 tint', fg: 'var(--m-primary)', bg: 'var(--m-primary-soft)', over: 'surface', kind: 'text' },
  { label: '危险文字 / 卡片面', fg: 'var(--m-danger)', bg: 'var(--m-surface)', over: 'page', kind: 'text' },
  { label: '危险文字 / 危险 tint', fg: 'var(--m-danger)', bg: 'var(--m-danger-soft)', over: 'surface', kind: 'text' },
  { label: '警告文字 / 卡片面', fg: 'var(--m-warning-fg)', bg: 'var(--m-surface)', over: 'page', kind: 'text' },
  { label: '警告文字 / 警告 tint', fg: 'var(--m-warning-fg)', bg: 'var(--m-warning-soft)', over: 'surface', kind: 'text' },
  { label: '行内代码 / 填充面', fg: 'var(--m-code-fg)', bg: 'var(--m-fill)', over: 'surface', kind: 'text' },
  { label: '主按钮文字 / 主色底', fg: 'var(--m-on-primary)', bg: 'var(--m-primary)', over: 'page', kind: 'text' },
  { label: '主按钮文字 / 主色按压底', fg: 'var(--m-on-primary)', bg: 'var(--m-primary-press)', over: 'page', kind: 'text' },
  { label: '危险按钮文字 / 危险底', fg: 'var(--m-on-danger)', bg: 'var(--m-danger)', over: 'page', kind: 'text' },
];

describe('T04467 移动皮肤语义配对（glass / light / light-dark）', () => {
  it('三套皮肤全部达到 AA', () => {
    const failures = auditMobile(TOKEN_ROWS);
    expect(failures, `未达标：\n  ${fmt(failures)}`).toEqual([]);
  });

  it('关键 token 在三套皮肤都有定义，且 border token 是纯色', () => {
    for (const t of themes) {
      for (const token of ['--m-on-primary', '--m-on-danger', '--m-code-fg', '--m-muted', '--m-warning-fg', '--m-primary-press']) {
        expect(t.decls.has(token), `${t.name} 缺少 ${token}`).toBe(true);
      }
      // 组件统一写 `border: 1px solid var(--m-border)`；token 若是整条简写，glass 下所有描边声明整条失效
      for (const token of ['--m-border', '--m-border-2']) {
        expect(t.decls.get(token), `${t.name} 缺少 ${token}`).toBeTruthy();
        expect(t.decls.get(token)).not.toMatch(/^\s*[\d.]+px\s+solid\b/);
      }
    }
  });
});

/** 从 `1px solid var(--x, rgba(...))` 里取出完整颜色表达式（按括号配平，避免被 fallback 里的 `)` 截断） */
function firstColorExpr(value: string): string | null {
  for (let i = 0; i < value.length; i++) {
    const rest = value.slice(i);
    if (i > 0 && /[\w-]/.test(value[i - 1])) continue;
    const hex = /^#[0-9a-f]{3,8}\b/i.exec(rest);
    if (hex) return hex[0];
    if (/^(?:rgb|hsl)a?\s*\(/i.test(rest) || /^var\(/.test(rest)) {
      let depth = 0;
      for (let j = i; j < value.length; j++) {
        if (value[j] === '(') depth++;
        else if (value[j] === ')' && --depth === 0) return value.slice(i, j + 1);
      }
      return value.slice(i);
    }
  }
  return null;
}

const BORDER_PROPS = /^(?:border|border-(?:top|right|bottom|left)|border-(?:top|right|bottom|left)-color|border-color|outline|outline-color)$/;
const TEXT_PROPS = /^(?:color|-webkit-text-fill-color)$/;

/**
 * 装饰性 tint 描边基线：新增一处会让集合变大 → 红；修掉一处会让集合变小 → 绿（只降不升）。
 * T04468 的整改范围是桌面 `--accent-*-aNN` 族；移动端这 9 处走 `--m-*`（T04467 自校准的皮肤族），
 * 不在该族内，故保持冻结、本单不改其视觉。
 */
const DECORATIVE_TINT_BASELINE = new Set([
  'MobileBrowse.vue::.mb-chip-type::border-color',
  'MobileBrowse.vue::.mb-error::border',
  'MobileIngest.vue::.mi-result-head.ok::border-color',
  'MobileIngest.vue::.mi-result-head.err::border-color',
  'MobileListen.vue::.ml-mini::border',
  'MobileListen.vue::.ml-q-btn.del:hover::border-color',
  'MobileListen.vue::.ml-pl-btn::border',
  'MobileQuery.vue::.mq-bubble.user::border',
  'MobileQuery.vue::.mq-error::border',
]);

interface PageScan {
  failures: AuditFailure[];
  decorative: string[];
}

/** 逐页扫描真实消费点：有自声明底色就压在自声明面上，否则按卡片面/页面底取最差 */
function scanPage(file: string, theme: ThemeTokens): PageScan {
  const s = mobileSurfaces(theme.decls);
  const src = readFileSync(join(MOBILE_DIR, file), 'utf8');
  const css = stripComments(styleText(src));
  const failures: AuditFailure[] = [];
  const decorative: string[] = [];
  for (const { sel, body } of iterRules(css)) {
    const bgDecl = /(?:^|;)\s*(?:background|background-color)\s*:\s*([^;]+)/i.exec(body);
    const ownBg = bgDecl ? bgDecl[1].trim().replace(/\s+/g, ' ') : null;
    const ownBgRgb = ownBg ? (() => { try { const r = resolve(ownBg, theme.decls); return 'stops' in r ? null : r.solid; } catch { return null; } })() : null;
    for (const seg of body.split(';')) {
      const colon = seg.indexOf(':');
      if (colon < 0) continue;
      const prop = seg.slice(0, colon).trim().replace(/\s+/g, ' ');
      const value = seg.slice(colon + 1).trim().replace(/\s+/g, ' ');
      const isText = TEXT_PROPS.test(prop);
      const isBorder = BORDER_PROPS.test(prop);
      if (!isText && !isBorder) continue;
      const fg = isText ? value : firstColorExpr(value);
      if (!fg) continue;
      // 中性描边（--m-border / --m-border-2）是输入框/分割线的常规发丝线，与 T04468 的 tint 族分开；
      // 本单不把整站发丝线刷红，形状锁（上面 token 测试）保证它至少是纯色、能被 border 简写消费。
      if (isBorder && /--m-border(?:-2)?\b/.test(fg)) continue;
      let fgSolid: RGB;
      try {
        const r = resolve(fg, theme.decls);
        if ('stops' in r) continue;
        fgSolid = r.solid;
      } catch {
        continue;
      }
      // 边界色 == 自身填充色是“不存在的描边”，不构成可感知边界，也无对比度可谈
      if (isBorder && ownBgRgb && fgSolid.r === ownBgRgb.r && fgSolid.g === ownBgRgb.g && fgSolid.b === ownBgRgb.b && fgSolid.a === ownBgRgb.a) continue;
      const faces = ownBg ? [ownBg] : ['var(--m-surface)', 'var(--m-bg)'];
      // 合成底：--m-bg 直接压 --bg-void；--m-surface 压 page；fill/tint 等叠层压 surface。
      // 不能统一传 s.surface：半透明 --m-surface 会被自己再合成一次，深色主题会算偏亮。
      const base = !ownBg
        ? s.page
        : /--m-bg\b/.test(ownBg)
          ? baseOf(theme.decls, 'void')
          : /--m-surface\b/.test(ownBg)
            ? s.page
            : s.surface;
      let worst = Infinity;
      for (const face of faces) {
        try {
          worst = Math.min(worst, worstRatio(fg, face, theme.decls, base));
        } catch { /* 面不可解析时不臆造比值，交由面口径测试兜底 */ }
      }
      if (worst === Infinity) continue;
      const kind = isText ? 'text' : 'ui';
      if (worst >= THRESHOLD[kind]) continue;
      if (isBorder && fgSolid.a < 0.5) {
        decorative.push(`${file}::${sel}::${prop}`);
        continue;
      }
      failures.push({ theme: theme.name, label: `${file} ${sel} ${prop} ${value}`, ratio: worst, threshold: THRESHOLD[kind] });
    }
  }
  return { failures, decorative };
}

describe('T04467 移动端逐页消费点（MobileBrowse / Query / Ingest / Listen / Me / Shell）', () => {
  it('除 T04468 的装饰 tint 外，所有前景消费点达标', () => {
    const failures: AuditFailure[] = [];
    const decorative = new Set<string>();
    for (const t of themes) {
      for (const file of THEMED_PAGES) {
        const r = scanPage(file, t);
        failures.push(...r.failures);
        for (const d of r.decorative) decorative.add(d);
      }
    }
    expect(failures, `未达标：\n  ${fmt(failures)}`).toEqual([]);
    const added = [...decorative].filter((k) => !DECORATIVE_TINT_BASELINE.has(k));
    expect(added, `新增了未登记的装饰 tint 描边（T04468 口径应先裁决再接入）：\n  ${added.join('\n  ')}`).toEqual([]);
  });

  it('主题皮肤页面不再出现字面色前景（Login 是常暗页，单独审计）', () => {
    const hits: string[] = [];
    for (const file of THEMED_PAGES) {
      const src = readFileSync(join(MOBILE_DIR, file), 'utf8');
      for (const site of listLiteralForegroundSites(src)) {
        // 只看文字前景：装饰 tint 描边是 T04468 的独立缺陷族，已由上一条基线冻结，
        // 混进本锁会让“新增一处粉色描边”和“新增一处白字”报同一种错，处置口径反而模糊。
        if (!TEXT_PROPS.test(site.prop)) continue;
        hits.push(`${file} ${site.sel} · ${site.prop} → ${site.value}`);
      }
    }
    expect(hits, `字面色前景（主题切换会压到不可见）：\n  ${hits.join('\n  ')}`).toEqual([]);
  });
});

/**
 * MobileLogin 不消费 glass/light 皮肤：固定深色渐变页 + 深色半透明卡片。
 * 面口径：页底最亮端点（渐变顶部）→ 卡片 → 输入框/代码块/错误条。
 * 卡片描边、错误条描边、hint 虚线框属于装饰性边界；控件边界（输入框）单独按 3:1 审。
 */
describe('T04467 MobileLogin 常暗页', () => {
  const decls = parseRootDecls();
  const loginVoid = (() => {
    const r = resolve('var(--login-bg, #070a12)', decls);
    if ('stops' in r) throw new Error('login-bg 不应是渐变');
    return r.solid;
  })();
  const pageTop = composite({ r: 8, g: 12, b: 22, a: 0.42 }, loginVoid);
  const card = 'rgba(18, 24, 38, 0.72)';
  const cardRgb = (() => {
    const r = resolve(card, decls);
    if ('stops' in r) throw new Error('登录卡片面不应是渐变');
    return r.solid;
  })();
  const cardBase = composite(cardRgb, pageTop);
  const rows: Array<{ label: string; fg: string; bg: string; over: RGB; kind: 'text' | 'ui' }> = [
    { label: '标题', fg: '#ffffff', bg: card, over: pageTop, kind: 'text' },
    { label: '副标题', fg: 'rgba(255, 255, 255, 0.62)', bg: card, over: pageTop, kind: 'text' },
    { label: '输入文字', fg: '#ffffff', bg: 'rgba(255, 255, 255, 0.10)', over: cardBase, kind: 'text' },
    { label: '输入占位符', fg: 'rgba(255, 255, 255, 0.5)', bg: 'rgba(255, 255, 255, 0.10)', over: cardBase, kind: 'text' },
    { label: '输入框边界', fg: 'rgba(255, 255, 255, 0.38)', bg: 'rgba(255, 255, 255, 0.10)', over: cardBase, kind: 'ui' },
    { label: '输入框聚焦边界', fg: 'rgba(255, 255, 255, 0.55)', bg: 'rgba(255, 255, 255, 0.14)', over: cardBase, kind: 'ui' },
    { label: '切换文案', fg: 'rgba(255, 255, 255, 0.72)', bg: card, over: pageTop, kind: 'text' },
    { label: '切换链接', fg: '#8ec5ff', bg: card, over: pageTop, kind: 'text' },
    { label: '默认账号提示', fg: 'rgba(255, 255, 255, 0.58)', bg: card, over: pageTop, kind: 'text' },
    { label: '默认账号代码', fg: '#8ec5ff', bg: 'rgba(255, 255, 255, 0.12)', over: cardBase, kind: 'text' },
    { label: '错误提示', fg: '#ff7d72', bg: 'rgba(217, 48, 37, 0.12)', over: cardBase, kind: 'text' },
    { label: '登录按钮文字', fg: '#ffffff', bg: '#1f6ad1', over: pageTop, kind: 'text' },
    { label: '登录按钮边界（填充 vs 卡片）', fg: '#1f6ad1', bg: card, over: pageTop, kind: 'ui' },
  ];

  it('全部达 AA', () => {
    const failures = rows.filter((r) => worstRatio(r.fg, r.bg, decls, r.over) < THRESHOLD[r.kind]);
    const msg = failures.map((r) => `${r.label} = ${worstRatio(r.fg, r.bg, decls, r.over).toFixed(2)}（需 ≥ ${THRESHOLD[r.kind]}）`).join('\n  ');
    expect(failures.map((r) => r.label), `未达标：\n  ${msg}`).toEqual([]);
  });

  it('按钮底色是暗化后的 #1f6ad1（白字仅 4.13 的原 #2b7de1 已替换）', () => {
    const src = readFileSync(join(MOBILE_DIR, 'MobileLogin.vue'), 'utf8');
    expect(src).toContain('background: #1f6ad1;');
    expect(src).not.toContain('background: #2b7de1;');
  });
});

describe('loadThemes 默认行为不变（T04467 只加开关，不动 8 主题锁）', () => {
  it('默认仍只返回桌面主题；显式 mobileSkins 才追加三套移动皮肤', () => {
    const desktop = loadThemes();
    expect(desktop.some((t) => t.name.startsWith('mobile-'))).toBe(false);
    expect(loadThemes({ mobileSkins: true }).filter((t) => t.name.startsWith('mobile-')).map((t) => t.name)).toEqual([
      'mobile-glass',
      'mobile-light',
      'mobile-light-dark',
    ]);
  });

  it('移动面口径能解析三套皮肤', () => {
    for (const t of themes) {
      const s = mobileSurfaces(t.decls);
      for (const [name, c] of Object.entries(s)) {
        expect(Number.isFinite(contrast(c, s.surface)), `${t.name} ${name}`).toBe(true);
      }
    }
  });
});
