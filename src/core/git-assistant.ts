/**
 * GitAssistant — 对标 Aider 的 Git 集成提交工具 (v21.3 新功能)
 *
 * 核心思想: 每次 agent 修改代码后，自动生成有意义的 commit message 并提交，
 * 让用户能轻松回滚 AI 的修改。受 Aider auto-commit 启发。
 *
 * 能力:
 * - 状态查询: getStatus / getDiff / getLog / getCurrentBranch / isRepo
 * - 暂存操作: add / unstage
 * - 提交: commit / generateCommitMessage (fallback, 不调用 LLM) / smartCommit
 * - 分支: createBranch / checkoutBranch / listBranches / mergeBranch
 * - 回滚: undoLastCommit / revertCommit / discardChanges
 * - Stash: stash / stashPop / stashList
 * - 远程: pull / push / fetch
 * - LLM 工具: 通过 getToolDefinitions() 暴露 8 个工具
 *
 * 实现约束:
 * - execGit 使用 child_process.execFile('git', [...args])，避免 shell 注入
 * - 所有 git 命令默认 30s 超时
 * - cwd = repoPath（默认 process.cwd()）
 * - git 命令失败时抛出带 stderr 内容的错误
 * - 无持久化，每次查询实时调用 git
 */

import { execFile } from 'child_process';
import * as path from 'path';
import { logger } from './structured-logger.js';
import { EventBus } from './event-bus.js';
import type { ToolDef } from './unified-tool-def.js';

// ============ 类型定义 ============

/** 文件变更信息 */
export interface FileChange {
  path: string;
  status: 'modified' | 'added' | 'deleted' | 'renamed' | 'copied';
  staged: boolean;
}

/** Git 仓库状态 */
export interface GitStatus {
  staged: FileChange[];
  unstaged: FileChange[];
  untracked: string[];
  branch: string;
  ahead: number;
  behind: number;
  clean: boolean;
}

/** 提交信息 */
export interface CommitInfo {
  hash: string;        // 完整 hash
  shortHash: string;   // 前 7 位
  author: string;
  email: string;
  date: string;        // ISO 格式
  message: string;     // 完整 message（含 body）
  subject: string;     // 仅首行
}

/** 分支信息 */
export interface BranchInfo {
  name: string;
  current: boolean;
  remote: boolean;
  lastCommit: string;  // short hash
}

/** Stash 信息 */
export interface StashInfo {
  index: number;
  message: string;
  hash: string;
}

// ============ 常量 ============

/** 默认 git 命令超时 30s */
const DEFAULT_TIMEOUT_MS = 30000;

/** execFile maxBuffer: 10MB */
const MAX_BUFFER = 10 * 1024 * 1024;

// ============ execFile 包装 ============

/** execFile 单次执行结果 */
interface ExecResult {
  stdout: string;
  stderr: string;
}

/**
 * 调用 git 命令（Promise 包装的 execFile）
 * 失败时抛出包含 stderr 内容的错误
 */
function execGitRaw(
  args: string[],
  opts: { cwd?: string; timeout?: number } = {},
): Promise<ExecResult> {
  const cwd = opts.cwd || process.cwd();
  const timeout = opts.timeout ?? DEFAULT_TIMEOUT_MS;
  return new Promise((resolve, reject) => {
    execFile('git', args, {
      cwd,
      timeout,
      maxBuffer: MAX_BUFFER,
      encoding: 'utf-8',
      windowsHide: true,
    }, (err, stdout, stderr) => {
      if (err) {
        const stderrText = (stderr || '').trim();
        const errMsg = stderrText || (err instanceof Error ? err.message : String(err));
        const cmdPreview = args.join(' ').substring(0, 200);
        reject(new Error(`git ${cmdPreview} failed: ${errMsg}`));
      } else {
        resolve({ stdout: stdout || '', stderr: stderr || '' });
      }
    });
  });
}

// ============ 主类 ============

export class GitAssistant {
  private repoPath: string;
  private log = logger.child({ module: 'GitAssistant' });
  /** 标记是否已 dispose（用于避免重复清理） */
  private disposed = false;

  constructor(repoPath?: string) {
    this.repoPath = repoPath || process.cwd();
  }

  /** 获取仓库工作目录 */
  getRepoPath(): string {
    return this.repoPath;
  }

  /**
   * 私有 execGit：执行 git 命令，返回 stdout 字符串
   * 失败时抛出带 stderr 内容的错误
   */
  private async execGit(args: string[], timeout?: number): Promise<string> {
    const { stdout } = await execGitRaw(args, { cwd: this.repoPath, timeout });
    return stdout;
  }

  // ============ 状态查询 ============

  /** 是否在 git 仓库内 */
  async isRepo(): Promise<boolean> {
    try {
      await this.execGit(['rev-parse', '--git-dir']);
      return true;
    } catch {
      return false;
    }
  }

  /** 获取当前分支名（detached HEAD 返回 'HEAD'） */
  async getCurrentBranch(): Promise<string> {
    const out = await this.execGit(['rev-parse', '--abbrev-ref', 'HEAD']);
    return out.trim();
  }

  /**
   * 获取仓库状态 — 解析 `git status --porcelain=v1 -b`
   */
  async getStatus(): Promise<GitStatus> {
    const out = await this.execGit(['status', '--porcelain=v1', '-b']);
    const lines = out.split('\n');

    let branch = '';
    let ahead = 0;
    let behind = 0;
    const staged: FileChange[] = [];
    const unstaged: FileChange[] = [];
    const untracked: string[] = [];

    for (const raw of lines) {
      const line = raw.replace(/\r$/, '');
      if (!line) continue;

      // 分支行: `## branch...origin/branch [ahead N, behind N]`
      if (line.startsWith('## ')) {
        const branchPart = line.substring(3);
        // 提取 ahead/behind
        const aheadMatch = branchPart.match(/\[ahead\s+(\d+)/);
        const behindMatch = branchPart.match(/\[behind\s+(\d+)/);
        if (aheadMatch) ahead = parseInt(aheadMatch[1], 10);
        if (behindMatch) behind = parseInt(behindMatch[1], 10);

        // 提取分支名
        const bareBranch = branchPart.split('...')[0].split(' ')[0];
        // 处理 detached HEAD: "HEAD (no branch)"
        if (bareBranch === 'HEAD' || branchPart.startsWith('HEAD (no branch)')) {
          branch = 'HEAD';
        } else if (bareBranch.startsWith('No commits yet on ')) {
          // "No commits yet on main"
          branch = bareBranch.replace(/^No commits yet on\s+/, '');
        } else {
          branch = bareBranch;
        }
        continue;
      }

      // porcelain v1 格式: `XY filename`
      // X = index(staged) 状态, Y = working tree(unstaged) 状态
      if (line.length < 3) continue;
      const x = line[0];
      const y = line[1];
      const pathStr = line.substring(3);

      // Untracked: `?? file`
      if (x === '?' && y === '?') {
        untracked.push(pathStr);
        continue;
      }

      // Renamed: 格式 `R  oldname -> newname`
      if (x === 'R' || y === 'R') {
        const arrowIdx = pathStr.indexOf('->');
        if (arrowIdx >= 0) {
          const newName = pathStr.substring(arrowIdx + 2).trim();
          if (x === 'R') {
            staged.push({ path: newName, status: 'renamed', staged: true });
          }
          if (y === 'R') {
            unstaged.push({ path: newName, status: 'renamed', staged: false });
          }
          continue;
        }
      }

      // 解析 staged 变更（X 列非空格且非问号）
      if (x !== ' ' && x !== '?') {
        const status = codeToStatus(x);
        if (status) {
          staged.push({ path: pathStr, status, staged: true });
        }
      }
      // 解析 unstaged 变更（Y 列非空格且非问号）
      if (y !== ' ' && y !== '?') {
        const status = codeToStatus(y);
        if (status) {
          unstaged.push({ path: pathStr, status, staged: false });
        }
      }
    }

    const clean = staged.length === 0 && unstaged.length === 0 && untracked.length === 0;

    return { staged, unstaged, untracked, branch, ahead, behind, clean };
  }

  /** 获取 diff（默认 unstaged，staged=true 则查 cached） */
  async getDiff(staged?: boolean): Promise<string> {
    const args = ['diff'];
    if (staged) args.push('--cached');
    return this.execGit(args);
  }

  /** 获取提交历史 */
  async getLog(limit?: number): Promise<CommitInfo[]> {
    const n = Math.max(1, limit ?? 50);
    // 使用控制字符分隔：%x1f=字段分隔, %x1e=记录分隔
    const fmt = '%H%x1f%h%x1f%an%x1f%ae%x1f%aI%x1f%B%x1e';
    let out: string;
    try {
      out = await this.execGit(['log', `-n`, String(n), `--format=${fmt}`]);
    } catch {
      // 空仓库或无提交时返回空数组
      return [];
    }
    return parseLogOutput(out);
  }

  // ============ 暂存操作 ============

  /** git add [paths] 或 git add -A */
  async add(paths?: string[]): Promise<void> {
    if (paths && paths.length > 0) {
      await this.execGit(['add', ...paths]);
    } else {
      await this.execGit(['add', '-A']);
    }
  }

  /** git reset HEAD <paths> — 取消暂存 */
  async unstage(paths: string[]): Promise<void> {
    if (paths.length === 0) return;
    await this.execGit(['reset', 'HEAD', '--', ...paths]);
  }

  // ============ 提交 ============

  /**
   * 提交变更
   * @returns commit hash（完整）
   */
  async commit(
    message: string,
    options?: { amend?: boolean; noVerify?: boolean },
  ): Promise<string> {
    const args = ['commit', '-m', message];
    if (options?.amend) args.push('--amend');
    if (options?.noVerify) args.push('--no-verify');
    await this.execGit(args);
    const hash = (await this.execGit(['rev-parse', 'HEAD'])).trim();
    return hash;
  }

  /**
   * 生成 commit message — Fallback 版本（不调用 LLM）
   * 基于 diff 分析生成结构化 Conventional Commits 格式
   */
  async generateCommitMessage(diff?: string): Promise<string> {
    if (!diff) {
      // 优先 staged diff，回退到 unstaged
      diff = await this.getDiff(true);
      if (!diff.trim()) {
        diff = await this.getDiff(false);
      }
    }
    return analyzeDiffAndGenerateMessage(diff);
  }

  /**
   * 智能 commit：自动 add 所有变更 → 生成 message → commit
   * 工作区干净时返回 { hash: '', message: 'No changes to commit', filesChanged: 0 }
   */
  async smartCommit(
    options?: { autoAdd?: boolean },
  ): Promise<{ hash: string; message: string; filesChanged: number }> {
    const status = await this.getStatus();
    if (status.clean) {
      return { hash: '', message: 'No changes to commit', filesChanged: 0 };
    }

    const filesChanged =
      status.staged.length + status.unstaged.length + status.untracked.length;

    if (options?.autoAdd !== false) {
      await this.add();
    }

    const diff = await this.getDiff(true);
    const message = await this.generateCommitMessage(diff);
    const hash = await this.commit(message);

    EventBus.getInstance().emitSync(
      'git.smart_commit',
      { hash, message, filesChanged },
      { source: 'GitAssistant' },
    );

    this.log.info('smartCommit 已完成', { hash: hash.substring(0, 7), message, filesChanged });
    return { hash, message, filesChanged };
  }

  // ============ 分支操作 ============

  /** 创建分支（可选基于 from） */
  async createBranch(name: string, from?: string): Promise<void> {
    const args = ['branch', name];
    if (from) args.push(from);
    await this.execGit(args);
  }

  /** 切换分支 */
  async checkoutBranch(name: string): Promise<void> {
    await this.execGit(['checkout', name]);
  }

  /** 列出本地+远程分支 */
  async listBranches(): Promise<BranchInfo[]> {
    // 注意：git for-each-ref 在部分 git 版本上不支持 %x1f 十六进制分隔符，
    // 因此使用字面量 | 作为字段分隔符（refname/hash/HEAD 标记均不含 |）
    const sep = '|';
    const fmt = `%(refname)${sep}%(refname:short)${sep}%(objectname:short)${sep}%(HEAD)`;
    let out: string;
    try {
      out = await this.execGit([
        'for-each-ref',
        `--format=${fmt}`,
        'refs/heads/',
        'refs/remotes/',
      ]);
    } catch {
      return [];
    }
    const branches: BranchInfo[] = [];
    for (const raw of out.split('\n')) {
      const line = raw.trim();
      if (!line) continue;
      const parts = line.split(sep);
      if (parts.length < 4) continue;
      const fullRef = parts[0];
      const shortName = parts[1];
      const lastCommit = parts[2];
      const headMark = parts[3];
      branches.push({
        name: shortName,
        current: headMark === '*',
        remote: fullRef.startsWith('refs/remotes/'),
        lastCommit,
      });
    }
    return branches;
  }

  /** 合并分支 */
  async mergeBranch(name: string, options?: { noFf?: boolean }): Promise<void> {
    const args = ['merge', name];
    if (options?.noFf) args.push('--no-ff');
    await this.execGit(args);
  }

  // ============ 回滚 ============

  /** 撤销最近一次提交（保留变更在工作区，--mixed） */
  async undoLastCommit(): Promise<void> {
    await this.execGit(['reset', 'HEAD~1']);
  }

  /** 反转指定提交（生成新提交） */
  async revertCommit(hash: string): Promise<void> {
    await this.execGit(['revert', '--no-edit', hash]);
  }

  /** 丢弃工作区变更（git checkout -- <paths>） */
  async discardChanges(paths: string[]): Promise<void> {
    if (paths.length === 0) return;
    await this.execGit(['checkout', '--', ...paths]);
  }

  // ============ Stash ============

  /** 暂存当前变更到 stash */
  async stash(message?: string): Promise<void> {
    const args = ['stash', 'push', '--include-untracked'];
    if (message) args.push('-m', message);
    await this.execGit(args);
  }

  /** 弹出最近的 stash */
  async stashPop(): Promise<void> {
    await this.execGit(['stash', 'pop']);
  }

  /** 列出所有 stash */
  async stashList(): Promise<StashInfo[]> {
    const fmt = '%gd%x1f%s%x1f%H';
    let out: string;
    try {
      out = await this.execGit(['stash', 'list', `--format=${fmt}`]);
    } catch {
      return [];
    }
    if (!out.trim()) return [];
    const list: StashInfo[] = [];
    for (const raw of out.split('\n')) {
      const line = raw.trim();
      if (!line) continue;
      const parts = line.split('\x1f');
      if (parts.length < 3) continue;
      // stash@{0} → 0
      const idxMatch = parts[0].match(/\{(\d+)\}/);
      const index = idxMatch ? parseInt(idxMatch[1], 10) : 0;
      list.push({
        index,
        message: parts[1],
        hash: parts[2],
      });
    }
    return list;
  }

  // ============ 远程 ============

  /** 拉取远程变更 */
  async pull(remote?: string, branch?: string): Promise<void> {
    const args = ['pull'];
    if (remote) {
      args.push(remote);
      if (branch) args.push(branch);
    }
    await this.execGit(args);
  }

  /** 推送到远程 */
  async push(
    remote?: string,
    branch?: string,
    options?: { force?: boolean; setUpstream?: boolean },
  ): Promise<void> {
    const args = ['push'];
    if (options?.force) args.push('--force');
    if (options?.setUpstream) args.push('-u');
    args.push(remote ?? 'origin');
    if (branch) args.push(branch);
    await this.execGit(args);
  }

  /** 拉取远程引用（不合并） */
  async fetch(remote?: string): Promise<void> {
    const args = ['fetch'];
    if (remote) args.push(remote);
    await this.execGit(args);
  }

  // ============ LLM 工具定义 ============

  /** 返回 Agent Loop 可用的 8 个工具定义 */
  getToolDefinitions(): ToolDef[] {
    // eslint-disable-next-line @typescript-eslint/no-this-alias
    const self = this;

    return [
      {
        name: 'git_status',
        description:
          '获取当前 Git 仓库状态，包括已暂存/未暂存/未跟踪文件、当前分支、相对远程的 ahead/behind 数。无参数。',
        parameters: {},
        readOnly: true,
        category: 'code',
        riskLevel: 'safe',
        execute: async () => {
          const status = await self.getStatus();
          return JSON.stringify(status, null, 2);
        },
      },
      {
        name: 'git_diff',
        description:
          '获取 Git 变更 diff。staged=true 查看 已暂存 diff（git diff --cached），否则查看未暂存 diff。',
        parameters: {
          staged: {
            type: 'boolean',
            description: '是否查看已暂存的 diff（默认 false，查看未暂存）',
            required: false,
          },
        },
        readOnly: true,
        category: 'code',
        riskLevel: 'safe',
        execute: async (args) => {
          const staged = Boolean(args?.staged);
          const diff = await self.getDiff(staged);
          const filesChanged = countDiffFiles(diff);
          return JSON.stringify({ diff, filesChanged });
        },
      },
      {
        name: 'git_commit',
        description:
          '提交变更。若提供 paths 则只暂存这些路径（git add <paths>）；未提供 paths 则暂存所有变更（git add -A）。可选 amend 修改上次提交。',
        parameters: {
          message: { type: 'string', description: 'Commit message', required: true },
          paths: {
            type: 'array',
            description: '要暂存的文件路径列表（可选，未提供则 git add -A）',
            required: false,
          },
          amend: { type: 'boolean', description: '是否 amend 上次提交（默认 false）', required: false },
        },
        category: 'code',
        riskLevel: 'moderate',
        execute: async (args) => {
          const message = String(args?.message ?? '');
          if (!message) {
            return JSON.stringify({ error: 'message is required' });
          }
          const paths = Array.isArray(args?.paths) ? (args.paths as string[]) : undefined;
          if (paths) {
            await self.add(paths);
          } else {
            await self.add();
          }
          const amend = Boolean(args?.amend);
          const noVerify = Boolean(args?.noVerify);
          const hash = await self.commit(message, { amend, noVerify });
          return JSON.stringify({ hash, message });
        },
      },
      {
        name: 'git_smart_commit',
        description:
          '智能提交：自动 add 所有变更 → 基于分析 diff 生成 Conventional Commits 格式 message → commit。工作区干净时返回空 hash。autoAdd 默认 true。',
        parameters: {
          autoAdd: { type: 'boolean', description: '是否自动 git add -A（默认 true）', required: false },
        },
        category: 'code',
        riskLevel: 'moderate',
        execute: async (args) => {
          const autoAdd = args?.autoAdd !== false;
          const result = await self.smartCommit({ autoAdd });
          return JSON.stringify(result);
        },
      },
      {
        name: 'git_log',
        description: '查看提交历史。limit 默认 10。返回完整 hash/shortHash/author/email/date/message/subject。',
        parameters: {
          limit: { type: 'number', description: '返回的最大提交数（默认 10）', required: false },
        },
        readOnly: true,
        category: 'code',
        riskLevel: 'safe',
        execute: async (args) => {
          const limit = typeof args?.limit === 'number' ? args.limit : 10;
          const commits = await self.getLog(limit);
          return JSON.stringify({ commits });
        },
      },
      {
        name: 'git_branch',
        description:
          '分支操作。action=create 创建分支(可选 from 基点)；action=checkout 切换分支；action=list 列出所有本地+远程分支；action=merge 合并分支(可选 noFf)。',
        parameters: {
          action: {
            type: 'string',
            description: "操作类型: 'create' | 'checkout' | 'list' | 'merge'",
            required: true,
          },
          name: { type: 'string', description: '分支名（create/checkout/merge 必填）', required: false },
          from: { type: 'string', description: 'create 时的基点分支（可选）', required: false },
          noFf: { type: 'boolean', description: 'merge 时是否 --no-ff（默认 false）', required: false },
        },
        category: 'code',
        riskLevel: 'moderate',
        execute: async (args) => {
          const action = String(args?.action ?? '');
          try {
            if (action === 'create') {
              const name = String(args?.name ?? '');
              if (!name) return JSON.stringify({ error: 'name is required for create' });
              await self.createBranch(name, args?.from as string | undefined);
              return JSON.stringify({ success: true, action, name });
            }
            if (action === 'checkout') {
              const name = String(args?.name ?? '');
              if (!name) return JSON.stringify({ error: 'name is required for checkout' });
              await self.checkoutBranch(name);
              return JSON.stringify({ success: true, action, name });
            }
            if (action === 'list') {
              const branches = await self.listBranches();
              return JSON.stringify({ success: true, action, branches });
            }
            if (action === 'merge') {
              const name = String(args?.name ?? '');
              if (!name) return JSON.stringify({ error: 'name is required for merge' });
              await self.mergeBranch(name, { noFf: Boolean(args?.noFf) });
              return JSON.stringify({ success: true, action, name });
            }
            return JSON.stringify({ error: `unknown action: ${action}` });
          } catch (e: unknown) {
            return JSON.stringify({
              success: false,
              error: e instanceof Error ? e.message : String(e),
            });
          }
        },
      },
      {
        name: 'git_undo',
        description:
          "撤销操作。action=last_commit 撤销最近一次提交(保留变更在工作区)；action=changes 丢弃工作区变更(需 paths)；action=stash_pop 弹出最近 stash。",
        parameters: {
          action: {
            type: 'string',
            description: "'last_commit' | 'changes' | 'stash_pop'",
            required: true,
          },
          paths: {
            type: 'array',
            description: 'paths for action=changes (git checkout -- <paths>)',
            required: false,
          },
        },
        category: 'code',
        riskLevel: 'dangerous',
        execute: async (args) => {
          const action = String(args?.action ?? '');
          try {
            if (action === 'last_commit') {
              await self.undoLastCommit();
              return JSON.stringify({ success: true, message: 'undid last commit (changes kept in working tree)' });
            }
            if (action === 'changes') {
              const paths = Array.isArray(args?.paths) ? (args.paths as string[]) : [];
              if (paths.length === 0) {
                return JSON.stringify({ success: false, message: 'paths is required for action=changes' });
              }
              await self.discardChanges(paths);
              return JSON.stringify({ success: true, message: `discarded changes in ${paths.length} file(s)` });
            }
            if (action === 'stash_pop') {
              await self.stashPop();
              return JSON.stringify({ success: true, message: 'popped latest stash' });
            }
            return JSON.stringify({ success: false, message: `unknown action: ${action}` });
          } catch (e: unknown) {
            return JSON.stringify({
              success: false,
              message: e instanceof Error ? e.message : String(e),
            });
          }
        },
      },
      {
        name: 'git_push',
        description:
          '推送到远程。remote 默认 origin，branch 默认当前分支。force=true 强制推送。setUpstream=true 设置上游(-u)。',
        parameters: {
          remote: { type: 'string', description: "远程名（默认 'origin'）", required: false },
          branch: { type: 'string', description: '分支名（默认当前分支）', required: false },
          force: { type: 'boolean', description: '是否强制推送（默认 false）', required: false },
          setUpstream: { type: 'boolean', description: '是否设置上游（-u，默认 false）', required: false },
        },
        category: 'code',
        riskLevel: 'dangerous',
        execute: async (args) => {
          const remote = (args?.remote as string) || 'origin';
          const branch = args?.branch as string | undefined;
          try {
            await self.push(remote, branch, {
              force: Boolean(args?.force),
              setUpstream: Boolean(args?.setUpstream),
            });
            return JSON.stringify({ success: true, message: `pushed to ${remote}${branch ? '/' + branch : ''}` });
          } catch (e: unknown) {
            return JSON.stringify({
              success: false,
              message: e instanceof Error ? e.message : String(e),
            });
          }
        },
      },
    ];
  }

  /** 资源释放（无持久化状态，调用后实例不再使用） */
  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    // 无持久化资源，仅标记释放
  }
}

// ============ 辅助函数 ============

/** git status code → FileChange.status */
function codeToStatus(code: string): FileChange['status'] | null {
  switch (code) {
    case 'M': return 'modified';
    case 'A': return 'added';
    case 'D': return 'deleted';
    case 'R': return 'renamed';
    case 'C': return 'copied';
    default: return null;
  }
}

/** 解析 git log 输出（使用 \x1e/\x1f 分隔） */
function parseLogOutput(out: string): CommitInfo[] {
  const commits: CommitInfo[] = [];
  const records = out.split('\x1e');
  for (const rec of records) {
    if (!rec.trim()) continue;
    const parts = rec.split('\x1f');
    if (parts.length < 6) continue;
    const hash = parts[0];
    const shortHash = parts[1];
    const author = parts[2];
    const email = parts[3];
    const date = parts[4];
    const message = parts[5];
    const subject = message.split('\n')[0].trim();
    commits.push({ hash, shortHash, author, email, date, message: message.trim(), subject });
  }
  return commits;
}

/** 计算 diff 中的文件数 */
function countDiffFiles(diff: string): number {
  if (!diff.trim()) return 0;
  let count = 0;
  for (const line of diff.split('\n')) {
    if (line.startsWith('diff --git ')) count++;
  }
  return count;
}

// ============ Diff 分析 & Commit Message 生成 ============

interface ParsedDiffFile {
  path: string;
  status: 'added' | 'deleted' | 'modified' | 'renamed';
  content: string;  // 该文件的 diff 块内容
}

/** 解析 diff 字符串为文件列表 */
function parseDiffFiles(diff: string): ParsedDiffFile[] {
  if (!diff.trim()) return [];
  const files: ParsedDiffFile[] = [];
  // 以 'diff --git ' 分割
  const blocks = diff.split(/^diff --git /m);
  for (const block of blocks) {
    if (!block.trim()) continue;
    // 首行: a/path b/path
    const lines = block.split('\n');
    const header = lines[0] || '';
    // 提取 b/path（新路径）
    const pathMatch = header.match(/\ba\/[^\s]+ b\/(.+)$/);
    const path = pathMatch ? pathMatch[1] : header.split(' b/').pop() || header.trim();
    let status: ParsedDiffFile['status'] = 'modified';
    if (/^new file mode/m.test(block)) status = 'added';
    else if (/^deleted file mode/m.test(block)) status = 'deleted';
    else if (/^rename from/m.test(block) || /^similarity index/m.test(block)) status = 'renamed';
    files.push({ path, status, content: block });
  }
  return files;
}

/**
 * 分析 diff 并生成 Conventional Commits 格式的 message
 * 规则：
 * 1. 新文件 → `feat: add {filename}`
 * 2. 删除文件 → `chore: remove {filename}`
 * 3. 修改文件 → 按内容分析
 * 4. 多文件 → 取主要变更类型 + 文件数
 */
export function analyzeDiffAndGenerateMessage(diff: string): string {
  if (!diff.trim()) return 'chore: no changes';

  const files = parseDiffFiles(diff);
  if (files.length === 0) return 'chore: no changes';

  const added = files.filter(f => f.status === 'added');
  const deleted = files.filter(f => f.status === 'deleted');
  const modified = files.filter(f => f.status === 'modified');

  // 单文件
  if (files.length === 1) {
    const f = files[0];
    const basename = path.basename(f.path);
    if (f.status === 'added') {
      return `feat: add ${basename}`;
    }
    if (f.status === 'deleted') {
      return `chore: remove ${basename}`;
    }
    if (f.status === 'renamed') {
      return `refactor: rename to ${basename}`;
    }
    return analyzeModifiedContent(f.content, basename);
  }

  // 多文件：判断主要变更类型
  // 新增为主
  if (added.length > 0 && added.length >= deleted.length && added.length >= modified.length) {
    if (added.length === files.length) {
      return `feat: add ${added.length} new modules`;
    }
    return `feat: add ${added.length} new modules`;
  }
  // 删除为主
  if (deleted.length > 0 && deleted.length > added.length && deleted.length > modified.length) {
    return `chore: remove ${deleted.length} files`;
  }
  // 修改为主 — 跨文件分析
  // 检查 import 变更
  if (files.some(f => /^[+-]\s*import\s/m.test(f.content) || /^[+-]\s*from\s/m.test(f.content) || /^[+-]\s*require\(/m.test(f.content))) {
    return `refactor: adjust imports in ${files.length} files`;
  }
  // 检查 fix 关键词
  const fixFiles = files.filter(f => /^\+.*\b(fix|bug|error)\b/im.test(f.content));
  if (fixFiles.length > 0) {
    return `fix: resolve issues in ${fixFiles.length} files`;
  }
  // 检查测试新增
  const testFiles = files.filter(f => /^\+\s*(describe|it|test)\s*\(/m.test(f.content));
  if (testFiles.length > 0) {
    return `test: add tests for ${testFiles.length} files`;
  }
  // 检查新 function/class
  const featFiles = files.filter(f =>
    /^\+\s*(?:export\s+)?(?:async\s+)?function\s+\w+/m.test(f.content) ||
    /^\+\s*(?:export\s+)?class\s+\w+/m.test(f.content),
  );
  if (featFiles.length > 0) {
    return `feat: add new functionality in ${featFiles.length} files`;
  }
  return `refactor: update ${files.length} files`;
}

/** 分析修改文件的 diff 内容生成 message */
function analyzeModifiedContent(content: string, basename: string): string {
  // import 变更
  if (/^[+-]\s*import\s/m.test(content) || /^[+-]\s*from\s/m.test(content) || /^[+-]\s*require\(/m.test(content)) {
    return `refactor: adjust imports`;
  }
  // 测试新增
  if (/^\+\s*(describe|it|test)\s*\(/m.test(content)) {
    return `test: add tests`;
  }
  // 新 function
  const fnMatch = content.match(/^\+\s*(?:export\s+)?(?:async\s+)?function\s+(\w+)/m);
  if (fnMatch) {
    return `feat: add ${fnMatch[1]}`;
  }
  // 新 class
  const clsMatch = content.match(/^\+\s*(?:export\s+)?class\s+(\w+)/m);
  if (clsMatch) {
    return `feat: add ${clsMatch[1]}`;
  }
  // fix 关键词
  const fixMatch = content.match(/^\+.*\b(fix|bug|error)\b/im);
  if (fixMatch) {
    return `fix: resolve ${fixMatch[1].toLowerCase()}`;
  }
  return `refactor: update ${basename}`;
}

// ============ 单例管理 ============

let _instance: GitAssistant | null = null;

/** 获取 GitAssistant 单例 */
export function getGitAssistant(): GitAssistant {
  if (!_instance) {
    _instance = new GitAssistant();
  }
  return _instance;
}

/** 重置单例（主要用于测试） */
export function resetGitAssistant(): void {
  if (_instance) {
    try { _instance.dispose(); } catch { /* ignore */ }
  }
  _instance = null;
}

/** 模块级便捷方法：获取单例的工具定义 */
export function getGitAssistantToolDefinitions(): ToolDef[] {
  return getGitAssistant().getToolDefinitions();
}

/**
 * 创建 GitAssistant 工具处理器 — 返回 (toolName, args) => Promise<string>
 * 用于外部 dispatch（如 ToolRegistryAdapter 或测试）
 */
export function createGitAssistantToolHandler(): (
  toolName: string,
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  args: any,
) => Promise<string> {
  const assistant = getGitAssistant();
  const defs = assistant.getToolDefinitions();
  const handlerMap = new Map<string, (args: unknown) => Promise<string>>();
  for (const def of defs) {
    handlerMap.set(def.name, def.execute);
  }
  return async (toolName: string, args: unknown) => {
    const fn = handlerMap.get(toolName);
    if (!fn) {
      return JSON.stringify({ error: `unknown git tool: ${toolName}` });
    }
    return fn(args);
  };
}
