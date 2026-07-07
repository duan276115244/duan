/**
 * AgentTeamOrchestrator — 多Agent团队编排系统
 *
 * 支持8+并行Agent、git worktree隔离、结果合并与冲突解决、Agent团队协调。
 * 集成 SubAgentOrchestrator + GitWorktreeManager，提供高层团队协作能力。
 */

import { EventBus } from './event-bus.js';
import { logger } from './structured-logger.js';
import type { SubAgentOrchestrator, SubAgentResult, SubAgentConfig } from './sub-agent-orchestrator.js';
import type { GitWorktreeManager, WorktreeResult } from './git-worktree.js';

// ============ 类型定义 ============

export type TeamRole = 'planner' | 'implementer' | 'reviewer' | 'researcher' | 'debugger' | 'architect' | 'tester' | 'writer';

export interface TeamMemberConfig {
  role: TeamRole;
  name: string;
  goal: string;
  context?: string;
  priority?: number;
  tokenBudget?: number;
  allowedTools?: string[];
}

export interface AgentTeamConfig {
  name: string;
  description: string;
  members: TeamMemberConfig[];
  maxConcurrent?: number;
  useWorktreeIsolation?: boolean;
  baseBranch?: string;
}

export interface TeamExecutionResult {
  teamName: string;
  success: boolean;
  startedAt: number;
  completedAt: number;
  duration: number;
  memberResults: SubAgentResult[];
  summary: string;
  worktreesCreated: number;
  mergeSuccess: boolean;
  errors: string[];
}

export interface SharedContextBoard {
  entries: SharedContextEntry[];
}

export interface SharedContextEntry {
  agentName: string;
  role: TeamRole;
  type: 'finding' | 'question' | 'decision' | 'warning' | 'status';
  content: string;
  timestamp: number;
}

// ============ 预定义团队模板 ============

const TEAM_TEMPLATES: Record<string, Omit<AgentTeamConfig, 'members'> & { members: Array<Omit<TeamMemberConfig, 'goal'>> }> = {
  'code-dev': {
    name: '代码开发团队',
    description: '完整的代码开发流程：规划→实现→审查→测试',
    maxConcurrent: 8,
    useWorktreeIsolation: true,
    members: [
      { role: 'planner', name: '规划师', priority: 0.9, tokenBudget: 10000, allowedTools: ['file_read', 'search_files', 'list_directory', 'web_search', 'web_fetch'] },
      { role: 'implementer', name: '核心开发者', priority: 0.8, tokenBudget: 40000, allowedTools: ['file_read', 'file_write', 'shell_execute', 'search_files', 'list_directory'] },
      { role: 'implementer', name: '辅助开发者', priority: 0.7, tokenBudget: 30000, allowedTools: ['file_read', 'file_write', 'shell_execute', 'search_files'] },
      { role: 'reviewer', name: '代码审查员', priority: 0.6, tokenBudget: 15000, allowedTools: ['file_read', 'search_files', 'list_directory', 'shell_execute'] },
      { role: 'tester', name: '测试工程师', priority: 0.5, tokenBudget: 20000, allowedTools: ['file_read', 'file_write', 'shell_execute', 'search_files', 'list_directory'] },
    ],
  },
  'research': {
    name: '调研分析团队',
    description: '多角度调研分析：资料收集→分析→总结',
    maxConcurrent: 6,
    useWorktreeIsolation: false,
    members: [
      { role: 'researcher', name: '高级研究员', priority: 0.9, tokenBudget: 20000, allowedTools: ['web_search', 'web_fetch', 'file_read'] },
      { role: 'researcher', name: '数据研究员', priority: 0.8, tokenBudget: 20000, allowedTools: ['web_search', 'web_fetch', 'file_read'] },
      { role: 'analyst', name: '分析师', priority: 0.7, tokenBudget: 15000, allowedTools: ['file_read', 'web_search'] },
      { role: 'writer', name: '报告撰写员', priority: 0.6, tokenBudget: 15000, allowedTools: ['file_read', 'file_write'] },
    // eslint-disable-next-line @typescript-eslint/no-explicit-any -- 'analyst' 角色不在 TeamRole 联合中,保留 any 绕过类型检查
    ] as any,
  },
  'bug-fix': {
    name: 'Bug修复团队',
    description: '快速定位和修复Bug：诊断→修复→验证',
    maxConcurrent: 6,
    useWorktreeIsolation: true,
    members: [
      { role: 'debugger', name: '调试专家', priority: 0.9, tokenBudget: 20000, allowedTools: ['file_read', 'search_files', 'shell_execute', 'list_directory'] },
      { role: 'implementer', name: '修复工程师', priority: 0.8, tokenBudget: 20000, allowedTools: ['file_read', 'file_write', 'shell_execute'] },
      { role: 'reviewer', name: '验证员', priority: 0.6, tokenBudget: 10000, allowedTools: ['file_read', 'search_files', 'shell_execute'] },
    ],
  },
};

// ============ 主类 ============

export class AgentTeamOrchestrator {
  private subAgentOrchestrator: SubAgentOrchestrator | null = null;
  private gitWorktreeManager: GitWorktreeManager | null = null;
  private sharedBoard: SharedContextBoard = { entries: [] };
  private executions: Map<string, TeamExecutionResult> = new Map();
  private eventBus: EventBus;
  private log = logger.child({ module: 'AgentTeamOrchestrator' });
  // C1 修复：当前执行 ID（用于 postToBoard 事件关联）
  private currentExecutionId: string | null = null;

  constructor() {
    this.eventBus = EventBus.getInstance();
  }

  /** 注入 SubAgentOrchestrator */
  setSubAgentOrchestrator(orchestrator: SubAgentOrchestrator): void {
    this.subAgentOrchestrator = orchestrator;
  }

  /** 注入 GitWorktreeManager */
  setGitWorktreeManager(manager: GitWorktreeManager): void {
    this.gitWorktreeManager = manager;
  }

  /** 获取可用团队模板 */
  getTemplates(): string[] {
    return Object.keys(TEAM_TEMPLATES);
  }

  /** 获取团队模板详情 */
  getTemplateInfo(name: string): AgentTeamConfig | null {
    const tmpl = TEAM_TEMPLATES[name];
    if (!tmpl) return null;
    return {
      ...tmpl,
      members: tmpl.members.map(m => ({
        ...m,
        goal: '',
      })),
    };
  }

  // ============ 执行团队任务 ============

  /** 使用预定义模板创建并执行团队 */
  runTemplate(templateName: string, taskGoal: string, extraContext?: string): Promise<TeamExecutionResult> {
    // 投递任务到共享上下文板
    this.postToBoard('system', 'planner', 'status', `启动团队任务: ${taskGoal}`);
    const tmpl = TEAM_TEMPLATES[templateName];
    if (!tmpl) return Promise.reject(new Error(`未知团队模板: ${templateName}，可用: ${Object.keys(TEAM_TEMPLATES).join(', ')}`));

    const members: TeamMemberConfig[] = tmpl.members.map(m => ({
      ...m,
      goal: this.buildRoleGoal(m.role, taskGoal),
      context: extraContext,
    }));

    const config: AgentTeamConfig = {
      name: tmpl.name,
      description: taskGoal,
      members,
      maxConcurrent: tmpl.maxConcurrent,
      useWorktreeIsolation: tmpl.useWorktreeIsolation,
    };

    return this.executeTeam(config);
  }

  /** 执行自定义团队任务 */
  async executeTeam(config: AgentTeamConfig): Promise<TeamExecutionResult> {
    const startTime = Date.now();
    const executionId = `team_${Date.now()}_${Math.random().toString(36).slice(2, 6)}`;
    this.currentExecutionId = executionId;
    const errors: string[] = [];
    let worktreesCreated = 0;
    const createdWorktrees: string[] = [];

    this.log.info('启动多Agent团队', { team: config.name, goal: config.description, members: config.members.length });

    this.eventBus.emitSync('team.execution.started', {
      executionId, teamName: config.name, goal: config.description,
    }, { source: 'AgentTeamOrchestrator' });

    // 更新 SubAgentOrchestrator 最大并发
    const maxConcurrent = config.maxConcurrent || 8;
    if (this.subAgentOrchestrator) {
      this.subAgentOrchestrator.setMaxConcurrent(maxConcurrent);
    }

    // 为每个成员创建 worktree 隔离（如果启用）
    if (config.useWorktreeIsolation && this.gitWorktreeManager) {
      this.gitWorktreeManager.init();
      for (const member of config.members) {
        if (member.role === 'implementer' || member.role === 'tester' || member.role === 'debugger') {
          const branchName = `team/${config.name.replace(/\s+/g, '-')}/${member.role}/${Date.now()}`;
          const result: WorktreeResult = this.gitWorktreeManager.createWorktree(
            `${executionId}_${member.role}`,
            branchName,
            `${member.name}: ${member.goal.substring(0, 80)}`,
          );
          if (result.success) {
            worktreesCreated++;
            createdWorktrees.push(`${executionId}_${member.role}`);
            member.context = (member.context || '') + `\n工作目录: ${result.worktree?.path || 'unknown'}\n分支: ${branchName}`;
          }
        }
      }
    }

    // 所有规划角色先行执行
    const plannerMembers = config.members.filter(m => m.role === 'planner');
    const nonPlannerMembers = config.members.filter(m => m.role !== 'planner');

    // 添加共享上下文到所有成员
    const sharedContext = this.buildSharedContext();

    // 执行规划阶段
    const plannerResults: SubAgentResult[] = [];
    if (plannerMembers.length > 0 && this.subAgentOrchestrator) {
      const plannerIds = await Promise.all(
        plannerMembers.map(m =>
          this.subAgentOrchestrator!.spawnAgent({
            id: `${executionId}_${m.role}_${m.name}`,
            name: m.name,
            goal: m.goal,
            context: [sharedContext, m.context || ''].filter(Boolean),
            priority: m.priority || 0.5,
            tokenBudget: m.tokenBudget || 20000,
            allowedTools: m.allowedTools,
            role: m.role as SubAgentConfig['role'],
          }),
        ),
      );
      // 等待所有规划者完成
      for (const id of plannerIds) {
        const result = await this.subAgentOrchestrator.waitForId(id, 120000);
        if (result) plannerResults.push(result);
      }

      // 将规划结果加入共享上下文
      for (const r of plannerResults) {
        this.postToBoard(r.name, 'planner', 'decision', `规划结果: ${r.summary.substring(0, 500)}`);
      }
    }

    // 更新共享上下文（包含规划结果）
    const enrichedContext = this.buildSharedContext();

    // 并行执行非规划成员
    const memberResults: SubAgentResult[] = [...plannerResults];
    if (nonPlannerMembers.length > 0 && this.subAgentOrchestrator) {
      const memberIds = await Promise.all(
        nonPlannerMembers.map(m =>
          this.subAgentOrchestrator!.spawnAgent({
            id: `${executionId}_${m.role}_${m.name}`,
            name: m.name,
            goal: m.goal,
            context: [enrichedContext, m.context || ''].filter(Boolean),
            priority: m.priority || 0.5,
            tokenBudget: m.tokenBudget || 30000,
            allowedTools: m.allowedTools,
            role: (m.role === 'tester' || m.role === 'debugger') ? 'implementer' : m.role as SubAgentConfig['role'],
          }),
        ),
      );
      // 等待所有成员完成
      for (const id of memberIds) {
        const result = await this.subAgentOrchestrator.waitForId(id, 300000);
        if (result) memberResults.push(result);
      }
    }

    // 合并 worktree 分支
    let mergeSuccess = true;
    if (config.useWorktreeIsolation && this.gitWorktreeManager && worktreesCreated > 0) {
      for (const wtName of createdWorktrees) {
        const mergeResult = this.gitWorktreeManager.mergeWorktree(wtName, 'squash');
        if (!mergeResult.success) {
          errors.push(`合并 worktree ${wtName} 失败: ${mergeResult.error || '未知错误'}`);
          mergeSuccess = false;
        }
      }
      // 清理 worktrees
      for (const wtName of createdWorktrees) {
        this.gitWorktreeManager.removeWorktree(wtName);
      }
    }

    const completedAt = Date.now();
    const success = memberResults.filter(r => r?.success).length >= Math.ceil(memberResults.length * 0.5);
    const summary = this.generateTeamSummary(memberResults, config);

    const result: TeamExecutionResult = {
      teamName: config.name,
      success,
      startedAt: startTime,
      completedAt,
      duration: completedAt - startTime,
      memberResults: memberResults.filter(Boolean),
      summary,
      worktreesCreated,
      mergeSuccess,
      errors,
    };

    this.executions.set(executionId, result);

    this.eventBus.emitSync('team.execution.completed', {
      executionId, teamName: config.name, success, duration: result.duration,
      memberCount: memberResults.length,
    }, { source: 'AgentTeamOrchestrator' });

    return result;
  }

  /** 获取执行结果 */
  getExecution(id: string): TeamExecutionResult | undefined {
    return this.executions.get(id);
  }

  /** 获取所有执行摘要 */
  getExecutionsSummary(): Array<{ id: string; teamName: string; success: boolean; duration: number; memberCount: number }> {
    return Array.from(this.executions.entries()).map(([id, r]) => ({
      id, teamName: r.teamName, success: r.success, duration: r.duration,
      memberCount: r.memberResults.length,
    }));
  }

  // ============ 共享上下文板 ============

  /** 向共享上下文板发布消息 */
  postToBoard(agentName: string, role: TeamRole, type: SharedContextEntry['type'], content: string): void {
    const entry: SharedContextEntry = { agentName, role, type, content, timestamp: Date.now() };
    this.sharedBoard.entries.push(entry);
    // 最多保留200条
    if (this.sharedBoard.entries.length > 200) {
      this.sharedBoard.entries = this.sharedBoard.entries.slice(-200);
    }
    // C1 修复：发射 team.board 事件（SSE 端点订阅转发到前端 SharedContextBoard）
    try {
      this.eventBus.emitSync('team.board', {
        executionId: this.currentExecutionId || 'unknown',
        entry,
        timestamp: Date.now(),
      }, { source: 'AgentTeamOrchestrator' });
    } catch {
      // 事件发射失败不影响主流程
    }
  }

  /** 获取共享上下文板 */
  getBoard(): SharedContextBoard {
    return { entries: [...this.sharedBoard.entries] };
  }

  /** 清空共享上下文板 */
  clearBoard(): void {
    this.sharedBoard.entries = [];
  }

  /** 构建共享上下文字符串 */
  private buildSharedContext(): string {
    if (this.sharedBoard.entries.length === 0) return '';
    const recent = this.sharedBoard.entries.slice(-30);
    let ctx = '### 团队共享上下文\n\n';
    for (const entry of recent) {
      const time = new Date(entry.timestamp).toLocaleTimeString();
      ctx += `[${time}] [${entry.agentName}] [${entry.type}] ${entry.content}\n`;
    }
    return ctx;
  }

  // ============ 内部方法 ============

  private buildRoleGoal(role: TeamRole, taskGoal: string): string {
    const rolePrompts: Record<string, string> = {
      planner: `作为规划师，分析以下任务并制定详细的执行计划：\n\n${taskGoal}\n\n请输出：1. 任务分解 2. 执行步骤 3. 注意事项 4. 预期产出`,
      implementer: `作为开发者，执行以下任务：\n\n${taskGoal}\n\n请专注于高质量的实现。`,
      reviewer: `作为代码审查员，审查已完成的工作，确保代码质量、安全性和最佳实践。\n\n任务: ${taskGoal}`,
      researcher: `作为研究员，研究以下主题并输出详细的调研报告：\n\n${taskGoal}`,
      debugger: `作为调试专家，诊断和修复以下问题：\n\n${taskGoal}`,
      architect: `作为架构师，为以下任务设计系统架构：\n\n${taskGoal}`,
      tester: `作为测试工程师，为以下功能编写和执行测试：\n\n${taskGoal}`,
      writer: `作为技术文档撰写员，为以下内容编写文档：\n\n${taskGoal}`,
    };
    return rolePrompts[role] || taskGoal;
  }

  private generateTeamSummary(results: (SubAgentResult | null)[], config: AgentTeamConfig): string {
    const successCount = results.filter(r => r?.success).length;
    const failCount = results.filter(r => r && !r.success).length;
    let summary = `## 团队执行报告: ${config.name}\n\n`;
    summary += `目标: ${config.description}\n`;
    summary += `成员: ${config.members.length} | 成功: ${successCount} | 失败: ${failCount}\n\n`;

    for (const r of results) {
      if (!r) continue;
      const icon = r.success ? '✅' : '❌';
      summary += `${icon} **${r.name}**: ${r.summary.substring(0, 300)}\n\n`;
    }

    if (this.sharedBoard.entries.length > 0) {
      summary += `\n### 团队协作记录\n`;
      const decisions = this.sharedBoard.entries.filter(e => e.type === 'decision').slice(-5);
      for (const d of decisions) {
        summary += `- ${d.agentName}: ${d.content.substring(0, 200)}\n`;
      }
    }

    return summary;
  }
}
