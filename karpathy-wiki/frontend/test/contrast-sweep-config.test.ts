// T04470 口径推广·批次 A6：系统配置页（Config.vue 18 处，批次 A 收尾文件）。
// 与前五批同一缺陷族：为深色霓虹底设计的强调色基名（--neon-magenta / --neon-purple / --neon-pink）
// 被直接写进 color / border(-color)，在浅底主题跌破 AA。
//
// 本批四点新内容（逐主题实算见 D:/code/tmp/t04470/a6matrix.log、a6beforeafter.log）：
// ① **所在面第一次由「容器底」而非元素自身决定**：本页的面板一律声明 `background: var(--bg-scene)`
//    （.config-block / .history-section / .diff-result / .ai-status / .cli-test-result / .test-results），
//    scene 在浅色主题是接近纯白的实底（macaron #fff5f0），比卡片页底更亮。
//    所以 tint 面要按 tint → scene 合成，而不是 tint → 卡片页底；两者结论会反过来。
// ② **粉族在本页大面积不够**：18 点里 11 点必须用 `--purple-readable`，其中 6 点坐在**粉 tint** 上
//    （粉 a15 / 粉 a12 / 粉渐变 a18→a05 / 粉 a10）——这不是风格统一问题，是实算：同一面上
//    `--pink-readable` 在 macaron / portfolio 最低只有 4.10~4.47，而 `--purple-readable` 4.58~4.74。
//    「跨族按面选族」在本批从个案变成多数，故写成断言防止后来者按家族名改回粉族。
// ③ **曾有的一处已知缺口已由 T04480 闭掉**：`.key-badge-private`（紫 a15 × scene）接入紫族后
//    macaron 实测 4.49 < 4.5（其余 7 主题 4.63~10.57），根因是 macaron 的 `--purple-readable: #7a628d`
//    本身偏浅，属 token 取值校准（非「接入既有 readable」授权范围，故当时只留档不修）。
//    T04480 把该值压暗到 #76608a 后本格实测 4.67，18 面 × 8 主题全绿——留档用例已按它自己的
//    迁移指引删除，源码形状断言（面没有被反向偷抬）并入上面的达标用例。
// ④ **`.pattern-status.invalid` 的单行规则**：`color: var(--neon-pink)` 写在同一行的花括号里，
//    行级口径扫描按分号切段也能抓到，故一并接入（该行涉及的假 token 属 T04460，不在本口径）。
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  ROOT,
  THRESHOLD,
  auditThemes,
  findBareBaseForegroundUses,
  formatFailures,
  loadThemes,
  pageOf,
  resolve,
  worstRatio,
  type AuditFailure,
  type AuditRow,
  type RGB,
  type ThemeTokens,
} from './helpers/contrast';

const FILE = 'src/views/Config.vue';
const PAGE = '系统配置页';

const BASE_TOKENS = [
  /^--neon-cyan$/,
  /^--neon-pink$/,
  /^--accent-pink$/,
  /^--neon-magenta$/,
  /^--neon-purple$/,
  /^--accent-purple$/,
];

const SCENE = 'var(--bg-scene)';
const CARD = 'var(--bg-card)';
const GLASS = 'var(--bg-glass)';
const PINK_A15 = 'var(--accent-pink-a15)';
const PINK_A12 = 'var(--accent-pink-a12)';
const PINK_A10 = 'var(--accent-pink-a10)';
const PINK_GRAD_A18 = 'linear-gradient(135deg, var(--accent-pink-a18), var(--accent-pink-a05))';
const PINK_GRAD_A12 = 'linear-gradient(135deg, var(--accent-pink-a12), var(--accent-pink-a03))';
const PURPLE_A15 = 'var(--accent-purple-a15)';
const PURPLE_A12 = 'var(--accent-purple-a12)';
const MAGENTA_A10 = 'var(--accent-magenta-a10)';

const PINK = 'var(--pink-readable)';
const PURPLE = 'var(--purple-readable)';

/**
 * 本批 18 个真实消费点。`on` 是**权威叠底**：scene 系实底（面板自己声明的不透明底），
 * 玻璃钮那条按 tint → scene 合成；card 变体另列一条下界清单。
 */
interface Point {
  ln: number;
  sel: string;
  face: string;
  fg: string;
  bare: string;
  kind: 'text' | 'ui';
}
const POINTS: Point[] = [
  { ln: 5777, sel: '.key-status.unset', face: PINK_A15, fg: PURPLE, bare: 'var(--neon-magenta)', kind: 'text' },
  { ln: 5794, sel: '.key-badge-private', face: PURPLE_A15, fg: PURPLE, bare: 'var(--neon-purple)', kind: 'text' },
  { ln: 5810, sel: '.env-name', face: PURPLE_A12, fg: PURPLE, bare: 'var(--neon-purple)', kind: 'text' },
  { ln: 5825, sel: '.warning-icon', face: PINK_GRAD_A18, fg: PURPLE, bare: 'var(--neon-magenta)', kind: 'text' },
  { ln: 5830, sel: '.warning-text strong', face: PINK_GRAD_A18, fg: PURPLE, bare: 'var(--neon-magenta)', kind: 'text' },
  { ln: 5901, sel: '.reload-warn', face: SCENE, fg: PINK, bare: 'var(--neon-magenta)', kind: 'text' },
  { ln: 5935, sel: '.history-disabled code', face: PURPLE_A12, fg: PURPLE, bare: 'var(--neon-purple)', kind: 'text' },
  { ln: 6066, sel: '.diff-line.del .line-prefix', face: PINK_A12, fg: PURPLE, bare: 'var(--neon-magenta)', kind: 'text' },
  { ln: 6305, sel: '.test-result.fail', face: PINK_GRAD_A12, fg: PURPLE, bare: 'var(--neon-magenta)', kind: 'text' },
  { ln: 6348, sel: '.masked-key', face: PURPLE_A12, fg: PURPLE, bare: 'var(--neon-purple)', kind: 'text' },
  { ln: 6357, sel: '.key-hint', face: SCENE, fg: PINK, bare: 'var(--neon-magenta)', kind: 'text' },
  { ln: 6407, sel: '.neon-btn-danger:hover border', face: GLASS, fg: PINK, bare: 'var(--neon-magenta)', kind: 'ui' },
  { ln: 6408, sel: '.neon-btn-danger:hover color', face: GLASS, fg: PINK, bare: 'var(--neon-magenta)', kind: 'text' },
  { ln: 6464, sel: '.mcp-json-error', face: MAGENTA_A10, fg: PINK, bare: 'var(--neon-magenta)', kind: 'text' },
  { ln: 6560, sel: '.cli-test-result .error-output', face: SCENE, fg: PINK, bare: 'var(--neon-magenta)', kind: 'text' },
  { ln: 6737, sel: '.dirty-indicator', face: PINK_A10, fg: PURPLE, bare: 'var(--neon-magenta)', kind: 'text' },
  { ln: 6757, sel: '.pattern-status.invalid', face: SCENE, fg: PINK, bare: 'var(--neon-pink)', kind: 'text' },
  { ln: 6913, sel: '.test-error', face: PINK_A10, fg: PURPLE, bare: 'var(--neon-pink)', kind: 'text' },
];

/**
 * 本页的叠底链与其余页不同：tint 坐在容器声明的 --bg-scene（实底）上，
 * 而 auditThemes 的 page 固定是卡片页底，故此处自带一份按面选底的算法。
 */
const sceneRgb = (decls: Map<string, string>): RGB => {
  const r = resolve(SCENE, decls);
  if ('stops' in r) throw new Error(`${FILE} 的 --bg-scene 不该是渐变`);
  return r.solid;
};
const pageFor = (face: string, decls: Map<string, string>, base: 'scene' | 'card'): RGB =>
  // scene 是实底：直接当可见底；card 走既有卡片页底口径
  base === 'scene' ? sceneRgb(decls) : pageOf(decls);

const ratio = (p: { face: string; fg: string; kind: 'text' | 'ui' }, t: ThemeTokens, base: 'scene' | 'card') =>
  worstRatio(p.fg, p.face, t.decls, pageFor(p.face, t.decls, base));

const audit = (base: 'scene' | 'card', themes: ThemeTokens[]): AuditFailure[] => {
  const out: AuditFailure[] = [];
  for (const t of themes) {
    for (const p of POINTS) {
      const r = ratio(p, t, base);
      if (r < THRESHOLD[p.kind]) out.push({ theme: t.name, label: `${p.sel} [L${p.ln}]`, ratio: r, threshold: THRESHOLD[p.kind] });
    }
  }
  return out;
};

/** 达标清单（既有 auditThemes 通道）：卡片实底 + 无自身底的三处，作为第二重下界 */
const CARD_BOUND: AuditRow[] = POINTS.map((p) => ({
  label: `${PAGE}·${p.sel} [card 下界]`,
  fg: p.fg,
  bg: p.face === SCENE || p.face === GLASS ? CARD : p.face,
  kind: p.kind,
}));

/** 接入前的裸基色事实（18 个点 × 各自面 / 各自口径）：证明本批不是「顺手活」 */
const BEFORE: Array<{ face: string; fg: string; kind: 'text' | 'ui' }> = POINTS.map((p) => ({
  face: p.face,
  fg: p.bare,
  kind: p.kind,
}));
const BEFORE_FAILURES = 88;

/** 本批接入后的源码原文（逐条点名；任何一条被回退即红） */
const WRAPPED_LINES: Array<{ line: string; count: number }> = [
  { line: '  color: var(--purple-readable, var(--neon-purple));', count: 4 },
  { line: '  color: var(--purple-readable, var(--neon-magenta));', count: 6 },
  { line: '  color: var(--purple-readable, var(--neon-pink));', count: 1 },
  { line: '  color: var(--pink-readable, var(--neon-magenta));', count: 4 },
  { line: '  border-color: var(--pink-readable, var(--neon-magenta)) !important;', count: 1 },
  { line: '  color: var(--pink-readable, var(--neon-magenta)) !important;', count: 1 },
  { line: '.pattern-status.invalid { color: var(--pink-readable, var(--neon-pink)); }', count: 1 },
];

/** 首组已接入青族 28 处，粉/紫全部来自本批（11 紫 / 7 粉） */
const FAMILY_COUNTS: Record<string, number> = { accent: 28, purple: 11, pink: 7 };
/** 装饰性 tint 前景基线（只降不升；是否纳入口径属 T04468） */
const TINT_BASELINE = 55;

const famCount = (src: string, fam: string) => (src.match(new RegExp(`--${fam}-readable`, 'g')) || []).length;
const srcOf = () => readFileSync(join(ROOT, FILE), 'utf8');

describe('T04470 批次 A6：逐主题达标（权威叠底 = 面板实底 --bg-scene）', () => {
  it(`8 主题 × ${POINTS.length} 面接入后全绿（L5794 缺口由 T04480 取值校准闭掉）`, () => {
    const failures = audit('scene', loadThemes());
    expect(failures, formatFailures(failures)).toEqual([]);
    // 校准只压暗前景，不许反过来把面偷抬成更亮来蒙过数值：源码形状逐字锁住
    expect(srcOf()).toMatch(/\.key-badge-private \{\s*\r?\n\s*background: var\(--accent-purple-a15\);\s*\r?\n\s*border-color: var\(--accent-purple-a40\);\s*\r?\n\s*color: var\(--purple-readable, var\(--neon-purple\)\);/);
  });

  it('卡片页底下界同样成立（叠底猜错也不会翻案，18 面 8 主题全过）', () => {
    const failures = audit('card', loadThemes());
    expect(failures, formatFailures(failures)).toEqual([]);
  });

  it('既有 auditThemes 通道复查：把 tint 面按卡片底合成仍全过', () => {
    const failures = auditThemes(CARD_BOUND, loadThemes());
    expect(failures, formatFailures(failures)).toEqual([]);
  });

  it(`接入前确有 ${BEFORE_FAILURES} 个未达标组合（本批不是顺手活）`, () => {
    const themes = loadThemes();
    const bare = BEFORE.reduce(
      (acc, b) =>
        acc +
        themes.filter(
          (t) => worstRatio(b.fg, b.face, t.decls, pageFor(b.face, t.decls, 'scene')) < THRESHOLD[b.kind],
        ).length,
      0,
    );
    expect(bare, `BEFORE 实测 ${bare}（18 点 × 8 主题）`).toBe(BEFORE_FAILURES);
  });

  it('跨族是按面实算的结果、不是风格选择：11 个紫族点若按粉族接必有点跌破 4.5', () => {
    const themes = loadThemes();
    const purplePoints = POINTS.filter((p) => p.fg === PURPLE);
    expect(purplePoints.length).toBe(11);
    const pinkWouldFail = purplePoints.filter(
      (p) => Math.min(...themes.map((t) => worstRatio(PINK, p.face, t.decls, sceneRgb(t.decls)))) < THRESHOLD.text,
    );
    // 除 L5794（粉族 3.69 更差）外每个紫族点按粉族都有主题跌破 4.5——即全部 11 个
    expect(pinkWouldFail.length, pinkWouldFail.map((p) => `L${p.ln} ${p.sel}`).join(' ')).toBe(purplePoints.length);
  });

  it('清单规模与本批实现严格对齐（18 个真实点），接入原文逐条点名', () => {
    expect(POINTS.length).toBe(18);
    const src = srcOf();
    for (const { line, count } of WRAPPED_LINES) {
      const hits = src.split(/\r?\n/).filter((l) => l === line).length;
      expect(hits, `${JSON.stringify(line)} 应 ${count} 条，实测 ${hits} 条`).toBe(count);
    }
  });

  it('逐族消费点数与账一致（接错家族或漏接会被点名）', () => {
    const src = srcOf();
    for (const [fam, n] of Object.entries(FAMILY_COUNTS)) {
      expect(famCount(src, fam), `${FILE} · --${fam}-readable 应有 ${n} 处`).toBe(n);
    }
  });

  it('青族数值表长度与源码声明数交叉锁（防止后续批次重写本文件时丢掉第二组覆盖）', () => {
    // 28 面里有 1 面是 border-left 简写，不落在按行首属性名的计数正则里，故 27
    expect(CYAN_AUDIT.length - 1, '青族清单与源码 --accent-readable 声明数不再对齐').toBe(cyanDeclCount(srcOf()));
  });

  it('包裹表达式括号平衡且行尾未丢（防止接入器吃掉字符）', () => {
    const src = srcOf();
    const isDecl = (l: string) => /^\s*(?:color|border|outline|--[\w-]+)[\w-]*\s*:/.test(l) || /^\s*\.[\w-]+[^{]*\{.*-readable.*\}$/.test(l);
    const bad = src
      .split(/\r?\n/)
      .filter((l) => isDecl(l) && /-readable/.test(l) && (l.match(/\(/g) || []).length !== (l.match(/\)/g) || []).length);
    expect(bad, `${FILE} 有 ${bad.length} 行括号不平衡：${bad.slice(0, 3).join(' | ')}`).toEqual([]);
    const noTail = src
      .split(/\r?\n/)
      .filter((l) => isDecl(l) && /-readable/.test(l) && !/[;}]$/.test(l.replace(/\s*!important\s*$/, '').trimEnd()));
    expect(noTail, `${FILE} 有 ${noTail.length} 行 readable 声明丢了行尾：${noTail.slice(0, 3).join(' | ')}`).toEqual([]);
  });
});

describe('T04470 批次 A6：口径守护（基色不得再裸写进前景）', () => {
  it(`${FILE}：基色 token 只允许作为 *-readable 的 fallback 出现`, () => {
    expect(findBareBaseForegroundUses(srcOf(), { baseTokens: BASE_TOKENS }), `${FILE} 存在裸用基色的前景声明`).toEqual([]);
  });

  it(`${FILE}：行级兜底锁——按声明判定，前景属性引用基色却无 readable 即红`, () => {
    const bad = srcOf()
      .split(/\r?\n/)
      .flatMap((l) => l.split(';'))
      .map((seg) => seg.replace(/^[^{]*\{/, '').trim())
      .filter(
        (seg) =>
          /^(?:color|border(?:-color)?|outline(?:-color)?)\s*:/.test(seg) &&
          /var\(--(?:neon-cyan|neon-pink|neon-magenta|neon-purple|accent-pink|accent-purple)\b(?![\w-])/.test(seg) &&
          !/-readable/.test(seg),
      );
    expect(bad, `${FILE} 有裸用基色的声明：${bad.slice(0, 3).join(' | ')}`).toEqual([]);
  });

  it(`${FILE}：装饰性 tint 前景停在基线，新增即红（改它需 T04468 裁决）`, () => {
    let n = 0;
    for (const l of srcOf().split(/\r?\n/)) {
      const m = /^\s*(?:color|border-color|border(?:-(?:left|right|top|bottom))?|outline(?:-color)?)\s*:\s*([^;]*)/.exec(l);
      if (m && /var\(--accent-[\w-]+-a\d\d/.test(m[1]) && !/-readable/.test(m[1])) n++;
    }
    expect(n, `${FILE} 装饰 tint 前景应从基线 ${TINT_BASELINE} 只降不升`).toBeLessThanOrEqual(TINT_BASELINE);
  });
});

// 第二组（T04449）青族 28 面原样保留：本批只动粉/紫，但接入器曾整文件重写本测试，
// 若删掉这段则「青族 28 面达标」只剩族计数锁，数值覆盖会静默回退。
/** 第二组消费点清单（28 行）：label 用选择器语义，bg 用该元素源码里自己声明的面 */
const CYAN_AUDIT: AuditRow[] = [
  { label: '配置页·头部等宽小标签', fg: 'var(--accent-readable)', bg: 'var(--bg-card-solid)', kind: 'text' },
  { label: '配置页·区块小标签', fg: 'var(--accent-readable)', bg: 'var(--bg-card-solid)', kind: 'text' },
  { label: '配置页·QQ 区块小标签', fg: 'var(--accent-readable)', bg: 'var(--bg-card-solid)', kind: 'text' },
  { label: '配置页·保存按钮 hover 描边', fg: 'var(--accent-readable)', bg: 'var(--bg-card-solid)', kind: 'ui' },
  { label: '配置页·保存按钮 hover 文字', fg: 'var(--accent-readable)', bg: 'var(--bg-card-solid)', kind: 'text' },
  { label: '配置页·Schema 输入框 focus 描边', fg: 'var(--accent-readable)', bg: 'var(--bg-card-solid)', kind: 'ui' },
  { label: '配置页·区块括号符', fg: 'var(--accent-readable)', bg: 'var(--bg-card-solid)', kind: 'text' },
  { label: '配置页·密钥已配置状态文字', fg: 'var(--accent-readable)', bg: 'var(--accent-cyan-a15)', kind: 'text' },
  { label: '配置页·共享密钥徽章', fg: 'var(--accent-readable)', bg: 'var(--accent-cyan-a15)', kind: 'text' },
  { label: '配置页·警示提示内 code', fg: 'var(--accent-readable)', bg: 'var(--accent-cyan-a12)', kind: 'text' },
  { label: '配置页·热生效强调文字', fg: 'var(--accent-readable)', bg: 'var(--bg-card-solid)', kind: 'text' },
  { label: '配置页·生效标签', fg: 'var(--accent-readable)', bg: 'var(--accent-cyan-a10)', kind: 'text' },
  { label: '配置页·提交号', fg: 'var(--accent-readable)', bg: 'var(--accent-cyan-a10)', kind: 'text' },
  { label: '配置页·diff 新增行前缀', fg: 'var(--accent-readable)', bg: 'var(--bg-card-solid)', kind: 'text' },
  { label: '配置页·用户徽章', fg: 'var(--accent-readable)', bg: 'var(--accent-cyan-a10)', kind: 'text' },
  { label: '配置页·预设标签 hover 描边', fg: 'var(--accent-readable)', bg: 'var(--accent-cyan-a10)', kind: 'ui' },
  { label: '配置页·预设标签 hover 文字', fg: 'var(--accent-readable)', bg: 'var(--accent-cyan-a10)', kind: 'text' },
  { label: '配置页·预设标签选中描边', fg: 'var(--accent-readable)', bg: 'var(--accent-cyan-a15)', kind: 'ui' },
  { label: '配置页·预设标签选中文字', fg: 'var(--accent-readable)', bg: 'var(--accent-cyan-a15)', kind: 'text' },
  { label: '配置页·表单项 hover 描边', fg: 'var(--accent-readable)', bg: 'var(--bg-card-solid)', kind: 'ui' },
  { label: '配置页·表单项 focus 描边', fg: 'var(--accent-readable)', bg: 'var(--bg-card-solid)', kind: 'ui' },
  { label: '配置页·连通测试结果(成功)', fg: 'var(--accent-readable)', bg: 'linear-gradient(135deg, var(--accent-cyan-a12), var(--accent-cyan-a03))', kind: 'text' },
  { label: '配置页·快捷键提示 code', fg: 'var(--accent-readable)', bg: 'var(--accent-cyan-a12)', kind: 'text' },
  { label: '配置页·提示条左侧色条(border-left 简写)', fg: 'var(--accent-readable)', bg: 'var(--accent-purple-a06)', kind: 'ui' },
  { label: '配置页·规则名内 code', fg: 'var(--accent-readable)', bg: 'var(--accent-cyan-a10)', kind: 'text' },
  { label: '配置页·正则校验通过态', fg: 'var(--accent-readable)', bg: 'var(--bg-card-solid)', kind: 'text' },
  { label: '配置页·测试进行中', fg: 'var(--accent-readable)', bg: 'var(--bg-card-solid)', kind: 'text' },
  { label: '配置页·迁移文件选择 hover 描边', fg: 'var(--accent-readable)', bg: 'var(--bg-card-solid)', kind: 'ui' },
];

/** 第二组声明级计数：27 个标准前景声明（border-left 简写那行不落在行首属性名正则里） */
const cyanDeclCount = (src: string) => [...src.matchAll(/^[ \t]*(?:color|border-color|border-left-color|outline-color)[ \t]*:[ \t]*[^;]*--accent-readable/gm)].length;

describe('T04449 推广第二组：配置中心青族 28 面（本批未动，原样复守）', () => {
  it('8 主题 × 28 面全部达 AA（文本 4.5 / 非文本 3.0）', () => {
    const failures = auditThemes(CYAN_AUDIT, loadThemes());
    expect(failures, formatFailures(failures)).toEqual([]);
  });

  it('清单与源码逐属性消费点对齐（27 个标准前景声明 + 1 个 border-left 简写）', () => {
    expect(cyanDeclCount(srcOf())).toBe(27);
    expect(CYAN_AUDIT.length).toBe(28);
  });

  it('整文件不存在未包裹的 --neon-cyan 引用（行级锁，兜住单行规则与简写）', () => {
    const unwrapped = srcOf()
      .split(/\r?\n/)
      .map((l) => l.trim())
      .filter((l) => l.includes('--neon-cyan') && !l.includes('--accent-readable') && !/^(\/\*|\*|\/\/)/.test(l));
    expect(unwrapped, `未包裹的强调色引用：${unwrapped.join(' | ')}`).toEqual([]);
  });
});

// T04480 取值校准后的数值锁（原为「已知缺口留档」，缺口闭掉后按该用例自己的迁移指引转正）。
// 留精确值而不是只留 ≥4.5：macaron 无深色面，任何再压暗/提亮都会同时移动本主题全部紫族落点，
// 精确值能把「顺手改动 readable」变成一次有意的、需要同时更新其它锁的变更。
describe('T04470 批次 A6：L5794 校准后数值锁', () => {
  it('L5794 逐主题实测：macaron 已从 4.49 抬到 4.67，其余 7 主题不因本次校准而变', () => {
    const themes = loadThemes();
    const p = POINTS.find((x) => x.ln === 5794)!;
    const vals = themes.map((t) => ({ th: t.name, v: ratio(p, t, 'scene') }));
    expect(vals.map((c) => `${c.th}=${c.v.toFixed(2)}`).join(' ')).toBe(
      'default(:root)=5.42 creative=5.42 ecommerce=4.91 enterprise=4.63 light-business=4.81 macaron=4.67 portfolio=10.57 product=5.37',
    );
    expect(Math.min(...vals.map((c) => c.v)), '最小值必须自身达标，不留阈值余量债').toBeGreaterThanOrEqual(THRESHOLD.text);
  });
});
