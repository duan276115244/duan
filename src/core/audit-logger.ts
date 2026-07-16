/**
 * 操作审计系统
 * 记录所有关键操作，支持审计追踪和安全分析
 */

import * as fs from 'fs/promises';
import * as path from 'path';
import { SENSITIVE_RESOURCE_KEYWORDS } from './security-config.js';
import { logger } from './structured-logger.js';

/** 审计日志条目 */
interface AuditLogEntry {
  id: string;
  timestamp: string;
  /** 缓存的数值时间戳（毫秒），避免重复解析 timestamp 字符串 */
  tsMs: number;
  type: 'tool_call' | 'permission_check' | 'data_access' | 'config_change' | 'security_event' | 'system_event';
  action: string;
  actor: string;
  resource: string;
  result: 'success' | 'failure' | 'denied';
  details: Record<string, unknown>;
  riskScore: number;
  sessionId?: string;
}

/** 审计查询条件 */
interface AuditQuery {
  type?: string;
  actor?: string;
  resource?: string;
  result?: string;
  startTime?: Date;
  endTime?: Date;
  minRiskScore?: number;
  limit?: number;
}

/** 审计统计 */
interface AuditStats {
  totalEntries: number;
  byType: Record<string, number>;
  byResult: Record<string, number>;
  highRiskCount: number;
  recentFailures: number;
}

export class AuditLogger {
  private entries: AuditLogEntry[] = [];
  private logDir: string;
  private maxEntries: number;
  private flushInterval: NodeJS.Timeout | null = null;
  private pendingWrites: AuditLogEntry[] = [];

  constructor(logDir: string = './data/audit', maxEntries: number = 10000) {
    this.logDir = logDir;
    this.maxEntries = maxEntries;
    this.startPeriodicFlush();
  }

  /**
   * 记录审计日志
   */
  log(entry: Omit<AuditLogEntry, 'id' | 'timestamp' | 'tsMs' | 'riskScore'>): Promise<void> {
    const now = Date.now();
    const fullEntry: AuditLogEntry = {
      ...entry,
      id: `audit_${now}_${Math.random().toString(36).substr(2, 9)}`,
      timestamp: new Date(now).toISOString(),
      tsMs: now,
      riskScore: this.calculateRiskScore(entry),
    };

    this.entries.push(fullEntry);
    this.pendingWrites.push(fullEntry);

    // 内存中保留最近的条目
    if (this.entries.length > this.maxEntries) {
      this.entries = this.entries.slice(-this.maxEntries);
    }
    return Promise.resolve();
  }

  /**
   * 计算操作风险分数
   */
  private calculateRiskScore(entry: Omit<AuditLogEntry, 'id' | 'timestamp' | 'tsMs' | 'riskScore'>): number {
    let score = 0;

    // 基于操作类型
    const typeScores: Record<string, number> = {
      'tool_call': 1,
      'permission_check': 2,
      'data_access': 3,
      'config_change': 4,
      'security_event': 5,
      'system_event': 1,
    };
    score += typeScores[entry.type] || 1;

    // 失败操作增加风险
    if (entry.result === 'failure') score += 2;
    if (entry.result === 'denied') score += 3;

    // 敏感资源增加风险（统一来源: security-config.ts）
    if (SENSITIVE_RESOURCE_KEYWORDS.some(r => entry.resource.toLowerCase().includes(r))) {
      score += 3;
    }

    // 文件写入/删除操作增加风险
    if (entry.action.includes('write') || entry.action.includes('delete') || entry.action.includes('remove')) {
      score += 2;
    }

    return Math.min(score, 10);
  }

  /**
   * 查询审计日志
   */
  query(query: AuditQuery): AuditLogEntry[] {
    let results = [...this.entries];

    if (query.type) {
      results = results.filter(e => e.type === query.type);
    }
    if (query.actor) {
      results = results.filter(e => e.actor === query.actor);
    }
    if (query.resource) {
      results = results.filter(e => e.resource.includes(query.resource!));
    }
    if (query.result) {
      results = results.filter(e => e.result === query.result);
    }
    if (query.startTime) {
      const startMs = query.startTime.getTime();
      results = results.filter(e => e.tsMs >= startMs);
    }
    if (query.endTime) {
      const endMs = query.endTime.getTime();
      results = results.filter(e => e.tsMs <= endMs);
    }
    if (query.minRiskScore !== undefined) {
      results = results.filter(e => e.riskScore >= query.minRiskScore!);
    }

    // 按时间倒序
    results.sort((a, b) => b.tsMs - a.tsMs);

    if (query.limit) {
      results = results.slice(0, query.limit);
    }

    return results;
  }

  /**
   * 获取审计统计
   */
  getStats(): AuditStats {
    const byType: Record<string, number> = {};
    const byResult: Record<string, number> = {};

    for (const entry of this.entries) {
      byType[entry.type] = (byType[entry.type] || 0) + 1;
      byResult[entry.result] = (byResult[entry.result] || 0) + 1;
    }

    const oneHourAgoMs = Date.now() - 3600000;
    const recentEntries = this.entries.filter(e => e.tsMs >= oneHourAgoMs);

    return {
      totalEntries: this.entries.length,
      byType,
      byResult,
      highRiskCount: this.entries.filter(e => e.riskScore >= 7).length,
      recentFailures: recentEntries.filter(e => e.result === 'failure' || e.result === 'denied').length,
    };
  }

  /**
   * 检测异常行为
   */
  detectAnomalies(): AuditLogEntry[] {
    const anomalies: AuditLogEntry[] = [];
    const oneHourAgoMs = Date.now() - 3600000;
    const recent = this.entries.filter(e => e.tsMs >= oneHourAgoMs);

    // 1. 短时间内大量失败操作
    const failures = recent.filter(e => e.result === 'failure' || e.result === 'denied');
    if (failures.length > 10) {
      anomalies.push(...failures);
    }

    // 2. 高风险操作
    const highRisk = recent.filter(e => e.riskScore >= 7);
    anomalies.push(...highRisk);

    // 3. 同一资源的频繁访问
    const resourceCounts = new Map<string, number>();
    for (const entry of recent) {
      resourceCounts.set(entry.resource, (resourceCounts.get(entry.resource) || 0) + 1);
    }
    for (const [resource, count] of resourceCounts) {
      if (count > 20) {
        anomalies.push(...recent.filter(e => e.resource === resource));
      }
    }

    // 去重
    const seen = new Set<string>();
    return anomalies.filter(a => {
      if (seen.has(a.id)) return false;
      seen.add(a.id);
      return true;
    });
  }

  /**
   * 定期刷新到磁盘
   */
  private startPeriodicFlush(): void {
    this.flushInterval = setInterval(() => {
      void this.flush();
    }, 60000); // 每分钟刷新一次
    // 防止定时器阻止进程优雅退出
    if (typeof this.flushInterval.unref === 'function') this.flushInterval.unref();
  }

  /**
   * 刷新到磁盘
   */
  async flush(): Promise<void> {
    if (this.pendingWrites.length === 0) return;

    const toWrite = [...this.pendingWrites];
    this.pendingWrites = [];

    try {
      await fs.mkdir(this.logDir, { recursive: true });

      const date = new Date().toISOString().split('T')[0];
      const logFile = path.join(this.logDir, `audit-${date}.jsonl`);

      const lines = toWrite.map(entry => JSON.stringify(entry)).join('\n') + '\n';
      await fs.appendFile(logFile, lines, 'utf-8');
    } catch (error: unknown) {
      logger.error('审计日志写入失败', { module: 'AuditLogger', error: error instanceof Error ? error.message : String(error) });
      // 写入失败时重新加入待写队列
      this.pendingWrites.unshift(...toWrite);
    }
  }

  /**
   * 从磁盘加载历史日志
   */
  async load(): Promise<void> {
    try {
      await fs.mkdir(this.logDir, { recursive: true });
      const files = await fs.readdir(this.logDir);
      const jsonlFiles = files.filter(f => f.endsWith('.jsonl')).sort().slice(-7); // 最近7天

      for (const file of jsonlFiles) {
        try {
          const content = await fs.readFile(path.join(this.logDir, file), 'utf-8');
          const lines = content.trim().split('\n').filter(l => l.trim());

          for (const line of lines) {
            try {
              const entry = JSON.parse(line) as AuditLogEntry;
              // 兼容历史数据：若缺少 tsMs 则从 timestamp 预解析一次
              if (typeof entry.tsMs !== 'number' || Number.isNaN(entry.tsMs)) {
                entry.tsMs = new Date(entry.timestamp).getTime();
              }
              this.entries.push(entry);
            } catch {
              // 跳过解析失败的行
            }
          }
        } catch {
          // 跳过读取失败的文件
        }
      }

      // 只保留最近的条目
      if (this.entries.length > this.maxEntries) {
        this.entries = this.entries.slice(-this.maxEntries);
      }
    } catch {
      // 目录不存在，忽略
    }
  }

  /**
   * 停止审计日志
   */
  stop(): void {
    if (this.flushInterval) {
      clearInterval(this.flushInterval);
      this.flushInterval = null;
    }
    void this.flush();
  }
}
