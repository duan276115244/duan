import { errMsg, type UnifiedToolDef } from '../../core/unified-tool-def.js';
import { toolContext } from './tool-context.js';
import type { Plan, StepStatus } from '../../core/task-planner.js';

export const planTools: UnifiedToolDef[] = [
  {
    name: 'create_plan',
    description: '为复杂任务创建多步骤执行计划。每个步骤可设置依赖关系，系统会按依赖顺序执行。适合需要多步骤协作的复杂任务。',
    parameters: {
      name: { type: 'string', description: '计划名称', required: true },
      goal: { type: 'string', description: '总体目标描述', required: true },
      steps: { type: 'string', description: '步骤列表JSON，格式: [{"description":"...","dependencies":[步骤ID]}]', required: true },
    },
    execute: (args) => {
      if (!toolContext.taskPlanner) return Promise.resolve('错误: 任务规划系统未初始化');
      const name = args.name as string; const goal = args.goal as string; const stepsStr = args.steps as string;
      if (!name || !goal || !stepsStr) return Promise.resolve('错误: 请提供 name, goal, steps');
      try {
        const steps = JSON.parse(stepsStr);
        if (!Array.isArray(steps) || steps.length === 0) return Promise.resolve('错误: steps必须是包含至少一个步骤的数组');
        const plan = toolContext.taskPlanner.createPlan(name, goal, steps);
        return Promise.resolve(`✅ 计划 "${name}" 已创建，ID: ${plan.id}\n${toolContext.taskPlanner.getProgress(plan.id)}`);
      } catch (err: unknown) { return Promise.resolve(`创建计划失败: ${errMsg(err)}`); }
    },
  },
  {
    name: 'update_plan_step',
    description: '更新计划中某个步骤的状态。步骤完成后标记completed，失败标记failed，开始执行标记in_progress。',
    parameters: {
      planId: { type: 'string', description: '计划ID', required: true },
      stepId: { type: 'string', description: '步骤编号（数字）', required: true },
      status: { type: 'string', description: '新状态: pending/in_progress/completed/failed/skipped', required: true },
      result: { type: 'string', description: '执行结果说明（completed时填写）', required: false },
      error: { type: 'string', description: '错误信息（failed时填写）', required: false },
    },
    execute: (args) => {
      if (!toolContext.taskPlanner) return Promise.resolve('错误: 任务规划系统未初始化');
      const planId = args.planId as string; const stepId = parseInt(args.stepId as string); const status = args.status as string;
      if (!planId || isNaN(stepId) || !status) return Promise.resolve('错误: 请提供 planId, stepId, status');
      if (!['pending', 'in_progress', 'completed', 'failed', 'skipped'].includes(status)) return Promise.resolve('错误: 无效状态');
      const plan = toolContext.taskPlanner.updateStep(planId, stepId, { status: status as StepStatus, result: args.result as string, error: args.error as string });
      if (!plan) return Promise.resolve('错误: 计划或步骤不存在');
      return Promise.resolve(`✅ 步骤${stepId} 已更新为 ${status}\n${toolContext.taskPlanner.getProgress(planId)}`);
    },
  },
  {
    name: 'get_plan',
    description: '查看计划的详细进度。显示所有步骤的状态、完成百分比、依赖关系。',
    readOnly: true,
    parameters: { planId: { type: 'string', description: '计划ID', required: true } },
    execute: (args) => {
      if (!toolContext.taskPlanner) return Promise.resolve('错误: 任务规划系统未初始化');
      const planId = args.planId as string;
      if (!planId) return Promise.resolve('错误: 请提供 planId');
      const plan = toolContext.taskPlanner.getPlan(planId);
      if (!plan) return Promise.resolve('错误: 计划不存在');
      return Promise.resolve(toolContext.taskPlanner.getProgress(planId));
    },
  },
  {
    name: 'list_plans',
    description: '查看所有进行中的计划和已完成计划',
    readOnly: true,
    parameters: {},
    execute: () => {
      if (!toolContext.taskPlanner) return Promise.resolve('错误: 任务规划系统未初始化');
      return Promise.resolve(toolContext.taskPlanner.getAllPlans().map((p: Plan) =>
        `  ${p.status === 'completed' ? '✅' : '🔄'} ${p.name} (${p.id}): ${p.status}`
      ).join('\n'));
    },
  },
  {
    name: 'complete',
    description: '标记当前任务完成为止。调用此工具表示你已完成所有必要工作。调用后任务立即结束，不要重复调用。',
    parameters: { summary: { type: 'string', description: '任务完成摘要', required: true } },
    execute: (args) => {
      const summary = (args.summary as string || '').substring(0, 1000);
      return Promise.resolve(`[TASK_COMPLETE] ${summary}`);
    },
  },
];
