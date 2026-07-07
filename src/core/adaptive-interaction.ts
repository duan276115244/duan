/**
 * 自适应用户交互系统 — AdaptiveInteractionSystem
 *
 * 基于对 Cursor、Trae 等工具的对比 UX 分析，实现用户中心交互增强：
 * - 响应风格自适应：根据用户画像调整冗余度、技术深度、语言
 * - 用户偏好追踪：通信风格、工具偏好、领域专长
 * - 进度可视化：ASCII 进度条、步骤状态、预估剩余时间
 * - 智能建议：基于上下文和已完成步骤推荐下一步
 * - 多格式输出：markdown / table / tree / code_block / diff / summary
 */

import * as fs from 'fs';
import * as path from 'path';
import { logger } from './structured-logger.js';
import { duanPath } from './duan-paths.js';
import { EventBus } from './event-bus.js';
import { errMsg } from './utils.js';
import type { ToolDef } from './unified-tool-def.js';
import { atomicWriteJsonSync } from './atomic-write.js';

// ============ 类型定义 ============

/** 用户画像 */
export interface UserProfile {
  id: string;
  expertiseLevel: 'beginner' | 'intermediate' | 'advanced' | 'expert';
  communicationStyle: 'concise' | 'balanced' | 'verbose' | 'technical';
  preferredLanguage: 'zh' | 'en' | 'mixed';
  domainStrengths: string[];
  interactionCount: number;
  lastInteraction: number;
}

/** 用户偏好项 */
export interface UserPreference {
  type: 'style' | 'tool' | 'domain' | 'language' | 'format';
  key: string;
  value: string;
  confidence: number;
}

/** 步骤进度 */
export interface StepProgress {
  name: string;
  status: 'pending' | 'in_progress' | 'completed' | 'failed' | 'skipped';
  progress: number;           // 0-100
  duration?: number;
  result?: string;
}

/** 输出格式 */
export type OutputFormat = 'markdown' | 'table' | 'tree' | 'code_block' | 'diff' | 'summary';


// ============ 常量 ============

/** 持久化目录 */
const DEFAULT_PROFILES_DIR = duanPath('profiles');

/** 专业水平权重映射 */
const _EXPERTISE_WEIGHTS: Record<UserProfile['expertiseLevel'], number> = {
  beginner: 0.2,
  intermediate: 0.4,
  advanced: 0.7,
  expert: 0.9,
};

/** 通信风格冗余度映射 */
const _STYLE_VERBOSITY: Record<UserProfile['communicationStyle'], number> = {
  concise: 0.2,
  balanced: 0.5,
  verbose: 0.8,
  technical: 0.6,
};

/** 步骤状态图标 */
const STATUS_ICONS: Record<StepProgress['status'], string> = {
  pending: '⏳',
  in_progress: '🔄',
  completed: '✅',
  failed: '❌',
  skipped: '⏭️',
};

/** 步骤状态中文名 */
const STATUS_LABELS: Record<StepProgress['status'], string> = {
  pending: '待处理',
  in_progress: '进行中',
  completed: '已完成',
  failed: '已失败',
  skipped: '已跳过',
};

/** 默认用户画像 */
const DEFAULT_PROFILE: UserProfile = {
  id: 'default',
  expertiseLevel: 'intermediate',
  communicationStyle: 'balanced',
  preferredLanguage: 'zh',
  domainStrengths: [],
  interactionCount: 0,
  lastInteraction: 0,
};

// ============ 主类 ============

export class AdaptiveInteractionSystem {
  private log = logger.child({ module: 'AdaptiveInteraction' });
  private profiles: Map<string, UserProfile> = new Map();
  private preferences: Map<string, UserPreference[]> = new Map();
  private taskProgress: Map<string, StepProgress[]> = new Map();
  /** 持久化目录（支持依赖注入） */
  private readonly profilesDir: string;
  /** 是否已加载画像（懒加载标记） */
  private profilesLoaded = false;

  /** 统计计数器 */
  private stats = {
    adaptationsPerformed: 0,
    preferencesTracked: 0,
    progressReportsGenerated: 0,
    suggestionsGenerated: 0,
    formatsApplied: 0,
  };

  constructor(options?: { dataDir?: string }) {
    this.profilesDir = options?.dataDir
      ? path.join(options.dataDir, 'profiles')
      : DEFAULT_PROFILES_DIR;
    this.log.info('自适应用户交互系统已初始化');
  }

  /** 懒加载：首次访问画像时才从磁盘加载 */
  private ensureProfilesLoaded(): void {
    if (this.profilesLoaded) return;
    this.profilesLoaded = true;
    this.loadAllProfiles();
  }

  // ========== 核心方法 ==========

  /**
   * 适配响应风格
   * 根据用户画像调整冗余度、技术深度和语言
   */
  adaptResponse(input: string, response: string, userProfile?: UserProfile): string {
    const profile = userProfile || this.getProfile('default');
    this.stats.adaptationsPerformed++;

    let adapted = response;

    // 1. 根据通信风格调整冗余度
    adapted = this.adjustVerbosity(adapted, profile.communicationStyle);

    // 2. 根据专业水平调整技术深度
    adapted = this.adjustTechnicalDepth(adapted, profile.expertiseLevel);

    // 3. 根据语言偏好调整
    adapted = this.adjustLanguage(adapted, profile.preferredLanguage, input);

    // 更新交互计数
    profile.interactionCount++;
    profile.lastInteraction = Date.now();
    this.profiles.set(profile.id, profile);
    this.persistProfile(profile.id);

    // 广播事件
    EventBus.getInstance().emitSync('interaction.adapted', {
      userId: profile.id,
      style: profile.communicationStyle,
      expertise: profile.expertiseLevel,
      language: profile.preferredLanguage,
    });

    this.log.debug('响应已适配', {
      userId: profile.id,
      style: profile.communicationStyle,
      originalLength: response.length,
      adaptedLength: adapted.length,
    });

    return adapted;
  }

  /**
   * 追踪用户偏好
   * 记录通信风格、工具偏好、领域专长等
   */
  trackUserPreference(userId: string, preference: UserPreference): UserProfile {
    this.stats.preferencesTracked++;

    const profile = this.getProfile(userId);

    // 存储偏好
    const existing = this.preferences.get(userId) || [];
    // 同类型同 key 的偏好只保留置信度最高的
    const idx = existing.findIndex(
      p => p.type === preference.type && p.key === preference.key
    );
    if (idx >= 0) {
      if (preference.confidence > existing[idx].confidence) {
        existing[idx] = preference;
      }
    } else {
      existing.push(preference);
    }
    this.preferences.set(userId, existing);

    // 根据偏好更新画像
    this.applyPreferenceToProfile(profile, preference);

    profile.lastInteraction = Date.now();
    this.profiles.set(userId, profile);
    this.persistProfile(userId);

    // 广播事件
    EventBus.getInstance().emitSync('interaction.preference_tracked', {
      userId,
      preferenceType: preference.type,
      preferenceKey: preference.key,
      confidence: preference.confidence,
    });

    this.log.debug('用户偏好已追踪', {
      userId,
      type: preference.type,
      key: preference.key,
      value: preference.value,
      confidence: preference.confidence,
    });

    return profile;
  }

  /**
   * 生成可视化进度报告
   * 包含 ASCII 进度条、步骤状态、预估剩余时间
   */
  generateProgressReport(taskId: string, steps: StepProgress[]): string {
    this.stats.progressReportsGenerated++;

    // 缓存进度
    this.taskProgress.set(taskId, steps);

    const totalSteps = steps.length;
    const completedSteps = steps.filter(s => s.status === 'completed').length;
    const failedSteps = steps.filter(s => s.status === 'failed').length;
    const overallProgress = totalSteps > 0
      ? Math.round(steps.reduce((sum, s) => sum + s.progress, 0) / totalSteps)
      : 0;

    // 预估剩余时间
    const estimatedRemaining = this.estimateRemainingTime(steps);

    const lines: string[] = [];

    // 标题
    lines.push(`📊 任务进度报告 — ${taskId}`);
    lines.push('═'.repeat(50));

    // 总体进度条
    lines.push('');
    lines.push(`总体进度: ${this.renderProgressBar(overallProgress, 40)} ${overallProgress}%`);
    lines.push(`步骤完成: ${completedSteps}/${totalSteps}${failedSteps > 0 ? ` (失败: ${failedSteps})` : ''}`);

    if (estimatedRemaining !== null) {
      lines.push(`预估剩余: ${this.formatDuration(estimatedRemaining)}`);
    }

    // 各步骤详情
    lines.push('');
    lines.push('─'.repeat(50));
    lines.push('步骤详情:');
    lines.push('─'.repeat(50));

    for (let i = 0; i < steps.length; i++) {
      const step = steps[i];
      const icon = STATUS_ICONS[step.status];
      const label = STATUS_LABELS[step.status];
      const progressBar = step.status === 'in_progress'
        ? ` ${this.renderProgressBar(step.progress, 20)} ${step.progress}%`
        : '';
      const duration = step.duration
        ? ` (${this.formatDuration(step.duration)})`
        : '';
      const result = step.result ? ` → ${step.result}` : '';

      lines.push(`  ${i + 1}. ${icon} ${step.name} [${label}]${progressBar}${duration}${result}`);
    }

    lines.push('═'.repeat(50));

    // 广播事件
    EventBus.getInstance().emitSync('interaction.progress_report', {
      taskId,
      overallProgress,
      completedSteps,
      totalSteps,
      failedSteps,
    });

    this.log.debug('进度报告已生成', { taskId, overallProgress, completedSteps, totalSteps });

    return lines.join('\n');
  }

  /**
   * 建议下一步操作
   * 基于当前任务上下文和已完成步骤
   */
  suggestNextAction(context: string, completedActions: string[]): string {
    this.stats.suggestionsGenerated++;

    const suggestion = this.computeSuggestion(context, completedActions);

    // 广播事件
    EventBus.getInstance().emitSync('interaction.suggestion_generated', {
      context: context.substring(0, 100),
      completedCount: completedActions.length,
      suggestion: suggestion.action,
    });

    this.log.debug('下一步建议已生成', {
      context: context.substring(0, 50),
      suggestion: suggestion.action,
      reasoning: suggestion.reasoning,
    });

    let output = `💡 建议下一步: ${suggestion.action}`;
    output += `\n   理由: ${suggestion.reasoning}`;

    if (suggestion.alternatives.length > 0) {
      output += `\n   备选方案:`;
      for (const alt of suggestion.alternatives) {
        output += `\n   - ${alt}`;
      }
    }

    return output;
  }

  /**
   * 格式化输出
   * 支持 markdown / table / tree / code_block / diff / summary
   */
  formatOutput(content: string, format: OutputFormat): string {
    this.stats.formatsApplied++;

    let result: string;

    switch (format) {
      case 'markdown':
        result = this.formatAsMarkdown(content);
        break;
      case 'table':
        result = this.formatAsTable(content);
        break;
      case 'tree':
        result = this.formatAsTree(content);
        break;
      case 'code_block':
        result = this.formatAsCodeBlock(content);
        break;
      case 'diff':
        result = this.formatAsDiff(content);
        break;
      case 'summary':
        result = this.formatAsSummary(content);
        break;
      default:
        result = content;
    }

    // 广播事件
    EventBus.getInstance().emitSync('interaction.output_formatted', {
      format,
      contentLength: content.length,
      resultLength: result.length,
    });

    this.log.debug('输出已格式化', { format, originalLength: content.length });

    return result;
  }

  /**
   * 获取统计信息
   */
  getStats(): Record<string, number> {
    this.ensureProfilesLoaded();
    return {
      ...this.stats,
      totalProfiles: this.profiles.size,
      totalPreferences: Array.from(this.preferences.values()).reduce((sum, prefs) => sum + prefs.length, 0),
      activeTasks: this.taskProgress.size,
    };
  }

  // ========== Agent Loop 工具定义 ==========

  getToolDefinitions(): ToolDef[] {
    // eslint-disable-next-line @typescript-eslint/no-this-alias
    const system = this;

    return [
      {
        name: 'interact_adapt',
        description: '根据用户画像自适应调整响应风格。可调整冗余度（简洁/详细）、技术深度（入门/专家）、语言偏好（中文/英文/混合）。返回适配后的响应文本。',
        readOnly: true,
        parameters: {
          input: {
            type: 'string',
            description: '用户原始输入',
            required: true,
          },
          response: {
            type: 'string',
            description: '待适配的原始响应',
            required: true,
          },
          userId: {
            type: 'string',
            description: '用户ID，用于查找画像。默认为 "default"',
            required: false,
          },
        },
        execute: (args) => {
          try {
            const profile = args.userId
              ? system.getProfile(args.userId as string)
              : undefined;
            const result = system.adaptResponse(
              args.input as string,
              args.response as string,
              profile
            );
            return Promise.resolve(JSON.stringify({ adapted: result, userId: profile?.id || 'default' }));
          } catch (err: unknown) {
            system.log.error('interact_adapt 执行失败', { error: err });
            return Promise.resolve(`适配失败: ${errMsg(err)}`);
          }
        },
      },
      {
        name: 'interact_progress',
        description: '生成可视化进度报告，包含 ASCII 进度条、步骤完成状态和预估剩余时间。返回格式化的进度报告字符串。',
        readOnly: true,
        parameters: {
          taskId: {
            type: 'string',
            description: '任务标识符',
            required: true,
          },
          steps: {
            type: 'string',
            description: '步骤进度数组（JSON格式），每项包含 name、status、progress(0-100)、duration(可选)、result(可选)',
            required: true,
          },
        },
        execute: (args) => {
          try {
            let steps: StepProgress[];
            try {
              steps = JSON.parse(args.steps as string);
            } catch {
              return Promise.resolve('步骤格式无效，请提供合法的 JSON 数组');
            }
            return Promise.resolve(system.generateProgressReport(args.taskId as string, steps));
          } catch (err: unknown) {
            system.log.error('interact_progress 执行失败', { error: err });
            return Promise.resolve(`进度报告生成失败: ${errMsg(err)}`);
          }
        },
      },
      {
        name: 'interact_suggest',
        description: '基于当前任务上下文和已完成步骤，智能建议下一步操作。返回建议动作及理由。',
        readOnly: true,
        parameters: {
          context: {
            type: 'string',
            description: '当前任务上下文描述',
            required: true,
          },
          completedActions: {
            type: 'string',
            description: '已完成动作列表（JSON字符串数组）',
            required: true,
          },
        },
        execute: (args) => {
          try {
            let actions: string[];
            try {
              actions = JSON.parse(args.completedActions as string);
            } catch {
              actions = [];
            }
            return Promise.resolve(system.suggestNextAction(args.context as string, actions));
          } catch (err: unknown) {
            system.log.error('interact_suggest 执行失败', { error: err });
            return Promise.resolve(`建议生成失败: ${errMsg(err)}`);
          }
        },
      },
      {
        name: 'interact_format',
        description: '将内容格式化为指定显示格式。支持 markdown、table、tree、code_block、diff、summary 六种格式。',
        readOnly: true,
        parameters: {
          content: {
            type: 'string',
            description: '待格式化的原始内容',
            required: true,
          },
          format: {
            type: 'string',
            description: '目标格式：markdown | table | tree | code_block | diff | summary',
            required: true,
          },
        },
        execute: (args) => {
          try {
            const format = args.format as OutputFormat;
            const validFormats: OutputFormat[] = ['markdown', 'table', 'tree', 'code_block', 'diff', 'summary'];
            if (!validFormats.includes(format)) {
              return Promise.resolve(`不支持的格式 "${format}"，可选: ${validFormats.join(', ')}`);
            }
            return Promise.resolve(system.formatOutput(args.content as string, format));
          } catch (err: unknown) {
            system.log.error('interact_format 执行失败', { error: err });
            return Promise.resolve(`格式化失败: ${errMsg(err)}`);
          }
        },
      },
    ];
  }

  // ========== 内部方法：响应适配 ==========

  /** 根据通信风格调整冗余度 */
  private adjustVerbosity(text: string, style: UserProfile['communicationStyle']): string {
    if (style === 'concise') {
      return this.makeConcise(text);
    }
    if (style === 'verbose') {
      return this.makeVerbose(text);
    }
    // balanced / technical 不做冗余度调整
    return text;
  }

  /** 精简内容：移除冗余解释和空行 */
  private makeConcise(text: string): string {
    const lines = text.split('\n');
    const filtered = lines.filter(line => {
      const trimmed = line.trim();
      // 保留代码块标记
      if (trimmed.startsWith('```')) return true;
      // 保留非空、非纯注释、非引用说明行
      if (trimmed.length === 0) return false;
      if (trimmed.startsWith('> 💡')) return false;
      if (trimmed.startsWith('> 📚')) return false;
      return true;
    });
    // 合并连续空行为一个
    const result: string[] = [];
    let lastEmpty = false;
    for (const line of filtered) {
      if (line.trim() === '') {
        if (!lastEmpty) result.push('');
        lastEmpty = true;
      } else {
        result.push(line);
        lastEmpty = false;
      }
    }
    return result.join('\n');
  }

  /** 扩展内容：添加补充说明 */
  private makeVerbose(text: string): string {
    // 在代码块后添加提示
    const augmented = text.replace(/```(\w+)\n([\s\S]*?)```/g, (match, lang) => {
      return `${match}\n\n> 💡 以上是 ${lang} 代码示例，如需详细解释请告知。`;
    });
    return augmented;
  }

  /** 根据专业水平调整技术深度 */
  private adjustTechnicalDepth(text: string, level: UserProfile['expertiseLevel']): string {
    if (level === 'beginner' || level === 'intermediate') {
      // 为代码块添加简要说明
      return text.replace(/```(\w+)\n([\s\S]*?)```/g, (match, lang, code) => {
        const summary = this.summarizeCodeSnippet(code, lang);
        return `${match}\n\n> 📖 ${summary}`;
      });
    }
    return text;
  }

  /** 简要描述代码片段 */
  private summarizeCodeSnippet(code: string, lang: string): string {
    if (code.includes('function') || code.includes('=>')) return `这段${lang}代码定义了一个函数，用于实现特定功能。`;
    if (code.includes('class ')) return `这段${lang}代码定义了一个类，封装了相关数据和行为。`;
    if (code.includes('import ')) return `这段${lang}代码导入了外部模块并使用。`;
    if (code.includes('SELECT') || code.includes('INSERT')) return `这是一段SQL查询，用于数据库操作。`;
    return `这是一段${lang}代码。`;
  }

  /** 根据语言偏好调整 */
  private adjustLanguage(text: string, preferred: UserProfile['preferredLanguage'], input: string): string {
    // 检测输入语言倾向
    const inputHasChinese = /[\u4e00-\u9fff]/.test(input);
    const inputHasEnglish = /[a-zA-Z]{3,}/.test(input);

    if (preferred === 'en' && inputHasChinese && !inputHasEnglish) {
      // 用户偏好英文但输入是中文，添加英文对照提示
      return text + '\n\n---\n*English version available upon request.*';
    }

    if (preferred === 'zh' && inputHasEnglish && !inputHasChinese) {
      // 用户偏好中文但输入是英文，添加中文提示
      return text + '\n\n---\n*可提供中文版本，请告知。*';
    }

    return text;
  }

  // ========== 内部方法：偏好追踪 ==========

  /** 将偏好应用到用户画像 */
  private applyPreferenceToProfile(profile: UserProfile, preference: UserPreference): void {
    switch (preference.type) {
      case 'style':
        if (['concise', 'balanced', 'verbose', 'technical'].includes(preference.value)) {
          profile.communicationStyle = preference.value as UserProfile['communicationStyle'];
        }
        break;
      case 'domain':
        if (!profile.domainStrengths.includes(preference.value)) {
          profile.domainStrengths.push(preference.value);
        }
        break;
      case 'language':
        if (['zh', 'en', 'mixed'].includes(preference.value)) {
          profile.preferredLanguage = preference.value as UserProfile['preferredLanguage'];
        }
        break;
      case 'format':
        // 格式偏好暂存，供 formatOutput 参考
        break;
      case 'tool':
        // 工具偏好暂存，供建议系统参考
        break;
    }
  }

  // ========== 内部方法：进度报告 ==========

  /** 渲染 ASCII 进度条 */
  private renderProgressBar(percent: number, width: number): string {
    const filled = Math.round((percent / 100) * width);
    const empty = width - filled;
    return `[${'█'.repeat(filled)}${'░'.repeat(empty)}]`;
  }

  /** 预估剩余时间 */
  private estimateRemainingTime(steps: StepProgress[]): number | null {
    const completedWithDuration = steps.filter(
      s => s.status === 'completed' && s.duration != null
    );
    if (completedWithDuration.length === 0) return null;

    const avgDuration = completedWithDuration.reduce((sum, s) => sum + (s.duration ?? 0), 0)
      / completedWithDuration.length;

    const remaining = steps.filter(s => s.status === 'pending' || s.status === 'in_progress');
    if (remaining.length === 0) return 0;

    // 进行中的步骤按剩余进度比例计算
    let estimated = 0;
    for (const step of remaining) {
      if (step.status === 'in_progress') {
        estimated += avgDuration * ((100 - step.progress) / 100);
      } else {
        estimated += avgDuration;
      }
    }

    return Math.round(estimated);
  }

  /** 格式化时长 */
  private formatDuration(ms: number): string {
    if (ms < 1000) return `${ms}ms`;
    if (ms < 60000) return `${(ms / 1000).toFixed(1)}s`;
    const minutes = Math.floor(ms / 60000);
    const seconds = Math.round((ms % 60000) / 1000);
    return `${minutes}m${seconds}s`;
  }

  // ========== 内部方法：智能建议 ==========

  /** 计算建议 */
  private computeSuggestion(
    context: string,
    completedActions: string[]
  ): { action: string; reasoning: string; alternatives: string[] } {
    const ctx = context.toLowerCase();
    const alternatives: string[] = [];

    // 基于上下文关键词匹配建议
    if (ctx.includes('代码') || ctx.includes('code') || ctx.includes('开发')) {
      if (!completedActions.some(a => a.includes('测试') || a.includes('test'))) {
        alternatives.push('运行测试验证代码正确性');
      }
      if (!completedActions.some(a => a.includes('审查') || a.includes('review'))) {
        alternatives.push('进行代码审查，检查潜在问题');
      }
      if (!completedActions.some(a => a.includes('文档') || a.includes('doc'))) {
        alternatives.push('补充代码文档和注释');
      }
    }

    if (ctx.includes('部署') || ctx.includes('deploy') || ctx.includes('发布')) {
      if (!completedActions.some(a => a.includes('构建') || a.includes('build'))) {
        alternatives.push('执行构建流程，确保产物就绪');
      }
      if (!completedActions.some(a => a.includes('检查') || a.includes('check'))) {
        alternatives.push('运行预部署检查清单');
      }
    }

    if (ctx.includes('调试') || ctx.includes('debug') || ctx.includes('修复') || ctx.includes('fix')) {
      if (!completedActions.some(a => a.includes('复现') || a.includes('reproduce'))) {
        alternatives.push('复现问题，确认触发条件');
      }
      if (!completedActions.some(a => a.includes('日志') || a.includes('log'))) {
        alternatives.push('检查相关日志，定位错误根源');
      }
    }

    if (ctx.includes('学习') || ctx.includes('learn') || ctx.includes('研究')) {
      if (!completedActions.some(a => a.includes('总结') || a.includes('summary'))) {
        alternatives.push('整理学习笔记和要点总结');
      }
      alternatives.push('动手实践，加深理解');
    }

    // 通用建议
    if (alternatives.length === 0) {
      alternatives.push('回顾已完成步骤，确认无遗漏');
      alternatives.push('检查结果是否符合预期');
    }

    const action = alternatives.shift() || '继续推进当前任务';
    const reasoning = completedActions.length === 0
      ? '当前尚未执行任何步骤，建议从首要任务开始'
      : `已完成 ${completedActions.length} 个步骤，基于上下文推荐最有价值的下一步`;

    return { action, reasoning, alternatives };
  }

  // ========== 内部方法：格式化输出 ==========

  /** Markdown 格式化 */
  private formatAsMarkdown(content: string): string {
    // 如果内容已经包含 Markdown 标记，直接返回
    if (content.includes('#') || content.includes('**') || content.includes('- ')) {
      return content;
    }
    // 否则将段落转为 Markdown
    const lines = content.split('\n').filter(l => l.trim().length > 0);
    if (lines.length === 0) return content;
    // 第一行作为标题
    const title = `### ${lines[0]}`;
    const body = lines.slice(1).join('\n\n');
    return body ? `${title}\n\n${body}` : title;
  }

  /** 表格格式化 */
  private formatAsTable(content: string): string {
    const lines = content.split('\n').filter(l => l.trim().length > 0);
    if (lines.length === 0) return content;

    // 尝试解析为键值对
    const rows: string[][] = [];
    for (const line of lines) {
      // 支持冒号分隔的键值对
      if (line.includes(':') || line.includes('：')) {
        const sep = line.includes('：') ? '：' : ':';
        const parts = line.split(sep, 2);
        rows.push([parts[0].trim(), parts[1].trim()]);
      }
      // 支持逗号分隔
      else if (line.includes(',')) {
        rows.push(line.split(',').map(s => s.trim()));
      }
      // 支持制表符分隔
      else if (line.includes('\t')) {
        rows.push(line.split('\t').map(s => s.trim()));
      } else {
        rows.push([line.trim()]);
      }
    }

    if (rows.length === 0) return content;

    // 计算列宽
    const colCount = Math.max(...rows.map(r => r.length));
    const widths: number[] = [];
    for (let c = 0; c < colCount; c++) {
      widths.push(Math.max(...rows.map(r => (r[c] || '').length), 3));
    }

    // 构建表格
    const formatRow = (cells: string[]) =>
      '| ' + cells.map((c, i) => c.padEnd(widths[i])).join(' | ') + ' |';
    const separator = '| ' + widths.map(w => '-'.repeat(w)).join(' | ') + ' |';

    const result: string[] = [];
    if (rows.length > 0) {
      // 第一行作为表头
      const header = rows[0];
      while (header.length < colCount) header.push('');
      result.push(formatRow(header));
      result.push(separator);
      for (let i = 1; i < rows.length; i++) {
        const row = rows[i];
        while (row.length < colCount) row.push('');
        result.push(formatRow(row));
      }
    }

    return result.join('\n');
  }

  /** 树形格式化 */
  private formatAsTree(content: string): string {
    const lines = content.split('\n').filter(l => l.trim().length > 0);
    if (lines.length === 0) return content;

    const result: string[] = [];
    for (let i = 0; i < lines.length; i++) {
      if (i === 0) {
        result.push(`📁 ${lines[i].trim()}`);
      } else if (i === lines.length - 1) {
        result.push(`└── ${lines[i].trim()}`);
      } else {
        result.push(`├── ${lines[i].trim()}`);
      }
    }

    return result.join('\n');
  }

  /** 代码块格式化 */
  private formatAsCodeBlock(content: string): string {
    // 检测是否已在代码块中
    if (content.trim().startsWith('```')) return content;
    return `\`\`\`\n${content}\n\`\`\``;
  }

  /** Diff 格式化 */
  private formatAsDiff(content: string): string {
    const lines = content.split('\n');
    const result: string[] = ['```diff'];

    for (const line of lines) {
      const trimmed = line.trim();
      // 识别添加/删除/标题行
      if (trimmed.startsWith('+') || trimmed.startsWith('添加') || trimmed.startsWith('新增')) {
        result.push(`+ ${trimmed.replace(/^[+]\s*/, '')}`);
      } else if (trimmed.startsWith('-') || trimmed.startsWith('删除') || trimmed.startsWith('移除')) {
        result.push(`- ${trimmed.replace(/^[-]\s*/, '')}`);
      } else if (trimmed.startsWith('@@') || trimmed.startsWith('修改')) {
        result.push(`@@ ${trimmed.replace(/^@@\s*/, '')} @@`);
      } else {
        result.push(`  ${line}`);
      }
    }

    result.push('```');
    return result.join('\n');
  }

  /** 摘要格式化 */
  private formatAsSummary(content: string): string {
    const lines = content.split('\n').filter(l => l.trim().length > 0);
    if (lines.length <= 3) return content;

    // 取首行作为标题，末行作为结论，中间压缩
    const title = lines[0];
    const conclusion = lines[lines.length - 1];
    const middleCount = lines.length - 2;

    const result: string[] = [];
    result.push(`📌 ${title}`);
    result.push(`   ... (省略 ${middleCount} 行详情) ...`);
    result.push(`📎 ${conclusion}`);

    return result.join('\n');
  }

  // ========== 持久化 ==========

  /** 获取用户画像（不存在则返回默认） */
  getProfile(userId: string): UserProfile {
    this.ensureProfilesLoaded();
    if (this.profiles.has(userId)) {
      return { ...this.profiles.get(userId)! };
    }
    return { ...DEFAULT_PROFILE, id: userId };
  }

  /** 持久化单个画像 */
  private persistProfile(userId: string): void {
    const profile = this.profiles.get(userId);
    if (!profile) return;
    try {
      fs.mkdirSync(this.profilesDir, { recursive: true });
      const filePath = path.join(this.profilesDir, `${userId}.json`);
      atomicWriteJsonSync(filePath, profile);
    } catch (err: unknown) {
      this.log.warn('画像持久化失败', { userId, error: err });
    }
  }

  /** 加载所有画像 */
  private loadAllProfiles(): void {
    try {
      if (!fs.existsSync(this.profilesDir)) return;
      const files = fs.readdirSync(this.profilesDir);
      for (const file of files) {
        if (!file.endsWith('.json')) continue;
        const userId = file.replace('.json', '');
        try {
          const filePath = path.join(this.profilesDir, userId + '.json');
          const raw = fs.readFileSync(filePath, 'utf-8');
          const profile = JSON.parse(raw) as UserProfile;
          this.profiles.set(userId, profile);
        } catch {
          // 单个文件损坏不影响整体加载
        }
      }
      this.log.info('用户画像已加载', { count: this.profiles.size });
    } catch {
      // 目录不存在或无权限，忽略
    }
  }
}
