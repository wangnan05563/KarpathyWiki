// T04073：GET /api/search/status 的前端契约（单一来源）。
// 字段名与 api/src/search/hybrid-search.ts 的 IndexCoverage 逐字对应；
// api 与 frontend 的 tsconfig 各自只 include 自己的 src，跨服务字段错配编译器永远看不见
// （T02773 就是这么把「释放 X MB」吃掉半年的），所以改任一侧都要同步另一侧——有契约测试锁住字段名集合。
export interface SearchIndexStatus {
  /** 索引层是否可用（后端未注入数据目录时为 false，此时以下计数全为 0） */
  enabled: boolean;
  /** 已切分块数（关键词路规模） */
  totalChunks: number;
  /** 分母：vault 内可检索页面总数（取自页面清单，不是索引表行数） */
  totalPages: number;
  /** 向量覆盖：已算出向量且仍在库的页面数 */
  coveredPages: number;
  /** 已切分、向量待补的在库页面数 */
  pendingPages: number;
  /** pending 中至少失败过一次（多为 embedding 调用出错），用于分辨「坏了」与「没配模型」 */
  failedPages: number;
  /** 从未入索引（关键词检索也搜不到）的在库页面数 */
  unindexedPages: number;
  /** 向量缺失或属于其它 embedding 模型的在库页面数；后端未收到 model 查询参数时为 null */
  staleModelPages: number | null;
}

export const EMPTY_INDEX_STATUS: SearchIndexStatus = {
  enabled: false,
  totalChunks: 0,
  totalPages: 0,
  coveredPages: 0,
  pendingPages: 0,
  failedPages: 0,
  unindexedPages: 0,
  staleModelPages: null,
};
