// T05721：60 个解析页必须全部成为独立编译单元，且不被 config.batch.maxBatchSize 截断。
// 端点走 JSON（不是 multipart），因此这里复用 routes-compile.test.ts 的 Fastify inject 范式。
import { describe, it, expect, afterEach, vi } from 'vitest';
import Fastify, { type FastifyInstance } from 'fastify';
import fs from 'node:fs/promises';
import { registerCompileRoute } from '../src/routes/compile.js';
import type { EngineAdapter, ProgressEvent, CompileInput, BatchCompileConfig } from '../src/types.js';

function parseSSE(payload: string): Array<{ event: string; data: any }> {
  const out: Array<{ event: string; data: any }> = [];
  for (const block of payload.split('\n\n')) {
    if (!block.trim()) continue;
    let event = '';
    let data = '';
    for (const line of block.split('\n')) {
      if (line.startsWith('event: ')) event = line.slice(7);
      else if (line.startsWith('data: ')) data += line.slice(6);
    }
    if (!event) continue;
    try { out.push({ event, data: JSON.parse(data) }); }
    catch { out.push({ event, data }); }
  }
  return out;
}

// 故意把 maxBatchSize 设成 5：旧 multipart batch 端点会拒掉 60 页，
// 专用端点必须不受它约束，这正是本组用例要锁住的行为。
// 60 页用例要写/读 60 个临时文件并收完整条 SSE，默认 5s 在并行跑全量或慢机上会假超时，
// 因此逐个显式放宽到 20s（只是放宽时限，不放宽任何断言）。
const SIXTY_PAGE_TIMEOUT_MS = 20_000;
const batch: BatchCompileConfig = {
  allowedExtensions: ['md', 'txt'], maxBatchSize: 5, maxFileSizeMb: 1,
};

let app: FastifyInstance | null = null;

function makePages(count: number) {
  return Array.from({ length: count }, (_, i) => ({
    name: `page-${String(i).padStart(3, '0')}.md`,
    markdown: `# PAGE ${i}\n\nbody ${i}\n`,
  }));
}

// 每次 compile 读取一次临时文件并记入 seen：seen.length 即「真正进入编译队列的页数」。
function createAdapter(seen: string[], failAt = -1): EngineAdapter {
  return {
    compile: vi.fn(async function* (input: CompileInput) {
      const raw = await fs.readFile(input.content, 'utf8');
      seen.push(raw);
      const index = seen.length - 1;
      if (index === failAt) {
        yield { step: 'done', status: 'error', message: `页面 ${index} 编译失败` } as ProgressEvent;
        return;
      }
      yield { step: 'progress', status: 'running', message: '抽取中' } as ProgressEvent;
      yield { step: 'done', status: 'done', message: '完成' } as ProgressEvent;
    }),
    resumeCompile: async function* () { /* unused */ },
    query: async function* () { /* unused */ },
    healthCheck: async () => ({}) as never,
    healthCheckFix: async function* () { /* unused */ },
    updateConfig: () => { /* unused */ },
  } as unknown as EngineAdapter;
}

async function build(adapter: EngineAdapter): Promise<void> {
  const instance = Fastify({ logger: false });
  registerCompileRoute(instance, adapter, batch);
  await instance.ready();
  app = instance;
}

async function post(pages: unknown): Promise<{ statusCode: number; body: string }> {
  const res = await app!.inject({
    method: 'POST',
    url: '/api/compile/url-pages',
    headers: { 'content-type': 'application/json' },
    payload: JSON.stringify({ pages }),
  });
  return { statusCode: res.statusCode, body: res.payload };
}

afterEach(async () => {
  if (app) { await app.close(); app = null; }
});

describe('POST /api/compile/url-pages (T05721)', () => {
  it('60 页全部入队：逐页调用 60 次，每页内容互不相同，事件统计完整', async () => {
    const seen: string[] = [];
    await build(createAdapter(seen));
    const res = await post(makePages(60));

    expect(res.statusCode).toBe(200);
    expect(seen).toHaveLength(60);
    expect(new Set(seen).size).toBe(60);
    for (let i = 0; i < 60; i++) expect(seen).toContain(`# PAGE ${i}\n\nbody ${i}\n`);

    const events = parseSSE(res.body);
    expect(events.filter((e) => e.event === 'file_start')).toHaveLength(60);
    expect(events.filter((e) => e.event === 'file_complete')).toHaveLength(60);
    expect(events.filter((e) => e.event === 'file_error')).toHaveLength(0);
    expect(events.find((e) => e.event === 'batch_start')?.data.data.fileCount).toBe(60);
    const done = events.find((e) => e.event === 'batch_done');
    expect(done?.data.status).toBe('done');
    expect(done?.data.data.fileCount).toBe(60);
    expect(done?.data.data.hasError).toBe(false);
  }, SIXTY_PAGE_TIMEOUT_MS);

  it('config.batch.maxBatchSize=5 不截断 60 页（这正是新端点存在的原因）', async () => {
    expect(batch.maxBatchSize).toBeLessThan(60);
    const seen: string[] = [];
    await build(createAdapter(seen));
    const res = await post(makePages(60));
    expect(res.statusCode).toBe(200);
    expect(seen).toHaveLength(60);
  }, SIXTY_PAGE_TIMEOUT_MS);

  it('部分失败时全部页面仍入队，失败项单独成事件，成功率分母不缩水', async () => {
    const seen: string[] = [];
    await build(createAdapter(seen, 5));
    const res = await post(makePages(60));
    const events = parseSSE(res.body);

    expect(events.filter((e) => e.event === 'file_start')).toHaveLength(60);
    expect(events.filter((e) => e.event === 'file_complete')).toHaveLength(59);
    const errors = events.filter((e) => e.event === 'file_error');
    expect(errors).toHaveLength(1);
    expect(errors[0].data.data.fileIndex).toBe(5);
    const done = events.find((e) => e.event === 'batch_done');
    expect(done?.data.status).toBe('error');
    expect(done?.data.data.fileCount).toBe(60);
    expect(done?.data.data.hasError).toBe(true);
  }, SIXTY_PAGE_TIMEOUT_MS);

  it('超过 500 页硬上限返回 400 且不触发任何编译', async () => {
    const seen: string[] = [];
    await build(createAdapter(seen));
    const res = await post(makePages(501));
    expect(res.statusCode).toBe(400);
    expect(res.body).toContain('超过上限 500');
    expect(seen).toHaveLength(0);
  });

  it('空 pages / 路径穿越文件名 / 缺 markdown 一律 400', async () => {
    const seen: string[] = [];
    await build(createAdapter(seen));

    expect((await post([])).statusCode).toBe(400);
    expect((await post([{ name: '../evil.md', markdown: '# x' }])).statusCode).toBe(400);
    expect((await post([{ name: 'ok.md', markdown: '' }])).statusCode).toBe(400);
    expect((await post([{ name: 'ok.txt', markdown: '# x' }])).statusCode).toBe(400);
    expect(seen).toHaveLength(0);
  });
});
