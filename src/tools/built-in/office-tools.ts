/**
 * 办公场景工具集 — OfficeTools
 *
 * 覆盖日常办公高频场景：
 * 1. 邮件处理（撰写专业邮件 / 模板管理 / 批量草稿）
 * 2. Excel 数据处理（数据分析 / 公式生成 / 数据清洗建议）
 * 3. 会议纪要（从文本/转录生成纪要 / 待办提取 / 决议归纳）
 * 4. 文件格式转换（PDF 合并/拆分 / 文本转 PDF / 图片转 PDF）
 * 5. OCR 文字识别（通过视觉模型识别图片/截图中的文字）
 * 6. 任务待办管理（创建 / 优先级排序 / 进度跟踪）
 * 7. 日程规划（LLM 生成日程安排 / 时间块建议）
 *
 * 设计原则：
 * - 内容生成通过 toolContext.modelLibrary 调用 LLM
 * - 文件操作走 fs.promises 异步
 * - 桌面操作委托 UniversalDesktop 的 app profile
 * - OCR 利用已修复的 vision 模型能力
 */

import * as fs from 'fs';
import * as path from 'path';
import { errMsg, type UnifiedToolDef } from '../../core/unified-tool-def.js';
import { matchSensitivePath } from '../../core/security-config.js';
import { toolContext } from './tool-context.js';
import { atomicWriteJson } from '../../core/atomic-write.js';

// ============ 辅助函数 ============

async function pathExists(p: string): Promise<boolean> {
  try { await fs.promises.access(p); return true; } catch { return false; }
}

function guardSensitivePath(p: string): string | null {
  if (matchSensitivePath(p)) return `❌ 拒绝访问敏感路径: ${p}`;
  return null;
}

/** 调用 LLM 生成内容 */
async function callLLM(prompt: string, systemPrompt?: string): Promise<string> {
  const ml = toolContext.modelLibrary;
  if (!ml || typeof ml.call !== 'function') {
    throw new Error('ModelLibrary 未初始化');
  }
  const messages: Array<{ role: 'system' | 'user'; content: string }> = [];
  if (systemPrompt) messages.push({ role: 'system', content: systemPrompt });
  messages.push({ role: 'user', content: prompt });
  const resp = await ml.call(messages);
  return resp.content || '';
}

/** 调用视觉模型识别图片文字 */
async function callVisionLLM(prompt: string, imageBase64: string, mediaType: string): Promise<string> {
  const ml = toolContext.modelLibrary;
  if (!ml || typeof ml.call !== 'function') {
    throw new Error('ModelLibrary 未初始化');
  }
  const messages: Array<{
    role: 'system' | 'user';
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    content: any;
  }> = [
    {
      role: 'user',
      content: [
        { type: 'text', text: prompt },
        { type: 'image_url', image_url: { url: `data:${mediaType};base64,${imageBase64}` } },
      ],
    },
  ];
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const resp = await (ml as any).call(messages, { modelId: 'auto-vision' });
  return resp.content || '';
}

/** 优先级 → 图标映射 */
function priorityIcon(priority: string): string {
  const iconMap: Record<string, string> = { high: '🔴', medium: '🟡', low: '🔵' };
  return iconMap[priority] || '🟡';
}

// ============ 工具定义 ============

export const officeTools: UnifiedToolDef[] = [
  // ============ 邮件处理 ============
  {
    name: 'email_compose',
    description: '智能撰写专业邮件。根据主题、收件人、要点自动生成邮件正文(含称呼/正文/署名)。支持正式/轻松/紧急三种语气。',
    readOnly: true,
    parameters: {
      subject: { type: 'string', description: '邮件主题', required: true },
      recipient: { type: 'string', description: '收件人(姓名或称呼，如"张总"/"技术团队")', required: true },
      keyPoints: { type: 'string', description: '邮件要点(JSON数组，如["汇报Q3业绩","请求追加预算"])', required: true },
      tone: { type: 'string', description: '语气: formal(正式)/casual(轻松)/urgent(紧急)，默认 formal', required: false },
      sender: { type: 'string', description: '发件人署名(可选)', required: false },
    },
    execute: async (args) => {
      const subject = args.subject as string;
      const recipient = args.recipient as string;
      const tone = (args.tone as string) || 'formal';
      const sender = (args.sender as string) || '';

      let keyPoints: string[];
      try { keyPoints = JSON.parse(args.keyPoints as string); } catch { return '❌ keyPoints 必须是 JSON 数组'; }

      const toneMap: Record<string, string> = {
        formal: '正式商务：措辞严谨、礼貌周到、逻辑清晰',
        casual: '轻松友好：语气亲切、简洁直接、可适当口语化',
        urgent: '紧急重要：突出紧迫性、重点加粗、行动明确',
      };

      const prompt = `撰写一封${toneMap[tone] || toneMap.formal}的邮件。

主题: ${subject}
收件人: ${recipient}
核心要点:
${keyPoints.map((p, i) => `${i + 1}. ${p}`).join('\n')}

要求：
1. 包含称呼、正文、结束语、署名
2. 正文按要点分段，逻辑清晰
3. 控制在 300-500 字
4. ${sender ? `署名: ${sender}` : '署名用 [你的名字] 占位'}`;

      try {
        const email = await callLLM(prompt, '你是专业的商务沟通顾问，擅长撰写得体的邮件。');
        return `📧 **邮件草稿**\n主题: ${subject} | 收件人: ${recipient} | 语气: ${tone}\n${'─'.repeat(50)}\n\n${email}\n\n${'─'.repeat(50)}\n💡 提示: 可用 cross_app_transfer channel=clipboard 将内容复制到剪贴板，再粘贴到 Outlook 邮件中。`;
      } catch (err) {
        return `❌ 邮件生成失败: ${errMsg(err)}`;
      }
    },
  },

  {
    name: 'email_template',
    description: '邮件模板管理。支持: save(保存模板)/list(列出模板)/apply(应用模板生成邮件)。模板存储在 ~/.duan/email-templates/ 目录。',
    readOnly: false,
    parameters: {
      action: { type: 'string', description: 'save/list/apply', required: true },
      templateName: { type: 'string', description: '模板名(如 "周报"/"请假申请")', required: false },
      content: { type: 'string', description: 'save 模式: 模板内容(含 {{占位符}}); apply 模式: 填充数据 JSON', required: false },
    },
    execute: async (args) => {
      const action = args.action as string;
      const os = await import('os');
      const tplDir = path.join(os.homedir(), '.duan', 'email-templates');
      await fs.promises.mkdir(tplDir, { recursive: true });

      if (action === 'save') {
        const name = (args.templateName as string) || 'unnamed';
        const content = (args.content as string) || '';
        const tplPath = path.join(tplDir, `${name}.txt`);
        try {
          await fs.promises.writeFile(tplPath, content, 'utf-8');
          return `✅ 模板已保存: ${name}\n路径: ${tplPath}\n💡 模板中可用 {{key}} 占位符，apply 时自动替换。`;
        } catch (err) { return `❌ 保存失败: ${errMsg(err)}`; }
      }

      if (action === 'list') {
        try {
          const files = await fs.promises.readdir(tplDir);
          const txtFiles = files.filter(f => f.endsWith('.txt'));
          if (txtFiles.length === 0) return '📭 暂无邮件模板';
          let report = `📋 **邮件模板列表** (${txtFiles.length} 个)\n${'─'.repeat(40)}\n`;
          for (const f of txtFiles) {
            const name = f.replace(/\.txt$/, '');
            const content = await fs.promises.readFile(path.join(tplDir, f), 'utf-8');
            const placeholders = content.match(/\{\{(\w+)\}\}/g) || [];
            const preview = content.substring(0, 60).replace(/\n/g, ' ');
            report += `📝 ${name}\n   占位符: ${placeholders.length > 0 ? [...new Set(placeholders.map(p => p.replace(/[{}]/g, '')))].join(', ') : '无'}\n   预览: ${preview}...\n`;
          }
          return report;
        } catch (err) { return `❌ 列表失败: ${errMsg(err)}`; }
      }

      if (action === 'apply') {
        const name = (args.templateName as string) || '';
        if (!name) return '❌ apply 需要 templateName';
        const tplPath = path.join(tplDir, `${name}.txt`);
        if (!(await pathExists(tplPath))) return `❌ 模板不存在: ${name}`;

        let tplContent: string;
        try { tplContent = await fs.promises.readFile(tplPath, 'utf-8'); } catch (err) { return `❌ 读取失败: ${errMsg(err)}`; }

        let data: Record<string, unknown> = {};
        if (args.content) {
          try { data = JSON.parse(args.content as string); } catch { return '❌ content 必须是有效 JSON'; }
        }

        let filled = tplContent;
        const placeholders = tplContent.match(/\{\{(\w+)\}\}/g) || [];
        const keys = [...new Set(placeholders.map(p => p.replace(/[{}]/g, '')))];
        const missing: string[] = [];
        for (const k of keys) {
          if (data[k] !== undefined) {
            filled = filled.split(`{{${k}}}`).join(String(data[k]));
          } else {
            missing.push(k);
            filled = filled.split(`{{${k}}}`).join(`[未提供:${k}]`);
          }
        }
        return `📧 **邮件已生成** (模板: ${name})\n${'─'.repeat(50)}\n\n${filled}\n\n${missing.length > 0 ? `⚠️ 缺失字段: ${missing.join(', ')}` : '✅ 所有字段已填充'}`;
      }

      return '❌ action 必须是 save/list/apply';
    },
  },

  // ============ Excel 数据处理 ============
  {
    name: 'excel_analyze',
    description: '分析 CSV/JSON 数据，生成统计摘要、趋势洞察、可视化建议。支持描述性统计(均值/极值/分布)与 LLM 洞察分析。',
    readOnly: true,
    parameters: {
      filePath: { type: 'string', description: '数据文件路径(CSV 或 JSON)', required: true },
      focus: { type: 'string', description: '分析重点(如"销售趋势/异常值/对比")', required: false },
    },
    execute: async (args) => {
      const filePath = args.filePath as string;
      const guard = guardSensitivePath(filePath);
      if (guard) return guard;
      if (!(await pathExists(filePath))) return `❌ 文件不存在: ${filePath}`;

      const ext = path.extname(filePath).toLowerCase();
      let rawData: unknown;

      try {
        const text = await fs.promises.readFile(filePath, 'utf-8');
        if (ext === '.json') {
          rawData = JSON.parse(text);
        } else if (ext === '.csv') {
          // 简单 CSV 解析
          const lines = text.trim().split('\n');
          if (lines.length < 2) return '❌ CSV 至少需要标题行+1行数据';
          const headers = lines[0].split(',').map(h => h.trim().replace(/^["']|["']$/g, ''));
          rawData = lines.slice(1).map(line => {
            const values = line.split(',').map(v => v.trim().replace(/^["']|["']$/g, ''));
            const obj: Record<string, unknown> = {};
            headers.forEach((h, i) => { obj[h] = values[i]; });
            return obj;
          });
        } else {
          return `❌ 仅支持 CSV/JSON，不支持 ${ext}`;
        }
      } catch (err) { return `❌ 解析失败: ${errMsg(err)}`; }

      // 统计摘要
      const dataStr = JSON.stringify(rawData).substring(0, 6000);
      const focus = (args.focus as string) || '';

      const prompt = `分析以下数据，生成洞察报告。

数据(JSON):
${dataStr}

${focus ? `分析重点: ${focus}\n` : ''}要求：
1. 数据概览(记录数/字段/数据类型)
2. 描述性统计(数值字段的均值/极值/分布)
3. 关键发现(趋势/异常/关联)
4. 可视化建议(适合的图表类型)
5. 行动建议

用 Markdown 输出，不超过 800 字。`;

      try {
        const analysis = await callLLM(prompt, '你是专业的数据分析师，擅长从结构化数据中发现洞察。');
        return `📊 **数据分析报告** | 文件: ${path.basename(filePath)}\n${'─'.repeat(50)}\n\n${analysis}`;
      } catch (err) {
        return `❌ 分析失败: ${errMsg(err)}`;
      }
    },
  },

  {
    name: 'excel_formula',
    description: '根据自然语言需求生成 Excel 公式。如"计算B列到D列的平均值"→ =AVERAGE(B:D)。返回公式 + 用法说明。',
    readOnly: true,
    parameters: {
      requirement: { type: 'string', description: '公式需求描述(如"统计A列中大于100的个数")', required: true },
      context: { type: 'string', description: '数据上下文(可选，如"A列是销售额，B列是日期")', required: false },
    },
    execute: async (args) => {
      const requirement = args.requirement as string;
      const context = (args.context as string) || '';

      const prompt = `根据需求生成 Excel 公式。

需求: ${requirement}
${context ? `数据上下文: ${context}\n` : ''}要求：
1. 给出 Excel 公式(以 = 开头)
2. 说明公式用法和参数
3. 给出适用场景的示例
4. 如有多种方案，列出对比

用 Markdown 输出。`;

      try {
        const result = await callLLM(prompt, '你是 Excel 公式专家，精通各类函数与数组公式。');
        return `🔧 **Excel 公式建议**\n需求: ${requirement}\n${'─'.repeat(50)}\n\n${result}`;
      } catch (err) {
        return `❌ 生成失败: ${errMsg(err)}`;
      }
    },
  },

  // ============ 会议纪要 ============
  {
    name: 'meeting_minutes',
    description: '从会议记录/转录文本生成结构化会议纪要。自动提取: 议题/讨论要点/决议/待办事项(含负责人/截止日)。支持从文件或直接文本输入。',
    readOnly: true,
    parameters: {
      source: { type: 'string', description: '输入模式: text(直接文本) 或 file(文件路径)', required: true },
      content: { type: 'string', description: 'text 模式: 会议文本内容; file 模式: 文件路径', required: true },
      meetingTitle: { type: 'string', description: '会议标题(可选)', required: false },
      outputPath: { type: 'string', description: '纪要输出文件路径(可选，默认仅返回)', required: false },
    },
    execute: async (args) => {
      const source = args.source as string;
      let meetingText = '';

      if (source === 'text') {
        meetingText = (args.content as string) || '';
      } else if (source === 'file') {
        const fp = args.content as string;
        const guard = guardSensitivePath(fp);
        if (guard) return guard;
        if (!(await pathExists(fp))) return `❌ 文件不存在: ${fp}`;
        try {
          meetingText = await fs.promises.readFile(fp, 'utf-8');
          if (meetingText.length > 10000) meetingText = meetingText.substring(0, 10000) + '\n...(截断)';
        } catch (err) { return `❌ 读取失败: ${errMsg(err)}`; }
      } else {
        return '❌ source 必须是 text 或 file';
      }

      if (!meetingText.trim()) return '❌ 会议内容为空';
      const title = (args.meetingTitle as string) || '会议纪要';

      const prompt = `从以下会议记录生成结构化会议纪要。

会议标题: ${title}
会议记录:
${meetingText}

输出 JSON 格式（不要代码块包裹）:
{
  "summary": "会议概述(100字内)",
  "topics": ["讨论议题1", "议题2"],
  "discussions": [{"topic": "议题", "points": ["讨论要点1", "要点2"]}],
  "decisions": ["决议1", "决议2"],
  "actionItems": [{"task": "待办任务", "owner": "负责人", "deadline": "截止日期", "priority": "high/medium/low"}],
  "nextMeeting": "下次会议建议(可选)"
}`;

      let minutes: { summary?: string; topics?: string[]; discussions?: Array<{ topic: string; points: string[] }>; decisions?: string[]; actionItems?: Array<{ task: string; owner: string; deadline: string; priority: string }>; nextMeeting?: string };
      try {
        const str = await callLLM(prompt, '你是专业的会议纪要撰写人，擅长结构化提炼关键信息。');
        const jsonMatch = str.match(/\{[\s\S]*\}/);
        minutes = jsonMatch ? JSON.parse(jsonMatch[0]) : { summary: str };
      } catch (err) {
        return `❌ 纪要生成失败: ${errMsg(err)}`;
      }

      let report = `📝 **${title}**\n${'─'.repeat(50)}\n\n`;
      report += `**概述**: ${minutes.summary || ''}\n\n`;
      if (minutes.topics && minutes.topics.length > 0) {
        report += `**讨论议题**:\n`;
        minutes.topics.forEach((t, i) => { report += `   ${i + 1}. ${t}\n`; });
        report += '\n';
      }
      if (minutes.discussions && minutes.discussions.length > 0) {
        report += `**讨论详情**:\n`;
        for (const d of minutes.discussions) {
          report += `   📌 ${d.topic}\n`;
          d.points.forEach(p => { report += `      • ${p}\n`; });
        }
        report += '\n';
      }
      if (minutes.decisions && minutes.decisions.length > 0) {
        report += `**决议**:\n`;
        minutes.decisions.forEach(d => { report += `   ✅ ${d}\n`; });
        report += '\n';
      }
      if (minutes.actionItems && minutes.actionItems.length > 0) {
        report += `**待办事项**:\n`;
        report += `   | 任务 | 负责人 | 截止日 | 优先级 |\n`;
        report += `   |------|--------|--------|--------|\n`;
        for (const a of minutes.actionItems) {
          report += `   | ${a.task} | ${a.owner} | ${a.deadline} | ${a.priority} |\n`;
        }
        report += '\n';
      }
      if (minutes.nextMeeting) report += `**下次会议**: ${minutes.nextMeeting}\n`;

      const outputPath = args.outputPath as string;
      if (outputPath) {
        try {
          await fs.promises.writeFile(outputPath, report, 'utf-8');
          report += `\n✅ 纪要已保存: ${outputPath}`;
        } catch (err) {
          report += `\n⚠️ 保存失败: ${errMsg(err)}`;
        }
      }
      return report;
    },
  },

  // ============ 文件格式转换 ============
  {
    name: 'file_convert',
    description: '文件格式转换。支持: pdf_merge(合并多个PDF)/txt_to_pdf(文本转PDF)/images_to_pdf(多图转PDF)/csv_to_json(CSV转JSON)/json_to_csv(JSON转CSV)。注意: PDF操作需 pdf-lib 或类似库。',
    readOnly: false,
    parameters: {
      operation: { type: 'string', description: 'pdf_merge/txt_to_pdf/images_to_pdf/csv_to_json/json_to_csv', required: true },
      input: { type: 'string', description: '输入: pdf_merge/images_to_pdf 为JSON数组路径; 其他为单文件路径', required: true },
      output: { type: 'string', description: '输出文件路径', required: true },
    },
    execute: async (args) => {
      const operation = args.operation as string;
      const output = args.output as string;
      const outGuard = guardSensitivePath(output);
      if (outGuard) return outGuard;

      // CSV ↔ JSON 转换（纯文本，无需外部库）
      if (operation === 'csv_to_json') {
        const input = args.input as string;
        const guard = guardSensitivePath(input);
        if (guard) return guard;
        if (!(await pathExists(input))) return `❌ 文件不存在: ${input}`;
        try {
          const text = await fs.promises.readFile(input, 'utf-8');
          const lines = text.trim().split('\n');
          if (lines.length < 1) return '❌ CSV 为空';
          const headers = lines[0].split(',').map(h => h.trim().replace(/^["']|["']$/g, ''));
          const records = lines.slice(1).map(line => {
            const values = line.split(',').map(v => v.trim().replace(/^["']|["']$/g, ''));
            const obj: Record<string, unknown> = {};
            headers.forEach((h, i) => { obj[h] = values[i]; });
            return obj;
          });
          await atomicWriteJson(output, records);
          return `✅ CSV→JSON 转换完成: ${output} (${records.length} 条记录)`;
        } catch (err) { return `❌ 转换失败: ${errMsg(err)}`; }
      }

      if (operation === 'json_to_csv') {
        const input = args.input as string;
        const guard = guardSensitivePath(input);
        if (guard) return guard;
        if (!(await pathExists(input))) return `❌ 文件不存在: ${input}`;
        try {
          const data = JSON.parse(await fs.promises.readFile(input, 'utf-8'));
          if (!Array.isArray(data) || data.length === 0) return '❌ JSON 必须是非空数组';
          const headers = Object.keys(data[0]);
          const csvLines = [headers.join(',')];
          for (const row of data) {
            csvLines.push(headers.map(h => `"${String(row[h] ?? '').replace(/"/g, '""')}"`).join(','));
          }
          await fs.promises.writeFile(output, csvLines.join('\n'), 'utf-8');
          return `✅ JSON→CSV 转换完成: ${output} (${data.length} 条记录)`;
        } catch (err) { return `❌ 转换失败: ${errMsg(err)}`; }
      }

      if (operation === 'txt_to_pdf') {
        const input = args.input as string;
        const guard = guardSensitivePath(input);
        if (guard) return guard;
        if (!(await pathExists(input))) return `❌ 文件不存在: ${input}`;
        try {
          // 尝试加载 pdfkit
          // @ts-expect-error - pdfkit 可能未安装
          const PDFDocument = (await import('pdfkit')).default;
          const text = await fs.promises.readFile(input, 'utf-8');
          await new Promise<void>((resolve, reject) => {
            const doc = new PDFDocument();
            const stream = fs.createWriteStream(output);
            doc.pipe(stream);
            doc.fontSize(12).font('Helvetica').text(text, { lineGap: 4 });
            doc.end();
            stream.on('finish', resolve);
            stream.on('error', reject);
          });
          return `✅ 文本→PDF 转换完成: ${output}`;
        } catch (err) {
          // pdfkit 未安装时的降级方案
          if (String(err).includes('Cannot find module') || String(err).includes('pdfkit')) {
            return `⚠️ 需要安装 pdfkit: npm install pdfkit\n转换失败: ${errMsg(err)}\n💡 或通过 app_operate word workflow="导出PDF" 用 Word 转 PDF。`;
          }
          return `❌ 转换失败: ${errMsg(err)}`;
        }
      }

      if (operation === 'pdf_merge' || operation === 'images_to_pdf') {
        let inputPaths: string[];
        try { inputPaths = JSON.parse(args.input as string); } catch { return '❌ input 必须是 JSON 数组路径'; }
        if (!Array.isArray(inputPaths) || inputPaths.length === 0) return '❌ input 不能为空';

        for (const p of inputPaths) {
          const guard = guardSensitivePath(p);
          if (guard) return guard;
        }

        if (operation === 'images_to_pdf') {
          try {
            // @ts-expect-error - pdfkit 可能未安装
            const PDFDocument = (await import('pdfkit')).default;
            await new Promise<void>((resolve, reject) => {
              const doc = new PDFDocument();
              const stream = fs.createWriteStream(output);
              doc.pipe(stream);
              for (let i = 0; i < inputPaths.length; i++) {
                if (i > 0) doc.addPage();
                doc.image(inputPaths[i], { fit: [500, 700], align: 'center', valign: 'center' });
              }
              doc.end();
              stream.on('finish', resolve);
              stream.on('error', reject);
            });
            return `✅ ${inputPaths.length} 张图片→PDF 完成: ${output}`;
          } catch (err) {
            return `⚠️ 需要安装 pdfkit: npm install pdfkit\n失败: ${errMsg(err)}`;
          }
        }

        return `⚠️ PDF 合并需要 pdf-lib 库: npm install pdf-lib\n💡 或通过 app_operate 用 Adobe Acrobat 合并。`;
      }

      return `❌ 未知操作: ${operation}`;
    },
  },

  // ============ OCR 文字识别 ============
  {
    name: 'ocr_recognize',
    description: 'OCR 文字识别。通过视觉模型识别图片/截图中的文字内容。支持中文/英文/表格/手写体。返回识别的文本 + 结构化分析。',
    readOnly: true,
    parameters: {
      imagePath: { type: 'string', description: '图片路径(支持 jpg/png/gif/bmp/webp)', required: true },
      mode: { type: 'string', description: '识别模式: text(纯文本)/table(表格结构)/handwriting(手写)/document(文档结构)，默认 text', required: false },
    },
    execute: async (args) => {
      const imagePath = args.imagePath as string;
      const guard = guardSensitivePath(imagePath);
      if (guard) return guard;
      if (!(await pathExists(imagePath))) return `❌ 图片不存在: ${imagePath}`;

      const ext = path.extname(imagePath).toLowerCase();
      const mediaTypeMap: Record<string, string> = {
        '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg',
        '.png': 'image/png', '.gif': 'image/gif',
        '.bmp': 'image/bmp', '.webp': 'image/webp',
      };
      const mediaType = mediaTypeMap[ext];
      if (!mediaType) return `❌ 不支持的图片格式: ${ext}`;

      const mode = (args.mode as string) || 'text';
      const modePrompts: Record<string, string> = {
        text: '请识别并提取图片中的所有文字内容，保持原文格式输出。',
        table: '请识别图片中的表格内容，用 Markdown 表格格式输出，保留行列结构。',
        handwriting: '请识别图片中的手写文字，尽量准确还原内容。',
        document: '请识别图片中的文档内容，用 Markdown 结构化输出(标题/段落/列表/表格)。',
      };

      let imageBase64: string;
      try {
        const buf = await fs.promises.readFile(imagePath);
        imageBase64 = buf.toString('base64');
      } catch (err) { return `❌ 读取图片失败: ${errMsg(err)}`; }

      try {
        const result = await callVisionLLM(modePrompts[mode] || modePrompts.text, imageBase64, mediaType);
        return `🔍 **OCR 识别结果** | 图片: ${path.basename(imagePath)} | 模式: ${mode}\n${'─'.repeat(50)}\n\n${result}`;
      } catch (err) {
        return `❌ OCR 识别失败: ${errMsg(err)}\n💡 提示: 确认视觉模型已配置(vision capability)，或检查 API Key。`;
      }
    },
  },

  // ============ 任务待办管理 ============
  {
    name: 'task_manage',
    description: '任务待办管理。支持: add(添加任务)/list(列出任务)/complete(标记完成)/prioritize(智能优先级排序)。任务存储在 ~/.duan/tasks.json。',
    readOnly: false,
    parameters: {
      action: { type: 'string', description: 'add/list/complete/prioritize', required: true },
      task: { type: 'string', description: 'add 模式: 任务描述; complete 模式: 任务ID', required: false },
      priority: { type: 'string', description: 'add 模式: high/medium/low，默认 medium', required: false },
      deadline: { type: 'string', description: 'add 模式: 截止日期(如 2026-07-15)', required: false },
    },
    execute: async (args) => {
      const os = await import('os');
      const tasksFile = path.join(os.homedir(), '.duan', 'tasks.json');
      await fs.promises.mkdir(path.dirname(tasksFile), { recursive: true });

      let tasks: Array<{ id: string; task: string; priority: string; deadline?: string; status: string; createdAt: number }>;
      try {
        if (await pathExists(tasksFile)) {
          tasks = JSON.parse(await fs.promises.readFile(tasksFile, 'utf-8'));
        } else { tasks = []; }
      } catch { tasks = []; }

      const action = args.action as string;

      if (action === 'add') {
        const task = (args.task as string) || '';
        if (!task) return '❌ add 需要 task 描述';
        const priority = (args.priority as string) || 'medium';
        const deadline = (args.deadline as string) || '';
        const newTask = {
          id: `task_${Date.now()}_${Math.random().toString(36).substring(2, 6)}`,
          task, priority, deadline, status: 'pending', createdAt: Date.now(),
        };
        tasks.push(newTask);
        await atomicWriteJson(tasksFile, tasks);
        return `✅ 任务已添加: ${newTask.id}\n   📋 ${task}\n   优先级: ${priority}${deadline ? ` | 截止: ${deadline}` : ''}`;
      }

      if (action === 'list') {
        const pending = tasks.filter(t => t.status === 'pending');
        const completed = tasks.filter(t => t.status === 'completed');
        if (pending.length === 0 && completed.length === 0) return '📭 暂无任务';
        let report = `📋 **任务列表** (待办 ${pending.length} / 已完成 ${completed.length})\n${'─'.repeat(50)}\n`;
        const pOrder = { high: 0, medium: 1, low: 2 };
        const sorted = [...pending].sort((a, b) => (pOrder[a.priority as keyof typeof pOrder] ?? 1) - (pOrder[b.priority as keyof typeof pOrder] ?? 1));
        for (const t of sorted) {
          const icon = priorityIcon(t.priority);
          report += `${icon} [${t.id.substring(5, 13)}] ${t.task}${t.deadline ? ` (截止: ${t.deadline})` : ''}\n`;
        }
        if (completed.length > 0) {
          report += `\n✅ 已完成:\n`;
          completed.slice(-5).forEach(t => { report += `   ✓ [${t.id.substring(5, 13)}] ${t.task}\n`; });
        }
        return report;
      }

      if (action === 'complete') {
        const taskId = (args.task as string) || '';
        const task = tasks.find(t => t.id.includes(taskId) || t.id === taskId);
        if (!task) return `❌ 未找到任务: ${taskId}`;
        task.status = 'completed';
        await atomicWriteJson(tasksFile, tasks);
        return `✅ 任务已完成: ${task.task}`;
      }

      if (action === 'prioritize') {
        const pending = tasks.filter(t => t.status === 'pending');
        if (pending.length === 0) return '📭 暂无待排序任务';
        const taskList = pending.map(t => `${t.id}|${t.task}|${t.deadline || '无截止日'}`).join('\n');
        const prompt = `对以下任务进行智能优先级排序。

任务列表(id|描述|截止日):
${taskList}

要求：
1. 考虑紧急程度(截止日)、重要性、依赖关系
2. 用 JSON 数组输出排序结果: [{"id":"task_xxx","priority":"high/medium/low","reason":"排序理由"}]
3. 按推荐执行顺序排列`;

        try {
          const str = await callLLM(prompt, '你是时间管理专家，擅长任务优先级排序。');
          const jsonMatch = str.match(/\[[\s\S]*\]/);
          const suggestions: Array<{ id: string; priority: string; reason: string }> = jsonMatch ? JSON.parse(jsonMatch[0]) : [];
          // 应用建议
          for (const s of suggestions) {
            const t = tasks.find(t => t.id === s.id);
            if (t) t.priority = s.priority;
          }
          await atomicWriteJson(tasksFile, tasks);
          let report = `🎯 **智能优先级排序** (${suggestions.length} 个任务)\n${'─'.repeat(50)}\n`;
          for (const s of suggestions) {
            const icon = priorityIcon(s.priority);
            report += `${icon} ${s.id}: ${s.reason}\n`;
          }
          return report;
        } catch (err) {
          return `❌ 排序失败: ${errMsg(err)}`;
        }
      }

      return '❌ action 必须是 add/list/complete/prioritize';
    },
  },

  // ============ 日程规划 ============
  {
    name: 'schedule_plan',
    description: '智能日程规划。根据待办任务、时间约束、个人偏好生成一日/一周日程安排。支持时间块(Time Blocking)方法论。',
    readOnly: true,
    parameters: {
      mode: { type: 'string', description: 'day(一日规划)/week(一周规划)', required: true },
      tasks: { type: 'string', description: '任务列表 JSON: [{"task":"写报告","duration":2,"deadline":"2026-07-03"}]', required: true },
      workHours: { type: 'string', description: '工作时间(默认 09:00-18:00)', required: false },
      preferences: { type: 'string', description: '偏好(可选，如"上午专注深度工作/下午开会/午休1小时")', required: false },
    },
    execute: async (args) => {
      const mode = args.mode as string;
      let tasks: Array<{ task: string; duration?: number; deadline?: string; priority?: string }>;
      try { tasks = JSON.parse(args.tasks as string); } catch { return '❌ tasks 必须是 JSON 数组'; }
      if (!Array.isArray(tasks) || tasks.length === 0) return '❌ tasks 不能为空';

      const workHours = (args.workHours as string) || '09:00-18:00';
      const preferences = (args.preferences as string) || '';

      const prompt = `制定${mode === 'day' ? '一日' : '一周'}日程安排。

任务列表:
${JSON.stringify(tasks, null, 2)}

工作时间: ${workHours}
${preferences ? `偏好: ${preferences}\n` : ''}要求：
1. 使用时间块(Time Blocking)方法论
2. 考虑任务优先级、截止日、预估时长
3. 安排休息时间和缓冲时间
4. 深度工作放在精力最佳时段
${mode === 'week' ? '5. 按周一到周五排列，周末休息\n' : ''}5. 用 Markdown 表格输出: | 时间 | 任务 | 类型 | 说明 |

输出 JSON 格式（不要代码块包裹）:
{
  "schedule": [{"time":"09:00-10:30","task":"任务名","type":"deep/meeting/break/admin","note":"说明"}],
  "tips": ["时间管理建议1", "建议2"],
  "conflicts": ["潜在冲突1"]
}`;

      let plan: { schedule?: Array<{ time: string; task: string; type: string; note: string }>; tips?: string[]; conflicts?: string[] };
      try {
        const str = await callLLM(prompt, '你是时间管理专家，精通番茄工作法和时间块方法论。');
        const jsonMatch = str.match(/\{[\s\S]*\}/);
        plan = jsonMatch ? JSON.parse(jsonMatch[0]) : { schedule: [], tips: [str] };
      } catch (err) {
        return `❌ 规划失败: ${errMsg(err)}`;
      }

      let report = `📅 **${mode === 'day' ? '一日' : '一周'}日程规划**\n工作时间: ${workHours}\n${'─'.repeat(50)}\n\n`;
      if (plan.schedule && plan.schedule.length > 0) {
        report += `| 时间 | 任务 | 类型 | 说明 |\n`;
        report += `|------|------|------|------|\n`;
        for (const s of plan.schedule) {
          report += `| ${s.time} | ${s.task} | ${s.type} | ${s.note} |\n`;
        }
        report += '\n';
      }
      if (plan.tips && plan.tips.length > 0) {
        report += `**💡 时间管理建议**:\n`;
        plan.tips.forEach(t => { report += `   • ${t}\n`; });
        report += '\n';
      }
      if (plan.conflicts && plan.conflicts.length > 0) {
        report += `**⚠️ 潜在冲突**:\n`;
        plan.conflicts.forEach(c => { report += `   • ${c}\n`; });
      }
      return report;
    },
  },

  // ============ 快速笔记 ============
  {
    name: 'quick_note',
    description: '快速笔记工具。支持: add(添加笔记)/list(列出)/search(搜索)/tag(按标签筛选)。笔记存储在 ~/.duan/notes/ 目录，每条笔记一个 Markdown 文件。',
    readOnly: false,
    parameters: {
      action: { type: 'string', description: 'add/list/search/tag', required: true },
      content: { type: 'string', description: 'add: 笔记内容; search: 搜索关键词; tag: 标签名', required: false },
      tags: { type: 'string', description: 'add 模式: 标签(JSON数组，如 ["想法","项目A"])', required: false },
      title: { type: 'string', description: 'add 模式: 笔记标题', required: false },
    },
    execute: async (args) => {
      const os = await import('os');
      const notesDir = path.join(os.homedir(), '.duan', 'notes');
      await fs.promises.mkdir(notesDir, { recursive: true });
      const action = args.action as string;

      if (action === 'add') {
        const content = (args.content as string) || '';
        if (!content) return '❌ add 需要 content';
        const title = (args.title as string) || `笔记_${new Date().toISOString().slice(0, 10)}`;
        let tags: string[] = [];
        if (args.tags) { try { tags = JSON.parse(args.tags as string); } catch { /* ignore */ } }
        const timestamp = new Date().toISOString();
        const fileName = `${Date.now()}_${title.replace(/[\\/:*?"<>|]/g, '_')}.md`;
        const notePath = path.join(notesDir, fileName);
        const md = `# ${title}\n\n> 创建时间: ${timestamp}\n> 标签: ${tags.join(', ')}\n\n${content}\n`;
        try {
          await fs.promises.writeFile(notePath, md, 'utf-8');
          return `✅ 笔记已保存: ${title}\n路径: ${notePath}${tags.length > 0 ? `\n标签: ${tags.join(', ')}` : ''}`;
        } catch (err) { return `❌ 保存失败: ${errMsg(err)}`; }
      }

      if (action === 'list' || action === 'tag') {
        try {
          const files = await fs.promises.readdir(notesDir);
          const mdFiles = files.filter(f => f.endsWith('.md'));
          if (mdFiles.length === 0) return '📭 暂无笔记';
          let notes: Array<{ file: string; title: string; tags: string[]; preview: string }> = [];
          for (const f of mdFiles) {
            const content = await fs.promises.readFile(path.join(notesDir, f), 'utf-8');
            const titleMatch = content.match(/^# (.+)$/m);
            const tagsMatch = content.match(/^> 标签: (.+)$/m);
            const tags = tagsMatch ? tagsMatch[1].split(',').filter(Boolean) : [];
            notes.push({
              file: f, title: titleMatch ? titleMatch[1] : f,
              tags, preview: content.split('\n').slice(3, 5).join(' ').substring(0, 80),
            });
          }
          if (action === 'tag') {
            const tag = (args.content as string) || '';
            notes = notes.filter(n => n.tags.some(t => t.trim() === tag));
            if (notes.length === 0) return `📭 标签 "${tag}" 下无笔记`;
          }
          notes.sort((a, b) => b.file.localeCompare(a.file));
          let report = `📝 **笔记列表** (${notes.length} 条${action === 'tag' ? ` | 标签: ${args.content}` : ''})\n${'─'.repeat(50)}\n`;
          for (const n of notes) {
            report += `📄 ${n.title}\n   标签: ${n.tags.length > 0 ? n.tags.join(', ') : '无'}\n   预览: ${n.preview}...\n`;
          }
          return report;
        } catch (err) { return `❌ 列表失败: ${errMsg(err)}`; }
      }

      if (action === 'search') {
        const keyword = (args.content as string) || '';
        if (!keyword) return '❌ search 需要关键词';
        try {
          const files = await fs.promises.readdir(notesDir);
          const mdFiles = files.filter(f => f.endsWith('.md'));
          const matches: Array<{ file: string; title: string; snippet: string }> = [];
          for (const f of mdFiles) {
            const content = await fs.promises.readFile(path.join(notesDir, f), 'utf-8');
            if (content.includes(keyword)) {
              const titleMatch = content.match(/^# (.+)$/m);
              const idx = content.indexOf(keyword);
              const snippet = content.substring(Math.max(0, idx - 20), idx + 60).replace(/\n/g, ' ');
              matches.push({ file: f, title: titleMatch ? titleMatch[1] : f, snippet: `...${snippet}...` });
            }
          }
          if (matches.length === 0) return `🔍 未找到包含 "${keyword}" 的笔记`;
          let report = `🔍 **搜索结果** "${keyword}" (${matches.length} 条)\n${'─'.repeat(50)}\n`;
          for (const m of matches) {
            report += `📄 ${m.title}\n   ${m.snippet}\n`;
          }
          return report;
        } catch (err) { return `❌ 搜索失败: ${errMsg(err)}`; }
      }

      return '❌ action 必须是 add/list/search/tag';
    },
  },
];
