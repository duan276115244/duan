/**
 * 上下文管理器 — ContextManager
 *
 * 替代简单 FIFO 滑动窗口，使用重要性评分选择消息：
 * - 评分维度：角色权重 + 位置衰减 + 工具调用相关性 + 长度惩罚
 * - 在 token 预算内选择最重要的消息
 * - 保留系统消息和最近用户消息
 *
 * P0-4 增强：接入 SemanticRecaller 注意力机制，实现语义级召回
 * - 当提供 query 时，结合语义相关性评分（注意力分数）与启发式评分
 * - 语义相关的历史消息获得加分，即使位置较旧也会被保留
 * - 向后兼容：不提供 query 时行为与原来完全一致
 */

import { SemanticRecaller } from './attention-mechanism.js';
import type { EmbeddingProvider } from './embedding-provider.js';

// ============ 类型定义 ============

export interface ContextMessage {
  role: 'system' | 'user' | 'assistant' | 'tool';
  content: string;
  /** 工具调用名称（如果有） */
  toolName?: string;
  /** 工具调用是否成功 */
  toolSuccess?: boolean;
  /** 时间戳 */
  timestamp?: number;
}

export interface ContextManagerConfig {
  /** 最大 token 预算（用于上下文消息） */
  maxContextTokens: number;
  /** 始终保留的最近消息数 */
  minRecentMessages: number;
  /** 系统消息是否始终保留 */
  preserveSystemMessages: boolean;
  /** 位置衰减因子（0-1，越大衰减越慢） */
  positionDecayFactor: number;
  /** 语义召回权重（0-1，0=纯启发式，1=纯语义，默认 0.3） */
  semanticWeight?: number;
}

const DEFAULT_CONFIG: ContextManagerConfig = {
  maxContextTokens: 8000,
  minRecentMessages: 4,
  preserveSystemMessages: true,
  positionDecayFactor: 0.85,
  semanticWeight: 0.3,
};

// ============ 重要性评分 ============

/** 角色权重：系统 > 用户 > 助手 > 工具 */
const ROLE_WEIGHTS: Record<string, number> = {
  system: 1.0,
  user: 0.9,
  assistant: 0.6,
  tool: 0.4,
};

/** 工具调用重要性加权 */
const IMPORTANT_TOOLS = new Set([
  'write_file', 'edit_file', 'execute_shell', 'run_code',
  'desktop_click', 'desktop_type', 'wechat_send',
]);

const ERROR_PENALTY = -0.2;

function scoreMessage(
  msg: ContextMessage,
  index: number,
  total: number,
  config: ContextManagerConfig,
): number {
  let score = 0;

  // 1. 角色权重
  score += ROLE_WEIGHTS[msg.role] || 0.5;

  // 2. 位置衰减（越近越重要）
  const positionRatio = total > 1 ? index / (total - 1) : 1;
  score += positionRatio * config.positionDecayFactor;

  // 3. 工具调用相关性
  if (msg.toolName) {
    if (IMPORTANT_TOOLS.has(msg.toolName)) {
      score += 0.3;
    }
    // 失败的工具调用更重要（避免重复）
    if (msg.toolSuccess === false) {
      score += 0.2;
    }
  }

  // 4. 内容长度惩罚（过长消息降权，但不过度）
  const charLen = msg.content.length;
  if (charLen > 2000) {
    score -= 0.1;
  }

  // 5. 错误内容加权
  if (msg.content.includes('Error') || msg.content.includes('error') || msg.content.includes('失败')) {
    score += ERROR_PENALTY;  // 轻微降权，但保留
  }

  return score;
}

// ============ Token 估算 ============

function estimateTokens(text: string): number {
  // 粗略估算：中文约 1.5 字/token，英文约 4 字符/token
  // 混合内容取中间值
  return Math.ceil(text.length / 2.5);
}

// ============ ContextManager ============

export class ContextManager {
  private config: ContextManagerConfig;
  private semanticRecaller: SemanticRecaller | null = null;

  constructor(config?: Partial<ContextManagerConfig>) {
    this.config = { ...DEFAULT_CONFIG, ...config };
  }

  /**
   * 启用语义召回（注意力机制）
   * 调用后 selectMessages 可接受 query 参数，结合语义相关性评分
   */
  enableSemanticRecall(dim = 256): void {
    this.semanticRecaller = new SemanticRecaller(dim);
  }

  /**
   * P1-3: 注入真实语义嵌入提供者到 SemanticRecaller
   *
   * 注入后 selectMessages 的语义召回路径使用真实语义嵌入（OpenAI/TF-IDF），
   * 取代默认的哈希嵌入。要求已调用 enableSemanticRecall()。
   *
   * @returns true 表示注入成功，false 表示 SemanticRecaller 未启用
   */
  setEmbeddingProvider(provider: EmbeddingProvider | null): boolean {
    if (!this.semanticRecaller) {
      // 自动启用语义召回
      this.enableSemanticRecall(provider?.dimension ?? 256);
    }
    this.semanticRecaller!.setEmbeddingProvider(provider);
    return this.semanticRecaller !== null;
  }

  /** P1-3: 查询是否已注入真实语义嵌入提供者 */
  hasSemanticProvider(): boolean {
    return this.semanticRecaller?.hasSemanticProvider() ?? false;
  }

  /**
   * 在 token 预算内选择最重要的消息（同步路径）
   *
   * ⚠️ 性能 / 正确性提示：
   * 真实 EmbeddingProvider（OpenAI/远程模型）通常是【异步】的。
   * 本同步方法调用的 computeSemanticScores 只能走 SemanticRecaller 的同步
   * add/recall，若底层嵌入尚未就绪会拿到空或过期向量，导致语义召回静默失效
   * （退化为纯启发式评分，不报错）。
   *
   * 因此在使用异步 provider 时，请优先使用 {@link selectMessagesAsync}；
   * 若必须使用本同步路径，请在调用前通过 {@link warmSemanticCache} 预热嵌入缓存。
   *
   * 策略：
   * 1. 始终保留系统消息
   * 2. 始终保留最近 N 条消息
   * 3. 对中间消息评分，按重要性选择
   * 4. 当提供 query 且启用语义召回时，结合语义相关性评分
   *
   * @param messages 消息列表
   * @param query 可选的当前查询，用于语义召回加分
   */
  selectMessages(messages: ContextMessage[], query?: string): ContextMessage[] {
    return this.assembleSelection(
      messages,
      this.computeSemanticScores.bind(this),
      query,
    ) as ContextMessage[];
  }

  /**
   * 在 token 预算内选择最重要的消息（异步路径）
   *
   * 推荐在注入了异步 EmbeddingProvider 时使用，确保语义向量在评分前完成计算，
   * 避免同步路径下语义召回静默失效。
   *
   * @param messages 消息列表
   * @param query 可选的当前查询，用于语义召回加分
   */
  async selectMessagesAsync(messages: ContextMessage[], query?: string): Promise<ContextMessage[]> {
    return this.assembleSelection(
      messages,
      this.computeSemanticScoresAsync.bind(this),
      query,
    ) as Promise<ContextMessage[]>;
  }

  /**
   * 预热语义嵌入缓存（用于同步 selectMessages 路径）
   *
   * 在异步 provider 场景下，提前异步计算 query 与候选消息的嵌入，
   * 使后续同步 add/recall 命中缓存，避免拿到空/过期向量。
   *
   * @returns 是否执行了预热（语义召回未启用时返回 false）
   */
  async warmSemanticCache(messages: ContextMessage[], query?: string): Promise<boolean> {
    if (!query || !this.semanticRecaller || messages.length === 0) return false;
    const recaller = this.semanticRecaller as any;
    if (typeof recaller.warmup === 'function') {
      try {
        await recaller.warmup([...messages.map(m => m.content), query]);
        return true;
      } catch {
        return false;
      }
    }
    // 回退：若 SemanticRecaller 暴露 embedAsync，则逐条预热
    if (typeof recaller.embedAsync === 'function') {
      try {
        await Promise.all([...messages.map(m => recaller.embedAsync(m.content)), recaller.embedAsync(query)]);
        return true;
      } catch {
        return false;
      }
    }
    return false;
  }

  /**
   * 共享的选择装配逻辑，供同步 / 异步语义评分复用
   */
  private assembleSelection(
    messages: ContextMessage[],
    scoreFn: (msgs: ContextMessage[], query?: string) => number[] | Promise<number[]>,
    query?: string,
  ): ContextMessage[] | Promise<ContextMessage[]> {
    if (messages.length === 0) return [];

    const totalTokens = messages.reduce((sum, m) => sum + estimateTokens(m.content), 0);
    if (totalTokens <= this.config.maxContextTokens) {
      return messages;  // 未超预算，全部保留
    }

    const result: ContextMessage[] = [];
    let usedTokens = 0;
    const budget = this.config.maxContextTokens;

    // 1. 保留系统消息
    const systemMsgs: ContextMessage[] = [];
    const nonSystemMsgs: ContextMessage[] = [];

    for (const msg of messages) {
      if (msg.role === 'system' && this.config.preserveSystemMessages) {
        systemMsgs.push(msg);
        usedTokens += estimateTokens(msg.content);
      } else {
        nonSystemMsgs.push(msg);
      }
    }

    result.push(...systemMsgs);

    // 2. 保留最近 N 条消息
    const recentCount = Math.min(this.config.minRecentMessages, nonSystemMsgs.length);
    const recentMsgs = nonSystemMsgs.slice(-recentCount);
    const olderMsgs = nonSystemMsgs.slice(0, nonSystemMsgs.length - recentCount);

    for (const msg of recentMsgs) {
      usedTokens += estimateTokens(msg.content);
    }
    // 先不加入 result，等评分排序后统一组装

    // 3. 计算语义相关性分数（当提供 query 且启用语义召回时）
    const finalize = (semanticScores: number[]): ContextMessage[] => {
      // 4. 对较旧消息评分（启发式 + 语义融合）
      const semanticWeight = this.config.semanticWeight ?? 0.3;
      const scored = olderMsgs.map((msg, i) => {
        const heuristicScore = scoreMessage(msg, i, olderMsgs.length, this.config);
        const semanticScore = semanticScores[i] ?? 0;
        // 融合：启发式为主，语义为辅
        const blendedScore = heuristicScore * (1 - semanticWeight) + semanticScore * semanticWeight;
        return { msg, score: blendedScore };
      });
      scored.sort((a, b) => b.score - a.score);

      // 5. 按评分选择旧消息，直到预算用完
      const selectedOlder: ContextMessage[] = [];
      for (const { msg } of scored) {
        const tokens = estimateTokens(msg.content);
        if (usedTokens + tokens <= budget) {
          selectedOlder.push(msg);
          usedTokens += tokens;
        }
      }

      // 6. 按原始顺序组装（保持对话连贯性）
      const olderSet = new Set(selectedOlder);
      const orderedOlder = olderMsgs.filter(m => olderSet.has(m));

      result.push(...orderedOlder, ...recentMsgs);
      return result;
    };

    const scores = scoreFn(olderMsgs, query);
    if (scores instanceof Promise) {
      return scores.then(finalize);
    }
    return finalize(scores);
  }

  /**
   * 计算语义相关性分数（同步）
   * 使用 SemanticRecaller 的注意力机制对 olderMsgs 评分
   * 返回归一化到 [0, 1] 的分数数组
   *
   * 注意：异步 provider 下需先调用 warmSemanticCache 预热，否则可能拿到空/过期向量。
   */
  private computeSemanticScores(msgs: ContextMessage[], query?: string): number[] {
    // 无 query 或未启用语义召回时，返回全 0（不影响启发式评分）
    if (!query || !this.semanticRecaller || msgs.length === 0) {
      return new Array(msgs.length).fill(0);
    }

    try {
      // 将 olderMsgs 加入召回库
      this.semanticRecaller.clear();
      msgs.forEach((msg, i) => {
        this.semanticRecaller!.add(`msg_${i}`, msg.content, { index: i });
      });

      // 语义召回，获取注意力分数
      const recalled = this.semanticRecaller.recall(query, msgs.length);

      return this.normalizeRecallScores(msgs, recalled);
    } catch {
      // 语义计算失败时降级为纯启发式
      return new Array(msgs.length).fill(0);
    }
  }

  /**
   * 计算语义相关性分数（异步）
   * 等待嵌入完成后再召回，避免同步路径下拿到空/过期向量导致语义召回静默失效。
   */
  private async computeSemanticScoresAsync(msgs: ContextMessage[], query?: string): Promise<number[]> {
    if (!query || !this.semanticRecaller || msgs.length === 0) {
      return new Array(msgs.length).fill(0);
    }

    try {
      const recaller = this.semanticRecaller as any;
      recaller.clear();

      // 异步加入（若 SemanticRecaller 提供 addAsync 则等待嵌入计算完成）
      for (let i = 0; i < msgs.length; i++) {
        if (typeof recaller.addAsync === 'function') {
          await recaller.addAsync(`msg_${i}`, msgs[i].content, { index: i });
        } else {
          recaller.add(`msg_${i}`, msgs[i].content, { index: i });
        }
      }

      // 异步召回（若提供 recallAsync 则等待 query 嵌入计算完成）
      const recalled = typeof recaller.recallAsync === 'function'
        ? await recaller.recallAsync(query, msgs.length)
        : recaller.recall(query, msgs.length);

      return this.normalizeRecallScores(msgs, recalled);
    } catch {
      // 语义计算失败时降级为纯启发式
      return new Array(msgs.length).fill(0);
    }
  }

  /**
   * 将召回结果归一化到 [0, 1] 的分数数组（同步 / 异步路径共用）
   */
  private normalizeRecallScores(
    msgs: ContextMessage[],
    recalled: Array<{ score: number; metadata?: { index?: number } }>,
  ): number[] {
    const scoreMap = new Map<number, number>();
    let maxScore = 0;
    for (const r of recalled) {
      const idx = r.metadata?.index ?? 0;
      scoreMap.set(idx, r.score);
      if (r.score > maxScore) maxScore = r.score;
    }

    return msgs.map((_, i) => {
      const raw = scoreMap.get(i) ?? 0;
      return maxScore > 0 ? raw / maxScore : 0;
    });
  }

  /**
   * 压缩消息内容（截断过长消息）
   */
  compressMessages(messages: ContextMessage[], maxCharsPerMessage: number = 1500): ContextMessage[] {
    return messages.map(msg => {
      if (msg.content.length <= maxCharsPerMessage) return msg;
      // 保留头部和尾部
      const headLen = Math.floor(maxCharsPerMessage * 0.6);
      const tailLen = Math.floor(maxCharsPerMessage * 0.3);
      const compressed =
        msg.content.substring(0, headLen) +
        '\n...[已压缩]...\n' +
        msg.content.substring(msg.content.length - tailLen);
      return { ...msg, content: compressed };
    });
  }

  /**
   * 估算消息列表的 token 数
   */
  estimateTotalTokens(messages: ContextMessage[]): number {
    return messages.reduce((sum, m) => sum + estimateTokens(m.content), 0);
  }

  /**
   * 获取配置
   */
  getConfig(): ContextManagerConfig {
    return { ...this.config };
  }

  /**
   * 更新配置
   */
  updateConfig(partial: Partial<ContextManagerConfig>): void {
    Object.assign(this.config, partial);
  }
}

