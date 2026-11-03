// T04449 口径推广·第二组：配置中心（Config.vue）。
// 与首组同一缺陷族：把主题强调色 `--neon-cyan` 裸写进前景。改造前由临时取证用例逐面实算
// （解析每条裸前景声明所在规则、取该规则自己的 background 作面，未声明的按卡片面计）：
//   macaron 最差 1.38:1、enterprise 2.11:1、ecommerce 2.32:1、portfolio 3.93:1，
//   深色主题（default/creative/product）与 light-business 本来达标——所以判定必须逐主题，
//   不能按「问答页修好了」推断。接入 --accent-readable 口径后 8 主题最差 4.82:1。
// 本组还暴露并补掉一个守护盲区：`findBareForegroundUses` 的声明正则按行首属性名匹配，
// 漏掉「单行规则」`{ color: var(--neon-cyan); }` 与 `border-left: 3px solid var(--neon-cyan)`
// 简写里的颜色。因此本文件除口径守护外，另加一条「整文件不允许出现未包裹的 --neon-cyan 引用」
// 的行级锁——它比逐属性正则更宽，专门兜住简写与单行写法。
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { ROOT, auditThemes, findBareForegroundUses, formatFailures, loadThemes, type AuditRow } from './helpers/contrast';

const FILE = 'src/views/Config.vue';
const themes = loadThemes();

/** 消费点清单（28 行）：label 用选择器语义，bg 用该元素源码里自己声明的面 */
const AUDIT: AuditRow[] = [
  { label: '配置页·头部等宽小标签', fg: 'var(--accent-readable)', bg: 'var(--bg-card-solid)', kind: 'text' },
  { label: '配置页·区块小标签', fg: 'var(--accent-readable)', bg: 'var(--bg-card-solid)', kind: 'text' },
  { label: '配置页·QQ 区块小标签', fg: 'var(--accent-readable)', bg: 'var(--bg-card-solid)', kind: 'text' },
  { label: '配置页·保存按钮 hover 描边', fg: 'var(--accent-readable)', bg: 'var(--bg-card-solid)', kind: 'ui' },
  { label: '配置页·保存按钮 hover 文字', fg: 'var(--accent-readable)', bg: 'var(--bg-card-solid)', kind: 'text' },
  { label: '配置页·Schema 输入框 focus 描边', fg: 'var(--accent-readable)', bg: 'var(--bg-card-solid)', kind: 'ui' },
  { label: '配置页·区块括号符', fg: 'var(--accent-readable)', bg: 'var(--bg-card-solid)', kind: 'text' },
  { label: '配置页·密钥已配置状态文字', fg: 'var(--accent-readable)', bg: 'var(--accent-cyan-a15)', kind: 'text' },
  { label: '配置页·共享密钥徽章', fg: 'var(--accent-readable)', bg: 'var(--accent-cyan-a15)', kind: 'text' },
  { label: '配置页·警示提示内 code', fg: 'var(--accent-readable)', bg: 'var(--accent-cyan-a12)', kind: 'text' },
  { label: '配置页·热生效强调文字', fg: 'var(--accent-readable)', bg: 'var(--bg-card-solid)', kind: 'text' },
  { label: '配置页·生效标签', fg: 'var(--accent-readable)', bg: 'var(--accent-cyan-a10)', kind: 'text' },
  { label: '配置页·提交号', fg: 'var(--accent-readable)', bg: 'var(--accent-cyan-a10)', kind: 'text' },
  { label: '配置页·diff 新增行前缀', fg: 'var(--accent-readable)', bg: 'var(--bg-card-solid)', kind: 'text' },
  { label: '配置页·用户徽章', fg: 'var(--accent-readable)', bg: 'var(--accent-cyan-a10)', kind: 'text' },
  { label: '配置页·预设标签 hover 描边', fg: 'var(--accent-readable)', bg: 'var(--accent-cyan-a10)', kind: 'ui' },
  { label: '配置页·预设标签 hover 文字', fg: 'var(--accent-readable)', bg: 'var(--accent-cyan-a10)', kind: 'text' },
  { label: '配置页·预设标签选中描边', fg: 'var(--accent-readable)', bg: 'var(--accent-cyan-a15)', kind: 'ui' },
  { label: '配置页·预设标签选中文字', fg: 'var(--accent-readable)', bg: 'var(--accent-cyan-a15)', kind: 'text' },
  { label: '配置页·表单项 hover 描边', fg: 'var(--accent-readable)', bg: 'var(--bg-card-solid)', kind: 'ui' },
  { label: '配置页·表单项 focus 描边', fg: 'var(--accent-readable)', bg: 'var(--bg-card-solid)', kind: 'ui' },
  { label: '配置页·连通测试结果(成功)', fg: 'var(--accent-readable)', bg: 'linear-gradient(135deg, var(--accent-cyan-a12), var(--accent-cyan-a03))', kind: 'text' },
  { label: '配置页·快捷键提示 code', fg: 'var(--accent-readable)', bg: 'var(--accent-cyan-a12)', kind: 'text' },
  { label: '配置页·提示条左侧色条(border-left 简写)', fg: 'var(--accent-readable)', bg: 'var(--accent-purple-a06)', kind: 'ui' },
  { label: '配置页·规则名内 code', fg: 'var(--accent-readable)', bg: 'var(--accent-cyan-a10)', kind: 'text' },
  { label: '配置页·正则校验通过态', fg: 'var(--accent-readable)', bg: 'var(--bg-card-solid)', kind: 'text' },
  { label: '配置页·测试进行中', fg: 'var(--accent-readable)', bg: 'var(--bg-card-solid)', kind: 'text' },
  { label: '配置页·迁移文件选择 hover 描边', fg: 'var(--accent-readable)', bg: 'var(--bg-card-solid)', kind: 'ui' },
];

const declCount = (src: string) => [...src.matchAll(/^[ \t]*(?:color|border-color|border-left-color|outline-color)[ \t]*:[ \t]*[^;]*--accent-readable/gm)].length;

describe('T04449 推广第二组：配置中心前景逐主题达标', () => {
  it('8 主题 × 28 面全部达 AA（文本 4.5 / 非文本 3.0）', () => {
    const failures = auditThemes(AUDIT, themes);
    expect(failures, formatFailures(failures)).toEqual([]);
  });

  it('清单与源码逐属性消费点对齐（27 个标准前景声明 + 1 个 border-left 简写）', () => {
    const src = readFileSync(join(ROOT, FILE), 'utf8');
    // 简写行 `border-left: 3px solid …` 不落在按行首属性名的计数正则里，故 28 面里只有 27 可数。
    expect(declCount(src)).toBe(27);
    expect(AUDIT.length).toBe(28);
  });

  it('整文件不存在未包裹的 --neon-cyan 引用（行级锁，兜住单行规则与简写）', () => {
    const src = readFileSync(join(ROOT, FILE), 'utf8');
    const unwrapped = src
      .split(/\r?\n/)
      .map((l) => l.trim())
      .filter((l) => l.includes('--neon-cyan') && !l.includes('--accent-readable') && !/^(\/\*|\*|\/\/)/.test(l));
    expect(unwrapped, `未包裹的强调色引用：${unwrapped.join(' | ')}`).toEqual([]);
  });
});

describe('T04449 推广第二组：口径守护（不得再把 --neon-cyan 裸写进前景）', () => {
  it(`${FILE}：--neon-cyan 只允许作为 --accent-readable 的 fallback 出现`, () => {
    const src = readFileSync(join(ROOT, FILE), 'utf8');
    const violations = findBareForegroundUses(src, {
      tokens: /var\(\s*--neon-cyan\b/,
      readableWrappers: [/--accent-readable/],
    });
    expect(violations, `${FILE} 存在裸用强调色的前景表达式`).toEqual([]);
  });

  it('配置页至少接入 25 处 readable 前景（计数锁）', () => {
    const src = readFileSync(join(ROOT, FILE), 'utf8');
    expect(declCount(src), `${FILE} 的 readable 前景消费点数量异常，疑似清单与实现同时走样`).toBeGreaterThanOrEqual(25);
  });
});
