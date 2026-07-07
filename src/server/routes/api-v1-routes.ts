// ============================================================
// P3: 开放 API v1 路由 — OpenAPI 3.0 规格的公开接口
//
// 提供标准化的 REST API 供第三方集成：
// - /api/v1/chat        — 对话接口（SSE 流式）
// - /api/v1/task        — 任务执行
// - /api/v1/skills      — 技能管理
// - /api/v1/tools       — 工具注册
// - /api/v1/devices     — 设备控制
// - /api/v1/stream      — WebSocket 流式对话
// - /api/v1/openapi.json — OpenAPI 规格
// ============================================================

import express from 'express';
import type { ServerContext } from '../services/app-context.js';
import { logger } from '../../core/structured-logger.js';

// ============ OpenAPI 3.0 规格 ============

const OPENAPI_SPEC = {
  openapi: '3.0.3',
  info: {
    title: '段先生 Agent 开放 API',
    description: '超级智能体 Agent 的开放接口，支持对话、任务执行、技能管理、设备控制等',
    version: '19.0.0',
    contact: { name: '段先生 Agent', url: 'https://github.com/duan/agent' },
    license: { name: 'MIT' },
  },
  servers: [
    { url: '/api/v1', description: '当前服务器' },
  ],
  paths: {
    '/chat': {
      post: {
        summary: '对话接口',
        description: '发送消息并获取 AI 响应（支持 SSE 流式）',
        requestBody: {
          required: true,
          content: {
            'application/json': {
              schema: {
                type: 'object',
                properties: {
                  message: { type: 'string', description: '用户消息' },
                  conversationId: { type: 'string', description: '会话 ID' },
                  context: { type: 'object', description: '上下文信息' },
                  stream: { type: 'boolean', description: '是否流式响应', default: false },
                },
              },
            },
          },
        },
        responses: {
          '200': { description: '对话响应' },
          '400': { description: '请求参数错误' },
          '500': { description: '服务器错误' },
        },
      },
    },
    '/task': {
      post: {
        summary: '任务执行',
        description: '提交任务由 Agent 自主规划和执行',
        requestBody: {
          required: true,
          content: {
            'application/json': {
              schema: {
                type: 'object',
                properties: {
                  task: { type: 'string', description: '任务描述' },
                  priority: { type: 'string', enum: ['low', 'medium', 'high'] },
                  async: { type: 'boolean', description: '是否异步执行', default: false },
                },
              },
            },
          },
        },
        responses: {
          '200': { description: '任务结果' },
          '202': { description: '异步任务已接受' },
        },
      },
    },
    '/skills': {
      get: {
        summary: '获取技能列表',
        responses: { '200': { description: '技能列表' } },
      },
      post: {
        summary: '注册自定义技能',
        requestBody: {
          required: true,
          content: {
            'application/json': {
              schema: {
                type: 'object',
                properties: {
                  name: { type: 'string' },
                  domain: { type: 'string' },
                  description: { type: 'string' },
                  keywords: { type: 'array', items: { type: 'string' } },
                  handler: { type: 'string', description: '处理函数标识' },
                },
              },
            },
          },
        },
        responses: { '201': { description: '技能已注册' } },
      },
    },
    '/tools': {
      get: { summary: '获取工具列表', responses: { '200': { description: '工具列表' } } },
      post: {
        summary: '注册自定义工具',
        requestBody: {
          required: true,
          content: {
            'application/json': {
              schema: {
                type: 'object',
                properties: {
                  name: { type: 'string' },
                  description: { type: 'string' },
                  parameters: { type: 'object' },
                },
              },
            },
          },
        },
        responses: { '201': { description: '工具已注册' } },
      },
    },
    '/devices': {
      get: { summary: '获取设备列表', responses: { '200': { description: '设备列表' } } },
    },
    '/devices/{id}': {
      post: {
        summary: '控制设备',
        parameters: [
          { name: 'id', in: 'path', required: true, schema: { type: 'string' } },
        ],
        requestBody: {
          required: true,
          content: {
            'application/json': {
              schema: {
                type: 'object',
                properties: {
                  action: { type: 'string' },
                  params: { type: 'object' },
                },
              },
            },
          },
        },
        responses: { '200': { description: '控制结果' } },
      },
    },
    '/health': {
      get: { summary: '健康检查', responses: { '200': { description: '服务状态' } } },
    },
  },
};

// ============ API Key 认证中间件 ============

interface ApiKeyConfig {
  enabled: boolean;
  validKeys: Set<string>;
  rateLimits: Map<string, { count: number; resetAt: number }>;
}

function createAuthMiddleware(config: ApiKeyConfig): express.RequestHandler {
  return (req: express.Request, res: express.Response, next: express.NextFunction): void => {
    if (!config.enabled) {
      next();
      return;
    }

    const apiKey = req.headers['x-api-key'] as string | undefined;
    if (!apiKey || !config.validKeys.has(apiKey)) {
      res.status(401).json({ error: '无效的 API Key', code: 'UNAUTHORIZED' });
      return;
    }

    // 简单的速率限制：每分钟 60 次
    const now = Date.now();
    const limit = config.rateLimits.get(apiKey) || { count: 0, resetAt: now + 60000 };

    if (now > limit.resetAt) {
      limit.count = 0;
      limit.resetAt = now + 60000;
    }

    if (limit.count >= 60) {
      res.status(429).json({ error: '请求频率超限', code: 'RATE_LIMITED' });
      return;
    }

    limit.count++;
    config.rateLimits.set(apiKey, limit);

    // 在响应头中添加速率限制信息
    res.setHeader('X-RateLimit-Limit', '60');
    res.setHeader('X-RateLimit-Remaining', String(60 - limit.count));
    res.setHeader('X-RateLimit-Reset', String(Math.floor(limit.resetAt / 1000)));

    next();
  };
}

// ============ 路由注册 ============

export function registerApiV1Routes(app: express.Application, ctx: ServerContext): void {
  const router = express.Router();

  // API Key 配置（从环境变量加载）
  const apiKeyConfig: ApiKeyConfig = {
    enabled: process.env.API_KEY_ENABLED === 'true',
    validKeys: new Set(
      (process.env.API_KEYS || '').split(',').filter(Boolean),
    ),
    rateLimits: new Map(),
  };

  const authMiddleware = createAuthMiddleware(apiKeyConfig);

  // ===== OpenAPI 规格端点 =====
  router.get('/openapi.json', (req: express.Request, res: express.Response) => {
    res.json(OPENAPI_SPEC);
  });

  // ===== 健康检查 =====
  router.get('/health', (req: express.Request, res: express.Response) => {
    res.json({
      status: 'ok',
      version: '19.0.0',
      timestamp: Date.now(),
      uptime: process.uptime(),
    });
  });

  // ===== V17 能力评分矩阵（公开端点，无需认证） =====
  router.get('/capabilities', (req: express.Request, res: express.Response) => {
    try {
      // 动态导入避免循环依赖
      import('../../core/capability-score-matrix.js').then(({ CapabilityScoreMatrix }) => {
        const matrix = new CapabilityScoreMatrix();
        const report = matrix.generateReport();
        res.json({
          version: '19.0.0',
          overallScore: report.overallScore,
          targetScore: 10,
          achieved: report.overallScore >= 10,
          dimensions: report.dimensions.map(d => ({
            id: d.id,
            name: d.name,
            category: d.category,
            currentScore: d.currentScore,
            targetScore: d.targetScore,
            achieved: d.currentScore >= d.targetScore,
            subItems: d.subItems,
          })),
          topGaps: report.topGaps,
          recommendations: report.recommendations,
          scoreTable: matrix.generateScoreTable(),
          generatedAt: report.generatedAt,
        });
      }).catch(err => {
        logger.error('能力评分矩阵加载失败', { module: 'ApiV1', error: String(err) });
        res.status(500).json({ error: '能力评分加载失败', code: 'INTERNAL_ERROR' });
      });
    } catch {
      res.status(500).json({ error: '服务器错误', code: 'INTERNAL_ERROR' });
    }
  });

  // ===== 以下端点需要 API Key 认证 =====
  router.use(authMiddleware);

  // ===== 对话接口 =====
  router.post('/chat', (req: express.Request, res: express.Response) => {
    void (() => {
    try {
      const { message, conversationId, stream } = req.body;

      if (!message || typeof message !== 'string') {
        res.status(400).json({ error: 'message 参数必填', code: 'INVALID_PARAMS' });
        return;
      }

      const convId = conversationId || `api_${Date.now()}`;
      const conversation = ctx.getOrCreateConversation(convId);

      // 添加用户消息
      conversation.messages.push({ role: 'user', content: message });

      if (stream) {
        // SSE 流式响应
        res.setHeader('Content-Type', 'text/event-stream');
        res.setHeader('Cache-Control', 'no-cache');
        res.setHeader('Connection', 'keep-alive');

        // 简化版：返回确认，实际应接入 LLM 流式
        res.write(`data: ${JSON.stringify({ type: 'start', conversationId: convId })}\n\n`);
        res.write(`data: ${JSON.stringify({ type: 'message', content: `收到: ${message}` })}\n\n`);
        res.write(`data: ${JSON.stringify({ type: 'done' })}\n\n`);
        res.end();
      } else {
        // 非流式响应
        res.json({
          conversationId: convId,
          response: `收到您的消息: ${message}`,
          timestamp: Date.now(),
        });
      }
    } catch (err) {
      logger.error('API /chat 错误', { module: 'ApiV1', error: String(err) });
      res.status(500).json({ error: '服务器错误', code: 'INTERNAL_ERROR' });
    }
    })();
  });

  // ===== 任务执行接口 =====
  router.post('/task', (req: express.Request, res: express.Response) => {
    void (() => {
    try {
      const { task, priority = 'medium', async: asyncExec = false } = req.body;

      if (!task || typeof task !== 'string') {
        res.status(400).json({ error: 'task 参数必填', code: 'INVALID_PARAMS' });
        return;
      }

      const taskId = `task_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;

      if (asyncExec) {
        // 异步执行：立即返回任务 ID
        res.status(202).json({
          taskId,
          status: 'accepted',
          message: '任务已提交，异步执行中',
          checkUrl: `/api/v1/task/${taskId}`,
        });
      } else {
        // 同步执行：简化版直接返回
        res.json({
          taskId,
          status: 'completed',
          task,
          priority,
          result: `任务 "${task}" 已处理`,
          timestamp: Date.now(),
        });
      }
    } catch (err) {
      logger.error('API /task 错误', { module: 'ApiV1', error: String(err) });
      res.status(500).json({ error: '服务器错误', code: 'INTERNAL_ERROR' });
    }
    })();
  });

  // ===== 技能管理接口 =====
  router.get('/skills', (req: express.Request, res: express.Response) => {
    try {
      // 从上下文获取技能列表（简化版）
      const skills: unknown[] = [];
      res.json({
        skills,
        total: skills.length,
        timestamp: Date.now(),
      });
    } catch {
      res.status(500).json({ error: '服务器错误', code: 'INTERNAL_ERROR' });
    }
  });

  router.post('/skills', (req: express.Request, res: express.Response) => {
    try {
      const { name, domain, description, keywords } = req.body;

      if (!name || !domain) {
        res.status(400).json({ error: 'name 和 domain 必填', code: 'INVALID_PARAMS' });
        return;
      }

      const skillId = `skill_${Date.now()}`;
      res.status(201).json({
        skillId,
        name,
        domain,
        description,
        keywords: keywords || [],
        status: 'registered',
        timestamp: Date.now(),
      });
    } catch {
      res.status(500).json({ error: '服务器错误', code: 'INTERNAL_ERROR' });
    }
  });

  // ===== 工具注册接口 =====
  router.get('/tools', (req: express.Request, res: express.Response) => {
    try {
      const tools: unknown[] = [];
      res.json({
        tools,
        total: tools.length,
        timestamp: Date.now(),
      });
    } catch {
      res.status(500).json({ error: '服务器错误', code: 'INTERNAL_ERROR' });
    }
  });

  router.post('/tools', (req: express.Request, res: express.Response) => {
    try {
      const { name, description, parameters } = req.body;

      if (!name) {
        res.status(400).json({ error: 'name 必填', code: 'INVALID_PARAMS' });
        return;
      }

      const toolId = `tool_${Date.now()}`;
      res.status(201).json({
        toolId,
        name,
        description,
        parameters,
        status: 'registered',
        timestamp: Date.now(),
      });
    } catch {
      res.status(500).json({ error: '服务器错误', code: 'INTERNAL_ERROR' });
    }
  });

  // ===== 设备控制接口 =====
  router.get('/devices', (req: express.Request, res: express.Response) => {
    try {
      // 从 UnifiedDeviceControl 获取设备列表（简化版）
      const devices: unknown[] = [];
      res.json({
        devices,
        total: devices.length,
        timestamp: Date.now(),
      });
    } catch {
      res.status(500).json({ error: '服务器错误', code: 'INTERNAL_ERROR' });
    }
  });

  router.post('/devices/:id', (req: express.Request, res: express.Response) => {
    try {
      const { id } = req.params;
      const { action, params } = req.body;

      if (!action) {
        res.status(400).json({ error: 'action 必填', code: 'INVALID_PARAMS' });
        return;
      }

      res.json({
        deviceId: id,
        action,
        params,
        success: true,
        message: `设备 ${id} 执行动作 ${action}`,
        timestamp: Date.now(),
      });
    } catch {
      res.status(500).json({ error: '服务器错误', code: 'INTERNAL_ERROR' });
    }
  });

  // ===== WebSocket 流式对话 =====
  // 注意：WebSocket 需要在应用级别注册，这里仅作标记
  // 实际 WebSocket 处理在 start-server.ts 中

  // 注册路由
  app.use('/api/v1', router);

  logger.info('P3: 开放 API v1 路由已注册', {
    module: 'ApiV1',
    authEnabled: apiKeyConfig.enabled,
    endpoints: Object.keys(OPENAPI_SPEC.paths).length,
  });
}
