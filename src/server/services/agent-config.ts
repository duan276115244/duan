import type { AgentInfo } from './app-context.js';

export const agents: AgentInfo[] = [
  { id: 'main', name: '段先生', description: '主智能体，总控中心', expertise: ['总控', '调度', '决策', '协调'], status: 'online' },
  { id: 'dev', name: '开发者', description: '专业代码生成和审查专家', expertise: ['代码生成', '代码审查', '调试', '架构'], status: 'online' },
  { id: 'designer', name: '设计师', description: 'UI/UX设计和创意专家', expertise: ['UI设计', 'UX研究', '视觉设计', '品牌'], status: 'online' },
  { id: 'researcher', name: '研究员', description: '深度研究和信息收集专家', expertise: ['调研', '分析', '报告', '学术'], status: 'online' },
  { id: 'analyst', name: '分析师', description: '数据分析和可视化专家', expertise: ['数据', '统计', '可视化', '预测'], status: 'online' },
  { id: 'writer', name: '文案师', description: '内容创作和翻译专家', expertise: ['写作', '翻译', '编辑', '文案'], status: 'online' },
  { id: 'planner', name: '规划师', description: '项目管理和任务规划专家', expertise: ['计划', '管理', '协调', '执行'], status: 'online' },
];

const taskPatterns: Record<string, RegExp[]> = {
  code: [/写代码|编写代码|代码生成|编程|开发|实现|function|class|javascript|python|java|typescript|react|vue|node|c\+\+|rust|go/i],
  debug: [/调试|bug|错误|error|fix|修复|问题|异常|crash/i],
  analyze: [/分析|数据|统计|图表|可视化|report|报表|数据挖掘/i],
  doc: [/文档|写文档|撰写|报告|说明|document|手册/i],
  search: [/搜索|查找|调研|研究|资料|信息|查询/i],
  translate: [/翻译|中英文|英文|中文|language|translate/i],
  video: [/视频|剪辑|制作|video|edit|特效/i],
  plan: [/规划|计划|任务|项目|安排|schedule|管理/i],
  design: [/设计|ui|ux|界面|交互|原型/i],
  research: [/研究|调研|学术|论文|文献/i],
};

const taskToAgent: Record<string, string> = {
  code: 'dev',
  debug: 'dev',
  analyze: 'analyst',
  doc: 'writer',
  search: 'researcher',
  translate: 'writer',
  video: 'designer',
  plan: 'planner',
  design: 'designer',
  research: 'researcher',
};

export function detectTaskType(message: string): { taskType: string; agent: string } {
  for (const [taskType, patterns] of Object.entries(taskPatterns)) {
    for (const pattern of patterns) {
      if (pattern.test(message)) {
        return { taskType, agent: taskToAgent[taskType] || 'main' };
      }
    }
  }
  return { taskType: 'general', agent: 'main' };
}

export { taskPatterns, taskToAgent };
