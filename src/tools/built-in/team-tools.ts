import { errMsg, type UnifiedToolDef } from '../../core/unified-tool-def.js';
import { toolContext } from './tool-context.js';

export const teamTools: UnifiedToolDef[] = [
  {
    name: 'team_run',
    description: '启动一个多Agent团队执行复杂任务。支持预定义团队模板（code-dev / research / bug-fix）和自定义团队。团队成员并行工作，支持 git worktree 隔离。返回执行ID后用 team_status / team_result 查看。',
    parameters: {
      template: { type: 'string', description: '团队模板: code-dev（代码开发）/ research（调研分析）/ bug-fix（Bug修复），或 custom', required: true },
      goal: { type: 'string', description: '团队任务的详细目标和要求', required: true },
      context: { type: 'string', description: '可选的上下文信息', required: false },
    },
    execute: async (args) => {
      if (!toolContext.agentTeamOrchestrator) return '错误: 多Agent团队系统未初始化';
      try {
        const template = args.template as string;
        const goal = args.goal as string;
        const context = args.context as string | undefined;
        if (!template || !goal) return '错误: 请提供 template 和 goal';
        if (template === 'custom') return '自定义团队暂不支持，请使用预定义模板: code-dev / research / bug-fix';
        const result = await toolContext.agentTeamOrchestrator.runTemplate(template, goal, context);
        const statusIcon = result.success ? '✅' : '⚠️';
        let output = `${statusIcon} **团队执行完成: ${result.teamName}**\n`;
        output += `耗时: ${(result.duration / 1000).toFixed(1)}s | 成员: ${result.memberResults.length} | Worktrees: ${result.worktreesCreated}\n\n`;
        output += result.summary.substring(0, 2000);
        if (result.errors.length > 0) {
          output += `\n\n**错误**:\n${result.errors.map(e => `  ❌ ${e}`).join('\n')}`;
        }
        return output;
      } catch (err: unknown) { return `团队执行失败: ${errMsg(err)}`; }
    },
  },
  {
    name: 'team_status',
    description: '查看多Agent团队的执行状态和成员进度。可查看单次执行的详细状态或历史列表。',
    readOnly: true,
    parameters: {
      executionId: { type: 'string', description: '执行ID（不提供则显示历史列表）', required: false },
    },
    execute: (args) => {
      if (!toolContext.agentTeamOrchestrator) return Promise.resolve('错误: 多Agent团队系统未初始化');
      try {
        const executionId = args.executionId as string | undefined;
        if (executionId) {
          const result = toolContext.agentTeamOrchestrator.getExecution(executionId);
          if (!result) return Promise.resolve(`❌ 未找到执行记录: ${executionId}`);
          const statusIcon = result.success ? '✅' : '⚠️';
          const dur = ((result.duration) / 1000).toFixed(1);
          let output = `${statusIcon} **${result.teamName}** (${dur}s)\n\n`;
          output += `目标: ${result.summary.split('\n')[1] || ''}\n`;
          output += `成员结果:\n`;
          for (const mr of result.memberResults) {
            const icon = mr.success ? '✅' : '❌';
            output += `  ${icon} ${mr.name}: ${mr.summary.substring(0, 150)}\n`;
          }
          if (result.errors.length > 0) {
            output += `\n错误:\n${result.errors.map(e => `  ❌ ${e}`).join('\n')}`;
          }
          return Promise.resolve(output);
        } else {
          const summaries = toolContext.agentTeamOrchestrator.getExecutionsSummary();
          if (summaries.length === 0) return Promise.resolve('暂无团队执行记录。');
          let output = '📋 **团队执行历史**\n\n';
          for (const s of summaries) {
            const icon = s.success ? '✅' : '⚠️';
            output += `${icon} \`${s.id}\` ${s.teamName} — ${(s.duration / 1000).toFixed(1)}s — ${s.memberCount}成员\n`;
          }
          return Promise.resolve(output);
        }
      } catch (err: unknown) { return Promise.resolve(`查询失败: ${errMsg(err)}`); }
    },
  },
  {
    name: 'team_templates',
    description: '查看可用的多Agent团队模板列表和详情。每个模板包含预定义的成员角色和配置。',
    readOnly: true,
    parameters: {
      template: { type: 'string', description: '可选：查看特定模板详情，如 code-dev / research / bug-fix', required: false },
    },
    execute: (args) => {
      if (!toolContext.agentTeamOrchestrator) return Promise.resolve('错误: 多Agent团队系统未初始化');
      try {
        const tpl = args.template as string | undefined;
        if (tpl) {
          const info = toolContext.agentTeamOrchestrator.getTemplateInfo(tpl);
          if (!info) return Promise.resolve(`❌ 未知模板: ${tpl}。可用: ${toolContext.agentTeamOrchestrator.getTemplates().join(', ')}`);
          let output = `📋 **团队模板: ${info.name}**\n`;
          output += `描述: ${info.description}\n`;
          output += `最大并发: ${info.maxConcurrent || 8}\n`;
          output += `Worktree隔离: ${info.useWorktreeIsolation ? '是' : '否'}\n\n`;
          output += `**成员角色**:\n`;
          for (const m of info.members) {
            output += `  • ${m.role} — "${m.name}" 优先级=${m.priority} Token预算=${m.tokenBudget}\n`;
            if (m.allowedTools && m.allowedTools.length > 0) {
              output += `    工具: ${m.allowedTools.join(', ')}\n`;
            }
          }
          return Promise.resolve(output);
        }
        const templates = toolContext.agentTeamOrchestrator.getTemplates();
        let output = '📋 **可用团队模板**\n\n';
        for (const t of templates) {
          const info = toolContext.agentTeamOrchestrator.getTemplateInfo(t);
          if (!info) continue;
          output += `**${t}** — ${info.name}\n`;
          output += `  ${info.description}\n`;
          output += `  成员: ${info.members.map(m => m.role).join(', ')} | 并发: ${info.maxConcurrent || 8}\n\n`;
        }
        output += '使用 `team_run template=code-dev goal="...任务描述..."` 启动团队。';
        return Promise.resolve(output);
      } catch (err: unknown) { return Promise.resolve(`查询失败: ${errMsg(err)}`); }
    },
  },
  {
    name: 'team_board',
    description: '查看和管理多Agent团队的共享上下文板。团队成员在板上发布发现、决策和状态更新。',
    readOnly: true,
    parameters: {
      action: { type: 'string', description: '操作: view / clear', required: false },
      message: { type: 'string', description: '发送到共享板的团队消息', required: false },
    },
    execute: (args) => {
      if (!toolContext.agentTeamOrchestrator) return Promise.resolve('错误: 多Agent团队系统未初始化');
      try {
        const action = (args.action as string) || 'view';
        if (action === 'clear') {
          toolContext.agentTeamOrchestrator.clearBoard();
          return Promise.resolve('✅ 共享上下文板已清空');
        }
        const board = toolContext.agentTeamOrchestrator.getBoard();
        if (board.entries.length === 0) return Promise.resolve('📋 共享上下文板为空。');
        let output = `📋 **共享上下文板** (${board.entries.length} 条)\n\n`;
        for (const entry of board.entries.slice(-20)) {
          const time = new Date(entry.timestamp).toLocaleTimeString();
          output += `[${time}] [${entry.agentName}] [${entry.type}] ${entry.content}\n`;
        }
        return Promise.resolve(output);
      } catch (err: unknown) { return Promise.resolve(`查询失败: ${errMsg(err)}`); }
    },
  },
];
