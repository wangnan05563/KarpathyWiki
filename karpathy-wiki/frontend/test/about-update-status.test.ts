// T04568：升级安装保留旧 config.json（update.enabled=false）时，About 页必须明确提示
// 「未启用检查更新」，而不是把本地分支伪装成「已是最新」。
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { updateOffKind } from '../src/utils/updateStatus';

const SRC = readFileSync(join(process.cwd(), 'src/views/About.vue'), 'utf8');

describe('T04568 未启用更新的提示映射', () => {
  it('source=local + reason=disabled → disabled（升级安装的旧配置）', () => {
    expect(updateOffKind('local', 'disabled')).toBe('disabled');
  });

  it('source=local + reason=unconfigured → unconfigured（启用但没填通道）', () => {
    expect(updateOffKind('local', 'unconfigured')).toBe('unconfigured');
  });

  it('source=local 缺 reason（旧后端）→ 按 disabled 提示，不显示已是最新', () => {
    expect(updateOffKind('local', undefined)).toBe('disabled');
  });

  it('source=local-fallback → check-failed（远端不可达）', () => {
    expect(updateOffKind('local-fallback', 'remote-error')).toBe('check-failed');
  });

  it('远端通道判定成功（github/remote）→ null，走 latest 分支', () => {
    expect(updateOffKind('github')).toBeNull();
    expect(updateOffKind('remote')).toBeNull();
    expect(updateOffKind(undefined)).toBeNull();
  });
});

describe('T04568 About.vue 接线', () => {
  it('本地分支用 updateOffKind 分流，不再一律显示已是最新', () => {
    expect(SRC).toMatch(/updateOffKind\(data\.source, data\.reason\)/);
    expect(SRC).toMatch(/kind: 'disabled', reason: off/);
    expect(SRC).toMatch(/kind: 'check-failed'/);
  });

  it('按钮与提示文案可查：未启用/未配置 + 指向 config.json 的 update 段', () => {
    expect(SRC).toContain('未启用检查更新');
    expect(SRC).toContain('未配置更新通道');
    expect(SRC).toMatch(/api\/config\.json/);
    expect(SRC).toMatch(/enabled=true/);
    expect(SRC).toMatch(/githubRepo/);
  });
});
