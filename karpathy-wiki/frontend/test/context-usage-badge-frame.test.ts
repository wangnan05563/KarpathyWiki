// T05703：「压缩上下文」徽章去外框回归锁
// ------------------------------------------------------------------
// 用户主诉：输入按钮行里的徽章带着一圈过大的可视外框，把整行撑高、挤占垂直空间。
// happy-dom 量不出真实盒子，但「画出外框的机制」是可断言的：旧实现给 44×44 的
// 点按盒叠了 background + 1px 描边 + 投影 + 10px 圆角 + 非对称 padding，于是
// 无障碍要求的透明点按区被画成了一块比 30px 主 CTA 还高的实心卡片。
// 本用例锁两件事：
//   1) 视觉外框归零（透明点按区仍 ≥44×44，内容仍居中）；
//   2) 只改样式——压缩接口 / popover / 键盘可达 / 宿主行高口径一律不动。
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const ROOT = join(__dirname, '..');
const badge = readFileSync(join(ROOT, 'src/components/ContextUsageBadge.vue'), 'utf8');
const query = readFileSync(join(ROOT, 'src/views/Query.vue'), 'utf8');
const mobile = readFileSync(join(ROOT, 'src/components/mobile/MobileQuery.vue'), 'utf8');

/** 取选择器主规则块体（第一个匹配即主规则，不带 :hover / 元素限定后缀） */
function ruleBlock(src: string, selector: string): string {
  const escaped = selector.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const m = new RegExp(`${escaped} \\{([^}]*)\\}`).exec(src);
  expect(m, `找不到规则块 ${selector}`).toBeTruthy();
  return m![1];
}

/** 独立声明匹配：height: 是 min-height: 的子串，必须锚到行首/分号后 */
const decl = (prop: string, value: string) => new RegExp(`(?:^|;)\\s*${prop}:\\s*${value}`);

describe('T05703 徽章常驻外框已移除', () => {
  const inner = ruleBlock(badge, '.ctx-badge-inner');

  it('背景 / 描边 / 投影 / 圆角 / 非对称 padding 五件外框属性全部清掉', () => {
    expect(inner).not.toMatch(/background\s*:\s*var\(--bg-card/);
    expect(inner).not.toMatch(/border\s*:\s*1px/);
    expect(inner).not.toMatch(/box-shadow\s*:\s*0 2px/);
    expect(inner).not.toMatch(/border-radius\s*:\s*10px/);
    expect(inner).not.toMatch(/padding\s*:\s*2px 6px/);
  });

  it('改为透明 / 零值声明，视觉体量只剩圆环与百分比文字', () => {
    expect(inner).toMatch(decl('background', 'transparent'));
    expect(inner).toMatch(decl('border', '0'));
    expect(inner).toMatch(decl('border-radius', '0'));
    expect(inner).toMatch(decl('box-shadow', 'none'));
    expect(inner).toMatch(decl('padding', '0'));
  });

  it('点按区不引入硬编码底色或固定阴影色（明/暗主题下都保持透明）', () => {
    expect(inner, '固定色值会让浅色主题重现大块底色').not.toMatch(/#[0-9a-fA-F]{3,8}\b/);
    expect(inner).not.toMatch(/rgba?\(/);
  });

  it('44×44 透明点按区与内容居中不变（WCAG 2.5.5 / T04542 裁决 B）', () => {
    expect(inner).toMatch(decl('min-width', '44px'));
    expect(inner).toMatch(decl('min-height', '44px'));
    expect(inner).toMatch(/align-items:\s*center/);
    expect(inner).toMatch(/justify-content:\s*center/);
  });

  it('hover 不再叠发光投影；键盘焦点反馈仍是独立规则', () => {
    const hover = ruleBlock(badge, '.ctx-badge-inner:hover');
    expect(hover, 'hover 投影会让外框在交互态又长回来').not.toMatch(/box-shadow/);
    expect(badge).toMatch(/\.ctx-badge-inner:focus-visible/);
    expect(ruleBlock(badge, '.ctx-badge-inner:focus-visible')).toMatch(/outline:\s*2px/);
  });

  it('浮层自身样式保留（那是弹层面板，不是图标外框）', () => {
    expect(badge).toMatch(/\.ctx-tooltip-popper\.el-popper \{[^}]*border: 1px/);
  });
});

describe('T05703 仅改样式：功能与布局口径不回归', () => {
  it('压缩入口仍是原生 button + click 触发 popover + aria-label', () => {
    expect(badge).toContain('<button type="button" class="ctx-badge-inner"');
    expect(badge).toContain('trigger="click"');
    expect(badge).toContain(':aria-label="badgeLabel"');
    expect(badge).toContain('ctx-compact-btn');
  });

  it('compact 请求与成功提示原样保留', () => {
    expect(badge).toContain('/threads/${props.threadId}/compact');
    expect(badge).toContain("ElMessage.success('上下文已压缩')");
  });

  it('宿主行高口径不动：桌面 44px 行 / 30px CTA，移动端 44px 控件', () => {
    expect(ruleBlock(query, '.button-bar')).toMatch(decl('min-height', '44px'));
    const send = /\.send-btn,\s*\.stop-btn \{([^}]*)\}/.exec(query);
    expect(send, '找不到 .send-btn,.stop-btn 规则').toBeTruthy();
    expect(send![1]).toMatch(decl('height', '30px'));
    expect(mobile).toMatch(/:deep\(\.context-usage-badge\) \{ height: 44px; align-self: flex-end; \}/);
  });
});
