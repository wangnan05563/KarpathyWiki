// @vitest-environment happy-dom
// T05746：气泡外观配置的归一化、CSS 变量注入，以及 MessageBubble 对全局设置的真实响应。
import { mount } from '@vue/test-utils';
import { nextTick, reactive } from 'vue';
import { afterEach, describe, expect, it, vi } from 'vitest';
import MessageBubble from '../src/components/message/MessageBubble.vue';
import AnswerBlock from '../src/components/message/AnswerBlock.vue';
import {
  applyBubbleSettings,
  DEFAULT_BUBBLE_SETTINGS,
  loadBubbleSettings,
  normalizeBubbleSettings,
  useBubbleSettings,
} from '../src/composables/useBubbleSettings';
import { STORAGE_KEYS } from '../src/constants/storageKeys';
import type { ChatTurnVM } from '../src/types/chatBubble';

const MarkdownRendererStub = {
  props: ['content'],
  template: '<div class="md-stub">{{ content }}</div>',
};

const { settings, resetBubbleSettings } = useBubbleSettings();

function makeTurn(): ChatTurnVM {
  return {
    id: 't-config',
    role: 'assistant',
    phase: 'running',
    outcome: 'ok',
    text: '答案',
    createdAt: 0,
    updatedAt: 0,
    blocks: [{ kind: 'answer', id: 'a-config', text: '答案', phase: 'running' }],
  };
}

afterEach(() => {
  vi.useRealTimers();
  resetBubbleSettings();
  localStorage.clear();
});

describe('T05746 气泡外观配置', () => {
  it('把速度/淡出收敛到合法区间，并按基础 1.7s 注入 CSS 变量', () => {
    const normalized = normalizeBubbleSettings({
      shimmerSpeed: 0.01,
      shimmerFadeMs: 99999,
      typewriter: false,
      shimmer: false,
      thinkExpanded: true,
    });
    expect(normalized.shimmerSpeed).toBe(0.5);
    expect(normalized.shimmerFadeMs).toBe(2000);
    expect(normalized.typewriter).toBe(false);
    expect(normalized.shimmer).toBe(false);
    expect(normalized.thinkExpanded).toBe(true);

    applyBubbleSettings({ ...DEFAULT_BUBBLE_SETTINGS, shimmerSpeed: 2, shimmerFadeMs: 900 });
    expect(document.documentElement.style.getPropertyValue('--kw-shimmer-duration')).toBe('850ms');
    expect(document.documentElement.style.getPropertyValue('--kw-shimmer-fade-ms')).toBe('900ms');
  });

  it('从 localStorage 读取关闭态，刷新后仍然生效', () => {
    localStorage.setItem(STORAGE_KEYS.BUBBLE_SHIMMER, '0');
    localStorage.setItem(STORAGE_KEYS.BUBBLE_TYPEWRITER, '0');
    localStorage.setItem(STORAGE_KEYS.BUBBLE_THINK_EXPANDED, '1');

    const loaded = loadBubbleSettings();
    expect(loaded.shimmer).toBe(false);
    expect(loaded.typewriter).toBe(false);
    expect(loaded.thinkExpanded).toBe(true);
  });

  it('MessageBubble 直接消费全局设置：关闭流光后无覆盖层，但保留活动光标', async () => {
    vi.useFakeTimers();
    resetBubbleSettings();
    const wrapper = mount(MessageBubble, {
      props: { turn: reactive(makeTurn()), charsPerSecond: 9999 },
      global: { stubs: { MarkdownRenderer: MarkdownRendererStub } },
    });

    const answer = wrapper.findComponent(AnswerBlock);
    expect(answer.props('typewriter')).toBe(true);
    expect(wrapper.find('.kw-shimmer').exists()).toBe(true);

    settings.typewriter = false;
    await nextTick();
    expect(answer.props('typewriter')).toBe(false);

    settings.shimmer = false;
    await nextTick();
    expect(wrapper.find('.kw-shimmer').exists()).toBe(false);
    expect(wrapper.find('.kw-caret--fallback').exists()).toBe(true);
    wrapper.unmount();
  });

  it('自定义淡出时长驱动组件定时器，而不是继续写死 600ms', async () => {
    vi.useFakeTimers();
    resetBubbleSettings();
    settings.shimmerFadeMs = 900;
    await nextTick();

    const turn = reactive<ChatTurnVM>(makeTurn());
    const wrapper = mount(MessageBubble, {
      props: { turn, charsPerSecond: 9999 },
      global: { stubs: { MarkdownRenderer: MarkdownRendererStub } },
    });
    const shimmer = wrapper.find('.kw-shimmer').element as HTMLElement;
    expect(shimmer.style.getPropertyValue('--kw-shimmer-fade-ms')).toBe('900ms');

    const block = turn.blocks[0];
    if (!block || block.kind !== 'answer') throw new Error('缺少 answer 块');
    block.phase = 'done';
    turn.phase = 'done';
    await nextTick();
    expect(wrapper.find('.kw-shimmer').classes()).toContain('is-fading');

    vi.advanceTimersByTime(899);
    await nextTick();
    expect(wrapper.find('.kw-shimmer').exists()).toBe(true);

    vi.advanceTimersByTime(1);
    await nextTick();
    expect(wrapper.find('.kw-shimmer').exists()).toBe(false);
    wrapper.unmount();
  });
});
