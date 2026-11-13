// T05721：URL 爬取结果 → 逐页编译载荷。核心断言是「N 个勾选页 == N 个独立编译单元」，
// 旧实现把 N 页拼成 1 份 text，只触发 1 次编译却显示 100% 成功。
import { describe, it, expect, beforeEach } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { setActivePinia, createPinia } from 'pinia';
import { buildUrlCompilePages, buildUrlPageFileName } from '../src/utils/urlPageCompile';
import { useCompileStore } from '../src/stores/compile';
import type { UrlCrawlPageSummary, UrlPageCompilePayload } from '../src/types';

const INGEST_SRC = path.resolve(__dirname, '../src/views/Ingest.vue');
const STORE_SRC = path.resolve(__dirname, '../src/stores/compile.ts');

function makePages(count: number): UrlCrawlPageSummary[] {
  return Array.from({ length: count }, (_, i) => ({
    url: `http://www.shcpe.com.cn/content/shcpe/p${i}.html`,
    // 故意让一半页面同名：验证序号前缀仍能保证文件名唯一
    title: i % 2 === 0 ? `示例页面 ${i}` : '相同标题',
    depth: i % 3,
    contentLength: 100 + i,
    attachmentCount: 0,
    markdown: `# 页面 ${i}\n\n正文 ${i}\n`,
  }));
}

describe('T05721 URL 逐页编译载荷', () => {
  beforeEach(() => {
    setActivePinia(createPinia());
    localStorage.clear();
  });

  it('60 个解析页 → 60 个独立编译单元，且每页 markdown 逐字保留', () => {
    const src = makePages(60);
    const built = buildUrlCompilePages(src, '# Combined Crawl');

    expect(built).not.toBeNull();
    expect(built!.degraded).toBe(false);
    expect(built!.pages).toHaveLength(60);
    for (let i = 0; i < 60; i++) {
      expect(built!.pages[i].markdown).toBe(src[i].markdown);
    }
  });

  it('勾选子集只产生对应数量的编译单元', () => {
    const selected = makePages(60).filter((_, i) => i % 10 === 0);
    const built = buildUrlCompilePages(selected, '');
    expect(built!.pages).toHaveLength(6);
    expect(built!.degraded).toBe(false);
  });

  it('文件名全局唯一、.md 结尾、无路径分隔符（同标题页也互不覆盖）', () => {
    const built = buildUrlCompilePages(makePages(60), '');
    const names = built!.pages.map((p) => p.name);
    expect(new Set(names).size).toBe(60);
    for (const name of names) {
      expect(name.endsWith('.md')).toBe(true);
      expect(name).not.toMatch(/[/\\]/);
      expect(name.length).toBeLessThanOrEqual(80);
    }
  });

  it('标题中的标点/斜杠被规范化，后端文件名校验不会被绕过', () => {
    const name = buildUrlPageFileName({
      url: 'http://example.com/a/b.html', title: 'A/B: 测试 页面?!',
      depth: 0, contentLength: 1, attachmentCount: 0,
    }, 0);
    expect(name).toBe('page-001-A-B-测试-页面.md');
  });

  it('旧后端缺逐页 markdown → 退化为 1 份合并文档并标记 degraded', () => {
    const legacy = makePages(60).map(({ markdown: _md, ...p }) => p);
    const built = buildUrlCompilePages(legacy, '# Combined Crawl');
    expect(built!.degraded).toBe(true);
    expect(built!.pages).toHaveLength(1);
    expect(built!.pages[0].markdown).toBe('# Combined Crawl');
  });

  it('没有可编译内容时返回 null，不给后端提交空 pages', () => {
    expect(buildUrlCompilePages([], '# Combined')).toBeNull();
    const legacy = makePages(3).map(({ markdown: _md, ...p }) => p);
    expect(buildUrlCompilePages(legacy, '')).toBeNull();
  });

  it('prepareBatchCompile 用 JSON 载荷时页数取自 pages.length', () => {
    const store = useCompileStore();
    const built = buildUrlCompilePages(makePages(60), '')!;
    store.prepareBatchCompile({ pages: built.pages });

    expect(store.isBatchMode).toBe(true);
    expect(store.isCompiling).toBe(true);
    expect(store.pendingBatchFileCount).toBe(60);
    expect((store.pendingBatchPayload as UrlPageCompilePayload).pages).toHaveLength(60);
  });

  it('结构锁：Ingest 的 URL 编译走批量端点，不再把合并稿当单文件 text 编译', () => {
    const src = fs.readFileSync(INGEST_SRC, 'utf8');
    const start = src.indexOf('function startUrlCompile()');
    expect(start).toBeGreaterThan(-1);
    const body = src.slice(start, src.indexOf('\n}\n', start));
    expect(body).toContain('buildUrlCompilePages(');
    expect(body).toContain('store.prepareBatchCompile(');
    expect(body).not.toContain('markdownParts');
    expect(body).not.toContain("prepareCompile({ type: 'text'");
  });

  it('结构锁：compile store 把 URL 页面载荷路由到 /api/compile/url-pages', () => {
    const src = fs.readFileSync(STORE_SRC, 'utf8');
    expect(src).toContain('`${API_BASE}/compile/url-pages`');
    expect(src).toContain("const isUrlPages = !isFormData && 'pages' in payload");
  });
});
