/**
 * 自主思考与决策引擎
 * 实现类似贾维斯的高度自主决策与执行能力
 * 包含独立思考机制、主动分析、方案制定和自主执行
 */

/** 思考模式 */
export type ThinkingMode = 'reactive' | 'proactive' | 'strategic' | 'creative';

/** 问题分析结果 */
export interface ProblemAnalysis {
  problem: string;
  type: 'factual' | 'analytical' | 'creative' | 'procedural' | 'strategic';
  complexity: 'simple' | 'moderate' | 'complex' | 'wicked';
  keyEntities: string[];
  constraints: string[];
  assumptions: string[];
  relatedProblems: string[];
  requiredCapabilities: string[];
}

/** 解决方案 */
export interface Solution {
  id: string;
  description: string;
  steps: SolutionStep[];
  estimatedSuccess: number;  // 0-1
  estimatedTime: string;
  requiredTools: string[];
  risks: string[];
  fallbackPlan: string;
}

/** 解决方案步骤 */
export interface SolutionStep {
  id: string;
  order: number;
  action: string;
  tool?: string;
  toolInput?: Record<string, unknown>;
  expectedOutput: string;
  verification: string;
  status: 'pending' | 'executing' | 'completed' | 'failed';
  result?: unknown;
}

/** 执行计划 */
export interface ExecutionPlan {
  id: string;
  problem: string;
  analysis: ProblemAnalysis;
  solutions: Solution[];
  selectedSolution: string;   // 选中的方案ID
  status: 'planning' | 'executing' | 'verifying' | 'completed' | 'failed';
  createdAt: number;
  completedAt?: number;
  executionLog: string[];
}

/** 自主决策结果 */
export interface AutonomousDecision {
  id: string;
  timestamp: number;
  trigger: string;
  thinking: string[];          // 思考过程
  analysis: ProblemAnalysis;
  plan: ExecutionPlan;
  confidence: number;
  mode: ThinkingMode;
}

export class AutonomousThinkingEngine {
  private decisionHistory: AutonomousDecision[] = [];
  private activePlans: Map<string, ExecutionPlan> = new Map();
  private completedPlans: ExecutionPlan[] = [];
  private thinkingMode: ThinkingMode = 'reactive';

  /** 分析问题 */
  analyzeProblem(problem: string): ProblemAnalysis {
    // 识别问题类型
    let type: ProblemAnalysis['type'] = 'factual';
    if (/如何|怎么|步骤|流程|方法/.test(problem)) type = 'procedural';
    else if (/分析|评估|比较|为什么|原因/.test(problem)) type = 'analytical';
    else if (/设计|创意|构思|想象|发明/.test(problem)) type = 'creative';
    else if (/规划|战略|方向|路线|架构/.test(problem)) type = 'strategic';

    // 评估复杂度
    let complexity: ProblemAnalysis['complexity'] = 'simple';
    if (problem.length > 100 || /多个|综合|系统|架构/.test(problem)) complexity = 'moderate';
    if (problem.length > 300 || /复杂|跨领域|多维度|全方位/.test(problem)) complexity = 'complex';
    if (/无法解决|矛盾|两难|悖论/.test(problem)) complexity = 'wicked';

    // 提取关键实体
    const keyEntities = this.extractEntities(problem);

    // 识别约束
    const constraints = this.identifyConstraints(problem);

    // 识别假设
    const assumptions = this.identifyAssumptions(problem);

    // 识别相关问题
    const relatedProblems = this.identifyRelatedProblems(problem, type);

    // 识别所需能力
    const requiredCapabilities = this.identifyRequiredCapabilities(problem, type);

    return {
      problem,
      type,
      complexity,
      keyEntities,
      constraints,
      assumptions,
      relatedProblems,
      requiredCapabilities,
    };
  }

  /** 生成解决方案 */
  generateSolutions(analysis: ProblemAnalysis): Solution[] {
    const solutions: Solution[] = [];
    let solId = 1;

    // 方案1：直接执行
    const directSteps = this.generateDirectSteps(analysis);
    solutions.push({
      id: `sol_${solId++}`,
      description: '直接执行方案：按步骤逐一解决问题',
      steps: directSteps,
      estimatedSuccess: 0.8,
      estimatedTime: (() => {
        if (analysis.complexity === 'simple') return '1-2分钟';
        if (analysis.complexity === 'moderate') return '5-10分钟';
        return '15-30分钟';
      })(),
      requiredTools: this.inferRequiredTools(analysis),
      risks: ['可能遇到未预见的障碍'],
      fallbackPlan: '切换到分解执行方案',
    });

    // 方案2：分解执行
    if (analysis.complexity !== 'simple') {
      const decomposedSteps = this.generateDecomposedSteps(analysis);
      solutions.push({
        id: `sol_${solId++}`,
        description: '分解执行方案：将问题拆分为子问题分别解决',
        steps: decomposedSteps,
        estimatedSuccess: 0.85,
        estimatedTime: analysis.complexity === 'moderate' ? '8-15分钟' : '20-45分钟',
        requiredTools: this.inferRequiredTools(analysis),
        risks: ['子问题间可能存在依赖', '分解可能不完整'],
        fallbackPlan: '合并子问题重新规划',
      });
    }

    // 方案3：创造性解决（仅复杂问题）
    if (analysis.complexity === 'complex' || analysis.complexity === 'wicked') {
      solutions.push({
        id: `sol_${solId++}`,
        description: '创新方案：从不同角度寻找突破性解决方案',
        steps: this.generateCreativeSteps(analysis),
        estimatedSuccess: 0.6,
        estimatedTime: '30-60分钟',
        requiredTools: [...this.inferRequiredTools(analysis), 'creativity_engine'],
        risks: ['创新方案可能不可行', '需要更多验证'],
        fallbackPlan: '回退到分解执行方案',
      });
    }

    return solutions;
  }

  /** 自主决策 */
  makeDecision(problem: string): AutonomousDecision {
    // 分析问题
    const analysis = this.analyzeProblem(problem);

    // 思考过程
    const thinking = this.thinkThrough(analysis);

    // 生成方案
    const solutions = this.generateSolutions(analysis);

    // 选择最优方案
    const selectedSolution = this.selectBestSolution(solutions);

    // 创建执行计划
    const plan: ExecutionPlan = {
      id: `plan_${Date.now()}`,
      problem,
      analysis,
      solutions,
      selectedSolution,
      status: 'planning',
      createdAt: Date.now(),
      executionLog: [],
    };

    // 确定思考模式
    const mode = this.determineThinkingMode(analysis);

    const decision: AutonomousDecision = {
      id: `dec_${Date.now()}`,
      timestamp: Date.now(),
      trigger: problem,
      thinking,
      analysis,
      plan,
      confidence: this.calculateConfidence(analysis, selectedSolution, solutions),
      mode,
    };

    this.activePlans.set(plan.id, plan);
    this.decisionHistory.push(decision);

    return decision;
  }

  /** 思考过程 */
  private thinkThrough(analysis: ProblemAnalysis): string[] {
    const thoughts: string[] = [];
    thoughts.push(`识别到${analysis.type}类型问题，复杂度为${analysis.complexity}`);
    if (analysis.keyEntities.length > 0) {
      thoughts.push(`关键实体: ${analysis.keyEntities.join(', ')}`);
    }
    if (analysis.constraints.length > 0) {
      thoughts.push(`约束条件: ${analysis.constraints.join('; ')}`);
    }
    thoughts.push(`需要${analysis.requiredCapabilities.join('、')}等能力`);
    thoughts.push(`推荐${analysis.complexity === 'simple' ? '直接执行' : '分解执行'}策略`);
    return thoughts;
  }

  /** 选择最优方案 */
  private selectBestSolution(solutions: Solution[]): string {
    if (solutions.length === 0) return '';
    // 按成功率排序，选择最高的
    const sorted = [...solutions].sort((a, b) => b.estimatedSuccess - a.estimatedSuccess);
    return sorted[0].id;
  }

  /** 计算置信度 */
  private calculateConfidence(analysis: ProblemAnalysis, selectedId: string, solutions: Solution[]): number {
    const selected = solutions.find(s => s.id === selectedId);
    if (!selected) return 0.3;
    let confidence = selected.estimatedSuccess;
    if (analysis.complexity === 'simple') confidence += 0.1;
    if (analysis.complexity === 'wicked') confidence -= 0.2;
    return Math.max(0.1, Math.min(0.95, confidence));
  }

  /** 确定思考模式 */
  private determineThinkingMode(analysis: ProblemAnalysis): ThinkingMode {
    if (analysis.type === 'creative') return 'creative';
    if (analysis.type === 'strategic') return 'strategic';
    if (analysis.complexity === 'complex' || analysis.complexity === 'wicked') return 'proactive';
    return 'reactive';
  }

  // ========== 辅助方法 ==========

  /** 实体类型后缀（可配置规则） */
  private readonly entitySuffixes = ['系统', '引擎', '模块', '框架', '平台', '工具', '服务'];

  /** 约束识别规则表：关键词正则 → 标签（可配置） */
  private readonly constraintRules: Array<{ pattern: RegExp; label: string }> = [
    { pattern: /必须|需要|要求|不能|禁止/, label: '存在明确约束条件' },
    { pattern: /预算|时间|资源|限制/, label: '存在资源约束' },
    { pattern: /安全|合规|隐私/, label: '存在安全合规约束' },
  ];

  /** 假设识别规则表：关键词正则 → 标签（可配置） */
  private readonly assumptionRules: Array<{ pattern: RegExp; label: string }> = [
    { pattern: /假设|默认|前提/, label: '存在显式假设' },
  ];

  private extractEntities(text: string): string[] {
    const entities: string[] = [];
    // 基于可配置后缀规则提取实体
    const pattern = new RegExp(`[\\u4e00-\\u9fa5]{2,6}(${this.entitySuffixes.join('|')})`, 'g');
    let m;
    while ((m = pattern.exec(text)) !== null) entities.push(m[0]);
    return [...new Set(entities)];
  }

  private identifyConstraints(text: string): string[] {
    const constraints: string[] = [];
    for (const { pattern, label } of this.constraintRules) {
      if (pattern.test(text)) constraints.push(label);
    }
    return constraints;
  }

  private identifyAssumptions(text: string): string[] {
    const assumptions: string[] = [];
    for (const { pattern, label } of this.assumptionRules) {
      if (pattern.test(text)) assumptions.push(label);
    }
    assumptions.push('用户需求描述准确完整');
    return assumptions;
  }

  private identifyRelatedProblems(text: string, type: ProblemAnalysis['type']): string[] {
    const related: string[] = [];

    if (type === 'procedural') related.push('执行顺序优化');
    if (type === 'analytical') related.push('数据质量验证');
    if (type === 'creative') related.push('可行性验证');
    return related;
  }

  private identifyRequiredCapabilities(text: string, type: ProblemAnalysis['type']): string[] {
    const caps: string[] = ['nlu', 'reasoning'];
    if (/代码|编程|开发/.test(text)) caps.push('coding');
    if (/搜索|查找|研究/.test(text)) caps.push('web_search');
    if (/分析|数据|统计/.test(text)) caps.push('data_analysis');
    if (/设计|UI|界面/.test(text)) caps.push('design');
    if (type === 'creative') caps.push('creativity');
    return [...new Set(caps)];
  }

  private generateDirectSteps(_analysis: ProblemAnalysis): SolutionStep[] {
    return [
      { id: 'step_1', order: 1, action: '理解并确认问题', expectedOutput: '问题确认', verification: '与用户确认理解正确', status: 'pending' },
      { id: 'step_2', order: 2, action: '收集相关信息', expectedOutput: '信息收集完成', verification: '信息充分且准确', status: 'pending' },
      { id: 'step_3', order: 3, action: '制定解决方案', expectedOutput: '方案制定完成', verification: '方案可行且完整', status: 'pending' },
      { id: 'step_4', order: 4, action: '执行解决方案', expectedOutput: '执行完成', verification: '结果符合预期', status: 'pending' },
      { id: 'step_5', order: 5, action: '验证结果并反馈', expectedOutput: '验证通过', verification: '用户确认满意', status: 'pending' },
    ];
  }

  private generateDecomposedSteps(_analysis: ProblemAnalysis): SolutionStep[] {
    return [
      { id: 'step_1', order: 1, action: '将问题分解为子问题', expectedOutput: '子问题列表', verification: 'MECE原则检查', status: 'pending' },
      { id: 'step_2', order: 2, action: '分析子问题依赖关系', expectedOutput: '依赖图', verification: '无循环依赖', status: 'pending' },
      { id: 'step_3', order: 3, action: '按依赖顺序解决子问题', expectedOutput: '子问题解决方案', verification: '每个子问题独立验证', status: 'pending' },
      { id: 'step_4', order: 4, action: '整合子问题解决方案', expectedOutput: '整体方案', verification: '方案完整且一致', status: 'pending' },
      { id: 'step_5', order: 5, action: '端到端验证', expectedOutput: '验证报告', verification: '所有场景通过', status: 'pending' },
    ];
  }

  private generateCreativeSteps(_analysis: ProblemAnalysis): SolutionStep[] {
    return [
      { id: 'step_1', order: 1, action: '从多个角度重新定义问题', expectedOutput: '问题重构', verification: '新视角有价值', status: 'pending' },
      { id: 'step_2', order: 2, action: '类比推理寻找灵感', expectedOutput: '类比方案', verification: '类比合理', status: 'pending' },
      { id: 'step_3', order: 3, action: '生成创新方案', expectedOutput: '创新方案', verification: '方案新颖且可行', status: 'pending' },
      { id: 'step_4', order: 4, action: '验证创新方案', expectedOutput: '验证结果', verification: '实际可行', status: 'pending' },
    ];
  }

  private inferRequiredTools(analysis: ProblemAnalysis): string[] {
    return analysis.requiredCapabilities
      .filter(c => ['coding', 'web_search', 'data_analysis'].includes(c))
      .map(c => {
        if (c === 'coding') return 'code_execute';
        if (c === 'web_search') return 'web_search';
        return 'analyze_data';
      });
  }

  /** 获取决策历史 */
  getDecisionHistory(): AutonomousDecision[] { return this.decisionHistory; }
  /** 获取活跃计划 */
  getActivePlans(): ExecutionPlan[] { return [...this.activePlans.values()]; }
  /** 获取思考模式 */
  getThinkingMode(): ThinkingMode { return this.thinkingMode; }
  /** 设置思考模式 */
  setThinkingMode(mode: ThinkingMode): void { this.thinkingMode = mode; }

  /** 类似CLAUDE CODE的链式推理 */
  chainOfThought(problem: string): { steps: string[]; conclusion: string; confidence: number } {
    const steps: string[] = [];

    // 步骤1：问题分解
    steps.push('让我仔细分析这个问题...');
    const analysis = this.analyzeProblem(problem);
    steps.push(`这是一个${analysis.type}类型的问题，复杂度为${analysis.complexity}。`);

    // 步骤2：信息收集
    steps.push('需要考虑以下关键因素：');
    analysis.keyEntities.forEach(e => steps.push(`- ${e}`));

    // 步骤3：推理过程
    steps.push('基于以上信息，我的推理如下：');
    if (analysis.constraints.length > 0) {
      steps.push(`在约束条件${analysis.constraints.join('、')}下，`);
    }

    // 步骤4：方案评估
    const solutions = this.generateSolutions(analysis);
    steps.push(`我生成了${solutions.length}个可行方案，其中最优方案的成功率估计为${(solutions[0]?.estimatedSuccess * 100 || 0).toFixed(0)}%。`);

    // 步骤5：结论
    const conclusion = `针对"${problem}"，推荐采用${solutions[0]?.description || '直接执行'}的方式处理。`;
    steps.push(conclusion);

    return {
      steps,
      conclusion,
      confidence: solutions[0]?.estimatedSuccess || 0.5,
    };
  }

  /** 类似CURSOR的上下文感知执行 */
  contextAwareExecute(task: string, recentActions: { action: string; result: string }[]): {
    suggestedAction: string;
    reasoning: string;
    relatedContext: string[];
  } {
    // 分析最近的操作
    const recentPatterns = recentActions.slice(-5).map(a => a.action);
    const relatedContext: string[] = [];

    // 检测操作模式
    if (recentPatterns.filter(a => a.includes('code')).length > 2) {
      relatedContext.push('用户正在进行编码工作');
    }
    if (recentPatterns.filter(a => a.includes('debug') || a.includes('fix')).length > 1) {
      relatedContext.push('用户正在调试问题');
    }
    if (recentPatterns.filter(a => a.includes('search') || a.includes('research')).length > 1) {
      relatedContext.push('用户正在研究阶段');
    }

    // 基于上下文建议下一步
    let suggestedAction = '执行当前任务';
    let reasoning = '基于当前任务直接执行';

    if (relatedContext.includes('用户正在进行编码工作')) {
      suggestedAction = '提供代码补全或优化建议';
      reasoning = '检测到编码模式，主动提供代码辅助';
    } else if (relatedContext.includes('用户正在调试问题')) {
      suggestedAction = '分析错误并提供修复方案';
      reasoning = '检测到调试模式，主动提供错误分析';
    } else if (relatedContext.includes('用户正在研究阶段')) {
      suggestedAction = '整理研究信息并生成摘要';
      reasoning = '检测到研究模式，主动整理信息';
    }

    return { suggestedAction, reasoning, relatedContext };
  }
}
