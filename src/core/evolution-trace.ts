/**
 * 进化追溯系统 - EvolutionTrace
 *
 * 确保进化过程的可追溯与可解释：
 * 1. 进化事件记录 - 记录所有进化相关事件
 * 2. 因果链追踪 - 追踪进化决策的因果链
 * 3. 版本快照 - 记录系统在关键节点的状态快照
 * 4. 影响分析 - 分析每次进化的影响范围
 * 5. 可解释性输出 - 生成人类可读的进化解释
 */

import * as fs from 'fs/promises';
import * as path from 'path';
import { logger } from './structured-logger.js';
import { atomicWriteJson } from './atomic-write.js';

/** 进化事件 */
export interface EvolutionEvent {
  id: string;
  type: 'assessment' | 'goal_set' | 'action_executed' | 'action_rolled_back' | 'strategy_changed' | 'module_replaced' | 'verification' | 'safety_violation';
  timestamp: Date;
  description: string;
  actor: 'system' | 'user' | 'auto';
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  data: Record<string, any>;
  causalParentIds: string[];              // 因果父事件ID
  impact: 'positive' | 'negative' | 'neutral';
  impactScore: number;                    // -1 到 1
}

/** 系统快照 */
interface SystemSnapshot {
  id: string;
  timestamp: Date;
  trigger: string;                        // 触发快照的原因
  metrics: Record<string, number>;
  moduleVersions: Record<string, string>;
  activeGoals: string[];
  eventCount: number;
}

/** 因果链 */
interface CausalChain {
  startEventId: string;
  endEventId: string;
  events: EvolutionEvent[];
  totalImpact: number;
  description: string;
}

/** 影响分析结果 */
interface ImpactAnalysis {
  eventId: string;
  directImpact: string[];
  indirectImpact: string[];
  affectedMetrics: Record<string, { before: number; after: number; change: number }>;
  affectedModules: string[];
  riskLevel: 'low' | 'medium' | 'high';
}

export class EvolutionTrace {
  private events: EvolutionEvent[] = [];
  private snapshots: SystemSnapshot[] = [];
  private dataDir: string;
  private maxEvents: number = 50000;

  // 索引：用于 O(1) 查找事件及其因果子事件，避免全量 filter/find
  private eventById: Map<string, EvolutionEvent> = new Map();
  private childrenIndex: Map<string, EvolutionEvent[]> = new Map();

  constructor(dataDir: string = './data/evolution-trace') {
    this.dataDir = dataDir;
  }

  /** 将单个事件加入索引 */
  private indexEvent(event: EvolutionEvent): void {
    this.eventById.set(event.id, event);
    for (const parentId of event.causalParentIds || []) {
      let arr = this.childrenIndex.get(parentId);
      if (!arr) {
        arr = [];
        this.childrenIndex.set(parentId, arr);
      }
      arr.push(event);
    }
  }

  /** 重建全部索引（在批量替换 events 后调用） */
  private rebuildIndexes(): void {
    this.eventById.clear();
    this.childrenIndex.clear();
    for (const event of this.events) this.indexEvent(event);
  }

  /**
   * 记录进化事件
   */
  recordEvent(event: Omit<EvolutionEvent, 'id' | 'timestamp'>): string {
    const id = `evt_${Date.now()}_${Math.random().toString(36).substr(2, 6)}`;

    const fullEvent: EvolutionEvent = {
      ...event,
      id,
      timestamp: new Date(),
    };

    this.events.push(fullEvent);
    this.indexEvent(fullEvent);

    // 限制事件数量
    if (this.events.length > this.maxEvents) {
      this.events = this.events.slice(-this.maxEvents / 2);
      this.rebuildIndexes();
    }

    return id;
  }

  /**
   * 创建系统快照
   */
  createSnapshot(trigger: string, metrics: Record<string, number>, moduleVersions: Record<string, string>, activeGoals: string[]): string {
    const id = `snap_${Date.now()}`;

    const snapshot: SystemSnapshot = {
      id,
      timestamp: new Date(),
      trigger,
      metrics,
      moduleVersions,
      activeGoals,
      eventCount: this.events.length,
    };

    this.snapshots.push(snapshot);

    // 限制快照数量
    if (this.snapshots.length > 100) {
      this.snapshots = this.snapshots.slice(-50);
    }

    return id;
  }

  /**
   * 追溯因果链
   */
  traceCausalChain(eventId: string, maxDepth: number = 10): CausalChain | null {
    const targetEvent = this.eventById.get(eventId);
    if (!targetEvent) return null;

    const chainEvents: EvolutionEvent[] = [targetEvent];
    const visited = new Set<string>([eventId]);

    // 向上追溯因果
    let current = targetEvent;
    let depth = 0;

    while (depth < maxDepth) {
      const parentIds = current.causalParentIds;
      if (!parentIds || parentIds.length === 0) break;

      let parentEvent: EvolutionEvent | undefined;
      for (const pid of parentIds) {
        if (visited.has(pid)) continue;
        const candidate = this.eventById.get(pid);
        if (candidate) {
          parentEvent = candidate;
          break;
        }
      }
      if (!parentEvent) break;

      chainEvents.unshift(parentEvent);
      visited.add(parentEvent.id);
      current = parentEvent;
      depth++;
    }

    const totalImpact = chainEvents.reduce((sum, e) => sum + e.impactScore, 0);

    return {
      startEventId: chainEvents[0].id,
      endEventId: chainEvents[chainEvents.length - 1].id,
      events: chainEvents,
      totalImpact,
      description: this.generateChainDescription(chainEvents),
    };
  }

  /**
   * 分析事件影响
   */
  analyzeImpact(eventId: string): ImpactAnalysis | null {
    const event = this.eventById.get(eventId);
    if (!event) return null;

    // 查找直接受影响的事件（通过索引 O(直接子节点数)）
    const directEvents = this.childrenIndex.get(eventId) || [];
    const directImpact = directEvents.map(e => `${e.type}: ${e.description}`);

    // 查找间接受影响的事件（2层，通过索引避免 O(n²)）
    const indirectImpact: string[] = [];
    for (const directEvent of directEvents) {
      const indirect = (this.childrenIndex.get(directEvent.id) || [])
        .map(e => `${e.type}: ${e.description}`);
      indirectImpact.push(...indirect);
    }

    // 分析指标变化
    const eventIndex = this.events.indexOf(event);
    const _beforeEvents = this.events.slice(Math.max(0, eventIndex - 5), eventIndex);
    const _afterEvents = this.events.slice(eventIndex + 1, eventIndex + 6);

    const affectedMetrics: Record<string, { before: number; after: number; change: number }> = {};
    // 简化：基于事件数据中的指标
    if (event.data.metrics) {
      for (const [key, value] of Object.entries(event.data.metrics as Record<string, number>)) {
        affectedMetrics[key] = { before: value, after: value, change: 0 };
      }
    }

    // 受影响的模块
    const affectedModules: string[] = [];
    if (event.data.moduleId) affectedModules.push(event.data.moduleId);

    // 风险评估
    let riskLevel: 'low' | 'medium' | 'high';
    if (event.impact === 'negative' && event.impactScore < -0.5) riskLevel = 'high';
    else if (event.impact === 'negative') riskLevel = 'medium';
    else riskLevel = 'low';

    return {
      eventId,
      directImpact,
      indirectImpact,
      affectedMetrics,
      affectedModules,
      riskLevel,
    };
  }

  /**
   * 查询事件
   */
  queryEvents(filter: {
    type?: EvolutionEvent['type'];
    actor?: EvolutionEvent['actor'];
    impact?: EvolutionEvent['impact'];
    startTime?: Date;
    endTime?: Date;
    limit?: number;
  }): EvolutionEvent[] {
    const startMs = filter.startTime ? filter.startTime.getTime() : undefined;
    const endMs = filter.endTime ? filter.endTime.getTime() : undefined;

    // 单次遍历完成所有过滤，避免多次全量 filter
    const results: EvolutionEvent[] = [];
    for (const e of this.events) {
      if (filter.type && e.type !== filter.type) continue;
      if (filter.actor && e.actor !== filter.actor) continue;
      if (filter.impact && e.impact !== filter.impact) continue;
      const t = e.timestamp.getTime();
      if (startMs !== undefined && t < startMs) continue;
      if (endMs !== undefined && t > endMs) continue;
      results.push(e);
    }

    results.sort((a, b) => b.timestamp.getTime() - a.timestamp.getTime());

    if (filter.limit) return results.slice(0, filter.limit);

    return results;
  }

  /**
   * 生成可解释的进化报告
   */
  generateExplanation(eventId: string): string {
    const event = this.eventById.get(eventId);
    if (!event) return '事件不存在';

    const causalChain = this.traceCausalChain(eventId);
    const impact = this.analyzeImpact(eventId);

    const lines: string[] = [];

    lines.push(`🔍 进化事件解释: ${event.id}`);
    lines.push('');
    lines.push(`类型: ${event.type}`);
    lines.push(`时间: ${event.timestamp.toLocaleString('zh-CN')}`);
    lines.push(`描述: ${event.description}`);
    let actorLabel: string;
    if (event.actor === 'system') {
      actorLabel = '系统自动';
    } else if (event.actor === 'user') {
      actorLabel = '用户';
    } else {
      actorLabel = '自动';
    }
    lines.push(`触发者: ${actorLabel}`);
    lines.push(`影响: ${event.impact} (分数: ${event.impactScore.toFixed(2)})`);
    lines.push('');

    if (causalChain && causalChain.events.length > 1) {
      lines.push('━━━ 因果链 ━━━');
      for (let i = 0; i < causalChain.events.length; i++) {
        const evt = causalChain.events[i];
        const arrow = i < causalChain.events.length - 1 ? '  ↓' : '';
        lines.push(`  ${i + 1}. [${evt.type}] ${evt.description} ${arrow}`);
      }
      lines.push(`综合影响: ${causalChain.totalImpact >= 0 ? '+' : ''}${causalChain.totalImpact.toFixed(2)}`);
      lines.push('');
    }

    if (impact) {
      lines.push('━━━ 影响分析 ━━━');
      if (impact.directImpact.length > 0) {
        lines.push('直接影响:');
        for (const imp of impact.directImpact) lines.push(`  → ${imp}`);
      }
      if (impact.indirectImpact.length > 0) {
        lines.push('间接影响:');
        for (const imp of impact.indirectImpact) lines.push(`  → ${imp}`);
      }
      lines.push(`风险等级: ${impact.riskLevel}`);
    }

    return lines.join('\n');
  }

  /**
   * 生成进化时间线
   */
  generateTimeline(limit: number = 20): string {
    const recentEvents = this.events.slice(-limit);
    const lines: string[] = [];

    lines.push('📅 进化时间线');
    lines.push('');

    for (const event of recentEvents) {
      let icon: string;
      if (event.impact === 'positive') {
        icon = '✅';
      } else if (event.impact === 'negative') {
        icon = '❌';
      } else {
        icon = '➡️';
      }
      const time = event.timestamp.toLocaleString('zh-CN');
      lines.push(`${icon} [${time}] ${event.type}: ${event.description}`);
    }

    return lines.join('\n');
  }

  /**
   * 获取统计
   */
  getStats(): {
    totalEvents: number;
    eventsByType: Record<string, number>;
    positiveImpactCount: number;
    negativeImpactCount: number;
    snapshotCount: number;
  } {
    // 单次遍历完成所有统计，避免多次全量 filter
    const eventsByType: Record<string, number> = {};
    let positiveImpactCount = 0;
    let negativeImpactCount = 0;
    for (const event of this.events) {
      eventsByType[event.type] = (eventsByType[event.type] || 0) + 1;
      if (event.impact === 'positive') positiveImpactCount++;
      else if (event.impact === 'negative') negativeImpactCount++;
    }

    return {
      totalEvents: this.events.length,
      eventsByType,
      positiveImpactCount,
      negativeImpactCount,
      snapshotCount: this.snapshots.length,
    };
  }

  /**
   * 持久化到磁盘
   */
  async save(): Promise<void> {
    try {
      await fs.mkdir(this.dataDir, { recursive: true });
      const date = new Date().toISOString().split('T')[0];
      await atomicWriteJson(
        path.join(this.dataDir, `trace-${date}.json`),
        { events: this.events.slice(-1000), snapshots: this.snapshots.slice(-10) }
      );
    } catch (error: unknown) {
      const msg = error instanceof Error ? error.message : String(error);
      logger.error('保存进化追溯数据失败', { module: 'EvolutionTrace', error: msg });
    }
  }

  /**
   * 从磁盘加载
   */
  async load(): Promise<void> {
    try {
      await fs.mkdir(this.dataDir, { recursive: true });
      const files = await fs.readdir(this.dataDir);
      const jsonFiles = files.filter(f => f.endsWith('.json')).sort().slice(-7);

      for (const file of jsonFiles) {
        try {
          const content = await fs.readFile(path.join(this.dataDir, file), 'utf-8');
          const data = JSON.parse(content);
          if (data.events) {
            // eslint-disable-next-line @typescript-eslint/no-explicit-any
            this.events.push(...data.events.map((e: any) => ({
              ...e,
              timestamp: new Date(e.timestamp),
            })));
          }
          if (data.snapshots) {
            // eslint-disable-next-line @typescript-eslint/no-explicit-any
            this.snapshots.push(...data.snapshots.map((s: any) => ({
              ...s,
              timestamp: new Date(s.timestamp),
            })));
          }
        } catch { /* skip */ }
      }
      // 加载完成后重建索引
      this.rebuildIndexes();
    } catch { /* dir not exist */ }
  }

  private generateChainDescription(events: EvolutionEvent[]): string {
    if (events.length === 0) return '空因果链';
    if (events.length === 1) return events[0].description;

    const first = events[0];
    const last = events[events.length - 1];
    return `从"${first.description}"到"${last.description}"的因果链，共${events.length}步`;
  }
}
