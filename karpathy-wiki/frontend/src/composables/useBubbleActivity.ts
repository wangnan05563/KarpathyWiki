// T05745 P3：气泡活动开关。
// 并行会话/后台页签仍可能保留 running turn；只有「当前可见且页面在前台」的会话
// 才需要跑流光与思考扫描动画。这里同时用 IntersectionObserver（容器滚出视口）
// 与 document.visibilityState（切标签页/切后台）两个信号，任一不可见即暂停。
// 注意：本开关只暂停装饰性动画，不停止流式写入/打字机状态机，回到可见后内容不丢。
import { computed, onBeforeUnmount, onMounted, ref, watch, type Ref } from 'vue';

export function useBubbleActivity(
  container: Ref<HTMLElement | null>,
  enabled: Ref<boolean>,
): { active: Ref<boolean> } {
  const docVisible = ref(
    typeof document === 'undefined' ? true : document.visibilityState !== 'hidden',
  );
  // 无 IntersectionObserver（happy-dom/旧浏览器）时按「在视口内」处理，不误伤动画
  const inView = ref(true);
  let observer: IntersectionObserver | null = null;

  function observe(el: HTMLElement | null): void {
    observer?.disconnect();
    observer = null;
    if (!el || typeof IntersectionObserver === 'undefined') {
      inView.value = true;
      return;
    }
    observer = new IntersectionObserver(
      (entries) => {
        const entry = entries[0];
        inView.value = entry ? entry.isIntersecting : true;
      },
      { threshold: 0.01, rootMargin: '80px 0px' },
    );
    observer.observe(el);
  }

  function onVisibilityChange(): void {
    docVisible.value = document.visibilityState !== 'hidden';
  }

  watch(container, (el) => observe(el), { immediate: true });

  onMounted(() => {
    if (typeof document !== 'undefined') {
      document.addEventListener('visibilitychange', onVisibilityChange);
    }
    observe(container.value);
  });

  onBeforeUnmount(() => {
    observer?.disconnect();
    observer = null;
    if (typeof document !== 'undefined') {
      document.removeEventListener('visibilitychange', onVisibilityChange);
    }
  });

  const active = computed(() => enabled.value && docVisible.value && inView.value);
  return { active };
}
