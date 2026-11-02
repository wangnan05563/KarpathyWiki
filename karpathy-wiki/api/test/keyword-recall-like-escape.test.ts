// T04068 回归锁：keywordRecall 的 LIKE 分支必须按「字面量」匹配用户输入的
// 通配符（% _）与转义符自身（\）。
// 缺陷本体：SQL 语句写成 `content LIKE ?` 而没有 `ESCAPE '\'` 子句——代码已经把
// 用户词里的 %/_ 前置了反斜杠，但 SQLite 在未声明 ESCAPE 时把反斜杠当普通字符，
// 于是「折扣%」这类查询变成搜索字面 `\%`（假阴性，该命中的不命中）；
// 而 FTS 语法错误的 catch 兜底分支连转义都没做，用户输入的 % 会退化成全表通配（假阳性）。
import { describe, it, expect, afterEach, beforeAll } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import {
  getIndexDb,
  replacePageChunks,
  keywordRecall,
  closeIndexDb,
} from '../src/search/sqlite-index.js';

const createdDirs: string[] = [];
let dataDir: string;

function freshDir(): string {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), 'wiki-like-escape-'));
  createdDirs.push(d);
  return d;
}

afterEach(() => {
  closeIndexDb();
});

beforeAll(() => {
  dataDir = freshDir();
  getIndexDb(dataDir);
});

function seed(rows: Array<[string, string]>): void {
  closeIndexDb();
  dataDir = freshDir();
  getIndexDb(dataDir);
  for (const [p, content] of rows) {
    replacePageChunks(dataDir, p, [{ content, heading: null }]);
  }
}

/** 取命中页面路径集合，便于断言「只命中含字面量的那一页」 */
function pathsOf(query: string): string[] {
  return keywordRecall(dataDir, query, 20).map((h) => h.pagePath);
}

describe('keywordRecall LIKE 分支的字面量匹配（T04068）', () => {
  it('两字词含 % 时按字面匹配，% 不被当作通配符', () => {
    seed([
      ['concepts/a.md', 'rate %ok enough'],
      ['concepts/b.md', 'rate xok enough'],
    ]);
    expect(pathsOf('%o')).toEqual(['concepts/a.md']);
  });

  it('两字词含 _ 时按字面匹配，_ 不被当作单字符通配符', () => {
    seed([
      ['concepts/a.md', 'id _val here'],
      ['concepts/b.md', 'id xval here'],
    ]);
    expect(pathsOf('_v')).toEqual(['concepts/a.md']);
  });

  it('转义符自身（反斜杠）也按字面匹配，不吞掉后一个字符', () => {
    seed([
      ['concepts/a.md', 'path C:\\tmp read'],
      ['concepts/b.md', 'path colt read'],
    ]);
    // 查询词 = 反斜杠 + t；若只加 ESCAPE 而不转义反斜杠本身，\t 会被解释为
    // 「转义后的 t」，等价于搜 %t%，第二页（不含反斜杠）会被误命中。
    expect(pathsOf('\\t')).toEqual(['concepts/a.md']);
  });

  it('单词仅为 % 时不得匹配全库（假阳性防线）', () => {
    seed([
      ['concepts/a.md', '增长 50% 达标'],
      ['concepts/b.md', '增长 50 达标'],
      ['concepts/c.md', '完全无关内容'],
    ]);
    expect(pathsOf('%')).toEqual(['concepts/a.md']);
  });

  it('普通中文两字词（无通配符）仍走 LIKE 并正常命中', () => {
    seed([
      ['concepts/a.md', '混合检索召回策略'],
      ['concepts/b.md', '图谱渲染方案'],
    ]);
    expect(pathsOf('检索')).toEqual(['concepts/a.md']);
  });
});

describe('LIKE 语句的 ESCAPE 子句源码守卫（T04068）', () => {
  const SRC = fs.readFileSync(
    path.resolve(__dirname, '../src/search/sqlite-index.ts'),
    'utf8',
  );
  // 只扫 keywordRecall 函数体，避免守卫随文件增长而误报别的 SQL
  const raw = SRC.slice(SRC.indexOf('export function keywordRecall'), SRC.indexOf('/** 向量路召回'));
  // 守卫判的是「实际 SQL 写法」，注释里的历史写法说明不该被当成缺陷命中——先去掉整行注释
  const body = raw
    .split('\n')
    .filter((line) => !/^\s*(\/\/|\*|\/\*)/.test(line))
    .join('\n');

  it('守卫覆盖到函数体（防止切片失效变成空断言）', () => {
    expect(body.length).toBeGreaterThan(200);
    expect(body).toContain('content LIKE ?');
  });

  it('每一处 LIKE 都带 ESCAPE 子句（含 catch 兜底分支）', () => {
    const likeCount = (body.match(/content LIKE \?/g) ?? []).length;
    const escapeCount = (body.match(/content LIKE \? ESCAPE/g) ?? []).length;
    expect(likeCount).toBe(escapeCount);
    expect(likeCount).toBeGreaterThanOrEqual(2);
  });

  it('两处 LIKE 的查询参数都经过同一转义函数（兜底分支不得裸拼参数）', () => {
    expect(body).toContain('toLikePattern(');
    // 兜底分支历史上写成 `%${terms[0]}%`——裸拼即未转义
    expect(body).not.toMatch(/`%\$\{terms\[0\]\}%`/);
  });
});
