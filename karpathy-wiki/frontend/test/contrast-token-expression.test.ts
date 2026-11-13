// T04529 —— 对比度普查判据从「前景声明含字面色」升级为「token 表达式 × 主题实算」。
//
// 旧判据（T04449 起的 sweep 族 + T04520/T04524 单族锁）只盯「规则里写了字面色」的前景；
// `color: var(--x, #abc)` 里只要 #abc 藏在 fallback 里，整类盲区就没人看得见：
//   - --x 在某主题未声明 → 生效值就是 #abc，旧判据不审计；
//   - --x 在所有主题都未声明 → 连 token 级锁都没得锁（T04520/T04524 都是这么漏掉的）。
//
// 本锁的口径（一次性铺开，不逐族补单）：
//   1. 普查：扫描 src 全部 .vue/.css 的颜色类声明（含单行规则、嵌套 fallback、无 fallback 的 var()），
//      逐 token 拆成「文件/选择器/属性/字面 fallback」一行（test/helpers/tokenCensus.ts）；
//   2. 实算：每个进入矩阵的族，在 9 套主题下按**真实生效值**算对比度 —— 主题声明优先，
//      未声明时取组件该消费点的字面 fallback（不是取一个假想默认值）；
//   3. 面口径：每个族必须登记面（页 / 卡片 / trace / 模态），没有面的族不许进矩阵；
//   4. fail-closed：进矩阵的 token 若某主题未声明，必须显式登记 missing 集合 + 生效 fallback；
//      :root 下实算不达标就必须落进已知债务台账，不允许「静默继承一份没人校准的值」；
//   5. 清零口径：普查出的每个族必须有归宿 —— 矩阵 / 委托既有锁 / 死声明登记 / 移动皮肤豁免 /
//      仅边框豁免 / 9 主题全声明；新族不登记即红。
//
// 与旧单族锁的关系（T04520 --probe-*、T04524 --cite-hit-*）：
//   两族的判定面（3 态 × 标签 tint/页底、2 张模态面）原样迁入本锁的矩阵；
//   模态面口径前提（遮罩来源、EP 原值、对话框取 --bg-card-solid、.citation-* 不自带底）
//   与消费点结构锁一并迁入；迁移前已用变异探针验证本锁能接住旧锁的全部红法。
//
// 本单只建通道 + 迁锁，**不改任何主题取值**：迁移中实算出的不达标族一律登记进 DEBT（21 条），
// 由后续单按族整改；债务台账是双向锁（不多不少、数值逐位冻结），整改时它会先红一次逼同步。
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  EP_VAR_CSS,
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
  worstRatioOnFaces,
  type RGB,
  type ThemeTokens,
} from './helpers/contrast';
import { censusFamilies, scanColorVarRows, type CensusFamily } from './helpers/tokenCensus';

const THEME_NAMES = [
  'default(:root)',
  'creative',
  'ecommerce',
  'enterprise',
  'light-business',
  'macaron',
  'portfolio',
  'product',
  'dark(tokens.css)',
] as const;
const ALL_THEMES: ThemeTokens[] = [...loadThemes(), loadAuxTheme('dark')];
const themeByName = (name: string): ThemeTokens => {
  const t = ALL_THEMES.find((x) => x.name === name);
  if (!t) throw new Error(`主题清单里没有 ${name}`);
  return t;
};
const LIGHT = ['ecommerce', 'enterprise', 'light-business', 'macaron', 'portfolio'];
const NOT_DARK = THEME_NAMES.filter((n) => n !== 'dark(tokens.css)');

const CENSUS_ROWS = scanColorVarRows();
const FAMILIES = censusFamilies(CENSUS_ROWS);
const familyOf = (token: string): CensusFamily | undefined => FAMILIES.get(token);
const missingThemes = (token: string): string[] => ALL_THEMES.filter((t) => !t.decls.get(token)).map((t) => t.name);
const declaredEverywhere = (token: string): boolean => missingThemes(token).length === 0;

const solidOf = (expr: string, decls: Map<string, string>, label: string): RGB => {
  const r = resolve(expr, decls);
  if ('stops' in r) throw new Error(`${label} 解析成了渐变，本锁的实算口径需要重新定义`);
  return r.solid;
};

/* ------------------------------------------------------------------ 矩阵 */

type FaceKind = 'page' | 'card' | 'trace' | 'modal';
interface MatrixRow {
  label: string;
  fg: string;
  bg: string;
  face: FaceKind;
  modalFace?: 0 | 1;
  kind: 'text' | 'ui';
  /** 该行实际消费的 token（面 token 也算），用于普查归宿与 fail-closed 登记 */
  families: string[];
}

const PROBE_STATES = ['ok', 'warn', 'error'] as const;

/**
 * 矩阵 = 「fallback 会真实生效」的消费点。每行都写清楚 fg/bg 表达式与压在哪张面上；
 * 面是算出来的（卡片/ trace 都是半透明合成），不是拍一个白色底交差。
 */
const MATRIX: MatrixRow[] = [
  ...PROBE_STATES.flatMap(
    (st): MatrixRow[] => [
      {
        label: `${st}·标签压 tint`,
        fg: `var(--probe-${st})`,
        bg: `var(--probe-${st}-bg)`,
        face: 'page',
        kind: 'text',
        families: [`--probe-${st}`, `--probe-${st}-bg`],
      },
      {
        label: `${st}·外层压页底`,
        fg: `var(--probe-${st})`,
        bg: 'transparent',
        face: 'page',
        kind: 'text',
        families: [`--probe-${st}`],
      },
    ],
  ),
  {
    label: 'cite-hit·对话框压页面卡片',
    fg: 'var(--cite-hit-fg)',
    bg: 'var(--cite-hit-bg)',
    face: 'modal',
    modalFace: 0,
    kind: 'text',
    families: ['--cite-hit-fg', '--cite-hit-bg'],
  },
  {
    label: 'cite-hit·对话框压页底',
    fg: 'var(--cite-hit-fg)',
    bg: 'var(--cite-hit-bg)',
    face: 'modal',
    modalFace: 1,
    kind: 'text',
    families: ['--cite-hit-fg', '--cite-hit-bg'],
  },
  {
    label: 'menu-active-fg·激活标签压渐变',
    fg: 'var(--menu-active-fg, #fff)',
    bg: 'var(--menu-active-bg, var(--grad-fire))',
    face: 'page',
    kind: 'text',
    families: ['--menu-active-fg', '--menu-active-bg'],
  },
  {
    label: 'el-color-primary·trace 图标',
    fg: 'var(--el-color-primary, #409eff)',
    bg: 'var(--trace-bg, rgba(64, 158, 255, 0.04))',
    face: 'card',
    kind: 'ui',
    families: ['--el-color-primary', '--trace-bg'],
  },
  {
    label: 'el-color-danger·trace 错误行',
    fg: 'var(--el-color-danger, #f56c6c)',
    bg: 'var(--trace-bg, rgba(64, 158, 255, 0.04))',
    face: 'card',
    kind: 'text',
    families: ['--el-color-danger', '--trace-bg'],
  },
  {
    label: 'accent·外链文字压卡片',
    fg: 'var(--accent, #4f7cff)',
    bg: 'transparent',
    face: 'card',
    kind: 'text',
    families: ['--accent'],
  },
  {
    label: 'ib-sepia-text·输入框',
    fg: 'var(--ib-sepia-text, #5b4636)',
    bg: 'var(--ib-sepia-bg, rgba(255, 244, 224, 0.55))',
    face: 'page',
    kind: 'text',
    families: ['--ib-sepia-text', '--ib-sepia-bg'],
  },
  {
    label: 'ib-midnight-text·输入框',
    fg: 'var(--ib-midnight-text, #d6e2ff)',
    bg: 'var(--ib-midnight-bg, rgba(10, 14, 24, 0.72))',
    face: 'page',
    kind: 'text',
    families: ['--ib-midnight-text', '--ib-midnight-bg'],
  },
  {
    label: '白色书签按钮文字',
    fg: '#ffffff',
    bg: 'var(--color-primary, #0f4c81)',
    face: 'page',
    kind: 'text',
    families: ['--color-primary'],
  },
  {
    label: 'text-soft·trace 热点行',
    fg: 'var(--text-soft, #888)',
    bg: 'var(--trace-hot-bg, rgba(245, 108, 108, 0.1))',
    face: 'trace',
    kind: 'text',
    families: ['--text-soft', '--trace-hot-bg'],
  },
];

/** 消费点是模板字符串拼出来的（`var(--probe-${st})`），静态普查看不见，必须显式登记 */
const DYNAMIC_FAMILIES = PROBE_STATES.flatMap((st) => [`--probe-${st}`, `--probe-${st}-bg`]);
const MATRIX_FAMILIES = new Set([...MATRIX.flatMap((r) => r.families), ...DYNAMIC_FAMILIES]);
const ROW_LABELS = MATRIX.map((r) => r.label);

function faceBase(t: ThemeTokens, face: FaceKind): RGB {
  const page = pageOf(t.decls);
  if (face === 'page') return page;
  const card = composite(solidOf('var(--bg-card-solid)', t.decls, `${t.name} 的 --bg-card-solid`), page);
  if (face === 'card') return card;
  if (face === 'trace') return composite(solidOf('var(--trace-bg, rgba(64, 158, 255, 0.04))', t.decls, `${t.name} 的 --trace-bg`), card);
  throw new Error(`faceBase 不处理 ${face}（模态面走 modalFaces）`);
}

function ratioOf(row: MatrixRow, t: ThemeTokens): number {
  if (row.face === 'modal') return worstRatioOnFaces(row.fg, row.bg, t.decls, [modalFaces(t)[row.modalFace ?? 0]]);
  return worstRatio(row.fg, row.bg, t.decls, faceBase(t, row.face));
}

interface Result {
  key: string;
  theme: string;
  row: MatrixRow;
  ratio: number;
  threshold: number;
  pass: boolean;
}
const MATRIX_RESULTS: Result[] = ALL_THEMES.flatMap((t) =>
  MATRIX.map((row) => {
    const ratio = ratioOf(row, t);
    const threshold = THRESHOLD[row.kind];
    return { key: `${row.label} · ${t.name}`, theme: t.name, row, ratio, threshold, pass: ratio >= threshold };
  }),
);
const failures = (results: Result[] = MATRIX_RESULTS) => results.filter((r) => !r.pass);

/* ------------------------------------------------------------------ 已知债务 */

/**
 * 迁移中实算出的既有不达标（本单只登记，不顺手改）。键 = 行 · 主题，值 = 三位小数实算值。
 * 双向锁：实算失败集合必须与它**逐项相等**；任一数值漂移（哪怕变好）都会先红，
 * 逼整改单先更新台账再收口 —— 否则「悄悄改好」与「悄悄改坏」在锁里长得一样。
 */
const DEBT: Record<string, string> = {
  'menu-active-fg·激活标签压渐变 · default(:root)': '3.834',
  'menu-active-fg·激活标签压渐变 · enterprise': '4.467',
  'el-color-primary·trace 图标 · ecommerce': '2.678',
  'el-color-primary·trace 图标 · enterprise': '2.678',
  'el-color-primary·trace 图标 · light-business': '2.678',
  'el-color-primary·trace 图标 · macaron': '2.678',
  'el-color-primary·trace 图标 · portfolio': '2.618',
  'el-color-danger·trace 错误行 · ecommerce': '2.792',
  'el-color-danger·trace 错误行 · enterprise': '2.792',
  'el-color-danger·trace 错误行 · light-business': '2.792',
  'el-color-danger·trace 错误行 · macaron': '2.792',
  'el-color-danger·trace 错误行 · portfolio': '2.729',
  'accent·外链文字压卡片 · ecommerce': '3.711',
  'accent·外链文字压卡片 · enterprise': '3.710',
  'accent·外链文字压卡片 · light-business': '3.711',
  'accent·外链文字压卡片 · macaron': '3.710',
  'accent·外链文字压卡片 · portfolio': '3.625',
  'ib-sepia-text·输入框 · default(:root)': '2.655',
  'ib-sepia-text·输入框 · creative': '2.655',
  'ib-sepia-text·输入框 · product': '2.681',
  'ib-sepia-text·输入框 · dark(tokens.css)': '2.865',
};

describe('T04529 · B 主锁：token 表达式 × 9 主题实算', () => {
  it('B1 · 实算失败集合与债务台账逐项相等（两边多一条都红）', () => {
    const computed = failures().map((f) => f.key).sort();
    expect(computed, '实算失败项与 DEBT 台账不一致；整改/新缺陷都要先更新台账').toEqual(Object.keys(DEBT).sort());
  });

  it('B2 · 规模锁：16 行 × 9 主题 = 144 次实算（少一行/少一主题都不是「更严」）', () => {
    expect(MATRIX.length).toBe(16);
    expect(ALL_THEMES.map((t) => t.name)).toEqual([...THEME_NAMES]);
    expect(MATRIX_RESULTS.length).toBe(144);
  });

  it('B3 · 债务数值逐位冻结（三位小数）：不是只记「这条红」，而是记「红到多少」', () => {
    const byKey = new Map(MATRIX_RESULTS.map((r) => [r.key, r]));
    for (const [key, value] of Object.entries(DEBT)) {
      const r = byKey.get(key);
      expect(r, `债务台账里的 ${key} 实算表里找不到`).toBeTruthy();
      expect((r as Result).ratio.toFixed(3), `${key} 实算值漂移`).toBe(value);
    }
  });

  it('B4 · 最差侧登记：全站最差是 el-color-primary 图标压 trace（portfolio 2.618），它只降不升会被 B1 抓住', () => {
    const worst = MATRIX_RESULTS.reduce((a, b) => (b.ratio < a.ratio ? b : a));
    expect(worst.key).toBe('el-color-primary·trace 图标 · portfolio');
    expect(worst.ratio.toFixed(3)).toBe('2.618');
  });
});

/* ------------------------------------------------------------------ fail-closed 登记 */

interface FallbackPolicy {
  token: string;
  /** 该 token 未声明的主题（显式列出，防止「以为继承了 :root」其实没有） */
  missing: string[];
  /** 未声明时组件该消费点的字面 fallback（逐字） */
  fallback: string;
}
const FALLBACK_POLICY: FallbackPolicy[] = [
  { token: '--menu-active-fg', missing: ['default(:root)'], fallback: '#fff' },
  { token: '--menu-active-bg', missing: ['default(:root)', 'ecommerce', 'enterprise', 'light-business', 'macaron'], fallback: 'var(--grad-fire)' },
  { token: '--el-color-primary', missing: NOT_DARK, fallback: '#409eff' },
  { token: '--el-color-danger', missing: NOT_DARK, fallback: '#f56c6c' },
  { token: '--trace-bg', missing: [...THEME_NAMES], fallback: 'rgba(64, 158, 255, 0.04)' },
  { token: '--trace-hot-bg', missing: [...THEME_NAMES], fallback: 'rgba(245, 108, 108, 0.1)' },
  { token: '--accent', missing: [...THEME_NAMES], fallback: '#4f7cff' },
  { token: '--ib-sepia-bg', missing: [...THEME_NAMES], fallback: 'rgba(255, 244, 224, 0.55)' },
  { token: '--ib-sepia-text', missing: [...THEME_NAMES], fallback: '#5b4636' },
  { token: '--ib-midnight-bg', missing: [...THEME_NAMES], fallback: 'rgba(10, 14, 24, 0.72)' },
  { token: '--ib-midnight-text', missing: [...THEME_NAMES], fallback: '#d6e2ff' },
  { token: '--color-primary', missing: [...THEME_NAMES], fallback: '#0f4c81' },
];
const POLICY = new Map(FALLBACK_POLICY.map((p) => [p.token, p]));

describe('T04529 · C fail-closed 声明锁', () => {
  it('C1 · 进矩阵的每个 token：要么 9 主题全声明，要么在 FALLBACK_POLICY 里显式登记', () => {
    const silent = [...MATRIX_FAMILIES].filter((token) => !declaredEverywhere(token) && !POLICY.has(token));
    expect(silent, `这些 token 在矩阵里有未声明主题却没登记 fallback，生效值将无人校准：${silent.join(' / ')}`).toEqual([]);
  });

  it('C2 · 登记的 missing 集合与真实声明状态逐主题一致', () => {
    for (const p of FALLBACK_POLICY) {
      expect(missingThemes(p.token).sort(), `${p.token} 的 missing 登记与主题文件不符`).toEqual([...p.missing].sort());
      const family = familyOf(p.token);
      if (family) {
        expect(family.fallbacks, `${p.token} 的消费点字面 fallback 与登记不一致`).toContain(p.fallback);
      } else {
        expect(DYNAMIC_FAMILIES, `${p.token} 既不在普查里、也不在动态族登记里`).toContain(p.token);
      }
    }
  });

  it('C3 · fail-closed 前提：:root 下实算不达标的登记项必须已经落进债务台账（不允许静默继承）', () => {
    const root = themeByName('default(:root)');
    const rootRows = MATRIX.filter((row) => row.families.some((f) => POLICY.has(f)));
    const silent = rootRows
      .map((row) => ({ row, ratio: ratioOf(row, root) }))
      .filter(({ row, ratio }) => ratio < THRESHOLD[row.kind] && !DEBT[`${row.label} · ${root.name}`]);
    expect(silent.map((s) => `${s.row.label}=${s.ratio.toFixed(3)}`), '这些行在 :root 已跌破阈值却不在台账里').toEqual([]);
  });

  it('C4 · 台账反向：登记的族必须真的缺声明、必须真的在矩阵里（避免登记表变成谎）', () => {
    for (const p of FALLBACK_POLICY) {
      expect(p.missing.length, `${p.token} 登记了 fallback 却没有 missing 主题`).toBeGreaterThan(0);
      expect(MATRIX_FAMILIES.has(p.token), `${p.token} 不在矩阵里，fallback 登记没有落点`).toBe(true);
    }
  });
});

/* ------------------------------------------------------------------ 普查归宿 */

/**
 * 委托既有锁的族：名字必须在被委托的锁里出现（锁文件存在且逐字引用 token）。
 * 这类族不是「没人管」，是「已经有人管，本单不重复建口径」。
 */
const DELEGATED: Record<string, string> = {
  '--role-admin-bg': 'test/contrast-ep-surfaces.test.ts',
  '--sort-caret-active': 'test/contrast-ep-surfaces.test.ts',
  '--el-border-color-lighter': 'test/contrast-ep-surfaces.test.ts',
  '--el-fill-color-lighter': 'test/contrast-ep-surfaces.test.ts',
  '--login-bg': 'test/contrast-sweep-mobile.test.ts',
};

/**
 * 死声明登记：无 fallback 且某主题未声明 → 该条声明在计算值阶段整条失效。
 * behavior 记录浏览器真实回退（color 继承、background 透明、border-color 走 currentColor），
 * 防止有人把「无效声明」误当成「取到了某个默认色」。
 */
const DEAD: Record<string, { behavior: 'inherit' | 'transparent' | 'currentColor'; missing: number | 'all' }> = {
  '--text': { behavior: 'inherit', missing: 'all' },
  '--el-color-primary-light-5': { behavior: 'currentColor', missing: 8 },
  '--el-color-primary-light-9': { behavior: 'transparent', missing: 6 },
  '--el-color-success': { behavior: 'inherit', missing: 8 },
  '--el-color-success-light-5': { behavior: 'currentColor', missing: 8 },
  '--el-color-success-light-9': { behavior: 'transparent', missing: 8 },
  '--el-color-info': { behavior: 'inherit', missing: 8 },
  '--el-color-info-light-5': { behavior: 'currentColor', missing: 8 },
  '--el-color-info-light-9': { behavior: 'transparent', missing: 8 },
  '--el-color-warning': { behavior: 'inherit', missing: 8 },
  '--el-color-warning-light-5': { behavior: 'currentColor', missing: 8 },
  '--el-color-warning-light-9': { behavior: 'transparent', missing: 8 },
  '--el-color-danger-light-5': { behavior: 'currentColor', missing: 8 },
  '--el-color-danger-light-9': { behavior: 'transparent', missing: 8 },
};

/** 移动端皮肤族：桌面 9 主题根本不该声明它们；消费点必须全在移动子树（3 皮肤锁在 sweep-mobile） */
const EXEMPT_MOBILE = ['--m-mask', '--m-stripe'];
const EXEMPT_BORDER = ['--ib-sepia-border', '--ib-midnight-border'];
const FACE_INPUT = ['--modal-mask'];

const isMobileFile = (file: string) => file.includes('/mobile/') || file.endsWith('mobile-light.css');

function dispositionOf(token: string): string {
  if (MATRIX_FAMILIES.has(token)) return 'matrix';
  if (DELEGATED[token]) return 'delegated';
  if (DEAD[token]) return 'dead';
  if (EXEMPT_MOBILE.includes(token)) return 'mobile';
  if (EXEMPT_BORDER.includes(token)) return 'border';
  if (FACE_INPUT.includes(token)) return 'face-input';
  if (declaredEverywhere(token)) return 'declared-all';
  return 'MISSING';
}

describe('T04529 · A 普查归宿锁', () => {
  // T05703 后基线：2676 → 2675。徽章外框精简移除 .ctx-badge-inner 基态的
  //   background: var(--bg-card) / border: 1px solid var(--purple-readable) /
  //   box-shadow: var(--accent-purple-a10) 三处消费点，同时保留 hover border-color
  //   审计锚点（var(--accent-readable) / var(--neon-cyan)）并新增 focus-visible
  //   outline（同一对 token）；净减 1 条消费点，是预期内的简化，不是扫描口径退化。
  // T05723 后基线：2675 → 2679。Progress.vue 新增 .back-to-top 悬浮按钮：
  //   border / color / hover border-color 三处 var(--accent-readable) +
  //   hover box-shadow 一处 var(--accent-cyan-a40)，净增 4 条消费点。
  //   FAMILIES / gap 未变：新增 token 均为既有族，族面未扩大。
  it('A1 · 规模锁：192 族 / 2679 条消费点 / 36 个 gap 族（少一个族说明扫描口径退化，不是「更干净」）', () => {
    expect(FAMILIES.size).toBe(192);
    expect(CENSUS_ROWS.length).toBe(2679);
    expect([...FAMILIES.values()].filter((f) => !declaredEverywhere(f.token)).length).toBe(36);
  });

  it('A2 · 每个普查出的族都有且只有一个归宿；没有归宿的 gap 族点名到 token', () => {
    const orphan = [...FAMILIES.keys()].filter((token) => dispositionOf(token) === 'MISSING');
    expect(orphan, `这些族在主题里缺声明，又没进矩阵/委托/死声明/豁免：${orphan.join(' / ')}`).toEqual([]);
  });

  it('A3 · 委托锁真实承接：每个 DELEGATED 的 token 都在被委托的锁文件里逐字出现', () => {
    for (const [token, testFile] of Object.entries(DELEGATED)) {
      const src = readFileSync(join(ROOT, testFile), 'utf8');
      expect(src.includes(token), `${testFile} 不再引用 ${token}：委托关系已失效，本锁要收回自审`).toBe(true);
      expect(FAMILIES.has(token), `${token} 不在普查里，委托登记是空的`).toBe(true);
    }
  });

  it('A4 · 死声明登记与真实状态一致：无 fallback、缺声明数对得上、行为已写明', () => {
    for (const [token, meta] of Object.entries(DEAD)) {
      const family = familyOf(token);
      expect(family, `${token} 不在普查里`).toBeTruthy();
      expect((family as CensusFamily).fallbacks, `${token} 现在有字面 fallback 了，应迁出死声明台账`).toEqual([]);
      const missing = missingThemes(token).length;
      if (meta.missing === 'all') expect(missing, `${token} 不再全主题缺失`).toBe(9);
      else expect(missing, `${token} 缺失主题数变了（生效面已移动）`).toBe(meta.missing);
      expect(['inherit', 'transparent', 'currentColor']).toContain(meta.behavior);
    }
  });

  it('A5 · 移动豁免前提：消费点全在移动子树（漏到桌面文件就必须重新定面/纳矩阵）', () => {
    for (const token of EXEMPT_MOBILE) {
      const family = familyOf(token);
      expect(family, `${token} 不在普查里`).toBeTruthy();
      const desktop = (family as CensusFamily).files.filter((f) => !isMobileFile(f));
      expect(desktop, `${token} 在桌面文件里有消费点：${desktop.join(', ')}`).toEqual([]);
      expect(declaredEverywhere(token), `${token} 现在 9 主题都有声明了，豁免理由失效`).toBe(false);
    }
  });

  it('A6 · 仅边框豁免前提：族的所有消费点确实只写边框（出现 color/background 就必须重新定面）', () => {
    for (const token of EXEMPT_BORDER) {
      const family = familyOf(token);
      expect(family, `${token} 不在普查里`).toBeTruthy();
      expect([...(family as CensusFamily).properties], `${token} 不止用于边框`).toEqual(['border']);
    }
  });

  it('A7 · 矩阵族的消费点可追溯：普查里有行，或在动态族登记里（模板字符串拼出来的）', () => {
    for (const token of MATRIX_FAMILIES) {
      const tracked = FAMILIES.has(token) || DYNAMIC_FAMILIES.includes(token);
      expect(tracked, `${token} 进了矩阵却找不到消费点：面口径是凭空定的`).toBe(true);
    }
  });

  it('A8 · 矩阵行标签唯一（台账键靠它，重名会让失败项与债务项对不上）', () => {
    expect(new Set(ROW_LABELS).size).toBe(ROW_LABELS.length);
  });
});

/* ------------------------------------------------------------------ 消费点 / 模态面前提 */

const read = (rel: string) => readFileSync(join(ROOT, rel), 'utf8');

/** 矩阵行对应的真实消费点：规则必须还在，且逐字引用 token（面口径换了要同步本表） */
const CONSUMERS: Array<{ file: string; selector: string; tokens: string[] }> = [
  { file: 'src/App.vue', selector: '.tab-btn.active', tokens: ['--menu-active-fg', '--menu-active-bg'] },
  { file: 'src/components/QueryTracePanel.vue', selector: '.trace-icon', tokens: ['--el-color-primary'] },
  { file: 'src/components/QueryTracePanel.vue', selector: '.trace-error', tokens: ['--el-color-danger'] },
  { file: 'src/components/QueryTracePanel.vue', selector: '.trace-table tr.hot td', tokens: ['--trace-hot-bg', '--text-soft'] },
  { file: 'src/views/Config.vue', selector: '.media-external-link', tokens: ['--accent'] },
  {
    file: 'src/views/Query.vue',
    selector: '.input-area.ib-theme-sepia :deep(.el-textarea__inner)',
    tokens: ['--ib-sepia-text', '--ib-sepia-bg'],
  },
  {
    file: 'src/views/Query.vue',
    selector: '.input-area.ib-theme-midnight :deep(.el-textarea__inner)',
    tokens: ['--ib-midnight-text', '--ib-midnight-bg'],
  },
  { file: 'src/views/Ingest.vue', selector: '.bookmarklet', tokens: ['--color-primary'] },
];

describe('T04529 · D 消费点与模态面口径前提', () => {
  it('D1 · 矩阵行的消费规则仍在且引用登记的 token（消费点改名/改 token → 本腿先红）', () => {
    for (const c of CONSUMERS) {
      const bodies = ruleBodies(read(c.file), c.selector);
      expect(bodies.length, `${c.file} 找不到 ${c.selector}`).toBe(1);
      for (const token of c.tokens) {
        expect(new RegExp(`var\\(${token}[,)]`).test(bodies[0] as string), `${c.selector} 不再引用 ${token}`).toBe(true);
      }
    }
  });

  it('D2 · 遮罩来源仍是 modal.css 的 --modal-mask（换成 EP 原值，模态面两张落点都要重算）', () => {
    const { source, expr } = overlayExpr();
    expect(source, `遮罩来源变了：${expr}`).toBe('modal.css');
    expect(/rgba\(4, 2, 12, 0?\.58\)/.exec(expr)?.[0], 'modal.css 的 --modal-mask fallback 值变了').toBeTruthy();
  });

  it('D3 · EP 安装副本的遮罩原值留档（#00000080）：覆盖被删时它就生效', () => {
    const m = /--el-overlay-color-lighter:\s*([^;]+)/.exec(stripComments(readFileSync(EP_VAR_CSS, 'utf8')));
    expect(m, 'EP 主题里找不到 --el-overlay-color-lighter').toBeTruthy();
    expect((m as RegExpMatchArray)[1].trim()).toBe('#00000080');
  });

  it('D4 · 对话框容器背景仍取 --bg-card-solid（对话框自身面 = 卡片，遮罩只透 alpha 渗入）', () => {
    const modal = stripComments(readFileSync(MODAL_CSS, 'utf8'));
    expect(
      /\.app-modal\.el-dialog[^{,]*,[^{]*\{[^}]*background:\s*var\(--bg-card-solid\)/.test(modal),
      'modal.css 的 .app-modal.el-dialog 背景不再取 --bg-card-solid',
    ).toBe(true);
    expect(
      /(?:^|[\n};])\s*\.el-dialog\s*\{[^}]*background:\s*var\(--bg-card-solid\)/.test(stripComments(read('src/style.css'))),
      'style.css 的 .el-dialog 背景不再取 --bg-card-solid',
    ).toBe(true);
  });

  it('D5 · .citation-* 容器不得自带背景，高亮仍由 mark.cite-hit 消费两个 token，组件 fallback 与 :root 同值', () => {
    const cite = read('src/components/CitationModal.vue');
    for (const sel of ['.citation-body', '.citation-chunk', '.citation-chunk-content']) {
      const bodies = ruleBodies(cite, sel);
      expect(bodies.length, `CitationModal 找不到 ${sel}`).toBe(1);
      expect(/background/.test(bodies[0] as string), `${sel} 自带了背景，模态面口径失效`).toBe(false);
    }
    const hit = ruleBodies(cite, ':deep(.cite-hit)');
    expect(hit.length).toBe(1);
    expect(/background:\s*var\(--cite-hit-bg[,)]/.test(hit[0] as string)).toBe(true);
    expect(/color:\s*var\(--cite-hit-fg[,)]/.test(hit[0] as string)).toBe(true);
    expect(/<mark class="cite-hit">/.test(cite)).toBe(true);
    const root = themeByName('default(:root)').decls;
    for (const token of ['--cite-hit-bg', '--cite-hit-fg']) {
      const fb = new RegExp(`var\\(${token},\\s*(rgba\\([^)]*\\)|#[0-9a-fA-F]{3,8})\\s*\\)`).exec(cite)?.[1].trim();
      expect(fb, `组件里 ${token} 的 fallback 取不到了`).toBeTruthy();
      expect(fb, `组件 fallback 与 :root 的 ${token} 不同值：未登记主题会落错档`).toBe(root.get(token));
    }
  });

  it('D6 · probe 六条消费规则仍在；外层规则无自声明底（「压页底」判定的前提）', () => {
    const ingest = read('src/views/Ingest.vue');
    for (const st of PROBE_STATES) {
      const outer = ruleBodies(ingest, `.url-proxy-probe.probe-${st}`);
      expect(outer.length, `probe-${st} 外层规则丢失`).toBeGreaterThan(0);
      expect(new RegExp(`var\\(--probe-${st}[,)]`).test(outer[0] as string)).toBe(true);
      expect(/background/.test(outer[0] as string), `probe-${st} 外层自带了背景，压页底口径失效`).toBe(false);
      const tag = ruleBodies(ingest, `.url-proxy-probe.probe-${st} .probe-tag`);
      expect(tag.length, `probe-${st} 标签规则丢失`).toBeGreaterThan(0);
      expect(new RegExp(`var\\(--probe-${st}[,)]`).test(tag[0] as string)).toBe(true);
      expect(new RegExp(`var\\(--probe-${st}-bg[,)]`).test(tag[0] as string)).toBe(true);
    }
  });

  it('D7 · 引用面清单：--probe-* / --cite-hit-* 只出现在登记的 8 个文件里（新接一处即红）', () => {
    const walk = (dir: string, out: string[] = []): string[] => {
      for (const d of readdirSync(join(ROOT, dir), { withFileTypes: true })) {
        const rel = `${dir}/${d.name}`;
        if (d.isDirectory()) walk(rel, out);
        else if (/\.(vue|css)$/.test(rel)) out.push(rel);
      }
      return out;
    };
    const files = walk('src');
    const probe = files.filter((f) => /--probe-(ok|warn|error)/.test(read(f))).sort();
    expect(probe).toEqual(
      ['src/style.css', 'src/styles/tokens.css', ...LIGHT.map((n) => `src/styles/themes/${n}.css`), 'src/views/Ingest.vue'].sort(),
    );
    const cite = files.filter((f) => /--cite-hit-/.test(read(f))).sort();
    expect(cite).toEqual(
      ['src/style.css', 'src/styles/tokens.css', 'src/components/CitationModal.vue', ...LIGHT.map((n) => `src/styles/themes/${n}.css`)].sort(),
    );
  });
});

/* ------------------------------------------------------------------ 口径负控制 */

const withOverrides = (t: ThemeTokens, over: Record<string, string>): ThemeTokens => {
  const decls = new Map(t.decls);
  for (const [k, v] of Object.entries(over)) decls.set(k, v);
  return { name: t.name, decls };
};
const citeRow = (index: 0 | 1) => MATRIX.find((r) => r.face === 'modal' && r.modalFace === index) as MatrixRow;

describe('T04529 · F 口径负控制（必须全绿）', () => {
  it('F1 · 两张模态落点可分辨且都不等于页底（遮罩 + 半透明卡片不是「自己等于自己」）', () => {
    for (const name of ['default(:root)', 'product', 'portfolio']) {
      const t = themeByName(name);
      const faces = modalFaces(t);
      expect(faces[0]).not.toEqual(faces[1]);
      const page = pageOf(t.decls);
      for (const f of faces) {
        expect([f.r, f.g, f.b]).not.toEqual([page.r, page.g, page.b]);
      }
    }
  });

  it('F2 · probe tint 是真正的半透明面：alpha 0.15，合成后 ≠ 页底', () => {
    const dark = themeByName('dark(tokens.css)');
    const page = pageOf(dark.decls);
    for (const st of PROBE_STATES) {
      const tint = solidOf(`var(--probe-${st}-bg)`, dark.decls, `--probe-${st}-bg`);
      expect(tint.a).toBe(0.15);
      const face = composite(tint, page);
      expect([face.r, face.g, face.b]).not.toEqual([page.r, page.g, page.b]);
    }
  });

  it('F3 · 144 次实算全部是 [1, 21] 内的有限数（解析器产出 NaN 时 B 腿会无声全绿）', () => {
    expect(MATRIX_RESULTS.length).toBe(144);
    for (const r of MATRIX_RESULTS) {
      expect(Number.isFinite(r.ratio), `${r.key} 比值异常`).toBe(true);
      expect(r.ratio).toBeGreaterThanOrEqual(1);
      expect(r.ratio).toBeLessThanOrEqual(21);
    }
  });

  it('F4 · 把 cite-hit 面换回改前的 .55，同一口径立刻在深底主题判红（证明主锁有牙齿）', () => {
    const product = themeByName('product');
    const before = withOverrides(product, { '--cite-hit-bg': 'rgba(255, 213, 79, 0.55)' });
    const bad = [citeRow(0), citeRow(1)].map((row) => ratioOf(row, before)).filter((r) => r < THRESHOLD.text);
    expect(bad.length, '把面换回 .55 必须两张落点都判红').toBe(2);
  });

  it('F5 · 白字压浅底 cite 片必须判红（锁盯的是两头，不是只校准深底）', () => {
    const ecommerce = themeByName('ecommerce');
    const bad = [citeRow(0), citeRow(1)]
      .map((row) => worstRatioOnFaces('#ffffff', 'var(--cite-hit-bg)', ecommerce.decls, [modalFaces(ecommerce)[row.modalFace ?? 0]]))
      .filter((r) => r < THRESHOLD.text);
    expect(bad.length).toBe(2);
  });

  it('F6 · 接错对象自证：fg/bg 写成同一个表达式，比值塌到 1 附近', () => {
    const ecommerce = themeByName('ecommerce');
    for (const index of [0, 1] as const) {
      const face = modalFaces(ecommerce)[index];
      const ratio = worstRatioOnFaces('var(--cite-hit-bg)', 'var(--cite-hit-bg)', ecommerce.decls, [face]);
      expect(ratio).toBeLessThan(1.5);
    }
  });

  it('F7 · probe 取值换回改前 #1a7f37，ecommerce 标签 tint 面立刻红（旧锁的定性结论在新口径里仍成立）', () => {
    const ecommerce = withOverrides(themeByName('ecommerce'), { '--probe-ok': '#1a7f37' });
    const row = MATRIX.find((r) => r.label === 'ok·标签压 tint') as MatrixRow;
    expect(ratioOf(row, ecommerce)).toBeLessThan(THRESHOLD.text);
  });
});
