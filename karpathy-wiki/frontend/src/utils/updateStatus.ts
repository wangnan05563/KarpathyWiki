// T04568：把 check-update 的本地/回退分支翻译成 About 页可操作的提示。
// 旧版 config.json 的 update.enabled=false 会原样保留（升级不继承新默认值），
// 此时若仍显示「已是最新」会误导用户；必须明确告知「未启用」或「检查失败」。
export type UpdateOffKind = 'disabled' | 'unconfigured' | 'check-failed';

export function updateOffKind(source?: string, reason?: string): UpdateOffKind | null {
  if (source === 'local') return reason === 'unconfigured' ? 'unconfigured' : 'disabled';
  if (source === 'local-fallback') return 'check-failed';
  return null;
}

// T05702：把后端 check-update 的 error_kind/error_detail 翻成可操作文案。
// 旧实现无论 404（远端暂无发布版本）、配置写错、JSON 解析失败都显示
// 「远端更新源不可达」，与实际原因不符且误导排障方向。
// 未知/旧后端（没有 error_kind）仍按网络不可达兜底，保持向后兼容。
export type CheckFailureKind = 'config' | 'network' | 'http' | 'response';

export function checkFailureLabel(kind?: string, detail?: string): string {
  if (kind === 'config') return '更新源配置有误';
  if (kind === 'response') return '更新源响应异常';
  if (kind === 'http') {
    if (detail?.includes('404')) return '远端暂无已发布版本';
    return '更新源返回异常';
  }
  return '远端更新源不可达';
}
