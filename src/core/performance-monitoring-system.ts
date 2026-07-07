/**
 * 性能监控系统 — PerformanceMonitoringSystem
 *
 * 对标 COMPREHENSIVE_COMPETITIVE_ANALYSIS.md 第八部分"持续监控与迭代机制"。
 *
 * 核心能力：
 * 1. 实时性能监控 — 6类指标采集（响应时间/资源占用/任务完成率/错误率/用户满意度/上下文使用）
 * 2. 12维度评分跟踪 — D1-D12 评分变化趋势
 * 3. 预警系统 — 8个关键指标的三级阈值预警（正常/警告/严重）
 * 4. 用户反馈闭环 — 收集→分类→优先级排序→改进→验证→通知
 * 5. 评估-优化-验证-迭代闭环流程
 */

import * as fs from 'fs';
import * as path from 'path';
import { logger } from './structured-logger.js';
import { EventBus } from './event-bus.js';
import { duanPath } from './duan-paths.js';
import { atomicWriteJsonSync } from './atomic-write.js';

// ============ 类型定义 ============

/** 指标类别 */
export type MetricCategory =
  | 'response_time'
  | 'resource_usage'
  | 'task_completion'
  | 'error_rate'
  | 'user_satisfaction'
  | 'context_usage';

/** 单条指标记录 */
export interface MetricRecord {
  /** 时间戳 */
  timestamp: number;
  /** 指标类别 */
  category: MetricCategory;
  /** 指标名称 */
  name: string;
  /** 数值 */
  value: number;
  /** 单位 */
  unit: string;
  /** 来源（哪个模块/工具） */
  source?: string;
  /** 附加元数据 */
  metadata?: Record<string, unknown>;
}

/** 12 维度评分 */
export interface DimensionScore {
  /** 维度 ID (D1-D12) */
  dimensionId: string;
  /** 维度名称 */
  name: string;
  /** 当前评分 (0-10) */
  score: number;
  /** 上次评分 */
  previousScore: number;
  /** 变化趋势 */
  trend: 'up' | 'down' | 'stable';
  /** 变化幅度 */
  change: number;
  /** 评估时间 */
  evaluatedAt: number;
}

/** 预警级别 */
export type AlertLevel = 'normal' | 'warning' | 'critical';

/** 预警记录 */
export interface AlertRecord {
  /** 预警 ID */
  id: string;
  /** 指标名称 */
  metricName: string;
  /** 预警级别 */
  level: AlertLevel;
  /** 当前值 */
  currentValue: number;
  /** 阈值 */
  threshold: number;
  /** 预警消息 */
  message: string;
  /** 触发时间 */
  triggeredAt: number;
  /** 是否已确认 */
  acknowledged: boolean;
}

/** 用户反馈 */
export interface UserFeedback {
  /** 反馈 ID */
  id: string;
  /** 用户 ID */
  userId: string;
  /** 反馈类型 */
  type: 'feature' | 'performance' | 'bug' | 'suggestion' | 'complaint' | 'praise';
  /** 反馈内容 */
  content: string;
  /** 满意度评分 (1-5) */
  rating?: number;
  /** 优先级 (P0-P3) */
  priority: 'P0' | 'P1' | 'P2' | 'P3';
  /** 状态 */
  status: 'collected' | 'classified' | 'in_progress' | 'resolved' | 'closed';
  /** 创建时间 */
  createdAt: number;
  /** 更新时间 */
  updatedAt: number;
  /** 处理结果 */
  resolution?: string;
  /** 标签 */
  tags: string[];
}

/** 闭环改进项 */
export interface ImprovementItem {
  /** 改进项 ID */
  id: string;
  /** 阶段：评估/优化/验证/迭代 */
  phase: 'assess' | 'optimize' | 'verify' | 'iterate';
  /** 描述 */
  description: string;
  /** 来源（用户反馈/竞品对标/定期评估） */
  source: 'user_feedback' | 'competitor_analysis' | 'periodic_evaluation' | 'alert_triggered';
  /** 关联反馈 ID */
  relatedFeedbackIds?: string[];
  /** 创建时间 */
  createdAt: number;
  /** 更新时间 */
  updatedAt?: number;
  /** 完成时间 */
  completedAt?: number;
  /** 状态 */
  status: 'pending' | 'in_progress' | 'completed' | 'cancelled';
}

// ============ 预警阈值配置 ============

interface ThresholdConfig {
  normal: { max?: number; min?: number };
  warning: { max?: number; min?: number };
  critical: { max?: number; min?: number };
  unit: string;
  description: string;
}

/** 8 个关键指标的预警阈值 */
const ALERT_THRESHOLDS: Record<string, ThresholdConfig> = {
  first_char_response_time: {
    normal: { max: 500 },
    warning: { max: 1000 },
    critical: { min: 1000 },
    unit: 'ms',
    description: '首字符响应时间',
  },
  avg_response_latency: {
    normal: { max: 5000 },
    warning: { max: 10000 },
    critical: { min: 10000 },
    unit: 'ms',
    description: '平均响应延迟',
  },
  task_completion_rate: {
    normal: { min: 92 },
    warning: { min: 85 },
    critical: { max: 85 },
    unit: '%',
    description: '任务完成率',
  },
  error_rate: {
    normal: { max: 5 },
    warning: { max: 10 },
    critical: { min: 10 },
    unit: '%',
    description: '错误率',
  },
  cpu_usage: {
    normal: { max: 30 },
    warning: { max: 50 },
    critical: { min: 50 },
    unit: '%',
    description: 'CPU 占用',
  },
  memory_usage: {
    normal: { max: 1024 },
    warning: { max: 2048 },
    critical: { min: 2048 },
    unit: 'MB',
    description: '内存占用',
  },
  context_usage: {
    normal: { max: 70 },
    warning: { max: 90 },
    critical: { min: 90 },
    unit: '%',
    description: '上下文使用率',
  },
  user_satisfaction: {
    normal: { min: 4.5 },
    warning: { min: 4.0 },
    critical: { max: 4.0 },
    unit: '/5',
    description: '用户满意度',
  },
};

/** 12 维度默认评分 */
const DEFAULT_DIMENSION_SCORES: Array<{ id: string; name: string; score: number }> = [
  { id: 'D1', name: '自然语言理解能力', score: 7.5 },
  { id: 'D2', name: '多轮对话连贯性', score: 7.0 },
  { id: 'D3', name: '任务执行效率', score: 7.5 },
  { id: 'D4', name: '代码生成质量', score: 7.5 },
  { id: 'D5', name: '上下文管理机制', score: 6.5 },
  { id: 'D6', name: '多模态处理能力', score: 6.0 },
  { id: 'D7', name: '个性化交互体验', score: 6.5 },
  { id: 'D8', name: '架构可扩展性', score: 8.0 },
  { id: 'D9', name: '资源占用率', score: 7.0 },
  { id: 'D10', name: '响应速度', score: 7.5 },
  { id: 'D11', name: '错误恢复能力', score: 7.0 },
  { id: 'D12', name: '用户界面友好度', score: 7.5 },
];

// ============ 性能监控系统 ============

export class PerformanceMonitoringSystem {
  /** 工作目录 */
  private workDir: string;

  /** 指标记录（按类别分组） */
  private metrics: Map<MetricCategory, MetricRecord[]> = new Map();

  /** 12 维度评分历史 */
  private dimensionScores: Map<string, DimensionScore[]> = new Map();

  /** 活跃预警 */
  private activeAlerts: Map<string, AlertRecord> = new Map();

  /** 预警历史 */
  private alertHistory: AlertRecord[] = [];

  /** 用户反馈 */
  private feedbacks: Map<string, UserFeedback> = new Map();

  /** 改进项 */
  private improvements: Map<string, ImprovementItem> = new Map();

  /** 最大存储条数（每类别） */
  private maxRecordsPerCategory = 10000;

  private log = logger.child({ module: 'PerformanceMonitoringSystem' });

  constructor(workDir?: string) {
    this.workDir = workDir ?? duanPath('monitoring');
    fs.mkdirSync(this.workDir, { recursive: true });

    // 初始化指标存储
    for (const category of ['response_time', 'resource_usage', 'task_completion', 'error_rate', 'user_satisfaction', 'context_usage'] as MetricCategory[]) {
      this.metrics.set(category, []);
    }

    // 初始化维度评分
    for (const dim of DEFAULT_DIMENSION_SCORES) {
      this.dimensionScores.set(dim.id, [{
        dimensionId: dim.id,
        name: dim.name,
        score: dim.score,
        previousScore: dim.score,
        trend: 'stable',
        change: 0,
        evaluatedAt: Date.now(),
      }]);
    }

    // 加载历史数据
    this.loadData();
  }

  // ========== 指标采集 ==========

  /**
   * 记录指标
   */
  recordMetric(category: MetricCategory, name: string, value: number, unit: string, source?: string, metadata?: Record<string, unknown>): void {
    const record: MetricRecord = {
      timestamp: Date.now(),
      category,
      name,
      value,
      unit,
      source,
      metadata,
    };

    let records = this.metrics.get(category);
    if (!records) {
      records = [];
      this.metrics.set(category, records);
    }
    records.push(record);

    // 限制记录数量
    if (records.length > this.maxRecordsPerCategory) {
      records.splice(0, records.length - this.maxRecordsPerCategory);
    }

    // 检查预警
    this.checkAlerts(name, value);

    EventBus.getInstance().emitSync('monitoring.metric.recorded', { category, name, value, unit });
  }

  /**
   * 批量记录响应时间
   */
  recordResponseTime(durationMs: number, source?: string): void {
    this.recordMetric('response_time', 'response_time', durationMs, 'ms', source);
  }

  /**
   * 记录任务完成情况
   */
  recordTaskCompletion(success: boolean, source?: string): void {
    const records = this.metrics.get('task_completion') ?? [];
    const recentRecords = records.slice(-99);
    const successCount = recentRecords.filter(r => r.value === 1).length + (success ? 1 : 0);
    const rate = (successCount / (recentRecords.length + 1)) * 100;
    this.recordMetric('task_completion', 'task_completion_rate', rate, '%', source);
    this.recordMetric('task_completion', 'task_success', success ? 1 : 0, 'boolean', source);
  }

  /**
   * 记录错误
   */
  recordError(errorType: string, source?: string): void {
    const records = this.metrics.get('error_rate') ?? [];
    const recentRecords = records.slice(-99);
    const errorCount = recentRecords.filter(r => r.value > 0).length + 1;
    const rate = (errorCount / (recentRecords.length + 1)) * 100;
    this.recordMetric('error_rate', 'error_rate', rate, '%', source, { errorType });
    this.recordMetric('error_rate', 'error_count', 1, 'count', source, { errorType });
  }

  /**
   * 记录用户满意度
   */
  recordSatisfaction(rating: number, userId: string): void {
    this.recordMetric('user_satisfaction', 'user_satisfaction', rating, '/5', userId);
  }

  /**
   * 记录资源使用
   */
  recordResourceUsage(cpuPercent: number, memoryMB: number): void {
    this.recordMetric('resource_usage', 'cpu_usage', cpuPercent, '%', 'system');
    this.recordMetric('resource_usage', 'memory_usage', memoryMB, 'MB', 'system');
  }

  /**
   * 记录上下文使用
   */
  recordContextUsage(usagePercent: number): void {
    this.recordMetric('context_usage', 'context_usage', usagePercent, '%', 'agent');
  }

  // ========== 指标查询 ==========

  /**
   * 获取最新指标
   */
  getLatestMetrics(): Record<MetricCategory, MetricRecord[]> {
    const result = {} as Record<MetricCategory, MetricRecord[]>;
    for (const [category, records] of this.metrics) {
      result[category] = records.slice(-20);
    }
    return result;
  }

  /**
   * 获取指标统计
   */
  getMetricStats(category: MetricCategory, name: string, windowMs: number = 3600000): {
    current: number;
    average: number;
    min: number;
    max: number;
    count: number;
    p50: number;
    p95: number;
    p99: number;
  } | null {
    const records = this.metrics.get(category) ?? [];
    const cutoff = Date.now() - windowMs;
    const filtered = records.filter(r => r.name === name && r.timestamp >= cutoff);

    if (filtered.length === 0) return null;

    const values = filtered.map(r => r.value).sort((a, b) => a - b);
    const sum = values.reduce((a, b) => a + b, 0);

    return {
      current: values[values.length - 1],
      average: sum / values.length,
      min: values[0],
      max: values[values.length - 1],
      count: values.length,
      p50: values[Math.floor(values.length * 0.5)],
      p95: values[Math.floor(values.length * 0.95)],
      p99: values[Math.floor(values.length * 0.99)],
    };
  }

  // ========== 12 维度评分 ==========

  /**
   * 更新维度评分
   */
  updateDimensionScore(dimensionId: string, newScore: number): DimensionScore | null {
    const history = this.dimensionScores.get(dimensionId);
    if (!history || history.length === 0) return null;

    const latest = history[history.length - 1];
    let trend: DimensionScore['trend'];
    if (newScore > latest.score) {
      trend = 'up';
    } else if (newScore < latest.score) {
      trend = 'down';
    } else {
      trend = 'stable';
    }
    const change = newScore - latest.score;

    const updated: DimensionScore = {
      dimensionId,
      name: latest.name,
      score: newScore,
      previousScore: latest.score,
      trend,
      change,
      evaluatedAt: Date.now(),
    };

    history.push(updated);
    // 保留最近 100 条
    if (history.length > 100) {
      history.splice(0, history.length - 100);
    }

    this.log.info('维度评分已更新', { dimensionId, score: newScore, trend, change });
    EventBus.getInstance().emitSync('monitoring.dimension.updated', { dimensionId, score: newScore, trend });

    this.persistData();
    return updated;
  }

  /**
   * 获取所有维度评分
   */
  getAllDimensionScores(): DimensionScore[] {
    const result: DimensionScore[] = [];
    for (const history of this.dimensionScores.values()) {
      if (history.length > 0) {
        result.push(history[history.length - 1]);
      }
    }
    return result;
  }

  /**
   * 获取综合评分
   */
  getOverallScore(): { score: number; trend: 'up' | 'down' | 'stable'; change: number } {
    const scores = this.getAllDimensionScores();
    if (scores.length === 0) return { score: 0, trend: 'stable', change: 0 };

    const avg = scores.reduce((sum, s) => sum + s.score, 0) / scores.length;
    const totalChange = scores.reduce((sum, s) => sum + s.change, 0) / scores.length;
    let trend: 'up' | 'down' | 'stable';
    if (totalChange > 0.1) {
      trend = 'up';
    } else if (totalChange < -0.1) {
      trend = 'down';
    } else {
      trend = 'stable';
    }

    return { score: avg, trend, change: totalChange };
  }

  // ========== 预警系统 ==========

  /**
   * 检查预警
   */
  private checkAlerts(metricName: string, value: number): void {
    const config = ALERT_THRESHOLDS[metricName];
    if (!config) return;

    let level: AlertLevel = 'normal';
    let threshold = 0;

    // 检查严重阈值
    if (config.critical.min !== undefined && value >= config.critical.min) {
      level = 'critical';
      threshold = config.critical.min;
    } else if (config.critical.max !== undefined && value <= config.critical.max) {
      level = 'critical';
      threshold = config.critical.max;
    } else if (config.warning.min !== undefined && value >= config.warning.min) {
      level = 'warning';
      threshold = config.warning.min;
    } else if (config.warning.max !== undefined && value >= config.warning.max) {
      level = 'warning';
      threshold = config.warning.max;
    }

    if (level !== 'normal') {
      const alertId = `alert_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 6)}`;
      const alert: AlertRecord = {
        id: alertId,
        metricName,
        level,
        currentValue: value,
        threshold,
        message: `${config.description} ${level === 'critical' ? '严重' : '警告'}: 当前 ${value}${config.unit}, 阈值 ${threshold}${config.unit}`,
        triggeredAt: Date.now(),
        acknowledged: false,
      };

      this.activeAlerts.set(alertId, alert);
      this.alertHistory.push(alert);

      // 限制历史记录
      if (this.alertHistory.length > 500) {
        this.alertHistory = this.alertHistory.slice(-300);
      }

      this.log.warn('预警触发', { metricName, level, value, threshold });
      EventBus.getInstance().emitSync('monitoring.alert.triggered', alert);
    }
  }

  /**
   * 确认预警
   */
  acknowledgeAlert(alertId: string): boolean {
    const alert = this.activeAlerts.get(alertId);
    if (!alert) return false;
    alert.acknowledged = true;
    this.activeAlerts.delete(alertId);
    this.log.info('预警已确认', { alertId });
    return true;
  }

  /**
   * 获取活跃预警
   */
  getActiveAlerts(): AlertRecord[] {
    return Array.from(this.activeAlerts.values()).sort((a, b) => b.triggeredAt - a.triggeredAt);
  }

  /**
   * 获取预警历史
   */
  getAlertHistory(limit: number = 50): AlertRecord[] {
    return this.alertHistory.slice(-limit).reverse();
  }

  // ========== 用户反馈管理 ==========

  /**
   * 收集用户反馈
   */
  collectFeedback(params: {
    userId: string;
    type: UserFeedback['type'];
    content: string;
    rating?: number;
    tags?: string[];
  }): UserFeedback {
    // 自动确定优先级
    let priority: UserFeedback['priority'] = 'P2';
    if (params.type === 'bug' && params.rating && params.rating <= 2) {
      priority = 'P0';
    } else if (params.type === 'complaint' || (params.rating && params.rating <= 3)) {
      priority = 'P1';
    } else if (params.type === 'suggestion') {
      priority = 'P3';
    }

    const feedback: UserFeedback = {
      id: `fb_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 6)}`,
      userId: params.userId,
      type: params.type,
      content: params.content,
      rating: params.rating,
      priority,
      status: 'collected',
      createdAt: Date.now(),
      updatedAt: Date.now(),
      tags: params.tags ?? [],
    };

    this.feedbacks.set(feedback.id, feedback);

    // 如果有评分，记录到满意度指标
    if (params.rating) {
      this.recordSatisfaction(params.rating, params.userId);
    }

    this.log.info('用户反馈已收集', { feedbackId: feedback.id, type: params.type, priority });
    EventBus.getInstance().emitSync('monitoring.feedback.collected', feedback);

    this.persistData();
    return feedback;
  }

  /**
   * 更新反馈状态
   */
  updateFeedbackStatus(feedbackId: string, status: UserFeedback['status'], resolution?: string): boolean {
    const feedback = this.feedbacks.get(feedbackId);
    if (!feedback) return false;

    feedback.status = status;
    feedback.updatedAt = Date.now();
    if (resolution) {
      feedback.resolution = resolution;
    }

    this.log.info('反馈状态已更新', { feedbackId, status });
    EventBus.getInstance().emitSync('monitoring.feedback.updated', { feedbackId, status });

    this.persistData();
    return true;
  }

  /**
   * 获取反馈列表
   */
  getFeedbacks(filter?: {
    type?: UserFeedback['type'];
    priority?: UserFeedback['priority'];
    status?: UserFeedback['status'];
  }): UserFeedback[] {
    let result = Array.from(this.feedbacks.values());
    if (filter) {
      if (filter.type) result = result.filter(f => f.type === filter.type);
      if (filter.priority) result = result.filter(f => f.priority === filter.priority);
      if (filter.status) result = result.filter(f => f.status === filter.status);
    }
    return result.sort((a, b) => b.createdAt - a.createdAt);
  }

  // ========== 闭环改进流程 ==========

  /**
   * 创建改进项
   */
  createImprovement(params: {
    description: string;
    source: ImprovementItem['source'];
    relatedFeedbackIds?: string[];
  }): ImprovementItem {
    const item: ImprovementItem = {
      id: `imp_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 6)}`,
      phase: 'assess',
      description: params.description,
      source: params.source,
      relatedFeedbackIds: params.relatedFeedbackIds,
      createdAt: Date.now(),
      status: 'pending',
    };

    this.improvements.set(item.id, item);
    this.log.info('改进项已创建', { improvementId: item.id, source: params.source });
    EventBus.getInstance().emitSync('monitoring.improvement.created', item);

    this.persistData();
    return item;
  }

  /**
   * 推进改进项到下一阶段
   *
   * 评估 → 优化 → 验证 → 迭代 → 完成
   */
  advanceImprovement(improvementId: string): ImprovementItem | null {
    const item = this.improvements.get(improvementId);
    if (!item) return null;

    const phaseOrder: ImprovementItem['phase'][] = ['assess', 'optimize', 'verify', 'iterate'];
    const currentIdx = phaseOrder.indexOf(item.phase);

    if (currentIdx < 0 || currentIdx >= phaseOrder.length - 1) {
      // 已到最后阶段，标记完成
      item.status = 'completed';
      item.completedAt = Date.now();
    } else {
      item.phase = phaseOrder[currentIdx + 1];
      item.status = 'in_progress';
    }

    item.updatedAt = Date.now();
    this.log.info('改进项已推进', { improvementId, phase: item.phase, status: item.status });
    EventBus.getInstance().emitSync('monitoring.improvement.advanced', { improvementId, phase: item.phase });

    this.persistData();
    return item;
  }

  /**
   * 获取改进项列表
   */
  getImprovements(filter?: { phase?: ImprovementItem['phase']; status?: ImprovementItem['status'] }): ImprovementItem[] {
    let result = Array.from(this.improvements.values());
    if (filter) {
      if (filter.phase) result = result.filter(i => i.phase === filter.phase);
      if (filter.status) result = result.filter(i => i.status === filter.status);
    }
    return result.sort((a, b) => b.createdAt - a.createdAt);
  }

  // ========== Dashboard ==========

  /**
   * 生成 Dashboard 数据
   */
  generateDashboard(): {
    dimensions: DimensionScore[];
    overall: { score: number; trend: string; change: number };
    activeAlerts: AlertRecord[];
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    metricStats: Record<string, any>;
    feedbackSummary: { total: number; byPriority: Record<string, number>; byStatus: Record<string, number> };
    improvementSummary: { total: number; byPhase: Record<string, number>; byStatus: Record<string, number> };
  } {
    const dimensions = this.getAllDimensionScores();
    const overall = this.getOverallScore();
    const activeAlerts = this.getActiveAlerts();

    const metricStats: Record<string, unknown> = {};
    for (const [name, config] of Object.entries(ALERT_THRESHOLDS)) {
      const category = this.getMetricCategoryForName(name);
      if (category) {
        const stats = this.getMetricStats(category, name);
        if (stats) {
          metricStats[name] = { ...stats, unit: config.unit, description: config.description };
        }
      }
    }

    const feedbacks = Array.from(this.feedbacks.values());
    const feedbackSummary = {
      total: feedbacks.length,
      byPriority: {} as Record<string, number>,
      byStatus: {} as Record<string, number>,
    };
    for (const f of feedbacks) {
      feedbackSummary.byPriority[f.priority] = (feedbackSummary.byPriority[f.priority] ?? 0) + 1;
      feedbackSummary.byStatus[f.status] = (feedbackSummary.byStatus[f.status] ?? 0) + 1;
    }

    const improvements = Array.from(this.improvements.values());
    const improvementSummary = {
      total: improvements.length,
      byPhase: {} as Record<string, number>,
      byStatus: {} as Record<string, number>,
    };
    for (const i of improvements) {
      improvementSummary.byPhase[i.phase] = (improvementSummary.byPhase[i.phase] ?? 0) + 1;
      improvementSummary.byStatus[i.status] = (improvementSummary.byStatus[i.status] ?? 0) + 1;
    }

    return { dimensions, overall, activeAlerts, metricStats, feedbackSummary, improvementSummary };
  }

  /** 根据指标名推断类别 */
  private getMetricCategoryForName(name: string): MetricCategory | null {
    const mapping: Record<string, MetricCategory> = {
      first_char_response_time: 'response_time',
      avg_response_latency: 'response_time',
      response_time: 'response_time',
      task_completion_rate: 'task_completion',
      error_rate: 'error_rate',
      cpu_usage: 'resource_usage',
      memory_usage: 'resource_usage',
      context_usage: 'context_usage',
      user_satisfaction: 'user_satisfaction',
    };
    return mapping[name] ?? null;
  }

  // ========== 持久化 ==========

  /** 持久化所有数据 */
  private persistData(): void {
    try {
      const data = {
        metrics: Array.from(this.metrics.entries()),
        dimensionScores: Array.from(this.dimensionScores.entries()),
        activeAlerts: Array.from(this.activeAlerts.entries()),
        alertHistory: this.alertHistory.slice(-200),
        feedbacks: Array.from(this.feedbacks.entries()),
        improvements: Array.from(this.improvements.entries()),
      };
      const dataPath = path.join(this.workDir, 'monitoring-data.json');
      atomicWriteJsonSync(dataPath, data);
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      this.log.error('持久化监控数据失败', { error: msg });
    }
  }

  /** 加载数据 */
  private loadData(): void {
    try {
      const dataPath = path.join(this.workDir, 'monitoring-data.json');
      if (!fs.existsSync(dataPath)) return;

      const data = JSON.parse(fs.readFileSync(dataPath, 'utf-8'));

      if (data.metrics) {
        for (const [cat, records] of data.metrics) {
          this.metrics.set(cat as MetricCategory, records);
        }
      }

      if (data.dimensionScores) {
        for (const [id, history] of data.dimensionScores) {
          this.dimensionScores.set(id, history);
        }
      }

      if (data.activeAlerts) {
        for (const [id, alert] of data.activeAlerts) {
          this.activeAlerts.set(id, alert);
        }
      }

      if (data.alertHistory) {
        this.alertHistory = data.alertHistory;
      }

      if (data.feedbacks) {
        for (const [id, fb] of data.feedbacks) {
          this.feedbacks.set(id, fb);
        }
      }

      if (data.improvements) {
        for (const [id, imp] of data.improvements) {
          this.improvements.set(id, imp);
        }
      }

      this.log.info('监控数据已加载', {
        metrics: this.metrics.size,
        dimensions: this.dimensionScores.size,
        feedbacks: this.feedbacks.size,
        improvements: this.improvements.size,
      });
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      this.log.error('加载监控数据失败', { error: msg });
    }
  }
}
