// ============================================================
// Consciousness & Misc Route Handlers — consciousness,
// self-awareness, values, goals, heartbeat, sub-agents,
// self-evolve, strategy-engine, skills, assessment, plans,
// 404 handler, error handler, SPA fallback
// ============================================================

import type express from 'express';
import path from 'path';
import { fileURLToPath } from 'url';
import { errMsg, type ServerContext } from '../services/app-context.js';

export function registerConsciousnessRoutes(app: express.Application, ctx: ServerContext): void {
  const {
    cognitiveState, selfAwareness, valueSystem, goalSystem,
    subAgentOrchestrator, heartbeat, selfEvolve, strategyEngine,
    skillExtractor, selfAssessment, taskPlanner,
  } = ctx;

  const __filename = fileURLToPath(import.meta.url);
  const __dirname = path.dirname(__filename);
// ============================================================
// 自主意识系统 API
// ============================================================

// GET /api/consciousness - 获取认知状态
app.get('/api/consciousness', (_req: express.Request, res: express.Response) => {
  try {
    const state = cognitiveState.getState();
    const moodHist = cognitiveState.getMoodHistory(10);
    const thoughts = cognitiveState.getRecentThoughts(5);
    res.json({ state, moodHistory: moodHist, recentThoughts: thoughts, moodDescription: cognitiveState.getMoodDescription() });
  } catch (error) {
    res.status(500).json({ error: errMsg(error) });
  }
});

// GET /api/consciousness/mood-history - 获取情绪历史
app.get('/api/consciousness/mood-history', (_req: express.Request, res: express.Response) => {
  try {
    res.json(cognitiveState.getMoodHistory(20));
  } catch (error) {
    res.status(500).json({ error: errMsg(error) });
  }
});

// GET /api/self-awareness - 获取自我认知
app.get('/api/self-awareness', (_req: express.Request, res: express.Response) => {
  try {
    res.json({
      model: {
        name: selfAwareness.getName(),
        version: selfAwareness.getVersion(),
        evolutionLevel: selfAwareness.getEvolutionLevel(),
      },
      capabilities: selfAwareness.getCapabilities(),
      insights: selfAwareness.getInsights().slice(-10),
      limitations: selfAwareness.getLimitations(),
      summary: selfAwareness.getSelfSummary(),
    });
  } catch (error) {
    res.status(500).json({ error: errMsg(error) });
  }
});

// GET /api/values - 获取价值观报告
app.get('/api/values', (_req: express.Request, res: express.Response) => {
  try {
    res.json({
      values: valueSystem.getValues(),
      decisionLog: valueSystem.getDecisionLog(10),
      conflicts: valueSystem.getConflictingValues(),
      report: valueSystem.getValueReport(),
    });
  } catch (error) {
    res.status(500).json({ error: errMsg(error) });
  }
});

// POST /api/values/judge - 判断行动是否符合价值观
app.post('/api/values/judge', (req: express.Request, res: express.Response) => {
  try {
    const { action, context } = req.body;
    if (!action) return res.status(400).json({ error: '请提供action' });
    const judgment = valueSystem.judgeAction(action, context || '');
    res.json(judgment);
  } catch (error) {
    res.status(500).json({ error: errMsg(error) });
  }
});

// GET /api/goals - 获取目标系统状态
app.get('/api/goals', (_req: express.Request, res: express.Response) => {
  try {
    res.json({
      stats: goalSystem.getStats(),
      activeGoals: goalSystem.getActiveGoals(),
      nextTask: goalSystem.getNextTask(),
      allGoals: goalSystem.getAllGoals(),
    });
  } catch (error) {
    res.status(500).json({ error: errMsg(error) });
  }
});

// POST /api/goals/create - 创建新目标
app.post('/api/goals/create', (req: express.Request, res: express.Response) => {
  try {
    const { title, description, priority, deadline, valueAlignment, tags } = req.body;
    if (!title) return res.status(400).json({ error: '请提供title' });
    const goal = goalSystem.createGoal({ title, description: description || title, priority, deadline, valueAlignment, tags });
    goalSystem.activateGoal(goal.id);
    res.json(goal);
  } catch (error) {
    res.status(500).json({ error: errMsg(error) });
  }
});

// POST /api/goals/:id/progress - 更新目标进度
app.post('/api/goals/:id/progress', (req: express.Request, res: express.Response) => {
  try {
    const { progress, note } = req.body;
    goalSystem.updateProgress(req.params.id, progress, note);
    res.json({ success: true });
  } catch (error) {
    res.status(500).json({ error: errMsg(error) });
  }
});

// POST /api/goals/:id/decompose - 分解目标为子目标
app.post('/api/goals/:id/decompose', (req: express.Request, res: express.Response) => {
  try {
    const { subgoals } = req.body;
    if (!subgoals || !Array.isArray(subgoals)) return res.status(400).json({ error: '请提供subgoals数组' });
    const created = goalSystem.decomposeGoal(req.params.id, subgoals);
    res.json(created);
  } catch (error) {
    res.status(500).json({ error: errMsg(error) });
  }
});

// GET /api/heartbeat - 获取心跳状态
app.get('/api/heartbeat', (_req: express.Request, res: express.Response) => {
  try {
    res.json({
      running: heartbeat.isRunning(),
      beatCount: heartbeat.getBeatCount(),
      uptime: heartbeat.getUptime(),
      uptimeMinutes: Math.round(heartbeat.getUptime() / 1000 / 60),
    });
  } catch (error) {
    res.status(500).json({ error: errMsg(error) });
  }
});

// POST /api/heartbeat/start - 启动心跳
app.post('/api/heartbeat/start', (_req: express.Request, res: express.Response) => {
  try {
    heartbeat.start();
    res.json({ status: 'started' });
  } catch (error) {
    res.status(500).json({ error: errMsg(error) });
  }
});

// POST /api/heartbeat/stop - 停止心跳
app.post('/api/heartbeat/stop', (_req: express.Request, res: express.Response) => {
  try {
    heartbeat.stop();
    res.json({ status: 'stopped' });
  } catch (error) {
    res.status(500).json({ error: errMsg(error) });
  }
});

// GET /api/sub-agents - 获取子Agent状态
app.get('/api/sub-agents', (_req: express.Request, res: express.Response) => {
  try {
    res.json({
      workers: subAgentOrchestrator.getAllWorkers(),
      report: subAgentOrchestrator.getStatusReport(),
      maxConcurrent: subAgentOrchestrator.getMaxConcurrent(),
      runningCount: subAgentOrchestrator.getRunningCount(),
    });
  } catch (error) {
    res.status(500).json({ error: errMsg(error) });
  }
});

// ============================================================
// 自进化系统 API
// ============================================================

// GET /api/self-evolve/analyze - 分析项目可改进项
app.get('/api/self-evolve/analyze', (_req: express.Request, res: express.Response) => {
  try {
    const actions = selfEvolve.analyzeProject();
    res.json({
      total: actions.length,
      byPriority: {
        critical: actions.filter((a: { priority: string }) => a.priority === 'critical').length,
        high: actions.filter((a: { priority: string }) => a.priority === 'high').length,
        medium: actions.filter((a: { priority: string }) => a.priority === 'medium').length,
        low: actions.filter((a: { priority: string }) => a.priority === 'low').length,
      },
      actions: actions.slice(0, 20),
    });
  } catch (error) {
    res.status(500).json({ error: errMsg(error) });
  }
});

// POST /api/self-evolve/run - 执行一轮进化
app.post('/api/self-evolve/run', (req: express.Request, res: express.Response) => {
  void (async () => {
    try {
      const { focus } = req.body || {};
      cognitiveState.setMood('focused', 'self_evolve');
      cognitiveState.think('进入自进化模式', 'self_evolve');
      const cycle = await selfEvolve.runCycle(focus);
      cognitiveState.think(`自进化完成: ${cycle.summary}`, 'self_evolve');
      if (cycle.successCount > 0) cognitiveState.onDiscovery();
      res.json(cycle);
    } catch (error) {
      res.status(500).json({ error: errMsg(error) });
    }
  })();
});

// GET /api/self-evolve/history - 进化历史
app.get('/api/self-evolve/history', (_req: express.Request, res: express.Response) => {
  try {
    res.json({
      history: selfEvolve.getHistory(),
      stats: selfEvolve.getStats(),
      report: selfEvolve.getEvolutionReport(),
    });
  } catch (error) {
    res.status(500).json({ error: errMsg(error) });
  }
});

// ============================================================
// 策略引擎 API
// ============================================================

// GET /api/strategy-engine - 获取策略引擎状态
app.get('/api/strategy-engine', (_req: express.Request, res: express.Response) => {
  try {
    res.json({
      currentStrategy: strategyEngine.getCurrentStrategy(),
      availableStrategies: strategyEngine.getAvailableStrategies(),
      stats: strategyEngine.getStats(),
    });
  } catch (error) {
    res.status(500).json({ error: errMsg(error) });
  }
});

// POST /api/strategy-engine/switch - 切换策略
app.post('/api/strategy-engine/switch', (req: express.Request, res: express.Response) => {
  try {
    const { context } = req.body || {};
    const strategy = strategyEngine.switchStrategy(context);
    res.json({ strategy, prompt: strategyEngine.getStrategyPrompt(context) });
  } catch (error) {
    res.status(500).json({ error: errMsg(error) });
  }
});

// POST /api/strategy-engine/report - 报告策略执行结果
app.post('/api/strategy-engine/report', (req: express.Request, res: express.Response) => {
  try {
    const { success } = req.body;
    if (typeof success !== 'boolean') return res.status(400).json({ error: '请提供 success (boolean)' });
    strategyEngine.reportResult(success);
    res.json({ success: true, stats: strategyEngine.getStats() });
  } catch (error) {
    res.status(500).json({ error: errMsg(error) });
  }
});

// ============================================================
// 技能萃取 API
// ============================================================

// GET /api/skills - 获取所有技能（返回数组，字段映射为前端 SkillMeta 格式）
app.get('/api/skills', (req: express.Request, res: express.Response) => {
  try {
    const { category, tag, top } = req.query;
    const skills = skillExtractor.getSkills({
      category: category as string | undefined,
      tag: tag as string | undefined,
      top: top ? parseInt(top as string, 10) : undefined,
    });
    // 映射为前端期望的 SkillMeta 格式：successRate/usageCount 由 successCount/failCount 计算
    const mapped = skills.map(s => {
      const total = s.successCount + s.failCount;
      return {
        id: s.id,
        name: s.name,
        version: '1.0.0',
        description: s.description,
        category: s.category,
        tags: s.tags,
        successRate: total > 0 ? s.successCount / total : 0,
        usageCount: total,
        createdAt: s.created,
        updatedAt: s.lastUsed,
      };
    });
    res.json(mapped);
  } catch (error) {
    res.status(500).json({ error: errMsg(error) });
  }
});

// POST /api/skills/extract - 手动萃取技能
app.post('/api/skills/extract', (req: express.Request, res: express.Response) => {
  try {
    const { name, description, category, steps, toolsUsed, tags } = req.body;
    if (!name || !description) return res.status(400).json({ error: '请提供 name 和 description' });
    const skill = skillExtractor.extractSkill({
      name, description, category: category || 'general',
      steps: steps || [], toolsUsed: toolsUsed || [], tags: tags || [],
    });
    res.json(skill);
  } catch (error) {
    res.status(500).json({ error: errMsg(error) });
  }
});

// POST /api/skills/auto-extract - 从任务自动萃取
app.post('/api/skills/auto-extract', (req: express.Request, res: express.Response) => {
  try {
    const { taskDescription, toolsUsed, result } = req.body;
    if (!taskDescription) return res.status(400).json({ error: '请提供 taskDescription' });
    const skill = skillExtractor.autoExtract(taskDescription, toolsUsed || [], result || '');
    res.json({ skill, extracted: !!skill });
  } catch (error) {
    res.status(500).json({ error: errMsg(error) });
  }
});

// ============================================================
// 自评估 API
// ============================================================

// GET /api/assessment - 获取自评估报告
app.get('/api/assessment', (_req: express.Request, res: express.Response) => {
  try {
    const report = selfAssessment.generateReport();
    res.json({
      ...report,
      formatted: selfAssessment.getFormattedReport(),
    });
  } catch (error) {
    res.status(500).json({ error: errMsg(error) });
  }
});

// POST /api/assessment/record - 记录指标
app.post('/api/assessment/record', (req: express.Request, res: express.Response) => {
  try {
    const { key, value } = req.body;
    if (!key || typeof value !== 'number') return res.status(400).json({ error: '请提供 key 和 value (number)' });
    selfAssessment.record(key, value);
    res.json({ success: true });
  } catch (error) {
    res.status(500).json({ error: errMsg(error) });
  }
});

// POST /api/assessment/record-task - 记录任务完成
app.post('/api/assessment/record-task', (req: express.Request, res: express.Response) => {
  try {
    const { success } = req.body;
    if (typeof success !== 'boolean') return res.status(400).json({ error: '请提供 success (boolean)' });
    selfAssessment.recordTaskCompletion(success);
    res.json({ success: true });
  } catch (error) {
    res.status(500).json({ error: errMsg(error) });
  }
});

// ============================================================
// 任务规划 API
// ============================================================

// GET /api/plans - 获取所有计划
app.get('/api/plans', (_req: express.Request, res: express.Response) => {
  try {
    const plans = taskPlanner.getAllPlans();
    res.json({
      total: plans.length,
      active: taskPlanner.getActivePlans().length,
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      plans: plans.map((p: Record<string, any>) => ({
        id: p.id,
        name: p.name,
        goal: (p.goal || '').substring(0, 100),
        status: p.status,
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        progress: Array.isArray(p.steps) && p.steps.length > 0 ? Math.round(p.steps.filter((s: Record<string, any>) => s.status === 'completed' || s.status === 'skipped').length / p.steps.length * 100) : 0,
        stepCount: Array.isArray(p.steps) ? p.steps.length : 0,
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        completedSteps: Array.isArray(p.steps) ? p.steps.filter((s: Record<string, any>) => s.status === 'completed' || s.status === 'skipped').length : 0,
        createdAt: p.createdAt,
      })),
    });
  } catch (error) {
    res.status(500).json({ error: errMsg(error) });
  }
});

// GET /api/plans/:id - 获取计划详情
app.get('/api/plans/:id', (req: express.Request, res: express.Response) => {
  try {
    const plan = taskPlanner.getPlan(req.params.id);
    if (!plan) return res.status(404).json({ error: '计划不存在' });
    res.json({
      ...plan,
      progress: taskPlanner.getProgress(req.params.id),
      nextSteps: taskPlanner.getNextSteps(req.params.id),
    });
  } catch (error) {
    res.status(500).json({ error: errMsg(error) });
  }
});

// POST /api/plans/create - 创建计划
app.post('/api/plans/create', (req: express.Request, res: express.Response) => {
  try {
    const { name, goal, steps } = req.body;
    if (!name || !goal || !steps) return res.status(400).json({ error: '请提供 name, goal, steps' });
    const plan = taskPlanner.createPlan(name, goal, steps);
    res.json(plan);
  } catch (error) {
    res.status(500).json({ error: errMsg(error) });
  }
});

// POST /api/plans/:id/step - 更新步骤状态
app.post('/api/plans/:id/step', (req: express.Request, res: express.Response) => {
  try {
    const { stepId, status, result, error } = req.body;
    if (!stepId || !status) return res.status(400).json({ error: '请提供 stepId 和 status' });
    const plan = taskPlanner.updateStep(req.params.id, stepId, { status, result, error });
    if (!plan) return res.status(404).json({ error: '计划或步骤不存在' });
    res.json({ plan, progress: taskPlanner.getProgress(req.params.id) });
  } catch (error) {
    res.status(500).json({ error: errMsg(error) });
  }
});

// ============================================================
// P0-1 修复：移除重复的 404 处理器、全局错误处理器和 SPA fallback
// 这些全局处理器由 middleware.ts 的 setupErrorHandlers() 统一注册，
// 必须在所有路由之后才注册。原代码在此处注册导致后续的
// module-routes 和 voice-routes 全部成为死代码（404 处理器不调用 next()）。
// ============================================================
}