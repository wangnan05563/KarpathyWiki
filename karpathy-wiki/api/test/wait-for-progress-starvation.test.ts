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
 * 牙齿用例的「同比例缩小契约」：NO_TIMER_CHAIN ÷ 20（与前端版同一推导）。
 * 判据的形状（欠账不进分子、cap 每轮都判、floor 与 idle 缺一不可）与尺度无关，但真实预算要
 * 81~121 轮真实宏任务才走完——全套并行时被拖到十倍以上就会把本文件变成**新的**偶发红源
 * （本单要消灭的正是这类等待）。所以 A/C/D/F 用 ÷20 的样本；真实数值由 B/E 两腿现场复现，两头都不缺。
 */
const TEETH = {
  floorMs: NO_TIMER_CHAIN.floorMs / 20,
  idleMs: NO_TIMER_CHAIN.idleMs / 20,
  capMs: NO_TIMER_CHAIN.capMs / 20,
} as const;

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

/**
 * 判红时刻的下界（从契约推导，不写经验数）：每轮实算恰好 HEALTHY_POLL_MS，
 * idle 分支要求 `ours > floor` 且 `idleOurs > idle`，两者同步增长 → 最早一轮满足的是
 * `floor(idle / HEALTHY_POLL_MS) + 1`（严格大于，所以整除时不能取 ceil）。
 * 这条下界是「归因」的牙齿：判据若退回纯墙钟，被饿样本会在第 1 轮就判红，
 * 而取证字段本身仍打印得出合规的数——只看数字看不出退化，只看上界也看不出退化。
 */
const earliestIdleTripRound = Math.floor(TEETH.idleMs / HEALTHY_POLL_MS) + 1;

describe('T04473 · waitForProgress 判据：欠账扣得掉，牙齿不能一起磨掉', () => {
  it(
    'A · 节拍健康且签名不变时，仍在契约预算判红，没有因为改造而被放宽',
    async () => {
      const clock = new SyntheticClock([HEALTHY_POLL_MS]); // 每轮恰好贴着健康上限：欠账恒为 0
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
      /**
       * 判红必须落在 floor+idle 这一拍：每轮实算 HEALTHY_POLL_MS，
       * 上界用同一口径推导（+2 轮余量），不写经验数。
       */
      const firstTrippingRound = Math.ceil((TEETH.floorMs + TEETH.idleMs) / HEALTHY_POLL_MS);
      expect(clock.round).toBeLessThanOrEqual(firstTrippingRound + 2);
      expect(clock.round).toBeGreaterThanOrEqual(earliestIdleTripRound);
      expect(ours).toBeGreaterThan(TEETH.idleMs); // 确实在预算到点时判红，而不是提前也不是靠 cap
      expect(clock.starvedMs()).toBe(0);
    },
    CASE_TIMEOUT_MS,
  );

  it(
    'B · 复刻被饿 2036ms 的节拍：新判据放行，旧墙钟判据按样本量出来必红',
    async () => {
      // 现场样本形态：轮 1 亚毫秒、轮 2 之间被饿 2036ms（这两轮签名毫无变化），轮 3 终点落进状态。
      const clock = new SyntheticClock([1, 2_036, 1]);
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
      const clock = new SyntheticClock([5_000]);
      const wait = waitForProgress('C · 被机器拖死但也永远不出现的状态', () => (clock.step(), false), {
        ...TEETH,
        progress: () => 'status=pending',
        now: clock.now,
      });
      const err = await failureOf(wait);
      expect(err).toBeInstanceOf(Error);
      expect(err.message).toMatch(/无进展实算|硬上限/);
      const { starve, ours } = reportedMs(err.message);
      // 判红时的实算仍在契约预算内（每轮只算 HEALTHY_POLL_MS），而墙钟虚耗是它的百倍——
      // 这正是「记账而不是放大预算」的证据。
      expect(ours).toBeLessThanOrEqual(TEETH.idleMs + HEALTHY_POLL_MS);
      expect(starve).toBeGreaterThan(ours * 100);
      const firstTrippingRound = Math.ceil((TEETH.floorMs + TEETH.idleMs) / HEALTHY_POLL_MS);
      expect(clock.round).toBeLessThanOrEqual(firstTrippingRound + 2);
      expect(clock.round).toBeGreaterThanOrEqual(earliestIdleTripRound);
      expect(err.message).toContain('轮询');
    },
    CASE_TIMEOUT_MS,
  );

  it(
    'D · 签名一直在动但终点不到时，由硬上限判红（旧实现挂在 else if 上，永远不会红）',
    async () => {
      const clock = new SyntheticClock([HEALTHY_POLL_MS]);
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
      // 上限按 capMs 推：每轮实算 HEALTHY_POLL_MS，第 ceil(cap/HEALTHY_POLL)+1 轮起必判（签名变化不影响）
      expect(clock.round).toBeLessThanOrEqual(Math.ceil(TEETH.capMs / HEALTHY_POLL_MS) + 2);
      expect(clock.round).toBeGreaterThanOrEqual(Math.floor(TEETH.capMs / HEALTHY_POLL_MS) + 1);
      expect(churn).toBeGreaterThan(1); // 确实一直在「有进展」，旧判据会一直跳过 cap
    },
    CASE_TIMEOUT_MS,
  );
});

describe('T04473 · pollUntil 必须同口径（api 专有的一条循环，漏它等于只修半边）', () => {
  it(
    'E · 慢读落在非最后一轮：欠账被扣掉、用例放行；同一样本按旧墙钟判据必红',
    async () => {
      // pollUntil 的一轮 = setTimeout(0) + 一次 read()，所以 read 的耗时就是这一轮的节拍。
      // 第 2 次读被饿 2036ms，第 3 次读到终值——慢读不能被判成被测链路卡死。
      const clock = new SyntheticClock([1, 2_036, 1]);
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
      const clock = new SyntheticClock([5_000]);
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
      expect(ours).toBeLessThanOrEqual(TEETH.idleMs + HEALTHY_POLL_MS);
      expect(starve).toBeGreaterThan(ours * 100);
      expect(clock.round).toBeGreaterThanOrEqual(earliestIdleTripRound); // 判红时刻同样不许退到墙钟
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
    const src = readFileSync(path.join(TEST_DIR, 'helpers', 'waitForProgress.ts'), 'utf8');
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
