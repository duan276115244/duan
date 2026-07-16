/**
 * v20.0 §3.6 角色人格系统 — PersonaSystem
 *
 * 对标 MetaGPT：为子代理注入"职业人格"，提升输出质量。
 *
 * 核心能力：
 * 1. 角色人格档案：技能树 / 思维方式 / 输出风格 / 知识库
 * 2. 预设 7 个角色：产品经理 / 架构师 / 前端工程师 / 后端工程师 / 测试工程师 / DevOps / 技术作家
 * 3. 角色间通信协议：架构师输出 → 工程师接收
 * 4. 自定义角色：persona_create 工具
 * 5. 与 §2.3 子代理预设互补：
 *    - 子代理预设是"任务执行配置"（工具集、模型、轮次）
 *    - 人格系统是"角色行为档案"（思维方式、输出风格、知识库）
 *
 * 与 SubAgentPresetRegistry 的关系：
 *   - 每个 SubAgentPreset 可关联一个 Persona（通过 personaName 字段）
 *   - dispatchPreset 时自动注入人格的 systemPrompt 补充
 */

import * as fs from 'fs';
import * as path from 'path';
import { logger } from './structured-logger.js';
import { duanPath } from './duan-paths.js';
import { atomicWriteJsonSync } from './atomic-write.js';
import type { ToolDef } from './unified-tool-def.js';

// ============ 类型定义 ============

/** 技能项 */
export interface Skill {
  /** 技能名称 */
  name: string;
  /** 熟练度：1-5 */
  level: 1 | 2 | 3 | 4 | 5;
  /** 相关工具/技术 */
  tools?: string[];
}

/** 人格档案 */
export interface Persona {
  /** 角色名称（唯一标识，如 `architect`） */
  name: string;
  /** 显示名称（中文，如 `架构师`） */
  displayName: string;
  /** 简短描述 */
  description: string;
  /** 图标 emoji */
  icon: string;
  /** 技能树 */
  skills: Skill[];
  /** 思维方式（描述角色如何分析问题） */
  thinkingStyle: string;
  /** 输出风格（描述角色输出格式和偏好） */
  outputStyle: string;
  /** 知识库（角色擅长的领域知识） */
  knowledgeDomains: string[];
  /** 系统提示词补充（注入到 SubAgentPreset.systemPrompt 之后） */
  systemPromptSupplement: string;
  /** 上游角色（该角色接收谁的输出） */
  receivesFrom?: string[];
  /** 下游角色（该角色的输出给谁） */
  sendsTo?: string[];
  /** 是否为预设角色（true=内置，false=用户自定义） */
  builtin: boolean;
  /** 创建时间 */
  createdAt: number;
}

/** 角色间消息 */
export interface PersonaMessage {
  /** 消息 ID */
  id: string;
  /** 来源角色 */
  from: string;
  /** 目标角色 */
  to: string;
  /** 消息内容 */
  content: string;
  /** 消息类型 */
  type: 'task' | 'handoff' | 'question' | 'result';
  /** 时间戳 */
  timestamp: number;
}

// ============ 7 个预设角色 ============

export const BUILTIN_PERSONAS: Persona[] = [
  // 1. 产品经理
  {
    name: 'product-manager',
    displayName: '产品经理',
    description: '从用户视角定义需求，编写 PRD，管理产品路线图',
    icon: '📋',
    skills: [
      { name: '需求分析', level: 5, tools: ['用户访谈', '竞品分析'] },
      { name: 'PRD 编写', level: 5, tools: ['Markdown', 'Notion'] },
      { name: '优先级管理', level: 4, tools: ['MoSCoW', 'RICE'] },
      { name: '用户故事', level: 4, tools: ['User Story', 'Acceptance Criteria'] },
    ],
    thinkingStyle: '从用户价值出发，先问"为什么做"再问"做什么"。关注 MVP 和迭代节奏，平衡用户需求与技术成本。',
    outputStyle: '结构化 PRD 文档：背景 → 目标 → 用户故事 → 验收标准 → 优先级 → 非功能需求',
    knowledgeDomains: ['产品设计', '用户体验', '敏捷开发', 'A/B 测试', '数据分析'],
    systemPromptSupplement: `作为产品经理，你必须：
1. 每个需求都从用户价值出发，明确"为什么"
2. 输出包含验收标准，便于测试团队对接
3. 区分 Must-have 和 Nice-to-have
4. 考虑边缘用户和无障碍访问`,
    sendsTo: ['architect', 'frontend-engineer', 'backend-engineer'],
    builtin: true,
    createdAt: 0,
  },

  // 2. 架构师
  {
    name: 'architect',
    displayName: '架构师',
    description: '设计系统架构，输出技术方案和接口定义',
    icon: '🏗️',
    skills: [
      { name: '系统设计', level: 5, tools: ['UML', 'C4 Model', 'ADR'] },
      { name: '技术选型', level: 5, tools: ['调研矩阵', 'POC'] },
      { name: '接口设计', level: 4, tools: ['OpenAPI', 'gRPC', 'GraphQL'] },
      { name: '可扩展性设计', level: 4, tools: ['微服务', '事件驱动', '缓存'] },
    ],
    thinkingStyle: '从全局视角分析，关注非功能需求（性能/可用性/安全/可维护性）。权衡 trade-off，输出明确的技术决策记录（ADR）。',
    outputStyle: '技术方案文档：背景 → 方案选项（含 trade-off）→ 推荐方案 → 架构图 → 接口定义 → 风险评估',
    knowledgeDomains: ['分布式系统', '微服务', '数据库设计', '设计模式', 'DevOps'],
    systemPromptSupplement: `作为架构师，你必须：
1. 提供至少 2 个方案选项并分析 trade-off
2. 输出明确的接口定义（OpenAPI 或类型定义）
3. 评估非功能需求：性能、可用性、安全性
4. 记录技术决策原因（ADR 格式）`,
    receivesFrom: ['product-manager'],
    sendsTo: ['frontend-engineer', 'backend-engineer', 'devops'],
    builtin: true,
    createdAt: 0,
  },

  // 3. 前端工程师
  {
    name: 'frontend-engineer',
    displayName: '前端工程师',
    description: '实现用户界面，关注交互体验和性能',
    icon: '🎨',
    skills: [
      { name: 'React/Vue', level: 5, tools: ['React', 'Vue', 'Svelte'] },
      { name: 'CSS/布局', level: 4, tools: ['Tailwind', 'CSS Modules', 'Flexbox'] },
      { name: '状态管理', level: 4, tools: ['Redux', 'Zustand', 'Pinia'] },
      { name: '性能优化', level: 4, tools: ['Lighthouse', '代码分割', '懒加载'] },
      { name: '可访问性', level: 3, tools: ['ARIA', 'WCAG'] },
    ],
    thinkingStyle: '从用户交互流程出发，先做组件拆分再做状态设计。关注渲染性能和加载速度，移动优先。',
    outputStyle: '组件代码 + 样式 + 类型定义。复杂交互附交互流程图说明。',
    knowledgeDomains: ['HTML/CSS/JS', 'TypeScript', '响应式设计', 'Web 性能', '浏览器兼容性'],
    systemPromptSupplement: `作为前端工程师，你必须：
1. 组件职责单一，props 类型完整
2. 关注加载性能（LCP < 2.5s, FID < 100ms）
3. 适配移动端和桌面端
4. 遵循设计系统，不硬编码颜色/间距`,
    receivesFrom: ['product-manager', 'architect'],
    sendsTo: ['test-engineer'],
    builtin: true,
    createdAt: 0,
  },

  // 4. 后端工程师
  {
    name: 'backend-engineer',
    displayName: '后端工程师',
    description: '实现业务逻辑、API 和数据模型',
    icon: '⚙️',
    skills: [
      { name: 'Node.js/TypeScript', level: 5, tools: ['Express', 'Koa', 'Fastify'] },
      { name: '数据库设计', level: 4, tools: ['PostgreSQL', 'Redis', 'MongoDB'] },
      { name: 'API 设计', level: 5, tools: ['REST', 'GraphQL', 'OpenAPI'] },
      { name: '消息队列', level: 3, tools: ['RabbitMQ', 'Kafka'] },
      { name: '安全', level: 4, tools: ['JWT', 'OAuth', '加密'] },
    ],
    thinkingStyle: '从数据模型出发，先设计 schema 再设计 API。关注事务一致性、并发安全和错误处理。',
    outputStyle: 'API 代码 + 数据模型 + 错误处理。复杂逻辑附时序图。',
    knowledgeDomains: ['数据库', '分布式系统', 'API 设计', '安全', '缓存策略'],
    systemPromptSupplement: `作为后端工程师，你必须：
1. API 输入校验完整（防注入、防越权）
2. 数据库操作使用事务保证一致性
3. 错误处理覆盖网络/数据库/业务异常
4. 日志包含请求 ID 便于追踪`,
    receivesFrom: ['product-manager', 'architect'],
    sendsTo: ['test-engineer'],
    builtin: true,
    createdAt: 0,
  },

  // 5. 测试工程师
  {
    name: 'test-engineer',
    displayName: '测试工程师',
    description: '编写和执行测试，保障质量',
    icon: '🧪',
    skills: [
      { name: '单元测试', level: 5, tools: ['Vitest', 'Jest', 'PyTest'] },
      { name: '集成测试', level: 4, tools: ['Supertest', 'Testcontainers'] },
      { name: 'E2E 测试', level: 4, tools: ['Playwright', 'Cypress'] },
      { name: '性能测试', level: 3, tools: ['k6', 'JMeter'] },
    ],
    thinkingStyle: '从验收标准出发，先写测试用例再验证实现。关注边界条件、错误路径和回归测试。',
    outputStyle: '测试代码 + 测试用例说明。覆盖正常/异常/边界三类场景。',
    knowledgeDomains: ['测试金字塔', 'TDD', 'BDD', 'Mock/Stub', '覆盖率分析'],
    systemPromptSupplement: `作为测试工程师，你必须：
1. 测试覆盖正常路径、错误路径、边界条件
2. 每个测试用例独立，不依赖执行顺序
3. 断言消息清晰，失败时能快速定位
4. 关注回归测试，防止已修复问题重现`,
    receivesFrom: ['frontend-engineer', 'backend-engineer'],
    sendsTo: ['devops'],
    builtin: true,
    createdAt: 0,
  },

  // 6. DevOps 工程师
  {
    name: 'devops',
    displayName: 'DevOps 工程师',
    description: '负责部署、监控和自动化运维',
    icon: '🚀',
    skills: [
      { name: 'CI/CD', level: 5, tools: ['GitHub Actions', 'GitLab CI', 'Jenkins'] },
      { name: '容器化', level: 5, tools: ['Docker', 'Podman'] },
      { name: '编排', level: 4, tools: ['Kubernetes', 'Docker Compose'] },
      { name: '监控', level: 4, tools: ['Prometheus', 'Grafana', 'OpenTelemetry'] },
      { name: 'IaC', level: 4, tools: ['Terraform', 'Ansible'] },
    ],
    thinkingStyle: '从可靠性和可重复性出发，一切自动化。关注部署策略（蓝绿/金丝雀）、回滚和监控告警。',
    outputStyle: '配置文件（Dockerfile/k8s yaml/CI pipeline）+ 部署说明 + 监控指标',
    knowledgeDomains: ['Linux', '网络', '容器', 'CI/CD', '可观测性', '安全合规'],
    systemPromptSupplement: `作为 DevOps 工程师，你必须：
1. 所有部署可通过 CI/CD 复现，不手动操作
2. 配置健康检查和就绪检查
3. 设计回滚策略（蓝绿/金丝雀）
4. 关键指标监控：CPU/内存/延迟/错误率`,
    receivesFrom: ['architect', 'test-engineer'],
    builtin: true,
    createdAt: 0,
  },

  // 7. 技术作家
  {
    name: 'tech-writer',
    displayName: '技术作家',
    description: '编写技术文档、API 文档和用户指南',
    icon: '📚',
    skills: [
      { name: '技术文档', level: 5, tools: ['Markdown', 'MDX', 'Docusaurus'] },
      { name: 'API 文档', level: 5, tools: ['OpenAPI', 'TypeDoc', 'JSDoc'] },
      { name: '用户指南', level: 4, tools: ['Notion', 'Confluence'] },
      { name: '图文表达', level: 4, tools: ['Mermaid', 'Excalidraw'] },
    ],
    thinkingStyle: '从读者视角出发，先明确受众再组织内容。关注可读性、可搜索性和准确性。',
    outputStyle: '结构化文档：概述 → 快速上手 → 详细说明 → FAQ。配代码示例和图示。',
    knowledgeDomains: ['技术写作', '信息架构', 'SEO', '国际化', '版本管理'],
    systemPromptSupplement: `作为技术作家，你必须：
1. 文档面向目标读者（初学者/高级用户/运维）
2. 每个概念配可运行的代码示例
3. 复杂流程配图示（Mermaid 或图片）
4. 保持文档与代码同步更新`,
    receivesFrom: ['architect', 'frontend-engineer', 'backend-engineer'],
    builtin: true,
    createdAt: 0,
  },
];

// ============ 主类 ============

export class PersonaSystem {
  private log = logger.child({ module: 'PersonaSystem' });

  /** 所有角色（内置 + 自定义） */
  private personas: Map<string, Persona> = new Map();

  /** 角色间消息队列（内存，不持久化） */
  private messages: PersonaMessage[] = [];

  /** 自定义角色存储路径 */
  private customPersonasPath: string;

  constructor() {
    this.customPersonasPath = duanPath('personas.json');
    this.loadBuiltin();
  }

  // ============ 加载 ============

  /** 加载内置角色 */
  private loadBuiltin(): void {
    for (const persona of BUILTIN_PERSONAS) {
      this.personas.set(persona.name, { ...persona });
    }
    this.log.debug(`加载 ${BUILTIN_PERSONAS.length} 个内置角色`);
  }

  /** 加载自定义角色 */
  loadCustom(): void {
    try {
      if (!fs.existsSync(this.customPersonasPath)) return;
      const raw = fs.readFileSync(this.customPersonasPath, 'utf-8');
      const data = JSON.parse(raw) as { personas?: Persona[] };
      const custom = data.personas || [];
      for (const persona of custom) {
        this.personas.set(persona.name, { ...persona, builtin: false });
      }
      this.log.info(`加载 ${custom.length} 个自定义角色`, { path: this.customPersonasPath });
    } catch (err: unknown) {
      this.log.warn('加载自定义角色失败', {
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }

  // ============ 查询 ============

  /** 获取所有角色 */
  getAllPersonas(): Persona[] {
    return Array.from(this.personas.values()).map(p => ({ ...p }));
  }

  /** 获取所有角色名 */
  listPersonaNames(): string[] {
    return Array.from(this.personas.keys());
  }

  /** 按名称获取角色 */
  getPersona(name: string): Persona | null {
    const p = this.personas.get(name);
    return p ? { ...p } : null;
  }

  /** 获取内置角色 */
  getBuiltinPersonas(): Persona[] {
    return Array.from(this.personas.values()).filter(p => p.builtin).map(p => ({ ...p }));
  }

  /** 获取自定义角色 */
  getCustomPersonas(): Persona[] {
    return Array.from(this.personas.values()).filter(p => !p.builtin).map(p => ({ ...p }));
  }

  // ============ 创建/删除 ============

  /**
   * 创建自定义角色
   * @returns 创建成功返回角色，失败返回错误消息
   */
  createPersona(persona: Omit<Persona, 'builtin' | 'createdAt'>): { success: boolean; persona?: Persona; error?: string } {
    // 校验名称不与内置冲突
    if (BUILTIN_PERSONAS.some(p => p.name === persona.name)) {
      return { success: false, error: `角色名 "${persona.name}" 与内置角色冲突` };
    }

    // 校验必填字段
    if (!persona.name || !persona.displayName || !persona.description) {
      return { success: false, error: '缺少必填字段: name, displayName, description' };
    }
    if (!persona.systemPromptSupplement || persona.systemPromptSupplement.trim().length === 0) {
      return { success: false, error: 'systemPromptSupplement 不能为空' };
    }

    const newPersona: Persona = {
      ...persona,
      builtin: false,
      createdAt: Date.now(),
    };

    this.personas.set(persona.name, newPersona);
    this.persistCustom();
    this.log.info('自定义角色已创建', { name: persona.name });
    return { success: true, persona: { ...newPersona } };
  }

  /** 删除自定义角色（不能删除内置角色） */
  deletePersona(name: string): { success: boolean; error?: string } {
    const persona = this.personas.get(name);
    if (!persona) {
      return { success: false, error: `角色 "${name}" 不存在` };
    }
    if (persona.builtin) {
      return { success: false, error: `不能删除内置角色 "${name}"` };
    }
    this.personas.delete(name);
    this.persistCustom();
    this.log.info('自定义角色已删除', { name });
    return { success: true };
  }

  /** 持久化自定义角色 */
  private persistCustom(): void {
    try {
      const custom = this.getCustomPersonas();
      const data = { personas: custom };
      const dir = path.dirname(this.customPersonasPath);
      if (!fs.existsSync(dir)) {
        fs.mkdirSync(dir, { recursive: true });
      }
      atomicWriteJsonSync(this.customPersonasPath, data);
      this.log.debug('自定义角色已持久化', { count: custom.length });
    } catch (err: unknown) {
      this.log.error('持久化自定义角色失败', {
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }

  // ============ 角色间通信 ============

  /**
   * 发送消息从一个角色到另一个角色
   */
  sendMessage(from: string, to: string, content: string, type: PersonaMessage['type'] = 'task'): { success: boolean; error?: string } {
    if (!this.personas.has(from)) {
      return { success: false, error: `来源角色 "${from}" 不存在` };
    }
    if (!this.personas.has(to)) {
      return { success: false, error: `目标角色 "${to}" 不存在` };
    }

    const msg: PersonaMessage = {
      id: `msg-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`,
      from,
      to,
      content,
      type,
      timestamp: Date.now(),
    };
    this.messages.push(msg);
    this.log.info('角色间消息已发送', { from, to, type });
    return { success: true };
  }

  /** 获取发给某角色的所有消息 */
  getMessagesForPersona(name: string): PersonaMessage[] {
    return this.messages.filter(m => m.to === name).map(m => ({ ...m }));
  }

  /** 获取某角色发出的所有消息 */
  getMessagesFromPersona(name: string): PersonaMessage[] {
    return this.messages.filter(m => m.from === name).map(m => ({ ...m }));
  }

  /** 清空消息队列 */
  clearMessages(): void {
    this.messages = [];
    this.log.info('消息队列已清空');
  }

  // ============ 协作流 ============

  /**
   * 获取角色的协作链：从该角色出发，下游能到达的所有角色
   */
  getDownstreamChain(name: string): string[] {
    const visited = new Set<string>();
    const queue = [name];
    while (queue.length > 0) {
      const current = queue.shift()!;
      if (visited.has(current)) continue;
      visited.add(current);
      const persona = this.personas.get(current);
      if (persona?.sendsTo) {
        for (const downstream of persona.sendsTo) {
          if (!visited.has(downstream)) queue.push(downstream);
        }
      }
    }
    visited.delete(name); // 排除自己
    return Array.from(visited);
  }

  /**
   * 获取角色的上游链：从该角色出发，上游能到达的所有角色
   */
  getUpstreamChain(name: string): string[] {
    const visited = new Set<string>();
    const queue = [name];
    while (queue.length > 0) {
      const current = queue.shift()!;
      if (visited.has(current)) continue;
      visited.add(current);
      const persona = this.personas.get(current);
      if (persona?.receivesFrom) {
        for (const upstream of persona.receivesFrom) {
          if (!visited.has(upstream)) queue.push(upstream);
        }
      }
    }
    visited.delete(name);
    return Array.from(visited);
  }

  // ============ 提示词生成 ============

  /**
   * 为角色生成完整的系统提示词补充
   * 包含：思维方式 + 输出风格 + 系统提示词补充 + 技能树
   */
  generatePromptSupplement(name: string): string {
    const persona = this.personas.get(name);
    if (!persona) return '';

    const lines: string[] = [];

    // 角色身份
    lines.push(`## 角色身份：${persona.displayName} ${persona.icon}`);
    lines.push(persona.description);
    lines.push('');

    // 思维方式
    lines.push('## 思维方式');
    lines.push(persona.thinkingStyle);
    lines.push('');

    // 输出风格
    lines.push('## 输出风格');
    lines.push(persona.outputStyle);
    lines.push('');

    // 技能树
    if (persona.skills.length > 0) {
      lines.push('## 核心技能');
      for (const skill of persona.skills) {
        const stars = '★'.repeat(skill.level) + '☆'.repeat(5 - skill.level);
        const tools = skill.tools ? ` (${skill.tools.join(', ')})` : '';
        lines.push(`- ${skill.name} ${stars}${tools}`);
      }
      lines.push('');
    }

    // 知识领域
    if (persona.knowledgeDomains.length > 0) {
      lines.push('## 知识领域');
      lines.push(persona.knowledgeDomains.join(' / '));
      lines.push('');
    }

    // 协作关系
    if (persona.receivesFrom && persona.receivesFrom.length > 0) {
      const names = persona.receivesFrom.map(n => this.personas.get(n)?.displayName || n).join('、');
      lines.push(`## 上游协作：接收来自 ${names} 的输出`);
    }
    if (persona.sendsTo && persona.sendsTo.length > 0) {
      const names = persona.sendsTo.map(n => this.personas.get(n)?.displayName || n).join('、');
      lines.push(`## 下游协作：输出传递给 ${names}`);
    }
    if (persona.receivesFrom?.length || persona.sendsTo?.length) {
      lines.push('');
    }

    // 行为约束
    lines.push('## 行为约束');
    lines.push(persona.systemPromptSupplement);

    return lines.join('\n');
  }

  // ============ 概览 ============

  /** 生成角色列表概览 */
  getOverview(): string {
    const lines: string[] = [];
    lines.push('=== 角色人格系统 ===');
    lines.push('');

    const all = this.getAllPersonas();
    lines.push(`共 ${all.length} 个角色（内置 ${this.getBuiltinPersonas().length} / 自定义 ${this.getCustomPersonas().length}）`);
    lines.push('');

    for (const p of all) {
      const tag = p.builtin ? '内置' : '自定义';
      const skills = p.skills.map(s => s.name).join(', ');
      lines.push(`${p.icon} ${p.displayName} (${p.name}) [${tag}]`);
      lines.push(`  描述: ${p.description}`);
      lines.push(`  技能: ${skills}`);
      if (p.receivesFrom?.length) {
        lines.push(`  上游: ${p.receivesFrom.join(', ')}`);
      }
      if (p.sendsTo?.length) {
        lines.push(`  下游: ${p.sendsTo.join(', ')}`);
      }
      lines.push('');
    }

    lines.push('用法:');
    lines.push('  - persona_list: 查看所有角色');
    lines.push('  - persona_create: 创建自定义角色');
    lines.push('  - persona_info: 查看角色详情');
    lines.push('  - persona_send_message: 角色间通信');

    return lines.join('\n');
  }

  // ============ LLM 工具 ============

  getToolDefinitions(): ToolDef[] {
    return [
      {
        name: 'persona_list',
        description: '查看所有角色人格（产品经理/架构师/前端工程师/后端工程师/测试工程师/DevOps/技术作家 + 用户自定义）',
        parameters: {},
        readOnly: true,
        execute: async () => this.getOverview(),
      },
      {
        name: 'persona_info',
        description: '查看指定角色的详细信息（技能树/思维方式/输出风格/知识库/协作关系）',
        parameters: {
          name: { type: 'string', description: '角色名称（如 architect / frontend-engineer）', required: true },
        },
        readOnly: true,
        execute: async (args: { name?: string }) => {
          if (!args?.name) return '❌ 缺少 name 参数';
          const supplement = this.generatePromptSupplement(args.name);
          if (!supplement) return `❌ 角色 "${args.name}" 不存在`;
          return supplement;
        },
      },
      {
        name: 'persona_create',
        description: '创建自定义角色人格。需提供 name、displayName、description、systemPromptSupplement。',
        parameters: {
          name: { type: 'string', description: '角色名称（唯一标识，如 data-scientist）', required: true },
          displayName: { type: 'string', description: '显示名称（如 数据科学家）', required: true },
          description: { type: 'string', description: '简短描述', required: true },
          icon: { type: 'string', description: '图标 emoji（默认 🤖）', required: false },
          systemPromptSupplement: { type: 'string', description: '系统提示词补充（行为约束）', required: true },
          thinkingStyle: { type: 'string', description: '思维方式描述', required: false },
          outputStyle: { type: 'string', description: '输出风格描述', required: false },
          skills: { type: 'array', description: '技能列表', required: false },
          knowledgeDomains: { type: 'array', description: '知识领域列表', required: false },
        },
        execute: async (args: Record<string, unknown>) => {
          const required = ['name', 'displayName', 'description', 'systemPromptSupplement'];
          for (const field of required) {
            if (!args?.[field]) return `❌ 缺少必填参数: ${field}`;
          }
          const result = this.createPersona({
            name: args.name as string,
            displayName: args.displayName as string,
            description: args.description as string,
            icon: (args.icon as string) || '🤖',
            skills: (args.skills as Skill[]) || [],
            thinkingStyle: (args.thinkingStyle as string) || '',
            outputStyle: (args.outputStyle as string) || '',
            knowledgeDomains: (args.knowledgeDomains as string[]) || [],
            systemPromptSupplement: args.systemPromptSupplement as string,
            receivesFrom: args.receivesFrom as string[] | undefined,
            sendsTo: args.sendsTo as string[] | undefined,
          });
          if (!result.success) return `❌ ${result.error}`;
          return `✅ 自定义角色已创建: ${result.persona!.displayName} (${result.persona!.name})`;
        },
      },
      {
        name: 'persona_delete',
        description: '删除自定义角色（不能删除内置角色）',
        parameters: {
          name: { type: 'string', description: '要删除的角色名称', required: true },
        },
        execute: async (args: { name?: string }) => {
          if (!args?.name) return '❌ 缺少 name 参数';
          const result = this.deletePersona(args.name);
          if (!result.success) return `❌ ${result.error}`;
          return `✅ 角色已删除: ${args.name}`;
        },
      },
      {
        name: 'persona_send_message',
        description: '角色间通信：从一个角色发送消息给另一个角色（如架构师→工程师）',
        parameters: {
          from: { type: 'string', description: '来源角色名称', required: true },
          to: { type: 'string', description: '目标角色名称', required: true },
          content: { type: 'string', description: '消息内容', required: true },
          type: { type: 'string', description: '消息类型: task/handoff/question/result', required: false },
        },
        execute: async (args: { from?: string; to?: string; content?: string; type?: string }) => {
          if (!args?.from || !args?.to || !args?.content) {
            return '❌ 缺少必填参数: from, to, content';
          }
          const validTypes: PersonaMessage['type'][] = ['task', 'handoff', 'question', 'result'];
          const type = (args.type as PersonaMessage['type']) || 'task';
          if (!validTypes.includes(type)) {
            return `❌ 无效 type: ${args.type}（应为 task/handoff/question/result）`;
          }
          const result = this.sendMessage(args.from, args.to, args.content, type);
          if (!result.success) return `❌ ${result.error}`;
          return `✅ 消息已发送: ${args.from} → ${args.to} (${type})`;
        },
      },
    ];
  }
}

// ============ 单例 ============

let _instance: PersonaSystem | null = null;

export function getPersonaSystem(): PersonaSystem {
  if (!_instance) {
    _instance = new PersonaSystem();
    _instance.loadCustom();
  }
  return _instance;
}
