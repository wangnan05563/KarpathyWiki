// T04550：编译作业管理器。
//
// 解决的问题：旧实现把一次编译绑死在单条 SSE 请求上。整页刷新（F5 / 关标签页）会销毁
// 前端 fetch，服务端只看到「客户端断连」，于是 routes/compile.ts 把断连当取消
// （isAborted() break）——在途编译真的被中断，批量编译更是没有任何续传通道。
//
// 设计对齐 batch-fix-job 的「运行与请求生命周期解耦」口径：
//   - 一次编译 = 一个 jobId 拥有的后台任务，任务只被显式取消端点终止，断连不影响；
//   - 事件带单调 seq 写入有界缓冲，`subscribe(jobId, sink, fromSeq)` 先回放再直播，
//     前端重挂载后按 seq 补齐丢失帧；
//   - 快照常驻内存（不落盘）：编译 run 的持久化状态在 compile-runs 里，这里只补
//     「这次作业是否还在跑」与事件重放，进程重启后自然失效（前端回落到历史列表）。
//
// 为什么不落盘：job 的生命周期与进程一致即可满足「刷新/关页后重连」；落盘需要处
// 理 vault 路径、权限与清理，超出本单范围，且 batch-fix 的落盘是因为它要跨重启续跑。

import { randomUUID } from 'node:crypto';

export type CompileJobKind = 'single' | 'batch' | 'retry' | 'resume';

// canceled 是显式取消（POST /cancel）后的终态；failed 是编译自身失败
export type CompileJobStatus = 'running' | 'done' | 'failed' | 'canceled';

export interface CompileJobSnapshot {
  jobId: string;
  kind: CompileJobKind;
  status: CompileJobStatus;
  startedAt: number;
  updatedAt: number;
  // 已发出的最后一个事件序号（前端据此从 seq+1 续订）
  lastSeq: number;
  message?: string;
}

export interface CompileJobEvent {
  seq: number;
  event: string;
  data: unknown;
}

// SSE 订阅者：onEvent 收到事件与序号；isAborted 表示这条连接已断开；
// end 用于在作业终态时收尾（正常结束流）。
export interface CompileJobSink {
  onEvent: (event: string, data: unknown, seq: number) => void;
  isAborted: () => boolean;
  end: () => void;
}

export interface CompileJobContext {
  emit: (event: string, data: unknown) => void;
  cancelled: () => boolean;
}

export type CompileJobResult = { status: 'done' | 'failed'; message?: string } | void;

export type CompileJobRunner = (ctx: CompileJobContext) => Promise<CompileJobResult>;

// 事件缓冲上限：单文件编译事件量在百级，批量 50 文件 × 每文件数十条仍在千级。
// 超限丢弃最旧事件——只影响「断开非常久之后」的重放完整性，前端仍可凭快照收敛终态。
const MAX_BUFFER_EVENTS = 2000;
// 终态作业保留时长：够用户刷新/次日重进查看结果，又不会无限占内存
const JOB_TTL_MS = 7 * 24 * 60 * 60 * 1000;
const MAX_JOBS = 200;

interface JobEntry {
  snapshot: CompileJobSnapshot;
  buffer: CompileJobEvent[];
  subscribers: Set<CompileJobSink>;
  cancelRequested: boolean;
}

export class CompileJobManager {
  private jobs = new Map<string, JobEntry>();

  // 启动作业并在后台执行。runner 内的 emit 与 cancelled 由本管理器注入。
  start(kind: CompileJobKind, runner: CompileJobRunner): CompileJobSnapshot {
    this.prune();
    const now = Date.now();
    const jobId = randomUUID();
    const entry: JobEntry = {
      snapshot: { jobId, kind, status: 'running', startedAt: now, updatedAt: now, lastSeq: 0 },
      buffer: [],
      subscribers: new Set(),
      cancelRequested: false,
    };
    this.jobs.set(jobId, entry);
    void this.run(entry, runner);
    return { ...entry.snapshot };
  }

  getSnapshot(jobId: string): CompileJobSnapshot | null {
    this.prune();
    const entry = this.jobs.get(jobId);
    return entry ? { ...entry.snapshot } : null;
  }

  // 订阅：先回放 seq >= fromSeq 的缓冲事件，再挂为直播。
  // 作业已终态时回放后立即 end，调用方无需再轮询。
  // 返回 false 表示 jobId 不存在/已过期（前端据此回落历史列表）。
  subscribe(jobId: string, sink: CompileJobSink, fromSeq = 0): boolean {
    const entry = this.jobs.get(jobId);
    if (!entry) return false;
    for (const item of entry.buffer) {
      if (item.seq < fromSeq) continue;
      if (sink.isAborted()) return true;
      sink.onEvent(item.event, item.data, item.seq);
    }
    if (entry.snapshot.status !== 'running') {
      sink.end();
      return true;
    }
    entry.subscribers.add(sink);
    return true;
  }

  // 只解除订阅，不触碰作业本身——断连不等于取消（本单的核心口径）
  unsubscribe(jobId: string, sink: CompileJobSink): void {
    this.jobs.get(jobId)?.subscribers.delete(sink);
  }

  // 显式取消：置标记后由 runner 在下一个检查点退出，终态落 canceled。
  // 已终态或不存在时返回当前快照/ null，重复取消幂等。
  cancel(jobId: string): CompileJobSnapshot | null {
    const entry = this.jobs.get(jobId);
    if (!entry) return null;
    if (entry.snapshot.status === 'running') entry.cancelRequested = true;
    return { ...entry.snapshot };
  }

  private async run(entry: JobEntry, runner: CompileJobRunner): Promise<void> {
    let status: 'done' | 'failed' = 'done';
    let message: string | undefined;
    try {
      const result = await runner({
        emit: (event, data) => this.emit(entry, event, data),
        cancelled: () => entry.cancelRequested,
      });
      if (result) {
        status = result.status;
        message = result.message;
      }
    } catch (err) {
      // runner 应自行把错误转成 error 事件；这里兜底避免静默丢终态
      status = 'failed';
      message = err instanceof Error ? err.message : String(err);
      this.emit(entry, 'error', { step: 'finalize', status: 'error', message });
    } finally {
      // 取消优先于失败：用户点取消后 runner 主动 break，不应被记成编译失败
      entry.snapshot.status = entry.cancelRequested && status !== 'done' ? 'canceled' : status;
      entry.snapshot.message = message;
      entry.snapshot.updatedAt = Date.now();
      this.finish(entry);
    }
  }

  private emit(entry: JobEntry, event: string, data: unknown): void {
    const seq = entry.snapshot.lastSeq + 1;
    entry.snapshot.lastSeq = seq;
    entry.snapshot.updatedAt = Date.now();
    entry.buffer.push({ seq, event, data });
    if (entry.buffer.length > MAX_BUFFER_EVENTS) {
      entry.buffer.splice(0, entry.buffer.length - MAX_BUFFER_EVENTS);
    }
    // 复制一份再遍历：onEvent 内部可能触发 unsubscribe（连接 close）
    for (const sink of [...entry.subscribers]) {
      if (sink.isAborted()) {
        entry.subscribers.delete(sink);
        continue;
      }
      sink.onEvent(event, data, seq);
    }
  }

  private finish(entry: JobEntry): void {
    for (const sink of [...entry.subscribers]) {
      if (!sink.isAborted()) sink.end();
    }
    entry.subscribers.clear();
  }

  // 懒清理：只在 start/get 时扫，避免定时器常驻 event loop
  private prune(): void {
    const now = Date.now();
    for (const [jobId, entry] of this.jobs) {
      const expired = now - entry.snapshot.updatedAt > JOB_TTL_MS;
      if (expired) this.jobs.delete(jobId);
    }
    if (this.jobs.size <= MAX_JOBS) return;
    // 超量时优先丢最旧的终态作业；运行中的作业永不驱逐
    const terminal = [...this.jobs.values()]
      .filter((e) => e.snapshot.status !== 'running')
      .sort((a, b) => a.snapshot.updatedAt - b.snapshot.updatedAt);
    for (const entry of terminal) {
      if (this.jobs.size <= MAX_JOBS) break;
      this.jobs.delete(entry.snapshot.jobId);
    }
  }
}
