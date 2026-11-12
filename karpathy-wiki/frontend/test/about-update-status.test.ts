// T04568：升级安装保留旧 config.json（update.enabled=false）时，About 页必须明确提示
// 「未启用检查更新」，而不是把本地分支伪装成「已是最新」。
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { updateOffKind, checkFailureLabel } from '../src/utils/updateStatus';

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

// T05702：失败文案必须按后端细分原因走，不能把 404 / 配置错 / 解析失败
// 统统显示成「远端更新源不可达」。
describe('T05702 检查失败文案映射', () => {
  it('HTTP 404 → 远端暂无已发布版本（用户实际遇到的误报场景）', () => {
    expect(checkFailureLabel('http', 'HTTP 404')).toBe('远端暂无已发布版本');
  });

  it('其它 HTTP 状态 → 更新源返回异常', () => {
    expect(checkFailureLabel('http', 'HTTP 429')).toBe('更新源返回异常');
    expect(checkFailureLabel('http', 'HTTP 500')).toBe('更新源返回异常');
  });

  it('配置错误 → 更新源配置有误', () => {
    expect(checkFailureLabel('config')).toBe('更新源配置有误');
  });

  it('响应解析失败 → 更新源响应异常（逻辑错误不误报网络）', () => {
    expect(checkFailureLabel('response')).toBe('更新源响应异常');
  });

  it('network 与旧后端（无 error_kind）→ 兜底远端更新源不可达', () => {
    expect(checkFailureLabel('network')).toBe('远端更新源不可达');
    expect(checkFailureLabel()).toBe('远端更新源不可达');
  });

  it('About.vue 接线：走 checkFailureLabel，不再写死那句不可达按钮提示', () => {
    expect(SRC).toContain('checkFailureLabel');
    expect(SRC).not.toContain('data-tip="远端更新源不可达，可重试"');
  });
});
