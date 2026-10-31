// T02941（帮助文档同源批次 2）：仪表盘统计卡实名单一来源的单测。
// 除常量形状外，还锁住「Dashboard.vue 只从 DASHBOARD_STAT_CARDS 取实名」，
// 防止有人把模板改回内联字面量、而帮助文档继续跟着 util 走。
import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { DASHBOARD_STAT_CARDS, dashboardStatValue } from '../src/utils/dashboardPresentation';
import type { StatsData } from '../src/types';

const stats: StatsData = {
  totalPages: 166,
  totalLinks: 412,
  dirCounts: { entities: 44, concepts: 122 },
  recentLog: '',
};

describe('DASHBOARD_STAT_CARDS 统计卡实名', () => {
  it('四张卡顺序固定：总页面数 / 双向链接 / 实体页 / 概念页', () => {
    expect(DASHBOARD_STAT_CARDS.map((c) => c.key)).toEqual([
      'totalPages',
      'totalLinks',
      'entities',
      'concepts',
    ]);
    expect(DASHBOARD_STAT_CARDS.map((c) => c.label)).toEqual([
      '总页面数',
      '双向链接',
      '实体页',
      '概念页',
    ]);
  });

  it('实名唯一且非空，配色类名都给了', () => {
    const labels = DASHBOARD_STAT_CARDS.map((c) => c.label);
    expect(new Set(labels).size).toBe(labels.length);
    for (const c of DASHBOARD_STAT_CARDS) {
      expect(c.label.trim()).not.toBe('');
      expect(c.grad.trim()).not.toBe('');
    }
  });

  it('只有实体页/概念页可跳转（T02457 B4 的假可点约束）', () => {
    expect(DASHBOARD_STAT_CARDS.filter((c) => c.type).map((c) => c.type)).toEqual([
      'entity',
      'concept',
    ]);
  });

  it('取数口径：总量取顶层字段，实体/概念取目录计数', () => {
    expect(dashboardStatValue('totalPages', stats)).toBe(166);
    expect(dashboardStatValue('totalLinks', stats)).toBe(412);
    expect(dashboardStatValue('entities', stats)).toBe(44);
    expect(dashboardStatValue('concepts', stats)).toBe(122);
    for (const c of DASHBOARD_STAT_CARDS) expect(dashboardStatValue(c.key, null)).toBe(0);
  });

  it('Dashboard.vue 不再手抄卡名（模板只跑 DASHBOARD_STAT_CARDS）', () => {
    const src = fs.readFileSync(path.resolve(__dirname, '../src/views/Dashboard.vue'), 'utf8');
    expect(src).toContain('DASHBOARD_STAT_CARDS');
    for (const c of DASHBOARD_STAT_CARDS) {
      expect(src.includes(`label: '${c.label}'`), `Dashboard.vue 手抄了「${c.label}」`).toBe(false);
    }
  });
});
