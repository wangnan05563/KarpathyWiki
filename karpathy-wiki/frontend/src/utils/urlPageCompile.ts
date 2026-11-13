// T05721：把 URL 爬取结果转换成「逐页编译」载荷。
// 为什么要抽成纯函数：Ingest.vue 的 startUrlCompile 依赖 ElMessage / Pinia / DOM 事件，
// 而「60 个勾选页是否真的变成 60 个独立编译单元」是本次修复的核心，必须能脱离组件直接断言。
import type { UrlCrawlPageSummary, UrlPageCompileItem } from '../types';

export interface UrlCompilePagesResult {
  pages: UrlPageCompileItem[];
  // 旧后端未返回逐页 markdown 时退化为 1 份合并文档。
  // 组件据此给出提示，进度条也会如实显示 1/1，不再冒充 N 页或谎报「N 页全部成功」。
  degraded: boolean;
}

// 文件名：序号前缀保证唯一（同标题页面不会互相覆盖 raw/ 存档），标题 slug 保留可读性；
// 只留 Unicode 字母/数字/下划线/连字符，后端会再按白名单 sanitize 一次。
export function buildUrlPageFileName(page: UrlCrawlPageSummary, index: number): string {
  const slug = (page.title || page.url)
    .replace(/[^\p{L}\p{N}_-]+/gu, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 48) || 'page';
  return `page-${String(index + 1).padStart(3, '0')}-${slug}.md`;
}

// 返回 null 表示「没有可编译内容」：调用方据此提示用户，而不是提交空 pages 让后端 400。
export function buildUrlCompilePages(
  selectedPages: UrlCrawlPageSummary[],
  combinedMarkdown: string,
): UrlCompilePagesResult | null {
  if (selectedPages.length === 0) return null;
  if (selectedPages.every((p) => !!p.markdown)) {
    return {
      pages: selectedPages.map((p, i) => ({
        name: buildUrlPageFileName(p, i),
        markdown: p.markdown as string,
      })),
      degraded: false,
    };
  }
  // 旧后端兼容：没有任何逐页 markdown 时，整份合并文档只能算 1 个编译单元。
  if (!combinedMarkdown) return null;
  return { pages: [{ name: 'url-crawl-combined.md', markdown: combinedMarkdown }], degraded: true };
}
