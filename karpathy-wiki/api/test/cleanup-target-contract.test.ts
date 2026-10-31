// T02941（帮助文档同源批次 2 / T02705 术语守护延长线）：清理目标清单的跨包一致性守护。
// ------------------------------------------------------------------
// CleanupTarget 字面量在仓库里有四份互不 import 的清单：
//   1. frontend/src/types.ts        —— 前端契约（4 类 + all）
//   2. api/src/cleanup-guard.ts     —— 后端权威清单 ALL_CLEANUP_TARGETS
//   3. api/src/routes/cleanup.ts    —— dispatchTarget 的 switch 分支（真正会执行的集合）
//   4. api/src/routes/cleanup.ts    —— target==='all' 时显式展开的数组
// 跨包无法共享常量，所以用源码解析比对「集合是否一致」：任一侧单独加/删目标，
// 后端要么报「未知清理目标」、要么静默漏跑，而编译器和类型检查都看不见。
// 解析口径用 TypeScript Compiler API 而不是正则（沿用 mirror-types-contract 的教训）。
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import ts from 'typescript';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(HERE, '../..');
const FE_TYPES_PATH = path.join(REPO_ROOT, 'frontend', 'src', 'types.ts');
const GUARD_PATH = path.join(REPO_ROOT, 'api', 'src', 'cleanup-guard.ts');
const ROUTE_PATH = path.join(REPO_ROOT, 'api', 'src', 'routes', 'cleanup.ts');

function parseFile(file: string): ts.SourceFile {
  return ts.createSourceFile(file, readFileSync(file, 'utf8'), ts.ScriptTarget.ESNext, true);
}

function walk(node: ts.Node, visit: (n: ts.Node) => void): void {
  visit(node);
  ts.forEachChild(node, (child) => walk(child, visit));
}

/** 前端契约：export type CleanupTarget = 'a' | 'b' | ... */
export function readTypeUnionLiterals(file: string, typeName: string): string[] {
  const source = parseFile(file);
  let found: string[] | null = null;
  walk(source, (node) => {
    if (found || !ts.isTypeAliasDeclaration(node) || node.name.text !== typeName) return;
    const type = node.type;
    if (!ts.isUnionTypeNode(type)) throw new Error(`${typeName} 不是字面量联合`);
    found = type.types.map((t) => {
      if (!ts.isLiteralTypeNode(t) || !ts.isStringLiteral(t.literal)) {
        throw new Error(`${typeName} 含非字符串字面量成员`);
      }
      return t.literal.text;
    });
  });
  if (!found) throw new Error(`未找到类型 ${typeName}`);
  return found;
}

/** 后端权威清单：const ALL_CLEANUP_TARGETS = ['a', 'b'] as const */
export function readConstStringArray(file: string, varName: string): string[] {
  const source = parseFile(file);
  let found: string[] | null = null;
  walk(source, (node) => {
    if (found || !ts.isVariableDeclaration(node) || !ts.isIdentifier(node.name)) return;
    if (node.name.text !== varName || !node.initializer) return;
    let init: ts.Expression = node.initializer;
    if (ts.isAsExpression(init)) init = init.expression;
    if (!ts.isArrayLiteralExpression(init)) throw new Error(`${varName} 不是数组字面量`);
    found = init.elements.map((el) => {
      if (!ts.isStringLiteral(el)) throw new Error(`${varName} 含非字符串字面量元素`);
      return el.text;
    });
  });
  if (!found) throw new Error(`未找到常量 ${varName}`);
  return found;
}

/** 路由执行分支：dispatchTarget 的 switch case 标签 */
export function readDispatchSwitchCases(file: string): string[] {
  const source = parseFile(file);
  let fn: ts.FunctionDeclaration | null = null;
  walk(source, (node) => {
    if (fn) return;
    if (ts.isFunctionDeclaration(node) && node.name?.text === 'dispatchTarget') fn = node;
  });
  if (!fn) throw new Error('未找到 dispatchTarget');
  const out: string[] = [];
  walk(fn, (node) => {
    if (!ts.isSwitchStatement(node)) return;
    for (const clause of node.caseBlock.clauses) {
      if (ts.isCaseClause(clause) && ts.isStringLiteral(clause.expression)) out.push(clause.expression.text);
    }
  });
  return out;
}

/** target==='all' 的展开数组：const targets = target === 'all' ? [...] : [target] */
export function readAllExpansionTargets(file: string): string[] {
  const source = parseFile(file);
  let found: string[] | null = null;
  walk(source, (node) => {
    if (found || !ts.isVariableDeclaration(node) || !ts.isIdentifier(node.name)) return;
    if (node.name.text !== 'targets' || !node.initializer) return;
    const cond = node.initializer;
    if (!ts.isConditionalExpression(cond) || !ts.isArrayLiteralExpression(cond.whenTrue)) {
      throw new Error("targets 的初值不是 target==='all' ? [...] : [...] 形态");
    }
    found = cond.whenTrue.elements.map((el) => {
      if (!ts.isStringLiteral(el)) throw new Error('all 展开数组含非字符串字面量元素');
      return el.text;
    });
  });
  if (!found) throw new Error('未找到 all 展开数组');
  return found;
}

/** 多份清单的集合比对：第一份为基准，返回逐份差异（空数组表示一致） */
export function compareTargetSets(sources: Record<string, string[]>): string[] {
  const entries = Object.entries(sources).map(
    ([name, list]) => [name, [...new Set(list)].sort()] as const,
  );
  if (entries.length < 2) throw new Error('至少需要两份清单才能比对');
  const [baseName, base] = entries[0];
  const out: string[] = [];
  for (const [name, list] of entries.slice(1)) {
    const onlyBase = base.filter((x) => !list.includes(x));
    const onlyOther = list.filter((x) => !base.includes(x));
    if (onlyBase.length || onlyOther.length) {
      out.push(
        `${name} 与 ${baseName} 不一致：仅 ${baseName} ${JSON.stringify(onlyBase)}，仅 ${name} ${JSON.stringify(onlyOther)}`,
      );
    }
  }
  return out;
}

describe('T02941 清理目标清单跨包一致（前端契约 / 后端权威 / 执行分支 / all 展开）', () => {
  const feTargets = readTypeUnionLiterals(FE_TYPES_PATH, 'CleanupTarget');
  const feConcrete = feTargets.filter((t) => t !== 'all');
  const guardTargets = readConstStringArray(GUARD_PATH, 'ALL_CLEANUP_TARGETS');
  const switchCases = readDispatchSwitchCases(ROUTE_PATH);
  const allExpansion = readAllExpansionTargets(ROUTE_PATH);

  it('解析不是空跑：四份清单都解出目标', () => {
    expect(feTargets).toContain('all');
    expect(feConcrete.length).toBeGreaterThanOrEqual(4);
    expect(guardTargets.length).toBeGreaterThanOrEqual(4);
    expect(switchCases.length).toBeGreaterThanOrEqual(4);
    expect(allExpansion.length).toBeGreaterThanOrEqual(4);
  });

  it('前端 CleanupTarget（去掉 all）与后端三份清单集合一致', () => {
    const violations = compareTargetSets({
      'frontend CleanupTarget': feConcrete,
      'api ALL_CLEANUP_TARGETS': guardTargets,
      'api dispatchTarget switch': switchCases,
      "api target==='all' 展开": allExpansion,
    });
    expect(violations, `清理目标清单已分叉：\n${violations.join('\n')}`).toEqual([]);
  });

  it("'all' 只存在于前端契约里，不作为具体目标下发", () => {
    expect(feTargets).toContain('all');
    for (const list of [guardTargets, switchCases, allExpansion]) expect(list).not.toContain('all');
  });

  it('反向用例：任一侧单独加目标，比对必须红（不靠注释自称有效）', () => {
    const base = { A: ['compile_cache', 'run_state'], B: ['compile_cache', 'run_state'] };
    expect(compareTargetSets(base)).toEqual([]);
    // 后端执行分支单侧加一个目标 → 红（新增目标没进前端契约，用户点不到却可能被 all 覆盖）
    const backendExtra = compareTargetSets({ A: base.A, B: [...base.B, 'orphan_page'] });
    expect(backendExtra).toHaveLength(1);
    expect(backendExtra[0]).toContain('orphan_page');
    // 前端契约单侧加目标 → 红（用户在页面上选中了一个后端不认识的 target）
    const frontendExtra = compareTargetSets({ A: [...base.A, 'wiki_export'], B: base.B });
    expect(frontendExtra).toHaveLength(1);
    expect(frontendExtra[0]).toContain('wiki_export');
  });
});
