// T04518：前端「测试类型检查」通道锁。
// ------------------------------------------------------------------
// 背景：frontend/tsconfig.json 的 include 只有 src/**，测试文件天然不在任何类型检查面上——
// 测试里的 mock 签名漂移、fixture 缺字段只能等运行时暴雷（本次实测存量 26 个文件 / 65 处错误）。
// 这条通道（tsconfig.test.json + package.json 的 typecheck:test）一旦被人删掉、改窄，
// 或悄悄换成看不见 .vue 实例类型的裸 tsc，本锁立刻红，而不是退回「测试不受类型约束」。
import { describe, it, expect } from 'vitest';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

const FRONTEND = join(__dirname, '..');

interface JsonBag {
  extends?: string;
  include?: string[];
  scripts?: Record<string, string>;
}

function readJson(absPath: string): JsonBag {
  return JSON.parse(readFileSync(absPath, 'utf8')) as JsonBag;
}

describe('前端测试类型检查通道（T04518）', () => {
  it('tsconfig.test.json 继承生产配置，且同时把 src 与 test 纳入检查面', () => {
    const cfg = readJson(join(FRONTEND, 'tsconfig.test.json'));
    expect(cfg.extends, '测试配置必须继承 tsconfig.json，否则 strict 口径会漂移').toBe('./tsconfig.json');
    expect(cfg.include, 'src 与 test 都要在检查面上，少一个就等于另一半失守').toEqual(
      expect.arrayContaining(['src/**/*', 'test/**/*']),
    );
  });

  it('typecheck:test 走 vue-tsc 且指向本侧配置：裸 tsc 看不见 .vue 实例类型，指向 ../api 是挂错对象', () => {
    const script = readJson(join(FRONTEND, 'package.json')).scripts?.['typecheck:test'];
    if (!script) throw new Error('frontend/package.json 缺 typecheck:test 脚本，测试面重新脱离类型检查');
    expect(script, '前端测试面必须走 vue-tsc（与 build 同源），退化成 tsc 会漏掉 SFC 类型').toContain('vue-tsc');
    expect(script, '脚本必须检查前端自己的配置，指向上一级 api 等于把前端测试面挂到别人的面上').not.toContain('../');
    const target = /-p\s+(\S+)/.exec(script);
    if (!target) throw new Error('typecheck:test 必须用 -p 显式指定 tsconfig，否则检查的是默认生产面');
    expect(existsSync(join(FRONTEND, target[1])), `typecheck:test 指向的 ${target[1]} 不存在`).toBe(true);
  });

  it('api 侧同类通道仍在，两侧不能只有一侧受约束', () => {
    const apiScript = readJson(join(FRONTEND, '..', 'api', 'package.json')).scripts?.['typecheck:test'];
    expect(apiScript, 'api/package.json 的 typecheck:test 被删会让两侧口径再次分叉').toContain('tsconfig.test.json');
  });
});
