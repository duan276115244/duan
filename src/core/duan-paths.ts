/**
 * P0 跨平台修复：统一的 .duan 数据目录解析
 *
 * 之前 30+ 处直接用 `process.cwd()/.duan`，4 处用 `os.homedir()/.duan`，
 * 导致从不同 CWD 启动会丢失记忆/会话/检查点（config 全局但 memory 按 CWD 隔离）。
 *
 * 现在统一通过此模块解析，默认 `os.homedir()/.duan`（全局状态），
 * 可通过 `DUAN_DATA_DIR` 环境变量覆盖（支持 per-project 隔离场景）。
 */

import * as os from 'os';
import * as path from 'path';

let cachedDataDir: string | null = null;

/**
 * 获取 .duan 数据根目录
 *
 * 优先级：
 * 1. `DUAN_DATA_DIR` 环境变量（支持 per-project 隔离）
 * 2. `os.homedir()/.duan`（默认全局状态）
 */
export function getDuanDataDir(): string {
  if (cachedDataDir) return cachedDataDir;
  const envDir = process.env.DUAN_DATA_DIR;
  cachedDataDir = envDir && envDir.trim().length > 0
    ? path.resolve(envDir)
    : path.join(os.homedir(), '.duan');
  return cachedDataDir;
}

/**
 * 在 .duan 数据目录下拼接子路径
 *
 * @param segments 子路径片段（如 'conversation-history.json' 或 'checkpoints', 'cp1.json'）
 */
export function duanPath(...segments: string[]): string {
  return path.join(getDuanDataDir(), ...segments);
}
