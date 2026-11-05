// T04454：坏 frontmatter 页的容错口径，以及 gray-matter「缓存吞掉失败解析」的确定性锁。
//
// 机制（node_modules/gray-matter/index.js:35-47 实测，非推断）：matter() 先把 toFile 造出来的
// 半成品写进 matter.cache（此时 data 还是 {}），随后才在 YAML 引擎里抛异常。缓存条目已经留下，
// 于是同一串字节在本进程里：
//   第 1 次读 → 抛异常；第 2 次起 → 「解析成功」并返回 data:{}。
// 后果分两类，都必须锁住：
//   ① 靠 catch 判坏页的地方，第二次读不再进 catch——坏页以「没有任何元数据」的身份继续参与过滤、
//      评分、范围限定，症状「自己好了」，现场无法复现；
//   ② 没兜住异常的地方，第一轮整批连坐 reject（同 T04176 检索侧结论），而下一轮又静默放行。
// 修法是把缓存整条绕开：缓存只在 options === undefined 时启用，收敛层显式传 options
// （defaults({language:'yaml'}) 与 defaults(undefined) 同值，不改解析语义），
// 于是「同一串字节 → 同一结论」，与本进程第几次读无关。
//
// 本文件五条腿：
//   A 机制复现（库行为 tripwire）：坏字节第 1 次抛、第 2 次返回空 data —— 若上游修掉了缓存，这条会红，
//     那时才允许重新评估「显式传 options」是否还必要；
//   B 确定性：收敛层对同一串坏字节两次都得同样结论（严格入口两次都抛、容错入口两次都 ok:false）；
//   C 不许过度收紧：合法但「元信息为空」的三种形状（空块 / 只有注释 / 没有头）必须照常 ok:true，
//     正文里出现 --- 分隔线也不得被误判成坏页；
//   D 绕开缓存的行为证据：走收敛层解析后 gray-matter 的内容缓存不增长，而直调 matter() 会增长；
//   E 活锁：一跳图拓（expandNeighbors）里夹一个坏页邻居 → 不抛、跳过它、其余邻居照常返回。
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterAll, afterEach, beforeEach, describe, expect, it } from 'vitest';
import matter from 'gray-matter';

import { parsePage, tryParsePage } from '../src/utils/frontmatter.js';
import { expandNeighbors, extractTitleAndSnippet } from '../src/search/graph-expand.js';
import { VaultService } from '../src/vault/vault-service.js';

const SRC = (rel: string) => path.resolve(__dirname, '..', 'src', rel);

// gray-matter 的 .d.ts 只声明了 matter/stringify，而 cache/clearCache 是运行时才挂上去的
// （index.js:224-227）。这里按运行时真实形状取用，只为观测「缓存有没有被绕开」。
const gm = matter as unknown as { cache: Record<string, unknown>; clearCache(): void };

/** 实测会抛异常的四种坏形状（每种都第 1 次抛、第 2 次静默返回空 data） */
const BROKEN: Record<string, string> = {
  未闭合流: ['---', 'title: 坏页', 'tags: [未闭合,', '---', '', '正文'].join('\n'),
  裸冒号: ['---', 'title: 冒号: 坏值', '---', '', '正文'].join('\n'),
  重复键: ['---', 'title: 甲', 'title: 乙', '---', '', '正文'].join('\n'),
  缩进错: ['---', 'title: 甲', '  nested: 乙', '---', '', '正文'].join('\n'),
};

/** 合法但元信息为空的三种形状：容错口径不许把它们当成坏页跳过 */
const EMPTY_BUT_VALID: Record<string, string> = {
  空块: ['---', '---', '', '正文'].join('\n'),
  只有注释: ['---', '# 只有注释', '---', '', '正文'].join('\n'),
  没有头: ['# 标题', '', '正文'].join('\n'),
};

// 每个用例独有的字节：gray-matter 的缓存键是整段内容，共字节会把上一例的条目漏给下一例
function uniqueBytes(tag: string): string {
  return ['---', `title: 好页-${tag}`, 'type: concept', '---', '', `正文-${tag}`].join('\n');
}

afterAll(() => {
  gm.clearCache();
});

describe('T04454 · 机制：gray-matter 把失败的解析缓成「空元信息页」', () => {
  it('A · 同一串坏字节：第 1 次抛异常，第 2 次静默返回 data:{}（tripwire）', () => {
    for (const [name, raw] of Object.entries(BROKEN)) {
      gm.clearCache();
      // 第 1 次：坏 YAML 一定抛
      let first = 'not-throw';
      try {
        matter(raw);
        first = 'ok';
      } catch {
        first = 'throw';
      }
      // 第 2 次：同字节命中缓存半成品，不抛且 data 为空
      let second: unknown = 'not-throw';
      try {
        second = matter(raw).data;
      } catch {
        second = 'throw';
      }
      expect(first, `${name}：第 1 次读应当抛异常`).toBe('throw');
      expect(second, `${name}：第 2 次读若还抛，说明上游修掉了缓存——本单的「显式传 options」可以再评估`).toEqual({});
    }
  });
});

describe('T04454 · 收敛层：同一串字节必须得到同一结论', () => {
  it('B1 · 严格入口 parsePage 对坏页两次都抛（不再「第二次自己好了」）', () => {
    for (const [name, raw] of Object.entries(BROKEN)) {
      const verdict = (label: string) => {
        try {
          parsePage(raw);
          return `${label}:ok`;
        } catch {
          return `${label}:throw`;
        }
      };
      expect(verdict('第一次'), name).toBe('第一次:throw');
      expect(verdict('第二次'), `${name}：第二次读被缓成空元信息页，过滤/评分会静默换口径`).toBe('第二次:throw');
    }
  });

  it('B2 · 容错入口 tryParsePage 对坏页两次都 ok:false，且带可读原因', () => {
    for (const [name, raw] of Object.entries(BROKEN)) {
      const first = tryParsePage(raw);
      const second = tryParsePage(raw);
      expect(first.ok, `${name}：第一次读应判坏页`).toBe(false);
      expect(second.ok, `${name}：第二次读必须同样判坏页（本单核心不变量）`).toBe(false);
      if (!first.ok && !second.ok) {
        expect(first.reason.length, '原因要能进聚合日志，不能是空串').toBeGreaterThan(0);
        // 同一字节 → 同一结论：两次判定的 reason 也一致，便于「现场两次日志对得上」
        expect(second.reason, name).toBe(first.reason);
      }
    }
  });

  it('C · 不过度收紧：合法但元信息为空的形状照常 ok，正文里的 --- 分隔线不算坏页', () => {
    for (const [name, raw] of Object.entries(EMPTY_BUT_VALID)) {
      const first = tryParsePage(raw);
      const second = tryParsePage(raw);
      expect(first.ok, `${name}：这是合法页面，不许当坏页跳过`).toBe(true);
      expect(second.ok, name).toBe(true);
      if (first.ok && second.ok) {
        expect(first.data).toEqual({});
        expect(second.data).toEqual({});
      }
    }
    // 正文含分隔线/代码围栏的合法页：头的判定只看开头，正文里的 --- 不得牵连
    const withRule = ['---', 'title: 分隔线页', '---', '', '第一段', '', '---', '', '第二段'].join('\n');
    const parsed = tryParsePage(withRule);
    expect(parsed.ok).toBe(true);
    if (parsed.ok) expect(parsed.content).toContain('第二段');
    // 好页两次同结论，且数据不脱手（T03647 的脱钩语义不许因绕开缓存而倒退）
    const raw = uniqueBytes('脱钩');
    const a = tryParsePage(raw);
    expect(a.ok).toBe(true);
    if (a.ok) {
      (a.data as { tags?: string[] }).tags = ['写进副本'];
    }
    const b = tryParsePage(raw);
    expect(b.ok).toBe(true);
    if (b.ok) expect(b.data.tags).toBeUndefined();
  });

  it('D · 行为证据：走收敛层不写 gray-matter 缓存，直调才会写', () => {
    const raw = uniqueBytes('缓存观测');
    gm.clearCache();
    parsePage(raw);
    tryParsePage(raw);
    expect(Object.keys(gm.cache).length, '收敛层解析过的字节不该留下缓存条目（缓存被绕开才是确定性来源）').toBe(0);
    matter(raw);
    expect(Object.keys(gm.cache)).toContain(raw);
  });
});

describe('T04454 · 批处理入口：一页写坏不许连坐整轮', () => {
  let vaultDir = '';
  let vault: VaultService;

  function writePage(rel: string, body: string): void {
    const abs = path.join(vaultDir, rel);
    mkdirSync(path.dirname(abs), { recursive: true });
    writeFileSync(abs, body, 'utf8');
  }

  beforeEach(() => {
    vaultDir = mkdtempSync(path.join(tmpdir(), 'wiki-t04454-'));
    vault = new VaultService(vaultDir);
    // 命中页 a 指向三个邻居：两个好页 + 一个坏 YAML 头页面
    writePage('concepts/a.md', '# 甲页\n\n甲页正文 alpha。\n\n参见 [[b1]]、[[bad]]、[[b2]]。');
    writePage('concepts/b1.md', '# 邻居一\n\n邻居一正文。参见 [[a]]。');
    writePage('concepts/b2.md', '# 邻居二\n\n邻居二正文。参见 [[a]]。');
    writePage('concepts/bad.md', `${BROKEN.未闭合流}\n\n坏页正文。参见 [[a]]。`);
  });

  it('E · 邻居里夹坏页：expandNeighbors 不抛，跳过坏页并返回其余邻居', async () => {
    const limits = { enabled: true, maxNeighbors: 3, charsPerPage: 200, totalChars: 900 };
    const neighbors = await expandNeighbors(vault, ['concepts/a.md'], limits);
    const paths = neighbors.map((n) => n.path).sort();
    expect(
      paths,
      '坏 YAML 头的邻居必须被跳过（本模块注释承诺「单页失败直接跳过，不阻断问答」），其余两页照常返回',
    ).toEqual(['concepts/b1.md', 'concepts/b2.md']);
    expect(neighbors.every((n) => n.snippet !== ''), '返回的邻居都要有摘要').toBe(true);
  });

  it('E2 · 纯函数层：坏页正文按空处理，好页口径不变', () => {
    const broken = extractTitleAndSnippet(BROKEN.裸冒号, 'concepts/x.md', 200);
    expect(broken.snippet, '坏页没有可信正文 → 空摘要，调用方据此跳过').toBe('');
    const good = extractTitleAndSnippet(['# 好页', '', '这是一段摘要正文。'].join('\n'), 'concepts/y.md', 200);
    expect(good.title).toBe('好页');
    expect(good.snippet).toBe('这是一段摘要正文。');
  });

  afterEach(() => {
    rmSync(vaultDir, { recursive: true, force: true });
  });
});

describe('T04454 · 口径锁：解析只能走带 options 的收敛层', () => {
  it('收敛层的 gray-matter 调用都显式传 options（缓存绕开不许被改回去）', () => {
    const src = readFileSync(SRC('utils/frontmatter.ts'), 'utf8');
    const calls = src.match(/matter\(/g) ?? [];
    const withOptions = src.match(/matter\([^)\n]*,\s*NO_CACHE_OPTIONS\)/g) ?? [];
    expect(calls.length, '本文件应当只有 parsePage 一处解析调用').toBe(1);
    expect(withOptions.length, '解析调用没传 options＝重新启用缓存＝坏页第二次读静默放行').toBe(1);
  });

  it('一跳图拓不再直连 gray-matter（批处理入口走收敛层）', () => {
    const src = readFileSync(SRC('search/graph-expand.ts'), 'utf8');
    expect(src, '图拓要经 tryParsePage，才有「同一字节同一结论」的容错口径').not.toContain("from 'gray-matter'");
    expect(src).toContain('tryParsePage');
  });
});
