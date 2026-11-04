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
import { readdirSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { HEALTHY_POLL_MS, NO_TIMER_CHAIN, waitForProgress } from './helpers/waitForProgress';

const TEST_DIR = __dirname;
/** 扫描面自指排除用文件名常量（守护不留豁免口子，但也不该把自己的合成时钟算成放水） */
const SELF = 'wait-for-progress-starvation.test.ts';

/**
 * 牙齿用例的「同比例缩小契约」：NO_TIMER_CHAIN ÷ 20。
 * 推导来源：判据的形状（欠账不进分子、cap 每轮都判、floor 与 idle 缺一不可）与尺度无关，
 * 但真实预算要 81~121 轮*真实宏任务*才走完，本机实测单条 1.2~1.9s——全套并行时被拖到 10 倍以上
 * 就会把本文件变成**新的**偶发红源（本单要消灭的正是这类等待）。所以 A/C/D 用 ÷20 的样本，
 * 判红轮数落到 5~7 轮（实测单条 <100ms）；真实数值由 B 用例现场复现，两头都不缺。
 */
const TEETH = {
  floorMs: NO_TIMER_CHAIN.floorMs / 20,
  idleMs: NO_TIMER_CHAIN.idleMs / 20,
  capMs: NO_TIMER_CHAIN.capMs / 20,
} as const;

/** 本文件用例的 vitest 超时：判据按合成时钟走，与墙钟无关，唯一开销是 <10 轮宏任务；给 2 倍默认余量 */
const CASE_TIMEOUT_MS = 10_000;

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

describe('T04461 · waitForProgress 判据：欠账扣得掉，牙齿不能一起磨掉', () => {
  it(
    'A · 节拍健康且签名不变时，仍在契约预算判红，没有因为改造而被放宽',
    async () => {
      const clock = new SyntheticClock([HEALTHY_POLL_MS]); // 每轮恰好贴着健康上限：欠账恒为 0
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
      /**
       * 判红必须落在 floor+idle 这一拍：每轮实算 HEALTHY_POLL_MS，
       * 需要 ours > floorMs 且 idleOurs > idleMs → 第 ceil((floor+idle)/HEALTHY_POLL) 轮附近；
       * 上界用同一口径推导（+2 轮余量），不写经验数。
       */
      const firstTrippingRound = Math.ceil((TEETH.floorMs + TEETH.idleMs) / HEALTHY_POLL_MS);
      expect(clock.round).toBeLessThanOrEqual(firstTrippingRound + 2);
      expect(ours).toBeGreaterThan(TEETH.idleMs); // 确实在预算到点时判红，而不是提前也不是靠 cap
      expect(clock.starvedMs()).toBe(0);
    },
    CASE_TIMEOUT_MS,
  );

  it(
    'B · 复刻 T04461 的 2036ms 被饿节拍：新判据放行，旧墙钟判据按样本量出来必红',
    async () => {
      // 实测失败样本：轮 1 亚毫秒、轮 2 之间被饿 2036ms（这两轮签名毫无变化），轮 3 状态行进 DOM。
      const clock = new SyntheticClock([1, 2_036, 1]);
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
      // 新判据看的是实算：第 2 轮末只过了 26ms，离 idleMs 还远
      expect(wallIdleAtRound2 - result.starveMs).toBeLessThan(NO_TIMER_CHAIN.idleMs);
    },
    CASE_TIMEOUT_MS,
  );

  it(
    'C · 每轮被饿 5000ms 也续不了命：终点永不到时照旧判红（欠账不进预算的分子）',
    async () => {
      const clock = new SyntheticClock([5_000]);
      const wait = waitForProgress('C · 被机器拖死但也永远不出现的东西', () => (clock.step(), false), {
        ...TEETH,
        progress: () => 'loadingAi=1',
        now: clock.now,
      });
      const err = await wait.catch((e: unknown) => e as Error);
      expect(err).toBeInstanceOf(Error);
      expect(err.message).toMatch(/无进展实算|硬上限/);
      const { starve, ours } = reportedMs(err.message);
      // 判红时的实算仍在契约预算内（每轮只算 HEALTHY_POLL_MS），而墙钟虚耗是它的百倍——
      // 这正是「记账而不是放大预算」的证据。
      expect(ours).toBeLessThanOrEqual(TEETH.idleMs + HEALTHY_POLL_MS);
      expect(starve).toBeGreaterThan(ours * 100);
      const firstTrippingRound = Math.ceil((TEETH.floorMs + TEETH.idleMs) / HEALTHY_POLL_MS);
      expect(clock.round).toBeLessThanOrEqual(firstTrippingRound + 2);
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
      const err = await wait.catch((e: unknown) => e as Error);
      expect(err).toBeInstanceOf(Error);
      expect(err.message).toContain('硬上限');
      const { starve } = reportedMs(err.message);
      expect(starve).toBe(0);
      // 上限按 capMs 推：每轮实算 HEALTHY_POLL_MS，第 ceil(cap/HEALTHY_POLL)+1 轮起必判（签名变化不影响）
      expect(clock.round).toBeLessThanOrEqual(Math.ceil(TEETH.capMs / HEALTHY_POLL_MS) + 2);
      expect(churn).toBeGreaterThan(1); // 确实一直在「有进展」，旧判据会一直跳过 cap
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
    const src = readFileSync(path.join(TEST_DIR, 'helpers', 'waitForProgress.ts'), 'utf8');
    expect(src).toContain('export const HEALTHY_POLL_MS');
    expect(src).toContain('const ours = elapsed - starveMs;');
    expect(src).toContain('if (ours > capMs)'); // cap 每轮都判，不挂在签名分支上
    expect(src).toContain('options.now ?? Date.now');
    // 契约预算一个数字都没动：T04461 的修法是记账，不是放宽
    expect(src).toContain('export const NO_TIMER_CHAIN = { floorMs: 1_000, idleMs: 2_000, capMs: 3_000 }');
    // 只允许一份实现：不得在本 helper 里长出第二套等待循环
    expect(src.match(/for \(;;\)/g) ?? []).toHaveLength(1);
  });
});
