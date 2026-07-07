/**
 * 惰性工具注册表 + 模型感知工具过滤
 *
 * 设计源自 OpenCode 的工具系统：
 * - 工具延迟初始化：init() 首次使用时才调用
 * - 模型感知过滤：不同模型获得不同的工具集
 * - 并行执行标记：只读工具可并行，写工具串行
 * - 元数据回调：工具执行时实时更新 UI
 */

import { EventBus, Events } from './event-bus.js';

// ============ 类型定义 ============

export interface LazyToolDef {
  id: string;
  name: string;
  description: string;
  parameters: Record<string, {
    type: string;
    description: string;
    required?: boolean;
  }>;
  /** 延迟初始化函数（首次调用时执行） */
  init?: () => Promise<void>;
  /** 是否已初始化 */
  initialized: boolean;
  /** 执行函数 */
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  execute: (args: any) => Promise<string>;
  /** 只读工具可以并行执行 */
  readOnly?: boolean;
  /** 支持该工具的最低模型能力级别 */
  minModelTier?: 'basic' | 'standard' | 'advanced' | 'reasoning';
  /** 工具分类 */
  category?: string;
  /** 风险等级 */
  riskLevel?: 'safe' | 'moderate' | 'dangerous';
  /** 初始化错误 */
  initError?: string;
  /** 优先级：影响预热顺序，critical 优先初始化 */
  priority?: 'critical' | 'high' | 'normal' | 'low';
  /** 初始化超时时间（毫秒），默认 10000 */
  initTimeoutMs?: number;
  /** 依赖的其他工具 ID（初始化前会先初始化依赖） */
  dependsOn?: string[];
}

export type ModelTier = 'basic' | 'standard' | 'advanced' | 'reasoning';

/** 模型能力描述 */
export interface ModelCapability {
  tier: ModelTier;
  supportsVision: boolean;
  supportsFunctionCalling: boolean;
  supportsStreaming: boolean;
  supportsThinking: boolean;
  maxTokens: number;
}

// ============ 模型能力预设 ============

export const MODEL_CAPABILITIES: Record<string, ModelCapability> = {
  'deepseek-chat': {
    tier: 'advanced',
    supportsVision: false,
    supportsFunctionCalling: true,
    supportsStreaming: true,
    supportsThinking: false,
    maxTokens: 32000,
  },
  'deepseek-reasoner': {
    tier: 'reasoning',
    supportsVision: false,
    supportsFunctionCalling: true,
    supportsStreaming: true,
    supportsThinking: true,
    maxTokens: 64000,
  },
  'gpt-4': {
    tier: 'advanced',
    supportsVision: false,
    supportsFunctionCalling: true,
    supportsStreaming: true,
    supportsThinking: false,
    maxTokens: 32000,
  },
  'gpt-4o': {
    tier: 'advanced',
    supportsVision: true,
    supportsFunctionCalling: true,
    supportsStreaming: true,
    supportsThinking: false,
    maxTokens: 32000,
  },
  'claude-3-opus': {
    tier: 'reasoning',
    supportsVision: true,
    supportsFunctionCalling: true,
    supportsStreaming: true,
    supportsThinking: true,
    maxTokens: 64000,
  },
  'claude-3-sonnet': {
    tier: 'advanced',
    supportsVision: true,
    supportsFunctionCalling: true,
    supportsStreaming: true,
    supportsThinking: false,
    maxTokens: 32000,
  },
};

// ============ 惰性工具注册表 ============

export class LazyToolRegistry {
  private tools: Map<string, LazyToolDef> = new Map();
  private eventBus: EventBus;
  /** 单飞模式：记录正在进行的初始化 Promise，避免并发重复初始化 */
  private inflightInits: Map<string, Promise<void>> = new Map();
  /** 默认初始化超时 */
  private readonly DEFAULT_INIT_TIMEOUT_MS = 10_000;

  constructor() {
    this.eventBus = EventBus.getInstance();
  }

  /** 注册工具（惰性） */
  register(tool: LazyToolDef): void {
    if (this.tools.has(tool.id)) {
      console.warn(`[ToolRegistry] 工具 ${tool.id} 已存在，跳过注册`);
      return;
    }
    this.tools.set(tool.id, { ...tool, initialized: false });
    this.eventBus.emitSync(Events.TOOL_REGISTERED, {
      toolId: tool.id,
      name: tool.name,
      category: tool.category,
      readOnly: tool.readOnly,
    }, { source: 'tool-registry' });
  }

  /** 批量注册工具 */
  registerMany(tools: LazyToolDef[]): void {
    for (const tool of tools) {
      this.register(tool);
    }
  }

  /** 注销工具 */
  unregister(toolId: string): void {
    this.tools.delete(toolId);
    this.inflightInits.delete(toolId);
    this.eventBus.emitSync(Events.TOOL_UNREGISTERED, {
      toolId,
    }, { source: 'tool-registry' });
  }

  /** 获取工具（触发惰性初始化，单飞保护+超时+依赖管理） */
  async getTool(toolId: string): Promise<LazyToolDef | null> {
    const tool = this.tools.get(toolId);
    if (!tool) return null;

    if (!tool.initialized && tool.init && !tool.initError) {
      // 单飞模式：复用正在进行的初始化 Promise，避免并发重复 init
      let initPromise = this.inflightInits.get(toolId);
      if (initPromise === undefined) {
        initPromise = this.initializeWithDeps(toolId);
        this.inflightInits.set(toolId, initPromise);
      }
      try {
        await initPromise;
      } finally {
        this.inflightInits.delete(toolId);
      }
    }

    return tool;
  }

  /**
   * 带依赖管理和超时的初始化
   * 1. 先递归初始化依赖的工具
   * 2. 检测循环依赖
   * 3. 执行 init 并施加超时
   */
  private async initializeWithDeps(toolId: string, initStack: Set<string> = new Set()): Promise<void> {
    // 循环依赖检测
    if (initStack.has(toolId)) {
      throw new Error(`检测到循环依赖: ${[...initStack, toolId].join(' → ')}`);
    }
    initStack.add(toolId);

    const tool = this.tools.get(toolId);
    if (!tool || !tool.init || tool.initialized) return;

    // 先初始化依赖
    if (tool.dependsOn && tool.dependsOn.length > 0) {
      for (const depId of tool.dependsOn) {
        const dep = this.tools.get(depId);
        if (!dep) {
          throw new Error(`工具 ${toolId} 依赖未注册的工具 ${depId}`);
        }
        if (!dep.initialized && dep.init && !dep.initError) {
          await this.initializeWithDeps(depId, new Set(initStack));
        }
      }
    }

    // 带超时的初始化
    const timeoutMs = tool.initTimeoutMs || this.DEFAULT_INIT_TIMEOUT_MS;
    try {
      await this.withTimeout(tool.init(), timeoutMs, toolId);
      tool.initialized = true;
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      tool.initError = msg;
      console.error(`[ToolRegistry] 工具 ${toolId} 初始化失败:`, err);
    }
  }

  /** 带超时的 Promise 包装 */
  private withTimeout<T>(promise: Promise<T>, ms: number, toolId: string): Promise<T> {
    return new Promise<T>((resolve, reject) => {
      const timer = setTimeout(() => {
        reject(new Error(`工具 ${toolId} 初始化超时 (${ms}ms)`));
      }, ms);
      promise.then(
        (v) => { clearTimeout(timer); resolve(v); },
        (e) => { clearTimeout(timer); reject(e); },
      );
    });
  }

  /**
   * 预热：按优先级后台预初始化指定模型所需工具
   * 消除首次调用延迟尖峰
   */
  async warmup(modelName: string): Promise<void> {
    const tools = this.getToolsForModel(modelName);
    // 按优先级排序：critical > high > normal > low
    const priorityOrder: Record<string, number> = { critical: 0, high: 1, normal: 2, low: 3 };
    const sorted = tools.sort((a, b) => {
      const pa = priorityOrder[a.priority || 'normal'];
      const pb = priorityOrder[b.priority || 'normal'];
      return pa - pb;
    });

    // 并行初始化，但限制并发数为 5 避免资源争抢
    const batchSize = 5;
    for (let i = 0; i < sorted.length; i += batchSize) {
      const batch = sorted.slice(i, i + batchSize);
      await Promise.allSettled(
        batch.filter(t => t.init && !t.initialized && !t.initError)
          .map(t => this.getTool(t.id))
      );
    }
  }

  /**
   * 重试初始化失败的工具
   * 清除 initError 状态，允许重新初始化
   */
  async retryInit(toolId: string): Promise<boolean> {
    const tool = this.tools.get(toolId);
    if (!tool) return false;
    tool.initError = undefined;
    tool.initialized = false;
    await this.getTool(toolId);
    return tool.initialized;
  }

  /** 获取适合指定模型的所有工具 */
  getToolsForModel(modelName: string, options?: {
    includeCategories?: string[];
    excludeCategories?: string[];
    onlyReadOnly?: boolean;
  }): LazyToolDef[] {
    const capability = this.getModelCapability(modelName);
    const tierOrder: Record<ModelTier, number> = {
      basic: 0, standard: 1, advanced: 2, reasoning: 3,
    };
    const modelTier = tierOrder[capability.tier];

    const result: LazyToolDef[] = [];

    for (const tool of this.tools.values()) {
      // 初始化错误的不返回
      if (tool.initError) continue;

      // 模型能力过滤
      if (tool.minModelTier) {
        const requiredTier = tierOrder[tool.minModelTier];
        if (modelTier < requiredTier) continue;
      }

      // 分类过滤
      if (options?.includeCategories && tool.category) {
        if (!options.includeCategories.includes(tool.category)) continue;
      }
      if (options?.excludeCategories && tool.category) {
        if (options.excludeCategories.includes(tool.category)) continue;
      }

      // 只读过滤
      if (options?.onlyReadOnly && !tool.readOnly) continue;

      result.push(tool);
    }

    return result;
  }

  /** 获取所有工具（不触发初始化） */
  getAllTools(): LazyToolDef[] {
    return Array.from(this.tools.values());
  }

  /** 执行工具（自动初始化） */
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  async executeTool(toolId: string, args: any): Promise<string> {
    const tool = await this.getTool(toolId);
    if (!tool) {
      return `错误: 工具 ${toolId} 未找到`;
    }
    if (tool.initError) {
      return `错误: 工具初始化失败: ${tool.initError}`;
    }

    this.eventBus.emitSync(Events.TOOL_CALL_START, {
      toolId: tool.id,
      toolName: tool.name,
      args,
    }, { source: 'tool-registry' });

    try {
      const result = await tool.execute(args);

      this.eventBus.emitSync(Events.TOOL_CALL_COMPLETE, {
        toolId: tool.id,
        toolName: tool.name,
        success: true,
      }, { source: 'tool-registry' });

      return result;
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      this.eventBus.emitSync(Events.TOOL_CALL_ERROR, {
        toolId: tool.id,
        toolName: tool.name,
        error: msg,
      }, { source: 'tool-registry' });
      return `执行错误: ${msg}`;
    }
  }

  /** 获取模型能力 */
  getModelCapability(modelName: string): ModelCapability {
    return MODEL_CAPABILITIES[modelName] || {
      tier: 'standard',
      supportsVision: false,
      supportsFunctionCalling: true,
      supportsStreaming: true,
      supportsThinking: false,
      maxTokens: 16000,
    };
  }

  /** 注册模型能力 */
  registerModelCapability(modelName: string, capability: ModelCapability): void {
    MODEL_CAPABILITIES[modelName] = capability;
  }

  /** 获取工具统计（增强版：含预热状态和依赖信息） */
  getStats(): { total: number; initialized: number; errored: number; pending: number; withDeps: number } {
    let initialized = 0;
    let errored = 0;
    let pending = 0;
    let withDeps = 0;
    for (const tool of this.tools.values()) {
      if (tool.initError) errored++;
      if (tool.initialized) initialized++;
      else if (tool.init && !tool.initError) pending++;
      if (tool.dependsOn && tool.dependsOn.length > 0) withDeps++;
    }
    return {
      total: this.tools.size,
      initialized,
      errored,
      pending,
      withDeps,
    };
  }

  /**
   * 获取并行可执行工具组（只读工具可并行）
   * 增强：只读工具合并为同一组实现真正并行
   */
  getParallelTools(toolIds: string[], modelName: string): { parallel: string[][]; serial: string[] } {
    const tools = this.getToolsForModel(modelName);
    const toolMap = new Map(tools.map(t => [t.id, t]));

    const readOnly: string[] = [];
    const write: string[] = [];

    for (const id of toolIds) {
      const tool = toolMap.get(id);
      if (tool?.readOnly) {
        readOnly.push(id);
      } else {
        write.push(id);
      }
    }

    return {
      // 只读工具合并为同一组，实现真正的并行执行
      parallel: readOnly.length > 0 ? [readOnly] : [],
      serial: write,
    };
  }
}

