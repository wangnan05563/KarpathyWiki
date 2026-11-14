import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import Fastify, { type FastifyInstance } from 'fastify';
import type { EngineAdapter, QueryInput, AnswerChunk } from '../src/types.js';
import { ThreadMemoryStore } from '../src/engine/thread-memory-store.js';
import { registerQueryRoute } from '../src/routes/query.js';
import { createIsolationGuards } from '../src/middleware/auth.js';
import { DEFAULT_GOVERNOR_CONFIG } from '../src/engine/context-governor.js';

const BYOK = {
  llmConfig: { provider: 'glm', baseUrl: 'http://test.local/v4', model: 'test-model', apiKey: 'TEST_KEY' },
};

interface Frame { event: string; data: Record<string, unknown> }

function parseFrames(body: string): Frame[] {
  const frames: Frame[] = [];
  for (const block of body.split('\n\n')) {
    let event = '';
    let data = '';
    for (const line of block.split('\n')) {
      if (line.startsWith('event: ')) event = line.slice(7);
      if (line.startsWith('data: ')) data = line.slice(6);
    }
    if (!event || !data) continue;
    try {
      frames.push({ event, data: JSON.parse(data) as Record<string, unknown> });
    } catch {
      // 心跳/非 JSON 帧跳过
    }
  }
  return frames;
}

function makeAdapter(chunks: AnswerChunk[], failAfter?: string): EngineAdapter {
  return {
    query: async function* (_input: QueryInput): AsyncIterable<AnswerChunk> {
      for (const chunk of chunks) {
        yield chunk;
        if (failAfter && chunk.text === failAfter) throw new Error('上游断流');
      }
    },
    compile: async function* () {},
    resumeCompile: async function* () {},
    healthCheck: async () => ({ orphans: [], brokenLinks: [], stale: [] }),
    healthCheckFix: async function* () {},
    updateConfig: () => {},
    podcast: async () => ({ script: '', audioFiles: [], durationSec: 0, archivePath: '', ttsEnabled: false }),
    generateVideo: async () => ({ taskId: '', videoId: '', status: 'queued', progress: 0 }),
    pollVideoTask: async () => ({ taskId: '', videoId: '', status: 'queued', progress: 0 }),
  } as unknown as EngineAdapter;
}

let app: FastifyInstance;
let store: ThreadMemoryStore;
let dataDir: string;

beforeAll(async () => {
  dataDir = await fs.mkdtemp(path.join(os.tmpdir(), 'query-v2-'));
  store = new ThreadMemoryStore(dataDir);
  app = Fastify();
  const adapter = makeAdapter([
    { thinking: { phase: 'thinking', message: '先检索知识库' } },
    { progress: { step: '检索中', count: 2 } },
    { thinking: { phase: 'composing', message: '' } },
    { text: '知识库里有三篇相关页面。' },
    { refs: ['页面A'], webRefs: [], done: true },
  ]);
  registerQueryRoute(app, adapter, store, DEFAULT_GOVERNOR_CONFIG, createIsolationGuards(), true);
  await app.ready();
});

afterAll(async () => {
  await app.close();
  await fs.rm(dataDir, { recursive: true, force: true }).catch(() => undefined);
});

describe('POST /api/query protocol=v2', () => {
  it('首连发送 turn_start/think/tool/answer/turn_end，且 done 持久化正常', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/api/query',
      payload: { ...BYOK, question: '知识库里有什么', protocol: 'v2' },
    });
    expect(res.statusCode).toBe(200);
    const frames = parseFrames(res.body);
    expect(frames[0]?.event).toBe('open');
    const runId = frames[0]?.data.runId as string;
    expect(runId).toBeTruthy();

    const protocolFrames = frames.filter((f) => f.event !== 'open');
    expect(protocolFrames[0]?.event).toBe('turn_start');
    expect(protocolFrames[0]?.data.seq).toBe(1);
    expect(protocolFrames.some((f) => f.event === 'think_delta')).toBe(true);
    expect(protocolFrames.some((f) => f.event === 'tool_start')).toBe(true);
    expect(protocolFrames.some((f) => f.event === 'tool_progress')).toBe(true);
    expect(protocolFrames.some((f) => f.event === 'answer_delta')).toBe(true);
    expect(protocolFrames.at(-1)?.event).toBe('turn_end');
    expect(protocolFrames.at(-1)?.data.outcome).toBe('ok');
    expect(protocolFrames.at(-1)?.data.threadId).toBeTruthy();

    const seqs = protocolFrames
      .map((f) => f.data.seq)
      .filter((seq): seq is number => typeof seq === 'number');
    expect(seqs).toEqual(Array.from({ length: seqs.length }, (_, i) => i + 1));

    const threadId = protocolFrames.at(-1)?.data.threadId as string;
    const session = await store.getSession(threadId);
    expect(session?.messages.at(-1)?.question).toBe('知识库里有什么');
  });

  it('afterSeq 重连只回放更晚的帧，不重复已读内容', async () => {
    const first = await app.inject({
      method: 'POST',
      url: '/api/query',
      payload: { ...BYOK, question: '重连测试', protocol: 'v2' },
    });
    const firstFrames = parseFrames(first.body);
    const runId = firstFrames[0]?.data.runId as string;
    expect(runId).toBeTruthy();

    const protocolFrames = firstFrames.filter((f) => f.event !== 'open');
    const numbered = protocolFrames.filter((f) => typeof f.data.seq === 'number');
    const afterSeq = (numbered.at(-3)?.data.seq as number) ?? 1;
    const resumed = await app.inject({
      method: 'POST',
      url: '/api/query',
      payload: { resume: runId, protocol: 'v2', afterSeq },
    });
    expect(resumed.statusCode).toBe(200);
    // side 事件（refs 等）不带 seq，重连时整体重放；序号断言只看 v2 业务事件
    const resumedFrames = parseFrames(resumed.body)
      .filter((f) => f.event !== 'open' && typeof f.data.seq === 'number');
    expect(resumedFrames.length).toBeGreaterThan(0);
    expect(resumedFrames.every((f) => (f.data.seq as number) > afterSeq)).toBe(true);
    expect(resumedFrames.at(-1)?.event).toBe('turn_end');
    expect(resumedFrames.some((f) => f.event === 'answer_delta' && (f.data.seq as number) <= afterSeq)).toBe(false);
  });

  it('producer 失败收口为 turn_error', async () => {
    const failingApp = Fastify();
    const failing = makeAdapter([{ text: '半截答案' }], '半截答案');
    registerQueryRoute(failingApp, failing, store, DEFAULT_GOVERNOR_CONFIG, createIsolationGuards(), true);
    await failingApp.ready();
    const res = await failingApp.inject({
      method: 'POST',
      url: '/api/query',
      payload: { ...BYOK, question: '会失败的问题', protocol: 'v2' },
    });
    const frames = parseFrames(res.body);
    expect(frames.at(-1)?.event).toBe('turn_error');
    expect(frames.at(-1)?.data.message).toBe('上游断流');
    expect(frames.some((f) => f.event === 'turn_end')).toBe(false);
    await failingApp.close();
  });

  it('未开启可恢复流式时 protocol=v2 明确拒绝', async () => {
    const legacyApp = Fastify();
    registerQueryRoute(legacyApp, makeAdapter([{ text: 'x', done: true }]), store, DEFAULT_GOVERNOR_CONFIG);
    await legacyApp.ready();
    const res = await legacyApp.inject({
      method: 'POST',
      url: '/api/query',
      payload: { ...BYOK, question: 'x', protocol: 'v2' },
    });
    expect(res.statusCode).toBe(400);
    expect((JSON.parse(res.body) as { code?: string }).code).toBe('V2_DISABLED');
    await legacyApp.close();
  });
});
