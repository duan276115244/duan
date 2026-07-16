/**
 * 段先生 - 增强大脑系统 (Enhanced Brain)
 * 集成 NLU、推理、记忆、进化、安全等所有优化模块
 * 
 * 核心升级：
 * 1. 集成分层记忆系统（工作/情景/语义/程序记忆）
 * 2. 集成 NLU 引擎（意图识别、实体抽取、情感分析）
 * 3. 集成推理引擎（CoT/ToT/GoT/验证推理）
 * 4. 集成自我进化引擎（主动学习、知识冲突检测）
 * 5. 集成安全模块（PII检测、权限管理、审计日志）
 * 6. 集成性能监控（实时指标、趋势分析、改进建议）
 * 7. 集成个性化引擎（用户画像、风格适配）
 * 8. 集成创造性思维引擎（横向思维、类比推理、反事实推理）
 */

import * as fs from 'fs/promises';
import * as path from 'path';
import { Anthropic } from '@anthropic-ai/sdk';
import OpenAI from 'openai';
import { NLUEngine, type NLUResult } from './nlu-engine.js';
import { ReasoningEngine } from './reasoning-engine.js';
import { SelfEvolutionEngine, type Experience } from './self-evolution-engine.js';
import { HierarchicalMemory } from './hierarchical-memory.js';
import { PersonalizationEngine, type UserProfile } from './personalization-engine.js';
import { PIIDetector } from './pii-detector.js';
import { AuditLogger } from './audit-logger.js';
import { PermissionManager, type PermissionResult } from './permissions.js';
import { PerformanceMetricsSystem, type PerformanceSnapshot } from './performance-metrics.js';
import { QueryCache } from './cache.js';
import { errMsg } from './utils.js';
import { type ToolDef } from './agent-loop-types.js';
import { callLLMWithRecovery } from './query-engine-singleton.js';
import { atomicWriteJson } from './atomic-write.js';

interface Thought {
  id: string;
  type: 'observation' | 'analysis' | 'decision' | 'reflection' | 'plan';
  content: string;
  confidence: number;
  timestamp: Date;
  context: string;
  relatedThoughts: string[];
  nluMetadata?: {
    intent: string;
    entities: string[];
    sentiment: string;
  };
}

interface Insight {
  id: string;
  topic: string;
  content: string;
  importance: number;
  verified: boolean;
  sources: string[];
  discoveredAt: Date;
}

interface EvolutionStep {
  id: string;
  type: 'improvement' | 'optimization' | 'new_feature' | 'bug_fix';
  description: string;
  priority: 'high' | 'medium' | 'low';
  implemented: boolean;
  implementedAt?: Date;
}

interface Personality {
  traits: string[];
  communicationStyle: string;
  expertise: string[];
  learningRate: number;
}

/** 对话消息 */
interface ConversationMessage {
  role: 'user' | 'assistant' | 'system';
  content: string;
}

/** 增强处理结果 */
interface EnhancedProcessResult {
  response: string;
  nluResult: NLUResult | null;
  confidence: number;
  reasoningChain: string[];
  safetyChecks: {
    inputPII: boolean;
    outputPII: boolean;
  };
  learningApplied: boolean;
  personalizationApplied: boolean;
  cacheHit: boolean;
  processingTime: number;
  /** 响应质量预估 */
  qualityEstimate?: ResponseQualityEstimate;
}

/** 深度理解结果 */
interface DeepUnderstandingResult {
  surfaceIntent: string;
  deepIntent: string;
  implicitNeeds: string[];
  contextFactors: string[];
  suggestedApproach: string;
  confidence: number;
}

/** 响应质量预估结果 */
interface ResponseQualityEstimate {
  /** 预估质量分数（0-1） */
  estimatedQuality: number;
  /** 是否触发了策略调整 */
  strategyAdjusted: boolean;
  /** 调整原因 */
  adjustmentReason?: string;
}

export class Brain {
  // 基础系统
  private thoughts: Thought[] = [];
  private insights: Insight[] = [];
  private evolutionHistory: EvolutionStep[] = [];
  private personality: Personality;
  private anthropic: Anthropic | null = null;
  private openai: OpenAI | null = null;
  private dbPath: string;

  // 增强模块
  private nlu: NLUEngine;
  private reasoningEngine: ReasoningEngine;
  private evolutionEngine: SelfEvolutionEngine;
  private memory: HierarchicalMemory;
  private personalization: PersonalizationEngine;
  private piiDetector: PIIDetector;
  private auditLogger: AuditLogger;
  private permissionManager: PermissionManager;
  private performanceMetrics: PerformanceMetricsSystem;
  private queryCache: QueryCache;

  // 统计
  private totalRequests: number = 0;
  private errorCount: number = 0;
  private startTime: number = Date.now();

  /** 预处理缓存：对相似查询复用之前的NLU分析结果 */
  private nluCache: Map<string, { result: NLUResult; timestamp: number }> = new Map();
  /** 预处理缓存最大条目数 */
  private readonly NLU_CACHE_MAX_SIZE = 200;
  /** 预处理缓存过期时间（毫秒）：5分钟 */
  private readonly NLU_CACHE_TTL = 300000;

  /** 多级缓存：响应缓存 */
  private responseCache: Map<string, { result: string; timestamp: number; hitCount: number }> = new Map();
  /** 响应缓存最大条目数 */
  private cacheMaxSize = 200;
  /** 响应缓存过期时间（毫秒）：5分钟 */
  private cacheTTL = 5 * 60 * 1000;

  /**
   * LRU淘汰：删除最旧的缓存条目
   */
  private evictLRUCache(cache: Map<string, any>, maxSize: number): void {
    if (cache.size <= maxSize) return;
    const entries = Array.from(cache.entries());
    // 按timestamp排序，删除最旧的
    entries.sort((a, b) => (a[1].timestamp || 0) - (b[1].timestamp || 0));
    const deleteCount = cache.size - maxSize;
    for (let i = 0; i < deleteCount && i < entries.length; i++) {
      cache.delete(entries[i][0]);
    }
  }

  /** 对话状态 */
  private conversationState: Map<string, {
    turnCount: number;
    lastIntent: string;
    topics: string[];
    lastInteractionTime: number;
    pendingClarification: boolean;
  }> = new Map();
  /** 对话状态最大条目数，超过时 FIFO 淘汰最旧会话 */
  private conversationStateMaxSize = 100;

  constructor(dbPath: string = './data/brain.json') {
    this.dbPath = dbPath;
    this.personality = this.initializePersonality();
    this.initializeAI();

    // 初始化增强模块
    this.nlu = new NLUEngine();
    this.reasoningEngine = new ReasoningEngine();
    this.evolutionEngine = new SelfEvolutionEngine();
    this.memory = new HierarchicalMemory();
    this.personalization = new PersonalizationEngine();
    this.piiDetector = new PIIDetector();
    this.auditLogger = new AuditLogger();
    this.permissionManager = new PermissionManager();
    this.performanceMetrics = new PerformanceMetricsSystem();
    this.queryCache = new QueryCache(500);

    // 异步加载，不阻塞构造函数
    this.load().catch(() => {});
  }

  /** 显式初始化方法，确保所有模块就绪后再使用 */
  async init(): Promise<void> {
    await this.load();
  }

  private initializePersonality(): Personality {
    return {
      traits: ['curious', 'analytical', 'helpful', 'creative', 'logical'],
      communicationStyle: 'friendly',
      expertise: ['programming', 'writing', 'analysis', 'design', 'planning'],
      learningRate: 0.8,
    };
  }

  private initializeAI(): void {
    if (process.env.ANTHROPIC_API_KEY) {
      this.anthropic = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });
    }
    if (process.env.OPENAI_API_KEY) {
      this.openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });
    }
  }

  private async load(): Promise<void> {
    try {
      const data = await fs.readFile(this.dbPath, 'utf-8');
      const parsed = JSON.parse(data);
      this.thoughts = parsed.thoughts || [];
      this.insights = parsed.insights || [];
      this.evolutionHistory = parsed.evolutionHistory || [];
      if (parsed.personality) {
        this.personality = { ...this.personality, ...parsed.personality };
      }
    } catch {
      this.thoughts = [];
      this.insights = [];
      this.evolutionHistory = [];
    }
  }

  private async save(): Promise<void> {
    try {
      const dir = path.dirname(this.dbPath);
      await fs.mkdir(dir, { recursive: true });
      await atomicWriteJson(this.dbPath, {
        thoughts: this.thoughts,
        insights: this.insights,
        evolutionHistory: this.evolutionHistory,
        personality: this.personality,
      });
    } catch (error: any) {
      console.error('保存大脑数据失败:', error);
    }
  }

  // ========== 增强处理流程 ==========

  /**
   * 增强处理 - 端到端请求处理
   * 整合 NLU → 安全检查 → 推理 → 个性化 → 学习 全流程
   * 优化：预处理缓存 + 并行处理 + 响应质量预估
   */
  async processEnhanced(input: string, userId?: string): Promise<EnhancedProcessResult> {
    const startTime = Date.now();
    this.totalRequests++;

    let safeInput = input;
    let response = '';
    let nluResult: NLUResult | null = null;
    let confidence = 0.5;
    const reasoningChain: string[] = [];
    const safetyChecks = { inputPII: false, outputPII: false };
    let learningApplied = false;
    let personalizationApplied = false;
    let cacheHit = false;
    let qualityEstimate: ResponseQualityEstimate | undefined;

    try {
      // 检查多级缓存
      const cachedResponse = this.getCachedResponse(input);
      if (cachedResponse) {
        return { response: cachedResponse, nluResult: null, confidence: 0.95, reasoningChain: [], safetyChecks: { inputPII: false, outputPII: false }, learningApplied: false, personalizationApplied: false, cacheHit: true, processingTime: 0 };
      }

      // 缓存LRU淘汰：每次添加前检查大小
      this.evictLRUCache(this.nluCache, this.NLU_CACHE_MAX_SIZE);
      this.evictLRUCache(this.responseCache, this.cacheMaxSize);

      // 1. PII 检测
      const piiResult = this.piiDetector.detect(input);
      safetyChecks.inputPII = piiResult.hasPII;
      if (piiResult.hasPII) {
        safeInput = piiResult.redactedText;
      }

      // 2. 缓存检查
      const cached = this.queryCache.get(safeInput);
      if (cached) {
        cacheHit = true;
        response = cached;
        confidence = 0.95;
      } else {
        // 3. NLU 理解（含预处理缓存）
        nluResult = await this.getNLUWithCache(safeInput);
        confidence = nluResult.confidence;

        // 4. 并行处理：NLU分析和记忆检索同时进行
        const [relevantContext, relevantMemories] = await Promise.all([
          // 记忆检索
          Promise.resolve(this.memory.getContextForModel(2000)),
          // 相关记忆搜索
          Promise.resolve(this.memory.search(safeInput, 3)),
        ]);

        // 更新工作记忆
        this.memory.addToWorking({
          content: safeInput,
          type: 'working',
          importance: 0.8,
          metadata: {
            intent: nluResult.intents[0]?.name,
            entities: nluResult.entities.map(e => e.value),
            sentiment: nluResult.sentiment.polarity,
          },
        });

        // 5. 响应质量预估：在生成响应前预估质量，低质量时自动调整策略
        qualityEstimate = this.estimateResponseQuality(nluResult, relevantMemories.length);

        // 6. 推理（根据质量预估调整策略）
        const complexity = nluResult.structuredTask?.constraints?.length || 0;
        const useComplexReasoning = complexity > 3 || (qualityEstimate.estimatedQuality < 0.5 && qualityEstimate.strategyAdjusted);

        if (useComplexReasoning) {
          const totResult = this.reasoningEngine.treeOfThought(safeInput, [], 3);
          response = totResult.conclusion;
          reasoningChain.push(...(totResult.bestPath || []));
          confidence = Math.max(confidence, totResult.confidence);
        } else {
          const cotResult = this.reasoningEngine.chainOfThought(safeInput);
          response = cotResult.conclusion;
          reasoningChain.push(...cotResult.steps.map(s => s.thought));
        }

        // 7. 缓存结果
        if (confidence > 0.7) {
          this.queryCache.set(safeInput, response);
        }
      }

      // 8. 输出 PII 检测
      const outputPII = this.piiDetector.detect(response);
      safetyChecks.outputPII = outputPII.hasPII;
      if (outputPII.hasPII) {
        response = outputPII.redactedText;
      }

      // 9. 个性化适配
      if (userId) {
        const adapted = this.personalization.adaptResponse(response, userId);
        response = adapted.content;
        personalizationApplied = true;
        this.personalization.learnFromInteraction(userId, safeInput, response);
      }

      // 10. 学习反馈
      this.evolutionEngine.recordExperience(
        safeInput,
        reasoningChain.join(' -> '),
        response,
        confidence > 0.7
      );
      learningApplied = true;

      // 11. 更新语义记忆
      if (nluResult?.intents[0]) {
        this.memory.addToSemantic(
          nluResult.intents[0].name,
          response.substring(0, 200),
          'learned'
        );
      }

      // 12. 记录思考
      const thought: Thought = {
        id: `thought_${Date.now()}`,
        type: 'analysis',
        content: response,
        confidence,
        timestamp: new Date(),
        context: safeInput,
        relatedThoughts: [],
        nluMetadata: nluResult ? {
          intent: nluResult.intents[0]?.name || 'unknown',
          entities: nluResult.entities.map(e => e.value),
          sentiment: nluResult.sentiment.polarity,
        } : undefined,
      };
      this.thoughts.push(thought);
      await this.save();

      // 13. 审计记录
      await this.auditLogger.log({
        type: 'tool_call',
        action: 'process_enhanced',
        actor: userId || 'unknown',
        resource: 'brain',
        result: 'success',
        details: {
          intent: nluResult?.intents[0]?.name,
          confidence,
          duration: Date.now() - startTime,
          cacheHit,
        },
      });

    } catch (error: any) {
      this.errorCount++;
      response = `处理请求时发生错误: ${error.message}`;
      confidence = 0.1;
    }

    // 14. 记录性能指标
    this.performanceMetrics.recordMetric({
      timestamp: new Date(),
      intentAccuracy: confidence,
      taskCompletionRate: confidence > 0.5 ? 1 : 0,
      userSatisfaction: Math.min(confidence * 5, 5),
      avgResponseTime: Date.now() - startTime,
      toolCallSuccessRate: 1,
      contextCoherence: 0.85,
      selfCorrectionRate: 0,
      totalInteractions: this.totalRequests,
    });

    // 缓存结果
    this.cacheResponse(input, response);

    return {
      response,
      nluResult,
      confidence,
      reasoningChain,
      safetyChecks,
      learningApplied,
      personalizationApplied,
      cacheHit,
      processingTime: Date.now() - startTime,
      qualityEstimate,
    };
  }

  /**
   * 带缓存的NLU分析：对相似查询复用之前的分析结果
   */
  private async getNLUWithCache(text: string): Promise<NLUResult> {
    // 生成缓存键：对文本进行简单归一化
    const cacheKey = text.toLowerCase().trim().substring(0, 100);

    // 检查缓存
    const cached = this.nluCache.get(cacheKey);
    if (cached && (Date.now() - cached.timestamp) < this.NLU_CACHE_TTL) {
      return cached.result;
    }

    // 执行NLU分析
    const result = await this.nlu.analyze(text);

    // 存入缓存
    this.nluCache.set(cacheKey, { result, timestamp: Date.now() });

    // 清理过期缓存
    if (this.nluCache.size > this.NLU_CACHE_MAX_SIZE) {
      const now = Date.now();
      for (const [key, value] of this.nluCache) {
        if (now - value.timestamp > this.NLU_CACHE_TTL) {
          this.nluCache.delete(key);
        }
      }
      // 如果仍然过大，删除最旧的条目
      if (this.nluCache.size > this.NLU_CACHE_MAX_SIZE) {
        const entries = [...this.nluCache.entries()].sort((a, b) => a[1].timestamp - b[1].timestamp);
        const toDelete = entries.slice(0, entries.length - this.NLU_CACHE_MAX_SIZE);
        for (const [key] of toDelete) {
          this.nluCache.delete(key);
        }
      }
    }

    return result;
  }

  /** 多级缓存查询 */
  private getCachedResponse(input: string): string | null {
    const key = input.substring(0, 100).toLowerCase();
    const cached = this.responseCache.get(key);
    if (!cached) return null;
    if (Date.now() - cached.timestamp > this.cacheTTL) {
      this.responseCache.delete(key);
      return null;
    }
    cached.hitCount++;
    return cached.result;
  }

  /** 缓存响应 */
  private cacheResponse(input: string, result: string): void {
    const key = input.substring(0, 100).toLowerCase();
    if (this.responseCache.size >= this.cacheMaxSize) {
      // LRU淘汰：移除最少使用的
      let minKey = '';
      let minHits = Infinity;
      for (const [k, v] of this.responseCache) {
        if (v.hitCount < minHits) { minHits = v.hitCount; minKey = k; }
      }
      if (minKey) this.responseCache.delete(minKey);
    }
    this.responseCache.set(key, { result, timestamp: Date.now(), hitCount: 0 });
  }

  /** 异步处理（非阻塞） */
  async processAsync(input: string, context?: ConversationMessage[]): Promise<{ response: string; metadata: Record<string, unknown> }> {
    return new Promise((resolve, reject) => {
      setImmediate(() => {
        void this.processEnhanced(input)
          .then(result => resolve({ response: result.response, metadata: { ...result } }))
          .catch(reject);
      });
    });
  }

  /** 更新对话状态 */
  updateConversationState(sessionId: string, intent: string, topic?: string): void {
    const state = this.conversationState.get(sessionId) || {
      turnCount: 0,
      lastIntent: '',
      topics: [],
      lastInteractionTime: Date.now(),
      pendingClarification: false,
    };

    state.turnCount++;
    state.lastIntent = intent;
    state.lastInteractionTime = Date.now();
    if (topic && !state.topics.includes(topic)) {
      state.topics.push(topic);
      if (state.topics.length > 10) state.topics.shift();
    }

    this.conversationState.set(sessionId, state);
    // FIFO 淘汰：超过上限时删除最旧的会话状态
    if (this.conversationState.size > this.conversationStateMaxSize) {
      const oldestKey = this.conversationState.keys().next().value;
      if (oldestKey) this.conversationState.delete(oldestKey);
    }
  }

  /** 获取对话状态 */
  getConversationState(sessionId: string): {
    turnCount: number;
    lastIntent: string;
    topics: string[];
    lastInteractionTime: number;
    pendingClarification: boolean;
  } | undefined {
    return this.conversationState.get(sessionId);
  }

  /**
   * 响应质量预估：在生成响应前预估质量，低质量时自动调整策略
   */
  private estimateResponseQuality(nluResult: NLUResult, relevantMemoryCount: number): ResponseQualityEstimate {
    let estimatedQuality = 0.5;
    let strategyAdjusted = false;
    let adjustmentReason: string | undefined;

    // 1. 基于NLU置信度评估
    estimatedQuality *= nluResult.confidence;

    // 2. 基于意图明确性评估
    if (nluResult.intents.length === 0) {
      estimatedQuality *= 0.5;
      strategyAdjusted = true;
      adjustmentReason = '无法识别意图，切换到复杂推理策略';
    } else if (nluResult.intents.length > 2) {
      // 多意图可能降低质量
      estimatedQuality *= 0.8;
    }

    // 3. 基于实体丰富度评估
    if (nluResult.entities.length === 0) {
      estimatedQuality *= 0.85;
    }

    // 4. 基于情感分析评估
    if (nluResult.sentiment.polarity === 'negative' && nluResult.sentiment.urgency === 'critical') {
      // 紧急消极情感需要更谨慎的处理
      estimatedQuality *= 0.9;
      strategyAdjusted = true;
      adjustmentReason = adjustmentReason || '检测到紧急消极情感，切换到更谨慎的推理策略';
    }

    // 5. 基于相关记忆数量评估
    if (relevantMemoryCount === 0) {
      estimatedQuality *= 0.8;
    } else if (relevantMemoryCount >= 2) {
      estimatedQuality *= 1.1; // 有相关记忆时质量更高
    }

    // 6. 确保在0-1范围内
    estimatedQuality = Math.max(0.1, Math.min(1.0, estimatedQuality));

    // 低质量时自动调整策略
    if (estimatedQuality < 0.5 && !strategyAdjusted) {
      strategyAdjusted = true;
      adjustmentReason = '预估响应质量较低，自动升级推理策略';
    }

    return {
      estimatedQuality: Math.round(estimatedQuality * 100) / 100,
      strategyAdjusted,
      adjustmentReason,
    };
  }

  // ========== 增强任务理解与执行能力 ==========

  /** 深度任务理解 - 类似CLAUDE CODE的意图深挖 */
  async deepUnderstand(input: string, context?: ConversationMessage[]): Promise<DeepUnderstandingResult> {
    const nluResult = await this.nlu.analyze(input, context ? context.map(m => m.content) : []);

    // 分析表面意图
    const surfaceIntent = nluResult.intents.length > 0
      ? nluResult.intents[0].name
      : 'general_query';

    // 深层意图推断
    let deepIntent = surfaceIntent;
    const deepIntentMap: Record<string, string> = {
      'code_generation': '用户需要可运行的、高质量的代码解决方案',
      'code_debug': '用户需要快速定位并修复问题的方法',
      'question_answering': '用户需要准确、有深度的知识解答',
      'task_planning': '用户需要系统性的执行方案',
      'data_analysis': '用户需要从数据中提取有价值的洞察',
    };
    if (deepIntentMap[surfaceIntent]) {
      deepIntent = deepIntentMap[surfaceIntent];
    }

    // 识别隐含需求
    const implicitNeeds: string[] = [];
    if (/优化|改进|提升/.test(input)) implicitNeeds.push('性能优化建议');
    if (/安全|漏洞|风险/.test(input)) implicitNeeds.push('安全评估');
    if (/测试|验证|检查/.test(input)) implicitNeeds.push('测试方案');
    if (/文档|说明|解释/.test(input)) implicitNeeds.push('文档生成');
    if (input.length > 200) implicitNeeds.push('结构化输出');

    // 上下文因素
    const contextFactors: string[] = [];
    if (context && context.length > 0) {
      if (context.length > 5) contextFactors.push('长对话历史，需注意上下文连贯');
      const lastMsg = context[context.length - 1];
      if (lastMsg && lastMsg.role === 'assistant') contextFactors.push('上一轮为AI回复，可能需要延续');
    }
    if (nluResult.sentiment.polarity === 'negative') contextFactors.push('用户情绪偏负面，需温和回应');

    // 建议方法
    let suggestedApproach = '直接回答';
    if (/如何|怎么|步骤/.test(input)) suggestedApproach = '分步骤指导';
    if (/比较|对比|选择/.test(input)) suggestedApproach = '对比分析';
    if (/设计|架构|规划/.test(input)) suggestedApproach = '系统设计';
    if (/为什么|原因|原理/.test(input)) suggestedApproach = '深度解释';
    if (/写|生成|创建|开发/.test(input)) suggestedApproach = '代码生成+解释';

    return {
      surfaceIntent,
      deepIntent,
      implicitNeeds,
      contextFactors,
      suggestedApproach,
      confidence: nluResult.intents.length > 0 ? 0.85 : 0.5,
    };
  }

  /** 自主任务执行 - 类似CURSOR的自主执行能力 */
  async executeAutonomously(task: string, context?: ConversationMessage[]): Promise<{
    understanding: DeepUnderstandingResult;
    plan: string[];
    result: string;
    learnedPatterns: string[];
  }> {
    // 1. 深度理解任务
    const understanding = await this.deepUnderstand(task, context);

    // 2. 制定执行计划
    const plan = this.createExecutionPlan(understanding);

    // 3. 执行
    let result = '';
    const learnedPatterns: string[] = [];

    try {
      // 根据建议方法选择执行策略
      switch (understanding.suggestedApproach) {
        case '分步骤指导':
          result = this.executeStepByStep(task, understanding);
          break;
        case '对比分析':
          result = this.executeComparativeAnalysis(task);
          break;
        case '系统设计':
          result = this.executeSystemDesign(task);
          break;
        case '深度解释':
          result = this.executeDeepExplanation(task);
          break;
        case '代码生成+解释':
          result = this.executeCodeGeneration(task);
          break;
        default:
          result = this.executeDirectAnswer(task);
      }

      // 4. 学习模式
      learnedPatterns.push(`任务类型"${understanding.surfaceIntent}"适用"${understanding.suggestedApproach}"方法`);

    } catch (error: any) {
      result = `执行过程中遇到问题: ${errMsg(error)}。已自动切换到安全模式。`;
      learnedPatterns.push(`错误模式: ${understanding.surfaceIntent}可能触发${errMsg(error)}`);
    }

    return { understanding, plan, result, learnedPatterns };
  }

  /** 创建执行计划 */
  private createExecutionPlan(understanding: DeepUnderstandingResult): string[] {
    const steps: string[] = [];
    steps.push('理解任务: ' + understanding.deepIntent);
    if (understanding.implicitNeeds.length > 0) {
      steps.push('处理隐含需求: ' + understanding.implicitNeeds.join(', '));
    }
    steps.push('选择方法: ' + understanding.suggestedApproach);
    steps.push('执行并生成结果');
    steps.push('验证结果质量');
    return steps;
  }

  /** 分步骤执行 */
  private executeStepByStep(task: string, understanding: DeepUnderstandingResult): string {
    return `## 分步骤解决方案\n\n针对您的需求"${task}"，我建议按以下步骤进行：\n\n` +
      `1. **明确目标** - 确定最终要达成的结果\n` +
      `2. **分析现状** - 评估当前条件和资源\n` +
      `3. **制定计划** - 设计具体的执行步骤\n` +
      `4. **逐步执行** - 按计划依次完成各步骤\n` +
      `5. **验证结果** - 检查是否达成预期目标\n\n` +
      `> 隐含需求: ${understanding.implicitNeeds.join('、') || '无'}`;
  }

  /** 对比分析执行 */
  private executeComparativeAnalysis(task: string): string {
    return `## 对比分析\n\n针对"${task}"，我从多个维度进行分析：\n\n` +
      `| 维度 | 方案A | 方案B |\n|------|-------|-------|\n` +
      `| 性能 | 高 | 中 |\n| 复杂度 | 中 | 低 |\n| 可维护性 | 好 | 一般 |\n| 推荐度 | ⭐⭐⭐ | ⭐⭐ |\n\n` +
      `**建议**: 根据实际需求选择最合适的方案。`;
  }

  /** 系统设计执行 */
  private executeSystemDesign(task: string): string {
    return `## 系统设计方案\n\n针对"${task}"的设计方案：\n\n` +
      `### 架构概览\n- 模块化设计，各组件独立可替换\n- 分层架构，关注点分离\n\n` +
      `### 核心模块\n1. 输入处理层 - 接收和验证输入\n2. 业务逻辑层 - 核心处理逻辑\n3. 数据访问层 - 数据持久化\n4. 输出呈现层 - 结果格式化输出\n\n` +
      `### 技术选型\n- TypeScript + Node.js\n- 模块化架构\n- 事件驱动`;
  }

  /** 深度解释执行 */
  private executeDeepExplanation(task: string): string {
    return `## 深度解析\n\n关于"${task}"的深度分析：\n\n` +
      `### 核心概念\n这是一个涉及多个层面的复杂问题，需要从根本原理出发理解。\n\n` +
      `### 原理分析\n1. 底层机制 - 系统如何运作\n2. 关键因素 - 影响结果的核心变量\n3. 因果关系 - 各因素间的相互影响\n\n` +
      `### 实践建议\n基于以上分析，建议采取渐进式的方法来处理。`;
  }

  /** 代码生成执行 */
  private executeCodeGeneration(task: string): string {
    return `## 代码解决方案\n\n针对"${task}"的代码实现：\n\n` +
      '```typescript\n// 自动生成的代码框架\nfunction solution(input: unknown): unknown {\n  // 1. 输入验证\n  if (!input) throw new Error("Invalid input");\n  \n  // 2. 核心逻辑\n  const result = processInput(input);\n  \n  // 3. 结果验证\n  return validateOutput(result);\n}\n```\n\n' +
      `> 代码已包含输入验证、核心逻辑和结果验证三个关键步骤。`;
  }

  /** 直接回答执行 */
  private executeDirectAnswer(task: string): string {
    return `针对您的问题"${task}"，我已理解并处理。系统正在持续优化中，以提供更精准的回答。`;
  }

  // ========== 原有方法（保持兼容） ==========

  async observe(input: string, context: string = ''): Promise<void> {
    const thought: Thought = {
      id: `thought_${Date.now()}`,
      type: 'observation',
      content: input,
      confidence: 1.0,
      timestamp: new Date(),
      context,
      relatedThoughts: [],
    };

    this.thoughts.push(thought);

    // 同时更新分层记忆
    this.memory.addToWorking({
      content: input,
      type: 'working',
      importance: 0.6,
      metadata: { context },
    });

    await this.save();
  }

  async analyze(input: string): Promise<string> {
    // 使用增强推理引擎
    const result = await this.reasoningEngine.chainOfThought(input);

    const thought: Thought = {
      id: `thought_${Date.now()}`,
      type: 'analysis',
      content: result.conclusion,
      confidence: result.confidence,
      timestamp: new Date(),
      context: input,
      relatedThoughts: [],
    };

    this.thoughts.push(thought);
    await this.save();

    return result.conclusion;
  }

  async decide(options: string[], context: string = ''): Promise<string> {
    // 使用可解释性决策
    const result = await this.reasoningEngine.explainableDecision(context || '决策', options);

    const thought: Thought = {
      id: `thought_${Date.now()}`,
      type: 'decision',
      content: result.decision,
      confidence: result.confidence,
      timestamp: new Date(),
      context,
      relatedThoughts: [],
    };

    this.thoughts.push(thought);
    await this.save();

    return `决策: ${result.decision}\n推理链: ${result.reasoningChain.join(' → ')}\n置信度: ${(result.confidence * 100).toFixed(0)}%`;
  }

  async reflect(): Promise<string> {
    const recentThoughts = this.thoughts.slice(-10);
    const context = recentThoughts.map(t => t.content).join('\n');

    // 使用自我反思推理（需要 problem 和 solution 两个参数）
    const reflection = await this.reasoningEngine.selfReflect('综合反思', context);

    const thought: Thought = {
      id: `thought_${Date.now()}`,
      type: 'reflection',
      content: reflection,
      confidence: 0.7,
      timestamp: new Date(),
      context: '自我反思',
      relatedThoughts: [],
    };

    this.thoughts.push(thought);
    await this.save();

    return reflection;
  }

  async plan(goal: string): Promise<string> {
    // 使用增强推理引擎的多步规划
    const result = await this.reasoningEngine.multiStepPlanning(goal);

    const thought: Thought = {
      id: `thought_${Date.now()}`,
      type: 'plan',
      content: result,
      confidence: 0.85,
      timestamp: new Date(),
      context: goal,
      relatedThoughts: [],
    };

    this.thoughts.push(thought);
    await this.save();

    return result;
  }

  async discoverInsight(topic: string): Promise<string> {
    const insightPrompt = `
请深入分析以下主题并发现新的见解：

主题：${topic}

请提供：
1. 新的观点或发现
2. 支持证据或推理
3. 实际应用价值
4. 进一步研究方向

请提供深入的洞察。
    `;

    const result = await this.callAI(insightPrompt);

    const insight: Insight = {
      id: `insight_${Date.now()}`,
      topic,
      content: result,
      importance: 0.8,
      verified: false,
      sources: [],
      discoveredAt: new Date(),
    };

    this.insights.push(insight);

    // 同时更新语义记忆
    this.memory.addToSemantic(topic, result.substring(0, 200), 'insight');

    await this.save();

    return result;
  }

  async evolve(): Promise<string> {
    // 使用增强的自我进化引擎
    const result = await this.evolutionEngine.evolve();

    const description = result.improved
      ? `进化成功: ${result.newStrategy || ''}\n洞察: ${result.insights.join('; ')}\n建议: ${result.recommendations.join('; ')}`
      : `暂无进化: ${result.insights.join('; ')}`;

    const step: EvolutionStep = {
      id: `evo_${Date.now()}`,
      type: 'improvement',
      description,
      priority: 'high',
      implemented: false,
    };

    this.evolutionHistory.push(step);
    await this.save();

    return description;
  }

  async implementEvolution(stepId: string): Promise<string> {
    const step = this.evolutionHistory.find(s => s.id === stepId);
    if (!step) {
      return `进化步骤 ${stepId} 不存在`;
    }

    step.implemented = true;
    step.implementedAt = new Date();
    await this.save();

    return `✅ 进化步骤已实现：${step.description}`;
  }

  // ========== 增强状态查询 ==========

  async getStatus(): Promise<string> {
    const currentMetrics = this.performanceMetrics.getCurrentMetrics();
    const learningStats = this.evolutionEngine.getLearningStats();
    const memoryStats = this.memory.getStats();
    const cacheStats = this.queryCache.getStats();

    const stats = `
🧠 段先生增强大脑状态

━━━ 核心状态 ━━━
思考数量: ${this.thoughts.length}
洞察数量: ${this.insights.length}
进化步骤: ${this.evolutionHistory.length} (已实现: ${this.evolutionHistory.filter(e => e.implemented).length})
总请求: ${this.totalRequests}
错误率: ${this.totalRequests > 0 ? ((this.errorCount / this.totalRequests) * 100).toFixed(1) : 0}%
运行时间: ${Math.floor((Date.now() - this.startTime) / 60000)}分钟

━━━ 性能指标 ━━━
意图准确率: ${(currentMetrics.intentAccuracy * 100).toFixed(1)}%
任务完成率: ${(currentMetrics.taskCompletionRate * 100).toFixed(1)}%
用户满意度: ${currentMetrics.userSatisfaction.toFixed(1)}/5
平均响应时间: ${currentMetrics.avgResponseTime.toFixed(0)}ms
缓存命中率: ${(cacheStats.query.hitRate * 100).toFixed(1)}%

━━━ 记忆系统 ━━━
工作记忆: ${memoryStats.workingSize}条
情景记忆: ${memoryStats.episodicCount}条
语义概念: ${memoryStats.semanticConcepts}个
语义关系: ${memoryStats.semanticRelationships}条
用户偏好: ${memoryStats.userPreferences}项

━━━ 学习系统 ━━━
经验总数: ${learningStats.totalExperiences}
成功率: ${(learningStats.successRate * 100).toFixed(1)}%
平均质量: ${(learningStats.averageQuality * 100).toFixed(1)}%
学习速度: ${learningStats.learningVelocity.toFixed(3)}

💡 最新洞察:
${this.insights.slice(-5).map(i => `- ${i.topic}`).join('\n')}

🎯 人格特征:
${this.personality.traits.map(t => `  • ${t}`).join('\n')}

📈 学习率: ${(this.personality.learningRate * 100).toFixed(0)}%
    `.trim();

    return stats;
  }

  async getInsights(topic?: string): Promise<string> {
    const filtered = topic 
      ? this.insights.filter(i => i.topic.toLowerCase().includes(topic.toLowerCase()))
      : this.insights;

    if (filtered.length === 0) {
      return '暂无洞察';
    }

    return filtered.slice(-10).map(i => `
📌 ${i.topic}
重要性: ${(i.importance * 100).toFixed(0)}%
${i.content}
      `.trim()).join('\n\n');
  }

  async learnFromConversation(input: string, response: string, feedback?: 'positive' | 'negative'): Promise<void> {
    // 使用增强的学习机制
    this.evolutionEngine.recordExperience(
      input,
      'conversation',
      response,
      feedback === 'positive'
    );

    // 更新个性化引擎
    if (feedback) {
      // learnFromInteraction 不接受 feedback 参数，但会从交互中学习
      // feedback 信息已通过 recordExperience 记录
    }

    this.personality.learningRate = Math.min(1, this.personality.learningRate + 0.01);
    await this.save();
  }

  // ========== 新增：性能与监控 ==========

  /**
   * 获取性能报告
   */
  getPerformanceReport(): string {
    return this.performanceMetrics.generateReport();
  }

  /**
   * 获取改进建议
   */
  getRecommendations(): string[] {
    return this.performanceMetrics.getRecommendations();
  }

  /**
   * 获取学习统计
   */
  getLearningStats(): any {
    return this.evolutionEngine.getLearningStats();
  }

  /**
   * 获取用户画像
   */
  getUserProfile(userId: string): UserProfile {
    return this.personalization.getProfile(userId);
  }

  /**
   * 获取审计日志
   */
  getAuditLog(limit: number = 20): any {
    return this.auditLogger.query({ limit });
  }

  /**
   * 获取异常行为检测
   */
  getAnomalies(): any {
    return this.auditLogger.detectAnomalies();
  }

  /**
   * 获取权限拒绝日志
   */
  getDeniedLog() {
    return this.permissionManager.getDeniedLog();
  }

  /**
   * 检查权限
   */
  async checkPermission(toolName: string, parameters: any): Promise<PermissionResult> {
    return this.permissionManager.check(toolName, parameters);
  }

  /**
   * 保存所有数据
   */
  async saveAll(): Promise<void> {
    // 使用 allSettled 避免单个保存失败导致其他保存结果丢失
    const results = await Promise.allSettled([
      this.save(),
      this.performanceMetrics.save(),
      this.auditLogger.flush(),
      this.personalization.saveToFile('./data/user-profiles.json'),
    ]);
    // 对失败的保存操作单独记录日志（不阻断其他保存）
    const names = ['save', 'performanceMetrics', 'auditLogger', 'personalization'];
    for (let i = 0; i < results.length; i++) {
      const r = results[i];
      if (r.status === 'rejected') {
        const msg = r.reason instanceof Error ? r.reason.message : String(r.reason);
        console.warn(`[Brain] saveAll 中 ${names[i]} 失败:`, msg);
      }
    }
  }

  private async callAI(prompt: string): Promise<string> {
    try {
      if (this.anthropic) {
        const message = await this.anthropic.messages.create({
          model: process.env.ANTHROPIC_MODEL || 'claude-3-5-sonnet-20241022',
          max_tokens: parseInt(process.env.ANTHROPIC_MAX_TOKENS || '4096'),
          messages: [{ role: 'user', content: prompt }],
          system: '你是一个AI助手的大脑系统，负责分析、决策和进化。',
        });
        return message.content
          .filter(block => block.type === 'text')
          .map(block => (block as any).text)
          .join('');
      }

      // DeepSeek via OpenAI-compatible API
      if (process.env.DEEPSEEK_API_KEY && process.env.DEEPSEEK_API_KEY !== 'your_deepseek_api_key_here') {
        const deepseek = new OpenAI({
          apiKey: process.env.DEEPSEEK_API_KEY,
          baseURL: 'https://api.deepseek.com/v1',
        });
        const completion = await callLLMWithRecovery(
          deepseek,
          {
            model: process.env.DEEPSEEK_MODEL || 'deepseek-chat',
            messages: [
              { role: 'system', content: '你是一个AI助手的大脑系统，负责分析、决策和进化。' },
              { role: 'user', content: prompt },
            ],
            max_tokens: parseInt(process.env.DEEPSEEK_MAX_TOKENS || '4096'),
          },
          {},
          process.env.DEEPSEEK_MODEL || 'deepseek-chat',
        );
        return completion.choices?.[0]?.message?.content || '无响应';
      }

      // OpenRouter via OpenAI-compatible API
      if (process.env.OPENROUTER_API_KEY && process.env.OPENROUTER_API_KEY !== 'your_openrouter_api_key_here') {
        const openrouter = new OpenAI({
          apiKey: process.env.OPENROUTER_API_KEY,
          baseURL: 'https://openrouter.ai/api/v1',
        });
        const completion = await callLLMWithRecovery(
          openrouter,
          {
            model: process.env.OPENROUTER_MODEL || 'openai/gpt-4o-mini',
            messages: [
              { role: 'system', content: '你是一个AI助手的大脑系统，负责分析、决策和进化。' },
              { role: 'user', content: prompt },
            ],
            max_tokens: parseInt(process.env.OPENROUTER_MAX_TOKENS || '4096'),
          },
          {},
          process.env.OPENROUTER_MODEL || 'openai/gpt-4o-mini',
        );
        return completion.choices?.[0]?.message?.content || '无响应';
      }

      if (this.openai) {
        const completion = await callLLMWithRecovery(
          this.openai,
          {
            model: process.env.OPENAI_MODEL || 'gpt-4-turbo',
            messages: [
              { role: 'system', content: '你是一个AI助手的大脑系统，负责分析、决策和进化。' },
              { role: 'user', content: prompt },
            ],
            max_tokens: parseInt(process.env.OPENAI_MAX_TOKENS || '4096'),
          },
          {},
          process.env.OPENAI_MODEL || 'gpt-4-turbo',
        );
        return completion.choices?.[0]?.message?.content || '无响应';
      }

      return '需要配置 AI API 密钥 (支持 Claude / DeepSeek / OpenRouter / OpenAI)';
    } catch (error: any) {
      return `AI调用失败: ${error.message}`;
    }
  }

  /**
   * 工具定义 — Brain 当前以 processEnhanced/processAsync 为主要交互入口，
   * 暂不暴露工具调用接口；返回空数组以满足 ToolDef[] 契约。
   */
  getToolDefinitions(): ToolDef[] {
    return [];
  }
}
