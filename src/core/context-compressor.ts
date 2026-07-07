/**
 * 动态上下文压缩器
 * 对长对话历史进行智能压缩，保留关键信息
 */

import { EventBus, Events } from './event-bus.js';
import { ModelLibrary } from './model-library.js';

/**
 * 技术实体关键词列表（统一维护）
 * 用于 extractKeyInfoFromMessages 和 scoreImportanceEnhanced 中的技术实体识别
 */
export const TECH_ENTITY_KEYWORDS = [
  'React',
  'Vue',
  'Angular',
  'Node\\.js',
  'Node',
  'Next\\.js',
  'Nuxt',
  'Express',
  'Koa',
  'TypeScript',
  'JavaScript',
  'Python',
  'Java',
  'Go',
  'Rust',
  'Docker',
  'Kubernetes',
  'Redis',
  'MySQL',
  'PostgreSQL',
  'MongoDB',
  'GraphQL',
  'Webpack',
  'Vite',
] as const;

/** 技术实体识别正则（基于统一关键词列表构建） */
export const TECH_ENTITY_REGEX = new RegExp(
  `\\b(${TECH_ENTITY_KEYWORDS.join('|')})\\b`,
  'gi'
);

/** 消息 */
interface Message {
  role: 'user' | 'assistant' | 'system';
  content: string;
  timestamp?: number;
  importance?: number;
}

/** 压缩结果 */
interface CompressionResult {
  compressedMessages: Message[];
  summary: string;
  keyPoints: string[];
  entities: string[];
  topicSegments: TopicSegment[];
  compressionRatio: number;
  originalTokenEstimate: number;
  compressedTokenEstimate: number;
  /** 压缩质量评估 */
  qualityAssessment?: CompressionQualityAssessment;
}

/** 主题段落 */
interface TopicSegment {
  startIndex: number;
  endIndex: number;
  topic: string;
  summary: string;
  keyDecisions: string[];
}

/** 压缩质量评估结果 */
interface CompressionQualityAssessment {
  /** 关键信息保留率（0-1） */
  keyInfoRetentionRate: number;
  /** 实体保留率（0-1） */
  entityRetentionRate: number;
  /** 数字保留率（0-1） */
  numberRetentionRate: number;
  /** 时间信息保留率（0-1） */
  timeRetentionRate: number;
  /** 总体质量评分（0-1） */
  overallQuality: number;
  /** 丢失的关键信息列表 */
  lostKeyInfo: string[];
}

export class ContextCompressor {
  private modelLibrary: ModelLibrary;
  private readonly modelId: string;
  private readonly maxContextTokens: number;


  /** 智能上下文窗口 - 动态调整上下文窗口大小 */
  private contextWindowSize = 4096;
  private maxContextWindowSize = 8192;
  private minContextWindowSize = 1024;

  /** ===== Auto-Compact 配置（借鉴 OpenCode） ===== */
  /** 自动压缩阈值（百分比），默认80% */
  private autoCompactThreshold = 0.80;
  /** 自动压缩冷却时间（毫秒），两次压缩之间至少间隔30秒 */
  private autoCompactCooldown = 30000;
  /** 上次自动压缩时间 */
  private lastAutoCompactTime = 0;
  /** 自动压缩次数统计 */
  private autoCompactCount = 0;
  /** 是否启用自动压缩 */
  private autoCompactEnabled = true;
  /** 会话摘要缓存 */
  private sessionSummaryCache: string[] = [];

  constructor(maxContextTokens: number = 8000, options?: { modelId?: string }) {
    this.maxContextTokens = maxContextTokens;
    // 复用进程级单例，避免独立 clients Map / LRU 缓存造成连接池翻倍
    this.modelLibrary = ModelLibrary.getInstance();
    this.modelId = options?.modelId || process.env.MODEL_NAME || 'auto';
  }

  // ========== Auto-Compact 方法（借鉴 OpenCode 设计） ==========

  /**
   * 配置Auto-Compact参数
   */
  configureAutoCompact(config: {
    threshold?: number;
    cooldown?: number;
    enabled?: boolean;
  }): void {
    if (config.threshold !== undefined) {
      this.autoCompactThreshold = Math.max(0.5, Math.min(0.99, config.threshold));
    }
    if (config.cooldown !== undefined) {
      this.autoCompactCooldown = Math.max(5000, config.cooldown);
    }
    if (config.enabled !== undefined) {
      this.autoCompactEnabled = config.enabled;
    }
  }

  /**
   * 检查是否需要自动压缩（OpenCode风格：监控token使用率）
   * 当使用率达到阈值且冷却时间已过时触发
   */
  shouldAutoCompact(currentTokens: number): boolean {
    if (!this.autoCompactEnabled) return false;
    if (currentTokens <= 0) return false;

    const usageRatio = currentTokens / this.maxContextTokens;
    const cooldownElapsed = Date.now() - this.lastAutoCompactTime > this.autoCompactCooldown;

    return usageRatio >= this.autoCompactThreshold && cooldownElapsed;
  }

  /**
   * 执行自动压缩（类似OpenCode的auto-compact功能）
   * 自动总结并创建新会话上下文的延续
   */
  async autoCompact(messages: Message[]): Promise<{
    compressed: CompressionResult;
    sessionContinuation: string;
    suggestedNextActions: string[];
  }> {
    this.autoCompactCount++;
    this.lastAutoCompactTime = Date.now();

    // 压缩消息
    const compressed = await this.compress(messages, Math.floor(this.maxContextTokens * 0.5));

    // 生成会话延续摘要（类似OpenCode创建新session）
    const sessionContinuation = await this.generateSessionContinuation(
      compressed.summary,
      compressed.keyPoints,
      compressed.entities
    );

    // 基于上下文推理下一步建议动作
    const suggestedNextActions = this.inferNextActions(
      compressed.keyPoints,
      compressed.topicSegments
    );

    // 缓存摘要
    this.sessionSummaryCache.push(
      `[AutoCompact #${this.autoCompactCount}] ${compressed.summary.substring(0, 200)}`
    );
    if (this.sessionSummaryCache.length > 10) {
      this.sessionSummaryCache.shift();
    }

    return { compressed, sessionContinuation, suggestedNextActions };
  }

  /**
   * 生成会话延续摘要（用于新session的上下文注入）
   */
  private generateSessionContinuation(
    summary: string,
    keyPoints: string[],
    entities: string[]
  ): Promise<string> {
    const parts: string[] = [];

    parts.push('📋 **会话延续摘要**');
    parts.push('');

    if (summary) {
      parts.push(`**总结**: ${summary}`);
      parts.push('');
    }

    if (keyPoints.length > 0) {
      parts.push('**关键点**:');
      keyPoints.slice(0, 10).forEach(kp => parts.push(`- ${kp}`));
      parts.push('');
    }

    if (entities.length > 0) {
      parts.push(`**涉及主题**: ${entities.slice(0, 15).join(', ')}`);
      parts.push('');
    }

    parts.push('> ⚡ 此会话已自动压缩以保持上下文效率。上述摘要是之前讨论的延续。');

    return Promise.resolve(parts.join('\n'));
  }

  /**
   * 从上下文中推理下一步建议动作
   */
  private inferNextActions(
    keyPoints: string[],
    segments: TopicSegment[]
  ): string[] {
    const suggestions: string[] = [];
    const allTopics = segments.map(s => s.topic);

    if (allTopics.includes('coding') || allTopics.includes('design')) {
      suggestions.push('继续完善代码实现或架构设计');
    }
    if (allTopics.includes('testing')) {
      suggestions.push('补充测试用例覆盖边界情况');
    }
    if (allTopics.includes('security')) {
      suggestions.push('进行安全审计检查潜在漏洞');
    }
    if (allTopics.includes('performance')) {
      suggestions.push('分析性能瓶颈并优化');
    }
    if (allTopics.includes('devops')) {
      suggestions.push('检查部署配置和CI/CD流程');
    }

    if (suggestions.length === 0) {
      suggestions.push('继续当前讨论方向');
      suggestions.push('探索相关主题的深入分析');
    }

    return suggestions;
  }

  /** 获取自动压缩统计 */
  getAutoCompactStats(): {
    totalCompacts: number;
    lastCompactTime: number;
    cooldownRemaining: number;
    enabled: boolean;
    threshold: number;
    sessionSummaries: string[];
  } {
    return {
      totalCompacts: this.autoCompactCount,
      lastCompactTime: this.lastAutoCompactTime,
      cooldownRemaining: Math.max(0, this.autoCompactCooldown - (Date.now() - this.lastAutoCompactTime)),
      enabled: this.autoCompactEnabled,
      threshold: this.autoCompactThreshold,
      sessionSummaries: [...this.sessionSummaryCache],
    };
  }

  /** 根据对话复杂度动态调整上下文窗口大小 */
  adjustContextWindow(complexity: 'simple' | 'medium' | 'complex'): number {
    switch (complexity) {
      case 'simple':
        this.contextWindowSize = this.minContextWindowSize;
        break;
      case 'medium':
        this.contextWindowSize = 4096;
        break;
      case 'complex':
        this.contextWindowSize = this.maxContextWindowSize;
        break;
    }
    return this.contextWindowSize;
  }

  /** 评估对话复杂度 */
  assessComplexity(messages: { role: string; content: string }[]): 'simple' | 'medium' | 'complex' {
    if (messages.length <= 3) return 'simple';

    const totalLength = messages.reduce((sum, m) => sum + m.content.length, 0);
    const avgLength = totalLength / messages.length;

    // 检测复杂关键词
    const complexIndicators = ['比较', '分析', '评估', '规划', '设计', '架构', '优化', '为什么', '如何', '因果'];
    const hasComplexContent = messages.some(m => complexIndicators.some(ind => m.content.includes(ind)));

    if (messages.length > 10 || avgLength > 200 || hasComplexContent) return 'complex';
    if (messages.length > 5 || avgLength > 100) return 'medium';
    return 'simple';
  }

  /**
   * 压缩消息历史（含关键信息保留策略和压缩质量评估）
   */
  async compress(messages: Message[], targetTokens?: number): Promise<CompressionResult> {
    const target = targetTokens || this.maxContextTokens;
    const originalEstimate = this.estimateTokens(messages);
    const eventBus = EventBus.getInstance();

    eventBus.emit(Events.COMPACTION_STARTED, {
      messageCount: messages.length,
      originalEstimate,
      target,
    }, { source: 'context-compressor' }).catch(() => {});

    if (originalEstimate <= target) {
      eventBus.emit(Events.COMPACTION_COMPLETE, {
        skipped: true,
        reason: 'under_budget',
      }, { source: 'context-compressor' }).catch(() => {});
      return {
        compressedMessages: messages,
        summary: '',
        keyPoints: [],
        entities: [],
        topicSegments: [],
        compressionRatio: 1,
        originalTokenEstimate: originalEstimate,
        compressedTokenEstimate: originalEstimate,
      };
    }

    // 0. 提取原始消息中的关键信息（用于压缩后验证保留率）
    const originalKeyInfo = this.extractKeyInfoFromMessages(messages);

    // 1. 主题分段（增强版：识别主题切换，按主题分段压缩）
    const segments = this.segmentByTopicEnhanced(messages);

    // 2. 按重要性评分（增强版：优先保留实体、数字、时间等关键信息）
    const scoredMessages = messages.map((msg, i) => ({
      message: msg,
      index: i,
      importance: this.scoreImportanceEnhanced(msg, i, messages.length),
    }));

    // 3. 选择性保留（含关键信息保留策略）
    const retained = this.selectMessagesWithKeyInfoPreservation(scoredMessages, target, originalKeyInfo);

    // 4. 生成摘要
    const summary = await this.generateSummary(messages);

    // 5. 提取关键点
    const keyPoints = this.extractKeyPoints(messages);

    // 6. 提取实体
    const entities = this.extractEntities(messages);

    const compressedEstimate = this.estimateTokens(retained);

    // 7. 压缩质量评估：验证关键信息保留率
    const qualityAssessment = this.assessCompressionQuality(messages, retained, originalKeyInfo);

    const compressionRatio = compressedEstimate / originalEstimate;

    eventBus.emit(Events.COMPACTION_COMPLETE, {
      originalCount: messages.length,
      compressedCount: retained.length,
      originalEstimate,
      compressedEstimate,
      compressionRatio,
      hasSummary: !!summary,
      qualityScore: qualityAssessment?.overallQuality,
    }, { source: 'context-compressor' }).catch(() => {});

    return {
      compressedMessages: retained,
      summary,
      keyPoints,
      entities,
      topicSegments: segments,
      compressionRatio,
      originalTokenEstimate: originalEstimate,
      compressedTokenEstimate: compressedEstimate,
      qualityAssessment,
    };
  }

  /**
   * 从消息中提取关键信息（实体、数字、时间等）
   */
  private extractKeyInfoFromMessages(messages: Message[]): {
    entities: Set<string>;
    numbers: Set<string>;
    times: Set<string>;
    decisions: Set<string>;
  } {
    const entities = new Set<string>();
    const numbers = new Set<string>();
    const times = new Set<string>();
    const decisions = new Set<string>();

    for (const msg of messages) {
      const content = msg.content;

      // 提取实体（技术名词）
      const techPattern = /(?:React|Vue|Angular|Node|Python|TypeScript|JavaScript|Docker|Kubernetes|Git|MongoDB|PostgreSQL|Redis|Next\.js|Express|FastAPI|Spring|Django|Flask)/gi;
      const techMatches = content.match(techPattern);
      if (techMatches) techMatches.forEach(m => entities.add(m));

      // 提取数字
      const numberPattern = /\d+(?:\.\d+)?(?:%|MB|GB|KB|TB|ms|秒|分钟|小时|天|个|条|项|次|份|篇|行)?/g;
      const numberMatches = content.match(numberPattern);
      if (numberMatches) numberMatches.forEach(m => numbers.add(m));

      // 提取时间表达式
      const timePattern = /(?:今天|明天|后天|昨天|前天|现在|目前|\d{4}年|\d{1,2}月|\d{1,2}日|\d{1,2}:\d{2}|上午|下午|晚上)/g;
      const timeMatches = content.match(timePattern);
      if (timeMatches) timeMatches.forEach(m => times.add(m));

      // 提取决策性语句
      const decisionPattern = /(?:决定|选择|结论|因此|所以|最终|确认|确定)[^。！？.!?]{5,50}/g;
      const decisionMatches = content.match(decisionPattern);
      if (decisionMatches) decisionMatches.forEach(m => decisions.add(m));
    }

    return { entities, numbers, times, decisions };
  }

  /**
   * 增强版主题分段：识别对话主题切换，按主题分段压缩
   */
  private segmentByTopicEnhanced(messages: Message[]): TopicSegment[] {
    const segments: TopicSegment[] = [];
    let currentSegment: TopicSegment = {
      startIndex: 0,
      endIndex: 0,
      topic: '',
      summary: '',
      keyDecisions: [],
    };

    // 扩展的主题关键词映射
    const topicKeywords = [
      { keywords: ['代码', '编程', '开发', '函数', '类', 'bug', 'debug', '代码', '实现', '编码'], topic: 'coding' },
      { keywords: ['设计', '架构', '模式', 'UI', '界面', '方案', '结构', '模块'], topic: 'design' },
      { keywords: ['部署', '运维', '服务器', 'Docker', 'CI', '发布', '上线', 'k8s'], topic: 'devops' },
      { keywords: ['数据', '分析', '统计', '图表', '数据库', '查询', 'SQL'], topic: 'data' },
      { keywords: ['学习', '教程', '入门', '课程', '怎么学', '如何学'], topic: 'learning' },
      { keywords: ['测试', 'test', '单元测试', '集成测试', '覆盖率'], topic: 'testing' },
      { keywords: ['安全', '漏洞', '加密', '认证', '授权', 'XSS', 'SQL注入'], topic: 'security' },
      { keywords: ['性能', '优化', '加速', '慢', '卡顿', '延迟', '内存'], topic: 'performance' },
      { keywords: ['重构', '改进', '整理', '优化代码', '重写'], topic: 'refactoring' },
    ];

    for (let i = 0; i < messages.length; i++) {
      const msg = messages[i];
      let detectedTopic = 'general';

      for (const topicDef of topicKeywords) {
        if (topicDef.keywords.some(kw => msg.content.toLowerCase().includes(kw.toLowerCase()))) {
          detectedTopic = topicDef.topic;
          break;
        }
      }

      // 检测主题切换
      if (i === 0 || detectedTopic !== currentSegment.topic) {
        if (i > 0) {
          currentSegment.endIndex = i - 1;
          segments.push(currentSegment);
        }
        currentSegment = {
          startIndex: i,
          endIndex: i,
          topic: detectedTopic,
          summary: '',
          keyDecisions: [],
        };
      }

      currentSegment.endIndex = i;

      // 收集关键决策
      const content = msg.content;
      const decisionKeywords = ['决定', '选择', '结论', '因此', '所以', '最终', '确认'];
      if (decisionKeywords.some(kw => content.includes(kw))) {
        currentSegment.keyDecisions.push(content.substring(0, 100));
      }
    }

    if (currentSegment.endIndex >= currentSegment.startIndex) {
      segments.push(currentSegment);
    }

    return segments;
  }

  /**
   * 增强版重要性评分：优先保留实体、数字、时间等关键信息
   */
  private scoreImportanceEnhanced(message: Message, index: number, total: number): number {
    let score = this.scoreImportance(message, index, total);

    const content = message.content;

    // 关键信息保留策略：包含实体、数字、时间的内容优先级更高
    // 包含技术实体的消息更重要
    const techPattern = /(?:React|Vue|Angular|Node|Python|TypeScript|JavaScript|Docker|Kubernetes|Git|MongoDB|PostgreSQL|Redis)/gi;
    if (techPattern.test(content)) {
      score += 0.15;
    }

    // 包含数字/指标的消息更重要
    if (/\d+(?:\.\d+)?(?:%|MB|GB|KB|TB|ms|秒|分钟)/.test(content)) {
      score += 0.1;
    }

    // 包含时间信息的消息更重要
    if (/(?:今天|明天|后天|昨天|前天|现在|目前|\d{4}年|\d{1,2}月|\d{1,2}日)/.test(content)) {
      score += 0.1;
    }

    // 包含决策/结论的消息最重要
    const decisionKeywords = ['决定', '选择', '结论', '因此', '所以', '最终', '确认', '确定'];
    if (decisionKeywords.some(kw => content.includes(kw))) {
      score += 0.2;
    }

    // 包含错误/异常信息的消息重要
    if (/(?:错误|异常|报错|bug|Error|Exception|失败)/i.test(content)) {
      score += 0.15;
    }

    return Math.min(score, 1.0);
  }

  /**
   * 选择性保留消息（含关键信息保留策略）
   */
  private selectMessagesWithKeyInfoPreservation(
    scoredMessages: Array<{ message: Message; index: number; importance: number }>,
    targetTokens: number,
    originalKeyInfo: ReturnType<typeof this.extractKeyInfoFromMessages>
  ): Message[] {
    // 始终保留最近的消息
    const recentCount = Math.min(5, scoredMessages.length);
    const recentMessages = scoredMessages.slice(-recentCount);

    // 计算剩余可用token
    const recentTokens = this.estimateTokens(recentMessages.map(s => s.message));
    const remainingTokens = targetTokens - recentTokens;

    // 从剩余消息中选择重要的，优先保留包含关键信息的
    const olderMessages = scoredMessages.slice(0, -recentCount)
      .sort((a, b) => b.importance - a.importance);

    const selected: Message[] = [];
    let usedTokens = 0;

    for (const item of olderMessages) {
      const msgTokens = this.estimateTokens([item.message]);
      if (usedTokens + msgTokens <= remainingTokens) {
        selected.push(item.message);
        usedTokens += msgTokens;
      }
    }

    // 关键信息保留检查：确保包含关键实体的消息被保留
    const selectedSet = new Set(selected);
    for (const item of scoredMessages.slice(0, -recentCount)) {
      if (selectedSet.has(item.message)) continue;

      const content = item.message.content;
      // 检查是否包含尚未保留的关键实体
      const hasUnretainedEntity = [...originalKeyInfo.entities].some(
        entity => content.includes(entity) && !selected.some(s => s.content.includes(entity)) && !recentMessages.some(r => r.message.content.includes(entity))
      );

      if (hasUnretainedEntity) {
        const msgTokens = this.estimateTokens([item.message]);
        if (usedTokens + msgTokens <= remainingTokens * 1.1) { // 允许10%溢出
          selected.push(item.message);
          usedTokens += msgTokens;
        }
      }
    }

    // 按原始顺序排列
    const allSelected = [...selected, ...recentMessages.map(s => s.message)];
    return allSelected;
  }

  /**
   * 压缩质量评估：压缩后验证关键信息保留率
   */
  private assessCompressionQuality(
    originalMessages: Message[],
    compressedMessages: Message[],
    originalKeyInfo: ReturnType<typeof this.extractKeyInfoFromMessages>
  ): CompressionQualityAssessment {
    const compressedContent = compressedMessages.map(m => m.content).join(' ');

    // 实体保留率
    const retainedEntities = [...originalKeyInfo.entities].filter(e => compressedContent.includes(e));
    const entityRetentionRate = originalKeyInfo.entities.size > 0
      ? retainedEntities.length / originalKeyInfo.entities.size
      : 1.0;

    // 数字保留率
    const retainedNumbers = [...originalKeyInfo.numbers].filter(n => compressedContent.includes(n));
    const numberRetentionRate = originalKeyInfo.numbers.size > 0
      ? retainedNumbers.length / originalKeyInfo.numbers.size
      : 1.0;

    // 时间信息保留率
    const retainedTimes = [...originalKeyInfo.times].filter(t => compressedContent.includes(t));
    const timeRetentionRate = originalKeyInfo.times.size > 0
      ? retainedTimes.length / originalKeyInfo.times.size
      : 1.0;

    // 关键决策保留率
    const retainedDecisions = [...originalKeyInfo.decisions].filter(d => compressedContent.includes(d.substring(0, 30)));
    const keyInfoRetentionRate = originalKeyInfo.decisions.size > 0
      ? retainedDecisions.length / originalKeyInfo.decisions.size
      : 1.0;

    // 丢失的关键信息
    const lostKeyInfo = [
      ...[...originalKeyInfo.entities].filter(e => !compressedContent.includes(e)).map(e => `实体: ${e}`),
      ...[...originalKeyInfo.decisions].filter(d => !compressedContent.includes(d.substring(0, 30))).map(d => `决策: ${d.substring(0, 50)}`),
    ].slice(0, 10); // 最多列出10条

    // 总体质量评分
    const overallQuality = entityRetentionRate * 0.3 + numberRetentionRate * 0.2 +
      timeRetentionRate * 0.2 + keyInfoRetentionRate * 0.3;

    return {
      keyInfoRetentionRate,
      entityRetentionRate,
      numberRetentionRate,
      timeRetentionRate,
      overallQuality,
      lostKeyInfo,
    };
  }

  /**
   * 主题分段
   */
  private segmentByTopic(messages: Message[]): TopicSegment[] {
    const segments: TopicSegment[] = [];
    let currentSegment: TopicSegment = {
      startIndex: 0,
      endIndex: 0,
      topic: '',
      summary: '',
      keyDecisions: [],
    };

    // 简单启发式：基于关键词变化检测主题切换
    const topicKeywords = [
      ['代码', '编程', '开发', '函数', '类', 'bug'],
      ['设计', '架构', '模式', 'UI', '界面'],
      ['部署', '运维', '服务器', 'Docker', 'CI'],
      ['数据', '分析', '统计', '图表'],
      ['学习', '教程', '入门', '课程'],
    ];

    for (let i = 0; i < messages.length; i++) {
      const msg = messages[i];
      let detectedTopic = 'general';

      for (const keywords of topicKeywords) {
        if (keywords.some(kw => msg.content.toLowerCase().includes(kw))) {
          detectedTopic = keywords[0];
          break;
        }
      }

      if (i === 0 || detectedTopic !== currentSegment.topic) {
        if (i > 0) {
          currentSegment.endIndex = i - 1;
          segments.push(currentSegment);
        }
        currentSegment = {
          startIndex: i,
          endIndex: i,
          topic: detectedTopic,
          summary: '',
          keyDecisions: [],
        };
      }

      currentSegment.endIndex = i;
    }

    if (currentSegment.endIndex >= currentSegment.startIndex) {
      segments.push(currentSegment);
    }

    return segments;
  }

  /**
   * 评分消息重要性
   */
  private scoreImportance(message: Message, index: number, total: number): number {
    let score = 0;

    // 1. 位置权重：最近的消息更重要
    const positionRatio = index / total;
    score += positionRatio * 0.3;

    // 2. 显式重要性标记
    if (message.importance) {
      score += message.importance * 0.3;
    }

    // 3. 内容特征
    const content = message.content.toLowerCase();

    // 包含决策/结论的内容更重要
    const decisionKeywords = ['决定', '选择', '结论', '因此', '所以', '最终', 'decided', 'conclusion', 'therefore'];
    if (decisionKeywords.some(kw => content.includes(kw))) {
      score += 0.2;
    }

    // 包含问题/需求的内容更重要
    const questionKeywords = ['怎么', '如何', '为什么', '帮我', '请', 'how', 'why', 'what'];
    if (questionKeywords.some(kw => content.includes(kw))) {
      score += 0.1;
    }

    // 用户消息通常比助手消息更重要
    if (message.role === 'user') {
      score += 0.1;
    }

    return Math.min(score, 1.0);
  }

  /**
   * 选择性保留消息
   */
  private selectMessages(
    scoredMessages: Array<{ message: Message; index: number; importance: number }>,
    targetTokens: number
  ): Message[] {
    // 始终保留最近的消息
    const recentCount = Math.min(5, scoredMessages.length);
    const recentMessages = scoredMessages.slice(-recentCount);

    // 计算剩余可用token
    const recentTokens = this.estimateTokens(recentMessages.map(s => s.message));
    const remainingTokens = targetTokens - recentTokens;

    // 从剩余消息中选择重要的
    const olderMessages = scoredMessages.slice(0, -recentCount)
      .sort((a, b) => b.importance - a.importance);

    const selected: Message[] = [];
    let usedTokens = 0;

    for (const item of olderMessages) {
      const msgTokens = this.estimateTokens([item.message]);
      if (usedTokens + msgTokens <= remainingTokens) {
        selected.push(item.message);
        usedTokens += msgTokens;
      }
    }

    // 按原始顺序排列
    const allSelected = [...selected, ...recentMessages.map(s => s.message)];
    return allSelected;
  }

  /**
   * 生成摘要（通过 ModelLibrary 统一调用，支持自动降级）
   */
  private async generateSummary(messages: Message[]): Promise<string> {
    // 如果消息太少，不需要摘要
    if (messages.length < 5) return '';

    const conversationText = messages
      .map(m => `${m.role === 'user' ? '用户' : '助手'}: ${m.content.substring(0, 200)}`)
      .join('\n');

    const prompt = `请用1-2句话总结以下对话的核心内容：\n\n${conversationText}`;

    try {
      const modelId = this.modelId === 'auto' ? undefined : this.modelId;
      const response = await this.modelLibrary.call(
        [
          { role: 'system', content: '你是一个对话摘要专家。' },
          { role: 'user', content: prompt },
        ],
        {
          modelId,
          maxTokens: 200,
          autoFallback: true,
        },
      );
      return response.content || '';
    } catch {
      // 摘要生成失败（所有降级模型均不可用）
    }

    return '';
  }

  /**
   * 提取关键点
   */
  private extractKeyPoints(messages: Message[]): string[] {
    const points: string[] = [];

    for (const msg of messages) {
      const content = msg.content;
      // 提取包含结论性语言的句子
      const sentences = content.split(/[。！？.!?]/);
      for (const sentence of sentences) {
        const conclusionKeywords = ['决定', '选择', '结论', '因此', '所以', '最终', 'decided', 'conclusion'];
        if (conclusionKeywords.some(kw => sentence.includes(kw)) && sentence.trim().length > 5) {
          points.push(sentence.trim());
        }
      }
    }

    return points.slice(0, 10);
  }

  /**
   * 提取实体
   */
  private extractEntities(messages: Message[]): string[] {
    const entities = new Set<string>();

    // 简单的实体提取：技术名词
    const techPattern = /(?:React|Vue|Angular|Node|Python|TypeScript|JavaScript|Docker|Kubernetes|Git|MongoDB|PostgreSQL|Redis|Next\.js|Express|FastAPI)/gi;

    for (const msg of messages) {
      const matches = msg.content.match(techPattern);
      if (matches) {
        matches.forEach(m => entities.add(m));
      }
    }

    return Array.from(entities);
  }

  /**
   * 估算token数（区分中英文）
   */
  private estimateTokens(messagesOrText: Message[] | string): number {
    const text = typeof messagesOrText === 'string'
      ? messagesOrText
      : messagesOrText.reduce((sum, m) => sum + m.content, '');

    let tokens = 0;
    for (const char of text) {
      // CJK字符（中文、日文、韩文）约1.5字符/token
      if (/[\u4e00-\u9fff\u3040-\u309f\u30a0-\u30ff\uac00-\ud7af]/.test(char)) {
        tokens += 0.67; // 约1.5字符/token
      } else {
        tokens += 0.25; // 约4字符/token
      }
    }
    return Math.ceil(tokens);
  }
}
