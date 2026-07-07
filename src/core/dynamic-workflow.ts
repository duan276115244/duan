/**
 * 动态工作流引擎 — YAML 编排
 *
 * 用户通过 YAML 定义工作流，引擎负责解析、验证和执行：
 *
 * workflow:
 *   name: code-review-pipeline
 *   trigger: pull_request
 *   steps:
 *     - id: lint
 *       tool: shell_execute
 *       args: { command: "npm run lint" }
 *       on_failure: abort
 *     - id: test
 *       tool: shell_execute
 *       args: { command: "npm test" }
 *       depends_on: [lint]
 *       on_failure: notify
 *     - id: review
 *       tool: code_review
 *       args: { files: "{{ steps.lint.output.changed_files }}" }
 *       depends_on: [test]
 *   outputs:
 *     status: "{{ steps.review.output.status }}"
 *
 * 核心能力：
 * 1. YAML 工作流定义解析（无外部依赖的轻量解析器）
 * 2. 步骤依赖（DAG）和拓扑排序
 * 3. 条件执行（if/unless）
 * 4. 变量插值（{{ }}）
 * 5. 错误处理（abort/retry/notify/continue）
 * 6. 并行执行
 * 7. 子工作流调用
 */

import * as fs from 'fs';
import * as path from 'path';
import { logger } from './structured-logger.js';

// ============ 类型定义 ============

/** 工作流步骤定义 */
export interface WorkflowStep {
  /** 步骤唯一标识 */
  id: string;
  /** 使用的工具名称 */
  tool: string;
  /** 工具参数 */
  args?: Record<string, unknown>;
  /** 前置步骤 ID 列表 */
  depends_on?: string[];
  /** 条件执行（满足条件时执行） */
  if?: string;
  /** 条件执行（满足条件时跳过） */
  unless?: string;
  /** 失败策略 */
  on_failure?: 'abort' | 'retry' | 'notify' | 'continue';
  /** 重试次数（仅 on_failure=retry 时生效） */
  retry_count?: number;
  /** 超时时间（毫秒） */
  timeout_ms?: number;
  /** 子工作流名称（用于子工作流调用） */
  sub_workflow?: string;
}

/** 工作流定义 */
export interface WorkflowDefinition {
  /** 工作流名称 */
  name: string;
  /** 工作流描述 */
  description?: string;
  /** 触发条件 */
  trigger?: string;
  /** 步骤列表 */
  steps: WorkflowStep[];
  /** 输出定义 */
  outputs?: Record<string, string>;
  /** 最大并行数 */
  max_parallel?: number;
  /** 全局超时（毫秒） */
  timeout_ms?: number;
  /** 元数据 */
  metadata?: Record<string, unknown>;
}

/** 工作流执行上下文 */
export interface WorkflowContext {
  /** 输入变量 */
  inputs?: Record<string, unknown>;
  /** 环境变量 */
  env?: Record<string, string>;
  /** 工作目录 */
  workingDir?: string;
  /** 自定义数据 */
  customData?: Record<string, unknown>;
}

/** 步骤执行结果 */
export interface StepResult {
  /** 步骤 ID */
  stepId: string;
  /** 执行状态 */
  status: 'completed' | 'failed' | 'skipped' | 'running';
  /** 步骤输出 */
  output?: unknown;
  /** 错误信息 */
  error?: string;
  /** 执行时长（毫秒） */
  durationMs: number;
  /** 重试次数 */
  attempts: number;
}

/** 工作流执行结果 */
export interface WorkflowResult {
  /** 工作流名称 */
  workflowName: string;
  /** 执行状态 */
  status: 'completed' | 'failed' | 'partial';
  /** 各步骤结果 */
  steps: StepResult[];
  /** 工作流输出 */
  outputs?: Record<string, unknown>;
  /** 总执行时长（毫秒） */
  totalDurationMs: number;
  /** 执行摘要 */
  summary: string;
}

/** 验证结果 */
export interface ValidationResult {
  /** 是否有效 */
  valid: boolean;
  /** 错误列表 */
  errors: string[];
  /** 警告列表 */
  warnings: string[];
}

/** 工作流工具处理器 */
export interface WorkflowToolHandler {
  /** 执行工具 */
  (args: Record<string, unknown>, context: WorkflowContext): Promise<unknown>;
}

/** 工作流信息 */
export interface WorkflowInfo {
  /** 工作流名称 */
  name: string;
  /** 描述 */
  description?: string;
  /** 触发条件 */
  trigger?: string;
  /** 步骤数 */
  stepCount: number;
  /** 是否已注册 */
  registered: boolean;
}

/** 工作流执行状态 */
export interface WorkflowExecutionStatus {
  /** 执行 ID */
  executionId: string;
  /** 工作流名称 */
  workflowName: string;
  /** 状态 */
  status: 'pending' | 'running' | 'completed' | 'failed' | 'partial' | 'cancelled';
  /** 已完成步骤数 */
  completedSteps: number;
  /** 总步骤数 */
  totalSteps: number;
  /** 已执行时长（毫秒） */
  elapsedMs: number;
  /** 当前正在执行的步骤 ID */
  currentSteps: string[];
}

// ============ 简易 YAML 解析器 ============

/**
 * 轻量 YAML 解析器，覆盖工作流定义所需的子集：
 * - 映射（键值对）
 * - 序列（列表）
 * - 标量：字符串、数字、布尔值
 * - 嵌套结构
 * - 行内映射（{ key: value }）
 *
 * 不支持：多文档、锚点/别名、复杂多行字符串等
 */
class SimpleYAMLParser {
  /** 解析 YAML 字符串为原始对象 */
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  parse(yaml: string): Record<string, any> {
    const lines = yaml.split('\n');
    return this.parseBlock(lines, 0, lines.length, 0);
  }

  /** 解析块级结构 */
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  private parseBlock(lines: string[], start: number, end: number, baseIndent: number): Record<string, any> {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const result: Record<string, any> = {};
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
      if (indent < baseIndent) break;

      // 解析列表项
      if (trimmed.startsWith('- ')) {
        // 找到列表所属的键
        const listKey = this.findParentKey(lines, i, start);
        if (!result[listKey]) result[listKey] = [];

        const itemContent = trimmed.substring(2).trim();

        // 行内映射（如 "- id: xxx"）
        if (itemContent.includes(':')) {
          // eslint-disable-next-line @typescript-eslint/no-explicit-any
          const item: Record<string, any> = {};
          const firstKv = this.parseKeyValue(itemContent);
          if (firstKv) item[firstKv.key] = firstKv.value;

          i++;
          // 收集同缩进层级的后续字段
          const itemIndent = indent + 2; // 列表项子字段的缩进
          while (i < end) {
            const nextLine = lines[i];
            const nextTrimmed = nextLine.trimStart();
            if (nextTrimmed === '' || nextTrimmed.startsWith('#')) { i++; continue; }
            const nextIndent = nextLine.length - nextTrimmed.length;
            if (nextIndent < itemIndent) break;

            if (nextTrimmed.startsWith('- ')) {
              // 子列表
              const subItem = nextTrimmed.substring(2).trim();
              const lastKey = Object.keys(item).pop();
              if (lastKey) {
                if (!Array.isArray(item[lastKey])) item[lastKey] = [];
                item[lastKey].push(this.parseScalar(subItem));
              }
              i++;
            } else {
              const kv = this.parseKeyValue(nextTrimmed);
              if (kv) {
                // 检查下一行是否为列表
                const peekResult = this.peekList(lines, i + 1, end, nextIndent);
                if (peekResult.isList) {
                  item[kv.key] = peekResult.items;
                  i = peekResult.nextLine;
                } else {
                  item[kv.key] = kv.value;
                  i++;
                }
              } else {
                i++;
              }
            }
          }
          (result[listKey] as unknown[]).push(item);
        } else {
          // 简单标量列表项
          (result[listKey] as unknown[]).push(this.parseScalar(itemContent));
          i++;
        }
        continue;
      }

      // 解析键值对
      const kv = this.parseKeyValue(trimmed);
      if (kv) {
        // 检查下一行是否为列表
        const peekResult = this.peekList(lines, i + 1, end, indent);
        if (peekResult.isList) {
          result[kv.key] = peekResult.items;
          i = peekResult.nextLine;
        } else {
          result[kv.key] = kv.value;
          i++;
        }
      } else {
        i++;
      }
    }

    return result;
  }

  /** 解析键值对 */
  private parseKeyValue(line: string): { key: string; value: unknown } | null {
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
        if (c + 1 === line.length || line[c + 1] === ' ') {
          colonIdx = c;
          break;
        }
      }
    }

    if (colonIdx === -1) return null;

    const key = line.substring(0, colonIdx).trim();
    const rawValue = line.substring(colonIdx + 1).trim();

    // 处理行内映射（如 { command: "npm run lint" }）
    if (rawValue.startsWith('{') && rawValue.endsWith('}')) {
      return { key: this.yamlKeyToCamel(key), value: this.parseInlineMapping(rawValue) };
    }

    return { key: this.yamlKeyToCamel(key), value: this.parseScalar(rawValue) };
  }

  /** 解析行内映射（如 { key: value, key2: value2 }） */
  private parseInlineMapping(raw: string): Record<string, unknown> {
    const content = raw.substring(1, raw.length - 1).trim();
    const result: Record<string, unknown> = {};

    // 简单分割（不处理嵌套大括号）
    const pairs = this.splitInlinePairs(content);
    for (const pair of pairs) {
      const kv = this.parseKeyValue(pair.trim());
      if (kv) {
        result[kv.key] = kv.value;
      }
    }

    return result;
  }

  /** 分割行内映射的键值对 */
  private splitInlinePairs(content: string): string[] {
    const pairs: string[] = [];
    let current = '';
    let depth = 0;
    let inQuote = false;
    let quoteChar = '';

    for (let i = 0; i < content.length; i++) {
      const ch = content[i];
      if (inQuote) {
        current += ch;
        if (ch === quoteChar) inQuote = false;
        continue;
      }
      if (ch === '"' || ch === "'") {
        inQuote = true;
        quoteChar = ch;
        current += ch;
        continue;
      }
      if (ch === '{' || ch === '[') depth++;
      if (ch === '}' || ch === ']') depth--;
      if (ch === ',' && depth === 0) {
        pairs.push(current);
        current = '';
        continue;
      }
      current += ch;
    }
    if (current.trim()) pairs.push(current);

    return pairs;
  }

  /** 解析标量值 */
  private parseScalar(raw: string): unknown {
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

  /** YAML 键名转驼峰（snake_case → camelCase） */
  private yamlKeyToCamel(key: string): string {
    return key.replace(/_([a-z])/g, (_, c) => c.toUpperCase());
  }

  /** 检查下一行是否为列表，并预解析 */
  private peekList(
    lines: string[],
    startIdx: number,
    end: number,
    parentIndent: number,
  ): { isList: boolean; items: unknown[]; nextLine: number } {
    if (startIdx >= end) return { isList: false, items: [], nextLine: startIdx };

    const peekLine = lines[startIdx];
    const peekTrimmed = peekLine.trimStart();
    const peekIndent = peekLine.length - peekTrimmed.length;

    if (!peekTrimmed.startsWith('- ') || peekIndent <= parentIndent) {
      return { isList: false, items: [], nextLine: startIdx };
    }

    // 是列表，解析所有列表项
    const items: unknown[] = [];
    const listIndent = peekIndent;
    let i = startIdx;

    while (i < end) {
      const liLine = lines[i];
      const liTrimmed = liLine.trimStart();
      if (liTrimmed === '' || liTrimmed.startsWith('#')) { i++; continue; }
      const liIndent = liLine.length - liTrimmed.length;
      if (liIndent < listIndent) break;
      if (liIndent === listIndent && liTrimmed.startsWith('- ')) {
        const itemContent = liTrimmed.substring(2).trim();
        items.push(this.parseScalar(itemContent));
        i++;
      } else {
        break;
      }
    }

    return { isList: true, items, nextLine: i };
  }

  /** 查找列表项应归属的父级键名 */
  private findParentKey(lines: string[], currentLine: number, startLine: number): string {
    for (let j = currentLine - 1; j >= startLine; j--) {
      const prev = lines[j].trimStart();
      if (prev === '' || prev.startsWith('#') || prev.startsWith('- ')) continue;
      const kv = this.parseKeyValue(prev);
      if (kv) return kv.key;
    }
    return 'items';
  }
}

// ============ 变量插值引擎 ============

/**
 * 处理 {{ }} 模板的变量插值
 * 支持的变量源：
 * - steps.<stepId>.output — 步骤输出
 * - inputs.<key> — 输入变量
 * - env.<key> — 环境变量
 */
class VariableInterpolator {
  /** 步骤结果 */
  private stepResults = new Map<string, StepResult>();
  /** 上下文 */
  private context: WorkflowContext;

  constructor(context: WorkflowContext) {
    this.context = context;
  }

  /** 设置步骤结果 */
  setStepResult(stepId: string, result: StepResult): void {
    this.stepResults.set(stepId, result);
  }

  /** 对字符串进行变量插值 */
  interpolate(template: string): string {
    if (typeof template !== 'string') return String(template);

    return template.replace(/\{\{\s*([^}]+)\s*\}\}/g, (_, expr) => {
      return String(this.resolveExpression(expr.trim()));
    });
  }

  /** 对任意值进行插值（递归处理对象和数组） */
  interpolateValue(value: unknown): unknown {
    if (typeof value === 'string') {
      return this.interpolate(value);
    }
    if (Array.isArray(value)) {
      return value.map(v => this.interpolateValue(v));
    }
    if (typeof value === 'object' && value !== null) {
      const result: Record<string, unknown> = {};
      for (const [k, v] of Object.entries(value)) {
        result[k] = this.interpolateValue(v);
      }
      return result;
    }
    return value;
  }

  /** 解析表达式 */
  private resolveExpression(expr: string): unknown {
    const parts = expr.split('.');

    if (parts[0] === 'steps' && parts.length >= 3) {
      const stepId = parts[1];
      const field = parts[2];
      const result = this.stepResults.get(stepId);
      if (!result) return `{{ ${expr} }}`;

      if (field === 'output') {
        // 支持 steps.<id>.output.<key> 的深层访问
        if (parts.length > 3) {
          return this.deepGet(result.output, parts.slice(3));
        }
        return result.output;
      }
      if (field === 'status') return result.status;
      if (field === 'error') return result.error;
      return `{{ ${expr} }}`;
    }

    if (parts[0] === 'inputs' && parts.length >= 2) {
      return this.context.inputs?.[parts[1]] ?? `{{ ${expr} }}`;
    }

    if (parts[0] === 'env' && parts.length >= 2) {
      return this.context.env?.[parts[1]] ?? process.env[parts[1]] ?? `{{ ${expr} }}`;
    }

    return `{{ ${expr} }}`;
  }

  /** 深层属性访问 */
  private deepGet(obj: unknown, keys: string[]): unknown {
    let current = obj;
    for (const key of keys) {
      if (current === null || current === undefined) return undefined;
      if (typeof current === 'object') {
        current = (current as Record<string, unknown>)[key];
      } else {
        return undefined;
      }
    }
    return current;
  }
}

// ============ 主类 ============

export class DynamicWorkflowEngine {
  private log = logger.child({ module: 'DynamicWorkflow' });

  /** 注册的工具处理器 */
  private tools = new Map<string, WorkflowToolHandler>();

  /** 注册的工作流定义 */
  private workflowDefs = new Map<string, WorkflowDefinition>();

  /** 执行中的工作流状态 */
  private executions = new Map<string, WorkflowExecutionStatus>();

  /** YAML 解析器 */
  private yamlParser = new SimpleYAMLParser();

  /** 是否已释放 */
  private disposed = false;

  /** 执行 ID 计数器 */
  private executionCounter = 0;

  /**
   * 向后兼容的旧版工具执行器（可选）
   * 旧版构造函数: new DynamicWorkflowEngine(toolExec, agentSpawner)
   */
  private legacyToolExec?: (name: string, args: Record<string, unknown>) => Promise<string>;
  private legacyAgentSpawner?: (name: string, task: string, config?: Record<string, unknown>) => Promise<string>;

  /**
   * 构造函数
   *
   * 新版用法（无参数）:
   *   new DynamicWorkflowEngine()
   *   然后通过 registerTool() 注册工具
   *
   * 旧版兼容用法:
   *   new DynamicWorkflowEngine(toolExec, agentSpawner)
   *   自动将旧版工具执行器和 Agent 生成器注册为内置工具
   */
  constructor(
    toolExec?: (name: string, args: Record<string, unknown>) => Promise<string>,
    agentSpawner?: (name: string, task: string, config?: Record<string, unknown>) => Promise<string>,
  ) {
    if (toolExec) {
      this.legacyToolExec = toolExec;
      // 将旧版工具执行器注册为通用工具
      this.registerTool('legacy_tool_exec', (args) => {
        const toolName = String(args.tool ?? args.name ?? '');
        const toolArgs = { ...args };
        delete toolArgs.tool;
        delete toolArgs.name;
        return Promise.resolve(toolExec(toolName, toolArgs));
      });
    }
    if (agentSpawner) {
      this.legacyAgentSpawner = agentSpawner;
      // 将旧版 Agent 生成器注册为工具
      this.registerTool('legacy_sub_agent', (args) => {
        return Promise.resolve(agentSpawner(
          String(args.agent ?? args.name ?? ''),
          String(args.task ?? args.action ?? ''),
          args.config as Record<string, unknown> | undefined,
        ));
      });
    }
  }

  /**
   * 解析 YAML 内容为工作流定义
   *
   * @param yamlContent YAML 格式的工作流定义
   * @returns 工作流定义
   */
  parse(yamlContent: string): WorkflowDefinition {
    this.checkDisposed();
    this.log.info('解析 YAML 工作流定义');

    const raw = this.yamlParser.parse(yamlContent);

    // 支持顶层 workflow: 包裹或直接定义
    const source = raw['workflow'] ?? raw;

    const steps: WorkflowStep[] = [];
    const rawSteps = source['steps'];
    if (Array.isArray(rawSteps)) {
      for (const rawStep of rawSteps) {
        const step: WorkflowStep = {
          id: String(rawStep['id'] || ''),
          tool: String(rawStep['tool'] || ''),
        };
        if (rawStep['args'] !== undefined) step.args = rawStep['args'] as Record<string, unknown>;
        if (rawStep['dependsOn'] !== undefined) {
          step.depends_on = this.toStringArray(rawStep['dependsOn']);
        } else if (rawStep['depends_on'] !== undefined) {
          step.depends_on = this.toStringArray(rawStep['depends_on']);
        }
        if (rawStep['if'] !== undefined) step.if = String(rawStep['if']);
        if (rawStep['unless'] !== undefined) step.unless = String(rawStep['unless']);
        if (rawStep['onFailure'] !== undefined) {
          step.on_failure = this.toOnFailure(rawStep['onFailure']);
        } else if (rawStep['on_failure'] !== undefined) {
          step.on_failure = this.toOnFailure(rawStep['on_failure']);
        }
        if (rawStep['retryCount'] !== undefined) {
          step.retry_count = Number(rawStep['retryCount']);
        } else if (rawStep['retry_count'] !== undefined) {
          step.retry_count = Number(rawStep['retry_count']);
        }
        if (rawStep['timeoutMs'] !== undefined) {
          step.timeout_ms = Number(rawStep['timeoutMs']);
        } else if (rawStep['timeout_ms'] !== undefined) {
          step.timeout_ms = Number(rawStep['timeout_ms']);
        }
        if (rawStep['subWorkflow'] !== undefined) {
          step.sub_workflow = String(rawStep['subWorkflow']);
        } else if (rawStep['sub_workflow'] !== undefined) {
          step.sub_workflow = String(rawStep['sub_workflow']);
        }
        steps.push(step);
      }
    }

    const definition: WorkflowDefinition = {
      name: String(source['name'] || ''),
      steps,
    };

    if (source['description'] !== undefined) definition.description = String(source['description']);
    if (source['trigger'] !== undefined) definition.trigger = String(source['trigger']);
    if (source['outputs'] !== undefined) definition.outputs = source['outputs'] as Record<string, string>;
    if (source['maxParallel'] !== undefined) {
      definition.max_parallel = Number(source['maxParallel']);
    } else if (source['max_parallel'] !== undefined) {
      definition.max_parallel = Number(source['max_parallel']);
    }
    if (source['timeoutMs'] !== undefined) {
      definition.timeout_ms = Number(source['timeoutMs']);
    } else if (source['timeout_ms'] !== undefined) {
      definition.timeout_ms = Number(source['timeout_ms']);
    }
    if (source['metadata'] !== undefined) definition.metadata = source['metadata'] as Record<string, unknown>;

    this.log.info('YAML 解析完成', { name: definition.name, steps: steps.length });
    return definition;
  }

  /**
   * 验证工作流定义
   *
   * 检查：名称、步骤 ID 唯一性、依赖引用、循环依赖、工具注册、条件表达式
   *
   * @param definition 工作流定义
   * @returns 验证结果
   */
  validate(definition: WorkflowDefinition): ValidationResult {
    this.checkDisposed();

    const errors: string[] = [];
    const warnings: string[] = [];

    // 检查名称
    if (!definition.name || definition.name.trim() === '') {
      errors.push('工作流名称不能为空');
    }

    // 检查步骤
    if (!definition.steps || definition.steps.length === 0) {
      errors.push('工作流必须包含至少一个步骤');
      return { valid: false, errors, warnings };
    }

    // 步骤 ID 唯一性
    const idSet = new Set<string>();
    for (const step of definition.steps) {
      if (!step.id || step.id.trim() === '') {
        errors.push(`存在空 ID 的步骤（tool: ${step.tool}）`);
        continue;
      }
      if (idSet.has(step.id)) {
        errors.push(`步骤 ID 重复: "${step.id}"`);
      }
      idSet.add(step.id);

      // 检查工具
      if (!step.tool || step.tool.trim() === '') {
        errors.push(`步骤 "${step.id}" 缺少 tool 字段`);
      } else if (!step.sub_workflow && !this.tools.has(step.tool)) {
        warnings.push(`步骤 "${step.id}" 使用的工具 "${step.tool}" 尚未注册`);
      }
    }

    // 依赖引用存在性
    for (const step of definition.steps) {
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
    const cycleErrors = this.detectCycles(definition);
    errors.push(...cycleErrors);

    // 检查子工作流引用
    for (const step of definition.steps) {
      if (step.sub_workflow && !this.workflowDefs.has(step.sub_workflow)) {
        warnings.push(`步骤 "${step.id}" 引用了未注册的子工作流 "${step.sub_workflow}"`);
      }
    }

    // 检查输出引用
    if (definition.outputs) {
      for (const [key, template] of Object.entries(definition.outputs)) {
        if (typeof template === 'string' && template.includes('{{')) {
          const stepRefMatch = template.match(/\{\{\s*steps\.([^.]+)\./);
          if (stepRefMatch && !idSet.has(stepRefMatch[1])) {
            warnings.push(`输出 "${key}" 引用了不存在的步骤 "${stepRefMatch[1]}"`);
          }
        }
      }
    }

    this.log.info('工作流验证完成', {
      name: definition.name,
      valid: errors.length === 0,
      errors: errors.length,
      warnings: warnings.length,
    });

    return { valid: errors.length === 0, errors, warnings };
  }

  /**
   * 执行工作流
   *
   * @param definition 工作流定义
   * @param context 执行上下文
   * @returns 执行结果
   */
  async execute(definition: WorkflowDefinition, context: WorkflowContext): Promise<WorkflowResult> {
    this.checkDisposed();

    const executionId = `exec_${(++this.executionCounter).toString(36)}_${Date.now().toString(36)}`;
    const startTime = Date.now();

    this.log.info('开始执行工作流', { name: definition.name, executionId });

    // 验证
    const validation = this.validate(definition);
    if (!validation.valid) {
      return {
        workflowName: definition.name,
        status: 'failed',
        steps: [],
        totalDurationMs: Date.now() - startTime,
        summary: `工作流验证失败: ${validation.errors.join('; ')}`,
      };
    }

    // 初始化执行状态
    const status: WorkflowExecutionStatus = {
      executionId,
      workflowName: definition.name,
      status: 'running',
      completedSteps: 0,
      totalSteps: definition.steps.length,
      elapsedMs: 0,
      currentSteps: [],
    };
    this.executions.set(executionId, status);

    // 初始化变量插值引擎
    const interpolator = new VariableInterpolator(context);

    // 获取执行顺序（拓扑排序 + 并行分组）
    const executionGroups = this.getExecutionGroups(definition);
    const stepMap = new Map(definition.steps.map(s => [s.id, s]));

    const allResults: StepResult[] = [];
    const completedStepIds = new Set<string>();
    let workflowFailed = false;
    const maxParallel = definition.max_parallel ?? 5;

    // 逐层执行
    for (const group of executionGroups) {
      if (workflowFailed) {
        // 将剩余步骤标记为 skipped
        for (const stepId of group) {
          allResults.push({
            stepId,
            status: 'skipped',
            durationMs: 0,
            attempts: 0,
            error: '因前置步骤失败而跳过',
          });
        }
        continue;
      }

      // 过滤出就绪的步骤（依赖已完成 + 条件满足）
      const readyStepIds = group.filter(stepId => {
        const step = stepMap.get(stepId)!;
        // 检查依赖
        if (step.depends_on && !step.depends_on.every(depId => completedStepIds.has(depId))) {
          return false;
        }
        // 检查条件
        return this.evaluateCondition(step, interpolator);
      });

      // 分批并行执行
      const batches = this.batchSteps(readyStepIds, maxParallel);

      for (const batch of batches) {
        status.currentSteps = batch;

        const batchPromises = batch.map((stepId) => {
          const step = stepMap.get(stepId)!;

          // 插值参数
          const interpolatedArgs = step.args
            ? (interpolator.interpolateValue(step.args) as Record<string, unknown>)
            : {};

          // 执行步骤
          return Promise.resolve(this.executeStep(step, interpolatedArgs, context, interpolator));
        });

        const batchResults = await Promise.all(batchPromises);

        for (const result of batchResults) {
          allResults.push(result);
          interpolator.setStepResult(result.stepId, result);

          if (result.status === 'completed') {
            completedStepIds.add(result.stepId);
            status.completedSteps++;
          } else if (result.status === 'failed') {
            const step = stepMap.get(result.stepId)!;
            if (step.on_failure === 'abort') {
              workflowFailed = true;
            }
            // continue 和 notify 都不阻塞后续步骤
          }
          // skipped 步骤也视为完成（不阻塞依赖）
          if (result.status === 'skipped') {
            completedStepIds.add(result.stepId);
          }
        }
      }

      status.elapsedMs = Date.now() - startTime;
    }

    // 处理输出
    let outputs: Record<string, unknown> | undefined;
    if (definition.outputs) {
      outputs = {};
      for (const [key, template] of Object.entries(definition.outputs)) {
        outputs[key] = interpolator.interpolateValue(template);
      }
    }

    // 确定最终状态
    const completedCount = allResults.filter(r => r.status === 'completed').length;
    const failedCount = allResults.filter(r => r.status === 'failed').length;

    let finalStatus: WorkflowResult['status'];
    if (failedCount === 0) {
      finalStatus = 'completed';
    } else if (completedCount === 0) {
      finalStatus = 'failed';
    } else {
      finalStatus = 'partial';
    }

    status.status = (() => {
      if (workflowFailed) return 'failed';
      if (finalStatus === 'completed') return 'completed';
      return 'partial';
    })();
    status.currentSteps = [];

    const totalDurationMs = Date.now() - startTime;
    const summary = this.generateSummary(definition.name, allResults, totalDurationMs);

    this.log.info('工作流执行完成', {
      name: definition.name,
      executionId,
      status: finalStatus,
      durationMs: totalDurationMs,
    });

    return {
      workflowName: definition.name,
      status: finalStatus,
      steps: allResults,
      outputs,
      totalDurationMs,
      summary,
    };
  }

  /**
   * 从文件执行工作流
   *
   * @param filePath YAML 文件路径
   * @param context 执行上下文
   * @returns 执行结果
   */
  async executeFromFile(filePath: string, context: WorkflowContext): Promise<WorkflowResult> {
    this.checkDisposed();

    const resolvedPath = path.resolve(filePath);
    this.log.info('从文件执行工作流', { path: resolvedPath });

    try {
      const content = await fs.promises.readFile(resolvedPath, 'utf-8');
      const definition = this.parse(content);
      return this.execute(definition, context);
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : String(err);
      this.log.error('读取工作流文件失败', { path: resolvedPath, error: message });
      return {
        workflowName: path.basename(resolvedPath),
        status: 'failed',
        steps: [],
        totalDurationMs: 0,
        summary: `读取工作流文件失败: ${message}`,
      };
    }
  }

  /**
   * 注册工具处理器
   *
   * @param name 工具名称
   * @param handler 处理器函数
   */
  registerTool(name: string, handler: WorkflowToolHandler): void {
    this.checkDisposed();
    this.tools.set(name, handler);
    this.log.info('注册工作流工具', { name });
  }

  /**
   * 列出所有已注册的工作流
   */
  listWorkflows(): WorkflowInfo[] {
    this.checkDisposed();
    const infos: WorkflowInfo[] = [];

    for (const [name, def] of this.workflowDefs) {
      infos.push({
        name,
        description: def.description,
        trigger: def.trigger,
        stepCount: def.steps.length,
        registered: true,
      });
    }

    return infos;
  }

  /**
   * 获取工作流执行状态
   *
   * @param executionId 执行 ID
   * @returns 执行状态
   */
  getWorkflowStatus(executionId: string): WorkflowExecutionStatus {
    this.checkDisposed();
    const status = this.executions.get(executionId);
    if (!status) {
      return {
        executionId,
        workflowName: '',
        status: 'pending',
        completedSteps: 0,
        totalSteps: 0,
        elapsedMs: 0,
        currentSteps: [],
      };
    }
    return { ...status };
  }

  /**
   * 取消工作流执行
   *
   * @param executionId 执行 ID
   */
  cancelWorkflow(executionId: string): void {
    this.checkDisposed();
    const status = this.executions.get(executionId);
    if (status && status.status === 'running') {
      status.status = 'cancelled';
      this.log.info('取消工作流执行', { executionId });
    }
  }

  /**
   * 释放资源
   */
  dispose(): void {
    this.disposed = true;
    this.tools.clear();
    this.workflowDefs.clear();
    this.executions.clear();
    this.log.info('DynamicWorkflowEngine 已释放');
  }

  // ============ 私有方法 ============

  /** 检查是否已释放 */
  private checkDisposed(): void {
    if (this.disposed) {
      throw new Error('DynamicWorkflowEngine 已释放，不能再使用');
    }
  }

  /**
   * 执行单个步骤
   */
  private async executeStep(
    step: WorkflowStep,
    args: Record<string, unknown>,
    context: WorkflowContext,
    _interpolator: VariableInterpolator,
  ): Promise<StepResult> {
    const stepStart = Date.now();
    const timeoutMs = step.timeout_ms ?? 120000;
    const maxAttempts = step.on_failure === 'retry' ? (step.retry_count ?? 1) + 1 : 1;

    // 子工作流调用
    if (step.sub_workflow) {
      const subDef = this.workflowDefs.get(step.sub_workflow);
      if (!subDef) {
        return {
          stepId: step.id,
          status: 'failed',
          error: `子工作流 "${step.sub_workflow}" 未注册`,
          durationMs: Date.now() - stepStart,
          attempts: 1,
        };
      }
      try {
        const subResult = await this.execute(subDef, context);
        return {
          stepId: step.id,
          status: subResult.status === 'completed' ? 'completed' : 'failed',
          output: subResult.outputs,
          durationMs: Date.now() - stepStart,
          attempts: 1,
        };
      } catch (err: unknown) {
        return {
          stepId: step.id,
          status: 'failed',
          error: err instanceof Error ? err.message : String(err),
          durationMs: Date.now() - stepStart,
          attempts: 1,
        };
      }
    }

    // 查找工具处理器
    const handler = this.tools.get(step.tool);
    if (!handler) {
      return {
        stepId: step.id,
        status: 'failed',
        error: `工具 "${step.tool}" 未注册`,
        durationMs: Date.now() - stepStart,
        attempts: 1,
      };
    }

    let lastError: string | undefined;

    for (let attempt = 0; attempt < maxAttempts; attempt++) {
      try {
        const output = await Promise.race([
          handler(args, context),
          new Promise<never>((_, reject) =>
            setTimeout(() => reject(new Error(`步骤超时（${timeoutMs}ms）`)), timeoutMs),
          ),
        ]);

        return {
          stepId: step.id,
          status: 'completed',
          output,
          durationMs: Date.now() - stepStart,
          attempts: attempt + 1,
        };
      } catch (err: unknown) {
        lastError = err instanceof Error ? err.message : String(err);
        this.log.warn('步骤执行失败', {
          stepId: step.id,
          attempt: attempt + 1,
          maxAttempts,
          error: lastError,
        });
      }
    }

    // 所有尝试均失败
    // notify 策略：记录错误但不阻塞
    if (step.on_failure === 'notify' || step.on_failure === 'continue') {
      this.log.warn('步骤失败但继续执行', { stepId: step.id, on_failure: step.on_failure });
    }

    return {
      stepId: step.id,
      status: 'failed',
      error: lastError,
      durationMs: Date.now() - stepStart,
      attempts: maxAttempts,
    };
  }

  /**
   * 评估条件表达式
   */
  private evaluateCondition(step: WorkflowStep, interpolator: VariableInterpolator): boolean {
    if (step.if) {
      const resolved = interpolator.interpolate(step.if);
      return this.isTruthy(resolved);
    }
    if (step.unless) {
      const resolved = interpolator.interpolate(step.unless);
      return !this.isTruthy(resolved);
    }
    return true;
  }

  /** 判断值是否为真 */
  private isTruthy(value: string): boolean {
    const lower = value.toLowerCase().trim();
    return lower !== '' && lower !== 'false' && lower !== '0' && lower !== 'null' && lower !== 'undefined';
  }

  /**
   * 获取执行分组（拓扑排序 + 并行层级）
   */
  private getExecutionGroups(definition: WorkflowDefinition): string[][] {
    const stepMap = new Map(definition.steps.map(s => [s.id, s]));
    const levels = new Map<string, number>();

    const computeLevel = (stepId: string, visited: Set<string> = new Set()): number => {
      if (levels.has(stepId)) return levels.get(stepId)!;
      if (visited.has(stepId)) return 0;
      visited.add(stepId);

      const step = stepMap.get(stepId);
      if (!step || !step.depends_on || step.depends_on.length === 0) {
        levels.set(stepId, 0);
        return 0;
      }

      let maxDepLevel = 0;
      for (const depId of step.depends_on) {
        if (stepMap.has(depId)) {
          const depLevel = computeLevel(depId, visited);
          maxDepLevel = Math.max(maxDepLevel, depLevel);
        }
      }

      const level = maxDepLevel + 1;
      levels.set(stepId, level);
      return level;
    };

    for (const step of definition.steps) {
      computeLevel(step.id);
    }

    // 按层级分组
    const groups = new Map<number, string[]>();
    levels.forEach((level, stepId) => {
      const group = groups.get(level) || [];
      group.push(stepId);
      groups.set(level, group);
    });

    const sortedLevels: number[] = [];
    groups.forEach((_, level) => sortedLevels.push(level));
    sortedLevels.sort((a, b) => a - b);

    return sortedLevels.map(level => groups.get(level)!);
  }

  /**
   * 分批步骤
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
   */
  private detectCycles(definition: WorkflowDefinition): string[] {
    const errors: string[] = [];
    const stepMap = new Map(definition.steps.map(s => [s.id, s]));
    const WHITE = 0, GRAY = 1, BLACK = 2;
    const color = new Map<string, number>();

    for (const step of definition.steps) {
      color.set(step.id, WHITE);
    }

    const dfs = (stepId: string, path: string[]): boolean => {
      color.set(stepId, GRAY);
      const step = stepMap.get(stepId);

      if (step?.depends_on) {
        for (const depId of step.depends_on) {
          if (!color.has(depId)) continue;
          const depColor = color.get(depId);
          if (depColor === GRAY) {
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

    for (const step of definition.steps) {
      if (color.get(step.id) === WHITE) {
        dfs(step.id, [step.id]);
      }
    }

    return errors;
  }

  /**
   * 转为字符串数组
   */
  private toStringArray(val: unknown): string[] {
    if (Array.isArray(val)) return val.map(v => String(v));
    if (typeof val === 'string') return [val];
    return [];
  }

  /**
   * 转为 onFailure 枚举
   */
  private toOnFailure(val: unknown): 'abort' | 'retry' | 'notify' | 'continue' | undefined {
    if (typeof val === 'string') {
      if (val === 'abort' || val === 'retry' || val === 'notify' || val === 'continue') return val;
    }
    return undefined;
  }

  /**
   * 生成执行摘要
   */
  private generateSummary(
    workflowName: string,
    results: StepResult[],
    totalDurationMs: number,
  ): string {
    const completed = results.filter(r => r.status === 'completed');
    const failed = results.filter(r => r.status === 'failed');
    const skipped = results.filter(r => r.status === 'skipped');

    const durationSec = (totalDurationMs / 1000).toFixed(1);

    let summary = `工作流 "${workflowName}" 执行完成，耗时 ${durationSec}s。\n`;
    summary += `总计 ${results.length} 个步骤：${completed.length} 完成，${failed.length} 失败，${skipped.length} 跳过。\n`;

    if (completed.length > 0) {
      summary += '\n已完成步骤:\n';
      for (const r of completed) {
        const outputStr = r.output ? String(r.output).substring(0, 80) : '';
        summary += `  ✅ ${r.stepId}: ${outputStr}${outputStr.length >= 80 ? '...' : ''}\n`;
      }
    }

    if (failed.length > 0) {
      summary += '\n失败步骤:\n';
      for (const r of failed) {
        summary += `  ❌ ${r.stepId}: ${r.error ?? '未知错误'}\n`;
      }
    }

    if (skipped.length > 0) {
      summary += '\n跳过步骤:\n';
      for (const r of skipped) {
        summary += `  ⏭️ ${r.stepId}: ${r.error ?? '条件不满足'}\n`;
      }
    }

    return summary;
  }
}
