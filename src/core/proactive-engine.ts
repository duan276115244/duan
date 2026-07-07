import * as fs from 'fs';
import * as path from 'path';
import { EventBus } from './event-bus.js';
import { logger } from './structured-logger.js';
import type { ToolDef } from './unified-tool-def.js';
import { duanPath } from './duan-paths.js';
import { atomicWriteJsonSync } from './atomic-write.js';

interface TriggerConfig {
  id: string;
  type: 'time' | 'interval' | 'event' | 'habit' | 'condition' | 'file_watch';
  label: string;
  action: string;
  enabled: boolean;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  config: Record<string, any>;
  lastFired?: number;
  cooldownMs?: number;
  createdAt: number;
  fireCount: number;
}

interface HabitRecord {
  pattern: string;
  frequency: number;
  lastObserved: number;
  confidence: number;
  suggestedTrigger?: string;
  category: 'work' | 'study' | 'rest' | 'communication' | 'other';
}

interface ProactiveAction {
  id: string;
  trigger: string;
  suggestion: string;
  priority: 'high' | 'normal' | 'low';
  createdAt: number;
  dismissed: boolean;
  source: 'trigger' | 'habit' | 'time' | 'system';
}

interface UserTiming {
  hour: number;
  dayOfWeek: number;
  activity: 'active' | 'idle' | 'away';
  commonTasks: string[];
}

const DEFAULT_PERSIST_DIR = duanPath('proactive');

export class ProactiveEngine {
  private triggers: Map<string, TriggerConfig> = new Map();
  private habits: HabitRecord[] = [];
  private actions: ProactiveAction[] = [];
  private timingHistory: UserTiming[] = [];
  private persistDir: string;
  private checkTimer: ReturnType<typeof setInterval> | null = null;
  private actionHandler: ((action: ProactiveAction) => Promise<void>) | null = null;
  private backgroundSpawner: ((goal: string, context?: string) => Promise<string>) | null = null;
  private log = logger.child({ module: 'ProactiveEngine' });
  private eventBus: EventBus;
  /** 懒加载标记 */
  private stateLoaded = false;

  constructor(persistDir?: string) {
    this.persistDir = persistDir || DEFAULT_PERSIST_DIR;
    this.eventBus = EventBus.getInstance();
    // 不在构造函数中执行同步 I/O，延迟到首次访问
    this.startHeartbeat();
  }

  /** 懒加载：首次访问数据时才从磁盘加载 */
  private ensureStateLoaded(): void {
    if (this.stateLoaded) return;
    this.stateLoaded = true;
    this.ensureDir();
    this.loadFromDisk();
    this.log.info('ProactiveEngine data loaded', {
      triggers: this.triggers.size,
      habits: this.habits.length,
    });
  }

  setActionHandler(handler: (action: ProactiveAction) => Promise<void>): void {
    this.actionHandler = handler;
  }

  setBackgroundSpawner(spawner: (goal: string, context?: string) => Promise<string>): void {
    this.backgroundSpawner = spawner;
  }

  addTrigger(config: Omit<TriggerConfig, 'id' | 'createdAt' | 'fireCount' | 'enabled'>): string {
    this.ensureStateLoaded();
    const id = `trig_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
    const trigger: TriggerConfig = {
      ...config,
      id,
      enabled: true,
      createdAt: Date.now(),
      fireCount: 0,
    };
    this.triggers.set(id, trigger);
    this.persist();
    this.log.info('Trigger added', { id, type: config.type, label: config.label });
    return id;
  }

  removeTrigger(id: string): boolean {
    this.ensureStateLoaded();
    const existed = this.triggers.delete(id);
    if (existed) this.persist();
    return existed;
  }

  enableTrigger(id: string, enabled: boolean): boolean {
    this.ensureStateLoaded();
    const trigger = this.triggers.get(id);
    if (!trigger) return false;
    trigger.enabled = enabled;
    this.persist();
    return true;
  }

  getTriggers(): TriggerConfig[] {
    this.ensureStateLoaded();
    return Array.from(this.triggers.values());
  }

  recordActivity(task: string, hour: number, dayOfWeek: number): void {
    this.ensureStateLoaded();
    this.timingHistory.push({ hour, dayOfWeek, activity: 'active', commonTasks: [task] });
    if (this.timingHistory.length > 1000) {
      this.timingHistory = this.timingHistory.slice(-500);
    }

    const existingHabit = this.habits.find(h =>
      task.toLowerCase().includes(h.pattern.toLowerCase())
    );
    if (existingHabit) {
      existingHabit.frequency++;
      existingHabit.lastObserved = Date.now();
      existingHabit.confidence = Math.min(1, existingHabit.confidence + 0.05);
    } else if (task.length > 5) {
      const category = this.inferCategory(task);
      this.habits.push({
        pattern: task.slice(0, 40),
        frequency: 1,
        lastObserved: Date.now(),
        confidence: 0.3,
        category,
      });
    }

    if (this.habits.length > 200) {
      this.habits.sort((a, b) => b.confidence - a.confidence);
      this.habits = this.habits.slice(0, 200);
    }

    this.persist();
  }

  suggestActions(limit: number = 3): ProactiveAction[] {
    this.ensureStateLoaded();
    const now = Date.now();
    const currentHour = new Date().getHours();
    const _currentDay = new Date().getDay();

    const pending: ProactiveAction[] = [];

    for (const trigger of this.triggers.values()) {
      if (!trigger.enabled) continue;
      if (trigger.lastFired && trigger.cooldownMs && now - trigger.lastFired < trigger.cooldownMs) continue;

      let shouldFire = false;
      switch (trigger.type) {
        case 'time': {
          const [h, m] = (trigger.config.hour ?? '9').toString().split(':').map(Number);
          shouldFire = currentHour === (h ?? 9) && new Date().getMinutes() === (m ?? 0);
          break;
        }
        case 'interval': {
          const intervalMs = Number(trigger.config.intervalMs) || 3600000;
          shouldFire = !trigger.lastFired || (now - trigger.lastFired >= intervalMs);
          break;
        }
        case 'condition': {
          const cond = String(trigger.config.check || '');
          if (cond === 'idle') {
            shouldFire = this.timingHistory.length > 0 &&
              now - (this.timingHistory[this.timingHistory.length - 1]?.activity === 'active' ? Date.now() : Date.now()) > 1800000;
          }
          break;
        }
      }

      if (shouldFire) {
        pending.push({
          id: `act_${Date.now()}_${Math.random().toString(36).slice(2, 6)}`,
          trigger: trigger.id,
          suggestion: trigger.action,
          priority: trigger.config.priority || 'normal',
          createdAt: now,
          dismissed: false,
          source: 'trigger',
        });
        trigger.lastFired = now;
        trigger.fireCount++;
        this.persist();

        if (trigger.config.spawnAgent && this.backgroundSpawner) {
          this.backgroundSpawner(trigger.action, `自动触发的后台任务: ${trigger.label}`)
            .then(bgId => {
              this.log.info('Background agent spawned by trigger', { triggerId: trigger.id, bgId });
            })
            .catch(err => {
              this.log.warn('Failed to spawn background agent from trigger', { triggerId: trigger.id, error: err.message });
            });
        }
      }
    }

    const highConfHabits = this.habits
      .filter(h => h.confidence > 0.6)
      .filter(h => {
        const lastActivity = this.timingHistory.filter(t => t.activity === 'active');
        if (lastActivity.length === 0) return true;
        const recentTasks = lastActivity.slice(-5).flatMap(t => t.commonTasks);
        const patternWords = h.pattern.split(/\s+/);
        return !patternWords.some(w => recentTasks.some(t => t.includes(w)));
      });

    for (const habit of highConfHabits.slice(0, 2)) {
      pending.push({
        id: `act_${Date.now()}_${Math.random().toString(36).slice(2, 6)}`,
        trigger: 'habit',
        suggestion: `基于你的习惯，你可能想做: ${habit.pattern}`,
        priority: habit.confidence > 0.8 ? 'normal' : 'low',
        createdAt: now,
        dismissed: false,
        source: 'habit',
      });
    }

    pending.sort((a, b) => {
      const rank = { high: 0, normal: 1, low: 2 };
      return (rank[a.priority] ?? 1) - (rank[b.priority] ?? 1);
    });

    this.actions.push(...pending);
    if (this.actions.length > 100) {
      this.actions = this.actions.slice(-100);
    }

    return pending.slice(0, limit);
  }

  dismissAction(id: string): boolean {
    this.ensureStateLoaded();
    const action = this.actions.find(a => a.id === id);
    if (!action) return false;
    action.dismissed = true;
    return true;
  }

  formatSuggestionsForPrompt(): string {
    const suggestions = this.suggestActions(3).filter(a => !a.dismissed);
    if (suggestions.length === 0) return '';
    return [
      '## 💡 主动建议',
      ...suggestions.map(a => `- [${a.priority}] ${a.suggestion}`),
      '',
    ].join('\n');
  }

  private checkTimedTriggers(): void {
    const suggestions = this.suggestActions();
    if (suggestions.length > 0 && this.actionHandler) {
      for (const action of suggestions) {
        this.actionHandler(action).catch(() => {});
      }
    }
  }

  private startHeartbeat(): void {
    this.checkTimer = setInterval(() => {
      this.checkTimedTriggers();
    }, 60000);
  }

  stop(): void {
    if (this.checkTimer) {
      clearInterval(this.checkTimer);
      this.checkTimer = null;
    }
    if (this.stateLoaded) this.persist();
  }

  private inferCategory(task: string): 'work' | 'study' | 'rest' | 'communication' | 'other' {
    const lower = task.toLowerCase();
    if (/code|debug|refactor|implement|test|build|deploy|fix|feature/i.test(lower)) return 'work';
    if (/read|learn|study|tutorial|document|research|paper/i.test(lower)) return 'study';
    if (/game|music|video|rest|break|lunch|coffee/i.test(lower)) return 'rest';
    if (/chat|email|message|call|meeting|discuss|review/i.test(lower)) return 'communication';
    return 'other';
  }

  private ensureDir(): void {
    try { fs.mkdirSync(this.persistDir, { recursive: true }); } catch {}
  }

  private loadFromDisk(): void {
    const triggersPath = path.join(this.persistDir, 'triggers.json');
    const habitsPath = path.join(this.persistDir, 'habits.json');
    const timingPath = path.join(this.persistDir, 'timing.json');
    try {
      if (fs.existsSync(triggersPath)) {
        const raw = JSON.parse(fs.readFileSync(triggersPath, 'utf-8'));
        for (const t of raw) this.triggers.set(t.id, t);
      }
    } catch {}
    try {
      if (fs.existsSync(habitsPath)) {
        this.habits = JSON.parse(fs.readFileSync(habitsPath, 'utf-8'));
      }
    } catch {}
    try {
      if (fs.existsSync(timingPath)) {
        this.timingHistory = JSON.parse(fs.readFileSync(timingPath, 'utf-8'));
      }
    } catch {}
  }

  private persist(): void {
    try {
      this.ensureDir();
      atomicWriteJsonSync(path.join(this.persistDir, 'triggers.json'), Array.from(this.triggers.values()));
      atomicWriteJsonSync(path.join(this.persistDir, 'habits.json'), this.habits.slice(-200));
      atomicWriteJsonSync(path.join(this.persistDir, 'timing.json'), this.timingHistory.slice(-500));
    } catch (err: unknown) {
      this.log.warn('Proactive persist failed', { error: (err instanceof Error ? err.message : String(err)) });
    }
  }

  getToolDefinitions(): ToolDef[] {
    // eslint-disable-next-line @typescript-eslint/no-this-alias
    const engine = this;
    return [
      {
        name: 'proactive_trigger_add',
        description: '添加一个主动触发器：定时(time)、间隔(interval)、条件(condition)触发主动行为',
        parameters: {
          type: { type: 'string', description: '触发器类型: time/interval/condition', required: true },
          label: { type: 'string', description: '触发器名称', required: true },
          action: { type: 'string', description: '触发后要执行的动作描述', required: true },
          hour: { type: 'number', description: '定时触发的小时(0-23)，仅 type=time 时使用', required: false },
          minute: { type: 'number', description: '定时触发的分钟(0-59)，仅 type=time 时使用', required: false },
          intervalMs: { type: 'number', description: '间隔毫秒(默认3600000)，仅 type=interval 时使用', required: false },
          check: { type: 'string', description: '条件检查: idle(空闲检测)，仅 type=condition 时使用', required: false },
          cooldownMs: { type: 'number', description: '冷却时间毫秒(默认不限制)', required: false },
          spawnAgent: { type: 'boolean', description: '触发时自动创建后台Agent执行动作', required: false },
        },
        execute: (args) => {
          const id = engine.addTrigger({
            type: args.type as TriggerConfig['type'],
            label: String(args.label || ''),
            action: String(args.action || ''),
            config: {
              hour: args.hour,
              minute: args.minute,
              intervalMs: args.intervalMs,
              check: args.check,
              priority: args.priority || 'normal',
              spawnAgent: args.spawnAgent === true,
            },
            cooldownMs: args.cooldownMs ? Number(args.cooldownMs) : undefined,
          });
          return Promise.resolve(`✅ 触发器已添加 (ID: ${id})\n类型: ${args.type}\n标签: ${args.label}\n动作: ${args.action}`);
        },
      },
      {
        name: 'proactive_trigger_list',
        description: '查看所有主动触发器及其状态',
        parameters: {},
        readOnly: true,
        execute: () => {
          const triggers = engine.getTriggers();
          if (triggers.length === 0) return Promise.resolve('暂无触发器');
          return Promise.resolve([
            '⏰ 主动触发器列表:',
            ...triggers.map(t =>
              `  [${t.enabled ? '✅' : '⏸️'}] ${t.label} (${t.type}) - ${t.action.slice(0, 50)} | 触发${t.fireCount}次 | ${t.lastFired ? `上次: ${new Date(t.lastFired).toLocaleString('zh-CN')}` : '从未触发'}`
            ),
          ].join('\n'));
        },
      },
      {
        name: 'proactive_trigger_remove',
        description: '删除指定触发器',
        parameters: {
          id: { type: 'string', description: '触发器ID', required: true },
        },
        execute: (args) => {
          const removed = engine.removeTrigger(String(args.id || ''));
          return Promise.resolve(removed ? `✅ 触发器已删除` : `❌ 未找到触发器: ${args.id}`);
        },
      },
      {
        name: 'proactive_trigger_toggle',
        description: '启用/禁用指定触发器',
        parameters: {
          id: { type: 'string', description: '触发器ID', required: true },
          enabled: { type: 'boolean', description: '是否启用', required: true },
        },
        execute: (args) => {
          const ok = engine.enableTrigger(String(args.id || ''), Boolean(args.enabled));
          return Promise.resolve(ok ? `✅ 触发器已${args.enabled ? '启用' : '禁用'}` : `❌ 未找到触发器: ${args.id}`);
        },
      },
      {
        name: 'proactive_habits',
        description: '查看学习到的用户习惯模式',
        parameters: {},
        readOnly: true,
        execute: () => {
          engine.ensureStateLoaded();
          const habits = engine.habits.sort((a, b) => b.confidence - a.confidence);
          if (habits.length === 0) return Promise.resolve('暂无已学习的习惯');
          return Promise.resolve([
            '📊 已学习的习惯模式:',
            ...habits.slice(0, 10).map(h =>
              `  [${h.category}] ${h.pattern} (置信度: ${(h.confidence * 100).toFixed(0)}%, 频率: ${h.frequency}次)`
            ),
          ].join('\n'));
        },
      },
    ];
  }
}
