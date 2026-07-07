/**
 * 中间件配置模块
 *
 * 集中管理所有 Express 中间件：CORS、JSON解析、静态文件、安全头、
 * 速率限制、认证、并发控制、请求超时、错误处理。
 */

import express from 'express';
import cors from 'cors';
import path from 'path';
import { fileURLToPath } from 'url';
import { AuthMiddleware, RateLimiter, securityHeaders } from '../core/security-middleware.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// 并发请求计数与队列（v15.2 优化：支持 100 并发 + 请求排队，避免直接 503）
let activeRequests = 0;
const MAX_CONCURRENT = parseInt(process.env.MAX_CONCURRENT_REQUESTS || '100', 10);
const MAX_QUEUE_SIZE = parseInt(process.env.MAX_QUEUE_SIZE || '200', 10);
const QUEUE_TIMEOUT_MS = parseInt(process.env.QUEUE_TIMEOUT_MS || '30000', 10);

interface QueuedRequest {
  resolve: () => void;
  reject: (err: Error) => void;
  enqueuedAt: number;
  timer: NodeJS.Timeout;
}
const requestQueue: QueuedRequest[] = [];

function processQueue(): void {
  while (activeRequests < MAX_CONCURRENT && requestQueue.length > 0) {
    const next = requestQueue.shift()!;
    clearTimeout(next.timer);
    activeRequests++;
    next.resolve();
  }
}

/** 并发统计 — 供健康检查端点读取 */
export function getConcurrencyStats() {
  return {
    activeRequests,
    maxConcurrent: MAX_CONCURRENT,
    queueLength: requestQueue.length,
    maxQueueSize: MAX_QUEUE_SIZE,
    utilization: activeRequests / MAX_CONCURRENT,
  };
}

// ============ 响应时间追踪（v15.2 新增） ============

interface ResponseTimeRecord {
  path: string;
  method: string;
  durationMs: number;
  statusCode: number;
  timestamp: number;
}

const responseTimeRecords: ResponseTimeRecord[] = [];
const MAX_RT_RECORDS = 5000; // 保留最近 5000 条记录

/** 记录响应时间 */
function recordResponseTime(rec: ResponseTimeRecord): void {
  responseTimeRecords.push(rec);
  if (responseTimeRecords.length > MAX_RT_RECORDS) {
    responseTimeRecords.shift();
  }
}

/** 计算百分位数 */
function percentile(sorted: number[], p: number): number {
  if (sorted.length === 0) return 0;
  const idx = Math.ceil((p / 100) * sorted.length) - 1;
  return sorted[Math.max(0, idx)];
}

/** 获取响应时间统计 — 供健康检查/监控端点读取 */
export function getResponseTimeStats(windowMs: number = 60000) {
  const now = Date.now();
  const recent = responseTimeRecords.filter(r => now - r.timestamp < windowMs);
  const durations = recent.map(r => r.durationMs).sort((a, b) => a - b);

  // 按路径分组统计
  const byPath: Record<string, { count: number; avgMs: number; p95Ms: number }> = {};
  for (const rec of recent) {
    const key = `${rec.method} ${rec.path}`;
    if (!byPath[key]) byPath[key] = { count: 0, avgMs: 0, p95Ms: 0 };
    byPath[key].count++;
  }
  for (const key of Object.keys(byPath)) {
    const pathDurations = recent.filter(r => `${r.method} ${r.path}` === key).map(r => r.durationMs).sort((a, b) => a - b);
    byPath[key].avgMs = pathDurations.length > 0 ? Math.round(pathDurations.reduce((a, b) => a + b, 0) / pathDurations.length) : 0;
    byPath[key].p95Ms = Math.round(percentile(pathDurations, 95));
  }

  return {
    window: windowMs,
    totalRequests: recent.length,
    avgMs: durations.length > 0 ? Math.round(durations.reduce((a, b) => a + b, 0) / durations.length) : 0,
    p50Ms: Math.round(percentile(durations, 50)),
    p95Ms: Math.round(percentile(durations, 95)),
    p99Ms: Math.round(percentile(durations, 99)),
    minMs: durations.length > 0 ? durations[0] : 0,
    maxMs: durations.length > 0 ? durations[durations.length - 1] : 0,
    errorCount: recent.filter(r => r.statusCode >= 400).length,
    errorRate: recent.length > 0 ? Number((recent.filter(r => r.statusCode >= 400).length / recent.length * 100).toFixed(1)) : 0,
    byPath,
  };
}

/**
 * 在 Express app 上挂载所有中间件
 */
export function setupMiddleware(app: express.Application): void {
  // 响应时间追踪（v15.2：最先挂载，记录所有请求耗时）
  app.use((req: express.Request, res: express.Response, next: express.NextFunction) => {
    const start = Date.now();
    res.on('finish', () => {
      const durationMs = Date.now() - start;
      recordResponseTime({
        path: req.path,
        method: req.method,
        durationMs,
        statusCode: res.statusCode,
        timestamp: start,
      });
      // 注入 X-Response-Time 头（毫秒）
    });
    // 设置响应头（在 finish 之前设置，确保客户端可见）
    res.setHeader('X-Response-Time-Start', start.toString());
    next();
  });

  // CORS — restrict to local origins by default to prevent cross-origin abuse.
  // Allowed origins: localhost on any port, the Electron renderer (file://),
  // and 127.0.0.1. Set CORS_ALLOW_ALL=true to restore the old permissive behavior.
  const allowAll = process.env.CORS_ALLOW_ALL === 'true';
  app.use(cors(allowAll ? undefined : {
    origin: (origin, cb) => {
      // Allow same-origin / no-origin (curl, server-side, Electron) requests
      if (!origin) return cb(null, true);
      if (/^https?:\/\/(localhost|127\.0\.0\.1)(:\d+)?$/.test(origin) || origin.startsWith('file://')) {
        return cb(null, true);
      }
      return cb(null, false);
    },
  }));

  // JSON 解析（10MB 上限 — 之前 50MB 过大，存在内存耗尽 DoS 风险）
  app.use(express.json({ limit: '10mb' }));

  // 请求超时控制
  app.use((req: express.Request, res: express.Response, next: express.NextFunction) => {
    req.setTimeout(30000);
    res.setTimeout(60000);
    next();
  });

  // 并发请求控制（v15.2：队列化，避免直接拒绝）
  app.use((req: express.Request, res: express.Response, next: express.NextFunction) => {
    // 非聊天请求直接放行（健康检查、静态资源等不应占用并发槽）
    const isHeavyRequest = req.path === '/api/chat' || req.path === '/api/chat/stream';
    if (!isHeavyRequest) {
      return next();
    }

    // 有空闲槽位，直接执行
    if (activeRequests < MAX_CONCURRENT) {
      activeRequests++;
      // P1 修复：同时监听 finish 和 close 事件，避免客户端断开时计数器永不递减导致死锁
      // 使用 once 包装防止 finish+close 双触发导致重复递减
      let released = false;
      const release = () => { if (!released) { released = true; activeRequests--; processQueue(); } };
      res.on('finish', release);
      res.on('close', release);
      return next();
    }

    // 队列已满，拒绝
    if (requestQueue.length >= MAX_QUEUE_SIZE) {
      return res.status(503).json({
        error: '服务繁忙，请求队列已满，请稍后重试',
        retryAfter: 5,
        concurrency: getConcurrencyStats(),
      });
    }

    // 入队等待
    const timer = setTimeout(() => {
      const idx = requestQueue.findIndex(q => q.timer === timer);
      if (idx >= 0) {
        requestQueue.splice(idx, 1);
        if (!res.headersSent) {
          res.status(504).json({
            error: '请求排队超时',
            concurrency: getConcurrencyStats(),
          });
        }
      }
    }, QUEUE_TIMEOUT_MS);

    requestQueue.push({
      resolve: () => {
        // P1 修复：队列出队后同样监听 close 事件，防止双触发
        let released = false;
        const release = () => { if (!released) { released = true; activeRequests--; processQueue(); } };
        res.on('finish', release);
        res.on('close', release);
        next();
      },
      reject: (err) => {
        clearTimeout(timer);
        if (!res.headersSent) {
          res.status(500).json({ error: '请求处理失败: ' + err.message });
        }
      },
      enqueuedAt: Date.now(),
      timer,
    });
  });

  // 静态文件服务
  app.use(express.static(path.join(__dirname, '../../web')));
  // NOTE: Previously exposed the entire node_modules under /lib, which allowed
  // dependency enumeration (supply-chain reconnaissance). Removed for security.
  // If specific client-side libs are needed, serve them from a curated allowlist.

  // 安全头
  app.use(securityHeaders());

  // 认证中间件（默认关闭，需 AUTH_ENABLED=true 开启）
  const auth = new AuthMiddleware();
  app.use(auth.middleware());

  // 速率限制
  const limiter = new RateLimiter(100, 60000);
  app.use(limiter.middleware());
}

/**
 * 注册全局错误处理和 404 中间件（必须在所有路由之后调用）
 */
export function setupErrorHandlers(app: express.Application): void {
  // 404 - API路由不存在
  app.use('/api/*', (req: express.Request, res: express.Response) => {
    res.status(404).json({
      error: '接口不存在',
      path: req.path,
      availableEndpoints: [
        '/api/chat', '/api/chat/stream', '/api/status', '/api/models',
        '/api/agents', '/api/tools', '/api/metrics', '/api/config',
        '/api/consciousness', '/api/goals', '/api/values',
      ],
    });
  });

  // 全局错误处理
  app.use((err: Error, _req: express.Request, res: express.Response, _next: express.NextFunction) => {
    console.error('全局错误:', err);

    const errorResponse = {
      error: '服务器内部错误',
      message: process.env.NODE_ENV === 'production' ? '请稍后重试' : err.message,
      code: 'INTERNAL_ERROR',
      timestamp: new Date().toISOString(),
    };

    if (!res.headersSent) {
      res.status(500).json(errorResponse);
    } else {
      try {
        res.write(`data: ${JSON.stringify({ type: 'error', chunk: '服务暂时不可用，请重试', code: 'STREAM_ERROR' })}\n\n`);
        res.end();
      } catch { /* 连接已关闭 */ }
    }
  });

  // SPA fallback
  app.get(/^(?!\/api|\/.*\.(html?|js|css|json|ico|png|jpg|jpeg|gif|svg|woff|woff2|ttf|eot))$/, (_req: express.Request, res: express.Response) => {
    res.sendFile(path.join(__dirname, '../../web/index.html'));
  });
}
