// ————————————————————————————————————————————————————————————
// T02836：api 测试的等待工具（把 frontend/test/helpers/waitForProgress.ts 的同口径落到 api 侧）
//
// 为什么复制而不是共享一个文件：两个包各有 tsconfig 与依赖面，前端那份 import 了
// @vue/test-utils 的 flushPromises，api 侧既没有也不需要。共享会把一个包的开发依赖灌进另一个包，
// 代价比「两份同口径」更大。口径漂移由两侧的守护用例共同盯住
// （frontend/test/wait-for-progress-guard.test.ts 与 api/test/wait-for-progress-guard.test.ts）。
//
// 与前端版的差异（只有这一处，且是被测对象决定的）：
// 前端要 flushPromises 才能把 Vue 的微任务链推到底；api 侧被测是 Fastify/Node 异步链，
// 让出一个宏任务（setTimeout 0）就足够把已排队的微任务与 I/O 回调推进。
//
// 两个出口对应两种场景（与前端版一致）：
//  1. waitForProgress：终点**可观测**（活跃计数已翻转 / 队列已入队 / 文件已消失）→ 轮询真实状态。
//     判据是「超过契约下限 且 连续 idleMs 无进展」，两者缺一不可。
//  2. contractSleep：终点**不可观测**（断言的是「没有发生」，或等的是真实时钟跨过某个刻度）→ 允许定时，
//     但预算必须由被测代码里的契约常量推导，并把来源写进 reason。裸写经验数值一律不许（见守护用例）。
//
// T04473 补齐的第三层口径——**判据一律按「实算时间」而不是墙钟**（前端侧 T04461 已改，本侧当时漏了）：
// api 全套 115 文件并行时，本工具自己的一轮 `setTimeout(0)` 会被同机其他 worker 的同步代码挤到事件循环
// 后面，墙钟判据于是把「机器的负载」算成「应用的卡死」。做法与前端逐字一致：每轮节拍超出
// HEALTHY_POLL_MS 的部分记为调度器欠账，floor/idle/cap 三条判据全部改用「墙钟 − 欠账」。
// 这不是放大预算（CLEANUP_CHAIN / NO_TIMER_CHAIN 一个数字都没动），机器空闲时欠账为 0、行为与改造前
// 逐毫秒一致；欠账再大也续不了命——实算时间仍要撞上 cap。由 api/test/wait-for-progress-starvation.test.ts
// 的正反四组用例锁住。api 侧与被测对象有关的唯一差异仍是：不需要 flushPromises，让出一个宏任务即可。
// ————————————————————————————————————————————————————————————

// T02836：预算里唯一的产品侧契约常量，直接从被测模块导入而非抄数值——
// 生产侧把标记轮询改成 400ms 时，这里的下限随之变大，不会出现「常量漂移而用例仍绿」。
import { MARKER_POLL_MS } from '../../src/cleanup-mutex.js';

export interface ProgressWaitOptions {
  /** 契约下限：早于此不判「无进展」失败。必须由被测代码的阈值/轮询间隔推导，不能随手大数 */
  floorMs: number;
  /** 进展签名：值变化即视为「异步链仍在推进」，用于续期无进展预算 */
  progress?: () => string;
  /** 超过契约下限后，进展签名连续多少毫秒毫无变化才判「真的卡住」（默认 = floorMs） */
  idleMs?: number;
  /** 绝对上限（默认 = floorMs + idleMs + 一轮余量），到点无论有无进展都失败 */
  capMs?: number;
  /**
   * 时钟注入（默认 Date.now）。只为把「调度器欠账」做成可确定性复现的样本而留的口子：
   * 单测里用合成时钟能瞬时造出被并行 worker 挤占事件循环的那种节拍，用真实 setTimeout 造就只能靠
   * 把机器压满——那正是本单要消灭的偶发红，不能拿它当判据的证明手段。生产调用点一律不许传
   * （由 api/test/wait-for-progress-starvation.test.ts 的注入面自指锁盯住）。
   */
  now?: () => number;
}

/**
 * 健康轮询的单轮节拍上限。**这个数在本侧还没量过，不许照抄前端的数值。**
 *
 * 前端版（`frontend/test/helpers/waitForProgress.ts`）在 T04471 里按 4 轮全量并行的实测分位把
 * 阈值从 25ms 抬到了 100ms（P50=15 / P95=44 / P99=144，双峰分布，978 个轮次样本）。**那组分布不迁移到本侧**：
 * 这里的运行时是 node 环境、被测链路与并发剖面都不同（同一句「亚毫秒级」在两台上可以差一个数量级），
 * 照抄数值等于把一个没测过的口径当成事实——正是 T04471 要消灭的毛病。
 *
 * 所以本侧暂存 25ms（判据偏松的方向不会误杀），按实测重定由派生单 T04514 承接：
 * 采样出口、双峰判据与「数与来源成对锁」都照前端那份移植过来，测出来是多少就写多少。
 * 超出上限的部分判为「事件循环被外部占用」（并行 worker 的同步代码、GC、进程调度），
 * 不计进无进展/上限预算——预算的放大量不是常量，而是逐轮实测出来的，这是它不等同于「把超时调大」的地方。
 */
export const HEALTHY_POLL_MS = 25;

export interface WaitResult {
  /** 从调用到谓词成立实际等待的墙钟毫秒（供取证断言） */
  elapsedMs: number;
  rounds: number;
  /** 墙钟里判给「调度器欠账」的毫秒数；> 0 说明这次等待被机器负载拖长过（T04473 取证用） */
  starveMs: number;
}

/**
 * 跨进程标记等待的契约预算下限 = `MARKER_POLL_MS × 2`（两整轮轮询仍无进展才算真卡住）。
 * 单独导出：用例里「断言任务被另一实例的真删挂住」这类终点不可观测的场景，
 * 让步预算用的就是这一个量，来源与 CLEANUP_CHAIN 完全同源。
 */
export const MARKER_WAIT_BUDGET_MS = MARKER_POLL_MS * 2;

/**
 * 「等另一实例的真删」链路的预算（起跑点等 `cleanup.lock` 标记失效）。
 *
 * 推导来源：本链路唯一的时间契约是清理互斥的跨进程标记轮询
 * `cleanup-mutex.ts` 的 MARKER_POLL_MS（起跑点最坏要等一整轮轮询才复判），
 * floor 取 MARKER_WAIT_BUDGET_MS=两轮轮询，其间出现进展属正常，不判卡死；
 * idle 取 2_000（过了下限再连续两秒毫无进展即判真卡），cap 取 5_000 对齐 vitest 单用例默认超时，
 * 让失败先由本工具给出带签名与轮次的取证快照，而不是被 vitest 截成一句 "Test timed out"。
 */
export const CLEANUP_CHAIN = { floorMs: MARKER_WAIT_BUDGET_MS, idleMs: 2_000, capMs: 5_000 } as const;

/**
 * 纯内存/纯同步链路的预算（登记计数、Promise 链落定）。
 * 推导来源：这类链路没有产品侧定时器，唯一契约仍是 vitest 默认 5000ms 超时；
 * 取与前端版一致的 NO_TIMER_CHAIN，两侧同数值便于对照排查。
 */
export const NO_TIMER_CHAIN = { floorMs: 1_000, idleMs: 2_000, capMs: 3_000 } as const;

export async function waitForProgress(
  label: string,
  predicate: () => boolean,
  options: ProgressWaitOptions,
): Promise<WaitResult> {
  const floorMs = options.floorMs;
  const idleMs = options.idleMs ?? floorMs;
  const capMs = options.capMs ?? floorMs + idleMs + 1_000;
  const nowFn = options.now ?? Date.now;
  const startedAt = nowFn();
  let lastProgressAt = startedAt;
  let lastSignature = options.progress?.() ?? '-';
  let rounds = 0;
  /** 累计调度器欠账（逐轮节拍超出 HEALTHY_POLL_MS 的部分） */
  let starveMs = 0;
  /** 上次进展时点的欠账快照：用它算「自上次进展以来」的欠账，而不是全程欠账 */
  let starveAtProgress = 0;
  let prevRoundAt = startedAt;
  for (;;) {
    rounds++;
    if (predicate()) {
      return { elapsedMs: nowFn() - startedAt, rounds, starveMs };
    }
    const now = nowFn();
    const gap = now - prevRoundAt;
    prevRoundAt = now;
    if (gap > HEALTHY_POLL_MS) starveMs += gap - HEALTHY_POLL_MS;
    const elapsed = now - startedAt;
    /** 实算时间 = 墙钟 − 欠账：三条判据一律以此为准（见文件头 T04473 说明） */
    const ours = elapsed - starveMs;
    const signature = options.progress?.() ?? '-';
    if (signature !== lastSignature) {
      lastSignature = signature;
      lastProgressAt = now;
      starveAtProgress = starveMs;
    } else if (ours > floorMs && elapsed - lastProgressAt - (starveMs - starveAtProgress) > idleMs) {
      const idleOurs = elapsed - lastProgressAt - (starveMs - starveAtProgress);
      throw new Error(
        `waitForProgress 超时（第 ${elapsed}ms 仍无进展，其中调度器欠账 ${starveMs}ms，实算 ${ours}ms；` +
          `无进展实算 ${idleOurs}ms > ${idleMs}ms（墙钟连续 ${elapsed - lastProgressAt}ms），` +
          `且超过契约下限 ${floorMs}ms）：${label}\n` +
          `  轮询 ${rounds} 次，最后进展于第 ${lastProgressAt - startedAt}ms\n` +
          `  最后一次进展签名：${lastSignature}`,
      );
    }
    // 硬上限每轮都判，不看签名有没有变——与前端 T04461 同一处纠正：旧实现把它挂在 `签名未变` 分支的
    // else if 上，于是「一直在动但永远不到终点」的链路只会靠用例自身超时兜底，与 capMs 的注释
    // （「到点无论有无进展都失败」）不符。
    if (ours > capMs) {
      throw new Error(
        `waitForProgress 超时（实算 ${ours}ms > 硬上限 ${capMs}ms；墙钟 ${elapsed}ms，` +
          `其中调度器欠账 ${starveMs}ms）：${label}\n` +
          `  轮询 ${rounds} 次，最后进展于第 ${lastProgressAt - startedAt}ms\n` +
          `  最后一次进展签名：${lastSignature}`,
      );
    }
    await new Promise((r) => setTimeout(r, 0));
  }
}

/**
 * 轮询「读一个真实状态」直到判据成立，并把最后一次读到的值交回调用方做断言。
 * 为什么在 waitForProgress 之外还要这一个：api 侧多数断言形如「读作业记录 → 判它的状态字段」，
 * 终点值本身就是证据；只回布尔值的话调用方还得再读一次，两次读之间状态可能又变。
 *
 * T04473：判据与 `waitForProgress` 完全同口径（欠账记账 + 实算 floor/idle/cap），
 * 只把「读到的值」额外作为证据带出去。一处与 `waitForProgress` 不同的节拍口径：
 * 本函数的一轮 = `setTimeout(0)` + 一次 `read()`，所以欠账按「上一轮的让位 + 读」的总时长算
 * （`prevRoundAt` 起点取在首读之前，且读后不复位）。这意味着一次确实很慢的 `read()` 会被记成欠账——
 * 这是对的归因：慢的是取证据的机器负载，不是被测链路卡死；`ours` 仍要撞 cap，续不了命。
 */
export async function pollUntil<T>(
  label: string,
  read: () => Promise<T> | T,
  predicate: (v: T) => boolean,
  options: ProgressWaitOptions,
): Promise<{ value: T; wait: WaitResult }> {
  const nowFn = options.now ?? Date.now;
  const startedAt = nowFn();
  let rounds = 0;
  let last = await read();
  const idleMs = options.idleMs ?? options.floorMs;
  const capMs = options.capMs ?? options.floorMs + idleMs + 1_000;
  let lastProgressAt = startedAt;
  let lastSignature = options.progress?.() ?? String(last);
  let starveMs = 0;
  let starveAtProgress = 0;
  let prevRoundAt = startedAt;
  while (!predicate(last)) {
    const now = nowFn();
    const gap = now - prevRoundAt;
    prevRoundAt = now;
    if (gap > HEALTHY_POLL_MS) starveMs += gap - HEALTHY_POLL_MS;
    const elapsed = now - startedAt;
    const ours = elapsed - starveMs;
    const signature = options.progress?.() ?? String(last);
    if (signature !== lastSignature) {
      lastSignature = signature;
      lastProgressAt = now;
      starveAtProgress = starveMs;
    } else if (ours > options.floorMs && elapsed - lastProgressAt - (starveMs - starveAtProgress) > idleMs) {
      const idleOurs = elapsed - lastProgressAt - (starveMs - starveAtProgress);
      throw new Error(
        `pollUntil 超时（第 ${elapsed}ms 仍无进展，其中调度器欠账 ${starveMs}ms，实算 ${ours}ms；` +
          `无进展实算 ${idleOurs}ms > ${idleMs}ms（墙钟连续 ${elapsed - lastProgressAt}ms））：${label}\n` +
          `  轮询 ${rounds} 次，最后一次读到的值：${JSON.stringify(last)}`,
      );
    }
    if (ours > capMs) {
      throw new Error(
        `pollUntil 超时（实算 ${ours}ms > 硬上限 ${capMs}ms；墙钟 ${elapsed}ms，` +
          `其中调度器欠账 ${starveMs}ms）：${label}\n` +
          `  最后一次读到的值：${JSON.stringify(last)}`,
      );
    }
    await new Promise((r) => setTimeout(r, 0));
    rounds++;
    last = await read();
  }
  return { value: last, wait: { elapsedMs: nowFn() - startedAt, rounds, starveMs } };
}

/**
 * 契约派生的定时等待——**只用于终点不可观测的场景**。
 * 写之前先问：被测链路的终点有没有可读的状态位 / 计数 / 文件存在性？有就用 waitForProgress/pollUntil。
 *
 * @param reason 预算来源：必须点名被测代码里的契约常量（文件+常量名+推导式），空串直接抛错
 * @param ms     等待时长，须为 `契约常量 × 倍率`，禁止裸写经验数值
 */
export function contractSleep(reason: string, ms: number): Promise<void> {
  const why = reason.trim();
  if (why.length === 0) {
    throw new Error('contractSleep 必须写明预算来源（哪个契约常量推导而来），否则就是裸写经验数值');
  }
  if (!Number.isFinite(ms) || ms <= 0) {
    throw new Error(`contractSleep 预算非法：${ms}`);
  }
  return new Promise((r) => setTimeout(r, ms));
}

/**
 * 「让出一个真实时间片」的统一口径——用于**负向断言**前的让步
 * （断言的是「某事没有发生」，无法用终点轮询表达，只能给它足够时间跑偏）。
 * 预算与来源集中在这一处，测试文件里不再各自 `setTimeout(r, 5)`（那正是本单要消灭的写法）。
 */
export const TEST_SLICE_MS = 5;
export function yieldSlice(forWhat: string): Promise<void> {
  return contractSleep(
    `TEST_SLICE_MS=5ms：让步给 Node 事件循环跑完已排队的微任务与 I/O 回调（${forWhat}）`,
    TEST_SLICE_MS,
  );
}
