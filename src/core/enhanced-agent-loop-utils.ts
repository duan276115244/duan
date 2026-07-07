/**
 * enhanced-agent-loop-utils.ts
 * 从 enhanced-agent-loop.ts 抽出的模块级纯函数和类型定义
 * 这些函数不依赖 EnhancedAgentLoop 类的实例状态，可独立使用和测试
 */

import { logger } from './structured-logger.js';

// ============ 结构化错误分类 ============

/** 结构化错误分类 */
export type ErrorCategory =
  | 'rate_limit'      // 429 限速
  | 'auth_error'      // 401/403 认证错误
  | 'insufficient_balance' // 402 余额不足
  | 'context_too_long' // 400 上下文过长
  | 'model_not_found' // 404 模型不存在或不支持
  | 'timeout'         // 超时
  | 'network_error'   // 网络错误
  | 'model_error'     // 模型服务错误 (5xx)
  | 'tool_error'      // 工具执行错误
  | 'unknown';        // 未知错误

/**
 * 5大类错误分类（与 self-healing-pipeline 保持一致）
 * - network: 网络错误（timeout/ECONNREFUSED/DNS）
 * - permission: 权限错误（401/403/ENOENT）
 * - syntax: 语法错误（SyntaxError/TypeError）
 * - resource: 资源错误（OOM/disk full）
 * - logic: 逻辑错误（assertion/business rule）
 */
export type ErrorCategory5 = 'network' | 'permission' | 'syntax' | 'resource' | 'logic' | 'unknown';

export function classifyError(error: any): ErrorCategory {
  const msg = String(error?.message || error?.code || '').toLowerCase();
  const status = error?.status || error?.statusCode;

  if (status === 429 || msg.includes('rate') || msg.includes('too many')) return 'rate_limit';
  if (status === 402 || msg.includes('insufficient') || msg.includes('balance') || msg.includes('余额')) return 'insufficient_balance';
  if (status === 401 || status === 403 || msg.includes('auth') || msg.includes('api key') || msg.includes('unauthorized') || msg.includes('authentication')) return 'auth_error';
  if (status === 404 || msg.includes('does not support') || msg.includes('model not found') || msg.includes('not support the coding plan')) return 'model_not_found';
  if (status === 400 || msg.includes('context') || msg.includes('token') || msg.includes('too long') || msg.includes('maximum') || msg.includes('invalid') || msg.includes('bad request')) return 'context_too_long';
  if (msg.includes('timeout') || msg.includes('timed out') || msg.includes('etimedout') || msg.includes('abort')) return 'timeout';
  if (msg.includes('econnrefused') || msg.includes('enotfound') || msg.includes('network') || msg.includes('fetch failed') || msg.includes('connection error')) return 'network_error';
  if ((status >= 500) || msg.includes('server error') || msg.includes('overloaded')) return 'model_error';
  if (msg.includes('tool') || msg.includes('execute')) return 'tool_error';
  return 'unknown';
}

/**
 * 将错误分类映射到5大类系统（用于自愈管道集成）
 * @param error 原始错误对象
 * @param detailedCategory 详细错误分类（来自 classifyError）
 * @returns 5大类错误分类
 */
export function classifyError5Category(error: any, detailedCategory?: ErrorCategory): ErrorCategory5 {
  const msg = String(error?.message || error?.code || '').toLowerCase();
  const category = detailedCategory || classifyError(error);

  // 网络错误类
  if (category === 'timeout' || category === 'network_error' || category === 'rate_limit' ||
      msg.includes('econnrefused') || msg.includes('econnreset') || msg.includes('enotfound') ||
      msg.includes('dns') || msg.includes('getaddrinfo')) {
    return 'network';
  }

  // 权限错误类
  if (category === 'auth_error' ||
      msg.includes('eacces') || msg.includes('permission denied') || msg.includes('forbidden') ||
      msg.includes('enoent') || msg.includes('no such file') || msg.includes('not found')) {
    return 'permission';
  }

  // 语法错误类
  if (msg.includes('syntaxerror') || msg.includes('typeerror') || msg.includes('unexpected token') ||
      msg.includes('is not a function') || msg.includes('is not defined') || msg.includes('语法错误')) {
    return 'syntax';
  }

  // 资源错误类
  if (msg.includes('out of memory') || msg.includes('oom') || msg.includes('heap out of memory') ||
      msg.includes('enospc') || msg.includes('disk full') || msg.includes('no space left') ||
      msg.includes('内存不足') || msg.includes('磁盘')) {
    return 'resource';
  }

  // 逻辑错误类
  if (msg.includes('assertion') || msg.includes('assert') || msg.includes('validation failed') ||
      msg.includes('断言') || msg.includes('业务规则')) {
    return 'logic';
  }

  return 'unknown';
}

/**
 * 生成自愈修复提示（基于5大类错误分类）
 * @param category5 5大类错误分类
 * @param errorMsg 错误消息
 * @returns 自愈提示文本，空字符串表示无需提示
 */
export function generateSelfHealingHint(category5: ErrorCategory5, errorMsg: string): string {
  switch (category5) {
    case 'network':
      return '【自动修复·网络错误】建议：1)检查网络连接 2)等待后重试 3)切换DNS 4)使用IP直连 5)降低并发度';
    case 'permission':
      if (errorMsg.toLowerCase().includes('enoent') || errorMsg.toLowerCase().includes('not found')) {
        return '【自动修复·资源不存在】建议：1)检查路径是否正确 2)使用绝对路径 3)搜索相似文件 4)创建缺失的资源';
      }
      return '【自动修复·权限错误】建议：1)检查文件权限 2)请求权限提升 3)使用替代路径 4)检查文件锁定';
    case 'syntax':
      if (errorMsg.toLowerCase().includes('typeerror')) {
        return '【自动修复·类型错误】建议：1)添加空值检查 2)使用可选链(?.) 3)添加类型守卫 4)检查变量初始化';
      }
      return '【自动修复·语法错误】建议：1)检查括号匹配 2)检查逗号/分号 3)检查字符串闭合 4)检查保留字';
    case 'resource':
      if (errorMsg.toLowerCase().includes('oom') || errorMsg.toLowerCase().includes('memory')) {
        return '【自动修复·内存不足】建议：1)触发垃圾回收 2)减小批处理大小 3)分批处理 4)增加内存限制 5)检查内存泄漏';
      }
      return '【自动修复·磁盘不足】建议：1)清理临时文件 2)清理npm缓存 3)清理日志 4)清理构建产物 5)检查磁盘配额';
    case 'logic':
      return '【自动修复·逻辑错误】建议：1)验证输入数据 2)检查前置条件 3)调整断言条件 4)添加错误上下文 5)检查边界情况';
    default:
      return '';
  }
}

// ============ 伪工具调用提取 ============

export interface PseudoToolCall {
  name: string;
  args: Record<string, string>;
  rawMatch: string;
}

/**
 * 尝试修复截断的 JSON 字符串
 * 当模型输出被 max_tokens 截断时，tool_calls.arguments 可能是不完整的 JSON
 * 例如: {"path": "index.html", "content": "<!DOCTYPE html>...
 * 策略：找到最后一个完整的键值对，闭合所有未关闭的引号和括号
 */
export function tryRepairJSON(raw: string): unknown {
  if (!raw || raw.trim() === '') return {};
  const str = raw.trim();

  // 尝试直接解析
  try { return JSON.parse(str); } catch {}

  // 策略1：逐步截断尾部，尝试找到可解析的前缀
  // 从末尾向前扫描，找到可以闭合的位置
  for (let i = str.length - 1; i >= 2; i--) {
    const sub = str.substring(0, i);
    // 跳过在逗号、冒号、反斜杠后截断的位置
    if (sub.endsWith(',') || sub.endsWith(':') || sub.endsWith('\\')) continue;
    // 尝试多种闭合方式
    for (const suffix of ['}', '"}', '"}}', '"}}}', '"]}', '"}]}}']) {
      try {
        const parsed = JSON.parse(sub + suffix);
        if (typeof parsed === 'object' && parsed !== null) return parsed;
      } catch {}
    }
    // 性能优化：找到第一个有效结果就返回，不要遍历所有位置
    // 但也限制最多尝试 200 个位置
    if (str.length - i > 200) break;
  }

  // 策略2：用正则提取键值对（支持转义字符）
  const result: Record<string, unknown> = {};

  // 提取字符串值（支持 \n \t \" 等转义）
  const strRegex = /"(\w+)"\s*:\s*"((?:[^"\\]|\\.)*)"/g;
  let match;
  while ((match = strRegex.exec(str)) !== null) {
    // 反转义 JSON 字符串
    try {
      result[match[1]] = JSON.parse('"' + match[2] + '"');
    } catch {
      result[match[1]] = match[2];
    }
  }

  // 提取非字符串值
  const kvNumRegex = /"(\w+)"\s*:\s*(\d+(?:\.\d+)?)/g;
  while ((match = kvNumRegex.exec(str)) !== null) {
    if (!(match[1] in result)) result[match[1]] = Number(match[2]);
  }
  const kvBoolRegex = /"(\w+)"\s*:\s*(true|false)/g;
  while ((match = kvBoolRegex.exec(str)) !== null) {
    if (!(match[1] in result)) result[match[1]] = match[2] === 'true';
  }

  return result;
}

/**
 * 规范化 tool_calls 的 arguments 字段，确保每个 arguments 都是合法 JSON 字符串。
 *
 * 用途：LLM 流式输出可能产生截断的 arguments（如 `{"path":"x.html"` 缺闭合）。
 * 若不修复就写入对话历史（state.messages），下一轮 API 调用会把残缺 args 发回服务端，
 * 触发 400 BadRequestError 导致任务终止（"无法完成"的直接根因）。
 *
 * 策略：JSON.parse 成功则保留；失败则 tryRepairJSON 修复后 JSON.stringify 回写；
 * 完全无法修复则回退 '{}'（避免历史携带半截 JSON）。
 *
 * @returns 修复/回退的计数（用于日志）
 */
export function normalizeToolCallArgsForHistory(
  toolCalls: Array<{ id: string; name: string; arguments: string }>,
): { repairedCount: number; failedCount: number } {
  let repaired = 0;
  let failed = 0;
  for (const tc of toolCalls) {
    if (!tc.arguments) { tc.arguments = '{}'; continue; }
    try { JSON.parse(tc.arguments); continue; } catch { /* 已合法则跳过，解析失败走修复 */ }
    const obj = tryRepairJSON(tc.arguments);
    if (obj && typeof obj === 'object' && Object.keys(obj as Record<string, unknown>).length > 0) {
      tc.arguments = JSON.stringify(obj);
      repaired++;
    } else {
      tc.arguments = '{}';
      failed++;
      logger.warn('tool_call arguments 修复失败，回退为空对象（避免下轮 API 400）', {
        tool: tc.name, raw: tc.arguments.substring(0, 200),
      });
    }
  }
  return { repairedCount: repaired, failedCount: failed };
}

/**
 * 从LLM文本输出中提取伪工具调用标签，转换为真实工具调用
 *
 * 支持的格式：
 * - <shell_execute><command>xxx</command></shell_execute>
 * - <browser_operate>{"action":"goto","url":"xxx"}</browser_operate>
 * - <｜｜DSML｜｜invoke name="tool_name"><｜｜DSML｜｜parameter name="param">value</parameter></invoke>
 * - 独立JSON行: browser_operate\n{"action":"goto","url":"xxx"}
 */
export function extractPseudoToolCalls(text: string): PseudoToolCall[] {
  const results: PseudoToolCall[] = [];

  // 格式1: <tool_name>...</tool_name> 格式
  const toolRegex = /<(\w+)>([\s\S]*?)<\/\1>/g;
  let match: RegExpExecArray | null;

  while ((match = toolRegex.exec(text)) !== null) {
    const toolName = match[1];
    const innerContent = match[2];
    const fullMatch = match[0];

    // 跳过非工具标签
    const skipTags = ['think', 'thinking', 'thought', 'reasoning', 'plan', 'note',
      'p', 'b', 'i', 'em', 'strong', 'div', 'span', 'br', 'hr',
      'h1', 'h2', 'h3', 'h4', 'h5', 'h6', 'ul', 'ol', 'li',
      'code', 'pre', 'blockquote', 'a', 'img', 'table', 'tr', 'td', 'th',
      'parameter', 'invoke', 'tool_calls'];
    if (skipTags.includes(toolName.toLowerCase())) continue;

    const args: Record<string, string> = {};

    // 先尝试解析内部内容为JSON
    const trimmedInner = innerContent.trim();
    try {
      const jsonArgs = JSON.parse(trimmedInner);
      if (typeof jsonArgs === 'object' && jsonArgs !== null) {
        for (const [k, v] of Object.entries(jsonArgs)) {
          args[k] = String(v);
        }
      }
    } catch {
      // 非JSON，提取子标签参数
      const paramRegex = /<(\w+)>([\s\S]*?)<\/\1>/g;
      let paramMatch: RegExpExecArray | null;
      while ((paramMatch = paramRegex.exec(innerContent)) !== null) {
        args[paramMatch[1]] = paramMatch[2].trim();
      }

      // 没有子标签，根据工具名推断参数
      if (Object.keys(args).length === 0 && trimmedInner) {
        if (toolName === 'shell_execute' || toolName === 'shell') {
          args.command = trimmedInner;
        } else if (toolName === 'web_search' || toolName === 'search') {
          args.query = trimmedInner;
        } else if (toolName === 'browser_operate' || toolName === 'browser') {
          args.action = trimmedInner;
        } else {
          args.content = trimmedInner;
        }
      }
    }

    if (Object.keys(args).length > 0) {
      results.push({ name: toolName, args, rawMatch: fullMatch });
    }
  }

  // 格式2: DSML格式
  const dsmlRegex = /<｜｜DSML｜｜invoke\s+name="(\w+)">([\s\S]*?)<\/｜｜DSML｜｜invoke>/g;
  while ((match = dsmlRegex.exec(text)) !== null) {
    const toolName = match[1];
    const innerContent = match[2];
    const fullMatch = match[0];
    const args: Record<string, string> = {};

    const paramRegex2 = /<｜｜DSML｜｜parameter\s+name="(\w+)"[^>]*>([\s\S]*?)<\/｜｜DSML｜｜parameter>/g;
    let paramMatch: RegExpExecArray | null;
    while ((paramMatch = paramRegex2.exec(innerContent)) !== null) {
      args[paramMatch[1]] = paramMatch[2].trim();
    }

    if (Object.keys(args).length > 0) {
      results.push({ name: toolName, args, rawMatch: fullMatch });
    }
  }

  // 格式3: ```tool_call 代码块格式（用于不支持 function calling 的模型）
  const toolCallBlockRegex = /```tool_call\s*\n([\s\S]*?)```/g;
  while ((match = toolCallBlockRegex.exec(text)) !== null) {
    const blockContent = match[1].trim();
    const fullMatch = match[0];
    try {
      const parsed = JSON.parse(blockContent);
      if (parsed.name && typeof parsed.name === 'string') {
        const args: Record<string, string> = {};
        if (parsed.arguments && typeof parsed.arguments === 'object') {
          for (const [k, v] of Object.entries(parsed.arguments)) {
            args[k] = String(v);
          }
        } else if (parsed.args && typeof parsed.args === 'object') {
          for (const [k, v] of Object.entries(parsed.args)) {
            args[k] = String(v);
          }
        }
        if (Object.keys(args).length > 0) {
          results.push({ name: parsed.name, args, rawMatch: fullMatch });
        }
      }
    } catch {
      // 可能是多行 JSON 或格式不对，尝试逐行解析
      const lines = blockContent.split('\n').filter(l => l.trim());
      for (const line of lines) {
        try {
          const parsed = JSON.parse(line.trim());
          if (parsed.name && typeof parsed.name === 'string') {
            const args: Record<string, string> = {};
            const argObj = parsed.arguments || parsed.args || {};
            if (typeof argObj === 'object') {
              for (const [k, v] of Object.entries(argObj)) {
                args[k] = String(v);
              }
            }
            if (Object.keys(args).length > 0) {
              results.push({ name: parsed.name, args, rawMatch: fullMatch });
            }
          }
        } catch {}
      }
    }
  }

  // 格式4: 工具名后跟独立JSON行
  const knownTools = ['browser_operate', 'shell_execute', 'web_search', 'file_write',
    'file_read', 'screen_click', 'screen_type', 'desktop_open', 'screen_screenshot',
    'screen_scroll', 'window_manage', 'clipboard'];
  const jsonLineRegex = new RegExp(`(${knownTools.join('|')})\\s*\\n\\s*(\\{[^}]+\\})`, 'g');
  while ((match = jsonLineRegex.exec(text)) !== null) {
    const toolName = match[1];
    const jsonStr = match[2];
    const fullMatch = match[0];

    try {
      const jsonArgs = JSON.parse(jsonStr);
      const args: Record<string, string> = {};
      for (const [k, v] of Object.entries(jsonArgs)) {
        args[k] = String(v);
      }
      if (Object.keys(args).length > 0) {
        results.push({ name: toolName, args, rawMatch: fullMatch });
      }
    } catch {}
  }

  return results;
}

/** 工具失败时返回正确用法示例 */
export function getToolUsageHint(toolName: string): string {
  const hints: Record<string, string> = {
    browser_operate: `\n正确用法示例:
- 打开网页: browser_operate(action="goto", url="https://www.doubao.com")
- 点击元素: browser_operate(action="click", selector="登录")
- 输入文字: browser_operate(action="type", selector="输入框", text="80年代怀旧视频")
- 截图: browser_operate(action="screenshot")
- 提取页面: browser_operate(action="extract")
- 等待变化: browser_operate(action="wait_for_change")
- 按键: browser_operate(action="press", key="Enter")`,
    shell_execute: `\n正确用法: shell_execute(command="mkdir -p src/components") 或 shell_execute(command="npm install axios")`,
    web_search: `\n正确用法: web_search(query="80年代怀旧视频")`,
    screen_click: `\n正确用法: screen_click(x=500, y=300)`,
    screen_type: `\n正确用法: screen_type(text="80年代怀旧视频")`,
    desktop_open: `\n正确用法: desktop_open(target="chrome") 或 desktop_open(target="https://www.doubao.com")`,
    file_write: `\n正确用法: file_write(path="xxx.txt", content="内容")\n注意: path参数也接受 filePath/file_path/filename/file`,
    file_edit: `\n正确用法: file_edit(path="xxx.ts", old_text="原代码", new_text="新代码")\n注意: 局部编辑，避免整文件重写`,
    file_read: `\n正确用法: file_read(path="xxx.ts")`,
    search_files: `\n正确用法: search_files(pattern="*.ts", root="src")`,
    grep_search: `\n正确用法: grep_search(pattern="function.*export", include="*.ts")`,
    list_directory: `\n正确用法: list_directory(path="src")`,
    code_execute: `\n正确用法: code_execute(code="return 1+1")`,
  };
  return hints[toolName] || '';
}
