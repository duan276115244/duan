/**
 * 段先生 - 代码推理与生成准确性模块 — CodeReasoningEngine
 *
 * 核心能力：
 * 1. 深度代码推理：在生成代码前先进行推理链分析，识别边界条件和约束
 * 2. 语法验证：检查常见语法错误、导入引用、类型一致性
 * 3. 逻辑验证：通过 LLM 验证代码逻辑是否匹配需求
 * 4. 改进建议：性能优化、安全最佳实践、可读性提升
 * 5. 测试用例生成：单元测试、边界覆盖
 * 6. 统计追踪：推理次数、验证通过率等
 */

import { logger } from './structured-logger.js';
import { EventBus } from './event-bus.js';
import { ModelLibrary } from './model-library.js';
import type { ToolDef } from './unified-tool-def.js';

// ============ 类型定义 ============

/** 代码推理结果 */
export interface CodeReasoningResult {
  /** 逐步推理链 */
  reasoning: string;
  /** 选定方案及原因 */
  approach: string;
  /** 识别到的边界情况 */
  edgeCases: string[];
  /** 需满足的约束条件 */
  constraints: string[];
  /** 建议的代码结构 */
  suggestedStructure: string;
  /** 置信度 0-1 */
  confidence: number;
}

/** 语法验证结果 */
export interface SyntaxVerification {
  /** 是否通过 */
  valid: boolean;
  /** 语法错误列表 */
  errors: SyntaxErrorInfo[];
  /** 警告列表 */
  warnings: string[];
  /** 语言 */
  language: string;
}

/** 语法错误详情 */
export interface SyntaxErrorInfo {
  /** 行号 */
  line?: number;
  /** 列号 */
  column?: number;
  /** 错误消息 */
  message: string;
  /** 严重程度 */
  severity: 'error' | 'warning';
  /** 修复建议 */
  suggestion: string;
}

/** 逻辑验证结果 */
export interface LogicVerification {
  /** 逻辑是否正确 */
  correct: boolean;
  /** 逻辑问题列表 */
  issues: LogicIssue[];
  /** 覆盖率 0-1 */
  coverage: number;
}

/** 逻辑问题 */
export interface LogicIssue {
  /** 问题类型 */
  type: 'missing_edge_case' | 'incorrect_logic' | 'null_handling' | 'off_by_one' | 'race_condition' | 'resource_leak';
  /** 问题描述 */
  description: string;
  /** 问题位置 */
  location: string;
  /** 修复建议 */
  fix: string;
}

/** 改进建议 */
export interface ImprovementSuggestion {
  /** 类别 */
  category: 'performance' | 'security' | 'readability' | 'maintainability' | 'testing';
  /** 描述 */
  description: string;
  /** 当前代码 */
  currentCode: string;
  /** 建议代码 */
  suggestedCode: string;
  /** 影响程度 */
  impact: 'low' | 'medium' | 'high';
}

/** 测试用例 */
export interface TestCase {
  /** 用例名称 */
  name: string;
  /** 输入 */
  input: string;
  /** 期望输出 */
  expectedOutput: string;
  /** 用例类型 */
  type: 'unit' | 'integration' | 'edge_case';
}


// ============ 语言语法规则映射 ============

/** 语言常见语法规则，用于静态检查 */
interface LanguageSyntaxRules {
  /** 单行注释前缀 */
  commentPrefix: string[];
  /** 字符串定界符 */
  stringDelimiters: string[];
  /** 代码块定界符 */
  blockDelimiters: [string, string] | null;
  /** 行尾分隔符 */
  lineTerminator: string;
  /** 是否需要分号 */
  requiresSemicolon: boolean;
  /** 常见关键字 */
  keywords: string[];
  /** 类型声明关键字 */
  typeKeywords: string[];
}

const LANGUAGE_RULES: Record<string, LanguageSyntaxRules> = {
  typescript: {
    commentPrefix: ['//', '/*'],
    stringDelimiters: ["'", '"', '`'],
    blockDelimiters: ['{', '}'],
    lineTerminator: ';',
    requiresSemicolon: false,
    keywords: ['const', 'let', 'var', 'function', 'class', 'interface', 'type', 'enum', 'import', 'export', 'async', 'await', 'return', 'if', 'else', 'for', 'while', 'switch', 'case', 'try', 'catch', 'finally', 'throw', 'new', 'this', 'extends', 'implements'],
    typeKeywords: [': string', ': number', ': boolean', ': void', ': any', ': never', ': unknown', ': null', ': undefined', ': object', 'Array<', 'Record<', 'Map<', 'Set<', 'Promise<'],
  },
  javascript: {
    commentPrefix: ['//', '/*'],
    stringDelimiters: ["'", '"', '`'],
    blockDelimiters: ['{', '}'],
    lineTerminator: ';',
    requiresSemicolon: false,
    keywords: ['const', 'let', 'var', 'function', 'class', 'import', 'export', 'async', 'await', 'return', 'if', 'else', 'for', 'while', 'switch', 'case', 'try', 'catch', 'finally', 'throw', 'new', 'this', 'extends'],
    typeKeywords: [],
  },
  python: {
    commentPrefix: ['#'],
    stringDelimiters: ["'", '"', "'''", '"""'],
    blockDelimiters: null,
    lineTerminator: '\n',
    requiresSemicolon: false,
    keywords: ['def', 'class', 'import', 'from', 'return', 'if', 'elif', 'else', 'for', 'while', 'try', 'except', 'finally', 'raise', 'with', 'as', 'lambda', 'yield', 'async', 'await', 'pass', 'break', 'continue', 'global', 'nonlocal'],
    typeKeywords: [': str', ': int', ': float', ': bool', ': None', ': List[', ': Dict[', ': Tuple[', ': Optional[', ': Union[', '-> str', '-> int', '-> float', '-> bool', '-> None'],
  },
  java: {
    commentPrefix: ['//', '/*'],
    stringDelimiters: ['"'],
    blockDelimiters: ['{', '}'],
    lineTerminator: ';',
    requiresSemicolon: true,
    keywords: ['public', 'private', 'protected', 'class', 'interface', 'extends', 'implements', 'import', 'package', 'return', 'if', 'else', 'for', 'while', 'switch', 'case', 'try', 'catch', 'finally', 'throw', 'throws', 'new', 'this', 'super', 'static', 'final', 'abstract', 'void', 'int', 'long', 'double', 'float', 'boolean', 'char', 'String'],
    typeKeywords: ['int', 'long', 'double', 'float', 'boolean', 'char', 'String', 'List<', 'Map<', 'Set<', 'Optional<'],
  },
  go: {
    commentPrefix: ['//', '/*'],
    stringDelimiters: ['"', '`'],
    blockDelimiters: ['{', '}'],
    lineTerminator: '\n',
    requiresSemicolon: false,
    keywords: ['func', 'package', 'import', 'return', 'if', 'else', 'for', 'switch', 'case', 'try', 'defer', 'go', 'chan', 'select', 'range', 'type', 'struct', 'interface', 'map', 'var', 'const', 'nil', 'true', 'false'],
    typeKeywords: ['int', 'string', 'bool', 'float64', 'error', '[]byte', 'chan ', 'map['],
  },
  rust: {
    commentPrefix: ['//', '/*'],
    stringDelimiters: ['"', "'"],
    blockDelimiters: ['{', '}'],
    lineTerminator: ';',
    requiresSemicolon: true,
    keywords: ['fn', 'let', 'mut', 'pub', 'struct', 'enum', 'impl', 'trait', 'use', 'mod', 'return', 'if', 'else', 'for', 'while', 'loop', 'match', 'async', 'await', 'self', 'Self', 'super', 'crate', 'where', 'type', 'const', 'static', 'unsafe', 'extern'],
    typeKeywords: ['i32', 'u32', 'i64', 'u64', 'f64', 'bool', 'String', '&str', 'Vec<', 'Option<', 'Result<', 'Box<', 'Arc<'],
  },
  csharp: {
    commentPrefix: ['//', '/*'],
    stringDelimiters: ['"'],
    blockDelimiters: ['{', '}'],
    lineTerminator: ';',
    requiresSemicolon: true,
    keywords: ['using', 'namespace', 'class', 'interface', 'struct', 'enum', 'public', 'private', 'protected', 'internal', 'static', 'void', 'return', 'if', 'else', 'for', 'foreach', 'while', 'switch', 'case', 'try', 'catch', 'finally', 'throw', 'new', 'this', 'base', 'async', 'await', 'var', 'const', 'readonly', 'override', 'virtual', 'abstract'],
    typeKeywords: ['int', 'string', 'bool', 'double', 'float', 'long', 'byte', 'List<', 'Dictionary<', 'Task<', 'IEnumerable<'],
  },
};

// ============ 主类 ============

export class CodeReasoningEngine {
  private log = logger.child({ module: 'CodeReasoning' });
  private modelLibrary: ModelLibrary | null = null;

  // 统计数据
  private stats = {
    reasoningCount: 0,
    syntaxChecks: 0,
    logicChecks: 0,
    improvementSuggestions: 0,
    testCasesGenerated: 0,
    totalErrors: 0,
    startTime: Date.now(),
  };

  constructor(modelLibrary?: any) {
    if (modelLibrary) {
      this.modelLibrary = modelLibrary instanceof ModelLibrary
        ? modelLibrary
        : null;
    }
  }

  // ========== 核心方法 ==========

  /**
   * 深度代码推理 — 在生成代码前进行推理链分析
   * 分析任务需求、识别边界条件与约束、生成推理链
   */
  async reasonAboutCode(task: string, language: string, context?: string): Promise<CodeReasoningResult> {
    this.stats.reasoningCount++;
    const startTime = Date.now();

    this.log.info('开始代码推理', { task: task.substring(0, 100), language });

    try {
      // 尝试使用 LLM 增强推理
      if (this.modelLibrary) {
        const result = await this.llmReasonAboutCode(task, language, context);
        this.emitEvent('code.reasoning.complete', {
          task: task.substring(0, 80),
          language,
          confidence: result.confidence,
          durationMs: Date.now() - startTime,
        });
        return result;
      }

      // 降级到基于规则的推理
      const result = this.ruleBasedReasonAboutCode(task, language, context);
      this.emitEvent('code.reasoning.complete', {
        task: task.substring(0, 80),
        language,
        confidence: result.confidence,
        durationMs: Date.now() - startTime,
      });
      return result;
    } catch (error: any) {
      this.stats.totalErrors++;
      this.log.error('代码推理失败', { error: error.message });
      this.emitEvent('code.reasoning.error', { task: task.substring(0, 80), error: error.message });

      // 降级到基于规则的推理
      return this.ruleBasedReasonAboutCode(task, language, context);
    }
  }

  /**
   * 语法验证 — 检查代码中的常见语法错误
   */
  async verifySyntax(code: string, language: string): Promise<SyntaxVerification> {
    this.stats.syntaxChecks++;
    const startTime = Date.now();

    this.log.info('开始语法验证', { language, codeLength: code.length });

    const normalizedLang = this.normalizeLanguage(language);
    const errors: SyntaxErrorInfo[] = [];
    const warnings: string[] = [];

    // 1. 基本结构检查
    this.checkBasicStructure(code, normalizedLang, errors, warnings);

    // 2. 括号匹配检查
    this.checkBracketMatching(code, errors);

    // 3. 导入引用检查
    this.checkImports(code, normalizedLang, errors, warnings);

    // 4. 类型一致性检查（TypeScript / Python）
    if (normalizedLang === 'typescript' || normalizedLang === 'python') {
      this.checkTypeConsistency(code, normalizedLang, errors, warnings);
    }

    // 5. 常见语法模式检查
    this.checkCommonPatterns(code, normalizedLang, errors, warnings);

    const result: SyntaxVerification = {
      valid: errors.filter(e => e.severity === 'error').length === 0,
      errors,
      warnings,
      language: normalizedLang,
    };

    this.emitEvent('code.syntax.verified', {
      language: normalizedLang,
      valid: result.valid,
      errorCount: errors.length,
      warningCount: warnings.length,
      durationMs: Date.now() - startTime,
    });

    return result;
  }

  /**
   * 逻辑验证 — 通过 LLM 验证代码逻辑是否匹配需求
   */
  async verifyLogic(code: string, requirements: string): Promise<LogicVerification> {
    this.stats.logicChecks++;
    const startTime = Date.now();

    this.log.info('开始逻辑验证', { codeLength: code.length, requirementsLength: requirements.length });

    try {
      if (this.modelLibrary) {
        const result = await this.llmVerifyLogic(code, requirements);
        this.emitEvent('code.logic.verified', {
          correct: result.correct,
          coverage: result.coverage,
          issueCount: result.issues.length,
          durationMs: Date.now() - startTime,
        });
        return result;
      }

      // 降级到基于规则的逻辑验证
      const result = this.ruleBasedVerifyLogic(code, requirements);
      this.emitEvent('code.logic.verified', {
        correct: result.correct,
        coverage: result.coverage,
        issueCount: result.issues.length,
        durationMs: Date.now() - startTime,
      });
      return result;
    } catch (error: any) {
      this.stats.totalErrors++;
      this.log.error('逻辑验证失败', { error: error.message });
      return this.ruleBasedVerifyLogic(code, requirements);
    }
  }

  /**
   * 改进建议 — 性能优化、安全最佳实践、可读性提升
   */
  async suggestImprovements(code: string, language: string): Promise<ImprovementSuggestion[]> {
    this.stats.improvementSuggestions++;
    const startTime = Date.now();

    this.log.info('开始生成改进建议', { language, codeLength: code.length });

    try {
      if (this.modelLibrary) {
        const suggestions = await this.llmSuggestImprovements(code, language);
        this.emitEvent('code.improvement.suggested', {
          language,
          suggestionCount: suggestions.length,
          durationMs: Date.now() - startTime,
        });
        return suggestions;
      }

      // 降级到基于规则的改进建议
      const suggestions = this.ruleBasedSuggestImprovements(code, language);
      this.emitEvent('code.improvement.suggested', {
        language,
        suggestionCount: suggestions.length,
        durationMs: Date.now() - startTime,
      });
      return suggestions;
    } catch (error: any) {
      this.stats.totalErrors++;
      this.log.error('改进建议生成失败', { error: error.message });
      return this.ruleBasedSuggestImprovements(code, language);
    }
  }

  /**
   * 测试用例生成 — 单元测试、边界覆盖
   */
  async generateTestCases(code: string, language: string): Promise<TestCase[]> {
    this.stats.testCasesGenerated++;
    const startTime = Date.now();

    this.log.info('开始生成测试用例', { language, codeLength: code.length });

    try {
      if (this.modelLibrary) {
        const cases = await this.llmGenerateTestCases(code, language);
        this.emitEvent('code.testgen.complete', {
          language,
          caseCount: cases.length,
          durationMs: Date.now() - startTime,
        });
        return cases;
      }

      // 降级到基于规则的测试生成
      const cases = this.ruleBasedGenerateTestCases(code, language);
      this.emitEvent('code.testgen.complete', {
        language,
        caseCount: cases.length,
        durationMs: Date.now() - startTime,
      });
      return cases;
    } catch (error: any) {
      this.stats.totalErrors++;
      this.log.error('测试用例生成失败', { error: error.message });
      return this.ruleBasedGenerateTestCases(code, language);
    }
  }

  /**
   * 获取统计信息
   */
  getStats(): Record<string, any> {
    const uptime = Date.now() - this.stats.startTime;
    return {
      ...this.stats,
      uptimeMs: uptime,
      reasoningPerHour: this.stats.reasoningCount / (uptime / 3600000 || 1),
      errorRate: this.stats.reasoningCount + this.stats.syntaxChecks + this.stats.logicChecks > 0
        ? this.stats.totalErrors / (this.stats.reasoningCount + this.stats.syntaxChecks + this.stats.logicChecks)
        : 0,
      hasLLM: !!this.modelLibrary,
    };
  }

  // ========== Agent Loop 工具定义 ==========

  /**
   * 返回 Agent Loop 兼容的工具定义列表
   */
  getToolDefinitions(): ToolDef[] {
    return [
      {
        name: 'code_reason',
        description: '在生成代码前进行深度推理分析，识别边界条件、约束和最佳方案。建议在编写复杂代码前先调用此工具进行推理。',
        parameters: {
          task: { type: 'string', description: '需要完成的代码任务描述', required: true },
          language: { type: 'string', description: '编程语言，如 typescript、python、java 等', required: true },
          context: { type: 'string', description: '额外的上下文信息，如项目结构、已有代码等', required: false },
        },
        readOnly: true,
        execute: async (args) => {
          const result = await this.reasonAboutCode(args.task, args.language, args.context);
          return JSON.stringify(result, null, 2);
        },
      },
      {
        name: 'code_verify_syntax',
        description: '验证代码的语法正确性，检查括号匹配、导入引用、类型一致性等常见语法问题。',
        parameters: {
          code: { type: 'string', description: '需要验证的代码', required: true },
          language: { type: 'string', description: '编程语言', required: true },
        },
        readOnly: true,
        execute: async (args) => {
          const result = await this.verifySyntax(args.code, args.language);
          return JSON.stringify(result, null, 2);
        },
      },
      {
        name: 'code_verify_logic',
        description: '验证代码逻辑是否正确匹配需求，识别逻辑错误、空值处理、off-by-one 等问题。',
        parameters: {
          code: { type: 'string', description: '需要验证的代码', required: true },
          requirements: { type: 'string', description: '代码需要满足的需求描述', required: true },
        },
        readOnly: true,
        execute: async (args) => {
          const result = await this.verifyLogic(args.code, args.requirements);
          return JSON.stringify(result, null, 2);
        },
      },
      {
        name: 'code_improve',
        description: '获取代码改进建议，包括性能优化、安全最佳实践、可读性和可维护性提升。',
        parameters: {
          code: { type: 'string', description: '需要改进的代码', required: true },
          language: { type: 'string', description: '编程语言', required: true },
        },
        readOnly: true,
        execute: async (args) => {
          const suggestions = await this.suggestImprovements(args.code, args.language);
          return JSON.stringify(suggestions, null, 2);
        },
      },
      {
        name: 'code_testgen',
        description: '为代码生成测试用例，包括单元测试和边界情况覆盖。',
        parameters: {
          code: { type: 'string', description: '需要生成测试的代码', required: true },
          language: { type: 'string', description: '编程语言', required: true },
        },
        readOnly: true,
        execute: async (args) => {
          const cases = await this.generateTestCases(args.code, args.language);
          return JSON.stringify(cases, null, 2);
        },
      },
    ];
  }

  // ========== LLM 增强方法 ==========

  /** 使用 LLM 进行深度代码推理 */
  private async llmReasonAboutCode(task: string, language: string, context?: string): Promise<CodeReasoningResult> {
    const prompt = `你是一个高级代码推理引擎。在生成代码之前，请对以下任务进行深度推理分析。

任务：${task}
语言：${language}
${context ? `上下文：${context}` : ''}

请用以下 JSON 格式返回分析结果：
{
  "reasoning": "逐步推理链，展示你的思考过程",
  "approach": "选择的方案及原因",
  "edgeCases": ["边界情况1", "边界情况2"],
  "constraints": ["约束条件1", "约束条件2"],
  "suggestedStructure": "建议的代码结构描述",
  "confidence": 0.0-1.0
}

要求：
1. 推理链要详细，至少包含3个步骤
2. 边界情况至少列出2个
3. 约束条件至少列出1个
4. 置信度要客观评估`;

    const response = await this.callLLM(prompt, '你是一个代码推理专家，擅长在编码前进行深度分析。');

    try {
      const jsonMatch = response.match(/\{[\s\S]*\}/);
      if (jsonMatch) {
        const parsed = JSON.parse(jsonMatch[0]);
        return {
          reasoning: parsed.reasoning || '',
          approach: parsed.approach || '',
          edgeCases: Array.isArray(parsed.edgeCases) ? parsed.edgeCases : [],
          constraints: Array.isArray(parsed.constraints) ? parsed.constraints : [],
          suggestedStructure: parsed.suggestedStructure || '',
          confidence: typeof parsed.confidence === 'number' ? Math.max(0, Math.min(1, parsed.confidence)) : 0.5,
        };
      }
    } catch {
      this.log.warn('LLM 推理结果解析失败，使用原始响应');
    }

    // 解析失败时从文本中提取信息
    return {
      reasoning: response,
      approach: 'LLM 推理结果解析失败，使用原始响应作为推理链',
      edgeCases: this.extractListFromText(response, /边界[情况]*[：:]\s*/i),
      constraints: this.extractListFromText(response, /约束[条件]*[：:]\s*/i),
      suggestedStructure: '',
      confidence: 0.4,
    };
  }

  /** 使用 LLM 进行逻辑验证 */
  private async llmVerifyLogic(code: string, requirements: string): Promise<LogicVerification> {
    const prompt = `你是一个代码逻辑验证专家。请验证以下代码的逻辑是否正确匹配需求。

代码：
\`\`\`
${code}
\`\`\`

需求：
${requirements}

请从以下角度验证：
1. 代码逻辑是否完整覆盖了所有需求？
2. 是否存在逻辑错误？
3. 空值/null 处理是否完善？
4. 是否存在 off-by-one 错误？
5. 是否存在竞态条件或资源泄漏？

请用以下 JSON 格式返回验证结果：
{
  "correct": true/false,
  "issues": [
    {
      "type": "missing_edge_case|incorrect_logic|null_handling|off_by_one|race_condition|resource_leak",
      "description": "问题描述",
      "location": "问题位置（如函数名或行号）",
      "fix": "修复建议"
    }
  ],
  "coverage": 0.0-1.0
}`;

    const response = await this.callLLM(prompt, '你是一个严谨的代码逻辑验证专家。');

    try {
      const jsonMatch = response.match(/\{[\s\S]*\}/);
      if (jsonMatch) {
        const parsed = JSON.parse(jsonMatch[0]);
        return {
          correct: parsed.correct ?? true,
          issues: Array.isArray(parsed.issues) ? parsed.issues.map((issue: any) => ({
            type: this.normalizeLogicIssueType(issue.type),
            description: issue.description || '',
            location: issue.location || '',
            fix: issue.fix || '',
          })) : [],
          coverage: typeof parsed.coverage === 'number' ? Math.max(0, Math.min(1, parsed.coverage)) : 0.5,
        };
      }
    } catch {
      this.log.warn('LLM 逻辑验证结果解析失败');
    }

    return {
      correct: true,
      issues: [],
      coverage: 0.5,
    };
  }

  /** 使用 LLM 生成改进建议 */
  private async llmSuggestImprovements(code: string, language: string): Promise<ImprovementSuggestion[]> {
    const prompt = `你是一个代码质量专家。请为以下 ${language} 代码提供改进建议。

代码：
\`\`\`${language}
${code}
\`\`\`

请从以下维度分析：
1. 性能优化机会
2. 安全最佳实践
3. 可读性改进
4. 可维护性提升
5. 测试覆盖建议

请用以下 JSON 格式返回建议列表：
[
  {
    "category": "performance|security|readability|maintainability|testing",
    "description": "改进描述",
    "currentCode": "当前代码片段",
    "suggestedCode": "建议的改进代码",
    "impact": "low|medium|high"
  }
]`;

    const response = await this.callLLM(prompt, '你是一个代码质量改进专家。');

    try {
      const jsonMatch = response.match(/\[[\s\S]*\]/);
      if (jsonMatch) {
        const parsed = JSON.parse(jsonMatch[0]);
        if (Array.isArray(parsed)) {
          return parsed.map((item: any) => ({
            category: this.normalizeCategory(item.category),
            description: item.description || '',
            currentCode: item.currentCode || '',
            suggestedCode: item.suggestedCode || '',
            impact: this.normalizeImpact(item.impact),
          }));
        }
      }
    } catch {
      this.log.warn('LLM 改进建议解析失败');
    }

    return [];
  }

  /** 使用 LLM 生成测试用例 */
  private async llmGenerateTestCases(code: string, language: string): Promise<TestCase[]> {
    const prompt = `你是一个测试工程师。请为以下 ${language} 代码生成测试用例。

代码：
\`\`\`${language}
${code}
\`\`\`

请生成以下类型的测试用例：
1. 单元测试：覆盖主要功能路径
2. 边界测试：覆盖边界条件和异常情况

请用以下 JSON 格式返回测试用例列表：
[
  {
    "name": "测试用例名称",
    "input": "输入描述",
    "expectedOutput": "期望输出描述",
    "type": "unit|integration|edge_case"
  }
]`;

    const response = await this.callLLM(prompt, '你是一个专业的测试工程师，擅长生成全面的测试用例。');

    try {
      const jsonMatch = response.match(/\[[\s\S]*\]/);
      if (jsonMatch) {
        const parsed = JSON.parse(jsonMatch[0]);
        if (Array.isArray(parsed)) {
          return parsed.map((item: any) => ({
            name: item.name || '未命名测试',
            input: item.input || '',
            expectedOutput: item.expectedOutput || '',
            type: this.normalizeTestCaseType(item.type),
          }));
        }
      }
    } catch {
      this.log.warn('LLM 测试用例解析失败');
    }

    return [];
  }

  /** 统一 LLM 调用 */
  private async callLLM(prompt: string, systemPrompt: string): Promise<string> {
    if (!this.modelLibrary) {
      throw new Error('ModelLibrary 未配置');
    }

    const response = await this.modelLibrary.call(
      [
        { role: 'system', content: systemPrompt },
        { role: 'user', content: prompt },
      ],
      { maxTokens: 4096, temperature: 0.3 }
    );

    return response.content;
  }

  // ========== 基于规则的降级方法 ==========

  /** 基于规则的代码推理（无 LLM 降级方案） */
  private ruleBasedReasonAboutCode(task: string, language: string, context?: string): CodeReasoningResult {
    const normalizedLang = this.normalizeLanguage(language);
    const rules = LANGUAGE_RULES[normalizedLang];

    // 分析任务关键词推断边界条件
    const edgeCases: string[] = [];
    const constraints: string[] = [];

    // 通用边界条件
    edgeCases.push('空输入/null/undefined 处理');
    edgeCases.push('超大输入/溢出场景');

    // 根据任务关键词推断
    if (/数组|列表|array|list|collection/i.test(task)) {
      edgeCases.push('空数组/空列表');
      edgeCases.push('单元素数组');
      edgeCases.push('重复元素');
    }
    if (/排序|sort/i.test(task)) {
      edgeCases.push('已排序输入');
      edgeCases.push('逆序输入');
      edgeCases.push('包含相同元素的输入');
      constraints.push('排序稳定性要求');
    }
    if (/搜索|查找|search|find/i.test(task)) {
      edgeCases.push('目标不存在');
      edgeCases.push('多个匹配结果');
    }
    if (/文件|file|io|读写/i.test(task)) {
      edgeCases.push('文件不存在');
      edgeCases.push('权限不足');
      edgeCases.push('磁盘空间不足');
      constraints.push('资源释放保证');
    }
    if (/网络|http|api|请求/i.test(task)) {
      edgeCases.push('网络超时');
      edgeCases.push('服务端错误响应');
      edgeCases.push('重试场景');
      constraints.push('请求幂等性');
    }
    if (/并发|异步|async|concurrent|parallel/i.test(task)) {
      edgeCases.push('竞态条件');
      edgeCases.push('死锁场景');
      constraints.push('线程安全');
    }
    if (/递归|recursion/i.test(task)) {
      edgeCases.push('栈溢出/递归深度过大');
      constraints.push('递归终止条件');
    }
    if (/字符串|string|文本/i.test(task)) {
      edgeCases.push('空字符串');
      edgeCases.push('特殊字符/Unicode');
      edgeCases.push('超长字符串');
    }
    if (/数字|数值|number|计算|calc/i.test(task)) {
      edgeCases.push('零值/除零');
      edgeCases.push('数值溢出');
      edgeCases.push('浮点精度');
    }

    // 语言特定约束
    if (normalizedLang === 'typescript') {
      constraints.push('类型安全：避免 any 类型');
      constraints.push('严格空值检查');
    } else if (normalizedLang === 'python') {
      constraints.push('类型注解完整性');
    } else if (normalizedLang === 'go') {
      constraints.push('错误处理：不忽略 error 返回值');
    } else if (normalizedLang === 'rust') {
      constraints.push('所有权与借用规则');
      constraints.push('生命周期标注');
    } else if (normalizedLang === 'java') {
      constraints.push('空指针防护');
      constraints.push('资源 try-with-resources');
    }

    // 构建推理链
    const reasoningSteps = [
      `1. 分析任务需求：${task}`,
      `2. 目标语言：${normalizedLang}，需遵循其语法和惯用模式`,
      `3. 识别边界条件：${edgeCases.join('、')}`,
      `4. 确认约束条件：${constraints.join('、')}`,
      `5. 选择实现方案：基于任务复杂度和语言特性选择最合适的方案`,
    ];

    return {
      reasoning: reasoningSteps.join('\n'),
      approach: `基于规则分析：针对 ${normalizedLang} 语言的 ${task} 任务，采用直接实现方案，重点关注边界条件处理和约束满足`,
      edgeCases,
      constraints,
      suggestedStructure: this.generateSuggestedStructure(task, normalizedLang),
      confidence: 0.5,
    };
  }

  /** 基于规则的逻辑验证 */
  private ruleBasedVerifyLogic(code: string, requirements: string): LogicVerification {
    const issues: LogicIssue[] = [];
    let coverage = 0.7; // 基础覆盖率

    // 检查空值处理
    if (!/null|undefined|nil|None|nullish|optional/i.test(code) && /参数|输入|input|param|argument/i.test(requirements)) {
      issues.push({
        type: 'null_handling',
        description: '代码未显式处理空值/null/undefined 情况',
        location: '函数入口',
        fix: '添加空值检查，如 if (param === null) 或 Optional 类型',
      });
      coverage -= 0.1;
    }

    // 检查错误处理
    if (!/try|catch|except|error|throw|raise|Result/i.test(code) && /文件|网络|io|数据库|database/i.test(requirements)) {
      issues.push({
        type: 'missing_edge_case',
        description: '涉及 I/O 操作但缺少错误处理',
        location: 'I/O 操作区域',
        fix: '添加 try-catch 或错误处理逻辑',
      });
      coverage -= 0.1;
    }

    // 检查循环边界
    const loopMatches = code.match(/for\s*\(|while\s*\(|\.forEach\(|\.map\(|\.filter\(/g);
    if (loopMatches && loopMatches.length > 0) {
      if (!/length|size|count|\.length|\.size|\.count/i.test(code)) {
        issues.push({
          type: 'off_by_one',
          description: '循环可能存在 off-by-one 错误，未检查边界',
          location: '循环区域',
          fix: '确认循环终止条件，检查 < vs <= 的使用',
        });
        coverage -= 0.05;
      }
    }

    // 检查资源释放
    if (/open|connect|create|alloc|new\s+\w+Stream|new\s+\w+Connection/i.test(code)) {
      if (!/close|dispose|free|release|finally|using|with\s+|try.*finally/i.test(code)) {
        issues.push({
          type: 'resource_leak',
          description: '创建了资源但未确保释放',
          location: '资源创建区域',
          fix: '使用 try-finally、using 语句或 with 上下文管理器确保资源释放',
        });
        coverage -= 0.1;
      }
    }

    // 检查竞态条件
    if (/async|await|Promise|thread|goroutine|go\s+func/i.test(code)) {
      if (!/lock|mutex|sync|atomic|concurrent|semaphore/i.test(code)) {
        issues.push({
          type: 'race_condition',
          description: '异步/并发代码未使用同步机制',
          location: '并发操作区域',
          fix: '添加锁、原子操作或其他同步机制',
        });
        coverage -= 0.1;
      }
    }

    // 检查需求关键词覆盖
    const requirementKeywords = requirements.split(/[,，、\s]+/).filter(kw => kw.length > 2);
    let coveredCount = 0;
    for (const keyword of requirementKeywords) {
      if (code.toLowerCase().includes(keyword.toLowerCase())) {
        coveredCount++;
      }
    }
    if (requirementKeywords.length > 0) {
      const keywordCoverage = coveredCount / requirementKeywords.length;
      coverage = Math.min(coverage, 0.3 + keywordCoverage * 0.7);
    }

    return {
      correct: issues.length === 0,
      issues,
      coverage: Math.max(0, Math.min(1, coverage)),
    };
  }

  /** 基于规则的改进建议 */
  private ruleBasedSuggestImprovements(code: string, language: string): ImprovementSuggestion[] {
    const suggestions: ImprovementSuggestion[] = [];
    const normalizedLang = this.normalizeLanguage(language);

    // 性能改进
    if (/for\s*\(.*await|for.*of.*await|\.forEach.*async|\.map.*async/i.test(code)) {
      suggestions.push({
        category: 'performance',
        description: '在循环中使用 await 会导致串行执行，考虑使用 Promise.all 并行化',
        currentCode: code.match(/for\s*\(.*await[\s\S]{0,80}/)?.[0] || '',
        suggestedCode: 'await Promise.all(items.map(async (item) => { ... }))',
        impact: 'high',
      });
    }

    if (/\.filter\(.*\.map\(|\.map\(.*\.filter\(/i.test(code)) {
      suggestions.push({
        category: 'performance',
        description: '链式 filter+map 会遍历两次，考虑使用 reduce 合并为一次遍历',
        currentCode: code.match(/\.filter\([\s\S]{0,60}\.map\(/)?.[0] || '',
        suggestedCode: '.reduce((acc, item) => { if (condition) acc.push(transform(item)); return acc; }, [])',
        impact: 'medium',
      });
    }

    // 安全改进
    if (/eval\(|Function\(|exec\(|innerHTML|dangerouslySetInnerHTML/i.test(code)) {
      const match = code.match(/(eval|Function|exec|innerHTML|dangerouslySetInnerHTML)\s*\(/)?.[0] || '';
      suggestions.push({
        category: 'security',
        description: '检测到潜在的不安全代码执行，可能导致代码注入漏洞',
        currentCode: match,
        suggestedCode: '使用安全的替代方案，如 JSON.parse、textContent 或参数化查询',
        impact: 'high',
      });
    }

    if (/password|secret|token|api[_-]?key/i.test(code) && !/process\.env|config|vault/i.test(code)) {
      suggestions.push({
        category: 'security',
        description: '检测到硬编码的敏感信息，应使用环境变量或密钥管理服务',
        currentCode: code.match(/(password|secret|token|api[_-]?key)\s*[:=]\s*['"][^'"]+['"]/i)?.[0] || '',
        suggestedCode: '使用 process.env.SECRET_NAME 或密钥管理服务获取敏感信息',
        impact: 'high',
      });
    }

    // 可读性改进
    if (code.includes('catch') && /catch\s*\(\s*\w*\s*\)\s*\{\s*\}/i.test(code)) {
      suggestions.push({
        category: 'readability',
        description: '空的 catch 块会吞掉错误，建议至少记录日志',
        currentCode: 'catch (err: any) { }',
        suggestedCode: 'catch (err: any) { console.error(err); /* 或 logger.error(err) */ }',
        impact: 'medium',
      });
    }

    const lines = code.split('\n');
    for (const line of lines) {
      if (line.length > 120) {
        suggestions.push({
          category: 'readability',
          description: '代码行过长（超过120字符），建议拆分',
          currentCode: line.substring(0, 80) + '...',
          suggestedCode: '将长行拆分为多行，使用换行和缩进提高可读性',
          impact: 'low',
        });
        break; // 只提示一次
      }
    }

    // 可维护性改进
    if (normalizedLang === 'typescript' && /:\s*any\b/i.test(code)) {
      suggestions.push({
        category: 'maintainability',
        description: '使用 any 类型会绕过 TypeScript 类型检查，建议使用更具体的类型',
        currentCode: ': any',
        suggestedCode: '使用具体类型、泛型或 unknown 替代 any',
        impact: 'medium',
      });
    }

    const functionMatch = code.match(/function\s+\w+\s*\([^)]*\)\s*\{/g);
    if (functionMatch) {
      for (const func of functionMatch) {
        const funcStart = code.indexOf(func);
        const funcBody = this.extractFunctionBody(code, funcStart);
        if (funcBody && funcBody.split('\n').length > 50) {
          suggestions.push({
            category: 'maintainability',
            description: '函数体过长（超过50行），建议拆分为更小的函数',
            currentCode: func.substring(0, 60) + '...',
            suggestedCode: '将函数拆分为多个职责单一的小函数',
            impact: 'medium',
          });
          break; // 只提示一次
        }
      }
    }

    // 测试建议
    if (!/test|spec|describe|it\(|expect/i.test(code)) {
      suggestions.push({
        category: 'testing',
        description: '代码缺少测试覆盖，建议添加单元测试',
        currentCode: '',
        suggestedCode: `为关键函数添加 ${normalizedLang === 'python' ? 'pytest' : normalizedLang === 'go' ? '_test.go' : 'Jest/Vitest'} 测试用例`,
        impact: 'high',
      });
    }

    return suggestions;
  }

  /** 基于规则的测试用例生成 */
  private ruleBasedGenerateTestCases(code: string, language: string): TestCase[] {
    const cases: TestCase[] = [];
    const normalizedLang = this.normalizeLanguage(language);

    // 提取函数名
    const funcNames = this.extractFunctionNames(code, normalizedLang);

    for (const funcName of funcNames) {
      // 基本功能测试
      cases.push({
        name: `${funcName} - 正常输入`,
        input: '有效的标准输入',
        expectedOutput: '符合预期的正确输出',
        type: 'unit',
      });

      // 空值测试
      cases.push({
        name: `${funcName} - 空值/null 输入`,
        input: 'null / undefined / None',
        expectedOutput: '优雅处理或抛出明确错误',
        type: 'edge_case',
      });

      // 边界值测试
      cases.push({
        name: `${funcName} - 边界值输入`,
        input: '0、空字符串、空数组、最大值等边界值',
        expectedOutput: '正确处理边界情况',
        type: 'edge_case',
      });
    }

    // 如果没有提取到函数名，生成通用测试
    if (funcNames.length === 0) {
      cases.push({
        name: '模块导入测试',
        input: 'import/require 模块',
        expectedOutput: '模块成功加载，无报错',
        type: 'unit',
      });
      cases.push({
        name: '基本功能验证',
        input: '标准使用场景',
        expectedOutput: '功能正常工作',
        type: 'integration',
      });
    }

    return cases;
  }

  // ========== 语法检查辅助方法 ==========

  /** 检查基本代码结构 */
  private checkBasicStructure(code: string, language: string, errors: SyntaxErrorInfo[], warnings: string[]): void {
    const lines = code.split('\n');

    // 检查空代码
    if (code.trim().length === 0) {
      errors.push({
        line: 1,
        message: '代码为空',
        severity: 'error',
        suggestion: '请提供需要验证的代码',
      });
      return;
    }

    // 检查未闭合的多行注释
    const openCommentCount = (code.match(/\/\*/g) || []).length;
    const closeCommentCount = (code.match(/\*\//g) || []).length;
    if (openCommentCount > closeCommentCount) {
      errors.push({
        message: '存在未闭合的多行注释 /*',
        severity: 'error',
        suggestion: '添加对应的 */ 关闭注释',
      });
    }

    // 检查未闭合的模板字符串（TypeScript/JavaScript）
    if (language === 'typescript' || language === 'javascript') {
      const backtickCount = (code.match(/`/g) || []).length;
      if (backtickCount % 2 !== 0) {
        errors.push({
          message: '存在未闭合的模板字符串',
          severity: 'error',
          suggestion: '检查反引号 ` 是否成对出现',
        });
      }
    }

    // 检查 Python 缩进一致性
    if (language === 'python') {
      let hasTab = false;
      let hasSpace = false;
      for (const line of lines) {
        const leadingWhitespace = line.match(/^(\s+)/)?.[1] || '';
        if (leadingWhitespace.includes('\t')) hasTab = true;
        if (leadingWhitespace.includes(' ')) hasSpace = true;
      }
      if (hasTab && hasSpace) {
        warnings.push('Python 代码中混用了 Tab 和空格缩进，建议统一使用4空格缩进');
      }
    }
  }

  /** 检查括号匹配 */
  private checkBracketMatching(code: string, errors: SyntaxErrorInfo[]): void {
    const pairs: Array<[string, string]> = [['(', ')'], ['{', '}'], ['[', ']']];
    const lines = code.split('\n');

    for (const [open, close] of pairs) {
      const stack: Array<{ char: string; line: number }> = [];
      let inString = false;
      let stringChar = '';

      for (let lineIdx = 0; lineIdx < lines.length; lineIdx++) {
        const line = lines[lineIdx];
        for (let col = 0; col < line.length; col++) {
          const ch = line[col];

          // 简单的字符串检测（不考虑转义）
          if ((ch === '"' || ch === "'" || ch === '`') && (col === 0 || line[col - 1] !== '\\')) {
            if (!inString) {
              inString = true;
              stringChar = ch;
            } else if (ch === stringChar) {
              inString = false;
              stringChar = '';
            }
          }

          if (inString) continue;

          if (ch === open) {
            stack.push({ char: open, line: lineIdx + 1 });
          } else if (ch === close) {
            if (stack.length === 0) {
              errors.push({
                line: lineIdx + 1,
                column: col + 1,
                message: `多余的闭合符号 '${close}'`,
                severity: 'error',
                suggestion: `移除多余的 '${close}' 或检查是否缺少对应的 '${open}'`,
              });
            } else {
              stack.pop();
            }
          }
        }
      }

      // 检查未闭合的括号
      for (const unmatched of stack) {
        errors.push({
          line: unmatched.line,
          message: `未闭合的 '${open}'`,
          severity: 'error',
          suggestion: `添加对应的 '${close}' 关闭符号`,
        });
      }
    }
  }

  /** 检查导入引用 */
  private checkImports(code: string, language: string, errors: SyntaxErrorInfo[], warnings: string[]): void {
    const lines = code.split('\n');

    if (language === 'typescript' || language === 'javascript') {
      // 检查 import 语句
      const importRegex = /import\s+(?:(?:\{[^}]*\}|\*\s+as\s+\w+|\w+)\s+from\s+)?['"]([^'"]+)['"]/g;
      const importedNames = new Set<string>();
      let match;

      for (let lineIdx = 0; lineIdx < lines.length; lineIdx++) {
        const line = lines[lineIdx];
        importRegex.lastIndex = 0;
        while ((match = importRegex.exec(line)) !== null) {
          const source = match[1];
          // 检查自引用
          if (source.startsWith('.')) {
            // 相对路径导入，仅做基本检查
          }
        }

        // 提取导入的名称
        const namedImportMatch = line.match(/import\s+\{([^}]+)\}\s+from/);
        if (namedImportMatch) {
          const names = namedImportMatch[1].split(',').map(n => n.trim().split(/\s+as\s+/).pop()?.trim()).filter(Boolean);
          names?.forEach(n => importedNames.add(n!));
        }

        const defaultImportMatch = line.match(/import\s+(\w+)\s+from/);
        if (defaultImportMatch) {
          importedNames.add(defaultImportMatch[1]);
        }

        const starImportMatch = line.match(/import\s+\*\s+as\s+(\w+)\s+from/);
        if (starImportMatch) {
          importedNames.add(starImportMatch[1]);
        }
      }

      // 检查未使用的导入（简单检查）
      const codeWithoutImports = lines.filter(l => !l.trim().startsWith('import')).join('\n');
      for (const name of Array.from(importedNames)) {
        // 排除类型导入（TypeScript type-only imports）
        if (!codeWithoutImports.includes(name)) {
          warnings.push(`导入 '${name}' 可能未被使用`);
        }
      }
    } else if (language === 'python') {
      // 检查 Python import
      const pythonImportRegex = /(?:from\s+(\w[\w.]*)\s+)?import\s+([\w.*, ]+)/g;
      const importedNames = new Set<string>();
      let match;

      for (const line of lines) {
        pythonImportRegex.lastIndex = 0;
        while ((match = pythonImportRegex.exec(line)) !== null) {
          const names = match[2].split(',').map(n => n.trim().split(/\s+as\s+/).pop()?.trim()).filter(Boolean);
          names?.forEach(n => importedNames.add(n!));
        }
      }

      const codeWithoutImports = lines.filter(l => !l.trim().startsWith('import') && !l.trim().startsWith('from')).join('\n');
      for (const name of Array.from(importedNames)) {
        if (name && name !== '*' && !codeWithoutImports.includes(name)) {
          warnings.push(`导入 '${name}' 可能未被使用`);
        }
      }
    } else if (language === 'go') {
      // 检查 Go import
      const goImportRegex = /import\s+(?:\([\s\S]*?\)|"([^"]+)")/g;
      let match;
      while ((match = goImportRegex.exec(code)) !== null) {
        // Go 的导入检查比较复杂，这里只做基本检查
      }
    }
  }

  /** 检查类型一致性（TypeScript / Python） */
  private checkTypeConsistency(code: string, language: string, errors: SyntaxErrorInfo[], warnings: string[]): void {
    if (language === 'typescript') {
      // 检查 any 类型的使用
      const anyRegex = /:\s*any\b/g;
      let match;
      while ((match = anyRegex.exec(code)) !== null) {
        const lineNum = code.substring(0, match.index).split('\n').length;
        warnings.push(`第 ${lineNum} 行使用了 any 类型，建议使用更具体的类型`);
      }

      // 检查类型断言（as）的使用
      const asRegex = /\bas\s+\w+/g;
      while ((match = asRegex.exec(code)) !== null) {
        const lineNum = code.substring(0, match.index).split('\n').length;
        warnings.push(`第 ${lineNum} 行使用了类型断言 '${match[0]}'，可能隐藏类型错误`);
      }

      // 检查非空断言 (!) 的使用
      const nonNullRegex = /\w+!/g;
      while ((match = nonNullRegex.exec(code)) !== null) {
        const lineNum = code.substring(0, match.index).split('\n').length;
        warnings.push(`第 ${lineNum} 行使用了非空断言 '${match[0]}'，建议使用可选链或空值检查`);
      }
    } else if (language === 'python') {
      // 检查 Python 类型注解
      const lines = code.split('\n');
      for (let i = 0; i < lines.length; i++) {
        const line = lines[i];
        // 检查函数定义是否缺少返回类型注解
        const funcMatch = line.match(/^def\s+(\w+)\s*\([^)]*\)\s*:/);
        if (funcMatch && !line.includes('->')) {
          warnings.push(`第 ${i + 1} 行函数 '${funcMatch[1]}' 缺少返回类型注解`);
        }
      }
    }
  }

  /** 检查常见语法模式问题 */
  private checkCommonPatterns(code: string, language: string, errors: SyntaxErrorInfo[], warnings: string[]): void {
    const lines = code.split('\n');

    // 检查赋值与比较混淆
    if (language === 'typescript' || language === 'javascript') {
      const assignInIfRegex = /if\s*\([^)]*(?<!=|!|<|>)=(?!=)[^)]*\)/g;
      let match;
      while ((match = assignInIfRegex.exec(code)) !== null) {
        const lineNum = code.substring(0, match.index).split('\n').length;
        warnings.push(`第 ${lineNum} 行 if 语句中可能存在赋值与比较混淆，建议使用 === 代替 =`);
      }
    }

    // 检查 console.log 遗留
    if (/console\.log|print\(/i.test(code)) {
      const logCount = (code.match(/console\.log|print\(/g) || []).length;
      if (logCount > 3) {
        warnings.push(`代码中包含 ${logCount} 处 console.log/print 语句，建议在发布前清理`);
      }
    }

    // 检查 TODO/FIXME/HACK 标记
    const todoCount = (code.match(/TODO|FIXME|HACK|XXX/i) || []).length;
    if (todoCount > 0) {
      warnings.push(`代码中包含 ${todoCount} 处 TODO/FIXME/HACK 标记，建议及时处理`);
    }

    // 检查过长的函数
    if (language !== 'python') {
      let braceDepth = 0;
      let funcStartLine = -1;
      for (let i = 0; i < lines.length; i++) {
        const line = lines[i];
        if (/function\s+\w+|=>\s*\{|:\s*function/.test(line)) {
          funcStartLine = i + 1;
        }
        braceDepth += (line.match(/\{/g) || []).length;
        braceDepth -= (line.match(/\}/g) || []).length;
        if (braceDepth === 0 && funcStartLine > 0) {
          const funcLength = i + 1 - funcStartLine;
          if (funcLength > 50) {
            warnings.push(`第 ${funcStartLine} 行开始的函数超过 ${funcLength} 行，建议拆分`);
          }
          funcStartLine = -1;
        }
      }
    }
  }

  // ========== 辅助方法 ==========

  /** 标准化语言名称 */
  private normalizeLanguage(language: string): string {
    const lower = language.toLowerCase().trim();
    const aliases: Record<string, string> = {
      'ts': 'typescript',
      'js': 'javascript',
      'py': 'python',
      'cs': 'csharp',
      'c#': 'csharp',
      'golang': 'go',
      'rs': 'rust',
      'rb': 'ruby',
      'kt': 'kotlin',
    };
    return aliases[lower] || lower;
  }

  /** 标准化逻辑问题类型 */
  private normalizeLogicIssueType(type: string): LogicIssue['type'] {
    const validTypes: LogicIssue['type'][] = ['missing_edge_case', 'incorrect_logic', 'null_handling', 'off_by_one', 'race_condition', 'resource_leak'];
    const normalized = type?.toLowerCase().replace(/\s+/g, '_');
    if (normalized && validTypes.includes(normalized as LogicIssue['type'])) {
      return normalized as LogicIssue['type'];
    }
    // 模糊匹配
    if (/edge|boundary|边界/i.test(type)) return 'missing_edge_case';
    if (/logic|incorrect|逻辑/i.test(type)) return 'incorrect_logic';
    if (/null|undefined|nil|none|空/i.test(type)) return 'null_handling';
    if (/off.?by.?one|off/i.test(type)) return 'off_by_one';
    if (/race|竞态|并发/i.test(type)) return 'race_condition';
    if (/leak|resource|泄漏/i.test(type)) return 'resource_leak';
    return 'incorrect_logic';
  }

  /** 标准化改进类别 */
  private normalizeCategory(category: string): ImprovementSuggestion['category'] {
    const valid: ImprovementSuggestion['category'][] = ['performance', 'security', 'readability', 'maintainability', 'testing'];
    const lower = category?.toLowerCase();
    if (lower && valid.includes(lower as ImprovementSuggestion['category'])) {
      return lower as ImprovementSuggestion['category'];
    }
    if (/性能|perf/i.test(category)) return 'performance';
    if (/安全|sec/i.test(category)) return 'security';
    if (/可读|read/i.test(category)) return 'readability';
    if (/维护|maint/i.test(category)) return 'maintainability';
    if (/测试|test/i.test(category)) return 'testing';
    return 'readability';
  }

  /** 标准化影响程度 */
  private normalizeImpact(impact: string): ImprovementSuggestion['impact'] {
    const lower = impact?.toLowerCase();
    if (lower === 'low' || lower === '低') return 'low';
    if (lower === 'high' || lower === '高') return 'high';
    return 'medium';
  }

  /** 标准化测试用例类型 */
  private normalizeTestCaseType(type: string): TestCase['type'] {
    const lower = type?.toLowerCase();
    if (lower === 'unit' || lower === '单元') return 'unit';
    if (lower === 'integration' || lower === '集成') return 'integration';
    if (lower === 'edge_case' || lower === 'edge' || lower === '边界') return 'edge_case';
    return 'unit';
  }

  /** 从文本中提取列表 */
  private extractListFromText(text: string, pattern: RegExp): string[] {
    const match = text.match(pattern);
    if (!match) return [];
    const startIndex = match.index! + match[0].length;
    const remaining = text.substring(startIndex);
    const items = remaining.split(/[,，、\n]/).map(s => s.trim()).filter(s => s.length > 0 && s.length < 100);
    return items.slice(0, 10);
  }

  /** 生成建议的代码结构 */
  private generateSuggestedStructure(task: string, language: string): string {
    const structures: Record<string, string> = {
      typescript: `// 1. 类型定义\n// 2. 主函数实现\n// 3. 辅助函数\n// 4. 导出`,
      javascript: `// 1. 常量定义\n// 2. 主函数实现\n// 3. 辅助函数\n// 4. 导出`,
      python: `# 1. 导入\n# 2. 常量/类型定义\n# 3. 主函数实现\n# 4. 辅助函数\n# 5. if __name__ == '__main__'`,
      java: `// 1. 包声明\n// 2. 导入\n// 3. 类定义\n// 4. 字段\n// 5. 构造函数\n// 6. 公有方法\n// 7. 私有方法`,
      go: `// 1. 包声明\n// 2. 导入\n// 3. 类型定义\n// 4. 主函数\n// 5. 辅助函数`,
      rust: `// 1. use 声明\n// 2. 结构体/枚举定义\n// 3. impl 块\n// 4. 函数实现\n// 5. 测试模块`,
      csharp: `// 1. using 声明\n// 2. 命名空间\n// 3. 类定义\n// 4. 属性\n// 5. 构造函数\n// 6. 方法`,
    };

    return structures[language] || `// 1. 导入/依赖\n// 2. 主逻辑实现\n// 3. 辅助函数\n// 4. 导出`;
  }

  /** 提取函数名 */
  private extractFunctionNames(code: string, language: string): string[] {
    const names: string[] = [];

    const patterns: Record<string, RegExp> = {
      typescript: /(?:export\s+)?(?:async\s+)?function\s+(\w+)|(?:export\s+)?(?:const|let)\s+(\w+)\s*=\s*(?:async\s*)?\(/g,
      javascript: /(?:export\s+)?(?:async\s+)?function\s+(\w+)|(?:export\s+)?(?:const|let)\s+(\w+)\s*=\s*(?:async\s*)?\(/g,
      python: /def\s+(\w+)/g,
      java: /(?:public|private|protected)?\s*(?:static\s+)?(?:\w+(?:<[^>]+>)?)\s+(\w+)\s*\(/g,
      go: /func\s+(?:\(\w+\s+\*?\w+\)\s+)?(\w+)/g,
      rust: /(?:pub\s+)?fn\s+(\w+)/g,
      csharp: /(?:public|private|protected)?\s*(?:static\s+)?(?:async\s+)?(?:\w+(?:<[^>]+>)?)\s+(\w+)\s*\(/g,
    };

    const pattern = patterns[language];
    if (!pattern) return names;

    let match;
    while ((match = pattern.exec(code)) !== null) {
      const name = match[1] || match[2];
      if (name && !names.includes(name)) {
        names.push(name);
      }
    }

    return names;
  }

  /** 提取函数体（简单实现） */
  private extractFunctionBody(code: string, startIndex: number): string | null {
    let braceCount = 0;
    let started = false;
    let body = '';

    for (let i = startIndex; i < code.length; i++) {
      const ch = code[i];
      if (ch === '{') {
        braceCount++;
        started = true;
      } else if (ch === '}') {
        braceCount--;
      }
      if (started) {
        body += ch;
      }
      if (started && braceCount === 0) {
        return body;
      }
    }

    return null;
  }

  /** 发射事件 */
  private emitEvent(type: string, data: Record<string, any>): void {
    try {
      EventBus.getInstance().emitSync(type, {
        ...data,
        source: 'CodeReasoning',
        timestamp: Date.now(),
      });
    } catch {
      // 事件发射失败不影响主流程
    }
  }
}
