/**
 * 10 个能力维度的定义 + 指标规格
 *
 * 指标映射表见方案文档 comprehensive-capability-optimization.md
 * 评分公式复用 EvolutionMetrics 已验证公式：
 *   higher-better:  score = min(100, (current/target) × 100)
 *   lower-better:   score = max(0, 100 - (current/target) × 50)
 */

import type { CapabilityDimensionId, CapabilityDimensionSpec, CapabilityMetricSpec } from './types.js';

// ============ 10 个维度元信息 ============

export const CAPABILITY_DIMENSIONS: CapabilityDimensionSpec[] = [
  {
    id: 'thinking',
    name: '思考能力',
    description: '逻辑推理、问题分析与决策，复杂问题拆解与解决方案构建',
    weight: 0.12,
  },
  {
    id: 'execution',
    name: '执行能力',
    description: '任务规划与执行效率，按时完成并达到预期质量',
    weight: 0.12,
  },
  {
    id: 'computer_ops',
    name: '电脑操作能力',
    description: '操作系统与应用程序控制精准度，多任务并行处理',
    weight: 0.10,
  },
  {
    id: 'code',
    name: '代码能力',
    description: '代码生成、优化、调试与重构，多语言多框架支持',
    weight: 0.10,
  },
  {
    id: 'learning',
    name: '学习能力',
    description: '新知识快速获取、整合与应用，持续知识更新',
    weight: 0.10,
  },
  {
    id: 'memory',
    name: '记忆能力',
    description: '信息存储、检索与关联，高效知识管理',
    weight: 0.10,
  },
  {
    id: 'self_iteration',
    name: '自我迭代能力',
    description: '自动化能力评估与改进，系统功能持续优化',
    weight: 0.09,
  },
  {
    id: 'self_repair',
    name: '自我修复能力',
    description: '错误检测、诊断与自动恢复，系统稳定性与可靠性',
    weight: 0.09,
  },
  {
    id: 'inference',
    name: '推理能力',
    description: '因果关系分析、预测推理与复杂逻辑推演',
    weight: 0.09,
  },
  {
    id: 'cross_platform',
    name: '三端互通能力',
    description: 'PC端、移动端与云端系统的无缝衔接与数据同步',
    weight: 0.09,
  },
];

// 权重归一化校验（构造时执行）
const _totalWeight = CAPABILITY_DIMENSIONS.reduce((s, d) => s + d.weight, 0);
if (Math.abs(_totalWeight - 1.0) > 0.001) {
  // 不抛错以避免运行时崩溃，但记录警告
  console.warn(`[CapabilityAssessment] 维度权重总和不为 1.0: ${_totalWeight}`);
}

// ============ 维度名查找表 ============

export const DIMENSION_NAME: Record<CapabilityDimensionId, string> = Object.fromEntries(
  CAPABILITY_DIMENSIONS.map(d => [d.id, d.name]),
) as Record<CapabilityDimensionId, string>;

export const DIMENSION_WEIGHT: Record<CapabilityDimensionId, number> = Object.fromEntries(
  CAPABILITY_DIMENSIONS.map(d => [d.id, d.weight]),
) as Record<CapabilityDimensionId, number>;

// ============ 所有指标规格 ============

export const CAPABILITY_METRICS: CapabilityMetricSpec[] = [
  // ===== D1 思考能力 =====
  {
    id: 'reasoning_depth',
    dimension: 'thinking',
    name: '推理深度',
    description: '复杂任务中产生分解式推理 trace 的比例',
    unit: '比率',
    target: 0.85,
    weight: 0.34,
    lowerIsBetter: false,
    source: 'suite',
  },
  {
    id: 'hypothesis_falsifiability',
    dimension: 'thinking',
    name: '假设可证伪性',
    description: '生成假设中含可证伪条件的比例',
    unit: '比率',
    target: 0.80,
    weight: 0.33,
    lowerIsBetter: false,
    source: 'suite',
  },
  {
    id: 'solution_validity',
    dimension: 'thinking',
    name: '解法有效性',
    description: '基准逻辑题正确率',
    unit: '比率',
    target: 0.90,
    weight: 0.33,
    lowerIsBetter: false,
    source: 'suite',
  },

  // ===== D2 执行能力 =====
  {
    id: 'task_completion_rate',
    dimension: 'execution',
    name: '任务完成率',
    description: '成功完成任务的比例',
    unit: '%',
    target: 90,
    weight: 0.30,
    lowerIsBetter: false,
    source: 'evolution_metrics',
    adapterKey: 'task_completion_rate',
  },
  {
    id: 'on_time_completion_rate',
    dimension: 'execution',
    name: '准时完成率',
    description: '有 deadline 的步骤准时完成的比例',
    unit: '比率',
    target: 0.85,
    weight: 0.25,
    lowerIsBetter: false,
    source: 'new',
  },
  {
    id: 'plan_quality',
    dimension: 'execution',
    name: '规划质量',
    description: '任务规划步骤的合理性和完整性',
    unit: '%',
    target: 85,
    weight: 0.20,
    lowerIsBetter: false,
    source: 'evolution_metrics',
    adapterKey: 'plan_quality',
  },
  {
    id: 'quality_gate_pass_rate',
    dimension: 'execution',
    name: '质量门通过率',
    description: 'Execute→Reflect 质量门通过的比例',
    unit: '比率',
    target: 0.90,
    weight: 0.25,
    lowerIsBetter: false,
    source: 'new',
  },

  // ===== D3 电脑操作能力 =====
  {
    id: 'op_success_rate',
    dimension: 'computer_ops',
    name: '操作成功率',
    description: '桌面操作成功执行的比例',
    unit: '比率',
    target: 0.92,
    weight: 0.40,
    lowerIsBetter: false,
    source: 'suite',
  },
  {
    id: 'focus_recovery_rate',
    dimension: 'computer_ops',
    name: '焦点恢复率',
    description: '失焦后成功恢复并完成操作的比例',
    unit: '比率',
    target: 0.85,
    weight: 0.35,
    lowerIsBetter: false,
    source: 'suite',
  },
  {
    id: 'parallel_throughput',
    dimension: 'computer_ops',
    name: '并行吞吐量',
    description: '批处理独立操作每秒完成数',
    unit: 'ops/sec',
    target: 3,
    weight: 0.25,
    lowerIsBetter: false,
    source: 'suite',
  },

  // ===== D4 代码能力 =====
  {
    id: 'code_correctness',
    dimension: 'code',
    name: '代码正确性',
    description: '生成代码通过隐藏测试的比例',
    unit: '比率',
    target: 0.85,
    weight: 0.40,
    lowerIsBetter: false,
    source: 'suite',
  },
  {
    id: 'refactor_safety',
    dimension: 'code',
    name: '重构安全性',
    description: '重构后行为保持（测试仍通过）的比例',
    unit: '比率',
    target: 0.95,
    weight: 0.30,
    lowerIsBetter: false,
    source: 'suite',
  },
  {
    id: 'debug_loop_success',
    dimension: 'code',
    name: '调试闭环成功率',
    description: '通过 debug→fix→retest 闭环修复 bug 的比例',
    unit: '比率',
    target: 0.80,
    weight: 0.30,
    lowerIsBetter: false,
    source: 'suite',
  },

  // ===== D5 学习能力 =====
  {
    id: 'learning_velocity',
    dimension: 'learning',
    name: '学习速度',
    description: '每日新增有效经验数',
    unit: '条/天',
    target: 5,
    weight: 0.30,
    lowerIsBetter: false,
    source: 'evolution_metrics',
    adapterKey: 'learning_velocity',
  },
  {
    id: 'knowledge_retention',
    dimension: 'learning',
    name: '知识保持率',
    description: '时间衰减后知识召回准确率',
    unit: '比率',
    target: 0.80,
    weight: 0.40,
    lowerIsBetter: false,
    source: 'learning_eval',
    adapterKey: 'retention',
  },
  {
    id: 'gap_probing_rate',
    dimension: 'learning',
    name: '盲区探测率',
    description: '任务后主动探测知识盲区的比例',
    unit: '比率',
    target: 0.70,
    weight: 0.30,
    lowerIsBetter: false,
    source: 'new',
  },

  // ===== D6 记忆能力 =====
  {
    id: 'recall_precision_at_5',
    dimension: 'memory',
    name: '召回精确率@5',
    description: '前 5 条召回结果中相关的比例',
    unit: '比率',
    target: 0.80,
    weight: 0.40,
    lowerIsBetter: false,
    source: 'suite',
  },
  {
    id: 'recall_latency_ms',
    dimension: 'memory',
    name: '召回延迟',
    description: '记忆检索平均延迟（越低越好）',
    unit: 'ms',
    target: 50,
    weight: 0.30,
    lowerIsBetter: true,
    source: 'new',
  },
  {
    id: 'association_coverage',
    dimension: 'memory',
    name: '关联覆盖率',
    description: '受益于图谱多跳关联的查询比例',
    unit: '比率',
    target: 0.70,
    weight: 0.30,
    lowerIsBetter: false,
    source: 'suite',
  },

  // ===== D7 自我迭代能力 =====
  {
    id: 'improvement_velocity',
    dimension: 'self_iteration',
    name: '改进速度',
    description: '每周成功应用的进化动作数',
    unit: '条/周',
    target: 5,
    weight: 0.35,
    lowerIsBetter: false,
    source: 'new',
  },
  {
    id: 'regression_rate',
    dimension: 'self_iteration',
    name: '回归率',
    description: '触发回滚的进化动作比例（越低越好）',
    unit: '比率',
    target: 0.10,
    weight: 0.30,
    lowerIsBetter: true,
    source: 'new',
  },
  {
    id: 'evolution_score',
    dimension: 'self_iteration',
    name: '进化评分',
    description: 'EvolutionMetrics 综合评分',
    unit: '分',
    target: 75,
    weight: 0.35,
    lowerIsBetter: false,
    source: 'evolution_metrics',
    adapterKey: '__overall__',
  },

  // ===== D8 自我修复能力 =====
  {
    id: 'mttr_ms',
    dimension: 'self_repair',
    name: '平均修复时间',
    description: '从异常到恢复的平均时间（越低越好）',
    unit: 'ms',
    target: 5000,
    weight: 0.30,
    lowerIsBetter: true,
    source: 'suite',
  },
  {
    id: 'repair_success_rate',
    dimension: 'self_repair',
    name: '修复成功率',
    description: '修复操作成功恢复的比例',
    unit: '比率',
    target: 0.85,
    weight: 0.35,
    lowerIsBetter: false,
    source: 'suite',
  },
  {
    id: 'corruption_recovery_rate',
    dimension: 'self_repair',
    name: '损坏恢复率',
    description: '文件损坏后成功备份+重建+不丢数据的比例',
    unit: '比率',
    target: 0.95,
    weight: 0.35,
    lowerIsBetter: false,
    source: 'suite',
  },

  // ===== D9 推理能力 =====
  {
    id: 'causal_accuracy',
    dimension: 'inference',
    name: '因果准确率',
    description: 'WorldModel 反事实推理正确率',
    unit: '比率',
    target: 0.80,
    weight: 0.34,
    lowerIsBetter: false,
    source: 'suite',
  },
  {
    id: 'prediction_accuracy',
    dimension: 'inference',
    name: '预测准确率',
    description: 'WorldModel predict() 下一状态预测正确率',
    unit: '比率',
    target: 0.75,
    weight: 0.33,
    lowerIsBetter: false,
    source: 'suite',
  },
  {
    id: 'counterfactual_validity',
    dimension: 'inference',
    name: '反事实有效性',
    description: '反事实推理结论与基准一致的比例',
    unit: '比率',
    target: 0.80,
    weight: 0.33,
    lowerIsBetter: false,
    source: 'suite',
  },

  // ===== D10 三端互通能力 =====
  {
    id: 'sync_consistency',
    dimension: 'cross_platform',
    name: '同步一致性',
    description: '同步成功且无冲突的比例',
    unit: '比率',
    target: 0.99,
    weight: 0.30,
    lowerIsBetter: false,
    source: 'suite',
  },
  {
    id: 'sync_latency_ms',
    dimension: 'cross_platform',
    name: '同步延迟',
    description: '云端同步平均延迟（越低越好）',
    unit: 'ms',
    target: 2000,
    weight: 0.25,
    lowerIsBetter: true,
    source: 'suite',
  },
  {
    id: 'pwa_installability',
    dimension: 'cross_platform',
    name: 'PWA 可安装性',
    description: 'manifest 字段完整性 + SW 注册',
    unit: '比率',
    target: 1.0,
    weight: 0.25,
    lowerIsBetter: false,
    source: 'suite',
  },
  {
    id: 'conflict_resolution_rate',
    dimension: 'cross_platform',
    name: '冲突解决率',
    description: '检测到的同步冲突被正确解决的比例',
    unit: '比率',
    target: 0.95,
    weight: 0.20,
    lowerIsBetter: false,
    source: 'suite',
  },
];

// ============ 查找辅助 ============

/** 按维度分组指标 */
export function getMetricsByDimension(dim: CapabilityDimensionId): CapabilityMetricSpec[] {
  return CAPABILITY_METRICS.filter(m => m.dimension === dim);
}

/** 按 id 查找指标 */
export function getMetricSpec(id: string): CapabilityMetricSpec | undefined {
  return CAPABILITY_METRICS.find(m => m.id === id);
}

/** 校验每个维度的指标权重和为 1.0（构造时执行，仅警告不抛错） */
function _validateWeights(): void {
  const dims = new Set(CAPABILITY_METRICS.map(m => m.dimension));
  for (const dim of dims) {
    const metrics = getMetricsByDimension(dim);
    const total = metrics.reduce((s, m) => s + m.weight, 0);
    if (Math.abs(total - 1.0) > 0.001) {
      console.warn(`[CapabilityAssessment] 维度 ${dim} 指标权重和不为 1.0: ${total.toFixed(3)}`);
    }
  }
}
_validateWeights();
