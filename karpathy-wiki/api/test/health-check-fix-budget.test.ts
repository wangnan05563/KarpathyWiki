// T04563：体检修复终态三态口径（done / budget_exceeded / failed）。
// 背景：此前 `isError = result.status === 'failed'`，budget_exceeded 落进成功的 else 分支，
// 推送「修复完成，共 N 步」并被批量作业计为已消解——预算耗尽实际未修复，口径必须修正。
import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { HarnessConfig } from '@wiki/harness';
import type { FixInput, FixProgressEvent } from '../src/types.js';
import type { VaultService } from '../src/vault/vault-service.js';

const h = vi.hoisted(() => ({
  run: vi.fn(),
  lastRunArgs: null as { signal?: AbortSignal } | null,
}));

vi.mock('@wiki/harness', () => ({
  Harness: class {
    constructor(_config: unknown) {
      void _config;
    }
    run(args: { signal?: AbortSignal }) {
      h.lastRunArgs = args;
      return h.run(args);
    }
  },
}));

import { healthCheckFixWorkflow } from '../src/workflows/health-check-fix-workflow.js';

const vault = {} as unknown as VaultService;

async function collect(input: FixInput = { issueType: 'orphan', target: 'x.md' }): Promise<FixProgressEvent[]> {
  const events: FixProgressEvent[] = [];
  for await (const ev of healthCheckFixWorkflow({} as HarnessConfig, vault, input)) events.push(ev);
  return events;
}

beforeEach(() => {
  h.run.mockReset();
  h.lastRunArgs = null;
});

describe('healthCheckFixWorkflow · T04563 终态口径', () => {
  it('budget_exceeded → 下发 error，不得出现「修复完成」', async () => {
    h.run.mockResolvedValue({
      runId: 'r',
      status: 'budget_exceeded',
      messages: [],
      finalContent: 'some partial content',
      step: 50,
      tokenUsed: 1000,
    });
    const events = await collect();

    expect(events.some((e) => e.step === 'fixed')).toBe(false);
    const terminal = events.filter((e) => e.step === 'done');
    expect(terminal).toHaveLength(1);
    expect(terminal[0].status).toBe('error');
    expect(terminal[0].message).toContain('预算');
    expect(terminal[0].message).not.toContain('修复完成');
    expect(terminal[0].data).toMatchObject({ category: 'budget', retryable: false });
  });

  it('done → 仍按成功下发 fixed + done（负控制）', async () => {
    h.run.mockResolvedValue({
      runId: 'r',
      status: 'done',
      messages: [],
      finalContent: 'ok',
      step: 3,
      tokenUsed: 20,
    });
    const events = await collect();

    const fixed = events.find((e) => e.step === 'fixed');
    const done = events.find((e) => e.step === 'done');
    expect(fixed?.status).toBe('done');
    expect(fixed?.message).toContain('修复完成');
    expect(done?.status).toBe('done');
    expect(events.some((e) => e.status === 'error')).toBe(false);
  });

  it('failed → 仍是 error（不回归）', async () => {
    h.run.mockResolvedValue({
      runId: 'r',
      status: 'failed',
      messages: [],
      finalContent: 'LLM API error 401: unauthorized',
      step: 1,
      tokenUsed: 5,
    });
    const events = await collect();
    const done = events.find((e) => e.step === 'done');
    expect(done?.status).toBe('error');
    expect(done?.message).toContain('401');
  });

  it('T04562：failed 且带结构化 error（fetch failed + cause ECONNRESET）→ 友好文案 + network/retryable', async () => {
    h.run.mockResolvedValue({
      runId: 'r',
      status: 'failed',
      messages: [],
      finalContent: '',
      step: 2,
      tokenUsed: 10,
      error: {
        name: 'TypeError',
        message: 'fetch failed',
        code: 'ECONNRESET',
        causeMessage: 'read ECONNRESET',
      },
    });
    const events = await collect();
    const done = events.find((e) => e.step === 'done');
    expect(done?.status).toBe('error');
    expect(done?.message).toContain('无法连接 LLM 服务');
    expect(done?.message).toContain('ECONNRESET');
    expect(done?.data).toMatchObject({ category: 'network', retryable: true, harnessSteps: 2, tokens: 10 });
  });

  it('T04562：failed 仅回退 finalContent 时仍按材质分类（401 → 人工处理）', async () => {
    h.run.mockResolvedValue({
      runId: 'r',
      status: 'failed',
      messages: [],
      finalContent: 'LLM API error 401: unauthorized',
      step: 1,
      tokenUsed: 5,
    });
    const events = await collect();
    const done = events.find((e) => e.step === 'done');
    expect(done?.data).toMatchObject({ category: 'auth', retryable: false });
  });

  it('FixInput.signal 原样透传给 harness.run（暂停/取消/超时的中断通道）', async () => {
    h.run.mockResolvedValue({
      runId: 'r',
      status: 'done',
      messages: [],
      finalContent: 'ok',
      step: 1,
      tokenUsed: 1,
    });
    const controller = new AbortController();
    await collect({ issueType: 'orphan', target: 'x.md', signal: controller.signal });
    expect(h.lastRunArgs?.signal).toBe(controller.signal);
  });
});
