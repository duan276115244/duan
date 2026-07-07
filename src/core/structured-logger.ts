/**
 * 结构化日志系统 — StructuredLogger
 *
 * 大厂最佳实践（Google SRE / Meta / Microsoft）:
 * - 结构化 JSON 日志，便于日志聚合（ELK/Loki/CloudWatch）
 * - 日志等级：debug < info < warn < error < fatal
 * - 上下文传递：traceId + spanId 实现分布式追踪
 * - 采样控制：避免高并发下日志爆炸
 * - 敏感数据脱敏：防止密钥泄露到日志
 */

import * as fs from 'fs';
import * as path from 'path';

type LogLevel = 'debug' | 'info' | 'warn' | 'error' | 'fatal';
type LogFormat = 'json' | 'pretty' | 'silent';

const LOG_LEVELS: Record<LogLevel, number> = {
  debug: 0,
  info: 1,
  warn: 2,
  error: 3,
  fatal: 4,
};

interface LogEntry {
  timestamp: string;
  level: LogLevel;
  message: string;
  traceId?: string;
  spanId?: string;
  module?: string;
  error?: {
    name: string;
    message: string;
    stack?: string;
  };
  metadata?: Record<string, unknown>;
  durationMs?: number;
}

interface LoggerConfig {
  level: LogLevel;
  format: LogFormat;
  outputFile?: string;
  maxFileSize?: number;
  maxFiles?: number;
  enableTimestamp?: boolean;
  enableStackTraces?: boolean;
  redactKeys?: string[];
  sampleRate?: number;
}

const SENSITIVE_KEYS = [
  'apiKey', 'api_key', 'apikey',
  'password', 'passwd', 'secret', 'token',
  'authorization', 'auth', 'credential',
  'OPENAI_API_KEY', 'ANTHROPIC_API_KEY', 'DEEPSEEK_API_KEY',
  'key', 'private',
];

function redactSensitive(obj: unknown, depth = 0): unknown {
  if (depth > 5) return '[max depth]';
  if (typeof obj !== 'object' || obj === null) return obj;
  if (Array.isArray(obj)) return obj.map(item => redactSensitive(item, depth + 1));
  const redacted: Record<string, unknown> = {};
  for (const [key, val] of Object.entries(obj as Record<string, unknown>)) {
    if (SENSITIVE_KEYS.some(k => key.toLowerCase().includes(k.toLowerCase()))) {
      redacted[key] = '[REDACTED]';
    } else if (typeof val === 'object' && val !== null) {
      redacted[key] = redactSensitive(val, depth + 1);
    } else {
      redacted[key] = val;
    }
  }
  return redacted;
}

export class StructuredLogger {
  private config: LoggerConfig;
  private outputStream?: fs.WriteStream;
  private traceId?: string;
  private moduleName?: string;
  /** 标记是否已初始化输出流（延迟到首次写日志时执行，避免模块加载时同步 I/O 阻塞） */
  private streamInitialized = false;

  constructor(config: Partial<LoggerConfig> = {}) {
    this.config = {
      level: (process.env.LOG_LEVEL as LogLevel) || config.level || 'info',
      format: (process.env.LOG_FORMAT as LogFormat) || config.format || process.env.NODE_ENV === 'production' ? 'json' : 'pretty',
      outputFile: config.outputFile || process.env.LOG_FILE,
      maxFileSize: config.maxFileSize || 10 * 1024 * 1024,
      maxFiles: config.maxFiles || 5,
      enableTimestamp: config.enableTimestamp ?? true,
      enableStackTraces: config.enableStackTraces ?? true,
      redactKeys: config.redactKeys || SENSITIVE_KEYS,
      sampleRate: config.sampleRate ?? 1.0,
    };
    // 不在构造函数中执行同步 I/O，延迟到首次写日志时初始化
  }

  /** 延迟初始化输出流（首次写日志时调用） */
  private ensureStreamInitialized(): void {
    if (this.streamInitialized || !this.config.outputFile) return;
    this.streamInitialized = true;
    this.ensureLogDir();
    this.rotateLogIfNeeded();
    this.outputStream = fs.createWriteStream(this.config.outputFile, { flags: 'a' });
  }

  private ensureLogDir(): void {
    if (this.config.outputFile) {
      fs.mkdirSync(path.dirname(this.config.outputFile), { recursive: true });
    }
  }

  private rotateLogIfNeeded(): void {
    if (!this.config.outputFile) return;
    try {
      const stats = fs.statSync(this.config.outputFile);
      if (stats.size >= (this.config.maxFileSize || 10 * 1024 * 1024)) {
        for (let i = (this.config.maxFiles || 5) - 1; i > 0; i--) {
          const oldFile = `${this.config.outputFile}.${i}`;
          const newFile = `${this.config.outputFile}.${i + 1}`;
          if (fs.existsSync(oldFile)) fs.renameSync(oldFile, newFile);
        }
        fs.renameSync(this.config.outputFile, `${this.config.outputFile}.1`);
      }
    } catch { /* first write */ }
  }

  child(context: { module?: string; traceId?: string }): StructuredLogger {
    const child = new StructuredLogger(this.config);
    child.moduleName = context.module || this.moduleName;
    child.traceId = context.traceId || this.traceId;
    return child;
  }

  withTraceId(traceId: string): StructuredLogger {
    return this.child({ traceId });
  }

  private shouldSample(): boolean {
    return Math.random() < (this.config.sampleRate ?? 1.0);
  }

  private formatEntry(entry: LogEntry): string {
    if (this.config.format === 'json') {
      return JSON.stringify(entry) + '\n';
    }
    const ts = entry.timestamp ? entry.timestamp.split('.')[0].replace('T', ' ') : '';
    const level = entry.level.toUpperCase().padEnd(5);
    const mod = entry.module ? `[${entry.module}]` : '';
    const trace = entry.traceId ? ` (${entry.traceId.slice(0, 8)})` : '';
    const dur = entry.durationMs != null ? ` +${entry.durationMs}ms` : '';
    const err = entry.error ? `\n  └─ ${entry.error.name}: ${entry.error.message}` : '';
    return `${ts} ${level} ${mod}${trace} ${entry.message}${dur}${err}\n`;
  }

  private log(level: LogLevel, message: string, meta?: Record<string, unknown>): void {
    if (LOG_LEVELS[level] < LOG_LEVELS[this.config.level]) return;
    if (!this.shouldSample()) return;

    const entry: LogEntry = {
      timestamp: new Date().toISOString(),
      level,
      message,
      traceId: this.traceId,
      module: this.moduleName,
    };

    if (meta) {
      if (meta.error instanceof Error) {
        const err = meta.error;
        entry.error = {
          name: err.name,
          message: err.message,
          stack: this.config.enableStackTraces ? err.stack : undefined,
        };
        delete meta.error;
      }
      if (typeof meta.durationMs === 'number') {
        entry.durationMs = meta.durationMs;
        delete meta.durationMs;
      }
      if (Object.keys(meta).length > 0) {
        entry.metadata = redactSensitive(meta) as Record<string, unknown>;
      }
    }

    const formatted = this.formatEntry(entry);

    if (this.config.format !== 'silent') {
      if (this.config.format === 'pretty') {
        const colors: Record<LogLevel, string> = {
          debug: '\x1b[90m', info: '\x1b[36m', warn: '\x1b[33m',
          error: '\x1b[31m', fatal: '\x1b[41m\x1b[97m',
        };
        const reset = '\x1b[0m';
        process.stdout.write(`${colors[level] || ''}${formatted}${reset}`);
      } else {
        process.stdout.write(formatted);
      }
    }

    // 延迟初始化输出流（首次写日志时触发）
    this.ensureStreamInitialized();
    if (this.outputStream) {
      this.outputStream.write(JSON.stringify(entry) + '\n');
    }
  }

  debug(message: string, meta?: Record<string, unknown>): void { this.log('debug', message, meta); }
  info(message: string, meta?: Record<string, unknown>): void { this.log('info', message, meta); }
  warn(message: string, meta?: Record<string, unknown>): void { this.log('warn', message, meta); }
  error(message: string, meta?: Record<string, unknown>): void { this.log('error', message, meta); }
  fatal(message: string, meta?: Record<string, unknown>): void { this.log('fatal', message, meta); }

  close(): void {
    if (this.outputStream) {
      this.outputStream.end();
    }
  }
}

export const logger = new StructuredLogger();
