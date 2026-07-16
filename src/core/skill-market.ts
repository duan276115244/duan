/**
 * SkillMarket — 技能市场
 *
 * v20.0 §5.4 学习增强的核心子系统之一。
 *
 * 定位：统一门户，聚合管理各类"技能资产"的发布、浏览、下载、评分、推荐、举报。
 * 与现有 5 套基础设施协同（不重复实现）：
 * - SlashCommandRegistry：技能市场安装的斜杠命令委托给它写入
 * - PersonaSystem：人格类技能委托给它创建
 * - SkillPackageSystem：技能包类技能委托给它安装激活
 * - SkillGenerator：生成的技能可发布到市场
 * - MCPMarketplace：综合评分算法和安全/兼容性检查模式参考它
 *
 * 资产类型：
 * 1. slash_command  — 斜杠命令模板
 * 2. subagent_preset — 专用子代理预设
 * 3. persona        — 角色人格
 * 4. skill_package  — SKILL.md 技能包
 * 5. generated_skill — LLM 生成的技能
 *
 * 数据存储：~/.duan/skill-market/
 *   - registry.json  — 市场技能注册表（含内置 + 用户发布）
 *   - ratings.json   — 用户评分记录
 *   - reports.json   — 举报记录
 *   - installed.json — 已下载记录
 */

import * as fs from 'fs';
import * as path from 'path';
import { logger } from './structured-logger.js';
import { EventBus } from './event-bus.js';
import { duanPath } from './duan-paths.js';
import { atomicWriteJsonSync } from './atomic-write.js';
import type { ToolDef } from './unified-tool-def.js';

// ============ 类型定义 ============

/** 技能资产类型 */
export type SkillAssetType =
  | 'slash_command'
  | 'subagent_preset'
  | 'persona'
  | 'skill_package'
  | 'generated_skill';

/** 维护状态 */
export type MaintenanceStatus = 'active' | 'maintenance' | 'deprecated' | 'abandoned';

/** 兼容性要求 */
export interface SkillCompatibility {
  /** 最低版本 */
  minVersion?: string;
  /** 所需工具 */
  requiredTools?: string[];
  /** 支持的操作系统 */
  supportedOS?: Array<'windows' | 'macos' | 'linux'>;
}

/** 权限声明 */
export interface SkillPermissions {
  network?: boolean;
  filesystem?: boolean;
  process?: boolean;
  envVars?: string[];
}

/** 市场技能资产 */
export interface MarketSkill {
  id: string;
  name: string;
  version: string;
  description: string;
  author: string;
  type: SkillAssetType;
  /** 分类：coding/testing/architecture/docs/security/performance/data/devops/other */
  category: string;
  tags: string[];
  /** 技能内容（JSON 字符串，根据 type 解析为不同结构） */
  content: string;
  /** 用户评分（0-5 平均分） */
  rating: number;
  /** 评分人数 */
  ratingCount: number;
  /** 下载量 */
  downloads: number;
  /** 举报数 */
  reports: number;
  /** 是否被隐藏（举报过多或作者主动下架） */
  hidden: boolean;
  /** 是否为内置 */
  builtin: boolean;
  /** 维护状态 */
  maintenanceStatus: MaintenanceStatus;
  /** 兼容性要求 */
  compatibility?: SkillCompatibility;
  /** 权限声明 */
  permissions?: SkillPermissions;
  /** 发布时间 */
  publishedAt: number;
  /** 最后更新时间 */
  updatedAt: number;
}

/** 用户评分记录 */
export interface SkillRating {
  skillId: string;
  userId: string;
  /** 1-5 星 */
  rating: number;
  comment?: string;
  ratedAt: number;
}

/** 举报记录 */
export interface SkillReport {
  skillId: string;
  reporterId: string;
  /** 举报原因 */
  reason: string;
  reportedAt: number;
}

/** 已安装记录 */
export interface InstalledRecord {
  skillId: string;
  version: string;
  installedAt: number;
}

/** 搜索选项 */
export interface SearchOptions {
  type?: SkillAssetType;
  category?: string;
  tag?: string;
  /** 是否包含隐藏的技能，默认 false */
  includeHidden?: boolean;
  /** 最多返回数，默认 20 */
  limit?: number;
}

/** 搜索结果 */
export interface SkillSearchResult {
  skill: MarketSkill;
  /** 相关性 0-100 */
  relevance: number;
  /** 综合评分（用于排序） */
  compositeScore: number;
}

/** 安装结果 */
export interface SkillInstallResult {
  success: boolean;
  message: string;
  /** 安装路径（如适用） */
  installPath?: string;
}

/** 发布选项 */
export interface PublishOptions {
  /** 覆盖同名同作者技能，默认 false */
  overwrite?: boolean;
}

/** 市场统计 */
export interface MarketStats {
  totalSkills: number;
  byType: Record<SkillAssetType, number>;
  byCategory: Record<string, number>;
  totalDownloads: number;
  totalRatings: number;
  averageRating: number;
  installedCount: number;
  hiddenCount: number;
}

// ============ 内置技能资产（精选示例） ============

const BUILTIN_SKILLS: MarketSkill[] = [
  {
    id: 'builtin-sc-git-review',
    name: 'git-review',
    version: '1.0.0',
    description: '审查当前 Git 分支的所有变更，生成结构化 review 报告（风格/安全/性能）',
    author: '段先生',
    type: 'slash_command',
    category: 'coding',
    tags: ['git', 'review', 'code-quality'],
    content: JSON.stringify({
      template: '请审查当前 Git 分支相对于 main 的所有变更。\n\n$ARGUMENTS\n\n输出：\n1. 变更概要\n2. 风格问题（按文件分组）\n3. 安全风险\n4. 性能隐患\n5. 改进建议',
    }),
    rating: 4.7,
    ratingCount: 42,
    downloads: 318,
    reports: 0,
    hidden: false,
    builtin: true,
    maintenanceStatus: 'active',
    publishedAt: Date.now() - 30 * 24 * 60 * 60 * 1000,
    updatedAt: Date.now() - 7 * 24 * 60 * 60 * 1000,
  },
  {
    id: 'builtin-sc-test-gen',
    name: 'test-gen',
    version: '1.1.0',
    description: '为指定文件自动生成单元测试（vitest/jest），覆盖率优先',
    author: '段先生',
    type: 'slash_command',
    category: 'testing',
    tags: ['test', 'vitest', 'jest', 'coverage'],
    content: JSON.stringify({
      template: '请为以下文件生成单元测试：$ARGUMENTS\n\n要求：\n1. 使用 vitest\n2. 覆盖正常路径 + 边缘情况 + 异常路径\n3. 目标覆盖率 ≥ 85%\n4. 遵循 AAA 模式（Arrange/Act/Assert）',
    }),
    rating: 4.5,
    ratingCount: 28,
    downloads: 215,
    reports: 0,
    hidden: false,
    builtin: true,
    maintenanceStatus: 'active',
    publishedAt: Date.now() - 45 * 24 * 60 * 60 * 1000,
    updatedAt: Date.now() - 14 * 24 * 60 * 60 * 1000,
  },
  {
    id: 'builtin-spell-code-reviewer-pro',
    name: 'code-reviewer-pro',
    version: '2.0.0',
    description: '增强版代码审查员子代理，支持多语言 + 安全漏洞扫描 + 修复建议',
    author: '段先生团队',
    type: 'subagent_preset',
    category: 'coding',
    tags: ['review', 'security', 'subagent'],
    content: JSON.stringify({
      systemPrompt: '你是一名资深代码审查员，精通 10+ 编程语言。审查时关注：代码风格、安全漏洞（OWASP Top 10）、性能瓶颈、可维护性。对每个问题给出严重等级（critical/warning/info）和具体修复建议。',
      allowedTools: ['file_read', 'search_files', 'code_execute', 'web_search'],
      model: 'advanced',
      maxTurns: 15,
      intentKeywords: ['审查', 'review', '检查代码', 'code review'],
      icon: '🔍',
    }),
    rating: 4.8,
    ratingCount: 67,
    downloads: 512,
    reports: 0,
    hidden: false,
    builtin: true,
    maintenanceStatus: 'active',
    compatibility: { requiredTools: ['file_read', 'search_files'] },
    publishedAt: Date.now() - 60 * 24 * 60 * 60 * 1000,
    updatedAt: Date.now() - 3 * 24 * 60 * 60 * 1000,
  },
  {
    id: 'builtin-spell-test-engineer-tdd',
    name: 'test-engineer-tdd',
    version: '1.2.0',
    description: 'TDD 测试工程师子代理，红-绿-重构循环驱动开发',
    author: '段先生团队',
    type: 'subagent_preset',
    category: 'testing',
    tags: ['tdd', 'test', 'subagent'],
    content: JSON.stringify({
      systemPrompt: '你是 TDD 测试工程师。工作流：1) 先写失败测试（红） 2) 写最小实现使测试通过（绿） 3) 重构保持测试通过。每步都向用户确认。',
      allowedTools: ['file_read', 'file_write', 'code_execute', 'search_files'],
      model: 'standard',
      maxTurns: 20,
      intentKeywords: ['TDD', '测试驱动', 'test driven'],
      icon: '🧪',
    }),
    rating: 4.6,
    ratingCount: 39,
    downloads: 287,
    reports: 0,
    hidden: false,
    builtin: true,
    maintenanceStatus: 'active',
    publishedAt: Date.now() - 50 * 24 * 60 * 60 * 1000,
    updatedAt: Date.now() - 10 * 24 * 60 * 60 * 1000,
  },
  {
    id: 'builtin-persona-data-scientist',
    name: 'data-scientist',
    version: '1.0.0',
    description: '数据科学家角色人格，擅长 Python/SQL/ML，以数据驱动决策',
    author: '段先生团队',
    type: 'persona',
    category: 'data',
    tags: ['data-science', 'ml', 'python', 'sql'],
    content: JSON.stringify({
      name: 'data-scientist',
      displayName: '数据科学家',
      description: '擅长数据清洗、特征工程、模型训练和可视化的数据科学家',
      icon: '📊',
      skills: [
        { name: 'Python', level: 5 },
        { name: 'SQL', level: 4 },
        { name: 'Machine Learning', level: 4 },
        { name: 'Data Visualization', level: 4 },
      ],
      thinkingStyle: '数据驱动，先看数据再下结论',
      outputStyle: '附上数据来源和置信度',
      knowledgeDomains: ['统计学', '机器学习', '数据可视化', 'Python 生态'],
      systemPromptSupplement: '回答时优先考虑数据支撑，对没有数据支撑的结论标注"假设"。',
      builtin: false,
    }),
    rating: 4.4,
    ratingCount: 23,
    downloads: 156,
    reports: 0,
    hidden: false,
    builtin: true,
    maintenanceStatus: 'active',
    publishedAt: Date.now() - 20 * 24 * 60 * 60 * 1000,
    updatedAt: Date.now() - 5 * 24 * 60 * 60 * 1000,
  },
  {
    id: 'builtin-persona-devops-engineer',
    name: 'devops-engineer',
    version: '1.0.0',
    description: 'DevOps 工程师角色，精通 CI/CD、容器编排、监控告警',
    author: '段先生团队',
    type: 'persona',
    category: 'devops',
    tags: ['devops', 'cicd', 'docker', 'k8s'],
    content: JSON.stringify({
      name: 'devops-engineer',
      displayName: 'DevOps 工程师',
      description: '专注于持续集成、持续部署、容器化和基础设施自动化的 DevOps 工程师',
      icon: '⚙️',
      skills: [
        { name: 'Docker', level: 5 },
        { name: 'Kubernetes', level: 4 },
        { name: 'CI/CD', level: 5 },
        { name: 'Linux', level: 4 },
      ],
      thinkingStyle: '自动化优先，幂等可重复',
      outputStyle: '附上可执行的命令和回滚步骤',
      knowledgeDomains: ['容器化', '编排', '监控', 'CI/CD'],
      systemPromptSupplement: '所有操作命令必须给出回滚方案。',
      builtin: false,
    }),
    rating: 4.6,
    ratingCount: 31,
    downloads: 198,
    reports: 0,
    hidden: false,
    builtin: true,
    maintenanceStatus: 'active',
    publishedAt: Date.now() - 25 * 24 * 60 * 60 * 1000,
    updatedAt: Date.now() - 8 * 24 * 60 * 60 * 1000,
  },
  {
    id: 'builtin-skillpkg-coding-standards',
    name: 'coding-standards',
    version: '1.3.0',
    description: '编码规范技能包，注入 TypeScript/Python/Go 的最佳实践到系统提示',
    author: '段先生',
    type: 'skill_package',
    category: 'coding',
    tags: ['standards', 'best-practices', 'typescript', 'python'],
    content: '---\nid: coding-standards\nname: 编码规范\nversion: 1.3.0\ndescription: TypeScript/Python/Go 编码规范\nauthor: 段先生\n---\n\n# 编码规范\n\n## TypeScript\n- 严格模式：noImplicitAny / strictNullChecks\n- 优先接口而非类型别名（便于扩展）\n- 异步函数必须 try-catch\n\n## Python\n- 类型注解必填\n- f-string 优先\n- 异步用 asyncio',
    rating: 4.7,
    ratingCount: 89,
    downloads: 624,
    reports: 0,
    hidden: false,
    builtin: true,
    maintenanceStatus: 'active',
    compatibility: { minVersion: '19.0.0' },
    publishedAt: Date.now() - 90 * 24 * 60 * 60 * 1000,
    updatedAt: Date.now() - 2 * 24 * 60 * 60 * 1000,
  },
  {
    id: 'builtin-skillpkg-security-checklist',
    name: 'security-checklist',
    version: '1.1.0',
    description: '安全审计技能包，OWASP Top 10 + 输入校验 + 密钥管理清单',
    author: '段先生安全小组',
    type: 'skill_package',
    category: 'security',
    tags: ['security', 'owasp', 'audit'],
    content: '---\nid: security-checklist\nname: 安全审计清单\nversion: 1.1.0\ndescription: OWASP Top 10 安全审计\nauthor: 段先生安全小组\n---\n\n# 安全审计清单\n\n## OWASP Top 10\n1. 注入攻击（SQL/NoSQL/Command）\n2. 失效认证\n3. 敏感数据泄露\n4. XML 外部实体\n5. 失效访问控制\n6. 安全配置错误\n7. XSS\n8. 失效反序列化\n9. 已知漏洞组件\n10. 日志监控不足',
    rating: 4.9,
    ratingCount: 124,
    downloads: 892,
    reports: 0,
    hidden: false,
    builtin: true,
    maintenanceStatus: 'active',
    compatibility: { minVersion: '19.0.0' },
    publishedAt: Date.now() - 75 * 24 * 60 * 60 * 1000,
    updatedAt: Date.now() - 1 * 24 * 60 * 60 * 1000,
  },
  {
    id: 'builtin-genk-refactor-helper',
    name: 'refactor-helper',
    version: '1.0.0',
    description: 'LLM 生成的重构助手技能，识别代码异味并给出重构建议',
    author: 'SelfLearning',
    type: 'generated_skill',
    category: 'coding',
    tags: ['refactor', 'code-smell', 'generated'],
    content: JSON.stringify({
      id: 'refactor-helper',
      name: '重构助手',
      domain: 'coding',
      description: '识别代码异味（长函数/重复代码/过深嵌套/大类）并给出重构建议',
      keywords: ['重构', 'refactor', '代码异味', 'code smell'],
      handler: 'auto',
    }),
    rating: 4.3,
    ratingCount: 17,
    downloads: 134,
    reports: 0,
    hidden: false,
    builtin: true,
    maintenanceStatus: 'active',
    publishedAt: Date.now() - 15 * 24 * 60 * 60 * 1000,
    updatedAt: Date.now() - 4 * 24 * 60 * 60 * 1000,
  },
  {
    id: 'builtin-genk-doc-writer',
    name: 'doc-writer',
    version: '1.0.0',
    description: 'LLM 生成的文档撰写技能，根据代码自动生成 API 文档',
    author: 'SelfLearning',
    type: 'generated_skill',
    category: 'docs',
    tags: ['docs', 'api', 'generated'],
    content: JSON.stringify({
      id: 'doc-writer',
      name: '文档撰写',
      domain: 'docs',
      description: '从代码注释和签名自动生成 API 文档（Markdown 格式）',
      keywords: ['文档', 'docs', 'api doc', '注释'],
      handler: 'auto',
    }),
    rating: 4.5,
    ratingCount: 21,
    downloads: 178,
    reports: 0,
    hidden: false,
    builtin: true,
    maintenanceStatus: 'active',
    publishedAt: Date.now() - 18 * 24 * 60 * 60 * 1000,
    updatedAt: Date.now() - 6 * 24 * 60 * 60 * 1000,
  },
];

// ============ SkillMarket 主类 ============

/** 举报阈值：达到此数量自动隐藏 */
const REPORT_THRESHOLD = 5;
/** 单作者发布上限（防刷屏） */
const MAX_PUBLISH_PER_AUTHOR = 50;

export class SkillMarket {
  private static _instance: SkillMarket | null = null;

  private dataDir: string;
  private registryPath: string;
  private ratingsPath: string;
  private reportsPath: string;
  private installedPath: string;

  private registry: Map<string, MarketSkill> = new Map();
  private ratings: Map<string, SkillRating[]> = new Map();
  private reports: Map<string, SkillReport[]> = new Map();
  private installed: Map<string, InstalledRecord> = new Map();

  private eventBus: EventBus;
  private log = logger.child({ module: 'SkillMarket' });

  /** 构造函数支持 dataDir 用于测试隔离 */
  constructor(dataDir?: string) {
    this.dataDir = dataDir ?? duanPath('skill-market');
    this.registryPath = path.join(this.dataDir, 'registry.json');
    this.ratingsPath = path.join(this.dataDir, 'ratings.json');
    this.reportsPath = path.join(this.dataDir, 'reports.json');
    this.installedPath = path.join(this.dataDir, 'installed.json');
    this.eventBus = EventBus.getInstance();
  }

  static getInstance(): SkillMarket {
    if (!SkillMarket._instance) {
      SkillMarket._instance = new SkillMarket();
    }
    return SkillMarket._instance;
  }

  /** 重置单例（仅测试用） */
  static _resetInstance(): void {
    SkillMarket._instance = null;
  }

  /** 初始化：创建目录 + 加载数据 + 注入内置 */
  initialize(): void {
    fs.mkdirSync(this.dataDir, { recursive: true });
    this.loadData();
    this.injectBuiltins();
    this.log.info('SkillMarket 初始化完成', {
      totalSkills: this.registry.size,
      installed: this.installed.size,
    });
  }

  /** 加载持久化数据 */
  private loadData(): void {
    this.registry = this.loadRegistryFile(this.registryPath);
    this.ratings = this.loadRatingsFile(this.ratingsPath);
    this.reports = this.loadReportsFile(this.reportsPath);
    this.installed = this.loadInstalledFile(this.installedPath);
  }

  private loadRegistryFile(filePath: string): Map<string, MarketSkill> {
    try {
      if (!fs.existsSync(filePath)) return new Map();
      const raw = fs.readFileSync(filePath, 'utf-8');
      const data = JSON.parse(raw) as { skills?: MarketSkill[] };
      const map = new Map<string, MarketSkill>();
      for (const skill of data.skills ?? []) {
        if (skill.id && skill.name) {
          map.set(skill.id, skill);
        }
      }
      return map;
    } catch (err: unknown) {
      this.log.warn('registry.json 解析失败，重置为空', { error: err instanceof Error ? err.message : String(err) });
      return new Map();
    }
  }

  private loadRatingsFile(filePath: string): Map<string, SkillRating[]> {
    try {
      if (!fs.existsSync(filePath)) return new Map();
      const raw = fs.readFileSync(filePath, 'utf-8');
      const data = JSON.parse(raw) as { ratings?: SkillRating[] };
      const map = new Map<string, SkillRating[]>();
      for (const r of data.ratings ?? []) {
        if (!r.skillId) continue;
        const list = map.get(r.skillId) ?? [];
        list.push(r);
        map.set(r.skillId, list);
      }
      return map;
    } catch {
      return new Map();
    }
  }

  private loadReportsFile(filePath: string): Map<string, SkillReport[]> {
    try {
      if (!fs.existsSync(filePath)) return new Map();
      const raw = fs.readFileSync(filePath, 'utf-8');
      const data = JSON.parse(raw) as { reports?: SkillReport[] };
      const map = new Map<string, SkillReport[]>();
      for (const r of data.reports ?? []) {
        if (!r.skillId) continue;
        const list = map.get(r.skillId) ?? [];
        list.push(r);
        map.set(r.skillId, list);
      }
      return map;
    } catch {
      return new Map();
    }
  }

  private loadInstalledFile(filePath: string): Map<string, InstalledRecord> {
    try {
      if (!fs.existsSync(filePath)) return new Map();
      const raw = fs.readFileSync(filePath, 'utf-8');
      const data = JSON.parse(raw) as { installed?: InstalledRecord[] };
      const map = new Map<string, InstalledRecord>();
      for (const r of data.installed ?? []) {
        if (r.skillId) map.set(r.skillId, r);
      }
      return map;
    } catch {
      return new Map();
    }
  }

  /** 注入内置技能（不覆盖用户发布的同名技能） */
  private injectBuiltins(): void {
    for (const skill of BUILTIN_SKILLS) {
      if (!this.registry.has(skill.id)) {
        this.registry.set(skill.id, { ...skill });
      }
    }
    this.persistRegistry();
  }

  // ============ 持久化 ============

  private persistRegistry(): void {
    const skills = Array.from(this.registry.values());
    atomicWriteJsonSync(this.registryPath, { skills });
  }

  private persistRatings(): void {
    const all: SkillRating[] = [];
    for (const list of this.ratings.values()) all.push(...list);
    atomicWriteJsonSync(this.ratingsPath, { ratings: all });
  }

  private persistReports(): void {
    const all: SkillReport[] = [];
    for (const list of this.reports.values()) all.push(...list);
    atomicWriteJsonSync(this.reportsPath, { reports: all });
  }

  private persistInstalled(): void {
    const installed = Array.from(this.installed.values());
    atomicWriteJsonSync(this.installedPath, { installed });
  }

  // ============ 发布 / 下架 ============

  /**
   * 发布技能到市场
   * @returns 发布结果，含 skillId
   */
  publish(skill: Omit<MarketSkill, 'rating' | 'ratingCount' | 'downloads' | 'reports' | 'hidden' | 'builtin' | 'publishedAt' | 'updatedAt'> & Partial<Pick<MarketSkill, 'rating' | 'ratingCount' | 'downloads' | 'reports' | 'hidden' | 'maintenanceStatus' | 'compatibility' | 'permissions'>>, options?: PublishOptions): { success: boolean; skillId?: string; error?: string } {
    // 单作者发布上限
    const authorCount = Array.from(this.registry.values())
      .filter(s => s.author === skill.author && !s.builtin).length;
    if (authorCount >= MAX_PUBLISH_PER_AUTHOR) {
      return { success: false, error: `作者 "${skill.author}" 已达到发布上限 ${MAX_PUBLISH_PER_AUTHOR}` };
    }

    // ID 冲突检查
    const existing = this.registry.get(skill.id);
    if (existing && !options?.overwrite) {
      return { success: false, error: `技能 ID "${skill.id}" 已存在（使用 overwrite=true 覆盖）` };
    }

    const now = Date.now();
    const newSkill: MarketSkill = {
      rating: 0,
      ratingCount: 0,
      downloads: 0,
      reports: 0,
      hidden: false,
      builtin: false,
      maintenanceStatus: 'active',
      publishedAt: now,
      updatedAt: now,
      ...skill,
    };
    // 以下字段不允许发布时覆盖（在 spread 之后单独赋值，避免对象字面量重复属性 TS1117）
    newSkill.builtin = false;
    newSkill.publishedAt = existing?.publishedAt ?? now;
    newSkill.downloads = existing?.downloads ?? 0;
    newSkill.ratingCount = existing?.ratingCount ?? 0;
    newSkill.rating = existing?.rating ?? 0;
    newSkill.reports = existing?.reports ?? 0;

    this.registry.set(skill.id, newSkill);
    this.persistRegistry();

    void this.eventBus.emit('skill.market.published', {
      skillId: skill.id,
      name: skill.name,
      type: skill.type,
      author: skill.author,
    });

    this.log.info('技能已发布', { skillId: skill.id, name: skill.name, type: skill.type });
    return { success: true, skillId: skill.id };
  }

  /**
   * 下架技能（仅作者本人或管理员）
   */
  unpublish(id: string, requesterId: string): { success: boolean; error?: string } {
    const skill = this.registry.get(id);
    if (!skill) return { success: false, error: `技能 "${id}" 不存在` };
    if (skill.builtin) return { success: false, error: '内置技能不可下架' };
    if (skill.author !== requesterId) {
      return { success: false, error: '只能下架自己发布的技能' };
    }

    this.registry.delete(id);
    this.ratings.delete(id);
    this.reports.delete(id);
    this.installed.delete(id);

    this.persistRegistry();
    this.persistRatings();
    this.persistReports();
    this.persistInstalled();

    void this.eventBus.emit('skill.market.unpublished', { skillId: id });
    this.log.info('技能已下架', { skillId: id });
    return { success: true };
  }

  // ============ 浏览 / 搜索 ============

  /**
   * 搜索市场技能（综合评分排序）
   * 算法：相关性(40%) + 用户评分(25%) + 下载量(20%) + 维护活跃度(15%)
   */
  search(query: string, options?: SearchOptions): SkillSearchResult[] {
    const q = query.toLowerCase().trim();
    const results: SkillSearchResult[] = [];

    for (const skill of this.registry.values()) {
      // 过滤隐藏
      if (skill.hidden && !options?.includeHidden) continue;
      // 类型过滤
      if (options?.type && skill.type !== options.type) continue;
      // 分类过滤
      if (options?.category && skill.category !== options.category) continue;
      // 标签过滤
      if (options?.tag && !skill.tags.includes(options.tag)) continue;

      let relevance = 0;
      if (q === '') {
        relevance = 50; // 空查询给中性分
      } else {
        const nameLower = skill.name.toLowerCase();
        const descLower = skill.description.toLowerCase();
        if (nameLower === q) relevance = 100;
        else if (nameLower.includes(q)) relevance = 80;
        else if (descLower.includes(q)) relevance = 50;
        else if (skill.tags.some(t => t.toLowerCase().includes(q))) relevance = 30;
        else if (skill.author.toLowerCase().includes(q)) relevance = 20;
        else continue;
      }

      // 已安装的优先级降低
      if (this.installed.has(skill.id)) relevance *= 0.6;

      const compositeScore = this.calculateCompositeScore(skill, relevance);
      results.push({ skill, relevance, compositeScore });
    }

    results.sort((a, b) => b.compositeScore - a.compositeScore);
    const limit = options?.limit ?? 20;
    return results.slice(0, limit);
  }

  /**
   * 计算综合评分
   * 相关性(40%) + 用户评分(25%) + 下载量(20%) + 维护活跃度(15%)
   */
  private calculateCompositeScore(skill: MarketSkill, relevance: number): number {
    const relevanceScore = relevance;
    const ratingScore = skill.rating * 20; // 0-5 → 0-100
    const downloads = skill.downloads;
    const downloadScore = downloads > 0 ? Math.min(100, Math.log10(downloads + 1) * 25) : 0;

    let maintenanceScore = 50;
    if (skill.maintenanceStatus === 'active') maintenanceScore = 100;
    else if (skill.maintenanceStatus === 'maintenance') maintenanceScore = 70;
    else if (skill.maintenanceStatus === 'deprecated') maintenanceScore = 30;
    else if (skill.maintenanceStatus === 'abandoned') maintenanceScore = 10;

    // 时间衰减
    const daysSinceUpdate = (Date.now() - skill.updatedAt) / (24 * 60 * 60 * 1000);
    const freshness = Math.max(0, 1 - daysSinceUpdate / 365);
    maintenanceScore *= freshness;

    return relevanceScore * 0.4 + ratingScore * 0.25 + downloadScore * 0.2 + maintenanceScore * 0.15;
  }

  /** 获取技能详情 */
  getInfo(id: string): MarketSkill | null {
    return this.registry.get(id) ?? null;
  }

  /** 列出所有可用技能（不含隐藏） */
  listAvailable(options?: SearchOptions): MarketSkill[] {
    const skills: MarketSkill[] = [];
    for (const s of this.registry.values()) {
      if (s.hidden && !options?.includeHidden) continue;
      if (options?.type && s.type !== options.type) continue;
      if (options?.category && s.category !== options.category) continue;
      if (options?.tag && !s.tags.includes(options.tag)) continue;
      skills.push(s);
    }
    return skills;
  }

  /** 推荐技能（按综合评分排序的 Top N） */
  listFeatured(limit: number = 10): MarketSkill[] {
    const visible = this.listAvailable();
    const scored = visible.map(s => ({
      skill: s,
      score: this.calculateCompositeScore(s, 50), // 中性相关性
    }));
    scored.sort((a, b) => b.score - a.score);
    return scored.slice(0, limit).map(x => x.skill);
  }

  /** 列出已安装的技能 */
  listInstalled(): Array<{ skill: MarketSkill; record: InstalledRecord }> {
    const result: Array<{ skill: MarketSkill; record: InstalledRecord }> = [];
    for (const [id, record] of this.installed) {
      const skill = this.registry.get(id);
      if (skill) result.push({ skill, record });
    }
    return result;
  }

  // ============ 安装 / 卸载 ============

  /**
   * 下载并安装技能（委托给对应模块的写入方法）
   * 注意：实际安装由外部调用方注入 callback 实现，本方法只记录安装状态
   */
  async install(id: string, installer?: (skill: MarketSkill) => Promise<SkillInstallResult>): Promise<SkillInstallResult> {
    const skill = this.registry.get(id);
    if (!skill) return { success: false, message: `技能 "${id}" 不存在` };
    if (skill.hidden) return { success: false, message: `技能 "${id}" 已被隐藏` };
    if (this.installed.has(id)) return { success: false, message: `技能 "${skill.name}" 已安装` };

    this.log.info('开始安装技能', { id, name: skill.name, type: skill.type });

    let result: SkillInstallResult;
    if (installer) {
      result = await installer(skill);
    } else {
      // 无 installer 时仅记录安装状态（测试或纯记录场景）
      result = { success: true, message: `技能 "${skill.name}" 已记录为安装（无实际安装器）` };
    }

    if (result.success) {
      // 更新下载量
      skill.downloads += 1;
      skill.updatedAt = Date.now();
      this.registry.set(id, skill);
      this.persistRegistry();

      // 记录安装
      this.installed.set(id, {
        skillId: id,
        version: skill.version,
        installedAt: Date.now(),
      });
      this.persistInstalled();

      void this.eventBus.emit('skill.market.downloaded', {
        skillId: id,
        name: skill.name,
        type: skill.type,
      });

      this.log.info('技能安装成功', { id, name: skill.name });
    }

    return result;
  }

  /**
   * 卸载技能（仅移除安装记录，不删除本地文件）
   */
  uninstall(id: string): { success: boolean; error?: string } {
    if (!this.installed.has(id)) {
      return { success: false, error: `技能 "${id}" 未安装` };
    }
    this.installed.delete(id);
    this.persistInstalled();
    this.log.info('技能已卸载', { skillId: id });
    return { success: true };
  }

  // ============ 评分 ============

  /**
   * 评分（同一用户对同一技能重复评分将覆盖）
   */
  rate(id: string, userId: string, rating: number, comment?: string): { success: boolean; error?: string } {
    const skill = this.registry.get(id);
    if (!skill) return { success: false, error: `技能 "${id}" 不存在` };
    if (rating < 1 || rating > 5) return { success: false, error: '评分必须在 1-5 之间' };
    if (!Number.isInteger(rating)) return { success: false, error: '评分必须为整数' };

    const list = this.ratings.get(id) ?? [];
    // 移除该用户的旧评分
    const filtered = list.filter(r => r.userId !== userId);
    filtered.push({
      skillId: id,
      userId,
      rating,
      comment,
      ratedAt: Date.now(),
    });
    this.ratings.set(id, filtered);

    // 重算平均分
    const sum = filtered.reduce((acc, r) => acc + r.rating, 0);
    skill.rating = sum / filtered.length;
    skill.ratingCount = filtered.length;
    skill.updatedAt = Date.now();
    this.registry.set(id, skill);

    this.persistRatings();
    this.persistRegistry();

    void this.eventBus.emit('skill.market.rated', {
      skillId: id,
      userId,
      rating,
      averageRating: skill.rating,
    });

    this.log.info('技能已评分', { skillId: id, userId, rating, average: skill.rating });
    return { success: true };
  }

  /** 获取技能的所有评分 */
  getRatings(id: string): SkillRating[] {
    return this.ratings.get(id) ?? [];
  }

  // ============ 举报 ============

  /**
   * 举报技能
   */
  report(id: string, reporterId: string, reason: string): { success: boolean; error?: string } {
    const skill = this.registry.get(id);
    if (!skill) return { success: false, error: `技能 "${id}" 不存在` };
    if (!reason || reason.trim().length === 0) {
      return { success: false, error: '举报原因不能为空' };
    }

    const list = this.reports.get(id) ?? [];
    // 同一用户对同一技能只能举报一次
    if (list.some(r => r.reporterId === reporterId)) {
      return { success: false, error: '你已举报过此技能' };
    }

    list.push({
      skillId: id,
      reporterId,
      reason: reason.trim(),
      reportedAt: Date.now(),
    });
    this.reports.set(id, list);

    skill.reports = list.length;
    // 达到阈值自动隐藏
    if (list.length >= REPORT_THRESHOLD && !skill.hidden) {
      skill.hidden = true;
      this.log.warn('技能因举报过多被自动隐藏', { skillId: id, reports: list.length });
    }
    skill.updatedAt = Date.now();
    this.registry.set(id, skill);

    this.persistReports();
    this.persistRegistry();

    void this.eventBus.emit('skill.market.reported', {
      skillId: id,
      reporterId,
      reason,
      hidden: skill.hidden,
    });

    this.log.info('技能被举报', { skillId: id, reporterId, hidden: skill.hidden });
    return { success: true };
  }

  /** 获取技能的所有举报 */
  getReports(id: string): SkillReport[] {
    return this.reports.get(id) ?? [];
  }

  // ============ 管理员操作 ============

  /** 隐藏技能（管理员） */
  hide(id: string): { success: boolean; error?: string } {
    const skill = this.registry.get(id);
    if (!skill) return { success: false, error: `技能 "${id}" 不存在` };
    if (skill.hidden) return { success: false, error: '技能已被隐藏' };
    skill.hidden = true;
    skill.updatedAt = Date.now();
    this.registry.set(id, skill);
    this.persistRegistry();
    this.log.info('技能已隐藏', { skillId: id });
    return { success: true };
  }

  /** 取消隐藏（管理员） */
  unhide(id: string): { success: boolean; error?: string } {
    const skill = this.registry.get(id);
    if (!skill) return { success: false, error: `技能 "${id}" 不存在` };
    if (!skill.hidden) return { success: false, error: '技能未被隐藏' };
    skill.hidden = false;
    skill.updatedAt = Date.now();
    this.registry.set(id, skill);
    this.persistRegistry();
    this.log.info('技能已取消隐藏', { skillId: id });
    return { success: true };
  }

  // ============ 统计 ============

  getStats(): MarketStats {
    const skills = Array.from(this.registry.values());
    const byType: Record<string, number> = {};
    const byCategory: Record<string, number> = {};
    let totalDownloads = 0;
    let totalRatings = 0;
    let ratingSum = 0;
    let hiddenCount = 0;

    for (const s of skills) {
      byType[s.type] = (byType[s.type] ?? 0) + 1;
      byCategory[s.category] = (byCategory[s.category] ?? 0) + 1;
      totalDownloads += s.downloads;
      totalRatings += s.ratingCount;
      ratingSum += s.rating * s.ratingCount;
      if (s.hidden) hiddenCount += 1;
    }

    return {
      totalSkills: skills.length,
      byType: byType as Record<SkillAssetType, number>,
      byCategory,
      totalDownloads,
      totalRatings,
      averageRating: totalRatings > 0 ? ratingSum / totalRatings : 0,
      installedCount: this.installed.size,
      hiddenCount,
    };
  }

  // ============ LLM 工具定义 ============

  getToolDefinitions(): ToolDef[] {
    return [
      {
        name: 'skill_market_search',
        description: '搜索技能市场，按综合评分返回最相关的技能资产（斜杠命令/子代理预设/人格/技能包/生成技能）',
        parameters: {
          query: { type: 'string', description: '搜索关键词（名称/描述/标签/作者）', required: true },
          type: { type: 'string', description: '过滤类型：slash_command|subagent_preset|persona|skill_package|generated_skill', required: false },
          category: { type: 'string', description: '过滤分类：coding|testing|architecture|docs|security|performance|data|devops|other', required: false },
          tag: { type: 'string', description: '过滤标签', required: false },
          limit: { type: 'number', description: '最多返回数，默认20', required: false },
        },
        readOnly: true,
        execute: async (args: { query: string; type?: SkillAssetType; category?: string; tag?: string; limit?: number }) => {
          const results = this.search(args.query, {
            type: args.type,
            category: args.category,
            tag: args.tag,
            limit: args.limit,
          });
          return JSON.stringify({
            count: results.length,
            results: results.map(r => ({
              id: r.skill.id,
              name: r.skill.name,
              version: r.skill.version,
              description: r.skill.description,
              author: r.skill.author,
              type: r.skill.type,
              category: r.skill.category,
              tags: r.skill.tags,
              rating: Number(r.skill.rating.toFixed(2)),
              ratingCount: r.skill.ratingCount,
              downloads: r.skill.downloads,
              maintenanceStatus: r.skill.maintenanceStatus,
              compositeScore: Number(r.compositeScore.toFixed(2)),
              installed: this.installed.has(r.skill.id),
            })),
          });
        },
      },
      {
        name: 'skill_market_list',
        description: '列出技能市场的技能资产（支持按类型/分类过滤），或列出推荐/已安装',
        parameters: {
          mode: { type: 'string', description: '列表模式：available(默认)|featured|installed|all', required: false },
          type: { type: 'string', description: '过滤类型', required: false },
          category: { type: 'string', description: '过滤分类', required: false },
          limit: { type: 'number', description: 'featured 模式下的返回数，默认10', required: false },
        },
        readOnly: true,
        execute: async (args: { mode?: string; type?: SkillAssetType; category?: string; tag?: string; limit?: number }) => {
          const mode = args.mode ?? 'available';
          if (mode === 'featured') {
            const list = this.listFeatured(args.limit ?? 10);
            return JSON.stringify({ mode, count: list.length, skills: list.map(s => this.summarize(s)) });
          }
          if (mode === 'installed') {
            const list = this.listInstalled();
            return JSON.stringify({
              mode,
              count: list.length,
              skills: list.map(x => ({ ...this.summarize(x.skill), installedAt: x.record.installedAt, version: x.record.version })),
            });
          }
          if (mode === 'all') {
            const list = this.listAvailable({ includeHidden: true, type: args.type, category: args.category });
            return JSON.stringify({ mode, count: list.length, skills: list.map(s => this.summarize(s)) });
          }
          // available
          const list = this.listAvailable({ type: args.type, category: args.category });
          return JSON.stringify({ mode, count: list.length, skills: list.map(s => this.summarize(s)) });
        },
      },
      {
        name: 'skill_market_info',
        description: '获取技能市场某技能的详细信息（含内容）',
        parameters: {
          id: { type: 'string', description: '技能 ID', required: true },
        },
        readOnly: true,
        execute: async (args: { id: string }) => {
          const skill = this.getInfo(args.id);
          if (!skill) return JSON.stringify({ error: `技能 "${args.id}" 不存在` });
          return JSON.stringify({
            ...this.summarize(skill),
            content: skill.content,
            compatibility: skill.compatibility,
            permissions: skill.permissions,
            publishedAt: skill.publishedAt,
            updatedAt: skill.updatedAt,
            reports: skill.reports,
            hidden: skill.hidden,
            builtin: skill.builtin,
          });
        },
      },
      {
        name: 'skill_market_publish',
        description: '发布技能到市场（需提供完整技能元信息和内容）',
        parameters: {
          skill_json: { type: 'string', description: '技能 JSON 字符串（含 id/name/version/description/author/type/category/tags/content 等字段）', required: true },
          overwrite: { type: 'boolean', description: '是否覆盖已存在的同 ID 技能，默认 false', required: false },
        },
        execute: async (args: { skill_json: string; overwrite?: boolean }) => {
          let skill: Partial<MarketSkill>;
          try {
            skill = JSON.parse(args.skill_json);
          } catch (err: unknown) {
            return JSON.stringify({ success: false, error: `skill_json 解析失败: ${err instanceof Error ? err.message : String(err)}` });
          }
          if (!skill.id || !skill.name || !skill.type || !skill.content) {
            return JSON.stringify({ success: false, error: '缺少必填字段：id/name/type/content' });
          }
          const result = this.publish(skill as MarketSkill, { overwrite: args.overwrite });
          return JSON.stringify(result);
        },
      },
      {
        name: 'skill_market_install',
        description: '从市场下载并安装技能到本地（记录安装状态，实际安装由系统委托给对应模块）',
        parameters: {
          id: { type: 'string', description: '技能 ID', required: true },
        },
        execute: async (args: { id: string }) => {
          const result = await this.install(args.id);
          return JSON.stringify(result);
        },
      },
      {
        name: 'skill_market_rate',
        description: '对市场技能评分（1-5 星，同一用户重复评分将覆盖）',
        parameters: {
          id: { type: 'string', description: '技能 ID', required: true },
          user_id: { type: 'string', description: '评分用户 ID', required: true },
          rating: { type: 'number', description: '评分 1-5（整数）', required: true },
          comment: { type: 'string', description: '可选评论', required: false },
        },
        execute: async (args: { id: string; user_id: string; rating: number; comment?: string }) => {
          const result = this.rate(args.id, args.user_id, args.rating, args.comment);
          return JSON.stringify(result);
        },
      },
      {
        name: 'skill_market_report',
        description: '举报市场技能（低质量/恶意/侵权等），达到阈值自动隐藏',
        parameters: {
          id: { type: 'string', description: '技能 ID', required: true },
          reporter_id: { type: 'string', description: '举报者 ID', required: true },
          reason: { type: 'string', description: '举报原因', required: true },
        },
        execute: async (args: { id: string; reporter_id: string; reason: string }) => {
          const result = this.report(args.id, args.reporter_id, args.reason);
          return JSON.stringify(result);
        },
      },
      {
        name: 'skill_market_stats',
        description: '获取技能市场统计数据（总数/分类分布/下载量/评分/已安装/隐藏）',
        parameters: {},
        readOnly: true,
        execute: async () => {
          return JSON.stringify(this.getStats());
        },
      },
    ];
  }

  /** 技能摘要（用于列表） */
  private summarize(s: MarketSkill): Record<string, unknown> {
    return {
      id: s.id,
      name: s.name,
      version: s.version,
      description: s.description,
      author: s.author,
      type: s.type,
      category: s.category,
      tags: s.tags,
      rating: Number(s.rating.toFixed(2)),
      ratingCount: s.ratingCount,
      downloads: s.downloads,
      maintenanceStatus: s.maintenanceStatus,
      installed: this.installed.has(s.id),
    };
  }
}

/** 获取单例 */
export function getSkillMarket(): SkillMarket {
  return SkillMarket.getInstance();
}
