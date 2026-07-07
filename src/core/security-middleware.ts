import type { Request, Response, NextFunction } from 'express';
import * as crypto from 'crypto';
import * as os from 'os';

/**
 * 生成加密主密钥：基于机器特征派生（与 UnifiedConfigManager 一致）
 * 同一台机器上三端（CLI/Web/Desktop）可互相解密，无需手动配置环境变量
 */
function deriveMasterKey(): Buffer {
  const host = os.hostname() || 'unknown-host';
  const user = os.userInfo().username || 'unknown-user';
  const seed = `duan-unified-config:${host}:${user}`;
  return crypto.scryptSync(seed, 'duan-aes-256-salt', 32);
}

// API Key 加密工具
export class ApiKeyEncryption {
  private algorithm = 'aes-256-gcm';
  private masterKey: Buffer;

  constructor(masterKey?: string) {
    if (masterKey) {
      // 显式传入主密钥时使用（向后兼容）
      this.masterKey = crypto.scryptSync(masterKey, 'duan-salt', 32);
    } else if (process.env.ENCRYPTION_MASTER_KEY) {
      // 环境变量优先（生产环境可覆盖）
      this.masterKey = crypto.scryptSync(process.env.ENCRYPTION_MASTER_KEY, 'duan-salt', 32);
    } else {
      // 默认：使用机器特征派生密钥（与 UnifiedConfigManager 一致，三端互通）
      this.masterKey = deriveMasterKey();
    }
  }

  encrypt(text: string): string {
    const iv = crypto.randomBytes(16);
    const cipher = crypto.createCipheriv(this.algorithm, this.masterKey, iv) as crypto.CipherGCM;
    let encrypted = cipher.update(text, 'utf8', 'hex');
    encrypted += cipher.final('hex');
    const authTag = cipher.getAuthTag();
    return iv.toString('hex') + ':' + authTag.toString('hex') + ':' + encrypted;
  }

  decrypt(encryptedText: string): string {
    const parts = encryptedText.split(':');
    if (parts.length !== 3) throw new Error('Invalid encrypted format');
    const iv = Buffer.from(parts[0], 'hex');
    const authTag = Buffer.from(parts[1], 'hex');
    const encrypted = parts[2];
    const decipher = crypto.createDecipheriv(this.algorithm, this.masterKey, iv) as crypto.DecipherGCM;
    decipher.setAuthTag(authTag);
    let decrypted = decipher.update(encrypted, 'hex', 'utf8');
    decrypted += decipher.final('utf8');
    return decrypted;
  }
}

// 认证中间件
export class AuthMiddleware {
  private apiKeys: Set<string> = new Set();
  private enabled: boolean;
  // H5 修复：localhost 白名单，本地开发免认证
  private localhostWhitelist: Set<string> = new Set([
    '127.0.0.1', 'localhost', '::1', '0.0.0.0',
  ]);

  constructor() {
    // H5 修复：认证默认开启（生产环境安全）
    // 仅在显式设置 AUTH_ENABLED=false 时关闭，或本地开发环境自动豁免
    const authEnabledEnv = process.env.AUTH_ENABLED;
    if (authEnabledEnv === 'false') {
      this.enabled = false;
    } else if (authEnabledEnv === 'true') {
      this.enabled = true;
    } else {
      // 默认：有 API Keys 则启用认证，无 Keys 则仅允许 localhost 访问
      this.enabled = true;
    }
    // 从环境变量加载API Keys
    const keys = process.env.AUTH_API_KEYS?.split(',').filter(Boolean) || [];
    keys.forEach(k => this.apiKeys.add(k.trim()));
  }

  middleware() {
    return (req: Request, res: Response, next: NextFunction) => {
      // H5 修复：localhost 白名单豁免（本地开发友好）
      const clientIp = (req.ip || req.socket.remoteAddress || '').replace(/^::ffff:/, '');
      const isLocalhost = this.localhostWhitelist.has(clientIp);

      // localhost 访问且无 API Keys 配置时，自动豁免认证
      if (isLocalhost && this.apiKeys.size === 0) {
        return next();
      }

      if (!this.enabled) return next();

      // localhost 访问时豁免认证（本地开发友好，但生产环境需配置 API Keys）
      if (isLocalhost && process.env.AUTH_LOCALHOST_BYPASS !== 'false') {
        return next();
      }

      const authHeader = req.headers.authorization;
      const apiKey = req.headers['x-api-key'] as string;
      const queryKey = req.query.api_key as string;

      const key = authHeader?.replace('Bearer ', '') || apiKey || queryKey;

      if (!key || !this.apiKeys.has(key)) {
        return res.status(401).json({
          error: 'Unauthorized: Invalid or missing API key',
          hint: '请在请求头中添加 Authorization: Bearer <key> 或 x-api-key: <key>，或设置 AUTH_API_KEYS 环境变量'
        });
      }

      next();
    };
  }
}

// 速率限制中间件
export class RateLimiter {
  private requests: Map<string, { count: number; resetTime: number }> = new Map();
  private maxRequests: number;
  private windowMs: number;

  constructor(maxRequests: number = 100, windowMs: number = 60000) {
    this.maxRequests = maxRequests;
    this.windowMs = windowMs;
  }

  middleware() {
    return (req: Request, res: Response, next: NextFunction) => {
      const ip = req.ip || req.socket.remoteAddress || 'unknown';
      const now = Date.now();

      const record = this.requests.get(ip);
      if (!record || now > record.resetTime) {
        this.requests.set(ip, { count: 1, resetTime: now + this.windowMs });
        return next();
      }

      record.count++;
      if (record.count > this.maxRequests) {
        return res.status(429).json({
          error: 'Too many requests',
          retryAfter: Math.ceil((record.resetTime - now) / 1000)
        });
      }

      next();
    };
  }

  // 清理过期记录
  cleanup(): void {
    const now = Date.now();
    for (const [ip, record] of this.requests) {
      if (now > record.resetTime) {
        this.requests.delete(ip);
      }
    }
  }
}

// 安全头中间件
export function securityHeaders() {
  return (req: Request, res: Response, next: NextFunction) => {
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('X-Frame-Options', 'DENY');
    res.setHeader('X-XSS-Protection', '1; mode=block');
    res.setHeader('Referrer-Policy', 'strict-origin-when-cross-origin');
    // B9: 移除 script-src 'unsafe-inline' — 防止 XSS 注入执行。
    // style-src 保留 'unsafe-inline'（Vite dev 模式注入内联样式；生产 build 后可进一步收紧，P2 follow-up）。
    // img-src/connect-src 白名单 data: URI（头像/截图）与 WebSocket/SSE/HTTP（LLM API + 流式）。
    res.setHeader('Content-Security-Policy', "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data: blob:; connect-src 'self' ws: wss: http: https:");
    next();
  };
}
