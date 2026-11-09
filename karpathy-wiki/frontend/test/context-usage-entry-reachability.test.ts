// T04453：「压缩上下文」入口可达性（键盘 / 触屏 / 移动端）
// ------------------------------------------------------------------
// 母单 T04177 把徽章从气泡右下角搬到发送按钮左侧，但入口本身仍是
// 「hover 触发的 el-tooltip + 不可聚焦的 div」：
//   · 键盘用户 Tab 到不了徽章（div 默认不可聚焦），浮层里的压缩按钮永远摸不到；
//   · 触屏设备没有 hover，浮层根本弹不出来 → 移动端等于没有这个功能；
//   · 移动端问答页连占用指示都没挂载（contextInputTokens/contextMaxTokens 零消费）。
// happy-dom 量不出「hover 是否能触发」，但导致不可达的**机制**是可断言的，本用例锁：
//   1) 徽章本体是原生 <button>（默认可聚焦）且带 aria-label/aria-haspopup/aria-expanded；
//   2) 明细浮层是 el-popover 且 trigger='click'（点按即开，不依赖 hover），
//      并且组件里不再有 el-tooltip 这条 hover-only 通道；
//   3) 真点一次徽章 → 浮层里的「压缩上下文」真的能点到，并命中 compact 接口；
//   4) 移动端发送行挂载徽章，且按「当前会话 id」取数（不是扁平 computed）；
//   5) 数据面前提成立：done 事件的 governor 统计确实落在按会话缓冲里。
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { mount } from '@vue/test-utils';
import { createPinia, setActivePinia } from 'pinia';
import ElementPlus, { ElPopover } from 'element-plus';
import ContextUsageBadge from '../src/components/ContextUsageBadge.vue';

const apiFetchMock = vi.fn();
vi.mock('../src/utils/apiBase', () => ({
  API_BASE: '/wiki/api',
  apiFetch: (...args: unknown[]) => apiFetchMock(...args),
}));
vi.mock('element-plus', async (importOriginal) => {
  const actual = (await importOriginal()) as Record<string, unknown>;
  return {
    ...actual,
    ElMessage: { success: vi.fn(), error: vi.fn(), warning: vi.fn(), info: vi.fn() },
  };
});

const ROOT = join(__dirname, '..');
const badgeSrc = readFileSync(join(ROOT, 'src/components/ContextUsageBadge.vue'), 'utf8');
const mobileSrc = readFileSync(join(ROOT, 'src/components/mobile/MobileQuery.vue'), 'utf8');

/** 挂载徽章（attachTo body：el-popover 的浮层 teleport 到 body，不挂文档就取不到） */
function mountBadge(props: { threadId: string | null; inputTokens: number; maxTokens: number }) {
  return mount(ContextUsageBadge, {
    props,
    attachTo: document.body,
    global: { plugins: [ElementPlus] },
  });
}

beforeEach(() => {
  apiFetchMock.mockReset();
  document.body.replaceChildren();
});

describe('T04453 桌面：徽章本体可聚焦，浮层由点按触发', () => {
  it('徽章本体是原生 button（不是不可聚焦的 div），带无障碍标签', () => {
    const wrapper = mountBadge({ threadId: 'th-1', inputTokens: 1200, maxTokens: 4000 });
    const btn = wrapper.find('button.ctx-badge-inner');
    expect(btn.exists(), '徽章本体必须是 <button>，否则键盘 Tab 到不了').toBe(true);
    expect(btn.attributes('type'), '按钮必须显式 type=button，否则会提交所在表单').toBe('button');
    expect(btn.attributes('aria-label'), '读屏需要知道这颗按钮是干什么的').toContain('上下文占用');
    expect(btn.attributes('aria-label')).toContain('压缩');
    expect(btn.attributes('tabindex'), '不得再用 tabindex 把徽章踢出 Tab 序列').not.toBe('-1');
    // div 版本回归防线：旧实现的 .ctx-badge-inner 是 div，整块模板里不应再存在该 div
    expect(badgeSrc).not.toMatch(/<div\s+class="ctx-badge-inner"/);
  });

  it('浮层是 el-popover 且 trigger=click；hover-only 的 el-tooltip 通道已移除', () => {
    const wrapper = mountBadge({ threadId: 'th-1', inputTokens: 1200, maxTokens: 4000 });
    const popover = wrapper.findComponent(ElPopover);
    expect(popover.exists(), '明细浮层必须是 el-popover（el-tooltip 内容不能放交互控件）').toBe(true);
    expect(popover.props('trigger'), '触屏没有 hover，触发方式只能是点按').toBe('click');
    expect(badgeSrc, 'el-tooltip 仍是 hover-only，留着就等于入口又回到摸不到').not.toContain('<el-tooltip');
  });

  it('点按徽章 → 浮层弹出 → 「压缩上下文」可点击并命中 compact 接口', async () => {
    apiFetchMock.mockResolvedValue({ ok: true, json: async () => ({ ok: true }) });
    const wrapper = mountBadge({ threadId: 'th-1', inputTokens: 1200, maxTokens: 4000 });
    const btn = wrapper.find('button.ctx-badge-inner');
    expect(btn.attributes('aria-label')).toContain('点击查看明细');

    await btn.trigger('click');
    await new Promise((r) => setTimeout(r, 0));
    const compactBtn = document.querySelector<HTMLButtonElement>('.ctx-compact-btn');
    expect(compactBtn, '点按后浮层里必须出现压缩按钮（这条入口要对键盘/触屏同样成立）').toBeTruthy();
    // 开合状态要能被播报：EP 克隆掉了 aria-expanded，标签文案随 popOpen 变（见组件脚本注释）
    expect(wrapper.find('button.ctx-badge-inner').attributes('aria-label')).toContain('浮层已展开');

    compactBtn!.click();
    await new Promise((r) => setTimeout(r, 0));
    expect(apiFetchMock).toHaveBeenCalledTimes(1);
    const [url, init] = apiFetchMock.mock.calls[0];
    expect(String(url)).toBe('/wiki/api/threads/th-1/compact');
    expect((init as RequestInit).method).toBe('POST');
    wrapper.unmount();
  });

  it('焦点可见时有描边反馈（键盘用户要看得见自己停在徽章上）', () => {
    const styleBlock = badgeSrc.slice(badgeSrc.indexOf('<style scoped>'));
    expect(styleBlock).toMatch(/\.ctx-badge-inner:focus-visible/);
  });
});

describe('T04453 移动端：发送行挂载占用指示与压缩入口', () => {
  /** 取 .mq-inputbar 容器整段（从开标签到该 div 结束前），用于判断挂载点归属 */
  function inputBarBlock(): string {
    const start = mobileSrc.indexOf('<div class="mq-inputbar">');
    expect(start, 'MobileQuery.vue 里找不到发送行 .mq-inputbar').toBeGreaterThanOrEqual(0);
    const end = mobileSrc.indexOf('</div>', mobileSrc.indexOf('class="mq-send"', start));
    expect(end, '发送行没有结束边界').toBeGreaterThan(start);
    return mobileSrc.slice(start, end);
  }

  it('复用桌面同一组件渲染徽章（不另写一份，避免两端口径漂移）', () => {
    expect(mobileSrc).toMatch(/import ContextUsageBadge from '\.\.\/ContextUsageBadge\.vue'/);
    expect(inputBarBlock()).toMatch(/<ContextUsageBadge\b/);
  });

  it('按「当前会话 id」取数：读 getSessionBuffer(activeId) 的按会话字段，而不是扁平 computed', () => {
    // 移动端支持多会话并行流式，后台会话的 done 只写它自己的缓冲；
    // 读 store.contextInputTokens（active 缓冲的快照）会在切会话时拿到上一个会话的数字。
    const getter = /const contextUsage = computed\(\(\) => \{([\s\S]*?)\n\}\);/.exec(mobileSrc);
    expect(getter, 'MobileQuery 缺少 contextUsage 取数逻辑').toBeTruthy();
    const body = getter![1];
    expect(body).toMatch(/store\.getSessionBuffer\(store\.activeId\)/);
    expect(body).toMatch(/buf\?\.contextInputTokens/);
    expect(body).toMatch(/buf\?\.contextMaxTokens/);
    expect(body).toMatch(/buf\?\.currentThreadId/);
    expect(body).not.toMatch(/store\.contextInputTokens/);
  });

  it('徽章 props 全部来自 contextUsage（threadId 随会话切换，压缩才不会打到别的线程）', () => {
    const block = inputBarBlock();
    expect(block).toMatch(/:thread-id="contextUsage\.threadId"/);
    expect(block).toMatch(/:input-tokens="contextUsage\.inputTokens"/);
    expect(block).toMatch(/:max-tokens="contextUsage\.maxTokens"/);
  });

  it('触屏排布收口：容器与发送控件同高、输入框允许收缩（否则 375px 屏整行溢出）', () => {
    const rule = /:deep\(\.context-usage-badge\) \{([^}]*)\}/.exec(mobileSrc);
    expect(rule, '找不到 :deep(.context-usage-badge) 规则').toBeTruthy();
    expect(rule![1]).toMatch(/height:\s*44px/);
    expect(rule![1]).toMatch(/align-self:\s*flex-end/);
    const inputRule = /\.mq-input \{([\s\S]*?)\n\}/.exec(mobileSrc);
    expect(inputRule, '找不到 .mq-input 规则').toBeTruthy();
    expect(inputRule![1]).toMatch(/min-width:\s*0/);
  });
});

// T04542 裁决 B：徽章点按目标抬到 44×44（WCAG 2.5.5 AAA），发送行高度同步。
// happy-dom 不做布局，量不出真实盒子；这里锁「导致尺寸不足的机制」——下限必须落在
// button 自身（不是宿主拉伸）、本行控件必须同高、行高必须钉住（徽章是 v-if，会跳高）。
// 真实几何由 375px 触屏实测取证，见本单回传的验证节。
describe('T04542 裁决 B：44×44 点按目标 + 发送行同高', () => {
  const querySrc = readFileSync(join(ROOT, 'src/views/Query.vue'), 'utf8');

  // 声明级匹配：`height:` 是 `min-height:` 的子串，裸 /height:\s*30px/ 会被 min-height 满足，
  // 于是把真正的 height 放大也照样绿（本单变异探针 P6 实测捕获过这个假绿）。
  // 故要求属性名前面是块首或分号，锁定的是独立声明而非某个后缀。
  const decl = (prop: string, value: string) => new RegExp(`(?:^|;)\\s*${prop}:\\s*${value}`);

  it('徽章本体自带 44×44 下限且内容居中（不依赖宿主 align-items 拉伸）', () => {
    const rule = /\.ctx-badge-inner \{([^}]*)\}/.exec(badgeSrc);
    expect(rule, '找不到 .ctx-badge-inner 规则').toBeTruthy();
    expect(rule![1], '宽度下限必须在 button 自身，换宿主才不会掉回 51.5×26').toMatch(decl('min-width', '44px'));
    expect(rule![1], '高度下限必须在 button 自身；父级 height 只抬容器不拉伸子项').toMatch(decl('min-height', '44px'));
    expect(rule![1], '抬高后圆环与百分比要在盒内居中，否则贴顶').toMatch(/align-items:\s*center/);
    expect(rule![1]).toMatch(/justify-content:\s*center/);
  });

  it('移动端发送行控件全部同步 44px（含麦克风宽度，不留 38×44 的半达标）', () => {
    const micModel = /\.mq-mic,\s*\.mq-model \{([^}]*)\}/.exec(mobileSrc);
    expect(micModel, '找不到 .mq-mic,.mq-model 规则').toBeTruthy();
    expect(micModel![1]).toMatch(decl('height', '44px'));
    expect(mobileSrc, '麦克风是方形图标钮，只抬高度会留下 38×44').toMatch(/\.mq-mic \{ width: 44px; \}/);
    const send = /\.mq-send \{([^}]*)\}/.exec(mobileSrc);
    expect(send, '找不到 .mq-send 规则').toBeTruthy();
    expect(send![1]).toMatch(decl('height', '44px'));
    const input = /\.mq-input \{([^}]*)\}/.exec(mobileSrc);
    expect(input, '找不到 .mq-input 规则').toBeTruthy();
    expect(input![1]).toMatch(decl('min-height', '44px'));
  });

  it('发送行不再残留 38px 高度假设（改回旧值即红）', () => {
    const start = mobileSrc.indexOf('/* 输入栏 */');
    const end = mobileSrc.indexOf('/* ===== 底部弹窗');
    expect(start, '找不到输入栏样式段起点').toBeGreaterThanOrEqual(0);
    expect(end, '找不到输入栏样式段终点').toBeGreaterThan(start);
    expect(mobileSrc.slice(start, end), '发送行高度口径已统一到 44px').not.toMatch(/38px/);
  });

  it('桌面按钮行钉住 44px 行高（徽章 v-if 出现/消失时输入区不跳高）', () => {
    const bar = /\.button-bar \{([^}]*)\}/.exec(querySrc);
    expect(bar, '找不到 .button-bar 规则').toBeTruthy();
    expect(bar![1]).toMatch(decl('min-height', '44px'));
    expect(bar![1]).toMatch(/align-items:\s*center/);
  });

  it('桌面主 CTA 保持 v3.1 的 30px（裁决只抬徽章与行高，不顺手改发送按钮视觉）', () => {
    const send = /\.send-btn,\s*\.stop-btn \{([^}]*)\}/.exec(querySrc);
    expect(send, '找不到 .send-btn,.stop-btn 规则').toBeTruthy();
    expect(send![1]).toMatch(decl('height', '30px'));
  });
});

describe('T04453 数据面前提：占用统计按会话落在各自缓冲', () => {
  beforeEach(() => {
    setActivePinia(createPinia());
  });

  it('后台会话的 done 写入自己的缓冲，不污染当前会话（移动端按 convId 取数才有意义）', async () => {
    const { useQueryStore } = await import('../src/stores/query');
    const store = useQueryStore();
    store.swapSession('conv-b');

    // 模拟 conv-a 在后台完成一轮问答：writer 按 conversationId 路由到 conv-a 缓冲
    store.getSessionWriter('conv-a').setContextUsage({ inputTokens: 1200 }, 4000);

    expect(store.getSessionBuffer('conv-a')?.contextInputTokens).toBe(1200);
    expect(store.getSessionBuffer('conv-a')?.contextMaxTokens).toBe(4000);
    expect(store.getSessionBuffer('conv-b')?.contextInputTokens).toBe(0);
    expect(store.getSessionBuffer('conv-b')?.contextMaxTokens).toBe(0);
    // 桌面扁平 computed 只反映 active 缓冲——这正是移动端必须按 convId 取数的原因
    expect(store.contextInputTokens).toBe(0);

    store.swapSession('conv-a');
    expect(store.contextInputTokens).toBe(1200);
  });
});
