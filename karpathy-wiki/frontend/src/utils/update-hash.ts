// T04567：更新包完整性校验的纯逻辑（与 About.vue 解耦，便于单测）。
// 为什么抽出来：下载代理在响应头里回传本次下载对应的摘要，check-update 的缓存值
// 可能已过期（发布方替换资产后 5 分钟内仍是旧摘要）；优先用响应头才能保证
// 「校验值」与「实际字节」同源。

/** 本次下载应使用的 sha256：响应头优先，其次 check-update 的声明值；都没有返回空串（跳过校验）。 */
export function expectedSha256(
  headerValue: string | null | undefined,
  fallback?: string | null,
): string {
  return (headerValue || fallback || '').trim();
}

/** 摘要比较：十六进制大小写不敏感；任一侧为空视为不匹配（调用方负责先判空）。 */
export function sha256Matches(actual: string, expected: string): boolean {
  return actual.toLowerCase() === expected.toLowerCase();
}

/** 计算 Blob 的 sha256 十六进制摘要（WebCrypto）。 */
export async function sha256Hex(blob: Blob): Promise<string> {
  const bytes = new Uint8Array(await blob.arrayBuffer());
  const digest = await crypto.subtle.digest('SHA-256', bytes);
  return Array.from(new Uint8Array(digest))
    .map((b) => b.toString(16).padStart(2, '0'))
    .join('');
}
