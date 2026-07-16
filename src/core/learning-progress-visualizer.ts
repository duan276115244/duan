/**
 * LearningProgressVisualizer — 学习进度可视化
 *
 * v20.0 §5.4 学习增强的进度可视化实现。
 *
 * 聚合多个学习数据源，生成可视化数据：
 * 1. 学习曲线 — 时间序列数据（学习记录数、技能等级、指标值变化）
 * 2. 能力雷达图 — 8 维能力评分（来自 CapabilityScoreMatrix）
 * 3. 进度报告 — Markdown 格式的综合报告
 * 4. 趋势分析 — 改进/下降/稳定趋势统计
 *
 * 数据源（松耦合，可选注入，缺失时降级）：
 * - SelfLearningSystem: 学习记录、技能等级、知识盲区
 * - EvolutionMetrics: 16 个进化指标 + 时间序列
 * - CapabilityScoreMatrix: 8 维能力评分 + 子项
 * - SelfAssessment: 12 个自评估指标 + 评估历史
 * - DuanPersonaEngine: 用户知识盲区 + 错误模式
 *
 * 数据存储：~/.duan/progress/
 *   - snapshots.json — 历史快照（每日聚合，最多 365 天）
 *   - reports.json   — 已生成的报告索引
 *
 * 设计原则：
 * - 数据源可选，缺失时优雅降级（不抛错）
 * - 不修改任何数据源模块，仅读取
 * - 快照机制：每次 generateSnapshot() 时聚合当前状态并持久化
 */

import * as fs from 'fs';
import * as path from 'path';
import { logger } from './structured-logger.js';
import { duanPath } from './duan-paths.js';
import { atomicWriteJsonSync } from './atomic-write.js';
import type { ToolDef } from './unified-tool-def.js';

// ============ 数据源接口（松耦合，避免循环依赖） ============

/** 学习记录最小接口（兼容 SelfLearningSystem.LearningRecord） */
interface LearningRecordLite {
  id: string;
  type: string;
  category: string;
  content: string;
  confidence: number;
  frequency: number;
  lastSeen: number;
  firstSeen: number;
  applied: boolean;
  appliedCount: number;
  outcome?: 'positive' | 'negative' | 'neutral';
  tags: string[];
}

/** 技能等级最小接口 */
interface SkillLevelLite {
  name: string;
  level: number;
  progress: number;
}

/** 进化指标最小接口（兼容 EvolutionMetrics.EvolutionMetric） */
interface EvolutionMetricLite {
  id: string;
  name: string;
  description: string;
  category: string;
  unit: string;
  target: number;
  currentValue: number;
  history: Array<{ timestamp: number; value: number }>;
  trend: 'improving' | 'declining' | 'stable';
  weight: number;
  lastUpdated: number;
}

/** 能力维度最小接口（兼容 CapabilityScoreMatrix.CapabilityDimension） */
interface CapabilityDimensionLite {
  id: string;
  name: string;
  category: string;
  currentScore: number;
  targetScore: number;
  subItems: Array<{
    name: string;
    score: number;
    status: 'not_started' | 'in_progress' | 'completed' | 'optimized';
    evidence: string;
    gap: string;
  }>;
  lastUpdated: number;
}

/** 自评估指标最小接口（兼容 SelfAssessment.Metric） */
interface AssessmentMetricLite {
  key: string;
  name: string;
  description: string;
  unit: string;
  target: number;
  current: number;
  trend: 'up' | 'down' | 'stable';
  history: Array<{ timestamp: number; value: number }>;
}

/** 用户知识画像最小接口（兼容 DuanPersonaEngine.UserKnowledgeProfile） */
interface UserProfileLite {
  masteredDomains: Array<{ domain: string; level: number; lastUsed: number }>;
  knowledgeGaps: Array<{ domain: string; evidence: string; detectedAt: number }>;
  interests: Array<{ topic: string; weight: number }>;
  errorPatterns: Array<{ pattern: string; count: number; lastOccurrence: number }>;
}

/** 数据源适配器接口 — 避免直接依赖具体类 */
export interface ProgressDataSource {
  /** 获取学习记录（可选） */
  getLearningRecords?(limit?: number): LearningRecordLite[];
  /** 获取技能等级（可选） */
  getSkillLevels?(): SkillLevelLite[];
  /** 获取知识盲区列表（可选） */
  getKnowledgeGaps?(): string[];
  /** 获取进化指标（可选） */
  getEvolutionMetrics?(): EvolutionMetricLite[];
  /** 获取能力维度评分（可选） */
  getCapabilityDimensions?(): CapabilityDimensionLite[];
  /** 获取自评估指标（可选） */
  getAssessmentMetrics?(): AssessmentMetricLite[];
  /** 获取用户画像（可选） */
  getUserProfile?(userId?: string): UserProfileLite | null;
}

// ============ 可视化数据类型 ============

/** 学习曲线数据点 */
export interface LearningCurvePoint {
  timestamp: number;
  date: string; // YYYY-MM-DD
  totalRecords: number;
  newRecords: number;
  appliedRecords: number;
  positiveOutcomes: number;
  negativeOutcomes: number;
  averageConfidence: number;
}

/** 学习曲线 */
export interface LearningCurve {
  points: LearningCurvePoint[];
  totalRecords: number;
  dateRange: { start: string | null; end: string | null };
  granularity: 'daily' | 'weekly' | 'monthly';
}

/** 雷达图维度 */
export interface RadarDimension {
  id: string;
  name: string;
  current: number; // 归一化到 0-100
  target: number;  // 归一化到 0-100
  gap: number;     // target - current
  lastUpdated: number;
}

/** 能力雷达图 */
export interface RadarChart {
  dimensions: RadarDimension[];
  overallScore: number;
  overallTarget: number;
  generatedAt: number;
  source: 'capability_matrix' | 'evolution_metrics' | 'assessment' | 'merged';
}

/** 技能树节点 */
export interface SkillTreeNode {
  name: string;
  level: number;
  progress: number;
  category: string;
  children: SkillTreeNode[];
}

/** 技能树 */
export interface SkillTree {
  roots: SkillTreeNode[];
  totalSkills: number;
  averageLevel: number;
  generatedAt: number;
}

/** 趋势统计 */
export interface TrendStats {
  improving: number;
  declining: number;
  stable: number;
  total: number;
  improvingMetrics: string[];
  decliningMetrics: string[];
}

/** 知识盲区视图 */
export interface KnowledgeGapView {
  gaps: Array<{ domain: string; evidence: string; detectedAt: number; source: 'learning' | 'persona' }>;
  errorPatterns: Array<{ pattern: string; count: number; lastOccurrence: number }>;
  totalGaps: number;
  totalErrorPatterns: number;
}

/** 进度快照 */
export interface ProgressSnapshot {
  timestamp: number;
  date: string; // YYYY-MM-DD
  totalLearningRecords: number;
  totalSkills: number;
  averageSkillLevel: number;
  capabilityOverall: number;
  evolutionOverall: number | null;
  assessmentOverall: number | null;
  knowledgeGapsCount: number;
  errorPatternsCount: number;
  topSkills: Array<{ name: string; level: number }>;
  topGaps: string[];
  trendStats: TrendStats;
}

/** 完整进度报告 */
export interface ProgressReport {
  generatedAt: number;
  dateRange: { start: string | null; end: string | null };
  summary: {
    totalLearningRecords: number;
    totalSkills: number;
    averageSkillLevel: number;
    capabilityOverall: number;
    knowledgeGapsCount: number;
    trendStats: TrendStats;
  };
  radarChart: RadarChart;
  learningCurve: LearningCurve;
  skillTree: SkillTree;
  knowledgeGaps: KnowledgeGapView;
  topImprovements: string[];
  topRisks: string[];
  recommendations: string[];
}

// ============ 内部辅助函数 ============

/** 格式化日期为 YYYY-MM-DD */
function formatDate(ts: number): string {
  const d = new Date(ts);
  const year = d.getFullYear();
  const month = String(d.getMonth() + 1).padStart(2, '0');
  const day = String(d.getDate()).padStart(2, '0');
  return `${year}-${month}-${day}`;
}

/** 归一化分数到 0-100 */
function normalizeTo100(score: number, max: number): number {
  if (max <= 0) return 0;
  return Math.max(0, Math.min(100, (score / max) * 100));
}

// ============ LearningProgressVisualizer 主类 ============

/** 最大快照数（一年） */
const MAX_SNAPSHOTS = 365;
/** 最大报告索引数 */
const MAX_REPORTS = 100;

export class LearningProgressVisualizer {
  private static _instance: LearningProgressVisualizer | null = null;

  private dataDir: string;
  private snapshotsPath: string;
  private reportsPath: string;

  private source: ProgressDataSource | null = null;
  private snapshots: ProgressSnapshot[] = [];
  private reports: Array<{ id: string; generatedAt: number; dateRange: { start: string | null; end: string | null } }> = [];

  private log = logger.child({ module: 'LearningProgressVisualizer' });

  constructor(dataDir?: string) {
    this.dataDir = dataDir ?? duanPath('progress');
    this.snapshotsPath = path.join(this.dataDir, 'snapshots.json');
    this.reportsPath = path.join(this.dataDir, 'reports.json');
  }

  static getInstance(): LearningProgressVisualizer {
    if (!LearningProgressVisualizer._instance) {
      LearningProgressVisualizer._instance = new LearningProgressVisualizer();
    }
    return LearningProgressVisualizer._instance;
  }

  static _resetInstance(): void {
    LearningProgressVisualizer._instance = null;
  }

  /** 注入数据源 */
  setDataSource(source: ProgressDataSource): void {
    this.source = source;
    this.log.debug('数据源已注入');
  }

  /** 初始化 */
  async initialize(): Promise<void> {
    fs.mkdirSync(this.dataDir, { recursive: true });
    this.loadSnapshots();
    this.loadReports();
    this.log.info('LearningProgressVisualizer 初始化完成', {
      snapshots: this.snapshots.length,
      reports: this.reports.length,
      hasSource: this.source !== null,
    });
  }

  // ============ 学习曲线 ============

  /**
   * 生成学习曲线（按日/周/月聚合）
   */
  generateLearningCurve(granularity: 'daily' | 'weekly' | 'monthly' = 'daily', days: number = 30): LearningCurve {
    if (!this.source?.getLearningRecords) {
      return { points: [], totalRecords: 0, dateRange: { start: null, end: null }, granularity };
    }

    const records = this.source.getLearningRecords();
    if (records.length === 0) {
      return { points: [], totalRecords: 0, dateRange: { start: null, end: null }, granularity };
    }

    // 按时间分组
    const grouped = new Map<string, LearningRecordLite[]>();
    const now = Date.now();
    const cutoff = now - days * 24 * 60 * 60 * 1000;

    for (const record of records) {
      const ts = record.lastSeen ?? record.firstSeen;
      if (ts < cutoff) continue;
      const dateKey = this.groupKey(ts, granularity);
      const arr = grouped.get(dateKey) ?? [];
      arr.push(record);
      grouped.set(dateKey, arr);
    }

    // 排序日期
    const sortedKeys = Array.from(grouped.keys()).sort();
    const points: LearningCurvePoint[] = [];
    let cumulativeTotal = 0;

    // 计算起点之前已有总数
    for (const record of records) {
      const ts = record.lastSeen ?? record.firstSeen;
      if (ts < cutoff) cumulativeTotal += 1;
    }

    for (const key of sortedKeys) {
      const groupRecords = grouped.get(key)!;
      const newRecords = groupRecords.length;
      cumulativeTotal += newRecords;
      const applied = groupRecords.filter(r => r.applied).length;
      const positive = groupRecords.filter(r => r.outcome === 'positive').length;
      const negative = groupRecords.filter(r => r.outcome === 'negative').length;
      const avgConfidence = newRecords > 0
        ? groupRecords.reduce((sum, r) => sum + (r.confidence ?? 0), 0) / newRecords
        : 0;

      points.push({
        timestamp: groupRecords[0]?.lastSeen ?? Date.now(),
        date: key,
        totalRecords: cumulativeTotal,
        newRecords,
        appliedRecords: applied,
        positiveOutcomes: positive,
        negativeOutcomes: negative,
        averageConfidence: Math.round(avgConfidence * 100) / 100,
      });
    }

    return {
      points,
      totalRecords: records.length,
      dateRange: {
        start: sortedKeys[0] ?? null,
        end: sortedKeys[sortedKeys.length - 1] ?? null,
      },
      granularity,
    };
  }

  /** 根据粒度生成分组 key */
  private groupKey(ts: number, granularity: 'daily' | 'weekly' | 'monthly'): string {
    const d = new Date(ts);
    const year = d.getFullYear();
    const month = String(d.getMonth() + 1).padStart(2, '0');
    const day = String(d.getDate()).padStart(2, '0');
    if (granularity === 'daily') {
      return `${year}-${month}-${day}`;
    } else if (granularity === 'weekly') {
      // ISO 周数
      const onejan = new Date(year, 0, 1);
      const week = Math.ceil(((d.getTime() - onejan.getTime()) / 86400000 + onejan.getDay() + 1) / 7);
      return `${year}-W${String(week).padStart(2, '0')}`;
    } else {
      return `${year}-${month}`;
    }
  }

  // ============ 能力雷达图 ============

  /**
   * 生成能力雷达图数据
   * 优先使用 CapabilityScoreMatrix（8 维度），否则回退到 EvolutionMetrics 类别评分
   */
  generateRadarChart(): RadarChart {
    // 优先使用 CapabilityScoreMatrix
    if (this.source?.getCapabilityDimensions) {
      const dims = this.source.getCapabilityDimensions();
      if (dims.length > 0) {
        const dimensions: RadarDimension[] = dims.map(d => ({
          id: d.id,
          name: d.name,
          current: normalizeTo100(d.currentScore, 10), // 0-10 → 0-100
          target: normalizeTo100(d.targetScore, 10),
          gap: normalizeTo100(d.targetScore - d.currentScore, 10),
          lastUpdated: d.lastUpdated,
        }));
        const overall = dimensions.reduce((s, d) => s + d.current, 0) / dimensions.length;
        const target = dimensions.reduce((s, d) => s + d.target, 0) / dimensions.length;
        return {
          dimensions,
          overallScore: Math.round(overall * 100) / 100,
          overallTarget: Math.round(target * 100) / 100,
          generatedAt: Date.now(),
          source: 'capability_matrix',
        };
      }
    }

    // 回退到 EvolutionMetrics 的 5 大类别
    if (this.source?.getEvolutionMetrics) {
      const metrics = this.source.getEvolutionMetrics();
      if (metrics.length > 0) {
        const byCategory = new Map<string, EvolutionMetricLite[]>();
        for (const m of metrics) {
          const arr = byCategory.get(m.category) ?? [];
          arr.push(m);
          byCategory.set(m.category, arr);
        }
        const dimensions: RadarDimension[] = Array.from(byCategory.entries()).map(([cat, ms]) => {
          const avgCurrent = ms.reduce((s, m) => s + m.currentValue, 0) / ms.length;
          const avgTarget = ms.reduce((s, m) => s + m.target, 0) / ms.length;
          return {
            id: cat,
            name: this.translateCategory(cat),
            current: normalizeTo100(avgCurrent, 100),
            target: normalizeTo100(avgTarget, 100),
            gap: normalizeTo100(avgTarget - avgCurrent, 100),
            lastUpdated: Date.now(),
          };
        });
        const overall = dimensions.reduce((s, d) => s + d.current, 0) / dimensions.length;
        const target = dimensions.reduce((s, d) => s + d.target, 0) / dimensions.length;
        return {
          dimensions,
          overallScore: Math.round(overall * 100) / 100,
          overallTarget: Math.round(target * 100) / 100,
          generatedAt: Date.now(),
          source: 'evolution_metrics',
        };
      }
    }

    // 最后回退到 SelfAssessment
    if (this.source?.getAssessmentMetrics) {
      const metrics = this.source.getAssessmentMetrics();
      if (metrics.length > 0) {
        const dimensions: RadarDimension[] = metrics.slice(0, 8).map(m => ({
          id: m.key,
          name: m.name,
          current: normalizeTo100(m.current, m.target || 100),
          target: 100,
          gap: normalizeTo100((m.target || 100) - m.current, m.target || 100),
          lastUpdated: Date.now(),
        }));
        const overall = dimensions.reduce((s, d) => s + d.current, 0) / dimensions.length;
        const target = dimensions.reduce((s, d) => s + d.target, 0) / dimensions.length;
        return {
          dimensions,
          overallScore: Math.round(overall * 100) / 100,
          overallTarget: Math.round(target * 100) / 100,
          generatedAt: Date.now(),
          source: 'assessment',
        };
      }
    }

    return { dimensions: [], overallScore: 0, overallTarget: 0, generatedAt: Date.now(), source: 'merged' };
  }

  /** 翻译 EvolutionMetrics 类别 */
  private translateCategory(cat: string): string {
    const map: Record<string, string> = {
      intelligence: '智能',
      evolution: '进化',
      functionality: '功能',
      performance: '性能',
      reliability: '可靠性',
    };
    return map[cat] ?? cat;
  }

  // ============ 技能树 ============

  /**
   * 生成技能树
   */
  generateSkillTree(): SkillTree {
    if (!this.source?.getSkillLevels) {
      return { roots: [], totalSkills: 0, averageLevel: 0, generatedAt: Date.now() };
    }

    const skills = this.source.getSkillLevels();
    if (skills.length === 0) {
      return { roots: [], totalSkills: 0, averageLevel: 0, generatedAt: Date.now() };
    }

    // 按名称推断 category（简单分词）
    const roots: SkillTreeNode[] = [];
    const categoryMap = new Map<string, SkillTreeNode>();

    for (const skill of skills) {
      const category = this.inferSkillCategory(skill.name);
      const node: SkillTreeNode = {
        name: skill.name,
        level: skill.level,
        progress: skill.progress,
        category,
        children: [],
      };
      if (!categoryMap.has(category)) {
        const root: SkillTreeNode = {
          name: category,
          level: 0,
          progress: 0,
          category,
          children: [],
        };
        categoryMap.set(category, root);
        roots.push(root);
      }
      categoryMap.get(category)!.children.push(node);
    }

    // 计算根节点平均等级
    for (const root of roots) {
      if (root.children.length > 0) {
        root.level = Math.round(root.children.reduce((s, c) => s + c.level, 0) / root.children.length * 100) / 100;
        root.progress = Math.round(root.children.reduce((s, c) => s + c.progress, 0) / root.children.length * 100) / 100;
      }
    }

    const avgLevel = skills.length > 0
      ? Math.round(skills.reduce((s, sk) => s + sk.level, 0) / skills.length * 100) / 100
      : 0;

    return {
      roots,
      totalSkills: skills.length,
      averageLevel: avgLevel,
      generatedAt: Date.now(),
    };
  }

  /** 推断技能分类 */
  private inferSkillCategory(name: string): string {
    const lower = name.toLowerCase();
    if (lower.includes('code') || lower.includes('代码') || lower.includes('编程')) return '编程';
    if (lower.includes('test') || lower.includes('测试')) return '测试';
    if (lower.includes('doc') || lower.includes('文档')) return '文档';
    if (lower.includes('debug') || lower.includes('调试')) return '调试';
    if (lower.includes('deploy') || lower.includes('部署')) return '部署';
    if (lower.includes('design') || lower.includes('设计')) return '设计';
    if (lower.includes('security') || lower.includes('安全')) return '安全';
    if (lower.includes('performance') || lower.includes('性能')) return '性能';
    if (lower.includes('git') || lower.includes('版本')) return '版本控制';
    return '其他';
  }

  // ============ 趋势分析 ============

  /**
   * 生成趋势统计
   */
  generateTrendStats(): TrendStats {
    if (!this.source?.getEvolutionMetrics) {
      return { improving: 0, declining: 0, stable: 0, total: 0, improvingMetrics: [], decliningMetrics: [] };
    }

    const metrics = this.source.getEvolutionMetrics();
    let improving = 0;
    let declining = 0;
    let stable = 0;
    const improvingMetrics: string[] = [];
    const decliningMetrics: string[] = [];

    for (const m of metrics) {
      if (m.trend === 'improving') {
        improving += 1;
        improvingMetrics.push(m.name);
      } else if (m.trend === 'declining') {
        declining += 1;
        decliningMetrics.push(m.name);
      } else {
        stable += 1;
      }
    }

    return {
      improving,
      declining,
      stable,
      total: metrics.length,
      improvingMetrics,
      decliningMetrics,
    };
  }

  // ============ 知识盲区视图 ============

  /**
   * 生成知识盲区视图
   */
  generateKnowledgeGapView(): KnowledgeGapView {
    const gaps: Array<{ domain: string; evidence: string; detectedAt: number; source: 'learning' | 'persona' }> = [];
    const errorPatterns: Array<{ pattern: string; count: number; lastOccurrence: number }> = [];

    // 从 SelfLearningSystem 获取知识盲区
    if (this.source?.getKnowledgeGaps) {
      const learningGaps = this.source.getKnowledgeGaps();
      for (const gap of learningGaps) {
        gaps.push({
          domain: gap,
          evidence: '学习记录中检测到',
          detectedAt: Date.now(),
          source: 'learning',
        });
      }
    }

    // 从 DuanPersonaEngine 获取用户画像
    if (this.source?.getUserProfile) {
      const profile = this.source.getUserProfile();
      if (profile) {
        for (const gap of profile.knowledgeGaps ?? []) {
          gaps.push({
            domain: gap.domain,
            evidence: gap.evidence,
            detectedAt: gap.detectedAt,
            source: 'persona',
          });
        }
        for (const ep of profile.errorPatterns ?? []) {
          errorPatterns.push({
            pattern: ep.pattern,
            count: ep.count,
            lastOccurrence: ep.lastOccurrence,
          });
        }
      }
    }

    return {
      gaps,
      errorPatterns,
      totalGaps: gaps.length,
      totalErrorPatterns: errorPatterns.length,
    };
  }

  // ============ 快照 ============

  /**
   * 生成当前进度快照并持久化
   */
  generateSnapshot(): ProgressSnapshot {
    const now = Date.now();
    const radar = this.generateRadarChart();
    const trendStats = this.generateTrendStats();
    const skillLevels = this.source?.getSkillLevels?.() ?? [];
    const knowledgeGaps = this.generateKnowledgeGapView();

    // 学习记录总数
    const records = this.source?.getLearningRecords?.() ?? [];

    // top skills（按 level 降序取前 5）
    const topSkills = skillLevels
      .slice()
      .sort((a, b) => b.level - a.level)
      .slice(0, 5)
      .map(s => ({ name: s.name, level: s.level }));

    // top gaps（取前 5）
    const topGaps = knowledgeGaps.gaps.slice(0, 5).map(g => g.domain);

    const snapshot: ProgressSnapshot = {
      timestamp: now,
      date: formatDate(now),
      totalLearningRecords: records.length,
      totalSkills: skillLevels.length,
      averageSkillLevel: skillLevels.length > 0
        ? Math.round(skillLevels.reduce((s, sk) => s + sk.level, 0) / skillLevels.length * 100) / 100
        : 0,
      capabilityOverall: radar.overallScore,
      evolutionOverall: null, // 从报告获取，这里简化
      assessmentOverall: null,
      knowledgeGapsCount: knowledgeGaps.totalGaps,
      errorPatternsCount: knowledgeGaps.totalErrorPatterns,
      topSkills,
      topGaps,
      trendStats,
    };

    this.snapshots.push(snapshot);
    // 同日覆盖（只保留最新一个）
    this.snapshots = this.dedupSnapshotsByDate(this.snapshots);
    // 限制数量
    if (this.snapshots.length > MAX_SNAPSHOTS) {
      this.snapshots = this.snapshots.slice(-MAX_SNAPSHOTS);
    }
    this.persistSnapshots();

    this.log.debug('已生成进度快照', { date: snapshot.date, capabilityOverall: snapshot.capabilityOverall });
    return snapshot;
  }

  /** 同日去重（保留最新） */
  private dedupSnapshotsByDate(snapshots: ProgressSnapshot[]): ProgressSnapshot[] {
    const byDate = new Map<string, ProgressSnapshot>();
    for (const s of snapshots) {
      byDate.set(s.date, s); // 后者覆盖前者
    }
    return Array.from(byDate.values()).sort((a, b) => a.timestamp - b.timestamp);
  }

  /** 获取所有快照 */
  getSnapshots(): ProgressSnapshot[] {
    return [...this.snapshots];
  }

  /** 获取最近 N 天快照 */
  getRecentSnapshots(days: number = 30): ProgressSnapshot[] {
    const cutoff = Date.now() - days * 24 * 60 * 60 * 1000;
    return this.snapshots.filter(s => s.timestamp >= cutoff);
  }

  /** 获取最新快照 */
  getLatestSnapshot(): ProgressSnapshot | null {
    return this.snapshots.length > 0 ? this.snapshots[this.snapshots.length - 1] : null;
  }

  // ============ 完整报告 ============

  /**
   * 生成完整进度报告
   */
  generateReport(): ProgressReport {
    const now = Date.now();
    const radar = this.generateRadarChart();
    const curve = this.generateLearningCurve('daily', 30);
    const skillTree = this.generateSkillTree();
    const knowledgeGaps = this.generateKnowledgeGapView();
    const trendStats = this.generateTrendStats();
    const records = this.source?.getLearningRecords?.() ?? [];

    // 生成建议
    const recommendations = this.generateRecommendations(radar, trendStats, knowledgeGaps);
    const topImprovements = this.extractTopImprovements(trendStats);
    const topRisks = this.extractTopRisks(trendStats, radar);

    const report: ProgressReport = {
      generatedAt: now,
      dateRange: curve.dateRange,
      summary: {
        totalLearningRecords: records.length,
        totalSkills: skillTree.totalSkills,
        averageSkillLevel: skillTree.averageLevel,
        capabilityOverall: radar.overallScore,
        knowledgeGapsCount: knowledgeGaps.totalGaps,
        trendStats,
      },
      radarChart: radar,
      learningCurve: curve,
      skillTree,
      knowledgeGaps,
      topImprovements,
      topRisks,
      recommendations,
    };

    // 记录报告索引
    this.reports.push({
      id: `report-${now}`,
      generatedAt: now,
      dateRange: curve.dateRange,
    });
    if (this.reports.length > MAX_REPORTS) {
      this.reports = this.reports.slice(-MAX_REPORTS);
    }
    this.persistReports();

    return report;
  }

  /** 生成建议 */
  private generateRecommendations(radar: RadarChart, trends: TrendStats, gaps: KnowledgeGapView): string[] {
    const recs: string[] = [];

    // 雷达图最低维度
    if (radar.dimensions.length > 0) {
      const sorted = [...radar.dimensions].sort((a, b) => a.current - b.current);
      const lowest = sorted[0];
      if (lowest.current < 50) {
        recs.push(`重点提升「${lowest.name}」维度（当前 ${lowest.current}/100，目标 ${lowest.target}/100）`);
      }
    }

    // 下降趋势
    if (trends.declining > 0) {
      recs.push(`关注 ${trends.declining} 个下降趋势的指标：${trends.decliningMetrics.slice(0, 3).join('、')}`);
    }

    // 知识盲区
    if (gaps.totalGaps > 0) {
      recs.push(`补充知识盲区：${gaps.gaps.slice(0, 3).map(g => g.domain).join('、')}`);
    }

    // 错误模式
    if (gaps.totalErrorPatterns > 0) {
      const topError = gaps.errorPatterns[0];
      recs.push(`减少错误模式「${topError.pattern}」（出现 ${topError.count} 次）`);
    }

    if (recs.length === 0) {
      recs.push('当前进度良好，继续保持学习节奏');
    }

    return recs;
  }

  /** 提取改进点 */
  private extractTopImprovements(trends: TrendStats): string[] {
    return trends.improvingMetrics.slice(0, 5);
  }

  /** 提取风险点 */
  private extractTopRisks(trends: TrendStats, radar: RadarChart): string[] {
    const risks: string[] = [];
    risks.push(...trends.decliningMetrics.slice(0, 3));
    // 雷达图 gap 大的维度
    const bigGaps = radar.dimensions.filter(d => d.gap > 30).map(d => `${d.name}（差距 ${d.gap}）`);
    risks.push(...bigGaps.slice(0, 2));
    return risks;
  }

  /**
   * 生成 Markdown 格式报告
   */
  generateMarkdownReport(): string {
    const report = this.generateReport();
    const lines: string[] = [];

    lines.push('# 学习进度报告');
    lines.push('');
    lines.push(`**生成时间**：${new Date(report.generatedAt).toLocaleString('zh-CN')}`);
    if (report.dateRange.start) {
      lines.push(`**数据范围**：${report.dateRange.start} ~ ${report.dateRange.end ?? '至今'}`);
    }
    lines.push('');

    // 概要
    lines.push('## 概要');
    lines.push('');
    lines.push(`- 学习记录总数：${report.summary.totalLearningRecords}`);
    lines.push(`- 技能总数：${report.summary.totalSkills}`);
    lines.push(`- 平均技能等级：${report.summary.averageSkillLevel}`);
    lines.push(`- 能力综合评分：${report.summary.capabilityOverall}/100`);
    lines.push(`- 知识盲区数：${report.summary.knowledgeGapsCount}`);
    lines.push('');

    // 趋势
    lines.push('## 趋势分析');
    lines.push('');
    const t = report.summary.trendStats;
    lines.push(`- 改进中：${t.improving}/${t.total}`);
    lines.push(`- 下降中：${t.declining}/${t.total}`);
    lines.push(`- 稳定：${t.stable}/${t.total}`);
    if (t.improvingMetrics.length > 0) {
      lines.push(`- 改进指标：${t.improvingMetrics.join('、')}`);
    }
    if (t.decliningMetrics.length > 0) {
      lines.push(`- 下降指标：${t.decliningMetrics.join('、')}`);
    }
    lines.push('');

    // 能力雷达图
    lines.push('## 能力雷达图');
    lines.push('');
    lines.push('| 维度 | 当前 | 目标 | 差距 |');
    lines.push('|------|------|------|------|');
    for (const d of report.radarChart.dimensions) {
      lines.push(`| ${d.name} | ${d.current} | ${d.target} | ${d.gap} |`);
    }
    lines.push(`| **综合** | **${report.radarChart.overallScore}** | **${report.radarChart.overallTarget}** | **${Math.max(0, report.radarChart.overallTarget - report.radarChart.overallScore)}** |`);
    lines.push('');

    // 学习曲线
    lines.push('## 学习曲线（近 30 天）');
    lines.push('');
    if (report.learningCurve.points.length > 0) {
      lines.push('| 日期 | 新增 | 累计 | 已应用 | 正向 | 负向 | 平均置信度 |');
      lines.push('|------|------|------|--------|------|------|------------|');
      for (const p of report.learningCurve.points) {
        lines.push(`| ${p.date} | ${p.newRecords} | ${p.totalRecords} | ${p.appliedRecords} | ${p.positiveOutcomes} | ${p.negativeOutcomes} | ${p.averageConfidence} |`);
      }
    } else {
      lines.push('暂无学习曲线数据');
    }
    lines.push('');

    // 技能树
    lines.push('## 技能树');
    lines.push('');
    if (report.skillTree.roots.length > 0) {
      for (const root of report.skillTree.roots) {
        lines.push(`- **${root.name}**（平均 ${root.level}）`);
        for (const child of root.children) {
          lines.push(`  - ${child.name}：${child.level}（进度 ${child.progress}%）`);
        }
      }
    } else {
      lines.push('暂无技能数据');
    }
    lines.push('');

    // 知识盲区
    lines.push('## 知识盲区');
    lines.push('');
    if (report.knowledgeGaps.gaps.length > 0) {
      for (const g of report.knowledgeGaps.gaps) {
        lines.push(`- **${g.domain}**（来源：${g.source}）：${g.evidence}`);
      }
    } else {
      lines.push('暂无知识盲区');
    }
    lines.push('');

    if (report.knowledgeGaps.errorPatterns.length > 0) {
      lines.push('## 错误模式');
      lines.push('');
      for (const ep of report.knowledgeGaps.errorPatterns) {
        lines.push(`- **${ep.pattern}**：出现 ${ep.count} 次`);
      }
      lines.push('');
    }

    // 建议
    lines.push('## 建议');
    lines.push('');
    for (const rec of report.recommendations) {
      lines.push(`- ${rec}`);
    }
    lines.push('');

    // 风险
    if (report.topRisks.length > 0) {
      lines.push('## 风险');
      lines.push('');
      for (const risk of report.topRisks) {
        lines.push(`- ${risk}`);
      }
      lines.push('');
    }

    return lines.join('\n');
  }

  // ============ 统计 ============

  getStats(): {
    snapshotsCount: number;
    reportsCount: number;
    hasDataSource: boolean;
    latestSnapshot: ProgressSnapshot | null;
  } {
    return {
      snapshotsCount: this.snapshots.length,
      reportsCount: this.reports.length,
      hasDataSource: this.source !== null,
      latestSnapshot: this.getLatestSnapshot(),
    };
  }

  // ============ LLM 工具定义 ============

  getToolDefinitions(): ToolDef[] {
    return [
      {
        name: 'progress_overview',
        description: '获取学习进度总览（快照数/报告数/最新快照/数据源状态）',
        parameters: {},
        readOnly: true,
        execute: async () => JSON.stringify(this.getStats()),
      },
      {
        name: 'progress_learning_curve',
        description: '生成学习曲线数据（按日/周/月聚合学习记录，返回时间序列）',
        parameters: {
          granularity: { type: 'string', description: '聚合粒度：daily|weekly|monthly，默认 daily', required: false },
          days: { type: 'number', description: '回溯天数，默认 30', required: false },
        },
        readOnly: true,
        execute: async (args: { granularity?: 'daily' | 'weekly' | 'monthly'; days?: number }) => {
          const curve = this.generateLearningCurve(args.granularity ?? 'daily', args.days ?? 30);
          return JSON.stringify({
            granularity: curve.granularity,
            totalRecords: curve.totalRecords,
            dateRange: curve.dateRange,
            pointsCount: curve.points.length,
            points: curve.points,
          });
        },
      },
      {
        name: 'progress_radar_chart',
        description: '生成能力雷达图数据（8 维度评分，0-100 归一化，含当前/目标/差距）',
        parameters: {},
        readOnly: true,
        execute: async () => JSON.stringify(this.generateRadarChart()),
      },
      {
        name: 'progress_skill_tree',
        description: '生成技能树数据（按分类分组，含等级和进度）',
        parameters: {},
        readOnly: true,
        execute: async () => JSON.stringify(this.generateSkillTree()),
      },
      {
        name: 'progress_knowledge_gaps',
        description: '查看知识盲区和错误模式（来自学习记录和用户画像）',
        parameters: {},
        readOnly: true,
        execute: async () => JSON.stringify(this.generateKnowledgeGapView()),
      },
      {
        name: 'progress_trends',
        description: '趋势分析（改进/下降/稳定的指标统计）',
        parameters: {},
        readOnly: true,
        execute: async () => JSON.stringify(this.generateTrendStats()),
      },
      {
        name: 'progress_snapshot',
        description: '生成当前进度快照并持久化（建议每日调用一次）',
        parameters: {},
        execute: async () => {
          const snapshot = this.generateSnapshot();
          return JSON.stringify({ success: true, snapshot });
        },
      },
      {
        name: 'progress_report',
        description: '生成完整 Markdown 进度报告（含概要/趋势/雷达图/学习曲线/技能树/知识盲区/建议）',
        parameters: {
          format: { type: 'string', description: '输出格式：markdown|json，默认 markdown', required: false },
        },
        readOnly: true,
        execute: async (args: { format?: 'markdown' | 'json' }) => {
          if (args.format === 'json') {
            return JSON.stringify(this.generateReport());
          }
          return this.generateMarkdownReport();
        },
      },
    ];
  }

  // ============ 持久化 ============

  private loadSnapshots(): void {
    try {
      if (!fs.existsSync(this.snapshotsPath)) return;
      const data = JSON.parse(fs.readFileSync(this.snapshotsPath, 'utf-8')) as { snapshots?: ProgressSnapshot[] };
      this.snapshots = data.snapshots ?? [];
    } catch {
      this.snapshots = [];
    }
  }

  private persistSnapshots(): void {
    atomicWriteJsonSync(this.snapshotsPath, { snapshots: this.snapshots });
  }

  private loadReports(): void {
    try {
      if (!fs.existsSync(this.reportsPath)) return;
      const data = JSON.parse(fs.readFileSync(this.reportsPath, 'utf-8')) as { reports?: Array<{ id: string; generatedAt: number; dateRange: { start: string | null; end: string | null } }> };
      this.reports = data.reports ?? [];
    } catch {
      this.reports = [];
    }
  }

  private persistReports(): void {
    atomicWriteJsonSync(this.reportsPath, { reports: this.reports });
  }
}

/** 获取单例 */
export function getLearningProgressVisualizer(): LearningProgressVisualizer {
  return LearningProgressVisualizer.getInstance();
}
