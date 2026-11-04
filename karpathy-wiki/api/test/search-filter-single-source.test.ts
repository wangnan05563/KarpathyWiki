// T04455：searchPages 的「过滤维度」必须只有一个判定源。
//
// 起因（本单在册缺陷，代码层已确认）：外层提前返回用的判据是
//   const hasFilter = filter?.source || filter?.status || filter?.type;   // 漏 tags，也漏 folder
// 而真正执行过滤的 matchSearchFilter 认 source/status/type/tags 四个维度。两处各写一遍就会漂：
// 调用方只传 tags（AI 伙伴的范围限定正是这个形态，query-workflow.ts:85）且关键词被切空
// （纯符号提问 → terms.length===0）时，外层直接 return []，tags 过滤根本没机会执行——
// 用户看到「没有结果」，真实原因是提前返回。
//
// 五条腿缺一不可：
//   A 复现腿：tags-only 范围限定 + 空关键词 → 必须查出该 tag 下的页（本单修复前恒为空集）；
//   B 同族盲区：folder-only + 空关键词 → 同样必须查出该目录下的页（folder 压根没参与旧 hasFilter，
//     且旧「纯过滤」识别依赖 matchSearchFilter 的 content==='' 约定，folder 维度不过 frontmatter，永远进不了那一支）；
//   C 不许顺手放宽：空关键词 + 无任何限定 → 仍返回空集，绝不把整库倒给调用方；
//     `tags: []`（未配置标签的 AI 伙伴）同样不构成限定——它要读 frontmatter（正文口径），但不缩范围；
//   D 活锁：按 SearchFilter 的每个维度逐个「只设这一维 + 空关键词」跑一遍，
//     并把登记表 satisfies Record<keyof SearchFilter> 绑死——以后加第五个、第六个维度忘了登记，
//     类型门禁当场红，而不是等用户再撞一次「看不见结果」；
//   E 不许顺手改到另一支：本单只动「无关键词」的判定，「有关键词」的检索面（正文，不含 YAML 头）
//     必须与修复前逐字一致——移除 matchSearchFilter 的 content 哨兵最容易静默动摇的正是这一条。
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { VaultService } from '../src/vault/vault-service.js';
import { narrowsToScope, needsFrontmatter, searchPages, type SearchFilter } from '../src/search-util.js';

const SRC_PATH = path.resolve(__dirname, '..', 'src', 'search-util.ts');

let vaultDir: string;
let vault: VaultService;

function writePage(rel: string, body: string): void {
  const abs = path.join(vaultDir, rel);
  mkdirSync(path.dirname(abs), { recursive: true });
  writeFileSync(abs, body, 'utf8');
}

/** 三页夹具：两个 tag 域、两个目录，便于把「命中集合」和「提前返回」区分开 */
function seedVault(): void {
  writePage(
    'entities/alpha.md',
    ['---', 'title: Alpha 页', 'type: entity', 'tags: [ai, partner]', '---', '', 'Alpha 正文：向量检索口径说明。'].join('\n'),
  );
  writePage(
    'concepts/beta.md',
    ['---', 'title: Beta 页', 'type: concept', 'tags: [partner]', '---', '', 'Beta 正文：范围限定与召回。'].join('\n'),
  );
  writePage(
    'concepts/gamma.md',
    ['---', 'title: Gamma 页', 'type: concept', 'tags: [other]', '---', '', 'Gamma 正文：不该被 partner 域召回。'].join('\n'),
  );
}

beforeEach(() => {
  vaultDir = mkdtempSync(path.join(tmpdir(), 'wiki-t04455-'));
  vault = new VaultService(vaultDir);
  seedVault();
});

afterEach(() => {
  rmSync(vaultDir, { recursive: true, force: true });
});

describe('T04455 · 纯范围限定查询（关键词为空）不得被提前返回拦死', () => {
  it('A · 只传 tags 的范围限定 + 关键词被切空：查出该 tag 下的两页，而不是空集', async () => {
    const hits = await searchPages(vault, '', 20, { tags: ['partner'] });
    expect(
      hits.map((h) => h.path).sort(),
      '纯 tags 限定被外层 hasFilter（漏 tags）提前 return [] 拦死——这正是本单在册缺陷',
    ).toEqual(['concepts/beta.md', 'entities/alpha.md']);
    // 命中集合真的由 tag 决定：gamma（tags:[other]）不在其中
    expect(hits.some((h) => h.path.includes('gamma')), 'gamma 不属于 partner 标签域，不该被召回').toBe(false);
  });

  it('B · 只传 folder 的范围限定 + 关键词为空：查出该目录下的页（folder 从未参与旧判据）', async () => {
    const hits = await searchPages(vault, '', 20, { folder: 'concepts' });
    expect(
      hits.map((h) => h.path).sort(),
      'folder-only 查询要能列出该目录：旧「纯过滤」识别依赖 content===“”约定，folder 不过 frontmatter 就进不了那一支',
    ).toEqual(['concepts/beta.md', 'concepts/gamma.md']);
  });

  it('C · 没有任何限定时仍返回空集，且空 tags 数组不算限定（不把整库倒给调用方）', async () => {
    expect(await searchPages(vault, '', 20), '无过滤 + 空关键词必须仍是空集').toEqual([]);
    expect(
      await searchPages(vault, '', 20, { tags: [] }),
      '未配置标签的 AI 伙伴（tags: []）不构成范围限定，绝不能退化成全库倾倒',
    ).toEqual([]);
    expect(
      await searchPages(vault, '   ', 20, { source: '', status: '', type: '', folder: '' }),
      '空串维度同样不算限定',
    ).toEqual([]);
  });

  it('D · 维度登记表与 SearchFilter 同源：每个维度「只设它自己 + 空关键词」都必须能列出范围', async () => {
    // satisfies Record<keyof SearchFilter, ...>：以后给 SearchFilter 加新维度而不在这里登记，
    // 类型门禁当场红（与 T04457 把字段名单绑到 IndexCoverage 同一个手法）。
    const DIMENSIONS = {
      source: { value: 'manual', seeded: (rel: string) => rel, expectPaths: ['entities/alpha.md'] },
      status: { value: 'published', seeded: (rel: string) => rel, expectPaths: ['entities/alpha.md'] },
      type: { value: 'concept', seeded: (rel: string) => rel, expectPaths: ['concepts/beta.md', 'concepts/gamma.md'] },
      folder: { value: 'entities', seeded: (rel: string) => rel, expectPaths: ['entities/alpha.md'] },
      tags: { value: ['partner'], seeded: (rel: string) => rel, expectPaths: ['entities/alpha.md', 'concepts/beta.md'] },
    } as const satisfies Record<keyof SearchFilter, { value: unknown; seeded: (rel: string) => string; expectPaths: string[] }>;

    // 给夹具补上 source/status，使这两个维度可判
    writePage(
      'entities/alpha.md',
      ['---', 'title: Alpha 页', 'type: entity', 'tags: [ai, partner]', 'source: manual', 'status: published', '---', '', 'Alpha 正文。'].join('\n'),
    );
    for (const [dim, cse] of Object.entries(DIMENSIONS)) {
      const filter: SearchFilter = { [dim]: cse.value };
      const hits = await searchPages(vault, '', 20, filter);
      expect(
        hits.map((h) => h.path).sort(),
        `维度「${dim}」单独作为范围限定时被提前返回拦死（外层判据与该维度不同源）`,
      ).toEqual([...cse.expectPaths].sort());
    }
  });

  it('E · 关键词支路的正文口径未被改动（移除 content 哨兵只影响「无关键词」一支）', async () => {
    // 有 + tags：命中集合由「正文含关键词」与「标签域」两者共同决定，gamma 两处都不满足。
    expect(
      (await searchPages(vault, '正文', 20, { tags: ['partner'] })).map((h) => h.path).sort(),
    ).toEqual(['concepts/beta.md', 'entities/alpha.md']);
    // 「检索面 = 正文」这一口径必须与修复前逐字一致：YAML 头里的值不该被关键词命中。
    // 这一条是移除 matchSearchFilter 的 `content: ''` 哨兵后最容易静默改到的地方（哨兵曾兼着「用正文」的副作用）。
    // 关键词特意选 `concept`：它是 gamma 的 frontmatter 值（type: concept），正文里没有这个词。
    // 注意不能选带空格的短语——terms 按空白切分后 ANY 命中即算，'Alpha 页' 会被正文里的 'alpha' 命中。
    expect(
      (await searchPages(vault, 'concept', 20, { tags: ['other'] })).map((h) => h.path),
      '带 frontmatter 维度时关键词只搜正文，YAML 头（type: concept）不参与匹配——修复前后都如此',
    ).toEqual([]);
  });
});

describe('T04455 · 单一判定源本身（防「改回来又漂」）', () => {
  it('两个谓词本身按维度成立：folder 不读 frontmatter 但缩范围，tags:[] 读 frontmatter 但不缩范围', () => {
    expect(needsFrontmatter({ tags: ['partner'] })).toBe(true);
    expect(needsFrontmatter({ folder: 'concepts' }), 'folder 只看路径，不该为它打开 YAML').toBe(false);
    expect(needsFrontmatter(undefined)).toBe(false);
    // 这一条是本单与「顺手放宽」的分界：空 tags 仍要走 frontmatter（正文口径不变），但不算限定
    expect(needsFrontmatter({ tags: [] }), 'tags: [] 仍读 frontmatter，关键词检索的正文来源不许因此改变').toBe(true);
    expect(narrowsToScope({ tags: [] }), 'tags: [] 不缩小任何东西').toBe(false);
    expect(narrowsToScope({ tags: ['partner'] })).toBe(true);
    expect(narrowsToScope({ folder: 'concepts' })).toBe(true);
    expect(narrowsToScope({ source: '', status: '', type: '', folder: '', tags: [] })).toBe(false);
    expect(narrowsToScope(undefined)).toBe(false);
  });

  it('口径锁：searchPages 里不得再各写一遍维度清单', () => {
    const src = readFileSync(SRC_PATH, 'utf8');
    expect(src).toContain('narrowsToScope(filter)'); // 外层提前返回必须走单源谓词
    expect(src).toContain('if (!needsFrontmatter(filter)) return'); // 内层过滤同一份维度枚举
    expect(src, '旧的自写维度清单又回来了（漏一个维度就是一次「看不见结果」）').not.toContain(
      'const hasFilter = filter?.source || filter?.status || filter?.type',
    );
    // 只允许一份维度枚举：presentDimensions 是唯一的 filter?.xxx 采集点
    expect(src.match(/function presentDimensions/g) ?? []).toHaveLength(1);
    expect(src.match(/if \(filter\?\.tags && filter\.tags\.length > 0\)/g) ?? []).toHaveLength(1);
  });
});
