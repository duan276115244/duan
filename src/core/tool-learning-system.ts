import * as fs from 'fs';
import * as path from 'path';
import { duanPath } from './duan-paths.js';
import { atomicWriteJsonSync } from './atomic-write.js';

interface ToolCallRecord {
  toolName: string;
  args: string;
  result: string;
  success: boolean;
  goal: string;
  timestamp: number;
}

interface ToolLesson {
  id: string;
  toolName: string;
  pattern: string;
  lesson: string;
  fixSuggestion: string;
  successRate: number;
  hitCount: number;
  lastRelevant: number;
  tags: string[];
}

// P0 跨平台修复：使用 duanPath 统一路径解析，避免污染 process.cwd()
// 之前为 path.join(process.cwd(), '.duan-tool-lessons.json')，会在用户项目根目录留垃圾文件
const DEFAULT_STORAGE_PATH = duanPath('tool-lessons.json');

export class ToolLearningSystem {
  private history: ToolCallRecord[] = [];
  private lessons: ToolLesson[] = [];
  private maxHistory = 200;
  private maxLessons = 100;
  /** 工具成功率权重 — 影响后续工具选择 */
  private toolWeights: Map<string, { successCount: number; failCount: number; lastUsed: number; weight: number }> = new Map();
  /** 持久化路径（支持依赖注入） */
  private readonly storagePath: string;

  constructor(options?: { dataDir?: string }) {
    this.storagePath = options?.dataDir
      ? path.join(options.dataDir, 'tool-lessons.json')
      : DEFAULT_STORAGE_PATH;
    this.load();
  }

  record(call: ToolCallRecord): void {
    this.history.push(call);
    if (this.history.length > this.maxHistory) this.history.shift();

    // 强化学习闭环：更新工具权重
    this.updateToolWeight(call.toolName, call.success);

    if (!call.success) {
      this.learnFromFailure(call);
    } else {
      this.reinforceSuccess(call);
    }

    if (this.history.length % 20 === 0) this.save();
  }

  /**
   * 强化学习：更新工具权重
   * 成功 → 权重增加（α=0.05），失败 → 权重降低（α=0.1，惩罚大于奖励）
   */
  private updateToolWeight(toolName: string, success: boolean): void {
    let entry = this.toolWeights.get(toolName);
    if (!entry) {
      entry = { successCount: 0, failCount: 0, lastUsed: Date.now(), weight: 0.5 }; // 初始权重0.5
    }

    if (success) {
      entry.successCount++;
      entry.weight = Math.min(1.0, entry.weight + 0.05); // 成功奖励
    } else {
      entry.failCount++;
      entry.weight = Math.max(0.1, entry.weight - 0.1); // 失败惩罚（更大）
    }

    entry.lastUsed = Date.now();
    this.toolWeights.set(toolName, entry);
  }

  /**
   * 获取工具权重（用于工具选择排序）
   */
  getToolWeight(toolName: string): number {
    const entry = this.toolWeights.get(toolName);
    if (!entry) return 0.5; // 未知工具默认权重
    return entry.weight;
  }

  /**
   * 获取所有工具权重（供SmartToolSelector使用）
   */
  getAllToolWeights(): Map<string, number> {
    const weights = new Map<string, number>();
    for (const [toolName, entry] of this.toolWeights) {
      weights.set(toolName, entry.weight);
    }
    return weights;
  }

  /**
   * 获取工具统计信息
   */
  getToolStats(toolName: string): { successRate: number; totalCalls: number; weight: number } | null {
    const entry = this.toolWeights.get(toolName);
    if (!entry) return null;
    const total = entry.successCount + entry.failCount;
    return {
      successRate: total > 0 ? entry.successCount / total : 0.5,
      totalCalls: total,
      weight: entry.weight,
    };
  }

  private learnFromFailure(call: ToolCallRecord): void {
    const existing = this.lessons.find(l =>
      l.toolName === call.toolName && this.isSimilarFailure(call.result, l.pattern)
    );

    if (existing) {
      existing.hitCount++;
      existing.lastRelevant = Date.now();
      existing.successRate = Math.max(0, existing.successRate - 0.05);
    } else {
      const lesson = this.generateLesson(call);
      if (lesson) {
        this.lessons.push(lesson);
        if (this.lessons.length > this.maxLessons) this.lessons.shift();
      }
    }
  }

  private reinforceSuccess(call: ToolCallRecord): void {
    // Track successful calls via the 'success' tag. Previously searched for
    // lesson text containing 'success', but generateLesson() only produces
    // failure lessons — so success reinforcement was dead code.
    const existing = this.lessons.find(l =>
      l.toolName === call.toolName && l.tags.includes('success')
    );
    if (existing) {
      existing.successRate = Math.min(1, existing.successRate + 0.02);
      existing.hitCount++;
      existing.lastRelevant = Date.now();
    } else {
      this.lessons.push({
        id: `${call.toolName}_success_${Date.now()}`,
        toolName: call.toolName,
        pattern: 'success',
        lesson: `${call.toolName} 执行成功`,
        fixSuggestion: '',
        successRate: 0.9,
        hitCount: 1,
        lastRelevant: Date.now(),
        tags: ['success'],
      });
      if (this.lessons.length > this.maxLessons) this.lessons.shift();
    }
  }

  private isSimilarFailure(errorMsg: string, pattern: string): boolean {
    if (pattern.length < 10) return false;
    const key = errorMsg.substring(0, 50);
    return pattern.includes(key) || key.includes(pattern.substring(0, 30));
  }

  private generateLesson(call: ToolCallRecord): ToolLesson | null {
    const err = call.result;
    const tool = call.toolName;

    const knownPatterns: Array<{ match: RegExp; lesson: string; fix: string; tags: string[] }> = [
      { match: /need.*selector|selector.*required|provide.*selector/i, lesson: `${tool} 需要 selector 参数，先调用 browser_extract 获取页面元素`, fix: '先用 extract 查看页面获取元素选择器', tags: ['browser', 'selector'] },
      { match: /timeout|timed out|no response/i, lesson: `${tool} 超时，可能是目标页面/应用无响应`, fix: '等待几秒后重试，或检查网络/应用状态', tags: ['timeout'] },
      { match: /not found|not exist|no such|not installed/i, lesson: `${tool} 找不到目标，检查是否拼写错误或目标不存在`, fix: '先用 list 或 search 确认目标存在再操作', tags: ['not_found'] },
      { match: /permission|access denied|unauthorized/i, lesson: `${tool} 权限不足`, fix: '以管理员身份运行或检查权限设置', tags: ['permission'] },
      { match: /network|econnrefused|enotfound|fetch failed/i, lesson: `${tool} 网络请求失败`, fix: '检查网络连接或换用 web_fetch 代替', tags: ['network'] },
      { match: /screenshot.*fail|capture.*fail|截图.*失败/i, lesson: `${tool} 截图失败，改用 browser_operate 的截图功能`, fix: '用 browser_operate 导航到目标页面后使用内置截图', tags: ['screenshot'] },
      { match: /visual.*fail|analyze.*fail|screen.*analyze/i, lesson: `${tool} 视觉分析失败，截图系统可能不可用`, fix: '跳过视觉分析，直接用 browser_operate 提取页面文本', tags: ['visual'] },
    ];

    for (const p of knownPatterns) {
      if (p.match.test(err)) {
        return { id: `${tool}_${Date.now()}`, toolName: tool, pattern: err.substring(0, 60), lesson: p.lesson, fixSuggestion: p.fix, successRate: 0.3, hitCount: 1, lastRelevant: Date.now(), tags: p.tags };
      }
    }

    if (err.length > 10) {
      return { id: `${tool}_${Date.now()}`, toolName: tool, pattern: err.substring(0, 60), lesson: `${tool} 失败: ${err.substring(0, 80)}`, fixSuggestion: '尝试不同的方法或换用其他工具', successRate: 0.2, hitCount: 1, lastRelevant: Date.now(), tags: ['generic'] };
    }

    return null;
  }

  getLessonsForGoal(goal: string, maxResults: number = 5): ToolLesson[] {
    const goalLower = goal.toLowerCase();
    const scored = this.lessons.map(l => {
      let score = l.successRate * 0.3 + Math.min(1, l.hitCount / 5) * 0.3;
      if (goalLower.includes(l.toolName.replace('_', ' '))) score += 0.3;
      if (l.tags.some(t => goalLower.includes(t))) score += 0.2;
      return { lesson: l, score };
    });
    scored.sort((a, b) => b.score - a.score);
    return scored.slice(0, maxResults).map(s => s.lesson);
  }

  formatLessonsForPrompt(goal: string): string {
    const lessons = this.getLessonsForGoal(goal);
    if (lessons.length === 0) return '';
    const lines = lessons.map((l, i) =>
      `${i + 1}. [${l.toolName}] ${l.lesson} (${Math.round(l.successRate * 100)}%可靠, ${l.hitCount}次经验)`
    );
    return `\n## 经验教训\n${lines.join('\n')}`;
  }

  getToolAlternatives(failedTool: string): string[] {
    const map: Record<string, string[]> = {
      'screen_capture': ['browser_operate (内置截图)', 'web_fetch'],
      'screen_analyze': ['browser_extract', 'web_fetch'],
      'web_search': ['web_fetch', 'browser_operate'],
      'browser_operate': ['screen_click', 'screen_type', 'screen_key'],
      'visual_analyze': ['browser_extract', 'read_file'],
      'app_screenshot': ['screen_capture', 'browser_operate'],
    };
    return map[failedTool] || [];
  }

  getStats(): { totalLessons: number; totalHistory: number; topLessons: ToolLesson[] } {
    const sorted = [...this.lessons].sort((a, b) => b.hitCount - a.hitCount);
    return { totalLessons: this.lessons.length, totalHistory: this.history.length, topLessons: sorted.slice(0, 10) };
  }

  private save(): void {
    try {
      const weightsObj: Record<string, unknown> = {};
      for (const [k, v] of this.toolWeights) weightsObj[k] = v;
      atomicWriteJsonSync(this.storagePath, { lessons: this.lessons, history: this.history.slice(-50), toolWeights: weightsObj });
    } catch {}
  }

  private load(): void {
    try {
      if (fs.existsSync(this.storagePath)) {
        const data = JSON.parse(fs.readFileSync(this.storagePath, 'utf-8'));
        this.lessons = data.lessons || [];
        this.history = data.history || [];
        // 恢复工具权重
        if (data.toolWeights) {
          for (const [k, v] of Object.entries(data.toolWeights)) {
            this.toolWeights.set(k, v as { successCount: number; failCount: number; lastUsed: number; weight: number });
          }
        }
      }
    } catch {}
  }
}
