// T04175 知识问答页「前景可读色配对」守护。
// 背景（缺陷复现口径）：.msg-bubble.user 的底色是主题渐变 --grad-fire，而气泡内的
//   「确认发送」（重新发送入口）按钮取的是「页面底色」口径的 --text-soft + 淡青描边，
//   两套口径叠在同一块面上 → 实测对比度 1.01:1（商务浅白）～2.52:1，用户读作
//   「按钮颜色与主题冲突，看不清楚」；同一页里所有把强调色当前景用的 hover/active 态
//   （工具栏图标、联想追问、代码块徽章、排队取消）在浅底主题上也普遍只有 1.0～2.4:1。
// 本用例把两件事钉住：
//   ① 数值：逐主题（含 :root 默认主题）逐面实算 WCAG 对比度，文本 4.5:1、控件 3:1；
//   ② 口径：这三个问答入口文件里，强调色/警示色当前景必须经 --accent-readable /
//      --warning-readable，不得再把 --neon-cyan / --warning-accent-hover 直接写进
//      color / border-color（装饰性填充不受限）。改一行配色就会在这里红，而不是等用户截图。
import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
// T04449：解析器与实算口径抽到 test/helpers/contrast.ts 共用（各页面推广时不再复制一套判定）。
import {
  ROOT,
  STYLE_CSS,
  THEMES_DIR,
  THRESHOLD,
  auditThemes,
  formatFailures,
  loadThemes,
  luminance,
  pageOf,
  parseDecls,
  rgbToHex,
  resolve,
  stripComments,
  worstRatio,
} from './helpers/contrast';
// 前景配对的消费点（问答页三处入口，含悬浮问答，同一套 token 口径）
const QA_FILES = ['src/views/Query.vue', 'src/components/MessageToolbar.vue', 'src/components/FloatingChat.vue'];


const themes = loadThemes();

/**
 * 审计清单：每行 = 问答页一个真实可见的前景消费点。
 * surface 用「表达式」而不是硬编码色值，主题改 token 会立刻反映到数值上。
 * kind=text 阈值 4.5（AA 正常字号），kind=ui 阈值 3.0（WCAG 1.4.11 非文本控件）。
 */
const AUDIT: Array<{ label: string; fg: string; bg: string; kind: 'text' | 'ui' }> = [
  // —— 本单主诉：用户气泡内的重新发送/取消按钮（T04175 修复前 1.01～2.52:1）——
  { label: '编辑态·确认发送 文字', fg: 'var(--accent-readable)', bg: 'var(--bg-card-solid)', kind: 'text' },
  { label: '编辑态·确认发送 描边', fg: 'var(--accent-readable)', bg: 'var(--bg-card-solid)', kind: 'ui' },
  { label: '编辑态·确认发送 hover', fg: 'var(--accent-readable)', bg: 'var(--accent-cyan-a12)', kind: 'text' },
  { label: '编辑态·取消 文字', fg: 'var(--text-base)', bg: 'var(--bg-card-solid)', kind: 'text' },
  // 描边即按钮可见轮廓（WCAG 1.4.11 按非文本控件 3:1）——用 --text-soft 而不是主题淡边框色，
  // 淡边框（#e6e8ec 级）在白卡片上只有 1.1:1，等于「按钮没有边界」
  { label: '编辑态·取消 描边', fg: 'var(--text-soft)', bg: 'var(--bg-card-solid)', kind: 'ui' },
  { label: '编辑态·取消 hover 描边', fg: 'var(--accent-readable)', bg: 'var(--bg-card-solid)', kind: 'ui' },
  // —— 同页横向排查：强调色当前景的 hover/active 态 ——
  { label: '工具栏图标 hover', fg: 'var(--accent-readable)', bg: 'var(--accent-cyan-a18)', kind: 'text' },
  { label: '工具栏图标 active', fg: 'var(--accent-readable)', bg: 'var(--accent-cyan-a25)', kind: 'text' },
  { label: '工具栏图标 静息', fg: 'var(--text-soft)', bg: 'var(--bg-card-solid)', kind: 'ui' },
  { label: '排队取消 静息文字', fg: 'var(--text-base)', bg: 'var(--bg-card-solid)', kind: 'text' },
  { label: '排队取消 hover', fg: 'var(--accent-readable)', bg: 'var(--bg-card-solid)', kind: 'text' },
  { label: '联想追问 chip 文字', fg: 'var(--accent-readable)', bg: 'var(--accent-cyan-a10)', kind: 'text' },
  { label: '代码块语言徽章', fg: 'var(--accent-readable)', bg: 'var(--accent-cyan-a12)', kind: 'text' },
  { label: '引用角标 [n]', fg: 'var(--accent-readable)', bg: 'var(--accent-cyan-a06)', kind: 'text' },
  { label: '侧栏展开按钮图标', fg: 'var(--accent-readable)', bg: 'var(--accent-cyan-a10)', kind: 'ui' },
  // —— 超时/失败条：琥珀提示文字（修复前浅底主题 1.55～1.71:1）——
  { label: '超时条·提示文字', fg: 'var(--warning-readable)', bg: 'var(--warning-accent-soft)', kind: 'text' },
  { label: '超时条·重发按钮文字', fg: 'var(--warning-accent-ink)', bg: 'var(--warning-accent)', kind: 'text' },
  { label: '超时条·重发按钮 hover', fg: 'var(--warning-accent-ink)', bg: 'var(--warning-accent-hover)', kind: 'text' },
  // —— 编辑框自身（本来就有独立面，留作配对回归锁）——
  { label: '编辑态·输入框文字', fg: 'var(--text-bright)', bg: 'var(--bg-input)', kind: 'text' },
  // —— T04448 粉/紫族：此前 --accent-pink / --accent-purple（裸名）从未定义，
  //    这 9 处前景恒走十六进制 fallback，浅底主题普遍 1.58～4.26:1 ——
  { label: '输入条·引用删除图标 hover', fg: 'var(--pink-readable)', bg: 'var(--bg-card-solid)', kind: 'ui' },
  { label: '视频任务·错误提示文字', fg: 'var(--pink-readable)', bg: 'var(--accent-pink-a10)', kind: 'text' },
  { label: '视频任务·下载链接文字', fg: 'var(--purple-readable)', bg: 'var(--bg-card-solid)', kind: 'text' },
  { label: '多模态卡头·标题文字', fg: 'var(--purple-readable)', bg: 'var(--accent-purple-a10)', kind: 'text' },
  { label: '多模态卡体·生成图链接', fg: 'var(--purple-readable)', bg: 'var(--accent-purple-a05)', kind: 'text' },
  { label: 'PPT 下载按钮·描边', fg: 'var(--purple-readable)', bg: 'var(--bg-card-solid)', kind: 'ui' },
  { label: 'PPT 下载按钮·文字(hover 淡底)', fg: 'var(--purple-readable)', bg: 'var(--accent-purple-a10)', kind: 'text' },
  { label: '渲染错误卡·标题', fg: 'var(--pink-readable)', bg: 'var(--accent-pink-a10)', kind: 'text' },
  { label: '渲染错误卡·详情正文', fg: 'var(--pink-readable)', bg: 'var(--accent-pink-a10)', kind: 'text' },
  // T04448 收尾时同源扫到的第 10 处：技能页删除按钮 hover 走未定义的 --accent-pink-a80
  { label: '技能页·删除按钮 hover 文字', fg: 'var(--pink-readable)', bg: 'var(--accent-pink-a10)', kind: 'text' },
];

describe('T04175 主题 token 解析', () => {
  it('主题清单齐全（防目录变化导致用例空转）', () => {
    expect(themes.length).toBeGreaterThanOrEqual(8);
    expect(themes.map((t) => t.name)).toContain('light-business');
  });

  it('每个主题的 --accent-readable / --warning-readable 都能解析成实色', () => {
    for (const t of themes) {
      for (const token of ['--accent-readable', '--warning-readable', '--pink-readable', '--purple-readable']) {
        const r = resolve(`var(${token})`, t.decls);
        if ('stops' in r) throw new Error(`${t.name} 的 ${token} 解析成了渐变`);
        expect(r.solid.a, `${t.name} ${token} 不得是半透明前景`).toBe(1);
      }
    }
  });

  it('浅底主题的 readable 值锁定为实测压暗值（防止被改回原亮色）', () => {
    const hexOf = (name: string, token: string) => {
      const t = themes.find((x) => x.name === name)!;
      const r = resolve(`var(${token})`, t.decls);
      if ('stops' in r) throw new Error('不该是渐变');
      return rgbToHex(r.solid);
    };
    // 取「对最紧的 --accent-cyan-a25 淡底也 ≥4.6:1」的最小压暗值（卡片面普遍 5.1–6.5:1）
    expect(hexOf('ecommerce', '--accent-readable')).toBe('#006b93');
    expect(hexOf('enterprise', '--accent-readable')).toBe('#046e80');
    expect(hexOf('light-business', '--accent-readable')).toBe('#1554d1');
    expect(hexOf('macaron', '--accent-readable')).toBe('#2b7a6e');
    // portfolio 在 T04449 口径推广里再压暗一档：帮助页锚点 hover 的黑淡底
    // （--accent-purple-a12，本主题的「紫」即墨色）实测 4.36:1 → #715d45 后 4.81:1
    expect(hexOf('portfolio', '--accent-readable')).toBe('#715d45');
    // readable 必须比原强调色更暗或相同（浅底主题只允许压暗，不允许提亮成霓虹）
    for (const name of ['ecommerce', 'enterprise', 'light-business', 'macaron', 'portfolio']) {
      const acc = resolve(`var(--accent-readable)`, themes.find((x) => x.name === name)!.decls);
      const cyan = resolve(`var(--neon-cyan)`, themes.find((x) => x.name === name)!.decls);
      if ('stops' in acc || 'stops' in cyan) throw new Error('不该是渐变');
      expect(luminance(acc.solid), `${name} readable 应 ≤ 原强调色亮度`).toBeLessThanOrEqual(luminance(cyan.solid) + 1e-6);
    }
  });
});

describe('T04175 问答页前景对比度（逐主题逐面）', () => {
  for (const t of themes) {
    it(`${t.name}：全部消费点达 WCAG AA`, () => {
      const page = pageOf(t.decls);
      const bad: string[] = [];
      for (const row of AUDIT) {
        // 半透明面（tint）先与页面底合成，再与前景合成
        const ratio = worstRatio(row.fg, row.bg, t.decls, page);
        if (ratio < THRESHOLD[row.kind]) {
          bad.push(`${row.label}(${row.kind}) = ${ratio.toFixed(2)}:1 < ${THRESHOLD[row.kind]}:1`);
        }
      }
      expect(bad, `${t.name} 低对比消费点清单`).toEqual([]);
    });
  }

  it('用户气泡（--grad-fire）仍是渐变面：靠独立操作条面承载按钮，不靠前景色硬扛', () => {
    // 这条锁住「修复路线没有被改回给按钮配前景色」：一旦 .msg-edit-actions 不再自带不透明面，
    // 按钮就又回到 --grad-fire 上，本清单的 4.5:1 判定失去意义。
    for (const f of QA_FILES.slice(0, 1)) {
      const css = readFileSync(join(ROOT, f), 'utf8');
      const start = css.indexOf('.msg-edit-actions {');
      expect(start, '缺少 .msg-edit-actions 规则块').toBeGreaterThanOrEqual(0);
      // 只截本规则块（到最近的块尾），否则后面的 .edit-btn{background:transparent} 会误判
      const block = css.slice(start, css.indexOf('\n}', start));
      expect(block).toMatch(/background:\s*var\(--bg-card-solid/);
      expect(block).not.toMatch(/background:\s*transparent/);
    }
  });
});

describe('T04175 前景口径守护（问答页不得再把强调色直接当前景）', () => {
  const colorDecl = /^\s*(?:color|border-color|--el-button-hover-text-color)\s*:\s*(.+);$/gm;

  for (const f of QA_FILES) {
    it(`${f}：--neon-cyan / --warning-accent-hover 只允许作为 readable 的 fallback 出现`, () => {
      const src = readFileSync(join(ROOT, f), 'utf8');
      const violations: string[] = [];
      for (const m of src.matchAll(colorDecl)) {
        const value = m[1];
        const rawAccent = /var\(\s*--neon-cyan\b/.test(value) && !/--accent-readable/.test(value);
        const rawWarn = /var\(\s*--warning-accent-hover\b/.test(value) && !/--warning-readable/.test(value);
        if (rawAccent || rawWarn) violations.push(`${f} → ${value}`);
      }
      expect(violations).toEqual([]);
    });
  }

  it('扫描确实覆盖到消费点（防止正则失配导致空转）', () => {
    let hits = 0;
    for (const f of QA_FILES) {
      hits += [...readFileSync(join(ROOT, f), 'utf8').matchAll(colorDecl)].filter((m) => m[1].includes('--accent-readable')).length;
    }
    expect(hits).toBeGreaterThanOrEqual(25);
  });

  // 上面的数值用例审「token 口径」，本用例审「选择器 ↔ token 配对」：
  // 只保证「用了 readable」不够，还得保证「用对那个 readable」——
  // 例如超时提示误用 --accent-readable（青）而不是 --warning-readable（琥珀），
  // 数值照样达标，但语义/告警可见性坏了，故此处按选择器逐条锁死。
  const KEY_PAIRINGS: Array<{ file: string; selector: string; mustInclude: string }> = [
    { file: QA_FILES[0], selector: '.timeout-resend-tip', mustInclude: '--warning-readable' },
    { file: QA_FILES[0], selector: '.edit-btn.confirm', mustInclude: '--accent-readable' },
    { file: QA_FILES[0], selector: '.queue-cancel:hover', mustInclude: '--accent-readable' },
    { file: QA_FILES[1], selector: '.toolbar-btn.active', mustInclude: '--accent-readable' },
  ];
  for (const { file, selector, mustInclude } of KEY_PAIRINGS) {
    it(`${selector} 使用 ${mustInclude}`, () => {
      const css = readFileSync(join(ROOT, file), 'utf8');
      const start = css.indexOf(`${selector} {`);
      expect(start, `缺少 ${selector} 规则块`).toBeGreaterThanOrEqual(0);
      const block = css.slice(start, css.indexOf('\n}', start));
      expect(block).toMatch(new RegExp(`:\\s*var\\(\\s*${mustInclude.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\b`));
    });
  }
});

// ===========================================================================
// T04448：粉/紫族「假 token」与前景口径
// 缺陷本体：--accent-pink / --accent-purple（裸名）从未在任何主题里定义过，
//   Query.vue + MultimodalOutputCard.vue 的 9 处前景 var() 恒等于走十六进制 fallback，
//   于是「配了主题色」的写法实际渲染出一个固定色——浅底主题拿到深底霓虹的粉紫，
//   实测 1.58~4.26:1（macaron 淡粉底上的错误文字最差）。修复分两层：补齐真 token
//   （= 本主题 *-base）+ 建立 --pink-readable / --purple-readable 前景配对。
// ===========================================================================
describe('T04448 粉/紫真 token 已定义（假 token 不再骗过审查看板）', () => {
  const definedProps = (() => {
    const names = new Set<string>();
    const files = [STYLE_CSS, ...readdirSync(THEMES_DIR).filter((f) => f.endsWith('.css')).map((f) => join(THEMES_DIR, f))];
    for (const f of files) {
      for (const m of stripComments(readFileSync(f, 'utf8')).matchAll(/(--[\w-]+)\s*:/g)) names.add(m[1]);
    }
    return names;
  })();

  it('--accent-pink / --accent-purple 裸名现在是真 token', () => {
    for (const t of ['--accent-pink', '--accent-purple']) expect(definedProps, `${t} 未在任何主题中定义`).toContain(t);
  });

  it('--pink-readable / --purple-readable 在 :root 有定义', () => {
    const rootDecl = parseDecls(stripComments(readFileSync(STYLE_CSS, 'utf8')).match(/:root\s*\{([\s\S]*?)\n\}/)![1]);
    for (const t of ['--pink-readable', '--purple-readable']) expect(rootDecl.has(t), `${t} 缺少 :root 默认`).toBe(true);
  });

  it('本单族（粉/紫）不再有假 token；其余族的已知空挂冻结为基线，新增即红', () => {
    const walk = (dir: string): string[] =>
      readdirSync(dir, { withFileTypes: true }).flatMap((e) => {
        const p = join(dir, e.name);
        if (e.isDirectory()) return walk(p);
        return /\.(vue|css)$/.test(e.name) ? [p] : [];
      });
    // 与本单同族但范围外的空挂 token（T04448 只负责粉/紫）。实测 41 处引用 / 19 个名字 /
    // 14 个文件，已由 T04448 建派生单专项治理；此处冻结为基线——只拦「新增的假 token」，
    // 存量清单被删干净时同样会红（防止基线悄悄失效）。
    const FAKE_TOKEN_BASELINE = new Set([
      '--text-secondary',
      '--text-color',
      '--text-faint',
      '--bg-sidebar',
      '--border-subtle',
      '--neon-amber',
      '--neon-',
      '--accent-lime-a40',
      '--accent-lime-a25',
      '--accent-lime-a08',
      '--accent-lime-a20',
      '--accent-red-a08',
      '--accent-red-a30',
      '--accent-red-text',
      '--accent-danger-a30',
      '--accent-danger-a10',
      '--accent-amber',
            '--accent-blue-a35',
    ]);
    const GLOBAL_PREFIX = /^(--accent-|--neon-|--warning-|--text-|--bg-|--border-|--pink-|--purple-)/;
    const ownFamily = /^(--accent-pink|--accent-purple|--pink-|--purple-)/;
    const offenders: string[] = [];
    const baselineHits = new Set<string>();
    for (const file of walk(join(ROOT, 'src'))) {
      const src = readFileSync(file, 'utf8');
      // 组件内自行定义的局部变量不算空挂
      const local = new Set([...src.matchAll(/(--[\w-]+)\s*:/g)].map((m) => m[1]));
      for (const m of src.matchAll(/var\((--[\w-]+)/g)) {
        const name = m[1];
        if (!GLOBAL_PREFIX.test(name)) continue;
        if (definedProps.has(name) || local.has(name)) continue;
        if (ownFamily.test(name)) offenders.push(`${file.replace(ROOT, '')} → ${name}`);
        else if (FAKE_TOKEN_BASELINE.has(name)) baselineHits.add(name);
        else offenders.push(`新增假 token ${file.replace(ROOT, '')} → ${name}`);
      }
    }
    expect(offenders).toEqual([]);
    // 基线里的 --accent-pink-a80 / --accent-purple 族若被治理掉，也应显式更新本清单——
    // 至少确认基线仍在覆盖空挂大户，避免「清单留着但已不命中」的空转
    expect(baselineHits.size, '存量假 token 基线未被扫描命中（用例可能已空转）').toBeGreaterThan(10);
  });
});

describe('T04448 粉/紫前景口径守护（不得再裸用 --accent-pink / --accent-purple）', () => {
  const PP_FILES = ['src/views/Query.vue', 'src/components/MultimodalOutputCard.vue', 'src/views/Skill.vue'];
  // color / border-color 与 border 简写都会把粉紫铺成可见前景；-aNN 淡色族是装饰用途，不受限
  const fgDecl = /^\s*(?:color|border-color|border|outline-color)\s*:\s*(.+);$/gm;

  for (const f of PP_FILES) {
    it(`${f}：粉/紫当前景必须经 *-readable`, () => {
      const src = readFileSync(join(ROOT, f), 'utf8');
      const violations: string[] = [];
      for (const m of src.matchAll(fgDecl)) {
        const v = m[1];
        const barePink = /var\(\s*--accent-pink\s*[,)]/.test(v) && !/--pink-readable/.test(v);
        const barePurple = /var\(\s*--accent-purple\s*[,)]/.test(v) && !/--purple-readable/.test(v);
        if (barePink || barePurple) violations.push(`${f} → ${v}`);
      }
      expect(violations).toEqual([]);
    });
  }

  it('粉/紫 readable 消费点计数锁定（防止回退成裸色时扫描空转）', () => {
    let pink = 0;
    let purple = 0;
    for (const f of PP_FILES) {
      const src = readFileSync(join(ROOT, f), 'utf8');
      pink += [...src.matchAll(fgDecl)].filter((m) => m[1].includes('--pink-readable')).length;
      purple += [...src.matchAll(fgDecl)].filter((m) => m[1].includes('--purple-readable')).length;
    }
    expect(pink, '粉族 readable 消费点应 ≥5（.ib-qr-del:hover / .video-error-tip / .error-title / .error-detail / .delete-btn:hover）').toBeGreaterThanOrEqual(5);
    expect(purple, '紫族 readable 消费点应 ≥5（卡头 / 图链 / PPT 描边 / PPT 文字 / 下载链接）').toBeGreaterThanOrEqual(5);
  });

  it('浅底主题的 pink/purple readable 锁为实测压暗值，且不得比本主题 base 更亮', () => {
    const hexOf = (name: string, token: string) => {
      const t = themes.find((x) => x.name === name)!;
      const r = resolve(`var(${token})`, t.decls);
      if ('stops' in r) throw new Error(`${token} 不该解析成渐变`);
      return rgbToHex(r.solid);
    };
    const EXPECT: Record<string, { pink: string; purple: string }> = {
      'default(:root)': { pink: '#ff006e', purple: '#bc47ff' },
      creative: { pink: '#ff006e', purple: '#bc47ff' },
      ecommerce: { pink: '#b34b25', purple: '#6757db' },
      enterprise: { pink: '#2f68c5', purple: '#2461e5' },
      'light-business': { pink: '#c33131', purple: '#1554d1' },
      macaron: { pink: '#8c6273', purple: '#7d6591' },
      portfolio: { pink: '#7a654a', purple: '#1a1a1a' },
      product: { pink: '#ff0080', purple: '#bc47ff' },
    };
    const LIGHT = ['ecommerce', 'enterprise', 'light-business', 'macaron', 'portfolio'];
    for (const [name, exp] of Object.entries(EXPECT)) {
      expect(hexOf(name, '--pink-readable'), `${name} pink`).toBe(exp.pink);
      expect(hexOf(name, '--purple-readable'), `${name} purple`).toBe(exp.purple);
      if (LIGHT.includes(name)) {
        // 浅底只允许压暗（提亮成霓虹 = 回到本缺陷）
        for (const fam of ['pink', 'purple'] as const) {
          const rd = resolve(`var(--${fam}-readable)`, themes.find((x) => x.name === name)!.decls);
          const bs = resolve(`var(--accent-${fam}-base)`, themes.find((x) => x.name === name)!.decls);
          if ('stops' in rd || 'stops' in bs) throw new Error('不该是渐变');
          expect(luminance(rd.solid), `${name} ${fam}-readable 应 ≤ base 亮度`).toBeLessThanOrEqual(luminance(bs.solid) + 1e-6);
        }
      }
    }
  });
});
