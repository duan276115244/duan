import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import { AutoTestGenerator } from '../auto-test-generator.js';

describe('AutoTestGenerator', () => {
  let tmpDir: string;
  let generator: AutoTestGenerator;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'testgen-test-'));
    generator = new AutoTestGenerator({ workDir: tmpDir, framework: 'vitest' });
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  describe('函数提取', () => {
    it('extractFunctions 提取 function 声明', () => {
      const filePath = path.join(tmpDir, 'funcs.ts');
      fs.writeFileSync(filePath, [
        `export function add(a: number, b: number): number { return a + b; }`,
        `function internal(x: string): void { console.info(x); }`,
      ].join('\n'));
      const funcs = generator.extractFunctions(filePath);
      expect(funcs.length).toBeGreaterThan(0);
      const addFn = funcs.find((f) => f.name === 'add');
      expect(addFn).toBeDefined();
      expect(addFn!.isExported).toBe(true);
      expect(addFn!.parameters).toHaveLength(2);
    });

    it('extractFunctions 提取箭头函数', () => {
      const filePath = path.join(tmpDir, 'arrow.ts');
      fs.writeFileSync(filePath, [
        `export const multiply = (a: number, b: number): number => a * b;`,
      ].join('\n'));
      const funcs = generator.extractFunctions(filePath);
      const mulFn = funcs.find((f) => f.name === 'multiply');
      expect(mulFn).toBeDefined();
      expect(mulFn!.isExported).toBe(true);
    });

    it('extractFunctions 提取 async 函数', () => {
      const filePath = path.join(tmpDir, 'async.ts');
      fs.writeFileSync(filePath, [
        `export async function fetchData(url: string): Promise<void> { return; }`,
      ].join('\n'));
      const funcs = generator.extractFunctions(filePath);
      const fn = funcs.find((f) => f.name === 'fetchData');
      expect(fn).toBeDefined();
      expect(fn!.isAsync).toBe(true);
    });

    it('extractFunctions 提取可选参数', () => {
      const filePath = path.join(tmpDir, 'optional.ts');
      fs.writeFileSync(filePath, [
        `export function greet(name: string, greeting?: string): string { return name; }`,
      ].join('\n'));
      const funcs = generator.extractFunctions(filePath);
      const fn = funcs.find((f) => f.name === 'greet');
      expect(fn).toBeDefined();
      expect(fn!.parameters).toHaveLength(2);
      expect(fn!.parameters[1].optional).toBe(true);
    });

    it('extractFunctions 提取带默认值的参数', () => {
      const filePath = path.join(tmpDir, 'default.ts');
      fs.writeFileSync(filePath, [
        `export function create(name: string, count: number = 10): void {}`,
      ].join('\n'));
      const funcs = generator.extractFunctions(filePath);
      const fn = funcs.find((f) => f.name === 'create');
      expect(fn).toBeDefined();
      expect(fn!.parameters[1].defaultValue).toBe('10');
    });
  });

  describe('测试用例生成', () => {
    it('generateTestCases 生成多个用例', () => {
      const func = {
        name: 'add',
        parameters: [
          { name: 'a', type: 'number', optional: false },
          { name: 'b', type: 'number', optional: false },
        ],
        returnType: 'number',
        isAsync: false,
        isExported: true,
        isStatic: false,
        startLine: 1,
        endLine: 1,
      };
      const cases = generator.generateTestCases(func);
      expect(cases.length).toBeGreaterThanOrEqual(3);
      // 包含 normal、boundary、extreme
      const tags = cases.flatMap((c) => c.tags);
      expect(tags).toContain('normal');
      expect(tags).toContain('boundary');
      expect(tags).toContain('extreme');
    });

    it('generateTestCases 有可选参数时生成 optional 用例', () => {
      const func = {
        name: 'greet',
        parameters: [
          { name: 'name', type: 'string', optional: false },
          { name: 'greeting', type: 'string', optional: true },
        ],
        returnType: 'string',
        isAsync: false,
        isExported: true,
        isStatic: false,
        startLine: 1,
        endLine: 1,
      };
      const cases = generator.generateTestCases(func);
      const optionalCase = cases.find((c) => c.tags.includes('optional'));
      expect(optionalCase).toBeDefined();
    });

    it('generateTestCases 有必填参数时生成 null 用例', () => {
      const func = {
        name: 'required',
        parameters: [
          { name: 'x', type: 'number', optional: false },
        ],
        returnType: 'number',
        isAsync: false,
        isExported: true,
        isStatic: false,
        startLine: 1,
        endLine: 1,
      };
      const cases = generator.generateTestCases(func);
      const errorCase = cases.find((c) => c.tags.includes('error'));
      expect(errorCase).toBeDefined();
      expect(errorCase!.shouldThrow).toBe('Error');
    });

    it('generateTestCases 边界值正确', () => {
      const func = {
        name: 'numFn',
        parameters: [
          { name: 'n', type: 'number', optional: false },
          { name: 's', type: 'string', optional: false },
        ],
        returnType: 'void',
        isAsync: false,
        isExported: true,
        isStatic: false,
        startLine: 1,
        endLine: 1,
      };
      const cases = generator.generateTestCases(func);
      const boundary = cases.find((c) => c.tags.includes('boundary'));
      expect(boundary).toBeDefined();
      expect(boundary!.inputs[0]).toBe(0);
      expect(boundary!.inputs[1]).toBe('');
    });

    it('generateTestCases 极端值正确', () => {
      const func = {
        name: 'extremeFn',
        parameters: [
          { name: 'n', type: 'number', optional: false },
        ],
        returnType: 'void',
        isAsync: false,
        isExported: true,
        isStatic: false,
        startLine: 1,
        endLine: 1,
      };
      const cases = generator.generateTestCases(func);
      const extreme = cases.find((c) => c.tags.includes('extreme'));
      expect(extreme).toBeDefined();
      expect(extreme!.inputs[0]).toBe(Number.MAX_SAFE_INTEGER);
    });
  });

  describe('测试文件生成', () => {
    it('generateTestFile 生成测试文件', () => {
      const filePath = path.join(tmpDir, 'target.ts');
      fs.writeFileSync(filePath, [
        `export function add(a: number, b: number): number { return a + b; }`,
      ].join('\n'));
      const result = generator.generateTestFile(filePath);
      expect(result.filePath).toBeTruthy();
      expect(result.coveredFunctions.length).toBeGreaterThan(0);
      expect(result.testCaseCount).toBeGreaterThan(0);
      expect(fs.existsSync(result.filePath)).toBe(true);
      const content = fs.readFileSync(result.filePath, 'utf-8');
      expect(content).toContain('add');
    });

    it('generateTestFile onlyExported 只测试导出函数', () => {
      const filePath = path.join(tmpDir, 'mixed.ts');
      fs.writeFileSync(filePath, [
        `export function exported() {}`,
        `function internal() {}`,
      ].join('\n'));
      const result = generator.generateTestFile(filePath, { onlyExported: true });
      expect(result.coveredFunctions.includes('exported')).toBe(true);
      expect(result.coveredFunctions.includes('internal')).toBe(false);
    });

    it('generateTestFile 自定义输出目录', () => {
      const filePath = path.join(tmpDir, 'src.ts');
      const outputDir = path.join(tmpDir, 'custom-tests');
      fs.writeFileSync(filePath, `export function fn(): void {}`);
      const result = generator.generateTestFile(filePath, { outputDir });
      expect(result.testFilePath).toContain('custom-tests');
    });
  });

  describe('批量生成', () => {
    it('generateTestsForDirectory 批量生成', () => {
      fs.writeFileSync(path.join(tmpDir, 'a.ts'), `export function a(): void {}`);
      fs.writeFileSync(path.join(tmpDir, 'b.ts'), `export function b(): void {}`);
      const report = generator.generateTestsForDirectory(tmpDir);
      expect(report.sourceFiles).toBeGreaterThanOrEqual(2);
      expect(report.generatedFiles).toBeGreaterThanOrEqual(2);
      expect(report.totalTestCases).toBeGreaterThan(0);
      expect(report.coveredFunctions).toBeGreaterThan(0);
      expect(report.estimatedCoverage).toBeGreaterThanOrEqual(0);
      expect(report.estimatedCoverage).toBeLessThanOrEqual(100);
      expect(Array.isArray(report.testFiles)).toBe(true);
    });

    it('generateTestsForDirectory 排除测试文件', () => {
      fs.writeFileSync(path.join(tmpDir, 'a.ts'), `export function a(): void {}`);
      fs.writeFileSync(path.join(tmpDir, 'a.test.ts'), `it('x', () => {});`);
      const report = generator.generateTestsForDirectory(tmpDir);
      expect(report.sourceFiles).toBe(1);
    });

    it('generateTestsForDirectory 空目录返回默认值', () => {
      const report = generator.generateTestsForDirectory(tmpDir);
      expect(report.sourceFiles).toBe(0);
      expect(report.generatedFiles).toBe(0);
      expect(report.totalTestCases).toBe(0);
    });
  });

  describe('报告生成', () => {
    it('generateReportMarkdown 返回 Markdown', () => {
      fs.writeFileSync(path.join(tmpDir, 'a.ts'), `export function a(): void {}`);
      const report = generator.generateTestsForDirectory(tmpDir);
      const md = generator.generateReportMarkdown(report);
      expect(typeof md).toBe('string');
      expect(md).toContain('自动测试生成报告');
    });
  });
});
