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
//   M4 徽标面主锁（T04521）：解析器认得混色面后，Dashboard 三枚状态徽标进数值口径——
//      T04510 当年只冻结「14/24 不达」的事实（改色归派生单），派生单修完后本腿已翻成
//      「9 主题 × 3 徽标 = 27 组 0 未达标」硬锁，原 FAIL_BASELINE 整张删除，另留 M4e 取证腿
//      复现改前的 14 条（保证这锁判的是真实落点，不是被口径放过）。
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  ROOT,
  THRESHOLD,
  composite,
  loadAuxTheme,
  loadThemes,
  pageOf,
  parseRootDecls,
  resolve,
  ruleBodies,
  themeBlockDecls,
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

describe('T04521 · M4 徽标面主锁：解析器照亮之后，三面 27 组必须 0 未达标', () => {
  /**
   * T04510 落地时，这一腿只做「冻结事实」（14 条 FAIL_BASELINE，不改色），改色归派生单。
   * 派生单 T04521 已按 T04472 的「一个面给一对 token」口径收口：面保持本色的 12% tint
   * （淡底徽标是设计语义），只把前景换成 --on-status-<态>-fg，逐主题实算到 ≥4.5。
   * 原 FAIL_BASELINE 表随本单整张删除 —— 0 未达标才是这条腿现在的判据。
   *
   * 定调时试过复用既有族，实测不过才落字面量（口径见 style.css:150）：
   * - failed 复用 --danger-readable：9 主题全达标（5.13~7.30）→ :root 直接接族，无人需要覆盖；
   * - running 复用 --warning-readable：3 个浅底主题 4.41~4.49 差一口气 → 那 5 主题给字面量 #854d0e；
   * - done 复用同族 --on-badge-green-fg：本面是 color-mix(--success 12%)、徽章面是
   *   rgba(74,222,128,.1)，两张面不同，实算只有 4.20~4.43 → 必须另给 token。
   */
  const BADGES = ['.status-done', '.status-failed', '.status-running'] as const;
  const LIGHT = ['ecommerce', 'enterprise', 'light-business', 'macaron', 'portfolio'];
  /** 主题全集（含 tokens.css 的辅助暗色主题：徽标在它下面同样要读得清） */
  const ALL_THEMES: ThemeTokens[] = [...loadThemes(), loadAuxTheme('dark')];

  /** 定调表：逐主题「解析后的前景色」。记解析结果而不是声明原文 —— 未覆盖的主题必须真的取到那个色 */
  const FG_VALUES: Record<string, Record<(typeof BADGES)[number], string>> = {
    'default(:root)': { '.status-done': '#4ade80', '.status-failed': '#ff8a80', '.status-running': '#ffb347' },
    creative: { '.status-done': '#4ade80', '.status-failed': '#ff8a80', '.status-running': '#ffb347' },
    product: { '.status-done': '#4ade80', '.status-failed': '#ff8a80', '.status-running': '#ffb347' },
    'dark(tokens.css)': { '.status-done': '#3fb950', '.status-failed': '#ff8a80', '.status-running': '#ffb347' },
    ecommerce: { '.status-done': '#166534', '.status-failed': '#b52e2e', '.status-running': '#854d0e' },
    enterprise: { '.status-done': '#166534', '.status-failed': '#b52e2e', '.status-running': '#854d0e' },
    'light-business': { '.status-done': '#166534', '.status-failed': '#b3261e', '.status-running': '#854d0e' },
    macaron: { '.status-done': '#166534', '.status-failed': '#a83a3a', '.status-running': '#854d0e' },
    portfolio: { '.status-done': '#166534', '.status-failed': '#8c1d1d', '.status-running': '#854d0e' },
  };

  /** 改前写法（前景 = 与面同源的本色）：只用于取证腿，证明主锁判的是真实落点而不是被口径放过 */
  const BEFORE_FG: Record<(typeof BADGES)[number], string> = {
    '.status-done': 'var(--success, #22c55e)',
    '.status-failed': 'var(--danger, #ef4444)',
    '.status-running': 'var(--warning, #f59e0b)',
  };
  /** T04510 当年实测、并被本单修掉的 14 条（8 主题口径，dark(tokens.css) 当时三面都过） */
  const BEFORE_FAILED = [
    '.status-done × ecommerce', '.status-done × enterprise', '.status-done × light-business', '.status-done × macaron', '.status-done × portfolio',
    '.status-failed × ecommerce', '.status-failed × enterprise', '.status-failed × light-business', '.status-failed × macaron',
    '.status-running × ecommerce', '.status-running × enterprise', '.status-running × light-business', '.status-running × macaron', '.status-running × portfolio',
  ];

  const dash = readFileSync(join(ROOT, 'src/views/Dashboard.vue'), 'utf8');

  function face(sel: string): { fg: string; bg: string } {
    const bodies = ruleBodies(dash, sel);
    expect(bodies.length, `Dashboard 找不到 ${sel} 规则（徽标改名的同时要更新本腿）`).toBe(1);
    const fg = /(?:^|;)[ \t\r\n]*color[ \t]*:[ \t]*([^;]+)/.exec(bodies[0]);
    const bg = /(?:^|;)[ \t\r\n]*background[ \t]*:[ \t]*([^;]+)/.exec(bodies[0]);
    expect(fg, `${sel} 规则里没有 color`).not.toBeNull();
    expect(bg, `${sel} 规则里没有 background`).not.toBeNull();
    return { fg: fg![1].trim(), bg: bg![1].trim() };
  }

  /** 一次实算全部「徽标 × 主题」，把每条的比值都带回去（不返回精简数组，避免口径被压缩后看不见） */
  function measure(fgOf: (sel: (typeof BADGES)[number]) => string, themes: ThemeTokens[]) {
    return BADGES.flatMap((sel) => {
      const { bg } = face(sel);
      const fg = fgOf(sel);
      return themes.map((t) => ({
        key: `${sel} × ${t.name}`,
        theme: t.name,
        sel,
        ratio: worstRatio(fg, bg, t.decls, pageOf(t.decls)),
      }));
    });
  }

  it('M4 · 27 个「徽标 × 主题」组合全部 ≥ 4.5（不达即红，不再走「冻结基线」）', () => {
    const bad = measure((sel) => face(sel).fg, ALL_THEMES).filter((r) => r.ratio < THRESHOLD.text);
    expect(bad.map((b) => `${b.key} → ${b.ratio.toFixed(2)}`)).toEqual([]);
  });

  it('M4b · 规模锁：9 主题 × 3 徽标 = 27 次实算，主题清单逐字（少一个不是「更严」，是清单失守）', () => {
    const rows = measure((sel) => face(sel).fg, ALL_THEMES);
    expect(ALL_THEMES.map((t) => t.name)).toEqual([
      'default(:root)', 'creative', 'ecommerce', 'enterprise', 'light-business', 'macaron', 'portfolio', 'product', 'dark(tokens.css)',
    ]);
    expect(rows.length).toBe(27);
    // 每条都必须是可判定的有限数：解析器出问题时产 NaN 会让上面那条「全部 ≥4.5」无声通过
    for (const r of rows) {
      expect(Number.isFinite(r.ratio) && r.ratio >= 1 && r.ratio <= 21, `${r.key} 比值异常`).toBe(true);
    }
  });

  it('M4c · 定调表：逐主题解析后的前景色必须与登记一致（表与代码脱钩即红）', () => {
    for (const t of ALL_THEMES) {
      const want = FG_VALUES[t.name];
      expect(want, `${t.name} 不在定调表里：新增主题要显式登记三面取值`).toBeDefined();
      for (const sel of BADGES) {
        const tok = `--on-status-${sel.replace('.status-', '')}-fg`;
        const r = resolve(`var(${tok})`, t.decls);
        expect('stops' in r, `${t.name} 的 ${tok} 解析成了渐变`).toBe(false);
        const solid = (r as { solid: RGB }).solid;
        expect(Math.round(solid.a * 100), `${t.name} 的 ${tok} 不该是半透明`).toBe(100);
        const got = `#${[solid.r, solid.g, solid.b].map((v) => Math.round(v).toString(16).padStart(2, '0')).join('')}`;
        expect(got, `${t.name} · ${tok}`).toBe(want![sel]);
      }
    }
  });

  it('M4d · 面口径前提：三面仍是「本色 12% 混透明」（比例按数值解析，换面即点名）', () => {
    for (const sel of BADGES) {
      const { fg, bg } = face(sel);
      const base = BEFORE_FG[sel];
      expect(fg, `${sel} 的前景不再是 token 供给（改回本色前景就是本单的回退）`).toContain('--on-status-');
      const m = /^color-mix\(\s*in\s+srgb\s*,\s*(.+?)\s+([\d.]+)%\s*,\s*transparent\s*\)$/.exec(bg);
      expect(m, `${sel} 的混色面写法变了：口径（压 tint 面）要跟着重定，不能留这条腿假绿`).not.toBeNull();
      expect(m![1].trim(), `${sel} 的面不再是前景那个本色`).toBe(base);
      // 「12.0%」与「12%」是同一个口径：只改比例写法不该误伤，改数值才是换面
      expect(Number(m![2]), `${sel} 的 tint 比例被改了`).toBe(12);
    }
  });

  it('M4e · 取证腿：把改前写法喂进同一口径，恰好复现当年的 14 条不达（证明 M4 有牙齿）', () => {
    const got = measure((sel) => BEFORE_FG[sel], loadThemes()).filter((r) => r.ratio < THRESHOLD.text);
    expect(got.map((r) => r.key).sort()).toEqual([...BEFORE_FAILED].sort());
    expect(Math.min(...got.map((r) => r.ratio))).toBeCloseTo(2.203, 2);
    // dark(tokens.css) 三面当时就达标 —— 所以当年那份基线不是「漏了一个主题」，而是口径本就没含它
    const darkRows = measure((sel) => BEFORE_FG[sel], [loadAuxTheme('dark')]);
    expect(darkRows.filter((r) => r.ratio < THRESHOLD.text)).toEqual([]);
    expect(darkRows.map((r) => Number(r.ratio.toFixed(2))).sort((a, b) => a - b)).toEqual([4.53, 5.64, 5.68]);
  });

  it('M4f · 五个浅底主题各自自带 done/running 覆盖（漏一个会静默继承 :root 本色，要点名到主题）', () => {
    // 判「这个主题块里真的声明了这个 token」，不判「文件里出现过这个色」——
    // #854d0e 在浅底主题里同时是 T04520 三态探测标签 warn 前景的取值，按色文搜索会假绿。
    const OVERRIDE: Record<string, string> = { '--on-status-done-fg': '#166534', '--on-status-running-fg': '#854d0e' };
    for (const name of LIGHT) {
      const own = themeBlockDecls(readFileSync(join(ROOT, 'src/styles/themes', `${name}.css`), 'utf8'), name);
      for (const [tok, hex] of Object.entries(OVERRIDE)) {
        expect(own.get(tok), `${name}.css 的 [data-theme="${name}"] 块缺 ${tok} 覆盖（会静默继承 :root 的本色前景）`).toBe(hex);
      }
      // failed 全域不覆盖：它靠 :root 接 --danger-readable，各主题那份族成员本就达标
      expect(own.has('--on-status-failed-fg'), `${name}.css 不该给 failed 另起取值（会把 --danger-readable 族绕过去）`).toBe(false);
    }
    expect(parseRootDecls().get('--on-status-failed-fg'), ':root 的 failed 前景必须接 --danger-readable 族').toMatch(/^var\(--danger-readable/);
  });
});

