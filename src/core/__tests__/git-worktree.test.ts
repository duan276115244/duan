/**
 * GitWorktreeManager 测试 — 模拟 git 命令响应，不依赖真实 git 仓库
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

// Mock child_process.execSync — 必须在导入被测模块之前
vi.mock('child_process', () => ({
  execSync: vi.fn(),
}));

import { execSync } from 'child_process';
import { GitWorktreeManager, WorktreeInfo } from '../git-worktree.js';

const mockedExecSync = vi.mocked(execSync);

/** 将简单 (cmd) => string 函数安装为 execSync mock 实现 */
function mockGit(fn: (cmd: string) => string): void {
  mockedExecSync.mockImplementation(fn as unknown as typeof execSync);
}

/** 默认 git mock：git 可用，仓库已存在，在 main 分支 */
function defaultGitMock(cmd: string): string {
  if (cmd === 'git --version') return 'git version 2.0.0\n';
  if (cmd === 'git rev-parse --git-dir') return '.git\n';
  if (cmd === 'git rev-parse --show-toplevel') return process.cwd() + '\n';
  if (cmd.startsWith('git rev-parse --abbrev-ref')) return 'main\n';
  if (cmd.startsWith('git branch ')) return '';
  if (cmd.startsWith('git worktree add')) return '';
  if (cmd.startsWith('git worktree remove')) return '';
  if (cmd.startsWith('git worktree prune')) return '';
  if (cmd.startsWith('git branch -D')) return '';
  if (cmd.startsWith('git add')) return '';
  if (cmd.startsWith('git commit')) return '';
  if (cmd.startsWith('git checkout')) return '';
  if (cmd.startsWith('git merge')) return 'Updating abc..def\nFast-forward\n';
  if (cmd.startsWith('git rebase')) return 'Successfully rebased and updated refs/heads/main\n';
  if (cmd.startsWith('git stash')) return '';
  if (cmd === 'git status --porcelain') return '';
  if (cmd.startsWith('git diff --name-only --diff-filter=U')) return '';
  if (cmd.startsWith('git diff --name-only HEAD~1..HEAD')) return 'file1.ts\nfile2.ts\n';
  if (cmd.includes('--stat') && cmd.startsWith('git diff')) return '2 files changed, 5 insertions(+)\n';
  if (cmd.includes('--name-status') && cmd.startsWith('git diff')) return 'M\tfile1.ts\nA\tfile2.ts\n';
  if (cmd.startsWith('git diff ')) return 'diff --git a/f b/f\n+line\n';
  return '';
}

/** 在 tmpDir/.duan/worktrees.json 写入 worktree 状态，并创建对应目录 */
function setupWorktreeState(tmpDir: string, worktrees: WorktreeInfo[]): void {
  const duanDir = path.join(tmpDir, '.duan');
  fs.mkdirSync(duanDir, { recursive: true });
  fs.writeFileSync(
    path.join(duanDir, 'worktrees.json'),
    JSON.stringify(worktrees),
  );
  for (const wt of worktrees) {
    fs.mkdirSync(wt.path, { recursive: true });
  }
}

/** 生成一个 WorktreeInfo，path 位于 tmpDir 内 */
function makeWorktree(tmpDir: string, name: string, overrides: Partial<WorktreeInfo> = {}): WorktreeInfo {
  const now = Date.now();
  return {
    name,
    path: path.join(tmpDir, '.duan', 'worktrees', name),
    branch: `duan/task-${name}`,
    baseBranch: 'main',
    status: 'active',
    createdAt: now,
    lastActivity: now,
    ...overrides,
  };
}

describe('GitWorktreeManager', () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'worktree-test-'));
    mockedExecSync.mockReset();
    mockGit(defaultGitMock);
  });

  afterEach(() => {
    try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch { /* ignore */ }
    vi.restoreAllMocks();
  });

  // ============ 构造函数 ============
  describe('constructor', () => {
    it('使用自定义 repoRoot', () => {
      const mgr = new GitWorktreeManager(tmpDir);
      mgr.init();
      const calls = mockedExecSync.mock.calls;
      const withCwd = calls.filter(c => (c[1] as { cwd?: string })?.cwd === tmpDir);
      expect(withCwd.length).toBeGreaterThan(0);
    });

    it('未提供 repoRoot 时调用 git rev-parse --show-toplevel', () => {
      mockGit(cmd => {
        if (cmd === 'git rev-parse --show-toplevel') return tmpDir + '\n';
        return defaultGitMock(cmd);
      });
      const mgr = new GitWorktreeManager();
      expect(mgr).toBeDefined();
      // findRepoRoot 应被调用
      expect(mockedExecSync.mock.calls.some(c => c[0] === 'git rev-parse --show-toplevel')).toBe(true);
    });
  });

  // ============ init ============
  describe('init', () => {
    it('成功初始化返回 true', () => {
      const mgr = new GitWorktreeManager(tmpDir);
      expect(mgr.init()).toBe(true);
    });

    it('git 不可用时返回 false', () => {
      mockGit(() => {
        throw new Error('git not found');
      });
      const mgr = new GitWorktreeManager(tmpDir);
      expect(mgr.init()).toBe(false);
    });

    it('不在 git 仓库中时返回 false', () => {
      mockGit(cmd => {
        if (cmd === 'git --version') return 'git version 2.0.0\n';
        if (cmd === 'git rev-parse --git-dir') throw new Error('not a git repo');
        return '';
      });
      const mgr = new GitWorktreeManager(tmpDir);
      expect(mgr.init()).toBe(false);
    });

    it('重复调用 init 是幂等的', () => {
      const mgr = new GitWorktreeManager(tmpDir);
      const first = mgr.init();
      const second = mgr.init();
      expect(first).toBe(second);
    });
  });

  // ============ createWorktree ============
  describe('createWorktree', () => {
    it('成功创建 worktree', () => {
      const mgr = new GitWorktreeManager(tmpDir);
      const result = mgr.createWorktree('wt1', 'feature-branch');
      expect(result.success).toBe(true);
      expect(result.worktree).toBeDefined();
      expect(result.worktree!.name).toBe('wt1');
      expect(result.worktree!.branch).toBe('feature-branch');
      expect(result.worktree!.status).toBe('active');
    });

    it('名称已存在时返回失败', () => {
      setupWorktreeState(tmpDir, [makeWorktree(tmpDir, 'wt1')]);
      const mgr = new GitWorktreeManager(tmpDir);
      const result = mgr.createWorktree('wt1');
      expect(result.success).toBe(false);
      expect(result.error).toContain('已存在');
    });

    it('git branch 命令失败时返回失败', () => {
      mockGit(cmd => {
        if (cmd.startsWith('git branch ')) throw new Error('branch exists');
        return defaultGitMock(cmd);
      });
      const mgr = new GitWorktreeManager(tmpDir);
      const result = mgr.createWorktree('wt1');
      expect(result.success).toBe(false);
      expect(result.error).toContain('创建 worktree 失败');
    });

    it('git worktree add 失败时返回失败', () => {
      mockGit(cmd => {
        if (cmd.startsWith('git worktree add')) throw new Error('worktree add failed');
        return defaultGitMock(cmd);
      });
      const mgr = new GitWorktreeManager(tmpDir);
      const result = mgr.createWorktree('wt1');
      expect(result.success).toBe(false);
      expect(result.error).toContain('创建 worktree 失败');
    });

    it('taskDescription 参数被保存', () => {
      const mgr = new GitWorktreeManager(tmpDir);
      const result = mgr.createWorktree('wt1', undefined, '实现登录功能');
      expect(result.success).toBe(true);
      expect(result.worktree!.taskDescription).toBe('实现登录功能');
    });

    it('未提供 branch 时自动生成 duan/task-{timestamp}', () => {
      const mgr = new GitWorktreeManager(tmpDir);
      const result = mgr.createWorktree('wt1');
      expect(result.success).toBe(true);
      expect(result.worktree!.branch).toMatch(/^duan\/task-\d+$/);
    });

    it('git 不可用时返回失败', () => {
      mockGit(() => {
        throw new Error('git not found');
      });
      const mgr = new GitWorktreeManager(tmpDir);
      const result = mgr.createWorktree('wt1');
      expect(result.success).toBe(false);
      expect(result.error).toContain('Git 不可用');
    });
  });

  // ============ removeWorktree ============
  describe('removeWorktree', () => {
    it('成功删除 worktree', () => {
      const wt = makeWorktree(tmpDir, 'wt1');
      setupWorktreeState(tmpDir, [wt]);
      const mgr = new GitWorktreeManager(tmpDir);
      const result = mgr.removeWorktree('wt1');
      expect(result.success).toBe(true);
      expect(result.output).toContain('已移除');
    });

    it('不存在的 worktree 返回失败', () => {
      const mgr = new GitWorktreeManager(tmpDir);
      const result = mgr.removeWorktree('nonexistent');
      expect(result.success).toBe(false);
      expect(result.error).toContain('不存在');
    });

    it('deleteBranch=true 时删除关联分支', () => {
      const wt = makeWorktree(tmpDir, 'wt1');
      setupWorktreeState(tmpDir, [wt]);
      const branchDeleteCalls: string[] = [];
      mockGit(cmd => {
        if (cmd.startsWith('git branch -D')) branchDeleteCalls.push(cmd);
        return defaultGitMock(cmd);
      });
      const mgr = new GitWorktreeManager(tmpDir);
      mgr.removeWorktree('wt1', true);
      expect(branchDeleteCalls.length).toBeGreaterThan(0);
    });

    it('deleteBranch=false 时保留关联分支', () => {
      const wt = makeWorktree(tmpDir, 'wt1');
      setupWorktreeState(tmpDir, [wt]);
      const branchDeleteCalls: string[] = [];
      mockGit(cmd => {
        if (cmd.startsWith('git branch -D')) branchDeleteCalls.push(cmd);
        return defaultGitMock(cmd);
      });
      const mgr = new GitWorktreeManager(tmpDir);
      mgr.removeWorktree('wt1', false);
      expect(branchDeleteCalls.length).toBe(0);
    });

    it('git worktree remove 失败时回退到手动清理', () => {
      const wt = makeWorktree(tmpDir, 'wt1');
      setupWorktreeState(tmpDir, [wt]);
      let pruneCalled = false;
      mockGit(cmd => {
        if (cmd.startsWith('git worktree remove')) throw new Error('remove failed');
        if (cmd.startsWith('git worktree prune')) {
          pruneCalled = true;
          return '';
        }
        return defaultGitMock(cmd);
      });
      const mgr = new GitWorktreeManager(tmpDir);
      const result = mgr.removeWorktree('wt1');
      expect(result.success).toBe(true);
      expect(pruneCalled).toBe(true);
    });
  });

  // ============ listWorktrees ============
  describe('listWorktrees', () => {
    it('空列表返回提示信息', () => {
      const mgr = new GitWorktreeManager(tmpDir);
      const result = mgr.listWorktrees();
      expect(result.success).toBe(true);
      expect(result.output).toContain('没有');
    });

    it('多条目时返回列表', () => {
      setupWorktreeState(tmpDir, [
        makeWorktree(tmpDir, 'wt1', { taskDescription: '任务1' }),
        makeWorktree(tmpDir, 'wt2', { status: 'merged' }),
      ]);
      const mgr = new GitWorktreeManager(tmpDir);
      const result = mgr.listWorktrees();
      expect(result.success).toBe(true);
      expect(result.output).toContain('wt1');
      expect(result.output).toContain('wt2');
      expect(result.output).toContain('任务1');
    });

    it('git 不可用时返回失败', () => {
      mockGit(() => {
        throw new Error('git not found');
      });
      const mgr = new GitWorktreeManager(tmpDir);
      const result = mgr.listWorktrees();
      expect(result.success).toBe(false);
      expect(result.error).toContain('Git 不可用');
    });
  });

  // ============ executeInWorktree ============
  describe('executeInWorktree', () => {
    it('成功执行命令并返回输出', () => {
      const wt = makeWorktree(tmpDir, 'wt1');
      setupWorktreeState(tmpDir, [wt]);
      mockGit(cmd => {
        if (cmd === 'git --version') return 'git version 2.0.0\n';
        if (cmd === 'git rev-parse --git-dir') return '.git\n';
        if (cmd === 'echo hello') return 'hello\n';
        return '';
      });
      const mgr = new GitWorktreeManager(tmpDir);
      const result = mgr.executeInWorktree('wt1', 'echo hello');
      expect(result.success).toBe(true);
      expect(result.output).toContain('hello');
    });

    it('不存在的 worktree 返回失败', () => {
      const mgr = new GitWorktreeManager(tmpDir);
      const result = mgr.executeInWorktree('nonexistent', 'ls');
      expect(result.success).toBe(false);
      expect(result.error).toContain('不存在');
    });

    it('状态非 active 时返回失败', () => {
      const wt = makeWorktree(tmpDir, 'wt1', { status: 'merged' });
      setupWorktreeState(tmpDir, [wt]);
      const mgr = new GitWorktreeManager(tmpDir);
      const result = mgr.executeInWorktree('wt1', 'ls');
      expect(result.success).toBe(false);
      expect(result.error).toContain('merged');
    });

    it('目录不存在时标记为 stale', () => {
      // 在状态文件中声明 worktree，但不创建目录
      const wt = makeWorktree(tmpDir, 'wt1');
      const duanDir = path.join(tmpDir, '.duan');
      fs.mkdirSync(duanDir, { recursive: true });
      fs.writeFileSync(path.join(duanDir, 'worktrees.json'), JSON.stringify([wt]));
      // 不创建 wt.path 目录
      const mgr = new GitWorktreeManager(tmpDir);
      const result = mgr.executeInWorktree('wt1', 'ls');
      expect(result.success).toBe(false);
      expect(result.error).toContain('stale');
    });

    it('命令执行失败时返回错误输出', () => {
      const wt = makeWorktree(tmpDir, 'wt1');
      setupWorktreeState(tmpDir, [wt]);
      mockGit(cmd => {
        if (cmd === 'git --version') return 'git version 2.0.0\n';
        if (cmd === 'git rev-parse --git-dir') return '.git\n';
        if (cmd === 'failing-command') {
          const err = new Error('Command failed') as Error & { status?: number; stderr?: string; stdout?: string };
          err.status = 1;
          err.stderr = 'error output';
          err.stdout = 'stdout output';
          throw err;
        }
        return '';
      });
      const mgr = new GitWorktreeManager(tmpDir);
      const result = mgr.executeInWorktree('wt1', 'failing-command');
      expect(result.success).toBe(false);
      expect(result.error).toContain('退出码 1');
    });
  });

  // ============ mergeWorktree ============
  describe('mergeWorktree', () => {
    it('merge 策略成功合并', () => {
      const wt = makeWorktree(tmpDir, 'wt1');
      setupWorktreeState(tmpDir, [wt]);
      const mgr = new GitWorktreeManager(tmpDir);
      const result = mgr.mergeWorktree('wt1', 'merge');
      expect(result.success).toBe(true);
      expect(result.output).toContain('merge');
      expect(result.output).toContain('main');
    });

    it('squash 策略成功合并', () => {
      const wt = makeWorktree(tmpDir, 'wt1');
      setupWorktreeState(tmpDir, [wt]);
      const mgr = new GitWorktreeManager(tmpDir);
      const result = mgr.mergeWorktree('wt1', 'squash');
      expect(result.success).toBe(true);
      expect(result.output).toContain('squash');
    });

    it('rebase 策略成功合并', () => {
      const wt = makeWorktree(tmpDir, 'wt1');
      setupWorktreeState(tmpDir, [wt]);
      const mgr = new GitWorktreeManager(tmpDir);
      const result = mgr.mergeWorktree('wt1', 'rebase');
      expect(result.success).toBe(true);
      expect(result.output).toContain('rebase');
    });

    it('合并冲突时返回冲突文件', () => {
      const wt = makeWorktree(tmpDir, 'wt1');
      setupWorktreeState(tmpDir, [wt]);
      mockGit(cmd => {
        if (cmd === 'git --version') return 'git version 2.0.0\n';
        if (cmd === 'git rev-parse --git-dir') return '.git\n';
        if (cmd.startsWith('git rev-parse --abbrev-ref')) return 'main\n';
        if (cmd.startsWith('git checkout')) return '';
        if (cmd.startsWith('git add')) return '';
        if (cmd.startsWith('git commit')) return '';
        if (cmd.startsWith('git merge') && cmd.includes('--no-ff')) throw new Error('merge conflict');
        if (cmd.startsWith('git diff --name-only --diff-filter=U')) return 'conflict-file.ts\n';
        return '';
      });
      const mgr = new GitWorktreeManager(tmpDir);
      const result = mgr.mergeWorktree('wt1', 'merge');
      expect(result.success).toBe(false);
      expect(result.error).toContain('冲突');
      expect(result.output).toContain('conflict-file.ts');
    });

    it('不支持的策略返回失败', () => {
      const wt = makeWorktree(tmpDir, 'wt1');
      setupWorktreeState(tmpDir, [wt]);
      const mgr = new GitWorktreeManager(tmpDir);
      const result = mgr.mergeWorktree('wt1', 'invalid');
      expect(result.success).toBe(false);
      expect(result.error).toContain('不支持的合并策略');
    });

    it('状态非 active 时返回失败', () => {
      const wt = makeWorktree(tmpDir, 'wt1', { status: 'merged' });
      setupWorktreeState(tmpDir, [wt]);
      const mgr = new GitWorktreeManager(tmpDir);
      const result = mgr.mergeWorktree('wt1', 'merge');
      expect(result.success).toBe(false);
      expect(result.error).toContain('merged');
    });
  });

  // ============ getWorktreeDiff ============
  describe('getWorktreeDiff', () => {
    it('成功返回差异', () => {
      const wt = makeWorktree(tmpDir, 'wt1');
      setupWorktreeState(tmpDir, [wt]);
      const mgr = new GitWorktreeManager(tmpDir);
      const result = mgr.getWorktreeDiff('wt1');
      expect(result.success).toBe(true);
      expect(result.output).toContain('差异');
      expect(result.output).toContain('file1.ts');
    });

    it('不存在的 worktree 返回失败', () => {
      const mgr = new GitWorktreeManager(tmpDir);
      const result = mgr.getWorktreeDiff('nonexistent');
      expect(result.success).toBe(false);
      expect(result.error).toContain('不存在');
    });
  });

  // ============ syncWorktree ============
  describe('syncWorktree', () => {
    it('成功同步（无暂存）', () => {
      const wt = makeWorktree(tmpDir, 'wt1');
      setupWorktreeState(tmpDir, [wt]);
      const mgr = new GitWorktreeManager(tmpDir);
      const result = mgr.syncWorktree('wt1');
      expect(result.success).toBe(true);
      expect(result.output).toContain('同步');
    });

    it('有未提交更改时先 stash 再同步', () => {
      const wt = makeWorktree(tmpDir, 'wt1');
      setupWorktreeState(tmpDir, [wt]);
      const stashCalls: string[] = [];
      mockGit(cmd => {
        if (cmd === 'git --version') return 'git version 2.0.0\n';
        if (cmd === 'git rev-parse --git-dir') return '.git\n';
        if (cmd === 'git status --porcelain') return ' M file.ts\n';
        if (cmd.startsWith('git stash')) {
          stashCalls.push(cmd);
          return '';
        }
        if (cmd.startsWith('git rebase')) return 'Successfully rebased\n';
        return '';
      });
      const mgr = new GitWorktreeManager(tmpDir);
      const result = mgr.syncWorktree('wt1');
      expect(result.success).toBe(true);
      expect(stashCalls.some(c => c.includes('stash --include-untracked'))).toBe(true);
      expect(stashCalls.some(c => c.includes('stash pop'))).toBe(true);
    });

    it('rebase 冲突时标记为 conflict', () => {
      const wt = makeWorktree(tmpDir, 'wt1');
      setupWorktreeState(tmpDir, [wt]);
      mockGit(cmd => {
        if (cmd === 'git --version') return 'git version 2.0.0\n';
        if (cmd === 'git rev-parse --git-dir') return '.git\n';
        if (cmd === 'git status --porcelain') return '';
        if (cmd.startsWith('git rebase') && !cmd.includes('--abort')) throw new Error('rebase conflict');
        if (cmd.startsWith('git rebase --abort')) return '';
        return '';
      });
      const mgr = new GitWorktreeManager(tmpDir);
      const result = mgr.syncWorktree('wt1');
      expect(result.success).toBe(false);
      expect(result.error).toContain('冲突');
    });
  });

  // ============ getWorktreePath ============
  describe('getWorktreePath', () => {
    it('返回存在的 worktree 路径', () => {
      const wt = makeWorktree(tmpDir, 'wt1');
      setupWorktreeState(tmpDir, [wt]);
      const mgr = new GitWorktreeManager(tmpDir);
      mgr.init();
      const result = mgr.getWorktreePath('wt1');
      expect(result).toBe(wt.path);
    });

    it('不存在的 worktree 返回 null', () => {
      const mgr = new GitWorktreeManager(tmpDir);
      const result = mgr.getWorktreePath('nonexistent');
      expect(result).toBeNull();
    });
  });

  // ============ getStats ============
  describe('getStats', () => {
    it('返回统计信息字符串', () => {
      setupWorktreeState(tmpDir, [
        makeWorktree(tmpDir, 'wt1', { status: 'active' }),
        makeWorktree(tmpDir, 'wt2', { status: 'merged' }),
      ]);
      const mgr = new GitWorktreeManager(tmpDir);
      mgr.init();
      const stats = mgr.getStats();
      expect(stats).toContain('Worktree 统计');
      expect(stats).toContain('总计: 2');
      expect(stats).toContain('活跃: 1');
      expect(stats).toContain('已合并: 1');
    });
  });

  // ============ getToolDefinitions ============
  describe('getToolDefinitions', () => {
    it('返回 7 个工具定义', () => {
      const mgr = new GitWorktreeManager(tmpDir);
      const tools = mgr.getToolDefinitions();
      expect(tools).toHaveLength(7);
    });

    it('工具名称正确', () => {
      const mgr = new GitWorktreeManager(tmpDir);
      const tools = mgr.getToolDefinitions();
      const names = tools.map(t => t.name);
      expect(names).toEqual([
        'worktree_create', 'worktree_remove', 'worktree_list',
        'worktree_exec', 'worktree_merge', 'worktree_diff', 'worktree_sync',
      ]);
    });

    it('worktree_list 工具是 readOnly', () => {
      const mgr = new GitWorktreeManager(tmpDir);
      const tools = mgr.getToolDefinitions();
      const listTool = tools.find(t => t.name === 'worktree_list');
      expect(listTool?.readOnly).toBe(true);
    });

    it('worktree_create 工具执行成功时返回输出', async () => {
      const mgr = new GitWorktreeManager(tmpDir);
      const tools = mgr.getToolDefinitions();
      const createTool = tools.find(t => t.name === 'worktree_create')!;
      const output = await createTool.execute({ name: 'wt1', branch: 'feat' });
      expect(output).toContain('已创建');
    });

    it('worktree_list 工具执行返回列表', async () => {
      const mgr = new GitWorktreeManager(tmpDir);
      const tools = mgr.getToolDefinitions();
      const listTool = tools.find(t => t.name === 'worktree_list')!;
      const output = await listTool.execute({});
      expect(output).toBeDefined();
    });

    it('worktree_remove 工具执行返回移除信息', async () => {
      const wt = makeWorktree(tmpDir, 'wt1');
      setupWorktreeState(tmpDir, [wt]);
      const mgr = new GitWorktreeManager(tmpDir);
      const tools = mgr.getToolDefinitions();
      const removeTool = tools.find(t => t.name === 'worktree_remove')!;
      const output = await removeTool.execute({ name: 'wt1' });
      expect(output).toContain('已移除');
    });

    it('worktree_exec 工具执行命令返回输出', async () => {
      const wt = makeWorktree(tmpDir, 'wt1');
      setupWorktreeState(tmpDir, [wt]);
      mockGit(cmd => {
        if (cmd === 'git --version') return 'git version 2.0.0\n';
        if (cmd === 'git rev-parse --git-dir') return '.git\n';
        if (cmd === 'echo test') return 'test output\n';
        return '';
      });
      const mgr = new GitWorktreeManager(tmpDir);
      const tools = mgr.getToolDefinitions();
      const execTool = tools.find(t => t.name === 'worktree_exec')!;
      const output = await execTool.execute({ name: 'wt1', command: 'echo test' });
      expect(output).toContain('test output');
    });

    it('worktree_merge 工具执行返回合并结果', async () => {
      const wt = makeWorktree(tmpDir, 'wt1');
      setupWorktreeState(tmpDir, [wt]);
      const mgr = new GitWorktreeManager(tmpDir);
      const tools = mgr.getToolDefinitions();
      const mergeTool = tools.find(t => t.name === 'worktree_merge')!;
      const output = await mergeTool.execute({ name: 'wt1', strategy: 'merge' });
      expect(output).toContain('merge');
    });
  });

  // ============ 持久化 ============
  describe('持久化', () => {
    it('创建 worktree 后状态保存到 .duan/worktrees.json', () => {
      const mgr = new GitWorktreeManager(tmpDir);
      mgr.createWorktree('wt1', 'feat-1', '任务描述');
      const stateFile = path.join(tmpDir, '.duan', 'worktrees.json');
      expect(fs.existsSync(stateFile)).toBe(true);
      const data = JSON.parse(fs.readFileSync(stateFile, 'utf-8'));
      expect(Array.isArray(data)).toBe(true);
      expect(data.length).toBe(1);
      expect(data[0].name).toBe('wt1');
      expect(data[0].branch).toBe('feat-1');
      expect(data[0].taskDescription).toBe('任务描述');
    });

    it('从 .duan/worktrees.json 加载已有状态', () => {
      const wt = makeWorktree(tmpDir, 'preexisting', {
        taskDescription: '预加载任务',
      });
      setupWorktreeState(tmpDir, [wt]);
      const mgr = new GitWorktreeManager(tmpDir);
      mgr.init();
      // 通过 getWorktreePath 验证加载是否成功
      expect(mgr.getWorktreePath('preexisting')).toBe(wt.path);
      // 通过 listWorktrees 验证 taskDescription 被加载
      const list = mgr.listWorktrees();
      expect(list.output).toContain('预加载任务');
    });

    it('删除 worktree 后状态从文件中移除', () => {
      const wt = makeWorktree(tmpDir, 'wt1');
      setupWorktreeState(tmpDir, [wt]);
      const mgr = new GitWorktreeManager(tmpDir);
      mgr.removeWorktree('wt1');
      const stateFile = path.join(tmpDir, '.duan', 'worktrees.json');
      const data = JSON.parse(fs.readFileSync(stateFile, 'utf-8'));
      expect(data.length).toBe(0);
    });
  });
});
