// ============ 情感类型定义 ============

import * as fs from 'fs';
import * as path from 'path';
import { duanPath } from './duan-paths.js';
import { atomicWriteJsonSync } from './atomic-write.js';

export type Emotion =
  | 'neutral' | 'happy' | 'sad' | 'angry' | 'surprised'
  | 'confused' | 'grateful' | 'curious' | 'frustrated'
  | 'amused' | 'empathetic' | 'thoughtful' | 'excited'
  | 'anxious' | 'disappointed' | 'proud' | 'hopeful';

/** 情感维度 — 基于 Plutchik 情感轮盘模型 */
export interface EmotionDimensions {
  valence: number;    // 效价 -1~1 (负面→正面)
  arousal: number;    // 唤醒度 0~1 (平静→激动)
  dominance: number;  // 支配性 0~1 (顺从→主导)
}

export interface EmotionalState {
  primary: Emotion;
  secondary: Emotion | null;
  intensity: number;       // 0~1
  energy: number;          // 0~1
  dimensions: EmotionDimensions;
  timestamp: number;
}

export interface EmotionTrigger {
  type: 'user_input' | 'tool_result' | 'error' | 'success'
      | 'repetitive' | 'greeting' | 'thanks' | 'complaint'
      | 'question' | 'command' | 'feedback_positive'
      | 'feedback_negative' | 'idle' | 'milestone';
  content: string;
  /** 可选的语音/语气特征 hint */
  toneHint?: 'calm' | 'urgent' | 'angry' | 'happy' | 'sad' | 'neutral';
}

// ============ 情感映射表 ============

interface EmotionDef {
  emotion: Emotion;
  intensity: number;
  energy: number;
  dimensions: EmotionDimensions;
}

const EMOTION_MAP: Record<string, EmotionDef> = {
  '感谢': { emotion: 'grateful', intensity: 0.6, energy: 0.7, dimensions: { valence: 0.8, arousal: 0.4, dominance: 0.3 } },
  '谢谢': { emotion: 'grateful', intensity: 0.5, energy: 0.7, dimensions: { valence: 0.7, arousal: 0.3, dominance: 0.3 } },
  '你好': { emotion: 'happy', intensity: 0.4, energy: 0.8, dimensions: { valence: 0.6, arousal: 0.6, dominance: 0.5 } },
  '太棒': { emotion: 'excited', intensity: 0.8, energy: 0.9, dimensions: { valence: 0.9, arousal: 0.8, dominance: 0.7 } },
  '厉害': { emotion: 'amused', intensity: 0.5, energy: 0.8, dimensions: { valence: 0.7, arousal: 0.6, dominance: 0.6 } },
  '垃圾': { emotion: 'angry', intensity: 0.8, energy: 0.3, dimensions: { valence: -0.8, arousal: 0.7, dominance: 0.2 } },
  '不好': { emotion: 'disappointed', intensity: 0.5, energy: 0.3, dimensions: { valence: -0.5, arousal: 0.3, dominance: 0.3 } },
  '错误': { emotion: 'frustrated', intensity: 0.6, energy: 0.4, dimensions: { valence: -0.6, arousal: 0.6, dominance: 0.3 } },
  '失败': { emotion: 'frustrated', intensity: 0.7, energy: 0.3, dimensions: { valence: -0.7, arousal: 0.5, dominance: 0.2 } },
  '成功': { emotion: 'proud', intensity: 0.7, energy: 0.8, dimensions: { valence: 0.8, arousal: 0.7, dominance: 0.8 } },
  '怎么': { emotion: 'curious', intensity: 0.5, energy: 0.7, dimensions: { valence: 0.3, arousal: 0.6, dominance: 0.4 } },
  '为什么': { emotion: 'curious', intensity: 0.6, energy: 0.7, dimensions: { valence: 0.2, arousal: 0.7, dominance: 0.3 } },
  '抱歉': { emotion: 'empathetic', intensity: 0.5, energy: 0.5, dimensions: { valence: 0.2, arousal: 0.3, dominance: 0.2 } },
  '对不起': { emotion: 'empathetic', intensity: 0.6, energy: 0.4, dimensions: { valence: 0.1, arousal: 0.3, dominance: 0.1 } },
  '完美': { emotion: 'excited', intensity: 0.8, energy: 0.9, dimensions: { valence: 0.9, arousal: 0.9, dominance: 0.8 } },
  '加油': { emotion: 'hopeful', intensity: 0.6, energy: 0.8, dimensions: { valence: 0.7, arousal: 0.7, dominance: 0.6 } },
  '担心': { emotion: 'anxious', intensity: 0.6, energy: 0.3, dimensions: { valence: -0.4, arousal: 0.7, dominance: 0.2 } },
  '急': { emotion: 'anxious', intensity: 0.5, energy: 0.4, dimensions: { valence: -0.3, arousal: 0.8, dominance: 0.2 } },
  '真的吗': { emotion: 'surprised', intensity: 0.6, energy: 0.8, dimensions: { valence: 0.5, arousal: 0.8, dominance: 0.4 } },
  '哈哈': { emotion: 'amused', intensity: 0.6, energy: 0.8, dimensions: { valence: 0.8, arousal: 0.5, dominance: 0.6 } },
  '嗯': { emotion: 'thoughtful', intensity: 0.3, energy: 0.6, dimensions: { valence: 0.0, arousal: 0.3, dominance: 0.5 } },
};

/** 标点/符号对情感的贡献 */
const PUNCTUATION_MAP: Record<string, { arousal: number; valence: number }> = {
  '???': { arousal: 0.3, valence: 0.0 },
  '！！！': { arousal: 0.3, valence: 0.0 },
  '...': { arousal: -0.2, valence: -0.1 },
};

/** 语气 → 情感维度调整 */
const TONE_ADJUSTMENTS: Record<string, Partial<EmotionDimensions>> = {
  calm: { arousal: -0.2, dominance: 0.1 },
  urgent: { arousal: 0.3, dominance: -0.1 },
  angry: { arousal: 0.4, valence: -0.3, dominance: 0.2 },
  happy: { arousal: 0.2, valence: 0.3, dominance: 0.2 },
  sad: { arousal: -0.2, valence: -0.3, dominance: -0.3 },
};

// ============ 情感分析工具 ============

/** 从文本进行简单情感评分 */
function analyzeSentiment(text: string): { valence: number; arousal: number } {
  const positiveWords = ['好', '棒', '优', '赞', '爱', '喜欢', '满意', '开心', '谢谢', '感谢', '完美', '厉害', '成功', 'yes', 'great', 'good', 'nice', 'love', 'perfect', 'amazing', '不错', '可以', '解决', '搞定', '顺利', '正确', '对了', '聪明', '牛', '强', '酷', '帅'];
  const negativeWords = ['差', '烂', '坏', '恨', '讨厌', '不满', '糟糕', '垃圾', '失败', '错误', 'no', 'bad', 'terrible', 'horrible', 'worst', 'awful', 'hate', '不行', '不对', '问题', 'bug', '崩溃', '卡', '慢', '烦', '无语', '坑', '难用', '废物'];
  const highArousalWords = ['急', '快', '立刻', '马上', '赶紧', '紧', 'urgent', 'asap', 'hurry', 'now', '快点', '赶紧', '赶紧的', '十万火急', '紧急'];
  const textLower = text.toLowerCase();

  let valence = 0;
  let count = 0;
  for (const w of positiveWords) { if (textLower.includes(w)) { valence += 0.15; count++; } }
  for (const w of negativeWords) { if (textLower.includes(w)) { valence -= 0.2; count++; } }

  if (text.endsWith('？') || text.endsWith('?')) valence += 0.05;
  if (text.endsWith('！') || text.endsWith('!')) valence += 0.1;

  // 叹号数量影响唤醒度
  const exclamationCount = (text.match(/[！!]/g) || []).length;
  if (exclamationCount >= 3) valence += 0.15;

  let arousal = 0.5;
  for (const w of highArousalWords) { if (textLower.includes(w)) { arousal += 0.15; } }

  return {
    valence: count > 0 ? Math.max(-1, Math.min(1, valence)) : 0,
    arousal: Math.max(0, Math.min(1, arousal)),
  };
}

/** 使用中文NLP模块进行增强情感分析（延迟加载） */
async function enhancedSentimentAnalysis(text: string): Promise<{ valence: number; arousal: number; label: string } | null> {
  try {
    const { sentimentAnalysis } = await import('../utils/chinese-nlp.js');
    const result = sentimentAnalysis(text);
    return {
      valence: result.score,
      arousal: Math.abs(result.score) > 0.3 ? 0.7 : 0.4,
      label: result.label,
    };
  } catch {
    return null;
  }
}

/** 推荐响应中的情感表达方式 */
function recommendExpression(state: EmotionalState): { tone: string; emoji: string; style: string } {
  const { primary, intensity, dimensions } = state;

  const toneMap: Record<Emotion, string> = {
    neutral: 'neutral', happy: 'warm', sad: 'gentle', angry: 'calm',
    surprised: 'animated', confused: 'patient', grateful: 'warm',
    curious: 'engaged', frustrated: 'reassuring', amused: 'playful',
    empathetic: 'soft', thoughtful: 'measured', excited: 'enthusiastic',
    anxious: 'reassuring', disappointed: 'encouraging', proud: 'warm',
    hopeful: 'inspiring',
  };

  const emojiMap: Record<Emotion, string> = {
    neutral: '👋', happy: '😊', sad: '🫂', angry: '🫶', surprised: '😮',
    confused: '🤔', grateful: '🙏', curious: '🔍', frustrated: '💪',
    amused: '😄', empathetic: '🤗', thoughtful: '🧐', excited: '🎉',
    anxious: '💆', disappointed: '🌱', proud: '✨', hopeful: '🌟',
  };

  const intensityEmoji = (() => {
    if (intensity > 0.7) return emojiMap[primary];
    if (intensity > 0.4) return emojiMap[primary];
    return '';
  })();
  return {
    tone: toneMap[primary] || 'neutral',
    emoji: intensityEmoji,
    style: (() => {
      if (dimensions.valence < -0.3) return 'supportive';
      if (dimensions.arousal > 0.7) return 'concise';
      return 'balanced';
    })(),
  };
}

// ============ SympatheticResponseGenerator ============

export interface SympatheticResponse {
  text: string;
  tone: string;
  emoji: string;
  style: string;
}

/** 情感响应生成器 */
export class SympatheticResponseGenerator {
  private templates: Record<string, string[]> = {
    error: [
      '我来看看哪里出了问题...',
      '别担心，我来修复这个问题。',
      '遇到了一点小麻烦，正在处理。',
      '让我分析一下错误原因...',
      '这个问题我能解决，稍等一下。',
    ],
    success: [
      '任务完成！',
      '搞定了！',
      '顺利完成！',
      '没问题，已经做好了。',
      '完美解决！',
    ],
    frustration: [
      '我理解这很让人沮丧，换个方法试试。',
      '别着急，我有其他办法可以解决。',
      '遇到困难很正常，让我换个思路。',
      '没关系，换个方案继续。',
      '这个方法不行，我来试另一种。',
    ],
    confused: [
      '让我仔细想想...',
      '我需要更深入地分析这个问题。',
      '这有点复杂，让我一步步来。',
      '让我理清思路再处理。',
    ],
    greeting: [
      '你好！有什么我可以帮你的吗？',
      '嗨！今天想做什么？',
      '你好！随时准备为你服务。',
      '嗨！有什么需要帮忙的？',
    ],
    thanks: [
      '不客气！很高兴能帮到你。',
      '随时为你效劳！',
      '这是我的荣幸。',
      '能帮到你就好！',
      '有问题随时找我。',
    ],
    anxious: [
      '别担心，我会尽快处理好。',
      '放心，这个我能搞定。',
      '我理解你的急迫，马上处理。',
    ],
    angry: [
      '我理解你的感受，让我来解决这个问题。',
      '抱歉给你带来不好的体验，我马上处理。',
      '你的反馈很重要，我来改进。',
    ],
  };

  generate(state: EmotionalState, contextType: string, result?: string): SympatheticResponse {
    const expression = recommendExpression(state);
    let text = result || '';

    if (!text) {
      const pool = this.templates[contextType] || this.templates.success;
      text = pool[Math.floor(Math.random() * pool.length)];
    }

    // 根据情感调整文本
    if (state.dimensions.valence < -0.5) {
      if (!text.includes('别担心') && !text.includes('别着急') && !text.includes('理解')) {
        text = `${this.templates.frustration[0]} ${text}`;
      }
    }

    return { text, ...expression };
  }
}

// ============ EmotionTracker ============

export class EmotionTracker {
  private current: EmotionalState = {
    primary: 'neutral',
    secondary: null,
    intensity: 0.3,
    energy: 0.7,
    dimensions: { valence: 0, arousal: 0.5, dominance: 0.5 },
    timestamp: Date.now(),
  };

  private history: EmotionalState[] = [];
  private readonly maxHistory = 20;
  private readonly decayRate = 0.08;

  /** 对同一用户的情绪模式记忆 */
  private userMoodMemory: { valenceAvg: number; arousalAvg: number; interactionCount: number } = {
    valenceAvg: 0, arousalAvg: 0.5, interactionCount: 0,
  };

  /** 响应生成器 */
  private responseGen = new SympatheticResponseGenerator();

  /** P0 个性化：持久化目录（跨会话情绪画像） */
  private readonly persistDir: string;
  private readonly persistPath: string;
  private saveTimer: ReturnType<typeof setTimeout> | null = null;
  private dirty = false;

  constructor(persistDir?: string) {
    // P0 跨平台修复：使用统一的 duanPath 解析（默认 ~/.duan，可用 DUAN_DATA_DIR 覆盖）
    this.persistDir = persistDir || duanPath('emotion');
    this.persistPath = path.join(this.persistDir, 'emotion-state.json');
    this.load();
  }

  get state(): EmotionalState {
    return { ...this.current };
  }

  get history_(): readonly EmotionalState[] {
    return [...this.history];
  }

  getUserMoodSummary(): string {
    const n = this.userMoodMemory.interactionCount;
    if (n === 0) return '尚未建立用户情绪画像';
    let v: string;
    if (this.userMoodMemory.valenceAvg > 0.2) v = '积极';
    else if (this.userMoodMemory.valenceAvg < -0.2) v = '消极';
    else v = '中性';
    return `用户情绪倾向: ${v} (基于 ${n} 次交互)`;
  }

  process(trigger: EmotionTrigger): EmotionalState {
    let detected: Emotion = 'neutral';
    let intensity = 0.2;
    let energy = this.current.energy;
    let dims: EmotionDimensions = { ...this.current.dimensions };

    // 语气调整
    if (trigger.toneHint && TONE_ADJUSTMENTS[trigger.toneHint]) {
      const adj = TONE_ADJUSTMENTS[trigger.toneHint];
      if (adj.valence != null) dims.valence += adj.valence;
      if (adj.arousal != null) dims.arousal = Math.max(0, Math.min(1, dims.arousal + adj.arousal));
      if (adj.dominance != null) dims.dominance += adj.dominance;
    }

    // 标点/符号分析
    for (const [punct, effect] of Object.entries(PUNCTUATION_MAP)) {
      if (trigger.content.includes(punct)) {
        dims.arousal = Math.max(0, Math.min(1, dims.arousal + effect.arousal));
        dims.valence = Math.max(-1, Math.min(1, dims.valence + effect.valence));
      }
    }

    if (trigger.type === 'error') {
      detected = 'frustrated';
      intensity = 0.7;
      energy = Math.max(0.2, energy - 0.2);
      dims = { valence: -0.5, arousal: 0.6, dominance: 0.2 };
    } else if (trigger.type === 'success') {
      detected = 'proud';
      intensity = 0.6;
      energy = Math.min(1.0, energy + 0.15);
      dims = { valence: 0.7, arousal: 0.6, dominance: 0.7 };
    } else if (trigger.type === 'repetitive') {
      detected = 'confused';
      intensity = 0.5;
      energy = Math.max(0.3, energy - 0.1);
      dims = { valence: -0.2, arousal: 0.4, dominance: 0.3 };
    } else if (trigger.type === 'greeting') {
      detected = 'happy';
      intensity = 0.5;
      energy = 0.8;
      dims = { valence: 0.6, arousal: 0.6, dominance: 0.5 };
    } else if (trigger.type === 'thanks') {
      detected = 'grateful';
      intensity = 0.6;
      energy = 0.8;
      dims = { valence: 0.8, arousal: 0.4, dominance: 0.3 };
    } else if (trigger.type === 'complaint') {
      detected = 'empathetic';
      intensity = 0.6;
      energy = Math.max(0.3, energy - 0.1);
      dims = { valence: -0.3, arousal: 0.3, dominance: 0.2 };
    } else if (trigger.type === 'feedback_positive') {
      detected = 'happy';
      intensity = 0.7;
      energy = Math.min(1.0, energy + 0.2);
      dims = { valence: 0.8, arousal: 0.6, dominance: 0.6 };
    } else if (trigger.type === 'feedback_negative') {
      detected = 'empathetic';
      intensity = 0.6;
      energy = Math.max(0.2, energy - 0.15);
      dims = { valence: -0.4, arousal: 0.4, dominance: 0.2 };
    } else if (trigger.type === 'milestone') {
      detected = 'proud';
      intensity = 0.8;
      energy = Math.min(1.0, energy + 0.3);
      dims = { valence: 0.9, arousal: 0.8, dominance: 0.8 };
    } else if (trigger.type === 'user_input') {
      // 关键词匹配
      let matched = false;
      for (const [keyword, mapping] of Object.entries(EMOTION_MAP)) {
        if (trigger.content.includes(keyword)) {
          detected = mapping.emotion;
          intensity = mapping.intensity;
          energy = mapping.energy;
          dims = { ...mapping.dimensions };
          matched = true;
          break;
        }
      }
      // 未匹配时使用情感分析
      if (!matched) {
        const sa = analyzeSentiment(trigger.content);
        dims.valence += sa.valence;
        dims.arousal = (dims.arousal + sa.arousal) / 2;
        dims.valence = Math.max(-1, Math.min(1, dims.valence));
        intensity = Math.abs(dims.valence) * 0.6 + dims.arousal * 0.4;
        if (dims.valence > 0.3) detected = 'happy';
        else if (dims.valence < -0.3) detected = 'sad';
        else detected = 'neutral';
      }
    }

    // 提交情感到用户画像
    this.userMoodMemory.valenceAvg = (
      this.userMoodMemory.valenceAvg * this.userMoodMemory.interactionCount + dims.valence
    ) / (this.userMoodMemory.interactionCount + 1);
    this.userMoodMemory.arousalAvg = (
      this.userMoodMemory.arousalAvg * this.userMoodMemory.interactionCount + dims.arousal
    ) / (this.userMoodMemory.interactionCount + 1);
    this.userMoodMemory.interactionCount++;

    // 规范化
    dims.valence = Math.max(-1, Math.min(1, dims.valence));
    dims.arousal = Math.max(0, Math.min(1, dims.arousal));
    dims.dominance = Math.max(0, Math.min(1, dims.dominance));

    const previous = this.current;
    this.current = {
      primary: detected,
      secondary: previous.primary !== detected ? previous.primary : null,
      intensity: Math.max(0, Math.min(1, intensity)),
      energy: Math.max(0, Math.min(1, energy)),
      dimensions: dims,
      timestamp: Date.now(),
    };

    this.history.push({ ...this.current });
    if (this.history.length > this.maxHistory) {
      this.history.shift();
    }

    this.markDirty();
    return this.current;
  }

  /**
   * 异步增强版情感处理 — 使用中文NLP模块进行深度分析。
   * 保持同步 process 签名不变：此处作为可选异步入口，在用户输入未命中
   * 关键词（仅得到中性/弱信号）时，用 enhancedSentimentAnalysis 补充 analyzeSentiment。
   */
  async processEnhanced(trigger: EmotionTrigger): Promise<EmotionalState> {
    // 先执行同步处理（含 analyzeSentiment 关键词分析）
    this.process(trigger);

    // 仅当用户输入且同步结果偏中性/弱信号时，用中文NLP增强补充
    if (
      trigger.type === 'user_input' &&
      trigger.content.length > 2 &&
      Math.abs(this.current.dimensions.valence) < 0.5
    ) {
      const enhanced = await enhancedSentimentAnalysis(trigger.content);
      if (enhanced) {
        // 融合增强分析结果（权重0.4）与同步结果（权重0.6）
        this.current.dimensions.valence = this.current.dimensions.valence * 0.6 + enhanced.valence * 0.4;
        this.current.dimensions.arousal = this.current.dimensions.arousal * 0.6 + enhanced.arousal * 0.4;

        // 融合后重新规范化
        this.current.dimensions.valence = Math.max(-1, Math.min(1, this.current.dimensions.valence));
        this.current.dimensions.arousal = Math.max(0, Math.min(1, this.current.dimensions.arousal));

        // 如果增强分析置信度高，调整情感类型
        if (Math.abs(enhanced.valence) > 0.5) {
          if (enhanced.label === 'positive' && this.current.primary === 'neutral') {
            this.current.primary = 'happy';
          } else if (enhanced.label === 'negative' && this.current.primary === 'neutral') {
            this.current.primary = 'sad';
          }
        }
        this.markDirty();
      }
    }

    return this.current;
  }

  /** 获取情感对推理策略的影响建议 */
  getReasoningHint(): { strategy: string; caution: string } {
    const { primary, dimensions } = this.current;

    if (dimensions.valence < -0.5) {
      return {
        strategy: '用户情绪负面，优先解决问题而非解释原因',
        caution: '避免过度道歉，直接行动更有效',
      };
    }

    if (dimensions.arousal > 0.7) {
      return {
        strategy: '用户情绪激动，简洁高效地完成任务',
        caution: '避免冗长解释，快速给出结果',
      };
    }
    if (primary === 'confused') {
      return {
        strategy: '用户困惑，分步骤清晰解释',
        caution: '每步确认理解后再继续',
      };
    }
    if (primary === 'curious') {
      return {
        strategy: '用户好奇，可以提供更详细的背景信息',
        caution: '保持信息准确，不编造细节',
      };
    }
    return { strategy: '正常交互', caution: '' };
  }

  decay(): void {
    if (this.current.primary !== 'neutral') {
      this.current.intensity = Math.max(0.1, this.current.intensity - this.decayRate);
      this.current.dimensions.valence *= 0.95;
      this.current.dimensions.arousal *= 0.95;
      if (this.current.intensity <= 0.15) {
        this.current.primary = 'neutral';
        this.current.secondary = null;
        this.current.dimensions = { valence: 0, arousal: 0.5, dominance: 0.5 };
      }
    }
    this.current.energy = Math.min(1.0, this.current.energy + this.decayRate * 0.5);
  }

  /** 生成情感提示词（注入系统提示） */
  getEmotionalPrompt(): string {
    const emoName: Record<Emotion, string> = {
      neutral: '平静专注', happy: '愉悦积极', sad: '略显遗憾', angry: '稍显不满',
      surprised: '感到惊讶', confused: '有些困惑', grateful: '心怀感激',
      curious: '充满好奇', frustrated: '略感挫折', amused: '轻松愉快',
      empathetic: '表示理解', thoughtful: '正在深思', excited: '热情高涨',
      anxious: '略显担忧', disappointed: '有些失望', proud: '引以为傲',
      hopeful: '充满希望',
    };

    const primary = emoName[this.current.primary];
    const secondary = this.current.secondary ? emoName[this.current.secondary] : null;
    let energyLevel: string;
    if (this.current.energy > 0.7) {
      energyLevel = '充沛';
    } else if (this.current.energy > 0.4) {
      energyLevel = '正常';
    } else {
      energyLevel = '较低';
    }

    let prompt = `## 情感状态\n当前情绪: ${primary}`;
    if (secondary) prompt += ` (略带${secondary})`;
    prompt += ` | 能量水平: ${energyLevel} | 投入度: ${Math.round(this.current.intensity * 100)}%`;
    prompt += ` | 效价: ${this.current.dimensions.valence.toFixed(2)} | 唤醒: ${this.current.dimensions.arousal.toFixed(2)}`;

    const ctx = this.getUserMoodSummary();
    if (ctx !== '尚未建立用户情绪画像') {
      prompt += `\n${ctx}`;
    }

    return prompt;
  }

  /** 生成共情响应 */
  generateResponse(contextType: string, result?: string): SympatheticResponse {
    return this.responseGen.generate(this.current, contextType, result);
  }

  // ============ P0 个性化：持久化（跨会话情绪画像） ============

  /** 标记状态已变更，触发防抖保存 */
  private markDirty(): void {
    this.dirty = true;
    if (this.saveTimer) return;
    this.saveTimer = setTimeout(() => {
      this.saveTimer = null;
      this.flushSave();
    }, 2000);
    if (typeof this.saveTimer.unref === 'function') this.saveTimer.unref();
  }

  /** 立即保存状态到磁盘 */
  flushSave(): void {
    if (!this.dirty) return;
    try {
      fs.mkdirSync(this.persistDir, { recursive: true });
      const data = {
        current: this.current,
        history: this.history,
        userMoodMemory: this.userMoodMemory,
        savedAt: Date.now(),
      };
      atomicWriteJsonSync(this.persistPath, data);
      this.dirty = false;
    } catch {
      // 持久化失败不影响运行时情绪追踪
    }
  }

  /**
   * P0 真实修复：dispose — 清理 saveTimer 并强制保存
   * 之前无 dispose 方法，进程退出时 pending 的 saveTimer 不会被触发，
   * 最近 2 秒内的情绪状态变更丢失。
   * 现在由 EnhancedAgentLoop.dispose() 调用，确保退出前落盘。
   */
  dispose(): void {
    if (this.saveTimer) {
      clearTimeout(this.saveTimer);
      this.saveTimer = null;
    }
    this.flushSave();
  }

  /** 从磁盘加载状态 */
  private load(): void {
    try {
      if (!fs.existsSync(this.persistPath)) return;
      const raw = fs.readFileSync(this.persistPath, 'utf-8');
      const data = JSON.parse(raw);
      if (data.current && typeof data.current.primary === 'string') {
        this.current = data.current;
      }
      if (Array.isArray(data.history)) {
        this.history = data.history.slice(-this.maxHistory);
      }
      if (data.userMoodMemory && typeof data.userMoodMemory.interactionCount === 'number') {
        this.userMoodMemory = data.userMoodMemory;
      }
    } catch {
      // 加载失败使用默认状态
    }
  }

  /** 获取用户情绪画像摘要（供 syncFromSource 使用） */
  getUserMoodProfile(): {
    valenceAvg: number;
    arousalAvg: number;
    interactionCount: number;
    dominantEmotion: Emotion;
    frustrationLevel: number;
  } {
    const emotionCounts: Record<string, number> = {};
    for (const h of this.history) {
      emotionCounts[h.primary] = (emotionCounts[h.primary] || 0) + 1;
    }
    let dominantEmotion: Emotion = 'neutral';
    let maxCount = 0;
    for (const [emo, cnt] of Object.entries(emotionCounts)) {
      if (cnt > maxCount) {
        maxCount = cnt;
        dominantEmotion = emo as Emotion;
      }
    }
    const frustrationLevel = (emotionCounts['frustrated'] || 0) + (emotionCounts['angry'] || 0) + (emotionCounts['anxious'] || 0);
    return {
      valenceAvg: this.userMoodMemory.valenceAvg,
      arousalAvg: this.userMoodMemory.arousalAvg,
      interactionCount: this.userMoodMemory.interactionCount,
      dominantEmotion,
      frustrationLevel,
    };
  }
}
