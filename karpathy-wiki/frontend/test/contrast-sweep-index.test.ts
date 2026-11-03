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

/** 已完成接入、必须保持 0 裸用的文件（第一~五组累计；本组新增隧道页/导入页） */
const WHITELIST = [
  'src/views/Browse.vue', // T04449 第四组
  'src/views/Graph.vue', // T04449 第四组
  'src/views/Progress.vue', // T04449 第四组
  'src/views/DataClean.vue', // T04449 第三组
  'src/views/Health.vue', // T04449 第三组
  'src/views/Tunnel.vue', // T04449 第五组
  'src/views/Ingest.vue', // T04449 第五组
];

/**
 * 未接入文件的基线（处数），冻结于 T04449 第五组收口时点：163 处 / 35 个文件。
 * 只允许下降——接入一处就把它调小，新增一处即红。接入完的文件请从这里移出并进 WHITELIST。
 */
const BASELINE: Record<string, number> = {
  'src/views/Config.vue': 18,
  'src/components/BatchProgressBar.vue': 11,
  'src/components/SingleFileProgressBar.vue': 10,
  'src/views/Cleanup.vue': 9,
  'src/components/MarkdownRenderer.vue': 9,
  'src/views/Query.vue': 8,
  'src/views/About.vue': 7,
  'src/components/RefsList.vue': 7,
  'src/views/Dashboard.vue': 6,
  'src/views/Users.vue': 6,
  'src/components/HealthIssueList.vue': 6,
  'src/views/Help.vue': 5,
  'src/views/Login.vue': 5,
  'src/components/ConversationSidebar.vue': 5,
  'src/components/DocumentTabs.vue': 5,
  'src/components/ModelSelector.vue': 5,
  'src/views/Register.vue': 4,
  'src/components/ClarifyCard.vue': 4,
  'src/components/InputToolbar.vue': 3,
  'src/components/SessionStatusIcon.vue': 3,
  'src/components/TocTree.vue': 3,
  'src/components/TtsController.vue': 3,
  'src/components/AttachmentUploader.vue': 2,
  'src/components/CitationText.vue': 2,
  'src/components/FloatingChat.vue': 2,
  'src/components/FollowupsChips.vue': 2,
  'src/components/GuideButton.vue': 2,
  'src/components/GuideOverlay.vue': 2,
  'src/components/MessageActions.vue': 2,
  'src/components/ThinkingBlock.vue': 2,
  'src/components/CitationModal.vue': 1,
  'src/components/ContextUsageBadge.vue': 1,
  'src/components/MessageToolbar.vue': 1,
  'src/components/MultimodalOutputCard.vue': 1,
  'src/components/ThemeSwitcher.vue': 1,
};

const BASELINE_TOTAL = 163;

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
    const missing = [...WHITELIST, ...Object.keys(BASELINE)].filter((f) => !SCANNED.includes(f) || !existsSync(join(ROOT, f)));
    expect(missing, `以下路径已不在遍历结果/磁盘上：${missing.join(', ')}`).toEqual([]);
  });

  it('基线表合计与全站账本一致（收口时点为 163 处 / 35 个文件）', () => {
    expect(Object.keys(BASELINE).length).toBe(35);
    expect(Object.values(BASELINE).reduce((s, n) => s + n, 0)).toBe(BASELINE_TOTAL);
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

  it(`全站裸基色前景总数不得超过 ${BASELINE_TOTAL} 处`, () => {
    const total = SCANNED.reduce((s, f) => s + (WHITELIST.includes(f) ? 0 : hitsOf(f).length), 0);
    expect(total).toBeLessThanOrEqual(BASELINE_TOTAL);
  });
});
