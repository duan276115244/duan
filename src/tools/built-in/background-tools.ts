import { errMsg, type UnifiedToolDef } from '../../core/unified-tool-def.js';
import { toolContext } from './tool-context.js';

export const backgroundTools: UnifiedToolDef[] = [
  {
    name: 'bg_spawn',
    description: '在后台启动一个独立Agent执行任务，不阻塞当前对话。支持优先级队列，适合耗时任务（如代码审查、批量测试、文档生成）。返回agent ID后用bg_status/bg_result查询状态和结果。',
    parameters: {
      name: { type: 'string', description: '后台Agent名称，如 code_review / batch_test', required: true },
      goal: { type: 'string', description: '后台任务的目标和详细要求', required: true },
      context: { type: 'string', description: '可选的上下文信息', required: false },
      priority: { type: 'string', description: '优先级: high/normal/low，默认normal', required: false },
      tokenBudget: { type: 'string', description: 'Token预算，默认20000', required: false },
    },
    execute: async (args) => {
      if (!toolContext.backgroundAgentManager) return '错误: 后台Agent系统未初始化';
      const name = args.name as string;
      const goal = args.goal as string;
      if (!name || !goal) return '错误: 请提供 name 和 goal';
      try {
        const id = await toolContext.backgroundAgentManager.spawn({
          name, goal,
          context: args.context as string | undefined,
          priority: (args.priority as 'high' | 'normal' | 'low') || 'normal',
          tokenBudget: parseInt(args.tokenBudget as string) || 20000,
        });
        return `✅ 后台Agent "${name}" 已加入队列，ID: ${id}。使用 bg_status ${id} 查看状态，或用 bg_result ${id} 获取结果。`;
      } catch (err: unknown) { return `创建后台Agent失败: ${errMsg(err)}`; }
    },
  },
  {
    name: 'bg_list',
    description: '列出所有后台Agent的摘要信息，包括ID、名称、状态、优先级和创建时间。可按状态过滤。',
    readOnly: true,
    parameters: {
      status: { type: 'string', description: '可选过滤: queued/running/completed/failed/cancelled，为空则显示全部', required: false },
      limit: { type: 'string', description: '返回条数上限，默认20', required: false },
    },
    execute: (args) => {
      if (!toolContext.backgroundAgentManager) return Promise.resolve('错误: 后台Agent系统未初始化');
      try {
        const statusFilter = args.status as string | undefined;
        const limit = parseInt(args.limit as string) || 20;
        let summaries = toolContext.backgroundAgentManager.getSummaries();
        if (statusFilter) {
          summaries = summaries.filter(s => s.status === statusFilter);
        }
        summaries = summaries.slice(0, limit);

        if (summaries.length === 0) return Promise.resolve('暂无后台Agent记录。');

        const stats = toolContext.backgroundAgentManager.getStats();
        let output = `📊 **后台Agent概览**\n`;
        output += `总计: ${stats.total} | 排队: ${stats.queued} | 运行: ${stats.running} | 完成: ${stats.completed} | 失败: ${stats.failed} | 取消: ${stats.cancelled}\n\n`;

        for (const s of summaries) {
          let statusIcon: string;
          if (s.status === 'completed') statusIcon = '✅';
          else if (s.status === 'running') statusIcon = '🔄';
          else if (s.status === 'failed') statusIcon = '❌';
          else if (s.status === 'cancelled') statusIcon = '🚫';
          else statusIcon = '⏳';
          const time = new Date(s.createdAt).toLocaleTimeString();
          const dur = s.duration ? ` (${(s.duration / 1000).toFixed(0)}s)` : '';
          output += `${statusIcon} \`${s.id}\` ${s.name} [${s.priority}] ${s.goal} — ${time}${dur}\n`;
        }
        return Promise.resolve(output);
      } catch (err: unknown) { return Promise.resolve(`获取列表失败: ${errMsg(err)}`); }
    },
  },
  {
    name: 'bg_status',
    description: '查询指定后台Agent的详细状态。提供ID获取单个状态，不提供ID则显示运行中的Agent列表。',
    readOnly: true,
    parameters: {
      agentId: { type: 'string', description: '后台Agent ID（可选，不传则显示运行中列表）', required: false },
    },
    execute: (args) => {
      if (!toolContext.backgroundAgentManager) return Promise.resolve('错误: 后台Agent系统未初始化');
      try {
        const agentId = args.agentId as string | undefined;
        if (agentId) {
          const agent = toolContext.backgroundAgentManager.get(agentId);
          if (!agent) return Promise.resolve(`❌ 未找到后台Agent: ${agentId}`);
          let statusIcon: string;
          if (agent.status === 'completed') statusIcon = '✅';
          else if (agent.status === 'running') statusIcon = '🔄';
          else if (agent.status === 'failed') statusIcon = '❌';
          else if (agent.status === 'cancelled') statusIcon = '🚫';
          else statusIcon = '⏳';
          let output = `${statusIcon} **${agent.name}** (\`${agent.id}\`)\n`;
          output += `状态: ${agent.status}\n`;
          output += `优先级: ${agent.priority}\n`;
          output += `目标: ${agent.goal}\n`;
          output += `创建时间: ${new Date(agent.createdAt).toLocaleString()}\n`;
          if (agent.startedAt) output += `开始时间: ${new Date(agent.startedAt).toLocaleString()}\n`;
          if (agent.completedAt) output += `完成时间: ${new Date(agent.completedAt).toLocaleString()}\n`;
          if (agent.startedAt && agent.completedAt) output += `耗时: ${((agent.completedAt - agent.startedAt) / 1000).toFixed(1)}s\n`;
          output += `Token预算: ${agent.tokenBudget}\n`;
          output += `执行轮次: ${agent.turnCount}\n`;
          if (agent.error) output += `错误: ${agent.error}\n`;
          return Promise.resolve(output);
        } else {
          const running = toolContext.backgroundAgentManager.getByStatus('running');
          const queued = toolContext.backgroundAgentManager.getByStatus('queued');
          if (running.length === 0 && queued.length === 0) return Promise.resolve('当前没有运行中或排队中的后台Agent。');
          let output = '🔄 **运行中的后台Agent**\n';
          for (const r of running) {
            const elapsed = ((Date.now() - (r.startedAt || r.createdAt)) / 1000).toFixed(0);
            output += `  \`${r.id}\` ${r.name} (${elapsed}s)\n`;
          }
          if (queued.length > 0) {
            output += '\n⏳ **排队中的后台Agent**\n';
            for (const q of queued) {
              output += `  \`${q.id}\` ${q.name} [${q.priority}]\n`;
            }
          }
          return Promise.resolve(output);
        }
      } catch (err: unknown) { return Promise.resolve(`查询状态失败: ${errMsg(err)}`); }
    },
  },
  {
    name: 'bg_result',
    description: '获取已完成后台Agent的结果。如果Agent还在运行中，返回当前进度信息。',
    readOnly: true,
    parameters: {
      agentId: { type: 'string', description: '后台Agent ID', required: true },
    },
    execute: (args) => {
      if (!toolContext.backgroundAgentManager) return Promise.resolve('错误: 后台Agent系统未初始化');
      try {
        const agentId = args.agentId as string;
        if (!agentId) return Promise.resolve('错误: 请提供 agentId');
        const agent = toolContext.backgroundAgentManager.get(agentId);
        if (!agent) return Promise.resolve(`❌ 未找到后台Agent: ${agentId}`);

        if (agent.status === 'queued') return Promise.resolve(`⏳ Agent "${agent.name}" 仍在排队中（位置: 待定）。`);
        if (agent.status === 'running') return Promise.resolve(`🔄 Agent "${agent.name}" 正在运行中（已执行 ${agent.turnCount} 轮）。完成后可使用 bg_result ${agentId} 获取结果。`);
        if (agent.status === 'cancelled') return Promise.resolve(`🚫 Agent "${agent.name}" 已取消。`);
        if (agent.status === 'failed') return Promise.resolve(`❌ Agent "${agent.name}" 执行失败: ${agent.error || '未知错误'}`);

        const dur = agent.startedAt && agent.completedAt ? ` (${((agent.completedAt - agent.startedAt) / 1000).toFixed(1)}s)` : '';
        let output = `✅ **${agent.name}** 执行完成${dur}\n`;
        output += `${'─'.repeat(50)}\n`;
        output += agent.result || '(无输出结果)';
        return Promise.resolve(output);
      } catch (err: unknown) { return Promise.resolve(`获取结果失败: ${errMsg(err)}`); }
    },
  },
  {
    name: 'bg_cancel',
    description: '取消一个正在排队或运行中的后台Agent。已完成或已取消的Agent不能再次取消。',
    parameters: {
      agentId: { type: 'string', description: '要取消的后台Agent ID', required: true },
    },
    execute: (args) => {
      if (!toolContext.backgroundAgentManager) return Promise.resolve('错误: 后台Agent系统未初始化');
      try {
        const agentId = args.agentId as string;
        if (!agentId) return Promise.resolve('错误: 请提供 agentId');
        const ok = toolContext.backgroundAgentManager.cancel(agentId);
        if (!ok) return Promise.resolve(`❌ 无法取消 Agent ${agentId}（不存在或已完成/已取消）`);
        return Promise.resolve(`🚫 后台Agent ${agentId} 已取消。`);
      } catch (err: unknown) { return Promise.resolve(`取消失败: ${errMsg(err)}`); }
    },
  },
  {
    name: 'bg_wait',
    description: '等待指定后台Agent完成并获取结果。设置超时避免无限等待。适合需要等待后台任务完成后继续的场景。',
    parameters: {
      agentId: { type: 'string', description: '后台Agent ID', required: true },
      timeout: { type: 'string', description: '超时秒数，默认120', required: false },
    },
    execute: async (args) => {
      if (!toolContext.backgroundAgentManager) return '错误: 后台Agent系统未初始化';
      try {
        const agentId = args.agentId as string;
        const timeoutMs = (parseInt(args.timeout as string) || 120) * 1000;
        if (!agentId) return '错误: 请提供 agentId';
        const agent = await toolContext.backgroundAgentManager.waitFor(agentId, timeoutMs);
        if (!agent) return `❌ 未找到后台Agent: ${agentId}`;
        if (agent.status === 'completed') {
          const dur = agent.startedAt && agent.completedAt ? ` (${((agent.completedAt - agent.startedAt) / 1000).toFixed(1)}s)` : '';
          return `✅ **${agent.name}** 完成${dur}\n${agent.result || '(无输出)'}`;
        }
        if (agent.status === 'failed') return `❌ **${agent.name}** 失败: ${agent.error || '未知错误'}`;
        if (agent.status === 'cancelled') return `🚫 **${agent.name}** 已取消。`;
        return `⏳ **${agent.name}** 超时（${args.timeout || 120}s），当前状态: ${agent.status}`;
      } catch (err: unknown) { return `等待失败: ${errMsg(err)}`; }
    },
  },
];
