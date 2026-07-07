/**
 * 工具注册表适配器 — 将 ScalableToolRegistry 适配为 IToolRegistry 接口
 *
 * 连接 ScalableToolRegistry（高性能注册表）与 EnhancedAgentLoop（期望 IToolRegistry）。
 * 提供风险等级、执行策略、沙箱、审批等元数据能力。
 */
import { TOOL_RISK_MAP, type ToolDef, type ToolCategory } from './unified-tool-def.js';
import type { ToolRiskLevel, ExecutionPolicy, ToolRegistryEntry, IToolRegistry } from './enhanced-loop-types.js';
import type { ScalableToolRegistry, ScalableToolDef } from './scalable-tool-registry.js';
import { getStructuredOutputEnforcer, type ToolSchema, type ParamDef, type ParamType } from './structured-output-enforcer.js';

/** 将 ToolDef 的 parameters 转换为 enforcer 的 ToolSchema 格式 */
function toolDefToSchema(def: ToolDef): ToolSchema {
  const parameters: Record<string, ParamDef> = {};
  for (const [name, p] of Object.entries(def.parameters || {})) {
    parameters[name] = {
      type: p.type as ParamType,
      description: p.description,
      required: p.required,
    };
  }
  return {
    name: def.name,
    description: def.description || '',
    parameters,
  };
}

interface ToolMeta {
  riskLevel: ToolRiskLevel;
  executionPolicy: ExecutionPolicy;
  sandboxEnabled: boolean;
  approvalMessage: string;
}

export class ToolRegistryAdapter implements IToolRegistry {
  private meta: Map<string, ToolMeta> = new Map();

  constructor(
    public readonly scalable: ScalableToolRegistry,
    private defaultCategory: ToolCategory = 'other',
    private defaultPriority: number = 50,
  ) {}

  register(
    definition: ToolDef,
    riskLevel: ToolRiskLevel = 'moderate',
    executionPolicy: ExecutionPolicy = definition.readOnly ? 'parallel' : 'serial',
    sandboxEnabled: boolean = false,
    approvalMessage: string = '',
  ): void {
    // 始终更新 meta（允许覆盖风险等级）
    this.meta.set(definition.name, { riskLevel, executionPolicy, sandboxEnabled, approvalMessage });

    // 注册 schema 到 StructuredOutputEnforcer（v19 P1-W3：让 parseToolCallArgsResilient 能基于 toolName 查询 schema 做校验）
    getStructuredOutputEnforcer().registerToolSchema(definition.name, toolDefToSchema(definition));

    // ScalableToolRegistry 中的工具已存在则跳过（避免重复注册警告）
    // 注意：必须用同步的 Map.get，而非 async getTool()——后者返回 Promise（恒 truthy），会导致注册永远被跳过
    const existing = this.scalable['tools'].get(definition.name);
    if (existing) return;

    const tool: Omit<ScalableToolDef, 'initialized' | 'initError' | 'lastUsed' | 'usageCount' | 'avgExecutionTime' | 'successRate'> = {
      id: definition.name,
      name: definition.name,
      description: definition.description || '',
      parameters: definition.parameters || {},
      category: this.defaultCategory,
      priority: this.defaultPriority,
      execute: definition.execute,
      readOnly: definition.readOnly,
      riskLevel: riskLevel,
      enabled: true,
    };
    this.scalable.register(tool);
  }

  registerAll(toolDefs: ToolDef[]): void {
    for (const def of toolDefs) {
      const risk = TOOL_RISK_MAP[def.name] || (def.readOnly ? 'safe' : 'moderate');
      const policy: ExecutionPolicy = def.readOnly ? 'parallel' : 'serial';
      this.register(def, risk as ToolRiskLevel, policy);
    }
  }

  get(name: string): ToolRegistryEntry | undefined {
    const tool = this.scalable['tools'].get(name);
    if (!tool) return undefined;

    const m = this.meta.get(name) || {
      // 直接注册到 ScalableToolRegistry 的工具无 meta；回退使用 ScalableToolDef 的 riskLevel
      riskLevel: (tool.riskLevel as ToolRiskLevel) || 'moderate',
      executionPolicy: tool.readOnly ? ('parallel' as ExecutionPolicy) : ('serial' as ExecutionPolicy),
      sandboxEnabled: false,
      approvalMessage: `即将执行 ${name}，此操作可能产生副作用。`,
    };

    return {
      definition: {
        name: tool.name,
        description: tool.description,
        parameters: tool.parameters,
        execute: tool.execute,
        readOnly: tool.readOnly,
      },
      riskLevel: m.riskLevel,
      executionPolicy: m.executionPolicy,
      sandboxEnabled: m.sandboxEnabled,
      approvalMessage: m.approvalMessage,
    };
  }

  getRiskLevel(name: string): ToolRiskLevel {
    const m = this.meta.get(name);
    if (m) return m.riskLevel;
    // 回退到 ScalableToolDef 的 riskLevel（支持直接注册到 scalable 的工具）
    const tool = this.scalable['tools'].get(name);
    return (tool?.riskLevel as ToolRiskLevel) || 'moderate';
  }

  getExecutionPolicy(name: string): ExecutionPolicy {
    const m = this.meta.get(name);
    if (m) return m.executionPolicy;
    const tool = this.scalable['tools'].get(name);
    return tool?.readOnly ? 'parallel' : 'serial';
  }

  getAllDefinitions(): ToolDef[] {
    // 直接读取 scalable 内部 Map（同步），保留 enabled 过滤；与 ScalableToolRegistry.getAllDefinitions() 等价
    return Array.from(this.scalable['tools'].values())
      .filter(t => t.enabled)
      .map(t => ({
        name: t.name,
        description: t.description,
        parameters: t.parameters,
        execute: t.execute,
        readOnly: t.readOnly,
      }));
  }

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  getOpenAITools(userMessage?: string, maxTools: number = 30): any[] {
    return this.scalable.getOpenAITools(userMessage, maxTools);
  }

}
