// T05721：URL 爬取 done 事件必须给每页回带独立 markdown，否则前端逐页编译无从谈起。
import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import {
  renderCrawledPage,
  combinePagesToMarkdown,
  URL_MAX_PAGES_HARD_LIMIT,
  type UrlCrawlPage,
} from '../src/utils/url-crawl.js';

const CRAWL_SRC = path.resolve(__dirname, '../src/utils/url-crawl.ts');
const INGEST_SRC = path.resolve(__dirname, '../src/routes/url-ingest.ts');
const COMPILE_SRC = path.resolve(__dirname, '../src/routes/compile.ts');

function makePage(i: number): UrlCrawlPage {
  return {
    url: `https://example.com/content/shcpe/p${i}.html`,
    title: `页面 ${i}`,
    content: `正文 ${i}`,
    depth: i % 3,
    attachments: i === 0
      ? [{ url: `https://example.com/files/a${i}.pdf`, type: 'document', extension: 'pdf' }]
      : [],
  };
}

describe('T05721 URL 爬取逐页 Markdown', () => {
  it('renderCrawledPage 含标题、来源、正文与附件块', () => {
    const md = renderCrawledPage(makePage(0));
    expect(md).toContain('页面 0');
    expect(md).toContain('_Source: [https://example.com/content/shcpe/p0.html]');
    expect(md).toContain('正文 0');
    expect(md).toContain('### Attachments');
    expect(md).toContain('[D] [https://example.com/files/a0.pdf]');
  });

  it('合并文档每一段与逐页渲染逐字同源（全量编译 == 逐页编译拼接）', () => {
    const pages = [makePage(0), makePage(1), makePage(2)];
    const combined = combinePagesToMarkdown(pages, '');
    expect(combined).toContain('> Crawled 3 page(s).');
    for (const p of pages) expect(combined).toContain(renderCrawledPage(p));
  });

  it('done 事件把逐页 markdown 写回 pages[]（结构锁，防退回纯摘要）', () => {
    const src = fs.readFileSync(CRAWL_SRC, 'utf8');
    expect(src).toContain('markdown: renderCrawledPage(p)');
    expect(src).not.toMatch(/pages:\s*allPages\.map\(\(p\) => \(\{ url: p\.url/);
  });

  it('爬取上限与逐页编译端点共用同一个硬上限常量', () => {
    expect(URL_MAX_PAGES_HARD_LIMIT).toBe(500);
    expect(fs.readFileSync(INGEST_SRC, 'utf8')).toContain('URL_MAX_PAGES_HARD_LIMIT');
    expect(fs.readFileSync(COMPILE_SRC, 'utf8')).toContain('URL_MAX_PAGES_HARD_LIMIT');
  });
});
