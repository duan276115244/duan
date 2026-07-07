import { errMsg, type UnifiedToolDef } from '../../core/unified-tool-def.js';
import { toolContext } from './tool-context.js';

export const skillTools: UnifiedToolDef[] = [
  {
    name: 'self_skills',
    description: '查看已萃取的技能库、记录新技能、查看技能统计。使用agent的完成任务经验自动提炼可复用的技能。',
    parameters: {
      action: { type: 'string', description: '操作: list/stats/extract/context', required: true },
      name: { type: 'string', description: '技能名称 (extract时需要)', required: false },
      description: { type: 'string', description: '技能描述 (extract时需要)', required: false },
      category: { type: 'string', description: '技能分类 (extract时需要), 如 development/research/analysis/configuration/general', required: false },
      steps: { type: 'string', description: '步骤列表JSON字符串 (extract时需要)', required: false },
      tools: { type: 'string', description: '使用工具列表JSON字符串 (extract时需要)', required: false },
      task: { type: 'string', description: '任务描述 (context时需要)', required: false },
    },
    execute: (args) => {
      if (!toolContext.skillExtractor) return Promise.resolve('错误: 技能萃取系统未初始化');
      try {
        const action = args.action as string;
        const sx = toolContext.skillExtractor;
        if (action === 'list') {
          const skills = sx.getAllSkills();
          if (skills.length === 0) return Promise.resolve('📚 尚无萃取技能。完成任务后会自动生成。');
          return Promise.resolve(skills.map((s) =>
            `  ✅ ${s.name} [${s.category}] (${s.successCount}次成功, ${s.failCount}次失败)\n     ${s.description.substring(0, 80)}`
          ).join('\n'));
        }
        if (action === 'stats') return Promise.resolve(sx.getStats());
        if (action === 'extract') {
          const steps = args.steps ? JSON.parse(args.steps as string) : [];
          const toolsList = args.tools ? JSON.parse(args.tools as string) : [];
          const skill = sx.extractSkill({
            name: args.name as string || '未命名技能',
            description: args.description as string || '',
            category: args.category as string || 'general',
            steps,
            toolsUsed: toolsList,
            tags: [args.category as string || 'general', ...toolsList],
          });
          return Promise.resolve(`✅ 技能 "${skill.name}" 已萃取，当前共 ${sx.getAllSkills().length} 个技能。`);
        }
        if (action === 'context' && args.task) {
          const ctx = sx.getSkillContext(args.task as string);
          return Promise.resolve(ctx || '无相关技能');
        }
        return Promise.resolve('用法: action=list|stats|extract|context');
      } catch (err: unknown) { return Promise.resolve(`操作失败: ${errMsg(err)}`); }
    },
  },
  {
    name: 'self_tool_framework',
    description: '统一工具框架管理：查看、注册、注销工具。用于运行时工具管理。',
    parameters: {
      action: { type: 'string', description: '操作: list/categories/stats/register/unregister', required: true },
      name: { type: 'string', description: '工具名称 (register/unregister时需要)', required: false },
      description: { type: 'string', description: '工具描述 (register时需要)', required: false },
      parameters: { type: 'string', description: '工具参数字符串 (register时需要)', required: false },
    },
    execute: (args) => {
      if (!toolContext.unifiedToolFramework) return Promise.resolve('错误: 统一工具框架未初始化');
      const action = args.action as string;
      // eslint-disable-next-line @typescript-eslint/no-explicit-any -- getToolsByCategory() 此处按分组重载使用,实际签名为 (category:string),需 any 绕过参数检查
      const utf = toolContext.unifiedToolFramework as any;
      const name = args.name as string;
      try {
        if (action === 'list') {
          const tools = utf.getActiveTools();
          return Promise.resolve(tools.length > 0 ? tools.map((t) => `  🔧 ${t.name}: ${t.description}`).join('\n') : '📭 无活跃工具');
        }
        if (action === 'categories') {
          const cats = utf.getToolsByCategory();
          return Promise.resolve(Object.entries(cats).map(([cat, tls]) => `${cat}: ${(tls as { length: number }).length}个`).join('\n'));
        }
        if (action === 'stats') {
          const stats = utf.getStats();
          return Promise.resolve(JSON.stringify(stats, null, 2));
        }
        if (action === 'register') {
          if (!name || !args.description) return Promise.resolve('错误: 需要 name 和 description');
          const params = args.parameters ? JSON.parse(args.parameters as string) : {};
          utf.register({ name, description: args.description as string, parameters: params, execute: () => Promise.resolve('') });
          return Promise.resolve(`✅ 工具已注册: ${name}`);
        }
        if (action === 'unregister') {
          if (!name) return Promise.resolve('错误: 需要 name');
          utf.unregister(name);
          return Promise.resolve(`✅ 工具已注销: ${name}`);
        }
        return Promise.resolve('用法: action=list|categories|stats|register|unregister');
      } catch (err: unknown) { return Promise.resolve(`操作失败: ${errMsg(err)}`); }
    },
  },
];
