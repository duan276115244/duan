// ============================================================
// C1 修复：SubAgent SSE 路由 — /api/subagent/stream
//
// 提供实时 SubAgent 和 Team 事件流，通过 SSE 转发到前端。
// 订阅 EventBus 的 subagent.* 和 team.* 命名空间事件。
// ============================================================

import type express from 'express';
import { EventBus } from '../../core/event-bus.js';
import { logger } from '../../core/structured-logger.js';
import type { ServerContext } from '../services/app-context.js';

export function registerSubAgentRoutes(app: express.Application, ctx?: ServerContext): void {
  const eventBus = EventBus.getInstance();
  const log = logger.child({ module: 'SubAgentRoutes' });

  /**
   * GET /api/subagent/stream — SSE 订阅 SubAgent 事件流
   * 前端通过 EventSource 订阅，实时接收 subagent.* 和 team.* 事件
   */
  app.get('/api/subagent/stream', (req: express.Request, res: express.Response): void => {
    // 设置 SSE 响应头
    res.setHeader('Content-Type', 'text/event-stream');
    res.setHeader('Cache-Control', 'no-cache');
    res.setHeader('Connection', 'keep-alive');
    res.setHeader('X-Accel-Buffering', 'no'); // 禁用 Nginx 缓冲
    res.flushHeaders();

    // 发送初始连接确认
    res.write(`data: ${JSON.stringify({ type: 'connection.established', timestamp: Date.now() })}\n\n`);

    // 订阅所有 SubAgent 和 Team 事件
    const eventTypes = [
      'subagent.dispatch',
      'subagent.turn',
      'subagent.tool_call',
      'subagent.tool_result',
      'subagent.status',
      'subagent.completed',
      'team.execution.started',
      'team.board',
      'team.execution.completed',
    ];

    // EventBus.on() 返回 unsubscribe 函数，用于清理订阅
    const unsubscribers: Array<() => void> = [];

    for (const type of eventTypes) {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const handler = (data: any): void => {
        try {
          const event = { type, ...data, timestamp: data?.timestamp || Date.now() };
          res.write(`data: ${JSON.stringify(event)}\n\n`);
        } catch (err: unknown) {
          log.warn('SSE 事件转发失败', { type, error: (err instanceof Error ? err.message : String(err)) });
        }
      };
      const unsubscribe = eventBus.on(type, handler);
      unsubscribers.push(unsubscribe);
    }

    log.info('SubAgent SSE 客户端已连接', { eventTypes: eventTypes.length });

    // 心跳保活（每 30 秒发送一次注释行，防止代理超时断开）
    const heartbeat = setInterval(() => {
      try {
        res.write(`: heartbeat ${Date.now()}\n\n`);
      } catch {
        // 连接已断开
      }
    }, 30000);

    // 客户端断开时清理订阅
    req.on('close', () => {
      clearInterval(heartbeat);
      for (const unsubscribe of unsubscribers) {
        try {
          unsubscribe();
        } catch {
          // 忽略清理错误
        }
      }
      log.info('SubAgent SSE 客户端已断开');
    });
  });

  /**
   * GET /api/subagent/agents — 列出所有可用的 SubAgent
   */
  app.get('/api/subagent/agents', (_req: express.Request, res: express.Response): void => {
    try {
      // 从 EventBus 获取或返回内置 Agent 列表
      const builtinAgents = [
        { name: 'code-reviewer', description: '代码审查专家，负责审查代码质量、安全性和最佳实践' },
        { name: 'test-runner', description: '测试工程师，负责编写和运行测试' },
        { name: 'architect', description: '架构师，负责系统设计和架构分析' },
        { name: 'doc-writer', description: '文档编写专家，负责生成和更新文档' },
      ];
      res.json({ success: true, agents: builtinAgents });
    } catch (err: unknown) {
      res.status(500).json({ success: false, error: (err instanceof Error ? err.message : String(err)) });
    }
  });

  /**
   * GET /api/subagent/team-templates — 列出所有团队模板
   */
  app.get('/api/subagent/team-templates', (_req: express.Request, res: express.Response): void => {
    try {
      const templates = [
        { id: 'code-dev', name: '代码开发团队', description: '完整的代码开发流程：规划→实现→审查→测试' },
        { id: 'research', name: '调研分析团队', description: '多角度调研分析：资料收集→分析→总结' },
      ];
      res.json({ success: true, templates });
    } catch (err: unknown) {
      res.status(500).json({ success: false, error: (err instanceof Error ? err.message : String(err)) });
    }
  });

  /**
   * POST /api/subagent/team/start — 启动团队执行（异步，结果通过 SSE 推送）
   * body: { templateName: string, taskGoal: string, extraContext?: string }
   * 返回临时确认，实际 executionId 通过 SSE team.execution.started 事件推送
   */
  app.post('/api/subagent/team/start', (req: express.Request, res: express.Response): void => {
    const { templateName, taskGoal, extraContext } = req.body || {};
    if (!templateName || typeof templateName !== 'string') {
      res.status(400).json({ success: false, error: '参数 templateName 必填' });
      return;
    }
    if (!taskGoal || typeof taskGoal !== 'string') {
      res.status(400).json({ success: false, error: '参数 taskGoal 必填' });
      return;
    }

    const teamOrchestrator = ctx?.agentTeamOrchestrator;
    if (!teamOrchestrator) {
      res.status(503).json({ success: false, error: 'AgentTeamOrchestrator 不可用（ServerContext 未注入）' });
      return;
    }

    // 验证模板名
    const templates = teamOrchestrator.getTemplates();
    if (!templates.includes(templateName)) {
      res.status(400).json({ success: false, error: `未知团队模板: ${templateName}，可用: ${templates.join(', ')}` });
      return;
    }

    // Fire-and-forget：团队执行可能耗时数分钟，结果通过 SSE 推送
    teamOrchestrator.runTemplate(templateName, taskGoal, extraContext)
      .then(result => {
        log.info('团队执行完成', { templateName, success: result.success, duration: result.duration });
      })
      .catch(err => {
        log.error('团队执行失败', { templateName, error: String(err) });
      });

    res.json({
      success: true,
      message: `团队 "${templateName}" 已启动，请通过 SSE 流 (/api/subagent/stream) 查看实时进度`,
      templateName,
      taskGoal,
    });
  });

  log.info('SubAgent 路由已注册', { endpoints: ['/api/subagent/stream', '/api/subagent/agents', '/api/subagent/team-templates', '/api/subagent/team/start'] });
}
