// T04561（方案 A）：体检 orphan 判定并入 vault 根目录 index.md / log.md 的收录链接。
// 背景：computeLinkGraph 只收 PAGE_DIRS 之间的互链，而编译期 append_index 往 index.md 追加
//   `- [[页面名]] — 摘要` 是产品设计的正常收录动作；被收录页因此被判 orphan，批量修复白烧 LLM。
//   本机库实测 91 个 orphan 中 59 个由 index.md 收录、1 个由 log.md 收录。
// 本文件锁四件事：
//   A doHealthCheck：index/log 收录页不判 orphan；未被收录且无互链的页仍判 orphan（负控制）
//   B recheckIssueResolved 与体检同口径（否则修复后永远判「未消解」）
//   C 图口径未被污染：index.md/log.md 不是节点、不产生边，nodes/edges 数量不变
//   D 根文件缺失按「无额外入链」降级，体检整体不报错
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import { VaultService } from '../src/vault/vault-service.js';
import { HarnessAdapter } from '../src/engine/harness-adapter.js';

const INDEX_PAGE = 'concepts/index-linked.md';
const LOG_PAGE = 'concepts/log-linked.md';
const ORPHAN_PAGE = 'concepts/no-inbound.md';

describe('T04561 · 体检 orphan 判定计入根目录收录链接', () => {
  let vaultDir = '';
  let vault: VaultService;

  beforeAll(async () => {
    vaultDir = await fs.mkdtemp(path.join(os.tmpdir(), 't04561-vault-'));
    vault = new VaultService(vaultDir);
    await vault.init();
    // 三个页面互不链接：唯一的差异是「被根目录收录」与「谁都没链」
    await vault.writeFile(INDEX_PAGE, '---\ntitle: 目录收录页\ntype: concept\n---\n\n内容。\n');
    await vault.writeFile(LOG_PAGE, '---\ntitle: 日志收录页\ntype: concept\n---\n\n内容。\n');
    await vault.writeFile(ORPHAN_PAGE, '---\ntitle: 真孤儿\ntype: concept\n---\n\n内容。\n');
    // 编译期 append_index 的产物形态；log.md 侧用别名写法验证与 link-parser 同口径
    await vault.writeFile('index.md', '# 知识库目录\n\n- [[index-linked]] — 目录摘要\n');
    await vault.writeFile('log.md', '# 操作日志\n\n- [[log-linked|日志别名]] 编译完成\n');
  });

  afterAll(async () => {
    await fs.rm(vaultDir, { recursive: true, force: true });
  });

  it('A · 被 index.md / log.md 收录的页不判 orphan；真孤儿仍判 orphan', async () => {
    const adapter = new HarnessAdapter({} as never, vault);
    adapter.invalidateHealthCheckCache();
    const report = await adapter.healthCheck();

    expect(report.orphans).not.toContain(INDEX_PAGE);
    expect(report.orphans).not.toContain(LOG_PAGE);
    expect(report.orphans).toContain(ORPHAN_PAGE);
  });

  it('B · recheckIssueResolved 与体检同口径：收录页判已消解，真孤儿判未消解', async () => {
    const adapter = new HarnessAdapter({} as never, vault);

    expect(await adapter.recheckIssueResolved({ issueType: 'orphan', target: INDEX_PAGE })).toBe(true);
    expect(await adapter.recheckIssueResolved({ issueType: 'orphan', target: LOG_PAGE })).toBe(true);
    expect(await adapter.recheckIssueResolved({ issueType: 'orphan', target: ORPHAN_PAGE })).toBe(false);
  });

  it('C · 图口径未被污染：根目录文件不是节点，也不产生边', async () => {
    const graph = await vault.buildLinkGraph();

    expect(graph.nodes.slice().sort()).toEqual([INDEX_PAGE, LOG_PAGE, ORPHAN_PAGE].sort());
    expect(graph.nodes).not.toContain('index.md');
    expect(graph.nodes).not.toContain('log.md');
    expect(graph.edges).toEqual([]);
  });

  it('D · 根文件缺失按「无额外入链」降级，体检不整体报错', async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), 't04561-degrade-'));
    try {
      const isolated = new VaultService(dir);
      await isolated.init();
      await isolated.writeFile(INDEX_PAGE, '---\ntitle: 目录收录页\ntype: concept\n---\n\n内容。\n');
      await isolated.writeFile('index.md', '# 知识库目录\n\n- [[index-linked]] — 摘要\n');
      const adapter = new HarnessAdapter({} as never, isolated);
      adapter.invalidateHealthCheckCache();
      expect((await adapter.healthCheck()).orphans).not.toContain(INDEX_PAGE);

      await fs.rm(path.join(dir, 'index.md'), { force: true });
      await fs.rm(path.join(dir, 'log.md'), { force: true });
      adapter.invalidateHealthCheckCache();
      expect((await adapter.healthCheck()).orphans).toContain(INDEX_PAGE);
      expect(await adapter.recheckIssueResolved({ issueType: 'orphan', target: INDEX_PAGE })).toBe(false);
    } finally {
      await fs.rm(dir, { recursive: true, force: true });
    }
  });
});
