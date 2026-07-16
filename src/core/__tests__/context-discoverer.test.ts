/**
 * v20.0 §3.2 动态上下文发现测试
 *
 * 测试 ContextDiscoverer 的核心功能：
 * - 三大发现策略（query/openfile/gitdiff）
 * - token 预算裁剪
 * - 透明化摘要
 * - 工具定义与执行
 * - 单例
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import { ContextDiscoverer, getContextDiscoverer, type DiscoveredFile } from '../context-discoverer.js';

// ============ 工具：创建临时项目 ============

function createTempProject(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ctx-disc-'));
  return dir;
}

function writeFile(base: string, relPath: string, content: string): string {
  const fullPath = path.join(base, relPath);
  fs.mkdirSync(path.dirname(fullPath), { recursive: true });
  fs.writeFileSync(fullPath, content, 'utf-8');
  return fullPath;
}

// ============ Mock CodebaseIndexer ============

function createMockIndexer(results: Array<{ filePath: string; symbolName: string; score: number; reason: string }>): any {
  return {
    searchSemantic: (_query: string, _limit: number) => {
      return results.map(r => ({
        symbol: {
          name: r.symbolName,
          kind: 'function',
          filePath: r.filePath,
          line: 1,
          language: 'typescript',
        },
        score: r.score,
        reason: r.reason,
      }));
    },
  };
}

// ============ 测试 ============

describe('v20.0 §3.2: ContextDiscoverer', () => {
  let discoverer: ContextDiscoverer;
  let tmpProject: string;

  beforeEach(() => {
    discoverer = new ContextDiscoverer();
    tmpProject = createTempProject();
  });

  afterEach(() => {
    try {
      fs.rmSync(tmpProject, { recursive: true, force: true });
    } catch {
      // ignore
    }
  });

  describe('discoverFromQuery', () => {
    it('无 CodebaseIndexer 时返回空数组', () => {
      const files = discoverer.discoverFromQuery('查询', null);
      expect(files).toEqual([]);
    });

    it('从 CodebaseIndexer 结果提取文件', () => {
      const mockIndexer = createMockIndexer([
        { filePath: 'src/api.ts', symbolName: 'getUser', score: 0.9, reason: '匹配 getUser' },
        { filePath: 'src/utils.ts', symbolName: 'formatDate', score: 0.7, reason: '匹配 formatDate' },
      ]);
      const files = discoverer.discoverFromQuery('user query', mockIndexer);
      expect(files.length).toBe(2);
      expect(files[0].filePath).toBe('src/api.ts');
      expect(files[0].score).toBe(0.9);
      expect(files[0].source).toBe('query');
      expect(files[0].matchedSymbols).toContain('getUser');
    });

    it('同一文件的多个符号合并', () => {
      const mockIndexer = createMockIndexer([
        { filePath: 'src/api.ts', symbolName: 'getUser', score: 0.9, reason: '匹配 getUser' },
        { filePath: 'src/api.ts', symbolName: 'deleteUser', score: 0.7, reason: '匹配 deleteUser' },
      ]);
      const files = discoverer.discoverFromQuery('user', mockIndexer);
      expect(files.length).toBe(1);
      expect(files[0].filePath).toBe('src/api.ts');
      expect(files[0].score).toBe(0.9); // 取最高分
      expect(files[0].matchedSymbols).toContain('getUser');
      expect(files[0].matchedSymbols).toContain('deleteUser');
    });

    it('分数不超过 1', () => {
      const mockIndexer = createMockIndexer([
        { filePath: 'src/api.ts', symbolName: 'foo', score: 1.5, reason: '高匹配' },
      ]);
      const files = discoverer.discoverFromQuery('foo', mockIndexer);
      expect(files[0].score).toBeLessThanOrEqual(1);
    });
  });

  describe('discoverFromOpenFile', () => {
    it('从 import 语句发现相关文件', async () => {
      writeFile(tmpProject, 'src/utils.ts', 'export function foo() {}');
      writeFile(tmpProject, 'src/main.ts', `import { foo } from './utils';\nfoo();`);

      const files = await discoverer.discoverFromOpenFile('src/main.ts', tmpProject);
      expect(files.length).toBeGreaterThan(0);
      const paths = files.map(f => f.filePath);
      expect(paths.some(p => p.includes('utils.ts'))).toBe(true);
    });

    it('CommonJS require 也能识别', async () => {
      writeFile(tmpProject, 'src/helper.js', 'module.exports = {};');
      writeFile(tmpProject, 'src/index.js', `const helper = require('./helper');`);

      const files = await discoverer.discoverFromOpenFile('src/index.js', tmpProject);
      expect(files.length).toBeGreaterThan(0);
      expect(files.some(f => f.filePath.includes('helper.js'))).toBe(true);
    });

    it('跳过 npm 包导入', async () => {
      writeFile(tmpProject, 'src/main.ts', `import React from 'react';\nimport { foo } from './utils';`);

      const files = await discoverer.discoverFromOpenFile('src/main.ts', tmpProject);
      // 只应发现 ./utils（不存在则空），不应尝试解析 react
      expect(files.every(f => !f.filePath.includes('react'))).toBe(true);
    });

    it('文件不存在时返回空数组', async () => {
      const files = await discoverer.discoverFromOpenFile('nonexistent.ts', tmpProject);
      expect(files).toEqual([]);
    });

    it('非代码文件返回空数组', async () => {
      writeFile(tmpProject, 'readme.txt', 'import something');
      const files = await discoverer.discoverFromOpenFile('readme.txt', tmpProject);
      expect(files).toEqual([]);
    });

    it('source 为 openfile', async () => {
      writeFile(tmpProject, 'src/utils.ts', 'export function foo() {}');
      writeFile(tmpProject, 'src/main.ts', `import { foo } from './utils';`);

      const files = await discoverer.discoverFromOpenFile('src/main.ts', tmpProject);
      expect(files.length).toBeGreaterThan(0);
      expect(files[0].source).toBe('openfile');
    });
  });

  describe('discoverFromGitDiff', () => {
    it('非 git 仓库返回空数组', () => {
      // tmpProject 不是 git 仓库
      discoverer.invalidateCache();
      const files = discoverer.discoverFromGitDiff(tmpProject);
      expect(files).toEqual([]);
    });

    it('source 为 gitdiff', () => {
      // 在实际 git 仓库中运行（d:\good\jws）
      const d = new ContextDiscoverer();
      const files = d.discoverFromGitDiff(process.cwd());
      // 如果有变更文件，验证 source
      for (const f of files) {
        expect(f.source).toBe('gitdiff');
      }
    });

    it('缓存机制：10 秒内返回相同结果', () => {
      const d = new ContextDiscoverer();
      const files1 = d.discoverFromGitDiff(process.cwd());
      const files2 = d.discoverFromGitDiff(process.cwd());
      // 第二次从缓存返回，文件路径应相同
      expect(files1.length).toBe(files2.length);
      expect(files1.map(f => f.filePath)).toEqual(files2.map(f => f.filePath));
    });
  });

  describe('discover 综合发现', () => {
    it('无任何来源时返回空结果', async () => {
      const result = await discoverer.discover('test', null, { cwd: tmpProject, includeGitDiff: false });
      expect(result.files).toEqual([]);
      expect(result.totalEstimatedTokens).toBe(0);
      expect(result.truncated).toBe(false);
    });

    it('合并 query 和 openfile 来源', async () => {
      writeFile(tmpProject, 'src/utils.ts', 'export function foo() {}');
      writeFile(tmpProject, 'src/main.ts', `import { foo } from './utils';`);

      const mockIndexer = createMockIndexer([
        { filePath: 'src/api.ts', symbolName: 'bar', score: 0.8, reason: '匹配 bar' },
      ]);
      // 也需要创建 src/api.ts 以便 estimateTokens 工作
      writeFile(tmpProject, 'src/api.ts', 'export function bar() {}');

      const result = await discoverer.discover('bar', mockIndexer, {
        cwd: tmpProject,
        openFilePath: 'src/main.ts',
        includeGitDiff: false,
      });

      const paths = result.files.map(f => f.filePath);
      expect(paths).toContain('src/api.ts');
      expect(paths.some(p => p.includes('utils.ts'))).toBe(true);
    });

    it('bySource 正确统计', async () => {
      writeFile(tmpProject, 'src/utils.ts', 'export function foo() {}');
      writeFile(tmpProject, 'src/main.ts', `import { foo } from './utils';`);

      const mockIndexer = createMockIndexer([
        { filePath: 'src/api.ts', symbolName: 'bar', score: 0.8, reason: '匹配' },
      ]);
      writeFile(tmpProject, 'src/api.ts', 'export function bar() {}');

      const result = await discoverer.discover('bar', mockIndexer, {
        cwd: tmpProject,
        openFilePath: 'src/main.ts',
        includeGitDiff: false,
      });

      expect(result.bySource.query).toBeGreaterThanOrEqual(1);
      expect(result.bySource.openfile).toBeGreaterThanOrEqual(1);
    });

    it('token 预算裁剪', async () => {
      // 创建多个大文件
      for (let i = 0; i < 10; i++) {
        writeFile(tmpProject, `src/file${i}.ts`, 'x'.repeat(1000));
      }

      const mockIndexer = createMockIndexer(
        Array.from({ length: 10 }, (_, i) => ({
          filePath: `src/file${i}.ts`,
          symbolName: `func${i}`,
          score: 0.9 - i * 0.05,
          reason: `匹配 func${i}`,
        })),
      );

      // 设置极小的 token 预算
      const result = await discoverer.discover('test', mockIndexer, {
        cwd: tmpProject,
        includeGitDiff: false,
        tokenBudget: 500, // 很小
      });

      expect(result.truncated).toBe(true);
      expect(result.totalEstimatedTokens).toBeLessThanOrEqual(500 + 250); // +250 容差（单个文件可能略超）
    });

    it('maxFiles 限制', async () => {
      const mockIndexer = createMockIndexer(
        Array.from({ length: 30 }, (_, i) => ({
          filePath: `src/file${i}.ts`,
          symbolName: `func${i}`,
          score: 0.9,
          reason: '匹配',
        })),
      );

      const result = await discoverer.discover('test', mockIndexer, {
        cwd: tmpProject,
        includeGitDiff: false,
        maxFiles: 5,
        tokenBudget: 100000, // 大预算
      });

      expect(result.files.length).toBeLessThanOrEqual(5);
      expect(result.truncated).toBe(true);
    });

    it('summary 包含文件信息', async () => {
      const mockIndexer = createMockIndexer([
        { filePath: 'src/api.ts', symbolName: 'foo', score: 0.9, reason: '匹配' },
      ]);
      writeFile(tmpProject, 'src/api.ts', 'export function foo() {}');

      const result = await discoverer.discover('foo', mockIndexer, {
        cwd: tmpProject,
        includeGitDiff: false,
      });

      expect(result.summary).toContain('动态上下文发现');
      expect(result.summary).toContain('src/api.ts');
    });

    it('summary 无文件时显示未发现', async () => {
      const result = await discoverer.discover('test', null, {
        cwd: tmpProject,
        includeGitDiff: false,
      });

      expect(result.summary).toContain('未发现');
    });

    it('openFilePath 不存在时正常执行', async () => {
      const result = await discoverer.discover('test', null, {
        cwd: tmpProject,
        openFilePath: 'nonexistent.ts',
        includeGitDiff: false,
      });

      expect(result.files).toEqual([]);
    });

    it('分数按降序排列', async () => {
      const mockIndexer = createMockIndexer([
        { filePath: 'src/low.ts', symbolName: 'low', score: 0.3, reason: '低匹配' },
        { filePath: 'src/high.ts', symbolName: 'high', score: 0.9, reason: '高匹配' },
        { filePath: 'src/mid.ts', symbolName: 'mid', score: 0.6, reason: '中匹配' },
      ]);
      writeFile(tmpProject, 'src/low.ts', 'export function low() {}');
      writeFile(tmpProject, 'src/high.ts', 'export function high() {}');
      writeFile(tmpProject, 'src/mid.ts', 'export function mid() {}');

      const result = await discoverer.discover('test', mockIndexer, {
        cwd: tmpProject,
        includeGitDiff: false,
      });

      expect(result.files.length).toBe(3);
      expect(result.files[0].filePath).toBe('src/high.ts');
      expect(result.files[1].filePath).toBe('src/mid.ts');
      expect(result.files[2].filePath).toBe('src/low.ts');
    });
  });

  describe('setCodebaseIndexer', () => {
    it('注入后 discover 自动使用', async () => {
      const mockIndexer = createMockIndexer([
        { filePath: 'src/injected.ts', symbolName: 'foo', score: 0.9, reason: '注入' },
      ]);
      writeFile(tmpProject, 'src/injected.ts', 'export function foo() {}');

      discoverer.setCodebaseIndexer(mockIndexer);
      const result = await discoverer.discover('foo', undefined, {
        cwd: tmpProject,
        includeGitDiff: false,
      });

      expect(result.files.some(f => f.filePath === 'src/injected.ts')).toBe(true);
    });

    it('显式参数覆盖注入的 indexer', async () => {
      const mock1 = createMockIndexer([
        { filePath: 'src/first.ts', symbolName: 'foo', score: 0.9, reason: 'first' },
      ]);
      const mock2 = createMockIndexer([
        { filePath: 'src/second.ts', symbolName: 'bar', score: 0.9, reason: 'second' },
      ]);
      writeFile(tmpProject, 'src/first.ts', 'export function foo() {}');
      writeFile(tmpProject, 'src/second.ts', 'export function bar() {}');

      discoverer.setCodebaseIndexer(mock1);
      // 显式传入 mock2 应覆盖 mock1
      const result = await discoverer.discover('bar', mock2, {
        cwd: tmpProject,
        includeGitDiff: false,
      });

      expect(result.files.some(f => f.filePath === 'src/second.ts')).toBe(true);
      expect(result.files.some(f => f.filePath === 'src/first.ts')).toBe(false);
    });
  });

  describe('invalidateCache', () => {
    it('清除 git diff 缓存', () => {
      const d = new ContextDiscoverer();
      d.discoverFromGitDiff(process.cwd()); // 填充缓存
      d.invalidateCache();
      // 缓存清除后再次调用应重新获取
      const files = d.discoverFromGitDiff(process.cwd());
      expect(Array.isArray(files)).toBe(true);
    });
  });

  describe('getToolDefinitions', () => {
    it('返回 1 个工具', () => {
      const tools = discoverer.getToolDefinitions();
      expect(tools.length).toBe(1);
      expect(tools[0].name).toBe('context_discover');
    });

    it('readOnly 为 true', () => {
      const tools = discoverer.getToolDefinitions();
      expect(tools[0].readOnly).toBe(true);
    });

    it('参数定义完整', () => {
      const tools = discoverer.getToolDefinitions();
      const tool = tools[0];
      expect(tool.parameters.query).toBeDefined();
      expect(tool.parameters.query.required).toBe(true);
      expect(tool.parameters.openFile).toBeDefined();
      expect(tool.parameters.openFile.required).toBe(false);
      expect(tool.parameters.tokenBudget).toBeDefined();
      expect(tool.parameters.tokenBudget.required).toBe(false);
    });

    it('缺少 query 参数返回错误', async () => {
      const tools = discoverer.getToolDefinitions();
      const result = await tools[0].execute({});
      expect(result as string).toContain('缺少 query 参数');
    });

    it('正常执行返回发现结果', async () => {
      writeFile(tmpProject, 'src/api.ts', 'export function foo() {}');
      const mockIndexer = createMockIndexer([
        { filePath: 'src/api.ts', symbolName: 'foo', score: 0.9, reason: '匹配' },
      ]);
      discoverer.setCodebaseIndexer(mockIndexer);

      const tools = discoverer.getToolDefinitions();
      const result = await tools[0].execute({ query: 'foo' });
      expect(typeof result).toBe('string');
      expect(result as string).toContain('src/api.ts');
    });

    it('无结果时返回未发现', async () => {
      // 在非 git 仓库的临时目录中运行，避免 git diff 干扰
      const d = new ContextDiscoverer();
      const result = await d.discover('nonexistent', null, {
        cwd: tmpProject,
        includeGitDiff: false,
      });
      expect(result.summary).toContain('未发现');
    });
  });

  describe('单例', () => {
    it('getContextDiscoverer 返回同一实例', () => {
      const a = getContextDiscoverer();
      const b = getContextDiscoverer();
      expect(a).toBe(b);
    });

    it('单例是 ContextDiscoverer 实例', () => {
      const a = getContextDiscoverer();
      expect(a).toBeInstanceOf(ContextDiscoverer);
    });
  });

  describe('DiscoveredFile 类型', () => {
    it('字段完整', () => {
      const file: DiscoveredFile = {
        filePath: 'src/test.ts',
        score: 0.8,
        source: 'query',
        reason: '匹配',
        matchedSymbols: ['foo', 'bar'],
        estimatedTokens: 100,
      };
      expect(file.filePath).toBe('src/test.ts');
      expect(file.score).toBe(0.8);
      expect(file.source).toBe('query');
      expect(file.matchedSymbols).toHaveLength(2);
      expect(file.estimatedTokens).toBe(100);
    });
  });
});
