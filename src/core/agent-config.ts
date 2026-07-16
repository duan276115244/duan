/**
 * Agent 配置即代码系统 — AgentConfig
 *
 * 参考 OpenAI Agents SDK 的声明式 Agent 定义模式：
 * - Agent 不再通过命令式代码创建，而是通过配置对象声明式定义
 * - 支持 JSON/YAML 格式的配置文件加载
 * - 配置验证：检查必填字段、工具引用、Handoff 目标
 * - 配置导出：将运行时 Agent 配置序列化为可移植的配置定义
 * - 配置热加载：运行时动态加载和更新 Agent 配置
 *
 * 设计原则：
 * - 结构化日志：logger.child({ module: 'AgentConfig' })
 * - 事件驱动：EventBus.getInstance().emitSync() 广播关键事件
 * - 统一工具格式：ToolDef 兼容 agent-loop.ts 的工具注册体系
 */

import * as fs from 'fs';
import * as path from 'path';
import { logger } from './structured-logger.js';
import { EventBus } from './event-bus.js';

// ============ 类型定义 ============

/** Agent 配置定义 — 声明式描述一个 Agent 的完整配置 */
export interface AgentConfigDefinition {
  id: string;
  name: string;
  version: string;
  description: string;
  systemPrompt: string;
  model?: string;
  tools: string[];
  handoffs: HandoffConfig[];
  guardrails: GuardrailConfig[];
  maxIterations?: number;
  temperature?: number;
  metadata?: Record<string, unknown>;
}

/** Handoff 配置 — 描述 Agent 间的控制转移规则 */
export interface HandoffConfig {
  targetAgent: string;
  condition: string;
  contextTransfer: 'full' | 'summary' | 'minimal';
}

/** 护栏配置 — 描述输入/输出校验规则 */
export interface GuardrailConfig {
  type: 'input' | 'output';
  name: string;
  rules: string[];
}

/** 配置验证结果 */
export interface ConfigValidationResult {
  valid: boolean;
  errors: Array<{ field: string; message: string }>;
  warnings: string[];
}

import type { ToolDef } from './unified-tool-def.js';

/** 配置摘要 — 用于列表展示 */
interface ConfigSummary {
  id: string;
  name: string;
  version: string;
  description: string;
  toolCount: number;
  handoffCount: number;
  guardrailCount: number;
  loadedAt: number;
}

/** AgentConfig 统计信息 */
interface AgentConfigStats {
  loadedConfigs: number;
  totalTools: number;
  totalHandoffs: number;
  totalGuardrails: number;
  configList: ConfigSummary[];
  validationRuns: number;
  validationFailures: number;
}

// ============ 主类 ============

export class AgentConfig {
  private configs: Map<string, AgentConfigDefinition> = new Map();
  private loadedAt: Map<string, number> = new Map();
  private log = logger.child({ module: 'AgentConfig' });

  // 统计
  private validationRuns = 0;
  private validationFailures = 0;

  constructor() {
    this.log.info('Agent 配置即代码系统初始化完成');
  }

  // ========== 核心 API ==========

  /**
   * 从文件加载 Agent 配置
   * 支持 JSON 和 YAML 格式
   */
  loadConfig(configPath: string): AgentConfigDefinition {
    const resolvedPath = path.resolve(configPath);

    if (!fs.existsSync(resolvedPath)) {
      const error = `配置文件不存在: ${resolvedPath}`;
      this.log.error('配置加载失败', { path: resolvedPath, error });
      throw new Error(error);
    }

    const ext = path.extname(resolvedPath).toLowerCase();
    let rawConfig: unknown;

    try {
      const content = fs.readFileSync(resolvedPath, 'utf-8');

      if (ext === '.json') {
        rawConfig = JSON.parse(content);
      } else if (ext === '.yaml' || ext === '.yml') {
        // 简易 YAML 解析：支持基本键值对和嵌套结构
        rawConfig = this.parseSimpleYaml(content);
      } else {
        throw new Error(`不支持的配置文件格式: ${ext}，仅支持 .json / .yaml / .yml`);
      }
    } catch (err: unknown) {
      const error = `配置文件解析失败: ${(err instanceof Error ? err.message : String(err))}`;
      this.log.error('配置解析失败', { path: resolvedPath, error: (err instanceof Error ? err.message : String(err)) });
      throw new Error(error);
    }

    // 验证配置
    const validation = this.validateConfig(rawConfig as AgentConfigDefinition);
    if (!validation.valid) {
      const errorMessages = validation.errors.map(e => `${e.field}: ${e.message}`).join('; ');
      this.log.error('配置验证失败', { path: resolvedPath, errors: validation.errors });
      throw new Error(`配置验证失败: ${errorMessages}`);
    }

    const config = rawConfig as AgentConfigDefinition;
    this.configs.set(config.id, config);
    this.loadedAt.set(config.id, Date.now());

    EventBus.getInstance().emitSync('agentconfig.loaded', {
      configId: config.id,
      configName: config.name,
      version: config.version,
      path: resolvedPath,
    }, { source: 'AgentConfig' });

    this.log.info('配置加载成功', {
      configId: config.id,
      configName: config.name,
      version: config.version,
      tools: config.tools.length,
      handoffs: config.handoffs.length,
      guardrails: config.guardrails.length,
    });

    return config;
  }

  /**
   * 从声明式配置创建 Agent 定义
   * 将配置注册到系统，返回可供 HandoffSystem 使用的 Agent 定义
   */
  createAgentFromConfig(config: AgentConfigDefinition): {
    success: boolean;
    agentId: string;
    message: string;
  } {
    // 先验证配置
    const validation = this.validateConfig(config);
    if (!validation.valid) {
      const errorMessages = validation.errors.map(e => `${e.field}: ${e.message}`).join('; ');
      this.log.error('创建 Agent 失败: 配置验证不通过', { configId: config.id, errors: validation.errors });
      return {
        success: false,
        agentId: config.id,
        message: `配置验证失败: ${errorMessages}`,
      };
    }

    // 记录警告
    if (validation.warnings.length > 0) {
      this.log.warn('配置验证警告', { configId: config.id, warnings: validation.warnings });
    }

    // 注册配置
    this.configs.set(config.id, config);
    this.loadedAt.set(config.id, Date.now());

    EventBus.getInstance().emitSync('agentconfig.created', {
      agentId: config.id,
      agentName: config.name,
      version: config.version,
      tools: config.tools,
      handoffs: config.handoffs.map(h => h.targetAgent),
      guardrails: config.guardrails.map(g => g.name),
    }, { source: 'AgentConfig' });

    this.log.info('Agent 从配置创建成功', {
      agentId: config.id,
      agentName: config.name,
      version: config.version,
      toolCount: config.tools.length,
      handoffCount: config.handoffs.length,
      guardrailCount: config.guardrails.length,
    });

    return {
      success: true,
      agentId: config.id,
      message: `Agent "${config.name}" (${config.id}) v${config.version} 创建成功，` +
        `包含 ${config.tools.length} 个工具、${config.handoffs.length} 个 Handoff、${config.guardrails.length} 个护栏`,
    };
  }

  /**
   * 验证 Agent 配置
   * 检查必填字段、工具引用、Handoff 目标等
   */
  validateConfig(config: AgentConfigDefinition): ConfigValidationResult {
    this.validationRuns++;

    const errors: Array<{ field: string; message: string }> = [];
    const warnings: string[] = [];

    // 1. 必填字段检查
    if (!config.id || typeof config.id !== 'string' || config.id.trim() === '') {
      errors.push({ field: 'id', message: 'id 为必填字段，且不能为空字符串' });
    } else if (!/^[a-zA-Z0-9_-]+$/.test(config.id)) {
      errors.push({ field: 'id', message: 'id 只能包含字母、数字、下划线和连字符' });
    }

    if (!config.name || typeof config.name !== 'string' || config.name.trim() === '') {
      errors.push({ field: 'name', message: 'name 为必填字段，且不能为空字符串' });
    }

    if (!config.version || typeof config.version !== 'string' || config.version.trim() === '') {
      errors.push({ field: 'version', message: 'version 为必填字段，且不能为空字符串' });
    } else if (!/^\d+\.\d+\.\d+/.test(config.version)) {
      warnings.push(`version "${config.version}" 不符合语义化版本规范 (semver)，建议使用 x.y.z 格式`);
    }

    if (!config.description || typeof config.description !== 'string' || config.description.trim() === '') {
      errors.push({ field: 'description', message: 'description 为必填字段，且不能为空字符串' });
    }

    if (!config.systemPrompt || typeof config.systemPrompt !== 'string' || config.systemPrompt.trim() === '') {
      errors.push({ field: 'systemPrompt', message: 'systemPrompt 为必填字段，且不能为空字符串' });
    }

    // 2. 工具列表检查
    if (!Array.isArray(config.tools)) {
      errors.push({ field: 'tools', message: 'tools 必须是字符串数组' });
    } else {
      if (config.tools.length === 0) {
        warnings.push('tools 为空数组，Agent 将没有任何工具可用');
      }
      for (let i = 0; i < config.tools.length; i++) {
        if (typeof config.tools[i] !== 'string' || config.tools[i].trim() === '') {
          errors.push({ field: `tools[${i}]`, message: '工具名称必须是非空字符串' });
        }
      }
      // 检查重复工具
      const uniqueTools = new Set(config.tools);
      if (uniqueTools.size !== config.tools.length) {
        warnings.push('tools 中存在重复的工具名称');
      }
    }

    // 3. Handoff 配置检查
    if (!Array.isArray(config.handoffs)) {
      errors.push({ field: 'handoffs', message: 'handoffs 必须是数组' });
    } else {
      for (let i = 0; i < config.handoffs.length; i++) {
        const h = config.handoffs[i];
        if (!h.targetAgent || typeof h.targetAgent !== 'string') {
          errors.push({ field: `handoffs[${i}].targetAgent`, message: 'targetAgent 为必填字段' });
        }
        if (!h.condition || typeof h.condition !== 'string') {
          errors.push({ field: `handoffs[${i}].condition`, message: 'condition 为必填字段' });
        }
        if (!['full', 'summary', 'minimal'].includes(h.contextTransfer)) {
          errors.push({ field: `handoffs[${i}].contextTransfer`, message: 'contextTransfer 必须是 full/summary/minimal 之一' });
        }
        // 检查自引用 Handoff
        if (h.targetAgent === config.id) {
          errors.push({ field: `handoffs[${i}].targetAgent`, message: '不允许 Handoff 到自身' });
        }
      }

      // 检查重复 Handoff 目标
      const handoffTargets = config.handoffs.map(h => h.targetAgent);
      const uniqueTargets = new Set(handoffTargets);
      if (uniqueTargets.size !== handoffTargets.length) {
        warnings.push('handoffs 中存在重复的 targetAgent');
      }
    }

    // 4. 护栏配置检查
    if (!Array.isArray(config.guardrails)) {
      errors.push({ field: 'guardrails', message: 'guardrails 必须是数组' });
    } else {
      for (let i = 0; i < config.guardrails.length; i++) {
        const g = config.guardrails[i];
        if (!['input', 'output'].includes(g.type)) {
          errors.push({ field: `guardrails[${i}].type`, message: 'type 必须是 input 或 output' });
        }
        if (!g.name || typeof g.name !== 'string') {
          errors.push({ field: `guardrails[${i}].name`, message: 'name 为必填字段' });
        }
        if (!Array.isArray(g.rules) || g.rules.length === 0) {
          errors.push({ field: `guardrails[${i}].rules`, message: 'rules 必须是非空字符串数组' });
        }
      }
    }

    // 5. 可选字段范围检查
    if (config.maxIterations !== undefined) {
      if (typeof config.maxIterations !== 'number' || config.maxIterations < 1 || config.maxIterations > 100) {
        errors.push({ field: 'maxIterations', message: 'maxIterations 必须是 1-100 之间的数字' });
      }
    }

    if (config.temperature !== undefined) {
      if (typeof config.temperature !== 'number' || config.temperature < 0 || config.temperature > 2) {
        errors.push({ field: 'temperature', message: 'temperature 必须是 0-2 之间的数字' });
      }
    }

    // 6. systemPrompt 长度建议
    if (config.systemPrompt && config.systemPrompt.length > 10000) {
      warnings.push(`systemPrompt 长度 (${config.systemPrompt.length} 字符) 过长，可能影响 Token 预算`);
    }

    const result: ConfigValidationResult = {
      valid: errors.length === 0,
      errors,
      warnings,
    };

    if (!result.valid) {
      this.validationFailures++;
    }

    this.log.debug('配置验证完成', {
      valid: result.valid,
      errorCount: errors.length,
      warningCount: warnings.length,
    });

    return result;
  }

  /**
   * 导出 Agent 配置为可序列化的配置定义
   */
  exportConfig(agentId: string): AgentConfigDefinition | null {
    const config = this.configs.get(agentId);
    if (!config) {
      this.log.warn('导出配置失败: Agent 不存在', { agentId });
      return null;
    }

    // 深拷贝以避免外部修改（structuredClone 比 JSON.parse(JSON.stringify()) 更快且支持 Date/Map 等类型）
    const exported: AgentConfigDefinition = structuredClone(config);

    EventBus.getInstance().emitSync('agentconfig.exported', {
      agentId: config.id,
      agentName: config.name,
      version: config.version,
    }, { source: 'AgentConfig' });

    this.log.info('配置导出成功', {
      agentId: config.id,
      agentName: config.name,
    });

    return exported;
  }

  /**
   * 列出所有已加载的配置摘要
   */
  listConfigs(): ConfigSummary[] {
    const summaries: ConfigSummary[] = [];

    for (const [id, config] of this.configs) {
      summaries.push({
        id,
        name: config.name,
        version: config.version,
        description: config.description,
        toolCount: config.tools.length,
        handoffCount: config.handoffs.length,
        guardrailCount: config.guardrails.length,
        loadedAt: this.loadedAt.get(id) || 0,
      });
    }

    return summaries;
  }

  /**
   * 获取指定 Agent 配置
   */
  getConfig(agentId: string): AgentConfigDefinition | undefined {
    return this.configs.get(agentId);
  }

  /**
   * 删除指定 Agent 配置
   */
  removeConfig(agentId: string): boolean {
    const existed = this.configs.delete(agentId);
    this.loadedAt.delete(agentId);

    if (existed) {
      EventBus.getInstance().emitSync('agentconfig.removed', {
        agentId,
      }, { source: 'AgentConfig' });

      this.log.info('配置已删除', { agentId });
    }

    return existed;
  }

  /**
   * 获取统计信息
   */
  getStats(): AgentConfigStats {
    let totalTools = 0;
    let totalHandoffs = 0;
    let totalGuardrails = 0;

    for (const config of this.configs.values()) {
      totalTools += config.tools.length;
      totalHandoffs += config.handoffs.length;
      totalGuardrails += config.guardrails.length;
    }

    return {
      loadedConfigs: this.configs.size,
      totalTools,
      totalHandoffs,
      totalGuardrails,
      configList: this.listConfigs(),
      validationRuns: this.validationRuns,
      validationFailures: this.validationFailures,
    };
  }

  // ========== Agent Loop 工具定义 ==========

  /**
   * 返回 ToolDef 兼容的工具定义列表，供 agent-loop 注册
   */
  getToolDefinitions(): ToolDef[] {
    // eslint-disable-next-line @typescript-eslint/no-this-alias
    const self = this;

    return [
      {
        name: 'agentconfig_load',
        description: '从文件加载 Agent 配置。支持 JSON 和 YAML 格式的配置文件。加载后会自动验证配置的完整性和正确性。',
        parameters: {
          config_path: {
            type: 'string',
            description: '配置文件的路径，支持 .json / .yaml / .yml 格式',
            required: true,
          },
        },
        execute: (args) => {
          try {
            const configPath = args.config_path as string;
            const config = self.loadConfig(configPath);
            return Promise.resolve(`✅ 配置加载成功\n` +
              `ID: ${config.id}\n` +
              `名称: ${config.name}\n` +
              `版本: ${config.version}\n` +
              `描述: ${config.description}\n` +
              `工具: ${config.tools.length} 个\n` +
              `Handoff: ${config.handoffs.length} 个\n` +
              `护栏: ${config.guardrails.length} 个`);
          } catch (err: unknown) {
            return Promise.resolve(`❌ 配置加载失败: ${(err instanceof Error ? err.message : String(err))}`);
          }
        },
      },
      {
        name: 'agentconfig_validate',
        description: '验证 Agent 配置的完整性和正确性。检查必填字段、工具引用、Handoff 目标、护栏规则等。此操作只读，不会修改任何配置。',
        readOnly: true,
        parameters: {
          config_json: {
            type: 'string',
            description: '要验证的 Agent 配置 JSON 字符串',
            required: true,
          },
        },
        execute: (args) => {
          try {
            const configJson = args.config_json as string;
            let config: AgentConfigDefinition;
            try {
              config = JSON.parse(configJson);
            } catch {
              return Promise.resolve('❌ 配置 JSON 解析失败，请检查格式');
            }

            const result = self.validateConfig(config);

            let output = `📋 配置验证结果: ${result.valid ? '✅ 通过' : '❌ 未通过'}\n`;

            if (result.errors.length > 0) {
              output += `\n🚨 错误 (${result.errors.length}个):\n`;
              for (const err of result.errors) {
                output += `  - [${err.field}] ${err.message}\n`;
              }
            }

            if (result.warnings.length > 0) {
              output += `\n⚠️ 警告 (${result.warnings.length}个):\n`;
              for (const warn of result.warnings) {
                output += `  - ${warn}\n`;
              }
            }

            if (result.valid && result.warnings.length === 0) {
              output += '\n配置完全合规，无错误和警告。';
            }

            return Promise.resolve(output);
          } catch (err: unknown) {
            return Promise.resolve(`❌ 验证过程异常: ${(err instanceof Error ? err.message : String(err))}`);
          }
        },
      },
      {
        name: 'agentconfig_export',
        description: '导出指定 Agent 的配置为 JSON 格式。返回可序列化的配置定义，可用于备份、迁移或版本管理。此操作只读。',
        readOnly: true,
        parameters: {
          agent_id: {
            type: 'string',
            description: '要导出配置的 Agent ID',
            required: true,
          },
        },
        execute: (args) => {
          try {
            const agentId = args.agent_id as string;
            const config = self.exportConfig(agentId);

            if (!config) {
              return Promise.resolve(`❌ 未找到 Agent "${agentId}" 的配置`);
            }

            return Promise.resolve(JSON.stringify(config, null, 2));
          } catch (err: unknown) {
            return Promise.resolve(`❌ 配置导出失败: ${(err instanceof Error ? err.message : String(err))}`);
          }
        },
      },
      {
        name: 'agentconfig_list',
        description: '列出所有已加载的 Agent 配置摘要。包括 ID、名称、版本、工具数量、Handoff 数量等信息。此操作只读。',
        readOnly: true,
        parameters: {},
        execute: () => {
          const summaries = self.listConfigs();
          const stats = self.getStats();

          if (summaries.length === 0) {
            return Promise.resolve('📭 暂无已加载的 Agent 配置');
          }

          let output = `📋 已加载 Agent 配置 (${summaries.length}个):\n\n`;

          for (const s of summaries) {
            const loadTime = new Date(s.loadedAt).toLocaleString('zh-CN');
            output += `🤖 ${s.name} (${s.id}) v${s.version}\n`;
            output += `  描述: ${s.description.substring(0, 80)}\n`;
            output += `  工具: ${s.toolCount} | Handoff: ${s.handoffCount} | 护栏: ${s.guardrailCount}\n`;
            output += `  加载时间: ${loadTime}\n\n`;
          }

          output += `---\n`;
          output += `总计: ${stats.loadedConfigs} 个配置 | ${stats.totalTools} 个工具 | ${stats.totalHandoffs} 个 Handoff | ${stats.totalGuardrails} 个护栏\n`;
          output += `验证: ${stats.validationRuns} 次 (失败 ${stats.validationFailures} 次)`;

          return Promise.resolve(output);
        },
      },
    ];
  }

  // ========== 私有方法 ==========

  /**
   * 简易 YAML 解析器
   * 支持基本键值对、嵌套结构、数组和字符串值
   * 不支持复杂的 YAML 特性（锚点、多文档等）
   */
  private parseSimpleYaml(content: string): unknown {
    const lines = content.split('\n');
    const result: Record<string, unknown> = {};
    const stack: Array<{ obj: Record<string, unknown>; indent: number }> = [{ obj: result, indent: -1 }];

    for (let i = 0; i < lines.length; i++) {
      const line = lines[i];

      // 跳过空行和注释
      if (line.trim() === '' || line.trim().startsWith('#')) continue;

      const indent = line.search(/\S/);
      const trimmed = line.trim();

      // 弹出栈中缩进大于等于当前行的项
      while (stack.length > 1 && stack[stack.length - 1].indent >= indent) {
        stack.pop();
      }

      const current = stack[stack.length - 1].obj;

      // 数组项
      if (trimmed.startsWith('- ')) {
        const value = this.parseYamlValue(trimmed.substring(2).trim());
        const arr = Object.values(current)[0];
        if (Array.isArray(arr)) {
          arr.push(value);
        }
        continue;
      }

      // 键值对
      const colonIdx = trimmed.indexOf(':');
      if (colonIdx === -1) continue;

      const key = trimmed.substring(0, colonIdx).trim();
      const valueStr = trimmed.substring(colonIdx + 1).trim();

      if (valueStr === '' || valueStr === '|' || valueStr === '>') {
        // 嵌套对象或数组
        if (valueStr === '') {
          // 检查下一行是否为数组
          const nextLine = lines[i + 1]?.trim() || '';
          if (nextLine.startsWith('- ')) {
            const newArr: unknown[] = [];
            current[key] = newArr;
            // 后续的 - 项会被添加到这个数组
            // 简化处理：将嵌套数组解析为字符串数组
            let j = i + 1;
            while (j < lines.length) {
              const nl = lines[j].trim();
              if (nl.startsWith('- ')) {
                newArr.push(this.parseYamlValue(nl.substring(2).trim()));
                j++;
              } else {
                break;
              }
            }
            i = j - 1; // 跳过已处理的行
          } else {
            const newObj: Record<string, unknown> = {};
            current[key] = newObj;
            stack.push({ obj: newObj, indent });
          }
        }
      } else {
        current[key] = this.parseYamlValue(valueStr);
      }
    }

    return result;
  }

  /**
   * 解析 YAML 值为合适的类型
   */
  private parseYamlValue(value: string): unknown {
    // 去除引号
    if ((value.startsWith('"') && value.endsWith('"')) ||
        (value.startsWith("'") && value.endsWith("'"))) {
      return value.slice(1, -1);
    }

    // 布尔值
    if (value === 'true') return true;
    if (value === 'false') return false;

    // null
    if (value === 'null' || value === '~') return null;

    // 数字
    if (/^-?\d+$/.test(value)) return parseInt(value, 10);
    if (/^-?\d+\.\d+$/.test(value)) return parseFloat(value);

    // 内联数组 [a, b, c]
    if (value.startsWith('[') && value.endsWith(']')) {
      const inner = value.slice(1, -1).trim();
      if (inner === '') return [];
      return inner.split(',').map(item => this.parseYamlValue(item.trim()));
    }

    // 内联对象 {key: value}
    if (value.startsWith('{') && value.endsWith('}')) {
      try {
        return JSON.parse(value);
      } catch {
        return value;
      }
    }

    return value;
  }
}
