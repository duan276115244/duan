/**
 * Agent Teams 工作流编排引擎 — WorkflowEngine
 *
 * 子系统一: Agent Teams 协同模式
 * 基于 YAML 定义的工作流，编排多个 SubAgent 在 DAG（有向无环图）中协同执行
 *
 * 核心能力：
 * 1. YAML 工作流定义解析（无外部依赖的轻量解析器）
 * 2. DAG 依赖拓扑排序 + 并行分组
 * 3. 按层级并发执行（受 maxParallel 限制）
 * 4. 上下文传递：已完成步骤的结果自动注入依赖步骤
 * 5. 失败策略：stop / skip / retry 全局策略 + 步骤级 retryOnFailure
 * 6. 循环依赖检测（DFS 三色标记法）
 * 7. 工作流验证：结构完整性、依赖可达性、循环检测
 */

import * as fs from 'fs';
import * as path from 'path';

// ============ 类型定义 ============

/** 工作流步骤定义 */
export interface WorkflowStep {
  id: string;
  agent: string;            // SubAgent 角色名（如 "code-analyzer"）
  action: string;           // 本步骤的任务描述
  depends_on?: string[];    // 前置步骤 ID 列表
  model?: string;           // 可选模型覆盖
  allowedTools?: string[];  // 可选工具白名单覆盖
  maxTurns?: number;        // 可选最大轮次覆盖
  timeout?: number;         // 可选超时时间（毫秒）
  retryOnFailure?: boolean; // 失败时是否重试
}

/** 工作流定义 */
export interface WorkflowDefinition {
  name: string;
  description?: string;
  steps: WorkflowStep[];
  onFailure?: 'stop' | 'skip' | 'retry'; // 全局失败策略
  maxParallel?: number;   // 最大并发 Agent 数（默认 3）
}

/** 单步骤执行结果 */
export interface StepResult {
  stepId: string;
  agent: string;
  status: 'completed' | 'failed' | 'skipped' | 'running';
  summary: string;
  duration: number;
  error?: string;
}

/** 工作流执行结果 */
export interface WorkflowResult {
  workflowName: string;
  status: 'completed' | 'failed' | 'partial';
  steps: StepResult[];
  totalDuration: number;
  summary: string;         // 汇总所有步骤结果的整体摘要
}

/** SubAgent 调度器接口（引擎所需的外部依赖） */
export interface SubAgentDispatcher {
  dispatch(
    role: string,
    task: string,
    allowedTools?: string[],
    options?: { model?: string; maxTurns?: number },
  ): Promise<string>;
}

// ============ 简易 YAML 解析器 ============

/**
 * 轻量 YAML 解析器，仅覆盖工作流定义所需的子集：
 * - 顶层标量（name, description, on_failure, max_parallel）
 * - steps 数组（含嵌套字段：id, agent, action, depends_on, model, allowed_tools, max_turns, timeout, retry_on_failure）
 * - 字符串、数字、布尔值、字符串数组
 *
 * 不支持：多文档、锚点/别名、复杂映射等完整 YAML 特性
 */
class SimpleYAMLParser {
  /** 解析 YAML 字符串为 WorkflowDefinition */
  parse(yaml: string): WorkflowDefinition {
    const lines = yaml.split('\n');
    const root = this.parseLines(lines, 0, lines.length);
    return this.toWorkflowDefinition(root);
  }

  /** 将解析后的对象转为 WorkflowDefinition */
  private toWorkflowDefinition(obj: Record<string, unknown>): WorkflowDefinition {
    const steps: WorkflowStep[] = [];
    const rawSteps = obj['steps'];
    if (Array.isArray(rawSteps)) {
      for (const raw of rawSteps) {
        const step: WorkflowStep = {
          id: String(raw['id'] || ''),
          agent: String(raw['agent'] || ''),
          action: String(raw['action'] || ''),
        };
        if (raw['depends_on'] !== undefined) {
          step.depends_on = this.toStringArray(raw['depends_on']);
        }
        if (raw['model'] !== undefined) step.model = String(raw['model']);
        if (raw['allowed_tools'] !== undefined) {
          step.allowedTools = this.toStringArray(raw['allowed_tools']);
        }
        if (raw['max_turns'] !== undefined) step.maxTurns = Number(raw['max_turns']);
        if (raw['timeout'] !== undefined) step.timeout = Number(raw['timeout']);
        if (raw['retry_on_failure'] !== undefined) {
          step.retryOnFailure = this.toBoolean(raw['retry_on_failure']);
        }
        steps.push(step);
      }
    }

    const onFailure = obj['on_failure'];
    const maxParallel = obj['max_parallel'];

    return {
      name: String(obj['name'] || ''),
      description: obj['description'] !== undefined ? String(obj['description']) : undefined,
      steps,
      onFailure: this.toOnFailure(onFailure),
      maxParallel: maxParallel !== undefined ? Number(maxParallel) : undefined,
    };
  }

  /** 逐行解析，返回嵌套对象 */
  private parseLines(lines: string[], start: number, end: number): Record<string, unknown> {
    const result: Record<string, unknown> = {};
    let i = start;

    while (i < end) {
      const line = lines[i];
      const trimmed = line.trimStart();

      // 跳过空行和注释
      if (trimmed === '' || trimmed.startsWith('#')) {
        i++;
        continue;
      }

      const indent = line.length - trimmed.length;

      // 解析列表项（如 "- id: xxx"）
      if (trimmed.startsWith('- ')) {
        const listKey = this.findParentListKey(lines, i, start);
        if (!result[listKey]) result[listKey] = [];

        const itemContent = trimmed.substring(2);
        // 列表项是内联标量（如 "- stop"）
        if (!itemContent.includes(':')) {
          (result[listKey] as unknown[]).push(this.parseScalar(itemContent.trim()));
          i++;
          continue;
        }
        // 列表项是映射（如 "- id: xxx"）
        const item: Record<string, unknown> = {};
        const firstField = this.parseKeyValue(itemContent);
        if (firstField) item[firstField.key] = firstField.value;

        i++;
        // 收集同缩进层级的后续字段
        while (i < end) {
          const nextLine = lines[i];
          const nextTrimmed = nextLine.trimStart();
          if (nextTrimmed === '' || nextTrimmed.startsWith('#')) { i++; continue; }
          const nextIndent = nextLine.length - nextTrimmed.length;
          if (nextIndent <= indent) break;
          // 子列表或子字段
          if (nextTrimmed.startsWith('- ')) {
            // 内联列表项
            const subItem = nextTrimmed.substring(2).trim();
            const lastKey = Object.keys(item).pop();
            if (lastKey && Array.isArray(item[lastKey])) {
              (item[lastKey] as unknown[]).push(this.parseScalar(subItem));
            } else {
              // 找最近一个可能是数组的键
              const arrKey = this.findLastListFieldKey(item);
              if (arrKey) {
                if (!Array.isArray(item[arrKey])) item[arrKey] = [];
                (item[arrKey] as unknown[]).push(this.parseScalar(subItem));
              }
            }
            i++;
          } else {
            const kv = this.parseKeyValue(nextTrimmed);
            if (kv) {
              // 检查下一行是否为该字段的列表
              const peekI = i + 1;
              if (peekI < end) {
                const peekLine = lines[peekI];
                const peekTrimmed = peekLine.trimStart();
                const peekIndent = peekLine.length - peekTrimmed.length;
                if (peekTrimmed.startsWith('- ') && peekIndent > nextIndent) {
                  // 该字段值是列表
                  item[kv.key] = [];
                  i = peekI;
                  const listIndent = peekIndent;
                  while (i < end) {
                    const liLine = lines[i];
                    const liTrimmed = liLine.trimStart();
                    if (liTrimmed === '' || liTrimmed.startsWith('#')) { i++; continue; }
                    const liIndent = liLine.length - liTrimmed.length;
                    if (liIndent < listIndent) break;
                    if (liIndent === listIndent && liTrimmed.startsWith('- ')) {
                      (item[kv.key] as unknown[]).push(this.parseScalar(liTrimmed.substring(2).trim()));
                      i++;
                    } else {
                      break;
                    }
                  }
                  continue;
                }
              }
              item[kv.key] = kv.value;
              i++;
            } else {
              i++;
            }
          }
        }
        (result[listKey] as unknown[]).push(item);
        continue;
      }

      // 解析键值对
      const kv = this.parseKeyValue(trimmed);
      if (kv) {
        // 检查下一行是否为该键的列表值
        const peekI = i + 1;
        if (peekI < end) {
          const peekLine = lines[peekI];
          const peekTrimmed = peekLine.trimStart();
          const peekIndent = peekLine.length - peekTrimmed.length;
          if (peekTrimmed.startsWith('- ') && peekIndent > indent) {
            // 该键的值是列表
            result[kv.key] = [];
            i = peekI;
            const listIndent = peekIndent;
            while (i < end) {
              const liLine = lines[i];
              const liTrimmed = liLine.trimStart();
              if (liTrimmed === '' || liTrimmed.startsWith('#')) { i++; continue; }
              const liIndent = liLine.length - liTrimmed.length;
              if (liIndent < listIndent) break;
              if (liIndent === listIndent && liTrimmed.startsWith('- ')) {
                (result[kv.key] as unknown[]).push(this.parseScalar(liTrimmed.substring(2).trim()));
                i++;
              } else {
                break;
              }
            }
            continue;
          }
        }
        result[kv.key] = kv.value;
        i++;
      } else {
        i++;
      }
    }

    return result;
  }

  /** 解析单行键值对 */
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  private parseKeyValue(line: string): { key: string; value: any } | null {
    // 找第一个未被引号包裹的冒号
    let colonIdx = -1;
    let inQuote = false;
    let quoteChar = '';
    for (let c = 0; c < line.length; c++) {
      const ch = line[c];
      if (inQuote) {
        if (ch === quoteChar) inQuote = false;
        continue;
      }
      if (ch === '"' || ch === "'") {
        inQuote = true;
        quoteChar = ch;
        continue;
      }
      if (ch === ':') {
        // 冒号后是空格或行尾
        if (c + 1 === line.length || line[c + 1] === ' ') {
          colonIdx = c;
          break;
        }
      }
    }

    if (colonIdx === -1) return null;

    const key = line.substring(0, colonIdx).trim();
    const rawValue = line.substring(colonIdx + 1).trim();

    return { key: this.yamlKeyToCamel(key), value: this.parseScalar(rawValue) };
  }

  /** YAML 键名转驼峰（snake_case → camelCase） */
  private yamlKeyToCamel(key: string): string {
    return key.replace(/_([a-z])/g, (_, c) => c.toUpperCase());
  }

  /** 解析标量值 */
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  private parseScalar(raw: string): any {
    if (raw === '' || raw === '~' || raw === 'null') return null;
    if (raw === 'true') return true;
    if (raw === 'false') return false;

    // 去除引号
    if ((raw.startsWith('"') && raw.endsWith('"')) ||
        (raw.startsWith("'") && raw.endsWith("'"))) {
      return raw.substring(1, raw.length - 1);
    }

    // 尝试数字
    const num = Number(raw);
    if (!isNaN(num) && raw !== '') return num;

    return raw;
  }

  /** 查找当前列表项应归属的父级列表键名 */
  private findParentListKey(lines: string[], currentLine: number, startLine: number): string {
    for (let j = currentLine - 1; j >= startLine; j--) {
      const prev = lines[j].trimStart();
      if (prev === '' || prev.startsWith('#') || prev.startsWith('- ')) continue;
      const kv = this.parseKeyValue(prev);
      if (kv) return kv.key;
    }
    return 'items';
  }

  /** 在映射中查找最近一个值为数组的键名 */
  private findLastListFieldKey(obj: Record<string, unknown>): string | null {
    const keys = Object.keys(obj);
    for (let i = keys.length - 1; i >= 0; i--) {
      if (Array.isArray(obj[keys[i]])) return keys[i];
    }
    return null;
  }

  /** 转为字符串数组 */
  private toStringArray(val: unknown): string[] {
    if (Array.isArray(val)) return val.map(v => String(v));
    if (typeof val === 'string') return [val];
    return [];
  }

  /** 转为布尔值 */
  private toBoolean(val: unknown): boolean {
    if (typeof val === 'boolean') return val;
    if (typeof val === 'string') return val.toLowerCase() === 'true';
    return !!val;
  }

  /** 转为 onFailure 枚举 */
  private toOnFailure(val: unknown): 'stop' | 'skip' | 'retry' | undefined {
    if (val === 'stop' || val === 'skip' || val === 'retry') return val;
    return undefined;
  }
}

// ============ 主类 ============

export class WorkflowEngine {
  private dispatcher: SubAgentDispatcher;
  private yamlParser: SimpleYAMLParser;
  /** 已加载的工作流定义（按名称索引） */
  private loadedWorkflows: Map<string, WorkflowDefinition> = new Map();

  constructor(subAgentDispatcher: SubAgentDispatcher) {
    this.dispatcher = subAgentDispatcher;
    this.yamlParser = new SimpleYAMLParser();
  }

  /**
   * 从目录加载 YAML 工作流定义文件
   * @param dirPath workflows 目录路径（默认为项目根目录下的 workflows/）
   * @returns 成功加载的工作流数量
   */
  loadWorkflowsFromDirectory(dirPath: string = path.join(process.cwd(), 'workflows')): number {
    let loaded = 0;
    try {
      if (!fs.existsSync(dirPath)) return 0;
      const files = fs.readdirSync(dirPath).filter((f: string) => f.endsWith('.yaml') || f.endsWith('.yml'));
      for (const file of files) {
        try {
          const filePath = path.join(dirPath, file);
          const content = fs.readFileSync(filePath, 'utf-8');
          const workflow = this.yamlParser.parse(content);
          const validation = this.validate(workflow);
          if (validation.valid && workflow.name) {
            this.loadedWorkflows.set(workflow.name, workflow);
            loaded++;
          }
        } catch {
          // 单个文件解析失败，跳过
        }
      }
    } catch {
      // 目录读取失败，静默降级
    }
    return loaded;
  }

  /**
   * 获取已加载的工作流名称列表
   */
  listWorkflows(): string[] {
    return Array.from(this.loadedWorkflows.keys());
  }

  /**
   * 按名称获取已加载的工作流定义
   */
  getWorkflow(name: string): WorkflowDefinition | null {
    return this.loadedWorkflows.get(name) || null;
  }

  /**
   * 按名称执行已加载的工作流
   * @param name 工作流名称
   * @param context 可选的初始上下文
   * @returns 工作流执行结果，若工作流不存在则返回失败结果
   */
  runWorkflow(name: string, context?: Record<string, unknown>): Promise<WorkflowResult> {
    const workflow = this.loadedWorkflows.get(name);
    if (!workflow) {
      return Promise.resolve({
        workflowName: name,
        status: 'failed',
        steps: [],
        totalDuration: 0,
        summary: `工作流 "${name}" 未找到。可用工作流: ${this.listWorkflows().join(', ') || '无'}`,
      });
    }
    return this.execute(workflow, context);
  }

  /**
   * 解析 YAML 工作流定义
   * @param yamlString YAML 格式的工作流定义
   * @returns 工作流定义对象
   */
  parseYAML(yamlString: string): WorkflowDefinition {
    return this.yamlParser.parse(yamlString);
  }

  /**
   * 验证工作流定义
   * 检查：步骤 ID 唯一性、依赖引用存在性、循环依赖、空步骤
   * @param workflow 工作流定义
   * @returns 验证结果
   */
  validate(workflow: WorkflowDefinition): { valid: boolean; errors: string[] } {
    const errors: string[] = [];

    // 检查名称
    if (!workflow.name || workflow.name.trim() === '') {
      errors.push('工作流名称不能为空');
    }

    // 检查步骤
    if (!workflow.steps || workflow.steps.length === 0) {
      errors.push('工作流必须包含至少一个步骤');
      return { valid: false, errors };
    }

    // 步骤 ID 唯一性
    const idSet = new Set<string>();
    for (const step of workflow.steps) {
      if (!step.id || step.id.trim() === '') {
        errors.push(`存在空 ID 的步骤（agent: ${step.agent}）`);
        continue;
      }
      if (idSet.has(step.id)) {
        errors.push(`步骤 ID 重复: "${step.id}"`);
      }
      idSet.add(step.id);

      // 检查 agent 和 action
      if (!step.agent || step.agent.trim() === '') {
        errors.push(`步骤 "${step.id}" 缺少 agent 字段`);
      }
      if (!step.action || step.action.trim() === '') {
        errors.push(`步骤 "${step.id}" 缺少 action 字段`);
      }
    }

    // 依赖引用存在性
    for (const step of workflow.steps) {
      if (step.depends_on) {
        for (const depId of step.depends_on) {
          if (!idSet.has(depId)) {
            errors.push(`步骤 "${step.id}" 引用了不存在的依赖: "${depId}"`);
          }
          if (depId === step.id) {
            errors.push(`步骤 "${step.id}" 不能依赖自身`);
          }
        }
      }
    }

    // 循环依赖检测（DFS 三色标记法）
    const cycleErrors = this.detectCycles(workflow);
    errors.push(...cycleErrors);

    // 孤立步骤检测（无依赖且不被任何步骤依赖的步骤，仅当步骤数 > 1 时警告）
    if (workflow.steps.length > 1) {
      const dependedBy = new Set<string>();
      for (const step of workflow.steps) {
        if (step.depends_on) {
          for (const depId of step.depends_on) {
            dependedBy.add(depId);
          }
        }
      }
      // 孤立步骤不一定是错误，但可能表示遗漏了依赖关系
      // 此处不作为错误，仅在步骤全部无依赖且数量 > 1 时提示
    }

    return { valid: errors.length === 0, errors };
  }

  /**
   * 获取执行顺序（拓扑排序结果，按并行层级分组）
   * @param workflow 工作流定义
   * @returns 二维数组，每个内层数组代表可并行执行的步骤 ID 组
   */
  getExecutionOrder(workflow: WorkflowDefinition): string[][] {
    const stepMap = new Map(workflow.steps.map(s => [s.id, s]));
    const _visited = new Set<string>();
    const levels = new Map<string, number>();

    // 计算每个步骤的层级（最长依赖链深度）
    const computeLevel = (stepId: string, path: Set<string> = new Set()): number => {
      if (levels.has(stepId)) return levels.get(stepId)!;
      if (path.has(stepId)) return 0; // 循环依赖保护
      path.add(stepId);

      const step = stepMap.get(stepId);
      if (!step || !step.depends_on || step.depends_on.length === 0) {
        levels.set(stepId, 0);
        return 0;
      }

      let maxDepLevel = 0;
      for (const depId of step.depends_on) {
        if (stepMap.has(depId)) {
          const depLevel = computeLevel(depId, path);
          maxDepLevel = Math.max(maxDepLevel, depLevel);
        }
      }

      const level = maxDepLevel + 1;
      levels.set(stepId, level);
      return level;
    };

    for (const step of workflow.steps) {
      computeLevel(step.id);
    }

    // 按层级分组
    const groups: Map<number, string[]> = new Map();
    levels.forEach((level, stepId) => {
      const group = groups.get(level) || [];
      group.push(stepId);
      groups.set(level, group);
    });

    // 按层级排序输出
    const sortedLevels: number[] = [];
    groups.forEach((_, level) => sortedLevels.push(level));
    sortedLevels.sort((a, b) => a - b);
    return sortedLevels.map(level => groups.get(level)!);
  }

  /**
   * 执行工作流
   * @param workflow 工作流定义
   * @param context 可选的初始上下文
   * @returns 工作流执行结果
   */
  async execute(
    workflow: WorkflowDefinition,
    context?: Record<string, unknown>,
  ): Promise<WorkflowResult> {
    const startTime = Date.now();
    const maxParallel = workflow.maxParallel ?? 3;
    const onFailure = workflow.onFailure ?? 'stop';

    // 验证工作流
    const validation = this.validate(workflow);
    if (!validation.valid) {
      return {
        workflowName: workflow.name,
        status: 'failed',
        steps: [],
        totalDuration: Date.now() - startTime,
        summary: `工作流验证失败: ${validation.errors.join('; ')}`,
      };
    }

    // 获取执行顺序
    const executionGroups = this.getExecutionOrder(workflow);
    const stepMap = new Map(workflow.steps.map(s => [s.id, s]));

    // 存储已完成步骤的结果，用于上下文传递
    const completedResults = new Map<string, StepResult>();
    const allResults: StepResult[] = [];
    let workflowFailed = false;

    // 逐层执行
    for (const group of executionGroups) {
      if (workflowFailed && onFailure === 'stop') {
        // stop 策略：将剩余步骤标记为 skipped
        for (const stepId of group) {
          const step = stepMap.get(stepId)!;
          allResults.push({
            stepId,
            agent: step.agent,
            status: 'skipped',
            summary: '因前置步骤失败而跳过',
            duration: 0,
          });
        }
        continue;
      }

      // 检查组内步骤的依赖是否都已完成
      const readyStepIds = group.filter(stepId => {
        const step = stepMap.get(stepId)!;
        if (!step.depends_on) return true;
        return step.depends_on.every(depId => {
          const depResult = completedResults.get(depId);
          return depResult && (depResult.status === 'completed' || depResult.status === 'skipped');
        });
      });

      // 受 maxParallel 限制，分批执行
      const batches = this.batchSteps(readyStepIds, maxParallel);

      for (const batch of batches) {
        const batchPromises = batch.map((stepId) => {
          const step = stepMap.get(stepId)!;

          // 如果工作流已失败且策略为 stop，跳过
          if (workflowFailed && onFailure === 'stop') {
            return Promise.resolve({
              stepId,
              agent: step.agent,
              status: 'skipped' as const,
              summary: '因前置步骤失败而跳过',
              duration: 0,
            });
          }

          // 构建上下文：将依赖步骤的结果注入任务描述
          const enrichedAction = this.enrichActionWithContext(step, completedResults, context);

          // 执行步骤（含重试逻辑）
          return this.executeStep(step, enrichedAction, onFailure);
        });

        const batchResults = await Promise.all(batchPromises);

        for (const result of batchResults) {
          allResults.push(result);
          completedResults.set(result.stepId, result);

          // 检查是否需要标记工作流失败
          if (result.status === 'failed') {
            workflowFailed = true;
          }
        }
      }
    }

    // 生成整体摘要
    const totalDuration = Date.now() - startTime;
    const summary = this.generateSummary(workflow.name, allResults, totalDuration);

    // 判定工作流状态
    const completedCount = allResults.filter(r => r.status === 'completed').length;
    const failedCount = allResults.filter(r => r.status === 'failed').length;
    const skippedCount = allResults.filter(r => r.status === 'skipped').length;

    let status: WorkflowResult['status'];
    if (failedCount === 0 && skippedCount === 0) {
      status = 'completed';
    } else if (completedCount === 0) {
      status = 'failed';
    } else {
      status = 'partial';
    }

    return {
      workflowName: workflow.name,
      status,
      steps: allResults,
      totalDuration,
      summary,
    };
  }

  // ============ 私有方法 ============

  /**
   * 执行单个步骤（含重试和超时逻辑）
   */
  private async executeStep(
    step: WorkflowStep,
    enrichedAction: string,
    globalOnFailure: 'stop' | 'skip' | 'retry',
  ): Promise<StepResult> {
    const shouldRetry = step.retryOnFailure ?? (globalOnFailure === 'retry');
    const maxAttempts = shouldRetry ? 2 : 1; // 最多重试1次
    const timeout = step.timeout ?? 120000; // 默认 2 分钟超时

    let lastError: string | undefined;

    for (let attempt = 0; attempt < maxAttempts; attempt++) {
      const stepStart = Date.now();

      try {
        // 带超时的 dispatch
        const result = await Promise.race([
          this.dispatcher.dispatch(
            step.agent,
            enrichedAction,
            step.allowedTools,
            { model: step.model, maxTurns: step.maxTurns },
          ),
          new Promise<never>((_, reject) =>
            setTimeout(() => reject(new Error(`步骤超时（${timeout}ms）`)), timeout),
          ),
        ]);

        return {
          stepId: step.id,
          agent: step.agent,
          status: 'completed',
          summary: result,
          duration: Date.now() - stepStart,
        };
      } catch (err: unknown) {
        lastError = (err instanceof Error ? err.message : String(err));
      }
    }

    // 所有尝试均失败
    return {
      stepId: step.id,
      agent: step.agent,
      status: 'failed',
      summary: `执行失败: ${lastError}`,
      duration: 0,
      error: lastError,
    };
  }

  /**
   * 将已完成步骤的结果注入当前步骤的任务描述
   * 格式：[前置步骤结果] stepId (agent): summary
   */
  private enrichActionWithContext(
    step: WorkflowStep,
    completedResults: Map<string, StepResult>,
    globalContext?: Record<string, unknown>,
  ): string {
    const parts: string[] = [];

    // 注入全局上下文
    if (globalContext && Object.keys(globalContext).length > 0) {
      parts.push(`[全局上下文] ${JSON.stringify(globalContext)}`);
    }

    // 注入依赖步骤的结果
    if (step.depends_on && step.depends_on.length > 0) {
      for (const depId of step.depends_on) {
        const depResult = completedResults.get(depId);
        if (depResult && depResult.status === 'completed') {
          // 截断过长结果，避免上下文膨胀
          const truncatedSummary = depResult.summary.length > 800
            ? depResult.summary.substring(0, 800) + '...'
            : depResult.summary;
          parts.push(`[前置步骤 ${depId} (${depResult.agent}) 结果] ${truncatedSummary}`);
        }
      }
    }

    if (parts.length > 0) {
      return `${parts.join('\n')}\n\n[当前任务] ${step.action}`;
    }

    return step.action;
  }

  /**
   * 将步骤 ID 列表分批（受 maxParallel 限制）
   */
  private batchSteps(stepIds: string[], maxParallel: number): string[][] {
    const batches: string[][] = [];
    for (let i = 0; i < stepIds.length; i += maxParallel) {
      batches.push(stepIds.slice(i, i + maxParallel));
    }
    return batches;
  }

  /**
   * DFS 三色标记法检测循环依赖
   * WHITE=0（未访问）, GRAY=1（正在访问）, BLACK=2（已完成）
   */
  private detectCycles(workflow: WorkflowDefinition): string[] {
    const errors: string[] = [];
    const stepMap = new Map(workflow.steps.map(s => [s.id, s]));
    const WHITE = 0, GRAY = 1, BLACK = 2;
    const color = new Map<string, number>();

    for (const step of workflow.steps) {
      color.set(step.id, WHITE);
    }

    const dfs = (stepId: string, path: string[]): boolean => {
      color.set(stepId, GRAY);
      const step = stepMap.get(stepId);

      if (step && step.depends_on) {
        for (const depId of step.depends_on) {
          if (!color.has(depId)) continue; // 引用不存在的依赖，由 validate 其他逻辑处理
          const depColor = color.get(depId);
          if (depColor === GRAY) {
            // 发现环
            const cycleStart = path.indexOf(depId);
            const cyclePath = cycleStart >= 0
              ? [...path.slice(cycleStart), depId].join(' → ')
              : `${depId} → ${stepId}`;
            errors.push(`检测到循环依赖: ${cyclePath}`);
            return true;
          }
          if (depColor === WHITE) {
            if (dfs(depId, [...path, depId])) return true;
          }
        }
      }

      color.set(stepId, BLACK);
      return false;
    };

    for (const step of workflow.steps) {
      if (color.get(step.id) === WHITE) {
        dfs(step.id, [step.id]);
      }
    }

    return errors;
  }

  /**
   * 生成工作流执行摘要
   */
  private generateSummary(
    workflowName: string,
    results: StepResult[],
    totalDuration: number,
  ): string {
    const completed = results.filter(r => r.status === 'completed');
    const failed = results.filter(r => r.status === 'failed');
    const skipped = results.filter(r => r.status === 'skipped');

    const durationSec = (totalDuration / 1000).toFixed(1);

    let summary = `工作流 "${workflowName}" 执行完成，耗时 ${durationSec}s。\n`;
    summary += `总计 ${results.length} 个步骤：${completed.length} 完成，${failed.length} 失败，${skipped.length} 跳过。\n`;

    if (completed.length > 0) {
      summary += '\n已完成步骤:\n';
      for (const r of completed) {
        const shortSummary = r.summary.length > 100
          ? r.summary.substring(0, 100) + '...'
          : r.summary;
        summary += `  ✅ ${r.stepId} (${r.agent}): ${shortSummary}\n`;
      }
    }

    if (failed.length > 0) {
      summary += '\n失败步骤:\n';
      for (const r of failed) {
        summary += `  ❌ ${r.stepId} (${r.agent}): ${r.error || r.summary}\n`;
      }
    }

    if (skipped.length > 0) {
      summary += '\n跳过步骤:\n';
      for (const r of skipped) {
        summary += `  ⏭️ ${r.stepId} (${r.agent}): ${r.summary}\n`;
      }
    }

    return summary;
  }
}
