import * as fs from 'fs';
import * as path from 'path';
import { callLLM } from './llm-caller.js';

export interface TestGenerationOptions {
  framework?: 'vitest' | 'jest' | 'mocha' | 'node:test';
  type?: 'unit' | 'integration' | 'e2e';
  coverage?: 'statements' | 'branches' | 'functions' | 'lines';
  outputPath?: string;
}

const TEST_ANALYSIS_SYSTEM = `你是顶级软件测试工程师。分析用户提供的代码，生成全面的测试方案。

分析维度：
1. 函数/方法签名和返回值
2. 输入参数和边界条件
3. 依赖注入和mock点
4. 错误处理路径
5. 异步操作和回调
6. 状态变更和副作用

输出格式（Markdown）：
## 测试分析
- 总函数数: X
- 需要测试的核心函数: X
- 边界条件: ...
- Mock依赖: ...

## 测试代码
\`\`\`typescript
// 生成的测试代码
\`\`\``;

const TEST_GENERATION_SYSTEM = `你是专业测试代码生成器。根据代码和测试分析生成可用测试。

要求：
1. 使用 describe/it/expect 模式
2. 全覆盖：正常路径、边界条件、错误路径
3. Mock外部依赖
4. 测试命名清晰：should_xxx_when_xxx
5. 每个测试独立，无共享状态
6. 添加必要的 import
7. 只输出可运行的测试代码，不要解释`;

export class TestGenerator {
  async analyzeFile(filePath: string): Promise<string> {
    let code: string;
    try {
      code = await fs.promises.readFile(filePath, 'utf-8');
    } catch {
      return `文件不存在: ${filePath}`;
    }
    const ext = path.extname(filePath);
    const fileName = path.basename(filePath);

    const prompt = `请分析以下 ${fileName} 文件并生成测试方案：

文件路径: ${filePath}
文件类型: ${ext}

\`\`\`${ext.slice(1) || 'typescript'}
${code.substring(0, 8000)}
\`\`\``;

    return await callLLM(TEST_ANALYSIS_SYSTEM, prompt, { temperature: 0.3, maxTokens: 4096 }) || 'AI 调用失败';
  }

  async generateTests(
    filePath: string,
    options: TestGenerationOptions = {},
  ): Promise<{ testCode: string; testPath: string; summary: string }> {
    let code: string;
    try {
      code = await fs.promises.readFile(filePath, 'utf-8');
    } catch {
      throw new Error(`文件不存在: ${filePath}`);
    }
    const fileName = path.basename(filePath);
    const dir = path.dirname(filePath);
    const framework = options.framework || 'vitest';
    const testType = options.type || 'unit';

    const testFileName = fileName.replace(/\.(ts|js|tsx|jsx)$/, '.test.$1');
    const testPath = options.outputPath || path.join(dir, '__tests__', testFileName);

    const generationPrompt = `为目标代码生成 ${testType} 测试。
使用测试框架: ${framework}
目标文件: ${fileName}

目标代码：
\`\`\`${path.extname(filePath).slice(1) || 'typescript'}
${code.substring(0, 8000)}
\`\`\`

${testType === 'unit' ? '生成单元测试，关注每个函数的独立行为。使用 mock 隔离依赖。' : ''}
${testType === 'integration' ? '生成集成测试，测试多个模块的协作。使用真实依赖。' : ''}
${testType === 'e2e' ? '生成端到端测试，模拟用户操作流程。' : ''}

${options.coverage ? `特别关注覆盖率: ${options.coverage}` : ''}`;

    const testCode = await callLLM(TEST_GENERATION_SYSTEM, generationPrompt, { temperature: 0.3, maxTokens: 8192 });

    if (!testCode) {
      throw new Error('AI 调用失败，请检查 API Key 配置');
    }

    let cleanTestCode = testCode;
    const codeBlockMatch = testCode.match(/```[\w]*\n([\s\S]*?)```/);
    if (codeBlockMatch) {
      cleanTestCode = codeBlockMatch[1].trim();
    }

    const summary = [
      `✅ 测试文件: ${testPath}`,
      `📋 测试类型: ${testType}`,
      `🔧 测试框架: ${framework}`,
      `📄 源代码: ${fileName} (${code.length} 字符)`,
      `🧪 生成代码: ${cleanTestCode.length} 字符`,
    ].join('\n');

    return { testCode: cleanTestCode, testPath, summary };
  }

  async generateTestsForProject(projectDir: string): Promise<string> {
    const results: string[] = [];
    const sourceFiles = await this.findSourceFiles(projectDir);

    if (sourceFiles.length === 0) {
      return '未找到需要测试的源文件';
    }

    for (const file of sourceFiles.slice(0, 5)) {
      try {
        const analysis = await this.analyzeFile(file);
        results.push(`## ${path.relative(projectDir, file)}\n\n${analysis}`);
      } catch (err: unknown) {
        results.push(`## ${path.relative(projectDir, file)}\n\n❌ 分析失败: ${(err instanceof Error ? err.message : String(err))}`);
      }
    }

    return results.join('\n\n---\n\n');
  }

  private async findSourceFiles(dir: string): Promise<string[]> {
    const files: string[] = [];
    try {
      const entries = await fs.promises.readdir(dir, { withFileTypes: true });
      for (const entry of entries) {
        const fullPath = path.join(dir, entry.name);
        if (entry.isDirectory() && !entry.name.startsWith('.') && entry.name !== 'node_modules' && entry.name !== 'dist') {
          files.push(...await this.findSourceFiles(fullPath));
        } else if (entry.isFile() && /\.(ts|js|tsx|jsx)$/.test(entry.name) && !entry.name.endsWith('.test.ts') && !entry.name.endsWith('.spec.ts') && !entry.name.endsWith('.d.ts')) {
          files.push(fullPath);
        }
      }
    } catch {}
    return files;
  }
}
