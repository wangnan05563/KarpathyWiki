// 流式气泡的 SSE 消费器：负责「读到字节 → 解析事件 → 状态机迁移 → 生命周期收口」。
//
// 为什么单独抽 composable：
//   1. 组件只该关心渲染，断流/超时/重连这类网络决策不应散落在模板里；
//   2. 泡泡的「done」必须由真正的流结束驱动，而不是靠 setTimeout 猜——
//      否则长回答会在还在输出时被误判完成（流光提前淡出）；
//   3. 可恢复流式（resume）与看门狗（watchdog）要复用同一份 baseline seq，
//      放在一起才能保证重连后不重复追加。
//
// 用法（消费方）：
//   const { turn, status, start, stop } = useBubbleStream({ resume: (turnId, seq) => fetch(...) })
//   void start(response, turnId)

import { computed, onBeforeUnmount, ref, type ComputedRef, type Ref } from 'vue';
import { parseSSEEvent } from '../utils/sse';
import {
  applyBubbleEvent,
  BubbleStreamState,
  createChatTurn,
  parseBubbleEvent,
  type BubbleStreamEvent,
  type ChatTurnVM,
} from '../types/chatBubble';

export type BubbleStatus = 'idle' | 'running' | 'done' | 'timeout' | 'error' | 'interrupted';

export interface BubbleStreamOptions {
  /** 滑动窗口空闲超时：连续 N ms 没读到任何字节即视为断流，默认 20s */
  idleTimeoutMs?: number;
  /** 整轮总超时（含重连），默认 180s，与后端 harness 上限对齐 */
  totalTimeoutMs?: number;
  /** 断线续传最大次数，默认 2；无 resume 时为 0 */
  maxResume?: number;
  /** 续传工厂：返回 null 表示服务端不支持续传，按中断收口 */
  resume?: (turnId: string, lastSeq: number) => Promise<Response | null>;
  /** 发现 seq 空洞时的提示回调（UI 可提示「内容可能有缺失」并触发重载） */
  onSeqGap?: (expected: number, received: number) => void;
}

export interface BubbleStreamHandle {
  turn: Ref<ChatTurnVM | null>;
  status: Ref<BubbleStatus>;
  streaming: ComputedRef<boolean>;
  start: (response: Response, turnId: string, role?: 'user' | 'assistant') => Promise<void>;
  stop: () => void;
}

const DEFAULT_IDLE_TIMEOUT = 20_000;
const DEFAULT_TOTAL_TIMEOUT = 180_000;
const RESUME_BACKOFF_MS = 320;

function errorText(err: unknown): string {
  if (err instanceof Error) return err.message;
  return String(err);
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export function useBubbleStream(options: BubbleStreamOptions = {}): BubbleStreamHandle {
  const turn = ref<ChatTurnVM | null>(null);
  const status = ref<BubbleStatus>('idle');
  const streaming = computed(() => status.value === 'running');

  const state = new BubbleStreamState();
  const idleTimeoutMs = options.idleTimeoutMs ?? DEFAULT_IDLE_TIMEOUT;
  const totalTimeoutMs = options.totalTimeoutMs ?? DEFAULT_TOTAL_TIMEOUT;
  const maxResume = options.resume ? options.maxResume ?? 2 : 0;

  // 读取当前状态：直接写 status.value 会被 TS 的赋值窄化保留成 'running'，
  // 而真实状态可能已被定时器/abort 改成 timeout/error，用函数取一次可拿到最新联合类型。
  const currentStatus = (): BubbleStatus => status.value;

  let controller: AbortController | null = null;
  let idleTimer: ReturnType<typeof setTimeout> | null = null;
  let totalTimer: ReturnType<typeof setTimeout> | null = null;
  let userAborted = false;
  let finished = false;

  function clearTimer(timer: ReturnType<typeof setTimeout> | null): null {
    if (timer) clearTimeout(timer);
    return null;
  }

  function clearAllTimers(): void {
    idleTimer = clearTimer(idleTimer);
    totalTimer = clearTimer(totalTimer);
  }

  /** 每读到一块字节就重置空闲窗口（心跳注释也算活动，避免把 keepalive 误判为断流） */
  function touchIdle(): void {
    idleTimer = clearTimer(idleTimer);
    idleTimer = setTimeout(() => {
      if (finished || status.value !== 'running') return;
      status.value = 'timeout';
      controller?.abort('idle-timeout');
    }, idleTimeoutMs);
  }

  /** 收口：只写一次终态事件，防止 done / error / stop 竞争造成重复快照 */
  function finalize(outcome: 'ok' | 'error' | 'interrupted', message?: string): void {
    if (finished || !turn.value) return;
    finished = true;
    // timeout 只是看门狗的内部触发态，对外统一为 interrupted（UI 只认 turn.outcome）
    if (status.value === 'timeout') status.value = 'interrupted';
    const seq = state.last + 1;
    turn.value = applyBubbleEvent(turn.value, {
      type: 'turn_end',
      turnId: turn.value.id,
      outcome,
      errorMessage: message,
      seq,
    });
    clearAllTimers();
  }

  function dispatchChunk(chunk: string): void {
    const parsed = parseSSEEvent(chunk);
    if (!parsed) return;
    let json: unknown;
    try {
      json = JSON.parse(parsed.data);
    } catch {
      // 非 JSON 心跳/注释：静默跳过，不能打断整条流
      return;
    }
    const event = parseBubbleEvent(parsed.eventType, json);
    if (!event) return;

    const verdict = state.accept(event.turnId, event.seq);
    if (verdict.status === 'duplicate') return;
    if (verdict.status === 'gap') {
      options.onSeqGap?.(verdict.expected, event.seq);
      // 仍然应用：内容优先，缺口由调用方决定是否 reload（不静默丢正文）
    }

    turn.value = applyBubbleEvent(turn.value!, event);

    if (event.type === 'turn_end') {
      finished = true;
      status.value = event.outcome === 'ok' ? 'done' : event.outcome === 'error' ? 'error' : 'interrupted';
      clearAllTimers();
    } else if (event.type === 'turn_error') {
      finished = true;
      status.value = 'error';
      clearAllTimers();
    }
  }

  /** 读一条响应体直到结束；取消/超时不抛异常，由 status 决定收口方式 */
  async function pump(response: Response, signal: AbortSignal): Promise<void> {
    if (!response.body) throw new Error('响应体为空，无法读取 SSE');
    const reader = response.body.getReader();
    const decoder = new TextDecoder();
    let buffer = '';
    try {
      // eslint-disable-next-line no-constant-condition
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        touchIdle();
        buffer += decoder.decode(value, { stream: true });
        const chunks = buffer.split('\n\n');
        buffer = chunks.pop() || '';
        for (const chunk of chunks) dispatchChunk(chunk);
      }
    } catch (err) {
      if ((err as Error)?.name === 'AbortError') return;
      throw err;
    } finally {
      if (signal.aborted) {
        try {
          await reader.cancel();
        } catch {
          /* 已释放 */
        }
      }
    }
  }

  async function start(
    response: Response,
    turnId: string,
    role: 'user' | 'assistant' = 'assistant',
  ): Promise<void> {
    // 新一轮必须先收掉旧轮（同一 composable 被复用时）
    stop();

    turn.value = createChatTurn(turnId, role);
    state.start(turnId);
    status.value = 'running';
    finished = false;
    userAborted = false;
    controller = new AbortController();
    const signal = controller.signal;

    touchIdle();
    totalTimer = setTimeout(() => {
      if (finished || status.value !== 'running') return;
      status.value = 'timeout';
      controller?.abort('total-timeout');
    }, totalTimeoutMs);

    let current: Response | null = response;
    let resumeCount = 0;

    try {
      while (current) {
        try {
          await pump(current, signal);
        } catch (err) {
          if (!userAborted) {
            status.value = 'error';
            finalize('error', `连接异常：${errorText(err)}`);
            return;
          }
        }

        if (finished || userAborted) break;
        // 流结束但没收到 turn_end：能续传就先续传，否则按断流收口
        if (currentStatus() === 'timeout') {
          finalize('interrupted', '响应超时，已保留已生成内容');
          break;
        }
        if (resumeCount >= maxResume || !options.resume) {
          finalize('interrupted', '连接中断，已保留已生成内容');
          break;
        }
        resumeCount += 1;
        await delay(RESUME_BACKOFF_MS * resumeCount);
        current = await options.resume(turnId, state.last);
        if (!current) {
          finalize('interrupted', '连接中断，已保留已生成内容');
          break;
        }
      }

      if (!finished && currentStatus() === 'running') {
        finalize('interrupted', '连接中断，已保留已生成内容');
      }
    } finally {
      clearAllTimers();
      controller = null;
    }
  }

  /** 用户主动停止：保留已生成内容，标记 interrupted（与「出错」区分，不弹错误态） */
  function stop(): void {
    if (finished) {
      // 已收口也要保证旧连接不占用
      controller?.abort('user-stop');
      controller = null;
      clearAllTimers();
      return;
    }
    userAborted = true;
    if (status.value === 'running') status.value = 'interrupted';
    controller?.abort('user-stop');
    finalize('interrupted', '已停止生成');
    clearAllTimers();
  }

  onBeforeUnmount(() => {
    userAborted = true;
    controller?.abort('unmount');
    clearAllTimers();
  });

  return { turn, status, streaming, start, stop };
}
