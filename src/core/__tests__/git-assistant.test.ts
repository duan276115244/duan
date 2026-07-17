/**
 * GitAssistant 测试 — 使用真实 git 仓库（非 mock）
 *
 * 测试策略:
 * - 在 beforeEach 中创建 tmpDir + `git init` + 配置 user.name/email
 * - 通过真实 git 命令验证 GitAssistant 行为
 * - 远程相关测试（pull/push/fetch）使用本地 bare 仓库作为 remote
 *
 * 测试隔离:
 * - afterEach: 调用 dispose + `fs.rmSync(tmpDir, { recursive: true, force: true })`
 * - 每个测试使用独立的 tmpDir，避免互相干扰
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { execSync, execFileSync } from 'child_process';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

import {
  GitAssistant,
  getGitAssistant,
  resetGitAssistant,
  getGitAssistantToolDefinitions,
  createGitAssistantToolHandler,
  analyzeDiffAndGenerateMessage,
} from '../git-assistant.js';

/** 在指定目录运行 git 命令（同步，使用 execFileSync 避免 shell 解析问题） */
function gitSync(args: string[], cwd: string): string {
  return execFileSync('git', args, {
    cwd,
    encoding: 'utf-8',
    timeout: 30000,
    stdio: ['pipe', 'pipe', 'pipe'],
  });
}

/** 创建临时目录并初始化 git 仓库 */
function createTmpRepo(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'git-assistant-test-'));
  gitSync(['init'], dir);
  // 配置本地 user（避免 commit 失败）
  gitSync(['config', 'user.name', 'Test User'], dir);
  gitSync(['config', 'user.email', 'test@example.com'], dir);
  // 设置默认分支为 main（兼容不同 git 版本）
  try {
    gitSync(['symbolic-ref', 'HEAD', 'refs/heads/main'], dir);
  } catch {
    // 旧版 git 可能默认 master，忽略
  }
  try {
    gitSync(['config', 'init.defaultBranch', 'main'], dir);
  } catch {
    // ignore
  }
  return dir;
}

/** 写入文件并 commit */
function writeAndCommit(dir: string, file: string, content: string, message: string): string {
  const fullPath = path.join(dir, file);
  fs.mkdirSync(path.dirname(fullPath), { recursive: true });
  fs.writeFileSync(fullPath, content);
  gitSync(['add', file], dir);
  gitSync(['commit', '-m', message], dir);
  return gitSync(['rev-parse', 'HEAD'], dir).trim();
}

/** 创建一个空的 bare 仓库作为 remote */
function createBareRepo(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'git-assistant-remote-'));
  execSync('git init --bare', { cwd: dir, encoding: 'utf-8', timeout: 30000 });
  // 将 bare 仓库的 HEAD 指向 main，与 createTmpRepo 的默认分支保持一致，
  // 否则 clone 时会 "remote HEAD refers to nonexistent ref" 导致无法 checkout
  try {
    execSync('git symbolic-ref HEAD refs/heads/main', { cwd: dir, encoding: 'utf-8', timeout: 30000 });
  } catch {
    // ignore
  }
  return dir;
}

describe('GitAssistant', () => {
  let tmpDir: string;
  let assistant: GitAssistant;

  beforeEach(() => {
    tmpDir = createTmpRepo();
    assistant = new GitAssistant(tmpDir);
  });

  afterEach(() => {
    try { assistant.dispose(); } catch { /* ignore */ }
    try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch { /* ignore */ }
  });

  // ============ isRepo ============
  describe('isRepo', () => {
    it('在 git 仓库内返回 true', async () => {
      const result = await assistant.isRepo();
      expect(result).toBe(true);
    });

    it('不在 git 仓库内返回 false', async () => {
      const nonRepo = fs.mkdtempSync(path.join(os.tmpdir(), 'git-assistant-nonrepo-'));
      try {
        const nonRepoAssistant = new GitAssistant(nonRepo);
        const result = await nonRepoAssistant.isRepo();
        expect(result).toBe(false);
      } finally {
        fs.rmSync(nonRepo, { recursive: true, force: true });
      }
    });
  });

  // ============ getCurrentBranch ============
  describe('getCurrentBranch', () => {
    it('在初始仓库返回当前分支名', async () => {
      // 先提交一次以确立分支
      writeAndCommit(tmpDir, 'README.md', '# test', 'init');
      const branch = await assistant.getCurrentBranch();
      // 主分支可能为 main 或 master，取决于 git 版本
      expect(['main', 'master']).toContain(branch);
    });
  });

  // ============ getStatus ============
  describe('getStatus', () => {
    it('干净仓库返回 clean=true', async () => {
      writeAndCommit(tmpDir, 'README.md', '# test', 'init');
      const status = await assistant.getStatus();
      expect(status.clean).toBe(true);
      expect(status.staged).toHaveLength(0);
      expect(status.unstaged).toHaveLength(0);
      expect(status.untracked).toHaveLength(0);
    });

    it('检测到未跟踪文件', async () => {
      writeAndCommit(tmpDir, 'README.md', '# test', 'init');
      fs.writeFileSync(path.join(tmpDir, 'new.txt'), 'hello');
      const status = await assistant.getStatus();
      expect(status.clean).toBe(false);
      expect(status.untracked).toContain('new.txt');
      expect(status.staged).toHaveLength(0);
      expect(status.unstaged).toHaveLength(0);
    });

    it('检测到已暂存文件', async () => {
      writeAndCommit(tmpDir, 'README.md', '# test', 'init');
      fs.writeFileSync(path.join(tmpDir, 'staged.txt'), 'staged content');
      gitSync(['add', 'staged.txt'], tmpDir);
      const status = await assistant.getStatus();
      expect(status.clean).toBe(false);
      expect(status.staged).toHaveLength(1);
      expect(status.staged[0].path).toBe('staged.txt');
      expect(status.staged[0].status).toBe('added');
      expect(status.staged[0].staged).toBe(true);
    });

    it('检测到未暂存修改', async () => {
      writeAndCommit(tmpDir, 'README.md', '# test', 'init');
      fs.writeFileSync(path.join(tmpDir, 'README.md'), '# modified');
      const status = await assistant.getStatus();
      expect(status.clean).toBe(false);
      expect(status.unstaged).toHaveLength(1);
      expect(status.unstaged[0].path).toBe('README.md');
      expect(status.unstaged[0].status).toBe('modified');
      expect(status.unstaged[0].staged).toBe(false);
    });

    it('正确解析分支名', async () => {
      writeAndCommit(tmpDir, 'README.md', '# test', 'init');
      const status = await assistant.getStatus();
      expect(['main', 'master']).toContain(status.branch);
    });

    it('ahead/behind 默认为 0（无远程）', async () => {
      writeAndCommit(tmpDir, 'README.md', '# test', 'init');
      const status = await assistant.getStatus();
      expect(status.ahead).toBe(0);
      expect(status.behind).toBe(0);
    });
  });

  // ============ getDiff ============
  describe('getDiff', () => {
    it('无变更返回空字符串', async () => {
      writeAndCommit(tmpDir, 'README.md', '# test', 'init');
      const diff = await assistant.getDiff();
      expect(diff.trim()).toBe('');
    });

    it('有未暂存变更返回 diff', async () => {
      writeAndCommit(tmpDir, 'README.md', '# test', 'init');
      fs.writeFileSync(path.join(tmpDir, 'README.md'), '# modified content');
      const diff = await assistant.getDiff();
      expect(diff).toContain('diff --git');
      expect(diff).toContain('README.md');
      expect(diff).toContain('-# test');
      expect(diff).toContain('+# modified content');
    });

    it('staged=true 返回已暂存的 diff', async () => {
      writeAndCommit(tmpDir, 'README.md', '# test', 'init');
      fs.writeFileSync(path.join(tmpDir, 'new.txt'), 'new content');
      gitSync(['add', 'new.txt'], tmpDir);
      const diff = await assistant.getDiff(true);
      expect(diff).toContain('new file mode');
      expect(diff).toContain('+new content');
    });

    it('未暂存 diff 不包含已暂存文件', async () => {
      writeAndCommit(tmpDir, 'README.md', '# test', 'init');
      // 先提交两个文件使其成为 tracked（git diff 仅显示 tracked 文件的变更）
      // 使用 s1/u1 避免文件名互为子串导致 toContain 断言误判
      writeAndCommit(tmpDir, 's1.txt', 'original', 'add s1');
      writeAndCommit(tmpDir, 'u1.txt', 'original', 'add u1');
      // 修改两个文件
      fs.writeFileSync(path.join(tmpDir, 's1.txt'), 'staged');
      fs.writeFileSync(path.join(tmpDir, 'u1.txt'), 'unstaged');
      gitSync(['add', 's1.txt'], tmpDir);
      const unstagedDiff = await assistant.getDiff(false);
      expect(unstagedDiff).toContain('u1.txt');
      expect(unstagedDiff).not.toContain('s1.txt');
    });
  });

  // ============ add / unstage ============
  describe('add', () => {
    it('暂存单个文件', async () => {
      writeAndCommit(tmpDir, 'README.md', '# test', 'init');
      fs.writeFileSync(path.join(tmpDir, 'a.txt'), 'a');
      fs.writeFileSync(path.join(tmpDir, 'b.txt'), 'b');
      await assistant.add(['a.txt']);
      const status = await assistant.getStatus();
      expect(status.staged).toHaveLength(1);
      expect(status.staged[0].path).toBe('a.txt');
    });

    it('暂存多个文件', async () => {
      writeAndCommit(tmpDir, 'README.md', '# test', 'init');
      fs.writeFileSync(path.join(tmpDir, 'a.txt'), 'a');
      fs.writeFileSync(path.join(tmpDir, 'b.txt'), 'b');
      await assistant.add(['a.txt', 'b.txt']);
      const status = await assistant.getStatus();
      expect(status.staged).toHaveLength(2);
    });

    it('未提供 paths 时暂存所有变更（git add -A）', async () => {
      writeAndCommit(tmpDir, 'README.md', '# test', 'init');
      fs.writeFileSync(path.join(tmpDir, 'a.txt'), 'a');
      fs.writeFileSync(path.join(tmpDir, 'b.txt'), 'b');
      await assistant.add();
      const status = await assistant.getStatus();
      expect(status.staged).toHaveLength(2);
      expect(status.untracked).toHaveLength(0);
    });
  });

  describe('unstage', () => {
    it('取消暂存文件', async () => {
      writeAndCommit(tmpDir, 'README.md', '# test', 'init');
      fs.writeFileSync(path.join(tmpDir, 'a.txt'), 'a');
      gitSync(['add', 'a.txt'], tmpDir);
      await assistant.unstage(['a.txt']);
      const status = await assistant.getStatus();
      expect(status.staged).toHaveLength(0);
      expect(status.untracked).toContain('a.txt');
    });
  });

  // ============ commit ============
  describe('commit', () => {
    it('基本提交并返回 hash', async () => {
      fs.writeFileSync(path.join(tmpDir, 'file.txt'), 'content');
      await assistant.add(['file.txt']);
      const hash = await assistant.commit('test commit');
      expect(hash).toMatch(/^[0-9a-f]{40}$/);
      // 验证提交确实存在
      const log = await assistant.getLog(1);
      expect(log).toHaveLength(1);
      expect(log[0].hash).toBe(hash);
      expect(log[0].subject).toBe('test commit');
    });

    it('amend 修改上次提交', async () => {
      fs.writeFileSync(path.join(tmpDir, 'file.txt'), 'content');
      await assistant.add(['file.txt']);
      const originalHash = await assistant.commit('original message');

      fs.writeFileSync(path.join(tmpDir, 'file.txt'), 'modified content');
      await assistant.add(['file.txt']);
      const amendedHash = await assistant.commit('amended message', { amend: true });

      expect(amendedHash).not.toBe(originalHash);
      const log = await assistant.getLog(1);
      expect(log[0].subject).toBe('amended message');
    });

    it('noVerify 跳过 pre-commit hook', async () => {
      fs.writeFileSync(path.join(tmpDir, 'file.txt'), 'content');
      await assistant.add(['file.txt']);
      // 即便没有 hook，noVerify 参数也应被正确传递
      const hash = await assistant.commit('commit noVerify', { noVerify: true });
      expect(hash).toMatch(/^[0-9a-f]{40}$/);
    });
  });

  // ============ getLog ============
  describe('getLog', () => {
    it('空仓库返回空数组', async () => {
      const log = await assistant.getLog();
      expect(log).toEqual([]);
    });

    it('返回所有提交（按时间倒序）', async () => {
      writeAndCommit(tmpDir, 'a.txt', 'a', 'commit A');
      writeAndCommit(tmpDir, 'b.txt', 'b', 'commit B');
      writeAndCommit(tmpDir, 'c.txt', 'c', 'commit C');
      const log = await assistant.getLog();
      expect(log).toHaveLength(3);
      // 倒序：最近提交在前
      expect(log[0].subject).toBe('commit C');
      expect(log[1].subject).toBe('commit B');
      expect(log[2].subject).toBe('commit A');
    });

    it('limit 参数限制返回数量', async () => {
      for (let i = 0; i < 5; i++) {
        writeAndCommit(tmpDir, `file${i}.txt`, `content${i}`, `commit ${i}`);
      }
      const log = await assistant.getLog(2);
      expect(log).toHaveLength(2);
      expect(log[0].subject).toBe('commit 4');
      expect(log[1].subject).toBe('commit 3');
    });

    it('返回完整 CommitInfo 结构', async () => {
      writeAndCommit(tmpDir, 'a.txt', 'a', 'subject line');
      const log = await assistant.getLog(1);
      expect(log).toHaveLength(1);
      const c = log[0];
      expect(c.hash).toMatch(/^[0-9a-f]{40}$/);
      expect(c.shortHash).toMatch(/^[0-9a-f]{7,40}$/);
      expect(c.author).toBe('Test User');
      expect(c.email).toBe('test@example.com');
      expect(c.date).toBeTruthy();
      expect(c.subject).toBe('subject line');
      expect(c.message).toContain('subject line');
    });

    it('多行 message 正确分离 subject 和 body', async () => {
      fs.writeFileSync(path.join(tmpDir, 'a.txt'), 'a');
      gitSync(['add', 'a.txt'], tmpDir);
      gitSync(['commit', '-m', 'subject line', '-m', 'body line 1', '-m', 'body line 2'], tmpDir);
      const log = await assistant.getLog(1);
      expect(log[0].subject).toBe('subject line');
      expect(log[0].message).toContain('subject line');
      expect(log[0].message).toContain('body line 1');
      expect(log[0].message).toContain('body line 2');
    });
  });

  // ============ generateCommitMessage ============
  describe('generateCommitMessage', () => {
    it('新文件 → feat: add {filename}', async () => {
      writeAndCommit(tmpDir, 'README.md', 'init', 'init');
      fs.writeFileSync(path.join(tmpDir, 'feature.ts'), 'export const x = 1;');
      gitSync(['add', 'feature.ts'], tmpDir);
      const diff = await assistant.getDiff(true);
      const msg = await assistant.generateCommitMessage(diff);
      expect(msg).toBe('feat: add feature.ts');
    });

    it('删除文件 → chore: remove {filename}', async () => {
      writeAndCommit(tmpDir, 'README.md', 'init', 'init');
      writeAndCommit(tmpDir, 'old.ts', 'old', 'add old');
      gitSync(['rm', 'old.ts'], tmpDir);
      const diff = await assistant.getDiff(true);
      const msg = await assistant.generateCommitMessage(diff);
      expect(msg).toBe('chore: remove old.ts');
    });

    it('修改文件含 import 变更 → refactor: adjust imports', async () => {
      fs.writeFileSync(path.join(tmpDir, 'mod.ts'), 'const a = 1;\n');
      gitSync(['add', 'mod.ts'], tmpDir);
      gitSync(['commit', '-m', 'init'], tmpDir);
      fs.writeFileSync(path.join(tmpDir, 'mod.ts'), "import { foo } from 'bar';\nconst a = 1;\n");
      gitSync(['add', 'mod.ts'], tmpDir);
      const diff = await assistant.getDiff(true);
      const msg = await assistant.generateCommitMessage(diff);
      expect(msg).toBe('refactor: adjust imports');
    });

    it('修改文件含测试 → test: add tests', async () => {
      fs.writeFileSync(path.join(tmpDir, 'mod.test.ts'), 'const x = 1;\n');
      gitSync(['add', 'mod.test.ts'], tmpDir);
      gitSync(['commit', '-m', 'init'], tmpDir);
      fs.writeFileSync(
        path.join(tmpDir, 'mod.test.ts'),
        "describe('test', () => {\n  it('works', () => {});\n});\n",
      );
      gitSync(['add', 'mod.test.ts'], tmpDir);
      const diff = await assistant.getDiff(true);
      const msg = await assistant.generateCommitMessage(diff);
      expect(msg).toBe('test: add tests');
    });

    it('修改文件含新 function → feat: add {name}', async () => {
      fs.writeFileSync(path.join(tmpDir, 'mod.ts'), 'const a = 1;\n');
      gitSync(['add', 'mod.ts'], tmpDir);
      gitSync(['commit', '-m', 'init'], tmpDir);
      fs.writeFileSync(
        path.join(tmpDir, 'mod.ts'),
        'const a = 1;\nfunction compute(x: number) { return x * 2; }\n',
      );
      gitSync(['add', 'mod.ts'], tmpDir);
      const diff = await assistant.getDiff(true);
      const msg = await assistant.generateCommitMessage(diff);
      expect(msg).toBe('feat: add compute');
    });

    it('修改文件含 fix 关键词 → fix: resolve {keyword}', async () => {
      fs.writeFileSync(path.join(tmpDir, 'mod.ts'), 'const a = 1;\n');
      gitSync(['add', 'mod.ts'], tmpDir);
      gitSync(['commit', '-m', 'init'], tmpDir);
      fs.writeFileSync(
        path.join(tmpDir, 'mod.ts'),
        'const a = 1;\n// fix the bug in computation\n',
      );
      gitSync(['add', 'mod.ts'], tmpDir);
      const diff = await assistant.getDiff(true);
      const msg = await assistant.generateCommitMessage(diff);
      expect(msg).toBe('fix: resolve bug');
    });

    it('修改文件无特殊模式 → refactor: update {filename}', async () => {
      fs.writeFileSync(path.join(tmpDir, 'mod.ts'), 'const a = 1;\n');
      gitSync(['add', 'mod.ts'], tmpDir);
      gitSync(['commit', '-m', 'init'], tmpDir);
      fs.writeFileSync(path.join(tmpDir, 'mod.ts'), 'const a = 2;\n');
      gitSync(['add', 'mod.ts'], tmpDir);
      const diff = await assistant.getDiff(true);
      const msg = await assistant.generateCommitMessage(diff);
      expect(msg).toBe('refactor: update mod.ts');
    });

    it('多文件以新增为主 → feat: add N new modules', async () => {
      writeAndCommit(tmpDir, 'README.md', 'init', 'init');
      fs.writeFileSync(path.join(tmpDir, 'a.ts'), 'a');
      fs.writeFileSync(path.join(tmpDir, 'b.ts'), 'b');
      fs.writeFileSync(path.join(tmpDir, 'c.ts'), 'c');
      gitSync(['add', '-A'], tmpDir);
      const diff = await assistant.getDiff(true);
      const msg = await assistant.generateCommitMessage(diff);
      expect(msg).toBe('feat: add 3 new modules');
    });

    it('无 diff 时返回 chore: no changes', async () => {
      writeAndCommit(tmpDir, 'README.md', 'init', 'init');
      const msg = await assistant.generateCommitMessage('');
      expect(msg).toBe('chore: no changes');
    });

    it('未提供 diff 时自动获取', async () => {
      writeAndCommit(tmpDir, 'README.md', 'init', 'init');
      fs.writeFileSync(path.join(tmpDir, 'new.ts'), 'export const x = 1;');
      gitSync(['add', 'new.ts'], tmpDir);
      const msg = await assistant.generateCommitMessage();
      expect(msg).toBe('feat: add new.ts');
    });
  });

  // ============ smartCommit ============
  describe('smartCommit', () => {
    it('干净仓库返回空 hash 和提示信息', async () => {
      writeAndCommit(tmpDir, 'README.md', 'init', 'init');
      const result = await assistant.smartCommit();
      expect(result.hash).toBe('');
      expect(result.message).toBe('No changes to commit');
      expect(result.filesChanged).toBe(0);
    });

    it('有变更时自动生成 message 并提交', async () => {
      writeAndCommit(tmpDir, 'README.md', 'init', 'init');
      fs.writeFileSync(path.join(tmpDir, 'feature.ts'), 'export const x = 1;');
      const result = await assistant.smartCommit();
      expect(result.hash).toMatch(/^[0-9a-f]{40}$/);
      expect(result.message).toBe('feat: add feature.ts');
      expect(result.filesChanged).toBeGreaterThan(0);
      // 验证提交确实存在
      const log = await assistant.getLog(1);
      expect(log[0].subject).toBe('feat: add feature.ts');
    });

    it('提交后工作区变干净', async () => {
      writeAndCommit(tmpDir, 'README.md', 'init', 'init');
      fs.writeFileSync(path.join(tmpDir, 'a.txt'), 'a');
      fs.writeFileSync(path.join(tmpDir, 'b.txt'), 'b');
      await assistant.smartCommit();
      const status = await assistant.getStatus();
      expect(status.clean).toBe(true);
    });

    it('autoAdd=false 不自动 add（提交空 commit 会失败但应保留变更）', async () => {
      writeAndCommit(tmpDir, 'README.md', 'init', 'init');
      fs.writeFileSync(path.join(tmpDir, 'feature.ts'), 'export const x = 1;');
      // 不自动 add，但有变更 → smartCommit 内部 add 默认开启
      // 这里测试 autoAdd=false 时不暂存
      // 由于没有 staged 内容，commit 会失败
      await expect(assistant.smartCommit({ autoAdd: false })).rejects.toThrow();
      // 文件仍是 untracked
      const status = await assistant.getStatus();
      expect(status.untracked).toContain('feature.ts');
    });
  });

  // ============ createBranch / checkoutBranch / listBranches ============
  describe('createBranch', () => {
    it('创建新分支', async () => {
      writeAndCommit(tmpDir, 'README.md', 'init', 'init');
      await assistant.createBranch('feature-x');
      const branches = await assistant.listBranches();
      const names = branches.map(b => b.name);
      expect(names).toContain('feature-x');
    });

    it('基于指定基点创建分支', async () => {
      writeAndCommit(tmpDir, 'a.txt', 'a', 'commit A');
      const hashA = gitSync(['rev-parse', 'HEAD'], tmpDir).trim();
      writeAndCommit(tmpDir, 'b.txt', 'b', 'commit B');
      await assistant.createBranch('from-A', hashA);
      // 切换到 from-A 应该只能看到 a.txt
      await assistant.checkoutBranch('from-A');
      expect(fs.existsSync(path.join(tmpDir, 'a.txt'))).toBe(true);
      // b.txt 在 from-A 分支上不存在（被切走）
      expect(fs.existsSync(path.join(tmpDir, 'b.txt'))).toBe(false);
    });
  });

  describe('checkoutBranch', () => {
    it('切换到已存在的分支', async () => {
      writeAndCommit(tmpDir, 'README.md', 'init', 'init');
      await assistant.createBranch('feature-x');
      await assistant.checkoutBranch('feature-x');
      const branch = await assistant.getCurrentBranch();
      expect(branch).toBe('feature-x');
    });
  });

  describe('listBranches', () => {
    it('列出本地分支并标记 current', async () => {
      writeAndCommit(tmpDir, 'README.md', 'init', 'init');
      await assistant.createBranch('feature-a');
      await assistant.createBranch('feature-b');
      const branches = await assistant.listBranches();
      const localBranches = branches.filter(b => !b.remote);
      expect(localBranches.length).toBeGreaterThanOrEqual(3);
      const current = localBranches.find(b => b.current);
      expect(current).toBeTruthy();
      // 当前分支应该是 main 或 master
      expect(['main', 'master']).toContain(current!.name);
      // lastCommit 应该是 short hash
      expect(current!.lastCommit).toMatch(/^[0-9a-f]{7,40}$/);
    });

    it('远程分支标记 remote=true', async () => {
      writeAndCommit(tmpDir, 'README.md', 'init', 'init');
      const remoteDir = createBareRepo();
      try {
        gitSync(['remote', 'add', 'origin', remoteDir], tmpDir);
        gitSync(['push', '-u', 'origin', 'HEAD'], tmpDir);
        const branches = await assistant.listBranches();
        const remoteBranches = branches.filter(b => b.remote);
        expect(remoteBranches.length).toBeGreaterThan(0);
        expect(remoteBranches.some(b => b.name.startsWith('origin/'))).toBe(true);
      } finally {
        fs.rmSync(remoteDir, { recursive: true, force: true });
      }
    });
  });

  describe('mergeBranch', () => {
    it('合并分支（fast-forward）', async () => {
      writeAndCommit(tmpDir, 'a.txt', 'a', 'commit A');
      await assistant.createBranch('feature');
      await assistant.checkoutBranch('feature');
      writeAndCommit(tmpDir, 'b.txt', 'b', 'commit B on feature');
      await assistant.checkoutBranch(await (async () => {
        // 切回 main 或 master
        const branches = await assistant.listBranches();
        const mainLike = branches.find(b =>
          !b.remote && (b.name === 'main' || b.name === 'master') && !b.current,
        );
        return mainLike!.name;
      })());
      await assistant.mergeBranch('feature');
      // 合并后 b.txt 应该存在
      expect(fs.existsSync(path.join(tmpDir, 'b.txt'))).toBe(true);
    });

    it('noFf 合并创建 merge commit', async () => {
      writeAndCommit(tmpDir, 'a.txt', 'a', 'commit A');
      const initialBranch = (await assistant.listBranches()).find(b => b.current)!.name;
      await assistant.createBranch('feature');
      await assistant.checkoutBranch('feature');
      writeAndCommit(tmpDir, 'b.txt', 'b', 'commit B on feature');
      await assistant.checkoutBranch(initialBranch);
      writeAndCommit(tmpDir, 'c.txt', 'c', 'commit C on main');
      await assistant.mergeBranch('feature', { noFf: true });
      // noFf 合并后会有一个 merge commit
      const log = await assistant.getLog(5);
      const subjects = log.map(c => c.subject);
      expect(subjects.some(s => s.includes('Merge'))).toBe(true);
    });
  });

  // ============ undoLastCommit / discardChanges ============
  describe('undoLastCommit', () => {
    it('撤销最近一次提交（保留变更在工作区）', async () => {
      writeAndCommit(tmpDir, 'README.md', 'init', 'init');
      writeAndCommit(tmpDir, 'a.txt', 'content', 'add a');
      await assistant.undoLastCommit();
      // 提交数应该减少 1
      const log = await assistant.getLog();
      expect(log).toHaveLength(1);
      // a.txt 文件应该还在（保留在工作区）
      expect(fs.existsSync(path.join(tmpDir, 'a.txt'))).toBe(true);
      // a.txt 应该处于未暂存或未跟踪状态
      const status = await assistant.getStatus();
      const allPaths = [
        ...status.staged.map(f => f.path),
        ...status.unstaged.map(f => f.path),
        ...status.untracked,
      ];
      expect(allPaths).toContain('a.txt');
    });
  });

  describe('discardChanges', () => {
    it('丢弃工作区修改', async () => {
      writeAndCommit(tmpDir, 'a.txt', 'original', 'init');
      fs.writeFileSync(path.join(tmpDir, 'a.txt'), 'modified');
      // 确认有未暂存修改
      const before = await assistant.getStatus();
      expect(before.unstaged).toHaveLength(1);
      await assistant.discardChanges(['a.txt']);
      // 内容应该恢复
      expect(fs.readFileSync(path.join(tmpDir, 'a.txt'), 'utf-8')).toBe('original');
      const after = await assistant.getStatus();
      expect(after.clean).toBe(true);
    });
  });

  describe('revertCommit', () => {
    it('反转指定提交（创建新提交）', async () => {
      writeAndCommit(tmpDir, 'README.md', 'init', 'init');
      const hash = writeAndCommit(tmpDir, 'a.txt', 'content', 'add a');
      const logBefore = await assistant.getLog();
      expect(logBefore).toHaveLength(2);
      await assistant.revertCommit(hash);
      // 反转后 a.txt 应该不存在了
      expect(fs.existsSync(path.join(tmpDir, 'a.txt'))).toBe(false);
      // 提交数应该增加（revert 是新提交）
      const logAfter = await assistant.getLog();
      expect(logAfter).toHaveLength(3);
      expect(logAfter[0].subject).toContain('Revert');
    });
  });

  // ============ stash ============
  describe('stash / stashPop / stashList', () => {
    it('stash 暂存当前变更', async () => {
      writeAndCommit(tmpDir, 'README.md', 'init', 'init');
      fs.writeFileSync(path.join(tmpDir, 'a.txt'), 'uncommitted');
      await assistant.stash('my stash');
      // stash 后工作区干净（a.txt 已被移走）
      const status = await assistant.getStatus();
      expect(status.clean).toBe(true);
      const list = await assistant.stashList();
      expect(list).toHaveLength(1);
      expect(list[0].index).toBe(0);
      expect(list[0].message).toContain('my stash');
      expect(list[0].hash).toMatch(/^[0-9a-f]{7,40}$/);
    });

    it('stashPop 恢复最近 stash', async () => {
      writeAndCommit(tmpDir, 'README.md', 'init', 'init');
      fs.writeFileSync(path.join(tmpDir, 'a.txt'), 'uncommitted');
      await assistant.stash('test');
      await assistant.stashPop();
      // a.txt 应该恢复
      expect(fs.readFileSync(path.join(tmpDir, 'a.txt'), 'utf-8')).toBe('uncommitted');
      const list = await assistant.stashList();
      expect(list).toHaveLength(0);
    });

    it('stashList 空仓库返回空数组', async () => {
      const list = await assistant.stashList();
      expect(list).toEqual([]);
    });

    it('多个 stash 按倒序列出', async () => {
      writeAndCommit(tmpDir, 'README.md', 'init', 'init');
      fs.writeFileSync(path.join(tmpDir, 'a.txt'), 'a');
      await assistant.stash('first');
      fs.writeFileSync(path.join(tmpDir, 'b.txt'), 'b');
      await assistant.stash('second');
      const list = await assistant.stashList();
      expect(list).toHaveLength(2);
      // stash@{0} 是最近的（second）
      expect(list[0].message).toContain('second');
      expect(list[1].message).toContain('first');
    });
  });

  // ============ pull / push / fetch ============
  describe('pull / push / fetch (使用本地 bare 仓库)', () => {
    let remoteDir: string;

    beforeEach(() => {
      remoteDir = createBareRepo();
      gitSync(['remote', 'add', 'origin', remoteDir], tmpDir);
    });

    afterEach(() => {
      try { fs.rmSync(remoteDir, { recursive: true, force: true }); } catch { /* ignore */ }
    });

    it('push 推送到本地 bare remote', async () => {
      writeAndCommit(tmpDir, 'a.txt', 'a', 'commit A');
      // 获取当前分支名
      const branch = (await assistant.listBranches()).find(b => b.current)!.name;
      await assistant.push('origin', branch, { setUpstream: true });
      // 验证 remote 有提交：clone remote 到新目录查看
      const cloneDir = fs.mkdtempSync(path.join(os.tmpdir(), 'git-assistant-clone-'));
      try {
        execSync(`git clone ${remoteDir} .`, { cwd: cloneDir, encoding: 'utf-8', timeout: 15000 });
        expect(fs.existsSync(path.join(cloneDir, 'a.txt'))).toBe(true);
      } finally {
        fs.rmSync(cloneDir, { recursive: true, force: true });
      }
    });

    it('fetch 拉取远程引用不合并', async () => {
      // 先 push
      writeAndCommit(tmpDir, 'a.txt', 'a', 'commit A');
      const branch = (await assistant.listBranches()).find(b => b.current)!.name;
      await assistant.push('origin', branch, { setUpstream: true });
      // 在另一个 clone 中创建新提交并 push
      const otherClone = fs.mkdtempSync(path.join(os.tmpdir(), 'git-other-clone-'));
      try {
        execSync(`git clone ${remoteDir} .`, { cwd: otherClone, encoding: 'utf-8', timeout: 15000 });
        gitSync(['config', 'user.name', 'Other'], otherClone);
        gitSync(['config', 'user.email', 'other@example.com'], otherClone);
        fs.writeFileSync(path.join(otherClone, 'b.txt'), 'b');
        gitSync(['add', 'b.txt'], otherClone);
        gitSync(['commit', '-m', 'commit B from other'], otherClone);
        gitSync(['push', 'origin', branch], otherClone);

        // 在原仓库 fetch
        await assistant.fetch('origin');
        // fetch 后远程引用存在但不影响工作区
        expect(fs.existsSync(path.join(tmpDir, 'b.txt'))).toBe(false);
        // 但远程分支应该有新提交
        const branches = await assistant.listBranches();
        const remoteBranch = branches.find(b => b.name === `origin/${branch}`);
        expect(remoteBranch).toBeTruthy();
      } finally {
        fs.rmSync(otherClone, { recursive: true, force: true });
      }
    });

    it('pull 拉取并合并远程变更', async () => {
      // 初始 commit + push
      writeAndCommit(tmpDir, 'a.txt', 'a', 'commit A');
      const branch = (await assistant.listBranches()).find(b => b.current)!.name;
      await assistant.push('origin', branch, { setUpstream: true });

      // 在另一个 clone 中提交并 push
      const otherClone = fs.mkdtempSync(path.join(os.tmpdir(), 'git-other-clone-'));
      try {
        execSync(`git clone ${remoteDir} .`, { cwd: otherClone, encoding: 'utf-8', timeout: 15000 });
        gitSync(['config', 'user.name', 'Other'], otherClone);
        gitSync(['config', 'user.email', 'other@example.com'], otherClone);
        fs.writeFileSync(path.join(otherClone, 'b.txt'), 'b');
        gitSync(['add', 'b.txt'], otherClone);
        gitSync(['commit', '-m', 'commit B from other'], otherClone);
        gitSync(['push', 'origin', branch], otherClone);

        // 原仓库 pull
        await assistant.pull('origin', branch);
        // pull 后 b.txt 应该出现在工作区
        expect(fs.existsSync(path.join(tmpDir, 'b.txt'))).toBe(true);
      } finally {
        fs.rmSync(otherClone, { recursive: true, force: true });
      }
    }, 60000); // 涉及 clone + push + pull 多次网络/git 操作，给予 60s 超时

    it('push 不存在的 remote 抛错（带 stderr 内容）', async () => {
      writeAndCommit(tmpDir, 'a.txt', 'a', 'commit A');
      // 移除 remote 后尝试 push
      gitSync(['remote', 'remove', 'origin'], tmpDir);
      await expect(assistant.push('origin', 'main')).rejects.toThrow();
    });
  });

  // ============ LLM 工具定义 ============
  describe('getToolDefinitions', () => {
    it('返回 8 个工具', () => {
      const tools = assistant.getToolDefinitions();
      expect(tools).toHaveLength(8);
    });

    it('所有工具都有 name/description/parameters/execute', () => {
      const tools = assistant.getToolDefinitions();
      for (const t of tools) {
        expect(t.name).toBeTruthy();
        expect(t.description).toBeTruthy();
        expect(t.parameters).toBeDefined();
        expect(typeof t.execute).toBe('function');
      }
    });

    it('包含 8 个预期的工具名', () => {
      const tools = assistant.getToolDefinitions();
      const names = tools.map(t => t.name);
      expect(names).toContain('git_status');
      expect(names).toContain('git_diff');
      expect(names).toContain('git_commit');
      expect(names).toContain('git_smart_commit');
      expect(names).toContain('git_log');
      expect(names).toContain('git_branch');
      expect(names).toContain('git_undo');
      expect(names).toContain('git_push');
    });

    it('只读工具标记 readOnly=true', () => {
      const tools = assistant.getToolDefinitions();
      const readOnly = tools.filter(t => t.readOnly).map(t => t.name);
      expect(readOnly).toContain('git_status');
      expect(readOnly).toContain('git_diff');
      expect(readOnly).toContain('git_log');
    });

    it('git_commit 的 message 参数为 required', () => {
      const tools = assistant.getToolDefinitions();
      const commit = tools.find(t => t.name === 'git_commit')!;
      expect(commit.parameters.message.required).toBe(true);
    });

    it('git_branch 的 action 参数为 required', () => {
      const tools = assistant.getToolDefinitions();
      const branch = tools.find(t => t.name === 'git_branch')!;
      expect(branch.parameters.action.required).toBe(true);
    });

    it('git_undo 的 action 参数为 required', () => {
      const tools = assistant.getToolDefinitions();
      const undo = tools.find(t => t.name === 'git_undo')!;
      expect(undo.parameters.action.required).toBe(true);
    });
  });

  // ============ 工具 handler ============
  describe('工具 handler', () => {
    it('git_status 工具返回 GitStatus JSON', async () => {
      writeAndCommit(tmpDir, 'README.md', 'init', 'init');
      const tools = assistant.getToolDefinitions();
      const statusTool = tools.find(t => t.name === 'git_status')!;
      const result = await statusTool.execute({});
      const parsed = JSON.parse(result);
      expect(parsed.clean).toBe(true);
      expect(parsed.branch).toBeTruthy();
    });

    it('git_diff 工具返回 diff 和 filesChanged', async () => {
      writeAndCommit(tmpDir, 'a.txt', 'a', 'init');
      fs.writeFileSync(path.join(tmpDir, 'a.txt'), 'modified');
      const tools = assistant.getToolDefinitions();
      const diffTool = tools.find(t => t.name === 'git_diff')!;
      const result = await diffTool.execute({ staged: false });
      const parsed = JSON.parse(result);
      expect(parsed.diff).toContain('diff --git');
      expect(parsed.filesChanged).toBe(1);
    });

    it('git_commit 工具完成提交', async () => {
      fs.writeFileSync(path.join(tmpDir, 'a.txt'), 'a');
      const tools = assistant.getToolDefinitions();
      const commitTool = tools.find(t => t.name === 'git_commit')!;
      const result = await commitTool.execute({ message: 'tool commit' });
      const parsed = JSON.parse(result);
      expect(parsed.hash).toMatch(/^[0-9a-f]{40}$/);
      expect(parsed.message).toBe('tool commit');
    });

    it('git_smart_commit 工具完成智能提交', async () => {
      writeAndCommit(tmpDir, 'README.md', 'init', 'init');
      fs.writeFileSync(path.join(tmpDir, 'feature.ts'), 'export const x = 1;');
      const tools = assistant.getToolDefinitions();
      const smartTool = tools.find(t => t.name === 'git_smart_commit')!;
      const result = await smartTool.execute({});
      const parsed = JSON.parse(result);
      expect(parsed.hash).toMatch(/^[0-9a-f]{40}$/);
      expect(parsed.message).toBe('feat: add feature.ts');
    });

    it('git_log 工具返回提交历史', async () => {
      writeAndCommit(tmpDir, 'a.txt', 'a', 'commit A');
      writeAndCommit(tmpDir, 'b.txt', 'b', 'commit B');
      const tools = assistant.getToolDefinitions();
      const logTool = tools.find(t => t.name === 'git_log')!;
      const result = await logTool.execute({ limit: 5 });
      const parsed = JSON.parse(result);
      expect(parsed.commits).toHaveLength(2);
      expect(parsed.commits[0].subject).toBe('commit B');
    });

    it('git_branch 工具 list 操作返回分支列表', async () => {
      writeAndCommit(tmpDir, 'README.md', 'init', 'init');
      await assistant.createBranch('feature-x');
      const tools = assistant.getToolDefinitions();
      const branchTool = tools.find(t => t.name === 'git_branch')!;
      const result = await branchTool.execute({ action: 'list' });
      const parsed = JSON.parse(result);
      expect(parsed.success).toBe(true);
      expect(parsed.branches.length).toBeGreaterThanOrEqual(2);
    });

    it('git_branch 工具 create 操作创建分支', async () => {
      writeAndCommit(tmpDir, 'README.md', 'init', 'init');
      const tools = assistant.getToolDefinitions();
      const branchTool = tools.find(t => t.name === 'git_branch')!;
      const result = await branchTool.execute({ action: 'create', name: 'new-branch' });
      const parsed = JSON.parse(result);
      expect(parsed.success).toBe(true);
      // 验证分支已创建
      const branches = await assistant.listBranches();
      expect(branches.map(b => b.name)).toContain('new-branch');
    });

    it('git_undo 工具 last_commit 撤销最近提交', async () => {
      writeAndCommit(tmpDir, 'README.md', 'init', 'init');
      writeAndCommit(tmpDir, 'a.txt', 'a', 'add a');
      const tools = assistant.getToolDefinitions();
      const undoTool = tools.find(t => t.name === 'git_undo')!;
      const result = await undoTool.execute({ action: 'last_commit' });
      const parsed = JSON.parse(result);
      expect(parsed.success).toBe(true);
      const log = await assistant.getLog();
      expect(log).toHaveLength(1);
    });

    it('git_undo 工具未知 action 返回错误', async () => {
      const tools = assistant.getToolDefinitions();
      const undoTool = tools.find(t => t.name === 'git_undo')!;
      const result = await undoTool.execute({ action: 'unknown' });
      const parsed = JSON.parse(result);
      expect(parsed.success).toBe(false);
    });

    it('git_push 工具无 remote 时返回失败信息', async () => {
      writeAndCommit(tmpDir, 'a.txt', 'a', 'init');
      const tools = assistant.getToolDefinitions();
      const pushTool = tools.find(t => t.name === 'git_push')!;
      const result = await pushTool.execute({});
      const parsed = JSON.parse(result);
      expect(parsed.success).toBe(false);
    });

    it('createGitAssistantToolHandler 返回的函数能分发工具', async () => {
      // 使用单例（独立于 assistant 的 tmpDir）
      resetGitAssistant();
      const handler = createGitAssistantToolHandler();
      const result = await handler('git_status', {});
      // 单例使用 process.cwd()，可能在或不在 git 仓库内
      // 只要返回 JSON 字符串就算成功
      expect(typeof result).toBe('string');
      // 验证可解析为 JSON
      expect(() => JSON.parse(result)).not.toThrow();
    });

    it('createGitAssistantToolHandler 对未知工具返回错误', async () => {
      resetGitAssistant();
      const handler = createGitAssistantToolHandler();
      const result = await handler('nonexistent_tool', {});
      const parsed = JSON.parse(result);
      expect(parsed.error).toContain('unknown git tool');
    });
  });

  // ============ 单例模式 ============
  describe('单例模式', () => {
    it('getGitAssistant 返回同一实例', () => {
      resetGitAssistant();
      const a = getGitAssistant();
      const b = getGitAssistant();
      expect(a).toBe(b);
    });

    it('resetGitAssistant 后返回新实例', () => {
      resetGitAssistant();
      const a = getGitAssistant();
      resetGitAssistant();
      const b = getGitAssistant();
      expect(a).not.toBe(b);
    });

    it('getGitAssistantToolDefinitions 返回 8 个工具', () => {
      resetGitAssistant();
      const tools = getGitAssistantToolDefinitions();
      expect(tools).toHaveLength(8);
    });
  });

  // ============ 错误处理 ============
  describe('错误处理', () => {
    it('非仓库目录调用 getStatus 抛出带 git 错误信息的错误', async () => {
      const nonRepo = fs.mkdtempSync(path.join(os.tmpdir(), 'git-assistant-nonrepo-'));
      try {
        const nonRepoAssistant = new GitAssistant(nonRepo);
        await expect(nonRepoAssistant.getStatus()).rejects.toThrow(/git/);
      } finally {
        fs.rmSync(nonRepo, { recursive: true, force: true });
      }
    });

    it('commit 无变更时抛出错误', async () => {
      writeAndCommit(tmpDir, 'README.md', 'init', 'init');
      await expect(assistant.commit('empty commit')).rejects.toThrow();
    });

    it('checkoutBranch 不存在的分支抛出错误', async () => {
      writeAndCommit(tmpDir, 'README.md', 'init', 'init');
      await expect(assistant.checkoutBranch('nonexistent-branch')).rejects.toThrow();
    });

    it('mergeBranch 不存在的分支抛出错误', async () => {
      writeAndCommit(tmpDir, 'README.md', 'init', 'init');
      await expect(assistant.mergeBranch('nonexistent')).rejects.toThrow();
    });

    it('createBranch 已存在的分支抛出错误', async () => {
      writeAndCommit(tmpDir, 'README.md', 'init', 'init');
      const branch = await assistant.getCurrentBranch();
      await expect(assistant.createBranch(branch)).rejects.toThrow();
    });

    it('revertCommit 无效 hash 抛出错误', async () => {
      writeAndCommit(tmpDir, 'README.md', 'init', 'init');
      await expect(assistant.revertCommit('invalidhash')).rejects.toThrow();
    });

    it('错误消息包含 stderr 内容', async () => {
      const nonRepo = fs.mkdtempSync(path.join(os.tmpdir(), 'git-assistant-nonrepo-'));
      try {
        const nonRepoAssistant = new GitAssistant(nonRepo);
        try {
          await nonRepoAssistant.getStatus();
          throw new Error('should have thrown');
        } catch (e) {
          expect(e).toBeInstanceOf(Error);
          // 错误消息应该包含 "git" 和 "failed" 关键词
          const msg = (e as Error).message;
          expect(msg).toMatch(/git/i);
          expect(msg).toMatch(/failed/i);
        }
      } finally {
        fs.rmSync(nonRepo, { recursive: true, force: true });
      }
    });

    it('空仓库调用 getLog 返回空数组（不抛错）', async () => {
      const log = await assistant.getLog();
      expect(log).toEqual([]);
    });

    it('空仓库调用 listBranches 返回空数组（不抛错）', async () => {
      const branches = await assistant.listBranches();
      expect(branches).toEqual([]);
    });

    it('空仓库调用 stashList 返回空数组（不抛错）', async () => {
      const list = await assistant.stashList();
      expect(list).toEqual([]);
    });
  });

  // ============ analyzeDiffAndGenerateMessage（直接单元测试） ============
  describe('analyzeDiffAndGenerateMessage', () => {
    it('空 diff 返回 chore: no changes', () => {
      expect(analyzeDiffAndGenerateMessage('')).toBe('chore: no changes');
      expect(analyzeDiffAndGenerateMessage('   \n  ')).toBe('chore: no changes');
    });

    it('新增文件 → feat: add {filename}', () => {
      const diff = [
        'diff --git a/foo.ts b/foo.ts',
        'new file mode 100644',
        'index 0000000..abc',
        '--- /dev/null',
        '+++ b/foo.ts',
        '@@ -0,0 +1,3 @@',
        '+export const foo = 1;',
        '+export const bar = 2;',
        '+export const baz = 3;',
      ].join('\n');
      expect(analyzeDiffAndGenerateMessage(diff)).toBe('feat: add foo.ts');
    });

    it('删除文件 → chore: remove {filename}', () => {
      const diff = [
        'diff --git a/dead.ts b/dead.ts',
        'deleted file mode 100644',
        'index abc..0000000',
        '--- a/dead.ts',
        '+++ /dev/null',
        '@@ -1,1 +0,0 @@',
        '-export const dead = 1;',
      ].join('\n');
      expect(analyzeDiffAndGenerateMessage(diff)).toBe('chore: remove dead.ts');
    });

    it('多文件以新增为主 → feat: add N new modules', () => {
      const diff = [
        'diff --git a/a.ts b/a.ts',
        'new file mode 100644',
        '--- /dev/null',
        '+++ b/a.ts',
        '+a',
        'diff --git a/b.ts b/b.ts',
        'new file mode 100644',
        '--- /dev/null',
        '+++ b/b.ts',
        '+b',
      ].join('\n');
      expect(analyzeDiffAndGenerateMessage(diff)).toBe('feat: add 2 new modules');
    });
  });

  // ============ dispose ============
  describe('dispose', () => {
    it('dispose 可安全调用多次', () => {
      expect(() => {
        assistant.dispose();
        assistant.dispose();
        assistant.dispose();
      }).not.toThrow();
    });
  });
});
