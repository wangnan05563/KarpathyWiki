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
// （127.0.0.1 随机端口，任何请求立即返回 500 或 429），不发任何真实请求、不消耗 token、不读真实密钥。
//
// T04479 在同一文件里加 E 组：主诉是「当前问答服务暂不可用：…两次尝试都没有完成…」
// 那句兜底文案，现场真实原因是上游模型回 429（免费额度限流）。
// 限流不是本侧代码缺陷，但①文案给的下一步动作（查配置与网络）与原因不符、②降级第 2 级
// 用同一 provider/密钥重复撞一次限流，这两条是本侧的缺陷，E 组逐条锁死。
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
  answerBodyChunks,
  composeFallbackText,
  describeQueryFailure,
  emptyAnswerFailure,
  FALLBACK_NO_COVERAGE_TEXT,
  FALLBACK_SERVICE_ERROR_TEXT,
  hasAnswerBody,
  isAccountLevelFailure,
  queryWorkflow,
  type QueryFailure,
} from '../src/workflows/query-workflow.js';
import type { AnswerChunk, QueryInput } from '../src/types.js';

let vaultDir: string;
let stateDir: string;
let vault: VaultService;
// 桩 LLM：任何请求都立即按 stubStatus 返回（默认 500）。为什么不用不可达端口：ECONNREFUSED 会走 harness 的重试退避，
// 两级降级实测 12 s（用例预算大头全花在等待上）；500 秒回，而且能统计「第 2 级真的走到调用点」的次数。
// 只监听 127.0.0.1 随机端口，密钥是字面量 test-key，绝不指向任何真实 provider。
let llmServer: http.Server;
let llmUrl = '';
let llmRequests = 0;
// T04479：桩服务的响应状态可切换（默认 500 = service_down；E 组切 429 = rate_limit）。
// 为什么按状态码而不是按用例注入 Error：要锁的是「真实链路里 provider 回 429 时本侧怎么办」，
// 从 HTTP 响应到 friendlyLlmError 分类到文案的整条链必须真的走一遍，直接喂 Error 会绕开分类上游。
let stubStatus = 500;
let stubBody = '{"error":{"message":"stub upstream exploded","type":"server_error"}}';
// T04456：真流式（请求体 stream:true）走 SSE。null = 本用例不测流式，仍按 JSON 分支回。
// 为什么按请求体里的 stream 标志分叉，而不是按用例切整个桩：深度问答与降级第 2 级在同一次
// 端到端里分别用流式/非流式发请求，只有一处判据能同时验到两级。
let stubStreamContent: string | null = null;
const createdDirs: string[] = [];

// OpenAI 流式协议帧：content 为空串时一帧 delta.content 都不发（正是「200 但零正文」的流式形态）
function sseFrames(content: string): string {
  const frames = [
    JSON.stringify({ choices: [{ index: 0, delta: { role: 'assistant' } }] }),
    ...(content ? [JSON.stringify({ choices: [{ index: 0, delta: { content } }] })] : []),
    JSON.stringify({ choices: [{ index: 0, delta: {}, finish_reason: 'stop' }] }),
    '[DONE]',
  ];
  return frames.map((f) => (f === '[DONE]' ? 'data: [DONE]' : `data: ${f}`)).join('\n\n') + '\n\n';
}

function writePage(rel: string, body: string): void {
  const abs = path.join(vaultDir, rel);
  mkdirSync(path.dirname(abs), { recursive: true });
  writeFileSync(abs, body, 'utf8');
}

beforeAll(async () => {
  llmServer = http.createServer((req, res) => {
    llmRequests += 1;
    const body: Buffer[] = [];
    req.on('data', (c) => body.push(c as Buffer));
    req.on('error', () => {
      /* 客户端中断：不响应即可，不能让无监听器的 error 事件掀翻桩服务 */
    });
    req.on('end', () => {
      let wantsStream = false;
      try {
        wantsStream = (JSON.parse(Buffer.concat(body).toString('utf8')) as { stream?: boolean }).stream === true;
      } catch {
        /* 非 JSON 请求体按非流式处理 */
      }
      if (wantsStream && stubStreamContent !== null) {
        res.writeHead(200, { 'content-type': 'text/event-stream' });
        res.end(sseFrames(stubStreamContent));
        return;
      }
      res.writeHead(stubStatus, { 'content-type': 'application/json' });
      res.end(stubBody);
    });
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
  stubStatus = 500;
  stubBody = '{"error":{"message":"stub upstream exploded","type":"server_error"}}';
  stubStreamContent = null;
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
    expect(text).toContain('问答服务暂不可用');
    expect(text).not.toContain('知识库未覆盖');
    // T04479：认证失败有专属指引（查密钥），不再套用「检查模型配置与网络」这句泛化提示
    expect(text).toContain('API Key');
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

// ===========================================================================
// E. T04479：上游 429（免费额度限流）——归因、文案、以及降级第 2 级的空转
// 现场取证 karpathy-wiki/logs/api-dev.log：同一个问题三连，每连都是
//   harness-failed{category:rate_limit} → 968ms → fallback-failed{category:rate_limit}，
//   reason 为「LLM API error 429: ...rate limit for free users...」。
// 上游限流本身不是本侧代码缺陷；本侧的两个缺陷是：① 兜底文案把限流说成「检查模型配置与网络」，
// 用户照着提示重试了三轮；② 降级第 2 级复用同一 provider/密钥，限流下必然同样失败却照跑。
// ===========================================================================
describe('T04479-E 上游限流', () => {
  const RATE_LIMIT_BODY =
    '{"error":{"code":"","message":"You\'ve reached the API rate limit for free users. Upgrade to a Token Plan to unlock more."}}';

  it('现场错误串判为 rate_limit（分类只认 friendlyLlmError，本侧不再造口径）', () => {
    const f = describeQueryFailure('harness', new Error(`LLM API error 429: ${RATE_LIMIT_BODY}`));
    expect(f).toMatchObject({ level: 'harness', kind: 'service_error', category: 'rate_limit' });
  });

  it('跳过判据只认「同一输入必然同样失败」的账号级错误', () => {
    const mk = (category: string, kind: QueryFailure['kind'] = 'service_error'): QueryFailure =>
      ({ level: 'harness', kind, category, reason: 'x' });
    expect(isAccountLevelFailure(mk('rate_limit'))).toBe(true);
    expect(isAccountLevelFailure(mk('auth'))).toBe(true);
    // service_down / timeout 换个时间可能成；request_too_large 的第 2 级上下文更小，
    // 可能正好落回上限内——这三类跳掉就是少给用户一次机会，不许进跳过集合
    expect(isAccountLevelFailure(mk('service_down'))).toBe(false);
    expect(isAccountLevelFailure(mk('timeout'))).toBe(false);
    expect(isAccountLevelFailure(mk('request_too_large'))).toBe(false);
    expect(isAccountLevelFailure(mk('unknown'))).toBe(false);
    expect(isAccountLevelFailure(mk('no_hits', 'no_coverage'))).toBe(false);
    expect(isAccountLevelFailure(undefined)).toBe(false);
  });

  it('限流文案给「降频 / 换密钥 / 换 provider」，不再让用户去查配置与网络', () => {
    const rate: QueryFailure = { level: 'harness', kind: 'service_error', category: 'rate_limit', reason: '429' };
    const text = composeFallbackText([rate], true);
    expect(text).toContain('429');
    expect(text).toContain('provider');
    // 主诉里把人引错的正是这句：配置和网络都没有错
    expect(text).not.toContain('检查模型配置与网络');
    expect(text).not.toContain('知识库未覆盖');
    // 第 2 级是「跳过」而不是「跑失败」，不许声称两次尝试都没完成
    expect(text).toContain('已跳过');
    expect(text).not.toContain('两次尝试都没有完成');
  });

  it('认证失败给「查密钥」、413 给「减少内容」——动作要各自对得上原因', () => {
    const mk = (category: string): QueryFailure =>
      ({ level: 'harness', kind: 'service_error' as const, category, reason: 'x' });
    expect(composeFallbackText([mk('auth')])).toContain('API Key');
    expect(composeFallbackText([mk('request_too_large')])).toContain('413');
  });

  it('口径不扩散：未点名分类仍用默认文案（默认那句对 service_down/timeout 依然成立）', () => {
    for (const category of ['service_down', 'timeout', 'unknown']) {
      const f: QueryFailure = { level: 'fallback', kind: 'service_error', category, reason: 'x' };
      expect(composeFallbackText([f])).toBe(FALLBACK_SERVICE_ERROR_TEXT);
    }
    expect(FALLBACK_SERVICE_ERROR_TEXT).toContain('检查模型配置与网络');
  });

  it('端到端：桩 LLM 回 429 → 第 2 级不进、不发「降级搜索中」、文案是限流话术', async () => {
    stubStatus = 429;
    stubBody = RATE_LIMIT_BODY;
    const stage = vi.spyOn(console, 'log').mockImplementation(() => {});
    const chunks = await collectWorkflow('知识库的价值体现在哪里');
    const phases = stagePhases(stage);
    expect(phases).toContain('harness-failed');
    expect(phases).toContain('fallback-skipped');
    expect(phases).not.toContain('fallback-start');
    expect(phases).not.toContain('fallback-failed');
    // 「第 2 级一次请求都没发」由 not.toContain('fallback-start') 保证：
    // 它的 LLM 调用只可能发生在 fallback-start 之后，start 没出现就是整级没进。
    expect(llmRequests, 'harness 一次、降级第 2 级零次（harness 重试已在配置里关掉）').toBe(1);
    const thinking = chunks.filter((c) => c.thinking).map((c) => c.thinking?.message ?? '').join('|');
    expect(thinking).not.toContain('降级搜索中');
    const text = chunks.filter((c) => typeof c.text === 'string').map((c) => c.text as string).join('');
    expect(text).toContain('429');
    expect(text).not.toContain('知识库未覆盖');
    // 「跳过」这个事实必须端到端传到文案，不能只在单元测试里手工传 true：
    // 探针把调用点改成 composeFallbackText(failures, false) 时，只看 429 字样会照样全绿，
    // 用户就会对着一个从没跑过的降级检索被告知「两次尝试都没有完成」。
    expect(text).toContain('已跳过');
    expect(text).not.toContain('两次尝试都没有完成');
    // 跳过时也不许声称日志里有 fallback-failed（那是「跑了且失败」，与本级没进是两件事）
    expect(text).not.toContain('fallback-failed');
    // 跳过也要留下可归因的一行（把原因吞掉正是本单主诉的成因之一）
    const skipped = stage.mock.calls
      .filter((c) => String(c[0]) === '[query-stage]')
      .map((c) => JSON.parse(String(c[1])) as { phase: string; category?: string; reason?: string })
      .find((o) => o.phase === 'fallback-skipped');
    expect(skipped).toMatchObject({
      phase: 'fallback-skipped',
      category: 'rate_limit',
      reason: '账号级错误，降级检索复用同一 provider/密钥，重试必然同样失败',
    });
  }, 30_000);

  it('端到端反向控制：500（服务端故障）仍要走完第 2 级——跳过判据不许扩面', async () => {
    const stage = vi.spyOn(console, 'log').mockImplementation(() => {});
    const chunks = await collectWorkflow('知识库的价值体现在哪里');
    const phases = stagePhases(stage);
    expect(phases).toContain('fallback-start');
    expect(phases).toContain('fallback-failed');
    expect(phases).not.toContain('fallback-skipped');
    expect(llmRequests, '两级都要打到 LLM').toBeGreaterThanOrEqual(2);
    // 反向的文案锁：真跑过两级就不许说成「已跳过」，且保持通用话术（不冒充限流指引）
    const text = chunks.filter((c) => typeof c.text === 'string').map((c) => c.text as string).join('');
    expect(text).toContain('两次尝试都没有完成');
    expect(text).not.toContain('已跳过');
    expect(text).not.toContain('429');
  }, 30_000);
});

// [query-stage] 埋点里的 phase 序列（E 组用它判「哪一级真的跑了」）
function stagePhases(spy: { mock: { calls: unknown[][] } }): string[] {
  return spy.mock.calls
    .filter((c) => String(c[0]) === '[query-stage]')
    .map((c) => String((JSON.parse(String(c[1])) as { phase: string }).phase));
}

// baseUrl 指向本用例的桩 LLM（默认 500，E 组按用例切到 429）；
// 与生产同源注入 stateStore（index.ts 也是这么传的）：不注入时 harness 在构造期就因
// 「FileStateStore 需要显式状态目录」抛错，降级链两级都到不了检索/调用点，
// 这条 e2e 就退化成「构造失败测试」，证明不了取词真的接进了检索。
function unreachableConfig(stateDir: string): HarnessConfig {
  return {
    llm: { provider: 'glm', baseUrl: llmUrl, apiKey: 'test-key', model: 'test-model' },
    tools: [],
    budget: { maxSteps: 1, tokenBudget: 1000 },
    // T04479：关掉 harness 的指数退避重试（默认对 429 重试 3 次、睡 7~10s）。
    // 重试是 wiki-harness 的行为、不是本单改的东西；关掉后「一次尝试 = 一次请求」，
    // llmRequests 才能把「降级第 2 级有没有被调用」这一件事读干净，用例也不必为等待买单。
    retry: { maxRetries: 0 },
    stateStore: createRunStateStore([stateDir]),
  } as unknown as HarnessConfig;
}

async function collectWorkflow(question: string, input?: Partial<QueryInput>): Promise<AnswerChunk[]> {
  const out: AnswerChunk[] = [];
  for await (const chunk of queryWorkflow(unreachableConfig(stateDir), vault, { question, stream: false, ...input })) {
    out.push(chunk);
  }
  return out;
}

// ===========================================================================
// F. T04456：空答案（HTTP 200 但零正文）——既不降级也不兜底的那条缝
// 取证（改造前实测，桩 LLM 回 200）：
//   content="" 或 null → 第 1 级把硬编码占位句「知识库未覆盖此问题。」当答案发出并 harness-done，
//                        用户被告知「库里没有」，而库里其实有这篇页面；既不降级也不打 *-failed。
//   content="  \n  "   → 原样发出这串空白，用户得到一只空白气泡（本单主诉形态）。
// ===========================================================================
describe('T04456-F 空答案判定', () => {
  const EMPTY_BODY = '{"choices":[{"message":{"role":"assistant","content":""}}]}';
  const WS_BODY = '{"choices":[{"message":{"role":"assistant","content":"  \\n  "}}]}';

  function joinedText(chunks: AnswerChunk[]): string {
    return chunks.filter((c) => typeof c.text === 'string').map((c) => c.text as string).join('');
  }

  it('判据真值表：空白串不算正文，image/ppt 算正文，thinking/refs/followups 不算', () => {
    expect(hasAnswerBody('')).toBe(false);
    expect(hasAnswerBody('  \n ')).toBe(false);
    expect(hasAnswerBody(null)).toBe(false);
    expect(hasAnswerBody(undefined)).toBe(false);
    expect(hasAnswerBody('一句正文')).toBe(true);
    expect(answerBodyChunks({ text: '   ' })).toBe(0);
    expect(answerBodyChunks({ text: '一句正文' })).toBe(1);
    expect(answerBodyChunks({ thinking: { phase: 'thinking', message: '正在思考', ts: '' } })).toBe(0);
    expect(answerBodyChunks({ refs: ['a/b.md'], done: true })).toBe(0);
    expect(answerBodyChunks({ followups: ['追问'] })).toBe(0);
    expect(answerBodyChunks({ image: { url: 'u', alt: 'a' } })).toBe(1);
    expect(answerBodyChunks({ ppt: { markdown: '# m', title: 't', archivePath: 'p' } })).toBe(1);
  });

  it('空答案归为 service_error/empty_answer，且不属于账号级（第 2 级值得再问一次）', () => {
    expect(emptyAnswerFailure('harness')).toEqual({
      level: 'harness',
      kind: 'service_error',
      category: 'empty_answer',
      reason: expect.any(String),
    });
    expect(isAccountLevelFailure(emptyAnswerFailure('harness'))).toBe(false);
  });

  it('兜底文案：说「没拿到正文」，日志指针按真实阶段拼，不冒充未覆盖也不支人查网络', () => {
    const text = composeFallbackText([emptyAnswerFailure('harness'), emptyAnswerFailure('fallback')]);
    expect(text).toContain('没有返回任何答案正文');
    expect(text).toContain('[query-stage] harness-empty-answer / fallback-empty-answer');
    expect(text).not.toContain('知识库未覆盖');
    expect(text).not.toContain('检查模型配置与网络');
  });

  it('混排（第 1 级空正文、第 2 级抛错）时指针不许谎报第 1 级为 harness-failed', () => {
    const text = composeFallbackText([
      emptyAnswerFailure('harness'),
      { level: 'fallback', kind: 'service_error', category: 'auth', reason: '401' },
    ]);
    expect(text).toContain('[query-stage] harness-empty-answer / fallback-failed');
  });

  it('端到端：200 空正文 → 真的降级到第 2 级，且不再硬编「知识库未覆盖此问题。」', async () => {
    stubStatus = 200;
    stubBody = EMPTY_BODY;
    const stage = vi.spyOn(console, 'log').mockImplementation(() => {});
    const chunks = await collectWorkflow('知识库的价值体现在哪里');
    const phases = stagePhases(stage);
    expect(phases).toContain('harness-empty-answer');
    expect(phases).not.toContain('harness-done');
    expect(phases).toContain('fallback-start');
    expect(phases).toContain('fallback-empty-answer');
    expect(phases).not.toContain('fallback-done');
    // 两级各打一次；用 >=2 而不是 ===2：多模态包装若再加调用不该把这条锁变成误报
    expect(llmRequests, '空答案必须真的走降级第 2 级').toBeGreaterThanOrEqual(2);
    const text = joinedText(chunks);
    expect(text).not.toContain('知识库未覆盖此问题。');
    expect(text).toContain('没有返回任何答案正文');
    expect(chunks.some((c) => c.done), '兜底后仍要收口 done').toBe(true);
  }, 30_000);

  it('端到端：纯空白正文（改造前是一只空泡）不再发出空白 text chunk，且有归因文案', async () => {
    stubStatus = 200;
    stubBody = WS_BODY;
    const chunks = await collectWorkflow('知识库的价值体现在哪里');
    expect(joinedText(chunks)).not.toBe('  \n  ');
    expect(chunks.some((c) => typeof c.text === 'string' && c.text.trim() === ''), '不许再发只含空白的正文块').toBe(false);
    expect(joinedText(chunks)).toContain('没有返回任何答案正文');
  }, 30_000);

  it('反向控制：模型正常给出正文时不触发空答案判据（判据不许扩到正常路径）', async () => {
    stubStatus = 200;
    stubBody = '{"choices":[{"message":{"role":"assistant","content":"知识库的价值体现在复利。"}}]}';
    const stage = vi.spyOn(console, 'log').mockImplementation(() => {});
    const chunks = await collectWorkflow('知识库的价值体现在哪里');
    const phases = stagePhases(stage);
    expect(phases).toContain('harness-done');
    expect(phases).not.toContain('harness-empty-answer');
    expect(phases).not.toContain('fallback-start');
    expect(joinedText(chunks)).toContain('复利');
  }, 30_000);

  it('关闭 answer 输出时零正文是预期内的：不降级、不兜底、不打空答案阶段', async () => {
    stubStatus = 200;
    stubBody = EMPTY_BODY;
    const stage = vi.spyOn(console, 'log').mockImplementation(() => {});
    const chunks = await collectWorkflow('知识库的价值体现在哪里', { outputModes: ['thinking'] });
    const phases = stagePhases(stage);
    expect(phases).not.toContain('harness-empty-answer');
    expect(phases).toContain('harness-done');
    expect(chunks.filter((c) => typeof c.text === 'string')).toHaveLength(0);
    expect(llmRequests, 'answer 关闭时不该再烧第 2 级').toBe(1);
  }, 30_000);

  // 真流式分支：判据是在「实际发到 wire 上的正文块」上测量的，所以 delta 一帧都没回
  // 也应当被同一口径接住。取证事实（本组实测）：降级第 2 级没有流式变体，它总是走非流式
  // chat()——所以这里让 SSE 分支与 JSON 分支给**相反**的内容，只有第 1 级真的按 stream:true
  // 发请求并消费了 SSE，才会出现「第 1 级空、第 2 级有正文」这个只有真流式才有的形态；
  // 一旦哪天有人把第 1 级悄悄退回非流式，这条腿立刻红。
  it('端到端（真流式）：SSE 一帧 delta 都没回 → 第 1 级判空答案、第 2 级（非流式）救回正文', async () => {
    stubStatus = 200;
    stubBody = '{"choices":[{"message":{"role":"assistant","content":"降级检索给出的正文。"}}]}';
    stubStreamContent = '';
    const stage = vi.spyOn(console, 'log').mockImplementation(() => {});
    const chunks = await collectWorkflow('知识库的价值体现在哪里', { stream: true });
    const phases = stagePhases(stage);
    expect(phases).toContain('harness-empty-answer');
    expect(phases).not.toContain('harness-done');
    expect(phases).toContain('fallback-start');
    expect(phases).toContain('fallback-done');
    const text = joinedText(chunks);
    expect(text).toContain('降级检索给出的正文');
    expect(text).not.toContain('知识库未覆盖此问题。');
    expect(chunks.some((c) => c.done), '救回后仍要收口 done').toBe(true);
  }, 30_000);

  it('端到端（真流式）：两级都没正文 → 兜底说「没拿到答案正文」，不冒充未覆盖', async () => {
    stubStatus = 200;
    stubBody = EMPTY_BODY;
    stubStreamContent = '';
    const stage = vi.spyOn(console, 'log').mockImplementation(() => {});
    const chunks = await collectWorkflow('知识库的价值体现在哪里', { stream: true });
    const phases = stagePhases(stage);
    expect(phases).toContain('harness-empty-answer');
    expect(phases).toContain('fallback-empty-answer');
    const text = joinedText(chunks);
    expect(text).not.toContain('知识库未覆盖此问题。');
    expect(text).toContain('没有返回任何答案正文');
    expect(chunks.some((c) => c.done), '兜底后仍要收口 done').toBe(true);
  }, 30_000);

  it('端到端（真流式反向控制）：delta 正文必须算作答案，正常流式问答不许被误判为空答案', async () => {
    // 与上一条刻意相反：JSON 分支给空正文、SSE 分支给正文。
    // 只有第 1 级真的消费了 SSE 才拿得到正文——否则这条腿会因 JSON 空正文而红。
    stubStatus = 200;
    stubBody = EMPTY_BODY;
    stubStreamContent = '知识库的价值体现在复利上，持续维护的页面会随时间累积收益。';
    const stage = vi.spyOn(console, 'log').mockImplementation(() => {});
    const chunks = await collectWorkflow('知识库的价值体现在哪里', { stream: true });
    const phases = stagePhases(stage);
    expect(phases).toContain('harness-done');
    expect(phases).not.toContain('harness-empty-answer');
    expect(phases).not.toContain('fallback-start');
    expect(joinedText(chunks)).toContain('复利');
  }, 30_000);
});
