// T02886：配置相对路径定根统一通道（anchorConfigPaths / portableConfigForDisk）。
// ------------------------------------------------------------------
// 缺陷：config.ts 原先只在 IS_SEA 时 applySeaRebase，开发模式配置里的相对值保持相对，
//   实际落点随进程 CWD 漂移（从仓库根起进程 vs 从 api 目录起进程，vault 读写指到不同目录）。
// 本用例直接测纯函数（loadConfig 读真实 config.json + 30s 缓存，不便隔离）：
//   A 定根：非 SEA 相对值按 api 目录 resolve（与 toAbsVaultPath 同锚）、绝对值原样、
//     空串保留（logFilePath 空=不落盘）；SEA 相对值映射用户数据目录规范文件名（原 applySeaRebase 语义）；
//   B 例外锚：logging.logFilePath 的消费基准是 api 上一级（index.ts setupLoggerStream 历史口径，
//     用户现存日志在仓库根 logs/）——非 SEA 定根沿用同一公式，不挪现有落点；
//   C 落盘可移植：portableConfigForDisk 把定根产生的绝对值还原回原相对写法（逐字段往返），
//     树外用户绝对值原样保留（SEA 的 LOCALAPPDATA 值不被改写），非路径字段不受影响；
//   D 源码级锁：不再存在第二份「把相对配置定根」的实现——applySeaRebase 已删除、
//     auth.ts 的 getDataDir()+basename 已改为复用 toAbsVaultPath、写盘全部收口 persistConfigFile。
// T04556 追加（不改动 A~E 既有断言）：
//   F 回落可观测：读失败/解析失败不再零日志，损坏文件改名留证、不被下次保存永久覆盖；
//   I 原子落盘：无 .tmp 残留、.bak 恒为上一版、rename 失败不破坏目标；
//   R 备份还原：以 .bak 为准且不销毁备份，缺失/非法备份拒绝还原。
//   全部在 fs.mkdtemp 临时目录内进行，绝不触碰真实 config.json。
import { describe, it, expect, vi, afterEach } from 'vitest';
import fs from 'node:fs/promises';
import fsPromises from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import {
  anchorConfigPaths,
  portableConfigForDisk,
  persistConfigFile,
  getConfigPath,
  loadConfig,
  restoreConfigFromBackup,
  getConfigSource,
  getPathWarnings,
  ConfigMigrationError,
} from '../src/config.js';
import { getApiDir, getUserDataDir } from '../src/utils/runtime.js';
import { toAbsVaultPath } from '../src/utils/harness-dirs.js';
import type { AppConfig } from '../src/types.js';

const apiDir = getApiDir();

function fixture(over: Partial<AppConfig> = {}): AppConfig {
  return {
    vaultPath: '../data/vault',
    auth: { usersFilePath: '../data/users.json', auditLogPath: '../data/audit.log' },
    urlCrawl: { logging: { enabled: false, logFilePath: '../data/url-crawl.log' }, incrementalStatePath: '../data/url-crawl-state.json' },
    // logging 段带 level 键——portableConfigForDisk 靠它区分与 urlCrawl.logging 的不同还原基准
    logging: { level: 'info', enableRequestLog: true, logFilePath: '../logs/api-dev.log' },
    ...over,
  } as AppConfig;
}

describe('A · 非 SEA 定根：相对值按 api 目录 resolve，绝对值原样，空串保留', () => {
  it('五个路径字段全部钉到绝对值，vaultPath 与 toAbsVaultPath 同锚', () => {
    const cfg = fixture();
    anchorConfigPaths(cfg, { sea: false });
    expect(cfg.vaultPath).toBe(toAbsVaultPath('../data/vault'));
    expect(path.isAbsolute(cfg.auth!.usersFilePath!)).toBe(true);
    expect(cfg.auth!.usersFilePath).toBe(toAbsVaultPath('../data/users.json'));
    expect(cfg.auth!.auditLogPath).toBe(toAbsVaultPath('../data/audit.log'));
    expect(cfg.urlCrawl!.logging!.logFilePath).toBe(toAbsVaultPath('../data/url-crawl.log'));
    expect(cfg.urlCrawl!.incrementalStatePath).toBe(toAbsVaultPath('../data/url-crawl-state.json'));
  });

  it('空串不落盘语义保留：logging.logFilePath=\'\' 定根后仍为 \'\'', () => {
    const cfg = fixture({ logging: { level: 'info', enableRequestLog: false, logFilePath: '' } });
    anchorConfigPaths(cfg, { sea: false });
    expect(cfg.logging!.logFilePath).toBe('');
  });

  it('用户显式绝对路径原样保留（自定义 vault 位置不被改写）', () => {
    const custom = path.resolve(os.tmpdir(), 'elsewhere-vault');
    const cfg = fixture({ vaultPath: custom });
    anchorConfigPaths(cfg, { sea: false });
    expect(cfg.vaultPath).toBe(custom);
  });
});

describe('B · 例外锚：logging.logFilePath 按 api 上一级定根（不挪仓库根 logs/ 现有落点）', () => {
  it('\'../logs/api-dev.log\' 定根到仓库根 logs/，而非 api 目录下', () => {
    const cfg = fixture();
    anchorConfigPaths(cfg, { sea: false });
    expect(cfg.logging!.logFilePath).toBe(path.resolve(apiDir, '..', '../logs/api-dev.log'));
  });
});

describe('A-SEA · SEA 分支沿用原 applySeaRebase 语义（相对值映射用户数据目录规范文件名）', () => {
  it('相对值丢弃相对目录部分落到 dataDir/<规范名>，绝对值原样', () => {
    const cfg = fixture();
    anchorConfigPaths(cfg, { sea: true });
    const dataDir = path.join(getUserDataDir(), 'data');
    expect(cfg.vaultPath).toBe(path.join(dataDir, 'vault'));
    expect(cfg.auth!.usersFilePath).toBe(path.join(dataDir, 'users.json'));
    expect(cfg.urlCrawl!.incrementalStatePath).toBe(path.join(dataDir, 'url-crawl-state.json'));
    const custom = path.resolve(os.tmpdir(), 'elsewhere-vault');
    const cfg2 = fixture({ vaultPath: custom });
    anchorConfigPaths(cfg2, { sea: true });
    expect(cfg2.vaultPath).toBe(custom);
  });
});

describe('C · 落盘可移植：portableConfigForDisk 逐字段往返', () => {
  it('定根后的绝对值还原回原相对写法（含 logging.logFilePath 的仓库根锚）', () => {
    const original = fixture();
    const cfg = JSON.parse(JSON.stringify(original)) as AppConfig;
    anchorConfigPaths(cfg, { sea: false });
    const portable = portableConfigForDisk(cfg);
    expect(portable.vaultPath).toBe('../data/vault');
    expect(portable.auth!.usersFilePath).toBe('../data/users.json');
    expect(portable.auth!.auditLogPath).toBe('../data/audit.log');
    expect(portable.urlCrawl!.logging!.logFilePath).toBe('../data/url-crawl.log');
    expect(portable.urlCrawl!.incrementalStatePath).toBe('../data/url-crawl-state.json');
    expect(portable.logging!.logFilePath).toBe('../logs/api-dev.log');
  });

  it('树外用户绝对值不被改写（自定义 vault 在定根树之外）', () => {
    const custom = path.resolve(os.tmpdir(), 'elsewhere-vault');
    const cfg = fixture({ vaultPath: custom });
    anchorConfigPaths(cfg, { sea: false });
    expect(portableConfigForDisk(cfg).vaultPath).toBe(custom);
  });

  it('相对值透传幂等；非路径字段不受影响', () => {
    const cfg = fixture();
    const once = portableConfigForDisk(cfg);
    expect(once.vaultPath).toBe('../data/vault');
    expect((once as unknown as Record<string, unknown>).server ?? 'no-server-key').toBe('no-server-key');
    const twice = portableConfigForDisk(JSON.parse(JSON.stringify(cfg)) as AppConfig);
    expect(twice).toEqual(cfg);
  });
});

describe('D · 源码级锁：不再有第二份定根实现，写盘收口单一出口', () => {
  it('applySeaRebase 已删除；auth.ts 复用 toAbsVaultPath；save* 写盘全部走 persistConfigFile', async () => {
    const srcDir = path.resolve(apiDir, 'src');
    const read = (rel: string) => fs.readFile(path.join(srcDir, rel), 'utf8');
    const configSrc = await read('config.ts');
    // 函数本体应已删除（注释里允许留历史名，故只匹配定义与调用）
    expect(configSrc, 'applySeaRebase 应已被统一通道取代').not.toMatch(/function applySeaRebase|applySeaRebase\(/);
    const authSrc = await read('routes/auth.ts');
    expect(authSrc).toContain('toAbsVaultPath');
    expect(authSrc, 'getDataDir()+basename 的第三份定根实现应已移除').not.toContain('path.basename(config.');
    // 整份回写收口：config.json 的直接 fs.writeFile 只允许三处——persistConfigFile 自身、
    // 导入备份 .bak、失败回滚（后两者写的是盘上原形 prev，不经定根）
    const directWrites = [...configSrc.matchAll(/fs\.writeFile\(.*configPath.*'utf8'\)/g)].map((m) => m[0]);
    expect(directWrites.length, `config.json 直写点应只剩 3 处，实际：${directWrites.join(' | ')}`).toBe(3);
    expect(directWrites[0]).toContain('portableConfigForDisk');
    expect(configSrc.match(/await persistConfigFile\(/g)!.length).toBeGreaterThanOrEqual(15);
    expect(await read('utils/url-crawl.ts')).toContain('toAbsVaultPath');
  });

  it('persistConfigFile 落盘的是 portable 形态（临时目录验证写盘不改相对写法）', async () => {
    // persistConfigFile 写 getConfigPath()——真实 config.json 是用户生产文件，绝不触碰；
    // 这里只验证「序列化即 portable」这一纯行为（写盘目标由 getConfigPath 决定，路径态已被 C 覆盖）。
    const cfg = fixture();
    anchorConfigPaths(cfg, { sea: false });
    const portable = portableConfigForDisk(cfg);
    expect(JSON.stringify(portable)).not.toContain(toAbsVaultPath('../data/vault'));
    expect(getConfigPath(), '真实实例 config.json 存在（只读确认，不写入）').toBeTruthy();
  });
});

describe('E · 双 CWD 等价：从不同目录起进程，定根后指向同一 vault（验收条款 1）', () => {
  it('chdir 到仓库根再定根，五个路径字段与 api 目录起法逐一相同；VaultService 列表一致', async () => {
    const cfgA = fixture();
    anchorConfigPaths(cfgA, { sea: false });
    const origCwd = process.cwd();
    try {
      process.chdir(path.resolve(apiDir, '..')); // 仓库根——缺陷场景里 vault 会漂到别处的起法
      const cfgB = fixture();
      anchorConfigPaths(cfgB, { sea: false });
      expect(cfgB.vaultPath, 'vaultPath 不随 CWD 漂移').toBe(cfgA.vaultPath);
      expect(cfgB.logging!.logFilePath).toBe(cfgA.logging!.logFilePath);
      expect(cfgB.urlCrawl!.incrementalStatePath).toBe(cfgA.urlCrawl!.incrementalStatePath);
    } finally {
      process.chdir(origCwd);
    }
    // 真实 vault 只读冒烟：同一绝对路径下两个 VaultService 实例列出同一套页面
    // （等价于「两个起法的 /api/vault/tree 返回同一套页面」，读侧不写盘）
    const { VaultService } = await import('../src/vault/vault-service.js');
    const a = new VaultService(cfgA.vaultPath);
    const b = new VaultService(cfgA.vaultPath);
    await a.init();
    await b.init();
    expect((await b.listAllPages()).map((p) => p.path)).toEqual((await a.listAllPages()).map((p) => p.path));
    expect((await a.listAllPages()).length, '真实 vault 应能列出页面（锚定路径可用）').toBeGreaterThan(0);
    // 本用例真实读全库（两个 VaultService 各列一遍页面），单跑实测 6.1 s > 默认 5 s 预算；
    //   全量并跑时 libuv 线程池被其它用例占满，更容易顶穿——按测量值给显式超时，不动共享配置。
  }, 20_000);
});

// T04556：隔离目录收集与清理——任何用例都只在自己的 mkdtemp 目录里读写
const tmpDirs: string[] = [];

async function mkTmpDir(): Promise<string> {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'kw-t04556-'));
  tmpDirs.push(dir);
  return dir;
}

afterEach(async () => {
  vi.restoreAllMocks();
  await Promise.all(tmpDirs.splice(0).map((d) => fs.rm(d, { recursive: true, force: true })));
});

describe('F · 读盘失败可观测：告警带路径 + 损坏文件留证（T04556）', () => {
  it('F1 文件缺失：回落默认值并打印一次含路径的告警，不凭空生成配置文件', async () => {
    const dir = await mkTmpDir();
    const configPath = path.join(dir, 'config.json');
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});

    const cfg = await loadConfig(configPath);

    expect(cfg.vaultPath).toBe('../data/vault');
    expect(cfg.llm.provider).toBe('glm');
    expect(getConfigSource()).toBe('defaults-after-read-error');
    expect(warn).toHaveBeenCalledTimes(1);
    const msg = String(warn.mock.calls[0][0]);
    expect(msg, '告警必须点名是哪个路径读失败').toContain(configPath);
    expect(msg).toContain('读取失败');
    expect(await fs.readdir(dir), '回落是只读动作，不应创建文件').toEqual([]);
  });

  it('F2 截断 JSON：回落默认值，原文件改名留证且字节不变', async () => {
    const dir = await mkTmpDir();
    const configPath = path.join(dir, 'config.json');
    const corrupt = '{\n  "vaultPath": "../data/va';
    await fs.writeFile(configPath, corrupt, 'utf8');
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});

    const cfg = await loadConfig(configPath);

    expect(cfg.vaultPath).toBe('../data/vault');
    expect(getConfigSource()).toBe('defaults-after-parse-error');
    const files = await fs.readdir(dir);
    expect(files).toHaveLength(1);
    expect(files[0]).toMatch(/^config\.json\.corrupt-\d/);
    expect(await fs.readFile(path.join(dir, files[0]), 'utf8'), '损坏内容必须原样留证').toBe(corrupt);
    const msg = String(warn.mock.calls[0][0]);
    expect(msg).toContain('JSON 解析失败');
    expect(msg).toContain(files[0]);
  });

  it('F3 损坏回落后再保存：损坏证据仍在，新配置可被重新读回', async () => {
    const dir = await mkTmpDir();
    const configPath = path.join(dir, 'config.json');
    const corrupt = '{"vaultPath": ';
    await fs.writeFile(configPath, corrupt, 'utf8');
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    await loadConfig(configPath);

    const cfg = fixture({ vaultPath: '../data/vault-2' });
    anchorConfigPaths(cfg, { sea: false });
    await persistConfigFile(cfg, configPath);

    const files = await fs.readdir(dir);
    const corruptFile = files.find((f) => f.startsWith('config.json.corrupt-'));
    expect(corruptFile, '损坏文件不应被新保存覆盖或删除').toBeTruthy();
    expect(await fs.readFile(path.join(dir, corruptFile!), 'utf8')).toBe(corrupt);

    const reread = await loadConfig(configPath);
    expect(reread.vaultPath).toBe(toAbsVaultPath('../data/vault-2'));
    expect(getConfigSource()).toBe('file');
  });
});

describe('I · 原子落盘：无 .tmp 残留、.bak 为上一版、失败不破坏目标（T04556）', () => {
  it('I1 连续两次保存：无 .tmp 残留，.bak 恰为上一版落盘内容', async () => {
    const dir = await mkTmpDir();
    const configPath = path.join(dir, 'config.json');
    const cfg1 = fixture({ vaultPath: '../data/v1' });
    anchorConfigPaths(cfg1, { sea: false });
    await persistConfigFile(cfg1, configPath);
    const first = await fs.readFile(configPath, 'utf8');
    expect(await fs.readdir(dir), '首次保存无旧文件可备份').toEqual(['config.json']);

    const cfg2 = fixture({ vaultPath: '../data/v2' });
    anchorConfigPaths(cfg2, { sea: false });
    await persistConfigFile(cfg2, configPath);

    expect((await fs.readdir(dir)).sort()).toEqual(['config.json', 'config.json.bak']);
    expect(await fs.readFile(`${configPath}.bak`, 'utf8')).toBe(first);
    expect(await fs.readFile(configPath, 'utf8')).toBe(JSON.stringify(portableConfigForDisk(cfg2), null, 2));
  });

  it('I2 rename 失败：目标保持完整旧内容、.tmp 被清理、错误上抛', async () => {
    const dir = await mkTmpDir();
    const configPath = path.join(dir, 'config.json');
    const old = '{"vaultPath":"../data/old"}';
    await fs.writeFile(configPath, old, 'utf8');
    const cfg = fixture({ vaultPath: '../data/v3' });
    anchorConfigPaths(cfg, { sea: false });
    const spy = vi
      .spyOn(fsPromises, 'rename')
      .mockRejectedValueOnce(Object.assign(new Error('EACCES: contrived'), { code: 'EACCES' }));

    await expect(persistConfigFile(cfg, configPath)).rejects.toThrow('EACCES');

    expect(spy).toHaveBeenCalledTimes(1);
    expect(await fs.readFile(configPath, 'utf8'), 'rename 失败时目标不能被截断').toBe(old);
    expect(await fs.readFile(`${configPath}.bak`, 'utf8')).toBe(old);
    expect((await fs.readdir(dir)).sort(), '.tmp 必须被清理').toEqual(['config.json', 'config.json.bak']);
  });

  it('I3 三次保存：.bak 只保留最近一版前态，全程无 .tmp', async () => {
    const dir = await mkTmpDir();
    const configPath = path.join(dir, 'config.json');
    const snaps: string[] = [];
    for (const vault of ['../data/a', '../data/b', '../data/c']) {
      const cfg = fixture({ vaultPath: vault });
      anchorConfigPaths(cfg, { sea: false });
      await persistConfigFile(cfg, configPath);
      snaps.push(await fs.readFile(configPath, 'utf8'));
      expect((await fs.readdir(dir)).filter((f) => f.endsWith('.tmp'))).toEqual([]);
    }
    expect(await fs.readFile(`${configPath}.bak`, 'utf8')).toBe(snaps[1]);
    expect(await fs.readFile(configPath, 'utf8')).toBe(snaps[2]);
  });
});

describe('R · 备份还原：以 .bak 为准且不销毁备份（T04556）', () => {
  it('R1 还原：config.json 回到备份内容，.bak 原样保留，来源回到 file', async () => {
    const dir = await mkTmpDir();
    const configPath = path.join(dir, 'config.json');
    const good = fixture({ vaultPath: '../data/good' });
    anchorConfigPaths(good, { sea: false });
    await persistConfigFile(good, configPath);
    const newer = fixture({ vaultPath: '../data/newer' });
    anchorConfigPaths(newer, { sea: false });
    await persistConfigFile(newer, configPath);
    const bakBytes = await fs.readFile(`${configPath}.bak`, 'utf8');
    await fs.writeFile(configPath, '{broken', 'utf8');

    const restored = await restoreConfigFromBackup(configPath);

    expect(restored.vaultPath).toBe(toAbsVaultPath('../data/good'));
    const onDisk = JSON.parse(await fs.readFile(configPath, 'utf8')) as AppConfig;
    expect(onDisk.vaultPath).toBe('../data/good');
    expect(await fs.readFile(`${configPath}.bak`, 'utf8'), '还原不得销毁唯一可用的备份').toBe(bakBytes);
    expect(getConfigSource()).toBe('file');
    expect((await fs.readdir(dir)).sort()).toEqual(['config.json', 'config.json.bak']);
  });

  it('R2 无备份：抛 ConfigMigrationError，且不创建 config.json', async () => {
    const dir = await mkTmpDir();
    const configPath = path.join(dir, 'config.json');
    await expect(restoreConfigFromBackup(configPath)).rejects.toBeInstanceOf(ConfigMigrationError);
    await expect(restoreConfigFromBackup(configPath)).rejects.toThrow('未找到配置备份');
    expect(await fs.readdir(dir)).toEqual([]);
  });

  it('R3 备份非法：拒绝还原，当前文件不被改动', async () => {
    const dir = await mkTmpDir();
    const configPath = path.join(dir, 'config.json');
    const current = '{"vaultPath":"../data/current"}';
    await fs.writeFile(configPath, current, 'utf8');
    await fs.writeFile(`${configPath}.bak`, '{nope', 'utf8');

    await expect(restoreConfigFromBackup(configPath)).rejects.toBeInstanceOf(ConfigMigrationError);
    await expect(restoreConfigFromBackup(configPath)).rejects.toThrow('备份不是合法 JSON');
    expect(await fs.readFile(configPath, 'utf8')).toBe(current);
  });
});

// ── T04558：定根后的绝对路径失效要能看见（只告警不改写） ──
// 触发面：UI 选目录把 vaultPath 存成绝对值，重装换盘后路径不存在 → 读不到库却像「配置丢了」。
// 四条锁住口径：报失效项、不误报存在项、探测在定根之后、空串是合法语义。
describe('K · 路径失效告警（T04558）', () => {
  const tempDirs: string[] = [];
  async function makeDir(prefix: string): Promise<string> {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), prefix));
    tempDirs.push(dir);
    return dir;
  }
  async function writeConfig(dir: string, body: Record<string, unknown>): Promise<string> {
    const p = path.join(dir, 'config.json');
    await fs.writeFile(p, JSON.stringify(body, null, 2), 'utf8');
    return p;
  }
  afterEach(async () => {
    for (const d of tempDirs.splice(0)) await fs.rm(d, { recursive: true, force: true });
  });

  it('K1 · vaultPath 指向不存在目录 → 告警含该项，且原值未被改写', async () => {
    const dir = await makeDir('t04558-k1-');
    const missing = path.join(dir, 'not-there');
    const cfg = await loadConfig(await writeConfig(dir, { vaultPath: missing }));

    expect(cfg.vaultPath).toBe(missing);
    expect(getPathWarnings()).toContainEqual({ field: 'vaultPath', path: missing, reason: '目录不存在' });
  });

  it('K2 · 路径存在 → 不产生告警', async () => {
    const dir = await makeDir('t04558-k2-');
    const vault = path.join(dir, 'vault');
    await fs.mkdir(vault);
    await loadConfig(await writeConfig(dir, { vaultPath: vault, logging: { level: 'info', logFilePath: '' } }));

    expect(getPathWarnings()).toEqual([]);
  });

  it('K3 · 相对值定根后存在 → 不误报告警（探测发生在定根之后）', async () => {
    const dir = await makeDir('t04558-k3-');
    const rel = path.relative(apiDir, dir);
    const cfg = await loadConfig(await writeConfig(dir, { vaultPath: rel, logging: { level: 'info', logFilePath: '' } }));

    expect(path.isAbsolute(cfg.vaultPath)).toBe(true);
    expect(path.resolve(cfg.vaultPath)).toBe(path.resolve(dir));
    expect(getPathWarnings()).toEqual([]);
  });

  it('K4 · 空串 logging.logFilePath 不告警（空 = 不落盘是合法语义）', async () => {
    const dir = await makeDir('t04558-k4-');
    await loadConfig(await writeConfig(dir, { vaultPath: dir, logging: { level: 'info', logFilePath: '' } }));

    expect(getPathWarnings().some((w) => w.field === 'logging.logFilePath')).toBe(false);
  });
});
