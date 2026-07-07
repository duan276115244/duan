/**
 * 反思引擎 (Reflection Engine) — 学习循环模块5
 *
 * 核心能力：
 * 1. SOP 提取 — 从成功任务执行路径中提取标准操作流程
 * 2. 失败反思 — 分析任务失败根因，关联已有 SOP 提供修复建议
 * 3. 触发判定 — 判断何时应触发反思（成功/失败/部分完成）
 * 4. 渐进式激活 — 紧凑索引 + 按需加载详情，适配系统提示 token 预算
 * 5. 触发匹配 — 基于关键词匹配为任务输入推荐相关 SOP
 * 6. 持久化 — toJSON/fromJSON 支持外部存储
 */

import { tokenize } from './chinese-tokenizer.js';

// ============ 类型定义 ============

/** SOP 步骤 */
export interface SOPStep {
  order: number;
  description: string;
  toolHint?: string;
  expectedOutcome: string;
  alternativeAction?: string;  // 步骤失败时的替代方案
}

/** SOP 统计指标（单一数据源，原顶层字段与 metrics 已合并） */
export interface SOPMetrics {
  successCount: number;     // 成功次数
  failureCount: number;     // 失败次数
  usageCount: number;       // 使用次数 (= successCount + failureCount)
  successRate: number;      // 成功率 (0-1)
  avgDuration: number;      // 平均执行时长(ms)
  lastUsed: number;         // 最近使用时间
  lastSuccessAt?: number;   // 最近成功时间
  lastFailureAt?: number;   // 最近失败时间
}

/** 标准操作流程 */
export interface SOP {
  id: string;
  name: string;
  triggerCondition: string;  // 何时使用此技能
  prerequisites: string[];   // 前置条件（如"确认目标数据库连接权限"、"备份当前数据"）
  steps: SOPStep[];
  pitfalls: string[];        // 需要注意的事项（随失败经验自动追加）
  category: string;          // 分类：development / debugging / automation 等
  metrics: SOPMetrics;       // 统计数据（唯一数据源，通过 recordSuccess/recordFailure 更新）
  // 兼容字段：部分历史代码直接访问顶层（recordSuccess/recordFailure 已迁移到 metrics，
  // 但 extractSOPWithLLM/findSimilarSOP 等仍读顶层；二者由 recordSuccess/recordFailure 同步维护）
  successCount: number;
  failureCount: number;
  lastUsed: number;
  createdAt: number;
  version: number;
}

/** 集中更新：记录一次成功执行（唯一写入入口，避免多处各自维护造成不一致） */
export function recordSuccess(sop: SOP, durationMs: number = 0): void {
  const m = sop.metrics;
  const now = Date.now();
  m.successCount++;
  m.usageCount = m.successCount + m.failureCount;
  m.successRate = m.usageCount > 0 ? m.successCount / m.usageCount : 0;
  m.avgDuration = m.usageCount > 0
    ? (m.avgDuration * (m.usageCount - 1) + durationMs) / m.usageCount
    : durationMs;
  m.lastUsed = now;
  m.lastSuccessAt = now;
  // 同步顶层兼容字段（部分历史代码直接读 sop.successCount / sop.lastUsed）
  sop.successCount = m.successCount;
  sop.failureCount = m.failureCount;
  sop.lastUsed = now;
  sop.version++;
}

/** 集中更新：记录一次失败执行（唯一写入入口） */
export function recordFailure(sop: SOP, durationMs: number = 0): void {
  const m = sop.metrics;
  const now = Date.now();
  m.failureCount++;
  m.usageCount = m.successCount + m.failureCount;
  m.successRate = m.usageCount > 0 ? m.successCount / m.usageCount : 0;
  m.avgDuration = m.usageCount > 0
    ? (m.avgDuration * (m.usageCount - 1) + durationMs) / m.usageCount
    : durationMs;
  m.lastUsed = now;
  m.lastFailureAt = now;
  // 同步顶层兼容字段
  sop.successCount = m.successCount;
  sop.failureCount = m.failureCount;
  sop.lastUsed = now;
  sop.version++;
}

/** 任务执行路径中的单步记录 */
export interface TaskExecutionStep {
  toolName: string;
  toolArgs: Record<string, unknown>;
  result: string;
  success: boolean;
  timestamp: number;
}


/** 任务执行路径 */
export interface TaskExecutionPath {
  taskInput: string;
  steps: TaskExecutionStep[];
  finalOutcome: 'success' | 'failure' | 'partial';
  userFeedback?: 'thumbs_up' | 'thumbs_down' | 'neutral';
  duration: number;
}

/** 失败分析结果 */
export interface FailureAnalysis {
  rootCause: string;
  failedStep: number;
  suggestedFix: string;
  relatedSOPs: string[];  // 可能有助于修复的 SOP 名称
}

/** LLM 调用器接口（可选注入） */
export interface LLMCaller {
  generate(prompt: string): Promise<string>;
}

// ============ 常量 ============

const MAX_SOPS = 50;

/** 反思触发阈值：最少成功步骤数才值得提取 SOP */
const MIN_SUCCESS_STEPS_FOR_SOP = 2;

/** 反思触发阈值：最少失败步骤数才值得反思 */
const MIN_FAILURE_STEPS_FOR_REFLECTION = 1;

// ============ 主类 ============

export class ReflectionEngine {
  private sops: Map<string, SOP> = new Map();
  private llmCaller?: LLMCaller;

  constructor(llmCaller?: LLMCaller) {
    this.llmCaller = llmCaller;
  }

  // ========== SOP 提取 ==========

  /** 从成功的任务执行路径中提取 SOP */
  async extractSOP(path: TaskExecutionPath): Promise<SOP | null> {
    // 仅从成功路径提取
    if (path.finalOutcome !== 'success') return null;

    // 过滤出成功步骤（关键路径）
    const successSteps = path.steps.filter(s => s.success);
    if (successSteps.length < MIN_SUCCESS_STEPS_FOR_SOP) return null;

    // 检查是否已存在相似 SOP，若有则更新而非重复创建
    const existingSOP = this.findSimilarSOP(path.taskInput);
    if (existingSOP) {
      existingSOP.successCount++;
      existingSOP.lastUsed = Date.now();
      // 版本递增：当成功次数是 5 的倍数时升级版本
      if (existingSOP.successCount % 5 === 0) {
        existingSOP.version++;
      }
      return existingSOP;
    }

    // 容量检查：满则淘汰
    this.evictIfNeeded();

    let sop: SOP | null = null;

    if (this.llmCaller) {
      sop = await this.extractSOPWithLLM(path, successSteps);
    }

    // LLM 提取失败或不可用时，使用规则提取
    if (!sop) {
      sop = this.extractSOPByRules(path, successSteps);
    }

    if (sop) {
      this.sops.set(sop.id, sop);
    }

    return sop;
  }

  /** 使用 LLM 提取 SOP */
  private async extractSOPWithLLM(
    path: TaskExecutionPath,
    successSteps: TaskExecutionStep[],
  ): Promise<SOP | null> {
    try {
      const criticalPath = successSteps.map((s, i) =>
        `步骤${i + 1}: 工具=${s.toolName}, 参数=${JSON.stringify(s.toolArgs)}, 结果摘要=${s.result.substring(0, 200)}`,
      ).join('\n');

      const prompt = [
        '你是一个 SOP 提取专家。请从以下成功任务执行路径中提取标准操作流程（SOP）。',
        '',
        `任务输入: ${path.taskInput}`,
        `执行耗时: ${path.duration}ms`,
        '',
        '关键执行路径（仅成功步骤）:',
        criticalPath,
        '',
        '请以 JSON 格式输出 SOP，格式如下：',
        '{',
        '  "name": "简短技能名称（英文或中文，不超过20字）",',
        '  "triggerCondition": "何时应使用此技能的描述",',
        '  "steps": [',
        '    {',
        '      "order": 1,',
        '      "description": "步骤描述",',
        '      "toolHint": "推荐使用的工具名",',
        '      "expectedOutcome": "预期结果",',
        '      "alternativeAction": "此步骤失败时的替代方案"',
        '    }',
        '  ],',
        '  "pitfalls": ["需要注意的事项1", "需要注意的事项2"],',
        '  "category": "development|debugging|automation|research|configuration|general"',
        '}',
        '',
        '要求：',
        '1. 步骤描述应具体、可操作',
        '2. 触发条件应概括此类任务的共性特征',
        '3. pitfalls 应包含常见陷阱和注意事项',
        '4. 仅输出 JSON，不要输出其他内容',
      ].join('\n');

      const response = await this.llmCaller!.generate(prompt);
      const parsed = this.parseLLMResponse(response, path, successSteps);
      return parsed;
    } catch {
      // LLM 调用失败，回退到规则提取
      return null;
    }
  }

  /** 解析 LLM 返回的 SOP JSON */
  private parseLLMResponse(
    response: string,
    path: TaskExecutionPath,
    _successSteps: TaskExecutionStep[],
  ): SOP | null {
    try {
      // 尝试从响应中提取 JSON 块
      let jsonStr = response.trim();

      // 处理 markdown 代码块包裹
      const codeBlockMatch = jsonStr.match(/```(?:json)?\s*([\s\S]*?)```/);
      if (codeBlockMatch) {
        jsonStr = codeBlockMatch[1].trim();
      }

      const data = JSON.parse(jsonStr);

      if (!data.name || !Array.isArray(data.steps) || data.steps.length === 0) {
        return null;
      }

      const id = `sop_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
      const now = Date.now();

      return {
        id,
        name: String(data.name).substring(0, 50),
        triggerCondition: String(data.triggerCondition || path.taskInput.substring(0, 100)),
        prerequisites: Array.isArray(data.prerequisites)
          ? data.prerequisites.map((p: unknown) => String(p)).slice(0, 10)
          : [],
        steps: data.steps.map((s: Record<string, unknown>, i: number) => ({
          order: i + 1,
          description: String(s.description || ''),
          toolHint: s.toolHint ? String(s.toolHint) : undefined,
          expectedOutcome: String(s.expectedOutcome || ''),
          alternativeAction: s.alternativeAction ? String(s.alternativeAction) : undefined,
        })),
        pitfalls: Array.isArray(data.pitfalls)
          ? data.pitfalls.map((p: unknown) => String(p)).slice(0, 10)
          : [],
        category: this.sanitizeCategory(data.category),
        metrics: {
          successCount: 1,
          failureCount: 0,
          usageCount: 1,
          successRate: 1.0,
          avgDuration: path.duration || 0,
          lastUsed: now,
          lastSuccessAt: now,
        },
        successCount: 1,
        failureCount: 0,
        lastUsed: now,
        createdAt: now,
        version: 1,
      };
    } catch {
      return null;
    }
  }

  /** 基于规则的 SOP 提取（无 LLM 时的回退方案，增强版） */
  private extractSOPByRules(
    path: TaskExecutionPath,
    successSteps: TaskExecutionStep[],
  ): SOP {
    const id = `sop_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
    const now = Date.now();

    // 从任务输入生成名称
    const name = this.generateSOPName(path.taskInput);

    // 从任务输入提取触发条件关键词
    const triggerCondition = this.extractTriggerCondition(path.taskInput);

    // 步骤去重与合并：相同工具+相似参数的连续步骤合并
    const mergedSteps = this.mergeSimilarSteps(successSteps);

    // 从合并后的成功步骤构建 SOP 步骤（增强：具体描述+预期结果+备选方案）
    const steps: SOPStep[] = mergedSteps.map((s, i) => {
      const description = this.generateStepDescription(s);
      const expectedOutcome = this.generateExpectedOutcome(s);
      const alternativeAction = this.generateAlternativeAction(s);
      return {
        order: i + 1,
        description,
        toolHint: s.toolName,
        expectedOutcome,
        alternativeAction,
      };
    });

    // 推断分类
    const category = this.inferCategory(path.taskInput, successSteps.map(s => s.toolName));

    // 增强规则提取：基于工具模式生成前置条件
    const prerequisites = this.inferPrerequisites(successSteps);

    // 增强规则提取：基于工具和任务类型生成注意事项
    const pitfalls = this.inferPitfalls(path, successSteps);

    return {
      id,
      name,
      triggerCondition,
      prerequisites,
      steps,
      pitfalls,
      category,
      metrics: {
        successCount: 1,
        failureCount: 0,
        usageCount: 1,
        successRate: 1.0,
        avgDuration: path.duration || 0,
        lastUsed: now,
        lastSuccessAt: now,
      },
      successCount: 1,
      failureCount: 0,
      lastUsed: now,
      createdAt: now,
      version: 1,
    };
  }

  /**
   * 合并相似步骤：相同工具且参数相似的连续步骤合并为一个
   * 避免重复步骤污染 SOP 质量
   */
  private mergeSimilarSteps(steps: TaskExecutionStep[]): TaskExecutionStep[] {
    if (steps.length <= 1) return [...steps];

    const merged: TaskExecutionStep[] = [];
    for (const step of steps) {
      const last = merged[merged.length - 1];
      if (last && last.toolName === step.toolName && this.argsSimilar(last.toolArgs, step.toolArgs)) {
        // 合并：保留后一步的结果（通常更完整），累加时间戳信息
        merged[merged.length - 1] = {
          ...step,
          result: `${last.result}\n[重复执行] ${step.result}`.substring(0, 500),
        };
      } else {
        merged.push({ ...step });
      }
    }
    return merged;
  }

  /** 判断两组参数是否相似（用于步骤合并判定） */
  private argsSimilar(a: Record<string, unknown>, b: Record<string, unknown>): boolean {
    const keysA = Object.keys(a || {});
    const keysB = Object.keys(b || {});
    if (keysA.length !== keysB.length) return false;
    // 键名完全一致且值的字符串表示一致
    for (const k of keysA) {
      if (!keysB.includes(k)) return false;
      if (String(a[k]) !== String(b[k])) return false;
    }
    return true;
  }

  /** 生成具体的步骤描述（基于工具名和参数） */
  private generateStepDescription(step: TaskExecutionStep): string {
    const tool = step.toolName;
    const args = step.toolArgs || {};
    const argKeys = Object.keys(args);

    // 基于工具类型生成更具体的描述
    if (tool.includes('read') || tool.includes('cat') || tool.includes('view')) {
      const target = args.file_path || args.path || args.file || '目标文件';
      return `读取 ${this.truncate(String(target), 60)}`;
    }
    if (tool.includes('write') || tool.includes('create')) {
      const target = args.file_path || args.path || args.file || '目标文件';
      return `写入 ${this.truncate(String(target), 60)}`;
    }
    if (tool.includes('edit') || tool.includes('modify')) {
      const target = args.file_path || args.path || '目标文件';
      return `编辑 ${this.truncate(String(target), 60)}`;
    }
    if (tool.includes('search') || tool.includes('grep') || tool.includes('find')) {
      const query = args.query || args.pattern || args.search || '查询内容';
      return `搜索 "${this.truncate(String(query), 40)}"`;
    }
    if (tool.includes('execute') || tool.includes('run') || tool.includes('bash') || tool.includes('shell')) {
      const cmd = args.command || args.cmd || '命令';
      return `执行命令: ${this.truncate(String(cmd), 60)}`;
    }
    if (tool.includes('delete') || tool.includes('remove')) {
      const target = args.file_path || args.path || '目标';
      return `删除 ${this.truncate(String(target), 60)}`;
    }

    // 通用描述：包含关键参数
    if (argKeys.length > 0) {
      const mainArg = args[argKeys[0]];
      return `使用 ${tool} 处理 ${this.truncate(String(mainArg), 50)}`;
    }

    return `使用 ${tool} 执行操作`;
  }

  /** 生成具体的预期结果（基于工具类型和实际结果） */
  private generateExpectedOutcome(step: TaskExecutionStep): string {
    const tool = step.toolName.toLowerCase();
    const result = step.result || '';

    // 基于工具类型推断预期结果
    if (tool.includes('read') || tool.includes('cat')) return '成功读取文件内容';
    if (tool.includes('write') || tool.includes('create')) return '文件成功写入，无错误';
    if (tool.includes('edit')) return '文件成功修改，变更已生效';
    if (tool.includes('search') || tool.includes('grep')) {
      // 从结果推断匹配数量
      const matchCount = result.split('\n').filter(l => l.trim()).length;
      return matchCount > 0 ? `找到 ${matchCount} 个匹配结果` : '搜索完成（可能无匹配）';
    }
    if (tool.includes('execute') || tool.includes('run')) return '命令执行成功，退出码 0';
    if (tool.includes('delete')) return '目标成功删除';
    if (tool.includes('test')) return '测试通过，无失败用例';

    // 从实际结果摘要推断
    if (result.length > 0) {
      return `操作成功: ${this.truncate(result.replace(/\n/g, ' '), 80)}`;
    }

    return '操作成功完成';
  }

  /** 生成备选方案（基于工具类型） */
  private generateAlternativeAction(step: TaskExecutionStep): string | undefined {
    const tool = step.toolName.toLowerCase();

    if (tool.includes('read')) return '若读取失败，检查文件路径或权限，或尝试使用替代读取工具';
    if (tool.includes('write') || tool.includes('create')) return '若写入失败，检查目录是否存在及写入权限';
    if (tool.includes('edit')) return '若编辑失败，确认目标内容存在，或改用全文替换';
    if (tool.includes('search')) return '若无匹配，尝试放宽搜索条件或使用模糊匹配';
    if (tool.includes('execute')) return '若命令失败，检查参数正确性，或分步执行';
    if (tool.includes('delete')) return '若删除失败，确认文件未被占用';
    if (tool.includes('test')) return '若测试失败，查看失败详情并修复后重试';

    return undefined;
  }

  /** 截断字符串到指定长度 */
  private truncate(s: string, maxLen: number): string {
    return s.length > maxLen ? s.substring(0, maxLen) + '...' : s;
  }

  /**
   * 基于工具模式推断前置条件
   * 从成功执行路径中识别出执行前应满足的条件
   */
  private inferPrerequisites(steps: TaskExecutionStep[]): string[] {
    const prereqs: string[] = [];
    const tools = steps.map(s => s.toolName.toLowerCase());
    const allTools = tools.join(' ');

    // 文件操作类前置条件
    if (allTools.includes('write') || allTools.includes('edit') || allTools.includes('create')) {
      prereqs.push('确认目标目录存在且有写入权限');
    }
    if (allTools.includes('read')) {
      prereqs.push('确认目标文件存在且可读');
    }
    if (allTools.includes('delete') || allTools.includes('remove')) {
      prereqs.push('已备份重要数据（删除操作不可逆）');
    }

    // 执行类前置条件
    if (allTools.includes('execute') || allTools.includes('run') || allTools.includes('bash')) {
      prereqs.push('确认执行环境已就绪（依赖、路径配置正确）');
    }

    // 搜索类前置条件
    if (allTools.includes('search') || allTools.includes('grep')) {
      prereqs.push('确认搜索范围和关键词已明确');
    }

    // 测试类前置条件
    if (allTools.includes('test')) {
      prereqs.push('确认代码已保存且无语法错误');
    }

    // 网络类前置条件
    if (allTools.includes('fetch') || allTools.includes('request') || allTools.includes('http')) {
      prereqs.push('确认网络连接正常');
    }

    // 去重
    return Array.from(new Set(prereqs));
  }

  /**
   * 基于工具和任务类型推断注意事项
   * 从常见工具失败模式中提取经验教训
   */
  private inferPitfalls(path: TaskExecutionPath, steps: TaskExecutionStep[]): string[] {
    const pitfalls: string[] = [];
    const tools = steps.map(s => s.toolName.toLowerCase());
    const allTools = tools.join(' ');

    // 文件操作注意事项
    if (allTools.includes('edit')) {
      pitfalls.push('编辑前确认目标内容唯一匹配，避免误修改多处');
    }
    if (allTools.includes('write')) {
      pitfalls.push('写入前确认文件路径，避免覆盖重要文件');
    }
    if (allTools.includes('delete')) {
      pitfalls.push('删除前再次确认目标，避免误删');
    }

    // 执行类注意事项
    if (allTools.includes('execute') || allTools.includes('bash')) {
      pitfalls.push('执行命令前检查命令安全性，避免危险操作');
      pitfalls.push('注意命令执行的当前工作目录');
    }

    // 搜索类注意事项
    if (allTools.includes('search') || allTools.includes('grep')) {
      pitfalls.push('搜索关键词过于宽泛可能产生大量噪音结果');
    }

    // 多步骤任务注意事项
    if (steps.length >= 4) {
      pitfalls.push('任务步骤较多，建议分阶段验证中间结果');
    }

    // 耗时长的任务注意事项
    if (path.duration > 30_000) {
      pitfalls.push('任务耗时较长，注意超时风险，可考虑分批执行');
    }

    // 部分成功的任务
    if (path.finalOutcome === 'partial') {
      pitfalls.push('任务可能部分失败，需检查每步结果是否完整');
    }

    // 去重
    return Array.from(new Set(pitfalls));
  }

  // ========== 失败反思 ==========

  /** 分析任务失败原因 */
  async reflectOnFailure(path: TaskExecutionPath): Promise<FailureAnalysis> {
    // 找到第一个失败步骤
    const failedIndex = path.steps.findIndex(s => !s.success);
    const failedStep = failedIndex >= 0 ? failedIndex : path.steps.length - 1;
    const failedStepRecord = path.steps[failedStep];

    // 基础根因描述
    let rootCause = '未知原因导致任务失败';
    let suggestedFix = '建议重试或调整执行策略';

    if (failedStepRecord && !failedStepRecord.success) {
      rootCause = `步骤 ${failedStep + 1}（工具: ${failedStepRecord.toolName}）执行失败: ${failedStepRecord.result.substring(0, 200)}`;
      suggestedFix = this.suggestFixForStep(failedStepRecord);
    } else if (path.finalOutcome === 'partial') {
      rootCause = '任务部分完成，可能缺少关键步骤或步骤执行不完整';
      suggestedFix = '检查是否遗漏必要步骤，补充执行';
    }

    // LLM 增强分析（可选）
    if (this.llmCaller) {
      try {
        const enhanced = await this.enhancedFailureAnalysis(path, failedStep);
        if (enhanced) return enhanced;
      } catch {
        // LLM 分析失败，使用基础分析
      }
    }

    // 查找相关 SOP
    const relatedSOPs = this.findRelatedSOPsForFailure(path);

    return {
      rootCause,
      failedStep,
      suggestedFix,
      relatedSOPs,
    };
  }

  /** 使用 LLM 增强失败分析 */
  private async enhancedFailureAnalysis(
    path: TaskExecutionPath,
    failedStep: number,
  ): Promise<FailureAnalysis | null> {
    try {
      const stepsDesc = path.steps.map((s, i) =>
        `步骤${i + 1}: 工具=${s.toolName}, 成功=${s.success}, 结果=${s.result.substring(0, 150)}`,
      ).join('\n');

      const prompt = [
        '你是一个任务失败分析专家。请分析以下任务执行失败的原因。',
        '',
        `任务输入: ${path.taskInput}`,
        `最终结果: ${path.finalOutcome}`,
        `用户反馈: ${path.userFeedback || '无'}`,
        '',
        '执行步骤:',
        stepsDesc,
        '',
        `失败发生在步骤 ${failedStep + 1}`,
        '',
        '请以 JSON 格式输出分析结果：',
        '{',
        '  "rootCause": "失败根因的简洁描述",',
        '  "suggestedFix": "修复建议"',
        '}',
        '',
        '仅输出 JSON，不要输出其他内容。',
      ].join('\n');

      const response = await this.llmCaller!.generate(prompt);

      let jsonStr = response.trim();
      const codeBlockMatch = jsonStr.match(/```(?:json)?\s*([\s\S]*?)```/);
      if (codeBlockMatch) {
        jsonStr = codeBlockMatch[1].trim();
      }

      const data = JSON.parse(jsonStr);

      const relatedSOPs = this.findRelatedSOPsForFailure(path);

      return {
        rootCause: String(data.rootCause || '未知原因'),
        failedStep,
        suggestedFix: String(data.suggestedFix || '建议重试'),
        relatedSOPs,
      };
    } catch {
      return null;
    }
  }

  /** 为失败步骤生成修复建议 */
  private suggestFixForStep(step: TaskExecutionStep): string {
    const _toolName = step.toolName.toLowerCase();
    const result = step.result.toLowerCase();

    // 基于常见错误模式的规则建议
    if (result.includes('timeout') || result.includes('超时')) {
      return `工具 ${step.toolName} 执行超时，建议增加超时时间或缩小操作范围`;
    }
    if (result.includes('permission') || result.includes('权限') || result.includes('denied')) {
      return `工具 ${step.toolName} 权限不足，建议检查权限设置或请求用户授权`;
    }
    if (result.includes('not found') || result.includes('未找到') || result.includes('不存在')) {
      return `工具 ${step.toolName} 目标资源未找到，建议确认资源路径或先创建所需资源`;
    }
    if (result.includes('invalid') || result.includes('参数') || result.includes('argument')) {
      return `工具 ${step.toolName} 参数无效，建议检查参数格式和取值范围`;
    }
    if (result.includes('network') || result.includes('网络') || result.includes('econnrefused')) {
      return `工具 ${step.toolName} 网络错误，建议检查网络连接后重试`;
    }

    return `工具 ${step.toolName} 执行失败，建议检查输入参数或尝试替代方案`;
  }

  /** 查找与失败任务相关的 SOP */
  private findRelatedSOPsForFailure(path: TaskExecutionPath): string[] {
    const related: Array<{ name: string; score: number }> = [];

    Array.from(this.sops.values()).forEach(sop => {
      let score = 0;

      // 关键词重叠度
      const inputKeywords = this.extractKeywords(path.taskInput);
      const triggerKeywords = this.extractKeywords(sop.triggerCondition);
      const overlap = inputKeywords.filter(k => triggerKeywords.includes(k));
      score += overlap.length * 2;

      // 分类匹配
      const categoryKeywords = this.extractKeywords(sop.category);
      const categoryOverlap = inputKeywords.filter(k => categoryKeywords.includes(k));
      score += categoryOverlap.length;

      // 工具匹配：失败路径中使用的工具与 SOP 步骤中的工具提示匹配
      const failedTools = path.steps.filter(s => !s.success).map(s => s.toolName);
      const sopTools = sop.steps.map(s => s.toolHint).filter(Boolean) as string[];
      const toolOverlap = failedTools.filter(t => sopTools.includes(t));
      score += toolOverlap.length * 3;

      if (score > 0) {
        related.push({ name: sop.name, score });
      }
    });

    return related
      .sort((a, b) => b.score - a.score)
      .slice(0, 3)
      .map(r => r.name);
  }

  // ========== 触发判定 ==========

  /** 判断是否应触发反思 */
  shouldTriggerReflection(path: TaskExecutionPath): Promise<boolean> {
    // 成功路径：步骤足够多时值得提取 SOP
    if (path.finalOutcome === 'success') {
      const successSteps = path.steps.filter(s => s.success);
      return Promise.resolve(successSteps.length >= MIN_SUCCESS_STEPS_FOR_SOP);
    }

    // 失败路径：有失败步骤时值得反思
    if (path.finalOutcome === 'failure') {
      const failedSteps = path.steps.filter(s => !s.success);
      return Promise.resolve(failedSteps.length >= MIN_FAILURE_STEPS_FOR_REFLECTION);
    }

    // 部分完成：用户给出负面反馈时值得反思
    if (path.finalOutcome === 'partial') {
      return Promise.resolve(path.userFeedback === 'thumbs_down');
    }

    return Promise.resolve(false);
  }

  // ========== SOP 查询 ==========

  /** 按名称查找 SOP */
  getSOPByName(name: string): SOP | undefined {
    const found = Array.from(this.sops.values()).find(sop => sop.name === name);
    return found;
  }

  /** 按分类查找 SOP */
  getSOPsByCategory(category: string): SOP[] {
    return Array.from(this.sops.values())
      .filter(s => s.category === category)
      .sort((a, b) => b.successCount - a.successCount);
  }

  /** 按触发条件匹配 SOP（基于关键词重叠度） */
  getSOPsByTrigger(taskInput: string): SOP[] {
    const inputKeywords = this.extractKeywords(taskInput);
    if (inputKeywords.length === 0) return [];

    const scored: Array<{ sop: SOP; score: number }> = [];

    Array.from(this.sops.values()).forEach(sop => {
      const triggerKeywords = this.extractKeywords(sop.triggerCondition);
      const overlap = inputKeywords.filter(k => triggerKeywords.includes(k));

      if (overlap.length > 0) {
        // 综合评分：关键词重叠度 + 成功率权重
        const overlapRatio = overlap.length / Math.max(triggerKeywords.length, 1);
        const successRate = sop.successCount / Math.max(sop.successCount + sop.failureCount, 1);
        const score = overlapRatio * 0.6 + successRate * 0.4;
        scored.push({ sop, score });
      }
    });

    return scored
      .sort((a, b) => b.score - a.score)
      .map(s => s.sop);
  }

  /** 获取所有 SOP */
  getAllSOPs(): SOP[] {
    return Array.from(this.sops.values());
  }

  // ========== 渐进式激活 ==========

  /** 格式化 SOP 索引（紧凑格式，用于系统提示） */
  formatSOPIndexForPrompt(maxTokens?: number): string {
    const sops = Array.from(this.sops.values())
      .sort((a, b) => b.successCount - a.successCount);

    if (sops.length === 0) return '';

    // 每条索引约 30-50 token，估算可容纳条数
    const tokenBudget = maxTokens || 500;
    const estimatedTokensPerEntry = 40;
    const maxEntries = Math.min(sops.length, Math.floor(tokenBudget / estimatedTokensPerEntry));

    const lines = sops.slice(0, maxEntries).map(sop => {
      const successRate = sop.successCount / Math.max(sop.successCount + sop.failureCount, 1);
      return `• ${sop.name} [${sop.category}] 触发: ${sop.triggerCondition.substring(0, 60)} (成功率${Math.round(successRate * 100)}%)`;
    });

    return `## 可用技能 SOP（共${sops.length}个）\n${lines.join('\n')}\n提示: 使用 formatSOPDetailForPrompt 查看具体步骤`;
  }

  /** 格式化 SOP 详情（完整格式，按需加载） */
  formatSOPDetailForPrompt(name: string): string {
    const sop = this.getSOPByName(name);
    if (!sop) return `未找到名为 "${name}" 的 SOP`;

    const successRate = sop.successCount / Math.max(sop.successCount + sop.failureCount, 1);

    const prerequisitesText = sop.prerequisites.length > 0
      ? `\n前置条件:\n${sop.prerequisites.map(p => `  ✓ ${p}`).join('\n')}`
      : '';

    const stepsText = sop.steps.map(s => {
      let line = `  ${s.order}. ${s.description}`;
      if (s.toolHint) line += ` [工具: ${s.toolHint}]`;
      line += `\n     预期: ${s.expectedOutcome}`;
      if (s.alternativeAction) line += `\n     备选: ${s.alternativeAction}`;
      return line;
    }).join('\n');

    const pitfallsText = sop.pitfalls.length > 0
      ? `\n注意事项:\n${sop.pitfalls.map(p => `  ⚠ ${p}`).join('\n')}`
      : '';

    const metricsText = `\n指标: 成功率${Math.round(successRate * 100)}% | 使用${sop.metrics.usageCount}次 | 平均${Math.round(sop.metrics.avgDuration / 1000)}s`;

    return [
      `## SOP: ${sop.name}`,
      `分类: ${sop.category} | 版本: v${sop.version} | 成功率: ${Math.round(successRate * 100)}% (${sop.successCount}次成功/${sop.failureCount}次失败)`,
      `触发条件: ${sop.triggerCondition}`,
      prerequisitesText,
      `步骤:`,
      stepsText,
      pitfallsText,
      metricsText,
    ].join('\n');
  }

  // ========== 持久化 ==========

  /** 序列化为 JSON */
  toJSON(): object {
    return {
      sops: Array.from(this.sops.values()),
    };
  }

  /** 从 JSON 反序列化 */
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  fromJSON(data: any): void {
    if (!data || !Array.isArray(data.sops)) return;

    this.sops.clear();
    for (const sop of data.sops) {
      if (sop && sop.id && sop.name) {
        this.sops.set(sop.id, sop as SOP);
      }
    }
  }

  // ========== 私有方法 ==========

  /** 查找与任务输入相似的已有 SOP */
  private findSimilarSOP(taskInput: string): SOP | null {
    const inputKeywords = this.extractKeywords(taskInput);

    const found = Array.from(this.sops.values()).find(sop => {
      const triggerKeywords = this.extractKeywords(sop.triggerCondition);
      const overlap = inputKeywords.filter(k => triggerKeywords.includes(k));
      // 超过 50% 关键词重叠视为相似
      return overlap.length > 0 && overlap.length >= inputKeywords.length * 0.5;
    });

    return found || null;
  }

  /** 容量淘汰：满时移除成功率最低的 SOP */
  private evictIfNeeded(): void {
    if (this.sops.size < MAX_SOPS) return;

    // 找到成功率最低的 SOP
    let lowestSOP: SOP | undefined;
    let lowestScore = Infinity;

    Array.from(this.sops.values()).forEach(sop => {
      const score = sop.successCount - sop.failureCount;
      if (score < lowestScore) {
        lowestScore = score;
        lowestSOP = sop;
      }
    });

    if (lowestSOP) {
      // Map is keyed by sop.id (set at insertion), not by name.
      // Previously deleted by name, which silently failed and caused unbounded growth.
      this.sops.delete(lowestSOP.id);
    }
  }

  /** 从任务输入生成 SOP 名称 */
  private generateSOPName(taskInput: string): string {
    // 取任务输入的前 20 个有效字符作为名称
    const cleaned = taskInput
      .replace(/[^\w\u4e00-\u9fff]/g, '')
      .substring(0, 20);
    return cleaned || `SOP_${Date.now()}`;
  }

  /** 从任务输入提取触发条件 */
  private extractTriggerCondition(taskInput: string): string {
    // 提取关键词作为触发条件
    const keywords = this.extractKeywords(taskInput);
    if (keywords.length === 0) return taskInput.substring(0, 100);
    return `当任务涉及 ${keywords.slice(0, 5).join('、')} 时`;
  }

  /** 关键词提取（简单分词：按空格/标点分割，过滤停用词） */
  private extractKeywords(text: string): string[] {
    if (!text) return [];

    // 中文停用词
    const stopWords = new Set([
      '的', '了', '在', '是', '我', '有', '和', '就', '不', '人', '都', '一', '一个',
      '上', '也', '很', '到', '说', '要', '去', '你', '会', '着', '没有', '看', '好',
      '自己', '这', '他', '她', '它', '们', '那', '些', '什么', '怎么', '如何',
      'the', 'a', 'an', 'is', 'are', 'was', 'were', 'be', 'been', 'being',
      'have', 'has', 'had', 'do', 'does', 'did', 'will', 'would', 'could',
      'should', 'may', 'might', 'can', 'shall', 'to', 'of', 'in', 'for',
      'on', 'with', 'at', 'by', 'from', 'as', 'into', 'through',
    ]);

    // 中文分词：使用统一的中文分词工具替代简单的标点分割
    const tokens = tokenize(text)
      .filter(t => t.length > 0 && !stopWords.has(t));

    return Array.from(new Set(tokens));
  }

  /** 推断 SOP 分类 */
  private inferCategory(taskInput: string, tools: string[]): string {
    const input = taskInput.toLowerCase();

    if (input.includes('调试') || input.includes('debug') || input.includes('修复') || input.includes('bug')) {
      return 'debugging';
    }
    if (input.includes('自动化') || input.includes('automate') || input.includes('脚本') || input.includes('批量')) {
      return 'automation';
    }
    if (input.includes('搜索') || input.includes('查询') || input.includes('研究') || input.includes('research')) {
      return 'research';
    }
    if (input.includes('配置') || input.includes('设置') || input.includes('安装') || input.includes('部署')) {
      return 'configuration';
    }
    if (input.includes('开发') || input.includes('编码') || input.includes('实现') || input.includes('创建')) {
      return 'development';
    }
    if (tools.some(t => t.includes('write') || t.includes('edit') || t.includes('create'))) {
      return 'development';
    }
    if (tools.some(t => t.includes('search') || t.includes('fetch') || t.includes('query'))) {
      return 'research';
    }
    if (tools.some(t => t.includes('execute') || t.includes('run') || t.includes('script'))) {
      return 'automation';
    }

    return 'general';
  }

  /** 校验分类值 */
  private sanitizeCategory(category: string): string {
    const valid = ['development', 'debugging', 'automation', 'research', 'configuration', 'general'];
    const lower = String(category).toLowerCase().trim();
    return valid.includes(lower) ? lower : 'general';
  }
}
