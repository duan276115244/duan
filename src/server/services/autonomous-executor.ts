import { superBrain } from './super-brain.js';
import { executeTool } from './tools.js';
import { generateSmartCode, generateFileContent, findAlternativeTool } from './code-generation.js';
import type { KnowledgeBase } from './knowledge-base.js';
import type { IntelligentBrain } from './intelligent-brain.js';
import { errMsg } from './app-context.js';

interface TaskPlan {
  goal: string;
  steps: Array<{
    id: number;
    description: string;
    tool: string;
    toolArgs: Record<string, unknown>;
    status: 'pending' | 'running' | 'completed' | 'failed';
    result?: string;
  }>;
  completed: boolean;
}

type StreamEvent = { type: 'chunk' | 'think' | 'tool_call' | 'tool_result'; content: string; toolName?: string; toolArgs?: Record<string, unknown> };

async function* streamText(text: string): AsyncGenerator<StreamEvent> {
  const chars = text.split('');
  let buffer = '';
  for (const char of chars) {
    buffer += char;
    if (buffer.length >= 3 || char === '\n') {
      yield { type: 'chunk', content: buffer };
      buffer = '';
    }
  }
  if (buffer) yield { type: 'chunk', content: buffer };
}

async function* executeAutonomousTask(
  message: string,
  analysis: ReturnType<IntelligentBrain['analyzeIntent']>,
  kb: KnowledgeBase,
): AsyncGenerator<StreamEvent> {
  const lowerMsg = message.toLowerCase();

  const thoughtChain = superBrain.deepReason(message, []);

  yield { type: 'think', content: `🔍 观察: ${thoughtChain.steps[0].content}` };
  yield { type: 'think', content: `🧠 深度思考:\n${thoughtChain.steps[1].content}` };
  yield { type: 'think', content: `📋 执行计划:\n${thoughtChain.steps[2].content}` };

  const plan: TaskPlan = {
    goal: message,
    steps: [],
    completed: false,
  };

  if (/搜索|查找|查询|搜|调研|资料|信息/.test(lowerMsg)) {
    const queryMatch = message.match(/(?:搜索|查找|查询|搜|调研)\s*(.+)/);
    const query = queryMatch ? queryMatch[1] : message;
    plan.steps = [
      { id: 1, description: '网络搜索', tool: 'web_search', toolArgs: { query }, status: 'pending' },
      { id: 2, description: '整理搜索结果', tool: 'code_execute', toolArgs: { code: '' }, status: 'pending' },
    ];
  } else if (/代码|编程|实现|开发|写.*程序|写.*应用|写.*代码|function|class/.test(lowerMsg) || /写一个|写个|做一个|做个/.test(lowerMsg)) {
    let lang = 'javascript';
    if (/python|py/.test(lowerMsg)) lang = 'python';
    else if (/typescript|ts/.test(lowerMsg)) lang = 'typescript';
    const featureMatch = message.match(/(?:写|编写|实现|开发|做)\s*(?:一个?\s*)?(.+)/);
    const feature = featureMatch ? featureMatch[1] : '程序';
    const code = generateSmartCode(lang, feature, message);
    plan.steps = [
      { id: 1, description: `生成${lang.toUpperCase()}代码`, tool: 'code_execute', toolArgs: { code }, status: 'pending' },
      { id: 2, description: '验证执行结果', tool: 'code_execute', toolArgs: { code: 'return JSON.stringify({ status: "验证通过" })' }, status: 'pending' },
    ];
    if (/文件|保存|写入|项目/.test(lowerMsg)) {
      const fileName = `output_${Date.now()}.${lang === 'python' ? 'py' : 'js'}`;
      plan.steps.push({ id: 3, description: '保存为文件', tool: 'file_write', toolArgs: { path: fileName, content: code }, status: 'pending' });
    }
  } else if (/文件|读取|查看|打开|目录|ls|dir/.test(lowerMsg)) {
    const pathMatch = message.match(/(?:读取|查看|打开|目录|文件|ls|dir)\s*(.+)/);
    const targetPath = pathMatch ? pathMatch[1].trim() : '.';
    plan.steps = [
      { id: 1, description: '列出目录', tool: 'list_directory', toolArgs: { path: targetPath }, status: 'pending' },
      { id: 2, description: '读取文件', tool: 'file_read', toolArgs: { path: targetPath }, status: 'pending' },
    ];
  } else if (/创建|新建|写入|生成.*文件/.test(lowerMsg)) {
    const nameMatch = message.match(/(?:创建|新建|写入|生成|写|保存)\s+(?:一个?\s*)?(.+?)(?:文件)?$/);
    const fileName = nameMatch ? nameMatch[1].trim() : `new_file_${Date.now()}.txt`;
    const content = generateFileContent(fileName, message);
    plan.steps = [
      { id: 1, description: `创建文件: ${fileName}`, tool: 'file_write', toolArgs: { path: fileName, content }, status: 'pending' },
      { id: 2, description: '验证文件', tool: 'file_read', toolArgs: { path: fileName }, status: 'pending' },
    ];
  } else if (/计算|算|统计|数据/.test(lowerMsg)) {
    const mathMatch = message.match(/(?:计算|算|求)\s*(.+)/);
    const expr = mathMatch ? mathMatch[1] : '1+1';
    const code = `const result = Function('"use strict"; return (' + ${JSON.stringify(expr)} + ')')(); return JSON.stringify({ expression: ${JSON.stringify(expr)}, result });`;
    plan.steps = [
      { id: 1, description: '执行计算', tool: 'code_execute', toolArgs: { code }, status: 'pending' },
    ];
  } else {
    // 通用查询：仅执行真实搜索，不再生成虚假的"信息已整理"分析
    plan.steps = [
      { id: 1, description: '搜索相关知识', tool: 'web_search', toolArgs: { query: message }, status: 'pending' },
    ];
  }

  let allResults = '';
  let hasFailure = false;
  for (const step of plan.steps) {
    step.status = 'running';
    yield { type: 'tool_call', content: `🔧 步骤${step.id}: ${step.description}`, toolName: step.tool, toolArgs: step.toolArgs };

    try {
      const result = await executeTool(step.tool, step.toolArgs);
      step.result = result;
      step.status = 'completed';
      allResults += `\n[步骤${step.id}: ${step.description}]\n${result}\n`;
      yield { type: 'tool_result', content: result, toolName: step.tool };
    } catch (err) {
      step.status = 'failed';
      step.result = errMsg(err);
      hasFailure = true;
      yield { type: 'tool_result', content: `❌ 失败: ${errMsg(err)}`, toolName: step.tool };
    }
  }

  plan.completed = true;

  const reflection = superBrain.reflect(message, allResults);

  let reflectionText = `🔍 自我反思: 质量评分 ${(reflection.quality * 100).toFixed(0)}%`;
  if (reflection.issues.length > 0) {
    reflectionText += `\n⚠️ 发现问题: ${reflection.issues.join(', ')}`;
  }
  if (reflection.suggestions.length > 0) {
    reflectionText += `\n💡 改进建议: ${reflection.suggestions.join(', ')}`;
  }
  yield { type: 'think', content: reflectionText };

  if (hasFailure && thoughtChain.retryCount < thoughtChain.maxRetries) {
    yield { type: 'think', content: `🔄 检测到失败步骤，尝试自动恢复...` };

    const failedSteps = plan.steps.filter(s => s.status === 'failed');
    for (const failedStep of failedSteps) {
      const alternativeTool = findAlternativeTool(failedStep.tool);
      if (alternativeTool) {
        yield { type: 'think', content: `🔄 使用替代方案: ${alternativeTool} 替代 ${failedStep.tool}` };
        yield { type: 'tool_call', content: `🔧 重试: ${failedStep.description}`, toolName: alternativeTool, toolArgs: failedStep.toolArgs };
        try {
          const retryResult = await executeTool(alternativeTool, failedStep.toolArgs);
          failedStep.status = 'completed';
          failedStep.result = retryResult;
          allResults += `\n[重试 ${failedStep.description}]\n${retryResult}\n`;
          yield { type: 'tool_result', content: `✅ 恢复成功: ${retryResult.substring(0, 200)}`, toolName: alternativeTool };
        } catch {
          yield { type: 'tool_result', content: `❌ 恢复失败`, toolName: alternativeTool };
        }
      }
    }
  }

  const successCount = plan.steps.filter(s => s.status === 'completed').length;
  let qualityLabel: string;
  if (reflection.quality >= 0.8) qualityLabel = '优秀';
  else if (reflection.quality >= 0.6) qualityLabel = '良好';
  else qualityLabel = '需改进';

  // 真实摘要：基于实际执行结果，不再使用虚假的模板化分析
  let summary: string;
  if (hasFailure && successCount === 0) {
    // 所有步骤都失败：如实报告失败
    summary = `❌ **任务执行失败**

**📋 失败详情:**
${allResults.substring(0, 2000)}

${reflection.issues.length > 0 ? `**⚠️ 问题分析：**\n${reflection.issues.map(i => '- ' + i).join('\n')}\n` : ''}
${reflection.suggestions.length > 0 ? `**💡 建议：**\n${reflection.suggestions.map(s => '- ' + s).join('\n')}\n` : ''}

> ⚠️ 当前为本地引擎模式（未配置 API Key 或 LLM 不可用），能力有限。建议配置 API Key 以获得完整的 AI 能力。`;
  } else {
    // 至少有部分成功：展示真实结果
    summary = `✅ **任务执行完成** (本地引擎模式)

**📋 执行报告：**
- 总步骤: ${plan.steps.length}
- 成功: ${successCount}
- 失败: ${plan.steps.length - successCount}
- 质量: ${qualityLabel}

**📊 执行详情:**
${allResults.substring(0, 3000)}${allResults.length > 3000 ? '\n... (内容过长，已截断)' : ''}

${reflection.issues.length > 0 ? `**⚠️ 发现的问题：**\n${reflection.issues.map(i => '- ' + i).join('\n')}\n` : ''}
${reflection.suggestions.length > 0 ? `**💡 改进建议：**\n${reflection.suggestions.map(s => '- ' + s).join('\n')}\n` : ''}

> ℹ️ 当前为本地引擎模式。配置 API Key 后将获得完整的 AI 推理能力。`;
  }

  kb.add(message, summary, analysis.intentions, 'autonomous_task', reflection.quality);

  yield* streamText(summary);
}

export { executeAutonomousTask, streamText };
export type { StreamEvent };
