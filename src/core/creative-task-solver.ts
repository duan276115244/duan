/**
 * 创意任务解决框架
 * 提供复杂需求理解、任务分解、创意方案生成与评估、动态策略调整等核心能力
 */

// ==================== 类型定义 ====================

/** 需求分析结果 */
export interface RequirementAnalysis {
  /** 核心意图 */
  coreIntent: string;
  /** 隐含需求列表 */
  implicitNeeds: string[];
  /** 约束条件列表 */
  constraints: string[];
  /** 成功标准列表 */
  successCriteria: string[];
  /** 风险因素列表 */
  riskFactors: string[];
  /** 需求清晰度评分 (0-1) */
  clarity: number;
}

/** 原子操作 */
export interface AtomicAction {
  /** 操作描述 */
  description: string;
  /** 建议工具 */
  suggestedTool: string;
  /** 预计耗时（分钟） */
  estimatedMinutes: number;
}

/** 子任务 */
export interface SubTask {
  /** 子任务名称 */
  name: string;
  /** 子任务描述 */
  description: string;
  /** 原子操作列表 */
  actions: AtomicAction[];
  /** 依赖的子任务索引 */
  dependencies: number[];
}

/** 任务分解结果 */
export interface TaskDecomposition {
  /** 主任务描述 */
  mainTask: string;
  /** 子任务列表 */
  subTasks: SubTask[];
  /** 分解深度 (1-3) */
  depth: number;
  /** 执行顺序（子任务索引序列） */
  executionOrder: number[];
}

/** 候选方案 */
export interface Solution {
  /** 方案名称 */
  name: string;
  /** 方案描述 */
  description: string;
  /** 实施步骤 */
  steps: string[];
  /** 前置条件 */
  prerequisites: string[];
}

/** 方案评估结果 */
export interface SolutionEvaluation {
  /** 方案名称 */
  solutionName: string;
  /** 可行性评分 (0-100) */
  feasibility: number;
  /** 效率评分 (0-100) */
  efficiency: number;
  /** 风险评分 (0-100，越低越好) */
  risk: number;
  /** 创新性评分 (0-100) */
  innovation: number;
  /** 鲁棒性评分 (0-100) */
  robustness: number;
  /** 综合评分 (0-100) */
  overallScore: number;
  /** 评估说明 */
  remarks: string;
}

/** 策略调整结果 */
export interface StrategyAdjustment {
  /** 原策略 */
  previousStrategy: string;
  /** 新策略 */
  newStrategy: string;
  /** 调整原因 */
  reason: string;
  /** 调整置信度 (0-1) */
  confidence: number;
  /** 建议行动列表 */
  suggestedActions: string[];
}

/** 开放式问题解决方案 */
export interface OpenEndedSolution {
  /** 问题陈述 */
  problem: string;
  /** 多角度分析 */
  perspectives: {
    /** 角度名称 */
    angle: string;
    /** 该角度下的分析 */
    analysis: string;
    /** 该角度下的建议 */
    suggestion: string;
  }[];
  /** 综合建议 */
  overallSuggestion: string;
  /** 不确定性说明 */
  uncertaintyNote: string;
}

/** 任务执行状态 */
type ExecutionStatus = 'pending' | 'running' | 'completed' | 'failed' | 'skipped';

/** 执行步骤记录 */
interface ExecutionRecord {
  /** 子任务索引 */
  subTaskIndex: number;
  /** 执行状态 */
  status: ExecutionStatus;
  /** 执行结果 */
  result: string;
}

// ==================== 核心类 ====================

export class CreativeTaskSolver {
  /** 执行历史记录 */
  private executionHistory: ExecutionRecord[] = [];
  /** 当前策略 */
  private currentStrategy: string = '默认策略';
  /** 已学到的经验 */
  private learnedExperiences: string[] = [];

  // ---------- 需求分析 ----------

  /** 解析模糊/多层级/矛盾的需求 */
  analyzeRequirement(input: string): RequirementAnalysis {
    const sentences = input.split(/[。！？；\n.!?;]/).filter(s => s.trim().length > 0);
    const keywords = this.extractKeywords(input);

    // 识别核心意图：取最核心的关键词组合
    const coreIntent = this.inferCoreIntent(sentences, keywords);

    // 推导隐含需求
    const implicitNeeds = this.inferImplicitNeeds(coreIntent, keywords);

    // 提取约束条件
    const constraints = this.extractConstraints(sentences);

    // 推导成功标准
    const successCriteria = this.inferSuccessCriteria(coreIntent, constraints);

    // 识别风险因素
    const riskFactors = this.identifyRisks(coreIntent, constraints, implicitNeeds);

    // 计算需求清晰度
    const clarity = this.computeClarity(input, constraints, implicitNeeds);

    return { coreIntent, implicitNeeds, constraints, successCriteria, riskFactors, clarity };
  }

  // ---------- 任务分解 ----------

  /** 层次化任务分解，支持1-3层深度 */
  decompose(task: string, depth: number = 3): TaskDecomposition {
    const clampedDepth = Math.max(1, Math.min(3, depth));
    const subTasks = this.buildSubTasks(task, clampedDepth);
    const executionOrder = this.resolveExecutionOrder(subTasks);

    return { mainTask: task, subTasks, depth: clampedDepth, executionOrder };
  }

  // ---------- 创意方案生成 ----------

  /** 生成多种候选方案 */
  generateSolutions(problem: string, constraints: string[]): Solution[] {
    const baseSolutions = this.deriveBaseSolutions(problem);
    const filtered = this.applyConstraints(baseSolutions, constraints);
    const creative = this.generateCreativeSolutions(problem, constraints);
    return [...filtered, ...creative];
  }

  // ---------- 方案评估 ----------

  /** 从五个维度评估方案 */
  evaluateSolution(solution: Solution): SolutionEvaluation {
    const feasibility = this.scoreFeasibility(solution);
    const efficiency = this.scoreEfficiency(solution);
    const risk = this.scoreRisk(solution);
    const innovation = this.scoreInnovation(solution);
    const robustness = this.scoreRobustness(solution);

    // 综合评分：加权平均，风险权重为负向
    const overallScore = Math.round(
      feasibility * 0.25 +
      efficiency * 0.20 +
      (100 - risk) * 0.20 +
      innovation * 0.15 +
      robustness * 0.20
    );

    const remarks = this.generateEvaluationRemarks(feasibility, efficiency, risk, innovation, robustness);

    return {
      solutionName: solution.name,
      feasibility, efficiency, risk, innovation, robustness,
      overallScore, remarks
    };
  }

  // ---------- 动态策略调整 ----------

  /** 根据反馈实时调整策略 */
  adaptStrategy(currentStrategy: string, feedback: string): StrategyAdjustment {
    const feedbackType = this.classifyFeedback(feedback);
    const newStrategy = this.deriveNewStrategy(currentStrategy, feedbackType, feedback);
    const confidence = this.computeAdjustmentConfidence(feedbackType, feedback);
    const suggestedActions = this.suggestActions(newStrategy, feedbackType);

    this.currentStrategy = newStrategy;
    this.learnedExperiences.push(`反馈类型[${feedbackType}] → 策略调整为[${newStrategy}]`);

    return {
      previousStrategy: currentStrategy,
      newStrategy,
      reason: `根据反馈类型"${feedbackType}"调整策略`,
      confidence,
      suggestedActions
    };
  }

  // ---------- 开放式问题解决 ----------

  /** 无标准答案问题的多角度分析 */
  solveOpenEnded(problem: string): OpenEndedSolution {
    const perspectives = this.analyzeFromMultipleAngles(problem);
    const overallSuggestion = this.synthesizePerspectives(perspectives);
    const uncertaintyNote = this.describeUncertainty(problem, perspectives);

    return { problem, perspectives, overallSuggestion, uncertaintyNote };
  }

  // ==================== 私有辅助方法 ====================

  private extractKeywords(text: string): string[] {
    const stopWords = new Set(['的', '了', '是', '在', '和', '与', '或', '不', '也', '都', '要', '会', '可以', '需要', '一个', '这个', '那个', 'the', 'a', 'an', 'is', 'are', 'and', 'or', 'not', 'to', 'of', 'in']);
    return text.split(/[\s,，、：:；;]+/)
      .filter(w => w.length > 1 && !stopWords.has(w));
  }

  private inferCoreIntent(sentences: string[], keywords: string[]): string {
    if (sentences.length === 0) return '无法识别核心意图';
    // 优先取包含最多关键词的句子作为核心意图
    let best = sentences[0];
    let maxCount = 0;
    for (const s of sentences) {
      const count = keywords.filter(k => s.includes(k)).length;
      if (count > maxCount) { maxCount = count; best = s; }
    }
    return best.trim();
  }

  private inferImplicitNeeds(coreIntent: string, keywords: string[]): string[] {
    const needs: string[] = [];
    if (keywords.some(k => ['性能', '速度', '快', '高效'].includes(k))) {
      needs.push('需要关注性能优化');
    }
    if (keywords.some(k => ['安全', '加密', '防护'].includes(k))) {
      needs.push('需要考虑安全防护措施');
    }
    if (keywords.some(k => ['用户', '体验', '界面'].includes(k))) {
      needs.push('需要关注用户体验设计');
    }
    if (keywords.some(k => ['扩展', '维护', '迭代'].includes(k))) {
      needs.push('需要考虑系统可扩展性');
    }
    if (needs.length === 0) {
      needs.push('需要进一步明确需求细节');
    }
    return needs;
  }

  private extractConstraints(sentences: string[]): string[] {
    const constraints: string[] = [];
    const patterns = ['必须', '不能', '不可', '限制', '约束', '要求', '不超过', '至少', '最多', '范围内'];
    for (const s of sentences) {
      if (patterns.some(p => s.includes(p))) {
        constraints.push(s.trim());
      }
    }
    return constraints;
  }

  private inferSuccessCriteria(coreIntent: string, constraints: string[]): string[] {
    const criteria: string[] = [`实现${coreIntent}的核心功能`];
    if (constraints.length > 0) {
      criteria.push('满足所有约束条件');
    }
    criteria.push('方案具备可执行性');
    criteria.push('结果可验证、可度量');
    return criteria;
  }

  private identifyRisks(coreIntent: string, constraints: string[], implicitNeeds: string[]): string[] {
    const risks: string[] = [];
    if (constraints.length > 3) risks.push('约束条件过多可能导致方案空间受限');
    if (implicitNeeds.length > 2) risks.push('隐含需求较多，可能存在理解偏差');
    risks.push('需求变更风险');
    risks.push('技术可行性风险');
    return risks;
  }

  private computeClarity(input: string, constraints: string[], implicitNeeds: string[]): number {
    let score = 0.5;
    if (input.length > 20) score += 0.1;
    if (input.length > 50) score += 0.1;
    if (constraints.length > 0) score += 0.1;
    if (implicitNeeds.length <= 1) score += 0.1;
    if (constraints.length > 3) score -= 0.1; // 矛盾约束可能降低清晰度
    return Math.max(0, Math.min(1, score));
  }

  private buildSubTasks(task: string, depth: number): SubTask[] {
    const subTasks: SubTask[] = [];
    // 第一层：核心子任务
    const phase1: SubTask = {
      name: '需求确认与规划',
      description: `明确"${task}"的具体需求和范围`,
      actions: [
        { description: '梳理需求要点', suggestedTool: '需求分析工具', estimatedMinutes: 15 },
        { description: '确认优先级', suggestedTool: '优先级矩阵', estimatedMinutes: 10 },
      ],
      dependencies: []
    };
    subTasks.push(phase1);

    if (depth >= 2) {
      const phase2: SubTask = {
        name: '方案设计与验证',
        description: '设计实现方案并进行可行性验证',
        actions: [
          { description: '生成候选方案', suggestedTool: '方案生成器', estimatedMinutes: 20 },
          { description: '方案评估与筛选', suggestedTool: '评估框架', estimatedMinutes: 15 },
          { description: '原型验证', suggestedTool: '原型工具', estimatedMinutes: 30 },
        ],
        dependencies: [0]
      };
      subTasks.push(phase2);
    }

    if (depth >= 3) {
      const phase3: SubTask = {
        name: '实施与迭代',
        description: '执行方案并根据反馈迭代优化',
        actions: [
          { description: '分步实施', suggestedTool: '任务执行引擎', estimatedMinutes: 60 },
          { description: '收集反馈', suggestedTool: '反馈收集器', estimatedMinutes: 10 },
          { description: '迭代优化', suggestedTool: '优化工具', estimatedMinutes: 25 },
        ],
        dependencies: [1]
      };
      subTasks.push(phase3);
    }

    return subTasks;
  }

  private resolveExecutionOrder(subTasks: SubTask[]): number[] {
    const order: number[] = [];
    const visited = new Set<number>();

    const visit = (idx: number) => {
      if (visited.has(idx)) return;
      visited.add(idx);
      for (const dep of subTasks[idx].dependencies) {
        visit(dep);
      }
      order.push(idx);
    };

    for (let i = 0; i < subTasks.length; i++) visit(i);
    return order;
  }

  private deriveBaseSolutions(problem: string): Solution[] {
    return [
      {
        name: '常规方案',
        description: `采用成熟技术路线解决"${problem}"`,
        steps: ['分析问题根因', '选择成熟技术方案', '按步骤实施', '测试验证'],
        prerequisites: ['具备相关技术经验', '资源充足']
      },
      {
        name: '渐进方案',
        description: `分阶段逐步解决"${problem}"，降低风险`,
        steps: ['最小可行方案', '小范围验证', '逐步扩展', '全面推广'],
        prerequisites: ['允许迭代周期', '有试错空间']
      }
    ];
  }

  private applyConstraints(solutions: Solution[], constraints: string[]): Solution[] {
    return solutions.filter(s => {
      // 如果约束中明确排除了某种方案的前提条件，则过滤
      return !constraints.some(c =>
        s.prerequisites.some(p => c.includes(p) && c.includes('不能'))
      );
    });
  }

  private generateCreativeSolutions(problem: string, _constraints: string[]): Solution[] {
    return [
      {
        name: '创新方案',
        description: `采用跨领域思路或新技术解决"${problem}"`,
        steps: ['跨界借鉴灵感', '设计创新方案', '快速实验验证', '调整优化'],
        prerequisites: ['开放的创新环境', '容错机制']
      },
      {
        name: '逆向方案',
        description: `从问题反面思考，转换视角解决"${problem}"`,
        steps: ['重新定义问题', '逆向推导', '构建反向方案', '验证可行性'],
        prerequisites: ['思维灵活性', '领域理解深度']
      }
    ];
  }

  private scoreFeasibility(solution: Solution): number {
    let score = 70;
    if (solution.prerequisites.length <= 1) score += 15;
    if (solution.steps.length <= 4) score += 10;
    if (solution.name.includes('常规')) score += 5;
    if (solution.name.includes('创新') || solution.name.includes('逆向')) score -= 10;
    return Math.min(100, Math.max(0, score));
  }

  private scoreEfficiency(solution: Solution): number {
    let score = 65;
    const totalMinutes = solution.steps.length * 15;
    if (totalMinutes < 60) score += 20;
    else if (totalMinutes < 120) score += 10;
    if (solution.name.includes('渐进')) score -= 5;
    return Math.min(100, Math.max(0, score));
  }

  private scoreRisk(solution: Solution): number {
    let score = 30;
    if (solution.name.includes('创新') || solution.name.includes('逆向')) score += 25;
    if (solution.prerequisites.length > 2) score += 15;
    if (solution.name.includes('常规')) score -= 10;
    return Math.min(100, Math.max(0, score));
  }

  private scoreInnovation(solution: Solution): number {
    if (solution.name.includes('创新')) return 85;
    if (solution.name.includes('逆向')) return 90;
    if (solution.name.includes('渐进')) return 55;
    return 40;
  }

  private scoreRobustness(solution: Solution): number {
    let score = 60;
    if (solution.name.includes('常规')) score += 20;
    if (solution.name.includes('渐进')) score += 15;
    if (solution.steps.length > 3) score += 5;
    return Math.min(100, Math.max(0, score));
  }

  private generateEvaluationRemarks(f: number, e: number, r: number, i: number, b: number): string {
    const parts: string[] = [];
    if (f >= 80) parts.push('可行性较高');
    else if (f < 50) parts.push('可行性不足，需谨慎');
    if (r >= 60) parts.push('风险较大，建议制定风险应对计划');
    if (i >= 80) parts.push('创新性突出');
    if (b >= 80) parts.push('鲁棒性良好');
    if (e >= 80) parts.push('执行效率高');
    return parts.length > 0 ? parts.join('；') + '。' : '方案整体均衡，无突出短板。';
  }

  private classifyFeedback(feedback: string): string {
    if (/失败|错误|异常|报错|不行/.test(feedback)) return '负面-执行失败';
    if (/慢|耗时|性能|卡顿/.test(feedback)) return '负面-性能问题';
    if (/不够|不足|欠缺|缺少/.test(feedback)) return '负面-功能不足';
    if (/成功|完成|通过|很好/.test(feedback)) return '正面-执行成功';
    if (/建议|优化|改进|调整/.test(feedback)) return '中性-改进建议';
    return '中性-一般反馈';
  }

  private deriveNewStrategy(current: string, feedbackType: string, _feedback: string): string {
    const strategyMap: Record<string, string> = {
      '负面-执行失败': '回退与重试策略',
      '负面-性能问题': '性能优先策略',
      '负面-功能不足': '功能补全策略',
      '正面-执行成功': '加速推进策略',
      '中性-改进建议': '渐进优化策略',
      '中性-一般反馈': '观察与微调策略',
    };
    return strategyMap[feedbackType] || '灵活调整策略';
  }

  private computeAdjustmentConfidence(feedbackType: string, _feedback: string): number {
    if (feedbackType.startsWith('负面')) return 0.7;
    if (feedbackType.startsWith('正面')) return 0.9;
    return 0.5;
  }

  private suggestActions(newStrategy: string, _feedbackType: string): string[] {
    const actionMap: Record<string, string[]> = {
      '回退与重试策略': ['回退到上一个稳定状态', '分析失败原因', '调整参数后重试'],
      '性能优先策略': ['定位性能瓶颈', '优化关键路径', '减少不必要的计算'],
      '功能补全策略': ['识别缺失功能', '评估补全优先级', '逐步实现缺失功能'],
      '加速推进策略': ['扩大执行范围', '并行处理独立任务', '减少验证环节'],
      '渐进优化策略': ['收集具体改进点', '按优先级排序', '逐步实施改进'],
      '观察与微调策略': ['持续监控执行状态', '记录关键指标', '必要时微调参数'],
    };
    return actionMap[newStrategy] || ['继续当前执行', '密切关注反馈'];
  }

  private analyzeFromMultipleAngles(problem: string): OpenEndedSolution['perspectives'] {
    return [
      {
        angle: '技术可行性角度',
        analysis: `从技术层面分析"${problem}"的实现路径和可行性`,
        suggestion: '评估现有技术栈的支撑能力，识别技术瓶颈'
      },
      {
        angle: '用户价值角度',
        analysis: `从用户需求和价值出发分析"${problem}"`,
        suggestion: '聚焦用户核心痛点，确保方案解决真实需求'
      },
      {
        angle: '成本效益角度',
        analysis: `从投入产出比分析"${problem}"的解决策略`,
        suggestion: '优先选择低成本高收益的路径，避免过度投入'
      },
      {
        angle: '长期发展角度',
        analysis: `从长远视角分析"${problem}"的影响和演进方向`,
        suggestion: '考虑方案的可扩展性和未来演进空间'
      },
      {
        angle: '风险评估角度',
        analysis: `从风险管控角度分析"${problem}"的潜在威胁`,
        suggestion: '识别关键风险点，制定预防和应急措施'
      }
    ];
  }

  private synthesizePerspectives(perspectives: OpenEndedSolution['perspectives']): string {
    return perspectives.map(p => p.suggestion).join('；同时，') + '。综合各角度，建议采取平衡策略，在可控风险下追求最大价值。';
  }

  private describeUncertainty(problem: string, _perspectives: OpenEndedSolution['perspectives']): string {
    return `"${problem}"为开放式问题，不存在唯一标准答案。以上分析基于多角度推演，实际结果受具体环境和执行条件影响，建议在实践中持续验证和调整。`;
  }
}
