/**
 * 统一记忆系统 — UnifiedMemory (Phase 1.7)
 *
 * 对标 Windsurf Memories + OpenClaw 持久记忆 + Claude Memory：
 * 统一 VectorStore(语义) + EnhancedMemory(标签) + MemoryManager(关键词) + 持久化文件记忆
 * 三层检索：语义 → 标签 → 关键词 逐级降级
 * 自动整合 agent-loop 中的 MemoryEntry 持久化系统
 * 提供统一 store/search/remember/forget 接口
 * Agent Loop 工具注册：self_unified_memory
 *
 * 与 MemoryOrchestrator 的职责区分（两者并行是有意为之，非重复实现）：
 *   - UnifiedMemory（本类）：「工具面」——通过 getToolDefinitions() 暴露记忆工具供 LLM 直接调用
 *     （remember/forget/search 等工具），由 bootstrap.ts 实例化并注册到工具层。
 *   - MemoryOrchestrator（./memory-orchestrator.ts）：「内部面」——供 EnhancedAgentLoop 内部
 *     search/store + 主动注入（ProactiveMemoryInjector），不直接对 LLM 暴露为工具。
 */

import * as fs from 'fs';
import { promises as fsp } from 'fs';
import * as path from 'path';
import { atomicWriteJsonSync } from './atomic-write.js';
import type { VectorStore } from '../memory/vector-store.js';
import type { UnifiedMemoryManager as EnhancedMemory, UnifiedMemoryManager } from '../memory/manager.js';
import { logger } from './structured-logger.js';
import { EventBus } from './event-bus.js';
import { duanPath } from './duan-paths.js';

// ============ 类型定义 ============


export interface UnifiedMemoryResult {
  content: string;
  score: number;
  source: 'vector' | 'tag' | 'keyword' | 'file';
  metadata?: Record<string, unknown>;
}

export interface MemoryEntry {
  id: string;
  content: string;
  type: 'conversation' | 'knowledge' | 'skill' | 'preference' | 'insight' | 'fact' | 'mistake' | 'achievement' | 'pattern' | 'goal';
  importance: number;
  tags: string[];
  timestamp: number;
  source?: string;
  accessCount?: number;
}

export interface MemoryStoreOptions {
  type?: MemoryEntry['type'];
  importance?: number;
  tags?: string[];
  source?: string;
}

export interface MemorySearchOptions {
  limit?: number;
  minScore?: number;
  types?: MemoryEntry['type'][];
  sources?: ('vector' | 'tag' | 'keyword' | 'file')[];
}

export interface MemoryStats {
  totalEntries: number;
  vectorEntries: number;
  tagEntries: number;
  fileEntries: number;
  byType: Record<string, number>;
  avgImportance: number;
  oldestTimestamp: number | null;
  newestTimestamp: number | null;
}

// ============ 主类 ============

export class UnifiedMemory {
  private vectorStore?: VectorStore;
  private enhancedMemory?: EnhancedMemory;
  private memoryManager?: UnifiedMemoryManager;
  private entries: MemoryEntry[] = [];
  private maxEntries = 10000;
  private maxFileAge = 30 * 24 * 60 * 60 * 1000; // 30天
  private log = logger.child({ module: 'UnifiedMemory' });
  private memoryDir: string;

  constructor(config: {
    vectorStore?: VectorStore;
    enhancedMemory?: EnhancedMemory;
    memoryManager?: UnifiedMemoryManager;
    memoryDir?: string;
    maxEntries?: number;
  }) {
    this.vectorStore = config.vectorStore;
    this.enhancedMemory = config.memoryManager ? undefined : config.enhancedMemory;
    this.memoryManager = config.memoryManager;
    this.memoryDir = config.memoryDir || duanPath('memories');
    if (config.maxEntries) this.maxEntries = config.maxEntries;

    // 加载持久化文件记忆
    this.loadFromFileSystem();
  }

  // ============ 核心操作 ============

  /**
   * 存储记忆 — 同时写入三层存储 + 文件持久化
   */
  async store(content: string, options: MemoryStoreOptions = {}): Promise<string> {
    const id = `mem_${Date.now().toString(36)}_${Math.random().toString(36).substr(2, 6)}`;
    const entry: MemoryEntry = {
      id,
      content,
      type: options.type || 'knowledge',
      importance: Math.min(10, Math.max(1, options.importance || 5)),
      tags: options.tags || [],
      timestamp: Date.now(),
      source: options.source,
      accessCount: 1,
    };

    // 内存索引
    this.entries.push(entry);
    if (this.entries.length > this.maxEntries) {
      this.entries.sort((a, b) => b.importance - a.importance);
      this.entries = this.entries.slice(0, this.maxEntries);
    }

    // 异步写入三层存储
    const promises: Promise<unknown>[] = [];

    if (this.vectorStore) {
      promises.push(
        this.vectorStore.add(content, {
          type: entry.type,
          tags: entry.tags,
          source: entry.source,
          importance: entry.importance,
          memoryId: id,
        }).catch((err) => {
          this.log.debug('vector store write failed', { error: err });
        })
      );
    }

    if (this.enhancedMemory) {
      promises.push(
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        this.enhancedMemory.add(content, { category: entry.type as any, tags: entry.tags, importance: entry.importance / 10 }).catch((err) => {
          this.log.warn('enhanced memory write failed', { error: err });
        })
      );
    }

    if (this.memoryManager) {
      promises.push(
        this.memoryManager.add(content, {
          tags: entry.tags,
          importance: entry.importance / 10,
          metadata: { type: entry.type, memoryId: id },
        }).catch((err) => {
          this.log.warn('memory manager write failed', { error: err });
        })
      );
    }

    await Promise.allSettled(promises);

    // 文件持久化
    this.saveEntryToFile(entry);

    // 事件广播
    EventBus.getInstance().emitSync('memory.stored', {
      id, type: entry.type, importance: entry.importance,
    }, { source: 'UnifiedMemory' });

    this.log.info('memory stored', { id, type: entry.type, importance: entry.importance });
    return id;
  }

  /**
   * 搜索记忆 — 三层检索 + 文件检索，逐级降级
   */
  async search(query: string, options: MemorySearchOptions = {}): Promise<UnifiedMemoryResult[]> {
    const limit = options.limit || 5;
    const minScore = options.minScore || 0;
    const allowedSources = options.sources || ['vector', 'tag', 'keyword', 'file'];
    const results: UnifiedMemoryResult[] = [];
    const seenContent = new Set<string>();

    const addResult = (result: UnifiedMemoryResult) => {
      if (results.length >= limit) return;
      // 去重：相似内容只保留最高分
      const contentKey = result.content.substring(0, 100);
      if (seenContent.has(contentKey)) return;
      seenContent.add(contentKey);
      if (result.score >= minScore) results.push(result);
    };

    // 第一层：向量语义搜索
    if (allowedSources.includes('vector') && this.vectorStore) {
      try {
        const docs = await this.vectorStore.search(query, limit);
        for (const d of docs) {
          addResult({
            content: d.text,
            score: d.similarity,
            source: 'vector',
            metadata: d.metadata,
          });
        }
      } catch (err: unknown) {
        this.log.warn('vector search failed, falling back', { error: err });
      }
    }

    // 第二层：标签搜索
    if (results.length < limit && allowedSources.includes('tag') && this.enhancedMemory) {
      try {
        const memories = await this.enhancedMemory.search(query, { limit: limit - results.length });
        for (const m of memories) {
          addResult({
            content: m.content,
            score: (m.importance || 0.5) * 10,
            source: 'tag',
            metadata: { type: m.type, tags: m.tags },
          });
        }
      } catch (err: unknown) {
        this.log.warn('tag search failed', { error: err });
      }
    }

    // 第三层：关键词搜索（内存索引）
    if (results.length < limit && allowedSources.includes('keyword')) {
      const keywordResults = this.searchByKeyword(query, limit - results.length, options.types);
      for (const r of keywordResults) {
        addResult(r);
      }
    }

    // 第四层：文件搜索（降级）
    if (results.length < limit && allowedSources.includes('file')) {
      const fileResults = this.searchFiles(query, limit - results.length);
      for (const r of fileResults) {
        addResult(r);
      }
    }

    results.sort((a, b) => b.score - a.score);
    return results.slice(0, limit);
  }

  /**
   * 快速记住 — 简化接口，返回最相关的一条记忆
   */
  async remember(key: string): Promise<string | null> {
    const results = await this.search(key, { limit: 1 });
    return results.length > 0 ? results[0].content : null;
  }

  /**
   * 删除记忆
   */
  forget(id: string): Promise<boolean> {
    // 从内存索引删除
    const idx = this.entries.findIndex(e => e.id === id);
    if (idx >= 0) {
      this.entries.splice(idx, 1);
    }

    // 从文件系统删除
    const filePath = path.join(this.memoryDir, `${id}.json`);
    try {
      if (fs.existsSync(filePath)) {
        fs.rmSync(filePath);
      }
    } catch {}

    EventBus.getInstance().emitSync('memory.forgotten', { id }, { source: 'UnifiedMemory' });
    return Promise.resolve(idx >= 0);
  }

  /**
   * 获取重要记忆 — 用于系统提示注入
   */
  getImportantMemories(limit: number = 5): MemoryEntry[] {
    return this.entries
      .filter(e => e.importance >= 6 && Date.now() - e.timestamp < this.maxFileAge)
      .sort((a, b) => b.importance - a.importance)
      .slice(0, limit);
  }

  /**
   * 获取最近记忆 — 用于上下文注入
   */
  getRecentMemories(hours: number = 24, limit: number = 5): MemoryEntry[] {
    const cutoff = Date.now() - hours * 60 * 60 * 1000;
    return this.entries
      .filter(e => e.timestamp >= cutoff)
      .sort((a, b) => b.timestamp - a.timestamp)
      .slice(0, limit);
  }

  /**
   * 格式化记忆为系统提示文本
   */
  formatForPrompt(memories?: MemoryEntry[]): string {
    const entries = memories || [...this.getImportantMemories(3), ...this.getRecentMemories(24, 3)];
    // 去重
    const seen = new Set<string>();
    const unique = entries.filter(e => {
      if (seen.has(e.id)) return false;
      seen.add(e.id);
      return true;
    });
    if (unique.length === 0) return '';
    return '## 重要记忆\n' + unique.map(m =>
      `- [${m.type}] ${m.content.substring(0, 120)} (重要度: ${m.importance}/10)`
    ).join('\n');
  }

  /**
   * 自动反思：任务完成后记录洞察
   */
  async reflectOnTask(input: string, output: string, success: boolean): Promise<void> {
    const type = success ? 'achievement' : 'mistake';
    const content = success
      ? `成功处理: ${input.substring(0, 80)}`
      : `遇到问题: ${input.substring(0, 80)}`;
    const importance = success
      ? Math.min(5 + Math.floor(output.length / 500), 8)
      : 7;

    await this.store(content, {
      type,
      importance,
      tags: ['auto_reflect', ...input.split(/\s+/).filter(w => w.length > 2).slice(0, 3)],
      source: 'auto_reflect',
    });

    // 检测模式：相同类型任务反复成功
    const similar = this.searchByKeyword(input, 2, ['achievement']);
    if (similar.length >= 2) {
      await this.store(
        `识别到模式: 擅长处理 "${input.substring(0, 40)}" 类任务 (已成功${similar.length + 1}次)`,
        { type: 'pattern', importance: 6, tags: ['pattern', 'strength'], source: 'pattern_detection' }
      );
    }

    // 清理过期低重要度记忆
    this.cleanupExpired();
  }

  // ============ 内部方法 ============

  private searchByKeyword(query: string, limit: number, types?: MemoryEntry['type'][]): UnifiedMemoryResult[] {
    const q = query.toLowerCase();
    const words = q.split(/\s+/).filter(w => w.length > 1);
    let candidates = this.entries;

    if (types && types.length > 0) {
      candidates = candidates.filter(e => types.includes(e.type));
    }

    const scored = candidates.map(e => {
      const c = e.content.toLowerCase();
      const t = e.tags.join(' ').toLowerCase();
      let score = 0;

      for (const w of words) {
        if (c.includes(w)) score += 3;
        if (t.includes(w)) score += 2;
        if (e.type.includes(w)) score += 1;
      }
      if (c.includes(q)) score += 5;
      score += e.importance * 0.5;
      score += Math.min((e.accessCount || 1) * 0.1, 2);

      // 时间衰减
      const recency = 1 - (Date.now() - e.timestamp) / this.maxFileAge;
      score += Math.max(0, recency) * 2;

      return { content: e.content, score, source: 'keyword' as const, metadata: { type: e.type, tags: e.tags, id: e.id } };
    });

    scored.sort((a, b) => b.score - a.score);

    // 更新访问计数
    for (const r of scored.slice(0, limit)) {
      const entry = this.entries.find(e => e.content === r.content);
      if (entry) {
        entry.accessCount = (entry.accessCount || 0) + 1;
        this.saveEntryToFile(entry);
      }
    }

    return scored.slice(0, limit);
  }

  private searchFiles(query: string, limit: number): UnifiedMemoryResult[] {
    const results: UnifiedMemoryResult[] = [];
    const q = query.toLowerCase();

    try {
      if (!fs.existsSync(this.memoryDir)) return results;
      const files = fs.readdirSync(this.memoryDir).filter(f => f.endsWith('.json'));

      for (const file of files) {
        if (results.length >= limit) break;
        try {
          const data = JSON.parse(fs.readFileSync(path.join(this.memoryDir, file), 'utf-8'));
          if (data.content && data.content.toLowerCase().includes(q)) {
            results.push({
              content: data.content,
              score: (data.importance || 5) * 0.3,
              source: 'file',
              metadata: { type: data.type, id: data.id },
            });
          }
        } catch {}
      }
    } catch {}

    return results;
  }

  private loadFromFileSystem(): void {
    try {
      if (!fs.existsSync(this.memoryDir)) {
        fs.mkdirSync(this.memoryDir, { recursive: true });
        return;
      }

      const files = fs.readdirSync(this.memoryDir).filter(f => f.endsWith('.json'));
      for (const file of files) {
        try {
          const data = JSON.parse(fs.readFileSync(path.join(this.memoryDir, file), 'utf-8'));
          if (data.id && data.content) {
            this.entries.push(data);
          }
        } catch {}
      }

      this.entries.sort((a, b) => b.importance - a.importance || b.timestamp - a.timestamp);
      this.log.info(`loaded ${this.entries.length} memories from filesystem`);
    } catch (err: unknown) {
      this.log.warn('failed to load memories from filesystem', { error: err });
      this.entries = [];
    }
  }

  private saveEntryToFile(entry: MemoryEntry): void {
    try {
      fs.mkdirSync(this.memoryDir, { recursive: true });
      atomicWriteJsonSync(
        path.join(this.memoryDir, `${entry.id}.json`),
        entry
      );
    } catch (err: unknown) {
      this.log.warn('failed to save memory to file', { id: entry.id, error: err });
    }
  }

  private cleanupExpired(): void {
    const cutoff = Date.now() - this.maxFileAge;
    const before = this.entries.length;

    this.entries = this.entries.filter(e => {
      if (e.importance >= 4) return true; // 高重要度不过期
      if (e.timestamp >= cutoff) return true;
      // 删除过期文件
      try {
        const filePath = path.join(this.memoryDir, `${e.id}.json`);
        if (fs.existsSync(filePath)) fs.rmSync(filePath);
      } catch {}
      return false;
    });

    // 上限清理
    if (this.entries.length > this.maxEntries) {
      this.entries.sort((a, b) => a.importance - b.importance || a.timestamp - b.timestamp);
      const toRemove = this.entries.slice(0, this.entries.length - this.maxEntries);
      for (const e of toRemove) {
        try {
          const filePath = path.join(this.memoryDir, `${e.id}.json`);
          if (fs.existsSync(filePath)) fs.rmSync(filePath);
        } catch {}
      }
      this.entries = this.entries.slice(this.entries.length - this.maxEntries);
    }

    if (this.entries.length < before) {
      this.log.info(`cleaned up ${before - this.entries.length} expired memories`);
    }
  }

  // ============ 统计 ============

  getStats(): MemoryStats {
    const byType: Record<string, number> = {};
    let totalImportance = 0;
    let oldest: number | null = null;
    let newest: number | null = null;

    for (const e of this.entries) {
      byType[e.type] = (byType[e.type] || 0) + 1;
      totalImportance += e.importance;
      if (!oldest || e.timestamp < oldest) oldest = e.timestamp;
      if (!newest || e.timestamp > newest) newest = e.timestamp;
    }

    return {
      totalEntries: this.entries.length,
      vectorEntries: this.vectorStore?.getStats().totalEntries || 0,
      tagEntries: 0,
      fileEntries: this.entries.length,
      byType,
      avgImportance: this.entries.length > 0 ? totalImportance / this.entries.length : 0,
      oldestTimestamp: oldest,
      newestTimestamp: newest,
    };
  }

  getFormattedStats(): string {
    const stats = this.getStats();
    let output = `📊 统一记忆系统\n`;
    output += `  总条目: ${stats.totalEntries} | 向量: ${stats.vectorEntries} | 文件: ${stats.fileEntries}\n`;
    output += `  平均重要度: ${stats.avgImportance.toFixed(1)}/10\n`;
    if (stats.oldestTimestamp) {
      output += `  时间范围: ${new Date(stats.oldestTimestamp).toLocaleDateString('zh-CN')} ~ ${new Date(stats.newestTimestamp!).toLocaleDateString('zh-CN')}\n`;
    }
    output += `  类型分布:\n`;
    for (const [type, count] of Object.entries(stats.byType)) {
      output += `    ${type}: ${count}\n`;
    }
    return output;
  }

  // ============ Agent Loop 工具定义 ============

  getToolDefinitions(): Array<{
    name: string;
    description: string;
    parameters: Record<string, { type: string; description: string; required?: boolean }>;
    readOnly?: boolean;
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    execute: (args: any) => Promise<string>;
  }> {
    // eslint-disable-next-line @typescript-eslint/no-this-alias
    const um = this;
    return [
      {
        name: 'unified_memory',
        description: '统一记忆系统：存储/搜索/删除/统计跨会话持久记忆。支持语义搜索、标签搜索、关键词搜索三层检索。记忆会跨会话持久保存。',
        parameters: {
          action: { type: 'string', description: '操作: store(存储) / search(搜索) / remember(快速回忆) / forget(删除) / stats(统计) / important(重要记忆) / recent(最近记忆)', required: true },
          content: { type: 'string', description: '记忆内容 (store时需要)', required: false },
          type: { type: 'string', description: '类型: conversation/knowledge/skill/preference/insight/fact/mistake/achievement/pattern/goal (store时可选，默认knowledge)', required: false },
          importance: { type: 'string', description: '重要度 1-10 (store时可选，默认5)', required: false },
          tags: { type: 'string', description: '标签，逗号分隔 (store时可选)', required: false },
          query: { type: 'string', description: '搜索关键词 (search/remember时需要)', required: false },
          id: { type: 'string', description: '记忆ID (forget时需要)', required: false },
          limit: { type: 'string', description: '返回条数，默认5', required: false },
        },
        execute: async (args) => {
          const action = args.action as string;
          const limit = parseInt(args.limit as string) || 5;

          try {
            if (action === 'store') {
              if (!args.content) return '错误: store 操作需要 content';
              const id = await um.store(args.content as string, {
                // eslint-disable-next-line @typescript-eslint/no-explicit-any
                type: (args.type as any) || 'knowledge',
                importance: parseInt(args.importance as string) || 5,
                tags: args.tags ? (args.tags as string).split(',').map(t => t.trim()) : [],
                source: 'agent_tool',
              });
              const total = um.getStats().totalEntries;
              return `✅ 记忆已存储 (ID: ${id}, 类型: ${args.type || 'knowledge'}, 重要度: ${args.importance || 5})。当前共${total}条记忆。`;
            }

            if (action === 'search') {
              if (!args.query) return '错误: search 操作需要 query';
              const results = await um.search(args.query as string, { limit });
              if (results.length === 0) return '🔍 未找到相关记忆';
              return results.map(r =>
                `  [${r.source}] ${r.content.substring(0, 120)} (分数: ${r.score.toFixed(2)})`
              ).join('\n');
            }

            if (action === 'remember') {
              if (!args.query) return '错误: remember 操作需要 query';
              const result = await um.remember(args.query as string);
              return result || '📭 未找到相关记忆';
            }

            if (action === 'forget') {
              if (!args.id) return '错误: forget 操作需要 id';
              const success = await um.forget(args.id as string);
              return success ? '🗑️ 记忆已删除' : '❌ 未找到该记忆';
            }

            if (action === 'stats') {
              return um.getFormattedStats();
            }

            if (action === 'important') {
              const memories = um.getImportantMemories(limit);
              if (memories.length === 0) return '📭 无高重要度记忆';
              return memories.map(m =>
                `  ⭐ [${m.type}] ${m.content.substring(0, 120)} (重要度: ${m.importance}/10)`
              ).join('\n');
            }

            if (action === 'recent') {
              const memories = um.getRecentMemories(48, limit);
              if (memories.length === 0) return '📭 最近48小时无新记忆';
              return memories.map(m =>
                `  [${m.type}] ${m.content.substring(0, 100)}`
              ).join('\n');
            }

            return '用法: action=store|search|remember|forget|stats|important|recent';
          } catch (err: unknown) {
            return `记忆操作失败: ${(err instanceof Error ? err.message : String(err))}`;
          }
        },
      },
    ];
  }
}
