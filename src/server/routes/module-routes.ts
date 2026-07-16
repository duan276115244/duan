import type express from 'express';
import fs from 'fs';
import path from 'path';
import os from 'os';
import { errMsg, type ServerContext } from '../services/app-context.js';
import { getBestAvailableClient } from '../services/llm-clients.js';
import { atomicWriteJsonSync } from '../../core/atomic-write.js';

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

  // POST /api/skills/package - 打包技能（Web 模式对应 Electron 的 skill:package IPC）
  // eslint-disable-next-line @typescript-eslint/no-misused-promises
  app.post('/api/skills/package', (req: express.Request, res: express.Response) => {
    try {
      const { name, description, intent, toolsUsed, steps, keywords, examples, conversationSnippet } = req.body || {};
      if (!name || !description) {
        return res.status(400).json({ success: false, error: '技能名称和描述不能为空' });
      }
      // 安全校验技能名
      const skillId = name.toLowerCase().replace(/[^a-z0-9_-]/g, '-').replace(/-+/g, '-').replace(/^-|-$/g, '');
      if (!skillId || !/^[a-z0-9_-]+$/.test(skillId)) {
        return res.status(400).json({ success: false, error: '技能名称无效（仅允许小写字母、数字、下划线、连字符）' });
      }

      const homeDir = os.homedir();
      const skillDir = path.join(homeDir, '.duan', 'skills', skillId);
      if (!fs.existsSync(skillDir)) fs.mkdirSync(skillDir, { recursive: true });

      // 构建 SKILL.md 内容
      const kwList: string[] = Array.isArray(keywords) && keywords.length > 0
        ? keywords : [intent || description.substring(0, 20)];
      const exList: string[] = Array.isArray(examples) && examples.length > 0
        ? examples : [intent || description.substring(0, 50)];
      const toolList: string[] = Array.isArray(toolsUsed) ? toolsUsed : [];
      const stepList: string[] = Array.isArray(steps) && steps.length > 0 ? steps : [];

      // 生成 YAML frontmatter
      const yamlLines = [
        '---',
        `name: ${skillId}`,
        `id: ${skillId}`,
        `domain: general`,
        `description: ${description.replace(/\n/g, ' ')}`,
        'keywords:',
        ...kwList.map(k => `  - ${k}`),
        'examples:',
        ...exList.map(e => `  - ${e.replace(/\n/g, ' ')}`),
        '---',
      ];

      // 生成技能正文
      const bodyLines = [
        `# ${name}`,
        '',
        `## 技能描述`,
        description,
        '',
      ];

      if (toolList.length > 0) {
        bodyLines.push('## 使用工具', ...toolList.map(t => `- \`${t}\``), '');
      }

      if (stepList.length > 0) {
        bodyLines.push('## 执行步骤');
        stepList.forEach((step, i) => {
          bodyLines.push(`${i + 1}. ${step}`);
        });
        bodyLines.push('');
      }

      if (conversationSnippet) {
        bodyLines.push('## 成功案例', '```', conversationSnippet.substring(0, 2000), '```', '');
      }

      bodyLines.push('## 注意事项', '- 此技能从成功对话中自动打包生成', `- 创建时间: ${new Date().toISOString()}`);

      const skillMdContent = [...yamlLines, '', ...bodyLines].join('\n');
      const skillMdPath = path.join(skillDir, 'SKILL.md');
      fs.writeFileSync(skillMdPath, skillMdContent, 'utf-8');

      // 更新 discovered.json 注册表（使用原子写防止部分写入）
      const discoveredPath = path.join(homeDir, '.duan', 'skills', 'discovered.json');
      let discovered: unknown[] = [];
      try {
        if (fs.existsSync(discoveredPath)) {
          const raw = JSON.parse(fs.readFileSync(discoveredPath, 'utf-8'));
          discovered = Array.isArray(raw) ? raw : (raw.skills || []);
        }
      } catch { /* ignore */ }

      // 移除同 ID 旧记录
      const skillRecord = (s: unknown): string => {
        const sk = s as Record<string, unknown>;
        return (typeof sk.id === 'string' ? sk.id : '') || (typeof sk.name === 'string' ? sk.name : '');
      };
      discovered = discovered.filter(s => skillRecord(s) !== skillId);
      // 添加新记录
      discovered.push({
        id: skillId,
        name: skillId,
        domain: 'general',
        description,
        keywords: kwList,
        examples: exList,
        source: 'user_defined',
        confidence: 1.0,
        installStatus: 'installed',
        rating: 0,
        usageCount: 1,
        createdAt: Date.now(),
        updatedAt: Date.now(),
        toolsUsed: toolList,
      });

      const discoveredDir = path.dirname(discoveredPath);
      if (!fs.existsSync(discoveredDir)) fs.mkdirSync(discoveredDir, { recursive: true });
      atomicWriteJsonSync(discoveredPath, discovered);

      res.json({ success: true, skillId, path: skillMdPath });
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

  // GET /api/skills/marketplace - 获取技能市场列表
  // 注意：必须在 /api/skills/:id 之前注册，否则 "marketplace" 会被当作 :id 匹配
  app.get('/api/skills/marketplace', (req: express.Request, res: express.Response) => {
    try {
      const discoveredPath = path.join(os.homedir(), '.duan', 'skills', 'discovered.json');
      if (!fs.existsSync(discoveredPath)) {
        return res.json({ success: true, skills: [], total: 0, message: '暂无已发现的技能，请先运行技能发现' });
      }
      const raw = JSON.parse(fs.readFileSync(discoveredPath, 'utf-8'));
      let skills: unknown[] = Array.isArray(raw) ? raw : (raw.discovered || raw.skills || []);

      // 按相关性过滤（如果提供 query 参数 q）
      const query = req.query.q as string | undefined;
      if (query && typeof query === 'string' && query.trim()) {
        const q = query.toLowerCase();
        skills = skills.filter((s) => {
          const sk = s as Record<string, unknown>;
          return (
            (typeof sk.name === 'string' && sk.name.toLowerCase().includes(q)) ||
            (typeof sk.description === 'string' && sk.description.toLowerCase().includes(q)) ||
            (Array.isArray(sk.keywords) && sk.keywords.some((k) => typeof k === 'string' && k.toLowerCase().includes(q)))
          );
        });
      }

      // 按置信度和评分排序
      skills.sort((a, b) => {
        const sa = a as Record<string, number>;
        const sb = b as Record<string, number>;
        const scoreA = (sa.confidence || 0) * 0.6 + ((sa.rating || 0) / 5) * 0.4;
        const scoreB = (sb.confidence || 0) * 0.6 + ((sb.rating || 0) / 5) * 0.4;
        return scoreB - scoreA;
      });

      res.json({ success: true, skills, total: skills.length });
    } catch (error) {
      res.status(500).json({ success: false, error: errMsg(error) });
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
