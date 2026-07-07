/**
 * 原子写 JSON 文件：temp + rename 模式
 *
 * 防止写入中途崩溃导致文件损坏（半写文件）。
 *
 * 背景：项目有 60+ 个 duanPath JSON 写入点，多数直接 `fs.writeFileSync(finalPath, ...)`,
 * 崩溃会产生半写文件，下次启动由 corruption-guard 重建为安全默认值（数据丢失）。
 * 本模块是"预防层"——写入时就用原子操作，从根源避免 corruption。
 *
 * 写入流程：
 *   1. 写入 temp 文件（同目录，${pid}.tmp 后缀，确保与 final 在同一文件系统）
 *   2. rename temp → final（POSIX 原子操作；Windows 上 rename 会覆盖目标文件）
 *   3. 失败时清理 temp 文件，抛出原错误
 *
 * 设计契约：
 *   - temp 文件用 ${pid}.tmp 后缀：同进程串行写入不会冲突；多进程并发写同一文件
 *     是上层职责（应加锁），本模块不处理
 *   - 不做 pre-write backup：corruption-guard 已在启动时兜底；运行时 backup 会让写入
 *     变 3 倍 I/O，对高频写入点（向量库/学习记录）不可接受
 *   - 接受 string 或 object：string 直接写（调用方已 stringify），object 自动 stringify
 */

import * as fs from 'fs';

/**
 * 原子写 JSON 文件（异步版）
 *
 * @param filePath 目标文件路径
 * @param data 数据（对象自动 JSON.stringify(data, null, 2)，string 直接写入）
 * @throws 写入或 rename 失败时抛出（temp 文件已清理）
 */
export async function atomicWriteJson(filePath: string, data: unknown): Promise<void> {
  const tmpPath = `${filePath}.${process.pid}.tmp`;
  const json = typeof data === 'string' ? data : JSON.stringify(data, null, 2);
  try {
    await fs.promises.writeFile(tmpPath, json, 'utf-8');
    await fs.promises.rename(tmpPath, filePath);
  } catch (e) {
    // 清理残留 temp 文件（不阻断原错误抛出）
    try {
      await fs.promises.unlink(tmpPath);
    } catch {
      // temp 文件可能不存在，忽略
    }
    throw e;
  }
}

/**
 * 原子写 JSON 文件（同步版）
 *
 * 用于同步上下文（如构造函数、启动初始化、persistXxx 同步方法）。
 * 异步上下文应优先使用 atomicWriteJson。
 *
 * @param filePath 目标文件路径
 * @param data 数据（对象自动 JSON.stringify(data, null, 2)，string 直接写入）
 * @throws 写入或 rename 失败时抛出（temp 文件已清理）
 */
export function atomicWriteJsonSync(filePath: string, data: unknown): void {
  const tmpPath = `${filePath}.${process.pid}.tmp`;
  const json = typeof data === 'string' ? data : JSON.stringify(data, null, 2);
  try {
    fs.writeFileSync(tmpPath, json, 'utf-8');
    fs.renameSync(tmpPath, filePath);
  } catch (e) {
    // 清理残留 temp 文件
    try {
      fs.unlinkSync(tmpPath);
    } catch {
      // temp 文件可能不存在，忽略
    }
    throw e;
  }
}
