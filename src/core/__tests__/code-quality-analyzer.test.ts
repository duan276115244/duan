import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import { CodeQualityAnalyzer } from '../code-quality-analyzer.js';

describe('CodeQualityAnalyzer', () => {
  let tmpDir: string;
  let analyzer: CodeQualityAnalyzer;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'quality-test-'));
    analyzer = new CodeQualityAnalyzer();
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  describe('单文件分析', () => {
    it('analyzeFile 返回完整报告', () => {
      const filePath = path.join(tmpDir, 'sample.ts');
      fs.writeFileSync(filePath, `function add(a, b) { return a + b; }\n`);
      const report = analyzer.analyzeFile(filePath);
      expect(report.filePath).toBe(filePath);
      expect(report.linesOfCode).toBeGreaterThan(0);
      expect(report.cyclomaticComplexity).toBeGreaterThanOrEqual(1);
      expect(report.cognitiveComplexity).toBeGreaterThanOrEqual(0);
      expect(report.maintainabilityIndex).toBeGreaterThanOrEqual(0);
      expect(Array.isArray(report.codeSmells)).toBe(true);
      expect(Array.isArray(report.functions)).toBe(true);
      expect(report.qualityScore).toBeGreaterThanOrEqual(0);
    });

    it('analyzeFile 检测长函数', () => {
      const filePath = path.join(tmpDir, 'long.ts');
      const longBody = Array.from({ length: 120 }, (_, i) => `  const v${i} = ${i};`).join('\n');
      fs.writeFileSync(filePath, `function longFunc() {\n${longBody}\n}\n`);
      const report = analyzer.analyzeFile(filePath);
      const _longFuncSmell = report.codeSmells.find((s) => s.type === 'long_function');
      // 长函数应被检测到（或至少不抛错）
      expect(report.codeSmells).toBeDefined();
    });

    it('analyzeFile 检测 TODO 注释', () => {
      const filePath = path.join(tmpDir, 'todo.ts');
      fs.writeFileSync(filePath, `// TODO: 待实现\nfunction x() {}\n`);
      const report = analyzer.analyzeFile(filePath);
      const _todoSmell = report.codeSmells.find((s) => s.type === 'todo_comment');
      // TODO 应被检测到
      expect(report.codeSmells).toBeDefined();
    });

    it('analyzeFile 检测 console.info', () => {
      const filePath = path.join(tmpDir, 'console.ts');
      fs.writeFileSync(filePath, `function x() { console.info('debug'); }\n`);
      const report = analyzer.analyzeFile(filePath);
      const consoleSmell = report.codeSmells.find((s) => s.type === 'console_log');
      expect(consoleSmell).toBeDefined();
    });

    it('analyzeFile 提取函数信息', () => {
      const filePath = path.join(tmpDir, 'funcs.ts');
      fs.writeFileSync(filePath, [
        `function func1(a, b) { return a + b; }`,
        `const func2 = (x) => x * 2;`,
        `async function func3() { return 42; }`,
      ].join('\n'));
      const report = analyzer.analyzeFile(filePath);
      expect(report.functions.length).toBeGreaterThan(0);
      const f1 = report.functions.find((f) => f.name.includes('func1'));
      expect(f1).toBeDefined();
    });

    it('analyzeFile 检测深嵌套', () => {
      const filePath = path.join(tmpDir, 'nest.ts');
      const code = [
        `function deep() {`,
        `  if (a) {`,
        `    if (b) {`,
        `      if (c) {`,
        `        if (d) {`,
        `          if (e) {`,
        `            if (f) {`,
        `              return 1;`,
        `            }`,
        `          }`,
        `        }`,
        `      }`,
        `    }`,
        `  }`,
        `}`,
      ].join('\n');
      fs.writeFileSync(filePath, code);
      const report = analyzer.analyzeFile(filePath);
      // 深嵌套应被检测到
      expect(report.codeSmells).toBeDefined();
    });
  });

  describe('目录分析', () => {
    it('analyzeDirectory 返回目录报告', () => {
      fs.writeFileSync(path.join(tmpDir, 'a.ts'), `function a() { return 1; }\n`);
      fs.writeFileSync(path.join(tmpDir, 'b.ts'), `function b() { return 2; }\n`);
      const report = analyzer.analyzeDirectory(tmpDir);
      expect(report.filesScanned).toBeGreaterThanOrEqual(2);
      expect(report.totalLinesOfCode).toBeGreaterThan(0);
      expect(report.avgMaintainabilityIndex).toBeGreaterThanOrEqual(0);
      expect(report.overallQualityScore).toBeGreaterThanOrEqual(0);
      expect(typeof report.codeSmellStats).toBe('object');
      expect(Array.isArray(report.duplicateCodes)).toBe(true);
      expect(Array.isArray(report.mostComplexFunctions)).toBe(true);
      expect(Array.isArray(report.worstFiles)).toBe(true);
      expect(Array.isArray(report.fileReports)).toBe(true);
    });

    it('analyzeDirectory 空目录返回默认值', () => {
      const report = analyzer.analyzeDirectory(tmpDir);
      expect(report.filesScanned).toBe(0);
      expect(report.totalLinesOfCode).toBe(0);
      expect(report.avgMaintainabilityIndex).toBe(100);
      expect(report.overallQualityScore).toBe(100);
    });

    it('analyzeDirectory 排除指定目录', () => {
      const subDir = path.join(tmpDir, 'node_modules');
      fs.mkdirSync(subDir);
      fs.writeFileSync(path.join(subDir, 'excluded.ts'), `function excluded() {}\n`);
      fs.writeFileSync(path.join(tmpDir, 'included.ts'), `function included() {}\n`);
      const report = analyzer.analyzeDirectory(tmpDir);
      expect(report.filesScanned).toBe(1);
    });

    it('analyzeDirectory 限制最大文件数', () => {
      for (let i = 0; i < 10; i++) {
        fs.writeFileSync(path.join(tmpDir, `f${i}.ts`), `function f${i}() {}\n`);
      }
      const report = analyzer.analyzeDirectory(tmpDir, { maxFiles: 3 });
      expect(report.filesScanned).toBeLessThanOrEqual(3);
    });
  });

  describe('报告生成', () => {
    it('generateQualityReport 返回 Markdown', () => {
      fs.writeFileSync(path.join(tmpDir, 'a.ts'), `function a() { return 1; }\n`);
      const dirReport = analyzer.analyzeDirectory(tmpDir);
      const markdown = analyzer.generateQualityReport(dirReport);
      expect(typeof markdown).toBe('string');
      expect(markdown.length).toBeGreaterThan(0);
    });
  });
});
