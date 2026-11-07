// T04563：前端失败分流与重试前刷新。
// 后端已给 failed 项带 retryable/category，前端必须：
//   1) 只把可恢复项重新提交为新作业（认证/413/预算等永久失败重跑只会再失败）；
//   2) batch_done / batch_stopped 后刷新体检报告，避免 retryFailed 依据陈旧 allRows 裁剪 payload。
import { describe, it, expect, beforeEach } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { setActivePinia, createPinia } from 'pinia';
import { useHealthStore } from '../src/stores/health';
import { splitRetryableFailures, failureCategoryLabel } from '../src/utils/healthList';
import type { BatchFixJobSnapshot } from '../src/types';

function healthSource(): string {
  return fs.readFileSync(path.resolve(__dirname, '../src/views/Health.vue'), 'utf8');
}

function snapshot(overrides: Partial<BatchFixJobSnapshot> = {}): BatchFixJobSnapshot {
  return {
    jobId: 'job-1',
    status: 'completed',
    total: 3,
    doneCount: 3,
    successCount: 1,
    failCount: 2,
    ineffectiveCount: 0,
    ineffective: [],
    currentIssueKey: '',
    pauseRequested: false,
    startedAt: 0,
    updatedAt: 0,
    elapsedMs: 1,
    avgMsPerIssue: 1,
    avgStepsPerIssue: 0,
    doneKeys: ['orphan:ok.md'],
    failed: [
      { issueKey: 'orphan:auth.md', message: 'LLM API 认证失败（HTTP 401）', retryable: false, category: 'auth' },
      { issueKey: 'orphan:flaky.md', message: 'fetch failed', retryable: true, category: 'service_down' },
    ],
    nextIndex: 3,
    ...overrides,
  };
}

describe('T04563 失败分流纯函数', () => {
  it('可重试 = 未消解 + retryable!==false；需人工 = retryable===false', () => {
    const split = splitRetryableFailures(
      [
        { issueKey: 'orphan:auth.md', message: '401', retryable: false, category: 'auth' },
        { issueKey: 'orphan:flaky.md', message: 'ECONNRESET', retryable: true },
      ],
      [{ issueKey: 'orphan:still.md', message: '未消解' }],
    );
    expect(split.manual.map((f) => f.issueKey)).toEqual(['orphan:auth.md']);
    expect([...split.retryableKeys].sort()).toEqual(['orphan:flaky.md', 'orphan:still.md']);
  });

  it('旧数据无 retryable 字段 → 按可重试降级', () => {
    const split = splitRetryableFailures([{ issueKey: 'orphan:legacy.md', message: '旧失败' }]);
    expect(split.manual).toEqual([]);
    expect(split.retryableKeys.has('orphan:legacy.md')).toBe(true);
  });

  it('失败类别渲染为可读文案', () => {
    expect(failureCategoryLabel('budget')).toBe('超出预算');
    expect(failureCategoryLabel('auth')).toBe('认证失败');
    expect(failureCategoryLabel(undefined)).toBe('');
  });
});

describe('T04563 health store 透传可重试性', () => {
  beforeEach(() => {
    setActivePinia(createPinia());
  });

  it('issue_error 事件带 retryable/category 时原样落入 batchFailed', () => {
    const store = useHealthStore();
    store.handleBatchEvent('batch_start', { jobId: 'job-1', totalIssues: 1 });
    store.handleBatchEvent('issue_error', {
      issueKey: 'orphan:auth.md',
      issueIndex: 0,
      totalIssues: 1,
      status: 'error',
      message: 'LLM API 认证失败（HTTP 401）',
      retryable: false,
      category: 'auth',
    });
    expect(store.batchFailed[0]).toMatchObject({ retryable: false, category: 'auth' });
  });

  it('快照校准：旧快照 failed 无 retryable → 降级为可重试，新快照保留 false', () => {
    const store = useHealthStore();
    store.applySnapshot(snapshot({ failed: [{ issueKey: 'orphan:legacy.md', message: '旧失败' }] }));
    expect(store.batchFailed[0].retryable).toBe(true);

    store.applySnapshot(snapshot());
    const auth = store.batchFailed.find((f) => f.issueKey === 'orphan:auth.md');
    expect(auth?.retryable).toBe(false);
  });
});

describe('T04563 Health.vue 接线', () => {
  it('batch_done / batch_stopped 后触发 runCheck 刷新报告', () => {
    const src = healthSource();
    expect(src).toMatch(
      /parsed\.eventType === 'batch_done'[\s\S]{0,600}void runCheck\(\)/,
    );
  });

  it('retryFailed 只提交可恢复项；需人工项单独成段', () => {
    const src = healthSource();
    expect(src).toContain('void openEstimate(retrySplit.value.retryableKeys)');
    expect(src).toContain('需人工处理（{{ retrySplit.manual.length }}）');
    expect(src).toContain('可重试项（{{ retrySplit.retryable.length }}）');
  });
});
