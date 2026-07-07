/**
 * P2-1: 用户偏好学习闭环引擎 — UserPreferenceEngine
 *
 * 对标 PersonaAgent 的用户偏好学习机制，作为 UnifiedUserProfileCenter 的薄包装/扩展层，
 * 补充以下缺失能力（避免与 unified-user-profile.ts 的 Hermes 偏好系统重复）：
 *
 * 1. 双向量用户状态：长期向量（稳定跨会话偏好）+ 短期向量（会话内适应）
 * 2. 三步循环：行动前寻求澄清消歧 → 基于记忆偏好行动 → 行动后整合反馈更新记忆
 * 3. persona prompt：每用户唯一系统提示，基于偏好动态生成
 * 4. 隐式信号采集：编辑行为、工具选择、审批/拒绝、使用时间、模板复用
 * 5. 显式信号采集：thumbs-up/down、pairwise 比较、直接反馈
 *
 * 职责边界：
 * - 偏好存储/检索/过期/置信度 → 委托给 UnifiedUserProfileCenter
 * - 双向量状态/三步循环/persona prompt/信号采集 → 本引擎独有
 */

import * as fs from 'fs';
import * as path from 'path';
import { logger } from './structured-logger.js';
import { atomicWriteJsonSync } from './atomic-write.js';
import { EventBus } from './event-bus.js';
import { UnifiedUserProfileCenter, type HermesUserPreference } from './unified-user-profile.js';

// ============ 类型定义 ============

/** 信号来源类型 */
export type PreferenceSignalType =
  | 'explicit_thumbs_up' // 显式：点赞
  | 'explicit_thumbs_down' // 显式：点踩
  | 'explicit_pairwise' // 显式：成对比较
  | 'explicit_feedback' // 显式：直接反馈
  | 'implicit_edit' // 隐式：编辑行为
  | 'implicit_tool_choice' // 隐式：工具选择
  | 'implicit_approval' // 隐式：审批
  | 'implicit_rejection' // 隐式：拒绝
  | 'implicit_usage_time' // 隐式：使用时间
  | 'implicit_template_reuse'; // 隐式：模板复用

/** 偏好信号 */
export interface PreferenceSignal {
  /** 信号类型 */
  type: PreferenceSignalType;
  /** 信号类别（与 HermesUserPreference.category 对齐） */
  category: HermesUserPreference['category'];
  /** 偏好键 */
  key: string;
  /** 偏好值 */
  value: string;
  /** 信号强度 0-1（显式信号默认 1.0，隐式信号默认 0.3-0.6） */
  strength: number;
  /** 时间戳 */
  timestamp: number;
  /** 附加上下文 */
  context?: Record<string, unknown>;
}

/** 长期向量：稳定跨会话偏好（低频更新、高持久性） */
export interface LongTermVector {
  /** 稳定偏好集合（置信度 ≥0.7 的偏好） */
  stablePreferences: HermesUserPreference[];
  /** 用户认知特征快照 */
  cognitiveSnapshot: {
    communicationStyle: string;
    expertiseLevel: string;
    preferredLanguages: string[];
    detailLevel: string;
  };
  /** 最后更新时间 */
  updatedAt: number;
}

/** 短期向量：会话内适应（高频更新、低持久性） */
export interface ShortTermVector {
  /** 会话 ID */
  sessionId: string;
  /** 会话内观察到的偏好（未达到长期向量阈值） */
  sessionPreferences: PreferenceSignal[];
  /** 会话内热点话题 */
  hotTopics: string[];
  /** 会话内情绪趋势 */
  sentimentTrend: 'positive' | 'neutral' | 'negative';
  /** 会话开始时间 */
  startedAt: number;
  /** 最后活动时间 */
  lastActiveAt: number;
}

/** 双向量用户状态 */
export interface DualVectorState {
  userId: string;
  longTerm: LongTermVector;
  shortTerm: ShortTermVector | null;
}

/** 三步循环阶段 */
export type ClarificationPhase = 'clarify' | 'act' | 'integrate';

/** 澄清请求 */
export interface ClarificationRequest {
  /** 需要澄清的偏好维度 */
  dimension: string;
  /** 澄清问题 */
  question: string;
  /** 候选选项 */
  options?: string[];
  /** 置信度阈值（低于此值才触发澄清） */
  confidenceThreshold: number;
}

/** persona prompt 组件 */
export interface PersonaPromptComponents {
  /** 沟通风格指令 */
  communicationStyle: string;
  /** 专业水平适配 */
  expertiseAdaptation: string;
  /** 语言偏好 */
  languagePreference: string;
  /** 详细程度 */
  detailLevel: string;
  /** 工具偏好 */
  toolPreference: string;
  /** 工作习惯 */
  workHabit: string;
}

// ============ 常量 ============

/** 长期向量更新阈值：置信度 ≥0.7 的偏好才进入长期向量 */
const LONG_TERM_CONFIDENCE_THRESHOLD = 0.7;

/** 短期向量会话超时：30 分钟无活动则清空短期向量 */
const SHORT_TERM_SESSION_TIMEOUT_MS = 30 * 60 * 1000;

/** 信号强度默认值 */
const SIGNAL_STRENGTH: Record<PreferenceSignalType, number> = {
  explicit_thumbs_up: 1.0,
  explicit_thumbs_down: 1.0,
  explicit_pairwise: 0.9,
  explicit_feedback: 0.8,
  implicit_edit: 0.5,
  implicit_tool_choice: 0.4,
  implicit_approval: 0.6,
  implicit_rejection: 0.6,
  implicit_usage_time: 0.3,
  implicit_template_reuse: 0.5,
};

// ============ 主类 ============

/**
 * 用户偏好学习闭环引擎
 *
 * 使用方式：
 * ```typescript
 * const engine = new UserPreferenceEngine(profileCenter);
 * engine.startSession(userId, sessionId);
 * engine.recordSignal(userId, { type: 'explicit_thumbs_up', ... });
 * const persona = engine.generatePersonaPrompt(userId);
 * ```
 */
export class UserPreferenceEngine {
  private readonly profileCenter: UnifiedUserProfileCenter;
  private readonly dualVectors: Map<string, DualVectorState> = new Map();
  private readonly clarificationQueue: Map<string, ClarificationRequest[]> = new Map();

  /** P2-1: 交互计数器（按用户） */
  private readonly interactionCounts: Map<string, number> = new Map();
  /** P2-1: 推荐追踪（按用户）— 记录推荐及是否被采纳 */
  private readonly recommendationTracker: Map<string, Array<{
    id: string;
    category: string;
    key: string;
    value: string;
    adopted: boolean | null;
    timestamp: number;
  }>> = new Map();
  /** P2-1: 收敛阈值 — 学到 3 个高置信度偏好即视为收敛 */
  private static readonly CONVERGENCE_PREF_COUNT = 3;
  /** P2-1: 推荐目标准确率 */
  private static readonly TARGET_ACCURACY = 0.9;

  constructor(profileCenter?: UnifiedUserProfileCenter) {
    this.profileCenter = profileCenter ?? new UnifiedUserProfileCenter();
  }

  // ============ 双向量用户状态 ============

  /**
   * 启动新会话 — 初始化短期向量
   */
  startSession(userId: string, sessionId: string): void {
    const longTerm = this.getLongTermVector(userId);
    const shortTerm: ShortTermVector = {
      sessionId,
      sessionPreferences: [],
      hotTopics: [],
      sentimentTrend: 'neutral',
      startedAt: Date.now(),
      lastActiveAt: Date.now(),
    };

    this.dualVectors.set(userId, { userId, longTerm, shortTerm });
    logger.info('用户偏好会话已启动', { module: 'UserPreferenceEngine', userId, sessionId });
  }

  /**
   * 结束会话 — 将短期向量中的高置信度偏好提升到长期向量
   */
  endSession(userId: string): void {
    const state = this.dualVectors.get(userId);
    if (!state?.shortTerm) return;

    const sessionPrefs = state.shortTerm.sessionPreferences;

    // 将短期向量中的显式信号提升为 Hermes 偏好
    let promotedCount = 0;
    for (const signal of sessionPrefs) {
      if (signal.strength >= 0.6) {
        this.profileCenter.recordHermesPreference(userId, signal.category, signal.key, signal.value, {
          source: signal.type,
        });
        promotedCount++;
      }
    }

    // 清空短期向量
    state.shortTerm = null;
    state.longTerm.updatedAt = Date.now();

    logger.info('用户偏好会话已结束', { module: 'UserPreferenceEngine', userId, promotedCount });
  }

  /**
   * 获取长期向量（稳定跨会话偏好）
   */
  getLongTermVector(userId: string): LongTermVector {
    const existing = this.dualVectors.get(userId);
    if (existing) return existing.longTerm;

    // 从 UnifiedUserProfileCenter 同步
    const profile = this.profileCenter.getProfile(userId);
    const stablePreferences = this.profileCenter.getHighConfidencePreferences(userId, LONG_TERM_CONFIDENCE_THRESHOLD);

    return {
      stablePreferences,
      cognitiveSnapshot: {
        communicationStyle: profile.cognitive.communicationStyle,
        expertiseLevel: profile.cognitive.expertiseLevel,
        preferredLanguages: profile.cognitive.preferredLanguages,
        detailLevel: profile.cognitive.detailLevel,
      },
      updatedAt: Date.now(),
    };
  }

  /**
   * 获取短期向量（会话内适应）
   */
  getShortTermVector(userId: string): ShortTermVector | null {
    const state = this.dualVectors.get(userId);
    if (!state?.shortTerm) return null;

    // 检查会话超时
    if (Date.now() - state.shortTerm.lastActiveAt > SHORT_TERM_SESSION_TIMEOUT_MS) {
      state.shortTerm = null;
      return null;
    }

    return state.shortTerm;
  }

  // ============ 信号采集 ============

  /**
   * 记录偏好信号（显式或隐式）
   */
  recordSignal(userId: string, signal: Omit<PreferenceSignal, 'timestamp' | 'strength'> & Partial<Pick<PreferenceSignal, 'strength'>>): void {
    const fullSignal: PreferenceSignal = {
      ...signal,
      strength: signal.strength ?? SIGNAL_STRENGTH[signal.type],
      timestamp: Date.now(),
    };

    // P2-1: 累加交互计数
    this.interactionCounts.set(userId, (this.interactionCounts.get(userId) || 0) + 1);

    // 写入短期向量
    const state = this.ensureState(userId);
    state.shortTerm!.sessionPreferences.push(fullSignal);
    state.shortTerm!.lastActiveAt = Date.now();

    // 更新热点话题
    this.updateHotTopics(state.shortTerm!, signal.key);

    // 显式信号直接写入 UnifiedUserProfileCenter（高置信度）
    if (fullSignal.strength >= 0.8) {
      this.profileCenter.recordHermesPreference(userId, signal.category, signal.key, signal.value, {
        source: signal.type,
      });
    }

    // 广播事件
    EventBus.getInstance().emitSync('preference.signal.recorded', {
      userId,
      signalType: signal.type,
      category: signal.category,
      strength: fullSignal.strength,
    });
  }

  /**
   * 批量记录隐式信号
   */
  recordImplicitSignals(userId: string, signals: Array<Omit<PreferenceSignal, 'timestamp' | 'strength'>>): void {
    for (const signal of signals) {
      this.recordSignal(userId, signal);
    }
  }

  /**
   * 记录 thumbs-up/down 反馈
   */
  recordFeedback(userId: string, positive: boolean, target: string, context?: string): void {
    this.recordSignal(userId, {
      type: positive ? 'explicit_thumbs_up' : 'explicit_thumbs_down',
      category: 'work_habit',
      key: 'feedback',
      value: positive ? `liked:${target}` : `disliked:${target}`,
      context: context ? { context } : undefined,
    });
  }

  /**
   * 记录 pairwise 比较
   */
  recordPairwise(userId: string, preferred: string, rejected: string, dimension: HermesUserPreference['category']): void {
    this.recordSignal(userId, {
      type: 'explicit_pairwise',
      category: dimension,
      key: 'pairwise_choice',
      value: `prefer:${preferred}|over:${rejected}`,
    });
  }

  // ============ 三步循环 ============

  /**
   * 三步循环：行动前寻求澄清消歧
   *
   * 当偏好置信度低于阈值时，生成澄清请求
   */
  shouldClarify(userId: string, dimension: HermesUserPreference['category'], key: string): boolean {
    const pref = this.profileCenter.getHermesPreference(userId, dimension, key);
    return !pref || pref.confidence < 0.6;
  }

  /**
   * 生成澄清请求
   */
  generateClarification(userId: string, dimension: HermesUserPreference['category'], key: string): ClarificationRequest | null {
    if (!this.shouldClarify(userId, dimension, key)) return null;

    const questionMap: Record<string, string> = {
      programming_language: '您偏好使用哪种编程语言？',
      work_habit: '您希望我以什么方式协助您工作？',
      communication_style: '您偏好哪种沟通风格？',
      tool_preference: '您偏好使用哪个工具？',
      detail_level: '您希望回答的详细程度如何？',
      expertise_level: '您的专业水平如何？',
    };

    const optionsMap: Record<string, string[]> = {
      programming_language: ['TypeScript', 'Python', 'Rust', 'Go', 'Java'],
      work_habit: ['逐步指导', '直接给方案', '先解释再执行'],
      communication_style: ['正式', '随意', '技术性', '友好'],
      tool_preference: ['自动选择', '指定工具', '提供多个选项'],
      detail_level: ['简洁', '适中', '详细'],
      expertise_level: ['初学者', '中级', '高级', '专家'],
    };

    const request: ClarificationRequest = {
      dimension,
      question: questionMap[key] ?? `请告诉我您对 ${key} 的偏好：`,
      options: optionsMap[key],
      confidenceThreshold: 0.6,
    };

    // 加入澄清队列
    const queue = this.clarificationQueue.get(userId) ?? [];
    queue.push(request);
    this.clarificationQueue.set(userId, queue);

    return request;
  }

  /**
   * 三步循环：基于记忆偏好行动
   *
   * 返回当前用户在指定维度的偏好值（若存在）
   */
  actWithMemory(userId: string, dimension: HermesUserPreference['category'], key: string): string | null {
    const pref = this.profileCenter.getHermesPreference(userId, dimension, key, 0.6);
    return pref?.value ?? null;
  }

  /**
   * 三步循环：行动后整合反馈更新记忆
   *
   * 将用户反馈整合到偏好系统中
   */
  integrateFeedback(userId: string, dimension: HermesUserPreference['category'], key: string, value: string, positive: boolean): void {
    this.recordSignal(userId, {
      type: positive ? 'explicit_feedback' : 'explicit_thumbs_down',
      category: dimension,
      key,
      value,
    });

    // 清除对应的澄清请求
    const queue = this.clarificationQueue.get(userId);
    if (queue) {
      const filtered = queue.filter(r => r.dimension !== dimension);
      this.clarificationQueue.set(userId, filtered);
    }
  }

  /**
   * 获取待处理的澄清请求
   */
  getPendingClarifications(userId: string): ClarificationRequest[] {
    return this.clarificationQueue.get(userId) ?? [];
  }

  // ============ persona prompt 生成 ============

  /**
   * 生成每用户唯一的 persona prompt
   *
   * 基于长期向量 + 短期向量动态组装系统提示
   */
  generatePersonaPrompt(userId: string): string {
    const components = this.getPersonaComponents(userId);
    const lines: string[] = [];

    lines.push('## 用户个性化指令');
    lines.push('');
    lines.push(`### 沟通风格\n${components.communicationStyle}`);
    lines.push(`### 专业水平适配\n${components.expertiseAdaptation}`);
    lines.push(`### 语言偏好\n${components.languagePreference}`);
    lines.push(`### 详细程度\n${components.detailLevel}`);

    if (components.toolPreference) {
      lines.push(`### 工具偏好\n${components.toolPreference}`);
    }
    if (components.workHabit) {
      lines.push(`### 工作习惯\n${components.workHabit}`);
    }

    // 短期向量：会话内适应
    const shortTerm = this.getShortTermVector(userId);
    if (shortTerm && shortTerm.hotTopics.length > 0) {
      lines.push(`### 当前会话热点\n关注话题：${shortTerm.hotTopics.slice(0, 5).join('、')}`);
    }

    return lines.join('\n');
  }

  /**
   * 获取 persona prompt 组件
   */
  getPersonaComponents(userId: string): PersonaPromptComponents {
    const longTerm = this.getLongTermVector(userId);
    const cs = longTerm.cognitiveSnapshot;

    // 沟通风格
    const styleMap: Record<string, string> = {
      formal: '使用正式、专业的语言，避免口语化表达',
      casual: '使用轻松、自然的语言，可以适当使用口语化表达',
      technical: '使用技术性语言，可以直接使用专业术语',
      friendly: '使用友好、亲切的语言，像朋友一样交流',
    };

    // 专业水平适配
    const expertiseMap: Record<string, string> = {
      beginner: '面向初学者，提供详细解释和基础概念说明',
      intermediate: '面向中级用户，提供适度解释，可跳过基础概念',
      advanced: '面向高级用户，直接给出技术细节，无需解释基础概念',
      expert: '面向专家，使用最深层次的技术语言，可直接讨论架构和设计权衡',
    };

    // 详细程度
    const detailMap: Record<string, string> = {
      brief: '回答简洁明了，只给出关键信息',
      moderate: '回答适中，包含必要的解释和示例',
      detailed: '回答详细，包含完整的解释、示例和注意事项',
    };

    // 从 Hermes 偏好中提取工具偏好和工作习惯
    const toolPrefs = longTerm.stablePreferences.filter(p => p.category === 'tool_preference');
    const workPrefs = longTerm.stablePreferences.filter(p => p.category === 'work_habit');

    return {
      communicationStyle: styleMap[cs.communicationStyle] ?? styleMap.friendly,
      expertiseAdaptation: expertiseMap[cs.expertiseLevel] ?? expertiseMap.intermediate,
      languagePreference: cs.preferredLanguages.length > 0
        ? `优先使用 ${cs.preferredLanguages.join('、')} 进行代码示例`
        : '使用用户提问时的语言进行回复',
      detailLevel: detailMap[cs.detailLevel] ?? detailMap.moderate,
      toolPreference: toolPrefs.map(p => `- ${p.key}: ${p.value}`).join('\n'),
      workHabit: workPrefs.map(p => `- ${p.key}: ${p.value}`).join('\n'),
    };
  }

  // ============ P2-1: 学习收敛测量 + 推荐准确率评估 + 持久化 + 冷启动 ============

  /**
   * P2-1: 获取学习进度 — 测量偏好学习收敛速度
   *
   * 验收标准：偏好学习 <10 次（少于 10 次交互学到偏好）
   *
   * @returns 交互次数、已学偏好数、收敛率、是否已收敛
   */
  getLearningProgress(userId: string): {
    interactionsCount: number;
    learnedPreferencesCount: number;
    convergenceRate: number;
    isConverged: boolean;
    targetInteractions: number;
  } {
    const interactionsCount = this.interactionCounts.get(userId) || 0;
    const longTerm = this.getLongTermVector(userId);
    const learnedPreferencesCount = longTerm.stablePreferences.length;
    const target = UserPreferenceEngine.CONVERGENCE_PREF_COUNT;
    const convergenceRate = Math.min(1, learnedPreferencesCount / target);
    const isConverged = learnedPreferencesCount >= target;

    return {
      interactionsCount,
      learnedPreferencesCount,
      convergenceRate,
      isConverged,
      targetInteractions: 10, // 验收标准：<10 次
    };
  }

  /**
   * P2-1: 追踪推荐 — 记录一次个性化推荐
   *
   * 在 actWithMemory() 返回偏好值后调用，记录推荐以便后续评估准确率
   *
   * @returns 推荐 ID（用于后续记录采纳结果）
   */
  trackRecommendation(
    userId: string,
    category: string,
    key: string,
    value: string,
  ): string {
    const recId = `rec_${Date.now()}_${Math.random().toString(36).substring(2, 8)}`;
    let tracker = this.recommendationTracker.get(userId);
    if (!tracker) {
      tracker = [];
      this.recommendationTracker.set(userId, tracker);
    }
    tracker.push({
      id: recId,
      category,
      key,
      value,
      adopted: null, // 待定
      timestamp: Date.now(),
    });
    return recId;
  }

  /**
   * P2-1: 记录推荐结果 — 用户是否采纳了推荐
   *
   * 推荐反馈闭环：推荐 → 用户是否采纳 → 更新命中率
   */
  recordRecommendationOutcome(userId: string, recommendationId: string, adopted: boolean): void {
    const tracker = this.recommendationTracker.get(userId);
    if (!tracker) return;
    const rec = tracker.find(r => r.id === recommendationId);
    if (rec) {
      rec.adopted = adopted;
    }
  }

  /**
   * P2-1: 评估推荐准确率
   *
   * 验收标准：个性化推荐 ≥90%
   *
   * @returns 命中率、总推荐数、命中数、是否达标
   */
  evaluateRecommendationAccuracy(userId: string): {
    hitRate: number;
    totalRecommendations: number;
    hitCount: number;
    pendingCount: number;
    meetsTarget: boolean;
    target: number;
  } {
    const tracker = this.recommendationTracker.get(userId) || [];
    const evaluated = tracker.filter(r => r.adopted !== null);
    const totalRecommendations = evaluated.length;
    const hitCount = evaluated.filter(r => r.adopted === true).length;
    const pendingCount = tracker.length - totalRecommendations;
    const hitRate = totalRecommendations > 0 ? hitCount / totalRecommendations : 0;
    const target = UserPreferenceEngine.TARGET_ACCURACY;

    return {
      hitRate,
      totalRecommendations,
      hitCount,
      pendingCount,
      meetsTarget: hitRate >= target,
      target,
    };
  }

  /**
   * P2-1: 持久化双向量状态到磁盘
   *
   * 保存双向量状态、交互计数、推荐追踪，进程重启后可恢复
   */
  persistState(filePath: string): boolean {
    try {
      const dir = path.dirname(filePath);
      if (!fs.existsSync(dir)) {
        fs.mkdirSync(dir, { recursive: true });
      }

      const state = {
        version: 1,
        savedAt: Date.now(),
        dualVectors: Array.from(this.dualVectors.entries()),
        interactionCounts: Array.from(this.interactionCounts.entries()),
        recommendationTracker: Array.from(this.recommendationTracker.entries()),
      };

      atomicWriteJsonSync(filePath, state);
      logger.info('偏好引擎状态已持久化', { module: 'UserPreferenceEngine', filePath, users: this.dualVectors.size });
      return true;
    } catch (err: any) {
      logger.error('偏好引擎状态持久化失败', { module: 'UserPreferenceEngine', error: err.message });
      return false;
    }
  }

  /**
   * P2-1: 从磁盘加载双向量状态
   */
  loadState(filePath: string): boolean {
    try {
      if (!fs.existsSync(filePath)) return false;

      const raw = fs.readFileSync(filePath, 'utf-8');
      const state = JSON.parse(raw);

      if (state.version !== 1) {
        logger.warn('偏好引擎状态版本不兼容', { module: 'UserPreferenceEngine', version: state.version });
        return false;
      }

      // 恢复双向量状态
      this.dualVectors.clear();
      for (const [userId, vec] of state.dualVectors || []) {
        this.dualVectors.set(userId, vec);
      }

      // 恢复交互计数
      this.interactionCounts.clear();
      for (const [userId, count] of state.interactionCounts || []) {
        this.interactionCounts.set(userId, count);
      }

      // 恢复推荐追踪
      this.recommendationTracker.clear();
      for (const [userId, tracker] of state.recommendationTracker || []) {
        this.recommendationTracker.set(userId, tracker);
      }

      logger.info('偏好引擎状态已加载', { module: 'UserPreferenceEngine', filePath, users: this.dualVectors.size });
      return true;
    } catch (err: any) {
      logger.error('偏好引擎状态加载失败', { module: 'UserPreferenceEngine', error: err.message });
      return false;
    }
  }

  /**
   * P2-1: 冷启动加速 — 用种子偏好初始化新用户
   *
   * 对标 PersonaAgent 的冷启动策略：
   * - 基于角色/行业预设偏好种子
   * - 跳过前 N 次探索，直接进入有效偏好区
   * - 配合 getLearningProgress() 验证 <10 次收敛
   *
   * @param userId 用户 ID
   * @param seedPreferences 种子偏好列表
   * @returns 已注入的偏好数量
   */
  bootstrapPreferences(
    userId: string,
    seedPreferences: Array<{
      category: HermesUserPreference['category'];
      key: string;
      value: string;
      strength?: number;
    }>,
  ): number {
    let injected = 0;
    for (const seed of seedPreferences) {
      this.recordSignal(userId, {
        type: 'explicit_feedback',
        category: seed.category,
        key: seed.key,
        value: seed.value,
        strength: seed.strength ?? 0.8, // 种子偏好默认高置信度
      });
      injected++;
    }
    logger.info('冷启动偏好已注入', { module: 'UserPreferenceEngine', userId, injected });
    return injected;
  }

  /**
   * P2-1: 偏好置信度衰减
   *
   * 长期未访问的偏好置信度按指数衰减，避免过时偏好影响推荐
   *
   * @param userId 用户 ID
   * @param decayFactor 衰减因子（0-1，0.9 表示衰减 10%）
   */
  decayPreferences(userId: string, decayFactor: number = 0.95): number {
    const state = this.dualVectors.get(userId);
    if (!state) return 0;

    let decayed = 0;
    const now = Date.now();
    const DECAY_PERIOD_MS = 30 * 24 * 60 * 60 * 1000; // 30 天

    for (const pref of state.longTerm.stablePreferences) {
      const ageMs = now - (pref as any).updatedAt;
      if (ageMs > DECAY_PERIOD_MS) {
        // 超过 30 天的偏好衰减置信度
        const ageCycles = Math.floor(ageMs / DECAY_PERIOD_MS);
        const adjustedConfidence = (pref.confidence ?? 0.7) * Math.pow(decayFactor, ageCycles);
        if (adjustedConfidence < LONG_TERM_CONFIDENCE_THRESHOLD) {
          // 降至阈值以下，从稳定偏好中移除
          decayed++;
        }
      }
    }

    if (decayed > 0) {
      state.longTerm.stablePreferences = state.longTerm.stablePreferences.filter(
        p => {
          const ageMs = now - (p as any).updatedAt;
          if (ageMs <= DECAY_PERIOD_MS) return true;
          const ageCycles = Math.floor(ageMs / DECAY_PERIOD_MS);
          const adjustedConfidence = (p.confidence ?? 0.7) * Math.pow(decayFactor, ageCycles);
          return adjustedConfidence >= LONG_TERM_CONFIDENCE_THRESHOLD;
        },
      );
      state.longTerm.updatedAt = now;
      logger.info('偏好置信度已衰减', { module: 'UserPreferenceEngine', userId, decayed });
    }

    return decayed;
  }

  // ============ 私有方法 ============

  private ensureState(userId: string): DualVectorState {
    let state = this.dualVectors.get(userId);
    if (!state) {
      state = {
        userId,
        longTerm: this.getLongTermVector(userId),
        shortTerm: null,
      };
      this.dualVectors.set(userId, state);
    }
    if (!state.shortTerm) {
      this.startSession(userId, `auto_${Date.now()}`);
      state = this.dualVectors.get(userId)!;
    }
    return state;
  }

  private updateHotTopics(shortTerm: ShortTermVector, topic: string): void {
    const existing = shortTerm.hotTopics.indexOf(topic);
    if (existing >= 0) {
      shortTerm.hotTopics.splice(existing, 1);
    }
    shortTerm.hotTopics.unshift(topic);
    if (shortTerm.hotTopics.length > 20) {
      shortTerm.hotTopics.length = 20;
    }
  }
}
