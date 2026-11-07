// T04458：搜索关键词路必须与问答降级链共用同一份中文取词（裁决：必须共用取词）。
// ------------------------------------------------------------------
// 缺陷本体（逐行读源码核对，非推测）：
//   `extractSearchKeywords`（utils/query-keywords.ts：拉丁词 + 中文 2-gram）只在
//   query-workflow.ts:892 的降级检索调用点被用到。三个真正的检索出口都还是
//   「keywords.toLowerCase().split(/\s+/)」：
//     A search-util.ts:166      searchPages（legacy 全库扫描；/api/search 索引不可用时的降级）
//     B indexed-search.ts:219   searchPagesIndexed（/api/search 的主路径）
//     C sqlite-index.ts:207     keywordRecall（B 与 hybridSearch 共用的召回层）
//   中文没有空格 ⇒ 整句成为**一个**词项：
//     A/B 的 includes 要求正文逐字含整句 → 0 命中；
//     C 走 trigram FTS5 的短语 MATCH `"知识库的价值体现在哪里"` → 同样要求整串子串 → 0 行。
//   用户可见症状：搜索框输入一整句中文（例如「知识库的价值体现在哪里」）永远空结果，
//   而同一句话在问答里能召回到页面——两个出口对「同一个查询」给出相反结论。
//
// 第二个分叉在 C 内部：短词（<3 字符）降级 LIKE 时用 `AND` 连接前 3 个词
// （sqlite-index.ts:210-217），而 FTS MATCH 分支用 `OR`（:219）。取词一旦共用，
// 中文查询必然产出 2-gram（全部 <3 字符）⇒ 全部落进 AND 分支：
// 「知识 价值」要求同一个 chunk 同时含两词，页面把两个概念写在相邻两节就召回不到。
// 同一个查询在「索引可用/不可用」两种形态下召回语义不同，正是本单要收掉的第二处口径分叉。
// LIKE 分支还必须逐词取候选再轮转合并：单条 OR + LIMIT 会按 rowid 先到先得，
// 高频词的前 N 个 chunk 会把低频词的页面整个挤出候选集（R10 就是钉这一条）。
//
// 负控制（改前改后都必须绿，证明红不是夹具坏了）：
//   R6 符号类查询（C++）抽不出词 → 必须回退原文按空白切词，不许退化成「无需检索」；
//   R9 纯过滤/范围限定（无关键词）走列出分支，不受取词影响（T04455 口径）。
import { afterAll, afterEach, beforeEach, describe, expect, it } from 'vitest';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';

import { VaultService } from '../src/vault/vault-service.js';
import { searchPages } from '../src/search-util.js';
import { closeIndexDb, keywordRecall, replacePageChunks } from '../src/search/sqlite-index.js';
import { searchPagesIndexed, ensureIndexSynced } from '../src/search/indexed-search.js';
import { hybridSearch } from '../src/search/hybrid-search.js';
import { extractSearchKeywords, toSearchTerms } from '../src/utils/query-keywords.js';

// 本单主诉问句：中文无空格，改造前在三个出口都是一个整句词项
const SENTENCE = '知识库的价值体现在哪里';
// 与 SENTENCE 对应的 2-gram（去虚词后）：知识 / 识库 / 价值 / 值体 / 体现
const TARGET_PAGE = 'concepts/kb-value.md';
const OTHER_PAGE = 'concepts/graph-render.md';

const KB_BODY = [
  '---',
  'title: 知识库的价值',
  'tags:',
  '  - 检索',
  '---',
  '',
  '知识库的价值在于把零散笔记连成可检索的网络。',
  '知识的沉淀让检索不再依赖记忆，价值随连接数增长。',
  '',
].join('\n');

const OTHER_BODY = [
  '---',
  'title: 图谱渲染',
  'tags:',
  '  - 渲染',
  '---',
  '',
  '图谱渲染方案与主题配色无关知识沉淀。',
  '',
].join('\n');

let tempDir = '';
let vaultDir = '';
let dataDir = '';
let vault: VaultService;

async function writePage(rel: string, body: string): Promise<void> {
  const abs = path.join(vaultDir, rel);
  await fs.mkdir(path.dirname(abs), { recursive: true });
  await fs.writeFile(abs, body, 'utf8');
}

async function seedVault(): Promise<void> {
  await writePage(TARGET_PAGE, KB_BODY);
  await writePage(OTHER_PAGE, OTHER_BODY);
  vault = new VaultService(vaultDir);
  await vault.init();
  // 节流状态是 indexed-search 的模块级变量，夹具走 fs.writeFile 不动写版本号 ⇒ 必须 force
  await ensureIndexSynced(dataDir, vault, true);
}

beforeEach(async () => {
  tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'kb-t04458-'));
  vaultDir = path.join(tempDir, 'vault');
  dataDir = path.join(tempDir, 'data');
  await fs.mkdir(vaultDir, { recursive: true });
  await fs.mkdir(dataDir, { recursive: true });
});

afterEach(async () => {
  closeIndexDb(); // 不关连接时 Windows 会锁住 db 文件，rm 直接 EBUSY
  await fs.rm(tempDir, { recursive: true, force: true });
});

afterAll(() => {
  closeIndexDb();
});

function pathsOf(hits: Array<{ path: string }>): string[] {
  return hits.map((h) => h.path);
}

describe('A · 整句中文在三个检索出口都必须有召回（改造前全部 0 命中）', () => {
  it('R1 searchPages（legacy 全库扫描）：整句中文召回到目标页', async () => {
    await seedVault();
    const hits = await searchPages(vault, SENTENCE, 20);
    expect(pathsOf(hits), '搜索框输入整句中文 0 命中：取词没接进 legacy 扫描').toContain(TARGET_PAGE);
  });

  it('R2 searchPagesIndexed（/api/search 主路径）：整句中文召回到目标页', async () => {
    await seedVault();
    const hits = await searchPagesIndexed(dataDir, vault, SENTENCE, 20);
    expect(hits, '索引路径返回 null 表示不可用，本腿要求它真的完成检索').not.toBeNull();
    expect(pathsOf(hits ?? []), 'FTS5 短语 MATCH 要求正文含整句 ⇒ 索引路径同样 0 命中').toContain(TARGET_PAGE);
  });

  it('R3 keywordRecall（B 与 hybrid 共用召回层）：整句中文至少召回一行 chunk', async () => {
    replacePageChunks(dataDir, TARGET_PAGE, [{ content: KB_BODY, heading: null }]);
    const rows = keywordRecall(dataDir, SENTENCE, 20);
    expect(rows.length, '召回层把整句当一个 trigram 短语查询 ⇒ 0 行').toBeGreaterThan(0);
    expect(rows.some((r) => r.pagePath === TARGET_PAGE)).toBe(true);
  });
});

describe('B · LIKE 降级分支的召回语义必须与 FTS MATCH 分支同口径（OR，不是 AND）', () => {
  it('R4 两个 2-gram 分处不同 chunk：两页都要召回（AND 口径下为 0 行）', () => {
    replacePageChunks(dataDir, 'concepts/a.md', [{ content: '知识需要沉淀成网络。', heading: null }]);
    replacePageChunks(dataDir, 'concepts/b.md', [{ content: '价值来自可检索的连接。', heading: null }]);
    const pages = new Set(keywordRecall(dataDir, '知识 价值', 20).map((r) => r.pagePath));
    expect([...pages].sort(), '短词 LIKE 分支用 AND 连接 ⇒ 概念分处两节就召回不到').toEqual([
      'concepts/a.md',
      'concepts/b.md',
    ]);
  });

  it('R10 逐词取候选再轮转：高频词的前 N 个 chunk 不许把低频词的页面挤出候选集', () => {
    // 先写 12 个只含「知识」的 chunk（rowid 在前），再写 1 个只含「价值」的页面
    for (let i = 0; i < 12; i++) {
      replacePageChunks(dataDir, `concepts/flood-${i}.md`, [{ content: `第 ${i} 段讲知识沉淀。`, heading: null }]);
    }
    replacePageChunks(dataDir, 'concepts/rare.md', [{ content: '这一段只谈价值。', heading: null }]);
    const pages = new Set(keywordRecall(dataDir, '知识 价值', 2).map((r) => r.pagePath));
    expect(pages.has('concepts/rare.md'), '单条 OR + LIMIT 按 rowid 先到先得 ⇒ 低频词页面被挤掉').toBe(true);
    expect(pages.size, 'limit=2 时候选应来自两个不同的词').toBe(2);
  });
});

describe('C · 共用取词后的口径一致性与不漂移', () => {
  it('R5 同一句中文：legacy 与索引路径给出同一份命中页面与同一排序', async () => {
    await seedVault();
    const legacy = await searchPages(vault, SENTENCE, 20);
    const indexed = await searchPagesIndexed(dataDir, vault, SENTENCE, 20);
    expect(pathsOf(legacy).length, '先证明不是「两边都空」的空断言').toBeGreaterThan(0);
    expect(pathsOf(indexed ?? []), '两个出口对同一查询给出不同召回集').toEqual(pathsOf(legacy));
  });

  it('R7 预抽词后再传入 == 直接传整句：问答降级链的既有调用点不许因共用取词而漂移', async () => {
    await seedVault();
    const pre = extractSearchKeywords(SENTENCE);
    expect(pre.length, '夹具问句必须能抽出词，否则本腿退化成空串比较').toBeGreaterThan(0);
    const viaPre = await searchPages(vault, pre, 20);
    const viaRaw = await searchPages(vault, SENTENCE, 20);
    expect(pathsOf(viaRaw).length).toBeGreaterThan(0);
    expect(pathsOf(viaPre), 'query-workflow.ts:892 先抽词再搜，共用取词后两次抽取必须同结论').toEqual(pathsOf(viaRaw));
  });

  it('R8 中文查询的 snippet 必须锚在抽出的词上，且非空', async () => {
    await seedVault();
    const hits = await searchPages(vault, SENTENCE, 20);
    const hit = hits.find((h) => h.path === TARGET_PAGE);
    expect(hit, '目标页必须被召回').toBeDefined();
    const grams = extractSearchKeywords(SENTENCE).split(' ').filter(Boolean);
    expect(grams.length).toBeGreaterThan(0);
    expect(hit!.snippet.length, 'snippet 不许为空').toBeGreaterThan(0);
    expect(grams.some((g) => hit!.snippet.includes(g)), 'snippet 锚点应落在查询词附近').toBe(true);
    expect(hit!.hits, '命中数按抽出的词计，整句口径下只会是 0/1').toBeGreaterThan(1);
  });

  it('R11 hybridSearch 关键词路（无 BYOK embedding）：整句中文同样必须召回', async () => {
    await seedVault();
    // 不传 embedding ⇒ 只有关键词路生效、无网络调用（不消耗任何配额）
    const result = await hybridSearch(dataDir, vault, { query: SENTENCE, limit: 10 });
    expect(result.semanticEnabled, '未配置 embedding 时语义路必须如实关闭').toBe(false);
    expect(pathsOf(result.hits), '搜索页语义模式的关键词路同样把整句当一个词项 ⇒ 空结果').toContain(TARGET_PAGE);
  });

  it('R12 取词幂等：toSearchTerms(toSearchTerms(q).join(" ")) 与一次取词同结论', async () => {
    // indexed-search 把词表 join 后交给 keywordRecall，召回层会再取一次词——
    // 两次结论不同就会出现「召回到的页」与「算分/锚点的词」分叉。符号回退支也要幂等。
    // 60 个互不相同的汉字 → 59 个 2-gram，必须被截到 24：上限是「每词一次全库匹配」的耗时护栏，
    // 只测短句等于没测上限（变异探针 P7 去掉 slice 时这条必须红）。
    const long = Array.from({ length: 60 }, (_, i) => String.fromCharCode(0x4e50 + i)).join('');
    const queries = [SENTENCE, '知识库 价值', 'obsidian 知识库', 'C++', '%o', '_v', '\\t', '%', '量子力学', '', long];
    for (const q of queries) {
      const once = toSearchTerms(q);
      const twice = toSearchTerms(once.join(' '));
      expect(twice, `查询 ${JSON.stringify(q)} 两次取词结论不一致`).toEqual(once);
      expect(once.length, '词表必须受上限约束（每词一次全库匹配）').toBeLessThanOrEqual(24);
    }
    expect(toSearchTerms(long), '长句必须真的触到上限而不是恰好短于它').toHaveLength(24);
  });
});

describe('D · 负控制：改造前后都必须绿（证明红来自缺陷而不是夹具）', () => {
  it('R6 符号类查询抽不出词时回退原文：C++ 仍按字面命中，不许变成「无需检索」', async () => {
    await writePage('concepts/lang.md', '---\ntitle: 语言\n---\n\n正文提到 C++ 与模板。\n');
    vault = new VaultService(vaultDir);
    await vault.init();
    const hits = await searchPages(vault, 'C++', 20);
    expect(pathsOf(hits), '抽不出词就返回空词表 ⇒ 符号查询整类退化为无结果').toContain('concepts/lang.md');
  });

  it('R9 纯范围限定（无关键词）走列出分支，不受取词影响', async () => {
    await seedVault();
    const hits = await searchPages(vault, '', 20, { tags: ['检索'] });
    expect(pathsOf(hits), 'tags 范围限定应列出该标签页面（T04455 口径）').toEqual([TARGET_PAGE]);
  });
});

describe('E · 结构锁：三个出口必须共用同一份取词，不许各自 split', () => {
  const SITES = [
    { label: 'search-util', file: path.resolve(__dirname, '..', 'src', 'search-util.ts') },
    { label: 'indexed-search', file: path.resolve(__dirname, '..', 'src', 'search', 'indexed-search.ts') },
    { label: 'sqlite-index', file: path.resolve(__dirname, '..', 'src', 'search', 'sqlite-index.ts') },
  ];
  const KEYWORDS_TS = path.resolve(__dirname, '..', 'src', 'utils', 'query-keywords.ts');

  // 注释里满是「按空白切词」的历史说明，结构锁只看真实代码：整行注释抹成空格（保留行号）
  function maskComments(src: string): string {
    return src
      .split('\n')
      .map((line) => (/^\s*(\/\/|\*|\/\*)/.test(line) ? '' : line.replace(/\/\/.*$/, '')))
      .join('\n');
  }

  it('G1 三个出口都从 utils/query-keywords.ts 取词（import + 调用），且不再自写空白切词作为取词入口', async () => {
    for (const site of SITES) {
      const body = maskComments(await fs.readFile(site.file, 'utf8'));
      expect(body, `${site.label} 必须 import 取词模块`).toMatch(/from\s+['"][^'"]*query-keywords\.js['"]/);
      expect(body, `${site.label} 必须调用共用取词函数`).toMatch(/toSearchTerms\s*\(/);
      expect(
        /keywords\.toLowerCase\(\)\.split\(|query\.trim\(\)\.split\(/.test(body),
        `${site.label} 仍在自写空白切词作为取词入口`,
      ).toBe(false);
    }
    // 取词模块本体必须真的导出该函数（防止 import 一个不存在的名字也算过）
    const kw = await fs.readFile(KEYWORDS_TS, 'utf8');
    expect(kw).toMatch(/export function toSearchTerms\s*\(/);
  });
});
