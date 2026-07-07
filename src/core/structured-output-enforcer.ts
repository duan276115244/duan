/**
 * 结构化输出强制约束器 — StructuredOutputEnforcer
 *
 * 对标 OpenAI Structured Output 和 Codex 的输出约束模式。
 * 解决工具调用参数解析失败率高的问题（目标：>99% 解析成功率）。
 *
 * 核心能力：
 * 1. JSON Schema 约束：为工具参数生成 schema，约束 LLM 输出格式
 * 2. 多策略解析：严格 JSON → 宽松 JSON → 正则提取 → 修复重试
 * 3. 自动修复：常见格式错误（尾逗号、单引号、未闭合）自动修复
 * 4. 参数验证：类型检查、必填校验、枚举值校验
 * 5. 降级处理：解析失败时提供默认值或请求重新生成
 *
 * 借鉴来源：
 * - OpenAI：Structured Output / JSON Mode
 * - Codex：输出格式约束
 * - Cursor：工具调用参数验证
 */

import { logger } from './structured-logger.js';

// ============ 类型定义 ============

/** 参数类型 */
export type ParamType =
  | 'string'
  | 'number'
  | 'integer'
  | 'boolean'
  | 'array'
  | 'object'
  | 'enum';

/** 参数定义 */
export interface ParamDef {
  type: ParamType;
  description?: string;
  required?: boolean;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  default?: any;
  enum?: Array<string | number>;
  items?: ParamDef; // 数组元素类型
  properties?: Record<string, ParamDef>; // 对象属性
  minimum?: number;
  maximum?: number;
  minLength?: number;
  maxLength?: number;
  pattern?: string;
}

/** 工具 schema */
export interface ToolSchema {
  name: string;
  description: string;
  parameters: Record<string, ParamDef>;
}

/** 解析结果 */
interface ParseResult<T = Record<string, unknown>> {
  success: boolean;
  data: T | null;
  errors: string[];
  warnings: string[];
  /** 使用的解析策略 */
  strategy: 'strict' | 'lenient' | 'regex' | 'repair' | 'default';
  /** 修复的内容 */
  repairs: string[];
}

/** 验证结果 */
interface ValidationResult {
  valid: boolean;
  errors: Array<{ path: string; message: string }>;
  warnings: Array<{ path: string; message: string }>;
  /** 规范化后的数据（填充默认值、类型转换） */
  normalized: Record<string, unknown>;
}

// ============ StructuredOutputEnforcer 主类 ============

export class StructuredOutputEnforcer {
  private log = logger.child({ module: 'StructuredOutputEnforcer' });
  /** 解析统计 */
  private stats = {
    total: 0,
    success: 0,
    failure: 0,
    byStrategy: { strict: 0, lenient: 0, regex: 0, repair: 0, default: 0 } as Record<string, number>,
  };

  /** 已注册的工具 schema（按工具名缓存），供 parseToolCallArgs 查询 */
  private toolSchemas = new Map<string, ToolSchema>();

  /**
   * 注册工具 schema，使 parseToolCallArgs 能基于 toolName 自动查询 schema 做校验
   */
  registerToolSchema(name: string, schema: ToolSchema): void {
    this.toolSchemas.set(name, schema);
  }

  /** 查询已注册的工具 schema */
  getToolSchema(name: string): ToolSchema | undefined {
    return this.toolSchemas.get(name);
  }

  /**
   * 解析工具调用参数 — 多策略降级
   *
   * 策略顺序：strict → lenient → regex → repair → default
   *
   * @param rawArgs LLM 返回的 tool_call arguments
   * @param schema 可选的参数 schema（传入则做类型校验；未传但有 toolName 则自动查询）
   * @param toolName 工具名（用于 schema 查询和日志）
   */
  parseToolCallArgs(rawArgs: string, schema?: ToolSchema, toolName?: string): ParseResult {
    // 未显式传 schema 但有 toolName：自动查询已注册的 schema
    if (!schema && toolName) {
      schema = this.getToolSchema(toolName);
    }
    this.stats.total++;
    const errors: string[] = [];
    const warnings: string[] = [];
    const repairs: string[] = [];

    // 空参数处理
    if (!rawArgs || rawArgs.trim() === '') {
      const result: ParseResult = {
        success: true,
        data: {},
        errors: [],
        warnings: ['空参数，返回空对象'],
        strategy: 'default',
        repairs: [],
      };
      this.stats.success++;
      this.stats.byStrategy.default++;
      return result;
    }

    // 策略 1: 严格 JSON 解析
    let data = this.tryStrictParse(rawArgs);
    if (data !== null) {
      const validated = this.validate(data, schema);
      if (validated.valid) {
        this.stats.success++;
        this.stats.byStrategy.strict++;
        return {
          success: true,
          data: validated.normalized,
          errors: [],
          warnings: validated.warnings.map(w => `${w.path}: ${w.message}`),
          strategy: 'strict',
          repairs: [],
        };
      }
      errors.push(...validated.errors.map(e => `${e.path}: ${e.message}`));
    }

    // 策略 2: 宽松 JSON 解析（容忍尾逗号、单引号）
    data = this.tryLenientParse(rawArgs, repairs);
    if (data !== null) {
      const validated = this.validate(data, schema);
      if (validated.valid) {
        this.stats.success++;
        this.stats.byStrategy.lenient++;
        return {
          success: true,
          data: validated.normalized,
          errors: [],
          warnings: [...warnings, ...validated.warnings.map(w => `${w.path}: ${w.message}`)],
          strategy: 'lenient',
          repairs,
        };
      }
      errors.push(...validated.errors.map(e => `${e.path}: ${e.message}`));
    }

    // 策略 3: 正则提取（从文本中提取 JSON 块）
    data = this.tryRegexExtract(rawArgs, repairs);
    if (data !== null) {
      const validated = this.validate(data, schema);
      if (validated.valid) {
        this.stats.success++;
        this.stats.byStrategy.regex++;
        return {
          success: true,
          data: validated.normalized,
          errors: [],
          warnings: [...warnings, ...validated.warnings.map(w => `${w.path}: ${w.message}`)],
          strategy: 'regex',
          repairs,
        };
      }
      errors.push(...validated.errors.map(e => `${e.path}: ${e.message}`));
    }

    // 策略 4: 修复重试（修复常见错误后重新解析）
    const repaired = this.tryRepair(rawArgs, repairs);
    if (repaired !== null) {
      const validated = this.validate(repaired, schema);
      if (validated.valid) {
        this.stats.success++;
        this.stats.byStrategy.repair++;
        return {
          success: true,
          data: validated.normalized,
          errors: [],
          warnings: [...warnings, ...validated.warnings.map(w => `${w.path}: ${w.message}`)],
          strategy: 'repair',
          repairs,
        };
      }
      errors.push(...validated.errors.map(e => `${e.path}: ${e.message}`));
    }

    // 全部失败 — 返回默认值
    this.stats.failure++;
    this.stats.byStrategy.default++;
    const defaultData = this.generateDefaults(schema);
    return {
      success: false,
      data: defaultData,
      errors: [...new Set(errors)],
      warnings,
      strategy: 'default',
      repairs,
    };
  }

  /**
   * 验证参数 — 类型检查、必填校验、枚举值
   */
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  validate(data: any, schema?: ToolSchema): ValidationResult {
    const errors: Array<{ path: string; message: string }> = [];
    const warnings: Array<{ path: string; message: string }> = [];
    const normalized: Record<string, unknown> = {};

    if (!schema) {
      return { valid: true, errors: [], warnings: [], normalized: data || {} };
    }

    if (typeof data !== 'object' || data === null) {
      errors.push({ path: 'root', message: `期望对象，得到 ${typeof data}` });
      return { valid: false, errors, warnings, normalized: {} };
    }

    for (const [paramName, paramDef] of Object.entries(schema.parameters)) {
      const value = data[paramName];
      const path = paramName;

      // 必填检查
      if (paramDef.required !== false && (value === undefined || value === null)) {
        if (paramDef.default !== undefined) {
          normalized[paramName] = paramDef.default;
          warnings.push({ path, message: '使用默认值' });
          continue;
        }
        errors.push({ path, message: '必填参数缺失' });
        continue;
      }

      // 空值跳过验证
      if (value === undefined || value === null) {
        if (paramDef.default !== undefined) {
          normalized[paramName] = paramDef.default;
        }
        continue;
      }

      // 类型验证与转换
      const converted = this.convertType(value, paramDef, path);
      if (converted.error) {
        errors.push({ path, message: converted.error });
        continue;
      }

      // 枚举值检查
      if (paramDef.type === 'enum' && paramDef.enum) {
        if (!paramDef.enum.includes(converted.value)) {
          errors.push({ path, message: `值 "${converted.value}" 不在枚举 ${JSON.stringify(paramDef.enum)} 中` });
          continue;
        }
      }

      // 数值范围检查
      if ((paramDef.type === 'number' || paramDef.type === 'integer') && typeof converted.value === 'number') {
        if (paramDef.minimum !== undefined && converted.value < paramDef.minimum) {
          errors.push({ path, message: `值 ${converted.value} 小于最小值 ${paramDef.minimum}` });
          continue;
        }
        if (paramDef.maximum !== undefined && converted.value > paramDef.maximum) {
          errors.push({ path, message: `值 ${converted.value} 大于最大值 ${paramDef.maximum}` });
          continue;
        }
      }

      // 字符串长度检查
      if (paramDef.type === 'string' && typeof converted.value === 'string') {
        if (paramDef.minLength !== undefined && converted.value.length < paramDef.minLength) {
          errors.push({ path, message: `长度 ${converted.value.length} 小于最小长度 ${paramDef.minLength}` });
          continue;
        }
        if (paramDef.maxLength !== undefined && converted.value.length > paramDef.maxLength) {
          warnings.push({ path, message: `长度 ${converted.value.length} 超过最大长度 ${paramDef.maxLength}，已截断` });
          normalized[paramName] = converted.value.slice(0, paramDef.maxLength);
          continue;
        }
        if (paramDef.pattern && !new RegExp(paramDef.pattern).test(converted.value)) {
          errors.push({ path, message: `不匹配模式 ${paramDef.pattern}` });
          continue;
        }
      }

      normalized[paramName] = converted.value;
    }

    return {
      valid: errors.length === 0,
      errors,
      warnings,
      normalized,
    };
  }

  /**
   * 生成 JSON Schema（用于 LLM 约束输出）
   */
  generateJsonSchema(schema: ToolSchema): Record<string, unknown> {
    const properties: Record<string, unknown> = {};
    const required: string[] = [];

    for (const [name, def] of Object.entries(schema.parameters)) {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const prop: Record<string, any> = {
        type: def.type === 'enum' ? 'string' : def.type,
        description: def.description || name,
      };

      if (def.enum) prop.enum = def.enum;
      if (def.default !== undefined) prop.default = def.default;
      if (def.minimum !== undefined) prop.minimum = def.minimum;
      if (def.maximum !== undefined) prop.maximum = def.maximum;
      if (def.minLength !== undefined) prop.minLength = def.minLength;
      if (def.maxLength !== undefined) prop.maxLength = def.maxLength;
      if (def.pattern) prop.pattern = def.pattern;

      if (def.type === 'array' && def.items) {
        prop.items = {
          type: def.items.type,
          description: def.items.description || '',
        };
      }
      if (def.type === 'object' && def.properties) {
        prop.properties = {};
        for (const [k, v] of Object.entries(def.properties)) {
          prop.properties[k] = { type: v.type, description: v.description || k };
        }
      }

      properties[name] = prop;
      if (def.required !== false) required.push(name);
    }

    return {
      type: 'object',
      properties,
      required,
      additionalProperties: false,
    };
  }

  /**
   * 生成格式化提示（注入到系统提示中）
   */
  generateFormatHint(schema: ToolSchema): string {
    const params = Object.entries(schema.parameters)
      .map(([name, def]) => {
        const req = def.required !== false ? '必填' : '可选';
        const type = def.type === 'enum' ? `枚举(${def.enum?.join('|')})` : def.type;
        const defVal = def.default !== undefined ? `, 默认=${JSON.stringify(def.default)}` : '';
        return `  - ${name}: ${type} (${req})${defVal} — ${def.description || ''}`;
      })
      .join('\n');

    return `工具 "${schema.name}" 参数格式：
${params}

请严格输出 JSON 格式，不要包含注释或额外文本。`;
  }

  /**
   * 获取统计信息
   */
  getStats() {
    const total = this.stats.total;
    return {
      total,
      success: this.stats.success,
      failure: this.stats.failure,
      successRate: total > 0 ? this.stats.success / total : 0,
      byStrategy: { ...this.stats.byStrategy },
    };
  }

  /** 重置统计 */
  resetStats(): void {
    this.stats = {
      total: 0,
      success: 0,
      failure: 0,
      byStrategy: { strict: 0, lenient: 0, regex: 0, repair: 0, default: 0 },
    };
  }

  // ============ 私有方法 ============

  /** 策略 1: 严格 JSON 解析 */
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  private tryStrictParse(raw: string): any | null {
    try {
      return JSON.parse(raw);
    } catch {
      return null;
    }
  }

  /** 策略 2: 宽松 JSON 解析 */
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  private tryLenientParse(raw: string, repairs: string[]): any | null {
    try {
      let fixed = raw;

      // 修复尾逗号：{"a": 1,} → {"a": 1}
      if (/,\s*[}\]]/.test(fixed)) {
        fixed = fixed.replace(/,(\s*[}\]])/g, '$1');
        repairs.push('移除尾逗号');
      }

      // 修复单引号：{'a': 1} → {"a": 1}
      if (/'[^']*'\s*:/.test(fixed)) {
        fixed = fixed.replace(/'([^']*)'(\s*:)/g, '"$1"$2');
        repairs.push('单引号转双引号');
      }

      // 修复键名缺引号：{a: 1} → {"a": 1}
      if (/\{[^"']\w+\s*:/.test(fixed)) {
        fixed = fixed.replace(/\{(\w+)\s*:/g, '{"$1":');
        fixed = fixed.replace(/,(\w+)\s*:/g, ',"$1":');
        repairs.push('键名补全引号');
      }

      return JSON.parse(fixed);
    } catch {
      return null;
    }
  }

  /** 策略 3: 正则提取 JSON 块 */
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  private tryRegexExtract(raw: string, repairs: string[]): any | null {
    try {
      // 从 ```json ... ``` 代码块提取
      const codeBlockMatch = raw.match(/```(?:json)?\s*\n?([\s\S]*?)\n?```/);
      if (codeBlockMatch) {
        repairs.push('从代码块提取 JSON');
        return JSON.parse(codeBlockMatch[1]);
      }

      // 从文本中提取第一个 { ... } 对象
      const objMatch = raw.match(/\{[\s\S]*\}/);
      if (objMatch) {
        repairs.push('从文本提取 JSON 对象');
        return JSON.parse(objMatch[0]);
      }

      return null;
    } catch {
      return null;
    }
  }

  /** 策略 4: 修复重试 */
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  private tryRepair(raw: string, repairs: string[]): any | null {
    try {
      let fixed = raw;

      // 移除注释
      fixed = fixed.replace(/\/\/[^\n]*/g, '');
      fixed = fixed.replace(/\/\*[\s\S]*?\*\//g, '');
      if (fixed !== raw) repairs.push('移除注释');

      // 修复未闭合的括号
      const opens = (fixed.match(/\{/g) || []).length;
      const closes = (fixed.match(/\}/g) || []).length;
      if (opens > closes) {
        fixed += '}'.repeat(opens - closes);
        repairs.push('补全闭合括号');
      }

      // 修复换行符问题
      fixed = fixed.replace(/,\s*\n\s*\n/g, ',\n');
      if (fixed !== raw) repairs.push('清理多余换行');

      // 修复布尔值和 null
      fixed = fixed.replace(/:\s*True/gi, ': true').replace(/:\s*False/gi, ': false').replace(/:\s*None/gi, ': null');

      return JSON.parse(fixed);
    } catch {
      return null;
    }
  }

  /** 类型转换 */
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  private convertType(value: any, def: ParamDef, _path: string): { value: any; error?: string } {
    const expected = def.type;

    // 字符串
    if (expected === 'string') {
      if (typeof value === 'string') return { value };
      if (typeof value === 'number' || typeof value === 'boolean') {
        return { value: String(value) };
      }
      return { value: null, error: `期望 string，得到 ${typeof value}` };
    }

    // 数字
    if (expected === 'number') {
      if (typeof value === 'number') return { value };
      if (typeof value === 'string') {
        const num = Number(value);
        if (!isNaN(num)) return { value: num };
      }
      return { value: null, error: `期望 number，得到 ${typeof value}` };
    }

    // 整数
    if (expected === 'integer') {
      if (typeof value === 'number' && Number.isInteger(value)) return { value };
      if (typeof value === 'string') {
        const num = parseInt(value, 10);
        if (!isNaN(num)) return { value: num };
      }
      return { value: null, error: `期望 integer，得到 ${typeof value}` };
    }

    // 布尔值
    if (expected === 'boolean') {
      if (typeof value === 'boolean') return { value };
      if (typeof value === 'string') {
        if (value === 'true') return { value: true };
        if (value === 'false') return { value: false };
      }
      return { value: null, error: `期望 boolean，得到 ${typeof value}` };
    }

    // 数组
    if (expected === 'array') {
      if (Array.isArray(value)) return { value };
      // 单值转数组
      if (value !== undefined && value !== null) {
        return { value: [value] };
      }
      return { value: null, error: `期望 array，得到 ${typeof value}` };
    }

    // 对象
    if (expected === 'object') {
      if (typeof value === 'object' && value !== null && !Array.isArray(value)) {
        return { value };
      }
      return { value: null, error: `期望 object，得到 ${typeof value}` };
    }

    // 枚举（作为字符串处理）
    if (expected === 'enum') {
      if (typeof value === 'string') return { value };
      if (typeof value === 'number') return { value: String(value) };
      return { value: null, error: `期望 enum(string)，得到 ${typeof value}` };
    }

    return { value };
  }

  /** 生成默认值 */
  private generateDefaults(schema?: ToolSchema): Record<string, unknown> {
    if (!schema) return {};
    const defaults: Record<string, unknown> = {};
    for (const [name, def] of Object.entries(schema.parameters)) {
      if (def.default !== undefined) {
        defaults[name] = def.default;
      } else if (def.required !== false) {
        // 必填参数无默认值 — 给类型默认值
        defaults[name] = this.getTypeDefault(def.type);
      }
    }
    return defaults;
  }

  /** 获取类型默认值 */
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  private getTypeDefault(type: ParamType): any {
    switch (type) {
      case 'string': return '';
      case 'number': return 0;
      case 'integer': return 0;
      case 'boolean': return false;
      case 'array': return [];
      case 'object': return {};
      case 'enum': return '';
      default: return null;
    }
  }
}

// ============ 单例 ============

let enforcerInstance: StructuredOutputEnforcer | null = null;

export function getStructuredOutputEnforcer(): StructuredOutputEnforcer {
  if (!enforcerInstance) {
    enforcerInstance = new StructuredOutputEnforcer();
  }
  return enforcerInstance;
}

export function resetStructuredOutputEnforcer(): void {
  enforcerInstance = null;
}

// ============================================================
// 维度 9 P1：工具调用参数解析韧性包装
//
// 背景：所有 LLM 调用路径（enhanced-agent-loop + llm-streaming）
// 用裸 JSON.parse 解析 LLM 返回的 tool_call arguments，遇到截断/
// 单引号/尾逗号等格式错误时直接失败。StructuredOutputEnforcer 已实现
// 多策略降级（strict→lenient→regex→repair→default）但生产零引用。
// 本 helper 统一接入点，由所有 LLM 调用路径消费，灰度开关启用即生效。
// ============================================================

/**
 * 工具调用参数解析韧性包装
 *
 * - 灰度开关 USE_STRUCTURED_OUTPUT_ENFORCER=true：调用 enforcer 多策略降级
 * - 默认 false：走原 JSON.parse 兼容路径（与原代码行为一致）
 *
 * @param rawArgs LLM 返回的 tool_call arguments（JSON 字符串）
 * @param toolName 工具名（用于 schema 查询和失败日志；通过 enforcer.registerToolSchema 注册）
 * @returns 解析后的参数对象（失败时返回 {}）
 */
export function parseToolCallArgsResilient(
  rawArgs: string,
  toolName?: string,
): Record<string, unknown> {
  // 灰度开关：USE_STRUCTURED_OUTPUT_ENFORCER=true 启用多策略降级，默认关闭走 JSON.parse
  // 生产环境由 bootstrap.ts 显式设置 'true' 启用；测试环境保持默认关闭以验证两条路径
  const useEnforcer = process.env.USE_STRUCTURED_OUTPUT_ENFORCER === 'true';

  // 未启用 enforcer：走原 JSON.parse 兼容路径（行为不变）
  if (!useEnforcer) {
    try {
      return JSON.parse(rawArgs || '{}');
    } catch {
      return {};
    }
  }

  // 启用 enforcer：多策略降级（toolName 用于 schema 查询和日志）
  const enforcer = getStructuredOutputEnforcer();
  const result = enforcer.parseToolCallArgs(rawArgs, undefined, toolName);
  if (!result.success && toolName) {
    logger.debug('[parseToolCallArgsResilient] 参数解析失败', {
      toolName,
      strategy: result.strategy,
      errors: result.errors.slice(0, 3),
    });
  }
  return result.data;
}
