/**
 * 智能PPT生成工具集 — PPTTools
 *
 * 覆盖能力：
 * 1. 大纲生成（基于主题/文档自动产出 PPT 大纲）
 * 2. 内容智能填充（从文档/数据提取关键信息生成各页文案）
 * 3. PPT 美化（配色方案/版式统一/动画建议）
 * 4. PPT 操作（通过 PowerPoint profile 调用桌面自动化）
 *
 * 设计原则：
 * - 大纲/内容/美化通过 LLM 生成结构化 JSON
 * - 实际 PPT 文件制作通过 UniversalDesktop powerpoint profile 的 workflow
 * - 支持纯 Markdown 大纲输出（不依赖 PPT 应用）+ 桌面自动化两种模式
 */

import * as fs from 'fs';
import * as path from 'path';
import { errMsg, type UnifiedToolDef } from '../../core/unified-tool-def.js';
import { toolContext } from './tool-context.js';
import { atomicWriteJson } from '../../core/atomic-write.js';

// ============ 辅助函数 ============

async function pathExists(p: string): Promise<boolean> {
  try { await fs.promises.access(p); return true; } catch { return false; }
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

// ============ 类型定义 ============

interface SlideOutline {
  title: string;
  bulletPoints: string[];
  layout: 'title' | 'content' | 'two_column' | 'image_text' | 'chart' | 'section' | 'closing';
  notes?: string;
  speakerNotes?: string;
}

interface PPTDesign {
  theme: {
    primaryColor: string;
    secondaryColor: string;
    accentColor: string;
    backgroundColor: string;
    fontTitle: string;
    fontBody: string;
  };
  layout: string;
  animations: Array<{ slide: number; element: string; type: string }>;
  consistency: string;
}

// ============ 工具定义 ============

export const pptTools: UnifiedToolDef[] = [
  // ---------------- PPT 大纲生成 ----------------
  {
    name: 'ppt_outline',
    description: '根据主题或源文档生成 PPT 大纲。支持两种输入: (1) topic 模式——给定主题+页数，从零生成大纲；(2) doc 模式——给定文档路径，提取要点生成大纲。输出结构化 JSON + Markdown 大纲。',
    readOnly: true,
    parameters: {
      mode: { type: 'string', description: 'topic: 按主题生成; doc: 按源文档生成', required: true },
      topic: { type: 'string', description: 'topic 模式必填: PPT 主题(如"2026年度产品规划")', required: false },
      docPath: { type: 'string', description: 'doc 模式必填: 源文档路径(txt/md)', required: false },
      slideCount: { type: 'string', description: '期望页数，默认 10', required: false },
      audience: { type: 'string', description: '目标受众(如"管理层/技术团队/客户")，影响内容深度', required: false },
      outputPath: { type: 'string', description: '大纲输出文件路径(可选，默认仅返回不保存)', required: false },
    },
    execute: async (args) => {
      const mode = args.mode as string;
      const slideCount = parseInt(args.slideCount as string) || 10;
      const audience = (args.audience as string) || '通用受众';

      let sourceContent = '';
      if (mode === 'topic') {
        const topic = args.topic as string;
        if (!topic) return '❌ topic 模式需要 topic 参数';
        sourceContent = `主题: ${topic}`;
      } else if (mode === 'doc') {
        const docPath = args.docPath as string;
        if (!docPath) return '❌ doc 模式需要 docPath';
        if (!(await pathExists(docPath))) return `❌ 文档不存在: ${docPath}`;
        try {
          sourceContent = await fs.promises.readFile(docPath, 'utf-8');
          if (sourceContent.length > 8000) sourceContent = sourceContent.substring(0, 8000) + '\n...(截断)';
        } catch (err) { return `❌ 读取文档失败: ${errMsg(err)}`; }
      } else {
        return '❌ mode 必须是 topic 或 doc';
      }

      const prompt = `基于以下内容生成一份 ${slideCount} 页的 PPT 大纲。

源内容:
${sourceContent}

目标受众: ${audience}
期望页数: ${slideCount}

输出 JSON 格式（不要代码块包裹）:
{
  "title": "PPT 总标题",
  "subtitle": "副标题",
  "slides": [
    {
      "title": "页面标题",
      "bulletPoints": ["要点1", "要点2", "要点3"],
      "layout": "title|content|two_column|image_text|chart|section|closing",
      "notes": "页面设计备注(图片/图表建议)",
      "speakerNotes": "演讲者备注"
    }
  ]
}

要求:
1. 首页用 title 布局，末页用 closing 布局
2. 中间页合理使用 content/two_column/image_text/chart
3. 每页 3-5 个要点，简洁有力
4. 逻辑递进: 引言→分析→方案→总结`;

      let outline: { title?: string; subtitle?: string; slides?: SlideOutline[] };
      try {
        const outlineStr = await callLLM(prompt, '你是专业的演示文稿策划师，擅长结构化表达与信息架构。');
        const jsonMatch = outlineStr.match(/\{[\s\S]*\}/);
        outline = jsonMatch ? JSON.parse(jsonMatch[0]) : { title: '生成失败', slides: [] };
      } catch (err) {
        return `❌ 大纲生成失败: ${errMsg(err)}`;
      }

      // 格式化输出
      let report = `📋 **PPT 大纲**\n`;
      report += `标题: ${outline.title || '未命名'} | 副标题: ${outline.subtitle || ''} | 页数: ${outline.slides?.length || 0} | 受众: ${audience}\n${'─'.repeat(50)}\n\n`;

      const slides = outline.slides || [];
      for (let i = 0; i < slides.length; i++) {
        const s = slides[i];
        report += `### 第 ${i + 1} 页 [${s.layout}]: ${s.title}\n`;
        for (const bp of (s.bulletPoints || [])) report += `   • ${bp}\n`;
        if (s.notes) report += `   💡 设计: ${s.notes}\n`;
        if (s.speakerNotes) report += `   🎤 备注: ${s.speakerNotes}\n`;
        report += '\n';
      }

      // 可选保存
      const outputPath = args.outputPath as string;
      if (outputPath) {
        try {
          await atomicWriteJson(outputPath, outline);
          report += `\n✅ 大纲已保存: ${outputPath}`;
        } catch (err) {
          report += `\n⚠️ 保存失败: ${errMsg(err)}`;
        }
      }

      report += `\n💡 提示: 使用 ppt_create 工具可自动创建 PPT 文件，ppt_beautify 可优化配色与版式。`;
      return report;
    },
  },

  // ---------------- PPT 创建（桌面自动化）----------------
  {
    name: 'ppt_create',
    description: '基于大纲自动创建 PowerPoint 文件。通过桌面自动化调用 PowerPoint：新建演示文稿 → 逐页添加标题与内容 → 保存。需 PowerPoint 已安装。',
    readOnly: false,
    parameters: {
      outlinePath: { type: 'string', description: 'ppt_outline 生成的大纲 JSON 文件路径', required: true },
      outputPath: { type: 'string', description: 'PPT 输出路径(如 D:/report.pptx)，默认 ./output.pptx', required: false },
      template: { type: 'string', description: '模板名(可选): 使用 PowerPoint 内置模板', required: false },
    },
    execute: async (args) => {
      const outlinePath = args.outlinePath as string;
      if (!(await pathExists(outlinePath))) return `❌ 大纲文件不存在: ${outlinePath}`;

      let outline: { title?: string; subtitle?: string; slides?: SlideOutline[] };
      try {
        outline = JSON.parse(await fs.promises.readFile(outlinePath, 'utf-8'));
      } catch (err) { return `❌ 解析大纲失败: ${errMsg(err)}`; }

      const slides = outline.slides || [];
      if (slides.length === 0) return '❌ 大纲无 slides';

      const { UniversalDesktop } = await import('../../core/universal-desktop.js');
      const desktop = new UniversalDesktop(toolContext.modelLibrary);

      // 1. 启动 PowerPoint
      const launchR = await desktop.executeOperation({ app: 'powerpoint', action: 'launch', params: {} });
      if (!launchR.success) return `❌ PowerPoint 启动失败: ${launchR.error}\n请确认 PowerPoint 已安装。`;
      await new Promise(r => setTimeout(r, 2000));

      // 2. 新建演示文稿
      await desktop.executeOperation({
        app: 'powerpoint', action: 'workflow',
        params: { workflowName: '新建演示文稿', params: {} },
      });
      await new Promise(r => setTimeout(r, 1500));

      // 3. 逐页填充
      const stepResults: string[] = [];
      for (let i = 0; i < slides.length; i++) {
        const s = slides[i];
        try {
          // 首页：标题页
          if (i === 0) {
            // 输入标题
            await desktop.executeOperation({
              app: 'powerpoint', action: 'type',
              params: { text: s.title },
            });
            await new Promise(r => setTimeout(r, 500));
          } else {
            // 添加新幻灯片
            await desktop.executeOperation({
              app: 'powerpoint', action: 'workflow',
              params: { workflowName: '添加幻灯片', params: {} },
            });
            await new Promise(r => setTimeout(r, 800));
            // 输入标题
            await desktop.executeOperation({
              app: 'powerpoint', action: 'type',
              params: { text: s.title },
            });
            await new Promise(r => setTimeout(r, 500));
            // 输入要点
            const bullets = (s.bulletPoints || []).join('\n');
            if (bullets) {
              await desktop.executeOperation({
                app: 'powerpoint', action: 'type',
                params: { text: bullets },
              });
              await new Promise(r => setTimeout(r, 500));
            }
          }
          stepResults.push(`✅ 第 ${i + 1} 页: ${s.title}`);
        } catch (err) {
          stepResults.push(`❌ 第 ${i + 1} 页失败: ${err instanceof Error ? err.message : String(err)}`);
        }
      }

      // 4. 保存
      const outputPath = (args.outputPath as string) || './output.pptx';
      try {
        // Ctrl+S 保存
        await desktop.executeOperation({
          app: 'powerpoint', action: 'shortcut',
          params: { shortcutName: '保存' },
        });
        await new Promise(r => setTimeout(r, 1000));
      } catch { /* 忽略保存错误 */ }

      let report = `📊 **PPT 创建报告**\n`;
      report += `大纲: ${outlinePath} | 页数: ${slides.length} | 输出: ${outputPath}\n${'─'.repeat(50)}\n`;
      report += stepResults.join('\n');
      report += `\n\n💡 提示: PPT 已在 PowerPoint 中打开，请手动检查并保存到指定路径。使用 ppt_beautify 可进一步美化。`;
      return report;
    },
  },

  // ---------------- PPT 美化 ----------------
  {
    name: 'ppt_beautify',
    description: '生成 PPT 美化方案: 配色方案/版式建议/动画效果/字体规范。可基于现有大纲 JSON 或直接描述 PPT 内容。返回结构化美化方案 + 应用指令。',
    readOnly: true,
    parameters: {
      outlinePath: { type: 'string', description: '大纲 JSON 路径(可选，若提供则基于内容定制)', required: false },
      topic: { type: 'string', description: '若不提供大纲，可提供主题描述', required: false },
      style: { type: 'string', description: '风格: business(商务)/tech(科技)/creative(创意)/academic(学术)/festival(节日)，默认 business', required: false },
    },
    execute: async (args) => {
      const style = (args.style as string) || 'business';
      let context = '';

      const outlinePath = args.outlinePath as string;
      if (outlinePath && await pathExists(outlinePath)) {
        try {
          const outline = JSON.parse(await fs.promises.readFile(outlinePath, 'utf-8'));
          context = `PPT 标题: ${outline.title || ''}\n副标题: ${outline.subtitle || ''}\n页数: ${outline.slides?.length || 0}\n`;
          context += `各页标题: ${(outline.slides || []).map((s: SlideOutline, i: number) => `\n${i + 1}. ${s.title} [${s.layout}]`).join('')}`;
        } catch { /* ignore */ }
      } else if (args.topic) {
        context = `主题: ${args.topic}`;
      } else {
        return '❌ 请提供 outlinePath 或 topic';
      }

      const styleMap: Record<string, string> = {
        business: '商务专业: 深蓝/灰白主色，无衬线字体，简洁几何',
        tech: '科技未来: 深色背景，霓虹蓝紫渐变，等宽字体',
        creative: '创意活泼: 撞色搭配，不规则形状，手写体点缀',
        academic: '学术严谨: 黑白灰，衬线字体，结构清晰',
        festival: '节日喜庆: 红金主色，传统纹样，圆润字体',
      };

      const prompt = `为以下 PPT 生成 ${styleMap[style] || styleMap.business} 的美化方案。

PPT 信息:
${context}

输出 JSON 格式（不要代码块包裹）:
{
  "theme": {
    "primaryColor": "#hex (主色)",
    "secondaryColor": "#hex (辅色)",
    "accentColor": "#hex (强调色)",
    "backgroundColor": "#hex (背景色)",
    "fontTitle": "标题字体",
    "fontBody": "正文字体"
  },
  "layout": "整体版式建议(留白/对齐/网格)",
  "animations": [
    {"slide": 1, "element": "标题", "type": "淡入"},
    {"slide": 2, "element": "要点列表", "type": "逐项显示"}
  ],
  "consistency": "一致性规范(字号层级/颜色用法/图标风格)"
}`;

      let design: PPTDesign;
      try {
        const designStr = await callLLM(prompt, '你是资深 PPT 设计师，擅长配色、版式与动画设计。');
        const jsonMatch = designStr.match(/\{[\s\S]*\}/);
        design = jsonMatch ? JSON.parse(jsonMatch[0]) : { theme: { primaryColor: '#1F4E79', secondaryColor: '#2E75B6', accentColor: '#FFC000', backgroundColor: '#FFFFFF', fontTitle: '微软雅黑', fontBody: '微软雅黑' }, layout: '', animations: [], consistency: '' };
      } catch (err) {
        return `❌ 美化方案生成失败: ${errMsg(err)}`;
      }

      let report = `🎨 **PPT 美化方案** | 风格: ${style}\n${'─'.repeat(50)}\n\n`;
      report += `**主题配色**\n`;
      report += `   • 主色: ${design.theme?.primaryColor}\n`;
      report += `   • 辅色: ${design.theme?.secondaryColor}\n`;
      report += `   • 强调色: ${design.theme?.accentColor}\n`;
      report += `   • 背景: ${design.theme?.backgroundColor}\n`;
      report += `   • 标题字体: ${design.theme?.fontTitle}\n`;
      report += `   • 正文字体: ${design.theme?.fontBody}\n\n`;
      report += `**版式建议**: ${design.layout || '未指定'}\n\n`;
      if (design.animations && design.animations.length > 0) {
        report += `**动画方案**\n`;
        for (const a of design.animations) {
          report += `   • 第 ${a.slide} 页 ${a.element}: ${a.type}\n`;
        }
        report += '\n';
      }
      report += `**一致性规范**: ${design.consistency || '未指定'}\n\n`;
      report += `💡 应用提示:\n`;
      report += `   1. 在 PowerPoint 中用"设计"→"变体"→"颜色"应用配色\n`;
      report += `   2. 用"设计"→"字体"应用字体方案\n`;
      report += `   3. 用"动画"→"淡入"等应用动画效果\n`;
      report += `   4. 或通过 ppt_create 自动化创建时预设主题`;
      return report;
    },
  },

  // ---------------- PPT 内容提取 ----------------
  {
    name: 'ppt_extract',
    description: '从源文档(报告/数据/会议纪要)提取关键信息，生成 PPT 各页内容建议。适合"把这份报告做成 PPT"的场景。',
    readOnly: true,
    parameters: {
      docPath: { type: 'string', description: '源文档路径(txt/md/json)', required: true },
      slideCount: { type: 'string', description: '期望 PPT 页数，默认 8', required: false },
      focus: { type: 'string', description: '提取重点(如"数据结论/行动项/风险点")', required: false },
    },
    execute: async (args) => {
      const docPath = args.docPath as string;
      if (!(await pathExists(docPath))) return `❌ 文档不存在: ${docPath}`;

      let content: string;
      try {
        content = await fs.promises.readFile(docPath, 'utf-8');
        if (content.length > 10000) content = content.substring(0, 10000) + '\n...(截断)';
      } catch (err) { return `❌ 读取失败: ${errMsg(err)}`; }

      const slideCount = parseInt(args.slideCount as string) || 8;
      const focus = (args.focus as string) || '';

      const prompt = `从以下文档中提取关键信息，整理为 ${slideCount} 页 PPT 的内容建议${focus ? `，重点关注: ${focus}` : ''}。

源文档:
${content}

输出 JSON 格式:
{
  "summary": "文档核心摘要(100字内)",
  "keyFindings": ["关键发现1", "关键发现2"],
  "slides": [
    {"page": 1, "title": "页面标题", "content": "页面要点(2-3句话)", "visualSuggestion": "图表/图片建议"}
  ]
}`;

      let extraction: { summary?: string; keyFindings?: string[]; slides?: Array<{ page: number; title: string; content: string; visualSuggestion?: string }> };
      try {
        const str = await callLLM(prompt, '你是专业的信息提取与内容策划专家。');
        const jsonMatch = str.match(/\{[\s\S]*\}/);
        extraction = jsonMatch ? JSON.parse(jsonMatch[0]) : { summary: str };
      } catch (err) {
        return `❌ 提取失败: ${errMsg(err)}`;
      }

      let report = `📥 **PPT 内容提取** | 源: ${path.basename(docPath)}\n${'─'.repeat(50)}\n\n`;
      report += `**核心摘要**: ${extraction.summary || ''}\n\n`;
      if (extraction.keyFindings && extraction.keyFindings.length > 0) {
        report += `**关键发现**:\n`;
        for (const f of extraction.keyFindings) report += `   • ${f}\n`;
        report += '\n';
      }
      if (extraction.slides && extraction.slides.length > 0) {
        report += `**页面内容建议**:\n`;
        for (const s of extraction.slides) {
          report += `\n### 第 ${s.page} 页: ${s.title}\n`;
          report += `   📝 ${s.content}\n`;
          if (s.visualSuggestion) report += `   🖼️ 视觉: ${s.visualSuggestion}\n`;
        }
      }
      report += `\n💡 提示: 将此结果作为 ppt_outline 的输入，可生成完整大纲。`;
      return report;
    },
  },
];
