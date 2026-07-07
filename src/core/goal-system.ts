/**
 * 目标系统 — 自主目标设定、分解与追踪
 * 让段先生能够自主设定目标并持续推进
 */

import * as fs from 'fs';
import * as path from 'path';
import { atomicWriteJsonSync } from './atomic-write.js';

export type GoalPriority = 'critical' | 'high' | 'medium' | 'low' | 'backlog';
export type GoalStatus = 'proposed' | 'active' | 'in_progress' | 'paused' | 'completed' | 'abandoned';

export interface Goal {
  id: string;
  title: string;
  description: string;
  priority: GoalPriority;
  status: GoalStatus;
  parentId: string | null;
  subgoals: string[];
  created: number;
  updated: number;
  deadline: number | null;
  progress: number;       // 0-100
  valueAlignment: string[];  // 关联的核心价值
  notes: string[];
  tags: string[];
}

export class GoalSystem {
  private goals: Map<string, Goal> = new Map();
  private dbPath: string;

  // —— 异步批量写盘相关状态 ——
  private dirty = false;
  private saveTimer: ReturnType<typeof setTimeout> | null = null;
  private batchDepth = 0;
  private readonly saveDelayMs = 200;

  constructor(dbPath?: string) {
    this.dbPath = dbPath || path.join(process.cwd(), '.awareness', 'goals.json');
    fs.mkdirSync(path.dirname(this.dbPath), { recursive: true });
    this.load();
    // 进程退出时确保未写入的变更被持久化
    process.once('exit', () => this.flush());
  }

  private load(): void {
    try {
      const data = JSON.parse(fs.readFileSync(this.dbPath, 'utf-8'));
      if (Array.isArray(data)) {
        for (const g of data) this.goals.set(g.id, g);
      }
    } catch {}
  }

  /** 实际的同步写盘动作（仅由 flush 调用） */
  private writeToDisk(): void {
    atomicWriteJsonSync(this.dbPath, Array.from(this.goals.values()));
  }

  /**
   * 标记数据已变更并安排一次防抖异步写盘。
   * 批量操作期间（batchDepth > 0）只标记不安排，待批量结束统一写入。
   */
  private scheduleSave(): void {
    this.dirty = true;
    if (this.batchDepth > 0) return;
    if (this.saveTimer) return;
    this.saveTimer = setTimeout(() => {
      this.saveTimer = null;
      this.flush();
    }, this.saveDelayMs);
  }

  /** 立即将待写入的变更落盘（取消挂起的防抖定时器） */
  flush(): void {
    if (this.saveTimer) {
      clearTimeout(this.saveTimer);
      this.saveTimer = null;
    }
    if (!this.dirty) return;
    this.writeToDisk();
    this.dirty = false;
  }

  private generateId(): string {
    return `goal_${Date.now()}_${Math.random().toString(36).substr(2, 6)}`;
  }

  createGoal(params: {
    title: string;
    description: string;
    priority?: GoalPriority;
    parentId?: string;
    deadline?: number;
    valueAlignment?: string[];
    tags?: string[];
  }): Goal {
    const goal: Goal = {
      id: this.generateId(),
      title: params.title,
      description: params.description,
      priority: params.priority || 'medium',
      status: 'proposed',
      parentId: params.parentId || null,
      subgoals: [],
      created: Date.now(),
      updated: Date.now(),
      deadline: params.deadline || null,
      progress: 0,
      valueAlignment: params.valueAlignment || [],
      notes: [],
      tags: params.tags || [],
    };
    this.goals.set(goal.id, goal);

    if (params.parentId) {
      const parent = this.goals.get(params.parentId);
      if (parent) {
        parent.subgoals.push(goal.id);
        parent.updated = Date.now();
      }
    }

    this.scheduleSave();
    return goal;
  }

  activateGoal(id: string): void {
    const goal = this.goals.get(id);
    if (goal && goal.status === 'proposed') {
      goal.status = 'active';
      goal.updated = Date.now();
      this.scheduleSave();
    }
  }

  startGoal(id: string): void {
    const goal = this.goals.get(id);
    if (goal && (goal.status === 'active' || goal.status === 'paused')) {
      goal.status = 'in_progress';
      goal.updated = Date.now();
      this.scheduleSave();
    }
  }

  updateProgress(id: string, progress: number, note?: string): void {
    const goal = this.goals.get(id);
    if (goal) {
      goal.progress = Math.min(100, Math.max(0, progress));
      goal.updated = Date.now();
      if (note) goal.notes.push(`[${new Date().toISOString().split('T')[0]}] ${note}`);
      if (progress >= 100) goal.status = 'completed';
      this.scheduleSave();
    }
  }

  pauseGoal(id: string): void {
    const goal = this.goals.get(id);
    if (goal && goal.status === 'in_progress') {
      goal.status = 'paused';
      goal.updated = Date.now();
      this.scheduleSave();
    }
  }

  abandonGoal(id: string, reason: string): void {
    const goal = this.goals.get(id);
    if (goal) {
      goal.status = 'abandoned';
      goal.updated = Date.now();
      goal.notes.push(`[ABANDONED] ${reason}`);
      // Also abandon subgoals
      for (const subId of goal.subgoals) {
        const sub = this.goals.get(subId);
        if (sub && sub.status !== 'completed') {
          sub.status = 'abandoned';
          sub.notes.push(`Parent abandoned: ${reason}`);
        }
      }
      this.scheduleSave();
    }
  }

  decomposeGoal(id: string, subgoals: Array<{ title: string; description: string }>): Goal[] {
    const parent = this.goals.get(id);
    if (!parent) return [];

    // 批量创建子目标：期间内部的多次 createGoal 不会各自写盘，
    // 仅在批量结束后统一安排一次写盘，避免 I/O 放大与重复阻塞。
    this.batchDepth++;
    const created: Goal[] = [];
    try {
      for (const sg of subgoals) {
        const child = this.createGoal({
          title: sg.title,
          description: sg.description,
          priority: parent.priority,
          parentId: parent.id,
          valueAlignment: parent.valueAlignment,
          tags: parent.tags,
        });
        created.push(child);
      }

      parent.subgoals = created.map(g => g.id);
      parent.updated = Date.now();
      if (parent.status === 'proposed') parent.status = 'active';
    } finally {
      this.batchDepth--;
    }

    this.scheduleSave();
    return created;
  }

  getAllGoals(): Goal[] {
    return Array.from(this.goals.values());
  }

  getActiveGoals(): Goal[] {
    return Array.from(this.goals.values())
      .filter(g => g.status === 'active' || g.status === 'in_progress')
      .sort((a, b) => {
        const priorityOrder: Record<string, number> = { critical: 0, high: 1, medium: 2, low: 3, backlog: 4 };
        return (priorityOrder[a.priority] ?? 99) - (priorityOrder[b.priority] ?? 99);
      });
  }

  getNextTask(): Goal | null {
    // Find the highest priority in-progress goal with incomplete subgoals
    const active = this.getActiveGoals();
    for (const goal of active) {
      // Check if any subgoal needs work
      const incompleteSubgoals = goal.subgoals
        .map(id => this.goals.get(id))
        .filter(g => g && g.status !== 'completed' && g.status !== 'abandoned') as Goal[];
      if (incompleteSubgoals.length > 0) {
        return incompleteSubgoals[0];
      }
      // If no subgoals but progress < 100, return the goal itself
      if (goal.progress < 100) return goal;
    }
    return null;
  }

  getGoalTree(id: string, depth: number = 0): string {
    const goal = this.goals.get(id);
    if (!goal) return '';
    const indent = '  '.repeat(depth);
    const statusEmoji: Record<GoalStatus, string> = {
      proposed: '📋', active: '📌', in_progress: '🔄',
      paused: '⏸️', completed: '✅', abandoned: '❌',
    };
    let output = `${indent}${statusEmoji[goal.status]} ${goal.title} (${goal.progress}%)\n`;
    for (const subId of goal.subgoals) {
      output += this.getGoalTree(subId, depth + 1);
    }
    return output;
  }

  suggestNextGoals(_context: string): string[] {
    const suggestions: string[] = [];
    const active = this.getActiveGoals().length;
    if (active < 3) {
      suggestions.push('考虑设定新的学习目标');
      suggestions.push('检查是否有可以改进的现有功能');
    }
    const inactive = Array.from(this.goals.values()).filter(g => g.status === 'paused' || g.status === 'proposed');
    if (inactive.length > 0) {
      suggestions.push(`有 ${inactive.length} 个待处理的目标待激活`);
    }
    return suggestions;
  }

  getStats(): string {
    const all = Array.from(this.goals.values());
    const completed = all.filter(g => g.status === 'completed').length;
    const active = all.filter(g => g.status === 'active' || g.status === 'in_progress').length;
    const abandoned = all.filter(g => g.status === 'abandoned').length;
    const avgProgress = active > 0
      ? Math.round(all.filter(g => g.status === 'in_progress').reduce((s, g) => s + g.progress, 0) / active)
      : 0;
    return `📊 **目标统计**: ${all.length}总 / ${active}进行中 / ${completed}完成 / ${abandoned}放弃 | 平均进度: ${avgProgress}%`;
  }
}
