import * as fs from 'fs';
import * as path from 'path';
import { logger } from './structured-logger.js';
import { EventBus } from './event-bus.js';
import { duanPath } from './duan-paths.js';
import { atomicWriteJsonSync } from './atomic-write.js';

interface ReplayRecord {
  sessionId: string;
  timestamp: number;
  summary: string;
  keyInsights: string[];
  toolUsage: string[];
  outcome: 'success' | 'partial' | 'failure';
  dreamingChains: string[];
}

export class SessionMemoryReplay {
  private replayDir: string;
  private records: Map<string, ReplayRecord> = new Map();
  private log = logger.child({ module: 'SessionMemoryReplay' });
  private eventBus: EventBus;

  constructor(replayDir?: string) {
    this.replayDir = replayDir || duanPath('replays');
    this.eventBus = EventBus.getInstance();
    fs.mkdirSync(this.replayDir, { recursive: true });
    this.loadFromDisk();
  }

  recordReplay(sessionId: string, summary: string, keyInsights: string[], toolUsage: string[], outcome: ReplayRecord['outcome'], dreamingChains: string[] = []): void {
    this.records.set(sessionId, { sessionId, timestamp: Date.now(), summary, keyInsights, toolUsage, outcome, dreamingChains });
    this.persist();
    this.log.info('Replay recorded', { sessionId, outcome, insightCount: keyInsights.length });
    this.eventBus.emitSync('replay.recorded', { sessionId, outcome }, { source: 'SessionMemoryReplay' });
  }

  getContextForNewSession(limit: number = 3): string {
    const recent = Array.from(this.records.values())
      .sort((a, b) => b.timestamp - a.timestamp)
      .slice(0, limit);

    if (recent.length === 0) return '';

    const blocks: string[] = ['## 🔄 跨会话经验回放'];
    for (const rec of recent) {
      const ago = this.formatTimeAgo(rec.timestamp);
      blocks.push(`--- ${ago} ---`);
      blocks.push(`  概要: ${rec.summary}`);
      if (rec.keyInsights.length > 0) {
        blocks.push(`  关键经验: ${rec.keyInsights.slice(0, 3).join('; ')}`);
      }
      blocks.push(`  结果: ${(() => {
        if (rec.outcome === 'success') return '✅ 成功';
        if (rec.outcome === 'partial') return '⚠️ 部分成功';
        return '❌ 失败';
      })()}`);
    }
    return blocks.join('\n') + '\n';
  }

  getRecordsByOutcome(outcome: ReplayRecord['outcome'], limit: number = 10): ReplayRecord[] {
    return Array.from(this.records.values())
      .filter(r => r.outcome === outcome)
      .sort((a, b) => b.timestamp - a.timestamp)
      .slice(0, limit);
  }

  getRelevantReplays(query: string, limit: number = 3): ReplayRecord[] {
    const q = query.toLowerCase();
    const scored = Array.from(this.records.values()).map(r => {
      let score = 0;
      if (r.summary.toLowerCase().includes(q)) score += 5;
      if (r.keyInsights.some(k => k.toLowerCase().includes(q))) score += 4;
      if (r.toolUsage.some(t => t.toLowerCase().includes(q))) score += 2;
      if (r.dreamingChains.some(c => c.toLowerCase().includes(q))) score += 3;
      const recency = Math.max(0, 1 - (Date.now() - r.timestamp) / (90 * 24 * 60 * 60 * 1000));
      score += recency * 3;
      return { record: r, score };
    });
    return scored.sort((a, b) => b.score - a.score).slice(0, limit).map(s => s.record);
  }

  cleanup(keepCount: number = 200): number {
    const all = Array.from(this.records.values()).sort((a, b) => b.timestamp - a.timestamp);
    if (all.length <= keepCount) return 0;
    const toRemove = all.slice(keepCount);
    for (const rec of toRemove) this.records.delete(rec.sessionId);
    this.persist();
    return toRemove.length;
  }

  getStats(): { total: number; success: number; partial: number; failure: number } {
    const all = Array.from(this.records.values());
    return {
      total: all.length,
      success: all.filter(r => r.outcome === 'success').length,
      partial: all.filter(r => r.outcome === 'partial').length,
      failure: all.filter(r => r.outcome === 'failure').length,
    };
  }

  // eslint-disable-next-line @typescript-eslint/no-explicit-any -- 工具定义需兼容 ToolDef[] (parameters: Record<string,any> / execute: (args:any)),见 bootstrap.ts standardToolModules
  getToolDefinitions(): Array<{ name: string; description: string; parameters: Record<string, any>; execute: (args: any) => Promise<string>; readOnly?: boolean }> {
    // eslint-disable-next-line @typescript-eslint/no-this-alias
    const engine = this;
    return [
      {
        name: 'replay_record',
        description: '记录本次会话的关键经验、成果和工具使用情况，供未来会话回放参考',
        parameters: {
          summary: { type: 'string', description: '会话概要', required: true },
          keyInsights: { type: 'string', description: '关键经验，逗号分隔', required: false },
          toolUsage: { type: 'string', description: '使用的工具，逗号分隔', required: false },
          outcome: { type: 'string', description: '结果: success/partial/failure', required: false },
        },
        // eslint-disable-next-line @typescript-eslint/no-explicit-any -- 工具执行参数为动态 JSON
        execute: (args: any) => {
          const summary = String(args.summary || '');
          const keyInsights = String(args.keyInsights || '').split(',').map((s: string) => s.trim()).filter(Boolean);
          const toolUsage = String(args.toolUsage || '').split(',').map((s: string) => s.trim()).filter(Boolean);
          const outcome = (args.outcome as ReplayRecord['outcome']) || 'success';
          const sessionId = `session_${Date.now()}`;
          engine.recordReplay(sessionId, summary, keyInsights, toolUsage, outcome);
          return Promise.resolve(`✅ 经验已记录 (${sessionId})`);
        },
      },
      {
        name: 'replay_query',
        description: '跨会话经验检索 — 查询过往类似任务的成功经验与失败教训',
        parameters: {
          query: { type: 'string', description: '查询关键词', required: true },
          limit: { type: 'number', description: '返回条数上限(默认3)', required: false },
        },
        readOnly: true,
        // eslint-disable-next-line @typescript-eslint/no-explicit-any -- 工具执行参数为动态 JSON
        execute: (args: any) => {
          const query = String(args.query || '');
          const limit = Number(args.limit) || 3;
          const results = engine.getRelevantReplays(query, limit);
          if (results.length === 0) return Promise.resolve('未找到相关经验记录');
          return Promise.resolve([
            '📚 跨会话经验检索结果:',
            ...results.map((r, i) =>
              `${i + 1}. [${r.outcome}] ${r.summary.slice(0, 80)} (${new Date(r.timestamp).toLocaleDateString('zh-CN')})`
            ),
          ].join('\n'));
        },
      },
      {
        name: 'replay_stats',
        description: '查看跨会话经验回放统计',
        parameters: {},
        readOnly: true,
        execute: () => {
          const stats = engine.getStats();
          return Promise.resolve([
            '📊 跨会话经验统计',
            `  总记录: ${stats.total}`,
            `  成功: ${stats.success}`,
            `  部分成功: ${stats.partial}`,
            `  失败: ${stats.failure}`,
            `  成功率: ${stats.total > 0 ? ((stats.success / stats.total) * 100).toFixed(0) : 0}%`,
          ].join('\n'));
        },
      },
    ];
  }

  private formatTimeAgo(ts: number): string {
    const mins = Math.floor((Date.now() - ts) / 60000);
    if (mins < 1) return '刚刚';
    if (mins < 60) return `${mins}分钟前`;
    const hours = Math.floor(mins / 60);
    if (hours < 24) return `${hours}小时前`;
    const days = Math.floor(hours / 24);
    if (days < 30) return `${days}天前`;
    return `${Math.floor(days / 30)}个月前`;
  }

  private persist(): void {
    try {
      atomicWriteJsonSync(
        path.join(this.replayDir, 'replays.json'),
        Array.from(this.records.values())
      );
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      this.log.warn('Replay persist failed', { error: msg });
    }
  }

  private loadFromDisk(): void {
    try {
      const filePath = path.join(this.replayDir, 'replays.json');
      if (fs.existsSync(filePath)) {
        const raw = JSON.parse(fs.readFileSync(filePath, 'utf-8'));
        if (Array.isArray(raw)) {
          for (const rec of raw) this.records.set(rec.sessionId, rec);
        }
      }
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      this.log.warn('Replay load failed', { error: msg });
    }
  }
}
