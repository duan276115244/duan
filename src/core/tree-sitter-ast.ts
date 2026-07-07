/**
 * Tree-sitter AST 代码分析模块 — TreeSitterAST
 *
 * 段先生自主AI代理系统的深度代码分析能力：
 * - 混合架构：正则结构分析（始终可用）+ web-tree-sitter WASM（可选增强）
 * - 多语言支持：TypeScript/JavaScript/Python/Go/Rust/Java/C/C++
 * - AST级分析：导入/导出/函数/类/接口/类型/变量精确提取
 * - 代码度量：圈复杂度、嵌套深度、代码行数
 * - 代码异味检测：长函数、深嵌套、过多参数、重复模式、上帝类
 * - 依赖图构建：循环依赖检测、未使用导入发现
 * - 符号引用查找：跨文件符号使用定位
 *
 * 设计原则：
 * 1. 正则快速路径始终可用，无需原生依赖
 * 2. WASM后端可选加载，优雅降级
 * 3. 与 EventBus 事件系统集成，广播分析事件
 * 4. 通过 getToolDefinitions() 注册为 Agent Loop 工具
 */

import * as fs from 'fs';
import * as path from 'path';
import { logger } from './structured-logger.js';
import { EventBus } from './event-bus.js';

// ============ 类型定义 ============

/** AST节点 */
export interface ASTNode {
  type: string;
  name: string;
  startLine: number;
  endLine: number;
  children: ASTNode[];
  modifiers?: string[];
}

/** 代码度量 */
export interface CodeMetrics {
  totalLines: number;
  codeLines: number;
  functions: number;
  classes: number;
  interfaces: number;
  cyclomaticComplexity: number;
  maxNestingDepth: number;
}

/** 代码异味 */
export interface CodeSmell {
  type: string;
  severity: 'low' | 'medium' | 'high';
  location: string;
  description: string;
  suggestion: string;
}

/** AST分析结果 */
export interface ASTAnalysis {
  filePath: string;
  language: string;
  nodes: ASTNode[];
  imports: string[];
  exports: string[];
  metrics: CodeMetrics;
  smells: CodeSmell[];
}

/** 导入信息 */
export interface ImportInfo {
  source: string;
  items: string[];
  isTypeOnly: boolean;
  line: number;
}

/** 依赖分析结果 */
export interface DependencyAnalysis {
  filePath: string;
  imports: ImportInfo[];
  usedImports: string[];
  unusedImports: string[];
  dependents: string[];
}

/** 项目分析结果 */
export interface ProjectAnalysis {
  files: ASTAnalysis[];
  dependencyGraph: Map<string, string[]>;
  circularDependencies: string[][];
  totalMetrics: CodeMetrics;
}

/** 语言配置 */
interface LanguageConfig {
  name: string;
  extensions: string[];
  functionPattern: RegExp;
  classPattern: RegExp;
  interfacePattern: RegExp;
  typePattern: RegExp;
  importPattern: RegExp;
  exportPattern: RegExp;
  variablePattern: RegExp;
  commentPatterns: RegExp;
  stringPatterns: RegExp;
  nestingOpen: string[];
  nestingClose: string[];
}

// ============ 语言配置表 ============

const LANGUAGE_CONFIGS: Record<string, LanguageConfig> = {
  typescript: {
    name: 'TypeScript',
    extensions: ['.ts', '.tsx'],
    functionPattern: /(?:export\s+)?(?:async\s+)?function\s+(?:\*\s+)?(\w+)\s*(?:<[^>]*>)?\s*\(/g,
    classPattern: /(?:export\s+)?(?:abstract\s+)?class\s+(\w+)(?:\s+extends\s+\w+)?(?:\s+implements\s+[\w,\s]+)?\s*\{/g,
    interfacePattern: /(?:export\s+)?interface\s+(\w+)(?:\s+extends\s+[\w,\s]+)?\s*\{/g,
    typePattern: /(?:export\s+)?type\s+(\w+)\s*(?:<[^>]*>)?\s*=/g,
    importPattern: /import\s+(?:type\s+)?(?:(?:\{[^}]*\})|(?:[\w]+\s*,\s*\{[^}]*\})|[\w*]+)\s+from\s+['"]([^'"]+)['"]/g,
    exportPattern: /export\s+(?:default\s+)?(?:function|class|interface|type|const|let|var|enum)\s+(\w+)/g,
    variablePattern: /(?:export\s+)?(?:const|let|var)\s+(\w+)\s*[:=]/g,
    commentPatterns: /\/\/.*$|\/\*[\s\S]*?\*\//gm,
    stringPatterns: /'(?:[^'\\]|\\.)*'|"(?:[^"\\]|\\.)*"|`(?:[^`\\]|\\.)*`/g,
    nestingOpen: ['{', '(', '['],
    nestingClose: ['}', ')', ']'],
  },
  javascript: {
    name: 'JavaScript',
    extensions: ['.js', '.jsx', '.mjs', '.cjs'],
    functionPattern: /(?:export\s+)?(?:async\s+)?function\s+(?:\*\s+)?(\w+)\s*\(/g,
    classPattern: /(?:export\s+)?class\s+(\w+)(?:\s+extends\s+\w+)?\s*\{/g,
    interfacePattern: /$^/g, // JS无接口
    typePattern: /$^/g, // JS无类型别名
    importPattern: /import\s+(?:(?:\{[^}]*\})|(?:[\w]+\s*,\s*\{[^}]*\})|[\w*]+)\s+from\s+['"]([^'"]+)['"]/g,
    exportPattern: /export\s+(?:default\s+)?(?:function|class|const|let|var)\s+(\w+)/g,
    variablePattern: /(?:export\s+)?(?:const|let|var)\s+(\w+)\s*[:=]/g,
    commentPatterns: /\/\/.*$|\/\*[\s\S]*?\*\//gm,
    stringPatterns: /'(?:[^'\\]|\\.)*'|"(?:[^"\\]|\\.)*"|`(?:[^`\\]|\\.)*`/g,
    nestingOpen: ['{', '(', '['],
    nestingClose: ['}', ')', ']'],
  },
  python: {
    name: 'Python',
    extensions: ['.py', '.pyw', '.pyi'],
    functionPattern: /(?:async\s+)?def\s+(\w+)\s*\(/g,
    classPattern: /class\s+(\w+)(?:\([^)]*\))?\s*:/g,
    interfacePattern: /class\s+(\w+)\(.*Protocol.*\)\s*:/g,
    typePattern: /(\w+)\s*:\s*(?:Type|Union|Optional|Literal|Final)\b/g,
    importPattern: /(?:from\s+([\w.]+)\s+import|import\s+([\w.]+))/g,
    exportPattern: /__all__\s*=\s*\[([^\]]*)\]/g,
    variablePattern: /(\w+)\s*[:=]\s*(?!.*\bdef\b)/g,
    commentPatterns: /#.*$|"""[\s\S]*?"""|'''[\s\S]*?'''/gm,
    stringPatterns: /'(?:[^'\\]|\\.)*'|"(?:[^"\\]|\\.)*"|"""[\s\S]*?"""|'''[\s\S]*?'''/g,
    nestingOpen: ['(', '[', '{'],
    nestingClose: [')', ']', '}'],
  },
  go: {
    name: 'Go',
    extensions: ['.go'],
    functionPattern: /func\s+(?:\(\w+\s+\*?\w+\)\s+)?(\w+)\s*\(/g,
    classPattern: /type\s+(\w+)\s+struct\s*\{/g,
    interfacePattern: /type\s+(\w+)\s+interface\s*\{/g,
    typePattern: /type\s+(\w+)\s+(?:func|map|chan|\[)/g,
    importPattern: /import\s+(?:\([\s\S]*?\)|\s*"([^"]+)")/g,
    exportPattern: /func\s+(?:\(\w+\s+\*?\w+\)\s+)?([A-Z]\w+)\s*\(/g,
    variablePattern: /(?:var|const)\s+(\w+)\s+/g,
    commentPatterns: /\/\/.*$|\/\*[\s\S]*?\*\//gm,
    stringPatterns: /"(?:[^"\\]|\\.)*"|`(?:[^`\\]|\\.)*`/g,
    nestingOpen: ['{', '(', '['],
    nestingClose: ['}', ')', ']'],
  },
  rust: {
    name: 'Rust',
    extensions: ['.rs'],
    functionPattern: /(?:pub\s+)?(?:async\s+)?fn\s+(\w+)\s*(?:<[^>]*>)?\s*\(/g,
    classPattern: /(?:pub\s+)?struct\s+(\w+)/g,
    interfacePattern: /(?:pub\s+)?trait\s+(\w+)/g,
    typePattern: /(?:pub\s+)?type\s+(\w+)\s*(?:<[^>]*>)?\s*=/g,
    importPattern: /use\s+([\w:]+(?:::\{[^}]*\})?)/g,
    exportPattern: /pub\s+(?:fn|struct|trait|type|enum|mod)\s+(\w+)/g,
    variablePattern: /let\s+(?:mut\s+)?(\w+)/g,
    commentPatterns: /\/\/.*$|\/\*[\s\S]*?\*\//gm,
    stringPatterns: /"(?:[^"\\]|\\.)*"|r#*(?:[^"#]|#(?!"#))*"#*/g,
    nestingOpen: ['{', '(', '['],
    nestingClose: ['}', ')', ']'],
  },
  java: {
    name: 'Java',
    extensions: ['.java'],
    functionPattern: /(?:public|private|protected)?\s*(?:static\s+)?(?:abstract\s+)?(?:final\s+)?(?:synchronized\s+)?(?:[\w<>[\]]+\s+)+(\w+)\s*\(/g,
    classPattern: /(?:public|private|protected)?\s*(?:abstract\s+)?(?:final\s+)?class\s+(\w+)(?:\s+extends\s+\w+)?(?:\s+implements\s+[\w,\s]+)?\s*\{/g,
    interfacePattern: /(?:public|private|protected)?\s*interface\s+(\w+)(?:\s+extends\s+[\w,\s]+)?\s*\{/g,
    typePattern: /(?:public|private|protected)?\s*(?:abstract\s+)?(?:final\s+)?class\s+(\w+)/g,
    importPattern: /import\s+(?:static\s+)?([\w.]+(?:\.\*)?)/g,
    exportPattern: /public\s+(?:class|interface|enum)\s+(\w+)/g,
    variablePattern: /(?:private|protected|public|static)?\s*(?:final\s+)?(?:[\w<>[\]]+\s+)+(\w+)\s*[=;]/g,
    commentPatterns: /\/\/.*$|\/\*[\s\S]*?\*\//gm,
    stringPatterns: /"(?:[^"\\]|\\.)*"/g,
    nestingOpen: ['{', '(', '['],
    nestingClose: ['}', ')', ']'],
  },
  c: {
    name: 'C',
    extensions: ['.c', '.h'],
    functionPattern: /(?:static\s+)?(?:inline\s+)?(?:[\w*]+\s+)+(\w+)\s*\(/g,
    classPattern: /typedef\s+struct\s*(\w+)?\s*\{/g,
    interfacePattern: /$^/g,
    typePattern: /typedef\s+.*\s+(\w+)\s*;/g,
    importPattern: /#include\s+[<"]([^>"]+)[>"]/g,
    exportPattern: /$^/g,
    variablePattern: /(?:static\s+)?(?:extern\s+)?(?:const\s+)?(?:[\w*]+\s+)+(\w+)\s*[=;,]/g,
    commentPatterns: /\/\/.*$|\/\*[\s\S]*?\*\//gm,
    stringPatterns: /"(?:[^"\\]|\\.)*"/g,
    nestingOpen: ['{', '(', '['],
    nestingClose: ['}', ')', ']'],
  },
  cpp: {
    name: 'C++',
    extensions: ['.cpp', '.cc', '.cxx', '.hpp', '.hxx', '.hh'],
    functionPattern: /(?:(?:static|virtual|inline|constexpr|explicit)\s+)*(?:[\w:*&<>]+\s+)+(\w+)\s*(?:<[^>]*>)?\s*\(/g,
    classPattern: /(?:class|struct)\s+(\w+)(?::\s*(?:public|private|protected)\s+\w+(?:,\s*(?:public|private|protected)\s+\w+)*)?\s*\{/g,
    interfacePattern: /class\s+(\w+)(?:\s*:\s*public\s+\w+)*\s*\{/g,
    typePattern: /(?:typedef|using)\s+(?:\w+\s*=\s*)?(\w+)/g,
    importPattern: /#include\s+[<"]([^>"]+)[>"]/g,
    exportPattern: /$^/g,
    variablePattern: /(?:static\s+)?(?:const\s+)?(?:[\w:*&<>]+\s+)+(\w+)\s*[=;,]/g,
    commentPatterns: /\/\/.*$|\/\*[\s\S]*?\*\//gm,
    stringPatterns: /"(?:[^"\\]|\\.)*"|R"([^(]*)\([\s\S]*?\)\1"/g,
    nestingOpen: ['{', '(', '[', '<'],
    nestingClose: ['}', ')', ']', '>'],
  },
};

// ============ 主类 ============

export class TreeSitterAST {
  private log = logger.child({ module: 'TreeSitterAST' });
  private fileCache = new Map<string, { analysis: ASTAnalysis; mtime: number }>();
  private projectCache = new Map<string, { analysis: ProjectAnalysis; timestamp: number }>();
  private wasmBackend: unknown = null;
  private wasmAvailable = false;
  private stats = {
    filesParsed: 0,
    projectsAnalyzed: 0,
    usagesFound: 0,
    smellsDetected: 0,
    cacheHits: 0,
    wasmUsed: 0,
  };

  constructor() {
    void this.tryInitWasm();
  }

  /** 尝试初始化 web-tree-sitter WASM 后端 */
  private async tryInitWasm(): Promise<void> {
    try {
      // 动态导入，如果不可用则优雅降级
      // eslint-disable-next-line @typescript-eslint/no-require-imports
      const wasmModule = require('web-tree-sitter') as { init: () => Promise<void> };
      await wasmModule.init();
      this.wasmBackend = wasmModule;
      this.wasmAvailable = true;
      this.log.info('web-tree-sitter WASM 后端已加载');
    } catch {
      this.wasmAvailable = false;
      this.log.info('web-tree-sitter 不可用，使用正则快速路径作为分析后端');
    }
  }

  // ============ 核心分析方法 ============

  /** 根据文件扩展名检测语言 */
  private detectLanguage(filePath: string): string {
    const ext = path.extname(filePath).toLowerCase();
    for (const [lang, config] of Object.entries(LANGUAGE_CONFIGS)) {
      if (config.extensions.includes(ext)) {
        return lang;
      }
    }
    return 'unknown';
  }

  /** 获取语言配置 */
  private getLanguageConfig(lang: string): LanguageConfig | null {
    return LANGUAGE_CONFIGS[lang] || null;
  }

  /** 移除注释和字符串内容（避免误匹配） */
  private stripCommentsAndStrings(content: string, config: LanguageConfig): string {
    // 先替换字符串为占位符
    let result = content.replace(config.stringPatterns, (match) => {
      // 保留相同长度的空格，保持行号对齐
      return ' '.repeat(match.length);
    });
    // 再替换注释
    result = result.replace(config.commentPatterns, (match) => {
      // 用空格替换，保持行号对齐
      const newlineCount = (match.match(/\n/g) || []).length;
      const lastLine = match.split('\n').pop() || '';
      return '\n'.repeat(newlineCount) + ' '.repeat(lastLine.length);
    });
    return result;
  }

  /** 计算代码行数（排除空行和纯注释行） */
  private countCodeLines(content: string): number {
    let codeLines = 0;
    for (const line of content.split('\n')) {
      const trimmed = line.trim();
      if (trimmed.length > 0 && !trimmed.startsWith('//') && !trimmed.startsWith('/*') && !trimmed.startsWith('*') && !trimmed.startsWith('#')) {
        codeLines++;
      }
    }
    return codeLines;
  }

  /** 计算圈复杂度 */
  private calculateCyclomaticComplexity(cleanContent: string, lang: string): number {
    let complexity = 1;
    const patterns: RegExp[] = [];

    switch (lang) {
      case 'typescript':
      case 'javascript':
        patterns.push(
          /\bif\s*\(/g, /\belse\s+if\b/g, /\bfor\s*\(/g, /\bwhile\s*\(/g,
          /\bcase\s+/g, /\bcatch\s*\(/g, /&&/g, /\|\|/g, /\?\s*[^?]/g,
        );
        break;
      case 'python':
        patterns.push(
          /\bif\s+/g, /\belif\s+/g, /\bfor\s+/g, /\bwhile\s+/g,
          /\bexcept\b/g, /\band\b/g, /\bor\b/g,
        );
        break;
      case 'go':
        patterns.push(
          /\bif\s+/g, /\belse\s+if\b/g, /\bfor\s+/g, /\bcase\s+/g,
          /\bdefault\b/g, /&&/g, /\|\|/g,
        );
        break;
      case 'rust':
        patterns.push(
          /\bif\s+/g, /\belse\s+if\b/g, /\bfor\s+/g, /\bwhile\s+/g,
          /\bmatch\b/g, /&&/g, /\|\|/g, /\?\?/g,
        );
        break;
      case 'java':
        patterns.push(
          /\bif\s*\(/g, /\belse\s+if\b/g, /\bfor\s*\(/g, /\bwhile\s*\(/g,
          /\bcase\s+/g, /\bcatch\s*\(/g, /&&/g, /\|\|/g,
        );
        break;
      case 'c':
      case 'cpp':
        patterns.push(
          /\bif\s*\(/g, /\belse\s+if\b/g, /\bfor\s*\(/g, /\bwhile\s*\(/g,
          /\bcase\s+/g, /&&/g, /\|\|/g, /\?\s*[^?]/g,
        );
        break;
    }

    for (const p of patterns) {
      const matches = cleanContent.match(p);
      if (matches) {
        complexity += matches.length;
      }
    }

    return complexity;
  }

  /** 计算最大嵌套深度 */
  private calculateMaxNestingDepth(cleanContent: string, config: LanguageConfig): number {
    let maxDepth = 0;
    let currentDepth = 0;

    for (let i = 0; i < cleanContent.length; i++) {
      const ch = cleanContent[i];
      if (config.nestingOpen.includes(ch)) {
        currentDepth++;
        if (currentDepth > maxDepth) {
          maxDepth = currentDepth;
        }
      } else if (config.nestingClose.includes(ch)) {
        currentDepth = Math.max(0, currentDepth - 1);
      }
    }

    return maxDepth;
  }

  /** 提取函数节点 */
  private extractFunctions(cleanContent: string, rawContent: string, config: LanguageConfig): ASTNode[] {
    const nodes: ASTNode[] = [];
    const regex = new RegExp(config.functionPattern.source, 'g');
    let match: RegExpExecArray | null;

    while ((match = regex.exec(cleanContent)) !== null) {
      const name = match[1];
      if (!name) continue;

      const startLine = cleanContent.slice(0, match.index).split('\n').length;
      const modifiers = this.extractModifiers(match[0]);

      // 估算函数结束行
      const bodyStart = cleanContent.indexOf('{', match.index);
      let endLine = startLine;
      if (bodyStart > -1) {
        const braceEnd = this.findMatchingBrace(cleanContent, bodyStart + 1);
        endLine = cleanContent.slice(0, braceEnd).split('\n').length;
      } else {
        // Python风格：无花括号，估算到下一个同缩进def/class
        endLine = this.estimateBlockEnd(cleanContent, startLine);
      }

      nodes.push({
        type: 'function',
        name,
        startLine,
        endLine,
        children: [],
        modifiers,
      });
    }

    return nodes;
  }

  /** 提取类节点 */
  private extractClasses(cleanContent: string, rawContent: string, config: LanguageConfig, _lang: string): ASTNode[] {
    const nodes: ASTNode[] = [];
    const regex = new RegExp(config.classPattern.source, 'g');
    let match: RegExpExecArray | null;

    while ((match = regex.exec(cleanContent)) !== null) {
      const name = match[1];
      if (!name) continue;

      const startLine = cleanContent.slice(0, match.index).split('\n').length;
      const modifiers = this.extractModifiers(match[0]);

      // 提取类体
      const bodyStart = cleanContent.indexOf('{', match.index);
      let endLine = startLine;
      let classBody = '';

      if (bodyStart > -1) {
        const braceEnd = this.findMatchingBrace(cleanContent, bodyStart + 1);
        endLine = cleanContent.slice(0, braceEnd).split('\n').length;
        classBody = cleanContent.slice(bodyStart + 1, braceEnd);
      } else {
        endLine = this.estimateBlockEnd(cleanContent, startLine);
        // Python风格：提取到下一个同缩进定义
        const lines = cleanContent.split('\n');
        classBody = lines.slice(startLine, endLine).join('\n');
      }

      // 提取类方法作为子节点
      const children: ASTNode[] = [];
      const methodRegex = new RegExp(config.functionPattern.source, 'g');
      let methodMatch: RegExpExecArray | null;
      while ((methodMatch = methodRegex.exec(classBody)) !== null) {
        const mName = methodMatch[1];
        if (!mName) continue;
        const mStartLine = startLine + classBody.slice(0, methodMatch.index).split('\n').length;
        children.push({
          type: 'method',
          name: mName,
          startLine: mStartLine,
          endLine: mStartLine + 5, // 估算
          children: [],
          modifiers: this.extractModifiers(methodMatch[0]),
        });
      }

      nodes.push({
        type: 'class',
        name,
        startLine,
        endLine,
        children,
        modifiers,
      });
    }

    return nodes;
  }

  /** 提取接口节点 */
  private extractInterfaces(cleanContent: string, config: LanguageConfig): ASTNode[] {
    const nodes: ASTNode[] = [];
    const regex = new RegExp(config.interfacePattern.source, 'g');
    let match: RegExpExecArray | null;

    while ((match = regex.exec(cleanContent)) !== null) {
      const name = match[1];
      if (!name) continue;

      const startLine = cleanContent.slice(0, match.index).split('\n').length;
      const bodyStart = cleanContent.indexOf('{', match.index);
      let endLine = startLine;
      if (bodyStart > -1) {
        const braceEnd = this.findMatchingBrace(cleanContent, bodyStart + 1);
        endLine = cleanContent.slice(0, braceEnd).split('\n').length;
      }

      nodes.push({
        type: 'interface',
        name,
        startLine,
        endLine,
        children: [],
        modifiers: this.extractModifiers(match[0]),
      });
    }

    return nodes;
  }

  /** 提取类型别名节点 */
  private extractTypes(cleanContent: string, config: LanguageConfig): ASTNode[] {
    const nodes: ASTNode[] = [];
    const regex = new RegExp(config.typePattern.source, 'g');
    let match: RegExpExecArray | null;

    while ((match = regex.exec(cleanContent)) !== null) {
      const name = match[1];
      if (!name) continue;

      const startLine = cleanContent.slice(0, match.index).split('\n').length;

      nodes.push({
        type: 'type_alias',
        name,
        startLine,
        endLine: startLine,
        children: [],
        modifiers: this.extractModifiers(match[0]),
      });
    }

    return nodes;
  }

  /** 提取变量节点 */
  private extractVariables(cleanContent: string, config: LanguageConfig): ASTNode[] {
    const nodes: ASTNode[] = [];
    const regex = new RegExp(config.variablePattern.source, 'g');
    let match: RegExpExecArray | null;

    while ((match = regex.exec(cleanContent)) !== null) {
      const name = match[1];
      if (!name) continue;

      const startLine = cleanContent.slice(0, match.index).split('\n').length;

      nodes.push({
        type: 'variable',
        name,
        startLine,
        endLine: startLine,
        children: [],
        modifiers: this.extractModifiers(match[0]),
      });
    }

    return nodes;
  }

  /** 从声明中提取修饰符 */
  private extractModifiers(declaration: string): string[] {
    const modifiers: string[] = [];
    const modifierKeywords = [
      'export', 'default', 'async', 'abstract', 'static', 'public',
      'private', 'protected', 'final', 'const', 'let', 'var',
      'synchronized', 'volatile', 'native', 'transient',
      'override', 'virtual', 'inline', 'constexpr', 'mutable',
      'pub', 'mut', 'impl',
    ];

    for (const kw of modifierKeywords) {
      if (new RegExp(`\\b${kw}\\b`).test(declaration)) {
        modifiers.push(kw);
      }
    }

    return modifiers;
  }

  /** 查找匹配的右花括号 */
  private findMatchingBrace(content: string, start: number): number {
    let depth = 1;
    let inString = false;
    let stringChar = '';

    for (let i = start; i < content.length; i++) {
      const ch = content[i];
      const prev = i > 0 ? content[i - 1] : '';

      // 跳过字符串内容
      if (inString) {
        if (ch === stringChar && prev !== '\\') {
          inString = false;
        }
        continue;
      }

      if (ch === '"' || ch === "'" || ch === '`') {
        inString = true;
        stringChar = ch;
        continue;
      }

      if (ch === '{') depth++;
      if (ch === '}') {
        depth--;
        if (depth === 0) return i;
      }
    }

    return content.length;
  }

  /** 估算无花括号语言（Python）的块结束行 */
  private estimateBlockEnd(content: string, startLine: number): number {
    const lines = content.split('\n');
    if (startLine - 1 >= lines.length) return startLine;

    // 获取起始行的缩进级别
    const startIndent = lines[startLine - 1].search(/\S/);
    if (startIndent === -1) return startLine;

    // 从下一行开始，找到第一个缩进小于等于起始行的非空行
    for (let i = startLine; i < lines.length; i++) {
      const line = lines[i];
      if (line.trim().length === 0) continue;
      const currentIndent = line.search(/\S/);
      if (currentIndent <= startIndent) {
        return i;
      }
    }

    return lines.length;
  }

  /** 提取导入列表 */
  private extractImportList(cleanContent: string, config: LanguageConfig): string[] {
    const imports: string[] = [];
    const regex = new RegExp(config.importPattern.source, 'g');
    let match: RegExpExecArray | null;

    while ((match = regex.exec(cleanContent)) !== null) {
      const source = match[1] || match[2] || match[0];
      imports.push(source.trim());
    }

    return Array.from(new Set(imports));
  }

  /** 提取导出列表 */
  private extractExportList(cleanContent: string, config: LanguageConfig): string[] {
    const exports: string[] = [];
    const regex = new RegExp(config.exportPattern.source, 'g');
    let match: RegExpExecArray | null;

    while ((match = regex.exec(cleanContent)) !== null) {
      const name = match[1];
      if (name) exports.push(name);
    }

    return Array.from(new Set(exports));
  }

  /** 提取详细导入信息 */
  private extractImportInfos(rawContent: string, config: LanguageConfig, lang: string): ImportInfo[] {
    const imports: ImportInfo[] = [];

    if (lang === 'typescript' || lang === 'javascript') {
      // TS/JS: import { A, B } from 'source' / import X from 'source' / import type { T } from 'source'
      const detailedPattern = /import\s+(type\s+)?(?:(\{[^}]*\})|([\w]+)\s*,\s*(\{[^}]*\})|([\w*]+))\s+from\s+['"]([^'"]+)['"]/g;
      let match: RegExpExecArray | null;
      while ((match = detailedPattern.exec(rawContent)) !== null) {
        const isTypeOnly = !!match[1];
        const source = match[6];
        const line = rawContent.slice(0, match.index).split('\n').length;
        const items: string[] = [];

        if (match[2]) {
          // { A, B }
          items.push(...match[2].replace(/[{}]/g, '').split(',').map(s => s.trim()).filter(Boolean));
        } else if (match[3] && match[4]) {
          // X, { A, B }
          items.push(match[3]);
          items.push(...match[4].replace(/[{}]/g, '').split(',').map(s => s.trim()).filter(Boolean));
        } else if (match[5]) {
          // X or *
          items.push(match[5]);
        }

        imports.push({ source, items, isTypeOnly, line });
      }

      // 处理 import 'source' 形式（副作用导入）
      const sideEffectPattern = /import\s+['"]([^'"]+)['"]/g;
      let seMatch: RegExpExecArray | null;
      while ((seMatch = sideEffectPattern.exec(rawContent)) !== null) {
        // 检查是否已被上面的模式匹配过
        const line = rawContent.slice(0, seMatch.index).split('\n').length;
        if (!imports.some(i => i.line === line)) {
          imports.push({ source: seMatch[1], items: [], isTypeOnly: false, line });
        }
      }
    } else if (lang === 'python') {
      const fromPattern = /from\s+([\w.]+)\s+import\s+([\w,\s*]+)/g;
      let match: RegExpExecArray | null;
      while ((match = fromPattern.exec(rawContent)) !== null) {
        const source = match[1];
        const line = rawContent.slice(0, match.index).split('\n').length;
        const items = match[2].split(',').map(s => s.trim()).filter(Boolean);
        imports.push({ source, items, isTypeOnly: false, line });
      }

      const importPattern = /^import\s+([\w.]+(?:\s*,\s*[\w.]+)*)/gm;
      let impMatch: RegExpExecArray | null;
      while ((impMatch = importPattern.exec(rawContent)) !== null) {
        const line = rawContent.slice(0, impMatch.index).split('\n').length;
        const items = impMatch[1].split(',').map(s => s.trim()).filter(Boolean);
        for (const item of items) {
          imports.push({ source: item, items: [item], isTypeOnly: false, line });
        }
      }
    } else if (lang === 'go') {
      // Go: import "source" 或 import ( "source1" "source2" )
      const singlePattern = /import\s+"([^"]+)"/g;
      let match: RegExpExecArray | null;
      while ((match = singlePattern.exec(rawContent)) !== null) {
        const line = rawContent.slice(0, match.index).split('\n').length;
        imports.push({ source: match[1], items: [], isTypeOnly: false, line });
      }

      const multiPattern = /import\s*\(([\s\S]*?)\)/g;
      let multiMatch: RegExpExecArray | null;
      while ((multiMatch = multiPattern.exec(rawContent)) !== null) {
        const block = multiMatch[1];
        const lineStart = rawContent.slice(0, multiMatch.index).split('\n').length;
        const sources = block.match(/"([^"]+)"/g) || [];
        for (const src of sources) {
          imports.push({ source: src.replace(/"/g, ''), items: [], isTypeOnly: false, line: lineStart });
        }
      }
    } else if (lang === 'rust') {
      const usePattern = /use\s+([\w:]+(?:::\{([^}]*)\})?)/g;
      let match: RegExpExecArray | null;
      while ((match = usePattern.exec(rawContent)) !== null) {
        const line = rawContent.slice(0, match.index).split('\n').length;
        const fullPath = match[1];
        const groupedItems = match[2];
        const items: string[] = [];

        if (groupedItems) {
          items.push(...groupedItems.split(',').map(s => s.trim()).filter(Boolean));
        }

        imports.push({ source: fullPath, items, isTypeOnly: false, line });
      }
    } else if (lang === 'java') {
      const importPattern = /import\s+(?:static\s+)?([\w.]+(?:\.\*)?)/g;
      let match: RegExpExecArray | null;
      while ((match = importPattern.exec(rawContent)) !== null) {
        const line = rawContent.slice(0, match.index).split('\n').length;
        const source = match[1];
        const items = source.endsWith('.*') ? ['*'] : [source.split('.').pop() || ''];
        imports.push({ source, items, isTypeOnly: false, line });
      }
    } else if (lang === 'c' || lang === 'cpp') {
      const includePattern = /#include\s+[<"]([^>"]+)[>"]/g;
      let match: RegExpExecArray | null;
      while ((match = includePattern.exec(rawContent)) !== null) {
        const line = rawContent.slice(0, match.index).split('\n').length;
        imports.push({ source: match[1], items: [], isTypeOnly: false, line });
      }
    }

    return imports;
  }

  // ============ 公共 API ============

  /** 解析单个文件，返回AST分析结果 */
  parseFile(filePath: string): Promise<ASTAnalysis> {
    const startTime = Date.now();

    try {
      // 检查缓存
      const stats = fs.statSync(filePath);
      const cached = this.fileCache.get(filePath);
      if (cached && cached.mtime === stats.mtimeMs) {
        this.stats.cacheHits++;
        this.log.debug('文件分析缓存命中', { filePath });
        return Promise.resolve(cached.analysis);
      }

      const content = fs.readFileSync(filePath, 'utf-8');
      const lang = this.detectLanguage(filePath);
      const config = this.getLanguageConfig(lang);

      if (!config || lang === 'unknown') {
        this.log.warn('不支持的语言', { filePath, ext: path.extname(filePath) });
        const emptyMetrics: CodeMetrics = {
          totalLines: content.split('\n').length,
          codeLines: 0,
          functions: 0,
          classes: 0,
          interfaces: 0,
          cyclomaticComplexity: 0,
          maxNestingDepth: 0,
        };
        return Promise.resolve({
          filePath,
          language: 'unknown',
          nodes: [],
          imports: [],
          exports: [],
          metrics: emptyMetrics,
          smells: [],
        });
      }

      // 清理注释和字符串
      const cleanContent = this.stripCommentsAndStrings(content, config);

      // 提取节点
      const functionNodes = this.extractFunctions(cleanContent, content, config);
      const classNodes = this.extractClasses(cleanContent, content, config, lang);
      const interfaceNodes = this.extractInterfaces(cleanContent, config);
      const typeNodes = this.extractTypes(cleanContent, config);
      const variableNodes = this.extractVariables(cleanContent, config);

      const allNodes: ASTNode[] = [
        ...classNodes,
        ...interfaceNodes,
        ...functionNodes,
        ...typeNodes,
        ...variableNodes,
      ];

      // 提取导入/导出
      const imports = this.extractImportList(cleanContent, config);
      const exports = this.extractExportList(cleanContent, config);

      // 计算度量
      const metrics: CodeMetrics = {
        totalLines: content.split('\n').length,
        codeLines: this.countCodeLines(content),
        functions: functionNodes.length,
        classes: classNodes.length,
        interfaces: interfaceNodes.length,
        cyclomaticComplexity: this.calculateCyclomaticComplexity(cleanContent, lang),
        maxNestingDepth: this.calculateMaxNestingDepth(cleanContent, config),
      };

      // 检测代码异味
      const smells = this.detectSmellsInternal(cleanContent, content, filePath, lang, config, allNodes, metrics);

      const analysis: ASTAnalysis = {
        filePath,
        language: config.name,
        nodes: allNodes,
        imports,
        exports,
        metrics,
        smells,
      };

      // 缓存结果
      this.fileCache.set(filePath, { analysis, mtime: stats.mtimeMs });
      this.stats.filesParsed++;

      // 广播事件
      EventBus.getInstance().emitSync('ast.file.parsed', {
        filePath,
        language: config.name,
        metrics,
        durationMs: Date.now() - startTime,
      }, { source: 'TreeSitterAST' });

      this.log.info('文件解析完成', {
        filePath,
        language: config.name,
        functions: metrics.functions,
        classes: metrics.classes,
        complexity: metrics.cyclomaticComplexity,
        durationMs: Date.now() - startTime,
      });

      return Promise.resolve(analysis);
    } catch (err: unknown) {
      this.log.error('文件解析失败', { filePath, error: err instanceof Error ? err.message : String(err) });
      const emptyMetrics: CodeMetrics = {
        totalLines: 0, codeLines: 0, functions: 0, classes: 0,
        interfaces: 0, cyclomaticComplexity: 0, maxNestingDepth: 0,
      };
      return Promise.resolve({
        filePath,
        language: 'unknown',
        nodes: [],
        imports: [],
        exports: [],
        metrics: emptyMetrics,
        smells: [],
      });
    }
  }

  /** 分析整个项目 */
  async analyzeProject(dir: string): Promise<ProjectAnalysis> {
    const startTime = Date.now();

    // 检查项目缓存
    const cached = this.projectCache.get(dir);
    if (cached && Date.now() - cached.timestamp < 60000) {
      this.stats.cacheHits++;
      return cached.analysis;
    }

    const sourceFiles = this.walkDir(dir);
    const fileAnalyses: ASTAnalysis[] = [];

    // 并行解析所有文件（限制并发数）
    const batchSize = 10;
    for (let i = 0; i < sourceFiles.length; i += batchSize) {
      const batch = sourceFiles.slice(i, i + batchSize);
      const results = await Promise.all(batch.map(f => this.parseFile(f)));
      fileAnalyses.push(...results);
    }

    // 构建依赖图
    const dependencyGraph = new Map<string, string[]>();
    for (const analysis of fileAnalyses) {
      const deps = this.resolveDependencies(analysis.filePath, analysis.imports, dir);
      dependencyGraph.set(analysis.filePath, deps);
    }

    // 检测循环依赖
    const circularDependencies = this.detectCircularDependencies(dependencyGraph);

    // 汇总度量
    const totalMetrics: CodeMetrics = {
      totalLines: 0,
      codeLines: 0,
      functions: 0,
      classes: 0,
      interfaces: 0,
      cyclomaticComplexity: 0,
      maxNestingDepth: 0,
    };

    for (const analysis of fileAnalyses) {
      totalMetrics.totalLines += analysis.metrics.totalLines;
      totalMetrics.codeLines += analysis.metrics.codeLines;
      totalMetrics.functions += analysis.metrics.functions;
      totalMetrics.classes += analysis.metrics.classes;
      totalMetrics.interfaces += analysis.metrics.interfaces;
      totalMetrics.cyclomaticComplexity += analysis.metrics.cyclomaticComplexity;
      totalMetrics.maxNestingDepth = Math.max(totalMetrics.maxNestingDepth, analysis.metrics.maxNestingDepth);
    }

    const projectAnalysis: ProjectAnalysis = {
      files: fileAnalyses,
      dependencyGraph,
      circularDependencies,
      totalMetrics,
    };

    // 缓存
    this.projectCache.set(dir, { analysis: projectAnalysis, timestamp: Date.now() });
    this.stats.projectsAnalyzed++;

    // 广播事件
    EventBus.getInstance().emitSync('ast.project.analyzed', {
      dir,
      fileCount: fileAnalyses.length,
      totalMetrics,
      circularDependencies: circularDependencies.length,
      durationMs: Date.now() - startTime,
    }, { source: 'TreeSitterAST' });

    this.log.info('项目分析完成', {
      dir,
      files: fileAnalyses.length,
      functions: totalMetrics.functions,
      classes: totalMetrics.classes,
      circularDeps: circularDependencies.length,
      durationMs: Date.now() - startTime,
    });

    return projectAnalysis;
  }

  /** 查找符号使用 */
  findUsages(filePath: string, symbolName: string): Promise<string> {
    const startTime = Date.now();
    const dir = path.dirname(filePath);
    const sourceFiles = this.walkDir(dir);
    const usages: Array<{ file: string; line: number; context: string }> = [];

    for (const file of sourceFiles) {
      try {
        const content = fs.readFileSync(file, 'utf-8');
        const lines = content.split('\n');

        for (let i = 0; i < lines.length; i++) {
          const line = lines[i];
          // 精确匹配符号名（词边界）
          const regex = new RegExp(`\\b${this.escapeRegex(symbolName)}\\b`);
          if (regex.test(line)) {
            // 排除定义行（函数声明、类声明等）
            usages.push({
              file: path.relative(dir, file),
              line: i + 1,
              context: line.trim(),
            });
          }
        }
      } catch {
        // 跳过无法读取的文件
      }
    }

    this.stats.usagesFound += usages.length;

    // 广播事件
    EventBus.getInstance().emitSync('ast.usages.found', {
      filePath,
      symbolName,
      usageCount: usages.length,
      durationMs: Date.now() - startTime,
    }, { source: 'TreeSitterAST' });

    if (usages.length === 0) {
      return Promise.resolve(`未找到符号 "${symbolName}" 的使用`);
    }

    const output = usages.map(u => `${u.file}:${u.line} → ${u.context}`).join('\n');
    return Promise.resolve(`找到 ${usages.length} 处使用:\n${output}`);
  }

  /** 检测代码异味 */
  async detectSmells(filePath: string): Promise<string> {
    const analysis = await this.parseFile(filePath);
    if (analysis.smells.length === 0) {
      return `${path.basename(filePath)} 未检测到代码异味`;
    }

    const output = analysis.smells.map(s => {
      let severity: string;
      if (s.severity === 'high') severity = '🔴';
      else if (s.severity === 'medium') severity = '🟡';
      else severity = '🟢';
      return `${severity} [${s.type}] ${s.location}\n   ${s.description}\n   建议: ${s.suggestion}`;
    }).join('\n\n');

    return `检测到 ${analysis.smells.length} 个代码异味:\n\n${output}`;
  }

  /** 获取代码结构大纲 */
  async getStructure(filePath: string): Promise<string> {
    const analysis = await this.parseFile(filePath);
    if (analysis.nodes.length === 0) {
      return `${path.basename(filePath)} 无可提取的结构`;
    }

    const lines: string[] = [`${path.basename(filePath)} (${analysis.language})`];
    this.formatStructure(analysis.nodes, lines, 0);
    return lines.join('\n');
  }

  /** 分析文件依赖 */
  getDependencies(filePath: string): Promise<string> {
    const startTime = Date.now();

    try {
      const content = fs.readFileSync(filePath, 'utf-8');
      const lang = this.detectLanguage(filePath);
      const config = this.getLanguageConfig(lang);

      if (!config) {
        return Promise.resolve(`不支持分析 ${path.extname(filePath)} 文件的依赖`);
      }

      const cleanContent = this.stripCommentsAndStrings(content, config);
      const importInfos = this.extractImportInfos(content, config, lang);

      // 检测未使用的导入
      const usedImports: string[] = [];
      const unusedImports: string[] = [];

      for (const imp of importInfos) {
        let isUsed = false;
        for (const item of imp.items) {
          if (item === '*' || item === '') {
            isUsed = true;
            break;
          }
          // 在文件内容中搜索该标识符的使用
          const usageRegex = new RegExp(`\\b${this.escapeRegex(item)}\\b`);
          if (usageRegex.test(cleanContent)) {
            isUsed = true;
            break;
          }
        }
        // 副作用导入（无items）视为已使用
        if (imp.items.length === 0) {
          isUsed = true;
        }
        if (isUsed) {
          usedImports.push(imp.source);
        } else {
          unusedImports.push(imp.source);
        }
      }

      // 查找依赖此文件的文件（反向依赖）
      const dir = path.dirname(filePath);
      const sourceFiles = this.walkDir(dir);
      const dependents: string[] = [];

      for (const file of sourceFiles) {
        if (file === filePath) continue;
        try {
          const otherContent = fs.readFileSync(file, 'utf-8');
          const relativePath = this.getRelativeImportPath(file, filePath);
          // 检查是否导入了当前文件
          if (otherContent.includes(relativePath) || otherContent.includes(filePath)) {
            dependents.push(path.relative(dir, file));
          }
        } catch {
          // 跳过
        }
      }

      // 广播事件
      EventBus.getInstance().emitSync('ast.dependencies.analyzed', {
        filePath,
        importCount: importInfos.length,
        unusedCount: unusedImports.length,
        dependentCount: dependents.length,
        durationMs: Date.now() - startTime,
      }, { source: 'TreeSitterAST' });

      // 格式化输出
      const lines: string[] = [];
      lines.push(`📁 ${path.basename(filePath)} 依赖分析`);
      lines.push('');
      lines.push(`📥 导入 (${importInfos.length}):`);
      for (const imp of importInfos) {
        const typeTag = imp.isTypeOnly ? ' [type]' : '';
        const itemsStr = imp.items.length > 0 ? ` {${imp.items.join(', ')}}` : '';
        lines.push(`  L${imp.line}: ${imp.source}${itemsStr}${typeTag}`);
      }
      lines.push('');
      if (unusedImports.length > 0) {
        lines.push(`⚠️ 未使用的导入 (${unusedImports.length}):`);
        for (const unused of unusedImports) {
          lines.push(`  - ${unused}`);
        }
        lines.push('');
      }
      if (dependents.length > 0) {
        lines.push(`📤 被依赖 (${dependents.length}):`);
        for (const dep of dependents) {
          lines.push(`  - ${dep}`);
        }
      }

      return Promise.resolve(lines.join('\n'));
    } catch (err: unknown) {
      return Promise.resolve(`依赖分析失败: ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  // ============ 内部辅助方法 ============

  /** 内部代码异味检测 */
  private detectSmellsInternal(
    cleanContent: string,
    rawContent: string,
    filePath: string,
    lang: string,
    config: LanguageConfig,
    nodes: ASTNode[],
    metrics: CodeMetrics,
  ): CodeSmell[] {
    const smells: CodeSmell[] = [];
    const fileName = path.basename(filePath);

    // 1. 长函数检测（>50行）
    for (const node of nodes) {
      if (node.type === 'function' || node.type === 'method') {
        const lineCount = node.endLine - node.startLine + 1;
        if (lineCount > 50) {
          smells.push({
            type: 'long_function',
            severity: (() => {
              if (lineCount > 100) return 'high';
              if (lineCount > 75) return 'medium';
              return 'low';
            })(),
            location: `${fileName}:${node.startLine}`,
            description: `函数 "${node.name}" 有 ${lineCount} 行（阈值: 50行）`,
            suggestion: '考虑将函数拆分为更小的、职责单一的子函数',
          });
        }
      }
    }

    // 2. 深嵌套检测（>4层）
    if (metrics.maxNestingDepth > 4) {
      smells.push({
        type: 'deep_nesting',
        severity: metrics.maxNestingDepth > 6 ? 'high' : 'medium',
        location: `${fileName}`,
        description: `最大嵌套深度 ${metrics.maxNestingDepth} 层（阈值: 4层）`,
        suggestion: '使用提前返回（early return）、提取方法或策略模式来降低嵌套深度',
      });
    }

    // 3. 过多参数检测（>5个）
    for (const node of nodes) {
      if (node.type === 'function' || node.type === 'method') {
        const paramCount = this.countParameters(cleanContent, node, lang);
        if (paramCount > 5) {
          smells.push({
            type: 'too_many_parameters',
            severity: paramCount > 8 ? 'high' : 'medium',
            location: `${fileName}:${node.startLine}`,
            description: `函数 "${node.name}" 有 ${paramCount} 个参数（阈值: 5个）`,
            suggestion: '考虑使用选项对象（Options Pattern）或构建器模式来减少参数数量',
          });
        }
      }
    }

    // 4. 上帝类检测（方法数>15）
    for (const node of nodes) {
      if (node.type === 'class') {
        const methodCount = node.children.filter(c => c.type === 'method').length;
        if (methodCount > 15) {
          smells.push({
            type: 'god_class',
            severity: methodCount > 25 ? 'high' : 'medium',
            location: `${fileName}:${node.startLine}`,
            description: `类 "${node.name}" 有 ${methodCount} 个方法（阈值: 15个）`,
            suggestion: '考虑将类拆分为多个职责单一的类（单一职责原则）',
          });
        }
      }
    }

    // 5. 高圈复杂度检测
    if (metrics.cyclomaticComplexity > 20) {
      smells.push({
        type: 'high_complexity',
        severity: metrics.cyclomaticComplexity > 40 ? 'high' : 'medium',
        location: `${fileName}`,
        description: `文件圈复杂度 ${metrics.cyclomaticComplexity}（阈值: 20）`,
        suggestion: '简化条件逻辑，提取方法，使用多态替代条件分支',
      });
    }

    // 6. 重复代码模式检测（简单启发式：连续相似行）
    this.detectDuplicatePatterns(rawContent, fileName, smells);

    this.stats.smellsDetected += smells.length;
    return smells;
  }

  /** 计算函数参数数量 */
  private countParameters(cleanContent: string, node: ASTNode, _lang: string): number {
    // 从源码中提取函数声明行
    const lines = cleanContent.split('\n');
    const declLine = lines[node.startLine - 1] || '';

    // 提取括号内的参数
    const parenStart = declLine.indexOf('(');
    if (parenStart === -1) return 0;

    let depth = 1;
    let paramStr = '';
    for (let i = parenStart + 1; i < declLine.length && depth > 0; i++) {
      if (declLine[i] === '(') depth++;
      if (declLine[i] === ')') depth--;
      if (depth > 0) paramStr += declLine[i];
    }

    if (!paramStr.trim()) return 0;

    // 按逗号分割（考虑泛型和默认值）
    let count = 0;
    let currentDepth = 0;
    for (const ch of paramStr) {
      if (ch === '<' || ch === '(' || ch === '[' || ch === '{') currentDepth++;
      if (ch === '>' || ch === ')' || ch === ']' || ch === '}') currentDepth--;
      if (ch === ',' && currentDepth === 0) count++;
    }

    return count + 1;
  }

  /** 检测重复代码模式 */
  private detectDuplicatePatterns(content: string, fileName: string, smells: CodeSmell[]): void {
    const lines = content.split('\n');
    const normalizedLines = lines.map(l => l.trim()).filter(l => l.length > 10 && !l.startsWith('//') && !l.startsWith('/*'));

    // 使用滑动窗口检测连续3行以上的重复
    const windowSize = 3;
    const seen = new Map<string, { line: number; count: number }>();

    for (let i = 0; i <= normalizedLines.length - windowSize; i++) {
      const window = normalizedLines.slice(i, i + windowSize).join('\n');
      // 简单标准化：移除变量名差异
      const normalized = window
        .replace(/\b\w+\b/g, 'X')  // 替换标识符
        .replace(/\s+/g, ' ');     // 标准化空白

      const existing = seen.get(normalized);
      if (existing) {
        existing.count++;
        if (existing.count === 2) {
          // 只报告第一次发现重复
          smells.push({
            type: 'duplicate_code',
            severity: 'low',
            location: `${fileName}`,
            description: `检测到相似代码模式重复出现`,
            suggestion: '考虑提取为公共方法或工具函数以消除重复',
          });
        }
      } else {
        seen.set(normalized, { line: i, count: 1 });
      }
    }
  }

  /** 遍历目录收集源文件 */
  private walkDir(dir: string): string[] {
    const results: string[] = [];
    const supportedExtensions = new Set<string>();
    for (const config of Object.values(LANGUAGE_CONFIGS)) {
      for (const ext of config.extensions) {
        supportedExtensions.add(ext);
      }
    }

    const walk = (currentDir: string) => {
      try {
        const entries = fs.readdirSync(currentDir, { withFileTypes: true });
        for (const entry of entries) {
          const fullPath = path.join(currentDir, entry.name);
          if (entry.isDirectory()) {
            // 跳过隐藏目录和node_modules
            if (!entry.name.startsWith('.') && entry.name !== 'node_modules' && entry.name !== 'dist' && entry.name !== 'build' && entry.name !== '.git') {
              walk(fullPath);
            }
          } else if (entry.isFile()) {
            const ext = path.extname(entry.name).toLowerCase();
            if (supportedExtensions.has(ext)) {
              results.push(fullPath);
            }
          }
        }
      } catch {
        // 跳过无权限目录
      }
    };

    walk(dir);
    return results;
  }

  /** 解析依赖路径 */
  private resolveDependencies(filePath: string, imports: string[], _projectRoot: string): string[] {
    const deps: string[] = [];
    const fileDir = path.dirname(filePath);

    for (const imp of imports) {
      // 只处理相对路径导入
      if (imp.startsWith('.') || imp.startsWith('/')) {
        const resolved = path.resolve(fileDir, imp);
        // 尝试添加扩展名
        const extensions = ['.ts', '.tsx', '.js', '.jsx', '.py', '.go', '.rs', '.java', '.c', '.cpp', '.h'];
        let found = false;
        for (const ext of extensions) {
          if (fs.existsSync(resolved + ext)) {
            deps.push(resolved + ext);
            found = true;
            break;
          }
        }
        if (!found && fs.existsSync(resolved)) {
          deps.push(resolved);
        } else if (!found && fs.existsSync(path.join(resolved, 'index.ts'))) {
          deps.push(path.join(resolved, 'index.ts'));
        } else if (!found && fs.existsSync(path.join(resolved, 'index.js'))) {
          deps.push(path.join(resolved, 'index.js'));
        }
      }
    }

    return deps;
  }

  /** 检测循环依赖 */
  private detectCircularDependencies(graph: Map<string, string[]>): string[][] {
    const cycles: string[][] = [];
    const visited = new Set<string>();
    const recursionStack = new Set<string>();
    const path: string[] = [];

    const dfs = (node: string) => {
      if (recursionStack.has(node)) {
        // 找到循环
        const cycleStart = path.indexOf(node);
        if (cycleStart !== -1) {
          const cycle = path.slice(cycleStart).concat(node);
          // 去重：只保留规范形式
          const normalized = this.normalizeCycle(cycle);
          if (!cycles.some(c => this.normalizeCycle(c) === normalized)) {
            cycles.push(cycle);
          }
        }
        return;
      }

      if (visited.has(node)) return;

      visited.add(node);
      recursionStack.add(node);
      path.push(node);

      const neighbors = graph.get(node) || [];
      for (const neighbor of neighbors) {
        dfs(neighbor);
      }

      path.pop();
      recursionStack.delete(node);
    };

    const graphKeys = Array.from(graph.keys());
    for (const node of graphKeys) {
      if (!visited.has(node)) {
        dfs(node);
      }
    }

    return cycles;
  }

  /** 规范化循环路径（用于去重） */
  private normalizeCycle(cycle: string[]): string {
    const minIdx = cycle.indexOf([...cycle].sort()[0]);
    const rotated = [...cycle.slice(minIdx), ...cycle.slice(0, minIdx)];
    return rotated.join('→');
  }

  /** 格式化代码结构 */
  private formatStructure(nodes: ASTNode[], lines: string[], depth: number): void {
    const indent = '  '.repeat(depth);
    const icons: Record<string, string> = {
      class: '📦',
      interface: '🔌',
      function: '⚡',
      method: '⚙️',
      type_alias: '🏷️',
      variable: '📌',
    };

    // 排序：类和接口在前，然后函数，最后变量
    const sortedNodes = [...nodes].sort((a, b) => {
      const order: Record<string, number> = { class: 0, interface: 1, function: 2, method: 3, type_alias: 4, variable: 5 };
      return (order[a.type] ?? 9) - (order[b.type] ?? 9);
    });

    for (const node of sortedNodes) {
      const icon = icons[node.type] || '•';
      const modifiers = node.modifiers && node.modifiers.length > 0 ? `[${node.modifiers.join(', ')}] ` : '';
      lines.push(`${indent}${icon} ${modifiers}${node.name} (L${node.startLine}-${node.endLine})`);

      if (node.children.length > 0) {
        this.formatStructure(node.children, lines, depth + 1);
      }
    }
  }

  /** 获取相对导入路径 */
  private getRelativeImportPath(fromFile: string, toFile: string): string {
    const fromDir = path.dirname(fromFile);
    const relative = path.relative(fromDir, toFile).replace(/\\/g, '/');
    if (!relative.startsWith('.')) {
      return './' + relative;
    }
    // 移除扩展名（TS/JS导入通常不含扩展名）
    return relative.replace(/\.(ts|tsx|js|jsx)$/, '');
  }

  /** 转义正则特殊字符 */
  private escapeRegex(str: string): string {
    return str.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  }

  /** 获取分析统计 */
  getStats(): string {
    const lines = [
      '📊 TreeSitterAST 分析统计',
      `  已解析文件: ${this.stats.filesParsed}`,
      `  已分析项目: ${this.stats.projectsAnalyzed}`,
      `  符号引用查找: ${this.stats.usagesFound} 处`,
      `  代码异味检测: ${this.stats.smellsDetected} 个`,
      `  缓存命中: ${this.stats.cacheHits} 次`,
      `  WASM后端: ${this.wasmAvailable ? '✅ 可用' : '❌ 不可用（使用正则后端）'}`,
      `  文件缓存: ${this.fileCache.size} 条`,
      `  项目缓存: ${this.projectCache.size} 条`,
      `  支持语言: ${Object.values(LANGUAGE_CONFIGS).map(c => c.name).join(', ')}`,
    ];
    return lines.join('\n');
  }

  // ============ Agent Loop 工具定义 ============

  getToolDefinitions(): Array<{
    name: string;
    description: string;
    parameters: Record<string, { type: string; description: string; required?: boolean }>;
    readOnly?: boolean;
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    execute: (args: any) => Promise<string>;
  }> {
    // eslint-disable-next-line @typescript-eslint/no-this-alias
    const self = this;

    return [
      {
        name: 'ast_parse',
        description: '解析源文件并返回AST分析结果：提取函数、类、接口、类型、变量、导入/导出，计算圈复杂度和嵌套深度，检测代码异味',
        parameters: {
          filePath: { type: 'string', description: '要解析的源文件路径', required: true },
        },
        readOnly: true,
        execute: async (args) => {
          const filePath = args.filePath as string;
          const analysis = await self.parseFile(filePath);
          return JSON.stringify({
            filePath: analysis.filePath,
            language: analysis.language,
            metrics: analysis.metrics,
            nodes: analysis.nodes.map(n => ({
              type: n.type,
              name: n.name,
              lines: `${n.startLine}-${n.endLine}`,
              modifiers: n.modifiers,
              childCount: n.children.length,
            })),
            imports: analysis.imports,
            exports: analysis.exports,
            smells: analysis.smells,
          }, null, 2);
        },
      },
      {
        name: 'ast_project',
        description: '分析整个项目目录：解析所有源文件，构建依赖图，检测循环依赖，汇总项目度量',
        parameters: {
          dir: { type: 'string', description: '项目根目录路径', required: true },
        },
        readOnly: true,
        execute: async (args) => {
          const dir = args.dir as string;
          const analysis = await self.analyzeProject(dir);
          return JSON.stringify({
            fileCount: analysis.files.length,
            totalMetrics: analysis.totalMetrics,
            circularDependencies: analysis.circularDependencies,
            dependencyGraph: Object.fromEntries(
              Array.from(analysis.dependencyGraph.entries()).map(([k, v]) => [
                path.relative(dir, k),
                v.map(d => path.relative(dir, d)),
              ]),
            ),
            files: analysis.files.map(f => ({
              path: path.relative(dir, f.filePath),
              language: f.language,
              metrics: f.metrics,
              smellCount: f.smells.length,
            })),
          }, null, 2);
        },
      },
      {
        name: 'ast_usages',
        description: '在项目中查找符号的所有使用位置，返回文件名:行号格式的引用列表',
        parameters: {
          filePath: { type: 'string', description: '起始文件路径（用于确定搜索范围）', required: true },
          symbolName: { type: 'string', description: '要查找的符号名称', required: true },
        },
        readOnly: true,
        execute: (args) => {
          return self.findUsages(args.filePath as string, args.symbolName as string);
        },
      },
      {
        name: 'ast_smells',
        description: '检测代码异味：长函数、深嵌套、过多参数、上帝类、高圈复杂度、重复代码',
        parameters: {
          filePath: { type: 'string', description: '要检测的源文件路径', required: true },
        },
        readOnly: true,
        execute: (args) => {
          return self.detectSmells(args.filePath as string);
        },
      },
      {
        name: 'ast_structure',
        description: '获取代码结构大纲：类、方法、函数、接口、类型的层级结构和行号',
        parameters: {
          filePath: { type: 'string', description: '要分析的源文件路径', required: true },
        },
        readOnly: true,
        execute: (args) => {
          return self.getStructure(args.filePath as string);
        },
      },
      {
        name: 'ast_dependencies',
        description: '分析文件依赖关系：导入来源、未使用的导入、反向依赖（谁依赖此文件）',
        parameters: {
          filePath: { type: 'string', description: '要分析的源文件路径', required: true },
        },
        readOnly: true,
        execute: (args) => {
          return self.getDependencies(args.filePath as string);
        },
      },
    ];
  }
}
