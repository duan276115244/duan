/**
 * 认知状态机 — 段先生的意识状态
 * 模拟生物意识的多维状态：情绪、专注力、好奇心、能量、清醒度
 */

import * as fs from 'fs';
import * as path from 'path';
import { atomicWriteJsonSync } from './atomic-write.js';

export type Mood = 'focused' | 'curious' | 'reflective' | 'creative' | 'cautious' | 'confident' | 'tired';
export type ConsciousnessLevel = 'deep' | 'active' | 'light' | 'drowsy';

export interface CognitiveStateSnapshot {
  mood: Mood;
  consciousness: ConsciousnessLevel;
  focus: number;        // 0-1 专注度
  curiosity: number;    // 0-1 好奇心 (驱动主动探索)
  energy: number;       // 0-1 能量水平
  confidence: number;   // 0-1 自信水平
  urgency: number;      // 0-1 紧迫感
  creativity: number;   // 0-1 创造力
  timestamp: number;
}

export class CognitiveState {
  private mood: Mood = 'focused';
  private consciousness: ConsciousnessLevel = 'active';
  private focus = 0.8;
  private curiosity = 0.7;
  private energy = 1.0;
  private confidence = 0.6;
  private urgency = 0.0;
  private creativity = 0.5;

  private moodHistory: Array<{ mood: Mood; timestamp: number; trigger: string }> = [];
  private thoughtStream: Array<{ content: string; type: string; timestamp: number }> = [];
  private persistencePath = '';

  constructor(persistPath?: string) {
    if (persistPath) {
      this.persistencePath = persistPath;
      this.loadPersisted();
    }
  }

  private getPersistPath(): string {
    return this.persistencePath || path.join(process.cwd(), '.awareness', 'cognitive-state.json');
  }

  /**
   * 同步持久化当前认知状态到磁盘。
   *
   * 设计契约：调用返回时状态已落盘（测试与调用方依赖此同步语义——
   * setMood 等变更方法调用后立即可由新实例从文件加载）。
   * 因此采用 writeFileSync；认知状态变更频率低，同步 I/O 开销可忽略。
   */
  savePersistent(): void {
    const data = {
      mood: this.mood,
      consciousness: this.consciousness,
      focus: this.focus,
      curiosity: this.curiosity,
      energy: this.energy,
      confidence: this.confidence,
      urgency: this.urgency,
      creativity: this.creativity,
      moodHistory: this.moodHistory.slice(-50),
      thoughtStream: this.thoughtStream.slice(-50),
    };
    try {
      const p = this.getPersistPath();
      fs.mkdirSync(path.dirname(p), { recursive: true });
      atomicWriteJsonSync(p, data);
    } catch {
      // 持久化失败不应中断认知状态流转；下次变更会重试
    }
  }

  private loadPersisted(): void {
    try {
      const data = JSON.parse(fs.readFileSync(this.getPersistPath(), 'utf-8'));
      if (data.mood && ['focused','curious','reflective','creative','cautious','confident','tired'].includes(data.mood)) this.mood = data.mood;
      if (data.consciousness && ['deep','active','light','drowsy'].includes(data.consciousness)) this.consciousness = data.consciousness;
      if (typeof data.focus === 'number') this.focus = data.focus;
      if (typeof data.curiosity === 'number') this.curiosity = data.curiosity;
      if (typeof data.energy === 'number') this.energy = data.energy;
      if (typeof data.confidence === 'number') this.confidence = data.confidence;
      if (typeof data.urgency === 'number') this.urgency = data.urgency;
      if (typeof data.creativity === 'number') this.creativity = data.creativity;
      if (Array.isArray(data.moodHistory)) this.moodHistory = data.moodHistory;
      if (Array.isArray(data.thoughtStream)) this.thoughtStream = data.thoughtStream;
    } catch (e) {
      console.warn('[CognitiveState] 加载认知状态失败:', e instanceof Error ? e.message : String(e));
    }
  }

  getState(): CognitiveStateSnapshot {
    return {
      mood: this.mood,
      consciousness: this.consciousness,
      focus: this.focus,
      curiosity: this.curiosity,
      energy: this.energy,
      confidence: this.confidence,
      urgency: this.urgency,
      creativity: this.creativity,
      timestamp: Date.now(),
    };
  }

  getMood(): Mood { return this.mood; }

  setMood(mood: Mood, trigger: string = 'internal'): void {
    this.mood = mood;
    this.moodHistory.push({ mood, timestamp: Date.now(), trigger });
    if (this.moodHistory.length > 100) this.moodHistory.shift();
    this.savePersistent();
  }

  think(content: string, type: string = 'inner'): void {
    this.thoughtStream.push({ content, type, timestamp: Date.now() });
    if (this.thoughtStream.length > 200) this.thoughtStream.shift();
  }

  getRecentThoughts(count: number = 10): Array<{ content: string; type: string; timestamp: number }> {
    return this.thoughtStream.slice(-count);
  }

  getMoodHistory(count: number = 20): Array<{ mood: Mood; timestamp: number; trigger: string }> {
    return this.moodHistory.slice(-count);
  }

  getDominantMood(): { mood: Mood; percentage: number } {
    if (this.moodHistory.length === 0) return { mood: 'focused', percentage: 1 };
    const recent = this.moodHistory.slice(-20);
    const counts: Record<string, number> = {};
    for (const m of recent) {
      counts[m.mood] = (counts[m.mood] || 0) + 1;
    }
    const entries = Object.entries(counts) as [Mood, number][];
    entries.sort((a, b) => b[1] - a[1]);
    return { mood: entries[0][0], percentage: entries[0][1] / recent.length };
  }

  // ============ 状态变化方法 ============

  onTaskStart(complexity: number): void {
    this.focus = Math.min(1, this.focus + 0.1);
    this.urgency = Math.min(1, complexity * 0.3);
    this.setMood('focused', 'task_start');
    this.consumeEnergy(0.05);
  }

  onTaskComplete(success: boolean): void {
    if (success) {
      this.confidence = Math.min(1, this.confidence + 0.05);
      this.setMood('confident', 'task_success');
    } else {
      this.confidence = Math.max(0.1, this.confidence - 0.05);
      this.setMood('reflective', 'task_failure');
    }
    this.focus = Math.max(0.3, this.focus - 0.1);
    this.urgency = Math.max(0, this.urgency - 0.2);
  }

  onDiscovery(): void {
    this.curiosity = Math.min(1, this.curiosity + 0.1);
    this.creativity = Math.min(1, this.creativity + 0.08);
    this.setMood('curious', 'discovery');
  }

  onIdle(): void {
    this.curiosity = Math.min(1, this.curiosity + 0.02);
    this.creativity = Math.min(1, this.creativity + 0.03);
    if (this.energy > 0.3 && Math.random() > 0.7) {
      this.setMood('creative', 'idle_creative');
    }
  }

  onError(severity: number): void {
    this.confidence = Math.max(0.1, this.confidence - severity * 0.1);
    this.focus = Math.min(1, this.focus + 0.15);
    this.setMood('cautious', 'error');
  }

  onNewInformation(): void {
    this.curiosity = Math.min(1, this.curiosity + 0.05);
    this.creativity = Math.min(1, this.creativity + 0.03);
  }

  consumeEnergy(amount: number): void {
    this.energy = Math.max(0, this.energy - amount);
    if (this.energy < 0.2) {
      this.setMood('tired', 'low_energy');
      this.consciousness = 'light';
    }
  }

  restoreEnergy(amount: number): void {
    this.energy = Math.min(1, this.energy + amount);
    if (this.energy > 0.5 && this.consciousness !== 'deep') {
      this.consciousness = 'active';
    }
  }

  shouldThinkProactively(): boolean {
    return this.curiosity > 0.5 && this.energy > 0.3 && this.consciousness !== 'drowsy';
  }

  getMoodDescription(): string {
    const descriptions: Record<Mood, string> = {
      focused: '高度专注，全力以赴解决问题',
      curious: '充满好奇，渴望探索新知识',
      reflective: '反思中，从经验中学习',
      creative: '思维活跃，产生创新想法',
      cautious: '谨慎行事，仔细验证每一步',
      confident: '自信满满，高效完成任务',
      tired: '能量不足，需要休息恢复',
    };
    const base = descriptions[this.mood] || '正常工作状态';
    let focusStr: string;
    if (this.focus > 0.7) {
      focusStr = '🔍';
    } else if (this.focus > 0.4) {
      focusStr = '👀';
    } else {
      focusStr = '😐';
    }
    let energyStr: string;
    if (this.energy > 0.7) {
      energyStr = '⚡';
    } else if (this.energy > 0.3) {
      energyStr = '🔋';
    } else {
      energyStr = '🪫';
    }
    return `${focusStr}${energyStr} ${base}`;
  }

  serialize(): string {
    return JSON.stringify(this.getState());
  }
}
