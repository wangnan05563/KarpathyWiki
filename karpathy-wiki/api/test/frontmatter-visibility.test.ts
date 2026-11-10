// T04554：坏 frontmatter 的「可见性」回归。
// ------------------------------------------------------------------
// 口径来自【裁决】按建议口径：
//   1) 体检报告给出「本库 N 页元信息解析失败」的计数 + 清单（HealthReport.frontmatterErrors）；
//   2) 四个静默读点里，错位页与技能在各自清单上标出 metadataError（列表元信息已回落，结论不确定）。
// 这里锁住「好库 N=0、坏库 N=1」这条计数语义，以及错位页/技能的标注不会被后续重构悄悄删掉。
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { VaultService } from '../src/vault/vault-service.js';
import { HarnessAdapter } from '../src/engine/harness-adapter.js';
import { detectMisplacedPages } from '../src/data-clean/misplaced-pages.js';

// 实测会抛异常的坏形状（未闭合流序列），与 frontmatter-tolerance 的 BROKEN 同源
const BROKEN = ['---', 'title: 坏页', 'tags: [未闭合,', '---', '', '正文仍可读'].join('\n');
const GOOD = ['---', 'title: 好页', 'type: concept', '---', '', '正文'].join('\n');

const tempDirs: string[] = [];

function makeVault(files: Record<string, string>): VaultService {
  const dir = mkdtempSync(path.join(tmpdir(), 'wiki-t04554-'));
  tempDirs.push(dir);
  for (const [rel, content] of Object.entries(files)) {
    const abs = path.join(dir, rel);
    mkdirSync(path.dirname(abs), { recursive: true });
    writeFileSync(abs, content, 'utf8');
  }
  return new VaultService(dir);
}

afterEach(() => {
  for (const dir of tempDirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

describe('T04554 · 体检计数：本库 N 页元信息解析失败', () => {
  it('干净库 N=0（不新增任何告警）', async () => {
    const vault = makeVault({
      'entities/a.md': GOOD,
      'concepts/b.md': GOOD.replace('好页', '好页-b'),
    });
    const report = await new HarnessAdapter({} as never, vault).healthCheck();
    expect(report.frontmatterErrors).toEqual([]);
  });

  it('含一个坏头页 N=1，带路径与单行原因', async () => {
    const vault = makeVault({
      'entities/a.md': GOOD,
      'concepts/bad.md': BROKEN,
    });
    const report = await new HarnessAdapter({} as never, vault).healthCheck();
    expect(report.frontmatterErrors).toHaveLength(1);
    const [entry] = report.frontmatterErrors;
    expect(entry.path).toBe('concepts/bad.md');
    expect(entry.reason.trim()).not.toBe('');
    // 原因要能进一行日志/一条清单，不能带原始多行栈
    expect(entry.reason).not.toContain('\n');
  });

  it('listAllPages 只给坏头页挂 frontmatterError，读取失败不冒充坏头', async () => {
    const vault = makeVault({
      'entities/a.md': GOOD,
      'concepts/bad.md': BROKEN,
    });
    const pages = await vault.listAllPages();
    const bad = pages.find((p) => p.path === 'concepts/bad.md');
    const good = pages.find((p) => p.path === 'entities/a.md');
    expect(bad?.frontmatterError?.trim()).not.toBe('');
    expect(bad?.frontmatter).toEqual({});
    expect(good?.frontmatterError).toBeUndefined();
  });
});

describe('T04554 · 错位页：坏头导致建议落点不确定时要标注', () => {
  it('解析失败 → type 为空、metadataError 非空；好页不标', async () => {
    const vault = makeVault({
      'entities/nested/bad.md': BROKEN,
      'entities/nested/good.md': GOOD,
    });
    const items = await detectMisplacedPages(vault);
    const bad = items.find((m) => m.path === 'entities/nested/bad.md');
    const good = items.find((m) => m.path === 'entities/nested/good.md');
    expect(bad?.metadataError?.trim()).not.toBe('');
    expect(bad?.type).toBe('');
    expect(good?.metadataError).toBeUndefined();
    expect(good?.type).toBe('concept');
  });
});

describe('T04554 · 技能：SKILL.md 坏头时标注原因、描述回落正文首段', () => {
  it('listSkills 与 getSkillDetail 都带 metadataError', async () => {
    const skillsRoot = mkdtempSync(path.join(tmpdir(), 'wiki-t04554-skills-'));
    tempDirs.push(skillsRoot);
    mkdirSync(path.join(skillsRoot, 'broken-skill'), { recursive: true });
    writeFileSync(path.join(skillsRoot, 'broken-skill', 'SKILL.md'), BROKEN, 'utf8');

    process.env.API_SKILLS_ROOT = skillsRoot;
    const { listSkills, getSkillDetail } = await import('../src/skill/skill-service.js');
    delete process.env.API_SKILLS_ROOT;

    const [listed] = await listSkills();
    expect(listed.id).toBe('broken-skill');
    expect(listed.metadataError?.trim()).not.toBe('');
    // 坏头时 description 走首段回落（现有实现取首个非标题/非 --- 行），关键是可辨识为非作者声明
    expect(listed.description.trim()).not.toBe('');

    const detail = await getSkillDetail('broken-skill');
    expect(detail?.metadataError?.trim()).not.toBe('');
  });
});
