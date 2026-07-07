/**
 * Shadow Git Checkpoint System — 影子 Git 检查点系统
 *
 * 灵感来源: Codex CLI 的 Shadow Git 机制
 * 核心思想: 在任何文件修改前自动创建检查点，支持一键回滚
 *
 * 能力:
 * - createCheckpoint: 创建检查点（暂存文件 + 提交）
 * - restoreCheckpoint: 回滚到指定检查点
 * - listCheckpoints: 列出最近检查点
 * - diffCheckpoints: 比较两个检查点之间的差异
 * - getCurrentState: 获取当前 Git 状态
 * - getStats: 统计信息
 *
 * 通过 getToolDefinitions() 注册为 Agent Loop 可用工具
 */

import { execSync } from 'child_process';
import * as path from 'path';
import { logger } from './structured-logger.js';
import { EventBus } from './event-bus.js';

// ============ Windows 环境下显式指定 shell，避免打包 Electron 中 PATH 缺少 System32 ============
const SHELL_PATH = process.env.ComSpec || (process.platform === 'win32' ? 'C:\\Windows\\System32\\cmd.exe' : undefined);

/** 包装 execSync，自动注入 shell 选项 */
function gitExec(cmd: string, opts: { cwd?: string; encoding?: BufferEncoding; timeout?: number } = {}): string {
  return execSync(cmd, {
    cwd: opts.cwd,
    encoding: opts.encoding || 'utf-8',
    timeout: opts.timeout || 10000,
    ...(SHELL_PATH ? { shell: SHELL_PATH } : {}),
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
  } as any);
}

// ============ Windows 保留文件名 ============
const WINDOWS_RESERVED_NAMES = new Set([
  'con', 'prn', 'aux', 'nul',
  'com1', 'com2', 'com3', 'com4', 'com5', 'com6', 'com7', 'com8', 'com9',
  'lpt1', 'lpt2', 'lpt3', 'lpt4', 'lpt5', 'lpt6', 'lpt7', 'lpt8', 'lpt9',
]);

function isReservedWindowsFile(filePath: string): boolean {
  const base = path.basename(filePath, path.extname(filePath)).toLowerCase();
  return WINDOWS_RESERVED_NAMES.has(base);
}

// ============ 类型定义 ============

/** 检查点创建结果 */
export interface CheckpointResult {
  success: boolean;
  checkpointId: string;
  message: string;
  filesChanged: number;
  timestamp: number;
}

/** 检查点信息 */
export interface CheckpointInfo {
  id: string;
  hash: string;
  message: string;
  timestamp: number;
  filesChanged: number;
}

/** Git 状态 */
export interface GitState {
  branch: string;
  lastCommit: string;
  uncommittedChanges: number;
  isClean: boolean;
}

/** 统计信息 */
export interface ShadowGitStats {
  totalCheckpoints: number;
  totalRestores: number;
  totalFailedCheckpoints: number;
  totalFailedRestores: number;
  lastCheckpointTime: number | null;
  averageFilesPerCheckpoint: number;
}

// ============ ShadowGit 主类 ============

export class ShadowGit {
  private projectRoot: string;
  private gitAvailable: boolean = false;
  private initialized: boolean = false;
  private log = logger.child({ module: 'ShadowGit' });

  // 统计计数
  private totalCheckpoints = 0;
  private totalRestores = 0;
  private totalFailedCheckpoints = 0;
  private totalFailedRestores = 0;
  private lastCheckpointTime: number | null = null;
  private filesPerCheckpoint: number[] = [];

  constructor(projectRoot?: string) {
    this.projectRoot = projectRoot || process.cwd();
  }

  // ============ 初始化 ============

  /** 初始化 Git 环境，检测可用性 */
  private ensureInit(): boolean {
    if (this.initialized) return this.gitAvailable;
    this.initialized = true;

    // 检查 git 是否可用
    try {
      gitExec('git --version', { timeout: 5000 });
    } catch {
      this.log.warn('git 不可用，Shadow Git 检查点系统无法启动');
      return false;
    }

    // 检查或初始化 git 仓库
    try {
      gitExec('git rev-parse --git-dir', { cwd: this.projectRoot, timeout: 5000 });
      gitExec('git config core.autocrlf false', { cwd: this.projectRoot, timeout: 5000 });
      gitExec('git config core.safecrlf false', { cwd: this.projectRoot, timeout: 5000 });
      this.gitAvailable = true;
    } catch {
      try {
        gitExec('git init', { cwd: this.projectRoot, timeout: 10000 });
        gitExec('git config user.email "shadow@duan.local"', { cwd: this.projectRoot, timeout: 5000 });
        gitExec('git config user.name "Shadow Git"', { cwd: this.projectRoot, timeout: 5000 });
        gitExec('git config core.autocrlf false', { cwd: this.projectRoot, timeout: 5000 });
        gitExec('git config core.safecrlf false', { cwd: this.projectRoot, timeout: 5000 });
        this.gitAvailable = true;
        this.log.info('已自动初始化 git 仓库', { projectRoot: this.projectRoot });
      } catch {
        this.log.error('git 仓库初始化失败');
        return false;
      }
    }

    return this.gitAvailable;
  }

  // ============ 核心方法 ============

  /**
   * 创建检查点
   * 暂存指定文件（或全部变更文件）并提交
   */
  createCheckpoint(message: string, files?: string[]): CheckpointResult {
    if (!this.ensureInit()) {
      return {
        success: false,
        checkpointId: '',
        message: 'Git 不可用，无法创建检查点',
        filesChanged: 0,
        timestamp: Date.now(),
      };
    }

    const startTime = Date.now();

    try {
      // 暂存文件
      if (files && files.length > 0) {
        for (const file of files) {
          if (isReservedWindowsFile(file)) {
            this.log.debug('跳过 Windows 保留文件', { file });
            continue;
          }
          try {
            gitExec(`git add --ignore-errors "${file.replace(/"/g, '\\"')}"`, {
              cwd: this.projectRoot,
              timeout: 10000,
            });
          } catch (addErr: unknown) {
            this.log.warn('git add 失败，跳过文件', { file, error: (addErr instanceof Error ? addErr.message : String(addErr)) });
          }
        }
      } else {
        try {
          gitExec('git add -A --ignore-errors', { cwd: this.projectRoot, timeout: 10000 });
        } catch (addErr: unknown) {
          this.log.warn('git add -A 失败，尝试逐个文件暂存', { error: (addErr instanceof Error ? addErr.message : String(addErr)) });
          try {
            const status = gitExec('git status --porcelain', {
              cwd: this.projectRoot, timeout: 5000,
            }).trim();
            for (const line of status.split('\n').filter(Boolean)) {
              const file = line.substring(3).trim();
              if (file && !isReservedWindowsFile(file)) {
                try {
                  gitExec(`git add --ignore-errors "${file.replace(/"/g, '\\"')}"`, {
                    cwd: this.projectRoot, timeout: 10000,
                  });
                } catch { /* skip problematic files */ }
              }
            }
          } catch {
            this.log.warn('git status 失败，跳过暂存');
          }
        }
      }

      // 检查是否有变更需要提交
      const status = gitExec('git status --porcelain', {
        cwd: this.projectRoot,
        timeout: 5000,
      }).trim();

      if (!status) {
        return {
          success: false,
          checkpointId: '',
          message: '没有变更需要创建检查点',
          filesChanged: 0,
          timestamp: Date.now(),
        };
      }

      // 统计变更文件数
      const filesChanged = status.split('\n').filter(Boolean).length;

      // 提交
      const safeMessage = message.replace(/"/g, '\\"').replace(/`/g, '\\`');
      try {
        gitExec(`git commit -m "[checkpoint] ${safeMessage}"`, {
          cwd: this.projectRoot,
          timeout: 15000,
        });
      } catch (commitErr: unknown) {
        this.log.warn('git commit 失败，检查是否有实际变更', { error: (commitErr instanceof Error ? commitErr.message : String(commitErr)) });
        const recheck = gitExec('git status --porcelain', {
          cwd: this.projectRoot, timeout: 5000,
        }).trim();
        if (!recheck) {
          return {
            success: false,
            checkpointId: '',
            message: '没有变更需要创建检查点',
            filesChanged: 0,
            timestamp: Date.now(),
          };
        }
        throw commitErr;
      }

      // 获取提交哈希
      const hash = gitExec('git rev-parse HEAD', {
        cwd: this.projectRoot,
        timeout: 5000,
      }).trim();

      const shortHash = hash.substring(0, 12);
      const timestamp = Date.now();

      // 更新统计
      this.totalCheckpoints++;
      this.lastCheckpointTime = timestamp;
      this.filesPerCheckpoint.push(filesChanged);
      if (this.filesPerCheckpoint.length > 100) this.filesPerCheckpoint.shift();

      // 广播事件
      EventBus.getInstance().emitSync('shadow.checkpoint.created', {
        checkpointId: shortHash,
        message,
        filesChanged,
        timestamp,
        duration: Date.now() - startTime,
      }, { source: 'ShadowGit' });

      this.log.info('检查点已创建', { checkpointId: shortHash, message, filesChanged });

      return {
        success: true,
        checkpointId: shortHash,
        message,
        filesChanged,
        timestamp,
      };
    } catch (err: unknown) {
      this.totalFailedCheckpoints++;

      this.log.error('创建检查点失败', { message, error: (err instanceof Error ? err.message : String(err)) });

      EventBus.getInstance().emitSync('shadow.checkpoint.failed', {
        message,
        error: (err instanceof Error ? err.message : String(err)),
        timestamp: Date.now(),
      }, { source: 'ShadowGit' });

      return {
        success: false,
        checkpointId: '',
        message: `创建检查点失败: ${(err instanceof Error ? err.message : String(err))}`,
        filesChanged: 0,
        timestamp: Date.now(),
      };
    }
  }

  /**
   * 回滚到指定检查点
   */
  restoreCheckpoint(checkpointId: string): CheckpointResult {
    if (!this.ensureInit()) {
      return {
        success: false,
        checkpointId,
        message: 'Git 不可用，无法回滚',
        filesChanged: 0,
        timestamp: Date.now(),
      };
    }

    const startTime = Date.now();

    try {
      // 验证检查点是否存在
      gitExec(`git rev-parse ${checkpointId}`, {
        cwd: this.projectRoot,
        timeout: 5000,
      });
    } catch {
      this.totalFailedRestores++;
      this.log.warn('检查点不存在', { checkpointId });
      return {
        success: false,
        checkpointId,
        message: `检查点 ${checkpointId} 不存在`,
        filesChanged: 0,
        timestamp: Date.now(),
      };
    }

    try {
      // 获取回滚前的文件变更数
      let filesChanged = 0;
      try {
        const diffStat = gitExec(`git diff --stat ${checkpointId} HEAD`, {
          cwd: this.projectRoot,
          timeout: 10000,
        }).trim();
        if (diffStat) {
          const lines = diffStat.split('\n');
          const lastLine = lines[lines.length - 1];
          const match = lastLine.match(/(\d+) files? changed/);
          if (match) filesChanged = parseInt(match[1], 10);
        }
      } catch {
        // diff 可能失败（比如只有一个提交），忽略
      }

      // 执行回滚
      gitExec(`git checkout ${checkpointId} -- .`, {
        cwd: this.projectRoot,
        timeout: 15000,
      });

      // 更新统计
      this.totalRestores++;

      // 广播事件
      EventBus.getInstance().emitSync('shadow.checkpoint.restored', {
        checkpointId,
        filesChanged,
        timestamp: Date.now(),
        duration: Date.now() - startTime,
      }, { source: 'ShadowGit' });

      this.log.info('已回滚到检查点', { checkpointId, filesChanged });

      return {
        success: true,
        checkpointId,
        message: `已回滚到检查点 ${checkpointId}`,
        filesChanged,
        timestamp: Date.now(),
      };
    } catch (err: unknown) {
      this.totalFailedRestores++;

      this.log.error('回滚检查点失败', { checkpointId, error: (err instanceof Error ? err.message : String(err)) });

      EventBus.getInstance().emitSync('shadow.checkpoint.restore_failed', {
        checkpointId,
        error: (err instanceof Error ? err.message : String(err)),
        timestamp: Date.now(),
      }, { source: 'ShadowGit' });

      return {
        success: false,
        checkpointId,
        message: `回滚失败: ${(err instanceof Error ? err.message : String(err))}`,
        filesChanged: 0,
        timestamp: Date.now(),
      };
    }
  }

  /**
   * 列出最近的检查点
   */
  listCheckpoints(limit: number = 20): CheckpointInfo[] {
    if (!this.ensureInit()) return [];

    try {
      // 获取检查点提交日志（只看 [checkpoint] 前缀的提交）
      const logFormat = '%H%n%s%n%ct%n---END---';
      const rawLog = gitExec(
        `git log --grep="\\[checkpoint\\]" --format="${logFormat}" -n ${Math.min(limit * 3, 200)}`,
        { cwd: this.projectRoot, timeout: 10000 },
      ).trim();

      if (!rawLog) return [];

      const entries = rawLog.split('---END---').filter(Boolean);
      const checkpoints: CheckpointInfo[] = [];

      for (const entry of entries) {
        const lines = entry.trim().split('\n');
        if (lines.length < 3) continue;

        const hash = lines[0].trim();
        const message = lines[1].trim().replace(/^\[checkpoint\]\s*/, '');
        const timestamp = parseInt(lines[2].trim(), 10) * 1000;

        // 获取变更文件数
        let filesChanged = 0;
        try {
          const stat = gitExec(`git diff --stat ${hash}~1..${hash}`, {
            cwd: this.projectRoot,
            timeout: 5000,
          }).trim();
          const match = stat.split('\n').pop()?.match(/(\d+) files? changed/);
          if (match) filesChanged = parseInt(match[1], 10);
        } catch {
          // 可能是初始提交，无法 diff
        }

        checkpoints.push({
          id: hash.substring(0, 12),
          hash,
          message,
          timestamp,
          filesChanged,
        });

        if (checkpoints.length >= limit) break;
      }

      return checkpoints;
    } catch {
      this.log.warn('获取检查点列表失败');
      return [];
    }
  }

  /**
   * 比较两个检查点之间的差异
   */
  diffCheckpoints(fromId: string, toId: string): string {
    if (!this.ensureInit()) return 'Git 不可用，无法比较差异';

    try {
      // 验证两个检查点是否存在
      gitExec(`git rev-parse ${fromId}`, { cwd: this.projectRoot, timeout: 5000 });
      gitExec(`git rev-parse ${toId}`, { cwd: this.projectRoot, timeout: 5000 });
    } catch (err: unknown) {
      return `无效的检查点 ID: ${(err instanceof Error ? err.message : String(err))}`;
    }

    try {
      // 获取统计信息
      const statOutput = gitExec(`git diff --stat ${fromId}..${toId}`, {
        cwd: this.projectRoot,
        timeout: 15000,
      }).trim();

      // 获取差异内容
      const diffOutput = gitExec(`git diff ${fromId}..${toId}`, {
        cwd: this.projectRoot,
        timeout: 15000,
      }).trim();

      // 截断过长的差异输出
      const truncated = diffOutput.length > 5000
        ? diffOutput.substring(0, 5000) + '\n\n...(差异过长，已截断)'
        : diffOutput;

      let result = `📊 差异统计 (${fromId} → ${toId})\n\n`;
      result += statOutput;
      result += '\n\n📝 详细差异:\n\n';
      result += truncated;

      return result;
    } catch (err: unknown) {
      return `获取差异失败: ${(err instanceof Error ? err.message : String(err))}`;
    }
  }

  /**
   * 获取当前 Git 状态
   */
  getCurrentState(): GitState {
    if (!this.ensureInit()) {
      return {
        branch: '(不可用)',
        lastCommit: '(不可用)',
        uncommittedChanges: 0,
        isClean: false,
      };
    }

    try {
      const branch = gitExec('git rev-parse --abbrev-ref HEAD', {
        cwd: this.projectRoot,
        timeout: 5000,
      }).trim();

      const lastCommit = gitExec('git log -1 --format="%h %s"', {
        cwd: this.projectRoot,
        timeout: 5000,
      }).trim();

      const status = gitExec('git status --porcelain', {
        cwd: this.projectRoot,
        timeout: 5000,
      }).trim();

      const uncommittedChanges = status ? status.split('\n').filter(Boolean).length : 0;

      return {
        branch,
        lastCommit,
        uncommittedChanges,
        isClean: uncommittedChanges === 0,
      };
    } catch {
      return {
        branch: '(获取失败)',
        lastCommit: '(获取失败)',
        uncommittedChanges: -1,
        isClean: false,
      };
    }
  }

  /**
   * 获取统计信息
   */
  getStats(): ShadowGitStats {
    const avgFiles = this.filesPerCheckpoint.length > 0
      ? this.filesPerCheckpoint.reduce((a, b) => a + b, 0) / this.filesPerCheckpoint.length
      : 0;

    return {
      totalCheckpoints: this.totalCheckpoints,
      totalRestores: this.totalRestores,
      totalFailedCheckpoints: this.totalFailedCheckpoints,
      totalFailedRestores: this.totalFailedRestores,
      lastCheckpointTime: this.lastCheckpointTime,
      averageFilesPerCheckpoint: Math.round(avgFiles * 10) / 10,
    };
  }

  // ============ Agent Loop 工具定义 ============

  /**
   * 返回 Agent Loop 可用的工具定义
   */
  getToolDefinitions(): Array<{
    name: string;
    description: string;
    parameters: Record<string, { type: string; description: string; required?: boolean }>;
    readOnly?: boolean;
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    execute: (args: any) => Promise<string>;
  }> {
    // eslint-disable-next-line @typescript-eslint/no-this-alias
    const self = this;

    return [
      {
        name: 'checkpoint_create',
        description: '创建 Shadow Git 检查点。在执行文件修改操作前自动创建，支持后续回滚。可指定需要暂存的文件列表，不指定则暂存所有变更。',
        parameters: {
          message: { type: 'string', description: '检查点描述信息，说明创建原因', required: true },
          files: { type: 'array', description: '需要暂存的文件路径列表（可选，不提供则暂存所有变更）', required: false },
        },
        execute: (args) => {
          const result = self.createCheckpoint(
            args.message as string,
            args.files as string[] | undefined,
          );
          if (!result.success) return Promise.resolve(`❌ ${result.message}`);
          return Promise.resolve(`✅ 检查点已创建\n  ID: ${result.checkpointId}\n  描述: ${result.message}\n  变更文件: ${result.filesChanged}\n  时间: ${new Date(result.timestamp).toLocaleString('zh-CN')}`);
        },
      },
      {
        name: 'checkpoint_restore',
        description: '回滚到指定的 Shadow Git 检查点。将工作区文件恢复到该检查点时的状态。注意：此操作会丢弃检查点之后的所有文件修改。',
        parameters: {
          checkpoint_id: { type: 'string', description: '要回滚到的检查点 ID（短哈希）', required: true },
        },
        execute: (args) => {
          const result = self.restoreCheckpoint(args.checkpoint_id as string);
          if (!result.success) return Promise.resolve(`❌ ${result.message}`);
          return Promise.resolve(`✅ 已回滚到检查点 ${result.checkpointId}\n  变更文件: ${result.filesChanged}`);
        },
      },
      {
        name: 'checkpoint_list',
        description: '列出最近的 Shadow Git 检查点。显示检查点 ID、描述、时间和变更文件数。',
        parameters: {
          limit: { type: 'number', description: '返回的最大检查点数量（默认 20）', required: false },
        },
        readOnly: true,
        execute: (args) => {
          const limit = (args.limit as number) || 20;
          const checkpoints = self.listCheckpoints(limit);
          if (checkpoints.length === 0) return Promise.resolve('📋 暂无检查点记录');

          let output = `📋 最近 ${checkpoints.length} 个检查点:\n\n`;
          for (const cp of checkpoints) {
            const time = new Date(cp.timestamp).toLocaleString('zh-CN');
            output += `  🔖 ${cp.id} | ${time}\n`;
            output += `     ${cp.message} (${cp.filesChanged} 个文件变更)\n\n`;
          }
          return Promise.resolve(output.trimEnd());
        },
      },
      {
        name: 'checkpoint_diff',
        description: '比较两个 Shadow Git 检查点之间的差异。显示文件变更统计和详细 diff 内容。',
        parameters: {
          from_id: { type: 'string', description: '起始检查点 ID', required: true },
          to_id: { type: 'string', description: '目标检查点 ID', required: true },
        },
        readOnly: true,
        execute: (args) => {
          return Promise.resolve(self.diffCheckpoints(args.from_id as string, args.to_id as string));
        },
      },
    ];
  }
}

// ============ 单例管理 ============

let _instance: ShadowGit | null = null;

/** 获取 ShadowGit 单例 */
export function getShadowGit(): ShadowGit {
  if (!_instance) {
    _instance = new ShadowGit();
  }
  return _instance;
}

/** 设置 ShadowGit 单例（用于测试或自定义配置） */
export function setShadowGit(instance: ShadowGit): void {
  _instance = instance;
}
