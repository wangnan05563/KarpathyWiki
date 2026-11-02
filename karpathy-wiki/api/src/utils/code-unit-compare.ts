/**
 * 码序（UTF-16 code unit）比较：与 Array#sort() 的默认顺序完全等价，但写成显式比较器。
 *
 * 用在「排序结果参与哈希/缓存键」的地方：sort() 不带比较器会被 SonarQube S2871 判为
 * 不可靠排序，而 localeCompare 随运行环境语言设置变化——同一集合在不同机器上可能得出
 * 不同顺序，进而得出不同的幂等键/签名，让去重与缓存判定静默失效。码序比较是确定性的。
 */
export function compareCodeUnit(a: string, b: string): number {
  if (a < b) return -1;
  if (a > b) return 1;
  return 0;
}
