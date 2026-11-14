<script setup lang="ts">
// AI 思考气泡：默认折叠，流式期间自动展开（可被用户手动覆盖）。
//
// 为什么折叠态用「标题 + 字数」而不是直接隐藏：
//   豆包把思考过程做成「已深度思考 Xs」的可展开摘要——用户不需要读全文，
//   但需要知道 Agent 确实思考过；running 时标题走文字流光，回答开始后自动收起。
import { computed, nextTick, ref, watch } from 'vue';
import type { ThinkBlockVM } from '../../types/chatBubble';

const props = withDefaults(
  defineProps<{
    block: ThinkBlockVM;
    /** done 后的默认展开态；默认 false（折叠） */
    defaultExpanded?: boolean;
    /** running 时是否强制展开；默认 true */
    autoExpandOnRun?: boolean;
  }>(),
  { defaultExpanded: false, autoExpandOnRun: true },
);

const userTouched = ref(false);
const expanded = ref(props.defaultExpanded);
const bodyRef = ref<HTMLElement | null>(null);

// 用户手动操作过就不再被状态机覆盖：避免「刚收起又被流式事件弹开」的争夺
watch(
  () => props.block.phase,
  (phase) => {
    if (userTouched.value) return;
    expanded.value = phase === 'running' ? props.autoExpandOnRun : props.defaultExpanded;
  },
  { immediate: true },
);

const running = computed(() => props.block.phase === 'running');

const durationText = computed(() => {
  const ms = props.block.durationMs;
  if (typeof ms !== 'number') return '';
  return ms < 1000 ? `${Math.round(ms)}ms` : `${(ms / 1000).toFixed(1)}s`;
});

const title = computed(() => {
  if (running.value) return '深度思考中';
  return durationText.value ? `已深度思考 ${durationText.value}` : '思考过程';
});

const charCount = computed(() => `${props.block.text.length} 字`);
const lines = computed(() => props.block.text.split('\n'));
const bodyId = computed(() => `kw-think-body-${props.block.id.replace(/[^\w-]/g, '-')}`);

function toggle(): void {
  userTouched.value = true;
  expanded.value = !expanded.value;
}

// 流式思考时贴底：用户能看到最新一行，而不是停在开头
watch(
  () => props.block.text,
  async () => {
    if (!running.value) return;
    await nextTick();
    const el = bodyRef.value;
    if (el) el.scrollTop = el.scrollHeight;
  },
);
</script>

<template>
  <div class="kw-think" :class="{ 'is-running': running }">
    <button
      type="button"
      class="kw-think__head"
      :aria-expanded="expanded"
      :aria-controls="bodyId"
      @click="toggle"
    >
      <span class="kw-think__icon" aria-hidden="true"></span>
      <span class="kw-think__title" :class="{ 'kw-text-shimmer': running }">{{ title }}</span>
      <span class="kw-think__meta">{{ charCount }}</span>
      <span class="kw-think__chevron" :class="{ 'is-open': expanded }" aria-hidden="true">›</span>
    </button>

    <div :id="bodyId" class="kw-collapse" :class="{ 'is-open': expanded }">
      <div class="kw-collapse__inner">
        <div ref="bodyRef" class="kw-think__body">
          <p v-for="(line, idx) in lines" :key="idx" class="kw-think__line">{{ line }}</p>
        </div>
      </div>
    </div>

    <span v-if="running" class="kw-think__scan" aria-hidden="true"></span>
    <span class="kw-sr-only" role="status">{{ running ? '正在深度思考' : '思考完成' }}</span>
  </div>
</template>
