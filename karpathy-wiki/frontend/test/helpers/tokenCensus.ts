// T04529 —— 全站颜色消费点普查器（token 表达式 × 主题实算的取数口径）。
//
// 取代 T04449~T04524 那套「只扫前景声明里的字面色」的判据：字面色看得见，
// 但 `color: var(--x, #abc)` 里真正生效的是 #abc（--x 未声明时），旧判据整类看不见。
// 这里只负责**取数**：把 src/**/*.{vue,css} 的 style 块里所有颜色类声明拆成
// 「文件 / 选择器 / 属性 / token / 字面 fallback / 行号」一行，供上层锁按族登记。
//
// 取数纪律：
//   - 单行规则（`.x { color: var(--y); }`）也必须入账 —— 行级正则扫不到这种写法，
//     而仓库里有 100+ 条，漏了它们本普查就等于没做；
//   - fallback 允许嵌套（`var(--a, var(--grad-fire))`），按括号深度切分，
//     不能拿 `[^)]*` 截断成 `var(--grad-fire`；
//   - 注释里的声明不算消费点（先按换行保形掩掉），Vue 只取 <style> 块，
//     模板里的 `:style="{ color: ... }"` 不是 CSS 声明；
//   - 空白差异不改变行号，取证/报错都指回真实行。
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { ROOT } from './contrast';

/**
 * 进入普查的属性：文字前景、面、非文字图形与线条（不含 box-shadow/text-shadow 这类装饰）。
 * 边框只认简写与 *-color 收口：`border-radius: var(--radius-sm)` 是圆角尺寸不是颜色，
 * 放进来会把一批尺寸 token 误当色族（本单取证时抓过一次）。
 */
export const COLORISH_PROPERTY =
  /^(color|background|background-color|border(?:-(?:top|right|bottom|left|block|inline)(?:-(?:start|end))?)?(?:-color)?|fill|stroke|outline(?:-color)?)$/;

export interface VarRef {
  token: string;
  /** 字面 fallback 原文（可含嵌套 var(...)）；没有第二参时为 null */
  fallback: string | null;
}

export interface CensusRow {
  /** 相对 frontend/ 的路径，正斜杠 */
  file: string;
  selector: string;
  property: string;
  token: string;
  fallback: string | null;
  line: number;
  raw: string;
}

export interface CensusFamily {
  token: string;
  rows: CensusRow[];
  /** 去重后的属性集合：color / background / border / fill / stroke / outline */
  properties: Set<string>;
  files: string[];
  /** 去重后的字面 fallback 原文；无 fallback 的族为空数组 */
  fallbacks: string[];
}

/** 按括号深度取 var(...) 列表，fallback 保留完整嵌套表达式 */
export function findVarRefs(value: string): VarRef[] {
  const out: VarRef[] = [];
  const open = /var\(/gi;
  let m: RegExpExecArray | null;
  while ((m = open.exec(value))) {
    let i = m.index + 4;
    let depth = 1;
    let quote: string | null = null;
    let topComma = -1;
    for (; i < value.length && depth > 0; i++) {
      const ch = value[i];
      if (quote) {
        if (ch === quote) quote = null;
      } else if (ch === '"' || ch === "'") quote = ch;
      else if (ch === '(') depth++;
      else if (ch === ')') depth--;
      else if (ch === ',' && depth === 1 && topComma < 0) topComma = i;
    }
    if (depth !== 0) break; // 不闭合的 var( 说明源码损坏，宁可少取也不瞎猜
    const inner = value.slice(m.index + 4, i - 1);
    const token = (topComma < 0 ? inner : inner.slice(0, topComma - (m.index + 4))).trim();
    const fallback = topComma < 0 ? null : inner.slice(topComma - (m.index + 4) + 1).trim();
    if (/^--[a-z0-9-]+$/i.test(token)) out.push({ token, fallback: fallback || null });
    open.lastIndex = i;
  }
  return out;
}

function maskComments(src: string): string {
  return src.replace(/\/\*[\s\S]*?\*\//g, (m) => m.replace(/[^\n]/g, ' '));
}

/** 只保留样式正文：.vue 取 <style> 块（保留偏移），.css 全取 */
function styleSegments(file: string, src: string): Array<{ start: number; text: string }> {
  if (!file.endsWith('.vue')) return [{ start: 0, text: src }];
  const out: Array<{ start: number; text: string }> = [];
  const re = /<style[^>]*>([\s\S]*?)<\/style>/gi;
  let m: RegExpExecArray | null;
  while ((m = re.exec(src))) {
    const start = m.index + m[0].indexOf('>') + 1;
    out.push({ start, text: m[1] });
  }
  return out;
}

interface Declaration {
  offset: number;
  selector: string;
  property: string;
  value: string;
  raw: string;
}

/**
 * 括号栈解析：任何 `选择器 { 声明; 声明 }`（含 @media 嵌套与单行写法）都能拆。
 * 不追求完整 CSS 语义，只保证「不漏声明、选择器不串行」。
 */
function parseDeclarations(src: string, baseOffset: number): Declaration[] {
  const out: Declaration[] = [];
  const stack: Array<{ selector: string; contentStart: number }> = [];
  let boundary = 0;
  for (let i = 0; i < src.length; i++) {
    const ch = src[i];
    if (ch === '{') {
      const selector = src.slice(boundary, i).replace(/\s+/g, ' ').trim();
      stack.push({ selector, contentStart: i + 1 });
      boundary = i + 1;
    } else if (ch === '}') {
      const frame = stack.pop();
      if (!frame) continue;
      const bodyStart = frame.contentStart;
      const bodyEnd = i;
      // 只解析本层直接声明：按 ; 切，嵌套块（后面还会再遇到 {）整段跳过，交给栈自行处理
      let depth = 0;
      let segStart = bodyStart;
      for (let j = bodyStart; j <= bodyEnd; j++) {
        const c = src[j];
        if (c === '{') depth++;
        else if (c === '}') depth--;
        else if ((c === ';' || j === bodyEnd) && depth === 0) {
          const segmentStart = segStart;
          const seg = src.slice(segmentStart, j);
          segStart = j + 1;
          if (!seg.trim()) continue;
          const m = /^\s*([a-z-]+)\s*:\s*([\s\S]+)$/i.exec(seg);
          if (!m) continue;
          const property = m[1].toLowerCase();
          if (!COLORISH_PROPERTY.test(property)) continue;
          const leading = seg.length - seg.replace(/^\s+/, '').length;
          const value = m[2].trim();
          out.push({
            offset: baseOffset + segmentStart + leading,
            selector: frame.selector,
            property,
            value,
            raw: `${property}: ${value}`,
          });
        }
      }
      boundary = i + 1;
    }
  }
  return out;
}

function lineIndex(src: string): number[] {
  const starts = [0];
  for (let i = 0; i < src.length; i++) if (src[i] === '\n') starts.push(i + 1);
  return starts;
}

function lineAt(starts: number[], offset: number): number {
  let lo = 0;
  let hi = starts.length - 1;
  while (lo < hi) {
    const mid = (lo + hi + 1) >> 1;
    if (starts[mid] <= offset) lo = mid;
    else hi = mid - 1;
  }
  return lo + 1;
}

function walk(dir: string, out: string[] = []): string[] {
  for (const d of readdirSync(join(ROOT, dir), { withFileTypes: true })) {
    if (d.name === 'node_modules' || d.name === 'dist') continue;
    const rel = `${dir}/${d.name}`;
    if (d.isDirectory()) walk(rel, out);
    else if (/\.(vue|css)$/.test(rel)) out.push(rel);
  }
  return out;
}

/** 全站普查：src 下所有 .vue/.css 的颜色类声明 → 逐 token 一行 */
export function scanColorVarRows(dir = 'src'): CensusRow[] {
  const rows: CensusRow[] = [];
  for (const file of walk(dir)) {
    const text = readFileSync(join(ROOT, file), 'utf8');
    const starts = lineIndex(text);
    // 注释只在 style 片段内掩掉：脚本里的 `/*`（正则/字符串）与 CSS 注释无关，
    // 全文件掩会把 <style> 块一起吃掉（Config.vue 实测整块丢过）。
    for (const seg of styleSegments(file, text)) {
      const masked = maskComments(seg.text);
      for (const d of parseDeclarations(masked, seg.start)) {
        const refs = findVarRefs(d.value);
        if (refs.length === 0) continue;
        const line = lineAt(starts, d.offset);
        for (const ref of refs) {
          rows.push({
            file,
            selector: d.selector,
            property: d.property,
            token: ref.token,
            fallback: ref.fallback,
            line,
            raw: d.raw,
          });
        }
      }
    }
  }
  return rows;
}

export function censusFamilies(rows: CensusRow[] = scanColorVarRows()): Map<string, CensusFamily> {
  const map = new Map<string, CensusFamily>();
  for (const row of rows) {
    const family = map.get(row.token) ?? {
      token: row.token,
      rows: [],
      properties: new Set<string>(),
      files: [],
      fallbacks: [],
    };
    family.rows.push(row);
    family.properties.add(
      row.property.startsWith('background') ? 'background' : row.property.startsWith('border') ? 'border' : row.property,
    );
    if (!family.files.includes(row.file)) family.files.push(row.file);
    if (row.fallback && !family.fallbacks.includes(row.fallback)) family.fallbacks.push(row.fallback);
    map.set(row.token, family);
  }
  for (const family of map.values()) family.files.sort();
  return map;
}

export function rowsOfToken(rows: CensusRow[], token: string): CensusRow[] {
  return rows.filter((r) => r.token === token);
}
