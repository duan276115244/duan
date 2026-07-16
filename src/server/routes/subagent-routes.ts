// ============================================================
// C1 修复：SubAgent SSE 路由 — /api/subagent/stream
//
// 提供实时 SubAgent 和 Team 事件流，通过 SSE 转发到前端。
// 订阅 EventBus 的 subagent.* 和 team.* 命名空间事件。
// ============================================================

import type express from 'express';
import * as fs from 'fs';
import { EventBus } from '../../core/event-bus.js';
import { logger } from '../../core/structured-logger.js';
import { duanPath } from '../../core/duan-paths.js';
import { atomicWriteJsonSync } from '../../core/atomic-write.js';
import type { ServerContext } from '../services/app-context.js';

// 自定义团队模板持久化文件
const CUSTOM_TEMPLATES_FILE = 'agent-team-templates.json';

/** 读取自定义团队模板（顶层数组），文件不存在或损坏时返回 [] */
function loadCustomTemplates(): any[] {
  try {
    const p = duanPath(CUSTOM_TEMPLATES_FILE);
    if (!fs.existsSync(p)) return [];
    const raw = fs.readFileSync(p, 'utf-8');
    const arr = JSON.parse(raw);
    return Array.isArray(arr) ? arr : [];
  } catch {
    return [];
  }
}

/** 原子写入自定义团队模板 */
function saveCustomTemplates(templates: any[]): void {
  atomicWriteJsonSync(duanPath(CUSTOM_TEMPLATES_FILE), templates);
}

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
   * GET /api/subagent/team-templates — 列出所有团队模板（内置 + 自定义）
   * 内置模板从 AgentTeamOrchestrator 读取（含 members 详情），自定义模板从 agent-team-templates.json 读取
   */
  app.get('/api/subagent/team-templates', (_req: express.Request, res: express.Response): void => {
    try {
      const orchestrator = ctx?.agentTeamOrchestrator;
      const builtinTemplates = orchestrator
        ? orchestrator.getTemplates().map((id: string) => {
            const info = orchestrator.getTemplateInfo(id);
            return {
              id,
              name: info?.name || id,
              description: info?.description || '',
              members: (info?.members || []).map((m: any) => ({
                role: m.role,
                name: m.name,
                priority: m.priority,
                tokenBudget: m.tokenBudget,
                allowedTools: m.allowedTools,
              })),
              maxConcurrent: info?.maxConcurrent,
              useWorktreeIsolation: info?.useWorktreeIsolation,
              custom: false,
            };
          })
        : [];

      const customTemplates = loadCustomTemplates().map((t: any) => ({ ...t, custom: true }));

      res.json({ success: true, templates: [...builtinTemplates, ...customTemplates] });
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

  /**
   * POST /api/subagent/team/custom — 启动自定义团队执行（异步，结果通过 SSE 推送）
   * body: AgentTeamConfig（{name, description, members: TeamMemberConfig[], maxConcurrent?, useWorktreeIsolation?}）
   */
  app.post('/api/subagent/team/custom', (req: express.Request, res: express.Response): void => {
    void (async () => {
      try {
        const config = req.body;
        if (!config || !config.name || !Array.isArray(config.members) || config.members.length === 0) {
          res.status(400).json({ success: false, error: '参数无效：需要 {name, members:[]}' });
          return;
        }
        const teamOrchestrator = ctx?.agentTeamOrchestrator;
        if (!teamOrchestrator) {
          res.status(503).json({ success: false, error: 'AgentTeamOrchestrator 不可用（ServerContext 未注入）' });
          return;
        }

        // Fire-and-forget：团队执行可能耗时数分钟，结果通过 SSE 推送
        teamOrchestrator.executeTeam(config)
          .then(result => {
            log.info('自定义团队执行完成', { teamName: config.name, success: result.success, duration: result.duration });
          })
          .catch(err => {
            log.error('自定义团队执行失败', { teamName: config.name, error: String(err) });
          });

        res.json({
          success: true,
          message: `自定义团队 "${config.name}" 已启动，请通过 SSE 流查看实时进度`,
          teamName: config.name,
        });
      } catch (err: unknown) {
        res.status(500).json({ success: false, error: (err instanceof Error ? err.message : String(err)) });
      }
    })();
  });

  /**
   * GET /api/subagent/team/history — 列出团队执行历史
   * 可选 ?id=xxx 获取单次执行详情
   */
  app.get('/api/subagent/team/history', (req: express.Request, res: express.Response): void => {
    try {
      const teamOrchestrator = ctx?.agentTeamOrchestrator;
      if (!teamOrchestrator) {
        res.status(503).json({ success: false, error: 'AgentTeamOrchestrator 不可用' });
        return;
      }
      const id = typeof req.query.id === 'string' ? req.query.id : null;
      if (id) {
        const detail = teamOrchestrator.getExecution(id);
        if (!detail) {
          res.status(404).json({ success: false, error: `未找到执行记录: ${id}` });
          return;
        }
        res.json({ success: true, execution: detail });
      } else {
        const summary = teamOrchestrator.getExecutionsSummary();
        res.json({ success: true, history: summary });
      }
    } catch (err: unknown) {
      res.status(500).json({ success: false, error: (err instanceof Error ? err.message : String(err)) });
    }
  });

  /**
   * GET /api/subagent/team/custom-templates — 列出自定义团队模板
   */
  app.get('/api/subagent/team/custom-templates', (_req: express.Request, res: express.Response): void => {
    try {
      res.json({ success: true, templates: loadCustomTemplates() });
    } catch (err: unknown) {
      res.status(500).json({ success: false, error: (err instanceof Error ? err.message : String(err)) });
    }
  });

  /**
   * POST /api/subagent/team/custom-templates — 保存/更新自定义团队模板
   * body: {id?, name, description, members, maxConcurrent?, useWorktreeIsolation?}
   */
  app.post('/api/subagent/team/custom-templates', (req: express.Request, res: express.Response): void => {
    try {
      const tpl = req.body;
      if (!tpl || !tpl.name || !Array.isArray(tpl.members) || tpl.members.length === 0) {
        res.status(400).json({ success: false, error: '参数无效：需要 {name, members:[]}' });
        return;
      }
      const templates = loadCustomTemplates();
      const now = Date.now();
      const id = tpl.id || `custom_${now.toString(36)}`;
      const idx = templates.findIndex((t: any) => t.id === id);
      const record = {
        id, name: tpl.name, description: tpl.description || '',
        members: tpl.members, maxConcurrent: tpl.maxConcurrent, useWorktreeIsolation: tpl.useWorktreeIsolation,
        createdAt: idx >= 0 ? templates[idx].createdAt : now, updatedAt: now,
      };
      if (idx >= 0) templates[idx] = record;
      else templates.push(record);
      saveCustomTemplates(templates);
      res.json({ success: true, template: record, message: `模板 "${tpl.name}" 已保存` });
    } catch (err: unknown) {
      res.status(500).json({ success: false, error: (err instanceof Error ? err.message : String(err)) });
    }
  });

  /**
   * DELETE /api/subagent/team/custom-templates/:id — 删除自定义团队模板
   */
  app.delete('/api/subagent/team/custom-templates/:id', (req: express.Request, res: express.Response): void => {
    try {
      const id = req.params.id;
      const templates = loadCustomTemplates();
      const idx = templates.findIndex((t: any) => t.id === id);
      if (idx < 0) {
        res.status(404).json({ success: false, error: `未找到模板: ${id}` });
        return;
      }
      templates.splice(idx, 1);
      saveCustomTemplates(templates);
      res.json({ success: true, message: `模板 ${id} 已删除` });
    } catch (err: unknown) {
      res.status(500).json({ success: false, error: (err instanceof Error ? err.message : String(err)) });
    }
  });

  log.info('SubAgent 路由已注册', { endpoints: ['/api/subagent/stream', '/api/subagent/agents', '/api/subagent/team-templates', '/api/subagent/team/start', '/api/subagent/team/custom', '/api/subagent/team/history', '/api/subagent/team/custom-templates'] });
}
