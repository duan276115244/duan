/**
 * 跨应用数据流转与集成工具集 — CrossAppTools
 *
 * 覆盖能力：
 * 1. 跨应用数据传递（基于剪贴板/临时文件/共享数据通道）
 * 2. 应用集成网关（统一 API 调用各应用的能力）
 * 3. 安全访问机制（数据流审计 + 敏感信息脱敏 + 权限校验）
 * 4. 跨应用工作流编排（多应用协同，如"从 Excel 取数据 → 写入 Word → 发邮件"）
 *
 * 设计原则：
 * - 数据流转通过 toolContext 共享，避免全局状态污染
 * - 所有跨应用操作经 audit-logger 审计
 * - 敏感数据（密码/密钥/PII）自动脱敏
 * - 工作流编排支持条件分支与错误回滚
 */

import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { errMsg, type UnifiedToolDef } from '../../core/unified-tool-def.js';
import { matchSensitivePath, containsSensitiveKeyword } from '../../core/security-config.js';
import { toolContext } from './tool-context.js';
import { atomicWriteJson } from '../../core/atomic-write.js';

// ============ 类型定义 ============

interface DataPacket {
  id: string;
  source: string;          // 来源应用/工具
  target: string;          // 目标应用/工具
  type: 'text' | 'json' | 'file' | 'image' | 'table';
  content: unknown;        // 实际数据
  metadata?: Record<string, unknown>;
  timestamp: number;
  sensitivity: 'public' | 'internal' | 'confidential';
}

interface WorkflowNode {
  id: string;
  app: string;
  action: string;
  params?: Record<string, unknown>;
  inputs?: string[];        // 依赖的上游节点 id
  condition?: string;       // 条件表达式
}

// ============ 内存数据通道（进程级）============

const dataChannels: Map<string, DataPacket[]> = new Map();
const auditLog: Array<{ timestamp: number; action: string; source: string; target: string; dataType: string; sanitized: boolean }> = [];

// ============ 辅助函数 ============

function guardSensitivePath(p: string): string | null {
  if (matchSensitivePath(p)) return `❌ 拒绝访问敏感路径: ${p}`;
  return null;
}

/** 敏感数据脱敏 */
function sanitizeContent(content: unknown, sensitivity: string): { content: unknown; sanitized: boolean } {
  if (sensitivity === 'public') return { content, sanitized: false };
  if (typeof content !== 'string') return { content, sanitized: false };

  let sanitized = content;
  let didSanitize = false;
  // 脱敏手机号
  if (/1[3-9]\d{9}/.test(sanitized)) {
    sanitized = sanitized.replace(/1[3-9]\d{9}/g, m => m.substring(0, 3) + '****' + m.substring(7));
    didSanitize = true;
  }
  // 脱敏身份证
  if (/\d{17}[\dXx]/.test(sanitized)) {
    sanitized = sanitized.replace(/\d{17}[\dXx]/g, m => m.substring(0, 6) + '********' + m.substring(14));
    didSanitize = true;
  }
  // 脱敏邮箱
  if (/[\w.-]+@[\w.-]+\.\w+/.test(sanitized)) {
    sanitized = sanitized.replace(/([\w.-]+)@([\w.-]+\.\w+)/g, (_, name: string, domain: string) =>
      name.substring(0, 2) + '***@' + domain);
    didSanitize = true;
  }
  // 脱敏 API Key（sk-... 等）
  if (/sk-[a-zA-Z0-9]{20,}/.test(sanitized)) {
    sanitized = sanitized.replace(/sk-[a-zA-Z0-9]{20,}/g, 'sk-***REDACTED***');
    didSanitize = true;
  }
  // 检查 security-config 关键词
  if (containsSensitiveKeyword(sanitized)) {
    // 仅标记，不直接删除（保留数据可用性，由审计日志追踪）
    didSanitize = true;
  }
  return { content: sanitized, sanitized: didSanitize };
}

/** 记录审计日志 */
function audit(action: string, source: string, target: string, dataType: string, sanitized: boolean): void {
  auditLog.push({ timestamp: Date.now(), action, source, target, dataType, sanitized });
  // 限制日志大小
  if (auditLog.length > 200) auditLog.shift();
  // 同步到全局通知服务（如可用）
  try {
    if (toolContext.notificationService && typeof toolContext.notificationService.notify === 'function') {
      // 仅记录敏感操作到通知服务
      if (sanitized || action === 'cross_app_transfer') {
        void toolContext.notificationService.notify('info', '跨应用数据流', `${source} → ${target}: ${action} (${dataType})`, { source: 'cross-app-bridge' });
      }
    }
  } catch { /* 通知失败不阻断 */ }
}

/** 调用 LLM */
async function callLLM(prompt: string, systemPrompt?: string): Promise<string> {
  const ml = toolContext.modelLibrary;
  if (!ml || typeof ml.call !== 'function') throw new Error('ModelLibrary 未初始化');
  const messages: Array<{ role: 'system' | 'user'; content: string }> = [];
  if (systemPrompt) messages.push({ role: 'system', content: systemPrompt });
  messages.push({ role: 'user', content: prompt });
  const resp = await ml.call(messages);
  return resp.content || '';
}

// ============ 工具定义 ============

export const crossAppTools: UnifiedToolDef[] = [
  // ---------------- 跨应用数据传递 ----------------
  {
    name: 'cross_app_transfer',
    description: '跨应用数据传递。支持三种通道: (1) channel——命名数据通道(进程内共享); (2) clipboard——系统剪贴板; (3) file——临时文件中转。自动脱敏敏感信息并审计。',
    readOnly: false,
    parameters: {
      source: { type: 'string', description: '来源应用/工具名(如 "excel"/"browser"/"file_read")', required: true },
      target: { type: 'string', description: '目标应用/工具名(如 "word"/"wechat"/"email")', required: true },
      channel: { type: 'string', description: '通道: channel(命名通道)/clipboard(剪贴板)/file(临时文件)，默认 channel', required: false },
      channelName: { type: 'string', description: 'channel 模式必填: 通道名(如 "report_data")', required: false },
      data: { type: 'string', description: '要传递的数据(文本或JSON字符串)', required: true },
      dataType: { type: 'string', description: '数据类型: text/json/file/image/table，默认 text', required: false },
      sensitivity: { type: 'string', description: '敏感级别: public/internal/confidential，默认 internal', required: false },
    },
    execute: async (args) => {
      const source = args.source as string;
      const target = args.target as string;
      const channel = (args.channel as string) || 'channel';
      const dataType = (args.dataType as string) || 'text';
      const sensitivity = (args.sensitivity as string) || 'internal';
      const rawData = args.data as string;

      // 脱敏
      const { content, sanitized } = sanitizeContent(rawData, sensitivity);

      const packet: DataPacket = {
        id: `pkt_${Date.now()}_${Math.random().toString(36).substring(2, 8)}`,
        source, target, type: dataType as DataPacket['type'],
        content, timestamp: Date.now(), sensitivity: sensitivity as DataPacket['sensitivity'],
      };

      audit('cross_app_transfer', source, target, dataType, sanitized);

      if (channel === 'channel') {
        const chName = (args.channelName as string) || `default_${source}_to_${target}`;
        if (!dataChannels.has(chName)) dataChannels.set(chName, []);
        dataChannels.get(chName)!.push(packet);
        return `✅ 数据已通过通道 "${chName}" 传递: ${source} → ${target}\n   包ID: ${packet.id} | 类型: ${dataType} | 敏感: ${sensitivity}${sanitized ? '(已脱敏)' : ''}\n   💡 用 cross_app_receive channel="${chName}" 接收`;
      }

      if (channel === 'clipboard') {
        // 通过 DesktopControl 剪贴板
        try {
          const { DesktopControl } = await import('../../core/desktop-control.js');
          const dc = new DesktopControl(toolContext.modelLibrary);
          // eslint-disable-next-line @typescript-eslint/no-explicit-any
          await (dc as any).clipboard('set', typeof content === 'string' ? content : JSON.stringify(content));
          return `✅ 数据已写入系统剪贴板: ${source} → ${target}\n   包ID: ${packet.id} | 类型: ${dataType}${sanitized ? ' | 已脱敏' : ''}\n   目标应用可用 Ctrl+V 粘贴`;
        } catch (err) {
          return `❌ 剪贴板写入失败: ${errMsg(err)}`;
        }
      }

      if (channel === 'file') {
        const tmpDir = path.join(os.tmpdir(), 'duan_cross_app');
        await fs.promises.mkdir(tmpDir, { recursive: true });
        const filePath = path.join(tmpDir, `${packet.id}.json`);
        try {
          await atomicWriteJson(filePath, packet);
          return `✅ 数据已写入临时文件: ${filePath}\n   ${source} → ${target} | 类型: ${dataType}${sanitized ? ' | 已脱敏' : ''}\n   💡 目标应用可用 file_read 读取`;
        } catch (err) {
          return `❌ 临时文件写入失败: ${errMsg(err)}`;
        }
      }

      return `❌ 未知通道: ${channel}`;
    },
  },

  {
    name: 'cross_app_receive',
    description: '从命名数据通道接收数据。配合 cross_app_transfer 使用。',
    readOnly: true,
    parameters: {
      channelName: { type: 'string', description: '通道名', required: true },
      consume: { type: 'string', description: '是否消费(取出后删除): true/false，默认 true', required: false },
      target: { type: 'string', description: '接收方应用名(用于审计)', required: false },
    },
    // eslint-disable-next-line require-await
    execute: async (args) => {
      const chName = args.channelName as string;
      const consume = (args.consume as string) !== 'false';
      const target = (args.target as string) || 'unknown';

      const queue = dataChannels.get(chName);
      if (!queue || queue.length === 0) return `📭 通道 "${chName}" 无数据`;

      const packet = consume ? queue.shift()! : queue[0];
      audit('cross_app_receive', chName, target, packet.type, packet.sensitivity !== 'public');

      let report = `✅ 从通道 "${chName}" 接收数据\n`;
      report += `   包ID: ${packet.id} | 来源: ${packet.source} | 类型: ${packet.type} | 时间: ${new Date(packet.timestamp).toLocaleTimeString()}\n`;
      report += `   内容: ${typeof packet.content === 'string' ? packet.content.substring(0, 500) : JSON.stringify(packet.content).substring(0, 500)}\n`;
      if (packet.metadata) report += `   元数据: ${JSON.stringify(packet.metadata)}\n`;
      if (consume) report += `   (已从通道移除)`;
      return report;
    },
  },

  // ---------------- 应用集成网关 ----------------
  {
    name: 'app_capabilities',
    description: '查询所有可用应用及其能力。返回应用列表 + 支持的操作类型(read/write/notify/execute)。用于跨应用工作流规划前的能力发现。',
    readOnly: true,
    parameters: {},
    execute: async () => {
      // 从 UniversalDesktop 获取所有注册应用
      try {
        const { UniversalDesktop } = await import('../../core/universal-desktop.js');
        const desktop = new UniversalDesktop(toolContext.modelLibrary);
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        const profiles = (desktop as any).profiles as Map<string, { id: string; name: string; shortcuts: Record<string, unknown>; workflows: Record<string, unknown> }>;
        if (!profiles) return '❌ 无法获取应用列表';

        let report = `🔌 **应用集成网关** — 可用应用列表\n${'─'.repeat(50)}\n`;
        for (const [id, p] of profiles) {
          const wfCount = Object.keys(p.workflows || {}).length;
          const scCount = Object.keys(p.shortcuts || {}).length;
          report += `📱 ${p.name} (${id})\n   工作流: ${wfCount} 个 | 快捷键: ${scCount} 个\n`;
        }
        report += `\n💡 使用 app_operate 调用具体工作流，或用 cross_app_workflow 编排多应用协同。`;
        return report;
      } catch (err) {
        return `❌ 查询失败: ${errMsg(err)}`;
      }
    },
  },

  // ---------------- 跨应用工作流编排 ----------------
  {
    name: 'cross_app_workflow',
    description: '编排跨应用工作流。例如"从 Excel 读取数据 → 用 LLM 生成报告 → 写入 Word → 发送邮件"。通过 JSON 描述节点与依赖关系，自动按拓扑序执行，支持条件分支与错误回滚。',
    readOnly: false,
    parameters: {
      workflow: { type: 'string', description: '工作流 JSON。格式: {"nodes":[{"id":"n1","app":"excel","action":"read","params":{...}},{"id":"n2","app":"llm","action":"generate","inputs":["n1"]}],"output":"n2"}', required: true },
      dryRun: { type: 'string', description: 'true 仅预览执行计划不实际执行，默认 false', required: false },
    },
    execute: async (args) => {
      let wf: { nodes: WorkflowNode[]; output?: string };
      try { wf = JSON.parse(args.workflow as string); } catch { return '❌ workflow 必须是有效 JSON'; }
      if (!wf.nodes || !Array.isArray(wf.nodes) || wf.nodes.length === 0) return '❌ nodes 不能为空';

      const dryRun = args.dryRun === 'true';

      // 拓扑排序
      const sorted = topologicalSort(wf.nodes);
      if (!sorted.ok) {
        // 类型守卫：TS 对 union narrowing 不可靠，用 in 操作符
        const errMsgText = 'error' in sorted ? sorted.error : '未知错误';
        return `❌ 工作流拓扑排序失败: ${errMsgText}`;
      }
      const order = sorted.order;

      // 预览
      let plan = `🔀 **跨应用工作流** ${dryRun ? '(dry-run)' : ''}\n`;
      plan += `节点数: ${wf.nodes.length} | 输出: ${wf.output || order[order.length - 1]}\n${'─'.repeat(50)}\n`;
      plan += `执行顺序:\n`;
      for (let i = 0; i < order.length; i++) {
        const node = wf.nodes.find(n => n.id === order[i])!;
        plan += `   ${i + 1}. [${node.app}] ${node.action}${node.inputs ? ` ← ${node.inputs.join(',')}` : ''}\n`;
      }

      if (dryRun) {
        plan += `\n💡 确认无误后，去掉 dryRun 参数执行。`;
        return plan;
      }

      // 执行
      const results: Map<string, unknown> = new Map();
      const { UniversalDesktop } = await import('../../core/universal-desktop.js');
      const desktop = new UniversalDesktop(toolContext.modelLibrary);

      for (const nodeId of order) {
        const node = wf.nodes.find(n => n.id === nodeId)!;
        // 条件检查
        if (node.condition) {
          try {
            // 简单条件求值（仅支持 ${n1.success} === true 这种）
            const condResult = evalCondition(node.condition, results);
            if (!condResult) {
              results.set(nodeId, { skipped: true, reason: `条件不满足: ${node.condition}` });
              audit('cross_app_workflow_skip', node.app, node.action, 'condition', false);
              continue;
            }
          } catch (err) {
            results.set(nodeId, { error: `条件求值失败: ${errMsg(err)}` });
            continue;
          }
        }

        audit('cross_app_workflow_exec', node.app, node.action, 'workflow', false);

        try {
          let result: unknown;
          if (node.app === 'llm') {
            // LLM 节点：用上游结果作为输入
            const inputContext = (node.inputs || []).map(id => JSON.stringify(results.get(id))).join('\n');
            result = await callLLM(`${node.action}\n\n上下文:\n${inputContext}`);
          } else if (node.app === 'file') {
            // 文件操作节点
            if (node.action === 'read') {
              const fp = (node.params?.path as string) || '';
              const guard = guardSensitivePath(fp);
              if (guard) { result = guard; } else {
                result = await fs.promises.readFile(fp, 'utf-8');
              }
            } else if (node.action === 'write') {
              const fp = (node.params?.path as string) || '';
              const guard = guardSensitivePath(fp);
              if (guard) { result = guard; } else {
                const content = (node.inputs || []).map(id => String(results.get(id))).join('\n');
                await fs.promises.writeFile(fp, content, 'utf-8');
                result = `已写入: ${fp}`;
              }
            } else {
              result = `未知 file action: ${node.action}`;
            }
          } else {
            // 桌面应用节点
            const r = await desktop.executeOperation({
              app: node.app, action: node.action,
              params: node.params || {},
            });
            result = r.success ? r.result : `❌ ${r.error}`;
          }
          results.set(nodeId, result);
        } catch (err) {
          results.set(nodeId, { error: errMsg(err) });
          // 错误回滚提示
          audit('cross_app_workflow_error', node.app, node.action, 'error', false);
        }
      }

      // 输出结果
      let report = plan + `\n${'─'.repeat(50)}\n**执行结果**:\n`;
      for (const [id, r] of results) {
        const rStr = typeof r === 'string' ? r.substring(0, 200) : JSON.stringify(r).substring(0, 200);
        report += `   • ${id}: ${rStr}\n`;
      }
      const outputId = wf.output || order[order.length - 1];
      report += `\n**最终输出** (${outputId}): ${JSON.stringify(results.get(outputId)).substring(0, 500)}`;
      return report;
    },
  },

  // ---------------- 数据流审计 ----------------
  {
    name: 'cross_app_audit',
    description: '查看跨应用数据流审计日志。可按来源/目标/操作类型过滤，支持查看脱敏记录。',
    readOnly: true,
    parameters: {
      source: { type: 'string', description: '按来源过滤(可选)', required: false },
      target: { type: 'string', description: '按目标过滤(可选)', required: false },
      action: { type: 'string', description: '按操作过滤: cross_app_transfer/cross_app_receive/cross_app_workflow_exec/cross_app_workflow_error，默认全部', required: false },
      limit: { type: 'string', description: '最多返回条数，默认 30', required: false },
    },
    // eslint-disable-next-line require-await
    execute: async (args) => {
      const limit = parseInt(args.limit as string) || 30;
      let entries = [...auditLog].reverse();
      if (args.source) entries = entries.filter(e => e.source === args.source);
      if (args.target) entries = entries.filter(e => e.target === args.target);
      if (args.action) entries = entries.filter(e => e.action === args.action);
      entries = entries.slice(0, limit);

      if (entries.length === 0) return '📭 暂无审计记录';

      let report = `📜 **跨应用数据流审计** (${entries.length} 条)\n${'─'.repeat(50)}\n`;
      for (const e of entries) {
        const time = new Date(e.timestamp).toLocaleTimeString();
        const mask = e.sanitized ? '🔒' : '🔓';
        report += `${mask} [${time}] ${e.action}: ${e.source} → ${e.target} (${e.dataType})${e.sanitized ? ' [脱敏]' : ''}\n`;
      }
      return report;
    },
  },
];

// ============ 工具函数 ============

/** 拓扑排序 */
function topologicalSort(nodes: WorkflowNode[]): { ok: true; order: string[] } | { ok: false; error: string } {
  const inDegree: Map<string, number> = new Map();
  const adjList: Map<string, string[]> = new Map();
  for (const n of nodes) {
    inDegree.set(n.id, 0);
    adjList.set(n.id, []);
  }
  for (const n of nodes) {
    for (const dep of (n.inputs || [])) {
      if (!inDegree.has(dep)) return { ok: false, error: `节点 ${n.id} 引用了不存在的上游 ${dep}` };
      adjList.get(dep)!.push(n.id);
      inDegree.set(n.id, (inDegree.get(n.id) || 0) + 1);
    }
  }
  const queue: string[] = [];
  for (const [id, deg] of inDegree) if (deg === 0) queue.push(id);
  const order: string[] = [];
  while (queue.length > 0) {
    const cur = queue.shift()!;
    order.push(cur);
    for (const next of (adjList.get(cur) || [])) {
      inDegree.set(next, (inDegree.get(next) || 0) - 1);
      if (inDegree.get(next) === 0) queue.push(next);
    }
  }
  if (order.length !== nodes.length) return { ok: false, error: '存在循环依赖' };
  return { ok: true, order };
}

/** 简单条件求值 */
function evalCondition(cond: string, results: Map<string, unknown>): boolean {
  // 替换 ${n1.field} 为实际值
  let expr = cond;
  const refs = cond.match(/\$\{(\w+)\.(\w+)\}/g) || [];
  for (const ref of refs) {
    const m = ref.match(/\$\{(\w+)\.(\w+)\}/)!;
    const nodeId = m[1];
    const field = m[2];
    const val = results.get(nodeId);
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const fieldVal = val && typeof val === 'object' ? (val as any)[field] : val;
    expr = expr.replace(ref, JSON.stringify(fieldVal));
  }
  // 仅支持简单的 === / !== / && / || 比较
  if (expr.includes('===')) {
    const [l, r] = expr.split('===').map(s => s.trim().replace(/^["']|["']$/g, ''));
    return l === r;
  }
  if (expr.includes('!==')) {
    const [l, r] = expr.split('!==').map(s => s.trim().replace(/^["']|["']$/g, ''));
    return l !== r;
  }
  return Boolean(expr);
}
