/**
 * 代码质量分析系统 — CodeQualityAnalyzer
 *
 * 分析代码质量，检测代码异味、复杂度和重复代码。
 *
 * 核心能力：
 * 1. 圈复杂度分析 — 检测过高的圈复杂度
 * 2. 代码异味检测 — 检测长函数/长类/深嵌套/过多参数等
 * 3. 重复代码检测 — 检测重复的代码块
 * 4. 维护性指数 — 计算维护性指数（MI）
 * 5. 代码统计 — 行数/类数/方法数等
 * 6. 质量评分 — 综合质量评分
 *
 * 对标工具：SonarQube / ESLint complexity / CodeClimate
 */

import * as fs from 'fs';
import * as fsp from 'fs/promises';
import * as path from 'path';
import { logger } from './structured-logger.js';

// ============ 遍历预算与限制 ============

/** 单文件最大体积（字节），超过则跳过分析以避免阻塞 */
export const MAX_FILE_SIZE_BYTES = 2 * 1024 * 1024; // 2MB
/** 目录递归最大深度 */
export const MAX_TRAVERSAL_DEPTH = 32;
/** 单次分析最大累计行数预算 */
export const MAX_TOTAL_LINES = 2_000_000;

// ============ 类型定义 ============

/** 代码异味类型 */
export type CodeSmellType =
  | 'long_function'        // 长函数
  | 'long_class'           // 长类
  | 'deep_nesting'         // 深嵌套

  | 'too_many_params'      // 过多参数
  | 'too_many_branches'    // 过多分支
  | 'duplicate_code'       // 重复代码
  | 'god_class'            // 上帝类
  | 'feature_envy'         // 特性依恋
  | 'data_class'           // 数据类
  | 'dead_code'            // 死代码
  | 'magic_number'         // 魔法数字
  | 'todo_comment'         // TODO 注释
  | 'console_log';         // 调试日志

/** 代码异味记录 */
export interface CodeSmell {
  /** 类型 */
  type: CodeSmellType;
  /** 严重程度 */
  severity: 'critical' | 'major' | 'minor' | 'info';
  /** 文件路径 */
  filePath: string;
  /** 行号 */
  line: number;
  /** 函数/类名 */
  name?: string;
  /** 描述 */
  description: string;
  /** 度量值 */
  metric: number;
  /** 阈值 */
  threshold: number;
  /** 修复建议 */
  suggestion: string;
}

/** 函数复杂度信息 */
export interface FunctionComplexity {
  /** 函数名 */
  name: string;
  /** 文件路径 */
  filePath: string;
  /** 起始行 */
  startLine: number;
  /** 结束行 */
  endLine: number;
  /** 圈复杂度 */
  cyclomaticComplexity: number;
  /** 认知复杂度 */
  cognitiveComplexity: number;
  /** 行数 */
  linesOfCode: number;
  /** 参数数量 */
  parameterCount: number;
  /** 嵌套深度 */
  nestingDepth: number;
}

/** 重复代码块 */
export interface DuplicateCode {
  /** 块 ID */
  id: string;
  /** 代码内容 */
  content: string;
  /** 出现位置 */
  occurrences: Array<{
    filePath: string;
    startLine: number;
    endLine: number;
  }>;
  /** 重复行数 */
  lineCount: number;
  /** 相似度（0-1） */
  similarity: number;
}

/** 质量分析结果 */
export interface QualityReport {
  /** 文件路径 */
  filePath: string;
  /** 代码行数 */
  linesOfCode: number;
  /** 圈复杂度 */
  cyclomaticComplexity: number;
  /** 认知复杂度 */
  cognitiveComplexity: number;
  /** 维护性指数（0-100） */
  maintainabilityIndex: number;
  /** 代码异味 */
  codeSmells: CodeSmell[];
  /** 函数复杂度列表 */
  functions: FunctionComplexity[];
  /** 质量评分（0-100） */
  qualityScore: number;
}

/** 目录质量报告 */
export interface DirectoryQualityReport {
  /** 扫描的文件数 */
  filesScanned: number;
  /** 总代码行数 */
  totalLinesOfCode: number;
  /** 平均维护性指数 */
  avgMaintainabilityIndex: number;
  /** 代码异味统计 */
  codeSmellStats: Record<CodeSmellType, number>;
  /** 重复代码块 */
  duplicateCodes: DuplicateCode[];
  /** 最复杂的函数 */
  mostComplexFunctions: FunctionComplexity[];
  /** 质量最差的文件 */
  worstFiles: QualityReport[];
  /** 总体质量评分 */
  overallQualityScore: number;
  /** 各文件报告 */
  fileReports: QualityReport[];
}

// ============ 阈值配置 ============

const THRESHOLDS = {
  cyclomaticComplexity: { warn: 10, critical: 15 },
  cognitiveComplexity: { warn: 15, critical: 25 },
  functionLength: { warn: 50, critical: 100 },
  classLength: { warn: 200, critical: 500 },
  nestingDepth: { warn: 4, critical: 6 },
  parameterCount: { warn: 4, critical: 7 },
  branchCount: { warn: 10, critical: 15 },
  duplicateThreshold: 6, // 最小重复行数
};

// ============ 代码质量分析器 ============

export class CodeQualityAnalyzer {
  private log = logger.child({ module: 'CodeQualityAnalyzer' });

  // ========== 单文件分析 ==========

  /**
   * 分析单个文件
   */
  analyzeFile(filePath: string): QualityReport {
    const content = fs.readFileSync(filePath, 'utf-8');
    const lines = content.split('\n');

    // 1. 计算代码行数
    const linesOfCode = this.countLinesOfCode(lines);

    // 2. 提取函数
    const functions = this.extractFunctions(content, filePath);

    // 3. 计算复杂度
    const cyclomaticComplexity = this.calculateCyclomaticComplexity(content);
    const cognitiveComplexity = this.calculateCognitiveComplexity(content);

    // 4. 检测代码异味
    const codeSmells = this.detectCodeSmells(content, filePath, lines, functions);

    // 5. 计算维护性指数
    const maintainabilityIndex = this.calculateMaintainabilityIndex(
      linesOfCode,
      cyclomaticComplexity,
      lines.length,
    );

    // 6. 计算质量评分
    const qualityScore = this.calculateQualityScore(
      cyclomaticComplexity,
      cognitiveComplexity,
      maintainabilityIndex,
      codeSmells,
    );

    return {
      filePath,
      linesOfCode,
      cyclomaticComplexity,
      cognitiveComplexity,
      maintainabilityIndex,
      codeSmells,
      functions,
      qualityScore,
    };
  }

  /**
   * 分析目录
   */
  analyzeDirectory(dirPath: string, options?: {
    extensions?: string[];
    exclude?: string[];
    maxFiles?: number;
  }): DirectoryQualityReport {
    const extensions = options?.extensions ?? ['.ts', '.js', '.tsx', '.jsx'];
    const exclude = options?.exclude ?? ['node_modules', '.git', 'dist', 'build', '.duan'];
    const maxFiles = options?.maxFiles ?? 500;

    const fileReports: QualityReport[] = [];
    const allFunctions: FunctionComplexity[] = [];

    const analyzeRecursive = (currentPath: string) => {
      if (fileReports.length >= maxFiles) return;

      try {
        const entries = fs.readdirSync(currentPath, { withFileTypes: true });
        for (const entry of entries) {
          if (fileReports.length >= maxFiles) break;

          const fullPath = path.join(currentPath, entry.name);
          if (exclude.some(ex => fullPath.includes(ex))) continue;

          if (entry.isDirectory()) {
            analyzeRecursive(fullPath);
          } else if (entry.isFile()) {
            const ext = path.extname(entry.name);
            if (extensions.includes(ext)) {
              try {
                const report = this.analyzeFile(fullPath);
                fileReports.push(report);
                allFunctions.push(...report.functions);
              } catch (err: unknown) {
                this.log.error('分析文件失败', { filePath: fullPath, error: (err instanceof Error ? err.message : String(err)) });
              }
            }
          }
        }
      } catch (err: unknown) {
        this.log.error('扫描目录失败', { dirPath: currentPath, error: (err instanceof Error ? err.message : String(err)) });
      }
    };

    analyzeRecursive(dirPath);

    // 检测重复代码
    const duplicateCodes = this.detectDuplicateCode(fileReports);

    // 统计代码异味
    const codeSmellStats = {} as Record<CodeSmellType, number>;
    for (const report of fileReports) {
      for (const smell of report.codeSmells) {
        codeSmellStats[smell.type] = (codeSmellStats[smell.type] ?? 0) + 1;
      }
    }

    // 最复杂的函数
    const mostComplexFunctions = allFunctions
      .sort((a, b) => b.cyclomaticComplexity - a.cyclomaticComplexity)
      .slice(0, 20);

    // 质量最差的文件
    const worstFiles = [...fileReports]
      .sort((a, b) => a.qualityScore - b.qualityScore)
      .slice(0, 10);

    // 平均维护性指数
    const avgMI = fileReports.length > 0
      ? fileReports.reduce((sum, r) => sum + r.maintainabilityIndex, 0) / fileReports.length
      : 100;

    // 总体质量评分
    const overallQualityScore = fileReports.length > 0
      ? fileReports.reduce((sum, r) => sum + r.qualityScore, 0) / fileReports.length
      : 100;

    const totalLinesOfCode = fileReports.reduce((sum, r) => sum + r.linesOfCode, 0);

    this.log.info('目录质量分析完成', {
      dirPath,
      filesScanned: fileReports.length,
      totalLinesOfCode,
      overallQualityScore: overallQualityScore.toFixed(1),
      duplicateCount: duplicateCodes.length,
    });

    return {
      filesScanned: fileReports.length,
      totalLinesOfCode,
      avgMaintainabilityIndex: avgMI,
      codeSmellStats,
      duplicateCodes,
      mostComplexFunctions,
      worstFiles,
      overallQualityScore,
      fileReports,
    };
  }

  // ========== 复杂度计算 ==========

  /**
   * 计算圈复杂度
   * 基于决策点数量：if/else/for/while/case/&&/||/?:/catch
   */
  private calculateCyclomaticComplexity(content: string): number {
    let complexity = 1; // 基础复杂度

    // 决策点模式
    const patterns = [
      /\bif\s*\(/g,
      /\belse\s+if\s*\(/g,
      /\bfor\s*\(/g,
      /\bwhile\s*\(/g,
      /\bdo\s*\{/g,
      /\bcase\s+/g,
      /\bcatch\s*\(/g,
      /\?\s*[^:]+\s*:/g, // 三元运算符
      /&&/g,
      /\|\|/g,
    ];

    for (const pattern of patterns) {
      const matches = content.match(pattern);
      if (matches) complexity += matches.length;
    }

    return complexity;
  }

  /**
   * 计算认知复杂度
   * 更接近人类理解的复杂度度量
   */
  private calculateCognitiveComplexity(content: string): number {
    let complexity = 0;
    let nestingLevel = 0;

    const lines = content.split('\n');
    for (const line of lines) {
      const trimmed = line.trim();

      // 增加嵌套
      if (/\b(if|for|while|switch|try)\b/.test(trimmed) && trimmed.includes('{')) {
        complexity += 1 + nestingLevel;
        nestingLevel++;
      } else if (/\b(if|for|while|switch|try)\b/.test(trimmed)) {
        complexity += 1 + nestingLevel;
      }

      // else if / else
      if (/\belse\b/.test(trimmed)) {
        complexity += 1;
      }

      // 逻辑运算符
      const logicOps = (trimmed.match(/&&|\|\|/g) ?? []).length;
      complexity += logicOps;

      // 减少嵌套
      if (trimmed === '}' && nestingLevel > 0) {
        nestingLevel--;
      }
    }

    return complexity;
  }

  // ========== 函数提取 ==========

  /**
   * 提取函数信息
   */
  private extractFunctions(content: string, filePath: string): FunctionComplexity[] {
    const functions: FunctionComplexity[] = [];
    const lines = content.split('\n');

    // 匹配函数定义
    const funcPattern = /(?:export\s+)?(?:async\s+)?(?:function\s+|const\s+|let\s+|var\s+)(\w+)\s*(?:=\s*)?(?:\([^)]*\)|<[^>]*>\([^)]*\))\s*(?::\s*[^=]+)?\s*(?:=>\s*|\{)/g;

    let match: RegExpExecArray | null;
    while ((match = funcPattern.exec(content)) !== null) {
      const funcName = match[1];
      const beforeMatch = content.substring(0, match.index);
      const startLine = beforeMatch.split('\n').length;

      // 查找函数结束
      const endLine = this.findFunctionEnd(lines, startLine);
      const funcContent = lines.slice(startLine - 1, endLine).join('\n');

      // 计算复杂度
      const cyclomaticComplexity = this.calculateCyclomaticComplexity(funcContent);

      // 计算参数数量
      const paramMatch = match[0].match(/\(([^)]*)\)/);
      const paramCount = paramMatch
        ? paramMatch[1].split(',').filter(p => p.trim()).length
        : 0;

      // 计算嵌套深度
      const nestingDepth = this.calculateMaxNestingDepth(funcContent);

      // 计算认知复杂度
      const cognitiveComplexity = this.calculateCognitiveComplexity(funcContent);

      functions.push({
        name: funcName,
        filePath,
        startLine,
        endLine,
        cyclomaticComplexity,
        cognitiveComplexity,
        linesOfCode: endLine - startLine + 1,
        parameterCount: paramCount,
        nestingDepth,
      });
    }

    return functions;
  }

  /**
   * 查找函数结束行
   */
  private findFunctionEnd(lines: string[], startLine: number): number {
    let braceCount = 0;
    let foundOpenBrace = false;

    for (let i = startLine - 1; i < lines.length; i++) {
      const line = lines[i];
      for (const char of line) {
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

  /**
   * 计算最大嵌套深度
   */
  private calculateMaxNestingDepth(content: string): number {
    let maxDepth = 0;
    let currentDepth = 0;

    for (const char of content) {
      if (char === '{') {
        currentDepth++;
        maxDepth = Math.max(maxDepth, currentDepth);
      } else if (char === '}') {
        currentDepth = Math.max(0, currentDepth - 1);
      }
    }

    return maxDepth;
  }

  // ========== 代码异味检测 ==========

  /**
   * 检测代码异味
   */
  private detectCodeSmells(
    content: string,
    filePath: string,
    lines: string[],
    functions: FunctionComplexity[],
  ): CodeSmell[] {
    const smells: CodeSmell[] = [];

    // 1. 长函数
    for (const func of functions) {
      if (func.linesOfCode > THRESHOLDS.functionLength.critical) {
        smells.push({
          type: 'long_function',
          severity: 'critical',
          filePath,
          line: func.startLine,
          name: func.name,
          description: `函数 "${func.name}" 过长: ${func.linesOfCode} 行`,
          metric: func.linesOfCode,
          threshold: THRESHOLDS.functionLength.critical,
          suggestion: '将函数拆分为多个小函数，每个函数只做一件事',
        });
      } else if (func.linesOfCode > THRESHOLDS.functionLength.warn) {
        smells.push({
          type: 'long_function',
          severity: 'major',
          filePath,
          line: func.startLine,
          name: func.name,
          description: `函数 "${func.name}" 较长: ${func.linesOfCode} 行`,
          metric: func.linesOfCode,
          threshold: THRESHOLDS.functionLength.warn,
          suggestion: '考虑将函数拆分为多个小函数',
        });
      }

      // 2. 高复杂度
      if (func.cyclomaticComplexity > THRESHOLDS.cyclomaticComplexity.critical) {
        smells.push({
          type: 'too_many_branches',
          severity: 'critical',
          filePath,
          line: func.startLine,
          name: func.name,
          description: `函数 "${func.name}" 圈复杂度过高: ${func.cyclomaticComplexity}`,
          metric: func.cyclomaticComplexity,
          threshold: THRESHOLDS.cyclomaticComplexity.critical,
          suggestion: '减少分支数量，使用策略模式或多态替代复杂条件',
        });
      }

      // 3. 过多参数
      if (func.parameterCount > THRESHOLDS.parameterCount.critical) {
        smells.push({
          type: 'too_many_params',
          severity: 'critical',
          filePath,
          line: func.startLine,
          name: func.name,
          description: `函数 "${func.name}" 参数过多: ${func.parameterCount}`,
          metric: func.parameterCount,
          threshold: THRESHOLDS.parameterCount.critical,
          suggestion: '将参数封装为对象，或使用构建器模式',
        });
      }

      // 4. 深嵌套
      if (func.nestingDepth > THRESHOLDS.nestingDepth.critical) {
        smells.push({
          type: 'deep_nesting',
          severity: 'critical',
          filePath,
          line: func.startLine,
          name: func.name,
          description: `函数 "${func.name}" 嵌套过深: ${func.nestingDepth} 层`,
          metric: func.nestingDepth,
          threshold: THRESHOLDS.nestingDepth.critical,
          suggestion: '使用提前返回（guard clause）减少嵌套',
        });
      }
    }

    // 5. 长类
    const classPattern = /(?:export\s+)?class\s+(\w+)/g;
    let classMatch: RegExpExecArray | null;
    while ((classMatch = classPattern.exec(content)) !== null) {
      const className = classMatch[1];
      const beforeMatch = content.substring(0, classMatch.index);
      const startLine = beforeMatch.split('\n').length;
      const endLine = this.findFunctionEnd(lines, startLine);
      const classLength = endLine - startLine + 1;

      if (classLength > THRESHOLDS.classLength.critical) {
        smells.push({
          type: 'long_class',
          severity: 'critical',
          filePath,
          line: startLine,
          name: className,
          description: `类 "${className}" 过长: ${classLength} 行`,
          metric: classLength,
          threshold: THRESHOLDS.classLength.critical,
          suggestion: '将类拆分为多个小类，遵循单一职责原则',
        });
      }
    }

    // 6. 魔法数字
    const magicNumberPattern = /(?<![\w.])\d{4,}(?![\w.])/g;
    let magicMatch: RegExpExecArray | null;
    while ((magicMatch = magicNumberPattern.exec(content)) !== null) {
      const beforeMatch = content.substring(0, magicMatch.index);
      const line = beforeMatch.split('\n').length;
      smells.push({
        type: 'magic_number',
        severity: 'minor',
        filePath,
        line,
        description: `魔法数字: ${magicMatch[0]}`,
        metric: parseInt(magicMatch[0]),
        threshold: 1000,
        suggestion: '将魔法数字提取为有意义的常量',
      });
    }

    // 7. TODO 注释
    const todoPattern = /\/\/\s*TODO|\/\*\s*TODO/gi;
    let todoMatch: RegExpExecArray | null;
    while ((todoMatch = todoPattern.exec(content)) !== null) {
      const beforeMatch = content.substring(0, todoMatch.index);
      const line = beforeMatch.split('\n').length;
      smells.push({
        type: 'todo_comment',
        severity: 'info',
        filePath,
        line,
        description: 'TODO 注释未完成',
        metric: 1,
        threshold: 0,
        suggestion: '完成 TODO 或创建 issue 跟踪',
      });
    }

    // 8. console.log 调试日志
    const consolePattern = /console\.(log|debug|info)\s*\(/g;
    let consoleMatch: RegExpExecArray | null;
    while ((consoleMatch = consolePattern.exec(content)) !== null) {
      const beforeMatch = content.substring(0, consoleMatch.index);
      const line = beforeMatch.split('\n').length;
      smells.push({
        type: 'console_log',
        severity: 'minor',
        filePath,
        line,
        description: '调试日志语句',
        metric: 1,
        threshold: 0,
        suggestion: '使用正式的日志系统替代 console.log',
      });
    }

    return smells;
  }

  // ========== 重复代码检测 ==========

  /**
   * 检测重复代码
   */
  private detectDuplicateCode(reports: QualityReport[]): DuplicateCode[] {
    const duplicates: DuplicateCode[] = [];
    const minLines = THRESHOLDS.duplicateThreshold;

    // 收集所有文件的代码块
    const allBlocks: Array<{
      filePath: string;
      startLine: number;
      content: string;
    }> = [];

    for (const report of reports) {
      try {
        const content = fs.readFileSync(report.filePath, 'utf-8');
        const lines = content.split('\n');

        // 滑动窗口提取代码块
        for (let i = 0; i <= lines.length - minLines; i++) {
          const block = lines.slice(i, i + minLines)
            .join('\n')
            .trim();

          // 忽略空块和纯注释
          if (block.length < 20 || block.startsWith('//') || block.startsWith('/*')) continue;

          allBlocks.push({
            filePath: report.filePath,
            startLine: i + 1,
            content: block,
          });
        }
      } catch {
        // 忽略读取错误
      }
    }

    // 查找重复（使用哈希加速）
    const blockMap: Map<string, Array<{ filePath: string; startLine: number }>> = new Map();

    for (const block of allBlocks) {
      // 简单哈希
      let hash = 0;
      for (let i = 0; i < block.content.length; i++) {
        hash = ((hash << 5) - hash) + block.content.charCodeAt(i);
        hash |= 0;
      }
      const hashKey = `${hash}`;

      if (!blockMap.has(hashKey)) {
        blockMap.set(hashKey, []);
      }
      blockMap.get(hashKey)!.push({ filePath: block.filePath, startLine: block.startLine });
    }

    // 提取重复块
    let dupId = 0;
    for (const [_hashKey, occurrences] of blockMap) {
      if (occurrences.length < 2) continue;

      // 找到原始内容
      const originalBlock = allBlocks.find(b =>
        b.filePath === occurrences[0].filePath && b.startLine === occurrences[0].startLine
      );
      if (!originalBlock) continue;

      duplicates.push({
        id: `dup_${++dupId}`,
        content: originalBlock.content.substring(0, 200),
        occurrences: occurrences.map(o => ({
          filePath: o.filePath,
          startLine: o.startLine,
          endLine: o.startLine + minLines - 1,
        })),
        lineCount: minLines,
        similarity: 1.0,
      });
    }

    return duplicates.sort((a, b) => b.occurrences.length - a.occurrences.length).slice(0, 50);
  }

  // ========== 指标计算 ==========

  /**
   * 计算维护性指数
   * MI = max(0, (171 - 5.2 * ln(HV) - 0.23 * CC - 16.2 * ln(LOC)) * 100 / 171)
   */
  private calculateMaintainabilityIndex(loc: number, cyclomaticComplexity: number, _totalLines: number): number {
    const halsteadVolume = Math.log(Math.max(1, loc * 10)); // 简化的 Halstead 体积
    const mi = (171 - 5.2 * halsteadVolume - 0.23 * cyclomaticComplexity - 16.2 * Math.log(Math.max(1, loc))) * 100 / 171;
    return Math.max(0, Math.min(100, mi));
  }

  /**
   * 计算质量评分
   */
  private calculateQualityScore(
    cyclomaticComplexity: number,
    cognitiveComplexity: number,
    maintainabilityIndex: number,
    codeSmells: CodeSmell[],
  ): number {
    let score = 100;

    // 复杂度扣分
    if (cyclomaticComplexity > THRESHOLDS.cyclomaticComplexity.critical) {
      score -= 20;
    } else if (cyclomaticComplexity > THRESHOLDS.cyclomaticComplexity.warn) {
      score -= 10;
    }

    // 认知复杂度扣分
    if (cognitiveComplexity > THRESHOLDS.cognitiveComplexity.critical) {
      score -= 15;
    } else if (cognitiveComplexity > THRESHOLDS.cognitiveComplexity.warn) {
      score -= 8;
    }

    // 维护性指数扣分
    if (maintainabilityIndex < 50) {
      score -= 20;
    } else if (maintainabilityIndex < 65) {
      score -= 10;
    }

    // 代码异味扣分
    for (const smell of codeSmells) {
      const penalty = { critical: 5, major: 3, minor: 1, info: 0 }[smell.severity];
      score -= penalty;
    }

    return Math.max(0, Math.min(100, score));
  }

  /**
   * 计算代码行数
   */
  private countLinesOfCode(lines: string[]): number {
    return lines.filter(line => {
      const trimmed = line.trim();
      return trimmed.length > 0 && !trimmed.startsWith('//') && !trimmed.startsWith('/*') && !trimmed.startsWith('*');
    }).length;
  }

  // ========== 报告生成 ==========

  /**
   * 生成质量报告 Markdown
   */
  generateQualityReport(report: DirectoryQualityReport): string {
    const lines: string[] = [
      '# 代码质量分析报告',
      '',
      `> 生成时间: ${new Date().toISOString()}`,
      '',
      '## 概览',
      '',
      `| 指标 | 值 |`,
      `|------|-----|`,
      `| 扫描文件数 | ${report.filesScanned} |`,
      `| 总代码行数 | ${report.totalLinesOfCode} |`,
      `| 平均维护性指数 | ${report.avgMaintainabilityIndex.toFixed(1)} |`,
      `| 总体质量评分 | ${report.overallQualityScore.toFixed(1)}/100 |`,
      `| 重复代码块 | ${report.duplicateCodes.length} |`,
      '',
      '## 代码异味统计',
      '',
      `| 类型 | 数量 |`,
      `|------|------|`,
    ];

    for (const [type, count] of Object.entries(report.codeSmellStats)) {
      if (count > 0) {
        lines.push(`| ${type} | ${count} |`);
      }
    }

    // 最复杂的函数
    if (report.mostComplexFunctions.length > 0) {
      lines.push('', '## 最复杂的函数（前 10）', '');
      lines.push(`| 函数 | 文件 | 圈复杂度 | 认知复杂度 | 行数 | 参数数 | 嵌套深度 |`);
      lines.push(`|------|------|---------|---------|------|--------|---------|`);
      for (const func of report.mostComplexFunctions.slice(0, 10)) {
        lines.push(`| ${func.name} | ${path.basename(func.filePath)}:${func.startLine} | ${func.cyclomaticComplexity} | ${func.cognitiveComplexity} | ${func.linesOfCode} | ${func.parameterCount} | ${func.nestingDepth} |`);
      }
    }

    // 质量最差的文件
    if (report.worstFiles.length > 0) {
      lines.push('', '## 质量最差的文件（前 10）', '');
      lines.push(`| 文件 | 质量评分 | 维护性指数 | 圈复杂度 | 代码异味数 |`);
      lines.push(`|------|---------|---------|---------|-----------|`);
      for (const file of report.worstFiles.slice(0, 10)) {
        lines.push(`| ${path.basename(file.filePath)} | ${file.qualityScore.toFixed(0)} | ${file.maintainabilityIndex.toFixed(0)} | ${file.cyclomaticComplexity} | ${file.codeSmells.length} |`);
      }
    }

    // 重复代码
    if (report.duplicateCodes.length > 0) {
      lines.push('', '## 重复代码（前 10）', '');
      for (const dup of report.duplicateCodes.slice(0, 10)) {
        lines.push(`### 重复块 ${dup.id} (${dup.occurrences.length} 处出现, ${dup.lineCount} 行)`);
        for (const occ of dup.occurrences) {
          lines.push(`- ${path.basename(occ.filePath)}:${occ.startLine}-${occ.endLine}`);
        }
        lines.push('');
      }
    }

    // 改进建议
    lines.push('', '## 改进建议', '');
    if (report.overallQualityScore < 60) {
      lines.push('- 🔴 **代码质量较差**，建议优先重构质量最差的文件');
    } else if (report.overallQualityScore < 80) {
      lines.push('- 🟡 **代码质量一般**，建议逐步改进');
    } else {
      lines.push('- 🟢 **代码质量良好**，保持当前标准');
    }

    const criticalSmells = Object.entries(report.codeSmellStats)
      .filter(([, count]) => count > 0)
      .map(([type]) => type);

    if (criticalSmells.length > 0) {
      lines.push(`- 重点关注: ${criticalSmells.join(', ')}`);
    }

    if (report.duplicateCodes.length > 5) {
      lines.push('- 大量重复代码，建议提取公共方法或工具类');
    }

    return lines.join('\n');
  }
}
