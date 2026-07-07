/**
 * 多模态情感交互系统
 * 提供情感识别、情感表达、共情能力、风格适应、视觉表达等核心能力
 */

/** 情感分类 */
export type EmotionCategory =
  | 'joy' | 'sadness' | 'anger' | 'fear'
  | 'surprise' | 'disgust' | 'trust' | 'anticipation' | 'neutral';

/** 风格类型 */
export type StyleType =
  | '正式' | '轻松' | '温暖' | '专业' | '幽默' | '鼓励' | '安慰';

/** 情感状态 */
export interface EmotionState {
  /** 主情感 */
  primary: EmotionCategory;
  /** 次情感 */
  secondary: EmotionCategory | null;
  /** 强度 0-1 */
  intensity: number;
  /** 效价：正或负 */
  valence: 'positive' | 'negative' | 'neutral';
  /** 激活度 0-1 */
  arousal: number;
}

/** 情感化回复 */
export interface EmotionResponse {
  /** 回复内容 */
  content: string;
  /** 语气风格 */
  style: StyleType;
  /** 表情符号 */
  emoji: string;
  /** 情感标签 */
  emotionTag: EmotionCategory;
}

/** 共情回应 */
export interface EmpathyResponse {
  /** 认可感受 */
  acknowledgment: string;
  /** 表达理解 */
  understanding: string;
  /** 提供支持 */
  support: string;
  /** 引导行动 */
  guidance: string;
}

/** 风格化内容 */
export interface StyledContent {
  /** 适配后的内容 */
  content: string;
  /** 使用的风格 */
  style: StyleType;
  /** 语气调整说明 */
  toneNote: string;
}

/** 视觉提示 */
export interface VisualCue {
  /** 表情符号 */
  emoji: string;
  /** 颜色提示（十六进制） */
  color: string;
  /** 视觉描述 */
  description: string;
  /** 动画建议 */
  animation: string;
}

/** 情感关键词映射 */
const EMOTION_KEYWORDS: Record<EmotionCategory, string[]> = {
  joy: ['开心', '高兴', '快乐', '幸福', '棒', '太好了', '哈哈', '喜欢', '爱', '美好'],
  sadness: ['难过', '伤心', '悲伤', '失望', '痛苦', '遗憾', '可惜', '孤独', '寂寞', '哭'],
  anger: ['生气', '愤怒', '烦', '讨厌', '气死', '受够了', '可恶', '混蛋', '火大', '暴怒'],
  fear: ['害怕', '恐惧', '担心', '焦虑', '紧张', '不安', '慌', '可怕', '恐怖', '忧虑'],
  surprise: ['惊讶', '意外', '没想到', '天哪', '哇', '居然', '竟然', '不可思议', '震惊', '没想到'],
  disgust: ['恶心', '厌恶', '反感', '讨厌', '受不了', '呕吐', '脏', '丑', '糟糕', '鄙夷'],
  trust: ['信任', '相信', '可靠', '放心', '安心', '依赖', '真诚', '诚实', '靠谱', '踏实'],
  anticipation: ['期待', '盼望', '希望', '渴望', '憧憬', '向往', '等不及', '兴奋', '期盼', '展望'],
  neutral: [],
};

/** 情感效价映射 */
const EMOTION_VALENCE: Record<EmotionCategory, 'positive' | 'negative' | 'neutral'> = {
  joy: 'positive', sadness: 'negative', anger: 'negative', fear: 'negative',
  surprise: 'neutral', disgust: 'negative', trust: 'positive',
  anticipation: 'positive', neutral: 'neutral',
};

/** 情感激活度映射 */
const EMOTION_AROUSAL: Record<EmotionCategory, number> = {
  joy: 0.8, sadness: 0.3, anger: 0.9, fear: 0.85,
  surprise: 0.75, disgust: 0.5, trust: 0.4,
  anticipation: 0.7, neutral: 0.2,
};

/** 情感视觉提示映射 */
const EMOTION_VISUAL: Record<EmotionCategory, VisualCue> = {
  joy: { emoji: '😊', color: '#FFD700', description: '明亮温暖的金色', animation: '轻微弹跳' },
  sadness: { emoji: '😢', color: '#6495ED', description: '柔和沉静的蓝色', animation: '缓慢淡入' },
  anger: { emoji: '😠', color: '#FF4500', description: '强烈炽热的红色', animation: '快速震动' },
  fear: { emoji: '😨', color: '#9370DB', description: '暗淡神秘的紫色', animation: '轻微闪烁' },
  surprise: { emoji: '😮', color: '#FF8C00', description: '醒目活力的橙色', animation: '放大弹出' },
  disgust: { emoji: '🤢', color: '#556B2F', description: '暗沉压抑的橄榄色', animation: '轻微摇晃' },
  trust: { emoji: '🤝', color: '#3CB371', description: '沉稳可靠的绿色', animation: '平稳渐显' },
  anticipation: { emoji: '✨', color: '#DA70D6', description: '充满期待的紫色', animation: '闪烁渐亮' },
  neutral: { emoji: '😐', color: '#A9A9A9', description: '中性的灰色', animation: '无' },
};

/** 情感对应默认风格 */
const EMOTION_STYLE: Record<EmotionCategory, StyleType> = {
  joy: '轻松', sadness: '安慰', anger: '专业', fear: '温暖',
  surprise: '轻松', disgust: '专业', trust: '温暖',
  anticipation: '鼓励', neutral: '正式',
};

/** 情感对应表情符号 */
const EMOTION_EMOJI: Record<EmotionCategory, string> = {
  joy: '😊', sadness: '💙', anger: '😤', fear: '🫂',
  surprise: '😲', disgust: '🙅', trust: '🤝',
  anticipation: '🌟', neutral: '📝',
};

/**
 * 多模态情感交互系统
 */
export class EmotionInteractionSystem {
  /**
   * 计算情感强度
   * 基于匹配数与文本长度进行归一化，neutral 使用独立的低强度逻辑
   */
  private computeIntensity(category: EmotionCategory, matchCount: number, textLength: number): number {
    if (category === 'neutral') {
      // neutral 独立的低强度逻辑：基础值低且增长缓慢
      return this.clamp(0.1 + matchCount / (matchCount + Math.max(textLength, 1)) * 0.2, 0, 0.4);
    }
    // 归一化：匹配数相对于文本长度的占比，匹配越密集强度越高
    const density = matchCount / (matchCount + Math.max(textLength, 1));
    return this.clamp(density / (density + 0.1), 0, 1);
  }

  /**
   * 情感识别：多通道情感分析
   * 综合文本情感、语气推断和上下文情绪进行分析
   */
  recognizeEmotion(text: string, context?: string[]): EmotionState {
    const textEmotion = this.analyzeTextEmotion(text);
    const contextEmotion = context ? this.analyzeContextEmotion(context) : null;

    // 融合文本情感与上下文情感
    let primary = textEmotion.primary;
    let intensity = textEmotion.intensity;
    let secondary = textEmotion.secondary;

    if (contextEmotion && contextEmotion.intensity > 0.3) {
      // 上下文情感较强时进行融合
      if (contextEmotion.primary !== primary && contextEmotion.intensity > textEmotion.intensity) {
        secondary = primary;
        primary = contextEmotion.primary;
      } else if (contextEmotion.primary !== primary) {
        secondary = contextEmotion.primary;
      }
      intensity = Math.min(1, (intensity + contextEmotion.intensity) / 2 + 0.1);
    }

    return {
      primary,
      secondary,
      intensity: this.clamp(intensity, 0, 1),
      valence: EMOTION_VALENCE[primary],
      arousal: EMOTION_AROUSAL[primary],
    };
  }

  /**
   * 生成情感化回复
   * 根据情感状态调整回复风格、语气和表情符号
   */
  generateResponse(emotion: EmotionState, content: string): EmotionResponse {

    const style = EMOTION_STYLE[emotion.primary];
    const styled = this.adaptStyle(emotion, content);
    return {
      content: styled.content,
      style,
      emoji: EMOTION_EMOJI[emotion.primary],
      emotionTag: emotion.primary,
    };
  }

  /**
   * 共情回应
   * 遵循策略：认可感受 → 表达理解 → 提供支持 → 引导行动
   */
  empathize(userState: EmotionState): EmpathyResponse {
    const { primary, intensity, valence } = userState;

    const acknowledgment = this.buildAcknowledgment(primary, intensity);
    const understanding = this.buildUnderstanding(primary, valence);
    const support = this.buildSupport(primary, intensity);
    const guidance = this.buildGuidance(primary, valence);

    return { acknowledgment, understanding, support, guidance };
  }

  /**
   * 风格适应
   * 根据情感状态调整语言风格
   */
  adaptStyle(emotion: EmotionState, baseContent: string): StyledContent {
    const style = EMOTION_STYLE[emotion.primary];
    let content = baseContent;
    let toneNote = '';

    switch (style) {
      case '温暖':
        content = `亲爱的，${content}，我一直在这里陪着你 💕`;
        toneNote = '使用亲切称呼和陪伴表达';
        break;
      case '安慰':
        content = `我理解这并不容易，${content}，一切都会好起来的 🌈`;
        toneNote = '先表达理解再给予希望';
        break;
      case '鼓励':
        content = `${content}，你做得很棒，继续加油！💪`;
        toneNote = '肯定努力并激励前行';
        break;
      case '轻松':
        content = `嘿～${content} 😄`;
        toneNote = '轻松活泼的语气';
        break;
      case '专业':
        content = `${content}。如有需要，我可以进一步协助。`;
        toneNote = '保持客观专业';
        break;
      case '幽默':
        content = `${content} 😄 话说回来，生活总要有点乐子嘛！`;
        toneNote = '适度幽默缓解气氛';
        break;
      case '正式':
      default:
        toneNote = '保持正式规范的表达';
        break;
    }

    return { content, style, toneNote };
  }

  /**
   * 获取视觉提示
   * 通过表情符号、颜色和动画传达情感
   */
  getVisualCue(emotion: EmotionState): VisualCue {
    const base = { ...EMOTION_VISUAL[emotion.primary] };
    // 根据强度调整动画描述
    if (emotion.intensity > 0.8) {
      base.description = `强烈的${base.description}`;
    } else if (emotion.intensity < 0.3) {
      base.description = `轻微的${base.description}`;
    }
    return base;
  }

  // ========== 私有方法 ==========

  /** 分析文本情感 */
  private analyzeTextEmotion(text: string): EmotionState {
    let maxScore = 0;
    let primary: EmotionCategory = 'neutral';
    let secondScore = 0;
    let secondary: EmotionCategory | null = null;

    for (const [emotion, keywords] of Object.entries(EMOTION_KEYWORDS) as [EmotionCategory, string[]][]) {
      if (emotion === 'neutral') continue;
      const score = this.calculateKeywordScore(text, keywords);
      if (score > maxScore) {
        secondScore = maxScore;
        secondary = primary;
        maxScore = score;
        primary = emotion;
      } else if (score > secondScore) {
        secondScore = score;
        secondary = emotion;
      }
    }

    const intensity = Math.min(1, maxScore * 0.3 + 0.2);
    return {
      primary,
      secondary: secondScore > 0 ? secondary : null,
      intensity,
      valence: EMOTION_VALENCE[primary],
      arousal: EMOTION_AROUSAL[primary],
    };
  }

  /** 分析上下文情绪 */
  private analyzeContextEmotion(context: string[]): EmotionState {
    if (context.length === 0) {
      return { primary: 'neutral', secondary: null, intensity: 0, valence: 'neutral', arousal: 0.2 };
    }
    // 对最近的消息赋予更高权重
    const recentText = context.slice(-3).join(' ');
    return this.analyzeTextEmotion(recentText);
  }

  /** 计算关键词匹配得分 */
  private calculateKeywordScore(text: string, keywords: string[]): number {
    let score = 0;
    const lower = text.toLowerCase();
    for (const kw of keywords) {
      if (lower.includes(kw)) {
        score += 1;
      }
    }
    return score;
  }

  /** 构建认可感受 */
  private buildAcknowledgment(emotion: EmotionCategory, intensity: number): string {
    const map: Record<EmotionCategory, string> = {
      joy: '我能感受到你的喜悦', sadness: '我听到了你内心的难过',
      anger: '我理解你现在的愤怒', fear: '我感受到你的不安',
      surprise: '我理解这让你很意外', disgust: '我知道这让你很不舒服',
      trust: '感谢你对我的信任', anticipation: '我感受到你的期待',
      neutral: '我理解你的想法',
    };
    const base = map[emotion];
    return intensity > 0.7 ? `${base}，这种感受非常强烈。` : `${base}。`;
  }

  /** 构建表达理解 */
  private buildUnderstanding(emotion: EmotionCategory, valence: string): string {
    const map: Record<string, string> = {
      positive: '这种积极的感受是值得珍惜的，每个人都有权利享受美好。',
      negative: '这种感受是完全正常的，每个人都会经历这样的时刻，你并不孤单。',
      neutral: '每个人的感受都值得被尊重和理解。',
    };
    return map[valence];
  }

  /** 构建提供支持 */
  private buildSupport(emotion: EmotionCategory, intensity: number): string {
    const map: Record<EmotionCategory, string> = {
      joy: '让我们一起珍惜这份快乐，把美好延续下去。',
      sadness: '我会一直在这里陪伴你，随时愿意倾听。',
      anger: '让我们一起找到解决问题的方法，你不是一个人在面对。',
      fear: '别担心，我会陪着你一起面对，一步一步来。',
      surprise: '不管结果如何，我都会支持你的决定。',
      disgust: '你的感受很重要，我们可以一起找到更好的选择。',
      trust: '我会继续努力，不辜负你的信任。',
      anticipation: '让我们一起为期待的事情做好准备！',
      neutral: '如果你需要任何帮助，我随时都在。',
    };
    return intensity > 0.7 ? `${map[emotion]} 请记住，你不需要独自承担。` : map[emotion];
  }

  /** 构建引导行动 */
  private buildGuidance(emotion: EmotionCategory, valence: string): string {
    const positiveMap: Partial<Record<EmotionCategory, string>> = {
      joy: '不妨把这份快乐分享给身边的人，让美好传递。',
      trust: '可以尝试把这份信任转化为行动，迈出下一步。',
      anticipation: '可以制定一个小计划，让期待变成现实。',
    };
    const negativeMap: Partial<Record<EmotionCategory, string>> = {
      sadness: '试着做一些让自己放松的小事，比如散步或听音乐。',
      anger: '深呼吸几次，等情绪平复后，我们再一起分析原因。',
      fear: '把担心的事情写下来，逐一分析，也许没有想象中那么可怕。',
      disgust: '给自己一些空间，远离让你不适的事物，关注让你舒适的部分。',
    };

    if (valence === 'positive' && positiveMap[emotion]) return positiveMap[emotion]!;
    if (valence === 'negative' && negativeMap[emotion]) return negativeMap[emotion]!;
    return '如果需要，我们可以继续聊聊，找到最适合你的方向。';
  }

  /** 数值限制 */
  private clamp(value: number, min: number, max: number): number {
    return Math.max(min, Math.min(max, value));
  }
}
