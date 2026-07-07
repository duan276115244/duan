// ============================================================
// MCP Security Routes — MCP 插件安全管理 API
//
// 提供安全防护层的可视化管理与审批闭环：
// - GET  /api/mcp/security/status     所有插件安全状态
// - GET  /api/mcp/security/events     安全事件日志
// - PUT  /api/mcp/security/plugins/:id 配置插件信任级别/审批策略
// - POST /api/mcp/security/approve    审批待审请求
// - POST /api/mcp/security/block      紧急阻止插件
// ============================================================

import type express from 'express';
import { getMCPSecurityGuard, type TrustLevel, type ApprovalPolicy } from '../../core/mcp-security.js';

export function registerMCPSecurityRoutes(app: express.Application): void {
  const guard = getMCPSecurityGuard();

  // GET /api/mcp/security/status — 所有插件安全状态总览
  app.get('/api/mcp/security/status', (_req: express.Request, res: express.Response) => {
    try {
      const plugins = guard.getAllPluginStatus() || [];
      const events = guard.getSecurityEvents(50) || [];
      const blockedCount = events.filter(e => e.action === 'blocked').length;
      const allowedCount = events.filter(e => e.action === 'allowed').length;

      res.json({
        totalPlugins: plugins.length,
        trusted: plugins.filter(p => p.config?.trust === 'trusted').length,
        untrusted: plugins.filter(p => p.config?.trust === 'untrusted').length,
        blocked: plugins.filter(p => p.config?.trust === 'blocked').length,
        recentStats: {
          total: events.length,
          allowed: allowedCount,
          blocked: blockedCount,
          blockRate: events.length > 0 ? Number((blockedCount / events.length * 100).toFixed(1)) : 0,
        },
        plugins: plugins.map(p => ({
          serverId: p.serverId,
          trust: p.config?.trust,
          approvalPolicy: p.config?.approvalPolicy,
          callsInLastMin: p.callsInLastMin,
          rateLimit: p.config?.rateLimitPerMin,
          timeoutMs: p.config?.timeoutMs,
          networkAccess: p.config?.networkAccess,
          fileWriteAccess: p.config?.fileWriteAccess,
          shellAccess: p.config?.shellAccess,
        })),
      });
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      res.status(500).json({ error: msg });
    }
  });

  // GET /api/mcp/security/events — 安全事件日志（支持分页与过滤）
  app.get('/api/mcp/security/events', (req: express.Request, res: express.Response) => {
    try {
      const limit = parseInt(req.query.limit as string, 10) || 100;
      const filterAction = req.query.action as string;
      const filterRisk = req.query.risk as string;

      let events = guard.getSecurityEvents(limit);

      if (filterAction) {
        events = events.filter(e => e.action === filterAction);
      }
      if (filterRisk) {
        events = events.filter(e => e.riskLevel === filterRisk);
      }

      res.json({
        total: events.length,
        events: events.map(e => ({
          ...e,
          time: new Date(e.timestamp).toISOString(),
        })),
      });
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      res.status(500).json({ error: msg });
    }
  });

  // PUT /api/mcp/security/plugins/:id — 配置插件信任级别与审批策略
  app.put('/api/mcp/security/plugins/:id', (req: express.Request, res: express.Response) => {
    try {
      const { id } = req.params;
      const { trust, approvalPolicy, timeoutMs, rateLimitPerMin, allowedTools, blockedTools } = req.body;

      // 验证信任级别
      const validTrust: TrustLevel[] = ['trusted', 'verified', 'untrusted', 'blocked'];
      if (trust && !validTrust.includes(trust)) {
        return res.status(400).json({ error: `无效信任级别，可选: ${validTrust.join(', ')}` });
      }

      // 验证审批策略
      const validPolicies: ApprovalPolicy[] = ['auto', 'suggest', 'manual'];
      if (approvalPolicy && !validPolicies.includes(approvalPolicy)) {
        return res.status(400).json({ error: `无效审批策略，可选: ${validPolicies.join(', ')}` });
      }

      // 重新注册插件（覆盖配置）
      const config = guard.registerPlugin(id, {
        trust,
        approvalPolicy,
        timeoutMs,
        rateLimitPerMin,
        allowedTools,
        blockedTools,
      });

      res.json({
        success: true,
        message: `插件 ${id} 安全配置已更新`,
        config,
      });
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      res.status(500).json({ error: msg });
    }
  });

  // POST /api/mcp/security/block — 紧急阻止插件（一键封禁）
  app.post('/api/mcp/security/block', (req: express.Request, res: express.Response) => {
    try {
      const { serverId, reason } = req.body;
      if (!serverId) {
        return res.status(400).json({ error: '缺少 serverId' });
      }

      guard.registerPlugin(serverId, {
        trust: 'blocked',
        approvalPolicy: 'manual',
        rateLimitPerMin: 0,
      });

      res.json({
        success: true,
        message: `插件 ${serverId} 已被紧急阻止`,
        reason: reason || 'manual_block',
        timestamp: new Date().toISOString(),
      });
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      res.status(500).json({ error: msg });
    }
  });

  // POST /api/mcp/security/approve — 审批待审请求
  // 前端轮询 /api/mcp/security/pending 获取待审列表，用户决策后调用此端点
  app.post('/api/mcp/security/approve', (req: express.Request, res: express.Response) => {
    try {
      const { approvalId, approved, serverId, toolName } = req.body;

      if (approved === undefined) {
        return res.status(400).json({ error: '缺少 approved 参数' });
      }

      // 通过审批 ID 或 serverId+toolName 解析待审请求
      const resolved = getMCPSecurityGuard().resolveApproval(approvalId, serverId, toolName, approved);

      if (!resolved) {
        return res.status(404).json({
          error: '未找到待审请求，可能已超时自动拒绝',
          hint: '审批超时为 60 秒，请及时处理',
        });
      }

      res.json({
        success: true,
        approved,
        message: approved ? '操作已批准' : '操作已拒绝',
        timestamp: new Date().toISOString(),
      });
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      res.status(500).json({ error: msg });
    }
  });

  // GET /api/mcp/security/pending — 获取待审请求列表
  app.get('/api/mcp/security/pending', (_req: express.Request, res: express.Response) => {
    try {
      const pending = getMCPSecurityGuard().getPendingApprovals();
      res.json({
        total: pending.length,
        pending: pending.map(p => ({
          ...p,
          waitingSeconds: Math.floor((Date.now() - p.enqueuedAt) / 1000),
          expiresInSeconds: Math.max(0, 60 - Math.floor((Date.now() - p.enqueuedAt) / 1000)),
        })),
      });
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      res.status(500).json({ error: msg });
    }
  });
}
