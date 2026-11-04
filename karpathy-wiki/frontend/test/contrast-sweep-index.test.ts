// T04449 口径推广·第五组收口件：全站「裸基色前景」索引锁。
//
// 为什么要这一份：前四组的守护各自钉在自己那几个文件上，接入进度是口口相传的——
// 本组清点全站才发现推广是「只换了青族（--neon-cyan），粉/紫族原地留下」：
// Config 18 / 进度条组件 21 / Query 8 … 合计 163 处、35 个文件仍在裸用基色当文字/描边。
// 没有全站口径的账本，下一组又会只改自己那两页，而「全站已收敛」这句话永远没人能否证。
//
// 本锁断言三件事：
//  ① 白名单（已接入文件）不得出现任何裸基色前景——防退化；
//  ② 白名单外文件逐文件冻结基线处数，新增即红、下降放行——进度只进不退；
//  ③ 账本自证：遍历文件数与基线表键必须落在真实文件上，防止 glob 失配/改名把锁变成空转。
//
// 基线口径 = listBareBaseForegroundUses（逐处计数，不去重）：`.a{color:var(--neon-cyan)}` 与
// `.b{color:var(--neon-cyan)}` 是两个消费点；tint（--accent-*-aNN）与 --*-base 派生不算违规。
// 剩余 163 处的接入清单见 T04470；装饰性 tint 前景是否要一并纳入口径见 T04468（待裁决）。
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { ROOT, findBareBaseForegroundUses, listBareBaseForegroundUses } from './helpers/contrast';

/** 基色 token（不含 -aNN tint 与 -base 派生）：这些裸写进前景即本口径要抓 */
const BASE_TOKENS = [
  /^--neon-cyan$/,
  /^--neon-pink$/,
  /^--accent-pink$/,
  /^--neon-magenta$/,
  /^--neon-purple$/,
  /^--accent-purple$/,
];

/** 已完成接入、必须保持 0 裸用的文件（第一~五组累计 + T04470 批次 A 视图层 + 批次 B 组件层） */
const WHITELIST = [
  'src/views/Browse.vue', // T04449 第四组
  'src/views/Graph.vue', // T04449 第四组
  'src/views/Progress.vue', // T04449 第四组
  'src/views/DataClean.vue', // T04449 第三组
  'src/views/Health.vue', // T04449 第三组
  'src/views/Tunnel.vue', // T04449 第五组
  'src/views/Ingest.vue', // T04449 第五组
  'src/views/Login.vue', // T04470 批次 A1
  'src/views/Register.vue', // T04470 批次 A1
  'src/views/Help.vue', // T04449 首组接入青族 7 处 + T04470 批次 A2 补 5 处
  'src/views/About.vue', // T04470 批次 A2
  'src/views/Dashboard.vue', // T04470 批次 A3
  'src/views/Users.vue', // T04470 批次 A3
  'src/views/Query.vue', // T04470 批次 A4（8 处裸基色；另回补 1 处 T04175 遗留的错族，不在本账内）
  'src/views/Cleanup.vue', // T04470 批次 A5（9 处粉/紫族；首组已接入的 7 处青族不在此账内）
  'src/views/Config.vue', // T04470 批次 A6（18 处粉/紫族，批次 A 视图层收尾；首组已接入的 28 处青族不在此账内）
  'src/components/BatchProgressBar.vue', // T04470 批次 B1
  'src/components/SingleFileProgressBar.vue', // T04470 批次 B1
  'src/components/MarkdownRenderer.vue', // T04470 批次 B1
  'src/components/RefsList.vue', // T04470 批次 B1
  'src/components/HealthIssueList.vue', // T04470 批次 B2
  'src/components/ConversationSidebar.vue', // T04470 批次 B2
  'src/components/DocumentTabs.vue', // T04470 批次 B2
  'src/components/ModelSelector.vue', // T04470 批次 B2
  'src/components/ClarifyCard.vue', // T04470 批次 B2
  'src/components/InputToolbar.vue', // T04470 批次 B2
  'src/components/SessionStatusIcon.vue', // T04470 批次 B2
  'src/components/TocTree.vue', // T04470 批次 B2
  'src/components/TtsController.vue', // T04470 批次 B2
  // ↓ 批次 C：长尾 13 个组件 21 处（每文件 1~2 处，散在 hover/focus/deep 选择器里）
  'src/components/AttachmentUploader.vue', // T04470 批次 C
  'src/components/CitationModal.vue', // T04470 批次 C
  'src/components/CitationText.vue', // T04470 批次 C
  'src/components/ContextUsageBadge.vue', // T04470 批次 C
  'src/components/FloatingChat.vue', // T04470 批次 C
  'src/components/FollowupsChips.vue', // T04470 批次 C
  'src/components/GuideButton.vue', // T04470 批次 C
  'src/components/GuideOverlay.vue', // T04470 批次 C
  'src/components/MessageActions.vue', // T04470 批次 C
  'src/components/MessageToolbar.vue', // T04470 批次 C
  'src/components/MultimodalOutputCard.vue', // T04470 批次 C
  'src/components/ThemeSwitcher.vue', // T04470 批次 C
  'src/components/ThinkingBlock.vue', // T04470 批次 C
];

/**
 * 从 BASELINE 移入 WHITELIST 的文件，登记它们**起算时**的处数（不是接入后的，接入后是 0）。
 * 账本不变式：BASELINE + DONE 合计恒等于起算 163 处 / 35 个文件——
 * 一个文件不能既离开基线表、又没在这里被记回数，否则「还剩多少」会凭空变小。
 */
const WIRING_DONE: Record<string, number> = {
  'src/views/Login.vue': 5, // T04470 批次 A1
  'src/views/Register.vue': 4, // T04470 批次 A1
  'src/views/Help.vue': 5, // T04470 批次 A2（首组已接入的 7 处青族不在此账内，那时它还没进基线表）
  'src/views/About.vue': 7, // T04470 批次 A2
  'src/views/Dashboard.vue': 6, // T04470 批次 A3
  'src/views/Users.vue': 6, // T04470 批次 A3
  'src/views/Query.vue': 8, // T04470 批次 A4
  'src/views/Cleanup.vue': 9, // T04470 批次 A5（基线冻结在首组之后，表里的 9 处就是首组青族 7 处之外的粉/紫族余量）
  'src/views/Config.vue': 18, // T04470 批次 A6（同上：首组接入的青族不在基线表里，这 18 处是冻结时点剩下的粉/紫族）
  // ↓ 批次 B：组件层 13 个文件 74 处。其中 10 处是状态点的「非文本前景」——那里 color 只喂
  //   box-shadow:0 0 8px currentColor 的光晕，不是可读文字。这 10 处按口径把光晕色改成显式的
  //   --dot-glow（值仍是原基色），既归零裸基色前景、又不改变观感；其余 64 处走 readable 包裹。
  'src/components/BatchProgressBar.vue': 11, // T04470 批次 B1（含 5 处状态点）
  'src/components/SingleFileProgressBar.vue': 10, // T04470 批次 B1（含 5 处状态点）
  'src/components/MarkdownRenderer.vue': 9, // T04470 批次 B1
  'src/components/RefsList.vue': 7, // T04470 批次 B1
  'src/components/HealthIssueList.vue': 6, // T04470 批次 B2
  'src/components/ConversationSidebar.vue': 5, // T04470 批次 B2
  'src/components/DocumentTabs.vue': 5, // T04470 批次 B2
  'src/components/ModelSelector.vue': 5, // T04470 批次 B2
  'src/components/ClarifyCard.vue': 4, // T04470 批次 B2
  'src/components/InputToolbar.vue': 3, // T04470 批次 B2
  'src/components/SessionStatusIcon.vue': 3, // T04470 批次 B2（三层嵌套：readable 插在内层，外层 --m-* 皮肤变量优先级不动）
  'src/components/TocTree.vue': 3, // T04470 批次 B2
  'src/components/TtsController.vue': 3, // T04470 批次 B2
  // ↓ 批次 C：长尾 13 个文件 21 处，全部走 readable 包裹（本批无状态点光晕惯用法）。
  //   其中 2 处（FloatingChat L942 / MessageToolbar L587）接完后在部分浅底主题上仍差 AA 一线
  //   ——三个 readable 族在该面上的最低值都到不了 4.5，属「面取值」问题不是「族」问题，
  //   实测值与换族反证锁在 contrast-sweep-components-c.test.ts 的 KNOWN_GAPS，已建派生单裁决。
  'src/components/AttachmentUploader.vue': 2, // T04470 批次 C
  'src/components/CitationModal.vue': 1, // T04470 批次 C
  'src/components/CitationText.vue': 2, // T04470 批次 C
  'src/components/ContextUsageBadge.vue': 1, // T04470 批次 C
  'src/components/FloatingChat.vue': 2, // T04470 批次 C（含 1 处跨家族按面选族；另 1 处为已登记残差）
  'src/components/FollowupsChips.vue': 2, // T04470 批次 C
  'src/components/GuideButton.vue': 2, // T04470 批次 C
  'src/components/GuideOverlay.vue': 2, // T04470 批次 C
  'src/components/MessageActions.vue': 2, // T04470 批次 C
  'src/components/MessageToolbar.vue': 1, // T04470 批次 C（已登记残差）
  'src/components/MultimodalOutputCard.vue': 1, // T04470 批次 C
  'src/components/ThemeSwitcher.vue': 1, // T04470 批次 C
  'src/components/ThinkingBlock.vue': 2, // T04470 批次 C
};

/**
 * 未接入文件的基线（处数），冻结于 T04449 第五组收口时点：163 处 / 35 个文件。
 * 只允许下降——接入一处就把它调小，新增一处即红。接入完的文件请从这里移出并进 WHITELIST+DONE。
 *
 * T04470 批次 C 起本表为空：起算的 35 个文件 163 处已全部迁入 WHITELIST+WIRING_DONE。
 * 空表不是「锁失效」——下方「白名单外只降不升」用 `BASELINE[f] ?? 0` 取预算，
 * 于是它对**全站视图+组件的每一个非白名单文件**要求 0 处：任何一个 .vue 新写一处裸基色前景即红。
 * 账本闭环用例继续钉住 163/35 这个起算点，防止有人靠删 DONE 条目把「已完成」抹小。
 */
const BASELINE: Record<string, number> = {};

/** 起算账本（T04449 第五组收口时点的全站清点），不得随进度改动 */
const START_TOTAL = 163;
const START_FILES = 35;

function walk(dir: string, acc: string[]): string[] {
  for (const e of readdirSync(dir, { withFileTypes: true })) {
    const p = join(dir, e.name);
    if (e.isDirectory()) walk(p, acc);
    else if (e.name.endsWith('.vue')) acc.push(p);
  }
  return acc;
}

/** 全站视图 + 组件（口径覆盖范围；不含 src/styles，那里是 token 定义层，不是消费层） */
const SCANNED: string[] = [...walk(join(ROOT, 'src/views'), []), ...walk(join(ROOT, 'src/components'), [])]
  .map((p) => p.slice(ROOT.length + 1).replace(/\\/g, '/'))
  .sort();

const hitsOf = (rel: string) => listBareBaseForegroundUses(readFileSync(join(ROOT, rel), 'utf8'), { baseTokens: BASE_TOKENS });

describe('T04449 全站索引锁：账本自证', () => {
  it('遍历确实覆盖到视图与组件（防止 glob 失配把锁变成空转）', () => {
    expect(SCANNED.length).toBeGreaterThanOrEqual(63);
    expect(SCANNED.filter((f) => f.startsWith('src/views/')).length).toBeGreaterThanOrEqual(15);
    expect(SCANNED.filter((f) => f.startsWith('src/components/')).length).toBeGreaterThanOrEqual(30);
  });

  it('白名单与基线表里的路径都必须是真实存在的文件（改名会静默丢掉预算）', () => {
    const missing = [...WHITELIST, ...Object.keys(BASELINE), ...Object.keys(WIRING_DONE)].filter(
      (f) => !SCANNED.includes(f) || !existsSync(join(ROOT, f)),
    );
    expect(missing, `以下路径已不在遍历结果/磁盘上：${missing.join(', ')}`).toEqual([]);
  });

  it('已完成登记表与基线表互斥、且已完成的文件确实在白名单里（防止双重登记或偷偷移出白名单）', () => {
    const inBoth = Object.keys(WIRING_DONE).filter((f) => f in BASELINE);
    expect(inBoth, `同时出现在 DONE 与 BASELINE：${inBoth.join(', ')}`).toEqual([]);
    const notWhitelisted = Object.keys(WIRING_DONE).filter((f) => !WHITELIST.includes(f));
    expect(notWhitelisted, `DONE 里的文件不在白名单：${notWhitelisted.join(', ')}`).toEqual([]);
  });

  it(`账本闭环：基线剩余 + 已完成登记 = 起算 ${START_TOTAL} 处 / ${START_FILES} 个文件`, () => {
    const sum = (t: Record<string, number>) => Object.values(t).reduce((s, n) => s + n, 0);
    expect(Object.keys(BASELINE).length + Object.keys(WIRING_DONE).length).toBe(START_FILES);
    expect(sum(BASELINE) + sum(WIRING_DONE)).toBe(START_TOTAL);
  });
});

describe('T04449 全站索引锁：白名单不退化', () => {
  for (const f of WHITELIST) {
    it(`${f}：不得出现裸基色前景（基色只能作为 *-readable 的 fallback）`, () => {
      expect(findBareBaseForegroundUses(readFileSync(join(ROOT, f), 'utf8'), { baseTokens: BASE_TOKENS })).toEqual([]);
    });
  }
});

describe('T04449 全站索引锁：白名单外只降不升', () => {
  it('逐文件处数不得超过冻结基线（未登记的文件基线为 0）', () => {
    const over: string[] = [];
    for (const f of SCANNED) {
      if (WHITELIST.includes(f)) continue;
      const allowed = BASELINE[f] ?? 0;
      const now = hitsOf(f).length;
      if (now > allowed) over.push(`${f}：基线 ${allowed} 处，现 ${now} 处（+${now - allowed}）`);
    }
    expect(over, `新增裸基色前景，须接入 readable 口径：\n${over.join('\n')}`).toEqual([]);
  });

  it('全站裸基色前景总数不得超过基线剩余合计', () => {
    const allowed = Object.values(BASELINE).reduce((s, n) => s + n, 0);
    const total = SCANNED.reduce((s, f) => s + (WHITELIST.includes(f) ? 0 : hitsOf(f).length), 0);
    expect(total, `基线剩余 ${allowed} 处，实测 ${total} 处`).toBeLessThanOrEqual(allowed);
  });
});
