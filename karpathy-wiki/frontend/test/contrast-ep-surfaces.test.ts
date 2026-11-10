// T04904：Element Plus 表面主题化守护。
// 现象（T04449 真实渲染审计）：creative/product 页底近黑，但 EP 表格沿用库默认白面，
// 行内 tint 徽章（青 a10）合成出 #e6feff / #e6fff3，霓虹前景只剩 1.29 / 1.27。
// 根因不是 readable 接线，而是表面未主题化——readable 实算前提（深底）不成立。
// 本锁把「EP 行面」显式纳入：未声明 --el-fill-color-blank 的主题按 EP 库默认 #fff 判，
// 「某深色主题漏补表面 token」会直接红，而不是靠人工巡检。
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  ROOT,
  THRESHOLD,
  composite,
  loadAuxTheme,
  loadThemes,
  luminance,
  pageOf,
  resolve,
  rgbToHex,
  worstRatio,
  type RGB,
  type ThemeTokens,
} from './helpers/contrast';

/** EP 库默认值（node_modules/element-plus/theme-chalk/base.css，随安装版本读数） */
const EP_DEFAULT = {
  '--el-fill-color-blank': '#ffffff',
  '--el-fill-color-lighter': '#fafafa',
  '--el-fill-color-light': '#f5f7fa',
  '--el-text-color-regular': '#606266',
  '--el-text-color-secondary': '#909399',
  '--el-text-color-placeholder': '#a8abb2',
  '--el-color-primary': '#409eff',
  '--el-color-primary-light-9': '#ecf5ff',
} as const;

type EpToken = keyof typeof EP_DEFAULT;

/** 本单新接入的表面/文字/描边 token：少一个就会回落 EP 浅色默认值 */
const BRIDGE_TOKENS = [
  '--el-bg-color',
  '--el-bg-color-overlay',
  '--el-bg-color-page',
  '--el-text-color-primary',
  '--el-text-color-regular',
  '--el-text-color-secondary',
  '--el-text-color-placeholder',
  '--el-text-color-disabled',
  '--el-border-color',
  '--el-border-color-light',
  '--el-border-color-lighter',
  '--el-border-color-extra-light',
  '--el-fill-color',
  '--el-fill-color-light',
  '--el-fill-color-lighter',
  '--el-fill-color-blank',
  '--el-fill-color-dark',
  '--el-color-primary-light-9',
];

const ALL = [...loadThemes(), loadAuxTheme('dark')];
/** 应用首帧 useTheme.applyTheme 必写 data-theme，:root 不是可观测渲染态，不参与判定 */
const RENDERED = ALL.filter((t) => t.name !== 'default(:root)');
const DARK_ROW_THEMES = ['creative', 'product', 'dark(tokens.css)'];
/** 沿用 EP 库默认白行、且页底本来就是浅色的主题（本单有意不桥接，见巡检用例） */
const LIGHT_THEMES = ['ecommerce', 'enterprise', 'light-business', 'macaron', 'portfolio'];

const theme = (name: string): ThemeTokens => {
  const t = ALL.find((x) => x.name === name);
  if (!t) throw new Error(`主题 ${name} 不在 loadThemes/loadAuxTheme 结果里`);
  return t;
};

const solid = (expr: string, t: ThemeTokens) => {
  const r = resolve(expr, t.decls);
  if ('stops' in r) throw new Error(`面不应是渐变：${expr}`);
  return r.solid;
};
const ep = (t: ThemeTokens, name: EpToken) => t.decls.get(name) ?? EP_DEFAULT[name];
/** 表格实际落点面：行底压所在页（与浏览器合成一致） */
const faceOf = (t: ThemeTokens, name: EpToken) => composite(solid(ep(t, name), t), pageOf(t.decls));
const rowOf = (t: ThemeTokens) => faceOf(t, '--el-fill-color-blank');
const stripedOf = (t: ThemeTokens) => faceOf(t, '--el-fill-color-lighter');

/** Users.vue 源码里的原表达式（不是转写的近似式） */
const ROLE_USER_FG = 'var(--accent-readable, var(--neon-cyan))';
const ROLE_USER_BG = 'var(--accent-cyan-a10)';
const ROLE_GUEST_FG = 'var(--purple-readable, var(--neon-purple))';
const ROLE_GUEST_BG = 'var(--accent-purple-a10)';

describe('T04904 · 深色主题必须桥接 EP 表面', () => {
  it('声明的主题集合 = 页底为深色的主题集合（深色漏补 / 浅色乱补都红）', () => {
    const declaring = RENDERED.filter((t) => t.decls.has('--el-fill-color-blank')).map((t) => t.name).sort();
    expect(declaring).toEqual([...DARK_ROW_THEMES].sort());
    for (const t of RENDERED) {
      const deep = luminance(pageOf(t.decls)) < 0.2;
      expect(t.decls.has('--el-fill-color-blank'), `${t.name} 页底亮度 ${luminance(pageOf(t.decls)).toFixed(3)}，桥接状态与深浅不符`).toBe(deep);
    }
  });

  it('creative/product 的 18 个表面 token 全部显式映射到本主题变量（不抄字面量）', () => {
    for (const name of ['creative', 'product']) {
      const t = theme(name);
      for (const key of BRIDGE_TOKENS) {
        const v = t.decls.get(key);
        expect(v, `${name} 缺 ${key}——EP 会回落库默认浅色值`).toBeTruthy();
        expect(v, `${name} · ${key} 应映射到主题变量，实际 ${v}`).toMatch(/var\(--[\w-]+\)/);
      }
      expect(t.decls.get('--el-fill-color-blank')).toBe('var(--bg-deep)');
    }
  });

  it('行底/斑马行取值锁（映射到白色或浅色立即红）', () => {
    expect(rgbToHex(rowOf(theme('creative')))).toBe('#0a0118');
    expect(rgbToHex(stripedOf(theme('creative')))).toBe('#14082a');
    expect(rgbToHex(rowOf(theme('product')))).toBe('#050508');
    expect(rgbToHex(stripedOf(theme('product')))).toBe('#0a0a14');
    expect(rgbToHex(rowOf(theme('dark(tokens.css)')))).toBe('#161b22');
  });

  it('巡检：浅色主题沿用 EP 默认白行，白行与浅页底同类（不是漏补）', () => {
    expect(RENDERED.filter((t) => !DARK_ROW_THEMES.includes(t.name)).map((t) => t.name).sort()).toEqual(LIGHT_THEMES);
    for (const name of LIGHT_THEMES) {
      const t = theme(name);
      expect(rgbToHex(rowOf(t)), `${name} 行面应仍是 EP 默认白`).toBe('#ffffff');
      expect(luminance(pageOf(t.decls)), `${name} 页底不该是深色`).toBeGreaterThan(0.9);
    }
  });
});

describe('T04904 · 表格真实落点面', () => {
  it('8 主题 × {普通行, 斑马行}：.role-user / .role-guest 均达 AA 4.5', () => {
    const failures: string[] = [];
    for (const t of RENDERED) {
      for (const [face, row] of [['普通行', rowOf(t)], ['斑马行', stripedOf(t)]] as const) {
        for (const [label, fg, bg] of [
          ['.role-user', ROLE_USER_FG, ROLE_USER_BG],
          ['.role-guest', ROLE_GUEST_FG, ROLE_GUEST_BG],
        ] as const) {
          const r = worstRatio(fg, bg, t.decls, row);
          if (r < THRESHOLD.text) failures.push(`${t.name} · ${face} ${label} = ${r.toFixed(2)}（需 ≥ ${THRESHOLD.text}）`);
        }
      }
    }
    expect(failures, failures.join('\n  ')).toEqual([]);
  });

  it('桥接主题的 EP 行文字/表头文字/排序图标在行面上达标（文本 4.5 / 图标 3.0）', () => {
    const failures: string[] = [];
    for (const name of DARK_ROW_THEMES) {
      const t = theme(name);
      // EP：行文字=text-regular；表头文字=text-secondary；排序三角=text-placeholder
      for (const [label, token, kind] of [
        ['行文字', '--el-text-color-regular', 'text'],
        ['表头文字', '--el-text-color-secondary', 'text'],
        ['排序图标', '--el-text-color-placeholder', 'ui'],
      ] as const) {
        const r = worstRatio(ep(t, token), ep(t, '--el-fill-color-blank'), t.decls, pageOf(t.decls));
        if (r < THRESHOLD[kind]) failures.push(`${name} · ${label} = ${r.toFixed(2)}（需 ≥ ${THRESHOLD[kind]}）`);
      }
    }
    expect(failures, failures.join('\n  ')).toEqual([]);
  });

  it('源码接入锁：Users.vue 两个徽章前景仍走 readable 家族', () => {
    const src = readFileSync(join(ROOT, 'src/views/Users.vue'), 'utf8');
    expect(src).toContain(`.role-user { color: ${ROLE_USER_FG}; background: ${ROLE_USER_BG}; }`);
    expect(src).toContain(`.role-guest { color: ${ROLE_GUEST_FG}; background: ${ROLE_GUEST_BG}; }`);
  });

  it('负控制：撤掉桥接（EP 默认白行）时 .role-user 回落到 1.27~1.29（改前状态会让本锁红）', () => {
    for (const [name, want] of [['creative', 1.29], ['product', 1.27]] as const) {
      const decls = new Map(theme(name).decls);
      decls.delete('--el-fill-color-blank');
      const pre = { name, decls };
      expect(rgbToHex(rowOf(pre)), `${name} 负控制应回落到 EP 白行`).toBe('#ffffff');
      expect(worstRatio(ROLE_USER_FG, ROLE_USER_BG, decls, rowOf(pre)), `${name} 改前实测 ${want}`).toBeCloseTo(want, 2);
    }
  });
});

// T04906：5 个浅色主题此前没有任何 --el-* 覆盖，表头与排序三角直接落到 EP 库默认值
// （表头 #909399 白行 3.08、未激活三角 #a8abb2 2.30、激活三角 #409eff 2.78）。
// 本组把「白行上的表头/三角」从无人审的状态纳入实算：行面仍须是 EP 白（不改深行），
// 三项分别取本主题正文色 / soft / readable。tokens.css 的 EP 桥只在 [data-theme="dark"] 块里，
// 浅色主题不继承，故回落基准就是 EP_DEFAULT——负控制按此复现改前读数。
describe('T04906 · 浅色主题表头文字与排序三角（EP 白行）', () => {
  /** index.css 共享规则里激活三角的完整表达式（未声明 --sort-caret-active 时回落 EP 主色） */
  const SORT_CARET_ACTIVE = 'var(--sort-caret-active, var(--el-color-primary))';
  const ratio = (t: ThemeTokens, expr: string) =>
    worstRatio(expr, rgbToHex(rowOf(t)), t.decls, pageOf(t.decls));

  it('5 主题：表头文字 ≥4.5，未激活/激活排序三角 ≥3.0，行面仍为 EP 白', () => {
    const failures: string[] = [];
    for (const name of LIGHT_THEMES) {
      const t = theme(name);
      expect(rgbToHex(rowOf(t)), `${name} 行面应仍是 EP 默认白（不得借深行凑对比度）`).toBe('#ffffff');
      for (const [label, expr, kind] of [
        ['表头文字', 'var(--el-text-color-secondary)', 'text'],
        ['未激活三角', 'var(--el-text-color-placeholder)', 'ui'],
        ['激活三角', SORT_CARET_ACTIVE, 'ui'],
      ] as const) {
        const r = ratio(t, expr);
        if (r < THRESHOLD[kind]) failures.push(`${name} · ${label} = ${r.toFixed(2)}（需 ≥ ${THRESHOLD[kind]}）`);
      }
    }
    expect(failures, failures.join('\n  ')).toEqual([]);
  });

  it('取值锁：表头=正文色 / 未激活三角=soft / 激活三角=readable', () => {
    const want = {
      macaron: ['#5c4a66', '#8a7a96', '#2b7a6e'],
      enterprise: ['#1e293b', '#475569', '#046e80'],
      ecommerce: ['#2d2d3f', '#6b6b7d', '#006b93'],
      portfolio: ['#2d2d2d', '#5a5a5a', '#6f5b44'],
      'light-business': ['#2b2b2b', '#5a5f66', '#1554d1'],
    } as const;
    for (const [name, [header, placeholder, active]] of Object.entries(want)) {
      const t = theme(name);
      expect(rgbToHex(solid(ep(t, '--el-text-color-secondary'), t)), `${name} 表头`).toBe(header);
      expect(rgbToHex(solid(ep(t, '--el-text-color-placeholder'), t)), `${name} 未激活三角`).toBe(placeholder);
      expect(rgbToHex(solid(t.decls.get('--sort-caret-active')!, t)), `${name} 激活三角`).toBe(active);
    }
  });

  it('源码接入锁：5 主题声明三项 token，index.css 共享规则覆盖 EP 两个激活态', () => {
    for (const name of LIGHT_THEMES) {
      const src = readFileSync(join(ROOT, 'src/styles/themes', `${name}.css`), 'utf8');
      expect(src, `${name} 缺表头映射`).toContain('--el-text-color-secondary: var(--text-base);');
      expect(src, `${name} 缺未激活三角映射`).toContain('--el-text-color-placeholder: var(--text-soft);');
      expect(src, `${name} 缺激活三角映射`).toContain('--sort-caret-active: var(--accent-readable);');
    }
    const idx = readFileSync(join(ROOT, 'src/styles/themes/index.css'), 'utf8');
    expect(idx, 'index.css 缺 ascending 激活态覆盖').toContain(
      '.el-table .ascending .sort-caret.ascending { border-bottom-color: var(--sort-caret-active, var(--el-color-primary)); }',
    );
    expect(idx, 'index.css 缺 descending 激活态覆盖').toContain(
      '.el-table .descending .sort-caret.descending { border-top-color: var(--sort-caret-active, var(--el-color-primary)); }',
    );
  });

  it('负控制：撤掉三项映射后回落 EP 库默认 3.08 / 2.30 / 2.78（改前状态会让阈值锁红）', () => {
    for (const name of LIGHT_THEMES) {
      const decls = new Map(theme(name).decls);
      for (const k of ['--el-text-color-secondary', '--el-text-color-placeholder', '--sort-caret-active']) decls.delete(k);
      decls.set('--el-color-primary', EP_DEFAULT['--el-color-primary']);
      const pre = { name, decls };
      expect(rgbToHex(rowOf(pre)), `${name} 负控制行面应回落 EP 白`).toBe('#ffffff');
      expect(ratio(pre, ep(pre, '--el-text-color-secondary')), `${name} 表头改前 3.08`).toBeCloseTo(3.08, 2);
      expect(ratio(pre, ep(pre, '--el-text-color-placeholder')), `${name} 未激活三角改前 2.30`).toBeCloseTo(2.3, 2);
      expect(ratio(pre, SORT_CARET_ACTIVE), `${name} 激活三角改前 2.78`).toBeCloseTo(2.78, 2);
    }
  });
});

// T04905：users 页 .role-admin 是「亮字压实底」（color:--text-bright / background:--neon-magenta）。
// 改前 creative/product/dark/light-business 实测 3.27/3.77/2.84/4.07 < AA 4.5。徽章底是不透明实底，
// 对比度与行面深浅无关（普通行/斑马行同值，两腿都断言以证「实底」而非 tint）。底色单独取成对 token
// --role-admin-bg（深主题压深品红、light-business 提浅红），前景仍 --text-bright；未声明主题回落品牌品红
// （enterprise 4.85 / macaron 6.25 / ecommerce 6.02 / portfolio 7.73 实测达标，不改 --neon-magenta 本体）。
describe('T04905 · .role-admin 实底徽章（8 主题）', () => {
  const ROLE_ADMIN_FG = 'var(--text-bright)';
  const ROLE_ADMIN_BG = 'var(--role-admin-bg, var(--neon-magenta))';
  const ratio = (t: ThemeTokens, face: RGB) => worstRatio(ROLE_ADMIN_FG, ROLE_ADMIN_BG, t.decls, face);

  it('8 主题 × {普通行, 斑马行}：.role-admin 均达 AA 4.5（实底与行面无关）', () => {
    const failures: string[] = [];
    for (const t of RENDERED) {
      for (const [face, row] of [['普通行', rowOf(t)], ['斑马行', stripedOf(t)]] as const) {
        const r = ratio(t, row);
        if (r < THRESHOLD.text) failures.push(`${t.name} · ${face} .role-admin = ${r.toFixed(2)}（需 ≥ ${THRESHOLD.text}）`);
      }
    }
    expect(failures, failures.join('\n  ')).toEqual([]);
  });

  it('取值锁：4 失败主题取压深/提浅配对底，4 达标主题回落品牌品红；前景恒 --text-bright', () => {
    const want = {
      creative: ['#f3e9ff', '#c20052'],
      product: ['#ffffff', '#cc0066'],
      'dark(tokens.css)': ['#e6edf3', '#b62f28'],
      'light-business': ['#111111', '#e45252'],
      enterprise: ['#0f172a', '#3b82f6'],
      macaron: ['#4a3a52', '#ffb3d1'],
      ecommerce: ['#1a1a2e', '#ff6b35'],
      portfolio: ['#1a1a1a', '#c9a961'],
    } as const;
    for (const [name, [fg, bg]] of Object.entries(want)) {
      const t = theme(name);
      expect(rgbToHex(solid(ROLE_ADMIN_FG, t)), `${name} 前景`).toBe(fg);
      expect(rgbToHex(solid(ROLE_ADMIN_BG, t)), `${name} 底色`).toBe(bg);
    }
  });

  it('源码接入锁：Users.vue 徽章走成对 token，creative/product/light-business/dark 声明 --role-admin-bg', () => {
    const src = readFileSync(join(ROOT, 'src/views/Users.vue'), 'utf8');
    expect(src).toContain(`.role-admin { color: ${ROLE_ADMIN_FG}; background: ${ROLE_ADMIN_BG}; }`);
    for (const name of ['creative', 'product', 'light-business']) {
      const tsrc = readFileSync(join(ROOT, 'src/styles/themes', `${name}.css`), 'utf8');
      expect(tsrc, `${name} 缺 --role-admin-bg`).toContain('--role-admin-bg:');
    }
    const tokens = readFileSync(join(ROOT, 'src/styles/tokens.css'), 'utf8');
    expect(tokens, 'dark(tokens.css) 缺 --role-admin-bg').toContain('--role-admin-bg:');
  });

  it('负控制：撤掉 --role-admin-bg 回落品牌品红，4 主题复现改前 3.27/3.77/2.84/4.07', () => {
    for (const [name, want] of [['creative', 3.27], ['product', 3.77], ['dark(tokens.css)', 2.84], ['light-business', 4.07]] as const) {
      const decls = new Map(theme(name).decls);
      decls.delete('--role-admin-bg');
      const pre = { name, decls };
      expect(ratio(pre, rowOf(pre)), `${name} 改前实测 ${want}`).toBeCloseTo(want, 2);
    }
  });
});
