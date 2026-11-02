// T04094：恢复成功（或恢复失败）后 run-state 的状态必须同步到历史列表。
//
// 根因：wiki-harness 的 Harness.resume() 只返回 RunResult，不像 run() 那样在结束时
// stateStore.save()。历史列表 GET /api/compile/runs 直接投影 state.status，于是
// 用户点了「恢复」、编译也真的跑完了，列表里那条任务仍然是「失败」。
// 修复在宿主侧（compile-workflow）：续传结束把终态合并回原 state 文件，不改 harness。
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { FileStateStore, type HarnessConfig, type RunState, type StateStore } from '@wiki/harness';

import { VaultService } from '../src/vault/vault-service.js';
import { persistResumedRunState, resumeCompileWorkflow } from '../src/workflows/compile-workflow.js';
import type { ProgressEvent } from '../src/types.js';

const RUN_ID = 'aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee';

function chatResponse(content: string) {
  return {
    choices: [{ message: { content } }],
    usage: { prompt_tokens: 10, completion_tokens: 5 },
  };
}

function jsonResponse(payload: unknown): Response {
  return new Response(JSON.stringify(payload), {
    status: 200,
    headers: { 'Content-Type': 'application/json' },
  });
}

function baseState(over: Partial<RunState> = {}): RunState {
  return {
    runId: RUN_ID,
    task: '恢复测试',
    events: [{ type: 'user', content: '恢复测试', ts: '2026-11-01T00:00:00.000Z' } as never],
    step: 2,
    tokenUsed: 100,
    status: 'failed',
    startedAt: '2026-11-01T00:00:00.000Z',
    ...over,
  };
}

describe('T04094 续传后 run-state 状态同步', () => {
  let tmpDir = '';
  let vault: VaultService;
  let harnessConfig: HarnessConfig;

  beforeEach(async () => {
    tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 't04094-'));
    vault = new VaultService(path.join(tmpDir, 'vault'));
    await vault.init();
    harnessConfig = {
      llm: { provider: 'glm', baseUrl: 'http://localhost:9/v1', apiKey: 'test-key', model: 'test-model' },
      tools: [],
      stateStore: new FileStateStore(path.join(tmpDir, 'state')),
    };
  });

  afterEach(async () => {
    vi.unstubAllGlobals();
    await fs.rm(tmpDir, { recursive: true, force: true });
  });

  async function collect(iter: AsyncIterable<ProgressEvent>): Promise<ProgressEvent[]> {
    const out: ProgressEvent[] = [];
    for await (const ev of iter) out.push(ev);
    return out;
  }

  it('恢复成功：state 写回 done，历史列表不再滞留「失败」', async () => {
    const stateStore = harnessConfig.stateStore!;
    await stateStore.save(RUN_ID, baseState());
    vi.stubGlobal('fetch', vi.fn(async () => jsonResponse(chatResponse('恢复完成'))));

    const events = await collect(resumeCompileWorkflow(harnessConfig, vault, RUN_ID));

    expect(events[events.length - 1].status).toBe('done');
    const saved = await stateStore.load(RUN_ID);
    expect(saved?.status).toBe('done');
    // 只更新运行态字段：事件序列与开始时间保持原值，断点续传/审计不受影响
    expect(saved?.events).toHaveLength(1);
    expect(saved?.startedAt).toBe('2026-11-01T00:00:00.000Z');
    expect(saved?.step).toBeGreaterThan(2);
    expect(saved?.tokenUsed).toBeGreaterThanOrEqual(100);
  });

  it('恢复抛错：state 落为 failed 且保留断点，不让列表停在 running', async () => {
    const stateStore = harnessConfig.stateStore!;
    await stateStore.save(RUN_ID, baseState({ status: 'running' }));
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => new Response('unauthorized', { status: 401 })),
    );

    const events = await collect(resumeCompileWorkflow(harnessConfig, vault, RUN_ID));

    expect(events[events.length - 1].status).toBe('error');
    const saved = await stateStore.load(RUN_ID);
    expect(saved?.status).toBe('failed');
    // 运行到失败那一步（step 3）才收口，断点信息随结果前移；token 不会回退
    expect(saved?.step).toBeGreaterThanOrEqual(2);
    expect(saved?.tokenUsed).toBeGreaterThanOrEqual(100);
  });
});

describe('T04094 persistResumedRunState 边界', () => {
  function memStore(initial: RunState | null): StateStore & { saved: RunState[] } {
    const saved: RunState[] = [];
    return {
      saved,
      async save(_runId, state) {
        saved.push(state);
      },
      async load() {
        return initial;
      },
      async list() {
        return initial ? [initial.runId] : [];
      },
    };
  }

  it('budget_exceeded 与 failed 同档落为 failed，timings 随结果更新', async () => {
    const store = memStore(baseState());
    await persistResumedRunState(store, RUN_ID, {
      status: 'budget_exceeded',
      step: 5,
      tokenUsed: 900,
      timings: [{ step: 1, llmMs: 10, toolMs: 2, tokens: 3, toolNames: [] }],
    });
    expect(store.saved).toHaveLength(1);
    expect(store.saved[0].status).toBe('failed');
    expect(store.saved[0].step).toBe(5);
    expect(store.saved[0].tokenUsed).toBe(900);
    expect(store.saved[0].timings).toHaveLength(1);
  });

  it('状态文件不存在时不新建；store 缺省时静默返回', async () => {
    const empty = memStore(null);
    await persistResumedRunState(empty, RUN_ID, { status: 'done', step: 3, tokenUsed: 120 });
    expect(empty.saved).toHaveLength(0);

    await expect(persistResumedRunState(undefined, RUN_ID, { status: 'done' })).resolves.toBeUndefined();
  });

  it('写入失败被吞掉：不影响续传结果，也不向调用方抛错', async () => {
    const store: StateStore = {
      async save() {
        throw new Error('disk full');
      },
      async load() {
        return baseState();
      },
      async list() {
        return [RUN_ID];
      },
    };
    await expect(persistResumedRunState(store, RUN_ID, { status: 'done' })).resolves.toBeUndefined();
  });

  it('续传成功路径确实接了回写（防重构时漏调用）', async () => {
    const src = await fs.readFile(
      path.resolve(__dirname, '../src/workflows/compile-workflow.ts'),
      'utf8',
    );
    const resumeBody = src.slice(src.indexOf('export async function* resumeCompileWorkflow'));
    expect(resumeBody).toContain('persistResumedRunState(harnessConfig.stateStore, runId, result)');
    expect(resumeBody).toContain("persistResumedRunState(harnessConfig.stateStore, runId, { status: 'failed' })");
  });
});
