// T04510：对比度解析器补 `color-mix(in srgb, A p%, B)`，把「混色面进不了数值主锁」这个盲区关掉。
//
// 为什么要单独一条口径：T04472 收口时登记的验证缺口——resolve() 不认 color-mix，
// `.remove-btn:hover` 的混色面只能靠「构造性论证（混黑只降亮度）+ 结构断言（不许改回 --danger）」两条弱保证。
// 谁把 85% 改成 50%、把 black 改成 white、或换成别的颜色函数，数值口径一律看不见。
//
// 本文件四组腿：
//   M1 混合语义：srgb 按 gamma 编码分量插值、alpha **预乘**（否则 12% tint 会被 transparent 的黑底拉暗成假色）；
//   M2 口径纪律：认不出的写法必须抛，不许静默回落成某个颜色——猜错一个色就是假达标进主锁；
//   M3 源码事实：仓库里 4 处 color-mix 全部进得了解析器（混色面从此可实算）；
//   M4 顺带照亮：解析器一旦认得混色面，Dashboard 三枚状态徽标的 tint 面就有数了——
//      实测 14/24 组合不达 AA，本单只冻结事实不改色（改色归派生单）。
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  ROOT,
  THRESHOLD,
  composite,
  loadThemes,
  pageOf,
  resolve,
  ruleBodies,
  worstRatio,
  type RGB,
  type ThemeTokens,
} from './helpers/contrast';

function solidOf(expr: string, decls: Map<string, string>): RGB {
  const r = resolve(expr, decls);
  if ('stops' in r) throw new Error(`${expr} 解析成渐变，本腿要的是实色`);
  return r.solid;
}

/** 空 decls：只喂字面量，排除 token 取值对判定的干扰 */
const NO_TOKENS = new Map<string, string>();

describe('T04510 · M1 混色语义（srgb 编码分量 + 预乘 alpha）', () => {
  it('M1a · 混黑按登记比例缩亮度：#b3261e 85% × black → 各通道 ×0.85，alpha 不变', () => {
    const c = solidOf('color-mix(in srgb, #b3261e 85%, black)', NO_TOKENS);
    expect(c.a).toBeCloseTo(1, 10);
    expect(c.r).toBeCloseTo(0xb3 * 0.85, 6);
    expect(c.g).toBeCloseTo(0x26 * 0.85, 6);
    expect(c.b).toBeCloseTo(0x1e * 0.85, 6);
  });

  it('M1b · 比例写法等价：85% = 85.0% = 双边 15%/85%（合法写法不得算出三种色）', () => {
    const a = solidOf('color-mix(in srgb, #b3261e 85%, black)', NO_TOKENS);
    const b = solidOf('color-mix(in srgb, #b3261e 85.0%, black)', NO_TOKENS);
    const c = solidOf('color-mix(in srgb, black 15%, #b3261e 85%)', NO_TOKENS);
    expect(b).toEqual(a);
    expect(c).toEqual(a);
  });

  it('M1c · 预乘口径：X 12% × transparent 得「X 的色相 + a=0.12」，不是被黑底拉暗的 rgb(0.12X)', () => {
    const c = solidOf('color-mix(in srgb, #22c55e 12%, transparent)', NO_TOKENS);
    expect(c.r).toBeCloseTo(0x22, 6);
    expect(c.g).toBeCloseTo(0xc5, 6);
    expect(c.b).toBeCloseTo(0x5e, 6);
    expect(c.a).toBeCloseTo(0.12, 10);
    // 反证：非预乘的直接混会得出下面这组（那才是当初会造出「假面」的算法）
    expect(Math.abs(c.r - 0x22 * 0.12)).toBeGreaterThan(1);
  });

  it('M1d · 与同 alpha 的 rgba 等价：color-mix(…, X 12%, transparent) ≡ rgba(X, 0.12)', () => {
    // 这条是「主锁里的面是不是真面」的判据：黑 12% 混透明，压到页底后的落点必须与 rgba 写法逐通道相同。
    const mix = solidOf('color-mix(in srgb, #000000 12%, transparent)', NO_TOKENS);
    const rgba = solidOf('rgba(0, 0, 0, 0.12)', NO_TOKENS);
    expect(mix).toEqual(rgba);
    for (const t of loadThemes()) {
      const page = pageOf(t.decls);
      expect(composite(mix, page), `${t.name}：混色面压页底的落点与 rgba 不同`).toEqual(composite(rgba, page));
    }
  });

  it('M1e · 双边都不给比例时按 50/50，且 rgba 里的百分比不会被当成尾部比例劈开', () => {
    const half = solidOf('color-mix(in srgb, #000000, #ffffff)', NO_TOKENS);
    expect(half.r).toBeCloseTo(127.5, 6);
    expect(half.a).toBeCloseTo(1, 10);
    // rgba(0, 0, 0, 0.5) 结尾是 )，不是 %；若解析器按「尾部是 %」乱切，这条会得到错色
    const nested = solidOf('color-mix(in srgb, rgba(0, 0, 0, 0.5) 30%, white)', NO_TOKENS);
    expect(nested.a).toBeCloseTo(0.3 * 0.5 + 0.7 * 1, 10);
    expect(nested.r).toBeCloseTo((0.7 * 255) / nested.a, 6);
  });

  it('M1f · 两边都是 transparent 时按 a=0 收口，不得产出 NaN 通道（NaN 会让面「无声达标」）', () => {
    const c = solidOf('color-mix(in srgb, transparent 50%, transparent)', NO_TOKENS);
    expect(c.a).toBe(0);
    expect([c.r, c.g, c.b].every((v) => !Number.isNaN(v))).toBe(true);
  });

  it('M1g · token 走 var() 链与嵌套 fallback 都取到真实取值', () => {
    const decls = new Map([['--on-danger-bg', '#b3261e']]);
    expect(solidOf('color-mix(in srgb, var(--on-danger-bg) 85%, black)', decls)).toEqual(
      solidOf('color-mix(in srgb, #b3261e 85%, black)', NO_TOKENS),
    );
    // --nope 未声明 → 取 fallback #22c55e（fallback 里带括号也不能打乱切分）
    const fb = solidOf('color-mix(in srgb, var(--nope, #22c55e) 12%, transparent)', NO_TOKENS);
    expect(fb.g).toBeCloseTo(0xc5, 6);
    expect(fb.a).toBeCloseTo(0.12, 10);
  });
});

describe('T04510 · M2 口径纪律：认不出就抛，绝不回落成某个颜色', () => {
  const bad: Array<[string, string]> = [
    ['未知色彩空间', 'color-mix(in oklab, #b3261e 85%, black)'],
    ['非 srgb 的 hsl', 'color-mix(in hsl, white 50%, black)'],
    ['渐变操作数', 'color-mix(in srgb, linear-gradient(#ffffff, #000000) 50%, black)'],
    ['双边比例和不为 100', 'color-mix(in srgb, #b3261e 70%, black 70%)'],
    ['只有一个操作数', 'color-mix(in srgb, #b3261e 85%)'],
    ['三个操作数', 'color-mix(in srgb, #b3261e 60%, black 20%, white 20%)'],
    ['口径外的命名色', 'color-mix(in srgb, rebeccapurple 50%, black)'],
    ['括号不配平的坏语法', 'color-mix(in srgb, var(--x, #000 85%, black)'],
  ];
  for (const [why, expr] of bad) {
    it(`M2 · ${why} 必须抛错：${expr}`, () => {
      expect(() => resolve(expr, new Map([['--x', '#b3261e']]))).toThrow(/无法解析|不在解析口径内|操作数|渐变|比例/);
    });
  }

  it('M2b · 抛错信息带上原表达式与原因，不能只说「解析失败」（否则定位一次要翻源码）', () => {
    const err = (() => {
      try {
        resolve('color-mix(in oklab, #b3261e 85%, black)', NO_TOKENS);
      } catch (e) {
        return (e as Error).message;
      }
      throw new Error('应当抛错却没有抛');
    })();
    expect(err).toContain('oklab');
    expect(err).toContain('color-mix(in oklab, #b3261e 85%, black)');
  });
});

describe('T04510 · M3 源码事实：仓库里的 color-mix 全部进得了解析器', () => {
  const FILES = ['src/components/AttachmentUploader.vue', 'src/views/Dashboard.vue'];
  const sites = FILES.flatMap((f) => {
    const css = readFileSync(join(ROOT, f), 'utf8');
    return [...css.matchAll(/color-mix\([^;]*/g)].map((m) => ({ file: f, expr: m[0].trim().replace(/;$/, '') }));
  });

  it('M3a · 现存 4 处混色写法逐主题解析全部不抛（此前 Dashboard 三面必抛，是数值主锁的盲区）', () => {
    expect(sites.length, '混色落点数变了要先核对是不是新增了 color-mix').toBe(4);
    for (const s of sites) {
      for (const t of loadThemes()) {
        expect(() => resolve(s.expr, t.decls), `${s.file} 的面在 ${t.name} 下解析失败`).not.toThrow();
      }
    }
  });

  it('M3b · tint 型混色的面保持本色相、只带登记 alpha（深底主题不会把它算成暗面）', () => {
    const exprs = sites.map((s) => s.expr).filter((e) => /transparent\)/.test(e));
    expect(exprs.length).toBe(3);
    const base: Record<string, string> = {
      'var(--success, #22c55e)': '#22c55e',
      'var(--danger, #ef4444)': '#ef4444',
      'var(--warning, #f59e0b)': '#f59e0b',
    };
    for (const expr of exprs) {
      const operand = /color-mix\(\s*in\s+srgb\s*,\s*(.+?)\s+[\d.]+%\s*,/.exec(expr)![1];
      const c = solidOf(expr, NO_TOKENS);
      const plain = solidOf(base[operand], NO_TOKENS);
      expect(c.r, `${expr} 的色相被 transparent 拉偏了`).toBeCloseTo(plain.r, 6);
      expect(c.g, `${expr} 的色相被 transparent 拉偏了`).toBeCloseTo(plain.g, 6);
      expect(c.b, `${expr} 的色相被 transparent 拉偏了`).toBeCloseTo(plain.b, 6);
      expect(c.a).toBeCloseTo(0.12, 10);
    }
  });

  it('M3c · 混色面进 worstRatio 后有确定数值（可实算 = 可判定，不再是只能论证）', () => {
    const themes: ThemeTokens[] = loadThemes();
    for (const t of themes) {
      const page = pageOf(t.decls);
      const danger = solidOf('color-mix(in srgb, var(--on-danger-bg) 85%, black)', t.decls);
      expect(danger.a, `${t.name}：hover 面不该是半透明`).toBeCloseTo(1, 10);
      const ratio = worstRatio('#ffffff', 'color-mix(in srgb, var(--on-danger-bg) 85%, black)', t.decls, page);
      expect(ratio, `${t.name}：白字压混色面的实测值应在正常量级`).toBeGreaterThan(1);
    }
  });
});

describe('T04510 · M4 解析器顺带照亮的既有面（测量并冻结，不在本单改色）', () => {
  /**
   * 补上 color-mix 后，Dashboard 三枚状态徽标第一次进得了数值口径：
   * 「本色文字压自己的 12% tint」在浅底主题里大面积不达 AA（实测 14/24 组合，最差 macaron·running 2.20）。
   * 本单只登记事实、不改色（改色与配对 token 归派生单）；基线只降不升——
   * 新增未达标组合即红，修好了要同步把对应行删掉，否则「已修」会被过期基线掩盖。
   */
  const BADGES = ['.status-done', '.status-failed', '.status-running'];
  const FAIL_BASELINE = [
    '.status-done × ecommerce', '.status-done × enterprise', '.status-done × light-business', '.status-done × macaron', '.status-done × portfolio',
    '.status-failed × ecommerce', '.status-failed × enterprise', '.status-failed × light-business', '.status-failed × macaron',
    '.status-running × ecommerce', '.status-running × enterprise', '.status-running × light-business', '.status-running × macaron', '.status-running × portfolio',
  ];

  function badgeFailures(): string[] {
    const dash = readFileSync(join(ROOT, 'src/views/Dashboard.vue'), 'utf8');
    const out: string[] = [];
    for (const sel of BADGES) {
      const body = ruleBodies(dash, sel);
      expect(body.length, `Dashboard 找不到 ${sel} 规则（徽标改名的同时要更新本腿）`).toBe(1);
      const fg = /(?:^|;)[ \t\r\n]*color[ \t]*:[ \t]*([^;]+)/.exec(body[0])![1].trim();
      const bg = /(?:^|;)[ \t\r\n]*background[ \t]*:[ \t]*([^;]+)/.exec(body[0])![1].trim();
      for (const t of loadThemes()) {
        if (worstRatio(fg, bg, t.decls, pageOf(t.decls)) < THRESHOLD.text) out.push(`${sel} × ${t.name}`);
      }
    }
    return out;
  }

  it('M4 · 未达标组合必须与基线逐条相同（多了=新缺陷即红，少了=已修要同步删行）', () => {
    const got = badgeFailures();
    expect(got.filter((k) => !FAIL_BASELINE.includes(k)), `基线外的新未达标组合`).toEqual([]);
    expect(FAIL_BASELINE.filter((k) => !got.includes(k)), `这些组合已达标，要从 FAIL_BASELINE 删掉（防止「已修」被过期基线掩盖）`).toEqual([]);
    expect(got.sort()).toEqual([...FAIL_BASELINE].sort());
  });
});
