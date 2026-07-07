/**
 * 性能评估系统 - PerformanceMetricsSystem
 * 跟踪、分析和报告系统性能指标，支持分阶段目标管理
 *
 * 核心能力：
 * 1. 指标记录 - 记录每次交互的性能快照
 * 2. 趋势分析 - 追踪各指标的变化趋势
 * 3. 阶段目标 - 管理三个阶段的性能目标及进度
 * 4. 报告生成 - 输出性能报告和改进建议
 *
 * 三阶段目标：
 * - 第一阶段（3个月）：意图准确率85%，任务完成率80%
 * - 第二阶段（6个月）：意图准确率90%，任务完成率88%，满意度4.2/5
 * - 第三阶段（12个月）：意图准确率95%，任务完成率95%，满意度4.5/5
 */

import * as fs from 'fs/promises';
import * as path from 'path';
import { atomicWriteJson } from './atomic-write.js';

/** 性能快照 */
export interface PerformanceSnapshot {
  timestamp: Date;
  intentAccuracy: number;      // 意图理解准确率
  taskCompletionRate: number;  // 任务完成率
  userSatisfaction: number;    // 用户满意度 (1-5)
  avgResponseTime: number;     // 平均响应时间(ms)
  toolCallSuccessRate: number; // 工具调用成功率
  contextCoherence: number;    // 上下文连贯性
  selfCorrectionRate: number;  // 自我修正率
  totalInteractions: number;   // 总交互次数
}

/** 阶段目标 */
export interface PhaseTarget {
  name: string;
  duration: string;           // 如"3个月"
  cumulativeMonths: number;   // 阶段截止的累计月份(以系统启动为起点)，用于按月份判断当前阶段
  intentAccuracy: number;     // 目标准确率
  taskCompletionRate: number;
  userSatisfaction: number;
}

/** 指标趋势 */
export interface MetricTrend {
  metric: string;
  values: Array<{ date: Date; value: number }>;
  trend: 'improving' | 'stable' | 'declining';
  changePercent: number;
}

/** 阶段进度 */
interface PhaseProgress {
  current: PerformanceSnapshot;
  target: PhaseTarget;
  progress: number;
}

// 三个阶段的性能目标
const PHASE_TARGETS: PhaseTarget[] = [
  {
    name: '第一阶段',

    duration: '3个月',
    cumulativeMonths: 3,
    intentAccuracy: 0.85,
    taskCompletionRate: 0.80,
    userSatisfaction: 3.5, // 第一阶段未明确，设为合理中间值
  },
  {
    name: '第二阶段',
    duration: '6个月',
    cumulativeMonths: 6,
    intentAccuracy: 0.90,
    taskCompletionRate: 0.88,
    userSatisfaction: 4.2,
  },
  {
    name: '第三阶段',
    duration: '12个月',
    cumulativeMonths: 12,
    intentAccuracy: 0.95,
    taskCompletionRate: 0.95,
    userSatisfaction: 4.5,
  },
];

export class PerformanceMetricsSystem {
  private snapshots: PerformanceSnapshot[] = [];
  private dataDir: string;

  constructor(dataDir?: string) {
    this.dataDir = dataDir || path.join(process.cwd(), 'data');
  }

  /**
   * 获取所有历史快照
   */
  getAllSnapshots(): PerformanceSnapshot[] {
    return this.snapshots.map(s => ({ ...s }));
  }

  /**
   * 记录一次性能快照
   */
  recordMetric(snapshot: PerformanceSnapshot): void {
    this.snapshots.push({
      ...snapshot,
      timestamp: new Date(snapshot.timestamp),
    });
  }

  /**
   * 获取最新的性能快照
   * 如果没有记录，返回全零默认值
   */
  getCurrentMetrics(): PerformanceSnapshot {
    if (this.snapshots.length === 0) {
      return {
        timestamp: new Date(),
        intentAccuracy: 0,
        taskCompletionRate: 0,
        userSatisfaction: 0,
        avgResponseTime: 0,
        toolCallSuccessRate: 0,
        contextCoherence: 0,
        selfCorrectionRate: 0,
        totalInteractions: 0,
      };
    }
    return { ...this.snapshots[this.snapshots.length - 1] };
  }

  /**
   * 获取指定指标的趋势
   * 基于最近10条记录的线性回归斜率判断趋势方向
   */
  getTrend(metric: string): MetricTrend {
    const recentSnapshots = this.snapshots.slice(-10);

    // 提取对应指标的值
    const values: Array<{ date: Date; value: number }> = recentSnapshots.map(s => ({
      date: new Date(s.timestamp),
      value: this.getMetricValue(s, metric),
    }));

    // 计算趋势方向
    let trend: MetricTrend['trend'] = 'stable';
    let changePercent = 0;

    if (values.length >= 2) {
      // 简单线性回归计算斜率
      const slope = this.computeSlope(values);
      const firstValue = values[0].value;
      const lastValue = values[values.length - 1].value;

      if (firstValue !== 0) {
        changePercent = Math.round(((lastValue - firstValue) / firstValue) * 10000) / 100;
      }

      // 判断趋势：斜率绝对值 > 阈值才认为有趋势
      const threshold = 0.005;
      if (slope > threshold) {
        trend = 'improving';
      } else if (slope < -threshold) {
        trend = 'declining';
      }
    }

    return { metric, values, trend, changePercent };
  }

  /**
   * 获取指定阶段的进度
   * @param phase 阶段编号（1-3）
   */
  getPhaseProgress(phase: number): PhaseProgress {
    const target = PHASE_TARGETS[phase - 1];
    if (!target) {
      throw new Error(`无效的阶段编号: ${phase}，有效范围为1-3`);
    }

    const current = this.getCurrentMetrics();

    // 计算各核心指标的达标率
    const accuracyProgress = target.intentAccuracy > 0
      ? Math.min(current.intentAccuracy / target.intentAccuracy, 1.0)
      : 0;
    const completionProgress = target.taskCompletionRate > 0
      ? Math.min(current.taskCompletionRate / target.taskCompletionRate, 1.0)
      : 0;
    const satisfactionProgress = target.userSatisfaction > 0
      ? Math.min(current.userSatisfaction / target.userSatisfaction, 1.0)
      : 0;

    // 综合进度为三项指标进度的加权平均
    const progress = Math.round(
      ((accuracyProgress + completionProgress + satisfactionProgress) / 3) * 10000
    ) / 100;

    return { current, target, progress };
  }

  /**
   * 生成性能评估报告
   */
  generateReport(): string {
    const current = this.getCurrentMetrics();
    const lines: string[] = [];

    lines.push('📊 性能评估报告');
    lines.push(`生成时间: ${new Date().toLocaleString('zh-CN')}`);
    lines.push('');

    // 当前指标
    lines.push('━━━ 当前指标 ━━━');
    lines.push(`意图理解准确率: ${(current.intentAccuracy * 100).toFixed(1)}%`);
    lines.push(`任务完成率: ${(current.taskCompletionRate * 100).toFixed(1)}%`);
    lines.push(`用户满意度: ${current.userSatisfaction.toFixed(1)}/5`);
    lines.push(`平均响应时间: ${current.avgResponseTime.toFixed(0)}ms`);
    lines.push(`工具调用成功率: ${(current.toolCallSuccessRate * 100).toFixed(1)}%`);
    lines.push(`上下文连贯性: ${(current.contextCoherence * 100).toFixed(1)}%`);
    lines.push(`自我修正率: ${(current.selfCorrectionRate * 100).toFixed(1)}%`);
    lines.push(`总交互次数: ${current.totalInteractions}`);
    lines.push('');

    // 各阶段进度
    lines.push('━━━ 阶段目标进度 ━━━');
    for (let i = 1; i <= 3; i++) {
      const progress = this.getPhaseProgress(i);
      const target = progress.target;
      lines.push(`${target.name}（${target.duration}）: 进度 ${progress.progress.toFixed(1)}%`);
      lines.push(`  目标 - 意图准确率${(target.intentAccuracy * 100).toFixed(0)}% / 任务完成率${(target.taskCompletionRate * 100).toFixed(0)}%${target.userSatisfaction > 0 ? ` / 满意度${target.userSatisfaction}/5` : ''}`);
    }
    lines.push('');

    // 趋势概览
    lines.push('━━━ 指标趋势 ━━━');
    const metricNames = [
      'intentAccuracy', 'taskCompletionRate', 'userSatisfaction',
      'avgResponseTime', 'toolCallSuccessRate', 'contextCoherence', 'selfCorrectionRate',
    ];
    const metricLabels: Record<string, string> = {
      intentAccuracy: '意图准确率',
      taskCompletionRate: '任务完成率',
      userSatisfaction: '用户满意度',
      avgResponseTime: '响应时间',
      toolCallSuccessRate: '工具调用成功率',
      contextCoherence: '上下文连贯性',
      selfCorrectionRate: '自我修正率',
    };
    for (const metric of metricNames) {
      const trend = this.getTrend(metric);
      const label = metricLabels[metric] || metric;
      let trendLabel: string;
      if (trend.trend === 'improving') {
        trendLabel = '↑ 上升';
      } else if (trend.trend === 'declining') {
        trendLabel = '↓ 下降';
      } else {
        trendLabel = '→ 稳定';
      }
      lines.push(`${label}: ${trendLabel}（变化${trend.changePercent > 0 ? '+' : ''}${trend.changePercent.toFixed(1)}%）`);
    }

    return lines.join('\n');
  }

  /**
   * 获取改进建议
   * 基于当前指标与阶段目标的差距，生成优先级排序的建议
   */
  getRecommendations(): string[] {
    const recommendations: string[] = [];
    const current = this.getCurrentMetrics();

    // 确定当前应处于的阶段
    const phase = this.determineCurrentPhase();
    const target = PHASE_TARGETS[phase - 1];

    // 意图准确率不足
    if (current.intentAccuracy < target.intentAccuracy) {
      const gap = ((target.intentAccuracy - current.intentAccuracy) * 100).toFixed(1);
      recommendations.push(`意图理解准确率距目标差${gap}%，建议优化意图识别模型和上下文理解策略`);
    }

    // 任务完成率不足
    if (current.taskCompletionRate < target.taskCompletionRate) {
      const gap = ((target.taskCompletionRate - current.taskCompletionRate) * 100).toFixed(1);
      recommendations.push(`任务完成率距目标差${gap}%，建议增强任务分解和工具调用能力`);
    }

    // 用户满意度不足
    if (current.userSatisfaction < target.userSatisfaction) {
      const gap = (target.userSatisfaction - current.userSatisfaction).toFixed(1);
      recommendations.push(`用户满意度距目标差${gap}分，建议改进回复质量和交互体验`);
    }

    // 响应时间过长
    if (current.avgResponseTime > 2000) {
      recommendations.push('平均响应时间超过2秒，建议优化推理流程和减少不必要的工具调用');
    }

    // 工具调用成功率低
    if (current.toolCallSuccessRate < 0.85) {
      recommendations.push('工具调用成功率低于85%，建议增加参数校验和错误重试机制');
    }

    // 上下文连贯性低
    if (current.contextCoherence < 0.7) {
      recommendations.push('上下文连贯性低于70%，建议优化对话历史管理和上下文窗口策略');
    }

    // 自我修正率低
    if (current.selfCorrectionRate < 0.3 && current.totalInteractions > 50) {
      recommendations.push('自我修正率较低，建议增强反思机制和错误检测能力');
    }

    // 如果所有指标都达标
    if (recommendations.length === 0) {
      recommendations.push('当前各项指标均已达到阶段目标，建议关注下一阶段的提升方向');
    }

    return recommendations;
  }

  /**
   * 保存数据到磁盘
   */
  async save(): Promise<void> {
    try {
      await fs.mkdir(this.dataDir, { recursive: true });

      const data = {
        snapshots: this.snapshots,
      };

      await atomicWriteJson(
        path.join(this.dataDir, 'performance-metrics.json'),
        data
      );
    } catch (error: unknown) {
      console.error('保存性能指标数据失败:', error);
    }
  }

  /**
   * 从磁盘加载数据
   * 优先加载 data/performance-metrics.json；若不存在则回退到 .awareness/metrics.json 并做字段映射
   */
  async load(): Promise<void> {
    try {
      const filePath = path.join(this.dataDir, 'performance-metrics.json');
      const content = await fs.readFile(filePath, 'utf-8');
      const data = JSON.parse(content);

      // eslint-disable-next-line @typescript-eslint/no-explicit-any -- 从磁盘加载的 JSON 快照,字段为动态结构
      this.snapshots = (data.snapshots || []).map((s: any) => ({
        ...s,
        timestamp: new Date(s.timestamp),
      }));
      if (this.snapshots.length > 0) return;
    } catch {
      // 主数据文件不存在，继续尝试回退源
    }

    // 回退：从 .awareness/metrics.json 加载（snake_case 格式）并映射为 PerformanceSnapshot
    try {
      const fallbackPath = path.join(process.cwd(), '.awareness', 'metrics.json');
      const raw = JSON.parse(await fs.readFile(fallbackPath, 'utf-8'));
      const pct = (v: unknown) => {
        if (typeof v === 'number') {
          return v > 1 ? v / 100 : v;
        }
        return 0;
      };
      const cur = (k: string) => (raw[k] && typeof raw[k].current === 'number') ? raw[k].current : 0;
      const snapshot: PerformanceSnapshot = {
        timestamp: raw.lastUpdated ? new Date(raw.lastUpdated) : new Date(),
        intentAccuracy: pct(cur('decision_accuracy')),
        taskCompletionRate: pct(cur('task_completion_rate')),
        // P0 真实修复：移除硬编码默认值，改为从原始数据读取或保持 0（不再伪造指标）
        userSatisfaction: cur('user_satisfaction') || 0,
        avgResponseTime: cur('avg_response_time') || 0,
        toolCallSuccessRate: pct(cur('tool_success_rate')),
        contextCoherence: pct(cur('context_coherence')),
        selfCorrectionRate: pct(cur('self_correction_rate')),
        totalInteractions: cur('total_interactions') || 0,
      };
      this.snapshots.push(snapshot);
    } catch {
      // 回退源也不存在，保持空数据
    }
  }

  // ========== 私有方法 ==========

  /**
   * 从快照中提取指定指标的值
   */
  private getMetricValue(snapshot: PerformanceSnapshot, metric: string): number {
    const metricMap: Record<string, number> = {
      intentAccuracy: snapshot.intentAccuracy,
      taskCompletionRate: snapshot.taskCompletionRate,
      userSatisfaction: snapshot.userSatisfaction,
      avgResponseTime: snapshot.avgResponseTime,
      toolCallSuccessRate: snapshot.toolCallSuccessRate,
      contextCoherence: snapshot.contextCoherence,
      selfCorrectionRate: snapshot.selfCorrectionRate,
      totalInteractions: snapshot.totalInteractions,
    };
    return metricMap[metric] ?? 0;
  }

  /**
   * 计算简单线性回归斜率
   * 用于判断指标趋势方向
   */
  private computeSlope(values: Array<{ date: Date; value: number }>): number {
    const n = values.length;
    if (n < 2) return 0;

    // 用索引作为x轴，值作为y轴
    let sumX = 0, sumY = 0, sumXY = 0, sumX2 = 0;
    for (let i = 0; i < n; i++) {
      sumX += i;
      sumY += values[i].value;
      sumXY += i * values[i].value;
      sumX2 += i * i;
    }

    const denominator = n * sumX2 - sumX * sumX;
    if (denominator === 0) return 0;

    return (n * sumXY - sumX * sumY) / denominator;
  }

  /**
   * 根据快照数量判断当前应处于的阶段
   * 简单启发式：基于数据量估算时间进度
   */
  private determineCurrentPhase(): number {
    const count = this.snapshots.length;
    if (count < 100) return 1;   // 少量数据，处于第一阶段
    if (count < 500) return 2;   // 中等数据，处于第二阶段
    return 3;                     // 大量数据，处于第三阶段
  }

  /**
   * P0 真实修复：暴露工具定义 — 使 PerformanceMetricsSystem 可注册到主循环作为工具
   *
   * 之前该类不暴露 getToolDefinitions()，导致它无法注册到 standardToolModules，
   * 主循环无法主动查询性能指标，只能通过 LLM 调用其他工具间接获取。
   */
  // eslint-disable-next-line @typescript-eslint/no-explicit-any -- 工具定义需兼容 ToolDef[] (parameters: Record<string,any> / execute: (args:any)),见 bootstrap.ts standardToolModules
  getToolDefinitions(): Array<{ name: string; description: string; parameters: Record<string, any>; readOnly?: boolean; execute: (args: any) => Promise<string> }> {
    return [
      {
        name: 'performance_query',
        description: '查询当前性能指标快照（包括意图准确率、任务完成率、工具成功率等）',
        parameters: {},
        readOnly: true,
        execute: () => {
          const metrics = this.getCurrentMetrics();
          return Promise.resolve(JSON.stringify({
            timestamp: metrics.timestamp.toISOString(),
            intentAccuracy: metrics.intentAccuracy,
            taskCompletionRate: metrics.taskCompletionRate,
            userSatisfaction: metrics.userSatisfaction,
            avgResponseTime: metrics.avgResponseTime,
            toolCallSuccessRate: metrics.toolCallSuccessRate,
            contextCoherence: metrics.contextCoherence,
            selfCorrectionRate: metrics.selfCorrectionRate,
            totalInteractions: metrics.totalInteractions,
          }, null, 2));
        },
      },
      {
        name: 'performance_trend',
        description: '查询性能趋势（最近 10 个快照的指标变化）',
        parameters: {
          metric: { type: 'string', description: '指标名称 (intentAccuracy/taskCompletionRate/toolCallSuccessRate)', required: false },
        },
        readOnly: true,
        // eslint-disable-next-line @typescript-eslint/no-explicit-any -- 工具执行参数为动态 JSON
        execute: (args: any) => {
          const metric = args.metric || 'intentAccuracy';
          const trend = this.getTrend(metric);
          return Promise.resolve(JSON.stringify({
            metric,
            trend: trend.trend,
            changePercent: trend.changePercent,
            values: trend.values,
            sampleCount: trend.values?.length || 0,
          }, null, 2));
        },
      },
      {
        name: 'performance_report',
        description: '生成完整性能报告（含当前指标、阶段进度、改进建议）',
        parameters: {},
        readOnly: true,
        execute: () => {
          const report = this.generateReport();
          return Promise.resolve(report);
        },
      },
    ];
  }
}
