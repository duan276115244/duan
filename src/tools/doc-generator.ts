import * as fs from 'fs';
import * as path from 'path';
import { exec } from 'child_process';
import { promisify } from 'util';
import { callLLM } from './llm-caller.js';

const execAsync = promisify(exec);

export interface DocGenerationOptions {
  type: 'readme' | 'api' | 'changelog' | 'contributing' | 'full';
  outputPath?: string;
}

const README_SYSTEM = `你是一个专业的技术文档写手。根据项目信息生成高质量的 README.md。

要求：
1. 项目名称和一句话简介
2. 功能特性列表（图标+描述）
3. 快速开始（安装 + 配置 + 运行）
4. 使用示例（代码块）
5. 项目结构（目录树）
6. 技术栈
7. 贡献指南
8. License

用中文撰写，技术术语保留英文。使用 GitHub 风格 Markdown。`;

const API_DOC_SYSTEM = `你是一个专业的 API 文档生成器。分析代码生成全面的 API 文档。

输出格式（每个导出成员）：
## \`FunctionName\`
- 描述: ...
- 参数: ...
- 返回值: ...
- 示例: \`\`\`typescript\n...\n\`\`\`

用中文描述，代码用 TypeScript。`;

export class DocGenerator {
  async generateREADME(projectDir: string = process.cwd()): Promise<string> {
    const pkgPath = path.join(projectDir, 'package.json');
    let pkgInfo = { name: '', version: '', description: '', scripts: {} as Record<string, string>, dependencies: {} as Record<string, string>, devDependencies: {} as Record<string, string> };
    try { pkgInfo = JSON.parse(await fs.promises.readFile(pkgPath, 'utf-8')); } catch {}

    const srcEntries = await this.listDir(path.join(projectDir, 'src'));
    const hasCore = await this.pathExists(path.join(projectDir, 'src', 'core'));
    const hasTools = await this.pathExists(path.join(projectDir, 'src', 'tools'));
    const hasWeb = await this.pathExists(path.join(projectDir, 'src', 'web-server.ts'));
    const hasCli = await this.pathExists(path.join(projectDir, 'src', 'duan-v19.0.ts'));
    const scripts = Object.entries(pkgInfo.scripts || {}).map(([k, v]) => `  "${k}": "${v}"`).join('\n');
    const deps = Object.entries(pkgInfo.dependencies || {}).map(([k, v]) => `- ${k}: ${v}`).join('\n');
    const devDeps = Object.entries(pkgInfo.devDependencies || {}).map(([k, v]) => `- ${k}: ${v}`).join('\n');

    const projectInfo = [
      `项目名称: ${pkgInfo.name || path.basename(projectDir)}`,
      `版本: ${pkgInfo.version || '0.0.0'}`,
      `描述: ${pkgInfo.description || ''}`,
      '',
      '## 项目结构',
      `src/ ${hasCore ? '├── core/ (核心模块)' : ''}`,
      `${hasTools ? '├── tools/ (工具模块)' : ''}`,
      `${hasCli ? '├── duan-v19.0.ts (CLI入口)' : ''}`,
      `${hasWeb ? '├── web-server.ts (Web服务)' : ''}`,
      '',
      '## 可用脚本',
      scripts || '无',
      '',
      '## 依赖',
      deps || '无',
      '',
      '## 开发依赖',
      devDeps || '无',
      '',
      `## 源码分析 (${srcEntries.length} 个文件)`,
      srcEntries.slice(0, 30).map(f => `- ${f}`).join('\n'),
    ].join('\n');

    const result = await callLLM(README_SYSTEM, projectInfo, { temperature: 0.5, maxTokens: 4096 });
    return result || `# ${pkgInfo.name || '项目'}\n\n${pkgInfo.description || ''}\n`;
  }

  async generateAPIDoc(filePath: string): Promise<string> {
    let code: string;
    try {
      code = await fs.promises.readFile(filePath, 'utf-8');
    } catch {
      return `文件不存在: ${filePath}`;
    }
    const fileName = path.basename(filePath);

    const prompt = `分析以下 ${fileName} 文件，生成完整的 API 文档：

\`\`\`typescript
${code.substring(0, 10000)}
\`\`\`

列出所有 export 的函数、类、接口、类型，并为每个生成文档。`;

    const result = await callLLM(API_DOC_SYSTEM, prompt, { temperature: 0.3, maxTokens: 4096 });
    return result || `# ${fileName}\n\n无法生成 API 文档`;
  }

  async generateChangelog(projectDir: string = process.cwd()): Promise<string> {
    const pkgPath = path.join(projectDir, 'package.json');
    let version = '0.0.0';
    try { version = JSON.parse(await fs.promises.readFile(pkgPath, 'utf-8')).version || '0.0.0'; } catch {}

    const gitLog = await this.execGitLog(projectDir);

    const prompt = `根据以下 Git 提交记录和当前版本 ${version}，生成 CHANGELOG.md。

提交记录（最近 50 条）：
${gitLog || '无 Git 提交记录'}

格式：
## [版本] - 日期
### Added
- ...
### Changed
- ...
### Fixed
- ...

请根据提交信息分类。`;

    const result = await callLLM(
      '你是一个专业的 CHANGELOG 生成器。根据 Git 提交记录生成结构化的变更日志。使用 Keep a Changelog 格式。',
      prompt,
      { temperature: 0.3, maxTokens: 2048 },
    );
    return result || `# Changelog\n\n## [${version}] - ${new Date().toISOString().split('T')[0]}\n\n### Added\n- 项目初始化\n`;
  }

  async generateFullDocs(projectDir: string = process.cwd()): Promise<Record<string, string>> {
    const results: Record<string, string> = {};

    results['README.md'] = await this.generateREADME(projectDir);
    results['CHANGELOG.md'] = await this.generateChangelog(projectDir);

    const srcDir = path.join(projectDir, 'src');
    if (await this.pathExists(srcDir)) {
      const files = (await this.findSourceFiles(srcDir)).slice(0, 10);
      const apiDocs: string[] = [];
      for (const file of files) {
        const doc = await this.generateAPIDoc(file);
        if (doc && !doc.startsWith('文件不存在')) {
          apiDocs.push(`## ${path.relative(projectDir, file)}\n\n${doc}`);
        }
      }
      if (apiDocs.length > 0) {
        results['API.md'] = apiDocs.join('\n\n---\n\n');
      }
    }

    return results;
  }

  async writeDocs(options: DocGenerationOptions, projectDir: string = process.cwd()): Promise<string> {
    const results: Record<string, string> = {};

    switch (options.type) {
      case 'readme':
        results['README.md'] = await this.generateREADME(projectDir);
        break;
      case 'api': {
        const srcDir = path.join(projectDir, 'src');
        if (await this.pathExists(srcDir)) {
          const files = (await this.findSourceFiles(srcDir)).slice(0, 10);
          for (const file of files) {
            const relPath = path.relative(projectDir, file);
            results[`docs/api/${relPath}.md`] = await this.generateAPIDoc(file);
          }
        }
        break;
      }
      case 'changelog':
        results['CHANGELOG.md'] = await this.generateChangelog(projectDir);
        break;
      case 'full':
        Object.assign(results, await this.generateFullDocs(projectDir));
        break;
    }

    const written: string[] = [];
    for (const [filename, content] of Object.entries(results)) {
      const outputPath = options.outputPath ? path.join(options.outputPath, filename) : path.join(projectDir, filename);
      try {
        await fs.promises.mkdir(path.dirname(outputPath), { recursive: true });
        await fs.promises.writeFile(outputPath, content, 'utf-8');
        written.push(outputPath);
      } catch (err: unknown) {
        written.push(`${outputPath} (写入失败: ${(err instanceof Error ? err.message : String(err))})`);
      }
    }

    return written.map(f => `✅ ${f}`).join('\n');
  }

  private async findSourceFiles(dir: string): Promise<string[]> {
    const files: string[] = [];
    try {
      const entries = await fs.promises.readdir(dir, { withFileTypes: true });
      for (const entry of entries) {
        const fullPath = path.join(dir, entry.name);
        if (entry.isDirectory() && !entry.name.startsWith('.') && entry.name !== 'node_modules' && entry.name !== 'dist') {
          files.push(...await this.findSourceFiles(fullPath));
        } else if (entry.isFile() && /\.(ts|js)$/.test(entry.name) && !entry.name.endsWith('.d.ts')) {
          files.push(fullPath);
        }
      }
    } catch {}
    return files;
  }

  private async listDir(dir: string): Promise<string[]> {
    try {
      const entries = await fs.promises.readdir(dir);
      const result = await Promise.all(
        entries.map(async (e: string) => {
          const full = path.join(dir, e);
          try {
            const stat = await fs.promises.stat(full);
            return e + (stat.isDirectory() ? '/' : '');
          } catch {
            return e;
          }
        }),
      );
      return result;
    } catch { return []; }
  }

  private async pathExists(p: string): Promise<boolean> {
    try {
      await fs.promises.access(p);
      return true;
    } catch {
      return false;
    }
  }

  private async execGitLog(projectDir: string): Promise<string> {
    try {
      const { stdout } = await execAsync('git log --oneline --pretty=format:"%h %s" -50', { cwd: projectDir, encoding: 'utf-8', timeout: 5000 });
      return stdout;
    } catch { return ''; }
  }
}
