// T04518：scripts/check-theme-tokens.mjs 的手写声明。
// 门禁脚本本体保持 JS（CLI 门禁与 test/theme-tokens.test.ts 共用同一份实现），
// 这里只给出测试消费到的两个导出面的类型，避免测试侧退化成 any。
export interface ThemeBlock {
  theme: string;
  body: string;
}

export interface CssSource {
  file: string;
  css: string;
}

export function extractThemeBlocks(css: string): ThemeBlock[];

export function checkThemeTokens(sources: CssSource[]): string[];
