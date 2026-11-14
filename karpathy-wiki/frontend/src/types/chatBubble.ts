// 消息气泡交互层（豆包同款流式体验）的视图模型 + SSE 事件协议 + 纯函数状态机。
//
// 为什么放在 types 而非某个组件内：
//   1. 协议、状态迁移、渲染是三件事，状态机做成不依赖 Vue/Pinia 的纯函数后可以直接单测与回放；
//   2. 桌面 Query.vue、FloatingChat.vue、移动端 MobileQuery.vue 共用同一份迁移逻辑，
//      避免三处各写一套 if/else 导致状态口径漂移（历史 S3776 复杂度问题的同类根因）；
//   3. 组件只消费不可变快照（ChatTurnVM），任何事件都返回新对象，便于 Vue 精确触发更新。
//
// 消息类型（与 T05740 任务书一致）：
//   user     用户输入
//   ai_think Agent 思考链路（可折叠）
//   ai_tool  工具调用状态（检索知识库 / 调用函数）
//   ai_answer 最终回答（流式 + 打字机，无流光）
//
// 三态：
//   idle    初始，尚未收到任何内容
//   running 流式输出中（流光动画的唯一起播条件）
//   done    流结束（outcome 区分正常结束 / 出错 / 中断）

export type BubbleType = 'user' | 'ai_think' | 'ai_tool' | 'ai_answer';
export type BubblePhase = 'idle' | 'running' | 'done';
export type BubbleOutcome = 'ok' | 'error' | 'interrupted';
export type ToolStatus = 'running' | 'done' | 'error';

// 单次工具调用的视图模型：一次调用 = 一个 tool 块，保证「思考 → 工具 → 思考」的到达顺序不被合并丢失
export interface ToolCallVM {
  callId: string;
  /** 机器可读的工具名，如 search_pages / read_page / web_search */
  name: string;
  /** 面向用户的一句话说明，如「在知识库中检索 3 个页面」 */
  title: string;
  /** 参数预览（JSON 截断或自然语言），仅在详情区展示 */
  argsPreview?: string;
  status: ToolStatus;
  /** 结果摘要，如「命中 3 页 · 1.2s」 */
  summary?: string;
  durationMs?: number;
  /** 工具执行中的阶段提示（轮询式刷新） */
  progressMessage?: string;
  errorMessage?: string;
}

// 思考块：每轮思考独立成块（多轮工具场景会出现多个，按到达顺序排列）
export interface ThinkBlockVM {
  kind: 'think';
  id: string;
  text: string;
  phase: BubblePhase;
  durationMs?: number;
}

export interface ToolBlockVM {
  kind: 'tool';
  id: string;
  call: ToolCallVM;
}

export interface AnswerBlockVM {
  kind: 'answer';
  id: string;
  text: string;
  phase: BubblePhase;
}

export type BubbleBlockVM = ThinkBlockVM | ToolBlockVM | AnswerBlockVM;

// 一轮 AI 回合（或一条用户消息）的完整视图模型
export interface ChatTurnVM {
  id: string;
  role: 'user' | 'assistant';
  phase: BubblePhase;
  outcome: BubbleOutcome;
  /** 按到达顺序排列的块（think / tool / answer 可任意交错） */
  blocks: BubbleBlockVM[];
  /** user：问题原文；assistant：各 answer 块拼接后的纯文本（复制/导出用） */
  text: string;
  refs?: string[];
  errorMessage?: string;
  retryable?: boolean;
  createdAt: number;
  updatedAt: number;
}

interface BubbleEventBase {
  /** 单调递增的流内序号，从 1 开始；用于丢重复、查空洞 */
  seq: number;
  turnId: string;
}

export type BubbleStreamEvent =
  | (BubbleEventBase & { type: 'turn_start'; role: 'user' | 'assistant' })
  | (BubbleEventBase & { type: 'think_delta'; blockId?: string; text: string })
  | (BubbleEventBase & { type: 'think_end'; blockId?: string; durationMs?: number })
  | (BubbleEventBase & { type: 'tool_start'; blockId?: string; call: ToolCallVM })
  | (BubbleEventBase & {
      type: 'tool_progress';
      blockId?: string;
      callId?: string;
      message?: string;
    })
  | (BubbleEventBase & {
      type: 'tool_end';
      blockId?: string;
      callId?: string;
      status: 'done' | 'error';
      summary?: string;
      durationMs?: number;
      errorMessage?: string;
    })
  | (BubbleEventBase & { type: 'answer_delta'; blockId?: string; text: string })
  | (BubbleEventBase & { type: 'answer_end'; blockId?: string })
  | (BubbleEventBase & { type: 'turn_end'; outcome?: BubbleOutcome; errorMessage?: string })
  | (BubbleEventBase & { type: 'turn_error'; message: string; retryable?: boolean })
  | (BubbleEventBase & { type: 'seq_gap'; expected: number; received: number });

export function createChatTurn(
  id: string,
  role: 'user' | 'assistant',
  now: number = Date.now(),
): ChatTurnVM {
  return {
    id,
    role,
    // 用户消息不走流式：直接终态，避免用户气泡出现无意义的流光
    phase: role === 'user' ? 'done' : 'idle',
    outcome: 'ok',
    blocks: [],
    text: '',
    createdAt: now,
    updatedAt: now,
  };
}

/** assistant 回合的纯文本答案（多 answer 块按顺序拼接） */
export function getAnswerText(turn: ChatTurnVM): string {
  return turn.blocks
    .filter((b): b is AnswerBlockVM => b.kind === 'answer')
    .map((b) => b.text)
    .join('');
}

/** 某个块是否仍在流式中（供流光/骨架判断） */
export function isBlockRunning(block: BubbleBlockVM): boolean {
  if (block.kind === 'tool') return block.call.status === 'running';
  return block.phase === 'running';
}

function findLastRunningThink(blocks: BubbleBlockVM[]): number {
  for (let i = blocks.length - 1; i >= 0; i -= 1) {
    const b = blocks[i];
    if (b && b.kind === 'think' && b.phase === 'running') return i;
  }
  return -1;
}

function findThink(blocks: BubbleBlockVM[], blockId?: string): number {
  if (blockId) {
    return blocks.findIndex((b) => b.kind === 'think' && b.id === blockId);
  }
  const running = findLastRunningThink(blocks);
  if (running >= 0) return running;
  // 没有 running 的思考块时回退到最后一个 think：
  // think_end 晚于 answer_delta 到达（网络乱序）时需要能落到正确的块上
  for (let i = blocks.length - 1; i >= 0; i -= 1) {
    const b = blocks[i];
    if (b && b.kind === 'think') return i;
  }
  return -1;
}

function findTool(blocks: BubbleBlockVM[], blockId?: string, callId?: string): number {
  if (blockId) {
    const byId = blocks.findIndex((b) => b.kind === 'tool' && b.id === blockId);
    if (byId >= 0) return byId;
  }
  const key = callId;
  for (let i = blocks.length - 1; i >= 0; i -= 1) {
    const b = blocks[i];
    if (!b || b.kind !== 'tool') continue;
    if (!key || b.call.callId === key) return i;
  }
  return -1;
}

function countBlocks(blocks: BubbleBlockVM[], kind: BubbleBlockVM['kind']): number {
  return blocks.reduce((n, b) => (b.kind === kind ? n + 1 : n), 0);
}

function nextBlockId(turnId: string, blocks: BubbleBlockVM[], kind: BubbleBlockVM['kind']): string {
  return `${turnId}:${kind}:${countBlocks(blocks, kind) + 1}`;
}

/**
 * 事件 → 新快照（纯函数、不可变）。
 *
 * 关键约定：
 * - answer_delta 首次到达时，把所有 running 的 think 块收口为 done：
 *   对应豆包「开始回答后思考区自动折叠」的观感；think_end 事件晚到也不会重复处理（幂等）。
 * - 多轮工具：新 tool_start 不会清空已有块，因此「think → tool → think → answer」
 *   会在 blocks 中完整保留四段，渲染顺序即到达顺序。
 * - turn_end 兜底：任何仍 running 的块一律收口，避免流结束后还有动效在跑（T05740 边界要求）。
 */
export function applyBubbleEvent(
  turn: ChatTurnVM,
  event: BubbleStreamEvent,
  now: number = Date.now(),
): ChatTurnVM {
  if (!turn || event.turnId !== turn.id) return turn;

  const blocks = turn.blocks.slice();
  let phase: BubblePhase = turn.phase;
  let outcome: BubbleOutcome = turn.outcome;
  let errorMessage = turn.errorMessage;
  let retryable = turn.retryable;

  switch (event.type) {
    case 'turn_start': {
      phase = turn.role === 'user' ? 'done' : 'running';
      break;
    }
    case 'think_delta': {
      phase = 'running';
      // 无 blockId 时只续写「仍在 running」的思考块；上一轮已收口的思考不能被续写，
      // 否则多轮工具场景会把第二轮思考拼进第一段（顺序与折叠摘要都会失真）
      const idx = event.blockId
        ? blocks.findIndex((b) => b.kind === 'think' && b.id === event.blockId)
        : findLastRunningThink(blocks);
      if (idx >= 0) {
        const prev = blocks[idx] as ThinkBlockVM;
        blocks[idx] = { ...prev, text: prev.text + event.text, phase: 'running' };
      } else {
        blocks.push({
          kind: 'think',
          id: event.blockId || nextBlockId(turn.id, blocks, 'think'),
          text: event.text,
          phase: 'running',
        });
      }
      break;
    }
    case 'think_end': {
      const idx = findThink(blocks, event.blockId);
      if (idx >= 0) {
        const prev = blocks[idx] as ThinkBlockVM;
        blocks[idx] = { ...prev, phase: 'done', durationMs: event.durationMs ?? prev.durationMs };
      }
      break;
    }
    case 'tool_start': {
      phase = 'running';
      // 发起工具调用 = 本轮思考结束（豆包同款：思考区在工具卡出现前收起）
      for (let i = 0; i < blocks.length; i += 1) {
        const b = blocks[i];
        if (b && b.kind === 'think' && b.phase === 'running') {
          blocks[i] = { ...b, phase: 'done' };
        }
      }
      const id = event.blockId || `${turn.id}:tool:${event.call.callId}`;
      const exists = blocks.findIndex((b) => b.kind === 'tool' && b.id === id);
      const next: ToolBlockVM = { kind: 'tool', id, call: { ...event.call } };
      if (exists >= 0) blocks[exists] = next;
      else blocks.push(next);
      break;
    }
    case 'tool_progress': {
      const idx = findTool(blocks, event.blockId, event.callId);
      if (idx >= 0) {
        const prev = blocks[idx] as ToolBlockVM;
        blocks[idx] = {
          ...prev,
          call: { ...prev.call, progressMessage: event.message ?? prev.call.progressMessage },
        };
      }
      break;
    }
    case 'tool_end': {
      const idx = findTool(blocks, event.blockId, event.callId);
      if (idx >= 0) {
        const prev = blocks[idx] as ToolBlockVM;
        blocks[idx] = {
          ...prev,
          call: {
            ...prev.call,
            status: event.status,
            summary: event.summary ?? prev.call.summary,
            durationMs: event.durationMs ?? prev.call.durationMs,
            errorMessage: event.errorMessage ?? prev.call.errorMessage,
            progressMessage: undefined,
          },
        };
      }
      break;
    }
    case 'answer_delta': {
      phase = 'running';
      // 回答开始 = 思考结束（豆包同款观感：思考区自动折叠，不等待 think_end 事件）
      for (let i = 0; i < blocks.length; i += 1) {
        const b = blocks[i];
        if (b && b.kind === 'think' && b.phase === 'running') {
          blocks[i] = { ...b, phase: 'done' };
        }
      }
      const last = blocks[blocks.length - 1];
      if (last && last.kind === 'answer') {
        blocks[blocks.length - 1] = {
          ...last,
          text: last.text + event.text,
          phase: 'running',
        };
      } else {
        blocks.push({
          kind: 'answer',
          id: event.blockId || nextBlockId(turn.id, blocks, 'answer'),
          text: event.text,
          phase: 'running',
        });
      }
      break;
    }
    case 'answer_end': {
      const idx = event.blockId
        ? blocks.findIndex((b) => b.kind === 'answer' && b.id === event.blockId)
        : blocks.length - 1;
      const b = idx >= 0 ? blocks[idx] : undefined;
      if (b && b.kind === 'answer') blocks[idx] = { ...b, phase: 'done' };
      break;
    }
    case 'turn_end': {
      phase = 'done';
      outcome = event.outcome ?? 'ok';
      errorMessage = event.errorMessage ?? errorMessage;
      closeAllBlocks(blocks, outcome);
      break;
    }
    case 'turn_error': {
      phase = 'done';
      outcome = 'error';
      errorMessage = event.message;
      retryable = event.retryable ?? true;
      closeAllBlocks(blocks, 'error');
      break;
    }
    case 'seq_gap': {
      // 缺口本身不改变文案：内容层已有部分数据，交由调用方提示/触发续传（见 useBubbleStream）
      break;
    }
  }

  return {
    ...turn,
    blocks,
    phase,
    outcome,
    errorMessage,
    retryable,
    text: turn.role === 'user' ? turn.text : getAnswerText({ ...turn, blocks }),
    updatedAt: now,
  };
}

/** 流终止时收口所有仍在 running 的块，避免幽灵流光/转圈 */
function closeAllBlocks(blocks: BubbleBlockVM[], outcome: BubbleOutcome): void {
  for (let i = 0; i < blocks.length; i += 1) {
    const b = blocks[i];
    if (!b) continue;
    if (b.kind === 'tool') {
      if (b.call.status === 'running') {
        blocks[i] = {
          ...b,
          call: {
            ...b.call,
            status: outcome === 'ok' ? 'done' : 'error',
            errorMessage: outcome === 'ok' ? b.call.errorMessage : b.call.errorMessage || '未收到工具结果',
          },
        };
      }
      continue;
    }
    if (b.phase === 'running') blocks[i] = { ...b, phase: 'done' };
  }
}

/** 断言序列号：重复丢、跳号告警但仍应用（内容优先，避免整轮白屏） */
export interface SeqVerdict {
  status: 'ok' | 'duplicate' | 'gap';
  expected: number;
}

export class BubbleStreamState {
  private turnId = '';
  private lastSeq = 0;

  start(turnId: string): void {
    this.turnId = turnId;
    this.lastSeq = 0;
  }

  get last(): number {
    return this.lastSeq;
  }

  accept(turnId: string, seq: number): SeqVerdict {
    if (turnId !== this.turnId) {
      // 换轮次：重置基线，接受新流
      this.start(turnId);
    }
    const expected = this.lastSeq + 1;
    if (seq <= this.lastSeq) return { status: 'duplicate', expected };
    const status = seq === expected ? 'ok' : 'gap';
    this.lastSeq = seq;
    return { status, expected };
  }
}

// ---- SSE 运行时解析：把「事件名 + JSON」还原成上面的判别联合（不信任网络数据） ----

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function asString(value: unknown): string | undefined {
  return typeof value === 'string' ? value : undefined;
}

function asNumber(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) ? value : undefined;
}

function parseToolCall(raw: unknown): ToolCallVM | null {
  if (!isRecord(raw)) return null;
  const callId = asString(raw.callId);
  const name = asString(raw.name);
  const title = asString(raw.title);
  if (!callId || !name || !title) return null;
  const status = raw.status === 'done' || raw.status === 'error' ? raw.status : 'running';
  return {
    callId,
    name,
    title,
    status,
    argsPreview: asString(raw.argsPreview),
    summary: asString(raw.summary),
    durationMs: asNumber(raw.durationMs),
    progressMessage: asString(raw.progressMessage),
    errorMessage: asString(raw.errorMessage),
  };
}

/**
 * 解析单个 SSE 事件。返回 null 表示字段不合法（调用方应丢弃并记一条协议错误，而不是崩掉整条流）。
 */
export function parseBubbleEvent(eventName: string, raw: unknown): BubbleStreamEvent | null {
  if (!isRecord(raw)) return null;
  const turnId = asString(raw.turnId);
  const seq = asNumber(raw.seq);
  if (!turnId || seq === undefined) return null;

  switch (eventName) {
    case 'turn_start': {
      const role = raw.role === 'user' ? 'user' : 'assistant';
      return { type: 'turn_start', turnId, seq, role };
    }
    case 'think_delta': {
      const text = asString(raw.text);
      if (!text) return null;
      return { type: 'think_delta', turnId, seq, text, blockId: asString(raw.blockId) };
    }
    case 'think_end':
      return { type: 'think_end', turnId, seq, durationMs: asNumber(raw.durationMs), blockId: asString(raw.blockId) };
    case 'tool_start': {
      const call = parseToolCall(raw.call);
      if (!call) return null;
      return { type: 'tool_start', turnId, seq, call, blockId: asString(raw.blockId) };
    }
    case 'tool_progress':
      return {
        type: 'tool_progress',
        turnId,
        seq,
        blockId: asString(raw.blockId),
        callId: asString(raw.callId),
        message: asString(raw.message),
      };
    case 'tool_end': {
      const status = raw.status === 'error' ? 'error' : 'done';
      return {
        type: 'tool_end',
        turnId,
        seq,
        status,
        blockId: asString(raw.blockId),
        callId: asString(raw.callId),
        summary: asString(raw.summary),
        durationMs: asNumber(raw.durationMs),
        errorMessage: asString(raw.errorMessage),
      };
    }
    case 'answer_delta': {
      const text = asString(raw.text);
      if (!text) return null;
      return { type: 'answer_delta', turnId, seq, text, blockId: asString(raw.blockId) };
    }
    case 'answer_end':
      return { type: 'answer_end', turnId, seq, blockId: asString(raw.blockId) };
    case 'turn_end': {
      const outcome =
        raw.outcome === 'error' || raw.outcome === 'interrupted' ? raw.outcome : 'ok';
      return { type: 'turn_end', turnId, seq, outcome, errorMessage: asString(raw.errorMessage) };
    }
    case 'turn_error': {
      const message = asString(raw.message);
      if (!message) return null;
      return {
        type: 'turn_error',
        turnId,
        seq,
        message,
        retryable: raw.retryable === true,
      };
    }
    case 'seq_gap':
      return {
        type: 'seq_gap',
        turnId,
        seq,
        expected: asNumber(raw.expected) ?? 0,
        received: asNumber(raw.received) ?? 0,
      };
    default:
      return null;
  }
}
