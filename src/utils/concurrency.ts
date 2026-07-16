/**
 * 并发控制工具
 * 用于限制 Promise.all 的并发数，防止资源耗尽（文件描述符、API 限流、内存等）
 */

/**
 * 对数组的每个元素异步执行 mapper，限制最大并发数。
 *
 * 与 `Promise.all(arr.map(async (...)))` 的区别：
 * - Promise.all 会同时启动所有异步操作，无并发上限
 * - mapWithConcurrency 最多同时运行 `limit` 个 mapper，新的在前面的完成后才启动
 *
 * @param items 输入数组
 * @param limit 最大并发数（≥1）
 * @param mapper 异步映射函数
 * @returns 结果数组（顺序与输入一致）
 *
 * @example
 * ```ts
 * // 最多同时下载 3 个文件
 * const results = await mapWithConcurrency(urls, 3, url => fetch(url).then(r => r.text()));
 * ```
 */
export async function mapWithConcurrency<T, R>(
  items: readonly T[],
  limit: number,
  mapper: (item: T, index: number) => Promise<R>,
): Promise<R[]> {
  if (limit < 1) limit = 1;
  const results: R[] = new Array(items.length);
  let cursor = 0;

  async function worker(): Promise<void> {
    while (cursor < items.length) {
      const index = cursor++;
      results[index] = await mapper(items[index], index);
    }
  }

  const workerCount = Math.min(limit, items.length);
  await Promise.all(Array.from({ length: workerCount }, () => worker()));
  return results;
}
