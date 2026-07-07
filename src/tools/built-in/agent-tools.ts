import { errMsg, type UnifiedToolDef } from '../../core/unified-tool-def.js';
import { toolContext } from './tool-context.js';
import type { SubAgentResult } from '../../core/sub-agent-orchestrator.js';

export const agentTools: UnifiedToolDef[] = [
  {
    name: 'spawn_agent',
    description: '创建一个子Agent执行子任务。适合复杂任务的并行分解。调用后返回agent ID，然后用wait_agents等待结果。',
    parameters: {
      name: { type: 'string', description: '子Agent名称，如 data_collector / code_reviewer', required: true },
      goal: { type: 'string', description: '子任务的目标和详细要求', required: true },
      context: { type: 'string', description: '可选的上下文信息', required: false },
      priority: { type: 'string', description: '优先级: high/medium/low，默认medium', required: false },
      tokenBudget: { type: 'string', description: 'Token预算，默认20000', required: false },
    },
    execute: async (args) => {
      if (!toolContext.subAgentOrchestrator) return '错误: 子Agent系统未初始化';
      const name = args.name as string;
      const goal = args.goal as string;
      if (!name || !goal) return '错误: 请提供 name 和 goal';
      try {
        const id = await toolContext.subAgentOrchestrator.spawnAgent({
          id: `agent_${Date.now()}`,
          name, goal,
          context: args.context ? [args.context as string] : [],
          priority: (() => {
            if (args.priority === 'high') return 0.9;
            if (args.priority === 'low') return 0.3;
            return 0.6;
          })(),
          tokenBudget: parseInt(args.tokenBudget as string) || 20000,
        });
        return `✅ 子Agent "${name}" 已创建，ID: ${id}。使用 wait_agents 等待结果。`;
      } catch (err: unknown) { return `创建子Agent失败: ${errMsg(err)}`; }
    },
  },
  {
    name: 'wait_agents',
    description: '等待之前创建的子Agent完成执行，并汇总所有结果。可指定等待特定ID或全部等待。',
    parameters: {
      agentId: { type: 'string', description: '可选：要等待的特定子Agent ID', required: false },
      timeout: { type: 'string', description: '超时秒数，默认60秒', required: false },
    },
    execute: async (args) => {
      if (!toolContext.subAgentOrchestrator) return '错误: 子Agent系统未初始化';
      try {
        const timeoutMs = (parseInt(args.timeout as string) || 60) * 1000;
        let results: SubAgentResult[];
        if (args.agentId) {
          const r = await toolContext.subAgentOrchestrator.waitForId(args.agentId as string, timeoutMs);
          results = r ? [r] : [];
        } else {
          results = await toolContext.subAgentOrchestrator.waitForAll(timeoutMs);
        }
        if (results.length === 0) return '没有等待中的子Agent';
        return results.map(r =>
          `${r.success ? '✅' : '❌'} ${r.name}: ${r.summary.substring(0, 300)} (${(r.duration / 1000).toFixed(1)}s)`
        ).join('\n');
      } catch (err: unknown) { return `等待子Agent失败: ${errMsg(err)}`; }
    },
  },
  {
    name: 'list_agents',
    description: '查看所有子Agent的状态：运行中、已完成、错误等',
    readOnly: true,
    parameters: {},
    execute: () => {
      if (!toolContext.subAgentOrchestrator) return Promise.resolve('错误: 子Agent系统未初始化');
      return Promise.resolve(toolContext.subAgentOrchestrator.getStatusReport());
    },
  },
  {
    name: 'spawn_and_wait',
    description: '创建子Agent执行子任务并等待结果返回。一站式完成，适合独立子任务。',
    parameters: {
      name: { type: 'string', description: '子Agent名称', required: true },
      goal: { type: 'string', description: '子任务的目标和要求', required: true },
      context: { type: 'string', description: '上下文信息', required: false },
      timeout: { type: 'string', description: '超时秒数，默认120', required: false },
    },
    execute: async (args) => {
      if (!toolContext.subAgentOrchestrator) return '错误: 子Agent系统未初始化';
      const name = args.name as string;
      const goal = args.goal as string;
      if (!name || !goal) return '错误: 请提供 name 和 goal';
      try {
        const id = await toolContext.subAgentOrchestrator.spawnAgent({
          id: `agent_${Date.now()}`,
          name, goal,
          context: args.context ? [args.context as string] : [],
          priority: 0.6,
          tokenBudget: 20000,
        });
        const timeoutMs = (parseInt(args.timeout as string) || 120) * 1000;
        const result = await toolContext.subAgentOrchestrator.waitForId(id, timeoutMs);
        if (!result) return `子Agent "${name}" 执行超时或无结果`;
        return `${result.success ? '✅' : '❌'} ${result.name}: ${result.summary.substring(0, 500)} (${(result.duration / 1000).toFixed(1)}s)`;
      } catch (err: unknown) { return `子Agent执行失败: ${errMsg(err)}`; }
    },
  },
];
