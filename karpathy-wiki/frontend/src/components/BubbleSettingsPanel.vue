<script setup lang="ts">
// T05746：配置页「界面主题」下的消息气泡设置。
// 这里不直接写 localStorage：所有值都走 useBubbleSettings 的模块级单例，
// 拖动滑块时 CSS 变量即时生效，防抖 120ms 后落盘，刷新页面仍然保留。
import { computed } from 'vue';
import {
  useBubbleSettings,
  BUBBLE_SHIMMER_SPEED_MIN,
  BUBBLE_SHIMMER_SPEED_MAX,
  BUBBLE_SHIMMER_FADE_MIN,
  BUBBLE_SHIMMER_FADE_MAX,
} from '../composables/useBubbleSettings';

const { settings, resetBubbleSettings } = useBubbleSettings();

const speedLabel = computed(() => `${settings.shimmerSpeed.toFixed(1)}x`);
const fadeLabel = computed(() => `${Math.round(settings.shimmerFadeMs)}ms`);

function formatSpeed(value: number | number[]): string {
  const n = Array.isArray(value) ? Number(value[0]) : Number(value);
  return `${n.toFixed(1)}x`;
}

function formatFade(value: number | number[]): string {
  const n = Array.isArray(value) ? Number(value[0]) : Number(value);
  return `${Math.round(n)}ms`;
}
</script>

<template>
  <section class="bubble-settings" aria-labelledby="bubble-settings-title">
    <header class="bubble-settings__head">
      <div>
        <h3 id="bubble-settings-title" class="bubble-settings__title">消息气泡</h3>
        <p class="bubble-settings__intro">
          调整回答的呈现节奏；修改即时预览，刷新页面后仍然保留。
        </p>
      </div>
      <button type="button" class="bubble-settings__reset" @click="resetBubbleSettings">
        恢复默认
      </button>
    </header>

    <div class="bubble-settings__rows">
      <div class="setting-row">
        <div class="setting-copy">
          <span class="setting-title">打字机</span>
          <span class="setting-desc">回答逐字出现；关闭后等首段完整返回再一次性展示。</span>
        </div>
        <el-switch v-model="settings.typewriter" aria-label="打字机" />
      </div>

      <div class="setting-row">
        <div class="setting-copy">
          <span class="setting-title">流光扫描</span>
          <span class="setting-desc">生成期间的气泡扫光；关闭后仍有光标与进度骨架。</span>
        </div>
        <el-switch v-model="settings.shimmer" aria-label="流光扫描" />
      </div>

      <div class="setting-row setting-row--stack">
        <div class="setting-copy">
          <span class="setting-title">流光速度</span>
          <span class="setting-desc">一轮扫光的快慢，当前 {{ speedLabel }}。</span>
        </div>
        <el-slider
          v-model="settings.shimmerSpeed"
          class="setting-slider"
          :min="BUBBLE_SHIMMER_SPEED_MIN"
          :max="BUBBLE_SHIMMER_SPEED_MAX"
          :step="0.1"
          :disabled="!settings.shimmer"
          :format-tooltip="formatSpeed"
          aria-label="流光速度"
        />
      </div>

      <div class="setting-row setting-row--stack">
        <div class="setting-copy">
          <span class="setting-title">生成结束后淡出</span>
          <span class="setting-desc">done 后覆盖层淡出的时长，当前 {{ fadeLabel }}。</span>
        </div>
        <el-slider
          v-model="settings.shimmerFadeMs"
          class="setting-slider"
          :min="BUBBLE_SHIMMER_FADE_MIN"
          :max="BUBBLE_SHIMMER_FADE_MAX"
          :step="50"
          :disabled="!settings.shimmer"
          :format-tooltip="formatFade"
          aria-label="生成结束后淡出时长"
        />
      </div>

      <div class="setting-row">
        <div class="setting-copy">
          <span class="setting-title">思考默认展开</span>
          <span class="setting-desc">历史回看时展开思考过程；运行中仍会自动展开。</span>
        </div>
        <el-switch v-model="settings.thinkExpanded" aria-label="思考默认展开" />
      </div>
    </div>
  </section>
</template>

<style scoped>
.bubble-settings {
  margin-top: 18px;
  padding: 18px 20px 20px;
  border: var(--border-glass);
  border-radius: 16px;
  background: var(--bg-glass);
}

.bubble-settings__head {
  display: flex;
  align-items: flex-start;
  justify-content: space-between;
  gap: 16px;
  margin-bottom: 6px;
}

.bubble-settings__title {
  margin: 0;
  font-family: var(--font-display);
  font-size: 15px;
  font-weight: 600;
  color: var(--text-bright);
}

.bubble-settings__intro {
  margin: 6px 0 0;
  font-size: 12px;
  line-height: 1.6;
  color: var(--text-soft);
}

.bubble-settings__reset {
  flex: 0 0 auto;
  padding: 5px 10px;
  border: var(--border-glass);
  border-radius: var(--radius-btn, 8px);
  background: transparent;
  color: var(--text-soft);
  font-size: 12px;
  cursor: pointer;
}

.bubble-settings__reset:hover,
.bubble-settings__reset:focus-visible {
  color: var(--text-bright);
  border-color: var(--border-neon);
}

.bubble-settings__rows {
  display: flex;
  flex-direction: column;
}

.setting-row {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 18px;
  padding: 12px 0;
  border-top: 1px solid var(--border-glass);
}

.setting-row--stack {
  align-items: flex-start;
}

.setting-copy {
  display: flex;
  min-width: 0;
  flex-direction: column;
  gap: 3px;
}

.setting-title {
  font-size: 13px;
  color: var(--text-base);
}

.setting-desc {
  font-size: 12px;
  line-height: 1.55;
  color: var(--text-dim);
}

.setting-slider {
  width: min(280px, 45vw);
  flex: 0 0 auto;
}

@media (max-width: 768px) {
  .bubble-settings {
    padding: 16px;
  }

  .setting-row {
    flex-direction: column;
    align-items: stretch;
    gap: 10px;
  }

  .setting-slider {
    width: 100%;
  }
}
</style>
