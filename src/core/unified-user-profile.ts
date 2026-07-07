/**
 * 统一用户画像中心 — UnifiedUserProfile
 *
 * 从 PersonalizationEngine / EmotionTracker / SelfLearningSystem / TaskSuccessTracker
 * 等多源采集数据，融合为统一的用户画像，支持需求预测和个性化推荐。
 *
 * 核心能力：
 * - 多源融合：整合认知特征、情感状态、行为模式、成功率数据
 * - 动态更新：毫秒级实时更新，5 分钟内完成全量同步
 * - 需求预测：基于 n-gram 序列模型的下一个意图预测（目标准确率 80%+）
 * - 个性化推荐：基于画像的上下文适配与服务推荐
 */

import * as fs from 'fs';
import * as path from 'path';
import { logger } from './structured-logger.js';
import { duanPath } from './duan-paths.js';
import { atomicWriteJsonSync } from './atomic-write.js';

const DEFAULT_PROFILE_DIR = duanPath('user-profiles');

export interface UnifiedUserProfile {
  userId: string;
  cognitive: {
    communicationStyle: 'formal' | 'casual' | 'technical' | 'friendly';
    expertiseLevel: 'beginner' | 'intermediate' | 'advanced' | 'expert';
    preferredLanguages: string[];
    interests: string[];
    detailLevel: 'brief' | 'moderate' | 'detailed';
    prefersCode: boolean;
    prefersStepByStep: boolean;
  };
  emotional: {
    valenceAvg: number;
    arousalAvg: number;
    dominantEmotion: string;
    frustrationLevel: number;
    lastEmotionUpdate: number;
  };
  behavioral: {
    totalInteractions: number;
    activeHours: number[];
    preferredDomains: Array<{ domain: string; count: number }>;
    avgSessionLength: number;
    peakActivityTime: string;
    commonTasks: Array<{ pattern: string; count: number }>;
  };
  performance: {
    taskSuccessRate: number;
    avgResponseTime: number;
    preferredTools: Array<{ tool: string; count: number }>;
    satisfactionScore: number;
  };
  predictions: {
    nextIntent: string;
    nextIntentConfidence: number;
    suggestedTopics: string[];
    personalizedServices: string[];
  };
  updatedAt: number;
}

export interface ProfileSyncSource {
  type: 'personalization' | 'emotion' | 'learning' | 'task_tracker';
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  data: Record<string, any>;
}

/**
 * Hermes：用户偏好条目（带置信度评分与 90 天过期机制）
 * 用于精准识别用户偏好，目标准确率 ≥90%
 */
export interface HermesUserPreference {
  /** 偏好类别 */
  category: 'programming_language' | 'work_habit' | 'communication_style' | 'tool_preference' | 'detail_level' | 'expertise_level';
  /** 偏好键名 */
  key: string;
  /** 偏好值 */
  value: string;
  /** 置信度评分 0-1（出现次数越多、来源越权威则越高） */
  confidence: number;
  /** 创建时间戳 */
  createdAt: number;
  /** 最后确认时间戳 */
  lastConfirmedAt: number;
  /** 过期时间戳（默认 90 天） */
  expiresAt: number;
  /** 确认次数（每次再次出现则 +1） */
  confirmCount: number;
  /** 来源（user/agent/system） */
  source: string;
}

export interface PredictionRecord {
  predicted: string;
  actual: string;
  correct: boolean;
  timestamp: number;
}

export interface ServiceFeedback {
  serviceName: string;
  rating: number;
  timestamp: number;
}

export interface RecommendationStats {
  totalRecommendations: number;
  totalFeedback: number;
  avgRating: number;
  serviceStats: Array<{
    serviceName: string;
    recommendedCount: number;
    feedbackCount: number;
    avgRating: number;
    lastRecommended: number;
  }>;
}

export interface PredictionAccuracyReport {
  globalAccuracy: number;
  accuracyTarget: number;
  accuracyMet: boolean;
  totalPredictions: number;
  correctPredictions: number;
  userReports: Array<{
    userId: string;
    total: number;
    correct: number;
    accuracy: number;
    recentHistory: PredictionRecord[];
  }>;
}

export class UnifiedUserProfileCenter {
  private log = logger.child({ module: 'UnifiedUserProfileCenter' });
  private profiles: Map<string, UnifiedUserProfile> = new Map();
  private intentHistory: Map<string, string[]> = new Map();
  private predictionStats: Map<string, { total: number; correct: number; history: PredictionRecord[] }> = new Map();
  private readonly MAX_HISTORY = 200;
  private readonly PREDICT_NGRAM = 3;
  private recFeedback: Map<string, ServiceFeedback[]> = new Map();
  private readonly ACCURACY_TARGET = 0.80;
  private readonly STALE_DAYS = 28;
  private evolutionHistory: Map<string, Array<{ timestamp: number; snapshot: Partial<UnifiedUserProfile>; reason: string }>> = new Map();
  private dreamTimer: ReturnType<typeof setInterval> | null = null;

  /** 画像持久化目录（支持依赖注入，测试时传入临时目录避免读取大量历史文件） */
  private readonly profileDir: string;

  /** Hermes：用户偏好存储（userId → 偏好键 → 偏好条目） */
  private hermesPreferences: Map<string, Map<string, HermesUserPreference>> = new Map();

  /** Hermes：偏好默认有效期 90 天 */
  private readonly PREFERENCE_TTL_MS = 90 * 24 * 60 * 60 * 1000;

  /** Hermes：偏好置信度阈值（≥0.6 视为高置信度） */
  private readonly PREFERENCE_CONFIDENCE_THRESHOLD = 0.6;

  /** Hermes：偏好置信度单次确认增量 */
  private readonly PREFERENCE_CONFIDENCE_INCREMENT = 0.15;

  /** Hermes：偏好置信度上限 */
  private readonly PREFERENCE_CONFIDENCE_MAX = 1.0;

  /** Hermes：偏好识别准确率目标 ≥90% */
  private readonly PREFERENCE_ACCURACY_TARGET = 0.9;

  constructor(options?: { dataDir?: string }) {
    this.profileDir = options?.dataDir
      ? path.join(options.dataDir, 'user-profiles')
      : DEFAULT_PROFILE_DIR;
    fs.mkdirSync(this.profileDir, { recursive: true });
    this.loadState();
    this.startDreaming();
  }

  private startDreaming(): void {
    this.dreamTimer = setInterval(() => this.dreamCycle(), 300000);
  }

  stop(): void {
    if (this.dreamTimer) {
      clearInterval(this.dreamTimer);
      this.dreamTimer = null;
    }
  }

  private dreamCycle(): void {
    for (const [userId, profile] of this.profiles) {
      try {
        let changed = false;
        const now = Date.now();
        const staleThreshold = this.STALE_DAYS * 24 * 60 * 60 * 1000;

        if (profile.updatedAt && (now - profile.updatedAt > staleThreshold)) {
          profile.performance.satisfactionScore *= 0.95;
          profile.predictions.nextIntentConfidence *= 0.9;
          changed = true;
        }

        const oldInterests = profile.cognitive.interests.filter(i => {
          const taskRefs = profile.behavioral.commonTasks.filter(t =>
            t.pattern.toLowerCase().includes(i.toLowerCase())
          );
          return taskRefs.length === 0;
        });
        if (oldInterests.length > profile.cognitive.interests.length / 2) {
          profile.cognitive.interests = profile.cognitive.interests.filter(i =>
            !oldInterests.includes(i)
          );
          changed = true;
        }

        const oldDomains = profile.behavioral.preferredDomains
          .filter(d => d.count < 2);
        if (oldDomains.length > 0) {
          profile.behavioral.preferredDomains = profile.behavioral.preferredDomains
            .filter(d => !oldDomains.includes(d));
          changed = true;
        }

        const oldTasks = profile.behavioral.commonTasks
          .filter(t => t.count < 2);
        if (oldTasks.length > 0) {
          profile.behavioral.commonTasks = profile.behavioral.commonTasks
            .filter(t => !oldTasks.includes(t));
          changed = true;
        }

        profile.cognitive.interests.sort((a, b) => {
          const aCount = profile.behavioral.commonTasks.filter(t => t.pattern.includes(a)).length;
          const bCount = profile.behavioral.commonTasks.filter(t => t.pattern.includes(b)).length;
          return bCount - aCount;
        });

        if (changed) {
          profile.updatedAt = now;
          this.persistProfile(userId);
        }
      } catch {}
    }
  }

  getProfile(userId: string): UnifiedUserProfile {
    let profile = this.profiles.get(userId);
    if (!profile) {
      profile = this.createDefault(userId);
      this.profiles.set(userId, profile);
    }
    return profile;
  }

  syncFromSource(userId: string, source: ProfileSyncSource): void {
    const profile = this.getProfile(userId);
    const d = source.data;
    switch (source.type) {
      case 'personalization': {
        let changed = false;
        if (d.communicationStyle) {
          const oldStyle = profile.cognitive.communicationStyle;
          if (oldStyle !== d.communicationStyle) {
            this.log.info('用户沟通风格更新', { from: oldStyle, to: d.communicationStyle });
            changed = true;
          }
          profile.cognitive.communicationStyle = d.communicationStyle;
        }
        if (d.expertiseLevel) {
          if (d.expertiseLevel !== profile.cognitive.expertiseLevel) {
            profile.cognitive.expertiseLevel = d.expertiseLevel;
            changed = true;
            const levelOrder = ['beginner', 'intermediate', 'advanced', 'expert'];
            const oldIdx = levelOrder.indexOf(profile.cognitive.expertiseLevel);
            const newIdx = levelOrder.indexOf(d.expertiseLevel);
            if (newIdx > oldIdx) profile.performance.satisfactionScore = Math.min(1, profile.performance.satisfactionScore + 0.05);
          }
        }
        if (d.preferredLanguages) {
          const oldLangs = [...profile.cognitive.preferredLanguages];
          for (const lang of d.preferredLanguages as string[]) {
            if (!profile.cognitive.preferredLanguages.includes(lang)) {
              profile.cognitive.preferredLanguages.push(lang);
            }
          }
          profile.cognitive.preferredLanguages = profile.cognitive.preferredLanguages.filter(l =>
            d.preferredLanguages.includes(l) || profile.behavioral.commonTasks.some(t => t.pattern.includes(l))
          );
          if (JSON.stringify(oldLangs) !== JSON.stringify(profile.cognitive.preferredLanguages)) changed = true;
        }
        if (d.interests) {
          const oldInterests = new Set(profile.cognitive.interests);
          for (const interest of d.interests as string[]) {
            if (!oldInterests.has(interest)) {
              this.log.info('发现新兴趣', { interest });
              changed = true;
            }
            if (!profile.cognitive.interests.includes(interest)) {
              profile.cognitive.interests.push(interest);
            }
          }
          profile.cognitive.interests = profile.cognitive.interests.filter(i =>
            d.interests.includes(i) || profile.behavioral.commonTasks.some(t => t.pattern.includes(i))
          );
        }
        if (d.detailLevel) profile.cognitive.detailLevel = d.detailLevel;
        if (d.prefersCode !== undefined) profile.cognitive.prefersCode = d.prefersCode;
        if (changed) this.recordEvolution(userId, 'personalization 数据同步');
        break;
      }
      case 'emotion': {
        if (d.valenceAvg !== undefined) profile.emotional.valenceAvg = d.valenceAvg;
        if (d.arousalAvg !== undefined) profile.emotional.arousalAvg = d.arousalAvg;
        if (d.dominantEmotion) profile.emotional.dominantEmotion = d.dominantEmotion;
        if (d.frustrationLevel !== undefined) profile.emotional.frustrationLevel = d.frustrationLevel;
        profile.emotional.lastEmotionUpdate = Date.now();
        break;
      }
      case 'learning': {
        if (d.interests) {
          for (const interest of d.interests as string[]) {
            if (!profile.cognitive.interests.includes(interest)) {
              profile.cognitive.interests.push(interest);
            }
          }
        }
        if (d.preferredLanguages) {
          for (const lang of d.preferredLanguages as string[]) {
            if (!profile.cognitive.preferredLanguages.includes(lang)) {
              profile.cognitive.preferredLanguages.push(lang);
            }
          }
        }
        break;
      }
      case 'task_tracker': {
        if (d.successRate !== undefined) profile.performance.taskSuccessRate = d.successRate;
        if (d.avgResponseTime !== undefined) profile.performance.avgResponseTime = d.avgResponseTime;
        if (d.satisfactionScore !== undefined) profile.performance.satisfactionScore = d.satisfactionScore;
        if (d.tools) profile.performance.preferredTools = d.tools;
        if (d.domains) profile.behavioral.preferredDomains = d.domains;
        if (d.totalInteractions !== undefined) profile.behavioral.totalInteractions = d.totalInteractions;
        break;
      }
    }
    profile.updatedAt = Date.now();
    this.persistProfile(userId);
    this.runPrediction(userId);
  }

  recordIntent(userId: string, intent: string): void {
    const profile = this.getProfile(userId);
    const predicted = profile.predictions.nextIntent;
    const correct = predicted === intent;
    const stats = this.predictionStats.get(userId) || { total: 0, correct: 0, history: [] };
    stats.total++;
    if (correct) stats.correct++;
    stats.history.push({ predicted, actual: intent, correct, timestamp: Date.now() });
    if (stats.history.length > 50) stats.history = stats.history.slice(-50);
    this.predictionStats.set(userId, stats);
    if (correct) {
      this.log.info('意图预测正确', { userId, predicted, confidence: profile.predictions.nextIntentConfidence });
    }
    this.persistPredictionStats();

    const history = this.intentHistory.get(userId) || [];
    history.push(intent);
    if (history.length > this.MAX_HISTORY) history.shift();
    this.intentHistory.set(userId, history);
    this.runPrediction(userId);
  }

  recordTaskResult(userId: string, taskDescription: string, success: boolean, toolsUsed: string[], duration: number): void {
    const profile = this.getProfile(userId);
    profile.behavioral.totalInteractions++;
    const total = profile.performance.taskSuccessRate * (profile.behavioral.totalInteractions - 1) + (success ? 1 : 0);
    profile.performance.taskSuccessRate = profile.behavioral.totalInteractions > 0
      ? total / profile.behavioral.totalInteractions : 0;
    profile.performance.avgResponseTime = profile.performance.avgResponseTime > 0
      ? (profile.performance.avgResponseTime * 0.8 + duration * 0.2) : duration;

    const existingTool = profile.performance.preferredTools.find(t => t.tool === toolsUsed[0]);
    if (existingTool) existingTool.count++;
    else if (toolsUsed[0]) profile.performance.preferredTools.push({ tool: toolsUsed[0], count: 1 });

    const existingDomain = profile.behavioral.preferredDomains.find(d =>
      taskDescription.includes(d.domain));
    if (existingDomain) existingDomain.count++;
    else if (taskDescription.length > 3)
      {profile.behavioral.preferredDomains.push({ domain: taskDescription.substring(0, 20), count: 1 });}

    const existingTask = profile.behavioral.commonTasks.find(t =>
      taskDescription.toLowerCase().includes(t.pattern.toLowerCase()));
    if (existingTask) existingTask.count++;
    else profile.behavioral.commonTasks.push({ pattern: taskDescription.substring(0, 30), count: 1 });

    profile.updatedAt = Date.now();
    this.persistProfile(userId);
  }

  // ============ Hermes 用户偏好精准识别 ============

  /**
   * Hermes：记录用户偏好（带置信度评分与 90 天过期）
   * 若偏好已存在则提升置信度，否则新建
   */
  recordHermesPreference(
    userId: string,
    category: HermesUserPreference['category'],
    key: string,
    value: string,
    options?: { confidence?: number; source?: string }
  ): HermesUserPreference {
    const now = Date.now();
    const prefKey = `${category}:${key}`;

    // 获取该用户的偏好存储
    if (!this.hermesPreferences.has(userId)) {
      this.hermesPreferences.set(userId, new Map());
    }
    const userPrefs = this.hermesPreferences.get(userId)!;
    const existing = userPrefs.get(prefKey);

    if (existing) {
      // 已存在：提升置信度，刷新过期时间
      existing.value = value;
      existing.confirmCount++;
      existing.lastConfirmedAt = now;
      existing.expiresAt = now + this.PREFERENCE_TTL_MS;
      existing.confidence = Math.min(
        this.PREFERENCE_CONFIDENCE_MAX,
        existing.confidence + this.PREFERENCE_CONFIDENCE_INCREMENT
      );
      return existing;
    }

    // 新建偏好
    const initialConfidence = options?.confidence ?? this.PREFERENCE_CONFIDENCE_INCREMENT;
    const pref: HermesUserPreference = {
      category,
      key,
      value,
      confidence: Math.min(this.PREFERENCE_CONFIDENCE_MAX, Math.max(0, initialConfidence)),
      createdAt: now,
      lastConfirmedAt: now,
      expiresAt: now + this.PREFERENCE_TTL_MS,
      confirmCount: 1,
      source: options?.source ?? 'user',
    };
    userPrefs.set(prefKey, pref);
    return pref;
  }

  /**
   * Hermes：获取用户偏好（带过期与置信度校验）
   */
  getHermesPreference(
    userId: string,
    category: HermesUserPreference['category'],
    key: string,
    minConfidence?: number
  ): HermesUserPreference | null {
    const prefKey = `${category}:${key}`;
    const userPrefs = this.hermesPreferences.get(userId);
    if (!userPrefs) return null;

    const pref = userPrefs.get(prefKey);
    if (!pref) return null;

    // 过期校验
    if (Date.now() > pref.expiresAt) {
      userPrefs.delete(prefKey);
      return null;
    }

    // 置信度校验
    const threshold = minConfidence ?? this.PREFERENCE_CONFIDENCE_THRESHOLD;
    if (pref.confidence < threshold) return null;

    return pref;
  }

  /**
   * Hermes：获取所有高置信度用户偏好（用于主动注入）
   */
  getHighConfidencePreferences(userId: string, minConfidence?: number): HermesUserPreference[] {
    const threshold = minConfidence ?? this.PREFERENCE_CONFIDENCE_THRESHOLD;
    const userPrefs = this.hermesPreferences.get(userId);
    if (!userPrefs) return [];

    const now = Date.now();
    const results: HermesUserPreference[] = [];
    for (const [key, pref] of userPrefs) {
      if (now > pref.expiresAt) {
        userPrefs.delete(key);
        continue;
      }
      if (pref.confidence >= threshold) {
        results.push(pref);
      }
    }
    return results.sort((a, b) => b.confidence - a.confidence);
  }

  /**
   * Hermes：从对话文本中自动提取用户偏好
   * 识别编程语言、工作习惯、沟通风格等，目标准确率 ≥90%
   * 返回新提取的偏好列表
   */
  extractPreferencesFromConversation(userId: string, text: string): HermesUserPreference[] {
    const extracted: HermesUserPreference[] = [];

    // 1. 编程语言识别
    const langPatterns: Array<{ lang: string; patterns: RegExp[] }> = [
      { lang: 'TypeScript', patterns: [/typescript/i, /\.ts\b/, /\bts\b/i] },
      { lang: 'JavaScript', patterns: [/javascript/i, /\.js\b/, /\bjs\b/i] },
      { lang: 'Python', patterns: [/python/i, /\.py\b/] },
      { lang: 'Go', patterns: [/\bgolang\b/i, /\.go\b/] },
      { lang: 'Rust', patterns: [/rust/i, /\.rs\b/] },
      { lang: 'Java', patterns: [/java/i, /\.java\b/] },
    ];
    for (const { lang, patterns } of langPatterns) {
      if (patterns.some(p => p.test(text))) {
        extracted.push(this.recordHermesPreference(userId, 'programming_language', 'primary', lang));
      }
    }

    // 2. 沟通风格识别
    if (/简洁|简短|直接|brief|concise/i.test(text)) {
      extracted.push(this.recordHermesPreference(userId, 'communication_style', 'detail_level', 'brief'));
    }
    if (/详细|完整|详尽|detailed|comprehensive/i.test(text)) {
      extracted.push(this.recordHermesPreference(userId, 'communication_style', 'detail_level', 'detailed'));
    }
    if (/代码示例|用代码|show code|code example/i.test(text)) {
      extracted.push(this.recordHermesPreference(userId, 'communication_style', 'prefers_code', 'true'));
    }
    if (/分步|步骤|step by step/i.test(text)) {
      extracted.push(this.recordHermesPreference(userId, 'communication_style', 'prefers_step_by_step', 'true'));
    }

    // 3. 专业水平识别
    if (/我是新手|初学者|beginner|不熟悉/i.test(text)) {
      extracted.push(this.recordHermesPreference(userId, 'expertise_level', 'self_assessed', 'beginner'));
    }
    if (/我是专家|资深|expert|advanced/i.test(text)) {
      extracted.push(this.recordHermesPreference(userId, 'expertise_level', 'self_assessed', 'expert'));
    }

    // 4. 工作习惯识别
    if (/测试驱动|TDD|test driven/i.test(text)) {
      extracted.push(this.recordHermesPreference(userId, 'work_habit', 'development_approach', 'TDD'));
    }
    if (/代码审查|code review|PR review/i.test(text)) {
      extracted.push(this.recordHermesPreference(userId, 'work_habit', 'review_practice', 'code_review'));
    }

    // 5. 工具偏好识别
    if (/vscode|visual studio code/i.test(text)) {
      extracted.push(this.recordHermesPreference(userId, 'tool_preference', 'editor', 'VSCode'));
    }
    if (/git\b/i.test(text)) {
      extracted.push(this.recordHermesPreference(userId, 'tool_preference', 'vcs', 'Git'));
    }
    if (/docker/i.test(text)) {
      extracted.push(this.recordHermesPreference(userId, 'tool_preference', 'containerization', 'Docker'));
    }

    return extracted;
  }

  /**
   * Hermes：清理过期用户偏好（超过 90 天未确认）
   */
  cleanExpiredPreferences(userId?: string): number {
    const now = Date.now();
    let cleaned = 0;

    const userIds = userId ? [userId] : Array.from(this.hermesPreferences.keys());
    for (const uid of userIds) {
      const userPrefs = this.hermesPreferences.get(uid);
      if (!userPrefs) continue;

      const expiredKeys: string[] = [];
      for (const [key, pref] of userPrefs) {
        if (now > pref.expiresAt) {
          expiredKeys.push(key);
        }
      }
      for (const key of expiredKeys) {
        userPrefs.delete(key);
        cleaned++;
      }
    }

    return cleaned;
  }

  /**
   * Hermes：获取偏好识别准确率报告
   */
  getPreferenceAccuracyReport(userId?: string): {
    totalPreferences: number;
    highConfidenceCount: number;
    averageConfidence: number;
    accuracyTarget: number;
    accuracyMet: boolean;
  } {
    const allPrefs: HermesUserPreference[] = [];
    const userIds = userId ? [userId] : Array.from(this.hermesPreferences.keys());
    const now = Date.now();

    for (const uid of userIds) {
      const userPrefs = this.hermesPreferences.get(uid);
      if (!userPrefs) continue;
      for (const [, pref] of userPrefs) {
        if (now <= pref.expiresAt) {
          allPrefs.push(pref);
        }
      }
    }

    const highConfidenceCount = allPrefs.filter(p => p.confidence >= this.PREFERENCE_CONFIDENCE_THRESHOLD).length;
    const averageConfidence = allPrefs.length > 0
      ? allPrefs.reduce((sum, p) => sum + p.confidence, 0) / allPrefs.length
      : 0;

    // 准确率近似：高置信度偏好占比作为准确率指标
    const accuracy = allPrefs.length > 0 ? highConfidenceCount / allPrefs.length : 0;

    return {
      totalPreferences: allPrefs.length,
      highConfidenceCount,
      averageConfidence: Math.round(averageConfidence * 100) / 100,
      accuracyTarget: this.PREFERENCE_ACCURACY_TARGET,
      accuracyMet: accuracy >= this.PREFERENCE_ACCURACY_TARGET,
    };
  }

  private runPrediction(userId: string): void {
    const profile = this.getProfile(userId);
    const history = this.intentHistory.get(userId) || [];
    if (history.length < 2) {
      profile.predictions.nextIntent = history[0] || 'general_chat';
      profile.predictions.nextIntentConfidence = 0.3;
      profile.predictions.suggestedTopics = profile.cognitive.interests.slice(0, 3);
      profile.predictions.personalizedServices = this.suggestServices(profile);
      return;
    }
    const ngram = this.buildNGram(history, this.PREDICT_NGRAM);
    const lastN = history.slice(-(this.PREDICT_NGRAM - 1));
    const candidates = ngram.get(lastN.join('|'));
    if (candidates && candidates.length > 0) {
      const total = candidates.reduce((s, c) => s + c.count, 0);
      const top = candidates.sort((a, b) => b.count - a.count)[0];
      profile.predictions.nextIntent = top.intent;
      profile.predictions.nextIntentConfidence = top.count / total;
    } else {
      profile.predictions.nextIntent = history[history.length - 1];
      profile.predictions.nextIntentConfidence = 0.4;
    }
    profile.predictions.suggestedTopics = this.suggestTopics(profile, history);
    profile.predictions.personalizedServices = this.suggestServices(profile);
  }

  private buildNGram(history: string[], n: number): Map<string, Array<{ intent: string; count: number }>> {
    const ngram = new Map<string, Array<{ intent: string; count: number }>>();
    for (let i = 0; i <= history.length - n; i++) {
      const key = history.slice(i, i + n - 1).join('|');
      const next = history[i + n - 1];
      const existing = ngram.get(key) || [];
      const found = existing.find(e => e.intent === next);
      if (found) found.count++;
      else existing.push({ intent: next, count: 1 });
      ngram.set(key, existing);
    }
    return ngram;
  }

  private suggestTopics(profile: UnifiedUserProfile, history: string[]): string[] {
    const topics = new Set<string>();
    for (const interest of profile.cognitive.interests) topics.add(interest);
    const recentIntents = history.slice(-10);
    for (const intent of recentIntents) {
      if (intent.length > 3 && intent.length < 30) topics.add(intent);
    }
    const topDomains = profile.behavioral.preferredDomains
      .sort((a, b) => b.count - a.count).slice(0, 3);
    for (const d of topDomains) topics.add(d.domain);
    return Array.from(topics).slice(0, 5);
  }

  private suggestServices(profile: UnifiedUserProfile): string[] {
    const lowRated = this.getLowRatedServices();
    const services: string[] = [];
    const interests = profile.cognitive.interests;
    if (interests.some(i => /code|program|develop|script/i.test(i))) {
      if (!lowRated.has('代码审查')) services.push('代码审查');
      if (!lowRated.has('自动重构')) services.push('自动重构');
      if (!lowRated.has('测试生成')) services.push('测试生成');
    }
    if (interests.some(i => /data|analytics|report|visual/i.test(i))) {
      if (!lowRated.has('数据分析')) services.push('数据分析');
      if (!lowRated.has('报告生成')) services.push('报告生成');
      if (!lowRated.has('图表制作')) services.push('图表制作');
    }
    if (interests.some(i => /write|doc|article|content/i.test(i))) {
      if (!lowRated.has('文档生成')) services.push('文档生成');
      if (!lowRated.has('文章润色')) services.push('文章润色');
      if (!lowRated.has('翻译')) services.push('翻译');
    }
    if (interests.some(i => /design|ui|ux|creative/i.test(i))) {
      if (!lowRated.has('UI设计建议')) services.push('UI设计建议');
      if (!lowRated.has('配色方案')) services.push('配色方案');
      if (!lowRated.has('原型生成')) services.push('原型生成');
    }
    if (profile.emotional.frustrationLevel > 0.6) {
      if (!lowRated.has('分步引导')) services.push('分步引导');
      if (!lowRated.has('错误排查')) services.push('错误排查');
    }
    if (profile.performance.taskSuccessRate < 0.7) {
      if (!lowRated.has('任务简化')) services.push('任务简化');
      if (!lowRated.has('模板复用')) services.push('模板复用');
    }
    return services.slice(0, 5);
  }

  private createDefault(userId: string): UnifiedUserProfile {
    return {
      userId,
      cognitive: {
        communicationStyle: 'friendly',
        expertiseLevel: 'intermediate',
        preferredLanguages: ['中文', 'English'],
        interests: [],
        detailLevel: 'moderate',
        prefersCode: false,
        prefersStepByStep: false,
      },
      emotional: {
        valenceAvg: 0.5, arousalAvg: 0.5, dominantEmotion: 'neutral',
        frustrationLevel: 0, lastEmotionUpdate: 0,
      },
      behavioral: {
        totalInteractions: 0, activeHours: [], preferredDomains: [],
        avgSessionLength: 0, peakActivityTime: 'unknown', commonTasks: [],
      },
      performance: {
        taskSuccessRate: 0, avgResponseTime: 0, preferredTools: [],
        satisfactionScore: 0,
      },
      predictions: {
        nextIntent: 'general_chat', nextIntentConfidence: 0.3,
        suggestedTopics: [], personalizedServices: [],
      },
      updatedAt: Date.now(),
    };
  }

  getPredictionAccuracy(userId?: string): { total: number; correct: number; accuracy: number; history: PredictionRecord[] } {
    if (userId) {
      const stats = this.predictionStats.get(userId);
      return stats
        ? { ...stats, accuracy: stats.total > 0 ? stats.correct / stats.total : 0 }
        : { total: 0, correct: 0, accuracy: 0, history: [] };
    }
    let total = 0, correct = 0;
    for (const s of this.predictionStats.values()) { total += s.total; correct += s.correct; }
    return { total, correct, accuracy: total > 0 ? correct / total : 0, history: [] };
  }

  getPredictionAccuracyReport(): PredictionAccuracyReport {
    const global = this.getPredictionAccuracy();
    const userReports: PredictionAccuracyReport['userReports'] = [];
    for (const [userId, stats] of this.predictionStats) {
      userReports.push({
        userId,
        total: stats.total,
        correct: stats.correct,
        accuracy: stats.total > 0 ? stats.correct / stats.total : 0,
        recentHistory: stats.history.slice(-10),
      });
    }
    userReports.sort((a, b) => b.total - a.total);
    return {
      globalAccuracy: global.accuracy,
      accuracyTarget: this.ACCURACY_TARGET,
      accuracyMet: global.accuracy >= this.ACCURACY_TARGET,
      totalPredictions: global.total,
      correctPredictions: global.correct,
      userReports,
    };
  }

  recordRecommendationFeedback(userId: string, serviceName: string, rating: number): void {
    const clamped = Math.max(0, Math.min(5, rating));
    const list = this.recFeedback.get(userId) || [];
    list.push({ serviceName, rating: clamped, timestamp: Date.now() });
    if (list.length > 100) list.splice(0, list.length - 100);
    this.recFeedback.set(userId, list);
    this.persistRecFeedback();
    this.log.info('推荐反馈已记录', { userId, serviceName, rating: clamped });
  }

  getRecommendationStats(): RecommendationStats {
    const serviceMap = new Map<string, { recommended: number; ratings: number[]; lastTs: number }>();
    for (const [, list] of this.recFeedback) {
      for (const fb of list) {
        const s = serviceMap.get(fb.serviceName) || { recommended: 0, ratings: [], lastTs: 0 };
        s.recommended++;
        s.ratings.push(fb.rating);
        if (fb.timestamp > s.lastTs) s.lastTs = fb.timestamp;
        serviceMap.set(fb.serviceName, s);
      }
    }
    let totalRating = 0, totalCount = 0;
    const serviceStats: RecommendationStats['serviceStats'] = [];
    for (const [name, s] of serviceMap) {
      const avg = s.ratings.reduce((a, b) => a + b, 0) / s.ratings.length;
      totalRating += s.ratings.reduce((a, b) => a + b, 0);
      totalCount += s.ratings.length;
      serviceStats.push({ serviceName: name, recommendedCount: s.recommended, feedbackCount: s.ratings.length, avgRating: avg, lastRecommended: s.lastTs });
    }
    serviceStats.sort((a, b) => b.recommendedCount - a.recommendedCount);
    const allFeedback: ServiceFeedback[] = [];
    for (const [, list] of this.recFeedback) allFeedback.push(...list);
    return {
      totalRecommendations: serviceStats.reduce((s, x) => s + x.recommendedCount, 0),
      totalFeedback: totalCount,
      avgRating: totalCount > 0 ? totalRating / totalCount : 0,
      serviceStats,
    };
  }

  private getLowRatedServices(): Set<string> {
    const lowRated = new Set<string>();
    for (const [, list] of this.recFeedback) {
      const byService = new Map<string, number[]>();
      for (const fb of list) {
        const arr = byService.get(fb.serviceName) || [];
        arr.push(fb.rating);
        byService.set(fb.serviceName, arr);
      }
      for (const [name, ratings] of byService) {
        const avg = ratings.reduce((a, b) => a + b, 0) / ratings.length;
        if (avg < 2 && ratings.length >= 2) lowRated.add(name);
      }
    }
    return lowRated;
  }

  recordEvolution(userId: string, reason: string): void {
    const profile = this.getProfile(userId);
    const history = this.evolutionHistory.get(userId) || [];
    const snapshot: Partial<UnifiedUserProfile> = {
      cognitive: { ...profile.cognitive },
      emotional: { ...profile.emotional },
      behavioral: {
        ...profile.behavioral,
        preferredDomains: profile.behavioral.preferredDomains.slice(0, 5),
        commonTasks: profile.behavioral.commonTasks.slice(0, 5),
      },
      performance: {
        ...profile.performance,
        preferredTools: profile.performance.preferredTools.slice(0, 5),
      },
      updatedAt: profile.updatedAt,
    };
    history.push({ timestamp: Date.now(), snapshot, reason });
    if (history.length > 50) history.shift();
    this.evolutionHistory.set(userId, history);
  }

  getEvolutionHistory(userId: string, limit: number = 10): Array<{ timestamp: number; snapshot: Partial<UnifiedUserProfile>; reason: string }> {
    return (this.evolutionHistory.get(userId) || []).slice(-limit);
  }

  formatEvolutionSummary(userId: string): string {
    const profile = this.getProfile(userId);
    const stats = this.predictionStats.get(userId);
    const accuracy = stats && stats.total > 0 ? ((stats.correct / stats.total) * 100).toFixed(1) : 'N/A';
    const topInterest = profile.cognitive.interests.slice(0, 3).join(', ') || '待发现';
    const topTool = profile.performance.preferredTools.sort((a, b) => b.count - a.count).slice(0, 2).map(t => t.tool).join(', ') || '待发现';
    const topTask = profile.behavioral.commonTasks.sort((a, b) => b.count - a.count).slice(0, 2).map(t => t.pattern).join(', ') || '待发现';
    return [
      '📊 用户画像动态进化',
      `  兴趣: ${topInterest}`,
      `  常用工具: ${topTool}`,
      `  常用任务: ${topTask}`,
      `  意图预测准确率: ${accuracy}%`,
      `  交互次数: ${profile.behavioral.totalInteractions}`,
      `  成功率: ${(profile.performance.taskSuccessRate * 100).toFixed(0)}%`,
    ].join('\n');
  }

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  getToolDefinitions(): Array<{ name: string; description: string; parameters: Record<string, any>; execute: (args: any) => any; readOnly?: boolean }> {
    return [
      {
        name: 'user_profile',
        description: '获取当前用户的完整画像，包含认知特征、情感状态、行为模式和需求预测',
        parameters: {
          userId: { type: 'string', description: '用户ID(默认当前用户)', required: false },
        },
        execute: (args) => {
          const profile = this.getProfile(args.userId || 'default');
          return JSON.stringify(profile, null, 2);
        },
      },
      {
        name: 'user_predict',
        description: '预测用户的下一个意图和推荐服务',
        parameters: {
          userId: { type: 'string', description: '用户ID(默认当前用户)', required: false },
        },
        execute: (args) => {
          const profile = this.getProfile(args.userId || 'default');
          return JSON.stringify(profile.predictions, null, 2);
        },
      },
      {
        name: 'user_sync_profile',
        description: '从各子系统同步数据到统一用户画像',
        parameters: {
          userId: { type: 'string', description: '用户ID', required: true },
          sourceType: { type: 'string', description: '数据源: personalization/emotion/learning/task_tracker', required: true },
          data: { type: 'object', description: '源数据', required: true },
        },
        execute: (args) => {
          this.syncFromSource(args.userId, { type: args.sourceType, data: args.data });
          return '✅ 画像已同步';
        },
      },
      {
        name: 'user_rec_feedback',
        description: '记录用户对推荐服务的反馈评分',
        parameters: {
          userId: { type: 'string', description: '用户ID', required: true },
          serviceName: { type: 'string', description: '服务名称', required: true },
          rating: { type: 'number', description: '评分(0-5，0=不喜欢，5=非常喜欢)', required: true },
        },
        execute: (args) => {
          this.recordRecommendationFeedback(args.userId, args.serviceName, args.rating);
          return '✅ 推荐反馈已记录';
        },
      },
      {
        name: 'user_evolution',
        description: '查看用户画像的进化轨迹 — 展示偏好、兴趣、行为随时间的变化历史',
        parameters: {
          userId: { type: 'string', description: '用户ID(默认当前用户)', required: false },
          limit: { type: 'number', description: '显示最近N条变化(默认10)', required: false },
        },
        readOnly: true,
        execute: (args) => {
          const userId = args.userId || 'default';
          const limit = Number(args.limit) || 10;
          const history = this.getEvolutionHistory(userId, limit);
          if (history.length === 0) return '暂无进化历史记录';
          const lines = ['📈 用户画像进化轨迹'];
          for (const h of history) {
            const date = new Date(h.timestamp).toLocaleString('zh-CN');
            lines.push(`--- ${date} ---`);
            lines.push(`  原因: ${h.reason}`);
            if (h.snapshot.cognitive) {
              const c = h.snapshot.cognitive;
              lines.push(`  风格: ${c.communicationStyle} | 兴趣: ${(c.interests || []).slice(0, 3).join(', ')}`);
              lines.push(`  专业度: ${c.expertiseLevel} | 详细度: ${c.detailLevel}`);
            }
            if (h.snapshot.performance) {
              const p = h.snapshot.performance;
              lines.push(`  成功率: ${((p.taskSuccessRate || 0) * 100).toFixed(0)}% | 满意度: ${((p.satisfactionScore || 0) * 100).toFixed(0)}%`);
            }
          }
          return lines.join('\n');
        },
      },
    ];
  }

  private persistProfile(userId: string): void {
    try {
      const profile = this.profiles.get(userId);
      if (!profile) return;
      const filePath = path.join(this.profileDir, `${userId}.json`);
      const tmp = filePath + '.' + process.pid + '.tmp';
      fs.writeFileSync(tmp, JSON.stringify(profile, null, 2), 'utf-8');
      fs.renameSync(tmp, filePath);
    } catch { this.log.warn('用户画像持久化失败', { userId }); }
  }

  private loadState(): void {
    try {
      if (!fs.existsSync(this.profileDir)) return;
      const files = fs.readdirSync(this.profileDir).filter(f => f.endsWith('.json') && f !== 'registry.json');
      for (const file of files) {
        try {
          const userId = file.replace('.json', '');
          const data = JSON.parse(fs.readFileSync(path.join(this.profileDir, file), 'utf-8'));
          this.profiles.set(userId, data);
        } catch {}
      }
      const statsPath = path.join(this.profileDir, 'prediction-stats.json');
      if (fs.existsSync(statsPath)) {
        const raw = JSON.parse(fs.readFileSync(statsPath, 'utf-8'));
        for (const [userId, stats] of Object.entries(raw)) {
          this.predictionStats.set(userId, stats as { total: number; correct: number; history: PredictionRecord[] });
        }
      }
      const recPath = path.join(this.profileDir, 'rec-feedback.json');
      if (fs.existsSync(recPath)) {
        const raw = JSON.parse(fs.readFileSync(recPath, 'utf-8'));
        for (const [userId, list] of Object.entries(raw)) {
          this.recFeedback.set(userId, list as ServiceFeedback[]);
        }
      }
      this.log.info('用户画像已加载', { count: this.profiles.size });
    } catch {}
  }

  private persistRecFeedback(): void {
    try {
      const obj: Record<string, unknown> = {};
      for (const [userId, list] of this.recFeedback) {
        obj[userId] = list;
      }
      atomicWriteJsonSync(path.join(this.profileDir, 'rec-feedback.json'), obj);
    } catch {}
  }

  private persistPredictionStats(): void {
    try {
      const obj: Record<string, unknown> = {};
      for (const [userId, stats] of this.predictionStats) {
        obj[userId] = stats;
      }
      atomicWriteJsonSync(path.join(this.profileDir, 'prediction-stats.json'), obj);
    } catch {}
  }
}
