// ============================================================
// Capability Assessment Routes — 统一能力评估框架的 HTTP API
//
// 暴露 CapabilityAssessor 的能力到前端/Electron，使前端
// CapabilityDashboard 可触发评估、读取报告、查看趋势。
//
// 端点：
//   GET  /api/capability/dimensions      — 静态维度定义（含指标规格）
//   GET  /api/capability/report          — 最近一次评估报告（last-report.json）
//   POST /api/capability/assess          — 触发新评估，body: { label?: 'current'|'manual' }
//   POST /api/capability/baseline        — 保存当前评估为 baseline
//   GET  /api/capability/baseline        — 加载 baseline
//   GET  /api/capability/snapshots       — 历史快照（趋势）
//   GET  /api/capability/runtime-values  — 当前 runtime 埋点值
//
// 设计要点：
// - CapabilityAssessor 实例由 web-server.ts 构造并注入 ServerContext，
//   保证全进程单例（与 CLI npx tsx cli.ts assess 写同一份持久化文件）
// - 评估过程可能耗时（运行 7 个 suite），POST /assess 不阻塞事件循环：
//   assessor.runAssessment() 本身是 async，IIFE 包裹避免 no-misused-promises
// - 所有写操作（assess/baseline）会持久化到 ~/.duan/capability-assessment/
// ============================================================

import type express from 'express';
import { errMsg, type ServerContext } from '../services/app-context.js';
import {
  CAPABILITY_DIMENSIONS,
  CAPABILITY_METRICS,
  getMetricsByDimension,
} from '../../core/capability-assessment/dimensions.js';
import { loadRuntimeValues } from '../../core/capability-assessment/runtime-values.js';

export function registerCapabilityRoutes(app: express.Application, ctx: ServerContext): void {
  const { capabilityAssessor } = ctx;

  // ---------- GET /api/capability/dimensions ----------
  // 静态维度定义 + 指标规格，前端用于雷达图/卡片渲染
  app.get('/api/capability/dimensions', (_req: express.Request, res: express.Response) => {
    try {
      res.json({
        dimensions: CAPABILITY_DIMENSIONS,
        metrics: CAPABILITY_METRICS,
        metricsByDimension: Object.fromEntries(
          CAPABILITY_DIMENSIONS.map(d => [d.id, getMetricsByDimension(d.id)]),
        ),
      });
    } catch (error) {
      res.status(500).json({ error: errMsg(error) });
    }
  });

  // ---------- GET /api/capability/report ----------
  // 返回最近一次评估报告；无则 404
  app.get('/api/capability/report', (_req: express.Request, res: express.Response) => {
    try {
      if (!capabilityAssessor) {
        return res.status(503).json({ error: 'capabilityAssessor 未注入' });
      }
      const report = capabilityAssessor.loadLastReport();
      if (!report) {
        return res.status(404).json({ error: '尚无评估报告，请先 POST /api/capability/assess' });
      }
      res.json(report);
    } catch (error) {
      res.status(500).json({ error: errMsg(error) });
    }
  });

  // ---------- POST /api/capability/assess ----------
  // 触发新评估；body.label: 'current' | 'manual'，默认 'current'
  // 注意：'baseline' 通过专属 /baseline 端点触发，避免误用
  app.post('/api/capability/assess', (req: express.Request, res: express.Response) => {
    void (async () => {
      try {
        if (!capabilityAssessor) {
          return res.status(503).json({ error: 'capabilityAssessor 未注入' });
        }
        const label = (req.body?.label === 'manual' ? 'manual' : 'current') as 'current' | 'manual';
        const report = await capabilityAssessor.runAssessment(label);
        res.json(report);
      } catch (error) {
        res.status(500).json({ error: errMsg(error) });
      }
    })();
  });

  // ---------- POST /api/capability/baseline ----------
  // 将本次评估保存为 baseline（label='baseline' 会持久化到 baseline.json）
  app.post('/api/capability/baseline', (_req: express.Request, res: express.Response) => {
    void (async () => {
      try {
        if (!capabilityAssessor) {
          return res.status(503).json({ error: 'capabilityAssessor 未注入' });
        }
        const report = await capabilityAssessor.saveBaseline();
        res.json(report);
      } catch (error) {
        res.status(500).json({ error: errMsg(error) });
      }
    })();
  });

  // ---------- GET /api/capability/baseline ----------
  app.get('/api/capability/baseline', (_req: express.Request, res: express.Response) => {
    try {
      if (!capabilityAssessor) {
        return res.status(503).json({ error: 'capabilityAssessor 未注入' });
      }
      const baseline = capabilityAssessor.loadBaseline();
      if (!baseline) {
        return res.status(404).json({ error: '尚无 baseline，请先 POST /api/capability/baseline' });
      }
      res.json(baseline);
    } catch (error) {
      res.status(500).json({ error: errMsg(error) });
    }
  });

  // ---------- GET /api/capability/snapshots ----------
  // 历史快照（最多 200 个），前端趋势图
  app.get('/api/capability/snapshots', (_req: express.Request, res: express.Response) => {
    try {
      if (!capabilityAssessor) {
        return res.status(503).json({ error: 'capabilityAssessor 未注入' });
      }
      const snapshots = capabilityAssessor.loadSnapshots();
      res.json({ snapshots, count: snapshots.length });
    } catch (error) {
      res.status(500).json({ error: errMsg(error) });
    }
  });

  // ---------- GET /api/capability/runtime-values ----------
  // 当前 runtime 埋点值（source='new' 的指标）
  app.get('/api/capability/runtime-values', (_req: express.Request, res: express.Response) => {
    try {
      const values = loadRuntimeValues();
      res.json({ values, count: Object.keys(values).length });
    } catch (error) {
      res.status(500).json({ error: errMsg(error) });
    }
  });
}
