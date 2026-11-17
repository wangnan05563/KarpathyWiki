// T04504 全库守护锁：api/src 下不允许再出现「直连 gray-matter 解析」的调用点。
// ------------------------------------------------------------------
// 为什么要锁到全库口径：T04454/T04502/T04503/T04504 四次修的都是同一件事——matter() 不带 options
// 时启用内容缓存，而缓存条目是在解析**之前**写进去的，坏 YAML 会留下 data:{} 的半成品；同字节第二
// 次读「解析成功」且元信息为空。逐点接入 utils/frontmatter 之后，必须让「新代码再写一遍直连解析」
// 当场变红，否则同样的缺陷会在下一个入口重新长出来。
// 判定口径：
//   · 违规 = 出现裸 `matter(` 解析调用（不含前缀 `.`/标识符字符），且不在注释里；
//   · 写侧 `matter.stringify(...)` 不读内容缓存，合法，不得误报；
//   · 白名单只剩收敛层 utils/frontmatter.ts 自己（它就是 matter() 的唯一封装点）。
// 守护写法仿 test/frontmatter-cache-isolation.test.ts：自检用例（能识别违规、不误识别 stringify）
// + 全库扫描用例 + 「扫描真的走到了文件」的反空转用例。
import { describe, expect, it } from 'vitest';
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const srcDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', 'src');
const CONVERGENCE_LAYER = path.join('utils', 'frontmatter.ts');
// 逐行豁免标记：确需保留的调用点必须就地写明理由，白名单不靠文件级豁免膨胀
const ALLOW_MARK = 'c04504-allow';

/**
 * 把源码里的注释抹成空格（换行保留 ⇒ 行号不变），字符串/模板字面量原样留下。
 * 这些文件的注释里满是 matter() 字样（解释「原来直连 matter() 会怎样」），不抹掉就会把说明文字当调用点。
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

/** 找出裸解析调用点：`matter(` 前面不能是 `.` 或标识符字符（否则是 x.matter( 之类的别家方法） */
function findParseCalls(rel: string, src: string): string[] {
  const maskedLines = maskComments(src).split(/\r?\n/);
  const rawLines = src.split(/\r?\n/);
  const hits: string[] = [];
  maskedLines.forEach((line, idx) => {
    const raw = rawLines[idx] ?? '';
    if (raw.includes(ALLOW_MARK)) return;
    for (const m of line.matchAll(/(?<![\w$.])matter\s*\(/g)) {
      hits.push(`${rel}:${idx + 1} → ${raw.trim()}`);
    }
  });
  return hits;
}

interface SrcFile {
  rel: string;
  text: string;
}

/** 走全库 .ts（排除 .test.ts 与 dist 之外的构建产物）：与 frontmatter-cache-isolation.test.ts 同口径 */
async function collectSrcFiles(): Promise<SrcFile[]> {
  const entries = await fs.readdir(srcDir, { recursive: true, encoding: 'utf-8' });
  return Promise.all(
    (entries as string[])
      .filter((f) => f.endsWith('.ts') && !f.endsWith('.test.ts'))
      .map(async (f) => {
        const rel = f.replace(/\\/g, '/');
        return { rel, text: await fs.readFile(path.join(srcDir, f), 'utf-8') };
      }),
  );
}

describe('守护规则本身（不空转、不误伤写侧）', () => {
  it('G1 能识别裸解析调用，不误识别 matter.stringify / 成员方法 / 注释文字', () => {
    const sample = [
      "import matter from 'gray-matter';", // 0：import 不是调用
      'const parsed = matter(raw);', // 1：违规
      'return matter.stringify(body, data);', // 0：写侧
      'const x = wrapper.matter(raw);', // 0：别人的方法
      '// 原来直连 matter() 时会拿到空 data', // 0：注释
      '/* 多行说明 matter(raw)', // 0：块注释
      ' * 里也提到 matter(x2) 的坑 */',
      "const tip = 'matter(unrelated)';", // 1：字符串里的同形文本按「可能是真调用」保守计红——故确需保留须显式标 c04504-allow
      'matter(content).data', // 1：违规
    ].join('\n');
    const hits = findParseCalls('probe.ts', sample);
    // 3 处真调用点：matter(raw) / 字符串里的同形文本 / matter(content).data
    expect(hits).toHaveLength(3);
    expect(hits.some((h) => h.includes('matter.stringify'))).toBe(false);
    expect(hits.some((h) => h.includes('wrapper.matter'))).toBe(false);
    expect(hits.some((h) => h.includes('原来直连'))).toBe(false);
    expect(hits.some((h) => h.includes('里也提到'))).toBe(false);
    // 字符串字面量里的同形文本按「可能是真调用」保守计红：宁可逼人写 c04504-allow，也不放过漏网点
    expect(hits.some((h) => h.includes('matter(unrelated)'))).toBe(true);
  });

  it('G2 豁免标记生效：带 c04504-allow 的行不进门', () => {
    const hits = findParseCalls('probe.ts', 'const p = matter(raw); // c04504-allow 理由见工单');
    expect(hits).toEqual([]);
  });

  it('G3 扫描真的走到了文件，且写侧调用点确实存在（allow 不是恒绿的空话）', async () => {
    const files = await collectSrcFiles();
    expect(files.length, 'api/src 下 .ts 文件数量级不对：目录走查失效，守护会退化成空转').toBeGreaterThan(80);
    expect(files.some((f) => f.rel === 'routes/files.ts')).toBe(true);
    expect(files.some((f) => f.rel === CONVERGENCE_LAYER.replace(/\\/g, '/'))).toBe(true);

    const stringifySites = files.flatMap((f) => (f.text.match(/matter\s*\.\s*stringify\s*\(/g) ?? []).map(() => f.rel));
    expect(stringifySites.length, '写侧 matter.stringify 调用点应当广泛存在——本用例要证明守护不会把它们一起判红').toBeGreaterThanOrEqual(
      5,
    );
  });
});

describe('全库口径锁', () => {
  // 逐文件串行 readFile（api/src 下 ~120 个 .ts）：与其他用例并发跑时默认 5 s 预算会卡住，按实测放宽
  it('G4 api/src 下不再有直连 gray-matter 的解析调用（白名单只剩收敛层）', { timeout: 60_000 }, async () => {
    const files = await collectSrcFiles();
    const offenders = files
      .filter((f) => f.rel !== CONVERGENCE_LAYER.replace(/\\/g, '/'))
      .flatMap((f) => findParseCalls(f.rel, f.text));

    expect(offenders, '整页/整块解析一律走 utils/frontmatter 的 parsePage / tryParsePage').toEqual([]);
  });

  it('G5 仍 import gray-matter 的源文件只允许写侧用法', { timeout: 60_000 }, async () => {
    const files = await collectSrcFiles();
    const importers = files.filter((f) =>
      /from\s+['"]gray-matter['"]/.test(f.text),
    );
    const bad = importers
      .filter((f) => f.rel !== CONVERGENCE_LAYER.replace(/\\/g, '/'))
      .filter((f) => findParseCalls(f.rel, f.text).length > 0);
    expect(bad.map((f) => f.rel), '这些文件还在用 gray-matter 解析：要么接收敛层，要么去掉 import').toEqual([]);
    // 反向证明扫描面覆盖到真实写侧文件（否则上面那条空数组没有意义）
    expect(importers.length).toBeGreaterThan(1);
  });

  it('G6 本单点名的读点都从收敛层拿解析入口（按解析后的真实模块路径判定）', async () => {
    const convergenceAbs = path.join(srcDir, CONVERGENCE_LAYER);
    const readers = [
      'routes/files.ts',
      'vault/vault-service.ts',
      'vault/page-write-guard.ts',
      'skill/skill-service.ts',
      'workflows/compile-workflow.ts',
      'workflows/discover-workflow.ts',
      'data-clean/misplaced-pages.ts',
      'data-clean/quality-scanner.ts',
      // T04503 已接入的四处在内：一起锁住，防止后续重构把它们退回直连
      'search-util.ts',
      'search/indexed-search.ts',
      'utils/ref-signal.ts',
      'mcp/tools.ts',
    ];
    for (const rel of readers) {
      const file = path.join(srcDir, ...rel.split('/'));
      const text = await fs.readFile(file, 'utf8');
      const spec = /from\s+["']([^"']*frontmatter\.js)["']/.exec(text)?.[1];
      const resolved = spec === undefined ? '' : path.resolve(path.dirname(file), spec).replace(/\.js$/, '.ts');
      expect(resolved, `${rel} 必须引用收敛层 utils/frontmatter`).toBe(convergenceAbs);
    }
  });
});
