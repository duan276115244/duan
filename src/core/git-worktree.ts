/**
 * Git Worktree 隔离模块 — GitWorktreeManager
 *
 * 为"段先生"自主 AI Agent 系统提供 Git Worktree 级别的并行开发隔离：
 * - 并行任务各自在独立 worktree 中工作，互不干扰
 * - 支持创建、删除、列出、执行命令、合并、差异查看、同步等操作
 * - 自动清理超过 7 天的过期 worktree
 * - 通过 EventBus 广播 worktree 生命周期事件
 * - 通过 getToolDefinitions() 注册为 Agent Loop 可用工具
 */

import { execSync } from 'child_process';
import * as fs from 'fs';
import * as path from 'path';
import { logger } from './structured-logger.js';
import { EventBus } from './event-bus.js';
import { atomicWriteJsonSync } from './atomic-write.js';

// ============ 类型定义 ============

export interface WorktreeInfo {
  /** worktree 名称 */
  name: string;
  /** worktree 绝对路径 */
  path: string;
  /** worktree 对应的分支名 */
  branch: string;
  /** 基于哪个分支创建 */
  baseBranch: string;
  /** 当前状态 */
  status: 'active' | 'merged' | 'conflict' | 'stale';
  /** 创建时间戳 */
  createdAt: number;
  /** 最后活动时间戳 */
  lastActivity: number;
  /** 关联的任务描述 */
  taskDescription?: string;
}

export interface WorktreeResult {
  success: boolean;
  worktree?: WorktreeInfo;
  output?: string;
  error?: string;
}

export interface MergeResult {
  success: boolean;
  conflicts: string[];
  mergedFiles: string[];
  strategy: string;
  output: string;
}

// ============ 主类 ============

export class GitWorktreeManager {
  private repoRoot: string;
  private stateFile: string;
  private worktrees: Map<string, WorktreeInfo> = new Map();
  private gitAvailable: boolean = false;
  private initialized: boolean = false;
  private log = logger.child({ module: 'GitWorktree' });

  /** 过期阈值：7 天（毫秒） */
  private static readonly STALE_THRESHOLD_MS = 7 * 24 * 60 * 60 * 1000;

  constructor(repoRoot?: string) {
    this.repoRoot = repoRoot || this.findRepoRoot();
    this.stateFile = path.join(this.repoRoot, '.duan', 'worktrees.json');
  }

  // ============ 初始化 ============

  /** 初始化：检测 git 可用性并加载持久化状态 */
  init(): boolean {
    if (this.initialized) return this.gitAvailable;
    this.initialized = true;

    // 检测 git 是否可用
    try {
      execSync('git --version', { encoding: 'utf-8', timeout: 5000, stdio: ['ignore', 'pipe', 'ignore'] });
    } catch {
      this.log.warn('git 命令不可用，worktree 功能将受限');
      this.gitAvailable = false;
      return false;
    }

    // 检测是否在 git 仓库内
    try {
      execSync('git rev-parse --git-dir', { cwd: this.repoRoot, encoding: 'utf-8', timeout: 5000, stdio: ['ignore', 'pipe', 'ignore'] });
      this.gitAvailable = true;
    } catch {
      this.log.warn('当前目录不是 git 仓库，worktree 功能将受限');
      this.gitAvailable = false;
      return false;
    }

    // 加载持久化状态
    this.loadState();

    // 自动清理过期 worktree
    this.cleanupStale();

    return true;
  }

  /** 自动探测 git 仓库根目录 */
  private findRepoRoot(): string {
    try {
      return execSync('git rev-parse --show-toplevel', {
        encoding: 'utf-8',
        stdio: ['ignore', 'pipe', 'ignore'],
        timeout: 5000,
      }).trim();
    } catch {
      return process.cwd();
    }
  }

  /** 检查 git 是否可用，不可用时返回统一错误信息 */
  private ensureGit(): string | null {
    if (!this.gitAvailable) {
      return 'Git 不可用：请确保已安装 git 且当前目录位于 git 仓库中';
    }
    return null;
  }

  // ============ 状态持久化 ============

  /** 从 .duan/worktrees.json 加载 worktree 状态 */
  private loadState(): void {
    try {
      if (fs.existsSync(this.stateFile)) {
        const data = JSON.parse(fs.readFileSync(this.stateFile, 'utf-8'));
        if (Array.isArray(data)) {
          for (const item of data) {
            this.worktrees.set(item.name, item as WorktreeInfo);
          }
        }
      }
    } catch (err: unknown) {
      this.log.warn('加载 worktree 状态文件失败', { error: (err instanceof Error ? err.message : String(err)) });
      this.worktrees.clear();
    }
  }

  /** 将 worktree 状态持久化到 .duan/worktrees.json */
  private saveState(): void {
    try {
      const dir = path.dirname(this.stateFile);
      if (!fs.existsSync(dir)) {
        fs.mkdirSync(dir, { recursive: true });
      }
      const data = [...this.worktrees.values()];
      atomicWriteJsonSync(this.stateFile, data);
    } catch (err: unknown) {
      this.log.error('保存 worktree 状态文件失败', { error: (err instanceof Error ? err.message : String(err)) });
    }
  }

  // ============ 核心操作 ============

  /**
   * 创建新的 git worktree
   * @param name worktree 名称
   * @param branch 可选分支名，未提供则自动生成
   * @param taskDescription 可选任务描述
   */
  createWorktree(name: string, branch?: string, taskDescription?: string): WorktreeResult {
    if (!this.init()) {
      return { success: false, error: this.ensureGit()! };
    }

    // 检查名称是否已存在
    if (this.worktrees.has(name)) {
      return { success: false, error: `worktree "${name}" 已存在` };
    }

    // 自动生成分支名
    const branchName = branch || `duan/task-${Date.now()}`;
    const worktreePath = path.join(this.repoRoot, '.duan', 'worktrees', name);

    try {
      // 确保工作目录存在
      const worktreeParent = path.dirname(worktreePath);
      if (!fs.existsSync(worktreeParent)) {
        fs.mkdirSync(worktreeParent, { recursive: true });
      }

      // 获取当前分支作为 base
      let baseBranch: string;
      try {
        baseBranch = execSync('git rev-parse --abbrev-ref HEAD', {
          cwd: this.repoRoot, encoding: 'utf-8', timeout: 5000,
        }).trim();
      } catch {
        baseBranch = 'main';
      }

      // 创建分支（基于当前 HEAD）
      execSync(`git branch "${branchName}"`, {
        cwd: this.repoRoot, encoding: 'utf-8', timeout: 10000, stdio: ['ignore', 'pipe', 'ignore'],
      });

      // 创建 worktree
      execSync(`git worktree add "${worktreePath}" "${branchName}"`, {
        cwd: this.repoRoot, encoding: 'utf-8', timeout: 30000,
      });

      const now = Date.now();
      const info: WorktreeInfo = {
        name,
        path: worktreePath,
        branch: branchName,
        baseBranch,
        status: 'active',
        createdAt: now,
        lastActivity: now,
        taskDescription,
      };

      this.worktrees.set(name, info);
      this.saveState();

      this.log.info('worktree 已创建', { name, branch: branchName, path: worktreePath });
      EventBus.getInstance().emitSync('git.worktree_created', {
        name, branch: branchName, path: worktreePath, baseBranch,
      }, { source: 'GitWorktree' });

      return {
        success: true,
        worktree: info,
        output: `✅ worktree "${name}" 已创建\n  路径: ${worktreePath}\n  分支: ${branchName}\n  基于: ${baseBranch}`,
      };
    } catch (err: unknown) {
      this.log.error('创建 worktree 失败', { name, error: (err instanceof Error ? err.message : String(err)) });
      return { success: false, error: `创建 worktree 失败: ${(err instanceof Error ? err.message : String(err))}` };
    }
  }

  /**
   * 移除 git worktree
   * @param name worktree 名称
   * @param deleteBranch 是否同时删除关联分支，默认 true
   */
  removeWorktree(name: string, deleteBranch: boolean = true): WorktreeResult {
    if (!this.init()) {
      return { success: false, error: this.ensureGit()! };
    }

    const info = this.worktrees.get(name);
    if (!info) {
      return { success: false, error: `worktree "${name}" 不存在` };
    }

    try {
      // 先尝试 git worktree remove
      try {
        execSync(`git worktree remove "${info.path}" --force`, {
          cwd: this.repoRoot, encoding: 'utf-8', timeout: 15000, stdio: ['ignore', 'pipe', 'ignore'],
        });
      } catch {
        // git worktree remove 失败时，手动清理目录
        try {
          execSync(`git worktree prune`, {
            cwd: this.repoRoot, encoding: 'utf-8', timeout: 10000, stdio: ['ignore', 'pipe', 'ignore'],
          });
        } catch { /* ignore */ }

        if (fs.existsSync(info.path)) {
          fs.rmSync(info.path, { recursive: true, force: true });
        }
      }

      // 删除关联分支
      if (deleteBranch) {
        try {
          execSync(`git branch -D "${info.branch}"`, {
            cwd: this.repoRoot, encoding: 'utf-8', timeout: 10000, stdio: ['ignore', 'pipe', 'ignore'],
          });
        } catch { /* 分支可能已被删除 */ }
      }

      this.worktrees.delete(name);
      this.saveState();

      this.log.info('worktree 已移除', { name, branch: info.branch, deleteBranch });
      EventBus.getInstance().emitSync('git.worktree_removed', {
        name, branch: info.branch,
      }, { source: 'GitWorktree' });

      return {
        success: true,
        output: `✅ worktree "${name}" 已移除${deleteBranch ? `（分支 ${info.branch} 已删除）` : `（分支 ${info.branch} 保留）`}`,
      };
    } catch (err: unknown) {
      this.log.error('移除 worktree 失败', { name, error: (err instanceof Error ? err.message : String(err)) });
      return { success: false, error: `移除 worktree 失败: ${(err instanceof Error ? err.message : String(err))}` };
    }
  }

  /**
   * 列出所有受管理的 worktree
   */
  listWorktrees(): WorktreeResult {
    if (!this.init()) {
      return { success: false, error: this.ensureGit()! };
    }

    if (this.worktrees.size === 0) {
      return { success: true, output: '📭 当前没有受管理的 worktree' };
    }

    const lines: string[] = ['📋 受管理的 Worktree 列表：'];
    let idx = 1;
    for (const info of this.worktrees.values()) {
      const statusIcon = { active: '🟢', merged: '✅', conflict: '⚠️', stale: '🔴' }[info.status] || '❓';
      const age = this.formatDuration(Date.now() - info.createdAt);
      lines.push(`  ${idx}. ${statusIcon} ${info.name}`);
      lines.push(`     路径: ${info.path}`);
      lines.push(`     分支: ${info.branch} (基于 ${info.baseBranch})`);
      lines.push(`     状态: ${info.status} | 创建于: ${age}前`);
      if (info.taskDescription) {
        lines.push(`     任务: ${info.taskDescription}`);
      }
      idx++;
    }

    return { success: true, output: lines.join('\n') };
  }

  /**
   * 在指定 worktree 中执行命令
   * @param name worktree 名称
   * @param command 要执行的 shell 命令
   * @param timeout 超时毫秒，默认 30000
   */
  executeInWorktree(name: string, command: string, timeout: number = 30000): WorktreeResult {
    if (!this.init()) {
      return { success: false, error: this.ensureGit()! };
    }

    const info = this.worktrees.get(name);
    if (!info) {
      return { success: false, error: `worktree "${name}" 不存在` };
    }

    if (info.status !== 'active') {
      return { success: false, error: `worktree "${name}" 状态为 ${info.status}，无法执行命令` };
    }

    if (!fs.existsSync(info.path)) {
      info.status = 'stale';
      this.saveState();
      return { success: false, error: `worktree "${name}" 的目录不存在，状态已标记为 stale` };
    }

    try {
      const output = execSync(command, {
        cwd: info.path,
        encoding: 'utf-8',
        timeout,
        maxBuffer: 10 * 1024 * 1024,
        stdio: ['ignore', 'pipe', 'pipe'],
      });

      // 更新最后活动时间
      info.lastActivity = Date.now();
      this.saveState();

      this.log.info('在 worktree 中执行命令', { name, command: command.substring(0, 80) });
      EventBus.getInstance().emitSync('git.worktree_exec', {
        name, command: command.substring(0, 80),
      }, { source: 'GitWorktree' });

      return { success: true, output: output || '(无输出)' };
    } catch (err: unknown) {
      const e = err as { stdout?: { toString(): string }; stderr?: { toString(): string }; status?: number };
      const stderr = e.stderr?.toString() || '';
      const stdout = e.stdout?.toString() || '';
      const combined = (stdout + '\n' + stderr).trim() || (err instanceof Error ? err.message : String(err));

      this.log.warn('worktree 命令执行失败', { name, command: command.substring(0, 80), error: (err instanceof Error ? err.message : String(err)) });
      return { success: false, output: combined, error: `命令执行失败 (退出码 ${e.status || 'unknown'}): ${combined}` };
    }
  }

  /**
   * 将 worktree 分支合并回基础分支
   * @param name worktree 名称
   * @param strategy 合并策略: merge / squash / rebase
   */
  mergeWorktree(name: string, strategy: string = 'merge'): WorktreeResult {
    if (!this.init()) {
      return { success: false, error: this.ensureGit()! };
    }

    const info = this.worktrees.get(name);
    if (!info) {
      return { success: false, error: `worktree "${name}" 不存在` };
    }

    if (info.status !== 'active') {
      return { success: false, error: `worktree "${name}" 状态为 ${info.status}，无法合并` };
    }

    const validStrategies = ['merge', 'squash', 'rebase'];
    if (!validStrategies.includes(strategy)) {
      return { success: false, error: `不支持的合并策略 "${strategy}"，可选: ${validStrategies.join(', ')}` };
    }

    try {
      // 先在 worktree 中提交所有更改
      execSync('git add -A', { cwd: info.path, encoding: 'utf-8', timeout: 10000 });
      try {
        execSync(`git commit -m "worktree: ${name} 合并前提交" --no-verify`, {
          cwd: info.path, encoding: 'utf-8', timeout: 15000, stdio: ['ignore', 'pipe', 'ignore'],
        });
      } catch {
        // 没有变更需要提交，忽略
      }

      // 记录当前分支
      const currentBranch = execSync('git rev-parse --abbrev-ref HEAD', {
        cwd: this.repoRoot, encoding: 'utf-8', timeout: 5000,
      }).trim();

      // 切换到基础分支
      execSync(`git checkout "${info.baseBranch}"`, {
        cwd: this.repoRoot, encoding: 'utf-8', timeout: 10000,
      });

      let mergeOutput = '';
      const conflicts: string[] = [];
      const mergedFiles: string[] = [];

      try {
        if (strategy === 'merge') {
          mergeOutput = execSync(`git merge "${info.branch}" --no-ff --no-verify -m "merge worktree: ${name} (${info.branch})"`, {
            cwd: this.repoRoot, encoding: 'utf-8', timeout: 30000,
          });
        } else if (strategy === 'squash') {
          execSync(`git merge --squash "${info.branch}"`, {
            cwd: this.repoRoot, encoding: 'utf-8', timeout: 30000,
          });
          mergeOutput = execSync(`git commit -m "squash worktree: ${name} (${info.branch})" --no-verify`, {
            cwd: this.repoRoot, encoding: 'utf-8', timeout: 15000,
          });
        } else if (strategy === 'rebase') {
          // rebase 需要在 worktree 分支上操作，然后快进合并
          execSync(`git checkout "${info.branch}"`, {
            cwd: this.repoRoot, encoding: 'utf-8', timeout: 10000,
          });
          execSync(`git rebase "${info.baseBranch}"`, {
            cwd: this.repoRoot, encoding: 'utf-8', timeout: 30000,
          });
          execSync(`git checkout "${info.baseBranch}"`, {
            cwd: this.repoRoot, encoding: 'utf-8', timeout: 10000,
          });
          mergeOutput = execSync(`git merge "${info.branch}" --ff-only --no-verify -m "rebase worktree: ${name}"`, {
            cwd: this.repoRoot, encoding: 'utf-8', timeout: 15000,
          });
        }

        // 获取合并的文件列表
        try {
          const diffNameOnly = execSync(`git diff --name-only HEAD~1..HEAD`, {
            cwd: this.repoRoot, encoding: 'utf-8', timeout: 10000,
          }).trim();
          if (diffNameOnly) {
            mergedFiles.push(...diffNameOnly.split('\n').filter(Boolean));
          }
        } catch { /* ignore */ }

        info.status = 'merged';
        info.lastActivity = Date.now();
        this.saveState();

        this.log.info('worktree 已合并', { name, strategy, branch: info.branch });
        EventBus.getInstance().emitSync('git.worktree_merged', {
          name, strategy, branch: info.branch, baseBranch: info.baseBranch,
        }, { source: 'GitWorktree' });

        const _result: MergeResult = {
          success: true,
          conflicts,
          mergedFiles,
          strategy,
          output: mergeOutput || '合并成功',
        };

        return {
          success: true,
          worktree: info,
          output: `✅ worktree "${name}" 已通过 ${strategy} 策略合并到 ${info.baseBranch}\n  变更文件: ${mergedFiles.length} 个\n${mergedFiles.length > 0 ? mergedFiles.map(f => `    - ${f}`).join('\n') : ''}`,
        };
      } catch (mergeErr: unknown) {
        // 检测冲突
        let conflictOutput = '';
        try {
          conflictOutput = execSync('git diff --name-only --diff-filter=U', {
            cwd: this.repoRoot, encoding: 'utf-8', timeout: 5000,
          }).trim();
          if (conflictOutput) {
            conflicts.push(...conflictOutput.split('\n').filter(Boolean));
          }
        } catch { /* ignore */ }

        if (conflicts.length > 0) {
          info.status = 'conflict';
          this.saveState();

          this.log.warn('worktree 合并存在冲突', { name, conflicts });
          EventBus.getInstance().emitSync('git.worktree_conflict', {
            name, conflicts, branch: info.branch,
          }, { source: 'GitWorktree' });

          return {
            success: false,
            worktree: info,
            error: `合并存在 ${conflicts.length} 个冲突文件`,
            output: `⚠️ worktree "${name}" 合并时发现冲突:\n${conflicts.map(f => `    ❌ ${f}`).join('\n')}\n\n请手动解决冲突后重新合并。`,
          };
        }

        throw mergeErr;
      } finally {
        // 恢复到原始分支
        try {
          execSync(`git checkout "${currentBranch}"`, {
            cwd: this.repoRoot, encoding: 'utf-8', timeout: 10000, stdio: ['ignore', 'pipe', 'ignore'],
          });
        } catch { /* ignore */ }
      }
    } catch (err: unknown) {
      this.log.error('合并 worktree 失败', { name, strategy, error: (err instanceof Error ? err.message : String(err)) });
      return { success: false, error: `合并 worktree 失败: ${(err instanceof Error ? err.message : String(err))}` };
    }
  }

  /**
   * 获取 worktree 相对于基础分支的差异
   * @param name worktree 名称
   */
  getWorktreeDiff(name: string): WorktreeResult {
    if (!this.init()) {
      return { success: false, error: this.ensureGit()! };
    }

    const info = this.worktrees.get(name);
    if (!info) {
      return { success: false, error: `worktree "${name}" 不存在` };
    }

    try {
      // 先暂存 worktree 中的未提交更改
      try {
        execSync('git add -A', { cwd: info.path, encoding: 'utf-8', timeout: 10000, stdio: ['ignore', 'pipe', 'ignore'] });
      } catch { /* ignore */ }

      // 统计差异
      const statOutput = execSync(`git diff "${info.baseBranch}..${info.branch}" --stat`, {
        cwd: this.repoRoot, encoding: 'utf-8', timeout: 15000,
      }).trim();

      // 文件列表
      const nameOnlyOutput = execSync(`git diff "${info.baseBranch}..${info.branch}" --name-status`, {
        cwd: this.repoRoot, encoding: 'utf-8', timeout: 15000,
      }).trim();

      // 实际差异内容（截断）
      const diffContent = execSync(`git diff "${info.baseBranch}..${info.branch}"`, {
        cwd: this.repoRoot, encoding: 'utf-8', timeout: 15000,
      }).trim();
      const truncated = diffContent.length > 3000
        ? diffContent.substring(0, 3000) + '\n...(截断)'
        : diffContent;

      const output = `📊 worktree "${name}" 差异 (对比 ${info.baseBranch}):\n\n${statOutput || '(无差异)'}\n\n文件变更:\n${nameOnlyOutput || '(无)'}\n\n详细差异:\n${truncated || '(无)'}`;

      return { success: true, output };
    } catch (err: unknown) {
      this.log.error('获取 worktree 差异失败', { name, error: (err instanceof Error ? err.message : String(err)) });
      return { success: false, error: `获取差异失败: ${(err instanceof Error ? err.message : String(err))}` };
    }
  }

  /**
   * 同步 worktree 与基础分支的最新变更
   * @param name worktree 名称
   */
  syncWorktree(name: string): WorktreeResult {
    if (!this.init()) {
      return { success: false, error: this.ensureGit()! };
    }

    const info = this.worktrees.get(name);
    if (!info) {
      return { success: false, error: `worktree "${name}" 不存在` };
    }

    if (info.status !== 'active') {
      return { success: false, error: `worktree "${name}" 状态为 ${info.status}，无法同步` };
    }

    if (!fs.existsSync(info.path)) {
      info.status = 'stale';
      this.saveState();
      return { success: false, error: `worktree "${name}" 的目录不存在，状态已标记为 stale` };
    }

    try {
      // 先在 worktree 中暂存当前更改
      let stashNeeded = false;
      try {
        const statusOutput = execSync('git status --porcelain', {
          cwd: info.path, encoding: 'utf-8', timeout: 5000,
        }).trim();
        if (statusOutput) {
          stashNeeded = true;
          execSync('git stash --include-untracked', {
            cwd: info.path, encoding: 'utf-8', timeout: 15000,
          });
        }
      } catch { /* ignore */ }

      // 从基础分支 rebase
      let syncOutput: string;
      try {
        syncOutput = execSync(`git rebase "${info.baseBranch}"`, {
          cwd: info.path, encoding: 'utf-8', timeout: 30000,
        });
      } catch (rebaseErr: unknown) {
        // rebase 冲突，中止
        try {
          execSync('git rebase --abort', {
            cwd: info.path, encoding: 'utf-8', timeout: 10000, stdio: ['ignore', 'pipe', 'ignore'],
          });
        } catch { /* ignore */ }

        // 恢复暂存
        if (stashNeeded) {
          try {
            execSync('git stash pop', {
              cwd: info.path, encoding: 'utf-8', timeout: 10000, stdio: ['ignore', 'pipe', 'ignore'],
            });
          } catch { /* ignore */ }
        }

        info.status = 'conflict';
        this.saveState();
        return { success: false, error: `同步时发现冲突，请手动解决后重试`, output: (rebaseErr instanceof Error ? rebaseErr.message : String(rebaseErr)) };
      }

      // 恢复暂存
      if (stashNeeded) {
        try {
          execSync('git stash pop', {
            cwd: info.path, encoding: 'utf-8', timeout: 10000,
          });
        } catch (popErr: unknown) {
          // stash pop 冲突
          info.status = 'conflict';
          this.saveState();
          return {
            success: false,
            error: '恢复暂存更改时发现冲突',
            output: `同步完成但恢复暂存更改时存在冲突，请手动解决: ${(popErr instanceof Error ? popErr.message : String(popErr))}`,
          };
        }
      }

      info.lastActivity = Date.now();
      this.saveState();

      this.log.info('worktree 已同步', { name, baseBranch: info.baseBranch });
      EventBus.getInstance().emitSync('git.worktree_synced', {
        name, baseBranch: info.baseBranch,
      }, { source: 'GitWorktree' });

      return {
        success: true,
        worktree: info,
        output: `✅ worktree "${name}" 已与 ${info.baseBranch} 同步\n${syncOutput || ''}`,
      };
    } catch (err: unknown) {
      this.log.error('同步 worktree 失败', { name, error: (err instanceof Error ? err.message : String(err)) });
      return { success: false, error: `同步失败: ${(err instanceof Error ? err.message : String(err))}` };
    }
  }

  // ============ 辅助方法 ============

  /** 获取 worktree 绝对路径 */
  getWorktreePath(name: string): string | null {
    const info = this.worktrees.get(name);
    return info ? info.path : null;
  }

  /** 获取 worktree 统计信息 */
  getStats(): string {
    const all = [...this.worktrees.values()];
    const active = all.filter(w => w.status === 'active').length;
    const merged = all.filter(w => w.status === 'merged').length;
    const conflict = all.filter(w => w.status === 'conflict').length;
    const stale = all.filter(w => w.status === 'stale').length;

    return [
      `📊 Worktree 统计:`,
      `  总计: ${all.length}`,
      `  🟢 活跃: ${active}`,
      `  ✅ 已合并: ${merged}`,
      `  ⚠️ 冲突: ${conflict}`,
      `  🔴 过期: ${stale}`,
    ].join('\n');
  }

  /** 自动清理超过 7 天的过期 worktree */
  private cleanupStale(): void {
    const now = Date.now();
    const staleNames: string[] = [];

    for (const [name, info] of this.worktrees) {
      if (info.status === 'active' && (now - info.createdAt) > GitWorktreeManager.STALE_THRESHOLD_MS) {
        info.status = 'stale';
        staleNames.push(name);
      }
    }

    if (staleNames.length > 0) {
      this.saveState();
      this.log.info('标记过期 worktree', { count: staleNames.length, names: staleNames });
    }
  }

  /** 格式化持续时间 */
  private formatDuration(ms: number): string {
    const seconds = Math.floor(ms / 1000);
    if (seconds < 60) return `${seconds}秒`;
    const minutes = Math.floor(seconds / 60);
    if (minutes < 60) return `${minutes}分钟`;
    const hours = Math.floor(minutes / 60);
    if (hours < 24) return `${hours}小时`;
    const days = Math.floor(hours / 24);
    return `${days}天`;
  }

  // ============ Agent Loop 工具注册 ============

  /** 返回 ToolDef 兼容的工具定义列表，供 Agent Loop 注册 */
  getToolDefinitions(): Array<{
    name: string;
    description: string;
    parameters: Record<string, { type: string; description: string; required?: boolean }>;
    readOnly?: boolean;
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    execute: (args: any) => Promise<string>;
  }> {
    // eslint-disable-next-line @typescript-eslint/no-this-alias
    const manager = this;

    return [
      {
        name: 'worktree_create',
        description: '创建隔离的 git worktree，用于并行开发。每个 worktree 拥有独立的工作目录和分支，不影响主工作区。',
        parameters: {
          name: { type: 'string', description: 'worktree 名称（用于标识，如 "feature-auth"）', required: true },
          branch: { type: 'string', description: '分支名（可选，不提供则自动生成 duan/task-{timestamp}）', required: false },
          task_description: { type: 'string', description: '任务描述（可选，用于记录 worktree 用途）', required: false },
        },
        execute: (args) => {
          const result = manager.createWorktree(
            args.name as string,
            args.branch as string | undefined,
            args.task_description as string | undefined,
          );
          return Promise.resolve(result.success
            ? result.output!
            : `❌ ${result.error}`);
        },
      },
      {
        name: 'worktree_remove',
        description: '移除指定的 git worktree，清理工作目录。可选择是否同时删除关联分支。',
        parameters: {
          name: { type: 'string', description: '要移除的 worktree 名称', required: true },
          delete_branch: { type: 'string', description: '是否同时删除关联分支（true/false，默认 true）', required: false },
        },
        execute: (args) => {
          const deleteBranch = (args.delete_branch as string) !== 'false';
          const result = manager.removeWorktree(args.name as string, deleteBranch);
          return Promise.resolve(result.success
            ? result.output!
            : `❌ ${result.error}`);
        },
      },
      {
        name: 'worktree_list',
        description: '列出所有受管理的 git worktree，显示名称、路径、分支、状态等信息。',
        parameters: {},
        readOnly: true,
        execute: () => {
          const result = manager.listWorktrees();
          return Promise.resolve(result.output || '❌ 无法列出 worktree');
        },
      },
      {
        name: 'worktree_exec',
        description: '在指定 worktree 的工作目录中执行 shell 命令。用于在隔离环境中运行构建、测试等操作。',
        parameters: {
          name: { type: 'string', description: 'worktree 名称', required: true },
          command: { type: 'string', description: '要执行的 shell 命令', required: true },
          timeout: { type: 'string', description: '超时毫秒数（默认 30000）', required: false },
        },
        execute: (args) => {
          const timeout = parseInt(args.timeout as string) || 30000;
          const result = manager.executeInWorktree(args.name as string, args.command as string, timeout);
          return Promise.resolve(result.success
            ? result.output || '(无输出)'
            : `❌ ${result.error}`);
        },
      },
      {
        name: 'worktree_merge',
        description: '将 worktree 的分支合并回基础分支。支持 merge、squash、rebase 三种策略。合并前会自动提交 worktree 中的未提交更改。',
        parameters: {
          name: { type: 'string', description: 'worktree 名称', required: true },
          strategy: { type: 'string', description: '合并策略: merge(默认) / squash / rebase', required: false },
        },
        execute: (args) => {
          const result = manager.mergeWorktree(args.name as string, (args.strategy as string) || 'merge');
          return Promise.resolve(result.success
            ? result.output!
            : `❌ ${result.error}\n${result.output || ''}`);
        },
      },
      {
        name: 'worktree_diff',
        description: '查看 worktree 相对于基础分支的差异，包括变更文件列表和差异内容。',
        parameters: {
          name: { type: 'string', description: 'worktree 名称', required: true },
        },
        readOnly: true,
        execute: (args) => {
          const result = manager.getWorktreeDiff(args.name as string);
          return Promise.resolve(result.success
            ? result.output!
            : `❌ ${result.error}`);
        },
      },
      {
        name: 'worktree_sync',
        description: '同步 worktree 与基础分支的最新变更。会先暂存本地更改，rebase 基础分支，再恢复暂存。',
        parameters: {
          name: { type: 'string', description: 'worktree 名称', required: true },
        },
        execute: (args) => {
          const result = manager.syncWorktree(args.name as string);
          return Promise.resolve(result.success
            ? result.output!
            : `❌ ${result.error}`);
        },
      },
    ];
  }
}

// ============ 单例导出 ============

let _instance: GitWorktreeManager | null = null;

/** 获取 GitWorktreeManager 单例 */
export function getGitWorktreeManager(): GitWorktreeManager {
  if (!_instance) {
    _instance = new GitWorktreeManager();
    _instance.init();
  }
  return _instance;
}

/** 注入自定义实例（用于测试） */
export function setGitWorktreeManager(instance: GitWorktreeManager): void {
  _instance = instance;
}
