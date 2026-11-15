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
import { useBubbleSettings } from '../../composables/useBubbleSettings';
import '../../styles/message-bubble.css';

const props = withDefaults(
  defineProps<{
    turn: ChatTurnVM;
    /** done 后流光淡出时长（ms）；不传时读全局气泡配置 */
    shimmerFadeMs?: number;
    charsPerSecond?: number;
    /** 用户消息是否显示头像（移动端紧凑布局可关闭） */
    showAvatar?: boolean;
    /**
     * T05745 P3：当前气泡是否处于可见活动态。
     * 并行会话里切走的会话、切后台的标签页、滚出视口的容器传 false，
     * 流光停止扫描（CSS animation-play-state: paused），回到可见后恢复。
     */
    active?: boolean;
  }>(),
  {
    charsPerSecond: 90,
    showAvatar: true,
    active: true,
  },
);

const { settings: bubbleSettings } = useBubbleSettings();

// T05746：外观参数统一来自配置页的全局单例。
// 注意：这里刻意不把 typewriter / shimmer / thinkExpanded 做成组件 prop——
// Vue 对未传的 Boolean prop 会隐式转成 false，`props.x ?? settings.x` 永远回落不到
// 全局配置（T05746 UI 单测首跑即因此失败）。若后续确实需要单点覆盖，应传对象型
// `appearance` 而不是裸布尔，避免再次踩 Boolean casting。
const effectiveThinkExpanded = computed(() => bubbleSettings.thinkExpanded);
const effectiveTypewriter = computed(() => bubbleSettings.typewriter);
const effectiveShimmer = computed(() => bubbleSettings.shimmer);
const effectiveShimmerFadeMs = computed(() => props.shimmerFadeMs ?? bubbleSettings.shimmerFadeMs);

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
  <div class="kw-msg" :class="{ 'is-paused': !active }">
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
            :default-expanded="effectiveThinkExpanded"
          />
          <ToolCallBlock v-else-if="block.kind === 'tool'" :call="block.call" />
          <AnswerBlock
            v-else
            :block="block"
            :typewriter="effectiveTypewriter"
            :shimmer="effectiveShimmer && active"
            :shimmer-fade-ms="effectiveShimmerFadeMs"
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
