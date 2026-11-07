// T04557：去掉启动期对进程 CWD 的两条隐性依赖。
// ------------------------------------------------------------------
// J 组（.env）：候选顺序 = 用户数据目录 → exe 同级/api 目录 → CWD → CWD/services/api；
//   始终打印全部候选，全不命中也要留一行日志（此前静默，用户无从判断「没放」还是「没找到」）。
// H 组（config.json）：CWD 同名文件先做内容归属校验（vaultPath/llm/server 至少一个特征键），
//   非应用配置跳过并 warn；否则会被当成应用配置读取，甚至被整文写回。
// 全部临时目录 + 受控 env/cwd，不碰真实 .env / api/config.json。
import { describe, it, expect, vi, afterEach } from 'vitest';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import { buildEnvFileCandidates, loadEnvFile } from '../src/utils/env-file.js';
import { getConfigPath, persistConfigFile } from '../src/config.js';
import type { AppConfig } from '../src/types.js';

const tmpDirs: string[] = [];
const origCwd = process.cwd();

async function mkTmpDir(): Promise<string> {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'kw-t04557-'));
  tmpDirs.push(dir);
  return dir;
}

async function writeEnv(dir: string, content: string): Promise<string> {
  const p = path.join(dir, '.env');
  await fs.writeFile(p, content, 'utf8');
  return p;
}

afterEach(async () => {
  vi.restoreAllMocks();
  process.chdir(origCwd);
  await Promise.all(tmpDirs.splice(0).map((d) => fs.rm(d, { recursive: true, force: true })));
});

describe('J · .env 候选顺序与可观测日志（T04557）', () => {
  it('J1 exe 同级有 .env、CWD 没有 → 命中前者，日志含全部候选', async () => {
    const userDataDir = await mkTmpDir();
    const exeDir = await mkTmpDir();
    const cwdDir = await mkTmpDir();
    const exeEnv = await writeEnv(exeDir, 'GLM_KEY=exe-key\n');
    const candidates = buildEnvFileCandidates({ userDataEnvPath: path.join(userDataDir, '.env'), apiDirEnvPath: exeEnv, cwd: cwdDir });
    const env: NodeJS.ProcessEnv = {};
    const logs: string[] = [];

    const hit = loadEnvFile(candidates, env, (m) => logs.push(m));

    expect(hit).toBe(exeEnv);
    expect(env.GLM_KEY).toBe('exe-key');
    expect(logs).toHaveLength(1);
    expect(logs[0]).toContain('已加载');
    for (const c of candidates) expect(logs[0]).toContain(c);
  });

  it('J2 两处都有但值不同 → 命中 exe 同级（顺序验收）', async () => {
    const userDataDir = await mkTmpDir();
    const exeDir = await mkTmpDir();
    const cwdDir = await mkTmpDir();
    const exeEnv = await writeEnv(exeDir, 'GLM_KEY=exe-key\n');
    await writeEnv(cwdDir, 'GLM_KEY=cwd-key\n');
    const candidates = buildEnvFileCandidates({ userDataEnvPath: path.join(userDataDir, '.env'), apiDirEnvPath: exeEnv, cwd: cwdDir });
    const env: NodeJS.ProcessEnv = {};

    const hit = loadEnvFile(candidates, env, () => {});

    expect(hit).toBe(exeEnv);
    expect(env.GLM_KEY).toBe('exe-key');
  });

  it('J3 chdir 到第三个目录后结果不变（去 CWD 依赖的核心条款）', async () => {
    const userDataDir = await mkTmpDir();
    const exeDir = await mkTmpDir();
    const thirdDir = await mkTmpDir();
    const exeEnv = await writeEnv(exeDir, 'GLM_KEY=exe-key\n');
    const deps = { userDataEnvPath: path.join(userDataDir, '.env'), apiDirEnvPath: exeEnv };

    const before = loadEnvFile(buildEnvFileCandidates({ ...deps, cwd: origCwd }), {}, () => {});
    process.chdir(thirdDir);
    const after = loadEnvFile(buildEnvFileCandidates(deps), {}, () => {});

    expect(before).toBe(exeEnv);
    expect(after, '命中项不应随 CWD 变化').toBe(before);
  });

  it('J4 全不命中 → 一行明确的「未找到 .env，候选=[…]」日志', async () => {
    const userDataDir = await mkTmpDir();
    const exeDir = await mkTmpDir();
    const cwdDir = await mkTmpDir();
    const candidates = buildEnvFileCandidates({
      userDataEnvPath: path.join(userDataDir, '.env'),
      apiDirEnvPath: path.join(exeDir, '.env'),
      cwd: cwdDir,
    });
    const logs: string[] = [];

    const hit = loadEnvFile(candidates, {}, (m) => logs.push(m));

    expect(hit).toBeNull();
    expect(logs).toHaveLength(1);
    expect(logs[0]).toContain('未找到 .env');
    for (const c of candidates) expect(logs[0]).toContain(c);
  });
});

describe('H · CWD 同名 config.json 内容归属校验（T04557）', () => {
  it('H1 权威路径缺失 + CWD 是非应用配置 → 跳过并 warn，应用配置不写进该文件', async () => {
    const root = await mkTmpDir();
    const cwdDir = path.join(root, 'cwd');
    await fs.mkdir(cwdDir);
    const hijackPath = path.join(cwdDir, 'config.json');
    const foreign = '{\n  "commands": ["build"],\n  "ports": { "api": 3000 }\n}';
    await fs.writeFile(hijackPath, foreign, 'utf8');
    const authoritativePath = path.join(root, 'authoritative', 'config.json');
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});

    const selected = getConfigPath({ cwd: cwdDir, authoritativePath });

    expect(selected, '非应用配置不能被采纳').toBe(authoritativePath);
    expect(warn).toHaveBeenCalledTimes(1);
    expect(String(warn.mock.calls[0][0])).toContain('忽略非应用配置文件');
    expect(String(warn.mock.calls[0][0])).toContain(hijackPath);

    // 调用方按 selected 落盘：应用配置落到权威路径，劫持文件逐字不变
    await fs.mkdir(path.dirname(authoritativePath), { recursive: true });
    await persistConfigFile({ vaultPath: '../data/vault' } as AppConfig, selected);
    expect(await fs.readFile(hijackPath, 'utf8')).toBe(foreign);
    expect((JSON.parse(await fs.readFile(authoritativePath, 'utf8')) as AppConfig).vaultPath).toBe('../data/vault');
  });

  it('H2 CWD 是有效应用配置 → 仍可采纳（不误杀兼容路径）', async () => {
    const root = await mkTmpDir();
    const cwdDir = path.join(root, 'cwd');
    await fs.mkdir(cwdDir);
    const cwdConfig = path.join(cwdDir, 'config.json');
    await fs.writeFile(cwdConfig, '{"vaultPath":"../data/vault"}', 'utf8');
    const authoritativePath = path.join(root, 'authoritative', 'config.json');
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});

    const selected = getConfigPath({ cwd: cwdDir, authoritativePath });

    expect(selected).toBe(cwdConfig);
    expect(warn).not.toHaveBeenCalled();
  });
});
