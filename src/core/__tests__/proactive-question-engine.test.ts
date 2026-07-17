/**
 * §5.4 学习增强 — ProactiveQuestionEngine 测试
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import {
  ProactiveQuestionEngine,
  DEFAULT_QUESTION_POLICY,
  getProactiveQuestionEngine,
  type QuestionContext,
} from '../proactive-question-engine.js';

// ============ 辅助函数 ============

/** 创建临时数据目录 */
function createTempDataDir(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'duan-proactive-test-'));
}

/** 创建空上下文 */
function emptyContext(): QuestionContext {
  return {
    knowledgeGaps: [],
    errorPatterns: [],
    interests: [],
  };
}

/** 创建带知识盲区的上下文 */
function contextWithGaps(): QuestionContext {
  return {
    knowledgeGaps: [
      { domain: 'TypeScript', evidence: '类型错误', detectedAt: Date.now() },
      { domain: 'React', evidence: 'Hook 使用错误', detectedAt: Date.now() },
    ],
    errorPatterns: [],
    interests: [],
  };
}

/** 创建带错误模式的上下文 */
function contextWithErrors(count: number = 3): QuestionContext {
  return {
    knowledgeGaps: [],
    errorPatterns: [
      { pattern: 'null_pointer', count, lastOccurrence: Date.now() },
    ],
    interests: [],
  };
}

/** 创建带兴趣的上下文 */
function contextWithInterests(weight: number = 0.8): QuestionContext {
  return {
    knowledgeGaps: [],
    errorPatterns: [],
    interests: [
      { topic: '机器学习', weight },
    ],
  };
}

/** 创建任务失败的上下文 */
function contextWithTaskFailure(): QuestionContext {
  return {
    knowledgeGaps: [],
    errorPatterns: [],
    interests: [],
    currentTask: '部署应用到生产环境',
    taskFailed: true,
  };
}

// ============ 测试 ============

describe('v20.0 §5.4: ProactiveQuestionEngine', () => {
  let tempDir: string;
  let engine: ProactiveQuestionEngine;

  beforeEach(async () => {
    tempDir = createTempDataDir();
    engine = new ProactiveQuestionEngine({}, tempDir);
    await engine.initialize();
  });

  afterEach(async () => {
    await engine.clearAll();
    // 清理临时目录
    try {
      fs.rmSync(tempDir, { recursive: true, force: true });
    } catch {
      // 忽略清理错误
    }
  });

  // ============ 初始化 ============

  describe('初始化', () => {
    it('initialize 后已初始化', async () => {
      const e = new ProactiveQuestionEngine({}, createTempDataDir());
      await e.initialize();
      // initialize 不抛错即为成功
      expect(e).toBeDefined();
    });

    it('重复调用 initialize 幂等', async () => {
      const e = new ProactiveQuestionEngine({}, createTempDataDir());
      await e.initialize();
      await e.initialize(); // 不应抛错
      expect(e).toBeDefined();
    });

    it('自定义策略覆盖默认值', () => {
      const e = new ProactiveQuestionEngine({ dailyLimit: 5, cooldownMs: 1000 });
      const policy = e.getPolicy();
      expect(policy.dailyLimit).toBe(5);
      expect(policy.cooldownMs).toBe(1000);
      // 未覆盖的保持默认
      expect(policy.sessionLimit).toBe(DEFAULT_QUESTION_POLICY.sessionLimit);
    });
  });

  // ============ 频率控制 ============

  describe('canAsk 频率控制', () => {
    it('初始状态可以提问', () => {
      expect(engine.canAsk()).toBe(true);
    });

    it('每日上限阻止提问', async () => {
      const e = new ProactiveQuestionEngine({ dailyLimit: 1, cooldownMs: 0 }, createTempDataDir());
      await e.initialize();
      // 提问一次
      await e.askQuestion(contextWithGaps());
      // 第二次应被阻止
      expect(e.canAsk()).toBe(false);
    });

    it('冷却期阻止提问', async () => {
      const e = new ProactiveQuestionEngine({ cooldownMs: 10000, dailyLimit: 100 }, createTempDataDir());
      await e.initialize();
      await e.askQuestion(contextWithGaps());
      // 冷却期内不能提问
      expect(e.canAsk()).toBe(false);
    });

    it('会话内上限阻止提问', async () => {
      const e = new ProactiveQuestionEngine({ sessionLimit: 1, cooldownMs: 0, dailyLimit: 100 }, createTempDataDir());
      await e.initialize();
      const ctx = { ...contextWithGaps(), sessionId: 'session-1' };
      await e.askQuestion(ctx);
      // 同一会话第二次被阻止
      expect(e.canAsk('session-1')).toBe(false);
      // 不同会话仍可以
      expect(e.canAsk('session-2')).toBe(true);
    });

    it('冷却期过后可以提问', async () => {
      // cooldownMs 2000ms：并行测试下 saveData 的 I/O 可能耗时 500ms+，
      // askedAt 在 markAsAsked 中 saveData 之前设置，如果 I/O 耗时 > cooldownMs，
      // 则 canAsk 检查时 elapsed 已超过冷却期导致误判。
      // 生产默认 5 分钟冷却期不受此影响。
      const e = new ProactiveQuestionEngine({ cooldownMs: 2000, dailyLimit: 100 }, createTempDataDir());
      await e.initialize();
      await e.askQuestion(contextWithGaps());
      expect(e.canAsk()).toBe(false);
      // 等待冷却期
      await new Promise(resolve => setTimeout(resolve, 2100));
      expect(e.canAsk()).toBe(true);
    });
  });

  // ============ generateCandidates ============

  describe('generateCandidates', () => {
    it('空上下文无候选', () => {
      const candidates = engine.generateCandidates(emptyContext());
      expect(candidates).toHaveLength(0);
    });

    it('知识盲区生成候选', () => {
      const candidates = engine.generateCandidates(contextWithGaps());
      expect(candidates.length).toBe(2);
      expect(candidates.every(c => c.trigger === 'knowledge_gap')).toBe(true);
      expect(candidates.every(c => c.priority === 'high')).toBe(true);
    });

    it('错误模式达到阈值生成候选', () => {
      const candidates = engine.generateCandidates(contextWithErrors(3));
      expect(candidates).toHaveLength(1);
      expect(candidates[0].trigger).toBe('error_pattern');
      expect(candidates[0].priority).toBe('urgent');
    });

    it('错误模式未达阈值不生成候选', () => {
      const candidates = engine.generateCandidates(contextWithErrors(2));
      expect(candidates).toHaveLength(0);
    });

    it('兴趣达到权重阈值生成候选', () => {
      const candidates = engine.generateCandidates(contextWithInterests(0.8));
      expect(candidates).toHaveLength(1);
      expect(candidates[0].trigger).toBe('interest');
      expect(candidates[0].priority).toBe('medium');
    });

    it('兴趣未达权重阈值不生成候选', () => {
      const candidates = engine.generateCandidates(contextWithInterests(0.5));
      expect(candidates).toHaveLength(0);
    });

    it('任务失败生成澄清候选', () => {
      const candidates = engine.generateCandidates(contextWithTaskFailure());
      expect(candidates).toHaveLength(1);
      expect(candidates[0].trigger).toBe('clarification');
      expect(candidates[0].priority).toBe('urgent');
      expect(candidates[0].question).toContain('部署应用到生产环境');
    });

    it('优先级排序：urgent 在前', () => {
      const ctx: QuestionContext = {
        knowledgeGaps: [{ domain: 'TS', evidence: 'err', detectedAt: Date.now() }],
        errorPatterns: [{ pattern: 'null_err', count: 5, lastOccurrence: Date.now() }],
        interests: [{ topic: 'ML', weight: 0.9 }],
        currentTask: '测试任务',
        taskFailed: true,
      };
      const candidates = engine.generateCandidates(ctx);
      expect(candidates.length).toBeGreaterThanOrEqual(3);
      // urgent 优先级应排在前面
      expect(candidates[0].priority).toBe('urgent');
    });

    it('候选包含选项数组', () => {
      const candidates = engine.generateCandidates(contextWithGaps());
      expect(candidates[0].options).toBeDefined();
      expect(candidates[0].options!.length).toBeGreaterThan(0);
    });

    it('候选包含 sessionId', () => {
      const ctx = { ...contextWithGaps(), sessionId: 'test-session' };
      const candidates = engine.generateCandidates(ctx);
      expect(candidates[0].sessionId).toBe('test-session');
    });
  });

  // ============ getNextQuestion ============

  describe('getNextQuestion', () => {
    it('频率控制阻止时返回 null', async () => {
      const e = new ProactiveQuestionEngine({ dailyLimit: 0 }, createTempDataDir());
      await e.initialize();
      expect(e.getNextQuestion(contextWithGaps())).toBeNull();
    });

    it('无候选时返回 null', () => {
      expect(engine.getNextQuestion(emptyContext())).toBeNull();
    });

    it('返回最高优先级候选', () => {
      const ctx: QuestionContext = {
        knowledgeGaps: [{ domain: 'TS', evidence: 'err', detectedAt: Date.now() }],
        errorPatterns: [{ pattern: 'null_err', count: 5, lastOccurrence: Date.now() }],
        interests: [],
      };
      const q = engine.getNextQuestion(ctx);
      expect(q).not.toBeNull();
      expect(q!.priority).toBe('urgent'); // error_pattern 优先级最高
    });
  });

  // ============ askQuestion ============

  describe('askQuestion', () => {
    it('成功提问并返回问题', async () => {
      const q = await engine.askQuestion(contextWithGaps());
      expect(q).not.toBeNull();
      expect(q!.status).toBe('asked');
      expect(q!.askedAt).toBeDefined();
    });

    it('提问后 dailyCount 增加', async () => {
      await engine.askQuestion(contextWithGaps());
      const stats = engine.getStats();
      expect(stats.totalAsked).toBe(1);
    });

    it('频率控制阻止时返回 null', async () => {
      const e = new ProactiveQuestionEngine({ dailyLimit: 0 }, createTempDataDir());
      await e.initialize();
      const q = await e.askQuestion(contextWithGaps());
      expect(q).toBeNull();
    });
  });

  // ============ recordFeedback ============

  describe('recordFeedback', () => {
    it('记录 answered 反馈', async () => {
      const q = await engine.askQuestion(contextWithGaps());
      await engine.recordFeedback(q!.id, {
        type: 'answered',
        answer: '好的，请帮我梳理',
      });
      const questions = engine.getAllQuestions();
      expect(questions[0].status).toBe('answered');
      expect(questions[0].feedback?.type).toBe('answered');
      expect(questions[0].feedback?.answer).toBe('好的，请帮我梳理');
    });

    it('记录 ignored 反馈', async () => {
      const q = await engine.askQuestion(contextWithGaps());
      await engine.recordFeedback(q!.id, { type: 'ignored' });
      expect(engine.getAllQuestions()[0].status).toBe('ignored');
    });

    it('记录 declined 反馈', async () => {
      const q = await engine.askQuestion(contextWithGaps());
      await engine.recordFeedback(q!.id, { type: 'declined' });
      expect(engine.getAllQuestions()[0].status).toBe('declined');
    });

    it('记录 partial 反馈状态为 answered', async () => {
      const q = await engine.askQuestion(contextWithGaps());
      await engine.recordFeedback(q!.id, { type: 'partial', answer: '部分回答' });
      expect(engine.getAllQuestions()[0].status).toBe('answered');
    });

    it('记录 selectedOption', async () => {
      const q = await engine.askQuestion(contextWithGaps());
      await engine.recordFeedback(q!.id, {
        type: 'answered',
        selectedOption: '好的，请帮我梳理',
      });
      expect(engine.getAllQuestions()[0].feedback?.selectedOption).toBe('好的，请帮我梳理');
    });

    it('不存在的 questionId 不抛错', async () => {
      // 应静默处理
      await engine.recordFeedback('nonexistent', { type: 'answered' });
      expect(true).toBe(true);
    });
  });

  // ============ cleanExpired ============

  describe('cleanExpired', () => {
    it('过期问题标记为 expired', async () => {
      const e = new ProactiveQuestionEngine({ expirationMs: 50, cooldownMs: 0, dailyLimit: 100 }, createTempDataDir());
      await e.initialize();
      await e.askQuestion(contextWithGaps());
      // 等待过期
      await new Promise(resolve => setTimeout(resolve, 60));
      const expiredCount = await e.cleanExpired();
      expect(expiredCount).toBe(1);
      expect(engine.getAllQuestions().length).toBeGreaterThanOrEqual(0);
    });
  });

  // ============ getStats ============

  describe('getStats', () => {
    it('初始状态统计全为 0', () => {
      const stats = engine.getStats();
      expect(stats.totalAsked).toBe(0);
      expect(stats.totalAnswered).toBe(0);
      expect(stats.answerRate).toBe(0);
    });

    it('提问后统计更新', async () => {
      await engine.askQuestion(contextWithGaps());
      const stats = engine.getStats();
      expect(stats.totalAsked).toBe(1);
      expect(stats.totalAnswered).toBe(0);
    });

    it('回答后 answerRate 更新', async () => {
      const q = await engine.askQuestion(contextWithGaps());
      await engine.recordFeedback(q!.id, { type: 'answered' });
      const stats = engine.getStats();
      expect(stats.totalAsked).toBe(1);
      expect(stats.totalAnswered).toBe(1);
      expect(stats.answerRate).toBe(1);
    });

    it('byTrigger 按触发源分类统计', async () => {
      await engine.askQuestion(contextWithGaps()); // knowledge_gap
      const stats = engine.getStats();
      expect(stats.byTrigger.knowledge_gap.asked).toBe(1);
      expect(stats.byTrigger.error_pattern.asked).toBe(0);
    });

    it('lastAskedAt 记录最后提问时间', async () => {
      const q = await engine.askQuestion(contextWithGaps());
      const stats = engine.getStats();
      expect(stats.lastAskedAt).toBe(q!.askedAt);
    });
  });

  // ============ 查询方法 ============

  describe('查询方法', () => {
    it('getPendingQuestions 返回 pending 状态', async () => {
      // generateCandidates 生成的是 pending，但未添加到记录
      // 使用 addQuestion 手动添加
      await engine.addQuestion({
        trigger: 'knowledge_gap',
        priority: 'high',
        question: '测试问题',
        domain: 'test',
        reason: '测试',
      });
      const pending = engine.getPendingQuestions();
      expect(pending).toHaveLength(1);
      expect(pending[0].status).toBe('pending');
    });

    it('getUnansweredQuestions 返回 asked 状态', async () => {
      await engine.askQuestion(contextWithGaps());
      const unanswered = engine.getUnansweredQuestions();
      expect(unanswered).toHaveLength(1);
      expect(unanswered[0].status).toBe('asked');
    });

    it('getAllQuestions 返回所有记录', async () => {
      await engine.askQuestion(contextWithGaps());
      const all = engine.getAllQuestions();
      expect(all).toHaveLength(1);
    });
  });

  // ============ 会话管理 ============

  describe('会话管理', () => {
    it('resetSession 清除会话计数', async () => {
      const e = new ProactiveQuestionEngine({ sessionLimit: 1, cooldownMs: 0, dailyLimit: 100 }, createTempDataDir());
      await e.initialize();
      const ctx = { ...contextWithGaps(), sessionId: 's1' };
      await e.askQuestion(ctx);
      expect(e.canAsk('s1')).toBe(false);
      e.resetSession('s1');
      expect(e.canAsk('s1')).toBe(true);
    });
  });

  // ============ 策略管理 ============

  describe('策略管理', () => {
    it('getPolicy 返回当前策略', () => {
      const policy = engine.getPolicy();
      expect(policy.dailyLimit).toBe(DEFAULT_QUESTION_POLICY.dailyLimit);
      expect(policy.cooldownMs).toBe(DEFAULT_QUESTION_POLICY.cooldownMs);
    });

    it('updatePolicy 更新策略', () => {
      engine.updatePolicy({ dailyLimit: 20, cooldownMs: 2000 });
      const policy = engine.getPolicy();
      expect(policy.dailyLimit).toBe(20);
      expect(policy.cooldownMs).toBe(2000);
    });
  });

  // ============ addQuestion ============

  describe('addQuestion', () => {
    it('手动添加提问', async () => {
      const q = await engine.addQuestion({
        trigger: 'follow_up',
        priority: 'low',
        question: '跟进问题',
        domain: 'test',
        reason: '手动添加',
      });
      expect(q.id).toBeDefined();
      expect(q.status).toBe('pending');
      expect(engine.getAllQuestions()).toHaveLength(1);
    });
  });

  // ============ 数据持久化 ============

  describe('数据持久化', () => {
    it('提问后数据写入文件', async () => {
      await engine.askQuestion(contextWithGaps());
      const dataFile = path.join(tempDir, 'proactive-questions.json');
      expect(fs.existsSync(dataFile)).toBe(true);
      const raw = fs.readFileSync(dataFile, 'utf-8');
      const data = JSON.parse(raw);
      expect(data.questions).toHaveLength(1);
    });

    it('重新初始化加载数据', async () => {
      await engine.askQuestion(contextWithGaps());
      // 创建新实例加载同一目录
      const e2 = new ProactiveQuestionEngine({}, tempDir);
      await e2.initialize();
      expect(e2.getAllQuestions()).toHaveLength(1);
    });
  });

  // ============ LLM 工具定义 ============

  describe('getToolDefinitions', () => {
    it('返回 4 个工具定义', () => {
      const tools = engine.getToolDefinitions();
      expect(tools).toHaveLength(4);
    });

    it('工具名称正确', () => {
      const tools = engine.getToolDefinitions();
      const names = tools.map(t => t.name);
      expect(names).toContain('proactive_question_check');
      expect(names).toContain('proactive_question_feedback');
      expect(names).toContain('proactive_question_stats');
      expect(names).toContain('proactive_question_policy');
    });

    it('每个工具有 name/description/parameters/execute', () => {
      const tools = engine.getToolDefinitions();
      for (const tool of tools) {
        expect(tool.name).toBeDefined();
        expect(tool.description).toBeDefined();
        expect(tool.parameters).toBeDefined();
        expect(typeof tool.execute).toBe('function');
      }
    });
  });

  // ============ 单例 ============

  describe('单例', () => {
    it('getProactiveQuestionEngine 返回同一实例', () => {
      const e1 = getProactiveQuestionEngine();
      const e2 = getProactiveQuestionEngine();
      expect(e1).toBe(e2);
    });
  });

  // ============ 边缘情况 ============

  describe('边缘情况', () => {
    it('空知识盲区数组不生成候选', () => {
      const candidates = engine.generateCandidates({
        ...emptyContext(),
        knowledgeGaps: [],
      });
      expect(candidates).toHaveLength(0);
    });

    it('重复 domain 不重复提问（24小时内）', async () => {
      const ctx = contextWithGaps();
      // 第一次提问
      await engine.askQuestion(ctx);
      // 等待冷却期
      await new Promise(resolve => setTimeout(resolve, 10));
      // 第二次同 domain 应被过滤（generateCandidates 内检查 recentAsked）
      const candidates = engine.generateCandidates(ctx);
      // knowledgeGaps 有 2 个 domain，第一次提问消耗 1 个，剩 1 个
      // 但第一次提问的 domain 在 24h 内不重复，所以只返回未问过的那个
      expect(candidates.length).toBe(1);
    });

    it('clearAll 清空所有记录', async () => {
      await engine.askQuestion(contextWithGaps());
      expect(engine.getAllQuestions()).toHaveLength(1);
      await engine.clearAll();
      expect(engine.getAllQuestions()).toHaveLength(0);
    });

    it('数据目录不存在时自动创建', async () => {
      const nonexistentDir = path.join(tempDir, 'nonexistent-subdir');
      const e = new ProactiveQuestionEngine({}, nonexistentDir);
      await e.initialize();
      expect(fs.existsSync(nonexistentDir)).toBe(true);
    });
  });
});
