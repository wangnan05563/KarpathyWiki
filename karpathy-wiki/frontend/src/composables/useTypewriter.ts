// 打字机：把「网络分片到达节奏」与「屏幕逐字呈现节奏」解耦。
//
// 为什么不用纯 CSS：
//   - width 动画只适合单行短文本，中文换行/自动折行会错位；
//   - clip-path 需要固定宽度，长回答（含代码块/表格）无法预知尺寸。
// 因此用 rAF 驱动字符指针，Markdown 渲染由 AnswerBlock 再做一层节流（见该组件）。
//
// 关键取舍：
//   - 追帧：积压超过 catchUpThreshold 时按 8 倍速追赶，避免长回答越拖越久；
//   - 收尾：running 变 false 后不再匀速，而是在 finishWindowMs 内收敛到全文，
//     这样 done 事件不会导致「瞬间全量弹出」的突兀感，也不会无限拖尾；
//   - 无动画偏好：prefers-reduced-motion 直接展示全文，不做逐字。

import { onBeforeUnmount, ref, watch, type Ref } from 'vue';

export interface TypewriterOptions {
  /** 开关（如用户配置关闭打字机）；缺省 true */
  enabled?: Ref<boolean>;
  /** 是否仍在流式（false 时进入快速收尾）；缺省视为一直 running */
  running?: Ref<boolean>;
  /** 基准速度（字/秒），默认 90 */
  charsPerSecond?: number;
  /** 积压阈值（字），超过后进入追赶速度，默认 180 */
  catchUpThreshold?: number;
  /** 收尾窗口（ms），默认 600 */
  finishWindowMs?: number;
}

export interface TypewriterHandle {
  displayed: Ref<string>;
  isTyping: Ref<boolean>;
  skip: () => void;
}

function prefersReducedMotion(): boolean {
  return (
    typeof window !== 'undefined' &&
    typeof window.matchMedia === 'function' &&
    window.matchMedia('(prefers-reduced-motion: reduce)').matches
  );
}

export function useTypewriter(source: Ref<string>, options: TypewriterOptions = {}): TypewriterHandle {
  const charsPerSecond = options.charsPerSecond ?? 90;
  const catchUpThreshold = options.catchUpThreshold ?? 180;
  const finishWindowMs = options.finishWindowMs ?? 600;

  const displayed = ref('');
  const isTyping = ref(false);

  // 挂载即已完成的历史消息（刷新回看）直接展示全文，避免「倒带重播」
  const initiallyDone = options.running ? !options.running.value : false;
  if (source.value && initiallyDone) displayed.value = source.value;

  let rafId = 0;
  let lastTs = 0;
  let stopped = true;

  function cancel(): void {
    if (rafId) cancelAnimationFrame(rafId);
    rafId = 0;
    stopped = true;
  }

  function flush(value: string): void {
    cancel();
    displayed.value = value;
    isTyping.value = false;
  }

  function tick(ts: number): void {
    rafId = 0;
    if (stopped) return;
    const target = source.value;
    const remain = target.length - displayed.value.length;
    if (remain <= 0) {
      isTyping.value = false;
      stopped = true;
      return;
    }

    const dt = lastTs > 0 ? Math.min(64, ts - lastTs) : 16;
    lastTs = ts;

    const running = options.running ? options.running.value : true;
    let rate = charsPerSecond;
    if (remain > catchUpThreshold) rate = charsPerSecond * 8;
    if (!running) {
      // 收尾：剩余字数在 finishWindowMs 内走完，保证 done 有「淡出」而不是「瞬移」
      rate = Math.max(rate, remain / Math.max(1, finishWindowMs / 1000));
    }

    const step = Math.max(1, Math.round((rate * dt) / 1000));
    displayed.value = target.slice(0, displayed.value.length + step);
    isTyping.value = displayed.value.length < target.length;

    if (isTyping.value) rafId = requestAnimationFrame(tick);
    else stopped = true;
  }

  function schedule(): void {
    if (stopped) {
      stopped = false;
      lastTs = 0;
      rafId = requestAnimationFrame(tick);
    }
  }

  watch(source, (value) => {
    // 文本被重置（新一轮 / 重新生成）：displayed 清空重来
    if (!value) {
      flush('');
      return;
    }
    if (!displayed.value.startsWith(value)) displayed.value = '';
    // 关闭打字机 / 无动画偏好：直接全文
    if ((options.enabled && !options.enabled.value) || prefersReducedMotion()) {
      flush(value);
      return;
    }
    schedule();
  });

  if (options.enabled) {
    watch(options.enabled, (enabled) => {
      if (!enabled) flush(source.value);
      else if (source.value.length > displayed.value.length) schedule();
    });
  }

  if (options.running) {
    watch(options.running, (running) => {
      if (running) schedule();
    });
  }

  // 组件挂载时已有首片内容（AnswerBlock 只在 answer 块出现后才渲染）：
  // 不补这一枪的话，要等第二个 chunk 才启动打字机，首屏会空白一截。
  if (source.value && !displayed.value && (!options.enabled || options.enabled.value) && !prefersReducedMotion()) {
    schedule();
  }

  onBeforeUnmount(cancel);

  return {
    displayed,
    isTyping,
    skip: () => flush(source.value),
  };
}
