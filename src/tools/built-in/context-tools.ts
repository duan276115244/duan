import { errMsg, type UnifiedToolDef } from '../../core/unified-tool-def.js';
import { toolContext } from './tool-context.js';
import type { ProjectStandard } from '../../core/project-context.js';

export const contextTools: UnifiedToolDef[] = [
  {
    name: 'project_context',
    description: '查看和管理项目上下文（类似 CLAUDE.md）。包括项目信息、编码规范、关键决策、事实、工具黑白名单。支持 view/update/add_decision/add_standard/add_fact/block_tool/allow_tool/clear_restrictions 操作。项目上下文会在每次对话中自动注入到 System Prompt。',
    readOnly: true,
    parameters: {
      action: { type: 'string', description: '操作: view/summary/add_decision/add_standard/add_fact/block_tool/allow_tool/clear_restrictions/info/auto_extract', required: true },
      value: { type: 'string', description: '值（add_decision/add_standard/add_fact/block_tool/allow_tool 时需要）', required: false },
      detail: { type: 'string', description: '详细信息（add_decision 时的 detail 参数）', required: false },
      category: { type: 'string', description: '分类（add_standard 时: coding_style/naming/architecture/testing/dependencies/communication/custom）', required: false },
      priority: { type: 'string', description: '优先级（add_standard 时: must/should/could）', required: false },
    },
    // eslint-disable-next-line require-await
    execute: async (args) => {
      if (!toolContext.projectContext) return '错误: 项目上下文系统未初始化';
      try {
        const action = args.action as string;
        const ctx = toolContext.projectContext;

        if (action === 'view' || action === 'info') {
          const data = ctx.getData();
          let output = `📋 **${data.projectName || '未命名项目'}**\n`;
          output += `${'─'.repeat(40)}\n`;
          if (data.description) output += `描述: ${data.description}\n`;
          if (data.techStack.length > 0) output += `技术栈: ${data.techStack.join(', ')}\n`;
          output += `会话数: ${data.sessionCount} | 最后更新: ${new Date(data.lastUpdated).toLocaleString()}\n\n`;

          if (data.standards.length > 0) {
            output += `**编码规范** (${data.standards.length}):\n`;
            for (const s of data.standards) output += `  [${s.priority}] [${s.category}] ${s.rule}\n`;
            output += '\n';
          }

          if (data.decisions.length > 0) {
            output += `**关键决策** (${data.decisions.length}):\n`;
            for (const d of [...data.decisions].reverse().slice(0, 10)) {
              output += `  • ${d.summary} (${new Date(d.timestamp).toLocaleDateString()})\n`;
            }
            if (data.decisions.length > 10) output += `  ...及其他 ${data.decisions.length - 10} 项\n`;
            output += '\n';
          }

          if (data.facts.length > 0) {
            output += `**项目事实** (${data.facts.length}):\n`;
            for (const f of data.facts.slice(0, 10)) output += `  • ${f}\n`;
            if (data.facts.length > 10) output += `  ...及其他 ${data.facts.length - 10} 项\n`;
            output += '\n';
          }

          if (data.preferences.length > 0) {
            output += `**用户偏好** (${data.preferences.length}):\n`;
            for (const p of data.preferences) output += `  • ${p}\n`;
            output += '\n';
          }

          if (data.allowedTools.length > 0) output += `白名单工具: ${data.allowedTools.join(', ')}\n`;
          if (data.blockedTools.length > 0) output += `黑名单工具: ${data.blockedTools.join(', ')}\n`;

          return output;
        }

        if (action === 'summary') {
          const s = ctx.getSummary();
          return `📋 **项目上下文摘要**\n项目: ${s.projectName || '(未设置)'}\n技术栈: ${s.techStack.join(', ') || '(未检测)'}\n决策: ${s.activeDecisions} | 规范: ${s.standards} | 事实: ${s.facts}\n工具限制: ${s.allowedTools > 0 ? `白名单${s.allowedTools}个` : '无'} ${s.blockedTools > 0 ? `/ 黑名单${s.blockedTools}个` : ''}\n会话数: ${s.sessionCount}`;
        }

        if (action === 'add_decision') {
          const value = args.value as string;
          if (!value) return '错误: 请提供 value（决策内容）';
          const id = ctx.addDecision(value, (args.detail as string) || '', (args.category as string) || 'general');
          return `✅ 决策已记录 (ID: ${id})`;
        }

        if (action === 'add_standard') {
          const value = args.value as string;
          if (!value) return '错误: 请提供 value（规范内容）';
          const category = (args.category as ProjectStandard['category']) || 'custom';
          const priority = (args.priority as ProjectStandard['priority']) || 'should';
          ctx.addStandard(category, value, priority);
          return `✅ 编码规范已添加 [${priority}] [${category}]`;
        }

        if (action === 'add_fact') {
          const value = args.value as string;
          if (!value) return '错误: 请提供 value（事实内容）';
          ctx.addFact(value);
          return `✅ 项目事实已记录`;
        }

        if (action === 'block_tool') {
          const value = args.value as string;
          if (!value) return '错误: 请提供 value（工具名）';
          ctx.blockTool(value);
          return `🚫 工具 "${value}" 已加入黑名单`;
        }

        if (action === 'allow_tool') {
          const value = args.value as string;
          if (!value) return '错误: 请提供 value（工具名）';
          ctx.allowTool(value);
          return `✅ 工具 "${value}" 已加入白名单`;
        }

        if (action === 'clear_restrictions') {
          ctx.clearToolRestrictions();
          return `✅ 工具限制已清除`;
        }

        if (action === 'auto_extract') {
          const result = ctx.autoExtract([]);
          return `✅ 自动提取完成。请注意：auto_extract 需要在会话上下文中运行。提取结果: 决策 ${result.decisions} 条, 事实 ${result.facts} 条, 偏好 ${result.preferences} 条。`;
        }

        return '用法: action=view|summary|add_decision|add_standard|add_fact|block_tool|allow_tool|clear_restrictions';
      } catch (err: unknown) { return `操作失败: ${errMsg(err)}`; }
    },
  },
];
