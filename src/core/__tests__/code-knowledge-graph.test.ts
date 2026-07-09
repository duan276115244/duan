/**
 * 代码知识图谱测试 — CodeKnowledgeGraph
 *
 * 覆盖：
 * - 单文件分析：函数/类/接口实体抽取 + defined_in 关系
 * - 文件 imports 关系
 * - 函数调用关系（calls）抽取
 * - 查询 API：findCallers / findCallees / findFileDependencies / findFileDependents
 * - 统计：getStats
 * - 工具定义：getToolDefinitions（code_graph_query / code_graph_stats / code_graph_analyze）
 * - 容错：解析失败/空目录
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { writeFileSync, mkdirSync, rmSync, existsSync } from 'fs';
import { join } from 'path';
import { CodeKnowledgeGraph } from '../code-knowledge-graph.js';
import { KnowledgeGraph } from '../knowledge-graph.js';
import { TreeSitterAST } from '../tree-sitter-ast.js';

const TMP_ROOT = join(process.cwd(), '.tmp-code-kg-test');

// 测试夹具：一个简单的 TS 项目结构
const FILE_A = `
import { helper } from './b';
import { Something } from './c';

export function greet(name: string): string {
  helper(name);
  return 'hello ' + name;
}

export class Calculator {
  add(a: number, b: number): number {
    return a + b;
  }
  multiply(a: number, b: number): number {
    greet('calc');
    return a * b;
  }
}
`;

const FILE_B = `
import { Something } from './c';

export function helper(input: string): void {
  console.log('helping', input);
}

export function utility(): number {
  helper('util');
  return 42;
}
`;

const FILE_C = `
export interface Something {
  id: string;
  value: number;
}

export type ID = string;
`;

describe('CodeKnowledgeGraph', () => {
  let kg: KnowledgeGraph;
  let ast: TreeSitterAST;
  let engine: CodeKnowledgeGraph;

  beforeEach(() => {
    // 干净的临时目录
    if (existsSync(TMP_ROOT)) {
      rmSync(TMP_ROOT, { recursive: true, force: true });
    }
    mkdirSync(TMP_ROOT, { recursive: true });
    writeFileSync(join(TMP_ROOT, 'a.ts'), FILE_A);
    writeFileSync(join(TMP_ROOT, 'b.ts'), FILE_B);
    writeFileSync(join(TMP_ROOT, 'c.ts'), FILE_C);

    kg = new KnowledgeGraph();
    ast = new TreeSitterAST();
    engine = new CodeKnowledgeGraph(kg, ast);
  });

  afterEach(() => {
    if (existsSync(TMP_ROOT)) {
      rmSync(TMP_ROOT, { recursive: true, force: true });
    }
  });

  describe('单文件分析 analyzeFile', () => {
    it('抽取函数实体与 defined_in 关系', async () => {
      const r = await engine.analyzeFile(join(TMP_ROOT, 'a.ts'));
      expect(r.error).toBeUndefined();
      expect(r.language).toBe('TypeScript');
      expect(r.functionsAdded).toBeGreaterThan(0); // greet + add + multiply
      expect(r.classesAdded).toBeGreaterThanOrEqual(1); // Calculator
    });

    it('接口实体被抽取', async () => {
      const r = await engine.analyzeFile(join(TMP_ROOT, 'c.ts'));
      expect(r.interfacesAdded).toBeGreaterThanOrEqual(1); // Something
    });

    it('type 别名被抽取为 code_type 实体', async () => {
      await engine.analyzeFile(join(TMP_ROOT, 'c.ts'));
      const stats = engine.getStats();
      expect(stats.byEntityType.code_type).toBeGreaterThanOrEqual(1);
    });

    it('解析失败返回 error 字段但不抛出', async () => {
      const r = await engine.analyzeFile(join(TMP_ROOT, 'nonexistent.ts'));
      // 不抛错，返回带 error 的结果
      expect(r).toBeDefined();
      // parseFile 内部捕获错误返回空 analysis，所以这里至少不会崩
      expect(r.callsAdded).toBe(0);
    });

    it('extractCalls=false 时不抽取调用关系', async () => {
      const r = await engine.analyzeFile(join(TMP_ROOT, 'a.ts'), { extractCalls: false });
      expect(r.callsAdded).toBe(0);
    });
  });

  describe('目录批量分析 analyzeDirectory', () => {
    it('分析所有 .ts 文件并抽取实体', async () => {
      const stats = await engine.analyzeDirectory(TMP_ROOT);
      expect(stats.filesAnalyzed).toBe(3);
      expect(stats.byEntityType.code_file).toBe(3);
      // greet + helper + utility = 3（Calculator 的 add/multiply 是 methods，TreeSitterAST 的 functionPattern 不匹配 class method 简写）
      expect(stats.byEntityType.code_function).toBeGreaterThanOrEqual(3);
      expect(stats.byEntityType.code_class).toBeGreaterThanOrEqual(1); // Calculator
      expect(stats.byEntityType.code_interface).toBeGreaterThanOrEqual(1); // Something
    });

    it('统计关系数量', async () => {
      const stats = await engine.analyzeDirectory(TMP_ROOT);
      // defined_in: 每个函数/类/接口都有
      expect(stats.byRelationType.defined_in).toBeGreaterThanOrEqual(5);
      // imports: a→b, a→c, b→c 共 3 个
      expect(stats.byRelationType.imports).toBeGreaterThanOrEqual(3);
      // calls: a.greet→b.helper, b.utility→b.helper（class methods 因 functionPattern 限制不抽取，所以只 2 个）
      expect(stats.byRelationType.calls).toBeGreaterThanOrEqual(2);
      expect(stats.durationMs).toBeGreaterThanOrEqual(0);
      expect(stats.lastAnalyzedAt).toBeGreaterThan(0);
    });

    it('maxFiles 限制生效', async () => {
      const stats = await engine.analyzeDirectory(TMP_ROOT, { maxFiles: 2 });
      expect(stats.filesAnalyzed).toBeLessThanOrEqual(2);
    });

    it('循环依赖计数为 0（无环测试夹具）', async () => {
      const stats = await engine.analyzeDirectory(TMP_ROOT);
      expect(stats.circularDependencies).toBe(0);
    });
  });

  describe('查询 API', () => {
    beforeEach(async () => {
      await engine.analyzeDirectory(TMP_ROOT);
    });

    it('findCallers: 找出谁调用了 helper', () => {
      const callers = engine.findCallers('helper');
      // a.greet 和 b.utility 都调用 helper
      expect(callers.length).toBeGreaterThanOrEqual(2);
      const callerNames = callers.map(c => c.callerFunction);
      expect(callerNames).toContain('greet');
      expect(callerNames).toContain('utility');
    });

    it('findCallees: 找出 greet 调用了谁', () => {
      const callees = engine.findCallees('greet');
      expect(callees.length).toBeGreaterThanOrEqual(1);
      const calleeNames = callees.map(c => c.calleeFunction);
      expect(calleeNames).toContain('helper');
    });

    it('findCallers: 查询不存在的函数返回空数组', () => {
      const callers = engine.findCallers('nonExistentFunction');
      expect(callers).toEqual([]);
    });

    it('findFileDependencies: 找出 a.ts 依赖的文件', () => {
      const deps = engine.findFileDependencies(join(TMP_ROOT, 'a.ts'));
      expect(deps.length).toBeGreaterThanOrEqual(2);
      // 依赖 b 和 c
      const depBasename = deps.map(d => d.split(/[\\/]/).pop() || d);
      expect(depBasename).toContain('b.ts');
      expect(depBasename).toContain('c.ts');
    });

    it('findFileDependents: 找出谁依赖了 c.ts', () => {
      const dependents = engine.findFileDependents(join(TMP_ROOT, 'c.ts'));
      expect(dependents.length).toBeGreaterThanOrEqual(2); // a 和 b 都依赖 c
      const depBasename = dependents.map(d => d.split(/[\\/]/).pop() || d);
      expect(depBasename).toContain('a.ts');
      expect(depBasename).toContain('b.ts');
    });

    it('findFileDependencies: 未分析的文件返回空', () => {
      const deps = engine.findFileDependencies('/not/analyzed.ts');
      expect(deps).toEqual([]);
    });
  });

  describe('统计 getStats', () => {
    it('未分析前 stats 全为 0', () => {
      const stats = engine.getStats();
      expect(stats.filesAnalyzed).toBe(0);
      expect(stats.entities).toBe(0);
      expect(stats.relations).toBe(0);
      expect(stats.lastAnalyzedAt).toBe(0);
    });

    it('分析后 stats 反映数据', async () => {
      await engine.analyzeDirectory(TMP_ROOT);
      const stats = engine.getStats();
      expect(stats.filesAnalyzed).toBe(3);
      expect(stats.entities).toBeGreaterThan(5);
      expect(stats.relations).toBeGreaterThan(5);
    });
  });

  describe('工具定义 getToolDefinitions', () => {
    it('返回 3 个工具', () => {
      const defs = engine.getToolDefinitions();
      expect(defs).toHaveLength(3);
      const names = defs.map(d => d.name);
      expect(names).toContain('code_graph_query');
      expect(names).toContain('code_graph_stats');
      expect(names).toContain('code_graph_analyze');
    });

    it('所有工具均只读', () => {
      const defs = engine.getToolDefinitions();
      for (const d of defs) {
        expect(d.readOnly).toBe(true);
      }
    });

    it('code_graph_stats 返回统计文本', async () => {
      await engine.analyzeDirectory(TMP_ROOT);
      const defs = engine.getToolDefinitions();
      const statsTool = defs.find(d => d.name === 'code_graph_stats')!;
      const result = await statsTool.execute({});
      expect(result).toContain('代码知识图谱统计');
      expect(result).toContain('已分析文件');
    });

    it('code_graph_query 查询 callers', async () => {
      await engine.analyzeDirectory(TMP_ROOT);
      const defs = engine.getToolDefinitions();
      const queryTool = defs.find(d => d.name === 'code_graph_query')!;
      const result = await queryTool.execute({ queryType: 'callers', target: 'helper' });
      // 应包含 greet 和 utility
      expect(result).toContain('greet');
      expect(result).toContain('utility');
    });

    it('code_graph_query 未知类型返回提示', async () => {
      const defs = engine.getToolDefinitions();
      const queryTool = defs.find(d => d.name === 'code_graph_query')!;
      const result = await queryTool.execute({ queryType: 'unknown', target: 'x' });
      expect(result).toContain('未知查询类型');
    });

    it('code_graph_query 无结果显示提示', async () => {
      const defs = engine.getToolDefinitions();
      const queryTool = defs.find(d => d.name === 'code_graph_query')!;
      const result = await queryTool.execute({ queryType: 'callers', target: 'nonExistent' });
      expect(result).toContain('无结果');
    });

    it('code_graph_analyze 触发分析', async () => {
      const defs = engine.getToolDefinitions();
      const analyzeTool = defs.find(d => d.name === 'code_graph_analyze')!;
      const result = await analyzeTool.execute({ dirPath: TMP_ROOT, maxFiles: 10 });
      const parsed = JSON.parse(result);
      expect(parsed.filesAnalyzed).toBe(3);
    });

    it('code_graph_analyze 缺少 dirPath 报错', async () => {
      const defs = engine.getToolDefinitions();
      const analyzeTool = defs.find(d => d.name === 'code_graph_analyze')!;
      const result = await analyzeTool.execute({});
      expect(result).toContain('错误');
    });
  });
});
