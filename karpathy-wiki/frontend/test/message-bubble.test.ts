// @vitest-environment happy-dom
// T05743 P1 组件级验收：running 时流光存在，done 后进入 fading，600ms 后才卸载
import { mount } from '@vue/test-utils';
import { nextTick, reactive } from 'vue';
import { describe, expect, it, vi } from 'vitest';
import MessageBubble from '../src/components/message/MessageBubble.vue';
import type { ChatTurnVM } from '../src/types/chatBubble';

const MarkdownRendererStub = {
  props: ['content'],
  template: '<div class="md-stub">{{ content }}</div>',
};

function makeTurn(): ChatTurnVM {
  return {
    id: 't1',
    role: 'assistant',
    phase: 'running',
    outcome: 'ok',
    text: '答案',
    createdAt: 0,
    updatedAt: 0,
    blocks: [{ kind: 'answer', id: 'a1', text: '答案', phase: 'running' }],
  };
}

describe('MessageBubble 流光生命周期', () => {
  it('done 后先 fading，600ms 才移除 DOM（不是瞬间消失）', async () => {
    vi.useFakeTimers();
    const turn = reactive<ChatTurnVM>(makeTurn());
    const wrapper = mount(MessageBubble, {
      props: { turn, typewriter: false },
      global: { stubs: { MarkdownRenderer: MarkdownRendererStub } },
    });

    expect(wrapper.find('.kw-shimmer').exists()).toBe(true);
    expect(wrapper.find('.kw-shimmer').classes()).toContain('is-running');

    const block = turn.blocks[0];
    if (!block || block.kind !== 'answer') throw new Error('缺少 answer 块');
    block.phase = 'done';
    turn.phase = 'done';
    await nextTick();

    expect(wrapper.find('.kw-shimmer').exists()).toBe(true);
    expect(wrapper.find('.kw-shimmer').classes()).toContain('is-fading');

    vi.advanceTimersByTime(599);
    await nextTick();
    expect(wrapper.find('.kw-shimmer').exists()).toBe(true);

    vi.advanceTimersByTime(1);
    await nextTick();
    expect(wrapper.find('.kw-shimmer').exists()).toBe(false);
    vi.useRealTimers();
  });
});
