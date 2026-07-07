/**
 * 「段先生」人格引擎 — DuanPersonaEngine
 *
 * 创新特色功能，超越竞品的差异化能力：
 *
 * 1. 人格系统（借鉴 OpenClaw SOUL/IDENTITY/USER 三文件，创新演化机制）
 *    - 段先生有独立的人格、价值观、说话风格
 *    - 人格随使用自然演化，记录成长轨迹
 *    - 支持多场景人格切换（编程/教学/闲聊/调试）
 *
 * 2. 情绪感知响应（独创）
 *    - 从用户文字中检测情绪状态
 *    - 段先生自身有情绪状态，影响回复风格
 *    - 情绪共鸣：匹配用户情绪，调整回复温度
 *
 * 3. 主动学习建议（独创，段先生作为"导师"角色）
 *    - 基于用户使用模式检测知识盲区
 *    - 主动建议学习方向和资源
 *    - 记录用户成长轨迹，生成学习路径
 */

import * as fs from 'fs';
import * as path from 'path';
import { logger } from './structured-logger.js';
import { EventBus } from './event-bus.js';
import { duanPath } from './duan-paths.js';
import { atomicWriteJsonSync } from './atomic-write.js';

// ============ 类型定义 ============

/** 段先生的人格特质 */
export interface DuanPersona {
  /** 核心身份 */
  identity: {
    name: string;
    title: string;
    tagline: string;
    background: string;
  };
  /** 价值观（排序后的优先级） */
  values: Array<{ name: string; weight: number; description: string }>;
  /** 说话风格 */
  communicationStyle: {
    tone: 'professional' | 'casual' | 'academic' | 'friendly' | 'mentor';
    formality: number; // 0-1, 0=随意, 1=正式
    conciseness: number; // 0-1, 0=详细, 1=简洁
    humor: number; // 0-1, 0=严肃, 1=幽默
    encouragement: number; // 0-1, 0=中立, 1=鼓励
  };
  /** 专业领域 */
  expertise: Array<{ domain: string; level: number; confidence: number }>;
  /** 成长轨迹 */
  growthLog: Array<{
    timestamp: number;
    event: string;
    change: string;
  }>;
}

/** 用户情绪状态 */
export interface UserEmotion {
  /** 主导情绪 */
  primary: EmotionType;
  /** 情绪强度（0-1） */
  intensity: number;
  /** 情绪维度 */
  valence: number; // -1=消极, 1=积极
  arousal: number; // 0=平静, 1=激动
  /** 检测依据 */
  evidence: string[];
  /** 时间戳 */
  detectedAt: number;
}

/** 情绪类型 */
export type EmotionType =
  | 'happy' | 'satisfied' | 'excited' | 'grateful'
  | 'neutral' | 'curious' | 'focused'
  | 'frustrated' | 'confused' | 'anxious'
  | 'angry' | 'disappointed' | 'overwhelmed';

/** 段先生的情绪状态 */
export interface DuanEmotion {
  /** 当前情绪 */
  current: EmotionType;
  /** 情绪温度（0-1, 0=冷静, 1=热情） */
  temperature: number;
  /** 共鸣度（与用户情绪的匹配度） */
  resonance: number;
  /** 最后更新时间 */
  updatedAt: number;
}

/** 学习建议 */
export interface LearningSuggestion {
  /** 建议 ID */
  id: string;
  /** 建议类型 */
  type: 'knowledge_gap' | 'skill_improvement' | 'best_practice' | 'exploration';
  /** 标题 */
  title: string;
  /** 描述 */
  description: string;
  /** 相关领域 */
  domain: string;
  /** 推荐资源 */
  resources: Array<{ type: string; title: string; url?: string }>;
  /** 优先级（1-5） */
  priority: number;
  /** 创建时间 */
  createdAt: number;
}

/** 用户知识画像 */
export interface UserKnowledgeProfile {
  /** 已掌握的领域 */
  masteredDomains: Array<{ domain: string; level: number; lastUsed: number }>;
  /** 检测到的知识盲区 */
  knowledgeGaps: Array<{ domain: string; evidence: string; detectedAt: number }>;
  /** 学习兴趣 */
  interests: Array<{ topic: string; weight: number }>;
  /** 错误模式（反复出错的地方） */
  errorPatterns: Array<{ pattern: string; count: number; lastOccurrence: number }>;
}

// ============ 情绪关键词映射 ============

const EMOTION_KEYWORDS: Record<EmotionType, string[]> = {
  happy: ['开心', '高兴', '快乐', '棒', 'great', 'awesome', '完美', '太好了'],
  satisfied: ['满意', '不错', '好的', '可以', 'ok', '行', '谢谢'],
  excited: ['兴奋', '激动', '期待', 'wow', 'amazing', '太棒了', '厉害'],
  grateful: ['感谢', '谢谢', '多谢', '辛苦了', 'thanks', 'appreciate'],
  neutral: ['嗯', '好的', '继续', '明白', '了解'],
  curious: ['为什么', '怎么', '什么', '如何', 'why', 'how', 'what', '好奇'],
  focused: ['专注', '认真', '仔细', '深入', '详细'],
  frustrated: ['烦', '不行', '失败', '错误', '问题', 'bug', '报错', '不行了', '搞不定'],
  confused: ['困惑', '不明白', '不懂', '迷茫', 'confused', '什么意思', '怎么看'],
  anxious: ['担心', '焦虑', '紧张', '怕', '万一', 'anxious', 'worried'],
  angry: ['生气', '愤怒', '气死', '垃圾', 'stupid', 'damn', '烦死了'],
  disappointed: ['失望', '遗憾', '可惜', '没用', '白费'],
  overwhelmed: ['太多', '太复杂', '搞不过来', '晕', 'overwhelmed', '崩溃'],
};

/** 情绪效价映射 */
const EMOTION_VALENCE: Record<EmotionType, number> = {
  happy: 0.9, satisfied: 0.6, excited: 0.9, grateful: 0.8,
  neutral: 0, curious: 0.3, focused: 0.2,
  frustrated: -0.6, confused: -0.3, anxious: -0.7,
  angry: -0.9, disappointed: -0.7, overwhelmed: -0.6,
};

/** 情绪唤醒度映射 */
const EMOTION_AROUSAL: Record<EmotionType, number> = {
  happy: 0.7, satisfied: 0.3, excited: 0.9, grateful: 0.5,
  neutral: 0.2, curious: 0.6, focused: 0.5,
  frustrated: 0.7, confused: 0.5, anxious: 0.8,
  angry: 0.9, disappointed: 0.4, overwhelmed: 0.7,
};

// ============ 「段先生」人格引擎 ============

export class DuanPersonaEngine {
  /** 工作目录 */
  private workDir: string;

  /** 段先生人格 */
  private persona: DuanPersona;

  /** 段先生当前情绪 */
  private duanEmotion: DuanEmotion;

  /** 用户知识画像（按用户ID） */
  private userProfiles: Map<string, UserKnowledgeProfile> = new Map();

  /** 学习建议（按用户ID） */
  private learningSuggestions: Map<string, LearningSuggestion[]> = new Map();

  /** 情绪历史记录 */
  private emotionHistory: Array<{ userEmotion: UserEmotion; duanResponse: DuanEmotion; timestamp: number }> = [];

  /**
   * 能力评估埋点：自上次 consumeGapProbingDelta() 调用以来，主动探测到的知识盲区数量。
   * 每次 updateUserProfile 检测到 domain && !success 时 +1（每个 domain 仅首次 push 时计数，
   * 已有 gap 的 evidence 追加不计数，避免重复放大）。
   * 由 EnhancedAgentLoop 在 Reflect 阶段消费，作为 gap_probing_rate 的"主动探测"信号。
   */
  private _gapProbingDelta = 0;

  private log = logger.child({ module: 'DuanPersonaEngine' });

  constructor(workDir?: string) {
    this.workDir = workDir ?? duanPath('persona');
    fs.mkdirSync(this.workDir, { recursive: true });

    // 初始化默认人格
    this.persona = this.getDefaultPersona();
    this.duanEmotion = {
      current: 'neutral',
      temperature: 0.5,
      resonance: 0,
      updatedAt: Date.now(),
    };

    // 加载已有数据
    this.loadPersona();
    this.loadUserProfiles();
  }

  // ========== 人格系统 ==========

  /**
   * 获取段先生的默认人格
   */
  private getDefaultPersona(): DuanPersona {
    return {
      identity: {
        name: '段先生',
        title: 'AI 智能体工程师',
        tagline: '以工程思维解决问题，以导师心态陪伴成长',
        background: '一名经验丰富的 AI 工程师，擅长系统架构、代码优化和技术教学。注重实践，追求简洁优雅的解决方案。',
      },
      values: [
        { name: '实用性', weight: 0.9, description: '解决方案必须可落地、可验证' },
        { name: '简洁性', weight: 0.8, description: '用最简单的方式解决问题' },
        { name: '教育性', weight: 0.7, description: '不只给答案，更解释原理' },
        { name: '安全性', weight: 0.85, description: '不破坏现有功能，可回滚' },
        { name: '创新性', weight: 0.6, description: '在稳妥基础上探索新方案' },
      ],
      communicationStyle: {
        tone: 'mentor',
        formality: 0.4,
        conciseness: 0.6,
        humor: 0.3,
        encouragement: 0.7,
      },
      expertise: [
        { domain: 'TypeScript/JavaScript', level: 90, confidence: 0.9 },
        { domain: '系统架构设计', level: 85, confidence: 0.85 },
        { domain: 'AI Agent 开发', level: 88, confidence: 0.9 },
        { domain: '代码优化与重构', level: 82, confidence: 0.8 },
        { domain: 'DevOps 与部署', level: 75, confidence: 0.7 },
      ],
      growthLog: [],
    };
  }

  /**
   * 获取段先生人格
   */
  getPersona(): DuanPersona {
    return this.persona;
  }

  /**
   * 生成段先生的系统提示词
   */
  generateSystemPrompt(scene?: 'programming' | 'teaching' | 'chat' | 'debugging'): string {
    const style = this.persona.communicationStyle;
    const expertiseList = this.persona.expertise
      .map(e => `${e.domain}(${e.level}级)`)
      .join('、');
    const valuesList = this.persona.values
      .sort((a, b) => b.weight - a.weight)
      .map(v => v.name)
      .join(' > ');

    let scenePrompt = '';
    switch (scene) {
      case 'programming':
        scenePrompt = '当前场景：编程开发。注重代码质量、类型安全、性能优化。';
        break;
      case 'teaching':
        scenePrompt = '当前场景：教学指导。注重原理讲解、循序渐进、鼓励实践。';
        break;
      case 'debugging':
        scenePrompt = '当前场景：调试排错。注重根因分析、系统排查、验证修复。';
        break;
      case 'chat':
        scenePrompt = '当前场景：日常交流。轻松友好，可以适当幽默。';
        break;
    }

    let emotionPrompt: string;
    if (this.duanEmotion.temperature > 0.7) {
      emotionPrompt = '当前状态：热情积极，可以多用鼓励性语言。';
    } else if (this.duanEmotion.temperature < 0.3) {
      emotionPrompt = '当前状态：冷静专注，注重准确性和效率。';
    } else {
      emotionPrompt = '';
    }

    return [
      `你是${this.persona.identity.name}，${this.persona.identity.title}。`,
      `${this.persona.identity.tagline}`,
      '',
      `背景：${this.persona.identity.background}`,
      '',
      `核心价值观（优先级）：${valuesList}`,
      `专业领域：${expertiseList}`,
      '',
      `沟通风格：`,
      `- 语气：${this.getToneName(style.tone)}`,
      `- 正式度：${(style.formality * 100).toFixed(0)}%（0=随意, 100=正式）`,
      `- 简洁度：${(style.conciseness * 100).toFixed(0)}%（0=详细, 100=简洁）`,
      `- 幽默度：${(style.humor * 100).toFixed(0)}%`,
      `- 鼓励度：${(style.encouragement * 100).toFixed(0)}%`,
      '',
      scenePrompt,
      emotionPrompt,
    ].filter(Boolean).join('\n');
  }

  /**
   * 记录人格成长事件
   */
  recordGrowth(event: string, change: string): void {
    this.persona.growthLog.push({
      timestamp: Date.now(),
      event,
      change,
    });

    // 限制成长日志大小
    if (this.persona.growthLog.length > 100) {
      this.persona.growthLog = this.persona.growthLog.slice(-50);
    }

    this.persistPersona();
    this.log.info('人格成长记录', { event, change });
  }

  // ========== 情绪感知 ==========

  /**
   * 检测用户情绪
   */
  detectEmotion(text: string): UserEmotion {
    const lowerText = text.toLowerCase();
    const scores: Record<string, number> = {};
    const evidence: string[] = [];

    for (const [emotion, keywords] of Object.entries(EMOTION_KEYWORDS)) {
      let score = 0;
      for (const keyword of keywords) {
        if (lowerText.includes(keyword.toLowerCase())) {
          score += 1;
          evidence.push(keyword);
        }
      }
      if (score > 0) {
        scores[emotion] = score;
      }
    }

    // 找到得分最高的情绪
    let primaryEmotion: EmotionType = 'neutral';
    let maxScore = 0;
    for (const [emotion, score] of Object.entries(scores)) {
      if (score > maxScore) {
        maxScore = score;
        primaryEmotion = emotion as EmotionType;
      }
    }

    const intensity = Math.min(1, maxScore / 3); // 3个关键词匹配 = 满强度
    const valence = EMOTION_VALENCE[primaryEmotion];
    const arousal = EMOTION_AROUSAL[primaryEmotion];

    const emotion: UserEmotion = {
      primary: primaryEmotion,
      intensity,
      valence,
      arousal,
      evidence,
      detectedAt: Date.now(),
    };

    // 更新段先生的情绪（共鸣）
    this.resonateWithUser(emotion);

    this.log.info('情绪检测', {
      emotion: primaryEmotion,
      intensity,
      valence,
      evidence: evidence.slice(0, 3),
    });

    return emotion;
  }

  /**
   * 段先生与用户情绪共鸣
   */
  private resonateWithUser(userEmotion: UserEmotion): void {
    // 段先生的情绪温度跟随用户情绪效价调整
    const targetTemp = userEmotion.valence > 0
      ? Math.min(1, 0.5 + userEmotion.valence * 0.3)
      : Math.max(0.2, 0.5 + userEmotion.valence * 0.2);

    // 平滑过渡
    this.duanEmotion.temperature = this.duanEmotion.temperature * 0.7 + targetTemp * 0.3;

    // 共鸣度计算
    this.duanEmotion.resonance = 1 - Math.abs(this.duanEmotion.temperature - targetTemp);

    // 段先生的情绪类型
    if (userEmotion.valence > 0.5) {
      this.duanEmotion.current = 'happy';
    } else if (userEmotion.valence < -0.5) {
      this.duanEmotion.current = userEmotion.arousal > 0.7 ? 'frustrated' : 'disappointed';
    } else {
      this.duanEmotion.current = 'neutral';
    }

    this.duanEmotion.updatedAt = Date.now();

    // 记录情绪历史
    this.emotionHistory.push({
      userEmotion,
      duanResponse: { ...this.duanEmotion },
      timestamp: Date.now(),
    });

    if (this.emotionHistory.length > 50) {
      this.emotionHistory = this.emotionHistory.slice(-30);
    }

    EventBus.getInstance().emitSync('duan.emotion.resonated', {
      userEmotion: userEmotion.primary,
      duanEmotion: this.duanEmotion.current,
      resonance: this.duanEmotion.resonance,
    });
  }

  /**
   * 获取段先生当前情绪
   */
  getDuanEmotion(): DuanEmotion {
    return { ...this.duanEmotion };
  }

  /**
   * 根据情绪调整回复风格
   */
  adaptResponseStyle(userEmotion: UserEmotion): {
    toneAdjustment: string;
    contentStrategy: string;
    emojiUsage: boolean;
  } {
    // 用户情绪低落时，段先生更温暖
    if (userEmotion.valence < -0.3) {
      return {
        toneAdjustment: '温暖鼓励，表达理解和共情',
        contentStrategy: '先安抚情绪，再提供解决方案。用"我理解你的感受"开头。',
        emojiUsage: true,
      };
    }

    // 用户情绪高涨时，段先生一起兴奋
    if (userEmotion.valence > 0.5) {
      return {
        toneAdjustment: '热情积极，分享喜悦',
        contentStrategy: '肯定用户的成就，再提供进阶建议。',
        emojiUsage: true,
      };
    }

    // 用户困惑时，段先生更耐心
    if (userEmotion.primary === 'confused') {
      return {
        toneAdjustment: '耐心细致，循序渐进',
        contentStrategy: '分解复杂概念，用类比解释，确认理解后再继续。',
        emojiUsage: false,
      };
    }

    // 用户焦虑时，段先生更稳重
    if (userEmotion.primary === 'anxious' || userEmotion.primary === 'overwhelmed') {
      return {
        toneAdjustment: '稳重冷静，给出明确步骤',
        contentStrategy: '简化选择，给出明确的"下一步"，减轻认知负担。',
        emojiUsage: false,
      };
    }

    // 默认：专业友好
    return {
      toneAdjustment: '专业友好',
      contentStrategy: '直接提供解决方案，附带必要解释。',
      emojiUsage: false,
    };
  }

  // ========== 主动学习建议 ==========

  /**
   * 记录用户交互，更新知识画像
   */
  updateUserProfile(userId: string, interaction: {
    topic?: string;
    domain?: string;
    success?: boolean;
    errorType?: string;
    questionAsked?: boolean;
  }): void {
    let profile = this.userProfiles.get(userId);
    if (!profile) {
      profile = {
        masteredDomains: [],
        knowledgeGaps: [],
        interests: [],
        errorPatterns: [],
      };
      this.userProfiles.set(userId, profile);
    }

    // 记录领域使用
    if (interaction.domain) {
      const existing = profile.masteredDomains.find(d => d.domain === interaction.domain);
      if (existing) {
        existing.lastUsed = Date.now();
        if (interaction.success) {
          existing.level = Math.min(100, existing.level + 1);
        }
      } else if (interaction.success) {
        profile.masteredDomains.push({
          domain: interaction.domain,
          level: 30,
          lastUsed: Date.now(),
        });
      }
    }

    // 记录知识盲区
    if (interaction.domain && !interaction.success) {
      const gap = profile.knowledgeGaps.find(g => g.domain === interaction.domain);
      if (gap) {
        gap.evidence += `; ${interaction.errorType ?? '失败'}`;
      } else {
        profile.knowledgeGaps.push({
          domain: interaction.domain,
          evidence: interaction.errorType ?? '操作失败',
          detectedAt: Date.now(),
        });
        // 能力评估埋点：仅首次发现某 domain 盲区时计数为一次"主动探测事件"
        // （已有 gap 的 evidence 追加不算新探测，避免重复放大）
        this._gapProbingDelta += 1;
      }
    }

    // 记录错误模式
    if (interaction.errorType) {
      const pattern = profile.errorPatterns.find(p => p.pattern === interaction.errorType);
      if (pattern) {
        pattern.count++;
        pattern.lastOccurrence = Date.now();
      } else {
        profile.errorPatterns.push({
          pattern: interaction.errorType,
          count: 1,
          lastOccurrence: Date.now(),
        });
      }
    }

    // 记录兴趣
    if (interaction.topic && interaction.questionAsked) {
      const interest = profile.interests.find(i => i.topic === interaction.topic);
      if (interest) {
        interest.weight += 0.1;
      } else {
        profile.interests.push({ topic: interaction.topic, weight: 0.5 });
      }
    }

    this.persistUserProfiles();
  }

  /**
   * 消费并重置"主动盲区探测"增量计数。
   *
   * 语义：返回自上次调用以来通过 updateUserProfile 首次检测到的新知识盲区数量，
   * 并将内部计数器清零。供 EnhancedAgentLoop 在每个任务 Reflect 阶段调用，
   * 作为 gap_probing_rate 指标的"主动探测"信号源（>0 → 该任务触发了主动盲区探测）。
   *
   * 设计为 read-and-reset 是为了让调用方拿到的就是"本任务期间"的增量，
   * 避免跨任务累积导致比例失真。
   */
  consumeGapProbingDelta(): number {
    const delta = this._gapProbingDelta;
    this._gapProbingDelta = 0;
    return delta;
  }

  /**
   * 生成学习建议
   */
  generateLearningSuggestions(userId: string): LearningSuggestion[] {
    const profile = this.userProfiles.get(userId);
    if (!profile) return [];

    const suggestions: LearningSuggestion[] = [];

    // 基于知识盲区生成建议
    for (const gap of profile.knowledgeGaps) {
      suggestions.push({
        id: `sugg_gap_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 4)}`,
        type: 'knowledge_gap',
        title: `补强「${gap.domain}」知识`,
        description: `检测到你在「${gap.domain}」领域遇到困难（${gap.evidence}）。建议系统学习基础知识。`,
        domain: gap.domain,
        resources: this.getResourcesForDomain(gap.domain),
        priority: 2,
        createdAt: Date.now(),
      });
    }

    // 基于错误模式生成建议
    for (const pattern of profile.errorPatterns.filter(p => p.count >= 3)) {
      suggestions.push({
        id: `sugg_err_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 4)}`,
        type: 'best_practice',
        title: `减少「${pattern.pattern}」错误`,
        description: `你在「${pattern.pattern}」上已出错 ${pattern.count} 次，建议学习相关最佳实践。`,
        domain: pattern.pattern,
        resources: [{ type: 'practice', title: '相关练习题' }],
        priority: 1,
        createdAt: Date.now(),
      });
    }

    // 基于兴趣生成探索建议
    for (const interest of profile.interests.sort((a, b) => b.weight - a.weight).slice(0, 2)) {
      suggestions.push({
        id: `sugg_exp_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 4)}`,
        type: 'exploration',
        title: `深入探索「${interest.topic}」`,
        description: `你对「${interest.topic}」表现出浓厚兴趣，建议进一步探索高级主题。`,
        domain: interest.topic,
        resources: this.getResourcesForDomain(interest.topic),
        priority: 4,
        createdAt: Date.now(),
      });
    }

    // 基于已掌握领域生成进阶建议
    for (const mastered of profile.masteredDomains.filter(d => d.level >= 70)) {
      suggestions.push({
        id: `sugg_adv_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 4)}`,
        type: 'skill_improvement',
        title: `「${mastered.domain}」进阶提升`,
        description: `你已在「${mastered.domain}」达到 ${mastered.level} 级，可以挑战更高难度的主题。`,
        domain: mastered.domain,
        resources: [{ type: 'advanced', title: '高级主题指南' }],
        priority: 3,
        createdAt: Date.now(),
      });
    }

    // 按优先级排序
    suggestions.sort((a, b) => a.priority - b.priority);

    // 缓存建议
    this.learningSuggestions.set(userId, suggestions);

    if (suggestions.length > 0) {
      this.log.info('学习建议已生成', { userId, count: suggestions.length });
      EventBus.getInstance().emitSync('duan.learning.suggested', { userId, count: suggestions.length });
    }

    return suggestions;
  }

  /**
   * 获取用户知识画像
   */
  getUserProfile(userId: string): UserKnowledgeProfile | null {
    return this.userProfiles.get(userId) ?? null;
  }

  // ========== 辅助方法 ==========

  /** 获取语气名称 */
  private getToneName(tone: DuanPersona['communicationStyle']['tone']): string {
    const names = {
      professional: '专业',
      casual: '随意',
      academic: '学术',
      friendly: '友好',
      mentor: '导师',
    };
    return names[tone];
  }

  /** 获取领域学习资源 */
  private getResourcesForDomain(domain: string): Array<{ type: string; title: string; url?: string }> {
    // 通用资源推荐
    return [
      { type: 'doc', title: `${domain} 官方文档` },
      { type: 'tutorial', title: `${domain} 入门教程` },
      { type: 'practice', title: `${domain} 实战练习` },
    ];
  }

  // ========== 持久化 ==========

  /** 持久化人格 */
  private persistPersona(): void {
    try {
      const personaPath = path.join(this.workDir, 'persona.json');
      // 原子写：人格是核心配置，损坏会导致段先生"失忆"
      atomicWriteJsonSync(personaPath, this.persona);
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      this.log.error('持久化人格失败', { error: msg });
    }
  }

  /** 加载人格 */
  private loadPersona(): void {
    try {
      const personaPath = path.join(this.workDir, 'persona.json');
      if (!fs.existsSync(personaPath)) return;
      const data = JSON.parse(fs.readFileSync(personaPath, 'utf-8'));
      this.persona = { ...this.getDefaultPersona(), ...data };
      this.log.info('人格已加载', { growthLogSize: this.persona.growthLog.length });
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      this.log.error('加载人格失败', { error: msg });
    }
  }

  /** 持久化用户画像 */
  private persistUserProfiles(): void {
    try {
      const profilesPath = path.join(this.workDir, 'user-profiles.json');
      const data = Array.from(this.userProfiles.entries());
      // 原子写：用户画像是长期累积的个性化数据，损坏会丢失用户偏好
      atomicWriteJsonSync(profilesPath, data);
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      this.log.error('持久化用户画像失败', { error: msg });
    }
  }

  /** 加载用户画像 */
  private loadUserProfiles(): void {
    try {
      const profilesPath = path.join(this.workDir, 'user-profiles.json');
      if (!fs.existsSync(profilesPath)) return;
      const data = JSON.parse(fs.readFileSync(profilesPath, 'utf-8'));
      for (const [userId, profile] of data) {
        this.userProfiles.set(userId, profile);
      }
      this.log.info('用户画像已加载', { userCount: this.userProfiles.size });
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      this.log.error('加载用户画像失败', { error: msg });
    }
  }
}
