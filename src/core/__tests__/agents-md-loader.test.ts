/**
 * AGENTS.md 三层记忆体系加载器单元测试
 *
 * 验证对标 Codex CLI 的 AGENTS.md 标准：
 * 1. 全局层加载（~/.duan/AGENTS.md）
 * 2. 项目层加载（<repo>/AGENTS.md）
 * 3. 子目录层加载（<subdir>/AGENTS.md）
 * 4. 覆盖层加载（<subdir>/AGENTS.override.md）
 * 5. 向上递归查找
 * 6. 合并策略（非冲突叠加，冲突深层覆盖浅层）
 * 7. 缓存机制
 * 8. /init 初始化
 * 9. LLM 工具
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import { execSync } from 'child_process';
import {
  AgentsMdLoader,
  AgentsMdInitializer,
  getAgentsMdToolDefinitions,
  createAgentsMdToolHandler,
  type AgentsMdLevel,
} from '../agents-md-loader.js';

describe('AGENTS.md 三层记忆体系', () => {
  let tmpDir: string;
  let globalDir: string;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'agents-md-test-'));
    globalDir = fs.mkdtempSync(path.join(os.tmpdir(), 'agents-md-global-'));
    // 初始化为 git 仓库
    try {
      execSync('git init', { cwd: tmpDir, stdio: 'ignore' });
    } catch {
      // git 不可用时跳过
    }
  });

  afterEach(() => {
    try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch {}
    try { fs.rmSync(globalDir, { recursive: true, force: true }); } catch {}
  });

  // ========== 1. 基础加载 ==========
  describe('基础加载', () => {
    it('无任何 AGENTS.md 时应返回空结果', () => {
      const loader = new AgentsMdLoader(path.join(globalDir, 'AGENTS.md'));
      const result = loader.load(tmpDir);
      expect(result.entries).toHaveLength(0);
      expect(result.combinedContext).toBe('');
    });

    it('应加载全局 AGENTS.md', () => {
      const globalPath = path.join(globalDir, 'AGENTS.md');
      fs.writeFileSync(globalPath, '# 全局规则\n禁止使用 root 权限');

      const loader = new AgentsMdLoader(globalPath);
      const result = loader.load(tmpDir);
      expect(result.entries.length).toBeGreaterThanOrEqual(1);
      const globalEntry = result.entries.find((e) => e.level === 'global');
      expect(globalEntry).toBeDefined();
      expect(globalEntry!.content).toContain('全局规则');
    });

    it('应加载项目根 AGENTS.md', () => {
      const projectPath = path.join(tmpDir, 'AGENTS.md');
      fs.writeFileSync(projectPath, '# 项目规则\n使用 TypeScript');

      const loader = new AgentsMdLoader(path.join(globalDir, 'AGENTS.md'));
      const result = loader.load(tmpDir);
      const projectEntry = result.entries.find((e) => e.level === 'project');
      expect(projectEntry).toBeDefined();
      expect(projectEntry!.content).toContain('项目规则');
    });

    it('应加载子目录 AGENTS.md', () => {
      // 创建子目录结构
      const subdir = path.join(tmpDir, 'src', 'components');
      fs.mkdirSync(subdir, { recursive: true });
      fs.writeFileSync(path.join(subdir, 'AGENTS.md'), '# 子目录规则\n组件使用 PascalCase');

      const loader = new AgentsMdLoader(path.join(globalDir, 'AGENTS.md'));
      const result = loader.load(subdir);
      const subdirEntry = result.entries.find((e) => e.level === 'subdir');
      expect(subdirEntry).toBeDefined();
      expect(subdirEntry!.content).toContain('子目录规则');
    });

    it('应加载 AGENTS.override.md', () => {
      const overridePath = path.join(tmpDir, 'AGENTS.override.md');
      fs.writeFileSync(overridePath, '# 覆盖规则\n忽略某些限制');

      const loader = new AgentsMdLoader(path.join(globalDir, 'AGENTS.md'));
      const result = loader.load(tmpDir);
      const overrideEntry = result.entries.find((e) => e.level === 'override');
      expect(overrideEntry).toBeDefined();
      expect(overrideEntry!.content).toContain('覆盖规则');
    });
  });

  // ========== 2. 层级合并 ==========
  describe('层级合并', () => {
    it('应按优先级从低到高拼接（全局 → 项目 → 子目录 → override）', () => {
      const globalPath = path.join(globalDir, 'AGENTS.md');
      fs.writeFileSync(globalPath, '# 全局');
      fs.writeFileSync(path.join(tmpDir, 'AGENTS.md'), '# 项目');
      const subdir = path.join(tmpDir, 'src');
      fs.mkdirSync(subdir, { recursive: true });
      fs.writeFileSync(path.join(subdir, 'AGENTS.md'), '# 子目录');
      fs.writeFileSync(path.join(subdir, 'AGENTS.override.md'), '# 覆盖');

      const loader = new AgentsMdLoader(globalPath);
      const result = loader.load(subdir);

      // 至少应包含这些层级
      const levels = result.entries.map((e) => e.level);
      expect(levels).toContain('global');
      expect(levels).toContain('project');
      expect(levels).toContain('subdir');
      expect(levels).toContain('override');

      // 合并上下文应包含所有内容
      expect(result.combinedContext).toContain('全局');
      expect(result.combinedContext).toContain('项目');
      expect(result.combinedContext).toContain('子目录');
      expect(result.combinedContext).toContain('覆盖');
    });

    it('合并上下文应包含层级分隔标记', () => {
      fs.writeFileSync(path.join(tmpDir, 'AGENTS.md'), '# 项目规则');

      const loader = new AgentsMdLoader(path.join(globalDir, 'AGENTS.md'));
      const result = loader.load(tmpDir);
      expect(result.combinedContext).toContain('<!-- ===');
    });
  });

  // ========== 3. 缓存机制 ==========
  describe('缓存机制', () => {
    it('应使用缓存加速重复加载', () => {
      fs.writeFileSync(path.join(tmpDir, 'AGENTS.md'), '# 项目规则');

      const loader = new AgentsMdLoader(path.join(globalDir, 'AGENTS.md'));
      const result1 = loader.load(tmpDir);
      const result2 = loader.load(tmpDir);

      expect(result1).toBe(result2); // 同一对象引用
      expect(loader.getCacheSize()).toBe(1);
    });

    it('清除缓存后应重新加载', () => {
      fs.writeFileSync(path.join(tmpDir, 'AGENTS.md'), '# 项目规则');

      const loader = new AgentsMdLoader(path.join(globalDir, 'AGENTS.md'));
      loader.load(tmpDir);
      expect(loader.getCacheSize()).toBe(1);

      loader.clearCache();
      expect(loader.getCacheSize()).toBe(0);

      const result = loader.load(tmpDir);
      expect(result.entries.length).toBeGreaterThanOrEqual(1);
    });
  });

  // ========== 4. 仓库根检测 ==========
  describe('仓库根检测', () => {
    it('应在 git 仓库中检测到仓库根', () => {
      const loader = new AgentsMdLoader(path.join(globalDir, 'AGENTS.md'));
      const result = loader.load(tmpDir);
      // git 仓库根应被检测到（git init 后）
      // 注意：Windows 8.3 短文件名 vs 长文件名，路径字符串比较不可靠
      // 改为验证 repoRoot 已定义且指向一个包含 .git 的有效目录
      expect(result.repoRoot).toBeDefined();
      if (result.repoRoot) {
        const gitDir = path.join(result.repoRoot, '.git');
        expect(fs.existsSync(gitDir)).toBe(true);
      }
    });

    it('非 git 仓库时 repoRoot 应为 null', () => {
      // 创建一个非 git 目录
      const noGitDir = fs.mkdtempSync(path.join(os.tmpdir(), 'no-git-'));
      try {
        const loader = new AgentsMdLoader(path.join(globalDir, 'AGENTS.md'));
        const result = loader.load(noGitDir);
        expect(result.repoRoot).toBeNull();
      } finally {
        // EPERM 重试：Windows 并发 I/O 下目录可能瞬时锁定
        for (let i = 0; i < 5; i++) {
          try {
            fs.rmSync(noGitDir, { recursive: true, force: true });
            break;
          } catch {
            const start = Date.now();
            while (Date.now() - start < 50) { /* busy-wait 50ms */ }
          }
        }
      }
    });
  });

  // ========== 5. /init 初始化 ==========
  describe('AgentsMdInitializer', () => {
    it('应检测项目信息', () => {
      // 创建一个简单的 Node.js 项目
      fs.writeFileSync(path.join(tmpDir, 'package.json'), JSON.stringify({
        name: 'test-project',
        dependencies: { react: '^18.0.0' },
        devDependencies: { typescript: '^5.0.0', vitest: '^1.0.0', eslint: '^8.0.0' },
      }));
      fs.writeFileSync(path.join(tmpDir, 'tsconfig.json'), '{}');

      const initializer = new AgentsMdInitializer();
      const detected = (initializer as unknown as { scanProject: (c: string) => { language: string[]; buildSystem: string[]; frameworks: string[]; testCommand: string | null; lintCommand: string | null; codeStyle: string | null } }).scanProject(tmpDir);

      expect(detected.language).toContain('TypeScript');
      expect(detected.buildSystem).toContain('npm');
      expect(detected.frameworks).toContain('React');
      expect(detected.testCommand).toBe('npm test');
      expect(detected.lintCommand).toBe('npm run lint');
    });

    it('应生成 AGENTS.md 内容', () => {
      fs.writeFileSync(path.join(tmpDir, 'package.json'), JSON.stringify({
        name: 'test-project',
      }));

      const initializer = new AgentsMdInitializer();
      const result = initializer.initialize(tmpDir);

      expect(result.content).toContain('AGENTS.md');
      expect(result.content).toContain('项目概述');
      expect(result.content).toContain('开发命令');
      expect(result.filePath).toContain('AGENTS.md');
    });

    it('不应覆盖已存在的 AGENTS.md', () => {
      const existingPath = path.join(tmpDir, 'AGENTS.md');
      fs.writeFileSync(existingPath, '# 已存在的内容');

      const initializer = new AgentsMdInitializer();
      initializer.initialize(tmpDir);

      // 文件内容应保持不变
      const content = fs.readFileSync(existingPath, 'utf-8');
      expect(content).toBe('# 已存在的内容');
    });

    it('应检测 Python 项目', () => {
      fs.writeFileSync(path.join(tmpDir, 'pyproject.toml'), '[tool.poetry]\nname = "test"');

      const initializer = new AgentsMdInitializer();
      const detected = (initializer as unknown as { scanProject: (c: string) => { language: string[]; buildSystem: string[] } }).scanProject(tmpDir);

      expect(detected.language).toContain('Python');
      expect(detected.buildSystem).toContain('poetry');
    });

    it('应检测 Go 项目', () => {
      fs.writeFileSync(path.join(tmpDir, 'go.mod'), 'module test\n\ngo 1.21');

      const initializer = new AgentsMdInitializer();
      const detected = (initializer as unknown as { scanProject: (c: string) => { language: string[]; testCommand: string | null } }).scanProject(tmpDir);

      expect(detected.language).toContain('Go');
      expect(detected.testCommand).toBe('go test ./...');
    });

    it('应检测 Rust 项目', () => {
      fs.writeFileSync(path.join(tmpDir, 'Cargo.toml'), '[package]\nname = "test"');

      const initializer = new AgentsMdInitializer();
      const detected = (initializer as unknown as { scanProject: (c: string) => { language: string[]; testCommand: string | null } }).scanProject(tmpDir);

      expect(detected.language).toContain('Rust');
      expect(detected.testCommand).toBe('cargo test');
    });
  });

  // ========== 6. LLM 工具 ==========
  describe('LLM 工具', () => {
    it('应返回 3 个工具定义', () => {
      const tools = getAgentsMdToolDefinitions();
      expect(tools).toHaveLength(3);
      const names = tools.map((t) => t.name);
      expect(names).toContain('agents_md_load');
      expect(names).toContain('agents_md_init');
      expect(names).toContain('agents_md_list');
    });

    it('agents_md_load 应返回合并上下文', async () => {
      fs.writeFileSync(path.join(tmpDir, 'AGENTS.md'), '# 项目规则');
      const handler = createAgentsMdToolHandler();
      const result = await handler('agents_md_load', { cwd: tmpDir });
      expect(result).toMatchObject({ combinedContext: expect.any(String) });
    });

    it('agents_md_list 应返回条目列表', async () => {
      fs.writeFileSync(path.join(tmpDir, 'AGENTS.md'), '# 项目规则');
      const handler = createAgentsMdToolHandler();
      const result = await handler('agents_md_list', { cwd: tmpDir }) as { entries: Array<{ level: string }> };
      expect(result.entries).toBeDefined();
      expect(Array.isArray(result.entries)).toBe(true);
    });

    it('agents_md_init 应生成 AGENTS.md', async () => {
      fs.writeFileSync(path.join(tmpDir, 'package.json'), '{"name":"test"}');
      const handler = createAgentsMdToolHandler();
      const result = await handler('agents_md_init', { cwd: tmpDir }) as { content: string; filePath: string };
      expect(result.content).toContain('AGENTS.md');
      expect(fs.existsSync(result.filePath)).toBe(true);
    });

    it('agents_md_init force 模式应覆盖已存在文件', async () => {
      const existingPath = path.join(tmpDir, 'AGENTS.md');
      fs.writeFileSync(existingPath, '# 旧内容');
      fs.writeFileSync(path.join(tmpDir, 'package.json'), '{"name":"test"}');
      const handler = createAgentsMdToolHandler();
      const result = await handler('agents_md_init', { cwd: tmpDir, force: true }) as { overwritten: boolean };
      expect(result.overwritten).toBe(true);
    });

    it('未知工具应返回错误', async () => {
      const handler = createAgentsMdToolHandler();
      const result = await handler('unknown_tool', {});
      expect(result).toMatchObject({ error: '未知工具: unknown_tool' });
    });
  });

  // ========== 7. 边缘情况 ==========
  describe('边缘情况', () => {
    it('全局 AGENTS.md 不存在时应正常工作', () => {
      const loader = new AgentsMdLoader(path.join(globalDir, 'nonexistent.md'));
      const result = loader.load(tmpDir);
      expect(result.entries).toHaveLength(0);
    });

    it('空文件应被正常加载', () => {
      fs.writeFileSync(path.join(tmpDir, 'AGENTS.md'), '');
      const loader = new AgentsMdLoader(path.join(globalDir, 'AGENTS.md'));
      const result = loader.load(tmpDir);
      const projectEntry = result.entries.find((e) => e.level === 'project');
      expect(projectEntry).toBeDefined();
      expect(projectEntry!.content).toBe('');
    });

    it('多级子目录应都加载', () => {
      fs.writeFileSync(path.join(tmpDir, 'AGENTS.md'), '# 项目根');
      const level1 = path.join(tmpDir, 'src');
      const level2 = path.join(level1, 'components');
      fs.mkdirSync(level2, { recursive: true });
      fs.writeFileSync(path.join(level1, 'AGENTS.md'), '# src 层');
      fs.writeFileSync(path.join(level2, 'AGENTS.md'), '# components 层');

      const loader = new AgentsMdLoader(path.join(globalDir, 'AGENTS.md'));
      const result = loader.load(level2);
      const subdirEntries = result.entries.filter((e) => e.level === 'subdir');
      expect(subdirEntries.length).toBeGreaterThanOrEqual(2);
    });
  });
});
