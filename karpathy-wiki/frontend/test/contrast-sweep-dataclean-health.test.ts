// T04449 口径推广·第三组：数据清洗页（DataClean.vue）+ 体检页（Health.vue）。
// 与首组/第二组同一缺陷族：把为深色霓虹底设计的强调色基名直接写进 color / border(-color) / outline，
// 在浅底主题上跌破 WCAG AA。本组覆盖两页全部 63 处「基色当前景」消费点（清洗页 33 + 体检页 30），
// 其中包含 CSS 扫描看不见的模板内联 style（清洗页 3 处）——它们同样是用户可见文字。
//
// 口径边界（写清楚，避免下一组误判）：
//   - 前景（文字/图标/描边/色条/焦点环）一律走 *-readable；本组涉及五个族：
//     accent（青）/ pink（粉红·危险）/ purple（紫）/ lime（绿·成功，本组新建 token）/
//     warning（琥珀·警告，T04460 把两处假 token 转真后并入）。
//   - 体检页的「通过 / 警告 / 危险」三态没有使用 --warning-* token，而是复用 magenta/pink/lime 族，
//     因此按 pink-readable / lime-readable 接入。（T04460 后 .job-stat.warn / .estimate-basis 两处
//     琥珀假 token 改接 --warning-readable，本组口径新增这两处前景消费点，见下方逐主题实算。）
//   - 大量 `border: 1px solid var(--accent-purple-aNN)` 是刻意压淡的装饰性分隔线：实测它在深色母主题上
//     同样只有 1.07~1.6:1（见 T04449 回传），属全站视觉语言而非浅底主题回归，不在本组口径内；
//     若要按 1.4.11 重定 alpha 档需要单独的设计裁决（已建派生单）。
//   - `.job-stat.warn` / `.estimate-basis.is-low-confidence` 曾引用从未定义的 --neon-amber /
//     --accent-amber（渲染恒等于写死的 fallback 橙），T04460 已改接 --warning-readable 并纳入
//     下面的逐主题实算清单；页面上不得再出现任何空挂 var()（由 qa-contrast-pairing 零空挂硬断言把关）。
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  ROOT,
  auditThemes,
  findBareBaseForegroundUses,
  formatFailures,
  loadThemes,
  luminance,
  pageOf,
  resolve,
  composite,
  contrast,
  type AuditRow,
  type RGB,
} from './helpers/contrast';

const FILES = ['src/views/DataClean.vue', 'src/views/Health.vue'];
/** 基色 token（不含 -aNN / -base 派生 tint）：这些裸写进前景就是本口径要抓的 */
const BASE_TOKENS = [
  /^--neon-cyan$/,
  /^--neon-pink$/,
  /^--accent-pink$/,
  /^--neon-purple$/,
  /^--accent-purple$/,
  /^--neon-magenta$/,
  /^--neon-lime$/,
];
/** 行级兜底：任何 var(--基色) 引用所在行必须同时出现某个 readable 包裹 */
const BASE_REF_RE = /var\(\s*--(?:neon-cyan|neon-pink|accent-pink|neon-purple|accent-purple|neon-magenta|neon-lime)(?![\w-])/g;
const themes = loadThemes();

const CARD = 'var(--bg-card-solid)';

/**
 * 消费点清单：每行 = 一个真实可见的前景点（选择器 → 前景 token → 所在面）。
 * 面按源码里该元素自己声明的底色取；未声明背景的按卡片面（--bg-card-solid）审计，
 * 半透明 tint 面（--accent-*-aNN）由 helpers/contrast 的 composite 先落到页底再算。
 * kind=text 阈值 4.5，kind=ui（描边/图标/色条/焦点环）阈值 3.0。
 */
const AUDIT: AuditRow[] = [
  // —— 数据清洗页（33）——
  { label: '清洗页·头部等宽小标签', fg: 'var(--accent-readable)', bg: CARD, kind: 'text' },
  { label: '清洗页·选择摘要文字', fg: 'var(--accent-readable)', bg: CARD, kind: 'text' },
  { label: '清洗页·权限提示条左侧色条', fg: 'var(--pink-readable)', bg: 'var(--bg-scene)', kind: 'ui' },
  { label: '清洗页·可排序表头 hover 文字', fg: 'var(--accent-readable)', bg: CARD, kind: 'text' },
  { label: '清洗页·可排序表头焦点环', fg: 'var(--accent-readable)', bg: CARD, kind: 'ui' },
  { label: '清洗页·排序方向符', fg: 'var(--accent-readable)', bg: CARD, kind: 'text' },
  { label: '清洗页·问题卡非清洁态状态值', fg: 'var(--pink-readable)', bg: CARD, kind: 'text' },
  { label: '清洗页·问题卡选中描边', fg: 'var(--accent-readable)', bg: CARD, kind: 'ui' },
  { label: '清洗页·状态块数值', fg: 'var(--accent-readable)', bg: CARD, kind: 'text' },
  { label: '清洗页·成功态进度条文字', fg: 'var(--accent-readable)', bg: CARD, kind: 'text' },
  { label: '清洗页·区块括号符', fg: 'var(--accent-readable)', bg: CARD, kind: 'text' },
  { label: '清洗页·重复对标题 A', fg: 'var(--accent-readable)', bg: CARD, kind: 'text' },
  { label: '清洗页·重复对标题 B', fg: 'var(--pink-readable)', bg: CARD, kind: 'text' },
  { label: '清洗页·相似度数值', fg: 'var(--accent-readable)', bg: CARD, kind: 'text' },
  { label: '清洗页·分组序号', fg: 'var(--accent-readable)', bg: CARD, kind: 'text' },
  { label: '清洗页·分组体积', fg: 'var(--pink-readable)', bg: CARD, kind: 'text' },
  { label: '清洗页·代表页徽章（淡青 tint 面）', fg: 'var(--accent-readable)', bg: 'var(--accent-cyan-a10, rgba(0, 255, 200, 0.1))', kind: 'text' },
  { label: '清洗页·差异路径 A', fg: 'var(--accent-readable)', bg: CARD, kind: 'text' },
  { label: '清洗页·差异路径 B', fg: 'var(--pink-readable)', bg: CARD, kind: 'text' },
  { label: '清洗页·新增行标记符', fg: 'var(--accent-readable)', bg: CARD, kind: 'text' },
  { label: '清洗页·新增行正文', fg: 'var(--accent-readable)', bg: CARD, kind: 'text' },
  { label: '清洗页·删除行标记符', fg: 'var(--pink-readable)', bg: CARD, kind: 'text' },
  { label: '清洗页·删除行正文', fg: 'var(--pink-readable)', bg: CARD, kind: 'text' },
  { label: '清洗页·评分「优秀」', fg: 'var(--accent-readable)', bg: CARD, kind: 'text' },
  { label: '清洗页·评分「良好」（紫族）', fg: 'var(--purple-readable)', bg: CARD, kind: 'text' },
  { label: '清洗页·评分「待处理」（粉族）', fg: 'var(--pink-readable)', bg: CARD, kind: 'text' },
  { label: '清洗页·评分「较差/危险」（红族）', fg: 'var(--pink-readable)', bg: CARD, kind: 'text' },
  { label: '清洗页·AI 分组小标题①冗余（内联 style，红族）', fg: 'var(--pink-readable)', bg: CARD, kind: 'text' },
  { label: '清洗页·AI 分组小标题②重复（内联 style，粉族）', fg: 'var(--pink-readable)', bg: CARD, kind: 'text' },
  { label: '清洗页·AI 分组小标题③重命名（内联 style，青族）', fg: 'var(--accent-readable)', bg: CARD, kind: 'text' },
  { label: '清洗页·AI 新增项标记', fg: 'var(--accent-readable)', bg: CARD, kind: 'text' },
  { label: '清洗页·AI 流转箭头', fg: 'var(--accent-readable)', bg: CARD, kind: 'text' },
  { label: '清洗页·AI 分组代表页（淡青 tint 面）', fg: 'var(--accent-readable)', bg: 'var(--accent-cyan-a10, rgba(0, 255, 200, 0.1))', kind: 'text' },
  // T04554：错位页因坏 frontmatter 导致落点不确定的提示
  { label: '清洗页·错位页元信息解析失败提示（红族）', fg: 'var(--pink-readable)', bg: CARD, kind: 'text' },
  // —— 体检页（30，含 T04460 转真的 2 处琥珀前景 + T04563 的需人工处理提示）——
  { label: '体检页·主按钮 hover 描边', fg: 'var(--accent-readable)', bg: CARD, kind: 'ui' },
  { label: '体检页·主按钮 hover 文字', fg: 'var(--accent-readable)', bg: CARD, kind: 'text' },
  { label: '体检页·批量修复按钮文字（红族）', fg: 'var(--pink-readable)', bg: CARD, kind: 'text' },
  { label: '体检页·批量修复按钮 hover 描边（红族）', fg: 'var(--pink-readable)', bg: CARD, kind: 'ui' },
  { label: '体检页·健康摘要数值（青渐变面）', fg: 'var(--accent-readable)', bg: 'linear-gradient(135deg, var(--accent-cyan-a20), var(--accent-cyan-a05))', kind: 'text' },
  { label: '体检页·警告摘要数值（粉渐变面，红族）', fg: 'var(--pink-readable)', bg: 'linear-gradient(135deg, var(--accent-pink-a20), var(--accent-pink-a05))', kind: 'text' },
  { label: '体检页·搜索提示文字', fg: 'var(--accent-readable)', bg: CARD, kind: 'text' },
  { label: '体检页·工具按钮 hover 文字', fg: 'var(--accent-readable)', bg: CARD, kind: 'text' },
  { label: '体检页·选中数量摘要', fg: 'var(--accent-readable)', bg: CARD, kind: 'text' },
  { label: '体检页·作业标题（红族）', fg: 'var(--pink-readable)', bg: CARD, kind: 'text' },
  { label: '体检页·作业状态「进行中」（红族）', fg: 'var(--pink-readable)', bg: CARD, kind: 'text' },
  { label: '体检页·作业状态「已完成」', fg: 'var(--accent-readable)', bg: CARD, kind: 'text' },
  { label: '体检页·作业统计正常项', fg: 'var(--accent-readable)', bg: CARD, kind: 'text' },
  { label: '体检页·作业统计失败项（红族）', fg: 'var(--pink-readable)', bg: CARD, kind: 'text' },
  { label: '体检页·失败条目代码（红族）', fg: 'var(--pink-readable)', bg: CARD, kind: 'text' },
  { label: '体检页·扫描中提示文字', fg: 'var(--accent-readable)', bg: CARD, kind: 'text' },
  { label: '体检页·断链图标（紫族）', fg: 'var(--purple-readable)', bg: CARD, kind: 'text' },
  { label: '体检页·孤链图标（红族）', fg: 'var(--pink-readable)', bg: CARD, kind: 'text' },
  { label: '体检页·陈旧图标', fg: 'var(--accent-readable)', bg: CARD, kind: 'text' },
  { label: '体检页·可修复图标（成功绿，新 token）', fg: 'var(--lime-readable)', bg: CARD, kind: 'text' },
  { label: '体检页·待复核图标（红族）', fg: 'var(--pink-readable)', bg: CARD, kind: 'text' },
  { label: '体检页·无问题徽标文字（成功绿，新 token）', fg: 'var(--lime-readable)', bg: CARD, kind: 'text' },
  { label: '体检页·区块计数（淡青 tint 面）', fg: 'var(--accent-readable)', bg: 'var(--accent-cyan-a15)', kind: 'text' },
  { label: '体检页·问题区块计数（粉底 tint 面，红族）', fg: 'var(--pink-readable)', bg: 'var(--accent-pink-a15)', kind: 'text' },
  { label: '体检页·目录行代码片段（紫族）', fg: 'var(--purple-readable)', bg: CARD, kind: 'text' },
  { label: '体检页·清空日志按钮 hover（红族）', fg: 'var(--pink-readable)', bg: CARD, kind: 'text' },
  { label: '体检页·修复日志工具名（淡青 tint 面）', fg: 'var(--accent-readable)', bg: 'var(--accent-cyan-a10)', kind: 'text' },
  // T04460：以下两点此前引用假 token（--neon-amber / --accent-amber），实际渲染恒等于写死的
  // fallback 橙（#f5a623 / #ffb224），换真 token --warning-readable 后第一次真正随主题变化，
  // 因此纳入逐主题实算
  { label: '体检页·任务统计「未消解」琥珀文字', fg: 'var(--warning-readable)', bg: CARD, kind: 'text' },
  { label: '体检页·估算依据「低置信」琥珀文字', fg: 'var(--warning-readable)', bg: CARD, kind: 'text' },
  // T04563：永久失败项（认证/413/预算）的「需人工处理」提示
  { label: '体检页·需人工处理提示（红族）', fg: 'var(--pink-readable)', bg: CARD, kind: 'text' },
  // T04554：坏 frontmatter 汇总条与可点击清单
  { label: '体检页·坏头汇总条描边（红族）', fg: 'var(--pink-readable)', bg: 'var(--accent-magenta-a08)', kind: 'ui' },
  { label: '体检页·坏头汇总计数（红族）', fg: 'var(--pink-readable)', bg: 'var(--accent-magenta-a08)', kind: 'text' },
  { label: '体检页·坏头页路径（青族）', fg: 'var(--accent-readable)', bg: 'var(--bg-deep)', kind: 'text' },
];

/** readable 消费点总数（数 token 名出现次数，不受单行规则 / 内联 style / !important 排版影响） */
const readableRefCount = (src: string) => (src.match(/-readable/g) || []).length;

/** T04468 描边账：tint 描边接入 readable 后，源码同族出现次数 = 审计清单点数 + 描边数 */
const TINT_STROKES: Record<string, Record<string, number>> = {
  DataClean: { accent: 2, pink: 1, purple: 13 },
  Health: { accent: 7, pink: 8, purple: 5, lime: 2 },
};

describe('T04449 推广第三组：清洗页/体检页前景逐主题达标', () => {
  it('8 主题 × 67 面全部达 AA（文本 4.5 / 非文本 3.0）', () => {
    const failures = auditThemes(AUDIT, themes);
    expect(failures, formatFailures(failures)).toEqual([]);
  });

  it('清单规模与两页实现严格对齐（防止清单与代码脱钩空转）', () => {
    expect(AUDIT.length).toBe(67);
    const dc = readFileSync(join(ROOT, FILES[0]), 'utf8');
    const he = readFileSync(join(ROOT, FILES[1]), 'utf8');
    // T04468 起计数含描边账（DataClean 16 / Health 22 处 tint 描边接入 readable）
    expect(readableRefCount(dc), 'DataClean.vue 的 readable 消费点数与登记值不一致').toBe(50);
    expect(readableRefCount(he), 'Health.vue 的 readable 消费点数与登记值不一致').toBe(55);
  });

  it('每个包裹表达式括号平衡（防止接入器吃掉右括号）', () => {
    for (const f of FILES) {
      const src = readFileSync(join(ROOT, f), 'utf8');
      const bad = src.split(/\r?\n/).filter((l) => /#[0-9a-fA-F]{6}\)\)\)/.test(l));
      expect(bad, `${f} 出现 var(...) 三层右括号，声明已损坏：${bad.join(' | ')}`).toEqual([]);
    }
  });

  it('审计清单里的每个 readable token 都在对应页面被真实消费', () => {
    const src = FILES.map((f) => readFileSync(join(ROOT, f), 'utf8')).join('\n');
    const tokens = [...new Set(AUDIT.map((r) => r.fg.match(/--([\w-]+-readable)/)![1]))];
    expect(tokens.sort()).toEqual(['accent-readable', 'lime-readable', 'pink-readable', 'purple-readable', 'warning-readable']);
    for (const t of tokens) expect(src, `清单需要 ${t}，但页面里没有它的消费点`).toContain(`var(--${t}`);
  });

  /**
   * 家族配对锁：逐页逐族统计源码里的 *-readable 出现次数，与审计清单里同页同族的行数对齐。
   * 只有「总数对得上」的锁拦不住把青族站点包成绿族（--lime-readable）这类接错家族——
   * 那类改动数值仍达标，但语义（危险=红 / 成功=绿）会错，故按族分桶校验。
   */
  it('逐族消费点数与审计清单一致（接错家族会被点名）', () => {
    const PREFIX = ['清洗页', '体检页'];
    const famOf = (fg: string) => fg.match(/--([\w-]+)-readable/)![1];
    for (const [i, f] of FILES.entries()) {
      const src = readFileSync(join(ROOT, f), 'utf8');
      const byFam = new Map<string, number>();
      for (const r of AUDIT) {
        if (!r.label.startsWith(PREFIX[i])) continue;
        const fam = famOf(r.fg);
        byFam.set(fam, (byFam.get(fam) ?? 0) + 1);
      }
      const page = f.includes('DataClean') ? 'DataClean' : 'Health';
      for (const [fam, n] of [...byFam.entries()].sort()) {
        const actual = (src.match(new RegExp(`--${fam}-readable`, 'g')) || []).length;
        const stroke = TINT_STROKES[page][fam] ?? 0;
        expect(actual, `${f} · --${fam}-readable：清单 ${n} 行 + 描边 ${stroke} vs 源码 ${actual} 处`).toBe(n + stroke);
      }
    }
  });
});

describe('T04449 推广第三组：lime-readable token 层（新建口径的单调压暗锁）', () => {
  const LIGHT = ['ecommerce', 'enterprise', 'light-business', 'macaron', 'portfolio'];
  // T04903：体检页 `.no-issue` 的真实落点是页面级 --bg-scene（不是卡片面），
  // 原值在该面 3.91~4.42，四支主题同色相压暗一档；ecommerce 在场景底 4.52 本就达标，不动。
  const EXPECTED: Record<string, string> = {
    ecommerce: '#39833c',
    enterprise: '#0b7c57',
    'light-business': '#237c4e',
    macaron: '#657350',
    portfolio: '#736441',
  };

  it('8 主题都能把 --lime-readable 解析成实色', () => {
    for (const t of themes) {
      const v = resolve('var(--lime-readable)', t.decls);
      expect('stops' in v, `${t.name} 的 lime-readable 解析成了渐变`).toBe(false);
    }
  });

  it('浅底主题的 lime-readable 锁定为实测压暗值，且不亮于本主题霓虹绿', () => {
    for (const name of LIGHT) {
      const t = themes.find((x) => x.name === name)!;
      const lime = resolve('var(--lime-readable)', t.decls);
      if ('stops' in lime) throw new Error(name + ' lime-readable 是渐变');
      const hex = '#' + [lime.solid.r, lime.solid.g, lime.solid.b].map((c) => Math.round(c).toString(16).padStart(2, '0')).join('');
      expect(hex, `${name} 的 lime-readable 与实测压暗值不符`).toBe(EXPECTED[name]);
      const neon = resolve('var(--neon-lime)', t.decls);
      if ('stops' in neon) throw new Error(name + ' neon-lime 是渐变');
      const page = pageOf(t.decls);
      const surface = composite(neon.solid as RGB, page);
      void surface;
      // 浅底主题只允许压暗：readable 的相对亮度必须 ≤ 本主题霓虹绿
      expect(luminance(lime.solid), `${name} lime-readable 不应比 --neon-lime 更亮`).toBeLessThanOrEqual(luminance(neon.solid) + 1e-6);
    }
  });

  it('lime-readable 在卡片面上逐主题 ≥ 4.6（成功绿语义不许靠 tint 蒙）', () => {
    for (const t of themes) {
      const page = pageOf(t.decls);
      const bg = resolve(CARD, t.decls);
      const surface = 'stops' in bg ? composite(bg.stops[0], page) : composite(bg.solid, page);
      const fg = resolve('var(--lime-readable)', t.decls);
      const f = 'stops' in fg ? fg.stops[0] : fg.solid;
      expect(contrast(composite(f, surface), surface), `${t.name} lime 前景`).toBeGreaterThanOrEqual(4.6);
    }
  });
});

describe('T04449 推广第三组：口径守护（基色不得再裸写进前景）', () => {
  for (const f of FILES) {
    it(`${f}：基色 token 只允许作为 *-readable 的 fallback 出现`, () =>
      expect(findBareBaseForegroundUses(readFileSync(join(ROOT, f), 'utf8'), { baseTokens: BASE_TOKENS }), `${f} 存在裸用基色的前景声明`).toEqual([]));

    it(`${f}：行级兜底锁——出现基色引用的行必须同时出现 readable`, () => {
      const src = readFileSync(join(ROOT, f), 'utf8');
      const unwrapped = src
        .split(/\r?\n/)
        .map((l) => l.trim())
        .filter((l) => !/^(?:\/\*|\*|\/\/)/.test(l))
        .filter((l) => {
          BASE_REF_RE.lastIndex = 0;
          return BASE_REF_RE.test(l);
        })
        .filter((l) => !/-readable/.test(l));
      expect(unwrapped, `未包裹的基色引用行：${unwrapped.join(' | ')}`).toEqual([]);
    });
  }

  it('装饰性 tint 前景保持基线（本组不改，新增即红）', () => {
    const count = (f: string) =>
      readFileSync(join(ROOT, f), 'utf8')
        .split(/\r?\n/)
        .filter((l) => /^[ \t]*(?:color|border[a-z-]*|outline[a-z-]*)[ \t]*:[^;]*var\(\s*--(?:accent|neon)[\w-]*-(?:a\d{2}|base)\b/.test(l)).length;
    expect(count(FILES[0])).toBeLessThanOrEqual(16);
    expect(count(FILES[1])).toBeLessThanOrEqual(23);
  });

  it('假 token（--neon-amber / --accent-amber）在这两页已清零（T04460 治理后为硬断言）', () => {
    // T04448 时代这里是「停在 2 处，只允许下降」的棘轮；T04460 把两处改接到本主题
    // --warning-readable（真 token），此后新增空挂即在 qa-contrast-pairing 的零空挂硬断言里红。
    const total = FILES.map((f) => readFileSync(join(ROOT, f), 'utf8')).join('\n').match(/var\(\s*--(?:neon|accent)-amber\b/g) || [];
    expect(total, '两页仍引用从未定义的琥珀假 token').toEqual([]);
  });
});
