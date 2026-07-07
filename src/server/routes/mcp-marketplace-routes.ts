// ============================================================
// D-MCP: MCP 插件市场 HTTP 路由 — /api/mcp/marketplace/*
//
// 提供插件浏览、搜索、安装、卸载、启用/禁用、更新检查等 REST API。
// 通过 MCPMarketplace.getInstance() 获取进程级单例（与 bootstrap 共享同一实例，
// 含已注入的 MCPManager，mcp-server 类型插件安装时可自动连接）。
// ============================================================

import type express from 'express';
import { MCPMarketplace } from '../../core/mcp-marketplace.js';
import { logger } from '../../core/structured-logger.js';

export function registerMCPMarketplaceRoutes(app: express.Application): void {
  const log = logger.child({ module: 'MCPMarketplaceRoutes' });
  const marketplace = MCPMarketplace.getInstance();

  /** GET /api/mcp/marketplace/list — 列出所有可用插件（注册表全量） */
  app.get('/api/mcp/marketplace/list', (_req: express.Request, res: express.Response): void => {
    try {
      const plugins = marketplace.listAvailable();
      res.json({ success: true, plugins, total: plugins.length });
    } catch (err: unknown) {
      log.error('列出插件失败', { error: String(err) });
      res.status(500).json({ success: false, error: (err instanceof Error ? err.message : String(err)) });
    }
  });

  /** GET /api/mcp/marketplace/installed — 列出已安装插件 */
  app.get('/api/mcp/marketplace/installed', (_req: express.Request, res: express.Response): void => {
    try {
      const plugins = marketplace.listInstalled();
      res.json({ success: true, plugins, total: plugins.length });
    } catch (err: unknown) {
      res.status(500).json({ success: false, error: (err instanceof Error ? err.message : String(err)) });
    }
  });

  /** GET /api/mcp/marketplace/search — 搜索插件 (?q=关键词&type=mcp-server&tag=xxx) */
  app.get('/api/mcp/marketplace/search', (req: express.Request, res: express.Response): void => {
    try {
      const { q, type, tag } = req.query;
      const results = marketplace.search(String(q || ''), {
        ...(type ? { type: String(type) as 'mcp-server' | 'tool-bundle' } : {}),
        ...(tag ? { tag: String(tag) } : {}),
      });
      res.json({ success: true, results, total: results.length });
    } catch (err: unknown) {
      res.status(500).json({ success: false, error: (err instanceof Error ? err.message : String(err)) });
    }
  });

  /** POST /api/mcp/marketplace/install/:id — 安装插件 */
  app.post('/api/mcp/marketplace/install/:id', (req: express.Request, res: express.Response): void => {
    const { id } = req.params;
    const { skipCompatibilityCheck, skipSecurityCheck } = req.body || {};
    marketplace.install(id, { skipCompatibilityCheck, skipSecurityCheck })
      .then(result => {
        log.info('插件安装请求', { id, success: result.success });
        res.json({ success: result.success, message: result.message });
      })
      .catch(err => {
        log.error('插件安装失败', { id, error: String(err) });
        res.status(500).json({ success: false, error: (err instanceof Error ? err.message : String(err)) });
      });
  });

  /** POST /api/mcp/marketplace/uninstall/:id — 卸载插件 */
  app.post('/api/mcp/marketplace/uninstall/:id', (req: express.Request, res: express.Response): void => {
    const { id } = req.params;
    marketplace.remove(id)
      .then(result => {
        log.info('插件卸载请求', { id, success: result.success });
        res.json({ success: result.success, message: result.message });
      })
      .catch(err => {
        res.status(500).json({ success: false, error: (err instanceof Error ? err.message : String(err)) });
      });
  });

  /** POST /api/mcp/marketplace/enable/:id — 启用/禁用插件 (body: { enabled: boolean }) */
  app.post('/api/mcp/marketplace/enable/:id', (req: express.Request, res: express.Response): void => {
    const { id } = req.params;
    const { enabled } = req.body || {};
    if (typeof enabled !== 'boolean') {
      res.status(400).json({ success: false, error: '参数 enabled 必须为 boolean' });
      return;
    }
    marketplace.setEnabled(id, enabled)
      .then(result => {
        res.json({ success: result, message: result ? `插件 ${id} 已${enabled ? '启用' : '禁用'}` : `操作失败：插件 ${id} 未安装` });
      })
      .catch(err => {
        res.status(500).json({ success: false, error: (err instanceof Error ? err.message : String(err)) });
      });
  });

  /** GET /api/mcp/marketplace/updates — 检查已安装插件的更新 */
  app.get('/api/mcp/marketplace/updates', (_req: express.Request, res: express.Response): void => {
    try {
      const updates = marketplace.checkUpdates();
      res.json({ success: true, updates, total: updates.length });
    } catch (err: unknown) {
      res.status(500).json({ success: false, error: (err instanceof Error ? err.message : String(err)) });
    }
  });

  /** GET /api/mcp/marketplace/stats — 获取安装统计 */
  app.get('/api/mcp/marketplace/stats', (_req: express.Request, res: express.Response): void => {
    try {
      const stats = marketplace.getStats();
      res.json({ success: true, ...stats });
    } catch (err: unknown) {
      res.status(500).json({ success: false, error: (err instanceof Error ? err.message : String(err)) });
    }
  });

  log.info('MCP 市场路由已注册', {
    endpoints: ['/list', '/installed', '/search', '/install/:id', '/uninstall/:id', '/enable/:id', '/updates', '/stats'],
  });
}
