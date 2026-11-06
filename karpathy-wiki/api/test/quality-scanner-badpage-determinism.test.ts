// T04502：体检/清洗这条链上的坏 YAML 页判定必须只由字节决定，与「本进程第几次读」无关。
// ------------------------------------------------------------------
// 机制（T04454 已在 frontmatter-tolerance.test.ts 里钉住库行为）：gray-matter 的 matter() 是
// 「先写缓存、后解析」，缓存条目由 toFile 造出来时就带 data:{}，坏 YAML 在随后的引擎里抛异常，
// data 永远停在 {}，缓存却已收下这个半成品。于是同一串字节第一次读抛、第二次起「解析成功」并返回空 data。
// 本文件把这条机制落到体检/清洗的四个出口上（判定分叉都是代码层实测，非推测）：
//   A scanVault      —— 冷：走 catch → 0 分 + SCAN_ERROR；热：以「缺元信息」身份被打分 → 列表规模锁漂移
//   B precheckVault  —— 冷：readPrecheckPage 抛 → 该页根本不进 scannedFiles/errors
//                       热：进 precheck 但 L637 的 matter() 也不抛 → 既不记 error 也不 block
//                       也就是「坏页永远拦不住清洗门」，本单要求两处都记 error 且 blocked=true
//   C fixFrontmatter —— 冷：errors 记账跳过；热：data:{} → 补齐字段后 matter.stringify 落盘，
//                       把原来那段（虽然写坏但仍是元信息）的 YAML 头整块丢掉，形成假修复
//   D mergeDuplicatePages —— 冷：Merge failed；热：坏页元信息当空合并，updatesApplied+1
// 取证手法：同一串字节只改 mtime（页面签名 = 路径 + mtimeMs + size，变签名而不改内容），
// 显式 resetPageSnapshot 让 DerivedCache 重算；gray-matter 的缓存键是内容，因此第二轮必然命中缓存。
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import matter from 'gray-matter';

import { VaultService } from '../src/vault/vault-service.js';
import type { DuplicatePair, PageQualityScore } from '../src/types.js';
import { resetPageSnapshot } from '../src/utils/derived-cache.js';
import {
  fixFrontmatter,
  mergeDuplicatePages,
  precheckVault,
  scanVault,
} from '../src/data-clean/quality-scanner.js';

const SCANNER_SRC = path.resolve(__dirname, '..', 'src', 'data-clean', 'quality-scanner.ts');

// gray-matter 的 .d.ts 只声明 matter/stringify，cache/clearCache 是运行时才挂上去的
const gm = matter as unknown as { clearCache(): void };

/** 实测会抛的坏形状（裸冒号），tag 保证每个用例字节唯一——缓存键是整段内容，共字节会串例 */
function badBytes(tag: string): string {
  return [
    '---',
    `title: ${tag}: 裸冒号坏值`,
    'tags: [未闭合,',
    '---',
    '',
    `正文 ${tag} 若干 词汇 这里 还有 一个 双链 [[邻居页]] 用来抬高热缓存那一轮的字数与链接分`,
    '',
  ].join('\n');
}

function goodBytes(tag: string): string {
  return ['---', `title: 好页-${tag}`, 'type: concept', '---', '', `正文-${tag}`].join('\n');
}

/**
 * 把源码里的注释抹成空格（换行保留 ⇒ 行号不变），字符串/模板字面量原样留下。
 * 结构锁只该看「真实调用点」：本文件与源文件的注释里满是 matter()、mergeDuplicateFrontmatter( 字样，
 * 不抹掉就会把说明文字当成调用点，锁红得没有意义。
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
let vault: VaultService;

async function writeRaw(rel: string, text: string): Promise<string> {
  const abs = path.join(vaultDir, ...rel.split('/'));
  await fs.mkdir(path.dirname(abs), { recursive: true });
  await fs.writeFile(abs, text, 'utf8');
  resetPageSnapshot();
  return abs;
}

/** 只动 mtime：页面签名（路径+mtimeMs+size）变化而字节不变 ⇒ 第二轮必然命中 gray-matter 内容缓存 */
async function touchKeepingBytes(abs: string): Promise<void> {
  const st = await fs.stat(abs);
  const t = new Date(st.mtimeMs + 1000);
  await fs.utimes(abs, t, t);
  resetPageSnapshot();
}

function scorePage(rel: string, title: string): PageQualityScore {
  const directory = rel.split('/')[0];
  return {
    path: rel,
    title,
    qualityScore: 60,
    category: { length: 20, links: 25, frontmatter: 25, citations: 20, duplicate: 0, freshness: 10 },
    metadata: {
      wordCount: 10, lineCount: 5, internalLinks: 0, inboundLinks: 0, lastModified: '',
      hasFrontmatter: true, isDraft: false, fileSizeBytes: 10, hasBom: false, encoding: 'utf-8', directory,
    },
    issues: [],
    suggestions: [],
  };
}

beforeAll(async () => {
  tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'kb-qsbp-'));
  vaultDir = path.join(tempDir, 'vault');
  vault = new VaultService(vaultDir);
  await vault.init();
});

afterAll(async () => {
  gm.clearCache();
  await fs.rm(tempDir, { recursive: true, force: true });
});

describe('T04502 · A 体检评分：坏页判定与第几次读脱钩', () => {
  it('同一串坏字节两轮扫描结论一致，且始终 0 分 + SCAN_ERROR 记账（不退化成「低分正常页」）', async () => {
    const rel = 'entities/bad-scan.md';
    const abs = await writeRaw(rel, badBytes('scan'));
    gm.clearCache();

    const first = (await scanVault(vault)).find((p) => p.path === rel);
    await touchKeepingBytes(abs);
    const second = (await scanVault(vault)).find((p) => p.path === rel);

    expect(first, '第一轮必须读到该页').toBeTruthy();
    expect(second, '第二轮必须同样读到该页').toBeTruthy();
    expect(
      second!.qualityScore,
      '第二轮不得因缓存半成品变成「按缺元信息打分的正常页」——同一次运行里先扫一遍再扫一遍，列表规模会漂移',
    ).toBe(first!.qualityScore);
    expect(first!.qualityScore, '坏 YAML 页判 0 分').toBe(0);
    expect(first!.issues.map((i) => i.code), '坏页必须留可见记账，不许静默过滤').toContain('SCAN_ERROR');
    expect(second!.issues.map((i) => i.code)).toContain('SCAN_ERROR');
    expect(first!.metadata.hasFrontmatter, '坏页不算有元信息').toBe(false);
    expect(second!.metadata.hasFrontmatter).toBe(false);
  });

  it('好页不受影响：两轮都得同一非零判定，且有元信息（防「一律判坏」的过度收紧）', async () => {
    const rel = 'entities/good-scan.md';
    const abs = await writeRaw(rel, goodBytes('scan'));
    gm.clearCache();
    const first = (await scanVault(vault)).find((p) => p.path === rel);
    await touchKeepingBytes(abs);
    const second = (await scanVault(vault)).find((p) => p.path === rel);
    expect(second!.qualityScore).toBe(first!.qualityScore);
    expect(first!.metadata.hasFrontmatter).toBe(true);
    expect(first!.qualityScore, '好页有正文 + 双链，不该 0 分').toBeGreaterThan(0);
    expect(first!.issues).toEqual([]);
  });
});

describe('T04502 · B 前置校验：坏页必须被数进来、记 error 且 blocked', () => {
  it('冷/热两轮预检都把坏页计入 scannedFiles，并记 Invalid YAML frontmatter 且 blocked=true', async () => {
    const rel = 'entities/bad-precheck.md';
    const abs = await writeRaw(rel, badBytes('precheck'));
    gm.clearCache();

    const first = await precheckVault(vault);
    await touchKeepingBytes(abs);
    const second = await precheckVault(vault);

    for (const [label, r] of [['第一次', first], ['第二次', second]] as const) {
      expect(r.scannedFiles, `${label}：该页必须进入覆盖面（不许因解析失败被丢）`).toBe(first.scannedFiles);
      const line = r.errors.find((e) => e.startsWith(rel));
      expect(line, `${label}：坏页必须在 errors 里可见`).toBeTruthy();
      expect(line!, `${label}：错误文案要指到 frontmatter`).toContain('Invalid YAML frontmatter');
      expect(r.blocked, `${label}：坏 YAML 页必须拦住清洗/编译门，不许把「不抛」当「通过」`).toBe(true);
      expect(r.passed, 'errors 非空 ⇒ 预检不算通过').toBe(false);
    }
    expect(
      second.errors.find((e) => e.startsWith(rel)),
      '两轮错误文案必须逐字一致（含 reason）',
    ).toBe(first.errors.find((e) => e.startsWith(rel)));
  });

  it('干净库仍不得凭空造出 blocked（防接入把好页误判成坏页）', async () => {
    const rel = 'entities/clean-only.md';
    await writeRaw(rel, goodBytes('clean'));
    const r = await precheckVault(vault);
    expect(r.errors.find((e) => e.startsWith(rel)), '好页不进 errors').toBeUndefined();
    expect(r.scannedFiles, '好页计入').toBeGreaterThanOrEqual(1);
  });
});

describe('T04502 · C 补元信息：坏页不许被「假修复」', () => {
  it('同一坏页两轮 dry-run 结论一致：跳过并记账，而不是补齐字段', async () => {
    const rel = 'entities/bad-fix.md';
    await writeRaw(rel, badBytes('fix'));
    gm.clearCache();

    const first = await fixFrontmatter(vault, [rel], true);
    const second = await fixFrontmatter(vault, [rel], true);

    expect(second.fixed.map((f) => f.path), '第二轮不得突然变成「可补齐」').toEqual(first.fixed.map((f) => f.path));
    expect(first.fixed, '坏 YAML 页不得被当成可补齐页面').toEqual([]);
    expect(second.fixed, '坏 YAML 页不得被当成可补齐页面').toEqual([]);
    expect(first.errors.join('|'), '第一轮必须记账').toContain(rel);
    expect(second.errors.join('|'), '第二轮必须同样记账').toContain(rel);
  });

  it('真实写盘（dryRun=false）也不得改动坏页字节：假修复会整块丢掉原 YAML 头', async () => {
    const rel = 'entities/bad-fix-write.md';
    const abs = await writeRaw(rel, badBytes('fixwrite'));
    const before = await fs.readFile(abs, 'utf8');
    gm.clearCache();
    await fixFrontmatter(vault, [rel], false);
    await fixFrontmatter(vault, [rel], false);
    const after = await fs.readFile(abs, 'utf8');
    expect(after, '两轮之后字节必须原样（第二轮命中缓存时若不判坏，就会把坏 YAML 头改掉再落盘）').toBe(before);
  });

  it('好页照常可补齐（防止把 fixFrontmatter 整条堵死）', async () => {
    const rel = 'entities/needs-fix.md';
    const abs = await writeRaw(rel, ['---', 'title: 缺类型页', '---', '', '正文'].join('\n'));
    const first = await fixFrontmatter(vault, [rel], true);
    const second = await fixFrontmatter(vault, [rel], true);
    expect(first.fixed.map((f) => f.path)).toContain(rel);
    expect(second.fixed.map((f) => f.path)).toEqual(first.fixed.map((f) => f.path));
    expect(second.errors).toEqual([]);
    const after = await fs.readFile(abs, 'utf8');
    expect(after, 'dryRun 不写盘').toContain('title: 缺类型页');
  });
});

describe('T04502 · D 合并比对：坏页参与合并不落盘且结论稳定', () => {
  it('A 侧坏页：两轮都记 Merge failed、updatesApplied 恒为 0', async () => {
    const badRel = 'entities/bad-merge-a.md';
    const goodRel = 'entities/good-merge-b.md';
    await writeRaw(badRel, badBytes('merge'));
    await writeRaw(goodRel, goodBytes('merge'));
    const pair: DuplicatePair = {
      pageA: scorePage(badRel, '坏页A'),
      pageB: scorePage(goodRel, '好页B'),
      similarity: 0.95,
      matchType: 'exact',
      reason: 'T04502 取证',
    };
    gm.clearCache();
    const first = await mergeDuplicatePages(vault, pair, false, true);
    const second = await mergeDuplicatePages(vault, pair, false, true);

    expect(second.updatesApplied, '第二轮不得因缓存半成品而「合并成功」').toBe(first.updatesApplied);
    expect(first.updatesApplied, 'A 侧坏页不得落合并结果').toBe(0);
    expect(first.errors.length, '必须记账').toBeGreaterThan(0);
    expect(second.errors).toEqual(first.errors);
  });

  it('两侧都好：照常合并成功（防过度收紧把去重整条堵死）', async () => {
    const a = 'entities/merge-ok-a.md';
    const b = 'entities/merge-ok-b.md';
    await writeRaw(a, goodBytes('oka'));
    await writeRaw(b, goodBytes('okb'));
    const pair: DuplicatePair = {
      pageA: scorePage(a, '好页甲'), pageB: scorePage(b, '好页乙'),
      similarity: 0.9, matchType: 'exact', reason: 'T04502 好页腿',
    };
    const first = await mergeDuplicatePages(vault, pair, false, true);
    expect(first.errors).toEqual([]);
    expect(first.updatesApplied).toBe(1);
  });
});

describe('T04502 · E 结构锁：整页解析必须走收敛层', () => {
  const srcPromise = fs.readFile(SCANNER_SRC, 'utf8');

  it('quality-scanner 从收敛层取严格/容错两个入口', async () => {
    const src = await srcPromise;
    expect(src, '必须引用 utils/frontmatter 的收敛层').toMatch(
      /import\s*\{[^}]*tryParsePage[^}]*\}\s*from\s*"\.\.\/utils\/frontmatter\.js"/,
    );
    expect(src).toMatch(/\btryParsePage\(/);
    expect(src).toMatch(/\bparsePage\(/);
  });

  it('不再用不带 options 的 matter( 解析整页（无 options 即启用那个会吞掉失败的缓存）', async () => {
    const src = await srcPromise;
    // 注释里大量出现 matter()/mergeDuplicateFrontmatter( 字样，先把注释与字符串外的部分保住：
    //   注释内容整体抹成空格（换行不动 ⇒ 行号与源文件一致），字符串字面量原样保留。
    const masked = maskComments(src);
    const lines = masked.split(/\r?\n/);
    const offenders: string[] = [];
    lines.forEach((line, idx) => {
      // (?<![...$.]) 排除 mergeDuplicateFrontmatter( 这类「…matter(」结尾的标识符，
      // 也排除 matter.stringify(（写出，不参与缓存）
      for (const m of line.matchAll(/(?<![\w$.])matter\(/g)) {
        const tail = line.slice(m.index);
        // 显式传 options（parseYamlBlock 的 `, {}` / 收敛层的 NO_CACHE_OPTIONS）已绕开缓存，属合规
        if (/,\s*\{\s*\}/.test(tail) || /,\s*NO_CACHE_OPTIONS/.test(tail)) continue;
        offenders.push(`L${idx + 1}: ${src.split(/\r?\n/)[idx].trim()}`);
      }
    });
    expect(offenders, `整页解析必须走 parsePage/tryParsePage：\n${offenders.join('\n')}`).toEqual([]);
  });
});
