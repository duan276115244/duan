/**
 * 智能模型路由器 — ModelRouter
 *
 * 灵感来源：Trae CN 的多模型路由机制
 * 核心能力：
 * 1. 基于任务类型、复杂度、成本约束智能选择最优模型
 * 2. 模型注册与管理（预注册主流模型）
 * 3. 成本估算（输入/输出 token 单价）
 * 4. 综合评分（质量 × 速度 × 成本加权）
 * 5. Agent Loop 工具 — 通过 getToolDefinitions() 注册为可用工具
 */

import { logger } from './structured-logger.js';
import { EventBus } from './event-bus.js';
import type { ToolDef } from './unified-tool-def.js';

// ============ 类型定义 ============

/** 模型能力标签 */
export type ModelCapability = 'code' | 'reasoning' | 'chat' | 'vision' | 'creative' | 'fast';

/** 模型定义 */
export interface ModelDefinition {
  /** 唯一标识 */
  id: string;
  /** 显示名称 */
  name: string;
  /** 提供商 */
  provider: string;
  /** 能力标签 */
  capabilities: ModelCapability[];
  /** 最大 token 数 */
  maxTokens: number;
  /** 每千输入 token 成本（USD） */
  inputCostPer1k: number;
  /** 每千输出 token 成本（USD） */
  outputCostPer1k: number;
  /** 平均延迟（毫秒） */
  avgLatencyMs: number;
  /** 质量评分 0-10 */
  qualityScore: number;
  /** 速度评分 0-10 */
  speedScore: number;
  /** 成本评分 0-10（10 = 最便宜） */
  costScore: number;
}

/** 模型选择需求约束 */
export interface ModelRequirements {
  /** 最低质量要求 0-10 */
  minQuality?: number;
  /** 最大延迟（毫秒） */
  maxLatencyMs?: number;
  /** 每千 token 最大成本（USD） */
  maxCostPer1k?: number;
  /** 必需的能力标签 */
  requiredCapability?: string;
}

/** 模型选择结果 */
export interface ModelSelection {
  /** 选中的模型ID */
  modelId: string;
  /** 选择理由 */
  reason: string;
  /** 质量评分 */
  qualityScore: number;
  /** 速度评分 */
  speedScore: number;
  /** 成本评分 */
  costScore: number;
  /** 综合评分 */
  compositeScore: number;
  /** 预估延迟（毫秒） */
  estimatedLatency: number;
  /** 预估成本（USD） */
  estimatedCost: number;
}

/** 模型画像（对外展示） */
export interface ModelProfile {
  id: string;
  name: string;
  provider: string;
  capabilities: ModelCapability[];
  maxTokens: number;
  qualityScore: number;
  speedScore: number;
  costScore: number;
  inputCostPer1k: number;
  outputCostPer1k: number;
  avgLatencyMs: number;
}


// ============ 预注册模型 ============

const PRE_REGISTERED_MODELS: ModelDefinition[] = [
  {
    id: 'gpt-4o',
    name: 'GPT-4o',
    provider: 'openai',
    capabilities: ['code', 'reasoning', 'chat', 'vision', 'creative'],
    maxTokens: 128000,
    inputCostPer1k: 0.0025,
    outputCostPer1k: 0.01,
    avgLatencyMs: 1800,
    qualityScore: 9,
    speedScore: 7,
    costScore: 4,
  },
  {
    id: 'gpt-4o-mini',
    name: 'GPT-4o Mini',
    provider: 'openai',
    capabilities: ['code', 'reasoning', 'chat', 'fast', 'vision'],
    maxTokens: 128000,
    inputCostPer1k: 0.00015,
    outputCostPer1k: 0.0006,
    avgLatencyMs: 600,
    qualityScore: 7,
    speedScore: 9,
    costScore: 9,
  },
  {
    id: 'claude-3.5-sonnet',
    name: 'Claude 3.5 Sonnet',
    provider: 'anthropic',
    capabilities: ['code', 'reasoning', 'chat', 'creative'],
    maxTokens: 200000,
    inputCostPer1k: 0.003,
    outputCostPer1k: 0.015,
    avgLatencyMs: 2000,
    qualityScore: 9.5,
    speedScore: 6,
    costScore: 3,
  },
  {
    id: 'claude-3-haiku',
    name: 'Claude 3 Haiku',
    provider: 'anthropic',
    capabilities: ['chat', 'fast', 'code'],
    maxTokens: 200000,
    inputCostPer1k: 0.00025,
    outputCostPer1k: 0.00125,
    avgLatencyMs: 400,
    qualityScore: 7,
    speedScore: 9,
    costScore: 8,
  },
  {
    id: 'deepseek-v3',
    name: 'DeepSeek V3',
    provider: 'deepseek',
    capabilities: ['code', 'reasoning', 'chat', 'fast'],
    maxTokens: 64000,
    inputCostPer1k: 0.00027,
    outputCostPer1k: 0.0011,
    avgLatencyMs: 1200,
    qualityScore: 8.5,
    speedScore: 7,
    costScore: 9,
  },
  {
    id: 'deepseek-r1',
    name: 'DeepSeek R1',
    provider: 'deepseek',
    capabilities: ['reasoning', 'code'],
    maxTokens: 64000,
    inputCostPer1k: 0.00055,
    outputCostPer1k: 0.00219,
    avgLatencyMs: 5000,
    qualityScore: 9,
    speedScore: 4,
    costScore: 7,
  },
  {
    id: 'gemini-pro',
    name: 'Gemini Pro',
    provider: 'google',
    capabilities: ['code', 'reasoning', 'chat', 'vision', 'creative'],
    maxTokens: 1000000,
    inputCostPer1k: 0.00125,
    outputCostPer1k: 0.005,
    avgLatencyMs: 1500,
    qualityScore: 8,
    speedScore: 7,
    costScore: 6,
  },
  {
    id: 'qwen-max',
    name: 'Qwen Max',
    provider: 'aliyun',
    capabilities: ['code', 'reasoning', 'chat', 'creative'],
    maxTokens: 32000,
    inputCostPer1k: 0.0008,
    outputCostPer1k: 0.002,
    avgLatencyMs: 1000,
    qualityScore: 8,
    speedScore: 8,
    costScore: 7,
  },
  {
    id: 'glm-5.2',
    name: 'GLM-5.2',
    provider: 'zhipu',
    capabilities: ['code', 'reasoning', 'chat'],
    maxTokens: 128000,
    inputCostPer1k: 0.001,
    outputCostPer1k: 0.002,
    avgLatencyMs: 1000,
    qualityScore: 9,
    speedScore: 8,
    costScore: 7,
  },
  {
    id: 'glm-5.1',
    name: 'GLM-5.1',
    provider: 'zhipu',
    capabilities: ['code', 'reasoning', 'chat'],
    maxTokens: 128000,
    inputCostPer1k: 0.001,
    outputCostPer1k: 0.002,
    avgLatencyMs: 1200,
    qualityScore: 8.5,
    speedScore: 7,
    costScore: 7,
  },
];

// ============ 任务类型 → 能力映射 ============

const TASK_TYPE_MAP: Record<string, ModelCapability[]> = {
  code: ['code'],
  coding: ['code'],
  编程: ['code'],
  代码: ['code'],
  reasoning: ['reasoning'],
  推理: ['reasoning'],
  分析: ['reasoning'],
  chat: ['chat'],
  对话: ['chat'],
  问答: ['chat'],
  vision: ['vision'],
  图像: ['vision'],
  视觉: ['vision'],
  creative: ['creative'],
  创意: ['creative'],
  写作: ['creative'],
  创作: ['creative'],
};

// ============ 主类 ============

export class ModelRouter {
  private log = logger.child({ module: 'ModelRouter' });
  private models: Map<string, ModelDefinition> = new Map();

  // 统计数据
  private stats = {
    selectCount: 0,
    registerCount: 0,
    costQueryCount: 0,
    profileQueryCount: 0,
    selectionHistory: [] as Array<{ modelId: string; task: string; timestamp: number }>,
  };

  // 评分权重
  private weights = {
    quality: 0.4,
    speed: 0.3,
    cost: 0.3,
  };

  constructor() {
    // 预注册模型
    for (const model of PRE_REGISTERED_MODELS) {
      this.models.set(model.id, { ...model });
      this.stats.registerCount++;
    }

    this.log.info('模型路由器已初始化', {
      preRegistered: this.models.size,
    });
  }

  // ========== 核心方法 ==========

  /**
   * 选择最优模型
   * 根据任务类型、复杂度和需求约束进行智能路由
   */
  selectModel(task: string, complexity: string, requirements?: ModelRequirements): ModelSelection {
    this.stats.selectCount++;
    const startTime = Date.now();

    // 1. 分析任务所需能力
    const requiredCapabilities = this.analyzeTaskCapabilities(task);

    // 2. 获取候选模型
    let candidates = Array.from(this.models.values());

    // 3. 按需求过滤
    candidates = this.filterByRequirements(candidates, requirements, requiredCapabilities);

    if (candidates.length === 0) {
      // 降级：放宽约束
      this.log.warn('无满足约束的模型，放宽约束重新选择', { task, complexity });
      candidates = Array.from(this.models.values());
      candidates = this.filterByRequirements(candidates, requirements, []);
    }

    if (candidates.length === 0) {
      throw new Error('没有可用的模型，请先注册模型');
    }

    // 4. 根据复杂度调整权重
    const adjustedWeights = this.adjustWeightsByComplexity(complexity);

    // 5. 计算综合评分
    const scored = candidates.map(model => {
      const compositeScore =
        model.qualityScore * adjustedWeights.quality +
        model.speedScore * adjustedWeights.speed +
        model.costScore * adjustedWeights.cost;

      const estimatedLatency = model.avgLatencyMs * this.getComplexityMultiplier(complexity);
      const estimatedCost = this.calculateEstimatedCost(model, complexity);

      return {
        model,
        compositeScore,
        estimatedLatency,
        estimatedCost,
      };
    });

    // 6. 排序选择最优
    scored.sort((a, b) => b.compositeScore - a.compositeScore);

    const best = scored[0];

    // 记录选择历史
    this.stats.selectionHistory.push({
      modelId: best.model.id,
      task: task.substring(0, 100),
      timestamp: Date.now(),
    });
    if (this.stats.selectionHistory.length > 100) {
      this.stats.selectionHistory = this.stats.selectionHistory.slice(-100);
    }

    const selection: ModelSelection = {
      modelId: best.model.id,
      reason: this.buildSelectionReason(best.model, task, complexity, requiredCapabilities, best.compositeScore),
      qualityScore: best.model.qualityScore,
      speedScore: best.model.speedScore,
      costScore: best.model.costScore,
      compositeScore: Math.round(best.compositeScore * 100) / 100,
      estimatedLatency: Math.round(best.estimatedLatency),
      estimatedCost: Math.round(best.estimatedCost * 10000) / 10000,
    };

    this.log.info('模型选择完成', {
      task: task.substring(0, 50),
      complexity,
      selected: best.model.id,
      compositeScore: selection.compositeScore,
      duration: Date.now() - startTime,
    });

    EventBus.getInstance().emitSync('model.selected', {
      modelId: best.model.id,
      task: task.substring(0, 100),
      complexity,
      compositeScore: selection.compositeScore,
    });

    return selection;
  }

  /**
   * 注册模型
   */
  registerModel(model: ModelDefinition): { success: boolean; message: string } {
    if (this.models.has(model.id)) {
      this.log.warn('模型已存在，将覆盖', { modelId: model.id });
    }

    this.models.set(model.id, { ...model });
    this.stats.registerCount++;

    this.log.info('模型已注册', {
      modelId: model.id,
      name: model.name,
      provider: model.provider,
      capabilities: model.capabilities,
    });

    EventBus.getInstance().emitSync('model.registered', {
      modelId: model.id,
      name: model.name,
    });

    return {
      success: true,
      message: `模型 ${model.name} (${model.id}) 注册成功`,
    };
  }

  /**
   * 获取模型画像
   */
  getModelProfile(modelId: string): ModelProfile | null {
    this.stats.profileQueryCount++;

    const model = this.models.get(modelId);
    if (!model) return null;

    return {
      id: model.id,
      name: model.name,
      provider: model.provider,
      capabilities: model.capabilities,
      maxTokens: model.maxTokens,
      qualityScore: model.qualityScore,
      speedScore: model.speedScore,
      costScore: model.costScore,
      inputCostPer1k: model.inputCostPer1k,
      outputCostPer1k: model.outputCostPer1k,
      avgLatencyMs: model.avgLatencyMs,
    };
  }

  /**
   * 估算 API 调用成本
   */
  estimateCost(modelId: string, inputTokens: number, outputTokens: number): {
    modelId: string;
    inputCost: number;
    outputCost: number;
    totalCost: number;
    currency: string;
  } {
    this.stats.costQueryCount++;

    const model = this.models.get(modelId);
    if (!model) {
      throw new Error(`模型 ${modelId} 未注册`);
    }

    const inputCost = (inputTokens / 1000) * model.inputCostPer1k;
    const outputCost = (outputTokens / 1000) * model.outputCostPer1k;
    const totalCost = inputCost + outputCost;

    return {
      modelId,
      inputCost: Math.round(inputCost * 10000) / 10000,
      outputCost: Math.round(outputCost * 10000) / 10000,
      totalCost: Math.round(totalCost * 10000) / 10000,
      currency: 'USD',
    };
  }

  /**
   * 获取统计数据
   */
  getStats(): Record<string, unknown> {
    return {
      registeredModels: this.models.size,
      selectCount: this.stats.selectCount,
      registerCount: this.stats.registerCount,
      costQueryCount: this.stats.costQueryCount,
      profileQueryCount: this.stats.profileQueryCount,
      recentSelections: this.stats.selectionHistory.slice(-10),
      availableModels: Array.from(this.models.keys()),
    };
  }

  // ========== Agent Loop 工具定义 ==========

  getToolDefinitions(): ToolDef[] {
    // eslint-disable-next-line @typescript-eslint/no-this-alias
    const self = this;

    return [
      {
        name: 'model_select',
        description: '根据任务类型、复杂度和约束条件智能选择最优AI模型。分析任务所需能力（代码/推理/对话/视觉/创意/快速），综合评估质量、速度、成本，返回最优模型选择及理由。',
        parameters: {
          task: {
            type: 'string',
            description: '任务描述，用于分析所需模型能力。如"编写TypeScript代码"、"分析复杂数据"、"快速问答"等',
            required: true,
          },
          complexity: {
            type: 'string',
            description: '任务复杂度: simple(简单快速任务) / medium(中等复杂任务) / complex(高复杂度任务)',
            required: true,
          },
          minQuality: {
            type: 'number',
            description: '最低质量要求(0-10)，不传则无约束',
            required: false,
          },
          maxLatencyMs: {
            type: 'number',
            description: '最大可接受延迟(毫秒)，不传则无约束',
            required: false,
          },
          maxCostPer1k: {
            type: 'number',
            description: '每千token最大成本(USD)，不传则无约束',
            required: false,
          },
          requiredCapability: {
            type: 'string',
            description: '必需的模型能力: code / reasoning / chat / vision / creative / fast',
            required: false,
          },
        },
        readOnly: true,
        execute: (args) => {
          try {
            const requirements: ModelRequirements = {};
            if (args.minQuality !== undefined) requirements.minQuality = Number(args.minQuality);
            if (args.maxLatencyMs !== undefined) requirements.maxLatencyMs = Number(args.maxLatencyMs);
            if (args.maxCostPer1k !== undefined) requirements.maxCostPer1k = Number(args.maxCostPer1k);
            if (args.requiredCapability) requirements.requiredCapability = args.requiredCapability as string;

            const selection = self.selectModel(
              args.task as string,
              args.complexity as string,
              Object.keys(requirements).length > 0 ? requirements : undefined,
            );
            return Promise.resolve(JSON.stringify(selection, null, 2));
          } catch (err: unknown) {
            return Promise.resolve(`❌ 模型选择失败: ${(err instanceof Error ? err.message : String(err))}`);
          }
        },
      },
      {
        name: 'model_list',
        description: '列出所有已注册的AI模型及其能力画像。返回每个模型的ID、名称、提供商、能力标签、质量/速度/成本评分、token限制和单价信息。',
        parameters: {
          capability: {
            type: 'string',
            description: '按能力筛选: code / reasoning / chat / vision / creative / fast。不传则列出全部',
            required: false,
          },
        },
        readOnly: true,
        execute: (args) => {
          try {
            let models = Array.from(self.models.values());

            if (args.capability) {
              const cap = args.capability as ModelCapability;
              models = models.filter(m => m.capabilities.includes(cap));
            }

            const profiles = models.map(m => ({
              id: m.id,
              name: m.name,
              provider: m.provider,
              capabilities: m.capabilities,
              maxTokens: m.maxTokens,
              qualityScore: m.qualityScore,
              speedScore: m.speedScore,
              costScore: m.costScore,
              inputCostPer1k: m.inputCostPer1k,
              outputCostPer1k: m.outputCostPer1k,
              avgLatencyMs: m.avgLatencyMs,
            }));

            return Promise.resolve(JSON.stringify(profiles, null, 2));
          } catch (err: unknown) {
            return Promise.resolve(`❌ 获取模型列表失败: ${(err instanceof Error ? err.message : String(err))}`);
          }
        },
      },
      {
        name: 'model_cost',
        description: '估算指定AI模型的API调用成本。根据输入/输出token数量和模型单价计算总费用（USD）。',
        parameters: {
          modelId: {
            type: 'string',
            description: '模型ID，如 gpt-4o / gpt-4o-mini / claude-3.5-sonnet / deepseek-v3 等',
            required: true,
          },
          inputTokens: {
            type: 'number',
            description: '输入token数量',
            required: true,
          },
          outputTokens: {
            type: 'number',
            description: '输出token数量',
            required: true,
          },
        },
        readOnly: true,
        execute: (args) => {
          try {
            const cost = self.estimateCost(
              args.modelId as string,
              Number(args.inputTokens),
              Number(args.outputTokens),
            );
            return Promise.resolve(JSON.stringify(cost, null, 2));
          } catch (err: unknown) {
            return Promise.resolve(`❌ 成本估算失败: ${(err instanceof Error ? err.message : String(err))}`);
          }
        },
      },
    ];
  }

  // ========== 私有方法 ==========

  /** 分析任务所需能力 */
  private analyzeTaskCapabilities(task: string): ModelCapability[] {
    const capabilities = new Set<ModelCapability>();
    const lowerTask = task.toLowerCase();

    for (const [keyword, caps] of Object.entries(TASK_TYPE_MAP)) {
      if (lowerTask.includes(keyword)) {
        for (const cap of caps) {
          capabilities.add(cap);
        }
      }
    }

    // 默认：对话 + 快速
    if (capabilities.size === 0) {
      capabilities.add('chat');
      capabilities.add('fast');
    }

    return Array.from(capabilities);
  }

  /** 按需求过滤模型 */
  private filterByRequirements(
    candidates: ModelDefinition[],
    requirements?: ModelRequirements,
    requiredCapabilities?: ModelCapability[],
  ): ModelDefinition[] {
    let filtered = candidates;

    // 按必需能力过滤
    if (requiredCapabilities && requiredCapabilities.length > 0) {
      filtered = filtered.filter(m =>
        requiredCapabilities.some(cap => m.capabilities.includes(cap)),
      );
    }

    if (!requirements) return filtered;

    // 按最低质量过滤
    if (requirements.minQuality !== undefined) {
      filtered = filtered.filter(m => m.qualityScore >= requirements.minQuality!);
    }

    // 按最大延迟过滤
    if (requirements.maxLatencyMs !== undefined) {
      filtered = filtered.filter(m => m.avgLatencyMs <= requirements.maxLatencyMs!);
    }

    // 按最大成本过滤（取输入和输出的较大值）
    if (requirements.maxCostPer1k !== undefined) {
      filtered = filtered.filter(m =>
        Math.max(m.inputCostPer1k, m.outputCostPer1k) <= requirements.maxCostPer1k!,
      );
    }

    // 按必需能力标签过滤
    if (requirements.requiredCapability) {
      filtered = filtered.filter(m =>
        m.capabilities.includes(requirements.requiredCapability as ModelCapability),
      );
    }

    return filtered;
  }

  /** 根据复杂度调整评分权重 */
  private adjustWeightsByComplexity(complexity: string): { quality: number; speed: number; cost: number } {
    switch (complexity.toLowerCase()) {
      case 'simple':
        // 简单任务：速度优先，成本其次
        return { quality: 0.2, speed: 0.5, cost: 0.3 };
      case 'complex':
        // 复杂任务：质量优先
        return { quality: 0.6, speed: 0.2, cost: 0.2 };
      case 'medium':
      default:
        // 中等任务：均衡
        return { quality: 0.4, speed: 0.3, cost: 0.3 };
    }
  }

  /** 获取复杂度对延迟的乘数 */
  private getComplexityMultiplier(complexity: string): number {
    switch (complexity.toLowerCase()) {
      case 'simple': return 0.6;
      case 'medium': return 1.0;
      case 'complex': return 1.8;
      default: return 1.0;
    }
  }

  /** 估算单次调用成本 */
  private calculateEstimatedCost(model: ModelDefinition, complexity: string): number {
    const tokenEstimate: Record<string, { input: number; output: number }> = {
      simple: { input: 500, output: 300 },
      medium: { input: 2000, output: 1000 },
      complex: { input: 5000, output: 3000 },
    };

    const estimate = tokenEstimate[complexity.toLowerCase()] || tokenEstimate.medium;
    return (estimate.input / 1000) * model.inputCostPer1k + (estimate.output / 1000) * model.outputCostPer1k;
  }

  /** 构建选择理由 */
  private buildSelectionReason(
    model: ModelDefinition,
    task: string,
    complexity: string,
    requiredCapabilities: ModelCapability[],
    compositeScore: number,
  ): string {
    const parts: string[] = [];

    parts.push(`模型: ${model.name} (${model.provider})`);
    parts.push(`任务复杂度: ${complexity}`);

    if (requiredCapabilities.length > 0) {
      const matchedCaps = requiredCapabilities.filter(c => model.capabilities.includes(c));
      parts.push(`能力匹配: [${matchedCaps.join(', ')}]`);
    }

    parts.push(`综合评分: ${compositeScore.toFixed(2)} (质量${model.qualityScore}/速度${model.speedScore}/成本${model.costScore})`);
    parts.push(`预估延迟: ${model.avgLatencyMs}ms`);

    return parts.join(' | ');
  }
}
