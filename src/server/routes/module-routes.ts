import type express from 'express';
import { errMsg, type ServerContext } from '../services/app-context.js';
import { getBestAvailableClient } from '../services/llm-clients.js';

export function registerModuleRoutes(app: express.Application, ctx: ServerContext): void {
  const { learningEval, skillGen, userProfile, performanceMetrics } = ctx;

  // ===== 学习效率评估 API =====

  // GET /api/eval/report - 获取评估报告
  app.get('/api/eval/report', (_req: express.Request, res: express.Response) => {
    try {
      const report = learningEval.generateReport();
      res.json(report);
    } catch (error) {
      res.status(500).json({ error: errMsg(error) });
    }
  });

  // GET /api/eval/abtests - 获取所有A/B测试
  app.get('/api/eval/abtests', (_req: express.Request, res: express.Response) => {
    try {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const tests = Array.from((learningEval as any).abTests?.values() || []);
      res.json(tests);
    } catch (error) {
      res.status(500).json({ error: errMsg(error) });
    }
  });

  // GET /api/eval/snapshots - 获取评估快照（趋势图用）
  app.get('/api/eval/snapshots', (_req: express.Request, res: express.Response) => {
    try {
      const limit = _req.query.limit ? parseInt(_req.query.limit as string, 10) : undefined;
      const offset = _req.query.offset ? parseInt(_req.query.offset as string, 10) : undefined;
      const snapshots = learningEval.getSnapshots(limit, offset);
      res.json(snapshots);
    } catch (error) {
      res.status(500).json({ error: errMsg(error) });
    }
  });

  // GET /api/eval/snapshots/count - 获取快照总数
  app.get('/api/eval/snapshots/count', (_req: express.Request, res: express.Response) => {
    try {
      res.json({ count: learningEval.getSnapshotCount() });
    } catch (error) {
      res.status(500).json({ error: errMsg(error) });
    }
  });

  // GET /api/performance/metrics - 获取性能指标
  app.get('/api/performance/metrics', (_req: express.Request, res: express.Response) => {
    try {
      const metrics = performanceMetrics.getCurrentMetrics();
      res.json(metrics);
    } catch (error) {
      res.status(500).json({ error: errMsg(error) });
    }
  });

  // GET /api/performance/sla - 获取SLA达标状态（基线对比）
  app.get('/api/performance/sla', (_req: express.Request, res: express.Response) => {
    try {
      const snapshots = performanceMetrics.getAllSnapshots();
      const current = performanceMetrics.getCurrentMetrics();
      let phase: number;
      if (snapshots.length < 100) {
        phase = 1;
      } else if (snapshots.length < 500) {
        phase = 2;
      } else {
        phase = 3;
      }
      const progress = performanceMetrics.getPhaseProgress(phase);

      let slaStatus: {
        taskCompletionRate: { current: number; baseline: number; target: number; improvement: number; met: boolean };
        userSatisfaction: { current: number; baseline: number; target: number; improvement: number; met: boolean };
        avgResponseTime: { current: number; baseline: number; target: number; improvement: number; met: boolean };
        overall: { progress: number; phase: string };
      };

      if (snapshots.length < 2) {
        const zero = { current: 0, baseline: 0, target: 0, improvement: 0, met: false };
        slaStatus = {
          taskCompletionRate: zero, userSatisfaction: zero, avgResponseTime: zero,
          overall: { progress: progress.progress, phase: progress.target.name },
        };
      } else {
        const baselineCount = Math.min(10, Math.floor(snapshots.length / 2));
        const baselineSnapshots = snapshots.slice(0, baselineCount);
        const baseline = {
          taskCompletionRate: baselineSnapshots.reduce((s, r) => s + r.taskCompletionRate, 0) / baselineCount,
          userSatisfaction: baselineSnapshots.reduce((s, r) => s + r.userSatisfaction, 0) / baselineCount,
          avgResponseTime: baselineSnapshots.reduce((s, r) => s + r.avgResponseTime, 0) / baselineCount,
        };

        const makeStatus = (
          key: 'taskCompletionRate' | 'userSatisfaction' | 'avgResponseTime',
          targetImprovement: number,
          lowerBetter: boolean,
        ) => {
          const cur = current[key];
          const base = baseline[key];
          let improvement: number;
          if (base > 0) {
            improvement = lowerBetter ? ((base - cur) / base) : ((cur - base) / base);
          } else {
            improvement = 0;
          }
          const target = lowerBetter ? base * (1 - targetImprovement) : base * (1 + targetImprovement);
          return { current: cur, baseline: base, target, improvement, met: lowerBetter ? cur <= target : cur >= target };
        };

        slaStatus = {
          taskCompletionRate: makeStatus('taskCompletionRate', 0.20, false),
          userSatisfaction: makeStatus('userSatisfaction', 0.15, false),
          avgResponseTime: makeStatus('avgResponseTime', 0.30, true),
          overall: { progress: progress.progress, phase: progress.target.name },
        };
      }

      res.json(slaStatus);
    } catch (error) {
      res.status(500).json({ error: errMsg(error) });
    }
  });

  // POST /api/eval/abtest - 创建A/B测试
  app.post('/api/eval/abtest', (req: express.Request, res: express.Response) => {
    try {
      const { id, variantA, variantB, dimension, minSampleSize } = req.body;
      if (!id || !variantA || !variantB) return res.status(400).json({ error: '缺少必填参数: id, variantA, variantB' });
      const test = learningEval.createABTest({
        id, variantA, variantB,
        dimension: dimension || 'accuracy',
        minSampleSize: minSampleSize || 30,
      });
      res.json(test);
    } catch (error) {
      res.status(500).json({ error: errMsg(error) });
    }
  });

  // ===== 技能生成 API =====

  // POST /api/skills/generate - 通过自然语言描述生成新技能（真正调用 LLM + SkillGenerator）
  // eslint-disable-next-line @typescript-eslint/no-misused-promises
  app.post('/api/skills/generate', async (req: express.Request, res: express.Response) => {
    try {
      const { description } = req.body || {};
      if (!description || typeof description !== 'string' || description.trim().length < 3) {
        return res.status(400).json({ success: false, error: '技能描述不能为空（至少 3 个字符）' });
      }

      // 获取可用的 LLM 客户端
      const client = getBestAvailableClient();
      if (!client) {
        return res.status(503).json({ success: false, error: '没有可用的 LLM 客户端，请先配置 API Key' });
      }

      // llmCall 函数：调用 LLM 生成文本
      const llmCall = async (prompt: string): Promise<string | null> => {
        try {
          // eslint-disable-next-line @typescript-eslint/no-explicit-any
          const openaiClient = client.client as any;
          const resp = await openaiClient.chat.completions.create({
            model: client.model,
            messages: [{ role: 'user', content: prompt }],
            temperature: 0.7,
            max_tokens: 2000,
          });
          return resp?.choices?.[0]?.message?.content || null;
        } catch (e) {
          console.error('[skills/generate] LLM 调用失败:', e);
          return null;
        }
      };

      // 调用 SkillGenerator 生成技能
      const meta = await skillGen.generateFromNL(description.trim(), llmCall);
      if (!meta) {
        return res.status(500).json({ success: false, error: '技能生成失败，LLM 可能未返回有效内容' });
      }

      res.json({ success: true, skill: meta });
    } catch (error) {
      res.status(500).json({ success: false, error: errMsg(error) });
    }
  });

  // GET /api/skills - 列出所有技能
  app.get('/api/skills', (_req: express.Request, res: express.Response) => {
    try {
      const skills = skillGen.listSkills();
      res.json(skills);
    } catch (error) {
      res.status(500).json({ error: errMsg(error) });
    }
  });

  // GET /api/skills/:id - 获取技能详情
  app.get('/api/skills/:id', (req: express.Request, res: express.Response) => {
    try {
      const meta = skillGen.getSkill(req.params.id);
      if (!meta) return res.status(404).json({ error: '技能不存在' });
      const content = skillGen.getSkillContent(req.params.id);
      res.json({ meta, content });
    } catch (error) {
      res.status(500).json({ error: errMsg(error) });
    }
  });

  // GET /api/skills/:id/versions - 技能版本历史
  app.get('/api/skills/:id/versions', (req: express.Request, res: express.Response) => {
    try {
      const versions = skillGen.getVersionHistory(req.params.id);
      res.json(versions);
    } catch (error) {
      res.status(500).json({ error: errMsg(error) });
    }
  });

  // GET /api/skills/:id/quality - 技能质量报告
  app.get('/api/skills/:id/quality', (req: express.Request, res: express.Response) => {
    try {
      const report = skillGen.generateQualityReport(req.params.id);
      if (!report) return res.status(404).json({ error: '技能不存在' });
      res.json(report);
    } catch (error) {
      res.status(500).json({ error: errMsg(error) });
    }
  });

  // POST /api/skills/:id/rollback - 回滚技能
  app.post('/api/skills/:id/rollback', (req: express.Request, res: express.Response) => {
    try {
      const { version } = req.body;
      if (!version) return res.status(400).json({ error: '缺少版本号' });
      const ok = skillGen.rollback(req.params.id, version);
      if (!ok) return res.status(400).json({ error: '回滚失败，请检查版本号' });
      res.json({ success: true, message: `已回滚 ${req.params.id} 到 ${version}` });
    } catch (error) {
      res.status(500).json({ error: errMsg(error) });
    }
  });

  // DELETE /api/skills/:id - 删除技能
  app.delete('/api/skills/:id', (req: express.Request, res: express.Response) => {
    try {
      const ok = skillGen.deleteSkill(req.params.id);
      if (!ok) return res.status(400).json({ error: '删除失败' });
      res.json({ success: true });
    } catch (error) {
      res.status(500).json({ error: errMsg(error) });
    }
  });

  // ===== 用户画像 API =====
  // 注意：具体路径必须注册在 :userId 参数路由之前，否则会被参数路由拦截

  // GET /api/profile/prediction-accuracy - 获取预测准确率报告
  app.get('/api/profile/prediction-accuracy', (_req: express.Request, res: express.Response) => {
    try {
      const report = userProfile.getPredictionAccuracyReport();
      res.json(report);
    } catch (error) {
      res.status(500).json({ error: errMsg(error) });
    }
  });

  // GET /api/profile/recommendation-stats - 获取推荐统计
  app.get('/api/profile/recommendation-stats', (_req: express.Request, res: express.Response) => {
    try {
      const stats = userProfile.getRecommendationStats();
      res.json(stats);
    } catch (error) {
      res.status(500).json({ error: errMsg(error) });
    }
  });

  // GET /api/profile/:userId - 获取用户画像
  app.get('/api/profile/:userId', (req: express.Request, res: express.Response) => {
    try {
      const profile = userProfile.getProfile(req.params.userId);
      res.json(profile);
    } catch (error) {
      res.status(500).json({ error: errMsg(error) });
    }
  });

  // GET /api/profile/:userId/predict - 预测用户意图
  app.get('/api/profile/:userId/predict', (req: express.Request, res: express.Response) => {
    try {
      const profile = userProfile.getProfile(req.params.userId);
      res.json(profile.predictions);
    } catch (error) {
      res.status(500).json({ error: errMsg(error) });
    }
  });

  // POST /api/profile/:userId/sync - 同步数据到画像
  app.post('/api/profile/:userId/sync', (req: express.Request, res: express.Response) => {
    try {
      const { sourceType, data } = req.body;
      if (!sourceType || !data) return res.status(400).json({ error: '缺少必填参数: sourceType, data' });
      userProfile.syncFromSource(req.params.userId, { type: sourceType, data });
      res.json({ success: true, message: '画像已同步' });
    } catch (error) {
      res.status(500).json({ error: errMsg(error) });
    }
  });

  // POST /api/profile/:userId/recommendation-feedback - 记录推荐反馈
  app.post('/api/profile/:userId/recommendation-feedback', (req: express.Request, res: express.Response) => {
    try {
      const { serviceName, rating } = req.body;
      if (!serviceName || rating === undefined) return res.status(400).json({ error: '缺少必填参数: serviceName, rating' });
      userProfile.recordRecommendationFeedback(req.params.userId, serviceName, rating);
      res.json({ success: true, message: '推荐反馈已记录' });
    } catch (error) {
      res.status(500).json({ error: errMsg(error) });
    }
  });

  // POST /api/profile/:userId/intent - 记录用户意图
  app.post('/api/profile/:userId/intent', (req: express.Request, res: express.Response) => {
    try {
      const { intent } = req.body;
      if (!intent) return res.status(400).json({ error: '缺少意图描述' });
      userProfile.recordIntent(req.params.userId, intent);
      res.json({ success: true });
    } catch (error) {
      res.status(500).json({ error: errMsg(error) });
    }
  });
}
