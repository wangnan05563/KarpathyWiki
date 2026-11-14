import { describe, expect, it } from 'vitest';
import { SseV2Encoder } from '../src/utils/sse-v2.js';
import { V2Run } from '../src/workflows/v2-stream-registry.js';

function collect(): { frames: Array<{ event: string; data: Record<string, unknown> }>; encoder: SseV2Encoder } {
  const frames: Array<{ event: string; data: Record<string, unknown> }> = [];
  const encoder = new SseV2Encoder('turn-test', (frame) => frames.push(frame));
  return { frames, encoder };
}

describe('SseV2Encoder', () => {
  it('把 thinking/tool/answer/done 编码为连续 seq 的 v2 事件', () => {
    const { frames, encoder } = collect();
    encoder.start();
    encoder.push({ thinking: { phase: 'thinking', message: '先检索知识库' } });
    encoder.push({ thinking: { phase: 'tool_call', message: '检索页面', tool: 'search_pages' } });
    encoder.push({ progress: { step: '检索中', count: 2 } });
    encoder.push({ thinking: { phase: 'composing', message: '' } });
    encoder.push({ text: '知识库里有三篇相关页面。' });
    encoder.done({
      runId: 'harness-run',
      threadId: 'thread-1',
      sessionId: 'session-1',
      messageIndex: 0,
      governor: null,
      refs: ['页面A'],
      webRefs: [],
    });

    const seqs = frames.map((f) => f.data.seq).filter((seq): seq is number => typeof seq === 'number');
    expect(seqs).toEqual(Array.from({ length: seqs.length }, (_, i) => i + 1));
    expect(frames[0].event).toBe('turn_start');
    expect(frames.some((f) => f.event === 'think_delta')).toBe(true);
    expect(frames.some((f) => f.event === 'tool_start')).toBe(true);
    expect(frames.some((f) => f.event === 'tool_progress')).toBe(true);
    expect(frames.some((f) => f.event === 'tool_end')).toBe(true);
    expect(frames.some((f) => f.event === 'answer_delta')).toBe(true);
    expect(frames.filter((f) => f.event === 'answer_end')).toHaveLength(1);
    expect(frames.at(-1)?.event).toBe('turn_end');
    expect(frames.at(-1)?.data.outcome).toBe('ok');
    expect(frames.at(-1)?.data.threadId).toBe('thread-1');
  });

  it('长文本按 8KB 上限分片且内容不丢不重', () => {
    const { frames, encoder } = collect();
    encoder.start();
    const text = '知识库'.repeat(1200); // 3600 字符，UTF-8 约 10.8KB
    encoder.push({ text });
    encoder.done({
      runId: 'r', threadId: 't', sessionId: 's', messageIndex: 0, governor: null, refs: [], webRefs: [],
    });

    const deltas = frames.filter((f) => f.event === 'answer_delta');
    expect(deltas.length).toBeGreaterThan(1);
    expect(deltas.map((f) => f.data.text as string).join('')).toBe(text);
    for (const frame of frames) {
      const json = JSON.stringify(frame.data);
      expect(Buffer.byteLength(json, 'utf8')).toBeLessThanOrEqual(8192);
    }
    expect(frames.some((f) => f.event === 'answer_end')).toBe(true);
  });

  it('error 收口为 turn_error，不再发 turn_end', () => {
    const { frames, encoder } = collect();
    encoder.start();
    encoder.error('上游超时');
    expect(frames.at(-1)?.event).toBe('turn_error');
    expect(frames.at(-1)?.data.message).toBe('上游超时');
    expect(frames.some((f) => f.event === 'turn_end')).toBe(false);
  });

  it('afterSeq 只返回严格大于该序号的帧', () => {
    const { encoder } = collect();
    encoder.start();
    encoder.push({ text: 'A' });
    encoder.push({ text: 'B' });
    const replay = encoder.after(2);
    expect(replay.every((f) => (f.data.seq as number) > 2)).toBe(true);
    expect(replay.map((f) => f.event)).toContain('answer_delta');
    expect(replay[0]?.data.text).toBe('B');
  });

  it('V2Run 断线后按 afterSeq 只补发缺失帧，终态结束后自动 end', () => {
    const run = new V2Run('run-replay');
    const first: Array<{ event: string; seq: number }> = [];
    const detach = run.attach(
      (event, data) => {
        first.push({ event, seq: (data as { seq: number }).seq });
        return true;
      },
      0,
      () => undefined,
    );
    expect(first[0]).toEqual({ event: 'turn_start', seq: 1 });
    detach();

    // 首连接断开后 run 继续编码
    run.recordChunk({ text: 'A' });
    run.recordChunk({ text: 'B' });

    const replay: Array<{ event: string; seq: number }> = [];
    let ended = false;
    run.attach(
      (event, data) => {
        replay.push({ event, seq: (data as { seq: number }).seq });
        return true;
      },
      1,
      () => { ended = true; },
    );
    expect(replay.map((f) => f.event)).not.toContain('turn_start');
    expect(replay.every((f) => f.seq > 1)).toBe(true);
    expect(replay.filter((f) => f.event === 'answer_delta')).toHaveLength(2);

    run.recordDone({
      runId: 'harness-1',
      threadId: 'thread-1',
      sessionId: 'session-1',
      messageIndex: 0,
      governor: null,
      refs: [],
      webRefs: [],
    });
    expect(replay.at(-1)?.event).toBe('turn_end');
    expect(ended).toBe(true);
  });
});
