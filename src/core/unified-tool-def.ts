/**
 * 统一工具定义接口
 * 融合了 agent-loop.ts 的 ToolDef + ScalableToolRegistry 的 ScalableToolDef + UnifiedToolFramework 的安全字段
 */

export { errMsg } from './utils.js';

export type ToolCategory =
  | 'desktop' | 'file' | 'code' | 'web' | 'system'
  | 'communication' | 'creative' | 'data' | 'nlu'
  | 'memory' | 'task' | 'skill' | 'other';

export type ToolRiskLevel = 'safe' | 'moderate' | 'dangerous';
export type ExecutionPolicy = 'parallel' | 'serial' | 'approval_required';
export type SandboxMode = 'none' | 'vm' | 'docker' | 'process';
export type ModelTier = 'basic' | 'standard' | 'advanced' | 'reasoning';

export interface ToolExecutionContext {
  workingDirectory?: string;
  projectRoot?: string;
  requestId?: string;
  userId?: string;
}

export interface UnifiedToolDef {
  // 基础字段 (来自 ToolDef)
  name: string;
  description: string;
  parameters: Record<string, { type: string; description: string; required?: boolean }>;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  execute: (args: any, context?: ToolExecutionContext) => Promise<string>;
  readOnly?: boolean;

  // 分类字段 (来自 ScalableToolDef)
  id?: string;  // 默认等于 name
  category?: ToolCategory;
  priority?: number;
  tags?: string[];
  version?: string;
  dependencies?: string[];

  // 安全字段 (来自 UnifiedToolFramework)
  riskLevel?: ToolRiskLevel;
  executionPolicy?: ExecutionPolicy;
  sandbox?: SandboxMode;
  approvalMessage?: string;

  // 性能字段 (来自 ScalableToolRegistry)
  minModelTier?: ModelTier;
  enabled?: boolean;

  // 延迟初始化
  init?: () => Promise<void>;

  // 运行时字段 (框架管理，注册时不需要)
  initialized?: boolean;
  initError?: string;
  lastUsed?: number;
  usageCount?: number;
  avgExecutionTime?: number;
  successRate?: number;
}

/**
 * 工具风险等级映射 — 全项目唯一来源 (Single Source of Truth)
 *
 * 所有注册表（bootstrap.ts、tool-registry-adapter.ts、enhanced-loop-types.ts、
 * unified-registry.ts）必须从此导入，禁止本地定义重复的 riskMap。
 */
export const TOOL_RISK_MAP: Readonly<Record<string, ToolRiskLevel>> = {
  // safe: 只读、查询类工具
  code_execute: 'safe',
  file_read: 'safe',
  list_directory: 'safe',
  search_files: 'safe',
  current_time: 'safe',
  web_search: 'safe',
  web_fetch: 'safe',
  self_read: 'safe',
  self_test: 'safe',
  self_learn: 'safe',
  self_evolve: 'safe',

  // moderate: 有副作用但可控
  http_request: 'moderate',

  // dangerous: 破坏性操作
  file_write: 'dangerous',
  shell_execute: 'dangerous',
  self_write: 'dangerous',
  self_rollback: 'dangerous',
};

/** 兼容旧版 ToolDef 类型别名 */
export type ToolDef = UnifiedToolDef;

/**
 * 精确工具名 -> 分类 (最高优先级)
 *
 * 用于无法仅靠前缀正确归类、或与某个通用前缀冲突的工具名。
 * 例如 list_agents 若仅靠前缀会被 `list_` 误归为 file。
 */
const TOOL_CATEGORY_BY_NAME: Readonly<Record<string, ToolCategory>> = {
  create_tool: 'system',
  list_tools: 'system',
  tool_install: 'system',
  list_agents: 'task',
};

/**
 * 前缀 -> 分类 (次优先级)
 *
 * 按前缀长度降序排列，确保更具体的前缀（如 self_memory、self_skill、list_plan）
 * 在通用前缀（如 self_、list_）之前被匹配，避免顺序敏感导致的不可达逻辑。
 */
const TOOL_CATEGORY_BY_PREFIX: ReadonlyArray<readonly [string, ToolCategory]> = (
  [
    ['self_memory', 'memory'],
    ['self_skill', 'skill'],
    ['self_', 'system'],
    ['search_files', 'file'],
    ['file_', 'file'],
    ['list_plan', 'task'],
    ['list_', 'file'],
    ['web_', 'web'],
    ['http_', 'web'],
    ['browser_', 'web'],
    ['desktop_', 'desktop'],
    ['screen_', 'desktop'],
    ['shell_', 'code'],
    ['code_', 'code'],
    ['spawn_', 'task'],
    ['wait_', 'task'],
    ['create_plan', 'task'],
    ['update_plan', 'task'],
    ['get_plan', 'task'],
  ] as Array<[string, ToolCategory]>
).sort((a, b) => b[0].length - a[0].length);

export function inferCategory(toolName: string): ToolCategory {
  // 1. 精确名称匹配 (最高优先级)
  const exact = TOOL_CATEGORY_BY_NAME[toolName];
  if (exact) return exact;

  // 2. 前缀匹配 (按前缀长度降序，更具体的前缀优先)
  for (const [prefix, category] of TOOL_CATEGORY_BY_PREFIX) {
    if (toolName.startsWith(prefix)) return category;
  }

  return 'other';
}
