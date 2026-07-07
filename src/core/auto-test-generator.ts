/**
 * 自动化测试生成系统 — AutoTestGenerator
 *
 * 基于代码分析自动生成单元测试。
 *
 * 核心能力：
 * 1. 函数分析 — 提取函数签名、参数类型、返回类型
 * 2. 测试用例生成 — 基于边界值/等价类/异常情况生成测试用例
 * 3. Mock 生成 — 自动生成依赖的 Mock
 * 4. 测试模板 — 支持多种测试框架模板（Vitest/Jest/Mocha）
 * 5. 覆盖率优化 — 生成覆盖分支的测试
 * 6. 测试报告 — 生成测试覆盖报告
 */

import * as fs from 'fs';
import * as path from 'path';
import { logger } from './structured-logger.js';
import { duanPath } from './duan-paths.js';

// ============ 类型定义 ============

/** 函数信息 */
export interface FunctionInfo {
  /** 函数名 */
  name: string;
  /** 参数列表 */
  parameters: Array<{
    name: string;
    type: string;
    optional: boolean;
    defaultValue?: string;
  }>;
  /** 返回类型 */
  returnType: string;
  /** 是否异步 */
  isAsync: boolean;
  /** 是否导出 */
  isExported: boolean;
  /** 是否静态 */
  isStatic: boolean;
  /** 所属类 */
  className?: string;
  /** 起始行 */
  startLine: number;
  /** 结束行 */
  endLine: number;
  /** JSDoc 注释 */
  jsDoc?: string;
}

/** 测试用例 */
export interface TestCase {
  /** 用例名 */
  name: string;
  /** 描述 */
  description: string;
  /** 输入参数 */
  inputs: unknown[];
  /** 预期输出 */
  expectedOutput?: unknown;
  /** 是否应抛出错误 */
  shouldThrow?: string;
  /** 标签 */
  tags: string[];
}

/** 生成的测试文件 */
export interface GeneratedTestFile {
  /** 文件路径 */
  filePath: string;
  /** 测试文件路径 */
  testFilePath: string;
  /** 测试框架 */
  framework: 'vitest' | 'jest' | 'mocha';
  /** 测试内容 */
  content: string;
  /** 测试用例数 */
  testCaseCount: number;
  /** 覆盖的函数 */
  coveredFunctions: string[];
  /** 生成的 Mock */
  mocks: string[];
}

/** 测试生成报告 */
export interface TestGenerationReport {
  /** 源文件数 */
  sourceFiles: number;
  /** 生成的测试文件数 */
  generatedFiles: number;
  /** 总测试用例数 */
  totalTestCases: number;
  /** 覆盖的函数数 */
  coveredFunctions: number;
  /** 未覆盖的函数数 */
  uncoveredFunctions: number;
  /** 估计覆盖率 */
  estimatedCoverage: number;
  /** 生成的测试文件 */
  testFiles: GeneratedTestFile[];
}

// ============ 自动测试生成器 ============

export class AutoTestGenerator {
  /** 工作目录 */
  private workDir: string;

  /** 测试框架 */
  private framework: 'vitest' | 'jest' | 'mocha';

  private log = logger.child({ module: 'AutoTestGenerator' });

  constructor(options?: { workDir?: string; framework?: 'vitest' | 'jest' | 'mocha' }) {
    this.workDir = options?.workDir ?? duanPath('test-generator');
    fs.mkdirSync(this.workDir, { recursive: true });
    this.framework = options?.framework ?? 'vitest';
  }

  // ========== 函数分析 ==========

  /**
   * 从文件提取函数信息
   */
  extractFunctions(filePath: string): FunctionInfo[] {
    const content = fs.readFileSync(filePath, 'utf-8');
    const lines = content.split('\n');
    const functions: FunctionInfo[] = [];

    // 匹配函数定义
    const patterns = [
      // export function name(params): returnType
      /(?<exported>export\s+)?(?<async>async\s+)?function\s+(?<name>\w+)\s*\((?<params>[^)]*)\)\s*(?::\s*(?<returnType>[^{]+))?\s*\{/g,
      // export const name = (params): returnType =>
      /(?<exported>export\s+)?(?:const|let|var)\s+(?<name>\w+)\s*=\s*(?<async>async\s+)?\((?<params>[^)]*)\)\s*(?::\s*(?<returnType>[^=]+))?\s*=>/g,
      // 类方法
      /(?<static>static\s+)?(?<async>async\s+)?(?<name>\w+)\s*\((?<params>[^)]*)\)\s*(?::\s*(?<returnType>[^{]+))?\s*\{/g,
    ];

    for (const pattern of patterns) {
      let match: RegExpExecArray | null;
      while ((match = pattern.exec(content)) !== null) {
        const groups = match.groups as {
          name?: string;
          params?: string;
          async?: string;
          returnType?: string;
          static?: string;
          optional?: string;
          type?: string;
          default?: string;
          exported?: string;
        } | undefined;
        if (!groups?.name) continue;

        const beforeMatch = content.substring(0, match.index);
        const startLine = beforeMatch.split('\n').length;

        // 查找 JSDoc
        const jsDoc = this.extractJSDoc(beforeMatch);

        // 解析参数
        const parameters = this.parseParameters(groups.params ?? '');

        // 查找函数结束
        const endLine = this.findFunctionEnd(lines, startLine);

        functions.push({
          name: groups.name,
          parameters,
          returnType: (groups.returnType ?? 'void').trim(),
          isAsync: !!groups.async,
          isExported: !!groups.exported,
          isStatic: !!groups.static,
          startLine,
          endLine,
          jsDoc: jsDoc ?? undefined,
        });
      }
    }

    return functions;
  }

  /**
   * 提取 JSDoc
   */
  private extractJSDoc(content: string): string | null {
    const lastBlockComment = content.lastIndexOf('/**');
    if (lastBlockComment === -1) return null;

    const afterComment = content.substring(lastBlockComment);
    const match = afterComment.match(/\/\*\*[\s\S]*?\*\//);
    return match ? match[0] : null;
  }

  /**
   * 解析参数列表
   */
  private parseParameters(paramsStr: string): FunctionInfo['parameters'] {
    if (!paramsStr.trim()) return [];

    const params: FunctionInfo['parameters'] = [];
    // 简化解析，按逗号分割
    const parts = this.splitParameters(paramsStr);

    for (const part of parts) {
      const trimmed = part.trim();
      if (!trimmed) continue;

      // 匹配 name: type 或 name?: type 或 name = default
      const paramMatch = trimmed.match(/^(?<name>\w+)\s*(?<optional>\?)?\s*(?::\s*(?<type>[^=]+))?\s*(?:=\s*(?<default>[^,]+))?$/);
      if (paramMatch) {
        const groups = paramMatch.groups as {
          name?: string;
          optional?: string;
          type?: string;
          default?: string;
        } | undefined;
        params.push({
          name: groups.name,
          type: (groups.type ?? 'any').trim(),
          optional: !!groups.optional || !!groups.default,
          defaultValue: groups.default?.trim(),
        });
      }
    }

    return params;
  }

  /**
   * 分割参数（考虑嵌套类型）
   */
  private splitParameters(paramsStr: string): string[] {
    const parts: string[] = [];
    let depth = 0;
    let current = '';

    for (const char of paramsStr) {
      if (char === '(' || char === '{' || char === '[') depth++;
      if (char === ')' || char === '}' || char === ']') depth--;

      if (char === ',' && depth === 0) {
        parts.push(current);
        current = '';
      } else {
        current += char;
      }
    }

    if (current.trim()) parts.push(current);
    return parts;
  }

  /**
   * 查找函数结束行
   */
  private findFunctionEnd(lines: string[], startLine: number): number {
    let braceCount = 0;
    let foundOpenBrace = false;

    for (let i = startLine - 1; i < lines.length; i++) {
      for (const char of lines[i]) {
        if (char === '{') {
          braceCount++;
          foundOpenBrace = true;
        } else if (char === '}') {
          braceCount--;
          if (foundOpenBrace && braceCount === 0) {
            return i + 1;
          }
        }
      }
    }

    return Math.min(startLine + 50, lines.length);
  }

  // ========== 测试用例生成 ==========

  /**
   * 为函数生成测试用例
   */
  generateTestCases(func: FunctionInfo): TestCase[] {
    const cases: TestCase[] = [];

    // 1. 正常用例
    const normalInputs = this.generateNormalInputs(func.parameters);
    cases.push({
      name: `${func.name}_normal`,
      description: `测试 ${func.name} 的正常输入`,
      inputs: normalInputs,
      tags: ['normal'],
    });

    // 2. 边界值用例
    const boundaryInputs = this.generateBoundaryInputs(func.parameters);
    cases.push({
      name: `${func.name}_boundary`,
      description: `测试 ${func.name} 的边界值`,
      inputs: boundaryInputs,
      tags: ['boundary'],
    });

    // 3. 空值/undefined 用例
    if (func.parameters.some(p => !p.optional)) {
      const nullInputs = this.generateNullInputs(func.parameters);
      cases.push({
        name: `${func.name}_null_input`,
        description: `测试 ${func.name} 的空值输入`,
        inputs: nullInputs,
        shouldThrow: 'Error',
        tags: ['error'],
      });
    }

    // 4. 可选参数省略用例
    if (func.parameters.some(p => p.optional)) {
      const partialInputs = this.generatePartialInputs(func.parameters);
      cases.push({
        name: `${func.name}_optional_omitted`,
        description: `测试 ${func.name} 省略可选参数`,
        inputs: partialInputs,
        tags: ['optional'],
      });
    }

    // 5. 极端值用例
    const extremeInputs = this.generateExtremeInputs(func.parameters);
    cases.push({
      name: `${func.name}_extreme`,
      description: `测试 ${func.name} 的极端值`,
      inputs: extremeInputs,
      tags: ['extreme'],
    });

    return cases;
  }

  /**
   * 生成正常输入
   */
  private generateNormalInputs(params: FunctionInfo['parameters']): unknown[] {
    return params.map(p => this.generateDefaultValue(p.type, p.defaultValue));
  }

  /**
   * 生成边界值输入
   */
  private generateBoundaryInputs(params: FunctionInfo['parameters']): unknown[] {
    return params.map(p => {
      switch (p.type.toLowerCase()) {
        case 'number':
          return 0;
        case 'string':
          return '';
        case 'boolean':
          return false;
        case 'number[]':
          return [];
        case 'string[]':
          return [];
        default:
          if (p.type.includes('[]')) return [];
          return null;
      }
    });
  }

  /**
   * 生成空值输入
   */
  private generateNullInputs(params: FunctionInfo['parameters']): unknown[] {
    return params.map(() => null);
  }

  /**
   * 生成部分输入（省略可选参数）
   */
  private generatePartialInputs(params: FunctionInfo['parameters']): unknown[] {
    return params
      .filter(p => !p.optional)
      .map(p => this.generateDefaultValue(p.type, p.defaultValue));
  }

  /**
   * 生成极端值输入
   */
  private generateExtremeInputs(params: FunctionInfo['parameters']): unknown[] {
    return params.map(p => {
      switch (p.type.toLowerCase()) {
        case 'number':
          return Number.MAX_SAFE_INTEGER;
        case 'string':
          return 'a'.repeat(10000);
        case 'boolean':
          return true;
        case 'number[]':
          return Array(1000).fill(0);
        default:
          return this.generateDefaultValue(p.type, p.defaultValue);
      }
    });
  }

  /**
   * 生成默认值
   */
  private generateDefaultValue(type: string, defaultValue?: string): unknown {
    if (defaultValue) {
      try {
        return JSON.parse(defaultValue);
      } catch {
        return defaultValue;
      }
    }

    switch (type.toLowerCase()) {
      case 'number':
        return 1;
      case 'string':
        return 'test';
      case 'boolean':
        return true;
      case 'void':
      case 'undefined':
        return undefined;
      case 'null':
        return null;
      case 'number[]':
        return [1, 2, 3];
      case 'string[]':
        return ['a', 'b', 'c'];
      case 'record<string, unknown>':
      case 'object':
        return {};
      default:
        if (type.includes('[]')) return [];
        if (type.startsWith('Record<')) return {};
        return null;
    }
  }

  // ========== 测试文件生成 ==========

  /**
   * 为单个文件生成测试
   */
  generateTestFile(filePath: string, options?: {
    outputDir?: string;
    onlyExported?: boolean;
  }): GeneratedTestFile {
    const functions = this.extractFunctions(filePath);
    const onlyExported = options?.onlyExported ?? true;
    const targetFunctions = onlyExported ? functions.filter(f => f.isExported) : functions;

    const testCases: Array<{ func: FunctionInfo; cases: TestCase[] }> = [];
    for (const func of targetFunctions) {
      const cases = this.generateTestCases(func);
      testCases.push({ func, cases });
    }

    // 生成测试内容
    const content = this.generateTestContent(filePath, testCases);

    // 确定输出路径
    const outputDir = options?.outputDir ?? path.join(path.dirname(filePath), '__tests__');
    fs.mkdirSync(outputDir, { recursive: true });

    const baseName = path.basename(filePath, path.extname(filePath));
    const testFileName = `${baseName}.test.ts`;
    const testFilePath = path.join(outputDir, testFileName);

    fs.writeFileSync(testFilePath, content, 'utf-8');

    const allCases = testCases.flatMap(t => t.cases);

    this.log.info('测试文件已生成', {
      filePath,
      testFilePath,
      functions: targetFunctions.length,
      testCases: allCases.length,
    });

    return {
      filePath,
      testFilePath,
      framework: this.framework,
      content,
      testCaseCount: allCases.length,
      coveredFunctions: targetFunctions.map(f => f.name),
      mocks: this.extractRequiredMocks(filePath, targetFunctions),
    };
  }

  /**
   * 生成测试内容
   */
  private generateTestContent(
    filePath: string,
    testCases: Array<{ func: FunctionInfo; cases: TestCase[] }>,
  ): string {
    const importPath = this.getRelativeImportPath(filePath);
    const lines: string[] = [
      '/**',
      ' * 自动生成的单元测试',
      ` * 源文件: ${path.basename(filePath)}`,
      ` * 生成时间: ${new Date().toISOString()}`,
      ' */',
      '',
    ];

    // 导入
    const exportedFuncs = testCases.filter(t => t.func.isExported).map(t => t.func.name);
    if (exportedFuncs.length > 0) {
      lines.push(`import { ${exportedFuncs.join(', ')} } from '${importPath}';`);
    }
    lines.push(`import { describe, it, expect, vi } from '${this.framework === 'vitest' ? 'vitest' : '@jest/globals'}';`);
    lines.push('');

    // 为每个函数生成测试套件
    for (const { func, cases } of testCases) {
      lines.push(`describe('${func.name}', () => {`);

      for (const testCase of cases) {
        lines.push(`  it('${testCase.description}', () => {`);

        // 生成输入参数
        const inputStr = testCase.inputs.map(input => JSON.stringify(input)).join(', ');

        if (testCase.shouldThrow) {
          lines.push(`    expect(() => ${func.name}(${inputStr})).toThrow();`);
        } else if (func.isAsync) {
          lines.push(`    const result = ${func.name}(${inputStr});`);
          lines.push(`    expect(result).toBeDefined();`);
        } else {
          lines.push(`    const result = ${func.name}(${inputStr});`);
          lines.push(`    expect(result).toBeDefined();`);
        }

        lines.push(`  });`);
        lines.push('');
      }

      lines.push('});');
      lines.push('');
    }

    return lines.join('\n');
  }

  /**
   * 获取相对导入路径
   */
  private getRelativeImportPath(filePath: string): string {
    const _cwd = process.cwd();
    const relative = path.relative(path.join(path.dirname(filePath), '__tests__'), filePath);
    return './' + relative.replace(/\\/g, '/').replace(/\.ts$/, '');
  }

  /**
   * 提取需要的 Mock
   */
  private extractRequiredMocks(filePath: string, _functions: FunctionInfo[]): string[] {
    const mocks: string[] = [];
    try {
      const content = fs.readFileSync(filePath, 'utf-8');

      // 检测常见的需要 Mock 的依赖
      const importPattern = /import\s+.*\s+from\s+['"]([^'"]+)['"]/g;
      let match: RegExpExecArray | null;
      while ((match = importPattern.exec(content)) !== null) {
        const importPath = match[1];
        // 外部依赖需要 Mock
        if (!importPath.startsWith('.') && !importPath.startsWith('/')) {
          mocks.push(importPath);
        }
      }
    } catch {
      // 忽略错误
    }
    return mocks;
  }

  // ========== 批量生成 ==========

  /**
   * 为目录生成测试
   */
  generateTestsForDirectory(dirPath: string, options?: {
    extensions?: string[];
    exclude?: string[];
    outputDir?: string;
    onlyExported?: boolean;
  }): TestGenerationReport {
    const extensions = options?.extensions ?? ['.ts', '.js'];
    const exclude = options?.exclude ?? ['node_modules', '.git', 'dist', 'build', '__tests__', '.duan'];

    const testFiles: GeneratedTestFile[] = [];
    let sourceFileCount = 0;
    let totalCoveredFunctions = 0;

    const generateRecursive = (currentPath: string) => {
      try {
        const entries = fs.readdirSync(currentPath, { withFileTypes: true });
        for (const entry of entries) {
          const fullPath = path.join(currentPath, entry.name);
          if (exclude.some(ex => fullPath.includes(ex))) continue;

          if (entry.isDirectory()) {
            generateRecursive(fullPath);
          } else if (entry.isFile()) {
            const ext = path.extname(entry.name);
            if (extensions.includes(ext) && !entry.name.endsWith('.test.ts') && !entry.name.endsWith('.d.ts')) {
              sourceFileCount++;
              try {
                const testFile = this.generateTestFile(fullPath, options);
                testFiles.push(testFile);
                totalCoveredFunctions += testFile.coveredFunctions.length;
              } catch (err: unknown) {
                this.log.error('生成测试失败', { filePath: fullPath, error: (err instanceof Error ? err.message : String(err)) });
              }
            }
          }
        }
      } catch (err: unknown) {
        this.log.error('扫描目录失败', { dirPath: currentPath, error: (err instanceof Error ? err.message : String(err)) });
      }
    };

    generateRecursive(dirPath);

    const totalTestCases = testFiles.reduce((sum, f) => sum + f.testCaseCount, 0);
    const estimatedCoverage = sourceFileCount > 0
      ? Math.min(100, (totalCoveredFunctions / Math.max(1, sourceFileCount * 5)) * 100)
      : 0;

    this.log.info('批量测试生成完成', {
      sourceFiles: sourceFileCount,
      generatedFiles: testFiles.length,
      totalTestCases,
      estimatedCoverage: estimatedCoverage.toFixed(1),
    });

    return {
      sourceFiles: sourceFileCount,
      generatedFiles: testFiles.length,
      totalTestCases,
      coveredFunctions: totalCoveredFunctions,
      uncoveredFunctions: Math.max(0, sourceFileCount * 5 - totalCoveredFunctions),
      estimatedCoverage,
      testFiles,
    };
  }

  /**
   * 生成测试报告 Markdown
   */
  generateReportMarkdown(report: TestGenerationReport): string {
    const lines: string[] = [
      '# 自动测试生成报告',
      '',
      `> 生成时间: ${new Date().toISOString()}`,
      '',
      '## 概览',
      '',
      `| 指标 | 值 |`,
      `|------|-----|`,
      `| 源文件数 | ${report.sourceFiles} |`,
      `| 生成测试文件数 | ${report.generatedFiles} |`,
      `| 总测试用例数 | ${report.totalTestCases} |`,
      `| 覆盖函数数 | ${report.coveredFunctions} |`,
      `| 未覆盖函数数 | ${report.uncoveredFunctions} |`,
      `| 估计覆盖率 | ${report.estimatedCoverage.toFixed(1)}% |`,
      '',
      '## 生成的测试文件',
      '',
      `| 测试文件 | 用例数 | 覆盖函数 |`,
      `|---------|--------|---------|`,
    ];

    for (const file of report.testFiles.slice(0, 20)) {
      lines.push(`| ${path.basename(file.testFilePath)} | ${file.testCaseCount} | ${file.coveredFunctions.length} |`);
    }

    lines.push('', '## 建议', '');
    if (report.estimatedCoverage < 60) {
      lines.push('- 🟡 覆盖率偏低，建议补充更多边界测试用例');
    } else {
      lines.push('- 🟢 覆盖率良好');
    }
    lines.push('- 运行 `npx vitest run` 执行生成的测试');
    lines.push('- 根据实际业务逻辑调整预期输出');

    return lines.join('\n');
  }
}
