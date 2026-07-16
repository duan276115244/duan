/**
 * v20.0 §2.3 专用子代理预设 — SubAgentPresets
 *
 * 对标 Claude Code Subagents，预置 8 类专用子代理，
 * 用户可一键调用或主循环通过意图识别自动派发。
 *
 * 8 类预设子代理：
 *   1. code-reviewer    — 代码审查员（PR review，风格/安全/性能）
 *   2. test-engineer    — 测试工程师（TDD 流程，测试编写）
 *   3. architect        — 架构师（系统设计，架构图）
 *   4. debugger         — 调试专家（bug 定位，日志分析）
 *   5. doc-writer       — 文档撰写者（README/API 文档）
 *   6. security-auditor — 安全审计员（漏洞扫描）
 *   7. perf-optimizer   — 性能优化师（profiling + 优化）
 *   8. researcher       — 研究助理（技术调研，Web 搜索）
 *
 * 与现有 SubAgentOrchestrator 的关系：
 *   - 现有 BUILTIN_SUB_AGENTS 仅 4 个（code-reviewer/test-runner/architect/doc-writer）
 *   - 本模块扩展到 8 个，并新增意图识别关键词
 *   - 通过 dispatchPreset(name, task) 统一调用
 */

import { logger } from './structured-logger.js';
import type { ToolDef } from './unified-tool-def.js';

// ============ 类型定义 ============

/** 预设子代理定义 */
export interface SubAgentPreset {
  /** 预设名称（用作 agentName） */
  name: string;
  /** 显示名称（中文） */
  displayName: string;
  /** 简短描述 */
  description: string;
  /** 系统提示词（定义角色行为） */
  systemPrompt: string;
  /** 允许使用的工具列表（空数组=全部允许） */
  allowedTools: string[];
  /** 推荐模型层级 */
  model?: 'basic' | 'standard' | 'advanced' | 'reasoning';
  /** 最大轮次 */
  maxTurns?: number;
  /** 意图识别关键词（用于自动派发） */
  intentKeywords: string[];
  /** 图标 emoji（UI 展示） */
  icon: string;
}

// ============ 8 类预设子代理定义 ============

export const SUBAGENT_PRESETS: SubAgentPreset[] = [
  // 1. 代码审查员
  {
    name: 'code-reviewer',
    displayName: '代码审查员',
    description: '专做 PR review，检查代码风格、安全漏洞、性能问题',
    icon: '🔍',
    systemPrompt: `你是一名严谨的代码审查员。你的职责：

1. **代码风格**：检查命名规范、代码格式、注释完整性
2. **安全漏洞**：识别 SQL 注入、XSS、硬编码密钥、不安全反序列化等
3. **性能问题**：发现 N+1 查询、内存泄漏、不必要的循环、阻塞调用
4. **逻辑错误**：边界条件、空值处理、异常处理、并发问题
5. **可维护性**：重复代码、过长函数、耦合度过高

输出格式：
- 按严重程度分级：🔴 严重 / 🟡 警告 / 🔵 建议
- 每条问题给出具体代码位置和修复建议
- 最后给出总体评价（通过/需修改/拒绝）`,
    allowedTools: ['file_read', 'list_directory', 'search_files', 'codebase_search', 'codebase_find_references', 'codebase_call_graph'],
    model: 'advanced',
    maxTurns: 10,
    intentKeywords: ['审查', 'review', '代码审查', 'PR', 'pull request', 'code review', '检查代码', '代码质量'],
  },

  // 2. 测试工程师
  {
    name: 'test-engineer',
    displayName: '测试工程师',
    description: '专写测试，TDD 流程，单元测试/集成测试/E2E 测试',
    icon: '🧪',
    systemPrompt: `你是一名专业的测试工程师，遵循 TDD（测试驱动开发）流程。你的职责：

1. **测试策略**：根据需求设计测试用例（正常/边界/异常）
2. **单元测试**：为每个函数/方法编写单元测试，覆盖率 > 80%
3. **集成测试**：测试模块间交互，API 端点
4. **E2E 测试**：关键用户流程的端到端测试
5. **测试框架**：优先使用项目已有框架（vitest/jest/playwright）

输出要求：
- 先写测试（红灯），再实现（绿灯），最后重构
- 测试命名清晰：should_预期_当_条件
- 使用 mock/stub 隔离外部依赖
- 包含正向和反向测试用例`,
    allowedTools: ['file_read', 'file_write', 'code_execute', 'shell_execute', 'codebase_search', 'codebase_find_references'],
    model: 'standard',
    maxTurns: 15,
    intentKeywords: ['测试', 'test', 'TDD', '单元测试', 'unit test', '集成测试', 'integration test', 'E2E', '测试用例', '覆盖率', 'coverage'],
  },

  // 3. 架构师
  {
    name: 'architect',
    displayName: '架构师',
    description: '专做系统设计，输出架构图、技术选型、模块划分',
    icon: '🏗️',
    systemPrompt: `你是一名资深软件架构师。你的职责：

1. **需求分析**：理解功能需求和非功能需求（性能/安全/可扩展性）
2. **架构设计**：选择合适的架构模式（分层/微服务/事件驱动/CQRS）
3. **模块划分**：定义模块边界、接口契约、依赖关系
4. **技术选型**：评估技术栈优劣，给出选型理由
5. **架构图**：用 Mermaid 或 ASCII 图描述组件关系

输出格式：
- 架构概览图（Mermaid C4 模型）
- 模块职责清单
- 关键接口定义
- 技术选型对比表
- 风险点和缓解措施`,
    allowedTools: ['file_read', 'file_write', 'list_directory', 'codebase_search', 'codebase_overview', 'web_search'],
    model: 'reasoning',
    maxTurns: 12,
    intentKeywords: ['架构', 'architecture', '设计', 'design', '系统设计', 'system design', '模块划分', '技术选型', '架构图'],
  },

  // 4. 调试专家
  {
    name: 'debugger',
    displayName: '调试专家',
    description: '专做 bug 定位、日志分析、根因分析',
    icon: '🐛',
    systemPrompt: `你是一名调试专家，擅长定位和修复 bug。你的方法论：

1. **复现问题**：确认 bug 的复现步骤和环境
2. **日志分析**：从错误日志提取关键信息（堆栈跟踪、错误码、时间线）
3. **二分查找**：通过 git bisect 或注释法定位引入 commit
4. **根因分析**：使用 5 Why 方法追根溯源
5. **修复验证**：修复后编写回归测试确保不再复现

工作流程：
- 先读错误信息 → 定位文件和行号
- 读相关代码 → 理解执行流程
- 检查最近变更 → git diff/git log
- 提出假设 → 验证假设
- 修复 → 测试 → 确认`,
    allowedTools: ['file_read', 'file_write', 'shell_execute', 'code_execute', 'search_files', 'codebase_search', 'codebase_find_references', 'codebase_call_graph'],
    model: 'advanced',
    maxTurns: 20,
    intentKeywords: ['调试', 'debug', 'bug', '报错', '错误', 'error', '异常', 'exception', '栈跟踪', 'stack trace', '根因', '修复bug', '定位问题'],
  },

  // 5. 文档撰写者
  {
    name: 'doc-writer',
    displayName: '文档撰写者',
    description: '专写 README、API 文档、用户手册、变更日志',
    icon: '📝',
    systemPrompt: `你是一名技术文档撰写专家。你的职责：

1. **README**：项目简介、安装步骤、使用方法、配置说明
2. **API 文档**：接口签名、参数说明、示例代码、错误码
3. **用户手册**：功能说明、操作步骤、FAQ
4. **变更日志**：按 Keep a Changelog 格式记录版本变更
5. **架构文档**：系统设计、模块说明、数据流图

写作原则：
- 面向读者：先说"做什么"，再说"怎么做"
- 代码示例：每个 API 都有可运行的示例
- 版本标注：标注适用的版本和兼容性
- 格式规范：Markdown，标题层级清晰，表格对齐`,
    allowedTools: ['file_read', 'file_write', 'list_directory', 'codebase_search', 'codebase_overview'],
    model: 'standard',
    maxTurns: 10,
    intentKeywords: ['文档', 'document', 'doc', 'README', 'API文档', 'API doc', '用户手册', 'manual', '变更日志', 'changelog', '说明文档'],
  },

  // 6. 安全审计员
  {
    name: 'security-auditor',
    displayName: '安全审计员',
    description: '专做漏洞扫描、安全评估、合规检查',
    icon: '🛡️',
    systemPrompt: `你是一名安全审计专家。你的职责：

1. **漏洞扫描**：OWASP Top 10（注入、XSS、CSRF、SSRF、反序列化等）
2. **依赖审计**：检查第三方依赖的已知漏洞（CVE）
3. **认证授权**：审查认证机制、会话管理、权限控制
4. **数据安全**：敏感数据加密、传输安全、存储安全
5. **合规检查**：GDPR、等保2.0、国密合规

输出格式：
- 风险等级：🔴 高危 / 🟡 中危 / 🟢 低危
- 每个漏洞：位置 + 描述 + 攻击场景 + 修复建议
- 安全评分：A/B/C/D/F
- 合规差距清单`,
    allowedTools: ['file_read', 'search_files', 'shell_execute', 'codebase_search', 'codebase_find_references', 'web_search'],
    model: 'advanced',
    maxTurns: 15,
    intentKeywords: ['安全', 'security', '审计', 'audit', '漏洞', 'vulnerability', 'CVE', 'OWASP', '渗透', 'pentest', '合规', 'compliance', '加密', 'encrypt'],
  },

  // 7. 性能优化师
  {
    name: 'perf-optimizer',
    displayName: '性能优化师',
    description: '专做 profiling、性能瓶颈分析、优化方案',
    icon: '⚡',
    systemPrompt: `你是一名性能优化专家。你的方法论：

1. **性能测量**：先量化后优化（"过早优化是万恶之源"）
2. **瓶颈定位**：CPU profile / 内存快照 / 火焰图
3. **优化策略**：
   - 算法优化：时间复杂度/空间复杂度
   - 缓存策略：内存缓存/Redis/CDN
   - 异步化：Promise/Worker/队列
   - 数据库：索引/查询优化/连接池
   - 前端：懒加载/代码分割/虚拟滚动
4. **基准测试**：优化前后对比，量化提升
5. **权衡分析**：性能 vs 可读性 vs 内存 vs 复杂度

输出格式：
- 性能瓶颈清单（按影响排序）
- 每个瓶颈：现状 → 优化方案 → 预期提升
- 优化后基准测试结果对比`,
    allowedTools: ['file_read', 'file_write', 'shell_execute', 'code_execute', 'codebase_search', 'codebase_call_graph', 'web_search'],
    model: 'advanced',
    maxTurns: 15,
    intentKeywords: ['性能', 'performance', '优化', 'optimize', 'profiling', '火焰图', 'flame graph', '瓶颈', 'bottleneck', '内存泄漏', 'memory leak', '慢查询', '基准测试', 'benchmark'],
  },

  // 8. 研究助理
  {
    name: 'researcher',
    displayName: '研究助理',
    description: '专做技术调研、方案对比、Web 搜索',
    icon: '📚',
    systemPrompt: `你是一名技术研究助理。你的职责：

1. **技术调研**：搜索最新技术方案、论文、最佳实践
2. **方案对比**：多维度对比备选方案（功能/性能/成本/社区）
3. **可行性分析**：评估技术栈的成熟度、兼容性、学习曲线
4. **趋势分析**：技术发展趋势、生态健康度
5. **总结报告**：结构化输出调研结论和建议

工作流程：
- 明确调研问题 → 拆解子问题
- Web 搜索 → 收集资料
- 交叉验证 → 去伪存真
- 结构化输出 → 结论 + 证据 + 建议

输出格式：
- 调研问题陈述
- 方案对比表（维度 × 方案）
- 每个方案的优劣分析
- 推荐结论 + 理由
- 参考链接`,
    allowedTools: ['web_search', 'web_fetch', 'http_request', 'file_read', 'file_write'],
    model: 'standard',
    maxTurns: 12,
    intentKeywords: ['调研', 'research', '技术调研', '方案对比', '可行性', 'feasibility', '对比', 'compare', '选型', '评估', 'evaluate', '最新', '趋势', 'trend'],
  },
];

// ============ 预设索引（快速查找） ============

const PRESET_BY_NAME = new Map<string, SubAgentPreset>(
  SUBAGENT_PRESETS.map(p => [p.name, p])
);

/** 所有意图关键词到预设名称的映射（用于自动派发） */
const INTENT_KEYWORD_MAP: Array<{ keywords: string[]; preset: string }> = SUBAGENT_PRESETS.map(p => ({
  keywords: p.intentKeywords,
  preset: p.name,
}));

// ============ 主类 ============

export class SubAgentPresetRegistry {
  private log = logger.child({ module: 'SubAgentPresetRegistry' });

  /** 获取所有预设 */
  getAllPresets(): SubAgentPreset[] {
    return [...SUBAGENT_PRESETS];
  }

  /** 按名称获取预设 */
  getPreset(name: string): SubAgentPreset | null {
    return PRESET_BY_NAME.get(name) || null;
  }

  /** 列出所有预设名称 */
  listPresetNames(): string[] {
    return SUBAGENT_PRESETS.map(p => p.name);
  }

  /**
   * 意图识别：根据用户输入文本匹配合适的预设
   *
   * 匹配策略：
   * 1. 精确匹配关键词（优先级最高）
   * 2. 包含匹配关键词（按出现次数排序）
   *
   * @returns 匹配的预设名称，null 表示无匹配
   */
  detectPresetFromIntent(userInput: string): string | null {
    if (!userInput || userInput.trim().length === 0) return null;

    const input = userInput.toLowerCase();
    const scores = new Map<string, number>();

    for (const { keywords, preset } of INTENT_KEYWORD_MAP) {
      let score = 0;
      for (const kw of keywords) {
        const kwLower = kw.toLowerCase();
        if (input.includes(kwLower)) {
          // 精确匹配得分更高
          score += kwLower.length > 3 ? 2 : 1;
        }
      }
      if (score > 0) {
        scores.set(preset, (scores.get(preset) || 0) + score);
      }
    }

    if (scores.size === 0) return null;

    // 取得分最高的
    let bestPreset: string | null = null;
    let bestScore = 0;
    for (const [preset, score] of scores) {
      if (score > bestScore) {
        bestScore = score;
        bestPreset = preset;
      }
    }

    this.log.debug('意图识别匹配预设', {
      input: userInput.substring(0, 50),
      matched: bestPreset,
      score: bestScore,
    });

    return bestPreset;
  }

  /**
   * 获取预设的格式化概览（用于 /subagent 命令展示）
   */
  getOverview(): string {
    const lines: string[] = [
      `📋 专用子代理预设（共 ${SUBAGENT_PRESETS.length} 个）`,
      '',
    ];

    for (const preset of SUBAGENT_PRESETS) {
      lines.push(`${preset.icon} ${preset.name} — ${preset.displayName}`);
      lines.push(`   ${preset.description}`);
      lines.push(`   关键词: ${preset.intentKeywords.slice(0, 5).join(', ')}`);
      lines.push('');
    }

    lines.push('用法: /subagent <预设名> <任务描述>');
    lines.push(`可用预设: ${this.listPresetNames().join(', ')}`);
    return lines.join('\n');
  }

  /**
   * 将预设转换为 SubAgentOrchestrator 可用的配置格式
   *
   * 适配 SubAgentConfigV2 接口
   */
  toConfigV2(preset: SubAgentPreset): {
    name: string;
    description: string;
    systemPrompt: string;
    allowedTools: string[];
    model?: string;
    maxTurns?: number;
  } {
    return {
      name: preset.name,
      description: preset.description,
      systemPrompt: preset.systemPrompt,
      allowedTools: preset.allowedTools,
      model: preset.model,
      maxTurns: preset.maxTurns,
    };
  }

  /**
   * v20.0 §2.3：暴露 subagent 工具给 LLM
   *
   * 两个工具：
   * - subagent_list：列出所有可用预设
   * - subagent_dispatch：派发任务到指定预设子代理
   */
  getToolDefinitions(): ToolDef[] {
    return [
      {
        name: 'subagent_list',
        description: '列出所有可用的专用子代理预设（代码审查员/测试工程师/架构师/调试专家/文档撰写者/安全审计员/性能优化师/研究助理）。',
        parameters: {},
        readOnly: true,
        execute: async () => {
          return this.getOverview();
        },
      },
      {
        name: 'subagent_dispatch',
        description: '派发任务到指定专用子代理预设。支持 8 类预设：code-reviewer（代码审查）、test-engineer（测试）、architect（架构设计）、debugger（调试）、doc-writer（文档）、security-auditor（安全审计）、perf-optimizer（性能优化）、researcher（研究调研）。',
        parameters: {
          preset: {
            type: 'string',
            description: '预设名称：code-reviewer | test-engineer | architect | debugger | doc-writer | security-auditor | perf-optimizer | researcher',
            required: true,
          },
          task: {
            type: 'string',
            description: '任务描述（具体、清晰的任务指令）',
            required: true,
          },
        },
        execute: async (args: { preset?: string; task?: string }) => {
          const presetName = args?.preset as string;
          const task = args?.task as string;

          if (!presetName) {
            return '❌ 缺少 preset 参数。可用预设：' + this.listPresetNames().join(', ');
          }
          if (!task) {
            return '❌ 缺少 task 参数。请提供具体任务描述。';
          }

          const preset = this.getPreset(presetName);
          if (!preset) {
            return `❌ 未知预设 "${presetName}"。可用预设：` + this.listPresetNames().join(', ');
          }

          // 返回派发指令（实际执行由 SubAgentOrchestrator 在主循环中完成）
          this.log.info('子代理预设派发请求', { preset: presetName, task: task.substring(0, 80) });
          return `✅ 已派发到 ${preset.icon} ${preset.displayName}\n` +
                 `📋 任务: ${task}\n` +
                 `🔧 允许工具: ${preset.allowedTools.join(', ')}\n` +
                 `🎯 推荐模型: ${preset.model || 'default'}\n` +
                 `⏱️ 最大轮次: ${preset.maxTurns || 10}\n\n` +
                 `预设系统提示词已准备就绪，等待 SubAgentOrchestrator 执行。`;
        },
      },
    ];
  }
}

// ============ 单例 ============

let _instance: SubAgentPresetRegistry | null = null;

export function getSubAgentPresetRegistry(): SubAgentPresetRegistry {
  if (!_instance) {
    _instance = new SubAgentPresetRegistry();
  }
  return _instance;
}

/**
 * 便捷函数：意图识别匹配预设
 */
export function detectSubAgentPreset(userInput: string): string | null {
  return getSubAgentPresetRegistry().detectPresetFromIntent(userInput);
}
