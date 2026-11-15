// T05746：消息气泡外观参数（打字机 / 流光 / 淡出 / 思考默认展开）
//
// 为什么单独做一个模块级单例：
//   1. 配置页与问答页是两条路由，若各自读一次 localStorage，配置改完切回问答页
//      不会生效（除非重新挂载）；模块级 reactive + 全局 watch 让两处共享同一份状态。
//   2. CSS 时长必须由根元素注入，而不是写死在 .kw-shimmer__band；样式在
//      message-bubble.css 里只负责 var() 消费，默认值也留在 CSS 里兜底。
//   3. 所有持久化键统一走 STORAGE_KEYS，避免再散落字面量。
import { reactive, watch } from 'vue';
import { STORAGE_KEYS } from '../constants/storageKeys';

export interface BubbleSettings {
  /** 回答是否逐字打字；关闭后一次性全量展示，流光仍独立生效 */
  typewriter: boolean;
  /** 是否渲染流光覆盖层；关闭后 running 态仍有光标/进度骨架 */
  shimmer: boolean;
  /** 流光速度倍率：0.5 慢 ~ 2.0 快；1.0 对应基础 1.7s 扫过一轮 */
  shimmerSpeed: number;
  /** done 后覆盖层淡出时长（ms）；必须与卸载定时器一致 */
  shimmerFadeMs: number;
  /** done 后思考块默认展开态；running 期间仍由 ThinkBlock 自动展开 */
  thinkExpanded: boolean;
}

/** 设计稿基准：1x 时一轮扫光时长 1.7s（对应 message-bubble.css 的 fallback） */
export const BUBBLE_SHIMMER_BASE_MS = 1700;
export const BUBBLE_SHIMMER_SPEED_MIN = 0.5;
export const BUBBLE_SHIMMER_SPEED_MAX = 2;
export const BUBBLE_SHIMMER_FADE_MIN = 100;
export const BUBBLE_SHIMMER_FADE_MAX = 2000;

export const DEFAULT_BUBBLE_SETTINGS: Readonly<BubbleSettings> = Object.freeze({
  typewriter: true,
  shimmer: true,
  shimmerSpeed: 1,
  shimmerFadeMs: 600,
  thinkExpanded: false,
});

function storage(): Storage | null {
  try {
    if (typeof window === 'undefined') return null;
    return window.localStorage;
  } catch {
    return null;
  }
}

function readBoolean(key: string, fallback: boolean): boolean {
  const raw = storage()?.getItem(key);
  if (raw === null || raw === undefined || raw === '') return fallback;
  if (raw === '1' || raw === 'true') return true;
  if (raw === '0' || raw === 'false') return false;
  return fallback;
}

function readNumber(key: string, fallback: number): number {
  const raw = storage()?.getItem(key);
  if (raw === null || raw === undefined || raw === '') return fallback;
  const value = Number(raw);
  return Number.isFinite(value) ? value : fallback;
}

function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value));
}

/** 把外部输入（localStorage / 旧值 / 手工调试）收敛到合法区间，避免 0 除数或负时长 */
export function normalizeBubbleSettings(input: Partial<BubbleSettings>): BubbleSettings {
  return {
    typewriter: input.typewriter !== false,
    shimmer: input.shimmer !== false,
    shimmerSpeed: clamp(
      Number.isFinite(input.shimmerSpeed) ? (input.shimmerSpeed as number) : DEFAULT_BUBBLE_SETTINGS.shimmerSpeed,
      BUBBLE_SHIMMER_SPEED_MIN,
      BUBBLE_SHIMMER_SPEED_MAX,
    ),
    shimmerFadeMs: Math.round(
      clamp(
        Number.isFinite(input.shimmerFadeMs) ? (input.shimmerFadeMs as number) : DEFAULT_BUBBLE_SETTINGS.shimmerFadeMs,
        BUBBLE_SHIMMER_FADE_MIN,
        BUBBLE_SHIMMER_FADE_MAX,
      ),
    ),
    thinkExpanded: input.thinkExpanded === true,
  };
}

export function loadBubbleSettings(): BubbleSettings {
  return normalizeBubbleSettings({
    typewriter: readBoolean(STORAGE_KEYS.BUBBLE_TYPEWRITER, DEFAULT_BUBBLE_SETTINGS.typewriter),
    shimmer: readBoolean(STORAGE_KEYS.BUBBLE_SHIMMER, DEFAULT_BUBBLE_SETTINGS.shimmer),
    shimmerSpeed: readNumber(STORAGE_KEYS.BUBBLE_SHIMMER_SPEED, DEFAULT_BUBBLE_SETTINGS.shimmerSpeed),
    shimmerFadeMs: readNumber(STORAGE_KEYS.BUBBLE_SHIMMER_FADE_MS, DEFAULT_BUBBLE_SETTINGS.shimmerFadeMs),
    thinkExpanded: readBoolean(STORAGE_KEYS.BUBBLE_THINK_EXPANDED, DEFAULT_BUBBLE_SETTINGS.thinkExpanded),
  });
}

function persistBubbleSettings(settings: BubbleSettings): void {
  const store = storage();
  if (!store) return;
  try {
    store.setItem(STORAGE_KEYS.BUBBLE_TYPEWRITER, settings.typewriter ? '1' : '0');
    store.setItem(STORAGE_KEYS.BUBBLE_SHIMMER, settings.shimmer ? '1' : '0');
    store.setItem(STORAGE_KEYS.BUBBLE_SHIMMER_SPEED, String(settings.shimmerSpeed));
    store.setItem(STORAGE_KEYS.BUBBLE_SHIMMER_FADE_MS, String(settings.shimmerFadeMs));
    store.setItem(STORAGE_KEYS.BUBBLE_THINK_EXPANDED, settings.thinkExpanded ? '1' : '0');
  } catch {
    // 隐私模式 / 配额满时静默降级：本次会话仍按内存值生效，不能因为存不了就打断页面
  }
}

/**
 * 把参数注入 CSS 根变量。
 * - `--kw-shimmer-duration`：一轮扫光时长（1.7s / speed），被 .kw-shimmer__band 消费；
 * - `--kw-shimmer-fade-ms`：done 后淡出时长，被 .kw-shimmer.is-fading 消费。
 * 这样 CSS 不再写死 1.7s，配置页改速度刷新后仍然生效。
 */
export function applyBubbleSettings(settings: BubbleSettings, root?: HTMLElement | null): void {
  if (typeof document === 'undefined' && !root) return;
  const el = root ?? document.documentElement;
  if (!el) return;
  const durationMs = Math.round(BUBBLE_SHIMMER_BASE_MS / settings.shimmerSpeed);
  el.style.setProperty('--kw-shimmer-duration', `${durationMs}ms`);
  el.style.setProperty('--kw-shimmer-fade-ms', `${settings.shimmerFadeMs}ms`);
  // 供 CSS/测试按属性判定，不必解析 style 字符串
  el.dataset.bubbleShimmer = settings.shimmer ? 'on' : 'off';
  el.dataset.bubbleTypewriter = settings.typewriter ? 'on' : 'off';
}

/** 模块级单例：配置页和所有 MessageBubble 共享同一份值 */
const settings = reactive<BubbleSettings>(loadBubbleSettings());
applyBubbleSettings(settings);

let persistTimer: ReturnType<typeof setTimeout> | null = null;
watch(
  settings,
  () => {
    applyBubbleSettings(settings);
    if (persistTimer) clearTimeout(persistTimer);
    // 滑块拖动会高频触发，120ms 合并写，避免 localStorage 同步写阻塞滚动
    persistTimer = setTimeout(() => {
      persistBubbleSettings(settings);
      persistTimer = null;
    }, 120);
  },
  { deep: true },
);

/** 同源其他标签页修改后同步到当前页（storage 事件不触发当前页自己的写入） */
if (typeof window !== 'undefined') {
  window.addEventListener('storage', (event) => {
    if (
      event.key === STORAGE_KEYS.BUBBLE_TYPEWRITER ||
      event.key === STORAGE_KEYS.BUBBLE_SHIMMER ||
      event.key === STORAGE_KEYS.BUBBLE_SHIMMER_SPEED ||
      event.key === STORAGE_KEYS.BUBBLE_SHIMMER_FADE_MS ||
      event.key === STORAGE_KEYS.BUBBLE_THINK_EXPANDED
    ) {
      Object.assign(settings, loadBubbleSettings());
    }
  });
}

export function useBubbleSettings(): {
  settings: BubbleSettings;
  resetBubbleSettings: () => void;
} {
  return {
    settings,
    resetBubbleSettings: () => {
      Object.assign(settings, DEFAULT_BUBBLE_SETTINGS);
      applyBubbleSettings(settings);
    },
  };
}
