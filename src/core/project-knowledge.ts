/**
 * 项目知识索引 — ProjectKnowledge
 *
 * 启动时自动扫描项目结构，生成项目知识摘要：
 * - 项目类型和技术栈
 * - 目录结构概览
 * - 关键配置文件内容
 * - 入口文件和核心模块
 *
 * 知识摘要注入到 PromptOrchestrator 的 context 层
 */

import * as fs from 'fs';
import * as path from 'path';

export interface ProjectKnowledgeConfig {
  /** 项目根目录 */
  rootDir: string;
  /** 最大目录深度 */
  maxDepth: number;
  /** 最大摘要长度（字符） */
  maxSummaryLength: number;
  /** 忽略的目录 */
  ignoreDirs: string[];
  /** 关键配置文件 */
  configFiles: string[];
}

const DEFAULT_CONFIG: ProjectKnowledgeConfig = {
  rootDir: process.cwd(),
  maxDepth: 3,
  maxSummaryLength: 2000,
  ignoreDirs: ['node_modules', '.git', 'dist', 'build', '.next', '__pycache__', '.venv', 'coverage', '.cache'],
  configFiles: [
    'package.json', 'tsconfig.json', 'pyproject.toml', 'Cargo.toml',
    'go.mod', 'pom.xml', 'build.gradle', 'Makefile',
    '.duanrules.md', '.duan/rules.md', 'CLAUDE.md', '.cursorrules',
  ],
};

export class ProjectKnowledge {
  private config: ProjectKnowledgeConfig;
  private cachedSummary: string | null = null;

  constructor(config?: Partial<ProjectKnowledgeConfig>) {
    this.config = { ...DEFAULT_CONFIG, ...config };
  }

  /**
   * 生成项目知识摘要
   */
  generateSummary(): Promise<string> {
    if (this.cachedSummary) return Promise.resolve(this.cachedSummary);

    const parts: string[] = [];

    // 1. 项目类型和技术栈
    const techStack = this.detectTechStack();
    if (techStack.length > 0) {
      parts.push(`技术栈: ${techStack.join(', ')}`);
    }

    // 2. 目录结构概览
    const dirStructure = this.scanDirectoryStructure();
    if (dirStructure) {
      parts.push(`\n目录结构:\n${dirStructure}`);
    }

    // 3. 关键配置文件内容
    const configContents = this.readConfigFiles();
    if (configContents) {
      parts.push(`\n关键配置:\n${configContents}`);
    }

    // 4. 入口文件
    const entryPoints = this.findEntryPoints();
    if (entryPoints.length > 0) {
      parts.push(`\n入口文件: ${entryPoints.join(', ')}`);
    }

    let summary = parts.join('\n');

    // 截断到最大长度
    if (summary.length > this.config.maxSummaryLength) {
      summary = summary.substring(0, this.config.maxSummaryLength) + '\n...[已截断]';
    }

    this.cachedSummary = summary;
    return Promise.resolve(summary);
  }

  /**
   * 检测技术栈
   */
  private detectTechStack(): string[] {
    const stack: string[] = [];
    const root = this.config.rootDir;

    // 检查配置文件判断技术栈
    if (fs.existsSync(path.join(root, 'package.json'))) {
      stack.push('Node.js');
      try {
        const pkg = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf-8'));
        const deps = { ...pkg.dependencies, ...pkg.devDependencies };
        if (deps['typescript'] || deps['ts-node'] || deps['tsx']) stack.push('TypeScript');
        if (deps['react'] || deps['next']) stack.push('React');
        if (deps['vue'] || deps['nuxt']) stack.push('Vue');
        if (deps['express'] || deps['koa'] || deps['fastify']) stack.push('Express');
        if (deps['@tarojs/taro']) stack.push('Taro');
        if (deps['electron']) stack.push('Electron');
      } catch {}
    }
    if (fs.existsSync(path.join(root, 'tsconfig.json'))) stack.push('TypeScript');
    if (fs.existsSync(path.join(root, 'pyproject.toml')) || fs.existsSync(path.join(root, 'requirements.txt'))) stack.push('Python');
    if (fs.existsSync(path.join(root, 'Cargo.toml'))) stack.push('Rust');
    if (fs.existsSync(path.join(root, 'go.mod'))) stack.push('Go');
    if (fs.existsSync(path.join(root, 'pom.xml'))) stack.push('Java/Maven');
    if (fs.existsSync(path.join(root, 'build.gradle'))) stack.push('Java/Gradle');

    return [...new Set(stack)];
  }

  /**
   * 扫描目录结构
   */
  private scanDirectoryStructure(): string {
    const MAX_LINES = 50;
    const lines: string[] = [];
    const root = this.config.rootDir;
    let truncated = false;

    const scan = (dir: string, prefix: string, depth: number) => {
      if (depth > this.config.maxDepth) return;
      // 累计行数达到上限时提前终止递归，避免遍历整棵目录树
      if (lines.length >= MAX_LINES) {
        truncated = true;
        return;
      }

      try {
        const entries = fs.readdirSync(dir, { withFileTypes: true })
          .filter(e => !this.config.ignoreDirs.includes(e.name) && !e.name.startsWith('.'))
          .sort((a, b) => {
            // 目录优先
            if (a.isDirectory() && !b.isDirectory()) return -1;
            if (!a.isDirectory() && b.isDirectory()) return 1;
            return a.name.localeCompare(b.name);
          })
          .slice(0, 20); // 每层最多 20 个条目

        for (const entry of entries) {
          if (lines.length >= MAX_LINES) {
            truncated = true;
            return;
          }
          lines.push(`${prefix}${entry.name}${entry.isDirectory() ? '/' : ''}`);
          if (entry.isDirectory() && depth < this.config.maxDepth) {
            scan(path.join(dir, entry.name), prefix + '  ', depth + 1);
            if (lines.length >= MAX_LINES) {
              truncated = true;
              return;
            }
          }
        }
      } catch {}
    };

    scan(root, '', 0);

    // 限制总行数
    if (truncated || lines.length > MAX_LINES) {
      return lines.slice(0, MAX_LINES).join('\n') + `\n... (条目超过 ${MAX_LINES} 个，已截断)`;
    }
    return lines.join('\n');
  }

  /**
   * 读取关键配置文件内容
   */
  private readConfigFiles(): string {
    const parts: string[] = [];
    const root = this.config.rootDir;

    for (const file of this.config.configFiles) {
      const filePath = path.join(root, file);
      if (fs.existsSync(filePath)) {
        try {
          let content = fs.readFileSync(filePath, 'utf-8');
          // 截断过长的配置文件
          if (content.length > 500) {
            content = content.substring(0, 500) + '\n...[已截断]';
          }
          parts.push(`--- ${file} ---\n${content}`);
        } catch {}
      }
    }

    return parts.join('\n\n');
  }

  /**
   * 查找入口文件
   */
  private findEntryPoints(): string[] {
    const entries: string[] = [];
    const root = this.config.rootDir;

    // 从 package.json 的 main/bin/scripts 推断
    try {
      const pkgPath = path.join(root, 'package.json');
      if (fs.existsSync(pkgPath)) {
        const pkg = JSON.parse(fs.readFileSync(pkgPath, 'utf-8'));
        if (pkg.main) entries.push(pkg.main);
        if (pkg.bin) {
          if (typeof pkg.bin === 'string') entries.push(pkg.bin);
          else Object.values(pkg.bin).forEach(v => entries.push(v as string));
        }
      }
    } catch {}

    // 常见入口文件
    const commonEntries = ['src/index.ts', 'src/index.js', 'src/main.ts', 'src/main.js', 'src/app.ts', 'src/app.js', 'index.ts', 'index.js'];
    for (const entry of commonEntries) {
      if (fs.existsSync(path.join(root, entry)) && !entries.includes(entry)) {
        entries.push(entry);
      }
    }

    return entries.slice(0, 5);
  }

  /**
   * 清除缓存（项目结构变化时调用）
   */
  invalidateCache(): void {
    this.cachedSummary = null;
  }
}
