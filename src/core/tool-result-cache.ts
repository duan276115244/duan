/**
 * 工具调用结果缓存 — ToolResultCache
 *
 * 对标 Cursor 的计算缓存模式和 LibTV 的缓存策略。
 * 解决重复工具调用导致的延迟和成本问题（目标：>40% 缓存命中率）。
 *
 * 核心能力：
 * 1. 幂等性识别：自动识别幂等工具（read/search/list）vs 非幂等工具（write/delete/update）
 * 2. 参数指纹：工具名 + 参数生成 SHA-256 指纹作为缓存键
 * 3. TTL 过期：按工具类型设置不同 TTL
 * 4. LRU 淘汰：缓存满时淘汰最近最少使用条目
 * 5. 依赖失效：文件变更时失效相关工具缓存（read_file 等）
 * 6. 命中统计：监控各工具缓存命中率
 *
 * 借鉴来源：
 * - Cursor：计算缓存 + 依赖失效
 * - LibTV：TTL + LRU 策略
 * - Codex：幂等性识别
 */

import { createHash } from 'crypto';
import { logger } from './structured-logger.js';

// ============ 类型定义 ============

/** 缓存条目 */
interface CacheEntry {
  /** 缓存键 */
  key: string;
  /** 工具名 */
  toolName: string;
  /** 参数指纹 */
  argsHash: string;
  /** 缓存结果 */
  result: unknown;
  /** 创建时间 */
  createdAt: number;
  /** 过期时间 */
  expiresAt: number;
  /** 最后命中时间 */
  lastHitAt: number;
  /** 命中次数 */
  hitCount: number;
  /** 结果大小（字节估算） */
  size: number;
}

/** 工具缓存配置 */
interface ToolCacheConfig {
  /** 是否可缓存 */
  cacheable: boolean;
  /** TTL（毫秒） */
  ttlMs: number;
  /** 最大结果大小（字节） */
  maxResultSize: number;
  /** 依赖的文件路径参数名（用于文件变更失效） */
  filePathParam?: string;
}

/** 缓存统计 */
export interface ToolCacheStats {
  /** 总请求数 */
  totalRequests: number;
  /** 缓存命中数 */
  hits: number;
  /** 缓存未命中数 */
  misses: number;
  /** 命中率 */
  hitRate: number;
  /** 当前缓存条目数 */
  cacheSize: number;
  /** 缓存内存占用（字节） */
  memoryUsage: number;
  /** 各工具命中率 */
  hitRateByTool: Record<string, { hits: number; misses: number; hitRate: number }>;
  /** 节省的时间（毫秒） */
  totalSavedMs: number;
}

// ============ 默认工具缓存配置 ============

/** 幂等工具（可缓存） */
const IDEMPOTENT_TOOLS: Record<string, ToolCacheConfig> = {
  // 文件读取类 — 缓存 5 分钟，文件变更失效
  read_file: { cacheable: true, ttlMs: 5 * 60 * 1000, maxResultSize: 1024 * 1024, filePathParam: 'path' },
  read_file_lines: { cacheable: true, ttlMs: 5 * 60 * 1000, maxResultSize: 1024 * 1024, filePathParam: 'path' },
  file_search: { cacheable: true, ttlMs: 10 * 60 * 1000, maxResultSize: 512 * 1024 },
  glob: { cacheable: true, ttlMs: 10 * 60 * 1000, maxResultSize: 512 * 1024 },
  grep: { cacheable: true, ttlMs: 5 * 60 * 1000, maxResultSize: 512 * 1024 },

  // 代码分析类 — 缓存 10 分钟
  code_analyze: { cacheable: true, ttlMs: 10 * 60 * 1000, maxResultSize: 512 * 1024, filePathParam: 'file' },
  ast_parse: { cacheable: true, ttlMs: 10 * 60 * 1000, maxResultSize: 512 * 1024, filePathParam: 'file' },
  lsp_diagnostics: { cacheable: true, ttlMs: 2 * 60 * 1000, maxResultSize: 256 * 1024, filePathParam: 'file' },

  // 搜索类 — 缓存 30 分钟
  web_search: { cacheable: true, ttlMs: 30 * 60 * 1000, maxResultSize: 512 * 1024 },
  semantic_search: { cacheable: true, ttlMs: 30 * 60 * 1000, maxResultSize: 512 * 1024 },

  // 项目信息类 — 缓存 1 小时
  project_structure: { cacheable: true, ttlMs: 60 * 60 * 1000, maxResultSize: 256 * 1024 },
  list_skills: { cacheable: true, ttlMs: 60 * 60 * 1000, maxResultSize: 256 * 1024 },
  get_config: { cacheable: true, ttlMs: 5 * 60 * 1000, maxResultSize: 64 * 1024 },

  // Git 信息类 — 缓存 5 分钟
  git_status: { cacheable: true, ttlMs: 5 * 60 * 1000, maxResultSize: 64 * 1024 },
  git_log: { cacheable: true, ttlMs: 5 * 60 * 1000, maxResultSize: 256 * 1024 },
  git_diff: { cacheable: true, ttlMs: 2 * 60 * 1000, maxResultSize: 512 * 1024 },
};

/** 非幂等工具（不可缓存） */
const NON_IDEMPOTENT_TOOLS = new Set([
  'write_file', 'edit_file', 'delete_file', 'move_file', 'copy_file',
  'shell_execute', 'command_execute', 'exec',
  'file_write', 'file_edit', 'file_delete',
  'git_commit', 'git_push', 'git_checkout', 'git_merge', 'git_rebase',
  'send_message', 'send_notification', 'send_email',
  'browser_click', 'browser_type', 'browser_navigate',
  'desktop_click', 'desktop_type', 'desktop_key',
  'create_checkpoint', 'rewind_files',
  'memory_store', 'memory_update', 'memory_delete',
  'skill_create', 'skill_update', 'skill_delete',
]);

// ============ ToolResultCache 主类 ============

export class ToolResultCache {
  private log = logger.child({ module: 'ToolResultCache' });
  private cache: Map<string, CacheEntry> = new Map();
  /** 文件路径 → 缓存键集合（用于文件变更失效） */
  private fileIndex: Map<string, Set<string>> = new Map();
  private maxEntries: number;
  private maxMemoryBytes: number;
  private currentMemoryBytes = 0;

  /** 统计 */
  private stats = {
    totalRequests: 0,
    hits: 0,
    misses: 0,
    totalSavedMs: 0,
    byTool: new Map<string, { hits: number; misses: number }>(),
  };

  constructor(maxEntries = 500, maxMemoryBytes = 100 * 1024 * 1024) {
    this.maxEntries = maxEntries;
    this.maxMemoryBytes = maxMemoryBytes;
  }

  /**
   * 获取缓存结果（如果存在且未过期）
   */
  get(toolName: string, args: Record<string, unknown>): { hit: boolean; result?: unknown; savedMs?: number } {
    this.stats.totalRequests++;
    this.ensureToolStats(toolName);

    const config = this.getToolConfig(toolName);
    if (!config.cacheable) {
      this.stats.misses++;
      this.stats.byTool.get(toolName)!.misses++;
      return { hit: false };
    }

    const key = this.buildCacheKey(toolName, args);
    const entry = this.cache.get(key);

    if (!entry) {
      this.stats.misses++;
      this.stats.byTool.get(toolName)!.misses++;
      return { hit: false };
    }

    // TTL 检查
    if (Date.now() > entry.expiresAt) {
      this.cache.delete(key);
      this.removeFromIndex(entry);
      this.currentMemoryBytes -= entry.size;
      this.stats.misses++;
      this.stats.byTool.get(toolName)!.misses++;
      return { hit: false };
    }

    // 命中
    entry.hitCount++;
    entry.lastHitAt = Date.now();
    this.stats.hits++;
    this.stats.byTool.get(toolName)!.hits++;

    // 估算节省的时间（假设工具调用平均 500ms）
    const savedMs = 500;
    this.stats.totalSavedMs += savedMs;

    return { hit: true, result: entry.result, savedMs };
  }

  /**
   * 存储工具调用结果
   */
  set(toolName: string, args: Record<string, unknown>, result: unknown, executionMs?: number): void {
    const config = this.getToolConfig(toolName);
    if (!config.cacheable) return;

    // 结果大小检查
    const size = this.estimateSize(result);
    if (size > config.maxResultSize) {
      this.log.debug('结果过大，跳过缓存', { toolName, size, max: config.maxResultSize });
      return;
    }

    // 仅序列化一次参数，复用同一哈希作为缓存键与 argsHash，避免重复 stringify
    const stableArgs = this.stabilizeArgs(args);
    const argsHash = this.hashArgs(stableArgs);
    const key = `${toolName}:${argsHash}`;
    const now = Date.now();

    // 惰性批量清理过期条目
    this.cleanupExpiredIfNeeded(now);

    // 如果已存在，先移除旧的
    const existing = this.cache.get(key);
    if (existing) {
      this.currentMemoryBytes -= existing.size;
    }

    const entry: CacheEntry = {
      key,
      toolName,
      argsHash,
      result,
      createdAt: now,
      expiresAt: now + config.ttlMs,
      lastHitAt: now,
      hitCount: 0,
      size,
    };

    this.cache.set(key, entry);
    this.currentMemoryBytes += size;

    // 文件路径索引
    if (config.filePathParam && args[config.filePathParam]) {
      const filePath = String(args[config.filePathParam]);
      if (!this.fileIndex.has(filePath)) {
        this.fileIndex.set(filePath, new Set());
      }
      this.fileIndex.get(filePath)!.add(key);
    }

    // LRU 淘汰
    this.evictIfNeeded();

    this.log.debug('缓存工具结果', {
      toolName,
      size,
      ttlMs: config.ttlMs,
      executionMs,
    });
  }

  /**
   * 文件变更时失效相关缓存
   */
  invalidateOnFileChange(filePath: string): number {
    let count = 0;
    const keys = this.fileIndex.get(filePath);
    if (keys) {
      for (const key of keys) {
        const entry = this.cache.get(key);
        if (entry) {
          this.cache.delete(key);
          this.currentMemoryBytes -= entry.size;
          count++;
        }
      }
      this.fileIndex.delete(filePath);
    }

    // 也失效目录前缀匹配的缓存
    for (const [idxPath, idxKeys] of this.fileIndex.entries()) {
      if (idxPath.startsWith(filePath + '/') || filePath.startsWith(idxPath + '/')) {
        for (const key of idxKeys) {
          const entry = this.cache.get(key);
          if (entry) {
            this.cache.delete(key);
            this.currentMemoryBytes -= entry.size;
            count++;
          }
        }
        this.fileIndex.delete(idxPath);
      }
    }

    if (count > 0) {
      this.log.debug('文件变更失效缓存', { filePath, invalidated: count });
    }
    return count;
  }

  /**
   * 失效指定工具的所有缓存
   */
  invalidateTool(toolName: string): number {
    let count = 0;
    for (const [key, entry] of this.cache.entries()) {
      if (entry.toolName === toolName) {
        this.cache.delete(key);
        this.currentMemoryBytes -= entry.size;
        this.removeFromIndex(entry);
        count++;
      }
    }
    return count;
  }

  /**
   * 清空所有缓存
   */
  clear(): void {
    this.cache.clear();
    this.fileIndex.clear();
    this.currentMemoryBytes = 0;
  }

  /**
   * 获取统计信息
   */
  getStats(): ToolCacheStats {
    const hitRateByTool: Record<string, { hits: number; misses: number; hitRate: number }> = {};
    for (const [tool, stats] of this.stats.byTool.entries()) {
      const total = stats.hits + stats.misses;
      hitRateByTool[tool] = {
        hits: stats.hits,
        misses: stats.misses,
        hitRate: total > 0 ? stats.hits / total : 0,
      };
    }

    return {
      totalRequests: this.stats.totalRequests,
      hits: this.stats.hits,
      misses: this.stats.misses,
      hitRate: this.stats.totalRequests > 0 ? this.stats.hits / this.stats.totalRequests : 0,
      cacheSize: this.cache.size,
      memoryUsage: this.currentMemoryBytes,
      hitRateByTool,
      totalSavedMs: this.stats.totalSavedMs,
    };
  }

  /** 重置统计 */
  resetStats(): void {
    this.stats = {
      totalRequests: 0,
      hits: 0,
      misses: 0,
      totalSavedMs: 0,
      byTool: new Map(),
    };
  }

  // ============ 私有方法 ============

  /** 过期条目批量清理的最小间隔 */
  private static readonly CLEANUP_INTERVAL_MS = 60 * 1000;
  /** 上次批量清理时间 */
  private lastCleanupAt = 0;

  /** 惰性批量清理过期条目，避免过期项长期占用内存计数 */
  private cleanupExpiredIfNeeded(now: number): void {
    if (now - this.lastCleanupAt < ToolResultCache.CLEANUP_INTERVAL_MS) return;
    this.lastCleanupAt = now;
    for (const [key, entry] of this.cache.entries()) {
      if (entry.expiresAt <= now) {
        this.cache.delete(key);
        this.currentMemoryBytes -= entry.size;
        this.removeFromIndex(entry);
      }
    }
  }

  /** 获取工具缓存配置 */
  private getToolConfig(toolName: string): ToolCacheConfig {
    // 显式配置优先
    if (IDEMPOTENT_TOOLS[toolName]) {
      return IDEMPOTENT_TOOLS[toolName];
    }

    // 非幂等工具
    if (NON_IDEMPOTENT_TOOLS.has(toolName)) {
      return { cacheable: false, ttlMs: 0, maxResultSize: 0 };
    }

    // 默认：以 read/list/get/search/analyze 开头的工具可缓存
    const cacheablePattern = /^(read|list|get|search|analyze|check|query|fetch|inspect|describe)/i;
    if (cacheablePattern.test(toolName)) {
      return { cacheable: true, ttlMs: 5 * 60 * 1000, maxResultSize: 256 * 1024 };
    }

    // 默认不可缓存
    return { cacheable: false, ttlMs: 0, maxResultSize: 0 };
  }

  /** 构建缓存键 */
  private buildCacheKey(toolName: string, args: Record<string, unknown>): string {
    // 过滤掉时间戳等易变参数
    const stableArgs = this.stabilizeArgs(args);
    const argsHash = this.hashArgs(stableArgs);
    return `${toolName}:${argsHash}`;
  }

  /** 稳定化参数（移除易变字段，排序键） */
  private stabilizeArgs(args: Record<string, unknown>): Record<string, unknown> {
    const stable: Record<string, unknown> = {};
    const volatileKeys = ['timestamp', '_ts', '_t', 'nonce', 'requestId'];

    for (const key of Object.keys(args).sort()) {
      if (volatileKeys.includes(key)) continue;
      const value = args[key];
      // 函数不可序列化，跳过
      if (typeof value === 'function') continue;
      // undefined 跳过
      if (value === undefined) continue;
      stable[key] = value;
    }

    return stable;
  }

  /** 参数哈希 */
  private hashArgs(args: Record<string, unknown>): string {
    try {
      const json = JSON.stringify(args, Object.keys(args).sort());
      return createHash('sha256').update(json).digest('hex').slice(0, 16);
    } catch {

      return createHash('sha256').update(String(Date.now())).digest('hex').slice(0, 16);
    }
  }

  /** 估算结果大小 */
  private estimateSize(result: unknown): number {
    try {
      const json = JSON.stringify(result);
      return Buffer.byteLength(json, 'utf-8');
    } catch {
      return 1024; // 默认 1KB
    }
  }

  /** LRU 淘汰 */
  private evictIfNeeded(): void {
    // 条目数淘汰
    while (this.cache.size > this.maxEntries) {
      this.evictLRU();
    }

    // 内存淘汰
    while (this.currentMemoryBytes > this.maxMemoryBytes && this.cache.size > 0) {
      this.evictLRU();
    }
  }

  /** 淘汰最近最少使用 */
  private evictLRU(): void {
    let oldestKey: string | null = null;
    let oldestTime = Infinity;
    for (const [key, entry] of this.cache.entries()) {
      if (entry.lastHitAt < oldestTime) {
        oldestTime = entry.lastHitAt;
        oldestKey = key;
      }
    }
    if (oldestKey) {
      const entry = this.cache.get(oldestKey);
      if (entry) {
        this.cache.delete(oldestKey);
        this.currentMemoryBytes -= entry.size;
        this.removeFromIndex(entry);
      }
    }
  }

  /** 从文件索引移除 */
  private removeFromIndex(entry: CacheEntry): void {
    for (const [filePath, keys] of this.fileIndex.entries()) {
      keys.delete(entry.key);
      if (keys.size === 0) {
        this.fileIndex.delete(filePath);
      }
    }
  }

  /** 确保工具统计存在 */
  private ensureToolStats(toolName: string): void {
    if (!this.stats.byTool.has(toolName)) {
      this.stats.byTool.set(toolName, { hits: 0, misses: 0 });
    }
  }
}

// ============ 单例 ============

let toolCacheInstance: ToolResultCache | null = null;

export function getToolResultCache(): ToolResultCache {
  if (!toolCacheInstance) {
    toolCacheInstance = new ToolResultCache();
  }
  return toolCacheInstance;
}

export function resetToolResultCache(): void {
  toolCacheInstance = null;
}
