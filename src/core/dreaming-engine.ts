import * as fs from 'fs';
import * as path from 'path';
import { EventBus } from './event-bus.js';
import { logger } from './structured-logger.js';
import type { ToolDef } from './unified-tool-def.js';
import { MemoryLevel, type MemoryStore } from './memory-store.js';
import { duanPath } from './duan-paths.js';
import { atomicWriteJsonSync } from './atomic-write.js';

interface MemoryFragment {
  id: string;
  content: string;
  type: 'fact' | 'preference' | 'pattern' | 'relationship' | 'entity';
  source: string;
  timestamp: number;
  weight: number;
  tags: string[];
  metadata?: Record<string, unknown>;
}

interface MemoryChain {
  id: string;
  label: string;
  fragments: string[];
  weight: number;
  lastUpdated: number;
  relationshipType: 'supports' | 'contradicts' | 'refines' | 'provides-context-for';
}

interface DreamingConfig {
  extractIntervalMs: number;
  idleThresholdMs: number;
  maxFragmentsBeforeExtract: number;
  maxChains: number;
  persistDir: string;
}

interface DreamingStats {
  totalFragments: number;
  totalChains: number;
  totalExtraxtions: number;
  totalConsolidations: number;
  lastExtraction: number | null;
  lastConsolidation: number | null;
  chainStats: Record<string, number>;
}

const DEFAULT_CONFIG: DreamingConfig = {
  extractIntervalMs: 60000,
  idleThresholdMs: 4 * 60 * 60 * 1000,
  maxFragmentsBeforeExtract: 20,
  maxChains: 500,
  persistDir: duanPath('dreaming'),
};

export class DreamingEngine {
  private config: DreamingConfig;
  private fragments: Map<string, MemoryFragment> = new Map();
  private chains: Map<string, MemoryChain> = new Map();
  private extractTimer: ReturnType<typeof setInterval> | null = null;
  private lastUserActivity: number = Date.now();
  private extractionCount = 0;
  private consolidationCount = 0;
  private lastExtraction: number | null = null;
  private lastConsolidation: number | null = null;
  private extractResolver: ((content: string) => Promise<string>) | null = null;
  private memoryStore: MemoryStore | null = null;
  private persistTimer: ReturnType<typeof setTimeout> | null = null;
  private dirty = false;
  private log = logger.child({ module: 'DreamingEngine' });
  private eventBus: EventBus;

  constructor(config?: Partial<DreamingConfig>, memoryStore?: MemoryStore | null) {
    this.config = { ...DEFAULT_CONFIG, ...config };
    this.memoryStore = memoryStore || null;
    this.eventBus = EventBus.getInstance();
    this.ensureDir();
    this.loadFromDisk();
    this.start();
    this.log.info('DreamingEngine initialized', {
      extractIntervalMs: this.config.extractIntervalMs,
      idleThresholdMs: this.config.idleThresholdMs,
    });
  }

  setExtractResolver(resolver: (content: string) => Promise<string>): void {
    this.extractResolver = resolver;
  }

  setMemoryStore(store: MemoryStore): void {
    this.memoryStore = store;
  }

  recordActivity(): void {
    this.lastUserActivity = Date.now();
  }

  recordFragment(fragment: Omit<MemoryFragment, 'id' | 'timestamp'>): string {
    const id = `frag_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
    const entry: MemoryFragment = { ...fragment, id, timestamp: Date.now() };
    this.fragments.set(id, entry);
    this.markDirty();

    if (this.fragments.size >= this.config.maxFragmentsBeforeExtract) {
      this.runExtraction().catch(() => {});
    }
    return id;
  }

  recordInteraction(input: string, output: string, success: boolean): void {
    this.recordFragment({
      content: success ? `用户需求: ${input.slice(0, 100)}` : `失败尝试: ${input.slice(0, 100)}`,
      type: 'fact',
      source: 'interaction',
      weight: success ? 3 : 5,
      tags: ['interaction', success ? 'success' : 'failure'],
    });

    if (input.length > 20) {
      this.recordFragment({
        content: `用户兴趣信号: ${input.slice(0, 80)}`,
        type: 'preference',
        source: 'interaction',
        weight: 2,
        tags: ['preference', 'implicit'],
      });
    }
  }

  private async runExtraction(): Promise<void> {
    if (this.fragments.size === 0 || !this.extractResolver) return;

    const pendingFragments = Array.from(this.fragments.values())
      .sort((a, b) => b.weight - a.weight)
      .slice(0, 30);

    const fragmentsText = pendingFragments.map(f =>
      `[${f.type}] ${f.content} (weight: ${f.weight}, tags: ${f.tags.join(',')})`
    ).join('\n');

    try {
      const result = await this.extractResolver(`
分析以下记忆片段，提取实体、关系、偏好模式和时间敏感信息。
返回JSON格式（不要其他文字）:
{
  "entities": [{"name": "实体名", "type": "person/concept/tool/language", "importance": 0-1}],
  "relationships": [{"source": "实体名", "target": "实体名", "type": "uses/part-of/related-to/prefers", "weight": 0-1}],
  "preferences": [{"topic": "主题", "preference": "用户偏好描述", "confidence": 0-1}],
  "patterns": [{"description": "行为模式描述", "frequency": "often/sometimes/rarely"}],
  "staleness": [{"fragmentId": "id", "reason": "过时原因"}]
}

记忆片段:
${fragmentsText}
`);

      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      let parsed: any;
      try {
        const jsonMatch = result.match(/\{[\s\S]*\}/);
        parsed = jsonMatch ? JSON.parse(jsonMatch[0]) : {};
      } catch {
        parsed = {};
      }

      const now = Date.now();
      if (Array.isArray(parsed.entities)) {
        for (const entity of parsed.entities) {
          const chainId = `chain_entity_${entity.name.replace(/\s+/g, '_')}`;
          const existing = this.chains.get(chainId);
          if (existing) {
            existing.weight = Math.max(existing.weight, entity.importance);
            existing.lastUpdated = now;
          } else {
            this.chains.set(chainId, {
              id: chainId,
              label: `实体: ${entity.name}`,
              fragments: pendingFragments.filter(f => f.content.includes(entity.name)).map(f => f.id),
              weight: entity.importance,
              lastUpdated: now,
              relationshipType: 'supports',
            });
          }
        }
      }

      if (Array.isArray(parsed.relationships)) {
        for (const rel of parsed.relationships) {
          const chainId = `chain_rel_${rel.source}_${rel.type}_${rel.target}`;
          this.chains.set(chainId, {
            id: chainId,
            label: `${rel.source} ${rel.type} ${rel.target}`,
            fragments: [],
            weight: rel.weight,
            lastUpdated: now,
            relationshipType: rel.type === 'prefers' ? 'refines' : 'supports',
          });
        }
      }

      if (Array.isArray(parsed.preferences)) {
        for (const pref of parsed.preferences) {
          const chainId = `chain_pref_${pref.topic.replace(/\s+/g, '_')}`;
          const existing = this.chains.get(chainId);
          const prefStr = `[偏好] ${pref.topic}: ${pref.preference}`;
          const fragId = this.recordFragment({
            content: prefStr,
            type: 'preference',
            source: 'dreaming_extraction',
            weight: pref.confidence * 10,
            tags: ['preference', 'extracted'],
          });
          if (existing) {
            existing.lastUpdated = now;
            if (!existing.fragments.includes(fragId)) {
              existing.fragments.push(fragId);
            }
          } else {
            this.chains.set(chainId, {
              id: chainId,
              label: prefStr,
              fragments: [fragId],
              weight: pref.confidence,
              lastUpdated: now,
              relationshipType: 'refines',
            });
          }

          if (this.memoryStore) {
            this.memoryStore.store({
              level: MemoryLevel.LONG_TERM,
              key: `preference:${pref.topic}`,
              content: pref.preference,
              importance: Math.max(0.3, pref.confidence),
              source: 'dreaming',
              tags: ['dreaming', 'preference', pref.topic],
            });
          }
        }
      }

      if (Array.isArray(parsed.staleness)) {
        for (const stale of parsed.staleness) {
          this.fragments.delete(stale.fragmentId);
        }
      }

      this.enforceChainLimit();

      const processedCount = pendingFragments.length;
      for (const f of pendingFragments) {
        this.fragments.delete(f.id);
      }

      this.extractionCount++;
      this.lastExtraction = now;
      this.markDirty();

      this.log.info('Dreaming extraction complete', {
        entities: parsed.entities?.length || 0,
        relationships: parsed.relationships?.length || 0,
        preferences: parsed.preferences?.length || 0,
        patterns: parsed.patterns?.length || 0,
        processed: processedCount,
        totalChains: this.chains.size,
      });

      this.eventBus.emitSync('dreaming.extraction.complete', {
        entities: parsed.entities?.length || 0,
        preferences: parsed.preferences?.length || 0,
        totalChains: this.chains.size,
      }, { source: 'DreamingEngine' });

      this.checkIdleConsolidation();
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      this.log.warn('Dreaming extraction failed', { error: msg });
    }
  }

  private checkIdleConsolidation(): void {
    const idleTime = Date.now() - this.lastUserActivity;
    if (idleTime >= this.config.idleThresholdMs) {
      this.runConsolidation().catch(() => {});
    }
  }

  private runConsolidation(): Promise<void> {
    this.log.info('Dreaming idle consolidation starting', {
      idleTime: Date.now() - this.lastUserActivity,
      chainCount: this.chains.size,
      fragmentCount: this.fragments.size,
    });

    const chains = Array.from(this.chains.values())
      .sort((a, b) => b.weight - a.weight);

    const lowWeight = chains.filter(c => c.weight < 0.2);
    for (const chain of lowWeight) {
      this.chains.delete(chain.id);
    }

    const now = Date.now();
    const staleThreshold = 7 * 24 * 60 * 60 * 1000;
    for (const chain of this.chains.values()) {
      if (now - chain.lastUpdated > staleThreshold) {
        chain.weight *= 0.5;
      }
    }

    const duplicateKeys = new Map<string, MemoryChain[]>();
    for (const chain of this.chains.values()) {
      const key = chain.label.split(':')[0] || chain.label;
      if (!duplicateKeys.has(key)) duplicateKeys.set(key, []);
      duplicateKeys.get(key)!.push(chain);
    }
    for (const [, group] of duplicateKeys) {
      if (group.length > 3) {
        const sorted = group.sort((a, b) => b.weight - a.weight);
        for (const dup of sorted.slice(3)) {
          this.chains.delete(dup.id);
        }
      }
    }

    this.consolidationCount++;
    this.lastConsolidation = now;
    this.markDirty();

    this.log.info('Dreaming consolidation complete', {
      chainsBefore: chains.length,
      chainsAfter: this.chains.size,
      removedLowWeight: lowWeight.length,
    });
    return Promise.resolve();
  }

  queryChains(query: string, limit: number = 5): MemoryChain[] {
    const q = query.toLowerCase();
    const scored = Array.from(this.chains.values()).map(c => {
      let score = 0;
      if (c.label.toLowerCase().includes(q)) score += 3;
      if (c.fragments.some(fid => {
        const frag = this.getFragment(fid);
        return frag && frag.content.toLowerCase().includes(q);
      })) score += 2;
      score += c.weight * 2;
      score += Math.max(0, 1 - (Date.now() - c.lastUpdated) / (30 * 24 * 60 * 60 * 1000));
      return { chain: c, score };
    });
    scored.sort((a, b) => b.score - a.score);
    return scored.slice(0, limit).map(s => s.chain);
  }

  getChainsByWeight(minWeight: number): MemoryChain[] {
    return Array.from(this.chains.values())
      .filter(c => c.weight >= minWeight)
      .sort((a, b) => b.weight - a.weight);
  }

  getChainsByType(type: string): MemoryChain[] {
    return Array.from(this.chains.values())
      .filter(c => c.label.startsWith(type))
      .sort((a, b) => b.weight - a.weight);
  }

  getStats(): DreamingStats {
    const chainTypes: Record<string, number> = {};
    for (const chain of this.chains.values()) {
      const type = chain.label.split(':')[0] || 'unknown';
      chainTypes[type] = (chainTypes[type] || 0) + 1;
    }
    return {
      totalFragments: this.fragments.size,
      totalChains: this.chains.size,
      totalExtraxtions: this.extractionCount,
      totalConsolidations: this.consolidationCount,
      lastExtraction: this.lastExtraction,
      lastConsolidation: this.lastConsolidation,
      chainStats: chainTypes,
    };
  }

  formatForPrompt(limit: number = 5): string {
    const topChains = Array.from(this.chains.values())
      .sort((a, b) => b.weight - a.weight)
      .slice(0, limit);
    if (topChains.length === 0) return '';
    return '## 🌙 Dreaming 记忆链\n' + topChains.map(c =>
      `- ${c.label} (权重: ${c.weight.toFixed(2)}, 更新: ${new Date(c.lastUpdated).toLocaleDateString('zh-CN')})`
    ).join('\n');
  }

  private enforceChainLimit(): void {
    if (this.chains.size <= this.config.maxChains) return;
    const sorted = Array.from(this.chains.values())
      .sort((a, b) => a.weight - b.weight || a.lastUpdated - b.lastUpdated);
    const toRemove = sorted.slice(0, this.chains.size - this.config.maxChains);
    for (const chain of toRemove) {
      this.chains.delete(chain.id);
    }
  }

  private getFragment(id: string): MemoryFragment | undefined {
    return this.fragments.get(id);
  }

  private start(): void {
    this.extractTimer = setInterval(() => {
      this.runExtraction().catch(err => {
        logger.warn('记忆抽取周期任务失败 — 记忆巩固链路中断', { error: err?.message });
      });
    }, this.config.extractIntervalMs);
    // 防止定时器阻止进程优雅退出
    if (typeof this.extractTimer.unref === 'function') this.extractTimer.unref();
  }

  stop(): void {
    if (this.extractTimer) {
      clearInterval(this.extractTimer);
      this.extractTimer = null;
    }
    this.flush();
  }

  private ensureDir(): void {
    try { fs.mkdirSync(this.config.persistDir, { recursive: true }); } catch {}
  }

  private loadFromDisk(): void {
    const chainsPath = path.join(this.config.persistDir, 'chains.json');
    const fragmentsPath = path.join(this.config.persistDir, 'fragments.json');
    try {
      if (fs.existsSync(chainsPath)) {
        const raw = JSON.parse(fs.readFileSync(chainsPath, 'utf-8'));
        if (Array.isArray(raw)) {
          for (const chain of raw) {
            this.chains.set(chain.id, chain);
          }
        }
      }
    } catch (e) {
      console.warn('[DreamingEngine] 加载 chains.json 失败:', e instanceof Error ? e.message : String(e));
    }
    try {
      if (fs.existsSync(fragmentsPath)) {
        const raw = JSON.parse(fs.readFileSync(fragmentsPath, 'utf-8'));
        if (Array.isArray(raw)) {
          for (const frag of raw) {
            this.fragments.set(frag.id, frag);
          }
        }
      }
    } catch (e) {
      console.warn('[DreamingEngine] 加载 fragments.json 失败:', e instanceof Error ? e.message : String(e));
    }
    try {
      const metaPath = path.join(this.config.persistDir, 'meta.json');
      if (fs.existsSync(metaPath)) {
        const meta = JSON.parse(fs.readFileSync(metaPath, 'utf-8'));
        this.extractionCount = meta.extractionCount || 0;
        this.consolidationCount = meta.consolidationCount || 0;
        this.lastExtraction = meta.lastExtraction || null;
        this.lastConsolidation = meta.lastConsolidation || null;
      }
    } catch (e) {
      console.warn('[DreamingEngine] 加载 meta.json 失败:', e instanceof Error ? e.message : String(e));
    }
  }

  private markDirty(): void {
    this.dirty = true;
    if (!this.persistTimer) {
      this.persistTimer = setTimeout(() => this.flush(), 5000);
      if (typeof this.persistTimer.unref === 'function') this.persistTimer.unref();
    }
  }

  flush(): void {
    this.persistTimer = null;
    if (!this.dirty) return;
    this.dirty = false;
    try {
      this.ensureDir();
      atomicWriteJsonSync(
        path.join(this.config.persistDir, 'chains.json'),
        Array.from(this.chains.values()),
      );
      atomicWriteJsonSync(
        path.join(this.config.persistDir, 'fragments.json'),
        Array.from(this.fragments.values()).slice(-100),
      );
      atomicWriteJsonSync(
        path.join(this.config.persistDir, 'meta.json'),
        {
          extractionCount: this.extractionCount,
          consolidationCount: this.consolidationCount,
          lastExtraction: this.lastExtraction,
          lastConsolidation: this.lastConsolidation,
        },
      );
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      this.log.warn('Dreaming persist failed', { error: msg });
    }
  }

  getToolDefinitions(): ToolDef[] {
    // eslint-disable-next-line @typescript-eslint/no-this-alias
    const engine = this;
    return [
      {
        name: 'dreaming_status',
        description: '查看 Dreaming 记忆合成引擎状态：总链数、碎片数、提取和合并次数、最新活动',
        parameters: {},
        readOnly: true,
        execute: () => {
          const stats = engine.getStats();
          return Promise.resolve([
            '🌙 Dreaming 记忆合成引擎状态',
            `  记忆链: ${stats.totalChains}`,
            `  待处理碎片: ${stats.totalFragments}`,
            `  提取次数: ${stats.totalExtraxtions}`,
            `  合并次数: ${stats.totalConsolidations}`,
            `  上次提取: ${stats.lastExtraction ? new Date(stats.lastExtraction).toLocaleString('zh-CN') : '从未'}`,
            `  上次合并: ${stats.lastConsolidation ? new Date(stats.lastConsolidation).toLocaleString('zh-CN') : '从未'}`,
            `  链类型分布:`,
            ...Object.entries(stats.chainStats).map(([type, count]) => `    ${type}: ${count}条`),
          ].join('\n'));
        },
      },
      {
        name: 'dreaming_query',
        description: '查询 Dreaming 记忆链，检索与查询相关的跨会话记忆',
        parameters: {
          query: { type: 'string', description: '查询关键词', required: true },
          limit: { type: 'number', description: '返回条数上限(默认5)', required: false },
        },
        readOnly: true,
        execute: (args) => {
          const query = String(args.query || '');
          const limit = Number(args.limit) || 5;
          const results = engine.queryChains(query, limit);
          if (results.length === 0) return Promise.resolve('未找到相关记忆链');
          return Promise.resolve([
            `🔍 记忆链查询结果 (${results.length}条):`,
            ...results.map((c, i) =>
              `${i + 1}. ${c.label} [权重: ${c.weight.toFixed(2)}] [更新: ${new Date(c.lastUpdated).toLocaleDateString('zh-CN')}]`
            ),
          ].join('\n'));
        },
      },
      {
        name: 'dreaming_forget',
        description: '删除低权重或过期的记忆链，手动触发清理',
        parameters: {
          minWeight: { type: 'number', description: '最低保留权重(0-1, 默认0.2)', required: false },
        },
        execute: (args) => {
          const minWeight = Number(args.minWeight) || 0.2;
          let removed = 0;
          for (const [id, chain] of engine.chains) {
            if (chain.weight < minWeight) {
              engine.chains.delete(id);
              removed++;
            }
          }
          engine.markDirty();
          return Promise.resolve(`✅ 已清理 ${removed} 条低权重记忆链（权重 < ${minWeight}），剩余 ${engine.chains.size} 条`);
        },
      },
      {
        name: 'dreaming_record',
        description: '手动记录一条记忆碎片供 Dreaming 引擎后台处理',
        parameters: {
          content: { type: 'string', description: '记忆内容', required: true },
          type: { type: 'string', description: '类型: fact/preference/pattern/relationship/entity', required: false },
          tags: { type: 'string', description: '标签，逗号分隔', required: false },
        },
        execute: (args) => {
          const content = String(args.content || '');
          const type = (args.type as string) || 'fact';
          const tags = String(args.tags || '').split(',').map(t => t.trim()).filter(Boolean);
          const validTypes = ['fact', 'preference', 'pattern', 'relationship', 'entity'];
          const finalType = validTypes.includes(type) ? type : 'fact';
          const id = engine.recordFragment({ content, type: finalType as MemoryFragment['type'], source: 'manual', weight: 5, tags });
          return Promise.resolve(`✅ 记忆碎片已记录 (ID: ${id})，将在下次提取时处理`);
        },
      },
    ];
  }
}
