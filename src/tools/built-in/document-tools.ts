/**
 * 文档处理工具集 — DocumentTools
 *
 * 覆盖办公场景四大能力：
 * 1. 文件智能分类与整理（按类型/日期/项目多维归档）
 * 2. 多源文档汇总（提取→整合→结构化呈现）
 * 3. 表单填写自动化（识别字段+模板填充）
 * 4. 文档优化（格式统一/内容润色/排版美化）
 *
 * 设计原则：
 * - 文件移动操作走 fs.promises 原生异步，不依赖外部工具
 * - 内容生成通过 toolContext.modelLibrary 调用 LLM
 * - 危险操作（移动/删除）默认 dry-run，需 confirm=true 才执行
 * - 所有路径受 security-config.matchSensitivePath 保护
 */

import * as fs from 'fs';
import * as path from 'path';
import { errMsg, type UnifiedToolDef } from '../../core/unified-tool-def.js';
import { matchSensitivePath } from '../../core/security-config.js';
import { toolContext } from './tool-context.js';

// ============ 辅助函数 ============

async function pathExists(p: string): Promise<boolean> {
  try { await fs.promises.access(p); return true; } catch { return false; }
}

function guardSensitivePath(p: string): string | null {
  if (matchSensitivePath(p)) {
    return `❌ 拒绝访问敏感路径: ${p}`;
  }
  return null;
}

/** 调用 LLM 生成内容（统一入口） */
async function callLLM(prompt: string, systemPrompt?: string): Promise<string> {
  const ml = toolContext.modelLibrary;
  if (!ml || typeof ml.call !== 'function') {
    throw new Error('ModelLibrary 未初始化，无法进行文档内容生成');
  }
  const messages: Array<{ role: 'system' | 'user'; content: string }> = [];
  if (systemPrompt) messages.push({ role: 'system', content: systemPrompt });
  messages.push({ role: 'user', content: prompt });
  const resp = await ml.call(messages);
  return resp.content || '';
}

/** 按扩展名归类 */
function classifyByExtension(ext: string): string {
  const e = ext.toLowerCase().replace(/^\./, '');
  if (['doc', 'docx', 'rtf', 'odt', 'wps'].includes(e)) return '文档/Word';
  if (['xls', 'xlsx', 'csv', 'ods'].includes(e)) return '文档/表格';
  if (['ppt', 'pptx', 'pps'].includes(e)) return '文档/演示';
  if (['pdf'].includes(e)) return '文档/PDF';
  if (['txt', 'md', 'markdown'].includes(e)) return '文档/文本';
  if (['jpg', 'jpeg', 'png', 'gif', 'bmp', 'webp', 'tiff', 'svg'].includes(e)) return '图片';
  if (['mp4', 'avi', 'mov', 'mkv', 'wmv', 'flv'].includes(e)) return '视频';
  if (['mp3', 'wav', 'flac', 'aac', 'ogg'].includes(e)) return '音频';
  if (['zip', 'rar', '7z', 'tar', 'gz', 'bz2'].includes(e)) return '压缩包';
  if (['js', 'ts', 'py', 'java', 'go', 'rs', 'c', 'cpp', 'h', 'cs', 'rb', 'php'].includes(e)) return '代码';
  if (['json', 'xml', 'yaml', 'yml', 'toml', 'ini', 'conf'].includes(e)) return '配置';
  if (['exe', 'msi', 'dmg', 'deb', 'rpm', 'app'].includes(e)) return '程序';
  return '其他';
}

/** 安全移动文件（跨目录用 copy+unlink） */
async function safeMove(src: string, destDir: string): Promise<string> {
  const basename = path.basename(src);
  let dest = path.join(destDir, basename);
  // 处理重名
  if (await pathExists(dest)) {
    const ext = path.extname(basename);
    const stem = path.basename(basename, ext);
    let i = 1;
    while (await pathExists(path.join(destDir, `${stem} (${i})${ext}`))) i++;
    dest = path.join(destDir, `${stem} (${i})${ext}`);
  }
  await fs.promises.mkdir(destDir, { recursive: true });
  try {
    await fs.promises.rename(src, dest);
  } catch {
    // 跨盘符 rename 会失败，降级为 copy+unlink
    await fs.promises.copyFile(src, dest);
    await fs.promises.unlink(src);
  }
  return dest;
}

// ============ 工具定义 ============

export const documentTools: UnifiedToolDef[] = [
  // ---------------- 文件分类与整理 ----------------
  {
    name: 'file_classify',
    description: '扫描指定目录下的文件并按维度(类型/日期/扩展名)分类统计。不移动文件，仅返回分类报告。维度: by_type(按类型)/by_date(按年月)/by_ext(按扩展名)。',
    readOnly: true,
    parameters: {
      directory: { type: 'string', description: '要扫描的目录路径', required: true },
      dimension: { type: 'string', description: '分类维度: by_type/by_date/by_ext，默认 by_type', required: false },
      recursive: { type: 'string', description: '是否递归子目录: true/false，默认 true', required: false },
    },
    execute: async (args) => {
      const dir = args.directory as string;
      const guard = guardSensitivePath(dir);
      if (guard) return guard;
      if (!(await pathExists(dir))) return `❌ 目录不存在: ${dir}`;
      const dimension = (args.dimension as string) || 'by_type';
      const recursive = (args.recursive as string) !== 'false';

      const files = await collectFiles(dir, recursive);
      if (files.length === 0) return `📂 目录 "${dir}" 下没有文件`;

      const groups: Record<string, string[]> = {};
      for (const f of files) {
        let key: string;
        if (dimension === 'by_ext') {
          key = path.extname(f).toLowerCase() || '(无扩展名)';
        } else if (dimension === 'by_date') {
          try {
            const stat = await fs.promises.stat(f);
            const d = new Date(stat.mtime);
            key = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}`;
          } catch { key = '未知日期'; }
        } else {
          key = classifyByExtension(path.extname(f));
        }
        if (!groups[key]) groups[key] = [];
        groups[key].push(path.basename(f));
      }

      const sortedKeys = Object.keys(groups).sort((a, b) => groups[b].length - groups[a].length);
      let report = `📊 **文件分类报告** — "${dir}"\n`;
      report += `分类维度: ${dimension} | 文件总数: ${files.length} | 类别数: ${sortedKeys.length}\n`;
      report += `${'─'.repeat(50)}\n`;
      for (const k of sortedKeys) {
        report += `📁 ${k} (${groups[k].length} 个)\n`;
        const preview = groups[k].slice(0, 5).map(n => `   • ${n}`).join('\n');
        report += `${preview}\n`;
        if (groups[k].length > 5) report += `   ... 及其他 ${groups[k].length - 5} 个\n`;
      }
      report += `\n💡 提示: 使用 file_organize 工具可以按分类结果自动整理归档。`;
      return report;
    },
  },

  {
    name: 'file_organize',
    description: '智能整理目录文件，按指定维度(类型/日期/项目)自动归档到子目录。**默认 dry-run 预览，需 confirm=true 才真正执行移动**。维度: by_type(按类型)/by_date(按年月)/by_project(按关键词识别项目)。',
    readOnly: false,
    parameters: {
      directory: { type: 'string', description: '要整理的目录', required: true },
      dimension: { type: 'string', description: '归档维度: by_type/by_date/by_project，默认 by_type', required: false },
      targetDir: { type: 'string', description: '归档目标目录(默认在原目录下创建 _organized)', required: false },
      confirm: { type: 'string', description: 'true 才真正执行移动，否则只预览', required: false },
      projectKeywords: { type: 'string', description: 'by_project 模式下的项目关键词(JSON数组，如 ["报告","发票","合同"])', required: false },
    },
    execute: async (args) => {
      const dir = args.directory as string;
      const guard = guardSensitivePath(dir);
      if (guard) return guard;
      if (!(await pathExists(dir))) return `❌ 目录不存在: ${dir}`;

      const dimension = (args.dimension as string) || 'by_type';
      const targetBase = (args.targetDir as string) || path.join(dir, '_organized');
      const confirm = args.confirm === 'true';
      let projectKeywords: string[] = [];
      if (args.projectKeywords) {
        try { projectKeywords = JSON.parse(args.projectKeywords as string); } catch { /* ignore */ }
      }

      const files = await collectFiles(dir, false);
      if (files.length === 0) return `📂 目录 "${dir}" 下没有需要整理的文件`;

      const plan: Array<{ src: string; dest: string; reason: string }> = [];
      for (const f of files) {
        const ext = path.extname(f);
        const basename = path.basename(f).toLowerCase();
        let subDir = '';
        let reason = '';

        if (dimension === 'by_type') {
          subDir = classifyByExtension(ext);
          reason = `扩展名 ${ext} → ${subDir}`;
        } else if (dimension === 'by_date') {
          try {
            const stat = await fs.promises.stat(f);
            const d = new Date(stat.mtime);
            subDir = path.join(`${d.getFullYear()}`, `${String(d.getMonth() + 1).padStart(2, '0')}`);
            reason = `修改时间 ${d.toISOString().slice(0, 10)}`;
          } catch { subDir = '未知日期'; reason = '无法读取时间'; }
        } else if (dimension === 'by_project') {
          let matched = '';
          for (const kw of projectKeywords) {
            if (basename.includes(kw.toLowerCase())) { matched = kw; break; }
          }
          subDir = matched || '未分类';
          reason = matched ? `文件名含关键词 "${matched}"` : '无匹配关键词';
        }
        const destDir = path.join(targetBase, subDir);
        plan.push({ src: f, dest: path.join(destDir, path.basename(f)), reason });
      }

      if (!confirm) {
        let preview = `🔍 **整理预览** (dry-run，未实际移动)\n`;
        preview += `源目录: ${dir}\n目标根: ${targetBase}\n维度: ${dimension}\n待整理: ${plan.length} 个文件\n${'─'.repeat(50)}\n`;
        for (const p of plan.slice(0, 20)) {
          preview += `📄 ${path.basename(p.src)}\n   → ${p.dest}\n   (${p.reason})\n`;
        }
        if (plan.length > 20) preview += `... 及其他 ${plan.length - 20} 个\n`;
        preview += `\n✅ 确认无误后，调用本工具并设置 confirm="true" 执行整理。`;
        return preview;
      }

      let moved = 0;
      const errors: string[] = [];
      for (const p of plan) {
        try {
          await safeMove(p.src, path.dirname(p.dest));
          moved++;
        } catch (err) {
          errors.push(`${path.basename(p.src)}: ${err instanceof Error ? err.message : String(err)}`);
        }
      }
      let result = `✅ 整理完成: 成功移动 ${moved}/${plan.length} 个文件\n`;
      result += `归档目录: ${targetBase}\n`;
      if (errors.length > 0) {
        result += `\n❌ 失败 ${errors.length} 个:\n${errors.slice(0, 10).map(e => `   • ${e}`).join('\n')}\n`;
      }
      return result;
    },
  },

  // ---------------- 文档汇总 ----------------
  {
    name: 'doc_summarize',
    description: '汇总多个文档的内容，提取关键信息并结构化呈现。支持读取 txt/md/json/code 等文本文件，对 docx/xlsx/pdf 等二进制格式提取文件元数据。输出统一的 Markdown 汇总报告。',
    readOnly: true,
    parameters: {
      paths: { type: 'string', description: '文档路径(JSON数组，如 ["a.txt","b.md","report.pdf"])', required: true },
      focus: { type: 'string', description: '汇总重点(可选，如"项目进展/财务数据/技术方案")', required: false },
      maxCharsPerDoc: { type: 'string', description: '每个文档最多读取字符数，默认 8000', required: false },
    },
    execute: async (args) => {
      let paths: string[] = [];
      try { paths = JSON.parse(args.paths as string); } catch { return '❌ paths 必须是 JSON 数组'; }
      if (!Array.isArray(paths) || paths.length === 0) return '❌ paths 不能为空';

      const focus = (args.focus as string) || '';
      const maxChars = parseInt(args.maxCharsPerDoc as string) || 8000;

      const docInfos: Array<{ path: string; content: string; meta: string }> = [];
      for (const p of paths) {
        const guard = guardSensitivePath(p);
        if (guard) return guard;
        if (!(await pathExists(p))) {
          docInfos.push({ path: p, content: '', meta: '(文件不存在)' });
          continue;
        }
        const ext = path.extname(p).toLowerCase().replace(/^\./, '');
        const textExts = ['txt', 'md', 'markdown', 'json', 'xml', 'yaml', 'yml', 'csv', 'js', 'ts', 'py', 'java', 'go', 'html', 'css', 'log', 'ini', 'conf'];
        if (textExts.includes(ext)) {
          try {
            const raw = await fs.promises.readFile(p, 'utf-8');
            const content = raw.length > maxChars ? raw.substring(0, maxChars) + '\n...(截断)' : raw;
            const stat = await fs.promises.stat(p);
            docInfos.push({ path: p, content, meta: `${ext} | ${stat.size} bytes | ${new Date(stat.mtime).toLocaleDateString()}` });
          } catch (err) {
            docInfos.push({ path: p, content: '', meta: `读取失败: ${err instanceof Error ? err.message : String(err)}` });
          }
        } else {
          // 二进制文件：仅提取元数据
          try {
            const stat = await fs.promises.stat(p);
            docInfos.push({ path: p, content: '', meta: `${ext || '无扩展名'} | ${stat.size} bytes | ${new Date(stat.mtime).toLocaleDateString()} (二进制，内容需专用工具)` });
          } catch (err) {
            docInfos.push({ path: p, content: '', meta: `元数据读取失败: ${err instanceof Error ? err.message : String(err)}` });
          }
        }
      }

      // 调用 LLM 生成汇总
      const docBlock = docInfos.map((d, i) =>
        `### 文档 ${i + 1}: ${path.basename(d.path)}\n路径: ${d.path}\n元数据: ${d.meta}\n内容:\n${d.content || '(无文本内容)'}`
      ).join('\n\n---\n\n');

      const prompt = `请汇总以下 ${docInfos.length} 个文档的关键信息${focus ? `，重点关注: ${focus}` : ''}。

${docBlock}

要求：
1. 用 Markdown 格式输出
2. 包含: 概述/关键信息/数据对比/建议
3. 跨文档交叉对比，发现关联与差异
4. 标注信息来源(文档编号)
5. 不超过 1500 字`;

      try {
        const summary = await callLLM(prompt, '你是专业的文档分析师，擅长多源信息整合与结构化呈现。');
        return `📋 **文档汇总报告** (${docInfos.length} 个文档${focus ? ` | 重点: ${focus}` : ''})\n${'─'.repeat(50)}\n\n${summary}`;
      } catch (err) {
        // LLM 失败时降级为原始拼接
        return `📋 **文档汇总** (LLM 调用失败，降级为原始拼接): ${errMsg(err)}\n${'─'.repeat(50)}\n\n${docBlock}`;
      }
    },
  },

  // ---------------- 表单填写 ----------------
  {
    name: 'form_fill',
    description: '基于模板和数据自动填充表单字段。支持两种模式: (1) template 模式——提供模板文件路径+数据JSON，按 {{key}} 占位符替换生成结果文件；(2) detect 模式——提供已有表单文件路径+数据JSON，通过 LLM 识别字段并生成填充建议。',
    readOnly: false,
    parameters: {
      mode: { type: 'string', description: 'template: 用模板生成新文件; detect: 识别已有表单字段', required: true },
      templatePath: { type: 'string', description: 'template 模式必填: 模板文件路径(含 {{key}} 占位符)', required: false },
      formPath: { type: 'string', description: 'detect 模式必填: 已有表单文件路径', required: false },
      data: { type: 'string', description: '填充数据 JSON 字符串，如 {"name":"张三","date":"2026-07-02"}', required: true },
      outputPath: { type: 'string', description: 'template 模式输出文件路径，默认在模板同目录加 _filled 后缀', required: false },
    },
    execute: async (args) => {
      const mode = args.mode as string;
      let data: Record<string, unknown>;
      try { data = JSON.parse(args.data as string); } catch { return '❌ data 必须是有效 JSON'; }

      if (mode === 'template') {
        const tplPath = args.templatePath as string;
        if (!tplPath) return '❌ template 模式需要 templatePath';
        const guard = guardSensitivePath(tplPath);
        if (guard) return guard;
        if (!(await pathExists(tplPath))) return `❌ 模板不存在: ${tplPath}`;

        let tplContent: string;
        try { tplContent = await fs.promises.readFile(tplPath, 'utf-8'); } catch (err) { return `❌ 读取模板失败: ${errMsg(err)}`; }

        // 替换 {{key}} 占位符
        let filled = tplContent;
        const missing: string[] = [];
        const placeholders = tplContent.match(/\{\{(\w+)\}\}/g) || [];
        const keys = [...new Set(placeholders.map(p => p.replace(/[{}]/g, '')))];
        for (const k of keys) {
          if (data[k] !== undefined) {
            filled = filled.split(`{{${k}}}`).join(String(data[k]));
          } else {
            missing.push(k);
            filled = filled.split(`{{${k}}}`).join(`[未提供:${k}]`);
          }
        }

        const outPath = (args.outputPath as string) || tplPath.replace(/(\.[^.]+)$/, '_filled$1');
        const outGuard = guardSensitivePath(outPath);
        if (outGuard) return outGuard;
        await fs.promises.writeFile(outPath, filled, 'utf-8');

        let result = `✅ 表单已填充: ${outPath}\n`;
        result += `模板字段: ${keys.length} 个 | 已填充: ${keys.length - missing.length} | 未提供: ${missing.length}\n`;
        if (missing.length > 0) result += `⚠️ 缺失字段: ${missing.join(', ')}\n`;
        return result;
      }

      if (mode === 'detect') {
        const formPath = args.formPath as string;
        if (!formPath) return '❌ detect 模式需要 formPath';
        const guard = guardSensitivePath(formPath);
        if (guard) return guard;
        if (!(await pathExists(formPath))) return `❌ 表单文件不存在: ${formPath}`;

        let formContent = '';
        try { formContent = await fs.promises.readFile(formPath, 'utf-8'); } catch (err) { return `❌ 读取失败: ${errMsg(err)}`; }
        if (formContent.length > 6000) formContent = formContent.substring(0, 6000) + '\n...(截断)';

        const prompt = `分析以下表单文件内容，识别所有可填写的字段。

表单内容:
${formContent}

填充数据(JSON):
${JSON.stringify(data, null, 2)}

要求：
1. 列出识别到的字段名、类型(text/number/date/select/checkbox)、当前位置或上下文
2. 给出每个字段的填充值建议
3. 用 Markdown 表格输出: | 字段 | 类型 | 当前值 | 建议值 |`;

        try {
          const analysis = await callLLM(prompt, '你是表单识别专家，擅长从各类文档中提取可填写字段。');
          return `📋 **表单字段识别与填充建议**\n表单: ${formPath}\n${'─'.repeat(50)}\n\n${analysis}\n\n💡 提示: 识别结果可指导你用 file_edit 工具直接修改表单文件。`;
        } catch (err) {
          return `❌ LLM 分析失败: ${errMsg(err)}`;
        }
      }

      return '❌ mode 必须是 template 或 detect';
    },
  },

  // ---------------- 文档优化 ----------------
  {
    name: 'document_optimize',
    description: '优化文档内容，支持: format(格式统一:标题层级/列表/缩进)/polish(内容润色:用词/流畅度)/layout(排版美化:段落/留白/分段)。输入为文件路径，直接修改原文件(可选 backup=true 保留备份)。',
    readOnly: false,
    parameters: {
      filePath: { type: 'string', description: '要优化的文档路径(支持 md/txt)', required: true },
      mode: { type: 'string', description: '优化模式: format/polish/layout/all(全部)，默认 all', required: false },
      backup: { type: 'string', description: '是否备份原文件: true/false，默认 true', required: false },
      style: { type: 'string', description: '风格偏好(可选): formal(正式)/casual(轻松)/concise(简洁)', required: false },
    },
    execute: async (args) => {
      const filePath = args.filePath as string;
      const guard = guardSensitivePath(filePath);
      if (guard) return guard;
      if (!(await pathExists(filePath))) return `❌ 文件不存在: ${filePath}`;

      const ext = path.extname(filePath).toLowerCase();
      const textExts = ['.md', '.markdown', '.txt', '.rst', '.adoc'];
      if (!textExts.includes(ext)) return `❌ 当前仅支持文本类文档(${textExts.join('/')})，不支持 ${ext}`;

      let content: string;
      try { content = await fs.promises.readFile(filePath, 'utf-8'); } catch (err) { return `❌ 读取失败: ${errMsg(err)}`; }
      if (!content.trim()) return '❌ 文件内容为空';

      const mode = (args.mode as string) || 'all';
      const style = (args.style as string) || 'formal';

      const modeDesc: Record<string, string> = {
        format: '格式统一: 规范标题层级、列表符号、代码块缩进',
        polish: `内容润色: 用词精准、语句流畅、风格${style}`,
        layout: '排版美化: 合理分段、控制段落长度、优化留白',
      };
      const tasks = mode === 'all' ? Object.values(modeDesc) : [modeDesc[mode] || modeDesc.all];

      const prompt = `优化以下 Markdown/文本文档。

优化任务:
${tasks.map((t, i) => `${i + 1}. ${t}`).join('\n')}

要求:
- 保持原文核心信息，不增删事实
- 直接输出优化后的完整文档内容(不要加说明或代码块包裹)
- 保持原扩展名兼容的语法

原文:
${content}`;

      let optimized: string;
      try { optimized = await callLLM(prompt, '你是专业的文档编辑，擅长格式规范、内容润色与排版优化。'); }
      catch (err) { return `❌ LLM 优化失败: ${errMsg(err)}`; }

      if (!optimized.trim()) return '❌ 优化结果为空，未做修改';

      // 备份
      if (args.backup !== 'false') {
        const backupPath = `${filePath}.backup.${Date.now()}`;
        try { await fs.promises.copyFile(filePath, backupPath); } catch { /* 备份失败不阻断 */ }
      }

      try { await fs.promises.writeFile(filePath, optimized, 'utf-8'); }
      catch (err) { return `❌ 写入失败: ${errMsg(err)}`; }

      const sizeBefore = content.length;
      const sizeAfter = optimized.length;
      const delta = sizeAfter - sizeBefore;
      return `✅ 文档已优化: ${filePath}\n模式: ${mode} | 风格: ${style}\n字数变化: ${sizeBefore} → ${sizeAfter} (${delta >= 0 ? '+' : ''}${delta})\n备份: ${args.backup !== 'false' ? '已保留' : '未备份'}`;
    },
  },
];

// ============ 工具函数 ============

/** 递归收集目录下所有文件(跳过 _organized 等归档目录) */
async function collectFiles(dir: string, recursive: boolean): Promise<string[]> {
  const result: string[] = [];
  const entries = await fs.promises.readdir(dir, { withFileTypes: true });
  for (const e of entries) {
    const full = path.join(dir, e.name);
    // 跳过归档目录自身，避免循环
    if (e.isDirectory()) {
      if (recursive && !e.name.startsWith('_') && !e.name.startsWith('.')) {
        result.push(...await collectFiles(full, recursive));
      }
    } else if (e.isFile()) {
      result.push(full);
    }
  }
  return result;
}
