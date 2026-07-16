/**
 * SubAgent 编排引擎
 * 借鉴 Claude Code 的 SubAgent 机制：独立上下文 + 专家角色 + 权限隔离 + 并行执行
 * 父 Agent 只拿最终 Summary，脏活全归子 Agent
 */

import type { LoopEvent, TerminalReason } from './agent-loop-types.js';
import type { SelfAwareness } from './self-awareness.js';
import { CognitiveState } from './cognitive-state.js';
import { EventBus } from './event-bus.js';
import { mapWithConcurrency } from '../utils/concurrency.js';
import * as fs from 'fs';
import * as path from 'path';

// ============ 新版 SubAgent 类型（v2） ============

/** SubAgent 配置（v2 — 简化版，用于 dispatch 模式） */
export interface SubAgentConfigV2 {
  name: string;
  description: string;
  systemPrompt: string;
  allowedTools: string[];
  model?: string;
  maxTurns: number;
}

/** SubAgent 运行状态（v2） */
export interface SubAgentState {
  taskId: string;
  status: 'idle' | 'running' | 'waiting_human' | 'completed' | 'error';
  messages: Array<{ role: string; content: string; timestamp: number }>;
  tokenUsage: number;
  result?: string;
  error?: string;
}

/** 预定义的 SubAgent 角色（v2） */
export const BUILTIN_SUB_AGENTS: Record<string, SubAgentConfigV2> = {
  'code-reviewer': {
    name: 'code-reviewer',
    description: '代码审查专家，负责审查代码质量、安全性和最佳实践',
    systemPrompt: '你是一个高级代码审查专家。你的任务是：1. 审查代码质量和可读性 2. 检查安全漏洞 3. 建议改进方案。只返回审查结果摘要，不要修改代码。',
    allowedTools: ['file_read', 'file_list', 'shell_execute', 'web_search'],
    maxTurns: 10,
  },
  'test-runner': {
    name: 'test-runner',
    description: '测试工程师，负责编写和运行测试',
    systemPrompt: '你是一个测试工程师。你的任务是：1. 分析需要测试的代码 2. 编写测试用例 3. 运行测试并报告结果。只返回测试结果摘要。',
    allowedTools: ['file_read', 'file_write', 'file_list', 'shell_execute', 'code_execute'],
    maxTurns: 15,
  },
  'architect': {
    name: 'architect',
    description: '架构师，负责系统设计和架构分析',
    systemPrompt: '你是一个系统架构师。你的任务是：1. 分析现有架构 2. 设计改进方案 3. 输出架构设计文档。只返回架构分析摘要和设计建议。',
    allowedTools: ['file_read', 'file_list', 'web_search', 'web_fetch'],
    maxTurns: 10,
  },
  'doc-writer': {
    name: 'doc-writer',
    description: '文档编写专家，负责生成和更新文档',
    systemPrompt: '你是一个技术文档专家。你的任务是：1. 分析代码和功能 2. 编写清晰的技术文档 3. 更新现有文档。只返回文档编写结果摘要。',
    allowedTools: ['file_read', 'file_write', 'file_list', 'web_search'],
    maxTurns: 10,
  },
};

// ============ 旧版兼容类型（v1 — 保持向后兼容） ============

/** Agent Runner 函数签名 — 可由 EnhancedAgentLoop.run 或 agent-loop.runAgentLoop 实现 */
export type AgentRunner = (
  input: string,
  context: Array<{ role: string; content: string }>,
  options?: { tokenBudget?: number; customSystemPrompt?: string; showThinking?: boolean },
) => AsyncGenerator<LoopEvent, TerminalReason, void>;

export interface SubAgentConfig {
  id: string;
  name: string;
  goal: string;
  context: string[];
  priority: number;           // 0-1
  maxRounds?: number;
  tokenBudget?: number;
  /** 工具权限白名单 — 只允许子Agent使用这些工具，为空则继承全部 */
  allowedTools?: string[];
  /** 是否启用上下文隔离 — 隔离时子Agent不继承主Agent的历史对话 */
  contextIsolation?: boolean;
  /** 角色类型 — 标准角色矩阵 */
  role?: 'planner' | 'implementer' | 'reviewer' | 'researcher' | 'custom';
}

export interface SubAgentResult {
  id: string;
  name: string;
  success: boolean;
  summary: string;
  events: LoopEvent[];
  terminal: TerminalReason | null;
  duration: number;
  error?: string;
}

export type AgentStatus = 'idle' | 'running' | 'completed' | 'error';

/** 并行任务定义（带依赖关系） */
export interface SubAgentTask {
  id: string;
  prompt: string;
  dependencies?: string[];
  priority?: number;
}

export interface AgentWorker {
  id: string;
  name: string;
  status: AgentStatus;
  config: SubAgentConfig;
  result: SubAgentResult | null;
  startedAt: number;
}

// ============ SubAgentOrchestrator（v1 兼容 + v2 新增） ============

export class SubAgentOrchestrator {
  // v1 兼容字段
  private workers: Map<string, AgentWorker> = new Map();
  private maxConcurrent: number;
  private selfAwareness: SelfAwareness;
  private cognitiveState: CognitiveState;
  private agentRunner: AgentRunner | null = null;

  // v2 新增字段
  private activeSubAgents: Map<string, SubAgentState> = new Map();
  private configV2: Record<string, SubAgentConfigV2>;
  // C1 修复：EventBus 用于发射 SubAgent 事件（SSE 端点订阅转发到前端）
  private eventBus: EventBus;

  constructor(
    selfAwareness: SelfAwareness,
    cognitiveState: CognitiveState,
    maxConcurrent: number = 3,
  ) {
    this.selfAwareness = selfAwareness;
    this.cognitiveState = cognitiveState;
    this.maxConcurrent = maxConcurrent;
    this.configV2 = { ...BUILTIN_SUB_AGENTS };
    this.eventBus = EventBus.getInstance();
  }

  // ============ agents/*.md 配置加载 ============

  /**
   * 从目录加载 SubAgent 配置文件（.md）
   * 解析 markdown 中的角色描述、权限、工作流程等字段，注册为 SubAgentConfigV2
   * @param dirPath agents 目录路径（默认为项目根目录下的 agents/）
   * @returns 成功加载的 SubAgent 数量
   */
  loadAgentsFromDirectory(dirPath: string = path.join(process.cwd(), 'agents')): number {
    let loaded = 0;
    try {
      if (!fs.existsSync(dirPath)) return 0;
      const files = fs.readdirSync(dirPath).filter(f => f.endsWith('.md'));
      for (const file of files) {
        try {
          const filePath = path.join(dirPath, file);
          const content = fs.readFileSync(filePath, 'utf-8');
          const config = this.parseAgentMarkdown(content, file);
          if (config) {
            this.configV2[config.name] = config;
            loaded++;
          }
        } catch {
          // 单个文件解析失败，跳过继续
        }
      }
    } catch {
      // 目录读取失败，静默降级
    }
    return loaded;
  }

  /**
   * 注册单个 SubAgent 配置
   */
  registerSubAgent(config: SubAgentConfigV2): void {
    this.configV2[config.name] = config;
  }

  /**
   * 解析 Agent Markdown 配置文件
   * 格式：
   *   # Title — Description
   *   ## 角色描述  → description + systemPrompt
   *   ## 权限      → allowedTools（解析 - 开头的工具列表）
   *   ## 工作流程  → systemPrompt 补充
   *   ## 输出格式  → systemPrompt 补充
   *   ## 约束      → systemPrompt 补充
   */
  private parseAgentMarkdown(content: string, fileName: string): SubAgentConfigV2 | null {
    try {
      // 从文件名生成 slug：code-analyzer.md → code-analyzer
      const baseName = fileName.replace(/\.md$/i, '');

      // 解析标题行：# Code Analyzer — 代码分析员
      const titleMatch = content.match(/^#\s+(.+?)(?:\s*[—–-]\s*(.+))?$/m);
      const titleEn = titleMatch?.[1]?.trim() || baseName;
      const titleCn = titleMatch?.[2]?.trim() || '';

      // 从标题生成 name（slugify）：Code Analyzer → code-analyzer
      const name = baseName
        .toLowerCase()
        .replace(/[^a-z0-9]+/g, '-')
        .replace(/^-+|-+$/g, '');

      // 提取各章节内容
      const getSection = (heading: string): string => {
        const regex = new RegExp(`^##\\s+${heading}\\s*$([\\s\\S]*?)(?=^##\\s+|$)`, 'm');
        const match = content.match(regex);
        return match?.[1]?.trim() || '';
      };

      const roleDesc = getSection('角色描述');
      const permissions = getSection('权限');
      const workflow = getSection('工作流程');
      const outputFormat = getSection('输出格式');
      const constraints = getSection('约束');

      // 解析权限中的工具列表
      // 格式：- 读写访问：file_read, file_write, search_files
      //       - 命令执行：shell_execute（仅用于构建和测试）
      //       - 禁止：web_search, web_fetch
      const allowedTools: string[] = [];
      const forbiddenTools = new Set<string>();
      const toolLineRegex = /-\s*(?:([^：:]+)[：:])?\s*([^（(]+)/g;
      const forbiddenRegex = /禁止[：:]?\s*([^\n]+)/;
      const forbiddenMatch = permissions.match(forbiddenRegex);
      if (forbiddenMatch) {
        forbiddenMatch[1].split(/[,，、\s]+/).forEach((t: string) => {
          const tool = t.trim().toLowerCase().replace(/[_\s]/g, '_');
          if (tool && !tool.includes('任何') && !tool.includes('修改')) forbiddenTools.add(tool);
        });
      }
      let m: RegExpExecArray | null;
      while ((m = toolLineRegex.exec(permissions)) !== null) {
        const toolsStr = m[2];
        toolsStr.split(/[,，、\s]+/).forEach((t: string) => {
          const tool = t.trim().toLowerCase().replace(/[_\s]/g, '_');
          // 匹配常见的工具名格式：file_read, shell_execute 等
          if (/^[a-z][a-z_]*$/.test(tool) && !forbiddenTools.has(tool)) {
            allowedTools.push(tool);
          }
        });
      }

      // 去重
      const uniqueTools = [...new Set(allowedTools)];

      // 构建 systemPrompt：角色描述 + 工作流程 + 输出格式 + 约束
      const systemPromptParts: string[] = [];
      if (roleDesc) systemPromptParts.push(roleDesc);
      if (workflow) systemPromptParts.push(`## 工作流程\n${workflow}`);
      if (outputFormat) systemPromptParts.push(`## 输出格式\n${outputFormat}`);
      if (constraints) systemPromptParts.push(`## 约束\n${constraints}`);
      const systemPrompt = systemPromptParts.join('\n\n') || roleDesc || titleEn;

      // description：中文标题优先，否则用角色描述首行
      const description = titleCn || roleDesc.split('\n')[0] || titleEn;

      return {
        name,
        description,
        systemPrompt,
        allowedTools: uniqueTools.length > 0 ? uniqueTools : ['file_read', 'file_list'],
        maxTurns: 10,
      };
    } catch {
      return null;
    }
  }

  /** 获取所有已注册的 SubAgent 配置（内置 + 从 .md 加载） */
  getRegisteredAgents(): Record<string, SubAgentConfigV2> {
    return { ...this.configV2 };
  }

  // ============ v1 兼容方法 ============

  /** 注入 Agent Runner（由 EnhancedAgentLoop 或 agent-loop 提供） */
  setAgentRunner(runner: AgentRunner): void {
    this.agentRunner = runner;
  }

  canSpawn(): boolean {
    const running = this.getRunningCount();
    return running < this.maxConcurrent;
  }

  getRunningCount(): number {
    return Array.from(this.workers.values()).filter(w => w.status === 'running').length;
  }

  spawnAgent(config: SubAgentConfig): Promise<string> {
    if (!this.canSpawn()) {
      return Promise.reject(new Error('已达到最大并发Agent数'));
    }

    const id = config.id || `agent_${Date.now()}_${Math.random().toString(36).substr(2, 6)}`;
    const worker: AgentWorker = {
      id,
      name: config.name,
      status: 'running',
      config: { ...config, id },
      result: null,
      startedAt: Date.now(),
    };
    this.workers.set(id, worker);

    this.cognitiveState.think(`派生子Agent: ${config.name} — ${config.goal.substring(0, 50)}`, 'spawn_agent');

    // Run agent asynchronously
    this.executeAgent(worker).catch(err => {
      worker.status = 'error';
      worker.result = {
        id: worker.id,
        name: worker.name,
        success: false,
        summary: `执行失败: ${err.message}`,
        events: [],
        terminal: { type: 'error', error: err.message, recoverable: false },
        duration: Date.now() - worker.startedAt,
        error: err.message,
      };
    });

    return Promise.resolve(id);
  }

  private async executeAgent(worker: AgentWorker): Promise<void> {
    const events: LoopEvent[] = [];
    const contextMessages = worker.config.contextIsolation
      ? []
      : worker.config.context.map(c => ({ role: 'user' as const, content: c }));

    const subCognitiveState = new CognitiveState();
    const roleConfig = this.getRoleConfig(worker.config.role);

    const systemPrompt = `你是子Agent "${worker.name}"，是段先生系统的一部分。
你的角色: ${roleConfig.description}
你的任务: ${worker.config.goal}
${(worker.config.allowedTools || roleConfig.allowedTools) ? `你只能使用以下工具: ${(worker.config.allowedTools || roleConfig.allowedTools)!.join(', ')}` : ''}
请专注于完成这个任务并将结果返回给主Agent。
完成后给出简洁清晰的结果总结。`;

    const runner = this.agentRunner;
    if (!runner) {
      worker.status = 'error';
      worker.result = {
        id: worker.id, name: worker.name, success: false,
        summary: 'Agent Runner 未注入，请在 Orchestrator 上调用 setAgentRunner()',
        events: [], terminal: { type: 'error', error: 'No runner', recoverable: true },
        duration: Date.now() - worker.startedAt,
      };
      return;
    }

    const generator = runner(worker.config.goal, contextMessages, {
      tokenBudget: worker.config.tokenBudget || 20000,
      customSystemPrompt: systemPrompt,
    });

    let terminal: TerminalReason = { type: 'completed', summary: '' };

    try {
      for await (const event of generator) {
        if (event.type === 'tool_call' && (worker.config.allowedTools || roleConfig.allowedTools)) {
          const allowed = worker.config.allowedTools || roleConfig.allowedTools!;
          if (event.toolName && !allowed.includes(event.toolName)) {
            subCognitiveState.think(`越权工具 ${event.toolName} 被拦截`, 'agent_security');
            continue;
          }
        }
        events.push(event);
        if (event.type === 'error') {
          subCognitiveState.think(`错误: ${event.content}`, 'agent_error');
        }
      }
    } catch (err: unknown) {
      terminal = { type: 'error', error: (err instanceof Error ? err.message : String(err)), recoverable: false };
    }

    const summary = this.generateSmartSummary(events, worker.config.goal);

    worker.status = 'completed';
    worker.result = {
      id: worker.id,
      name: worker.name,
      success: terminal.type === 'completed',
      summary,
      events,
      terminal,
      duration: Date.now() - worker.startedAt,
    };

    this.cognitiveState.think(`子Agent ${worker.name} 完成: ${summary.substring(0, 100)}`, 'agent_complete');
  }

  /** 标准角色矩阵配置 */
  private getRoleConfig(role?: string): { description: string; allowedTools?: string[] } {
    switch (role) {
      case 'planner':
        return { description: '规划者 — 负责分析任务、拆解步骤、输出执行计划', allowedTools: ['file_read', 'search_files', 'list_directory', 'web_search', 'web_fetch'] };
      case 'implementer':
        return { description: '执行者 — 按计划写代码、修改文件、执行命令', allowedTools: ['file_read', 'file_write', 'shell_execute', 'code_execute', 'search_files', 'list_directory'] };
      case 'reviewer':
        return { description: '审查者 — 对比Diff、检查代码质量、挑毛病', allowedTools: ['file_read', 'search_files', 'list_directory'] };
      case 'researcher':
        return { description: '调研员 — 查阅外部文档、搜索资料', allowedTools: ['web_search', 'web_fetch', 'file_read'] };
      default:
        return { description: '通用子Agent' };
    }
  }

  /** 智能结果摘要 */
  private generateSmartSummary(events: LoopEvent[], _goal: string): string {
    const textEvents = events.filter(e => e.type === 'text').map(e => e.content);
    const finalText = textEvents.length > 0 ? textEvents[textEvents.length - 1] : '';

    const toolResults = events.filter(e => e.type === 'tool_result');
    const toolSummary = toolResults.length > 0
      ? `执行了 ${toolResults.length} 个工具调用`
      : '';

    const errors = events.filter(e => e.type === 'error').map(e => e.content);
    const errorSummary = errors.length > 0 ? `遇到 ${errors.length} 个错误` : '';

    let summary = '';
    if (finalText) {
      summary = finalText.length > 1200 ? finalText.substring(0, 1200) + '...' : finalText;
    }
    if (toolSummary) summary += `\n[${toolSummary}]`;
    if (errorSummary) summary += `\n[${errorSummary}]`;

    return summary.substring(0, 1500) || '(无输出)';
  }

  async spawnMultiple(configs: SubAgentConfig[]): Promise<string[]> {
    const ids: string[] = [];
    for (const config of configs) {
      if (!this.canSpawn()) break;
      const id = await this.spawnAgent(config);
      ids.push(id);
    }
    return ids;
  }

  getWorker(id: string): AgentWorker | undefined {
    return this.workers.get(id);
  }

  getAllWorkers(): AgentWorker[] {
    return Array.from(this.workers.values());
  }

  getCompletedResults(): SubAgentResult[] {
    return Array.from(this.workers.values())
      .filter(w => w.status === 'completed' && w.result)
      .map(w => w.result!);
  }

  async waitForAll(timeoutMs: number = 60000): Promise<SubAgentResult[]> {
    const start = Date.now();
    const running = () => Array.from(this.workers.values()).filter(w => w.status === 'running');

    while (running().length > 0 && Date.now() - start < timeoutMs) {
      await new Promise(resolve => setTimeout(resolve, 500));
    }

    return this.getCompletedResults();
  }

  async waitForId(id: string, timeoutMs: number = 30000): Promise<SubAgentResult | null> {
    const start = Date.now();
    const worker = this.workers.get(id);
    if (!worker) return null;

    while (worker.status === 'running' && Date.now() - start < timeoutMs) {
      await new Promise(resolve => setTimeout(resolve, 200));
    }

    return worker.result;
  }

  getStatusReport(): string {
    const all = Array.from(this.workers.values());
    const running = all.filter(w => w.status === 'running');
    const completed = all.filter(w => w.status === 'completed');
    const errored = all.filter(w => w.status === 'error');

    let output = `🤖 **子Agent报告**\n\n`;
    output += `总计: ${all.length} | 运行中: ${running.length} | 完成: ${completed.length} | 错误: ${errored.length}\n\n`;

    if (running.length > 0) {
      output += `**运行中**:\n`;
      for (const w of running) {
        const elapsed = ((Date.now() - w.startedAt) / 1000).toFixed(0);
        output += `  ⏳ ${w.name}: ${w.config.goal.substring(0, 60)}... (${elapsed}s)\n`;
      }
    }

    if (completed.length > 0) {
      output += `\n**已完成**:\n`;
      for (const w of completed.slice(-5)) {
        const duration = ((w.result?.duration || 0) / 1000).toFixed(1);
        output += `  ✅ ${w.name}: ${(w.result?.summary || '').substring(0, 80)} (${duration}s)\n`;
      }
    }

    if (errored.length > 0) {
      output += `\n**错误**:\n`;
      for (const w of errored) {
        output += `  ❌ ${w.name}: ${w.result?.error || '未知错误'}\n`;
      }
    }

    return output;
  }

  getMaxConcurrent(): number {
    return this.maxConcurrent;
  }

  setMaxConcurrent(n: number): void {
    this.maxConcurrent = Math.max(1, n);
  }

  async executeParallel(tasks: SubAgentTask[]): Promise<Map<string, SubAgentResult>> {
    const completed = new Map<string, SubAgentResult>();
    const taskMap = new Map(tasks.map(t => [t.id, t]));
    const remaining = new Set(tasks.map(t => t.id));

    // 循环依赖检测
    const visited = new Set<string>();
    const inStack = new Set<string>();
    const hasCycle = (id: string): boolean => {
      if (inStack.has(id)) return true;
      if (visited.has(id)) return false;
      visited.add(id);
      inStack.add(id);
      const task = taskMap.get(id);
      if (task?.dependencies) {
        for (const dep of task.dependencies) {
          if (hasCycle(dep)) return true;
        }
      }
      inStack.delete(id);
      return false;
    };
    for (const task of tasks) {
      if (hasCycle(task.id)) {
        throw new Error(`检测到循环依赖，涉及任务: ${task.id}`);
      }
    }

    let iteration = 0;
    const maxIterations = tasks.length * 3;

    while (remaining.size > 0 && iteration < maxIterations) {
      iteration++;

      const ready: SubAgentTask[] = [];
      for (const id of remaining) {
        const task = taskMap.get(id)!;
        const depsReady = !task.dependencies || task.dependencies.every(dep => completed.has(dep));
        if (depsReady) {
          ready.push(task);
        }
      }

      if (ready.length === 0 && remaining.size > 0) {
        const unmet = [...remaining].map(id => {
          const task = taskMap.get(id)!;
          const unmetDeps = (task.dependencies || []).filter(d => !completed.has(d));
          return `${id} (等待: ${unmetDeps.join(', ')})`;
        });
        throw new Error(`任务依赖无法满足: ${unmet.join('; ')}`);
      }

      ready.sort((a, b) => (b.priority || 0.5) - (a.priority || 0.5));

      const toExecute = ready.slice(0, this.maxConcurrent - this.getRunningCount());
      if (toExecute.length === 0) {
        await new Promise(resolve => setTimeout(resolve, 500));
        continue;
      }

      const spawnPromises = toExecute.map(task =>
        this.spawnAgent({
          id: task.id,
          name: task.id,
          goal: task.prompt,
          context: task.dependencies
            ?.filter(depId => completed.has(depId))
            .map(depId => `前置任务 ${depId} 结果: ${completed.get(depId)!.summary.substring(0, 500)}`) || [],
          priority: task.priority || 0.5,
        }),
      );

      const _ids = await Promise.all(spawnPromises);

      const results = await this.waitForAll(120000);
      for (const result of results) {
        completed.set(result.id, result);
        remaining.delete(result.id);
      }
    }

    return completed;
  }

  // ============ v2 新增方法 ============

  /**
   * 派发子任务给 SubAgent（v2 — 简化版，LLM Caller 注入）
   */
  async dispatch(
    agentName: string,
    taskPrompt: string,
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    llmCaller: (messages: Array<{ role: string; content: string }>, tools?: any[]) => Promise<{ content: string; toolCalls?: any[] }>,
  ): Promise<SubAgentState> {
    const config = this.configV2[agentName];
    if (!config) {
      return {
        taskId: `sub_${Date.now()}`,
        status: 'error',
        messages: [],
        tokenUsage: 0,
        error: `Unknown SubAgent: ${agentName}`,
      };
    }

    const taskId = `sub_${agentName}_${Date.now()}`;
    const state: SubAgentState = {
      taskId,
      status: 'running',
      messages: [
        { role: 'system', content: config.systemPrompt, timestamp: Date.now() },
        { role: 'user', content: taskPrompt, timestamp: Date.now() },
      ],
      tokenUsage: 0,
    };

    this.activeSubAgents.set(taskId, state);

    // C1 修复：发射 subagent.dispatch 事件
    this.emitSubAgentEvent('subagent.dispatch', { taskId, agentName, taskPrompt: taskPrompt.substring(0, 200) });
    this.emitSubAgentEvent('subagent.status', { taskId, status: 'running' });

    try {
      for (let turn = 0; turn < config.maxTurns; turn++) {
        // C1 修复：发射 subagent.turn 事件
        this.emitSubAgentEvent('subagent.turn', { taskId, turn });

        const response = await llmCaller(state.messages);
        state.messages.push({ role: 'assistant', content: response.content, timestamp: Date.now() });

        if (!response.toolCalls || response.toolCalls.length === 0) {
          state.status = 'completed';
          state.result = response.content;
          break;
        }

        for (const tc of response.toolCalls) {
          const allowed = config.allowedTools.includes(tc.name);
          // C1 修复：发射 subagent.tool_call 事件
          this.emitSubAgentEvent('subagent.tool_call', { taskId, toolName: tc.name, allowed });

          if (allowed) {
            const toolResult = `[SubAgent ${agentName} executed ${tc.name}]`;
            state.messages.push({
              role: 'tool_result',
              content: toolResult,
              timestamp: Date.now(),
            });
            // C1 修复：发射 subagent.tool_result 事件
            this.emitSubAgentEvent('subagent.tool_result', { taskId, toolName: tc.name, result: toolResult });
          } else {
            const toolResult = `Tool ${tc.name} not allowed for SubAgent ${agentName}`;
            state.messages.push({
              role: 'tool_result',
              content: toolResult,
              timestamp: Date.now(),
            });
            this.emitSubAgentEvent('subagent.tool_result', { taskId, toolName: tc.name, result: toolResult });
          }
        }
      }

      if (state.status === 'running') {
        state.status = 'completed';
        state.result = state.messages[state.messages.length - 1]?.content || 'SubAgent reached max turns';
      }
    } catch (err: unknown) {
      state.status = 'error';
      state.error = (err instanceof Error ? err.message : String(err));
    }

    // C1 修复：发射 subagent.status 和 subagent.completed 事件
    this.emitSubAgentEvent('subagent.status', { taskId, status: state.status });
    this.emitSubAgentEvent('subagent.completed', { taskId, result: state.result?.substring(0, 500), tokenUsage: state.tokenUsage });

    return state;
  }

  /**
   * C1 修复：发射 SubAgent 事件到 EventBus（SSE 端点订阅转发到前端）
   * 使用 try/catch 吞错，避免事件发射失败影响主流程
   */
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  private emitSubAgentEvent(type: string, data: Record<string, any>): void {
    try {
      this.eventBus.emitSync(type, { ...data, timestamp: Date.now() }, { source: 'SubAgentOrchestrator' });
    } catch {
      // 事件发射失败不影响主流程
    }
  }

  /**
   * 并行派发多个子任务（v2）
   * 限制并发数为 3，避免同时发起过多 LLM 调用导致 API 限流或内存压力
   */
  dispatchParallel(
    tasks: Array<{ agent: string; prompt: string }>,
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    llmCaller: (messages: Array<{ role: string; content: string }>, tools?: any[]) => Promise<{ content: string; toolCalls?: any[] }>,
  ): Promise<SubAgentState[]> {
    return mapWithConcurrency(tasks, 3, t => this.dispatch(t.agent, t.prompt, llmCaller));
  }

  /**
   * 获取所有可用的 SubAgent 配置（v2）
   */
  getAvailableAgents(): SubAgentConfigV2[] {
    return Object.values(this.configV2);
  }

  /**
   * 注册自定义 SubAgent（v2）
   */
  registerAgent(config: SubAgentConfigV2): void {
    this.configV2[config.name] = config;
  }

  /**
   * 获取活跃的 SubAgent 状态（v2）
   */
  getActiveSubAgents(): SubAgentState[] {
    return Array.from(this.activeSubAgents.values()).filter(s => s.status === 'running');
  }
}
