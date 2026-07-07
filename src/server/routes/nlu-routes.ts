import type express from 'express';
import { errMsg, type ServerContext } from '../services/app-context.js';

export function registerNluRoutes(app: express.Application, ctx: ServerContext): void {
  const {
    nluEngine, promptOptimizer, continuousLearning, performanceMetrics,
    getCachedResponse, setCachedResponse, contextMemory,
  } = ctx;

// POST /api/nlu/analyze - 自然语言理解分析
app.post('/api/nlu/analyze', (req: express.Request, res: express.Response) => {
  void (async () => {
    try {
      const { message, context } = req.body;
      if (!message) return res.status(400).json({ error: '消息不能为空' });
      const result = await nluEngine.analyze(message, context || []);
      res.json(result);
    } catch (error) {
      res.status(500).json({ error: errMsg(error) });
    }
  })();
});

// POST /api/prompt/optimize - 提示词优化
app.post('/api/prompt/optimize', (req: express.Request, res: express.Response) => {
  try {
    const { message } = req.body;
    if (!message) return res.status(400).json({ error: '消息不能为空' });
    const result = promptOptimizer.optimizePrompt(message, 'reasoning');
    res.json({ optimized: result.optimized, improvements: result.improvements, qualityScore: result.qualityScore });
  } catch (error) {
    res.status(500).json({ error: errMsg(error) });
  }
});

// POST /api/feedback - 用户反馈
app.post('/api/feedback', (req: express.Request, res: express.Response) => {
  try {
    const { taskId, originalInput, agentResponse, feedback, comment } = req.body;
    continuousLearning.learnKnowledge(
      `反馈-${taskId || Date.now()}`,
      `输入:${originalInput} 响应:${agentResponse} 反馈:${feedback} 评论:${comment}`,
      'feedback'
    ).catch(() => {});

    // P2-1: 反馈回流到 PersonalizationEngine — 之前此端点只路由到 continuousLearning，
    // 导致 profile.feedbackHistory 始终为空，反馈闭环断开。
    // 现在同步将反馈传入个性化引擎，触发 _applyFeedback 调整用户画像（详细程度/沟通风格）。
    if (feedback === 'positive' || feedback === 'negative') {
      try {
        const loop = ctx.loop as unknown as {
          recordUserFeedback?: (uid: string, fb: 'positive' | 'negative', ctx?: string, resp?: string) => void;
        } | undefined;
        if (loop?.recordUserFeedback) {
          loop.recordUserFeedback('default', feedback, originalInput, agentResponse);
        }
      } catch { /* 非关键路径，吞错避免阻塞反馈响应 */ }
    }

    res.json({ success: true, message: '反馈已记录' });
  } catch (error) {
    res.status(500).json({ error: errMsg(error) });
  }
});

// GET /api/learning/insights - 学习洞察
app.get('/api/learning/insights', (_req: express.Request, res: express.Response) => {
  try {
    const stats = continuousLearning.getLearningStats();
    res.json({ insights: stats, version: '2.0' });
  } catch (error) {
    res.status(500).json({ error: errMsg(error) });
  }
});

// GET /api/metrics - 性能指标（兼容前端格式）
app.get('/api/metrics', (_req: express.Request, res: express.Response) => {
  try {
    const cacheKey = `metrics_${Date.now() / 60000 | 0}`;
    const cached = getCachedResponse(cacheKey);
    if (cached) return res.json(cached);

    const current = performanceMetrics.getCurrentMetrics();
    const recommendations = performanceMetrics.getRecommendations();
    const phase1 = performanceMetrics.getPhaseProgress(1);
    const phase2 = performanceMetrics.getPhaseProgress(2);
    const phase3 = performanceMetrics.getPhaseProgress(3);

    const flatMetrics = {
      intentAccuracy: current.intentAccuracy,
      taskCompletionRate: current.taskCompletionRate,
      avgResponseTime: current.avgResponseTime,
      userSatisfaction: current.userSatisfaction / 5,
      toolCallSuccessRate: current.toolCallSuccessRate,
      contextCoherence: current.contextCoherence,
      selfCorrectionRate: current.selfCorrectionRate,
      totalInteractions: current.totalInteractions,
      recommendations,
      phases: {
        phase1: phase1.progress,
        phase2: phase2.progress,
        phase3: phase3.progress,
      },
    };

    setCachedResponse(cacheKey, flatMetrics);
    res.json(flatMetrics);
  } catch (error) {
    res.status(500).json({ error: errMsg(error) });
  }
});

// GET /api/user/profile - 用户画像（兼容前端格式）
app.get('/api/user/profile', (_req: express.Request, res: express.Response) => {
  try {
    const cacheKey = `user_profile_${Date.now() / 60000 | 0}`;
    const cached = getCachedResponse(cacheKey);
    if (cached) return res.json(cached);

    const profile = contextMemory.getUserProfile();
    const stats = contextMemory.getStats();

    const flatProfile = {
      techLevel: (() => {
        if (profile.technicalLevel === 'beginner') return '初级';
        if (profile.technicalLevel === 'intermediate') return '中级';
        if (profile.technicalLevel === 'advanced') return '高级';
        return '专家';
      })(),
      preferredLanguage: profile.preferredLanguage || '中文',
      communicationStyle: (() => {
        if (profile.communicationStyle === 'concise') return '简洁';
        if (profile.communicationStyle === 'detailed') return '详细';
        if (profile.communicationStyle === 'friendly') return '友好';
        return '正式';
      })(),
      activePeriod: '全天',
      preferences: profile.interests || [],
      commonTasks: (profile.frequentTasks && typeof profile.frequentTasks.entries === 'function'
        ? Array.from(profile.frequentTasks.entries() as IterableIterator<[string, number]>)
        : []
      )
        .sort((a: [string, number], b: [string, number]) => b[1] - a[1])
        .slice(0, 5)
        .map(([name, count]: [string, number]) => ({ name, count })),
      totalInteractions: profile.totalInteractions,
      lastActiveAt: profile.lastActiveAt,
      stats,
    };

    setCachedResponse(cacheKey, flatProfile);
    res.json(flatProfile);
  } catch (error) {
    res.status(500).json({ error: errMsg(error) });
  }
});

// GET /api/memory/search - 记忆检索
app.get('/api/memory/search', (req: express.Request, res: express.Response) => {
  try {
    const query = req.query.q as string;
    if (!query) return res.status(400).json({ error: '查询参数不能为空' });
    const results = contextMemory.retrieveMemories(query, 10);
    res.json({ results });
  } catch (error) {
    res.status(500).json({ error: errMsg(error) });
  }
});
}
