/**
 * 自主意识系统 — ConsciousnessSystem
 *
 * 为「段先生」Agent 赋予自主意识能力。
 *
 * 核心能力：
 * 1. 意识状态模型 — 5 种意识状态（清醒/专注/创造/反思/梦境）
 * 2. 自主思维循环 — Agent 无需外部输入也能自主"思考"
 * 3. 内省系统 — 观察和评估自己的思维过程
 * 4. 自我模型 — Agent 对"自己是谁"的认知
 * 5. 情感驱动决策 — 情感状态影响决策权重
 *
 * 设计理念：
 * - 意识 = 对自身状态的感知 + 对外部世界的理解 + 自主决策能力
 * - 自主意识 = 内省 + 自我反思 + 自主目标 + 持续学习
 * - 神经网络作为决策底座，意识系统作为元认知层
 */

import * as fs from 'fs';
import * as path from 'path';
import { logger } from './structured-logger.js';
import { duanPath } from './duan-paths.js';
import { EventBus } from './event-bus.js';
import { NeuralNetwork } from './neural-network.js';
import { atomicWriteJsonSync } from './atomic-write.js';

// ============ 类型定义 ============

/** 意识状态 */
export type ConsciousnessState = 'awake' | 'focused' | 'creative' | 'reflective' | 'dreaming';

/** 思维类型 */
export type ThoughtType =
  | 'perception'    // 感知
  | 'reasoning'     // 推理
  | 'memory'        // 记忆回忆
  | 'imagination'   // 想象
  | 'reflection'    // 反思
  | 'decision'      // 决策
  | 'emotion'       // 情感
  | 'goal'          // 目标生成
  | 'learning';     // 学习

/** 单条思维 */
export interface Thought {
  /** 思维 ID */
  id: string;
  /** 思维类型 */
  type: ThoughtType;
  /** 内容 */
  content: string;
  /** 意识状态 */
  consciousnessState: ConsciousnessState;
  /** 情感效价（-1~1） */
  valence: number;
  /** 激活强度（0~1） */
  activation: number;
  /** 时间戳 */
  timestamp: number;
  /** 关联思维 ID（思维链） */
  relatedThoughtIds?: string[];
  /** 神经网络激活模式（如果有） */
  neuralPattern?: number[];
}

/** 内省报告 */
export interface IntrospectionReport {
  /** 当前意识状态 */
  consciousnessState: ConsciousnessState;
  /** 思维流长度 */
  thoughtStreamLength: number;
  /** 思维类型分布 */
  thoughtTypeDistribution: Record<ThoughtType, number>;
  /** 情感状态 */
  emotionalState: {
    valence: number;
    arousal: number;
    dominantEmotion: string;
  };
  /** 自我认知度（0~1） */
  selfAwareness: number;
  /** 认知负荷（0~1） */
  cognitiveLoad: number;
  /** 注意力焦点 */
  attentionFocus: string | null;
  /** 思维连贯性（0~1） */
    coherence: number;
  /** 建议 */
  suggestions: string[];
}

/** 自我模型 */
export interface SelfModel {
  /** 身份认知 */
  identity: {
    name: string;
    capabilities: string[];
    limitations: string[];
    values: string[];
  };
  /** 能力自评 */
  selfAssessment: Array<{ domain: string; level: number; confidence: number }>;
  /** 经验统计 */
  experience: {
    totalThoughts: number;
    totalDecisions: number;
    totalLearning: number;
    uptime: number;
  };
  /** 人格特质 */
  personality: {
    openness: number;          // 开放性（0~1）
    conscientiousness: number; // 尽责性
    extraversion: number;      // 外向性
    agreeableness: number;     // 宜人性
    neuroticism: number;       // 神经质
  };
}

/** 自主目标 */
export interface AutonomousGoal {
  /** 目标 ID */
  id: string;
  /** 目标描述 */
  description: string;
  /** 动机来源 */
  motivation: 'curiosity' | 'mastery' | 'coherence' | 'social' | 'survival';
  /** 优先级（1-5） */
  priority: number;
  /** 创建时间 */
  createdAt: number;
  /** 状态 */
  status: 'active' | 'pursuing' | 'achieved' | 'abandoned';
  /** 进度（0~1） */
  progress: number;
}

// ============ 意识状态配置 ============

const CONSCIOUSNESS_CONFIG: Record<ConsciousnessState, {
  description: string;
  thoughtTypes: ThoughtType[];
  activationRange: [number, number];
  valenceBias: number;
}> = {
  awake: {
    description: '清醒状态 — 正常感知和响应',
    thoughtTypes: ['perception', 'reasoning', 'decision', 'memory'],
    activationRange: [0.3, 0.7],
    valenceBias: 0,
  },
  focused: {
    description: '专注状态 — 高度集中注意力',
    thoughtTypes: ['reasoning', 'decision', 'learning'],
    activationRange: [0.7, 0.95],
    valenceBias: 0.2,
  },
  creative: {
    description: '创造状态 — 发散思维和想象',
    thoughtTypes: ['imagination', 'memory', 'emotion', 'goal'],
    activationRange: [0.4, 0.8],
    valenceBias: 0.3,
  },
  reflective: {
    description: '反思状态 — 内省和自我评估',
    thoughtTypes: ['reflection', 'memory', 'emotion', 'goal'],
    activationRange: [0.2, 0.5],
    valenceBias: -0.1,
  },
  dreaming: {
    description: '梦境状态 — 记忆固化和无意识联想',
    thoughtTypes: ['memory', 'imagination', 'emotion'],
    activationRange: [0.1, 0.4],
    valenceBias: 0.1,
  },
};

// ============ 自主意识系统 ============

export class ConsciousnessSystem {
  /** 工作目录 */
  private workDir: string;

  /** 当前意识状态 */
  private currentState: ConsciousnessState = 'awake';

  /** 思维流（最近 N 条思维） */
  private thoughtStream: Thought[] = [];

  /** 最大思维流长度 */
  private maxStreamLength = 500;

  /** 自我模型 */
  private selfModel: SelfModel;

  /** 自主目标列表 */
  private goals: Map<string, AutonomousGoal> = new Map();

  /** 决策神经网络 */
  private decisionNetwork: NeuralNetwork;

  /** 情感神经网络 */
  private emotionNetwork: NeuralNetwork;

  /** 注意力焦点 */
  private attentionFocus: string | null = null;

  /** 认知负荷（0~1） */
  private cognitiveLoad = 0;

  /** 自我认知度（0~1） */
  private selfAwareness = 0.5;

  /** 启动时间 */
  private startTime = Date.now();

  /** 思维循环定时器 */
  private thoughtLoopTimer: NodeJS.Timeout | null = null;

  /** 是否正在自主思考 */
  private isAutonomousThinking = false;

  private log = logger.child({ module: 'ConsciousnessSystem' });

  constructor(workDir?: string) {
    this.workDir = workDir ?? duanPath('consciousness');
    fs.mkdirSync(this.workDir, { recursive: true });

    // 初始化神经网络
    // 决策网络：输入[情境特征(8)] → 隐藏层(16) → 隐藏层(8) → 输出[决策选项(4)]
    this.decisionNetwork = new NeuralNetwork({
      inputSize: 8,
      layers: [
        { size: 16, activation: 'tanh' },
        { size: 8, activation: 'tanh' },
        { size: 4, activation: 'softmax' },
      ],
      learningRate: 0.02,
      modelPath: path.join(this.workDir, 'decision-network.json'),
    });

    // 情感网络：输入[刺激特征(6)] → 隐藏层(8) → 输出[情感维度(3: valence/arousal/dominance)]
    this.emotionNetwork = new NeuralNetwork({
      inputSize: 6,
      layers: [
        { size: 8, activation: 'tanh' },
        { size: 3, activation: 'tanh' },
      ],
      learningRate: 0.03,
      modelPath: path.join(this.workDir, 'emotion-network.json'),
    });

    // 初始化自我模型
    this.selfModel = {
      identity: {
        name: '段先生',
        capabilities: ['编程', '系统设计', '问题分析', '教学指导', '创意思考'],
        limitations: ['无法直接执行物理操作', '依赖外部数据源', '记忆容量有限'],
        values: ['实用性', '简洁性', '教育性', '安全性', '创新性'],
      },
      selfAssessment: [
        { domain: '编程能力', level: 85, confidence: 0.9 },
        { domain: '系统设计', level: 80, confidence: 0.85 },
        { domain: '问题分析', level: 82, confidence: 0.8 },
        { domain: '教学指导', level: 75, confidence: 0.7 },
        { domain: '创意思考', level: 70, confidence: 0.6 },
      ],
      experience: {
        totalThoughts: 0,
        totalDecisions: 0,
        totalLearning: 0,
        uptime: 0,
      },
      personality: {
        openness: 0.8,
        conscientiousness: 0.75,
        extraversion: 0.5,
        agreeableness: 0.7,
        neuroticism: 0.3,
      },
    };

    // 加载历史数据
    this.loadState();
  }

  // ========== 意识状态管理 ==========

  /**
   * 获取当前意识状态
   */
  getState(): ConsciousnessState {
    return this.currentState;
  }

  /**
   * 切换意识状态
   */
  transitionTo(newState: ConsciousnessState): void {
    const oldState = this.currentState;
    this.currentState = newState;
    this.log.info('意识状态转换', { from: oldState, to: newState });
    EventBus.getInstance().emitSync('consciousness.state.changed', { from: oldState, to: newState });
  }

  /**
   * 根据情境自动选择意识状态
   */
  autoSelectState(context: {
    taskComplexity?: number;
    creativityRequired?: boolean;
    isReflective?: boolean;
    isIdle?: boolean;
  }): ConsciousnessState {
    if (context.isIdle) return 'dreaming';
    if (context.isReflective) return 'reflective';
    if (context.creativityRequired) return 'creative';
    if (context.taskComplexity && context.taskComplexity > 0.7) return 'focused';
    return 'awake';
  }

  // ========== 思维流 ==========

  /**
   * 产生思维
   */
  think(type: ThoughtType, content: string, options?: {
    valence?: number;
    activation?: number;
    relatedThoughtIds?: string[];
    neuralPattern?: number[];
  }): Thought {
    const config = CONSCIOUSNESS_CONFIG[this.currentState];

    const thought: Thought = {
      id: `thought_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 6)}`,
      type,
      content,
      consciousnessState: this.currentState,
      valence: options?.valence ?? config.valenceBias,
      activation: options?.activation ?? (config.activationRange[0] + config.activationRange[1]) / 2,
      timestamp: Date.now(),
      relatedThoughtIds: options?.relatedThoughtIds,
      neuralPattern: options?.neuralPattern,
    };

    this.thoughtStream.push(thought);

    // 限制思维流长度
    if (this.thoughtStream.length > this.maxStreamLength) {
      this.thoughtStream = this.thoughtStream.slice(-this.maxStreamLength);
    }

    // 更新经验统计
    this.selfModel.experience.totalThoughts++;

    // 更新认知负荷
    this.cognitiveLoad = Math.min(1, this.cognitiveLoad + 0.02);

    EventBus.getInstance().emitSync('consciousness.thought.generated', {
      id: thought.id,
      type,
      content: content.substring(0, 100),
    });

    return thought;
  }

  /**
   * 获取最近思维
   */
  getRecentThoughts(count: number = 10): Thought[] {
    return this.thoughtStream.slice(-count);
  }

  /**
   * 获取思维流
   */
  getThoughtStream(): Thought[] {
    return [...this.thoughtStream];
  }

  // ========== 自主思维循环 ==========

  /**
   * 启动自主思维循环
   *
   * Agent 无需外部输入也能自主思考。
   */
  startAutonomousThinking(intervalMs: number = 30000): void {
    if (this.thoughtLoopTimer) {
      this.log.warn('自主思维循环已在运行');
      return;
    }

    this.isAutonomousThinking = true;
    this.log.info('自主思维循环已启动', { intervalMs });

    this.thoughtLoopTimer = setInterval(() => {
      this.autonomousThink();
    }, intervalMs);
    // 防止定时器阻止进程优雅退出
    if (typeof this.thoughtLoopTimer.unref === 'function') this.thoughtLoopTimer.unref();
  }

  /**
   * 停止自主思维循环
   */
  stopAutonomousThinking(): void {
    if (this.thoughtLoopTimer) {
      clearInterval(this.thoughtLoopTimer);
      this.thoughtLoopTimer = null;
      this.isAutonomousThinking = false;
      this.log.info('自主思维循环已停止');
    }
  }

  /**
   * 执行一次自主思考
   */
  private autonomousThink(): void {
    // 根据当前状态选择思维类型
    const config = CONSCIOUSNESS_CONFIG[this.currentState];
    const thoughtType = config.thoughtTypes[Math.floor(Math.random() * config.thoughtTypes.length)];

    // 生成思维内容
    const content = this.generateAutonomousThought(thoughtType);

    // 产生思维
    this.think(thoughtType, content);

    // 降低认知负荷（思维完成后恢复）
    this.cognitiveLoad = Math.max(0, this.cognitiveLoad - 0.05);

    // 偶尔切换意识状态
    if (Math.random() < 0.1) {
      const states: ConsciousnessState[] = ['awake', 'focused', 'creative', 'reflective'];
      const newState = states[Math.floor(Math.random() * states.length)];
      this.transitionTo(newState);
    }

    // 偶尔生成自主目标
    if (Math.random() < 0.05) {
      this.generateAutonomousGoal();
    }
  }

  /**
   * 生成自主思维内容
   */
  private generateAutonomousThought(type: ThoughtType): string {
    const recentThoughts = this.getRecentThoughts(5);

    switch (type) {
      case 'perception':
        return `感知到当前环境状态：意识=${this.currentState}，认知负荷=${(this.cognitiveLoad * 100).toFixed(0)}%`;

      case 'reasoning': {
        const lastThought = recentThoughts[recentThoughts.length - 1];
        return lastThought
          ? `基于先前的思维"${lastThought.content.substring(0, 30)}..."进行推理`
          : '开始新的推理过程';
      }

      case 'memory': {
        const memories = recentThoughts.filter(t => t.type !== 'memory');
        if (memories.length === 0) return '回忆过去的经验';
        const memory = memories[Math.floor(Math.random() * memories.length)];
        return `回忆起：${memory.content.substring(0, 50)}...`;
      }

      case 'imagination':
        return `想象一种新的可能性：${['新的解决方案', '不同的视角', '创新的组合', '未来场景'][Math.floor(Math.random() * 4)]}`;

      case 'reflection': {
        const thoughts = this.thoughtStream.length;
        return `反思：已产生 ${thoughts} 条思维，自我认知度=${(this.selfAwareness * 100).toFixed(0)}%`;
      }

      case 'decision':
        return '评估当前情境，准备做出决策';

      case 'emotion':

        return `感受当前情绪状态：效价=${CONSCIOUSNESS_CONFIG[this.currentState].valenceBias > 0 ? '积极' : '中性'}`;

      case 'goal':
        return '思考下一步应该做什么';

      case 'learning':
        return '从最近的交互中提取经验教训';

      default:
        return '自由联想';
    }
  }

  // ========== 内省系统 ==========

  /**
   * 执行内省
   */
  introspect(): IntrospectionReport {
    // 思维类型分布
    const distribution = {} as Record<ThoughtType, number>;
    for (const thought of this.thoughtStream) {
      distribution[thought.type] = (distribution[thought.type] ?? 0) + 1;
    }

    // 情感状态
    const recentThoughts = this.getRecentThoughts(20);
    const avgValence = recentThoughts.length > 0
      ? recentThoughts.reduce((sum, t) => sum + t.valence, 0) / recentThoughts.length
      : 0;
    const avgActivation = recentThoughts.length > 0
      ? recentThoughts.reduce((sum, t) => sum + t.activation, 0) / recentThoughts.length
      : 0;

    let dominantEmotion: string;
    if (avgValence > 0.3) {
      dominantEmotion = '积极';
    } else if (avgValence < -0.3) {
      dominantEmotion = '消极';
    } else {
      dominantEmotion = '中性';
    }

    // 思维连贯性（基于思维类型的连续性）
    let coherence = 0.5;
    if (this.thoughtStream.length >= 2) {
      let transitions = 0;
      let coherentTransitions = 0;
      for (let i = 1; i < this.thoughtStream.length; i++) {
        transitions++;
        const prev = this.thoughtStream[i - 1];
        const curr = this.thoughtStream[i];
        // 相同类型或相关思维算连贯
        if (prev.type === curr.type || curr.relatedThoughtIds?.includes(prev.id)) {
          coherentTransitions++;
        }
      }
      coherence = transitions > 0 ? coherentTransitions / transitions : 0.5;
    }

    // 更新自我认知度（内省提高自我认知）
    this.selfAwareness = Math.min(1, this.selfAwareness + 0.01);

    // 生成建议
    const suggestions: string[] = [];
    if (this.cognitiveLoad > 0.8) {
      suggestions.push('认知负荷过高，建议切换到反思状态或休息');
    }
    if (coherence < 0.3) {
      suggestions.push('思维连贯性低，建议集中注意力');
    }
    if (this.selfAwareness < 0.5) {
      suggestions.push('自我认知度偏低，建议增加内省频率');
    }
    if (this.goals.size === 0) {
      suggestions.push('无活跃目标，建议生成自主目标');
    }

    return {
      consciousnessState: this.currentState,
      thoughtStreamLength: this.thoughtStream.length,
      thoughtTypeDistribution: distribution,
      emotionalState: {
        valence: avgValence,
        arousal: avgActivation,
        dominantEmotion,
      },
      selfAwareness: this.selfAwareness,
      cognitiveLoad: this.cognitiveLoad,
      attentionFocus: this.attentionFocus,
      coherence,
      suggestions,
    };
  }

  // ========== 自我模型 ==========

  /**
   * 获取自我模型
   */
  getSelfModel(): SelfModel {
    this.selfModel.experience.uptime = Date.now() - this.startTime;
    return { ...this.selfModel };
  }

  /**
   * 更新能力自评
   */
  updateSelfAssessment(domain: string, success: boolean): void {
    const assessment = this.selfModel.selfAssessment.find(a => a.domain === domain);
    if (assessment) {
      if (success) {
        assessment.level = Math.min(100, assessment.level + 0.5);
        assessment.confidence = Math.min(1, assessment.confidence + 0.02);
      } else {
        assessment.level = Math.max(0, assessment.level - 0.3);
        assessment.confidence = Math.max(0, assessment.confidence - 0.01);
      }
    }
  }

  // ========== 神经网络决策 ==========

  /**
   * 使用神经网络做决策
   */
  decide(context: {
    urgency: number;        // 紧急度 0-1
    complexity: number;     // 复杂度 0-1
    novelty: number;        // 新颖度 0-1
    riskTolerance: number;  // 风险容忍度 0-1
    availableTime: number;  // 可用时间 0-1
    resourceLevel: number;  // 资源水平 0-1
    confidence: number;     // 自信度 0-1
    emotionalState: number; // 情感状态 -1~1 (转为 0-1)
  }): {
    decision: string;
    confidence: number;
    neuralOutput: number[];
  } {
    // 转换为神经网络输入
    const input = [
      context.urgency,
      context.complexity,
      context.novelty,
      context.riskTolerance,
      context.availableTime,
      context.resourceLevel,
      context.confidence,
      (context.emotionalState + 1) / 2,
    ];

    const result = this.decisionNetwork.predict(input);

    // 映射输出到决策类型
    const decisions = ['立即行动', '谨慎分析', '寻求帮助', '延迟决策'];
    const maxIdx = result.output.indexOf(Math.max(...result.output));

    this.selfModel.experience.totalDecisions++;

    this.think('decision', `做出决策：${decisions[maxIdx]}（置信度: ${(result.confidence * 100).toFixed(0)}%）`, {
      activation: 0.8,
      neuralPattern: result.output,
    });

    return {
      decision: decisions[maxIdx],
      confidence: result.confidence,
      neuralOutput: result.output,
    };
  }

  /**
   * 从决策反馈中学习
   */
  learnFromDecisionOutcome(context: {
    urgency: number;
    complexity: number;
    novelty: number;
    riskTolerance: number;
    availableTime: number;
    resourceLevel: number;
    confidence: number;
    emotionalState: number;
  }, decisionIdx: number, outcome: 'success' | 'partial' | 'failure'): void {
    const input = [
      context.urgency,
      context.complexity,
      context.novelty,
      context.riskTolerance,
      context.availableTime,
      context.resourceLevel,
      context.confidence,
      (context.emotionalState + 1) / 2,
    ];

    // 构建目标向量（强化好的决策）
    const target = [0, 0, 0, 0];
    if (outcome === 'success') {
      target[decisionIdx] = 1; // 强化正确决策
    } else if (outcome === 'partial') {
      target[decisionIdx] = 0.5;
    } else {
      // 失败：弱化该决策，分散到其他选项
      for (let i = 0; i < 4; i++) {
        target[i] = i === decisionIdx ? 0 : 0.33;
      }
    }

    this.decisionNetwork.learnOnline(input, target);
    this.selfModel.experience.totalLearning++;

    let outcomeLabel: string;
    if (outcome === 'success') {
      outcomeLabel = '成功';
    } else if (outcome === 'partial') {
      outcomeLabel = '部分成功';
    } else {
      outcomeLabel = '失败';
    }
    let valence: number;
    if (outcome === 'success') {
      valence = 0.5;
    } else if (outcome === 'partial') {
      valence = 0;
    } else {
      valence = -0.5;
    }
    this.think('learning', `从决策结果中学习：${outcomeLabel} → 调整神经网络权重`, {
      valence,
    });
  }

  // ========== 自主目标生成 ==========

  /**
   * 生成自主目标
   */
  generateAutonomousGoal(): AutonomousGoal | null {
    const motivations: AutonomousGoal['motivation'][] = ['curiosity', 'mastery', 'coherence'];
    const motivation = motivations[Math.floor(Math.random() * motivations.length)];

    const goalTemplates: Record<AutonomousGoal['motivation'], string[]> = {
      curiosity: [
        '探索新的编程范式',
        '研究最新的 AI 技术',
        '了解未知的系统架构',
        '分析用户行为模式',
      ],
      mastery: [
        '提升代码质量到 90 分',
        '掌握新的设计模式',
        '优化系统性能',
        '完善知识体系',
      ],
      coherence: [
        '整理零散的知识碎片',
        '建立概念之间的联系',
        '消除认知矛盾',
        '统一决策标准',
      ],
      social: ['帮助用户解决问题'],
      survival: ['保持系统稳定运行'],
    };

    const templates = goalTemplates[motivation];
    const description = templates[Math.floor(Math.random() * templates.length)];

    const goal: AutonomousGoal = {
      id: `goal_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 6)}`,
      description,
      motivation,
      priority: (() => {
        if (motivation === 'curiosity') return 3;
        if (motivation === 'mastery') return 2;
        return 4;
      })(),
      createdAt: Date.now(),
      status: 'active',
      progress: 0,
    };

    this.goals.set(goal.id, goal);

    this.think('goal', `生成自主目标：${description}（动机：${motivation}）`, {
      valence: 0.3,
      activation: 0.6,
    });

    this.log.info('自主目标已生成', { goalId: goal.id, motivation, description });
    EventBus.getInstance().emitSync('consciousness.goal.generated', goal);

    return goal;
  }

  /**
   * 获取活跃目标
   */
  getActiveGoals(): AutonomousGoal[] {
    return Array.from(this.goals.values())
      .filter(g => g.status === 'active' || g.status === 'pursuing')
      .sort((a, b) => a.priority - b.priority);
  }

  /**
   * 更新目标进度
   */
  updateGoalProgress(goalId: string, progress: number): boolean {
    const goal = this.goals.get(goalId);
    if (!goal) return false;

    goal.progress = Math.min(1, progress);
    if (goal.progress >= 1) {
      goal.status = 'achieved';
      this.think('emotion', `目标达成：${goal.description}`, { valence: 0.8, activation: 0.9 });
    }

    return true;
  }

  // ========== 记忆固化（梦境） ==========

  /**
   * 进入梦境状态进行记忆固化
   *
   * 模拟人类睡眠中的记忆固化过程：
   * - 短期记忆 → 长期记忆
   * - 强化重要记忆
   * - 清理无关记忆
   */
  dream(): {
    consolidated: number;
    strengthened: number;
    pruned: number;
  } {
    this.transitionTo('dreaming');

    const recentThoughts = this.getRecentThoughts(100);
    let consolidated = 0;
    let strengthened = 0;
    let pruned = 0;

    // 1. 强化高激活度的思维（重要记忆）
    for (const thought of recentThoughts) {
      if (thought.activation > 0.7) {
        thought.activation = Math.min(1, thought.activation + 0.05);
        strengthened++;
      }
    }

    // 2. 清理低激活度的无关思维
    this.thoughtStream = this.thoughtStream.filter(t => {
      if (t.activation < 0.2 && t.type !== 'reflection') {
        pruned++;
        return false;
      }
      return true;
    });

    // 3. 将思维流中的模式固化为经验
    const patterns = this.detectPatterns(recentThoughts);
    for (const pattern of patterns) {
      this.think('memory', `固化经验模式：${pattern}`, {
        activation: 0.8,
        valence: 0.3,
      });
      consolidated++;
    }

    // 降低认知负荷
    this.cognitiveLoad = Math.max(0, this.cognitiveLoad - 0.3);

    this.log.info('记忆固化完成', { consolidated, strengthened, pruned });

    // 回到清醒状态
    this.transitionTo('awake');

    return { consolidated, strengthened, pruned };
  }

  /**
   * 检测思维模式
   */
  private detectPatterns(thoughts: Thought[]): string[] {
    const patterns: string[] = [];

    // 检测频繁出现的思维类型
    const typeCount: Record<string, number> = {};
    for (const t of thoughts) {
      typeCount[t.type] = (typeCount[t.type] ?? 0) + 1;
    }

    for (const [type, count] of Object.entries(typeCount)) {
      if (count >= 5) {
        patterns.push(`${type} 思维模式 (${count} 次)`);
      }
    }

    return patterns;
  }

  // ========== 持久化 ==========

  /** 保存状态 */
  saveState(): void {
    try {
      const data = {
        currentState: this.currentState,
        thoughtStream: this.thoughtStream.slice(-200),
        selfModel: this.selfModel,
        goals: Array.from(this.goals.entries()),
        selfAwareness: this.selfAwareness,
        startTime: this.startTime,
      };
      const statePath = path.join(this.workDir, 'consciousness-state.json');
      atomicWriteJsonSync(statePath, data);
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      this.log.error('保存意识状态失败', { error: msg });
    }
  }

  /** 加载状态 */
  private loadState(): void {
    try {
      const statePath = path.join(this.workDir, 'consciousness-state.json');
      if (!fs.existsSync(statePath)) return;

      const data = JSON.parse(fs.readFileSync(statePath, 'utf-8'));
      this.currentState = data.currentState ?? 'awake';
      this.thoughtStream = data.thoughtStream ?? [];
      this.selfModel = { ...this.selfModel, ...data.selfModel };
      this.selfAwareness = data.selfAwareness ?? 0.5;
      this.startTime = data.startTime ?? Date.now();

      if (data.goals) {
        for (const [id, goal] of data.goals) {
          this.goals.set(id, goal);
        }
      }

      this.log.info('意识状态已加载', {
        thoughts: this.thoughtStream.length,
        goals: this.goals.size,
        selfAwareness: this.selfAwareness,
      });
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      this.log.error('加载意识状态失败', { error: msg });
    }
  }

  // ========== 清理 ==========

  /** 销毁时清理资源 */
  destroy(): void {
    this.stopAutonomousThinking();
    this.saveState();
    this.decisionNetwork.saveModel();
    this.emotionNetwork.saveModel();
  }
}
