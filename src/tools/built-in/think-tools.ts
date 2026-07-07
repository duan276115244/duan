import * as path from 'path';
import * as fs from 'fs';
import type { UnifiedToolDef } from '../../core/unified-tool-def.js';
import { toolContext } from './tool-context.js';
import { duanPath } from '../../core/duan-paths.js';

/**
 * 搜索相关记忆
 */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
async function searchMemories(query: string, limit: number): Promise<any[]> {
  try {
    // P0 跨平台修复：使用统一的 duanPath 解析
    const dir = duanPath('memories');
    let files: string[];
    try {
      files = (await fs.promises.readdir(dir)).filter((f: string) => f.endsWith('.json'));
    } catch {
      return [];
    }
    const q = query.toLowerCase();
    // P0-4 改进：分词后计算重叠度，而非简单 includes
    const queryTokens = q.split(/\s+/).filter((t: string) => t.length > 2);
    const memories = (await Promise.all(
      files.map(async (f: string) => {
        try {
          const content = await fs.promises.readFile(path.join(dir, f), 'utf-8');
          return JSON.parse(content);
        } catch {
          return null;
        }
      }),
    )).filter(x => x !== null);
    return memories.map(m => {
      const content = (m.content || '').toLowerCase();
      // 计算分词重叠度
      const overlap = queryTokens.filter((t: string) => content.includes(t)).length;
      const score = overlap > 0 ? overlap / queryTokens.length + (m.importance || 0) / 10 : 0;
      return { memory: m, score };
    }).filter(x => x.score > 0).sort((a, b) => b.score - a.score).slice(0, limit).map(x => x.memory);
  } catch { return []; }
}

/**
 * P0-4 改进：搜索相关学习记录
 */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
function searchLearningRecords(query: string, limit: number): any[] {
  try {
    if (!toolContext.selfLearningSystem) return [];
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const records = (toolContext.selfLearningSystem as any).records;
    if (!records || typeof records.values !== 'function') return [];
    const q = query.toLowerCase();
    const queryTokens = q.split(/\s+/).filter((t: string) => t.length > 2);
    const allRecords = Array.from(records.values());
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    return allRecords.filter((r: any) => {
      const content = (r.content || '').toLowerCase();
      return queryTokens.some((t: string) => content.includes(t));
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    }).sort((a: any, b: any) => (b.confidence || 0) - (a.confidence || 0)).slice(0, limit);
  } catch { return []; }
}

/**
 * P0-4 改进：搜索相关技能
 */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
async function searchSkills(query: string, limit: number): Promise<any[]> {
  try {
    const skillsPath = path.join(process.cwd(), '.awareness', 'skills.json');
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    let data: any;
    try {
      const raw = await fs.promises.readFile(skillsPath, 'utf-8');
      data = JSON.parse(raw);
    } catch {
      return [];
    }
    const skills = Array.isArray(data) ? data : (data.skills || []);
    const q = query.toLowerCase();
    const queryTokens = q.split(/\s+/).filter((t: string) => t.length > 2);
    return skills.filter(s => {
      const text = `${s.name || ''} ${s.description || ''} ${s.category || ''}`.toLowerCase();
      return queryTokens.some((t: string) => text.includes(t));
    }).sort((a, b) => (b.successRate || 0) - (a.successRate || 0)).slice(0, limit);
  } catch { return []; }
}

export const thinkTools: UnifiedToolDef[] = [
  {
    name: 'self_think',
    description: '深度思考 — 在采取行动前进行结构化推理。分析问题、评估方案、制定计划。复杂问题先think再行动。思考结果会注入到后续上下文中，帮助做出更好的决策。',
    readOnly: true,
    parameters: {
      thought: { type: 'string', description: '你的深度思考过程：包括问题理解、关键约束、可能的方案', required: true },
      plan: { type: 'string', description: '执行计划概述：具体步骤、预期结果、风险点', required: false },
    },
    execute: async (args) => {
      const thought = (args.thought as string || '').substring(0, 4000);
      const plan = (args.plan as string || '').substring(0, 2000);

      if (!thought.trim()) {
        return '⚠️ 思考内容不能为空。请描述你对问题的理解、关键约束和可能的方案。';
      }

      // P0-4 改进：检索相关记忆、学习记录和技能（记忆/技能并行异步 I/O，避免串行阻塞）
      const learnings = searchLearningRecords(thought, 3);
      const [memories, skills] = await Promise.all([
        searchMemories(thought, 3),
        searchSkills(thought, 3),
      ]);

      // P0-4 改进：结构化思考框架输出
      let output = '🧠 深度思考已记录\n';
      output += '━━━━━━━━━━━━━━━━━━━━\n';
      output += `📝 思考过程 (${thought.length}字符):\n${thought}\n`;

      if (plan) {
        output += `\n📋 执行计划:\n${plan}\n`;
      }

      // 相关经验
      if (memories.length > 0) {
        output += '\n📖 相关记忆:\n';
        memories.forEach((m, i: number) => {
          output += `  ${i + 1}. [${m.type || 'memory'}] ${(m.content || '').substring(0, 150)}\n`;
          if (m.importance) output += `     重要性: ${m.importance}\n`;
        });
      }

      // 相关学习记录
      if (learnings.length > 0) {
        output += '\n📚 历史学习记录:\n';
        learnings.forEach((l, i: number) => {
          output += `  ${i + 1}. [${l.category || 'general'}] ${(l.content || '').substring(0, 150)}\n`;
          output += `     置信度: ${l.confidence || '?'} | 出现次数: ${l.frequency || 1} | 结果: ${l.outcome || 'neutral'}\n`;
        });
      }

      // 相关技能
      if (skills.length > 0) {
        output += '\n🔧 可用技能:\n';
        skills.forEach((s, i: number) => {
          output += `  ${i + 1}. ${s.name || '未命名'} (${s.category || 'general'})\n`;
          if (s.description) output += `     ${s.description.substring(0, 120)}\n`;
          if (s.successRate !== undefined) output += `     成功率: ${(s.successRate * 100).toFixed(0)}%\n`;
        });
      }

      // P0-4 改进：思考质量评估和下一步建议
      output += '\n━━━━━━━━━━━━━━━━━━━━\n';
      output += '✅ 思考已完成，以上经验可辅助决策。\n';

      // 简单的思考质量评估
      const hasAnalysis = /因为|所以|由于|分析|考虑|假设|如果/.test(thought);
      const hasPlan = plan.length > 50;
      const hasAlternatives = /方案[一二三123]|备选|或者|替代/.test(thought);

      const suggestions: string[] = [];
      if (!hasAnalysis) suggestions.push('建议增加因果分析（为什么这样想）');
      if (!hasPlan) suggestions.push('建议补充具体执行计划');
      if (!hasAlternatives && thought.length > 200) suggestions.push('建议考虑备选方案');

      if (suggestions.length > 0) {
        output += '💡 优化建议:\n';
        suggestions.forEach(s => output += `  - ${s}\n`);
      } else {
        output += '🌟 思考质量良好，可以开始执行。\n';
      }

      return output;
    },
  },
  {
    name: 'self_omni',
    description: '全能管家 — 用自然语言描述任务，自动分析意图、制定计划并执行。适合复杂的一次性任务。',
    parameters: { task: { type: 'string', description: '用自然语言描述要完成的任务', required: true } },
    execute: async (args) => {
      if (!toolContext.omniAssistant) return '错误: 全能管家未初始化';
      try {
        const result = await toolContext.omniAssistant.understandAndExecute(args.task as string);
        return `✅ 任务完成:\n${result.substring(0, 3000)}`;
      } catch (err: unknown) {
        // P0-4 改进：更详细的错误信息
        const errMsg = err instanceof Error ? err.message : String(err);
        return `❌ 执行失败: ${errMsg}\n\n建议:\n  1. 检查任务描述是否清晰\n  2. 确认相关工具是否可用\n  3. 尝试分解为更小的子任务`;
      }
    },
  },
  {
    name: 'extended_think',
    description: 'P1-2: 扩展思考模式 — 对标 Claude Code Extended Thinking。复杂任务自动进入多步逻辑检查 + 边缘情况枚举。思考过程可视化展示。适用于：架构设计、复杂 Bug 诊断、多步骤规划、不确定性决策。',
    readOnly: true,
    parameters: {
      problem: { type: 'string', description: '要思考的复杂问题或决策', required: true },
      depth: { type: 'string', description: '思考深度: shallow(浅层)/medium(中等)/deep(深度)', required: false },
      context: { type: 'string', description: '相关上下文信息（已有代码、约束条件等）', required: false },
    },
    execute: async (args) => {
      const problem = (args.problem as string || '').substring(0, 4000);
      const depth = (args.depth as string) || 'medium';
      const context = (args.context as string || '').substring(0, 2000);

      if (!problem.trim()) {
        return '⚠️ 问题不能为空。请描述你要思考的复杂问题或决策。';
      }

      // P1-2: 扩展思考模式 — 多步逻辑检查 + 边缘情况枚举
      const steps: string[] = [];

      // Step 1: 问题分解
      steps.push('## Step 1: 问题分解');
      const subProblems = decomposeProblem(problem);
      subProblems.forEach((sp, i) => steps.push(`  ${i + 1}. ${sp}`));

      // Step 2: 约束识别
      steps.push('\n## Step 2: 约束识别');
      const constraints = identifyConstraints(problem, context);
      if (constraints.length > 0) {
        constraints.forEach(c => steps.push(`  - ${c}`));
      } else {
        steps.push('  - 未识别到明确约束');
      }

      // Step 3: 方案生成（根据深度）
      steps.push(`\n## Step 3: 方案生成 (深度: ${depth})`);
      let solutionCount: number;
      if (depth === 'deep') solutionCount = 5;
      else if (depth === 'medium') solutionCount = 3;
      else solutionCount = 2;
      const solutions = generateSolutions(problem, solutionCount);
      solutions.forEach((s, i) => steps.push(`  方案${i + 1}: ${s}`));

      // Step 4: 边缘情况枚举（深度思考时）
      if (depth === 'deep' || depth === 'medium') {
        steps.push('\n## Step 4: 边缘情况枚举');
        const edgeCases = enumerateEdgeCases(problem, context);
        if (edgeCases.length > 0) {
          edgeCases.forEach(ec => steps.push(`  - ${ec}`));
        } else {
          steps.push('  - 未识别到明显边缘情况');
        }
      }

      // Step 5: 风险评估（深度思考时）
      if (depth === 'deep') {
        steps.push('\n## Step 5: 风险评估');
        const risks = assessRisks(problem, solutions);
        risks.forEach(r => steps.push(`  - ${r}`));
      }

      // Step 6: 相关经验检索（并行异步 I/O）
      const [memories, skills] = await Promise.all([
        searchMemories(problem, 3),
        searchSkills(problem, 3),
      ]);
      if (memories.length > 0 || skills.length > 0) {
        steps.push('\n## 相关经验');
        if (memories.length > 0) {
          steps.push('  📖 记忆:');
          memories.forEach((m, i: number) => {
            steps.push(`    ${i + 1}. [${m.type || 'memory'}] ${(m.content || '').substring(0, 120)}`);
          });
        }
        if (skills.length > 0) {
          steps.push('  🔧 技能:');
          skills.forEach((s, i: number) => {
            steps.push(`    ${i + 1}. ${s.name || '未命名'}: ${(s.description || '').substring(0, 100)}`);
          });
        }
      }

      // Step 7: 推荐方案
      steps.push('\n## Step 7: 推荐方案');
      steps.push(`  基于以上分析，推荐方案1（最直接解决问题且风险可控）。`);
      steps.push(`  建议先小范围验证，确认无误后再全面实施。`);

      const output = `🧠 扩展思考模式 (Extended Thinking)\n问题: ${problem.substring(0, 200)}\n深度: ${depth}\n${'='.repeat(60)}\n${steps.join('\n')}\n${'='.repeat(60)}\n✅ 思考完成。以上分析可辅助决策，请结合实际情况判断。`;

      return output;
    },
  },
];

/**
 * P1-2: 问题分解
 */
function decomposeProblem(problem: string): string[] {
  const subProblems: string[] = [];
  // 基于关键词的问题分解
  if (/如何|怎么|how/i.test(problem)) subProblems.push('明确目标：确定期望的最终状态');
  if (/为什么|why|原因/i.test(problem)) subProblems.push('根因分析：识别问题的根本原因');
  if (/优化|改进|improve|optimize/i.test(problem)) subProblems.push('现状评估：分析当前性能/效率瓶颈');
  if (/设计|架构|design|architecture/i.test(problem)) subProblems.push('架构约束：识别技术约束和业务需求');
  if (/bug|错误|失败|error|fail/i.test(problem)) subProblems.push('复现路径：确定问题复现的最小步骤');
  if (subProblems.length === 0) subProblems.push('问题理解：明确要解决的核心问题');
  subProblems.push('成功标准：定义问题解决的可验证标准');
  return subProblems;
}

/**
 * P1-2: 约束识别
 */
function identifyConstraints(problem: string, context: string): string[] {
  const constraints: string[] = [];
  const combined = `${problem} ${context}`.toLowerCase();
  if (/时间|deadline|紧急|urgent/i.test(combined)) constraints.push('时间约束：需要在限定时间内完成');
  if (/性能|performance|延迟|latency/i.test(combined)) constraints.push('性能约束：需满足性能指标要求');
  if (/安全|security|权限|permission/i.test(combined)) constraints.push('安全约束：需遵循安全规范');
  if (/兼容|compatible|兼容性/i.test(combined)) constraints.push('兼容性约束：需保持向后兼容');
  if (/成本|budget|预算/i.test(combined)) constraints.push('成本约束：需在预算范围内');
  if (/资源|resource|内存|memory|cpu/i.test(combined)) constraints.push('资源约束：受限于可用计算资源');
  return constraints;
}

/**
 * P1-2: 方案生成
 */
function generateSolutions(problem: string, count: number): string[] {
  const solutions: string[] = [];
  // 基于问题类型的方案模板
  if (/bug|错误|失败|error|fail/i.test(problem)) {
    solutions.push('直接修复：定位根因并最小化修改');
    if (count >= 2) solutions.push('防御性修复：增加边界检查和错误处理');
    if (count >= 3) solutions.push('重构修复：优化相关代码结构防止复发');
    if (count >= 4) solutions.push('监控修复：增加监控告警提前发现');
    if (count >= 5) solutions.push('文档修复：补充文档和注释防止误用');
  } else if (/优化|改进|improve|optimize/i.test(problem)) {
    solutions.push('渐进式优化：保持接口不变，内部优化');
    if (count >= 2) solutions.push('激进式优化：重新设计，追求最大性能');
    if (count >= 3) solutions.push('替代方案：使用完全不同的方法');
    if (count >= 4) solutions.push('缓存策略：通过缓存减少重复计算');
    if (count >= 5) solutions.push('异步化：将同步操作改为异步');
  } else {
    solutions.push('直接方案：最直接地解决问题');
    if (count >= 2) solutions.push('稳健方案：更安全但可能更慢的方法');
    if (count >= 3) solutions.push('创新方案：尝试新的思路或技术');
    if (count >= 4) solutions.push('分阶段方案：先解决核心，再完善细节');
    if (count >= 5) solutions.push('并行方案：同时尝试多种方法');
  }
  return solutions.slice(0, count);
}

/**
 * P1-2: 边缘情况枚举
 */
function enumerateEdgeCases(problem: string, _context: string): string[] {
  const edgeCases: string[] = [];
  edgeCases.push('空输入/空值情况');
  edgeCases.push('超长输入/大数据量情况');
  edgeCases.push('并发/竞态条件');
  edgeCases.push('网络中断/超时情况');
  if (/文件|file|路径|path/i.test(problem)) edgeCases.push('文件不存在/权限不足情况');
  if (/用户|user|权限|permission/i.test(problem)) edgeCases.push('未授权/越权访问情况');
  if (/数据|data|数据库|database/i.test(problem)) edgeCases.push('数据不一致/脏数据情况');
  return edgeCases;
}

/**
 * P1-2: 风险评估
 */
function assessRisks(problem: string, solutions: string[]): string[] {
  const risks: string[] = [];
  risks.push('方案1风险：低 — 最直接但可能不够全面');
  if (solutions.length >= 2) risks.push('方案2风险：中 — 更稳健但复杂度增加');
  if (solutions.length >= 3) risks.push('方案3风险：高 — 创新但不确定性大');
  risks.push('通用风险：修改可能引入新问题，需充分测试');
  risks.push('回滚风险：确保有回滚方案（使用 rewind_files 工具）');
  return risks;
}
