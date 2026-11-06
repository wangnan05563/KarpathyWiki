// T04524 —— `--cite-hit-{bg,fg}`（引用溯源命中高亮）首次纳入可达径 + 模态面口径实算锁。
//
// 这族 token 的缺陷不是「取值差一点没锁住」，而是**从来没有可达径**：
//   - 除 tokens.css 的 dark 块外，`--cite-hit-bg` 在任何主题文件里都没声明过 → token 级实算锁看不见它；
//   - 它的落点在弹窗内，而 T04449/T04470 的普查只列页面级规则 → 页面清单也没有它。
// 生效值因此是 CitationModal.vue 里的字面 fallback `rgba(255,213,79,.55)`（8/9 主题），
// 按本单新定的**模态面**口径实算，3 套深底主题（default/creative/product）两张落点全部跌破 AA
// （3.94~4.07），其余 6 套 7.08~9.99 达标。取证阶段还纠正了一处口径错误：
// 遮罩不是 element-plus 的 `--el-overlay-color-lighter`，而是 modal.css 覆盖后的 `--modal-mask`
// （main.ts 里 modal.css 最后导入，同特异性后来者胜）—— 照抄 EP 默认值会把整族数字算偏一档。
//
// 修法沿用已验证口径：**面优先不动，只把达标值 token 化**。
//   :root 给 `rgba(255,213,79,.9)`（与 tokens.css 里 dark 那一档同一个值，实算 9.92~9.93），
//   5 套浅底主题各自覆盖回 `.55`（它们本就达标，观感逐字节不变），
//   组件 fallback 抬到与 :root 同值 —— 未登记的新主题必须落到达标档（fail closed）。
//   不动 `--bg-card-solid` 本体（全站卡片语言，牵一发动全身）。
//
// 六条腿：
//   A 取证：改前生效值喂进**同一模态口径**，必须恰好判红 6 条（3 主题 × 2 落点），并复现「改前无人审计」；
//   B 主锁：9 主题 × 2 张落点 = 18 次实算全达 AA + 规模锁 + 最差侧登记；
//   C 定调表：逐主题登记两个 token 的生效声明，未登记主题必须真的继承 :root；
//   D 面口径前提：遮罩来源仍是 modal.css、EP 那份变量原值留档、对话框仍取 --bg-card-solid、
//     .citation-* 容器不得自带背景（任一前提被破坏 → B 腿的数字失去意义，本腿先红）；
//   E 可达径：消费点仍引用两个 token、每主题都有声明（字面 fallback 永久不可达）、
//     fallback 与 :root 同值、全站引用文件清单已登记；
//   F 口径负控制：两张落点确实不同且都不等于页底、18 次实算是 [1,21] 内有限数、
//     值换回改前必红、前景换成白字必让浅底判红（证明锁盯的是**两头**而不是一个方向）。
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  EP_VAR_CSS,
  MODAL_CSS,
  ROOT,
  THRESHOLD,
  loadAuxTheme,
  loadThemes,
  modalFaces,
  overlayExpr,
  pageOf,
  resolve,
  ruleBodies,
  stripComments,
  themeBlockDecls,
  worstRatioOnFaces,
  type RGB,
  type ThemeTokens,
} from './helpers/contrast';

const CITE_BG = 'var(--cite-hit-bg, rgba(255, 213, 79, 0.9))';
const CITE_FG = 'var(--cite-hit-fg, #1a1a1a)';
const LIGHT = ['ecommerce', 'enterprise', 'light-business', 'macaron', 'portfolio'];
/** 主题全集（含 tokens.css 的辅助暗色主题：高亮片在它下面同样要读得清） */
const ALL_THEMES: ThemeTokens[] = [...loadThemes(), loadAuxTheme('dark')];
const FACE_LABELS = ['对话框覆盖处（遮罩压卡片）', '卡片外沿（遮罩压页底）'] as const;

/** 一次给一个主题算两张落点，把每条的比值都带回去（不压缩成数组，避免口径被压后看不见） */
function measure(t: ThemeTokens, bgExpr = CITE_BG, fgExpr = CITE_FG) {
  const faces = modalFaces(t);
  return faces.map((face, i) => ({
    key: `${t.name} · ${FACE_LABELS[i]}`,
    theme: t.name,
    face: i,
    ratio: worstRatioOnFaces(fgExpr, bgExpr, t.decls, [face]),
  }));
}
const solid = (expr: string, t: ThemeTokens): RGB => {
  const r = resolve(expr, t.decls);
  expect('stops' in r, `${t.name} 下 ${expr} 解析成了渐变，本锁口径需要重新定义`).toBe(false);
  return (r as { solid: RGB }).solid;
};

/* ------------------------------------------------------------------ A 取证 */

/**
 * 改前的生效面：8 套主题走组件字面 fallback `.55`，只有 tokens.css 的 dark 声明了 `.9`。
 * 这里直接喂**字面色**而不是 token —— 当时根本没有 :root 声明可解析，喂 token 会把自己骗过去。
 */
const BEFORE_BG = (name: string) => (name === 'dark(tokens.css)' ? 'rgba(255, 213, 79, 0.9)' : 'rgba(255, 213, 79, 0.55)');
const BEFORE_FAILED = ['default(:root)', 'creative', 'product'].flatMap((n) => FACE_LABELS.map((l) => `${n} · ${l}`)).sort();

describe('T04524 · A 取证：改前值喂进同一模态口径', () => {
  /** 逐主题改前的两张落点最差值（工单里的数字就是这张表） */
  const beforeWorst = Object.fromEntries(
    ALL_THEMES.map((t) => [t.name, Math.min(...measure(t, BEFORE_BG(t.name)).map((r) => r.ratio))]),
  ) as Record<string, number>;

  it('恰好 6 条跌破 AA（3 套深底主题 × 2 张落点），且失败方点名到主题', () => {
    const bad = ALL_THEMES.flatMap((t) => measure(t, BEFORE_BG(t.name))).filter((r) => r.ratio < THRESHOLD.text);
    expect(bad.map((b) => b.key).sort()).toEqual(BEFORE_FAILED);
    expect(bad.length).toBe(6);
    expect(beforeWorst['default(:root)'].toFixed(3)).toBe('3.958');
    expect(beforeWorst['creative'].toFixed(3)).toBe('3.958');
    expect(beforeWorst['product'].toFixed(3)).toBe('3.940');
  });

  it('A2 · 当年达标的 6 套不是「余量刚好够」：最差一档也有 7.09，两侧口径本来就分得很开', () => {
    const passed = Object.entries(beforeWorst).filter(([n]) => !BEFORE_FAILED.some((k) => k.startsWith(n)));
    expect(passed.map(([n]) => n).sort()).toEqual(['dark(tokens.css)', 'ecommerce', 'enterprise', 'light-business', 'macaron', 'portfolio']);
    expect(Math.min(...passed.map(([, v]) => v)).toFixed(3)).toBe('7.085');
  });

  it('A3 · 除本单新建的锁之外，仓库里不存在任何 --cite-hit-* 审计（缺的是可达径，不是余量）', () => {
    const hit = testFilesReferencingCiteHit().filter((f) => !f.endsWith('contrast-cite-hit-face.test.ts'));
    expect(hit, `不应存在别的 --cite-hit-* 审计：${hit.join(' ')}`).toEqual([]);
  });
});

/* ------------------------------------------------------------------ B 主锁 */

describe('T04524 · B 主锁：9 主题 × 2 张落点实算达 AA', () => {
  const all = ALL_THEMES.flatMap((t) => measure(t));

  it('18 个组合全部 ≥ 4.5，未达标即红（不再走「冻结基线」）', () => {
    const bad = all.filter((r) => r.ratio < THRESHOLD.text);
    expect(bad, bad.map((b) => `${b.key} = ${b.ratio.toFixed(2)}（需 ≥ ${THRESHOLD.text}）`).join('\n  ')).toEqual([]);
  });

  it('规模锁：主题清单逐字、实算次数 18（少一个主题不是「更严」，是清单失守）', () => {
    expect(ALL_THEMES.map((t) => t.name)).toEqual([
      'default(:root)', 'creative', 'ecommerce', 'enterprise', 'light-business', 'macaron', 'portfolio', 'product', 'dark(tokens.css)',
    ]);
    expect(all.length).toBe(18);
  });

  it('最差侧登记：全站最差是 portfolio 的卡片外沿 7.08（本单不动它，跌到 4.5 以下会被上一条抓住）', () => {
    const worst = all.reduce((a, b) => (b.ratio < a.ratio ? b : a));
    expect(worst.theme).toBe('portfolio');
    expect(worst.face).toBe(1);
    expect(worst.ratio.toFixed(2)).toBe('7.08');
  });
});

/* ------------------------------------------------------------------ C 定调表 */

/**
 * 逐主题登记两个 token 的**生效声明原文**（主题未声明的继承 :root，与 loadThemes 合并口径一致）。
 * 新主题进来必须在这里登记一行 —— 否则 C 腿红，而不是悄悄继承一份没人校准的黄片。
 */
const CITE_VALUES: Record<string, Record<string, string>> = {
  'default(:root)': { '--cite-hit-bg': 'rgba(255, 213, 79, 0.9)', '--cite-hit-fg': '#1a1a1a' },
  creative: {},
  product: {},
  ecommerce: { '--cite-hit-bg': 'rgba(255, 213, 79, 0.55)' },
  enterprise: { '--cite-hit-bg': 'rgba(255, 213, 79, 0.55)' },
  'light-business': { '--cite-hit-bg': 'rgba(255, 213, 79, 0.55)' },
  macaron: { '--cite-hit-bg': 'rgba(255, 213, 79, 0.55)' },
  portfolio: { '--cite-hit-bg': 'rgba(255, 213, 79, 0.55)' },
  'dark(tokens.css)': { '--cite-hit-bg': 'rgba(255, 213, 79, 0.9)' },
};

describe('T04524 · C 取值定调锁', () => {
  it('C1 · 逐主题两个 token 的生效声明与定调一致；未登记主题必须真的继承 :root', () => {
    const root = CITE_VALUES['default(:root)'];
    for (const t of ALL_THEMES) {
      const want = CITE_VALUES[t.name];
      expect(want, `主题 ${t.name} 不在定调表里（新主题要显式登记两族取值）`).toBeTruthy();
      for (const tok of ['--cite-hit-bg', '--cite-hit-fg']) {
        const expected = want?.[tok] ?? root[tok];
        expect(t.decls.get(tok), `${t.name} · ${tok} 的取值与本单定调不一致`).toBe(expected);
      }
    }
  });

  it('C2 · 前景全域只有 #1a1a1a 一档（深底浅底共用，实算两头都过）；面才是分档的那一侧', () => {
    for (const t of ALL_THEMES) expect(t.decls.get('--cite-hit-fg'), `${t.name} 另起了前景取值`).toBe('#1a1a1a');
  });

  it('C3 · 浅底五主题的覆盖是同一套字面 rgba(.55)，深底三主题（含 creative/product）真的走 :root 的 .9', () => {
    for (const name of LIGHT) {
      const t = ALL_THEMES.find((x) => x.name === name) as ThemeTokens;
      const own = themeBlockDecls(readFileSync(join(ROOT, 'src/styles/themes', `${name}.css`), 'utf8'), name);
      expect(own.get('--cite-hit-bg'), `${name}.css 的 [data-theme="${name}"] 块缺 --cite-hit-bg 覆盖`).toBe('rgba(255, 213, 79, 0.55)');
    }
    for (const name of ['creative', 'product']) {
      const css = readFileSync(join(ROOT, `src/styles/themes/${name}.css`), 'utf8');
      expect(css.includes('--cite-hit-bg'), `${name}.css 自带 --cite-hit-bg，但定调表写的是继承 :root`).toBe(false);
    }
    expect(solid(CITE_BG, ALL_THEMES.find((x) => x.name === 'product') as ThemeTokens).a).toBe(0.9);
  });

  it('C4 · tokens.css 的 dark 那份与本单 :root 同值（两套暗色主题不该有两张黄片；改一处而不改另一处即红）', () => {
    const dark = ALL_THEMES.find((x) => x.name === 'dark(tokens.css)') as ThemeTokens;
    const root = ALL_THEMES.find((x) => x.name === 'default(:root)') as ThemeTokens;
    const a = solid(CITE_BG, dark);
    const b = solid(CITE_BG, root);
    expect([a.r, a.g, a.b, a.a]).toEqual([b.r, b.g, b.b, b.a]);
  });
});

/* ------------------------------------------------------------------ D 面口径前提 */

const modalSrc = () => readFileSync(MODAL_CSS, 'utf8');
const styleSrc = () => readFileSync(join(ROOT, 'src/style.css'), 'utf8');
const citeSrc = () => readFileSync(join(ROOT, 'src/components/CitationModal.vue'), 'utf8');

describe('T04524 · D 模态面口径前提锁', () => {
  it('D1 · 遮罩来源仍是 modal.css 的 --modal-mask（换成 EP 那份说明覆盖被删，B/C 的数字要按新遮罩重定）', () => {
    const { source, expr } = overlayExpr();
    expect(source, `遮罩来源变了，当前表达式：${expr}`).toBe('modal.css');
    expect(/rgba\(4, 2, 12, 0?\.58\)/.exec(expr)?.[0], 'modal.css 的 --modal-mask fallback 值变了：面口径要重算').toBeTruthy();
  });

  it('D2 · EP 安装副本那份遮罩变量原值留档（#00000080）——它当前被 modal.css 盖住，删掉覆盖后就会生效', () => {
    const m = /--el-overlay-color-lighter:\s*([^;]+)/.exec(stripComments(readFileSync(EP_VAR_CSS, 'utf8')));
    expect(m, 'element-plus 主题里找不到 --el-overlay-color-lighter：D1 的来源判定需要跟着改').toBeTruthy();
    expect((m as RegExpMatchArray)[1].trim()).toBe('#00000080');
  });

  it('D3 · 对话框容器背景仍取 --bg-card-solid（「遮罩压卡片」这张落点的前提）', () => {
    // modal.css 里那条是选择器列表（.app-modal.el-dialog, .app-modal.el-drawer），
    // ruleBodies 只认「选择器直接接 {」的写法，所以这里按列表块整段匹配，不作废成结构断言
    const modal = stripComments(modalSrc());
    expect(/\.app-modal\.el-dialog[^{,]*,[^{]*\{[^}]*background:\s*var\(--bg-card-solid\)/.test(modal),
      'modal.css 的 .app-modal.el-dialog 背景不再取 --bg-card-solid：模态面口径失效').toBe(true);
    const root = styleSrc();
    expect(/(?:^|[\n};])\s*\.el-dialog\s*\{[^}]*background:\s*var\(--bg-card-solid\)/.test(stripComments(root)),
      'style.css 的 .el-dialog 背景不再取 --bg-card-solid：那份与 modal.css 同源的落点前提没了').toBe(true);
  });

  it('D4 · .citation-* 容器不得自带背景（自带底就变成「压自声明底」，B 腿的两张落点全算错）', () => {
    for (const sel of ['.citation-body', '.citation-chunk', '.citation-chunk-content']) {
      const bodies = ruleBodies(citeSrc(), sel);
      expect(bodies.length, `CitationModal 找不到 ${sel} 规则（改名要同步本腿）`).toBe(1);
      expect(/background/.test(bodies[0] as string), `${sel} 自带了背景，压遮罩口径失效：${(bodies[0] as string).trim()}`).toBe(false);
    }
  });
});

/* ------------------------------------------------------------------ E 可达径 */

function walk(dir: string, out: string[] = []): string[] {
  for (const d of readdirSync(join(ROOT, dir), { withFileTypes: true })) {
    const rel = `${dir}/${d.name}`;
    if (d.isDirectory()) walk(rel, out);
    else if (/\.(vue|css)$/.test(rel)) out.push(rel);
  }
  return out;
}
function testFilesReferencingCiteHit(): string[] {
  const dir = join(ROOT, 'test');
  return readdirSync(dir)
    .filter((f) => f.endsWith('.test.ts'))
    .map((f) => join(dir, f))
    .filter((p) => /--cite-hit-/.test(readFileSync(p, 'utf8')));
}

describe('T04524 · E 可达径锁', () => {
  it('E1 · 消费点仍是 :deep(.cite-hit)，且底色/前景分别取两个 token', () => {
    const bodies = ruleBodies(citeSrc(), ':deep(.cite-hit)');
    expect(bodies.length).toBe(1);
    const body = bodies[0] as string;
    expect(/background:\s*var\(--cite-hit-bg[,)]/.test(body), '高亮底色不再引用 --cite-hit-bg').toBe(true);
    expect(/color:\s*var\(--cite-hit-fg[,)]/.test(body), '高亮前景不再引用 --cite-hit-fg').toBe(true);
    expect(/<mark class="cite-hit">/.test(citeSrc()), 'highlight() 不再产出 mark.cite-hit（本锁审的就不是真实落点）').toBe(true);
  });

  it('E2 · 每主题两个 token 都有声明：组件里的字面 fallback 才是永久不可达的', () => {
    const offenders: string[] = [];
    for (const t of ALL_THEMES) for (const tok of ['--cite-hit-bg', '--cite-hit-fg']) if (!t.decls.get(tok)) offenders.push(`${t.name} ${tok}`);
    expect(offenders, `这些 token 缺声明，组件 fallback 会变成真实生效值（改前的 3.94 会静默回来）：${offenders.join(' / ')}`).toEqual([]);
  });

  it('E3 · 组件 fallback 与 :root 声明逐字同值（未登记主题必须 fail closed 到达标档，而不是退回 .55）', () => {
    const root = ALL_THEMES.find((x) => x.name === 'default(:root)') as ThemeTokens;
    const fb: Record<string, string | undefined> = {
      '--cite-hit-bg': /var\(--cite-hit-bg,\s*(rgba\([^)]*\)|#[0-9a-fA-F]{3,8})\s*\)/.exec(citeSrc())?.[1].trim(),
      '--cite-hit-fg': /var\(--cite-hit-fg,\s*(rgba\([^)]*\)|#[0-9a-fA-F]{3,8})\s*\)/.exec(citeSrc())?.[1].trim(),
    };
    for (const tok of ['--cite-hit-bg', '--cite-hit-fg']) {
      expect(fb[tok], `组件里 ${tok} 的 fallback 取不到了（写法变了要同步本腿）`).toBeTruthy();
      expect(fb[tok], `组件 fallback 与 :root 的 ${tok} 声明不再同值：未登记主题会落到哪一档无人知道`).toBe(root.decls.get(tok));
    }
  });

  it('E4 · 全站 --cite-hit-* 的引用只允许出现在已登记的 8 个文件里（新接一处而不进本锁即红）', () => {
    const EXPECTED_FILES = [
      'src/style.css',
      'src/styles/tokens.css',
      'src/components/CitationModal.vue',
      ...LIGHT.map((n) => `src/styles/themes/${n}.css`),
    ].sort();
    const hit = walk('src').filter((f) => /--cite-hit-/.test(readFileSync(join(ROOT, f), 'utf8'))).sort();
    expect(hit).toEqual(EXPECTED_FILES);
  });
});

/* ------------------------------------------------------------------ F 口径负控制 */

describe('T04524 · F 口径负控制（必须全绿）', () => {
  it('F1 · 两张落点都真的不等于页底，且深底主题两张可分辨（遮罩 + 半透明卡片不是「自己等于自己」）', () => {
    for (const name of ['default(:root)', 'product', 'portfolio']) {
      const t = ALL_THEMES.find((x) => x.name === name) as ThemeTokens;
      const faces = modalFaces(t);
      const page = pageOf(t.decls);
      expect(faces[0]).not.toEqual(faces[1]);
      for (const f of faces) {
        expect([f.r, f.g, f.b].every((v, i) => v === [page.r, page.g, page.b][i]), `${name} 的落点与页底完全相同：遮罩没算进去`).toBe(false);
      }
    }
  });

  it('F2 · 18 次实算全部是 [1, 21] 区间内的有限数（解析器出问题产出 NaN 时，B 腿会无声全绿）', () => {
    const all = ALL_THEMES.flatMap((t) => measure(t));
    expect(all.length).toBe(18);
    for (const r of all) {
      expect(Number.isFinite(r.ratio) && r.ratio >= 1 && r.ratio <= 21, `${r.key} 比值异常`).toBe(true);
    }
  });

  it('F3 · 把 :root 的面换回改前的 .55，同一口径立刻在深底判红（证明 B 腿有牙齿）', () => {
    const t = ALL_THEMES.find((x) => x.name === 'product') as ThemeTokens;
    const bad = measure(t, 'rgba(255, 213, 79, 0.55)').filter((r) => r.ratio < THRESHOLD.text);
    expect(bad.length, '把面换回 .55 必须两张落点都判红，否则本锁空转').toBe(2);
  });

  it('F4 · 前景换成白字必须让浅底主题判红（证明锁盯的是两头方向，不是只校准了深底那一侧）', () => {
    const t = ALL_THEMES.find((x) => x.name === 'ecommerce') as ThemeTokens;
    const bad = measure(t, CITE_BG, '#ffffff').filter((r) => r.ratio < THRESHOLD.text);
    expect(bad.length, '白字压浅底黄片若不判红，说明实算根本没吃到前景').toBe(2);
  });

  it('F5 · 接错对象自证：把「面」当前景喂进同一口径，比值必然塌到 1 附近（fg/bg 两个参数写反不可能悄悄成立）', () => {
    const t = ALL_THEMES.find((x) => x.name === 'ecommerce') as ThemeTokens;
    const swapped = measure(t, CITE_BG, CITE_BG);
    expect(swapped.length).toBe(2);
    for (const r of swapped) {
      expect(r.ratio, `${r.key} 用「自己比自己」算出 ${r.ratio.toFixed(3)}，说明面/前景喂反了`).toBeLessThan(1.5);
    }
  });
});
