/**
 * v20.0 §3.1 CodebaseIndexer 测试
 *
 * 测试代码库语义索引功能：
 * - 全量索引构建
 * - 增量更新
 * - 语义搜索
 * - 引用查找
 * - 调用图
 * - 工具定义
 */
import { describe, it, expect, beforeAll } from 'vitest';
import * as path from 'path';
import { CodebaseIndexer } from '../codebase-indexer.js';

describe('v20.0 §3.1: CodebaseIndexer', () => {
  // 索引 src/core/ 目录（包含 CodebaseIndexer 及其依赖），避免索引整个项目导致超时
  const projectRoot = path.resolve(__dirname, '../..');
  let indexer: CodebaseIndexer;

  beforeAll(async () => {
    indexer = new CodebaseIndexer(projectRoot);
    await indexer.buildIndex();
  }, 120000); // 索引可能耗时，给予 2 分钟超时

  describe('buildIndex', () => {
    it('索引构建后 stats 非空', () => {
      const stats = indexer.getStats();
      expect(stats).not.toBeNull();
      expect(stats!.totalFiles).toBeGreaterThan(0);
      expect(stats!.totalSymbols).toBeGreaterThan(0);
      expect(stats!.indexDurationMs).toBeGreaterThanOrEqual(0);
    });

    it('索引包含 TypeScript 文件', () => {
      const stats = indexer.getStats();
      expect(stats!.byLanguage.typescript).toBeGreaterThan(0);
    });

    it('符号按类型分布有值', () => {
      const stats = indexer.getStats();
      expect(stats!.byKind.function).toBeGreaterThanOrEqual(0);
      expect(stats!.byKind.class).toBeGreaterThanOrEqual(0);
      expect(stats!.byKind.interface).toBeGreaterThanOrEqual(0);
      // 项目中肯定有函数
      const totalSymbols = Object.values(stats!.byKind).reduce((a, b) => a + b, 0);
      expect(totalSymbols).toBeGreaterThan(0);
    });
  });

  describe('searchSemantic', () => {
    it('搜索 "buildIndex" 返回 CodebaseIndexer 的方法', () => {
      const results = indexer.searchSemantic('buildIndex');
      expect(results.length).toBeGreaterThan(0);
      const top = results[0];
      expect(top.symbol.name).toBe('buildIndex');
      expect(top.score).toBeGreaterThan(0);
    });

    it('搜索 "CodebaseIndexer" 返回类定义', () => {
      const results = indexer.searchSemantic('CodebaseIndexer');
      expect(results.length).toBeGreaterThan(0);
      const classResult = results.find(r => r.symbol.kind === 'class' && r.symbol.name === 'CodebaseIndexer');
      expect(classResult).toBeDefined();
    });

    it('搜索不存在的符号返回空', () => {
      const results = indexer.searchSemantic('nonExistentFunction12345');
      expect(results.length).toBe(0);
    });

    it('搜索结果按分数降序排列', () => {
      const results = indexer.searchSemantic('index', 10);
      for (let i = 1; i < results.length; i++) {
        expect(results[i - 1].score).toBeGreaterThanOrEqual(results[i].score);
      }
    });

    it('limit 参数限制返回数量', () => {
      const results5 = indexer.searchSemantic('function', 5);
      const results10 = indexer.searchSemantic('function', 10);
      expect(results5.length).toBeLessThanOrEqual(5);
      expect(results10.length).toBeLessThanOrEqual(10);
    });
  });

  describe('findReferences', () => {
    it('查找 "CodebaseIndexer" 的定义引用', () => {
      const refs = indexer.findReferences('CodebaseIndexer');
      expect(refs.length).toBeGreaterThan(0);
      const defRef = refs.find(r => r.context.startsWith('definition:'));
      expect(defRef).toBeDefined();
    });

    it('查找不存在的符号返回空', () => {
      const refs = indexer.findReferences('nonExistentSymbol12345');
      expect(refs.length).toBe(0);
    });
  });

  describe('getCallGraph', () => {
    it('无参数返回所有函数节点', () => {
      const nodes = indexer.getCallGraph();
      expect(nodes.length).toBeGreaterThan(0);
      // 至少有一些函数
      expect(nodes.some(n => n.name.length > 0)).toBe(true);
    });

    it('指定函数名返回该函数的调用关系', () => {
      const nodes = indexer.getCallGraph('buildIndex');
      expect(nodes.length).toBeGreaterThan(0);
      expect(nodes[0].name).toBe('buildIndex');
    });

    it('不存在的函数返回空', () => {
      const nodes = indexer.getCallGraph('nonExistentFunction12345');
      expect(nodes.length).toBe(0);
    });
  });

  describe('getOverview', () => {
    it('返回包含统计信息的文本', () => {
      const overview = indexer.getOverview();
      expect(overview).toContain('代码库索引概览');
      expect(overview).toContain('文件数');
      expect(overview).toContain('符号数');
      expect(overview).toContain('按类型分布');
      expect(overview).toContain('按语言分布');
    });
  });

  describe('updateIncremental', () => {
    it('增量更新返回零变更（无文件变化时）', async () => {
      const result = await indexer.updateIncremental();
      expect(result.added).toBe(0);
      expect(result.updated).toBe(0);
      expect(result.removed).toBe(0);
    });
  });

  describe('getToolDefinitions', () => {
    it('返回 4 个工具定义', () => {
      const tools = indexer.getToolDefinitions();
      expect(tools.length).toBe(4);
      const names = tools.map(t => t.name);
      expect(names).toContain('codebase_search');
      expect(names).toContain('codebase_find_references');
      expect(names).toContain('codebase_call_graph');
      expect(names).toContain('codebase_overview');
    });

    it('每个工具都有 execute 函数', () => {
      const tools = indexer.getToolDefinitions();
      tools.forEach(t => {
        expect(typeof t.execute).toBe('function');
      });
    });

    it('codebase_search 工具可执行搜索', async () => {
      const tools = indexer.getToolDefinitions();
      const searchTool = tools.find(t => t.name === 'codebase_search');
      const result = await searchTool!.execute({ query: 'CodebaseIndexer' });
      expect(result).toContain('CodebaseIndexer');
    });

    it('codebase_overview 工具可执行概览', async () => {
      const tools = indexer.getToolDefinitions();
      const overviewTool = tools.find(t => t.name === 'codebase_overview');
      const result = await overviewTool!.execute({});
      expect(result).toContain('代码库索引概览');
    });

    it('codebase_find_references 工具可查找引用', async () => {
      const tools = indexer.getToolDefinitions();
      const refsTool = tools.find(t => t.name === 'codebase_find_references');
      const result = await refsTool!.execute({ symbol_name: 'CodebaseIndexer' });
      expect(result).toContain('CodebaseIndexer');
    });

    it('缺少参数时返回错误提示', async () => {
      const tools = indexer.getToolDefinitions();
      const searchTool = tools.find(t => t.name === 'codebase_search');
      const result = await searchTool!.execute({});
      expect(result).toContain('❌');
    });
  });
});
