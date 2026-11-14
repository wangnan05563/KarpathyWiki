<script setup lang="ts">
// 消息气泡入口组件：按 turn.blocks 的到达顺序渲染「思考 / 工具 / 回答」。
//
// 为什么入口组件只管编排、不承载状态机：
//   气泡的 phase 只有一个真源（ChatTurnVM，由 useBubbleStream 的 reducer 产出），
//   组件派生出的每个块状态都是只读的；否则「done 后的流光淡出」会出现两套时钟互相打架。
import { computed } from 'vue';
import MarkdownRenderer from '../MarkdownRenderer.vue';
import ThinkBlock from './ThinkBlock.vue';
import ToolCallBlock from './ToolCallBlock.vue';
import AnswerBlock from './AnswerBlock.vue';
import type { ChatTurnVM } from '../../types/chatBubble';
import '../../styles/message-bubble.css';

const props = withDefaults(
  defineProps<{
    turn: ChatTurnVM;
    /** done 后思考块是否默认展开；默认折叠 */
    defaultThinkExpanded?: boolean;
    /** 是否启用打字机 */
    typewriter?: boolean;
    /** 是否启用流光扫描 */
    shimmer?: boolean;
    charsPerSecond?: number;
    /** 用户消息是否显示头像（移动端紧凑布局可关闭） */
    showAvatar?: boolean;
  }>(),
  {
    defaultThinkExpanded: false,
    typewriter: true,
    shimmer: true,
    charsPerSecond: 90,
    showAvatar: true,
  },
);

defineEmits<{ (e: 'retry'): void }>();

const isUser = computed(() => props.turn.role === 'user');
const running = computed(() => props.turn.phase === 'running');

const statusText = computed(() => {
  if (props.turn.phase !== 'done' || props.turn.outcome === 'ok') return '';
  return (
    props.turn.errorMessage ||
    (props.turn.outcome === 'interrupted' ? '已停止生成' : '生成失败，请重试')
  );
});

const statusClass = computed(() => ({
  'is-error': props.turn.outcome === 'error',
  'is-interrupted': props.turn.outcome === 'interrupted',
}));
</script>

<template>
  <div class="kw-msg">
    <!-- 用户气泡：右侧、无流光、无打字机（用户输入不是流式产出） -->
    <div v-if="isUser" class="kw-row kw-row--user">
      <div class="kw-bubble--user">
        <MarkdownRenderer :content="turn.text" />
      </div>
      <div v-if="showAvatar" class="kw-avatar" aria-hidden="true">ME</div>
    </div>

    <!-- AI 回合：思考 → 工具 → 回答按到达顺序堆叠，一个回合内共享同一份流状态 -->
    <div v-else class="kw-row kw-row--assistant">
      <div class="kw-ai-stack" :aria-busy="running">
        <template v-for="block in turn.blocks" :key="block.id">
          <ThinkBlock
            v-if="block.kind === 'think'"
            :block="block"
            :default-expanded="defaultThinkExpanded"
          />
          <ToolCallBlock v-else-if="block.kind === 'tool'" :call="block.call" />
          <AnswerBlock
            v-else
            :block="block"
            :typewriter="typewriter"
            :shimmer="shimmer"
            :chars-per-second="charsPerSecond"
            :tone="turn.outcome"
          />
        </template>

        <!-- turn_start 已到但首个 delta 未到的极短窗口：给一个明确的活动指示，避免空白气泡 -->
        <div v-if="running && turn.blocks.length === 0" class="kw-pending">
          <span class="kw-pending__dot" aria-hidden="true"></span>
          <span>正在连接知识库…</span>
        </div>

        <div v-if="statusText" class="kw-status" :class="statusClass">
          <span>{{ statusText }}</span>
          <button v-if="turn.retryable" type="button" class="kw-retry" @click="$emit('retry')">
            重新生成
          </button>
        </div>
      </div>
    </div>
  </div>
</template>
