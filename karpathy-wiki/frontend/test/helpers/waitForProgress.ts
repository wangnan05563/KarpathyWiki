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
//
// T04471 又补了一层：**那个「健康节拍」本身必须量出来**。原值 25ms 是估的，实测 978 轮里 14% 的
// 正常轮次都被记成欠账，等于判据被悄悄放宽；现在阈值按 4 轮全量并行的实测分位推导，
// 数与来源成对锁死（见 HEALTHY_POLL_MS 注释 + 单测「阈值必须是实测派生」），并留了一个默认关闭的
// 取证出口（T04471_POLL_DUMP）——分布要重测就重测，不许再靠话术定数。
// ————————————————————————————————————————————————————————————
import { appendFileSync } from 'node:fs';
import { flushPromises } from '@vue/test-utils';

/**
 * T04471 取证出口：设了环境变量 `T04471_POLL_DUMP=<jsonl 路径>` 才逐轮留存节拍样本，默认完全不走这条路。
 * 落盘只发生在一次等待**结束时**（正常返回或判红抛出），绝不在轮询循环里做 I/O——
 * 写文件自身的耗时会落进下一轮的 gap，把要测的东西测脏，分布就失去意义了。
 * 循环里唯一的代价是 `gaps.push(gap)`（一个数组追加）。
 */
const POLL_SAMPLE_DUMP = process.env.T04471_POLL_DUMP;

function dumpPollSamples(entry: { label: string; rounds: number; elapsedMs: number; starveMs: number; outcome: string; synthetic: boolean; gaps: number[] }): void {
  if (!POLL_SAMPLE_DUMP) return;
  appendFileSync(POLL_SAMPLE_DUMP, `${JSON.stringify({ pid: process.pid, ...entry })}\n`);
}

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
 * 健康轮询的单轮节拍上限。**这个数是量出来的，不是估的**（T04471）。
 *
 * 样本来源：本文件的取证出口（`T04471_POLL_DUMP`）在 **4 轮全量并行**（129 文件，vitest 默认
 * threads 池满并行）里逐轮留存的**真实时钟**单轮间隔；合成时钟用例（下面 A/B/C/D 那四条腿）
 * 按 `synthetic` 标记筛掉，不计入分布。共 120 次等待 / **978 个轮次样本**（其中第 4 轮是阈值
 * 抬到 100 之后的交叉核对轮，间隔分布与前 3 轮同源——欠账只影响预算记账，不影响节拍本身）。
 * 实测分位：P50=15ms  P90=29ms  P95=44ms  P99=144ms  P99.9=2671ms  最大值 2671ms  均值 27.6ms。
 *
 * 分布是**双峰**的，这一点决定阈值怎么取：
 *  - 正常总体止于 ~144ms（一次 `flushPromises + setTimeout(0)` 加一个廉价谓词，被同批 worker 挤压后就是这样）；
 *  - 再往上的 407 / 467 / 556 / 621 / 1237 / 1411 / 1507 / 1888 / 2671ms（978 轮里 9 轮，0.9%）与 P50 差两个数量级，
 *    不是「应用算得慢」而是**事件循环被整段偷走**——T04461 那次偶发红（单轮 2036ms）就属于这一总体。
 *    被饿的那一段不归被测链路管，所以必须记成欠账；这一段是本判据存在的唯一理由。
 *
 * 因此阈值要落在两个总体之间，取 **`ceil(2 × P95 / 50) × 50 = 100`**：
 *  - 下界 `2 × P95 = 88`：正常总体的极端（含 P95 的机器抖动）一律不记欠账，判据按墙钟原样收敛；
 *  - 上界 `P99 = 144`：越过正常总体就必须记欠账，否则 T04461 的偶发红回归。
 *  两侧都由 `wait-for-progress-starvation.test.ts` 的「阈值必须是实测派生」那节盯着：**改了数没改注释、
 *  或改了注释没改数，都会红**（旧口径下 25→30 这种小抬无人值守，正是本单要补的牙）。
 *
 * 为什么不是原来的 25：实测 978 轮里有 **137 轮（14.0%）超过 25ms**，其中 120 轮落在 25~100ms 的
 * 正常总体里——那等于把机器常态负载一律免进预算，等待实际消耗的墙钟比契约预算多出 14%，
 * 判据被悄悄放宽了（本单修的就是这个口径失真）。抬到 100 后被判欠账的只剩 17 轮（1.74%）：
 * 其中 9 轮（0.9%）确实是整段偷走，另外 8 轮（0.8%）是正常总体 P95→P99 的拖尾——把上界钉在
 * P99 之下必然要付这点代价，但它比旧口径的 14% 免单小一个数量级，且不会随机器负载放大。
 *
 * 抬阈值会让各等待的「垫付」变少、判定更严，所以按点名文件逐条核对过余量（4 轮实测；下面「垫付」
 * 一律指该轮实际生效阈值下记到的 starveMs，阈值 25 的那三轮和阈值 100 的这一轮不能直接混着看）：
 *  - `query-edit-resend-flow` 的 `S3 兜底定时器`：158~202 轮 / 墙钟 3046~3100ms。旧阈值 25 下垫付 386/120/50ms，
 *    实算 2660~3010ms；抬到 100 后第 4 轮只垫付 32ms（那轮节拍 123ms），实算 3068ms，对 floor 3500ms
 *    余 432ms——这是四轮里最薄的一次，也仍落在它自己推导式 `EDIT_RESEND_FALLBACK_MS(3000) + 500`
 *    声明的余量之内（实测兜底定时器比标称 3000ms 迟了 46~100ms）。阈值再往上抬之前必须先重估这个 +500。
 *  - `config-index-coverage` 的语义索引等待：第 4 轮最坏一次墙钟 3294ms、单轮被偷 2671ms，阈值 100 下
 *    仍记欠账 2571ms、实算 723ms（floor 1000ms，余量 277ms）。被偷的轮次越多它反而越宽松——
 *    这条靠的是欠账记账，不是阈值大小。
 * 阈值调整后复跑的两轮全量并行零偶发红：带取证的第 4 轮与不带取证的第 5 轮均 129 文件 / 1299 用例全绿，
 * 点名两条 `config-index-coverage`（34.5s / 35.9s）与 `query-edit-resend-flow`（5.3s / 5.1s）稳定通过。
 */
export const HEALTHY_POLL_MS = 100;

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
  /** 合成时钟下的节拍不是机器真实分布（T04461 的 A/B/C/D 用例），取证时必须能筛掉 */
  const isSynthetic = options.now !== undefined;
  const startedAt = nowFn();
  let lastProgressAt = startedAt;
  let lastSignature = options.progress?.() ?? '-';
  let rounds = 0;
  /** 累计调度器欠账（逐轮节拍超出 HEALTHY_POLL_MS 的部分） */
  let starveMs = 0;
  /** 上次进展时点的欠账快照：用它算「自上次进展以来」的欠账，而不是全程欠账 */
  let starveAtProgress = 0;
  let prevRoundAt = startedAt;
  /** T04471：逐轮节拍样本，只在取证模式下落盘（见 dumpPollSamples） */
  const gaps: number[] = [];
  for (;;) {
    rounds++;
    if (predicate()) {
      const at = nowFn();
      // 闭合轮的间隔（上一轮判红点到终点成立这一段）必须进样本：结构与其它轮完全一样
      // （一次 await + 一次 predicate），漏掉它会让实测尾部系统性偏小——实测里就出现过
      // rounds=2 / elapsed=1511ms 这种「全部耗时都落在闭合轮」的等待。判据本身不受影响
      // （成功路径没有预算可判），所以这条只走取证出口。
      if (POLL_SAMPLE_DUMP) gaps.push(at - prevRoundAt);
      const result = { elapsedMs: at - startedAt, rounds, starveMs };
      dumpPollSamples({ label, rounds, elapsedMs: result.elapsedMs, starveMs, outcome: 'ok', synthetic: isSynthetic, gaps });
      return result;
    }
    const now = nowFn();
    const gap = now - prevRoundAt;
    gaps.push(gap);
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
      const message =
        `waitForProgress 超时（第 ${elapsed}ms 仍无进展，其中调度器欠账 ${starveMs}ms，实算 ${ours}ms；` +
        `无进展实算 ${idleOurs}ms > ${idleMs}ms（墙钟连续 ${elapsed - lastProgressAt}ms），` +
        `且超过契约下限 ${floorMs}ms）：${label}\n` +
        `  轮询 ${rounds} 次，最后进展于第 ${lastProgressAt - startedAt}ms\n` +
        `  最后一次进展签名：${lastSignature}`;
      dumpPollSamples({ label, rounds, elapsedMs: elapsed, starveMs, outcome: 'idle-timeout', synthetic: isSynthetic, gaps });
      throw new Error(message);
    }
    // 硬上限每轮都判，不看签名有没有变。旧实现把它挂在 `签名未变` 分支的 else if 上，
    // 于是「一直在动但永远不到终点」的链路只会靠用例自身超时兜底，与 capMs 的注释
    // （「到点无论有无进展都失败」）不符——T04461 落判据时顺带纠正，由 starvation 用例 D 锁住。
    if (ours > capMs) {
      const message =
        `waitForProgress 超时（实算 ${ours}ms > 硬上限 ${capMs}ms；墙钟 ${elapsed}ms，` +
        `其中调度器欠账 ${starveMs}ms）：${label}\n` +
        `  轮询 ${rounds} 次，最后进展于第 ${lastProgressAt - startedAt}ms\n` +
        `  最后一次进展签名：${lastSignature}`;
      dumpPollSamples({ label, rounds, elapsedMs: elapsed, starveMs, outcome: 'cap-timeout', synthetic: isSynthetic, gaps });
      throw new Error(message);
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
