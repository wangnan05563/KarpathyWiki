import matter from 'gray-matter';

// T03647：gray-matter 按「内容字符串原样」缓存解析结果，且缓存命中时只做浅拷贝
// （node_modules/gray-matter/index.js:35-47：`file = Object.assign({}, cached)`），
// 所以 parsed.data 以及 data 里的数组/对象仍是缓存本体。就地写它等于写缓存：
// 只要第二次读到的原始字节完全相同，就会拿到被第一次改过的同一个 data，随后
// matter.stringify 把别人的字段落进这个页面的 frontmatter。
// 约定：所有「读→改→写 frontmatter」的入口走本模块，先与缓存脱钩，改的永远是副本。
//
// T04454：同一份缓存还会把坏页「吃进去」。index.js:35-47 的顺序是「先写缓存、后解析」，
// 而缓存条目由 toFile 造出来时就带着 data:{}；坏 YAML 在随后的引擎里抛异常，data 因此永远停在
// {}，缓存却已经收下这个半成品。于是同一串字节在本进程里第一次读抛异常、之后每次都「成功」并
// 返回空 data——页面看着存在，但没有任何元数据，type/tags/status 一律不匹配，症状「自己好了」。
// 缓存只在 options === undefined 时启用，所以显式传一个 options 就能整条绕开它
// （lib/defaults.js 里 defaults({language:'yaml'}) 与 defaults(undefined) 完全同值，不改解析语义）。
// 绕开后解析结论只由字节决定，与「本进程第几次读」无关——这才是本单要的确定性。
// 代价实测（data/vault 409 页）：其中只有 3 页字节相同，全库扫描本来几乎命不中缓存；
// 单页解析 0.053 ms，关掉缓存跑完整库 97.0 ms，带缓存 95.8 ms，差别在噪声内。
export type FrontmatterData = Record<string, any>;

const NO_CACHE_OPTIONS = { language: 'yaml' } as const;

export interface PageDoc {
  data: FrontmatterData;
  content: string;
}

// 容错入口的返回值：调用方按 ok 决定「跳过并记账」还是「照常处理」，不必自己 catch
export type PageParse =
  | { ok: true; data: FrontmatterData; content: string }
  | { ok: false; reason: string };

// 深拷贝 frontmatter：YAML 值可能是数组/嵌套对象（如 entities），浅拷贝仍会串改缓存内部结构。
// 用 structuredClone 而非 JSON 往返：js-yaml 会把无引号日期解析成 Date，JSON 会把它压成字符串。
function detach<T>(value: T): T {
  return value === undefined || value === null
    ? (value as T)
    : structuredClone(value);
}

// 坏页原因压成一行：它会进聚合日志，多行原文会把一条 JSON 日志撑成不可读的长串
function failReason(err: unknown): string {
  const msg = err instanceof Error ? err.message : String(err);
  return msg.split('\n')[0].slice(0, 160);
}

export function parsePage(raw: string): PageDoc {
  const parsed = matter(raw, NO_CACHE_OPTIONS);
  return { data: detach(parsed.data) ?? {}, content: parsed.content };
}

/**
 * 坏 YAML 容错口径：解析失败＝坏页，返回 ok:false 而不是抛出。
 * 给「一次处理很多页」的入口用——一页写坏不该让整轮连坐（同 T04176 的检索侧结论）。
 * 判定与进程内第几次读无关：坏页第一次和第一万次都得到 ok:false。
 */
export function tryParsePage(raw: string): PageParse {
  try {
    const { data, content } = parsePage(raw);
    return { ok: true, data, content };
  } catch (err: unknown) {
    return { ok: false, reason: failReason(err) };
  }
}

// 正文以对象形式传入：避免 matter.stringify 再对正文做一次 YAML 解析
// （双块/非法内联 YAML 的历史页面会在重解析时抛 YAMLException）
export function stringifyPage(content: string, data: FrontmatterData): string {
  return matter.stringify({ content }, data);
}
