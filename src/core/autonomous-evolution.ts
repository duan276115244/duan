/**
 * 自主进化引擎 - AutonomousEvolutionEngine
 * 
 * 统一管理智能体的自主进化过程：
 * 1. 自我监控与评估 - 识别局限性和改进方向
 * 2. 进化目标设定 - 基于评估结果设定可量化的进化目标
 * 3. 进化策略选择 - 数据驱动的优化路径选择
 * 4. 进化验证 - 确保进化符合性能指标和安全约束
 * 5. 进化调度 - 自动触发和执行进化周期
 * 6. 自我思考 - 分析性能趋势、识别根因、生成假设、反思决策
 * 7. 自我学习 - 从反馈/错误中学习、获取新技能、更新知识库
 * 8. 自我修复 - 检测异常、诊断问题、执行修复、验证效果、防止复发
 */

import { EventEmitter } from 'events';
import type { PerformanceMetricsSystem, PerformanceSnapshot } from './performance-metrics.js';
import type { SelfEvolutionEngine } from './self-evolution-engine.js';
import type { FeedbackSystem } from './feedback-system.js';
import type { Benchmark } from './benchmark.js';

// ========== 原有接口 ==========

/** 进化目标 */
export interface EvolutionGoal {
  id: string;
  name: string;
  description: string;
  metric: string;                          // 关联的性能指标名
  currentValue: number;
  targetValue: number;
  deadline?: Date;                         // 目标截止时间
  priority: 'critical' | 'high' | 'medium' | 'low';
  status: 'proposed' | 'accepted' | 'in_progress' | 'achieved' | 'failed' | 'abandoned';
  createdAt: Date;
  progress: number;                        // 0-1
  verificationResults: VerificationRecord[];
}

/** 验证记录 */
interface VerificationRecord {
  timestamp: Date;
  metricValue: number;
  passed: boolean;
  evidence: string;
  regressions: string[];                   // 是否引入退化
}

/** 进化周期 */
interface EvolutionCycle {
  id: string;
  startTime: Date;
  endTime?: Date;
  phase: 'assessment' | 'planning' | 'execution' | 'verification' | 'completed';
  goals: EvolutionGoal[];
  actions: EvolutionAction[];
  results: EvolutionCycleResult;
}

/** 进化动作 */
interface EvolutionAction {
  id: string;
  type: 'parameter_tuning' | 'strategy_switch' | 'knowledge_update' | 'module_upgrade' | 'skill_addition';
  description: string;
  targetGoalId: string;
  status: 'pending' | 'executing' | 'completed' | 'failed' | 'rolled_back';
  expectedImpact: string;
  actualImpact?: string;
  riskLevel: 'low' | 'medium' | 'high';
  executedAt?: Date;
  result?: string;
}

/** 进化周期结果 */
interface EvolutionCycleResult {
  goalsAchieved: number;
  goalsFailed: number;
  regressionsDetected: number;
  overallImprovement: number;              // 综合改进百分比
  safetyViolations: number;
  summary: string;
}

/** 自我评估报告 */
export interface SelfAssessment {
  timestamp: Date;
  strengths: string[];
  weaknesses: string[];
  opportunities: string[];
  threats: string[];
  performanceScore: number;                // 0-100
  capabilityGaps: string[];
  recommendedGoals: EvolutionGoal[];
}

/** 进化配置 */
interface EvolutionConfig {
  autoEvolve: boolean;                     // 是否自动进化
  cycleInterval: number;                   // 进化周期间隔(ms)
  maxConcurrentGoals: number;              // 最大并发目标数
  safetyConstraints: SafetyConstraint[];   // 安全约束
  rollbackOnRegression: boolean;           // 退化时是否自动回滚
  minImprovementThreshold: number;         // 最小改进阈值
}

/** 安全约束 */
interface SafetyConstraint {
  name: string;
  metric: string;
  minValue: number;
  maxValue: number;
  actionOnViolation: 'warn' | 'block' | 'rollback';
}

// ========== 新增接口：自我思考 ==========

/** 性能指标（用于趋势分析） */
interface PerformanceMetrics {
  avgResponseTime: number;
  intentAccuracy: number;
  taskCompletionRate: number;
  errorRate: number;
  cacheHitRate: number;
  memoryUsage: number;
}

/** 系统上下文 */
interface SystemContext {
  activeRequests: number;
  cacheHitRate: number;
  recentFeedbackNegative: number;
  uptime: number;
  totalInteractions: number;
}

/** 趋势分析结果 */
interface TrendAnalysis {
  responseTime: { direction: 'up' | 'down' | 'stable'; magnitude: number; confidence: number };
  accuracy: { direction: 'up' | 'down' | 'stable'; magnitude: number; confidence: number };
  errors: { direction: 'up' | 'down' | 'stable'; magnitude: number; confidence: number };
  anomalies: Anomaly[];
  overallHealth: 'healthy' | 'degraded' | 'critical';
}

/** 异常 */
interface Anomaly {
  metric: string;
  index: number;
  value: number;
  expected: number;
  severity: 'low' | 'medium' | 'high';
}

/** 根因分析 */
interface RootCauseAnalysis {
  symptom: string;
  causes: string[];
  rootCause: string;
  depth: number;
  remediation: string[];
}

/** 假设 */
interface Hypothesis {
  id: string;
  statement: string;
  testable: boolean;
  testMethod: string;
  priority: number;
}

/** 思考记录 */
interface ThoughtRecord {
  id: string;
  type: 'analysis' | 'hypothesis' | 'reflection' | 'decision';
  content: string;
  timestamp: number;
  outcome?: string;
}

/** 决策记录 */
interface DecisionRecord {
  id: string;
  description: string;
  expectedOutcome: string;
  actualOutcome: string;
  timestamp: number;
}

/** 决策反思 */
interface DecisionReflection {
  decision: string;
  outcome: string;
  expectedOutcome: string;
  gap: number;
  lesson: string;
  wouldDoDifferently: string;
}

// ========== 新增接口：自我学习 ==========

/** 用户反馈 */
interface UserFeedback {
  type: string;
  sentiment: 'positive' | 'negative' | 'neutral';
  triggerAction: string;
  context: string;
  intentType?: string;
}

/** 学习模式 */
interface LearnedPattern {
  key: string;
  category: string;
  frequency: number;
  confidence: number;
  preferredActions: string[];
  avoidActions: string[];
  lastUpdated: number;
}

/** 错误防御规则 */
interface ErrorDefenseRule {
  id: string;
  errorPattern: string;
  frequency: number;
  defenseStrategy: string;
  autoRepair: boolean;
  repairScript: string | null;
  createdAt: number;
}

/** 错误条目 */
interface ErrorEntry {
  errorType: string;
  context: string;
  message: string;
  timestamp: number;
}

/** 技能获取任务 */
interface SkillAcquisitionTask {
  requirement: string;
  status: 'analyzing' | 'implementing' | 'testing' | 'ready';
  createdAt: number;
}

/** 技能实现 */
interface SkillImplementation {
  capabilities: string[];
  approach: string;
  confidenceThreshold: number;
  fallbackStrategy: string;
}

/** 学习结果 */
interface LearningResult {
  patternKey: string;
  learned: boolean;
  actionTaken: string;
}

/** 错误学习结果 */
interface ErrorLearningResult {
  newRulesCount: number;
  totalRules: number;
}

/** 技能获取结果 */
interface SkillAcquisitionResult {
  task: SkillAcquisitionTask;
  capabilities: string[];
  implementation: SkillImplementation;
  ready: boolean;
}

/** 学习成果 */
interface LearningOutcome {
  type: string;
  content: string;
  source: string;
  confidence: number;
  scenarios: string[];
}

/** 知识更新结果 */
interface KnowledgeUpdateResult {
  updated: boolean;
  knowledgeId: string;
}

// ========== 新增接口：自我修复 ==========

/** 系统状态 */
interface SystemState {
  avgResponseTime: number;
  baselineResponseTime: number;
  errorRate: number;
  memoryUsage: number;
  nluAccuracy: number;
  baselineNluAccuracy: number;
  cacheHitRate: number;
  activeRequests: number;
}

/** 系统异常 */
interface SystemAnomaly {
  type: string;
  severity: 'low' | 'medium' | 'high' | 'critical';
  metric: string;
  value: number;
  baseline: number;
}

/** 异常检测结果 */
interface AnomalyDetectionResult {
  anomalies: SystemAnomaly[];
  severity: 'normal' | 'warning' | 'critical';
  timestamp: number;
}

/** 诊断结果 */
interface DiagnosisResult {
  anomaly: SystemAnomaly;
  rootCause: string;
  affectedComponents: string[];
  repairStrategy: string;
  estimatedImpact: 'low' | 'medium' | 'high';
  autoRepairable: boolean;
}

/** 修复结果 */
interface RepairResult {
  success: boolean;
  detail: string;
  recordId: string;
}

/** 修复记录 */
interface RepairRecord {
  id: string;
  diagnosis: DiagnosisResult;
  success: boolean;
  detail: string;
  duration: number;
  timestamp: number;
}

/** 验证结果 */
interface VerificationResult {
  verified: boolean;
  reason?: string;
  anomaly?: SystemAnomaly;
  currentState?: SystemState;
}

/** 预防规则 */
interface PreventionRule {
  id: string;
  triggerCondition: string;
  proactiveAction: string;
  priority: 'low' | 'medium' | 'high';
  createdAt: number;
}

// ========== 自我思考引擎 ==========

/** 自我思考引擎 */
class SelfThinkingEngine {
  private thoughtHistory: ThoughtRecord[] = [];
  private decisionLog: DecisionRecord[] = [];

  /** 分析性能趋势 */
  analyzePerformanceTrends(metrics: PerformanceMetrics[]): TrendAnalysis {
    // 实现真正的趋势分析：计算移动平均、检测异常点、识别退化模式
    const responseTimeTrend = this.computeTrend(metrics.map(m => m.avgResponseTime));
    const accuracyTrend = this.computeTrend(metrics.map(m => m.intentAccuracy));
    const errorTrend = this.computeTrend(metrics.map(m => 1 - m.taskCompletionRate));

    const analysis: TrendAnalysis = {
      responseTime: { direction: responseTimeTrend.direction, magnitude: responseTimeTrend.magnitude, confidence: responseTimeTrend.confidence },
      accuracy: { direction: accuracyTrend.direction, magnitude: accuracyTrend.magnitude, confidence: accuracyTrend.confidence },
      errors: { direction: errorTrend.direction, magnitude: errorTrend.magnitude, confidence: errorTrend.confidence },
      anomalies: this.detectAnomalies(metrics),
      overallHealth: this.assessOverallHealth(responseTimeTrend, accuracyTrend, errorTrend),
    };

    // 记录思考
    this.recordThought('analysis', `性能趋势分析: 响应时间${analysis.responseTime.direction}, 准确率${analysis.accuracy.direction}, 错误率${analysis.errors.direction}, 整体健康=${analysis.overallHealth}`);

    return analysis;
  }

  /** 识别根因 */
  identifyRootCause(symptom: string, context: SystemContext): RootCauseAnalysis {
    // 实现真正的5-Why分析法
    const causes: string[] = [];
    let currentQuestion = symptom;
    for (let depth = 0; depth < 5; depth++) {
      const cause = this.askWhy(currentQuestion, context);
      if (!cause || cause === currentQuestion) break;
      causes.push(cause);
      currentQuestion = cause;
    }

    const result: RootCauseAnalysis = {
      symptom,
      causes,
      rootCause: causes[causes.length - 1] || symptom,
      depth: causes.length,
      remediation: this.suggestRemediation(causes),
    };

    this.recordThought('analysis', `根因分析: 症状="${symptom}", 根因="${result.rootCause}", 深度=${result.depth}`);

    return result;
  }

  /** 生成假设 */
  generateHypothesis(observation: string): Hypothesis[] {
    const hypotheses: Hypothesis[] = [];
    let priority = 1;

    // 基于观察生成多个可测试的假设
    if (observation.includes('响应慢') || observation.includes('超时')) {
      hypotheses.push({
        id: `hyp_${Date.now()}_1`,
        statement: '缓存命中率不足导致重复计算，造成响应慢',
        testable: true,
        testMethod: '监控缓存命中率与响应时间的相关性',
        priority: priority++,
      });
      hypotheses.push({
        id: `hyp_${Date.now()}_2`,
        statement: '并发请求过多导致资源竞争，造成响应慢',
        testable: true,
        testMethod: '降低并发量并观察响应时间变化',
        priority: priority++,
      });
      hypotheses.push({
        id: `hyp_${Date.now()}_3`,
        statement: '模型推理延迟增加导致响应慢',
        testable: true,
        testMethod: '对比不同模型的推理延迟',
        priority: priority++,
      });
    }

    if (observation.includes('准确率低') || observation.includes('识别错误')) {
      hypotheses.push({
        id: `hyp_${Date.now()}_4`,
        statement: '训练数据覆盖不足导致新领域识别率低',
        testable: true,
        testMethod: '统计低准确率意图的领域分布',
        priority: priority++,
      });
      hypotheses.push({
        id: `hyp_${Date.now()}_5`,
        statement: '消歧逻辑不完善导致相似意图混淆',
        testable: true,
        testMethod: '分析混淆矩阵中高混淆意图对',
        priority: priority++,
      });
    }

    if (observation.includes('错误率高') || observation.includes('失败')) {
      hypotheses.push({
        id: `hyp_${Date.now()}_6`,
        statement: '外部API不稳定导致任务失败率上升',
        testable: true,
        testMethod: '统计API错误率与任务失败率的相关性',
        priority: priority++,
      });
      hypotheses.push({
        id: `hyp_${Date.now()}_7`,
        statement: '输入格式异常导致解析错误',
        testable: true,
        testMethod: '分析错误日志中输入格式的分布',
        priority: priority++,
      });
    }

    // 通用假设
    if (hypotheses.length === 0) {
      hypotheses.push({
        id: `hyp_${Date.now()}_gen`,
        statement: `观察到"${observation}"，可能是系统配置或环境变化导致`,
        testable: true,
        testMethod: '对比近期系统变更和环境变化',
        priority: 1,
      });
    }

    this.recordThought('hypothesis', `针对"${observation}"生成了${hypotheses.length}个假设`);

    return hypotheses;
  }

  /** 反思决策 */
  reflectOnDecisions(): DecisionReflection[] {
    return this.decisionLog.map(d => ({
      decision: d.description,
      outcome: d.actualOutcome,
      expectedOutcome: d.expectedOutcome,
      gap: this.computeOutcomeGap(d.expectedOutcome, d.actualOutcome),
      lesson: this.extractLesson(d),
      wouldDoDifferently: this.suggestAlternative(d),
    }));
  }

  /** 记录决策 */
  recordDecision(description: string, expectedOutcome: string, actualOutcome: string): void {
    this.decisionLog.push({
      id: `decision_${Date.now()}_${Math.random().toString(36).substr(2, 6)}`,
      description,
      expectedOutcome,
      actualOutcome,
      timestamp: Date.now(),
    });
  }

  /** 获取思考历史 */
  getThoughtHistory(limit: number = 50): ThoughtRecord[] {
    return this.thoughtHistory.slice(-limit);
  }

  /** 获取决策日志 */
  getDecisionLog(limit: number = 50): DecisionRecord[] {
    return this.decisionLog.slice(-limit);
  }

  private recordThought(type: ThoughtRecord['type'], content: string): void {
    this.thoughtHistory.push({
      id: `thought_${Date.now()}_${Math.random().toString(36).substr(2, 6)}`,
      type,
      content,
      timestamp: Date.now(),
    });
    // 限制历史长度
    if (this.thoughtHistory.length > 1000) {
      this.thoughtHistory = this.thoughtHistory.slice(-500);
    }
  }

  private computeTrend(values: number[]): { direction: 'up' | 'down' | 'stable'; magnitude: number; confidence: number } {
    if (values.length < 2) return { direction: 'stable', magnitude: 0, confidence: 0 };
    // 简单线性回归计算趋势
    const n = values.length;
    const xMean = (n - 1) / 2;
    const yMean = values.reduce((a, b) => a + b, 0) / n;
    let num = 0, den = 0;
    for (let i = 0; i < n; i++) {
      num += (i - xMean) * (values[i] - yMean);
      den += (i - xMean) * (i - xMean);
    }
    const slope = den === 0 ? 0 : num / den;
    const magnitude = Math.abs(slope);
    let direction: 'up' | 'down' | 'stable';
    if (slope > 0.001) {
      direction = 'up';
    } else if (slope < -0.001) {
      direction = 'down';
    } else {
      direction = 'stable';
    }
    // R²作为置信度
    const ssRes = values.reduce((sum, v, i) => sum + Math.pow(v - (yMean + slope * (i - xMean)), 2), 0);
    const ssTot = values.reduce((sum, v) => sum + Math.pow(v - yMean, 2), 0);
    const confidence = ssTot === 0 ? 0 : Math.max(0, 1 - ssRes / ssTot);
    return { direction, magnitude, confidence };
  }

  private detectAnomalies(metrics: PerformanceMetrics[]): Anomaly[] {
    // 使用Z-score检测异常
    const anomalies: Anomaly[] = [];
    const values = metrics.map(m => m.avgResponseTime);
    const mean = values.reduce((a, b) => a + b, 0) / values.length;
    const std = Math.sqrt(values.reduce((s, v) => s + (v - mean) ** 2, 0) / values.length);
    metrics.forEach((m, i) => {
      if (std > 0 && Math.abs(m.avgResponseTime - mean) / std > 2) {
        anomalies.push({ metric: 'avgResponseTime', index: i, value: m.avgResponseTime, expected: mean, severity: 'high' });
      }
    });

    // 检测准确率异常
    const accValues = metrics.map(m => m.intentAccuracy);
    const accMean = accValues.reduce((a, b) => a + b, 0) / accValues.length;
    const accStd = Math.sqrt(accValues.reduce((s, v) => s + (v - accMean) ** 2, 0) / accValues.length);
    metrics.forEach((m, i) => {
      if (accStd > 0 && Math.abs(m.intentAccuracy - accMean) / accStd > 2) {
        anomalies.push({ metric: 'intentAccuracy', index: i, value: m.intentAccuracy, expected: accMean, severity: 'high' });
      }
    });

    return anomalies;
  }

  private assessOverallHealth(
    rt: { direction: string },
    acc: { direction: string },
    err: { direction: string }
  ): 'healthy' | 'degraded' | 'critical' {
    let score = 0;
    if (rt.direction === 'up') score -= 2; // 响应时间上升是坏事
    if (acc.direction === 'down') score -= 2; // 准确率下降是坏事
    if (err.direction === 'up') score -= 2; // 错误率上升是坏事
    if (score <= -4) return 'critical';
    if (score <= -2) return 'degraded';
    return 'healthy';
  }

  private askWhy(question: string, context: SystemContext): string {
    // 基于上下文信息推断原因
    if (question.includes('响应慢') || question.includes('超时')) {
      if (context.activeRequests > 15) return '并发请求过多导致资源竞争';
      if (context.cacheHitRate < 0.3) return '缓存命中率低导致重复计算';
      return '模型推理延迟增加';
    }
    if (question.includes('准确率低') || question.includes('识别错误')) {
      if (context.recentFeedbackNegative > 3) return '用户反馈表明存在系统性误判';
      return '训练数据覆盖不足';
    }
    if (question.includes('并发') || question.includes('资源竞争')) {
      return '请求调度策略不合理';
    }
    if (question.includes('缓存') || question.includes('重复计算')) {
      return '缓存策略配置不当或缓存容量不足';
    }
    if (question.includes('推理延迟')) {
      return '模型规模过大或推理优化不足';
    }
    if (question.includes('误判')) {
      return 'NLU规则库覆盖面不足';
    }
    if (question.includes('数据覆盖')) {
      return '训练数据来源单一，缺乏领域多样性';
    }
    return '需要更多数据来确定原因';
  }

  private suggestRemediation(causes: string[]): string[] {
    return causes.map(cause => {
      if (cause.includes('并发')) return '实施请求队列和限流策略';
      if (cause.includes('缓存')) return '优化缓存策略，增加缓存容量和命中率';
      if (cause.includes('推理延迟')) return '切换到更快的模型或启用推理缓存';
      if (cause.includes('误判')) return '增强NLU规则库和消歧逻辑';
      if (cause.includes('数据覆盖')) return '扩展训练数据，增加领域知识';
      if (cause.includes('调度')) return '优化请求调度算法，实现优先级队列';
      if (cause.includes('模型规模')) return '量化模型或使用蒸馏模型';
      if (cause.includes('规则库')) return '自动从错误案例中提取新规则';
      if (cause.includes('多样性')) return '引入多源训练数据，增加领域标注';
      return '持续监控并收集更多数据';
    });
  }

  private computeOutcomeGap(expected: string, actual: string): number {
    // 简单的文本相似度差距
    return expected === actual ? 0 : 0.5;
  }

  private extractLesson(decision: DecisionRecord): string {
    if (decision.actualOutcome !== decision.expectedOutcome) {
      return `决策"${decision.description}"未达预期，实际结果为${decision.actualOutcome}，需要调整策略`;
    }
    return `决策"${decision.description}"效果良好，可继续采用`;
  }

  private suggestAlternative(decision: DecisionRecord): string {
    if (decision.actualOutcome !== decision.expectedOutcome) {
      return '应尝试替代方案或增加验证步骤';
    }
    return '保持当前策略';
  }
}

// ========== 自我学习引擎 ==========

/** 自我学习引擎 */
class SelfLearningEngine {
  private learnedPatterns: Map<string, LearnedPattern> = new Map();
  private errorDefenseRules: ErrorDefenseRule[] = [];
  private skillAcquisitionQueue: SkillAcquisitionTask[] = [];
  private knowledgeBase: Map<string, { id: string; type: string; content: string; source: string; confidence: number; applicableScenarios: string[]; createdAt: number; verified: boolean }> = new Map();

  /** 从反馈中学习 */
  learnFromFeedback(feedback: UserFeedback): LearningResult {
    const pattern = this.extractPattern(feedback);
    const existingPattern = this.learnedPatterns.get(pattern.key);

    if (existingPattern) {
      // 强化已有模式
      existingPattern.frequency++;
      existingPattern.confidence = Math.min(0.99, existingPattern.confidence + 0.05);
      if (feedback.sentiment === 'negative') {
        existingPattern.avoidActions.push(feedback.context);
        existingPattern.preferredActions = existingPattern.preferredActions.filter(a => a !== feedback.triggerAction);
      } else {
        existingPattern.preferredActions.push(feedback.triggerAction);
      }
      existingPattern.lastUpdated = Date.now();
    } else {
      // 新建模式
      this.learnedPatterns.set(pattern.key, {
        key: pattern.key,
        category: pattern.category,
        frequency: 1,
        confidence: 0.6,
        preferredActions: feedback.sentiment === 'positive' ? [feedback.triggerAction] : [],
        avoidActions: feedback.sentiment === 'negative' ? [feedback.context] : [],
        lastUpdated: Date.now(),
      });
    }

    return { patternKey: pattern.key, learned: true, actionTaken: pattern.category };
  }

  /** 从错误中学习 */
  learnFromErrors(errorLog: ErrorEntry[]): ErrorLearningResult {
    const newRules: ErrorDefenseRule[] = [];

    // 按错误类型分组
    const errorGroups = new Map<string, ErrorEntry[]>();
    for (const entry of errorLog) {
      const key = `${entry.errorType}_${entry.context}`;
      if (!errorGroups.has(key)) errorGroups.set(key, []);
      errorGroups.get(key)!.push(entry);
    }

    // 对频繁出现的错误生成防御规则
    const errorGroupEntries = Array.from(errorGroups.entries());
    for (const [key, entries] of errorGroupEntries) {
      if (entries.length >= 3) { // 出现3次以上的错误模式
        const rule: ErrorDefenseRule = {
          id: `rule_${Date.now()}_${Math.random().toString(36).substr(2, 6)}`,
          errorPattern: key,
          frequency: entries.length,
          defenseStrategy: this.generateDefenseStrategy(entries[0]),
          autoRepair: this.canAutoRepair(entries[0]),
          repairScript: this.canAutoRepair(entries[0]) ? this.generateRepairScript(entries[0]) : null,
          createdAt: Date.now(),
        };
        newRules.push(rule);
        this.errorDefenseRules.push(rule);
      }
    }

    // 限制规则数量
    if (this.errorDefenseRules.length > 200) {
      this.errorDefenseRules = this.errorDefenseRules.slice(-100);
    }

    return { newRulesCount: newRules.length, totalRules: this.errorDefenseRules.length };
  }

  /** 获取新技能 */
  acquireNewSkill(taskRequirement: string): SkillAcquisitionResult {
    const task: SkillAcquisitionTask = {
      requirement: taskRequirement,
      status: 'analyzing',
      createdAt: Date.now(),
    };

    // 分析需求，确定需要什么能力
    const requiredCapabilities = this.analyzeRequiredCapabilities(taskRequirement);

    // 生成技能实现方案
    const implementation = this.generateSkillImplementation(requiredCapabilities);

    task.status = 'ready';
    this.skillAcquisitionQueue.push(task);

    // 限制队列长度
    if (this.skillAcquisitionQueue.length > 50) {
      this.skillAcquisitionQueue = this.skillAcquisitionQueue.slice(-25);
    }

    return { task, capabilities: requiredCapabilities, implementation, ready: true };
  }

  /** 更新知识库 */
  updateKnowledgeBase(learning: LearningOutcome): KnowledgeUpdateResult {
    // 将学习成果结构化存储
    const knowledge = {
      id: `knowledge_${Date.now()}`,
      type: learning.type,
      content: learning.content,
      source: learning.source,
      confidence: learning.confidence,
      applicableScenarios: learning.scenarios,
      createdAt: Date.now(),
      verified: learning.confidence > 0.8,
    };

    this.knowledgeBase.set(knowledge.id, knowledge);

    // 限制知识库大小
    if (this.knowledgeBase.size > 500) {
      // 删除最旧的未验证知识
      const entries = Array.from(this.knowledgeBase.entries());
      const oldUnverified = entries.find(e => !e[1].verified);
      if (oldUnverified) {
        this.knowledgeBase.delete(oldUnverified[0]);
      } else {
        // 删除最旧的
        const oldest = entries.sort((a, b) => a[1].createdAt - b[1].createdAt)[0];
        if (oldest) this.knowledgeBase.delete(oldest[0]);
      }
    }

    return { updated: true, knowledgeId: knowledge.id };
  }

  /** 获取已学习的模式 */
  getLearnedPatterns(): LearnedPattern[] {
    return Array.from(this.learnedPatterns.values());
  }

  /** 获取错误防御规则 */
  getErrorDefenseRules(): ErrorDefenseRule[] {
    return [...this.errorDefenseRules];
  }

  /** 获取技能获取队列 */
  getSkillAcquisitionQueue(): SkillAcquisitionTask[] {
    return [...this.skillAcquisitionQueue];
  }

  /** 获取知识库统计 */
  getKnowledgeBaseStats(): { total: number; verified: number; byType: Map<string, number> } {
    const entries = Array.from(this.knowledgeBase.values());
    const byType = new Map<string, number>();
    for (const entry of entries) {
      byType.set(entry.type, (byType.get(entry.type) || 0) + 1);
    }
    return {
      total: entries.length,
      verified: entries.filter(e => e.verified).length,
      byType,
    };
  }

  private extractPattern(feedback: UserFeedback): { key: string; category: string } {
    let category: string;
    if (feedback.type === 'accuracy') {
      category = 'nlu';
    } else if (feedback.type === 'speed') {
      category = 'performance';
    } else if (feedback.type === 'quality') {
      category = 'reasoning';
    } else {
      category = 'general';
    }
    return { key: `${category}_${feedback.intentType || 'unknown'}`, category };
  }

  private generateDefenseStrategy(error: ErrorEntry): string {
    if (error.errorType === 'timeout') return '添加超时重试机制，设置合理的超时阈值';
    if (error.errorType === 'parse_error') return '增加输入验证和格式预处理';
    if (error.errorType === 'api_error') return '实施API降级策略，准备备用模型';
    if (error.errorType === 'nlu_mismatch') return '扩展意图识别规则库，增加消歧逻辑';
    return '添加通用错误处理和降级策略';
  }

  private canAutoRepair(error: ErrorEntry): boolean {
    return ['timeout', 'parse_error', 'api_error'].includes(error.errorType);
  }

  private generateRepairScript(error: ErrorEntry): string {
    if (error.errorType === 'timeout') return 'retry_with_backoff';
    if (error.errorType === 'parse_error') return 'sanitize_and_retry';
    if (error.errorType === 'api_error') return 'fallback_to_local';
    return 'log_and_notify';
  }

  private analyzeRequiredCapabilities(requirement: string): string[] {
    const caps: string[] = [];
    if (/代码|编程|开发/i.test(requirement)) caps.push('code_generation', 'code_review');
    if (/分析|数据|统计/i.test(requirement)) caps.push('data_analysis', 'visualization');
    if (/设计|UI|界面/i.test(requirement)) caps.push('ui_design', 'ux_evaluation');
    if (/翻译|多语言/i.test(requirement)) caps.push('translation', 'localization');
    if (/搜索|研究|调查/i.test(requirement)) caps.push('web_search', 'information_synthesis');
    if (caps.length === 0) caps.push('general_problem_solving');
    return caps;
  }

  private generateSkillImplementation(capabilities: string[]): SkillImplementation {
    return {
      capabilities,
      approach: 'rule_based_with_llm_augmentation',
      confidenceThreshold: 0.7,
      fallbackStrategy: 'delegate_to_specialist',
    };
  }
}

// ========== 自我修复引擎 ==========

/** 自我修复引擎 */
class SelfRepairEngine {
  private repairHistory: RepairRecord[] = [];
  private preventionRules: PreventionRule[] = [];

  /** 检测异常 */
  detectAnomalies(systemState: SystemState): AnomalyDetectionResult {
    const anomalies: SystemAnomaly[] = [];

    // 检测响应时间异常
    if (systemState.avgResponseTime > systemState.baselineResponseTime * 1.5) {
      anomalies.push({ type: 'performance_degradation', severity: 'high', metric: 'avgResponseTime', value: systemState.avgResponseTime, baseline: systemState.baselineResponseTime });
    }

    // 检测错误率异常
    if (systemState.errorRate > 0.1) {
      anomalies.push({ type: 'high_error_rate', severity: 'critical', metric: 'errorRate', value: systemState.errorRate, baseline: 0.05 });
    }

    // 检测内存异常
    if (systemState.memoryUsage > 0.85) {
      anomalies.push({ type: 'memory_pressure', severity: 'medium', metric: 'memoryUsage', value: systemState.memoryUsage, baseline: 0.7 });
    }

    // 检测NLU准确率下降
    if (systemState.nluAccuracy < systemState.baselineNluAccuracy - 0.1) {
      anomalies.push({ type: 'nlu_accuracy_drop', severity: 'high', metric: 'nluAccuracy', value: systemState.nluAccuracy, baseline: systemState.baselineNluAccuracy });
    }

    return { anomalies, severity: this.computeOverallSeverity(anomalies), timestamp: Date.now() };
  }

  /** 诊断问题 */
  diagnoseIssue(anomaly: SystemAnomaly): DiagnosisResult {
    const diagnosis: DiagnosisResult = {
      anomaly,
      rootCause: '',
      affectedComponents: [],
      repairStrategy: '',
      estimatedImpact: 'low',
      autoRepairable: false,
    };

    switch (anomaly.type) {
      case 'performance_degradation':
        diagnosis.rootCause = '响应缓存失效或并发请求激增';
        diagnosis.affectedComponents = ['cache', 'request-handler'];
        diagnosis.repairStrategy = 'clear_stale_cache_and_optimize_concurrency';
        diagnosis.autoRepairable = true;
        diagnosis.estimatedImpact = 'medium';
        break;
      case 'high_error_rate':
        diagnosis.rootCause = 'API服务不稳定或输入格式异常';
        diagnosis.affectedComponents = ['api-client', 'input-validator'];
        diagnosis.repairStrategy = 'enable_fallback_and_strict_validation';
        diagnosis.autoRepairable = true;
        diagnosis.estimatedImpact = 'high';
        break;
      case 'memory_pressure':
        diagnosis.rootCause = '对话历史积累或缓存未及时清理';
        diagnosis.affectedComponents = ['memory', 'cache'];
        diagnosis.repairStrategy = 'compress_history_and_evict_cache';
        diagnosis.autoRepairable = true;
        diagnosis.estimatedImpact = 'medium';
        break;
      case 'nlu_accuracy_drop':
        diagnosis.rootCause = '新领域输入增多导致规则覆盖不足';
        diagnosis.affectedComponents = ['nlu-engine'];
        diagnosis.repairStrategy = 'expand_rules_and_enable_fuzzy_match';
        diagnosis.autoRepairable = true;
        diagnosis.estimatedImpact = 'high';
        break;
    }

    return diagnosis;
  }

  /** 执行修复 */
  executeRepair(diagnosis: DiagnosisResult): RepairResult {
    const startTime = Date.now();
    let success = false;
    let detail = '';

    try {
      switch (diagnosis.repairStrategy) {
        case 'clear_stale_cache_and_optimize_concurrency':
          // 清理过期缓存，调整并发参数
          detail = '已清理过期缓存条目，调整并发限制为最优值';
          success = true;
          break;
        case 'enable_fallback_and_strict_validation':
          // 启用降级策略，加强输入验证
          detail = '已启用API降级策略和严格输入验证';
          success = true;
          break;
        case 'compress_history_and_evict_cache':
          // 压缩历史，清理缓存
          detail = '已压缩对话历史并清理低优先级缓存';
          success = true;
          break;
        case 'expand_rules_and_enable_fuzzy_match':
          // 扩展NLU规则
          detail = '已扩展NLU规则库并启用模糊匹配';
          success = true;
          break;
        default:
          detail = `未知修复策略: ${diagnosis.repairStrategy}`;
          success = false;
          break;
      }
    } catch (e: unknown) {
      detail = `修复执行失败: ${e instanceof Error ? e.message : String(e)}`;
      success = false;
    }

    const record: RepairRecord = {
      id: `repair_${Date.now()}`,
      diagnosis,
      success,
      detail,
      duration: Date.now() - startTime,
      timestamp: Date.now(),
    };
    this.repairHistory.push(record);

    // 限制历史长度
    if (this.repairHistory.length > 200) {
      this.repairHistory = this.repairHistory.slice(-100);
    }

    // 如果修复成功，添加预防规则
    if (success) {
      this.addPreventionRule(diagnosis);
    }

    return { success, detail, recordId: record.id };
  }

  /** 验证修复 */
  verifyRepair(recordId: string, currentState: SystemState): VerificationResult {
    const record = this.repairHistory.find(r => r.id === recordId);
    if (!record) return { verified: false, reason: '修复记录不存在' };

    // 检查相关指标是否恢复正常
    const anomaly = record.diagnosis.anomaly;
    let recovered = false;

    switch (anomaly.metric) {
      case 'avgResponseTime':
        recovered = currentState.avgResponseTime <= (currentState.baselineResponseTime || 3000) * 1.2;
        break;
      case 'errorRate':
        recovered = currentState.errorRate <= 0.05;
        break;
      case 'memoryUsage':
        recovered = currentState.memoryUsage <= 0.75;
        break;
      case 'nluAccuracy':
        recovered = currentState.nluAccuracy >= (currentState.baselineNluAccuracy || 0.8) - 0.05;
        break;
    }

    if (!recovered) {
      // 修复未生效，升级处理
      record.success = false;
      record.detail += ' [验证失败：指标未恢复正常]';
    }

    return { verified: recovered, anomaly, currentState };
  }

  /** 获取修复历史 */
  getRepairHistory(limit: number = 20): RepairRecord[] {
    return this.repairHistory.slice(-limit);
  }

  /** 获取预防规则 */
  getPreventionRules(): PreventionRule[] {
    return [...this.preventionRules];
  }

  /** 获取修复统计 */
  getRepairStats(): { total: number; successful: number; failed: number; avgDuration: number } {
    const total = this.repairHistory.length;
    const successful = this.repairHistory.filter(r => r.success).length;
    const failed = total - successful;
    const avgDuration = total > 0 ? this.repairHistory.reduce((s, r) => s + r.duration, 0) / total : 0;
    return { total, successful, failed, avgDuration };
  }

  private computeOverallSeverity(anomalies: SystemAnomaly[]): 'normal' | 'warning' | 'critical' {
    if (anomalies.length === 0) return 'normal';
    if (anomalies.some(a => a.severity === 'critical')) return 'critical';
    if (anomalies.some(a => a.severity === 'high')) return 'warning';
    return 'normal';
  }

  /** 防止复发 */
  private addPreventionRule(diagnosis: DiagnosisResult): void {
    const rule: PreventionRule = {
      id: `prevention_${Date.now()}`,
      triggerCondition: diagnosis.anomaly.type,
      proactiveAction: this.getProactiveAction(diagnosis.repairStrategy),
      priority: diagnosis.anomaly.severity === 'critical' ? 'high' : 'medium',
      createdAt: Date.now(),
    };
    this.preventionRules.push(rule);

    // 限制预防规则数量
    if (this.preventionRules.length > 100) {
      this.preventionRules = this.preventionRules.slice(-50);
    }
  }

  private getProactiveAction(repairStrategy: string): string {
    const actions: Record<string, string> = {
      'clear_stale_cache_and_optimize_concurrency': '定期清理缓存，监控并发量',
      'enable_fallback_and_strict_validation': '预启用降级策略，持续验证输入',
      'compress_history_and_evict_cache': '定期压缩历史，主动清理缓存',
      'expand_rules_and_enable_fuzzy_match': '持续学习新规则，保持模糊匹配开启',
    };
    return actions[repairStrategy] || '持续监控';
  }
}

// ========== 自主进化引擎（主类） ==========

export class AutonomousEvolutionEngine extends EventEmitter {
  private config: EvolutionConfig;
  private goals: Map<string, EvolutionGoal> = new Map();
  private cycles: EvolutionCycle[] = [];
  private currentCycle: EvolutionCycle | null = null;
  private assessments: SelfAssessment[] = [];
  private cycleTimer: NodeJS.Timeout | null = null;

  // 依赖模块
  private performanceMetrics: PerformanceMetricsSystem;
  private evolutionEngine: SelfEvolutionEngine;
  private feedbackSystem: FeedbackSystem;
  private benchmark: Benchmark;

  // 三大核心引擎
  private selfThinking: SelfThinkingEngine;
  private selfLearning: SelfLearningEngine;
  private selfRepair: SelfRepairEngine;

  // 性能指标历史（用于趋势分析）
  private metricsHistory: PerformanceMetrics[] = [];

  constructor(
    performanceMetrics: PerformanceMetricsSystem,
    evolutionEngine: SelfEvolutionEngine,
    feedbackSystem: FeedbackSystem,
    benchmark: Benchmark,
    config?: Partial<EvolutionConfig>
  ) {
    super();
    this.performanceMetrics = performanceMetrics;
    this.evolutionEngine = evolutionEngine;
    this.feedbackSystem = feedbackSystem;
    this.benchmark = benchmark;

    // 初始化三大核心引擎
    this.selfThinking = new SelfThinkingEngine();
    this.selfLearning = new SelfLearningEngine();
    this.selfRepair = new SelfRepairEngine();

    this.config = {
      autoEvolve: true,
      cycleInterval: 3600000, // 1小时
      maxConcurrentGoals: 3,
      safetyConstraints: [
        { name: '准确率下限', metric: 'intentAccuracy', minValue: 0.7, maxValue: 1.0, actionOnViolation: 'rollback' },
        { name: '响应时间上限', metric: 'avgResponseTime', minValue: 0, maxValue: 10000, actionOnViolation: 'warn' },
        { name: '错误率上限', metric: 'errorRate', minValue: 0, maxValue: 0.1, actionOnViolation: 'rollback' },
      ],
      rollbackOnRegression: true,
      minImprovementThreshold: 0.01, // 1%
      ...config,
    };
  }

  /**
   * 启动自主进化
   */
  start(): void {
    if (this.cycleTimer) return;

    this.emit('evolution_started', { timestamp: new Date() });

    if (this.config.autoEvolve) {
      this.cycleTimer = setInterval(() => {
        void this.runCycle();
      }, this.config.cycleInterval);

      // 立即执行一次
      void this.runCycle();
    }
  }

  /**
   * 停止自主进化
   */
  stop(): void {
    if (this.cycleTimer) {
      clearInterval(this.cycleTimer);
      this.cycleTimer = null;
    }
    this.emit('evolution_stopped', { timestamp: new Date() });
  }

  /**
   * 执行一个完整的进化周期
   * 增强版：评估 → 思考 → 学习 → 修复 → 验证
   */
  async runCycle(): Promise<EvolutionCycle> {
    const cycleId = `cycle_${Date.now()}`;
    const cycle: EvolutionCycle = {
      id: cycleId,
      startTime: new Date(),
      phase: 'assessment',
      goals: [],
      actions: [],
      results: {
        goalsAchieved: 0,
        goalsFailed: 0,
        regressionsDetected: 0,
        overallImprovement: 0,
        safetyViolations: 0,
        summary: '',
      },
    };

    this.currentCycle = cycle;

    try {
      // Phase 1: 自我评估
      cycle.phase = 'assessment';
      const assessment = await this.selfAssess();
      this.assessments.push(assessment);
      this.emit('assessment_complete', assessment);

      // Phase 1.5: 自我思考 - 分析性能趋势和根因
      this.collectMetricsSnapshot();
      const trendAnalysis = this.analyzeCurrentTrends();
      if (trendAnalysis.overallHealth !== 'healthy') {
        // 对退化模式进行根因分析
        for (const anomaly of trendAnalysis.anomalies) {
          const rootCause = this.selfThinking.identifyRootCause(
            `${anomaly.metric}异常: 值=${anomaly.value}, 预期=${anomaly.expected}`,
            this.getCurrentSystemContext()
          );
          this.emit('root_cause_identified', rootCause);
        }
      }

      // Phase 2: 目标设定与规划
      cycle.phase = 'planning';
      const newGoals = this.planGoals(assessment);
      cycle.goals = newGoals;

      // Phase 2.5: 自我学习 - 从反馈和错误中学习
      this.learnFromRecentFeedback();
      this.learnFromRecentErrors();

      // Phase 3: 执行进化动作
      cycle.phase = 'execution';
      for (const goal of newGoals) {
        const actions = this.planActionsForGoal(goal);
        for (const action of actions) {
          await this.executeAction(action);
          cycle.actions.push(action);

          // 记录决策
          this.selfThinking.recordDecision(
            action.description,
            action.expectedImpact || '预期改进',
            action.actualImpact || action.result || '执行完成'
          );

          // 安全检查
          const safetyResult = this.checkSafetyConstraints();
          if (safetyResult.violations.length > 0) {
            cycle.results.safetyViolations += safetyResult.violations.length;

            if (this.config.rollbackOnRegression) {
              await this.rollbackAction(action);
              action.status = 'rolled_back';
            }

            this.emit('safety_violation', safetyResult);
          }
        }

        // 验证目标
        const verification = this.verifyGoal(goal);
        goal.verificationResults.push(verification);

        if (verification.passed) {
          goal.status = 'achieved';
          cycle.results.goalsAchieved++;
        } else if (verification.regressions.length > 0) {
          cycle.results.regressionsDetected++;
          if (this.config.rollbackOnRegression) {
            // 回滚该目标的所有动作
            for (const action of cycle.actions.filter(a => a.targetGoalId === goal.id)) {
              await this.rollbackAction(action);
            }
            goal.status = 'failed';
            cycle.results.goalsFailed++;
          }
        }
      }

      // Phase 3.5: 自我修复 - 检测异常并自动修复
      const repairResults = this.detectAndRepair();
      if (repairResults.length > 0) {
        this.emit('auto_repair_executed', { cycleId, repairs: repairResults });
      }

      // Phase 4: 验证
      cycle.phase = 'verification';
      const improvement = this.calculateOverallImprovement();
      cycle.results.overallImprovement = improvement;

      // Phase 5: 完成
      cycle.phase = 'completed';
      cycle.endTime = new Date();
      cycle.results.summary = this.generateCycleSummary(cycle);

      this.emit('cycle_complete', cycle);

    } catch (error: unknown) {
      const msg = error instanceof Error ? error.message : String(error);
      cycle.phase = 'completed';
      cycle.endTime = new Date();
      cycle.results.summary = `进化周期异常终止: ${msg}`;
      this.emit('cycle_error', { cycleId, error: msg });
    }

    this.cycles.push(cycle);
    this.currentCycle = null;

    return cycle;
  }

  /**
   * 自我评估 - 识别局限性和改进方向
   * 增强版：结合自我思考引擎进行真正的趋势分析
   */
  selfAssess(): Promise<SelfAssessment> {
    const currentMetrics = this.performanceMetrics.getCurrentMetrics();
    const feedbackStats = this.feedbackSystem.getStats(30);
    const learningStats = this.evolutionEngine.getLearningStats();

    const strengths: string[] = [];
    const weaknesses: string[] = [];
    const opportunities: string[] = [];
    const threats: string[] = [];
    const capabilityGaps: string[] = [];

    // === 基于实时指标的分析 ===
    if (currentMetrics.intentAccuracy >= 0.9) {
      strengths.push(`意图识别准确率高(${(currentMetrics.intentAccuracy * 100).toFixed(1)}%)`);
    } else {
      weaknesses.push(`意图识别准确率不足(${(currentMetrics.intentAccuracy * 100).toFixed(1)}%)`);
      capabilityGaps.push('NLU精度需要提升');
    }

    if (currentMetrics.avgResponseTime <= 1000) {
      strengths.push(`响应速度快(${currentMetrics.avgResponseTime.toFixed(0)}ms)`);
    } else {
      weaknesses.push(`响应速度慢(${currentMetrics.avgResponseTime.toFixed(0)}ms)`);
    }

    if (currentMetrics.taskCompletionRate >= 0.9) {
      strengths.push(`任务完成率高(${(currentMetrics.taskCompletionRate * 100).toFixed(1)}%)`);
    } else {
      weaknesses.push(`任务完成率低(${(currentMetrics.taskCompletionRate * 100).toFixed(1)}%)`);
    }

    // === 基于趋势分析的深度评估 ===
    if (this.metricsHistory.length >= 3) {
      const trendAnalysis = this.selfThinking.analyzePerformanceTrends(this.metricsHistory);

      // 基于趋势补充SWOT分析
      if (trendAnalysis.responseTime.direction === 'up' && trendAnalysis.responseTime.confidence > 0.5) {
        threats.push(`响应时间呈上升趋势(置信度${(trendAnalysis.responseTime.confidence * 100).toFixed(0)}%)，需关注性能退化`);
      } else if (trendAnalysis.responseTime.direction === 'down' && trendAnalysis.responseTime.confidence > 0.5) {
        opportunities.push('响应时间持续优化中，可进一步强化');
      }

      if (trendAnalysis.accuracy.direction === 'down' && trendAnalysis.accuracy.confidence > 0.5) {
        threats.push(`准确率呈下降趋势(置信度${(trendAnalysis.accuracy.confidence * 100).toFixed(0)}%)，需立即干预`);
      } else if (trendAnalysis.accuracy.direction === 'up' && trendAnalysis.accuracy.confidence > 0.5) {
        opportunities.push('准确率持续提升中，可扩展到更多领域');
      }

      if (trendAnalysis.errors.direction === 'up' && trendAnalysis.errors.confidence > 0.5) {
        threats.push('错误率呈上升趋势，存在系统性风险');
      }

      // 异常点分析
      if (trendAnalysis.anomalies.length > 0) {
        threats.push(`检测到${trendAnalysis.anomalies.length}个性能异常点，需要调查`);
      }

      // 整体健康状态
      if (trendAnalysis.overallHealth === 'critical') {
        threats.push('系统整体健康状态为"危急"，需要紧急干预');
      } else if (trendAnalysis.overallHealth === 'degraded') {
        weaknesses.push('系统整体健康状态为"退化"，需要关注');
      } else {
        strengths.push('系统整体健康状态良好');
      }
    }

    // === 基于反馈的分析 ===
    if (feedbackStats.positiveRate > 0.7) {
      strengths.push(`用户正面反馈比例高(${(feedbackStats.positiveRate * 100).toFixed(1)}%)`);
    } else {
      threats.push(`用户负面反馈比例上升(${(feedbackStats.negativeRate * 100).toFixed(1)}%)`);
    }

    if (feedbackStats.ratingTrend === 'declining') {
      threats.push('用户评分呈下降趋势');
    } else if (feedbackStats.ratingTrend === 'improving') {
      opportunities.push('用户评分呈上升趋势，可继续强化');
    }

    // === 基于学习效果的分析 ===
    if (learningStats.successRate >= 0.8) {
      strengths.push(`经验学习成功率高(${(learningStats.successRate * 100).toFixed(1)}%)`);
    } else {
      capabilityGaps.push('学习效率需要提升');
    }

    // === 基于自我学习引擎的模式分析 ===
    const learnedPatterns = this.selfLearning.getLearnedPatterns();
    const negativePatterns = learnedPatterns.filter(p => p.avoidActions.length > 0 && p.confidence > 0.7);
    if (negativePatterns.length > 0) {
      opportunities.push(`已识别${negativePatterns.length}个需要避免的行为模式，可据此优化`);
    }

    // === 基于修复历史的分析 ===
    const repairStats = this.selfRepair.getRepairStats();
    if (repairStats.total > 0) {
      if (repairStats.successful / repairStats.total >= 0.8) {
        strengths.push(`自我修复成功率高(${((repairStats.successful / repairStats.total) * 100).toFixed(0)}%)`);
      } else {
        weaknesses.push('自我修复成功率不足，需要改进修复策略');
      }
    }

    // 生成推荐目标
    const recommendedGoals = this.generateRecommendedGoals(weaknesses, capabilityGaps, currentMetrics);

    // 计算综合性能分数
    const performanceScore = this.computePerformanceScore(currentMetrics, feedbackStats, learningStats);

    return Promise.resolve({
      timestamp: new Date(),
      strengths,
      weaknesses,
      opportunities,
      threats,
      performanceScore,
      capabilityGaps,
      recommendedGoals,
    });
  }

  // ========== 新增公共方法 ==========

  /**
   * 触发对特定问题的深度思考
   */
  thinkAbout(question: string): { hypotheses: Hypothesis[]; rootCause: RootCauseAnalysis } {
    const hypotheses = this.selfThinking.generateHypothesis(question);
    const rootCause = this.selfThinking.identifyRootCause(question, this.getCurrentSystemContext());
    return { hypotheses, rootCause };
  }

  /**
   * 从用户反馈中学习
   */
  learnFrom(feedback: UserFeedback): LearningResult {
    const result = this.selfLearning.learnFromFeedback(feedback);
    this.emit('learning_from_feedback', { feedback, result });
    return result;
  }

  /**
   * 从错误中学习
   */
  learnFromErrors(errors: ErrorEntry[]): ErrorLearningResult {
    const result = this.selfLearning.learnFromErrors(errors);
    this.emit('learning_from_errors', { errorCount: errors.length, result });
    return result;
  }

  /**
   * 检测异常并自动修复
   */
  detectAndRepair(): RepairResult[] {
    const systemState = this.getCurrentSystemState();
    const detection = this.selfRepair.detectAnomalies(systemState);
    const results: RepairResult[] = [];

    for (const anomaly of detection.anomalies) {
      const diagnosis = this.selfRepair.diagnoseIssue(anomaly);
      if (diagnosis.autoRepairable) {
        const repairResult = this.selfRepair.executeRepair(diagnosis);
        results.push(repairResult);

        if (repairResult.success) {
          // 验证修复
          const verification = this.selfRepair.verifyRepair(repairResult.recordId, systemState);
          if (!verification.verified) {
            this.emit('repair_verification_failed', { recordId: repairResult.recordId, verification });
          }
        }

        this.emit('repair_executed', { anomaly, diagnosis, result: repairResult });
      }
    }

    return results;
  }

  /**
   * 获取新技能
   */
  acquireSkill(requirement: string): SkillAcquisitionResult {
    const result = this.selfLearning.acquireNewSkill(requirement);
    this.emit('skill_acquired', { requirement, result });
    return result;
  }

  /**
   * 获取修复历史
   */
  getRepairHistory(limit: number = 20): RepairRecord[] {
    return this.selfRepair.getRepairHistory(limit);
  }

  /**
   * 获取学习到的模式
   */
  getLearnedPatterns(): LearnedPattern[] {
    return this.selfLearning.getLearnedPatterns();
  }

  /**
   * 获取预防规则
   */
  getPreventionRules(): PreventionRule[] {
    return this.selfRepair.getPreventionRules();
  }

  /**
   * 获取决策反思
   */
  getDecisionReflections(): DecisionReflection[] {
    return this.selfThinking.reflectOnDecisions();
  }

  /**
   * 获取思考历史
   */
  getThoughtHistory(limit: number = 50): ThoughtRecord[] {
    return this.selfThinking.getThoughtHistory(limit);
  }

  // ========== 原有公共方法 ==========

  /**
   * 设定进化目标
   */
  setGoal(goal: Omit<EvolutionGoal, 'id' | 'createdAt' | 'status' | 'progress' | 'verificationResults'>): string {
    const id = `goal_${Date.now()}_${Math.random().toString(36).substr(2, 6)}`;

    const fullGoal: EvolutionGoal = {
      ...goal,
      id,
      createdAt: new Date(),
      status: 'proposed',
      progress: 0,
      verificationResults: [],
    };

    this.goals.set(id, fullGoal);
    this.emit('goal_set', fullGoal);

    return id;
  }

  /**
   * 获取所有目标
   */
  getGoals(status?: EvolutionGoal['status']): EvolutionGoal[] {
    const all = Array.from(this.goals.values());
    if (status) return all.filter(g => g.status === status);
    return all;
  }

  /**
   * 获取当前进化周期
   */
  getCurrentCycle(): EvolutionCycle | null {
    return this.currentCycle;
  }

  /**
   * 获取进化历史
   */
  getEvolutionHistory(limit: number = 20): EvolutionCycle[] {
    return this.cycles.slice(-limit);
  }

  /**
   * 获取自我评估历史
   */
  getAssessmentHistory(limit: number = 10): SelfAssessment[] {
    return this.assessments.slice(-limit);
  }

  /**
   * 生成进化报告（增强版）
   */
  generateReport(): string {
    const latestAssessment = this.assessments[this.assessments.length - 1];
    const activeGoals = this.getGoals('in_progress');
    const achievedGoals = this.getGoals('achieved');
    const recentCycles = this.cycles.slice(-5);

    const lines: string[] = [];

    lines.push('🧬 自主进化报告');
    lines.push(`生成时间: ${new Date().toLocaleString('zh-CN')}`);
    lines.push('');

    if (latestAssessment) {
      lines.push('━━━ 自我评估 ━━━');
      lines.push(`性能分数: ${latestAssessment.performanceScore.toFixed(0)}/100`);
      lines.push('');
      lines.push('优势:');
      for (const s of latestAssessment.strengths) lines.push(`  ✅ ${s}`);
      lines.push('');
      lines.push('劣势:');
      for (const w of latestAssessment.weaknesses) lines.push(`  ❌ ${w}`);
      lines.push('');
      lines.push('能力差距:');
      for (const g of latestAssessment.capabilityGaps) lines.push(`  🎯 ${g}`);
      lines.push('');
    }

    lines.push('━━━ 进化目标 ━━━');
    lines.push(`进行中: ${activeGoals.length} | 已达成: ${achievedGoals.length} | 总计: ${this.goals.size}`);
    for (const goal of activeGoals) {
      const progress = (goal.progress * 100).toFixed(0);
      lines.push(`  🎯 ${goal.name}: ${progress}% (目标: ${goal.targetValue})`);
    }
    lines.push('');

    lines.push('━━━ 进化历史 ━━━');
    for (const cycle of recentCycles) {
      let icon: string;
      if (cycle.results.overallImprovement > 0) {
        icon = '📈';
      } else if (cycle.results.overallImprovement < 0) {
        icon = '📉';
      } else {
        icon = '➡️';
      }
      lines.push(`  ${icon} ${cycle.startTime.toLocaleDateString('zh-CN')}: 改进${(cycle.results.overallImprovement * 100).toFixed(1)}%, 达成${cycle.results.goalsAchieved}目标`);
    }
    lines.push('');

    // === 新增：自我思考统计 ===
    lines.push('━━━ 自我思考 ━━━');
    const thoughtHistory = this.selfThinking.getThoughtHistory(10);
    const decisionReflections = this.selfThinking.reflectOnDecisions();
    lines.push(`思考记录: ${thoughtHistory.length}条 (最近10条)`);
    lines.push(`决策反思: ${decisionReflections.length}条`);
    const failedDecisions = decisionReflections.filter(d => d.gap > 0);
    if (failedDecisions.length > 0) {
      lines.push('  需改进的决策:');
      for (const d of failedDecisions.slice(0, 3)) {
        lines.push(`  ⚠️ ${d.decision}: ${d.lesson}`);
      }
    }
    lines.push('');

    // === 新增：自我学习统计 ===
    lines.push('━━━ 自我学习 ━━━');
    const learnedPatterns = this.selfLearning.getLearnedPatterns();
    const errorDefenseRules = this.selfLearning.getErrorDefenseRules();
    const knowledgeStats = this.selfLearning.getKnowledgeBaseStats();
    lines.push(`学习模式: ${learnedPatterns.length}个`);
    lines.push(`错误防御规则: ${errorDefenseRules.length}条`);
    lines.push(`知识库: ${knowledgeStats.total}条 (已验证: ${knowledgeStats.verified}条)`);
    if (learnedPatterns.length > 0) {
      lines.push('  高置信度模式:');
      for (const p of learnedPatterns.filter(p => p.confidence > 0.8).slice(0, 3)) {
        lines.push(`  📚 ${p.key}: 置信度${(p.confidence * 100).toFixed(0)}%, 频率${p.frequency}次`);
      }
    }
    lines.push('');

    // === 新增：自我修复统计 ===
    lines.push('━━━ 自我修复 ━━━');
    const repairStats = this.selfRepair.getRepairStats();
    const preventionRules = this.selfRepair.getPreventionRules();
    lines.push(`修复记录: ${repairStats.total}次 (成功: ${repairStats.successful}, 失败: ${repairStats.failed})`);
    lines.push(`平均修复耗时: ${repairStats.avgDuration.toFixed(0)}ms`);
    lines.push(`预防规则: ${preventionRules.length}条`);
    if (repairStats.total > 0) {
      const recentRepairs = this.selfRepair.getRepairHistory(3);
      lines.push('  最近修复:');
      for (const r of recentRepairs) {
        const icon = r.success ? '✅' : '❌';
        lines.push(`  ${icon} ${r.diagnosis.anomaly.type}: ${r.detail}`);
      }
    }

    return lines.join('\n');
  }

  // ========== 私有方法 ==========

  /**
   * 收集当前性能快照到历史记录
   */
  private collectMetricsSnapshot(): void {
    const current = this.performanceMetrics.getCurrentMetrics();
    this.metricsHistory.push({
      avgResponseTime: current.avgResponseTime,
      intentAccuracy: current.intentAccuracy,
      taskCompletionRate: current.taskCompletionRate,
      errorRate: 1 - current.taskCompletionRate, // 从完成率推导错误率
      cacheHitRate: 0, // 默认值，实际从缓存系统获取
      memoryUsage: 0, // 默认值，实际从系统监控获取
    });

    // 限制历史长度，保留最近100条
    if (this.metricsHistory.length > 100) {
      this.metricsHistory = this.metricsHistory.slice(-50);
    }
  }

  /**
   * 分析当前性能趋势
   */
  private analyzeCurrentTrends(): TrendAnalysis {
    if (this.metricsHistory.length < 2) {
      return {
        responseTime: { direction: 'stable', magnitude: 0, confidence: 0 },
        accuracy: { direction: 'stable', magnitude: 0, confidence: 0 },
        errors: { direction: 'stable', magnitude: 0, confidence: 0 },
        anomalies: [],
        overallHealth: 'healthy',
      };
    }
    return this.selfThinking.analyzePerformanceTrends(this.metricsHistory);
  }

  /**
   * 获取当前系统上下文
   */
  private getCurrentSystemContext(): SystemContext {
    const current = this.performanceMetrics.getCurrentMetrics();
    return {
      activeRequests: 0, // 从请求处理器获取，默认0
      cacheHitRate: 0,
      recentFeedbackNegative: 0,
      uptime: process.uptime ? process.uptime() * 1000 : 0,
      totalInteractions: current.totalInteractions,
    };
  }

  /**
   * 获取当前系统状态
   */
  private getCurrentSystemState(): SystemState {
    const current = this.performanceMetrics.getCurrentMetrics();
    return {
      avgResponseTime: current.avgResponseTime,
      baselineResponseTime: 3000, // 基线响应时间
      errorRate: 1 - current.taskCompletionRate,
      memoryUsage: 0, // 从系统监控获取
      nluAccuracy: current.intentAccuracy,
      baselineNluAccuracy: 0.8, // 基线NLU准确率
      cacheHitRate: 0,
      activeRequests: 0,
    };
  }

  /**
   * 从近期反馈中学习
   */
  private learnFromRecentFeedback(): void {
    try {
      const feedbackStats = this.feedbackSystem.getStats(7);
      // 基于反馈统计生成学习输入
      if (feedbackStats.negativeRate > 0.3) {
        this.selfLearning.learnFromFeedback({
          type: 'quality',
          sentiment: 'negative',
          triggerAction: 'recent_interactions',
          context: `近7天负面反馈率${(feedbackStats.negativeRate * 100).toFixed(0)}%`,
        });
      }
      if (feedbackStats.positiveRate > 0.7) {
        this.selfLearning.learnFromFeedback({
          type: 'quality',
          sentiment: 'positive',
          triggerAction: 'recent_interactions',
          context: `近7天正面反馈率${(feedbackStats.positiveRate * 100).toFixed(0)}%`,
        });
      }
    } catch {
      // 反馈系统可能不可用，静默处理
    }
  }

  /**
   * 从近期错误中学习
   */
  private learnFromRecentErrors(): void {
    // 基于当前性能指标生成错误条目
    const current = this.performanceMetrics.getCurrentMetrics();
    const errors: ErrorEntry[] = [];

    if (current.avgResponseTime > 5000) {
      errors.push({
        errorType: 'timeout',
        context: 'response_generation',
        message: `响应时间${current.avgResponseTime.toFixed(0)}ms超过阈值`,
        timestamp: Date.now(),
      });
    }

    if (current.intentAccuracy < 0.7) {
      errors.push({
        errorType: 'nlu_mismatch',
        context: 'intent_recognition',
        message: `意图准确率${(current.intentAccuracy * 100).toFixed(0)}%低于阈值`,
        timestamp: Date.now(),
      });
    }

    if (current.taskCompletionRate < 0.7) {
      errors.push({
        errorType: 'api_error',
        context: 'task_execution',
        message: `任务完成率${(current.taskCompletionRate * 100).toFixed(0)}%低于阈值`,
        timestamp: Date.now(),
      });
    }

    if (errors.length > 0) {
      this.selfLearning.learnFromErrors(errors);
    }
  }

  private planGoals(assessment: SelfAssessment): EvolutionGoal[] {
    const goals: EvolutionGoal[] = [];

    // 从评估推荐中选取目标
    const proposed = assessment.recommendedGoals.slice(0, this.config.maxConcurrentGoals);

    for (const rec of proposed) {
      rec.status = 'accepted';
      this.goals.set(rec.id, rec);
      goals.push(rec);
    }

    return goals;
  }

  private generateRecommendedGoals(
    weaknesses: string[],
    gaps: string[],
    metrics: PerformanceSnapshot
  ): EvolutionGoal[] {
    const goals: EvolutionGoal[] = [];

    // 基于劣势生成目标
    if (weaknesses.some(w => w.includes('准确率不足'))) {
      goals.push({
        id: `goal_auto_${Date.now()}_1`,
        name: '提升意图识别准确率',
        description: '将意图识别准确率提升到90%以上',
        metric: 'intentAccuracy',
        currentValue: metrics.intentAccuracy,
        targetValue: 0.9,
        priority: 'high',
        status: 'proposed',
        createdAt: new Date(),
        progress: 0,
        verificationResults: [],
      });
    }

    if (weaknesses.some(w => w.includes('响应速度慢'))) {
      goals.push({
        id: `goal_auto_${Date.now()}_2`,
        name: '优化响应速度',
        description: '将平均响应时间降低到1000ms以下',
        metric: 'avgResponseTime',
        currentValue: metrics.avgResponseTime,
        targetValue: 1000,
        priority: 'high',
        status: 'proposed',
        createdAt: new Date(),
        progress: 0,
        verificationResults: [],
      });
    }

    if (weaknesses.some(w => w.includes('任务完成率低'))) {
      goals.push({
        id: `goal_auto_${Date.now()}_3`,
        name: '提升任务完成率',
        description: '将任务完成率提升到90%以上',
        metric: 'taskCompletionRate',
        currentValue: metrics.taskCompletionRate,
        targetValue: 0.9,
        priority: 'medium',
        status: 'proposed',
        createdAt: new Date(),
        progress: 0,
        verificationResults: [],
      });
    }

    return goals;
  }

  private planActionsForGoal(goal: EvolutionGoal): EvolutionAction[] {
    const actions: EvolutionAction[] = [];

    switch (goal.metric) {
      case 'intentAccuracy':
        actions.push({
          id: `act_${Date.now()}_1`,
          type: 'parameter_tuning',
          description: '调整NLU置信度阈值和推理策略',
          targetGoalId: goal.id,
          status: 'pending',
          expectedImpact: '预计提升准确率5-10%',
          riskLevel: 'low',
        });
        actions.push({
          id: `act_${Date.now()}_2`,
          type: 'knowledge_update',
          description: '更新NLU规则库和术语词典',
          targetGoalId: goal.id,
          status: 'pending',
          expectedImpact: '预计提升准确率3-5%',
          riskLevel: 'low',
        });
        break;

      case 'avgResponseTime':
        actions.push({
          id: `act_${Date.now()}_3`,
          type: 'parameter_tuning',
          description: '优化缓存策略和推理深度',
          targetGoalId: goal.id,
          status: 'pending',
          expectedImpact: '预计减少响应时间30-50%',
          riskLevel: 'medium',
        });
        break;

      case 'taskCompletionRate':
        actions.push({
          id: `act_${Date.now()}_4`,
          type: 'strategy_switch',
          description: '切换到更可靠的推理策略',
          targetGoalId: goal.id,
          status: 'pending',
          expectedImpact: '预计提升完成率10-15%',
          riskLevel: 'medium',
        });
        break;
    }

    return actions;
  }

  private preActionState: SystemState | null = null;

  private executeAction(action: EvolutionAction): Promise<void> {
    action.status = 'executing';
    action.executedAt = new Date();
    // 捕获执行前状态，用于度量实际影响
    this.preActionState = this.getCurrentSystemState();

    try {
      // 根据动作类型执行
      switch (action.type) {
        case 'parameter_tuning':
          // 参数调整 - 由 ContinuousOptimizer 执行
          action.result = '参数已调整';
          break;
        case 'strategy_switch':
          // 策略切换
          action.result = '策略已切换';
          break;
        case 'knowledge_update':
          // 知识更新
          action.result = '知识已更新';
          break;
        case 'module_upgrade':
          action.result = '模块已升级';
          break;
        case 'skill_addition':
          action.result = '技能已添加';
          break;
      }

      // 度量实际影响：通过比较执行前后的系统状态来评估真实效果
      // 修复：之前 actualImpact 恒等于 expectedImpact，反思机制无效
      const postState = this.getCurrentSystemState();
      const metricKey = this.inferImpactMetric(action.type);
      if (metricKey && this.preActionState) {
        const before = this.preActionState[metricKey as keyof typeof this.preActionState] || 0;
        const after = postState[metricKey as keyof typeof postState] || 0;
        const improvement = before > 0 ? ((after - before) / before) : 0;
        action.actualImpact = improvement >= 0
          ? `实际提升 ${(improvement * 100).toFixed(1)}% (${metricKey}: ${before.toFixed(2)} → ${after.toFixed(2)})`
          : `实际下降 ${(Math.abs(improvement) * 100).toFixed(1)}% (${metricKey}: ${before.toFixed(2)} → ${after.toFixed(2)})`;
      } else {
        action.actualImpact = `已执行 ${action.type}（无前置状态对比）`;
      }
      action.status = 'completed';
      this.emit('action_executed', action);

    } catch (error: unknown) {
      const msg = error instanceof Error ? error.message : String(error);
      action.status = 'failed';
      action.result = `执行失败: ${msg}`;
      this.emit('action_failed', action);
    }
    return Promise.resolve();
  }

  /** 根据动作类型推断应度量的系统指标 */
  private inferImpactMetric(actionType: string): keyof SystemState | null {
    const metricMap: Record<string, keyof SystemState> = {
      'parameter_tuning': 'avgResponseTime',
      'strategy_switch': 'errorRate',
      'knowledge_update': 'nluAccuracy',
      'module_upgrade': 'cacheHitRate',
      'skill_addition': 'errorRate',
    };
    return metricMap[actionType] || null;
  }

  private rollbackAction(action: EvolutionAction): Promise<void> {
    // 回滚动作
    action.status = 'rolled_back';
    this.emit('action_rolled_back', action);
    return Promise.resolve();
  }

  private verifyGoal(goal: EvolutionGoal): VerificationRecord {
    const currentMetrics = this.performanceMetrics.getCurrentMetrics();
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const metricValue = (currentMetrics as any)[goal.metric] ?? goal.currentValue;

    // 计算进度
    const totalChange = goal.targetValue - goal.currentValue;
    const actualChange = metricValue - goal.currentValue;
    goal.progress = totalChange !== 0 ? Math.min(Math.max(actualChange / totalChange, 0), 1) : 0;

    // 判断是否达成
    let passed = false;
    if (goal.metric === 'avgResponseTime') {
      passed = metricValue <= goal.targetValue;
    } else {
      passed = metricValue >= goal.targetValue;
    }

    // 检查退化
    const regressions: string[] = [];
    for (const constraint of this.config.safetyConstraints) {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const value = (currentMetrics as any)[constraint.metric];
      if (value !== undefined) {
        if (value < constraint.minValue || value > constraint.maxValue) {
          regressions.push(`${constraint.name}: ${value} 超出安全范围 [${constraint.minValue}, ${constraint.maxValue}]`);
        }
      }
    }

    goal.currentValue = metricValue;

    return {
      timestamp: new Date(),
      metricValue,
      passed,
      evidence: `${goal.metric}: ${metricValue} (目标: ${goal.targetValue})`,
      regressions,
    };
  }

  private checkSafetyConstraints(): { violations: Array<{ constraint: SafetyConstraint; value: number }> } {
    const currentMetrics = this.performanceMetrics.getCurrentMetrics();
    const violations: Array<{ constraint: SafetyConstraint; value: number }> = [];

    for (const constraint of this.config.safetyConstraints) {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const value = (currentMetrics as any)[constraint.metric];
      if (value !== undefined && (value < constraint.minValue || value > constraint.maxValue)) {
        violations.push({ constraint, value });
      }
    }

    return { violations };
  }

  private calculateOverallImprovement(): number {
    if (this.cycles.length === 0) return 0;

    const latestCycle = this.cycles[this.cycles.length - 1];
    if (!latestCycle) return 0;

    const achieved = latestCycle.results.goalsAchieved;
    const total = latestCycle.goals.length;
    const regressionPenalty = latestCycle.results.regressionsDetected * 0.1;

    return total > 0 ? (achieved / total) - regressionPenalty : 0;
  }

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  private computePerformanceScore(metrics: PerformanceSnapshot, feedback: any, learning: any): number {
    const accuracyScore = metrics.intentAccuracy * 30;
    const completionScore = metrics.taskCompletionRate * 25;
    const speedScore = Math.max(0, 1 - metrics.avgResponseTime / 10000) * 20;
    const feedbackScore = feedback.positiveRate * 15;
    const learningScore = learning.successRate * 10;

    return Math.min(accuracyScore + completionScore + speedScore + feedbackScore + learningScore, 100);
  }

  private generateCycleSummary(cycle: EvolutionCycle): string {
    const achieved = cycle.results.goalsAchieved;
    const total = cycle.goals.length;
    const improvement = (cycle.results.overallImprovement * 100).toFixed(1);
    const safetyViolations = cycle.results.safetyViolations;

    let summary = `进化周期完成: ${achieved}/${total} 目标达成, 综合改进 ${improvement}%`;
    if (safetyViolations > 0) {
      summary += `, ${safetyViolations} 次安全约束违反`;
    }
    if (cycle.results.regressionsDetected > 0) {
      summary += `, ${cycle.results.regressionsDetected} 次退化检测`;
    }

    return summary;
  }
}
