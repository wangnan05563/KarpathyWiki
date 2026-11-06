import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';

// T03611：投递原件留存按 currentUser 归属。编译请求若用裸 fetch，
// 后端拿不到 Bearer token，auth 启用部署下 ownerId=null，本人「已投递原始文档」
// 永远为空、下载 404。这类回归在 API 单测里看不出来，用源码守护钉住。
// T04508 起发起方从 Progress.vue 搬到 stores/compile.ts（编译流归 store 持有），
// 守护的对象没变、锚点跟着搬：仍要求「编译 POST 走 apiFetch」。
describe('投递编译请求必须携带登录态 (T03611)', () => {
  const src = fs.readFileSync(path.resolve(__dirname, '../src/stores/compile.ts'), 'utf8');

  it('编译 POST 走 apiFetch（注入 Bearer）', () => {
    expect(src).toMatch(/await apiFetch\(endpoint,/);
  });

  it('不得退回裸 fetch 发编译请求', () => {
    expect(src).not.toMatch(/await fetch\(endpoint,/);
  });
});
