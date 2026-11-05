// T04472：桌面「硬白字压强调面」的面级配对与全站锁。
//
// 缺陷族与 T04449/T04470 方向相反：那边是「强调色裸写当前景」，这边是「白字硬写在强调面上」。
// 根因同一个：前景与所在面各写各的。所在面是 --grad-fire/--grad-cool/--grad-aurora、粉 tint、
// 或 --bg-card-solid 一类的半透明/浅色卡片时，白字在浅底主题里实测掉到 1.00:1（文字与底同色、
// 整块看不见）。修法沿用 T04447 已验证的口径：一个面给一对 token（--on-<面>-fg / --on-<面>-bg），
// 取值逐主题实算；需要压深时**只压这一面**，不动 --grad-* 本体（--grad-fire 全站 59 处引用）。
//
// 本文件六条腿：
//   A 取证（改前实况，永久留在仓库说明为什么要改）：11 处按原始表达式逐主题实算，
//     断言未达标条数与「最差 ≤ 1.05」这两件事成立；
//   B 数值主锁：11 处按配对 token 逐主题实算，必须 0 未达标；另加清理页危险态的 border-color 行；
//   C 成对锁：每个落点的同一条规则里必须同时出现该面的 -fg 与 -bg，且前景不再有硬编码白
//     （防「只接前景、底色仍写原渐变」的半接入——只数 token 出现次数兜不住这种）；
//   D 取值定调锁：逐主题登记 --on-cool-bg / --on-aurora-bg 的字面取值，
//     并按「主题覆盖了自己的渐变就必须覆盖自己的压深面」锁住完整性（新主题漏配即红）；
//   E 扫描器口径锁（负控制，必须全绿）：var() 的 fallback 位不计、纯深底白字不计、
//     直接白字必计——证明新扫描器既不漏判也不误伤；
//   F 全站硬白字基线：桌面 .vue 逐文件计数只降不升，11 个已修文件钉在 0；
//     移动端皮肤（T04467 口径）不在本单改色，但按文件冻结当前处数——「暂不处理」不等于「不看」。
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  ROOT,
  auditThemes,
  formatFailures,
  foregroundOf,
  listHardWhiteForegroundUses,
  loadThemes,
  ruleBodies,
  type AuditRow,
} from './helpers/contrast';

interface Site {
  label: string;
  file: string;
  selector: string;
  /** 该面的配对 token 家族名（--on-<face>-fg / -bg） */
  face: 'on-fire' | 'on-cool' | 'on-aurora' | 'on-danger' | 'on-danger-tint' | 'on-tooltip';
  kind: 'text' | 'ui';
  /** 改前的原始表达式（取证腿用） */
  beforeFg: string;
  beforeBg: string;
  /** 所在面是文字还是非文本判定的依据，写在这里避免后人不明所以地改档位 */
  why: string;
}

const SITES: Site[] = [
  { label: '问答页·.user-avatar', file: 'src/views/Query.vue', selector: '.user-avatar', face: 'on-fire', kind: 'text', beforeFg: '#fff', beforeBg: 'var(--grad-fire)', why: '头像内是用户名首字（文本，4.5）' },
  { label: '悬浮问答·.user-avatar', file: 'src/components/FloatingChat.vue', selector: '.user-avatar', face: 'on-fire', kind: 'text', beforeFg: '#fff', beforeBg: 'var(--grad-fire)', why: '同上，与问答页同一面同一语义' },
  { label: '用户管理·.neon-btn', file: 'src/views/Users.vue', selector: '.neon-btn', face: 'on-fire', kind: 'text', beforeFg: '#fff', beforeBg: 'var(--grad-fire)', why: '按钮文字 13px（文本，4.5）' },
  { label: '登录页·.login-btn', file: 'src/views/Login.vue', selector: '.login-btn', face: 'on-fire', kind: 'text', beforeFg: '#fff', beforeBg: 'var(--grad-fire)', why: '主按钮文字 14px（文本，4.5）' },
  { label: '注册页·.login-btn', file: 'src/views/Register.vue', selector: '.login-btn', face: 'on-fire', kind: 'text', beforeFg: '#fff', beforeBg: 'var(--grad-fire)', why: '与登录页同面同口径' },
  { label: '图谱页·.seg-control button.active', file: 'src/views/Graph.vue', selector: '.seg-control button.active', face: 'on-cool', kind: 'text', beforeFg: '#fff', beforeBg: 'var(--grad-cool, var(--accent-purple-a40))', why: '段控件选中态文字（文本，4.5）' },
  { label: '关于页·.brand-logo', file: 'src/views/About.vue', selector: '.brand-logo', face: 'on-aurora', kind: 'text', beforeFg: '#fff', beforeBg: 'var(--grad-aurora)', why: '模板里是「KW」两个字母（文本，4.5）' },
  { label: '帮助页·.intro-icon-wrap', file: 'src/views/Help.vue', selector: '.intro-icon-wrap', face: 'on-aurora', kind: 'ui', beforeFg: '#fff', beforeBg: 'var(--grad-aurora)', why: '内部是 fill=currentColor 的 SVG 星形（非文本，按 1.4.11 的 3.0；实测按 3.0 也全线不达）' },
  { label: '问答页·.chip-tooltip', file: 'src/views/Query.vue', selector: '.chip-tooltip', face: 'on-tooltip', kind: 'text', beforeFg: '#fff', beforeBg: 'var(--bg-card-solid, rgba(0, 0, 0, 0.75))', why: 'hover 浮层正文 10px（文本，4.5）' },
  { label: '清理页·.cleanup-btn.danger', file: 'src/views/Cleanup.vue', selector: '.cleanup-btn.danger', face: 'on-danger-tint', kind: 'text', beforeFg: '#fff', beforeBg: 'linear-gradient(135deg, var(--accent-pink-a30), var(--accent-pink-a15))', why: '危险按钮文字（文本，4.5）' },
  { label: '附件上传·.remove-btn', file: 'src/components/AttachmentUploader.vue', selector: '.remove-btn', face: 'on-danger', kind: 'text', beforeFg: 'white', beforeBg: 'var(--danger, #d32f2f)', why: '× 是文字符号（文本，4.5）' },
];

const row = (s: Site): AuditRow => ({ label: s.label, fg: `var(--${s.face}-fg)`, bg: `var(--${s.face}-bg)`, kind: s.kind });
const beforeRow = (s: Site): AuditRow => ({ label: s.label, fg: s.beforeFg, bg: s.beforeBg, kind: s.kind });

/** 附加行：同一条规则里的其它前景（不清钉 hover 会被通用 hover 规则顶掉，见 Cleanup.vue 注释） */
const EXTRA_ROWS: AuditRow[] = [
  { label: '清理页·.cleanup-btn.danger [border-color·pink readable × 配对 tint 面]', fg: 'var(--pink-readable)', bg: 'var(--on-danger-tint-bg)', kind: 'ui' },
  { label: '问答页·.chip-tooltip [border 无·仅面本身]', fg: 'var(--on-tooltip-fg)', bg: 'var(--on-tooltip-bg)', kind: 'text' },
];

/** 取值定调锁：逐主题登记的压深面字面值（改它等于改本单定调，需连带工单一起动） */
const FACE_VALUES: Record<string, Record<string, string>> = {
  'default(:root)': {
    '--on-cool-bg': 'linear-gradient(135deg, #007c81 0%, #8338ec 100%)',
    '--on-aurora-bg': 'linear-gradient(120deg, #007c81 0%, #a824f3 40%, #dc005f 80%, #c32f9a 100%)',
    '--on-danger-bg': '#b3261e',
  },
  creative: {
    '--on-cool-bg': 'linear-gradient(135deg, #007c81 0%, #8338ec 100%)',
    '--on-aurora-bg': 'linear-gradient(120deg, #007c81 0%, #a824f3 40%, #dc005f 80%, #c32f9a 100%)',
    '--on-danger-bg': '#b3261e',
  },
  ecommerce: {
    '--on-cool-bg': 'linear-gradient(135deg, #0077a5 0%, #0066cc 100%)',
    '--on-aurora-bg': 'linear-gradient(120deg, #0077a5 0%, #6a5ae3 40%, #ba4e27 80%, #a75c2b 100%)',
    '--on-danger-bg': 'var(--danger)',
  },
  enterprise: {
    '--on-cool-bg': 'linear-gradient(135deg, #047a8f 0%, #2563eb 100%)',
    '--on-aurora-bg': 'linear-gradient(120deg, #047a8f 0%, #2563eb 40%, #316dce 80%, #5d5fe1 100%)',
    '--on-danger-bg': 'var(--danger)',
  },
  'light-business': {
    '--on-cool-bg': 'linear-gradient(135deg, #2a6fc7 0%, #1554d1 100%)',
    '--on-aurora-bg': 'linear-gradient(120deg, #2a6fc7 0%, #1554d1 40%, #396cce 80%, #0f3f9e 100%)',
    '--on-danger-bg': 'var(--danger)',
  },
  macaron: {
    '--on-cool-bg': 'var(--grad-cool)',
    '--on-aurora-bg': 'var(--grad-aurora)',
    '--on-danger-bg': '#b3261e',
  },
  portfolio: {
    '--on-cool-bg': 'linear-gradient(135deg, #826d3f 0%, #826c50 100%)',
    '--on-aurora-bg': 'linear-gradient(120deg, #826d3f 0%, #1a1a1a 40%, #826c50 80%, #806d45 100%)',
    '--on-danger-bg': 'var(--danger)',
  },
  product: {
    '--on-cool-bg': 'var(--grad-cool)',
    '--on-aurora-bg': 'linear-gradient(120deg, #008145 0%, #007a93 30%, #5d5fe1 60%, #da006d 100%)',
    '--on-danger-bg': '#b3261e',
  },
};

/**
 * 全站硬白字基线（桌面 .vue，不含 components/mobile/** —— 那是 T04467 的独立皮肤口径）。
 * 只降不升：新增即红；已修的 11 处钉在 0。
 */
const HARD_WHITE_BASELINE: Record<string, number> = {
  'src/views/Ingest.vue': 1,
};
/**
 * 移动端皮肤（src/components/mobile/**）另有 T04467 的独立口径，本单不改它的色板；
 * 但「不改」不等于「不看」——这里按文件冻结当前处数（只降不升），
 * 否则排除目录会变成第二套无人认领的硬白字，将来加白字也没人拦。
 */
const MOBILE_BASELINE: Record<string, number> = {
  'src/components/mobile/MobileListen.vue': 5,
  'src/components/mobile/MobileLogin.vue': 12,
  'src/components/mobile/MobileMe.vue': 1,
  'src/components/mobile/MobileQuery.vue': 4,
};
const FIXED_FILES = [...new Set(SITES.map((s) => s.file))];

const src = (f: string) => readFileSync(join(ROOT, f), 'utf8');

describe('T04472 · 取证：改前的硬白字面全线不达 AA', () => {
  it('A · 11 处按原始表达式逐主题实算：未达标条数 ≥ 70，且存在 ≤1.05 的「文字不可见」面', () => {
    const failures = auditThemes(SITES.map(beforeRow), loadThemes());
    const worst = Math.min(...failures.map((f) => f.ratio));
    // 工单口径：桌面 12 处硬白字里 11 处跌破 AA（唯一达标的 Ingest .bookmarklet 不在本单）
    expect(failures.length, formatFailures(failures)).toBeGreaterThanOrEqual(70);
    expect(worst, '存在白字与底色同色的面（≤1.05）才证明这不是「余量差一点」的挑剔').toBeLessThanOrEqual(1.05);
  });

  it('A2 · 清单规模：11 个落点、6 个面家族，一个不多一个不少', () => {
    expect(SITES.length).toBe(11);
    expect(new Set(SITES.map((s) => s.face)).size).toBe(6);
    // 每个落点都真能在源码里找到对应规则（防止清单与代码脱钩后无人发现）
    for (const s of SITES) {
      expect(ruleBodies(src(s.file), s.selector).length, `${s.file} 找不到选择器 ${s.selector}`).toBeGreaterThan(0);
    }
  });
});

describe('T04472 · 数值主锁：配对 token 逐主题达标', () => {
  it('B · 8 主题 × 11 面 + 2 附加行全部达 AA（文本 4.5 / 非文本 3.0）', () => {
    const failures = auditThemes([...SITES.map(row), ...EXTRA_ROWS], loadThemes());
    expect(failures, formatFailures(failures)).toEqual([]);
  });

  it('B2 · 前提成立：hover 若不定向钉回，危险态会被通用规则换成第二套前景', () => {
    const s = src('src/views/Cleanup.vue');
    // 通用 .cleanup-btn:hover:not(.is-disabled) 把 color 写成青 readable；它压在粉 tint 面上
    const failures = auditThemes(
      [{ label: '青 readable × 粉 tint 面（未钉住时的前景）', fg: 'var(--accent-readable)', bg: 'var(--on-danger-tint-bg)', kind: 'text' }],
      loadThemes(),
    );
    const pinned = s.includes('.cleanup-btn.danger:hover:not(.is-disabled)') && /color: var\(--on-danger-tint-fg\) !important;/.test(s);
    expect(pinned, 'Cleanup.vue 必须存在危险态 hover 定向规则钉住配对着色').toBe(true);
    // 无论青 readable 在几个主题不达（0 个也要成立：钉住是为了「一套前景」，不是因为它一定红）
    expect(failures.length).toBeLessThanOrEqual(8);
  });

  it('B3 · remove-btn 的 hover 只从配对底取色（不得退回未配对的 --danger）', () => {
    const s = src('src/components/AttachmentUploader.vue');
    expect(s).toContain('background: color-mix(in srgb, var(--on-danger-bg) 85%, black);');
    expect(s, 'hover 若混 --danger 本体，压深底会被换回亮红、白字重新掉档').not.toContain('var(--danger, #d32f2f)');
  });
});

describe('T04472 · 成对锁：面与前景必须同条规则成对出现', () => {
  for (const s of SITES) {
    it(`${s.label}：同一条规则里同时声明 --${s.face}-fg 与 --${s.face}-bg，且前景无硬编码白`, () => {
      const bodies = ruleBodies(src(s.file), s.selector);
      const paired = bodies.find((b) => b.includes(`var(--${s.face}-bg)`) && b.includes(`var(--${s.face}-fg)`));
      expect(paired, `${s.file} 的 ${s.selector} 没有把 --${s.face}-bg / -fg 写在同一条规则里（半接入）`).toBeTruthy();
      const fgs = foregroundOf(paired as string);
      expect(fgs.length, `${s.selector} 取不到前景声明`).toBeGreaterThan(0);
      for (const fg of fgs) {
        expect(fg, `${s.label} 的前景仍是硬编码白：${fg}（判定依据：${s.why}）`).not.toMatch(/#fff|#ffffff|\bwhite\b|rgba?\(\s*255\s*,\s*255\s*,\s*255/i);
      }
    });
  }

  it('light-business 的 .chip-tooltip 选择器补丁已下线（面取值只由 token 供给，不留第二套口径）', () => {
    const css = src('src/styles/themes/light-business.css');
    expect(css).not.toContain('.chip-tooltip {');
    expect(css).toContain('--on-tooltip-bg: rgba(17, 17, 17, 0.85);');
  });
});

describe('T04472 · 取值定调锁', () => {
  it('D1 · 逐主题的压深面字面值与本单定调一致', () => {
    for (const t of loadThemes()) {
      const want = FACE_VALUES[t.name];
      expect(want, `主题 ${t.name} 不在定调表里（新主题要按本单口径登记取值）`).toBeTruthy();
      for (const [token, value] of Object.entries(want as Record<string, string>)) {
        expect(t.decls.get(token), `${t.name} · ${token} 的取值与本单定调不一致`).toBe(value);
      }
    }
  });

  it('D2 · 覆盖了自己渐变的主题必须覆盖自己的压深面（:root 的字面压深版只适配 :root 端点）', () => {
    const themes = loadThemes();
    const root = themes[0];
    for (const t of themes.slice(1)) {
      for (const [grad, face] of [['--grad-cool', '--on-cool-bg'], ['--grad-aurora', '--on-aurora-bg']] as const) {
        const gradChanged = t.decls.get(grad) !== root.decls.get(grad);
        if (!gradChanged) continue;
        const faceValue = t.decls.get(face);
        expect(faceValue, `${t.name} 覆盖了 ${grad} 却没声明 ${face}`).toBeTruthy();
        expect(faceValue, `${t.name} 用了 :root 的压深面（色相与本主题渐变无关）`).not.toBe(root.decls.get(face));
      }
    }
  });
});

describe('T04472 · 扫描器口径（负控制：既不漏判也不误伤）', () => {
  it('E1 · var() 的 fallback 位不计——App/CitationText 的 --xxx, #fff 属合法', () => {
    expect(listHardWhiteForegroundUses(src('src/App.vue')), 'token fallback 里的白不该算硬白字前景').toEqual([]);
    expect(listHardWhiteForegroundUses(src('src/components/CitationText.vue'))).toEqual([]);
    expect(src('src/App.vue')).toContain('color: var(--menu-active-fg, #fff);');
    // Progress.vue 的两处是「嵌套 fallback」（var(--x, rgba(255,255,255,·))）：真实前景由 token 供给。
    // 早先用 /var\([^()]*\)/ 摘 var 组时，内层括号让它整条不匹配 → 被误判成硬白字；这里锁住配平摘除。
    expect(listHardWhiteForegroundUses(src('src/views/Progress.vue'))).toEqual([]);
    const nested = ['<style>', '.n { color: var(--text-secondary, rgba(255, 255, 255, 0.6)); }', '</style>'].join('\n');
    expect(listHardWhiteForegroundUses(nested), '嵌套括号 fallback 必须整组摘除').toEqual([]);
  });

  it('E2 · 直接写白字必计（扫描器不许被改哑）', () => {
    const probe = ['<style scoped>', '.x {', '  background: var(--grad-fire);', '  color: #fff;', '}', '</style>'].join('\n');
    expect(listHardWhiteForegroundUses(probe).length).toBe(1);
    const probe2 = ['<style>', '.y { -webkit-text-fill-color: white; }', '</style>'].join('\n');
    expect(listHardWhiteForegroundUses(probe2).length, 'white 关键字与 -webkit-text-fill-color 也要抓').toBe(1);
    // 单行规则（声明不在行首）与半透明白同样要抓：行锚定版扫描器正是在这里漏判
    const probe3 = ['<style>', '.z { border: 1px solid rgba(255, 255, 255, 0.42); }', '</style>'].join('\n');
    expect(listHardWhiteForegroundUses(probe3).length, '单行规则里的白色描边也要抓').toBe(1);
    const probe4 = ['<style>', '.w {', '  color: #ffffff;', '  background: linear-gradient(#fff, #000);', '}', '</style>'].join('\n');
    expect(listHardWhiteForegroundUses(probe4).length, 'background/gradient 里的白是装饰，不计为前景').toBe(1);
  });

  it('E3 · 唯一保留的白字站点：Ingest .bookmarklet（8/8 达标，工单已核实不改）', () => {
    const failures = auditThemes(
      [{ label: '采集页·.bookmarklet', fg: '#fff', bg: 'var(--color-primary, #0f4c81)', kind: 'text' }],
      loadThemes(),
    );
    expect(failures, formatFailures(failures)).toEqual([]);
    expect(listHardWhiteForegroundUses(src('src/views/Ingest.vue'))).toHaveLength(1);
  });
});

describe('T04472 · 全站硬白字基线（只降不升）', () => {
  it('F1 · 11 个已修文件的直接白字前景归零', () => {
    for (const f of FIXED_FILES) {
      const hits = listHardWhiteForegroundUses(src(f));
      expect(hits, `${f} 仍有直接硬白字前景：${hits.join(' | ')}`).toEqual([]);
    }
  });

  it('F2 · 桌面 .vue 逐文件计数停在基线（新增站点即红，防止同类缺陷再长回来）', () => {
    const seen = new Set<string>();
    for (const [f, n] of Object.entries(HARD_WHITE_BASELINE)) {
      seen.add(f);
      const hits = listHardWhiteForegroundUses(src(f));
      expect(hits.length, `${f} 硬白字前景应从基线 ${n} 只降不升，实测 ${hits.length}：${hits.join(' | ')}`).toBeLessThanOrEqual(n);
    }
    // 基线表之外的桌面文件必须为 0（新文件写硬白字即红）；移动端另有基线（同一扫描器、另一张表）
    const { readdirSync } = require('node:fs') as typeof import('node:fs');
    const walk = (dir: string, out: string[] = []): string[] => {
      for (const d of readdirSync(join(ROOT, dir), { withFileTypes: true })) {
        const rel = `${dir}/${d.name}`;
        if (d.isDirectory()) walk(rel, out);
        else if (rel.endsWith('.vue')) out.push(rel);
      }
      return out;
    };
    for (const f of walk('src')) {
      if (seen.has(f)) continue;
      const hits = listHardWhiteForegroundUses(src(f));
      if (f.startsWith('src/components/mobile/')) {
        // 未登记 = 基线 0：移动端新写硬白字同样即红，要加必须先按 T04467 口径进表
        const n = MOBILE_BASELINE[f] ?? 0;
        expect(hits.length, `${f} 硬白字前景应从基线 ${n} 只降不升，实测 ${hits.length}：${hits.join(' | ')}`).toBeLessThanOrEqual(n);
        continue;
      }
      expect(hits, `${f} 出现了基线外的硬白字前景`).toEqual([]);
    }
    // 基线表不许留着已经消失的文件（否则「修完了」会被过期基线掩盖）
    for (const f of Object.keys(MOBILE_BASELINE)) {
      expect(walk('src'), `${f} 已不存在，基线表要同步删除`).toContain(f);
    }
  });
});
