/**
 * 用户反馈收集与分析系统
 * FeedbackSystem
 *
 * 核心能力：
 * 1. 反馈收集 - 多种反馈类型（评分、标签、自由文本）
 * 2. 反馈分析 - 情感分析、主题提取、趋势追踪
 * 3. 改进建议 - 基于反馈数据自动生成改进建议
 * 4. A/B验证 - 将改进建议与反馈数据关联验证
 * 5. 报告生成 - 输出反馈分析报告
 */

import * as fs from 'fs/promises';
import * as path from 'path';
import { logger } from './structured-logger.js';
import { atomicWriteJson } from './atomic-write.js';

/** 反馈条目 */
export interface FeedbackEntry {
  id: string;
  userId: string;
  sessionId: string;
  timestamp: Date;
  type: 'rating' | 'thumbs' | 'tag' | 'text' | 'bug_report' | 'feature_request';
  value: number | string | string[];  // 评分(1-5) / 👍👎 / 标签数组 / 文本
  context: {
    query: string;                     // 用户原始查询
    response: string;                  // 系统响应
    intent?: string;                   // 识别的意图
    confidence?: number;               // 置信度
    processingTime?: number;           // 处理时间
  };
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  metadata?: Record<string, any>;
}

/** 反馈统计 */
interface FeedbackStats {
  totalFeedback: number;
  averageRating: number;
  positiveRate: number;              // 正面反馈比例
  negativeRate: number;              // 负面反馈比例
  topIssues: string[];               // 最常见问题
  topPraise: string[];               // 最常见好评
  ratingTrend: 'improving' | 'stable' | 'declining';
  satisfactionScore: number;         // 综合满意度 0-100
}

/** 改进建议 */
interface ImprovementSuggestion {
  id: string;
  category: 'accuracy' | 'speed' | 'relevance' | 'completeness' | 'safety' | 'ux';
  description: string;
  priority: 'high' | 'medium' | 'low';
  affectedFeedbackIds: string[];
  estimatedImpact: string;
  status: 'proposed' | 'in_progress' | 'implemented' | 'verified';
}

/** 反馈分析结果 */
interface FeedbackAnalysis {
  period: { start: Date; end: Date };
  stats: FeedbackStats;
  themes: Array<{ theme: string; count: number; sentiment: 'positive' | 'negative' | 'mixed' }>;
  suggestions: ImprovementSuggestion[];
  comparisonWithPrevious: {
    ratingChange: number;
    satisfactionChange: number;
  };
}

export class FeedbackSystem {
  private feedbacks: FeedbackEntry[] = [];
  private suggestions: ImprovementSuggestion[] = [];
  private dataDir: string;
  private maxFeedbacks: number = 10000;
  /** 反馈触发回调 — 用于接入反思引擎（反馈→反思闭环） */
  private onFeedbackCallback?: (entry: FeedbackEntry) => Promise<void>;

  constructor(dataDir: string = './data/feedback') {
    this.dataDir = dataDir;
  }

  /** 设置反馈触发回调 — 反馈→反思闭环的关键连接点 */
  setOnFeedbackCallback(callback: (entry: FeedbackEntry) => Promise<void>): void {
    this.onFeedbackCallback = callback;
  }

  /**
   * 收集反馈
   */
  async collect(feedback: Omit<FeedbackEntry, 'id' | 'timestamp'>): Promise<string> {
    const id = `fb_${Date.now()}_${Math.random().toString(36).substr(2, 6)}`;

    const entry: FeedbackEntry = {
      ...feedback,
      id,
      timestamp: new Date(),
    };

    this.feedbacks.push(entry);

    // 限制数量
    if (this.feedbacks.length > this.maxFeedbacks) {
      this.feedbacks = this.feedbacks.slice(-this.maxFeedbacks);
    }

    // 实时分析并生成建议
    await this.analyzeAndSuggest(entry);

    // 持久化
    await this.persistFeedback(entry);

    // 触发反馈→反思闭环回调
    if (this.onFeedbackCallback) {
      try { await this.onFeedbackCallback(entry); } catch {}
    }

    return id;
  }

  /**
   * 快速评分（1-5星）
   */
  async rate(userId: string, sessionId: string, rating: number, context: FeedbackEntry['context']): Promise<string> {
    return await this.collect({
      userId,
      sessionId,
      type: 'rating',
      value: Math.max(1, Math.min(5, rating)),
      context,
    });
  }

  /**
   * 点赞/点踩
   */
  async thumbs(userId: string, sessionId: string, isPositive: boolean, context: FeedbackEntry['context']): Promise<string> {
    return await this.collect({
      userId,
      sessionId,
      type: 'thumbs',
      value: isPositive ? 'up' : 'down',
      context,
    });
  }

  /**
   * 标签反馈
   */
  async tag(userId: string, sessionId: string, tags: string[], context: FeedbackEntry['context']): Promise<string> {
    return await this.collect({
      userId,
      sessionId,
      type: 'tag',
      value: tags,
      context,
    });
  }

  /**
   * 文本反馈
   */
  async textFeedback(userId: string, sessionId: string, text: string, context: FeedbackEntry['context']): Promise<string> {
    return await this.collect({
      userId,
      sessionId,
      type: 'text',
      value: text,
      context,
    });
  }

  /**
   * Bug报告
   */
  async bugReport(userId: string, sessionId: string, description: string, context: FeedbackEntry['context']): Promise<string> {
    return await this.collect({
      userId,
      sessionId,
      type: 'bug_report',
      value: description,
      context,
    });
  }

  /**
   * 功能请求
   */
  async featureRequest(userId: string, sessionId: string, description: string, context: FeedbackEntry['context']): Promise<string> {
    return await this.collect({
      userId,
      sessionId,
      type: 'feature_request',
      value: description,
      context,
    });
  }

  /**
   * 获取反馈统计
   */
  getStats(periodDays: number = 30): FeedbackStats {
    const cutoff = new Date(Date.now() - periodDays * 24 * 60 * 60 * 1000);
    const recentFeedbacks = this.feedbacks.filter(f => f.timestamp >= cutoff);
    return this.computeStats(recentFeedbacks);
  }

  /**
   * 基于已过滤的反馈集合进行单次遍历聚合统计
   */
  private computeStats(recentFeedbacks: typeof this.feedbacks): FeedbackStats {
    // 单次遍历完成评分、点赞/点踩、标签的聚合
    let ratingSum = 0;
    let ratingCount = 0;
    let positiveCount = 0;
    let negativeCount = 0;
    const tagCounts = new Map<string, number>();

    for (const f of recentFeedbacks) {
      if (f.type === 'rating') {
        ratingSum += f.value as number;
        ratingCount++;
      } else if (f.type === 'thumbs') {
        if (f.value === 'up') positiveCount++;
        else if (f.value === 'down') negativeCount++;
      } else if (f.type === 'tag') {
        for (const tag of f.value as string[]) {
          tagCounts.set(tag, (tagCounts.get(tag) || 0) + 1);
        }
      }
    }

    // 计算平均评分
    const averageRating = ratingCount > 0 ? ratingSum / ratingCount : 0;

    // 计算正面/负面比例
    const totalThumbs = positiveCount + negativeCount;
    const positiveRate = totalThumbs > 0 ? positiveCount / totalThumbs : 0;
    const negativeRate = totalThumbs > 0 ? negativeCount / totalThumbs : 0;

    // 评分趋势
    const ratingTrend = this.computeRatingTrend(recentFeedbacks);

    // 常见问题和好评
    const sortedTags = Array.from(tagCounts.entries()).sort((a, b) => b[1] - a[1]);
    const negativeTags = sortedTags.filter(([tag]) => this.isNegativeTag(tag)).map(([tag]) => tag);
    const positiveTags = sortedTags.filter(([tag]) => !this.isNegativeTag(tag)).map(([tag]) => tag);

    // 综合满意度
    const satisfactionScore = this.computeSatisfactionScore(averageRating, positiveRate, ratingTrend);

    return {
      totalFeedback: recentFeedbacks.length,
      averageRating,
      positiveRate,
      negativeRate,
      topIssues: negativeTags.slice(0, 5),
      topPraise: positiveTags.slice(0, 5),
      ratingTrend,
      satisfactionScore,
    };
  }

  /**
   * 分析反馈并生成改进建议
   */
  analyze(periodDays: number = 30): FeedbackAnalysis {
    const cutoff = new Date(Date.now() - periodDays * 24 * 60 * 60 * 1000);
    const recentFeedbacks = this.feedbacks.filter(f => f.timestamp >= cutoff);
    // 复用过滤后的 recentFeedbacks，避免重复过滤与重复统计计算
    const stats = this.computeStats(recentFeedbacks);

    // 主题提取
    const themes = this.extractThemes(recentFeedbacks);

    // 生成改进建议
    const suggestions = this.generateSuggestions(stats, themes, recentFeedbacks);

    // 与上一周期对比
    const previousCutoff = new Date(cutoff.getTime() - periodDays * 24 * 60 * 60 * 1000);
    const previousFeedbacks = this.feedbacks.filter(f => f.timestamp >= previousCutoff && f.timestamp < cutoff);
    const previousStats = this.computeQuickStats(previousFeedbacks);

    return {
      period: { start: cutoff, end: new Date() },
      stats,
      themes,
      suggestions,
      comparisonWithPrevious: {
        ratingChange: stats.averageRating - previousStats.averageRating,
        satisfactionChange: stats.satisfactionScore - previousStats.satisfactionScore,
      },
    };
  }

  /**
   * 获取改进建议
   */
  getSuggestions(status?: ImprovementSuggestion['status']): ImprovementSuggestion[] {
    if (status) {
      return this.suggestions.filter(s => s.status === status);
    }
    return [...this.suggestions];
  }

  /**
   * 更新建议状态
   */
  updateSuggestionStatus(suggestionId: string, status: ImprovementSuggestion['status']): boolean {
    const suggestion = this.suggestions.find(s => s.id === suggestionId);
    if (!suggestion) return false;
    suggestion.status = status;
    return true;
  }

  /**
   * 生成反馈报告
   */
  generateReport(periodDays: number = 30): string {
    const analysis = this.analyze(periodDays);
    const lines: string[] = [];

    lines.push('📋 用户反馈分析报告');
    lines.push(`分析周期: ${analysis.period.start.toLocaleDateString('zh-CN')} - ${analysis.period.end.toLocaleDateString('zh-CN')}`);
    lines.push('');

    // 统计概览
    lines.push('━━━ 统计概览 ━━━');
    lines.push(`总反馈数: ${analysis.stats.totalFeedback}`);
    lines.push(`平均评分: ${analysis.stats.averageRating.toFixed(1)}/5`);
    lines.push(`正面比例: ${(analysis.stats.positiveRate * 100).toFixed(1)}%`);
    lines.push(`负面比例: ${(analysis.stats.negativeRate * 100).toFixed(1)}%`);
    lines.push(`满意度: ${analysis.stats.satisfactionScore.toFixed(0)}/100`);
    lines.push(`评分趋势: ${(() => {
      if (analysis.stats.ratingTrend === 'improving') return '↑ 上升';
      if (analysis.stats.ratingTrend === 'declining') return '↓ 下降';
      return '→ 稳定';
    })()}`);
    lines.push('');

    // 与上期对比
    lines.push('━━━ 环比变化 ━━━');
    lines.push(`评分变化: ${analysis.comparisonWithPrevious.ratingChange >= 0 ? '+' : ''}${analysis.comparisonWithPrevious.ratingChange.toFixed(2)}`);
    lines.push(`满意度变化: ${analysis.comparisonWithPrevious.satisfactionChange >= 0 ? '+' : ''}${analysis.comparisonWithPrevious.satisfactionChange.toFixed(1)}`);
    lines.push('');

    // 主要主题
    lines.push('━━━ 反馈主题 ━━━');
    for (const theme of analysis.themes.slice(0, 10)) {
      let icon: string;
      if (theme.sentiment === 'positive') icon = '👍';
      else if (theme.sentiment === 'negative') icon = '👎';
      else icon = '😐';
      lines.push(`${icon} ${theme.theme} (${theme.count}次)`);
    }
    lines.push('');

    // 常见问题
    if (analysis.stats.topIssues.length > 0) {
      lines.push('━━━ 常见问题 ━━━');
      for (const issue of analysis.stats.topIssues) {
        lines.push(`🔴 ${issue}`);
      }
      lines.push('');
    }

    // 改进建议
    lines.push('━━━ 改进建议 ━━━');
    if (analysis.suggestions.length === 0) {
      lines.push('✅ 暂无紧急改进建议');
    } else {
      for (const suggestion of analysis.suggestions) {
        let priorityIcon: string;
        if (suggestion.priority === 'high') {
          priorityIcon = '🔴';
        } else if (suggestion.priority === 'medium') {
          priorityIcon = '🟡';
        } else {
          priorityIcon = '🟢';
        }
        lines.push(`${priorityIcon} [${suggestion.category}] ${suggestion.description}`);
        lines.push(`   预期影响: ${suggestion.estimatedImpact}`);
      }
    }


    return lines.join('\n');
  }

  /**
   * 加载历史数据
   */
  async load(): Promise<void> {
    try {
      await fs.mkdir(this.dataDir, { recursive: true });
      const files = await fs.readdir(this.dataDir);
      const jsonFiles = files.filter(f => f.endsWith('.json')).sort().slice(-7);

      for (const file of jsonFiles) {
        try {
          const content = await fs.readFile(path.join(this.dataDir, file), 'utf-8');
          const data = JSON.parse(content);
          if (Array.isArray(data)) {
            // eslint-disable-next-line @typescript-eslint/no-explicit-any
            this.feedbacks.push(...data.map((f: any) => ({
              ...f,
              timestamp: new Date(f.timestamp),
            })));
          }
        } catch {
          // 跳过
        }
      }

      if (this.feedbacks.length > this.maxFeedbacks) {
        this.feedbacks = this.feedbacks.slice(-this.maxFeedbacks);
      }
    } catch {
      // 目录不存在
    }
  }

  // ========== 私有方法 ==========

  private async persistFeedback(entry: FeedbackEntry): Promise<void> {
    try {
      await fs.mkdir(this.dataDir, { recursive: true });
      const date = new Date().toISOString().split('T')[0];
      const filePath = path.join(this.dataDir, `feedback-${date}.json`);

      let existing: unknown[] = [];
      try {
        const content = await fs.readFile(filePath, 'utf-8');
        existing = JSON.parse(content);
      } catch {
        // 文件不存在
      }

      existing.push(entry);
      await atomicWriteJson(filePath, existing);
    } catch (error: unknown) {
      const msg = error instanceof Error ? error.message : String(error);
      logger.error('持久化反馈失败', { module: 'FeedbackSystem', error: msg });
    }
  }

  private analyzeAndSuggest(entry: FeedbackEntry): Promise<void> {
    // 实时分析：低评分或负面反馈自动生成建议
    const isNegative = (
      (entry.type === 'rating' && (entry.value as number) <= 2) ||
      (entry.type === 'thumbs' && entry.value === 'down') ||
      (entry.type === 'bug_report')
    );

    if (isNegative) {
      const category = this.inferCategory(entry);
      const existingSuggestion = this.suggestions.find(
        s => s.category === category && s.status === 'proposed'
      );

      if (existingSuggestion) {
        existingSuggestion.affectedFeedbackIds.push(entry.id);
      } else {
        this.suggestions.push({
          id: `sug_${Date.now()}_${Math.random().toString(36).substr(2, 6)}`,
          category,
          description: this.generateSuggestionDescription(entry, category),
          priority: entry.type === 'bug_report' ? 'high' : 'medium',
          affectedFeedbackIds: [entry.id],
          estimatedImpact: this.estimateImpact(category),
          status: 'proposed',
        });
      }
    }

    return Promise.resolve();
  }

  private inferCategory(entry: FeedbackEntry): ImprovementSuggestion['category'] {
    const text = typeof entry.value === 'string' ? entry.value.toLowerCase() : '';
    const context = entry.context;

    if (text.includes('慢') || text.includes('延迟') || (context.processingTime && context.processingTime > 3000)) {
      return 'speed';
    }
    if (text.includes('不准确') || text.includes('错误') || (context.confidence && context.confidence < 0.5)) {
      return 'accuracy';
    }
    if (text.includes('不相关') || text.includes('答非所问')) {
      return 'relevance';
    }
    if (text.includes('不完整') || text.includes('缺少')) {
      return 'completeness';
    }
    if (text.includes('安全') || text.includes('隐私')) {
      return 'safety';
    }
    return 'ux';
  }

  private generateSuggestionDescription(entry: FeedbackEntry, category: string): string {
    const descriptions: Record<string, string> = {
      accuracy: `用户反馈响应不准确（意图: ${entry.context.intent || '未知'}），需要优化推理逻辑`,
      speed: `用户反馈响应过慢（${entry.context.processingTime ? entry.context.processingTime + 'ms' : '未知'}），需要优化处理流程`,
      relevance: '用户反馈响应与问题不相关，需要改进意图理解',
      completeness: '用户反馈响应不完整，需要增强信息覆盖',
      safety: '用户反馈存在安全/隐私问题，需要加强安全检测',
      ux: '用户反馈交互体验不佳，需要改进交互设计',
    };
    return descriptions[category] || '需要改进';
  }

  private estimateImpact(category: string): string {
    const impacts: Record<string, string> = {
      accuracy: '预计提升准确率5-15%',
      speed: '预计减少响应时间30-50%',
      relevance: '预计提升相关性10-20%',
      completeness: '预计提升完整度15-25%',
      safety: '消除安全隐患',
      ux: '预计提升满意度10-20%',
    };
    return impacts[category] || '待评估';
  }

  private computeRatingTrend(feedbacks: FeedbackEntry[]): 'improving' | 'stable' | 'declining' {
    const ratings = feedbacks
      .filter(f => f.type === 'rating')
      .sort((a, b) => a.timestamp.getTime() - b.timestamp.getTime());

    if (ratings.length < 4) return 'stable';

    const half = Math.floor(ratings.length / 2);
    const firstHalf = ratings.slice(0, half);
    const secondHalf = ratings.slice(half);

    const avgFirst = firstHalf.reduce((s, f) => s + (f.value as number), 0) / firstHalf.length;
    const avgSecond = secondHalf.reduce((s, f) => s + (f.value as number), 0) / secondHalf.length;

    const diff = avgSecond - avgFirst;
    if (diff > 0.2) return 'improving';
    if (diff < -0.2) return 'declining';
    return 'stable';
  }

  private computeSatisfactionScore(avgRating: number, positiveRate: number, trend: string): number {
    const ratingScore = (avgRating / 5) * 50;           // 最高50分
    const thumbsScore = positiveRate * 30;                // 最高30分
    let trendScore: number;
    if (trend === 'improving') trendScore = 20;
    else if (trend === 'stable') trendScore = 10;
    else trendScore = 0; // 最高20分
    return Math.min(ratingScore + thumbsScore + trendScore, 100);
  }

  private computeQuickStats(feedbacks: FeedbackEntry[]): { averageRating: number; satisfactionScore: number } {
    const ratings = feedbacks.filter(f => f.type === 'rating').map(f => f.value as number);
    const averageRating = ratings.length > 0 ? ratings.reduce((a, b) => a + b, 0) / ratings.length : 3;
    return { averageRating, satisfactionScore: (averageRating / 5) * 60 };
  }

  private extractThemes(feedbacks: FeedbackEntry[]): Array<{ theme: string; count: number; sentiment: 'positive' | 'negative' | 'mixed' }> {
    const themes: Map<string, { count: number; positive: number; negative: number }> = new Map();

    // 从标签反馈中提取主题
    for (const fb of feedbacks) {
      if (fb.type === 'tag') {
        const tags = fb.value as string[];
        for (const tag of tags) {
          const existing = themes.get(tag) || { count: 0, positive: 0, negative: 0 };
          existing.count++;
          if (this.isNegativeTag(tag)) {
            existing.negative++;
          } else {
            existing.positive++;
          }
          themes.set(tag, existing);
        }
      }

      // 从文本反馈中提取关键词主题
      if (fb.type === 'text' || fb.type === 'bug_report' || fb.type === 'feature_request') {
        const text = (fb.value as string).toLowerCase();
        const keywords = this.extractKeywords(text);
        for (const keyword of keywords) {
          const existing = themes.get(keyword) || { count: 0, positive: 0, negative: 0 };
          existing.count++;
          if (fb.type === 'bug_report') {
            existing.negative++;
          } else {
            existing.positive++;
          }
          themes.set(keyword, existing);
        }
      }
    }

    return Array.from(themes.entries())
      .filter(([, data]) => data.count >= 2)
      .map(([theme, data]) => ({
        theme,
        count: data.count,
        sentiment: (() => {
          if (data.negative > data.positive) return 'negative';
          if (data.positive > data.negative) return 'positive';
          return 'mixed';
        })() as 'positive' | 'negative' | 'mixed',
      }))
      .sort((a, b) => b.count - a.count);
  }

  private extractKeywords(text: string): string[] {
    const stopWords = new Set(['的', '了', '是', '在', '我', '有', '和', '就', '不', '人', '都', '一', '一个', '上', '也', '很', '到', '说', '要', '去', '你', '会', '着', '没有', '看', '好', '自己', '这']);
    return text.split(/\s+/)
      .filter(w => w.length >= 2 && !stopWords.has(w))
      .slice(0, 5);
  }

  private isNegativeTag(tag: string): boolean {
    const negativeTags = ['不准确', '太慢', '不相关', '不完整', '错误', 'bug', '崩溃', '难用', '困惑', '不满意'];
    return negativeTags.some(nt => tag.toLowerCase().includes(nt.toLowerCase()));
  }

  private generateSuggestions(stats: FeedbackStats, themes: Array<{ theme: string; count: number; sentiment: 'positive' | 'negative' | 'mixed' }>, _feedbacks: FeedbackEntry[]): ImprovementSuggestion[] {
    const suggestions: ImprovementSuggestion[] = [...this.suggestions.filter(s => s.status === 'proposed')];

    // 基于评分趋势生成建议
    if (stats.ratingTrend === 'declining') {
      suggestions.push({
        id: `sug_auto_${Date.now()}_1`,
        category: 'accuracy',
        description: '用户评分呈下降趋势，建议全面审查响应质量',
        priority: 'high',
        affectedFeedbackIds: [],
        estimatedImpact: '预计止住评分下降趋势',
        status: 'proposed',
      });
    }

    // 基于负面主题生成建议
    const negativeThemes = themes.filter(t => t.sentiment === 'negative');
    for (const theme of negativeThemes.slice(0, 3)) {
      if (!suggestions.some(s => s.description.includes(theme.theme))) {
        suggestions.push({
          id: `sug_auto_${Date.now()}_${theme.theme}`,
          category: this.inferCategoryFromTheme(theme.theme),
          description: `用户频繁反馈"${theme.theme}"问题（${theme.count}次），建议重点改进`,
          priority: theme.count > 5 ? 'high' : 'medium',
          affectedFeedbackIds: [],
          estimatedImpact: `预计减少"${theme.theme}"相关负面反馈30-50%`,
          status: 'proposed',
        });
      }
    }

    return suggestions.sort((a, b) => {
      const priorityOrder = { high: 0, medium: 1, low: 2 };
      return priorityOrder[a.priority] - priorityOrder[b.priority];
    });
  }

  private inferCategoryFromTheme(theme: string): ImprovementSuggestion['category'] {
    if (theme.includes('慢') || theme.includes('延迟')) return 'speed';
    if (theme.includes('准确') || theme.includes('错误')) return 'accuracy';
    if (theme.includes('相关')) return 'relevance';
    if (theme.includes('完整')) return 'completeness';
    if (theme.includes('安全') || theme.includes('隐私')) return 'safety';
    return 'ux';
  }
}
