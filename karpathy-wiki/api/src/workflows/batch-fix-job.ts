// T02466（PRD R-F2 / H2）体检批量修复作业管理器。
//
// 解决的问题：原实现把批量修复绑死在单次 SSE 请求上——关页/刷新即断，且断开后
// 后端只是「不再推送」，任务状态完全丢失：用户回来既看不到进度，也不知道哪些已修完，
// 只能整批重跑（重复调用 LLM、重复写 vault）。同时确认弹窗只有「可能耗时较长」一句话，
// 无法预判成本。
//
// 设计（沿用 stream-run-manager 的「运行与请求生命周期解耦」思路，不重写流式机制）：
//   - 一次批量修复 = 一个 jobId 拥有的后台作业，事件带单调序号写入环形缓冲并扇出给订阅者；
//   - 每个问题结束后把快照落盘（jobsDir/<jobId>.json），刷新页面/重启进程都能恢复；
//   - 暂停 = 当前问题跑完后停止并释放编译锁；继续 = 从 nextIndex 起把剩余问题重新入队；
//     取消 = 当前问题跑完后终止，已完成项保留（不做「回滚」承诺）；
//   - 真实耗时样本持久化在 jobsDir/stats.json，供启动前量化估算（明确标注为估算）。
//
// T02922 成功口径裁决：流程跑完 ≠ 问题消解。每项流程成功后再做一次定点复检
// （adapter.recheckIssueResolved，确定性、零 LLM），未消解判 ineffective 单独计数，
// 不进 doneKeys；耗时样本改为「跑了 LLM 流程的项都计入」（成功/未消解/失败都消耗真实时间，
// 否则无效项不计样本会让估算越跑越乐观）。
//
// T02924 估算口径裁决：llmCalls 表示「预计模型往返次数」= count × 每项实测 harness step 数，
// 不再按 1 项 = 1 次写死（T02605 实测 3 项 17 步）。每个终端事件带 harnessSteps/tokens，
// 统计落 stats.json；兜底默认值来自同一次真实实测（115s / 5.7 步 / 17.2k tokens 每项）。
// 样本 <5 标 measured-low（页面提示仅供参考），≥5 标 measured；估算同时给出 ±1σ 区间。
//
// vault 写入纪律不变：整批仍包在 withCompileLock 内串行，与 compile 互斥。

import fs from 'node:fs/promises';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { withCompileLock } from '../compile-queue.js';
import { friendlyLlmError, isRetryableLlmError } from '../utils/llm-error.js';
import type { EngineAdapter, FixInput, FixProgressEvent } from '../types.js';

// 作业状态。暂停请求不单独建状态：用 pauseRequested 标记，当前问题跑完落 paused。
export type BatchFixStatus = 'running' | 'paused' | 'canceled' | 'completed';

export interface BatchFixEvent {
  seq: number;
  event: string;
  data: unknown;
}

export interface BatchFixFailedItem {
  issueKey: string;
  message: string;
  // T04563：可重试性（缺省/旧快照按可重试降级）；认证失败/413/护栏拒绝为 false
  retryable?: boolean;
  // 失败类别：timeout / rate_limit / service_down / network / auth / request_too_large / budget / unknown
  category?: string;
}

// 单个待修复项：稳定 key（前端生成，如 orphan:foo.md）+ 修复入参
export interface BatchFixItem {
  issueKey: string;
  input: FixInput;
}

// 快照 = 落盘内容 = 对外可见的作业状态
export interface BatchFixSnapshot {
  jobId: string;
  status: BatchFixStatus;
  total: number;
  doneCount: number;
  // 已消解数：流程成功且定点复检确认问题消失（doneKeys 与之一一对应）
  successCount: number;
  failCount: number;
  // T02922：流程跑完但定点复检未确认消解的项（与失败区分——LLM 没报错，只是问题还在）
  ineffectiveCount: number;
  ineffective: BatchFixFailedItem[];
  // T04565(B)：修复前确定性预复检已判消项的计数（不烧 LLM、不计入 failCount）。
  skippedCount: number;
  skippedKeys: string[];
  currentIssueKey: string;
  pauseRequested: boolean;
  startedAt: number;
  updatedAt: number;
  elapsedMs: number;
  avgMsPerIssue: number;
  // T02924：每项平均模型往返次数（实测样本不足时取标定默认值），页面据此显示实测口径
  avgStepsPerIssue: number;
  doneKeys: string[];
  failed: BatchFixFailedItem[];
  items: BatchFixItem[];
  // 下一个待处理下标：恢复运行时从该位置继续（之前的项已修完或已判失败）
  nextIndex: number;
}

// 订阅端（由路由用 createSSESender 适配）
export interface BatchFixSink {
  onEvent(event: string, data: unknown, seq: number): void;
  isAborted(): boolean;
  end(): void;
}

export interface EstimateResult {
  count: number;
  // T02924：预计模型往返次数 = count × 每项实测/默认 harness step 数（不是 1 项 1 次）
  llmCalls: number;
  avgStepsPerIssue: number;
  avgMsPerIssue: number;
  avgTokensPerIssue: number;
  // 预计 token 消耗 = count × 每项实测/默认 token 数
  tokens: number;
  samples: number;
  estimatedMs: number;
  estimatedMinMs: number;
  estimatedMaxMs: number;
  estimatedMinutes: number;
  // default = 无样本（用实测标定的兜底值）；measured-low = 1~4 个样本（仅供参考）；measured = ≥5
  basis: 'default' | 'measured-low' | 'measured';
}

interface DurationStats {
  samples: number;
  totalMs: number;
  avgMs: number;
  // 方差与极值：估算误差区间用（样本 ≥2 取 ±1σ）
  sumSqMs: number;
  minMs: number;
  maxMs: number;
  // 模型往返/token 只在终端事件带 usage 时累计，分母是带该字段的样本数（不是总样本数）
  stepSamples: number;
  totalSteps: number;
  avgSteps: number;
  tokenSamples: number;
  totalTokens: number;
  avgTokens: number;
}

interface JobEntry {
  snapshot: BatchFixSnapshot;
  buffer: BatchFixEvent[];
  seq: number;
  subscribers: Set<BatchFixSink>;
  stopRequested: boolean;
  stopKind: 'pause' | 'cancel';
  // T04563：当前项（或重试退避）的中止句柄；pause/cancel 直接 abort，无需等整项跑完
  activeAbort: AbortController | null;
}

// 环形缓冲上限：597 项 × 多步事件量很大，只保留尾部用于断线重连回放；
// 完整状态以快照（doneKeys/failed/nextIndex）为准，不依赖缓冲。
const MAX_BUFFER_EVENTS = 400;
// 快照文件保留期：超过即回收，避免 .harness 目录无限增长
const SNAPSHOT_TTL_MS = 7 * 24 * 60 * 60 * 1000;
// T02924：兜底默认值来自 T02605 真实 LLM 实测（3 项：均值 115,350ms/项、17 个 harness step、
// 51,602 tokens），取整后写入常量。旧值 45s / 1 次调用分别低估 2.6 倍 / 5.7 倍。
const FALLBACK_AVG_MS = 115_000;
const FALLBACK_STEPS_PER_ISSUE = 5.7;
const FALLBACK_TOKENS_PER_ISSUE = 17_200;
// 样本量阈值：<5 视为「样本不足，仅供参考」；≥5 判 measured
const MEASURED_SAMPLE_THRESHOLD = 5;
// 单样本无法量方差，用 ±50% 显式表达不确定性（明示规则，不是统计结论）
const SINGLE_SAMPLE_SPREAD = 0.5;

// T04563：项级容错默认值。config.ts 的 defaultConfig 写入同值（可配置口径在配置层）；
// 这里保留一份，供直接构造管理器的测试/调用方在缺省时降级。
// itemTimeoutMs 必须大于 harness 单次最坏耗时（Layer A：60s × 3 次重试 ≈ 186s），
// 取 300s 以免把「还在正常跑的项」误判超时。
export const DEFAULT_BATCH_FIX_OPTIONS: Required<Omit<BatchFixJobOptions, 'logger'>> = {
  maxRetries: 2,
  baseDelayMs: 1000,
  maxDelayMs: 30_000,
  itemTimeoutMs: 300_000,
};

export interface BatchFixJobOptions {
  /** 单项失败后的自动重试次数（不含首次尝试） */
  maxRetries?: number;
  /** 指数退避基数（毫秒），实际等待 = 基数 × 2^(n-1)，再叠加 50%~100% jitter */
  baseDelayMs?: number;
  /** 退避上限（毫秒） */
  maxDelayMs?: number;
  /** 单项（单次尝试）超时预算（毫秒） */
  itemTimeoutMs?: number;
  /** T04562：服务端日志口（失败项保留原始错误与 cause.code，供排障） */
  logger?: { warn(payload: Record<string, unknown>, message: string): void };
}

function sleep(ms: number, signal?: AbortSignal): Promise<void> {
  if (ms <= 0) return Promise.resolve();
  return new Promise((resolve) => {
    if (signal?.aborted) {
      resolve();
      return;
    }
    const done = () => {
      clearTimeout(timer);
      signal?.removeEventListener('abort', done);
      resolve();
    };
    const timer = setTimeout(done, ms);
    signal?.addEventListener('abort', done, { once: true });
  });
}

function backoffDelay(attempt: number, opts: Required<Omit<BatchFixJobOptions, 'logger'>>): number {
  const ceiling = Math.min(opts.maxDelayMs, opts.baseDelayMs * 2 ** (attempt - 1));
  // 半固定 + 半随机：避免多项连续失败时同拍重试再次撞上限流窗口
  return Math.round(ceiling / 2 + Math.random() * (ceiling / 2));
}

function classifyFixFailure(outcome: FixOutcome): { retryable: boolean; category?: string } {
  // 工作流显式声明（如 budget）优先，避免文案变化影响分类
  if (outcome.retryable !== undefined) return { retryable: outcome.retryable, category: outcome.category };
  const raw = outcome.error ?? outcome.errorMessage;
  if (!raw) return { retryable: false, category: outcome.category };
  return {
    retryable: isRetryableLlmError(raw),
    category: outcome.category ?? friendlyLlmError(raw).category,
  };
}

function emptyStats(): DurationStats {
  return {
    samples: 0,
    totalMs: 0,
    avgMs: FALLBACK_AVG_MS,
    sumSqMs: 0,
    minMs: 0,
    maxMs: 0,
    stepSamples: 0,
    totalSteps: 0,
    avgSteps: FALLBACK_STEPS_PER_ISSUE,
    tokenSamples: 0,
    totalTokens: 0,
    avgTokens: FALLBACK_TOKENS_PER_ISSUE,
  };
}

function isTerminal(status: BatchFixStatus): boolean {
  return status === 'canceled' || status === 'completed';
}

function estimateBasis(samples: number): EstimateResult['basis'] {
  if (samples === 0) return 'default';
  if (samples < MEASURED_SAMPLE_THRESHOLD) return 'measured-low';
  return 'measured';
}

/** 单项修复的流式终态（跨事件累积，事件处理与收尾判定共用）。 */
interface FixOutcome {
  succeeded: boolean;
  errorMessage: string;
  doneMessage: string;
  gotDoneEvent: boolean;
  harnessSteps: number;
  tokens: number;
  // T04563：原始异常（分类用）与工作流显式给出的可重试性/类别
  error?: unknown;
  retryable?: boolean;
  category?: string;
}

export class BatchFixJobManager {
  private readonly jobsDir: string;
  private readonly statsFile: string;
  private readonly adapter: EngineAdapter;
  private readonly options: Required<Omit<BatchFixJobOptions, 'logger'>>;
  private readonly logger?: BatchFixJobOptions['logger'];
  private readonly jobs = new Map<string, JobEntry>();
  // 串行落盘：同一 job 的并发写入互相覆盖，排队保证后写生效
  private writeChain: Promise<void> = Promise.resolve();
  // T02888：进程启动时的过期快照回收。懒启动（构造函数不发起异步操作），
  // 由路由注册时调用 startStartupPrune() 或测试首次访问 startupPrune 触发。
  private prunePromise: Promise<void> | null = null;

  get startupPrune(): Promise<void> {
    this.prunePromise ??= this.pruneOldSnapshots().catch(() => undefined);
    return this.prunePromise;
  }

  /** 启动期回收入口：保持「进程启动即回收」语义，不把异步动作放进构造函数。 */
  startStartupPrune(): void {
    this.startupPrune.catch(() => undefined);
  }

  constructor(jobsDir: string, adapter: EngineAdapter, options: BatchFixJobOptions = {}) {
    this.jobsDir = jobsDir;
    this.statsFile = path.join(jobsDir, 'stats.json');
    this.adapter = adapter;
    this.logger = options.logger;
    this.options = {
      maxRetries: Math.max(0, options.maxRetries ?? DEFAULT_BATCH_FIX_OPTIONS.maxRetries),
      baseDelayMs: Math.max(0, options.baseDelayMs ?? DEFAULT_BATCH_FIX_OPTIONS.baseDelayMs),
      maxDelayMs: Math.max(0, options.maxDelayMs ?? DEFAULT_BATCH_FIX_OPTIONS.maxDelayMs),
      itemTimeoutMs: Math.max(1, options.itemTimeoutMs ?? DEFAULT_BATCH_FIX_OPTIONS.itemTimeoutMs),
    };
    // T02888：快照回收原来只在下一次批量修复起跑时发生——用过一次就不再用的用户，
    // 终态快照会一直留在盘上，而清理页四类目标都不扫 batch-fix（看不到也删不掉）。
    // 快照是「断点续传/恢复」语义（与 run-state 同族），不并入清理删除面，
    // 改由管理器自己在启动时按同一 TTL 回收，不依赖用户再次使用该功能。
  }

  /** 启动一次批量修复：立即返回快照，实际执行在后台排队（withCompileLock 与 compile 互斥）。 */
  async start(items: BatchFixItem[]): Promise<BatchFixSnapshot> {
    const now = Date.now();
    const stats = await this.readStats();
    const snapshot: BatchFixSnapshot = {
      jobId: randomUUID(),
      status: 'running',
      total: items.length,
      doneCount: 0,
      successCount: 0,
      failCount: 0,
      ineffectiveCount: 0,
      ineffective: [],
      skippedCount: 0,
      skippedKeys: [],
      currentIssueKey: '',
      pauseRequested: false,
      startedAt: now,
      updatedAt: now,
      elapsedMs: 0,
      avgMsPerIssue: stats.avgMs,
      avgStepsPerIssue: Math.round(stats.avgSteps * 10) / 10,
      doneKeys: [],
      failed: [],
      items,
      nextIndex: 0,
    };
    const entry: JobEntry = {
      snapshot,
      buffer: [],
      seq: 0,
      subscribers: new Set(),
      stopRequested: false,
      stopKind: 'pause',
      activeAbort: null,
    };
    this.jobs.set(snapshot.jobId, entry);
    await this.pruneOldSnapshots();
    this.emit(entry, 'batch_start', { jobId: snapshot.jobId, totalIssues: snapshot.total });
    await this.persist(entry);
    void this.runLoop(entry).catch(() => undefined);
    return snapshot;
  }

  /**
   * 继续一个 paused/canceled 作业：从 nextIndex 起把剩余问题重新入队。
   * canceled 也允许继续——取消后反悔是常见路径，且已完成项本就不受影响。
   */
  async resume(jobId: string): Promise<BatchFixSnapshot | null> {
    const entry = await this.ensureLoaded(jobId);
    if (!entry) return null;
    const snap = entry.snapshot;
    if (snap.status === 'running' || snap.nextIndex >= snap.total) {
      if (snap.nextIndex >= snap.total && snap.status !== 'completed') snap.status = 'completed';
      await this.persist(entry);
      return snap;
    }
    snap.status = 'running';
    snap.pauseRequested = false;
    snap.startedAt = Date.now() - snap.elapsedMs;
    entry.stopRequested = false;
    this.emit(entry, 'batch_resume', {
      jobId,
      resumeFrom: snap.nextIndex,
      remaining: snap.total - snap.nextIndex,
    });
    await this.persist(entry);
    void this.runLoop(entry).catch(() => undefined);
    return snap;
  }

  /**
   * 暂停：若有进行中的项，abort 其 signal 立即中断（LLM 调用随之中止），该项不计完成、
   * 保持 nextIndex 不变，继续时从该项重跑；无进行中项时在下一轮迭代开头停下。
   */
  async pause(jobId: string): Promise<BatchFixSnapshot | null> {
    return this.requestStop(jobId, 'pause');
  }

  /** 取消：语义同暂停（中断当前项），但落 canceled 态；已完成项保留。 */
  async cancel(jobId: string): Promise<BatchFixSnapshot | null> {
    return this.requestStop(jobId, 'cancel');
  }

  /** 内存中的作业快照（不读盘）。 */
  get(jobId: string): BatchFixSnapshot | null {
    return this.jobs.get(jobId)?.snapshot ?? null;
  }

  /** 取快照：内存优先，回落磁盘（进程重启后仍可查）。 */
  async getSnapshot(jobId: string): Promise<BatchFixSnapshot | null> {
    const entry = await this.ensureLoaded(jobId);
    return entry?.snapshot ?? null;
  }

  /** 最近一次作业（供页面刷新/重进时恢复进度面板）。 */
  async latest(): Promise<BatchFixSnapshot | null> {
    const inMemory = [...this.jobs.values()].sort(
      (a, b) => b.snapshot.updatedAt - a.snapshot.updatedAt,
    )[0];
    if (inMemory) return inMemory.snapshot;
    const files = await this.listSnapshotFiles();
    const newest = files[0];
    if (!newest) return null;
    const loaded = await this.ensureLoaded(newest.jobId);
    return loaded?.snapshot ?? null;
  }

  /**
   * 启动前量化估算（估算非承诺）：问题数 / 模型往返次数 / token / 耗时区间。
   * 口径见文件头 T02924：llmCalls = count × 每项实测 step 数；无样本时用实测标定的兜底值。
   */
  async estimate(count: number): Promise<EstimateResult> {
    const stats = await this.readStats();
    const mean = stats.avgMs;
    // 误差区间：样本 ≥2 且有二阶矩时用总体标准差 ±1σ；单样本与旧格式样本（无 sumSqMs）
    // 无法量方差，用固定 ±50% 明示不确定性，而不是报一个宽度为 0 的假精确区间
    const sigma =
      stats.samples >= 2 && stats.sumSqMs > 0
        ? Math.sqrt(Math.max(0, stats.sumSqMs / stats.samples - mean * mean))
        : mean * SINGLE_SAMPLE_SPREAD;
    const estimatedMs = Math.round(mean * count);
    const basis: EstimateResult['basis'] = estimateBasis(stats.samples);
    return {
      count,
      llmCalls: Math.max(count, Math.round(count * stats.avgSteps)),
      avgStepsPerIssue: Math.round(stats.avgSteps * 10) / 10,
      avgMsPerIssue: mean,
      avgTokensPerIssue: Math.round(stats.avgTokens),
      tokens: Math.round(stats.avgTokens * count),
      samples: stats.samples,
      estimatedMs,
      estimatedMinMs: Math.max(0, Math.round((mean - sigma) * count)),
      estimatedMaxMs: Math.round((mean + sigma) * count),
      estimatedMinutes: Math.max(1, Math.round(estimatedMs / 60000)),
      basis,
    };
  }

  /**
   * 记录一次真实耗时（单个修复与批量修复共用），供下一次估算使用。
   * T02924：同时累计 harness step 数与 token；带 usage 的样本单独计分母，
   * 避免旧调用（只有耗时）把平均 step 数拉低。
   * 口径（T02922 裁决）：只要 LLM 流程跑过就记样本，成功/未消解/失败一视同仁——
   * 失败项同样消耗真实时间与调用，排除它们会让估算越跑越乐观。
   */
  async recordDuration(ms: number, usage: { steps?: number; tokens?: number } = {}): Promise<void> {
    if (!Number.isFinite(ms) || ms <= 0) return;
    const steps = Number.isFinite(usage.steps) && (usage.steps as number) > 0 ? Math.round(usage.steps as number) : 0;
    const tokens =
      Number.isFinite(usage.tokens) && (usage.tokens as number) > 0 ? Math.round(usage.tokens as number) : 0;
    // 与快照共用落盘队列：stats.json 是「读-改-写」，并发写会互相吞样本；
    // 原子 rename 另保证 readStats 不会读到半截 JSON（读到即样本清零，ETA 会莫名退回兜底值）。
    this.writeChain = this.writeChain.then(async () => {
      try {
        const stats = await this.readStats();
        const samples = stats.samples + 1;
        const totalMs = stats.totalMs + ms;
        const stepSamples = stats.stepSamples + (steps > 0 ? 1 : 0);
        const tokenSamples = stats.tokenSamples + (tokens > 0 ? 1 : 0);
        const next: DurationStats = {
          samples,
          totalMs,
          avgMs: Math.round(totalMs / samples),
          sumSqMs: stats.sumSqMs + ms * ms,
          minMs: samples === 1 ? ms : Math.min(stats.minMs || ms, ms),
          maxMs: samples === 1 ? ms : Math.max(stats.maxMs || ms, ms),
          stepSamples,
          totalSteps: stats.totalSteps + steps,
          avgSteps: stepSamples > 0 ? (stats.totalSteps + steps) / stepSamples : FALLBACK_STEPS_PER_ISSUE,
          tokenSamples,
          totalTokens: stats.totalTokens + tokens,
          avgTokens: tokenSamples > 0 ? (stats.totalTokens + tokens) / tokenSamples : FALLBACK_TOKENS_PER_ISSUE,
        };
        await this.writeAtomic(this.statsFile, JSON.stringify(next));
      } catch {
        // 统计写失败不影响业务，仅失去更准的估算
      }
    });
    await this.writeChain;
  }

  /**
   * 订阅作业事件：先回放缓冲中 seq >= fromSeq 的事件，再挂为直播。
   * 作业已终态则回放后立即 end()，runLoop 结束时也会主动关闭订阅者。
   */
  subscribe(jobId: string, sink: BatchFixSink, fromSeq = 0): void {
    const entry = this.jobs.get(jobId);
    if (!entry) {
      sink.end();
      return;
    }
    for (const item of entry.buffer) {
      if (item.seq < fromSeq) continue;
      try {
        sink.onEvent(item.event, item.data, item.seq);
      } catch {
        return;
      }
    }
    if (isTerminal(entry.snapshot.status)) {
      sink.end();
      return;
    }
    entry.subscribers.add(sink);
  }

  /** 断开连接只退订，作业继续在后台跑（这正是「关页不静默中断」的语义）。 */
  unsubscribe(jobId: string, sink: BatchFixSink): void {
    this.jobs.get(jobId)?.subscribers.delete(sink);
  }

  private async requestStop(jobId: string, kind: 'pause' | 'cancel'): Promise<BatchFixSnapshot | null> {
    const entry = await this.ensureLoaded(jobId);
    if (!entry) return null;
    if (entry.snapshot.status !== 'running') return entry.snapshot;
    entry.stopRequested = true;
    entry.stopKind = kind;
    entry.snapshot.pauseRequested = true;
    // T04563：立即中断进行中的 LLM 调用/退避等待；fixOne 会把它当「未结算」处理，
    // nextIndex 不前移，继续时该项重跑。
    entry.activeAbort?.abort();
    this.emit(entry, 'batch_stop_requested', { jobId, kind });
    await this.persist(entry);
    return entry.snapshot;
  }

  private async runLoop(entry: JobEntry): Promise<void> {
    const snap = entry.snapshot;
    await withCompileLock(async () => {
      for (let i = snap.nextIndex; i < snap.items.length; i++) {
        if (entry.stopRequested) break;
        const item = snap.items[i];
        snap.currentIssueKey = item.issueKey;
        this.emit(entry, 'issue_start', {
          issueKey: item.issueKey,
          issueIndex: i,
          totalIssues: snap.total,
        });
        const settled = await this.fixOne(entry, item, i);
        // T04563：被暂停/取消中断的中途项不算完成，nextIndex 不前移，继续时从该项重跑
        if (settled) {
          snap.nextIndex = i + 1;
          snap.doneCount = snap.nextIndex;
        }
        snap.elapsedMs = Date.now() - snap.startedAt;
        snap.currentIssueKey = '';
        await this.persist(entry);
        if (!settled || entry.stopRequested) break;
      }
    });
    this.finalize(entry);
    await this.persist(entry);
    this.closeSubscribers(entry);
  }

  // 收尾：按请求落 paused / canceled / completed 终态并广播对应事件
  private finalize(entry: JobEntry): void {
    const snap = entry.snapshot;
    snap.currentIssueKey = '';
    snap.pauseRequested = false;
    snap.elapsedMs = Date.now() - snap.startedAt;
    if (entry.stopRequested) {
      snap.status = entry.stopKind === 'cancel' ? 'canceled' : 'paused';
      const verb = snap.status === 'canceled' ? '已取消' : '已暂停';
      this.emit(entry, 'batch_stopped', {
        jobId: snap.jobId,
        status: snap.status,
        nextIndex: snap.nextIndex,
        remaining: snap.total - snap.nextIndex,
        message: `${verb}：已处理 ${snap.doneCount}/${snap.total}，已完成项保留`,
      });
      return;
    }
    snap.status = snap.nextIndex >= snap.total ? 'completed' : snap.status;
    if (snap.status === 'completed') {
      // T02922：文案区分「已处理」与「已消解」——进度条 100% 只代表处理完，
      // 消解数才回答「问题还在不在」
      this.emit(entry, 'batch_done', {
        jobId: snap.jobId,
        step: 'done',
        status: 'done',
        totalIssues: snap.total,
        successCount: snap.successCount,
        failCount: snap.failCount,
        ineffectiveCount: snap.ineffectiveCount,
        message: `批量修复完成：已处理 ${snap.doneCount}/${snap.total}，消解 ${snap.successCount}，未消解 ${snap.ineffectiveCount}，失败 ${snap.failCount}`,
      });
    }
  }

  // 修复单个问题：把 adapter.healthCheckFix 的事件包装为带定位信息的批量事件。
  // T02922：流程成功的终态事件延后到定点复检之后——先裁定「消解/未消解」，
  // 再发 issue_done / issue_ineffective，保证「全部打绿」只代表问题真的消解了。
  // T04563：项级自动重试（仅可重试错误）+ 项级超时 + 暂停/取消中断。
  // 返回值 = 该项是否已结算：成功/最终失败都算结算（nextIndex 前移）；
  // 被暂停/取消中断且未跑完的中途项返回 false，保持 nextIndex 不变，继续时重跑。
  private async fixOne(entry: JobEntry, item: BatchFixItem, issueIndex: number): Promise<boolean> {
    const snap = entry.snapshot;
    const opts = this.options;
    const maxAttempts = Math.max(1, opts.maxRetries + 1);
    // T04565(B)：修复前确定性预复检——已被外部（Obsidian 手改 / 另一轮编译 / 上一轮修复）消解的问题，
    // 在烧 LLM 之前剔掉，省一轮模型往返。复用 adapter.recheckIssueResolved（与 doHealthCheck、finishSuccessfulFix 同口径）。
    // 跳过项不计 failCount、不调用 harness.run，推独立事件 issue_skipped；返回 true 使其结算（nextIndex 前移，resume 不重跑）。
    let preResolved = false;
    let preNote = '';
    try {
      preResolved = (await this.adapter.recheckIssueResolved?.(item.input)) ?? false;
    } catch (err: unknown) {
      // 预复检自身异常：保守放行进入真实修复，不让复检故障阻断整条作业
      preResolved = false;
      preNote = `预复检失败，放行修复: ${err instanceof Error ? err.message : String(err)}`;
    }
    if (preResolved) {
      snap.skippedCount = (snap.skippedCount ?? 0) + 1;
      (snap.skippedKeys ??= []).push(item.issueKey);
      this.emit(entry, 'issue_skipped', {
        step: 'done',
        status: 'skipped',
        issueIndex,
        totalIssues: snap.total,
        issueKey: item.issueKey,
        issueDone: true,
        message: preNote || '问题已被外部消解，跳过修复（不消耗 LLM）',
      });
      await this.persist(entry);
      return true;
    }
    let outcome: FixOutcome | null = null;
    let firstAttemptMs = 0;
    let totalMs = 0;
    let retryable = false;
    let category: string | undefined;

    for (let attempt = 1; attempt <= maxAttempts; attempt++) {
      const controller = new AbortController();
      entry.activeAbort = controller;
      let timedOut = false;
      const timer = setTimeout(() => {
        timedOut = true;
        controller.abort();
      }, opts.itemTimeoutMs);
      const attemptStartedAt = Date.now();
      try {
        outcome = await this.runFixStream(entry, item, issueIndex, {
          ...item.input,
          signal: controller.signal,
        });
      } finally {
        clearTimeout(timer);
        if (entry.activeAbort === controller) entry.activeAbort = null;
      }
      const attemptMs = Math.max(1, Date.now() - attemptStartedAt);
      totalMs += attemptMs;
      if (attempt === 1) firstAttemptMs = attemptMs;
      if (timedOut) {
        outcome.errorMessage = `修复超时：超过项级时限 ${opts.itemTimeoutMs}ms`;
        outcome.category = 'timeout';
        outcome.retryable = true;
      } else if (!outcome.gotDoneEvent) {
        outcome.errorMessage = '修复流提前结束（未收到完成事件）';
      }
      if (outcome.succeeded) break;
      // 用户暂停/取消：不计失败、不推进 nextIndex（若这次已跑完成功，上方 break 后按结算处理）
      if (entry.stopRequested) return false;
      ({ retryable, category } = classifyFixFailure(outcome));
      if (retryable && attempt < maxAttempts) {
        const delay = backoffDelay(attempt, opts);
        this.emit(entry, 'progress', {
          step: 'retry',
          status: 'running',
          message: `第 ${attempt} 次自动重试（${category ?? '瞬时错误'}）：${outcome.errorMessage}`,
          retryable: true,
          category,
          issueIndex,
          totalIssues: snap.total,
          issueKey: item.issueKey,
        });
        await this.waitBackoff(entry, delay);
        if (entry.stopRequested) return false;
        continue;
      }
      break;
    }

    if (!outcome) return false;
    if (outcome.succeeded) {
      await this.finishSuccessfulFix(entry, item, issueIndex, outcome);
      // 成功项记完整耗时（含重试的真实 LLM 成本）
      await this.recordDuration(totalMs, { steps: outcome.harnessSteps, tokens: outcome.tokens });
    } else {
      snap.failCount++;
      snap.failed.push({ issueKey: item.issueKey, message: outcome.errorMessage, retryable, category });
      this.emit(entry, 'issue_error', {
        step: 'done',
        status: 'error',
        message: outcome.errorMessage,
        retryable,
        category,
        data: { harnessSteps: outcome.harnessSteps, tokens: outcome.tokens },
        issueIndex,
        totalIssues: snap.total,
        issueKey: item.issueKey,
        issueDone: true,
      });
      // 失败项只记首次尝试耗时：T02922 要求失败也计样本（否则估算越跑越乐观），
      // 但重试/退避的额外耗时不能把单次成本抬高（T04563）。
      await this.recordDuration(firstAttemptMs, { steps: outcome.harnessSteps, tokens: outcome.tokens });
    }
    const stats = await this.readStats();
    snap.avgMsPerIssue = stats.avgMs;
    snap.avgStepsPerIssue = Math.round(stats.avgSteps * 10) / 10;
    return true;
  }

  // 重试退避：期间把 controller 暴露给 requestStop，暂停/取消可立即打断等待
  private async waitBackoff(entry: JobEntry, ms: number): Promise<void> {
    const controller = new AbortController();
    entry.activeAbort = controller;
    try {
      await sleep(ms, controller.signal);
    } finally {
      if (entry.activeAbort === controller) entry.activeAbort = null;
    }
  }

  // 消费修复流：逐事件转发；抛出异常时补一条终态错误事件，保证订阅端总能收到结束信号。
  // T04563：终态错误先不广播——是否重试由 fixOne 按可重试性裁定，避免中间尝试被计成失败项。
  private async runFixStream(
    entry: JobEntry,
    item: BatchFixItem,
    issueIndex: number,
    input: FixInput,
  ): Promise<FixOutcome> {
    // T02924：终端事件带出的实测往返步数/token（缺省 0 → 不计入 step/token 均值）
    const outcome: FixOutcome = {
      succeeded: false,
      errorMessage: '',
      doneMessage: '',
      gotDoneEvent: false,
      harnessSteps: 0,
      tokens: 0,
    };
    try {
      for await (const ev of this.adapter.healthCheckFix(input)) {
        this.emitFixEvent(entry, ev, item, issueIndex, outcome);
      }
    } catch (err: unknown) {
      outcome.succeeded = false;
      outcome.gotDoneEvent = true;
      outcome.error = err;
      outcome.errorMessage = err instanceof Error ? err.message : String(err);
      // T04562：友好文案只给用户看「网络不可达」；真因（cause.code）留在服务端日志里排障。
      const cause = err instanceof Error ? (err as { cause?: unknown }).cause : undefined;
      const causeNode = typeof cause === 'object' && cause !== null ? (cause as { code?: unknown; message?: unknown }) : null;
      this.logger?.warn(
        {
          issueKey: item.issueKey,
          errorName: err instanceof Error ? err.name : typeof err,
          errorMessage: outcome.errorMessage.slice(0, 500),
          causeCode: typeof causeNode?.code === 'string' ? causeNode.code : undefined,
          causeMessage: typeof causeNode?.message === 'string' ? causeNode.message.slice(0, 500) : undefined,
        },
        '批量修复项失败：LLM 调用异常',
      );
    }
    return outcome;
  }

  // 单事件分发：done 是终态（成功/失败），fixed/progress 直接转发。
  private emitFixEvent(
    entry: JobEntry,
    ev: FixProgressEvent,
    item: BatchFixItem,
    issueIndex: number,
    outcome: FixOutcome,
  ): void {
    if (ev.data?.harnessSteps !== undefined) outcome.harnessSteps = ev.data.harnessSteps;
    if (ev.data?.tokens !== undefined) outcome.tokens = ev.data.tokens;
    const wrapped = {
      ...ev,
      issueIndex,
      totalIssues: entry.snapshot.total,
      issueKey: item.issueKey,
      issueDone: ev.step === 'done',
    };
    if (ev.step !== 'done') {
      this.emit(entry, ev.step === 'fixed' ? 'fixed' : 'progress', wrapped);
      return;
    }
    outcome.gotDoneEvent = true;
    outcome.succeeded = ev.status === 'done';
    if (outcome.succeeded) {
      outcome.doneMessage = ev.message;
      return;
    }
    outcome.errorMessage = ev.message || '修复失败';
    if (ev.data?.category !== undefined) outcome.category = ev.data.category;
    if (ev.data?.retryable !== undefined) outcome.retryable = ev.data.retryable;
    if (ev.category !== undefined) outcome.category = ev.category;
    if (ev.retryable !== undefined) outcome.retryable = ev.retryable;
  }

  // 成功后的定点复检：先裁定「消解/未消解」，再广播终态事件。
  private async finishSuccessfulFix(
    entry: JobEntry,
    item: BatchFixItem,
    issueIndex: number,
    outcome: FixOutcome,
  ): Promise<void> {
    const snap = entry.snapshot;
    // 定点复检：确定性检查（零 LLM），裁定问题是否真的消解。
    // adapter 未实现复检时按消解降级（保持流程成功语义）；复检自身异常按未消解如实上报。
    let resolved = true;
    let recheckNote = '';
    try {
      resolved = (await this.adapter.recheckIssueResolved?.(item.input)) ?? true;
    } catch (err: unknown) {
      resolved = false;
      recheckNote = `复检失败: ${err instanceof Error ? err.message : String(err)}`;
    }
    const base = {
      step: 'done',
      status: 'done',
      issueIndex,
      totalIssues: snap.total,
      issueKey: item.issueKey,
      issueDone: true,
      harnessSteps: outcome.harnessSteps,
      tokens: outcome.tokens,
    };
    if (resolved) {
      snap.successCount++;
      snap.doneKeys.push(item.issueKey);
      this.emit(entry, 'issue_done', { ...base, message: outcome.doneMessage || '已修复' });
      return;
    }
    snap.ineffectiveCount++;
    snap.ineffective.push({ issueKey: item.issueKey, message: recheckNote || '流程完成但问题未消解' });
    this.emit(entry, 'issue_ineffective', {
      ...base,
      message: recheckNote || '流程完成但问题未消解（已处理，需复核）',
    });
  }

  private emit(entry: JobEntry, event: string, data: unknown): void {
    entry.seq += 1;
    const item: BatchFixEvent = { seq: entry.seq, event, data };
    entry.buffer.push(item);
    if (entry.buffer.length > MAX_BUFFER_EVENTS) {
      entry.buffer.splice(0, entry.buffer.length - MAX_BUFFER_EVENTS);
    }
    for (const sink of entry.subscribers) {
      if (sink.isAborted()) {
        entry.subscribers.delete(sink);
        continue;
      }
      try {
        sink.onEvent(event, data, item.seq);
      } catch {
        entry.subscribers.delete(sink);
      }
    }
  }

  private closeSubscribers(entry: JobEntry): void {
    for (const sink of entry.subscribers) {
      try {
        sink.end();
      } catch {
        /* 流已销毁 */
      }
    }
    entry.subscribers.clear();
  }

  /**
   * 等待排队中的落盘全部完成。
   * 内存快照会先于磁盘可见（runLoop 里先改状态再 await persist），外部要「读文件」的调用方
   * （重启恢复、单测、优雅退出）必须先 flush，否则会读到上一份完整快照——本方法就是这个门。
   */
  async flush(): Promise<void> {
    await this.writeChain;
  }

  /**
   * 原子落盘：先写同目录临时文件再 rename。
   * T02478 P0 回归发现的缺陷：原先直接 fs.writeFile 就地截断重写，读取侧
   * （ensureLoaded / 单测直读快照文件）有概率拿到半截 JSON → JSON.parse 抛错，
   * 恢复链路会把「本可恢复的作业」误判为「快照不存在」，P0 H2「断线恢复」失真。
   * 临时文件名带 pid 且不以 .json 结尾，因此不会被 listSnapshotFiles 当成快照收进来。
   */
  private async writeAtomic(filePath: string, payload: string): Promise<void> {
    const tmp = `${filePath}.${process.pid}.tmp`;
    await fs.mkdir(this.jobsDir, { recursive: true });
    await fs.writeFile(tmp, payload, 'utf8');
    await fs.rename(tmp, filePath);
  }

  private async persist(entry: JobEntry): Promise<void> {
    entry.snapshot.updatedAt = Date.now();
    const filePath = path.join(this.jobsDir, `${entry.snapshot.jobId}.json`);
    const payload = JSON.stringify(entry.snapshot);
    this.writeChain = this.writeChain.then(async () => {
      try {
        await this.writeAtomic(filePath, payload);
      } catch {
        // 落盘失败仅失去「重启后恢复」能力，不影响本次修复
      }
    });
    await this.writeChain;
  }

  // 内存没有则从磁盘装载。重启前 running 的作业实际已中断：归一为 paused，由用户显式继续。
  private async ensureLoaded(jobId: string): Promise<JobEntry | null> {
    const existing = this.jobs.get(jobId);
    if (existing) return existing;
    try {
      const raw = await fs.readFile(path.join(this.jobsDir, `${jobId}.json`), 'utf8');
      const snapshot = JSON.parse(raw) as BatchFixSnapshot;
      if (snapshot.status === 'running') {
        snapshot.status = 'paused';
        snapshot.pauseRequested = false;
      }
      // 旧快照（T02922 之前落盘）没有这两个字段，补齐避免前端读到 undefined
      snapshot.ineffectiveCount ??= 0;
      snapshot.ineffective ??= [];
      // T04563：旧快照的失败项没有 retryable → 按「可重试」降级，避免老记录被误判为永久失败
      snapshot.failed = (snapshot.failed ?? []).map((f) => ({ ...f, retryable: f.retryable !== false }));
      snapshot.ineffective = snapshot.ineffective.map((f) => ({ ...f, retryable: f.retryable !== false }));
      // T02924：同理补齐 step 均值，旧作业面板不显示 undefined
      snapshot.avgStepsPerIssue ??= 0;
      const entry: JobEntry = {
        snapshot,
        buffer: [],
        seq: 0,
        subscribers: new Set(),
        stopRequested: false,
        stopKind: 'pause',
        activeAbort: null,
      };
      this.jobs.set(jobId, entry);
      return entry;
    } catch {
      return null;
    }
  }

  private async listSnapshotFiles(): Promise<Array<{ jobId: string; file: string; mtimeMs: number }>> {
    let names: string[] = [];
    try {
      names = await fs.readdir(this.jobsDir);
    } catch {
      return [];
    }
    const out: Array<{ jobId: string; file: string; mtimeMs: number }> = [];
    for (const name of names) {
      if (!name.endsWith('.json') || name === 'stats.json') continue;
      const file = path.join(this.jobsDir, name);
      try {
        const stat = await fs.stat(file);
        out.push({ jobId: name.replace(/\.json$/, ''), file, mtimeMs: stat.mtimeMs });
      } catch {
        /* 忽略无法访问的文件 */
      }
    }
    return out.sort((a, b) => b.mtimeMs - a.mtimeMs);
  }

  // 公开给测试与启动路径（T02888）：按 TTL 回收过期快照与残留临时文件。
  async pruneOldSnapshots(): Promise<void> {
    const files = await this.listSnapshotFiles();
    const now = Date.now();
    for (const f of files) {
      if (now - f.mtimeMs <= SNAPSHOT_TTL_MS) continue;
      try {
        await fs.rm(f.file, { force: true });
        this.jobs.delete(f.jobId);
      } catch {
        /* 删除失败下次再试 */
      }
    }
    // 原子写留下的临时文件（rename 前进程被杀才会残留）：同样按 TTL 回收，
    // 它们不参与 listSnapshotFiles（名字不以 .json 结尾），留着只会越攒越多。
    try {
      const names = await fs.readdir(this.jobsDir);
      for (const name of names) {
        if (!name.includes('.tmp')) continue;
        const file = path.join(this.jobsDir, name);
        try {
          const stat = await fs.stat(file);
          if (now - stat.mtimeMs <= SNAPSHOT_TTL_MS) continue;
          await fs.rm(file, { force: true });
        } catch {
          /* 忽略无法访问或已被 rename 的文件 */
        }
      }
    } catch {
      /* 目录尚不存在 */
    }
  }

  private async readStats(): Promise<DurationStats> {
    try {
      const raw = await fs.readFile(this.statsFile, 'utf8');
      const parsed = JSON.parse(raw) as Partial<DurationStats>;
      if (typeof parsed.avgMs === 'number' && parsed.avgMs > 0) {
        const samples = parsed.samples ?? 0;
        const avgMs = Math.round(parsed.avgMs);
        // 兼容 T02924 之前的旧文件（只有 samples/totalMs/avgMs）：新维度回落标定默认值，
        // 旧样本没有 step/token，不参与它们的均值（分母为 0 → 用兜底值）。
        return {
          samples,
          totalMs: parsed.totalMs ?? avgMs * samples,
          avgMs,
          sumSqMs: parsed.sumSqMs ?? 0,
          minMs: parsed.minMs ?? avgMs,
          maxMs: parsed.maxMs ?? avgMs,
          stepSamples: parsed.stepSamples ?? 0,
          totalSteps: parsed.totalSteps ?? 0,
          avgSteps:
            typeof parsed.avgSteps === 'number' && parsed.avgSteps > 0
              ? parsed.avgSteps
              : FALLBACK_STEPS_PER_ISSUE,
          tokenSamples: parsed.tokenSamples ?? 0,
          totalTokens: parsed.totalTokens ?? 0,
          avgTokens:
            typeof parsed.avgTokens === 'number' && parsed.avgTokens > 0
              ? parsed.avgTokens
              : FALLBACK_TOKENS_PER_ISSUE,
        };
      }
    } catch {
      /* 首次运行尚无统计文件 */
    }
    return emptyStats();
  }
}
