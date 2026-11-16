// scripts/link-harness.mjs
// 构建前置：把 @wiki/harness 的 node_modules 链接强制重建为指向源码目录的绝对 junction。
// 背景（2026-11-16）：pnpm 11 在本机 Windows 上写入的 link: 相对软链会多算一级 `..`
// （指向 D:\otherProjects\... 而非 D:\code\otherProjects\...），且 api 的 file: 依赖
// 会把 wiki-harness 复制到 .pnpm 时丢掉 dist junction，导致 tsc 找不到 @wiki/harness。
// 这里直接以绝对 target 建 junction，dist -> release/harness 的链路即可被 TypeScript 解析。

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const appRoot = path.resolve(here, '..');           // karpathy-wiki
const harnessDir = path.resolve(appRoot, '..', 'wiki-harness');

const links = [
  path.join(appRoot, 'node_modules', '@wiki', 'harness'),
  path.join(appRoot, 'api', 'node_modules', '@wiki', 'harness'),
];

if (!fs.existsSync(path.join(harnessDir, 'dist', 'index.d.ts'))) {
  console.error(`[link-harness] 未找到 ${path.join(harnessDir, 'dist', 'index.d.ts')}，请先构建 @wiki/harness`);
  process.exit(1);
}

for (const link of links) {
  fs.mkdirSync(path.dirname(link), { recursive: true });
  try {
    fs.unlinkSync(link);
  } catch {
    // 不存在则忽略；若是普通目录则报错，避免误删
  }
  fs.symlinkSync(harnessDir, link, 'junction');
  console.log(`[link-harness] ${link} -> ${harnessDir}`);
}
