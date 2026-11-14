import { describe, expect, it, vi } from 'vitest';
import { useBubbleStream } from '../src/composables/useBubbleStream';
import type { ChatTurnVM } from '../src/types/chatBubble';

interface Frame {
  event: string;
  data: Record<string, unknown>;
}

function toSSE(frames: Frame[]): string {
  return frames.map((f) => `event: ${f.event}\ndata: ${JSON.stringify(f.data)}\n\n`).join('');
}

function responseOf(frames: Frame[]): Response {
  return new Response(toSSE(frames), {
    status: 200,
    headers: { 'Content-Type': 'text/event-stream' },
  });
}

function answerText(turn: ChatTurnVM): string {
  return turn.blocks
    .filter((b) => b.kind === 'answer')
    .map((b) => b.text)
    .join('');
}

describe('useBubbleStream 消费 v2 协议', () => {
  it('正常流：think → tool → answer → turn_end，状态收口为 done', async () => {
    const stream = useBubbleStream();
    const frames: Frame[] = [
      { event: 'turn_start', data: { turnId: 't1', seq: 1, role: 'assistant' } },
      { event: 'think_delta', data: { turnId: 't1', seq: 2, blockId: 't1:think:1', text: '先检索知识库' } },
      {
        event: 'tool_start',
        data: {
          turnId: 't1', seq: 3,
          call: { callId: 'c1', name: 'search_pages', title: '检索页面', status: 'running' },
        },
      },
      { event: 'tool_progress', data: { turnId: 't1', seq: 4, callId: 'c1', message: '命中 2 页' } },
      { event: 'tool_end', data: { turnId: 't1', seq: 5, callId: 'c1', status: 'done', durationMs: 120 } },
      { event: 'answer_delta', data: { turnId: 't1', seq: 6, blockId: 't1:answer:1', text: '答案正文' } },
      { event: 'turn_end', data: { turnId: 't1', seq: 7, outcome: 'ok' } },
    ];
    await stream.start(responseOf(frames), 't1');

    expect(stream.status.value).toBe('done');
    expect(stream.turn.value?.blocks.map((b) => b.kind)).toEqual(['think', 'tool', 'answer']);
    expect(answerText(stream.turn.value!)).toBe('答案正文');
    expect(stream.turn.value?.blocks[1]).toMatchObject({
      kind: 'tool',
      call: { status: 'done', durationMs: 120, progressMessage: undefined },
    });
  });

  it('断流后按 lastSeq 续传：只追加缺失帧，不重复渲染', async () => {
    const first: Frame[] = [
      { event: 'turn_start', data: { turnId: 't2', seq: 1, role: 'assistant' } },
      { event: 'answer_delta', data: { turnId: 't2', seq: 2, text: 'A' } },
      { event: 'answer_delta', data: { turnId: 't2', seq: 3, text: 'B' } },
    ];
    const second: Frame[] = [
      { event: 'answer_delta', data: { turnId: 't2', seq: 4, text: 'C' } },
      { event: 'turn_end', data: { turnId: 't2', seq: 5, outcome: 'ok' } },
    ];
    const resumeCalls: Array<{ turnId: string; afterSeq: number }> = [];
    const stream = useBubbleStream({
      resume: async (turnId, afterSeq) => {
        resumeCalls.push({ turnId, afterSeq });
        return responseOf(second);
      },
    });
    await stream.start(responseOf(first), 't2');

    expect(resumeCalls).toEqual([{ turnId: 't2', afterSeq: 3 }]);
    expect(stream.status.value).toBe('done');
    expect(answerText(stream.turn.value!)).toBe('ABC');
  });

  it('seq 空洞回调 onSeqGap，但仍应用内容', async () => {
    const gaps: Array<[number, number]> = [];
    const stream = useBubbleStream({ onSeqGap: (expected, received) => gaps.push([expected, received]) });
    const frames: Frame[] = [
      { event: 'turn_start', data: { turnId: 't3', seq: 1, role: 'assistant' } },
      { event: 'answer_delta', data: { turnId: 't3', seq: 3, text: '缺口后的正文' } },
      { event: 'turn_end', data: { turnId: 't3', seq: 4, outcome: 'ok' } },
    ];
    await stream.start(responseOf(frames), 't3');

    expect(gaps).toEqual([[2, 3]]);
    expect(stream.status.value).toBe('done');
    expect(answerText(stream.turn.value!)).toBe('缺口后的正文');
  });

  it('refs 等 side 事件不占 seq，不触发空洞也不打断收口', async () => {
    const gaps: Array<[number, number]> = [];
    const stream = useBubbleStream({ onSeqGap: (expected, received) => gaps.push([expected, received]) });
    const frames: Frame[] = [
      { event: 'turn_start', data: { turnId: 't5', seq: 1, role: 'assistant' } },
      { event: 'answer_delta', data: { turnId: 't5', seq: 2, text: '答案' } },
      // side 事件沿用 legacy 事件名，不带 seq；消费器应忽略且不推进基线
      { event: 'refs', data: { turnId: 't5', refs: ['页面A'], webRefs: [] } },
      { event: 'answer_end', data: { turnId: 't5', seq: 3 } },
      { event: 'turn_end', data: { turnId: 't5', seq: 4, outcome: 'ok' } },
    ];
    await stream.start(responseOf(frames), 't5');

    expect(gaps).toEqual([]);
    expect(stream.status.value).toBe('done');
    expect(answerText(stream.turn.value!)).toBe('答案');
  });

  it('连续多轮工具：两块工具卡按到达顺序保留', async () => {
    const stream = useBubbleStream();
    const frames: Frame[] = [
      { event: 'turn_start', data: { turnId: 't4', seq: 1, role: 'assistant' } },
      { event: 'tool_start', data: { turnId: 't4', seq: 2, call: { callId: 'c1', name: 'search_pages', title: '第一次检索', status: 'running' } } },
      { event: 'tool_end', data: { turnId: 't4', seq: 3, callId: 'c1', status: 'done' } },
      { event: 'think_delta', data: { turnId: 't4', seq: 4, blockId: 't4:think:1', text: '继续检索' } },
      { event: 'tool_start', data: { turnId: 't4', seq: 5, call: { callId: 'c2', name: 'read_page', title: '第二次读取', status: 'running' } } },
      { event: 'tool_end', data: { turnId: 't4', seq: 6, callId: 'c2', status: 'done' } },
      { event: 'answer_delta', data: { turnId: 't4', seq: 7, text: '最终答案' } },
      { event: 'turn_end', data: { turnId: 't4', seq: 8, outcome: 'ok' } },
    ];
    await stream.start(responseOf(frames), 't4');

    const tools = stream.turn.value?.blocks.filter((b) => b.kind === 'tool') ?? [];
    expect(tools).toHaveLength(2);
    expect(tools.map((b) => (b.kind === 'tool' ? b.call.callId : ''))).toEqual(['c1', 'c2']);
    expect(stream.status.value).toBe('done');
  });
});

// 抑制 composable 在非组件环境调用 onBeforeUnmount 的 Vue 警告，不影响行为断言
vi.spyOn(console, 'warn').mockImplementation(() => undefined);
