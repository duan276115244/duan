/**
 * 代码知识图谱 — CodeKnowledgeGraph
 *
 * 文档三·代码智慧的落地实现。基于 TreeSitterAST 解析项目源码，
 * 将函数/类/接口/文件 + 调用/导入/继承关系抽取为知识图谱实体与关系，
 * sink 进通用 KnowledgeGraph，使 LLM 可通过工具查询代码结构。
 *
 * 价值：
 * 1. "X 函数被谁调用" — 影响分析，重构前必查
 * 2. "Y 模块依赖哪些模块" — 依赖审查，循环依赖预警
 * 3. "Z 类继承了哪些接口" — 接口契约审查
 * 4. "项目里最复杂的 10 个函数" — 重构热点定位
 *
 * 设计原则：
 * - 增量友好：单文件粒度 analyzeFile，整体项目 analyzeDirectory 可控
 * - 容错：单文件解析失败不阻塞整体扫描
 * - 静态优先：基于正则与 AST 节点，不依赖运行时插桩
 * - 与 KnowledgeGraph 解耦：通过 addEntity/addRelation sink，不直接持私有状态
 */

import { logger } from './structured-logger.js';
import { EventBus } from './event-bus.js';
import { KnowledgeGraph } from './knowledge-graph.js';
import { TreeSitterAST, type ASTAnalysis, type ASTNode } from './tree-sitter-ast.js';

// ============ 类型定义 ============

export type CodeEntityType = 'code_file' | 'code_function' | 'code_class' | 'code_interface' | 'code_type';

export type CodeRelationType =
  | 'defined_in'    // function/class/interface → file
  | 'calls'         // function → function
  | 'imports'       // file → file
  | 'extends'       // class → class
  | 'implements';   // class → interface

export interface CodeGraphStats {
  filesAnalyzed: number;
  entities: number;
  relations: number;
  byEntityType: Record<CodeEntityType, number>;
  byRelationType: Record<CodeRelationType, number>;
  circularDependencies: number;
  lastAnalyzedAt: number;
  durationMs: number;
}

export interface AnalyzeOptions {
  /** 最大文件数限制（防止大项目超时），默认 500 */
  maxFiles?: number;
  /** 是否抽取函数调用关系（耗时操作），默认 true */
  extractCalls?: boolean;
  /** 忽略目录名（默认含 node_modules/.git/dist/build/.next/coverage） */
  ignoreDirs?: string[];
  /** 忽略文件扩展名以外的（自动按语言配置过滤） */
}

export interface FileAnalysisResult {
  filePath: string;
  language: string;
  functionsAdded: number;
  classesAdded: number;
  interfacesAdded: number;
  callsAdded: number;
  importsAdded: number;
  error?: string;
}

// ============ 默认忽略目录 ============

const DEFAULT_IGNORE_DIRS = new Set([
  'node_modules', '.git', 'dist', 'build', '.next', 'coverage',
  '.cache', '.turbo', 'out', '.vscode', '.idea',
]);

/** 函数调用提取正则：identifier( 形式 */
const CALL_PATTERN = /\b([A-Za-z_$][A-Za-z0-9_$]*)\s*\(/g;
/** 排除关键字（控制流/语言关键字不算调用） */
const CALL_EXCLUDE = new Set([
  'if', 'for', 'while', 'switch', 'catch', 'return', 'typeof',
  'new', 'delete', 'void', 'function', 'class', 'interface', 'enum',
  'import', 'export', 'from', 'require', 'console', // console 是宿主，不算业务调用
]);

// ============ 主类 ============

export class CodeKnowledgeGraph {
  private log = logger.child({ module: 'CodeKnowledgeGraph' });

  private filesAnalyzed = 0;
  private byEntityType: Record<CodeEntityType, number> = {
    code_file: 0, code_function: 0, code_class: 0, code_interface: 0, code_type: 0,
  };
  private byRelationType: Record<CodeRelationType, number> = {
    defined_in: 0, calls: 0, imports: 0, extends: 0, implements: 0,
  };
  private lastAnalyzedAt = 0;
  private lastDurationMs = 0;

  // 已分析文件集合，防止重复分析
  private analyzedFiles: Set<string> = new Set();
  // 文件路径 → 文件实体 ID 映射（用于 imports 关系）
  private filePathToEntityId: Map<string, string> = new Map();
  // 函数名 → 实体 ID 列表（用于 calls 关系查找）
  private functionNameToEntityIds: Map<string, string[]> = new Map();
  // 实体 ID → 实体快照（避免依赖 KnowledgeGraph 未公开的 by-id 查询）
  private entityCache: Map<string, { name: string; properties: Record<string, string> }> = new Map();

  constructor(
    private readonly kg: KnowledgeGraph,
    private readonly ast: TreeSitterAST,
  ) {
    this.log.info('代码知识图谱引擎初始化完成');
  }

  // ========== 单文件分析 ==========

  /**
   * 分析单个文件 — 抽取实体与关系，sink 进 KnowledgeGraph
   */
  async analyzeFile(filePath: string, options: { extractCalls?: boolean } = {}): Promise<FileAnalysisResult> {
    const extractCalls = options.extractCalls !== false;
    const startTime = Date.now();

    const result: FileAnalysisResult = {
      filePath,
      language: 'unknown',
      functionsAdded: 0,
      classesAdded: 0,
      interfacesAdded: 0,
      callsAdded: 0,
      importsAdded: 0,
    };

    try {
      const analysis = await this.ast.parseFile(filePath);
      result.language = analysis.language;

      // 1. 创建文件实体
      const fileId = this.makeFileEntityId(filePath);
      const fileProps = {
        path: filePath,
        language: analysis.language,
        totalLines: String(analysis.metrics.totalLines),
        codeLines: String(analysis.metrics.codeLines),
        functions: String(analysis.metrics.functions),
        classes: String(analysis.metrics.classes),
        cyclomaticComplexity: String(analysis.metrics.cyclomaticComplexity),
      };
      this.kg.addEntity(fileId, this.basename(filePath), 'code_file', fileProps, 1.0, 'code-knowledge-graph');
      this.entityCache.set(fileId, { name: this.basename(filePath), properties: fileProps });
      this.byEntityType.code_file++;
      this.filePathToEntityId.set(filePath, fileId);
      this.filePathToEntityId.set(this.normalizePath(filePath), fileId);

      // 2. 抽取函数/类/接口实体 + defined_in 关系
      // 递归遍历所有节点（含 class 内的 method children）
      const visitNode = (node: ASTNode): void => {
        if (node.type === 'function' || node.type === 'method') {
          const fnId = this.makeFunctionEntityId(filePath, node.name, node.startLine);
          const fnProps = {
            file: filePath,
            startLine: String(node.startLine),
            endLine: String(node.endLine),
            modifiers: (node.modifiers || []).join(','),
          };
          this.kg.addEntity(fnId, node.name, 'code_function', fnProps, 0.9, 'code-knowledge-graph');
          this.entityCache.set(fnId, { name: node.name, properties: fnProps });
          this.byEntityType.code_function++;
          this.kg.addRelation(fnId, fileId, 'defined_in', { line: String(node.startLine) }, 1.0, 1.0);
          this.byRelationType.defined_in++;
          this.recordFunctionName(node.name, fnId);
          result.functionsAdded++;
        } else if (node.type === 'class') {
          const clsId = this.makeClassEntityId(filePath, node.name, node.startLine);
          const clsProps = {
            file: filePath,
            startLine: String(node.startLine),
            endLine: String(node.endLine),
            modifiers: (node.modifiers || []).join(','),
          };
          this.kg.addEntity(clsId, node.name, 'code_class', clsProps, 0.9, 'code-knowledge-graph');
          this.entityCache.set(clsId, { name: node.name, properties: clsProps });
          this.byEntityType.code_class++;
          this.kg.addRelation(clsId, fileId, 'defined_in', { line: String(node.startLine) }, 1.0, 1.0);
          this.byRelationType.defined_in++;
          result.classesAdded++;
        } else if (node.type === 'interface') {
          const ifaceId = this.makeInterfaceEntityId(filePath, node.name, node.startLine);
          const ifaceProps = {
            file: filePath,
            startLine: String(node.startLine),
          };
          this.kg.addEntity(ifaceId, node.name, 'code_interface', ifaceProps, 0.9, 'code-knowledge-graph');
          this.entityCache.set(ifaceId, { name: node.name, properties: ifaceProps });
          this.byEntityType.code_interface++;
          this.kg.addRelation(ifaceId, fileId, 'defined_in', { line: String(node.startLine) }, 1.0, 1.0);
          this.byRelationType.defined_in++;
          result.interfacesAdded++;
        } else if (node.type === 'type' || node.type === 'type_alias') {
          // type 别名也建实体（不计入 defined_in 关系，避免噪音）
          // 注意：TreeSitterAST 的 extractTypes 返回节点 type 字段为 'type_alias'
          const typeId = this.makeTypeEntityId(filePath, node.name, node.startLine);
          const typeProps = {
            file: filePath,
            startLine: String(node.startLine),
          };
          this.kg.addEntity(typeId, node.name, 'code_type', typeProps, 0.85, 'code-knowledge-graph');
          this.entityCache.set(typeId, { name: node.name, properties: typeProps });
          this.byEntityType.code_type++;
        }
        // 递归处理 children（class 内的 methods）
        if (node.children && node.children.length > 0) {
          for (const child of node.children) {
            visitNode(child);
          }
        }
      };
      for (const node of analysis.nodes) {
        visitNode(node);
      }

      // 3. imports 关系由 analyzeDirectory 专门负责（需要所有文件已建实体）
      //    单文件分析时跳过（无法解析跨文件目标）

      // 4. 抽取函数调用关系（可选，耗时）
      if (extractCalls) {
        const callsAdded = this.extractCallRelations(filePath, analysis.nodes);
        result.callsAdded = callsAdded;
        // 注意：byRelationType.calls 在 extractCallRelations 内部已更新
      }

      this.filesAnalyzed++;
      this.analyzedFiles.add(this.normalizePath(filePath));

      EventBus.getInstance().emitSync('code.graph.file.analyzed', {
        filePath,
        language: analysis.language,
        functions: result.functionsAdded,
        classes: result.classesAdded,
        durationMs: Date.now() - startTime,
      }, { source: 'CodeKnowledgeGraph' });

      return result;
    } catch (err: unknown) {
      result.error = err instanceof Error ? err.message : String(err);
      this.log.warn('文件分析失败', { filePath, error: result.error });
      return result;
    }
  }

  // ========== 目录批量分析 ==========

  /**
   * 递归分析目录下所有支持语言的源文件
   */
  async analyzeDirectory(dirPath: string, options: AnalyzeOptions = {}): Promise<CodeGraphStats> {
    const startTime = Date.now();
    const maxFiles = options.maxFiles ?? 500;
    const ignoreDirs = new Set([
      ...DEFAULT_IGNORE_DIRS,
      ...(options.ignoreDirs || []),
    ]);
    const extractCalls = options.extractCalls !== false;

    // 收集文件
    const files: string[] = [];
    this.collectSourceFiles(dirPath, ignoreDirs, files, maxFiles);

    this.log.info('开始批量分析目录', {
      dir: dirPath,
      fileCount: files.length,
      maxFiles,
      extractCalls,
    });

    let totalFunctions = 0;
    let totalClasses = 0;
    let totalInterfaces = 0;
    let totalCalls = 0;
    let totalImports = 0;
    let failedFiles = 0;

    // 第一遍：建立文件实体 + 函数/类/接口实体 + defined_in 关系
    // （不抽 calls，因为 calls 需要已知所有函数名）
    for (const file of files) {
      const r = await this.analyzeFile(file, { extractCalls: false });
      totalFunctions += r.functionsAdded;
      totalClasses += r.classesAdded;
      totalInterfaces += r.interfacesAdded;
      if (r.error) failedFiles++;
    }

    // 第二遍：抽取 imports 关系（此时所有文件实体已建，可解析跨文件目标）
    for (const file of files) {
      try {
        const analysis = await this.ast.parseFile(file);
        const added = this.rebuildImportsForFile(file, analysis.imports);
        totalImports += added;
      } catch {
        // 静默失败 — 第一遍已记录
      }
    }

    // 第三遍：抽取调用关系（此时 functionNameToEntityIds 已完整）
    if (extractCalls) {
      for (const file of files) {
        try {
          const analysis = await this.ast.parseFile(file);
          totalCalls += this.extractCallRelations(file, analysis.nodes);
        } catch (err: unknown) {
          // 静默失败 — 第一遍已记录
        }
      }
    }

    this.lastAnalyzedAt = Date.now();
    this.lastDurationMs = this.lastAnalyzedAt - startTime;

    // 检测循环依赖（委托 TreeSitterAST 的 analyzeProject）
    let circularDeps = 0;
    try {
      const projectAnalysis = await this.ast.analyzeProject(dirPath);
      circularDeps = projectAnalysis.circularDependencies.length;
      if (circularDeps > 0) {
        this.log.warn('检测到循环依赖', {
          count: circularDeps,
          samples: projectAnalysis.circularDependencies.slice(0, 3),
        });
      }
    } catch (err: unknown) {
      this.log.debug('循环依赖检测跳过', { error: err instanceof Error ? err.message : String(err) });
    }

    const stats = this.getStats();
    stats.circularDependencies = circularDeps;
    stats.durationMs = this.lastDurationMs;

    this.log.info('目录批量分析完成', {
      dir: dirPath,
      files: this.filesAnalyzed,
      functions: totalFunctions,
      classes: totalClasses,
      interfaces: totalInterfaces,
      calls: totalCalls,
      imports: totalImports,
      circularDeps,
      failedFiles,
      durationMs: this.lastDurationMs,
    });

    return stats;
  }

  // ========== 查询 API ==========

  /**
   * 查询某函数的所有调用者（谁调用了 X）
   */
  findCallers(functionName: string): Array<{ callerFunction: string; callerFile: string; line?: number }> {
    const targetIds = this.functionNameToEntityIds.get(functionName) || [];
    if (targetIds.length === 0) return [];

    const callers: Array<{ callerFunction: string; callerFile: string; line?: number }> = [];
    for (const targetId of targetIds) {
      const relations = this.kg.getEntityRelations(targetId);
      for (const rel of relations) {
        if (rel.relationType === 'calls' && rel.targetId === targetId) {
          // rel.sourceId 是调用者函数实体 ID — 查回名称
          const sourceEntity = this.findEntityById(rel.sourceId);
          if (sourceEntity) {
            callers.push({
              callerFunction: sourceEntity.name,
              callerFile: sourceEntity.properties.file || '',
              line: rel.properties.line ? Number(rel.properties.line) : undefined,
            });
          }
        }
      }
    }
    return callers;
  }

  /**
   * 查询某函数调用的所有函数（X 调用了谁）
   */
  findCallees(functionName: string): Array<{ calleeFunction: string; calleeFile: string; line?: number }> {
    const sourceIds = this.functionNameToEntityIds.get(functionName) || [];
    if (sourceIds.length === 0) return [];

    const callees: Array<{ calleeFunction: string; calleeFile: string; line?: number }> = [];
    for (const sourceId of sourceIds) {
      const relations = this.kg.getEntityRelations(sourceId);
      for (const rel of relations) {
        if (rel.relationType === 'calls' && rel.sourceId === sourceId) {
          const targetEntity = this.findEntityById(rel.targetId);
          if (targetEntity) {
            callees.push({
              calleeFunction: targetEntity.name,
              calleeFile: targetEntity.properties.file || '',
              line: rel.properties.line ? Number(rel.properties.line) : undefined,
            });
          }
        }
      }
    }
    return callees;
  }

  /**
   * 查询某文件的所有导入（依赖了哪些文件）
   */
  findFileDependencies(filePath: string): string[] {
    const fileId = this.filePathToEntityId.get(this.normalizePath(filePath));
    if (!fileId) return [];
    const relations = this.kg.getEntityRelations(fileId);
    const deps: string[] = [];
    for (const rel of relations) {
      if (rel.relationType === 'imports' && rel.sourceId === fileId) {
        const targetEntity = this.findEntityById(rel.targetId);
        if (targetEntity) deps.push(targetEntity.properties.path || targetEntity.name);
      }
    }
    return deps;
  }

  /**
   * 查询某文件的所有反向依赖（谁依赖了它）
   */
  findFileDependents(filePath: string): string[] {
    const fileId = this.filePathToEntityId.get(this.normalizePath(filePath));
    if (!fileId) return [];
    const relations = this.kg.getEntityRelations(fileId);
    const dependents: string[] = [];
    for (const rel of relations) {
      if (rel.relationType === 'imports' && rel.targetId === fileId) {
        const sourceEntity = this.findEntityById(rel.sourceId);
        if (sourceEntity) dependents.push(sourceEntity.properties.path || sourceEntity.name);
      }
    }
    return dependents;
  }

  /**
   * 查询某类继承的父类
   */
  findParentClasses(className: string): string[] {
    const entity = this.kg.findEntityByName(className);
    if (!entity) return [];
    const relations = this.kg.getEntityRelations(entity.id);
    const parents: string[] = [];
    for (const rel of relations) {
      if (rel.relationType === 'extends' && rel.sourceId === entity.id) {
        const targetEntity = this.findEntityById(rel.targetId);
        if (targetEntity) parents.push(targetEntity.name);
      }
    }
    return parents;
  }

  // ========== 统计 ==========

  getStats(): CodeGraphStats {
    return {
      filesAnalyzed: this.filesAnalyzed,
      entities: Object.values(this.byEntityType).reduce((a, b) => a + b, 0),
      relations: Object.values(this.byRelationType).reduce((a, b) => a + b, 0),
      byEntityType: { ...this.byEntityType },
      byRelationType: { ...this.byRelationType },
      circularDependencies: 0,
      lastAnalyzedAt: this.lastAnalyzedAt,
      durationMs: this.lastDurationMs,
    };
  }

  // ========== Agent Loop 工具定义 ==========

  getToolDefinitions(): Array<{
    name: string;
    description: string;
    parameters: Record<string, { type: string; description: string; required?: boolean }>;
    readOnly?: boolean;
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    execute: (args: any) => Promise<string>;
  }> {
    // eslint-disable-next-line @typescript-eslint/no-this-alias
    const engine = this;
    return [
      {
        name: 'code_graph_query',
        description: '查询代码知识图谱：查找函数调用者/被调用者、文件依赖/被依赖、类继承关系。在重构、影响分析、依赖审查前调用。只读。',
        parameters: {
          queryType: {
            type: 'string',
            description: '查询类型: callers (谁调用了 X) | callees (X 调用了谁) | file_deps (X 依赖了哪些文件) | file_dependents (谁依赖了 X) | parent_classes (X 继承了哪些父类)',
            required: true,
          },
          target: {
            type: 'string',
            description: '查询目标：函数名（callers/callees/parent_classes）或文件路径（file_deps/file_dependents）',
            required: true,
          },
        },
        readOnly: true,
        execute: (args) => {
          const queryType = String(args.queryType || '');
          const target = String(args.target || '');
          let result: unknown;

          switch (queryType) {
            case 'callers':
              result = engine.findCallers(target);
              break;
            case 'callees':
              result = engine.findCallees(target);
              break;
            case 'file_deps':
              result = engine.findFileDependencies(target);
              break;
            case 'file_dependents':
              result = engine.findFileDependents(target);
              break;
            case 'parent_classes':
              result = engine.findParentClasses(target);
              break;
            default:
              return Promise.resolve(`未知查询类型: ${queryType}。支持: callers/callees/file_deps/file_dependents/parent_classes`);
          }

          const arr = result as Array<Record<string, unknown>>;
          if (Array.isArray(arr) && arr.length === 0) {
            return Promise.resolve(`查询 ${queryType}("${target}") 无结果。可能目标未在已分析的项目中，或先调用 code_graph_analyze 分析项目。`);
          }
          return Promise.resolve(JSON.stringify(result, null, 2));
        },
      },
      {
        name: 'code_graph_stats',
        description: '查看代码知识图谱统计：已分析文件数、实体数、关系数、循环依赖数。只读。',
        parameters: {},
        readOnly: true,
        execute: () => {
          const stats = engine.getStats();
          const lines = [
            `📊 代码知识图谱统计:`,
            `  已分析文件: ${stats.filesAnalyzed}`,
            `  实体总数: ${stats.entities}`,
            `    文件: ${stats.byEntityType.code_file} | 函数: ${stats.byEntityType.code_function} | 类: ${stats.byEntityType.code_class} | 接口: ${stats.byEntityType.code_interface} | 类型: ${stats.byEntityType.code_type}`,
            `  关系总数: ${stats.relations}`,
            `    defined_in: ${stats.byRelationType.defined_in} | calls: ${stats.byRelationType.calls} | imports: ${stats.byRelationType.imports} | extends: ${stats.byRelationType.extends} | implements: ${stats.byRelationType.implements}`,
            `  循环依赖: ${stats.circularDependencies}`,
            `  最近分析时间: ${stats.lastAnalyzedAt ? new Date(stats.lastAnalyzedAt).toISOString() : '未分析'}`,
            `  分析耗时: ${stats.durationMs}ms`,
          ];
          return Promise.resolve(lines.join('\n'));
        },
      },
      {
        name: 'code_graph_analyze',
        description: '触发代码知识图谱构建：分析指定目录下所有源文件，抽取函数/类/接口/调用/导入关系。耗时操作，大项目慎用（默认上限 500 文件）。',
        parameters: {
          dirPath: { type: 'string', description: '要分析的目录绝对路径', required: true },
          maxFiles: { type: 'number', description: '最大文件数（默认 500）', required: false },
        },
        readOnly: true, // 只读 KnowledgeGraph 的外部源码，不修改文件
        execute: async (args) => {
          const dirPath = String(args.dirPath || '');
          const maxFiles = typeof args.maxFiles === 'number' ? args.maxFiles : 500;
          if (!dirPath) return Promise.resolve('错误: 缺少 dirPath 参数');
          try {
            const stats = await engine.analyzeDirectory(dirPath, { maxFiles });
            return Promise.resolve(JSON.stringify(stats, null, 2));
          } catch (err: unknown) {
            return Promise.resolve(`分析失败: ${err instanceof Error ? err.message : String(err)}`);
          }
        },
      },
    ];
  }

  // ========== 私有辅助 ==========

  /** 递归收集支持语言的源文件 */
  private collectSourceFiles(
    dirPath: string,
    ignoreDirs: Set<string>,
    files: string[],
    maxFiles: number,
  ): void {
    if (files.length >= maxFiles) return;
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const fs = require('fs');
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const path = require('path');

    let entries: string[];
    try {
      entries = fs.readdirSync(dirPath);
    } catch {
      return;
    }

    for (const entry of entries) {
      if (files.length >= maxFiles) return;
      const full = path.join(dirPath, entry);
      let stat;
      try {
        stat = fs.statSync(full);
      } catch {
        continue;
      }
      if (stat.isDirectory()) {
        if (ignoreDirs.has(entry)) continue;
        this.collectSourceFiles(full, ignoreDirs, files, maxFiles);
      } else if (stat.isFile()) {
        // 仅收 .ts/.tsx/.js/.jsx/.mjs/.cjs/.py/.go/.rs/.java/.c/.cpp/.h 等支持语言
        const ext = path.extname(entry).toLowerCase();
        if (SUPPORTED_EXTS.has(ext)) {
          files.push(full);
        }
      }
    }
  }

  /** 重建单文件的 imports 关系（在所有文件实体已建后调用）
   *  注意：直接从 raw content 抽 imports，绕过 TreeSitterAST 的 cleanContent
   *  （stripCommentsAndStrings 会把字符串 './b' 替换成空格导致 imports 丢失）
   */
  private rebuildImportsForFile(filePath: string, _imports: string[]): number {
    const fileId = this.filePathToEntityId.get(this.normalizePath(filePath));
    if (!fileId) return 0;

    // 自己读 raw content 抽 import sources（TS/JS/Python/Go/Java）
    const importSources = this.extractImportSourcesFromRaw(filePath);

    let added = 0;
    for (const impStr of importSources) {
      const resolvedTarget = this.resolveImportTarget(filePath, impStr);
      if (!resolvedTarget) continue;
      const targetFileId = this.filePathToEntityId.get(this.normalizePath(resolvedTarget));
      if (targetFileId && targetFileId !== fileId) {
        this.kg.addRelation(fileId, targetFileId, 'imports', {
          source: impStr,
        }, 0.9, 0.7);
        this.byRelationType.imports++;
        added++;
      }
    }
    return added;
  }

  /** 从文件原始内容抽取 import sources（绕过 TreeSitterAST 的 cleanContent） */
  private extractImportSourcesFromRaw(filePath: string): string[] {
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const fs = require('fs');
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const path = require('path');
    let content: string;
    try {
      content = fs.readFileSync(filePath, 'utf-8');
    } catch {
      return [];
    }

    const ext = path.extname(filePath).toLowerCase();
    const sources: string[] = [];

    if (ext === '.ts' || ext === '.tsx' || ext === '.js' || ext === '.jsx' || ext === '.mjs' || ext === '.cjs') {
      // TS/JS: import { A } from 'src' / import X from 'src' / import 'src'
      const pattern = /import\s+(?:type\s+)?(?:(?:\{[^}]*\})|(?:[\w]+\s*,\s*\{[^}]*\})|[\w*]+)?\s*from\s+['"]([^'"]+)['"]/g;
      let match: RegExpExecArray | null;
      while ((match = pattern.exec(content)) !== null) {
        if (match[1]) sources.push(match[1]);
      }
      // 副作用导入 import 'src'
      const sideEffectPattern = /import\s+['"]([^'"]+)['"]/g;
      while ((match = sideEffectPattern.exec(content)) !== null) {
        if (match[1]) sources.push(match[1]);
      }
    } else if (ext === '.py') {
      // Python: from X import Y / import X
      const pattern = /from\s+([\w.]+)\s+import/g;
      let match: RegExpExecArray | null;
      while ((match = pattern.exec(content)) !== null) {
        if (match[1]) sources.push(match[1]);
      }
      const importPattern = /import\s+([\w.]+)/g;
      while ((match = importPattern.exec(content)) !== null) {
        if (match[1]) sources.push(match[1]);
      }
    } else if (ext === '.go') {
      // Go: import "X" / import (multi)
      const pattern = /import\s+["']([^"']+)["']/g;
      let match: RegExpExecArray | null;
      while ((match = pattern.exec(content)) !== null) {
        if (match[1]) sources.push(match[1]);
      }
    } else if (ext === '.java' || ext === '.rs') {
      // Java/Rust: import X.Y.Z / use X::Y
      const pattern = /import\s+([\w.]+);/g;
      let match: RegExpExecArray | null;
      while ((match = pattern.exec(content)) !== null) {
        if (match[1]) sources.push(match[1]);
      }
    }

    return Array.from(new Set(sources));
  }

  /** 从 AST 节点抽取函数调用关系 */
  private extractCallRelations(filePath: string, nodes: ASTNode[]): number {
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const fs = require('fs');
    let content: string;
    try {
      content = fs.readFileSync(filePath, 'utf-8');
    } catch {
      return 0;
    }

    // 仅对函数节点抽 calls — 用函数名索引判断 callee 是否是项目内的函数
    let callsAdded = 0;
    const fileId = this.filePathToEntityId.get(this.normalizePath(filePath));
    if (!fileId) return 0;

    for (const node of nodes) {
      if (node.type !== 'function' && node.type !== 'method') continue;

      // 提取函数体
      const lines = content.split('\n');
      const fnBody = lines.slice(node.startLine - 1, node.endLine).join('\n');
      if (!fnBody) continue;

      const callerId = this.makeFunctionEntityId(filePath, node.name, node.startLine);

      // 全局匹配 identifier( 形式
      let match: RegExpExecArray | null;
      CALL_PATTERN.lastIndex = 0;
      const seen = new Set<string>();
      while ((match = CALL_PATTERN.exec(fnBody)) !== null) {
        const calleeName = match[1];
        if (CALL_EXCLUDE.has(calleeName)) continue;
        if (calleeName === node.name) continue; // 不计自调用
        if (seen.has(calleeName)) continue;
        seen.add(calleeName);

        // 仅当 callee 是项目内已知函数才建立关系（避免噪音）
        const calleeIds = this.functionNameToEntityIds.get(calleeName);
        if (!calleeIds || calleeIds.length === 0) continue;

        // 取第一个匹配（同名的多个函数暂只连第一个）
        const targetId = calleeIds[0];
        const callLine = node.startLine + fnBody.slice(0, match.index).split('\n').length - 1;
        this.kg.addRelation(callerId, targetId, 'calls', {
          line: String(callLine),
        }, 0.7, 0.5);
        callsAdded++;
        this.byRelationType.calls++;
      }
    }
    return callsAdded;
  }

  /** 记录函数名 → 实体 ID 索引 */
  private recordFunctionName(name: string, entityId: string): void {
    const list = this.functionNameToEntityIds.get(name);
    if (list) {
      if (!list.includes(entityId)) list.push(entityId);
    } else {
      this.functionNameToEntityIds.set(name, [entityId]);
    }
  }

  /** 解析 import 目标为绝对路径（尽力而为） */
  private resolveImportTarget(fromFile: string, impSource: string): string | null {
    if (!impSource) return null;
    // 相对路径
    if (impSource.startsWith('.')) {
      // eslint-disable-next-line @typescript-eslint/no-var-requires
      const path = require('path');
      const dir = path.dirname(fromFile);
      const candidates = [
        path.resolve(dir, impSource),
        path.resolve(dir, impSource + '.ts'),
        path.resolve(dir, impSource + '.tsx'),
        path.resolve(dir, impSource + '.js'),
        path.resolve(dir, impSource + '.jsx'),
        path.resolve(dir, impSource + '.mjs'),
        path.resolve(dir, impSource + '.cjs'),
        path.resolve(dir, impSource, 'index.ts'),
        path.resolve(dir, impSource, 'index.js'),
      ];
      for (const c of candidates) {
        if (this.analyzedFiles.has(this.normalizePath(c))) return c;
      }
      return candidates[0]; // 返回最可能的路径
    }
    return null; // npm 包不建立文件关系
  }

  private makeFileEntityId(filePath: string): string {
    return `code_file:${this.normalizePath(filePath)}`;
  }
  private makeFunctionEntityId(filePath: string, name: string, line: number): string {
    return `code_fn:${this.normalizePath(filePath)}:${name}:${line}`;
  }
  private makeClassEntityId(filePath: string, name: string, line: number): string {
    return `code_cls:${this.normalizePath(filePath)}:${name}:${line}`;
  }
  private makeInterfaceEntityId(filePath: string, name: string, line: number): string {
    return `code_iface:${this.normalizePath(filePath)}:${name}:${line}`;
  }
  private makeTypeEntityId(filePath: string, name: string, line: number): string {
    return `code_type:${this.normalizePath(filePath)}:${name}:${line}`;
  }

  private normalizePath(p: string): string {
    return p.replace(/\\/g, '/').toLowerCase();
  }

  private basename(p: string): string {
    const norm = p.replace(/\\/g, '/');
    const parts = norm.split('/');
    return parts[parts.length - 1] || p;
  }

  /** 从内部缓存查实体（避免依赖 KnowledgeGraph 未公开的 by-id 查询） */
  private findEntityById(entityId: string): { id: string; name: string; properties: Record<string, string> } | undefined {
    const cached = this.entityCache.get(entityId);
    if (cached) {
      return { id: entityId, name: cached.name, properties: cached.properties };
    }
    return undefined;
  }
}

// ============ 支持的扩展名集合 ============

const SUPPORTED_EXTS = new Set([
  '.ts', '.tsx', '.js', '.jsx', '.mjs', '.cjs',
  '.py', '.go', '.rs', '.java', '.c', '.cpp', '.h', '.hpp',
]);
