// T04565-A：LLM 出站速率闸（进程级）。
//
// 背景：此前 LLM 出站完全没有统一速率闸——429 只能靠事后重试兜。真实并发来源是
// query 路径（不受 withCompileLock 约束）与多标签页/多用户同时问答；重试叠加（Layer A ×
// Layer B）还会把偶发 429 打成持续 429。
//
// 设计要点：
//  1) 单点出网：所有 LLM 请求都经 OpenAICompatibleAdapter.chat()/chatStream()，二者
//     共用 fetchWithRetry()；闸门就卡在 fetchWithRetry 每次尝试的入口，天然覆盖重试。
//  2) 进程级单例：query / health / compile 各路径都会 new 各自的 adapter，为避免各管一段，
//     用模块级 shared 实例让全进程共用一个闸（见 getSharedRateLimiter）。
//  3) 双约束：maxConcurrent（并发闸）+ 令牌桶（requestsPerMinute / tokensPerMinute）。
//  4) 自适应：收到 429 时把 rateMul 临时减半（下限 0.1），距上次限流超过 30s 后每次补充
//     缓慢回调 0.1，直至回到 1。Retry-After 的**实际等待**由 retry-policy 的 withRetry 负责
//     （T04564 已落地），本闸只调整自身出速，不重复实现等待逻辑，避免双重休眠。
//
// 缺省（未配置 rateLimit）时闸门禁用，完全保持历史行为，不得因缺配置而启动失败。

import type { RateLimitConfig } from '../types.js';

// 保守占位默认值：仅在配置块缺字段时兜底。真实额度须由用户在 config.json 覆盖
// （agnes / deepseek 的实际 RPM/TPM 属产品/额度决策，见 T04565 约束）。
const FALLBACK: Omit<RateLimitConfig, 'enabled'> = {
  maxConcurrent: 4,
  requestsPerMinute: 60,
  tokensPerMinute: 100_000,
};

// 降速恢复：距上次 429 超过该时长后，每次 refill 把 rateMul 向 1 回调一步
const RECOVERY_AFTER_MS = 30_000;
const RECOVERY_STEP = 0.1;
// rateMul 下限（最多降到原速率的 10%，避免限流后长期停摆）
const MIN_RATE_MUL = 0.1;

function resolveConfig(cfg?: Partial<RateLimitConfig>): RateLimitConfig {
  // 无配置块 = 禁用（保持历史行为，不节流）
  if (!cfg) {
    return { enabled: false, ...FALLBACK };
  }
  return {
    enabled: cfg.enabled ?? true,
    maxConcurrent: cfg.maxConcurrent ?? FALLBACK.maxConcurrent,
    requestsPerMinute: cfg.requestsPerMinute ?? FALLBACK.requestsPerMinute,
    tokensPerMinute: cfg.tokensPerMinute ?? FALLBACK.tokensPerMinute,
  };
}

const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * 进程内 LLM 出站速率闸。
 * 使用方式：`await limiter.acquire(tokens)` → 发起请求 → `finally { limiter.release() }`。
 * acquire 成功即占用一个并发槽；release 必须在请求结束时（成功/失败/重试）调用一次。
 */
// 可注入依赖：生产用真实 Date/setTimeout；单测注入可控时钟与立即返回的 sleep，
// 从而在不真实等待的前提下断言「令牌桶在时间窗口内限制请求数」。
export interface RateLimiterDeps {
  now: () => number;
  sleep: (ms: number) => Promise<void>;
}

export class RateLimiter {
  readonly enabled: boolean;
  private readonly maxConcurrent: number;
  private readonly rpm: number;
  private readonly tpm: number;

  private readonly now: () => number;
  private readonly sleep: (ms: number) => Promise<void>;

  // 令牌桶：当前可用令牌（浮点，按时间连续补充）
  private reqTokens: number;
  private tokTokens: number;
  private lastRefillAt: number;

  // 并发闸：已占用槽位 + 等待唤醒队列（FIFO）
  private inFlight = 0;
  private readonly waiters: Array<() => void> = [];

  // 自适应降速倍率（1 = 全速；越小越慢）
  private rateMul = 1;
  private lastLimitedAt = 0;

  constructor(cfg?: Partial<RateLimitConfig>, deps?: Partial<RateLimiterDeps>) {
    const c = resolveConfig(cfg);
    this.enabled = c.enabled;
    this.maxConcurrent = c.maxConcurrent;
    this.rpm = c.requestsPerMinute;
    this.tpm = c.tokensPerMinute;
    this.now = deps?.now ?? (() => Date.now());
    this.sleep = deps?.sleep ?? ((ms) => sleep(ms));
    this.reqTokens = this.effectiveRpm();
    this.tokTokens = this.effectiveTpm();
    this.lastRefillAt = this.now();
  }

  /** 当前有效速率倍率（供测试与可观测性读取；<1 表示处于降速中） */
  get rateMultiplier(): number {
    return this.rateMul;
  }

  /** 当前已占用的并发槽数（供测试读取） */
  get activeRequests(): number {
    return this.inFlight;
  }

  private effectiveRpm(): number {
    return Math.max(1, Math.floor(this.rpm * this.rateMul));
  }

  private effectiveTpm(): number {
    return Math.max(1, Math.floor(this.tpm * this.rateMul));
  }

  // 按经过时间补充令牌，并在远离限流时缓慢恢复速率倍率
  private refill(): void {
    const now = this.now();
    const elapsed = now - this.lastRefillAt;
    if (elapsed > 0) {
      const minutes = elapsed / 60_000;
      this.reqTokens = Math.min(this.effectiveRpm(), this.reqTokens + this.effectiveRpm() * minutes);
      this.tokTokens = Math.min(this.effectiveTpm(), this.tokTokens + this.effectiveTpm() * minutes);
    }
    this.lastRefillAt = now;

    if (this.rateMul < 1 && now - this.lastLimitedAt > RECOVERY_AFTER_MS) {
      this.rateMul = Math.min(1, this.rateMul + RECOVERY_STEP);
    }
  }

  // 距离「凑够 needReq 个请求令牌 / needTok 个 token 令牌」还要等多久（毫秒，至少 1ms）
  private msUntilRefill(needReq: number, needTok: number): number {
    const needRpm = Math.max(0, needReq - this.reqTokens);
    const needTpm = Math.max(0, needTok - this.tokTokens);
    const waitReqMs = needRpm > 0 ? (needRpm / this.effectiveRpm()) * 60_000 : 0;
    const waitTokMs = needTpm > 0 ? (needTpm / this.effectiveTpm()) * 60_000 : 0;
    // +1 保证严格大于所需时间，避免浮点误差导致永远差一点点
    return Math.max(1, Math.ceil(Math.max(waitReqMs, waitTokMs)) + 1);
  }

  /**
   * 取一个出站许可。会阻塞直到并发槽与令牌都可用。
   * @param estimatedTokens 本次请求的 token 估算（仅首个尝试传入；重试传 0，避免同请求重复计 token）
   */
  async acquire(estimatedTokens = 0): Promise<void> {
    if (!this.enabled) return;

    // 并发准入：条件为真才 await（此时让出执行权），为假则同步跳过并立刻占槽，
    // 保证「检查-占槽」之间不存在让出点，杜绝并发超额。
    while (this.inFlight >= this.maxConcurrent) {
      await new Promise<void>((resolve) => this.waiters.push(resolve));
    }
    this.inFlight += 1;

    try {
      this.refill();
      // 单请求 token 可能大于每分钟预算（极小 TPM 配置下的长上下文）：此时把等待目标
      // 夹到桶容量，等桶满即放行（余量扣到 0），避免永远凑不够而挂死。
      const needTok = Math.min(estimatedTokens, this.effectiveTpm());
      while (this.reqTokens < 1 || this.tokTokens < needTok) {
        await this.sleep(this.msUntilRefill(1, needTok));
        this.refill();
      }
      this.reqTokens -= 1;
      this.tokTokens = Math.max(0, this.tokTokens - estimatedTokens);
    } catch (err) {
      // 取令牌阶段异常（理论不发生）：回退并发槽，避免泄漏
      this.inFlight = Math.max(0, this.inFlight - 1);
      throw err;
    }
  }

  /** 请求结束释放并发槽（必须在 finally 调用一次，对应一次成功的 acquire） */
  release(): void {
    if (!this.enabled) return;
    this.inFlight = Math.max(0, this.inFlight - 1);
    // 唤醒一个等待者（FIFO），由它重新竞争令牌
    const next = this.waiters.shift();
    if (next) next();
  }

  /**
   * 收到 429 限流：把速率临时减半，并立即削掉一半当前令牌，强制后续请求降速。
   * 不做实际等待——Retry-After 的等待由 withRetry 负责（避免双重休眠）。
   */
  onRateLimited(_retryAfterMs?: number | null): void {
    if (!this.enabled) return;
    this.rateMul = Math.max(MIN_RATE_MUL, this.rateMul * 0.5);
    this.lastLimitedAt = this.now();
    this.reqTokens = Math.min(this.reqTokens, this.effectiveRpm() * 0.5);
    this.tokTokens = Math.min(this.tokTokens, this.effectiveTpm() * 0.5);
  }
}

// 进程级单例：query / health / compile 各自 new adapter，但共用同一个闸实例。
// 首次带 rateLimit 的调用创建实例；后续复用（配置属服务端全局，不随用户切换）。
let shared: RateLimiter | null = null;

/**
 * 取得（或惰性创建）进程级共享速率闸。
 * - cfg 为空（未配置）时返回 null（调用方视为禁用）。
 * - 已存在实例时直接复用，保证全进程单一闸。
 */
export function getSharedRateLimiter(cfg?: Partial<RateLimitConfig>): RateLimiter | null {
  // 未配置 rateLimit 的 adapter 视为禁用（不借用别人的闸），保持各自历史行为
  if (!cfg) return null;
  if (!shared) {
    shared = new RateLimiter(cfg);
  }
  return shared;
}

/** 仅供测试：重置进程级单例，避免用例间互相污染。 */
export function resetSharedRateLimiterForTest(): void {
  shared = null;
}
