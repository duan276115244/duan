/**
 * 代码质量引擎 — CodeQualityEngine
 *
 * 生产级代码质量分析系统：
 * - 词法/正则级语法分析（注意：当前为基于正则的启发式分析，
 *   无法可靠处理字符串字面量、注释、模板字符串中的伪匹配，
 *   例如注释里的 eval、字符串中的 SQL 文本；
 *   TODO: 引入真正的语法解析器以实现 AST 级别分析，
 *   推荐 @typescript-eslint/parser、Babel 或 tree-sitter）
 * - 多语言风格合规检查（PEP8 / Airbnb / Google / gofmt）
 * - 安全漏洞扫描（15+ 种模式）
 * - 性能分析（N+1 查询、内存泄漏、低效循环等）
 * - 复杂度指标（圈复杂度、认知复杂度、Halstead 等）
 * - 自动修复建议与代码格式化
 */

import { logger } from './structured-logger.js';
import type { EventBus } from './event-bus.js';

// ============ 类型定义 ============

export interface CodeAnalysisResult {
  filePath: string;
  language: string;
  quality: QualityScore;

  issues: CodeIssue[];
  suggestions: CodeSuggestion[];
  metrics: CodeMetrics;
  styleCompliance: StyleCompliance;
}

export interface QualityScore {
  overall: number;
  readability: number;
  maintainability: number;
  security: number;
  performance: number;
  correctness: number;
}

export interface CodeIssue {
  line: number;
  column?: number;
  severity: 'error' | 'warning' | 'info';
  category: 'syntax' | 'style' | 'security' | 'performance' | 'logic' | 'complexity';
  message: string;
  rule: string;
  fix?: string;
}

export interface CodeSuggestion {
  type: 'refactor' | 'optimize' | 'simplify' | 'modernize' | 'secure';
  description: string;
  original?: string;
  suggested?: string;
  impact: 'low' | 'medium' | 'high';
  effort: 'low' | 'medium' | 'high';
}

export interface CodeMetrics {
  linesOfCode: number;
  cyclomaticComplexity: number;
  cognitiveComplexity: number;
  maintainabilityIndex: number;
  halsteadVolume?: number;
  dependencyCount: number;
  functionCount: number;
  classCount: number;
  commentRatio: number;
  duplicateRatio: number;
}

export interface StyleCompliance {
  standard: string;
  compliance: number;
  violations: Array<{ rule: string; count: number; examples: string[] }>;
}

// ============ 安全模式定义 ============

interface SecurityPattern {
  rule: string;
  pattern: RegExp;
  severity: 'error' | 'warning' | 'info';
  message: string;
  languages: string[];
  fix?: string;
}

const SECURITY_PATTERNS: SecurityPattern[] = [
  {
    rule: 'no-eval',
    pattern: /\beval\s*\(/g,
    severity: 'error',
    message: '使用 eval() 存在代码注入风险，请使用更安全的替代方案',
    languages: ['javascript', 'typescript', 'python'],
    fix: '使用 JSON.parse() 解析 JSON，或使用 Function 构造器替代',
  },
  {
    rule: 'no-innerhtml',
    pattern: /\.innerHTML\s*=/g,
    severity: 'error',
    message: 'innerHTML 赋值存在 XSS 攻击风险，请使用 textContent 或 DOMPurify',
    languages: ['javascript', 'typescript'],
    fix: '使用 element.textContent 或 DOMPurify.sanitize()',
  },
  {
    rule: 'no-sql-concat',
    pattern: /['"`]\s*(SELECT|INSERT|UPDATE|DELETE|DROP|ALTER)\s+.*['"`]\s*\+|['"`]\s*\+\s*.*\b(SELECT|INSERT|UPDATE|DELETE|DROP|ALTER)\b/gi,
    severity: 'error',
    message: 'SQL 查询使用字符串拼接存在 SQL 注入风险，请使用参数化查询',
    languages: ['javascript', 'typescript', 'python', 'java', 'go'],
    fix: '使用参数化查询（prepared statements）替代字符串拼接',
  },
  {
    rule: 'no-hardcoded-api-keys',
    pattern: /['"`](sk-[a-zA-Z0-9]{20,}|ghp_[a-zA-Z0-9]{36}|AIza[a-zA-Z0-9_-]{35})['"`]/g,
    severity: 'error',
    message: '检测到硬编码的 API 密钥，请使用环境变量管理密钥',
    languages: ['javascript', 'typescript', 'python', 'java', 'go'],
    fix: '使用 process.env 或环境变量管理密钥',
  },
  {
    rule: 'no-insecure-crypto',
    pattern: /\b(md5|sha1|MD5|SHA1)\s*[.(]/g,
    severity: 'warning',
    message: '使用不安全的哈希算法（MD5/SHA1），请使用 SHA-256 或更强算法',
    languages: ['javascript', 'typescript', 'python', 'java', 'go'],
    fix: '使用 SHA-256 或 SHA-512 替代 MD5/SHA1',
  },
  {
    rule: 'no-exec-with-user-input',
    pattern: /\b(exec|execSync|spawn|execFile)\s*\([^)]*(req\.|request\.|params\.|query\.|body\.|input|userInput|user_input)/g,
    severity: 'error',
    message: '使用用户输入执行命令存在命令注入风险',
    languages: ['javascript', 'typescript', 'python'],
    fix: '对用户输入进行严格校验和转义，或使用参数化 API',
  },
  {
    rule: 'no-document-write',
    pattern: /document\.write\s*\(/g,
    severity: 'error',
    message: 'document.write() 存在 XSS 风险且影响性能，请使用 DOM API',
    languages: ['javascript', 'typescript'],
    fix: '使用 element.textContent 或 element.appendChild()',
  },
  {
    rule: 'no-cors-wildcard',
    pattern: /Access-Control-Allow-Origin['":\s]*\*|cors\s*\(\s*\)\s*\.|\bcors\b[^}]*origin\s*:\s*['"`]\*['"`]/gi,
    severity: 'warning',
    message: 'CORS 配置允许所有来源（*），存在安全风险',
    languages: ['javascript', 'typescript', 'python', 'go'],
    fix: '指定具体的允许来源域名，而非使用通配符 *',
  },
  {
    rule: 'no-hardcoded-passwords',
    pattern: /['"`](password|passwd|pwd|secret|token|apikey|api_key)\s*[:=]\s*['"`][^'"`]{3,}['"`]/gi,
    severity: 'error',
    message: '检测到硬编码的密码或密钥，请使用环境变量',
    languages: ['javascript', 'typescript', 'python', 'java', 'go'],
    fix: '使用环境变量或密钥管理服务存储敏感信息',
  },
  {
    rule: 'no-insecure-random',
    pattern: /Math\.random\s*\(\s*\)/g,
    severity: 'warning',
    message: 'Math.random() 不适用于安全场景，请使用 crypto.getRandomValues()',
    languages: ['javascript', 'typescript'],
    fix: '使用 crypto.getRandomValues() 或 crypto.randomBytes()',
  },
  {
    rule: 'no-prototype-pollution',
    pattern: /(__proto__|constructor\s*\[\s*['"`]|prototype\s*\[\s*['"`])/g,
    severity: 'error',
    message: '检测到原型链污染风险，请避免直接修改 __proto__ 或 prototype',
    languages: ['javascript', 'typescript'],
    fix: '使用 Object.create() 或 Object.assign() 替代原型链操作',
  },
  {
    rule: 'no-path-traversal',
    pattern: /\.\.\//g,
    severity: 'warning',
    message: '检测到路径遍历模式（../），请验证和规范化文件路径',
    languages: ['javascript', 'typescript', 'python', 'java', 'go'],
    fix: '使用 path.resolve() 和 path.normalize() 验证路径',
  },
  {
    rule: 'no-unvalidated-redirect',
    pattern: /(redirect|res\.redirect|response\.redirect)\s*\([^)]*(req\.|request\.|params\.|query\.|body\.)/g,
    severity: 'warning',
    message: '未验证的重定向可能导致钓鱼攻击',
    languages: ['javascript', 'typescript', 'python'],
    fix: '验证重定向目标 URL 是否在白名单中',
  },
  {
    rule: 'no-async-without-trycatch',
    pattern: /await\s+/g,
    severity: 'info',
    message: '异步操作缺少 try-catch 错误处理',
    languages: ['javascript', 'typescript'],
    fix: '在 await 调用外包裹 try-catch 或使用 .catch()',
  },
  {
    rule: 'no-console-in-prod',
    pattern: /\bconsole\.(log|debug|info|warn|error)\s*\(/g,
    severity: 'info',
    message: '生产代码中存在 console 调用，建议使用专业日志库',
    languages: ['javascript', 'typescript'],
    fix: '使用结构化日志库替代 console 调用',
  },
];

// ============ 风格规则定义 ============

interface StyleRule {
  rule: string;
  pattern: RegExp;
  message: string;
  standard: string[];
}

const STYLE_RULES: StyleRule[] = [
  // 通用规则
  {
    rule: 'no-trailing-whitespace',
    pattern: /[ \t]+$/m,
    message: '行尾存在多余空白字符',
    standard: ['PEP8', 'Airbnb', 'Google', 'Standard', 'gofmt'],
  },
  {
    rule: 'no-multiple-empty-lines',
    pattern: /\n{4,}/,
    message: '存在连续多个空行',
    standard: ['PEP8', 'Airbnb', 'Google', 'Standard', 'gofmt'],
  },
  // Python / PEP8
  {
    rule: 'pep8-line-length',
    pattern: /^(.{80,})/m,
    message: '行长度超过 79 字符（PEP8 建议）',
    standard: ['PEP8'],
  },
  {
    rule: 'pep8-indentation',
    pattern: /^ {1,3}\S|^ {5,7}\S|^ {9,11}\S/m,
    message: '缩进不是 4 个空格的倍数',
    standard: ['PEP8'],
  },
  {
    rule: 'pep8-naming-class',
    pattern: /class\s+[a-z]/,
    message: '类名应使用驼峰命名法（CamelCase）',
    standard: ['PEP8'],
  },
  {
    rule: 'pep8-naming-function',
    pattern: /def\s+[A-Z]/,
    message: '函数名应使用蛇形命名法（snake_case）',
    standard: ['PEP8'],
  },
  {
    rule: 'pep8-import-order',
    pattern: /^import\s+.{1,}\nfrom\s+/m,
    message: 'import 和 from 语句应分组排列',
    standard: ['PEP8'],
  },
  // JavaScript / TypeScript
  {
    rule: 'js-semicolons',
    pattern: /[^;{}\s]\s*$/m,
    message: '语句末尾缺少分号',
    standard: ['Airbnb'],
  },
  {
    rule: 'js-no-semicolons',
    pattern: /;\s*$/m,
    message: 'Standard 风格不使用分号',
    standard: ['Standard'],
  },
  {
    rule: 'js-single-quotes',
    pattern: /"/,
    message: '应使用单引号而非双引号',
    standard: ['Standard'],
  },
  {
    rule: 'js-double-quotes',
    pattern: /'/,
    message: '应使用双引号而非单引号',
    standard: ['Google'],
  },
  {
    rule: 'js-naming-camelcase',
    pattern: /(?:function|const|let|var)\s+[a-z]+_[a-z]/,
    message: '变量和函数名应使用驼峰命名法（camelCase）',
    standard: ['Airbnb', 'Google'],
  },
  {
    rule: 'js-default-export',
    pattern: /export\s+default\s+/,
    message: '避免使用 default export，使用 named export',
    standard: ['Airbnb'],
  },
  // Go
  {
    rule: 'go-unused-import',
    pattern: /import\s*\([^)]*\)/,
    message: '检查是否有未使用的 import',
    standard: ['gofmt'],
  },
  // Java
  {
    rule: 'java-brace-style',
    pattern: /^\s*\)\s*$/m,
    message: '左花括号不应换行（Google Java Style）',
    standard: ['Google'],
  },
];

// ============ 性能模式定义 ============

interface PerformancePattern {
  rule: string;
  pattern: RegExp;
  type: CodeSuggestion['type'];
  description: string;
  impact: CodeSuggestion['impact'];
  effort: CodeSuggestion['effort'];
  languages: string[];
}

const PERFORMANCE_PATTERNS: PerformancePattern[] = [
  {
    rule: 'n-plus-1-query',
    pattern: /for\s*\(.*await.*(?:find|query|select|fetch|get)\s*\(/gi,
    type: 'optimize',
    description: '检测到循环中的数据库查询，可能存在 N+1 查询问题，建议批量查询',
    impact: 'high',
    effort: 'medium',
    languages: ['javascript', 'typescript', 'python'],
  },
  {
    rule: 'sync-in-async',
    pattern: /(?:async\s+function|async\s+\w+\s*\(|async\s*\(\)).*(?:readFileSync|writeFileSync|execSync|existsSync)/gs,
    type: 'optimize',
    description: '异步函数中使用了同步操作，会阻塞事件循环',
    impact: 'high',
    effort: 'low',
    languages: ['javascript', 'typescript'],
  },
  {
    rule: 'memory-leak-listener',
    pattern: /\.addEventListener\s*\([^)]+\)(?![\s\S]*?\.removeEventListener)/g,
    type: 'optimize',
    description: '添加了事件监听器但未在组件销毁时移除，可能导致内存泄漏',
    impact: 'medium',
    effort: 'low',
    languages: ['javascript', 'typescript'],
  },
  {
    rule: 'nested-loops',
    pattern: /for\s*\(.*\n\s*for\s*\(/g,
    type: 'optimize',
    description: '检测到嵌套循环，时间复杂度为 O(n²)，考虑使用 Map/Set 优化',
    impact: 'medium',
    effort: 'medium',
    languages: ['javascript', 'typescript', 'python', 'java', 'go'],
  },
  {
    rule: 'repeated-calculation',
    pattern: /(\.\w+\([^)]*\)).*\1/g,
    type: 'optimize',
    description: '检测到重复计算，建议将结果缓存到变量中',
    impact: 'low',
    effort: 'low',
    languages: ['javascript', 'typescript', 'python', 'java', 'go'],
  },
  {
    rule: 'large-object-hot-path',
    pattern: /(?:for\s*\(|while\s*\().*(?:new\s+(?:Map|Set|Array|Object)|\{[^}]{100,}\}|\[[^\]]{100,}\])/gs,
    type: 'optimize',
    description: '在热路径中创建大型对象，可能影响性能',
    impact: 'medium',
    effort: 'high',
    languages: ['javascript', 'typescript', 'python', 'java'],
  },
  {
    rule: 'missing-cache',
    pattern: /(?:fetch|axios|http\.get|request)\s*\([^)]*(?:api|endpoint|url)/gi,
    type: 'optimize',
    description: 'API 请求缺少缓存机制，建议添加缓存层',
    impact: 'medium',
    effort: 'medium',
    languages: ['javascript', 'typescript', 'python'],
  },
];

// ============ 工具定义 ============

export interface ToolDefinition {
  name: string;
  description: string;
  parameters: Record<string, { type: string; description: string; required?: boolean }>;
}

const TOOL_DEFINITIONS: ToolDefinition[] = [
  {
    name: 'code_analyze',
    description: '全面代码质量分析：语法验证、风格合规、安全扫描、性能分析、复杂度指标',
    parameters: {
      code: { type: 'string', description: '待分析的代码内容', required: true },
      language: { type: 'string', description: '编程语言（javascript/typescript/python/java/go）', required: true },
      filePath: { type: 'string', description: '文件路径（可选，用于结果标注）' },
    },
  },
  {
    name: 'code_style_check',
    description: '代码风格合规检查，支持 PEP8/Airbnb/Google/Standard/gofmt 标准',
    parameters: {
      code: { type: 'string', description: '待检查的代码内容', required: true },
      language: { type: 'string', description: '编程语言', required: true },
      standard: { type: 'string', description: '风格标准（PEP8/Airbnb/Google/Standard/gofmt）' },
    },
  },
  {
    name: 'code_security_scan',
    description: '安全漏洞扫描：SQL注入、XSS、硬编码密钥、不安全加密等 15+ 种模式',
    parameters: {
      code: { type: 'string', description: '待扫描的代码内容', required: true },
      language: { type: 'string', description: '编程语言', required: true },
    },
  },
  {
    name: 'code_format',
    description: '代码格式化：缩进标准化、尾随空白移除、分号处理、import 排序',
    parameters: {
      code: { type: 'string', description: '待格式化的代码内容', required: true },
      language: { type: 'string', description: '编程语言', required: true },
      standard: { type: 'string', description: '风格标准' },
    },
  },
];

// ============ 主类 ============

export class CodeQualityEngine {
  private eventBus: EventBus | null = null;

  constructor(eventBus?: EventBus) {
    this.eventBus = eventBus || null;
    logger.info('CodeQualityEngine 初始化完成', { module: 'code-quality-engine' });
  }

  /**
   * 获取工具定义列表
   */
  getToolDefinitions(): ToolDefinition[] {
    return TOOL_DEFINITIONS;
  }

  /**
   * 执行工具调用
   */
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  executeTool(name: string, params: Record<string, any>): any {
    switch (name) {
      case 'code_analyze':
        return this.analyzeCode(params.code, params.language, params.filePath);
      case 'code_style_check':
        return this.checkStyle(params.code, params.language, params.standard);
      case 'code_security_scan':
        return this.scanSecurity(params.code, params.language);
      case 'code_format':
        return this.formatCode(params.code, params.language, params.standard);
      default:
        throw new Error(`未知工具: ${name}`);
    }
  }

  /**
   * 全面代码分析
   */
  analyzeCode(code: string, language: string, filePath?: string): CodeAnalysisResult {
    const startTime = Date.now();

    logger.info('开始代码分析', { module: 'code-quality-engine', metadata: { language, filePath } });

    const issues: CodeIssue[] = [];
    const suggestions: CodeSuggestion[] = [];

    // 语法验证
    const syntaxIssues = this.validateSyntax(code, language);
    issues.push(...syntaxIssues);

    // 安全扫描
    const securityIssues = this.scanSecurity(code, language);
    issues.push(...securityIssues);

    // 风格检查
    const styleCompliance = this.checkStyle(code, language);

    // 性能分析
    const perfSuggestions = this.analyzePerformance(code, language);
    suggestions.push(...perfSuggestions);

    // 指标计算
    const metrics = this.calculateMetrics(code, language);

    // 复杂度问题
    if (metrics.cyclomaticComplexity > 10) {
      issues.push({
        line: 0,
        severity: 'warning',
        category: 'complexity',
        message: `圈复杂度为 ${metrics.cyclomaticComplexity}，建议拆分为更小的函数（阈值: 10）`,
        rule: 'max-cyclomatic-complexity',
      });
    }

    if (metrics.cognitiveComplexity > 15) {
      issues.push({
        line: 0,
        severity: 'warning',
        category: 'complexity',
        message: `认知复杂度为 ${metrics.cognitiveComplexity}，代码难以理解（阈值: 15）`,
        rule: 'max-cognitive-complexity',
      });
    }

    // 计算质量分数
    const quality = this.calculateQualityScore(issues, metrics, styleCompliance);

    // 生成重构建议
    suggestions.push(...this.generateRefactorSuggestions(code, language, metrics));

    const result: CodeAnalysisResult = {
      filePath: filePath || '<unknown>',
      language,
      quality,
      issues,
      suggestions,
      metrics,
      styleCompliance,
    };

    const duration = Date.now() - startTime;
    logger.info('代码分析完成', {
      module: 'code-quality-engine',
      metadata: { language, filePath, durationMs: duration, issueCount: issues.length },
    });

    this.emitEvent('code:analyzed', result);

    return result;
  }

  /**
   * 代码风格合规检查
   */
  checkStyle(code: string, language: string, standard?: string): StyleCompliance {
    const detectedStandard = standard || this.detectDefaultStandard(language);
    const violations: Array<{ rule: string; count: number; examples: string[] }> = [];

    const applicableRules = STYLE_RULES.filter(
      (rule) => rule.standard.includes(detectedStandard) && this.isRuleApplicable(rule, language)
    );

    for (const rule of applicableRules) {
      const matches = this.findPatternMatches(code, rule.pattern);
      if (matches.length > 0) {
        const examples = matches.slice(0, 3).map((m) => m.text.trim());
        violations.push({
          rule: rule.rule,
          count: matches.length,
          examples,
        });
      }
    }

    const totalViolations = violations.reduce((sum, v) => sum + v.count, 0);
    const compliance = Math.max(0, 100 - totalViolations * 5);

    logger.debug('风格检查完成', {
      module: 'code-quality-engine',
      metadata: { standard: detectedStandard, compliance, violationCount: totalViolations },
    });

    return {
      standard: detectedStandard,
      compliance,
      violations,
    };
  }

  /**
   * 安全漏洞扫描
   */
  scanSecurity(code: string, language: string): CodeIssue[] {
    const issues: CodeIssue[] = [];
    const lines = code.split('\n');

    for (const pattern of SECURITY_PATTERNS) {
      if (!pattern.languages.includes(language) && !pattern.languages.includes(this.getLanguageFamily(language))) {
        continue;
      }

      const regex = new RegExp(pattern.pattern.source, pattern.pattern.flags);
      let match: RegExpExecArray | null;

      // 重置正则状态
      regex.lastIndex = 0;

      while ((match = regex.exec(code)) !== null) {
        const lineNumber = this.getLineNumber(code, match.index);
        const column = this.getColumnNumber(code, match.index);

        issues.push({
          line: lineNumber,
          column,
          severity: pattern.severity,
          category: 'security',
          message: pattern.message,
          rule: pattern.rule,
          fix: pattern.fix,
        });

        // 防止无限循环
        if (match.index === regex.lastIndex) {
          regex.lastIndex++;
        }
      }
    }

    // 检查 await 是否在 try-catch 中
    const awaitIssues = this.checkAwaitErrorHandling(code, lines);
    issues.push(...awaitIssues);

    logger.debug('安全扫描完成', {
      module: 'code-quality-engine',
      metadata: { language, issueCount: issues.length },
    });

    return issues;
  }

  /**
   * 性能分析
   */
  analyzePerformance(code: string, language: string): CodeSuggestion[] {
    const suggestions: CodeSuggestion[] = [];

    for (const pattern of PERFORMANCE_PATTERNS) {
      if (!pattern.languages.includes(language) && !pattern.languages.includes(this.getLanguageFamily(language))) {
        continue;
      }

      const regex = new RegExp(pattern.pattern.source, pattern.pattern.flags);
      const match = regex.exec(code);

      if (match) {
        suggestions.push({
          type: pattern.type,
          description: pattern.description,
          original: match[0].substring(0, 100),
          impact: pattern.impact,
          effort: pattern.effort,
        });
      }
    }

    // 额外的性能建议
    this.addExtraPerformanceSuggestions(code, language, suggestions);

    return suggestions;
  }

  /**
   * 计算代码指标
   */
  calculateMetrics(code: string, language: string): CodeMetrics {
    const lines = code.split('\n');
    const totalLines = lines.length;

    // 有效代码行（排除空行和注释）
    const codeLines = lines.filter((line) => {
      const trimmed = line.trim();
      return trimmed.length > 0 && !this.isCommentLine(trimmed, language);
    });
    const linesOfCode = codeLines.length;

    // 注释行
    const commentLines = lines.filter((line) => this.isCommentLine(line.trim(), language)).length;

    // 空行
    const _blankLines = totalLines - linesOfCode - commentLines;

    // 圈复杂度
    const cyclomaticComplexity = this.calculateCyclomaticComplexity(code, language);

    // 认知复杂度
    const cognitiveComplexity = this.calculateCognitiveComplexity(code, language);

    // 函数计数
    const functionCount = this.countFunctions(code, language);

    // 类计数
    const classCount = this.countClasses(code, language);

    // 依赖计数
    const dependencyCount = this.countDependencies(code, language);

    // 注释比率
    const commentRatio = totalLines > 0 ? commentLines / totalLines : 0;

    // 重复比率
    const duplicateRatio = this.calculateDuplicateRatio(lines);

    // 可维护性指数
    const maintainabilityIndex = this.calculateMaintainabilityIndex(
      linesOfCode,
      cyclomaticComplexity,
      commentRatio
    );

    // Halstead 体积（简化估算）
    const halsteadVolume = this.estimateHalsteadVolume(code);

    return {
      linesOfCode,
      cyclomaticComplexity,
      cognitiveComplexity,
      maintainabilityIndex,
      halsteadVolume,
      dependencyCount,
      functionCount,
      classCount,
      commentRatio,
      duplicateRatio,
    };
  }

  /**
   * 生成自动修复
   */
  generateFix(issue: CodeIssue, code: string): string | null {
    const lines = code.split('\n');
    const lineIndex = issue.line - 1;

    if (lineIndex < 0 || lineIndex >= lines.length) {
      return null;
    }

    const line = lines[lineIndex];

    switch (issue.rule) {
      case 'no-trailing-whitespace': {
        const fixed = line.replace(/[ \t]+$/, '');
        lines[lineIndex] = fixed;
        return lines.join('\n');
      }

      case 'no-console-in-prod': {
        // 注释掉 console 调用
        const indentation = line.match(/^(\s*)/)?.[1] || '';
        lines[lineIndex] = `${indentation}// ${line.trim()}`;
        return lines.join('\n');
      }

      case 'no-multiple-empty-lines': {
        const result: string[] = [];
        let emptyCount = 0;
        for (const l of lines) {
          if (l.trim() === '') {
            emptyCount++;
            if (emptyCount <= 2) {
              result.push(l);
            }
          } else {
            emptyCount = 0;
            result.push(l);
          }
        }
        return result.join('\n');
      }

      case 'no-insecure-crypto': {
        // 替换 MD5/SHA1 为 SHA-256
        let fixed = code;
        fixed = fixed.replace(/\bcreateHash\s*\(\s*['"`]md5['"`]\s*\)/g, "createHash('sha256')");
        fixed = fixed.replace(/\bcreateHash\s*\(\s*['"`]sha1['"`]\s*\)/g, "createHash('sha256')");
        fixed = fixed.replace(/\bhashlib\.md5\b/g, 'hashlib.sha256');
        fixed = fixed.replace(/\bhashlib\.sha1\b/g, 'hashlib.sha256');
        return fixed;
      }

      default:
        return null;
    }
  }

  /**
   * 代码格式化
   */
  formatCode(code: string, language: string, standard?: string): string {
    let formatted = code;

    // 移除行尾空白
    formatted = formatted.replace(/[ \t]+$/gm, '');

    // 规范化连续空行（最多保留 2 个）
    formatted = formatted.replace(/\n{4,}/g, '\n\n\n');

    // 确保文件末尾有换行
    if (!formatted.endsWith('\n')) {
      formatted += '\n';
    }

    // 根据语言和标准处理缩进
    formatted = this.normalizeIndentation(formatted, language, standard);

    // 根据标准处理分号
    formatted = this.normalizeSemicolons(formatted, language, standard);

    // 排序 import 语句
    formatted = this.sortImports(formatted, language);

    logger.debug('代码格式化完成', {
      module: 'code-quality-engine',
      metadata: { language, standard: standard || 'default' },
    });

    return formatted;
  }

  // ============ 私有方法 ============

  private validateSyntax(code: string, _language: string): CodeIssue[] {
    const issues: CodeIssue[] = [];
    const lines = code.split('\n');

    // 检查未闭合的括号
    const bracketStack: Array<{ char: string; line: number }> = [];
    const openBrackets = ['(', '[', '{'];
    const closeBrackets = [')', ']', '}'];
    const bracketPairs: Record<string, string> = { ')': '(', ']': '[', '}': '{' };

    let inString = false;
    let stringChar = '';

    for (let i = 0; i < lines.length; i++) {
      const line = lines[i];
      for (let j = 0; j < line.length; j++) {
        const char = line[j];

        // 简单的字符串检测
        if ((char === '"' || char === "'" || char === '`') && (j === 0 || line[j - 1] !== '\\')) {
          if (!inString) {
            inString = true;
            stringChar = char;
          } else if (char === stringChar) {
            inString = false;
          }
          continue;
        }

        if (inString) continue;

        if (openBrackets.includes(char)) {
          bracketStack.push({ char, line: i + 1 });
        } else if (closeBrackets.includes(char)) {
          const expected = bracketPairs[char];
          if (bracketStack.length === 0 || bracketStack[bracketStack.length - 1].char !== expected) {
            issues.push({
              line: i + 1,
              column: j + 1,
              severity: 'error',
              category: 'syntax',
              message: `未匹配的闭合括号 '${char}'`,
              rule: 'bracket-matching',
            });
          } else {
            bracketStack.pop();
          }
        }
      }
    }

    // 检查未闭合的括号
    for (const bracket of bracketStack) {
      issues.push({
        line: bracket.line,
        severity: 'error',
        category: 'syntax',
        message: `未闭合的括号 '${bracket.char}'`,
        rule: 'bracket-matching',
      });
    }

    return issues;
  }

  private checkAwaitErrorHandling(code: string, _lines: string[]): CodeIssue[] {
    const issues: CodeIssue[] = [];

    // 简化检测：找到 await 但不在 try 块中的情况
    const awaitRegex = /\bawait\s+/g;
    let match: RegExpExecArray | null;

    while ((match = awaitRegex.exec(code)) !== null) {
      const lineNumber = this.getLineNumber(code, match.index);
      // 检查上方是否有 try {
      const precedingCode = code.substring(0, match.index);
      const lastTryIndex = precedingCode.lastIndexOf('try');
      const lastCatchIndex = precedingCode.lastIndexOf('catch');

      if (lastTryIndex === -1 || lastCatchIndex > lastTryIndex) {
        // 不在 try 块中
        issues.push({
          line: lineNumber,
          severity: 'info',
          category: 'security',
          message: '异步操作缺少 try-catch 错误处理',
          rule: 'no-async-without-trycatch',
          fix: '在 await 调用外包裹 try-catch',
        });
      }
    }

    return issues;
  }

  private calculateQualityScore(
    issues: CodeIssue[],
    metrics: CodeMetrics,
    _styleCompliance: StyleCompliance
  ): QualityScore {
    // 安全分数
    const securityErrors = issues.filter((i) => i.category === 'security' && i.severity === 'error').length;
    const securityWarnings = issues.filter((i) => i.category === 'security' && i.severity === 'warning').length;
    const security = Math.max(0, 100 - securityErrors * 20 - securityWarnings * 5);

    // 性能分数
    const perfIssues = issues.filter((i) => i.category === 'performance').length;
    const performance = Math.max(0, 100 - perfIssues * 10);

    // 可读性分数
    const readability = Math.min(100, Math.max(0,
      100
      - Math.max(0, metrics.cyclomaticComplexity - 10) * 3
      - Math.max(0, (1 - metrics.commentRatio) * 20)
      - (metrics.duplicateRatio > 0.1 ? 10 : 0)
    ));

    // 可维护性分数
    const maintainability = Math.min(100, Math.max(0,
      metrics.maintainabilityIndex
      - (metrics.cyclomaticComplexity > 10 ? 10 : 0)
      - (metrics.linesOfCode > 300 ? 10 : 0)
    ));

    // 正确性分数
    const syntaxErrors = issues.filter((i) => i.category === 'syntax' && i.severity === 'error').length;
    const logicIssues = issues.filter((i) => i.category === 'logic').length;
    const correctness = Math.max(0, 100 - syntaxErrors * 25 - logicIssues * 15);

    // 总分
    const overall = Math.round(
      (security * 0.25 + performance * 0.15 + readability * 0.25 + maintainability * 0.2 + correctness * 0.15)
    );

    return {
      overall,
      readability: Math.round(readability),
      maintainability: Math.round(maintainability),
      security: Math.round(security),
      performance: Math.round(performance),
      correctness: Math.round(correctness),
    };
  }

  private generateRefactorSuggestions(
    code: string,
    language: string,
    metrics: CodeMetrics
  ): CodeSuggestion[] {
    const suggestions: CodeSuggestion[] = [];

    // 长函数建议拆分
    if (metrics.linesOfCode > 100 && metrics.functionCount < 3) {
      suggestions.push({
        type: 'refactor',
        description: '文件代码行数较多但函数数量少，建议拆分为更小的函数以提高可读性',
        impact: 'high',
        effort: 'medium',
      });
    }

    // 高复杂度建议
    if (metrics.cyclomaticComplexity > 10) {
      suggestions.push({
        type: 'simplify',
        description: '圈复杂度过高，建议使用策略模式、查找表或提前返回来简化逻辑',
        impact: 'high',
        effort: 'medium',
      });
    }

    // 低注释率建议
    if (metrics.commentRatio < 0.1 && metrics.linesOfCode > 50) {
      suggestions.push({
        type: 'refactor',
        description: '注释率过低，建议添加关键逻辑的注释说明',
        impact: 'low',
        effort: 'low',
      });
    }

    // 重复代码建议
    if (metrics.duplicateRatio > 0.1) {
      suggestions.push({
        type: 'refactor',
        description: `代码重复率为 ${(metrics.duplicateRatio * 100).toFixed(1)}%，建议提取公共方法`,
        impact: 'medium',
        effort: 'medium',
      });
    }

    // 过多依赖建议
    if (metrics.dependencyCount > 15) {
      suggestions.push({
        type: 'simplify',
        description: '依赖数量较多，建议审视是否所有依赖都是必要的',
        impact: 'low',
        effort: 'low',
      });
    }

    // 现代化建议
    this.addModernizeSuggestions(code, language, suggestions);

    return suggestions;
  }

  private addModernizeSuggestions(code: string, language: string, suggestions: CodeSuggestion[]): void {
    if (language === 'javascript' || language === 'typescript') {
      // var → let/const
      if (/\bvar\s+/.test(code)) {
        suggestions.push({
          type: 'modernize',
          description: '使用 var 声明变量，建议替换为 let/const',
          original: 'var x = ...',
          suggested: 'const x = ... // 或 let x = ...',
          impact: 'medium',
          effort: 'low',
        });
      }

      // 回调 → async/await
      if (/\.then\s*\(/.test(code) && !/\bawait\b/.test(code)) {
        suggestions.push({
          type: 'modernize',
          description: '使用 .then() 链式调用，建议使用 async/await 提高可读性',
          impact: 'medium',
          effort: 'low',
        });
      }

      // 字符串拼接 → 模板字符串
      if (/['"`]\s*\+\s*|\s*\+\s*['"`]/.test(code) && !/`[^`]*\$\{/.test(code)) {
        suggestions.push({
          type: 'modernize',
          description: '使用字符串拼接，建议使用模板字符串（template literals）',
          original: '"Hello " + name',
          suggested: '`Hello ${name}`',
          impact: 'low',
          effort: 'low',
        });
      }

      // for 循环 → forEach/map/filter
      if (/for\s*\(\s*let\s+\w+\s*=\s*0/.test(code)) {
        suggestions.push({
          type: 'modernize',
          description: '使用传统 for 循环遍历数组，建议使用 forEach/map/filter',
          impact: 'low',
          effort: 'low',
        });
      }
    }

    if (language === 'python') {
      // 旧式字符串格式化 → f-string
      if (/['"]\s*%\s*\(|\.format\s*\(/g.test(code)) {
        suggestions.push({
          type: 'modernize',
          description: '使用旧式字符串格式化，建议使用 f-string（Python 3.6+）',
          original: '"Hello %s" % name',
          suggested: 'f"Hello {name}"',
          impact: 'low',
          effort: 'low',
        });
      }
    }
  }

  private addExtraPerformanceSuggestions(
    code: string,
    language: string,
    suggestions: CodeSuggestion[]
  ): void {
    // 检测 JSON.parse 在循环中
    if (/for\s*\(.*JSON\.parse|while\s*\(.*JSON\.parse/s.test(code)) {
      suggestions.push({
        type: 'optimize',
        description: '在循环中调用 JSON.parse，建议在循环外解析',
        impact: 'medium',
        effort: 'low',
      });
    }

    // 检测 Array.push 在循环中未预分配
    if (/const\s+\w+\s*=\s*\[\]\s*;[\s\S]*?for\s*\(/s.test(code)) {
      suggestions.push({
        type: 'optimize',
        description: '数组在循环中动态增长，如果知道大小建议预分配',
        impact: 'low',
        effort: 'low',
      });
    }

    // 检测正则表达式在循环中重复编译
    if (/for\s*\([\s\S]*?new\s+RegExp\s*\(/s.test(code)) {
      suggestions.push({
        type: 'optimize',
        description: '在循环中创建正则表达式，建议在循环外编译',
        impact: 'medium',
        effort: 'low',
      });
    }
  }

  // ============ 指标计算辅助方法 ============

  private calculateCyclomaticComplexity(code: string, language: string): number {
    let complexity = 1; // 基础复杂度

    const decisionPatterns: RegExp[] = [];

    if (language === 'python') {
      decisionPatterns.push(
        /\bif\b/g,
        /\belif\b/g,
        /\bfor\b/g,
        /\bwhile\b/g,
        /\bexcept\b/g,
        /\band\b/g,
        /\bor\b/g
      );
    } else {
      decisionPatterns.push(
        /\bif\b/g,
        /\belse\s+if\b/g,
        /\bfor\b/g,
        /\bwhile\b/g,
        /\bcase\b/g,
        /\bcatch\b/g,
        /&&/g,
        /\|\|/g,
        /\?\s*[^.?]/g  // 三元运算符（排除可选链 ?.）
      );
    }

    for (const pattern of decisionPatterns) {
      const regex = new RegExp(pattern.source, pattern.flags);
      const matches = code.match(regex);
      if (matches) {
        complexity += matches.length;
      }
    }

    return complexity;
  }

  private calculateCognitiveComplexity(code: string, language: string): number {
    let complexity = 0;
    let nestingLevel = 0;
    const lines = code.split('\n');

    const increasePatterns = language === 'python'
      ? [/^\s*if\b/, /^\s*elif\b/, /^\s*for\b/, /^\s*while\b/, /^\s*except\b/]
      : [/\bif\b/, /\belse\s+if\b/, /\bfor\b/, /\bwhile\b/, /\bcatch\b/, /\?\s*[^.?]/];

    const nestingOpen = language === 'python'
      ? [/^\s*if\b/, /^\s*for\b/, /^\s*while\b/, /^\s*try\b/, /^\s*with\b/]
      : [/\{/, /\bif\s*\(/, /\bfor\s*\(/, /\bwhile\s*\(/, /\btry\s*\{/];

    const nestingClose = language === 'python'
      ? [/^\s*(return|break|continue|pass)\b/]
      : [/\}/];

    for (const line of lines) {
      const trimmed = line.trim();

      // 跳过空行和注释
      if (!trimmed || this.isCommentLine(trimmed, language)) continue;

      // 检测嵌套增加
      for (const pattern of nestingOpen) {
        if (pattern.test(trimmed)) {
          nestingLevel++;
          break;
        }
      }

      // 检测决策点
      for (const pattern of increasePatterns) {
        if (pattern.test(trimmed)) {
          complexity += 1 + Math.max(0, nestingLevel - 1);
          break;
        }
      }

      // 检测逻辑运算符
      const andMatches = trimmed.match(/&&/g);
      const orMatches = trimmed.match(/\|\|/g);
      if (andMatches) complexity += andMatches.length;
      if (orMatches) complexity += orMatches.length;

      // 检测嵌套减少
      for (const pattern of nestingClose) {
        if (pattern.test(trimmed)) {
          nestingLevel = Math.max(0, nestingLevel - 1);
          break;
        }
      }
    }

    return complexity;
  }

  private countFunctions(code: string, language: string): number {
    let count = 0;

    if (language === 'python') {
      const funcMatches = code.match(/\bdef\s+\w+/g);
      count += funcMatches ? funcMatches.length : 0;
      const lambdaMatches = code.match(/\blambda\b/g);
      count += lambdaMatches ? lambdaMatches.length : 0;
    } else {
      // 普通函数
      const funcMatches = code.match(/\bfunction\s+\w+/g);
      count += funcMatches ? funcMatches.length : 0;
      // 箭头函数
      const arrowMatches = code.match(/(?:const|let|var)\s+\w+\s*=\s*(?:async\s*)?\([^)]*\)\s*=>/g);
      count += arrowMatches ? arrowMatches.length : 0;
      // 方法简写
      const methodMatches = code.match(/(?:async\s+)?\w+\s*\([^)]*\)\s*\{/g);
      count += methodMatches ? methodMatches.length : 0;
    }

    return count;
  }

  private countClasses(code: string, language: string): number {
    if (language === 'python') {
      const matches = code.match(/\bclass\s+\w+/g);
      return matches ? matches.length : 0;
    }
    const matches = code.match(/\bclass\s+\w+/g);
    return matches ? matches.length : 0;
  }

  private countDependencies(code: string, language: string): number {
    let count = 0;

    switch (language) {
      case 'javascript':
      case 'typescript': {
        const importMatches = code.match(/(?:import\s+.*from\s+|require\s*\()\s*['"`]/g);
        count += importMatches ? importMatches.length : 0;
        break;
      }
      case 'python': {
        const importMatches = code.match(/(?:^import\s+|^from\s+\S+\s+import)/gm);
        count += importMatches ? importMatches.length : 0;
        break;
      }
      case 'java': {
        const importMatches = code.match(/^import\s+/gm);
        count += importMatches ? importMatches.length : 0;
        break;
      }
      case 'go': {
        const importMatches = code.match(/(?:^import\s+|^\s*"[^"]+"(?:\s*$|\s*\/\/))/gm);
        count += importMatches ? importMatches.length : 0;
        break;
      }
    }

    return count;
  }

  private calculateDuplicateRatio(lines: string[]): number {
    const normalizedLines = lines.map((l) => l.trim()).filter((l) => l.length > 10);
    if (normalizedLines.length === 0) return 0;

    const seen = new Map<string, number>();
    let duplicateCount = 0;

    for (const line of normalizedLines) {
      const count = seen.get(line) || 0;
      if (count > 0) {
        duplicateCount++;
      }
      seen.set(line, count + 1);
    }

    return duplicateCount / normalizedLines.length;
  }

  private calculateMaintainabilityIndex(
    linesOfCode: number,
    cyclomaticComplexity: number,
    commentRatio: number
  ): number {
    // 简化的可维护性指数计算
    // 原始公式: MI = 171 - 5.2 * ln(HV) - 0.23 * CC - 16.2 * ln(LOC)
    // 简化版本
    if (linesOfCode === 0) return 100;

    const locFactor = Math.max(0, 20 - Math.log(linesOfCode) * 3);
    const ccFactor = Math.max(0, 20 - cyclomaticComplexity * 2);
    const commentFactor = Math.min(20, commentRatio * 100);

    return Math.min(100, Math.max(0, 60 + locFactor + ccFactor + commentFactor));
  }

  private estimateHalsteadVolume(code: string): number {
    // 简化的 Halstead 体积估算
    // 提取操作符和操作数
    const operators = code.match(/[+\-*/%=<>!&|^~?:]+|\.|\[|\(|\{|\}|\]|;|,|=>|&&|\|\||\.\.\./g) || [];
    const operands = code.match(/\b[a-zA-Z_$][a-zA-Z0-9_$]*\b|\b\d+\.?\d*\b|['"`][^'"`]*['"`]/g) || [];

    const uniqueOperators = new Set(operators).size;
    const uniqueOperands = new Set(operands).size;
    const totalN = operators.length + operands.length;
    const vocabulary = uniqueOperators + uniqueOperands;

    if (vocabulary === 0 || totalN === 0) return 0;

    return Math.round(totalN * Math.log2(Math.max(vocabulary, 1)));
  }

  // ============ 格式化辅助方法 ============

  private normalizeIndentation(code: string, language: string, standard?: string): string {
    if (language === 'python') {
      // Python: 确保使用 4 空格缩进
      return code.replace(/\t/g, '    ');
    }

    if (language === 'go') {
      // Go: 使用 tab 缩进
      return code.replace(/ {4}/g, '\t');
    }

    // JS/TS/Java: 根据标准选择
    if (standard === 'Standard' || standard === 'Airbnb') {
      return code.replace(/\t/g, '  ');
    }

    // 默认 2 空格
    return code.replace(/\t/g, '  ');
  }

  private normalizeSemicolons(code: string, language: string, standard?: string): string {
    if (language === 'python' || language === 'go') {
      return code; // 这些语言不使用分号
    }

    if (standard === 'Standard') {
      // Standard 风格：移除不必要的分号
      return code.replace(/;(\s*\n)/g, '$1');
    }

    // Airbnb/Google 风格：确保分号存在（简化处理，不改变已有分号）
    return code;
  }

  private sortImports(code: string, language: string): string {
    if (language !== 'javascript' && language !== ' ' + 'typescript') {
      return code;
    }

    const lines = code.split('\n');
    const importLines: Array<{ index: number; line: string; priority: number }> = [];
    const nonImportLines: Array<{ index: number; line: string }> = [];

    let inImportBlock = false;
    let _importStartIndex = -1;

    for (let i = 0; i < lines.length; i++) {
      const trimmed = lines[i].trim();

      if (/^import\s+/.test(trimmed) || /^const\s+.*require\s*\(/.test(trimmed)) {
        if (!inImportBlock) {
          _importStartIndex = i;
          inImportBlock = true;
        }

        // 确定优先级：核心模块 > 第三方 > 本地
        let priority = 2;
        if (/^import\s+.*from\s+['"`][./]/.test(trimmed) || /require\s*\(\s*['"`][./]/.test(trimmed)) {
          priority = 3; // 本地模块
        } else if (/^import\s+.*from\s+['"`](react|express|lodash|axios|fs|path|http)/.test(trimmed)) {
          priority = 1; // 核心/常用第三方
        }

        importLines.push({ index: i, line: lines[i], priority });
      } else {
        if (inImportBlock && trimmed !== '' && !trimmed.startsWith('//') && !trimmed.startsWith('/*')) {
          inImportBlock = false;
        }
        nonImportLines.push({ index: i, line: lines[i] });
      }
    }

    if (importLines.length === 0) {
      return code;
    }

    // 按优先级排序 import
    importLines.sort((a, b) => {
      if (a.priority !== b.priority) return a.priority - b.priority;
      return a.line.localeCompare(b.line);
    });

    // 重建代码
    const result: string[] = [];
    let importIdx = 0;
    let nonImportIdx = 0;

    for (let i = 0; i < lines.length; i++) {
      if (importIdx < importLines.length && importLines[importIdx].index === i) {
        result.push(importLines[importIdx].line);
        importIdx++;
      } else if (nonImportIdx < nonImportLines.length && nonImportLines[nonImportIdx].index === i) {
        result.push(nonImportLines[nonImportIdx].line);
        nonImportIdx++;
      }
    }

    return result.join('\n');
  }

  // ============ 通用辅助方法 ============

  private detectDefaultStandard(language: string): string {
    switch (language) {
      case 'python': return 'PEP8';
      case 'javascript':
      case 'typescript': return 'Airbnb';
      case 'java': return 'Google';
      case 'go': return 'gofmt';
      default: return 'Standard';
    }
  }

  private isRuleApplicable(rule: StyleRule, language: string): boolean {
    // 语言特定规则过滤
    if (rule.rule.startsWith('pep8-') && language !== 'python') return false;
    if (rule.rule.startsWith('js-') && language !== 'javascript' && language !== 'typescript') return false;
    if (rule.rule.startsWith('go-') && language !== 'go') return false;
    if (rule.rule.startsWith('java-') && language !== 'java') return false;
    return true;
  }

  private getLanguageFamily(language: string): string {
    if (language === 'typescript') return 'javascript';
    return language;
  }

  private isCommentLine(line: string, language: string): boolean {
    if (language === 'python') {
      return line.startsWith('#') || line.startsWith('"""') || line.startsWith("'''");
    }
    return line.startsWith('//') || line.startsWith('/*') || line.startsWith('*') || line.startsWith('*/');
  }

  private getLineNumber(code: string, index: number): number {
    return code.substring(0, index).split('\n').length;
  }

  private getColumnNumber(code: string, index: number): number {
    const lastNewline = code.lastIndexOf('\n', index - 1);
    return index - lastNewline;
  }

  private findPatternMatches(code: string, pattern: RegExp): Array<{ index: number; text: string }> {
    const matches: Array<{ index: number; text: string }> = [];
    const regex = new RegExp(pattern.source, pattern.flags);
    let match: RegExpExecArray | null;

    regex.lastIndex = 0;

    while ((match = regex.exec(code)) !== null) {
      matches.push({
        index: match.index,
        text: match[0],
      });

      if (match.index === regex.lastIndex) {
        regex.lastIndex++;
      }

      // 限制匹配数量防止性能问题
      if (matches.length >= 100) break;
    }

    return matches;
  }

  private emitEvent(type: string, data: unknown): void {
    if (this.eventBus) {
      this.eventBus.emitSync(type, data, { source: 'code-quality-engine' });
    }
  }
}
