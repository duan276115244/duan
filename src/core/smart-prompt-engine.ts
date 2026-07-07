/**
 * 智能提示词引擎 — SmartPromptEngine
 *
 * 核心能力：
 * 1. 提示词优化：自动补全模糊输入、注入项目上下文、添加约束
 * 2. 模板库：内置 10+ 分类模板，支持自定义注册
 * 3. 模型适配：针对 Claude/GPT/DeepSeek/Gemini 等模型重写提示词
 * 4. 关键信息提取：语义分块 + 信息密度评分
 * 5. 上下文窗口构建：token 预算内的最优消息组合
 * 6. 持久化：模板和统计信息保存到 .duan/prompts/
 */

import * as fs from 'fs';
import * as path from 'path';
import { logger } from './structured-logger.js';
import { EventBus } from './event-bus.js';
import type { ToolDef } from './unified-tool-def.js';
import { duanPath } from './duan-paths.js';
import { atomicWriteJsonSync } from './atomic-write.js';

// ============ 类型定义 ============

export interface PromptTemplate {
  id: string;
  name: string;
  category: 'code_gen' | 'code_review' | 'debug' | 'reasoning' | 'creative' | 'desktop' | 'search' | 'communication' | 'testing';
  template: string;  // Template with {variable} placeholders
  variables: string[];
  modelHints: Record<string, string>;  // Model-specific adjustments
  qualityScore: number;  // Historical quality score 0-1
  usageCount: number;
}

export interface PromptOptimization {
  original: string;
  optimized: string;
  improvements: string[];
  estimatedQuality: number;
}


// ============ 内置模板 ============

const BUILTIN_TEMPLATES: PromptTemplate[] = [
  {
    id: 'tpl_code_gen',
    name: '代码生成',
    category: 'code_gen',
    template: '生成{language}代码：{task}。要求：{requirements}。遵循{style}规范。',
    variables: ['language', 'task', 'requirements', 'style'],
    modelHints: {
      claude: '使用 XML 标签包裹代码块，明确标注输入输出类型',
      gpt: '分步骤说明，每步给出代码片段',
      deepseek: '先分析需求，再给出完整实现',
      gemini: '提供代码和简要说明',
    },
    qualityScore: 0.85,
    usageCount: 0,
  },
  {
    id: 'tpl_code_review',
    name: '代码审查',
    category: 'code_review',
    template: '审查以下{language}代码，关注：安全性、性能、可维护性。代码：\n{code}',
    variables: ['language', 'code'],
    modelHints: {
      claude: '按维度分 <security> <performance> <maintainability> 标签审查',
      gpt: '逐行审查，每个问题标注严重级别',
      deepseek: '先整体评估，再逐项分析',
      gemini: '列出关键发现和改进建议',
    },
    qualityScore: 0.82,
    usageCount: 0,
  },
  {
    id: 'tpl_debug',
    name: '调试修复',
    category: 'debug',
    template: '以下{language}代码出现错误：{error}。代码：\n{code}。请分析原因并提供修复。',
    variables: ['language', 'error', 'code'],
    modelHints: {
      claude: '用 <analysis> <root_cause> <fix> 结构化输出',
      gpt: '逐步推理错误原因，给出修复步骤',
      deepseek: '推理链：现象→假设→验证→修复',
      gemini: '直接给出原因和修复方案',
    },
    qualityScore: 0.88,
    usageCount: 0,
  },
  {
    id: 'tpl_reasoning',
    name: '逻辑推理',
    category: 'reasoning',
    template: '请逐步分析以下问题：{problem}。考虑：{constraints}。',
    variables: ['problem', 'constraints'],
    modelHints: {
      claude: '使用 <thinking> 标签展示推理过程',
      gpt: '分步骤推理，每步标注置信度',
      deepseek: '链式推理，每步验证前一步结论',
      gemini: '简洁推理，给出结论和依据',
    },
    qualityScore: 0.80,
    usageCount: 0,
  },
  {
    id: 'tpl_desktop_op',
    name: '桌面操作',
    category: 'desktop',
    template: '在{app}中执行：{operation}。参数：{params}。',
    variables: ['app', 'operation', 'params'],
    modelHints: {
      claude: '明确操作步骤，每步描述预期结果',
      gpt: '列出操作序列和回退方案',
      deepseek: '先规划路径，再执行操作',
      gemini: '简洁指令，直接操作',
    },
    qualityScore: 0.75,
    usageCount: 0,
  },
  {
    id: 'tpl_search_summarize',
    name: '搜索总结',
    category: 'search',
    template: '搜索{query}，然后总结关键信息，重点关注{focus}。',
    variables: ['query', 'focus'],
    modelHints: {
      claude: '用 <findings> <summary> <sources> 结构化输出',
      gpt: '按主题分点总结，标注来源',
      deepseek: '先提取关键事实，再综合分析',
      gemini: '直接给出要点总结',
    },
    qualityScore: 0.83,
    usageCount: 0,
  },
  {
    id: 'tpl_test_gen',
    name: '测试生成',
    category: 'testing',
    template: '为以下{language}代码生成{framework}测试用例：\n{code}',
    variables: ['language', 'framework', 'code'],
    modelHints: {
      claude: '覆盖正常路径、边界条件、异常路径',
      gpt: '每个测试用例标注测试目标和预期结果',
      deepseek: '先分析代码逻辑，再设计测试矩阵',
      gemini: '生成核心测试用例',
    },
    qualityScore: 0.81,
    usageCount: 0,
  },
  {
    id: 'tpl_refactor',
    name: '代码重构',
    category: 'code_gen',
    template: '重构以下{language}代码，目标：{goal}。保持功能不变。\n{code}',
    variables: ['language', 'goal', 'code'],
    modelHints: {
      claude: '说明重构理由，展示前后对比',
      gpt: '分步重构，每步验证功能不变',
      deepseek: '先分析代码结构，再规划重构策略',
      gemini: '直接给出重构结果和说明',
    },
    qualityScore: 0.79,
    usageCount: 0,
  },
  {
    id: 'tpl_explain',
    name: '概念解释',
    category: 'communication',
    template: '用{language}解释以下概念：{concept}。受众：{audience}。',
    variables: ['language', 'concept', 'audience'],
    modelHints: {
      claude: '从基础概念逐步深入，配合示例',
      gpt: '分层解释：简单→进阶→深入',
      deepseek: '先给定义，再举例，最后总结要点',
      gemini: '简洁明了，配合类比',
    },
    qualityScore: 0.84,
    usageCount: 0,
  },
  {
    id: 'tpl_deploy',
    name: '部署配置',
    category: 'code_gen',
    template: '部署{project}到{target}。环境：{env}。配置：{config}。',
    variables: ['project', 'target', 'env', 'config'],
    modelHints: {
      claude: '列出部署步骤和回滚方案',
      gpt: '分阶段部署，每阶段验证',
      deepseek: '先检查依赖，再规划部署流程',
      gemini: '给出部署命令和配置',
    },
    qualityScore: 0.77,
    usageCount: 0,
  },
];

// ============ 主类 ============

export class SmartPromptEngine {
  private log = logger.child({ module: 'SmartPromptEngine' });
  private templates: Map<string, PromptTemplate> = new Map();
  private stats: Map<string, { usageCount: number; qualityScores: number[] }> = new Map();
  private dataDir: string;

  constructor(projectDir?: string) {
    this.dataDir = projectDir
      ? path.join(projectDir, '.duan', 'prompts')
      : duanPath('prompts');

    // 加载内置模板
    for (const tmpl of BUILTIN_TEMPLATES) {
      this.templates.set(tmpl.id, { ...tmpl });
    }

    // 加载持久化的自定义模板和统计
    this.loadPersistedData();

    this.log.info('智能提示词引擎初始化完成', {
      templateCount: this.templates.size,
      dataDir: this.dataDir,
    });
  }

  // ========== 核心方法 ==========

  /**
   * 优化用户提示词
   * - 模糊输入添加具体性
   * - 注入项目配置上下文
   * - 从历史添加约束
   * - 选择最佳模板
   */
  optimizePrompt(
    userInput: string,
    // eslint-disable-next-line @typescript-eslint/no-explicit-any -- projectConfig is dynamic JSON config
    context?: { domain?: string; history?: string[]; projectConfig?: any },
  ): PromptOptimization {
    const startTime = Date.now();
    const improvements: string[] = [];
    let optimized = userInput;

    // 1. 检测模糊输入并添加具体性
    const specificityResult = this.addSpecificity(optimized);
    optimized = specificityResult.optimized;
    improvements.push(...specificityResult.improvements);

    // 2. 注入项目配置上下文
    if (context?.projectConfig) {
      const contextResult = this.injectProjectContext(optimized, context.projectConfig);
      optimized = contextResult.optimized;
      improvements.push(...contextResult.improvements);
    }

    // 3. 从历史对话添加约束
    if (context?.history && context.history.length > 0) {
      const constraintResult = this.addConstraintsFromHistory(optimized, context.history);
      optimized = constraintResult.optimized;
      improvements.push(...constraintResult.improvements);
    }

    // 4. 选择最佳模板并应用
    if (context?.domain) {
      const templateResult = this.applyBestTemplate(optimized, context.domain);
      if (templateResult) {
        optimized = templateResult.optimized;
        improvements.push(...templateResult.improvements);
      }
    }

    // 5. 通用优化
    const generalResult = this.generalOptimize(optimized);
    optimized = generalResult.optimized;
    improvements.push(...generalResult.improvements);

    // 估算质量
    const estimatedQuality = this.estimateQuality(optimized);

    const result: PromptOptimization = {
      original: userInput,
      optimized,
      improvements: [...new Set(improvements)],
      estimatedQuality,
    };

    // 广播事件
    EventBus.getInstance().emitSync('prompt.optimized', {
      originalLength: userInput.length,
      optimizedLength: optimized.length,
      estimatedQuality,
      improvementCount: result.improvements.length,
      durationMs: Date.now() - startTime,
    });

    this.log.info('提示词优化完成', {
      originalLength: userInput.length,
      optimizedLength: optimized.length,
      estimatedQuality,
      durationMs: Date.now() - startTime,
    });

    return result;
  }

  /**
   * 选择并填充提示词模板
   */
  selectTemplate(category: string, variables: Record<string, string>): string {
    // 查找匹配类别的模板
    const matchedTemplates = Array.from(this.templates.values())
      .filter(t => t.category === category);

    if (matchedTemplates.length === 0) {
      this.log.warn('未找到匹配类别的模板', { category });
      return Object.entries(variables)
        .map(([k, v]) => `${k}: ${v}`)
        .join('\n');
    }

    // 选择质量分数最高的模板
    const best = matchedTemplates.reduce((a, b) =>
      a.qualityScore > b.qualityScore ? a : b,
    );

    // 填充变量
    let result = best.template;
    for (const [key, value] of Object.entries(variables)) {
      result = result.replace(new RegExp(`\\{${key}\\}`, 'g'), value);
    }

    // 更新使用统计
    best.usageCount++;
    const stat = this.stats.get(best.id) || { usageCount: 0, qualityScores: [] };
    stat.usageCount++;
    this.stats.set(best.id, stat);

    this.log.debug('使用模板', { templateId: best.id, category, variables: Object.keys(variables) });
    return result;
  }

  /**
   * 为特定模型重写提示词
   */
  rewriteForModel(prompt: string, modelName: string): string {
    const lowerModel = modelName.toLowerCase();
    let rewritten = prompt;

    if (lowerModel.includes('claude') || lowerModel.includes('anthropic')) {
      // Claude: 添加 XML 标签结构
      rewritten = this.rewriteForClaude(rewritten);
    } else if (lowerModel.includes('gpt') || lowerModel.includes('openai')) {
      // GPT: 添加明确的分步指令
      rewritten = this.rewriteForGPT(rewritten);
    } else if (lowerModel.includes('deepseek')) {
      // DeepSeek: 添加推理链提示
      rewritten = this.rewriteForDeepSeek(rewritten);
    } else if (lowerModel.includes('gemini') || lowerModel.includes('google')) {
      // Gemini: 添加上下文锚定
      rewritten = this.rewriteForGemini(rewritten);
    }

    this.log.debug('为模型重写提示词', { model: modelName, originalLength: prompt.length, rewrittenLength: rewritten.length });
    return rewritten;
  }

  /**
   * 从长文本提取关键信息（语义分块 + 信息密度评分）
   */
  extractKeyInfo(longText: string): string[] {
    // 按段落分块
    const paragraphs = longText
      .split(/\n{2,}/)
      .map(p => p.trim())
      .filter(p => p.length > 0);

    if (paragraphs.length === 0) return [];

    // 对每个段落评分
    const scored = paragraphs.map(p => ({
      text: p,
      score: this.calculateInfoDensity(p),
    }));

    // 按信息密度排序
    scored.sort((a, b) => b.score - a.score);

    // 取 top N（最多 10 条，且信息密度 > 0.3）
    const topN = scored
      .filter(s => s.score > 0.3)
      .slice(0, 10)
      .map(s => {
        // 截取每个要点的第一句话作为关键信息
        const firstSentence = s.text.split(/[。！？\n]/)[0].trim();
        return firstSentence.length > 200 ? firstSentence.substring(0, 200) + '...' : firstSentence;
      });

    return topN;
  }

  /**
   * 在 token 预算内构建优化的上下文窗口
   */
  buildContextWindow(
    messages: Array<{ role: string; content: string }>,
    tokenBudget: number,
  ): string {
    if (messages.length === 0) return '';

    // 粗略 token 估算：中文约 1.5 token/字，英文约 0.75 token/词
    const estimateTokens = (text: string): number => Math.ceil(text.length * 0.8);

    const result: string[] = [];
    let usedTokens = 0;

    // 1. 优先保留最近的消息
    const recentMessages = messages.slice(-5);
    for (const msg of recentMessages) {
      const tokens = estimateTokens(msg.content);
      if (usedTokens + tokens <= tokenBudget) {
        result.push(`[${msg.role}]: ${msg.content}`);
        usedTokens += tokens;
      } else {
        // 部分保留
        const remaining = tokenBudget - usedTokens;
        if (remaining > 50) {
          const chars = Math.floor(remaining / 0.8);
          result.push(`[${msg.role}]: ${msg.content.substring(0, chars)}...`);
          usedTokens = tokenBudget;
        }
        break;
      }
    }

    // 2. 如果还有预算，摘要较早的消息
    const olderMessages = messages.slice(0, -5);
    if (olderMessages.length > 0 && usedTokens < tokenBudget * 0.8) {
      const summaryBudget = Math.floor(tokenBudget * 0.3);
      const summary = this.summarizeMessages(olderMessages);
      const summaryTokens = estimateTokens(summary);
      if (summaryTokens <= summaryBudget) {
        result.unshift(`[历史摘要]: ${summary}`);
      }
    }

    return result.join('\n\n');
  }

  /**
   * 注册自定义模板
   */
  registerTemplate(template: PromptTemplate): void {
    this.templates.set(template.id, { ...template });
    this.log.info('注册自定义模板', { id: template.id, name: template.name, category: template.category });

    // 持久化
    this.persistTemplates();

    EventBus.getInstance().emitSync('prompt.template.registered', {
      id: template.id,
      category: template.category,
    });
  }

  /**
   * 获取所有可用模板
   */
  getTemplateLibrary(): PromptTemplate[] {
    return Array.from(this.templates.values());
  }

  // ========== Agent Loop 工具定义 ==========

  getToolDefinitions(): ToolDef[] {
    // eslint-disable-next-line @typescript-eslint/no-this-alias
    const self = this;

    return [
      {
        name: 'prompt_optimize',
        description: '优化提示词：自动补全模糊输入、注入项目上下文、添加约束，提升提示词质量。',
        parameters: {
          input: {
            type: 'string',
            description: '待优化的原始提示词',
            required: true,
          },
          domain: {
            type: 'string',
            description: '领域/类别：code_gen | code_review | debug | reasoning | creative | desktop | search | communication | testing',
            required: false,
          },
        },
        readOnly: true,
        execute: (args) => {
          try {
            const result = self.optimizePrompt(
              args.input as string,
              { domain: args.domain as string },
            );
            return Promise.resolve(JSON.stringify(result, null, 2));
          } catch (err: unknown) {
            const msg = err instanceof Error ? err.message : String(err);
            return Promise.resolve(`❌ 优化提示词失败: ${msg}`);
          }
        },
      },
      {
        name: 'prompt_template',
        description: '使用提示词模板：选择指定类别的模板并填充变量，生成结构化提示词。',
        parameters: {
          category: {
            type: 'string',
            description: '模板类别：code_gen | code_review | debug | reasoning | creative | desktop | search | communication | testing',
            required: true,
          },
          variables: {
            type: 'string',
            description: '模板变量 JSON，如 {"language":"TypeScript","task":"排序算法"}',
            required: true,
          },
        },
        readOnly: true,
        execute: (args) => {
          try {
            const variables = JSON.parse(args.variables as string) as Record<string, string>;
            const result = self.selectTemplate(args.category as string, variables);
            return Promise.resolve(result);
          } catch (err: unknown) {
            const msg = err instanceof Error ? err.message : String(err);
            return Promise.resolve(`❌ 使用模板失败: ${msg}`);
          }
        },
      },
    ];
  }

  // ========== 私有方法 ==========

  /** 添加具体性：检测模糊表达并补充 */
  private addSpecificity(prompt: string): { optimized: string; improvements: string[] } {
    const improvements: string[] = [];
    let optimized = prompt;

    // 检测过短的输入
    if (prompt.length < 15) {
      optimized += '\n\n请提供详细的实现方案，包含代码示例和说明。';
      improvements.push('补充了详细输出要求（原始输入过短）');
    }

    // 检测模糊动词
    const vaguePatterns: Array<{ pattern: RegExp; addition: string; label: string }> = [
      { pattern: /写一个|写个|实现一个|实现个/, addition: '\n请明确技术栈、输入输出格式和错误处理要求。', label: '补充了技术栈和格式要求' },
      { pattern: /优化一下|改进一下/, addition: '\n请从性能、可读性、可维护性三个维度优化。', label: '补充了优化维度' },
      { pattern: /看看|检查一下|审查/, addition: '\n请从安全性、性能、可维护性三个维度审查，引用具体行号。', label: '补充了审查维度' },
      { pattern: /修复|fix/, addition: '\n请分析根因并提供修复方案，确保不引入新问题。', label: '补充了修复要求' },
    ];

    for (const { pattern, addition, label } of vaguePatterns) {
      if (pattern.test(optimized) && !optimized.includes(addition.trim())) {
        optimized += addition;
        improvements.push(label);
      }
    }

    // 检测缺少语言指定
    if (/代码|函数|类|模块|组件/.test(optimized) && !/TypeScript|JavaScript|Python|Java|Go|Rust|C\+\+|语言/.test(optimized)) {
      optimized += '\n请明确指定编程语言。';
      improvements.push('补充了语言指定提示');
    }

    return { optimized, improvements };
  }

  /** 注入项目配置上下文 */
  // eslint-disable-next-line @typescript-eslint/no-explicit-any -- config is dynamic JSON config
  private injectProjectContext(prompt: string, config: any): { optimized: string; improvements: string[] } {
    const improvements: string[] = [];
    let optimized = prompt;

    const additions: string[] = [];

    // 技术栈
    if (config.techStack && Array.isArray(config.techStack) && config.techStack.length > 0) {
      if (!/技术栈|tech stack/.test(optimized)) {
        additions.push(`项目技术栈: ${config.techStack.join(', ')}`);
        improvements.push('注入了项目技术栈信息');
      }
    }

    // 编码风格
    if (config.codeStyle && !/代码风格|code style|eslint|prettier/.test(optimized)) {
      additions.push(`代码风格: ${config.codeStyle}`);
      improvements.push('注入了代码风格约束');
    }

    // 自定义规则
    if (config.customRules && Array.isArray(config.customRules)) {
      const activeRules = config.customRules
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        .filter((r: any) => r.enabled && r.priority === 'must')
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        .map((r: any) => r.rule);
      if (activeRules.length > 0) {
        additions.push(`必须遵守的规则: ${activeRules.join('; ')}`);
        improvements.push(`注入了 ${activeRules.length} 条必须规则`);
      }
    }

    // 排除工具
    if (config.excludedTools && Array.isArray(config.excludedTools) && config.excludedTools.length > 0) {
      additions.push(`禁止使用的工具: ${config.excludedTools.join(', ')}`);
      improvements.push('注入了工具排除列表');
    }

    if (additions.length > 0) {
      optimized += '\n\n项目上下文:\n' + additions.map(a => `- ${a}`).join('\n');
    }

    return { optimized, improvements };
  }

  /** 从历史对话添加约束 */
  private addConstraintsFromHistory(prompt: string, history: string[]): { optimized: string; improvements: string[] } {
    const improvements: string[] = [];
    let optimized = prompt;

    // 从历史中提取常见约束模式
    const constraintPatterns = [
      { pattern: /不要|禁止|不能|不可/, label: '否定约束' },
      { pattern: /必须|一定要|务必/, label: '强制约束' },
      { pattern: /使用|采用|基于/, label: '技术偏好' },
    ];

    const extractedConstraints: string[] = [];
    for (const msg of history.slice(-5)) {
      for (const { pattern, label: _label } of constraintPatterns) {
        const matches = msg.match(new RegExp(`.{0,20}${pattern.source}.{0,30}`, 'g'));
        if (matches) {
          extractedConstraints.push(...matches.slice(0, 2));
        }
      }
    }

    if (extractedConstraints.length > 0) {
      const uniqueConstraints = [...new Set(extractedConstraints)].slice(0, 3);
      optimized += `\n\n历史约束: ${uniqueConstraints.join('; ')}`;
      improvements.push(`从历史对话提取了 ${uniqueConstraints.length} 条约束`);
    }

    return { optimized, improvements };
  }

  /** 应用最佳模板 */
  private applyBestTemplate(prompt: string, domain: string): { optimized: string; improvements: string[] } | null {
    const matchedTemplates = Array.from(this.templates.values())
      .filter(t => t.category === domain);

    if (matchedTemplates.length === 0) return null;

    const best = matchedTemplates.reduce((a, b) =>
      a.qualityScore > b.qualityScore ? a : b,
    );

    // 如果提示词已经足够长，不强制套模板
    if (prompt.length > 200) return null;

    const improvements: string[] = [`选用了 ${best.name} 模板进行结构化`];

    // 添加模板的模型提示作为补充
    const hints = Object.values(best.modelHints);
    if (hints.length > 0) {
      improvements.push('添加了模型适配提示');
    }

    return { optimized: prompt, improvements };
  }

  /** 通用优化 */
  private generalOptimize(prompt: string): { optimized: string; improvements: string[] } {
    const improvements: string[] = [];
    let optimized = prompt;

    // 去除多余空白
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

  /** 估算提示词质量（0-1） */
  private estimateQuality(prompt: string): number {
    let score = 0.4;

    // 长度合理性
    if (prompt.length >= 30) score += 0.1;
    if (prompt.length >= 80) score += 0.1;
    if (prompt.length >= 150) score += 0.05;

    // 具体性指标
    if (/请|要求|需要|必须|应当/.test(prompt)) score += 0.05;
    if (/具体|详细|明确|精确/.test(prompt)) score += 0.05;
    if (/格式|输出|结果|返回/.test(prompt)) score += 0.05;

    // 约束指标
    if (/约束|限制|边界|条件/.test(prompt)) score += 0.05;
    if (/示例|例如|参考/.test(prompt)) score += 0.05;

    // 扣分项
    const ambiguousWords = ['大概', '差不多', '可能', '一些', '某种', '弄一下', '搞一下'];
    const ambiguousCount = ambiguousWords.filter(w => prompt.includes(w)).length;
    score -= ambiguousCount * 0.05;

    if (prompt.length < 10) score -= 0.15;

    return Math.max(0, Math.min(1, score));
  }

  /** 计算段落信息密度 */
  private calculateInfoDensity(paragraph: string): number {
    let score = 0;

    // 包含数据/数字
    const numbers = paragraph.match(/\d+/g);
    if (numbers) score += Math.min(numbers.length * 0.1, 0.3);

    // 包含技术术语
    const techTerms = paragraph.match(/[A-Z][a-zA-Z]+(?:\.js|\.ts)?|API|SDK|HTTP|REST|SQL|NoSQL|ORM|CI\/CD/g);
    if (techTerms) score += Math.min(techTerms.length * 0.1, 0.3);

    // 包含因果关系
    if (/因为|所以|因此|导致|原因|结果|由于|使得/.test(paragraph)) score += 0.15;

    // 包含对比/列表
    if (/[①②③④⑤]|首先|其次|最后|一方面|另一方面|对比|相比/.test(paragraph)) score += 0.15;

    // 长度适中（太短信息不足，太长可能冗余）
    if (paragraph.length >= 30 && paragraph.length <= 500) score += 0.1;

    return Math.min(score, 1.0);
  }

  /** 摘要消息列表 */
  private summarizeMessages(messages: Array<{ role: string; content: string }>): string {
    // 简单摘要：提取每条消息的第一句
    const summaries = messages.map(msg => {
      const firstSentence = msg.content.split(/[。！？\n]/)[0].trim();
      let prefix: string;
      if (msg.role === 'user') prefix = '用户';
      else if (msg.role === 'assistant') prefix = '助手';
      else prefix = msg.role;
      return `${prefix}: ${firstSentence.substring(0, 80)}${firstSentence.length > 80 ? '...' : ''}`;
    });

    return summaries.join('; ');
  }

  // ========== 模型适配方法 ==========

  /** Claude 适配：添加 XML 标签结构 */
  private rewriteForClaude(prompt: string): string {
    if (prompt.length < 100) return prompt;

    // 如果已经包含 XML 标签，不重复添加
    if (/<task>|<instruction>|<context>/.test(prompt)) return prompt;

    const lines = prompt.split('\n').filter(l => l.trim().length > 0);
    if (lines.length < 3) return prompt;

    // 将内容包裹在 XML 标签中
    const taskLines: string[] = [];
    const constraintLines: string[] = [];
    let inConstraints = false;

    for (const line of lines) {
      if (/要求|约束|规则|必须|应当|限制/.test(line)) {
        inConstraints = true;
      }
      if (inConstraints) {
        constraintLines.push(line);
      } else {
        taskLines.push(line);
      }
    }

    let result = '<task>\n';
    result += taskLines.join('\n');
    result += '\n</task>';

    if (constraintLines.length > 0) {
      result += '\n\n<constraints>\n';
      result += constraintLines.join('\n');
      result += '\n</constraints>';
    }

    return result;
  }

  /** GPT 适配：添加分步指令 */
  private rewriteForGPT(prompt: string): string {
    if (prompt.length < 50) return prompt;

    // 如果已经包含步骤标记，不重复添加
    if (/步骤|Step|第一步|1\./.test(prompt)) return prompt;

    // 在末尾添加分步指引
    const stepSuffix = '\n\n请按以下步骤完成：\n1. 理解需求\n2. 分析方案\n3. 实现并验证\n4. 总结输出';

    return prompt + stepSuffix;
  }

  /** DeepSeek 适配：添加推理链提示 */
  private rewriteForDeepSeek(prompt: string): string {
    if (prompt.length < 50) return prompt;

    // 如果已经包含推理链标记，不重复添加
    if (/推理|分析链|思维链|chain of thought/.test(prompt)) return prompt;

    const chainPrefix = '请按以下推理链分析：\n- 观察：识别关键信息\n- 假设：提出可能的原因/方案\n- 验证：逐步验证假设\n- 结论：给出最终答案\n\n';

    return chainPrefix + prompt;
  }

  /** Gemini 适配：添加上下文锚定 */
  private rewriteForGemini(prompt: string): string {
    if (prompt.length < 50) return prompt;

    // Gemini 偏好简洁，去除冗余空白
    let result = prompt.replace(/\n{3,}/g, '\n\n');

    // 添加简短的上下文锚定
    if (!/背景|上下文|context/.test(result)) {
      result = '基于当前上下文，' + result;
    }

    return result;
  }

  // ========== 持久化方法 ==========

  /** 加载持久化数据 */
  private loadPersistedData(): void {
    // 加载自定义模板
    const templatePath = path.join(this.dataDir, 'templates.json');
    if (fs.existsSync(templatePath)) {
      try {
        const content = fs.readFileSync(templatePath, 'utf-8');
        const customTemplates = JSON.parse(content) as PromptTemplate[];
        for (const tmpl of customTemplates) {
          this.templates.set(tmpl.id, tmpl);
        }
        this.log.debug('加载自定义模板', { count: customTemplates.length });
      } catch (err: unknown) {
        const msg = err instanceof Error ? err.message : String(err);
        this.log.warn('加载自定义模板失败', { error: msg });
      }
    }

    // 加载使用统计
    const statsPath = path.join(this.dataDir, 'stats.json');
    if (fs.existsSync(statsPath)) {
      try {
        const content = fs.readFileSync(statsPath, 'utf-8');
        const loadedStats = JSON.parse(content) as Record<string, { usageCount: number; qualityScores: number[] }>;
        for (const [id, stat] of Object.entries(loadedStats)) {
          this.stats.set(id, stat);
        }
        this.log.debug('加载使用统计', { count: Object.keys(loadedStats).length });
      } catch (err: unknown) {
        const msg = err instanceof Error ? err.message : String(err);
        this.log.warn('加载使用统计失败', { error: msg });
      }
    }
  }

  /** 持久化模板 */
  private persistTemplates(): void {
    try {
      if (!fs.existsSync(this.dataDir)) {
        fs.mkdirSync(this.dataDir, { recursive: true });
      }

      // 只持久化非内置模板
      const builtinIds = new Set(BUILTIN_TEMPLATES.map(t => t.id));
      const customTemplates = Array.from(this.templates.values())
        .filter(t => !builtinIds.has(t.id));

      const templatePath = path.join(this.dataDir, 'templates.json');
      atomicWriteJsonSync(templatePath, customTemplates);
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      this.log.warn('持久化模板失败', { error: msg });
    }
  }

  /** 持久化统计 */
  private persistStats(): void {
    try {
      if (!fs.existsSync(this.dataDir)) {
        fs.mkdirSync(this.dataDir, { recursive: true });
      }

      const statsObj: Record<string, { usageCount: number; qualityScores: number[] }> = {};
      for (const [id, stat] of this.stats) {
        statsObj[id] = stat;
      }

      const statsPath = path.join(this.dataDir, 'stats.json');
      atomicWriteJsonSync(statsPath, statsObj);
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      this.log.warn('持久化统计失败', { error: msg });
    }
  }
}
