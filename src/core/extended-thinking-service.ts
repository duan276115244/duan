/**
 * extended-thinking-service.ts
 * 从 enhanced-agent-loop.ts 抽出的 Extended Thinking 模块
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

// ============ 主编排函数 ============

/**
 * P1-2: 执行 Extended Thinking — 多步逻辑检查 + 边缘情况枚举
 *
 * 不调用 LLM，基于规则的问题分解 + 约束识别 + 方案生成 + 边缘情况枚举。
 * 结果注入上下文，帮助 LLM 做出更好的决策。
 */
export async function runExtendedThinking(
  ctx: ExtendedThinkingContext,
  problem: string,
  depth: 'shallow' | 'medium' | 'deep',
): Promise<string> {
  const steps: string[] = [];

  // Step 1: 问题分解
  steps.push('## 问题分解');
  const subProblems = decomposeProblem(problem);
  subProblems.forEach((sp, i) => steps.push(`  ${i + 1}. ${sp}`));

  // Step 2: 约束识别
  steps.push('\n## 约束识别');
  const constraints = identifyConstraints(problem);
  if (constraints.length > 0) {
    constraints.forEach(c => steps.push(`  - ${c}`));
  } else {
    steps.push('  - 未识别到明确约束');
  }

  // Step 3: 方案生成
  if (depth !== 'shallow') {
    steps.push(`\n## 方案生成 (深度: ${depth})`);
    const solutions = generateSolutions(problem, depth === 'deep' ? 5 : 3);
    solutions.forEach((s, i) => steps.push(`  方案${i + 1}: ${s}`));
  }

  // Step 4: 边缘情况枚举
  if (depth === 'deep' || depth === 'medium') {
    steps.push('\n## 边缘情况枚举');
    const edgeCases = enumerateEdgeCases(problem);
    if (edgeCases.length > 0) {
      edgeCases.forEach(ec => steps.push(`  - ${ec}`));
    } else {
      steps.push('  - 未识别到明显边缘情况');
    }
  }

  // Step 5: 风险评估
  if (depth === 'deep') {
    steps.push('\n## 风险评估');
    steps.push('  - 注意并发安全和数据竞争');
    steps.push('  - 验证边界条件（空值、极值、溢出）');
    steps.push('  - 考虑向后兼容性和迁移成本');
  }

  // Step 6: 相关经验检索（如果有记忆系统）
  if (ctx.memoryOrchestrator) {
    try {
      const memories = await ctx.searchMemoryWithCache(problem, 3);
      if (memories && memories.length > 0) {
        steps.push('\n## 相关经验');
        memories.forEach((m: any, i: number) => {
          steps.push(`  ${i + 1}. [${m.type || 'memory'}] ${(m.content || '').substring(0, 120)}`);
        });
      }
    } catch {}
  }

  return steps.join('\n');
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
