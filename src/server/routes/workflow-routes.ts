// ============================================================
// Phase 3A: 工作流构建器路由 — /api/workflow/*
//
// 提供 YAML 工作流的 CRUD、验证、执行（fire-and-forget）和 SSE 实时进度。
// 引擎 (DynamicWorkflowEngine) 通过 ServerContext.dynamicWorkflowEngine 注入。
// 持久化在路由层完成：workflows.json（定义）+ workflow-executions.json（历史）。
//
// 参考：subagent-routes.ts 的 SSE + CRUD 模式
// ============================================================

import type express from 'express';
import * as fs from 'fs';
import { EventBus } from '../../core/event-bus.js';
import { logger } from '../../core/structured-logger.js';
import { duanPath } from '../../core/duan-paths.js';
import { atomicWriteJsonSync } from '../../core/atomic-write.js';
import type { ServerContext } from '../services/app-context.js';
import type { WorkflowDefinition, WorkflowContext, WorkflowResult } from '../../core/dynamic-workflow.js';

// 持久化文件
const WORKFLOWS_FILE = 'workflows.json';
const EXECUTIONS_FILE = 'workflow-executions.json';
const MAX_EXECUTIONS = 200; // FIFO 上限

/** 工作流定义记录（含持久化元数据） */
interface WorkflowRecord {
  id: string;
  name: string;
  description?: string;
  trigger?: string;
  steps: unknown[];
  outputs?: Record<string, string>;
  max_parallel?: number;
  timeout_ms?: number;
  metadata?: Record<string, unknown>;
  createdAt: number;
  updatedAt: number;
}

/** 执行历史记录摘要 */
interface ExecutionRecord {
  executionId: string;
  workflowName: string;
  status: string;
  startedAt: number;
  completedAt?: number;
  durationMs?: number;
  summary?: string;
  stepCount: number;
  successCount: number;
  failedCount: number;
}

/** 读取工作流定义列表（顶层数组），文件不存在或损坏时返回 [] */
function loadWorkflows(): WorkflowRecord[] {
  try {
    const p = duanPath(WORKFLOWS_FILE);
    if (!fs.existsSync(p)) return [];
    const raw = fs.readFileSync(p, 'utf-8');
    const arr = JSON.parse(raw);
    return Array.isArray(arr) ? arr : [];
  } catch {
    return [];
  }
}

/** 原子写入工作流定义列表 */
function saveWorkflows(workflows: WorkflowRecord[]): void {
  atomicWriteJsonSync(duanPath(WORKFLOWS_FILE), workflows);
}

/** 读取执行历史（顶层数组），FIFO 截断到 MAX_EXECUTIONS */
function loadExecutions(): ExecutionRecord[] {
  try {
    const p = duanPath(EXECUTIONS_FILE);
    if (!fs.existsSync(p)) return [];
    const raw = fs.readFileSync(p, 'utf-8');
    const arr = JSON.parse(raw);
    return Array.isArray(arr) ? arr : [];
  } catch {
    return [];
  }
}

/** 追加执行记录并保持 FIFO 上限 */
function appendExecution(record: ExecutionRecord): void {
  const list = loadExecutions();
  list.unshift(record); // 最新的在最前面
  if (list.length > MAX_EXECUTIONS) list.length = MAX_EXECUTIONS;
  atomicWriteJsonSync(duanPath(EXECUTIONS_FILE), list);
}

export function registerWorkflowRoutes(app: express.Application, ctx?: ServerContext): void {
  const eventBus = EventBus.getInstance();
  const log = logger.child({ module: 'WorkflowRoutes' });

  /**
   * GET /api/workflow/stream — SSE 订阅工作流事件流
   */
  app.get('/api/workflow/stream', (req: express.Request, res: express.Response): void => {
    res.setHeader('Content-Type', 'text/event-stream');
    res.setHeader('Cache-Control', 'no-cache');
    res.setHeader('Connection', 'keep-alive');
    res.setHeader('X-Accel-Buffering', 'no');
    res.flushHeaders();

    res.write(`data: ${JSON.stringify({ type: 'connection.established', timestamp: Date.now() })}\n\n`);

    const eventTypes = [
      'workflow.started',
      'workflow.step.completed',
      'workflow.completed',
      'workflow.failed',
    ];

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

    log.info('Workflow SSE 客户端已连接', { eventTypes: eventTypes.length });

    const heartbeat = setInterval(() => {
      try {
        res.write(`: heartbeat ${Date.now()}\n\n`);
      } catch {
        // 连接已断开
      }
    }, 30000);

    req.on('close', () => {
      clearInterval(heartbeat);
      for (const unsubscribe of unsubscribers) {
        try {
          unsubscribe();
        } catch {
          // 忽略清理错误
        }
      }
      log.info('Workflow SSE 客户端已断开');
    });
  });

  /**
   * GET /api/workflow/list — 列出所有已保存的工作流定义
   */
  app.get('/api/workflow/list', (_req: express.Request, res: express.Response): void => {
    try {
      const workflows = loadWorkflows();
      res.json({ success: true, workflows });
    } catch (err: unknown) {
      res.status(500).json({ success: false, error: (err instanceof Error ? err.message : String(err)) });
    }
  });

  /**
   * GET /api/workflow/:id — 获取单个工作流定义
   */
  app.get('/api/workflow/:id', (req: express.Request, res: express.Response): void => {
    try {
      const id = req.params.id;
      const workflows = loadWorkflows();
      const found = workflows.find(w => w.id === id);
      if (!found) {
        res.status(404).json({ success: false, error: `未找到工作流: ${id}` });
        return;
      }
      res.json({ success: true, workflow: found });
    } catch (err: unknown) {
      res.status(500).json({ success: false, error: (err instanceof Error ? err.message : String(err)) });
    }
  });

  /**
   * POST /api/workflow/save — 保存/更新工作流定义
   * body: WorkflowDefinition + 可选 id
   * 先 validate()，valid 才写入
   */
  app.post('/api/workflow/save', (req: express.Request, res: express.Response): void => {
    try {
      const body = req.body || {};
      const engine = ctx?.dynamicWorkflowEngine;
      if (!engine) {
        res.status(503).json({ success: false, error: 'DynamicWorkflowEngine 不可用（ServerContext 未注入）' });
        return;
      }

      // 构造 WorkflowDefinition 供验证
      const definition: WorkflowDefinition = {
        name: String(body.name || ''),
        steps: Array.isArray(body.steps) ? body.steps : [],
      };
      if (body.description !== undefined) definition.description = String(body.description);
      if (body.trigger !== undefined) definition.trigger = String(body.trigger);
      if (body.outputs !== undefined) definition.outputs = body.outputs;
      if (body.max_parallel !== undefined) definition.max_parallel = Number(body.max_parallel);
      if (body.timeout_ms !== undefined) definition.timeout_ms = Number(body.timeout_ms);
      if (body.metadata !== undefined) definition.metadata = body.metadata;

      const validation = engine.validate(definition);
      if (!validation.valid) {
        res.status(400).json({ success: false, error: '验证失败', errors: validation.errors, warnings: validation.warnings });
        return;
      }

      const workflows = loadWorkflows();
      const now = Date.now();
      const id = body.id || `wf_${now.toString(36)}`;
      const idx = workflows.findIndex(w => w.id === id);
      const record: WorkflowRecord = {
        id,
        name: definition.name,
        description: definition.description,
        trigger: definition.trigger,
        steps: definition.steps,
        outputs: definition.outputs,
        max_parallel: definition.max_parallel,
        timeout_ms: definition.timeout_ms,
        metadata: definition.metadata,
        createdAt: idx >= 0 ? workflows[idx].createdAt : now,
        updatedAt: now,
      };
      if (idx >= 0) workflows[idx] = record;
      else workflows.push(record);
      saveWorkflows(workflows);

      res.json({ success: true, id, workflow: record, warnings: validation.warnings, message: `工作流 "${definition.name}" 已保存` });
    } catch (err: unknown) {
      res.status(500).json({ success: false, error: (err instanceof Error ? err.message : String(err)) });
    }
  });

  /**
   * DELETE /api/workflow/:id — 删除工作流定义
   */
  app.delete('/api/workflow/:id', (req: express.Request, res: express.Response): void => {
    try {
      const id = req.params.id;
      const workflows = loadWorkflows();
      const idx = workflows.findIndex(w => w.id === id);
      if (idx < 0) {
        res.status(404).json({ success: false, error: `未找到工作流: ${id}` });
        return;
      }
      workflows.splice(idx, 1);
      saveWorkflows(workflows);
      res.json({ success: true, message: `工作流 ${id} 已删除` });
    } catch (err: unknown) {
      res.status(500).json({ success: false, error: (err instanceof Error ? err.message : String(err)) });
    }
  });

  /**
   * POST /api/workflow/validate — 验证工作流定义或 YAML
   * body: { definition?: WorkflowDefinition, yaml?: string }
   */
  app.post('/api/workflow/validate', (req: express.Request, res: express.Response): void => {
    try {
      const engine = ctx?.dynamicWorkflowEngine;
      if (!engine) {
        res.status(503).json({ success: false, error: 'DynamicWorkflowEngine 不可用' });
        return;
      }

      const body = req.body || {};
      let definition: WorkflowDefinition;

      if (typeof body.yaml === 'string' && body.yaml.trim()) {
        definition = engine.parse(body.yaml);
      } else if (body.definition && typeof body.definition === 'object') {
        const d = body.definition;
        definition = {
          name: String(d.name || ''),
          steps: Array.isArray(d.steps) ? d.steps : [],
        };
        if (d.description !== undefined) definition.description = String(d.description);
        if (d.trigger !== undefined) definition.trigger = String(d.trigger);
        if (d.outputs !== undefined) definition.outputs = d.outputs;
        if (d.max_parallel !== undefined) definition.max_parallel = Number(d.max_parallel);
        if (d.timeout_ms !== undefined) definition.timeout_ms = Number(d.timeout_ms);
        if (d.metadata !== undefined) definition.metadata = d.metadata;
      } else {
        res.status(400).json({ success: false, error: '需要提供 definition 或 yaml 字段' });
        return;
      }

      const validation = engine.validate(definition);
      res.json({ success: true, valid: validation.valid, errors: validation.errors, warnings: validation.warnings, definition });
    } catch (err: unknown) {
      res.status(500).json({ success: false, error: (err instanceof Error ? err.message : String(err)) });
    }
  });

  /**
   * POST /api/workflow/execute — 执行工作流（fire-and-forget）
   * body: { id?: string, definition?: WorkflowDefinition, yaml?: string, inputs?: Record<string, unknown> }
   * 立即返回 executionId，实际进度通过 SSE 推送
   */
  app.post('/api/workflow/execute', (req: express.Request, res: express.Response): void => {
    void (async () => {
      try {
        const engine = ctx?.dynamicWorkflowEngine;
        if (!engine) {
          res.status(503).json({ success: false, error: 'DynamicWorkflowEngine 不可用' });
          return;
        }

        const body = req.body || {};
        let definition: WorkflowDefinition;
        let workflowName = '';

        // 三种方式获取定义：已保存的 id / 直接 definition / YAML 字符串
        if (typeof body.id === 'string' && body.id.trim()) {
          const workflows = loadWorkflows();
          const found = workflows.find(w => w.id === body.id);
          if (!found) {
            res.status(404).json({ success: false, error: `未找到工作流: ${body.id}` });
            return;
          }
          definition = {
            name: found.name,
            steps: found.steps as WorkflowDefinition['steps'],
          };
          if (found.description) definition.description = found.description;
          if (found.trigger) definition.trigger = found.trigger;
          if (found.outputs) definition.outputs = found.outputs;
          if (found.max_parallel) definition.max_parallel = found.max_parallel;
          if (found.timeout_ms) definition.timeout_ms = found.timeout_ms;
          if (found.metadata) definition.metadata = found.metadata;
          workflowName = found.name;
        } else if (typeof body.yaml === 'string' && body.yaml.trim()) {
          definition = engine.parse(body.yaml);
          workflowName = definition.name;
        } else if (body.definition && typeof body.definition === 'object') {
          const d = body.definition;
          definition = {
            name: String(d.name || 'unnamed'),
            steps: Array.isArray(d.steps) ? d.steps : [],
          };
          if (d.description) definition.description = String(d.description);
          if (d.outputs) definition.outputs = d.outputs;
          if (d.max_parallel) definition.max_parallel = Number(d.max_parallel);
          if (d.timeout_ms) definition.timeout_ms = Number(d.timeout_ms);
          workflowName = definition.name;
        } else {
          res.status(400).json({ success: false, error: '需要提供 id、definition 或 yaml 字段' });
          return;
        }

        // 先验证
        const validation = engine.validate(definition);
        if (!validation.valid) {
          res.status(400).json({ success: false, error: '工作流验证失败', errors: validation.errors });
          return;
        }

        // 构造执行上下文
        const context: WorkflowContext = {
          inputs: (body.inputs && typeof body.inputs === 'object') ? body.inputs as Record<string, unknown> : {},
        };

        // 生成 executionId（与引擎内部生成的解耦，路由层用独立的便于 SSE 关联）
        const executionId = `wfexec_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`;
        const startedAt = Date.now();

        // emit started 事件
        void eventBus.emit('workflow.started', { executionId, workflowName, stepCount: definition.steps.length, timestamp: startedAt });

        // 立即返回，fire-and-forget 执行
        res.json({
          success: true,
          executionId,
          workflowName,
          message: `工作流 "${workflowName}" 已启动，请通过 SSE 流 (/api/workflow/stream) 查看进度`,
        });

        // 异步执行，完成后持久化 + emit 事件
        let result: WorkflowResult;
        try {
          result = await engine.execute(definition, context);
        } catch (execErr: unknown) {
          const errMsg = execErr instanceof Error ? execErr.message : String(execErr);
          log.error('工作流执行异常', { workflowName, executionId, error: errMsg });
          const failedRecord: ExecutionRecord = {
            executionId,
            workflowName,
            status: 'failed',
            startedAt,
            completedAt: Date.now(),
            durationMs: Date.now() - startedAt,
            summary: `执行异常: ${errMsg}`,
            stepCount: definition.steps.length,
            successCount: 0,
            failedCount: definition.steps.length,
          };
          appendExecution(failedRecord);
          void eventBus.emit('workflow.failed', { executionId, workflowName, error: errMsg, timestamp: Date.now() });
          return;
        }

        const completedAt = Date.now();
        const successCount = result.steps.filter(s => s.status === 'completed').length;
        const failedCount = result.steps.filter(s => s.status === 'failed').length;
        const record: ExecutionRecord = {
          executionId,
          workflowName: result.workflowName || workflowName,
          status: result.status,
          startedAt,
          completedAt,
          durationMs: result.totalDurationMs,
          summary: result.summary,
          stepCount: result.steps.length,
          successCount,
          failedCount,
        };
        appendExecution(record);

        if (result.status === 'completed') {
          void eventBus.emit('workflow.completed', { executionId, workflowName: record.workflowName, status: result.status, summary: result.summary, timestamp: completedAt });
        } else {
          void eventBus.emit('workflow.failed', { executionId, workflowName: record.workflowName, status: result.status, summary: result.summary, timestamp: completedAt });
        }

        log.info('工作流执行完成', { workflowName, executionId, status: result.status, duration: result.totalDurationMs });
      } catch (err: unknown) {
        res.status(500).json({ success: false, error: (err instanceof Error ? err.message : String(err)) });
      }
    })();
  });

  /**
   * GET /api/workflow/history — 列出执行历史
   */
  app.get('/api/workflow/history', (_req: express.Request, res: express.Response): void => {
    try {
      const executions = loadExecutions();
      res.json({ success: true, history: executions });
    } catch (err: unknown) {
      res.status(500).json({ success: false, error: (err instanceof Error ? err.message : String(err)) });
    }
  });

  log.info('Workflow 路由已注册', { endpoints: ['/api/workflow/stream', '/api/workflow/list', '/api/workflow/:id', '/api/workflow/save', '/api/workflow/validate', '/api/workflow/execute', '/api/workflow/history'] });
}
