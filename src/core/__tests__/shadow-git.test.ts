/**
 * ShadowGit 测试 — 模拟 git 命令响应，不依赖真实 git 仓库
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

// Mock child_process.execSync — 必须在导入 ShadowGit 之前
vi.mock('child_process', () => ({
  execSync: vi.fn(),
}));

import { execSync } from 'child_process';
import { ShadowGit } from '../shadow-git.js';

const mockedExecSync = vi.mocked(execSync);

/** 将简单 (cmd) => string 函数安装为 execSync mock 实现 */
function mockGit(fn: (cmd: string) => string): void {
  mockedExecSync.mockImplementation(fn as unknown as typeof execSync);
}

/** 默认 git mock：git 可用，仓库已存在，无变更 */
function defaultGitMock(cmd: string): string {
  if (cmd === 'git --version') return 'git version 2.0.0\n';
  if (cmd === 'git rev-parse --git-dir') return '.git\n';
  if (cmd.startsWith('git config')) return '';
  if (cmd.startsWith('git rev-parse --abbrev-ref')) return 'main\n';
  if (cmd === 'git rev-parse HEAD') return 'abcdef1234567890abcdef1234567890abcdef12\n';
  // git rev-parse <checkpointId> (无 -- 参数)
  if (cmd.startsWith('git rev-parse ') && !cmd.includes('--')) {
    return 'abcdef1234567890abcdef1234567890abcdef12\n';
  }
  if (cmd.startsWith('git log -1')) return 'abc1234 test message\n';
  if (cmd.startsWith('git log --grep')) return '';
  if (cmd.startsWith('git add')) return '';
  if (cmd === 'git status --porcelain') return '';
  if (cmd.startsWith('git commit')) return '';
  if (cmd.startsWith('git checkout')) return '';
  if (cmd.startsWith('git diff --stat')) return '1 file changed, 1 insertion(+)\n';
  if (cmd.startsWith('git diff ')) return 'diff --git a/file b/file\n+line\n';
  if (cmd.startsWith('git init')) return '';
  return '';
}

describe('ShadowGit', () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'shadow-git-test-'));
    mockedExecSync.mockClear();
    mockGit(defaultGitMock);
  });

  afterEach(() => {
    try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch {}
  });

  // ============ 构造函数 ============
  describe('constructor', () => {
    it('使用自定义 projectRoot', () => {
      const sg = new ShadowGit(tmpDir);
      sg.getCurrentState();
      const calls = mockedExecSync.mock.calls;
      const withCwd = calls.filter(c => (c[1] as { cwd?: string })?.cwd === tmpDir);
      expect(withCwd.length).toBeGreaterThan(0);
    });

    it('未提供 projectRoot 时使用 process.cwd()', () => {
      const sg = new ShadowGit();
      sg.getCurrentState();
      const calls = mockedExecSync.mock.calls;
      const withCwd = calls.filter(c => (c[1] as { cwd?: string })?.cwd === process.cwd());
      expect(withCwd.length).toBeGreaterThan(0);
    });
  });

  // ============ createCheckpoint ============
  describe('createCheckpoint', () => {
    it('成功创建检查点并返回正确结构', () => {
      mockGit(cmd => {
        if (cmd === 'git --version') return 'git version 2.0.0\n';
        if (cmd === 'git rev-parse --git-dir') return '.git\n';
        if (cmd.startsWith('git config')) return '';
        if (cmd === 'git status --porcelain') return ' M file1.txt\n M file2.txt\n';
        if (cmd.startsWith('git commit')) return '[main abc1234] msg\n';
        if (cmd === 'git rev-parse HEAD') return 'abcdef1234567890abcdef1234567890abcdef12\n';
        return '';
      });
      const sg = new ShadowGit(tmpDir);
      const result = sg.createCheckpoint('test message');
      expect(result.success).toBe(true);
      expect(result.checkpointId).toBe('abcdef123456');
      expect(result.message).toBe('test message');
      expect(result.filesChanged).toBe(2);
      expect(result.timestamp).toBeGreaterThan(0);
    });

    it('无变更时返回失败', () => {
      mockGit(cmd => {
        if (cmd === 'git --version') return 'git version 2.0.0\n';
        if (cmd === 'git rev-parse --git-dir') return '.git\n';
        if (cmd.startsWith('git config')) return '';
        if (cmd === 'git status --porcelain') return '';
        return '';
      });
      const sg = new ShadowGit(tmpDir);
      const result = sg.createCheckpoint('no changes');
      expect(result.success).toBe(false);
      expect(result.checkpointId).toBe('');
      expect(result.message).toContain('没有变更');
    });

    it('git 不可用时返回失败', () => {
      mockGit(() => {
        throw new Error('git not found');
      });
      const sg = new ShadowGit(tmpDir);
      const result = sg.createCheckpoint('test');
      expect(result.success).toBe(false);
      expect(result.message).toContain('Git 不可用');
    });

    it('暂存指定文件列表', () => {
      const addCalls: string[] = [];
      mockGit(cmd => {
        if (cmd === 'git --version') return 'git version 2.0.0\n';
        if (cmd === 'git rev-parse --git-dir') return '.git\n';
        if (cmd.startsWith('git config')) return '';
        if (cmd.startsWith('git add')) {
          addCalls.push(cmd);
          return '';
        }
        if (cmd === 'git status --porcelain') return 'M file1.txt\n';
        if (cmd.startsWith('git commit')) return '';
        if (cmd === 'git rev-parse HEAD') return 'abcdef1234567890abcdef1234567890abcdef12\n';
        return '';
      });
      const sg = new ShadowGit(tmpDir);
      sg.createCheckpoint('test', ['file1.txt']);
      expect(addCalls.some(c => c.includes('file1.txt'))).toBe(true);
    });

    it('跳过 Windows 保留文件名', () => {
      const addCalls: string[] = [];
      mockGit(cmd => {
        if (cmd === 'git --version') return 'git version 2.0.0\n';
        if (cmd === 'git rev-parse --git-dir') return '.git\n';
        if (cmd.startsWith('git config')) return '';
        if (cmd.startsWith('git add')) {
          addCalls.push(cmd);
          return '';
        }
        if (cmd === 'git status --porcelain') return 'M file1.txt\n';
        if (cmd.startsWith('git commit')) return '';
        if (cmd === 'git rev-parse HEAD') return 'abcdef1234567890abcdef1234567890abcdef12\n';
        return '';
      });
      const sg = new ShadowGit(tmpDir);
      sg.createCheckpoint('test', ['CON', 'PRN', 'AUX', 'file1.txt']);
      expect(addCalls.some(c => c.includes('CON'))).toBe(false);
      expect(addCalls.some(c => c.includes('PRN'))).toBe(false);
      expect(addCalls.some(c => c.includes('AUX'))).toBe(false);
      expect(addCalls.some(c => c.includes('file1.txt'))).toBe(true);
    });

    it('git add 失败时跳过该文件并继续', () => {
      mockGit(cmd => {
        if (cmd === 'git --version') return 'git version 2.0.0\n';
        if (cmd === 'git rev-parse --git-dir') return '.git\n';
        if (cmd.startsWith('git config')) return '';
        if (cmd.startsWith('git add') && cmd.includes('bad-file')) {
          throw new Error('add failed');
        }
        if (cmd.startsWith('git add')) return '';
        if (cmd === 'git status --porcelain') return 'M good-file.txt\n';
        if (cmd.startsWith('git commit')) return '';
        if (cmd === 'git rev-parse HEAD') return 'abcdef1234567890abcdef1234567890abcdef12\n';
        return '';
      });
      const sg = new ShadowGit(tmpDir);
      const result = sg.createCheckpoint('test', ['bad-file', 'good-file.txt']);
      expect(result.success).toBe(true);
    });

    it('成功后更新统计信息', () => {
      mockGit(cmd => {
        if (cmd === 'git --version') return 'git version 2.0.0\n';
        if (cmd === 'git rev-parse --git-dir') return '.git\n';
        if (cmd.startsWith('git config')) return '';
        if (cmd === 'git status --porcelain') return ' M file.txt\n';
        if (cmd.startsWith('git commit')) return '';
        if (cmd === 'git rev-parse HEAD') return 'abcdef1234567890abcdef1234567890abcdef12\n';
        return '';
      });
      const sg = new ShadowGit(tmpDir);
      sg.createCheckpoint('test');
      const stats = sg.getStats();
      expect(stats.totalCheckpoints).toBe(1);
      expect(stats.lastCheckpointTime).not.toBeNull();
      expect(stats.averageFilesPerCheckpoint).toBe(1);
    });

    it('commit 失败时增加 failedCheckpoints 计数', () => {
      mockGit(cmd => {
        if (cmd === 'git --version') return 'git version 2.0.0\n';
        if (cmd === 'git rev-parse --git-dir') return '.git\n';
        if (cmd.startsWith('git config')) return '';
        if (cmd === 'git status --porcelain') return ' M file.txt\n';
        if (cmd.startsWith('git commit')) throw new Error('commit failed');
        if (cmd === 'git rev-parse HEAD') throw new Error('no HEAD');
        return '';
      });
      const sg = new ShadowGit(tmpDir);
      const result = sg.createCheckpoint('test');
      expect(result.success).toBe(false);
      const stats = sg.getStats();
      expect(stats.totalFailedCheckpoints).toBe(1);
    });

    it('未在 git 仓库中时自动初始化', () => {
      let initCalled = false;
      mockGit(cmd => {
        if (cmd === 'git --version') return 'git version 2.0.0\n';
        if (cmd === 'git rev-parse --git-dir') throw new Error('not a git repo');
        if (cmd === 'git init') {
          initCalled = true;
          return '';
        }
        if (cmd.startsWith('git config')) return '';
        if (cmd === 'git status --porcelain') return '';
        return '';
      });
      const sg = new ShadowGit(tmpDir);
      sg.getCurrentState();
      expect(initCalled).toBe(true);
    });
  });

  // ============ restoreCheckpoint ============
  describe('restoreCheckpoint', () => {
    it('成功恢复到指定检查点', () => {
      mockGit(cmd => {
        if (cmd === 'git --version') return 'git version 2.0.0\n';
        if (cmd === 'git rev-parse --git-dir') return '.git\n';
        if (cmd.startsWith('git config')) return '';
        if (cmd.startsWith('git rev-parse ') && !cmd.includes('--')) {
          return 'abcdef1234567890abcdef1234567890abcdef12\n';
        }
        if (cmd.startsWith('git diff --stat')) return ' 2 files changed, 10 insertions(+)\n';
        if (cmd.startsWith('git checkout')) return '';
        return '';
      });
      const sg = new ShadowGit(tmpDir);
      const result = sg.restoreCheckpoint('abcdef123456');
      expect(result.success).toBe(true);
      expect(result.checkpointId).toBe('abcdef123456');
      expect(result.filesChanged).toBe(2);
    });

    it('检查点不存在时返回失败', () => {
      mockGit(cmd => {
        if (cmd === 'git --version') return 'git version 2.0.0\n';
        if (cmd === 'git rev-parse --git-dir') return '.git\n';
        if (cmd.startsWith('git config')) return '';
        if (cmd.startsWith('git rev-parse ') && !cmd.includes('--')) {
          throw new Error('unknown revision');
        }
        return '';
      });
      const sg = new ShadowGit(tmpDir);
      const result = sg.restoreCheckpoint('nonexistent');
      expect(result.success).toBe(false);
      expect(result.message).toContain('不存在');
    });

    it('git checkout 失败时返回失败', () => {
      mockGit(cmd => {
        if (cmd === 'git --version') return 'git version 2.0.0\n';
        if (cmd === 'git rev-parse --git-dir') return '.git\n';
        if (cmd.startsWith('git config')) return '';
        if (cmd.startsWith('git rev-parse ') && !cmd.includes('--')) {
          return 'abcdef1234567890\n';
        }
        if (cmd.startsWith('git diff --stat')) return '';
        if (cmd.startsWith('git checkout')) throw new Error('checkout failed');
        return '';
      });
      const sg = new ShadowGit(tmpDir);
      const result = sg.restoreCheckpoint('abcdef123456');
      expect(result.success).toBe(false);
      expect(result.message).toContain('回滚失败');
    });

    it('git 不可用时返回失败', () => {
      mockGit(() => {
        throw new Error('git not found');
      });
      const sg = new ShadowGit(tmpDir);
      const result = sg.restoreCheckpoint('abcdef123456');
      expect(result.success).toBe(false);
      expect(result.message).toContain('Git 不可用');
    });

    it('成功后更新 restore 统计', () => {
      mockGit(cmd => {
        if (cmd === 'git --version') return 'git version 2.0.0\n';
        if (cmd === 'git rev-parse --git-dir') return '.git\n';
        if (cmd.startsWith('git config')) return '';
        if (cmd.startsWith('git rev-parse ') && !cmd.includes('--')) {
          return 'abcdef1234567890\n';
        }
        if (cmd.startsWith('git diff --stat')) return '';
        if (cmd.startsWith('git checkout')) return '';
        return '';
      });
      const sg = new ShadowGit(tmpDir);
      sg.restoreCheckpoint('abcdef123456');
      const stats = sg.getStats();
      expect(stats.totalRestores).toBe(1);
    });

    it('checkout 失败时增加 failedRestores 计数', () => {
      mockGit(cmd => {
        if (cmd === 'git --version') return 'git version 2.0.0\n';
        if (cmd === 'git rev-parse --git-dir') return '.git\n';
        if (cmd.startsWith('git config')) return '';
        if (cmd.startsWith('git rev-parse ') && !cmd.includes('--')) {
          return 'abcdef1234567890\n';
        }
        if (cmd.startsWith('git diff --stat')) return '';
        if (cmd.startsWith('git checkout')) throw new Error('checkout failed');
        return '';
      });
      const sg = new ShadowGit(tmpDir);
      sg.restoreCheckpoint('abcdef123456');
      const stats = sg.getStats();
      expect(stats.totalFailedRestores).toBe(1);
    });
  });

  // ============ listCheckpoints ============
  describe('listCheckpoints', () => {
    it('无检查点时返回空数组', () => {
      mockGit(cmd => {
        if (cmd === 'git --version') return 'git version 2.0.0\n';
        if (cmd === 'git rev-parse --git-dir') return '.git\n';
        if (cmd.startsWith('git config')) return '';
        if (cmd.startsWith('git log --grep')) return '';
        return '';
      });
      const sg = new ShadowGit(tmpDir);
      const list = sg.listCheckpoints();
      expect(list).toEqual([]);
    });

    it('返回多个检查点条目', () => {
      const hash1 = 'aaaa111122223333444455556666777788889999';
      const hash2 = 'bbbb111122223333444455556666777788889999';
      const logOutput = `${hash1}\n[checkpoint] first\n1700000000\n---END---\n${hash2}\n[checkpoint] second\n1700000100\n---END---\n`;
      mockGit(cmd => {
        if (cmd === 'git --version') return 'git version 2.0.0\n';
        if (cmd === 'git rev-parse --git-dir') return '.git\n';
        if (cmd.startsWith('git config')) return '';
        if (cmd.startsWith('git log --grep')) return logOutput;
        if (cmd.startsWith('git diff --stat')) return '1 file changed\n';
        return '';
      });
      const sg = new ShadowGit(tmpDir);
      const list = sg.listCheckpoints();
      expect(list.length).toBe(2);
      expect(list[0].id).toBe(hash1.substring(0, 12));
      expect(list[0].hash).toBe(hash1);
      expect(list[0].message).toBe('first');
      expect(list[0].timestamp).toBe(1700000000 * 1000);
      expect(list[1].message).toBe('second');
    });

    it('limit 参数限制返回数量', () => {
      const parts: string[] = [];
      for (let i = 0; i < 5; i++) {
        const hash = `hash${i}111222333444555666777888999000`;
        parts.push(`${hash}\n[checkpoint] cp${i}\n1700000000\n---END---`);
      }
      const logOutput = parts.join('\n') + '\n';
      mockGit(cmd => {
        if (cmd === 'git --version') return 'git version 2.0.0\n';
        if (cmd === 'git rev-parse --git-dir') return '.git\n';
        if (cmd.startsWith('git config')) return '';
        if (cmd.startsWith('git log --grep')) return logOutput;
        if (cmd.startsWith('git diff --stat')) return '1 file changed\n';
        return '';
      });
      const sg = new ShadowGit(tmpDir);
      const list = sg.listCheckpoints(3);
      expect(list.length).toBe(3);
    });

    it('git 不可用时返回空数组', () => {
      mockGit(() => {
        throw new Error('git not found');
      });
      const sg = new ShadowGit(tmpDir);
      const list = sg.listCheckpoints();
      expect(list).toEqual([]);
    });

    it('默认 limit 为 20', () => {
      let requestedLimit = 0;
      mockGit(cmd => {
        if (cmd === 'git --version') return 'git version 2.0.0\n';
        if (cmd === 'git rev-parse --git-dir') return '.git\n';
        if (cmd.startsWith('git config')) return '';
        if (cmd.startsWith('git log --grep')) {
          const match = cmd.match(/-n (\d+)/);
          if (match) requestedLimit = parseInt(match[1], 10);
          return '';
        }
        return '';
      });
      const sg = new ShadowGit(tmpDir);
      sg.listCheckpoints();
      // limit * 3 = 20 * 3 = 60
      expect(requestedLimit).toBe(60);
    });
  });

  // ============ diffCheckpoints ============
  describe('diffCheckpoints', () => {
    it('返回两个检查点之间的差异', () => {
      mockGit(cmd => {
        if (cmd === 'git --version') return 'git version 2.0.0\n';
        if (cmd === 'git rev-parse --git-dir') return '.git\n';
        if (cmd.startsWith('git config')) return '';
        if (cmd.startsWith('git rev-parse ') && !cmd.includes('--')) {
          return 'abcdef1234567890\n';
        }
        if (cmd.startsWith('git diff --stat')) return '1 file changed, 5 insertions(+)\n';
        if (cmd.startsWith('git diff ')) return 'diff --git a/file b/file\n+added line\n';
        return '';
      });
      const sg = new ShadowGit(tmpDir);
      const result = sg.diffCheckpoints('from123', 'to456');
      expect(result).toContain('from123');
      expect(result).toContain('to456');
      expect(result).toContain('差异统计');
      expect(result).toContain('详细差异');
    });

    it('无效检查点 ID 时返回错误信息', () => {
      mockGit(cmd => {
        if (cmd === 'git --version') return 'git version 2.0.0\n';
        if (cmd === 'git rev-parse --git-dir') return '.git\n';
        if (cmd.startsWith('git config')) return '';
        if (cmd.startsWith('git rev-parse ') && cmd.includes('invalid')) {
          throw new Error('unknown revision');
        }
        if (cmd.startsWith('git rev-parse ') && !cmd.includes('--')) {
          return 'abcdef123456\n';
        }
        return '';
      });
      const sg = new ShadowGit(tmpDir);
      const result = sg.diffCheckpoints('invalid', 'to456');
      expect(result).toContain('无效的检查点');
    });

    it('git 不可用时返回错误信息', () => {
      mockGit(() => {
        throw new Error('git not found');
      });
      const sg = new ShadowGit(tmpDir);
      const result = sg.diffCheckpoints('from', 'to');
      expect(result).toContain('Git 不可用');
    });

    it('截断过长的 diff 输出', () => {
      const longDiff = 'x'.repeat(6000);
      mockGit(cmd => {
        if (cmd === 'git --version') return 'git version 2.0.0\n';
        if (cmd === 'git rev-parse --git-dir') return '.git\n';
        if (cmd.startsWith('git config')) return '';
        if (cmd.startsWith('git rev-parse ') && !cmd.includes('--')) {
          return 'abcdef1234567890\n';
        }
        if (cmd.startsWith('git diff --stat')) return '1 file changed\n';
        if (cmd.startsWith('git diff ')) return longDiff;
        return '';
      });
      const sg = new ShadowGit(tmpDir);
      const result = sg.diffCheckpoints('from', 'to');
      expect(result).toContain('已截断');
    });
  });

  // ============ getCurrentState ============
  describe('getCurrentState', () => {
    it('返回当前 git 状态', () => {
      mockGit(cmd => {
        if (cmd === 'git --version') return 'git version 2.0.0\n';
        if (cmd === 'git rev-parse --git-dir') return '.git\n';
        if (cmd.startsWith('git config')) return '';
        if (cmd.startsWith('git rev-parse --abbrev-ref')) return 'main\n';
        if (cmd.startsWith('git log -1')) return 'abc1234 test message\n';
        if (cmd === 'git status --porcelain') return ' M file1.txt\n M file2.txt\n';
        return '';
      });
      const sg = new ShadowGit(tmpDir);
      const state = sg.getCurrentState();
      expect(state.branch).toBe('main');
      expect(state.lastCommit).toBe('abc1234 test message');
      expect(state.uncommittedChanges).toBe(2);
      expect(state.isClean).toBe(false);
    });

    it('无未提交变更时返回 clean 状态', () => {
      mockGit(cmd => {
        if (cmd === 'git --version') return 'git version 2.0.0\n';
        if (cmd === 'git rev-parse --git-dir') return '.git\n';
        if (cmd.startsWith('git config')) return '';
        if (cmd.startsWith('git rev-parse --abbrev-ref')) return 'main\n';
        if (cmd.startsWith('git log -1')) return 'abc1234 msg\n';
        if (cmd === 'git status --porcelain') return '';
        return '';
      });
      const sg = new ShadowGit(tmpDir);
      const state = sg.getCurrentState();
      expect(state.uncommittedChanges).toBe(0);
      expect(state.isClean).toBe(true);
    });

    it('git 不可用时返回不可用状态', () => {
      mockGit(() => {
        throw new Error('git not found');
      });
      const sg = new ShadowGit(tmpDir);
      const state = sg.getCurrentState();
      expect(state.branch).toBe('(不可用)');
      expect(state.isClean).toBe(false);
    });

    it('git 命令出错时返回失败状态', () => {
      mockGit(cmd => {
        if (cmd === 'git --version') return 'git version 2.0.0\n';
        if (cmd === 'git rev-parse --git-dir') return '.git\n';
        if (cmd.startsWith('git config')) return '';
        if (cmd.startsWith('git rev-parse --abbrev-ref')) throw new Error('error');
        return '';
      });
      const sg = new ShadowGit(tmpDir);
      const state = sg.getCurrentState();
      expect(state.branch).toBe('(获取失败)');
      expect(state.uncommittedChanges).toBe(-1);
    });
  });

  // ============ getStats ============
  describe('getStats', () => {
    it('初始统计全部为 0', () => {
      const sg = new ShadowGit(tmpDir);
      const stats = sg.getStats();
      expect(stats.totalCheckpoints).toBe(0);
      expect(stats.totalRestores).toBe(0);
      expect(stats.totalFailedCheckpoints).toBe(0);
      expect(stats.totalFailedRestores).toBe(0);
      expect(stats.lastCheckpointTime).toBeNull();
      expect(stats.averageFilesPerCheckpoint).toBe(0);
    });

    it('计算平均变更文件数', () => {
      let statusCallCount = 0;
      mockGit(cmd => {
        if (cmd === 'git --version') return 'git version 2.0.0\n';
        if (cmd === 'git rev-parse --git-dir') return '.git\n';
        if (cmd.startsWith('git config')) return '';
        if (cmd === 'git status --porcelain') {
          statusCallCount++;
          return statusCallCount === 1
            ? ' M a.txt\n'
            : ' M a.txt\n M b.txt\n M c.txt\n';
        }
        if (cmd.startsWith('git commit')) return '';
        if (cmd === 'git rev-parse HEAD') return 'abcdef1234567890abcdef1234567890abcdef12\n';
        return '';
      });
      const sg = new ShadowGit(tmpDir);
      sg.createCheckpoint('cp1');
      sg.createCheckpoint('cp2');
      const stats = sg.getStats();
      expect(stats.totalCheckpoints).toBe(2);
      // (1 + 3) / 2 = 2
      expect(stats.averageFilesPerCheckpoint).toBe(2);
    });
  });

  // ============ getToolDefinitions ============
  describe('getToolDefinitions', () => {
    it('返回 4 个工具定义', () => {
      const sg = new ShadowGit(tmpDir);
      const tools = sg.getToolDefinitions();
      expect(tools.length).toBe(4);
    });

    it('工具名称正确', () => {
      const sg = new ShadowGit(tmpDir);
      const tools = sg.getToolDefinitions();
      const names = tools.map(t => t.name);
      expect(names).toContain('checkpoint_create');
      expect(names).toContain('checkpoint_restore');
      expect(names).toContain('checkpoint_list');
      expect(names).toContain('checkpoint_diff');
    });

    it('list 和 diff 标记为 readOnly', () => {
      const sg = new ShadowGit(tmpDir);
      const tools = sg.getToolDefinitions();
      const listTool = tools.find(t => t.name === 'checkpoint_list');
      const diffTool = tools.find(t => t.name === 'checkpoint_diff');
      expect(listTool?.readOnly).toBe(true);
      expect(diffTool?.readOnly).toBe(true);
    });

    it('create 和 restore 不是 readOnly', () => {
      const sg = new ShadowGit(tmpDir);
      const tools = sg.getToolDefinitions();
      const createTool = tools.find(t => t.name === 'checkpoint_create');
      const restoreTool = tools.find(t => t.name === 'checkpoint_restore');
      expect(createTool?.readOnly).toBeUndefined();
      expect(restoreTool?.readOnly).toBeUndefined();
    });

    it('每个工具有 description 和 parameters', () => {
      const sg = new ShadowGit(tmpDir);
      const tools = sg.getToolDefinitions();
      for (const tool of tools) {
        expect(tool.description.length).toBeGreaterThan(0);
        expect(Object.keys(tool.parameters).length).toBeGreaterThan(0);
        expect(typeof tool.execute).toBe('function');
      }
    });
  });

  // ============ 工具 execute 函数 ============
  describe('工具 execute 函数', () => {
    it('checkpoint_create 成功时返回成功消息', async () => {
      mockGit(cmd => {
        if (cmd === 'git --version') return 'git version 2.0.0\n';
        if (cmd === 'git rev-parse --git-dir') return '.git\n';
        if (cmd.startsWith('git config')) return '';
        if (cmd === 'git status --porcelain') return ' M file.txt\n';
        if (cmd.startsWith('git commit')) return '';
        if (cmd === 'git rev-parse HEAD') return 'abcdef1234567890abcdef1234567890abcdef12\n';
        return '';
      });
      const sg = new ShadowGit(tmpDir);
      const tools = sg.getToolDefinitions();
      const createTool = tools.find(t => t.name === 'checkpoint_create')!;
      const result = await createTool.execute({ message: 'test' });
      expect(result).toContain('检查点已创建');
      expect(result).toContain('abcdef123456');
    });

    it('checkpoint_create 失败时返回错误消息', async () => {
      mockGit(() => {
        throw new Error('git not found');
      });
      const sg = new ShadowGit(tmpDir);
      const tools = sg.getToolDefinitions();
      const createTool = tools.find(t => t.name === 'checkpoint_create')!;
      const result = await createTool.execute({ message: 'test' });
      expect(result).toContain('❌');
    });

    it('checkpoint_restore 成功时返回回滚消息', async () => {
      mockGit(cmd => {
        if (cmd === 'git --version') return 'git version 2.0.0\n';
        if (cmd === 'git rev-parse --git-dir') return '.git\n';
        if (cmd.startsWith('git config')) return '';
        if (cmd.startsWith('git rev-parse ') && !cmd.includes('--')) {
          return 'abcdef1234567890\n';
        }
        if (cmd.startsWith('git diff --stat')) return '1 file changed\n';
        if (cmd.startsWith('git checkout')) return '';
        return '';
      });
      const sg = new ShadowGit(tmpDir);
      const tools = sg.getToolDefinitions();
      const restoreTool = tools.find(t => t.name === 'checkpoint_restore')!;
      const result = await restoreTool.execute({ checkpoint_id: 'abcdef123456' });
      expect(result).toContain('已回滚');
    });

    it('checkpoint_restore 失败时返回错误消息', async () => {
      mockGit(cmd => {
        if (cmd === 'git --version') return 'git version 2.0.0\n';
        if (cmd === 'git rev-parse --git-dir') return '.git\n';
        if (cmd.startsWith('git config')) return '';
        if (cmd.startsWith('git rev-parse ') && !cmd.includes('--')) {
          throw new Error('unknown revision');
        }
        return '';
      });
      const sg = new ShadowGit(tmpDir);
      const tools = sg.getToolDefinitions();
      const restoreTool = tools.find(t => t.name === 'checkpoint_restore')!;
      const result = await restoreTool.execute({ checkpoint_id: 'nonexistent' });
      expect(result).toContain('❌');
    });

    it('checkpoint_list 空列表时返回暂无消息', async () => {
      mockGit(cmd => {
        if (cmd === 'git --version') return 'git version 2.0.0\n';
        if (cmd === 'git rev-parse --git-dir') return '.git\n';
        if (cmd.startsWith('git config')) return '';
        if (cmd.startsWith('git log --grep')) return '';
        return '';
      });
      const sg = new ShadowGit(tmpDir);
      const tools = sg.getToolDefinitions();
      const listTool = tools.find(t => t.name === 'checkpoint_list')!;
      const result = await listTool.execute({});
      expect(result).toContain('暂无检查点');
    });

    it('checkpoint_list 有条目时返回列表', async () => {
      const hash = 'aaaa111122223333444455556666777788889999';
      const logOutput = `${hash}\n[checkpoint] test cp\n1700000000\n---END---\n`;
      mockGit(cmd => {
        if (cmd === 'git --version') return 'git version 2.0.0\n';
        if (cmd === 'git rev-parse --git-dir') return '.git\n';
        if (cmd.startsWith('git config')) return '';
        if (cmd.startsWith('git log --grep')) return logOutput;
        if (cmd.startsWith('git diff --stat')) return '1 file changed\n';
        return '';
      });
      const sg = new ShadowGit(tmpDir);
      const tools = sg.getToolDefinitions();
      const listTool = tools.find(t => t.name === 'checkpoint_list')!;
      const result = await listTool.execute({ limit: 5 });
      expect(result).toContain('test cp');
      expect(result).toContain('检查点');
    });

    it('checkpoint_diff 返回差异内容', async () => {
      mockGit(cmd => {
        if (cmd === 'git --version') return 'git version 2.0.0\n';
        if (cmd === 'git rev-parse --git-dir') return '.git\n';
        if (cmd.startsWith('git config')) return '';
        if (cmd.startsWith('git rev-parse ') && !cmd.includes('--')) {
          return 'abcdef1234567890\n';
        }
        if (cmd.startsWith('git diff --stat')) return '1 file changed\n';
        if (cmd.startsWith('git diff ')) return 'diff content\n';
        return '';
      });
      const sg = new ShadowGit(tmpDir);
      const tools = sg.getToolDefinitions();
      const diffTool = tools.find(t => t.name === 'checkpoint_diff')!;
      const result = await diffTool.execute({ from_id: 'aaa', to_id: 'bbb' });
      expect(result).toContain('差异');
    });

    it('checkpoint_create 支持 files 参数', async () => {
      const addCalls: string[] = [];
      mockGit(cmd => {
        if (cmd === 'git --version') return 'git version 2.0.0\n';
        if (cmd === 'git rev-parse --git-dir') return '.git\n';
        if (cmd.startsWith('git config')) return '';
        if (cmd.startsWith('git add')) {
          addCalls.push(cmd);
          return '';
        }
        if (cmd === 'git status --porcelain') return 'M test.txt\n';
        if (cmd.startsWith('git commit')) return '';
        if (cmd === 'git rev-parse HEAD') return 'abcdef1234567890abcdef1234567890abcdef12\n';
        return '';
      });
      const sg = new ShadowGit(tmpDir);
      const tools = sg.getToolDefinitions();
      const createTool = tools.find(t => t.name === 'checkpoint_create')!;
      await createTool.execute({ message: 'test', files: ['test.txt'] });
      expect(addCalls.some(c => c.includes('test.txt'))).toBe(true);
    });
  });
});
