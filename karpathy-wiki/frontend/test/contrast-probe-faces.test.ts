// T04520 —— `--probe-{ok,warn,error}` 三态面：首次纳入可达径 + 逐主题取值定调锁。
//
// 缺陷不是「取值差一点没锁住」，而是**这一族从来没有可达径**：T04449 / T04470 / T04472 / T04509 / T04510
// 一路建下来的对比度锁，审计清单里没有任何一行引用 `--probe-*`。按 token 表达式 × 9 主题
// （含 tokens.css 的 dark 辅助主题）实算，6 个面 × 9 主题 = 54 个「前景 × 所在面」组合里 11 个跌破 AA：
//   5 个浅底主题的 `.probe-tag` 压自身 tint 面：ok 4.47、warn 4.40；
//   dark(tokens.css) 的 error 压 `rgba(248, 81, 73, 0.15)`（与前景同色相的 tint）4.35。
//
// 修法沿用已验证口径：只动**前景**这一档，`--success/--warning/--danger` 本体与 tint 面一律不动。
// 浅底两族没有可直接复用的 readable 档——实测 `--lime-readable` 在 5 个浅底主题是 4.06~4.20、
// `--warning-readable` 在 macaron 只有 4.49，接过来照样掉档，所以给字面量（绿/琥珀同色相压深一档）；
// dark 的 error 则直接接本主题继承到的 `--danger-readable`（#ff8a80，实算 6.39 / 外层 7.58），
// 不再造第三个红字面量——与 style.css:150「前景优先复用既有 readable 族」的口径一致。
//
// 五条腿：
//   A 取证（改前实况，永久留在仓库说明为什么非改不可）：把改前取值喂进**同一个判定口径**，必须恰好判红 11 条；
//   B 主锁：9 主题 × 3 态 × 2 面（`.probe-tag` 压 tint / 外层 `.url-proxy-probe` 压页底）= 54 次实算全达 AA；
//   C 定调表：逐主题登记 6 个 token 的取值，新主题未登记即红；
//   D 消费点结构锁：6 条规则仍在且前景仍取 `var(--probe-*)`；外层规则**无自声明底**（B 腿「压页底」判定的前提，
//     给它加底就会让这条腿变红并提醒换口径）；`:root` 声明齐 6 个 token（否则 Ingest.vue 里的字面 fallback
//     会成为真实生效值，改前的 4.47 静默回来）；全站 `--probe-*` 的引用文件只有已登记的这 8 个；
//   E 口径负控制（必须全绿）：tint 是真正的半透明面（alpha 0.15，合成后 ≠ 页底，「同色相自比」不会被误判成达标）、
//     54 次实算全部落在 [1, 21] 的有限区间内（解析器或口径出问题产出 NaN/Infinity 时本腿即红）。
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  ROOT,
  THRESHOLD,
  composite,
  loadAuxTheme,
  loadThemes,
  pageOf,
  resolve,
  ruleBodies,
  worstRatio,
  type AuditFailure,
  type AuditRow,
  type ThemeTokens,
} from './helpers/contrast';

const STATES = ['ok', 'warn', 'error'] as const;
const PROBE_TOKENS = ['--probe-ok', '--probe-ok-bg', '--probe-warn', '--probe-warn-bg', '--probe-error', '--probe-error-bg'];

/** 两个必须分别达标的面：标签实底色面 + 外层压页底（外层规则自己不带背景） */
const ROWS: AuditRow[] = STATES.flatMap(
  (st): AuditRow[] => [
    { label: `${st}·标签压 tint 面`, fg: `var(--probe-${st})`, bg: `var(--probe-${st}-bg)`, kind: 'text' },
    { label: `${st}·外层压页底`, fg: `var(--probe-${st})`, bg: 'transparent', kind: 'text' },
  ],
);

const ALL_THEMES: ThemeTokens[] = [...loadThemes(), loadAuxTheme('dark')];
const LIGHT = ['ecommerce', 'enterprise', 'light-business', 'macaron', 'portfolio'];

/** 逐主题逐面实算（本单自己的口径循环，不用 auditThemes，好把「实算次数」与「有限数」一并管住） */
function ratiosFor(t: ThemeTokens): Array<{ label: string; ratio: number; threshold: number }> {
  const page = pageOf(t.decls);
  return ROWS.map((r) => ({ label: r.label, ratio: worstRatio(r.fg, r.bg, t.decls, page), threshold: THRESHOLD[r.kind] }));
}
const withOverrides = (t: ThemeTokens, over: Record<string, string>): ThemeTokens => {
  const decls = new Map(t.decls);
  for (const [k, v] of Object.entries(over)) decls.set(k, v);
  return { name: t.name, decls };
};

/* ------------------------------------------------------------------ C 定调表 */

/**
 * 逐主题登记本族 6 个 token 的**生效取值**（主题未声明的回落 :root，与 loadThemes 的合并口径一致）。
 * 新主题进来必须在这里登记一行——否则 C 腿红，而不是悄悄继承一份没人校准过的三色。
 */
const PROBE_VALUES: Record<string, Record<string, string>> = {
  'default(:root)': {
    '--probe-ok': '#4ade80',
    '--probe-ok-bg': 'rgba(74, 222, 128, 0.15)',
    '--probe-warn': '#fbbf24',
    '--probe-warn-bg': 'rgba(251, 191, 36, 0.15)',
    '--probe-error': '#f87171',
    '--probe-error-bg': 'rgba(248, 113, 113, 0.15)',
  },
  // creative / product 不发 probe 三色，真的继承 :root（D 腿再验一次「文件里确实没有自己的声明」）
  creative: {},
  product: {},
  ecommerce: { '--probe-ok': '#166534', '--probe-ok-bg': '#e6f4ea', '--probe-warn': '#854d0e', '--probe-warn-bg': '#fdf3d7', '--probe-error': '#c62828', '--probe-error-bg': '#fdecea' },
  enterprise: { '--probe-ok': '#166534', '--probe-ok-bg': '#e6f4ea', '--probe-warn': '#854d0e', '--probe-warn-bg': '#fdf3d7', '--probe-error': '#c62828', '--probe-error-bg': '#fdecea' },
  'light-business': { '--probe-ok': '#166534', '--probe-ok-bg': '#e6f4ea', '--probe-warn': '#854d0e', '--probe-warn-bg': '#fdf3d7', '--probe-error': '#c62828', '--probe-error-bg': '#fdecea' },
  macaron: { '--probe-ok': '#166534', '--probe-ok-bg': '#e6f4ea', '--probe-warn': '#854d0e', '--probe-warn-bg': '#fdf3d7', '--probe-error': '#c62828', '--probe-error-bg': '#fdecea' },
  portfolio: { '--probe-ok': '#166534', '--probe-ok-bg': '#e6f4ea', '--probe-warn': '#854d0e', '--probe-warn-bg': '#fdf3d7', '--probe-error': '#c62828', '--probe-error-bg': '#fdecea' },
  // dark(tokens.css) 的 error 前景复用本主题继承到的 --danger-readable，不再留字面量
  'dark(tokens.css)': {
    '--probe-ok': '#3fb950',
    '--probe-ok-bg': 'rgba(63, 185, 80, 0.15)',
    '--probe-warn': '#d29922',
    '--probe-warn-bg': 'rgba(210, 153, 34, 0.15)',
    '--probe-error': 'var(--danger-readable)',
    '--probe-error-bg': 'rgba(248, 81, 73, 0.15)',
  },
};

/* ------------------------------------------------------------------ A 取证：改前取值 */

/** 改前只有 3 个 token 需要动，取证就按「原值 + 其余不变」喂进同一口径，逐字对得上工单里的 11 条 */
const BEFORE: Record<string, Record<string, string>> = {
  ...Object.fromEntries(LIGHT.map((n) => [n, { '--probe-ok': '#1a7f37', '--probe-warn': '#9a6700' }])),
  'dark(tokens.css)': { '--probe-error': '#f85149' },
};
const BEFORE_EXPECTED = [
  ...LIGHT.flatMap((n) => [`${n} · ok·标签压 tint 面`, `${n} · warn·标签压 tint 面`]),
  'dark(tokens.css) · error·标签压 tint 面',
].sort();

describe('T04520 · A 取证：改前取值喂进同一判定口径', () => {
  it('恰好 11 条跌破 AA，且全部是「压标签 tint 面」（外层压页底当时是达标的）', () => {
    const failures: AuditFailure[] = [];
    for (const t of ALL_THEMES) {
      const over = BEFORE[t.name];
      if (!over) continue;
      const merged = withOverrides(t, over);
      for (const r of ratiosFor(merged)) if (r.ratio < r.threshold) failures.push({ theme: t.name, label: r.label, ratio: r.ratio, threshold: r.threshold });
    }
    expect(failures.length, `改前未达标条数应与工单一致（11）：\n  ${failures.map((f) => `${f.theme} ${f.label} ${f.ratio.toFixed(3)}`).join('\n  ')}`).toBe(11);
    expect(failures.map((f) => `${f.theme} · ${f.label}`).sort()).toEqual(BEFORE_EXPECTED);
    const worst = Math.min(...failures.map((f) => f.ratio));
    expect(worst.toFixed(3)).toBe('4.352');
  });

  it('A2 · 改前的三个值当时没有任何锁引用（这就是「无可达径」的证据，不是「有余量没锁住」）', () => {
    const hit = testFilesReferencingProbe().filter((f) => !f.endsWith('contrast-probe-faces.test.ts'));
    expect(hit, `除本单新建的锁之外，不应存在别的 --probe-* 审计：${hit.join(' ')}`).toEqual([]);
  });
});

/* ------------------------------------------------------------------ B 主锁 */

describe('T04520 · B 主锁：9 主题 × 3 态 × 2 面实算达 AA', () => {
  const all = ALL_THEMES.flatMap((t) => ratiosFor(t).map((r) => ({ theme: t.name, ...r })));

  it('54 个组合（6 面 × 9 主题）全部 ≥ 4.5，未达标即红', () => {
    const failures = all.filter((r) => r.ratio < r.threshold);
    expect(failures, failures.map((f) => `${f.theme} · ${f.label} = ${f.ratio.toFixed(2)}（需 ≥ ${f.threshold}）`).join('\n  ')).toEqual([]);
  });

  it('规模锁：主题数 9、面数 6、实算次数 54（少一个主题或一面说明清单失守，而不是「更严」）', () => {
    expect(ALL_THEMES.map((t) => t.name)).toEqual(['default(:root)', 'creative', 'ecommerce', 'enterprise', 'light-business', 'macaron', 'portfolio', 'product', 'dark(tokens.css)']);
    expect(ROWS.length).toBe(6);
    expect(all.length).toBe(54);
  });

  it('最差侧登记：当前全站最差是浅底 error 压 tint 4.92（本单不动它，但它跌到 4.5 以下会被上一条抓住）', () => {
    const worst = all.reduce((a, b) => (b.ratio < a.ratio ? b : a));
    expect(worst.theme).toBe('ecommerce');
    expect(worst.label).toBe('error·标签压 tint 面');
    expect(worst.ratio.toFixed(2)).toBe('4.92');
  });
});

/* ------------------------------------------------------------------ C 定调表 */

describe('T04520 · C 取值定调锁', () => {
  it('C1 · 逐主题的 6 个 token 取值与定调一致；未登记的主题必须真的继承 :root', () => {
    const root = PROBE_VALUES['default(:root)'];
    for (const t of ALL_THEMES) {
      const want = PROBE_VALUES[t.name];
      expect(want, `主题 ${t.name} 不在定调表里（新主题要按本单口径登记取值）`).toBeTruthy();
      for (const token of PROBE_TOKENS) {
        const expected = want[token] ?? root[token];
        expect(expected, `定调表 :root 行漏登记 ${token}`).toBeTruthy();
        expect(t.decls.get(token), `${t.name} · ${token} 的取值与本单定调不一致`).toBe(expected);
      }
    }
  });

  it('C2 · 浅底五主题的 tint 面是同一套字面底色（前景压深只此一处口径；任何主题另起一张 tint 会被 C1 点名）', () => {
    const face = (t: ThemeTokens, tok: string) => t.decls.get(tok);
    for (const name of LIGHT) {
      const t = ALL_THEMES.find((x) => x.name === name) as ThemeTokens;
      expect(face(t, '--probe-ok-bg')).toBe('#e6f4ea');
      expect(face(t, '--probe-warn-bg')).toBe('#fdf3d7');
      expect(face(t, '--probe-error-bg')).toBe('#fdecea');
    }
  });

  it('C3 · dark 的 error 前景走 readable 族（不是再造字面红；readable 被别处改到不达标时由 B 腿兜住）', () => {
    const t = ALL_THEMES.find((x) => x.name === 'dark(tokens.css)') as ThemeTokens;
    expect(t.decls.get('--probe-error')).toBe('var(--danger-readable)');
    expect(t.decls.get('--danger-readable'), '本主题 --danger-readable 应继承自 :root（否则 var 链取到的是别处的值）').toBe('#ff8a80');
  });
});

/* ------------------------------------------------------------------ D 消费点结构锁 */

function walk(dir: string, out: string[] = []): string[] {
  for (const d of readdirSync(join(ROOT, dir), { withFileTypes: true })) {
    const rel = `${dir}/${d.name}`;
    if (d.isDirectory()) walk(rel, out);
    else if (/\.(vue|css)$/.test(rel)) out.push(rel);
  }
  return out;
}
function testFilesReferencingProbe(): string[] {
  const dir = join(ROOT, 'test');
  return readdirSync(dir)
    .filter((f) => f.endsWith('.test.ts'))
    .map((f) => join(dir, f))
    .filter((p) => /--probe-(ok|warn|error)\b/.test(readFileSync(p, 'utf8')));
}
const ingestSrc = () => readFileSync(join(ROOT, 'src/views/Ingest.vue'), 'utf8');

describe('T04520 · D 消费点结构锁', () => {
  /** 消费点写的是 var(--probe-x, 字面 fallback)，所以判定要认「token 名后面跟 , 或 )」两种收口 */
  const refsToken = (body: string, tok: string) => new RegExp(`var\\(${tok}[,)]`).test(body);

  it('六条规则都在，且前景仍取 var(--probe-*)', () => {
    for (const st of STATES) {
      const outer = ruleBodies(ingestSrc(), `.url-proxy-probe.probe-${st}`);
      expect(outer.length, `.url-proxy-probe.probe-${st} 规则丢失`).toBeGreaterThan(0);
      expect(refsToken(outer[0] as string, `--probe-${st}`), `${st} 外层前景不再引用 --probe-${st}`).toBe(true);
      const tag = ruleBodies(ingestSrc(), `.url-proxy-probe.probe-${st} .probe-tag`);
      expect(tag.length, `.url-proxy-probe.probe-${st} .probe-tag 规则丢失`).toBeGreaterThan(0);
      expect(refsToken(tag[0] as string, `--probe-${st}`), `${st} 标签前景不再引用 --probe-${st}`).toBe(true);
      expect(refsToken(tag[0] as string, `--probe-${st}-bg`), `${st} 标签底色不再引用 --probe-${st}-bg`).toBe(true);
    }
  });

  it('外层规则不许自带背景（B 腿「压页底」判定的前提；加了底就要改按 tint 面重算，不能让锁继续按旧口径绿着）', () => {
    for (const st of STATES) {
      const body = ruleBodies(ingestSrc(), `.url-proxy-probe.probe-${st}`)[0] as string;
      expect(/background/.test(body), `.url-proxy-probe.probe-${st} 自带了背景，压页底口径失效：${body.trim()}`).toBe(false);
    }
    expect(ruleBodies(ingestSrc(), '.url-proxy-probe .probe-tag')[0], '.probe-tag 基础规则不应自带背景（背景只属于三态）').not.toContain('background');
  });

  it('每个主题的 6 个 token 都有声明：消费点里的字面 fallback 才是永久不可达的', () => {
    const offenders: string[] = [];
    for (const t of ALL_THEMES) for (const tok of PROBE_TOKENS) if (!t.decls.get(tok)) offenders.push(`${t.name} ${tok}`);
    expect(offenders, `这些 token 缺声明，Ingest.vue 的字面 fallback 会变成真实生效值（改前的 4.47 会静默回来）：${offenders.join(' / ')}`).toEqual([]);
  });

  it('全站 --probe-* 的引用只允许出现在已登记的 8 个文件里（新接一处而不进本锁即红）', () => {
    const EXPECTED_FILES = [
      'src/style.css',
      'src/styles/tokens.css',
      ...LIGHT.map((n) => `src/styles/themes/${n}.css`),
      'src/views/Ingest.vue',
    ].sort();
    const hit = walk('src')
      .filter((f) => {
        if (f.startsWith('src/components/mobile/')) return false;
        return /--probe-(ok|warn|error)/.test(readFileSync(join(ROOT, f), 'utf8'));
      })
      .sort();
    expect(hit).toEqual(EXPECTED_FILES);
  });

  it('creative / product 不发本族三色（与定调表里的「继承 :root」一致，防止把表写成谎）', () => {
    for (const name of ['creative', 'product']) {
      const css = readFileSync(join(ROOT, `src/styles/themes/${name}.css`), 'utf8');
      expect(/--probe-/.test(css), `${name}.css 自带 --probe-* 声明，但定调表写的是继承 :root`).toBe(false);
    }
  });
});

/* ------------------------------------------------------------------ E 口径负控制 */

describe('T04520 · E 口径负控制（必须全绿）', () => {
  it('E1 · tint 是真正的半透明面：alpha 0.15、合成结果 ≠ 页底（同色相 tint 不会「自己等于自己」蒙过判定）', () => {
    for (const st of STATES) {
      const t = ALL_THEMES.find((x) => x.name === 'dark(tokens.css)') as ThemeTokens;
      const page = pageOf(t.decls);
      const tint = resolve(`var(--probe-${st}-bg)`, t.decls);
      if (!('solid' in tint)) throw new Error(`--probe-${st}-bg 在 dark 下不是纯色，本腿口径需要重新定义`);
      expect(tint.solid.a, `dark 的 --probe-${st}-bg alpha 应为 0.15`).toBe(0.15);
      const face = composite(tint.solid, page);
      expect(face.r === page.r && face.g === page.g && face.b === page.b, `--probe-${st}-bg 合成后与页底完全相同，说明 alpha 或面算错了`).toBe(false);
    }
  });

  it('E2 · 54 次实算全部是 [1, 21] 区间内的有限数（解析器出问题时不会静默产出 NaN 而「全都达标」）', () => {
    const all = ALL_THEMES.flatMap((t) => ratiosFor(t).map((r) => r.ratio));
    expect(all.length).toBe(54);
    for (const r of all) {
      expect(Number.isFinite(r), '出现 NaN/Infinity，判定口径失效').toBe(true);
      expect(r).toBeGreaterThanOrEqual(1);
      expect(r).toBeLessThanOrEqual(21);
    }
  });

  it('E3 · 把达标值换成改前的值，同一口径立刻判红（证明 B 腿有牙齿，不是恒绿）', () => {
    const seed = withOverrides(ALL_THEMES.find((x) => x.name === 'ecommerce') as ThemeTokens, { '--probe-ok': '#1a7f37' });
    const failures = ratiosFor(seed).filter((r) => r.ratio < r.threshold);
    expect(failures.length, '把 --probe-ok 换回改前值必须判红，否则本锁空转').toBe(1);
    expect(failures[0].label).toBe('ok·标签压 tint 面');
  });
});
