/**
 * 优化路线图与评分矩阵系统 — OptimizationRoadmap
 *
 * 核心设计原则（融合 OpenClaw / OpenCode / Codex / Trae CN / OpenAI Agents / Cursor / LibTV 最佳实践）：
 * 1. 多维评分矩阵：影响力(0-10) × 可行性(0-10) × 资源效率(0-10) × 战略对齐(0-10)
 * 2. 加权复合评分：Impact*0.35 + Feasibility*0.25 + (10-Resource)*0.20 + Alignment*0.20
 * 3. 四级优先级分层：P0(立即) / P1(高优) / P2(中优) / P3(长期)
 * 4. 四阶段里程碑：Week1-2 / Week3-4 / Week5-8 / Week9-12
 * 5. 来源溯源：每项优化可追溯到源工具的具体技术
 * 6. 实现规格生成：技术方案、依赖、测试计划、成功标准、风险缓解
 * 7. Agent Loop 工具 — 通过 getToolDefinitions() 注册为可用工具
 */

import { logger } from './structured-logger.js';
import { EventBus } from './event-bus.js';
import type { ToolDef } from './unified-tool-def.js';

// ============ 类型定义 ============

/** 优化项分类 */
export type OptimizationCategory =
  | 'nlu'
  | 'code_gen'
  | 'reasoning'
  | 'tool_integration'
  | 'context'
  | 'task_decomp'
  | 'interaction'
  | 'performance'
  | 'architecture';

/** 优先级 */
export type Priority = 'P0' | 'P1' | 'P2' | 'P3';

/** 优化项状态 */
export type OptimizationStatus = 'planned' | 'in_progress' | 'completed' | 'deferred';

/** 优化项 */
export interface OptimizationItem {
  id: string;
  title: string;
  description: string;
  category: OptimizationCategory;
  sourceTool: string;
  sourceTechnique: string;
  impact: number;
  feasibility: number;
  resourceRequired: number;
  strategicAlignment: number;
  compositeScore: number;
  priority: Priority;
  status: OptimizationStatus;
  dependencies: string[];
  estimatedEffort: string;
  successMetrics: string[];
  risks: string[];
}

/** 评分结果 */
export interface ScoredOptimization {
  itemId: string;
  scores: {
    impact: number;
    feasibility: number;
    resourceEfficiency: number;
    strategicAlignment: number;
  };
  compositeScore: number;
  priority: Priority;
  reasoning: string;
}

/** 里程碑 */
export interface Milestone {
  phase: string;
  name: string;
  timeframe: string;
  items: string[];
  objectives: string[];
  successCriteria: string[];
  deliverables: string[];
}

/** 来源分析 */
export interface SourceAnalysis {
  toolName: string;
  totalTechniques: number;
  adoptedTechniques: Array<{ name: string; status: string; ourImplementation: string }>;
  pendingTechniques: Array<{ name: string; reason: string; priority: string }>;
  competitiveAdvantage: string[];
  gaps: string[];
}

/** 实现规格 */
export interface ImplementationSpec {
  itemId: string;
  technicalApproach: string;
  dependencies: string[];
  implementationSteps: string[];
  testPlan: string[];
  successCriteria: string[];
  risks: Array<{ risk: string; mitigation: string }>;
  estimatedTimeline: string;
  requiredResources: string[];
}

/** 路线图数据 */
export interface OptimizationRoadmapData {
  items: OptimizationItem[];
  totalItems: number;
  byPriority: Record<Priority, number>;
  byCategory: Record<OptimizationCategory, number>;
  byStatus: Record<OptimizationStatus, number>;
  averageCompositeScore: number;
  lastUpdated: string;
}

/** 统计数据 */
export interface RoadmapStats {
  totalItems: number;
  completedItems: number;
  inProgressItems: number;
  plannedItems: number;
  deferredItems: number;
  averageImpact: number;
  averageFeasibility: number;
  averageResourceEfficiency: number;
  averageAlignment: number;
  averageCompositeScore: number;
  topCategory: OptimizationCategory;
  sourceDistribution: Record<string, number>;
  completionRate: number;
}


// ============ 评分权重常量 ============

const WEIGHT_IMPACT = 0.35;
const WEIGHT_FEASIBILITY = 0.25;
const WEIGHT_RESOURCE = 0.20;
const WEIGHT_ALIGNMENT = 0.20;

/** 优先级阈值 */
const PRIORITY_THRESHOLDS: { min: number; priority: Priority }[] = [
  { min: 7.5, priority: 'P0' },
  { min: 6.0, priority: 'P1' },
  { min: 4.5, priority: 'P2' },
  { min: 0, priority: 'P3' },
];

/** 分类中文标签 */
const CATEGORY_LABELS: Record<OptimizationCategory, string> = {
  nlu: '自然语言理解',
  code_gen: '代码生成',
  reasoning: '推理能力',
  tool_integration: '工具集成',
  context: '上下文管理',
  task_decomp: '任务分解',
  interaction: '交互体验',
  performance: '性能优化',
  architecture: '架构设计',
};

/** 优先级中文标签 */
const PRIORITY_LABELS: Record<Priority, string> = {
  P0: '立即执行',
  P1: '高优先级',
  P2: '中优先级',
  P3: '长期规划',
};

// ============ 主类 ============

export class OptimizationRoadmap {
  private log = logger.child({ module: 'OptimizationRoadmap' });
  private items: Map<string, OptimizationItem> = new Map();

  constructor() {
    this.initializeOptimizationItems();
    this.log.info('优化路线图初始化完成', { totalItems: this.items.size });
  }

  // ============ 初始化优化项 ============

  private initializeOptimizationItems(): void {
    const items: OptimizationItem[] = [
      // ===== P0: 立即执行 =====
      {
        id: 'opt-001',
        title: 'LSP实时诊断闭环',
        description: '将LSP诊断结果实时反馈到代码生成循环中，实现"生成-诊断-修复"自动闭环。借鉴OpenCode的LSP集成模式，在每次代码编辑后自动触发诊断，将错误信息注入上下文供下一轮修复。',
        category: 'code_gen',
        sourceTool: 'OpenCode',
        sourceTechnique: 'LSP Diagnostics Feedback Loop',
        impact: 9,
        feasibility: 8,
        resourceRequired: 4,
        strategicAlignment: 9,
        compositeScore: 0,
        priority: 'P0',
        status: 'planned',
        dependencies: [],
        estimatedEffort: '3 days',
        successMetrics: [
          '代码生成后诊断反馈延迟 < 200ms',
          '自动修复成功率 > 70%',
          '减少用户手动修复次数 50%',
        ],
        risks: ['LSP服务器启动延迟影响体验', '诊断结果噪声过多导致误修复'],
      },
      {
        id: 'opt-002',
        title: '两阶段权限分类器',
        description: '实现快速规则匹配+LLM深度判断的两阶段权限分类器。第一阶段用规则引擎处理明确的safe/dangerous操作，第二阶段对模糊操作调用LLM判断，兼顾安全与效率。借鉴Codex的权限模型。',
        category: 'architecture',
        sourceTool: 'Codex',
        sourceTechnique: 'Two-Stage Permission Classifier',
        impact: 9,
        feasibility: 7,
        resourceRequired: 3,
        strategicAlignment: 8,
        compositeScore: 0,
        priority: 'P0',
        status: 'planned',
        dependencies: [],
        estimatedEffort: '4 days',
        successMetrics: [
          '明确操作分类准确率 > 99%',
          '模糊操作分类准确率 > 90%',
          '平均权限判断延迟 < 50ms（规则阶段）',
        ],
        risks: ['规则引擎覆盖不足导致过多LLM调用', 'LLM判断不一致性'],
      },
      {
        id: 'opt-003',
        title: '5阶段渐进式压缩',
        description: '实现5阶段上下文压缩管线：摘要→关键信息提取→结构化→去重→语义压缩。每阶段保留核心语义同时减少Token消耗。借鉴OpenClaw的渐进式上下文管理策略。',
        category: 'context',
        sourceTool: 'OpenClaw',
        sourceTechnique: '5-Stage Progressive Compression',
        impact: 8,
        feasibility: 8,
        resourceRequired: 3,
        strategicAlignment: 9,
        compositeScore: 0,
        priority: 'P0',
        status: 'planned',
        dependencies: [],
        estimatedEffort: '5 days',
        successMetrics: [
          '上下文压缩率 > 60%',
          '关键信息保留率 > 95%',
          '压缩后任务完成率下降 < 5%',
        ],
        risks: ['过度压缩丢失关键上下文', '压缩管线延迟过高'],
      },
      {
        id: 'opt-004',
        title: '结构化输出强制约束',
        description: '通过JSON Schema约束LLM输出格式，确保工具调用参数、代码块、配置文件等输出的结构一致性。借鉴OpenAI Structured Output和Codex的输出约束模式，减少解析失败。',
        category: 'nlu',
        sourceTool: 'Codex',
        sourceTechnique: 'Structured Output Enforcement',
        impact: 8,
        feasibility: 9,
        resourceRequired: 2,
        strategicAlignment: 9,
        compositeScore: 0,
        priority: 'P0',
        status: 'planned',
        dependencies: [],
        estimatedEffort: '2 days',
        successMetrics: [
          '工具调用参数解析成功率 > 99%',
          '输出格式违规率 < 1%',
          '减少重试次数 80%',
        ],
        risks: ['过度约束限制创造性输出', 'Schema维护成本'],
      },
      {
        id: 'opt-005',
        title: '工具调用结果缓存',
        description: '对幂等工具调用结果进行智能缓存，相同参数直接返回缓存结果。支持TTL过期、LRU淘汰、依赖失效策略。借鉴LibTV的缓存策略和Cursor的计算缓存模式。',
        category: 'performance',
        sourceTool: 'LibTV',
        sourceTechnique: 'Tool Result Caching with Invalidation',
        impact: 7,
        feasibility: 9,
        resourceRequired: 2,
        strategicAlignment: 8,
        compositeScore: 0,
        priority: 'P0',
        status: 'planned',
        dependencies: [],
        estimatedEffort: '3 days',
        successMetrics: [
          '缓存命中率 > 40%',
          '平均工具调用延迟降低 50%',
          '缓存一致性保证 > 99.9%',
        ],
        risks: ['缓存失效策略不当导致脏数据', '内存占用过高'],
      },

      // ===== P1: 高优先级 =====
      {
        id: 'opt-006',
        title: 'Handoff交接机制',
        description: '实现Agent间的结构化交接协议，包含上下文摘要、未完成任务列表、关键决策记录。借鉴OpenAI Agents的Handoff机制，确保子Agent间信息无损传递。',
        category: 'architecture',
        sourceTool: 'OpenAI Agents',
        sourceTechnique: 'Structured Handoff Protocol',
        impact: 8,
        feasibility: 6,
        resourceRequired: 5,
        strategicAlignment: 8,
        compositeScore: 0,
        priority: 'P1',
        status: 'planned',
        dependencies: ['opt-003'],
        estimatedEffort: '1 week',
        successMetrics: [
          '交接后上下文完整性 > 90%',
          '交接延迟 < 500ms',
          '多Agent协作任务成功率提升 30%',
        ],
        risks: ['交接协议过于复杂', '上下文序列化丢失信息'],
      },
      {
        id: 'opt-007',
        title: 'Tree-sitter+向量混合检索',
        description: '结合Tree-sitter的精确AST解析与向量语义检索，实现代码库的混合检索系统。AST检索保证结构精确性，向量检索覆盖语义相似性。借鉴Cursor的混合检索架构。',
        category: 'context',
        sourceTool: 'Cursor',
        sourceTechnique: 'Tree-sitter + Vector Hybrid Retrieval',
        impact: 9,
        feasibility: 5,
        resourceRequired: 7,
        strategicAlignment: 9,
        compositeScore: 0,
        priority: 'P1',
        status: 'planned',
        dependencies: [],
        estimatedEffort: '2 weeks',
        successMetrics: [
          '代码检索准确率 > 85%',
          '检索延迟 < 300ms',
          '语义检索召回率 > 80%',
        ],
        risks: ['向量索引构建耗时', 'Tree-sitter语言支持覆盖度'],
      },
      {
        id: 'opt-008',
        title: 'Diff-based精确编辑',
        description: '实现基于Diff的精确代码编辑，替代整文件重写。生成最小化Diff补丁，只修改必要行，保留用户代码风格和未修改部分。借鉴Cursor的Diff编辑模式和Codex的精确补丁。',
        category: 'code_gen',
        sourceTool: 'Cursor',
        sourceTechnique: 'Diff-based Precise Editing',
        impact: 8,
        feasibility: 6,
        resourceRequired: 5,
        strategicAlignment: 7,
        compositeScore: 0,
        priority: 'P1',
        status: 'planned',
        dependencies: ['opt-004'],
        estimatedEffort: '1 week',
        successMetrics: [
          '编辑精确率 > 95%（只修改必要行）',
          '减少不必要代码变更 70%',
          '编辑冲突率 < 5%',
        ],
        risks: ['Diff生成不完整', '并发编辑冲突'],
      },
      {
        id: 'opt-009',
        title: 'Builder主动构建模式',
        description: '实现Builder模式下的主动代码构建：自动分析项目结构、识别缺失模块、主动生成代码骨架。借鉴Trae CN的Builder模式，从被动响应转向主动构建。',
        category: 'code_gen',
        sourceTool: 'Trae CN',
        sourceTechnique: 'Builder Proactive Construction',
        impact: 7,
        feasibility: 6,
        resourceRequired: 5,
        strategicAlignment: 8,
        compositeScore: 0,
        priority: 'P1',
        status: 'planned',
        dependencies: ['opt-007', 'opt-008'],
        estimatedEffort: '1 week',
        successMetrics: [
          '主动构建准确率 > 75%',
          '减少用户指令次数 40%',
          '项目初始化时间减少 60%',
        ],
        risks: ['主动构建方向错误导致返工', '过度生成无用代码'],
      },
      {
        id: 'opt-010',
        title: '双层Guardrail护栏',
        description: '实现输入/输出双层安全护栏：输入层过滤恶意指令和敏感数据，输出层审查代码安全性和内容合规性。借鉴OpenAI Agents的Guardrail机制，保障系统安全底线。',
        category: 'architecture',
        sourceTool: 'OpenAI Agents',
        sourceTechnique: 'Dual-Layer Guardrails',
        impact: 8,
        feasibility: 7,
        resourceRequired: 4,
        strategicAlignment: 9,
        compositeScore: 0,
        priority: 'P1',
        status: 'planned',
        dependencies: ['opt-002'],
        estimatedEffort: '5 days',
        successMetrics: [
          '恶意指令拦截率 > 99%',
          '敏感数据泄露率 < 0.1%',
          '误报率 < 5%',
        ],
        risks: ['护栏过严影响正常使用', '新型攻击绕过'],
      },
      {
        id: 'opt-011',
        title: '多步推理链验证',
        description: '对多步推理过程进行逐步验证，每步推理后检查逻辑一致性和事实准确性。借鉴OpenCode的推理验证和Codex的逐步确认模式，减少推理链错误累积。',
        category: 'reasoning',
        sourceTool: 'OpenCode',
        sourceTechnique: 'Multi-Step Reasoning Chain Verification',
        impact: 8,
        feasibility: 7,
        resourceRequired: 4,
        strategicAlignment: 8,
        compositeScore: 0,
        priority: 'P1',
        status: 'planned',
        dependencies: [],
        estimatedEffort: '5 days',
        successMetrics: [
          '推理链错误检出率 > 80%',
          '推理准确率提升 25%',
          '验证延迟 < 100ms/步',
        ],
        risks: ['验证步骤过多影响效率', '验证本身引入错误'],
      },
      {
        id: 'opt-012',
        title: '自适应Prompt优化',
        description: '根据任务类型、模型能力和历史效果自动优化Prompt。包括指令重排、示例选择、约束注入等策略。借鉴Trae CN的Prompt优化和OpenAI的最佳实践。',
        category: 'nlu',
        sourceTool: 'Trae CN',
        sourceTechnique: 'Adaptive Prompt Optimization',
        impact: 7,
        feasibility: 7,
        resourceRequired: 4,
        strategicAlignment: 8,
        compositeScore: 0,
        priority: 'P1',
        status: 'planned',
        dependencies: [],
        estimatedEffort: '4 days',
        successMetrics: [
          'Prompt优化后任务完成率提升 15%',
          'Token消耗减少 20%',
          '优化决策延迟 < 50ms',
        ],
        risks: ['优化策略与特定任务不匹配', '过度优化导致通用性下降'],
      },

      // ===== P2: 中优先级 =====
      {
        id: 'opt-013',
        title: '多模型路由架构',
        description: '实现基于任务复杂度、成本预算和延迟要求的智能模型路由。简单任务用轻量模型，复杂推理用强模型，平衡效果与成本。借鉴Trae CN的多模型策略。',
        category: 'architecture',
        sourceTool: 'Trae CN',
        sourceTechnique: 'Multi-Model Routing Architecture',
        impact: 7,
        feasibility: 5,
        resourceRequired: 6,
        strategicAlignment: 7,
        compositeScore: 0,
        priority: 'P2',
        status: 'planned',
        dependencies: ['opt-012'],
        estimatedEffort: '2 weeks',
        successMetrics: [
          '模型选择准确率 > 85%',
          '平均推理成本降低 30%',
          '任务质量下降 < 5%',
        ],
        risks: ['路由判断错误导致质量下降', '模型API不稳定'],
      },
      {
        id: 'opt-014',
        title: '.cursorrules项目配置',
        description: '支持项目级配置文件（类似.cursorrules），定义项目特定的代码风格、架构约束、工具偏好等。确保AI行为与项目规范一致。借鉴Cursor的项目配置模式。',
        category: 'interaction',
        sourceTool: 'Cursor',
        sourceTechnique: 'Project-Level Configuration (.cursorrules)',
        impact: 6,
        feasibility: 8,
        resourceRequired: 2,
        strategicAlignment: 7,
        compositeScore: 0,
        priority: 'P2',
        status: 'planned',
        dependencies: [],
        estimatedEffort: '2 days',
        successMetrics: [
          '项目配置加载成功率 > 99%',
          '配置规则遵循率 > 90%',
          '支持配置项 > 20种',
        ],
        risks: ['配置冲突处理复杂', '配置文件格式不统一'],
      },
      {
        id: 'opt-015',
        title: '任务依赖图自动构建',
        description: '自动分析任务间的依赖关系，构建DAG依赖图，支持并行执行无依赖子任务。借鉴OpenClaw的任务编排和Codex的依赖分析。',
        category: 'task_decomp',
        sourceTool: 'OpenClaw',
        sourceTechnique: 'Automatic Task Dependency Graph',
        impact: 7,
        feasibility: 6,
        resourceRequired: 5,
        strategicAlignment: 7,
        compositeScore: 0,
        priority: 'P2',
        status: 'planned',
        dependencies: ['opt-006'],
        estimatedEffort: '1 week',
        successMetrics: [
          '依赖关系识别准确率 > 85%',
          '并行执行加速比 > 1.5x',
          '死锁检测率 100%',
        ],
        risks: ['循环依赖检测遗漏', '依赖关系过于复杂'],
      },
      {
        id: 'opt-016',
        title: '代码变更影响分析',
        description: '在代码修改前自动分析变更影响范围，识别可能受影响的模块、测试和API。借鉴Cursor的变更影响分析和OpenCode的代码理解。',
        category: 'reasoning',
        sourceTool: 'Cursor',
        sourceTechnique: 'Code Change Impact Analysis',
        impact: 7,
        feasibility: 5,
        resourceRequired: 6,
        strategicAlignment: 7,
        compositeScore: 0,
        priority: 'P2',
        status: 'planned',
        dependencies: ['opt-007'],
        estimatedEffort: '1 week',
        successMetrics: [
          '影响范围预测准确率 > 80%',
          '漏报率 < 10%',
          '分析延迟 < 2s',
        ],
        risks: ['大型代码库分析耗时', '间接影响难以追踪'],
      },
      {
        id: 'opt-017',
        title: '对话意图追踪器',
        description: '追踪多轮对话中的意图演变，检测意图偏移和回归，维护意图栈。借鉴OpenAI Agents的对话管理和Trae CN的上下文追踪。',
        category: 'nlu',
        sourceTool: 'OpenAI Agents',
        sourceTechnique: 'Conversation Intent Tracker',
        impact: 6,
        feasibility: 7,
        resourceRequired: 4,
        strategicAlignment: 7,
        compositeScore: 0,
        priority: 'P2',
        status: 'planned',
        dependencies: ['opt-003'],
        estimatedEffort: '4 days',
        successMetrics: [
          '意图识别准确率 > 85%',
          '意图偏移检测延迟 < 200ms',
          '多轮对话一致性提升 25%',
        ],
        risks: ['意图模糊地带处理困难', '意图栈过深'],
      },
      {
        id: 'opt-018',
        title: '增量式知识图谱',
        description: '构建项目级增量知识图谱，实时更新代码实体关系、API调用链、数据流向。支持语义查询和影响分析。借鉴LibTV的知识图谱和OpenClaw的上下文图谱。',
        category: 'context',
        sourceTool: 'LibTV',
        sourceTechnique: 'Incremental Knowledge Graph',
        impact: 7,
        feasibility: 4,
        resourceRequired: 7,
        strategicAlignment: 8,
        compositeScore: 0,
        priority: 'P2',
        status: 'planned',
        dependencies: ['opt-007'],
        estimatedEffort: '2 weeks',
        successMetrics: [
          '图谱构建覆盖率 > 80%',
          '增量更新延迟 < 1s',
          '语义查询准确率 > 75%',
        ],
        risks: ['图谱构建资源消耗大', '增量更新一致性'],
      },
      {
        id: 'opt-019',
        title: '工具组合编排引擎',
        description: '支持工具的自动组合与编排，将复杂任务分解为工具调用链。支持条件分支、并行执行、错误恢复。借鉴OpenClaw的工具编排和Codex的管道模式。',
        category: 'tool_integration',
        sourceTool: 'OpenClaw',
        sourceTechnique: 'Tool Composition Orchestration Engine',
        impact: 7,
        feasibility: 5,
        resourceRequired: 6,
        strategicAlignment: 7,
        compositeScore: 0,
        priority: 'P2',
        status: 'planned',
        dependencies: ['opt-015'],
        estimatedEffort: '1 week',
        successMetrics: [
          '工具组合成功率 > 85%',
          '编排执行延迟 < 100ms开销',
          '错误恢复率 > 80%',
        ],
        risks: ['工具接口不兼容', '编排逻辑过于复杂'],
      },
      {
        id: 'opt-020',
        title: '实时性能剖析器',
        description: '实时剖析Agent Loop各阶段性能，识别瓶颈并自动优化。包括LLM推理延迟、工具调用耗时、上下文处理时间。借鉴LibTV的性能监控和OpenCode的诊断。',
        category: 'performance',
        sourceTool: 'LibTV',
        sourceTechnique: 'Real-Time Performance Profiler',
        impact: 6,
        feasibility: 7,
        resourceRequired: 3,
        strategicAlignment: 7,
        compositeScore: 0,
        priority: 'P2',
        status: 'planned',
        dependencies: [],
        estimatedEffort: '3 days',
        successMetrics: [
          '性能数据采集开销 < 2%',
          '瓶颈识别准确率 > 90%',
          '自动优化建议采纳率 > 60%',
        ],
        risks: ['剖析本身影响性能', '性能数据噪声'],
      },

      // ===== P3: 长期规划 =====
      {
        id: 'opt-021',
        title: '跨会话记忆持久化',
        description: '实现跨会话的长期记忆持久化，保留用户偏好、项目知识、历史决策。支持记忆检索、遗忘和更新。借鉴Trae CN的会话持久化和OpenAI Agents的状态管理。',
        category: 'context',
        sourceTool: 'Trae CN',
        sourceTechnique: 'Cross-Session Memory Persistence',
        impact: 6,
        feasibility: 6,
        resourceRequired: 5,
        strategicAlignment: 7,
        compositeScore: 0,
        priority: 'P3',
        status: 'planned',
        dependencies: ['opt-003', 'opt-018'],
        estimatedEffort: '1 week',
        successMetrics: [
          '记忆检索准确率 > 80%',
          '跨会话任务连续性提升 40%',
          '记忆存储开销 < 100MB/项目',
        ],
        risks: ['隐私合规问题', '记忆过时导致错误决策'],
      },
      {
        id: 'opt-022',
        title: '自适应交互风格',
        description: '根据用户技术水平和偏好自动调整交互风格：专家模式简洁精确，新手模式详细引导。借鉴Trae CN的自适应交互和Cursor的用户画像。',
        category: 'interaction',
        sourceTool: 'Trae CN',
        sourceTechnique: 'Adaptive Interaction Style',
        impact: 5,
        feasibility: 7,
        resourceRequired: 4,
        strategicAlignment: 6,
        compositeScore: 0,
        priority: 'P3',
        status: 'planned',
        dependencies: ['opt-017'],
        estimatedEffort: '4 days',
        successMetrics: [
          '用户满意度提升 20%',
          '交互轮次减少 15%',
          '风格切换延迟 < 100ms',
        ],
        risks: ['用户画像不准确', '风格切换不自然'],
      },
      {
        id: 'opt-023',
        title: '多Agent协作框架',
        description: '实现多Agent协作框架，支持角色分配、任务分发、结果聚合。包含协调者、执行者、审查者等角色。借鉴OpenAI Agents的多Agent模式和OpenClaw的团队协作。',
        category: 'architecture',
        sourceTool: 'OpenAI Agents',
        sourceTechnique: 'Multi-Agent Collaboration Framework',
        impact: 7,
        feasibility: 4,
        resourceRequired: 8,
        strategicAlignment: 7,
        compositeScore: 0,
        priority: 'P3',
        status: 'planned',
        dependencies: ['opt-006', 'opt-019'],
        estimatedEffort: '3 weeks',
        successMetrics: [
          '多Agent协作任务成功率 > 80%',
          '协作开销 < 20%',
          '冲突解决率 > 90%',
        ],
        risks: ['Agent间通信开销', '协作死锁', '结果聚合困难'],
      },
      {
        id: 'opt-024',
        title: '可视化调试界面',
        description: '提供Agent Loop的可视化调试界面，展示推理链、工具调用、上下文状态。支持断点、回放、单步执行。借鉴Cursor的调试可视化和OpenCode的追踪。',
        category: 'interaction',
        sourceTool: 'Cursor',
        sourceTechnique: 'Visual Debugging Interface',
        impact: 5,
        feasibility: 4,
        resourceRequired: 7,
        strategicAlignment: 5,
        compositeScore: 0,
        priority: 'P3',
        status: 'planned',
        dependencies: ['opt-020'],
        estimatedEffort: '2 weeks',
        successMetrics: [
          '调试效率提升 50%',
          '问题定位时间减少 60%',
          '界面响应延迟 < 100ms',
        ],
        risks: ['开发成本高', '终端环境适配困难'],
      },
      {
        id: 'opt-025',
        title: '自进化反馈闭环',
        description: '实现从用户反馈到系统自进化的完整闭环：收集反馈→分析模式→生成改进→A/B测试→自动部署。借鉴LibTV的自优化和OpenClaw的持续学习。',
        category: 'performance',
        sourceTool: 'LibTV',
        sourceTechnique: 'Self-Evolution Feedback Loop',
        impact: 6,
        feasibility: 4,
        resourceRequired: 7,
        strategicAlignment: 7,
        compositeScore: 0,
        priority: 'P3',
        status: 'planned',
        dependencies: ['opt-020', 'opt-021'],
        estimatedEffort: '2 weeks',
        successMetrics: [
          '反馈到改进周期 < 1天',
          '自进化改进成功率 > 60%',
          '退化率 < 5%',
        ],
        risks: ['自进化方向失控', 'A/B测试样本不足', '退化风险'],
      },
      {
        id: 'opt-026',
        title: '语义化代码搜索',
        description: '基于自然语言描述搜索代码，结合语义理解和代码结构分析。支持"找到处理用户认证的函数"等自然语言查询。借鉴Cursor的语义搜索和OpenCode的代码理解。',
        category: 'context',
        sourceTool: 'Cursor',
        sourceTechnique: 'Semantic Code Search',
        impact: 6,
        feasibility: 5,
        resourceRequired: 5,
        strategicAlignment: 6,
        compositeScore: 0,
        priority: 'P2',
        status: 'planned',
        dependencies: ['opt-007'],
        estimatedEffort: '1 week',
        successMetrics: [
          '语义搜索准确率 > 75%',
          '搜索延迟 < 500ms',
          '用户查询理解率 > 85%',
        ],
        risks: ['语义理解偏差', '大型代码库索引耗时'],
      },
      {
        id: 'opt-027',
        title: '智能错误恢复策略',
        description: '根据错误类型自动选择恢复策略：重试、降级、替代方案、回滚。维护错误模式知识库，持续优化恢复策略。借鉴Codex的错误恢复和OpenClaw的自愈机制。',
        category: 'tool_integration',
        sourceTool: 'Codex',
        sourceTechnique: 'Intelligent Error Recovery Strategy',
        impact: 7,
        feasibility: 6,
        resourceRequired: 4,
        strategicAlignment: 7,
        compositeScore: 0,
        priority: 'P1',
        status: 'planned',
        dependencies: [],
        estimatedEffort: '4 days',
        successMetrics: [
          '错误自动恢复率 > 70%',
          '恢复后任务成功率 > 85%',
          '平均恢复时间 < 3s',
        ],
        risks: ['恢复策略选择错误', '恢复过程引入新错误'],
      },
      {
        id: 'opt-028',
        title: '上下文感知工具推荐',
        description: '根据当前任务上下文和对话历史，智能推荐最合适的工具和参数。减少用户工具选择负担，提升工具使用效率。借鉴Trae CN的智能推荐和Cursor的上下文感知。',
        category: 'tool_integration',
        sourceTool: 'Trae CN',
        sourceTechnique: 'Context-Aware Tool Recommendation',
        impact: 6,
        feasibility: 7,
        resourceRequired: 3,
        strategicAlignment: 7,
        compositeScore: 0,
        priority: 'P2',
        status: 'planned',
        dependencies: ['opt-017'],
        estimatedEffort: '3 days',
        successMetrics: [
          '工具推荐准确率 > 80%',
          '工具选择时间减少 50%',
          '推荐采纳率 > 60%',
        ],
        risks: ['推荐干扰用户决策', '上下文理解偏差'],
      },
      {
        id: 'opt-029',
        title: '代码风格一致性检查',
        description: '自动检测和修复代码风格不一致问题，基于项目配置和社区最佳实践。支持ESLint/Prettier集成和自定义规则。借鉴Cursor的代码风格检查和Codex的代码规范。',
        category: 'code_gen',
        sourceTool: 'Cursor',
        sourceTechnique: 'Code Style Consistency Check',
        impact: 5,
        feasibility: 8,
        resourceRequired: 2,
        strategicAlignment: 6,
        compositeScore: 0,
        priority: 'P2',
        status: 'planned',
        dependencies: ['opt-014'],
        estimatedEffort: '2 days',
        successMetrics: [
          '风格问题检出率 > 90%',
          '自动修复率 > 80%',
          '误报率 < 5%',
        ],
        risks: ['风格规则冲突', '自动修复引入新问题'],
      },
      {
        id: 'opt-030',
        title: '分层抽象推理框架',
        description: '实现分层抽象推理：战略层(目标规划)→战术层(方案设计)→执行层(具体操作)。每层独立推理，层间通过结构化接口通信。借鉴OpenAI Agents的分层推理和Codex的多层规划。',
        category: 'reasoning',
        sourceTool: 'OpenAI Agents',
        sourceTechnique: 'Hierarchical Abstract Reasoning Framework',
        impact: 7,
        feasibility: 4,
        resourceRequired: 7,
        strategicAlignment: 8,
        compositeScore: 0,
        priority: 'P3',
        status: 'planned',
        dependencies: ['opt-011', 'opt-015'],
        estimatedEffort: '2 weeks',
        successMetrics: [
          '复杂任务分解准确率 > 80%',
          '分层推理效率提升 30%',
          '层间通信开销 < 10%',
        ],
        risks: ['层次划分不合理', '层间信息丢失', '推理链过长'],
      },
    ];

    // 计算复合评分和优先级
    for (const item of items) {
      const scored = this.scoreOptimization(item);
      item.compositeScore = scored.compositeScore;
      item.priority = scored.priority;
      this.items.set(item.id, item);
    }
  }

  // ============ 核心方法 ============

  /**
   * 使用评分矩阵对优化项评分
   */
  scoreOptimization(item: OptimizationItem): ScoredOptimization {
    const resourceEfficiency = 10 - item.resourceRequired;
    const compositeScore =
      item.impact * WEIGHT_IMPACT +
      item.feasibility * WEIGHT_FEASIBILITY +
      resourceEfficiency * WEIGHT_RESOURCE +
      item.strategicAlignment * WEIGHT_ALIGNMENT;

    const roundedScore = Math.round(compositeScore * 100) / 100;

    // 确定优先级
    let priority: Priority = 'P3';
    for (const threshold of PRIORITY_THRESHOLDS) {
      if (roundedScore >= threshold.min) {
        priority = threshold.priority;
        break;
      }
    }

    // 生成评分推理说明
    const reasoning = this.generateScoreReasoning(item, roundedScore, priority);

    return {
      itemId: item.id,
      scores: {
        impact: item.impact,
        feasibility: item.feasibility,
        resourceEfficiency,
        strategicAlignment: item.strategicAlignment,
      },
      compositeScore: roundedScore,
      priority,
      reasoning,
    };
  }

  /**
   * 生成评分推理说明
   */
  private generateScoreReasoning(item: OptimizationItem, score: number, priority: Priority): string {
    const parts: string[] = [];
    parts.push(`综合评分 ${score}，优先级 ${priority}（${PRIORITY_LABELS[priority]}）。`);

    if (item.impact >= 8) {
      parts.push(`影响力突出(${item.impact}/10)，对系统核心能力有显著提升。`);
    } else if (item.impact >= 6) {
      parts.push(`影响力中等(${item.impact}/10)，对特定场景有明显改善。`);
    } else {
      parts.push(`影响力有限(${item.impact}/10)，属于锦上添花型优化。`);
    }

    if (item.feasibility >= 8) {
      parts.push(`可行性高(${item.feasibility}/10)，技术方案成熟，实施风险低。`);
    } else if (item.feasibility >= 6) {
      parts.push(`可行性中等(${item.feasibility}/10)，需要一定技术攻关。`);
    } else {
      parts.push(`可行性较低(${item.feasibility}/10)，存在技术挑战。`);
    }

    if (item.resourceRequired <= 3) {
      parts.push(`资源需求低(${item.resourceRequired}/10)，投入产出比优秀。`);
    } else if (item.resourceRequired <= 5) {
      parts.push(`资源需求中等(${item.resourceRequired}/10)，需要合理规划。`);
    } else {
      parts.push(`资源需求高(${item.resourceRequired}/10)，需要充分评估。`);
    }

    parts.push(`来源: ${item.sourceTool} 的 ${item.sourceTechnique}。`);

    return parts.join('');
  }

  /**
   * 获取完整路线图
   */
  getRoadmap(): OptimizationRoadmapData {
    const items = Array.from(this.items.values());
    const byPriority: Record<Priority, number> = { P0: 0, P1: 0, P2: 0, P3: 0 };
    const byCategory: Record<OptimizationCategory, number> = {
      nlu: 0, code_gen: 0, reasoning: 0, tool_integration: 0,
      context: 0, task_decomp: 0, interaction: 0, performance: 0, architecture: 0,
    };
    const byStatus: Record<OptimizationStatus, number> = {
      planned: 0, in_progress: 0, completed: 0, deferred: 0,
    };

    let totalScore = 0;
    for (const item of items) {
      byPriority[item.priority]++;
      byCategory[item.category]++;
      byStatus[item.status]++;
      totalScore += item.compositeScore;
    }

    const data: OptimizationRoadmapData = {
      items,
      totalItems: items.length,
      byPriority,
      byCategory,
      byStatus,
      averageCompositeScore: items.length > 0 ? Math.round((totalScore / items.length) * 100) / 100 : 0,
      lastUpdated: new Date().toISOString(),
    };

    EventBus.getInstance().emitSync('roadmap.viewed', {
      source: 'OptimizationRoadmap',
      data: { totalItems: data.totalItems },
    });

    return data;
  }

  /**
   * 获取按复合评分排序的优先级列表
   */
  getPrioritizedList(): ScoredOptimization[] {
    const items = Array.from(this.items.values());
    const scored = items.map(item => this.scoreOptimization(item));
    scored.sort((a, b) => b.compositeScore - a.compositeScore);

    EventBus.getInstance().emitSync('roadmap.prioritized', {
      source: 'OptimizationRoadmap',
      data: { count: scored.length },
    });

    return scored;
  }

  /**
   * 获取分阶段里程碑
   */
  getMilestones(): Milestone[] {
    const items = Array.from(this.items.values());

    const p0Items = items.filter(i => i.priority === 'P0').map(i => i.id);
    const p1Items = items.filter(i => i.priority === 'P1').map(i => i.id);
    const p2Items = items.filter(i => i.priority === 'P2').map(i => i.id);
    const p3Items = items.filter(i => i.priority === 'P3').map(i => i.id);

    const milestones: Milestone[] = [
      {
        phase: 'Phase 1',
        name: '基础能力夯实',
        timeframe: 'Week 1-2',
        items: p0Items,
        objectives: [
          '建立代码生成-诊断-修复闭环',
          '实现两阶段权限安全体系',
          '完成上下文压缩管线',
          '确保输出结构一致性',
          '建立工具调用缓存层',
        ],
        successCriteria: [
          'LSP诊断闭环延迟 < 200ms',
          '权限分类准确率 > 95%',
          '上下文压缩率 > 60%',
          '工具调用解析成功率 > 99%',
          '缓存命中率 > 40%',
        ],
        deliverables: [
          'LSP集成模块',
          '权限分类器模块',
          '5阶段压缩管线',
          '结构化输出约束模块',
          '工具缓存层',
        ],
      },
      {
        phase: 'Phase 2',
        name: '核心能力增强',
        timeframe: 'Week 3-4',
        items: p1Items,
        objectives: [
          '实现Agent间结构化交接',
          '建立混合代码检索系统',
          '实现精确Diff编辑',
          '构建主动代码生成模式',
          '部署双层安全护栏',
          '验证多步推理链',
          '优化Prompt自适应',
          '实现智能错误恢复',
        ],
        successCriteria: [
          '交接上下文完整性 > 90%',
          '代码检索准确率 > 85%',
          '编辑精确率 > 95%',
          '恶意指令拦截率 > 99%',
          '推理链错误检出率 > 80%',
          '错误自动恢复率 > 70%',
        ],
        deliverables: [
          'Handoff交接协议模块',
          '混合检索引擎',
          'Diff编辑引擎',
          'Builder模式模块',
          'Guardrail护栏模块',
          '推理验证模块',
          'Prompt优化器',
          '错误恢复策略模块',
        ],
      },
      {
        phase: 'Phase 3',
        name: '智能能力拓展',
        timeframe: 'Week 5-8',
        items: p2Items,
        objectives: [
          '实现多模型智能路由',
          '支持项目级配置',
          '构建任务依赖图',
          '实现变更影响分析',
          '追踪对话意图演变',
          '构建增量知识图谱',
          '编排工具组合调用',
          '部署性能剖析器',
          '实现语义代码搜索',
          '上下文感知工具推荐',
          '代码风格一致性检查',
        ],
        successCriteria: [
          '模型路由准确率 > 85%',
          '依赖图构建准确率 > 85%',
          '影响分析准确率 > 80%',
          '知识图谱覆盖率 > 80%',
          '工具组合成功率 > 85%',
          '语义搜索准确率 > 75%',
        ],
        deliverables: [
          '模型路由器',
          '项目配置系统',
          '任务依赖图引擎',
          '影响分析模块',
          '意图追踪器',
          '知识图谱模块',
          '工具编排引擎',
          '性能剖析器',
          '语义搜索引擎',
          '工具推荐模块',
          '风格检查模块',
        ],
      },
      {
        phase: 'Phase 4',
        name: '生态能力完善',
        timeframe: 'Week 9-12',
        items: p3Items,
        objectives: [
          '实现跨会话记忆持久化',
          '自适应交互风格',
          '多Agent协作框架',
          '可视化调试界面',
          '自进化反馈闭环',
          '分层抽象推理框架',
        ],
        successCriteria: [
          '记忆检索准确率 > 80%',
          '多Agent协作成功率 > 80%',
          '自进化改进成功率 > 60%',
          '分层推理效率提升 30%',
        ],
        deliverables: [
          '记忆持久化模块',
          '交互风格适配器',
          '多Agent协作框架',
          '可视化调试器',
          '自进化引擎',
          '分层推理框架',
        ],
      },
    ];

    EventBus.getInstance().emitSync('roadmap.milestones_viewed', {
      source: 'OptimizationRoadmap',
      data: { phases: milestones.length },
    });

    return milestones;
  }

  /**
   * 获取源工具分析
   */
  getSourceAnalysis(toolName: string): SourceAnalysis {
    const items = Array.from(this.items.values()).filter(i => i.sourceTool === toolName);

    if (items.length === 0) {
      return {
        toolName,
        totalTechniques: 0,
        adoptedTechniques: [],
        pendingTechniques: [],
        competitiveAdvantage: [],
        gaps: [],
      };
    }

    // 已采纳技术：状态为 completed 或 in_progress
    const adoptedTechniques = items
      .filter(i => i.status === 'completed' || i.status === 'in_progress')
      .map(i => ({
        name: i.sourceTechnique,
        status: i.status,
        ourImplementation: i.title,
      }));

    // 待采纳技术：状态为 planned 或 deferred
    const pendingTechniques = items
      .filter(i => i.status === 'planned' || i.status === 'deferred')
      .map(i => ({
        name: i.sourceTechnique,
        reason: i.status === 'deferred' ? '资源限制或优先级调整' : '待实施',
        priority: i.priority,
      }));

    // 竞争优势：我们已实现且评分高的技术
    const competitiveAdvantage = items
      .filter(i => i.compositeScore >= 7.0 && (i.status === 'completed' || i.status === 'in_progress'))
      .map(i => `${i.sourceTechnique}（评分: ${i.compositeScore}）`);

    // 差距：高影响但未实施的技术
    const gaps = items
      .filter(i => i.impact >= 7 && i.status === 'planned')
      .map(i => `${i.sourceTechnique}（影响: ${i.impact}/10，状态: 待实施）`);

    const analysis: SourceAnalysis = {
      toolName,
      totalTechniques: items.length,
      adoptedTechniques,
      pendingTechniques,
      competitiveAdvantage,
      gaps,
    };

    EventBus.getInstance().emitSync('roadmap.source_analyzed', {
      source: 'OptimizationRoadmap',
      data: { toolName, techniqueCount: items.length },
    });

    return analysis;
  }

  /**
   * 生成实现规格
   */
  generateImplementationSpec(itemId: string): ImplementationSpec | null {
    const item = this.items.get(itemId);
    if (!item) {
      this.log.warn('未找到优化项', { itemId });
      return null;
    }

    // 解析依赖项标题
    const depItems = item.dependencies
      .map(depId => this.items.get(depId))
      .filter((d): d is OptimizationItem => d !== undefined);

    // 生成实现步骤
    const implementationSteps = this.generateImplementationSteps(item);

    // 生成测试计划
    const testPlan = this.generateTestPlan(item);

    // 生成风险缓解
    const risks = item.risks.map(risk => ({
      risk,
      mitigation: this.generateRiskMitigation(risk),
    }));

    // 估算所需资源
    const requiredResources = this.generateRequiredResources(item);

    const spec: ImplementationSpec = {
      itemId: item.id,
      technicalApproach: this.generateTechnicalApproach(item),
      dependencies: depItems.map(d => `${d.id}: ${d.title}`),
      implementationSteps,
      testPlan,
      successCriteria: item.successMetrics,
      risks,
      estimatedTimeline: item.estimatedEffort,
      requiredResources,
    };

    EventBus.getInstance().emitSync('roadmap.spec_generated', {
      source: 'OptimizationRoadmap',
      data: { itemId, category: item.category },
    });

    return spec;
  }

  /**
   * 获取统计数据
   */
  getStats(): RoadmapStats {
    const items = Array.from(this.items.values());
    if (items.length === 0) {
      return {
        totalItems: 0,
        completedItems: 0,
        inProgressItems: 0,
        plannedItems: 0,
        deferredItems: 0,
        averageImpact: 0,
        averageFeasibility: 0,
        averageResourceEfficiency: 0,
        averageAlignment: 0,
        averageCompositeScore: 0,
        topCategory: 'nlu',
        sourceDistribution: {},
        completionRate: 0,
      };
    }

    const completedItems = items.filter(i => i.status === 'completed').length;
    const inProgressItems = items.filter(i => i.status === 'in_progress').length;
    const plannedItems = items.filter(i => i.status === 'planned').length;
    const deferredItems = items.filter(i => i.status === 'deferred').length;

    const avg = (arr: number[]) => Math.round((arr.reduce((s, v) => s + v, 0) / arr.length) * 100) / 100;

    // 按分类统计，找出最多的分类
    const categoryCount: Record<OptimizationCategory, number> = {
      nlu: 0, code_gen: 0, reasoning: 0, tool_integration: 0,
      context: 0, task_decomp: 0, interaction: 0, performance: 0, architecture: 0,
    };
    for (const item of items) {
      categoryCount[item.category]++;
    }
    const topCategory = (Object.entries(categoryCount) as [OptimizationCategory, number][])
      .sort((a, b) => b[1] - a[1])[0][0];

    // 来源分布
    const sourceDistribution: Record<string, number> = {};
    for (const item of items) {
      sourceDistribution[item.sourceTool] = (sourceDistribution[item.sourceTool] || 0) + 1;
    }

    return {
      totalItems: items.length,
      completedItems,
      inProgressItems,
      plannedItems,
      deferredItems,
      averageImpact: avg(items.map(i => i.impact)),
      averageFeasibility: avg(items.map(i => i.feasibility)),
      averageResourceEfficiency: avg(items.map(i => 10 - i.resourceRequired)),
      averageAlignment: avg(items.map(i => i.strategicAlignment)),
      averageCompositeScore: avg(items.map(i => i.compositeScore)),
      topCategory,
      sourceDistribution,
      completionRate: Math.round((completedItems / items.length) * 100),
    };
  }

  // ============ 辅助方法 ============

  /**
   * 生成技术方案描述
   */
  private generateTechnicalApproach(item: OptimizationItem): string {
    const approachMap: Record<OptimizationCategory, string> = {
      nlu: `基于${item.sourceTool}的${item.sourceTechnique}，构建自然语言理解增强模块。采用规则引擎+深度学习混合方案，在保证推理速度的同时提升理解准确率。`,
      code_gen: `基于${item.sourceTool}的${item.sourceTechnique}，实现代码生成优化模块。采用多阶段生成管线：需求分析→方案设计→代码生成→质量验证，确保生成代码的准确性和一致性。`,
      reasoning: `基于${item.sourceTool}的${item.sourceTechnique}，构建推理能力增强模块。采用链式推理+逐步验证策略，在推理过程中实时检查逻辑一致性。`,
      tool_integration: `基于${item.sourceTool}的${item.sourceTechnique}，实现工具集成优化模块。采用声明式工具注册+动态编排架构，支持工具的自动发现、组合和容错。`,
      context: `基于${item.sourceTool}的${item.sourceTechnique}，构建上下文管理优化模块。采用分层存储+渐进压缩策略，在有限Token预算内最大化有效信息保留。`,
      task_decomp: `基于${item.sourceTool}的${item.sourceTechnique}，实现任务分解优化模块。采用递归分解+依赖图构建策略，支持任务的并行执行和动态调整。`,
      interaction: `基于${item.sourceTool}的${item.sourceTechnique}，构建交互体验优化模块。采用用户画像+自适应策略，根据上下文动态调整交互方式。`,
      performance: `基于${item.sourceTool}的${item.sourceTechnique}，实现性能优化模块。采用剖析+缓存+并行三管齐下策略，系统性提升响应速度。`,
      architecture: `基于${item.sourceTool}的${item.sourceTechnique}，构建架构级优化模块。采用分层设计+模块解耦策略，提升系统的可扩展性和可维护性。`,
    };

    return approachMap[item.category] || `基于${item.sourceTool}的${item.sourceTechnique}实现优化。`;
  }

  /**
   * 生成实现步骤
   */
  private generateImplementationSteps(item: OptimizationItem): string[] {
    const steps: string[] = [];

    steps.push(`1. 需求分析：明确${item.title}的具体需求和验收标准`);
    steps.push(`2. 技术调研：研究${item.sourceTool}的${item.sourceTechnique}实现细节`);

    if (item.dependencies.length > 0) {
      const depNames = item.dependencies
        .map(d => this.items.get(d))
        .filter((d): d is OptimizationItem => d !== undefined)
        .map(d => d.title);
      steps.push(`3. 依赖准备：完成前置依赖 [${depNames.join(', ')}]`);
      steps.push(`4. 原型开发：基于${item.sourceTechnique}构建核心原型`);
    } else {
      steps.push(`3. 原型开发：基于${item.sourceTechnique}构建核心原型`);
    }

    steps.push(`5. 单元测试：编写核心逻辑的单元测试用例`);
    steps.push(`6. 集成测试：与现有系统集成并验证兼容性`);
    steps.push(`7. 性能测试：验证性能指标是否满足${item.successMetrics.join('、')}`);
    steps.push(`8. 代码审查：提交代码审查，确保代码质量`);
    steps.push(`9. 文档编写：编写模块使用文档和API说明`);
    steps.push(`10. 上线部署：灰度发布并监控运行状态`);

    return steps;
  }

  /**
   * 生成测试计划
   */
  private generateTestPlan(item: OptimizationItem): string[] {
    const plan: string[] = [];

    plan.push(`单元测试：覆盖核心逻辑分支率 > 90%`);
    plan.push(`集成测试：验证与Agent Loop的集成正确性`);
    plan.push(`回归测试：确保不影响现有功能`);

    if (item.category === 'code_gen') {
      plan.push(`代码质量测试：验证生成代码的语法正确性和风格一致性`);
      plan.push(`边界测试：测试极端输入场景（空输入、超长输入、特殊字符）`);
    } else if (item.category === 'nlu') {
      plan.push(`准确率测试：使用标注数据集验证理解准确率`);
      plan.push(`模糊输入测试：测试模糊/歧义输入的处理能力`);
    } else if (item.category === 'performance') {
      plan.push(`压力测试：模拟高并发场景验证性能稳定性`);
      plan.push(`延迟测试：验证P50/P95/P99延迟指标`);
    } else if (item.category === 'architecture') {
      plan.push(`安全测试：验证安全策略的有效性`);
      plan.push(`容错测试：模拟异常场景验证系统韧性`);
    }

    plan.push(`A/B测试：与基线方案对比验证效果提升`);

    return plan;
  }

  /**
   * 生成风险缓解策略
   */
  private generateRiskMitigation(risk: string): string {
    if (risk.includes('延迟') || risk.includes('耗时')) {
      return '引入异步处理和缓存机制，设置超时阈值，提供降级方案';
    }
    if (risk.includes('准确率') || risk.includes('误报') || risk.includes('漏报')) {
      return '建立持续评估机制，收集bad case用于模型优化，设置人工审核兜底';
    }
    if (risk.includes('冲突') || risk.includes('不一致')) {
      return '实现冲突检测和自动解决机制，提供手动干预接口';
    }
    if (risk.includes('资源') || risk.includes('内存') || risk.includes('开销')) {
      return '实现资源配额和限流机制，采用懒加载和按需分配策略';
    }
    if (risk.includes('安全') || risk.includes('攻击') || risk.includes('泄露')) {
      return '加强安全审计和渗透测试，实现多层防护和实时监控';
    }
    if (risk.includes('复杂') || risk.includes('困难')) {
      return '分阶段实施，先实现核心功能再逐步完善，设置技术验证里程碑';
    }
    return '建立监控告警机制，制定应急预案，定期回顾和调整策略';
  }

  /**
   * 生成所需资源列表
   */
  private generateRequiredResources(item: OptimizationItem): string[] {
    const resources: string[] = [];

    resources.push('TypeScript开发环境');
    resources.push('单元测试框架（Jest/Vitest）');

    if (item.category === 'code_gen' || item.category === 'context') {
      resources.push('LSP服务器（TypeScript Language Server）');
    }
    if (item.category === 'context' && item.id === 'opt-007') {
      resources.push('Tree-sitter绑定（tree-sitter-wasms）');
      resources.push('向量数据库（如ChromaDB/Qdrant）');
      resources.push('Embedding模型API');
    }
    if (item.category === 'nlu') {
      resources.push('LLM API访问权限');
    }
    if (item.category === 'performance') {
      resources.push('性能监控工具');
      resources.push('基准测试数据集');
    }
    if (item.category === 'architecture') {
      resources.push('系统架构文档');
    }
    if (item.resourceRequired >= 7) {
      resources.push('额外开发人力（预计2-3人）');
    }

    resources.push(`预估工时：${item.estimatedEffort}`);

    return resources;
  }

  // ============ 格式化输出 ============

  /**
   * 格式化路线图
   */
  private formatRoadmap(data: OptimizationRoadmapData): string {
    const lines: string[] = [];
    lines.push('🗺️ 优化路线图 — 段先生自主AI Agent系统');
    lines.push('═'.repeat(60));
    lines.push('');
    lines.push(`📊 总览: ${data.totalItems}项优化 | 平均评分: ${data.averageCompositeScore}`);
    lines.push('');

    // 优先级分布
    lines.push('📋 优先级分布:');
    for (const [p, count] of Object.entries(data.byPriority)) {
      if (count > 0) {
        const bar = '█'.repeat(count * 2);
        lines.push(`  ${p} (${PRIORITY_LABELS[p as Priority]}): ${bar} ${count}项`);
      }
    }
    lines.push('');

    // 分类分布
    lines.push('📂 分类分布:');
    for (const [cat, count] of Object.entries(data.byCategory)) {
      if (count > 0) {
        lines.push(`  ${CATEGORY_LABELS[cat as OptimizationCategory]}: ${count}项`);
      }
    }
    lines.push('');

    // 详细列表
    const sorted = [...data.items].sort((a, b) => b.compositeScore - a.compositeScore);
    lines.push('📝 优化项详情（按评分排序）:');
    lines.push('─'.repeat(60));
    for (const item of sorted) {
      let statusIcon: string;
      if (item.status === 'completed') {
        statusIcon = '✅';
      } else if (item.status === 'in_progress') {
        statusIcon = '🔄';
      } else if (item.status === 'deferred') {
        statusIcon = '⏸️';
      } else {
        statusIcon = '📋';
      }
      lines.push(`${statusIcon} [${item.priority}] ${item.id}: ${item.title}`);
      lines.push(`   评分: ${item.compositeScore} | 影响:${item.impact} 可行:${item.feasibility} 资源:${item.resourceRequired} 对齐:${item.strategicAlignment}`);
      lines.push(`   来源: ${item.sourceTool} → ${item.sourceTechnique}`);
      lines.push(`   工期: ${item.estimatedEffort} | 状态: ${item.status}`);
      lines.push('');
    }

    lines.push(`最后更新: ${data.lastUpdated}`);
    return lines.join('\n');
  }

  /**
   * 格式化优先级列表
   */
  private formatPrioritizedList(scored: ScoredOptimization[]): string {
    const lines: string[] = [];
    lines.push('📊 优化项优先级排序');
    lines.push('═'.repeat(60));
    lines.push('');

    let currentPriority = '';
    for (const s of scored) {
      if (s.priority !== currentPriority) {
        currentPriority = s.priority;
        lines.push(`\n🔹 ${s.priority} — ${PRIORITY_LABELS[s.priority]}`);
        lines.push('─'.repeat(40));
      }

      const item = this.items.get(s.itemId);
      const title = item ? item.title : s.itemId;
      lines.push(`  ${s.itemId}: ${title}`);
      lines.push(`    复合评分: ${s.compositeScore} | 影响:${s.scores.impact} 可行:${s.scores.feasibility} 资源效率:${s.scores.resourceEfficiency} 对齐:${s.scores.strategicAlignment}`);
      lines.push(`    ${s.reasoning}`);
    }

    return lines.join('\n');
  }

  /**
   * 格式化里程碑
   */
  private formatMilestones(milestones: Milestone[]): string {
    const lines: string[] = [];
    lines.push('🎯 分阶段里程碑');
    lines.push('═'.repeat(60));

    for (const m of milestones) {
      lines.push('');
      lines.push(`📌 ${m.phase}: ${m.name} (${m.timeframe})`);
      lines.push('─'.repeat(40));
      lines.push(`  包含项: ${m.items.join(', ')}`);
      lines.push('  目标:');
      for (const obj of m.objectives) {
        lines.push(`    • ${obj}`);
      }
      lines.push('  成功标准:');
      for (const sc of m.successCriteria) {
        lines.push(`    ✓ ${sc}`);
      }
      lines.push('  交付物:');
      for (const d of m.deliverables) {
        lines.push(`    📦 ${d}`);
      }
    }

    return lines.join('\n');
  }

  /**
   * 格式化来源分析
   */
  private formatSourceAnalysis(analysis: SourceAnalysis): string {
    const lines: string[] = [];
    lines.push(`🔍 源工具分析: ${analysis.toolName}`);
    lines.push('═'.repeat(60));
    lines.push(`总技术数: ${analysis.totalTechniques}`);
    lines.push('');

    if (analysis.adoptedTechniques.length > 0) {
      lines.push('✅ 已采纳技术:');
      for (const t of analysis.adoptedTechniques) {
        lines.push(`  • ${t.name} → ${t.ourImplementation} (${t.status})`);
      }
      lines.push('');
    }

    if (analysis.pendingTechniques.length > 0) {
      lines.push('⏳ 待采纳技术:');
      for (const t of analysis.pendingTechniques) {
        lines.push(`  • ${t.name} [${t.priority}] — ${t.reason}`);
      }
      lines.push('');
    }

    if (analysis.competitiveAdvantage.length > 0) {
      lines.push('🏆 竞争优势:');
      for (const a of analysis.competitiveAdvantage) {
        lines.push(`  ★ ${a}`);
      }
      lines.push('');
    }

    if (analysis.gaps.length > 0) {
      lines.push('⚠️ 差距:');
      for (const g of analysis.gaps) {
        lines.push(`  ✗ ${g}`);
      }
    }

    return lines.join('\n');
  }

  /**
   * 格式化实现规格
   */
  private formatImplementationSpec(spec: ImplementationSpec): string {
    const lines: string[] = [];
    const item = this.items.get(spec.itemId);
    lines.push(`📋 实现规格: ${item ? item.title : spec.itemId}`);
    lines.push('═'.repeat(60));
    lines.push('');

    lines.push('🔧 技术方案:');
    lines.push(`  ${spec.technicalApproach}`);
    lines.push('');

    if (spec.dependencies.length > 0) {
      lines.push('🔗 依赖项:');
      for (const dep of spec.dependencies) {
        lines.push(`  → ${dep}`);
      }
      lines.push('');
    }

    lines.push('📝 实现步骤:');
    for (const step of spec.implementationSteps) {
      lines.push(`  ${step}`);
    }
    lines.push('');

    lines.push('🧪 测试计划:');
    for (const test of spec.testPlan) {
      lines.push(`  • ${test}`);
    }
    lines.push('');

    lines.push('✅ 成功标准:');
    for (const sc of spec.successCriteria) {
      lines.push(`  ✓ ${sc}`);
    }
    lines.push('');

    if (spec.risks.length > 0) {
      lines.push('⚠️ 风险与缓解:');
      for (const r of spec.risks) {
        lines.push(`  风险: ${r.risk}`);
        lines.push(`  缓解: ${r.mitigation}`);
      }
      lines.push('');
    }

    lines.push(`⏱️ 预估工期: ${spec.estimatedTimeline}`);
    lines.push('');
    lines.push('📦 所需资源:');
    for (const res of spec.requiredResources) {
      lines.push(`  • ${res}`);
    }

    return lines.join('\n');
  }

  /**
   * 格式化统计数据
   */
  private formatStats(stats: RoadmapStats): string {
    const lines: string[] = [];
    lines.push('📈 路线图统计');
    lines.push('═'.repeat(60));
    lines.push('');
    lines.push(`总优化项: ${stats.totalItems}`);
    lines.push(`  ✅ 已完成: ${stats.completedItems} | 🔄 进行中: ${stats.inProgressItems} | 📋 计划中: ${stats.plannedItems} | ⏸️ 已推迟: ${stats.deferredItems}`);
    lines.push(`  完成率: ${stats.completionRate}%`);
    lines.push('');
    lines.push('📊 平均评分:');
    lines.push(`  影响力: ${stats.averageImpact}/10`);
    lines.push(`  可行性: ${stats.averageFeasibility}/10`);
    lines.push(`  资源效率: ${stats.averageResourceEfficiency}/10`);
    lines.push(`  战略对齐: ${stats.averageAlignment}/10`);
    lines.push(`  复合评分: ${stats.averageCompositeScore}`);
    lines.push('');
    lines.push(`📂 重点分类: ${CATEGORY_LABELS[stats.topCategory]}`);
    lines.push('');
    lines.push('🏗️ 来源分布:');
    for (const [source, count] of Object.entries(stats.sourceDistribution)) {
      const bar = '█'.repeat(count);
      lines.push(`  ${source.padEnd(15)} ${bar} ${count}项`);
    }

    return lines.join('\n');
  }

  // ============ Agent Loop 工具定义 ============

  getToolDefinitions(): ToolDef[] {
    // eslint-disable-next-line @typescript-eslint/no-this-alias
    const self = this;

    return [
      {
        name: 'roadmap_view',
        description: '查看优化路线图，展示所有优化项的评分、优先级、分类和状态分布',
        parameters: {
          category: {
            type: 'string',
            description: '按分类筛选，可选: nlu, code_gen, reasoning, tool_integration, context, task_decomp, interaction, performance, architecture。不传则显示全部',
            required: false,
          },
          priority: {
            type: 'string',
            description: '按优先级筛选，可选: P0, P1, P2, P3。不传则显示全部',
            required: false,
          },
        },
        readOnly: true,
        execute: (args) => {
          try {
            let data = self.getRoadmap();

            // 按分类筛选
            if (args.category) {
              const cat = args.category as OptimizationCategory;
              data = {
                ...data,
                items: data.items.filter(i => i.category === cat),
                totalItems: data.items.filter(i => i.category === cat).length,
              };
            }

            // 按优先级筛选
            if (args.priority) {
              const pri = args.priority as Priority;
              data = {
                ...data,
                items: data.items.filter(i => i.priority === pri),
                totalItems: data.items.filter(i => i.priority === pri).length,
              };
            }

            return Promise.resolve(self.formatRoadmap(data));
          } catch (err: unknown) {
            const msg = err instanceof Error ? err.message : String(err);
            self.log.error('路线图查看失败', { error: msg });
            return Promise.resolve(`❌ 路线图查看失败: ${msg}`);
          }
        },
      },
      {
        name: 'roadmap_prioritize',
        description: '获取按复合评分排序的优化项列表，包含评分详情和优先级分层',
        parameters: {
          minScore: {
            type: 'number',
            description: '最低复合评分过滤阈值，如6.0。不传则显示全部',
            required: false,
          },
        },
        readOnly: true,
        execute: (args) => {
          try {
            let scored = self.getPrioritizedList();

            if (args.minScore !== undefined) {
              const min = Number(args.minScore);
              scored = scored.filter(s => s.compositeScore >= min);
            }

            return Promise.resolve(self.formatPrioritizedList(scored));
          } catch (err: unknown) {
            const msg = err instanceof Error ? err.message : String(err);
            self.log.error('优先级列表获取失败', { error: msg });
            return Promise.resolve(`❌ 优先级列表获取失败: ${msg}`);
          }
        },
      },
      {
        name: 'roadmap_milestones',
        description: '查看分阶段里程碑，包含Phase1-4的目标、成功标准和交付物',
        parameters: {
          phase: {
            type: 'string',
            description: '指定阶段，可选: Phase 1, Phase 2, Phase 3, Phase 4。不传则显示全部',
            required: false,
          },
        },
        readOnly: true,
        execute: (args) => {
          try {
            let milestones = self.getMilestones();

            if (args.phase) {
              milestones = milestones.filter(m => m.phase === args.phase);
            }

            return Promise.resolve(self.formatMilestones(milestones));
          } catch (err: unknown) {
            const msg = err instanceof Error ? err.message : String(err);
            self.log.error('里程碑获取失败', { error: msg });
            return Promise.resolve(`❌ 里程碑获取失败: ${msg}`);
          }
        },
      },
      {
        name: 'roadmap_spec',
        description: '生成指定优化项的实现规格，包含技术方案、实现步骤、测试计划、风险缓解',
        parameters: {
          itemId: {
            type: 'string',
            description: '优化项ID，如 opt-001, opt-002 等',
            required: true,
          },
        },
        readOnly: true,
        execute: (args) => {
          try {
            const itemId = args.itemId as string;
            const spec = self.generateImplementationSpec(itemId);

            if (!spec) {
              return Promise.resolve(`❌ 未找到优化项: ${itemId}。可用ID: ${Array.from(self.items.keys()).join(', ')}`);
            }

            return Promise.resolve(self.formatImplementationSpec(spec));
          } catch (err: unknown) {
            const msg = err instanceof Error ? err.message : String(err);
            self.log.error('实现规格生成失败', { error: msg });
            return Promise.resolve(`❌ 实现规格生成失败: ${msg}`);
          }
        },
      },
      {
        name: 'roadmap_sources',
        description: '查看源工具分析，了解各工具的技术采纳情况、竞争优势和差距',
        parameters: {
          toolName: {
            type: 'string',
            description: '源工具名称，可选: OpenCode, Codex, OpenClaw, OpenAI Agents, Cursor, Trae CN, LibTV',
            required: true,
          },
        },
        readOnly: true,
        execute: (args) => {
          try {
            const toolName = args.toolName as string;
            const analysis = self.getSourceAnalysis(toolName);

            if (analysis.totalTechniques === 0) {
              return Promise.resolve(`❌ 未找到工具 "${toolName}" 的相关技术。可用工具: OpenCode, Codex, OpenClaw, OpenAI Agents, Cursor, Trae CN, LibTV`);
            }

            return Promise.resolve(self.formatSourceAnalysis(analysis));
          } catch (err: unknown) {
            const msg = err instanceof Error ? err.message : String(err);
            self.log.error('来源分析失败', { error: msg });
            return Promise.resolve(`❌ 来源分析失败: ${msg}`);
          }
        },
      },
    ];
  }
}
