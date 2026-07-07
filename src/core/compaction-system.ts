/**
 * 5 层上下文压缩系统 — Claude Code 风格的长会话上下文管理
 *
 * Layer 1: Full Context — 完整对话历史（无限制）
 * Layer 2: Summarized — LLM 生成的旧轮次摘要
 * Layer 3: Key Facts — 提取的事实、决策和行动项
 * Layer 4: Semantic Index — 向量嵌入用于相似性检索
 * Layer 5: Persistent Memory — 持久化到文件的长期知识
 *
 * 当 token 数量超过阈值时触发压缩
 * 每层有自己的压缩比和保留策略
 */

import { logger } from './structured-logger.js';
import { EventBus, Events } from './event-bus.js';
import { CircuitBreaker } from './circuit-breaker.js';
import * as fs from 'fs/promises';
import * as path from 'path';
import { randomUUID } from 'crypto';
import { atomicWriteJson } from './atomic-write.js';

// ============ 导出接口 ============

/** 压缩消息 */
export interface CompactionMessage {
  id: string;
  role: 'system' | 'user' | 'assistant' | 'tool';
  content: string;
  timestamp: number;
  /** 消息重要性 (1-10) */
  importance?: number;
  /** 关联的工具调用 ID */
  toolCallId?: string;
  /** 工具调用列表 */
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  toolCalls?: any[];
  /** 消息元数据 */
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  metadata?: Record<string, any>;
}

/** 压缩结果 */
export interface CompactionResult {
  /** 压缩后的消息列表 */
  messages: CompactionMessage[];
  /** 使用的 token 预算 */
  tokensUsed: number;
  /** 总 token 预算 */
  tokenBudget: number;
  /** 压缩比 */
  compressionRatio: number;
  /** 各层贡献 */
  layerContributions: Record<string, number>;
}

/** 压缩统计 */
export interface CompactionStats {
  /** Layer 1 消息数 */
  layer1MessageCount: number;
  /** Layer 1 token 数 */
  layer1TokenCount: number;
  /** Layer 2 摘要数 */
  layer2SummaryCount: number;
  /** Layer 2 token 数 */
  layer2TokenCount: number;
  /** Layer 3 事实数 */
  layer3FactCount: number;
  /** Layer 4 索引条目数 */
  layer4IndexSize: number;
  /** Layer 5 持久化条目数 */
  layer5PersistentCount: number;
  /** 总 token 估算 */
  totalTokens: number;
  /** 压缩触发次数 */
  compactionCount: number;
  /** 上次压缩时间 */
  lastCompactionAt: number | null;
  /** 平均压缩比 */
  averageCompressionRatio: number;
}

/** 压缩搜索结果 */
export interface CompactionSearchResult {
  /** 匹配内容 */
  content: string;
  /** 来源层 */
  layer: number;
  /** 相关性分数 (0-1) */
  relevance: number;
  /** 来源消息 ID */
  sourceId?: string;
  /** 时间戳 */
  timestamp?: number;
}

/** 压缩层描述 */
export interface CompactionLayer {
  /** 层编号 (1-5) */
  number: number;
  /** 层名称 */
  name: string;
  /** 层描述 */
  description: string;
  /** 压缩比（相对上一层） */
  compressionRatio: number;
  /** 保留策略 */
  retentionPolicy: 'unlimited' | 'sliding_window' | 'importance_based' | 'time_based' | 'persistent';
  /** 最大条目数 */
  maxEntries: number;
}

/** 压缩配置 */
export interface CompactionConfig {
  /** 触发压缩的 token 阈值 */
  compactionThreshold: number;
  /** 每层保留的最大 token 数 */
  layerTokenBudgets: Record<number, number>;
  /** 摘要窗口大小（消息数） */
  summaryWindowSize: number;
  /** 事实提取最小重要性 */
  factImportanceThreshold: number;
  /** 持久化存储目录 */
  persistentDir?: string;
  /** 是否自动压缩 */
  autoCompact: boolean;
  /** 上下文窗口总大小（tokens），用于三级阈值计算 */
  contextWindowSize?: number;
}

// ============ 三级阈值 + 熔断器（P0-1：对标 Claude Code） ============

/** 三级阈值级别 */
export type ThresholdLevel = 'normal' | 'warn' | 'block';

/** 三级阈值评估结果 */
export interface ThresholdStatus {
  /** 当前级别 */
  level: ThresholdLevel;
  /** 上下文使用率 (0-1) */
  usage: number;
  /** 使用的 tokens */
  tokensUsed: number;
  /** 总窗口大小 */
  windowSize: number;
  /** 触发的阈值百分比 */
  triggeredThreshold?: number;
  /** 建议动作 */
  recommendedAction: 'continue' | 'compact' | 'warn_user' | 'block';
}

/** 熔断器状态 */
export interface CircuitBreakerStatus {
  /** 是否开启（熔断中） */
  isOpen: boolean;
  /** 连续失败次数 */
  consecutiveFailures: number;
  /** 最大允许连续失败次数 */
  maxFailures: number;
  /** 上次失败时间 */
  lastFailureAt: number | null;
  /** 上次成功时间 */
  lastSuccessAt: number | null;
  /** 熔断恢复时间（毫秒） */
  resetTimeoutMs: number;
}

/** 三级阈值配置（对标 Claude Code） */
export const THREE_LEVEL_THRESHOLDS = {
  /** 70% 使用率 → 自动触发 Compaction */
  COMPACT_THRESHOLD: 0.70,
  /** 90% 使用率 → 向用户显示警告 */
  WARN_THRESHOLD: 0.90,
  /** 98% 使用率 → 阻止新请求 */
  BLOCK_THRESHOLD: 0.98,
} as const;

/** 熔断器配置（对标 Claude Code MAX_CONSECUTIVE_AUTOCOMPACT_FAILURES=3） */
export const CIRCUIT_BREAKER_CONFIG = {
  /** 连续失败 3 次停止重试强制上报 */
  MAX_CONSECUTIVE_FAILURES: 3,
  /** 熔断恢复时间 5 分钟 */
  RESET_TIMEOUT_MS: 5 * 60 * 1000,
} as const;

// ============ 内部类型 ============

interface Layer2Summary {
  id: string;
  /** 摘要覆盖的消息 ID 范围 */
  messageIds: string[];
  /** 摘要内容 */
  content: string;
  /** token 估算 */
  tokenCount: number;
  /** 创建时间 */
  createdAt: number;
}

interface Layer3Fact {
  id: string;
  /** 事实内容 */
  content: string;
  /** 事实类型 */
  type: 'fact' | 'decision' | 'action_item' | 'preference';
  /** 重要性 */
  importance: number;
  /** 来源消息 ID */
  sourceMessageId: string;
  /** 创建时间 */
  createdAt: number;
}

interface Layer4Entry {
  id: string;
  /** 原始内容 */
  content: string;
  /** 简化向量（基于关键词的伪向量） */
  vector: number[];
  /** 来源层 */
  sourceLayer: number;
  /** 来源 ID */
  sourceId: string;
  /** 时间戳 */
  timestamp: number;
}

interface Layer5Entry {
  id: string;
  /** 持久化知识 */
  content: string;
  /** 知识类型 */
  type: 'long_term' | 'preference' | 'pattern' | 'skill';
  /** 创建时间 */
  createdAt: number;
  /** 更新时间 */
  updatedAt: number;
}

// ============ Token 估算 ============

function estimateTokens(text: string): number {
  let chineseChars = 0;
  let otherChars = 0;
  for (const char of text) {
    if (/[\u4e00-\u9fff\u3400-\u4dbf]/.test(char)) chineseChars++;
    else otherChars++;
  }
  return Math.ceil(chineseChars / 1.5 + otherChars / 4);
}

function estimateMessageTokens(msg: CompactionMessage): number {
  let total = 4; // 角色/格式开销
  total += estimateTokens(msg.content);
  if (msg.toolCalls) total += estimateTokens(JSON.stringify(msg.toolCalls));
  return total;
}

// ============ 简易向量编码 ============

/** 基于关键词的简易向量编码（无需外部嵌入模型） */
function simpleVectorize(text: string): number[] {
  const dim = 64;
  const vector = new Array(dim).fill(0);

  // 基于字符 n-gram 的哈希向量
  const normalized = text.toLowerCase().replace(/[^\w\u4e00-\u9fff]/g, ' ');
  const words = normalized.split(/\s+/).filter(Boolean);

  for (const word of words) {
    for (let i = 0; i < word.length; i++) {
      const charCode = word.charCodeAt(i);
      const idx = charCode % dim;
      vector[idx] += 1;
      // 二元组
      if (i < word.length - 1) {
        const biIdx = (charCode * 31 + word.charCodeAt(i + 1)) % dim;
        vector[biIdx] += 0.5;
      }
    }
  }

  // 归一化
  const magnitude = Math.sqrt(vector.reduce((s, v) => s + v * v, 0));
  if (magnitude > 0) {
    for (let i = 0; i < dim; i++) vector[i] /= magnitude;
  }

  return vector;
}

/** 余弦相似度 */
function cosineSimilarity(a: number[], b: number[]): number {
  let dot = 0;
  let normA = 0;
  let normB = 0;
  for (let i = 0; i < a.length; i++) {
    dot += a[i] * b[i];
    normA += a[i] * a[i];
    normB += b[i] * b[i];
  }
  const denom = Math.sqrt(normA) * Math.sqrt(normB);
  return denom > 0 ? dot / denom : 0;
}

// ============ 5 层压缩系统 ============

const DEFAULT_CONFIG: CompactionConfig = {
  compactionThreshold: 8000,
  layerTokenBudgets: {
    1: 4000, // Layer 1: 保留最近消息
    2: 2000, // Layer 2: 摘要
    3: 1000, // Layer 3: 关键事实
    4: 500,  // Layer 4: 语义索引
    5: 500,  // Layer 5: 持久化记忆
  },
  summaryWindowSize: 6,
  factImportanceThreshold: 6,
  autoCompact: true,
  // P0-1: 上下文窗口大小，用于三级阈值计算（默认 128K）
  contextWindowSize: 128000,
};

const LAYER_DEFINITIONS: CompactionLayer[] = [
  { number: 1, name: 'Full Context', description: '完整对话历史', compressionRatio: 1.0, retentionPolicy: 'sliding_window', maxEntries: 100 },
  { number: 2, name: 'Summarized', description: 'LLM 生成的旧轮次摘要', compressionRatio: 0.3, retentionPolicy: 'importance_based', maxEntries: 50 },
  { number: 3, name: 'Key Facts', description: '提取的事实、决策和行动项', compressionRatio: 0.1, retentionPolicy: 'importance_based', maxEntries: 200 },
  { number: 4, name: 'Semantic Index', description: '向量嵌入用于相似性检索', compressionRatio: 0.05, retentionPolicy: 'time_based', maxEntries: 500 },
  { number: 5, name: 'Persistent Memory', description: '持久化到文件的长期知识', compressionRatio: 0.02, retentionPolicy: 'persistent', maxEntries: 1000 },
];

export class CompactionSystem {
  // Layer 1: 完整对话历史
  private layer1Messages: CompactionMessage[] = [];
  // Layer 2: 摘要
  private layer2Summaries: Layer2Summary[] = [];
  // Layer 3: 关键事实
  private layer3Facts: Layer3Fact[] = [];
  // Layer 4: 语义索引
  private layer4Index: Layer4Entry[] = [];
  // Layer 5: 持久化记忆
  private layer5Entries: Layer5Entry[] = [];

  private config: CompactionConfig;
  private eventBus: EventBus;
  private compactionCount = 0;
  private totalCompressionRatios = 0;
  private lastCompactionAt: number | null = null;
  private disposed = false;

  // P0-1: 熔断器状态（对标 Claude Code MAX_CONSECUTIVE_AUTOCOMPACT_FAILURES=3）
  // 已统一到 CircuitBreaker 统一实现，实例级隔离
  private breaker: CircuitBreaker;
  private lastCompactionSuccessAt: number | null = null;

  // P0-1 深度优化: LLM 摘要器钩子 — 允许外部注入 LLM 调用实现语义压缩
  private llmSummarizer: ((messages: CompactionMessage[]) => Promise<string>) | null = null;

  // P0-3 真实语义嵌入: 注入 EmbeddingProvider 后 L4 Semantic Index 使用真实语义向量
  // 未注入时降级到 simpleVectorize（字符 n-gram 哈希）
  private embeddingProvider: ((text: string) => number[]) | null = null;

  // P0-1 深度优化: 摘要链 — 支持层级化摘要（摘要的摘要）
  private summaryChainDepth = 0;
  private readonly MAX_SUMMARY_CHAIN_DEPTH = 3;

  constructor(config?: Partial<CompactionConfig>) {
    this.config = { ...DEFAULT_CONFIG, ...config };
    this.eventBus = EventBus.getInstance();
    this.breaker = new CircuitBreaker('compactionSystem', {
      failureThreshold: CIRCUIT_BREAKER_CONFIG.MAX_CONSECUTIVE_FAILURES,
      timeoutMs: CIRCUIT_BREAKER_CONFIG.RESET_TIMEOUT_MS,
      successThreshold: 1,
      halfOpenMaxRequests: 1,
    });
  }

  /**
   * P0-1 深度优化: 注入 LLM 摘要器 — 启用语义压缩（对标 Claude Code LLM-based summarization）
   *
   * 注入后，Layer 2 摘要将使用 LLM 生成语义摘要，而非简单截断。
   * 摘要链支持层级化：当 Layer 2 摘要数超过 maxEntries/2 时，触发摘要合并。
   */
  setLLMSummarizer(summarizer: (messages: CompactionMessage[]) => Promise<string>): void {
    this.llmSummarizer = summarizer;
    logger.info('[Compaction] LLM 摘要器已注入 — 语义压缩已启用', { module: 'CompactionSystem' });
  }

  /**
   * P0-3: 注入真实语义嵌入 Provider — 替换默认的 simpleVectorize（字符 n-gram 哈希）
   *
   * 注入后，L4 Semantic Index 和所有向量相似度计算将使用真实语义嵌入。
   * 对标 Claude Code 的 semantic index + RAG 向量检索。
   *
   * Provider 签名为同步函数（避免破坏现有同步调用链）。
   * 异步嵌入 API（如 OpenAI embeddings）应在调用方做缓存 + 同步包装。
   *
   * @param provider 同步嵌入函数：text → number[]（维度需与 cosineSimilarity 兼容）
   */
  setEmbeddingProvider(provider: (text: string) => number[]): void {
    this.embeddingProvider = provider;
    logger.info('[Compaction] EmbeddingProvider 已注入 — L4 语义索引升级为真实嵌入', { module: 'CompactionSystem' });
  }

  /**
   * P0-3: 统一向量化入口 — 优先用 embeddingProvider，降级到 simpleVectorize
   */
  private vectorize(text: string): number[] {
    if (this.embeddingProvider) {
      try {
        return this.embeddingProvider(text);
      } catch (e) {
        logger.debug('[Compaction] embeddingProvider 调用失败，降级到 simpleVectorize', {
          error: e instanceof Error ? e.message : String(e).slice(0, 80),
        });
      }
    }
    return simpleVectorize(text);
  }

  /** 添加消息到 Layer 1 */
  addMessage(message: CompactionMessage): void {
    if (this.disposed) throw new Error('CompactionSystem 已释放');

    if (!message.id) message.id = randomUUID();
    if (!message.timestamp) message.timestamp = Date.now();

    // 设置默认重要性
    if (message.importance === undefined) {
      message.importance = this.scoreImportance(message);
    }

    this.layer1Messages.push(message);

    // 同时添加到 Layer 4 语义索引
    this.addToLayer4(message.content, 1, message.id, message.timestamp);

    // P0-1: 三级阈值检查（对标 Claude Code）
    if (this.config.autoCompact) {
      const status = this.getThresholdStatus();
      if (status.level === 'block') {
        // 98% 阻止新请求 — 抛出错误让上层处理
        logger.error('[Compaction] 上下文使用率达 98%，阻止新请求', {
          usage: `${(status.usage * 100).toFixed(1)}%`,
          tokensUsed: status.tokensUsed,
          windowSize: status.windowSize,
        });
        throw new Error(`上下文已满（${(status.usage * 100).toFixed(1)}%），请先压缩或清理会话`);
      }
      if (status.level === 'warn') {
        // 90% 向用户显示警告（不阻止，但记录）
        logger.warn('[Compaction] 上下文使用率达 90%，建议压缩', {
          usage: `${(status.usage * 100).toFixed(1)}%`,
        });
      }
      if (status.recommendedAction === 'compact') {
        // 70% 自动触发 Compaction
        this.forceCompaction().catch((err) => {
          logger.warn('[Compaction] 自动压缩失败', { error: (err as Error).message });
        });
      }
    }
  }

  /**
   * P0-1: 获取三级阈值状态（对标 Claude Code）
   *
   * - 70% 使用率 → 自动触发 Compaction
   * - 90% 使用率 → 向用户显示警告
   * - 98% 使用率 → 阻止新请求
   */
  getThresholdStatus(): ThresholdStatus {
    const windowSize = this.config.contextWindowSize || 128000;
    const tokensUsed = this.estimateTotalTokens();
    const usage = tokensUsed / windowSize;

    let level: ThresholdLevel = 'normal';
    let recommendedAction: ThresholdStatus['recommendedAction'] = 'continue';
    let triggeredThreshold: number | undefined;

    if (usage >= THREE_LEVEL_THRESHOLDS.BLOCK_THRESHOLD) {
      level = 'block';
      recommendedAction = 'block';
      triggeredThreshold = THREE_LEVEL_THRESHOLDS.BLOCK_THRESHOLD;
    } else if (usage >= THREE_LEVEL_THRESHOLDS.WARN_THRESHOLD) {
      level = 'warn';
      recommendedAction = 'warn_user';
      triggeredThreshold = THREE_LEVEL_THRESHOLDS.WARN_THRESHOLD;
    } else if (usage >= THREE_LEVEL_THRESHOLDS.COMPACT_THRESHOLD) {
      level = 'warn';
      recommendedAction = 'compact';
      triggeredThreshold = THREE_LEVEL_THRESHOLDS.COMPACT_THRESHOLD;
    }

    return {
      level,
      usage,
      tokensUsed,
      windowSize,
      triggeredThreshold,
      recommendedAction,
    };
  }

  /** 获取熔断器实例（使用 CircuitBreaker 统一实现，实例级隔离） */
  private getBreaker() {
    return this.breaker;
  }

  /**
   * P0-1: 获取熔断器状态（对标 Claude Code MAX_CONSECUTIVE_AUTOCOMPACT_FAILURES=3）
   *
   * 连续 Compaction 失败 3 次后熔断，5 分钟后自动恢复
   */
  getCircuitBreakerStatus(): CircuitBreakerStatus {
    const breaker = this.getBreaker();
    // 主动触发 open→half_open 转换，复刻原实现的超时检查语义
    breaker.tryTransition();
    const stats = breaker.getStats();
    return {
      isOpen: breaker.getState() === 'open',
      consecutiveFailures: stats.failureCount,
      maxFailures: CIRCUIT_BREAKER_CONFIG.MAX_CONSECUTIVE_FAILURES,
      lastFailureAt: stats.lastFailureTime,
      lastSuccessAt: this.lastCompactionSuccessAt,
      resetTimeoutMs: CIRCUIT_BREAKER_CONFIG.RESET_TIMEOUT_MS,
    };
  }

  /** P0-1: 估算总 tokens（所有层） */
  private estimateTotalTokens(): number {
    const layer1 = this.estimateLayer1Tokens();
    const layer2 = this.layer2Summaries.reduce((s, sum) => s + sum.tokenCount, 0);
    const layer3 = this.layer3Facts.reduce((s, f) => s + estimateTokens(f.content), 0);
    const layer4 = this.layer4Index.reduce((s, e) => s + estimateTokens(e.content), 0);
    const layer5 = this.layer5Entries.reduce((s, e) => s + estimateTokens(e.content), 0);
    return layer1 + layer2 + layer3 + layer4 + layer5;
  }

  /** 获取压缩后的上下文（在 token 预算内） */
  getContext(tokenBudget: number, query?: string): Promise<CompactionResult> {
    if (this.disposed) return Promise.reject(new Error('CompactionSystem 已释放'));

    const layerContributions: Record<string, number> = { layer1: 0, layer2: 0, layer3: 0, layer4: 0, layer5: 0 };
    let tokensUsed = 0;
    const result: CompactionMessage[] = [];

    // 1. Layer 5: 持久化记忆（最高优先级，始终包含）
    const layer5Budget = this.config.layerTokenBudgets[5] || 500;
    const layer5Messages = this.getLayer5Context(layer5Budget, query);
    for (const msg of layer5Messages) {
      const t = estimateMessageTokens(msg);
      if (tokensUsed + t <= tokenBudget) {
        result.push(msg);
        tokensUsed += t;
        layerContributions.layer5 += t;
      }
    }

    // 2. Layer 3: 关键事实
    const layer3Budget = this.config.layerTokenBudgets[3] || 1000;
    const layer3Messages = this.getLayer3Context(layer3Budget, query);
    for (const msg of layer3Messages) {
      const t = estimateMessageTokens(msg);
      if (tokensUsed + t <= tokenBudget) {
        result.push(msg);
        tokensUsed += t;
        layerContributions.layer3 += t;
      }
    }

    // 3. Layer 2: 摘要
    const layer2Budget = this.config.layerTokenBudgets[2] || 2000;
    const layer2Messages = this.getLayer2Context(layer2Budget, query);
    for (const msg of layer2Messages) {
      const t = estimateMessageTokens(msg);
      if (tokensUsed + t <= tokenBudget) {
        result.push(msg);
        tokensUsed += t;
        layerContributions.layer2 += t;
      }
    }

    // 4. Layer 4: 语义检索（如果有查询）
    if (query) {
      const layer4Budget = this.config.layerTokenBudgets[4] || 500;
      const layer4Messages = this.getLayer4Context(layer4Budget, query);
      for (const msg of layer4Messages) {
        const t = estimateMessageTokens(msg);
        if (tokensUsed + t <= tokenBudget) {
          result.push(msg);
          tokensUsed += t;
          layerContributions.layer4 += t;
        }
      }
    }

    // 5. Layer 1: 最近消息（填充剩余预算）
    const remainingBudget = tokenBudget - tokensUsed;
    const layer1Messages = this.getLayer1Context(remainingBudget);
    for (const msg of layer1Messages) {
      const t = estimateMessageTokens(msg);
      if (tokensUsed + t <= tokenBudget) {
        result.push(msg);
        tokensUsed += t;
        layerContributions.layer1 += t;
      }
    }

    const totalOriginalTokens = this.estimateLayer1Tokens();
    const compressionRatio = totalOriginalTokens > 0 ? tokensUsed / totalOriginalTokens : 1;

    return Promise.resolve({
      messages: result,
      tokensUsed,
      tokenBudget,
      compressionRatio,
      layerContributions,
    });
  }

  /** 手动触发压缩 */
  async forceCompaction(): Promise<CompactionStats> {
    if (this.disposed) throw new Error('CompactionSystem 已释放');

    // P0-1: 熔断器检查（对标 Claude Code MAX_CONSECUTIVE_AUTOCOMPACT_FAILURES=3）
    const breakerStatus = this.getCircuitBreakerStatus();
    if (breakerStatus.isOpen) {
      logger.error('[Compaction] 熔断器开启中，拒绝压缩请求', {
        consecutiveFailures: breakerStatus.consecutiveFailures,
        lastFailureAt: breakerStatus.lastFailureAt,
      });
      throw new Error(
        `Compaction 熔断器开启中（连续失败 ${breakerStatus.consecutiveFailures} 次），` +
        `请 ${Math.ceil(breakerStatus.resetTimeoutMs / 60000)} 分钟后重试`,
      );
    }

    logger.info('[Compaction] 开始压缩', {
      layer1Messages: this.layer1Messages.length,
      layer1Tokens: this.estimateLayer1Tokens(),
    });

    await this.eventBus.emit(Events.COMPACTION_STARTED, {
      messageCount: this.layer1Messages.length,
      tokenCount: this.estimateLayer1Tokens(),
    }, { source: 'compaction-system' });

    const beforeTokens = this.estimateLayer1Tokens();

    try {
      // P0-1 深度优化: 重置摘要链深度 — 每次压缩周期重新开始
      this.summaryChainDepth = 0;

      // Step 1: 将旧消息摘要到 Layer 2（P0-1 深度优化: 支持 LLM 语义压缩 + 摘要链）
      await this.compactToLayer2();

      // Step 2: 从 Layer 2 提取关键事实到 Layer 3
      this.extractFactsToLayer3();

      // Step 3: 将高重要性事实持久化到 Layer 5
      await this.persistToLayer5();

      // Step 4: 裁剪 Layer 1（保留最近消息）
      this.pruneLayer1();

      this.compactionCount++;
      this.lastCompactionAt = Date.now();

      // P0-1: 压缩成功 — 记录熔断器成功
      this.lastCompactionSuccessAt = Date.now();
      this.getBreaker().recordSuccess();

      const afterTokens = this.estimateLayer1Tokens();
      const ratio = beforeTokens > 0 ? afterTokens / beforeTokens : 1;
      this.totalCompressionRatios += ratio;

      const stats = this.getStats();

      await this.eventBus.emit(Events.COMPACTION_COMPLETE, {
        beforeTokens,
        afterTokens,
        compressionRatio: ratio,
      }, { source: 'compaction-system' });

      logger.info('[Compaction] 压缩完成', {
        beforeTokens,
        afterTokens,
        compressionRatio: ratio.toFixed(2),
      });

      return stats;
    } catch (err: unknown) {
      // P0-1: 压缩失败 — 记录熔断器失败
      const breaker = this.getBreaker();
      breaker.recordFailure();
      const stats = breaker.getStats();
      const msg = err instanceof Error ? err.message : String(err);

      if (breaker.getState() === 'open') {
        logger.error('[Compaction] 熔断器触发（连续失败达上限）', {
          consecutiveFailures: stats.failureCount,
          maxFailures: CIRCUIT_BREAKER_CONFIG.MAX_CONSECUTIVE_FAILURES,
          lastError: msg,
        });
      } else {
        logger.warn('[Compaction] 压缩失败', {
          error: msg,
          consecutiveFailures: stats.failureCount,
          remaining: CIRCUIT_BREAKER_CONFIG.MAX_CONSECUTIVE_FAILURES - stats.failureCount,
        });
      }

      throw err;
    }
  }

  /** 获取各层统计信息 */
  getStats(): CompactionStats {
    return {
      layer1MessageCount: this.layer1Messages.length,
      layer1TokenCount: this.estimateLayer1Tokens(),
      layer2SummaryCount: this.layer2Summaries.length,
      layer2TokenCount: this.layer2Summaries.reduce((s, sum) => s + sum.tokenCount, 0),
      layer3FactCount: this.layer3Facts.length,
      layer4IndexSize: this.layer4Index.length,
      layer5PersistentCount: this.layer5Entries.length,
      totalTokens:
        this.estimateLayer1Tokens() +
        this.layer2Summaries.reduce((s, sum) => s + sum.tokenCount, 0) +
        this.layer3Facts.reduce((s, f) => s + estimateTokens(f.content), 0),
      compactionCount: this.compactionCount,
      lastCompactionAt: this.lastCompactionAt,
      averageCompressionRatio: this.compactionCount > 0
        ? this.totalCompressionRatios / this.compactionCount
        : 1,
    };
  }

  /** 跨层搜索 */
  search(query: string, limit: number = 10): Promise<CompactionSearchResult[]> {
    if (this.disposed) return Promise.reject(new Error('CompactionSystem 已释放'));

    const results: CompactionSearchResult[] = [];
    const queryVector = this.vectorize(query);
    const queryLower = query.toLowerCase();

    // 搜索 Layer 1
    for (const msg of this.layer1Messages) {
      const score = this.computeRelevance(msg.content, queryLower, queryVector, msg.importance);
      if (score > 0.1) {
        results.push({
          content: msg.content,
          layer: 1,
          relevance: score,
          sourceId: msg.id,
          timestamp: msg.timestamp,
        });
      }
    }

    // 搜索 Layer 2
    for (const summary of this.layer2Summaries) {
      const score = this.computeRelevance(summary.content, queryLower, queryVector);
      if (score > 0.1) {
        results.push({
          content: summary.content,
          layer: 2,
          relevance: score,
          sourceId: summary.id,
          timestamp: summary.createdAt,
        });
      }
    }

    // 搜索 Layer 3
    for (const fact of this.layer3Facts) {
      const score = this.computeRelevance(fact.content, queryLower, queryVector, fact.importance);
      if (score > 0.1) {
        results.push({
          content: fact.content,
          layer: 3,
          relevance: score,
          sourceId: fact.id,
          timestamp: fact.createdAt,
        });
      }
    }

    // 搜索 Layer 4（向量相似性）
    for (const entry of this.layer4Index) {
      const similarity = cosineSimilarity(queryVector, entry.vector);
      if (similarity > 0.3) {
        results.push({
          content: entry.content,
          layer: 4,
          relevance: similarity,
          sourceId: entry.sourceId,
          timestamp: entry.timestamp,
        });
      }
    }

    // 搜索 Layer 5
    for (const entry of this.layer5Entries) {
      const score = this.computeRelevance(entry.content, queryLower, queryVector);
      if (score > 0.1) {
        results.push({
          content: entry.content,
          layer: 5,
          relevance: score,
          sourceId: entry.id,
          timestamp: entry.updatedAt,
        });
      }
    }

    // 按相关性排序并返回 top N
    results.sort((a, b) => b.relevance - a.relevance);
    return Promise.resolve(results.slice(0, limit));
  }

  /** 导出指定层为 JSON */
  exportLayer(layer: number): Promise<string> {
    let data: unknown;
    switch (layer) {
      case 1: data = this.layer1Messages; break;
      case 2: data = this.layer2Summaries; break;
      case 3: data = this.layer3Facts; break;
      case 4: data = this.layer4Index; break;
      case 5: data = this.layer5Entries; break;
      default: throw new Error(`无效的层编号: ${layer}，有效范围 1-5`);
    }
    return Promise.resolve(JSON.stringify({ layer, exportedAt: Date.now(), data }, null, 2));
  }

  /** 从 JSON 导入指定层 */
  importLayer(layer: number, data: string): Promise<void> {
    if (this.disposed) return Promise.reject(new Error('CompactionSystem 已释放'));

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    let parsed: any;
    try {
      parsed = JSON.parse(data);
    } catch {
      return Promise.reject(new Error('无效的 JSON 数据'));
    }

    if (parsed.layer !== layer) {
      return Promise.reject(new Error(`数据层编号 ${parsed.layer} 与目标层 ${layer} 不匹配`));
    }

    switch (layer) {
      case 1: this.layer1Messages = parsed.data || []; break;
      case 2: this.layer2Summaries = parsed.data || []; break;
      case 3: this.layer3Facts = parsed.data || []; break;
      case 4: this.layer4Index = parsed.data || []; break;
      case 5: this.layer5Entries = parsed.data || []; break;
      default: return Promise.reject(new Error(`无效的层编号: ${layer}`));
    }

    logger.info(`[Compaction] 已导入 Layer ${layer}`, { entryCount: (parsed.data || []).length });
    return Promise.resolve();
  }

  /** 释放资源 */
  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    this.layer1Messages = [];
    this.layer2Summaries = [];
    this.layer3Facts = [];
    this.layer4Index = [];
    this.layer5Entries = [];
    logger.info('[Compaction] CompactionSystem 已释放');
  }

  // ============ 私有方法 ============

  private estimateLayer1Tokens(): number {
    return this.layer1Messages.reduce((s, m) => s + estimateMessageTokens(m), 0);
  }

  /**
   * P0-1 深度优化: 智能重要性评分算法（对标 Claude Code importance scoring）
   *
   * 评分维度（1-10 分）：
   * 1. 角色权重：system(10) > assistant(6) > user(5) > tool(3)
   * 2. 内容长度：长内容含更多信息（+0-2 分）
   * 3. 工具调用：含工具调用的消息更重要（+2 分）
   * 4. 关键词信号：决策/错误/重要/警告等关键词加分（+0-3 分）
   * 5. 代码内容：含代码块的消息加分（+1 分）
   * 6. 时间衰减：越旧的消息重要性略降（-0-1 分）
   */
  private scoreImportance(message: CompactionMessage): number {
    let score = 5; // 基础分

    // 维度 1: 角色权重
    switch (message.role) {
      case 'system': score = 10; break;
      case 'assistant': score = 6; break;
      case 'user': score = 5; break;
      case 'tool': score = 3; break;
    }

    // 维度 2: 内容长度（100 字符 +0.5，500 字符 +1，1000+ 字符 +2，上限 +2）
    const len = message.content.length;
    if (len > 1000) score += 2;
    else if (len > 500) score += 1.5;
    else if (len > 100) score += 0.5;

    // 维度 3: 工具调用
    if (message.toolCalls && message.toolCalls.length > 0) {
      score += 2;
    }

    // 维度 4: 关键词信号
    const lowerContent = message.content.toLowerCase();
    const highPriorityKeywords = ['error', '错误', 'fail', '失败', 'critical', '严重', 'important', '重要', 'decision', '决定', 'must', '必须', 'warning', '警告'];
    const mediumPriorityKeywords = ['bug', 'fix', '修复', 'change', '修改', 'update', '更新', 'create', '创建', 'delete', '删除', 'config', '配置'];
    let keywordBonus = 0;
    for (const kw of highPriorityKeywords) {
      if (lowerContent.includes(kw)) { keywordBonus += 1; break; }
    }
    for (const kw of mediumPriorityKeywords) {
      if (lowerContent.includes(kw)) { keywordBonus += 0.5; break; }
    }
    score += Math.min(keywordBonus, 3);

    // 维度 5: 代码内容
    if (message.content.includes('```') || message.content.includes('function') || message.content.includes('class ')) {
      score += 1;
    }

    // 维度 6: 时间衰减（超过 10 分钟的消息轻微衰减）
    if (message.timestamp) {
      const ageMs = Date.now() - message.timestamp;
      if (ageMs > 10 * 60 * 1000) score -= 0.5;
      if (ageMs > 30 * 60 * 1000) score -= 0.5;
    }

    return Math.max(1, Math.min(10, Math.round(score)));
  }

  /** Layer 1 → Layer 2: 将旧消息压缩为摘要 */
  private async compactToLayer2(): Promise<void> {
    const windowSize = this.config.summaryWindowSize;
    if (this.layer1Messages.length <= windowSize) return;

    // 保留最近的窗口大小消息，其余压缩
    const toSummarize = this.layer1Messages.slice(0, -windowSize);
    if (toSummarize.length === 0) return;

    // 按窗口分组生成摘要
    for (let i = 0; i < toSummarize.length; i += windowSize) {
      const window = toSummarize.slice(i, i + windowSize);
      let summaryContent: string;

      // P0-1 深度优化: 优先使用 LLM 摘要器（语义压缩）
      if (this.llmSummarizer) {
        try {
          summaryContent = await this.llmSummarizer(window);
        } catch (err) {
          logger.warn('[Compaction] LLM 摘要失败，降级为规则摘要', { error: (err as Error).message });
          summaryContent = this.generateSummary(window);
        }
      } else {
        summaryContent = this.generateSummary(window);
      }

      const summary: Layer2Summary = {
        id: randomUUID(),
        messageIds: window.map(m => m.id),
        content: summaryContent,
        tokenCount: estimateTokens(summaryContent),
        createdAt: Date.now(),
      };
      this.layer2Summaries.push(summary);

      // 同时添加到 Layer 4 语义索引
      this.addToLayer4(summaryContent, 2, summary.id, summary.createdAt);
    }

    // P0-1 深度优化: 摘要链 — 当 Layer 2 摘要过多时，合并旧摘要（层级化）
    if (this.summaryChainDepth < this.MAX_SUMMARY_CHAIN_DEPTH &&
        this.layer2Summaries.length > LAYER_DEFINITIONS[1].maxEntries / 2) {
      await this.compactSummaryChain();
    }

    // 限制 Layer 2 大小
    const maxLayer2 = LAYER_DEFINITIONS[1].maxEntries;
    if (this.layer2Summaries.length > maxLayer2) {
      this.layer2Summaries = this.layer2Summaries.slice(-maxLayer2);
    }
  }

  /**
   * P0-1 深度优化: 摘要链压缩 — 将多个旧摘要合并为更高层级的摘要
   *
   * 对标 Claude Code 的 hierarchical summarization：
   * - Level 0: 原始消息摘要
   * - Level 1: 摘要的摘要（每 3 个旧摘要合并为 1 个）
   * - Level 2: 更高层级合并
   * - Level 3: 最高层级（整个会话的精炼摘要）
   */
  private async compactSummaryChain(): Promise<void> {
    this.summaryChainDepth++;
    const mergeCount = 3; // 每 3 个旧摘要合并为 1 个
    const oldSummaries = this.layer2Summaries.slice(0, -mergeCount); // 保留最近的
    if (oldSummaries.length < mergeCount) return;

    const merged: Layer2Summary[] = [];
    for (let i = 0; i < oldSummaries.length; i += mergeCount) {
      const group = oldSummaries.slice(i, i + mergeCount);
      const combinedContent = group.map(s => s.content).join('\n---\n');

      let mergedContent: string;
      if (this.llmSummarizer) {
        try {
          // 将摘要转换为 CompactionMessage 格式供 LLM 处理
          const pseudoMessages: CompactionMessage[] = group.map(s => ({
            id: s.id,
            role: 'assistant' as const,
            content: s.content,
            timestamp: s.createdAt,
            importance: 7,
          }));
          mergedContent = await this.llmSummarizer(pseudoMessages);
        } catch {
          mergedContent = `[层级${this.summaryChainDepth}摘要] ${combinedContent.substring(0, 300)}...`;
        }
      } else {
        mergedContent = `[层级${this.summaryChainDepth}摘要] 合并 ${group.length} 个摘要: ${combinedContent.substring(0, 300)}...`;
      }

      merged.push({
        id: randomUUID(),
        messageIds: group.flatMap(g => g.messageIds),
        content: mergedContent,
        tokenCount: estimateTokens(mergedContent),
        createdAt: Date.now(),
      });
    }

    // 替换旧摘要为合并后的摘要
    this.layer2Summaries = [...merged, ...this.layer2Summaries.slice(-mergeCount)];
    logger.info('[Compaction] 摘要链压缩完成', {
      depth: this.summaryChainDepth,
      before: oldSummaries.length + mergeCount,
      after: this.layer2Summaries.length,
    });
  }

  /** 生成消息窗口的摘要 */
  private generateSummary(messages: CompactionMessage[]): string {
    // 基于规则的摘要生成（无需 LLM 调用）
    const parts: string[] = [];

    for (const msg of messages) {
      const content = msg.content.length > 200
        ? msg.content.substring(0, 200) + '...'
        : msg.content;

      switch (msg.role) {
        case 'user':
          parts.push(`用户: ${content}`);
          break;
        case 'assistant':
          parts.push(`助手: ${content}`);
          break;
        case 'tool':
          parts.push(`工具结果: ${content}`);
          break;
        case 'system':
          parts.push(`系统: ${content}`);
          break;
      }
    }

    return `[摘要] 以下为 ${messages.length} 条历史对话的压缩:\n${parts.join('\n')}`;
  }

  /** Layer 2 → Layer 3: 从摘要中提取关键事实 */
  private extractFactsToLayer3(): void {
    const threshold = this.config.factImportanceThreshold;

    // 从 Layer 1 高重要性消息中提取
    for (const msg of this.layer1Messages) {
      if ((msg.importance ?? 0) >= threshold) {
        // 避免重复
        const exists = this.layer3Facts.some(f => f.sourceMessageId === msg.id);
        if (!exists) {
          const factType = this.inferFactType(msg);
          const fact: Layer3Fact = {
            id: randomUUID(),
            content: this.extractFactContent(msg),
            type: factType,
            importance: msg.importance ?? threshold,
            sourceMessageId: msg.id,
            createdAt: msg.timestamp,
          };
          this.layer3Facts.push(fact);
        }
      }
    }

    // 从 Layer 2 摘要中提取关键决策
    for (const summary of this.layer2Summaries) {
      const decisions = this.extractDecisionsFromSummary(summary.content);
      for (const decision of decisions) {
        const exists = this.layer3Facts.some(f => f.content === decision && f.sourceMessageId === summary.id);
        if (!exists) {
          const fact: Layer3Fact = {
            id: randomUUID(),
            content: decision,
            type: 'decision',
            importance: threshold,
            sourceMessageId: summary.id,
            createdAt: summary.createdAt,
          };
          this.layer3Facts.push(fact);
        }
      }
    }

    // 限制 Layer 3 大小
    const maxLayer3 = LAYER_DEFINITIONS[2].maxEntries;
    if (this.layer3Facts.length > maxLayer3) {
      // 按重要性排序，保留最重要的
      this.layer3Facts.sort((a, b) => b.importance - a.importance);
      this.layer3Facts = this.layer3Facts.slice(0, maxLayer3);
    }
  }

  /** 推断事实类型 */
  private inferFactType(msg: CompactionMessage): Layer3Fact['type'] {
    const content = msg.content.toLowerCase();
    if (content.includes('决定') || content.includes('decide') || content.includes('选择')) return 'decision';
    if (content.includes('待办') || content.includes('todo') || content.includes('需要') || content.includes('action')) return 'action_item';
    if (content.includes('偏好') || content.includes('prefer') || content.includes('喜欢')) return 'preference';
    return 'fact';
  }

  /** 提取事实内容 */
  private extractFactContent(msg: CompactionMessage): string {
    // 提取关键句子（简化版：取前 200 字符）
    const content = msg.content;
    if (content.length <= 200) return content;

    // 尝试按句子分割，取前几个关键句
    const sentences = content.split(/[。！？.!?\n]/).filter(s => s.trim().length > 0);
    if (sentences.length <= 2) return content.substring(0, 200);

    return sentences.slice(0, 3).join('。') + '。';
  }

  /** 从摘要中提取决策 */
  private extractDecisionsFromSummary(summary: string): string[] {
    const decisions: string[] = [];
    const lines = summary.split('\n');

    for (const line of lines) {
      const trimmed = line.trim();
      if (
        trimmed.includes('决定') ||
        trimmed.includes('选择') ||
        trimmed.includes('确认') ||
        trimmed.includes('decide') ||
        trimmed.includes('confirmed')
      ) {
        if (trimmed.length <= 300) {
          decisions.push(trimmed);
        }
      }
    }

    return decisions;
  }

  /** Layer 3 → Layer 5: 持久化高重要性事实 */
  private async persistToLayer5(): Promise<void> {
    const highImportanceFacts = this.layer3Facts.filter(f => f.importance >= 8);

    for (const fact of highImportanceFacts) {
      const exists = this.layer5Entries.some(e => e.content === fact.content);
      if (!exists) {
        const entry: Layer5Entry = {
          id: randomUUID(),
          content: fact.content,
          type: fact.type === 'preference' ? 'preference' : 'long_term',
          createdAt: fact.createdAt,
          updatedAt: Date.now(),
        };
        this.layer5Entries.push(entry);
      }
    }

    // 持久化到文件
    if (this.config.persistentDir) {
      try {
        const dir = this.config.persistentDir;
        await fs.mkdir(dir, { recursive: true });
        const filePath = path.join(dir, 'layer5-persistent.json');
        await atomicWriteJson(filePath, this.layer5Entries);
      } catch (err: unknown) {
        const msg = err instanceof Error ? err.message : String(err);
        logger.warn('[Compaction] 持久化 Layer 5 失败', { error: msg });
      }
    }

    // 限制 Layer 5 大小
    const maxLayer5 = LAYER_DEFINITIONS[4].maxEntries;
    if (this.layer5Entries.length > maxLayer5) {
      this.layer5Entries = this.layer5Entries.slice(-maxLayer5);
    }
  }

  /** 裁剪 Layer 1 */
  private pruneLayer1(): void {
    const budget = this.config.layerTokenBudgets[1] || 4000;
    let currentTokens = this.estimateLayer1Tokens();

    if (currentTokens <= budget) return;

    // 保留系统消息 + 最近的非系统消息
    const systemMessages = this.layer1Messages.filter(m => m.role === 'system');
    const nonSystemMessages = this.layer1Messages.filter(m => m.role !== 'system');

    // 从最旧的非系统消息开始移除
    while (currentTokens > budget && nonSystemMessages.length > 2) {
      const removed = nonSystemMessages.shift()!;
      currentTokens -= estimateMessageTokens(removed);
    }

    this.layer1Messages = [...systemMessages, ...nonSystemMessages];
  }

  /** 添加到 Layer 4 语义索引 */
  private addToLayer4(content: string, sourceLayer: number, sourceId: string, timestamp: number): void {
    if (!content.trim()) return;

    const entry: Layer4Entry = {
      id: randomUUID(),
      content: content.length > 500 ? content.substring(0, 500) : content,
      vector: this.vectorize(content),
      sourceLayer,
      sourceId,
      timestamp,
    };
    this.layer4Index.push(entry);

    // 限制 Layer 4 大小
    const maxLayer4 = LAYER_DEFINITIONS[3].maxEntries;
    if (this.layer4Index.length > maxLayer4) {
      this.layer4Index = this.layer4Index.slice(-maxLayer4);
    }
  }

  /** 获取 Layer 1 上下文 */
  private getLayer1Context(budget: number): CompactionMessage[] {
    const result: CompactionMessage[] = [];
    let tokens = 0;

    // 从最新消息开始，向前填充
    for (let i = this.layer1Messages.length - 1; i >= 0; i--) {
      const msg = this.layer1Messages[i];
      const t = estimateMessageTokens(msg);
      if (tokens + t > budget) break;
      result.unshift(msg);
      tokens += t;
    }

    return result;
  }

  /** 获取 Layer 2 上下文 */
  private getLayer2Context(budget: number, query?: string): CompactionMessage[] {
    const result: CompactionMessage[] = [];
    let tokens = 0;

    const summaries = query
      ? this.rankByRelevance(this.layer2Summaries, query)
      : [...this.layer2Summaries];

    for (const summary of summaries) {
      if (tokens + summary.tokenCount > budget) break;
      result.push({
        id: summary.id,
        role: 'assistant',
        content: summary.content,
        timestamp: summary.createdAt,
        importance: 7,
      });
      tokens += summary.tokenCount;
    }

    return result;
  }

  /** 获取 Layer 3 上下文 */
  private getLayer3Context(budget: number, query?: string): CompactionMessage[] {
    const result: CompactionMessage[] = [];
    let tokens = 0;

    const facts = query
      ? this.layer3Facts.sort((a, b) => {
          const scoreA = this.computeRelevance(a.content, query.toLowerCase(), this.vectorize(query), a.importance);
          const scoreB = this.computeRelevance(b.content, query.toLowerCase(), this.vectorize(query), b.importance);
          return scoreB - scoreA;
        })
      : [...this.layer3Facts].sort((a, b) => b.importance - a.importance);

    for (const fact of facts) {
      const t = estimateTokens(fact.content) + 4;
      if (tokens + t > budget) break;
      result.push({
        id: fact.id,
        role: 'system',
        content: `[${fact.type}] ${fact.content}`,
        timestamp: fact.createdAt,
        importance: fact.importance,
      });
      tokens += t;
    }

    return result;
  }

  /** 获取 Layer 4 上下文（基于语义检索） */
  private getLayer4Context(budget: number, query: string): CompactionMessage[] {
    const queryVector = this.vectorize(query);
    const scored = this.layer4Index
      .map(entry => ({ entry, score: cosineSimilarity(queryVector, entry.vector) }))
      .filter(s => s.score > 0.3)
      .sort((a, b) => b.score - a.score);

    const result: CompactionMessage[] = [];
    let tokens = 0;

    for (const { entry, score } of scored) {
      const t = estimateTokens(entry.content) + 4;
      if (tokens + t > budget) break;
      result.push({
        id: entry.sourceId,
        role: 'system',
        content: `[相关记忆] ${entry.content}`,
        timestamp: entry.timestamp,
        importance: Math.round(score * 10),
      });
      tokens += t;
    }

    return result;
  }

  /** 获取 Layer 5 上下文 */
  private getLayer5Context(budget: number, query?: string): CompactionMessage[] {
    const result: CompactionMessage[] = [];
    let tokens = 0;

    const entries = query
      ? this.layer5Entries.sort((a, b) => {
          const scoreA = this.computeRelevance(a.content, query.toLowerCase(), this.vectorize(query));
          const scoreB = this.computeRelevance(b.content, query.toLowerCase(), this.vectorize(query));
          return scoreB - scoreA;
        })
      : [...this.layer5Entries];

    for (const entry of entries) {
      const t = estimateTokens(entry.content) + 4;
      if (tokens + t > budget) break;
      result.push({
        id: entry.id,
        role: 'system',
        content: `[长期记忆] ${entry.content}`,
        timestamp: entry.updatedAt,
        importance: 9,
      });
      tokens += t;
    }

    return result;
  }

  /** 计算文本与查询的相关性 */
  private computeRelevance(
    content: string,
    queryLower: string,
    queryVector: number[],
    importance?: number,
  ): number {
    // 关键词匹配分数
    const contentLower = content.toLowerCase();
    const queryWords = queryLower.split(/\s+/).filter(Boolean);
    let keywordScore = 0;
    for (const word of queryWords) {
      if (contentLower.includes(word)) keywordScore += 1;
    }
    keywordScore = queryWords.length > 0 ? keywordScore / queryWords.length : 0;

    // 向量相似度分数
    const contentVector = this.vectorize(content);
    const vectorScore = cosineSimilarity(queryVector, contentVector);

    // 重要性加成
    const importanceBoost = (importance ?? 5) / 10;

    // 综合评分
    return keywordScore * 0.4 + vectorScore * 0.4 + importanceBoost * 0.2;
  }

  /** 按相关性排序摘要 */
  private rankByRelevance(summaries: Layer2Summary[], query: string): Layer2Summary[] {
    const queryLower = query.toLowerCase();
    const queryVector = this.vectorize(query);

    return [...summaries].sort((a, b) => {
      const scoreA = this.computeRelevance(a.content, queryLower, queryVector);
      const scoreB = this.computeRelevance(b.content, queryLower, queryVector);
      return scoreB - scoreA;
    });
  }
}
