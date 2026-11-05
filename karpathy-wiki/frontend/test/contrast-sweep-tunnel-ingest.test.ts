// T04449 口径推广·第五组：隧道页（Tunnel.vue）+ 导入页（Ingest.vue）。
// 与前四组同一缺陷族：为深色霓虹底设计的强调色基名（--neon-cyan / --neon-pink / --neon-magenta /
// --neon-purple）被直接写进 color / border(-color)，在浅底主题的白卡片与淡 tint 面上跌破 WCAG AA。
// 本组覆盖 25 处「基色当前景」消费点（隧道 10 / 导入 15）。
//
// 本组新暴露的口径缺口：导入页把紫族文字压在 `--accent-purple-a20`（比前四组样本更深一档的 tint）上，
// ecommerce 的 `--purple-readable: #6354d3` 在该面只有 4.30 < 4.5 → 二次压暗到 #5d4fc6
// （a20 4.73 / a15 5.07 / a12 5.28 / 白卡片 6.18；面变深即更严，故已校准档位不会反向退化）。
//
// 口径边界：装饰性 `var(--accent-*-aNN)` 前景按基线冻结（隧道 4 / 导入 16），
// 改它需要 T04468 的设计裁决；剩余 163 处（35 个文件，含 Config 18 / 进度条组件 21 等）
// 由本组同时交付的 contrast-sweep-index.test.ts 冻结基线并跟踪，接入清单见 T04470。
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

const FILES = ['src/views/Tunnel.vue', 'src/views/Ingest.vue'];
const PAGE: Record<string, string> = { 'src/views/Tunnel.vue': '隧道页', 'src/views/Ingest.vue': '导入页' };
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

/** 逐面清单：fg=接入后的 readable token，bg=该声明所在规则的真实落点面 */
const AUDIT: AuditRow[] = [
  { label: '隧道页·.card-title [color·accent]', fg: 'var(--accent-readable)', bg: CARD, kind: 'text' },
  { label: '隧道页·.url-text [color·accent]', fg: 'var(--accent-readable)', bg: 'var(--accent-cyan-a08)', kind: 'text' },
  { label: '隧道页·.manual-path code [color·pink]', fg: 'var(--pink-readable)', bg: 'var(--accent-pink-a10)', kind: 'text' },
  { label: '隧道页·.download-link [color·accent]', fg: 'var(--accent-readable)', bg: CARD, kind: 'text' },
  { label: '隧道页·.info-line code [color·accent]', fg: 'var(--accent-readable)', bg: 'var(--accent-cyan-a08)', kind: 'text' },
  { label: '隧道页·.auth-url-link [color·accent]', fg: 'var(--accent-readable)', bg: CARD, kind: 'text' },
  { label: '隧道页·.prereq-stale [color·pink]', fg: 'var(--pink-readable)', bg: CARD, kind: 'text' },
  { label: '隧道页·.prereq-error [color·pink]', fg: 'var(--pink-readable)', bg: CARD, kind: 'text' },
  { label: '隧道页·.prereq-link [color·accent]', fg: 'var(--accent-readable)', bg: CARD, kind: 'text' },
  { label: '隧道页·.prereq-goto:hover [color·accent]', fg: 'var(--accent-readable)', bg: CARD, kind: 'text' },
  { label: '导入页·.hero-tag [color·accent]', fg: 'var(--accent-readable)', bg: CARD, kind: 'text' },
  { label: '导入页·.upload-icon [color·accent]', fg: 'var(--accent-readable)', bg: CARD, kind: 'text' },
  { label: '导入页·.folder-dropzone:hover [border-color·purple]', fg: 'var(--purple-readable)', bg: 'var(--accent-purple-a05)', kind: 'ui' },
  { label: '导入页·.folder-files-title [color·accent]', fg: 'var(--accent-readable)', bg: CARD, kind: 'text' },
  { label: '导入页·.qq-step-no [color·purple]', fg: 'var(--purple-readable)', bg: 'var(--accent-purple-a20)', kind: 'text' },
  { label: '导入页·.meta-value.mono [color·accent]', fg: 'var(--accent-readable)', bg: 'var(--accent-cyan-a10)', kind: 'text' },
  { label: '导入页·.drafts-tip strong [color·pink]', fg: 'var(--pink-readable)', bg: CARD, kind: 'text' },
  { label: '导入页·.drafts-path [color·accent]', fg: 'var(--accent-readable)', bg: CARD, kind: 'text' },
  { label: '导入页·.url-step-no [color·purple]', fg: 'var(--purple-readable)', bg: 'var(--accent-purple-a20)', kind: 'text' },
  { label: '导入页·.url-attachments-title [color·purple]', fg: 'var(--purple-readable)', bg: CARD, kind: 'text' },
  { label: '导入页·.url-page-depth [color·accent]', fg: 'var(--accent-readable)', bg: CARD, kind: 'text' },
  { label: '导入页·.url-att-type [color·pink]', fg: 'var(--pink-readable)', bg: CARD, kind: 'text' },
  { label: '导入页·.url-att-group-title [color·accent]', fg: 'var(--accent-readable)', bg: CARD, kind: 'text' },
  // T04460：诊断横幅两处前景此前引用假 token --accent-red-text（恒等于 fallback #d6336c），
  // 改接 --pink-readable 后随主题变化；所在面同时换成真 tint --accent-danger-a10
  { label: '导入页·.url-diagnosis-banner [color·pink]', fg: 'var(--pink-readable)', bg: 'var(--accent-danger-a10)', kind: 'text' },
  { label: '导入页·.url-diagnosis-banner .el-icon [color·pink]', fg: 'var(--pink-readable)', bg: 'var(--accent-danger-a10)', kind: 'ui' },
];

const EXPECTED: Record<string, { n: number; readable: number; fam: Record<string, number>; tint: number }> = {
  'src/views/Tunnel.vue': { n: 10, readable: 10, fam: { accent: 7, pink: 3 }, tint: 4 },
  'src/views/Ingest.vue': { n: 15, readable: 15, fam: { accent: 7, pink: 4, purple: 4 }, tint: 16 },
};

const readableRefCount = (src: string) => (src.match(/-readable/g) || []).length;
const famCount = (src: string, fam: string) => (src.match(new RegExp(`--${fam}-readable`, 'g')) || []).length;
const rowsOf = (f: string) => AUDIT.filter((r) => r.label.startsWith(PAGE[f] + '·'));

describe('T04449 推广第五组：逐主题达标', () => {
  it(`8 主题 × ${AUDIT.length} 面全部达 AA（文本 4.5 / 非文本 3.0）`, () => {
    const failures = auditThemes(AUDIT, loadThemes());
    expect(failures, formatFailures(failures)).toEqual([]);
  });

  it('清单规模与两页实现严格对齐（防止清单与代码脱钩空转）', () => {
    expect(AUDIT.length).toBe(25);
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
});

describe('T04449 推广第五组：口径守护（基色不得再裸写进前景）', () => {
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

describe('T04449 推广第五组：token 层三次收紧（更深一档 tint 面校准）', () => {
  it('紫族压 `--accent-purple-a20` 不再靠浅档位蒙过（ecommerce 二次压暗的成因）', () => {
    const rows2: AuditRow[] = [
      { label: '紫族文字压紫 a20 面', fg: 'var(--purple-readable)', bg: 'var(--accent-purple-a20)', kind: 'text' },
      { label: '紫族描边压更淡紫 a05 面', fg: 'var(--purple-readable)', bg: 'var(--accent-purple-a05)', kind: 'ui' },
      { label: '青族文字压青 a08 面', fg: 'var(--accent-readable)', bg: 'var(--accent-cyan-a08)', kind: 'text' },
    ];
    const failures = auditThemes(rows2, loadThemes());
    expect(failures, formatFailures(failures)).toEqual([]);
  });

  it('前四组已校准的落点不被二次收紧改坏（卡片面 + a12/a15 面）', () => {
    const rows3: AuditRow[] = [
      { label: '紫族文字压卡片', fg: 'var(--purple-readable)', bg: CARD, kind: 'text' },
      { label: '紫族文字压 a12 面', fg: 'var(--purple-readable)', bg: 'var(--accent-purple-a12)', kind: 'text' },
      { label: '紫族文字压 a15 面', fg: 'var(--purple-readable)', bg: 'var(--accent-purple-a15)', kind: 'text' },
      { label: '粉族文字压卡片', fg: 'var(--pink-readable)', bg: CARD, kind: 'text' },
      { label: '青族文字压卡片', fg: 'var(--accent-readable)', bg: CARD, kind: 'text' },
    ];
    const failures = auditThemes(rows3, loadThemes());
    expect(failures, formatFailures(failures)).toEqual([]);
  });
});
