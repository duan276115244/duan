/**
 * Checkpoint 单例 — 全局文件 Checkpoint 管理器
 *
 * P0-3: 集成到文件修改工具，实现文件修改前自动创建 Checkpoint
 * 对标 Claude Code 的文件 Checkpoint 回滚机制
 */

import { CheckpointManager } from './checkpoint-rewind.js';
import { logger } from './structured-logger.js';
import { duanPath } from './duan-paths.js';

let globalCheckpointManager: CheckpointManager | null = null;

/**
 * 获取全局 CheckpointManager 单例
 */
export function getCheckpointManager(): CheckpointManager {
  if (!globalCheckpointManager) {
    // P0 跨平台修复：使用统一的 duanPath 解析（默认 ~/.duan，可用 DUAN_DATA_DIR 覆盖）
    const storageDir = duanPath('checkpoints');
    globalCheckpointManager = new CheckpointManager(storageDir);
    logger.info('[Checkpoint] 全局 CheckpointManager 已初始化', { storageDir });
  }
  return globalCheckpointManager;
}

/**
 * P0-3: 在文件修改前自动创建 Checkpoint
 *
 * @param files 即将修改的文件列表
 * @param label 操作标签
 * @returns checkpoint ID，失败时返回 null
 */
export async function createCheckpointBeforeModify(
  files: string[],
  label: string,
): Promise<string | null> {
  try {
    const manager = getCheckpointManager();
    const validFiles = files.filter(f => {
      try {
        return !!f && typeof f === 'string';
      } catch {
        return false;
      }
    });
    if (validFiles.length === 0) return null;

    const checkpointId = await manager.createCheckpoint(label, validFiles, {
      source: 'auto-before-modify',
      timestamp: Date.now(),
    });
    logger.debug('[Checkpoint] 已创建 Checkpoint', {
      id: checkpointId,
      label,
      fileCount: validFiles.length,
    });
    return checkpointId;
  } catch (err: unknown) {
    // Checkpoint 创建失败不应阻止文件修改
    logger.warn('[Checkpoint] 创建 Checkpoint 失败', { error: (err instanceof Error ? err.message : String(err)), label });
    return null;
  }
}

/**
 * P0-3: 回滚到指定 Checkpoint
 *
 * @param checkpointId Checkpoint ID
 * @returns 是否成功
 */
export async function rewindToCheckpoint(checkpointId: string): Promise<boolean> {
  try {
    const manager = getCheckpointManager();
    const success = await manager.restore(checkpointId);
    if (success) {
      logger.info('[Checkpoint] 已回滚到 Checkpoint', { id: checkpointId });
    } else {
      logger.warn('[Checkpoint] 回滚失败 — Checkpoint 不存在', { id: checkpointId });
    }
    return success;
  } catch (err: unknown) {
    logger.error('[Checkpoint] 回滚异常', { id: checkpointId, error: (err instanceof Error ? err.message : String(err)) });
    return false;
  }
}

/**
 * P0-3: 回滚指定步数
 *
 * @param steps 回滚步数（默认 1）
 * @returns 是否成功
 */
export async function rewindSteps(steps: number = 1): Promise<boolean> {
  try {
    const manager = getCheckpointManager();
    const success = await manager.rewind(steps);
    if (success) {
      logger.info('[Checkpoint] 已回滚', { steps });
    }
    return success;
  } catch (err: unknown) {
    logger.error('[Checkpoint] 回滚异常', { steps, error: (err instanceof Error ? err.message : String(err)) });
    return false;
  }
}

/**
 * 获取 Checkpoint 历史
 */
export function getCheckpointHistory() {
  return getCheckpointManager().getHistory();
}

/**
 * 获取最新 Checkpoint
 */
export function getLatestCheckpoint() {
  return getCheckpointManager().getLatestCheckpoint();
}
