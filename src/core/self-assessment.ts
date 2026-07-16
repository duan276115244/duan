import * as fs from 'fs';
import * as path from 'path';
import { atomicWriteJsonSync } from './atomic-write.js';

export interface MetricSample {
  timestamp: number;
  value: number;
}

export interface Metric {
  key: string;
  name: string;
  description: string;
  unit: string;
  target: number;
  history: MetricSample[];
  current: number;
  trend: 'up' | 'down' | 'stable';
}

export interface AssessmentReport {
  timestamp: number;
  overall: number;
  metrics: Metric[];
  summary: string;
  improvements: string[];
  risks: string[];
}

export class SelfAssessment {
  private metrics: Map<string, Metric> = new Map();
  private dbPath: string;
  private reportPath: string;

  constructor(dbPath?: string, reportPath?: string) {
    this.dbPath = dbPath || path.join(process.cwd(), '.awareness', 'metrics.json');
    this.reportPath = reportPath || path.join(process.cwd(), '.learnings', 'ASSESSMENT_REPORT.md');
    fs.mkdirSync(path.dirname(this.dbPath), { recursive: true });
    fs.mkdirSync(path.dirname(this.reportPath), { recursive: true });
    this.initMetrics();
    this.load();
  }

  private initMetrics(): void {
    const defaults: Metric[] = [
      { key: 'task_completion_rate', name: '任务完成率', description: '成功完成任务的比例', unit: '%', target: 90, history: [], current: 0, trend: 'stable' },
      { key: 'error_rate', name: '错误率', description: '任务执行中的错误比例（越低越好）', unit: '%', target: 10, history: [], current: 0, trend: 'stable' },
      { key: 'decision_accuracy', name: '决策准确率', description: '工具调用成功比例', unit: '%', target: 90, history: [], current: 0, trend: 'stable' },
      { key: 'strategy_effectiveness', name: '策略有效率', description: '策略切换后任务成功的比例', unit: '%', target: 80, history: [], current: 0, trend: 'stable' },
      { key: 'learning_promotion_rate', name: '学习采纳率', description: '学习记录被推广的比例', unit: '%', target: 50, history: [], current: 0, trend: 'stable' },
      { key: 'skill_extraction_count', name: '技能萃取数', description: '自动萃取的技能数量', unit: '个', target: 20, history: [], current: 0, trend: 'stable' },
      { key: 'self_evolve_cycles', name: '自进化周期', description: '运行的自我进化周期数', unit: '次', target: 10, history: [], current: 0, trend: 'stable' },
      { key: 'evolution_level', name: '进化等级', description: '当前进化等级', unit: '级', target: 10, history: [], current: 0, trend: 'stable' },
      { key: 'capability_average', name: '能力均值', description: '8项能力的平均等级', unit: '级', target: 7, history: [], current: 0, trend: 'stable' },
      { key: 'energy_stability', name: '能量稳定性', description: '能量水平维持在0.3以上的时间比例', unit: '%', target: 85, history: [], current: 0, trend: 'stable' },
      { key: 'task_volume', name: '任务处理量', description: '总完成任务数', unit: '个', target: 100, history: [], current: 0, trend: 'stable' },
      { key: 'response_quality', name: '回复质量', description: '平均回复长度（反映回答详尽程度）', unit: '字符', target: 500, history: [], current: 0, trend: 'stable' },
    ];
    for (const m of defaults) this.metrics.set(m.key, m);
  }

  private load(): void {
    try {
      const data = JSON.parse(fs.readFileSync(this.dbPath, 'utf-8'));
      for (const [key, metric] of Object.entries(data)) {
        if (this.metrics.has(key)) Object.assign(this.metrics.get(key)!, metric);
      }
    } catch {}
  }

  private save(): void {
    const data: Record<string, unknown> = {};
    for (const [key, m] of this.metrics) data[key] = { history: m.history.slice(-100), current: m.current, trend: m.trend };
    atomicWriteJsonSync(this.dbPath, data);
  }

  /** 异步持久化（供 flushPersist 串行化链调用，避免阻塞事件循环） */
  private persistToFile(): Promise<void> {
    this.save();
    return Promise.resolve();
  }

  record(key: string, value: number): void {
    const m = this.metrics.get(key);
    if (!m) return;
    const sample: MetricSample = { timestamp: Date.now(), value };
    m.history.push(sample);
    if (m.history.length > 100) m.history.shift();
    const recent = m.history.slice(-5);
    m.current = recent.reduce((s, h) => s + h.value, 0) / recent.length;
    if (recent.length >= 3) {
      const dir = recent[recent.length - 1].value - recent[0].value;
      m.trend = (() => {
        if (dir > 0.05 * m.target) return 'up';
        if (dir < -0.05 * m.target) return 'down';
        return 'stable';
      })();
    }
    this.save();
  }

  recordTaskCompletion(success: boolean): void {
    const recent = this.metrics.get('task_completion_rate')!.history.slice(-20);
    recent.push({ timestamp: Date.now(), value: success ? 1 : 0 });
    const rate = recent.reduce((s, h) => s + h.value, 0) / recent.length * 100;
    this.record('task_completion_rate', rate);
  }

  recordError(): void {
    const recent = this.metrics.get('error_rate')!.history.slice(-20);
    recent.push({ timestamp: Date.now(), value: 1 });
    const rate = recent.reduce((s, h) => s + h.value, 0) / recent.length * 100;
    this.record('error_rate', rate);
  }

  recordToolSuccess(success: boolean): void {
    const recent = this.metrics.get('decision_accuracy')!.history.slice(-20);
    recent.push({ timestamp: Date.now(), value: success ? 1 : 0 });
    const rate = recent.reduce((s, h) => s + h.value, 0) / recent.length * 100;
    this.record('decision_accuracy', rate);
  }

  updateCapabilityAverage(avgLevel: number): void {
    this.record('capability_average', avgLevel);
  }

  updateEvolutionLevel(level: number): void {
    this.record('evolution_level', level);
  }

  generateReport(): AssessmentReport {
    const now = Date.now();

    const scores: number[] = [];
    for (const m of this.metrics.values()) {
      const ratio = Math.min(1, m.current / m.target);
      const trendPenalty = m.trend === 'down' ? 0.1 : 0;
      scores.push(Math.max(0, Math.min(1, ratio - trendPenalty)) * 100);
    }
    const overall = scores.reduce((s, v) => s + v, 0) / scores.length;

    const lowMetrics = Array.from(this.metrics.values())
      .filter(m => m.current < m.target * 0.6);
    const decliningMetrics = Array.from(this.metrics.values())
      .filter(m => m.trend === 'down' && m.current > 0);

    return {
      timestamp: now,
      overall: Math.round(overall),
      metrics: Array.from(this.metrics.values()),
      summary: `综合评分: ${Math.round(overall)}/100 — ${(() => { if (overall >= 80) return '✅ 良好'; if (overall >= 60) return '⚠️ 需要改进'; return '🔴 亟需优化'; })()}`,
      improvements: lowMetrics.map(m => `${m.name} (${m.current.toFixed(1)}/${m.target}) 低于目标，需重点关注`),
      risks: decliningMetrics.map(m => `${m.name} 呈下降趋势 (${m.current.toFixed(1)})`),
    };
  }

  getFormattedReport(): string {
    const r = this.generateReport();
    let output = '';

    output += `📊 自评估报告\n\n`;
    output += `  ${r.summary}\n\n`;
    output += `╭─ 关键指标 ${'─'.repeat(40)}╮\n`;

    for (const m of r.metrics) {
      if (m.current === 0 && m.history.length === 0) continue;
      const pct = m.target > 0 ? Math.min(100, (m.current / m.target) * 100) : 0;
      const bar = '█'.repeat(Math.round(pct / 5)) + '░'.repeat(20 - Math.round(pct / 5));
      let trendIcon: string;
      if (m.trend === 'up') {
        trendIcon = '📈';
      } else if (m.trend === 'down') {
        trendIcon = '📉';
      } else {
        trendIcon = '➡️';
      }
      output += `  ${trendIcon} ${m.name.padEnd(18)} ${bar} ${m.current.toFixed(1)}/${m.target} ${m.unit}\n`;
    }
    output += `╰${'─'.repeat(50)}╯\n`;

    if (r.improvements.length > 0) {
      output += `\n⚠️ 需改进项:\n`;
      for (const imp of r.improvements) output += `  • ${imp}\n`;
    }
    if (r.risks.length > 0) {
      output += `\n📉 风险项:\n`;
      for (const risk of r.risks) output += `  • ${risk}\n`;
    }
    return output;
  }

  // ========== P2-4: 自动定期评估 ==========

  private assessmentTimer: NodeJS.Timeout | null = null;
  private assessmentHistory: Array<{ timestamp: number; report: AssessmentReport }> = [];
  private readonly maxHistory = 50;

  /** 自动评估的回调（用于将报告发送到指定位置） */
  private assessmentCallback?: (report: AssessmentReport) => void;

  // ========== Perf: 异步 + 防抖持久化，降低 IO 开销 ==========
  private persistTimer: NodeJS.Timeout | null = null;
  private readonly persistDebounceMs = 2000;
  private persistInFlight: Promise<void> | null = null;

  /** 防抖触发的持久化：合并频繁写入，延迟后异步落盘 */
  private schedulePersist(): void {
    if (this.persistTimer) {
      clearTimeout(this.persistTimer);
    }
    this.persistTimer = setTimeout(() => {
      this.persistTimer = null;
      void this.flushPersist();
    }, this.persistDebounceMs);
  }

  /** 立即异步持久化（必要时调用，如定时自动评估完成后） */
  private async flushPersist(): Promise<void> {
    if (this.persistTimer) {
      clearTimeout(this.persistTimer);
      this.persistTimer = null;
    }
    // 串行化写入，避免并发写文件
    this.persistInFlight = (this.persistInFlight ?? Promise.resolve()).then(() =>
      this.persistToFile()
    );
    return this.persistInFlight;
  }

  /**
   * P2-4: 启动自动定期评估
   * @param intervalMs 评估间隔（默认 1 小时）
   * @param callback 评估完成后的回调（可选）
   */
  startAutoAssessment(intervalMs: number = 60 * 60 * 1000, callback?: (report: AssessmentReport) => void): void {
    this.stopAutoAssessment();
    this.assessmentCallback = callback;

    this.assessmentTimer = setInterval(() => {
      this.runAutoAssessment();
      // 仅在定时自动评估时持久化
      void this.flushPersist();
    }, intervalMs);
    // 防止定时器阻止进程优雅退出
    if (typeof this.assessmentTimer.unref === 'function') this.assessmentTimer.unref();

    // 立即执行一次
    this.runAutoAssessment();
  }

  /**
   * P2-4: 停止自动评估
   */
  stopAutoAssessment(): void {
    if (this.assessmentTimer) {
      clearInterval(this.assessmentTimer);
      this.assessmentTimer = null;
    }
    // 停止前将待写入数据落盘
    void this.flushPersist();
  }


  /**
   * P2-4: 执行一次自动评估
   */
  private runAutoAssessment(): AssessmentReport {
    const report = this.generateReport();

    // 记录历史
    this.assessmentHistory.push({ timestamp: Date.now(), report });
    if (this.assessmentHistory.length > this.maxHistory) {
      this.assessmentHistory.shift();
    }

    // 持久化报告到文件
    try {
      const reportContent = this.generateAutoReportContent(report);
      fs.writeFileSync(this.reportPath, reportContent, 'utf-8');
    } catch {
      // 静默失败
    }

    // 调用回调
    if (this.assessmentCallback) {
      try {
        this.assessmentCallback(report);
      } catch {}
    }

    return report;
  }

  /**
   * P2-4: 生成自动评估报告内容
   */
  private generateAutoReportContent(report: AssessmentReport): string {
    const lines: string[] = [];
    const time = new Date(report.timestamp).toLocaleString('zh-CN');

    lines.push(`# 自评估报告 — ${time}`);
    lines.push('');
    lines.push(`## 综合评分: ${report.overall}/100`);
    lines.push('');
    lines.push(`> ${report.summary}`);
    lines.push('');

    lines.push('## 关键指标');
    lines.push('');
    lines.push('| 指标 | 当前值 | 目标 | 趋势 |');
    lines.push('|------|--------|------|------|');
    for (const m of report.metrics) {
      if (m.current === 0 && m.history.length === 0) continue;
      let trendIcon: string;
      if (m.trend === 'up') {
        trendIcon = '📈';
      } else if (m.trend === 'down') {
        trendIcon = '📉';
      } else {
        trendIcon = '➡️';
      }
      lines.push(`| ${m.name} | ${m.current.toFixed(1)} ${m.unit} | ${m.target} ${m.unit} | ${trendIcon} |`);
    }
    lines.push('');

    if (report.improvements.length > 0) {
      lines.push('## 需改进项');
      lines.push('');
      for (const imp of report.improvements) {
        lines.push(`- ${imp}`);
      }
      lines.push('');
    }

    if (report.risks.length > 0) {
      lines.push('## 风险项');
      lines.push('');
      for (const risk of report.risks) {
        lines.push(`- ${risk}`);
      }
      lines.push('');
    }

    // 历史趋势
    if (this.assessmentHistory.length > 1) {
      lines.push('## 历史趋势');
      lines.push('');
      lines.push('| 时间 | 评分 |');
      lines.push('|------|------|');
      for (const h of this.assessmentHistory.slice(-10)) {
        lines.push(`| ${new Date(h.timestamp).toLocaleString('zh-CN')} | ${h.report.overall} |`);
      }
      lines.push('');
    }

    return lines.join('\n');
  }

  /**
   * P2-4: 获取评估历史
   */
  getAssessmentHistory(): Array<{ timestamp: number; report: AssessmentReport }> {
    return [...this.assessmentHistory];
  }

  /**
   * P2-4: 检查是否需要触发优化
   * 当综合评分连续 3 次低于阈值时返回 true
   */
  shouldTriggerOptimization(threshold: number = 60): boolean {
    if (this.assessmentHistory.length < 3) return false;
    const recent = this.assessmentHistory.slice(-3);
    return recent.every(h => h.report.overall < threshold);
  }

  /**
   * P2-4: 获取最需要关注的指标（评分最低的）
   */
  getTopConcerns(limit: number = 3): Metric[] {
    return Array.from(this.metrics.values())
      .filter(m => m.history.length > 0)
      .sort((a, b) => (a.current / a.target) - (b.current / b.target))
      .slice(0, limit);
  }
}
