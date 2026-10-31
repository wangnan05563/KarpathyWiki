// T02941（帮助文档同源批次 2）：体检项实名单一来源的单测。
// 断言不只是「常量长这样」，还锁住两件事：
//   1. 四类问题与问题行模型（healthList.IssueKind）一一对应，增删一类漏改一处就红；
//   2. Health.vue 不再内联手抄这些实名（否则页面与帮助文档又各说一套）。
import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { ISSUE_SECTIONS } from '../src/utils/healthSections';
import { buildIssueRows, type IssueKind } from '../src/utils/healthList';
import type { HealthReport } from '../src/types';

const KINDS: IssueKind[] = ['orphan', 'broken', 'stale', 'knowledge_stale'];

function report(): HealthReport {
  return {
    orphans: ['a.md'],
    brokenLinks: [{ from: 'b.md', to: '缺失页' }],
    stale: ['c.md'],
    knowledgeStale: ['d.md'],
  };
}

describe('ISSUE_SECTIONS 体检项实名', () => {
  it('覆盖全部四类问题，顺序与问题行模型一致', () => {
    expect(ISSUE_SECTIONS.map((s) => s.kind)).toEqual(KINDS);
  });

  it('每条都有非空实名/图标/说明/空态文案', () => {
    for (const s of ISSUE_SECTIONS) {
      for (const field of ['title', 'icon', 'iconClass', 'desc', 'emptyText'] as const) {
        expect(s[field].trim(), `${s.kind} 的 ${field} 不应为空`).not.toBe('');
      }
    }
  });

  it('实名唯一（页面分区标题不重名）', () => {
    const titles = ISSUE_SECTIONS.map((s) => s.title);
    expect(new Set(titles).size).toBe(titles.length);
  });

  it('只有知识时效复核带「一键复核」动作', () => {
    expect(ISSUE_SECTIONS.filter((s) => s.reviewAction).map((s) => s.kind)).toEqual(['knowledge_stale']);
  });

  it('与 buildIssueRows 的四类行一一对应（类名漂移时先在这里失败）', () => {
    const kinds = new Set(buildIssueRows(report()).map((r) => r.kind));
    expect([...kinds].sort()).toEqual([...ISSUE_SECTIONS.map((s) => s.kind)].sort());
  });

  it('Health.vue 不再手抄分区实名（渲染只从 ISSUE_SECTIONS 取）', () => {
    const src = fs.readFileSync(path.resolve(__dirname, '../src/views/Health.vue'), 'utf8');
    expect(src).toContain('ISSUE_SECTIONS');
    for (const s of ISSUE_SECTIONS) {
      expect(src.includes(`title: '${s.title}'`), `Health.vue 手抄了「${s.title}」`).toBe(false);
    }
  });
});
