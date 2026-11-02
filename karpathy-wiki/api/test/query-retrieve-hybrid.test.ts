// T04066：问答检索接入 FR-20 混合检索的回归锁。
// 覆盖三点：
//   A 同义词（字面不匹配、语义相关）查询：改造前关键词 0 命中 → 改造后经语义路进入 top-5
//     （防「接了 hybridSearch 但 embedding 未透传」的假修复）；
//   B 无 embedding 配置时问答检索与改造前完全一致（仅有 key 才启用语义路）；
//   C FR-12 scopeFilter 场景不得改走全库混合检索（否则 AI 伙伴的范围限定被绕过）。
// 隔离纪律：vault 与 SQLite 索引都落在 os.tmpdir() 随机目录；embedding 用本机 stub HTTP 服务，
// 不读真实 key、不消耗任何外部额度。
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { VaultService } from '../src/vault/vault-service.js';
import { searchPages } from '../src/search-util.js';
import { indexPage, type EmbeddingConfig } from '../src/search/hybrid-search.js';
import { closeIndexDb } from '../src/search/sqlite-index.js';
import { retrieveForQuery } from '../src/workflows/query-workflow.js';

// 语义坐标：每个文本按命中词表落到某一维，便于构造「查询与页面同向、但与页面字面不重叠」的场景。
const AXES: Array<{ dim: number; words: string[] }> = [
  { dim: 0, words: ['远程协作', '在家办公', 'telecommuting', 'productivity'] },
  { dim: 1, words: ['图谱渲染', '力导向', 'layout'] },
  { dim: 2, words: ['范围限定测试', 'scope-test'] },
];

function fakeEmbedding(text: string): number[] {
  const vec = [0, 0, 0, 0];
  const axis = AXES.find((a) => a.words.some((w) => text.includes(w)));
  vec[axis ? axis.dim : 3] = 1;
  return vec;
}

let server: http.Server;
let serverUrl = '';
let embeddingRequests = 0;
let lastAuthHeader = '';
let vaultDir: string;
let dataDir: string;
let vault: VaultService;
const createdDirs: string[] = [];

const EMB: EmbeddingConfig = { baseUrl: '', apiKey: 'test-key', model: 'stub-embed' };

function writePage(relPath: string, body: string): void {
  const abs = path.join(vaultDir, relPath);
  mkdirSync(path.dirname(abs), { recursive: true });
  writeFileSync(abs, body, 'utf8');
}

beforeAll(async () => {
  server = http.createServer((req, res) => {
    embeddingRequests += 1;
    lastAuthHeader = String(req.headers.authorization ?? '');
    let raw = '';
    req.on('data', (c) => (raw += c));
    req.on('end', () => {
      const body = JSON.parse(raw || '{}') as { input?: string[] };
      const data = (body.input ?? []).map((text, index) => ({ index, embedding: fakeEmbedding(text) }));
      res.setHeader('Content-Type', 'application/json');
      res.end(JSON.stringify({ data }));
    });
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  serverUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}/v1`;
  EMB.baseUrl = serverUrl;
});

afterAll(async () => {
  await new Promise<void>((resolve) => server.close(() => resolve()));
  for (const dir of createdDirs) {
    try {
      rmSync(dir, { recursive: true, force: true });
    } catch {
      /* 清理失败不影响结果 */
    }
  }
});

beforeEach(async () => {
  vaultDir = mkdtempSync(path.join(tmpdir(), 'wiki-query-vault-'));
  dataDir = mkdtempSync(path.join(tmpdir(), 'wiki-query-index-'));
  createdDirs.push(vaultDir, dataDir);
  vault = new VaultService(vaultDir);

  writePage('concepts/remote-work.md', '# 远程协作\n\n远程协作与在家办公的产出管理经验。');
  writePage('concepts/graph-render.md', '# 图谱渲染\n\n力导向布局的性能优化方案。');
  writePage('queries/scoped.md', '# 范围内\n\n范围限定测试样例。');
  writePage('concepts/out-of-scope.md', '# 范围外\n\n范围限定测试的越界副本。');

  // 先用 stub 服务给三个页面建索引（chunk + 向量），模拟「已经搜索页同步过」的库
  for (const p of ['concepts/remote-work.md', 'concepts/graph-render.md', 'concepts/out-of-scope.md']) {
    await indexPage(dataDir, vault, p, EMB);
  }
  embeddingRequests = 0;
  lastAuthHeader = '';
});

afterEach(() => {
  // 索引层 db 是模块级单例，必须随 tmpdir 生命周期关闭，否则下一个用例会读到旧库
  closeIndexDb();
});

describe('A · 同义词查询：改造前 0 命中 → 改造后进入 top-5', () => {
  it('字面不匹配的英文同义查询：关键词扫描 0 命中，混合检索命中远程协作页', async () => {
    const q = 'telecommuting productivity';
    // 改造前基线：全库关键词扫描确实一无所获（证明这是语义路带来的召回，不是字面匹配）
    expect(await searchPages(vault, q, 5)).toEqual([]);

    const hits = await retrieveForQuery(vault, q, undefined, { embedding: EMB, dataDir });
    expect(hits.length).toBeGreaterThan(0);
    expect(hits.length).toBeLessThanOrEqual(5);
    expect(hits[0].path).toBe('concepts/remote-work.md');
    expect(hits[0].source).toBe('semantic');
    // BYOK：请求确实带着调用方下发的 key 打到了 embedding 服务
    expect(lastAuthHeader).toBe('Bearer test-key');
  });

  it('中文同义改述同样进入 top-5（远程协作 vs 在家办公）', async () => {
    const hits = await retrieveForQuery(vault, '在家办公', undefined, { embedding: EMB, dataDir });
    expect(hits.map((h) => h.path)).toContain('concepts/remote-work.md');
    expect(hits.find((h) => h.path === 'concepts/remote-work.md')?.source).toBe('both');
  });
});

describe('B · 无 embedding 配置：问答检索与改造前一致', () => {
  it('未携带 embedding 时不触达 embedding 服务，结果与 searchPages 逐条相同', async () => {
    const q = '远程协作';
    const viaHelper = await retrieveForQuery(vault, q);
    const baseline = await searchPages(vault, q, 20);
    expect(viaHelper.map((h) => h.path)).toEqual(baseline.map((h) => h.path));
    expect(viaHelper.every((h) => h.source === 'keyword')).toBe(true);
    expect(embeddingRequests).toBe(0);
  });

  it('索引完全未建立（新部署/未同步）时混合检索零命中，自动回退关键词扫描', async () => {
    const freshIndex = mkdtempSync(path.join(tmpdir(), 'wiki-query-index-empty-'));
    createdDirs.push(freshIndex);
    const hits = await retrieveForQuery(vault, '远程协作', undefined, { embedding: EMB, dataDir: freshIndex });
    expect(hits.map((h) => h.path)).toEqual((await searchPages(vault, '远程协作', 20)).map((h) => h.path));
    expect(hits.every((h) => h.source === 'keyword')).toBe(true);
  });
});

describe('C · scopeFilter 场景保持关键词路（FR-12 范围不被放宽）', () => {
  it('带 folder 限定时不调用 embedding，且越界页面不出现', async () => {
    const hits = await retrieveForQuery(vault, '范围限定测试', { folder: 'queries' }, { embedding: EMB, dataDir });
    expect(embeddingRequests).toBe(0);
    expect(hits.map((h) => h.path)).toEqual(['queries/scoped.md']);
    expect(hits.every((h) => h.source === 'keyword')).toBe(true);
  });
});

describe('D · 降级：embedding 服务不可用时回退关键词', () => {
  it('baseUrl 指向不可达端口时静默回退，不向调用方抛错', async () => {
    const broken: EmbeddingConfig = { baseUrl: 'http://127.0.0.1:1/v1', apiKey: 'k', model: 'm' };
    const hits = await retrieveForQuery(vault, '远程协作', undefined, { embedding: broken, dataDir });
    expect(hits.map((h) => h.path)).toEqual((await searchPages(vault, '远程协作', 20)).map((h) => h.path));
    expect(hits.every((h) => h.source === 'keyword')).toBe(true);
  });
});

// E 组只做源码守卫：上述行为测试直接调 retrieveForQuery，若链路某一段忘记透传
// （routes 不映射 body.embedding / Query.vue 不下发 / createQueryTools 不接 input.embedding），
// 端到端仍是「关键词检索」而单测照绿——故把三处接线点逐一声明锁住。
describe('E · 透传链路源码守卫（防假修复）', () => {
  const SRC = (rel: string) => readFileSync(path.resolve(__dirname, rel), 'utf8');

  it('createQueryTools 两处调用点（run/runStream）都接 input.embedding', () => {
    const src = SRC('../src/workflows/query-workflow.ts');
    expect(src.match(/embedding: input\.embedding,/g) ?? []).toHaveLength(2);
  });

  it('search_pages 经 retrieveForQuery 取数，且 helper 内使用 hybridSearch', () => {
    const src = SRC('../src/workflows/query-workflow.ts');
    expect(src).toContain('retrieveForQuery(vault, keywords, scopeFilter, {');
    const helper = src.slice(src.indexOf('export async function retrieveForQuery'), src.indexOf('// query 工作流的工具集'));
    expect(helper).toContain('await hybridSearch(');
    expect(helper).toContain('await searchPages(vault, keywords, limit');
  });

  it('routes/query.ts 把 body.embedding 映射进 QueryInput（无 key 时为 undefined）', () => {
    expect(SRC('../src/routes/query.ts')).toContain('embedding: body.embedding?.apiKey ? body.embedding : undefined,');
  });

  it('Query.vue 按 embeddingConfigFromAi 判定后下发 body.embedding', () => {
    const src = SRC('../../frontend/src/views/Query.vue');
    expect(src).toContain('embeddingConfigFromAi(aiCfg)');
    expect(src).toContain('body.embedding = embeddingCfg;');
  });

  it('前端 embedding 判定单点：loadEmbeddingConfigForSearch 复用 embeddingConfigFromAi', () => {
    const src = SRC('../../frontend/src/services/userConfig.ts');
    expect(src).toContain('export function embeddingConfigFromAi(');
    expect(src).toContain('return embeddingConfigFromAi(await loadAiUserConfigForPreset(');
  });
});
