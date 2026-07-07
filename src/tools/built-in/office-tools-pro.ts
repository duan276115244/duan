/**
 * 进阶办公工具集 — OfficeToolsPro
 *
 * 第三批办公场景工具，覆盖更深度的专业办公需求：
 * 1. 批量文件操作（重命名/内容替换/批量水印）
 * 2. 联系人/CRM 管理（客户信息存储与查询）
 * 3. 简历生成与优化（基于模板填充+LLM 润色）
 * 4. 合同要点提取（条款结构化、风险点识别）
 * 5. 财务计算（贷款月供/复利/税务/投资回报）
 * 6. PDF 拆分（按页码范围拆分）
 * 7. 演讲稿/提词卡生成（基于主题+时长）
 * 8. 文档差异对比（两文档 diff）
 * 9. 数据清洗（去重/格式化/缺失值处理）
 * 10. 项目跟踪（里程碑/任务进度管理）
 *
 * 设计原则：
 * - LLM 用于内容生成与语义分析，纯计算走本地算法
 * - 数据持久化到 ~/.duan/ 下相应子目录
 * - 所有文件操作走 fs.promises 异步
 * - 敏感路径防护 + 输入校验
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

export const officeToolsPro: UnifiedToolDef[] = [
  // ============ 批量文件操作 ============
  {
    name: 'batch_files',
    description: '批量文件操作。支持: rename(批量重命名)/replace(批量替换内容)/watermark(批量加水印)。基于目录扫描+模式匹配。',
    readOnly: false,
    parameters: {
      action: { type: 'string', description: 'rename/replace/watermark', required: true },
      directory: { type: 'string', description: '目标目录', required: true },
      pattern: { type: 'string', description: 'rename: 文件名匹配正则; replace: 内容查找字符串; watermark: 文件扩展名过滤(如 .jpg)', required: true },
      replacement: { type: 'string', description: 'rename: 替换为; replace: 替换为; watermark: 水印文字', required: true },
      recursive: { type: 'string', description: '是否递归子目录 true/false，默认 false', required: false },
      dryRun: { type: 'string', description: 'true 仅预览不执行，默认 false', required: false },
    },
    execute: async (args) => {
      const action = args.action as string;
      const directory = args.directory as string;
      const guard = guardSensitivePath(directory);
      if (guard) return guard;
      if (!(await pathExists(directory))) return `❌ 目录不存在: ${directory}`;
      const pattern = args.pattern as string;
      const replacement = args.replacement as string;
      const recursive = (args.recursive as string) === 'true';
      const dryRun = (args.dryRun as string) === 'true';

      // 收集文件
      const files: string[] = [];
      const collect = async (dir: string) => {
        const entries = await fs.promises.readdir(dir, { withFileTypes: true });
        for (const e of entries) {
          const full = path.join(dir, e.name);
          if (e.isDirectory() && recursive) await collect(full);
          else if (e.isFile()) files.push(full);
        }
      };
      await collect(directory);

      let regex: RegExp | null = null;
      if (action === 'rename') {
        try { regex = new RegExp(pattern); } catch (err) { return `❌ 无效正则: ${errMsg(err)}`; }
      }

      const results: string[] = [];
      let success = 0;
      let skipped = 0;

      for (const file of files) {
        try {
          if (action === 'rename') {
            const dir = path.dirname(file);
            const oldName = path.basename(file);
            const newName = oldName.replace(regex!, replacement);
            if (newName === oldName) { skipped++; continue; }
            const newPath = path.join(dir, newName);
            if (!dryRun) await fs.promises.rename(file, newPath);
            results.push(`✏️ ${oldName} → ${newName}`);
            success++;
          } else if (action === 'replace') {
            const ext = path.extname(file).toLowerCase();
            if (!['.txt', '.md', '.json', '.csv', '.js', '.ts', '.html', '.css', '.xml', '.yaml', '.yml'].includes(ext)) { skipped++; continue; }
            const content = await fs.promises.readFile(file, 'utf-8');
            if (!content.includes(pattern)) { skipped++; continue; }
            const newContent = content.split(pattern).join(replacement);
            if (!dryRun) await fs.promises.writeFile(file, newContent, 'utf-8');
            const count = content.split(pattern).length - 1;
            results.push(`🔄 ${path.basename(file)} (${count} 处替换)`);
            success++;
          } else if (action === 'watermark') {
            const ext = path.extname(file).toLowerCase();
            const targetExts = pattern.split(',').map(s => s.trim().toLowerCase());
            if (!targetExts.includes(ext)) { skipped++; continue; }
            // 委托 watermark_add 工具（避免重复实现）
            try {
              const { officeToolsExtended } = await import('./office-tools-extended.js');
              const wmTool = officeToolsExtended.find(t => t.name === 'watermark_add');
              if (!wmTool) { skipped++; continue; }
              const outPath = file.replace(new RegExp(`\\${ext}$`), `_wm${ext}`);
              if (!dryRun) {
                await wmTool.execute({ imagePath: file, text: replacement, outputPath: outPath });
              }
              results.push(`💧 ${path.basename(file)} → ${path.basename(outPath)}`);
              success++;
            } catch (err) {
              results.push(`❌ ${path.basename(file)}: ${errMsg(err)}`);
            }
          }
        } catch (err) {
          results.push(`❌ ${path.basename(file)}: ${errMsg(err)}`);
        }
      }

      const actionLabelMap: Record<string, string> = { rename: '重命名', replace: '替换', watermark: '水印' };
      let report = `🔧 **批量${actionLabelMap[action] || '操作'}** ${dryRun ? '(dry-run)' : ''}\n`;
      report += `目录: ${directory} | 递归: ${recursive} | 处理: ${success} | 跳过: ${skipped}\n${'─'.repeat(50)}\n`;
      report += results.slice(0, 50).join('\n');
      if (results.length > 50) report += `\n...(共 ${results.length} 条，已截断)`;
      return report;
    },
  },

  // ============ 联系人/CRM 管理 ============
  {
    name: 'contact_manage',
    description: '联系人/CRM 管理。支持: add(添加)/list(列表)/search(搜索)/update(更新)/note(添加跟进记录)。存储在 ~/.duan/contacts.json。',
    readOnly: false,
    parameters: {
      action: { type: 'string', description: 'add/list/search/update/note', required: true },
      name: { type: 'string', description: '联系人姓名', required: false },
      company: { type: 'string', description: '公司', required: false },
      phone: { type: 'string', description: '电话', required: false },
      email: { type: 'string', description: '邮箱', required: false },
      tags: { type: 'string', description: '标签 JSON 数组(如 ["客户","VIP"])', required: false },
      note: { type: 'string', description: 'note 模式: 跟进记录内容', required: false },
      contactId: { type: 'string', description: 'update/note 模式: 联系人ID', required: false },
      keyword: { type: 'string', description: 'search 模式: 搜索关键词', required: false },
    },
    execute: async (args) => {
      const os = await import('os');
      const contactsFile = path.join(os.homedir(), '.duan', 'contacts.json');
      await fs.promises.mkdir(path.dirname(contactsFile), { recursive: true });

      interface ContactRecord {
        id: string; name: string; company?: string; phone?: string;
        email?: string; tags: string[]; notes: Array<{ time: string; content: string }>;
        createdAt: number; updatedAt: number;
      }

      let contacts: ContactRecord[];
      try {
        if (await pathExists(contactsFile)) contacts = JSON.parse(await fs.promises.readFile(contactsFile, 'utf-8'));
        else contacts = [];
      } catch { contacts = []; }

      const action = args.action as string;

      if (action === 'add') {
        const name = (args.name as string) || '';
        if (!name) return '❌ add 需要 name';
        let tags: string[] = [];
        if (args.tags) { try { tags = JSON.parse(args.tags as string); } catch { /* ignore */ } }
        const newContact: ContactRecord = {
          id: `c_${Date.now()}_${Math.random().toString(36).substring(2, 6)}`,
          name, company: args.company as string, phone: args.phone as string,
          email: args.email as string, tags, notes: [],
          createdAt: Date.now(), updatedAt: Date.now(),
        };
        contacts.push(newContact);
        await atomicWriteJson(contactsFile, contacts);
        return `✅ 联系人已添加: ${newContact.id}\n   📛 ${name} | 🏢 ${newContact.company || '未知'} | 📞 ${newContact.phone || '无'} | ✉️ ${newContact.email || '无'}\n   标签: ${tags.join(', ') || '无'}`;
      }

      if (action === 'list') {
        if (contacts.length === 0) return '📭 暂无联系人';
        let report = `👥 **联系人列表** (${contacts.length} 个)\n${'─'.repeat(50)}\n`;
        for (const c of contacts) {
          report += `🆔 ${c.id}\n   📛 ${c.name} | 🏢 ${c.company || '未知'} | 📞 ${c.phone || '无'} | ✉️ ${c.email || '无'}\n   标签: ${c.tags.join(', ') || '无'} | 跟进: ${c.notes.length} 条\n`;
        }
        return report;
      }

      if (action === 'search') {
        const kw = ((args.keyword as string) || '').toLowerCase();
        if (!kw) return '❌ search 需要 keyword';
        const matches = contacts.filter(c =>
          c.name.toLowerCase().includes(kw) ||
          (c.company || '').toLowerCase().includes(kw) ||
          (c.email || '').toLowerCase().includes(kw) ||
          c.tags.some(t => t.toLowerCase().includes(kw))
        );
        if (matches.length === 0) return `🔍 未找到匹配 "${kw}" 的联系人`;
        let report = `🔍 **搜索结果** "${kw}" (${matches.length} 条)\n${'─'.repeat(50)}\n`;
        for (const c of matches) {
          report += `🆔 ${c.id} | 📛 ${c.name} | 🏢 ${c.company || '未知'} | 📞 ${c.phone || '无'}\n`;
        }
        return report;
      }

      if (action === 'update') {
        const id = (args.contactId as string) || '';
        const c = contacts.find(x => x.id === id || x.id.includes(id));
        if (!c) return `❌ 未找到联系人: ${id}`;
        if (args.name) c.name = args.name as string;
        if (args.company) c.company = args.company as string;
        if (args.phone) c.phone = args.phone as string;
        if (args.email) c.email = args.email as string;
        if (args.tags) { try { c.tags = JSON.parse(args.tags as string); } catch { /* ignore */ } }
        c.updatedAt = Date.now();
        await atomicWriteJson(contactsFile, contacts);
        return `✅ 已更新: ${c.name} (${c.id})`;
      }

      if (action === 'note') {
        const id = (args.contactId as string) || '';
        const c = contacts.find(x => x.id === id || x.id.includes(id));
        if (!c) return `❌ 未找到联系人: ${id}`;
        const noteContent = (args.note as string) || '';
        if (!noteContent) return '❌ note 需要 note 内容';
        c.notes.push({ time: new Date().toISOString(), content: noteContent });
        c.updatedAt = Date.now();
        await atomicWriteJson(contactsFile, contacts);
        return `✅ 跟进记录已添加: ${c.name}\n   ${noteContent}`;
      }

      return '❌ action 必须是 add/list/search/update/note';
    },
  },

  // ============ 简历生成与优化 ============
  {
    name: 'resume_generate',
    description: '简历生成与优化。支持: generate(从要点生成简历)/optimize(优化现有简历)/tailor(根据岗位JD定制)。输出 Markdown 格式简历。',
    readOnly: true,
    parameters: {
      action: { type: 'string', description: 'generate/optimize/tailor', required: true },
      input: { type: 'string', description: 'generate: 个人信息+经历 JSON; optimize: 现有简历文本; tailor: 现有简历文本', required: true },
      jobDescription: { type: 'string', description: 'tailor 模式: 目标岗位 JD', required: false },
      outputPath: { type: 'string', description: '输出文件路径(可选)', required: false },
    },
    execute: async (args) => {
      const action = args.action as string;
      const input = args.input as string;
      const outputPath = args.outputPath as string;

      let prompt: string;
      let systemPrompt: string;

      if (action === 'generate') {
        let info: { name?: string; title?: string; experience?: string[]; education?: string[]; skills?: string[]; projects?: string[] };
        try { info = JSON.parse(input); } catch { return '❌ input 必须是有效 JSON'; }
        prompt = `根据以下信息生成专业简历。

信息:
${JSON.stringify(info, null, 2)}

要求：
1. 输出 Markdown 格式简历
2. 包含: 个人信息/求职意向/工作经历/项目经历/教育背景/技能特长/自我评价
3. 工作经历用 STAR 法则描述(Situation/Task/Action/Result)
4. 突出量化成果(数字/百分比)
5. 措辞专业、简洁有力
6. 控制在 1-2 页篇幅

输出 Markdown 简历：`;
        systemPrompt = '你是资深 HR 顾问，擅长撰写吸引招聘方的专业简历。';
      } else if (action === 'optimize') {
        prompt = `优化以下简历，提升专业度与竞争力。

原简历:
${input}

要求：
1. 优化措辞，使用强动词(主导/设计/推动/提升)
2. 量化成果，添加可衡量指标
3. 调整结构，突出核心亮点
4. 修正语法/排版问题
5. 保留原有真实经历，不编造
6. 输出优化后的 Markdown 简历

输出：`;
        systemPrompt = '你是简历优化专家，擅长提升简历的专业度与竞争力。';
      } else if (action === 'tailor') {
        const jd = (args.jobDescription as string) || '';
        if (!jd) return '❌ tailor 模式需要 jobDescription';
        prompt = `根据目标岗位 JD 定制简历，提升匹配度。

原简历:
${input}

目标岗位 JD:
${jd}

要求：
1. 调整简历顺序，将与 JD 匹配的经历前置
2. 在技能/经历描述中使用 JD 中的关键词
3. 突出与岗位相关的项目经历与成果
4. 弱化或省略无关经历
5. 保留真实信息，不编造
6. 输出定制后的 Markdown 简历

输出：`;
        systemPrompt = '你是求职顾问，擅长根据岗位 JD 定制简历以提升匹配度。';
      } else {
        return '❌ action 必须是 generate/optimize/tailor';
      }

      try {
        const resume = await callLLM(prompt, systemPrompt);
        const resumeActionMap: Record<string, string> = { generate: '生成', optimize: '优化', tailor: '定制' };
        let report = `📄 **简历${resumeActionMap[action] || '处理'}**\n${'─'.repeat(50)}\n\n${resume}`;
        if (outputPath) {
          const guard = guardSensitivePath(outputPath);
          if (guard) return guard;
          try {
            await fs.promises.writeFile(outputPath, resume, 'utf-8');
            report += `\n\n✅ 简历已保存: ${outputPath}`;
          } catch (err) {
            report += `\n⚠️ 保存失败: ${errMsg(err)}`;
          }
        }
        return report;
      } catch (err) {
        return `❌ 简历生成失败: ${errMsg(err)}`;
      }
    },
  },

  // ============ 合同要点提取 ============
  {
    name: 'contract_analyze',
    description: '合同要点提取与风险识别。从合同文本中提取关键条款、风险点、义务责任，并给出审查建议。',
    readOnly: true,
    parameters: {
      source: { type: 'string', description: 'text(直接文本) 或 file(文件路径)', required: true },
      content: { type: 'string', description: 'text: 合同文本; file: 文件路径', required: true },
      contractType: { type: 'string', description: '合同类型(如"劳动合同"/"采购合同"/"租赁合同")，可选', required: false },
    },
    execute: async (args) => {
      const source = args.source as string;
      let contractText = '';

      if (source === 'text') {
        contractText = (args.content as string) || '';
      } else if (source === 'file') {
        const fp = args.content as string;
        const guard = guardSensitivePath(fp);
        if (guard) return guard;
        if (!(await pathExists(fp))) return `❌ 文件不存在: ${fp}`;
        try {
          contractText = await fs.promises.readFile(fp, 'utf-8');
          if (contractText.length > 15000) contractText = contractText.substring(0, 15000) + '\n...(截断)';
        } catch (err) { return `❌ 读取失败: ${errMsg(err)}`; }
      } else {
        return '❌ source 必须是 text 或 file';
      }

      if (!contractText.trim()) return '❌ 合同内容为空';
      const contractType = (args.contractType as string) || '未指定';

      const prompt = `分析以下合同，提取关键要点并识别风险。

合同类型: ${contractType}

合同文本:
${contractText}

要求输出 JSON（不要代码块包裹）:
{
  "summary": "合同概述(100字内)",
  "parties": ["甲方名称", "乙方名称"],
  "keyTerms": [
    {"term": "条款名称(如合同期限)", "content": "条款内容摘要", "risk": "low/medium/high"}
  ],
  "obligations": [
    {"party": "甲方/乙方", "obligation": "义务内容"}
  ],
  "risks": [
    {"risk": "风险描述", "severity": "high/medium/low", "suggestion": "应对建议"}
  ],
  "importantClauses": ["违约责任", "保密条款", "争议解决"],
  "reviewSuggestions": ["审查建议1", "建议2"]
}`;

      interface ContractAnalysis {
        summary?: string;
        parties?: string[];
        keyTerms?: Array<{ term: string; content: string; risk: string }>;
        obligations?: Array<{ party: string; obligation: string }>;
        risks?: Array<{ risk: string; severity: string; suggestion: string }>;
        importantClauses?: string[];
        reviewSuggestions?: string[];
      }

      let analysis: ContractAnalysis;
      try {
        const str = await callLLM(prompt, '你是资深法务顾问，擅长合同审查与风险识别。注意：分析仅供参考，不构成法律意见。');
        const jsonMatch = str.match(/\{[\s\S]*\}/);
        analysis = jsonMatch ? JSON.parse(jsonMatch[0]) : { summary: str };
      } catch (err) {
        return `❌ 分析失败: ${errMsg(err)}`;
      }

      const riskIconMap: Record<string, string> = { high: '🔴', medium: '🟡', low: '🟢' };
      const severityIconMap: Record<string, string> = { high: '⚠️', medium: '⚡', low: '✓' };
      const riskIcon = (r: string): string => riskIconMap[r] || '🟢';
      const severityIcon = (s: string): string => severityIconMap[s] || '✓';

      let report = `📋 **合同分析报告** | 类型: ${contractType}\n${'─'.repeat(50)}\n\n`;
      report += `**概述**: ${analysis.summary || ''}\n\n`;
      if (analysis.parties && analysis.parties.length > 0) {
        report += `**当事人**: ${analysis.parties.join(' / ')}\n\n`;
      }
      if (analysis.keyTerms && analysis.keyTerms.length > 0) {
        report += `**关键条款**:\n`;
        for (const t of analysis.keyTerms) {
          report += `   ${riskIcon(t.risk)} ${t.term}: ${t.content}\n`;
        }
        report += '\n';
      }
      if (analysis.obligations && analysis.obligations.length > 0) {
        report += `**义务责任**:\n`;
        for (const o of analysis.obligations) {
          report += `   • [${o.party}] ${o.obligation}\n`;
        }
        report += '\n';
      }
      if (analysis.risks && analysis.risks.length > 0) {
        report += `**风险识别**:\n`;
        for (const r of analysis.risks) {
          report += `   ${severityIcon(r.severity)} ${r.risk}\n      💡 ${r.suggestion}\n`;
        }
        report += '\n';
      }
      if (analysis.reviewSuggestions && analysis.reviewSuggestions.length > 0) {
        report += `**审查建议**:\n`;
        analysis.reviewSuggestions.forEach(s => { report += `   • ${s}\n`; });
      }
      report += `\n⚠️ **免责声明**: 本分析由 AI 生成，仅供参考，不构成法律意见。重要合同请咨询专业律师。`;
      return report;
    },
  },

  // ============ 财务计算 ============
  {
    name: 'finance_calc',
    description: '财务计算工具。支持: loan(贷款月供)/compound(复利终值)/tax(个税估算)/roi(投资回报率)/break_even(盈亏平衡点)。纯本地计算，无需联网。',
    readOnly: true,
    parameters: {
      type: { type: 'string', description: 'loan/compound/tax/roi/break_even', required: true },
      principal: { type: 'string', description: 'loan: 贷款本金; compound: 本金; roi: 投入金额; break_even: 固定成本', required: false },
      rate: { type: 'string', description: 'loan: 年利率(%); compound: 年化收益率(%); roi: 收益金额(此字段借用为终值)', required: false },
      years: { type: 'string', description: 'loan/compound: 年数', required: false },
      salary: { type: 'string', description: 'tax: 税前月薪', required: false },
      price: { type: 'string', description: 'break_even: 单价; roi: 实际投入', required: false },
      variableCost: { type: 'string', description: 'break_even: 单件可变成本', required: false },
    },
    // eslint-disable-next-line require-await
    execute: async (args) => {
      const type = args.type as string;
      const num = (v: unknown): number => parseFloat((v as string) || '0') || 0;

      if (type === 'loan') {
        // 等额本息月供
        const P = num(args.principal);
        const annualRate = num(args.rate) / 100;
        const n = num(args.years) * 12;
        if (P <= 0 || annualRate < 0 || n <= 0) return '❌ 参数无效: principal/rate/years 必须为正数';
        const r = annualRate / 12;
        const monthly = r === 0 ? P / n : P * r * Math.pow(1 + r, n) / (Math.pow(1 + r, n) - 1);
        const totalPayment = monthly * n;
        const totalInterest = totalPayment - P;
        return `💰 **贷款月供计算** (等额本息)\n${'─'.repeat(50)}\n   本金: ${P.toLocaleString()} 元\n   年利率: ${(annualRate * 100).toFixed(2)}%\n   期限: ${n} 个月 (${num(args.years)} 年)\n   **月供: ${monthly.toFixed(2)} 元**\n   总还款: ${totalPayment.toFixed(2)} 元\n   总利息: ${totalInterest.toFixed(2)} 元\n   利息占本金: ${(totalInterest / P * 100).toFixed(2)}%`;
      }

      if (type === 'compound') {
        // 复利终值 FV = PV * (1+r)^n
        const PV = num(args.principal);
        const annualRate = num(args.rate) / 100;
        const years = num(args.years);
        if (PV <= 0 || years <= 0) return '❌ 参数无效';
        const FV = PV * Math.pow(1 + annualRate, years);
        const profit = FV - PV;
        return `📈 **复利终值计算**\n${'─'.repeat(50)}\n   本金: ${PV.toLocaleString()} 元\n   年化收益率: ${(annualRate * 100).toFixed(2)}%\n   投资年限: ${years} 年\n   **终值: ${FV.toFixed(2)} 元**\n   收益: ${profit.toFixed(2)} 元\n   收益率: ${(profit / PV * 100).toFixed(2)}%`;
      }

      if (type === 'tax') {
        // 中国个税估算(2025年税率表，起征点 5000)
        const salary = num(args.salary);
        if (salary <= 0) return '❌ salary 必须为正数';
        const threshold = 5000;
        const taxable = Math.max(0, salary - threshold);
        if (taxable === 0) return `💰 **个税估算**\n${'─'.repeat(50)}\n   税前月薪: ${salary} 元\n   起征点: ${threshold} 元\n   应纳税所得额: 0 元(无需缴税)\n   **应纳税额: 0 元**\n   税后收入: ${salary} 元`;
        const brackets = [
          { upper: 3000, rate: 0.03, deduct: 0 },
          { upper: 12000, rate: 0.10, deduct: 210 },
          { upper: 25000, rate: 0.20, deduct: 1410 },
          { upper: 35000, rate: 0.25, deduct: 2660 },
          { upper: 55000, rate: 0.30, deduct: 4410 },
          { upper: 80000, rate: 0.35, deduct: 7160 },
          { upper: Infinity, rate: 0.45, deduct: 15160 },
        ];
        const bracket = brackets.find(b => taxable <= b.upper)!;
        const tax = taxable * bracket.rate - bracket.deduct;
        const afterTax = salary - tax;
        return `💰 **个税估算**(中国累计预扣法简化版)\n${'─'.repeat(50)}\n   税前月薪: ${salary} 元\n   起征点: ${threshold} 元\n   应纳税所得额: ${taxable.toFixed(2)} 元\n   适用税率: ${(bracket.rate * 100)}% | 速算扣除: ${bracket.deduct} 元\n   **应纳税额: ${tax.toFixed(2)} 元**\n   税后收入: ${afterTax.toFixed(2)} 元\n   ⚠️ 实际个税按累计预扣法计算，此处为单月简化估算`;
      }

      if (type === 'roi') {
        // 投资回报率
        const cost = num(args.price);
        const returnValue = num(args.rate);
        if (cost <= 0) return '❌ price(投入) 必须为正数';
        if (returnValue <= 0) return '❌ rate(回报) 必须为正数';
        const profit = returnValue - cost;
        const roi = (profit / cost) * 100;
        return `📊 **投资回报率(ROI)**\n${'─'.repeat(50)}\n   投入: ${cost.toLocaleString()} 元\n   回报: ${returnValue.toLocaleString()} 元\n   净收益: ${profit.toLocaleString()} 元\n   **ROI: ${roi.toFixed(2)}%**\n   ${roi > 0 ? '✅ 盈利' : '❌ 亏损'}`;
      }

      if (type === 'break_even') {
        // 盈亏平衡点：固定成本 / (单价 - 单位可变成本)
        const fixedCost = num(args.principal);
        const price = num(args.price);
        const variableCost = num(args.variableCost);
        if (fixedCost <= 0 || price <= 0) return '❌ 参数无效';
        if (price <= variableCost) return `❌ 单价 ${price} 必须大于单位可变成本 ${variableCost}`;
        const breakEvenQty = fixedCost / (price - variableCost);
        const breakEvenRevenue = breakEvenQty * price;
        return `⚖️ **盈亏平衡点分析**\n${'─'.repeat(50)}\n   固定成本: ${fixedCost.toLocaleString()} 元\n   单价: ${price} 元\n   单位可变成本: ${variableCost} 元\n   单位毛利: ${(price - variableCost).toFixed(2)} 元\n   **盈亏平衡销量: ${breakEvenQty.toFixed(2)} 件**\n   **盈亏平衡营收: ${breakEvenRevenue.toFixed(2)} 元**`;
      }

      return '❌ type 必须是 loan/compound/tax/roi/break_even';
    },
  },

  // ============ PDF 拆分 ============
  {
    name: 'pdf_split',
    description: '按页码范围拆分 PDF。如将 10 页 PDF 拆分为 [1-3], [4-7], [8-10] 三份。依赖 pdf-lib 库。',
    readOnly: false,
    parameters: {
      pdfPath: { type: 'string', description: '源 PDF 路径', required: true },
      ranges: { type: 'string', description: '页码范围 JSON 数组，如 [["1-3"],["4-7"],["8-10"]]', required: true },
      outputDir: { type: 'string', description: '输出目录(默认源文件同目录)', required: false },
    },
    execute: async (args) => {
      const pdfPath = args.pdfPath as string;
      const guard = guardSensitivePath(pdfPath);
      if (guard) return guard;
      if (!(await pathExists(pdfPath))) return `❌ 文件不存在: ${pdfPath}`;
      if (!pdfPath.toLowerCase().endsWith('.pdf')) return '❌ 仅支持 PDF 文件';

      let ranges: string[][];
      try { ranges = JSON.parse(args.ranges as string); } catch { return '❌ ranges 必须是 JSON 数组'; }
      if (!Array.isArray(ranges) || ranges.length === 0) return '❌ ranges 不能为空';

      const baseName = path.basename(pdfPath, '.pdf');
      const outputDir = (args.outputDir as string) || path.dirname(pdfPath);
      const dirGuard = guardSensitivePath(outputDir);
      if (dirGuard) return dirGuard;
      await fs.promises.mkdir(outputDir, { recursive: true });

      try {
        // @ts-expect-error - pdf-lib 可能未安装
        const { PDFDocument } = await import('pdf-lib');
        const srcBytes = await fs.promises.readFile(pdfPath);
        const srcDoc = await PDFDocument.load(srcBytes);
        const totalPages = srcDoc.getPageCount();

        const results: string[] = [];
        for (let i = 0; i < ranges.length; i++) {
          const range = ranges[i];
          if (!Array.isArray(range) || range.length === 0) continue;
          const newDoc = await PDFDocument.create();
          for (const r of range) {
            const m = String(r).match(/^(\d+)-(\d+)$/);
            if (m) {
              const start = parseInt(m[1], 10);
              const end = parseInt(m[2], 10);
              if (start < 1 || end > totalPages || start > end) {
                return `❌ 页码范围 ${r} 无效(总页数 ${totalPages})`;
              }
              const indices = Array.from({ length: end - start + 1 }, (_, k) => start - 1 + k);
              const copied = await newDoc.copyPages(srcDoc, indices);
              copied.forEach(p => newDoc.addPage(p));
            } else if (/^\d+$/.test(String(r))) {
              const p = parseInt(String(r), 10);
              if (p < 1 || p > totalPages) return `❌ 页码 ${p} 无效(总页数 ${totalPages})`;
              const [copied] = await newDoc.copyPages(srcDoc, [p - 1]);
              newDoc.addPage(copied);
            }
          }
          const outBytes = await newDoc.save();
          const outPath = path.join(outputDir, `${baseName}_part${i + 1}.pdf`);
          await fs.promises.writeFile(outPath, outBytes);
          results.push(`📄 ${path.basename(outPath)} (${range.join(', ')})`);
        }

        let report = `✅ **PDF 拆分完成** | 源: ${path.basename(pdfPath)} | 总页数: ${totalPages}\n${'─'.repeat(50)}\n`;
        report += results.join('\n');
        return report;
      } catch (err) {
        if (String(err).includes('Cannot find module') || String(err).includes('pdf-lib')) {
          return `⚠️ 需要安装 pdf-lib: npm install pdf-lib\n失败: ${errMsg(err)}`;
        }
        return `❌ 拆分失败: ${errMsg(err)}`;
      }
    },
  },

  // ============ 演讲稿/提词卡生成 ============
  {
    name: 'speech_draft',
    description: '演讲稿/提词卡生成。基于主题+时长+受众，生成结构化演讲稿与提词卡。支持开场/主体/结尾三段式。',
    readOnly: true,
    parameters: {
      topic: { type: 'string', description: '演讲主题', required: true },
      duration: { type: 'string', description: '时长(分钟，如 "10")', required: true },
      audience: { type: 'string', description: '受众(如"技术团队"/"投资人"/"客户")', required: false },
      style: { type: 'string', description: '风格: formal(正式)/inspiring(激励)/casual(轻松)/technical(技术)，默认 formal', required: false },
      outputPath: { type: 'string', description: '输出文件路径(可选)', required: false },
    },
    execute: async (args) => {
      const topic = args.topic as string;
      const duration = parseInt((args.duration as string) || '5', 10);
      const audience = (args.audience as string) || '通用受众';
      const style = (args.style as string) || 'formal';
      const outputPath = args.outputPath as string;

      // 根据时长估算字数(中文约 200 字/分钟)
      const wordCount = duration * 200;

      const styleMap: Record<string, string> = {
        formal: '正式严谨，逻辑清晰，措辞得体',
        inspiring: '激励鼓舞，富有感染力，善用排比与反问',
        casual: '轻松幽默，亲切自然，多用故事',
        technical: '技术深入，数据支撑，结构化呈现',
      };

      const prompt = `撰写一篇 ${duration} 分钟的演讲稿(约 ${wordCount} 字)。

主题: ${topic}
受众: ${audience}
风格: ${styleMap[style] || styleMap.formal}

要求：
1. 三段式结构: 开场(15%) / 主体(70%) / 结尾(15%)
2. 开场用提问/故事/数据吸引注意
3. 主体分 2-3 个要点，每个要点配案例或数据
4. 结尾呼吁行动或升华主题
5. 标注关键停顿点 [停顿] 和重音 [重音:xxx]
6. 输出 JSON 格式（不要代码块包裹）:
{
  "title": "演讲标题",
  "outline": ["开场要点", "主体要点1", "主体要点2", "结尾"],
  "speech": "完整演讲稿(含标注)",
  "cueCards": ["提词卡1: 开场第一句", "提词卡2: 要点1 关键数据", "..."],
  "tips": ["演讲技巧提示1", "提示2"]
}`;

      interface SpeechDraft {
        title?: string;
        outline?: string[];
        speech?: string;
        cueCards?: string[];
        tips?: string[];
      }

      let draft: SpeechDraft;
      try {
        const str = await callLLM(prompt, '你是资深演讲教练，擅长撰写打动人心的演讲稿。');
        const jsonMatch = str.match(/\{[\s\S]*\}/);
        draft = jsonMatch ? JSON.parse(jsonMatch[0]) : { speech: str };
      } catch (err) {
        return `❌ 生成失败: ${errMsg(err)}`;
      }

      let report = `🎤 **${draft.title || topic}**\n`;
      report += `⏱️ ${duration} 分钟 | 👥 ${audience} | 🎨 ${style}\n${'─'.repeat(50)}\n\n`;

      if (draft.outline && draft.outline.length > 0) {
        report += `**📋 大纲**:\n`;
        draft.outline.forEach((o, i) => { report += `   ${i + 1}. ${o}\n`; });
        report += '\n';
      }

      if (draft.speech) {
        report += `**📝 演讲稿**:\n\n${draft.speech}\n\n`;
      }

      if (draft.cueCards && draft.cueCards.length > 0) {
        report += `**🎴 提词卡**:\n`;
        draft.cueCards.forEach((c, i) => { report += `   [${i + 1}] ${c}\n`; });
        report += '\n';
      }

      if (draft.tips && draft.tips.length > 0) {
        report += `**💡 演讲技巧**:\n`;
        draft.tips.forEach(t => { report += `   • ${t}\n`; });
      }

      if (outputPath) {
        const guard = guardSensitivePath(outputPath);
        if (guard) return guard;
        try {
          await fs.promises.writeFile(outputPath, report, 'utf-8');
          report += `\n✅ 演讲稿已保存: ${outputPath}`;
        } catch (err) {
          report += `\n⚠️ 保存失败: ${errMsg(err)}`;
        }
      }
      return report;
    },
  },

  // ============ 文档差异对比 ============
  {
    name: 'doc_diff',
    description: '对比两个文档的差异。支持文本行级 diff 和语义级差异分析(由 LLM 识别实质性改动)。',
    readOnly: true,
    parameters: {
      file1: { type: 'string', description: '第一个文件路径', required: true },
      file2: { type: 'string', description: '第二个文件路径', required: true },
      mode: { type: 'string', description: 'line(行级 diff)/semantic(语义级分析)/both(默认 both)', required: false },
    },
    execute: async (args) => {
      const file1 = args.file1 as string;
      const file2 = args.file2 as string;
      for (const f of [file1, file2]) {
        const guard = guardSensitivePath(f);
        if (guard) return guard;
        if (!(await pathExists(f))) return `❌ 文件不存在: ${f}`;
      }
      const mode = (args.mode as string) || 'both';

      let text1 = '', text2 = '';
      try {
        text1 = await fs.promises.readFile(file1, 'utf-8');
        text2 = await fs.promises.readFile(file2, 'utf-8');
      } catch (err) { return `❌ 读取失败: ${errMsg(err)}`; }

      const lines1 = text1.split('\n');
      const lines2 = text2.split('\n');

      let report = `🔍 **文档差异对比**\n${'─'.repeat(50)}\n`;
      report += `📄 ${path.basename(file1)} (${lines1.length} 行) vs 📄 ${path.basename(file2)} (${lines2.length} 行)\n\n`;

      // 行级 diff（简化 LCS）
      if (mode === 'line' || mode === 'both') {
        const diff = computeLineDiff(lines1, lines2);
        if (diff.length === 0) {
          report += `**行级 diff**: ✅ 两文件完全相同\n\n`;
        } else {
          report += `**行级 diff** (${diff.length} 处差异):\n\`\`\`\n`;
          for (const d of diff.slice(0, 50)) {
            if (d.type === 'removed') report += `- ${d.line}\n`;
            else if (d.type === 'added') report += `+ ${d.line}\n`;
            else report += `  ${d.line}\n`;
          }
          if (diff.length > 50) report += `...(共 ${diff.length} 处差异)\n`;
          report += `\`\`\`\n\n`;
        }
      }

      // 语义级分析
      if (mode === 'semantic' || mode === 'both') {
        const prompt = `对比以下两份文档，识别实质性差异。

文档 A (${path.basename(file1)}):
${text1.substring(0, 6000)}

文档 B (${path.basename(file2)}):
${text2.substring(0, 6000)}

要求输出 JSON（不要代码块包裹）:
{
  "summary": "差异概述",
  "changes": [{"type": "add/remove/modify", "description": "具体改动", "impact": "high/medium/low"}],
  "keyInsight": "关键洞察(如风险/机会)"
}`;

        interface SemanticDiff {
          summary?: string;
          changes?: Array<{ type: string; description: string; impact: string }>;
          keyInsight?: string;
        }
        try {
          const str = await callLLM(prompt, '你是文档对比分析专家。');
          const jsonMatch = str.match(/\{[\s\S]*\}/);
          const analysis: SemanticDiff = jsonMatch ? JSON.parse(jsonMatch[0]) : { summary: str };
          report += `**🧠 语义级差异**:\n`;
          report += `   📝 ${analysis.summary || ''}\n`;
          if (analysis.changes && analysis.changes.length > 0) {
            const impactIconMap: Record<string, string> = { high: '🔴', medium: '🟡', low: '🟢' };
            const impactIcon = (i: string): string => impactIconMap[i] || '🟢';
            for (const c of analysis.changes.slice(0, 20)) {
              report += `   ${impactIcon(c.impact)} [${c.type}] ${c.description}\n`;
            }
          }
          if (analysis.keyInsight) report += `\n   💡 ${analysis.keyInsight}\n`;
        } catch (err) {
          report += `**🧠 语义级差异**: ⚠️ 分析失败: ${errMsg(err)}\n`;
        }
      }

      return report;
    },
  },

  // ============ 数据清洗 ============
  {
    name: 'data_clean',
    description: '数据清洗。支持: dedupe(去重)/format(格式化)/fillna(缺失值填充)/outlier(异常值检测)。输入 CSV/JSON，输出清洗后数据。',
    readOnly: false,
    parameters: {
      inputFile: { type: 'string', description: '输入文件路径(CSV/JSON)', required: true },
      outputFile: { type: 'string', description: '输出文件路径', required: true },
      action: { type: 'string', description: 'dedupe(去重)/format(格式标准化)/fillna(缺失值填充)/outlier(异常值检测)', required: true },
      column: { type: 'string', description: '目标列名(可选，默认全列)', required: false },
      fillValue: { type: 'string', description: 'fillna 模式: 填充值(如 "0"/"未知"/"mean")', required: false },
    },
    execute: async (args) => {
      const inputFile = args.inputFile as string;
      const outputFile = args.outputFile as string;
      for (const f of [inputFile, outputFile]) {
        const guard = guardSensitivePath(f);
        if (guard) return guard;
      }
      if (!(await pathExists(inputFile))) return `❌ 文件不存在: ${inputFile}`;

      const action = args.action as string;
      const column = (args.column as string) || '';
      const fillValue = (args.fillValue as string) || '';

      // 读取数据
      let data: Record<string, unknown>[];
      const ext = path.extname(inputFile).toLowerCase();
      try {
        const text = await fs.promises.readFile(inputFile, 'utf-8');
        if (ext === '.json') {
          const parsed = JSON.parse(text);
          data = Array.isArray(parsed) ? parsed : [parsed];
        } else if (ext === '.csv') {
          const lines = text.trim().split('\n');
          if (lines.length < 2) return '❌ CSV 至少需要标题行+1行数据';
          const headers = lines[0].split(',').map(h => h.trim().replace(/^["']|["']$/g, ''));
          data = lines.slice(1).map(line => {
            const values = line.split(',').map(v => v.trim().replace(/^["']|["']$/g, ''));
            const obj: Record<string, unknown> = {};
            headers.forEach((h, i) => { obj[h] = values[i]; });
            return obj;
          });
        } else {
          return `❌ 仅支持 CSV/JSON，不支持 ${ext}`;
        }
      } catch (err) { return `❌ 解析失败: ${errMsg(err)}`; }

      const originalCount = data.length;
      let cleanedCount = 0;
      let report = '';

      if (action === 'dedupe') {
        const seen = new Set<string>();
        const deduped: Record<string, unknown>[] = [];
        for (const row of data) {
          const key = column ? String(row[column] ?? '') : JSON.stringify(row);
          if (!seen.has(key)) {
            seen.add(key);
            deduped.push(row);
          }
        }
        cleanedCount = deduped.length;
        const removed = originalCount - cleanedCount;
        report = `🧹 **数据去重**\n${'─'.repeat(50)}\n   原始: ${originalCount} 条\n   去重后: ${cleanedCount} 条\n   移除: ${removed} 条重复\n`;
        data = deduped;
      } else if (action === 'format') {
        // 格式标准化：去除首尾空格、统一日期格式等
        let formatted = 0;
        for (const row of data) {
          for (const key of Object.keys(row)) {
            const v = row[key];
            if (typeof v === 'string') {
              const trimmed = v.trim();
              if (trimmed !== v) { row[key] = trimmed; formatted++; }
              // 简单日期格式统一 yyyy/mm/dd → yyyy-mm-dd
              if (/^\d{4}\/\d{1,2}\/\d{1,2}/.test(trimmed)) {
                row[key] = trimmed.replace(/\//g, '-');
                formatted++;
              }
            }
          }
        }
        cleanedCount = data.length;
        report = `🔧 **格式标准化**\n${'─'.repeat(50)}\n   处理: ${originalCount} 条\n   修正字段: ${formatted} 处(去空格/日期格式统一)\n`;
      } else if (action === 'fillna') {
        if (!fillValue) return '❌ fillna 模式需要 fillValue';
        let filled = 0;
        for (const row of data) {
          for (const key of Object.keys(row)) {
            if (column && key !== column) continue;
            const v = row[key];
            if (v === undefined || v === null || v === '' || String(v).toLowerCase() === 'nan') {
              if (fillValue === 'mean') {
                // 数值列求均值填充
                const nums = data.map(r => Number(r[key])).filter(n => !isNaN(n));
                const mean = nums.length > 0 ? nums.reduce((a, b) => a + b, 0) / nums.length : 0;
                row[key] = String(mean.toFixed(2));
              } else {
                row[key] = fillValue;
              }
              filled++;
            }
          }
        }
        cleanedCount = data.length;
        report = `📝 **缺失值填充**\n${'─'.repeat(50)}\n   处理: ${originalCount} 条\n   填充值: ${fillValue}\n   填充字段数: ${filled} 处\n`;
      } else if (action === 'outlier') {
        // 数值列异常值检测(3σ原则)
        const numericCols = new Set<string>();
        for (const row of data) {
          for (const key of Object.keys(row)) {
            if (column && key !== column) continue;
            if (!isNaN(Number(row[key]))) numericCols.add(key);
          }
        }
        const outliers: Array<{ col: string; row: number; value: string }> = [];
        for (const col of numericCols) {
          const values = data.map(r => Number(r[col])).filter(n => !isNaN(n));
          if (values.length < 3) continue;
          const mean = values.reduce((a, b) => a + b, 0) / values.length;
          const std = Math.sqrt(values.reduce((s, v) => s + (v - mean) ** 2, 0) / values.length);
          if (std === 0) continue;
          data.forEach((row, idx) => {
            const v = Number(row[col]);
            if (!isNaN(v) && Math.abs((v - mean) / std) > 3) {
              outliers.push({ col, row: idx + 1, value: String(v) });
            }
          });
        }
        cleanedCount = data.length;
        report = `📊 **异常值检测(3σ原则)**\n${'─'.repeat(50)}\n   检测列: ${Array.from(numericCols).join(', ') || '无'}\n   异常数: ${outliers.length} 处\n`;
        if (outliers.length > 0) {
          report += `   异常明细(前 10 条):\n`;
          outliers.slice(0, 10).forEach(o => { report += `      行 ${o.row} 列 ${o.col}: ${o.value}\n`; });
        }
      } else {
        return '❌ action 必须是 dedupe/format/fillna/outlier';
      }

      // 写入输出
      try {
        const outExt = path.extname(outputFile).toLowerCase();
        if (outExt === '.json') {
          await atomicWriteJson(outputFile, data);
        } else if (outExt === '.csv') {
          const headers = data.length > 0 ? Object.keys(data[0]) : [];
          const csvLines = [headers.join(',')];
          for (const row of data) {
            csvLines.push(headers.map(h => `"${String(row[h] ?? '').replace(/"/g, '""')}"`).join(','));
          }
          await fs.promises.writeFile(outputFile, csvLines.join('\n'), 'utf-8');
        } else {
          await atomicWriteJson(outputFile, data);
        }
        report += `   ✅ 已保存: ${outputFile}`;
        return report;
      } catch (err) {
        return `${report}\n❌ 保存失败: ${errMsg(err)}`;
      }
    },
  },

  // ============ 项目跟踪 ============
  {
    name: 'project_track',
    description: '项目跟踪管理。支持: create(创建项目)/add_milestone(添加里程碑)/add_task(添加任务)/progress(查看进度)/complete_task(完成任务)。存储在 ~/.duan/projects/。',
    readOnly: false,
    parameters: {
      action: { type: 'string', description: 'create/add_milestone/add_task/progress/complete_task', required: true },
      projectId: { type: 'string', description: '项目 ID(create 时可省略)', required: false },
      name: { type: 'string', description: 'create: 项目名; add_milestone: 里程碑名; add_task: 任务名', required: false },
      description: { type: 'string', description: 'create/add_milestone: 描述', required: false },
      dueDate: { type: 'string', description: 'add_milestone/add_task: 截止日期', required: false },
      assignee: { type: 'string', description: 'add_task: 负责人', required: false },
      taskId: { type: 'string', description: 'complete_task: 任务 ID', required: false },
    },
    execute: async (args) => {
      const os = await import('os');
      const projectsDir = path.join(os.homedir(), '.duan', 'projects');
      await fs.promises.mkdir(projectsDir, { recursive: true });

      const action = args.action as string;

      interface Milestone { id: string; name: string; description?: string; dueDate?: string; tasks: Task[]; completed: boolean; }
      interface Task { id: string; name: string; assignee?: string; dueDate?: string; status: 'pending' | 'in_progress' | 'completed'; }
      interface Project { id: string; name: string; description?: string; createdAt: number; milestones: Milestone[]; }

      if (action === 'create') {
        const name = (args.name as string) || '';
        if (!name) return '❌ create 需要 name';
        const proj: Project = {
          id: `proj_${Date.now()}_${Math.random().toString(36).substring(2, 6)}`,
          name,
          description: args.description as string,
          createdAt: Date.now(),
          milestones: [],
        };
        await atomicWriteJson(path.join(projectsDir, `${proj.id}.json`), proj);
        return `✅ 项目已创建: ${proj.id}\n   📁 ${name}\n   ${proj.description || ''}`;
      }

      // 其他 action 都需要 projectId
      const pid = (args.projectId as string) || '';
      const projPath = path.join(projectsDir, `${pid}.json`);
      if (!(await pathExists(projPath))) return `❌ 项目不存在: ${pid}`;

      let project: Project;
      try { project = JSON.parse(await fs.promises.readFile(projPath, 'utf-8')); } catch (err) { return `❌ 读取失败: ${errMsg(err)}`; }

      if (action === 'add_milestone') {
        const name = (args.name as string) || '';
        if (!name) return '❌ add_milestone 需要 name';
        const ms: Milestone = {
          id: `ms_${Date.now()}_${Math.random().toString(36).substring(2, 6)}`,
          name, description: args.description as string,
          dueDate: args.dueDate as string, tasks: [], completed: false,
        };
        project.milestones.push(ms);
        await atomicWriteJson(projPath, project);
        return `✅ 里程碑已添加: ${ms.id}\n   🎯 ${name} | 截止: ${ms.dueDate || '未设定'}`;
      }

      if (action === 'add_task') {
        // 简化：任务添加到第一个未完成里程碑（若 pid 是 ms_ 前缀则定向到该里程碑）
        const targetMs = (pid.startsWith('ms_') ? project.milestones.find(m => m.id === pid) : undefined)
          || project.milestones.find(m => !m.completed)
          || project.milestones[project.milestones.length - 1];
        if (!targetMs) return '❌ 项目无里程碑，请先 add_milestone';
        const name = (args.name as string) || '';
        if (!name) return '❌ add_task 需要 name';
        const task: Task = {
          id: `task_${Date.now()}_${Math.random().toString(36).substring(2, 6)}`,
          name, assignee: args.assignee as string,
          dueDate: args.dueDate as string, status: 'pending',
        };
        targetMs.tasks.push(task);
        await atomicWriteJson(projPath, project);
        return `✅ 任务已添加: ${task.id}\n   📋 ${name} → ${targetMs.name}\n   负责人: ${task.assignee || '未指定'} | 截止: ${task.dueDate || '未设定'}`;
      }

      if (action === 'complete_task') {
        const taskId = (args.taskId as string) || '';
        let found = false;
        for (const ms of project.milestones) {
          const t = ms.tasks.find(x => x.id === taskId || x.id.includes(taskId));
          if (t) { t.status = 'completed'; found = true; break; }
        }
        if (!found) return `❌ 未找到任务: ${taskId}`;
        await atomicWriteJson(projPath, project);
        return `✅ 任务已完成: ${taskId}`;
      }

      if (action === 'progress') {
        let report = `📊 **项目进度** | ${project.name}\n${'─'.repeat(50)}\n`;
        report += `📁 ${project.description || '无描述'} | 创建于 ${new Date(project.createdAt).toLocaleDateString()}\n\n`;
        if (project.milestones.length === 0) {
          report += '📭 暂无里程碑';
          return report;
        }
        for (const ms of project.milestones) {
          const totalTasks = ms.tasks.length;
          const completedTasks = ms.tasks.filter(t => t.status === 'completed').length;
          const progress = totalTasks > 0 ? Math.round(completedTasks / totalTasks * 100) : 0;
          const bar = '█'.repeat(Math.floor(progress / 10)) + '░'.repeat(10 - Math.floor(progress / 10));
          report += `🎯 ${ms.name} ${ms.completed ? '✅' : ''}\n   ${bar} ${progress}% (${completedTasks}/${totalTasks}) | 截止: ${ms.dueDate || '未设定'}\n`;
          for (const t of ms.tasks) {
            const taskStatusIconMap: Record<string, string> = { completed: '✅', in_progress: '🔄', pending: '⬜' };
            const icon = taskStatusIconMap[t.status] || '⬜';
            report += `      ${icon} ${t.name} [${t.assignee || '未分配'}]\n`;
          }
        }
        return report;
      }

      return '❌ action 必须是 create/add_milestone/add_task/progress/complete_task';
    },
  },
];

// ============ 辅助函数 ============

/** 简化行级 diff（基于 LCS）*/
function computeLineDiff(lines1: string[], lines2: string[]): Array<{ type: 'added' | 'removed' | 'same'; line: string }> {
  const m = lines1.length;
  const n = lines2.length;
  // LCS DP 表
  const dp: number[][] = Array.from({ length: m + 1 }, () => new Array(n + 1).fill(0));
  for (let i = 1; i <= m; i++) {
    for (let j = 1; j <= n; j++) {
      if (lines1[i - 1] === lines2[j - 1]) dp[i][j] = dp[i - 1][j - 1] + 1;
      else dp[i][j] = Math.max(dp[i - 1][j], dp[i][j - 1]);
    }
  }
  // 回溯收集差异
  const result: Array<{ type: 'added' | 'removed' | 'same'; line: string }> = [];
  let i = m, j = n;
  while (i > 0 || j > 0) {
    if (i > 0 && j > 0 && lines1[i - 1] === lines2[j - 1]) {
      result.unshift({ type: 'same', line: lines1[i - 1] });
      i--; j--;
    } else if (j > 0 && (i === 0 || dp[i][j - 1] >= dp[i - 1][j])) {
      result.unshift({ type: 'added', line: lines2[j - 1] });
      j--;
    } else {
      result.unshift({ type: 'removed', line: lines1[i - 1] });
      i--;
    }
  }
  // 只返回有差异的部分（前后各保留 1 行上下文）
  const diffOnly = result.filter(d => d.type !== 'same');
  return diffOnly;
}
