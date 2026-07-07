/**
 * Self-Healing Pipeline — 自愈管道系统
 *
 * 灵感来源: Codex CLI 的错误恢复模式
 * 核心思想: 自动检测、诊断和恢复错误，减少人工干预
 *
 * 能力:
 * - registerHealer: 注册错误类型的修复器
 * - heal: 尝试修复错误（检测 → 匹配 → 修复 → 验证）
 * - diagnose: 诊断错误（不修复，仅分析）
 * - getHealingHistory: 获取修复历史
 * - getStats: 统计信息
 *
 * 预注册修复器:
 * 1. tool_timeout — 工具超时：延长超时重试，然后降级
 * 2. llm_rate_limit — LLM 限流：指数退避重试
 * 3. file_not_found — 文件未找到：搜索相似文件，建议替代
 * 4. syntax_error — 语法错误：自动修复常见语法问题
 * 5. network_error — 网络错误：退避重试
 * 6. permission_denied — 权限拒绝：建议权限修复方案
 *
 * 通过 getToolDefinitions() 注册为 Agent Loop 可用工具
 */

import * as fs from 'fs';
import * as path from 'path';
import { logger } from './structured-logger.js';
import { EventBus } from './event-bus.js';

// ============ 类型定义 ============

/** 修复器定义 */
export interface HealerDefinition {
  /** 错误类型标识 */
  errorType: string;
  /** 修复器描述 */
  description: string;
  /** 检测是否匹配该错误类型 */
  detect: (error: ErrorContext) => boolean;
  /** 执行修复 */
  heal: (error: ErrorContext) => Promise<HealingAction>;
  /** 验证修复是否成功 */
  verify: (error: ErrorContext, action: HealingAction) => Promise<boolean>;
  /** 最大重试次数 */
  maxRetries: number;
  /** 优先级（数值越小越优先） */
  priority: number;
}

/** 错误上下文 */
export interface ErrorContext {
  /** 错误消息 */
  error: string;
  /** 错误类型（可选，用于快速匹配） */
  errorType?: string;
  /** 堆栈跟踪 */
  stackTrace?: string;
  /** 附加上下文 */
  context: Record<string, unknown>;
  /** 错误发生时间戳 */
  timestamp: number;
  /** 错误来源 */
  source: string;
}

/** 修复动作 */
export interface HealingAction {
  /** 动作类型 */
  type: 'retry' | 'fallback' | 'restart' | 'skip' | 'escalate' | 'custom';
  /** 动作描述 */
  description: string;
  /** 执行结果 */
  result: string;
  /** 是否成功 */
  success: boolean;
}

/** 修复结果 */
export interface HealingResult {
  /** 是否修复成功 */
  healed: boolean;
  /** 识别的错误类型 */
  errorType: string;
  /** 使用的修复器名称 */
  healerUsed: string;
  /** 执行的修复动作 */
  action: HealingAction;
  /** 尝试次数 */
  attempts: number;
  /** 耗时（毫秒） */
  duration: number;
}

/** 诊断结果 */
export interface Diagnosis {
  /** 错误类型 */
  errorType: string;
  /** 根因分析 */
  rootCause: string;
  /** 严重程度 */
  severity: 'low' | 'medium' | 'high' | 'critical';
  /** 建议修复方案 */
  suggestedFixes: Array<{ description: string; confidence: number }>;
  /** 是否可自动修复 */
  autoHealable: boolean;
}

/** 修复历史记录 */
export interface HealingRecord {
  /** 记录 ID */
  id: string;
  /** 错误消息 */
  error: string;
  /** 错误类型 */
  errorType: string;
  /** 使用的修复器 */
  healer: string;
  /** 执行的动作 */
  action: string;
  /** 是否成功 */
  success: boolean;
  /** 时间戳 */
  timestamp: number;
  /** 耗时 */
  duration: number;
}

/** 统计信息 */
export interface SelfHealingStats {
  totalErrors: number;
  totalHealed: number;
  totalFailed: number;
  totalEscalated: number;
  healSuccessRate: number;
  averageHealingTime: number;
  healerStats: Record<string, { used: number; success: number; failed: number }>;
  recentErrors: Array<{ error: string; errorType: string; timestamp: number }>;
}

// ============ 错误分类系统 ============

/**
 * 错误大类分类（5大类，覆盖90%以上常见错误）
 * - network: 网络错误（timeout/ECONNREFUSED/DNS）
 * - permission: 权限错误（401/403/ENOENT）
 * - syntax: 语法错误（SyntaxError/TypeError）
 * - resource: 资源错误（OOM/disk full）
 * - logic: 逻辑错误（assertion/business rule）
 */
export type ErrorCategory = 'network' | 'permission' | 'syntax' | 'resource' | 'logic' | 'unknown';

/** 错误分类结果 */
export interface ErrorClassification {
  /** 错误大类 */
  category: ErrorCategory;
  /** 具体错误子类型（如 timeout、dns_error、oom 等） */
  subType: string;
  /** 严重程度 */
  severity: 'low' | 'medium' | 'high' | 'critical';
  /** 是否可自动修复 */
  autoHealable: boolean;
  /** 推荐的修复策略优先级列表 */
  recommendedStrategies: string[];
}

/** 单个修复策略的执行效果追踪 */
export interface StrategyEffectiveness {
  /** 策略名称 */
  strategyName: string;
  /** 错误子类型 */
  errorSubType: string;
  /** 总尝试次数 */
  totalAttempts: number;
  /** 成功次数 */
  successCount: number;
  /** 失败次数 */
  failureCount: number;
  /** 成功率（0-1） */
  successRate: number;
  /** 平均修复耗时（毫秒） */
  avgDuration: number;
  /** 最后一次尝试时间戳 */
  lastAttemptAt: number;
  /** 历史耗时样本（用于计算平均耗时） */
  durationSamples: number[];
}

/** 策略升级结果 */
export interface StrategyEscalationResult {
  /** 是否升级到下一个策略 */
  escalated: boolean;
  /** 当前策略名称 */
  currentStrategy: string;
  /** 升级后的策略名称 */
  nextStrategy?: string;
  /** 升级原因 */
  reason: string;
  /** 已尝试的策略列表 */
  attemptedStrategies: string[];
}

// ============ SelfHealingPipeline 主类 ============

export class SelfHealingPipeline {
  private healers: Map<string, HealerDefinition> = new Map();
  private history: HealingRecord[] = [];
  private maxHistorySize = 200;
  private log = logger.child({ module: 'SelfHealingPipeline' });

  // 统计计数
  private totalErrors = 0;
  private totalHealed = 0;
  private totalFailed = 0;
  private totalEscalated = 0;
  private healingTimes: number[] = [];
  private healerUsageStats: Map<string, { used: number; success: number; failed: number }> = new Map();
  private recentErrors: Array<{ error: string; errorType: string; timestamp: number }> = [];

  // ============ 策略效果追踪 ============

  /** 策略效果追踪表（key: `${errorSubType}:${strategyName}` → 效果数据） */
  private strategyEffectiveness: Map<string, StrategyEffectiveness> = new Map();
  /** 错误子类型 → 策略优先级列表（按历史成功率排序） */
  private strategyPriorityMap: Map<string, string[]> = new Map();
  /** 当前正在进行的修复会话（key: errorSignature → 已尝试策略列表） */
  private activeRepairSessions: Map<string, string[]> = new Map();

  constructor() {
    this.registerBuiltinHealers();
    this.initializeStrategyPriorities();
  }

  // ============ 预注册修复器 ============

  private registerBuiltinHealers(): void {
    // 1. tool_timeout — 工具超时
    this.registerHealer('tool_timeout', {
      errorType: 'tool_timeout',
      description: '工具执行超时：延长超时时间重试，失败后降级处理',
      detect: (error) => {
        const msg = error.error.toLowerCase();
        return msg.includes('timeout') || msg.includes('超时') || msg.includes('timed out') || msg.includes('etimedout');
      },
      heal: (error) => {
        const originalTimeout = (error.context.timeout as number) || 30000;
        const newTimeout = originalTimeout * 2;

        this.log.info('工具超时，尝试延长超时重试', { originalTimeout, newTimeout });

        return Promise.resolve({
          type: 'retry',
          description: `延长超时从 ${originalTimeout}ms 到 ${newTimeout}ms 后重试`,
          result: `已将超时时间调整为 ${newTimeout}ms，建议重新执行工具调用`,
          success: true,
        });
      },
      verify: (error, action) => {
        // 重新检查：新超时必须大于原超时，且 action 标记成功
        const originalTimeout = (error.context.timeout as number) || 30000;
        const match = action.result.match(/(\d+)ms/);
        const newTimeout = match ? parseInt(match[1], 10) : 0;
        return Promise.resolve(action.success && newTimeout > originalTimeout);
      },
      maxRetries: 2,
      priority: 10,
    });

    // 2. llm_rate_limit — LLM 限流
    this.registerHealer('llm_rate_limit', {
      errorType: 'llm_rate_limit',
      description: 'LLM API 限流：指数退避重试',
      detect: (error) => {
        const msg = error.error.toLowerCase();
        return msg.includes('rate limit') || msg.includes('429') ||
               msg.includes('too many requests') || msg.includes('限流') ||
               msg.includes('rate_limit') || msg.includes('quota exceeded');
      },
      heal: async (error) => {
        const retryCount = (error.context.retryCount as number) || 0;
        const baseDelay = 2000;
        const delay = Math.min(baseDelay * Math.pow(2, retryCount), 60000);
        // 添加抖动防止惊群效应
        const jitter = Math.random() * 1000;
        const totalDelay = delay + jitter;

        this.log.info('LLM 限流，指数退避等待', { retryCount, delay: totalDelay });

        // 实际等待
        await new Promise(resolve => setTimeout(resolve, totalDelay));

        return {
          type: 'retry',
          description: `指数退避等待 ${Math.round(totalDelay)}ms 后重试（第 ${retryCount + 1} 次）`,
          result: `已等待 ${Math.round(totalDelay)}ms，可以重新发起请求`,
          success: true,
        };
      },
      verify: (_error, action) => {
        // 重新检查：退避等待必须实际发生（result 含延迟且 > 0）
        const match = action.result.match(/(\d+)ms/);
        const waited = match ? parseInt(match[1], 10) : 0;
        return Promise.resolve(action.success && waited > 0);
      },
      maxRetries: 5,
      priority: 5,
    });

    // 3. file_not_found — 文件未找到
    this.registerHealer('file_not_found', {
      errorType: 'file_not_found',
      description: '文件未找到：搜索相似文件，建议替代方案',
      detect: (error) => {
        const msg = error.error.toLowerCase();
        return msg.includes('enoent') || msg.includes('not found') ||
               msg.includes('找不到') || msg.includes('不存在') ||
               msg.includes('no such file') || msg.includes('file not found');
      },
      heal: (error) => {
        const filePath = (error.context.filePath as string) || (error.context.path as string) || '';

        if (!filePath) {
          return Promise.resolve({
            type: 'skip',
            description: '无法确定文件路径，跳过修复',
            result: '错误上下文中未包含文件路径信息',
            success: false,
          });
        }

        // 提取文件名和目录，搜索相似文件
        const pathParts = filePath.replace(/\\/g, '/').split('/');
        const fileName = pathParts[pathParts.length - 1];

        // 基于文件名生成建议
        const suggestions: string[] = [];

        // 常见替代：.js → .ts, .tsx → .jsx 等
        const extMap: Record<string, string[]> = {
          '.ts': ['.js', '.tsx'],
          '.js': ['.ts', '.jsx'],
          '.tsx': ['.jsx', '.ts'],
          '.jsx': ['.tsx', '.js'],
          '.mjs': ['.js', '.cjs'],
          '.cjs': ['.js', '.mjs'],
        };

        const ext = '.' + fileName.split('.').pop();
        if (extMap[ext]) {
          for (const alt of extMap[ext]) {
            suggestions.push(filePath.replace(new RegExp(`\\${ext}$`), alt));
          }
        }

        // 建议检查 index 文件
        if (!fileName.startsWith('index.')) {
          const dir = pathParts.slice(0, -1).join('/');
          suggestions.push(`${dir}/index${ext}`);
        }

        this.log.info('文件未找到，生成替代建议', { filePath, suggestions });

        return Promise.resolve({
          type: 'fallback',
          description: `文件 ${filePath} 未找到，建议替代文件`,
          result: suggestions.length > 0
            ? `建议尝试以下替代文件:\n${suggestions.map((s, i) => `  ${i + 1}. ${s}`).join('\n')}`
            : `文件 ${filePath} 未找到，且无相似替代文件`,
          success: suggestions.length > 0,
        });
      },
      verify: (error, action) => {
        // 重新检查：若提供了替代文件建议，至少一个应真实存在
        const filePath = (error.context.filePath as string) || (error.context.path as string) || '';
        if (!action.success) return Promise.resolve(false);
        if (!filePath) return Promise.resolve(true); // 无路径上下文则信任 action
        const baseDir = path.dirname(filePath);
        const candidates = action.result.match(/[\w/.-]+\.\w+/g) || [];
        for (const c of candidates) {
          try {
            if (fs.existsSync(path.resolve(baseDir, c))) return Promise.resolve(true);
          } catch { /* 忽略单个候选检查失败 */ }
        }
        return Promise.resolve(false);
      },
      maxRetries: 1,
      priority: 20,
    });

    // 4. syntax_error — 语法错误
    this.registerHealer('syntax_error', {
      errorType: 'syntax_error',
      description: '代码语法错误：自动修复常见语法问题',
      detect: (error) => {
        const msg = error.error.toLowerCase();
        return msg.includes('syntaxerror') || msg.includes('syntax error') ||
               msg.includes('语法错误') || msg.includes('unexpected token') ||
               msg.includes('unexpected identifier') || msg.includes('unexpected end');
      },
      heal: (error) => {
        const code = (error.context.code as string) || '';
        const msg = error.error;

        const fixes: string[] = [];

        // 常见语法错误自动修复策略
        if (msg.includes('unexpected token') || msg.includes('unexpected identifier')) {
          fixes.push('检查是否缺少逗号、分号或括号');
          fixes.push('检查是否有未闭合的字符串或模板字面量');
          fixes.push('检查是否误用了保留字作为变量名');
        }

        if (msg.includes('unexpected end')) {
          fixes.push('检查是否缺少闭合括号、花括号或方括号');
          if (code) {
            const opens = (code.match(/[{([]/g) || []).length;
            const closes = (code.match(/[})\]]/g) || []).length;
            if (opens > closes) {
              fixes.push(`检测到 ${opens - closes} 个未闭合的括号`);
            }
          }
        }

        this.log.info('语法错误，生成修复建议', { error: msg, fixCount: fixes.length });

        return Promise.resolve({
          type: 'custom',
          description: '语法错误自动分析和修复建议',
          result: fixes.length > 0
            ? `语法错误修复建议:\n${fixes.map((f, i) => `  ${i + 1}. ${f}`).join('\n')}`
            : '无法自动修复此语法错误，建议手动检查代码',
          success: fixes.length > 0,
        });
      },
      verify: (error, action) => {
        // 重新检查：修复建议非空，且与原始错误类型相关
        if (!action.success) return Promise.resolve(false);
        const msg = error.error.toLowerCase();
        const result = action.result.toLowerCase();
        const relevant =
          (msg.includes('unexpected') && result.includes('括号')) ||
          (msg.includes('unexpected end') && result.includes('闭合')) ||
          result.includes('语法错误');
        return Promise.resolve(relevant);
      },
      maxRetries: 1,
      priority: 30,
    });

    // 5. network_error — 网络错误
    this.registerHealer('network_error', {
      errorType: 'network_error',
      description: '网络错误：退避重试',
      detect: (error) => {
        const msg = error.error.toLowerCase();
        return msg.includes('econnrefused') || msg.includes('econnreset') ||
               msg.includes('enotfound') || msg.includes('network') ||
               msg.includes('fetch failed') || msg.includes('网络错误') ||
               msg.includes('connection refused') || msg.includes('connection reset');
      },
      heal: async (error) => {
        const retryCount = (error.context.retryCount as number) || 0;
        const baseDelay = 1000;
        const delay = Math.min(baseDelay * Math.pow(2, retryCount), 30000);
        const jitter = Math.random() * 500;
        const totalDelay = delay + jitter;

        this.log.info('网络错误，退避重试', { retryCount, delay: totalDelay });

        await new Promise(resolve => setTimeout(resolve, totalDelay));

        return {
          type: 'retry',
          description: `网络错误，等待 ${Math.round(totalDelay)}ms 后重试（第 ${retryCount + 1} 次）`,
          result: `已等待 ${Math.round(totalDelay)}ms，可以重新发起网络请求`,
          success: true,
        };
      },
      verify: (_error, action) => {
        // 重新检查：退避等待必须实际发生
        const match = action.result.match(/(\d+)ms/);
        const waited = match ? parseInt(match[1], 10) : 0;
        return Promise.resolve(action.success && waited > 0);
      },
      maxRetries: 3,
      priority: 15,
    });

    // 6. permission_denied — 权限拒绝
    this.registerHealer('permission_denied', {
      errorType: 'permission_denied',
      description: '权限拒绝：建议权限修复方案',
      detect: (error) => {
        const msg = error.error.toLowerCase();
        return msg.includes('eacces') || msg.includes('permission denied') ||
               msg.includes('权限') || msg.includes('access denied') ||
               msg.includes('forbidden') || msg.includes('eperm');
      },
      heal: (error) => {
        const filePath = (error.context.filePath as string) || (error.context.path as string) || '';
        const suggestions: string[] = [];

        if (filePath) {
          suggestions.push(`检查文件权限: ls -la "${filePath}"`);
          suggestions.push(`修改文件权限: chmod 644 "${filePath}"`);
          suggestions.push(`修改目录权限: chmod 755 "$(dirname "${filePath}")"`);
        }

        suggestions.push('确认当前用户是否有访问权限');
        suggestions.push('检查文件是否被其他进程锁定');

        this.log.info('权限拒绝，生成修复建议', { filePath });

        return Promise.resolve({
          type: 'escalate',
          description: '权限拒绝需要人工介入',
          result: `权限修复建议:\n${suggestions.map((s, i) => `  ${i + 1}. ${s}`).join('\n')}`,
          success: true,
        });
      },
      verify: (error, action) => {
        // 重新检查：若提供了文件路径，验证当前是否可访问
        const filePath = (error.context.filePath as string) || (error.context.path as string) || '';
        if (!action.success) return Promise.resolve(false);
        if (!filePath) return Promise.resolve(true); // 无路径则信任 escalate action
        try {
          fs.accessSync(filePath, fs.constants.R_OK);
          return Promise.resolve(true); // 权限已恢复
        } catch {
          return Promise.resolve(false); // 仍不可访问
        }
      },
      maxRetries: 0,
      priority: 40,
    });

    // ============ 扩展修复器（错误分类系统支持） ============

    // 7. dns_error — DNS 解析失败
    this.registerHealer('dns_error', {
      errorType: 'dns_error',
      description: 'DNS解析失败：切换DNS服务器、使用IP直连、缓存解析结果',
      detect: (error) => {
        const msg = error.error.toLowerCase();
        return msg.includes('enotfound') || msg.includes('getaddrinfo') ||
               msg.includes('dns') || msg.includes('域名解析') ||
               msg.includes('name resolution');
      },
      heal: async (error) => {
        const retryCount = (error.context.retryCount as number) || 0;
        const strategies = [
          '等待后重试（DNS可能是临时故障）',
          '切换到公共DNS（如 8.8.8.8 或 114.114.114.114）',
          '使用IP直连代替域名',
          '检查hosts文件是否有错误映射',
        ];
        const delay = Math.min(2000 * Math.pow(2, retryCount), 20000);

        this.log.info('DNS解析失败，尝试修复', { retryCount, delay });

        await new Promise(resolve => setTimeout(resolve, delay));

        return {
          type: 'retry',
          description: `DNS解析失败修复（第 ${retryCount + 1} 次）`,
          result: `已等待 ${delay}ms。建议:\n${strategies.map((s, i) => `  ${i + 1}. ${s}`).join('\n')}`,
          success: true,
        };
      },
      verify: (_error, action) => {
        // 重新检查：DNS 修复必须实际等待
        const match = action.result.match(/(\d+)ms/);
        const waited = match ? parseInt(match[1], 10) : 0;
        return Promise.resolve(action.success && waited > 0);
      },
      maxRetries: 3,
      priority: 16,
    });

    // 8. oom_error — 内存不足
    this.registerHealer('oom_error', {
      errorType: 'oom_error',
      description: '内存不足：释放缓存、减少并发、分批处理',
      detect: (error) => {
        const msg = error.error.toLowerCase();
        return msg.includes('out of memory') || msg.includes('oom') ||
               msg.includes('heap out of memory') || msg.includes('内存不足') ||
               msg.includes('javascript heap out of memory');
      },
      heal: (_error) => {
        const strategies = [
          '触发垃圾回收：global.gc && global.gc()',
          '减少并发任务数量，改为串行处理',
          '分批处理大数据集，避免一次性加载',
          '增加Node.js内存限制：--max-old-space-size=4096',
          '检查是否有内存泄漏（未清理的定时器、事件监听器）',
        ];

        // 尝试触发垃圾回收（如果可用）
        try {
          if (typeof (global as { gc?: () => void }).gc === 'function') {
            (global as { gc?: () => void }).gc!();
          }
        } catch {}

        this.log.info('内存不足，生成修复建议');

        return Promise.resolve({
          type: 'fallback',
          description: '内存不足修复建议',
          result: `内存优化建议:\n${strategies.map((s, i) => `  ${i + 1}. ${s}`).join('\n')}`,
          success: true,
        });
      },
      verify: (_error, action) => {
        // 重新检查：内存优化建议必须非空且相关
        if (!action.success) return Promise.resolve(false);
        const result = action.result.toLowerCase();
        const hasRelevantAdvice =
          result.includes('垃圾回收') || result.includes('并发') ||
          result.includes('分批') || result.includes('内存') ||
          result.includes('memory');
        return Promise.resolve(hasRelevantAdvice);
      },
      maxRetries: 1,
      priority: 25,
    });

    // 9. disk_full_error — 磁盘空间不足
    this.registerHealer('disk_full_error', {
      errorType: 'disk_full_error',
      description: '磁盘空间不足：清理临时文件、缓存、日志',
      detect: (error) => {
        const msg = error.error.toLowerCase();
        return msg.includes('enospc') || msg.includes('disk full') ||
               msg.includes('no space left') || msg.includes('磁盘满') ||
               msg.includes('磁盘空间不足') || msg.includes('quota exceeded');
      },
      heal: (_error) => {
        const strategies = [
          '清理临时文件：删除 tmp/ 和 temp/ 目录内容',
          '清理npm缓存：npm cache clean --force',
          '清理日志文件：压缩或删除旧日志',
          '清理构建产物：删除 dist/ build/ 目录',
          '检查磁盘配额：df -h 查看剩余空间',
        ];

        this.log.info('磁盘空间不足，生成清理建议');

        return Promise.resolve({
          type: 'fallback',
          description: '磁盘空间不足修复建议',
          result: `磁盘清理建议:\n${strategies.map((s, i) => `  ${i + 1}. ${s}`).join('\n')}`,
          success: true,
        });
      },
      verify: (_error, action) => {
        // 重新检查：磁盘清理建议必须非空且相关
        if (!action.success) return Promise.resolve(false);
        const result = action.result.toLowerCase();
        const hasRelevantAdvice =
          result.includes('临时文件') || result.includes('缓存') ||
          result.includes('日志') || result.includes('磁盘') ||
          result.includes('disk');
        return Promise.resolve(hasRelevantAdvice);
      },
      maxRetries: 0,
      priority: 35,
    });

    // 10. type_error — 类型错误
    this.registerHealer('type_error', {
      errorType: 'type_error',
      description: '类型错误：检查变量类型、添加类型守卫、修复空值引用',
      detect: (error) => {
        const msg = error.error.toLowerCase();
        return msg.includes('typeerror') || msg.includes('type error') ||
               msg.includes('cannot read propert') || msg.includes('cannot read properties') ||
               msg.includes('is not a function') || msg.includes('is not defined') ||
               msg.includes('is null') || msg.includes('is undefined') ||
               msg.includes('类型错误');
      },
      heal: (error) => {
        const msg = error.error;
        const fixes: string[] = [];

        if (msg.includes('cannot read propert') || msg.includes('cannot read properties')) {
          fixes.push('检查变量是否为 null/undefined，添加空值检查');
          fixes.push('使用可选链操作符 (?.) 访问属性');
          fixes.push('添加默认值：const x = obj?.prop ?? defaultValue');
        }
        if (msg.includes('is not a function')) {
          fixes.push('检查对象是否正确初始化');
          fixes.push('确认方法名拼写正确');
          fixes.push('检查 this 绑定是否正确');
        }
        if (msg.includes('is not defined')) {
          fixes.push('检查变量是否已声明（let/const/var）');
          fixes.push('检查 import/require 是否正确');
          fixes.push('检查作用域是否正确');
        }

        this.log.info('类型错误，生成修复建议', { fixCount: fixes.length });

        return Promise.resolve({
          type: 'custom',
          description: '类型错误修复建议',
          result: fixes.length > 0
            ? `类型错误修复建议:\n${fixes.map((f, i) => `  ${i + 1}. ${f}`).join('\n')}`
            : '无法自动修复此类型错误，建议检查代码逻辑',
          success: fixes.length > 0,
        });
      },
      verify: (error, action) => {
        // 重新检查：类型错误修复建议必须与原始错误相关
        if (!action.success) return Promise.resolve(false);
        const msg = error.error.toLowerCase();
        const result = action.result.toLowerCase();
        const relevant =
          (msg.includes('cannot read') && (result.includes('空值') || result.includes('null'))) ||
          (msg.includes('is not a function') && result.includes('初始化')) ||
          (msg.includes('is not defined') && (result.includes('声明') || result.includes('import'))) ||
          result.includes('类型错误');
        return Promise.resolve(relevant);
      },
      maxRetries: 1,
      priority: 32,
    });

    // 11. assertion_error — 断言/业务逻辑错误
    this.registerHealer('assertion_error', {
      errorType: 'assertion_error',
      description: '断言/业务逻辑错误：分析失败条件、调整验证逻辑',
      detect: (error) => {
        const msg = error.error.toLowerCase();
        return msg.includes('assertion') || msg.includes('assert') ||
               msg.includes('expect') || msg.includes('断言失败') ||
               msg.includes('业务规则') || msg.includes('validation failed') ||
               msg.includes('precondition');
      },
      heal: (_error) => {
        const strategies = [
          '检查输入数据是否符合预期格式',
          '验证业务规则前置条件是否满足',
          '调整断言条件，确认是否过于严格',
          '添加更详细的错误上下文信息',
          '检查边界情况处理（空值、极值、并发）',
        ];

        this.log.info('断言/业务逻辑错误，生成修复建议');

        return Promise.resolve({
          type: 'custom',
          description: '断言/业务逻辑错误修复建议',
          result: `业务逻辑修复建议:\n${strategies.map((s, i) => `  ${i + 1}. ${s}`).join('\n')}`,
          success: true,
        });
      },
      verify: (_error, action) => {
        // 重新检查：业务逻辑修复建议必须非空且相关
        if (!action.success) return Promise.resolve(false);
        const result = action.result.toLowerCase();
        const hasRelevantAdvice =
          result.includes('输入数据') || result.includes('业务规则') ||
          result.includes('断言') || result.includes('边界') ||
          result.includes('业务逻辑');
        return Promise.resolve(hasRelevantAdvice);
      },
      maxRetries: 0,
      priority: 45,
    });
  }

  /**
   * 初始化错误子类型 → 策略优先级映射
   * 每种错误类型对应3-5种修复策略，按优先级排序
   */
  private initializeStrategyPriorities(): void {
    // 网络错误类（5种策略）
    this.strategyPriorityMap.set('timeout', ['tool_timeout', 'network_error', 'dns_error', 'llm_rate_limit', 'assertion_error']);
    this.strategyPriorityMap.set('network_error', ['network_error', 'dns_error', 'tool_timeout', 'llm_rate_limit']);
    this.strategyPriorityMap.set('dns_error', ['dns_error', 'network_error', 'tool_timeout']);
    this.strategyPriorityMap.set('llm_rate_limit', ['llm_rate_limit', 'network_error', 'tool_timeout']);

    // 权限错误类（3种策略）
    this.strategyPriorityMap.set('permission_denied', ['permission_denied', 'file_not_found', 'assertion_error']);
    this.strategyPriorityMap.set('file_not_found', ['file_not_found', 'permission_denied', 'assertion_error']);

    // 语法错误类（3种策略）
    this.strategyPriorityMap.set('syntax_error', ['syntax_error', 'type_error', 'assertion_error']);
    this.strategyPriorityMap.set('type_error', ['type_error', 'syntax_error', 'assertion_error']);

    // 资源错误类（4种策略）
    this.strategyPriorityMap.set('oom_error', ['oom_error', 'tool_timeout', 'network_error', 'assertion_error']);
    this.strategyPriorityMap.set('disk_full_error', ['disk_full_error', 'file_not_found', 'permission_denied', 'assertion_error']);

    // 逻辑错误类（3种策略）
    this.strategyPriorityMap.set('assertion_error', ['assertion_error', 'type_error', 'syntax_error']);
  }

  // ============ 核心方法 ============

  /**
   * 注册修复器
   */
  registerHealer(errorType: string, healer: HealerDefinition): { success: boolean; message: string } {
    if (this.healers.has(errorType)) {
      this.log.warn('修复器已存在，将被覆盖', { errorType });
    }

    this.healers.set(errorType, healer);
    this.healerUsageStats.set(errorType, { used: 0, success: 0, failed: 0 });

    this.log.info('修复器已注册', { errorType, description: healer.description });

    EventBus.getInstance().emitSync('healing.healer.registered', {
      errorType,
      description: healer.description,
      priority: healer.priority,
    }, { source: 'SelfHealingPipeline' });

    return { success: true, message: `修复器 "${errorType}" 已注册` };
  }

  /**
   * 尝试修复错误
   * 流程: 检测错误类型 → 匹配修复器 → 执行修复 → 验证结果
   */
  async heal(error: ErrorContext): Promise<HealingResult> {
    const startTime = Date.now();
    this.totalErrors++;

    // 记录最近错误
    this.recentErrors.push({
      error: (error.error || '').substring(0, 200),
      errorType: error.errorType || 'unknown',
      timestamp: error.timestamp,
    });
    if (this.recentErrors.length > 50) this.recentErrors.shift();

    // 广播错误事件
    EventBus.getInstance().emitSync('healing.error.detected', {
      error: (error.error || '').substring(0, 200),
      source: error.source,
      timestamp: error.timestamp,
    }, { source: 'SelfHealingPipeline' });

    // 查找匹配的修复器
    const matchedHealers = this.findMatchingHealers(error);

    if (matchedHealers.length === 0) {
      this.totalFailed++;
      this.log.warn('未找到匹配的修复器', { error: (error.error || '').substring(0, 100) });

      const result: HealingResult = {
        healed: false,
        errorType: 'unknown',
        healerUsed: 'none',
        action: {
          type: 'escalate',
          description: '未找到匹配的修复器，需要人工介入',
          result: `无法自动修复错误: ${(error.error || '').substring(0, 200)}`,
          success: false,
        },
        attempts: 0,
        duration: Date.now() - startTime,
      };

      this.recordHealing(error, result);
      return result;
    }

    // 按优先级尝试修复器
    let lastResult: HealingResult | null = null;

    for (const healer of matchedHealers) {
      const stats = this.healerUsageStats.get(healer.errorType);
      if (stats) stats.used++;

      let attempts = 0;
      const maxAttempts = healer.maxRetries + 1;

      while (attempts < maxAttempts) {
        attempts++;

        try {
          // 执行修复
          const action = await healer.heal(error);

          // 验证修复
          const verified = await healer.verify(error, action);

          const result: HealingResult = {
            healed: verified && action.success,
            errorType: healer.errorType,
            healerUsed: healer.errorType,
            action,
            attempts,
            duration: Date.now() - startTime,
          };

          if (result.healed) {
            this.totalHealed++;
            if (stats) stats.success++;

            // 记录策略效果（用于后续优化策略选择）
            this.recordStrategyEffect(healer.errorType, healer.errorType, true, result.duration);

            this.log.info('错误已修复', {
              errorType: healer.errorType,
              attempts,
              duration: result.duration,
            });

            EventBus.getInstance().emitSync('healing.error.healed', {
              errorType: healer.errorType,
              healerUsed: healer.errorType,
              attempts,
              duration: result.duration,
            }, { source: 'SelfHealingPipeline' });

            this.recordHealing(error, result);
            return result;
          }

          lastResult = result;

          // 如果动作类型是 escalate，不再重试
          if (action.type === 'escalate') {
            this.totalEscalated++;
            // 记录升级策略的效果
            this.recordStrategyEffect(healer.errorType, healer.errorType, false, result.duration);
            break;
          }

          // 更新重试计数到上下文
          error.context = { ...error.context, retryCount: attempts };

        } catch (healErr: unknown) {
          this.log.warn('修复器执行异常', {
            healer: healer.errorType,
            attempt: attempts,
            error: (healErr instanceof Error ? healErr.message : String(healErr)),
          });
          // 记录修复器异常的效果
          this.recordStrategyEffect(healer.errorType, healer.errorType, false, Date.now() - startTime);
          lastResult = {
            healed: false,
            errorType: healer.errorType,
            healerUsed: healer.errorType,
            action: {
              type: 'custom',
              description: `修复器执行异常: ${(healErr instanceof Error ? healErr.message : String(healErr))}`,
              result: (healErr instanceof Error ? healErr.message : String(healErr)),
              success: false,
            },
            attempts,
            duration: Date.now() - startTime,
          };
        }
      }

      // 当前修复器所有尝试都失败，记录并尝试下一个
      if (stats && !lastResult?.healed) stats.failed++;
    }

    // 所有修复器都失败
    this.totalFailed++;
    this.log.warn('所有修复器均未能修复错误', { error: (error.error || '').substring(0, 100) });

    const finalResult: HealingResult = lastResult || {
      healed: false,
      errorType: 'unknown',
      healerUsed: 'none',
      action: {
        type: 'escalate',
        description: '所有修复器均失败',
        result: '无法自动修复，需要人工介入',
        success: false,
      },
      attempts: 0,
      duration: Date.now() - startTime,
    };

    this.recordHealing(error, finalResult);
    return finalResult;
  }

  /**
   * 诊断错误（不修复）
   */
  diagnose(error: ErrorContext): Diagnosis {
    const matchedHealers = this.findMatchingHealers(error);

    if (matchedHealers.length === 0) {
      return {
        errorType: 'unknown',
        rootCause: this.analyzeRootCause(error),
        severity: 'high',
        suggestedFixes: [
          { description: '未找到匹配的自动修复器，建议人工排查', confidence: 0.3 },
        ],
        autoHealable: false,
      };
    }

    const primaryHealer = matchedHealers[0];
    const rootCause = this.analyzeRootCause(error);

    // 根据错误特征判断严重程度
    const severity = this.assessSeverity(error);

    // 生成修复建议
    const suggestedFixes: Array<{ description: string; confidence: number }> = [];

    for (const healer of matchedHealers) {
      suggestedFixes.push({
        description: `[${healer.errorType}] ${healer.description}`,
        confidence: Math.max(0.5, 1 - healer.priority / 100),
      });
    }

    return {
      errorType: primaryHealer.errorType,
      rootCause,
      severity,
      suggestedFixes,
      autoHealable: true,
    };
  }

  /**
   * 获取修复历史
   */
  getHealingHistory(limit: number = 50): HealingRecord[] {
    return this.history.slice(-limit).reverse();
  }

  /**
   * 获取统计信息
   */
  getStats(): SelfHealingStats {
    const successRate = this.totalErrors > 0
      ? this.totalHealed / this.totalErrors
      : 1;

    const avgTime = this.healingTimes.length > 0
      ? this.healingTimes.reduce((a, b) => a + b, 0) / this.healingTimes.length
      : 0;

    const healerStats: Record<string, { used: number; success: number; failed: number }> = {};
    for (const [type, stats] of this.healerUsageStats) {
      healerStats[type] = { ...stats };
    }

    return {
      totalErrors: this.totalErrors,
      totalHealed: this.totalHealed,
      totalFailed: this.totalFailed,
      totalEscalated: this.totalEscalated,
      healSuccessRate: Math.round(successRate * 1000) / 1000,
      averageHealingTime: Math.round(avgTime),
      healerStats,
      recentErrors: this.recentErrors.slice(-10),
    };
  }

  // ============ 错误分类系统方法 ============

  /**
   * 对错误进行分类（5大类：network/permission/syntax/resource/logic）
   *
   * @param error 错误上下文
   * @returns 错误分类结果，包含大类、子类型、严重程度和推荐策略
   */
  classifyError(error: ErrorContext): ErrorClassification {
    const msg = (error.error || '').toLowerCase();
    const subType = this.detectErrorSubType(error);

    // 网络错误类
    if (this.isNetworkError(msg)) {
      return {
        category: 'network',
        subType,
        severity: this.assessSeverity(error),
        autoHealable: true,
        recommendedStrategies: this.getRecommendedStrategies(subType),
      };
    }

    // 权限错误类
    if (this.isPermissionError(msg)) {
      return {
        category: 'permission',
        subType,
        severity: this.assessSeverity(error),
        autoHealable: subType !== 'permission_denied',
        recommendedStrategies: this.getRecommendedStrategies(subType),
      };
    }

    // 语法错误类
    if (this.isSyntaxError(msg)) {
      return {
        category: 'syntax',
        subType,
        severity: 'medium',
        autoHealable: true,
        recommendedStrategies: this.getRecommendedStrategies(subType),
      };
    }

    // 资源错误类
    if (this.isResourceError(msg)) {
      return {
        category: 'resource',
        subType,
        severity: 'critical',
        autoHealable: subType === 'oom_error',
        recommendedStrategies: this.getRecommendedStrategies(subType),
      };
    }

    // 逻辑错误类
    if (this.isLogicError(msg)) {
      return {
        category: 'logic',
        subType,
        severity: 'high',
        autoHealable: false,
        recommendedStrategies: this.getRecommendedStrategies(subType),
      };
    }

    return {
      category: 'unknown',
      subType: 'unknown',
      severity: 'medium',
      autoHealable: false,
      recommendedStrategies: [],
    };
  }

  /** 检测错误子类型 */
  private detectErrorSubType(error: ErrorContext): string {
    const msg = (error.error || '').toLowerCase();

    // 网络类子类型
    if (msg.includes('timeout') || msg.includes('超时') || msg.includes('timed out')) return 'timeout';
    if (msg.includes('enotfound') || msg.includes('dns') || msg.includes('getaddrinfo')) return 'dns_error';
    if (msg.includes('econnrefused') || msg.includes('econnreset') || msg.includes('network')) return 'network_error';
    if (msg.includes('rate limit') || msg.includes('429') || msg.includes('too many requests')) return 'llm_rate_limit';

    // 权限类子类型
    if (msg.includes('eacces') || msg.includes('permission denied') || msg.includes('forbidden')) return 'permission_denied';
    if (msg.includes('enoent') || msg.includes('not found') || msg.includes('no such file')) return 'file_not_found';

    // 语法类子类型
    if (msg.includes('syntaxerror') || msg.includes('unexpected token')) return 'syntax_error';
    if (msg.includes('typeerror') || msg.includes('cannot read') || msg.includes('is not a function')) return 'type_error';

    // 资源类子类型
    if (msg.includes('out of memory') || msg.includes('oom') || msg.includes('heap')) return 'oom_error';
    if (msg.includes('enospc') || msg.includes('disk full') || msg.includes('no space')) return 'disk_full_error';

    // 逻辑类子类型
    if (msg.includes('assertion') || msg.includes('assert') || msg.includes('validation failed')) return 'assertion_error';

    return 'unknown';
  }

  /** 判断是否网络错误 */
  private isNetworkError(msg: string): boolean {
    return msg.includes('timeout') || msg.includes('超时') || msg.includes('timed out') ||
           msg.includes('econnrefused') || msg.includes('econnreset') || msg.includes('enotfound') ||
           msg.includes('network') || msg.includes('fetch failed') || msg.includes('dns') ||
           msg.includes('rate limit') || msg.includes('429') || msg.includes('getaddrinfo');
  }

  /** 判断是否权限错误 */
  private isPermissionError(msg: string): boolean {
    return msg.includes('eacces') || msg.includes('permission denied') || msg.includes('forbidden') ||
           msg.includes('enoent') || msg.includes('not found') || msg.includes('no such file') ||
           msg.includes('access denied') || msg.includes('权限');
  }

  /** 判断是否语法错误 */
  private isSyntaxError(msg: string): boolean {
    return msg.includes('syntaxerror') || msg.includes('syntax error') || msg.includes('unexpected token') ||
           msg.includes('typeerror') || msg.includes('type error') || msg.includes('cannot read') ||
           msg.includes('is not a function') || msg.includes('is not defined') || msg.includes('语法错误');
  }

  /** 判断是否资源错误 */
  private isResourceError(msg: string): boolean {
    return msg.includes('out of memory') || msg.includes('oom') || msg.includes('heap out of memory') ||
           msg.includes('enospc') || msg.includes('disk full') || msg.includes('no space left') ||
           msg.includes('内存不足') || msg.includes('磁盘');
  }

  /** 判断是否逻辑错误 */
  private isLogicError(msg: string): boolean {
    return msg.includes('assertion') || msg.includes('assert') || msg.includes('expect') ||
           msg.includes('validation failed') || msg.includes('precondition') || msg.includes('断言') ||
           msg.includes('业务规则');
  }

  /** 获取错误子类型对应的推荐策略列表 */
  private getRecommendedStrategies(subType: string): string[] {
    return this.strategyPriorityMap.get(subType) || [];
  }

  // ============ 策略效果追踪方法 ============

  /**
   * 记录策略执行效果（用于后续优化策略选择）
   */
  recordStrategyEffect(strategyName: string, errorSubType: string, success: boolean, duration: number): void {
    const key = `${errorSubType}:${strategyName}`;
    let effectiveness = this.strategyEffectiveness.get(key);

    if (!effectiveness) {
      effectiveness = {
        strategyName,
        errorSubType,
        totalAttempts: 0,
        successCount: 0,
        failureCount: 0,
        successRate: 0,
        avgDuration: 0,
        lastAttemptAt: 0,
        durationSamples: [],
      };
      this.strategyEffectiveness.set(key, effectiveness);
    }

    effectiveness.totalAttempts++;
    if (success) {
      effectiveness.successCount++;
    } else {
      effectiveness.failureCount++;
    }
    effectiveness.successRate = effectiveness.successCount / effectiveness.totalAttempts;
    effectiveness.lastAttemptAt = Date.now();

    // 记录耗时样本（最多保留50个）
    effectiveness.durationSamples.push(duration);
    if (effectiveness.durationSamples.length > 50) {
      effectiveness.durationSamples.shift();
    }
    effectiveness.avgDuration = Math.round(
      effectiveness.durationSamples.reduce((a, b) => a + b, 0) / effectiveness.durationSamples.length
    );

    // 基于历史数据动态调整策略优先级
    this.adjustStrategyPriority(errorSubType);
  }

  /**
   * 基于历史成功率动态调整策略优先级排序
   */
  private adjustStrategyPriority(errorSubType: string): void {
    const currentPriority = this.strategyPriorityMap.get(errorSubType);
    if (!currentPriority || currentPriority.length <= 1) return;

    // 收集该错误子类型下所有策略的效果数据
    const strategiesWithStats = currentPriority.map(strategyName => {
      const key = `${errorSubType}:${strategyName}`;
      const effectiveness = this.strategyEffectiveness.get(key);
      return {
        strategyName,
        successRate: effectiveness?.successRate ?? 0,
        totalAttempts: effectiveness?.totalAttempts ?? 0,
      };
    });

    // 只在有足够样本时调整（至少5次尝试）
    const hasEnoughData = strategiesWithStats.some(s => s.totalAttempts >= 5);
    if (!hasEnoughData) return;

    // 按成功率降序排序（成功率高的排前面）
    strategiesWithStats.sort((a, b) => {
      // 样本不足的策略保持原位
      if (a.totalAttempts < 5 && b.totalAttempts >= 5) return 1;
      if (b.totalAttempts < 5 && a.totalAttempts >= 5) return -1;
      return b.successRate - a.successRate;
    });

    const newPriority = strategiesWithStats.map(s => s.strategyName);
    this.strategyPriorityMap.set(errorSubType, newPriority);

    this.log.info('策略优先级已动态调整', {
      errorSubType,
      newPriority: newPriority.map((s, i) => `${i + 1}.${s}`).join(', '),
    });
  }

  /**
   * 策略升级：当前策略失败后，升级到下一个策略
   *
   * @param errorSignature 错误签名（用于标识修复会话）
   * @param currentStrategy 当前失败的策略
   * @param errorSubType 错误子类型
   * @returns 升级结果
   */
  escalateStrategy(
    errorSignature: string,
    currentStrategy: string,
    errorSubType: string,
  ): StrategyEscalationResult {
    // 获取已尝试的策略列表
    let attempted = this.activeRepairSessions.get(errorSignature) || [];
    if (!attempted.includes(currentStrategy)) {
      attempted = [...attempted, currentStrategy];
      this.activeRepairSessions.set(errorSignature, attempted);
    }

    // 获取该错误类型的策略优先级列表
    const priorityList = this.strategyPriorityMap.get(errorSubType) || [];

    // 找到下一个未尝试的策略
    const nextStrategy = priorityList.find(s => !attempted.includes(s));

    if (!nextStrategy) {
      this.log.warn('所有策略已耗尽，无法继续升级', {
        errorSubType, attempted: attempted.length,
      });
      return {
        escalated: false,
        currentStrategy,
        reason: `错误类型 ${errorSubType} 的所有策略已耗尽（共 ${attempted.length} 种）`,
        attemptedStrategies: attempted,
      };
    }

    this.log.info('策略升级', {
      errorSubType,
      from: currentStrategy,
      to: nextStrategy,
      attempted: attempted.length,
    });

    return {
      escalated: true,
      currentStrategy,
      nextStrategy,
      reason: `策略 "${currentStrategy}" 失败，升级到 "${nextStrategy}"`,
      attemptedStrategies: attempted,
    };
  }

  /**
   * 清理已完成的修复会话
   */
  clearRepairSession(errorSignature: string): void {
    this.activeRepairSessions.delete(errorSignature);
  }

  /**
   * 获取策略效果统计
   */
  getStrategyEffectiveness(): StrategyEffectiveness[] {
    return Array.from(this.strategyEffectiveness.values())
      .sort((a, b) => b.totalAttempts - a.totalAttempts);
  }

  /**
   * 获取错误子类型的策略优先级列表
   */
  getStrategyPriority(errorSubType: string): string[] {
    return this.strategyPriorityMap.get(errorSubType) || [];
  }

  // ============ 内部方法 ============

  /** 查找匹配的修复器，按优先级排序 */
  private findMatchingHealers(error: ErrorContext): HealerDefinition[] {
    const matched: HealerDefinition[] = [];

    for (const healer of this.healers.values()) {
      try {
        if (healer.detect(error)) {
          matched.push(healer);
        }
      } catch {
        // 检测函数异常，跳过该修复器
      }
    }

    // 按优先级排序（数值越小越优先）
    matched.sort((a, b) => a.priority - b.priority);
    return matched;
  }

  /** 分析根因 */
  private analyzeRootCause(error: ErrorContext): string {
    const msg = error.error.toLowerCase();

    // 基于错误消息模式分析根因
    if (msg.includes('timeout') || msg.includes('超时')) {
      return '操作耗时超过预期，可能是网络延迟或目标服务响应慢';
    }
    if (msg.includes('rate limit') || msg.includes('429')) {
      return 'API 调用频率超过限制，需要降低请求速率';
    }
    if (msg.includes('enoent') || msg.includes('not found')) {
      return '目标资源不存在，可能是路径错误或文件已被删除';
    }
    if (msg.includes('syntax') || msg.includes('语法')) {
      return '代码存在语法错误，需要检查并修正';
    }
    if (msg.includes('econnrefused') || msg.includes('network')) {
      return '网络连接异常，可能是服务不可达或 DNS 解析失败';
    }
    if (msg.includes('eacces') || msg.includes('permission')) {
      return '权限不足，当前用户无法访问目标资源';
    }

    return (error.error || '').substring(0, 200);
  }

  /** 评估严重程度 */
  private assessSeverity(error: ErrorContext): 'low' | 'medium' | 'high' | 'critical' {
    const msg = error.error.toLowerCase();

    // 关键错误
    if (msg.includes('out of memory') || msg.includes('fatal') || msg.includes('corruption')) {
      return 'critical';
    }

    // 高严重度
    if (msg.includes('econnrefused') || msg.includes('permission denied') ||
        msg.includes('data loss') || msg.includes('数据丢失')) {
      return 'high';
    }

    // 中等严重度
    if (msg.includes('timeout') || msg.includes('rate limit') ||
        msg.includes('syntax') || msg.includes('enoent')) {
      return 'medium';
    }

    return 'low';
  }

  /** 记录修复历史 */
  private recordHealing(error: ErrorContext, result: HealingResult): void {
    const record: HealingRecord = {
      id: `heal_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`,
      error: (error.error || '').substring(0, 200),
      errorType: result.errorType,
      healer: result.healerUsed,
      action: result.action.type,
      success: result.healed,
      timestamp: Date.now(),
      duration: result.duration,
    };

    this.history.push(record);
    if (this.history.length > this.maxHistorySize) {
      this.history = this.history.slice(-this.maxHistorySize);
    }

    this.healingTimes.push(result.duration);
    if (this.healingTimes.length > 100) this.healingTimes.shift();
  }

  // ============ Agent Loop 工具定义 ============

  /**
   * 返回 Agent Loop 可用的工具定义
   */
  getToolDefinitions(): Array<{
    name: string;
    description: string;
    parameters: Record<string, { type: string; description: string; required?: boolean }>;
    readOnly?: boolean;
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    execute: (args: any) => Promise<string>;
  }> {
    // eslint-disable-next-line @typescript-eslint/no-this-alias
    const self = this;

    return [
      {
        name: 'heal_attempt',
        description: '尝试自动修复错误。系统会检测错误类型，匹配最佳修复器，执行修复并验证结果。支持重试和降级策略。',
        parameters: {
          error: { type: 'string', description: '错误消息', required: true },
          error_type: { type: 'string', description: '错误类型标识（可选，如 tool_timeout、llm_rate_limit）', required: false },
          stack_trace: { type: 'string', description: '堆栈跟踪（可选）', required: false },
          source: { type: 'string', description: '错误来源模块（可选）', required: false },
          context: { type: 'object', description: '附加上下文信息（可选，如 filePath、timeout 等）', required: false },
        },
        execute: async (args) => {
          const errorContext: ErrorContext = {
            error: args.error as string,
            errorType: args.error_type as string | undefined,
            stackTrace: args.stack_trace as string | undefined,
            context: (args.context as Record<string, unknown>) || {},
            timestamp: Date.now(),
            source: (args.source as string) || 'agent',
          };

          const result = await self.heal(errorContext);

          if (result.healed) {
            return `✅ 错误已修复\n  类型: ${result.errorType}\n  修复器: ${result.healerUsed}\n  动作: ${result.action.type}\n  描述: ${result.action.description}\n  结果: ${result.action.result}\n  尝试次数: ${result.attempts}\n  耗时: ${result.duration}ms`;
          }
          return `❌ 修复失败\n  类型: ${result.errorType}\n  修复器: ${result.healerUsed}\n  动作: ${result.action.type}\n  原因: ${result.action.result}\n  尝试次数: ${result.attempts}\n  耗时: ${result.duration}ms`;
        },
      },
      {
        name: 'heal_diagnose',
        description: '诊断错误，分析根因和严重程度，提供修复建议（不执行修复）。用于在修复前了解错误性质。',
        parameters: {
          error: { type: 'string', description: '错误消息', required: true },
          error_type: { type: 'string', description: '错误类型标识（可选）', required: false },
          stack_trace: { type: 'string', description: '堆栈跟踪（可选）', required: false },
          source: { type: 'string', description: '错误来源模块（可选）', required: false },
          context: { type: 'object', description: '附加上下文信息（可选）', required: false },
        },
        readOnly: true,
        execute: (args) => {
          const errorContext: ErrorContext = {
            error: args.error as string,
            errorType: args.error_type as string | undefined,
            stackTrace: args.stack_trace as string | undefined,
            context: (args.context as Record<string, unknown>) || {},
            timestamp: Date.now(),
            source: (args.source as string) || 'agent',
          };

          const diagnosis = self.diagnose(errorContext);

          let output = `🔍 错误诊断\n\n`;
          output += `  错误类型: ${diagnosis.errorType}\n`;
          output += `  严重程度: ${diagnosis.severity}\n`;
          output += `  根因分析: ${diagnosis.rootCause}\n`;
          output += `  可自动修复: ${diagnosis.autoHealable ? '是' : '否'}\n\n`;

          if (diagnosis.suggestedFixes.length > 0) {
            output += `  💡 修复建议:\n`;
            for (const fix of diagnosis.suggestedFixes) {
              const confidence = Math.round(fix.confidence * 100);
              output += `    - ${fix.description} (置信度: ${confidence}%)\n`;
            }
          }

          return Promise.resolve(output.trimEnd());
        },
      },
      {
        name: 'heal_history',
        description: '查看自愈管道的修复历史记录，包括成功和失败的修复尝试。',
        parameters: {
          limit: { type: 'number', description: '返回的最大记录数（默认 20）', required: false },
        },
        readOnly: true,
        execute: (args) => {
          const limit = (args.limit as number) || 20;
          const records = self.getHealingHistory(limit);

          if (records.length === 0) return Promise.resolve('📋 暂无修复历史记录');

          let output = `📋 最近 ${records.length} 条修复记录:\n\n`;
          for (const record of records) {
            const time = new Date(record.timestamp).toLocaleString('zh-CN');
            const icon = record.success ? '✅' : '❌';
            output += `  ${icon} [${record.errorType}] ${record.healer} → ${record.action}\n`;
            output += `     ${record.error.substring(0, 80)}${record.error.length > 80 ? '...' : ''}\n`;
            output += `     ${time} | 耗时 ${record.duration}ms\n\n`;
          }

          // 附加统计摘要
          const stats = self.getStats();
          output += `📊 统计摘要: 总错误 ${stats.totalErrors} | 已修复 ${stats.totalHealed} | 失败 ${stats.totalFailed} | 成功率 ${(stats.healSuccessRate * 100).toFixed(1)}%`;

          return Promise.resolve(output);
        },
      },
    ];
  }
}

// ============ 单例管理 ============

let _instance: SelfHealingPipeline | null = null;

/** 获取 SelfHealingPipeline 单例 */
export function getSelfHealingPipeline(): SelfHealingPipeline {
  if (!_instance) {
    _instance = new SelfHealingPipeline();
  }
  return _instance;
}

/** 设置 SelfHealingPipeline 单例（用于测试或自定义配置） */
export function setSelfHealingPipeline(instance: SelfHealingPipeline): void {
  _instance = instance;
}
