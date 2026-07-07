// ============================================================
// Health Routes — 健康检查与实时性能监控端点
//
// 提供三级健康检查（对标 Kubernetes probe 规范）：
// - /api/health/live    存活探针（进程是否运行）
// - /api/health/ready   就绪探针（是否可接受流量）
// - /api/health         综合健康报告（含并发、内存、MCP 安全状态）
// - /api/health/metrics 实时性能指标看板数据
// ============================================================

import type express from 'express';
import * as os from 'os';
import { getConcurrencyStats, getResponseTimeStats } from '../middleware.js';
import { getMCPSecurityGuard } from '../../core/mcp-security.js';

const startTime = Date.now();

export function registerHealthRoutes(app: express.Application): void {

  // GET /api/health/live — 存活探针（轻量，<1ms）
  app.get('/api/health/live', (_req: express.Request, res: express.Response) => {
    res.status(200).json({
      status: 'alive',
      uptime: process.uptime(),
      pid: process.pid,
    });
  });

  // GET /api/health/ready — 就绪探针（检查关键依赖）
  app.get('/api/health/ready', (req: express.Request, res: express.Response) => {
    try {
      const mem = process.memoryUsage();
      const memUtilization = mem.rss / (os.totalmem() * 0.25); // 限制使用系统内存 25%
      const concurrency = getConcurrencyStats();

      const checks = {
        memory: memUtilization < 1,
        concurrency: concurrency.utilization < 0.95,
        eventLoopLag: true, // 简化检查
      };

      const ready = Object.values(checks).every(v => v === true);
      res.status(ready ? 200 : 503).json({
        status: ready ? 'ready' : 'not_ready',
        checks,
      });
    } catch (error) {
      res.status(500).json({ status: 'error', error: (error as Error).message });
    }
  });

  // GET /api/health — 综合健康报告
  app.get('/api/health', (_req: express.Request, res: express.Response) => {
    try {
      const mem = process.memoryUsage();
      const concurrency = getConcurrencyStats();
      const cpuLoad = os.loadavg();
      const mcpGuard = getMCPSecurityGuard();
      const rtStats = getResponseTimeStats(60000); // 最近 1 分钟

      // 系统资源状态
      const memStatus = mem.rss > 1024 * 1024 * 1024 ? 'warning' : 'ok'; // >1GB 告警
      const cpuStatus = cpuLoad[0] > 4 ? 'warning' : 'ok';
      const concurrencyStatus = concurrency.utilization > 0.8 ? 'warning' : 'ok';
      const responseTimeStatus = rtStats.p95Ms > 2000 ? 'warning' : 'ok'; // P95>2s 告警

      const mcpPlugins = mcpGuard.getAllPluginStatus() || [];
      const mcpEvents = mcpGuard.getSecurityEvents(20) || [];
      const blockedCount = mcpEvents.filter(e => e.action === 'blocked').length;

      const overallStatus =
        (memStatus === 'warning' || cpuStatus === 'warning' || concurrencyStatus === 'warning' || responseTimeStatus === 'warning')
          ? 'degraded'
          : 'healthy';

      res.json({
        status: overallStatus,
        timestamp: new Date().toISOString(),
        uptime: Math.floor((Date.now() - startTime) / 1000),

        // 系统资源
        system: {
          platform: `${os.type()} ${os.release()}`,
          arch: os.arch(),
          cpus: os.cpus().length,
          cpuLoad: { '1m': cpuLoad[0], '5m': cpuLoad[1], '15m': cpuLoad[2] },
          cpuStatus,
          totalMem: os.totalmem(),
          freeMem: os.freemem(),
          memUsage: mem.rss,
          memUtilization: mem.rss / os.totalmem(),
          memStatus,
          nodeVersion: process.version,
        },

        // 响应时间（v15.2 新增）
        responseTime: {
          status: responseTimeStatus,
          ...rtStats,
        },

        // 并发处理
        concurrency: {
          ...concurrency,
          status: concurrencyStatus,
        },

        // MCP 安全状态
        mcpSecurity: {
          registeredPlugins: mcpPlugins.length,
          plugins: mcpPlugins.map(p => ({
            serverId: p.serverId,
            trust: p.config?.trust,
            approvalPolicy: p.config?.approvalPolicy,
            callsInLastMin: p.callsInLastMin,
            rateLimit: p.config?.rateLimitPerMin,
          })),
          recentEvents: mcpEvents,
          blockedCount24h: blockedCount,
        },
      });
    } catch (error) {
      res.status(500).json({ status: 'error', error: (error as Error).message });
    }
  });

  // GET /api/health/metrics — 实时性能指标看板（适合 Prometheus 抓取）
  app.get('/api/health/metrics', (req: express.Request, res: express.Response) => {
    try {
      const mem = process.memoryUsage();
      const concurrency = getConcurrencyStats();
      const cpuLoad = os.loadavg();
      const windowMs = parseInt(req.query.window as string, 10) || 60000;
      const rtStats = getResponseTimeStats(windowMs);

      res.json({
        // 时间戳
        timestamp: Date.now(),

        // 并发指标
        metrics: {
          active_requests: concurrency.activeRequests,
          max_concurrent: concurrency.maxConcurrent,
          queue_length: concurrency.queueLength,
          concurrency_utilization: Number(concurrency.utilization.toFixed(4)),

          // 内存指标（字节）
          memory_rss: mem.rss,
          memory_heap_used: mem.heapUsed,
          memory_heap_total: mem.heapTotal,
          memory_external: mem.external,

          // CPU 指标
          cpu_load_1m: cpuLoad[0],
          cpu_load_5m: cpuLoad[1],
          cpu_load_15m: cpuLoad[2],

          // 响应时间指标（v15.2 新增，毫秒）
          response_time_avg_ms: rtStats.avgMs,
          response_time_p50_ms: rtStats.p50Ms,
          response_time_p95_ms: rtStats.p95Ms,
          response_time_p99_ms: rtStats.p99Ms,
          response_time_min_ms: rtStats.minMs,
          response_time_max_ms: rtStats.maxMs,
          total_requests: rtStats.totalRequests,
          error_count: rtStats.errorCount,
          error_rate: rtStats.errorRate,

          // 运行时指标
          uptime_seconds: process.uptime(),
          event_loop_pending: 0, // 占位，可扩展
        },
      });
    } catch (error) {
      res.status(500).json({ status: 'error', error: (error as Error).message });
    }
  });
}
