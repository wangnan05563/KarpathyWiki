// T04503：检索/引用/MCP 读页这四条链上的坏 YAML 判定必须只由字节决定，且「坏」要留下记账。
// ------------------------------------------------------------------
// 机制（T04454 已在 frontmatter-tolerance.test.ts 钉住库行为）：gray-matter 的 matter() 是
// 「先写缓存、后解析」，缓存条目由 toFile 造出来时就带 data:{}，坏 YAML 在随后的引擎里抛异常，
// data 永远停在 {}，缓存却已收下这个半成品。于是同一串字节第一次读抛、第二次起「解析成功」并返回空 data。
// 本文件把这条机制落到四个真实出口（每个出口的红都对应一条用户可见症状，不是推测）：
//   A searchPages（search-util.matchSearchFilter）
//       冷：抛 → processSearchFile 的 catch → 记进 badPageSink 并 warn；
//       热：不抛、data:{} → 过滤不匹配 → 页面静默消失，**同一轮扫描第二次就没有记账**。
//   B searchPagesIndexed（indexed-search.matchesFrontmatter）
//       两种读序都排除该页，但**一条记账都没有**：与 A 的口径分叉，坏页在索引路径上彻底隐形。
//   C buildRefSignals（utils/ref-signal.ts）
//       冷：抛 → catch → confidence:false；热：不抛 → data:{} 但 content 非空 → confidence:true。
//       同一页的「完整度」信号随第几次读翻转 ⇒ 正是「同一次提问，问第二遍结果不一样」的另一半。
//   D vault_read_page（mcp/tools.ts）
//       冷：把 js-yaml 原始多行消息当工具错误抛给 MCP 调用方；热：不报错，返回 frontmatter:{} 的「空元信息页」。
//       同一页两种结论，且调用方拿不到可读原因。
// 取证手法：同一串字节只改 mtime（VaultService 的内容缓存与页面签名都按 mtimeMs 判失效，
// 变 mtime + resetPageSnapshot 即逼它们重算；gray-matter 的缓存键是内容字节，因此第二轮必然命中缓存）。
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import matter from 'gray-matter';

import { VaultService } from '../src/vault/vault-service.js';
import { PAGE_DIRS } from '../src/vault/page-scope.js';
import { resetPageSnapshot } from '../src/utils/derived-cache.js';
import { searchPages } from '../src/search-util.js';
import { closeIndexDb } from '../src/search/sqlite-index.js';
import { searchPagesIndexed, ensureIndexSynced } from '../src/search/indexed-search.js';
import { buildRefSignals } from '../src/utils/ref-signal.js';
import { callTool, type McpToolContext } from '../src/mcp/tools.js';

// 四条落点所在源文件：结构锁按真实调用点判定，不看注释
const TARGET_SRCS: Array<{ label: string; file: string }> = [
  { label: 'search-util', file: path.resolve(__dirname, '..', 'src', 'search-util.ts') },
  { label: 'indexed-search', file: path.resolve(__dirname, '..', 'src', 'search', 'indexed-search.ts') },
  { label: 'ref-signal', file: path.resolve(__dirname, '..', 'src', 'utils', 'ref-signal.ts') },
  { label: 'mcp-tools', file: path.resolve(__dirname, '..', 'src', 'mcp', 'tools.ts') },
];
// E2 按解析后的真实模块路径判定收敛层接入（见该用例注释）
const FRONTMATTER_TS = path.resolve(__dirname, '..', 'src', 'utils', 'frontmatter.ts');

// gray-matter 的 .d.ts 只声明 matter/stringify，cache/clearCache 是运行时才挂上去的
const gm = matter as unknown as { clearCache(): void };

/** 实测会抛的坏形状（裸冒号 + 未闭合流），tag 保证每页字节唯一——缓存键是整段内容，共字节会串例 */
function badBytes(tag: string): string {
  return [
    '---',
    `title: ${tag}: 裸冒号坏值`,
    'tags: [未闭合,',
    '---',
    '',
    `正文 ${tag} 里有一个 唯一标记${tag} 供关键词命中`,
    '',
  ].join('\n');
}

function goodBytes(tag: string, source = 'web', type = 'concept'): string {
  return [
    '---',
    `title: 好页-${tag}`,
    `source: ${source}`,
    `type: ${type}`,
    'tags:',
    '  - 检索',
    '---',
    '',
    `正文-${tag} 唯一标记${tag}`,
  ].join('\n');
}

/**
 * 把源码里的注释抹成空格（换行保留 ⇒ 行号不变），字符串/模板字面量原样留下。
 * 结构锁只该看真实调用点：这些文件的注释里满是 matter() 字样，不抹掉就会把说明文字当调用点。
 */
function maskComments(src: string): string {
  let out = '';
  let i = 0;
  const n = src.length;
  while (i < n) {
    const c = src[i];
    const d = src[i + 1];
    if (c === '/' && d === '/') {
      while (i < n && src[i] !== '\n') {
        out += ' ';
        i++;
      }
      continue;
    }
    if (c === '/' && d === '*') {
      out += '  ';
      i += 2;
      while (i < n && !(src[i] === '*' && src[i + 1] === '/')) {
        out += src[i] === '\n' ? '\n' : ' ';
        i++;
      }
      out += '  ';
      i += 2;
      continue;
    }
    if (c === '"' || c === "'" || c === '`') {
      out += c;
      i++;
      while (i < n) {
        if (src[i] === '\\') {
          out += src[i] + (src[i + 1] ?? '');
          i += 2;
          continue;
        }
        out += src[i];
        const closed = src[i] === c;
        i++;
        if (closed) break;
      }
      continue;
    }
    out += c;
    i++;
  }
  return out;
}

let tempDir: string;
let vaultDir: string;
let dataDir: string;
let vault: VaultService;
let mcpCtx: McpToolContext;

async function writeRaw(rel: string, text: string): Promise<string> {
  const abs = path.join(vaultDir, ...rel.split('/'));
  await fs.mkdir(path.dirname(abs), { recursive: true });
  await fs.writeFile(abs, text, 'utf8');
  resetPageSnapshot();
  return abs;
}

/** 字节不变、只推 mtime：逼 VaultService 内容缓存与页面签名重算，而 gray-matter 内容缓存必然命中 */
async function touchKeepingBytes(abs: string): Promise<void> {
  const t = (Date.now() + 60_000) / 1000;
  await fs.utimes(abs, t, t);
  resetPageSnapshot();
}

/** 抓 [search-scan] 记账：返回每条 warn 里 JSON 负载的 total 与样本路径 */
function scanSinkLines(spy: { mock: { calls: Array<Array<unknown>> } }): Array<{ total: number; paths: string[] }> {
  const out: Array<{ total: number; paths: string[] }> = [];
  for (const call of spy.mock.calls) {
    const text = call.map((a) => (typeof a === 'string' ? a : '')).join(' ');
    if (!text.includes('[search-scan]')) continue;
    const json = text.slice(text.indexOf('{'));
    try {
      const parsed = JSON.parse(json) as { total: number; sample: Array<{ path: string }> };
      out.push({ total: parsed.total, paths: (parsed.sample ?? []).map((s) => s.path) });
    } catch {
      out.push({ total: -1, paths: [] });
    }
  }
  return out;
}

beforeAll(async () => {
  tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'kb-t04503-'));
  vaultDir = path.join(tempDir, 'vault');
  dataDir = path.join(tempDir, 'data');
  await fs.mkdir(vaultDir, { recursive: true });
  await fs.mkdir(dataDir, { recursive: true });
  vault = new VaultService(vaultDir);
  await vault.init();
  mcpCtx = { vault } as unknown as McpToolContext;
});

beforeEach(async () => {
  // gray-matter 的缓存是进程级全局：不清就等于「上一轮的第二次读」变成「这一轮的第一次读」
  gm.clearCache();
  resetPageSnapshot();
  // 腿与腿之间必须互相看不见：上一腿留下的坏页会往同一轮扫描里再记一条，
  // 让「记账条数」这类断言红得和缺陷无关。索引库同理（fts 里滞留的旧页会让结果集凭空多行）。
  await wipeVaultPages();
});

async function wipeVaultPages(): Promise<void> {
  closeIndexDb();
  await fs.rm(path.join(dataDir, 'wiki-index.db'), { force: true });
  for (const d of PAGE_DIRS) {
    const abs = path.join(vaultDir, d);
    try {
      const entries = await fs.readdir(abs);
      await Promise.all(entries.filter((f) => f.endsWith('.md')).map((f) => fs.rm(path.join(abs, f), { force: true })));
    } catch {
      // 目录还没建出来：本来就没有页面
    }
  }
  resetPageSnapshot();
}

afterEach(async () => {
  vi.restoreAllMocks();
  await ensureIndexCleared();
});

afterAll(async () => {
  closeIndexDb(); // 不关连接时 Windows 会锁住 db 文件，rm 直接 EBUSY
  await fs.rm(tempDir, { recursive: true, force: true });
});

async function ensureIndexCleared(): Promise<void> {
  closeIndexDb(); // 不关连接时 Windows 会锁住 db 文件，rm 直接 EBUSY
}

/**
 * 强制同步索引。
 * 为什么不能只靠 searchPagesIndexed 内部的 ensureIndexSynced：节流状态（lastSyncAt / lastSyncRevision /
 * syncIntervalMs / syncInFlight）是 indexed-search 的模块级变量，本文件按腿删库重建时不会归零；
 * 而写夹具走 fs.writeFile，不动 vault 的写版本号 —— 于是「版本号没变 + 还在窗口内」直接短路返回旧结果，
 * 空库里 0 条召回，searchPagesIndexed 在 rows.length===0 处提前返回，坏页那圈循环根本没跑。
 * 那种红是夹具时序问题，与本单缺陷无关，所以 B 组显式 force。
 */
async function syncIndexForced(): Promise<void> {
  await ensureIndexSynced(dataDir, vault, true);
}

describe('A · searchPages（legacy 全库扫描）坏页判定与记账都不许随读序变脸', () => {
  it('A1 同字节两遍扫描：结果一致，且两轮都必须在 [search-scan] 里留下记账', async () => {
    const badAbs = await writeRaw('entities/bad-a1.md', badBytes('A1'));
    await writeRaw('concepts/good-a1.md', goodBytes('A1'));

    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const filter = { source: 'web' };
    const first = await searchPages(vault, '词汇', 20, filter); // 冷读：抛 → badPageSink
    const cold = scanSinkLines(warnSpy);
    await touchKeepingBytes(badAbs);
    const second = await searchPages(vault, '词汇', 20, filter); // 热读：不抛、data:{}
    const warm = scanSinkLines(warnSpy);

    expect(second.map((h) => h.path)).toEqual(first.map((h) => h.path));
    expect(cold, '冷读有记账').toHaveLength(1);
    expect(cold[0].paths).toContain('entities/bad-a1.md');
    expect(warm, '热读必须同样有记账——坏页不许退化成「静默不匹配」').toHaveLength(2);
    expect(warm[1].paths).toEqual(cold[0].paths);
    expect(warm[1].total, '坏页计数不随读序漂移').toBe(cold[0].total);
  });

  it('A2 负控制：干净库里不得凭空造出 [search-scan] 记账', async () => {
    await writeRaw('entities/clean-a2.md', goodBytes('A2'));
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const hits = await searchPages(vault, '唯一标记A2', 20, { source: 'web' });
    expect(hits.map((h) => h.path)).toContain('entities/clean-a2.md');
    expect(scanSinkLines(warnSpy), '好页不该被记成坏页').toHaveLength(0);
  });

  it('A3 T04455 契约不回归：只传 tags 的范围限定 + 空关键词仍能列出页面', async () => {
    await writeRaw('entities/tagged-a3.md', goodBytes('A3'));
    const hits = await searchPages(vault, '   ', 20, { tags: ['检索'] });
    expect(hits.map((h) => h.path), '过滤维度枚举源不许被接入顺手动掉').toContain('entities/tagged-a3.md');
  });
});

describe('B · searchPagesIndexed 的坏页必须汇入同一记账口径', () => {
  it('B1 索引路径遇到坏 frontmatter：排除该页，但必须在 [search-scan] 里可见', async () => {
    await writeRaw('entities/bad-b1.md', badBytes('B1'));
    await writeRaw('entities/good-b1.md', goodBytes('B1'));
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
    await syncIndexForced();

    const hits = await searchPagesIndexed(dataDir, vault, '唯一标记B1', 20, { source: 'web' });
    expect(hits, '索引路径此时不该整体失败').not.toBeNull();
    expect(hits!.map((h) => h.path), '坏页无法证明属于过滤范围 → 排除').not.toContain('entities/bad-b1.md');
    expect(hits!.map((h) => h.path)).toContain('entities/good-b1.md');
    const lines = scanSinkLines(warnSpy);
    expect(lines, '坏页在索引路径上也必须记账——与 legacy 同口径').toHaveLength(1);
    expect(lines[0].paths).toContain('entities/bad-b1.md');
  });

  it('B2 同字节两遍索引检索：结果与记账逐轮一致（第一轮就是热缓存也不许少记账）', async () => {
    const badAbs = await writeRaw('entities/bad-b2.md', badBytes('B2'));
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});

    await syncIndexForced();
    await searchPagesIndexed(dataDir, vault, '唯一标记B2', 20, { source: 'web' });
    const cold = scanSinkLines(warnSpy);
    await touchKeepingBytes(badAbs);
    const second = await searchPagesIndexed(dataDir, vault, '唯一标记B2', 20, { source: 'web' });
    const warm = scanSinkLines(warnSpy);

    expect(cold, '第一轮已有记账').toHaveLength(1);
    expect(warm, '第二轮仍要有同一条记账').toHaveLength(2);
    expect(warm[1].paths).toEqual(cold[0].paths);
    expect(second).toEqual([]);
  });
});

describe('C · buildRefSignals 的引用信号不随读序翻转', () => {
  it('C1 同字节两次构建：authority/confidence/review 结论逐字段一致', async () => {
    const badAbs = await writeRaw('entities/bad-c1.md', badBytes('C1'));
    const first = await buildRefSignals(['entities/bad-c1.md'], vault);
    await touchKeepingBytes(badAbs);
    const second = await buildRefSignals(['entities/bad-c1.md'], vault);

    // 坏页仍要「保留引用」（AC-19-6 不许静默丢弃），但信号必须是同一个结论而不是随读序翻转
    expect(second).toHaveLength(1);
    expect(second[0].confidence, '完整度信号不许第一次读 false、第二次读 true').toBe(first[0].confidence);
    expect(second[0].authority).toBe(first[0].authority);
    expect(second[0].review).toBe(first[0].review);
    expect(first[0].confidence, '坏页无法证明正文完整：判 false，两轮都 false').toBe(false);
  });

  it('C2 负控制：好页的信号照常算出，接入后不得把好页判成坏页', async () => {
    await writeRaw('entities/good-c2.md', goodBytes('C2'));
    const [sig] = await buildRefSignals(['entities/good-c2.md'], vault, {
      refs: { authorityMap: { web: 'high' } },
    } as never);
    expect(sig.authority, '好页权威度照常来自 source').toBe('high');
    expect(sig.confidence, '好页正文非空 → 完整度 true').toBe(true);
  });
});

describe('D · MCP vault_read_page 的坏页要有可读结论且两轮一致', () => {
  async function readPage(rel: string): Promise<{ isError: boolean; text: string }> {
    const r = await callTool('vault_read_page', { path: rel }, mcpCtx);
    return { isError: r.isError, text: r.content.map((c) => c.text ?? '').join('') };
  }

  it('D1 坏页：返回单行可读的「该页元信息解析失败」，冷读与热读完全一致', async () => {
    const badAbs = await writeRaw('entities/bad-d1.md', badBytes('D1'));
    const cold = await readPage('entities/bad-d1.md');
    await touchKeepingBytes(badAbs);
    const warm = await readPage('entities/bad-d1.md');

    expect(cold.isError, '坏页必须报错，而不是返回一份空元信息页').toBe(true);
    expect(warm.isError, '热读也必须同样报错——同一页两种结论是本单的病灶').toBe(true);
    expect(cold.text).toContain('该页元信息解析失败');
    expect(cold.text).toContain('entities/bad-d1.md');
    expect(cold.text.split('\n')).toHaveLength(1);
    expect(warm.text).toBe(cold.text);
  });

  it('D2 负控制：好页照常返回 frontmatter 与正文，接入不误伤', async () => {
    await writeRaw('entities/good-d2.md', goodBytes('D2'));
    const r = await readPage('entities/good-d2.md');
    expect(r.isError).toBe(false);
    const parsed = JSON.parse(r.text) as { frontmatter: Record<string, unknown>; body: string };
    expect(parsed.frontmatter.source).toBe('web');
    expect(parsed.body).toContain('唯一标记D2');
  });
});

describe('E · 结构锁：四文件只接收敛层，不留私有绕法', () => {
  it('E1 目标文件内不存在「不带 options 的 matter(」调用点', async () => {
    const offenders: string[] = [];
    for (const { label, file } of TARGET_SRCS) {
      const raw = await fs.readFile(file, 'utf8');
      const maskedLines = maskComments(raw).split(/\r?\n/);
      const rawLines = raw.split(/\r?\n/);
      maskedLines.forEach((line, idx) => {
        for (const m of line.matchAll(/(?<![\w$.])matter\(/g)) {
          const tail = line.slice(m.index);
          if (/,\s*\{\s*\}/.test(tail) || /,\s*NO_CACHE_OPTIONS/.test(tail)) continue;
          offenders.push(`${label} L${idx + 1}: ${rawLines[idx].trim()}`);
        }
      });
    }
    expect(offenders, '整页解析一律走 utils/frontmatter 收敛层').toEqual([]);
  });

  it('E2 目标文件都从收敛层导入解析入口（不是各自 import gray-matter 硬撑）', async () => {
    // 按「解析后的真实目标」判定，而不是按字符串里有没有 utils/：
    // ref-signal.ts 自己就在 utils/ 下，合法写法是 './frontmatter.js'——用路径匹配会把它误判成没接入。
    for (const { label, file } of TARGET_SRCS) {
      const src = await fs.readFile(file, 'utf8');
      const spec = /from\s+["']([^"']*frontmatter\.js)["']/.exec(src)?.[1];
      const resolved = spec === undefined
        ? ''
        : path.resolve(path.dirname(file), spec).replace(/\.js$/, '.ts');
      expect(resolved, `${label} 必须引用收敛层 utils/frontmatter`).toBe(FRONTMATTER_TS);
      expect(/import\s+matter\s+from\s+["']gray-matter["']/.test(src), `${label} 不该再直连 gray-matter`).toBe(false);
    }
  });

  it('E3 记账口不许被顺手拆掉：legacy 侧仍把坏页交给 badPageSink', async () => {
    const src = maskComments(await fs.readFile(TARGET_SRCS[0].file, 'utf8'));
    expect(src).toContain('badPageSink?.push');
    expect(src).toContain('frontmatter 解析失败已跳过');
  });
});
