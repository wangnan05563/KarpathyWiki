// T04177：上下文占用徽章位置回归锁
// ------------------------------------------------------------------
// 用户主诉：徽章「挡住消息气泡消息内容」，要求「放到页面下方发送按钮左侧」。
// 布局是否真的不再压字，jsdom 量不出来；但导致压字的**机制**是可断言的：
// 旧实现 = 组件自带 `position:absolute` + 挂在 `.msg-bubble` 内（脱离文档流叠在正文上）。
// 因此本用例锁三件事实：
//   1) 组件自身不再声明任何定位（宿主换到哪都不需要改组件）；
//   2) Query.vue 只有 1 个实例，且位于 `.right-buttons` 内、发送按钮之**前**（DOM 顺序=视觉左序）；
//   3) 取数按「当前会话」（store.currentThreadId），不再把最新占用数画到每条历史气泡上；
//      无数据时整块不渲染（否则发送按钮左侧会挂一个空壳）。
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { mount } from '@vue/test-utils';
import ElementPlus from 'element-plus';
import ContextUsageBadge from '../src/components/ContextUsageBadge.vue';

vi.mock('../src/utils/apiBase', () => ({
  API_BASE: '/wiki/api',
  apiFetch: vi.fn(),
}));
vi.mock('element-plus', async (importOriginal) => {
  const actual = (await importOriginal()) as Record<string, unknown>;
  return {
    ...actual,
    ElMessage: { success: vi.fn(), error: vi.fn(), warning: vi.fn(), info: vi.fn() },
  };
});

const ROOT = join(__dirname, '..');
const querySrc = readFileSync(join(ROOT, 'src/views/Query.vue'), 'utf8');

/** 取 `.right-buttons { ... }` 之前那段模板里，按钮行 div 的内容 */
function rightButtonsBlock(): string {
  const start = querySrc.indexOf('<div class="right-buttons">');
  expect(start, 'Query.vue 里找不到 .right-buttons 容器').toBeGreaterThanOrEqual(0);
  const end = querySrc.indexOf('<Transition', start);
  expect(end, '.right-buttons 容器没有结束边界').toBeGreaterThan(start);
  return querySrc.slice(start, end);
}

describe('T04177 徽章不再自带定位', () => {
  const css = readFileSync(join(ROOT, 'src/components/ContextUsageBadge.vue'), 'utf8');

  it('.context-usage-badge 规则块内不得出现 position / z-index / right / bottom', () => {
    const start = css.indexOf('.context-usage-badge {');
    expect(start, '缺少 .context-usage-badge 规则块').toBeGreaterThanOrEqual(0);
    const block = css.slice(start, css.indexOf('\n}', start));
    for (const prop of ['position', 'z-index', 'right', 'bottom', 'top', 'left']) {
      expect(new RegExp(`(^|\\s)${prop}\\s*:`).test(block), `.context-usage-badge 不应再声明 ${prop}（旧实现靠它叠在气泡正文上）`).toBe(false);
    }
    expect(block).toMatch(/display:\s*inline-flex/);
  });
});

describe('T04177 挂载点迁移（单实例 · 发送按钮左侧）', () => {
  it('Query.vue 只渲染 1 个 ContextUsageBadge 实例', () => {
    const hits = [...querySrc.matchAll(/<ContextUsageBadge\b/g)].length;
    expect(hits, '徽章应当是全页单实例；出现多个说明又回到「每条气泡挂一个」').toBe(1);
  });

  it('实例位于 .right-buttons 内且在发送按钮之前', () => {
    const block = rightButtonsBlock();
    const badge = block.indexOf('<ContextUsageBadge');
    const send = block.indexOf('class="send-btn"');
    const stop = block.indexOf('class="stop-btn"');
    expect(badge, '徽章没在按钮行里').toBeGreaterThanOrEqual(0);
    expect(send, '找不到发送按钮').toBeGreaterThan(badge);
    expect(stop, '找不到停止按钮').toBeGreaterThan(badge);
  });

  it('不再挂在消息气泡（.msg-bubble）内部', () => {
    // 气泡容器开标签到按钮行之间的区域就是消息列表；徽章若还留在气泡里，
    // 它的索引会落在 right-buttons 之前
    const badgeIdx = querySrc.indexOf('<ContextUsageBadge');
    const barIdx = querySrc.indexOf('<div class="button-bar">');
    expect(barIdx, '找不到按钮行').toBeGreaterThanOrEqual(0);
    expect(badgeIdx, '徽章必须在按钮行之后（即不再属于消息列表区）').toBeGreaterThan(barIdx);
    const bubbleStart = querySrc.lastIndexOf('class="msg-bubble', badgeIdx);
    expect(bubbleStart).toBeLessThan(barIdx);
  });

  it('按当前会话取数：thread-id 用 store.currentThreadId，不再取 msg.threadId', () => {
    const block = rightButtonsBlock();
    expect(block).toMatch(/:thread-id="store\.currentThreadId"/);
    expect(block).toMatch(/:input-tokens="store\.contextInputTokens"/);
    expect(block).toMatch(/:max-tokens="store\.contextMaxTokens"/);
    expect(block).not.toMatch(/msg\.threadId/);
  });
});

describe('T04177 组件渲染行为', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('maxTokens>0 时渲染徽章并显示百分比', () => {
    const wrapper = mount(ContextUsageBadge, {
      props: { threadId: 'th-1', inputTokens: 1200, maxTokens: 4000 },
      global: { plugins: [ElementPlus] },
    });
    expect(wrapper.find('.context-usage-badge').exists()).toBe(true);
    expect(wrapper.find('.ctx-pct').text()).toBe('30%');
  });

  it('maxTokens=0（还没拿到 governor 统计）时整块不渲染，按钮行不留空壳', () => {
    const wrapper = mount(ContextUsageBadge, {
      props: { threadId: 'th-1', inputTokens: 0, maxTokens: 0 },
      global: { plugins: [ElementPlus] },
    });
    expect(wrapper.find('.context-usage-badge').exists()).toBe(false);
    // Vue 的 v-if 收起后仍会留 <!----> 注释占位符——注释不是元素，不会成为 .right-buttons
    // 的 flex 子项，因此不会挤出一个 gap 空位。这里锁的是「没有任何真实 DOM 节点」，
    // 而不是「html() 字符串为空」（后者会被注释占位符误判）。
    const realNodes = wrapper.html()
      .replace(/<!--[\s\S]*?-->/g, '')
      .replace(/<[^>]+>/g, '')
      .trim();
    expect(wrapper.html().match(/<[a-zA-Z]/)).toBeNull();
    expect(realNodes).toBe('');
  });
});
