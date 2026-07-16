/**
 * 段先生 - 全能管家模块 (OmniAssistant)
 * 能够理解自然语言并自动执行各种任务
 */

import { Anthropic } from '@anthropic-ai/sdk';
import OpenAI from 'openai';
import { exec } from 'child_process';
import * as fs from 'fs/promises';

interface Task {
  id: string;
  type: string;
  description: string;
  steps: Step[];
  status: 'pending' | 'in_progress' | 'completed';
  result?: string;
}

interface Step {
  id: string;
  action: string;
  args: string[];
  completed: boolean;
  result?: string;
}

interface ExecutionResult {
  success: boolean;
  output?: string;
  error?: string;
}

export class OmniAssistant {
  private anthropic: Anthropic | null = null;
  private openai: OpenAI | null = null;

  constructor() {
    if (process.env.ANTHROPIC_API_KEY) {
      this.anthropic = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });
    }
    if (process.env.OPENAI_API_KEY) {
      this.openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });
    }
  }

  async understandAndExecute(input: string): Promise<string> {
    const analysis = await this.analyzeIntent(input);
    console.info(`🧠 意图分析: ${analysis.type}`);
    
    const task = await this.planTask(input, analysis);
    console.info(`📋 任务计划: ${task.steps.length} 个步骤`);
    
    const result = await this.executeTask(task);
    return result;
  }

  private async analyzeIntent(input: string): Promise<{ type: string; parameters: Record<string, string> }> {
    const prompt = `
分析用户的意图：

用户输入：${input}

请识别意图类型并提取参数。可用的意图类型：
- code: 编写或分析代码
- file: 文件操作（读取、写入、编辑）
- search: 网络搜索
- image: 图像生成或分析
- video: 视频生成或编辑
- plan: 制定计划
- execute: 执行命令
- research: 研究分析
- write: 写作
- translate: 翻译
- analyze: 数据分析
- decision: 决策
- learning: 学习相关

请输出JSON格式：
{"type": "意图类型", "parameters": {"参数名": "值"}}
    `;

    try {
      let response: string;

      if (this.anthropic) {
        const message = await this.anthropic.messages.create({
          model: 'claude-3-5-sonnet-20241022',
          max_tokens: 512,
          messages: [{ role: 'user', content: prompt }],
          system: '你是一个意图识别专家，请分析用户输入并识别意图。',
        });
        response = message.content
          .filter(block => block.type === 'text')
          .map(block => (block as unknown as { text: string }).text)
          .join('');
      } else if (this.openai) {
        const completion = await this.openai.chat.completions.create({
          model: 'gpt-4-turbo',
          messages: [
            { role: 'system', content: '你是一个意图识别专家，请分析用户输入并识别意图。' },
            { role: 'user', content: prompt },
          ],
          max_tokens: 512,
        });
        response = completion.choices?.[0]?.message?.content || '{}';
      } else {
        return { type: 'general', parameters: {} };
      }

      const match = response.match(/\{[\s\S]*\}/);
      if (match) {
        try {
          return JSON.parse(match[0]);
        } catch {
          return { type: 'general', parameters: {} };
        }
      }

      return { type: 'general', parameters: {} };
    } catch {
      return { type: 'general', parameters: {} };
    }
  }

  private async planTask(input: string, analysis: { type: string; parameters: Record<string, string> }): Promise<Task> {
    const prompt = `
为以下任务制定执行计划：

用户需求：${input}
意图类型：${analysis.type}
参数：${JSON.stringify(analysis.parameters)}

请分解为具体的执行步骤，每个步骤包含动作和参数。

输出格式：
步骤1: 动作(参数1, 参数2) - 说明
步骤2: 动作(参数1) - 说明
步骤3: 动作(参数1, 参数2, 参数3) - 说明

可用动作：
- read_file(path) - 读取文件
- write_file(path, content) - 写入文件
- edit_file(path, old_text, new_text) - 编辑文件
- execute_command(command) - 执行命令
- search_web(query) - 网络搜索
- generate_image(prompt) - 生成图像
- generate_video(prompt) - 生成视频
- analyze_code(path) - 分析代码
- write_code(language, code) - 编写代码
- summarize(text) - 总结内容
- translate(text, target_language) - 翻译
- calculate(expression) - 计算
- create_project(name) - 创建项目
- send_message(platform, message) - 发送消息
    `;

    let response: string;

    if (this.anthropic) {
      const message = await this.anthropic.messages.create({
        model: 'claude-3-5-sonnet-20241022',
        max_tokens: 1024,
        messages: [{ role: 'user', content: prompt }],
        system: '你是一个任务规划专家，请将任务分解为具体步骤。',
      });
      response = message.content
        .filter(block => block.type === 'text')
        .map(block => (block as unknown as { text: string }).text)
        .join('');
    } else if (this.openai) {
      const completion = await this.openai.chat.completions.create({
        model: 'gpt-4-turbo',
        messages: [
          { role: 'system', content: '你是一个任务规划专家，请将任务分解为具体步骤。' },
          { role: 'user', content: prompt },
        ],
        max_tokens: 1024,
      });
      response = completion.choices?.[0]?.message?.content || '';
    } else {
      response = `步骤1: execute_command(dir) - 列出当前目录`;
    }

    const steps: Step[] = [];
    const lines = response.split('\n');
    
    for (const line of lines) {
      const match = line.match(/步骤(\d+):\s*(\w+)\(([^)]*)\)\s*-\s*(.+)/);
      if (match) {
        const args = match[3]
          .split(',')
          .map(a => a.trim().replace(/['"]/g, ''))
          .filter(a => a);
        
        steps.push({
          id: `step_${match[1]}`,
          action: match[2],
          args,
          completed: false,
        });
      }
    }

    return {
      id: `task_${Date.now()}`,
      type: analysis.type,
      description: input,
      steps,
      status: 'pending',
    };
  }

  private async executeTask(task: Task): Promise<string> {
    task.status = 'in_progress';
    const results: string[] = [];

    for (const step of task.steps) {
      console.info(`🔄 执行步骤: ${step.action}(${step.args.join(', ')})`);
      
      let result: ExecutionResult;
      
      switch (step.action) {
        case 'read_file':
          result = await this.readFile(step.args[0]);
          break;
        case 'write_file':
          result = await this.writeFile(step.args[0], step.args[1] || '');
          break;
        case 'edit_file':
          result = await this.editFile(step.args[0], step.args[1] || '', step.args[2] || '');
          break;
        case 'execute_command':
          result = await this.executeCommand(step.args[0]);
          break;
        case 'search_web':
          result = await this.searchWeb(step.args[0]);
          break;
        case 'generate_image':
          result = await this.generateImage(step.args[0]);
          break;
        case 'analyze_code':
          result = await this.analyzeCode(step.args[0]);
          break;
        case 'calculate':
          result = await this.calculate(step.args[0]);
          break;
        default:
          result = { success: true, output: `未知动作: ${step.action}` };
      }

      step.completed = result.success;
      step.result = result.success ? result.output : result.error;
      
      if (result.success) {
        results.push(`✅ ${step.action}: ${result.output}`);
      } else {
        results.push(`❌ ${step.action}: ${result.error}`);
        task.status = 'completed';
        task.result = results.join('\n');
        return task.result;
      }
    }

    task.status = 'completed';
    task.result = results.join('\n');
    
    const summary = await this.summarizeTask(task);
    return summary;
  }

  private async summarizeTask(task: Task): Promise<string> {
    const prompt = `
总结以下任务执行结果：

任务: ${task.description}
步骤: ${task.steps.length} 个
状态: ${task.status}

执行结果:
${task.steps.map(s => `${s.action}: ${s.result}`).join('\n')}

请提供简洁的总结。
    `;

    if (this.anthropic) {
      const message = await this.anthropic.messages.create({
        model: 'claude-3-5-sonnet-20241022',
        max_tokens: 512,
        messages: [{ role: 'user', content: prompt }],
        system: '你是一个总结专家，请简洁总结任务执行结果。',
      });
      return message.content
        .filter(block => block.type === 'text')
        .map(block => (block as unknown as { text: string }).text)
        .join('');
    }

    return task.result || '任务已完成';
  }

  private async readFile(filePath: string): Promise<ExecutionResult> {
    try {
      const content = await fs.readFile(filePath, 'utf-8');
      return { success: true, output: `已读取文件: ${filePath}\n内容预览: ${content.substring(0, 200)}...` };
    } catch (error: unknown) {
      return { success: false, error: (error instanceof Error ? error.message : String(error)) };
    }
  }

  private async writeFile(filePath: string, content: string): Promise<ExecutionResult> {
    try {
      await fs.writeFile(filePath, content, 'utf-8');
      return { success: true, output: `已写入文件: ${filePath}` };
    } catch (error: unknown) {
      return { success: false, error: (error instanceof Error ? error.message : String(error)) };
    }
  }

  private async editFile(filePath: string, oldText: string, newText: string): Promise<ExecutionResult> {
    try {
      const content = await fs.readFile(filePath, 'utf-8');
      const newContent = content.replace(oldText, newText);
      await fs.writeFile(filePath, newContent, 'utf-8');
      return { success: true, output: `已编辑文件: ${filePath}` };
    } catch (error: unknown) {
      return { success: false, error: (error instanceof Error ? error.message : String(error)) };
    }
  }

  private executeCommand(command: string): Promise<ExecutionResult> {
    return new Promise((resolve) => {
      exec(command, { timeout: 30000 }, (error, stdout, stderr) => {
        if (error) {
          resolve({ success: false, error: error.message + '\n' + stderr });
        } else {
          resolve({ success: true, output: stdout || '命令执行成功' });
        }
      });
    });
  }

  private async searchWeb(query: string): Promise<ExecutionResult> {
    try {
      const axios = await import('axios');
      const response = await axios.default.get('https://api.duckduckgo.com/', {
        params: { q: query, format: 'json' },
      });
      const abstract = response.data.Abstract || '未找到摘要';
      return { success: true, output: `搜索结果: ${abstract}` };
    } catch (error: unknown) {
      return { success: false, error: (error instanceof Error ? error.message : String(error)) };
    }
  }

  private async generateImage(prompt: string): Promise<ExecutionResult> {
    if (!this.openai) {
      return { success: false, error: '需要 OpenAI API 密钥' };
    }

    try {
      const response = await this.openai.images.generate({
        model: 'dall-e-3',
        prompt,
        n: 1,
        size: '1024x1024',
      });
      const imgUrl = response.data?.[0]?.url || '未知';
      return { success: true, output: `图像生成成功: ${imgUrl}` };
    } catch (error: unknown) {
      return { success: false, error: (error instanceof Error ? error.message : String(error)) };
    }
  }

  private async analyzeCode(filePath: string): Promise<ExecutionResult> {
    try {
      const content = await fs.readFile(filePath, 'utf-8');
      const lines = content.split('\n');
      const functions = lines.filter(l => l.match(/function|const.*=.*=>|def /)).length;
      const classes = lines.filter(l => l.match(/class /)).length;
      return { 
        success: true, 
        output: `文件分析: ${filePath}\n行数: ${lines.length}\n函数: ${functions}\n类: ${classes}` 
      };
    } catch (error: unknown) {
      return { success: false, error: (error instanceof Error ? error.message : String(error)) };
    }
  }

  private calculate(expression: string): Promise<ExecutionResult> {
    try {
      // 安全的数学表达式求值：仅允许数字、运算符和括号
      if (!/^[\d\s+\-*/().%eE,]+$/.test(expression)) {
        return Promise.resolve({ success: false, error: '表达式包含不支持的字符，仅支持数字和运算符' });
      }
      // 使用 Function 构造器但在受限作用域中执行
      // eslint-disable-next-line no-new-func
      const result = Function('"use strict"; return (' + expression + ')')();
      if (typeof result !== 'number' || !isFinite(result)) {
        return Promise.resolve({ success: false, error: '计算结果无效' });
      }
      return Promise.resolve({ success: true, output: `${expression} = ${result}` });
    } catch (error: unknown) {
      return Promise.resolve({ success: false, error: (error instanceof Error ? error.message : String(error)) });
    }
  }
}
