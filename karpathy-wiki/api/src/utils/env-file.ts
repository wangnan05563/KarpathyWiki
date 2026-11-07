import fsSync from 'node:fs';
import path from 'node:path';
import { getApiDir, getUserDataPath } from './runtime.js';

// 用 match 从 .env 行提取 KEY=VALUE；未匹配返回 null 跳过
function applyEnvLine(line: string, env: NodeJS.ProcessEnv): void {
  const trimmed = line.trim();
  if (!trimmed || trimmed.startsWith('#')) return;
  const m = trimmed.match(/^([^=]+)=(.*)$/);
  // 已存在的环境变量优先：.env 只补齐，不覆盖进程显式注入的值
  if (m && !env[m[1].trim()]) env[m[1].trim()] = m[2].trim();
}

export interface EnvFileCandidateDeps {
  userDataEnvPath?: string;
  apiDirEnvPath?: string;
  cwd?: string;
}

// .env 查找顺序（T04557）：
//   1. 用户数据目录（SEA: %LOCALAPPDATA%/KarpathyWiki，开发: api/）
//   2. exe 同级 / api 目录（build-exe.ps1 给用户的指引就是「放在应用同目录」）
//   3. 进程 CWD（兼容从应用目录直接启动）
//   4. CWD/services/api（兼容仓库根启动）
// 第 2 项是本次新增：此前只有 1/3/4，从计划任务/服务/改了起始位置的快捷方式启动就丢 Key。
// 去重是因为开发模式下第 1、2 项可能指向同一个 api/.env。
export function buildEnvFileCandidates(deps: EnvFileCandidateDeps = {}): string[] {
  const cwd = deps.cwd ?? process.cwd();
  return Array.from(new Set([
    deps.userDataEnvPath ?? getUserDataPath('.env'),
    deps.apiDirEnvPath ?? path.join(getApiDir(), '.env'),
    path.resolve(cwd, '.env'),
    path.resolve(cwd, 'services', 'api', '.env'),
  ]));
}

// 按候选顺序加载第一个存在的 .env，并始终打印「全部候选」（命中打命中项）。
// 全不命中时也要留一行日志：此前静默返回，用户无从判断是没放还是没找到。
export function loadEnvFile(
  candidates: string[],
  env: NodeJS.ProcessEnv = process.env,
  log: (message: string) => void = console.log,
): string | null {
  const hit = candidates.find((p) => fsSync.existsSync(p));
  if (!hit) {
    log(`[启动] 未找到 .env，候选：[${candidates.join(' | ')}]`);
    return null;
  }
  for (const line of fsSync.readFileSync(hit, 'utf8').split(/\r?\n/)) {
    applyEnvLine(line, env);
  }
  log(`[启动] .env 已加载：${hit}（候选：${candidates.join(' | ')}）`);
  return hit;
}
