/**
 * AGENTS.md 三层记忆体系加载器 — AgentsMdLoader
 *
 * 对标 Codex CLI 的 AGENTS.md 标准：
 * - 全局层：~/.duan/AGENTS.md（用户全局规则）
 * - 项目层：<repo>/AGENTS.md（项目根规则）
 * - 子目录层：<subdir>/AGENTS.override.md（子目录覆盖）
 *
 * 查找策略：
 * 1. 从当前工作目录向上递归查找 AGENTS.md 和 AGENTS.override.md
 * 2. 全局层始终加载
 * 3. 项目层从仓库根加载
 * 4. 子目录层从当前目录及其祖先目录加载
 *
 * 合并策略：
 * - 非冲突指令叠加
 * - 冲突时深层覆盖浅层（子目录 > 项目根 > 全局）
 * - AGENTS.override.md 优先级高于同目录的 AGENTS.md
 *
 * 与现有 ProjectMemoryLoader 共存：AGENTS.md 作为新的标准入口
 */

import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import { execSync } from 'child_process';

// ============ 类型定义 ============

/** AGENTS.md 文件层级 */
export type AgentsMdLevel = 'global' | 'project' | 'subdir' | 'override';

/** AGENTS.md 加载的单个文件条目 */
export interface AgentsMdEntry {
  /** 层级 */
  level: AgentsMdLevel;
  /** 文件绝对路径 */
  filePath: string;
  /** 文件内容 */
  content: string;
  /** 相对于工作目录的路径（用于显示） */
  relativePath: string;
}

/** AGENTS.md 加载结果 */
export interface AgentsMdLoadResult {
  /** 按优先级从低到高排列的条目（全局 → 项目 → 子目录 → override） */
  entries: AgentsMdEntry[];
  /** 合并后的完整上下文 */
  combinedContext: string;
  /** 工作目录 */
  cwd: string;
  /** 仓库根目录（如检测到） */
  repoRoot: string | null;
}

/** AGENTS.md init 扫描结果 */
export interface AgentsMdInitResult {
  /** 生成的 AGENTS.md 内容 */
  content: string;
  /** 写入的文件路径 */
  filePath: string;
  /** 检测到的项目信息 */
  detected: {
    language: string[];
    buildSystem: string[];
    frameworks: string[];
    testCommand: string | null;
    lintCommand: string | null;
    codeStyle: string | null;
  };
}

// ============ AGENTS.md 加载器 ============

export class AgentsMdLoader {
  /** 全局 AGENTS.md 路径 */
  private globalPath: string;
  /** 缓存（60 秒） */
  private cache: Map<string, { result: AgentsMdLoadResult; ts: number }> = new Map();
  /** 缓存有效期（毫秒） */
  private cacheTtl = 60_000;

  constructor(globalPath?: string) {
    this.globalPath = globalPath ?? path.join(os.homedir(), '.duan', 'AGENTS.md');
  }

  /**
   * 加载所有层级的 AGENTS.md
   * @param cwd 当前工作目录
   * @returns 加载结果
   */
  load(cwd: string = process.cwd()): AgentsMdLoadResult {
    // 检查缓存
    const cacheKey = cwd;
    const cached = this.cache.get(cacheKey);
    if (cached && Date.now() - cached.ts < this.cacheTtl) {
      return cached.result;
    }

    const entries: AgentsMdEntry[] = [];

    // 1. 加载全局层
    const globalEntry = this.loadFile(this.globalPath, 'global', cwd);
    if (globalEntry) {
      entries.push(globalEntry);
    }

    // 2. 检测仓库根
    const repoRoot = this.detectRepoRoot(cwd);

    // 3. 加载项目层（仓库根的 AGENTS.md）
    if (repoRoot) {
      const projectPath = path.join(repoRoot, 'AGENTS.md');
      const projectEntry = this.loadFile(projectPath, 'project', cwd);
      if (projectEntry) {
        entries.push(projectEntry);
      }
    }

    // 4. 加载子目录层（从仓库根到当前目录的所有 AGENTS.md 和 AGENTS.override.md）
    if (repoRoot) {
      const subdirEntries = this.loadSubdirEntries(repoRoot, cwd);
      entries.push(...subdirEntries);
    }

    // 5. 合并上下文
    const combinedContext = this.combineEntries(entries);

    const result: AgentsMdLoadResult = {
      entries,
      combinedContext,
      cwd,
      repoRoot,
    };

    // 更新缓存
    this.cache.set(cacheKey, { result, ts: Date.now() });

    return result;
  }

  /**
   * 加载单个 AGENTS.md 文件
   */
  private loadFile(
    filePath: string,
    level: AgentsMdLevel,
    cwd: string,
  ): AgentsMdEntry | null {
    try {
      if (!fs.existsSync(filePath)) {
        return null;
      }
      const content = fs.readFileSync(filePath, 'utf-8');
      const relativePath = path.relative(cwd, filePath) || path.basename(filePath);
      return { level, filePath, content, relativePath };
    } catch {
      return null;
    }
  }

  /**
   * 加载子目录层条目（从仓库根到当前目录路径上的所有 AGENTS.md 和 AGENTS.override.md）
   */
  private loadSubdirEntries(repoRoot: string, cwd: string): AgentsMdEntry[] {
    const entries: AgentsMdEntry[] = [];

    // 计算从仓库根到当前目录的路径链
    const relPath = path.relative(repoRoot, cwd);
    if (relPath === '') {
      // 当前目录就是仓库根，项目层已加载，只需检查 override
      const overridePath = path.join(cwd, 'AGENTS.override.md');
      const overrideEntry = this.loadFile(overridePath, 'override', cwd);
      if (overrideEntry) {
        entries.push(overrideEntry);
      }
      return entries;
    }

    // 遍历从仓库根到当前目录的每一级
    const parts = relPath.split(path.sep).filter(Boolean);
    let currentPath = repoRoot;

    for (let i = 0; i < parts.length; i++) {
      currentPath = path.join(currentPath, parts[i]);

      // 跳过仓库根的 AGENTS.md（已在项目层加载）
      if (i === 0 && parts.length === 1) {
        // 只剩一级，且是根的下一级
      }

      // 加载该目录的 AGENTS.md（除非是仓库根本身）
      if (currentPath !== repoRoot) {
        const agentsMdPath = path.join(currentPath, 'AGENTS.md');
        const entry = this.loadFile(agentsMdPath, 'subdir', cwd);
        if (entry) {
          entries.push(entry);
        }
      }

      // 加载该目录的 AGENTS.override.md
      const overridePath = path.join(currentPath, 'AGENTS.override.md');
      const overrideEntry = this.loadFile(overridePath, 'override', cwd);
      if (overrideEntry) {
        entries.push(overrideEntry);
      }
    }

    return entries;
  }

  /**
   * 合并多个条目的内容
   * 按优先级从低到高拼接，每层添加分隔标记
   */
  private combineEntries(entries: AgentsMdEntry[]): string {
    if (entries.length === 0) {
      return '';
    }

    const sections: string[] = [];
    for (const entry of entries) {
      const levelLabel = this.getLevelLabel(entry.level);
      sections.push(`<!-- === ${levelLabel}: ${entry.relativePath} === -->\n${entry.content}`);
    }

    return sections.join('\n\n');
  }

  /** 获取层级标签 */
  private getLevelLabel(level: AgentsMdLevel): string {
    switch (level) {
      case 'global': return '全局层';
      case 'project': return '项目层';
      case 'subdir': return '子目录层';
      case 'override': return '覆盖层';
    }
  }

  /**
   * 检测 git 仓库根目录
   *
   * 优先用 `git rev-parse --show-toplevel`（能解析 worktree/submodule），
   * 失败时回退到向上遍历查找 `.git` 目录（不依赖 git 进程，无超时风险）。
   */
  private detectRepoRoot(cwd: string): string | null {
    try {
      const result = execSync('git rev-parse --show-toplevel', {
        cwd,
        encoding: 'utf-8',
        timeout: 5000,
        stdio: ['pipe', 'pipe', 'ignore'],
      });
      const root = result.trim();
      if (root) return root;
    } catch {
      // git 不可用或超时，走回退逻辑
    }
    // 回退：向上遍历查找 .git 目录
    let dir = path.resolve(cwd);
    while (true) {
      if (fs.existsSync(path.join(dir, '.git'))) {
        return dir;
      }
      const parent = path.dirname(dir);
      if (parent === dir) break;
      dir = parent;
    }
    return null;
  }

  /**
   * 清除缓存
   */
  clearCache(): void {
    this.cache.clear();
  }

  /**
   * 获取缓存大小
   */
  getCacheSize(): number {
    return this.cache.size;
  }
}

// ============ AGENTS.md 初始化器（/init 命令） ============

export class AgentsMdInitializer {
  /**
   * 扫描项目结构并生成 starter AGENTS.md
   * @param cwd 工作目录
   * @returns 初始化结果
   */
  initialize(cwd: string = process.cwd()): AgentsMdInitResult {
    const detected = this.scanProject(cwd);
    const content = this.generateContent(cwd, detected);
    const filePath = path.join(cwd, 'AGENTS.md');

    // 写入文件（不覆盖已存在的文件）
    if (!fs.existsSync(filePath)) {
      fs.writeFileSync(filePath, content, 'utf-8');
    }

    return { content, filePath, detected };
  }

  /**
   * 扫描项目结构
   */
  private scanProject(cwd: string): AgentsMdInitResult['detected'] {
    const language: string[] = [];
    const buildSystem: string[] = [];
    const frameworks: string[] = [];
    let testCommand: string | null = null;
    let lintCommand: string | null = null;
    let codeStyle: string | null = null;

    // 检测 package.json
    const pkgJsonPath = path.join(cwd, 'package.json');
    if (fs.existsSync(pkgJsonPath)) {
      buildSystem.push('npm');
      language.push('TypeScript', 'JavaScript');
      try {
        const pkg = JSON.parse(fs.readFileSync(pkgJsonPath, 'utf-8'));
        // 检测框架
        const deps = { ...pkg.dependencies, ...pkg.devDependencies };
        if (deps['react']) frameworks.push('React');
        if (deps['vue']) frameworks.push('Vue');
        if (deps['express']) frameworks.push('Express');
        if (deps['electron']) frameworks.push('Electron');
        if (deps['next']) frameworks.push('Next.js');
        if (deps['vitest']) { testCommand = 'npm test'; frameworks.push('Vitest'); }
        if (deps['jest']) { testCommand = testCommand ?? 'npm test'; frameworks.push('Jest'); }
        if (deps['eslint']) { lintCommand = 'npm run lint'; }
        if (deps['prettier']) { codeStyle = 'Prettier'; }
        if (deps['typescript']) language.push('TypeScript');
      } catch {
        // package.json 解析失败
      }
    }

    // 检测其他语言
    if (fs.existsSync(path.join(cwd, 'tsconfig.json'))) {
      if (!language.includes('TypeScript')) language.push('TypeScript');
    }
    if (fs.existsSync(path.join(cwd, 'pyproject.toml')) || fs.existsSync(path.join(cwd, 'setup.py'))) {
      language.push('Python');
      buildSystem.push('pip');
      if (fs.existsSync(path.join(cwd, 'pyproject.toml'))) buildSystem.push('poetry');
    }
    if (fs.existsSync(path.join(cwd, 'go.mod'))) {
      language.push('Go');
      buildSystem.push('go');
      testCommand = testCommand ?? 'go test ./...';
    }
    if (fs.existsSync(path.join(cwd, 'Cargo.toml'))) {
      language.push('Rust');
      buildSystem.push('cargo');
      testCommand = testCommand ?? 'cargo test';
    }
    if (fs.existsSync(path.join(cwd, 'pom.xml'))) {
      language.push('Java');
      buildSystem.push('maven');
      testCommand = testCommand ?? 'mvn test';
    }
    if (fs.existsSync(path.join(cwd, 'build.gradle')) || fs.existsSync(path.join(cwd, 'build.gradle.kts'))) {
      language.push('Java');
      buildSystem.push('gradle');
      testCommand = testCommand ?? 'gradle test';
    }

    // 检测 Dockerfile
    if (fs.existsSync(path.join(cwd, 'Dockerfile'))) {
      buildSystem.push('docker');
    }

    // 检测 .eslintrc
    const eslintVariants = ['.eslintrc', '.eslintrc.js', '.eslintrc.json', '.eslintrc.yml', '.eslintrc.yaml'];
    if (eslintVariants.some((f) => fs.existsSync(path.join(cwd, f)))) {
      lintCommand = lintCommand ?? 'eslint .';
    }

    // 去重
    return {
      language: [...new Set(language)],
      buildSystem: [...new Set(buildSystem)],
      frameworks: [...new Set(frameworks)],
      testCommand,
      lintCommand,
      codeStyle,
    };
  }

  /**
   * 生成 AGENTS.md 内容
   */
  private generateContent(cwd: string, detected: AgentsMdInitResult['detected']): string {
    const projectName = path.basename(cwd);
    const lines: string[] = [
      `# ${projectName} — AGENTS.md`,
      '',
      '> 此文件为 AI Agent 提供项目上下文，由 /init 命令自动生成，可手动编辑补充。',
      '> 对标 Codex CLI AGENTS.md 标准，与 ~/.duan/AGENTS.md（全局）和 AGENTS.override.md（子目录覆盖）协同工作。',
      '',
      '## 项目概述',
      '',
      `- **项目名称**: ${projectName}`,
      `- **编程语言**: ${detected.language.join(', ') || '未检测到'}`,
      `- **构建系统**: ${detected.buildSystem.join(', ') || '未检测到'}`,
      `- **框架**: ${detected.frameworks.join(', ') || '未检测到'}`,
      '',
      '## 开发命令',
      '',
    ];

    if (detected.testCommand) {
      lines.push(`- **运行测试**: \`${detected.testCommand}\``);
    }
    if (detected.lintCommand) {
      lines.push(`- **代码检查**: \`${detected.lintCommand}\``);
    }
    if (detected.codeStyle) {
      lines.push(`- **代码风格**: ${detected.codeStyle}`);
    }

    lines.push(
      '',
      '## 代码规范',
      '',
      '- 使用有意义的变量和函数命名',
      '- 添加必要的注释（复杂逻辑必须注释）',
      '- 遵循已有代码风格（缩进、引号、分号等）',
      '- 新增功能需附带测试',
      '',
      '## 关键路径',
      '',
      '<!-- 列出项目的关键目录和文件，帮助 Agent 快速定位 -->',
      '',
      '## 注意事项',
      '',
      '<!-- 列出 Agent 需要注意的禁忌和约定 -->',
      '',
      '## 参考链接',
      '',
      '<!-- 项目文档、Issue tracker、CI/CD 等链接 -->',
      '',
    );

    return lines.join('\n');
  }
}

// ============ LLM 工具定义 ============

/** AGENTS.md 管理 LLM 工具定义 */
export function getAgentsMdToolDefinitions() {
  return [
    {
      name: 'agents_md_load',
      description: '加载所有层级的 AGENTS.md（全局 + 项目 + 子目录 + override），返回合并后的项目上下文',
      inputSchema: {
        type: 'object' as const,
        properties: {
          cwd: {
            type: 'string',
            description: '工作目录（默认为当前目录）',
          },
        },
      },
    },
    {
      name: 'agents_md_init',
      description: '扫描项目结构并生成 starter AGENTS.md（对标 Codex CLI /init 命令）',
      inputSchema: {
        type: 'object' as const,
        properties: {
          cwd: {
            type: 'string',
            description: '工作目录（默认为当前目录）',
          },
          force: {
            type: 'boolean',
            description: '是否覆盖已存在的 AGENTS.md（默认 false）',
          },
        },
      },
    },
    {
      name: 'agents_md_list',
      description: '列出所有已加载的 AGENTS.md 文件及其层级',
      inputSchema: {
        type: 'object' as const,
        properties: {
          cwd: {
            type: 'string',
            description: '工作目录（默认为当前目录）',
          },
        },
      },
    },
  ];
}

/** AGENTS.md 工具处理器 */
export function createAgentsMdToolHandler() {
  const loader = new AgentsMdLoader();
  const initializer = new AgentsMdInitializer();

  return async (toolName: string, args: Record<string, unknown>): Promise<unknown> => {
    switch (toolName) {
      case 'agents_md_load': {
        const cwd = (args.cwd as string) ?? process.cwd();
        const result = loader.load(cwd);
        return {
          combinedContext: result.combinedContext,
          entries: result.entries.map((e) => ({
            level: e.level,
            relativePath: e.relativePath,
            contentLength: e.content.length,
          })),
          repoRoot: result.repoRoot,
        };
      }
      case 'agents_md_init': {
        const cwd = (args.cwd as string) ?? process.cwd();
        const force = (args.force as boolean) ?? false;
        if (force) {
          // 覆盖模式
          const detected = (initializer as unknown as { scanProject: (c: string) => AgentsMdInitResult['detected'] }).scanProject(cwd);
          const content = (initializer as unknown as { generateContent: (c: string, d: AgentsMdInitResult['detected']) => string }).generateContent(cwd, detected);
          const filePath = `${cwd}/AGENTS.md`;
          fs.writeFileSync(filePath, content, 'utf-8');
          return { content, filePath, detected, overwritten: true };
        }
        const result = initializer.initialize(cwd);
        return { content: result.content, filePath: result.filePath, detected: result.detected };
      }
      case 'agents_md_list': {
        const cwd = (args.cwd as string) ?? process.cwd();
        const result = loader.load(cwd);
        return {
          entries: result.entries.map((e) => ({
            level: e.level,
            filePath: e.filePath,
            relativePath: e.relativePath,
            contentPreview: e.content.substring(0, 200),
            contentLength: e.content.length,
          })),
          repoRoot: result.repoRoot,
        };
      }
      default:
        return { error: `未知工具: ${toolName}` };
    }
  };
}
