<script setup lang="ts">
// 回答气泡：Markdown 流式渲染 + 打字机 + 流光扫描 + done 平滑淡出。
//
// 这里是 T05740「流光不能瞬间消失」的落点：
//   1. 状态层：shimmerPhase 由 block.phase 驱动 running → fading → off；
//   2. 动画层：fading 期间覆盖层 opacity 走 600ms 过渡，同时 animation-play-state: paused；
//   3. 卸载层：600ms 后才把节点移出 DOM（v-if），保证淡出真正被看见。
// 三层缺一不可：只改 class 不移除 → 残留透明层吃事件；只移除不淡出 → 闪断。
import { computed, onBeforeUnmount, ref, watch } from 'vue';
import MarkdownRenderer from '../MarkdownRenderer.vue';
import { useTypewriter } from '../../composables/useTypewriter';
import type { AnswerBlockVM } from '../../types/chatBubble';

const props = withDefaults(
  defineProps<{
    block: AnswerBlockVM;
    /** 是否启用打字机；关闭时逐字直接全量展示（流光仍生效） */
    typewriter?: boolean;
    /** 是否启用流光（用户可在设置中整体关闭） */
    shimmer?: boolean;
    charsPerSecond?: number;
    /** Markdown 重渲染节流窗口（ms）：打字机 60fps，Markdown 约 10fps */
    renderIntervalMs?: number;
    /** 终态色调：由外层按 turn.outcome 传入，用于左侧状态条 */
    tone?: 'ok' | 'error' | 'interrupted';
  }>(),
  { typewriter: true, shimmer: true, charsPerSecond: 90, renderIntervalMs: 100, tone: 'ok' },
);

/** 与 message-bubble.css 的 --kw-shimmer-fade-ms 保持一致，改一处必须同步另一处 */
const SHIMMER_FADE_MS = 600;

const running = computed(() => props.block.phase === 'running');
const enabled = computed(() => props.typewriter);

const source = computed(() => props.block.text);
const { displayed, isTyping } = useTypewriter(source, {
  enabled,
  running,
  charsPerSecond: props.charsPerSecond,
});

// ---- 流光生命周期：running → fading（600ms）→ off ----
type ShimmerPhase = 'off' | 'running' | 'fading';
const shimmerPhase = ref<ShimmerPhase>('off');
let fadeTimer: ReturnType<typeof setTimeout> | null = null;

function clearFadeTimer(): void {
  if (fadeTimer) {
    clearTimeout(fadeTimer);
    fadeTimer = null;
  }
}

watch(
  () => props.block.phase,
  (phase, prev) => {
    clearFadeTimer();
    if (phase === 'running') {
      // 连续多轮工具后重新进入流式：中断淡出，覆盖层平滑亮回（160ms，见 CSS）
      shimmerPhase.value = 'running';
      return;
    }
    if (phase === 'done') {
      // prev === undefined 表示组件挂载即终态（刷新回看历史）：
      // 历史消息不该补播一次 600ms 淡出，直接 off
      if (!prev) {
        shimmerPhase.value = 'off';
        return;
      }
      shimmerPhase.value = 'fading';
      fadeTimer = setTimeout(() => {
        shimmerPhase.value = 'off';
        fadeTimer = null;
      }, SHIMMER_FADE_MS);
      return;
    }
    shimmerPhase.value = 'off';
  },
  { immediate: true },
);

const shimmerVisible = computed(() => props.shimmer && shimmerPhase.value !== 'off');

// ---- Markdown 重渲染节流：打字机每帧改 displayed，但 markdown-it 全量渲染很贵 ----
const renderText = ref('');
let renderTimer: ReturnType<typeof setTimeout> | null = null;
let lastRenderAt = 0;

watch(
  displayed,
  (value) => {
    const now = Date.now();
    if (!isTyping.value || now - lastRenderAt >= props.renderIntervalMs) {
      renderText.value = value;
      lastRenderAt = now;
      return;
    }
    // 尾随节流：最后一次更新必须落地，避免 done 时少一段
    if (!renderTimer) {
      const wait = Math.max(16, props.renderIntervalMs - (now - lastRenderAt));
      renderTimer = setTimeout(() => {
        renderText.value = displayed.value;
        lastRenderAt = Date.now();
        renderTimer = null;
      }, wait);
    }
  },
  { immediate: true },
);

onBeforeUnmount(() => {
  clearFadeTimer();
  if (renderTimer) {
    clearTimeout(renderTimer);
    renderTimer = null;
  }
});
</script>

<template>
  <div
    class="kw-answer"
    :class="{
      'is-running': running,
      'is-typing': isTyping,
      'is-error': !running && tone === 'error',
      'is-interrupted': !running && tone === 'interrupted',
    }"
  >
    <MarkdownRenderer :content="renderText" />

    <div
      v-if="shimmerVisible"
      class="kw-shimmer"
      :class="{ 'is-running': shimmerPhase === 'running', 'is-fading': shimmerPhase === 'fading' }"
      aria-hidden="true"
    >
      <span class="kw-shimmer__band"></span>
      <span class="kw-shimmer__edge"></span>
    </div>

    <span class="kw-sr-only" role="status">{{ running ? '正在生成回答' : '' }}</span>
  </div>
</template>
