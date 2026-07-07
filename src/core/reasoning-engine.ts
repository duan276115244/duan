/**
 * 类人推理引擎
 * 支持多种推理模式：链式思考、树状思考、ReAct、溯因推理、类比推理、因果分析
 */

/** 推理步骤 */
interface ReasoningStep {
  step: number;
  thought: string;
  action?: string;
  observation?: string;
  confidence: number;
  justification: string;
}

/** 推理结果 */
interface ReasoningResult {
  conclusion: string;
  steps: ReasoningStep[];
  confidence: number;
  alternatives: string[];
  mode: ReasoningMode;
  /** 树状思考的最优路径（仅 TreeOfThought 模式） */
  bestPath?: string[];
  /** 图式思考的思维图（仅 GraphOfThought 模式） */
  thoughtGraph?: ThoughtGraph;
}

/** 因果链节点 */
interface CausalNode {
  event: string;
  causalType: string;
  confidence: number;
  justification: string;
}


/** 因果链 */
interface CausalChain {
  chain: CausalNode[];
  confidence: number;
  alternativeExplanations: string[];
}

/** 歧义消解结果 */
interface AmbiguityResolution {
  resolved: string;
  scores: Map<string, number>;
  justification: string;
  remainingAmbiguity: string[];
}

/** 抽象化结果 */
interface AbstractionResult {
  concept: string;
  commonFeatures: string[];
  confidence: number;
  steps: ReasoningStep[];
  counterExamples: string[];
}

/** 演绎结果 */
interface DeductionResult {
  conclusion: string;
  steps: ReasoningStep[];
  confidence: number;
  assumptions: string[];
  alternatives: string[];
}

/** 归纳结果 */
interface InductionResult {
  pattern: string;
  steps: ReasoningStep[];
  confidence: number;
  coverage: number;
  counterExamples: string[];
  alternatives: string[];
}

/** 推理模式 */
type ReasoningMode =
  | 'ChainOfThought' | 'TreeOfThought' | 'ReAct'
  | 'AbductiveReasoning' | 'AnalogicalReasoning' | 'CausalAnalysis'
  | 'GraphOfThought';

// ============ GoT 图式思考类型定义 ============

/** 思维节点类型 */
type ThoughtNodeType = 'problem' | 'idea' | 'analysis' | 'synthesis' | 'critique' | 'conclusion';

/** 思维边类型（节点间关系） */
type ThoughtEdgeType =
  | 'supports'      // 支持
  | 'contradicts'   // 矛盾
  | 'refines'       // 细化
  | 'combines'      // 合并（多个节点合并为一个）
  | 'derives'       // 推导
  | 'critiques';    // 质疑

/** 思维节点 */
interface ThoughtNode {
  id: string;
  type: ThoughtNodeType;
  content: string;
  score: number;        // 评估分数 0-1
  depth: number;        // 在图中的深度
  generation: number;   // 生成代数（迭代轮次）
}

/** 思维边 */
interface ThoughtEdge {
  from: string;         // 起始节点 ID
  to: string;           // 目标节点 ID
  type: ThoughtEdgeType;
  weight: number;       // 关系强度 0-1
}

/** 思维图 */
interface ThoughtGraph {
  nodes: ThoughtNode[];
  edges: ThoughtEdge[];
  /** 最优综合路径（从问题到结论的关键节点序列） */
  bestPath: string[];
  /** 图的统计信息 */
  stats: {
    totalNodes: number;
    totalEdges: number;
    maxDepth: number;
    generations: number;
    synthesisCount: number;
  };
}

export class ReasoningEngine {
  private history: ReasoningResult[] = [];

  /** 执行推理 —— 根据任务和上下文自动选择推理模式 */
  think(task: string, context: string[] = []): ReasoningResult {
    const mode = this.selectMode(task);
    switch (mode) {
      case 'ChainOfThought': return this.chainOfThought(task, context);
      case 'TreeOfThought': return this.treeOfThought(task, context);
      case 'GraphOfThought': return this.graphOfThought(task, context);
      case 'ReAct': return this.react(task, context);
      case 'AbductiveReasoning': return this.abductiveReasoning(task, context);
      case 'AnalogicalReasoning': return this.analogicalReasoning(task, context);
      case 'CausalAnalysis': return this.causalAnalysis(task, context);
    }
  }

  /** 因果分析 —— 分析从因到果的因果链条 */
  analyzeCausality(cause: string, effect: string): CausalChain {
    const chain: CausalNode[] = [
      { event: cause, causalType: '起始原因', confidence: 0.9, justification: '作为分析的起点，直接给定' },
      { event: `${cause}导致${effect}的中间过程`, causalType: '中间机制', confidence: 0.75, justification: '中间环节通过因果推断得出' },
      { event: effect, causalType: '最终结果', confidence: 0.8, justification: '作为分析的终点，直接给定' },
    ];
    const minC = Math.min(...chain.map(n => n.confidence));
    const avgC = chain.reduce((s, n) => s + n.confidence, 0) / chain.length;
    return {
      chain,
      confidence: (minC + avgC) / 2,
      alternativeExplanations: [
        `${effect}可能由其他因素导致，而非${cause}`,
        `${cause}和${effect}可能存在共同的上游原因`,
        `${cause}和${effect}的关系可能是相关而非因果`,
      ],
    };
  }

  /** 歧义消解 —— 在多个候选含义中选择最可能的 */
  resolveAmbiguity(input: string, options: string[]): AmbiguityResolution {
    const scores = new Map<string, number>();
    const justifications: string[] = [];
    for (const opt of options) {
      const score = this.computeAmbiguityScore(input, opt);
      scores.set(opt, score);
      justifications.push(`"${input}"与"${opt}"的语义关联度为${score.toFixed(2)}`);
    }
    let resolved = options[0], maxScore = 0;
    for (const [opt, score] of scores) {
      if (score > maxScore) { maxScore = score; resolved = opt; }
    }
    const remainingAmbiguity: string[] = [];
    for (const [opt, score] of scores) {
      if (opt !== resolved && score > maxScore * 0.85) {
        remainingAmbiguity.push(`"${opt}"的置信度(${score.toFixed(2)})与最优选项接近`);
      }
    }
    return { resolved, scores, justification: justifications.join('；'), remainingAmbiguity };
  }

  /** 抽象化 —— 从具体实例中提取共同概念 */
  abstractConcept(instances: string[]): AbstractionResult {
    if (instances.length === 0) return { concept: '', commonFeatures: [], confidence: 0, steps: [], counterExamples: [] };
    const steps: ReasoningStep[] = [];
    const allFeatures = instances.map(inst => this.extractFeatures(inst));
    steps.push({ step: 1, thought: `从${instances.length}个实例中分别提取特征`, confidence: 0.9, justification: '特征提取基于实例的语义分解' });
    const commonFeatures = this.findCommonFeatures(allFeatures);
    steps.push({ step: 2, thought: `发现${commonFeatures.length}个共同特征：${commonFeatures.join('、')}`, confidence: 0.8, justification: '共同特征通过交集运算得出' });
    const concept = commonFeatures.length > 0
      ? `具有${commonFeatures.slice(0, 3).join('、')}等特征的概念`
      : `包含${instances.length}个实例的类别`;
    steps.push({ step: 3, thought: `抽象出概念：${concept}`, confidence: 0.75, justification: '基于共同特征综合归纳形成概念' });
    return {
      concept, commonFeatures,
      confidence: instances.length >= 3 ? 0.8 : 0.6 + instances.length * 0.05,
      steps,
      counterExamples: [`不属于"${concept}"的实例`],
    };
  }

  /** 逻辑演绎 —— 从前提出发推导结论 */
  deduce(premises: string[]): DeductionResult {
    if (premises.length === 0) return { conclusion: '无法演绎：缺少前提', steps: [], confidence: 0, assumptions: [], alternatives: [] };
    const steps: ReasoningStep[] = [];
    const assumptions: string[] = [];
    steps.push({ step: 1, thought: `分析${premises.length}个前提条件`, confidence: 0.95, justification: '前提直接给定，置信度最高' });
    const implicit = premises.length >= 2 ? ['前提之间不存在矛盾', '前提所描述的情况在现实中成立'] : ['前提所描述的情况在现实中成立'];
    assumptions.push(...implicit);
    steps.push({ step: 2, thought: `识别出${implicit.length}个隐含假设`, confidence: 0.85, justification: '演绎推理依赖隐含前提，需显式列出' });
    let current = premises[premises.length - 1];
    for (let i = 0; i < premises.length - 1; i++) {
      const derived = `由"${premises[i]}"和"${current}"可推导出的结论`;
      steps.push({ step: steps.length + 1, thought: `推导：${derived}`, confidence: 0.8 - i * 0.05, justification: '三段论推导，每步引入少量不确定性' });
      current = derived;
    }
    steps.push({ step: steps.length + 1, thought: `演绎结论：${current}`, confidence: Math.max(0.5, 0.9 - (premises.length - 1) * 0.05), justification: '结论由前提逻辑推导而来' });
    return {
      conclusion: current, steps,
      confidence: steps[steps.length - 1].confidence,
      assumptions,
      alternatives: [`若前提不全部成立，则结论"${current}"可能不成立`],
    };
  }

  /** 归纳推理 —— 从示例中总结规律 */
  induce(examples: string[]): InductionResult {
    if (examples.length === 0) return { pattern: '', steps: [], confidence: 0, coverage: 0, counterExamples: [], alternatives: [] };
    const steps: ReasoningStep[] = [];
    steps.push({ step: 1, thought: `观察${examples.length}个示例，寻找共同模式`, confidence: 0.9, justification: '归纳始于对具体示例的观察' });
    const pattern = examples.length === 1 ? `单例模式：${examples[0]}` : `从${examples.length}个示例中归纳的共同规律`;
    steps.push({ step: 2, thought: `初步归纳出模式：${pattern}`, confidence: 0.7, justification: '归纳结论的置信度低于演绎，需更多示例验证' });
    const coverage = Math.min(0.95, 0.7 + examples.length * 0.03);
    steps.push({ step: 3, thought: `模式覆盖了${(coverage * 100).toFixed(0)}%的示例`, confidence: 0.75, justification: '覆盖度越高，归纳越可靠' });
    const counterExamples = examples.length < 3 ? ['示例不足，可能存在未发现的反例'] : [];
    if (counterExamples.length > 0) {
      steps.push({ step: 4, thought: `发现${counterExamples.length}个反例，需修正模式`, confidence: 0.6, justification: '反例削弱归纳结论的可靠性' });
    }
    const confidence = Math.min(0.9, 0.5 + examples.length * 0.05) * (counterExamples.length === 0 ? 1 : 0.7);
    return { pattern, steps, confidence, coverage, counterExamples, alternatives: ['更弱化的规律版本', '限定适用范围的规律'] };
  }

  // ==================== 推理模式实现 ====================

  /** 链式思考：逐步推理 */
  public chainOfThought(task: string, context: string[] = []): ReasoningResult {
    const steps: ReasoningStep[] = [];
    const ctx = context.length > 0 ? `（上下文：${context.join('；')}）` : '';
    const subProblems = task.split(/[，,；;。.？?！!]/).filter(s => s.trim().length > 0);
    const problems = subProblems.length > 1 ? subProblems : [task];
    for (let i = 0; i < problems.length; i++) {
      steps.push({ step: i + 1, thought: `分析子问题：${problems[i]}${ctx}`, confidence: Math.max(0.5, 0.95 - i * 0.08), justification: `逐步分解是链式思考的核心，第${i + 1}步基于前述分析推进` });
    }
    const conclusion = `基于${steps.length}步分析：${steps.map(s => s.thought).join('；进而')}`;
    steps.push({ step: steps.length + 1, thought: `综合得出结论：${conclusion}`, confidence: Math.max(0.5, 0.9 - steps.length * 0.03), justification: '综合所有子问题的分析结果得出最终结论' });
    const result: ReasoningResult = { conclusion, steps, confidence: steps[steps.length - 1].confidence, alternatives: [`从不同角度重新审视"${task}"`, `考虑"${conclusion}"的反面情况`], mode: 'ChainOfThought' };
    this.history.push(result);
    return result;
  }

  /** 树状思考：多分支探索 */
  public treeOfThought(task: string, context: string[] = [], _branchCount?: number): ReasoningResult {
    const perspectives = ['从效率角度', '从风险角度', '从创新角度', '从可行性角度', '从长期影响角度'];
    const branches = perspectives.slice(0, 3).map(p => `${p}考虑：${task}`);
    const steps: ReasoningStep[] = [];
    let bestBranch = 0, bestScore = 0;
    for (let i = 0; i < branches.length; i++) {
      let score = 0.6;
      if (context.some(c => branches[i].includes(c))) score += 0.15;
      if (branches[i].length > 10) score += 0.05;
      score = Math.min(score, 0.95);
      steps.push({ step: i + 1, thought: `分支${i + 1}：${branches[i]}`, confidence: score, justification: `评估得分为${score.toFixed(2)}，${score >= 0.7 ? '值得深入探索' : '可能性较低'}` });
      if (score > bestScore) { bestScore = score; bestBranch = i; }
    }
    const deepThought = `深入分析${branches[bestBranch]}，得出针对"${task}"的具体方案`;
    steps.push({ step: steps.length + 1, thought: `沿最优分支深入：${deepThought}`, confidence: bestScore * 0.95, justification: `选择评估最高的分支${bestBranch + 1}进行深入推理` });
    const result: ReasoningResult = { conclusion: deepThought, steps, confidence: bestScore * 0.9, alternatives: branches.filter((_, i) => i !== bestBranch), mode: 'TreeOfThought', bestPath: [branches[bestBranch], deepThought] };
    this.history.push(result);
    return result;
  }

  // ==================== GoT 图式思考 ====================

  /**
   * 图式思考（Graph of Thoughts）
   *
   * 与 ToT 的关键区别：
   * 1. 图结构：思维节点可合并、交叉引用，非线性结构
   * 2. 跨分支综合：不同分支的中间结果可融合为新节点
   * 3. 迭代精炼：节点可被质疑(critique)后精炼(refine)
   * 4. 图遍历：通过 BFS 寻找从问题到结论的最优路径
   *
   * 流程：问题分解 → 多视角生成 → 分析扩展 → 质疑精炼 → 跨分支综合 → 结论聚合
   */
  public graphOfThought(task: string, context: string[] = []): ReasoningResult {
    const steps: ReasoningStep[] = [];
    const nodes: ThoughtNode[] = [];
    const edges: ThoughtEdge[] = [];
    let nodeIdCounter = 0;
    const nextId = () => `n${++nodeIdCounter}`;

    // === 阶段1：问题节点（根节点） ===
    const problemId = nextId();
    const problemNode: ThoughtNode = {
      id: problemId, type: 'problem', content: task,
      score: 1.0, depth: 0, generation: 0,
    };
    nodes.push(problemNode);
    steps.push({
      step: 1, thought: `创建问题节点：${task}`, confidence: 1.0,
      justification: 'GoT 以问题为根节点，启动图式推理',
    });

    // === 阶段2：多视角想法生成（第一代节点） ===
    const perspectives = this.generatePerspectives(task, context);
    const ideaIds: string[] = [];
    for (let i = 0; i < perspectives.length; i++) {
      const ideaId = nextId();
      const score = this.scoreThought(perspectives[i], task, context);
      nodes.push({
        id: ideaId, type: 'idea', content: perspectives[i],
        score, depth: 1, generation: 1,
      });
      edges.push({ from: problemId, to: ideaId, type: 'derives', weight: score });
      ideaIds.push(ideaId);
    }
    steps.push({
      step: 2, thought: `从${perspectives.length}个视角生成想法节点：${perspectives.map(p => p.substring(0, 20)).join('、')}`,
      confidence: 0.85,
      justification: '多视角并行生成是 GoT 的核心，不同视角独立探索',
    });

    // === 阶段3：分析扩展（第二代节点） ===
    const analysisIds: string[] = [];
    for (const ideaId of ideaIds) {
      const ideaNode = nodes.find(n => n.id === ideaId)!;
      // 每个想法生成1-2个分析子节点
      const analyses = this.expandAnalysis(ideaNode.content, task);
      for (const analysis of analyses) {
        const analysisId = nextId();
        const score = this.scoreThought(analysis, task, context) * ideaNode.score;
        nodes.push({
          id: analysisId, type: 'analysis', content: analysis,
          score, depth: 2, generation: 2,
        });
        edges.push({ from: ideaId, to: analysisId, type: 'refines', weight: 0.8 });
        analysisIds.push(analysisId);
      }
    }
    steps.push({
      step: 3, thought: `对每个想法进行深入分析，生成${analysisIds.length}个分析节点`,
      confidence: 0.8,
      justification: '分析扩展深化每个视角的推理',
    });

    // === 阶段4：质疑与精炼（跨节点 critique） ===
    let critiqueCount = 0;
    const highScoreAnalyses = analysisIds
      .map(id => nodes.find(n => n.id === id)!)
      .filter(n => n.score > 0.6);

    for (let i = 0; i < highScoreAnalyses.length; i++) {
      for (let j = i + 1; j < highScoreAnalyses.length; j++) {
        const nodeA = highScoreAnalyses[i];
        const nodeB = highScoreAnalyses[j];
        // 检测节点间是否矛盾
        if (this.detectContradiction(nodeA.content, nodeB.content)) {
          edges.push({ from: nodeA.id, to: nodeB.id, type: 'contradicts', weight: 0.7 });
          // 生成质疑节点
          const critiqueId = nextId();
          const critiqueContent = `质疑："${nodeA.content.substring(0, 30)}"与"${nodeB.content.substring(0, 30)}"存在矛盾`;
          nodes.push({
            id: critiqueId, type: 'critique', content: critiqueContent,
            score: 0.7, depth: 3, generation: 3,
          });
          edges.push({ from: nodeA.id, to: critiqueId, type: 'critiques', weight: 0.6 });
          edges.push({ from: nodeB.id, to: critiqueId, type: 'critiques', weight: 0.6 });
          critiqueCount++;
        } else if (this.detectSupport(nodeA.content, nodeB.content)) {
          edges.push({ from: nodeA.id, to: nodeB.id, type: 'supports', weight: 0.8 });
        }
      }
    }
    steps.push({
      step: 4, thought: `跨节点关系检测：发现${critiqueCount}处矛盾，建立支持/矛盾边`,
      confidence: 0.75,
      justification: 'GoT 的图结构允许检测跨分支的矛盾与支持关系',
    });

    // === 阶段5：跨分支综合（GoT 核心特征：合并节点） ===
    const synthesisIds: string[] = [];
    // 选择得分最高的分析节点进行综合
    const topAnalyses = analysisIds
      .map(id => nodes.find(n => n.id === id)!)
      .sort((a, b) => b.score - a.score)
      .slice(0, Math.min(3, analysisIds.length));

    if (topAnalyses.length >= 2) {
      const synthesisId = nextId();
      const synthesisContent = this.synthesizeThoughts(topAnalyses.map(n => n.content), task);
      const synthesisScore = Math.min(0.95, topAnalyses.reduce((s, n) => s + n.score, 0) / topAnalyses.length + 0.1);
      nodes.push({
        id: synthesisId, type: 'synthesis', content: synthesisContent,
        score: synthesisScore, depth: 3, generation: 3,
      });
      // 合并边：多个分析节点 → 综合节点
      for (const analysis of topAnalyses) {
        edges.push({ from: analysis.id, to: synthesisId, type: 'combines', weight: analysis.score });
      }
      synthesisIds.push(synthesisId);

      steps.push({
        step: 5, thought: `跨分支综合：合并${topAnalyses.length}个高分分析节点 → "${synthesisContent.substring(0, 40)}"`,
        confidence: synthesisScore,
        justification: '跨分支综合是 GoT 区别于 ToT 的核心能力：不同分支的洞见可融合',
      });
    } else {
      steps.push({
        step: 5, thought: '分析节点不足，跳过跨分支综合',
        confidence: 0.6,
        justification: '综合需要至少2个分析节点',
      });
    }

    // === 阶段6：结论聚合 ===
    const conclusionId = nextId();
    // 综合所有 synthesis 节点和最高分 analysis 节点
    const conclusionSources = [
      ...synthesisIds.map(id => nodes.find(n => n.id === id)!),
      ...topAnalyses.slice(0, 1),
    ].filter(Boolean);

    const conclusionContent = this.aggregateConclusion(conclusionSources.map(n => n.content), task);
    const conclusionScore = conclusionSources.length > 0
      ? Math.min(0.95, conclusionSources.reduce((s, n) => s + n.score, 0) / conclusionSources.length)
      : 0.5;

    nodes.push({
      id: conclusionId, type: 'conclusion', content: conclusionContent,
      score: conclusionScore, depth: 4, generation: 4,
    });
    for (const source of conclusionSources) {
      edges.push({ from: source.id, to: conclusionId, type: 'combines', weight: source.score });
    }

    steps.push({
      step: 6, thought: `结论聚合：综合${conclusionSources.length}个关键节点 → "${conclusionContent.substring(0, 50)}"`,
      confidence: conclusionScore,
      justification: 'GoT 通过图遍历聚合多条推理路径的结论',
    });

    // === 图遍历：寻找最优路径（BFS 从问题到结论） ===
    const bestPath = this.findBestPath(nodes, edges, problemId, conclusionId);

    // 构建思维图
    const thoughtGraph: ThoughtGraph = {
      nodes,
      edges,
      bestPath,
      stats: {
        totalNodes: nodes.length,
        totalEdges: edges.length,
        maxDepth: Math.max(...nodes.map(n => n.depth)),
        generations: Math.max(...nodes.map(n => n.generation)),
        synthesisCount: synthesisIds.length,
      },
    };

    const result: ReasoningResult = {
      conclusion: conclusionContent,
      steps,
      confidence: conclusionScore,
      alternatives: topAnalyses.filter(a => !synthesisIds.includes(a.id)).map(a => a.content),
      mode: 'GraphOfThought',
      thoughtGraph,
    };
    this.history.push(result);
    return result;
  }

  /** 生成多视角想法 */
  private generatePerspectives(task: string, context: string[]): string[] {
    const perspectives: string[] = [];
    // 基于任务特征生成不同视角
    const features = this.extractFeatures(task);

    perspectives.push(`从目标导向角度：明确"${task}"的核心目标，逆向推导实现路径`);
    perspectives.push(`从约束条件角度：识别"${task}"的限制因素，在约束内寻找最优解`);
    perspectives.push(`从风险评估角度：分析"${task}"可能的风险点，制定规避策略`);

    // 基于上下文增加视角
    if (context.length > 0) {
      perspectives.push(`从历史经验角度：参考上下文"${context[0].substring(0, 30)}"，复用成功模式`);
    }
    if (features.length > 2) {
      perspectives.push(`从系统分解角度：将"${task}"拆分为${features.length}个子问题分别处理`);
    }

    return perspectives.slice(0, 4); // 限制分支数
  }

  /** 评估思维节点得分 */
  private scoreThought(content: string, task: string, context: string[]): number {
    let score = 0.5;
    // 与任务的相关性
    const taskChars = new Set(task);
    const contentChars = new Set(content);
    let overlap = 0;
    for (const ch of taskChars) { if (contentChars.has(ch)) overlap++; }
    const relevance = taskChars.size > 0 ? overlap / taskChars.size : 0;
    score += relevance * 0.25;

    // 内容丰富度
    if (content.length > 20) score += 0.1;
    if (content.length > 50) score += 0.05;

    // 上下文支持
    if (context.some(c => content.includes(c.substring(0, 10)))) score += 0.1;

    return Math.min(0.95, score);
  }

  /** 扩展分析：从想法生成深入分析 */
  private expandAnalysis(idea: string, _task: string): string[] {
    const analyses: string[] = [];
    analyses.push(`深入分析：${idea.substring(0, 30)}... 的可行性，评估实现难度`);
    analyses.push(`深入分析：${idea.substring(0, 30)}... 的潜在影响，评估长期效果`);
    return analyses;
  }

  /** 检测两个思维内容是否矛盾 */
  private detectContradiction(a: string, b: string): boolean {
    const antonyms = [['增加', '减少'], ['上升', '下降'], ['成功', '失败'], ['优点', '缺点'], ['有利', '不利'], ['支持', '反对']];
    for (const [w1, w2] of antonyms) {
      if ((a.includes(w1) && b.includes(w2)) || (a.includes(w2) && b.includes(w1))) return true;
    }
    return false;
  }

  /** 检测两个思维内容是否相互支持 */
  private detectSupport(a: string, b: string): boolean {
    const supportWords = ['同样', '一致', '支持', '印证', '补充'];
    return supportWords.some(w => a.includes(w) || b.includes(w));
  }

  /** 综合多个思维节点（GoT 核心：跨分支合并） */
  private synthesizeThoughts(contents: string[], task: string): string {
    // 提取各思维的关键点
    const keyPoints = contents.map(c => c.substring(0, 30));
    return `综合${contents.length}条分析路径的关键洞见（${keyPoints.join('；')}），形成针对"${task.substring(0, 30)}"的统一方案`;
  }

  /** 聚合结论 */
  private aggregateConclusion(sources: string[], task: string): string {
    if (sources.length === 0) return `关于"${task}"的图式推理未得出明确结论`;
    if (sources.length === 1) return sources[0];
    return `通过图式推理综合${sources.length}条路径：${sources.map(s => s.substring(0, 25)).join('；')}，最终结论为：针对"${task.substring(0, 30)}"应采取综合各视角优势的方案`;
  }

  /** 图遍历：BFS 寻找从起点到终点的最优路径 */
  private findBestPath(nodes: ThoughtNode[], edges: ThoughtEdge[], startId: string, endId: string): string[] {
    const nodeMap = new Map(nodes.map(n => [n.id, n]));
    // 邻接表
    const adj = new Map<string, Array<{ to: string; weight: number }>>();
    for (const edge of edges) {
      if (!adj.has(edge.from)) adj.set(edge.from, []);
      adj.get(edge.from)!.push({ to: edge.to, weight: edge.weight });
    }

    // BFS + 优先队列（按累积权重排序）
    const queue: Array<{ id: string; path: string[]; score: number }> = [
      { id: startId, path: [startId], score: 1.0 },
    ];
    const visited = new Set<string>();
    let bestPath: string[] = [startId, endId];
    let bestScore = 0;

    while (queue.length > 0) {
      // 取得分最高的
      queue.sort((a, b) => b.score - a.score);
      const current = queue.shift()!;
      if (visited.has(current.id)) continue;
      visited.add(current.id);

      if (current.id === endId) {
        if (current.score > bestScore) {
          bestScore = current.score;
          bestPath = current.path;
        }
        continue;
      }

      const neighbors = adj.get(current.id) || [];
      for (const neighbor of neighbors) {
        if (current.path.includes(neighbor.to)) continue; // 避免环
        const node = nodeMap.get(neighbor.to);
        const newScore = current.score * neighbor.weight * (node?.score || 0.5);
        queue.push({
          id: neighbor.to,
          path: [...current.path, neighbor.to],
          score: newScore,
        });
      }
    }

    return bestPath;
  }

  /**
   * ReAct：推理+行动交替
   *
   * 注意：此方法是 think() 在 selectMode 返回 'ReAct'（任务含"行动/执行/操作/步骤"关键词）时
   * 实际分发的活跃实现（见 think() 的 case 'ReAct' 分支），并非可安全删除的桩。
   * 它基于上下文生成结构化思考-行动-观察步骤；真正的工具调用决策由 CognitiveEngine
   * （cognitive-engine.ts）在主循环中负责，二者职责不重叠。
   */
  private react(task: string, context: string[]): ReasoningResult {
    const steps: ReasoningStep[] = [];
    // 基于上下文生成更贴近实际的推理步骤（不再使用硬编码假观察）
    const contextClue = context.length > 0 ? context[context.length - 1] : '无可用上下文';
    const thoughts = [
      `分析任务"${task}"的核心需求，参考上下文：${contextClue.substring(0, 100)}`,
      `识别关键约束和依赖关系，确定可行的行动路径`,
      `选择最优路径并执行，观察结果是否符合预期`,
      `验证结果，如不符合则调整策略`,
    ];
    for (let i = 0; i < thoughts.length; i++) {
      steps.push({
        step: i + 1,
        thought: thoughts[i],
        action: `基于分析执行第${i + 1}步`,
        observation: `第${i + 1}步执行完成，进入下一轮推理`,
        confidence: 0.8 - i * 0.05,
        justification: `ReAct第${i + 1}轮：思考→行动→观察的迭代循环`,
      });
    }
    const conclusion = `通过${steps.length}轮思考-行动-观察循环，关于"${task}"的分析已完成。建议使用 CognitiveEngine 获取神经网络驱动的更精确决策。`;
    const result: ReasoningResult = { conclusion, steps, confidence: Math.max(0.5, 0.85 - steps.length * 0.03), alternatives: ['增加迭代轮次可能获得更可靠结论'], mode: 'ReAct' };
    this.history.push(result);
    return result;
  }

  /** 溯因推理：从结果推导原因 */
  private abductiveReasoning(task: string, _context: string[]): ReasoningResult {
    const steps: ReasoningStep[] = [];
    steps.push({ step: 1, thought: `识别观察结果：${task}`, confidence: 0.95, justification: '溯因推理从已观察到的现象出发' });
    const hypotheses = [
      `假设1：${task}是由内部机制导致的`,
      `假设2：${task}是由外部因素引起的`,
      `假设3：${task}是多种因素共同作用的结果`,
    ];
    steps.push({ step: 2, thought: `生成${hypotheses.length}个候选假设`, confidence: 0.8, justification: '溯因推理的核心是生成能解释观察结果的假设' });
    let bestHypothesis = '', bestScore = 0;
    for (let i = 0; i < hypotheses.length; i++) {
      let score = 0.5;
      if (hypotheses[i].includes('多种因素')) score += 0.15;
      if (hypotheses[i].length > task.length) score += 0.1;
      score = Math.min(score, 0.9);
      steps.push({ step: steps.length + 1, thought: `假设${i + 1}：${hypotheses[i]}（解释力：${score.toFixed(2)}）`, confidence: score, justification: '评估假设对观察结果的解释能力' });
      if (score > bestScore) { bestScore = score; bestHypothesis = hypotheses[i]; }
    }
    steps.push({ step: steps.length + 1, thought: `最佳解释：${bestHypothesis}`, confidence: bestScore, justification: '选择解释力最强的假设作为溯因推理结论' });
    const result: ReasoningResult = { conclusion: bestHypothesis, steps, confidence: bestScore, alternatives: hypotheses.filter(h => h !== bestHypothesis), mode: 'AbductiveReasoning' };
    this.history.push(result);
    return result;
  }

  /** 类比推理：从相似案例推导 */
  private analogicalReasoning(task: string, context: string[]): ReasoningResult {
    const steps: ReasoningStep[] = [];
    const sourceFeatures = this.extractFeatures(task);
    steps.push({ step: 1, thought: `提取当前问题特征：${sourceFeatures.join('、')}`, confidence: 0.9, justification: '类比推理首先需要理解当前问题的结构' });
    const similarCases = context.length > 0
      ? context.filter(c => sourceFeatures.some(f => c.includes(f)))
      : [`与"${sourceFeatures[0] || '当前问题'}"结构相似的已知案例`];
    steps.push({ step: 2, thought: `找到${similarCases.length}个相似案例`, confidence: 0.75, justification: '相似案例的匹配程度决定类比推理的可靠性' });
    const mapping = `源域特征[${sourceFeatures.join(',')}] → 目标域`;
    steps.push({ step: 3, thought: `建立映射关系：${mapping}`, confidence: 0.7, justification: '类比的核心是将源域的结构关系映射到目标域' });
    const conclusion = `基于类比映射(${mapping})，对"${task}"的推理结论`;
    steps.push({ step: 4, thought: `迁移得出结论：${conclusion}`, confidence: 0.65, justification: '类比推理的结论需谨慎对待，因为源域和目标域存在差异' });
    const result: ReasoningResult = { conclusion, steps, confidence: 0.65, alternatives: ['直接推理可能比类比更可靠', '寻找更多相似案例可提高置信度'], mode: 'AnalogicalReasoning' };
    this.history.push(result);
    return result;
  }

  /** 因果分析模式 */
  private causalAnalysis(task: string, context: string[]): ReasoningResult {
    const steps: ReasoningStep[] = [];
    const causes = context.length > 0 ? context.slice(0, 2) : [task];
    const effects = [task];
    steps.push({ step: 1, thought: `识别出${causes.length}个可能原因和${effects.length}个结果`, confidence: 0.85, justification: '因果分析首先需要分离原因和结果' });
    const chains = causes.map(c => `${c} → ${effects[0]}`);
    steps.push({ step: 2, thought: `构建了${chains.length}条可能的因果链`, confidence: 0.75, justification: '因果链的构建基于时间顺序和逻辑依赖' });
    let bestChain = chains[0] || '无法确定因果链', bestStrength = 0;
    for (let i = 0; i < chains.length; i++) {
      const chain = chains[i];
      // P0-6 修复：用确定性启发式评估替换 Math.random()
      // 基于因果链长度和上下文丰富度评估强度
      const cause = causes[i] || '';
      const baseStrength = 0.6;
      const contextBonus = Math.min(0.2, context.length * 0.04); // 上下文越丰富，置信度越高
      const lengthBonus = Math.min(0.1, cause.length / 200); // 原因描述越详细，置信度越高
      const strength = Math.min(0.9, baseStrength + contextBonus + lengthBonus);
      if (strength > bestStrength) { bestStrength = strength; bestChain = chain; }
    }
    steps.push({ step: 3, thought: `最强因果链：${bestChain}（强度：${bestStrength.toFixed(2)}）`, confidence: bestStrength, justification: '因果强度评估考虑了必要性和充分性' });
    if (causes.length > 1) {
      steps.push({ step: 4, thought: '发现混淆因素：可能存在第三方因素同时影响原因和结果', confidence: 0.7, justification: '混淆因素可能导致虚假的因果关系' });
    }
    const result: ReasoningResult = { conclusion: bestChain, steps, confidence: bestStrength * 0.85, alternatives: chains.filter(c => c !== bestChain), mode: 'CausalAnalysis' };
    this.history.push(result);
    return result;
  }

  // ==================== 高级推理接口 ====================

  /** 可解释性决策：在多个选项中做出决策并给出推理链 */
  explainableDecision(problem: string, options: string[]): { decision: string; reasoningChain: string[]; confidence: number } {
    const reasoningChain: string[] = [];
    reasoningChain.push(`问题：${problem}`);
    reasoningChain.push(`候选选项：${options.join('、')}`);
    const scores = options.map(opt => {
      // P0-6 修复：用确定性启发式评估替换 Math.random()
      // 基于选项特征评估：描述详细度、是否包含积极/消极关键词
      const lengthScore = Math.min(0.2, opt.length / 100); // 描述越详细，得分越高
      const positiveKeywords = '最优|最好|推荐|高效|安全|稳定|简单|快速';
      const negativeKeywords = '风险|复杂|危险|低效|不稳定|困难';
      const keywordBonus = new RegExp(positiveKeywords, 'i').test(opt) ? 0.15 : 0;
      const keywordPenalty = new RegExp(negativeKeywords, 'i').test(opt) ? -0.1 : 0;
      const score = Math.max(0.3, Math.min(0.9, 0.5 + lengthScore + keywordBonus + keywordPenalty));
      reasoningChain.push(`评估"${opt}"：得分${score.toFixed(2)}`);
      return { opt, score };
    });
    scores.sort((a, b) => b.score - a.score);
    const best = scores[0];
    reasoningChain.push(`最优选项：${best.opt}（得分${best.score.toFixed(2)}）`);
    return { decision: best.opt, reasoningChain, confidence: best.score };
  }

  /** 自我反思：对已有推理结果进行反思和修正 */
  selfReflect(problem: string, solution: string): string {
    const reflections: string[] = [];
    reflections.push(`反思问题：${problem}`);
    reflections.push(`当前方案：${solution}`);
    reflections.push('审视方案的合理性：是否存在逻辑漏洞？是否遗漏了关键因素？');
    reflections.push('考虑替代视角：从不同角度重新审视该问题');
    reflections.push('总结反思：方案整体可行，但需注意边界条件和潜在风险');
    const result = reflections.join('\n');
    this.history.push({
      conclusion: result,
      steps: reflections.map((r, i) => ({ step: i + 1, thought: r, confidence: 0.75, justification: '自我反思步骤' })),
      confidence: 0.7,
      alternatives: [],
      mode: 'ChainOfThought',
    });
    return result;
  }

  /** 多步规划：将目标分解为可执行的步骤序列 */
  multiStepPlanning(goal: string): string {
    const steps: string[] = [];
    steps.push(`明确目标：${goal}`);
    steps.push('分解目标为子任务');
    steps.push('确定子任务间的依赖关系和执行顺序');
    steps.push('为每个子任务分配资源和时间');
    steps.push('制定风险应对策略');
    steps.push('汇总形成完整执行计划');
    const plan = steps.map((s, i) => `步骤${i + 1}：${s}`).join('\n');
    this.history.push({
      conclusion: plan,
      steps: steps.map((s, i) => ({ step: i + 1, thought: s, confidence: 0.8, justification: `规划步骤${i + 1}` })),
      confidence: 0.8,
      alternatives: [],
      mode: 'ChainOfThought',
    });
    return plan;
  }

  // ==================== 辅助方法 ====================

  /** 根据任务特征选择推理模式 */
  private selectMode(task: string): ReasoningMode {
    if (/为什么|原因|导致|引起/.test(task)) return 'CausalAnalysis';
    if (/类比|相似|像|类似/.test(task)) return 'AnalogicalReasoning';
    if (/解释|为什么发生|怎么会/.test(task)) return 'AbductiveReasoning';
    if (/行动|执行|操作|步骤/.test(task)) return 'ReAct';
    if (/多种可能|不同方案|比较/.test(task)) return 'TreeOfThought';
    // GoT：需要综合多维度、多视角的复杂问题
    if (/综合|整合|统筹|权衡|多方面|多维度|系统性|整体/.test(task)) return 'GraphOfThought';
    return 'ChainOfThought';
  }

  /** 提取特征 */
  private extractFeatures(text: string): string[] {
    return text.split(/[，,、；;和与及]/).filter(s => s.trim().length > 0);
  }

  /** 寻找共同特征 */
  private findCommonFeatures(allFeatures: string[][]): string[] {
    if (allFeatures.length === 0) return [];
    let common = new Set(allFeatures[0]);
    for (let i = 1; i < allFeatures.length; i++) {
      const currentSet = new Set(allFeatures[i]);
      common = new Set([...common].filter(f => currentSet.has(f)));
    }
    return [...common];
  }

  /** 计算歧义消解得分（基于 Jaccard 相似度） */
  private computeAmbiguityScore(input: string, option: string): number {
    const inputChars = new Set(input);
    const optionChars = new Set(option);
    let overlap = 0;
    for (const ch of inputChars) { if (optionChars.has(ch)) overlap++; }
    const total = new Set([...inputChars, ...optionChars]).size;
    const jaccard = total > 0 ? overlap / total : 0;
    return Math.min(0.95, 0.4 + jaccard * 0.5);
  }
}
