// @vitest-environment happy-dom
// T05745 P3：不可见会话/后台页签的气泡活动开关。
import { defineComponent, nextTick, ref } from 'vue';
import { mount } from '@vue/test-utils';
import { describe, expect, it } from 'vitest';
import { useBubbleActivity } from '../src/composables/useBubbleActivity';

const Host = defineComponent({
  setup() {
    const container = ref<HTMLElement | null>(null);
    const enabled = ref(true);
    const { active } = useBubbleActivity(container, enabled);
    return { active, enabled };
  },
  template: '<div ref="container">{{ active }}</div>',
});

describe('useBubbleActivity', () => {
  it('enabled=false 时 active 立即为 false（列表模式/面板关闭）', async () => {
    const wrapper = mount(Host);
    expect(wrapper.text()).toBe('true');

    (wrapper.vm as unknown as { enabled: boolean }).enabled = false;
    await nextTick();
    expect(wrapper.text()).toBe('false');
  });

  it('页面隐藏时 active=false，恢复可见后 true', async () => {
    const wrapper = mount(Host);
    const original = Object.getOwnPropertyDescriptor(document, 'visibilityState');
    Object.defineProperty(document, 'visibilityState', {
      configurable: true,
      get: () => 'hidden',
    });
    document.dispatchEvent(new Event('visibilitychange'));
    await nextTick();
    expect(wrapper.text()).toBe('false');

    Object.defineProperty(document, 'visibilityState', {
      configurable: true,
      get: () => 'visible',
    });
    document.dispatchEvent(new Event('visibilitychange'));
    await nextTick();
    expect(wrapper.text()).toBe('true');

    if (original) Object.defineProperty(document, 'visibilityState', original);
    wrapper.unmount();
  });
});
