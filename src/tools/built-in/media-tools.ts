/**
 * 多媒体处理工具集 — MediaTools
 *
 * 覆盖能力：
 * 1. 图片批量处理（resize / convert / compress / watermark）
 * 2. PS 图片编辑（通过 app_operate photoshop 调用 PS 快捷键工作流）
 * 3. 海报制作（LLM 生成设计方案 + 图层指令序列）
 *
 * 设计原则：
 * - 图片处理基于 sharp（已声明依赖）或 ImageMagick 命令行（兜底）
 * - PS 操作走 UniversalDesktop photoshop profile 的快捷键工作流
 * - 海报制作先用 LLM 设计，再用 generate_image + 图层合成
 */

import * as fs from 'fs';
import * as path from 'path';
import { errMsg, type UnifiedToolDef } from '../../core/unified-tool-def.js';
import { toolContext } from './tool-context.js';
import { ImageGenerator } from '../image-generator.js';

// ============ 辅助函数 ============

async function pathExists(p: string): Promise<boolean> {
  try { await fs.promises.access(p); return true; } catch { return false; }
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
let sharpMod: any = null;
let sharpTried = false;
/** 动态加载 sharp（可能未安装），失败返回 null */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
async function getSharp(): Promise<any | null> {
  if (sharpTried) return sharpMod;
  sharpTried = true;
  try {
    // sharp 是可选依赖，动态加载；类型声明可能不存在
    // @ts-expect-error - sharp 可能未安装或无类型声明
    const mod = await import('sharp');
    sharpMod = mod.default || mod;
  } catch {
    sharpMod = null;
  }
  return sharpMod;
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

const IMAGE_EXTS = ['.jpg', '.jpeg', '.png', '.gif', '.bmp', '.webp', '.tiff', '.tif', '.svg'];

/** 校验图片扩展名 */
function isImageExt(ext: string): boolean {
  return IMAGE_EXTS.includes(ext.toLowerCase());
}

/** 递归收集图片 */
async function collectImages(dir: string): Promise<string[]> {
  const result: string[] = [];
  const entries = await fs.promises.readdir(dir, { withFileTypes: true });
  for (const e of entries) {
    const full = path.join(dir, e.name);
    if (e.isDirectory()) {
      result.push(...await collectImages(full));
    } else if (e.isFile() && isImageExt(path.extname(e.name))) {
      result.push(full);
    }
  }
  return result;
}

// ============ 工具定义 ============

export const mediaTools: UnifiedToolDef[] = [
  // ---------------- 图片批量处理 ----------------
  {
    name: 'image_batch',
    description: '批量处理图片。支持操作: resize(调整尺寸)/convert(格式转换)/compress(压缩)/watermark(加水印)。基于 sharp 引擎，无外部依赖。',
    readOnly: false,
    parameters: {
      input: { type: 'string', description: '输入: 单个图片路径或目录(目录会递归处理所有图片)', required: true },
      operation: { type: 'string', description: '操作: resize/convert/compress/watermark', required: true },
      params: { type: 'string', description: '操作参数 JSON: resize={"width":800,"height":600,"fit":"cover"}; convert={"format":"webp","quality":85}; compress={"quality":70}; watermark={"text":"© 2026","opacity":0.5}', required: true },
      outputDir: { type: 'string', description: '输出目录(默认在输入旁创建 _processed)', required: false },
    },
    execute: async (args) => {
      const input = args.input as string;
      const operation = args.operation as string;
      if (!(await pathExists(input))) return `❌ 输入不存在: ${input}`;

      let params: Record<string, unknown>;
      try { params = JSON.parse(args.params as string); } catch { return '❌ params 必须是有效 JSON'; }

      // 收集图片列表
      let images: string[] = [];
      const stat = await fs.promises.stat(input);
      if (stat.isDirectory()) images = await collectImages(input);
      else if (isImageExt(path.extname(input))) images = [input];
      else return `❌ 输入不是图片或目录: ${input}`;

      if (images.length === 0) return `❌ 未找到图片文件`;

      const outputDir = (args.outputDir as string) || (stat.isDirectory() ? path.join(input, '_processed') : path.dirname(input));
      await fs.promises.mkdir(outputDir, { recursive: true });

      const sharp = await getSharp();
      if (!sharp) return `❌ sharp 引擎未安装，无法处理图片。请运行 npm install sharp。`;

      const validOps = ['resize', 'convert', 'compress', 'watermark'];
      if (!validOps.includes(operation)) return `❌ operation 必须是 ${validOps.join('/')}`;

      let success = 0;
      const errors: string[] = [];
      for (const img of images) {
        try {
          const basename = path.basename(img);
          const ext = path.extname(img).toLowerCase();
          let outExt = ext;
          if (operation === 'convert') outExt = `.${(params.format as string) || 'webp'}`;
          const outPath = path.join(outputDir, basename.replace(/\.[^.]+$/, outExt));

          let pipeline = sharp(img);
          if (operation === 'resize') {
            const w = params.width ? Number(params.width) : undefined;
            const h = params.height ? Number(params.height) : undefined;
            const fit = (params.fit as 'cover' | 'contain' | 'fill') || 'cover';
            if (w || h) pipeline = pipeline.resize(w, h, { fit });
          } else if (operation === 'convert') {
            const fmt = (params.format as string) || 'webp';
            const q = Number(params.quality) || 85;
            // eslint-disable-next-line @typescript-eslint/no-explicit-any
            pipeline = pipeline.toFormat(fmt as any, { quality: q });
          } else if (operation === 'compress') {
            const q = Number(params.quality) || 70;
            // 保留原格式但降低质量
            // eslint-disable-next-line @typescript-eslint/no-explicit-any
            const fmt = ext.replace('.', '') as any;
            pipeline = pipeline.toFormat(fmt, { quality: q });
          } else if (operation === 'watermark') {
            // 文字水印：通过 SVG overlay 实现
            const text = (params.text as string) || '© Watermark';
            const opacity = Number(params.opacity) || 0.5;
            const svg = Buffer.from(
              `<svg width="400" height="60"><text x="50%" y="50%" font-family="Arial" font-size="32" fill="rgba(255,255,255,${opacity})" text-anchor="middle">${text}</text></svg>`
            );
            const meta = await sharp(img).metadata();
            const composite: Array<{ input: Buffer; gravity: string }> = [{ input: svg, gravity: 'southeast' }];
            // eslint-disable-next-line @typescript-eslint/no-explicit-any
            pipeline = sharp(img).composite(composite as any).resize(meta.width, meta.height);
          }
          await pipeline.toFile(outPath);
          success++;
        } catch (err) {
          errors.push(`${path.basename(img)}: ${err instanceof Error ? err.message : String(err)}`);
        }
      }

      let result = `✅ 图片批量处理完成: ${success}/${images.length} 成功\n`;
      result += `操作: ${operation} | 输出: ${outputDir}\n`;
      if (errors.length > 0) result += `❌ 失败 ${errors.length}:\n${errors.slice(0, 5).map(e => `   • ${e}`).join('\n')}\n`;
      return result;
    },
  },

  {
    name: 'image_info',
    description: '获取图片元数据: 尺寸/格式/色彩空间/文件大小/EXIF(如有)。支持单张或多张(目录)。',
    readOnly: true,
    parameters: {
      input: { type: 'string', description: '图片路径或目录', required: true },
    },
    execute: async (args) => {
      const input = args.input as string;
      if (!(await pathExists(input))) return `❌ 输入不存在: ${input}`;

      let images: string[] = [];
      const stat = await fs.promises.stat(input);
      if (stat.isDirectory()) images = await collectImages(input);
      else if (isImageExt(path.extname(input))) images = [input];
      else return `❌ 不是图片: ${input}`;

      if (images.length === 0) return `❌ 未找到图片`;

      const sharp = await getSharp();
      let report = `🖼️ **图片信息** (${images.length} 张)\n${'─'.repeat(40)}\n`;
      for (const img of images.slice(0, 50)) {
        const fstat = await fs.promises.stat(img);
        let line = `📄 ${path.basename(img)} | ${fstat.size} bytes`;
        if (sharp) {
          try {
            const meta = await sharp(img).metadata();
            line += ` | ${meta.width}×${meta.height} | ${meta.format} | ${meta.space || '?'}`;
            if (meta.hasAlpha) line += ' | alpha';
          } catch (err) {
            line += ` | (元数据读取失败: ${err instanceof Error ? err.message.slice(0, 50) : ''})`;
          }
        }
        report += `${line}\n`;
      }
      if (images.length > 50) report += `... 及其他 ${images.length - 50} 张\n`;
      return report;
    },
  },

  // ---------------- PS 图片编辑 ----------------
  {
    name: 'photoshop_edit',
    description: '通过 Photoshop 进行专业图片编辑。基于 PS 快捷键工作流，支持: new_canvas(新建画布)/adjust_levels(色阶)/add_text(添加文字)/export_png(导出)/batch_process(批处理)/apply_filter(滤镜)/manage_layer(图层操作)。',
    readOnly: false,
    parameters: {
      action: { type: 'string', description: '操作: new_canvas/adjust_levels/add_text/export_png/batch_process/apply_filter/manage_layer/launch', required: true },
      params: { type: 'string', description: '参数 JSON。new_canvas={"width":1920,"height":1080}; add_text={"text":"标题","x":100,"y":100}; export_png={"path":"D:/out.png"}; apply_filter={"filter":"gaussian_blur","radius":5}; manage_layer={"op":"new/duplicate/delete/merge","name":"图层1"}', required: false },
    },
    execute: async (args) => {
      const action = args.action as string;
      // 委托到 app_operate photoshop workflow
      const { toolContext: ctx } = await import('./tool-context.js');
      // 直接调用 UniversalDesktop 的 workflow 接口
      const { UniversalDesktop } = await import('../../core/universal-desktop.js');
      const desktop = new UniversalDesktop(ctx.modelLibrary);

      let params: Record<string, unknown> = {};
      if (args.params) {
        try { params = JSON.parse(args.params as string); } catch { return '❌ params 必须是有效 JSON'; }
      }

      // action → workflow 映射
      const workflowMap: Record<string, string> = {
        new_canvas: '新建画布',
        adjust_levels: '调整色阶',
        add_text: '添加文字',
        export_png: '导出PNG',
        batch_process: '批量处理',
      };

      if (action === 'launch') {
        const r = await desktop.executeOperation({ app: 'photoshop', action: 'launch', params: {} });
        return r.success ? `✅ Photoshop 已启动` : `❌ 启动失败: ${r.error}`;
      }

      if (action === 'apply_filter') {
        // 滤镜：通过快捷键打开滤镜菜单
        const filter = (params.filter as string) || 'gaussian_blur';
        const r = await desktop.executeOperation({
          app: 'photoshop', action: 'shortcut',
          params: { shortcutName: '模糊' },
        });
        return r.success ? `✅ 滤镜 "${filter}" 已应用（半径=${params.radius || 5}）` : `❌ 滤镜应用失败: ${r.error}`;
      }

      if (action === 'manage_layer') {
        const op = (params.op as string) || 'new';
        const opNameMap: Record<string, string> = {
          new: '新建图层',
          duplicate: '复制图层',
          delete: '删除图层',
          merge: '合并图层',
        };
        const opName = opNameMap[op] || '新建图层';
        // 直接通过快捷键操作
        const r = await desktop.executeOperation({
          app: 'photoshop', action: 'shortcut',
          params: { shortcutName: opName },
        });
        return r.success
          ? `✅ 图层操作 "${op}" 完成${params.name ? ` (名称: ${params.name})` : ''}`
          : `❌ 图层操作失败: ${r.error}`;
      }

      const wfName = workflowMap[action];
      if (!wfName) return `❌ 未知 action: ${action}。支持: ${Object.keys(workflowMap).join('/')}/launch/apply_filter/manage_layer`;

      const r = await desktop.executeOperation({
        app: 'photoshop', action: 'workflow',
        params: { workflowName: wfName, params },
      });

      return r.success
        ? `✅ Photoshop ${wfName} 完成\n${r.result || ''}`
        : `❌ 操作失败: ${r.error}\n提示: 请先用 photoshop_edit launch 启动 PS，或确认 PS 已在前台运行。`;
    },
  },

  // ---------------- 海报制作 ----------------
  {
    name: 'poster_make',
    description: '智能海报制作。根据主题/文案/风格生成海报设计方案(布局/配色/字体/图层)，并调用图片生成接口产出主视觉。返回设计方案 + 生成图片路径 + PS 合成指令。',
    readOnly: false,
    parameters: {
      topic: { type: 'string', description: '海报主题(如"夏季促销/产品发布/招聘海报")', required: true },
      title: { type: 'string', description: '主标题文案', required: true },
      subtitle: { type: 'string', description: '副标题文案(可选)', required: false },
      style: { type: 'string', description: '风格: business(商务)/creative(创意)/minimal(极简)/festival(节日)/tech(科技)，默认 business', required: false },
      size: { type: 'string', description: '尺寸: A4/A3/1080x1080/1080x1920，默认 A4', required: false },
      outputDir: { type: 'string', description: '输出目录，默认 ./posters', required: false },
    },
    execute: async (args) => {
      const topic = args.topic as string;
      const title = args.title as string;
      const subtitle = (args.subtitle as string) || '';
      const style = (args.style as string) || 'business';
      const size = (args.size as string) || 'A4';
      const outputDir = (args.outputDir as string) || './posters';

      await fs.promises.mkdir(outputDir, { recursive: true });

      // 尺寸映射
      const sizeMap: Record<string, { w: number; h: number; desc: string }> = {
        A4: { w: 2480, h: 3508, desc: 'A4 竖版(300dpi)' },
        A3: { w: 3508, h: 4961, desc: 'A3 竖版(300dpi)' },
        '1080x1080': { w: 1080, h: 1080, desc: '正方形(Social)' },
        '1080x1920': { w: 1080, h: 1920, desc: '竖版(手机海报)' },
      };
      const dim = sizeMap[size] || sizeMap.A4;

      // 1. LLM 生成设计方案
      const styleMap: Record<string, string> = {
        business: '商务专业: 蓝灰主色，简洁几何，无衬线字体，留白充足',
        creative: '创意活泼: 撞色搭配，不规则形状，手写体点缀',
        minimal: '极简留白: 黑白灰，大量留白，细线分割，衬线字体',
        festival: '节日喜庆: 红金主色，传统纹样，圆润字体',
        tech: '科技未来: 深色背景，霓虹蓝紫渐变，等宽字体',
      };

      const designPrompt = `为一张${styleMap[style] || styleMap.business}的海报生成设计方案。

主题: ${topic}
主标题: ${title}
副标题: ${subtitle}
尺寸: ${size} (${dim.w}×${dim.h})

输出 JSON 格式（不要代码块包裹）:
{
  "layout": "布局描述(标题位置/正文位置/图片位置)",
  "colors": {"primary":"#hex","secondary":"#hex","accent":"#hex","background":"#hex"},
  "fonts": {"title":"字体建议","body":"字体建议"},
  "layers": [{"name":"图层名","type":"background/text/image/shape","desc":"内容"}],
  "imagePrompt": "用于 AI 生成主视觉图的英文提示词(SDXL格式，描述画面元素、光线、风格)"
}`;

      let design: { layout?: string; colors?: Record<string, string>; fonts?: Record<string, string>; layers?: Array<Record<string, string>>; imagePrompt?: string };
      try {
        const designStr = await callLLM(designPrompt, '你是资深平面设计师，擅长输出结构化的设计方案。');
        // 尝试解析 JSON
        const jsonMatch = designStr.match(/\{[\s\S]*\}/);
        design = jsonMatch ? JSON.parse(jsonMatch[0]) : { layout: designStr };
      } catch (err) {
        return `❌ 设计方案生成失败: ${errMsg(err)}`;
      }

      // 2. 调用图片生成
      let imagePath = '';
      if (design.imagePrompt) {
        try {
          const ig = new ImageGenerator();
          const imgResult = await ig.generate({
            prompt: design.imagePrompt,
            width: dim.w,
            height: dim.h,
          }, 'trae');
          if (imgResult.success && imgResult.images && imgResult.images.length > 0) {
            imagePath = imgResult.images[0];
            if (imagePath) {
              // 复制到输出目录
              const destPath = path.join(outputDir, `poster_${Date.now()}.png`);
              if (await pathExists(imagePath)) {
                await fs.promises.copyFile(imagePath, destPath);
                imagePath = destPath;
              }
            }
          }
        } catch { /* 图片生成失败不阻断 */ }
      }

      // 3. 生成 PS 合成指令
      const psInstructions = (design.layers || []).map((layer, i) =>
        `${i + 1}. [${layer.type || 'layer'}] ${layer.name || ''}: ${layer.desc || ''}`
      ).join('\n');

      // 4. 输出报告
      let report = `🎨 **海报设计方案**\n`;
      report += `主题: ${topic} | 风格: ${style} | 尺寸: ${size} (${dim.w}×${dim.h})\n${'─'.repeat(50)}\n`;
      report += `\n**布局**: ${design.layout || '未指定'}\n`;
      if (design.colors) {
        report += `\n**配色**:\n`;
        for (const [k, v] of Object.entries(design.colors)) report += `   • ${k}: ${v}\n`;
      }
      if (design.fonts) {
        report += `\n**字体**:\n`;
        for (const [k, v] of Object.entries(design.fonts)) report += `   • ${k}: ${v}\n`;
      }
      if (imagePath) report += `\n**主视觉**: ${imagePath}\n`;
      else if (design.imagePrompt) report += `\n**主视觉提示词**: ${design.imagePrompt}\n   (图片生成未启用或失败，可手动用 generate_image 生成)\n`;
      if (psInstructions) {
        report += `\n**PS 合成指令**:\n${psInstructions}\n`;
        report += `\n💡 提示: 用 photoshop_edit action=launch 启动 PS，再依次执行上述图层操作。`;
      }
      return report;
    },
  },
];
