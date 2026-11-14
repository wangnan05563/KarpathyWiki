// T05745 P3：气泡模式开关的唯一读取入口。
// Query.vue / FloatingChat.vue / MobileQuery.vue 共用，避免三处各自解析 localStorage/URL
// 出现「桌面已切 v2、悬浮窗仍 legacy」的不一致。
import { STORAGE_KEYS } from '../constants/storageKeys';

export type BubbleMode = 'v2' | 'legacy';

/** 默认 v2；localStorage 或 URL ?bubble=legacy 可一键回滚到旧渲染。 */
export function readBubbleMode(): BubbleMode {
  try {
    // 兼容任务口径的裸键 bubbleMode 与仓库前缀键 kw:bubbleMode
    const stored = localStorage.getItem(STORAGE_KEYS.BUBBLE_MODE) ?? localStorage.getItem('bubbleMode');
    if (stored === 'v2' || stored === 'legacy') return stored;
    const fromUrl = new URLSearchParams(window.location.search).get('bubble');
    if (fromUrl === 'v2' || fromUrl === 'legacy') return fromUrl;
  } catch {
    // localStorage / URL 不可用时按默认 v2，不影响问答
  }
  return 'v2';
}
