/**
 * 提示词优化中间件 — PromptOptimizer
 *
 * 灵感来源：LibTV 的双提示词优化（图像 vs 视频提示词有不同要求）
 * 核心能力：
 * 1. 按目标类型自动优化提示词（代码生成、代码审查、推理、工具调用等）
 * 2. 模板系统：每种目标类型预注册优化模板，含规则和 few-shot 示例
 * 3. 提示词质量分析：多维度评分（清晰度、具体性、完整性、简洁性）
 * 4. 模型适配：针对特定 LLM 的偏好调整提示词格式/风格
 * 5. 统计追踪：优化次数、token 节省、质量提升等
 */

import { logger } from './structured-logger.js';
import { EventBus } from './event-bus.js';
import type { ToolDef } from './unified-tool-def.js';

// ============ 类型定义 ============

/** 提示词目标类型 */
export type PromptTarget =
  | 'code_generation'
  | 'code_review'
  | 'reasoning'
  | 'creative'
  | 'tool_call'
  | 'search_query'
  | 'documentation'
  | 'testing';

/** 优化后的提示词 */
export interface OptimizedPrompt {
  original: string;
  optimized: string;
  target: PromptTarget;
  improvements: string[];
  estimatedTokenSavings: number;
  qualityScore: { before: number; after: number };
}

/** 提示词优化模板 */
export interface PromptTemplate {
  name: string;
  target: PromptTarget;
  systemPrefix: string;
  systemSuffix: string;
  fewShotExamples: Array<{ input: string; output: string }>;
  rules: string[];
}

/** 提示词质量报告 */
export interface PromptQualityReport {
  overallScore: number;       // 0-100
  clarity: number;
  specificity: number;
  completeness: number;
  conciseness: number;
  issues: string[];
  suggestions: string[];
}


// ============ 预注册模板 ============

const BUILTIN_TEMPLATES: PromptTemplate[] = [
  {
    name: 'code_generation',
    target: 'code_generation',
    systemPrefix: '你是一个专业的代码生成助手。请严格按照要求生成高质量代码。',
    systemSuffix: '确保代码完整可运行，包含错误处理和必要注释。',
    fewShotExamples: [
      {
        input: '写一个排序函数',
        output: '请用 TypeScript 编写一个泛型排序函数，支持升序/降序，包含类型定义、错误处理和单元测试示例。',
      },
    ],
    rules: [
      '明确指定编程语言、框架和版本约束',
      '包含错误处理和边界检查',
      '提供类型定义（如适用）',
      '输出完整可运行的代码，不省略关键逻辑',
    ],
  },
  {
    name: 'code_review',
    target: 'code_review',
    systemPrefix: '你是一个严格的代码审查专家。请从安全、性能、可读性、可维护性四个维度审查代码。',
    systemSuffix: '每个问题需引用具体行号，给出修改建议和修复代码。',
    fewShotExamples: [
      {
        input: '审查这段代码',
        output: '请从以下维度审查代码：1) 安全性（注入、XSS、敏感数据泄露）2) 性能（时间/空间复杂度、N+1查询）3) 可读性（命名、注释、结构）4) 可维护性（耦合度、扩展性）。对每个问题标注严重级别，引用具体行号，给出修复代码。',
      },
    ],
    rules: [
      '关注：安全、性能、可读性、可维护性',
      '引用具体行号',
      '每个问题标注严重级别（critical/warning/info）',
      '给出修复建议和修复代码',
    ],
  },
  {
    name: 'reasoning',
    target: 'reasoning',
    systemPrefix: '你是一个逻辑推理专家。请逐步推理，展示完整思考过程。',
    systemSuffix: '考虑边界情况和反例，确保推理链完整。',
    fewShotExamples: [
      {
        input: '为什么这段代码会内存泄漏',
        output: '请逐步分析内存泄漏原因：1) 识别所有对象引用链 2) 定位未释放的资源 3) 分析垃圾回收无法回收的原因 4) 考虑边界情况（循环引用、闭包捕获）5) 给出修复方案。',
      },
    ],
    rules: [
      '逐步推理，展示思考过程',
      '考虑边界情况和反例',
      '区分事实与推断',
      '标注推理置信度',
    ],
  },
  {
    name: 'creative',
    target: 'creative',
    systemPrefix: '你是一个创意生成引擎。请提供多角度、差异化的创意方案。',
    systemSuffix: '每个方案需包含核心思路、亮点和可行性评估。',
    fewShotExamples: [
      {
        input: '设计一个推荐系统',
        output: '请提供3个不同方向的推荐系统设计方案：方案A（协同过滤+深度学习）、方案B（知识图谱+规则引擎）、方案C（联邦学习+隐私保护）。每个方案包含：核心架构、技术亮点、可行性评估（1-5分）、适用场景。',
      },
    ],
    rules: [
      '提供至少3个差异化方案',
      '每个方案包含核心思路和亮点',
      '评估可行性',
      '推荐最优方案并说明理由',
    ],
  },
  {
    name: 'tool_call',
    target: 'tool_call',
    systemPrefix: '你是一个精确的工具调用助手。请严格按照工具参数规范构造调用。',
    systemSuffix: '确保所有必填参数都已提供，可选参数有合理默认值。',
    fewShotExamples: [
      {
        input: '搜索关于 React 的资料',
        output: '调用搜索工具，参数：query="React framework best practices 2025", limit=10, language="zh-CN"',
      },
    ],
    rules: [
      '精确指定参数名称和值',
      '区分必填参数和可选参数',
      '参数值类型必须匹配定义',
      '缺少必填参数时主动询问',
    ],
  },
  {
    name: 'search_query',
    target: 'search_query',
    systemPrefix: '',
    systemSuffix: '',
    fewShotExamples: [
      {
        input: '怎么解决 Python 的内存泄漏问题',
        output: 'Python memory leak diagnosis troubleshooting gc.collect objgraph tracemalloc',
      },
    ],
    rules: [
      '使用关键词而非完整句子',
      '包含同义词和相关术语',
      '优先使用英文技术术语',
      '去除停用词和虚词',
    ],
  },
  {
    name: 'documentation',
    target: 'documentation',
    systemPrefix: '你是一个技术文档专家。请生成清晰、结构化的技术文档。',
    systemSuffix: '文档需包含概述、API参考、使用示例和常见问题。',
    fewShotExamples: [
      {
        input: '给这个模块写文档',
        output: '请生成完整的技术文档，包含：1) 模块概述与核心概念 2) API参考（参数、返回值、异常）3) 快速开始示例 4) 高级用法 5) 常见问题与排错指南。',
      },
    ],
    rules: [
      '包含概述、API参考、示例、FAQ',
      'API文档需列出参数、返回值、异常',
      '提供可运行的代码示例',
      '使用 Markdown 格式',
    ],
  },
  {
    name: 'testing',
    target: 'testing',
    systemPrefix: '你是一个测试工程专家。请设计全面的测试方案。',
    systemSuffix: '覆盖正常路径、边界条件和异常路径。',
    fewShotExamples: [
      {
        input: '测试登录功能',
        output: '请设计完整的登录功能测试方案：1) 正常路径（有效凭据登录成功）2) 边界条件（空密码、超长输入、特殊字符）3) 异常路径（错误密码、账户锁定、网络超时）4) 安全测试（SQL注入、暴力破解、CSRF）5) 性能测试（并发登录、响应时间）。',
      },
    ],
    rules: [
      '覆盖正常路径、边界条件、异常路径',
      '包含安全测试用例',
      '每个用例有明确的预期结果',
      '标注优先级（P0/P1/P2）',
    ],
  },
];

// ============ 主类 ============

export class PromptOptimizer {
  private log = logger.child({ module: 'PromptOptimizer' });
  private templates: Map<string, PromptTemplate> = new Map();
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  private modelLibrary: any;
  private stats = {
    totalOptimizations: 0,
    totalTokenSavings: 0,
    qualityImprovements: 0,
    targetBreakdown: {} as Record<string, number>,
  };

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  constructor(modelLibrary?: any) {
    this.modelLibrary = modelLibrary;
    // 注册内置模板
    for (const tmpl of BUILTIN_TEMPLATES) {
      this.templates.set(tmpl.name, tmpl);
    }
    this.log.info('提示词优化中间件初始化完成', {
      templateCount: this.templates.size,
      hasModelLibrary: !!modelLibrary,
    });
  }

  // ========== 核心方法 ==========

  /**
   * 按目标类型优化提示词
   * 灵感：LibTV 图像提示词 vs 视频提示词有不同优化策略
   */
  optimizePrompt(prompt: string, targetType: PromptTarget): OptimizedPrompt {
    const startTime = Date.now();
    this.log.info('开始优化提示词', { target: targetType, inputLength: prompt.length });

    // 优化前质量评分
    const beforeQuality = this.calculateQualityScore(prompt);

    // 获取目标模板
    const template = this.templates.get(targetType);
    let optimized = prompt;
    const improvements: string[] = [];

    // 1. 应用模板规则
    if (template) {
      const ruleResult = this.applyTemplateRules(prompt, template);
      optimized = ruleResult.optimized;
      improvements.push(...ruleResult.improvements);
    }

    // 2. 目标特定优化
    const targetResult = this.applyTargetSpecificOptimization(optimized, targetType);
    optimized = targetResult.optimized;
    improvements.push(...targetResult.improvements);

    // 3. 通用优化（去冗余、结构化）
    const generalResult = this.applyGeneralOptimization(optimized);
    optimized = generalResult.optimized;
    improvements.push(...generalResult.improvements);

    // 优化后质量评分
    const afterQuality = this.calculateQualityScore(optimized);

    // 估算 token 节省
    const estimatedTokenSavings = this.estimateTokenSavings(prompt, optimized);

    const result: OptimizedPrompt = {
      original: prompt,
      optimized,
      target: targetType,
      improvements: [...new Set(improvements)], // 去重
      estimatedTokenSavings,
      qualityScore: { before: beforeQuality, after: afterQuality },
    };

    // 更新统计
    this.stats.totalOptimizations++;
    this.stats.totalTokenSavings += estimatedTokenSavings;
    if (afterQuality > beforeQuality) {
      this.stats.qualityImprovements++;
    }
    this.stats.targetBreakdown[targetType] = (this.stats.targetBreakdown[targetType] || 0) + 1;

    // 广播事件
    EventBus.getInstance().emitSync('prompt.optimized', {
      target: targetType,
      beforeQuality,
      afterQuality,
      tokenSavings: estimatedTokenSavings,
      durationMs: Date.now() - startTime,
    });

    this.log.info('提示词优化完成', {
      target: targetType,
      beforeQuality,
      afterQuality,
      tokenSavings: estimatedTokenSavings,
      improvementCount: result.improvements.length,
      durationMs: Date.now() - startTime,
    });

    return result;
  }

  /**
   * 添加优化模板
   */
  addTemplate(name: string, template: PromptTemplate): boolean {
    if (this.templates.has(name)) {
      this.log.warn('模板已存在，将覆盖', { name });
    }
    this.templates.set(name, template);
    this.log.info('添加优化模板', { name, target: template.target });
    EventBus.getInstance().emitSync('prompt.template.added', { name, target: template.target });
    return true;
  }

  /**
   * 分析提示词质量
   */
  analyzePromptQuality(prompt: string): PromptQualityReport {
    const issues: string[] = [];
    const suggestions: string[] = [];

    // 清晰度评估
    const clarity = this.assessClarity(prompt, issues, suggestions);
    // 具体性评估
    const specificity = this.assessSpecificity(prompt, issues, suggestions);
    // 完整性评估
    const completeness = this.assessCompleteness(prompt, issues, suggestions);
    // 简洁性评估
    const conciseness = this.assessConciseness(prompt, issues, suggestions);

    const overallScore = Math.round(
      clarity * 25 + specificity * 25 + completeness * 25 + conciseness * 25
    );

    return {
      overallScore,
      clarity: Math.round(clarity * 100),
      specificity: Math.round(specificity * 100),
      completeness: Math.round(completeness * 100),
      conciseness: Math.round(conciseness * 100),
      issues,
      suggestions,
    };
  }

  /**
   * 针对特定模型优化提示词
   */
  optimizeForModel(prompt: string, modelId: string): string {
    this.log.info('针对模型优化提示词', { modelId });

    let optimized = prompt;

    // 根据模型特征调整
    if (modelId.includes('deepseek') || modelId.includes('coder')) {
      // DeepSeek/Coder 模型偏好：结构化指令、明确输入输出
      optimized = this.formatForCodeModel(optimized);
    } else if (modelId.includes('claude') || modelId.includes('anthropic')) {
      // Claude 模型偏好：XML 标签、角色设定、详细指令
      optimized = this.formatForClaude(optimized);
    } else if (modelId.includes('gpt') || modelId.includes('openai')) {
      // GPT 模型偏好：Markdown 格式、清晰分段
      optimized = this.formatForGPT(optimized);
    } else if (modelId.includes('gemini') || modelId.includes('google')) {
      // Gemini 模型偏好：简洁直接、结构化列表
      optimized = this.formatForGemini(optimized);
    } else if (modelId.includes('llama') || modelId.includes('ollama')) {
      // Llama 模型偏好：简洁指令、少样本示例
      optimized = this.formatForLlama(optimized);
    }

    return optimized;
  }

  /**
   * 获取统计信息
   */
  getStats(): Record<string, unknown> {
    return {
      totalOptimizations: this.stats.totalOptimizations,
      totalTokenSavings: this.stats.totalTokenSavings,
      qualityImprovements: this.stats.qualityImprovements,
      qualityImprovementRate: this.stats.totalOptimizations > 0
        ? (this.stats.qualityImprovements / this.stats.totalOptimizations * 100).toFixed(1) + '%'
        : '0%',
      targetBreakdown: { ...this.stats.targetBreakdown },
      templateCount: this.templates.size,
    };
  }

  // ========== 工具定义（Agent Loop 集成） ==========

  getToolDefinitions(): ToolDef[] {
    return [
      {
        name: 'prompt_optimize',
        description: '优化提示词：按目标类型自动优化提示词，提升清晰度、具体性和完整性。灵感来自 LibTV 的双提示词优化（图像/视频提示词有不同要求）。',
        parameters: {
          prompt: { type: 'string', description: '待优化的原始提示词', required: true },
          target: {
            type: 'string',
            description: '目标类型：code_generation | code_review | reasoning | creative | tool_call | search_query | documentation | testing',
            required: true,
          },
        },
        readOnly: true,
        execute: (args) => {
          const result = this.optimizePrompt(
            args.prompt as string,
            args.target as PromptTarget
          );
          return Promise.resolve(JSON.stringify(result, null, 2));
        },
      },
      {
        name: 'prompt_quality',
        description: '分析提示词质量：多维度评分（清晰度、具体性、完整性、简洁性），发现问题并给出改进建议。',
        parameters: {
          prompt: { type: 'string', description: '待分析的提示词', required: true },
        },
        readOnly: true,
        execute: (args) => {
          const report = this.analyzePromptQuality(args.prompt as string);
          return Promise.resolve(JSON.stringify(report, null, 2));
        },
      },
      {
        name: 'prompt_template',
        description: '管理提示词优化模板：查看已有模板或添加新模板。每种目标类型有特定的优化规则和 few-shot 示例。',
        parameters: {
          action: { type: 'string', description: '操作：list | add | get', required: true },
          name: { type: 'string', description: '模板名称（add/get 时必填）' },
          template: { type: 'string', description: '模板 JSON（add 时必填）' },
        },
        readOnly: true,
        execute: (args) => {
          const action = args.action as string;
          if (action === 'list') {
            const list = Array.from(this.templates.entries()).map(([name, tmpl]) => ({
              name,
              target: tmpl.target,
              rulesCount: tmpl.rules.length,
              examplesCount: tmpl.fewShotExamples.length,
            }));
            return Promise.resolve(JSON.stringify(list, null, 2));
          }
          if (action === 'get') {
            const tmpl = this.templates.get(args.name as string);
            return Promise.resolve(tmpl ? JSON.stringify(tmpl, null, 2) : `模板 "${args.name}" 不存在`);
          }
          if (action === 'add') {
            try {
              const tmpl = JSON.parse(args.template as string) as PromptTemplate;
              this.addTemplate(args.name as string, tmpl);
              return Promise.resolve(`模板 "${args.name}" 添加成功`);
            } catch (e: unknown) {
              return Promise.resolve(`模板解析失败: ${(e instanceof Error ? e.message : String(e))}`);
            }
          }
          return Promise.resolve(`未知操作: ${action}`);
        },
      },
    ];
  }

  // ========== 私有方法 ==========

  /** 应用模板规则 */
  private applyTemplateRules(prompt: string, template: PromptTemplate): { optimized: string; improvements: string[] } {
    const improvements: string[] = [];
    let optimized = prompt;

    // 添加系统前缀
    if (template.systemPrefix && !prompt.includes(template.systemPrefix)) {
      optimized = `${template.systemPrefix}\n\n${optimized}`;
      improvements.push(`添加了 ${template.target} 类型的系统前缀`);
    }

    // 添加系统后缀
    if (template.systemSuffix && !prompt.includes(template.systemSuffix)) {
      optimized = `${optimized}\n\n${template.systemSuffix}`;
      improvements.push(`添加了 ${template.target} 类型的系统后缀`);
    }

    // 添加规则约束
    if (template.rules.length > 0 && !/要求|约束|规则|必须/.test(prompt)) {
      const ruleText = template.rules.map((r, i) => `${i + 1}. ${r}`).join('\n');
      optimized = `${optimized}\n\n要求：\n${ruleText}`;
      improvements.push(`添加了 ${template.rules.length} 条 ${template.target} 类型规则`);
    }

    // 添加 few-shot 示例（仅在提示词较短时）
    if (template.fewShotExamples.length > 0 && prompt.length < 200) {
      const exampleText = template.fewShotExamples
        .map((ex, i) => `示例${i + 1}:\n输入: ${ex.input}\n输出: ${ex.output}`)
        .join('\n\n');
      optimized = `${optimized}\n\n参考示例：\n${exampleText}`;
      improvements.push('添加了 few-shot 示例引导');
    }

    return { optimized, improvements };
  }

  /** 目标特定优化 */
  private applyTargetSpecificOptimization(prompt: string, target: PromptTarget): { optimized: string; improvements: string[] } {
    const improvements: string[] = [];
    let optimized = prompt;

    switch (target) {
      case 'code_generation':
        if (!/语言|框架|版本/.test(prompt)) {
          optimized += '\n请明确指定编程语言和框架版本。';
          improvements.push('补充了语言/框架指定提示');
        }
        if (!/错误处理|异常|边界/.test(prompt)) {
          optimized += '\n包含完整的错误处理和边界检查。';
          improvements.push('补充了错误处理要求');
        }
        break;

      case 'code_review':
        if (!/安全|性能|可读|维护/.test(prompt)) {
          optimized += '\n请从安全、性能、可读性、可维护性四个维度审查。';
          improvements.push('补充了四维审查要求');
        }
        if (!/行号|具体/.test(prompt)) {
          optimized += '\n引用具体行号，标注严重级别。';
          improvements.push('补充了行号引用要求');
        }
        break;

      case 'reasoning':
        if (!/逐步|步骤|step/.test(prompt)) {
          optimized = `[请逐步推理]\n${optimized}`;
          improvements.push('添加了逐步推理指令');
        }
        if (!/边界|反例|edge case/.test(prompt)) {
          optimized += '\n考虑边界情况和反例。';
          improvements.push('补充了边界情况考虑');
        }
        break;

      case 'creative':
        if (!/方案|方向|选项/.test(prompt)) {
          optimized += '\n请提供至少3个差异化方案，每个包含核心思路和可行性评估。';
          improvements.push('补充了多方案要求');
        }
        break;

      case 'tool_call':
        if (!/参数|必填|可选/.test(prompt)) {
          optimized += '\n请精确指定参数，区分必填和可选参数。';
          improvements.push('补充了参数精确性要求');
        }
        break;

      case 'search_query':
        // 搜索查询优化：提取关键词，去除虚词
        optimized = this.optimizeSearchQuery(prompt);
        improvements.push('将自然语言转为关键词搜索');
        break;

      case 'documentation':
        if (!/概述|API|示例|FAQ/.test(prompt)) {
          optimized += '\n文档需包含：概述、API参考、使用示例、常见问题。';
          improvements.push('补充了文档结构要求');
        }
        break;

      case 'testing':
        if (!/正常|边界|异常|安全/.test(prompt)) {
          optimized += '\n覆盖正常路径、边界条件、异常路径和安全测试。';
          improvements.push('补充了测试覆盖要求');
        }
        break;
    }

    return { optimized, improvements };
  }

  /** 通用优化 */
  private applyGeneralOptimization(prompt: string): { optimized: string; improvements: string[] } {
    const improvements: string[] = [];
    let optimized = prompt;

    // 去除重复空白
    const deduplicated = optimized.replace(/\n{3,}/g, '\n\n').replace(/ {2,}/g, ' ');
    if (deduplicated !== optimized) {
      optimized = deduplicated;
      improvements.push('去除了多余空白');
    }

    // 消除模糊表达
    const ambiguityMap: Record<string, string> = {
      '差不多': '具体明确',
      '大概': '精确',
      '可能': '需要确认是否',
      '尽量': '务必',
      '看看': '详细检查并分析',
      '弄一下': '完成具体实现',
      '搞一下': '完成具体实现',
    };
    for (const [ambiguous, clear] of Object.entries(ambiguityMap)) {
      if (optimized.includes(ambiguous)) {
        optimized = optimized.replaceAll(ambiguous, clear);
        improvements.push(`消除模糊表达: "${ambiguous}" → "${clear}"`);
      }
    }

    return { optimized, improvements };
  }

  /** 搜索查询优化 */
  private optimizeSearchQuery(query: string): string {
    // 去除常见虚词
    const stopWords = ['的', '了', '是', '在', '有', '和', '与', '或', '怎么', '如何', '什么', '为什么', '哪', '那个', '这个'];
    let result = query;

    // 如果是自然语言问句，提取关键词
    if (/[？?]/.test(query) || /^(怎么|如何|什么|为什么)/.test(query)) {
      let keywords = query
        .replace(/[？?！!。，,、；;：:""''（）()【】[\]{}]/g, ' ')
        .split(/\s+/)
        .filter(w => w.length > 0 && !stopWords.includes(w));

      // 添加英文同义词提示
      const techTermMap: Record<string, string> = {
        '内存泄漏': 'memory leak',
        '性能优化': 'performance optimization',
        '并发': 'concurrency parallel',
        '安全': 'security vulnerability',
        '测试': 'testing unit test',
        '部署': 'deployment CI/CD',
        '调试': 'debugging troubleshooting',
      };

      const synonyms: string[] = [];
      for (const [cn, en] of Object.entries(techTermMap)) {
        if (query.includes(cn)) {
          synonyms.push(en);
        }
      }

      if (synonyms.length > 0) {
        keywords = [...keywords, ...synonyms];
      }

      result = keywords.join(' ');
    }

    return result;
  }

  /** 计算质量评分（0-100） */
  private calculateQualityScore(prompt: string): number {
    let score = 50;

    // 清晰度
    if (prompt.length >= 20) score += 5;
    if (prompt.length >= 50) score += 5;
    if (/请|要求|需要|必须/.test(prompt)) score += 5;

    // 具体性
    if (/具体|详细|明确|精确/.test(prompt)) score += 5;
    if (/\d+/.test(prompt)) score += 5; // 包含数字
    if (/语言|框架|版本|格式/.test(prompt)) score += 5;

    // 完整性
    if (/约束|限制|边界|条件/.test(prompt)) score += 5;
    if (/示例|例如|参考/.test(prompt)) score += 5;
    if (/输出|格式|结果/.test(prompt)) score += 5;

    // 扣分项
    const ambiguousWords = ['大概', '差不多', '可能', '一些', '某种', '弄一下', '搞一下'];
    const ambiguousCount = ambiguousWords.filter(w => prompt.includes(w)).length;
    score -= ambiguousCount * 5;

    if (prompt.length < 10) score -= 15;

    return Math.max(0, Math.min(100, score));
  }

  /** 估算 token 节省 */
  private estimateTokenSavings(original: string, optimized: string): number {
    // 粗略估算：中文约 1.5 token/字，英文约 0.75 token/词
    const _originalTokens = Math.ceil(original.length * 0.8);
    const _optimizedTokens = Math.ceil(optimized.length * 0.8);

    // 优化后通常更长（添加了规则和上下文），但信息密度更高
    // token 节省体现在减少多轮对话的澄清次数
    const qualityGain = this.calculateQualityScore(optimized) - this.calculateQualityScore(original);
    const savingsFromReducedRounds = Math.max(0, qualityGain * 5); // 每分质量提升约节省5 tokens

    return Math.round(savingsFromReducedRounds);
  }

  // ========== 质量评估子方法 ==========

  private assessClarity(prompt: string, issues: string[], suggestions: string[]): number {
    let score = 0.5;

    if (prompt.length >= 20) score += 0.15;
    if (prompt.length >= 50) score += 0.1;
    if (/请|帮我|需要|要求/.test(prompt)) score += 0.1;

    const ambiguousWords = ['大概', '差不多', '可能', '一些', '某种', '弄一下', '搞一下', '看看'];
    const ambiguousCount = ambiguousWords.filter(w => prompt.includes(w)).length;
    score -= ambiguousCount * 0.1;

    if (prompt.length < 10) {
      score -= 0.2;
      issues.push('提示词过短，目标不明确');
      suggestions.push('添加更详细的描述和目标');
    }


    if (ambiguousCount > 0) {
      issues.push(`包含 ${ambiguousCount} 个模糊表达`);
      suggestions.push('将模糊表达替换为具体描述');
    }

    return Math.max(0, Math.min(1, score));
  }

  private assessSpecificity(prompt: string, issues: string[], suggestions: string[]): number {
    let score = 0.3;

    const specificIndicators = ['具体', '详细', '明确', '精确', '包含', '要求', '格式', '步骤', '标准', '规范', '完整'];
    score += specificIndicators.filter(w => prompt.includes(w)).length * 0.07;

    if (/\d+/.test(prompt)) score += 0.1;

    if (score < 0.5) {
      issues.push('缺少具体的量化要求');
      suggestions.push('添加具体的数量、时间或质量标准');
    }

    return Math.max(0, Math.min(1, score));
  }

  private assessCompleteness(prompt: string, issues: string[], suggestions: string[]): number {
    let score = 0.2;

    if (/要求|需要|必须|应当/.test(prompt)) score += 0.15;
    if (/格式|输出|结果/.test(prompt)) score += 0.15;
    if (/例如|比如|示例|参考/.test(prompt)) score += 0.15;
    if (/约束|限制|边界|条件/.test(prompt)) score += 0.15;
    if (/错误|异常|边界/.test(prompt)) score += 0.1;

    if (score < 0.5) {
      issues.push('提示词缺少必要的要求说明');
      suggestions.push('添加输出格式、约束条件和示例');
    }

    return Math.max(0, Math.min(1, score));
  }

  private assessConciseness(prompt: string, issues: string[], suggestions: string[]): number {
    let score = 0.7;

    // 过长可能冗余
    if (prompt.length > 2000) {
      score -= 0.2;
      issues.push('提示词过长，可能包含冗余信息');
      suggestions.push('精简重复内容，聚焦核心要求');
    }

    // 重复句子
    const sentences = prompt.split(/[。！？\n]/).filter(s => s.trim().length > 0);
    const uniqueSentences = new Set(sentences.map(s => s.trim()));
    if (sentences.length > uniqueSentences.size + 2) {
      score -= 0.15;
      issues.push('存在重复表述');
      suggestions.push('去除重复的句子和表述');
    }

    // 适中的长度最佳
    if (prompt.length >= 30 && prompt.length <= 500) score += 0.15;
    if (prompt.length < 15) {
      score -= 0.2;
      issues.push('提示词过短，信息不足');
      suggestions.push('补充必要的上下文和要求');
    }

    return Math.max(0, Math.min(1, score));
  }

  // ========== 模型适配方法 ==========

  private formatForCodeModel(prompt: string): string {
    // DeepSeek/Coder 偏好：结构化指令
    if (!/```/.test(prompt) && /代码|函数|实现/.test(prompt)) {
      return `${prompt}\n\n请用代码块格式输出，包含完整的类型定义。`;
    }
    return prompt;
  }

  private formatForClaude(prompt: string): string {
    // Claude 偏好：XML 标签分段
    if (prompt.length > 200 && !/<|>/.test(prompt)) {
      return `<task>\n${prompt}\n</task>\n\n请仔细分析上述任务要求，逐步完成。`;
    }
    return prompt;
  }

  private formatForGPT(prompt: string): string {
    // GPT 偏好：Markdown 格式
    if (!/^#|^##|^-/.test(prompt) && prompt.length > 100) {
      return `## 任务\n${prompt}\n\n## 要求\n请按步骤完成，输出结构化结果。`;
    }
    return prompt;
  }

  private formatForGemini(prompt: string): string {
    // Gemini 偏好：简洁直接
    return prompt.replace(/\n{3,}/g, '\n\n');
  }

  private formatForLlama(prompt: string): string {
    // Llama 偏好：简洁指令 + 少样本
    if (prompt.length > 500) {
      // 截取核心指令
      const lines = prompt.split('\n').filter(l => l.trim().length > 0);
      return lines.slice(0, 10).join('\n');
    }
    return prompt;
  }
}
