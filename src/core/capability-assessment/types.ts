/**
 * 统一能力评估框架 - 类型定义
 *
 * 将段先生 v19.0 现有的 6 个评估系统（EvolutionMetrics / EvolutionAssessmentSystem /
 * SelfAssessment / LearningEvalSystem / CapabilityScoreMatrix / Benchmark）聚合到
 * 用户要求的 10 个能力维度上，形成可量化、可对比、可证明改进的统一框架。
 *
 * 设计原则：
 * - 非破坏性：现有 6 系统继续运行，本框架只读拉取
 * - 优雅降级：单个适配器失败只跳过该指标，不阻断整体评估
 * - 评分公式与 EvolutionMetrics 一致（已验证），保证可比性
 * - baseline vs current 双快照对比，证明改进效果
 */

// ============ 维度定义 ============

/** 10 个能力维度标识 */
export type CapabilityDimensionId =
  | 'thinking'         // D1 思考能力
  | 'execution'        // D2 执行能力
  | 'computer_ops'     // D3 电脑操作能力
  | 'code'             // D4 代码能力
  | 'learning'         // D5 学习能力
  | 'memory'           // D6 记忆能力
  | 'self_iteration'   // D7 自我迭代能力
  | 'self_repair'      // D8 自我修复能力
  | 'inference'        // D9 推理能力
  | 'cross_platform';  // D10 三端互通能力

/** 维度的元信息 */
export interface CapabilityDimensionSpec {
  id: CapabilityDimensionId;
  name: string;          // 中文名
  description: string;
  weight: number;        // 该维度在总分中的权重 0-1（默认每维度 0.10）
}

// ============ 指标定义 ============

/** 指标数据来源 — 哪个现有系统已测量该指标 */
export type MetricSource =
  | 'evolution_metrics'     // EvolutionMetrics 已有
  | 'learning_eval'         // LearningEvalSystem 已有
  | 'memory_orchestrator'   // MemoryOrchestrator 已测延迟
  | 'new'                   // 新增测量（由测试套件或代码埋点产生）
  | 'suite';                 // 由 *.suite.ts 基准测试产出

/** 单个指标的规格定义（静态） */
export interface CapabilityMetricSpec {
  id: string;                  // 全局唯一，如 'reasoning_depth'
  dimension: CapabilityDimensionId;
  name: string;                // 显示名
  description: string;
  unit: string;                 // '%' | 'ms' | '条/天' | ...
  target: number;               // 达标目标值
  weight: number;               // 维度内权重 0-1
  lowerIsBetter: boolean;       // true = 越低越好（如延迟、错误率）
  source: MetricSource;         // 数据来源
  /** 从现有系统拉取的适配器 key（source != 'new'/'suite' 时必填） */
  adapterKey?: string;
}

/** 指标测量结果（运行时） */
export interface CapabilityMetricResult {
  spec: CapabilityMetricSpec;
  value: number;                // 测得的原始值
  score: number;                // 0-100 归一化评分
  source: string;               // 实际来源描述
  measuredAt: number;           // 时间戳
  /** 测量失败时不阻断整体，记录错误并跳过 */
  error?: string;
}

/** 维度评估结果 */
export interface CapabilityDimensionResult {
  dimension: CapabilityDimensionId;
  name: string;
  score: number;                // 0-100 维度内加权平均
  weight: number;
  metrics: CapabilityMetricResult[];
}

// ============ 报告 ============

/** 一次完整评估的产物 */
export interface CapabilityReport {
  timestamp: number;
  label: 'baseline' | 'current' | 'manual';
  overallScore: number;          // 0-100 总分
  dimensions: CapabilityDimensionResult[];
  /** baseline 对比（仅 current 报告有） */
  baseline?: CapabilityReport | null;
  /** 与 baseline 对比的正向变化 Top N */
  topImprovements: Array<{ metricId: string; metricName: string; delta: number }>;
  /** 与 baseline 对比的负向变化 Top N */
  topRegressions: Array<{ metricId: string; metricName: string; delta: number }>;
  recommendations: string[];
  /** 评估过程中跳过的指标（适配器失败等） */
  skipped: Array<{ metricId: string; reason: string }>;
}

/** 持久化的指标快照（用于趋势对比） */
export interface CapabilityMetricSnapshot {
  timestamp: number;
  label: 'baseline' | 'current' | 'manual';
  overallScore: number;
  dimensionScores: Partial<Record<CapabilityDimensionId, number>>;
  metricValues: Record<string, number>;
}

// ============ 测试套件 ============

/** 单个基准测试用例 */
export interface CapabilityTestCase {
  id: string;
  name: string;
  dimension: CapabilityDimensionId;
  difficulty: 'easy' | 'medium' | 'hard';
  /** 评分函数：传入执行结果，返回 0-1 得分 */
  score: (result: unknown) => number;
}

/** 测试套件接口 — 每个维度一个 */
export interface CapabilityTestSuite {
  dimension: CapabilityDimensionId;
  name: string;
  /** 运行所有测试用例并返回每个用例的得分（0-1）+ 原始结果 */
  run(): Promise<Array<{ caseId: string; score: number; raw?: unknown }>>;
}

// ============ 适配器接口 ============

/** 从现有评估系统拉取指标值的只读适配器 */
export interface MetricAdapter {
  name: string;
  /** 拉取指定 metricId 的当前值；失败应抛错或返回 null */
  getMetricValue(metricId: string): Promise<number | null>;
  /** 该适配器能提供的 metricId 列表（用于校验） */
  availableMetrics(): string[];
}
