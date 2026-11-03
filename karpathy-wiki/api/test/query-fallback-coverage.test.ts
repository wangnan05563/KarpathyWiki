// T04176：问答兜底文案「知识库未覆盖此问题，或当前问答服务暂不可用。」回归锁
// ------------------------------------------------------------------
// 现场主诉：生产环境新导入的知识内容，用其中的内容提问，气泡回这句兜底。
// 这句话只有一个产地（queryWorkflow 降级链第 3 级），触发条件是「两级降级同时失败」。
// 排查出三个各自独立、但都收敛到同一句文案的成因，本用例逐个锁死：
//   A 取词口径：降级第 2 级把整句中文问题当一个关键词交给 searchPages（按空白切词 + includes），
//     中文没有空格 → 页面正文必须逐字含整句才算命中 → 中文问句必然 0 命中 → 必然 throw。
//     锁「抽词函数」和「真的接到了调用点上」两层，防只写工具函数不接线的假修复。
//   B 连坐：带 source/status/type/tags 任一过滤时每个页面都要过 gray-matter，一页 frontmatter 写坏
//     就从 processSearchFile 抛出去，而 mapWithConcurrency 约定「失败由调用方在 fn 内处理」且调用方
//     没处理 → 整次全库扫描 reject → 问答两级同时失败。锁「坏页跳过、好页照常召回、一次扫描只 warn 一条」。
//   C 归因与文案：改造前两级是 `catch {}`，err 直接丢掉，日志只有 phase；文案把「库里没有」和
//     「服务没通」压成同一句，用户对着可修复的配置故障反复换关键词。锁分类、锁一行截断、锁文案选择，
//     并用不可达 LLM 跑一次真实降级链，验证两句文案各归各位。
// 隔离纪律：vault 落在 os.tmpdir() 随机目录，用后即焚；LLM 一律指向本用例自建的桩服务
// （127.0.0.1 随机端口，任何请求立即 500），不发任何真实请求、不消耗 token、不读真实密钥。
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import matter from 'gray-matter';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import type { HarnessConfig } from '@wiki/harness';
import { VaultService } from '../src/vault/vault-service.js';
import { searchPages } from '../src/search-util.js';
import { createRunStateStore } from '../src/engine/run-state-store.js';
import { extractSearchKeywords } from '../src/utils/query-keywords.js';
import {
  composeFallbackText,
  describeQueryFailure,
  FALLBACK_NO_COVERAGE_TEXT,
  FALLBACK_SERVICE_ERROR_TEXT,
  queryWorkflow,
  type QueryFailure,
} from '../src/workflows/query-workflow.js';
import type { AnswerChunk } from '../src/types.js';

let vaultDir: string;
let stateDir: string;
let vault: VaultService;
// 桩 LLM：任何请求都立即 500。为什么不用不可达端口：ECONNREFUSED 会走 harness 的重试退避，
// 两级降级实测 12 s（用例预算大头全花在等待上）；500 秒回，而且能统计「第 2 级真的走到调用点」的次数。
// 只监听 127.0.0.1 随机端口，密钥是字面量 test-key，绝不指向任何真实 provider。
let llmServer: http.Server;
let llmUrl = '';
let llmRequests = 0;
const createdDirs: string[] = [];

function writePage(rel: string, body: string): void {
  const abs = path.join(vaultDir, rel);
  mkdirSync(path.dirname(abs), { recursive: true });
  writeFileSync(abs, body, 'utf8');
}

beforeAll(async () => {
  llmServer = http.createServer((_req, res) => {
    llmRequests += 1;
    res.writeHead(500, { 'content-type': 'application/json' });
    res.end('{"error":{"message":"stub upstream exploded","type":"server_error"}}');
  });
  await new Promise<void>((resolve) => {
    llmServer.listen(0, '127.0.0.1', () => {
      llmUrl = `http://127.0.0.1:${(llmServer.address() as AddressInfo).port}/v1`;
      resolve();
    });
  });
});

afterAll(async () => {
  await new Promise<void>((resolve) => llmServer.close(() => resolve()));
});

beforeEach(() => {
  llmRequests = 0;
  vaultDir = mkdtempSync(path.join(tmpdir(), 'wiki-t04176-'));
  createdDirs.push(vaultDir);
  stateDir = mkdtempSync(path.join(tmpdir(), 'wiki-t04176-state-'));
  createdDirs.push(stateDir);
  vault = new VaultService(vaultDir);
  // 一篇「新导入」的正常页面：正文含中文，标题是中文文件名常见的拼音/英文
  writePage(
    'entities/llm-wiki.md',
    [
      '---',
      'title: LLM Wiki',
      'type: entity',
      'tags: [ai, wiki]',
      '---',
      '',
      '# LLM Wiki',
      '',
      'Karpathy 提出的 LLM Wiki 理念：知识库的价值体现在复利上，',
      '持续维护的页面会随时间累积收益，而不是一次性问答的消耗品。',
      '',
    ].join('\n'),
  );
});

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
});

afterAll(() => {
  for (const dir of createdDirs) {
    try {
      rmSync(dir, { recursive: true, force: true });
    } catch {
      /* 清理失败不影响结果 */
    }
  }
});

// ===========================================================================
// A. 取词：中文整句必须变成词表，且真的用在降级检索的调用点上
// ===========================================================================
describe('T04176-A 降级检索取词', () => {
  it('整句问题不再作为单一词项，主题 2-gram 进入词表', () => {
    const keywords = extractSearchKeywords('知识库的价值体现在哪里');
    expect(keywords).not.toContain('知识库的价值体现在哪里');
    expect(keywords.split(' ')).toEqual(expect.arrayContaining(['知识', '识库', '价值', '体现']));
  });

  it('中英混排保留拉丁词并小写（searchPages 词序第一项决定 snippet 锚点，拉丁词区分度高）', () => {
    const keywords = extractSearchKeywords('Karpathy 的 wiki 复利');
    expect(keywords.split(' ')).toEqual(expect.arrayContaining(['karpathy', 'wiki']));
  });

  it('纯虚词问句退回全 2-gram 而不是空串（空串会让调用方误判「无需检索」）', () => {
    expect(extractSearchKeywords('这是什么')).not.toBe('');
    expect(extractSearchKeywords('')).toBe('');
  });

  it('词表有上限：每个词都要在全库正文做一次 includes，词数直接决定扫描耗时', () => {
    // 60 个互不相同的汉字 → 59 个互不相同的 2-gram，够触发截断
    const long = Array.from({ length: 60 }, (_, i) => String.fromCharCode(0x4e50 + i)).join('');
    expect(extractSearchKeywords(long).split(' ').length).toBeLessThanOrEqual(24);
    expect(extractSearchKeywords(long, { maxTerms: 3 }).split(' ')).toHaveLength(3);
  });

  it('串联 searchPages：改造前整句 0 命中，抽取后命中新导入页面（修分词不接线=假修复）', async () => {
    const question = '知识库的价值体现在哪里';
    // 旧口径：整句当一个词 → 必然空
    expect(await searchPages(vault, question, 5)).toHaveLength(0);
    // 新口径：抽词后进降级链第 2 级的取数
    const hits = await searchPages(vault, extractSearchKeywords(question), 5);
    expect(hits.map((h) => h.path)).toContain('entities/llm-wiki.md');
  });

  // 「真的接到调用点上」由 D 组端到端锁：取词没接线时第 2 级必然 0 命中，
  // 兜底文案会变成「未覆盖」，D-1 的「暂不可用」断言即刻红——比给 ESM 导出打桩可靠。
});

// ===========================================================================
// B. 单页坏 frontmatter 不得连坐整次全库扫描
// ===========================================================================
describe('T04176-B 坏 frontmatter 不连坐', () => {
  // gray-matter 实测会抛的三种写法（未闭合 flow collection / 重复键 / 值里裸冒号）
  const BROKEN: Array<{ name: string; body: string }> = [
    { name: '未闭合列表', body: '---\ntitle: 坏页\ntags: [a, b\n---\n\n正文：复利。\n' },
    { name: '重复键', body: '---\ntitle: 甲\ntitle: 乙\n---\n\n正文：复利。\n' },
    { name: '值里裸冒号', body: '---\ntitle: 你好: 世界\n---\n\n正文：复利。\n' },
  ];

  // 每个用例用「带唯一标记的字节」，这条纪律是被实测逼出来的：
  // gray-matter 会缓存解析结果，而**失败的解析也会被缓存**——同一串字节第一次 parse 抛异常，
  // 第二次不再抛，直接返回 data:{}（实测见 B 组最后一个用例）。
  // 于是「是否 warn」取决于该字符串在本进程里是否已被 parse 过，用例之间共享 BROKEN 原文时
  // 断言会随执行顺序翻转。注入 seed 行只改字节、不改三种坏法的成因。
  let seed = 0;
  const fresh = (body: string) => body.replace('\n---\n', `\nseed: t04176-${seed++}\n---\n`);

  it.each(BROKEN)('$name：带 tags 过滤的扫描不再整体 reject，好页照常召回', async ({ body }) => {
    const broken = fresh(body);
    writePage('concepts/broken.md', broken);
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const hits = await searchPages(vault, '复利', 5, { tags: ['wiki'] });
    expect(hits.map((h) => h.path)).toContain('entities/llm-wiki.md');
    // 坏页无法证明属于 tags 范围 → 跳过而不是放行
    expect(hits.some((h) => h.path === 'concepts/broken.md')).toBe(false);
    expect(warn.mock.calls.filter((c) => String(c[0]).includes('[search-scan]'))).toHaveLength(1);
    expect(JSON.stringify(warn.mock.calls[0][1])).toContain('concepts/broken.md');
  });

  it('全库都是坏页时返回空而不抛（调用方拿到「无命中」而不是 500）', async () => {
    rmSync(path.join(vaultDir, 'entities'), { recursive: true, force: true });
    writePage('concepts/b1.md', fresh(BROKEN[0].body));
    writePage('concepts/b2.md', fresh(BROKEN[1].body));
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    await expect(searchPages(vault, '复利', 5, { type: 'concept' })).resolves.toEqual([]);
    // 两页坏也只 warn 一条：坏页多时逐页 warn 会把日志刷满，排查要的是「几页 + 哪几页」
    expect(warn.mock.calls.filter((c) => String(c[0]).includes('[search-scan]'))).toHaveLength(1);
    expect(JSON.parse(String(warn.mock.calls[0][1])).total).toBe(2);
  });

  it('同一坏页第二次 parse 不再抛但也不会被误放行（gray-matter 缓存失败结果，长驻进程的真实形态）', () => {
    // 为什么单独锁这条：现场服务是长驻进程，一页坏 YAML 只在该进程「第一次读到它」时抛。
    // 修复前那一次会把整次扫描连坐 reject；后续请求看似恢复正常，其实是缓存把异常吞了，
    // 而坏页以 data:{} 的身份永远匹配不上任何 frontmatter 过滤——两种形态都必须是「跳过」，
    // 不能因为第二次不抛就当成合法页面放进来。
    const broken = fresh(BROKEN[2].body);
    expect(() => matter(broken)).toThrow();
    const second = matter(broken);
    expect(second.data).toEqual({});
  });

  it('无过滤的扫描行为不变（原本就不解析 frontmatter，不能因为本单改动而变慢或变样）', async () => {
    writePage('concepts/broken.md', fresh(BROKEN[0].body));
    const hits = await searchPages(vault, '复利', 5);
    expect(hits.length).toBeGreaterThan(0);
  });
});

// ===========================================================================
// C. 失败归因 + 文案按因分开
// ===========================================================================
describe('T04176-C 降级链归因', () => {
  it('降级链第 2 级的固定消息判为「未覆盖」，不是服务故障', () => {
    expect(describeQueryFailure('fallback', new Error('search fallback: no hits'))).toMatchObject({
      kind: 'no_coverage',
      category: 'no_hits',
    });
    expect(describeQueryFailure('fallback', new Error('search fallback: all page reads failed'))).toMatchObject({
      kind: 'no_coverage',
      category: 'page_read_failed',
    });
  });

  it('LLM 故障判为 service_error 并带上分类', () => {
    const f = describeQueryFailure('harness', new Error('LLM API error 520: cloudflare bad gateway'));
    expect(f.kind).toBe('service_error');
    expect(f.category).toBe('service_down');
  });

  it('多行错误（provider 返回整页 HTML）压成一行并截断，避免日志一条不可读', () => {
    const html = ['HTTP 500 boom', ...Array.from({ length: 200 }, (_, i) => `<p>${i}</p>`)].join('\n');
    const f = describeQueryFailure('harness', new Error(html));
    expect(f.reason).not.toContain('\n');
    expect(f.reason.length).toBeLessThanOrEqual(160);
  });

  it('归因日志不得把 BYOK 密钥顺手写进去（provider 常回显整条请求 URL）', () => {
    const f = describeQueryFailure(
      'harness',
      new Error('request failed: https://api.x.com/v1/chat?api_key=***"Bearer sk-ABCDEFGHIJKLMNOP'),
    );
    expect(f.reason).not.toContain('sk-ABCDEFGHIJKLMNOP');
    expect(f.reason).not.toContain('abcd1234efgh5678');
    expect(f.reason).toContain('[已脱敏]');
  });

  it('文案选择：第 2 级说「没检索到」就用未覆盖，且 harness 也坏了要补一句', () => {
    const cov: QueryFailure = { level: 'fallback', kind: 'no_coverage', category: 'no_hits', reason: 'x' };
    const harnessBad: QueryFailure = { level: 'harness', kind: 'service_error', category: 'timeout', reason: 'y' };
    expect(composeFallbackText([cov])).toBe(FALLBACK_NO_COVERAGE_TEXT);
    const both = composeFallbackText([harnessBad, cov]);
    expect(both).toContain(FALLBACK_NO_COVERAGE_TEXT);
    expect(both).not.toBe(FALLBACK_NO_COVERAGE_TEXT);
    expect(both).toContain('深度问答未完成');
  });

  it('文案选择：第 2 级本身是故障时绝不说「未覆盖」（本单主诉：把配置故障伪装成知识库缺陷）', () => {
    const bad: QueryFailure = { level: 'fallback', kind: 'service_error', category: 'auth', reason: '401' };
    const text = composeFallbackText([bad]);
    expect(text).toBe(FALLBACK_SERVICE_ERROR_TEXT);
    expect(text).not.toContain('知识库未覆盖');
  });

  it('需求 AC-03-2 措辞特征保留：未覆盖分支必须明说「知识库未覆盖此问题」', () => {
    expect(FALLBACK_NO_COVERAGE_TEXT).toContain('知识库未覆盖此问题');
  });
});

// ===========================================================================
// D. 端到端：真实降级链（LLM 不可达）跑出的兜底文案
// ===========================================================================
describe('T04176-D 端到端降级链', () => {
  it('库里有的内容 + LLM 不可达 → 说「暂不可用」并带上失败原因，不再含糊说「未覆盖」', async () => {
    const stage = vi.spyOn(console, 'log').mockImplementation(() => {});
    const chunks = await collectWorkflow('知识库的价值体现在哪里');
    const text = chunks.filter((c) => typeof c.text === 'string').map((c) => c.text as string).join('');
    expect(text).toContain('问答服务暂不可用');
    expect(text).not.toContain('知识库未覆盖此问题');
    // 归因证据：failed 阶段必须带 kind/category/reason（改造前是 `catch {}`，只有 phase）
    const failed = stage.mock.calls
      .map((c) => String(c[1] ?? ''))
      .filter((s) => /"phase":"(harness|fallback)-failed"/.test(s));
    expect(failed.length).toBeGreaterThanOrEqual(2);
    for (const line of failed) {
      const parsed = JSON.parse(line) as { kind: string; category: string; reason: string };
      expect(['service_error']).toContain(parsed.kind);
      expect(parsed.reason.length).toBeGreaterThan(0);
    }
    // 链路深度自检：注入了 stateStore，第 2 级就必须走到「拿完页面→调 LLM」这一步，
    // 失败原因是连接被拒而不是 harness 构造期报错——否则这条用例只是构造失败测试，
    // 证明不了取词修复真的让用户「库里有的问题」走到了模型。
    // 链路深度自检：注入了 stateStore，第 2 级就必须走到「拿完页面→调 LLM」这一步，
    // 否则这条用例只是 harness 构造失败测试，证明不了取词修复真的让「库里有的问题」走到了模型。
    expect(llmRequests, 'harness 与降级第 2 级都应打到 LLM').toBeGreaterThanOrEqual(2);
    for (const line of failed) {
      expect(JSON.parse(line).category, '桩 LLM 返 500，应归为 service_down').toBe('service_down');
    }
  }, 30_000);

  it('库里没有的内容 + LLM 不可达 → 未覆盖文案（并按 harness 故障补一句）', async () => {
    const chunks = await collectWorkflow('量子拓扑冰淇淋产量排行榜');
    const text = chunks.filter((c) => typeof c.text === 'string').map((c) => c.text as string).join('');
    expect(text).toContain('知识库未覆盖此问题');
  }, 30_000);
});

// baseUrl 指向本用例的桩 LLM（永远 500）；
// 与生产同源注入 stateStore（index.ts 也是这么传的）：不注入时 harness 在构造期就因
// 「FileStateStore 需要显式状态目录」抛错，降级链两级都到不了检索/调用点，
// 这条 e2e 就退化成「构造失败测试」，证明不了取词真的接进了检索。
function unreachableConfig(stateDir: string): HarnessConfig {
  return {
    llm: { provider: 'glm', baseUrl: llmUrl, apiKey: 'test-key', model: 'test-model' },
    tools: [],
    budget: { maxSteps: 1, tokenBudget: 1000 },
    stateStore: createRunStateStore([stateDir]),
  } as unknown as HarnessConfig;
}

async function collectWorkflow(question: string): Promise<AnswerChunk[]> {
  const out: AnswerChunk[] = [];
  for await (const chunk of queryWorkflow(unreachableConfig(stateDir), vault, { question, stream: false })) {
    out.push(chunk);
  }
  return out;
}
