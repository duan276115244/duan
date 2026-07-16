/**
 * DreamingBridge — DreamingEngine ↔ MemoryStore 双向桥接
 *
 * 方向 A: DreamingEngine 高权重链 → MemoryStore LONG_TERM 记忆
 * 方向 B: MemoryStore 高频访问条目 → DreamingEngine 碎片
 */
import { MemoryLevel, type MemoryStore } from './memory-store.js';
import type { DreamingEngine } from './dreaming-engine.js';
import { logger } from './structured-logger.js';
import { EventBus } from './event-bus.js';

export class DreamingBridge {
  private syncTimer: ReturnType<typeof setInterval> | null = null;
  private log = logger.child({ module: 'DreamingBridge' });
  private eventBus: EventBus;
  private store: MemoryStore;
  private engine: DreamingEngine;

  constructor(store: MemoryStore, engine: DreamingEngine) {
    this.store = store;
    this.engine = engine;
    this.eventBus = EventBus.getInstance();
  }

  start(intervalMs: number = 120000): void {
    this.syncTimer = setInterval(() => this.sync(), intervalMs);
    if (typeof this.syncTimer.unref === 'function') this.syncTimer.unref();
    this.log.info('DreamingBridge started', { intervalMs });
  }

  stop(): void {
    if (this.syncTimer) {
      clearInterval(this.syncTimer);
      this.syncTimer = null;
    }
  }

  sync(): { toStore: number; toEngine: number } {
    let toStore = 0;
    let toEngine = 0;

    // A: DreamingEngine 高权重链 → MemoryStore
    const highWeightChains = this.engine.getChainsByWeight(0.6);

    // 一次性查询已存在的 dreaming 记忆，构建 key/label 集合做批量去重，
    // 避免对每个高权重链都执行一次 store.query 产生 N 次串行查询。
    const existingDreaming = this.store.query({
      tags: ['dreaming'],
      level: MemoryLevel.LONG_TERM,
    });
    const existingKeys = new Set<string>();
    const existingLabels = new Set<string>();
    for (const entry of existingDreaming) {
      existingKeys.add(entry.key);
      existingLabels.add(entry.content);
    }

    for (const chain of highWeightChains) {
      const key = `dreaming:${chain.id}`;
      if (!existingKeys.has(key) && !existingLabels.has(chain.label)) {
        this.store.store({
          level: MemoryLevel.LONG_TERM,
          key,
          content: chain.label,
          importance: Math.min(1, chain.weight),
          source: 'dreaming',
          tags: ['dreaming', chain.relationshipType],
        });
        // 更新本地缓存，避免同一批次内重复写入
        existingKeys.add(key);
        existingLabels.add(chain.label);
        toStore++;
      }
    }

    // B: MemoryStore 高频访问条目 → DreamingEngine
    const frequentEntries = this.store.getFrequentEntries(3, 5);
    for (const entry of frequentEntries) {
      this.engine.recordFragment({
        content: `[高频记忆] ${entry.key}: ${entry.content}`,
        type: 'fact',
        source: 'memory_store_promotion',
        weight: entry.metadata.importance * 5,
        tags: ['memory_store', 'frequent', ...entry.metadata.tags],
      });
      toEngine++;
    }

    // B2: 近期提升到长期的记忆
    const promotedEntries = this.store.getRecentlyPromoted(60000, 3);
    for (const entry of promotedEntries) {
      this.engine.recordFragment({
        content: `[提升记忆] ${entry.key}: ${entry.content}`,
        type: 'fact',
        source: 'memory_store_promotion',
        weight: entry.metadata.importance * 4,
        tags: ['memory_store', 'promoted', ...entry.metadata.tags],
      });
      toEngine++;
    }

    if (toStore > 0 || toEngine > 0) {
      this.log.info('DreamingBridge sync complete', { toStore, toEngine });
      this.eventBus.emitSync('dreaming.bridge.sync', {
        toStore, toEngine,
        totalChains: this.engine['chains'].size,
      }, { source: 'DreamingBridge' });
    }

    return { toStore, toEngine };
  }
}
