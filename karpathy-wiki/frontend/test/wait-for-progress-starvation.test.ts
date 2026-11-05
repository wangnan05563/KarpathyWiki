// T04461：waitForProgress 的「调度器欠账」判据锁。
//
// 起因（父单 T04448 全套门禁实测复现的偶发红）：`config-index-coverage.test.ts` 在全量 113 文件并行时
// 失败、隔离单跑通过，失败信息是「轮询 2 次…第 2036ms 仍无进展，已连续 2036ms > 2000ms」。
// 那 2036ms 不是被测链路在等，而是本工具自己的一轮 `flushPromises + setTimeout(0)` 被同机其他
// worker 的同步代码挤到了事件循环后面——墙钟判据把机器的负载算成了应用的卡死。
//
// 本文件用**合成时钟**把这件事变成确定性样本（不靠压满机器复现，那本身就不可复现）。
// 四条腿缺一不可：
//   A 牙齿·空转必红：节拍健康、签名不变、终点不到 → 仍按契约预算判红，且判红时点没被改造放宽；
//   B 偶发红必绿：复刻 T04461 的 2036ms 被饿节拍（用**真实** NO_TIMER_CHAIN 数值，这是现场证据）→
//     放行；同一样本按旧墙钟判据必红，差分量在断言里；
//   C 欠账续不了命：每轮被饿 5000ms、终点永不到 → 照旧判红，且报出来的欠账 ≫ 实算——
//     放大的是取证信息，不是预算；
//   D 上限不看签名：链路一直在动但永远到不了终点 → 由硬上限判红。旧实现把 capMs 挂在「签名未变」的
//     else if 上，这类链路只能靠用例自身超时兜底，与 capMs 注释「无论有无进展都失败」不符。
//
// T04471 在本文件加了两节新锁，并改了尺度口径：
//  1) 尺度：预算不再写成「真实契约毫秒 ÷ 20」。阈值一旦按实测抬离 25ms，固定毫秒会与
//     「每轮进账 = 阈值」脱钩，判红会退化到第 1 轮，「连续无进展」这条语义就根本没被测到。
//     现在 floor/idle/cap 一律以「健康上限的整数轮」表述，无论阈值是多少都落在第 5 / 第 11 轮。
//  2) 阈值必须是实测派生：数与注释里登记的 P50/P95/P99 成对锁死（旧口径下 25→30 这种小抬无人值守）。
//  3) 取证出口本身：默认关闭、只在等待结束时一次性写盘、合成时钟必须打标——这三条一旦被拆，
//     下一次「按实测定阈值」就会测到工具自己的 I/O 或被合成样本污染，本单等于没做。
import { readdirSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { HEALTHY_POLL_MS, NO_TIMER_CHAIN, waitForProgress } from './helpers/waitForProgress';

const TEST_DIR = __dirname;
/** 扫描面自指排除用文件名常量（守护不留豁免口子，但也不该把自己的合成时钟算成放水） */
const SELF = 'wait-for-progress-starvation.test.ts';

/**
 * 牙齿用例的尺度：**预算一律以「健康上限的整数轮」表述**（T04471 起）。
 *
 * 判据的形状（floor 与 idle 缺一不可、cap 每轮都判、欠账不进分子）与尺度无关，
 * 所以把 floor/idle/cap 写成 4/2/10 轮：无论阈值实测出来是多少，A/C 都恰好落在第 5 轮、
 * D 落在第 11 轮，取证轮数恒定，单条用例的真实开销只有十几轮宏任务（实测 <100ms）。
 * 真实毫秒由 B 用例现场复现（用真实 NO_TIMER_CHAIN 与 2036ms 样本），两头都不缺。
 */
const TEETH = {
  floorMs: 4 * HEALTHY_POLL_MS,
  idleMs: 2 * HEALTHY_POLL_MS,
  capMs: 10 * HEALTHY_POLL_MS,
} as const;

/** 合成节拍取健康上限本身：`gap > HEALTHY_POLL_MS` 为假 → 欠账恒为 0，每轮进账恰好一个阈值 */
const STEADY_GAP_MS = HEALTHY_POLL_MS;

/** 判红轮次的闭式：越线条件是 `ours > floorMs`，而 ours 每轮进账恰好一个节拍 → 第 floor/节拍 + 1 轮 */
const TRIP_ROUND = Math.floor(TEETH.floorMs / STEADY_GAP_MS) + 1;

/** 同理，硬上限在第 cap/节拍 + 1 轮越线（与签名是否变化无关） */
const CAP_TRIP_ROUND = Math.floor(TEETH.capMs / STEADY_GAP_MS) + 1;

/** 本文件用例的 vitest 超时：判据按合成时钟走，与墙钟无关，唯一开销是 <15 轮宏任务；给 2 倍默认余量 */
const CASE_TIMEOUT_MS = 10_000;

/** T04461 的现场样本：一次轮询之间被饿 2036ms。它必须始终高于阈值，否则欠账判据形同虚设 */
const STARVED_ROUND_MS = 2_036;

/** 「永远被饿」这一档的节拍：够大以证明欠账续不了命，够小以不超过任何契约上限 */
const HUNGRY_GAP_MS = 5_000;

/**
 * 合成时钟：每轮轮询按脚本推进一格，真实事件循环只跑 `setTimeout(r, 0)` 的亚毫秒节拍。
 * gaps[i] 是第 i+1 轮的墙钟增量；用满后固定取最后一档（便于「永远被饿」这种场景）。
 */
class SyntheticClock {
  t = 0;
  round = 0;
  /** 每轮的增量样本，供用例把「旧墙钟判据会不会红」量出来 */
  readonly gaps: number[] = [];
  constructor(private readonly plan: number[]) {}

  /** 由 predicate 调用：一轮开始即推进时钟，模拟这一轮 between-poll 花了多久 */
  step(): number {
    const gap = this.plan[Math.min(this.round, this.plan.length - 1)] ?? 0;
    this.round++;
    this.gaps.push(gap);
    this.t += gap;
    return gap;
  }

  now = () => this.t;

  /** 累计欠账的口径复刻（与 helper 同一常量）：用例用它断言「这次到底被饿了多少」 */
  starvedMs(): number {
    return this.gaps.reduce((s, g) => s + Math.max(0, g - HEALTHY_POLL_MS), 0);
  }
}

/** 从判红信息里取「(欠账, 实算)」——断言只认工具自己报出来的数，不另算一套 */
function reportedMs(message: string): { starve: number; ours: number } {
  const s = /调度器欠账 (\d+)ms/.exec(message);
  const o = /实算 (\d+)ms/.exec(message);
  expect(s, `判红信息里没有欠账取证字段：${message}`).toBeTruthy();
  expect(o, `判红信息里没有实算取证字段：${message}`).toBeTruthy();
  return { starve: Number(s?.[1]), ours: Number(o?.[1]) };
}

const HELPER_SRC = () => readFileSync(path.join(TEST_DIR, 'helpers', 'waitForProgress.ts'), 'utf8');

describe('T04461 · waitForProgress 判据：欠账扣得掉，牙齿不能一起磨掉', () => {
  it(
    'A · 节拍健康且签名不变时，仍在契约预算判红，没有因为改造而被放宽',
    async () => {
      const clock = new SyntheticClock([STEADY_GAP_MS]); // 每轮恰好贴着健康上限：欠账恒为 0
      const wait = waitForProgress('A · 永远不出现的语义索引状态行', () => (clock.step(), false), {
        ...TEETH,
        progress: () => 'loadingAi=1',
        now: clock.now,
      });
      await expect(wait).rejects.toThrow(/无进展实算/);
      const err = await wait.catch((e: unknown) => e as Error);
      expect(err).toBeInstanceOf(Error);
      const { starve, ours } = reportedMs(err.message);
      expect(starve).toBe(0);
      // 判红轮次与实算都必须落在闭式解上——阈值被抬高却没人同步预算，这里就会偏
      expect(clock.round).toBe(TRIP_ROUND);
      expect(ours).toBe(TRIP_ROUND * STEADY_GAP_MS);
      expect(ours).toBeGreaterThan(TEETH.floorMs); // 确实在预算到点时判红，而不是提前也不是靠 cap
      expect(ours).toBeLessThanOrEqual(TEETH.capMs); // 且没有走到硬上限那条路上
      expect(clock.starvedMs()).toBe(0);
    },
    CASE_TIMEOUT_MS,
  );

  it(
    'B · 复刻 T04461 的 2036ms 被饿节拍：新判据放行，旧墙钟判据按样本量出来必红',
    async () => {
      // 前提锁：现场样本必须仍高于阈值。阈值被抬到样本之上，这条腿就测不到任何东西
      // （「阈值必须是实测派生」那节同时守住上界，这里只把本腿的自洽性写死）。
      expect(STARVED_ROUND_MS).toBeGreaterThan(HEALTHY_POLL_MS);
      // 实测失败样本：轮 1 亚毫秒、轮 2 之间被饿 2036ms（这两轮签名毫无变化），轮 3 状态行进 DOM。
      const clock = new SyntheticClock([1, STARVED_ROUND_MS, 1]);
      const doneAtRound = 3;
      const result = await waitForProgress(
        'B · AI 面板语义索引状态行进入 DOM（loadingAi 落定）',
        () => {
          clock.step();
          return clock.round >= doneAtRound;
        },
        { ...NO_TIMER_CHAIN, progress: () => 'loadingAi=1', now: clock.now },
      );
      expect(result.rounds).toBe(doneAtRound);
      expect(result.elapsedMs).toBe(clock.t);
      // 欠账逐轮实测出来，且与 helper 同一口径（同一个 HEALTHY_POLL_MS）算得的量必须一致
      expect(result.starveMs).toBe(clock.starvedMs());
      expect(result.starveMs).toBe(clock.gaps[1] - HEALTHY_POLL_MS);
      expect(result.starveMs).toBeGreaterThan(0);

      // 口径差分：把旧判据（纯墙钟）在同一份样本上算一遍，证明本用例确实踩在旧实现的红线上。
      const wallIdleAtRound2 = clock.gaps[0] + clock.gaps[1];
      expect(wallIdleAtRound2).toBeGreaterThan(NO_TIMER_CHAIN.idleMs); // 旧：已连续 2037ms > 2000ms
      expect(wallIdleAtRound2).toBeGreaterThan(NO_TIMER_CHAIN.floorMs); // 旧：且超过契约下限 → 抛
      // 新判据看的是实算：第 2 轮末只过了「一个阈值 + 1ms」，离 idleMs 还远
      expect(wallIdleAtRound2 - result.starveMs).toBeLessThan(NO_TIMER_CHAIN.idleMs);
    },
    CASE_TIMEOUT_MS,
  );

  it(
    'C · 每轮被饿 5000ms 也续不了命：终点永不到时照旧判红（欠账不进预算的分子）',
    async () => {
      const clock = new SyntheticClock([HUNGRY_GAP_MS]);
      const wait = waitForProgress('C · 被机器拖死但也永远不出现的东西', () => (clock.step(), false), {
        ...TEETH,
        progress: () => 'loadingAi=1',
        now: clock.now,
      });
      const err = await wait.catch((e: unknown) => e as Error);
      expect(err).toBeInstanceOf(Error);
      expect(err.message).toMatch(/无进展实算|硬上限/);
      const { starve, ours } = reportedMs(err.message);
      // 判红时的实算恰好等于「轮数 × 健康上限」：每轮 5000ms 的虚耗全部记进欠账，一分不进预算。
      // 这是「记账而不是放大预算」的闭式证据，不依赖任何经验倍数。
      expect(clock.round).toBe(TRIP_ROUND);
      expect(ours).toBe(TRIP_ROUND * HEALTHY_POLL_MS);
      expect(starve).toBe(TRIP_ROUND * (HUNGRY_GAP_MS - HEALTHY_POLL_MS));
      expect(starve).toBeGreaterThan(ours * 10); // 虚耗与预算仍差一个数量级以上
      expect(err.message).toContain('轮询');
    },
    CASE_TIMEOUT_MS,
  );

  it(
    'D · 签名一直在动但终点不到时，由硬上限判红（旧实现挂在 else if 上，永远不会红）',
    async () => {
      const clock = new SyntheticClock([STEADY_GAP_MS]);
      let churn = 0;
      const wait = waitForProgress('D · 一直在改但到不了终点的链路', () => (clock.step(), false), {
        ...TEETH,
        progress: () => `churn=${++churn}`,
        now: clock.now,
      });
      const err = await wait.catch((e: unknown) => e as Error);
      expect(err).toBeInstanceOf(Error);
      expect(err.message).toContain('硬上限');
      const { starve } = reportedMs(err.message);
      expect(starve).toBe(0);
      // 上限按 capMs 的闭式落点判（每轮实算一个健康上限，签名变化不影响）
      expect(clock.round).toBe(CAP_TRIP_ROUND);
      expect(churn).toBeGreaterThanOrEqual(CAP_TRIP_ROUND); // 确实一直在「有进展」，旧判据会一直跳过 cap
    },
    CASE_TIMEOUT_MS,
  );
});

describe('T04461 · 合成时钟只能出现在本单测里（不许拿它给生产链路放水）', () => {
  it('除本文件外，没有任何调用点向 waitForProgress 注入 now', () => {
    const offenders = readdirSync(TEST_DIR)
      .filter((f) => f.endsWith('.test.ts') && f !== SELF)
      .filter((f) => {
        const src = readFileSync(path.join(TEST_DIR, f), 'utf8');
        return /waitForProgress\(/.test(src) && /(?:^|[,{\s])now\s*:/.test(src);
      });
    expect(offenders, `这些文件注入了合成时钟：${offenders.join(', ')}`).toEqual([]);
  });

  it('判据口径锁：helper 里 floor/idle/cap 一律按「墙钟 − 欠账」实算，且没有顺手放大契约数', () => {
    const src = HELPER_SRC();
    expect(src).toContain('export const HEALTHY_POLL_MS');
    expect(src).toContain('const ours = elapsed - starveMs;');
    // T04471 补：idle 判据里「自上次进展以来的欠账」必须单独扣掉。探针实测过——只把 `ours`
    // 退回墙钟并不会放过 T04461 那种被饿节拍（真正兜住它的是这一句），所以它不能被漏锁。
    expect(src).toContain('elapsed - lastProgressAt - (starveMs - starveAtProgress) > idleMs');
    expect(src).toContain('if (ours > capMs)'); // cap 每轮都判，不挂在签名分支上
    expect(src).toContain('options.now ?? Date.now');
    // 契约预算一个数字都没动：T04461 的修法是记账，不是放宽
    expect(src).toContain('export const NO_TIMER_CHAIN = { floorMs: 1_000, idleMs: 2_000, capMs: 3_000 }');
    // 只允许一份实现：不得在本 helper 里长出第二套等待循环
    expect(src.match(/for \(;;\)/g) ?? []).toHaveLength(1);
  });
});

describe('T04471 · 阈值必须是实测派生：数与来源成对，改一个不改另一个就是放水', () => {
  it('HEALTHY_POLL_MS 等于注释登记的 2×P95 取整值，且落在正常总体与偷走总体之间', () => {
    const src = HELPER_SRC();
    const value = /export const HEALTHY_POLL_MS = (\d+);/.exec(src);
    const p50 = /P50=(\d+(?:\.\d+)?)ms/.exec(src);
    const p95 = /P95=(\d+(?:\.\d+)?)ms/.exec(src);
    const p99 = /P99=(\d+(?:\.\d+)?)ms/.exec(src);
    expect(value, '读不到 HEALTHY_POLL_MS 的当前值').toBeTruthy();
    for (const [match, name] of [
      [p50, 'P50'],
      [p95, 'P95'],
      [p99, 'P99'],
    ] as const) {
      expect(match, `注释里没有登记实测分位 ${name}——阈值就成了估的`).toBeTruthy();
    }
    const n = Number(value?.[1]);
    const derived = Math.ceil((2 * Number(p95?.[1])) / 50) * 50;
    expect(n, `阈值 ${n} 与注释登记的 P95=${p95?.[1]} 推出的 ${derived} 不一致`).toBe(derived);
    // 双边锁：下界保证不冤枉正常节拍，上界保证「整段偷走」仍算欠账
    expect(n).toBeGreaterThanOrEqual(2 * Number(p95?.[1]));
    expect(n, `阈值 ${n} 已不小于实测 P99=${p99?.[1]}，会把正常总体的尾部也免进预算`).toBeLessThan(Number(p99?.[1]));
    expect(n, `阈值 ${n} 已不小于 T04461 的现场样本 ${STARVED_ROUND_MS}ms，偶发红会回归`).toBeLessThan(STARVED_ROUND_MS);
    // 估出来的话术必须一次清干净，否则下一个人不知道信数还是信文案
    expect(src).not.toContain('亚毫秒级');
    expect(src).not.toContain('已是十几倍余量');
  });
});

describe('T04471 · 取证出口：默认不写盘，写盘不落在被测节拍里', () => {
  it('落盘只有一处真正的写调用，且默认被环境变量短路', () => {
    const src = HELPER_SRC();
    expect(src).toContain('const POLL_SAMPLE_DUMP = process.env.T04471_POLL_DUMP');
    expect(src).toContain('if (!POLL_SAMPLE_DUMP) return;');
    expect(src.match(/appendFileSync\(POLL_SAMPLE_DUMP/g) ?? []).toHaveLength(1);
  });

  it('轮询循环体内没有任何写盘：I/O 耗时一旦进循环，分布测的就是自己', () => {
    const src = HELPER_SRC();
    const start = src.indexOf('for (;;)');
    const end = src.indexOf('契约派生的定时等待');
    expect(start).toBeGreaterThanOrEqual(0);
    expect(end, '找不到 waitForProgress 之后的边界锚点，本锁的扫描面无法确定').toBeGreaterThan(start);
    expect(src.slice(start, end)).not.toContain('appendFileSync');
  });

  it('三个出口各落一次样本，且都带上合成时钟标记与逐轮 gaps', () => {
    const src = HELPER_SRC();
    expect(src.match(/synthetic: isSynthetic, gaps/g) ?? []).toHaveLength(3);
    expect(src).toContain('const isSynthetic = options.now !== undefined;');
  });

  it('采样开关没被写进 vitest 配置（常驻打开会把一次性取证变成默认行为）', () => {
    const cfg = readFileSync(path.join(TEST_DIR, '..', 'vitest.config.ts'), 'utf8');
    expect(cfg).not.toContain('T04471_POLL_DUMP');
  });
});
