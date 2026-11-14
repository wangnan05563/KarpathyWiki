// @vitest-environment jsdom
// T05743 P1 集成测试：session buffer → legacy 适配器 → currentTurn → 消息落库 → 700ms 淡出保留
import { createPinia, setActivePinia } from 'pinia';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { useQueryStore } from '../src/stores/query';

beforeEach(() => {
  setActivePinia(createPinia());
  localStorage.clear();
});

describe('query store 气泡轮集成', () => {
  it('begin → answer → finalize：消息 id 复用 turn id，currentTurn 保留 700ms 后清除', () => {
    vi.useFakeTimers();
    const store = useQueryStore();

    store.beginStreaming();
    expect(store.isLoading).toBe(true);
    const turnId = store.currentTurn?.id;
    expect(turnId).toBeTruthy();

    store.appendAnswer('<think>先想一下</think>最终答案');
    const turn = store.currentTurn;
    expect(turn?.blocks.map((b) => b.kind)).toEqual(['think', 'answer']);
    expect(turn?.phase).toBe('running');

    store.finalizeAnswer();
    expect(store.isLoading).toBe(false);
    expect(store.messages).toHaveLength(1);
    expect(store.messages[0]?.id).toBe(turnId);
    expect(store.messages[0]?.content).toBe('最终答案');
    expect(store.currentTurn?.phase).toBe('done');

    // 600ms 是 CSS 淡出时长，699ms 时仍必须挂载（否则流光会被瞬间卸载）
    vi.advanceTimersByTime(699);
    expect(store.currentTurn).not.toBeNull();
    vi.advanceTimersByTime(1);
    expect(store.currentTurn).toBeNull();
    vi.useRealTimers();
  });

  it('handleError 保留 think 内容并把工具卡收口为 error', () => {
    const store = useQueryStore();
    store.beginStreaming();
    store.appendThinking({
      phase: 'tool_call',
      message: '检索知识库',
      tool: 'search_pages',
      ts: '2026-11-14T00:00:00.000Z',
    });
    store.handleError('上游 402');
    expect(store.messages).toHaveLength(1);
    expect(store.messages[0]?.status).toBe('error');
    expect(store.currentTurn?.outcome).toBe('error');
  });
});
