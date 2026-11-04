// FR-20 语义搜索：SQLite 索引层（node:sqlite 内置模块，零依赖）。
// 约束 6 合规：向量以 BLOB 存于同一 SQLite 库（无独立向量库进程），embedding 计算外置到
// 用户 BYOK 的 embedding API——本模块不做任何网络调用，只负责存储与 FTS5 关键词查询。
// 为什么 node:sqlite 而非 better-sqlite3：Node ≥22.5 内置（运行时 v24 实测可用）、
// 编译期自带 FTS5，无需原生编译依赖，符合「单机零安装」路线。
// 为什么用 createRequire 动态加载而非静态 import：vite 5 / vitest 1.x 的模块解析器
// 内置清单不含 node:sqlite（Node 22.5 新增），静态 import 会被误解析为 npm 包 'sqlite'
// 导致构建/测试加载失败；CJS require 由 Node 运行时自行处理，绕开前端工具链解析。
import { createRequire } from 'node:module';
import fs from 'node:fs';
import path from 'node:path';

const nodeRequire = createRequire(import.meta.url);
const { DatabaseSync } = nodeRequire('node:sqlite') as typeof import('node:sqlite');
// DatabaseSync 是类（值），类型位置用 InstanceType 提取实例类型
type SyncDb = InstanceType<typeof DatabaseSync>;

export interface ChunkRow {
  pagePath: string;
  chunkIndex: number;
  content: string;
  heading: string | null;
}

export interface IndexStatus {
  indexedPages: number;
  pendingPages: number;
  totalChunks: number;
}

let db: SyncDb | null = null;
// 记录当前库目录：目录变更（测试隔离/多实例）时重建连接，避免旧句柄指向已删除的临时目录
let currentDir = '';

// 单例惰性初始化：库文件位于 data/（运行时数据目录，与 threads/ 同级）
export function getIndexDb(dataDir: string): SyncDb {
  if (db && currentDir === dataDir) return db;
  db?.close();
  fs.mkdirSync(dataDir, { recursive: true });
  db = new DatabaseSync(path.join(dataDir, 'wiki-index.db'));
  currentDir = dataDir;
  db.exec('PRAGMA journal_mode = WAL;');
  db.exec(`
    CREATE TABLE IF NOT EXISTS chunks (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      page_path TEXT NOT NULL,
      chunk_index INTEGER NOT NULL,
      content TEXT NOT NULL,
      heading TEXT,
      updated_at TEXT NOT NULL,
      UNIQUE(page_path, chunk_index)
    );
    CREATE TABLE IF NOT EXISTS chunk_vecs (
      page_path TEXT NOT NULL,
      chunk_index INTEGER NOT NULL,
      -- 向量按调用方序列化为 BLOB（Float32Array little-endian），此处只管存取
      vec BLOB NOT NULL,
      dim INTEGER NOT NULL,
      model TEXT NOT NULL,
      UNIQUE(page_path, chunk_index)
    );
    CREATE TABLE IF NOT EXISTS index_status (
      page_path TEXT PRIMARY KEY,
      status TEXT NOT NULL DEFAULT 'indexed',
      -- 重试计数：embedding 失败重试 ≤3 次后标记 pending（索引待补）
      attempts INTEGER NOT NULL DEFAULT 0,
      updated_at TEXT NOT NULL
    );
    CREATE VIRTUAL TABLE IF NOT EXISTS chunks_fts USING fts5(
      content, page_path UNINDEXED, content=chunks, content_rowid=id, tokenize='trigram'
    );
    -- FTS5 外部内容表同步触发器（chunks 增删改自动维护全文索引）
    CREATE TRIGGER IF NOT EXISTS chunks_ai AFTER INSERT ON chunks BEGIN
      INSERT INTO chunks_fts(rowid, content, page_path) VALUES (new.id, new.content, new.page_path);
    END;
    CREATE TRIGGER IF NOT EXISTS chunks_ad AFTER DELETE ON chunks BEGIN
      INSERT INTO chunks_fts(chunks_fts, rowid, content, page_path) VALUES ('delete', old.id, old.content, old.page_path);
    END;
    CREATE TRIGGER IF NOT EXISTS chunks_au AFTER UPDATE ON chunks BEGIN
      INSERT INTO chunks_fts(chunks_fts, rowid, content, page_path) VALUES ('delete', old.id, old.content, old.page_path);
      INSERT INTO chunks_fts(rowid, content, page_path) VALUES (new.id, new.content, new.page_path);
    END;
    -- T04069 向量缓存失效判据：单行「变更代号」，由 chunk_vecs 上的三个触发器在同一事务内推进。
    -- 为什么用触发器而不是让各写函数显式清缓存：改到向量的入口不止本模块
    -- （rebuildIndex 的裸 DELETE、补算/测试里的裸 UPDATE），显式清缓存必漏；
    -- 代号由数据库自己推进，读到不一致就重建，调用方无需知道缓存存在。
    -- 事务回滚时触发器一并回滚 → 代号不变 → 缓存继续有效（回滚确实没改到数据）。
    CREATE TABLE IF NOT EXISTS vec_gen (
      id INTEGER PRIMARY KEY CHECK (id = 1),
      gen INTEGER NOT NULL DEFAULT 0
    );
    CREATE TRIGGER IF NOT EXISTS vec_gen_ai AFTER INSERT ON chunk_vecs BEGIN
      INSERT INTO vec_gen (id, gen) VALUES (1, 1) ON CONFLICT (id) DO UPDATE SET gen = gen + 1;
    END;
    CREATE TRIGGER IF NOT EXISTS vec_gen_ad AFTER DELETE ON chunk_vecs BEGIN
      INSERT INTO vec_gen (id, gen) VALUES (1, 1) ON CONFLICT (id) DO UPDATE SET gen = gen + 1;
    END;
    CREATE TRIGGER IF NOT EXISTS vec_gen_au AFTER UPDATE ON chunk_vecs BEGIN
      INSERT INTO vec_gen (id, gen) VALUES (1, 1) ON CONFLICT (id) DO UPDATE SET gen = gen + 1;
    END;
  `);
  return db;
}

/** 测试与重建用：关闭并释放单例（进程内不影响其他模块） */
export function closeIndexDb(): void {
  db?.close();
  db = null;
  // T04069：连接释放时一并释放向量矩阵——缓存按 dataDir 归组，而代号要从库里读；
  // 不在此清理的话，测试隔离里同名临时目录复用会挂着上一轮矩阵（数据已删）。
  resetVectorCache();
}

/** 写入一页的 chunk（先清旧再写新，保证幂等） */
export function replacePageChunks(dataDir: string, pagePath: string, chunks: Array<{ content: string; heading: string | null }>): void {
  const d = getIndexDb(dataDir);
  const now = new Date().toISOString();
  const tx = d;
  let vecRowsTouched = 0;
  tx.exec('BEGIN');
  try {
    const delVecs = tx.prepare('DELETE FROM chunk_vecs WHERE page_path = ?').run(pagePath);
    // T04186 记账：删掉的每一行都会被触发器推一次代号，提交后据此登记「这页的向量变了」
    // （changes 的类型含 bigint 档，记账只按行数走，取 Number）
    vecRowsTouched = Number(delVecs.changes);
    tx.prepare('DELETE FROM chunks WHERE page_path = ?').run(pagePath);
    const ins = tx.prepare('INSERT INTO chunks (page_path, chunk_index, content, heading, updated_at) VALUES (?, ?, ?, ?, ?)');
    chunks.forEach((c, i) => ins.run(pagePath, i, c.content, c.heading, now));
    // T04182：切分的第一步已经把该页向量删干净了（上面那条 DELETE FROM chunk_vecs），
    // 所以冲突分支必须连同 status 一起退回 pending。此前只清 attempts 不重置 status，
    // 「重切后从未重算」的页面还挂着上一轮的 'indexed'：设置页「向量覆盖 N/M 页」虚高，
    // 且与按 chunk_vecs 实际有无判定的 staleModelPages 互相矛盾（同一时刻 N 与 stale 数对不上）。
    // 唯一能把 status 改回 indexed 的入口是 savePageVectors——向量真的写进去了才算覆盖。
    tx.prepare(`INSERT INTO index_status (page_path, status, attempts, updated_at) VALUES (?, 'pending', 0, ?)
                ON CONFLICT(page_path) DO UPDATE SET status = 'pending', attempts = 0, updated_at = excluded.updated_at`).run(pagePath, now);
    tx.exec('COMMIT');
    noteVecPageMutation(dataDir, pagePath, vecRowsTouched);
  } catch (err) {
    tx.exec('ROLLBACK');
    throw err;
  }
}

/** 写入某页全部 chunk 的向量，并把该页标记为 indexed（待补清零） */
export function savePageVectors(
  dataDir: string,
  pagePath: string,
  vectors: Float32Array[],
  model: string,
): void {
  const d = getIndexDb(dataDir);
  const now = new Date().toISOString();
  d.exec('BEGIN');
  try {
    const del = d.prepare('DELETE FROM chunk_vecs WHERE page_path = ?');
    const delCount = Number(del.run(pagePath).changes);
    const ins = d.prepare('INSERT INTO chunk_vecs (page_path, chunk_index, vec, dim, model) VALUES (?, ?, ?, ?, ?)');
    vectors.forEach((v, i) => {
      // Float32Array → BLOB：固定 4 字节小端，查询端同构反序列化
      ins.run(pagePath, i, Buffer.from(v.buffer, v.byteOffset, v.byteLength), v.length, model);
    });
    const vecRowsTouched = delCount + vectors.length;
    d.prepare(`INSERT INTO index_status (page_path, status, attempts, updated_at) VALUES (?, 'indexed', 0, ?)
               ON CONFLICT(page_path) DO UPDATE SET status = 'indexed', attempts = 0, updated_at = excluded.updated_at`)
      .run(pagePath, now);
    d.exec('COMMIT');
    noteVecPageMutation(dataDir, pagePath, vecRowsTouched);
  } catch (err) {
    d.exec('ROLLBACK');
    throw err;
  }
}

/** embedding 失败：累计重试计数，≤3 次 status=pending（索引待补），不阻塞摄取主流程 */
export function markIndexFailed(dataDir: string, pagePath: string): void {
  const d = getIndexDb(dataDir);
  const now = new Date().toISOString();
  d.prepare(`UPDATE index_status SET attempts = attempts + 1,
             status = CASE WHEN attempts + 1 >= 3 THEN 'pending' ELSE status END,
             updated_at = ? WHERE page_path = ?`).run(now, pagePath);
}

/** 删除页面索引（页面被删除/清空时调用，防引用跳转泄露已删除内容——NFR-4） */
export function removePageIndex(dataDir: string, pagePath: string): void {
  const d = getIndexDb(dataDir);
  d.prepare('DELETE FROM chunks WHERE page_path = ?').run(pagePath);
  const vecCount = Number(d.prepare('DELETE FROM chunk_vecs WHERE page_path = ?').run(pagePath).changes);
  d.prepare('DELETE FROM index_status WHERE page_path = ?').run(pagePath);
  noteVecPageMutation(dataDir, pagePath, vecCount);
}

/** FTS5 关键词路召回：BM25 排序 top-N。
 * 分词说明：trigram tokenizer 支持 CJK 子串匹配（默认 unicode61 会把整段中文当一个 token）。
 * trigram 的限制是查询串须 ≥3 字符——短查询与 FTS 语法错误一律降级 LIKE 扫描，保证功能可用。 */
// T04068：LIKE 的字面量匹配口径单一来源。SQLite 仅在语句显式声明 ESCAPE 时才把该字符
// 当转义符，因此「转义」与「ESCAPE 子句」必须成对出现（见 keywordRecall 两处 LIKE）。
// 转义符自身必须先替换，否则用户输入的反斜杠会变成转义符并吞掉后一个字符。
const LIKE_ESCAPE_CHAR = '\\';

export function toLikePattern(term: string): string {
  const escaped = term.replace(/[\\%_]/g, (c) => LIKE_ESCAPE_CHAR + c);
  return `%${escaped}%`;
}

export function keywordRecall(dataDir: string, query: string, limit: number): Array<ChunkRow & { score: number }> {
  const d = getIndexDb(dataDir);
  const terms = query.trim().split(/\s+/).filter(Boolean);
  if (terms.length === 0) return [];
  // 短查询（trigram 需 ≥3 字符）降级 LIKE；中文两字词（最常见的搜索粒度）走此分支
  const useLike = terms.some((t) => t.length < 3) || /["*()]/.test(query);
  if (useLike) {
    const likeTerms = terms.slice(0, 3);
    const where = likeTerms.map(() => `content LIKE ? ESCAPE '${LIKE_ESCAPE_CHAR}'`).join(' AND ');
    const rows = d.prepare(`
      SELECT page_path, chunk_index, content, heading FROM chunks WHERE ${where} LIMIT ?
    `).all(...likeTerms.map(toLikePattern), limit) as Array<{ page_path: string; chunk_index: number; content: string; heading: string | null }>;
    return rows.map((r) => ({ pagePath: r.page_path, chunkIndex: r.chunk_index, content: r.content, heading: r.heading, score: -1 }));
  }
  const match = terms.map((t) => `"${t.replace(/"/g, '""')}"`).join(' OR ');
  try {
    const rows = d.prepare(`
      SELECT c.page_path, c.chunk_index, c.content, c.heading, bm25(chunks_fts) AS score
      FROM chunks_fts f JOIN chunks c ON c.id = f.rowid
      WHERE chunks_fts MATCH ?
      ORDER BY score LIMIT ?
    `).all(match, limit) as Array<{ page_path: string; chunk_index: number; content: string; heading: string | null; score: number }>;
    return rows.map((r) => ({ pagePath: r.page_path, chunkIndex: r.chunk_index, content: r.content, heading: r.heading, score: r.score }));
  } catch {
    // FTS5 语法错误等：LIKE 兜底，不让关键词路崩溃
    // T04068：兜底分支与上方同一转义口径——历史上这里裸拼 `%${terms[0]}%`，
    // 用户输入的 %/_ 会退化成通配符（把全库当命中结果返回）。
    const rows = d.prepare(`SELECT page_path, chunk_index, content, heading FROM chunks WHERE content LIKE ? ESCAPE '${LIKE_ESCAPE_CHAR}' LIMIT ?`)
      .all(toLikePattern(terms[0]), limit) as Array<{ page_path: string; chunk_index: number; content: string; heading: string | null }>;
    return rows.map((r) => ({ pagePath: r.page_path, chunkIndex: r.chunk_index, content: r.content, heading: r.heading, score: -1 }));
  }
}

/** 向量路召回：与查询向量做余弦相似度，top-N。无向量数据时返回空（语义路自动关闭）
 *  T04067：model 是召回口径的一部分。dim 相同不代表语义空间相同——切换 embedding 模型后，
 *  旧模型向量与新查询向量做余弦会得到「看似很高」的分数并排在前面。传入 model 时只召回同模型向量；
 *  不传保持旧口径（供尚未确定模型的场景与测试使用）。 */
export function vectorRecall(
  dataDir: string,
  queryVec: Float32Array,
  limit: number,
  model?: string,
): Array<ChunkRow & { similarity: number }> {
  const d = getIndexDb(dataDir);
  if (queryVec.length === 0 || limit <= 0) return [];
  const top = recallCandidates(d, dataDir, queryVec, limit, model);
  if (top.length === 0) return [];
  return attachChunkContents(d, top);
}

// ── T04069 向量召回加速：进程内向量矩阵缓存 ────────────────────────────────
// 方案取舍：ticket 的首选是 sqlite-vec 下推，但它要随包分发平台相关的扩展二进制
// （node:sqlite 还得显式开 enableLoadExtension），与本项目「单机零安装 / 单文件发布」路线冲突，
// 故采纳备选：进程内缓存向量矩阵。两处收益都被 vector-recall-bench.test.ts 实测锁住——
//   1. 向量不再每次查询重新反序列化成 Float32Array（只有 chunk_vecs 变更后的首次查询重建）；
//   2. 正文不再随全表 JOIN 物化。旧实现为拿 top-N 把每个分块的 content 都读进内存
//      （万级 chunk 单次查询十几 MB 的临时大对象，且落在 Fastify 请求线程上），
//      现在只对最终 top-N 回表取正文。
// 一致性口径：缓存是否过期只认库内的 vec_gen 代号（见 getIndexDb 的触发器），本模块不自建脏标记。
// T04186 补算期增量：代号仍是唯一判据，只是「代号变了」之后的动作分两档——
// 本进程记得住是哪些页面改动过（savePageVectors/replacePageChunks/removePageIndex 的记账），
// 就只摘掉这些页面的槽位并按 rowid 追加其现存行；记不住（旁路裸 SQL、批量超过账本上限）
// 仍走原来的整目录重建。增量不是第二套失效判据，只是重建的等价快路径。
// 近似性：仍是精确余弦（不做 ANN 截断），与暴力扫描的结果逐条一致——T04069 验收要求
// top-10 重合率 ≥90%，实测为 100%（见 bench 用例）。
// 规模上界：缓存总量受 WIKI_VECTOR_CACHE_MAX_MB（默认 128MB）约束，超预算的这一次不缓存、
// 直接逐行扫（结果一致，只是每次重新反序列化）——宁可不快，也不把常驻内存推到无上限。

/** 一行向量记录（冷路径取数形状；正文不在这里取，见 attachChunkContents） */
interface VectorRow {
  page_path: string;
  chunk_index: number;
  vec: Buffer;
}

interface VectorCandidate {
  pagePath: string;
  chunkIndex: number;
  similarity: number;
}

/** 某 (model, dim) 口径下的向量矩阵：展平存储，点积落在连续内存上 */
interface VectorMatrix {
  dim: number;
  count: number;
  /** count × dim 行优先；是副本而非引用 SQLite 返回的 Buffer（不把整批 BLOB 挂在缓存上） */
  data: Float32Array;
  /** 各向量 L2 范数（建矩阵时算一次，查询时不再重复开方累加）。
   *  必须是 Float64：范数存成 Float32 会让商在小数第 8 位就与旧实现分岔——
   *  分数是排序键，容不得这一档精度损失（vector-recall-cache.test.ts 逐条比对能抓到）。 */
  norms: Float64Array;
  pagePaths: string[];
  chunkIndexes: Int32Array;
  bytes: number;
}

interface DirVectorCache {
  /** 建这批矩阵时的 vec_gen 代号 */
  gen: number;
  /** 该目录已缓存的向量字节数（用于总量记账） */
  bytes: number;
  /** key = `${model ?? ''}\0${dim}`：不同模型/不同维度是不可比的两套向量空间 */
  matrices: Map<string, VectorMatrix>;
  /** T04186：自 gen 之后本进程改动过向量的页面（集合即可，追加次序由 rowid 决定）。
   *  null = 账本已满、放弃增量，下一次代号变化直接整目录重建。 */
  pendingPages: Set<string> | null;
  /** 记账口径下这些改动应当把代号推进到的值（chunk_vecs 每行增删改由触发器推 1） */
  expectGen: number;
}

/** 单次增量同步的页面数上限：超过即放弃记账退回全量重建（补算期一次查几百页已足够，
 *  再大说明写入远快于查询，全量重建本来就是更省的做法） */
const MAX_PENDING_VEC_PAGES = 400;

const DEFAULT_VECTOR_CACHE_MB = 128;
const vectorCaches = new Map<string, DirVectorCache>();
let cachedVectorBytes = 0;
const vectorCacheCounters = { hits: 0, rebuilds: 0, oversizeScans: 0, incrementalPages: 0 };

function vectorCacheEnabled(): boolean {
  // 关掉缓存即可与改造前逐行对照（单改动 A/B 归因用），不改变结果只改变快慢
  return process.env.WIKI_VECTOR_CACHE !== '0';
}

function vectorCacheBudgetBytes(): number {
  const raw = process.env.WIKI_VECTOR_CACHE_MAX_MB;
  if (raw === undefined || raw === '') return DEFAULT_VECTOR_CACHE_MB * 1024 * 1024;
  const mb = Number(raw);
  return Number.isFinite(mb) && mb >= 0 ? Math.floor(mb) * 1024 * 1024 : DEFAULT_VECTOR_CACHE_MB * 1024 * 1024;
}

/** 丢弃某目录的向量缓存（代号变化 / 连接释放） */
function dropDirCache(dataDir: string): void {
  const dir = vectorCaches.get(dataDir);
  if (!dir) return;
  cachedVectorBytes -= dir.bytes;
  vectorCaches.delete(dataDir);
}

/** 清空全部向量缓存（closeIndexDb 与测试用） */
export function resetVectorCache(): void {
  vectorCaches.clear();
  cachedVectorBytes = 0;
  vectorCacheCounters.hits = 0;
  vectorCacheCounters.rebuilds = 0;
  vectorCacheCounters.oversizeScans = 0;
  vectorCacheCounters.incrementalPages = 0;
}

/** 向量缓存观测读数（诊断与性能用例用；不暴露到任何用户界面） */
export function getVectorCacheStats(): {
  dirs: number;
  matrices: number;
  vectors: number;
  bytes: number;
  budgetBytes: number;
  hits: number;
  rebuilds: number;
  oversizeScans: number;
  incrementalPages: number;
} {
  let matrices = 0;
  let vectors = 0;
  for (const dir of vectorCaches.values()) {
    matrices += dir.matrices.size;
    for (const m of dir.matrices.values()) vectors += m.count;
  }
  return {
    dirs: vectorCaches.size,
    matrices,
    vectors,
    bytes: cachedVectorBytes,
    budgetBytes: vectorCacheBudgetBytes(),
    hits: vectorCacheCounters.hits,
    rebuilds: vectorCacheCounters.rebuilds,
    oversizeScans: vectorCacheCounters.oversizeScans,
    // 增量同步消化掉的页面数（T04186：验收用例用它确认「快」来自增量而非重建）
    incrementalPages: vectorCacheCounters.incrementalPages,
  };
}

/** 读库内的向量变更代号（主键单行查询，微秒级）；表里没有行按 0 计 */
function readVecGen(d: SyncDb): number {
  const row = d.prepare('SELECT gen FROM vec_gen WHERE id = 1').get() as { gen: number | null } | undefined;
  return typeof row?.gen === 'number' ? row.gen : 0;
}

// ── T04186 补算期增量同步 ──────────────────────────────────────────────────
// 批量补算（懒索引边写边查、重建索引按钮）时每次写入都会把代号推高，改造前每一次紧跟的
// 查询都要整目录重建矩阵：本机实测 10400 条 × 256 维每轮 70.6ms，而纯热查询只要 5.0ms。
// 本进程知道自己改了哪些页面，就只摘那几个页面的槽位再追加它们现存的行——
// 结果与全量重建逐条一致（行序论证见 reshapeMatrix），成本从「反序列化全库」降到「搬一次内存」。

/** 写入侧记账：本模块的向量写函数在事务提交后登记「这页的向量变了、代号应推几格」。
 *  没有该目录缓存时不记（那种情况下下一次查询本来就是全量新建，账是多余的）。
 *  代号每行增删改推一格，与库内触发器同式；账对不上即说明存在旁路裸 SQL
 *  （重建索引的整表 DELETE、脚本里的裸 UPDATE），退回整目录重建——
 *  增量只是重建的等价快路径，不是第二套失效判据。 */
function noteVecPageMutation(dataDir: string, pagePath: string, vecRowsTouched: number): void {
  if (vecRowsTouched <= 0) return; // 没碰到向量行 → 代号一格没动（重切分但本页从未有向量）
  const dir = vectorCaches.get(dataDir);
  if (!dir || !dir.pendingPages) return;
  dir.expectGen += vecRowsTouched;
  dir.pendingPages.add(pagePath);
  if (dir.pendingPages.size > MAX_PENDING_VEC_PAGES) dir.pendingPages = null;
}

/** 待同步页面在库中现存的向量行（rid 定次序，model/dim 决定落到哪一份矩阵） */
interface PendingVecRow {
  rid: number;
  page_path: string;
  chunk_index: number;
  vec: Buffer;
  dim: number;
  model: string;
}

/** 取待同步页面现存的向量行：与全量扫描同一 JOIN 存活口径（正文缺席的向量不参与召回）、
 *  同一 rowid 行序；分批 IN 查询避开绑定参数上限。 */
function listPageVectorRows(d: SyncDb, pages: string[]): PendingVecRow[] {
  const out: PendingVecRow[] = [];
  for (let i = 0; i < pages.length; i += MAX_PENDING_VEC_PAGES) {
    const slice = pages.slice(i, i + MAX_PENDING_VEC_PAGES);
    const rows = (d
      .prepare(`
        SELECT v.rowid AS rid, v.page_path AS page_path, v.chunk_index AS chunk_index, v.vec AS vec, v.dim AS dim, v.model AS model
        FROM chunk_vecs v CROSS JOIN chunks c ON c.page_path = v.page_path AND c.chunk_index = v.chunk_index
        WHERE v.page_path IN (${slice.map(() => '?').join(', ')})
        ORDER BY v.rowid
      `)
      .all(...slice) as unknown as PendingVecRow[]);
    out.push(...rows);
  }
  out.sort((a, b) => a.rid - b.rid); // 分批各自有序，合并后全局再钉一次
  return out;
}

/** 冷路径取数 SQL：只取向量与定位键，不取正文。
 *  CROSS JOIN 是刻意写法——SQLite 对它的约定是「不得交换左右表」，
 *  配合 ORDER BY v.rowid 把行序钉死在 chunk_vecs 的插入序上：
 *  同分向量的先后次序由此决定，换计划就会换并列名次，结果不可复现。 */
function vectorScanSql(model?: string): string {
  const conditions = ['v.dim = ?'];
  if (model) conditions.push('v.model = ?');
  return `
    SELECT v.page_path AS page_path, v.chunk_index AS chunk_index, v.vec AS vec
    FROM chunk_vecs v CROSS JOIN chunks c ON c.page_path = v.page_path AND c.chunk_index = v.chunk_index
    WHERE ${conditions.join(' AND ')}
    ORDER BY v.rowid
  `;
}

function vectorScanParams(d2: Float32Array, model?: string): Array<string | number> {
  return model ? [d2.length, model] : [d2.length];
}

/** 单条向量的缓存占用（向量本体 float32 + 范数 float64 + 分块号 int32；页面路径字符串另计） */
function bytesPerVector(dim: number): number {
  return dim * 4 + 8 + 4;
}

/** 该口径下的向量行数（用于建矩阵前估算内存，不碰 BLOB） */
function countVectorsForRecall(d: SyncDb, model: string | undefined, dim: number): number {
  const conditions = ['v.dim = ?'];
  const params: Array<string | number> = [dim];
  if (model) {
    conditions.push('v.model = ?');
    params.push(model);
  }
  const row = d.prepare(
    `SELECT COUNT(*) AS n FROM chunk_vecs v CROSS JOIN chunks c ON c.page_path = v.page_path AND c.chunk_index = v.chunk_index WHERE ${conditions.join(' AND ')}`,
  ).get(...params) as { n: number };
  return row.n;
}

/** 稳定 top-K：相似度降序，同分保留先到者（即行序靠前者），与「全表打分 + 稳定排序」结果逐条一致。
 *  limit 未满时先收，满了才与末位比较——因此零分/负分候选在不足 K 条时照样返回（旧口径如此）。 */
function keepTopK(top: VectorCandidate[], cand: VectorCandidate, limit: number): void {
  if (top.length >= limit && !(cand.similarity > top[limit - 1].similarity)) return;
  if (top.length >= limit) top.length = limit - 1;
  let at = top.length;
  while (at > 0 && top[at - 1].similarity < cand.similarity) at--;
  top.splice(at, 0, cand);
}

/** 由向量行构建矩阵副本。长度与 dim 不符的 BLOB 视为脏数据跳过（旧实现会在建视图时抛
 *  RangeError，被 hybridSearch 的 catch 吞成「整条语义路静默关闭」——显式丢一行比丢一路好）。 */
function buildMatrix(rows: Iterable<VectorRow>, dim: number): VectorMatrix {
  const list = rows instanceof Array ? rows : [...rows];
  const count = list.length;
  const data = new Float32Array(count * dim);
  const norms = new Float64Array(count);
  const pagePaths: string[] = new Array(count);
  const chunkIndexes = new Int32Array(count);
  let filled = 0;
  for (const r of list) {
    if (r.vec.byteLength < dim * 4) continue;
    // Buffer 可能来自共享内存池（byteOffset 非 4 对齐），此时先复制再建视图
    const buf = r.vec.byteOffset % 4 === 0 ? r.vec : Buffer.from(r.vec);
    const src = new Float32Array(buf.buffer, buf.byteOffset, dim);
    const off = filled * dim;
    let sq = 0;
    for (let k = 0; k < dim; k++) {
      const v = src[k];
      data[off + k] = v;
      sq += v * v;
    }
    norms[filled] = Math.sqrt(sq);
    pagePaths[filled] = r.page_path;
    chunkIndexes[filled] = r.chunk_index;
    filled++;
  }
  return {
    dim,
    count: filled,
    data: filled === count ? data : data.subarray(0, filled * dim),
    norms: filled === count ? norms : norms.subarray(0, filled),
    pagePaths: pagePaths.slice(0, filled),
    chunkIndexes: filled === count ? chunkIndexes : chunkIndexes.subarray(0, filled),
    bytes: filled * bytesPerVector(dim),
  };
}

/** 摘掉待同步页面的槽位，再把它们现存的行追加到尾部。
 *  追加后的行序与「全表按 rowid 重扫」逐条一致：一页的向量每次写都是先整页删再插，
 *  故待同步页面的现存行必产自本次同步之后，rowid 单调递增即大于所有保留行的 rowid，
 *  而保留行彼此次序不变——「保留段原序 + 新行按 rowid 排在尾部」正是全表扫描的次序，
 *  同分并列名次（keepTopK 的先到先得）因而也与重建路径完全相同。
 *  这份性质还让增量幂等：中途新建的矩阵已含新行，再摘再贴结果不变。 */
function reshapeMatrix(m: VectorMatrix, droppedPages: Set<string>, adds: PendingVecRow[], dropped: number): VectorMatrix {
  const dim = m.dim;
  const allocated = m.count + adds.length;
  const data = new Float32Array(allocated * dim);
  const norms = new Float64Array(allocated);
  const pagePaths: string[] = new Array(allocated);
  const chunkIndexes = new Int32Array(allocated);
  let filled = 0;
  if (dropped === 0) {
    // 补算期的主流形态（纯新增）：整块搬运旧矩阵，不逐个比较页面名
    data.set(m.data, 0);
    norms.set(m.norms, 0);
    for (let i = 0; i < m.count; i++) {
      pagePaths[i] = m.pagePaths[i];
      chunkIndexes[i] = m.chunkIndexes[i];
    }
    filled = m.count;
  } else {
    for (let i = 0; i < m.count; i++) {
      if (droppedPages.has(m.pagePaths[i])) continue;
      data.set(m.data.subarray(i * dim, (i + 1) * dim), filled * dim);
      norms[filled] = m.norms[i];
      pagePaths[filled] = m.pagePaths[i];
      chunkIndexes[filled] = m.chunkIndexes[i];
      filled++;
    }
  }
  for (const r of adds) {
    if (r.vec.byteLength < dim * 4) continue; // 脏 BLOB：与 buildMatrix 同口径只丢这一行
    const buf = r.vec.byteOffset % 4 === 0 ? r.vec : Buffer.from(r.vec);
    const src = new Float32Array(buf.buffer, buf.byteOffset, dim);
    const off = filled * dim;
    let sq = 0;
    for (let k = 0; k < dim; k++) {
      const v = src[k];
      data[off + k] = v;
      sq += v * v;
    }
    norms[filled] = Math.sqrt(sq);
    pagePaths[filled] = r.page_path;
    chunkIndexes[filled] = r.chunk_index;
    filled++;
  }
  return {
    dim,
    count: filled,
    data: filled === allocated ? data : data.subarray(0, filled * dim),
    norms: filled === allocated ? norms : norms.subarray(0, filled),
    pagePaths: pagePaths.slice(0, filled),
    chunkIndexes: filled === allocated ? chunkIndexes : chunkIndexes.subarray(0, filled),
    bytes: filled * bytesPerVector(dim),
  };
}

/** 把记账到的页面改动应用到已缓存矩阵。返回 false = 增量做不了（账对不上 / 已弃账 / 会超内存预算），
 *  由调用方按原口径整目录重建。 */
function applyPendingVecOps(d: SyncDb, dir: DirVectorCache, gen: number): boolean {
  const pages = dir.pendingPages;
  if (!pages || dir.expectGen !== gen) return false;
  if (pages.size === 0) {
    dir.gen = gen;
    return true;
  }
  const rows = listPageVectorRows(d, [...pages]);
  // 先只算增量后的总占用：超预算就退回重建，内存上界（WIKI_VECTOR_CACHE_MAX_MB）不因增量而失守
  const plans: Array<{ key: string; matrix: VectorMatrix; dim: number; dropped: number; adds: PendingVecRow[] }> = [];
  let projectedDelta = 0;
  for (const [key, matrix] of dir.matrices) {
    const sep = key.indexOf('\u0000');
    const modelOfKey = key.slice(0, sep);
    const dim = Number(key.slice(sep + 1));
    let dropped = 0;
    for (let i = 0; i < matrix.count; i++) if (pages.has(matrix.pagePaths[i])) dropped++;
    // 空 model 段 = 「不传 model」的全量口径矩阵，任何模型的行都属于它；指定 model 的矩阵只收同模型的行
    const adds = rows.filter((r) => r.dim === dim && (modelOfKey === '' || r.model === modelOfKey));
    projectedDelta += (matrix.count - dropped + adds.length) * bytesPerVector(dim) - matrix.bytes;
    if (dropped > 0 || adds.length > 0) plans.push({ key, matrix, dim, dropped, adds });
  }
  if (cachedVectorBytes + projectedDelta > vectorCacheBudgetBytes()) return false;
  for (const p of plans) {
    const next = reshapeMatrix(p.matrix, pages, p.adds, p.dropped);
    dir.bytes += next.bytes - p.matrix.bytes;
    cachedVectorBytes += next.bytes - p.matrix.bytes;
    dir.matrices.set(p.key, next);
  }
  vectorCacheCounters.incrementalPages += pages.size;
  dir.gen = gen;
  dir.pendingPages = new Set();
  dir.expectGen = gen;
  return true;
}

/** 对已缓存矩阵做全量精确打分（O(count × dim)，无 SQL、无正文） */
function scoreMatrix(m: VectorMatrix, queryVec: Float32Array, limit: number): VectorCandidate[] {
  const top: VectorCandidate[] = [];
  const dim = m.dim;
  let qs = 0;
  for (let k = 0; k < dim; k++) qs += queryVec[k] * queryVec[k];
  const qNorm = Math.sqrt(qs);
  const data = m.data;
  const norms = m.norms;
  for (let i = 0; i < m.count; i++) {
    const off = i * dim;
    let dot = 0;
    for (let k = 0; k < dim; k++) dot += queryVec[k] * data[off + k];
    const vNorm = norms[i];
    const similarity = qNorm > 0 && vNorm > 0 ? dot / (qNorm * vNorm) : 0;
    keepTopK(top, { pagePath: m.pagePaths[i], chunkIndex: m.chunkIndexes[i], similarity }, limit);
  }
  return top;
}

/** 不缓存时的逐行打分（同一口径，只是每行现场建视图） */
function scoreRows(rows: Iterable<VectorRow>, queryVec: Float32Array, limit: number): VectorCandidate[] {
  const dim = queryVec.length;
  let qs = 0;
  for (let k = 0; k < dim; k++) qs += queryVec[k] * queryVec[k];
  const qNorm = Math.sqrt(qs);
  const top: VectorCandidate[] = [];
  for (const r of rows) {
    if (r.vec.byteLength < dim * 4) continue;
    const buf = r.vec.byteOffset % 4 === 0 ? r.vec : Buffer.from(r.vec);
    const v = new Float32Array(buf.buffer, buf.byteOffset, dim);
    let dot = 0;
    let vs = 0;
    for (let k = 0; k < dim; k++) {
      dot += queryVec[k] * v[k];
      vs += v[k] * v[k];
    }
    const vNorm = Math.sqrt(vs);
    const similarity = qNorm > 0 && vNorm > 0 ? dot / (qNorm * vNorm) : 0;
    keepTopK(top, { pagePath: r.page_path, chunkIndex: r.chunk_index, similarity }, limit);
  }
  return top;
}

/** 取 top-K 候选（走缓存或逐行扫，结果同构） */
function recallCandidates(
  d: SyncDb,
  dataDir: string,
  queryVec: Float32Array,
  limit: number,
  model?: string,
): VectorCandidate[] {
  const sql = vectorScanSql(model);
  const params = vectorScanParams(queryVec, model);
  if (!vectorCacheEnabled()) {
    return scoreRows(d.prepare(sql).iterate(...params) as unknown as Iterable<VectorRow>, queryVec, limit);
  }
  const gen = readVecGen(d);
  let dir = vectorCaches.get(dataDir);
  if (dir && dir.gen !== gen) {
    // T04186：先看本进程记得住账否——补算期只改过几页时增量同步即可；
    // 账对不上（旁路裸写、批量已弃账）仍整目录重建，不猜哪一份还新
    if (!applyPendingVecOps(d, dir, gen)) {
      dropDirCache(dataDir);
      dir = undefined;
    }
  }
  if (!dir) {
    dir = { gen, bytes: 0, matrices: new Map<string, VectorMatrix>(), pendingPages: new Set<string>(), expectGen: gen };
    vectorCaches.set(dataDir, dir);
  }
  const key = `${model ?? ''}\u0000${queryVec.length}`;
  const cached = dir.matrices.get(key);
  if (cached) {
    vectorCacheCounters.hits++;
    return scoreMatrix(cached, queryVec, limit);
  }
  // 先按行数估算内存再决定缓不缓存：超预算就不读矩阵，逐行扫过去打分（结果一致，只是每次都这样）
  const estimatedBytes = countVectorsForRecall(d, model, queryVec.length) * bytesPerVector(queryVec.length);
  if (cachedVectorBytes + estimatedBytes > vectorCacheBudgetBytes()) {
    vectorCacheCounters.oversizeScans++;
    return scoreRows(d.prepare(sql).iterate(...params) as unknown as Iterable<VectorRow>, queryVec, limit);
  }
  vectorCacheCounters.rebuilds++;
  const matrix = buildMatrix(d.prepare(sql).all(...params) as unknown as VectorRow[], queryVec.length);
  dir.matrices.set(key, matrix);
  dir.bytes += matrix.bytes;
  cachedVectorBytes += matrix.bytes;
  return scoreMatrix(matrix, queryVec, limit);
}

/** 只对 top-K 回表取正文（旧实现是全表 JOIN 出正文，这是每次查询最大的那块临时分配） */
function attachChunkContents(d: SyncDb, top: VectorCandidate[]): Array<ChunkRow & { similarity: number }> {
  const pages = [...new Set(top.map((t) => t.pagePath))];
  const byKey = new Map<string, { content: string; heading: string | null }>();
  // 分批取，避开 SQLite 绑定参数上限（调用方 limit 只有 20，这里是防御性上限）
  const BATCH = 400;
  for (let i = 0; i < pages.length; i += BATCH) {
    const slice = pages.slice(i, i + BATCH);
    const placeholders = slice.map(() => '?').join(', ');
    const rows = d.prepare(
      `SELECT page_path, chunk_index, content, heading FROM chunks WHERE page_path IN (${placeholders})`,
    ).all(...slice) as Array<{ page_path: string; chunk_index: number; content: string; heading: string | null }>;
    for (const r of rows) byKey.set(`${r.page_path}\u0000${r.chunk_index}`, { content: r.content, heading: r.heading });
  }
  const out: Array<ChunkRow & { similarity: number }> = [];
  for (const t of top) {
    const hit = byKey.get(`${t.pagePath}\u0000${t.chunkIndex}`);
    // 取不到正文说明 chunk 被外部删了而向量还留着（top-K 是与 chunks JOIN 后算的，正常不会发生）：
    // 与旧实现的 INNER JOIN 同口径——该条不出现在结果里
    if (!hit) continue;
    out.push({ pagePath: t.pagePath, chunkIndex: t.chunkIndex, content: hit.content, heading: hit.heading, similarity: t.similarity });
  }
  return out;
}

/** 索引状态统计（设置页展示：已索引/待补页面数） */
export function getIndexStatus(dataDir: string): IndexStatus {
  const d = getIndexDb(dataDir);
  const indexed = (d.prepare(`SELECT COUNT(*) AS n FROM index_status WHERE status = 'indexed'`).get() as { n: number }).n;
  const pending = (d.prepare(`SELECT COUNT(*) AS n FROM index_status WHERE status = 'pending'`).get() as { n: number }).n;
  const chunks = (d.prepare('SELECT COUNT(*) AS n FROM chunks').get() as { n: number }).n;
  return { indexedPages: indexed, pendingPages: pending, totalChunks: chunks };
}

/** 逐页索引状态（T04073 覆盖统计的数据源）：页面路径 → 状态与重试次数。
 *  只含 index_status 里有行的页面——「从未入索引」的页面在这里不存在，分母要由调用方按 vault 清单算。 */
export function listPageIndexStates(dataDir: string): Map<string, { status: string; attempts: number }> {
  const d = getIndexDb(dataDir);
  const rows = d.prepare('SELECT page_path, status, attempts FROM index_status').all() as Array<{ page_path: string; status: string; attempts: number }>;
  return new Map(rows.map((r) => [r.page_path, { status: r.status, attempts: r.attempts }]));
}

/** 模型过期页面清单（T04067）：chunk 已切分，但向量缺失或属于其它 embedding 模型。
 *  模型切换后这些页面的旧向量不可比——既不能参与召回，也要交给懒索引按新模型补算。
 *  判据按页聚合：只要有任一分块的向量不等于当前模型（含 LEFT JOIN 出的「无向量」NULL），该页即待补。 */
export function listStaleModelPages(dataDir: string, model: string): string[] {
  const d = getIndexDb(dataDir);
  const rows = d.prepare(`
    SELECT c.page_path AS page_path
    FROM chunks c
    LEFT JOIN chunk_vecs v ON v.page_path = c.page_path AND v.chunk_index = c.chunk_index
    GROUP BY c.page_path
    HAVING SUM(CASE WHEN v.model = ? THEN 1 ELSE 0 END) < COUNT(*)
    ORDER BY MIN(c.id)
  `).all(model) as Array<{ page_path: string }>;
  return rows.map((r) => r.page_path);
}

/** 全部待补/未索引页面清单（懒索引与重建的工作清单） */
export function listPendingPages(dataDir: string): string[] {
  const d = getIndexDb(dataDir);
  const rows = d.prepare(`SELECT page_path FROM index_status WHERE status = 'pending' OR attempts > 0`).all() as Array<{ page_path: string }>;
  return rows.map((r) => r.page_path);
}

/** 已建索引页面 → 最近写入时间（ms）。用于按文件 mtime 增量同步（O1） */
export function listIndexedPageTimes(dataDir: string): Map<string, number> {
  const d = getIndexDb(dataDir);
  const rows = d.prepare('SELECT page_path, updated_at FROM index_status').all() as Array<{ page_path: string; updated_at: string }>;
  const times = new Map<string, number>();
  for (const row of rows) {
    const ms = Date.parse(row.updated_at);
    times.set(row.page_path, Number.isFinite(ms) ? ms : 0);
  }
  return times;
}
