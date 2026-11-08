// T04473：api 侧 waitForProgress / pollUntil 的「调度器欠账」判据锁（前端 T04461 的同口径移植）。
//
// 起因有两条，缺一条这单就不该开：
//  1. 前端 T04461 把判据从纯墙钟换成「墙钟 − 欠账」后，api 侧的 `helpers/waitForProgress.ts` 漏改，
//     而跨侧口径锁（api/test/wait-for-progress-guard.test.ts「两侧口径锁」）当时比的是 **api 自己写的
//     那条旧正则**，于是 api 全量套件长期只挂这一条红、其余全绿——门本身没牙。本文件把那四腿搬到 api。
//  2. api 侧还多一条循环 `pollUntil`（前端没有）：它的读动作本身是真实 I/O，欠账口径若不同步，
//     「读作业记录 → 判状态字段」这类用例在 115 文件并行时照样会被机器的负载判成应用卡死。
//
// 四条腿缺一不可（A/B/C/D 与前端逐字同形，E/F 是 api 专有的 pollUntil 两腿）：
//   A 牙齿·空转必红：节拍健康、签名不变、终点不到 → 仍按契约预算判红，且判红时点没被改造放宽；
//   B 偶发红必绿：复刻被饿 2036ms 的节拍（真实 NO_TIMER_CHAIN 数值）→ 放行；同一样本按旧墙钟判据必红；
//   C 欠账续不了命：每轮被饿 5000ms、终点永不到 → 照旧判红，且报出来的欠账 ≫ 实算——放大的是取证信息，不是预算；
//   D 上限不看签名：链路一直在动但永远到不了终点 → 由硬上限判红（旧实现挂在 else if 上，这类永远不红）；
//   E pollUntil 偶发红必绿：慢读出现在**非最后一轮** → 欠账被扣掉、用例放行，旧墙钟判据同样本必红；
//   F pollUntil 牙齿：每轮慢读 5000ms 且终点永不到 → 照旧判红。
import { readdirSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { HEALTHY_POLL_MS, NO_TIMER_CHAIN, pollUntil, waitForProgress } from './helpers/waitForProgress.js';

const TEST_DIR = __dirname;
/** 扫描面自指排除用文件名常量（守护不留豁免口子，但也不该把自己的合成时钟算成放水） */
const SELF = 'wait-for-progress-starvation.test.ts';

/**
 * 牙齿用例的尺度：**预算一律以「健康上限的整数轮」表述**（T04514 同步前端 T04471）。
 *
 * 阈值一旦按实测抬离 25ms，固定毫秒会与「每轮进账 = 阈值」脱钩，判红会退化到第 1 轮，
 * 「连续无进展」这条语义就根本没被测到。现在 floor/idle/cap 写成 4/2/10 轮：
 * 无论阈值实测出来是多少，A/C/F 都恰好落在第 5 轮、D 落在第 11 轮。
 * 真实毫秒由 B/E 两腿现场复现（用真实 NO_TIMER_CHAIN 与 2036ms 样本），两头都不缺。
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

/** T04461 的现场样本：一次轮询之间被饿 2036ms。它必须始终高于阈值，否则欠账判据形同虚设 */
const STARVED_ROUND_MS = 2_036;

/** 「永远被饿」这一档的节拍：够大以证明欠账续不了命，够小以不超过任何契约上限 */
const HUNGRY_GAP_MS = 5_000;

/** 本文件用例的 vitest 超时：判据按合成时钟走，与墙钟无关，唯一开销是 <10 轮宏任务；给 2 倍默认余量 */
const CASE_TIMEOUT_MS = 10_000;

/**
 * 合成时钟：每次 step 推进一格，真实事件循环只跑 helper 里的 `setTimeout(r, 0)` 亚毫秒节拍。
 * gaps[i] 是第 i+1 轮的墙钟增量；用满后固定取最后一档（便于「永远被饿」这种场景）。
 */
class SyntheticClock {
  t = 0;
  round = 0;
  /** 每轮的增量样本，供用例把「旧墙钟判据会不会红」量出来 */
  readonly gaps: number[] = [];
  constructor(private readonly plan: number[]) {}

  /** 由 predicate / read 调用：一轮开始即推进时钟，模拟这一轮 between-poll 花了多久 */
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

/** 判红用例的统一收口：取出 Error；helper 反而放行时，把放行的值当成失败信息抛出来（不会静默变绿） */
async function failureOf(promise: Promise<unknown>): Promise<Error> {
  try {
    const ok = await promise;
    throw new Error(`预期判红但放行了：${JSON.stringify(ok)}`);
  } catch (e) {
    return e as Error;
  }
}

const HELPER_SRC = () => readFileSync(path.join(TEST_DIR, 'helpers', 'waitForProgress.ts'), 'utf8');

describe('T04473 · waitForProgress 判据：欠账扣得掉，牙齿不能一起磨掉', () => {
  it(
    'A · 节拍健康且签名不变时，仍在契约预算判红，没有因为改造而被放宽',
    async () => {
      const clock = new SyntheticClock([STEADY_GAP_MS]); // 每轮恰好贴着健康上限：欠账恒为 0
      const wait = waitForProgress('A · 永远不落定的作业状态', () => (clock.step(), false), {
        ...TEETH,
        progress: () => 'status=pending',
        now: clock.now,
      });
      const err = await failureOf(wait);
      expect(err).toBeInstanceOf(Error);
      expect(err.message).toMatch(/无进展实算/);
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
    'B · 复刻被饿 2036ms 的节拍：新判据放行，旧墙钟判据按样本量出来必红',
    async () => {
      expect(STARVED_ROUND_MS).toBeGreaterThan(HEALTHY_POLL_MS);
      // 现场样本形态：轮 1 亚毫秒、轮 2 之间被饿 2036ms（这两轮签名毫无变化），轮 3 终点落进状态。
      const clock = new SyntheticClock([1, STARVED_ROUND_MS, 1]);
      const doneAtRound = 3;
      const result = await waitForProgress(
        'B · 作业状态行落到终值（真实 NO_TIMER_CHAIN 预算）',
        () => {
          clock.step();
          return clock.round >= doneAtRound;
        },
        { ...NO_TIMER_CHAIN, progress: () => 'status=pending', now: clock.now },
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
      // 新判据看的是实算：第 2 轮末只过了 26ms，离 idleMs 还远
      expect(wallIdleAtRound2 - result.starveMs).toBeLessThan(NO_TIMER_CHAIN.idleMs);
    },
    CASE_TIMEOUT_MS,
  );

  it(
    'C · 每轮被饿 5000ms 也续不了命：终点永不到时照旧判红（欠账不进预算的分子）',
    async () => {
      const clock = new SyntheticClock([HUNGRY_GAP_MS]);
      const wait = waitForProgress('C · 被机器拖死但也永远不出现的状态', () => (clock.step(), false), {
        ...TEETH,
        progress: () => 'status=pending',
        now: clock.now,
      });
      const err = await failureOf(wait);
      expect(err).toBeInstanceOf(Error);
      expect(err.message).toMatch(/无进展实算|硬上限/);
      const { starve, ours } = reportedMs(err.message);
      // 判红时的实算恰好等于「轮数 × 健康上限」：每轮 5000ms 的虚耗全部记进欠账，一分不进预算。
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
      const err = await failureOf(wait);
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

describe('T04473 · pollUntil 必须同口径（api 专有的一条循环，漏它等于只修半边）', () => {
  it(
    'E · 慢读落在非最后一轮：欠账被扣掉、用例放行；同一样本按旧墙钟判据必红',
    async () => {
      expect(STARVED_ROUND_MS).toBeGreaterThan(HEALTHY_POLL_MS);
      // pollUntil 的一轮 = setTimeout(0) + 一次 read()，所以 read 的耗时就是这一轮的节拍。
      // 第 2 次读被饿 2036ms，第 3 次读到终值——慢读不能被判成被测链路卡死。
      const clock = new SyntheticClock([1, STARVED_ROUND_MS, 1]);
      const terminalAt = 3;
      const { value, wait } = await pollUntil(
        'E · 读作业记录直到状态落定',
        () => {
          clock.step();
          return { status: clock.round >= terminalAt ? 'done' : 'pending' };
        },
        (v) => v.status === 'done',
        { ...NO_TIMER_CHAIN, now: clock.now },
      );
      expect(value.status).toBe('done');
      expect(wait.starveMs).toBe(clock.starvedMs());
      expect(wait.starveMs).toBe(clock.gaps[1] - HEALTHY_POLL_MS); // 只扣第 2 次读那笔，末轮不计
      expect(wait.starveMs).toBeGreaterThan(0);

      // 差分：旧判据（纯墙钟 elapsed / now − lastProgressAt）在第 2 轮末就同时越过 floor 与 idle → 抛
      const wallIdleAtRound2 = clock.gaps[0] + clock.gaps[1];
      expect(wallIdleAtRound2).toBeGreaterThan(NO_TIMER_CHAIN.floorMs);
      expect(wallIdleAtRound2).toBeGreaterThan(NO_TIMER_CHAIN.idleMs);
      expect(wallIdleAtRound2 - wait.starveMs).toBeLessThan(NO_TIMER_CHAIN.idleMs);
      // 签名：本例不传 progress，走 helper 的默认 `String(last)`。对象读值的默认签名恒为
      // '[object Object]'（不会因 pending/done 而变），所以这条样本量的是「全程无进展」的最坏形状——
      // 若哪天把默认改成 JSON.stringify，本例的 lastProgressAt 仍成立（欠账扣掉后实算离 idle 还远）。
      expect(wait.elapsedMs).toBe(clock.t);
    },
    CASE_TIMEOUT_MS,
  );

  it(
    'F · 每次读都被饿 5000ms 且终点永不到 → pollUntil 照旧判红（欠账不进分子）',
    async () => {
      const clock = new SyntheticClock([HUNGRY_GAP_MS]);
      const run = pollUntil(
        'F · 永远读不到终值的作业',
        () => (clock.step(), { status: 'pending' }),
        (v: { status: string }) => v.status === 'done',
        { ...TEETH, progress: () => 'status=pending', now: clock.now },
      );
      const err = await failureOf(run);
      expect(err).toBeInstanceOf(Error);
      expect(err.message).toMatch(/无进展实算|硬上限/);
      const { starve, ours } = reportedMs(err.message);
      expect(clock.round).toBe(TRIP_ROUND);
      expect(ours).toBe(TRIP_ROUND * HEALTHY_POLL_MS);
      expect(starve).toBe(TRIP_ROUND * (HUNGRY_GAP_MS - HEALTHY_POLL_MS));
      expect(starve).toBeGreaterThan(ours); // 虚耗不进预算，但仍被取证为调度器欠账
      // 判红信息必须把最后一次读到的值带出来——pollUntil 的证据面就是这个值，去掉它等于退回盲判
      expect(err.message).toContain('"status":"pending"');
    },
    CASE_TIMEOUT_MS,
  );
});

describe('T04473 · 合成时钟只能出现在本单测里（不许拿它给生产链路放水）', () => {
  it('除本文件外，没有任何调用点向 waitForProgress / pollUntil 注入 now', () => {
    const offenders = readdirSync(TEST_DIR)
      .filter((f) => f.endsWith('.test.ts') && f !== SELF)
      .filter((f) => {
        const src = readFileSync(path.join(TEST_DIR, f), 'utf8');
        const callsWait = /waitForProgress\(/.test(src) || /pollUntil[<(]/.test(src);
        return callsWait && /(?:^|[,{\s])now\s*:/.test(src);
      });
    expect(offenders, `这些文件注入了合成时钟：${offenders.join(', ')}`).toEqual([]);
  });

  it('判据口径锁：两条循环都按「墙钟 − 欠账」实算，且没有顺手放大契约数', () => {
    const src = HELPER_SRC();
    expect(src).toContain('export const HEALTHY_POLL_MS');
    // waitForProgress 与 pollUntil 各一份记账——只有一条循环带欠账，就是本单没做完
    expect(src.match(/const ours = elapsed - starveMs;/g) ?? []).toHaveLength(2);
    expect(src.match(/if \(ours > capMs\)/g) ?? []).toHaveLength(2);
    expect(src.match(/options\.now \?\? Date\.now/g) ?? []).toHaveLength(2);
    expect(src.match(/starveAtProgress = starveMs;/g) ?? []).toHaveLength(2);
    // 契约预算一个数字都没动：T04473 的修法是记账，不是放宽
    expect(src).toContain('NO_TIMER_CHAIN = { floorMs: 1_000, idleMs: 2_000, capMs: 3_000 }');
    // 只允许一份主循环：不得在本 helper 里长出第三套等待
    expect(src.match(/for \(;;\)/g) ?? []).toHaveLength(1);
  });
});

describe('T04514 · 阈值必须是实测派生：数与来源成对，改一个不改另一个就是放水', () => {
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
    expect(n).toBeGreaterThanOrEqual(2 * Number(p95?.[1]));
    // 上界锁的方向随实测剖面而定（T04514 实测结论，不是照搬前端）：
    // 前端双峰——P99 贴近「被偷总体」，故锁 n < P99，越过正常总体就记欠账；
    // 本侧 singleFork 单进程实测单峰紧致（P99=16 仍是正常总体尾部，max=18，476 轮 0 轮 >25ms），
    // 没有独立的被偷总体，故锁 n > P99：阈值必须高于整个正常总体，正常节拍永不被冤枉成欠账。
    // 「被偷总体仍算欠账」这一侧由下面 n < 现场样本(2036ms) 单独盯住。两条共同守住「阈值分开正常与被偷」。
    expect(n, `阈值 ${n} 未高于实测正常总体尾部 P99=${p99?.[1]}，会把正常节拍冤枉成欠账`).toBeGreaterThan(Number(p99?.[1]));
    expect(n, `阈值 ${n} 已不小于 T04461 的现场样本 ${STARVED_ROUND_MS}ms，偶发红会回归`).toBeLessThan(STARVED_ROUND_MS);
    expect(src).not.toContain('本侧未实测');
    expect(src).not.toContain('暂存 25ms');
    expect(src).not.toContain('亚毫秒级');
  });
});

describe('T04514 · 取证出口：默认不写盘，写盘不落在被测节拍里', () => {
  it('落盘只有一处真正的写调用，且默认被环境变量短路', () => {
    const src = HELPER_SRC();
    expect(src).toContain('const POLL_SAMPLE_DUMP = process.env.T04471_POLL_DUMP');
    expect(src).toContain('if (!POLL_SAMPLE_DUMP) return;');
    expect(src.match(/appendFileSync\(POLL_SAMPLE_DUMP/g) ?? []).toHaveLength(1);
  });

  it('两个轮询循环体内都没有任何写盘：I/O 耗时一旦进循环，分布测的就是自己', () => {
    const src = HELPER_SRC();
    const waitStart = src.indexOf('for (;;)');
    const pollStart = src.indexOf('while (!predicate(last))');
    const end = src.indexOf('契约派生的定时等待');
    expect(waitStart).toBeGreaterThanOrEqual(0);
    expect(pollStart).toBeGreaterThan(waitStart);
    expect(end, '找不到 pollUntil 之后的边界锚点，本锁的扫描面无法确定').toBeGreaterThan(pollStart);
    expect(src.slice(waitStart, pollStart)).not.toContain('appendFileSync');
    expect(src.slice(pollStart, end)).not.toContain('appendFileSync');
  });

  it('两个出口共六个收口各落一次样本，且都带合成时钟标记与逐轮 gaps', () => {
    const src = HELPER_SRC();
    expect(src.match(/synthetic: isSynthetic, gaps/g) ?? []).toHaveLength(6);
    expect(src.match(/const isSynthetic = options\.now !== undefined;/g) ?? []).toHaveLength(2);
    expect(src.match(/const gaps: number\[\] = \[\];/g) ?? []).toHaveLength(2);
    expect(src.match(/gaps\.push\(gap\);/g) ?? []).toHaveLength(2);
    expect(src.match(/if \(POLL_SAMPLE_DUMP\) gaps\.push\(at - prevRoundAt\);/g) ?? []).toHaveLength(2);
  });

  it('采样开关没被写进 vitest 配置（常驻打开会把一次性取证变成默认行为）', () => {
    const cfg = readFileSync(path.join(TEST_DIR, '..', 'vitest.config.ts'), 'utf8');
    expect(cfg).not.toContain('T04471_POLL_DUMP');
  });
});
