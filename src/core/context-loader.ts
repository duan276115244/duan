/**
 * L0/L1/L2 分层上下文加载器 — ContextLoader
 *
 * 三层上下文加载系统，在每次 LLM 调用前动态组装 prompt。
 *
 * 分层设计：
 *   L0_SYSTEM   (~500 tokens)  — 始终加载：系统规则、身份、当前目标
 *   L1_OVERVIEW (~2000 tokens) — 条件加载：项目概览、文件树、API 签名、技能索引
 *   L2_DETAIL   (剩余预算)     — 指导 LLM 按需获取细节（read_file、recall_memory）
 *
 * 工作流程：
 *   1. 计算总预算 = modelMaxTokens - reservedForGeneration
 *   2. 分配 L0 预算 → 始终加载
 *   3. 分配 L1 预算 → 根据条件加载
 *   4. 分配工作记忆预算 → 压缩后的历史
 *   5. 分配 L2 指令预算 → 按需加载指引
 *   6. 注入 Scratchpad 事实
 *   7. 返回组装结果 + 预算明细
 *
 * Token 估算：中文约 1.5 字符/token，英文约 4 字符/token
 * 历史压缩：滑动窗口 — 保留最近 3 轮完整对话，更早的简单截断摘要
 */

import type { Scratchpad } from './scratchpad.js';
import * as fs from 'fs';
import * as path from 'path';

// ============ 类型定义 ============

/** 上下文层级 */
export enum ContextLayer {
  /** 系统层：规则、身份、当前目标（始终加载） */
  L0_SYSTEM = 'L0_SYSTEM',
  /** 概览层：项目概览、技能索引（条件加载） */
  L1_OVERVIEW = 'L1_OVERVIEW',
  /** 细节层：按需加载指引（始终加载但体积小） */
  L2_DETAIL = 'L2_DETAIL',
}

/** 层级配置 */
export interface ContextLayerConfig {
  /** 所属层级 */
  layer: ContextLayer;
  /** 该层 token 上限 */
  maxTokens: number;
  /** 优先级（数字越小越先加载） */
  priority: number;
  /** 条件函数：返回 true 时该层参与加载 */
  condition?: (task: string) => boolean;
}

/** 已注册的层级（含加载函数） */
interface RegisteredLayer {
  config: ContextLayerConfig;
  loader: () => Promise<string>;
}

/** 聊天消息（与 Scratchpad 共用接口） */
export interface ChatMessage {
  role: 'system' | 'user' | 'assistant' | 'tool';
  content: string;
}

/** 构建结果 */
export interface BuildResult {
  /** 组装后的完整 prompt */
  prompt: string;
  /** prompt 的估算 token 数 */
  totalTokens: number;
  /** 已使用的预算 */
  budgetUsed: number;
  /** 剩余预算 */
  budgetRemaining: number;
  /** 各层使用明细 */
  layers: Array<{
    layer: ContextLayer;
    tokensUsed: number;
  }>;
  /** 是否对历史进行了压缩 */
  compressionApplied: boolean;
}

// ============ 常量 ============

/** 默认 L0 预算 */
const L0_BUDGET = 500;
/** 默认 L1 预算 */
const L1_BUDGET = 2000;
/** 默认 L2 预算 */
const L2_BUDGET = 300;
/** 默认 Scratchpad 预算 */
const SCRATCHPAD_BUDGET = 400;
/** 保留最近完整对话轮数 */
const RECENT_FULL_TURNS = 3;
/** 历史摘要单条最大字符数 */
const HISTORY_SUMMARY_MAX_CHARS = 150;

// ============ 主类 ============

export class ContextLoader {
  /** 模型最大 token 数 */
  private modelMaxTokens: number;
  /** 为生成保留的 token 数 */
  private reservedForGeneration: number;
  /** 已注册的层级 */
  private layers: RegisteredLayer[] = [];
  /** 项目根目录（用于加载 L1 项目概览） */
  private projectRoot: string;
  /** L1 项目概览缓存（避免每次调用都读文件系统） */
  private l1Cache: string | null = null;
  /** L1 缓存时间戳 */
  private l1CacheTime: number = 0;
  /** L1 缓存有效期（5分钟） */
  private static readonly L1_CACHE_TTL = 5 * 60 * 1000;
  /** 外部系统提示提供者（由 PromptOrchestrator 注入，避免 L0 内容重复） */
  private systemPromptProvider: (() => Promise<string>) | null = null;

  constructor(modelMaxTokens: number, reservedForGeneration: number = 4000, projectRoot?: string) {
    this.modelMaxTokens = modelMaxTokens;
    this.reservedForGeneration = reservedForGeneration;
    this.projectRoot = projectRoot || process.cwd();

    // 注册默认层级
    this.registerDefaultLayers();
  }

  /**
   * 注入外部系统提示提供者（通常是 PromptOrchestrator.orchestrate）
   * 设置后，L0_SYSTEM 层将使用此提供者的输出，而非内置的硬编码身份。
   */
  setSystemPromptProvider(provider: () => Promise<string>): void {
    this.systemPromptProvider = provider;
  }

  // ========== 核心 API ==========

  /**
   * 注册一个上下文层级及其加载函数
   */
  registerLayer(config: ContextLayerConfig, loader: () => Promise<string>): void {
    // 如果同层级已注册，替换
    const existingIdx = this.layers.findIndex(l => l.config.layer === config.layer);
    const entry: RegisteredLayer = { config, loader };

    if (existingIdx >= 0) {
      this.layers[existingIdx] = entry;
    } else {
      this.layers.push(entry);
    }

    // 按优先级排序
    this.layers.sort((a, b) => a.config.priority - b.config.priority);
  }

  /**
   * 构建上下文：主方法
   *
   * 按层级加载内容，在 token 预算内组装 prompt，注入 scratchpad 事实和压缩历史
   */
  async buildContext(
    task: string,
    history: ChatMessage[],
    scratchpad: Scratchpad,
  ): Promise<BuildResult> {
    const totalBudget = this.modelMaxTokens - this.reservedForGeneration;
    const layerDetails: Array<{ layer: ContextLayer; tokensUsed: number }> = [];
    const parts: string[] = [];
    let budgetUsed = 0;

    // ---- 1. 加载各层级内容 ----
    for (const registered of this.layers) {
      const { config, loader } = registered;

      // 检查条件
      if (config.condition && !config.condition(task)) {
        layerDetails.push({ layer: config.layer, tokensUsed: 0 });
        continue;
      }

      // 计算该层可用预算
      const remainingBudget = totalBudget - budgetUsed;
      const layerBudget = Math.min(config.maxTokens, remainingBudget);

      if (layerBudget <= 0) {
        layerDetails.push({ layer: config.layer, tokensUsed: 0 });
        continue;
      }

      // 加载内容
      let content: string;
      try {
        content = await loader();
      } catch {
        content = '';
      }

      // 如果内容超过预算，截断
      const contentTokens = this.estimateStringTokens(content);
      if (contentTokens > layerBudget) {
        content = this.truncateToTokenBudget(content, layerBudget);
      }

      const actualTokens = this.estimateStringTokens(content);

      if (content.trim()) {
        parts.push(content);
        budgetUsed += actualTokens;
      }

      layerDetails.push({ layer: config.layer, tokensUsed: actualTokens });
    }

    // ---- 2. 注入 Scratchpad 事实 ----
    const scratchpadRemaining = totalBudget - budgetUsed;
    const scratchpadBudget = Math.min(SCRATCHPAD_BUDGET, scratchpadRemaining);

    if (scratchpadBudget > 0) {
      const scratchpadText = scratchpad.formatForPrompt(scratchpadBudget);
      const scratchpadTokens = this.estimateStringTokens(scratchpadText);

      if (scratchpadText && scratchpadTokens <= scratchpadBudget) {
        parts.push(scratchpadText);
        budgetUsed += scratchpadTokens;
      } else if (scratchpadText) {
        // 截断到预算内
        const truncated = this.truncateToTokenBudget(scratchpadText, scratchpadBudget);
        const truncatedTokens = this.estimateStringTokens(truncated);
        parts.push(truncated);
        budgetUsed += truncatedTokens;
      }
    }

    // ---- 3. 压缩历史并注入 ----
    const historyRemaining = totalBudget - budgetUsed;
    let compressionApplied = false;

    if (historyRemaining > 0 && history.length > 0) {
      const { text, tokens, compressed } = this.compressHistory(history, historyRemaining);
      compressionApplied = compressed;

      if (text && tokens <= historyRemaining) {
        parts.push(text);
        budgetUsed += tokens;
      } else if (text) {
        // 截断到剩余预算
        const truncated = this.truncateToTokenBudget(text, historyRemaining);
        const truncatedTokens = this.estimateStringTokens(truncated);
        parts.push(truncated);
        budgetUsed += truncatedTokens;
      }
    }

    // ---- 4. 组装结果 ----
    const prompt = parts.filter(p => p.trim()).join('\n\n');
    const totalTokens = this.estimateStringTokens(prompt);

    return {
      prompt,
      totalTokens,
      budgetUsed,
      budgetRemaining: Math.max(0, totalBudget - budgetUsed),
      layers: layerDetails,
      compressionApplied,
    };
  }

  // ========== 私有方法 ==========

  /**
   * 注册默认层级
   */
  private registerDefaultLayers(): void {
    // L0: 系统规则 + 身份 + 当前目标（始终加载）
    this.registerLayer(
      {
        layer: ContextLayer.L0_SYSTEM,
        maxTokens: L0_BUDGET,
        priority: 1,
        // L0 始终加载，无条件
      },
      async () => {
        // 优先使用外部系统提示提供者（PromptOrchestrator），避免身份/规则重复
        if (this.systemPromptProvider) {
          try {
            const prompt = await this.systemPromptProvider();
            if (prompt && prompt.trim()) return prompt;
          } catch {}
        }
        // 降级：内置基础系统规则（仅在外部提供者未设置时使用）
        return [
          '[系统规则]',
          '你是段先生，一个智能助手。',
          '- 遵循用户指令，不超出范围',
          '- 优先使用工具获取信息，而非猜测',
          '- 代码修改前先理解上下文',
          '- 关键操作需确认后再执行',
        ].join('\n');
      },
    );

    // L1: 项目概览 + 技能索引（代码相关或复杂任务时加载）
    this.registerLayer(
      {
        layer: ContextLayer.L1_OVERVIEW,
        maxTokens: L1_BUDGET,
        priority: 2,
        condition: (task: string) => {
          // 代码相关或复杂任务时加载
          const codeKeywords = ['代码', '函数', '文件', '项目', '开发', '调试', '重构', 'code', 'debug', 'refactor', 'implement', 'fix', 'build'];
          const complexKeywords = ['分析', '设计', '架构', '规划', '比较', '评估', 'analyze', 'design', 'architect', 'plan', 'compare'];
          const allKeywords = [...codeKeywords, ...complexKeywords];
          return allKeywords.some(kw => task.toLowerCase().includes(kw));
        },
      },
      () => this.loadProjectOverview(),
    );

    // L2: 按需加载指引（始终加载但体积小）
    this.registerLayer(
      {
        layer: ContextLayer.L2_DETAIL,
        maxTokens: L2_BUDGET,
        priority: 3,
        // L2 始终加载
      },
      () => Promise.resolve([
          '[按需获取细节]',
          '当你需要更多信息时，使用以下方式：',
          '- read_file(path) — 读取文件内容',
          '- recall_memory(query) — 回忆相关记忆',
          '- search_codebase(query) — 搜索代码库',
          '- list_directory(path) — 列出目录内容',
          '不要猜测文件内容，先读取再操作。',
        ].join('\n')),
    );
  }

  /**
   * 加载项目概览（L1 层）
   * 从实际文件系统读取项目信息：package.json、目录结构、技能索引
   * 结果缓存 5 分钟，避免频繁 IO
   */
  private async loadProjectOverview(): Promise<string> {
    // 检查缓存是否有效
    const now = Date.now();
    if (this.l1Cache !== null && (now - this.l1CacheTime) < ContextLoader.L1_CACHE_TTL) {
      return this.l1Cache;
    }

    const parts: string[] = ['[项目概览]'];

    try {
      // 1. 读取 package.json 获取项目基本信息
      const pkgPath = path.join(this.projectRoot, 'package.json');
      if (await this.pathExists(pkgPath)) {
        try {
          const pkg = JSON.parse(await fs.promises.readFile(pkgPath, 'utf-8'));
          parts.push(`项目: ${pkg.name || 'unknown'} v${pkg.version || '0.0.0'}`);
          if (pkg.description) parts.push(`描述: ${pkg.description}`);
          if (pkg.scripts && Object.keys(pkg.scripts).length > 0) {
            const scripts = Object.entries(pkg.scripts)
              .slice(0, 8)
              .map(([k, v]) => `  ${k}: ${String(v).substring(0, 60)}`)
              .join('\n');
            parts.push(`常用脚本:\n${scripts}`);
          }
          if (pkg.dependencies && Object.keys(pkg.dependencies).length > 0) {
            const depCount = Object.keys(pkg.dependencies).length;
            const keyDeps = Object.keys(pkg.dependencies).slice(0, 10).join(', ');
            parts.push(`依赖 (${depCount}): ${keyDeps}${depCount > 10 ? '...' : ''}`);
          }
        } catch {}
      }

      // 2. 列出顶层目录结构（最多 20 项，跳过 node_modules/.git）
      try {
        const entries = await fs.promises.readdir(this.projectRoot, { withFileTypes: true });
        const skipDirs = new Set(['node_modules', '.git', 'dist', 'build', '.cache', 'coverage']);
        const topItems = entries
          .filter(e => !skipDirs.has(e.name) && !e.name.startsWith('.'))
          .slice(0, 20)
          .map(e => e.isDirectory() ? `${e.name}/` : e.name)
          .sort();
        if (topItems.length > 0) {
          parts.push(`目录结构:\n  ${topItems.join('\n  ')}`);
        }
      } catch {}

      // 3. 列出 src/core 下的核心模块（如果存在）
      try {
        const coreDir = path.join(this.projectRoot, 'src', 'core');
        if (await this.pathExists(coreDir)) {
          const coreFiles = (await fs.promises.readdir(coreDir))
            .filter(f => f.endsWith('.ts') || f.endsWith('.js'))
            .slice(0, 15)
            .map(f => f.replace(/\.(ts|js)$/, ''))
            .sort();
          if (coreFiles.length > 0) {
            parts.push(`核心模块: ${coreFiles.join(', ')}`);
          }
        }
      } catch {}

      // 4. 列出可用技能（从 skills/ 目录或 .awareness/skills/）
      try {
        const skillsDir = path.join(this.projectRoot, 'skills');
        const awarenessSkillsDir = path.join(this.projectRoot, '.awareness', 'skills');
        const skills: string[] = [];
        for (const dir of [skillsDir, awarenessSkillsDir]) {
          if (await this.pathExists(dir)) {
            const items = (await fs.promises.readdir(dir))
              .filter(f => f.endsWith('.md') || f.endsWith('.json') || f.endsWith('.yaml'))
              .slice(0, 10);
            for (const item of items) {
              skills.push(item.replace(/\.(md|json|yaml)$/i, ''));
            }
          }
        }
        if (skills.length > 0) {
          parts.push(`可用技能: ${[...new Set(skills)].join(', ')}`);
        }
      } catch {}

      // 5. 列出 SubAgent 配置（从 agents/ 目录）
      try {
        const agentsDir = path.join(this.projectRoot, 'agents');
        if (await this.pathExists(agentsDir)) {
          const agents = (await fs.promises.readdir(agentsDir))
            .filter(f => f.endsWith('.md'))
            .map(f => f.replace(/\.md$/i, ''));
          if (agents.length > 0) {
            parts.push(`SubAgent: ${agents.join(', ')}`);
          }
        }
      } catch {}
    } catch {
      // 任何异常都降级为基础信息
    }

    // 如果什么都没读到，返回基础信息
    if (parts.length <= 1) {
      parts.push('可用能力：代码编辑、文件操作、Shell 执行、网页搜索、桌面控制、语音交互。');
    }

    const result = parts.join('\n');
    // 更新缓存
    this.l1Cache = result;
    this.l1CacheTime = now;
    return result;
  }

  /** 异步检查路径是否存在（替代 fs.existsSync） */
  private async pathExists(p: string): Promise<boolean> {
    try {
      await fs.promises.access(p);
      return true;
    } catch {
      return false;
    }
  }

  /**
   * 压缩历史：滑动窗口策略
   * - 保留最近 RECENT_FULL_TURNS 轮完整对话
   * - 更早的对话简单截断摘要
   */
  private compressHistory(
    messages: ChatMessage[],
    tokenBudget: number,
  ): { text: string; tokens: number; compressed: boolean } {
    if (messages.length === 0) {
      return { text: '', tokens: 0, compressed: false };
    }

    // 将消息按"轮"分组（user+assistant 为一轮）
    const turns: ChatMessage[][] = [];
    let currentTurn: ChatMessage[] = [];

    for (const msg of messages) {
      currentTurn.push(msg);
      if (msg.role === 'assistant') {
        turns.push(currentTurn);
        currentTurn = [];
      }
    }
    // 处理最后一轮（可能没有 assistant 回复）
    if (currentTurn.length > 0) {
      turns.push(currentTurn);
    }

    // 分离最近轮次和更早轮次
    const recentTurns = turns.slice(-RECENT_FULL_TURNS);
    const olderTurns = turns.slice(0, Math.max(0, turns.length - RECENT_FULL_TURNS));

    // 先构建最近轮次的完整文本
    const recentText = recentTurns
      .flat()
      .map(m => `[${m.role}]: ${m.content}`)
      .join('\n');

    const recentTokens = this.estimateStringTokens(recentText);

    // 如果最近轮次已经超过预算，只保留最近轮次并截断
    if (recentTokens >= tokenBudget) {
      const truncated = this.truncateToTokenBudget(recentText, tokenBudget);
      return {
        text: '[对话历史]\n' + truncated,
        tokens: this.estimateStringTokens(truncated),
        compressed: true,
      };
    }

    // 如果没有更早的轮次，直接返回
    if (olderTurns.length === 0) {
      return {
        text: '[对话历史]\n' + recentText,
        tokens: recentTokens,
        compressed: false,
      };
    }

    // 为更早轮次生成简单截断摘要
    const summaryBudget = tokenBudget - recentTokens;
    const summaryParts: string[] = ['[早期对话摘要]'];

    let summaryUsed = this.estimateStringTokens(summaryParts[0]);

    for (const turn of olderTurns) {
      // 每轮摘要：取用户消息的前 N 字符
      const userMsg = turn.find(m => m.role === 'user');
      if (!userMsg) continue;

      const summaryLine = `- ${userMsg.content.substring(0, HISTORY_SUMMARY_MAX_CHARS)}${userMsg.content.length > HISTORY_SUMMARY_MAX_CHARS ? '...' : ''}`;
      const lineTokens = this.estimateStringTokens(summaryLine);

      if (summaryUsed + lineTokens > summaryBudget) break;

      summaryParts.push(summaryLine);
      summaryUsed += lineTokens;
    }

    const fullText = summaryParts.join('\n') + '\n\n[最近对话]\n' + recentText;
    const fullTokens = this.estimateStringTokens(fullText);

    return {
      text: '[对话历史]\n' + fullText,
      tokens: fullTokens,
      compressed: true,
    };
  }

  /**
   * 截断文本到指定 token 预算内
   * 优先保留头部内容
   */
  private truncateToTokenBudget(text: string, budget: number): string {
    if (this.estimateStringTokens(text) <= budget) return text;

    // 二分查找截断点
    let low = 0;
    let high = text.length;
    let best = 0;

    while (low <= high) {
      const mid = Math.floor((low + high) / 2);
      const tokens = this.estimateStringTokens(text.substring(0, mid));

      if (tokens <= budget) {
        best = mid;
        low = mid + 1;
      } else {
        high = mid - 1;
      }
    }

    return text.substring(0, best) + '...';
  }

  /**
   * 估算字符串的 token 数
   * 中文约 1.5 字符/token，英文约 4 字符/token
   */
  private estimateStringTokens(text: string): number {
    let chineseChars = 0;
    let otherChars = 0;

    for (const char of text) {
      if (/[\u4e00-\u9fff\u3400-\u4dbf\u3040-\u309f\u30a0-\u30ff\uac00-\ud7af]/.test(char)) {
        chineseChars++;
      } else {
        otherChars++;
      }
    }

    return Math.ceil(chineseChars / 1.5 + otherChars / 4);
  }
}
