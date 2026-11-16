// 将 tsc 编译产物（release/harness）链接为 wiki-harness/dist。
//
// 为什么不再复制：pnpm 的 file: 依赖要求包内存在 dist/index.js，但复制会让同一份
// 编译产物在 wiki-harness/dist 与 release/harness 各存一份，用户清理磁盘时容易漏掉。
// 这里改为目录链接（Windows junction / 其他平台 symlink）：真实文件只落在 release/，
// 包内 dist 仅是一个入口链接；删除 release/ 后重跑 build 会自动重建。
//
// 注意：不能用 fs.cpSync(src, dest, {recursive:true}) —— Node 24.14.0 在 Windows 上
// 该 API 会原生崩溃（退出码 0xC0000409 / 3221226505）；旧实现已弃用。
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const projectRoot = path.resolve(__dirname, '..'); // wiki-harness
const releaseRoot = path.resolve(projectRoot, '..', 'release');
const src = path.resolve(releaseRoot, 'harness');
const dest = path.resolve(projectRoot, 'dist');

if (!fs.existsSync(path.join(src, 'index.js'))) {
  console.error(`[link-dist] 编译产物不存在: ${src}/index.js；请先运行 tsc`);
  process.exit(1);
}

function removeLinkOrEmptyDir(target) {
  let stat;
  try {
    stat = fs.lstatSync(target);
  } catch (error) {
    if (error.code === 'ENOENT') return;
    throw error;
  }
  if (stat.isSymbolicLink()) {
    // Windows junction 用 rmdir 删除；POSIX 目录 symlink 用 unlink。
    try {
      fs.unlinkSync(target);
    } catch (error) {
      if (process.platform === 'win32') fs.rmdirSync(target);
      else throw error;
    }
    return;
  }
  if (stat.isDirectory()) {
    // 首次迁移：旧 dist 是真实目录，不直接删除（safe-delete 钩子会拦截），
    // 原样挪到 release/harness-legacy-dist 留档，之后由用户统一清理。
    const legacy = path.join(releaseRoot, 'harness-legacy-dist');
    if (fs.existsSync(legacy)) {
      fs.renameSync(legacy, `${legacy}-${Date.now()}`);
    }
    fs.renameSync(target, legacy);
    console.log(`[link-dist] 旧 dist 已归档: ${legacy}`);
    return;
  }
  fs.unlinkSync(target);
}

removeLinkOrEmptyDir(dest);
fs.symlinkSync(src, dest, process.platform === 'win32' ? 'junction' : 'dir');
console.log(`[link-dist] 已链接 ${src} -> ${dest}`);
