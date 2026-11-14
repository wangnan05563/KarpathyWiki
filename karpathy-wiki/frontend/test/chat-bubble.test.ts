// 消息气泡状态机单测（T05740）
// 覆盖：
//   1. 四类块按到达顺序保留（多轮工具不合并、不乱序）
//   2. 思考 → 工具 / 思考 → 回答 的自动收口
//   3. 出错/中断时所有 running 块收口（不留幽灵流光）
//   4. 协议解析对畸形数据的防御
//   5. CSS 层「done 淡出而非瞬移」关键声明存在（防后人把 transition 改回 0s）
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  applyBubbleEvent,
  BubbleStreamState,
  createChatTurn,
  parseBubbleEvent,
  type BubbleStreamEvent,
  type ChatTurnVM,
} from '../src/types/chatBubble';
import { createLegacyBubbleAdapter } from '../src/utils/sse';

function run(events: BubbleStreamEvent[], turnId = 't1'): ChatTurnVM {
  let turn = createChatTurn(turnId, 'assistant');
  for (const event of events) turn = applyBubbleEvent(turn, event);
  return turn;
}

describe('chatBubble 状态机', () => {
  it('用户消息直接 done，且不会出现 assistant 的空态', () => {
    const turn = createChatTurn('u1', 'user');
    expect(turn.phase).toBe('done');
    expect(turn.outcome).toBe('ok');
    expect(turn.blocks).toHaveLength(0);
  });

  it('思考 → 工具 → 回答：块顺序与终态正确', () => {
    const turn = run([
      { type: 'turn_start', turnId: 't1', seq: 1, role: 'assistant' },
      { type: 'think_delta', turnId: 't1', seq: 2, text: '先看' },
      { type: 'think_delta', turnId: 't1', seq: 3, text: '知识库' },
      { type: 'tool_start', turnId: 't1', seq: 4, call: { callId: 'c1', name: 'search_pages', title: '检索知识库', status: 'running' } },
      { type: 'tool_end', turnId: 't1', seq: 5, callId: 'c1', status: 'done', summary: '命中 3 页', durationMs: 1200 },
      { type: 'answer_delta', turnId: 't1', seq: 6, text: '答案' },
      { type: 'answer_delta', turnId: 't1', seq: 7, text: '内容' },
      { type: 'turn_end', turnId: 't1', seq: 8 },
    ]);

    expect(turn.blocks.map((b) => b.kind)).toEqual(['think', 'tool', 'answer']);
    expect(turn.phase).toBe('done');
    expect(turn.outcome).toBe('ok');
    expect(turn.text).toBe('答案内容');

    const think = turn.blocks[0];
    if (think?.kind !== 'think') throw new Error('第一个块应为 think');
    expect(think.text).toBe('先看知识库');
    // tool_start 触发思考收口（不等 think_end）
    expect(think.phase).toBe('done');

    const tool = turn.blocks[1];
    if (tool?.kind !== 'tool') throw new Error('第二个块应为 tool');
    expect(tool.call.status).toBe('done');
    expect(tool.call.summary).toBe('命中 3 页');
  });

  it('多轮工具：think / tool / think / tool / answer 五块完整保留', () => {
    const turn = run([
      { type: 'turn_start', turnId: 't1', seq: 1, role: 'assistant' },
      { type: 'think_delta', turnId: 't1', seq: 2, text: '第一轮思考' },
      { type: 'tool_start', turnId: 't1', seq: 3, call: { callId: 'c1', name: 'search_pages', title: '检索', status: 'running' } },
      { type: 'tool_end', turnId: 't1', seq: 4, callId: 'c1', status: 'done' },
      { type: 'think_delta', turnId: 't1', seq: 5, text: '第二轮思考' },
      { type: 'tool_start', turnId: 't1', seq: 6, call: { callId: 'c2', name: 'read_page', title: '读页面', status: 'running' } },
      { type: 'tool_end', turnId: 't1', seq: 7, callId: 'c2', status: 'done' },
      { type: 'answer_delta', turnId: 't1', seq: 8, text: '最终答案' },
      { type: 'turn_end', turnId: 't1', seq: 9 },
    ]);

    expect(turn.blocks.map((b) => b.kind)).toEqual(['think', 'tool', 'think', 'tool', 'answer']);
    const secondThink = turn.blocks[2];
    if (secondThink?.kind !== 'think') throw new Error('第三个块应为第二轮 think');
    expect(secondThink.text).toBe('第二轮思考');
  });

  it('出错：所有 running 块收口，工具标 error，可重试', () => {
    const turn = run([
      { type: 'turn_start', turnId: 't1', seq: 1, role: 'assistant' },
      { type: 'think_delta', turnId: 't1', seq: 2, text: '思考中' },
      { type: 'tool_start', turnId: 't1', seq: 3, call: { callId: 'c1', name: 'web_search', title: '联网搜索', status: 'running' } },
      { type: 'answer_delta', turnId: 't1', seq: 4, text: '部分答案' },
      { type: 'turn_error', turnId: 't1', seq: 5, message: '上游模型 402', retryable: true },
    ]);

    expect(turn.phase).toBe('done');
    expect(turn.outcome).toBe('error');
    expect(turn.errorMessage).toBe('上游模型 402');
    expect(turn.retryable).toBe(true);
    const tool = turn.blocks.find((b) => b.kind === 'tool');
    if (tool?.kind !== 'tool') throw new Error('缺少 tool 块');
    expect(tool.call.status).toBe('error');
    const answer = turn.blocks.find((b) => b.kind === 'answer');
    if (answer?.kind !== 'answer') throw new Error('缺少 answer 块');
    expect(answer.phase).toBe('done');
  });

  it('序号校验：重复丢弃、空洞告警但保留内容', () => {
    const state = new BubbleStreamState();
    state.start('t1');
    expect(state.accept('t1', 1).status).toBe('ok');
    expect(state.accept('t1', 2).status).toBe('ok');
    expect(state.accept('t1', 2).status).toBe('duplicate');
    const gap = state.accept('t1', 5);
    expect(gap.status).toBe('gap');
    expect(gap.expected).toBe(3);
  });
});

describe('parseBubbleEvent 防御', () => {
  it('畸形 JSON 返回 null 而不是抛错', () => {
    expect(parseBubbleEvent('answer_delta', { turnId: 't1' })).toBeNull();
    expect(parseBubbleEvent('answer_delta', { turnId: 't1', seq: 1 })).toBeNull();
    expect(parseBubbleEvent('unknown_event', { turnId: 't1', seq: 1 })).toBeNull();
    expect(parseBubbleEvent('answer_delta', null)).toBeNull();
  });

  it('合法事件被还原为判别联合', () => {
    const event = parseBubbleEvent('tool_start', {
      turnId: 't1',
      seq: 4,
      call: { callId: 'c1', name: 'search_pages', title: '检索知识库', status: 'running' },
    });
    expect(event?.type).toBe('tool_start');
    if (event?.type !== 'tool_start') throw new Error('解析类型错误');
    expect(event.call.name).toBe('search_pages');
  });
});

describe('legacy SSE 适配器（T05743 P1）', () => {
  it('answer 里的 <think> 内容分流为 think 块，正文进 answer 块', () => {
    const adapter = createLegacyBubbleAdapter('t1');
    adapter.begin();
    adapter.answer('<think>先检索知识库');
    adapter.answer('再回答</think>最终答案');
    const turn = adapter.snapshot;

    expect(turn.blocks.map((b) => b.kind)).toEqual(['think', 'answer']);
    const think = turn.blocks[0];
    if (think?.kind !== 'think') throw new Error('第一个块应为 think');
    expect(think.text).toContain('先检索知识库');
    const answer = turn.blocks[1];
    if (answer?.kind !== 'answer') throw new Error('第二个块应为 answer');
    expect(answer.text).toBe('最终答案');
    expect(turn.phase).toBe('running');
  });

  it('tool_call / composing 事件驱动工具卡起止，finish 收口整轮', () => {
    const adapter = createLegacyBubbleAdapter('t2');
    adapter.begin();
    adapter.thinking({
      phase: 'thinking',
      message: '分析问题',
      ts: '2026-11-14T00:00:00.000Z',
    });
    adapter.thinking({
      phase: 'tool_call',
      message: '在知识库中检索',
      tool: 'search_pages',
      ts: '2026-11-14T00:00:00.000Z',
    });
    let turn = adapter.snapshot;
    expect(turn.blocks[0]?.kind).toBe('think');
    const tool = turn.blocks.find((b) => b.kind === 'tool');
    if (tool?.kind !== 'tool') throw new Error('缺少 tool 块');
    expect(tool.call.status).toBe('running');
    expect(tool.call.name).toBe('search_pages');

    adapter.thinking({
      phase: 'composing',
      message: '整理答案',
      ts: '2026-11-14T00:00:01.000Z',
    });
    adapter.answer('答案');
    turn = adapter.finish('ok');
    expect(turn.phase).toBe('done');
    expect(turn.outcome).toBe('ok');
    const finishedTool = turn.blocks.find((b) => b.kind === 'tool');
    if (finishedTool?.kind !== 'tool') throw new Error('缺少 tool 块');
    expect(finishedTool.call.status).toBe('done');
  });

  it('finish(error) 把未完成工具标 error 并保留错误文案', () => {
    const adapter = createLegacyBubbleAdapter('t3');
    adapter.begin();
    adapter.thinking({ phase: 'tool_call', message: '联网搜索', tool: 'web_search', ts: '2026-11-14T00:00:00.000Z' });
    const turn = adapter.finish('error', '上游 402');
    expect(turn.outcome).toBe('error');
    expect(turn.errorMessage).toBe('上游 402');
    const tool = turn.blocks.find((b) => b.kind === 'tool');
    if (tool?.kind !== 'tool') throw new Error('缺少 tool 块');
    expect(tool.call.status).toBe('error');
  });
});

describe('CSS：done 淡出而非瞬间移除', () => {
  // vitest 的 cwd 即 frontend 根（package.json 所在目录），用相对根拼绝对路径最稳妥；
  // import.meta.url 在 vitest 转换后不是 file:// scheme，fileURLToPath 会抛 ERR_INVALID_URL_SCHEME
  const css = readFileSync(join(process.cwd(), 'src/styles/message-bubble.css'), 'utf-8');

  it('存在 fading 态与 600ms 透明度过渡', () => {
    expect(css).toContain('.kw-shimmer.is-fading');
    expect(css).toContain('transition: opacity var(--kw-shimmer-fade-ms, 600ms)');
  });

  it('淡出期间暂停扫描动画，保留最后一帧', () => {
    expect(css).toContain('animation-play-state: paused');
  });

  it('无动画偏好下关闭流光与扫描', () => {
    expect(css).toContain('@media (prefers-reduced-motion: reduce)');
  });
});
