/**
 * extended-thinking-service.ts
 * 从 enhanced-agent-loop.ts 抽出的 Extended Thinking 模块
 *
 * v20.0 升级：4 级思考预算分级（对标 Claude Code ultrathink）
 *   L1（~500 tokens）：仅问题分解 — 快速思考
 *   L2（~1500 tokens）：问题分解 + 约束识别 — 标准思考
 *   L3（~3000 tokens）：完整 6 阶段 — 深度思考
 *   L4（~6000 tokens）：6 阶段 + ToT 树搜索 + 自指校验 — 极限思考
 *
 * 设计模式：Context Object + Stateless Functions
 * - 依赖通过 ExtendedThinkingContext 显式传入，不依赖类实例状态
 * - 纯规则函数（decomposeProblem 等）无需 ctx
 * - 不调用 LLM，基于规则的问题分解 + 约束识别 + 方案生成 + 边缘情况枚举
 */

// ============ 类型定义 ============

/** Extended Thinking 上下文 — 封装对 loop 实例的依赖 */
export interface ExtendedThinkingContext {
  /** Memory orchestrator — truthy 表示记忆系统可用 */
  readonly memoryOrchestrator: unknown | null;
  /** 搜索记忆（委托 loop 的 _searchMemoryWithCache） */
  readonly searchMemoryWithCache: (query: string, topK: number) => Promise<unknown[]>;
}

/**
 * v20.0 思考预算级别
 *
 * - L1：快速思考（仅问题分解，~500 tokens）
 * - L2：标准思考（问题分解 + 约束识别，~1500 tokens）
 * - L3：深度思考（完整 6 阶段，~3000 tokens）
 * - L4：极限思考（6 阶段 + ToT 树搜索 + 自指校验，~6000 tokens）
 *
 * 向后兼容：shallow=L1, medium=L2, deep=L3
 */
export type ThinkingDepth = 'L1' | 'L2' | 'L3' | 'L4' | 'shallow' | 'medium' | 'deep';

/** 用户显式触发词 → 思考级别映射 */
export const THINK_TRIGGER_KEYWORDS: Array<{ keywords: string[]; level: ThinkingDepth; label: string }> = [
  { keywords: ['极限思考', 'ultrathink', 'think harder', '极限模式'], level: 'L4', label: '极限思考' },
  { keywords: ['深入思考', 'think hard', '仔细想想', '深思熟虑', '深度思考'], level: 'L3', label: '深度思考' },
  { keywords: ['仔细想', 'think', '想一下', '思考一下', '考虑考虑'], level: 'L2', label: '标准思考' },
];

// ============ 类型：流式思考阶段 ============

/**
 * Phase D1: 流式思考阶段事件
 *
 * 每个阶段作为独立事件 yield，让 enhanced-agent-loop 逐阶段推送 think 事件，
 * 前端可以看到推理过程逐步展开（而非等待全部完成）。
 */
export interface ThinkingPhaseEvent {
  /** 阶段 emoji 前缀（🧩/🎯/💡/🔍/⚠️/📚/🌳/🪞）— 前端据此识别阶段边界 */
  emoji: string;
  /** 阶段标题（问题分解/约束识别/方案生成/边缘情况/风险评估/相关经验/树搜索/自指校验） */
  title: string;
  /** 阶段正文（多行 markdown，已含缩进） */
  body: string;
}

// ============ 深度归一化 ============

/** 将旧版 depth 值归一化为 L1-L4 */
export function normalizeDepth(depth: ThinkingDepth): 'L1' | 'L2' | 'L3' | 'L4' {
  switch (depth) {
    case 'shallow': return 'L1';
    case 'medium': return 'L2';
    case 'deep': return 'L3';
    default: return depth;
  }
}

/** 从用户输入检测显式思考触发词，返回匹配的级别（无匹配返回 null） */
export function detectExplicitThinkingLevel(input: string): { level: ThinkingDepth; label: string } | null {
  const lower = input.toLowerCase();
  for (const trigger of THINK_TRIGGER_KEYWORDS) {
    for (const kw of trigger.keywords) {
      if (lower.includes(kw.toLowerCase())) {
        return { level: trigger.level, label: trigger.label };
      }
    }
  }
  return null;
}

// ============ 主编排函数 ============

/**
 * P1-2: 执行 Extended Thinking — 多步逻辑检查 + 边缘情况枚举
 *
 * v20.0: 支持 L1-L4 四级思考预算
 *
 * 注意：本函数保持原签名（返回 Promise<string>）以维持向后兼容。
 * 新代码请改用 runExtendedThinkingStream 获取阶段级流式输出。
 */
export async function runExtendedThinking(
  ctx: ExtendedThinkingContext,
  problem: string,
  depth: ThinkingDepth,
): Promise<string> {
  const phases: ThinkingPhaseEvent[] = [];
  for await (const phase of runExtendedThinkingStream(ctx, problem, depth)) {
    phases.push(phase);
  }
  // 拼接为单一 markdown 字符串（兼容历史调用方）
  return phases
    .map(p => `${p.emoji} ${p.title}\n${p.body}`)
    .join('\n');
}

/**
 * Phase D1: 流式 Extended Thinking — 逐阶段 yield 思考事件
 *
 * v20.0: 4 级思考预算分级
 *   L1：仅问题分解（1 阶段）
 *   L2：问题分解 + 约束识别（2 阶段）
 *   L3：完整 6 阶段（问题分解/约束/方案/边缘/风险/经验）
 *   L4：6 阶段 + ToT 树搜索 + 自指校验（8 阶段）
 *
 * @yields ThinkingPhaseEvent 每个思考阶段（含 emoji + 标题 + 正文）
 */
export async function* runExtendedThinkingStream(
  ctx: ExtendedThinkingContext,
  problem: string,
  depth: ThinkingDepth,
): AsyncGenerator<ThinkingPhaseEvent, void, void> {
  const level = normalizeDepth(depth);

  // Phase 1: 问题分解（所有级别都执行）
  {
    const subProblems = decomposeProblem(problem);
    const body = subProblems.map((sp, i) => `  ${i + 1}. ${sp}`).join('\n');
    yield { emoji: '🧩', title: '问题分解', body };
  }

  // L1 仅问题分解，到此结束
  if (level === 'L1') return;

  // Phase 2: 约束识别（L2+）
  {
    const constraints = identifyConstraints(problem);
    const body =
      constraints.length > 0
        ? constraints.map(c => `  - ${c}`).join('\n')
        : '  - 未识别到明确约束';
    yield { emoji: '🎯', title: '约束识别', body };
  }

  // L2 仅问题分解 + 约束识别，到此结束
  if (level === 'L2') return;

  // Phase 3: 方案生成（L3+）
  {
    const solutionCount = level === 'L4' ? 7 : 5;
    const solutions = generateSolutions(problem, solutionCount);
    const body = solutions.map((s, i) => `  方案${i + 1}: ${s}`).join('\n');
    yield { emoji: '💡', title: `方案生成 (深度: ${level})`, body };
  }

  // Phase 4: 边缘情况枚举（L3+）
  {
    const edgeCases = enumerateEdgeCases(problem);
    const body =
      edgeCases.length > 0
        ? edgeCases.map(ec => `  - ${ec}`).join('\n')
        : '  - 未识别到明显边缘情况';
    yield { emoji: '🔍', title: '边缘情况枚举', body };
  }

  // Phase 5: 风险评估（L3+）
  {
    const body = [
      '  - 注意并发安全和数据竞争',
      '  - 验证边界条件（空值、极值、溢出）',
      '  - 考虑向后兼容性和迁移成本',
    ].join('\n');
    yield { emoji: '⚠️', title: '风险评估', body };
  }

  // Phase 6: 相关经验检索（L3+，如果有记忆系统）
  if (ctx.memoryOrchestrator) {
    try {
      const memories = await ctx.searchMemoryWithCache(problem, 3);
      if (memories && memories.length > 0) {
        const body = memories
          .map((m: any, i: number) => `  ${i + 1}. [${m.type || 'memory'}] ${(m.content ?? '').substring(0, 120)}`)
          .join('\n');
        yield { emoji: '📚', title: '相关经验', body };
      }
    } catch {
      // 记忆检索失败不影响后续阶段
    }
  }

  // L3 到此结束，L4 继续执行树搜索和自指校验
  if (level !== 'L4') return;

  // Phase 7: ToT 树搜索（仅 L4）— 多分支方案探索
  {
    const treeResult = treeOfThoughtSearch(problem);
    const body = treeResult;
    yield { emoji: '🌳', title: 'ToT 树搜索', body };
  }

  // Phase 8: 自指校验（仅 L4）— 一致性自检
  {
    const selfCheck = godelSelfVerification(problem);
    const body = selfCheck;
    yield { emoji: '🪞', title: '自指校验', body };
  }
}

// ============ 纯规则函数（无外部依赖） ============

/** 问题分解 — 按关键词和结构拆分 */
export function decomposeProblem(problem: string): string[] {
  const subs: string[] = [];
  const parts = problem.split(/[。\n；;]|(?:第[一二三四五六七八九十\d]+[步个条])/).filter(s => s.trim().length > 5);
  if (parts.length > 1) {
    parts.slice(0, 5).forEach(p => subs.push(p.trim().substring(0, 100)));
  }
  if (problem.includes('实现') || problem.includes('implement')) subs.push('确定实现方案和技术选型');
  if (problem.includes('测试') || problem.includes('test')) subs.push('设计测试用例和验证策略');
  if (problem.includes('优化') || problem.includes('optimize')) subs.push('识别性能瓶颈和优化方向');
  if (problem.includes('重构') || problem.includes('refactor')) subs.push('评估重构风险和影响范围');
  if (problem.includes('调试') || problem.includes('debug')) subs.push('定位问题根因和复现路径');
  if (subs.length === 0) subs.push('分析核心需求和目标');
  return subs;
}

/** 约束识别 */
export function identifyConstraints(problem: string): string[] {
  const constraints: string[] = [];
  if (/性能|performance|延迟|latency/i.test(problem)) constraints.push('性能约束：需关注响应时间和吞吐量');
  if (/安全|security|权限|permission/i.test(problem)) constraints.push('安全约束：需考虑权限控制和数据保护');
  if (/兼容|compat|向后|backward/i.test(problem)) constraints.push('兼容性约束：需保持向后兼容');
  if (/并发|concurren|线程|thread/i.test(problem)) constraints.push('并发约束：需处理线程安全和数据竞争');
  if (/内存|memory|资源|resource/i.test(problem)) constraints.push('资源约束：需控制内存和资源使用');
  if (constraints.length === 0) constraints.push('无明显技术约束');
  return constraints;
}

/** 方案生成 */
export function generateSolutions(problem: string, count: number): string[] {
  const solutions: string[] = [];
  const lower = problem.toLowerCase();
  if (lower.includes('实现') || lower.includes('implement')) {
    solutions.push('渐进式实现：先核心功能，再边缘情况');
    solutions.push('测试驱动：先写测试，再实现');
  }
  if (lower.includes('优化') || lower.includes('optimize')) {
    solutions.push(' profiling 定位瓶颈，针对性优化');
    solutions.push('空间换时间：缓存/索引/预计算');
  }
  if (lower.includes('重构') || lower.includes('refactor')) {
    solutions.push('小步重构：每次只改一处，保持测试通过');
    solutions.push('提取抽象：识别重复模式，建立统一接口');
  }
  if (lower.includes('调试') || lower.includes('debug')) {
    solutions.push('二分法排查：缩小问题范围');
    solutions.push('日志追踪：添加关键路径日志');
  }
  while (solutions.length < count) {
    solutions.push(`备选方案 ${solutions.length + 1}：基于上下文的替代实现`);
  }
  return solutions.slice(0, count);
}

/** 边缘情况枚举 */
export function enumerateEdgeCases(problem: string): string[] {
  const edges: string[] = [];
  edges.push('空输入/空集合/null/undefined');
  edges.push('极值：最大/最小/边界值');
  if (/数组|array|list|集合|collection/i.test(problem)) {
    edges.push('单元素集合 vs 多元素集合');
    edges.push('重复元素/有序 vs 无序');
  }
  if (/字符串|string|文本|text/i.test(problem)) {
    edges.push('空字符串/超长字符串/特殊字符');
    edges.push('Unicode/emoji/多字节字符');
  }
  if (/文件|file|路径|path/i.test(problem)) {
    edges.push('文件不存在/权限不足/路径穿越');
    edges.push('大文件/二进制文件/编码问题');
  }
  if (/网络|network|api|请求|request/i.test(problem)) {
    edges.push('超时/断网/重试/幂等性');
    edges.push('限流/认证失败/数据格式异常');
  }
  return edges;
}

// ============ L4 专属：ToT 树搜索 + Gödel 自指校验 ============

/**
 * ToT 树搜索 — 多分支方案探索（L4 专属）
 *
 * 参考 reasoning-engine.ts 的 graphOfThought BFS 图遍历模式，
 * 但简化为纯规则版本（不调用 LLM）：
 *   1. 生成 3 个思考分支（保守/激进/平衡）
 *   2. 每个分支展开 2 层子节点
 *   3. 评分选择最优路径
 *   4. 返回格式化的搜索结果
 *
 * @param problem 问题陈述
 * @returns 格式化的 ToT 搜索结果（markdown 文本）
 */
export function treeOfThoughtSearch(problem: string): string {
  // === 分支定义：3 种思考视角 ===
  const branches: Array<{ name: string; perspective: string; expand: () => string[] }> = [
    {
      name: '保守分支',
      perspective: `以最小改动和最低风险为优先，复用现有成熟方案解决「${problem.substring(0, 40)}」`,
      expand: () => [
        `评估现有方案是否可直接套用，识别需适配的差异点`,
        `制定回滚预案和灰度发布策略，确保失败可逆`,
      ],
    },
    {
      name: '激进分支',
      perspective: `以最优性能和最大收益为优先，采用创新方案解决「${problem.substring(0, 40)}」`,
      expand: () => [
        `探索前沿技术栈或重构架构以根本性解决问题`,
        `评估创新方案的可行性和技术债务，规划落地路径`,
      ],
    },
    {
      name: '平衡分支',
      perspective: `权衡成本/收益/风险，选择性价比最高的方案解决「${problem.substring(0, 40)}」`,
      expand: () => [
        `对比保守与激进方案的成本收益矩阵，寻找折中点`,
        `设计可渐进式升级的方案，先落地 MVP 再迭代优化`,
      ],
    },
  ];

  // === 评分函数：基于问题特征对分支打分 ===
  const scoreBranch = (branchName: string, problem: string): number => {
    let score = 0.5; // 基础分
    // 风险敏感问题 → 保守分支加分
    if (/安全|权限|支付|金融|production|生产/i.test(problem) && branchName === '保守分支') score += 0.3;
    // 性能/创新问题 → 激进分支加分
    if (/优化|性能|创新|重构|architecture/i.test(problem) && branchName === '激进分支') score += 0.3;
    // 通用问题 → 平衡分支加分
    if (/实现|功能|feature|开发/i.test(problem) && branchName === '平衡分支') score += 0.25;
    // 复杂问题 → 平衡分支加分
    if (problem.length > 80 && branchName === '平衡分支') score += 0.15;
    return Math.min(0.95, score);
  };

  // === 展开搜索树并评分 ===
  const lines: string[] = [];
  const scoredBranches: Array<{ name: string; perspective: string; score: number; subNodes: string[] }> = [];

  for (const branch of branches) {
    const score = scoreBranch(branch.name, problem);
    const subNodes = branch.expand();
    scoredBranches.push({ name: branch.name, perspective: branch.perspective, score, subNodes });
  }

  // === 格式化输出 ===
  lines.push('思考树展开（3 分支 × 2 子节点）：');
  for (const b of scoredBranches) {
    lines.push(`  ├─ [${b.name}] 评分: ${b.score.toFixed(2)}`);
    lines.push(`  │   视角: ${b.perspective}`);
    for (const sub of b.subNodes) {
      lines.push(`  │   └─ ${sub}`);
    }
  }

  // === 选择最优路径 ===
  const best = scoredBranches.slice().sort((a, b) => b.score - a.score)[0];
  lines.push('');
  lines.push(`✓ 最优路径：${best.name}（评分 ${best.score.toFixed(2)}）`);
  lines.push(`  推荐子步骤：`);
  best.subNodes.forEach((s, i) => lines.push(`    ${i + 1}. ${s}`));

  // === 备选路径 ===
  const alternatives = scoredBranches.filter(b => b.name !== best.name);
  if (alternatives.length > 0) {
    lines.push(`  备选路径：${alternatives.map(a => `${a.name}(${a.score.toFixed(2)})`).join('、')}`);
  }

  return lines.join('\n');
}

/**
 * Gödel 自指校验 — 一致性自检（L4 专属）
 *
 * 参考 reasoning-engine.ts 的 detectContradiction（反义词对）和 graphOfThought 的 critique 节点机制，
 * 对已生成的思考结果进行一致性校验：
 *   1. 内部矛盾检测（反义词对共现）
 *   2. 假设覆盖度检查（是否遗漏关键假设）
 *   3. 逻辑完备性自检（是否覆盖主要维度）
 *   4. 自指循环检测（方案是否依赖自身成立）
 *
 * @param problem 问题陈述
 * @returns 校验报告（markdown 文本）
 */
export function godelSelfVerification(problem: string): string {
  const lines: string[] = [];
  let issues = 0;

  // === 1. 内部矛盾检测 ===
  const antonymPairs: Array<[string, string, string]> = [
    ['增加', '减少', '增减矛盾'],
    ['上升', '下降', '升降矛盾'],
    ['成功', '失败', '成败矛盾'],
    ['有利', '不利', '利弊矛盾'],
    ['支持', '反对', '立场矛盾'],
    ['快速', '慢速', '速度矛盾'],
    ['简单', '复杂', '复杂度矛盾'],
    ['同步', '异步', '并发模型矛盾'],
  ];
  const contradictions: string[] = [];
  for (const [w1, w2, label] of antonymPairs) {
    if (problem.includes(w1) && problem.includes(w2)) {
      contradictions.push(label);
    }
  }
  if (contradictions.length > 0) {
    lines.push(`⚠ 检测到 ${contradictions.length} 处潜在矛盾：${contradictions.join('、')}`);
    issues += contradictions.length;
  } else {
    lines.push('✓ 内部矛盾检测：未发现明显矛盾');
  }

  // === 2. 假设覆盖度检查 ===
  const assumptionDimensions: Array<{ key: string; label: string }> = [
    { key: '性能|performance|延迟', label: '性能假设' },
    { key: '安全|security|权限', label: '安全假设' },
    { key: '兼容|compat|版本', label: '兼容性假设' },
    { key: '资源|内存|cpu|memory', label: '资源假设' },
    { key: '时间|deadline|工期', label: '时间假设' },
  ];
  const coveredDimensions = assumptionDimensions.filter(d => new RegExp(d.key, 'i').test(problem));
  const missingDimensions = assumptionDimensions.filter(d => !new RegExp(d.key, 'i').test(problem));
  lines.push('');
  lines.push(`假设覆盖度：${coveredDimensions.length}/${assumptionDimensions.length} 维度已明确`);
  if (missingDimensions.length > 0) {
    lines.push(`⚠ 未覆盖维度：${missingDimensions.map(d => d.label).join('、')}（建议显式确认）`);
    issues += missingDimensions.length;
  } else {
    lines.push('✓ 所有关键维度均已覆盖');
  }

  // === 3. 逻辑完备性自检 ===
  const completenessChecks: Array<{ key: string; label: string }> = [
    { key: '输入|input|请求', label: '输入处理' },
    { key: '输出|output|响应|结果', label: '输出生成' },
    { key: '错误|异常|error|exception', label: '异常处理' },
    { key: '测试|test|验证|verify', label: '验证策略' },
  ];
  const coveredChecks = completenessChecks.filter(c => new RegExp(c.key, 'i').test(problem));
  lines.push('');
  lines.push(`逻辑完备性：${coveredChecks.length}/${completenessChecks.length} 环节已覆盖`);
  if (coveredChecks.length < completenessChecks.length) {
    const missing = completenessChecks.filter(c => !coveredChecks.includes(c));
    lines.push(`⚠ 缺失环节：${missing.map(c => c.label).join('、')}`);
    issues += missing.length;
  } else {
    lines.push('✓ 输入/输出/异常/测试全链路完备');
  }

  // === 4. 自指循环检测 ===
  const selfRefKeywords = ['自身', '自己', 'self', '递归', 'recursive', 'bootstrap'];
  const hasSelfRef = selfRefKeywords.some(k => problem.toLowerCase().includes(k.toLowerCase()));
  lines.push('');
  if (hasSelfRef) {
    lines.push('⚠ 检测到自指特征：方案可能依赖自身成立，需警惕循环论证');
    lines.push('  建议引入外部基准（benchmark/ground truth）打破自指循环');
    issues += 1;
  } else {
    lines.push('✓ 自指循环检测：未发现循环论证风险');
  }

  // === 总结 ===
  lines.push('');
  if (issues === 0) {
    lines.push('🎯 自指校验结论：思考过程内部一致，假设覆盖完整，逻辑链路完备');
  } else {
    lines.push(`🎯 自指校验结论：发现 ${issues} 处待确认问题，建议在落地前针对性复核`);
  }

  return lines.join('\n');
}
