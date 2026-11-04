// ————————————————————————————————————————————————————————————
// T02753：前端测试的等待工具（把 T02687 落在单文件里的 waitFor 提成公共出口）
//
// 为什么要有这个文件：固定时长的 `await new Promise(r => setTimeout(r, 10))` 是「猜机器时长」，
// 与被测逻辑无关。全套并发跑时同批 worker 抢占事件循环，链条变长就出现假失败；
// 更糟的是当生产侧兜底阈值大于测试预算时，那是**必然失败**而不是不稳定（T02687 实测：
// Query.vue 的 EDIT_RESEND_FALLBACK_MS=3000 与测试预算 2000 正面撞车）。
// 本文件只有一份实现，六个文件共用——各写一份必然漂移，那正是本单要消灭的东西。
//
// 两个出口对应两种场景：
//  1. waitForProgress：被测链路的终点**可观测**（请求已发出 / 状态位已翻转 / DOM 已渲染）→ 轮询真实状态。
//     判据是「超过契约下限 且 连续 idleMs 无进展」，两个条件缺一不可：只靠「无进展 X ms」
//     会把合法的静默等待期（如 abort 被传输层吞掉、要等生产兜底定时器）误判成卡死。
//  2. contractSleep：终点**不可观测**（断言的是「没有发生」，或等的是生产侧定时器）→ 允许定时，
//     但预算必须由被测代码里的契约常量推导，并把来源写进 reason。裸写经验数值一律不许（见守护用例）。
//
// T04461 补的第三层口径——**判据一律按「实算时间」而不是墙钟**：
// 全套 113 文件并行时，本工具自己的一轮 `flushPromises + setTimeout(0)` 会被同机其他 worker 的同步代码
// 挤到事件循环后面。实测的偶发红就是这样来的（config-index-coverage 真实挂载 Config.vue AI 面板）：
//   全量并行 23992ms FAIL / 隔离单跑 19515ms PASS，失败信息「轮询 2 次…第 2036ms 仍无进展，已连续
//   2036ms > 2000ms」——两轮之间啥也没发生，只是那 2036ms 根本不归被测链路管。
// 所以这里把每轮节拍超出健康值（HEALTHY_POLL_MS）的部分记为「调度器欠账」，floor/idle/cap 三条判据
// 全部改用「墙钟 − 欠账」。这不是放大预算：NO_TIMER_CHAIN 一个数字都没动，机器空闲时欠账为 0，
// 行为与改造前逐毫秒一致（真卡死照样在第 floor+idle 拍就红，由 wait-for-progress-starvation.test.ts
// 的正反两组用例锁住）。欠账再大也续不了命——实算时间仍要撞上 cap，最坏退化成用例自身超时，
// 仍然是红，只是取证信息变差，不存在「被饿就永不失败」的假绿。
// ————————————————————————————————————————————————————————————
import { flushPromises } from '@vue/test-utils';

export interface ProgressWaitOptions {
  /** 契约下限：早于此不判「无进展」失败。必须由被测代码的阈值/防抖时长推导，不能随手大数 */
  floorMs: number;
  /** 进展签名：值变化即视为「异步链仍在推进」，用于续期无进展预算 */
  progress?: () => string;
  /** 超过契约下限后，进展签名连续多少毫秒毫无变化才判「真的卡住」（默认 = floorMs） */
  idleMs?: number;
  /** 绝对上限（默认 = floorMs + idleMs + 一轮余量），到点无论有无进展都失败 */
  capMs?: number;
  /**
   * 时钟注入（默认 Date.now）。只为把「调度器欠账」做成可确定性复现的样本而留的口子：
   * 单测里用合成时钟能瞬时造出 T04461 那种 2036ms 的被饿节拍，用真实 setTimeout 造就只能靠
   * 把机器压满——那正是本单要消灭的偶发红，不能拿它当判据的证明手段。生产调用点一律不许传。
   */
  now?: () => number;
}

/**
 * 健康轮询的单轮节拍上限。一次 `flushPromises + setTimeout(0)` 在没人抢占的机器上是亚毫秒级，
 * 25ms 已是十几倍余量；超出部分判为「事件循环被外部占用」（并行 worker 的同步代码、GC、进程调度），
 * 不计进无进展/上限预算——这是 T04461 判据的全部依据，也是它不等同于「把超时调大」的地方：
 * 预算的放大量不是常量，而是逐轮实测出来的。
 */
export const HEALTHY_POLL_MS = 25;

export interface WaitResult {
  /** 从调用到谓词成立实际等待的墙钟毫秒（供取证断言） */
  elapsedMs: number;
  rounds: number;
  /** 墙钟里判给「调度器欠账」的毫秒数；真实时钟下 > 0 就说明这次等待被机器负载拖长过（T04461 取证用） */
  starveMs: number;
}

/**
 * 「无产品侧定时器」链路的预算（挂载 → mock Promise 链 → 状态落定）。
 *
 * 推导来源：这类链路里唯一的时间契约是 vitest 单用例默认超时 5000ms——
 * floor 取 1000（一次组件挂载加一轮 mock Promise 链，实测远低于此），idle 取 2000
 * （过了下限再连续两秒毫无进展即判卡死），cap 取 3000（刻意小于 5000，
 * 让失败先由本工具给出带签名与轮次的取证快照，而不是被 vitest 截成一句 "Test timed out in 5000ms"，
 * 那正是 T02687 要消除的观感）。用例自身的 vitest 超时须大于 cap（默认 5000 已满足）。
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
    /** 实算时间 = 墙钟 − 欠账：三条判据一律以此为准（见文件头 T04461 说明） */
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
    // 硬上限每轮都判，不看签名有没有变。旧实现把它挂在 `签名未变` 分支的 else if 上，
    // 于是「一直在动但永远不到终点」的链路只会靠用例自身超时兜底，与 capMs 的注释
    // （「到点无论有无进展都失败」）不符——T04461 落判据时顺带纠正，由 starvation 用例 D 锁住。
    if (ours > capMs) {
      throw new Error(
        `waitForProgress 超时（实算 ${ours}ms > 硬上限 ${capMs}ms；墙钟 ${elapsed}ms，` +
          `其中调度器欠账 ${starveMs}ms）：${label}\n` +
          `  轮询 ${rounds} 次，最后进展于第 ${lastProgressAt - startedAt}ms\n` +
          `  最后一次进展签名：${lastSignature}`,
      );
    }
    await flushPromises();
    await new Promise((r) => setTimeout(r, 0));
  }
}

/**
 * 契约派生的定时等待——**只用于终点不可观测的场景**。
 * 写之前先问：被测链路的终点有没有可读的状态位 / DOM / mock 调用次数？有就用 waitForProgress。
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
