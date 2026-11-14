<script setup lang="ts">
// 工具调用气泡：一行主信息 + 可选详情/错误。
//
// 为什么一次调用单独成块，而不是把所有调用合并成一张卡：
//   Agent 会出现「思考 → 工具 → 思考 → 工具 → 回答」的多轮交错，合并会丢掉时序；
//   每个调用独立成块后，MessageBubble 按 blocks 顺序渲染即可原样还原执行链路。
import { computed } from 'vue';
import type { ToolCallVM } from '../../types/chatBubble';

const props = defineProps<{ call: ToolCallVM }>();

const running = computed(() => props.call.status === 'running');
const failed = computed(() => props.call.status === 'error');

const statusLabel = computed(() => {
  if (running.value) return '调用中';
  return failed.value ? '失败' : '已完成';
});

const durationText = computed(() => {
  const ms = props.call.durationMs;
  if (typeof ms !== 'number') return '';
  return ms < 1000 ? `${Math.round(ms)}ms` : `${(ms / 1000).toFixed(1)}s`;
});

const meta = computed(() => {
  if (running.value) return props.call.progressMessage || statusLabel.value;
  return [statusLabel.value, props.call.summary, durationText.value].filter(Boolean).join(' · ');
});

const detail = computed(() => props.call.argsPreview || '');
</script>

<template>
  <div class="kw-tool" :class="{ 'is-running': running, 'is-error': failed }">
    <div class="kw-tool__row">
      <span class="kw-tool__dot" aria-hidden="true"></span>
      <span class="kw-tool__name">{{ call.name }}</span>
      <span class="kw-tool__title" :title="call.title">{{ call.title }}</span>
      <span class="kw-tool__meta">{{ meta }}</span>
    </div>

    <div v-if="detail" class="kw-tool__detail">{{ detail }}</div>
    <div v-if="failed && call.errorMessage" class="kw-tool__error">{{ call.errorMessage }}</div>

    <span class="kw-sr-only" role="status">
      {{ running ? `正在调用工具 ${call.name}` : `工具 ${call.name} ${statusLabel}` }}
    </span>
  </div>
</template>
