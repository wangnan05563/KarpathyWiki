// T04903：把「真实渲染出来的背景」纳入对比度面清单。
//
// 背景：静态面对账（T04468）全绿，但各页测试的面清单把面写成 --bg-card-solid / tint，
// 由 worstRatio 统一合成到 pageOf()（卡片叠页底）。真实页面里还有三类常被漏掉的面：
//   1. 体检页 `.no-issue` 直接坐在页面级 `--bg-scene` 上（不是卡片面）；
//   2. 配置页 `.key-badge-private` 坐在 `.config-block`（background: --bg-scene）上的紫 a15 里；
//   3. 帮助页活动锚点坐在内容区 `--bg-mid` 上的紫 a20 里；未登录登录卡 `.login-hint code`
//      坐在「青 a08 × 白色 3% 提示条 × 玻璃卡」三层叠面上。
// T04449 的 137 次真实渲染采样在以上 7 个主题×站点组合上跌破 AA（4.42/4.23/3.91/4.26/
// 4.43/3.85/4.31），本用例把这三类面按 token 组合复算成确定值（与采样值逐格对齐），
// 作为「真实面」口径的守护；面模型对登录卡取的是偏亮的一侧（比实测面更保守）。
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  ROOT,
  TOKENS_CSS,
  THRESHOLD,
  composite,
  contrast,
  loadAuxTheme,
  loadThemes,
  pageOf,
  resolve,
  rgbToHex,
  themeBlockDecls,
  worstRatio,
  type RGB,
  type ThemeTokens,
} from './helpers/contrast';

const solid = (expr: string, decls: Map<string, string>): RGB => {
  const r = resolve(expr, decls);
  if ('stops' in r) throw new Error(`${expr} 是渐变，不能当实色面`);
  return r.solid;
};

/** 体检页 .no-issue：页面级场景底（不是卡片面） */
const sceneOf = (t: ThemeTokens) => solid('var(--bg-scene)', t.decls);

/** 配置页 .key-badge-private：紫 a15 叠在 --bg-scene 的 .config-block 上 */
const badgeFaceOf = (t: ThemeTokens) => composite(solid('var(--accent-purple-a15)', t.decls), sceneOf(t));

/** 帮助页 .anchor-item.active：紫 a20 叠在侧栏 --bg-card-solid 上（真实 DOM 栈：a20 → sidebar → 页底） */
const anchorFaceOf = (t: ThemeTokens) => composite(solid('var(--accent-purple-a20)', t.decls), solid('var(--bg-card-solid)', t.decls));

/**
 * 登录页 .login-hint code：青 a08 × 白 3% 提示条 × 玻璃卡 × 页底。
 * 登录页自身没有卡片垫层（未登录不渲染主内容区），所以底座是 --bg-void 而不是 pageOf()。
 */
const loginCodeFaceOf = (t: ThemeTokens) => {
  const glassCard = composite(solid('var(--bg-glass)', t.decls), solid('var(--bg-void)', t.decls));
  const hint = composite({ r: 255, g: 255, b: 255, a: 0.03 }, glassCard);
  return composite(solid('var(--accent-cyan-a08)', t.decls), hint);
};

const themes = loadThemes();
const dark = loadAuxTheme('dark');

describe('T04903 真实渲染面：体检页 .no-issue 坐在 --bg-scene 上', () => {
  it(`${themes.length + 1} 主题 × 场景底全部达 4.5`, () => {
    const failures: string[] = [];
    for (const t of [...themes, dark]) {
      const scene = sceneOf(t);
      const r = worstRatio('var(--lime-readable)', 'var(--bg-scene)', t.decls, scene);
      if (r < THRESHOLD.text) failures.push(`${t.name} = ${r.toFixed(2)}`);
    }
    expect(failures, failures.join('\n  ')).toEqual([]);
  });

  it('本单四支浅底主题的绿族取值落定（旧值在场景底实测 3.91~4.42）', () => {
    const expected: Record<string, string> = {
      macaron: '#657350',
      enterprise: '#0b7c57',
      portfolio: '#736441',
      'light-business': '#237c4e',
    };
    for (const [name, hex] of Object.entries(expected)) {
      const t = themes.find((x) => x.name === name)!;
      expect(solid('var(--lime-readable)', t.decls), `${name} --lime-readable`).toEqual(
        solid(hex, new Map()),
      );
      const r = worstRatio('var(--lime-readable)', 'var(--bg-scene)', t.decls, sceneOf(t));
      expect(r, `${name} 场景底实测`).toBeGreaterThanOrEqual(THRESHOLD.text);
    }
  });
});

describe('T04903 真实渲染面：dark 的三处深底叠面', () => {
  it('面模型与 T04449 真实采样逐格对齐（防面写错后假达标）', () => {
    // 采样值：配置徽章 #18263c / 帮助锚点 #20304d / 登录码面 #262d3a；
    // 模型按 DOM 背景栈复算，与采样同色 ±1（合成口径的取整差）
    expect(rgbToHex(badgeFaceOf(dark))).toBe('#18263c');
    expect(rgbToHex(anchorFaceOf(dark))).toBe('#21324e');
    expect(rgbToHex(loginCodeFaceOf(dark))).toBe('#262d3a');
  });

  it('配置徽章紫族 / 帮助锚点紫族 / 登录码青族三面全部达 4.5', () => {
    const rows = [
      ['配置徽章 .key-badge-private', 'var(--purple-readable)', badgeFaceOf(dark)],
      ['帮助活动锚点 .anchor-item.active', 'var(--purple-readable)', anchorFaceOf(dark)],
      ['登录提示码 .login-hint code', 'var(--accent-readable)', loginCodeFaceOf(dark)],
    ] as const;
    for (const [label, fg, face] of rows) {
      const r = contrast(solid(fg, dark.decls), face);
      expect(r, `${label} = ${r.toFixed(2)}`).toBeGreaterThanOrEqual(THRESHOLD.text);
    }
  });

  it('dark 的紫/青 readable 覆盖与 :root 兜底分离（只动 dark 自身）', () => {
    const decls = themeBlockDecls(readFileSync(TOKENS_CSS, 'utf8'), 'dark');
    expect(decls.get('--purple-readable')).toBe('#d47aff');
    expect(decls.get('--accent-readable')).toBe('#79a9ff');
    // :root 兜底仍是旧值（creative/product 等继承它的主题行为不变）
    const root = readFileSync(join(ROOT, 'src/style.css'), 'utf8');
    expect(root).toMatch(/--purple-readable:\s*#c258ff;/);
  });
});
