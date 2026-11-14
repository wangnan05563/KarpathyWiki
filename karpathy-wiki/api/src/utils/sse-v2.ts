import type { AnswerChunk, ThinkingChunk } from '../types.js';

// SSE v2 单帧硬约束：data 行 JSON ≤ 8KB。留 600B 余量给 turnId/seq/blockId 等固定字段。
export const V2_MAX_FRAME_BYTES = 8192;
const TEXT_BUDGET_BYTES = 7600;
const SIDE_BATCH_REFS = 20;

export interface SseV2Frame {
  event: string;
  // turnId 是协议必填字段；seq 只属于 v2 业务事件（turn/think/tool/answer）。
  // refs/followups/image/ppt 等 side 事件沿用 legacy 事件名且不带 seq：
  // 它们由气泡外的卡片/列表消费，若占用 seq 会让只认 v2 事件的消费器误报空洞。
  data: Record<string, unknown> & { turnId: string; seq?: number };
}

export interface V2DonePayload {
  runId: string;
  threadId: string;
  sessionId: string;
  messageIndex: number;
  governor?: unknown;
  refs?: string[];
  webRefs?: unknown[];
  maxTokens?: number;
}

function splitTextByBytes(text: string, maxBytes: number): string[] {
  if (Buffer.byteLength(text, 'utf8') <= maxBytes) return [text];
  const parts: string[] = [];
  let current = '';
  let currentBytes = 0;
  // 按 code point 切，避免代理对/多字节字符被截断
  for (const char of Array.from(text)) {
    const charBytes = Buffer.byteLength(char, 'utf8');
    if (current && currentBytes + charBytes > maxBytes) {
      parts.push(current);
      current = '';
      currentBytes = 0;
    }
    current += char;
    currentBytes += charBytes;
  }
  if (current) parts.push(current);
  return parts;
}

function previewArgs(args?: Record<string, unknown>): string | undefined {
  if (!args) return undefined;
  try {
    const text = JSON.stringify(args);
    return text.length > 360 ? `${text.slice(0, 360)}…` : text;
  } catch {
    return undefined;
  }
}

// 把旧 AnswerChunk 流编码成 v2 气泡事件，同时保留完整帧日志供 afterSeq 回放。
// 为什么编码器独立于连接：断线时 run 仍在后台跑，事件必须继续入日志；重连只回放 seq > afterSeq。
export class SseV2Encoder {
  readonly turnId: string;
  readonly frames: SseV2Frame[] = [];
  private seq = 0;
  private started = false;
  private finished = false;
  private thinkSeq = 0;
  private answerSeq = 0;
  private toolSeq = 0;
  private openThink: { blockId: string; startedAt: number } | null = null;
  private openAnswer: string | null = null;
  private runningTool: { callId: string; startedAt: number } | null = null;

  constructor(turnId: string, private readonly onFrame: (frame: SseV2Frame) => void) {
    this.turnId = turnId;
  }

  start(): void {
    if (this.started) return;
    this.started = true;
    this.emitFrame('turn_start', { role: 'assistant' });
  }

  push(chunk: AnswerChunk): void {
    if (!this.started) this.start();
    if (this.finished) return;
    // 澄清是回合中断而非答案：先留存 clarify 供调用方渲染卡片，再收口为 interrupted
    if (chunk.clarify) {
      this.emitSide('clarify', chunk.clarify as unknown as Record<string, unknown>);
      this.finish('interrupted', undefined, { clarify: chunk.clarify });
      return;
    }
    if (chunk.thinking) this.pushThinking(chunk.thinking);
    if (chunk.progress) this.pushProgress(chunk.progress);
    if (chunk.refs) this.emitRefs(
      chunk.refs.map((r) => (typeof r === 'string' ? r : r.path)),
      chunk.webRefs ?? [],
    );
    if (chunk.followups) this.emitSide('followups', { followups: chunk.followups });
    if (chunk.image) this.emitSide('image', chunk.image as unknown as Record<string, unknown>);
    if (chunk.ppt) this.emitSide('ppt', chunk.ppt as unknown as Record<string, unknown>);
    if (chunk.multimodal) this.emitSide('multimodal', chunk.multimodal as unknown as Record<string, unknown>);
    if (chunk.text) this.pushAnswer(chunk.text);
  }

  done(payload: V2DonePayload): void {
    if (this.finished) return;
    // 引用可能超过 8KB，先按批发送 side 事件；turn_end 只带计数与元信息
    const refs = payload.refs ?? [];
    const webRefs = payload.webRefs ?? [];
    if (refs.length > 0 || webRefs.length > 0) this.emitRefs(refs, webRefs);
    // governor 统计可能很大；超过 2KB 就不塞进 turn_end，避免单帧超 8KB
    let governorForFrame: unknown = payload.governor;
    if (governorForFrame) {
      try {
        if (Buffer.byteLength(JSON.stringify(governorForFrame), 'utf8') > 2048) governorForFrame = undefined;
      } catch {
        governorForFrame = undefined;
      }
    }
    this.finish('ok', undefined, {
      runId: payload.runId,
      threadId: payload.threadId,
      sessionId: payload.sessionId,
      messageIndex: payload.messageIndex,
      governor: governorForFrame,
      governorOmitted: governorForFrame === undefined && payload.governor !== undefined && payload.governor !== null,
      maxTokens: payload.maxTokens,
      refsCount: refs.length,
      webRefsCount: webRefs.length,
    });
  }

  error(message: string, retryable = true): void {
    this.finish('error', message, { retryable });
  }

  stop(message = '已停止生成'): void {
    this.finish('interrupted', message);
  }

  after(afterSeq: number): SseV2Frame[] {
    return this.frames.filter((frame) => {
      const seq = frame.data.seq;
      // side 事件没有 seq，重连时整体重放；消费器按事件名忽略/幂等更新
      return seq === undefined || seq > afterSeq;
    });
  }

  private pushThinking(step: ThinkingChunk): void {
    if (step.phase === 'thinking') {
      this.closeTool('done');
      this.closeAnswer();
      if (!this.openThink) {
        this.openThink = {
          blockId: `${this.turnId}:think:${++this.thinkSeq}`,
          startedAt: Date.now(),
        };
      }
      for (const part of splitTextByBytes(step.message || '思考中…', TEXT_BUDGET_BYTES)) {
        this.emitFrame('think_delta', { blockId: this.openThink.blockId, text: part });
      }
      return;
    }
    if (step.phase === 'tool_call') {
      this.closeThink();
      this.closeAnswer();
      this.closeTool('done');
      this.toolSeq += 1;
      const callId = `${this.turnId}:tool:${this.toolSeq}`;
      this.runningTool = { callId, startedAt: Date.now() };
      this.emitFrame('tool_start', {
        call: {
          callId,
          name: step.tool || 'tool',
          title: step.message || step.tool || '工具调用',
          status: 'running',
          argsPreview: previewArgs(step.args),
        },
      });
      return;
    }
    // composing：模型开始写答案，收掉工具与思考，避免卡片一直转圈
    this.closeThink();
    this.closeTool('done');
    this.closeAnswer();
  }

  private pushProgress(progress: { step: string; count?: number }): void {
    this.closeThink();
    this.closeAnswer();
    if (!this.runningTool) {
      this.toolSeq += 1;
      const callId = `${this.turnId}:tool:${this.toolSeq}`;
      this.runningTool = { callId, startedAt: Date.now() };
      this.emitFrame('tool_start', {
        call: {
          callId,
          name: 'search_pages',
          title: progress.step || '检索知识库',
          status: 'running',
        },
      });
    }
    const message = progress.count === undefined ? progress.step : `${progress.step}（${progress.count}）`;
    this.emitFrame('tool_progress', { callId: this.runningTool.callId, message });
  }

  private pushAnswer(text: string): void {
    if (!text) return;
    this.closeThink();
    this.closeTool('done');
    if (!this.openAnswer) this.openAnswer = `${this.turnId}:answer:${++this.answerSeq}`;
    for (const part of splitTextByBytes(text, TEXT_BUDGET_BYTES)) {
      this.emitFrame('answer_delta', { blockId: this.openAnswer, text: part });
    }
  }

  private finish(outcome: 'ok' | 'error' | 'interrupted', errorMessage?: string, extra: Record<string, unknown> = {}): void {
    if (this.finished) return;
    this.finished = true;
    this.closeTool(outcome === 'error' ? 'error' : 'done', errorMessage);
    this.closeThink();
    this.closeAnswer();
    if (outcome === 'error') {
      this.emitFrame('turn_error', { message: errorMessage || '回答失败', retryable: true, ...extra });
      return;
    }
    this.emitFrame('turn_end', { outcome, errorMessage, ...extra });
  }

  private closeThink(): void {
    if (!this.openThink) return;
    this.emitFrame('think_end', {
      blockId: this.openThink.blockId,
      durationMs: Date.now() - this.openThink.startedAt,
    });
    this.openThink = null;
  }

  private closeTool(status: 'done' | 'error', errorMessage?: string): void {
    if (!this.runningTool) return;
    this.emitFrame('tool_end', {
      callId: this.runningTool.callId,
      status,
      durationMs: Date.now() - this.runningTool.startedAt,
      ...(errorMessage ? { errorMessage } : {}),
    });
    this.runningTool = null;
  }

  private closeAnswer(): void {
    if (!this.openAnswer) return;
    this.emitFrame('answer_end', { blockId: this.openAnswer });
    this.openAnswer = null;
  }

  private emitRefs(refs: string[], webRefs: unknown[]): void {
    // 每帧最多 20 条，避免 refs 数组把单帧撑过 8KB
    for (let i = 0; i < refs.length; i += SIDE_BATCH_REFS) {
      this.emitSide('refs', {
        refs: refs.slice(i, i + SIDE_BATCH_REFS),
        webRefs: i === 0 ? webRefs : [],
      });
    }
    if (refs.length === 0 && webRefs.length > 0) this.emitSide('refs', { refs: [], webRefs });
  }

  private emitSide(event: string, data: Record<string, unknown>): void {
    const frame: SseV2Frame = { event, data: { ...data, turnId: this.turnId } };
    this.frames.push(frame);
    try {
      this.onFrame(frame);
    } catch {
      // 单连接写失败不阻断其他订阅者
    }
  }

  private emitFrame(event: string, data: Record<string, unknown>): void {
    this.seq += 1;
    const frame: SseV2Frame = {
      event,
      data: { ...data, turnId: this.turnId, seq: this.seq },
    };
    this.frames.push(frame);
    try {
      this.onFrame(frame);
    } catch {
      // 单个订阅者写入失败不能打断编码，重连仍可从 frames 回放
    }
  }
}
