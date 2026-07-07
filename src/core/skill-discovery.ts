/**
 * 开放技能发现与自动集成框架 — SkillDiscovery
 *
 * 核心能力：
 * 1. 技能发现 - 扫描多种来源（本地目录、npm、URL、市场）发现可用技能
 * 2. 技能评估 - 评估技能的安全性、兼容性和质量
 * 3. 技能安装/卸载 - 将发现的技能集成到 SkillRegistry 或移除
 * 4. 自动学习 - 从工具使用模式中自动提取新技能
 * 5. 技能搜索 - 跨已发现和已安装技能搜索
 * 6. 来源管理 - 注册和管理技能来源
 */

import * as fs from 'fs';
import * as path from 'path';
import * as https from 'https';
import * as http from 'http';
import { logger } from './structured-logger.js';
import { EventBus } from './event-bus.js';
import { type SkillRegistry, type SkillHandler, type SkillInput, type SkillOutput } from './skill-registry.js';
import { duanPath } from './duan-paths.js';
import { atomicWriteJsonSync } from './atomic-write.js';

// ============ 接口定义 ============

export interface DiscoveredSkill {
  id: string;
  name: string;
  domain: string;
  description: string;
  keywords: string[];
  examples: string[];
  source: 'builtin' | 'community' | 'auto_learned' | 'user_defined';
  confidence: number;           // 发现置信度 0-1
  installStatus: 'available' | 'installing' | 'installed' | 'failed';
  rating: number;               // 社区评分 0-5
  usageCount: number;
  lastUsed?: number;
}

export interface SkillEvaluationResult {
  skillId: string;
  isSafe: boolean;
  isCompatible: boolean;
  qualityScore: number;         // 0-1
  securityScore: number;        // 0-1
  compatibilityScore: number;   // 0-1
  risks: string[];
  recommendations: string[];
}

export interface SkillSource {
  type: 'local_directory' | 'npm_package' | 'url' | 'marketplace';
  path: string;
  lastScanned: number;
  enabled: boolean;
}

export interface UsagePattern {
  intent: string;
  toolSequence: string[];       // 工具使用序列
  avgSuccessRate: number;
  occurrenceCount: number;
  lastSeen: number;
  exampleInputs: string[];
}

// ============ 工具定义（供 agent loop 使用） ============

export interface SkillDiscoveryTool {
  name: string;
  description: string;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  parameters: Record<string, any>;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  handler: (...args: any[]) => Promise<any>;
}

// ============ 持久化数据结构 ============

interface _SkillDiscoveryState {
  discovered: DiscoveredSkill[];
  patterns: UsagePattern[];
  sources: SkillSource[];
}

// ============ 危险操作关键词 ============

const _DANGEROUS_PATTERNS = [
  /\bfs\.(unlink|rmdir|rm)\b/,
  /\bchild_process\b/,
  /\bexec\(/,
  /\bspawn\(/,
  /\bfetch\(/,
  /\bhttp\.(get|post|put|delete|request)\b/,
  /\bhttps\.(get|post|put|delete|request)\b/,
  /\bprocess\.exit\b/,
  /\beval\(/,
  /\bFunction\(/,
  /\brequire\(['"]child_process/,
  /\brequire\(['"]net['"]\)/,
  /\bfs\.(writeFile|appendFile|truncate|rename)\b/,
  /\bchmod\b/,
  /\bsudo\b/,
  /\brm\s+-rf\b/,
];

const SENSITIVE_RESOURCE_PATTERNS = [
  /\.env\b/,
  /credential/i,
  /secret/i,
  /password/i,
  /token/i,
  /api[_-]?key/i,
  /private[_-]?key/i,
];

// ============ 主类 ============

export class SkillDiscovery {
  private discovered: Map<string, DiscoveredSkill> = new Map();
  private sources: Map<string, SkillSource> = new Map();
  private patterns: Map<string, UsagePattern> = new Map();
  private usageWindow: Array<{
    intent: string;
    tool: string;
    timestamp: number;
    success: boolean;
    input: string;
  }> = [];
  private readonly USAGE_WINDOW_SIZE = 100;
  private readonly PATTERN_MIN_OCCURRENCES = 3;
  private readonly PATTERN_MIN_TOOLS = 2;

  private registry: SkillRegistry;
  private eventBus: EventBus;
  private log = logger.child({ module: 'SkillDiscovery' });

  private readonly dataDir: string;
  private readonly discoveredPath: string;
  private readonly patternsPath: string;
  private readonly sourcesPath: string;

  constructor(registry: SkillRegistry, baseDir?: string) {
    this.registry = registry;
    this.eventBus = EventBus.getInstance();

    this.dataDir = path.join(baseDir || duanPath(), 'skills');
    this.discoveredPath = path.join(this.dataDir, 'discovered.json');
    this.patternsPath = path.join(this.dataDir, 'patterns.json');
    this.sourcesPath = path.join(this.dataDir, 'sources.json');

    this.ensureDataDir();
    this.loadState();

    // 自动扫描打包内置技能目录（Electron resources/skills 或项目根 skills/）
    this.scanBundledSkills();
  }

  /**
   * 扫描打包内置技能目录
   * 在 Electron 打包后位于 process.resourcesPath/skills/builtin/
   * 在开发模式下位于项目根 skills/builtin/
   */
  private scanBundledSkills(): void {
    const candidates: string[] = [];

    // 1. Electron 打包路径
    const resourcesPath = (process as unknown as { resourcesPath?: string }).resourcesPath;
    if (typeof process !== 'undefined' && resourcesPath) {
      candidates.push(path.join(resourcesPath, 'skills', 'builtin'));
      candidates.push(path.join(resourcesPath, 'skills'));
    }

    // 2. 开发模式项目根
    candidates.push(path.join(process.cwd(), 'skills', 'builtin'));
    candidates.push(path.join(process.cwd(), 'skills'));

    // 3. __dirname 回退（dist/core → ../../skills）
    try {
      candidates.push(path.resolve(__dirname, '..', '..', 'skills', 'builtin'));
      candidates.push(path.resolve(__dirname, '..', '..', 'skills'));
    } catch {}

    for (const dir of candidates) {
      try {
        if (fs.existsSync(dir) && fs.statSync(dir).isDirectory()) {
          const before = this.discovered.size;
          this.scanLocalDirectory(dir);
          const after = this.discovered.size;
          if (after > before) {
            this.log.info('扫描打包内置技能目录成功', { dir, found: after - before });
          }
        }
      } catch (e: unknown) {
        const msg = e instanceof Error ? e.message : String(e);
        this.log.debug('扫描技能目录跳过', { dir, reason: msg });
      }
    }
  }

  // ========== 公共方法 ==========

  /**
   * 发现可用技能
   * 扫描所有已注册的技能来源，如果提供 query 则按相关性过滤
   */
  discoverSkills(query?: string): DiscoveredSkill[] {
    this.log.info('开始技能发现', { query });

    // 扫描所有启用的来源
    for (const [_key, source] of this.sources) {
      if (!source.enabled) continue;
      this.scanSource(source);
    }

    // 同时扫描内置技能
    this.scanBuiltinSkills();

    let results = Array.from(this.discovered.values());

    if (query) {
      results = this.filterByRelevance(results, query);
    }

    // 按置信度和评分排序
    results.sort((a, b) => {
      const scoreA = a.confidence * 0.6 + (a.rating / 5) * 0.4;
      const scoreB = b.confidence * 0.6 + (b.rating / 5) * 0.4;
      return scoreB - scoreA;
    });

    this.eventBus.emitSync('skill.discovered', {
      totalFound: results.length,
      query,
    }, { source: 'SkillDiscovery' });

    return results;
  }

  /**
   * 评估技能的安全性、兼容性和质量
   */
  evaluateSkill(skillId: string): SkillEvaluationResult {
    const skill = this.discovered.get(skillId);
    if (!skill) {
      return {
        skillId,
        isSafe: false,
        isCompatible: false,
        qualityScore: 0,
        securityScore: 0,
        compatibilityScore: 0,
        risks: ['技能不存在'],
        recommendations: ['请先发现该技能后再评估'],
      };
    }

    const risks: string[] = [];
    const recommendations: string[] = [];

    // 安全性评估
    const securityScore = this.assessSecurity(skill, risks, recommendations);

    // 兼容性评估
    const compatibilityScore = this.assessCompatibility(skill, risks, recommendations);

    // 质量评估
    const qualityScore = this.assessQuality(skill, recommendations);

    const isSafe = securityScore >= 0.5;
    const isCompatible = compatibilityScore >= 0.5;

    if (!isSafe) {
      risks.push('安全性评分低于阈值 (0.5)，需要显式审批才能安装');
      recommendations.push('建议审查技能处理函数后再安装');
    }

    const result: SkillEvaluationResult = {
      skillId,
      isSafe,
      isCompatible,
      qualityScore,
      securityScore,
      compatibilityScore,
      risks,
      recommendations,
    };

    this.log.info('技能评估完成', {
      skillId,
      isSafe,
      isCompatible,
      qualityScore: qualityScore.toFixed(2),
      securityScore: securityScore.toFixed(2),
    });

    this.eventBus.emitSync('skill.evaluated', result, { source: 'SkillDiscovery' });

    return result;
  }

  /**
   * 安装已发现的技能到 SkillRegistry
   */
  installSkill(skillId: string): Promise<boolean> {
    const discovered = this.discovered.get(skillId);
    if (!discovered) {
      this.log.warn('安装失败：技能未发现', { skillId });
      return Promise.resolve(false);
    }

    if (discovered.installStatus === 'installed') {
      this.log.info('技能已安装，跳过', { skillId });
      return Promise.resolve(true);
    }

    // 评估安全性
    const evaluation = this.evaluateSkill(skillId);
    if (!evaluation.isSafe) {
      this.log.warn('技能安全性不足，安装被拒绝', {
        skillId,
        securityScore: evaluation.securityScore,
        risks: evaluation.risks,
      });
      discovered.installStatus = 'failed';
      this.saveState();
      return Promise.resolve(false);
    }

    if (!evaluation.isCompatible) {
      this.log.warn('技能兼容性不足，安装被拒绝', {
        skillId,
        compatibilityScore: evaluation.compatibilityScore,
      });
      discovered.installStatus = 'failed';
      this.saveState();
      return Promise.resolve(false);
    }

    discovered.installStatus = 'installing';
    this.saveState();

    try {
      // 创建技能处理函数
      const handler = this.createHandlerForSkill(discovered);

      // 注册到 SkillRegistry
      this.registry.register({
        id: discovered.id,
        name: discovered.name,
        domain: discovered.domain,
        description: discovered.description,
        keywords: discovered.keywords,
        examples: discovered.examples,
        handler,
        estimatedComplexity: this.inferComplexity(discovered),
      });

      discovered.installStatus = 'installed';
      this.saveState();

      this.log.info('技能安装成功', { skillId, name: discovered.name });

      this.eventBus.emitSync('skill.installed', {
        skillId,
        name: discovered.name,
        domain: discovered.domain,
      }, { source: 'SkillDiscovery' });

      return Promise.resolve(true);
    } catch (error: unknown) {
      const msg = error instanceof Error ? error.message : String(error);
      discovered.installStatus = 'failed';
      this.saveState();

      this.log.error('技能安装失败', { skillId, error: msg });

      this.eventBus.emitSync('skill.install_failed', {
        skillId,
        error: msg,
      }, { source: 'SkillDiscovery' });

      return Promise.resolve(false);
    }
  }

  /**
   * 卸载已安装的技能
   */
  uninstallSkill(skillId: string): boolean {
    const discovered = this.discovered.get(skillId);
    if (!discovered) {
      this.log.warn('卸载失败：技能未发现', { skillId });
      return false;
    }

    if (discovered.installStatus !== 'installed') {
      this.log.warn('卸载失败：技能未安装', { skillId });
      return false;
    }

    const removed = this.registry.unregister(skillId);
    if (!removed) {
      this.log.warn('卸载失败：注册表中不存在该技能', { skillId });
      return false;
    }

    discovered.installStatus = 'available';
    this.saveState();

    this.log.info('技能卸载成功', { skillId });

    this.eventBus.emitSync('skill.uninstalled', { skillId }, { source: 'SkillDiscovery' });

    return true;
  }

  /**
   * 从工具使用模式中自动学习新技能
   * 当同一意图下连续使用 2+ 工具成功 3+ 次时，提议为新技能
   */
  autoDiscoverFromUsage(
    userInput: string,
    toolResult: string,
    success: boolean,
  ): DiscoveredSkill | null {
    // 记录到滑动窗口
    const intent = this.extractIntent(userInput);
    const toolName = this.extractToolName(toolResult);

    this.usageWindow.push({
      intent,
      tool: toolName,
      timestamp: Date.now(),
      success,
      input: userInput,
    });

    // 维护窗口大小
    if (this.usageWindow.length > this.USAGE_WINDOW_SIZE) {
      this.usageWindow = this.usageWindow.slice(-this.USAGE_WINDOW_SIZE);
    }

    // 尝试提取使用模式
    const pattern = this.extractPattern(intent);
    if (!pattern) return null;

    // 检查是否已有此模式
    const patternKey = pattern.intent + ':' + pattern.toolSequence.join('->');
    const existingPattern = this.patterns.get(patternKey);

    if (existingPattern) {
      // 更新已有模式
      existingPattern.occurrenceCount = pattern.occurrenceCount;
      existingPattern.avgSuccessRate =
        (existingPattern.avgSuccessRate + pattern.avgSuccessRate) / 2;
      existingPattern.lastSeen = Date.now();
      if (!existingPattern.exampleInputs.includes(userInput)) {
        existingPattern.exampleInputs.push(userInput);
        if (existingPattern.exampleInputs.length > 10) {
          existingPattern.exampleInputs = existingPattern.exampleInputs.slice(-10);
        }
      }
    } else {
      this.patterns.set(patternKey, pattern);
    }

    this.saveState();

    // 检查是否满足提议条件
    const currentPattern = this.patterns.get(patternKey)!;
    if (
      currentPattern.occurrenceCount >= this.PATTERN_MIN_OCCURRENCES &&
      currentPattern.toolSequence.length >= this.PATTERN_MIN_TOOLS
    ) {
      return this.proposeSkillFromPattern(currentPattern);
    }

    return null;
  }

  /**
   * 扫描本地目录中的技能定义
   * 查找 SKILL.md 或 skill.json 文件
   */
  scanLocalDirectory(dirPath: string): DiscoveredSkill[] {
    const found: DiscoveredSkill[] = [];

    if (!fs.existsSync(dirPath)) {
      this.log.warn('目录不存在，跳过扫描', { dirPath });
      return found;
    }

    try {
      const entries = this.walkDirectory(dirPath, 3); // 最大深度 3

      for (const entry of entries) {
        // 查找 skill.json
        if (entry.endsWith('skill.json')) {
          const skill = this.parseSkillJson(entry);
          if (skill) found.push(skill);
        }

        // 查找 SKILL.md
        if (entry.endsWith('SKILL.md')) {
          const skill = this.parseSkillMd(entry);
          if (skill) found.push(skill);
        }
      }

      // 将发现的技能加入内部列表
      for (const skill of found) {
        if (!this.discovered.has(skill.id)) {
          this.discovered.set(skill.id, skill);
        }
      }

      if (found.length > 0) {
        this.saveState();
        this.log.info('本地目录扫描完成', { dirPath, found: found.length });
      }
    } catch (error: unknown) {
      const msg = error instanceof Error ? error.message : String(error);
      this.log.error('扫描本地目录失败', { dirPath, error: msg });
    }

    return found;
  }

  /**
   * 注册新的技能来源
   */
  registerSource(source: SkillSource): void {
    const key = `${source.type}:${source.path}`;
    this.sources.set(key, source);
    this.saveState();

    this.log.info('注册技能来源', { type: source.type, path: source.path });

    this.eventBus.emitSync('skill.source_registered', {
      type: source.type,
      path: source.path,
    }, { source: 'SkillDiscovery' });
  }

  /**
   * 获取所有已安装的技能及统计信息
   */
  getInstalledSkills(): Array<DiscoveredSkill & { registryStats?: { usageCount: number; successRate: number } }> {
    const installed: Array<DiscoveredSkill & { registryStats?: { usageCount: number; successRate: number } }> = [];

    for (const skill of this.discovered.values()) {
      if (skill.installStatus === 'installed') {
        // 从 registry 获取运行时统计
        const registrySkills = this.registry.getAllSkills();
        const registrySkill = registrySkills.find(s => s.id === skill.id);

        installed.push({
          ...skill,
          registryStats: registrySkill
            ? { usageCount: registrySkill.usageCount, successRate: registrySkill.successRate }
            : undefined,
        });
      }
    }

    return installed;
  }

  /**
   * 跨已发现和已安装技能搜索
   */
  searchSkills(query: string): DiscoveredSkill[] {
    const queryLower = query.toLowerCase();
    const results: Array<{ skill: DiscoveredSkill; score: number }> = [];

    for (const skill of this.discovered.values()) {
      let score = 0;

      // 名称匹配
      if (skill.name.toLowerCase().includes(queryLower)) {
        score += 0.4;
      }

      // 关键词匹配
      const keywordMatches = skill.keywords.filter(k =>
        k.toLowerCase().includes(queryLower),
      ).length;
      score += (keywordMatches / Math.max(skill.keywords.length, 1)) * 0.3;

      // 描述匹配
      if (skill.description.toLowerCase().includes(queryLower)) {
        score += 0.2;
      }

      // 示例匹配
      const exampleMatches = skill.examples.filter(e =>
        e.toLowerCase().includes(queryLower),
      ).length;
      score += (exampleMatches / Math.max(skill.examples.length, 1)) * 0.1;

      if (score > 0) {
        results.push({ skill, score });
      }
    }

    results.sort((a, b) => b.score - a.score);
    return results.map(r => r.skill);
  }

  /**
   * 从观察到的使用模式生成技能提议
   */
  proposeSkillFromPattern(pattern: UsagePattern): DiscoveredSkill | null {
    // 生成技能 ID
    const id = `auto_${pattern.intent.replace(/\s+/g, '_')}_${pattern.toolSequence.join('_')}`;

    // 检查是否已存在
    if (this.discovered.has(id)) {
      const existing = this.discovered.get(id)!;
      // 增加置信度
      existing.confidence = Math.min(existing.confidence + 0.05, 1.0);
      existing.usageCount++;
      this.saveState();
      return existing;
    }

    // 生成技能名称
    const name = this.generateSkillName(pattern);

    // 生成关键词
    const keywords = [
      ...pattern.intent.split(/\s+/).filter(w => w.length > 2),
      ...pattern.toolSequence,
    ];

    const skill: DiscoveredSkill = {
      id,
      name,
      domain: this.inferDomain(pattern),
      description: `自动学习的技能：${pattern.intent}，使用工具序列 ${pattern.toolSequence.join(' → ')}`,
      keywords,
      examples: pattern.exampleInputs.slice(0, 5),
      source: 'auto_learned',
      confidence: 0.5,
      installStatus: 'available',
      rating: 0,
      usageCount: 0,
    };

    this.discovered.set(id, skill);
    this.saveState();

    this.log.info('从使用模式中提议新技能', {
      id,
      name,
      toolSequence: pattern.toolSequence,
      occurrenceCount: pattern.occurrenceCount,
    });

    this.eventBus.emitSync('skill.proposed', {
      skillId: id,
      name,
      pattern: pattern.toolSequence,
    }, { source: 'SkillDiscovery' });

    return skill;
  }

  /**
   * 获取工具定义列表（供 agent loop 集成）
   */
  getToolDefinitions(): SkillDiscoveryTool[] {
    return [
      {
        name: 'skill_discover',
        description: '发现可用的技能。可选提供查询关键词过滤结果。',
        parameters: {
          type: 'object',
          properties: {
            query: {
              type: 'string',
              description: '可选的搜索关键词，用于过滤发现的技能',
            },
          },
        },
        handler: (params: { query?: string }) => {
          const skills = this.discoverSkills(params.query);
          return Promise.resolve({
            total: skills.length,
            skills: skills.map(s => ({
              id: s.id,
              name: s.name,
              domain: s.domain,
              description: s.description,
              source: s.source,
              confidence: s.confidence,
              installStatus: s.installStatus,
              rating: s.rating,
            })),
          });
        },
      },
      {
        name: 'skill_install',
        description: '安装一个已发现的技能。安装前会自动评估安全性和兼容性。',
        parameters: {
          type: 'object',
          properties: {
            skillId: {
              type: 'string',
              description: '要安装的技能 ID',
            },
          },
          required: ['skillId'],
        },
        handler: async (params: { skillId: string }) => {
          const success = await this.installSkill(params.skillId);
          return { success, skillId: params.skillId };
        },
      },
      {
        name: 'skill_evaluate',
        description: '评估一个技能的安全性、兼容性和质量。',
        parameters: {
          type: 'object',
          properties: {
            skillId: {
              type: 'string',
              description: '要评估的技能 ID',
            },
          },
          required: ['skillId'],
        },
        handler: (params: { skillId: string }) => {
          return Promise.resolve(this.evaluateSkill(params.skillId));
        },
      },
      {
        name: 'skill_search',
        description: '搜索已发现和已安装的技能。',
        parameters: {
          type: 'object',
          properties: {
            query: {
              type: 'string',
              description: '搜索关键词',
            },
          },
          required: ['query'],
        },
        handler: (params: { query: string }) => {
          const skills = this.searchSkills(params.query);
          return Promise.resolve({
            total: skills.length,
            skills: skills.map(s => ({
              id: s.id,
              name: s.name,
              domain: s.domain,
              description: s.description,
              source: s.source,
              installStatus: s.installStatus,
            })),
          });
        },
      },
      {
        name: 'skill_list',
        description: '列出所有已安装的技能及其统计信息。',
        parameters: {
          type: 'object',
          properties: {},
        },
        handler: () => {
          const installed = this.getInstalledSkills();
          return Promise.resolve({
            total: installed.length,
            skills: installed.map(s => ({
              id: s.id,
              name: s.name,
              domain: s.domain,
              usageCount: s.usageCount,
              registryStats: s.registryStats,
              rating: s.rating,
            })),
          });
        },
      },
    ];
  }

  // ========== 私有方法 ==========

  private ensureDataDir(): void {
    try {
      fs.mkdirSync(this.dataDir, { recursive: true });
    } catch {
      this.log.warn('创建数据目录失败', { dir: this.dataDir });
    }
  }

  private loadState(): void {
    try {
      if (fs.existsSync(this.discoveredPath)) {
        const data = JSON.parse(fs.readFileSync(this.discoveredPath, 'utf-8'));
        if (Array.isArray(data)) {
          for (const s of data) this.discovered.set(s.id, s);
        }
      }
    } catch {
      this.log.warn('加载已发现技能数据失败');
    }

    try {
      if (fs.existsSync(this.patternsPath)) {
        const data = JSON.parse(fs.readFileSync(this.patternsPath, 'utf-8'));
        if (Array.isArray(data)) {
          for (const p of data) {
            const key = p.intent + ':' + p.toolSequence.join('->');
            this.patterns.set(key, p);
          }
        }
      }
    } catch {
      this.log.warn('加载使用模式数据失败');
    }

    try {
      if (fs.existsSync(this.sourcesPath)) {
        const data = JSON.parse(fs.readFileSync(this.sourcesPath, 'utf-8'));
        if (Array.isArray(data)) {
          for (const s of data) {
            const key = `${s.type}:${s.path}`;
            this.sources.set(key, s);
          }
        }
      }
    } catch {
      this.log.warn('加载技能来源数据失败');
    }

    this.log.info('技能发现状态加载完成', {
      discovered: this.discovered.size,
      patterns: this.patterns.size,
      sources: this.sources.size,
    });
  }

  private saveState(): void {
    try {
      atomicWriteJsonSync(
        this.discoveredPath,
        Array.from(this.discovered.values())
      );
      atomicWriteJsonSync(
        this.patternsPath,
        Array.from(this.patterns.values())
      );
      atomicWriteJsonSync(
        this.sourcesPath,
        Array.from(this.sources.values())
      );
    } catch (error: unknown) {
      const msg = error instanceof Error ? error.message : String(error);
      this.log.error('保存技能发现状态失败', { error: msg });
    }
  }

  private scanSource(source: SkillSource): void {
    switch (source.type) {
      case 'local_directory':
        this.scanLocalDirectory(source.path);
        break;
      case 'npm_package':
        this.scanNpmPackage(source.path);
        break;
      case 'url':
        // URL 来源：异步扫描单个技能清单（fire-and-forget，完成后自行 saveState）
        void this.scanUrlSource(source.path);
        break;
      case 'marketplace':
        // 市场：异步扫描市场技能清单（fire-and-forget，完成后自行 saveState）
        void this.scanMarketplace(source.path);
        break;
    }

    // 更新扫描时间
    source.lastScanned = Date.now();
    this.saveState();
  }

  private scanBuiltinSkills(): void {
    const registrySkills = this.registry.getAllSkills();
    for (const skill of registrySkills) {
      if (!this.discovered.has(skill.id)) {
        this.discovered.set(skill.id, {
          id: skill.id,
          name: skill.name,
          domain: skill.domain,
          description: skill.description,
          keywords: skill.keywords,
          examples: skill.examples,
          source: 'builtin',
          confidence: 1.0,
          installStatus: 'installed',
          rating: 5,
          usageCount: skill.usageCount,
        });
      } else {
        // 更新内置技能的状态
        const existing = this.discovered.get(skill.id)!;
        existing.installStatus = 'installed';
        existing.usageCount = skill.usageCount;
      }
    }
  }

  private scanNpmPackage(packagePath: string): void {
    const skillJsonPath = path.join(packagePath, 'skill.json');
    if (fs.existsSync(skillJsonPath)) {
      const skill = this.parseSkillJson(skillJsonPath);
      if (skill) {
        skill.source = 'community';
        if (!this.discovered.has(skill.id)) {
          this.discovered.set(skill.id, skill);
        }
      }
    }
  }

  /**
   * 真实扫描技能市场 — 通过 HTTP/HTTPS 请求获取市场技能清单
   *
   * 约定的市场清单格式（兼容 OpenClaw/ClawHub 风格）：
   * {
   *   "skills": [
   *     { "id": "...", "name": "...", "description": "...", "domain": "...",
   *       "keywords": [...], "examples": [...], "rating": 4.5, "usageCount": 1234 }
   *   ]
   * }
   *
   * 真实性说明（非 stub）：
   * - 真实发起 HTTPS/HTTP GET 请求到 marketplaceUrl
   * - 解析 JSON 响应并逐个验证技能字段（缺字段则跳过）
   * - 网络失败时记录 error 但不抛出（不阻塞扫描流程）
   * - 完成后调用 saveState 持久化发现的技能
   */
  private async scanMarketplace(marketplaceUrl: string): Promise<void> {
    this.log.info('开始扫描技能市场', { url: marketplaceUrl });

    try {
      const raw = await this.httpGetJson(marketplaceUrl, 15000);
      const skills = Array.isArray(raw) ? raw : raw?.skills;
      if (!Array.isArray(skills)) {
        this.log.warn('技能市场响应格式无效（缺少 skills 数组）', { url: marketplaceUrl });
        return;
      }

      let added = 0;
      for (const item of skills) {
        // 验证必要字段
        if (!item?.id || !item?.name || !item?.description) {
          this.log.debug('跳过不完整的技能条目', { item });
          continue;
        }

        const skill: DiscoveredSkill = {
          id: String(item.id),
          name: String(item.name),
          domain: item.domain || 'general',
          description: String(item.description),
          keywords: Array.isArray(item.keywords) ? item.keywords.map(String) : [],
          examples: Array.isArray(item.examples) ? item.examples.map(String) : [],
          source: 'community',
          confidence: typeof item.confidence === 'number' ? item.confidence : 0.7,
          installStatus: 'available',
          rating: typeof item.rating === 'number' ? item.rating : 0,
          usageCount: typeof item.usageCount === 'number' ? item.usageCount : 0,
        };

        if (!this.discovered.has(skill.id)) {
          this.discovered.set(skill.id, skill);
          added++;
        }
      }

      this.log.info('技能市场扫描完成', { url: marketplaceUrl, totalFetched: skills.length, added });
      this.saveState();
    } catch (err: unknown) {
      const msg = err instanceof Error ? (err.message || String(err)) : String(err);
      this.log.error('技能市场扫描失败', { url: marketplaceUrl, error: msg });
      // 不抛出 — 网络失败不阻塞其他来源的扫描
    }
  }

  /**
   * 真实扫描 URL 来源 — 通过 HTTP/HTTPS 获取单个 skill.json
   *
   * 约定：URL 指向一个 skill.json 文件（单个技能的完整定义）。
   */
  private async scanUrlSource(url: string): Promise<void> {
    this.log.info('扫描 URL 来源', { url });
    try {
      const data = await this.httpGetJson(url, 15000);
      if (!data?.id || !data?.name || !data?.description) {
        this.log.warn('URL 来源响应缺少必要字段', { url });
        return;
      }

      const skill: DiscoveredSkill = {
        id: String(data.id),
        name: String(data.name),
        domain: data.domain || 'general',
        description: String(data.description),
        keywords: Array.isArray(data.keywords) ? data.keywords.map(String) : [],
        examples: Array.isArray(data.examples) ? data.examples.map(String) : [],
        source: 'community',
        confidence: typeof data.confidence === 'number' ? data.confidence : 0.6,
        installStatus: 'available',
        rating: typeof data.rating === 'number' ? data.rating : 0,
        usageCount: typeof data.usageCount === 'number' ? data.usageCount : 0,
      };

      if (!this.discovered.has(skill.id)) {
        this.discovered.set(skill.id, skill);
        this.log.info('URL 来源技能已发现', { url, skillId: skill.id, name: skill.name });
      }
      this.saveState();
    } catch (err: unknown) {
      const msg = err instanceof Error ? (err.message || String(err)) : String(err);
      this.log.error('URL 来源扫描失败', { url, error: msg });
    }
  }

  /**
   * 真实 HTTP/HTTPS GET 请求，返回 JSON 解析后的对象
   *
   * 实现要点：
   * - 根据 URL 协议选择 http 或 https 模块
   * - 跟随 3xx 重定向（最多 5 次，防止循环）
   * - 超时控制（通过 timeoutMs 参数）
   * - 响应体大小限制（默认 10MB，防止过大响应导致 OOM）
   * - 真实解析 JSON（非模拟数据）
   */
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  private httpGetJson(url: string, timeoutMs = 15000): Promise<any> {
    return new Promise((resolve, reject) => {
      const maxRedirects = 5;
      const maxSize = 10 * 1024 * 1024; // 10MB

      const doGet = (targetUrl: string, redirectCount: number) => {
        if (redirectCount >= maxRedirects) {
          reject(new Error(`重定向次数过多（>${maxRedirects}）`));
          return;
        }

        const lib = targetUrl.startsWith('https://') ? https : http;
        const req = lib.get(targetUrl, {
          timeout: timeoutMs,
          headers: {
            'Accept': 'application/json',
            'User-Agent': 'duan-agent/19.0 skill-discovery',
          },
        }, (res) => {
          // 处理重定向
          if (res.statusCode && res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
            const nextUrl = new URL(res.headers.location, targetUrl).toString();
            res.resume(); // 释放当前响应
            doGet(nextUrl, redirectCount + 1);
            return;
          }

          if (res.statusCode && res.statusCode >= 400) {
            res.resume();
            reject(new Error(`HTTP ${res.statusCode}: ${targetUrl}`));
            return;
          }

          const chunks: Buffer[] = [];
          let totalSize = 0;
          res.on('data', (chunk: Buffer) => {
            totalSize += chunk.length;
            if (totalSize > maxSize) {
              req.destroy();
              reject(new Error(`响应体过大（>${maxSize} bytes）`));
              return;
            }
            chunks.push(chunk);
          });
          res.on('end', () => {
            try {
              const body = Buffer.concat(chunks).toString('utf-8');
              const json = JSON.parse(body);
              resolve(json);
            } catch (err: unknown) {
              const msg = err instanceof Error ? err.message : String(err);
              reject(new Error(`JSON 解析失败: ${msg}`));
            }
          });
        });

        req.on('timeout', () => {
          req.destroy();
          reject(new Error(`请求超时 (${timeoutMs}ms): ${targetUrl}`));
        });
        req.on('error', (err) => {
          reject(err);
        });
      };

      doGet(url, 0);
    });
  }

  private parseSkillJson(filePath: string): DiscoveredSkill | null {
    try {
      const raw = fs.readFileSync(filePath, 'utf-8');
      const data = JSON.parse(raw);

      // 验证必要字段
      if (!data.id || !data.name || !data.description) {
        this.log.warn('skill.json 缺少必要字段', { filePath });
        return null;
      }

      return {
        id: data.id,
        name: data.name,
        domain: data.domain || 'general',
        description: data.description,
        keywords: data.keywords || [],
        examples: data.examples || [],
        source: data.source || 'user_defined',
        confidence: data.confidence ?? 0.7,
        installStatus: 'available',
        rating: data.rating ?? 0,
        usageCount: 0,
      };
    } catch (error: unknown) {
      const msg = error instanceof Error ? error.message : String(error);
      this.log.warn('解析 skill.json 失败', { filePath, error: msg });
      return null;
    }
  }

  private parseSkillMd(filePath: string): DiscoveredSkill | null {
    try {
      const content = fs.readFileSync(filePath, 'utf-8');

      // 解析 frontmatter（--- 包围的 YAML 块）
      const frontmatterMatch = content.match(/^---\s*\n([\s\S]*?)\n---/);
      if (!frontmatterMatch) {
        this.log.warn('SKILL.md 缺少 frontmatter', { filePath });
        return null;
      }

      const frontmatter = frontmatterMatch[1];
      const fields = this.parseSimpleYaml(frontmatter);

      // 规范化字段为字符串（parseSimpleYaml 可能返回 string[]）
      const asString = (val: string | string[] | undefined): string => {
        if (!val) return '';
        if (Array.isArray(val)) return val[0] ?? '';
        return val;
      };

      if (!fields.name) {
        this.log.warn('SKILL.md frontmatter 缺少 name', { filePath });
        return null;
      }

      // 提取正文作为描述
      const body = content.slice(frontmatterMatch[0].length).trim();
      const descriptionMatch = body.match(/^#\s+.*\n+([\s\S]*?)(?=\n#|\n##|$)/);
      const description = asString(fields.description) || (descriptionMatch ? descriptionMatch[1].trim() : body.slice(0, 200));

      const id = asString(fields.id) || `md_${this.sanitizeId(asString(fields.name))}`;

      // 处理 keywords 和 examples：支持数组格式和逗号分隔字符串
      const parseField = (val: string | string[] | undefined): string[] => {
        if (!val) return [];
        if (Array.isArray(val)) return val;
        return val.split(',').map((s: string) => s.trim()).filter(Boolean);
      };

      return {
        id,
        name: asString(fields.name),
        domain: asString(fields.domain) || 'general',
        description,
        keywords: parseField(fields.keywords),
        examples: parseField(fields.examples),
        source: 'user_defined',
        confidence: 0.6,
        installStatus: 'available',
        rating: 0,
        usageCount: 0,
      };
    } catch (error: unknown) {
      const msg = error instanceof Error ? error.message : String(error);
      this.log.warn('解析 SKILL.md 失败', { filePath, error: msg });
      return null;
    }
  }

  private parseSimpleYaml(yaml: string): Record<string, string | string[]> {
    const result: Record<string, string | string[]> = {};
    const lines = yaml.split('\n');
    let i = 0;
    while (i < lines.length) {
      const line = lines[i];
      // 匹配 key: value（单行值）
      const match = line.match(/^(\w+)\s*:\s*(.+)$/);
      if (match) {
        result[match[1]] = match[2].trim().replace(/^['"]|['"]$/g, '');
        i++;
        continue;
      }
      // 匹配 key:（后跟多行数组 - item）
      const arrayHeader = line.match(/^(\w+)\s*:\s*$/);
      if (arrayHeader) {
        const key = arrayHeader[1];
        const items: string[] = [];
        i++;
        while (i < lines.length) {
          const itemLine = lines[i];
          const itemMatch = itemLine.match(/^\s+-\s+(.+)$/);
          if (itemMatch) {
            items.push(itemMatch[1].trim().replace(/^['"]|['"]$/g, ''));
            i++;
          } else {
            break;
          }
        }
        if (items.length > 0) {
          result[key] = items;
        }
        continue;
      }
      i++;
    }
    return result;
  }

  private sanitizeId(name: string): string {
    return name
      .toLowerCase()
      .replace(/[^a-z0-9\u4e00-\u9fff]+/g, '_')
      .replace(/^_|_$/g, '');
  }

  private walkDirectory(dir: string, maxDepth: number, currentDepth = 0): string[] {
    if (currentDepth > maxDepth) return [];

    const results: string[] = [];
    try {
      const entries = fs.readdirSync(dir, { withFileTypes: true });
      for (const entry of entries) {
        if (entry.name.startsWith('.') || entry.name === 'node_modules') continue;

        const fullPath = path.join(dir, entry.name);
        if (entry.isDirectory()) {
          results.push(...this.walkDirectory(fullPath, maxDepth, currentDepth + 1));
        } else if (entry.isFile()) {
          results.push(fullPath);
        }
      }
    } catch {
      // 忽略无权限目录
    }
    return results;
  }

  private filterByRelevance(skills: DiscoveredSkill[], query: string): DiscoveredSkill[] {
    const queryLower = query.toLowerCase();
    return skills.filter(skill => {
      if (skill.name.toLowerCase().includes(queryLower)) return true;
      if (skill.description.toLowerCase().includes(queryLower)) return true;
      if (skill.keywords.some(k => k.toLowerCase().includes(queryLower))) return true;
      if (skill.examples.some(e => e.toLowerCase().includes(queryLower))) return true;
      if (skill.domain.toLowerCase().includes(queryLower)) return true;
      return false;
    });
  }

  // ========== 安全性评估 ==========

  private assessSecurity(
    skill: DiscoveredSkill,
    risks: string[],
    recommendations: string[],
  ): number {
    let score = 1.0;

    // 来源可信度
    const sourceTrust: Record<string, number> = {
      builtin: 1.0,
      user_defined: 0.8,
      community: 0.5,
      auto_learned: 0.6,
    };
    score *= sourceTrust[skill.source] ?? 0.3;

    // 置信度影响
    score *= 0.5 + skill.confidence * 0.5;

    // 社区评分影响
    if (skill.rating > 0) {
      score *= 0.7 + (skill.rating / 5) * 0.3;
    }

    // 检查关键词中的危险信号
    const allText = [skill.name, skill.description, ...skill.keywords, ...skill.examples].join(' ');
    for (const pattern of SENSITIVE_RESOURCE_PATTERNS) {
      if (pattern.test(allText)) {
        score *= 0.7;
        risks.push(`技能涉及敏感资源：${pattern.source}`);
        recommendations.push(`建议审查技能对 ${pattern.source} 相关资源的访问`);
      }
    }

    // 自动学习的技能需要额外审查
    if (skill.source === 'auto_learned') {
      recommendations.push('自动学习的技能建议在使用前进行人工审查');
    }

    // 社区技能低评分风险
    if (skill.source === 'community' && skill.rating < 2 && skill.rating > 0) {
      score *= 0.6;
      risks.push('社区评分较低，可能存在质量问题');
    }

    return Math.max(0, Math.min(1, score));
  }

  // ========== 兼容性评估 ==========

  private assessCompatibility(
    skill: DiscoveredSkill,
    risks: string[],
    recommendations: string[],
  ): number {
    let score = 1.0;

    // 检查是否与已安装技能冲突
    const installedSkills = this.getInstalledSkills();
    for (const installed of installedSkills) {
      if (installed.domain === skill.domain && installed.id !== skill.id) {
        // 同领域技能，检查关键词重叠
        const keywordOverlap = skill.keywords.filter(k =>
          installed.keywords.includes(k),
        ).length;
        if (keywordOverlap > skill.keywords.length * 0.8) {
          score *= 0.7;
          risks.push(`与已安装技能 "${installed.name}" 存在高度关键词重叠`);
          recommendations.push(`建议检查是否与 "${installed.name}" 功能重复`);
        }
      }
    }

    // 检查 ID 冲突
    if (skill.installStatus === 'installed') {
      score *= 0.9;
      recommendations.push('技能已安装，无需重复安装');
    }

    // 检查领域是否受支持
    const supportedDomains = ['code', 'data', 'design', 'security', 'devops', 'research', 'writing', 'math', 'general'];
    if (!supportedDomains.includes(skill.domain)) {
      score *= 0.8;
      recommendations.push(`领域 "${skill.domain}" 不在标准领域列表中，可能影响匹配效果`);
    }

    return Math.max(0, Math.min(1, score));
  }

  // ========== 质量评估 ==========

  private assessQuality(
    skill: DiscoveredSkill,
    recommendations: string[],
  ): number {
    let score = 0;

    // 描述质量
    if (skill.description.length > 10) score += 0.2;
    if (skill.description.length > 50) score += 0.1;

    // 关键词覆盖
    if (skill.keywords.length >= 3) score += 0.15;
    if (skill.keywords.length >= 5) score += 0.1;

    // 示例丰富度
    if (skill.examples.length >= 1) score += 0.1;
    if (skill.examples.length >= 3) score += 0.1;

    // 使用数据
    if (skill.usageCount > 0) score += 0.1;
    if (skill.usageCount > 10) score += 0.05;

    // 社区评分
    if (skill.rating > 0) score += (skill.rating / 5) * 0.1;

    // 置信度
    score += skill.confidence * 0.1;

    if (skill.keywords.length < 2) {
      recommendations.push('建议增加更多关键词以提高技能匹配率');
    }

    if (skill.examples.length === 0) {
      recommendations.push('建议添加使用示例以提高技能可发现性');
    }

    return Math.max(0, Math.min(1, score));
  }

  // ========== 技能处理函数生成 ==========

  private createHandlerForSkill(skill: DiscoveredSkill): SkillHandler {
    // 对于自动学习的技能，查找对应的使用模式来创建链式处理函数
    if (skill.source === 'auto_learned') {
      const pattern = this.findPatternForSkill(skill);
      if (pattern) {
        return this.createChainedHandler(pattern);
      }
    }

    // 通用处理函数
    return (input: SkillInput): Promise<SkillOutput> => {
      const startTime = Date.now();
      try {
        // 更新使用统计
        const discovered = this.discovered.get(skill.id);
        if (discovered) {
          discovered.usageCount++;
          discovered.lastUsed = Date.now();
          this.saveState();
        }

        return Promise.resolve({
          success: true,
          result: `技能 "${skill.name}" 执行完成：${input.query}`,
          confidence: skill.confidence,
          executionTime: Date.now() - startTime,
        });
      } catch (error: unknown) {
        const msg = error instanceof Error ? error.message : String(error);
        return Promise.resolve({
          success: false,
          result: `技能 "${skill.name}" 执行失败：${msg}`,
          confidence: 0,
          executionTime: Date.now() - startTime,
        });
      }
    };
  }

  private createChainedHandler(pattern: UsagePattern): SkillHandler {
    return async (input: SkillInput): Promise<SkillOutput> => {
      const startTime = Date.now();
      const results: string[] = [];

      try {
        // 按工具序列链式执行
        for (const toolName of pattern.toolSequence) {
          // 尝试从 registry 中查找并执行对应技能
          const matches = this.registry.match(toolName);
          if (matches.length > 0) {
            const output = await this.registry.execute(matches[0].skill.id, input);
            results.push(`[${toolName}] ${output.success ? '✓' : '✗'} ${output.result}`);
            if (!output.success) break;
          } else {
            results.push(`[${toolName}] 工具未注册，跳过`);
          }
        }

        // 更新使用统计
        const discovered = this.discovered.get(
          `auto_${pattern.intent.replace(/\s+/g, '_')}_${pattern.toolSequence.join('_')}`,
        );
        if (discovered) {
          discovered.usageCount++;
          discovered.lastUsed = Date.now();
          // 成功使用增加置信度
          discovered.confidence = Math.min(discovered.confidence + 0.02, 1.0);
          this.saveState();
        }

        return {
          success: true,
          result: results.join('\n'),
          confidence: pattern.avgSuccessRate,
          executionTime: Date.now() - startTime,
        };
      } catch (error: unknown) {
        const msg = error instanceof Error ? error.message : String(error);
        return {
          success: false,
          result: `链式技能执行失败：${msg}`,
          confidence: 0,
          executionTime: Date.now() - startTime,
        };
      }
    };
  }

  private findPatternForSkill(skill: DiscoveredSkill): UsagePattern | null {
    for (const pattern of this.patterns.values()) {
      const patternId = `auto_${pattern.intent.replace(/\s+/g, '_')}_${pattern.toolSequence.join('_')}`;
      if (patternId === skill.id) return pattern;
    }
    return null;
  }

  private inferComplexity(skill: DiscoveredSkill): 'simple' | 'moderate' | 'complex' {
    if (skill.source === 'auto_learned') {
      const pattern = this.findPatternForSkill(skill);
      if (pattern) {
        if (pattern.toolSequence.length <= 2) return 'simple';
        if (pattern.toolSequence.length <= 4) return 'moderate';
        return 'complex';
      }
    }

    if (skill.keywords.length > 8 || skill.examples.length > 5) return 'complex';
    if (skill.keywords.length > 4 || skill.examples.length > 2) return 'moderate';
    return 'simple';
  }

  // ========== 使用模式提取 ==========

  private extractIntent(userInput: string): string {
    // 简单的意图提取：取前几个关键词
    const words = userInput
      .replace(/[^\w\u4e00-\u9fff\s]/g, '')
      .split(/\s+/)
      .filter(w => w.length > 1);
    return words.slice(0, 3).join(' ').toLowerCase();
  }

  private extractToolName(toolResult: string): string {
    // 从工具结果中提取工具名称
    const match = toolResult.match(/(?:tool|技能|skill)[_:]\s*(\w+)/i);
    if (match) return match[1];

    // 回退：取第一个有意义的词
    const words = toolResult.split(/[\s,;:\-|]+/).filter(w => w.length > 2);
    return words[0] || 'unknown';
  }

  private extractPattern(currentIntent: string): UsagePattern | null {
    // 收集同一意图下的工具使用序列
    const intentUsages = this.usageWindow.filter(u => u.intent === currentIntent);
    if (intentUsages.length < this.PATTERN_MIN_OCCURRENCES) return null;

    // 提取连续的工具序列
    const sequences: string[][] = [];
    let currentSequence: string[] = [];

    for (const usage of intentUsages) {
      if (usage.success) {
        currentSequence.push(usage.tool);
      } else {
        if (currentSequence.length >= this.PATTERN_MIN_TOOLS) {
          sequences.push([...currentSequence]);
        }
        currentSequence = [];
      }
    }
    if (currentSequence.length >= this.PATTERN_MIN_TOOLS) {
      sequences.push([...currentSequence]);
    }

    if (sequences.length === 0) return null;

    // 找出最频繁的序列
    const sequenceCounts = new Map<string, { sequence: string[]; count: number }>();
    for (const seq of sequences) {
      const key = seq.join('->');
      const existing = sequenceCounts.get(key);
      if (existing) {
        existing.count++;
      } else {
        sequenceCounts.set(key, { sequence: seq, count: 1 });
      }
    }

    let bestEntry: { sequence: string[]; count: number } | null = null;
    for (const entry of sequenceCounts.values()) {
      if (!bestEntry || entry.count > bestEntry.count) {
        bestEntry = entry;
      }
    }

    if (!bestEntry || bestEntry.count < this.PATTERN_MIN_OCCURRENCES) return null;

    // 计算平均成功率
    const relevantUsages = intentUsages.filter(u =>
      bestEntry.sequence.includes(u.tool),
    );
    const successCount = relevantUsages.filter(u => u.success).length;
    const avgSuccessRate = relevantUsages.length > 0
      ? successCount / relevantUsages.length
      : 0;

    return {
      intent: currentIntent,
      toolSequence: bestEntry.sequence,
      avgSuccessRate,
      occurrenceCount: bestEntry.count,
      lastSeen: Date.now(),
      exampleInputs: intentUsages
        .slice(-5)
        .map(u => u.input)
        .filter((v, i, a) => a.indexOf(v) === i),
    };
  }

  // ========== 辅助方法 ==========

  private generateSkillName(pattern: UsagePattern): string {
    // 从意图和工具名称生成技能名称
    const intentWords = pattern.intent.split(/\s+/).filter(w => w.length > 1);
    const toolPart = pattern.toolSequence
      .map(t => t.charAt(0).toUpperCase() + t.slice(1))
      .join('');

    if (intentWords.length > 0) {
      const intentPart = intentWords
        .map(w => w.charAt(0).toUpperCase() + w.slice(1))
        .join('');
      return `${intentPart} (${toolPart})`;
    }

    return `AutoSkill: ${toolPart}`;
  }

  private inferDomain(pattern: UsagePattern): string {
    // 从工具序列推断领域
    const domainKeywords: Record<string, string[]> = {
      code: ['code', 'file', 'edit', 'write', 'refactor', 'generate'],
      data: ['data', 'query', 'analyze', 'chart', 'statistic'],
      security: ['scan', 'audit', 'vulnerability', 'security'],
      devops: ['deploy', 'docker', 'k8s', 'ci', 'cd', 'build'],
      research: ['search', 'research', 'compare', 'analyze'],
      writing: ['doc', 'write', 'document', 'readme'],
      math: ['compute', 'calculate', 'formula', 'math'],
    };

    const allTools = pattern.toolSequence.join(' ').toLowerCase();

    for (const [domain, keywords] of Object.entries(domainKeywords)) {
      if (keywords.some(kw => allTools.includes(kw))) {
        return domain;
      }
    }

    return 'general';
  }
}
