/**
 * Handoff（Agent 控制转移）系统 — HandoffSystem
 *
 * 核心概念（借鉴 OpenAI Agents SDK）：
 * - Handoff ≠ spawn_agent：Handoff 是控制权转移（同一时间只有一个活跃 Agent），
 *   spawn 是并行创建子 Agent（多个同时运行）
 * - Handoff 将当前上下文（对话历史、任务状态、记忆）打包传递给目标 Agent
 * - 目标 Agent 接管后，原 Agent 暂停，直到 Handoff 回来或任务完成
 *
 * 设计原则：
 * - 结构化日志：logger.child({ module: 'HandoffSystem' })
 * - 事件驱动：EventBus.getInstance().emitSync() 广播关键事件
 * - 统一工具格式：ToolDef 兼容 agent-loop.ts 的工具注册体系
 * - LLM 调用：通过 ModelLibrary 统一调用
 */

import { logger } from './structured-logger.js';
import { EventBus } from './event-bus.js';
import { ModelLibrary } from './model-library.js';

// ============ 类型定义 ============

/** Agent 定义 — 描述一个可接收 Handoff 的 Agent */
export interface AgentDefinition {
  id: string;
  name: string;
  description: string;
  systemPrompt: string;
  tools?: string[];            // 该 Agent 可使用的工具名称列表
  handoffDescription: string;  // 何时应将控制权移交给此 Agent
  capabilities: string[];
  domain: string;
}

/** Handoff 上下文 — 控制权转移时携带的信息 */
export interface HandoffContext {
  conversationHistory: Array<{ role: string; content: string }>;
  taskState: Record<string, unknown>;
  memories: string[];
  fromAgentId: string;
  fromAgentName: string;
  reason: string;
  timestamp: number;
}

/** Handoff 结果 — 一次控制权转移的执行结果 */
export interface HandoffResult {
  success: boolean;
  fromAgent: string;
  toAgent: string;
  reason: string;
  contextTransferred: boolean;
  executionResult?: string;
  error?: string;
}

/** Handoff 记录 — 历史记录条目 */
export interface HandoffRecord {
  id: string;
  fromAgent: string;
  toAgent: string;
  reason: string;
  timestamp: number;
  contextSize: number;
  success: boolean;
}

import type { ToolDef } from './unified-tool-def.js';

// ============ 默认 Agent 定义 ============

const DEFAULT_AGENTS: AgentDefinition[] = [
  {
    id: 'general',
    name: '通用助手',
    description: '处理日常对话、问答、信息查询等通用任务',
    systemPrompt: '你是段先生的通用助手模块。你擅长处理日常对话、信息查询、简单问答和一般性任务。当任务涉及专业领域时，你应该将控制权移交给对应的专业 Agent。用中文回复，简洁专业。',
    tools: ['file_read', 'web_search', 'web_fetch', 'current_time', 'list_directory', 'search_files'],
    handoffDescription: '当用户进行日常对话、简单问答、信息查询，或当前任务不属于其他专业 Agent 的领域时，应将控制权移交通用助手',
    capabilities: ['conversation', 'qa', 'information_retrieval', 'general_assistance'],
    domain: 'general',
  },
  {
    id: 'coder',
    name: '代码专家',
    description: '处理代码编写、修改、重构等编程任务',
    systemPrompt: '你是段先生的代码专家模块。你精通多种编程语言，擅长代码编写、修改、重构、优化和调试。你会先理解需求，再编写高质量代码，并确保代码可编译运行。用中文回复，代码注释可用英文。',
    tools: ['file_read', 'file_write', 'shell_execute', 'code_execute', 'search_files', 'list_directory', 'self_patch', 'self_read', 'self_write'],
    handoffDescription: '当用户需要编写代码、修改代码、重构代码、实现功能、创建项目或进行任何编程相关任务时，应将控制权移交代码专家',
    capabilities: ['coding', 'refactoring', 'implementation', 'code_generation', 'debugging'],
    domain: 'development',
  },
  {
    id: 'architect',
    name: '架构师',
    description: '处理系统设计、架构分析、技术选型等高层设计任务',
    systemPrompt: '你是段先生的架构师模块。你擅长系统设计、架构分析、技术选型、性能评估和方案对比。你会从全局视角分析问题，给出结构化的设计方案和权衡分析。用中文回复，注重系统性和深度。',
    tools: ['file_read', 'search_files', 'list_directory', 'self_project', 'self_think', 'web_search'],
    handoffDescription: '当用户需要系统设计、架构分析、技术选型、方案评估、性能分析或整体规划时，应将控制权移交架构师',
    capabilities: ['system_design', 'architecture_analysis', 'tech_selection', 'performance_analysis', 'planning'],
    domain: 'architecture',
  },
  {
    id: 'debugger',
    name: '调试专家',
    description: '处理 Bug 排查、错误诊断、问题定位等调试任务',
    systemPrompt: '你是段先生的调试专家模块。你擅长 Bug 排查、错误诊断、问题定位和修复验证。你会采用科学的调试方法：复现问题→假设原因→插桩验证→定位根因→修复→验证。用中文回复，注重逻辑严密性。',
    tools: ['file_read', 'shell_execute', 'code_execute', 'search_files', 'self_test', 'self_read', 'http_request'],
    handoffDescription: '当用户遇到 Bug、错误、异常行为、程序崩溃或需要诊断问题时，应将控制权移交调试专家',
    capabilities: ['bug_fixing', 'error_diagnosis', 'root_cause_analysis', 'log_analysis', 'testing'],
    domain: 'debugging',
  },
  {
    id: 'reviewer',
    name: '代码审查员',
    description: '处理代码审查、质量检查、安全扫描等审查任务',
    systemPrompt: '你是段先生的代码审查员模块。你擅长代码审查、质量检查、安全扫描、最佳实践验证和改进建议。你会从正确性、可读性、安全性、性能和可维护性五个维度进行审查。用中文回复，给出具体的改进建议。',
    tools: ['file_read', 'search_files', 'self_read', 'self_git', 'self_project', 'web_search'],
    handoffDescription: '当用户需要代码审查、质量检查、安全扫描、代码规范检查或改进建议时，应将控制权移交代码审查员',
    capabilities: ['code_review', 'quality_check', 'security_scan', 'best_practices', 'improvement_suggestions'],
    domain: 'review',
  },
  {
    id: 'devops',
    name: '运维专家',
    description: '处理部署、运维、监控、基础设施等 DevOps 任务',
    systemPrompt: '你是段先生的运维专家模块。你擅长部署、运维、监控、CI/CD 配置、Docker、Kubernetes 和基础设施管理。你会确保操作的安全性和可回滚性。用中文回复，注重操作规范和风险控制。',
    tools: ['shell_execute', 'file_read', 'file_write', 'http_request', 'self_git', 'list_directory', 'search_files'],
    handoffDescription: '当用户需要部署、运维、环境配置、Docker/K8s 操作、CI/CD 设置或基础设施管理时，应将控制权移交运维专家',
    capabilities: ['deployment', 'monitoring', 'ci_cd', 'containerization', 'infrastructure'],
    domain: 'devops',
  },
];

// ============ 主类 ============

export class HandoffSystem {
  private agents: Map<string, AgentDefinition> = new Map();
  private history: HandoffRecord[] = [];
  private activeAgentId: string = 'general';
  private modelLibrary: ModelLibrary | null = null;
  private log = logger.child({ module: 'HandoffSystem' });

  constructor(modelLibrary?: unknown) {
    this.modelLibrary = modelLibrary instanceof ModelLibrary ? modelLibrary : null;

    // 注册默认 Agent
    for (const agent of DEFAULT_AGENTS) {
      this.agents.set(agent.id, agent);
    }

    this.log.info('Handoff 系统初始化完成', {
      defaultAgents: DEFAULT_AGENTS.length,
      activeAgent: this.activeAgentId,
    });
  }

  // ========== 核心 API ==========

  /**
   * 注册一个可接收 Handoff 的 Agent
   */
  registerAgent(agent: AgentDefinition): { success: boolean; message: string } {
    if (this.agents.has(agent.id)) {
      this.log.warn('Agent 已存在，将覆盖注册', { agentId: agent.id });
    }

    this.agents.set(agent.id, agent);

    EventBus.getInstance().emitSync('handoff.agent.registered', {
      agentId: agent.id,
      agentName: agent.name,
      domain: agent.domain,
    }, { source: 'HandoffSystem' });

    this.log.info('Agent 注册成功', {
      agentId: agent.id,
      agentName: agent.name,
      domain: agent.domain,
    });

    return {
      success: true,
      message: `Agent "${agent.name}" (${agent.id}) 注册成功`,
    };
  }

  /**
   * 执行 Handoff — 将控制权从 fromAgent 转移到 toAgent
   */
  async handoff(
    fromAgentId: string,
    toAgentId: string,
    reason: string,
    context?: HandoffContext,
  ): Promise<HandoffResult> {
    // 验证源 Agent
    const fromAgent = this.agents.get(fromAgentId);
    if (!fromAgent) {
      const error = `源 Agent "${fromAgentId}" 不存在`;
      this.log.error('Handoff 失败: 源 Agent 不存在', { fromAgentId });
      return {
        success: false,
        fromAgent: fromAgentId,
        toAgent: toAgentId,
        reason,
        contextTransferred: false,
        error,
      };
    }

    // 验证目标 Agent
    const toAgent = this.agents.get(toAgentId);
    if (!toAgent) {
      const error = `目标 Agent "${toAgentId}" 不存在`;
      this.log.error('Handoff 失败: 目标 Agent 不存在', { toAgentId });
      return {
        success: false,
        fromAgent: fromAgentId,
        toAgent: toAgentId,
        reason,
        contextTransferred: false,
        error,
      };
    }

    // 不允许 Handoff 给自己
    if (fromAgentId === toAgentId) {
      const error = '不允许 Handoff 给自己';
      this.log.warn('Handoff 被拒绝: 源和目标相同', { agentId: fromAgentId });
      return {
        success: false,
        fromAgent: fromAgentId,
        toAgent: toAgentId,
        reason,
        contextTransferred: false,
        error,
      };
    }

    // 构建 Handoff 上下文
    const handoffContext: HandoffContext = context || {
      conversationHistory: [],
      taskState: {},
      memories: [],
      fromAgentId,
      fromAgentName: fromAgent.name,
      reason,
      timestamp: Date.now(),
    };

    // 计算上下文大小
    const contextSize = JSON.stringify(handoffContext).length;

    // 广播 Handoff 开始事件
    EventBus.getInstance().emitSync('handoff.started', {
      fromAgent: fromAgentId,
      toAgent: toAgentId,
      reason,
      contextSize,
    }, { source: 'HandoffSystem' });

    this.log.info('Handoff 执行中', {
      from: fromAgentId,
      to: toAgentId,
      reason: reason.substring(0, 100),
      contextSize,
    });

    // 执行目标 Agent
    let executionResult: string | undefined;
    let executionError: string | undefined;

    try {
      // 使用上下文中最后一条用户消息作为输入
      const lastUserMsg = handoffContext.conversationHistory
        .filter(m => m.role === 'user')
        .pop()?.content || reason;

      executionResult = await this.executeHandoffAgent(toAgentId, lastUserMsg, handoffContext);
    } catch (err: unknown) {
      executionError = err instanceof Error ? (err.message || String(err)) : String(err);
      this.log.error('Handoff Agent 执行失败', {
        toAgent: toAgentId,
        error: executionError,
      });
    }

    // 更新活跃 Agent
    const previousActive = this.activeAgentId;
    this.activeAgentId = toAgentId;

    // 记录历史
    const record: HandoffRecord = {
      id: `handoff_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`,
      fromAgent: fromAgentId,
      toAgent: toAgentId,
      reason,
      timestamp: Date.now(),
      contextSize,
      success: !executionError,
    };
    this.history.push(record);

    // 广播 Handoff 完成事件
    EventBus.getInstance().emitSync('handoff.completed', {
      fromAgent: fromAgentId,
      toAgent: toAgentId,
      reason,
      success: !executionError,
      previousActive,
    }, { source: 'HandoffSystem' });

    const result: HandoffResult = {
      success: !executionError,
      fromAgent: fromAgentId,
      toAgent: toAgentId,
      reason,
      contextTransferred: true,
      executionResult,
      error: executionError,
    };

    this.log.info('Handoff 完成', {
      from: fromAgentId,
      to: toAgentId,
      success: result.success,
    });

    return result;
  }

  /**
   * 执行 Handoff 后的目标 Agent — 构建专属 prompt，注入上下文，调用 LLM
   */
  async executeHandoffAgent(
    agentId: string,
    input: string,
    context: HandoffContext,
  ): Promise<string> {
    const agent = this.agents.get(agentId);
    if (!agent) {
      throw new Error(`Agent "${agentId}" 不存在`);
    }

    // 构建注入了 Handoff 上下文的系统提示
    const contextBlock = this.buildContextBlock(context);
    const enhancedSystemPrompt = `${agent.systemPrompt}\n\n${contextBlock}`;

    // 构建消息列表
    const messages: Array<{ role: 'system' | 'user' | 'assistant'; content: string }> = [
      { role: 'system', content: enhancedSystemPrompt },
    ];

    // 注入对话历史（最近 10 轮）
    const recentHistory = context.conversationHistory.slice(-20);
    for (const msg of recentHistory) {
      if (msg.role === 'user' || msg.role === 'assistant') {
        messages.push({ role: msg.role as 'user' | 'assistant', content: msg.content });
      }
    }

    // 添加当前输入
    messages.push({ role: 'user', content: input });

    // 调用 LLM
    if (this.modelLibrary) {
      try {
        const response = await this.modelLibrary.call(messages, {
          maxTokens: 4096,
          temperature: 0.7,
        });
        return response.content;
      } catch (err: unknown) {
        const msg = err instanceof Error ? err.message : String(err);
        this.log.error('LLM 调用失败，回退到简单响应', { error: msg });
      }
    }

    // 降级：无法调用 LLM 时返回结构化提示
    return `[${agent.name}] 已接管任务。原因: ${context.reason}\n` +
      `来自: ${context.fromAgentName}\n` +
      `输入: ${input}\n` +
      `（LLM 调用不可用，请配置 ModelLibrary 后重试）`;
  }

  /**
   * 获取所有 Handoff 历史记录
   */
  getHandoffHistory(): HandoffRecord[] {
    return [...this.history];
  }

  /**
   * 根据当前任务描述，建议最合适的 Agent
   */
  suggestHandoff(currentTask: string): Promise<{
    suggestedAgentId: string;
    suggestedAgentName: string;
    reasoning: string;
    confidence: number;
    alternatives: Array<{ agentId: string; agentName: string; score: number }>;
  }> {
    const task = currentTask.toLowerCase();

    // 为每个 Agent 计算匹配分数
    const scored: Array<{
      agent: AgentDefinition;
      score: number;
      reasoning: string;
    }> = [];

    const agentEntries = Array.from(this.agents.values());
    for (const agent of agentEntries) {
      const { score, reasoning } = this.scoreAgentForTask(agent, task);
      scored.push({ agent, score, reasoning });
    }

    // 按分数降序排序
    scored.sort((a, b) => b.score - a.score);

    const best = scored[0];
    const alternatives = scored.slice(1, 4).map(s => ({
      agentId: s.agent.id,
      agentName: s.agent.name,
      score: s.score,
    }));

    // 如果最高分太低，建议保持当前 Agent
    const confidence = Math.min(best.score / 100, 1.0);

    this.log.info('Handoff 建议生成', {
      task: task.substring(0, 50),
      suggested: best.agent.id,
      confidence,
    });

    return Promise.resolve({
      suggestedAgentId: best.agent.id,
      suggestedAgentName: best.agent.name,
      reasoning: best.reasoning,
      confidence,
      alternatives,
    });
  }

  /**
   * 获取系统统计信息
   */
  getStats(): {
    registeredAgents: number;
    totalHandoffs: number;
    successfulHandoffs: number;
    failedHandoffs: number;
    activeAgent: string;
    agentList: Array<{ id: string; name: string; domain: string }>;
    recentHandoffs: HandoffRecord[];
  } {
    const successful = this.history.filter(h => h.success).length;
    const failed = this.history.filter(h => !h.success).length;

    return {
      registeredAgents: this.agents.size,
      totalHandoffs: this.history.length,
      successfulHandoffs: successful,
      failedHandoffs: failed,
      activeAgent: this.activeAgentId,
      agentList: Array.from(this.agents.values()).map(a => ({
        id: a.id,
        name: a.name,
        domain: a.domain,
      })),
      recentHandoffs: this.history.slice(-5),
    };
  }

  /**
   * 获取当前活跃 Agent ID
   */
  getActiveAgentId(): string {
    return this.activeAgentId;
  }

  /**
   * 获取指定 Agent 定义
   */
  getAgent(agentId: string): AgentDefinition | undefined {
    return this.agents.get(agentId);
  }

  /**
   * 获取所有已注册 Agent
   */
  getAllAgents(): AgentDefinition[] {
    return Array.from(this.agents.values());
  }

  // ========== Agent Loop 工具定义 ==========

  /**
   * 返回 ToolDef 兼容的工具定义列表，供 agent-loop 注册
   */
  getToolDefinitions(): ToolDef[] {
    return [
      {
        name: 'handoff_to',
        description: '将控制权移交给另一个专业 Agent。Handoff 不同于 spawn_agent：Handoff 是控制权转移（同一时间只有一个活跃 Agent），spawn 是并行创建子 Agent。当当前任务更适合其他 Agent 处理时使用。',
        parameters: {
          agent_id: {
            type: 'string',
            description: '目标 Agent 的 ID。可选: general, coder, architect, debugger, reviewer, devops',
            required: true,
          },
          reason: {
            type: 'string',
            description: '移交控制权的原因，说明为什么目标 Agent 更适合处理当前任务',
            required: true,
          },
          task_summary: {
            type: 'string',
            description: '当前任务的摘要，帮助目标 Agent 理解上下文',
            required: false,
          },
        },
        execute: async (args) => {
          const agentId = args.agent_id as string;
          const reason = args.reason as string;
          const taskSummary = args.task_summary as string || '';

          // 构建上下文
          const context: HandoffContext = {
            conversationHistory: taskSummary
              ? [{ role: 'user', content: taskSummary }]
              : [],
            taskState: { taskSummary },
            memories: [],
            fromAgentId: this.activeAgentId,
            fromAgentName: this.agents.get(this.activeAgentId)?.name || this.activeAgentId,
            reason,
            timestamp: Date.now(),
          };

          const result = await this.handoff(this.activeAgentId, agentId, reason, context);

          if (result.success) {
            return `✅ 控制权已移交给 ${result.toAgent}\n` +
              `原因: ${reason}\n` +
              (result.executionResult
                ? `执行结果: ${result.executionResult.substring(0, 500)}`
                : '目标 Agent 已接管');
          }
          return `❌ Handoff 失败: ${result.error}`;
        },
      },
      {
        name: 'handoff_suggest',
        description: '根据当前任务描述，建议最合适的 Agent 来处理。返回建议的 Agent ID、名称、推荐理由和置信度。',
        readOnly: true,
        parameters: {
          task: {
            type: 'string',
            description: '当前任务描述，用于匹配最合适的 Agent',
            required: true,
          },
        },
        execute: async (args) => {
          const task = args.task as string;
          const suggestion = await this.suggestHandoff(task);

          let output = `🎯 建议移交给: ${suggestion.suggestedAgentName} (${suggestion.suggestedAgentId})\n`;
          output += `推荐理由: ${suggestion.reasoning}\n`;
          output += `置信度: ${(suggestion.confidence * 100).toFixed(0)}%\n`;

          if (suggestion.alternatives.length > 0) {
            output += `\n备选方案:\n`;
            for (const alt of suggestion.alternatives) {
              output += `  - ${alt.agentName} (${alt.agentId}), 评分: ${alt.score.toFixed(0)}\n`;
            }
          }

          return output;
        },
      },
      {
        name: 'handoff_list',
        description: '列出所有可用的 Agent 及其能力描述，帮助决定将控制权移交给谁。',
        readOnly: true,
        parameters: {},
        execute: () => {
          const agents = Array.from(this.agents.values());
          let output = `📋 已注册 Agent (${agents.length}个):\n\n`;

          for (const agent of agents) {
            const isActive = agent.id === this.activeAgentId;
            const marker = isActive ? '🟢 [当前活跃]' : '⚪';
            output += `${marker} ${agent.name} (${agent.id})\n`;
            output += `  领域: ${agent.domain} | 能力: ${agent.capabilities.join(', ')}\n`;
            output += `  移交条件: ${agent.handoffDescription.substring(0, 80)}...\n\n`;
          }

          return Promise.resolve(output);
        },
      },
      {
        name: 'handoff_history',
        description: '查看 Handoff 历史记录，了解控制权转移的完整链路。',
        readOnly: true,
        parameters: {
          limit: {
            type: 'string',
            description: '返回最近 N 条记录，默认 10',
            required: false,
          },
        },
        execute: (args) => {
          const limit = parseInt(args.limit as string) || 10;
          const records = this.history.slice(-limit);

          if (records.length === 0) {
            return Promise.resolve('📭 暂无 Handoff 历史记录');
          }

          let output = `📜 Handoff 历史 (最近 ${records.length} 条):\n\n`;

          for (const record of records) {
            const time = new Date(record.timestamp).toLocaleString('zh-CN');
            const status = record.success ? '✅' : '❌';
            output += `${status} [${time}] ${record.fromAgent} → ${record.toAgent}\n`;
            output += `  原因: ${record.reason.substring(0, 60)}\n`;
            output += `  上下文大小: ${(record.contextSize / 1024).toFixed(1)}KB\n\n`;
          }

          return Promise.resolve(output);
        },
      },
    ];
  }

  // ========== 私有方法 ==========

  /**
   * 构建 Handoff 上下文注入块
   */
  private buildContextBlock(context: HandoffContext): string {
    const parts: string[] = [];

    parts.push('## 🔄 Handoff 上下文');
    parts.push(`- 来源 Agent: ${context.fromAgentName} (${context.fromAgentId})`);
    parts.push(`- 移交原因: ${context.reason}`);
    parts.push(`- 移交时间: ${new Date(context.timestamp).toLocaleString('zh-CN')}`);

    // 任务状态
    if (context.taskState && Object.keys(context.taskState).length > 0) {
      parts.push('\n### 📋 任务状态');
      for (const [key, value] of Object.entries(context.taskState)) {
        parts.push(`- ${key}: ${JSON.stringify(value).substring(0, 200)}`);
      }
    }

    // 记忆
    if (context.memories && context.memories.length > 0) {
      parts.push('\n### 🧠 相关记忆');
      for (const memory of context.memories.slice(0, 5)) {
        parts.push(`- ${memory.substring(0, 150)}`);
      }
    }

    // 对话历史摘要
    if (context.conversationHistory.length > 0) {
      parts.push('\n### 💬 对话历史摘要');
      const recent = context.conversationHistory.slice(-6);
      for (const msg of recent) {
        let role: string;
        if (msg.role === 'user') {
          role = '👤';
        } else if (msg.role === 'assistant') {
          role = '🤖';
        } else {
          role = '💬';
        }
        parts.push(`${role} ${msg.content.substring(0, 150)}`);
      }
    }

    parts.push('\n---');
    parts.push('请基于以上上下文继续处理任务。');

    return parts.join('\n');
  }

  /**
   * 为 Agent 计算与任务的匹配分数
   */
  private scoreAgentForTask(agent: AgentDefinition, task: string): {
    score: number;
    reasoning: string;
  } {
    let score = 0;
    const reasons: string[] = [];

    // 1. 领域关键词匹配（权重最高）
    const domainKeywords: Record<string, string[]> = {
      general: ['聊天', '问答', '帮助', '你好', '什么', '怎么', '为什么', 'chat', 'help', 'question', 'hello'],
      development: ['代码', '编程', '函数', '实现', '写', '创建', '修改', '开发', 'code', 'program', 'function', 'implement', 'write', 'create', 'bug', 'fix', 'feature'],
      architecture: ['架构', '设计', '系统', '方案', '选型', '评估', '规划', 'architecture', 'design', 'system', 'plan', 'evaluate'],
      debugging: ['调试', 'bug', '错误', '异常', '崩溃', '排查', '诊断', 'debug', 'error', 'exception', 'crash', 'diagnose', 'trace', 'stack'],
      review: ['审查', '检查', '质量', '安全', '规范', '优化', 'review', 'check', 'quality', 'security', 'lint', 'audit'],
      devops: ['部署', '运维', 'docker', 'k8s', 'kubernetes', 'ci', 'cd', '监控', 'deploy', 'devops', 'container', 'infrastructure', 'nginx', 'server'],
    };

    const keywords = domainKeywords[agent.domain] || [];
    let keywordMatches = 0;
    for (const keyword of keywords) {
      if (task.includes(keyword)) {
        keywordMatches++;
      }
    }
    if (keywordMatches > 0) {
      const keywordScore = Math.min(keywordMatches * 15, 60);
      score += keywordScore;
      reasons.push(`领域关键词匹配 ${keywordMatches} 个 (+${keywordScore})`);
    }

    // 2. 能力标签匹配
    const capabilityKeywords: Record<string, string[]> = {
      conversation: ['聊天', '对话', '问答', 'chat', 'talk', 'conversation'],
      coding: ['代码', '编程', 'code', 'coding', 'programming', 'develop'],
      reasoning: ['分析', '推理', 'reason', 'analyze', 'logic'],
      analysis: ['分析', '统计', 'analyze', 'statistics', 'data'],
      debugging: ['调试', 'bug', 'debug', 'fix', 'error'],
      design: ['设计', '架构', 'design', 'architecture'],
      review: ['审查', '检查', 'review', 'check', 'audit'],
      deployment: ['部署', '发布', 'deploy', 'release', 'publish'],
    };

    let capabilityMatches = 0;
    for (const cap of agent.capabilities) {
      const capKws = capabilityKeywords[cap] || [];
      for (const kw of capKws) {
        if (task.includes(kw)) {
          capabilityMatches++;
          break;
        }
      }
    }
    if (capabilityMatches > 0) {
      const capScore = Math.min(capabilityMatches * 10, 30);
      score += capScore;
      reasons.push(`能力匹配 ${capabilityMatches} 项 (+${capScore})`);
    }

    // 3. handoffDescription 语义匹配（简单关键词重叠）
    const descWords = agent.handoffDescription.toLowerCase().split(/\s+/);
    const taskWords = task.split(/\s+/);
    let descOverlap = 0;
    for (const tw of taskWords) {
      if (tw.length > 1 && descWords.some(dw => dw.includes(tw))) {
        descOverlap++;
      }
    }
    if (descOverlap > 0) {
      const descScore = Math.min(descOverlap * 5, 15);
      score += descScore;
      reasons.push(`描述重叠 ${descOverlap} 个词 (+${descScore})`);
    }

    // 4. 基础分（避免零分）
    score += 5;

    const reasoning = reasons.length > 0
      ? reasons.join('；')
      : '无明确匹配，作为默认选择';

    return { score, reasoning };
  }
}
