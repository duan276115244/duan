/**
 * 上下文选择器 — ContextSelector
 *
 * 参考 OpenAI Agents SDK 的 context_wrapper 模式：
 * - 当 Agent 间发生 Handoff 时，只传递目标 Agent 所需的上下文
 * - 避免全量上下文传递导致的 Token 浪费和信息噪声
 * - 基于目标 Agent 的领域规则，智能过滤和优先级排序上下文项
 * - 支持上下文摘要，在 Token 预算内保留关键信息
 *
 * 核心设计：
 * - 每个 Agent 注册 ContextRule，定义其需要的上下文模式
 * - selectContextForHandoff() 根据目标 Agent 的规则选择上下文
 * - summarizeContext() 在 Token 预算内压缩上下文
 * - estimateContextTokens() 估算上下文的 Token 占用
 *
 * 设计原则：
 * - 结构化日志：logger.child({ module: 'ContextSelector' })
 * - 事件驱动：EventBus.getInstance().emitSync() 广播关键事件
 * - 统一工具格式：ToolDef 兼容 agent-loop.ts 的工具注册体系
 */

import { logger } from './structured-logger.js';
import { EventBus } from './event-bus.js';
import type { ToolDef } from './unified-tool-def.js';

// ============ 类型定义 ============

/** Handoff 上下文 — 控制权转移时携带的完整上下文 */
export interface HandoffContext {
  conversationHistory: Array<{ role: string; content: string }>;
  taskState: Record<string, unknown>;
  memories: string[];
  facts: Record<string, string>;
  decisions: string[];
  pendingActions: string[];
}

/** 上下文选择规则 — 定义 Agent 的上下文偏好 */
export interface ContextRule {
  agentId: string;
  includePatterns: string[];
  excludePatterns: string[];
  maxTokens: number;
  priorityFields: string[];
  summaryStyle: 'detailed' | 'brief' | 'keywords';
}

/** 上下文选择结果 */
export interface SelectedContext {
  includedItems: number;
  excludedItems: number;
  estimatedTokens: number;
  context: HandoffContext;
  selectionReasoning: string;
}


/** ContextSelector 统计信息 */
interface ContextSelectorStats {
  totalSelections: number;
  totalSummaries: number;
  totalTokenEstimates: number;
  registeredRules: number;
  avgTokensSaved: number;
  recentSelections: Array<{
    from: string;
    to: string;
    includedItems: number;
    excludedItems: number;
    estimatedTokens: number;
    timestamp: number;
  }>;
}

// ============ 领域关键词映射 ============

/** 各 Agent 领域的关键词分类 */
const DOMAIN_KEYWORDS: Record<string, {
  include: string[];
  exclude: string[];
  priorityFields: string[];
}> = {
  coder: {
    include: ['代码', '函数', '变量', '类', '方法', '模块', 'API', '接口', '实现', '逻辑',
      'code', 'function', 'variable', 'class', 'method', 'module', 'implement', 'logic',
      'import', 'export', 'return', 'parameter', 'type', 'interface', 'syntax', 'compile',
      'runtime', 'debug', 'stack', 'trace', 'error', 'exception', 'bug', 'fix'],
    exclude: ['设计', '架构', '创意', 'UI', '配色', '用户体验', '品牌',
      'design', 'architecture', 'creative', 'color', 'brand', 'aesthetic', 'layout'],
    priorityFields: ['code', 'error', 'stackTrace', 'filePath', 'functionName', 'variableName'],
  },
  architect: {
    include: ['设计', '架构', '系统', '模块', '组件', '接口', '依赖', '数据流', '方案',
      'design', 'architecture', 'system', 'module', 'component', 'interface', 'dependency',
      'dataflow', 'pattern', 'structure', 'diagram', 'relationship', 'abstraction', 'layer',
      'service', 'microservice', 'monolith', 'scalability', 'performance', 'tradeoff'],
    exclude: ['实现细节', '代码行', '变量名', '具体语法', '调试',
      'implementation detail', 'line number', 'variable name', 'syntax', 'debug step'],
    priorityFields: ['architecture', 'design', 'component', 'dependency', 'dataFlow', 'pattern'],
  },
  debugger: {
    include: ['错误', '异常', '崩溃', '堆栈', '日志', '报错', 'Bug', '调试', '复现',
      'error', 'exception', 'crash', 'stack', 'trace', 'log', 'bug', 'debug', 'reproduce',
      'fail', 'assert', 'null', 'undefined', 'timeout', 'memory', 'leak', 'segfault',
      'backtrace', 'core dump', 'diagnostic', 'symptom', 'root cause'],
    exclude: ['文档', '注释', 'README', '设计理念', '最佳实践',
      'documentation', 'comment', 'readme', 'design philosophy', 'best practice', 'tutorial'],
    priorityFields: ['error', 'stackTrace', 'log', 'reproduction', 'symptom', 'rootCause'],
  },
  reviewer: {
    include: ['代码变更', 'diff', '提交', 'PR', '审查', '质量', '安全', '规范',
      'code change', 'diff', 'commit', 'PR', 'review', 'quality', 'security', 'standard',
      'lint', 'vulnerability', 'best practice', 'refactor', 'coverage', 'test'],
    exclude: ['无关上下文', '历史对话', '个人偏好',
      'unrelated context', 'chat history', 'personal preference', 'off-topic'],
    priorityFields: ['diff', 'change', 'commit', 'file', 'line', 'security', 'quality'],
  },
  devops: {
    include: ['部署', '运维', 'Docker', 'K8s', 'CI/CD', '监控', '配置', '环境', '基础设施',
      'deploy', 'devops', 'docker', 'k8s', 'kubernetes', 'CI', 'CD', 'monitor', 'config',
      'environment', 'infrastructure', 'nginx', 'server', 'container', 'pod', 'service',
      'ingress', 'volume', 'secret', 'pipeline', 'build', 'release', 'rollback'],
    exclude: ['代码逻辑', '业务实现', '算法', '数据结构',
      'code logic', 'business logic', 'algorithm', 'data structure', 'implementation'],
    priorityFields: ['deploy', 'config', 'environment', 'infrastructure', 'monitor', 'pipeline'],
  },
};

// ============ 默认上下文规则 ============

const DEFAULT_CONTEXT_RULES: ContextRule[] = [
  {
    agentId: 'coder',
    includePatterns: ['code', 'error', 'stackTrace', 'filePath', 'functionName', 'implementation', 'syntax', 'runtime'],
    excludePatterns: ['design', 'creative', 'brand', 'aesthetic', 'layout', 'color'],
    maxTokens: 4000,
    priorityFields: ['code', 'error', 'stackTrace', 'filePath'],
    summaryStyle: 'detailed',
  },
  {
    agentId: 'architect',
    includePatterns: ['design', 'architecture', 'component', 'dependency', 'dataFlow', 'pattern', 'structure', 'service'],
    excludePatterns: ['implementation', 'syntax', 'variableName', 'lineNumber', 'debugStep'],
    maxTokens: 3000,
    priorityFields: ['architecture', 'design', 'component', 'dependency'],
    summaryStyle: 'brief',
  },
  {
    agentId: 'debugger',
    includePatterns: ['error', 'exception', 'stackTrace', 'log', 'bug', 'reproduce', 'symptom', 'rootCause'],
    excludePatterns: ['documentation', 'comment', 'readme', 'bestPractice', 'tutorial'],
    maxTokens: 4000,
    priorityFields: ['error', 'stackTrace', 'log', 'reproduction'],
    summaryStyle: 'detailed',
  },
  {
    agentId: 'reviewer',
    includePatterns: ['diff', 'change', 'commit', 'file', 'security', 'quality', 'lint', 'refactor'],
    excludePatterns: ['unrelatedContext', 'chatHistory', 'personalPreference', 'offTopic'],
    maxTokens: 3500,
    priorityFields: ['diff', 'change', 'commit', 'file'],
    summaryStyle: 'brief',
  },
  {
    agentId: 'devops',
    includePatterns: ['deploy', 'config', 'environment', 'infrastructure', 'monitor', 'pipeline', 'docker', 'k8s'],
    excludePatterns: ['codeLogic', 'businessLogic', 'algorithm', 'dataStructure'],
    maxTokens: 3000,
    priorityFields: ['deploy', 'config', 'environment', 'infrastructure'],
    summaryStyle: 'keywords',
  },
];

// ============ 主类 ============

export class ContextSelector {
  private rules: Map<string, ContextRule> = new Map();
  private log = logger.child({ module: 'ContextSelector' });

  // 统计
  private totalSelections = 0;
  private totalSummaries = 0;
  private totalTokenEstimates = 0;
  private tokensSaved: number[] = [];
  private recentSelections: Array<{
    from: string;
    to: string;
    includedItems: number;
    excludedItems: number;
    estimatedTokens: number;
    timestamp: number;
  }> = [];

  constructor() {
    // 预注册默认 Agent 的上下文规则
    for (const rule of DEFAULT_CONTEXT_RULES) {
      this.rules.set(rule.agentId, rule);
    }

    this.log.info('上下文选择器初始化完成', {
      defaultRules: DEFAULT_CONTEXT_RULES.length,
      agents: DEFAULT_CONTEXT_RULES.map(r => r.agentId),
    });
  }

  // ========== 核心 API ==========

  /**
   * 为 Handoff 选择相关上下文
   * 根据目标 Agent 的领域规则，过滤和优先级排序上下文项
   */
  selectContextForHandoff(
    fromAgent: string,
    toAgent: string,
    fullContext: HandoffContext,
  ): SelectedContext {
    const rule = this.rules.get(toAgent);
    const startTime = Date.now();

    // 如果目标 Agent 没有注册规则，返回完整上下文
    if (!rule) {
      this.log.warn('目标 Agent 无上下文规则，返回完整上下文', { toAgent });

      const estimatedTokens = this.estimateContextTokensInternal(fullContext);

      return {
        includedItems: this.countContextItems(fullContext),
        excludedItems: 0,
        estimatedTokens,
        context: fullContext,
        selectionReasoning: `目标 Agent "${toAgent}" 无注册规则，使用完整上下文`,
      };
    }

    // 基于规则过滤上下文
    const selected = this.filterContext(fullContext, rule);
    const filteredTokens = this.estimateContextTokensInternal(selected);

    // 如果超过 Token 预算，进行摘要压缩
    let finalContext = selected;
    if (filteredTokens > rule.maxTokens) {
      finalContext = this.summarizeContextInternal(selected, rule.maxTokens, rule.summaryStyle);
    }

    // 统一以 finalContext 为准重新计算 Token，避免压缩后使用陈旧的估算值
    const estimatedTokens = this.estimateContextTokensInternal(finalContext);

    const fullItemCount = this.countContextItems(fullContext);
    const selectedItemCount = this.countContextItems(finalContext);
    const excludedItems = fullItemCount - selectedItemCount;

    // 计算节省的 Token
    const fullTokens = this.estimateContextTokensInternal(fullContext);
    const savedTokens = Math.max(0, fullTokens - estimatedTokens);
    if (savedTokens > 0) {
      this.tokensSaved.push(savedTokens);
      if (this.tokensSaved.length > 100) this.tokensSaved.shift();
    }

    // 记录统计
    this.totalSelections++;
    const selectionRecord = {
      from: fromAgent,
      to: toAgent,
      includedItems: selectedItemCount,
      excludedItems,
      estimatedTokens,
      timestamp: Date.now(),
    };
    this.recentSelections.push(selectionRecord);
    if (this.recentSelections.length > 50) this.recentSelections.shift();

    // 构建选择推理说明
    const reasoning = this.buildSelectionReasoning(fromAgent, toAgent, rule, fullItemCount, selectedItemCount, excludedItems);

    EventBus.getInstance().emitSync('context.selected', {
      fromAgent,
      toAgent,
      includedItems: selectedItemCount,
      excludedItems,
      estimatedTokens,
      processingTime: Date.now() - startTime,
    }, { source: 'ContextSelector' });

    this.log.info('上下文选择完成', {
      from: fromAgent,
      to: toAgent,
      includedItems: selectedItemCount,
      excludedItems,
      estimatedTokens,
      savedTokens,
    });

    return {
      includedItems: selectedItemCount,
      excludedItems,
      estimatedTokens,
      context: finalContext,
      selectionReasoning: reasoning,
    };
  }

  /**
   * 注册上下文选择规则
   */
  registerContextRule(agentId: string, rule: ContextRule): {
    success: boolean;
    message: string;
  } {
    this.rules.set(agentId, rule);

    EventBus.getInstance().emitSync('context.rule.registered', {
      agentId,
      maxTokens: rule.maxTokens,
      includePatterns: rule.includePatterns.length,
      excludePatterns: rule.excludePatterns.length,
    }, { source: 'ContextSelector' });

    this.log.info('上下文规则注册成功', {
      agentId,
      maxTokens: rule.maxTokens,
      includePatterns: rule.includePatterns,
      excludePatterns: rule.excludePatterns,
      summaryStyle: rule.summaryStyle,
    });

    return {
      success: true,
      message: `Agent "${agentId}" 的上下文规则注册成功，` +
        `包含 ${rule.includePatterns.length} 个包含模式、${rule.excludePatterns.length} 个排除模式、` +
        `最大 ${rule.maxTokens} Token`,
    };
  }


  /**
   * 摘要上下文以适应 Token 预算
   * 保留关键事实、决策和承诺
   */
  summarizeContext(context: HandoffContext, maxLength: number): HandoffContext {
    this.totalSummaries++;
    return this.summarizeContextInternal(context, maxLength, 'brief');
  }

  /**
   * 估算上下文的 Token 数量
   * 使用简单的启发式：中文约 1.5 字符/Token，英文约 4 字符/Token
   */
  estimateContextTokens(context: HandoffContext): number {
    this.totalTokenEstimates++;
    return this.estimateContextTokensInternal(context);
  }

  /**
   * 获取指定 Agent 的上下文规则
   */
  getRule(agentId: string): ContextRule | undefined {
    return this.rules.get(agentId);
  }

  /**
   * 获取所有已注册的规则
   */
  getAllRules(): ContextRule[] {
    return Array.from(this.rules.values());
  }

  /**
   * 获取统计信息
   */
  getStats(): ContextSelectorStats {
    const avgSaved = this.tokensSaved.length > 0
      ? this.tokensSaved.reduce((a, b) => a + b, 0) / this.tokensSaved.length
      : 0;

    return {
      totalSelections: this.totalSelections,
      totalSummaries: this.totalSummaries,
      totalTokenEstimates: this.totalTokenEstimates,
      registeredRules: this.rules.size,
      avgTokensSaved: Math.round(avgSaved),
      recentSelections: this.recentSelections.slice(-10),
    };
  }

  // ========== Agent Loop 工具定义 ==========

  /**
   * 返回 ToolDef 兼容的工具定义列表，供 agent-loop 注册
   */
  getToolDefinitions(): ToolDef[] {
    // eslint-disable-next-line @typescript-eslint/no-this-alias
    const self = this;

    return [
      {
        name: 'ctx_select',
        description: '为 Agent Handoff 选择相关上下文。根据目标 Agent 的领域规则，智能过滤和优先级排序上下文项，只传递目标 Agent 需要的信息。此操作只读，不会修改原始上下文。',
        readOnly: true,
        parameters: {
          from_agent: {
            type: 'string',
            description: '源 Agent ID',
            required: true,
          },
          to_agent: {
            type: 'string',
            description: '目标 Agent ID',
            required: true,
          },
          context_json: {
            type: 'string',
            description: '完整上下文的 JSON 字符串，包含 conversationHistory、taskState、memories、facts、decisions、pendingActions',
            required: true,
          },
        },
        execute: (args) => {
          try {
            const fromAgent = args.from_agent as string;
            const toAgent = args.to_agent as string;
            let context: HandoffContext;

            try {
              context = JSON.parse(args.context_json as string);
            } catch {
              return Promise.resolve('❌ 上下文 JSON 解析失败，请检查格式');
            }

            const result = self.selectContextForHandoff(fromAgent, toAgent, context);

            let output = `🎯 上下文选择结果\n`;
            output += `源: ${fromAgent} → 目标: ${toAgent}\n`;
            output += `包含项: ${result.includedItems} | 排除项: ${result.excludedItems}\n`;
            output += `估算 Token: ${result.estimatedTokens}\n`;
            output += `选择推理: ${result.selectionReasoning}\n\n`;
            output += `筛选后上下文:\n${JSON.stringify(result.context, null, 2).substring(0, 2000)}`;

            return Promise.resolve(output);
          } catch (err: unknown) {
            return Promise.resolve(`❌ 上下文选择失败: ${(err instanceof Error ? err.message : String(err))}`);
          }
        },
      },
      {
        name: 'ctx_summarize',
        description: '将上下文摘要压缩到指定 Token 预算内。保留关键事实、决策和承诺，去除冗余信息。此操作只读，不会修改原始上下文。',
        readOnly: true,
        parameters: {
          context_json: {
            type: 'string',
            description: '需要摘要的上下文 JSON 字符串',
            required: true,
          },
          max_tokens: {
            type: 'string',
            description: '最大 Token 预算，默认 2000',
            required: false,
          },
        },
        execute: (args) => {
          try {
            let context: HandoffContext;
            try {
              context = JSON.parse(args.context_json as string);
            } catch {
              return Promise.resolve('❌ 上下文 JSON 解析失败，请检查格式');
            }

            const maxTokens = parseInt(args.max_tokens as string) || 2000;
            const summarized = self.summarizeContext(context, maxTokens);
            const originalTokens = self.estimateContextTokens(context);
            const newTokens = self.estimateContextTokens(summarized);

            let output = `📝 上下文摘要结果\n`;
            output += `原始 Token: ${originalTokens} → 摘要后 Token: ${newTokens}\n`;
            output += `压缩率: ${((1 - newTokens / Math.max(originalTokens, 1)) * 100).toFixed(1)}%\n\n`;
            output += `摘要后上下文:\n${JSON.stringify(summarized, null, 2).substring(0, 2000)}`;

            return Promise.resolve(output);
          } catch (err: unknown) {
            return Promise.resolve(`❌ 上下文摘要失败: ${(err instanceof Error ? err.message : String(err))}`);
          }
        },
      },
      {
        name: 'ctx_estimate',
        description: '估算上下文的 Token 数量。使用启发式方法：中文约 1.5 字符/Token，英文约 4 字符/Token。此操作只读。',
        readOnly: true,
        parameters: {
          context_json: {
            type: 'string',
            description: '需要估算的上下文 JSON 字符串',
            required: true,
          },
        },
        execute: (args) => {
          try {
            let context: HandoffContext;
            try {
              context = JSON.parse(args.context_json as string);
            } catch {
              return Promise.resolve('❌ 上下文 JSON 解析失败，请检查格式');
            }

            const tokens = self.estimateContextTokens(context);
            const itemCounts = {
              conversationHistory: context.conversationHistory?.length || 0,
              taskStateKeys: Object.keys(context.taskState || {}).length,
              memories: context.memories?.length || 0,
              facts: Object.keys(context.facts || {}).length,
              decisions: context.decisions?.length || 0,
              pendingActions: context.pendingActions?.length || 0,
            };

            let output = `📊 上下文 Token 估算\n\n`;
            output += `总估算 Token: ${tokens}\n\n`;
            output += `上下文项统计:\n`;
            output += `  对话历史: ${itemCounts.conversationHistory} 条\n`;
            output += `  任务状态: ${itemCounts.taskStateKeys} 个键\n`;
            output += `  记忆: ${itemCounts.memories} 条\n`;
            output += `  事实: ${itemCounts.facts} 个\n`;
            output += `  决策: ${itemCounts.decisions} 条\n`;
            output += `  待办: ${itemCounts.pendingActions} 条\n`;

            return Promise.resolve(output);
          } catch (err: unknown) {
            return Promise.resolve(`❌ Token 估算失败: ${(err instanceof Error ? err.message : String(err))}`);
          }
        },
      },
    ];
  }

  // ========== 私有方法 ==========

  /**
   * 基于规则过滤上下文
   */
  private filterContext(context: HandoffContext, rule: ContextRule): HandoffContext {
    const domainInfo = DOMAIN_KEYWORDS[rule.agentId];
    const includeKeywords = domainInfo?.include || rule.includePatterns;
    const excludeKeywords = domainInfo?.exclude || rule.excludePatterns;

    // 过滤对话历史
    const filteredHistory = context.conversationHistory.filter(msg => {
      const content = msg.content.toLowerCase();
      // 排除模式优先
      if (excludeKeywords.some(kw => content.includes(kw.toLowerCase()))) {
        // 但如果同时也命中包含模式，保留
        if (includeKeywords.some(kw => content.includes(kw.toLowerCase()))) {
          return true;
        }
        return false;
      }
      return true;
    });

    // 过滤任务状态
    const filteredTaskState: Record<string, unknown> = {};
    for (const [key, value] of Object.entries(context.taskState)) {
      const keyLower = key.toLowerCase();
      const valueStr = typeof value === 'string' ? value.toLowerCase() : JSON.stringify(value).toLowerCase();

      // 优先级字段始终保留
      if (rule.priorityFields.some(f => keyLower.includes(f.toLowerCase()))) {
        filteredTaskState[key] = value;
        continue;
      }

      // 包含模式匹配
      if (includeKeywords.some(kw => keyLower.includes(kw.toLowerCase()) || valueStr.includes(kw.toLowerCase()))) {
        filteredTaskState[key] = value;
        continue;
      }

      // 排除模式匹配
      if (excludeKeywords.some(kw => keyLower.includes(kw.toLowerCase()) || valueStr.includes(kw.toLowerCase()))) {
        continue;
      }

      // 默认保留
      filteredTaskState[key] = value;
    }

    // 过滤记忆
    const filteredMemories = context.memories.filter(memory => {
      const memoryLower = memory.toLowerCase();
      if (excludeKeywords.some(kw => memoryLower.includes(kw.toLowerCase()))) {
        return includeKeywords.some(kw => memoryLower.includes(kw.toLowerCase()));
      }
      return true;
    });

    // 事实和决策默认保留（通常数量较少且重要）
    // 待办事项也默认保留
    return {
      conversationHistory: filteredHistory,
      taskState: filteredTaskState,
      memories: filteredMemories,
      facts: { ...context.facts },
      decisions: [...context.decisions],
      pendingActions: [...context.pendingActions],
    };
  }

  /**
   * 内部摘要方法 — 在 Token 预算内压缩上下文
   */
  private summarizeContextInternal(
    context: HandoffContext,
    maxTokens: number,
    style: 'detailed' | 'brief' | 'keywords',
  ): HandoffContext {
    const currentTokens = this.estimateContextTokensInternal(context);
    if (currentTokens <= maxTokens) {
      return context;
    }

    // 摘要策略：按优先级逐步裁剪
    let summarized = { ...context };

    // 1. 首先裁剪对话历史（保留最近的消息）
    if (this.estimateContextTokensInternal(summarized) > maxTokens) {
      const maxHistory = Math.max(2, Math.floor(summarized.conversationHistory.length * 0.5));
      summarized = {
        ...summarized,
        conversationHistory: summarized.conversationHistory.slice(-maxHistory),
      };
    }

    // 2. 裁剪记忆
    if (this.estimateContextTokensInternal(summarized) > maxTokens) {
      const maxMemories = Math.max(2, Math.floor(summarized.memories.length * 0.5));
      summarized = {
        ...summarized,
        memories: summarized.memories.slice(-maxMemories),
      };
    }

    // 3. 根据 summaryStyle 压缩内容
    if (this.estimateContextTokensInternal(summarized) > maxTokens) {
      switch (style) {
        case 'keywords':
          // 关键词模式：只保留关键词
          summarized = this.summarizeAsKeywords(summarized, maxTokens);
          break;
        case 'brief':
          // 简要模式：截断长文本
          summarized = this.summarizeAsBrief(summarized, maxTokens);
          break;
        case 'detailed':
          // 详细模式：尽量保留，只裁剪最旧的内容
          summarized = this.summarizeAsDetailed(summarized, maxTokens);
          break;
      }
    }

    // 4. 最后手段：截断对话历史到最近 2 条
    if (this.estimateContextTokensInternal(summarized) > maxTokens) {
      summarized = {
        ...summarized,
        conversationHistory: summarized.conversationHistory.slice(-2),
        memories: summarized.memories.slice(-2),
      };
    }

    return summarized;
  }

  /**
   * 关键词模式摘要
   */
  private summarizeAsKeywords(context: HandoffContext, _maxTokens: number): HandoffContext {
    // 将对话历史压缩为关键词摘要
    const keywordSummary = context.conversationHistory
      .map(msg => {
        // 提取每条消息的前 50 个字符作为关键词
        const truncated = msg.content.substring(0, 50);
        return { role: msg.role, content: `[摘要] ${truncated}...` };
      });

    return {
      ...context,
      conversationHistory: keywordSummary,
      memories: context.memories.map(m => m.substring(0, 80)),
    };
  }

  /**
   * 简要模式摘要
   */
  private summarizeAsBrief(context: HandoffContext, _maxTokens: number): HandoffContext {
    // 截断每条消息到合理长度
    const maxContentLength = 200;

    return {
      ...context,
      conversationHistory: context.conversationHistory.map(msg => ({
        role: msg.role,
        content: msg.content.length > maxContentLength
          ? msg.content.substring(0, maxContentLength) + '...'
          : msg.content,
      })),
      memories: context.memories.map(m =>
        m.length > 100 ? m.substring(0, 100) + '...' : m
      ),
    };
  }

  /**
   * 详细模式摘要
   */
  private summarizeAsDetailed(context: HandoffContext, _maxTokens: number): HandoffContext {
    // 保留最新消息的完整内容，旧消息截断
    const historyLen = context.conversationHistory.length;

    return {
      ...context,
      conversationHistory: context.conversationHistory.map((msg, idx) => {
        // 最近 3 条保持完整
        if (idx >= historyLen - 3) return msg;
        // 更早的消息截断
        return {
          role: msg.role,
          content: msg.content.length > 100
            ? msg.content.substring(0, 100) + '...'
            : msg.content,
        };
      }),
    };
  }

  /**
   * 内部 Token 估算方法
   * 启发式：中文约 1.5 字符/Token，英文约 4 字符/Token
   */
  private estimateContextTokensInternal(context: HandoffContext): number {
    const jsonStr = JSON.stringify(context);
    return this.estimateStringTokens(jsonStr);
  }

  /**
   * 估算字符串的 Token 数量
   */
  private estimateStringTokens(text: string): number {
    // 区分中文字符和英文字符
    let chineseChars = 0;
    let otherChars = 0;

    for (const char of text) {
      if (/[\u4e00-\u9fff\u3400-\u4dbf]/.test(char)) {
        chineseChars++;
      } else {
        otherChars++;
      }
    }

    // 中文约 1.5 字符/Token，英文约 4 字符/Token
    return Math.ceil(chineseChars / 1.5 + otherChars / 4);
  }

  /**
   * 计算上下文项总数
   */
  private countContextItems(context: HandoffContext): number {
    return (
      (context.conversationHistory?.length || 0) +
      Object.keys(context.taskState || {}).length +
      (context.memories?.length || 0) +
      Object.keys(context.facts || {}).length +
      (context.decisions?.length || 0) +
      (context.pendingActions?.length || 0)
    );
  }

  /**
   * 构建选择推理说明
   */
  private buildSelectionReasoning(
    fromAgent: string,
    toAgent: string,
    rule: ContextRule,
    totalItems: number,
    includedItems: number,
    excludedItems: number,
  ): string {
    const parts: string[] = [];

    parts.push(`Handoff ${fromAgent} → ${toAgent}`);

    if (excludedItems > 0) {
      parts.push(`排除 ${excludedItems}/${totalItems} 项`);
      parts.push(`包含模式: [${rule.includePatterns.slice(0, 5).join(', ')}]`);
      parts.push(`排除模式: [${rule.excludePatterns.slice(0, 5).join(', ')}]`);
    } else {
      parts.push('保留完整上下文（无需过滤）');
    }

    parts.push(`Token 预算: ${rule.maxTokens}`);
    parts.push(`摘要风格: ${rule.summaryStyle}`);

    return parts.join('；');
  }
}
