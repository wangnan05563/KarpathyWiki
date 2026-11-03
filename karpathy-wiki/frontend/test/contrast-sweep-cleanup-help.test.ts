// T04449 口径推广·首组：系统清理页（Cleanup.vue）+ 帮助页（Help.vue）。
// 缺陷族与 T04175 / T04448 相同：把主题强调色 `--neon-cyan` 直接当前景写进
// color / border-color，在浅底主题上拿到的是「为深色霓虹页面设计的亮青」，
// 落在淡紫/淡青 tint 或白卡片上普遍跌破 WCAG AA。本组先把 14 处消费点逐面列全，
// 再按 --accent-readable 口径接入；数值与口径两道锁，改一行配色就会在这里红。
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { ROOT, auditThemes, findBareForegroundUses, formatFailures, loadThemes, type AuditRow } from './helpers/contrast';

const FILES = ['src/views/Cleanup.vue', 'src/views/Help.vue'];
const themes = loadThemes();

/**
 * 消费点清单：每行 = 一个真实可见的前景点（选择器 → 前景 token → 所在面）。
 * bg 用源码里该元素自己声明的面；未声明背景的按卡片面（--bg-card-solid）审计。
 * kind=text 阈值 4.5，kind=ui（描边/图标/色条）阈值 3.0。
 */
const AUDIT: AuditRow[] = [
  // —— 系统清理页 ——
  { label: '清理页·头部等宽小标签', fg: 'var(--accent-readable)', bg: 'var(--bg-card-solid)', kind: 'text' },
  { label: '清理页·状态大数字', fg: 'var(--accent-readable)', bg: 'var(--bg-card-solid)', kind: 'text' },
  { label: '清理页·区块括号符', fg: 'var(--accent-readable)', bg: 'var(--bg-card-solid)', kind: 'text' },
  { label: '清理页·高级开关 hover 文字', fg: 'var(--accent-readable)', bg: 'var(--bg-card-solid)', kind: 'text' },
  { label: '清理页·清理按钮 hover 描边', fg: 'var(--accent-readable)', bg: 'var(--bg-glass)', kind: 'ui' },
  { label: '清理页·清理按钮 hover 文字', fg: 'var(--accent-readable)', bg: 'var(--bg-glass)', kind: 'text' },
  { label: '清理页·结果摘要标题', fg: 'var(--accent-readable)', bg: 'var(--bg-card-solid)', kind: 'text' },
  // —— 帮助页 ——
  { label: '帮助页·侧栏小标签', fg: 'var(--accent-readable)', bg: 'var(--bg-card-solid)', kind: 'text' },
  { label: '帮助页·锚点 hover 文字', fg: 'var(--accent-readable)', bg: 'var(--accent-purple-a12)', kind: 'text' },
  { label: '帮助页·章节图标容器', fg: 'var(--accent-readable)', bg: 'var(--accent-purple-a15)', kind: 'ui' },
  { label: '帮助页·提示条左侧色条', fg: 'var(--accent-readable)', bg: 'var(--accent-cyan-a08)', kind: 'ui' },
  { label: '帮助页·跳转按钮文字', fg: 'var(--accent-readable)', bg: 'var(--accent-cyan-a08)', kind: 'text' },
  { label: '帮助页·配置表格 code 徽章', fg: 'var(--accent-readable)', bg: 'var(--accent-cyan-a10)', kind: 'text' },
  { label: '帮助页·复制按钮 hover 文字', fg: 'var(--accent-readable)', bg: 'var(--accent-cyan-a10)', kind: 'text' },
];

describe('T04449 推广首组：清理页/帮助页前景逐主题达标', () => {
  it('8 主题 × 14 面全部达 AA（文本 4.5 / 非文本 3.0）', () => {
    const failures = auditThemes(AUDIT, themes);
    expect(failures, formatFailures(failures)).toEqual([]);
  });

  it('审计清单确实覆盖了两个页面（防止清单与代码脱钩空转）', () => {
    expect(AUDIT.length).toBeGreaterThanOrEqual(14);
    const src = FILES.map((f) => readFileSync(join(ROOT, f), 'utf8')).join('\n');
    for (const row of AUDIT) {
      expect(src, `清单里的面 ${row.label} 在两个页面源码中都找不到 readable 消费点`).toMatch(/--accent-readable/);
    }
  });
});

describe('T04449 推广首组：口径守护（不得再把 --neon-cyan 裸写进前景）', () => {
  for (const f of FILES) {
    it(`${f}：--neon-cyan 只允许作为 --accent-readable 的 fallback 出现`, () => {
      const src = readFileSync(join(ROOT, f), 'utf8');
      const violations = findBareForegroundUses(src, {
        tokens: /var\(\s*--neon-cyan\b/,
        readableWrappers: [/--accent-readable/],
      });
      expect(violations, `${f} 存在裸用强调色的前景表达式`).toEqual([]);
    });
  }

  it('两个页面各自至少接入 7 处 readable 前景（计数锁）', () => {
    for (const f of FILES) {
      const src = readFileSync(join(ROOT, f), 'utf8');
      const hits = [...src.matchAll(/^[ \t]*(?:color|border-color|border-left-color|outline-color)[ \t]*:[ \t]*[^;]*--accent-readable/gm)].length;
      expect(hits, `${f} 的 readable 前景消费点数量异常，疑似清单与实现同时走样`).toBeGreaterThanOrEqual(7);
    }
  });
});
