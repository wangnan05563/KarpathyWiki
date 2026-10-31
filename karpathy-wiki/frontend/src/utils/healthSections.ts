// T02941（帮助文档同源批次 2）：体检中心四类问题的实名/图标/说明单一来源。
// ------------------------------------------------------------------
// 此前这段常量内联在 Health.vue（标题、图标、空态文案），帮助文档 health 章
// 另抄一份「3 类问题：孤立页面 / 断链 / 过期页面」——页面实际已有 4 类
// （含知识时效复核），且「断开链接」被写成了「断链」。抽到本模块后：
//   1. Health.vue 渲染与 helpDocSections 的 health 章从同一份定义取词；
//   2. 增删一类问题只改这里，章节的类数（ISSUE_SECTIONS.length）自动跟随。
import type { IssueKind } from './healthList';

export interface IssueSectionMeta {
  kind: IssueKind;
  title: string;
  icon: string;
  iconClass: string;
  desc: string;
  emptyText: string;
  reviewAction?: boolean;
}

// 4 类问题共用一套渲染与交互（原实现每类手写一段模板，改一处漏三处）
export const ISSUE_SECTIONS: IssueSectionMeta[] = [
  {
    kind: 'orphan',
    title: '孤立页面',
    icon: '◈',
    iconClass: 'icon-orphan',
    desc: '没有任何页面通过双向链接指向它们 · 可自动补回链',
    emptyText: '▸ 无孤立页面',
  },
  {
    kind: 'broken',
    title: '断开链接',
    icon: '⟶',
    iconClass: 'icon-broken',
    desc: '指向不存在页面的 [[链接]] · 可自动创建目标页或改写链接',
    emptyText: '▸ 无断链',
  },
  {
    kind: 'stale',
    title: '过期页面',
    icon: '⏱',
    iconClass: 'icon-stale',
    desc: '长时间未更新的页面（默认 30 天）· 需人工判断，不参与批量修复',
    emptyText: '▸ 无过期页面',
  },
  {
    kind: 'knowledge_stale',
    title: '知识时效复核',
    icon: '◉',
    iconClass: 'icon-review',
    desc: 'knowledge_class=dated 且超过知识时效阈值的页面，复核后追加 reviewed_at 恢复为时效正常',
    emptyText: '▸ 无知识时效过期页面',
    reviewAction: true,
  },
];
