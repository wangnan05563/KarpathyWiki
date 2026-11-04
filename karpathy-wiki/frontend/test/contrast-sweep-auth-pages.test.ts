// T04470 口径推广·批次 A1：登录页（Login.vue）+ 注册页（Register.vue）。
// 与前五组同一缺陷族：为深色霓虹底设计的强调色基名（--neon-cyan / --neon-magenta）被直接写进
// color / border-color，在浅底主题（macaron / portfolio / ecommerce / enterprise / light-business）
// 的白卡片与淡 tint 面上跌破 WCAG AA。本批覆盖 9 处（登录 5 / 注册 4）。
//
// 先测后改的实算结果（8 主题 × 4 种面/族组合，单位 = 对比度，最差值）：
//   青 readable × 卡片面（焦点描边，需 ≥3.0）最差 macaron 5.11
//   青 readable × 青 a08 面（行内码，需 ≥4.5）最差 macaron 4.95
//   青 readable × 玻璃卡面（.login-card 是 var(--bg-glass)+blur，需 ≥4.5）最差 macaron 5.10
//   粉 readable × 粉 a10 面（报错条，需 ≥4.5）最差 macaron 4.85
// 即本批四个落点面全部已被既有 token 校准覆盖，未触发第五组那种逐主题二次收紧。
// 玻璃面口径沿用清理页先例（contrast-sweep-cleanup-help.test.ts:25-26）：半透明面按 --bg-void 合成可见底。
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  ROOT,
  auditThemes,
  findBareBaseForegroundUses,
  formatFailures,
  loadThemes,
  type AuditRow,
} from './helpers/contrast';

const FILES = ['src/views/Login.vue', 'src/views/Register.vue'];
const PAGE: Record<string, string> = { 'src/views/Login.vue': '登录页', 'src/views/Register.vue': '注册页' };
/** 基色 token（不含 -aNN tint 与 -base 派生）：这些裸写进前景即本口径要抓 */
const BASE_TOKENS = [
  /^--neon-cyan$/,
  /^--neon-pink$/,
  /^--accent-pink$/,
  /^--neon-magenta$/,
  /^--neon-purple$/,
  /^--accent-purple$/,
];
const CARD = 'var(--bg-card-solid)';
const GLASS = 'var(--bg-glass)';

/** 逐面清单：fg=接入后的 readable token，bg=该声明所在规则的真实落点面 */
const AUDIT: AuditRow[] = [
  { label: '登录页·.form-input:focus [border-color·accent]', fg: 'var(--accent-readable)', bg: CARD, kind: 'ui' },
  { label: '登录页·.login-error [color·pink]', fg: 'var(--pink-readable)', bg: 'var(--accent-pink-a10)', kind: 'text' },
  { label: '登录页·.login-hint code [color·accent]', fg: 'var(--accent-readable)', bg: 'var(--accent-cyan-a08)', kind: 'text' },
  { label: '登录页·.pwd-toggle:hover [color·accent]', fg: 'var(--accent-readable)', bg: GLASS, kind: 'text' },
  { label: '登录页·.switch-link [color·accent]', fg: 'var(--accent-readable)', bg: GLASS, kind: 'text' },
  { label: '注册页·.form-input:focus [border-color·accent]', fg: 'var(--accent-readable)', bg: CARD, kind: 'ui' },
  { label: '注册页·.pwd-toggle:hover [color·accent]', fg: 'var(--accent-readable)', bg: GLASS, kind: 'text' },
  { label: '注册页·.login-error [color·pink]', fg: 'var(--pink-readable)', bg: 'var(--accent-pink-a10)', kind: 'text' },
  { label: '注册页·.switch-link [color·accent]', fg: 'var(--accent-readable)', bg: GLASS, kind: 'text' },
];

const EXPECTED: Record<string, { n: number; readable: number; fam: Record<string, number>; tint: number }> = {
  'src/views/Login.vue': { n: 5, readable: 5, fam: { accent: 4, pink: 1 }, tint: 4 },
  'src/views/Register.vue': { n: 4, readable: 4, fam: { accent: 3, pink: 1 }, tint: 3 },
};

const readableRefCount = (src: string) => (src.match(/-readable/g) || []).length;
const famCount = (src: string, fam: string) => (src.match(new RegExp(`--${fam}-readable`, 'g')) || []).length;
const rowsOf = (f: string) => AUDIT.filter((r) => r.label.startsWith(PAGE[f] + '·'));

describe('T04470 批次 A1：逐主题达标', () => {
  it(`8 主题 × ${AUDIT.length} 面全部达 AA（文本 4.5 / 非文本 3.0）`, () => {
    const failures = auditThemes(AUDIT, loadThemes());
    expect(failures, formatFailures(failures)).toEqual([]);
  });

  it('清单规模与两页实现严格对齐（防止清单与代码脱钩空转）', () => {
    expect(AUDIT.length).toBe(9);
    for (const f of FILES) {
      const src = readFileSync(join(ROOT, f), 'utf8');
      const exp = EXPECTED[f];
      expect(rowsOf(f).length, `${f} 清单行数与总清单不一致`).toBe(exp.n);
      expect(readableRefCount(src), `${f} 的 readable 消费点数与清单不一致`).toBe(exp.readable);
    }
  });

  it('逐族消费点数与审计清单一致（接错家族会被点名）', () => {
    for (const f of FILES) {
      const src = readFileSync(join(ROOT, f), 'utf8');
      for (const [fam, n] of Object.entries(EXPECTED[f].fam)) {
        expect(famCount(src, fam), `${f} · --${fam}-readable 应有 ${n} 处`).toBe(n);
      }
    }
  });

  it('包裹表达式括号平衡（防止接入器吃掉右括号/行尾）', () => {
    for (const f of FILES) {
      const bad = readFileSync(join(ROOT, f), 'utf8')
        .split(/\r?\n/)
        .filter((l) => /-readable/.test(l) && (l.match(/\(/g) || []).length !== (l.match(/\)/g) || []).length);
      expect(bad, `${f} 有 ${bad.length} 行括号不平衡：${bad.slice(0, 3).join(' | ')}`).toEqual([]);
    }
  });

  it('清单里的落点面 token 在 8 个主题上都可解析（防止面写成凭空声明）', () => {
    const themes = loadThemes();
    for (const t of themes) {
      for (const face of [GLASS, 'var(--accent-pink-a10)', 'var(--accent-cyan-a08)']) {
        expect(() => auditThemes([{ label: `${t.name}·${face}`, fg: 'var(--accent-readable)', bg: face, kind: 'text' }], [t])).not.toThrow();
      }
    }
  });
});

describe('T04470 批次 A1：口径守护（基色不得再裸写进前景）', () => {
  for (const f of FILES) {
    it(`${f}：基色 token 只允许作为 *-readable 的 fallback 出现`, () => {
      const src = readFileSync(join(ROOT, f), 'utf8');
      expect(findBareBaseForegroundUses(src, { baseTokens: BASE_TOKENS }), `${f} 存在裸用基色的前景声明`).toEqual([]);
    });

    it(`${f}：行级兜底锁——出现基色引用的行必须同时出现 readable`, () => {
      const bad = readFileSync(join(ROOT, f), 'utf8')
        .split(/\r?\n/)
        .filter(
          (l) =>
            /(?:color|border(?:-color)?|outline(?:-color)?)\s*:/.test(l) &&
            /var\(--(?:neon-cyan|neon-pink|neon-magenta|neon-purple|accent-pink|accent-purple)\b(?![\w-])/.test(l) &&
            !/-readable/.test(l),
        );
      expect(bad, `${f} 有裸用基色的行：${bad.slice(0, 3).join(' | ')}`).toEqual([]);
    });

    it(`${f}：装饰性 tint 前景停在基线，新增即红（改它需 T04468 裁决）`, () => {
      const src = readFileSync(join(ROOT, f), 'utf8');
      let n = 0;
      for (const l of src.split(/\r?\n/)) {
        const m = /^\s*(?:color|border-color|border(?:-(?:left|right|top|bottom))?|outline(?:-color)?)\s*:\s*([^;]*)/.exec(l);
        if (m && /var\(--accent-[\w-]+-a\d\d/.test(m[1]) && !/-readable/.test(m[1])) n++;
      }
      expect(n, `${f} 装饰 tint 前景应从基线 ${EXPECTED[f].tint} 只降不升`).toBeLessThanOrEqual(EXPECTED[f].tint);
    });
  }
});
