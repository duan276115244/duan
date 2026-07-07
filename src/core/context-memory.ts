/**
 * 多轮对话上下文记忆系统 — ContextMemory
 *
 * 核心能力：
 * - 对话轮次管理：自动提取意图/实体，上下文窗口管理
 * - 指代消解：中文代词（他/她/它/这个/那个/刚才/之前）→ 实体映射
 * - 多步骤任务：创建/推进/暂停/失败的任务生命周期
 * - 用户目标追踪：从对话中检测并跟踪用户目标
 * - 主题栈：维护当前对话主题栈，支持上下文感知
 * - 持久化：会话级 JSON 持久化，自动清理过期会话
 * - Token 预算：中文 ~4 字符/token 估算，超限时摘要压缩
 *
 * Hermes 三级记忆架构集成：
 * - L0 会话级：本模块即 L0 层，管理当前对话上下文
 * - 偏好自动提取：从对话中识别用户偏好并向上层（L1）传递
 */

import * as fs from 'fs/promises';
import * as path from 'path';
import { logger } from './structured-logger.js';
import { duanPath } from './duan-paths.js';
import { EventBus } from './event-bus.js';
import { HermesMemoryTier } from './memory-types.js';
import { atomicWriteJson } from './atomic-write.js';

// ==================== 接口定义 ====================

// HermesMemoryTier 已迁至 ./memory-types.ts（单一来源）

/** Hermes：从对话中提取的用户偏好（向上传递到 L1） */
export interface ExtractedPreference {
  /** 偏好类别 */
  category: 'programming_language' | 'work_habit' | 'communication_style' | 'tool_preference' | 'detail_level' | 'expertise_level';
  /** 偏好键 */
  key: string;
  /** 偏好值 */
  value: string;
  /** 提取来源轮次 ID */
  sourceTurnId: string;
  /** 提取时间戳 */
  extractedAt: number;
}

export interface ConversationTurn {
  id: string;
  role: 'user' | 'assistant' | 'system';
  content: string;
  timestamp: number;
  intent?: string;
  entities?: Array<{ type: string; value: string }>;
  taskResult?: { success: boolean; summary: string };
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  metadata?: Record<string, any>;
}

export interface TaskStep {
  description: string;
  status: 'pending' | 'in_progress' | 'completed' | 'failed';
  result?: string;
}

export interface PendingTask {
  id: string;
  description: string;
  steps: TaskStep[];
  currentStepIndex: number;
  status: 'active' | 'completed' | 'failed' | 'paused';
  createdAt: number;
  updatedAt: number;
}

export interface ConversationSession {
  id: string;
  startTime: number;
  lastActivityTime: number;
  turns: ConversationTurn[];
  topicStack: string[];
  pendingTasks: PendingTask[];
  userGoals: string[];
  resolvedReferences: Map<string, string>;
}

// ==================== 持久化用的可序列化类型 ====================

interface SerializableConversationTurn {
  id: string;
  role: 'user' | 'assistant' | 'system';
  content: string;
  timestamp: number;
  intent?: string;
  entities?: Array<{ type: string; value: string }>;
  taskResult?: { success: boolean; summary: string };
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  metadata?: Record<string, any>;
}

interface SerializablePendingTask {
  id: string;
  description: string;
  steps: TaskStep[];
  currentStepIndex: number;
  status: 'active' | 'completed' | 'failed' | 'paused';
  createdAt: number;
  updatedAt: number;
}

interface SerializableConversationSession {
  id: string;
  startTime: number;
  lastActivityTime: number;
  turns: SerializableConversationTurn[];
  topicStack: string[];
  pendingTasks: SerializablePendingTask[];
  userGoals: string[];
  resolvedReferences: Record<string, string>;
  summary?: string;
}

// ==================== 持久化数据整体结构 ====================

interface _SessionStore {
  sessions: Record<string, SerializableConversationSession>;
}

// ==================== 辅助常量 ====================

/** 中文代词 → 实体类型映射 */
const PRONOUN_ENTITY_MAP: Record<string, string[]> = {
  '他': ['person', 'user', 'developer'],
  '她': ['person', 'user', 'developer'],
  '它': ['technology', 'tool', 'file', 'project', 'language', 'framework'],
  '这个': ['technology', 'tool', 'file', 'project', 'language', 'framework', 'concept'],
  '那个': ['technology', 'tool', 'file', 'project', 'language', 'framework', 'concept'],
  '刚才': ['action'],
  '之前': ['action'],
};

/** 意图关键词映射 */
const INTENT_KEYWORDS: Record<string, string[]> = {
  '代码生成': ['写代码', '生成', '实现', '创建函数', '编写', 'implement', 'create', 'write code'],
  '代码调试': ['debug', '调试', '错误', 'bug', '报错', 'error', '修复', 'fix'],
  '代码审查': ['review', '审查', '检查代码', '优化', '重构', 'refactor'],
  '问题解答': ['怎么', '如何', '为什么', '什么是', 'how', 'what', 'why', '解释'],
  '文件操作': ['读取文件', '写入文件', '创建文件', '删除文件', 'file', '目录'],
  '部署运维': ['部署', 'deploy', 'docker', '服务器', '运维'],
  '学习咨询': ['学习', '教程', '入门', '推荐', '建议', 'learn', 'tutorial'],
  '任务规划': ['帮我', '计划', '规划', '步骤', '安排', 'plan'],
};

/** 实体类型关键词映射 */
const ENTITY_PATTERNS: Array<{ type: string; pattern: RegExp }> = [
  { type: 'person', pattern: /(?:张三|李四|王五|老师|同事|经理|领导|小明|小红|小华|[A-Z][a-z]+(?:\s[A-Z][a-z]+)?)/g },
  { type: 'language', pattern: /(?:Python|Java(?:Script)?|TypeScript|Go|Rust|C\+\+|C#|Ruby|PHP|Swift|Kotlin)/gi },
  { type: 'framework', pattern: /(?:React|Vue|Angular|Django|Flask|Spring|Express|Next\.?js|Nuxt)/gi },
  { type: 'tool', pattern: /(?:Docker|Git|Webpack|Vite|ESLint|Prettier|Jest|Pytest)/gi },
  { type: 'file', pattern: /(?:[\w-]+\.(?:ts|js|py|java|go|rs|json|yaml|yml|md|txt|css|html))/gi },
  { type: 'project', pattern: /(?:项目|project|仓库|repo|工程)/g },
  { type: 'concept', pattern: /(?:微服务|分布式|容器化|CI\/CD|设计模式|架构|算法|数据结构)/g },
];

/** 用户目标关键词映射 */
const GOAL_PATTERNS: Array<{ pattern: RegExp; goal: string }> = [
  { pattern: /(?:想|想要|希望|需要|得|必须).*(?:完成|实现|做|开发|构建|搭建)/, goal: '实现功能' },
  { pattern: /(?:想|想要|希望|需要).*(?:学习|了解|掌握|弄懂|理解)/, goal: '学习知识' },
  { pattern: /(?:想|想要|希望|需要).*(?:修复|解决|排查|调试|debug)/, goal: '解决问题' },
  { pattern: /(?:想|想要|希望|需要).*(?:优化|改进|提升|加速|提高)/, goal: '优化改进' },
  { pattern: /(?:想|想要|希望|需要).*(?:部署|上线|发布|交付)/, goal: '部署发布' },
  { pattern: /(?:想|想要|希望|需要).*(?:测试|验证|确认|检查)/, goal: '测试验证' },
];

/** 主题关键词映射 */
const TOPIC_KEYWORDS: Record<string, string[]> = {
  '编程语言': ['python', 'java', 'javascript', 'typescript', 'go', 'rust', 'c++', 'c#'],
  '框架': ['react', 'vue', 'angular', 'django', 'flask', 'spring', 'express', 'next.js'],
  '数据库': ['mysql', 'postgresql', 'mongodb', 'redis', 'sqlite', '数据库', 'sql'],
  '部署': ['docker', 'kubernetes', 'nginx', '部署', 'deploy', 'ci/cd'],
  '测试': ['测试', 'test', 'jest', 'pytest', '单元测试', 'e2e'],
  '架构': ['架构', '设计', 'design', '模式', '微服务', '分布式'],
  '安全': ['安全', 'security', '加密', '认证', '授权', '漏洞'],
  '性能': ['性能', 'performance', '优化', '缓存', '并发'],
};

// ==================== 工具定义 ====================

export const contextMemoryTools = [
  {
    name: 'context_recall',
    description: '从对话历史中回忆信息，用于查找之前讨论过的内容',
    parameters: {
      type: 'object',
      properties: {
        query: {
          type: 'string',
          description: '要回忆的内容查询关键词',
        },
      },
      required: ['query'],
    },
  },
  {
    name: 'context_task_status',
    description: '检查当前多步骤任务的执行状态',
    parameters: {
      type: 'object',
      properties: {},
    },
  },
  {
    name: 'context_task_create',
    description: '创建一个多步骤任务计划',
    parameters: {
      type: 'object',
      properties: {
        description: {
          type: 'string',
          description: '任务描述',
        },
        steps: {
          type: 'string',
          description: '任务步骤的 JSON 数组字符串，例如: ["步骤1", "步骤2"]',
        },
      },
      required: ['description', 'steps'],
    },
  },
];

// ==================== 主类 ====================

export class ContextMemory {
  private session: ConversationSession;
  private dataDir: string;
  private maxTurns: number;
  private tokenBudget: number;
  private summary: string;
  private log = logger.child({ module: 'ContextMemory' });
  private eventBus: EventBus;

  /** Hermes：从对话中提取的偏好（待向上传递到 L1） */
  private extractedPreferences: ExtractedPreference[] = [];

  /** Hermes：L0 快速检索索引（关键词 → 轮次索引集合） */
  private turnKeywordIndex: Map<string, Set<number>> = new Map();

  constructor(options?: {
    dataDir?: string;
    maxTurns?: number;
    tokenBudget?: number;
    sessionId?: string;
  } | string) {
    // 兼容旧 API：传入字符串路径
    const opts = typeof options === 'string'
      ? { dataDir: options }
      : options;
    this.dataDir = opts?.dataDir || duanPath('context');
    this.maxTurns = opts?.maxTurns || 50;
    this.tokenBudget = opts?.tokenBudget || 8000;
    this.summary = '';
    this.eventBus = EventBus.getInstance();

    const sessionId = opts?.sessionId || `session_${Date.now()}_${Math.random().toString(36).slice(2, 9)}`;
    this.session = {
      id: sessionId,
      startTime: Date.now(),
      lastActivityTime: Date.now(),
      turns: [],
      topicStack: [],
      pendingTasks: [],
      userGoals: [],
      resolvedReferences: new Map(),
    };

    this.load().catch(err => {
      this.log.warn('加载会话数据失败，使用空会话', { error: err instanceof Error ? err.message : String(err) });
    });

    this.log.info('ContextMemory 初始化', { sessionId: this.session.id, maxTurns: this.maxTurns });
  }

  // ==================== 对话轮次管理 ====================

  /** 添加对话轮次，自动提取意图和实体 */
  addTurn(role: ConversationTurn['role'], content: string, metadata?: Record<string, unknown>): ConversationTurn {
    const turn: ConversationTurn = {
      id: `turn_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`,
      role,
      content,
      timestamp: Date.now(),
      metadata,
    };

    // 自动提取意图
    turn.intent = this.extractIntent(content);

    // 自动提取实体
    turn.entities = this.extractEntities(content);

    this.session.turns.push(turn);
    this.session.lastActivityTime = Date.now();

    // Hermes：维护 L0 关键词索引，加速 ≤100ms 检索
    this.updateTurnKeywordIndex(this.session.turns.length - 1, content);

    // 更新指代消解映射
    if (turn.entities && turn.entities.length > 0) {
      this.updateResolvedReferences(turn.entities);
    }

    // 更新主题栈
    this.updateTopicStack(content);

    // 检测用户目标
    if (role === 'user') {
      this.detectUserGoal(content);
      // Hermes：从用户消息中自动提取偏好
      this.extractPreferencesFromMessage(turn.id, content);
    }

    // 上下文窗口管理
    this.manageContextWindow();

    // 持久化
    this.save().catch(err => {
      this.log.error('保存会话失败', { error: err instanceof Error ? err.message : String(err) });
    });

    // 发射事件
    this.eventBus.emitSync('context.turn.added', {
      turnId: turn.id,
      role: turn.role,
      intent: turn.intent,
      entityCount: turn.entities?.length || 0,
    }, { source: 'ContextMemory' });

    this.log.debug('添加对话轮次', {
      turnId: turn.id,
      role,
      intent: turn.intent,
      entityCount: turn.entities?.length || 0,
    });

    return turn;
  }

  /** 获取最近 N 轮对话作为格式化字符串，用于 LLM 上下文 */
  getRecentContext(n: number = 10): string {
    // session 在构造函数中必定初始化，无需 assertInitialized 守卫
    const turns = this.session.turns.slice(-n);
    if (turns.length === 0) return '';

    const parts: string[] = [];

    // 如果有摘要，先输出摘要
    if (this.summary) {
      parts.push(`[对话摘要] ${this.summary}`);
      parts.push('');
    }

    for (const turn of turns) {
      let roleLabel: string;
      if (turn.role === 'user') {
        roleLabel = '用户';
      } else if (turn.role === 'assistant') {
        roleLabel = '助手';
      } else {

        roleLabel = '系统';
      }
      let line = `${roleLabel}: ${turn.content}`;
      if (turn.intent) {
        line += ` [意图: ${turn.intent}]`;
      }
      if (turn.entities && turn.entities.length > 0) {
        const entityStr = turn.entities.map(e => `${e.type}:${e.value}`).join(', ');
        line += ` [实体: ${entityStr}]`;
      }
      parts.push(line);
    }

    return parts.join('\n');
  }

  // ==================== 指代消解 ====================

  /** 解析文本中的代词/指代，使用上下文替换为具体实体 */
  resolveReference(text: string): string {
    let resolved = text;

    for (const [pronoun, entityTypes] of Object.entries(PRONOUN_ENTITY_MAP)) {
      if (!resolved.includes(pronoun)) continue;

      // 先查已解析映射
      const cached = this.session.resolvedReferences.get(pronoun);
      if (cached) {
        resolved = resolved.replaceAll(pronoun, cached);
        continue;
      }

      // 向后搜索最近的匹配实体
      const resolvedEntity = this.findRecentEntity(entityTypes);
      if (resolvedEntity) {
        resolved = resolved.replaceAll(pronoun, resolvedEntity);
        this.session.resolvedReferences.set(pronoun, resolvedEntity);
      }
    }

    return resolved;
  }

  /** 在最近轮次中查找匹配类型的实体 */
  private findRecentEntity(entityTypes: string[]): string | null {
    for (let i = this.session.turns.length - 1; i >= 0; i--) {
      const turn = this.session.turns[i];
      if (!turn.entities) continue;

      for (const entity of turn.entities) {
        if (entityTypes.includes(entity.type)) {
          return entity.value;
        }
      }
    }
    return null;
  }

  /** 更新指代消解映射 */
  private updateResolvedReferences(entities: Array<{ type: string; value: string }>): void {
    for (const entity of entities) {
      // 人物实体 → 他/她
      if (['person', 'user', 'developer'].includes(entity.type)) {
        this.session.resolvedReferences.set('他', entity.value);
        this.session.resolvedReferences.set('她', entity.value);
      }
      // 技术/工具/文件实体 → 它/这个
      if (['technology', 'tool', 'file', 'project', 'language', 'framework'].includes(entity.type)) {
        this.session.resolvedReferences.set('它', entity.value);
        this.session.resolvedReferences.set('这个', entity.value);
        this.session.resolvedReferences.set('那个', entity.value);
      }
    }
  }

  // ==================== 多步骤任务管理 ====================

  /** 获取当前活跃的多步骤任务 */
  getActiveTask(): PendingTask | null {
    return this.session.pendingTasks.find(t => t.status === 'active') || null;
  }

  /** 创建新的多步骤任务 */
  createTask(description: string, steps: string[]): PendingTask {
    const task: PendingTask = {
      id: `task_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`,
      description,
      steps: steps.map(s => ({
        description: s,
        status: 'pending' as const,
      })),
      currentStepIndex: 0,
      status: 'active',
      createdAt: Date.now(),
      updatedAt: Date.now(),
    };

    // 将第一个步骤标记为进行中
    if (task.steps.length > 0) {
      task.steps[0].status = 'in_progress';
    }

    // 暂停其他活跃任务
    for (const existing of this.session.pendingTasks) {
      if (existing.status === 'active') {
        existing.status = 'paused';
        existing.updatedAt = Date.now();
      }
    }

    this.session.pendingTasks.push(task);
    this.session.lastActivityTime = Date.now();

    this.log.info('创建多步骤任务', {
      taskId: task.id,
      description,
      stepCount: steps.length,
    });

    this.eventBus.emitSync('context.task.created', {
      taskId: task.id,
      description,
      stepCount: steps.length,
    }, { source: 'ContextMemory' });

    this.save().catch(err => {
      this.log.error('保存会话失败', { error: err instanceof Error ? err.message : String(err) });
    });

    return task;
  }

  /** 推进当前活跃任务的步骤 */
  advanceTask(result: string, success: boolean): PendingTask | null {
    const task = this.getActiveTask();
    if (!task) {
      this.log.warn('没有活跃任务可推进');
      return null;
    }

    // 更新当前步骤
    const currentStep = task.steps[task.currentStepIndex];
    if (currentStep) {
      currentStep.status = success ? 'completed' : 'failed';
      currentStep.result = result;
    }

    // 推进到下一步
    if (success) {
      task.currentStepIndex++;
      if (task.currentStepIndex >= task.steps.length) {
        // 所有步骤完成
        task.status = 'completed';
        this.log.info('多步骤任务完成', { taskId: task.id, description: task.description });
      } else {
        // 标记下一步为进行中
        task.steps[task.currentStepIndex].status = 'in_progress';
        this.log.info('任务推进到下一步', {
          taskId: task.id,
          stepIndex: task.currentStepIndex,
          stepDescription: task.steps[task.currentStepIndex].description,
        });
      }
    } else {
      task.status = 'failed';
      this.log.warn('多步骤任务失败', { taskId: task.id, failedStep: task.currentStepIndex, result });
    }

    task.updatedAt = Date.now();

    this.eventBus.emitSync('context.task.advanced', {
      taskId: task.id,
      status: task.status,
      currentStepIndex: task.currentStepIndex,
      success,
    }, { source: 'ContextMemory' });

    this.save().catch(err => {
      this.log.error('保存会话失败', { error: err instanceof Error ? err.message : String(err) });
    });

    return task;
  }

  // ==================== 用户目标检测 ====================

  /** 从文本中检测并跟踪用户目标 */
  detectUserGoal(text: string): string[] {
    const detectedGoals: string[] = [];

    for (const { pattern, goal } of GOAL_PATTERNS) {
      if (pattern.test(text)) {
        if (!this.session.userGoals.includes(goal)) {
          this.session.userGoals.push(goal);
          detectedGoals.push(goal);
        }
      }
    }

    // 重置正则 lastIndex
    for (const { pattern } of GOAL_PATTERNS) {
      pattern.lastIndex = 0;
    }

    // 最多保留 10 个目标
    if (this.session.userGoals.length > 10) {
      this.session.userGoals = this.session.userGoals.slice(-10);
    }

    if (detectedGoals.length > 0) {
      this.log.debug('检测到用户目标', { goals: detectedGoals });
    }

    return detectedGoals;
  }

  // ==================== 主题管理 ====================

  /** 获取当前主题栈的上下文描述 */
  getTopicContext(): string {
    if (this.session.topicStack.length === 0) return '';

    const parts: string[] = ['[当前话题]'];
    for (let i = this.session.topicStack.length - 1; i >= 0; i--) {
      const indent = '  '.repeat(this.session.topicStack.length - 1 - i);
      parts.push(`${indent}- ${this.session.topicStack[i]}`);
    }
    return parts.join('\n');
  }

  /** 更新主题栈 */
  private updateTopicStack(text: string): void {
    const lower = text.toLowerCase();

    for (const [topic, keywords] of Object.entries(TOPIC_KEYWORDS)) {
      if (keywords.some(kw => lower.includes(kw))) {
        // 如果主题已在栈中，移到栈顶
        const idx = this.session.topicStack.indexOf(topic);
        if (idx !== -1) {
          this.session.topicStack.splice(idx, 1);
        }
        this.session.topicStack.push(topic);

        // 最多保留 5 个主题
        if (this.session.topicStack.length > 5) {
          this.session.topicStack.shift();
        }
      }
    }
  }

  // ==================== 对话摘要 ====================

  /** 生成对话摘要 */
  summarizeConversation(): string {
    const turns = this.session.turns;
    if (turns.length === 0) return '（空对话）';

    const parts: string[] = [];

    // 基本信息
    const duration = Math.round((Date.now() - this.session.startTime) / 60000);
    parts.push(`对话时长: ${duration}分钟, 共${turns.length}轮`);

    // 用户目标
    if (this.session.userGoals.length > 0) {
      parts.push(`用户目标: ${this.session.userGoals.join('、')}`);
    }

    // 主题
    if (this.session.topicStack.length > 0) {
      parts.push(`讨论话题: ${this.session.topicStack.join('、')}`);
    }

    // 关键轮次摘要
    const userTurns = turns.filter(t => t.role === 'user');
    const assistantTurns = turns.filter(t => t.role === 'assistant');
    parts.push(`用户消息${userTurns.length}条, 助手回复${assistantTurns.length}条`);

    // 意图统计
    const intentCounts: Record<string, number> = {};
    for (const turn of turns) {
      if (turn.intent) {
        intentCounts[turn.intent] = (intentCounts[turn.intent] || 0) + 1;
      }
    }
    if (Object.keys(intentCounts).length > 0) {
      const topIntents = Object.entries(intentCounts)
        .sort((a, b) => b[1] - a[1])
        .slice(0, 3)
        .map(([intent, count]) => `${intent}(${count}次)`)
        .join(', ');
      parts.push(`主要意图: ${topIntents}`);
    }

    // 任务状态
    const activeTasks = this.session.pendingTasks.filter(t => t.status === 'active');
    const completedTasks = this.session.pendingTasks.filter(t => t.status === 'completed');
    if (activeTasks.length > 0) {
      parts.push(`进行中任务: ${activeTasks.map(t => t.description).join(', ')}`);
    }
    if (completedTasks.length > 0) {
      parts.push(`已完成任务: ${completedTasks.length}个`);
    }

    // 最近3轮对话要点
    const recentTurns = turns.slice(-3);
    if (recentTurns.length > 0) {
      parts.push('最近对话:');
      for (const turn of recentTurns) {
        const roleLabel = turn.role === 'user' ? '用户' : '助手';
        const snippet = turn.content.length > 80 ? turn.content.slice(0, 80) + '...' : turn.content;
        parts.push(`  ${roleLabel}: ${snippet}`);
      }
    }

    return parts.join('\n');
  }

  // ==================== 会话管理 ====================

  /** 清除当前会话数据 */
  clearSession(): void {
    const sessionId = this.session.id;

    this.session = {
      id: `session_${Date.now()}_${Math.random().toString(36).slice(2, 9)}`,
      startTime: Date.now(),
      lastActivityTime: Date.now(),
      turns: [],
      topicStack: [],
      pendingTasks: [],
      userGoals: [],
      resolvedReferences: new Map(),
    };
    this.summary = '';

    // 删除旧会话文件
    const filePath = path.join(this.dataDir, `session-${sessionId}.json`);
    fs.unlink(filePath).catch(() => { /* 文件可能不存在 */ });

    this.log.info('会话已清除', { oldSessionId: sessionId, newSessionId: this.session.id });

    this.eventBus.emitSync('context.session.cleared', {
      oldSessionId: sessionId,
      newSessionId: this.session.id,
    }, { source: 'ContextMemory' });
  }

  /** 获取当前会话 ID */
  getSessionId(): string {
    return this.session.id;
  }

  /** 获取当前会话的轮次数 */
  getTurnCount(): number {
    return this.session.turns.length;
  }

  /** 获取估算的 token 数（中文 ~4 字符/token） */
  getEstimatedTokens(): number {
    let totalChars = this.summary.length;
    for (const turn of this.session.turns) {
      totalChars += turn.content.length;
    }
    return Math.ceil(totalChars / 4);
  }

  /** 获取用户目标列表 */
  getUserGoals(): string[] {
    return [...this.session.userGoals];
  }

  /** 获取所有待处理任务 */
  getPendingTasks(): PendingTask[] {
    return [...this.session.pendingTasks];
  }

  // ==================== 意图与实体提取 ====================

  /** 从文本中提取意图 */
  private extractIntent(text: string): string | undefined {
    const lower = text.toLowerCase();
    let bestIntent: string | undefined;
    let bestScore = 0;

    for (const [intent, keywords] of Object.entries(INTENT_KEYWORDS)) {
      let score = 0;
      for (const kw of keywords) {
        if (lower.includes(kw)) {
          score += kw.length; // 更长的关键词权重更高
        }
      }
      if (score > bestScore) {
        bestScore = score;
        bestIntent = intent;
      }
    }

    return bestIntent;
  }

  /** 从文本中提取实体 */
  private extractEntities(text: string): Array<{ type: string; value: string }> | undefined {
    const entities: Array<{ type: string; value: string }> = [];
    const seen = new Set<string>();

    for (const { type, pattern } of ENTITY_PATTERNS) {
      const matches = text.matchAll(pattern);
      for (const match of matches) {
        const value = match[0];
        const key = `${type}:${value}`;
        if (!seen.has(key)) {
          seen.add(key);
          entities.push({ type, value });
        }
      }
      // 重置正则 lastIndex
      pattern.lastIndex = 0;
    }

    return entities.length > 0 ? entities : undefined;
  }

  // ==================== 上下文窗口管理 ====================

  /** 管理上下文窗口，超限时摘要压缩 */
  private manageContextWindow(): void {
    // 检查轮次限制
    if (this.session.turns.length <= this.maxTurns) return;

    // 保留最近 70% 的轮次，对旧的 30% 进行摘要
    const keepCount = Math.floor(this.maxTurns * 0.7);
    const oldTurns = this.session.turns.slice(0, this.session.turns.length - keepCount);
    const recentTurns = this.session.turns.slice(-keepCount);

    // 生成旧轮次的摘要
    const oldSummary = this.summarizeTurns(oldTurns);
    if (this.summary) {
      this.summary = `${this.summary}\n${oldSummary}`;
    } else {
      this.summary = oldSummary;
    }

    // 摘要本身也需要控制长度
    const maxSummaryChars = this.tokenBudget * 2; // 约占 token 预算的一半字符
    if (this.summary.length > maxSummaryChars) {
      this.summary = this.summary.slice(-maxSummaryChars);
    }

    this.session.turns = recentTurns;

    this.log.info('上下文窗口压缩', {
      removedTurns: oldTurns.length,
      keptTurns: recentTurns.length,
      summaryLength: this.summary.length,
      estimatedTokens: this.getEstimatedTokens(),
    });

    this.eventBus.emitSync('context.window.compacted', {
      removedTurns: oldTurns.length,
      keptTurns: recentTurns.length,
      estimatedTokens: this.getEstimatedTokens(),
    }, { source: 'ContextMemory' });
  }

  /** 将一组轮次摘要为简短文本 */
  private summarizeTurns(turns: ConversationTurn[]): string {
    if (turns.length === 0) return '';

    const parts: string[] = [];
    for (const turn of turns) {
      const roleLabel = turn.role === 'user' ? '用户' : '助手';
      const snippet = turn.content.length > 60 ? turn.content.slice(0, 60) + '...' : turn.content;
      let line = `${roleLabel}: ${snippet}`;
      if (turn.intent) {
        line += ` [${turn.intent}]`;
      }
      parts.push(line);
    }
    return parts.join('; ');
  }

  // ==================== 持久化 ====================

  /** 保存当前会话到磁盘 */
  async save(): Promise<void> {
    try {
      await fs.mkdir(this.dataDir, { recursive: true });

      const data: SerializableConversationSession = {
        id: this.session.id,
        startTime: this.session.startTime,
        lastActivityTime: this.session.lastActivityTime,
        turns: this.session.turns.map(t => ({ ...t })),
        topicStack: this.session.topicStack,
        pendingTasks: this.session.pendingTasks.map(t => ({ ...t, steps: t.steps.map(s => ({ ...s })) })),
        userGoals: this.session.userGoals,
        resolvedReferences: Object.fromEntries(this.session.resolvedReferences),
        summary: this.summary,
      };

      const filePath = path.join(this.dataDir, `session-${this.session.id}.json`);
      await atomicWriteJson(filePath, data);
    } catch (err: unknown) {
      this.log.error('保存会话失败', { error: err instanceof Error ? err.message : String(err) });
    }
  }

  /** 从磁盘加载最近的会话 */
  async load(): Promise<void> {
    try {
      await fs.mkdir(this.dataDir, { recursive: true });

      const entries = await fs.readdir(this.dataDir);
      const sessionFiles = entries.filter(f => f.startsWith('session-') && f.endsWith('.json'));

      if (sessionFiles.length === 0) return;

      // 清理超过 24 小时的会话
      const now = Date.now();
      const DAY_MS = 24 * 60 * 60 * 1000;
      const validFiles: string[] = [];

      for (const file of sessionFiles) {
        const filePath = path.join(this.dataDir, file);
        try {
          const stat = await fs.stat(filePath);
          if (now - stat.mtimeMs < DAY_MS) {
            validFiles.push(file);
          } else {
            await fs.unlink(filePath);
            this.log.debug('清理过期会话文件', { file });
          }
        } catch {
          // 文件可能已被删除
        }
      }

      if (validFiles.length === 0) return;

      // 找到最近修改的会话文件
      let latestFile = validFiles[0];
      let latestTime = 0;
      for (const file of validFiles) {
        const filePath = path.join(this.dataDir, file);
        const stat = await fs.stat(filePath);
        if (stat.mtimeMs > latestTime) {
          latestTime = stat.mtimeMs;
          latestFile = file;
        }
      }

      // 加载最近的会话
      const filePath = path.join(this.dataDir, latestFile);
      const content = await fs.readFile(filePath, 'utf-8');
      const data: SerializableConversationSession = JSON.parse(content);

      this.session = {
        id: data.id,
        startTime: data.startTime,
        lastActivityTime: data.lastActivityTime,
        turns: data.turns.map(t => ({ ...t })),
        topicStack: data.topicStack || [],
        pendingTasks: data.pendingTasks || [],
        userGoals: data.userGoals || [],
        resolvedReferences: new Map(Object.entries(data.resolvedReferences || {})),
      };
      this.summary = data.summary || '';

      this.log.info('加载会话成功', {
        sessionId: this.session.id,
        turnCount: this.session.turns.length,
        taskCount: this.session.pendingTasks.length,
      });
    } catch (err: unknown) {
      this.log.warn('加载会话失败', { error: err instanceof Error ? err.message : String(err) });
    }
  }

  // ==================== Hermes L0 会话级 API ====================

  /**
   * Hermes：更新 L0 关键词索引
   * 加速对话轮次的 ≤100ms 检索
   */
  private updateTurnKeywordIndex(turnIdx: number, content: string): void {
    const lower = content.toLowerCase();
    const words = lower
      .replace(/[^\u4e00-\u9fa5a-z0-9+#.]/gi, ' ')
      .split(/\s+/)
      .filter(w => w.length >= 2);

    for (const word of words) {
      if (!this.turnKeywordIndex.has(word)) {
        this.turnKeywordIndex.set(word, new Set());
      }
      this.turnKeywordIndex.get(word)!.add(turnIdx);
    }
  }

  /**
   * Hermes：L0 会话级快速检索
   * 使用关键词索引实现 ≤100ms 响应
   */
  searchL0Session(query: string, limit: number = 5): ConversationTurn[] {
    const queryWords = query.toLowerCase()
      .replace(/[^\u4e00-\u9fa5a-z0-9+#.]/gi, ' ')
      .split(/\s+/)
      .filter(w => w.length >= 2);

    if (queryWords.length === 0) return [];

    // 关键词索引命中
    const hitIndices = new Set<number>();
    for (const word of queryWords) {
      const indices = this.turnKeywordIndex.get(word);
      if (indices) {
        for (const idx of indices) {
          hitIndices.add(idx);
        }
      }
    }

    // 转换为轮次并评分
    const results: Array<{ turn: ConversationTurn; score: number }> = [];
    for (const idx of hitIndices) {
      const turn = this.session.turns[idx];
      if (!turn) continue;

      let score = 0;
      const text = turn.content.toLowerCase();
      for (const word of queryWords) {
        if (text.includes(word)) score += 1;
      }
      // 意图匹配加分
      if (turn.intent) {
        for (const word of queryWords) {
          if (turn.intent.toLowerCase().includes(word)) score += 2;
        }
      }
      results.push({ turn, score });
    }

    return results
      .sort((a, b) => b.score - a.score)
      .slice(0, limit)
      .map(r => r.turn);
  }

  /**
   * Hermes：从用户消息中自动提取偏好
   * 识别编程语言、工作习惯、沟通风格等
   */
  private extractPreferencesFromMessage(turnId: string, text: string): void {
    const now = Date.now();

    // 1. 编程语言识别
    const langPatterns: Array<{ lang: string; patterns: RegExp[] }> = [
      { lang: 'TypeScript', patterns: [/typescript/i, /\.ts\b/, /\bts\b/i] },
      { lang: 'JavaScript', patterns: [/javascript/i, /\.js\b/, /\bjs\b/i] },
      { lang: 'Python', patterns: [/python/i, /\.py\b/] },
      { lang: 'Go', patterns: [/\bgolang\b/i, /\.go\b/] },
      { lang: 'Rust', patterns: [/rust/i, /\.rs\b/] },
    ];
    for (const { lang, patterns } of langPatterns) {
      if (patterns.some(p => p.test(text))) {
        this.addExtractedPreference({
          category: 'programming_language',
          key: 'primary',
          value: lang,
          sourceTurnId: turnId,
          extractedAt: now,
        });
      }
    }

    // 2. 沟通风格识别
    if (/简洁|简短|直接|brief|concise/i.test(text)) {
      this.addExtractedPreference({
        category: 'communication_style',
        key: 'detail_level',
        value: 'brief',
        sourceTurnId: turnId,
        extractedAt: now,
      });
    }
    if (/详细|完整|detailed|comprehensive/i.test(text)) {
      this.addExtractedPreference({
        category: 'communication_style',
        key: 'detail_level',
        value: 'detailed',
        sourceTurnId: turnId,
        extractedAt: now,
      });
    }
    if (/代码示例|用代码|show code/i.test(text)) {
      this.addExtractedPreference({
        category: 'communication_style',
        key: 'prefers_code',
        value: 'true',
        sourceTurnId: turnId,
        extractedAt: now,
      });
    }

    // 3. 专业水平识别
    if (/我是新手|初学者|beginner/i.test(text)) {
      this.addExtractedPreference({
        category: 'expertise_level',
        key: 'self_assessed',
        value: 'beginner',
        sourceTurnId: turnId,
        extractedAt: now,
      });
    }
    if (/我是专家|资深|expert|advanced/i.test(text)) {
      this.addExtractedPreference({
        category: 'expertise_level',
        key: 'self_assessed',
        value: 'expert',
        sourceTurnId: turnId,
        extractedAt: now,
      });
    }

    // 4. 工作习惯识别
    if (/测试驱动|TDD|test driven/i.test(text)) {
      this.addExtractedPreference({
        category: 'work_habit',
        key: 'development_approach',
        value: 'TDD',
        sourceTurnId: turnId,
        extractedAt: now,
      });
    }
  }

  /**
   * Hermes：添加提取的偏好（去重）
   */
  private addExtractedPreference(pref: ExtractedPreference): void {
    // 去重：同类别同键的偏好只保留最新的
    const existingIdx = this.extractedPreferences.findIndex(
      p => p.category === pref.category && p.key === pref.key
    );
    if (existingIdx >= 0) {
      this.extractedPreferences[existingIdx] = pref;
    } else {
      this.extractedPreferences.push(pref);
    }
  }

  /**
   * Hermes：获取本会话提取的所有偏好（用于向上传递到 L1）
   */
  getExtractedPreferences(): ExtractedPreference[] {
    return [...this.extractedPreferences];
  }

  /**
   * Hermes：清空已提取的偏好（向上传递后调用）
   */
  clearExtractedPreferences(): void {
    this.extractedPreferences = [];
  }

  /**
   * Hermes：获取 L0 会话级记忆层级标识
   */
  getHermesTier(): HermesMemoryTier {
    return HermesMemoryTier.L0_SESSION;
  }

  // ==================== 工具方法 ====================

  /** 处理 context_recall 工具调用 */
  handleContextRecall(query: string): string {
    const keywords = query.toLowerCase().split(/\s+/).filter(k => k.length > 0);
    if (keywords.length === 0) return '未找到相关对话记录';

    const results: Array<{ turn: ConversationTurn; score: number }> = [];

    for (const turn of this.session.turns) {
      const text = turn.content.toLowerCase();
      let score = 0;

      for (const kw of keywords) {
        if (text.includes(kw)) {
          score += kw.length;
        }
      }

      // 意图匹配加分
      if (turn.intent) {
        for (const kw of keywords) {
          if (turn.intent.toLowerCase().includes(kw)) {
            score += 2;
          }
        }
      }

      // 实体匹配加分
      if (turn.entities) {
        for (const entity of turn.entities) {
          for (const kw of keywords) {
            if (entity.value.toLowerCase().includes(kw) || entity.type.toLowerCase().includes(kw)) {
              score += 3;
            }
          }
        }
      }

      if (score > 0) {
        results.push({ turn, score });
      }
    }

    if (results.length === 0) return '未找到相关对话记录';

    results.sort((a, b) => b.score - a.score);
    const topResults = results.slice(0, 5);

    const parts: string[] = ['找到以下相关对话记录:'];
    for (const { turn } of topResults) {
      const roleLabel = turn.role === 'user' ? '用户' : '助手';
      const time = new Date(turn.timestamp).toLocaleString('zh-CN');
      parts.push(`[${time}] ${roleLabel}: ${turn.content}`);
    }

    return parts.join('\n');
  }

  /** 处理 context_task_status 工具调用 */
  handleTaskStatus(): string {
    const activeTask = this.getActiveTask();
    if (!activeTask) return '当前没有进行中的多步骤任务';

    const parts: string[] = [
      `任务: ${activeTask.description}`,
      `状态: ${activeTask.status}`,
      `进度: ${activeTask.currentStepIndex + 1}/${activeTask.steps.length}`,
      '',
      '步骤详情:',
    ];

    for (let i = 0; i < activeTask.steps.length; i++) {
      const step = activeTask.steps[i];
      let marker: string;
      if (step.status === 'completed') {
        marker = '✓';
      } else if (step.status === 'in_progress') {
        marker = '→';
      } else if (step.status === 'failed') {
        marker = '✗';
      } else {
        marker = '○';
      }
      let line = `  ${marker} ${i + 1}. ${step.description}`;
      if (step.result) {
        line += ` — ${step.result}`;
      }
      parts.push(line);
    }

    return parts.join('\n');
  }

  /** 处理 context_task_create 工具调用 */
  handleTaskCreate(description: string, stepsJson: string): string {
    let steps: string[];
    try {
      steps = JSON.parse(stepsJson);
      if (!Array.isArray(steps) || steps.length === 0) {
        return '步骤格式错误: 需要非空 JSON 数组';
      }
      if (!steps.every(s => typeof s === 'string')) {
        return '步骤格式错误: 每个步骤必须是字符串';
      }
    } catch {
      return '步骤格式错误: 无法解析 JSON 数组';
    }

    const task = this.createTask(description, steps);

    const parts: string[] = [
      `已创建任务: ${description}`,
      `任务ID: ${task.id}`,
      `共 ${steps.length} 个步骤:`,
    ];
    for (let i = 0; i < steps.length; i++) {
      parts.push(`  ${i + 1}. ${steps[i]}`);
    }

    return parts.join('\n');
  }
  // ==================== 兼容旧 API（web-server.ts 等模块使用） ====================

  /** 兼容旧 API: addMessage → addTurn */
  addMessage(role: string, content: string, metadata?: Record<string, unknown>): void {
    this.addTurn(role as 'user' | 'assistant' | 'system', content, metadata);
  }

  /** 兼容旧 API: createSession → clearSession */
  createSession(): void {
    this.clearSession();
  }

  /** 兼容旧 API: storeMemory */
  storeMemory(key: string, value: string, _tags?: string[]): string {
    this.session.resolvedReferences.set(key, value);
    this.save().catch(err => {
      logger.warn('记忆保存失败 — 数据可能未持久化', { error: err?.message });
    });
    return `已存储记忆: ${key}`;
  }

  /** 兼容旧 API: retrieveMemories */
  retrieveMemories(query: string, limit?: number): Array<{ key: string; value: string; relevance: number }> {
    const results: Array<{ key: string; value: string; relevance: number }> = [];
    const q = query.toLowerCase();

    for (const [key, value] of this.session.resolvedReferences) {
      if (key.toLowerCase().includes(q) || value.toLowerCase().includes(q)) {
        results.push({ key, value, relevance: 1.0 });
      }
    }

    // 也搜索对话轮次
    for (const turn of this.session.turns) {
      if (turn.content.toLowerCase().includes(q)) {
        results.push({
          key: `turn_${turn.id}`,
          value: turn.content.substring(0, 200),
          relevance: 0.8,
        });
      }
    }

    return results.slice(0, limit || 10);
  }

  /** 兼容旧 API: learnFromInteraction */
  learnFromInteraction(input: string, output: string, success: boolean): void {
    this.addTurn('user', input);
    this.addTurn('assistant', output, { success });
  }

  /** 兼容旧 API: getUserProfile */
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  getUserProfile(): Record<string, any> {
    return {
      goals: this.session.userGoals,
      topics: this.session.topicStack,
      turnCount: this.session.turns.length,
      sessionId: this.session.id,
    };
  }

  /** 兼容旧 API: getStats */
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  getStats(): Record<string, any> {
    const userTurns = this.session.turns.filter(t => t.role === 'user').length;
    const assistantTurns = this.session.turns.filter(t => t.role === 'assistant').length;
    return {
      totalTurns: this.session.turns.length,
      userTurns,
      assistantTurns,
      activeTasks: this.session.pendingTasks.filter(t => t.status === 'active').length,
      completedTasks: this.session.pendingTasks.filter(t => t.status === 'completed').length,
      userGoals: this.session.userGoals.length,
      estimatedTokens: this.getEstimatedTokens(),
      sessionId: this.session.id,
    };
  }
}

/** 兼容别名：web-server.ts 等模块可能使用 ContextMemorySystem 名称 */
export const ContextMemorySystem = ContextMemory;
