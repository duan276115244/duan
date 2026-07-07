import type { CognitiveState } from './cognitive-state.js';
import type { SelfAwareness } from './self-awareness.js';
import type { GoalSystem } from './goal-system.js';
import type { ValueSystem } from './value-system.js';
import type { SelfLearningSystem } from './self-learning-system.js';

export interface HeartbeatConfig {
  intervalMs: number;
  enableProactiveThinking: boolean;
  enableGoalReview: boolean;
  enableSelfCheck: boolean;
  enableLearningReview: boolean;
}

export interface HeartbeatReport {
  timestamp: number;
  type: 'proactive_think' | 'goal_review' | 'self_check' | 'learning_review' | 'idle';
  summary: string;
  actions: string[];
  suggestions: string[];
}

export class Heartbeat {
  private cognitiveState: CognitiveState;
  private selfAwareness: SelfAwareness;
  private goalSystem: GoalSystem;
  private valueSystem: ValueSystem;
  private selfLearning: SelfLearningSystem;
  private config: HeartbeatConfig;
  private lastBeat: number = 0;
  private beatCount: number = 0;
  private timer: ReturnType<typeof setTimeout> | null = null;
  private running: boolean = false;
  private onReport: ((report: HeartbeatReport) => void) | null = null;

  constructor(
    cognitiveState: CognitiveState,
    selfAwareness: SelfAwareness,
    goalSystem: GoalSystem,
    valueSystem: ValueSystem,
    selfLearning: SelfLearningSystem,
    config?: Partial<HeartbeatConfig>,
  ) {
    this.cognitiveState = cognitiveState;
    this.selfAwareness = selfAwareness;
    this.goalSystem = goalSystem;
    this.valueSystem = valueSystem;
    this.selfLearning = selfLearning;

    // 校验 intervalMs：必须为有限正数，否则回退到默认值（避免 `|| 300000` 把合法的 0 误覆盖，
    // 同时显式拒绝 0、负值与非法数值）
    const intervalMs =
      config?.intervalMs !== undefined && Number.isFinite(config.intervalMs) && config.intervalMs > 0
        ? config.intervalMs
        : 300000;

    this.config = {
      intervalMs,
      enableProactiveThinking: config?.enableProactiveThinking ?? true,
      enableGoalReview: config?.enableGoalReview ?? true,
      enableSelfCheck: config?.enableSelfCheck ?? true,
      enableLearningReview: config?.enableLearningReview ?? true,
    };
  }

  onReportCallback(cb: (report: HeartbeatReport) => void): void {
    this.onReport = cb;
  }

  start(): void {
    if (this.running) return;
    this.running = true;
    this.lastBeat = Date.now();
    this.scheduleNext();
  }

  stop(): void {
    this.running = false;
    if (this.timer) {
      clearTimeout(this.timer);
      this.timer = null;
    }
  }

  isRunning(): boolean {
    return this.running;
  }

  getBeatCount(): number { return this.beatCount; }
  getUptime(): number { return Date.now() - this.lastBeat; }

  // 用递归 setTimeout 替代 setInterval，确保上一次 beat 完成后才安排下一次，彻底避免心跳重叠
  private scheduleNext(): void {
    if (!this.running) return;
    this.timer = setTimeout(async () => {
      this.timer = null;
      try {
        await this.beat();
      } finally {
        this.scheduleNext();
      }
    }, this.config.intervalMs);
  }

  private emit(report: HeartbeatReport): void {
    // 只报告有实际操作的beat，忽略空闲报告减少噪音
    if (report.type !== 'idle' && this.onReport) {
      this.onReport(report);
    }
  }

  private async beat(): Promise<void> {
    this.beatCount++;
    this.cognitiveState.restoreEnergy(0.1);
    this.cognitiveState.onIdle();

    const beatType = this.beatCount % 4;
    let report: HeartbeatReport | null = null;

    switch (beatType) {
      case 0:
        if (this.config.enableProactiveThinking) {
          report = await this.proactiveThink();
          await this.executeActions(report);
        }
        break;
      case 1:
        if (this.config.enableGoalReview) {
          report = this.reviewGoals();
          await this.executeActions(report);
        }
        break;
      case 2:
        if (this.config.enableSelfCheck) report = this.selfCheck();
        break;
      case 3:
        if (this.config.enableLearningReview) report = this.reviewLearning();
        break;
    }

    if (!report) {
      report = {
        timestamp: Date.now(),
        type: 'idle',
        summary: '一切正常，无特别事项',
        actions: [],
        suggestions: [],
      };
    }

    this.emit(report);
  }

  private executeActions(report: HeartbeatReport): Promise<void> {
    if (report.actions.length === 0) return Promise.resolve();

    for (const action of report.actions) {
      this.cognitiveState.think(`心跳执行: ${action}`, 'heartbeat_action');
    }
    return Promise.resolve();
  }

  private proactiveThink(): Promise<HeartbeatReport> {
    this.cognitiveState.think('心跳触发：主动思考', 'heartbeat');

    const activeGoals = this.goalSystem.getActiveGoals();
    const suggestions: string[] = [];
    const actions: string[] = [];

    if (activeGoals.length === 0) {
      suggestions.push('当前无活跃目标，建议设定新目标');
      this.cognitiveState.setMood('curious', 'no_goals');
      actions.push('暂无目标需要推进');
    } else {
      const nextTask = this.goalSystem.getNextTask();
      if (nextTask) {
        actions.push(`推进目标: ${nextTask.title} (当前进度: ${nextTask.progress}%)`);
      }
    }

    const improveCap = this.selfAwareness.shouldImproveCapability();
    if (improveCap) {
      suggestions.push(`建议提升能力: ${improveCap}`);
    }

    const state = this.cognitiveState.getState();
    if (state.curiosity > 0.7 && state.energy > 0.5) {
      suggestions.push('好奇心旺盛，适合探索新知识或尝试新方案');
    }

    this.cognitiveState.think(`主动思考完成: ${actions.length}个行动建议, ${suggestions.length}个改进建议`, 'heartbeat_result');

    return Promise.resolve({
      timestamp: Date.now(),
      type: 'proactive_think',
      summary: `心跳 #${this.beatCount}: ${actions.length > 0 ? actions[0] : '无待办事项'}`,
      actions,
      suggestions: [...suggestions, ...this.goalSystem.suggestNextGoals('heartbeat')],
    });
  }

  private reviewGoals(): HeartbeatReport {
    this.cognitiveState.think('心跳触发：目标评审', 'heartbeat');

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const allGoals = Array.from((this.goalSystem as any).goals?.values() || []) as any[];
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const stuck = allGoals.filter((g: any) => g.status === 'in_progress' && g.progress === 0 && (Date.now() - g.updated) > 3600000);
    const suggestions: string[] = [];
    const actions: string[] = [];

    if (stuck.length > 0) {
      for (const g of stuck) {
        suggestions.push(`目标 "${g.title}" 长时间未推进，建议重新评估或分解`);
      }
    }

    return {
      timestamp: Date.now(),
      type: 'goal_review',
      summary: `目标评审完成 | ${allGoals.length}总目标`,
      actions,
      suggestions,
    };
  }

  private selfCheck(): HeartbeatReport {
    this.cognitiveState.think('心跳触发：自检', 'heartbeat');

    const state = this.cognitiveState.getState();
    const suggestions: string[] = [];

    if (state.energy < 0.3) {
      suggestions.push('能量水平低，建议减少主动操作');
    }
    if (state.confidence < 0.3) {
      suggestions.push('自信水平低，建议从简单任务开始重建信心');
    }
    if (state.focus < 0.4) {
      suggestions.push('专注度下降，建议休息或切换任务类型');
    }

    const recentErrors = this.selfLearning.getLearnings({ category: 'error', limit: 5 });
    if (recentErrors.length >= 3) {
      suggestions.push(`最近有 ${recentErrors.length} 个错误记录，建议检查并修复根本原因`);
    }

    return {
      timestamp: Date.now(),
      type: 'self_check',
      summary: `状态: ${this.cognitiveState.getMoodDescription()}`,
      actions: [],
      suggestions,
    };
  }

  private reviewLearning(): HeartbeatReport {
    this.cognitiveState.think('心跳触发：学习回顾', 'heartbeat');

    const recentLearnings = this.selfLearning.getLearnings({ limit: 5 });
    const suggestions: string[] = [];

    if (recentLearnings.length > 0) {
      suggestions.push(`最近有 ${recentLearnings.length} 条学习记录待回顾`);
    }

    return {
      timestamp: Date.now(),
      type: 'learning_review',
      summary: `学习回顾: ${recentLearnings.length}条新记录`,
      actions: [],
      suggestions,
    };
  }
}
