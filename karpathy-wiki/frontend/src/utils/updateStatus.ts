// T04568：把 check-update 的本地/回退分支翻译成 About 页可操作的提示。
// 旧版 config.json 的 update.enabled=false 会原样保留（升级不继承新默认值），
// 此时若仍显示「已是最新」会误导用户；必须明确告知「未启用」或「检查失败」。
export type UpdateOffKind = 'disabled' | 'unconfigured' | 'check-failed';

export function updateOffKind(source?: string, reason?: string): UpdateOffKind | null {
  if (source === 'local') return reason === 'unconfigured' ? 'unconfigured' : 'disabled';
  if (source === 'local-fallback') return 'check-failed';
  return null;
}
