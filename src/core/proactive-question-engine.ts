/**
 * §5.4 学习增强 — 主动提问引擎 ProactiveQuestionEngine
 *
 * 对标 ChatGPT 的"主动追问"和 Khan Academy 的"个性化引导"：
 * 检测到用户知识盲区 / 反复错误 / 兴趣信号时，主动向用户提问，引导学习与澄清。
 *
 * 核心能力：
 * 1. 盲区提问：基于 DuanPersonaEngine.knowledgeGaps 生成补强提问
 * 2. 错误模式提问：基于 errorPatterns（count >= 3）生成最佳实践提问
 * 3. 兴趣深化提问：基于 interests 生成进阶学习提问
 * 4. 澄清提问：任务失败后主动追问用户意图（对标 ChatGPT 追问）
 * 5. 频率控制：冷却期 + 每日上限 + 会话内上限，避免过度打扰
 * 6. 反馈记录：记录用户回答 / 忽略 / 拒绝，优化后续提问策略
 *
 * 数据持久化：~/.duan/proactive-questions.json
 */

import * as fs from 'fs';
import * as path from 'path';
import { logger } from './structured-logger.js';
import { duanPath } from './duan-paths.js';
import { atomicWriteJson } from './atomic-write.js';
import type { ToolDef } from './unified-tool-def.js';

// ============ 类型定义 ============

/** 提问触发源 */
export type QuestionTrigger = 'knowledge_gap' | 'error_pattern' | 'interest' | 'clarification' | 'follow_up';

/** 提问优先级 */
export type QuestionPriority = 'low' | 'medium' | 'high' | 'urgent';

/** 提问状态 */
export type QuestionStatus = 'pending' | 'asked' | 'answered' | 'ignored' | 'declined' | 'expired';

/** 用户反馈类型 */
export type FeedbackType = 'answered' | 'ignored' | 'declined' | 'partial';

/** 主动提问记录 */
export interface ProactiveQuestion {
  /** 唯一 ID */
  id: string;
  /** 触发源 */
  trigger: QuestionTrigger;
  /** 优先级 */
  priority: QuestionPriority;
  /** 提问内容 */
  question: string;
  /** 相关领域 */
  domain: string;
  /** 背景/原因（为什么问这个） */
  reason: string;
  /** 建议的选项（可选，用于引导用户回答） */
  options?: string[];
  /** 创建时间 */
  createdAt: number;
  /** 提问时间（实际向用户展示的时间） */
  askedAt?: number;
  /** 状态 */
  status: QuestionStatus;
  /** 用户反馈 */
  feedback?: {
    type: FeedbackType;
    answer?: string;
    selectedOption?: string;
    timestamp: number;
  };
  /** 关联的会话 ID（可选） */
  sessionId?: string;
}

/** 提问统计 */
export interface QuestionStats {
  /** 总提问数 */
  totalAsked: number;
  /** 已回答数 */
  totalAnswered: number;
  /** 被忽略数 */
  totalIgnored: number;
  /** 被拒绝数 */
  totalDeclined: number;
  /** 回答率 */
  answerRate: number;
  /** 按触发源统计 */
  byTrigger: Record<QuestionTrigger, { asked: number; answered: number }>;
  /** 最后提问时间 */
  lastAskedAt?: number;
}

/** 提问策略配置 */
export interface QuestionPolicy {
  /** 冷却期（毫秒）：两次提问之间的最小间隔，默认 5 分钟 */
  cooldownMs: number;
  /** 每日提问上限，默认 10 */
  dailyLimit: number;
  /** 单会话提问上限，默认 3 */
  sessionLimit: number;
  /** 错误模式触发阈值（出现次数），默认 3 */
  errorPatternThreshold: number;
  /** 兴趣权重触发阈值，默认 0.7 */
  interestWeightThreshold: number;
  /** 提问过期时间（毫秒），默认 1 小时 */
  expirationMs: number;
}

/** 默认提问策略 */
export const DEFAULT_QUESTION_POLICY: QuestionPolicy = {
  cooldownMs: 5 * 60 * 1000,      // 5 分钟
  dailyLimit: 10,
  sessionLimit: 3,
  errorPatternThreshold: 3,
  interestWeightThreshold: 0.7,
  expirationMs: 60 * 60 * 1000,   // 1 小时
};

/** 提问生成输入（从 DuanPersonaEngine 等系统获取） */
export interface QuestionContext {
  /** 知识盲区列表 */
  knowledgeGaps: Array<{ domain: string; evidence: string; detectedAt: number }>;
  /** 错误模式列表 */
  errorPatterns: Array<{ pattern: string; count: number; lastOccurrence: number }>;
  /** 兴趣列表 */
  interests: Array<{ topic: string; weight: number }>;
  /** 当前会话 ID（可选） */
  sessionId?: string;
  /** 当前任务描述（可选，用于澄清提问） */
  currentTask?: string;
  /** 任务是否失败（可选，用于澄清提问） */
  taskFailed?: boolean;
}

// ============ ProactiveQuestionEngine ============

export class ProactiveQuestionEngine {
  private log = logger.child({ module: 'ProactiveQuestionEngine' });

  /** 提问记录（按时间排序，新的在前） */
  private questions: ProactiveQuestion[] = [];

  /** 提问策略 */
  private policy: QuestionPolicy;

  /** 数据文件路径 */
  private dataFile: string;

  /** 单会话提问计数器（sessionId → count） */
  private sessionCounts: Map<string, number> = new Map();

  /** 当日提问计数 */
  private dailyCount: number = 0;

  /** 当日日期标记（用于跨日重置） */
  private dailyDate: string = '';

  /** 是否已初始化 */
  private initialized: boolean = false;

  constructor(policy?: Partial<QuestionPolicy>, dataDir?: string) {
    this.policy = { ...DEFAULT_QUESTION_POLICY, ...policy };
    // 支持自定义数据目录（测试隔离）
    const baseDir = dataDir || duanPath();
    this.dataFile = path.join(baseDir, 'proactive-questions.json');
  }

  /** 初始化：创建目录 + 加载已有数据 */
  async initialize(): Promise<void> {
    if (this.initialized) return;

    try {
      const dir = path.dirname(this.dataFile);
      if (!fs.existsSync(dir)) {
        fs.mkdirSync(dir, { recursive: true });
      }
      await this.loadData();
      this.resetDailyCountIfNeeded();
      this.initialized = true;
      this.log.info('ProactiveQuestionEngine 初始化完成', {
        questionCount: this.questions.length,
        dailyCount: this.dailyCount,
      });
    } catch (err: unknown) {
      this.log.warn('ProactiveQuestionEngine 初始化失败（非致命）', {
        error: err instanceof Error ? err.message : String(err),
      });
      this.initialized = true; // 即使加载失败也标记为已初始化，使用空数据继续
    }
  }

  /** 加载数据文件 */
  private async loadData(): Promise<void> {
    try {
      if (!fs.existsSync(this.dataFile)) return;
      const raw = await fs.promises.readFile(this.dataFile, 'utf-8');
      const data = JSON.parse(raw);
      if (Array.isArray(data.questions)) {
        // 只保留最近 500 条记录，避免无限增长
        this.questions = data.questions.slice(-500);
      }
      if (data.dailyCount && typeof data.dailyCount === 'number') {
        this.dailyCount = data.dailyCount;
      }
      if (data.dailyDate && typeof data.dailyDate === 'string') {
        this.dailyDate = data.dailyDate;
      }
    } catch (err: unknown) {
      this.log.warn('加载提问记录失败，使用空数据', {
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }

  /** 保存数据文件 */
  private async saveData(): Promise<void> {
    try {
      const data = {
        questions: this.questions.slice(-500),
        dailyCount: this.dailyCount,
        dailyDate: this.dailyDate,
        savedAt: Date.now(),
      };
      await atomicWriteJson(this.dataFile, data);
    } catch (err: unknown) {
      this.log.warn('保存提问记录失败', {
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }

  /** 跨日重置每日计数 */
  private resetDailyCountIfNeeded(): void {
    const today = new Date().toISOString().slice(0, 10); // YYYY-MM-DD
    if (this.dailyDate !== today) {
      this.dailyCount = 0;
      this.dailyDate = today;
    }
  }

  /** 检查是否可以提问（频率控制） */
  canAsk(sessionId?: string): boolean {
    this.resetDailyCountIfNeeded();

    // 每日上限
    if (this.dailyCount >= this.policy.dailyLimit) {
      return false;
    }

    // 冷却期检查
    const lastQuestion = this.questions.find(q => q.askedAt);
    if (lastQuestion?.askedAt) {
      const elapsed = Date.now() - lastQuestion.askedAt;
      if (elapsed < this.policy.cooldownMs) {
        return false;
      }
    }

    // 会话内上限
    if (sessionId) {
      const sessionCount = this.sessionCounts.get(sessionId) || 0;
      if (sessionCount >= this.policy.sessionLimit) {
        return false;
      }
    }

    return true;
  }

  /** 根据上下文生成候选提问 */
  generateCandidates(ctx: QuestionContext): ProactiveQuestion[] {
    const candidates: ProactiveQuestion[] = [];
    const now = Date.now();

    // 1. 知识盲区提问（high 优先级）
    for (const gap of ctx.knowledgeGaps) {
      // 检查是否最近已问过相同 domain
      const recentAsked = this.questions.some(
        q => q.domain === gap.domain &&
             q.trigger === 'knowledge_gap' &&
             q.askedAt &&
             (now - q.askedAt) < 24 * 60 * 60 * 1000, // 24 小时内不重复问
      );
      if (recentAsked) continue;

      candidates.push({
        id: this.generateId('gap'),
        trigger: 'knowledge_gap',
        priority: 'high',
        question: `我注意到你在「${gap.domain}」领域遇到了一些困难（${gap.evidence}）。你希望我帮你梳理一下这个领域的基础知识吗？`,
        domain: gap.domain,
        reason: `检测到知识盲区：${gap.evidence}`,
        options: ['好的，请帮我梳理', '不用了，我知道怎么处理', '稍后再说'],
        createdAt: now,
        status: 'pending',
        sessionId: ctx.sessionId,
      });
    }

    // 2. 错误模式提问（urgent 优先级）
    for (const pattern of ctx.errorPatterns.filter(p => p.count >= this.policy.errorPatternThreshold)) {
      const recentAsked = this.questions.some(
        q => q.domain === pattern.pattern &&
             q.trigger === 'error_pattern' &&
             q.askedAt &&
             (now - q.askedAt) < 12 * 60 * 60 * 1000, // 12 小时内不重复问
      );
      if (recentAsked) continue;

      candidates.push({
        id: this.generateId('err'),
        trigger: 'error_pattern',
        priority: 'urgent',
        question: `你在「${pattern.pattern}」上已经遇到 ${pattern.count} 次问题了。要不要我帮你分析一下根本原因，避免下次再犯？`,
        domain: pattern.pattern,
        reason: `错误模式重复 ${pattern.count} 次`,
        options: ['好的，帮我分析', '不用了', '稍后再说'],
        createdAt: now,
        status: 'pending',
        sessionId: ctx.sessionId,
      });
    }

    // 3. 兴趣深化提问（medium 优先级）
    for (const interest of ctx.interests.filter(i => i.weight >= this.policy.interestWeightThreshold)) {
      const recentAsked = this.questions.some(
        q => q.domain === interest.topic &&
             q.trigger === 'interest' &&
             q.askedAt &&
             (now - q.askedAt) < 48 * 60 * 60 * 1000, // 48 小时内不重复问
      );
      if (recentAsked) continue;

      candidates.push({
        id: this.generateId('int'),
        trigger: 'interest',
        priority: 'medium',
        question: `你对「${interest.topic}」似乎很感兴趣。想不想深入了解一下进阶内容？`,
        domain: interest.topic,
        reason: `兴趣权重 ${interest.weight.toFixed(2)} 超过阈值`,
        options: ['好的，说说看', '暂时不需要', '稍后再说'],
        createdAt: now,
        status: 'pending',
        sessionId: ctx.sessionId,
      });
    }

    // 4. 澄清提问（urgent 优先级，任务失败时触发）
    if (ctx.taskFailed && ctx.currentTask) {
      candidates.push({
        id: this.generateId('clar'),
        trigger: 'clarification',
        priority: 'urgent',
        question: `刚才的任务「${ctx.currentTask}」似乎没有完全成功。你能描述一下你期望的结果吗？我可以重新尝试。`,
        domain: 'task_clarification',
        reason: '任务失败，需要澄清用户意图',
        createdAt: now,
        status: 'pending',
        sessionId: ctx.sessionId,
      });
    }

    // 按优先级排序：urgent > high > medium > low
    const priorityOrder: Record<QuestionPriority, number> = { urgent: 0, high: 1, medium: 2, low: 3 };
    candidates.sort((a, b) => priorityOrder[a.priority] - priorityOrder[b.priority]);

    return candidates;
  }

  /** 获取下一个应该提问的问题（考虑频率控制） */
  getNextQuestion(ctx: QuestionContext): ProactiveQuestion | null {
    if (!this.canAsk(ctx.sessionId)) {
      return null;
    }

    const candidates = this.generateCandidates(ctx);
    if (candidates.length === 0) {
      return null;
    }

    // 返回最高优先级的候选
    return candidates[0];
  }

  /** 标记问题为已提问 */
  async markAsAsked(questionId: string): Promise<void> {
    const q = this.questions.find(qq => qq.id === questionId);
    if (q && q.status === 'pending') {
      q.status = 'asked';
      q.askedAt = Date.now();
      this.resetDailyCountIfNeeded();
      this.dailyCount++;
      if (q.sessionId) {
        const count = this.sessionCounts.get(q.sessionId) || 0;
        this.sessionCounts.set(q.sessionId, count + 1);
      }
      await this.saveData();
      this.log.info('主动提问已发出', {
        questionId,
        trigger: q.trigger,
        domain: q.domain,
        dailyCount: this.dailyCount,
      });
    }
  }

  /** 创建并标记提问（便捷方法：生成 + 立即标记） */
  async askQuestion(ctx: QuestionContext): Promise<ProactiveQuestion | null> {
    const question = this.getNextQuestion(ctx);
    if (!question) {
      return null;
    }
    // 添加到记录列表
    this.questions.push(question);
    await this.markAsAsked(question.id);
    return question;
  }

  /** 记录用户反馈 */
  async recordFeedback(questionId: string, feedback: {
    type: FeedbackType;
    answer?: string;
    selectedOption?: string;
  }): Promise<void> {
    const q = this.questions.find(qq => qq.id === questionId);
    if (!q) {
      this.log.warn('未找到提问记录，无法记录反馈', { questionId });
      return;
    }

    q.feedback = {
      type: feedback.type,
      answer: feedback.answer,
      selectedOption: feedback.selectedOption,
      timestamp: Date.now(),
    };

    // 根据反馈类型更新状态
    switch (feedback.type) {
      case 'answered':
        q.status = 'answered';
        break;
      case 'ignored':
        q.status = 'ignored';
        break;
      case 'declined':
        q.status = 'declined';
        break;
      case 'partial':
        q.status = 'answered'; // 部分回答也算 answered
        break;
    }

    await this.saveData();
    this.log.info('用户反馈已记录', {
      questionId,
      feedbackType: feedback.type,
      status: q.status,
    });
  }

  /** 清理过期未回答的问题 */
  async cleanExpired(): Promise<number> {
    const now = Date.now();
    const before = this.questions.length;
    this.questions = this.questions.filter(q => {
      // pending 或 asked 状态的过期问题标记为 expired
      if ((q.status === 'pending' || q.status === 'asked') &&
          (now - q.createdAt) > this.policy.expirationMs) {
        q.status = 'expired';
        return true; // 保留记录但标记为 expired
      }
      return true;
    });
    const changed = this.questions.length !== before;
    if (changed || this.questions.some(q => q.status === 'expired')) {
      await this.saveData();
    }
    return this.questions.filter(q => q.status === 'expired').length;
  }

  /** 获取提问统计 */
  getStats(): QuestionStats {
    const asked = this.questions.filter(q => q.status !== 'pending');
    const answered = this.questions.filter(q => q.status === 'answered');
    const ignored = this.questions.filter(q => q.status === 'ignored');
    const declined = this.questions.filter(q => q.status === 'declined');

    const byTrigger: Record<QuestionTrigger, { asked: number; answered: number }> = {
      knowledge_gap: { asked: 0, answered: 0 },
      error_pattern: { asked: 0, answered: 0 },
      interest: { asked: 0, answered: 0 },
      clarification: { asked: 0, answered: 0 },
      follow_up: { asked: 0, answered: 0 },
    };

    for (const q of asked) {
      byTrigger[q.trigger].asked++;
      if (q.status === 'answered') {
        byTrigger[q.trigger].answered++;
      }
    }

    const lastAsked = asked
      .filter(q => q.askedAt)
      .sort((a, b) => (b.askedAt || 0) - (a.askedAt || 0))[0];

    return {
      totalAsked: asked.length,
      totalAnswered: answered.length,
      totalIgnored: ignored.length,
      totalDeclined: declined.length,
      answerRate: asked.length > 0 ? answered.length / asked.length : 0,
      byTrigger,
      lastAskedAt: lastAsked?.askedAt,
    };
  }

  /** 获取所有提问记录 */
  getAllQuestions(): ProactiveQuestion[] {
    return [...this.questions];
  }

  /** 获取待提问（pending 状态） */
  getPendingQuestions(): ProactiveQuestion[] {
    return this.questions.filter(q => q.status === 'pending');
  }

  /** 获取已提问但未回答的（asked 状态） */
  getUnansweredQuestions(): ProactiveQuestion[] {
    return this.questions.filter(q => q.status === 'asked');
  }

  /** 重置会话计数（会话结束时调用） */
  resetSession(sessionId: string): void {
    this.sessionCounts.delete(sessionId);
  }

  /** 更新提问策略 */
  updatePolicy(updates: Partial<QuestionPolicy>): void {
    this.policy = { ...this.policy, ...updates };
    this.log.info('提问策略已更新', { policy: this.policy });
  }

  /** 获取当前策略 */
  getPolicy(): QuestionPolicy {
    return { ...this.policy };
  }

  /** 生成唯一 ID */
  private generateId(prefix: string): string {
    return `pq_${prefix}_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 6)}`;
  }

  /** 手动添加提问（用于测试或外部系统注入） */
  async addQuestion(question: Omit<ProactiveQuestion, 'id' | 'createdAt' | 'status'>): Promise<ProactiveQuestion> {
    const fullQuestion: ProactiveQuestion = {
      ...question,
      id: this.generateId('manual'),
      createdAt: Date.now(),
      status: 'pending',
    };
    this.questions.push(fullQuestion);
    await this.saveData();
    return fullQuestion;
  }

  /** 清空所有记录（用于测试） */
  async clearAll(): Promise<void> {
    this.questions = [];
    this.sessionCounts.clear();
    this.dailyCount = 0;
    this.dailyDate = '';
    await this.saveData();
  }

  // ============ LLM 工具定义 ============

  getToolDefinitions(): ToolDef[] {
    return [
      {
        name: 'proactive_question_check',
        description: '检查是否有应该主动向用户提问的内容。基于用户知识盲区、错误模式、兴趣信号和任务失败情况，判断是否需要主动提问。返回提问内容和选项（如果有）。',
        parameters: {
          knowledge_gaps_json: { type: 'string', description: '知识盲区列表 JSON 字符串，格式: [{"domain":"领域","evidence":"证据","detectedAt":时间戳}]', required: false },
          error_patterns_json: { type: 'string', description: '错误模式列表 JSON 字符串，格式: [{"pattern":"模式","count":次数,"lastOccurrence":时间戳}]', required: false },
          interests_json: { type: 'string', description: '兴趣列表 JSON 字符串，格式: [{"topic":"话题","weight":0.8}]', required: false },
          session_id: { type: 'string', description: '当前会话 ID（可选）', required: false },
          current_task: { type: 'string', description: '当前任务描述（可选，用于澄清提问）', required: false },
          task_failed: { type: 'boolean', description: '任务是否失败（可选，用于澄清提问）', required: false },
        },
        execute: async (args: {
          knowledge_gaps_json?: string;
          error_patterns_json?: string;
          interests_json?: string;
          session_id?: string;
          current_task?: string;
          task_failed?: boolean;
        }) => {
          try {
            const ctx: QuestionContext = {
              knowledgeGaps: args.knowledge_gaps_json ? JSON.parse(args.knowledge_gaps_json) : [],
              errorPatterns: args.error_patterns_json ? JSON.parse(args.error_patterns_json) : [],
              interests: args.interests_json ? JSON.parse(args.interests_json) : [],
              sessionId: args.session_id,
              currentTask: args.current_task,
              taskFailed: args.task_failed,
            };
            const question = await this.askQuestion(ctx);
            if (!question) {
              return '✅ 当前无需主动提问（无候选或频率控制阻止）';
            }
            return JSON.stringify({
              question_id: question.id,
              trigger: question.trigger,
              priority: question.priority,
              question: question.question,
              domain: question.domain,
              reason: question.reason,
              options: question.options,
            }, null, 2);
          } catch (err: unknown) {
            return `❌ 检查主动提问失败: ${err instanceof Error ? err.message : String(err)}`;
          }
        },
      },
      {
        name: 'proactive_question_feedback',
        description: '记录用户对主动提问的反馈。当用户回答、忽略或拒绝主动提问时调用此工具。',
        parameters: {
          question_id: { type: 'string', description: '提问 ID', required: true },
          feedback_type: { type: 'string', description: '反馈类型: answered/ignored/declined/partial', required: true },
          answer: { type: 'string', description: '用户的回答内容（可选）', required: false },
          selected_option: { type: 'string', description: '用户选择的选项（可选）', required: false },
        },
        execute: async (args: {
          question_id?: string;
          feedback_type?: string;
          answer?: string;
          selected_option?: string;
        }) => {
          if (!args?.question_id || !args?.feedback_type) {
            return '❌ 缺少必填参数: question_id, feedback_type';
          }
          const validTypes = ['answered', 'ignored', 'declined', 'partial'];
          if (!validTypes.includes(args.feedback_type)) {
            return `❌ 无效的 feedback_type: ${args.feedback_type}，应为: ${validTypes.join('/')}`;
          }
          await this.recordFeedback(args.question_id, {
            type: args.feedback_type as FeedbackType,
            answer: args.answer,
            selectedOption: args.selected_option,
          });
          return `✅ 反馈已记录 (question_id=${args.question_id}, type=${args.feedback_type})`;
        },
      },
      {
        name: 'proactive_question_stats',
        description: '查看主动提问统计，包括总提问数、回答率、按触发源分类的统计等。',
        parameters: {},
        execute: async () => {
          const stats = this.getStats();
          return JSON.stringify(stats, null, 2);
        },
      },
      {
        name: 'proactive_question_policy',
        description: '查看或更新主动提问策略。可调整冷却期、每日上限、会话上限、错误模式阈值等参数。',
        parameters: {
          action: { type: 'string', description: '操作: get=查看当前策略, update=更新策略', required: true },
          cooldown_ms: { type: 'number', description: '冷却期（毫秒），两次提问的最小间隔', required: false },
          daily_limit: { type: 'number', description: '每日提问上限', required: false },
          session_limit: { type: 'number', description: '单会话提问上限', required: false },
          error_pattern_threshold: { type: 'number', description: '错误模式触发阈值（出现次数）', required: false },
          interest_weight_threshold: { type: 'number', description: '兴趣权重触发阈值 0-1', required: false },
          expiration_ms: { type: 'number', description: '提问过期时间（毫秒）', required: false },
        },
        execute: async (args: {
          action?: string;
          cooldown_ms?: number;
          daily_limit?: number;
          session_limit?: number;
          error_pattern_threshold?: number;
          interest_weight_threshold?: number;
          expiration_ms?: number;
        }) => {
          if (!args?.action) {
            return '❌ 缺少必填参数: action';
          }
          if (args.action === 'get') {
            return JSON.stringify(this.getPolicy(), null, 2);
          }
          if (args.action === 'update') {
            const updates: Partial<QuestionPolicy> = {};
            if (args.cooldown_ms !== undefined) updates.cooldownMs = args.cooldown_ms;
            if (args.daily_limit !== undefined) updates.dailyLimit = args.daily_limit;
            if (args.session_limit !== undefined) updates.sessionLimit = args.session_limit;
            if (args.error_pattern_threshold !== undefined) updates.errorPatternThreshold = args.error_pattern_threshold;
            if (args.interest_weight_threshold !== undefined) updates.interestWeightThreshold = args.interest_weight_threshold;
            if (args.expiration_ms !== undefined) updates.expirationMs = args.expiration_ms;
            this.updatePolicy(updates);
            return `✅ 策略已更新\n${JSON.stringify(this.getPolicy(), null, 2)}`;
          }
          return `❌ 无效的 action: ${args.action}，应为 get 或 update`;
        },
      },
    ];
  }
}

// ============ 单例 ============

let _instance: ProactiveQuestionEngine | null = null;

export function getProactiveQuestionEngine(): ProactiveQuestionEngine {
  if (!_instance) {
    _instance = new ProactiveQuestionEngine();
  }
  return _instance;
}
