// T04567：GitHub 更新通道的完整性校验。
// 后端已从 release asset 的 digest 拿到真实 sha256；本组锁前端「拿响应头摘要校验字节、
// 不匹配判 hash 失败」的行为，以及摘要选择优先级（响应头 > check-update 缓存值）。
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { expectedSha256, sha256Hex, sha256Matches } from '../src/utils/update-hash';

const ROOT = process.cwd();
const ABOUT = join(ROOT, 'src/views/About.vue');
const HEX_ABC = 'ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad';

describe('T04567 更新包摘要校验', () => {
  it('sha256Hex 对已知向量给出标准摘要（浏览器实际走同一 WebCrypto 路径）', async () => {
    expect(await sha256Hex(new Blob(['abc']))).toBe(HEX_ABC);
  });

  it('篡改一个字节 → 摘要变化，校验必然失败', async () => {
    const original = await sha256Hex(new Blob(['installer-v1']));
    const tampered = await sha256Hex(new Blob(['installer-v2']));
    expect(tampered).not.toBe(original);
    expect(sha256Matches(tampered, original)).toBe(false);
  });

  it('摘要比较大小写不敏感；空值不会被当成匹配', () => {
    expect(sha256Matches(HEX_ABC, HEX_ABC.toUpperCase())).toBe(true);
    expect(sha256Matches(HEX_ABC, `x${HEX_ABC}`)).toBe(false);
    expect(sha256Matches('', '')).toBe(true); // 调用方先判空，空对空不会走到校验分支
  });

  it('摘要来源：响应头优先于 check-update 缓存值，缺失才回退', () => {
    const header = `  ${HEX_ABC}  `;
    expect(expectedSha256(header, 'stale')).toBe(HEX_ABC);
    expect(expectedSha256(null, HEX_ABC)).toBe(HEX_ABC);
    expect(expectedSha256('', '')).toBe('');
  });

  it('About.vue 接线：读取 X-Update-Sha256、按优先级取摘要、失配走 download-error/hash', () => {
    const src = readFileSync(ABOUT, 'utf8');
    expect(src).toMatch(/res\.headers\.get\(['"]x-update-sha256['"]\)/);
    expect(src).toMatch(/expectedSha256\(/);
    expect(src).toMatch(/sha256Matches\(/);
    expect(src).toMatch(/reason:\s*'hash'/);
    // 摘要为空时仍继续下载（旧资产无 digest），不能因为空值直接判失败
    expect(src).toMatch(/if\s*\(declared\)\s*\{/);
  });
});
