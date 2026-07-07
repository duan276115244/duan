/**
 * 自主深度学习引擎 (Autonomous Deep Learning Engine)
 * 
 * 持续自我进化的学习框架，包含：
 * - 知识缺口识别：通过性能分析和任务结果评估自动检测知识缺陷
 * - 学习路径设计：自适应学习路线规划，优先高影响知识领域
 * - 学习效果评估：多维度评估指标量化知识获取和应用能力
 * - 学习策略优化：元学习能力，根据历史表现优化学习方法
 * - 无监督知识构建：自主知识图谱开发和能力提升
 */

import * as fs from 'fs';
import * as path from 'path';
import { duanPath } from './duan-paths.js';
import { atomicWriteJsonSync } from './atomic-write.js';

// ============ 类型定义 ============

export interface KnowledgeNode {
  id: string;
  domain: string;           // 知识领域：browser/desktop/code/system/web/creative/emotion
  topic: string;            // 具体主题
  level: number;            // 掌握程度 0-100
  confidence: number;       // 置信度 0-1
  lastUsed: number;         // 最后使用时间戳
  useCount: number;         // 使用次数
  failCount: number;        // 失败次数
  successRate: number;      // 成功率
  dependencies: string[];   // 依赖的知识节点ID
  relatedTools: string[];   // 相关工具
  examples: KnowledgeExample[]; // 知识示例
}

export interface KnowledgeExample {
  input: string;            // 用户输入示例
  approach: string;         // 解决方法
  outcome: 'success' | 'partial' | 'failure'; // 结果
  toolsUsed: string[];      // 使用的工具
  timestamp: number;
}

export interface LearningPath {
  id: string;
  targetDomain: string;
  priority: number;         // 1-10
  steps: LearningStep[];
  estimatedImpact: number;  // 预期影响 0-1
  status: 'planned' | 'active' | 'completed' | 'abandoned';
  createdAt: number;
  completedAt?: number;
  effectiveness?: number;   // 学习效果 0-1
}

export interface LearningStep {
  knowledgeId: string;
  action: 'practice' | 'observe' | 'analyze' | 'experiment' | 'review';
  description: string;
  status: 'pending' | 'in_progress' | 'completed';
  result?: string;
}

export interface LearningMetrics {
  totalKnowledge: number;
  averageLevel: number;
  coverageByDomain: Record<string, number>;
  recentGrowth: number;     // 最近增长率
  topGaps: KnowledgeGap[];
  learningVelocity: number; // 学习速度
  retentionRate: number;    // 知识保留率
}

export interface KnowledgeGap {
  domain: string;
  topic: string;
  severity: 'critical' | 'high' | 'medium' | 'low';
  impact: number;           // 对任务完成的影响 0-1
  frequency: number;        // 遇到频率
  suggestedAction: string;
}

export interface TaskOutcome {
  taskDescription: string;
  domain: string;
  success: boolean;
  toolsUsed: string[];
  failureReason?: string;
  duration: number;
  timestamp: number;
}

// ============ 自主学习引擎 ============

export class LearningEngine {
  private knowledgeGraph: Map<string, KnowledgeNode> = new Map();
  private learningPaths: LearningPath[] = [];
  private taskOutcomes: TaskOutcome[] = [];
  private dataDir: string;
  private maxOutcomes = 500;
  private maxPaths = 20;

  // 学习策略参数（可被元学习优化）
  private strategyParams = {
    gapThreshold: 30,         // 低于此分数视为缺口
    highImpactThreshold: 0.7, // 高影响阈值
    practiceWeight: 0.4,      // 实践权重
    observeWeight: 0.2,       // 观察权重
    analyzeWeight: 0.3,       // 分析权重
    reviewInterval: 5,        // 复习间隔（使用次数）
    decayRate: 0.01,          // 知识衰减率
  };

  constructor(dataDir?: string) {
    this.dataDir = dataDir || duanPath('learning');
    this.ensureDataDir();
    this.loadData();
    this.initializeCoreKnowledge();
  }

  // ============ 知识缺口识别 ============

  /** 通过任务结果分析知识缺口 */
  identifyGaps(): KnowledgeGap[] {
    const gaps: KnowledgeGap[] = [];

    // 1. 分析知识图谱中的低水平节点
    for (const node of this.knowledgeGraph.values()) {
      if (node.level < this.strategyParams.gapThreshold) {
        gaps.push({
          domain: node.domain,
          topic: node.topic,
          severity: this.classifySeverity(node.level, node.successRate),
          impact: this.calculateImpact(node),
          frequency: node.useCount,
          suggestedAction: this.suggestGapAction(node),
        });
      }
    }

    // 2. 分析近期失败模式
    const recentFailures = this.taskOutcomes
      .filter(o => !o.success && Date.now() - o.timestamp < 7 * 24 * 3600 * 1000);

    const failureDomains: Record<string, number> = {};
    for (const failure of recentFailures) {
      failureDomains[failure.domain] = (failureDomains[failure.domain] || 0) + 1;
    }

    for (const [domain, count] of Object.entries(failureDomains)) {
      if (count >= 3) {
        const existing = gaps.find(g => g.domain === domain);
        if (existing) {
          existing.frequency += count;
          existing.severity = 'critical';
        } else {
          gaps.push({
            domain,
            topic: `${domain}综合能力`,
            severity: 'critical',
            impact: Math.min(count / 10, 1),
            frequency: count,
            suggestedAction: `需要系统性提升${domain}领域知识和工具使用能力`,
          });
        }
      }
    }

    // 3. 检查缺失的知识领域
    const requiredDomains = ['browser', 'desktop', 'code', 'system', 'web', 'creative', 'emotion'];
    for (const domain of requiredDomains) {
      const domainNodes = [...this.knowledgeGraph.values()].filter(n => n.domain === domain);
      if (domainNodes.length === 0) {
        gaps.push({
          domain,
          topic: `${domain}领域基础`,
          severity: 'high',
          impact: 0.8,
          frequency: 0,
          suggestedAction: `建立${domain}领域的基础知识体系`,
        });
      }
    }

    return gaps.sort((a, b) => {
      const severityOrder = { critical: 0, high: 1, medium: 2, low: 3 };
      return (severityOrder[a.severity] - severityOrder[b.severity]) || (b.impact - a.impact);
    });
  }

  /** 记录任务结果，用于学习分析 */
  recordOutcome(outcome: TaskOutcome): void {
    this.taskOutcomes.push(outcome);
    if (this.taskOutcomes.length > this.maxOutcomes) {
      this.taskOutcomes = this.taskOutcomes.slice(-this.maxOutcomes);
    }

    // 更新相关知识节点
    const domain = outcome.domain;
    for (const tool of outcome.toolsUsed) {
      this.updateKnowledgeFromOutcome(domain, tool, outcome);
    }

    this.saveData();
  }

  // ============ 学习路径设计 ============

  /** 基于知识缺口设计学习路径 */
  designLearningPath(gaps?: KnowledgeGap[]): LearningPath | null {
    const targetGaps = gaps || this.identifyGaps();
    if (targetGaps.length === 0) return null;

    // 选择最高优先级的缺口
    const topGap = targetGaps[0];

    // 检查是否已有相同领域的学习路径
    const existingPath = this.learningPaths.find(
      p => p.targetDomain === topGap.domain && p.status === 'active'
    );
    if (existingPath) return existingPath;

    const path: LearningPath = {
      id: `lp_${Date.now()}`,
      targetDomain: topGap.domain,
      priority: this.calculatePathPriority(topGap),
      steps: this.generateLearningSteps(topGap),
      estimatedImpact: topGap.impact,
      status: 'planned',
      createdAt: Date.now(),
    };

    this.learningPaths.push(path);
    if (this.learningPaths.length > this.maxPaths) {
      this.learningPaths = this.learningPaths.slice(-this.maxPaths);
    }

    this.saveData();
    return path;
  }

  /** 生成学习步骤 */
  private generateLearningSteps(gap: KnowledgeGap): LearningStep[] {
    const steps: LearningStep[] = [];
    const knowledgeId = `${gap.domain}_${gap.topic}`.replace(/\s+/g, '_');

    // 确保知识节点存在
    if (!this.knowledgeGraph.has(knowledgeId)) {
      this.knowledgeGraph.set(knowledgeId, {
        id: knowledgeId,
        domain: gap.domain,
        topic: gap.topic,
        level: 0,
        confidence: 0,
        lastUsed: Date.now(),
        useCount: 0,
        failCount: 0,
        successRate: 0,
        dependencies: [],
        relatedTools: this.inferRelatedTools(gap.domain),
        examples: [],
      });
    }

    // Step 1: 分析当前能力和失败模式
    steps.push({
      knowledgeId,
      action: 'analyze',
      description: `分析${gap.domain}领域的失败模式和能力缺口`,
      status: 'pending',
    });

    // Step 2: 观察成功案例
    steps.push({
      knowledgeId,
      action: 'observe',
      description: `学习${gap.domain}领域的最佳实践和成功策略`,
      status: 'pending',
    });

    // Step 3: 实践练习
    steps.push({
      knowledgeId,
      action: 'practice',
      description: `在${gap.domain}领域进行针对性练习，提升${gap.topic}能力`,
      status: 'pending',
    });

    // Step 4: 实验新方法
    steps.push({
      knowledgeId,
      action: 'experiment',
      description: `尝试不同的${gap.domain}操作策略，找到最优方案`,
      status: 'pending',
    });

    // Step 5: 复习巩固
    steps.push({
      knowledgeId,
      action: 'review',
      description: `回顾${gap.domain}领域的学习成果，巩固知识`,
      status: 'pending',
    });

    return steps;
  }

  // ============ 学习效果评估 ============

  /** 获取学习指标 */
  getMetrics(): LearningMetrics {
    const nodes = [...this.knowledgeGraph.values()];
    const totalKnowledge = nodes.length;
    const averageLevel = totalKnowledge > 0
      ? nodes.reduce((sum, n) => sum + n.level, 0) / totalKnowledge : 0;

    // 按领域统计覆盖率
    const coverageByDomain: Record<string, number> = {};
    const domainNodes: Record<string, KnowledgeNode[]> = {};
    for (const node of nodes) {
      if (!domainNodes[node.domain]) domainNodes[node.domain] = [];
      domainNodes[node.domain].push(node);
    }
    for (const [domain, dns] of Object.entries(domainNodes)) {
      coverageByDomain[domain] = dns.reduce((s, n) => s + n.level, 0) / dns.length;
    }

    // 最近增长率
    const recentSuccesses = this.taskOutcomes.filter(
      o => o.success && Date.now() - o.timestamp < 24 * 3600 * 1000
    ).length;
    const recentTotal = this.taskOutcomes.filter(
      o => Date.now() - o.timestamp < 24 * 3600 * 1000
    ).length;
    const recentGrowth = recentTotal > 0 ? recentSuccesses / recentTotal : 0;

    // 学习速度（每周知识增长）
    const learningVelocity = this.calculateLearningVelocity();

    // 知识保留率
    const retentionRate = this.calculateRetentionRate();

    return {
      totalKnowledge,
      averageLevel,
      coverageByDomain,
      recentGrowth,
      topGaps: this.identifyGaps().slice(0, 5),
      learningVelocity,
      retentionRate,
    };
  }

  /** 评估学习路径的效果 */
  evaluatePathEffectiveness(pathId: string): number {
    const path = this.learningPaths.find(p => p.id === pathId);
    if (!path) return 0;

    const completedSteps = path.steps.filter(s => s.status === 'completed').length;
    const totalSteps = path.steps.length;
    if (totalSteps === 0) return 0;

    // 基础完成率
    let effectiveness = completedSteps / totalSteps;

    // 检查目标领域的知识水平提升
    const domainNodes = [...this.knowledgeGraph.values()]
      .filter(n => n.domain === path.targetDomain);
    if (domainNodes.length > 0) {
      const avgLevel = domainNodes.reduce((s, n) => s + n.level, 0) / domainNodes.length;
      effectiveness = effectiveness * 0.5 + (avgLevel / 100) * 0.5;
    }

    // 检查近期该领域的成功率
    const recentDomainOutcomes = this.taskOutcomes.filter(
      o => o.domain === path.targetDomain && Date.now() - o.timestamp < 7 * 24 * 3600 * 1000
    );
    if (recentDomainOutcomes.length > 0) {
      const successRate = recentDomainOutcomes.filter(o => o.success).length / recentDomainOutcomes.length;
      effectiveness = effectiveness * 0.7 + successRate * 0.3;
    }

    path.effectiveness = effectiveness;
    return effectiveness;
  }

  // ============ 学习策略优化（元学习） ============

  /** 基于历史表现优化学习策略 */
  optimizeStrategy(): void {
    const completedPaths = this.learningPaths.filter(p => p.status === 'completed' && p.effectiveness !== undefined);
    if (completedPaths.length < 3) return; // 数据不足

    // 分析哪些学习行动最有效
    const actionEffectiveness: Record<string, number[]> = {};
    for (const path of completedPaths) {
      for (const step of path.steps) {
        if (step.status === 'completed' && path.effectiveness) {
          if (!actionEffectiveness[step.action]) actionEffectiveness[step.action] = [];
          actionEffectiveness[step.action].push(path.effectiveness);
        }
      }
    }

    // 调整权重
    const avgEffectiveness: Record<string, number> = {};
    for (const [action, scores] of Object.entries(actionEffectiveness)) {
      avgEffectiveness[action] = scores.reduce((s, v) => s + v, 0) / scores.length;
    }

    const totalEffect = Object.values(avgEffectiveness).reduce((s, v) => s + v, 0);
    if (totalEffect > 0) {
      this.strategyParams.practiceWeight = (avgEffectiveness['practice'] || 0.4) / totalEffect * 2;
      this.strategyParams.observeWeight = (avgEffectiveness['observe'] || 0.2) / totalEffect * 2;
      this.strategyParams.analyzeWeight = (avgEffectiveness['analyze'] || 0.3) / totalEffect * 2;
    }

    // 调整缺口阈值
    const highEffectPaths = completedPaths.filter(p => (p.effectiveness || 0) > 0.7);
    if (highEffectPaths.length > completedPaths.length * 0.5) {
      // 学习效果好的时候，提高标准
      this.strategyParams.gapThreshold = Math.min(40, this.strategyParams.gapThreshold + 2);
    } else {
      // 学习效果差的时候，降低标准，关注更基础的缺口
      this.strategyParams.gapThreshold = Math.max(20, this.strategyParams.gapThreshold - 2);
    }

    this.saveData();
  }

  // ============ 无监督知识构建 ============

  /** 从任务经验中自动构建知识 */
  buildKnowledgeFromExperience(): void {
    // 1. 聚类相似任务
    const clusters = this.clusterSimilarTasks();

    // 2. 从每个聚类中提取知识模式
    for (const cluster of clusters) {
      if (cluster.length < 2) continue;

      const successes = cluster.filter(o => o.success);
      const failures = cluster.filter(o => !o.success);

      if (successes.length > 0) {
        // 提取成功模式
        const commonTools = this.findCommonTools(successes);
        const domain = successes[0].domain;

        const knowledgeId = `${domain}_pattern_${Date.now()}`;
        const existingNode = this.findSimilarKnowledge(domain, commonTools);

        if (existingNode) {
          // 更新现有知识节点
          existingNode.level = Math.min(100, existingNode.level + 5);
          existingNode.successRate = successes.length / cluster.length;
          existingNode.examples.push({
            input: successes[0].taskDescription,
            approach: `使用 ${commonTools.join(' → ')} 完成`,
            outcome: 'success',
            toolsUsed: commonTools,
            timestamp: Date.now(),
          });
          if (existingNode.examples.length > 10) {
            existingNode.examples = existingNode.examples.slice(-10);
          }
        } else {
          // 创建新知识节点
          this.knowledgeGraph.set(knowledgeId, {
            id: knowledgeId,
            domain,
            topic: `${domain}操作模式: ${commonTools.join('→')}`,
            level: Math.round(successes.length / cluster.length * 60),
            confidence: Math.min(successes.length / 5, 1),
            lastUsed: Date.now(),
            useCount: successes.length,
            failCount: failures.length,
            successRate: successes.length / cluster.length,
            dependencies: [],
            relatedTools: commonTools,
            examples: successes.slice(0, 3).map(s => ({
              input: s.taskDescription,
              approach: `使用 ${commonTools.join(' → ')} 完成`,
              outcome: 'success' as const,
              toolsUsed: commonTools,
              timestamp: s.timestamp,
            })),
          });
        }
      }
    }

    this.saveData();
  }

  /** 获取特定领域的知识建议 */
  getKnowledgeAdvice(domain: string, _taskDescription: string): string[] {
    const advice: string[] = [];

    // 查找相关领域知识
    const domainNodes = [...this.knowledgeGraph.values()]
      .filter(n => n.domain === domain)
      .sort((a, b) => b.successRate - a.successRate);

    for (const node of domainNodes) {
      if (node.successRate > 0.7 && node.examples.length > 0) {
        const bestExample = node.examples[0];
        advice.push(`[${node.topic}] 成功率${Math.round(node.successRate * 100)}%: ${bestExample.approach}`);
      }
    }

    // 查找相关工具建议
    const relevantTools = new Set<string>();
    for (const node of domainNodes) {
      if (node.level > 50) {
        for (const tool of node.relatedTools) {
          relevantTools.add(tool);
        }
      }
    }
    if (relevantTools.size > 0) {
      advice.push(`推荐工具: ${[...relevantTools].join(', ')}`);
    }

    return advice;
  }

  // ============ 私有方法 ============

  private initializeCoreKnowledge(): void {
    const coreKnowledge: Array<{ domain: string; topic: string; tools: string[] }> = [
      { domain: 'browser', topic: '网页导航', tools: ['browser_operate'] },
      { domain: 'browser', topic: '页面交互', tools: ['browser_operate'] },
      { domain: 'browser', topic: '数据提取', tools: ['browser_operate', 'extract'] },
      { domain: 'desktop', topic: '应用操控', tools: ['desktop_open', 'screen_click', 'screen_type'] },
      { domain: 'desktop', topic: '屏幕操作', tools: ['screen_capture', 'visual_analyze'] },
      { domain: 'code', topic: '代码执行', tools: ['code_execute', 'shell_execute'] },
      { domain: 'code', topic: '文件操作', tools: ['file_read', 'file_write'] },
      { domain: 'web', topic: '网络搜索', tools: ['web_search', 'web_fetch'] },
      { domain: 'creative', topic: '内容生成', tools: ['code_execute', 'file_write'] },
      { domain: 'emotion', topic: '情感理解', tools: [] },
    ];

    for (const k of coreKnowledge) {
      const id = `${k.domain}_${k.topic}`.replace(/\s+/g, '_');
      if (!this.knowledgeGraph.has(id)) {
        this.knowledgeGraph.set(id, {
          id,
          domain: k.domain,
          topic: k.topic,
          level: 30, // 初始基础水平
          confidence: 0.3,
          lastUsed: Date.now(),
          useCount: 0,
          failCount: 0,
          successRate: 0.5,
          dependencies: [],
          relatedTools: k.tools,
          examples: [],
        });
      }
    }
  }

  private updateKnowledgeFromOutcome(domain: string, tool: string, outcome: TaskOutcome): void {
    // 找到或创建相关知识点
    const relatedNodes = [...this.knowledgeGraph.values()]
      .filter(n => n.domain === domain && n.relatedTools.includes(tool));

    if (relatedNodes.length === 0) {
      // 创建新知识点
      const id = `${domain}_${tool}_${Date.now()}`;
      this.knowledgeGraph.set(id, {
        id,
        domain,
        topic: `${tool}操作`,
        level: outcome.success ? 40 : 10,
        confidence: 0.2,
        lastUsed: Date.now(),
        useCount: 1,
        failCount: outcome.success ? 0 : 1,
        successRate: outcome.success ? 1 : 0,
        dependencies: [],
        relatedTools: [tool],
        examples: [{
          input: outcome.taskDescription,
          approach: `使用${tool}`,
          outcome: outcome.success ? 'success' : 'failure',
          toolsUsed: [tool],
          timestamp: Date.now(),
        }],
      });
    } else {
      for (const node of relatedNodes) {
        node.lastUsed = Date.now();
        node.useCount++;
        if (outcome.success) {
          node.level = Math.min(100, node.level + 3);
          node.successRate = (node.successRate * (node.useCount - 1) + 1) / node.useCount;
        } else {
          node.failCount++;
          node.level = Math.max(0, node.level - 2);
          node.successRate = (node.successRate * (node.useCount - 1)) / node.useCount;
          if (outcome.failureReason) {
            node.examples.push({
              input: outcome.taskDescription,
              approach: `使用${tool}`,
              outcome: 'failure',
              toolsUsed: [tool],
              timestamp: Date.now(),
            });
            if (node.examples.length > 10) node.examples = node.examples.slice(-10);
          }
        }
        node.confidence = Math.min(1, node.useCount / 10);
      }
    }
  }

  private classifySeverity(level: number, successRate: number): 'critical' | 'high' | 'medium' | 'low' {
    if (level < 10 && successRate < 0.2) return 'critical';
    if (level < 20 || successRate < 0.3) return 'high';
    if (level < 40 || successRate < 0.5) return 'medium';
    return 'low';
  }

  private calculateImpact(node: KnowledgeNode): number {
    const usageImpact = Math.min(node.useCount / 20, 1);
    const failureImpact = Math.min(node.failCount / 5, 1);
    const domainBreadth = node.relatedTools.length / 5;
    return (usageImpact * 0.4 + failureImpact * 0.4 + domainBreadth * 0.2);
  }

  private suggestGapAction(node: KnowledgeNode): string {
    if (node.failCount > node.useCount * 0.5) {
      return `需要学习${node.topic}的正确使用方法，当前失败率过高`;
    }
    if (node.useCount === 0) {
      return `从未使用过${node.topic}，需要建立基础知识`;
    }
    if (node.level < 20) {
      return `${node.topic}能力严重不足，需要系统性学习`;
    }
    return `提升${node.topic}能力，从${node.level}分提升到60分以上`;
  }

  private calculatePathPriority(gap: KnowledgeGap): number {
    const severityScores = { critical: 10, high: 7, medium: 4, low: 2 };
    return Math.round(severityScores[gap.severity] * gap.impact);
  }

  private inferRelatedTools(domain: string): string[] {
    const toolMap: Record<string, string[]> = {
      browser: ['browser_operate', 'web_search', 'web_fetch'],
      desktop: ['desktop_open', 'screen_click', 'screen_type', 'screen_capture', 'visual_analyze'],
      code: ['code_execute', 'shell_execute', 'file_read', 'file_write'],
      system: ['shell_execute', 'list_directory', 'search_files'],
      web: ['web_search', 'web_fetch', 'http_request'],
      creative: ['code_execute', 'file_write', 'browser_operate'],
      emotion: [],
    };
    return toolMap[domain] || [];
  }

  private clusterSimilarTasks(): TaskOutcome[][] {
    const clusters: TaskOutcome[][] = [];
    const used = new Set<number>();

    for (let i = 0; i < this.taskOutcomes.length; i++) {
      if (used.has(i)) continue;
      const cluster: TaskOutcome[] = [this.taskOutcomes[i]];
      used.add(i);

      for (let j = i + 1; j < this.taskOutcomes.length; j++) {
        if (used.has(j)) continue;
        if (this.taskOutcomes[i].domain === this.taskOutcomes[j].domain &&
            this.areSimilarTools(this.taskOutcomes[i].toolsUsed, this.taskOutcomes[j].toolsUsed)) {
          cluster.push(this.taskOutcomes[j]);
          used.add(j);
        }
      }

      if (cluster.length >= 2) clusters.push(cluster);
    }

    return clusters;
  }

  private areSimilarTools(a: string[], b: string[]): boolean {
    const setA = new Set(a);
    const setB = new Set(b);
    const intersection = [...setA].filter(t => setB.has(t));
    return intersection.length >= Math.min(setA.size, setB.size) * 0.5;
  }

  private findCommonTools(outcomes: TaskOutcome[]): string[] {
    const toolCounts: Record<string, number> = {};
    for (const o of outcomes) {
      for (const t of o.toolsUsed) {
        toolCounts[t] = (toolCounts[t] || 0) + 1;
      }
    }
    return Object.entries(toolCounts)
      .filter(([_, count]) => count >= outcomes.length * 0.5)
      .sort((a, b) => b[1] - a[1])
      .map(([tool]) => tool);
  }

  private findSimilarKnowledge(domain: string, tools: string[]): KnowledgeNode | null {
    for (const node of this.knowledgeGraph.values()) {
      if (node.domain !== domain) continue;
      const overlap = tools.filter(t => node.relatedTools.includes(t));
      if (overlap.length >= tools.length * 0.5) return node;
    }
    return null;
  }

  private calculateLearningVelocity(): number {
    const weekAgo = Date.now() - 7 * 24 * 3600 * 1000;
    const recentNodes = [...this.knowledgeGraph.values()]
      .filter(n => n.lastUsed > weekAgo && n.level > 30);
    return recentNodes.length;
  }

  private calculateRetentionRate(): number {
    const nodes = [...this.knowledgeGraph.values()].filter(n => n.useCount > 3);
    if (nodes.length === 0) return 0;
    const retained = nodes.filter(n => n.successRate > 0.5).length;
    return retained / nodes.length;
  }

  // ============ 持久化 ============

  private ensureDataDir(): void {
    try {
      fs.mkdirSync(this.dataDir, { recursive: true });
    } catch {}
  }

  private loadData(): void {
    try {
      const graphPath = path.join(this.dataDir, 'knowledge-graph.json');
      if (fs.existsSync(graphPath)) {
        const data = JSON.parse(fs.readFileSync(graphPath, 'utf-8'));
        for (const node of data) {
          this.knowledgeGraph.set(node.id, node);
        }
      }
      const pathsPath = path.join(this.dataDir, 'learning-paths.json');
      if (fs.existsSync(pathsPath)) {
        this.learningPaths = JSON.parse(fs.readFileSync(pathsPath, 'utf-8'));
      }
      const outcomesPath = path.join(this.dataDir, 'task-outcomes.json');
      if (fs.existsSync(outcomesPath)) {
        this.taskOutcomes = JSON.parse(fs.readFileSync(outcomesPath, 'utf-8'));
      }
    } catch {}
  }

  private saveData(): void {
    try {
      this.ensureDataDir();
      atomicWriteJsonSync(
        path.join(this.dataDir, 'knowledge-graph.json'),
        [...this.knowledgeGraph.values()]
      );
      atomicWriteJsonSync(
        path.join(this.dataDir, 'learning-paths.json'),
        this.learningPaths
      );
      atomicWriteJsonSync(
        path.join(this.dataDir, 'task-outcomes.json'),
        this.taskOutcomes
      );
    } catch {}
  }

  /** 获取知识图谱摘要（用于注入系统提示） */
  getKnowledgeSummary(domain?: string): string {
    const nodes = domain
      ? [...this.knowledgeGraph.values()].filter(n => n.domain === domain)
      : [...this.knowledgeGraph.values()];

    if (nodes.length === 0) return '';

    const highConfidence = nodes.filter(n => n.confidence > 0.5 && n.successRate > 0.6);
    if (highConfidence.length === 0) return '';

    return highConfidence
      .sort((a, b) => b.successRate - a.successRate)
      .slice(0, 5)
      .map(n => `• ${n.topic}: 成功率${Math.round(n.successRate * 100)}%，推荐工具: ${n.relatedTools.join(', ')}`)
      .join('\n');
  }
}
