import type { AnswerChunk } from '../types.js';
import type { DonePayload } from './stream-run-manager.js';
import { SseV2Encoder, type SseV2Frame } from '../utils/sse-v2.js';

interface V2Client {
  send: (event: string, data: unknown) => boolean;
  end: () => void;
}

const RUN_TTL_MS = 5 * 60 * 1000;

// 一个 v2 run 的事件中枢：编码器持续把 chunk 写入帧日志，客户端只订阅「seq > afterSeq」。
// 与 StreamRunManager 的分工：manager 负责跑 producer / 持久化，本类负责协议编码与跨连接回放。
class V2Run {
  readonly runId: string;
  readonly encoder: SseV2Encoder;
  private clients = new Set<V2Client>();
  private ended = false;
  private evictTimer: ReturnType<typeof setTimeout> | null = null;

  constructor(runId: string) {
    this.runId = runId;
    this.encoder = new SseV2Encoder(runId, (frame) => this.broadcast(frame));
    this.encoder.start();
  }

  private broadcast(frame: SseV2Frame): void {
    for (const client of [...this.clients]) {
      try {
        client.send(frame.event, frame.data);
      } catch {
        // 单连接写失败不阻断其他连接
      }
    }
    if (frame.event === 'turn_end' || frame.event === 'turn_error') this.finish();
  }

  recordChunk(chunk: AnswerChunk): void {
    this.encoder.push(chunk);
  }

  recordDone(payload: DonePayload, maxTokens?: number): void {
    this.encoder.done({ ...payload, maxTokens });
  }

  recordError(message: string): void {
    this.encoder.error(message);
  }

  // manager 的订阅者 end()：正常 done/error 后 encoder 已收口；只有自然中断（如澄清后 return）
  // 会走到这里且没有终端事件，此时补 turn_end(interrupted)，否则客户端会一直等。
  recordEnd(): void {
    if (!this.ended) this.encoder.stop('连接已结束');
  }

  stop(message = '已停止生成'): void {
    this.encoder.stop(message);
  }

  attach(send: (event: string, data: unknown) => boolean, afterSeq: number, end: () => void): () => void {
    for (const frame of this.encoder.after(afterSeq)) {
      if (!send(frame.event, frame.data)) break;
    }
    if (this.ended) {
      end();
      return () => undefined;
    }
    const client: V2Client = { send, end };
    this.clients.add(client);
    return () => {
      this.clients.delete(client);
    };
  }

  isFinished(): boolean {
    return this.ended;
  }

  private finish(): void {
    if (this.ended) return;
    this.ended = true;
    const clients = [...this.clients];
    this.clients.clear();
    for (const client of clients) {
      try {
        client.end();
      } catch {
        // 连接已销毁
      }
    }
    if (this.evictTimer) clearTimeout(this.evictTimer);
    this.evictTimer = setTimeout(() => v2StreamRegistry.delete(this.runId), RUN_TTL_MS);
    this.evictTimer.unref?.();
  }
}

class V2StreamRegistry {
  private readonly runs = new Map<string, V2Run>();

  create(runId: string): V2Run {
    const existing = this.runs.get(runId);
    if (existing) return existing;
    const run = new V2Run(runId);
    this.runs.set(runId, run);
    return run;
  }

  get(runId: string): V2Run | undefined {
    return this.runs.get(runId);
  }

  has(runId: string): boolean {
    return this.runs.has(runId);
  }

  stop(runId: string, message?: string): boolean {
    const run = this.runs.get(runId);
    if (!run) return false;
    run.stop(message);
    return true;
  }

  delete(runId: string): void {
    this.runs.delete(runId);
  }

  // 测试专用：清空注册表，避免跨用例残留
  clear(): void {
    this.runs.clear();
  }
}

export const v2StreamRegistry = new V2StreamRegistry();
export { V2Run };
