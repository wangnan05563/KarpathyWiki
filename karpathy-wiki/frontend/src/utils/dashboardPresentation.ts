// T02941（帮助文档同源批次 2）：仪表盘统计卡的实名/配色/跳转类型单一来源。
// ------------------------------------------------------------------
// 此前四张卡的 label 内联在 Dashboard.vue 模板的 v-for 字面量里，帮助文档
// dashboard 章另抄一份「总页面数、双向链接数、实体页 / 概念页」。抽到本模块后
// 页面与文档同取 DASHBOARD_STAT_CARDS，卡名改动两边一起变。
import type { StatsData } from '../types';

export type DashboardStatKey = 'totalPages' | 'totalLinks' | 'entities' | 'concepts';

export interface DashboardStatCardMeta {
  key: DashboardStatKey;
  label: string;
  grad: string;
  /** 有类型过滤目标的卡才可点击（T02457 B4） */
  type?: 'entity' | 'concept';
}

export const DASHBOARD_STAT_CARDS: DashboardStatCardMeta[] = [
  { key: 'totalPages', label: '总页面数', grad: 'grad-fire' },
  { key: 'totalLinks', label: '双向链接', grad: 'grad-cool' },
  { key: 'entities', label: '实体页', grad: 'grad-neon', type: 'entity' },
  { key: 'concepts', label: '概念页', grad: 'grad-aurora', type: 'concept' },
];

// 卡片取数口径与模板原表达式保持一致；stats 未返回时按 0（骨架屏会盖住数字）
export function dashboardStatValue(key: DashboardStatKey, stats: StatsData | null): number {
  switch (key) {
    case 'totalPages':
      return stats?.totalPages ?? 0;
    case 'totalLinks':
      return stats?.totalLinks ?? 0;
    case 'entities':
      return stats?.dirCounts?.entities ?? 0;
    case 'concepts':
      return stats?.dirCounts?.concepts ?? 0;
  }
}
