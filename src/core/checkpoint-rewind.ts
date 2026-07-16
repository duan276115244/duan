/**
 * Checkpoint/Rewind 系统 — CheckpointManager (Phase 2.4)
 *
 * 对标 Claude Code Checkpoints + Cursor Git Worktree：
 * - 自动保存文件状态快照
 * - 即时回滚（Esc+Esc 风格）
 * - 每个更改点自动创建 checkpoint
 */

import * as fs from 'fs';
import * as path from 'path';
import { createHash } from 'crypto';
import { logger } from './structured-logger.js';
import { EventBus } from './event-bus.js';
import { duanPath } from './duan-paths.js';

const WINDOWS_RESERVED_NAMES = new Set([
  'con', 'prn', 'aux', 'nul',
  'com1', 'com2', 'com3', 'com4', 'com5', 'com6', 'com7', 'com8', 'com9',
  'lpt1', 'lpt2', 'lpt3', 'lpt4', 'lpt5', 'lpt6', 'lpt7', 'lpt8', 'lpt9',
]);

function isReservedWindowsFile(filePath: string): boolean {
  const base = path.basename(filePath, path.extname(filePath)).toLowerCase();
  return WINDOWS_RESERVED_NAMES.has(base);
}

export interface Checkpoint {
  id: string;
  timestamp: number;
  label: string;
  files: Map<string, { content: string; hash: string }>;
  metadata?: Record<string, unknown>;
}

export class CheckpointManager {
  private checkpoints: Checkpoint[] = [];
  private currentIndex = -1;
  private maxCheckpoints = 50;
  private storageDir: string;
  // 性能优化：按内容哈希去重的共享内容池。相同 hash 的文件内容在内存中只保存一份，
  // 并通过引用计数在 checkpoint 被淘汰/截断时释放，显著降低大文件或频繁创建场景的内存占用。
  private contentPool = new Map<string, { content: string; refs: number }>();
  private log = logger.child({ module: 'CheckpointManager' });

  constructor(storageDir?: string) {
    // P0 跨平台修复：使用统一的 duanPath 解析（默认 ~/.duan，可用 DUAN_DATA_DIR 覆盖）
    this.storageDir = storageDir || duanPath('checkpoints');
    fs.mkdirSync(this.storageDir, { recursive: true });
    this.loadPersisted();
  }

  // 将内容写入共享池（去重）：相同 hash 复用同一字符串引用并增加引用计数
  private internContent(hash: string, content: string): string {
    const existing = this.contentPool.get(hash);
    if (existing) {
      existing.refs++;
      return existing.content;
    }
    this.contentPool.set(hash, { content, refs: 1 });
    return content;
  }

  // 释放某个 checkpoint 引用的内容：引用计数归零时从内存池移除
  private releaseCheckpointContent(cp: Checkpoint): void {
    for (const { hash } of cp.files.values()) {
      const entry = this.contentPool.get(hash);
      if (!entry) continue;
      if (--entry.refs <= 0) this.contentPool.delete(hash);
    }
  }

  async createCheckpoint(label: string, files: string[], metadata?: Record<string, unknown>): Promise<string> {
    const id = `ckpt_${Date.now().toString(36)}_${Math.random().toString(36).substr(2, 6)}`;
    const fileMap = new Map<string, { content: string; hash: string }>();

    const validFiles = files.filter(f => !isReservedWindowsFile(f));
    for (const filePath of validFiles) {
      try {
        if (await this.pathExists(filePath)) {
          const content = await fs.promises.readFile(filePath, 'utf-8');
          const hash = createHash('sha256').update(content).digest('hex').slice(0, 12);
          // 去重：相同 hash 的内容共享同一份内存，避免重复占用
          const shared = this.internContent(hash, content);
          fileMap.set(filePath, { content: shared, hash });
        }
      } catch (e) {
        console.warn('[CheckpointRewind] 读取文件失败:', e instanceof Error ? e.message : String(e));
      }
    }

    if (fileMap.size === 0) {
      this.log.warn('checkpoint created with no files', { label });
    }

    const cp: Checkpoint = { id, timestamp: Date.now(), label, files: fileMap, metadata };

    if (this.currentIndex < this.checkpoints.length - 1) {
      // 截断未来分支前，释放被丢弃 checkpoint 占用的共享内容
      for (const stale of this.checkpoints.slice(this.currentIndex + 1)) {
        this.releaseCheckpointContent(stale);
      }
      this.checkpoints = this.checkpoints.slice(0, this.currentIndex + 1);
    }

    this.checkpoints.push(cp);
    if (this.checkpoints.length > this.maxCheckpoints) {
      // 淘汰最旧 checkpoint 时同步释放其共享内容引用
      const removed = this.checkpoints.shift();
      if (removed) this.releaseCheckpointContent(removed);
    }
    this.currentIndex = this.checkpoints.length - 1;

    this.persistCheckpoint(cp);
    EventBus.getInstance().emitSync('checkpoint.created', { id, label, files: fileMap.size });

    return id;
  }

  async restore(id: string): Promise<boolean> {
    const cp = this.checkpoints.find(c => c.id === id);
    if (!cp) return false;

    try {
      // P0-3 深度优化: 原子写入 + 回滚验证（对标 Claude Code atomic file operations）
      //
      // 原子写入策略：先写入 .tmp 临时文件，验证内容哈希，再 rename 覆盖原文件
      // 确保写入过程中断不会损坏原文件
      const restoreResults: Array<{ filePath: string; success: boolean; verified: boolean }> = [];

      for (const [filePath, data] of cp.files) {
        try {
          // 确保目录存在

          await fs.promises.mkdir(path.dirname(filePath), { recursive: true });

          // Step 1: 写入临时文件
          const tmpPath = `${filePath}.ckpt_tmp_${Date.now()}`;
          await fs.promises.writeFile(tmpPath, data.content, 'utf-8');

          // Step 2: 验证临时文件内容哈希
          const writtenContent = await fs.promises.readFile(tmpPath, 'utf-8');
          const writtenHash = createHash('sha256').update(writtenContent).digest('hex').slice(0, 12);
          const verified = writtenHash === data.hash;

          if (!verified) {
            // 哈希不匹配 — 删除临时文件，跳过此文件
            this.log.error('checkpoint restore hash mismatch', { filePath, expected: data.hash, actual: writtenHash });
            try { await fs.promises.unlink(tmpPath); } catch {}
            restoreResults.push({ filePath, success: false, verified: false });
            continue;
          }

          // Step 3: 原子 rename 覆盖原文件
          await fs.promises.rename(tmpPath, filePath);
          restoreResults.push({ filePath, success: true, verified: true });
        } catch (fileErr: unknown) {
          this.log.error('checkpoint restore file failed', { filePath, error: (fileErr instanceof Error ? fileErr.message : String(fileErr)) });
          restoreResults.push({ filePath, success: false, verified: false });
        }
      }

      this.currentIndex = this.checkpoints.indexOf(cp);

      // P0-3 深度优化: 验证结果汇总
      const successCount = restoreResults.filter(r => r.success && r.verified).length;
      const failedCount = restoreResults.filter(r => !r.success || !r.verified).length;

      if (failedCount > 0) {
        this.log.warn('checkpoint restore partial failure', {
          id: cp.id,
          label: cp.label,
          successCount,
          failedCount,
          failedFiles: restoreResults.filter(r => !r.success).map(r => r.filePath),
        });
      }

      EventBus.getInstance().emitSync('checkpoint.restored', {
        id: cp.id,
        label: cp.label,
        filesRestored: successCount,
        filesFailed: failedCount,
        allVerified: failedCount === 0,
      });

      return failedCount === 0;
    } catch (err: unknown) {
      this.log.error('checkpoint restore failed', { id, error: (err instanceof Error ? err.message : String(err)) });
      return false;
    }
  }

  rewind(steps: number = 1): Promise<boolean> {
    if (this.currentIndex - steps < 0) return Promise.resolve(false);
    this.currentIndex -= steps;
    return Promise.resolve(this.restore(this.checkpoints[this.currentIndex].id));
  }

  fastForward(steps: number = 1): Promise<boolean> {
    if (this.currentIndex + steps >= this.checkpoints.length) return Promise.resolve(false);
    this.currentIndex += steps;
    return Promise.resolve(this.restore(this.checkpoints[this.currentIndex].id));
  }

  private persistCheckpoint(cp: Checkpoint): void {
    try {
      const data = {
        id: cp.id,
        timestamp: cp.timestamp,
        label: cp.label,
        files: [...cp.files].map(([filePath, data]) => ({ filePath, content: data.content, hash: data.hash })),
        metadata: cp.metadata,
      };
      // P0-3 深度优化: 原子写入 — 先写临时文件再 rename，防止写入中途崩溃导致检查点损坏
      const targetPath = path.join(this.storageDir, `${cp.id}.json`);
      const tmpPath = `${targetPath}.tmp_${Date.now()}`;
      fs.writeFileSync(tmpPath, JSON.stringify(data, null, 2), 'utf-8');
      // 验证临时文件可读后再 rename
      const written = fs.readFileSync(tmpPath, 'utf-8');
      JSON.parse(written); // 验证 JSON 完整性
      fs.renameSync(tmpPath, targetPath);
    } catch (err: unknown) {
      this.log.error('persistCheckpoint failed', { id: cp.id, error: (err instanceof Error ? err.message : String(err)) });
    }
  }

  private loadPersisted(): void {
    try {
      const files = fs.readdirSync(this.storageDir).filter(f => f.endsWith('.json'));
      for (const file of files.slice(-this.maxCheckpoints)) {
        try {
          const data = JSON.parse(fs.readFileSync(path.join(this.storageDir, file), 'utf-8'));
          const fileMap = new Map<string, { content: string; hash: string }>();
          for (const f of data.files || []) {
            fileMap.set(f.filePath, { content: f.content, hash: f.hash });
          }
          this.checkpoints.push({
            id: data.id, timestamp: data.timestamp, label: data.label, files: fileMap,
            metadata: data.metadata,
          });
        } catch (e) {
          console.warn('[CheckpointRewind] 加载检查点条目失败:', e instanceof Error ? e.message : String(e));
        }
      }
      if (this.checkpoints.length > 0) {
        this.checkpoints.sort((a, b) => a.timestamp - b.timestamp);
        this.currentIndex = this.checkpoints.length - 1;
      }
    } catch (e) {
      console.warn('[CheckpointRewind] 加载检查点目录失败:', e instanceof Error ? e.message : String(e));
    }
  }

  private async pathExists(filePath: string): Promise<boolean> {
    try {
      await fs.promises.access(filePath);
      return true;
    } catch {
      return false;
    }
  }

  getLatestCheckpoint(): Checkpoint | undefined {
    return this.checkpoints[this.currentIndex];
  }

  getHistory(): Array<{ id: string; label: string; timestamp: number; fileCount: number }> {
    return this.checkpoints.map(c => ({
      id: c.id, label: c.label, timestamp: c.timestamp, fileCount: c.files.size,
    }));
  }

  getCurrentIndex(): number { return this.currentIndex; }
  getTotalCheckpoints(): number { return this.checkpoints.length; }

  diff(id1: string, id2: string): Promise<string> {
    const cp1 = this.checkpoints.find(c => c.id === id1);
    const cp2 = this.checkpoints.find(c => c.id === id2);
    if (!cp1 || !cp2) return Promise.resolve('checkpoint not found');

    const lines: string[] = [];
    const allFiles = new Set([...cp1.files.keys(), ...cp2.files.keys()]);

    for (const filePath of allFiles) {
      const d1 = cp1.files.get(filePath);
      const d2 = cp2.files.get(filePath);
      if (d1?.hash !== d2?.hash) {
        lines.push(`📄 ${filePath}`);
        if (!d1) lines.push('  + file created');
        else if (!d2) lines.push('  - file deleted');
        else lines.push(`  changed: ${d1.hash} → ${d2.hash}`);
      }
    }

    return Promise.resolve(lines.join('\n') || 'no differences');
  }
}
