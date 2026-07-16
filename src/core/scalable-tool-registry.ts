/**
 * 可扩展工具注册表 — ScalableToolRegistry
 *
 * 面向 100+ 工具的高性能、分类感知、延迟加载注册表：
 * - 分类索引：O(1) 分类查找
 * - 标签倒排索引：快速标签搜索
 * - LRU 缓存：工具选择结果缓存（TTL=60s）
 * - 延迟初始化：首次调用时才 init
 * - 批量初始化：启动时并行 init
 * - 防抖持久化：最多每 5s 保存一次
 * - 熔断器：连续 3 次失败自动禁用 5 分钟
 * - 执行超时：默认 30s
 * - 内存监控：执行内存 > 100MB 告警
 * - 优雅降级：过多工具初始化失败时回退核心集
 */

import * as fs from 'fs';
import * as path from 'path';
import { logger } from './structured-logger.js';
import { EventBus, Events } from './event-bus.js';
import type { ToolRiskLevel } from './enhanced-loop-types.js';
import { errMsg } from './utils.js';
import { inferCategory, type ToolCategory, type ToolDef } from './unified-tool-def.js';
import { atomicWriteJson } from './atomic-write.js';

// ============ 类型定义 ============

export interface ScalableToolDef extends ToolDef {
  id: string;
  category: ToolCategory;
  priority: number;
  enabled: boolean;
  initialized: boolean;
  usageCount: number;
  avgExecutionTime: number;
  successRate: number;
}

export interface ToolSelectionContext {
  intent?: string;
  domain?: string;
  modelTier?: string;
  maxTools?: number;
  includeCategories?: ToolCategory[];
  excludeCategories?: ToolCategory[];
  onlyReadOnly?: boolean;
  maxRiskLevel?: 'safe' | 'moderate' | 'dangerous';
  recentToolIds?: string[];
}

export interface ToolSelectionResult {
  tools: ScalableToolDef[];
  selectionReason: string;
  totalAvailable: number;
  filtered: number;
}

interface CachedSelection {
  result: ToolSelectionResult;
  expiresAt: number;
}

interface CircuitState {
  consecutiveFailures: number;
  disabledUntil: number;
}

interface PersistedToolState {
  enabled: boolean;
  usageCount: number;
  avgExecutionTime: number;
  successRate: number;
  lastUsed?: number;
}

// ============ 审批与权限类型 ============

export interface ApprovalRequest {
  toolId: string;
  toolName: string;
  toolArgs: Record<string, unknown>;
  riskLevel: ToolRiskLevel;
  reason: string;
  timestamp: number;
}

export interface ApprovalResult {
  approved: boolean;
  reason?: string;
  modifiedArgs?: Record<string, unknown>;
}

export type ApprovalCallback = (request: ApprovalRequest) => Promise<ApprovalResult>;

export type PermissionPolicy = 'auto_allow' | 'auto_deny' | 'require_approval';

export interface PermissionRule {
  toolId?: string;
  toolNamePattern?: RegExp;
  riskLevel?: ToolRiskLevel;
  policy: PermissionPolicy;
}

// ============ 常量 ============

const TIER_ORDER: Record<string, number> = {
  basic: 0, standard: 1, advanced: 2, reasoning: 3,
};

const RISK_ORDER: Record<string, number> = {
  safe: 0, moderate: 1, dangerous: 2,
};

// P1-1 修复：command_execute 不存在，实际命令执行工具为 shell_execute
const CORE_TOOL_IDS = new Set(['file_read', 'shell_execute']);

const DEFAULT_EXECUTION_TIMEOUT = 30_000;

// Phase G1: 按工具类别(category)的默认超时 — 介于 per-name 覆盖和全局默认之间
// 目的：让快速工具（read/memory/task）更快失败，让网络/UI 工具有足够时间
// 解析优先级：调用方显式传入 > per-name 覆盖 > per-category 默认 > 全局 30s
const CATEGORY_DEFAULT_TIMEOUTS: Record<string, number> = {
  // 本地快速 I/O — 5-10s 足够（失败应快速暴露，不要拖到 30s）
  memory: 5_000,         // 本地倒排索引检索，正常 <100ms
  task: 5_000,            // plan/task 管理是纯逻辑操作
  file: 10_000,           // 本地文件读写，正常 <1s（大文件除外，但 10s 已够 100MB）
  nlu: 10_000,            // NLU 解析（本地），不应阻塞
  // 中等耗时 — 15-30s
  system: 15_000,         // 系统状态读取，含进程/注册表查询
  skill: 15_000,          // 技能操作可能涉及 I/O
  data: 30_000,           // 数据处理，方差大
  code: 30_000,           // 代码执行可能含编译
  // 网络/UI 类 — 60s（网络延迟 + UI 自动化）
  web: 60_000,             // 浏览器/HTTP 请求，受网络延迟影响
  desktop: 60_000,         // 屏幕截图/点击/键盘，UI 自动化有等待时间
  communication: 60_000,   // 微信/邮件/飞书，含应用启动
  // 长耗时创作类 — 120s（多数会被 per-name 覆盖到更长）
  creative: 120_000,
  // 兜底
  other: 30_000,
};

// 长耗时工具超时覆盖：默认 30s 对视频生成/模型训练/长任务太短，按工具名(name)单独配置
// key 为工具 name（UnifiedToolDef.name），value 为毫秒
const LONG_RUNNING_TOOL_TIMEOUTS: Record<string, number> = {
  // 视频生成/渲染：通常需要 1-5 分钟
  libtv_generate_video: 5 * 60_000,        // 5 分钟
  generate_video: 5 * 60_000,
  video_generate: 5 * 60_000,
  // 故事板/分镜生成：涉及多次 LLM 调用
  libtv_create_storyboard: 3 * 60_000,     // 3 分钟
  create_storyboard: 3 * 60_000,
  // 图片生成：30s-2min
  generate_image: 2 * 60_000,
  image_generate: 2 * 60_000,
  // 代码/项目生成
  create_mini_app: 3 * 60_000,
  // 桌面自动化长流程（workflow 含内部 launchApp+activate+多步 SendKeys，launchApp 单次可达 24s）
  app_operate: 120_000,
  app_batch: 150_000,
  // 依赖安装
  tool_install: 3 * 60_000,
};

const CIRCUIT_FAILURE_THRESHOLD = 3;
const CIRCUIT_COOLDOWN_MS = 5 * 60 * 1000;
const MEMORY_WARN_BYTES = 100 * 1024 * 1024;
const SELECTION_CACHE_TTL = 60_000;
const DEBOUNCE_SAVE_MS = 5_000;
const MAX_SELECTION_CACHE_SIZE = 50;

const REGISTRY_DIR = '.duan/registry';
const TOOLS_FILE = 'tools.json';
const METRICS_FILE = 'metrics.json';

// ============ 主类 ============

/** 沙箱执行器接口 — 用于隔离执行不信任的代码 */
export interface SandboxExecutor {
  executeInSandbox(code: string, timeout?: number): Promise<{ success: boolean; output: string; error?: string }>;
  executeShell(command: string, cwd: string, timeout?: number): { success: boolean; output: string; error?: string };
}

export class ScalableToolRegistry {
  private tools: Map<string, ScalableToolDef> = new Map();
  private categoryIndex: Map<ToolCategory, Set<string>> = new Map();
  private tagIndex: Map<string, Set<string>> = new Map();
  private circuitStates: Map<string, CircuitState> = new Map();
  private selectionCache: Map<string, CachedSelection> = new Map();

  // 审批与权限
  private approvalCallback: ApprovalCallback | null = null;
  private permissionRules: PermissionRule[] = [];
  private autoApproveSafe: boolean = true;
  private trustedCommands: Set<string> = new Set([
    'npm run', 'npm test', 'npm start', 'npm build',
    'git status', 'git diff', 'git log', 'git branch',
    'ls', 'dir', 'cat', 'pwd', 'echo', 'node --version', 'npm --version',
    'tsc --noEmit', 'npx tsc --noEmit',
  ]);

  // 沙箱执行器（可选注入）
  private sandboxExecutor: SandboxExecutor | null = null;

  private eventBus: EventBus;
  private log = logger.child({ module: 'ScalableToolRegistry' });

  private saveTimer: ReturnType<typeof setTimeout> | null = null;
  private metricsTimer: ReturnType<typeof setTimeout> | null = null;
  private registryDir: string;

  constructor(baseDir?: string) {
    this.eventBus = EventBus.getInstance();
    this.registryDir = path.join(baseDir || process.cwd(), REGISTRY_DIR);

    // 初始化分类索引
    const categories: ToolCategory[] = [
      'desktop', 'file', 'code', 'web', 'system',
      'communication', 'creative', 'data', 'nlu',
      'memory', 'task', 'skill', 'other',
    ];
    for (const cat of categories) {
      this.categoryIndex.set(cat, new Set());
    }
  }

  // ============ 注册 / 注销 ============

  register(
    tool: Omit<
      ScalableToolDef,
      'initialized' | 'initError' | 'lastUsed' | 'usageCount' | 'avgExecutionTime' | 'successRate'
    >,
  ): void {
    if (this.tools.has(tool.id)) {
      this.log.warn('工具已存在，跳过注册', { toolId: tool.id });
      return;
    }

    const full: ScalableToolDef = {
      ...tool,
      initialized: false,
      initError: undefined,
      lastUsed: undefined,
      usageCount: 0,
      avgExecutionTime: 0,
      successRate: 1,
    };

    this.tools.set(tool.id, full);

    // 更新分类索引
    this.categoryIndex.get(tool.category)?.add(tool.id);

    // 更新标签倒排索引
    if (tool.tags) {
      for (const tag of tool.tags) {
        let set = this.tagIndex.get(tag);
        if (!set) {
          set = new Set();
          this.tagIndex.set(tag, set);
        }
        set.add(tool.id);
      }
    }

    this.invalidateSelectionCache();

    this.eventBus.emitSync(Events.TOOL_REGISTERED, {
      toolId: tool.id,
      name: tool.name,
      category: tool.category,
    }, { source: 'scalable-tool-registry' });

    this.debouncedSaveState();
  }

  unregister(toolId: string): void {
    const tool = this.tools.get(toolId);
    if (!tool) return;

    // 清除分类索引
    this.categoryIndex.get(tool.category)?.delete(toolId);

    // 清除标签索引
    if (tool.tags) {
      for (const tag of tool.tags) {
        const set = this.tagIndex.get(tag);
        if (set) {
          set.delete(toolId);
          if (set.size === 0) this.tagIndex.delete(tag);
        }
      }
    }

    this.tools.delete(toolId);
    this.circuitStates.delete(toolId);
    this.invalidateSelectionCache();

    this.eventBus.emitSync(Events.TOOL_UNREGISTERED, {
      toolId,
    }, { source: 'scalable-tool-registry' });

    this.debouncedSaveState();
  }

  // ============ 获取 / 执行 ============

  async getTool(toolId: string): Promise<ScalableToolDef | null> {
    const tool = this.tools.get(toolId);
    if (!tool) return null;

    // 熔断检查
    if (this.isCircuitOpen(toolId)) {
      this.log.warn('工具因熔断被禁用', { toolId });
      return null;
    }

    if (!tool.initialized && tool.init) {
      try {
        await tool.init();
        tool.initialized = true;
        tool.initError = undefined;
      } catch (err: unknown) {
        const msg = err instanceof Error ? err.message : String(err);
        tool.initError = msg;
        this.log.error('工具初始化失败', { toolId, error: msg });
      }
    }

    return tool;
  }

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  async executeTool(toolId: string, args: any, timeoutMs?: number): Promise<string> {
    const tool = await this.getTool(toolId);
    if (!tool) return `错误: 工具 ${toolId} 未找到或已被熔断禁用`;
    if (tool.initError) return `错误: 工具初始化失败: ${tool.initError}`;
    if (!tool.enabled) return `错误: 工具 ${toolId} 已被禁用`;

    // 检查依赖
    if (tool.dependencies) {
      for (const depId of tool.dependencies) {
        const dep = this.tools.get(depId);
        if (!dep || !dep.initialized || dep.initError) {
          return `错误: 依赖工具 ${depId} 未就绪`;
        }
      }
    }

    this.eventBus.emitSync(Events.TOOL_CALL_START, {
      toolId: tool.id,
      toolName: tool.name,
      args,
    }, { source: 'scalable-tool-registry' });

    const startTime = Date.now();
    const memBefore = process.memoryUsage().heapUsed;

    // 超时解析优先级（Phase G1 新增 per-category 层）：
    //   调用方显式传入 > per-name 长耗时覆盖 > per-category 默认 > 全局 30s
    // per-category 通过 tool.category 字段获取；若未设置则用 inferCategory(tool.name) 推断
    const toolCategory = tool.category ?? inferCategory(tool.name);
    const effectiveTimeout = timeoutMs
      ?? LONG_RUNNING_TOOL_TIMEOUTS[tool.name]
      ?? CATEGORY_DEFAULT_TIMEOUTS[toolCategory]
      ?? DEFAULT_EXECUTION_TIMEOUT;

    try {
      // 沙箱路由：当工具的 sandbox 模式为 'vm' 且有沙箱执行器时，走沙箱
      const useSandbox = tool.sandbox === 'vm' && this.sandboxExecutor !== null;
      let result: string;
      if (useSandbox && tool.name === 'code_execute') {
        const sandboxResult = await this.sandboxExecutor!.executeInSandbox(
          String(args.code || ''),
          effectiveTimeout,
        );
        result = sandboxResult.success ? sandboxResult.output : `沙箱错误: ${sandboxResult.error}`;
      } else {
        result = await this.executeWithTimeout(
          tool.execute(args),
          effectiveTimeout,
          toolId,
        );
      }

      const duration = Date.now() - startTime;
      this.recordSuccess(toolId, duration);

      // 内存监控
      const memAfter = process.memoryUsage().heapUsed;
      const memDelta = memAfter - memBefore;
      if (memDelta > MEMORY_WARN_BYTES) {
        this.log.warn('工具执行内存使用过高', {
          toolId,
          memDeltaMB: Math.round(memDelta / 1024 / 1024),
        });
      }

      this.eventBus.emitSync(Events.TOOL_CALL_COMPLETE, {
        toolId: tool.id,
        toolName: tool.name,
        success: true,
        duration,
      }, { source: 'scalable-tool-registry' });

      return result;
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      const duration = Date.now() - startTime;
      this.recordFailure(toolId);

      this.eventBus.emitSync(Events.TOOL_CALL_ERROR, {
        toolId: tool.id,
        toolName: tool.name,
        error: msg,
        duration,
      }, { source: 'scalable-tool-registry' });

      return `执行错误: ${msg}`;
    }
  }

  // ============ 智能工具选择 ============

  selectToolsForContext(context: ToolSelectionContext): ToolSelectionResult {
    const cacheKey = this.hashContext(context);
    const cached = this.selectionCache.get(cacheKey);
    if (cached && cached.expiresAt > Date.now()) {
      return cached.result;
    }

    const maxTools = context.maxTools ?? 30;
    let candidates = Array.from(this.tools.values());

    // 1. 仅保留启用的工具
    const totalAvailable = candidates.length;
    candidates = candidates.filter(t => t.enabled);

    // 2. 熔断禁用的排除
    candidates = candidates.filter(t => !this.isCircuitOpen(t.id));

    // 3. 初始化失败排除
    candidates = candidates.filter(t => !t.initError);

    // 4. 模型能力过滤
    if (context.modelTier) {
      const modelTierLevel = TIER_ORDER[context.modelTier] ?? 1;
      candidates = candidates.filter(t => {
        if (!t.minModelTier) return true;
        return (TIER_ORDER[t.minModelTier] ?? 0) <= modelTierLevel;
      });
    }

    // 5. 风险等级过滤
    if (context.maxRiskLevel) {
      const maxRisk = RISK_ORDER[context.maxRiskLevel] ?? 2;
      candidates = candidates.filter(t => {
        if (!t.riskLevel) return true;
        return (RISK_ORDER[t.riskLevel] ?? 0) <= maxRisk;
      });
    }

    // 6. 分类过滤
    if (context.includeCategories?.length) {
      candidates = candidates.filter(t => context.includeCategories!.includes(t.category));
    }
    if (context.excludeCategories?.length) {
      candidates = candidates.filter(t => !context.excludeCategories!.includes(t.category));
    }

    // 7. 只读过滤
    if (context.onlyReadOnly) {
      candidates = candidates.filter(t => t.readOnly);
    }

    const filtered = candidates.length;

    // 8. 评分
    const now = Date.now();
    const scored = candidates.map(t => {
      let score = 0;

      // 意图相关性
      if (context.intent && this.isIntentRelevant(context.intent, t)) {
        score += 3;
      }

      // 领域匹配
      if (context.domain && this.isDomainMatch(context.domain, t)) {
        score += 2;
      }

      // 近期使用（5 分钟内）
      if (context.recentToolIds?.includes(t.id)) {
        score += 2;
      } else if (t.lastUsed && now - t.lastUsed < 5 * 60 * 1000) {
        score += 2;
      }

      // 历史成功率
      if (t.successRate > 0.8) {
        score += 1;
      }

      // 优先级
      score += t.priority / 2;

      return { tool: t, score };
    });

    // 9. 排序
    scored.sort((a, b) => b.score - a.score);

    // 10. 取 top N，但始终包含核心工具
    const selectedIds = new Set<string>();
    const result: ScalableToolDef[] = [];

    // 先加入核心工具
    for (const coreId of Array.from(CORE_TOOL_IDS)) {
      const coreTool = candidates.find(t => t.id === coreId);
      if (coreTool) {
        selectedIds.add(coreId);
        result.push(coreTool);
      }
    }

    // 再按分数加入
    for (const { tool } of scored) {
      if (result.length >= maxTools) break;
      if (!selectedIds.has(tool.id)) {
        selectedIds.add(tool.id);
        result.push(tool);
      }
    }

    const selectionResult: ToolSelectionResult = {
      tools: result,
      selectionReason: `从 ${totalAvailable} 个工具中筛选出 ${result.length} 个（过滤后 ${filtered} 个候选）`,
      totalAvailable,
      filtered,
    };

    // 缓存
    this.selectionCache.set(cacheKey, {
      result: selectionResult,
      expiresAt: Date.now() + SELECTION_CACHE_TTL,
    });
    if (this.selectionCache.size > MAX_SELECTION_CACHE_SIZE) {
      const oldest = this.selectionCache.keys().next().value;
      if (oldest) this.selectionCache.delete(oldest);
    }

    return selectionResult;
  }

  // ============ 搜索 / 查询 ============

  searchTools(query: string): ScalableToolDef[] {
    const q = query.toLowerCase();
    const results: Array<{ tool: ScalableToolDef; score: number }> = [];

    for (const tool of Array.from(this.tools.values())) {
      if (!tool.enabled) continue;

      let score = 0;

      // ID 匹配
      if (tool.id.toLowerCase().includes(q)) score += 3;
      // 名称匹配
      if (tool.name.toLowerCase().includes(q)) score += 3;
      // 描述匹配
      if (tool.description.toLowerCase().includes(q)) score += 2;
      // 标签匹配
      if (tool.tags?.some(tag => tag.toLowerCase().includes(q))) score += 2;
      // 分类匹配
      if (tool.category.toLowerCase().includes(q)) score += 1;

      if (score > 0) {
        results.push({ tool, score });
      }
    }

    results.sort((a, b) => b.score - a.score);
    return results.map(r => r.tool);
  }

  getToolsByCategory(category: ToolCategory): ScalableToolDef[] {
    const ids = this.categoryIndex.get(category);
    if (!ids) return [];
    const result: ScalableToolDef[] = [];
    for (const id of Array.from(ids)) {
      const tool = this.tools.get(id);
      if (tool && tool.enabled) result.push(tool);
    }
    return result;
  }

  toggleTool(toolId: string, enabled: boolean): boolean {
    const tool = this.tools.get(toolId);
    if (!tool) return false;
    tool.enabled = enabled;
    this.invalidateSelectionCache();
    this.debouncedSaveState();
    this.log.info('工具状态切换', { toolId, enabled });
    return true;
  }

  // ============ 统计 ============

  getToolStats(): {
    total: number;
    enabled: number;
    initialized: number;
    errored: number;
    circuitOpen: number;
    byCategory: Record<string, number>;
    topUsed: Array<{ id: string; name: string; usageCount: number }>;
    avgExecutionTimes: Array<{ id: string; name: string; avgMs: number }>;
  } {
    let enabled = 0;
    let initialized = 0;
    let errored = 0;
    let circuitOpen = 0;
    const byCategory: Record<string, number> = {};

    for (const tool of Array.from(this.tools.values())) {
      if (tool.enabled) enabled++;
      if (tool.initialized) initialized++;
      if (tool.initError) errored++;
      if (this.isCircuitOpen(tool.id)) circuitOpen++;
      byCategory[tool.category] = (byCategory[tool.category] || 0) + 1;
    }

    const all = Array.from(this.tools.values());
    const topUsed = all
      .sort((a, b) => b.usageCount - a.usageCount)
      .slice(0, 10)
      .map(t => ({ id: t.id, name: t.name, usageCount: t.usageCount }));

    const avgExecutionTimes = all
      .filter(t => t.usageCount > 0)
      .sort((a, b) => b.avgExecutionTime - a.avgExecutionTime)
      .slice(0, 10)
      .map(t => ({ id: t.id, name: t.name, avgMs: Math.round(t.avgExecutionTime) }));

    return {
      total: this.tools.size,
      enabled,
      initialized,
      errored,
      circuitOpen,
      byCategory,
      topUsed,
      avgExecutionTimes,
    };
  }

  // ============ 模型优化 ============

  optimizeForModel(modelName: string, tokenBudget: number): ToolSelectionResult {
    // 估算每个工具描述大约占用的 token 数
    const ESTIMATED_TOKENS_PER_TOOL = 150;

    const maxTools = Math.min(
      Math.floor(tokenBudget / ESTIMATED_TOKENS_PER_TOOL),
      60,
    );

    return this.selectToolsForContext({
      modelTier: this.inferModelTier(modelName),
      maxTools: Math.max(maxTools, 10),
    });
  }

  // ============ 批量初始化 ============

  async batchInit(concurrency: number = 5): Promise<{ succeeded: number; failed: number }> {
    const uninitialized = Array.from(this.tools.values())
      .filter(t => !t.initialized && t.init && t.enabled);

    let succeeded = 0;
    let failed = 0;

    // 并发控制
    const batches: ScalableToolDef[][] = [];
    for (let i = 0; i < uninitialized.length; i += concurrency) {
      batches.push(uninitialized.slice(i, i + concurrency));
    }

    for (const batch of batches) {
      const results = await Promise.allSettled(
        batch.map(async (tool) => {
          await tool.init!();
          tool.initialized = true;
          tool.initError = undefined;
        }),
      );

      for (let i = 0; i < results.length; i++) {
        if (results[i].status === 'fulfilled') {
          succeeded++;
        } else {
          const tool = batch[i];
          const err = (results[i] as PromiseRejectedResult).reason;
          tool.initError = err instanceof Error ? err.message : String(err);
          failed++;
          this.log.error('批量初始化失败', { toolId: tool.id, error: tool.initError });
        }
      }
    }

    // 优雅降级：如果失败率 > 50%，记录警告
    if (uninitialized.length > 0 && failed / uninitialized.length > 0.5) {
      this.log.warn('工具初始化失败率过高，建议检查核心工具', {
        failed,
        total: uninitialized.length,
      });
    }

    this.log.info('批量初始化完成', { succeeded, failed });
    return { succeeded, failed };
  }

  // ============ 持久化 ============

  async loadState(): Promise<void> {
    try {
      const toolsPath = path.join(this.registryDir, TOOLS_FILE);
      if (await this.pathExists(toolsPath)) {
        const raw = await fs.promises.readFile(toolsPath, 'utf-8');
        const states: Record<string, PersistedToolState> = JSON.parse(raw);
        for (const [id, state] of Object.entries(states)) {
          const tool = this.tools.get(id);
          if (tool) {
            tool.enabled = state.enabled;
            tool.usageCount = state.usageCount;
            tool.avgExecutionTime = state.avgExecutionTime;
            tool.successRate = state.successRate;
            tool.lastUsed = state.lastUsed;
          }
        }
        this.log.info('工具状态已加载', { count: Object.keys(states).length });
      }

      const metricsPath = path.join(this.registryDir, METRICS_FILE);
      if (await this.pathExists(metricsPath)) {
        const raw = await fs.promises.readFile(metricsPath, 'utf-8');
        const metrics: Record<string, PersistedToolState> = JSON.parse(raw);
        for (const [id, m] of Object.entries(metrics)) {
          const tool = this.tools.get(id);
          if (tool) {
            tool.usageCount = m.usageCount;
            tool.avgExecutionTime = m.avgExecutionTime;
            tool.successRate = m.successRate;
            tool.lastUsed = m.lastUsed;
          }
        }
      }
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      this.log.warn('加载工具状态失败', { error: msg });
    }
  }

  async saveState(): Promise<void> {
    try {
      await fs.promises.mkdir(this.registryDir, { recursive: true });

      const states: Record<string, PersistedToolState> = {};
      const metrics: Record<string, PersistedToolState> = {};

      for (const [id, tool] of Array.from(this.tools)) {
        states[id] = {
          enabled: tool.enabled,
          usageCount: tool.usageCount,
          avgExecutionTime: tool.avgExecutionTime,
          successRate: tool.successRate,
          lastUsed: tool.lastUsed,
        };
        metrics[id] = {
          enabled: tool.enabled,
          usageCount: tool.usageCount,
          avgExecutionTime: tool.avgExecutionTime,
          successRate: tool.successRate,
          lastUsed: tool.lastUsed,
        };
      }

      await atomicWriteJson(
        path.join(this.registryDir, TOOLS_FILE),
        states
      );
      await atomicWriteJson(
        path.join(this.registryDir, METRICS_FILE),
        metrics
      );
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      this.log.error('保存工具状态失败', { error: msg });
    }
  }

  // ============ 内部方法 ============

  private async pathExists(p: string): Promise<boolean> {
    try {
      await fs.promises.access(p);
      return true;
    } catch {
      return false;
    }
  }

  private executeWithTimeout(
    promise: Promise<string>,
    timeoutMs: number,
    toolId: string,
  ): Promise<string> {
    return new Promise<string>((resolve, reject) => {
      const timer = setTimeout(() => {
        reject(new Error(`工具 ${toolId} 执行超时 (${timeoutMs}ms)`));
      }, timeoutMs);
      promise.then(
        (val) => { clearTimeout(timer); resolve(val); },
        (err) => { clearTimeout(timer); reject(err); },
      );
    });
  }

  private recordSuccess(toolId: string, durationMs: number): void {
    const tool = this.tools.get(toolId);
    if (!tool) return;

    tool.lastUsed = Date.now();
    tool.usageCount++;

    // 移动平均
    tool.avgExecutionTime =
      tool.usageCount === 1
        ? durationMs
        : (tool.avgExecutionTime * (tool.usageCount - 1) + durationMs) / tool.usageCount;

    // 成功率：简单移动平均
    tool.successRate = tool.successRate * 0.9 + 1 * 0.1;

    // 重置熔断计数
    const circuit = this.circuitStates.get(toolId);
    if (circuit) {
      circuit.consecutiveFailures = 0;
    }

    this.debouncedSaveMetrics();
  }

  private recordFailure(toolId: string): void {
    const tool = this.tools.get(toolId);
    if (!tool) return;

    tool.usageCount++;
    tool.successRate = tool.successRate * 0.9 + 0 * 0.1;

    // 熔断计数
    let circuit = this.circuitStates.get(toolId);
    if (!circuit) {
      circuit = { consecutiveFailures: 0, disabledUntil: 0 };
      this.circuitStates.set(toolId, circuit);
    }
    circuit.consecutiveFailures++;

    if (circuit.consecutiveFailures >= CIRCUIT_FAILURE_THRESHOLD) {
      circuit.disabledUntil = Date.now() + CIRCUIT_COOLDOWN_MS;
      this.log.warn('工具因连续失败被熔断禁用', {
        toolId,
        failures: circuit.consecutiveFailures,
        cooldownMs: CIRCUIT_COOLDOWN_MS,
      });
    }

    this.debouncedSaveMetrics();
  }

  private isCircuitOpen(toolId: string): boolean {
    const circuit = this.circuitStates.get(toolId);
    if (!circuit) return false;
    if (circuit.disabledUntil <= Date.now()) {
      // 冷却期已过，半开
      circuit.consecutiveFailures = 0;
      circuit.disabledUntil = 0;
      return false;
    }
    return true;
  }

  private isIntentRelevant(intent: string, tool: ScalableToolDef): boolean {
    const lower = intent.toLowerCase();
    // 基于工具分类和标签的简单启发式匹配
    const intentCategoryMap: Record<string, ToolCategory[]> = {
      code: ['code', 'file'],
      edit: ['code', 'file'],
      write: ['code', 'file', 'creative'],
      read: ['file', 'code'],
      search: ['web', 'file', 'code'],
      browse: ['web'],
      internet: ['web'],
      file: ['file'],
      desktop: ['desktop'],
      communicate: ['communication'],
      message: ['communication'],
      create: ['creative', 'code'],
      generate: ['creative', 'code'],
      data: ['data'],
      analyze: ['data', 'code'],
      remember: ['memory'],
      memory: ['memory'],
      task: ['task'],
      plan: ['task'],
      skill: ['skill'],
    };

    for (const [keyword, categories] of Object.entries(intentCategoryMap)) {
      if (lower.includes(keyword) && categories.includes(tool.category)) {
        return true;
      }
    }

    // 标签匹配
    if (tool.tags?.some(tag => lower.includes(tag.toLowerCase()))) {
      return true;
    }

    return false;
  }

  private isDomainMatch(domain: string, tool: ScalableToolDef): boolean {
    const lower = domain.toLowerCase();
    if (tool.category === lower) return true;
    if (tool.tags?.some(tag => tag.toLowerCase() === lower)) return true;
    return false;
  }

  private inferModelTier(modelName: string): string {
    const lower = modelName.toLowerCase();
    if (lower.includes('reason') || lower.includes('opus') || lower.includes('o3')) return 'reasoning';
    if (lower.includes('4o') || lower.includes('sonnet') || lower.includes('deepseek-chat') || lower.includes('gpt-4')) return 'advanced';
    if (lower.includes('3.5') || lower.includes('haiku') || lower.includes('mini')) return 'basic';
    return 'standard';
  }

  private hashContext(context: ToolSelectionContext): string {
    const parts = [
      context.intent ?? '',
      context.domain ?? '',
      context.modelTier ?? '',
      String(context.maxTools ?? ''),
      (context.includeCategories ?? []).join(','),
      (context.excludeCategories ?? []).join(','),
      String(context.onlyReadOnly ?? ''),
      context.maxRiskLevel ?? '',
      (context.recentToolIds ?? []).join(','),
    ];
    return parts.join('|');
  }

  private invalidateSelectionCache(): void {
    this.selectionCache.clear();
  }

  private debouncedSaveState(): void {
    if (this.saveTimer) clearTimeout(this.saveTimer);
    this.saveTimer = setTimeout(() => {
      this.saveState().catch(err => {
        this.log.error('防抖保存状态失败', { error: errMsg(err) });
      });
    }, DEBOUNCE_SAVE_MS);
    if (typeof this.saveTimer.unref === 'function') this.saveTimer.unref();
  }

  private debouncedSaveMetrics(): void {
    if (this.metricsTimer) clearTimeout(this.metricsTimer);
    this.metricsTimer = setTimeout(() => {
      this.saveState().catch(err => {
        this.log.error('防抖保存指标失败', { error: errMsg(err) });
      });
    }, DEBOUNCE_SAVE_MS);
    if (typeof this.metricsTimer.unref === 'function') this.metricsTimer.unref();
  }

  /** 销毁时清理 */
  dispose(): void {
    if (this.saveTimer) clearTimeout(this.saveTimer);
    if (this.metricsTimer) clearTimeout(this.metricsTimer);
    this.saveState().catch(() => {});
  }

  // ============ 审批与权限管理 ============

  /** 设置审批回调 */
  setApprovalCallback(callback: ApprovalCallback | null): void {
    this.approvalCallback = callback;
  }

  /** 设置是否自动放行 safe 工具 */
  setAutoApproveSafe(auto: boolean): void {
    this.autoApproveSafe = auto;
  }

  /** 添加权限规则 */
  addPermissionRule(rule: PermissionRule): void {
    this.permissionRules.push(rule);
  }

  /** 添加信任命令 */
  addTrustedCommand(command: string): void {
    this.trustedCommands.add(command);
  }

  /** 注入沙箱执行器 */
  setSandboxExecutor(executor: SandboxExecutor | null): void {
    this.sandboxExecutor = executor;
  }

  /** 检查工具是否需要审批 */
  async checkApproval(
    toolId: string,
    toolArgs: Record<string, unknown>,
  ): Promise<ApprovalResult> {
    const tool = this.tools.get(toolId);
    if (!tool) return { approved: false, reason: `工具 ${toolId} 不存在` };

    const riskLevel = tool.riskLevel || 'moderate';

    // 1. 自动放行 safe 和 moderate 工具
    if (this.autoApproveSafe && (riskLevel === 'safe' || riskLevel === 'moderate')) {
      return { approved: true, reason: `${riskLevel} 工具自动放行` };
    }

    // 2. 检查信任命令（仅 shell_execute 等命令类工具）
    if (toolId === 'shell_execute' || tool.name === 'shell_execute') {
      const cmd = String(toolArgs.command || '');
      // 安全修复：之前用 cmd.startsWith(tc) 允许 "npm run && rm -rf /" 自动放行
      // 现在要求精确匹配或空格分隔的前缀匹配（不允许 shell 元字符后跟额外命令）
      if (this.trustedCommands.has(cmd)) {
        return { approved: true, reason: '信任命令精确匹配自动放行' };
      }
      // 前缀匹配：仅当命令以信任前缀开头且后续部分不含 shell 元字符时放行
      const shellMetacharacters = /[;&|`$(){}!><\n\r]/;
      const matchingPrefix = [...this.trustedCommands].find(tc =>
        cmd.startsWith(tc) && (cmd.length === tc.length || cmd[tc.length] === ' ')
      );
      if (matchingPrefix && !shellMetacharacters.test(cmd)) {
        return { approved: true, reason: '信任命令前缀匹配自动放行' };
      }
    }

    // 3. 检查权限规则
    for (const rule of this.permissionRules) {
      if (rule.toolId && rule.toolId !== toolId) continue;
      if (rule.toolNamePattern && !rule.toolNamePattern.test(tool.name)) continue;
      if (rule.riskLevel && rule.riskLevel !== riskLevel) continue;

      switch (rule.policy) {
        case 'auto_allow':
          return { approved: true, reason: '权限规则自动放行' };
        case 'auto_deny':
          return { approved: false, reason: '权限规则自动拒绝' };
        case 'require_approval':
          break; // 继续到审批回调
      }
    }

    // 4. 无审批回调时的默认策略
    if (!this.approvalCallback) {
      if (riskLevel === 'dangerous') {
        return { approved: false, reason: '危险工具无审批回调，默认拒绝' };
      }
      return { approved: true, reason: '中等风险工具无审批回调，默认放行' };
    }

    // 5. 调用审批回调
    try {
      const request: ApprovalRequest = {
        toolId,
        toolName: tool.name,
        toolArgs,
        riskLevel,
        reason: `${riskLevel} 风险工具需要审批`,
        timestamp: Date.now(),
      };
      const result = await this.approvalCallback(request);
      return result;
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      return { approved: false, reason: `审批回调失败: ${msg}` };
    }
  }

  /** 带审批的工具执行 */
  async executeWithApproval(
    toolId: string,
    args: Record<string, unknown>,
    timeoutMs?: number,
  ): Promise<string> {
    // 审批检查
    const approval = await this.checkApproval(toolId, args);
    if (!approval.approved) {
      return `⛔ 操作被拒绝: ${approval.reason || '需要用户审批'}`;
    }

    // 如果审批修改了参数，使用修改后的参数
    const finalArgs = approval.modifiedArgs || args;

    return this.executeTool(toolId, finalArgs, timeoutMs);
  }

  /** 获取所有工具的 OpenAI function calling 格式（带智能选择） */
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  getOpenAITools(userMessage?: string, maxTools: number = 30): Array<any> {
    let toolsToExport: ScalableToolDef[];

    if (userMessage && this.tools.size > maxTools) {
      const selection = this.selectToolsForContext({
        intent: userMessage,
        maxTools,
      });
      toolsToExport = selection.tools;
    } else {
      toolsToExport = Array.from(this.tools.values()).filter(t => t.enabled);
    }

    return toolsToExport.map(tool => ({
      type: 'function' as const,
      function: {
        name: tool.name,
        description: tool.description,
        parameters: {
          type: 'object',
          properties: Object.fromEntries(
            Object.entries(tool.parameters).map(([key, val]) => [
              key,
              { type: val.type, description: val.description },
            ]),
          ),
          required: Object.entries(tool.parameters)
            .filter(([, val]) => val.required)
            .map(([key]) => key),
        },
      },
    }));
  }

  /** 获取所有工具定义（兼容旧版 ToolDef 格式） */
  getAllDefinitions(): Array<{
    name: string;
    description: string;
    parameters: Record<string, { type: string; description: string; required?: boolean }>;
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    execute: (args: any) => Promise<string>;
    readOnly?: boolean;
  }> {
    return Array.from(this.tools.values())
      .filter(t => t.enabled)
      .map(t => ({
        name: t.name,
        description: t.description,
        parameters: t.parameters,
        execute: t.execute,
        readOnly: t.readOnly,
      }));
  }
}
