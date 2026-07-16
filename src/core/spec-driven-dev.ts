/**
 * Spec-Driven Development — SpecDrivenDev
 *
 * 对标 GitHub Spec Kit 实现四阶段结构化任务工件流程：
 * 1. /specify  — 创建需求规范 spec.md（多轮交互澄清）
 * 2. /plan     — 生成技术方案 plan.md
 * 3. /tasks    — 拆解为可执行任务清单 tasks.md
 * 4. /implement — 按任务清单执行
 *
 * 工件目录结构（存储在项目根目录的 spec/ 文件夹下）：
 *   spec/
 *   ├── constitution.md          # 项目宪法（持久约束，全局）
 *   ├── 001-feature-name/
 *   │   ├── spec.md              # 需求规范
 *   │   ├── plan.md              # 技术方案
 *   │   ├── tasks.md             # 任务清单
 *   │   └── checklist.md         # 验收清单
 *
 * 持久化：spec 索引通过 atomicWriteJsonSync 保存到 duanPath('spec-driven') 目录，
 * Markdown 工件文件用 fs.writeFileSync 写入项目 spec/ 目录。
 */

import * as fs from 'fs';
import * as path from 'path';
import { atomicWriteJsonSync } from './atomic-write.js';
import { duanPath } from './duan-paths.js';

// ============ 类型定义 ============

/** Spec 流程阶段 */
export type SpecStage = 'specify' | 'plan' | 'tasks' | 'implement' | 'completed';

/** Spec 项目（一个完整的需求规范流程） */
export interface SpecProject {
  /** Spec ID，三位数字如 "001" */
  id: string;
  /** Spec 名称（kebab-case slug），如 "feature-name" */
  name: string;
  /** 标题（人类可读） */
  title: string;
  /** 需求描述 */
  description: string;
  /** 当前阶段 */
  stage: SpecStage;
  /** 创建时间戳 */
  createdAt: number;
  /** 更新时间戳 */
  updatedAt: number;
  /** spec.md 路径 */
  specPath: string;
  /** plan.md 路径 */
  planPath: string;
  /** tasks.md 路径 */
  tasksPath: string;
  /** checklist.md 路径 */
  checklistPath: string;
  /** 任务列表 */
  tasks: SpecTask[];
}

/** Spec 任务 */
export interface SpecTask {
  /** 任务 ID */
  id: string;
  /** 任务标题 */
  title: string;
  /** 任务描述 */
  description: string;
  /** 任务状态 */
  status: 'pending' | 'in_progress' | 'completed' | 'skipped';
  /** 前置任务 ID 列表 */
  dependencies: string[];
  /** 涉及文件列表 */
  files: string[];
  /** 验收标准列表 */
  acceptanceCriteria: string[];
}

/** Self Check 结果 */
export interface SpecCheckResult {
  /** Spec ID */
  specId: string;
  /** 是否通过 */
  passed: boolean;
  /** 总任务数 */
  totalTasks: number;
  /** 已完成任务数 */
  completedTasks: number;
  /** 待办任务数 */
  pendingTasks: number;
  /** 失败检查项列表 */
  failedChecks: string[];
  /** checklist 条目验证结果 */
  checklistItems: { description: string; passed: boolean }[];
}

// ============ 中文 → 英文 slug 词典 ============

/**
 * 常见中文开发术语 → 英文映射，用于 slugify。
 * 按词组长度降序匹配，优先匹配长词。
 */
const CN_EN_DICT: Record<string, string> = {
  // 长词组优先
  '用户登录': 'user-login',
  '用户注册': 'user-register',
  '用户管理': 'user-management',
  '数据库': 'database',
  '购物车': 'cart',
  '支付': 'payment',
  '订单': 'order',
  '商品': 'product',
  '搜索': 'search',
  '通知': 'notification',
  '消息': 'message',
  '配置': 'config',
  '文档': 'doc',
  '测试': 'test',
  '项目': 'project',
  '任务': 'task',
  '系统': 'system',
  '功能': 'feature',
  '模块': 'module',
  '接口': 'api',
  '页面': 'page',
  '列表': 'list',
  '详情': 'detail',
  '编辑': 'edit',
  '删除': 'delete',
  '添加': 'add',
  '创建': 'create',
  '更新': 'update',
  '导入': 'import',
  '导出': 'export',
  '管理': 'management',
  '用户': 'user',
  '登录': 'login',
  '注册': 'register',
  '数据': 'data',
  '文件': 'file',
  '权限': 'permission',
  '角色': 'role',
  '菜单': 'menu',
  '仪表盘': 'dashboard',
  '图表': 'chart',
  '报表': 'report',
  '日志': 'log',
  '监控': 'monitor',
  '部署': 'deploy',
  '构建': 'build',
  '发布': 'release',
  '版本': 'version',
  '标签': 'tag',
  '分类': 'category',
  '评论': 'comment',
  '点赞': 'like',
  '分享': 'share',
  '收藏': 'favorite',
  '上传': 'upload',
  '下载': 'download',
  '预览': 'preview',
  '审计': 'audit',
  '安全': 'security',
  '认证': 'auth',
  '令牌': 'token',
  '密钥': 'secret',
  '会话': 'session',
  '缓存': 'cache',
  '队列': 'queue',
  '调度': 'schedule',
  '工作流': 'workflow',
  '流水线': 'pipeline',
};

/** 词典键按长度降序排列，优先匹配长词 */
const SORTED_DICT_KEYS = Object.keys(CN_EN_DICT).sort((a, b) => b.length - a.length);

/**
 * 将标题转换为 kebab-case slug
 *
 * 策略：
 * 1. 先尝试中文词典匹配（最长匹配优先）
 * 2. 剩余非 CJK 字符按常规 slugify（小写 + 连字符）
 * 3. 未知 CJK 字符跳过
 *
 * @example
 *   slugify('用户登录')   // => 'user-login'
 *   slugify('User Login') // => 'user-login'
 *   slugify('feature-A')  // => 'feature-a'
 */
function slugify(title: string): string {
  if (!title) return 'untitled';
  let result = title.trim();

  // 中文词典匹配：替换已知中文词组为英文
  for (const cn of SORTED_DICT_KEYS) {
    if (result.includes(cn)) {
      result = result.split(cn).join(` ${CN_EN_DICT[cn]} `);
    }
  }

  // 转小写
  result = result.toLowerCase();

  // 非 CJK 字符：保留 a-z 0-9，其他替换为连字符
  result = result.replace(/[^a-z0-9\u4e00-\u9fff]+/g, '-');

  // 移除未知 CJK 字符（未被词典匹配的）
  result = result.replace(/[\u4e00-\u9fff]+/g, '');

  // 合并连续连字符
  result = result.replace(/-+/g, '-');

  // 去除首尾连字符
  result = result.replace(/^-+|-+$/g, '');

  return result || 'untitled';
}

// ============ SpecDrivenDev 类 ============

export class SpecDrivenDev {
  /** 项目根目录（spec/ 文件夹所在位置） */
  private cwd: string;
  /** spec 工件根目录 */
  private specRoot: string;
  /** spec 索引存储目录（duanPath('spec-driven')） */
  private indexDir: string;
  /** 索引文件路径 */
  private indexPath: string;
  /** 内存中的 spec 索引（id → SpecProject） */
  private specs: Map<string, SpecProject> = new Map();

  constructor(private options: { cwd?: string; indexDir?: string } = {}) {
    this.cwd = options.cwd ?? process.cwd();
    this.specRoot = path.join(this.cwd, 'spec');
    // 默认使用 duanPath('spec-driven')，可通过 options.indexDir 覆盖（用于测试隔离）
    this.indexDir = options.indexDir ?? duanPath('spec-driven');
    this.indexPath = path.join(this.indexDir, 'index.json');
    this.ensureDir(this.indexDir);
    this.ensureDir(this.specRoot);
    this.loadIndex();
  }

  // ============ 公开 API ============

  /**
   * 创建新 spec（第 1 阶段 /specify）
   *
   * 生成 spec.md 需求规范文件，创建 spec 目录结构。
   * @param title       规范标题
   * @param description 需求描述
   * @param options     额外选项（constitution 为可选的宪法引用）
   * @returns 创建的 SpecProject
   */
  createSpec(
    title: string,
    description: string,
    options?: { constitution?: string },
  ): SpecProject {
    const id = this.generateSpecId();
    const name = slugify(title);
    const dir = path.join(this.specRoot, `${id}-${name}`);
    this.ensureDir(dir);

    const now = Date.now();
    const specPath = path.join(dir, 'spec.md');
    const planPath = path.join(dir, 'plan.md');
    const tasksPath = path.join(dir, 'tasks.md');
    const checklistPath = path.join(dir, 'checklist.md');

    // 生成 spec.md（需求规范）
    const constitution = options?.constitution ?? this.loadConstitution();
    const specContent = this.renderSpecMarkdown(title, description, constitution);
    fs.writeFileSync(specPath, specContent, 'utf-8');

    // 生成 checklist.md（初始空模板）
    const checklistContent = this.renderChecklistMarkdown([]);
    fs.writeFileSync(checklistPath, checklistContent, 'utf-8');

    const project: SpecProject = {
      id,
      name,
      title,
      description,
      stage: 'specify',
      createdAt: now,
      updatedAt: now,
      specPath,
      planPath,
      tasksPath,
      checklistPath,
      tasks: [],
    };

    this.specs.set(id, project);
    this.saveIndex();
    return project;
  }

  /**
   * 生成技术方案（第 2 阶段 /plan）
   *
   * 生成 plan.md 技术方案文件，阶段更新为 plan。
   * @param specId       Spec ID
   * @param techStack    技术栈列表
   * @param architecture 架构描述
   */
  generatePlan(specId: string, techStack: string[], architecture: string): void {
    const spec = this.specs.get(specId);
    if (!spec) throw new Error(`Spec 不存在: ${specId}`);

    const content = this.renderPlanMarkdown(spec, techStack, architecture);
    fs.writeFileSync(spec.planPath, content, 'utf-8');

    spec.stage = 'plan';
    spec.updatedAt = Date.now();
    this.saveIndex();
  }

  /**
   * 拆解任务（第 3 阶段 /tasks）
   *
   * 生成 tasks.md 任务清单文件，阶段更新为 tasks。
   * @param specId Spec ID
   * @param tasks  任务列表
   */
  generateTasks(specId: string, tasks: SpecTask[]): void {
    const spec = this.specs.get(specId);
    if (!spec) throw new Error(`Spec 不存在: ${specId}`);

    spec.tasks = tasks.map((t) => ({ ...t, status: t.status ?? 'pending' }));
    const content = this.renderTasksMarkdown(spec);
    fs.writeFileSync(spec.tasksPath, content, 'utf-8');

    // 同时更新 checklist.md（基于任务的验收标准）
    const checklistContent = this.renderChecklistFromTasks(spec);
    fs.writeFileSync(spec.checklistPath, checklistContent, 'utf-8');

    spec.stage = 'tasks';
    spec.updatedAt = Date.now();
    this.saveIndex();
  }

  /**
   * 获取下一个待执行任务（第 4 阶段 /implement）
   *
   * 返回第一个 pending 且所有依赖已完成的任务。
   * 如果有 in_progress 任务，优先返回它。
   * @param specId Spec ID
   * @returns 下一个任务，或 null
   */
  getNextTask(specId: string): SpecTask | null {
    const spec = this.specs.get(specId);
    if (!spec) return null;

    // 优先返回进行中的任务
    const inProgress = spec.tasks.find((t) => t.status === 'in_progress');
    if (inProgress) return inProgress;

    // 查找所有依赖已完成的 pending 任务
    for (const task of spec.tasks) {
      if (task.status !== 'pending') continue;
      const depsOk = task.dependencies.every((depId) => {
        const dep = spec.tasks.find((t) => t.id === depId);
        return dep && dep.status === 'completed';
      });
      if (depsOk) {
        // 首次获取任务时，将阶段切换到 implement
        if (spec.stage === 'tasks') {
          spec.stage = 'implement';
          spec.updatedAt = Date.now();
          this.saveIndex();
        }
        return task;
      }
    }
    return null;
  }

  /**
   * 标记任务完成
   *
   * @param specId  Spec ID
   * @param taskId  任务 ID
   */
  completeTask(specId: string, taskId: string): void {
    const spec = this.specs.get(specId);
    if (!spec) throw new Error(`Spec 不存在: ${specId}`);

    const task = spec.tasks.find((t) => t.id === taskId);
    if (!task) throw new Error(`任务不存在: ${taskId}`);

    task.status = 'completed';
    spec.updatedAt = Date.now();

    // 如果阶段还是 tasks，切换到 implement
    if (spec.stage === 'tasks') {
      spec.stage = 'implement';
    }

    // 如果所有任务都已完成，切换到 completed
    const allDone = spec.tasks.every(
      (t) => t.status === 'completed' || t.status === 'skipped',
    );
    if (allDone && spec.tasks.length > 0) {
      spec.stage = 'completed';
    }

    // 更新 tasks.md
    const content = this.renderTasksMarkdown(spec);
    fs.writeFileSync(spec.tasksPath, content, 'utf-8');

    this.saveIndex();
  }

  /**
   * Self Check — 验证当前实现是否符合 spec.md 和 checklist.md
   *
   * @param specId Spec ID
   * @returns 检查结果
   */
  checkSpec(specId: string): SpecCheckResult {
    const spec = this.specs.get(specId);
    if (!spec) {
      return {
        specId,
        passed: false,
        totalTasks: 0,
        completedTasks: 0,
        pendingTasks: 0,
        failedChecks: [`Spec 不存在: ${specId}`],
        checklistItems: [],
      };
    }

    const totalTasks = spec.tasks.length;
    const completedTasks = spec.tasks.filter((t) => t.status === 'completed').length;
    const pendingTasks = spec.tasks.filter(
      (t) => t.status === 'pending' || t.status === 'in_progress',
    ).length;
    const skippedTasks = spec.tasks.filter((t) => t.status === 'skipped').length;

    const failedChecks: string[] = [];

    // 检查 1：spec.md 是否存在
    if (!fs.existsSync(spec.specPath)) {
      failedChecks.push('spec.md 不存在');
    }

    // 检查 2：plan.md 是否存在
    if (!fs.existsSync(spec.planPath)) {
      failedChecks.push('plan.md 不存在');
    }

    // 检查 3：tasks.md 是否存在
    if (!fs.existsSync(spec.tasksPath)) {
      failedChecks.push('tasks.md 不存在');
    }

    // 检查 4：所有任务是否已完成
    if (pendingTasks > 0) {
      failedChecks.push(`还有 ${pendingTasks} 个任务未完成`);
    }

    // 解析 checklist.md 并验证
    const checklistItems = this.parseChecklist(spec.checklistPath);

    // 如果没有 checklist 条目且有任务，从任务验收标准生成
    if (checklistItems.length === 0 && spec.tasks.length > 0) {
      for (const task of spec.tasks) {
        for (const criteria of task.acceptanceCriteria) {
          const passed = task.status === 'completed';
          checklistItems.push({ description: `[${task.id}] ${criteria}`, passed });
          if (!passed) {
            failedChecks.push(`任务 ${task.id} 验收标准未满足: ${criteria}`);
          }
        }
      }
    }

    const passed =
      failedChecks.length === 0 &&
      completedTasks + skippedTasks === totalTasks &&
      totalTasks > 0;

    return {
      specId,
      passed,
      totalTasks,
      completedTasks,
      pendingTasks,
      failedChecks,
      checklistItems,
    };
  }

  /**
   * 列出所有 spec
   * @returns SpecProject 数组（按创建时间升序）
   */
  listSpecs(): SpecProject[] {
    return Array.from(this.specs.values()).sort((a, b) => a.createdAt - b.createdAt);
  }

  /**
   * 获取 spec 详情
   * @param specId Spec ID
   * @returns SpecProject 或 null
   */
  getSpec(specId: string): SpecProject | null {
    return this.specs.get(specId) ?? null;
  }

  /**
   * 创建 constitution.md（项目宪法）
   *
   * 持久约束，全局生效，写入 spec/constitution.md。
   * @param content 宪法内容
   */
  createConstitution(content: string): void {
    const constitutionPath = path.join(this.specRoot, 'constitution.md');
    fs.writeFileSync(constitutionPath, content, 'utf-8');
  }

  /**
   * 加载 constitution
   * @returns 宪法内容，或 null（不存在时）
   */
  loadConstitution(): string | null {
    const constitutionPath = path.join(this.specRoot, 'constitution.md');
    if (!fs.existsSync(constitutionPath)) return null;
    try {
      return fs.readFileSync(constitutionPath, 'utf-8');
    } catch {
      return null;
    }
  }

  // ============ 内部实现 ============

  /** 确保目录存在 */
  private ensureDir(dir: string): void {
    if (!fs.existsSync(dir)) {
      fs.mkdirSync(dir, { recursive: true });
    }
  }

  /** 生成三位数字递增的 spec ID */
  private generateSpecId(): string {
    let maxNum = 0;
    for (const id of Array.from(this.specs.keys())) {
      const num = parseInt(id, 10);
      if (!isNaN(num) && num > maxNum) maxNum = num;
    }
    return String(maxNum + 1).padStart(3, '0');
  }

  /** 加载索引文件 */
  private loadIndex(): void {
    try {
      if (!fs.existsSync(this.indexPath)) return;
      const content = fs.readFileSync(this.indexPath, 'utf-8');
      const data = JSON.parse(content) as SpecProject[];
      for (const spec of data) {
        this.specs.set(spec.id, spec);
      }
    } catch {
      // 索引文件损坏时忽略，从空开始
    }
  }

  /** 保存索引文件 */
  private saveIndex(): void {
    try {
      const data = Array.from(this.specs.values());
      atomicWriteJsonSync(this.indexPath, data);
    } catch {
      // 保存失败忽略
    }
  }

  // ============ Markdown 渲染 ============

  /** 渲染 spec.md */
  private renderSpecMarkdown(title: string, description: string, constitution?: string | null): string {
    const lines: string[] = [];
    lines.push(`# ${title}`);
    lines.push('');
    lines.push('## 需求描述');
    lines.push('');
    lines.push(description);
    lines.push('');
    lines.push('## 验收标准');
    lines.push('');
    lines.push('<!-- 在此处添加验收标准 -->');
    lines.push('');
    if (constitution) {
      lines.push('## 项目宪法约束');
      lines.push('');
      lines.push('```');
      lines.push(constitution);
      lines.push('```');
      lines.push('');
    }
    lines.push('---');
    lines.push(`> 创建时间: ${new Date().toISOString()}`);
    lines.push('');
    return lines.join('\n');
  }

  /** 渲染 plan.md */
  private renderPlanMarkdown(spec: SpecProject, techStack: string[], architecture: string): string {
    const lines: string[] = [];
    lines.push(`# 技术方案: ${spec.title}`);
    lines.push('');
    lines.push('## 技术栈');
    lines.push('');
    for (const tech of techStack) {
      lines.push(`- ${tech}`);
    }
    lines.push('');
    lines.push('## 架构设计');
    lines.push('');
    lines.push(architecture);
    lines.push('');
    lines.push('## 实现步骤');
    lines.push('');
    lines.push('<!-- 在此处添加实现步骤 -->');
    lines.push('');
    lines.push('---');
    lines.push(`> Spec ID: ${spec.id}`);
    lines.push(`> 更新时间: ${new Date().toISOString()}`);
    lines.push('');
    return lines.join('\n');
  }

  /** 渲染 tasks.md */
  private renderTasksMarkdown(spec: SpecProject): string {
    const lines: string[] = [];
    lines.push(`# 任务清单: ${spec.title}`);
    lines.push('');
    lines.push('| ID | 任务 | 状态 | 依赖 | 文件 |');
    lines.push('| --- | --- | --- | --- | --- |');
    for (const task of spec.tasks) {
      const statusIcon = {
        pending: '⬜',
        in_progress: '🔄',
        completed: '✅',
        skipped: '⏭️',
      }[task.status];
      lines.push(
        `| ${task.id} | ${task.title} | ${statusIcon} ${task.status} | ${task.dependencies.join(', ') || '-'} | ${task.files.join(', ') || '-'} |`,
      );
    }
    lines.push('');
    lines.push('## 任务详情');
    lines.push('');
    for (const task of spec.tasks) {
      lines.push(`### ${task.id}: ${task.title}`);
      lines.push('');
      lines.push(`- **状态**: ${task.status}`);
      lines.push(`- **描述**: ${task.description}`);
      if (task.dependencies.length > 0) {
        lines.push(`- **依赖**: ${task.dependencies.join(', ')}`);
      }
      if (task.files.length > 0) {
        lines.push(`- **涉及文件**: ${task.files.join(', ')}`);
      }
      if (task.acceptanceCriteria.length > 0) {
        lines.push('- **验收标准**:');
        for (const criteria of task.acceptanceCriteria) {
          lines.push(`  - ${criteria}`);
        }
      }
      lines.push('');
    }
    lines.push('---');
    lines.push(`> Spec ID: ${spec.id}`);
    lines.push(`> 更新时间: ${new Date().toISOString()}`);
    lines.push('');
    return lines.join('\n');
  }

  /** 渲染 checklist.md（初始空模板） */
  private renderChecklistMarkdown(items: string[]): string {
    const lines: string[] = [];
    lines.push('# 验收清单');
    lines.push('');
    if (items.length === 0) {
      lines.push('<!-- 任务生成后将自动填充 -->');
    } else {
      for (const item of items) {
        lines.push(`- [ ] ${item}`);
      }
    }
    lines.push('');
    return lines.join('\n');
  }

  /** 从任务列表生成 checklist.md 内容 */
  private renderChecklistFromTasks(spec: SpecProject): string {
    const items: string[] = [];
    for (const task of spec.tasks) {
      for (const criteria of task.acceptanceCriteria) {
        items.push(`[${task.id}] ${criteria}`);
      }
      // 如果任务没有验收标准，用任务标题作为条目
      if (task.acceptanceCriteria.length === 0) {
        items.push(`[${task.id}] ${task.title}`);
      }
    }
    const lines: string[] = [];
    lines.push('# 验收清单');
    lines.push('');
    for (const item of items) {
      lines.push(`- [ ] ${item}`);
    }
    lines.push('');
    lines.push('---');
    lines.push(`> Spec ID: ${spec.id}`);
    lines.push('');
    return lines.join('\n');
  }

  /** 解析 checklist.md，返回条目列表 */
  private parseChecklist(checklistPath: string): { description: string; passed: boolean }[] {
    if (!fs.existsSync(checklistPath)) return [];
    try {
      const content = fs.readFileSync(checklistPath, 'utf-8');
      const items: { description: string; passed: boolean }[] = [];
      const lines = content.split('\n');
      for (const line of lines) {
        const match = line.match(/^\s*- \[(x|X| )\] (.+)$/);
        if (match) {
          items.push({
            description: match[2].trim(),
            passed: match[1].toLowerCase() === 'x',
          });
        }
      }
      return items;
    } catch {
      return [];
    }
  }
}

// ============ LLM 工具定义 ============

/**
 * Spec-Driven Development LLM 工具定义
 *
 * 返回 7 个工具定义：
 * - spec_create:    创建新的需求规范
 * - spec_plan:      生成技术方案
 * - spec_tasks:     拆解任务清单
 * - spec_implement: 获取下一个待执行任务
 * - spec_check:     Self Check
 * - spec_list:      列出所有 spec
 * - spec_get:       获取 spec 详情
 */
export function getSpecDrivenToolDefinitions() {
  return [
    {
      name: 'spec_create',
      description: '创建新的需求规范（Spec-Driven Development 第 1 阶段）',
      inputSchema: {
        type: 'object' as const,
        properties: {
          title: { type: 'string', description: '规范标题' },
          description: { type: 'string', description: '需求描述' },
          constitution: { type: 'string', description: '项目宪法内容（可选）' },
        },
        required: ['title', 'description'],
      },
    },
    {
      name: 'spec_plan',
      description: '生成技术方案（Spec-Driven Development 第 2 阶段）',
      inputSchema: {
        type: 'object' as const,
        properties: {
          specId: { type: 'string', description: 'Spec ID（如 001）' },
          techStack: {
            type: 'array',
            items: { type: 'string' },
            description: '技术栈列表',
          },
          architecture: { type: 'string', description: '架构描述' },
        },
        required: ['specId', 'techStack', 'architecture'],
      },
    },
    {
      name: 'spec_tasks',
      description: '拆解任务清单（Spec-Driven Development 第 3 阶段）',
      inputSchema: {
        type: 'object' as const,
        properties: {
          specId: { type: 'string', description: 'Spec ID' },
          tasks: {
            type: 'array',
            items: {
              type: 'object',
              properties: {
                id: { type: 'string', description: '任务 ID' },
                title: { type: 'string', description: '任务标题' },
                description: { type: 'string', description: '任务描述' },
                dependencies: {
                  type: 'array',
                  items: { type: 'string' },
                  description: '前置任务 ID 列表',
                },
                files: {
                  type: 'array',
                  items: { type: 'string' },
                  description: '涉及文件列表',
                },
                acceptanceCriteria: {
                  type: 'array',
                  items: { type: 'string' },
                  description: '验收标准列表',
                },
              },
              required: ['id', 'title', 'description'],
            },
            description: '任务列表',
          },
        },
        required: ['specId', 'tasks'],
      },
    },
    {
      name: 'spec_implement',
      description: '获取下一个待执行任务并标记为进行中（Spec-Driven Development 第 4 阶段）',
      inputSchema: {
        type: 'object' as const,
        properties: {
          specId: { type: 'string', description: 'Spec ID' },
          action: {
            type: 'string',
            description: '操作: next（获取下一任务）/ complete（完成任务）',
          },
          taskId: { type: 'string', description: '完成任务时指定任务 ID' },
        },
        required: ['specId', 'action'],
      },
    },
    {
      name: 'spec_check',
      description: 'Self Check — 验证当前实现是否符合 spec.md 和 checklist.md',
      inputSchema: {
        type: 'object' as const,
        properties: {
          specId: { type: 'string', description: 'Spec ID' },
        },
        required: ['specId'],
      },
    },
    {
      name: 'spec_list',
      description: '列出所有 spec 项目',
      inputSchema: {
        type: 'object' as const,
        properties: {
          stage: { type: 'string', description: '按阶段过滤: specify/plan/tasks/implement/completed' },
        },
      },
    },
    {
      name: 'spec_get',
      description: '获取 spec 项目详情',
      inputSchema: {
        type: 'object' as const,
        properties: {
          specId: { type: 'string', description: 'Spec ID' },
        },
        required: ['specId'],
      },
    },
  ];
}

/**
 * Spec-Driven Development 工具处理器
 *
 * @param manager SpecDrivenDev 实例
 * @returns 异步工具处理函数
 */
export function createSpecDrivenToolHandler(manager: SpecDrivenDev) {
  return async (toolName: string, args: Record<string, unknown>): Promise<unknown> => {
    switch (toolName) {
      case 'spec_create': {
        const { title, description, constitution } = args as {
          title: string;
          description: string;
          constitution?: string;
        };
        const spec = manager.createSpec(title, description, { constitution });
        return {
          specId: spec.id,
          name: spec.name,
          stage: spec.stage,
          specPath: spec.specPath,
        };
      }
      case 'spec_plan': {
        const { specId, techStack, architecture } = args as {
          specId: string;
          techStack: string[];
          architecture: string;
        };
        try {
          manager.generatePlan(specId, techStack, architecture);
          return { specId, generated: true };
        } catch (e) {
          return { error: (e as Error).message };
        }
      }
      case 'spec_tasks': {
        const { specId, tasks } = args as { specId: string; tasks: SpecTask[] };
        try {
          manager.generateTasks(specId, tasks);
          return { specId, taskCount: tasks.length };
        } catch (e) {
          return { error: (e as Error).message };
        }
      }
      case 'spec_implement': {
        const { specId, action, taskId } = args as {
          specId: string;
          action: string;
          taskId?: string;
        };
        if (action === 'next') {
          const task = manager.getNextTask(specId);
          if (!task) return { task: null, message: '没有可执行的任务' };
          return { task };
        }
        if (action === 'complete') {
          if (!taskId) return { error: '完成任务需要 taskId' };
          try {
            manager.completeTask(specId, taskId);
            return { completed: true, taskId };
          } catch (e) {
            return { error: (e as Error).message };
          }
        }
        return { error: `未知 action: ${action}` };
      }
      case 'spec_check': {
        const { specId } = args as { specId: string };
        return manager.checkSpec(specId);
      }
      case 'spec_list': {
        const { stage } = args as { stage?: SpecStage };
        let specs = manager.listSpecs();
        if (stage) specs = specs.filter((s) => s.stage === stage);
        return specs.map((s) => ({
          id: s.id,
          name: s.name,
          title: s.title,
          stage: s.stage,
          taskCount: s.tasks.length,
          completedTasks: s.tasks.filter((t) => t.status === 'completed').length,
        }));
      }
      case 'spec_get': {
        const { specId } = args as { specId: string };
        const spec = manager.getSpec(specId);
        if (!spec) return { error: `Spec 不存在: ${specId}` };
        return spec;
      }
      default:
        return { error: `未知工具: ${toolName}` };
    }
  };
}
