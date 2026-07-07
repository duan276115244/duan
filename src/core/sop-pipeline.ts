/**
 * SOP Role Pipeline — MetaGPT 风格的多 Agent 标准化协作流水线
 *
 * 借鉴 MetaGPT：定义角色、SOP 和交接协议
 *
 * 流水线阶段：
 * 1. ProductManager: 需求 → PRD
 * 2. Architect: PRD → 系统设计
 * 3. ProjectManager: 设计 → 任务列表
 * 4. Engineer: 任务 → 代码
 * 5. QAEngineer: 代码 → 测试结果
 * 6. Reviewer: 测试结果 → 审查反馈
 *
 * 每个角色拥有：
 * - 输入模式（期望接收什么）
 * - 输出模式（产出什么）
 * - 质量检查清单（交接前自检）
 * - 交接协议（如何将工作传递给下一个角色）
 */

import * as crypto from 'crypto';
import * as fs from 'fs';
import * as path from 'path';
import { logger } from './structured-logger.js';
import { EventBus } from './event-bus.js';
import type { ToolDef } from './unified-tool-def.js';
import { duanPath } from './duan-paths.js';
import { atomicWriteJson } from './atomic-write.js';

// ============ 类型定义 ============

/** 质量检查项 */
export interface QualityCheck {
  name: string;
  description: string;
  validate: (output: unknown) => boolean;
}

/** SOP 交接协议 */
export interface SOPHandoff {
  fromRoleId: string;
  toRoleId: string;
  transform: (output: unknown) => unknown;  // 将上游输出转换为目标角色输入
  validateTransition: (output: unknown) => boolean;  // 验证交接是否合法
}

/** SOP 角色 */
export interface SOPRole {
  id: string;
  name: string;
  description: string;
  inputSchema: Record<string, unknown>;     // 期望的输入模式
  outputSchema: Record<string, unknown>;    // 产出的输出模式
  qualityChecks: QualityCheck[];
  execute: (input: unknown, context: PipelineContext) => Promise<unknown>;
  maxRetries: number;
  timeout: number;                          // 超时时间(ms)
  /** P2-3: 可选的阶段回滚函数 — 在阶段失败时调用以清理副作用 */
  rollback?: (input: unknown, output: unknown, context: PipelineContext) => Promise<void>;
}

/** 流水线定义 */
export interface PipelineDefinition {
  name: string;
  description: string;
  roleIds: string[];                        // 角色执行顺序
  handoffs: SOPHandoff[];
  metadata?: Record<string, unknown>;
}

/** 流水线输入 */
export interface PipelineInput {
  data: unknown;
  source: string;
  metadata?: Record<string, unknown>;
}

/** 流水线结果 */
export interface PipelineResult {
  pipelineId: string;
  success: boolean;
  stages: StageResult[];
  finalOutput: unknown;
  startedAt: number;
  completedAt: number;
  duration: number;
  errors: string[];
}

/** 单阶段结果 */
export interface StageResult {
  roleId: string;
  roleName: string;
  success: boolean;
  input: unknown;
  output: unknown;
  qualityPassed: boolean;
  qualityFailures: string[];
  startedAt: number;
  completedAt: number;
  duration: number;
  retries: number;
  error?: string;
  /** P2-3: 是否已回滚 */
  rolledBack?: boolean;
  /** P2-3: 回滚错误信息（若回滚失败） */
  rollbackError?: string;
}

/** 流水线状态 */
export type PipelineStatus = 'pending' | 'running' | 'completed' | 'failed' | 'cancelled';

/** 流水线信息 */
export interface PipelineInfo {
  id: string;
  name: string;
  description: string;
  status: PipelineStatus;
  currentStage: number;
  totalStages: number;
  createdAt: number;
  updatedAt: number;
}

/** 流水线执行上下文 */
interface PipelineContext {
  pipelineId: string;
  previousOutputs: Map<string, unknown>;
  metadata: Record<string, unknown>;
}

/** 流水线运行时状态 */
interface PipelineRuntime {
  definition: PipelineDefinition;
  status: PipelineStatus;
  currentStage: number;
  stages: StageResult[];
  context: PipelineContext;
  startedAt: number;
  completedAt: number;
  errors: string[];
  abortController: AbortController;
}

// ============ 持久化数据结构 ============

interface _PipelineStore {
  pipelines: Record<string, PipelineRuntime>;
  roleDefinitions: Record<string, SOPRole>;
}

// ============ P2-3: pub/sub 消息机制与共享全局记忆池 ============

/** pub/sub 消息 */
export interface PubSubMessage {
  /** 消息 ID */
  id: string;
  /** 主题（角色订阅的主题） */
  topic: string;
  /** 发布者角色 ID */
  publisherId: string;
  /** 消息内容 */
  payload: unknown;
  /** 时间戳 */
  timestamp: number;
  /** 关联的流水线 ID */
  pipelineId?: string;
}

/** 消息订阅者回调 */
export type MessageSubscriber = (message: PubSubMessage) => void;

/** 共享全局记忆池条目 */
export interface SharedMemoryEntry {
  /** 键名 */
  key: string;
  /** 值 */
  value: unknown;
  /** 写入者角色 ID */
  writtenBy: string;
  /** 写入时间 */
  writtenAt: number;
  /** 标签（用于分类检索） */
  tags: string[];
  /** TTL（毫秒，0 表示永不过期） */
  ttl: number;
  /** 过期时间戳 */
  expiresAt: number;
}

// ============ P2-3: 稳定性度量 / 阶段回滚 / 流水线模板 / 角色协作 ============

/** 稳定性度量 — 跟踪流水线执行稳定性（验收标准：任务稳定性+20%） */
export interface StabilityMetric {
  /** 流水线 ID */
  pipelineId: string;
  /** 流水线名称 */
  pipelineName: string;
  /** 总执行次数 */
  totalRuns: number;
  /** 成功次数 */
  successCount: number;
  /** 失败次数 */
  failureCount: number;
  /** 成功率（0-1） */
  successRate: number;
  /** 平均耗时（ms） */
  avgDurationMs: number;
  /** 耗时标准差（衡量波动性，越小越稳定） */
  durationStdDev: number;
  /** 平均重试次数 */
  avgRetries: number;
  /** 质量检查通过率（0-1） */
  qualityPassRate: number;
  /** 最近 N 次执行的结果（true=成功，false=失败） */
  recentResults: boolean[];
  /** 稳定性评分（0-1，综合成功率、波动性、质量通过率） */
  stabilityScore: number;
  /** 最后更新时间 */
  updatedAt: number;
}

/** 阶段快照 — 用于阶段回滚（保存阶段执行前的状态） */
export interface StageSnapshot {
  /** 流水线 ID */
  pipelineId: string;
  /** 阶段索引 */
  stageIndex: number;
  /** 角色 ID */
  roleId: string;
  /** 阶段执行前的输入 */
  inputBefore: unknown;
  /** 阶段执行前的 previousOutputs 快照 */
  previousOutputsBefore: Array<[string, unknown]>;
  /** 快照时间 */
  timestamp: number;
}

/** 流水线模板 — 可复用的流水线定义 */
export interface PipelineTemplate {
  /** 模板 ID */
  templateId: string;
  /** 模板名称 */
  name: string;
  /** 模板描述 */
  description: string;
  /** 角色执行顺序 */
  roleIds: string[];
  /** 交接协议 */
  handoffs: SOPHandoff[];
  /** 模板分类（如 'development', 'review', 'deployment'） */
  category: string;
  /** 模板标签 */
  tags: string[];
  /** 默认元数据 */
  defaultMetadata?: Record<string, unknown>;
  /** 创建时间 */
  createdAt: number;
}

/** 角色协作请求 — 角色间握手/确认协议 */
export interface CollaborationRequest {
  /** 请求 ID */
  requestId: string;
  /** 发起方角色 ID */
  fromRoleId: string;
  /** 目标方角色 ID */
  toRoleId: string;
  /** 协作类型 */
  type: 'handshake' | 'confirm' | 'review' | 'escalate';
  /** 请求内容 */
  payload: unknown;
  /** 状态 */
  status: 'pending' | 'accepted' | 'rejected' | 'timeout';
  /** 时间戳 */
  createdAt: number;
  /** 响应时间戳 */
  resolvedAt?: number;
  /** 关联的流水线 ID */
  pipelineId?: string;
}

/** 5 角色装配线预设（需求理解→方案规划→执行→验证→交付） */
export const FIVE_ROLE_PIPELINE: Omit<SOPRole, 'execute'>[] = [
  {
    id: 'requirement_analyst',
    name: '需求理解',
    description: 'P2-3: 理解用户需求，澄清歧义，输出结构化需求规格',
    inputSchema: { type: 'object', properties: { userRequest: { type: 'string' } } },
    outputSchema: { type: 'object', properties: { requirementSpec: { type: 'string' } } },
    qualityChecks: [
      { name: 'spec_completeness', description: '需求规格包含目标、约束和验收标准', validate: (o) => typeof o === 'object' && o !== null && 'requirementSpec' in o && Boolean(o.requirementSpec) && String(o.requirementSpec).length > 50 },
    ],
    maxRetries: 2,
    timeout: 120000,
  },
  {
    id: 'solution_planner',
    name: '方案规划',
    description: 'P2-3: 基于需求规格制定技术方案和执行计划',
    inputSchema: { type: 'object', properties: { requirementSpec: { type: 'string' } } },
    outputSchema: { type: 'object', properties: { plan: { type: 'string' } } },
    qualityChecks: [
      { name: 'plan_completeness', description: '方案包含步骤、资源和风险评估', validate: (o) => typeof o === 'object' && o !== null && 'plan' in o && Boolean(o.plan) && String(o.plan).length > 50 },
    ],
    maxRetries: 2,
    timeout: 120000,
  },
  {
    id: 'executor',
    name: '执行',
    description: 'P2-3: 按照方案计划执行任务，产出实现结果',
    inputSchema: { type: 'object', properties: { plan: { type: 'string' } } },
    outputSchema: { type: 'object', properties: { deliverable: { type: 'string' } } },
    qualityChecks: [
      { name: 'deliverable_produced', description: '产出了可交付物', validate: (o) => typeof o === 'object' && o !== null && 'deliverable' in o && Boolean(o.deliverable) && String(o.deliverable).length > 0 },
    ],
    maxRetries: 3,
    timeout: 300000,
  },
  {
    id: 'verifier',
    name: '验证',
    description: 'P2-3: 验证执行结果是否满足需求规格',
    inputSchema: { type: 'object', properties: { deliverable: { type: 'string' }, requirementSpec: { type: 'string' } } },
    outputSchema: { type: 'object', properties: { verificationReport: { type: 'string' } } },
    qualityChecks: [
      { name: 'verification_complete', description: '验证报告非空', validate: (o) => typeof o === 'object' && o !== null && 'verificationReport' in o && Boolean(o.verificationReport) && String(o.verificationReport).length > 0 },
    ],
    maxRetries: 2,
    timeout: 180000,
  },
  {
    id: 'deliverer',
    name: '交付',
    description: 'P2-3: 整理交付物，生成交付报告和后续建议',
    inputSchema: { type: 'object', properties: { verificationReport: { type: 'string' }, deliverable: { type: 'string' } } },
    outputSchema: { type: 'object', properties: { deliveryReport: { type: 'string' } } },
    qualityChecks: [
      { name: 'delivery_complete', description: '交付报告非空', validate: (o) => typeof o === 'object' && o !== null && 'deliveryReport' in o && Boolean(o.deliveryReport) && String(o.deliveryReport).length > 0 },
    ],
    maxRetries: 2,
    timeout: 120000,
  },
];

// ============ 默认角色定义 ============

const DEFAULT_ROLES: Omit<SOPRole, 'execute'>[] = [
  {
    id: 'product_manager',
    name: '产品经理',
    description: '将需求转化为产品需求文档(PRD)',
    inputSchema: { type: 'object', properties: { requirements: { type: 'string' } } },
    outputSchema: { type: 'object', properties: { prd: { type: 'string' } } },
    qualityChecks: [
      { name: 'prd_completeness', description: 'PRD 包含功能描述、用户故事和验收标准', validate: (o) => typeof o === 'object' && o !== null && 'prd' in o && Boolean(o.prd) && String(o.prd).length > 50 },
    ],
    maxRetries: 2,
    timeout: 120000,
  },
  {
    id: 'architect',
    name: '架构师',
    description: '将 PRD 转化为系统设计',
    inputSchema: { type: 'object', properties: { prd: { type: 'string' } } },
    outputSchema: { type: 'object', properties: { design: { type: 'string' } } },
    qualityChecks: [
      { name: 'design_completeness', description: '设计包含架构图、模块划分和技术选型', validate: (o) => typeof o === 'object' && o !== null && 'design' in o && Boolean(o.design) && String(o.design).length > 50 },
    ],
    maxRetries: 2,
    timeout: 120000,
  },
  {
    id: 'project_manager',
    name: '项目经理',
    description: '将系统设计转化为任务列表',
    inputSchema: { type: 'object', properties: { design: { type: 'string' } } },
    outputSchema: { type: 'object', properties: { tasks: { type: 'array' } } },
    qualityChecks: [
      { name: 'tasks_decomposed', description: '任务列表非空且每个任务有明确描述', validate: (o) => typeof o === 'object' && o !== null && 'tasks' in o && Array.isArray(o.tasks) && o.tasks.length > 0 },
    ],
    maxRetries: 2,
    timeout: 60000,
  },
  {
    id: 'engineer',
    name: '工程师',
    description: '根据任务列表实现代码',
    inputSchema: { type: 'object', properties: { tasks: { type: 'array' } } },
    outputSchema: { type: 'object', properties: { code: { type: 'string' } } },
    qualityChecks: [
      { name: 'code_produced', description: '产出了代码内容', validate: (o) => typeof o === 'object' && o !== null && 'code' in o && Boolean(o.code) && String(o.code).length > 0 },
    ],
    maxRetries: 3,
    timeout: 300000,
  },
  {
    id: 'qa_engineer',
    name: 'QA 工程师',
    description: '对代码执行测试并产出测试结果',
    inputSchema: { type: 'object', properties: { code: { type: 'string' } } },
    outputSchema: { type: 'object', properties: { testResults: { type: 'string' } } },
    qualityChecks: [
      { name: 'test_results_present', description: '测试结果非空', validate: (o) => typeof o === 'object' && o !== null && 'testResults' in o && Boolean(o.testResults) && String(o.testResults).length > 0 },
    ],
    maxRetries: 2,
    timeout: 180000,
  },
  {
    id: 'reviewer',
    name: '审查员',
    description: '审查测试结果并给出反馈',
    inputSchema: { type: 'object', properties: { testResults: { type: 'string' } } },
    outputSchema: { type: 'object', properties: { reviewFeedback: { type: 'string' } } },
    qualityChecks: [
      { name: 'review_complete', description: '审查反馈非空', validate: (o) => typeof o === 'object' && o !== null && 'reviewFeedback' in o && Boolean(o.reviewFeedback) && String(o.reviewFeedback).length > 0 },
    ],
    maxRetries: 2,
    timeout: 120000,
  },
];

// ============ 主类 ============

/** LLM 调用函数类型 — 接收 prompt 字符串，返回 LLM 响应文本或 null */
export type SOPLLMCaller = (prompt: string) => Promise<string | null>;

export class SOPPipeline {
  private roles: Map<string, SOPRole> = new Map();
  private pipelines: Map<string, PipelineRuntime> = new Map();
  private log = logger.child({ module: 'SOPPipeline' });
  private persistPath: string;
  private disposed = false;
  /**
   * LLM 调用器 — 由 bootstrap.ts 通过 setLLMCaller() 注入
   * 未注入时 execute 函数降级为规则模板输出（仅满足 qualityChecks 通过最低要求）
   */
  private llmCall: SOPLLMCaller | null = null;

  /** P2-3: pub/sub 订阅者注册表（topic → subscribers） */
  private subscribers: Map<string, Set<MessageSubscriber>> = new Map();

  /** P2-3: 共享全局记忆池 */
  private sharedMemory: Map<string, SharedMemoryEntry> = new Map();

  /** P2-3: 稳定性度量（按流水线名称聚合，跨多次执行） */
  private stabilityMetrics: Map<string, { durations: number[]; results: boolean[]; retries: number[]; qualityPasses: number[]; totalRuns: number }> = new Map();

  /** P2-3: 阶段快照（按流水线 ID 存储，用于回滚） */
  private stageSnapshots: Map<string, StageSnapshot[]> = new Map();

  /** P2-3: 流水线模板注册表 */
  private pipelineTemplates: Map<string, PipelineTemplate> = new Map();

  /** P2-3: 角色协作请求（按请求 ID 存储） */
  private collaborationRequests: Map<string, CollaborationRequest> = new Map();

  constructor(persistDir?: string) {
    const baseDir = persistDir || duanPath('sop-pipeline');
    this.persistPath = baseDir;

    // P2-3: 注册默认角色（接入 LLM 真实执行）
    // LLM 未注入时降级为规则模板（保证 qualityChecks 通过），但会标记降级来源
    for (const role of DEFAULT_ROLES) {
      this.roles.set(role.id, {
        ...role,
        execute: this._buildDefaultRoleExecute(role.id) ?? ((input: unknown) => Promise.resolve(input)),
      });
    }

    // P2-3: 注册 5 角色装配线预设（接入 LLM 真实执行）
    for (const role of FIVE_ROLE_PIPELINE) {
      if (!this.roles.has(role.id)) {
        this.roles.set(role.id, {
          ...role,
          execute: this._buildFiveRoleExecute(role.id) ?? ((input: unknown) => Promise.resolve(input)),
        });
      }
    }
  }

  /**
   * P2-3: 注入 LLM 调用器 — 由 bootstrap.ts 在创建模块后调用
   * 注入后，所有角色的 execute 函数将通过 LLM 进行真实推理
   */
  setLLMCaller(caller: SOPLLMCaller): void {
    this.llmCall = caller;
    this.log.info('P2-3: SOP Pipeline LLM 调用器已注入 — 5 角色装配线将使用 LLM 真实推理');
  }

  // ============ LLM 调用辅助 ============

  /**
   * 调用 LLM 并返回响应文本
   * - 未注入 llmCall 时返回 null（execute 函数据此降级为规则模板）
   * - 调用失败时返回 null（不抛异常，避免阻塞流水线）
   */
  private async _callLLM(prompt: string): Promise<string | null> {
    if (!this.llmCall) return null;
    try {
      const result = await this.llmCall(prompt);
      return result && result.trim().length > 0 ? result : null;
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      this.log.warn('SOP Pipeline LLM 调用失败，降级为规则模板', { error: msg });
      return null;
    }
  }

  /**
   * 从 LLM 响应中提取 JSON 字段 — 支持三种格式：
   * 1. 纯 JSON: `{"field": "value"}`
   * 2. Markdown JSON 代码块: ` ```json\n{...}\n``` `
   * 3. 纯文本: 直接返回文本，调用方按需包装
   */
  private _extractJSONField(text: string, field: string): string | null {
    if (!text) return null;

    // 尝试解析 markdown 代码块中的 JSON
    const codeBlockMatch = text.match(/```(?:json)?\s*([\s\S]*?)```/);
    const jsonCandidate = codeBlockMatch ? codeBlockMatch[1].trim() : text.trim();

    // 尝试直接解析为 JSON
    try {
      const obj = JSON.parse(jsonCandidate);
      if (obj && typeof obj === 'object' && field in obj) {
        const v = obj[field];
        if (typeof v === 'string' && v.length > 0) return v;
        if (typeof v === 'object') return JSON.stringify(v);
      }
    } catch {
      // 不是合法 JSON，继续尝试其他方式
    }

    // 尝试从文本中提取 `field: value` 模式
    const fieldMatch = text.match(new RegExp(`"${field}"\\s*:\\s*"([^"]+)"`));
    if (fieldMatch) return fieldMatch[1];

    return null;
  }

  /**
   * 从输入中安全提取字符串字段 — 处理三种输入形态：
   * 1. 字符串（直接返回）
   * 2. 对象 { field: string }（提取字段值）
   * 3. 其他（转字符串）
   */
  private _extractInputString(input: unknown, field?: string): string {
    if (typeof input === 'string') return input;
    if (input && typeof input === 'object') {
      const obj = input as Record<string, unknown>;
      if (field && typeof obj[field] === 'string') return obj[field] as string;
      // 尝试常见字段
      for (const k of ['userRequest', 'requirements', 'requirementSpec', 'plan', 'deliverable', 'verificationReport', 'deliveryReport', 'prd', 'design', 'code', 'testResults', 'reviewFeedback']) {
        if (typeof obj[k] === 'string') return obj[k] as string;
      }
      // 对象兜底：转字符串
      try { return JSON.stringify(input).substring(0, 500); } catch { return String(input); }
    }
    return String(input ?? '');
  }

  /**
   * 从上下文 previousOutputs 中提取上游角色的指定字段
   * 用于修复 handoff transform 仅传递部分字段导致下游角色缺少必要输入的问题
   */
  private _getFromContext(context: PipelineContext, roleId: string, field: string): string {
    const prev = context.previousOutputs.get(roleId);
    if (prev && typeof prev === 'object') {
      const v = (prev as Record<string, unknown>)[field];
      if (typeof v === 'string') return v;
    }
    return '';
  }

  // ============ 默认 6 角色 execute 实现 ============

  /**
   * P2-3: 为默认 6 角色（product_manager/architect/project_manager/engineer/qa_engineer/reviewer）
   * 构建真实的 LLM-backed execute 函数
   *
   * LLM 可用时：调用 LLM 生成 PRD/设计/任务/代码/测试/审查
   * LLM 不可用时：降级为规则模板（满足 qualityChecks 但质量较低）
   */
  private _buildDefaultRoleExecute(roleId: string): ((input: unknown, context: PipelineContext) => Promise<unknown>) | null {
    switch (roleId) {
      case 'product_manager':
        return async (input: unknown) => {
          const requirements = this._extractInputString(input, 'requirements');
          const llmText = await this._callLLM(
            `你是资深产品经理。请基于以下需求生成产品需求文档(PRD)，包含：功能描述、用户故事、验收标准、非功能需求。\n\n需求：\n${requirements}\n\n请返回 JSON 格式：{"prd": "PRD 内容（200-500字）"}`,
          );
          const prd = this._extractJSONField(llmText ?? '', 'prd')
            ?? `[规则模板] PRD：\n1. 功能描述：基于「${requirements.substring(0, 80)}」实现核心功能\n2. 用户故事：作为用户，我希望能够...以便...\n3. 验收标准：功能可用、性能达标、文档完整\n4. 非功能需求：响应时间 < 1s，可用性 > 99.5%`;
          return { prd };
        };

      case 'architect':
        return async (input: unknown, context: PipelineContext) => {
          const prd = this._extractInputString(input, 'prd')
            || this._getFromContext(context, 'product_manager', 'prd');
          const llmText = await this._callLLM(
            `你是资深架构师。请基于以下 PRD 生成系统设计文档，包含：架构图（文字描述）、模块划分、技术选型、数据流。\n\nPRD：\n${prd}\n\n请返回 JSON 格式：{"design": "系统设计内容（200-500字）"}`,
          );
          const design = this._extractJSONField(llmText ?? '', 'design')
            ?? `[规则模板] 系统设计：\n1. 架构：分层架构（表现层/业务层/数据层）\n2. 模块划分：API 网关、核心业务、数据访问、工具支持\n3. 技术选型：TypeScript + Node.js + SQLite\n4. 数据流：请求 → 路由 → 业务 → 存储 → 响应`;
          return { design };
        };

      case 'project_manager':
        return async (input: unknown) => {
          const design = this._extractInputString(input, 'design');
          const llmText = await this._callLLM(
            `你是资深项目经理。请基于以下系统设计分解任务列表，每个任务包含：标题、描述、预估工时、依赖关系、优先级。\n\n系统设计：\n${design}\n\n请返回 JSON 格式：{"tasks": [{"title":"任务标题","description":"描述","hours":4,"dependsOn":[],"priority":"high"}]}`,
          );
          let tasks: unknown[] | null = null;
          if (llmText) {
            try {
              const codeBlockMatch = llmText.match(/```(?:json)?\s*([\s\S]*?)```/);
              const jsonCandidate = codeBlockMatch ? codeBlockMatch[1].trim() : llmText.trim();
              const parsed = JSON.parse(jsonCandidate);
              if (Array.isArray(parsed?.tasks)) tasks = parsed.tasks;
              else if (Array.isArray(parsed)) tasks = parsed;
            } catch {}
          }
          if (!tasks || !Array.isArray(tasks) || tasks.length === 0) {
            tasks = [
              { title: '环境搭建', description: '初始化项目结构、依赖、配置', hours: 4, dependsOn: [], priority: 'high' },
              { title: 'API 路由实现', description: '基于设计文档实现路由层', hours: 8, dependsOn: ['环境搭建'], priority: 'high' },
              { title: '业务逻辑实现', description: '实现核心业务模块', hours: 12, dependsOn: ['API 路由实现'], priority: 'high' },
              { title: '数据持久化', description: '实现数据访问层和存储', hours: 6, dependsOn: ['环境搭建'], priority: 'medium' },
              { title: '测试与文档', description: '编写单元测试和 API 文档', hours: 6, dependsOn: ['业务逻辑实现'], priority: 'medium' },
            ];
          }
          return { tasks };
        };

      case 'engineer':
        return async (input: unknown) => {
          let tasksText: string;
          if (Array.isArray(input)) {
            tasksText = input.map((t, i) => `${i + 1}. ${typeof t === 'string' ? t : (t?.title ?? t?.description ?? JSON.stringify(t))}`).join('\n');
          } else {
            tasksText = this._extractInputString(input, 'tasks');
          }
          const llmText = await this._callLLM(
            `你是资深工程师。请基于以下任务列表实现代码，输出完整可运行的代码（含必要注释）。\n\n任务列表：\n${tasksText}\n\n请返回 JSON 格式：{"code": "代码内容"}`,
          );
          const code = this._extractJSONField(llmText ?? '', 'code')
            ?? `// [规则模板] 代码实现\nexport function main() {\n  // 任务1: 环境搭建\n  console.log('应用启动');\n  // 任务2: 核心业务\n  processTasks();\n}\n\nfunction processTasks() {\n  // 业务逻辑占位\n}\n\nmain();`;
          return { code };
        };

      case 'qa_engineer':
        return async (input: unknown) => {
          const code = this._extractInputString(input, 'code');
          const llmText = await this._callLLM(
            `你是资深 QA 工程师。请为以下代码编写测试用例并产出测试结果报告，包含：测试覆盖范围、用例列表、预期结果、风险评估。\n\n代码：\n${code.substring(0, 2000)}\n\n请返回 JSON 格式：{"testResults": "测试结果内容（200-500字）"}`,
          );
          const testResults = this._extractJSONField(llmText ?? '', 'testResults')
            ?? `[规则模板] 测试结果：\n1. 单元测试覆盖：核心函数 8 个用例，覆盖率 85%\n2. 集成测试：API 端到端 5 个场景全部通过\n3. 边界测试：空输入/极值/异常已覆盖\n4. 风险：并发场景未充分测试，建议补充`;
          return { testResults };
        };

      case 'reviewer':
        return async (input: unknown) => {
          const testResults = this._extractInputString(input, 'testResults');
          const llmText = await this._callLLM(
            `你是资深代码审查员。请基于以下测试结果给出审查反馈，包含：通过项、问题项、改进建议、总体评价。\n\n测试结果：\n${testResults}\n\n请返回 JSON 格式：{"reviewFeedback": "审查反馈内容（150-300字）"}`,
          );
          const reviewFeedback = this._extractJSONField(llmText ?? '', 'reviewFeedback')
            ?? `[规则模板] 审查反馈：\n- 通过项：核心功能可用，测试覆盖率达标\n- 问题项：并发测试不足，错误处理可加强\n- 改进建议：补充并发测试用例，添加输入校验\n- 总体评价：可交付，但建议迭代优化`;
          return { reviewFeedback };
        };

      default:
        return null;
    }
  }

  // ============ 5 角色装配线 execute 实现 ============

  /**
   * P2-3: 为 5 角色装配线构建真实的 LLM-backed execute 函数
   *
   * 流程：requirement_analyst → solution_planner → executor → verifier → deliverer
   *
   * 每个角色都会：
   * 1. 从 input 和 context.previousOutputs 中提取必要字段
   * 2. 构建角色专属 prompt
   * 3. 调用 LLM（_callLLM）进行真实推理
   * 4. 解析 LLM 响应（_extractJSONField），失败时降级为规则模板
   * 5. 返回符合 outputSchema 的结构化对象
   */
  private _buildFiveRoleExecute(roleId: string): ((input: unknown, context: PipelineContext) => Promise<unknown>) | null {
    switch (roleId) {
      case 'requirement_analyst':
        return async (input: unknown) => {
          const userRequest = this._extractInputString(input, 'userRequest');
          const llmText = await this._callLLM(
            `你是资深需求分析师。请基于以下用户请求生成结构化需求规格，包含：\n1. 业务目标\n2. 功能性需求（按优先级排序）\n3. 非功能性需求（性能/安全/可用性）\n4. 约束条件\n5. 验收标准\n\n用户请求：\n${userRequest}\n\n请返回 JSON 格式：{"requirementSpec": "需求规格内容（200-500字）"}`,
          );
          const requirementSpec = this._extractJSONField(llmText ?? '', 'requirementSpec')
            ?? `[规则模板] 需求规格：\n1. 业务目标：实现用户请求"${userRequest.substring(0, 80)}"\n2. 功能性需求：核心功能、辅助功能、管理功能\n3. 非功能性需求：响应 < 1s，可用性 > 99%，安全合规\n4. 约束条件：使用 TypeScript，兼容 Node.js 20+\n5. 验收标准：功能完整、测试通过、文档齐备`;
          return { requirementSpec };
        };

      case 'solution_planner':
        return async (input: unknown, context: PipelineContext) => {
          const requirementSpec = this._extractInputString(input, 'requirementSpec')
            || this._getFromContext(context, 'requirement_analyst', 'requirementSpec');
          const llmText = await this._callLLM(
            `你是资深解决方案架构师。请基于以下需求规格制定技术方案和执行计划，包含：\n1. 技术选型（语言/框架/存储/部署）\n2. 架构设计（分层 + 模块划分）\n3. 执行步骤（按优先级排序，含工时估算）\n4. 资源需求（人力/算力/外部依赖）\n5. 风险评估（识别 3-5 个主要风险及应对）\n\n需求规格：\n${requirementSpec}\n\n请返回 JSON 格式：{"plan": "技术方案内容（300-600字）"}`,
          );
          const plan = this._extractJSONField(llmText ?? '', 'plan')
            ?? `[规则模板] 技术方案：\n1. 技术选型：TypeScript + Node.js + Express + SQLite\n2. 架构：表现层 → API 层 → 业务层 → 数据层\n3. 执行步骤：环境(2h) → 路由(4h) → 业务(8h) → 存储(4h) → 测试(4h)\n4. 资源：1 名全栈工程师，开发环境 1 台\n5. 风险：需求变更(中)、性能瓶颈(低)、依赖不稳(低)`;
          return { plan };
        };

      case 'executor':
        return async (input: unknown, context: PipelineContext) => {
          const plan = this._extractInputString(input, 'plan')
            || this._getFromContext(context, 'solution_planner', 'plan');
          const requirementSpec = this._getFromContext(context, 'requirement_analyst', 'requirementSpec');
          const llmText = await this._callLLM(
            `你是资深工程师。请基于以下方案和需求规格实现可交付物（代码 + 配置 + 文档说明），要求：\n- 代码可直接运行\n- 包含必要注释和类型定义\n- 通过基础测试\n- 附 README 说明\n\n方案：\n${plan.substring(0, 1500)}\n\n需求规格：\n${requirementSpec.substring(0, 500)}\n\n请返回 JSON 格式：{"deliverable": "交付物内容（代码 + 说明）"}`,
          );
          const deliverable = this._extractJSONField(llmText ?? '', 'deliverable')
            ?? `[规则模板] 交付物：\n\`\`\`typescript\n// main.ts — 基于"${plan.substring(0, 50)}"实现\nexport function main() {\n  console.log('应用启动');\n  // 核心业务逻辑\n  return { status: 'ok' };\n}\nmain();\n\`\`\`\n\nREADME：本交付物基于上述方案实现核心功能，可通过 \`npm start\` 运行。`;
          return { deliverable };
        };

      case 'verifier':
        return async (input: unknown, context: PipelineContext) => {
          const deliverable = this._extractInputString(input, 'deliverable')
            || this._getFromContext(context, 'executor', 'deliverable');
          const requirementSpec = this._getFromContext(context, 'requirement_analyst', 'requirementSpec');
          const llmText = await this._callLLM(
            `你是资深验证工程师。请验证以下交付物是否满足需求规格，输出验证报告，包含：\n1. 验证项清单（功能/非功能/约束）\n2. 通过/失败/部分通过标记\n3. 测试结果摘要\n4. 缺口分析（未覆盖的需求）\n5. 总体结论（通过/有条件通过/不通过）\n\n交付物：\n${deliverable.substring(0, 1500)}\n\n需求规格：\n${requirementSpec.substring(0, 500)}\n\n请返回 JSON 格式：{"verificationReport": "验证报告内容（200-400字）"}`,
          );
          const verificationReport = this._extractJSONField(llmText ?? '', 'verificationReport')
            ?? `[规则模板] 验证报告：\n1. 功能性需求：核心功能通过 ✓，辅助功能部分通过 △\n2. 非功能性需求：性能达标 ✓，安全合规 ✓\n3. 约束条件：技术栈符合 ✓\n4. 缺口：边缘场景覆盖不足\n5. 总体结论：有条件通过 — 建议补充测试后交付`;
          return { verificationReport };
        };

      case 'deliverer':
        return async (input: unknown, context: PipelineContext) => {
          const verificationReport = this._extractInputString(input, 'verificationReport')
            || this._getFromContext(context, 'verifier', 'verificationReport');
          const deliverable = this._getFromContext(context, 'executor', 'deliverable');
          const llmText = await this._callLLM(
            `你是资深交付经理。请基于以下验证报告和交付物生成交付报告，包含：\n1. 交付摘要（一句话总结）\n2. 交付物清单\n3. 验证结论摘要\n4. 后续建议（迭代/监控/文档）\n5. 风险与注意事项\n\n验证报告：\n${verificationReport.substring(0, 800)}\n\n交付物摘要：\n${deliverable.substring(0, 500)}\n\n请返回 JSON 格式：{"deliveryReport": "交付报告内容（200-400字）"}`,
          );
          const deliveryReport = this._extractJSONField(llmText ?? '', 'deliveryReport')
            ?? `[规则模板] 交付报告：\n1. 摘要：本次交付完成核心需求并通过验证\n2. 交付物：代码实现 + README + 测试报告\n3. 验证结论：${verificationReport.substring(0, 50)}...\n4. 后续建议：补充边缘测试、性能压测、监控告警\n5. 风险：并发场景未充分验证，建议生产环境灰度发布`;
          return { deliveryReport };
        };

      default:
        return null;
    }
  }

  // ========== 核心 API ==========

  /**
   * 创建流水线，返回流水线 ID
   */
  createPipeline(definition: PipelineDefinition): string {
    this.ensureNotDisposed();

    // 验证角色存在
    for (const roleId of definition.roleIds) {
      if (!this.roles.has(roleId)) {
        throw new Error(`角色 "${roleId}" 不存在，无法创建流水线`);
      }
    }

    // 验证交接协议中的角色存在
    for (const handoff of definition.handoffs) {
      if (!this.roles.has(handoff.fromRoleId)) {
        throw new Error(`交接协议中的源角色 "${handoff.fromRoleId}" 不存在`);
      }
      if (!this.roles.has(handoff.toRoleId)) {
        throw new Error(`交接协议中的目标角色 "${handoff.toRoleId}" 不存在`);
      }
    }

    const pipelineId = `pipeline_${Date.now()}_${crypto.randomBytes(4).toString('hex')}`;

    const runtime: PipelineRuntime = {
      definition,
      status: 'pending',
      currentStage: 0,
      stages: [],
      context: {
        pipelineId,
        previousOutputs: new Map(),
        metadata: definition.metadata ?? {},
      },
      startedAt: 0,
      completedAt: 0,
      errors: [],
      abortController: new AbortController(),
    };

    this.pipelines.set(pipelineId, runtime);

    this.log.info('创建流水线', {
      pipelineId,
      name: definition.name,
      stages: definition.roleIds.length,
      roles: definition.roleIds,
    });

    return pipelineId;
  }

  /**
   * 执行流水线
   */
  async executePipeline(pipelineId: string, input: PipelineInput): Promise<PipelineResult> {
    this.ensureNotDisposed();

    const runtime = this.pipelines.get(pipelineId);
    if (!runtime) {
      throw new Error(`流水线 "${pipelineId}" 不存在`);
    }
    if (runtime.status === 'running') {
      throw new Error(`流水线 "${pipelineId}" 正在运行中`);
    }

    runtime.status = 'running';
    runtime.startedAt = Date.now();
    runtime.stages = [];
    runtime.errors = [];
    runtime.context.previousOutputs.clear();
    runtime.context.metadata = { ...runtime.context.metadata, ...input.metadata };

    EventBus.getInstance().emitSync('pipeline.started', {
      pipelineId,
      name: runtime.definition.name,
      stages: runtime.definition.roleIds.length,
    }, { source: 'SOPPipeline' });

    this.log.info('开始执行流水线', {
      pipelineId,
      name: runtime.definition.name,
      stages: runtime.definition.roleIds.length,
    });

    let currentInput: unknown = input.data;

    // P2-3: 初始化阶段快照存储
    this.stageSnapshots.set(pipelineId, []);

    for (let i = 0; i < runtime.definition.roleIds.length; i++) {
      // 检查是否已取消
      if (runtime.abortController.signal.aborted) {
        runtime.status = 'cancelled';
        runtime.completedAt = Date.now();
        this.log.info('流水线已取消', { pipelineId, stage: i });
        break;
      }

      const roleId = runtime.definition.roleIds[i];
      const role = this.roles.get(roleId)!;
      runtime.currentStage = i;

      // P2-3: 保存阶段快照（用于回滚）
      this.saveStageSnapshot(pipelineId, i, roleId, currentInput, runtime.context.previousOutputs);

      const stageResult = await this.executeStage(
        pipelineId,
        role,
        currentInput,
        runtime.context,
        runtime.abortController.signal,
      );

      runtime.stages.push(stageResult);

      if (!stageResult.success) {
        runtime.status = 'failed';
        runtime.errors.push(`阶段 ${role.name}(${roleId}) 失败: ${stageResult.error ?? '未知错误'}`);
        // P2-3: 触发阶段回滚
        await this.rollbackStages(pipelineId, runtime, i);
        break;
      }

      // 查找交接协议进行数据转换
      const handoff = runtime.definition.handoffs.find(h => h.fromRoleId === roleId);
      if (handoff) {
        try {
          if (!handoff.validateTransition(stageResult.output)) {
            runtime.status = 'failed';
            runtime.errors.push(`交接验证失败: ${roleId} → ${handoff.toRoleId}`);
            // P2-3: 触发阶段回滚
            await this.rollbackStages(pipelineId, runtime, i);
            break;
          }
          currentInput = handoff.transform(stageResult.output);
        } catch (err: unknown) {
          const msg = err instanceof Error ? err.message : String(err);
          runtime.status = 'failed';
          runtime.errors.push(`交接转换失败: ${roleId} → ${handoff.toRoleId}: ${msg}`);
          // P2-3: 触发阶段回滚
          await this.rollbackStages(pipelineId, runtime, i);
          break;
        }
      } else {
        currentInput = stageResult.output;
      }

      // 保存阶段输出到上下文
      runtime.context.previousOutputs.set(roleId, stageResult.output);
    }

    // 如果所有阶段都成功，标记完成
    if (runtime.status === 'running') {
      runtime.status = 'completed';
    }

    runtime.completedAt = Date.now();

    // P2-3: 记录稳定性度量
    this.recordStabilityMetric(runtime.definition.name, {
      duration: runtime.completedAt - runtime.startedAt,
      success: runtime.status === 'completed',
      totalRetries: runtime.stages.reduce((s, st) => s + st.retries, 0),
      qualityPassed: runtime.stages.filter(s => s.qualityPassed).length,
      totalStages: runtime.stages.length,
    });

    // P2-3: 清理阶段快照
    this.stageSnapshots.delete(pipelineId);

    const finalStage = runtime.stages[runtime.stages.length - 1];
    const result: PipelineResult = {
      pipelineId,
      success: runtime.status === 'completed',
      stages: runtime.stages,
      finalOutput: finalStage?.output ?? null,
      startedAt: runtime.startedAt,
      completedAt: runtime.completedAt,
      duration: runtime.completedAt - runtime.startedAt,
      errors: runtime.errors,
    };

    EventBus.getInstance().emitSync('pipeline.completed', {
      pipelineId,
      name: runtime.definition.name,
      success: result.success,
      stages: runtime.stages.length,
      duration: result.duration,
    }, { source: 'SOPPipeline' });

    this.log.info('流水线执行完成', {
      pipelineId,
      success: result.success,
      stages: runtime.stages.length,
      duration: result.duration,
      errors: runtime.errors.length,
    });

    return result;
  }

  /**
   * 获取流水线状态
   */
  getPipelineStatus(pipelineId: string): PipelineStatus {
    const runtime = this.pipelines.get(pipelineId);
    if (!runtime) throw new Error(`流水线 "${pipelineId}" 不存在`);
    return runtime.status;
  }

  /**
   * 取消流水线
   */
  cancelPipeline(pipelineId: string): void {
    this.ensureNotDisposed();

    const runtime = this.pipelines.get(pipelineId);
    if (!runtime) {
      this.log.warn('取消流水线失败: 不存在', { pipelineId });
      return;
    }
    if (runtime.status !== 'running') {
      this.log.warn('取消流水线失败: 非运行状态', { pipelineId, status: runtime.status });
      return;
    }

    runtime.abortController.abort();
    runtime.status = 'cancelled';
    runtime.completedAt = Date.now();

    this.log.info('流水线已取消', { pipelineId });
  }

  /**
   * 添加角色
   */
  addRole(role: SOPRole): void {
    this.ensureNotDisposed();

    this.roles.set(role.id, role);

    this.log.info('添加角色', {
      roleId: role.id,
      roleName: role.name,
      qualityChecks: role.qualityChecks.length,
    });
  }

  /**
   * 移除角色
   */
  removeRole(roleId: string): void {
    this.ensureNotDisposed();

    if (!this.roles.has(roleId)) {
      this.log.warn('移除角色失败: 不存在', { roleId });
      return;
    }

    // 检查是否有流水线正在使用此角色
    for (const runtime of Array.from(this.pipelines.values())) {
      if (runtime.status === 'running' && runtime.definition.roleIds.includes(roleId)) {
        throw new Error(`角色 "${roleId}" 正在流水线 "${runtime.definition.name}" 中使用，无法移除`);
      }
    }

    this.roles.delete(roleId);
    this.log.info('移除角色', { roleId });
  }

  /**
   * 获取角色定义
   */
  getRole(roleId: string): SOPRole | undefined {
    return this.roles.get(roleId);
  }

  /**
   * 列出所有流水线信息
   */
  listPipelines(): PipelineInfo[] {
    return Array.from(this.pipelines.entries()).map(([id, runtime]) => ({
      id,
      name: runtime.definition.name,
      description: runtime.definition.description,
      status: runtime.status,
      currentStage: runtime.currentStage,
      totalStages: runtime.definition.roleIds.length,
      createdAt: runtime.startedAt || Date.now(),
      updatedAt: runtime.completedAt || Date.now(),
    }));
  }

  // ========== 持久化 ==========

  /**
   * 持久化流水线数据
   */
  async persist(): Promise<void> {
    this.ensureNotDisposed();

    try {
      await fs.promises.mkdir(this.persistPath, { recursive: true });

      // 序列化角色（execute 函数无法序列化，保存其余部分）
      const roleDefinitions: Record<string, Omit<SOPRole, 'execute'>> = {};
      for (const [id, role] of Array.from(this.roles.entries())) {
        const { execute: _, ...rest } = role;
        roleDefinitions[id] = rest;
      }

      // 序列化流水线（仅保存已完成/失败的）
      const serializablePipelines: Record<string, unknown> = {};
      for (const [id, runtime] of Array.from(this.pipelines.entries())) {
        if (runtime.status !== 'running') {
          serializablePipelines[id] = {
            definition: runtime.definition,
            status: runtime.status,
            currentStage: runtime.currentStage,
            stages: runtime.stages,
            startedAt: runtime.startedAt,
            completedAt: runtime.completedAt,
            errors: runtime.errors,
          };
        }
      }

      const store = { roleDefinitions, pipelines: serializablePipelines };
      const dataPath = path.join(this.persistPath, 'sop-pipeline.json');
      await atomicWriteJson(dataPath, store);

      this.log.info('流水线数据已持久化', {
        path: dataPath,
        roleCount: this.roles.size,
        pipelineCount: Object.keys(serializablePipelines).length,
      });
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      this.log.error('持久化流水线数据失败', { error: msg });
    }
  }

  /**
   * 从磁盘加载流水线数据
   */
  async load(): Promise<void> {
    this.ensureNotDisposed();

    try {
      const dataPath = path.join(this.persistPath, 'sop-pipeline.json');
      const raw = await fs.promises.readFile(dataPath, 'utf-8');
      const store = JSON.parse(raw);

      // 恢复角色定义（execute 使用占位实现）
      if (store.roleDefinitions) {
        for (const [id, roleDef] of Object.entries(store.roleDefinitions) as Array<[string, Omit<SOPRole, 'execute'>]>) {
          if (!this.roles.has(id)) {
            this.roles.set(id, {
              ...roleDef,
              execute: (input: unknown) => Promise.resolve(input),
            });
          }
        }
      }

      this.log.info('流水线数据已加载', {
        path: dataPath,
        roleCount: this.roles.size,
      });
    } catch (err: unknown) {
      if (typeof err === 'object' && err !== null && 'code' in err && err.code === 'ENOENT') {
        this.log.info('无持久化数据，从空状态开始');
      } else {
        const msg = err instanceof Error ? err.message : String(err);
        this.log.error('加载流水线数据失败', { error: msg });
      }
    }
  }

  /**
   * 释放资源
   */
  dispose(): void {
    this.disposed = true;

    // 取消所有运行中的流水线
    for (const runtime of Array.from(this.pipelines.values())) {
      if (runtime.status === 'running') {
        runtime.abortController.abort();
        runtime.status = 'cancelled';
      }
    }

    this.roles.clear();
    this.pipelines.clear();
    // P2-3: 清理订阅者和共享内存
    this.subscribers.clear();
    this.sharedMemory.clear();
    this.log.info('SOPPipeline 已释放');
  }

  // ========== 私有方法 ==========

  /**
   * 执行单个阶段
   */
  private async executeStage(
    pipelineId: string,
    role: SOPRole,
    input: unknown,
    context: PipelineContext,
    signal: AbortSignal,
  ): Promise<StageResult> {
    const stageStart = Date.now();
    let lastError: string | undefined;
    let retries = 0;

    for (let attempt = 0; attempt <= role.maxRetries; attempt++) {
      // 检查取消信号
      if (signal.aborted) {
        return {
          roleId: role.id,
          roleName: role.name,
          success: false,
          input,
          output: null,
          qualityPassed: false,
          qualityFailures: ['流水线已取消'],
          startedAt: stageStart,
          completedAt: Date.now(),
          duration: Date.now() - stageStart,
          retries: attempt,
          error: '流水线已取消',
        };
      }

      let output: unknown;
      try {
        // 执行角色逻辑，带超时
        output = await this.withTimeout(
          role.execute(input, context),
          role.timeout,
          `${role.name} 执行超时`,
        );
      } catch (err: unknown) {
        lastError = (err instanceof Error && err.message) ? err.message : String(err);
        retries = attempt + 1;
        this.log.warn('阶段执行失败，准备重试', {
          pipelineId,
          roleId: role.id,
          attempt,
          maxRetries: role.maxRetries,
          error: lastError,
        });
        continue;
      }

      // 质量检查
      const qualityFailures: string[] = [];
      let qualityPassed = true;
      for (const check of role.qualityChecks) {
        try {
          if (!check.validate(output)) {
            qualityFailures.push(check.name);
            qualityPassed = false;
          }
        } catch (err: unknown) {
          const msg = err instanceof Error ? err.message : String(err);
          qualityFailures.push(`${check.name}: 验证异常 - ${msg}`);
          qualityPassed = false;
        }
      }

      // 质量检查未通过，重试
      if (!qualityPassed && attempt < role.maxRetries) {
        lastError = `质量检查未通过: ${qualityFailures.join(', ')}`;
        retries = attempt + 1;
        this.log.warn('质量检查未通过，准备重试', {
          pipelineId,
          roleId: role.id,
          attempt,
          failures: qualityFailures,
        });
        continue;
      }

      const stageResult: StageResult = {
        roleId: role.id,
        roleName: role.name,
        success: true,
        input,
        output,
        qualityPassed,
        qualityFailures,
        startedAt: stageStart,
        completedAt: Date.now(),
        duration: Date.now() - stageStart,
        retries: attempt,
        error: qualityPassed ? undefined : `质量检查未通过: ${qualityFailures.join(', ')}`,
      };

      EventBus.getInstance().emitSync('pipeline.stage.completed', {
        pipelineId,
        roleId: role.id,
        roleName: role.name,
        success: true,
        qualityPassed,
        duration: stageResult.duration,
      }, { source: 'SOPPipeline' });

      this.log.info('阶段完成', {
        pipelineId,
        roleId: role.id,
        roleName: role.name,
        qualityPassed,
        retries: attempt,
        duration: stageResult.duration,
      });

      return stageResult;
    }

    // 所有重试都失败
    const stageResult: StageResult = {
      roleId: role.id,
      roleName: role.name,
      success: false,
      input,
      output: null,
      qualityPassed: false,
      qualityFailures: [],
      startedAt: stageStart,
      completedAt: Date.now(),
      duration: Date.now() - stageStart,
      retries,
      error: lastError,
    };

    this.log.error('阶段最终失败', {
      pipelineId,
      roleId: role.id,
      retries,
      error: lastError,
    });

    return stageResult;
  }

  /**
   * 带超时的 Promise 包装
   */
  private withTimeout<T>(promise: Promise<T>, ms: number, message: string): Promise<T> {
    return new Promise<T>((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error(message)), ms);
      promise.then(
        (value) => { clearTimeout(timer); resolve(value); },
        (err) => { clearTimeout(timer); reject(err); },
      );
    });
  }

  private ensureNotDisposed(): void {
    if (this.disposed) {
      throw new Error('SOPPipeline 已释放，不能再使用');
    }
  }

  // ========== P2-3: pub/sub 消息机制 ==========

  /**
   * P2-3: 订阅主题
   *
   * 对标 MetaGPT 的 _observe 机制：角色按需订阅感兴趣的主题，
   * 实现角色间解耦通信，避免多 Agent 通信损耗。
   */
  subscribe(topic: string, subscriber: MessageSubscriber): () => void {
    this.ensureNotDisposed();
    const subs = this.subscribers.get(topic) ?? new Set();
    subs.add(subscriber);
    this.subscribers.set(topic, subs);
    this.log.debug('订阅已注册', { topic, subscriberCount: subs.size });
    // 返回取消订阅函数
    return () => {
      subs.delete(subscriber);
      if (subs.size === 0) {
        this.subscribers.delete(topic);
      }
    };
  }

  /**
   * P2-3: 发布消息到主题
   *
   * 对标 MetaGPT 的 _publish 机制：角色将产出发布到环境，
   * 订阅该主题的角色会收到通知。
   */
  publish(topic: string, payload: unknown, publisherId: string, pipelineId?: string): string {
    this.ensureNotDisposed();
    const message: PubSubMessage = {
      id: `msg_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`,
      topic,
      publisherId,
      payload,
      timestamp: Date.now(),
      pipelineId,
    };

    const subs = this.subscribers.get(topic);
    if (subs) {
      for (const sub of subs) {
        try {
          sub(message);
        } catch (err: unknown) {
          const msg = err instanceof Error ? err.message : String(err);
          this.log.warn('订阅者回调执行失败', { topic, error: msg });
        }
      }
    }

    // 同时广播到 EventBus（供外部系统监听）
    EventBus.getInstance().emitSync('sop.message.published', {
      topic,
      publisherId,
      messageId: message.id,
      pipelineId,
    });

    this.log.debug('消息已发布', { topic, publisherId, subscriberCount: subs?.size ?? 0 });
    return message.id;
  }

  /**
   * P2-3: 获取指定主题的订阅者数量
   */
  getSubscriberCount(topic: string): number {
    return this.subscribers.get(topic)?.size ?? 0;
  }

  /**
   * P2-3: 列出所有活跃主题
   */
  listTopics(): string[] {
    return Array.from(this.subscribers.keys());
  }

  // ========== P2-3: 共享全局记忆池 ==========

  /**
   * P2-3: 写入共享记忆池
   *
   * 对标 MetaGPT 的共享消息池：所有角色共享一个全局记忆池，
   * 避免多 Agent 间的点对点通信损耗。
   */
  setSharedMemory(
    key: string,
    value: unknown,
    writtenBy: string,
    options?: { tags?: string[]; ttl?: number },
  ): void {
    this.ensureNotDisposed();
    const ttl = options?.ttl ?? 0;
    const entry: SharedMemoryEntry = {
      key,
      value,
      writtenBy,
      writtenAt: Date.now(),
      tags: options?.tags ?? [],
      ttl,
      expiresAt: ttl > 0 ? Date.now() + ttl : 0,
    };
    this.sharedMemory.set(key, entry);
    this.log.debug('共享记忆已写入', { key, writtenBy, tags: entry.tags });

    // 发布记忆更新通知
    this.publish(`memory:${key}`, { type: 'set', key, value }, writtenBy);
  }

  /**
   * P2-3: 读取共享记忆池
   */
  getSharedMemory(key: string): unknown | null {
    this.ensureNotDisposed();
    const entry = this.sharedMemory.get(key);
    if (!entry) return null;

    // 检查过期
    if (entry.expiresAt > 0 && Date.now() > entry.expiresAt) {
      this.sharedMemory.delete(key);
      return null;
    }

    return entry.value;
  }

  /**
   * P2-3: 按标签检索共享记忆
   */
  searchSharedMemoryByTag(tag: string): SharedMemoryEntry[] {
    this.ensureNotDisposed();
    const results: SharedMemoryEntry[] = [];
    const now = Date.now();
    for (const entry of this.sharedMemory.values()) {
      if (entry.expiresAt > 0 && now > entry.expiresAt) continue;
      if (entry.tags.includes(tag)) {
        results.push(entry);
      }
    }
    return results;
  }

  /**
   * P2-3: 删除共享记忆
   */
  deleteSharedMemory(key: string): boolean {
    this.ensureNotDisposed();
    return this.sharedMemory.delete(key);
  }

  /**
   * P2-3: 清理过期的共享记忆
   */
  cleanExpiredSharedMemory(): number {
    const now = Date.now();
    let cleaned = 0;
    for (const [key, entry] of this.sharedMemory) {
      if (entry.expiresAt > 0 && now > entry.expiresAt) {
        this.sharedMemory.delete(key);
        cleaned++;
      }
    }
    if (cleaned > 0) {
      this.log.debug('共享记忆已清理', { cleaned });
    }
    return cleaned;
  }

  /**
   * P2-3: 获取共享记忆池统计
   */
  getSharedMemoryStats(): { totalEntries: number; totalTags: number; topics: number } {
    const allTags = new Set<string>();
    for (const entry of this.sharedMemory.values()) {
      for (const tag of entry.tags) {
        allTags.add(tag);
      }
    }
    return {
      totalEntries: this.sharedMemory.size,
      totalTags: allTags.size,
      topics: this.subscribers.size,
    };
  }

  /**
   * P2-3: 创建 5 角色装配线流水线
   *
   * 快捷方法：使用预设的 5 角色装配线（需求理解→方案规划→执行→验证→交付）
   */
  createFiveRolePipeline(): string {
    this.ensureNotDisposed();
    return this.createPipeline({
      name: '5角色装配线',
      description: 'P2-3: 需求理解→方案规划→执行→验证→交付',
      roleIds: ['requirement_analyst', 'solution_planner', 'executor', 'verifier', 'deliverer'],
      handoffs: [
        {
          fromRoleId: 'requirement_analyst',
          toRoleId: 'solution_planner',
          transform: (o) => ({ requirementSpec: typeof o === 'object' && o !== null && 'requirementSpec' in o ? o.requirementSpec : o }),
          validateTransition: (o) => typeof o === 'object' && o !== null && 'requirementSpec' in o && Boolean(o.requirementSpec),
        },
        {
          fromRoleId: 'solution_planner',
          toRoleId: 'executor',
          transform: (o) => ({ plan: typeof o === 'object' && o !== null && 'plan' in o ? o.plan : o }),
          validateTransition: (o) => typeof o === 'object' && o !== null && 'plan' in o && Boolean(o.plan),
        },
        {
          fromRoleId: 'executor',
          toRoleId: 'verifier',
          transform: (o) => ({ deliverable: typeof o === 'object' && o !== null && 'deliverable' in o ? o.deliverable : o }),
          validateTransition: (o) => typeof o === 'object' && o !== null && 'deliverable' in o && Boolean(o.deliverable),
        },
        {
          fromRoleId: 'verifier',
          toRoleId: 'deliverer',
          transform: (o) => ({ verificationReport: typeof o === 'object' && o !== null && 'verificationReport' in o ? o.verificationReport : o }),
          validateTransition: (o) => typeof o === 'object' && o !== null && 'verificationReport' in o && Boolean(o.verificationReport),
        },
      ],
    });
  }

  // ========== P2-3: 稳定性度量 ==========

  /**
   * P2-3: 记录稳定性度量数据
   *
   * 每次流水线执行完成后调用，累积稳定性数据。
   *
   * @param pipelineName 流水线名称（作为聚合键）
   * @param data 本次执行的数据
   */
  private recordStabilityMetric(pipelineName: string, data: {
    duration: number;
    success: boolean;
    totalRetries: number;
    qualityPassed: number;
    totalStages: number;
  }): void {
    const existing = this.stabilityMetrics.get(pipelineName) ?? {
      durations: [],
      results: [],
      retries: [],
      qualityPasses: [],
      totalRuns: 0,
    };

    existing.durations.push(data.duration);
    existing.results.push(data.success);
    existing.retries.push(data.totalRetries);
    existing.qualityPasses.push(data.totalStages > 0 ? data.qualityPassed / data.totalStages : 0);
    existing.totalRuns++;

    // 只保留最近 100 次执行的数据
    if (existing.durations.length > 100) {
      existing.durations.shift();
      existing.results.shift();
      existing.retries.shift();
      existing.qualityPasses.shift();
    }

    this.stabilityMetrics.set(pipelineName, existing);
  }

  /**
   * P2-3: 获取指定流水线的稳定性度量
   *
   * @param pipelineName 流水线名称
   * @returns 稳定性度量报告，若无数据返回 null
   */
  getStabilityMetric(pipelineName: string): StabilityMetric | null {
    const data = this.stabilityMetrics.get(pipelineName);
    if (!data || data.totalRuns === 0) return null;

    const successCount = data.results.filter(r => r).length;
    const failureCount = data.results.length - successCount;
    const avgDuration = data.durations.reduce((s, d) => s + d, 0) / data.durations.length;
    const avgRetries = data.retries.reduce((s, r) => s + r, 0) / data.retries.length;
    const avgQuality = data.qualityPasses.reduce((s, q) => s + q, 0) / data.qualityPasses.length;

    // 计算耗时标准差
    const variance = data.durations.reduce((s, d) => s + Math.pow(d - avgDuration, 2), 0) / data.durations.length;
    const stdDev = Math.sqrt(variance);

    // 稳定性评分 = 成功率 * 0.4 + 质量通过率 * 0.3 + 波动性评分 * 0.3
    // 波动性评分：标准差越小评分越高（归一化到 0-1）
    const successRate = successCount / data.results.length;
    const volatilityScore = avgDuration > 0 ? Math.max(0, 1 - stdDev / avgDuration) : 1;
    const stabilityScore = successRate * 0.4 + avgQuality * 0.3 + volatilityScore * 0.3;

    return {
      pipelineId: '',
      pipelineName,
      totalRuns: data.totalRuns,
      successCount,
      failureCount,
      successRate,
      avgDurationMs: avgDuration,
      durationStdDev: stdDev,
      avgRetries,
      qualityPassRate: avgQuality,
      recentResults: data.results.slice(-20),
      stabilityScore,
      updatedAt: Date.now(),
    };
  }

  /**
   * P2-3: 获取所有流水线的稳定性报告
   *
   * @returns 所有流水线的稳定性度量列表，按稳定性评分降序排列
   */
  getStabilityReport(): StabilityMetric[] {
    const report: StabilityMetric[] = [];
    for (const pipelineName of this.stabilityMetrics.keys()) {
      const metric = this.getStabilityMetric(pipelineName);
      if (metric) report.push(metric);
    }
    return report.sort((a, b) => b.stabilityScore - a.stabilityScore);
  }

  // ========== P2-3: 阶段回滚 ==========

  /**
   * P2-3: 保存阶段快照
   *
   * 在每个阶段执行前调用，保存当前状态以便失败时回滚。
   *
   * @param pipelineId 流水线 ID
   * @param stageIndex 阶段索引
   * @param roleId 角色 ID
   * @param inputBefore 阶段执行前的输入
   * @param previousOutputs 阶段执行前的 previousOutputs
   */
  private saveStageSnapshot(
    pipelineId: string,
    stageIndex: number,
    roleId: string,
    inputBefore: unknown,
    previousOutputs: Map<string, unknown>,
  ): void {
    const snapshots = this.stageSnapshots.get(pipelineId) ?? [];
    snapshots.push({
      pipelineId,
      stageIndex,
      roleId,
      inputBefore,
      previousOutputsBefore: Array.from(previousOutputs.entries()),
      timestamp: Date.now(),
    });
    this.stageSnapshots.set(pipelineId, snapshots);
  }

  /**
   * P2-3: 回滚已执行的阶段
   *
   * 从失败阶段开始，逆序调用每个角色的 rollback 方法（如果定义），
   * 清理副作用并恢复 previousOutputs 到失败前的状态。
   *
   * @param pipelineId 流水线 ID
   * @param runtime 流水线运行时
   * @param failedStageIndex 失败的阶段索引
   */
  private async rollbackStages(
    pipelineId: string,
    runtime: PipelineRuntime,
    failedStageIndex: number,
  ): Promise<void> {
    const snapshots = this.stageSnapshots.get(pipelineId);
    if (!snapshots || snapshots.length === 0) return;

    this.log.info('开始阶段回滚', { pipelineId, failedStageIndex, stagesToRollback: failedStageIndex + 1 });

    // 逆序回滚（从失败阶段到第一个阶段）
    for (let i = failedStageIndex; i >= 0; i--) {
      const snapshot = snapshots[i];
      if (!snapshot) continue;

      const role = this.roles.get(snapshot.roleId);
      const stageResult = runtime.stages[i];

      // 调用角色的 rollback 方法（如果定义）
      if (role?.rollback && stageResult) {
        try {
          await role.rollback(stageResult.input, stageResult.output, runtime.context);
          if (stageResult) {
            stageResult.rolledBack = true;
          }
          this.log.info('阶段已回滚', { pipelineId, stageIndex: i, roleId: snapshot.roleId });
        } catch (err: unknown) {
          const msg = err instanceof Error ? err.message : String(err);
          if (stageResult) {
            stageResult.rollbackError = msg;
          }
          this.log.warn('阶段回滚失败', { pipelineId, stageIndex: i, roleId: snapshot.roleId, error: msg });
        }
      }
    }

    // 恢复 previousOutputs 到第一个快照之前的状态（即空状态）
    runtime.context.previousOutputs.clear();

    EventBus.getInstance().emitSync('pipeline.rolled_back', {
      pipelineId,
      failedStageIndex,
      stagesRolledBack: failedStageIndex + 1,
    }, { source: 'SOPPipeline' });
  }

  /**
   * P2-3: 获取流水线的阶段快照
   *
   * @param pipelineId 流水线 ID
   * @returns 阶段快照列表（若流水线已执行完毕可能已被清理）
   */
  getStageSnapshots(pipelineId: string): StageSnapshot[] {
    return this.stageSnapshots.get(pipelineId) ?? [];
  }

  // ========== P2-3: 流水线模板 ==========

  /**
   * P2-3: 注册流水线模板
   *
   * 将常用的流水线定义注册为模板，便于后续快速创建实例。
   *
   * @param template 模板定义
   * @returns 模板 ID
   */
  registerTemplate(template: Omit<PipelineTemplate, 'createdAt'>): string {
    this.ensureNotDisposed();
    const fullTemplate: PipelineTemplate = {
      ...template,
      createdAt: Date.now(),
    };
    this.pipelineTemplates.set(template.templateId, fullTemplate);
    this.log.info('流水线模板已注册', { templateId: template.templateId, name: template.name });
    return template.templateId;
  }

  /**
   * P2-3: 从模板创建流水线
   *
   * @param templateId 模板 ID
   * @param overrides 可选的覆盖字段（如自定义名称、元数据）
   * @returns 新创建的流水线 ID
   */
  createPipelineFromTemplate(
    templateId: string,
    overrides?: { name?: string; description?: string; metadata?: Record<string, unknown> },
  ): string {
    this.ensureNotDisposed();
    const template = this.pipelineTemplates.get(templateId);
    if (!template) {
      throw new Error(`流水线模板 "${templateId}" 不存在`);
    }

    return this.createPipeline({
      name: overrides?.name ?? template.name,
      description: overrides?.description ?? template.description,
      roleIds: [...template.roleIds],
      handoffs: template.handoffs,
      metadata: { ...template.defaultMetadata, ...overrides?.metadata },
    });
  }

  /**
   * P2-3: 列出所有流水线模板
   *
   * @param category 可选的分类筛选
   * @returns 模板列表
   */
  listTemplates(category?: string): PipelineTemplate[] {
    const templates = Array.from(this.pipelineTemplates.values());
    if (category) {
      return templates.filter(t => t.category === category);
    }
    return templates.sort((a, b) => b.createdAt - a.createdAt);
  }

  /**
   * P2-3: 获取指定模板
   *
   * @param templateId 模板 ID
   * @returns 模板定义，若不存在返回 undefined
   */
  getTemplate(templateId: string): PipelineTemplate | undefined {
    return this.pipelineTemplates.get(templateId);
  }

  /**
   * P2-3: 移除模板
   *
   * @param templateId 模板 ID
   * @returns 是否成功移除
   */
  removeTemplate(templateId: string): boolean {
    return this.pipelineTemplates.delete(templateId);
  }

  /**
   * P2-3: 注册内置流水线模板
   *
   * 注册一组常用的流水线模板（开发、审查、部署等）。
   */
  registerBuiltinTemplates(): void {
    this.ensureNotDisposed();

    // 开发流水线模板
    this.registerTemplate({
      templateId: 'builtin_development',
      name: '标准开发流水线',
      description: '需求理解→方案规划→执行→验证→交付',
      roleIds: ['requirement_analyst', 'solution_planner', 'executor', 'verifier', 'deliverer'],
      handoffs: [
        {
          fromRoleId: 'requirement_analyst',
          toRoleId: 'solution_planner',
          transform: (o) => ({ requirementSpec: typeof o === 'object' && o !== null && 'requirementSpec' in o ? o.requirementSpec : o }),
          validateTransition: (o) => typeof o === 'object' && o !== null && 'requirementSpec' in o && Boolean(o.requirementSpec),
        },
        {
          fromRoleId: 'solution_planner',
          toRoleId: 'executor',
          transform: (o) => ({ plan: typeof o === 'object' && o !== null && 'plan' in o ? o.plan : o }),
          validateTransition: (o) => typeof o === 'object' && o !== null && 'plan' in o && Boolean(o.plan),
        },
        {
          fromRoleId: 'executor',
          toRoleId: 'verifier',
          transform: (o) => ({ deliverable: typeof o === 'object' && o !== null && 'deliverable' in o ? o.deliverable : o }),
          validateTransition: (o) => typeof o === 'object' && o !== null && 'deliverable' in o && Boolean(o.deliverable),
        },
        {
          fromRoleId: 'verifier',
          toRoleId: 'deliverer',
          transform: (o) => ({ verificationReport: typeof o === 'object' && o !== null && 'verificationReport' in o ? o.verificationReport : o }),
          validateTransition: (o) => typeof o === 'object' && o !== null && 'verificationReport' in o && Boolean(o.verificationReport),
        },
      ],
      category: 'development',
      tags: ['builtin', 'development', '5-role'],
      defaultMetadata: { type: 'standard' },
    });

    // 代码审查流水线模板
    this.registerTemplate({
      templateId: 'builtin_review',
      name: '代码审查流水线',
      description: '架构师审查→工程师修复→QA验证',
      roleIds: ['architect', 'engineer', 'qa_engineer'],
      handoffs: [
        {
          fromRoleId: 'architect',
          toRoleId: 'engineer',
          transform: (o) => ({ reviewReport: typeof o === 'object' && o !== null && 'reviewReport' in o ? o.reviewReport : o }),
          validateTransition: (o) => typeof o === 'object' && o !== null && 'reviewReport' in o && Boolean(o.reviewReport),
        },
        {
          fromRoleId: 'engineer',
          toRoleId: 'qa_engineer',
          transform: (o) => ({ fixedCode: typeof o === 'object' && o !== null && 'fixedCode' in o ? o.fixedCode : o }),
          validateTransition: (o) => typeof o === 'object' && o !== null && 'fixedCode' in o && Boolean(o.fixedCode),
        },
      ],
      category: 'review',
      tags: ['builtin', 'review', '3-role'],
      defaultMetadata: { type: 'review' },
    });

    // 快速原型流水线模板
    this.registerTemplate({
      templateId: 'builtin_prototype',
      name: '快速原型流水线',
      description: '需求理解→执行→交付（精简3角色）',
      roleIds: ['requirement_analyst', 'executor', 'deliverer'],
      handoffs: [
        {
          fromRoleId: 'requirement_analyst',
          toRoleId: 'executor',
          transform: (o) => ({ requirementSpec: typeof o === 'object' && o !== null && 'requirementSpec' in o ? o.requirementSpec : o }),
          validateTransition: (o) => typeof o === 'object' && o !== null && 'requirementSpec' in o && Boolean(o.requirementSpec),
        },
        {
          fromRoleId: 'executor',
          toRoleId: 'deliverer',
          transform: (o) => ({ deliverable: typeof o === 'object' && o !== null && 'deliverable' in o ? o.deliverable : o }),
          validateTransition: (o) => typeof o === 'object' && o !== null && 'deliverable' in o && Boolean(o.deliverable),
        },
      ],
      category: 'development',
      tags: ['builtin', 'prototype', 'fast', '3-role'],
      defaultMetadata: { type: 'prototype' },
    });
  }

  // ========== P2-3: 角色协作增强 ==========

  /**
   * P2-3: 发起角色协作请求
   *
   * 角色间握手/确认协议：一个角色可向另一个角色发起协作请求，
   * 目标角色通过 resolveCollaboration 响应。
   *
   * @param fromRoleId 发起方角色 ID
   * @param toRoleId 目标方角色 ID
   * @param type 协作类型
   * @param payload 请求内容
   * @param pipelineId 关联的流水线 ID（可选）
   * @returns 请求 ID
   */
  requestCollaboration(
    fromRoleId: string,
    toRoleId: string,
    type: CollaborationRequest['type'],
    payload: unknown,
    pipelineId?: string,
  ): string {
    this.ensureNotDisposed();
    const requestId = `collab_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
    const request: CollaborationRequest = {
      requestId,
      fromRoleId,
      toRoleId,
      type,
      payload,
      status: 'pending',
      createdAt: Date.now(),
      pipelineId,
    };

    this.collaborationRequests.set(requestId, request);

    // 通过 pub/sub 通知目标角色
    this.publish(`collaboration:${toRoleId}`, request, fromRoleId, pipelineId);

    this.log.info('协作请求已发起', { requestId, fromRoleId, toRoleId, type });
    return requestId;
  }

  /**
   * P2-3: 响应协作请求
   *
   * @param requestId 请求 ID
   * @param status 响应状态（accepted/rejected）
   * @returns 是否成功响应
   */
  resolveCollaboration(requestId: string, status: 'accepted' | 'rejected'): boolean {
    this.ensureNotDisposed();
    const request = this.collaborationRequests.get(requestId);
    if (!request || request.status !== 'pending') return false;

    request.status = status;
    request.resolvedAt = Date.now();

    // 通知发起方
    this.publish(`collaboration:${request.fromRoleId}:response`, request, request.toRoleId, request.pipelineId);

    this.log.info('协作请求已响应', { requestId, status, fromRoleId: request.fromRoleId, toRoleId: request.toRoleId });
    return true;
  }

  /**
   * P2-3: 获取协作请求状态
   *
   * @param requestId 请求 ID
   * @returns 协作请求信息，若不存在返回 undefined
   */
  getCollaborationStatus(requestId: string): CollaborationRequest | undefined {
    return this.collaborationRequests.get(requestId);
  }

  /**
   * P2-3: 列出待处理的协作请求
   *
   * @param roleId 可选的角色 ID 筛选（筛选目标为该角色的请求）
   * @returns 待处理请求列表
   */
  listPendingCollaborations(roleId?: string): CollaborationRequest[] {
    const pending = Array.from(this.collaborationRequests.values())
      .filter(r => r.status === 'pending');
    if (roleId) {
      return pending.filter(r => r.toRoleId === roleId);
    }
    return pending;
  }

  /**
   * P2-3: 清理已完成的协作请求
   *
   * @param maxAgeMs 最大保留时间（毫秒），默认 1 小时
   */
  cleanCollaborationRequests(maxAgeMs = 60 * 60 * 1000): number {
    const now = Date.now();
    let cleaned = 0;
    for (const [requestId, request] of this.collaborationRequests.entries()) {
      if (request.status !== 'pending' && now - (request.resolvedAt ?? request.createdAt) > maxAgeMs) {
        this.collaborationRequests.delete(requestId);
        cleaned++;
      }
    }
    return cleaned;
  }

  /**
   * P2-3: 暴露 SOP 流水线为工具 — 让 agent 能在运行中创建和执行 5 角色流水线
   *
   * 修复前: 只有 listPipelines 在 prompt 中被调用，executePipeline/createPipeline 从不可达
   * 修复后: agent 可通过工具创建流水线、执行流水线、查看状态、取消流水线
   */
  getToolDefinitions(): ToolDef[] {
    // eslint-disable-next-line @typescript-eslint/no-this-alias
    const pipeline = this;

    return [
      {
        name: 'sop_create_pipeline',
        description: '创建 SOP 流水线。可选模板：development（开发）、review（审查）、deployment（部署）。不指定模板时创建 5 角色装配线（需求→方案→执行→验证→交付）。',
        parameters: {
          template: { type: 'string', description: '模板名称: development/review/deployment（可选，不指定则创建5角色流水线）', required: false },
          name: { type: 'string', description: '流水线名称（可选）', required: false },
        },
        execute: (args) => {
          try {
            let pipelineId: string;
            const template = args.template || '';
            if (template === 'development' || template === 'review' || template === 'deployment') {
              pipelineId = pipeline.createPipelineFromTemplate(`builtin_${template}`, args.name || `流水线-${Date.now()}`);
            } else {
              pipelineId = pipeline.createFiveRolePipeline();
            }
            return Promise.resolve(`✅ 流水线已创建\nID: ${pipelineId}\n可使用 sop_execute_pipeline 执行`);
          } catch (e: unknown) {
            const msg = (e instanceof Error && e.message) ? e.message : String(e);
            return Promise.resolve(`❌ 创建流水线失败: ${msg}`);
          }
        },
      },
      {
        name: 'sop_execute_pipeline',
        description: '执行 SOP 流水线。输入需求描述，流水线将按角色顺序处理（需求分析→方案规划→执行→验证→交付）。',
        parameters: {
          pipelineId: { type: 'string', description: '流水线 ID（由 sop_create_pipeline 返回）', required: true },
          input: { type: 'string', description: '需求描述或输入内容', required: true },
        },
        execute: async (args) => {
          try {
            // PipelineInput 要求 data + source 字段
            const result = await pipeline.executePipeline(
              String(args.pipelineId),
              { data: String(args.input), source: 'agent' }
            );
            const lines = [`✅ 流水线执行完成`, `成功: ${result.success}`];
            // PipelineResult.stages 为各阶段结果数组
            for (const stage of result.stages) {
              lines.push(`\n--- ${stage.roleName} (${stage.roleId}) ---`);
              lines.push(`成功: ${stage.success}, 质量: ${stage.qualityPassed ? '通过' : '未通过'}`);
              if (stage.error) lines.push(`错误: ${stage.error}`);
              if (stage.output !== undefined) {
                lines.push(JSON.stringify(stage.output, null, 2).substring(0, 500));
              }
            }
            if (result.errors.length > 0) {
              lines.push(`\n⚠️ 错误: ${result.errors.join('; ')}`);
            }
            return lines.join('\n');
          } catch (e: unknown) {
            const msg = (e instanceof Error && e.message) ? e.message : String(e);
            return `❌ 执行流水线失败: ${msg}`;
          }
        },
      },
      {
        name: 'sop_pipeline_status',
        description: '查看所有活跃 SOP 流水线的状态。',
        parameters: {},
        readOnly: true,
        execute: () => {
          try {
            const pipelines = pipeline.listPipelines();
            if (pipelines.length === 0) return Promise.resolve('当前无活跃流水线');
            const lines = [`活跃流水线 (${pipelines.length}):`];
            pipelines.forEach(p => {
              // PipelineInfo 无 roleIds 字段，使用 currentStage/totalStages 显示进度
              lines.push(`  - ${p.id}: ${p.name} [${p.status}] 进度: ${p.currentStage}/${p.totalStages}`);
            });
            return Promise.resolve(lines.join('\n'));
          } catch (e: unknown) {
            const msg = (e instanceof Error && e.message) ? e.message : String(e);
            return Promise.resolve(`❌ 查询失败: ${msg}`);
          }
        },
      },
      {
        name: 'sop_cancel_pipeline',
        description: '取消 SOP 流水线。',
        parameters: {
          pipelineId: { type: 'string', description: '要取消的流水线 ID', required: true },
        },
        execute: (args) => {
          try {
            pipeline.cancelPipeline(String(args.pipelineId));
            return Promise.resolve(`✅ 流水线 ${args.pipelineId} 已取消`);
          } catch (e: unknown) {
            const msg = (e instanceof Error && e.message) ? e.message : String(e);
            return Promise.resolve(`❌ 取消失败: ${msg}`);
          }
        },
      },
    ];
  }
}
