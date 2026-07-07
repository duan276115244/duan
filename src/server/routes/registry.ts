// ============================================================
// Route Registry — thin coordinator that delegates to
// individual route group files
// ============================================================

import type express from 'express';
import type { ServerContext } from '../services/app-context.js';
import { registerChatRoutes } from './chat-routes.js';
import { registerSystemRoutes } from './system-routes.js';
import { registerKnowledgeRoutes } from './knowledge-routes.js';
import { registerNluRoutes } from './nlu-routes.js';
import { registerEvolutionRoutes } from './evolution-routes.js';
import { registerCapabilitiesRoutes } from './capabilities-routes.js';
import { registerFeaturesRoutes } from './features-routes.js';
import { registerConsciousnessRoutes } from './consciousness-routes.js';
import { registerConfigRoutes } from './config-routes.js';
import { registerChannelsRoutes } from './channels-routes.js';
import { registerPairingRoutes } from './pairing-routes.js';
import { registerModuleRoutes } from './module-routes.js';
import { registerVoiceRoutes } from './voice-routes.js';
import { registerHealthRoutes } from './health-routes.js';
import { registerMCPSecurityRoutes } from './mcp-security-routes.js';
import { registerMCPMarketplaceRoutes } from './mcp-marketplace-routes.js';
import { registerApiV1Routes } from './api-v1-routes.js';
import { registerSubAgentRoutes } from './subagent-routes.js';
import { registerCapabilityRoutes } from './capability-routes.js';

export function registerRoutes(app: express.Application, ctx: ServerContext): void {
  // v15.2：API 版本管理 — /api/v1/* 别名重写到 /api/*（向后兼容）
  // 注意：P3 的开放 API v1 路由使用独立的 /api/v1 前缀，需在此重写之前注册
  // 因此将 v1 别名重写改为只对非 v1 开放 API 路径生效

  // 健康检查端点（不依赖 ServerContext，最先注册）
  registerHealthRoutes(app);

  // MCP 安全管理端点（不依赖 ServerContext）
  registerMCPSecurityRoutes(app);

  // D-MCP: MCP 插件市场端点（不依赖 ServerContext，使用 MCPMarketplace 单例）
  registerMCPMarketplaceRoutes(app);

  // C1 修复：SubAgent SSE 端点 + POST 端点（POST 需要 ServerContext 获取 orchestrator）
  registerSubAgentRoutes(app, ctx);

  // P3: 开放 API v1 路由（独立前缀，不重写）
  registerApiV1Routes(app, ctx);

  registerConfigRoutes(app);
  registerChannelsRoutes(app);
  registerPairingRoutes(app);
  registerChatRoutes(app, ctx);
  registerSystemRoutes(app, ctx);
  registerNluRoutes(app, ctx);
  registerEvolutionRoutes(app, ctx);
  registerKnowledgeRoutes(app, ctx);
  registerCapabilitiesRoutes(app, ctx);
  registerFeaturesRoutes(app, ctx);
  registerConsciousnessRoutes(app, ctx);
  registerModuleRoutes(app, ctx);
  registerVoiceRoutes(app, ctx);
  registerCapabilityRoutes(app, ctx);
}
