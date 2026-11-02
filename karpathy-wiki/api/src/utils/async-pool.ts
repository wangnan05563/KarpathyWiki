// 全库扫描类任务的并发与让出工具。
// 为什么需要：
// 1) 逐文件串行 await 会让一次扫描占据事件循环数秒（B2/B3），并发池把 I/O 等待重叠起来；
// 2) CPU 段（YAML/正则解析）即使并发也无法并行，仍需周期性让出事件循环，
//    否则搜索等接口的 max 会出现 9–16 s 的队头阻塞（B4）。
export const DEFAULT_SCAN_CONCURRENCY = 8;
// 每处理多少个文件让出一次事件循环：太小会拖慢扫描，太大会重新出现秒级阻塞
const YIELD_EVERY = 16;

/** 让出事件循环一轮，使在途 HTTP 请求有机会被处理 */
export function yieldToEventLoop(): Promise<void> {
  return new Promise((resolve) => setImmediate(resolve));
}

/**
 * 有界并发 map：保持结果顺序与输入一致，任意一项失败由调用方在 fn 内处理。
 * 每完成一批（YIELD_EVERY 项）让出一次事件循环，避免长任务独占。
 */
export async function mapWithConcurrency<T, R>(
  items: readonly T[],
  concurrency: number,
  fn: (item: T, index: number) => Promise<R>,
): Promise<R[]> {
  const results = new Array<R>(items.length);
  const limit = Math.max(1, Math.min(concurrency, items.length || 1));
  let next = 0;
  let sinceYield = 0;
  const worker = async (): Promise<void> => {
    while (true) {
      const index = next++;
      if (index >= items.length) return;
      results[index] = await fn(items[index], index);
      sinceYield++;
      if (sinceYield >= YIELD_EVERY) {
        sinceYield = 0;
        await yieldToEventLoop();
      }
    }
  };
  await Promise.all(Array.from({ length: limit }, () => worker()));
  return results;
}
