// T04504：其余 frontmatter 读点接入收敛层——「同一串字节，第几次读都同一个结论」在剩余出口上的取证。
// ------------------------------------------------------------------
// 机制（T04454 已在 frontmatter-tolerance.test.ts 钉住库行为）：gray-matter 的 matter() 是
// 「先写缓存、后解析」，缓存条目由 toFile 造出来时就带 data:{}，坏 YAML 在随后的引擎里抛异常，
// data 永远停在 {}，缓存却已经收下这个半成品。于是同一串字节第一次读抛、第二次起「解析成功」并返回空 data。
// 本文件把这条机制落到本单点名的出口上，每个红都对应一条逐行读源码核对出来的用户可见症状：
//   A GET /api/files（routes/files.ts:269）
//       冷：YAMLException 没有 code → mapVaultReadError 兜底分支 → HTTP 500 + js-yaml 原文；
//       热：不抛 → 200 + frontmatter:{} →「页面打开了但没有元信息」。同一页两种结论。
//   B splitFrontmatter（vault/page-write-guard.ts:64）
//       热读拿到的 data 是 gray-matter 缓存条目本体（Object.assign 只浅拷贝 File，不动 data），
//       任何一次就地改写都会渗进后续所有同字节读取——而这份 data 正是写守卫的差分基线。
//   C 技能开关（skill/skill-service.ts:488）
//       冷：抛 → return null（拒绝写入，文件不动）；热：不抛、data:{} → 走下去用
//       matter.stringify(body, {enabled}) 整文件重写，name/description 等字段被吃掉。
//       ⇒ 第二次点开关比第一次多点掉的不只是状态，是整个技能元信息。
//   D 编译写页（workflows/compile-workflow.ts:53）
//       取证后的实测修正：把本点还原成修复前的直连 matter()（探针 P5）重放同一串「坏首块 + 第二块」，
//       两轮的落盘字节仍然相同——热读那份缓存半成品的 content 是未剥块的原始串，merge 于是把块 1 当成
//       「第二块」再解析一次、照旧失败。⇒ 本点的分叉在数据上不可观测，可见的守护只剩 G4/G5；
//       D1 因此改成钉「两轮都原样落盘」的实际行为（P8 跳过塌块→D2 红、P9 改写坏块→D1 红，两腿各有抓手）。
//   E vault-service 其余读点 + discover/misplaced
//       这些落点的 catch 恰好把两条读序都归到同一个兜底值，分叉不可直接观测；本文件把它们钉成回归锁
//       （改完必须仍然同结论、好页不许被误判），另外 E1 证明「同字节两页共用同一个 data 引用」确实存在。
// 取证手法与 T04503 相同：字节不变、只推 mtime（VaultService 内容缓存与派生缓存签名按 mtimeMs 判失效，
// 变 mtime + resetPageSnapshot 逼它们重算；gray-matter 的缓存键是内容字节，因此第二轮必然命中缓存）。
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import Fastify, { type FastifyInstance } from 'fastify';
import matter from 'gray-matter';

import { VaultService } from '../src/vault/vault-service.js';
import { PAGE_DIRS } from '../src/vault/page-scope.js';
import { resetPageSnapshot } from '../src/utils/derived-cache.js';
import { registerFilesRoutes } from '../src/routes/files.js';
import { createIsolationGuards } from '../src/middleware/auth.js';
import { splitFrontmatter, writePageSafely } from '../src/vault/page-write-guard.js';
import { createCompileTools } from '../src/workflows/compile-workflow.js';
import { collectAllPageMetadata } from '../src/workflows/discover-workflow.js';
import { detectMisplacedPages } from '../src/data-clean/misplaced-pages.js';

// gray-matter 的 .d.ts 只声明 matter/stringify，cache/clearCache 是运行时才挂上去的
const gm = matter as unknown as { clearCache(): void };

/** 实测会抛的坏形状（裸冒号 + 未闭合流）；tag 保证每腿字节唯一——缓存键是整段内容，共字节会串腿 */
function badBytes(tag: string): string {
  return [
    '---',
    `title: ${tag}: 裸冒号坏值`,
    'tags: [未闭合,',
    '---',
    '',
    `正文 ${tag} 唯一标记${tag}`,
    '',
  ].join('\n');
}

function goodBytes(tag: string, type = 'concept'): string {
  return [
    '---',
    `title: 好页-${tag}`,
    `type: ${type}`,
    'source: web',
    'updated: 2026-10-01',
    'tags:',
    '  - 收敛',
    '---',
    '',
    `正文-${tag} 唯一标记${tag}`,
  ].join('\n');
}

/** 技能入口文件：坏 frontmatter，但正文与其余字段都是真实存在的内容 */
function badSkillBytes(tag: string): string {
  return [
    '---',
    `name: 坏开关技能${tag}: 裸冒号`,
    'description: 这段描述应当逐字保留',
    'enabled: true',
    '---',
    '',
    '# 用法',
    '',
    `正文${tag}`,
    '',
  ].join('\n');
}

let tempDir: string;
let vaultDir: string;
let skillRoot: string;
let vault: VaultService;
let app: FastifyInstance;
let prevSkillRoot: string | undefined;
let svc: typeof import('../src/skill/skill-service.js');

async function writeRaw(rel: string, text: string): Promise<string> {
  const abs = path.join(vaultDir, ...rel.split('/'));
  await fs.mkdir(path.dirname(abs), { recursive: true });
  await fs.writeFile(abs, text, 'utf8');
  resetPageSnapshot();
  return abs;
}

/** 字节不变、只推 mtime：逼 VaultService 内容缓存与派生缓存重算，而 gray-matter 内容缓存必然命中 */
async function touchKeepingBytes(abs: string): Promise<void> {
  const t = (Date.now() + 60_000) / 1000;
  await fs.utimes(abs, t, t);
  resetPageSnapshot();
}

function getFile(rel: string): Promise<{ statusCode: number; json: () => Record<string, any> }> {
  return app.inject({ method: 'GET', url: `/api/files?path=${encodeURIComponent(rel)}` }) as Promise<{
    statusCode: number;
    json: () => Record<string, any>;
  }>;
}

async function wipeVaultPages(): Promise<void> {
  for (const d of PAGE_DIRS) {
    const abs = path.join(vaultDir, d);
    try {
      const entries = await fs.readdir(abs, { withFileTypes: true });
      await Promise.all(
        entries.map(async (e) => {
          if (e.isDirectory()) await fs.rm(path.join(abs, e.name), { recursive: true, force: true });
          else if (e.name.endsWith('.md')) await fs.rm(path.join(abs, e.name), { force: true });
        }),
      );
    } catch {
      // 目录还没建出来：本来就没有页面
    }
  }
  resetPageSnapshot();
}

beforeAll(async () => {
  tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'kb-t04504-'));
  vaultDir = path.join(tempDir, 'vault');
  await fs.mkdir(vaultDir, { recursive: true });
  vault = new VaultService(vaultDir);
  await vault.init();

  app = Fastify({ logger: false });
  // 单租户形态（auth 未启用）：只验端点行为，鉴权接线另有守护
  registerFilesRoutes(app, vault, createIsolationGuards({ enabled: false }));
  await app.ready();

  // skill-service 在模块加载时解析技能根目录，必须在 import 之前指到临时目录，
  // 否则用例会写进用户真实的 data/skills。
  skillRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'kb-t04504-skills-'));
  prevSkillRoot = process.env.API_SKILLS_ROOT;
  process.env.API_SKILLS_ROOT = skillRoot;
  svc = await import('../src/skill/skill-service.js');
});

beforeEach(async () => {
  // gray-matter 的缓存是进程级全局：不清就等于「上一腿的第二次读」变成「这一腿的第一次读」
  gm.clearCache();
  resetPageSnapshot();
  await wipeVaultPages();
});

afterEach(() => {
  vi.restoreAllMocks();
});

afterAll(async () => {
  await app.close();
  if (prevSkillRoot === undefined) delete process.env.API_SKILLS_ROOT;
  else process.env.API_SKILLS_ROOT = prevSkillRoot;
  await fs.rm(tempDir, { recursive: true, force: true });
  await fs.rm(skillRoot, { recursive: true, force: true });
});

describe('A · GET /api/files 的坏页判定必须与读序无关，且与「文件不存在/越界」可区分', () => {
  it('A1 同字节两轮请求同一结论：都是 200 + frontmatter_error，不再冷读 500、热读空元信息', async () => {
    const badAbs = await writeRaw('concepts/bad-a1.md', badBytes('A1'));
    const cold = await getFile('concepts/bad-a1.md');
    await touchKeepingBytes(badAbs);
    const warm = await getFile('concepts/bad-a1.md');

    expect(cold.statusCode, '500 + js-yaml 原文对用户没有意义，且热读根本不是 500').not.toBe(500);
    expect(cold.statusCode).toBe(200);
    expect(warm.statusCode, '同一页第二次打开不得换成另一种结论').toBe(cold.statusCode);

    const c = cold.json();
    const w = warm.json();
    expect(w).toEqual(c);
    expect(c.frontmatter, '坏页无法证明任何字段：两轮都给空元信息').toEqual({});
    expect(typeof c.frontmatter_error).toBe('string');
    expect((c.frontmatter_error as string).length, '必须给出可读原因，而不是静默空页').toBeGreaterThan(0);
    expect(c.frontmatter_error.split('\n'), '原因压成一行：多行原文会撑坏前端').toHaveLength(1);
    expect(c.body, '正文一页不少地交回（用户要能在详情页看到坏头并手工修）').toContain('裸冒号坏值');
    expect(c.content).toBe(w.content);
  });

  it('A2 文件不存在 / 路径越界仍是各自的错误码，且不带 frontmatter_error', async () => {
    const missing = await getFile('concepts/no-such-a2.md');
    expect(missing.statusCode).toBe(404);
    expect(missing.json().error).toBeTruthy();
    expect(missing.json().frontmatter_error, '「读不到」与「元信息解析失败」必须在响应里可区分').toBeUndefined();

    const outside = await getFile('../outside-a2.md');
    expect([200, 500], '越界不得退化成 500 兜底文案').not.toContain(outside.statusCode);
    expect(outside.statusCode).toBe(400);
    expect(outside.json().frontmatter_error).toBeUndefined();
  });

  it('A3 负控制：好页照常返回解析后的 frontmatter，且不出现 frontmatter_error', async () => {
    await writeRaw('concepts/good-a3.md', goodBytes('A3'));
    const r = await getFile('concepts/good-a3.md');
    expect(r.statusCode).toBe(200);
    const j = r.json();
    expect(j.frontmatter.title).toBe('好页-A3');
    expect(j.frontmatter.type).toBe('concept');
    expect(j.frontmatter_error, '接入收敛层不得把好页判成坏页').toBeUndefined();
    expect(j.body).toContain('唯一标记A3');
  });
});

describe('B · splitFrontmatter：写守卫的差分基线不许是 gray-matter 缓存本体', () => {
  it('B1 热读返回的 data 与缓存脱钩：一次就地改写不渗进后续读取', () => {
    const raw = badBytes('B1');
    splitFrontmatter(raw); // 冷读：解析抛 → 退化为 {}
    const warm = splitFrontmatter(raw); // 热读：拿到缓存条目里的 data 引用本体
    warm.data.probeB1 = '串改';
    const again = splitFrontmatter(raw);

    expect(again.data, '差分基线与缓存共用同一个对象 = 写守卫可被一次改写污染').not.toBe(warm.data);
    expect(again.data.probeB1, '下一次读取凭空多出字段，守卫的「旧值 → 新值」就不再是原页真相').toBeUndefined();
  });

  it('B2 同字节两遍拆分：header/body/data 逐个一致（坏页与好页各一组）', () => {
    for (const raw of [badBytes('B2'), goodBytes('B2')]) {
      const r1 = splitFrontmatter(raw);
      const r2 = splitFrontmatter(raw);
      expect(r2.header).toBe(r1.header);
      expect(r2.body).toBe(r1.body);
      expect(r2.data).toEqual(r1.data);
    }
  });

  it('B3 负控制：好页经写守卫仍逐字保留原 frontmatter、忽略候选字段变更', async () => {
    const original = ['---', 'title: B3 原标题', 'type: concept', '---', '', '## 小节', '', '内容一', '内容二'].join('\n');
    await vault.writeFile('concepts/good-b3.md', original);
    const candidate = ['---', 'title: B3 被 LLM 改掉的标题', 'type: concept', '---', '', '## 小节', '', '内容一', '内容二'].join('\n');

    const res = await writePageSafely(vault, 'concepts/good-b3.md', candidate);
    expect(res.preservedFrontmatter).toBe(true);
    expect(res.ignored.map((c) => c.key)).toContain('title');

    const after = await vault.readFile('concepts/good-b3.md');
    expect(after).toContain('title: B3 原标题');
    expect(after).not.toContain('被 LLM 改掉的标题');
  });
});

describe('C · 技能开关：同一份坏 SKILL.md 两轮都拒绝，且不得吃掉其余字段', () => {
  async function writeSkill(id: string, raw: string): Promise<string> {
    const dir = path.join(skillRoot, id);
    await fs.mkdir(dir, { recursive: true });
    const entry = path.join(dir, 'SKILL.md');
    await fs.writeFile(entry, raw, 'utf8');
    return entry;
  }

  it('C1 冷读拒绝后，热读也必须拒绝——第二次点开关不得整文件重写丢掉 name/description', async () => {
    const raw = badSkillBytes('C1');
    const entry = await writeSkill('c1-skill', raw);

    const first = await svc.setSkillEnabled('c1-skill', false);
    const afterFirst = await fs.readFile(entry, 'utf8');
    const second = await svc.setSkillEnabled('c1-skill', true);
    const afterSecond = await fs.readFile(entry, 'utf8');

    expect(first, '坏 frontmatter：不猜结构、不覆盖正文，直接拒绝').toBeNull();
    expect(second, '热缓存那一轮同样必须拒绝——同一页两种结论是本单的病灶').toBeNull();
    expect(afterFirst).toBe(raw);
    expect(afterSecond, '拒绝写入 = 文件一个字节都不能变（否则元信息被静默清空）').toBe(afterFirst);
  });

  it('C2 同一份坏 SKILL.md 连续两轮读取，技能描述必须一模一样', async () => {
    const entry = await writeSkill('c2-skill', badSkillBytes('C2'));
    const r1 = await svc.getSkillDetail('c2-skill');
    await touchKeepingBytes(entry);
    const r2 = await svc.getSkillDetail('c2-skill');

    expect(r1).not.toBeNull();
    expect(r2).not.toBeNull();
    expect(r2!.description, '刷新一次换一个描述：列表里看到的和点开的不是一回事').toBe(r1!.description);
    expect(r2!.name).toBe(r1!.name);
  });

  it('C3 负控制：好 SKILL.md 的开关照常生效且保留其余字段', async () => {
    const raw = ['---', 'name: 好开关技能', 'description: 正常描述', 'enabled: true', '---', '', '# 用法', '', '正文 C3'].join('\n');
    const entry = await writeSkill('c3-skill', raw);

    const res = await svc.setSkillEnabled('c3-skill', false);
    expect(res).not.toBeNull();
    expect(res!.enabled).toBe(false);

    const after = await fs.readFile(entry, 'utf8');
    const fm = matter(after).data as Record<string, unknown>;
    expect(fm.name).toBe('好开关技能');
    expect(fm.description).toBe('正常描述');
    expect(after).toContain('正文 C3');
  });
});

describe('D · 编译写页：同一串输出重放两次，落盘字节必须一致', () => {
  it('D1 坏首块 + 第二块：两轮都原样落盘（不塌块、不丢正文）且逐字节一致', async () => {
    const write = createCompileTools(vault).find((t) => t.name === 'write_file');
    expect(write).toBeTruthy();
    const dupBad = [
      '---',
      'title: D1: 裸冒号坏值',
      '---',
      '---',
      'title: D1 块二标题',
      'tags:',
      '  - 甲',
      '---',
      '',
      '正文 D1',
    ].join('\n');

    await write!.handler({ path: 'concepts/d1-a.md', content: dupBad }, {} as never);
    await write!.handler({ path: 'concepts/d1-b.md', content: dupBad }, {} as never);

    const a = await vault.readFile('concepts/d1-a.md');
    const b = await vault.readFile('concepts/d1-b.md');
    expect(b, '同一批次重编译/重试落出两种文件：块结构随第几次读变化').toBe(a);
    // 本点两读的实际结论都是「首块非法 ⇒ 整串原样落盘」（块结构不塌），这里把行为也钉住：
    // 只比 a/b 的话，任何一次改动只要两读同样错就看不见——P5 探针实测还原成修复前的直连
    // matter() 也落不出两种文件，可见的守护只剩 G4/G5，故行为断言必须由这一行补上。
    expect(a, '坏首块保持原样，由 health-check 兜底：不塌块、不丢正文').toBe(dupBad);
  });

  it('D2 负控制：好页双块仍按 T02964 收敛为单块、块 2 字段优先', async () => {
    const write = createCompileTools(vault).find((t) => t.name === 'write_file');
    const dupGood = [
      '---',
      'title: D2 首块占位标题',
      'type: concept',
      '---',
      '---',
      'title: D2 真实标题',
      '---',
      '',
      '正文 D2',
    ].join('\n');

    await write!.handler({ path: 'concepts/d2.md', content: dupGood }, {} as never);
    const out = await vault.readFile('concepts/d2.md');

    expect((out.match(/^---[ \t]*$/gm) ?? []).length, '双块必须并成单块').toBe(2);
    expect(out).toContain('D2 真实标题');
    expect(out).not.toContain('首块占位标题');
  });
});

describe('E · vault-service / discover / misplaced 其余读点：同字节两轮同结论（回归锁）', () => {
  it('E1 两个字节完全相同的页面，listAllPages 返回的 frontmatter 不是同一个对象', async () => {
    const raw = goodBytes('E1');
    await writeRaw('concepts/e1-a.md', raw);
    await writeRaw('concepts/e1-b.md', raw);

    const pages = async () =>
      (await vault.listAllPages())
        .filter((p) => p.path.startsWith('concepts/e1-'))
        .sort((x, y) => x.path.localeCompare(y.path));

    const first = await pages();
    expect(first).toHaveLength(2);
    expect(first[0].frontmatter).not.toBe(first[1].frontmatter);

    first[0].frontmatter.probeE1 = '串改';
    const again = await pages();
    expect(again[1].frontmatter.probeE1, '给一页加字段，另一页凭空跟着变').toBeUndefined();
  });

  it('E2 坏页在列表/updated/同名查找/待确认队列四个读点上两轮结论逐个一致', async () => {
    const badAbs = await writeRaw('concepts/bad-e2.md', badBytes('E2'));
    await writeRaw('concepts/good-e2.md', goodBytes('E2'));

    const snapshot = async () =>
      JSON.stringify({
        list: (await vault.listAllPages())
          .filter((p) => p.path.includes('-e2'))
          .map((p) => ({ path: p.path, keys: Object.keys(p.frontmatter).sort() })),
        updatedBad: await vault.getPageUpdated('concepts/bad-e2.md'),
        updatedGood: await vault.getPageUpdated('concepts/good-e2.md'),
        byTitle: await vault.findPageByTitle('E2: 裸冒号坏值', 'concepts'),
        pending: (await vault.listPendingTagPages()).map((p) => p.path).sort(),
      });

    const cold = await snapshot();
    await touchKeepingBytes(badAbs);
    const warm = await snapshot();

    expect(warm, '坏页允许被判成「没有元信息」，但两轮必须是同一个判词').toBe(cold);
    const parsed = JSON.parse(cold) as {
      list: Array<{ path: string; keys: string[] }>;
      updatedBad: string | null;
      updatedGood: string | null;
      byTitle: string | null;
    };
    expect(parsed.updatedBad, '坏页读不出 updated（过期判定只能落到「未知」，不能凭空造时间）').toBeNull();
    expect(parsed.updatedGood, '好页的 updated 照常读得出——不许把好页一并判空').toBeTruthy();
    expect(parsed.byTitle).toBeNull();
    expect(parsed.list.find((p) => p.path === 'concepts/good-e2.md')!.keys.length).toBeGreaterThan(0);
  });

  it('E3 发现链：坏页两轮都被跳过、好页两轮都在（集合不随读序增减）', async () => {
    const badAbs = await writeRaw('concepts/bad-e3.md', badBytes('E3'));
    await writeRaw('concepts/good-e3.md', goodBytes('E3'));

    const paths = async () => (await collectAllPageMetadata(vault)).map((p) => p.path).sort();
    const first = await paths();
    await touchKeepingBytes(badAbs);
    const second = await paths();

    // 冷读这一轮「解析抛错 → 跳过该页」，热读那一轮拿到空 data → 反而以文件名兜底标题进了集合：
    // 推荐列表里凭空多/少一页，随进程重启翻转。
    expect(second, '推荐集合不得随第几次读增减').toEqual(first);
    expect(first).toContain('concepts/good-e3.md');
    expect(first).not.toContain('concepts/bad-e3.md');
    expect(second).not.toContain('concepts/bad-e3.md');
  });

  it('E4 错位页：坏页退回文件名标题仍照常被列出，两轮判词一致', async () => {
    const badAbs = await writeRaw('concepts/nested-e4/bad-e4.md', badBytes('E4'));
    const first = await detectMisplacedPages(vault);
    await touchKeepingBytes(badAbs);
    const second = await detectMisplacedPages(vault);

    const key = (rows: typeof first) =>
      rows.map((r) => `${r.path}|${r.title}|${r.type}|${r.suggestedPath}`).sort();
    expect(key(second)).toEqual(key(first));

    const row = first.find((r) => r.path.endsWith('bad-e4.md'));
    expect(row, '坏页不能因为读不出 type 就从错位列表里消失（那正是 T02731 的症状）').toBeTruthy();
    expect(row!.title).toBe('bad-e4');
    expect(row!.type).toBe('');
    expect(row!.suggestedPath.startsWith('concepts/'), '读不出 type 时留在原顶层目录，只补掉多余层级').toBe(true);
  });
});
