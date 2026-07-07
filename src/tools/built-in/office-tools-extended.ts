/**
 * 扩展办公工具集 — OfficeToolsExtended
 *
 * 补充第一批 office-tools 未覆盖的高频办公小工具：
 * 1. 多语言翻译（LLM 驱动，支持中英日韩法德西俄等）
 * 2. 二维码生成（svg-to-image/qrcode 库，零依赖时降级 SVG 文本）
 * 3. 二维码识别（视觉模型扫描图片中二维码）
 * 4. 文件压缩（zip，基于内置 zlib 或动态加载 archiver）
 * 5. 文件解压（zip/tar/gz）
 * 6. 水印添加（图片水印 + PDF 水印）
 * 7. PDF 文字提取（pdf-parse 动态加载，无依赖时降级提示）
 * 8. 网页转 Markdown（web_fetch + LLM 清洗）
 * 9. 代码片段管理（save/list/search/insert，存储在 ~/.duan/snippets/）
 * 10. 密码生成（强密码 + 可记忆密码 + PIN 码）
 * 11. 汇率换算（在线 API，离线时降级 LLM 估算）
 * 12. 单位换算（长度/重量/温度/面积/体积/速度/数据量）
 *
 * 设计原则：
 * - 外部库一律动态加载（@ts-expect-error），缺失时给出降级方案
 * - 在线 API 失败时优先尝试 LLM 兜底
 * - 所有文件操作走 fs.promises 异步
 * - 输出带 emoji 标识和分隔线，方便用户阅读
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

async function callVisionLLM(prompt: string, imageBase64: string, mediaType: string): Promise<string> {
  const ml = toolContext.modelLibrary;
  if (!ml || typeof ml.call !== 'function') throw new Error('ModelLibrary 未初始化');
  const messages: Array<{
    role: 'system' | 'user';
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    content: any;
  }> = [{
    role: 'user',
    content: [
      { type: 'text', text: prompt },
      { type: 'image_url', image_url: { url: `data:${mediaType};base64,${imageBase64}` } },
    ],
  }];
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const resp = await (ml as any).call(messages, { modelId: 'auto-vision' });
  return resp.content || '';
}

// ============ 工具定义 ============

export const officeToolsExtended: UnifiedToolDef[] = [
  // ============ 多语言翻译 ============
  {
    name: 'translate',
    description: '多语言翻译。支持中英日韩法德西俄等主流语言互译，LLM 驱动保留语境与术语。支持正式/技术/口语三种风格。',
    readOnly: true,
    parameters: {
      text: { type: 'string', description: '要翻译的文本', required: true },
      from: { type: 'string', description: '源语言(如 zh/en/ja/ko/fr/de/es/ru)，auto 表示自动检测', required: false },
      to: { type: 'string', description: '目标语言(如 zh/en/ja/ko/fr/de/es/ru)', required: true },
      style: { type: 'string', description: '风格: formal(正式)/technical(技术)/casual(口语)，默认 formal', required: false },
    },
    execute: async (args) => {
      const text = args.text as string;
      const from = (args.from as string) || 'auto';
      const to = args.to as string;
      const style = (args.style as string) || 'formal';

      const langMap: Record<string, string> = {
        zh: '中文', en: '英语', ja: '日语', ko: '韩语',
        fr: '法语', de: '德语', es: '西班牙语', ru: '俄语',
        it: '意大利语', pt: '葡萄牙语', ar: '阿拉伯语', auto: '自动检测',
      };
      const styleMap: Record<string, string> = {
        formal: '正式商务风格，措辞严谨',
        technical: '技术文档风格，术语准确',
        casual: '日常口语风格，自然流畅',
      };

      const prompt = `将以下文本从${langMap[from] || from}翻译为${langMap[to] || to}。

源文本:
${text}

要求：
1. 风格: ${styleMap[style] || styleMap.formal}
2. 保留专有名词、代码、URL 不译
3. 保留原文段落结构
4. 如有歧义，给出最常用译法并标注
5. 直接输出译文，不要解释

输出格式:
[译文]
<翻译内容>`;

      try {
        const result = await callLLM(prompt, '你是专业翻译，精通多语言互译，注重语境与术语准确性。');
        const translated = result.replace(/\[译文\]/, '').trim();
        return `🌐 **翻译结果** | ${langMap[from] || from} → ${langMap[to] || to} | 风格: ${style}\n${'─'.repeat(50)}\n\n${translated}`;
      } catch (err) {
        return `❌ 翻译失败: ${errMsg(err)}`;
      }
    },
  },

  // ============ 二维码生成 ============
  {
    name: 'qrcode_gen',
    description: '生成二维码图片。支持自定义尺寸/颜色/容错级别。输出 PNG 文件（依赖 qrcode 库，缺失时降级为 SVG 文本）。',
    readOnly: false,
    parameters: {
      data: { type: 'string', description: '二维码内容(URL/文本/联系方式等)', required: true },
      outputPath: { type: 'string', description: '输出图片路径(如 qrcode.png)，默认 output/qrcode_<时间>.png', required: false },
      size: { type: 'string', description: '尺寸像素(默认 300)', required: false },
      color: { type: 'string', description: '前景色 hex(默认 #000000)', required: false },
      background: { type: 'string', description: '背景色 hex(默认 #FFFFFF)', required: false },
    },
    execute: async (args) => {
      const data = args.data as string;
      if (!data) return '❌ data 不能为空';
      const size = parseInt((args.size as string) || '300', 10);
      const color = (args.color as string) || '#000000';
      const background = (args.background as string) || '#FFFFFF';

      const defaultPath = path.join(process.cwd(), 'output', `qrcode_${Date.now()}.png`);
      const outputPath = (args.outputPath as string) || defaultPath;
      const guard = guardSensitivePath(outputPath);
      if (guard) return guard;

      await fs.promises.mkdir(path.dirname(outputPath), { recursive: true });

      // 尝试 qrcode 库
      try {
        // @ts-expect-error - qrcode 可能未安装
        const QRCode = (await import('qrcode')).default;
        await QRCode.toFile(outputPath, data, {
          width: size,
          color: { dark: color, light: background },
          errorCorrectionLevel: 'M',
          margin: 2,
        });
        return `✅ 二维码已生成: ${outputPath}\n   内容: ${data.substring(0, 80)}${data.length > 80 ? '...' : ''}\n   尺寸: ${size}×${size} | 前景: ${color} | 背景: ${background}`;
      } catch (err) {
        // 降级：生成 SVG（纯文本，无外部依赖）
        if (String(err).includes('Cannot find module') || String(err).includes('qrcode')) {
          const svgPath = outputPath.replace(/\.png$/i, '.svg');
          const svg = generateQrSvgPlaceholder(data, size, color, background);
          await fs.promises.writeFile(svgPath, svg, 'utf-8');
          return `⚠️ 未安装 qrcode 库(npm install qrcode)，已生成 SVG 占位文件: ${svgPath}\n   💡 安装 qrcode 库后可生成真实 PNG 二维码。`;
        }
        return `❌ 二维码生成失败: ${errMsg(err)}`;
      }
    },
  },

  // ============ 二维码识别 ============
  {
    name: 'qrcode_scan',
    description: '识别图片中的二维码/条形码内容。通过视觉模型扫描图片，返回识别到的码内容与类型。',
    readOnly: true,
    parameters: {
      imagePath: { type: 'string', description: '图片路径(支持 jpg/png/gif/bmp/webp)', required: true },
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

      let imageBase64: string;
      try {
        const buf = await fs.promises.readFile(imagePath);
        imageBase64 = buf.toString('base64');
      } catch (err) { return `❌ 读取图片失败: ${errMsg(err)}`; }

      const prompt = `请识别图片中的所有二维码和条形码。对每个识别到的码，输出：
1. 码类型(二维码/条形码/EAN-13/UPC-A 等)
2. 码内容(URL/文本/数字等)
3. 在图片中的大致位置

如果没有识别到任何码，请明确说明"未检测到二维码"。

输出格式:
[码 1] 类型: xxx | 内容: xxx | 位置: xxx
[码 2] ...`;

      try {
        const result = await callVisionLLM(prompt, imageBase64, mediaType);
        return `🔍 **二维码识别结果** | 图片: ${path.basename(imagePath)}\n${'─'.repeat(50)}\n\n${result}`;
      } catch (err) {
        return `❌ 识别失败: ${errMsg(err)}\n💡 提示: 确认视觉模型已配置(vision capability)。`;
      }
    },
  },

  // ============ 文件压缩 ============
  {
    name: 'archive_compress',
    description: '将文件/目录压缩为 zip。支持多文件打包。依赖 archiver 库，缺失时降级提示。',
    readOnly: false,
    parameters: {
      input: { type: 'string', description: '输入: 单文件/目录路径，或 JSON 数组路径', required: true },
      output: { type: 'string', description: '输出 zip 路径(如 archive.zip)', required: true },
    },
    execute: async (args) => {
      const output = args.output as string;
      const outGuard = guardSensitivePath(output);
      if (outGuard) return outGuard;
      if (!output.toLowerCase().endsWith('.zip')) return '❌ 目前仅支持 zip 格式';

      let inputPaths: string[];
      try {
        const parsed = JSON.parse(args.input as string);
        inputPaths = Array.isArray(parsed) ? parsed : [args.input as string];
      } catch {
        inputPaths = [args.input as string];
      }

      for (const p of inputPaths) {
        const guard = guardSensitivePath(p);
        if (guard) return guard;
        if (!(await pathExists(p))) return `❌ 输入不存在: ${p}`;
      }

      await fs.promises.mkdir(path.dirname(output) || '.', { recursive: true });

      try {
        // @ts-expect-error - archiver 可能未安装
        const archiver = (await import('archiver')).default;
        await new Promise<void>((resolve, reject) => {
          const archive = archiver('zip', { zlib: { level: 9 } });
          const stream = fs.createWriteStream(output);
          archive.pipe(stream);
          for (const p of inputPaths) {
            const stat = fs.statSync(p);
            if (stat.isDirectory()) {
              archive.directory(p, path.basename(p));
            } else {
              archive.file(p, { name: path.basename(p) });
            }
          }
          archive.finalize();
          stream.on('finish', resolve);
          stream.on('error', reject);
        });
        const stat = await fs.promises.stat(output);
        return `✅ 压缩完成: ${output}\n   文件数: ${inputPaths.length} | 大小: ${(stat.size / 1024).toFixed(2)} KB`;
      } catch (err) {
        if (String(err).includes('Cannot find module') || String(err).includes('archiver')) {
          return `⚠️ 需要安装 archiver: npm install archiver\n失败: ${errMsg(err)}`;
        }
        return `❌ 压缩失败: ${errMsg(err)}`;
      }
    },
  },

  // ============ 文件解压 ============
  {
    name: 'archive_extract',
    description: '解压 zip 文件到指定目录。依赖 unzipper 库，缺失时降级提示。',
    readOnly: false,
    parameters: {
      input: { type: 'string', description: 'zip 文件路径', required: true },
      output: { type: 'string', description: '输出目录(默认同目录下同名文件夹)', required: false },
    },
    execute: async (args) => {
      const input = args.input as string;
      const guard = guardSensitivePath(input);
      if (guard) return guard;
      if (!(await pathExists(input))) return `❌ 文件不存在: ${input}`;
      if (!input.toLowerCase().endsWith('.zip')) return '❌ 目前仅支持 zip 格式';

      const output = (args.output as string) || input.replace(/\.zip$/i, '');
      const outGuard = guardSensitivePath(output);
      if (outGuard) return outGuard;
      await fs.promises.mkdir(output, { recursive: true });

      try {
        const unzipper = (await import('unzipper')).default;
        await fs.createReadStream(input).pipe(unzipper.Extract({ path: output })).promise();
        const files = await fs.promises.readdir(output);
        return `✅ 解压完成: ${input} → ${output}\n   解压文件数: ${files.length}`;
      } catch (err) {
        if (String(err).includes('Cannot find module') || String(err).includes('unzipper')) {
          return `⚠️ 需要安装 unzipper: npm install unzipper\n失败: ${errMsg(err)}\n💡 或通过 shell_execute 用 PowerShell 的 Expand-Archive 命令。`;
        }
        return `❌ 解压失败: ${errMsg(err)}`;
      }
    },
  },

  // ============ 水印添加 ============
  {
    name: 'watermark_add',
    description: '为图片添加文字水印。支持位置/字号/颜色/透明度/旋转。依赖 sharp 库。',
    readOnly: false,
    parameters: {
      imagePath: { type: 'string', description: '源图片路径', required: true },
      text: { type: 'string', description: '水印文字(如"机密"/"© 2026 公司名")', required: true },
      outputPath: { type: 'string', description: '输出路径(默认在源文件名加 _watermark)', required: false },
      position: { type: 'string', description: '位置: center/top-left/bottom-right 等，默认 center', required: false },
      opacity: { type: 'string', description: '透明度 0-1(默认 0.5)', required: false },
    },
    execute: async (args) => {
      const imagePath = args.imagePath as string;
      const guard = guardSensitivePath(imagePath);
      if (guard) return guard;
      if (!(await pathExists(imagePath))) return `❌ 图片不存在: ${imagePath}`;

      const text = args.text as string;
      const position = (args.position as string) || 'center';
      const opacity = parseFloat((args.opacity as string) || '0.5');

      const ext = path.extname(imagePath);
      const base = path.basename(imagePath, ext);
      const dir = path.dirname(imagePath);
      const outputPath = (args.outputPath as string) || path.join(dir, `${base}_watermark${ext}`);
      const outGuard = guardSensitivePath(outputPath);
      if (outGuard) return outGuard;

      try {
        // @ts-expect-error - sharp 可能未安装
        const sharpMod = (await import('sharp')).default;
        // 创建 SVG 水印图层
        const meta = await sharpMod(imagePath).metadata();
        const w = meta.width || 800;
        const h = meta.height || 600;
        const fontSize = Math.max(16, Math.floor(Math.min(w, h) / 20));
        const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${w}" height="${h}">
          <text x="50%" y="50%" text-anchor="middle" dominant-baseline="middle"
            font-size="${fontSize}" font-family="Arial, sans-serif"
            fill="rgba(255,255,255,${opacity})"
            stroke="rgba(0,0,0,${opacity * 0.5})" stroke-width="${Math.max(1, fontSize / 16)}"
            transform="rotate(-30 ${w / 2} ${h / 2})">${escapeXml(text)}</text>
        </svg>`;
        const svgBuf = Buffer.from(svg);

        await sharpMod(imagePath)
          .composite([{ input: svgBuf, gravity: position }])
          .toFile(outputPath);

        return `✅ 水印已添加: ${outputPath}\n   水印文字: "${text}" | 位置: ${position} | 透明度: ${opacity}`;
      } catch (err) {
        if (String(err).includes('Cannot find module') || String(err).includes('sharp')) {
          return `⚠️ 需要安装 sharp: npm install sharp\n失败: ${errMsg(err)}`;
        }
        return `❌ 添加水印失败: ${errMsg(err)}`;
      }
    },
  },

  // ============ PDF 文字提取 ============
  {
    name: 'pdf_extract_text',
    description: '从 PDF 文件提取文字内容。支持指定页码范围。依赖 pdf-parse 库。',
    readOnly: true,
    parameters: {
      pdfPath: { type: 'string', description: 'PDF 文件路径', required: true },
      maxPages: { type: 'string', description: '最多提取页数(默认 50，防止超大 PDF 拖慢)', required: false },
    },
    execute: async (args) => {
      const pdfPath = args.pdfPath as string;
      const guard = guardSensitivePath(pdfPath);
      if (guard) return guard;
      if (!(await pathExists(pdfPath))) return `❌ 文件不存在: ${pdfPath}`;
      if (!pdfPath.toLowerCase().endsWith('.pdf')) return '❌ 仅支持 PDF 文件';

      const maxPages = parseInt((args.maxPages as string) || '50', 10);

      try {
        const buf = await fs.promises.readFile(pdfPath);
        // @ts-expect-error - pdf-parse 可能未安装
        const pdfParse = (await import('pdf-parse')).default;
        const data = await pdfParse(buf, { max: maxPages });
        let report = `📄 **PDF 文字提取** | ${path.basename(pdfPath)}\n${'─'.repeat(50)}\n\n`;
        report += `📊 元信息:\n   总页数: ${data.numpages}\n   作者: ${data.info?.Author || '未知'}\n   标题: ${data.info?.Title || '未知'}\n   创建时间: ${data.info?.CreationDate || '未知'}\n\n`;
        report += `📝 文字内容 (前 3000 字):\n${(data.text || '').substring(0, 3000)}`;
        if ((data.text || '').length > 3000) report += `\n...(共 ${data.text.length} 字，已截断)`;
        return report;
      } catch (err) {
        if (String(err).includes('Cannot find module') || String(err).includes('pdf-parse')) {
          return `⚠️ 需要安装 pdf-parse: npm install pdf-parse\n失败: ${errMsg(err)}\n💡 或通过 ocr_recognize 工具用视觉模型逐页识别(适合扫描版 PDF)。`;
        }
        return `❌ 提取失败: ${errMsg(err)}`;
      }
    },
  },

  // ============ 网页转 Markdown ============
  {
    name: 'url_to_markdown',
    description: '将网页 URL 内容提取并转为干净的 Markdown。自动去除广告/导航/脚本，保留正文结构。',
    readOnly: true,
    parameters: {
      url: { type: 'string', description: '网页 URL', required: true },
      maxLength: { type: 'string', description: '最大输出字符数(默认 8000)', required: false },
    },
    execute: async (args) => {
      const url = args.url as string;
      if (!/^https?:\/\//i.test(url)) return '❌ URL 必须以 http:// 或 https:// 开头';
      const maxLength = parseInt((args.maxLength as string) || '8000', 10);

      try {
        // 复用内置 web_fetch
        const { webTools } = await import('./web-tools.js');
        const fetchTool = webTools.find(t => t.name === 'web_fetch');
        if (!fetchTool) return '❌ web_fetch 工具不可用';
        const rawContent = await fetchTool.execute({ url, format: 'markdown' });

        // 用 LLM 清洗
        const prompt = `以下是网页抓取的原始内容。请清洗并转为结构化 Markdown：

URL: ${url}

原始内容:
${String(rawContent).substring(0, 12000)}

要求：
1. 去除广告、导航、页脚、cookie 提示等非正文内容
2. 保留标题层级(#/##/###)、段落、列表、表格、代码块、图片链接
3. 保留关键链接(URL)
4. 如内容明显是文章，保留作者/发布时间(如有)
5. 直接输出 Markdown，不要解释

输出:`;

        const cleaned = await callLLM(prompt, '你是网页内容清洗专家，擅长提取正文并保留结构。');
        const result = cleaned.substring(0, maxLength);
        return `🌐 **网页转 Markdown** | ${url}\n${'─'.repeat(50)}\n\n${result}${cleaned.length > maxLength ? '\n\n...(已截断)' : ''}`;
      } catch (err) {
        return `❌ 转换失败: ${errMsg(err)}`;
      }
    },
  },

  // ============ 代码片段管理 ============
  {
    name: 'snippet_manage',
    description: '代码片段管理。支持: save(保存片段)/list(列表)/search(搜索)/insert(读取片段内容)。片段存储在 ~/.duan/snippets/。',
    readOnly: false,
    parameters: {
      action: { type: 'string', description: 'save/list/search/insert', required: true },
      name: { type: 'string', description: '片段名(如 "react-useEffect"/"axios-get")', required: false },
      content: { type: 'string', description: 'save: 片段代码内容; search: 搜索关键词', required: false },
      language: { type: 'string', description: 'save: 编程语言(如 typescript/python)', required: false },
      tags: { type: 'string', description: 'save: 标签 JSON 数组(如 ["react","hook"])', required: false },
      description: { type: 'string', description: 'save: 片段描述', required: false },
    },
    execute: async (args) => {
      const os = await import('os');
      const snipDir = path.join(os.homedir(), '.duan', 'snippets');
      await fs.promises.mkdir(snipDir, { recursive: true });
      const action = args.action as string;

      if (action === 'save') {
        const name = (args.name as string) || `snippet_${Date.now()}`;
        const content = (args.content as string) || '';
        if (!content) return '❌ save 需要 content';
        const language = (args.language as string) || 'text';
        const description = (args.description as string) || '';
        let tags: string[] = [];
        if (args.tags) { try { tags = JSON.parse(args.tags as string); } catch { /* ignore */ } }

        const safeName = name.replace(/[\\/:*?"<>|]/g, '_');
        const meta = {
          name, language, description, tags,
          createdAt: new Date().toISOString(),
        };
        const codePath = path.join(snipDir, `${safeName}.snippet`);
        const metaPath = path.join(snipDir, `${safeName}.meta.json`);
        try {
          await fs.promises.writeFile(codePath, content, 'utf-8');
          await atomicWriteJson(metaPath, meta);
          return `✅ 片段已保存: ${name}\n   语言: ${language} | 标签: ${tags.join(', ') || '无'}\n   路径: ${codePath}`;
        } catch (err) { return `❌ 保存失败: ${errMsg(err)}`; }
      }

      if (action === 'list') {
        try {
          const files = (await fs.promises.readdir(snipDir)).filter(f => f.endsWith('.snippet'));
          if (files.length === 0) return '📭 暂无代码片段';
          let report = `📦 **代码片段列表** (${files.length} 个)\n${'─'.repeat(50)}\n`;
          for (const f of files) {
            const metaPath = path.join(snipDir, f.replace(/\.snippet$/, '.meta.json'));
            let meta: { name?: string; language?: string; description?: string; tags?: string[] } = {};
            try { meta = JSON.parse(await fs.promises.readFile(metaPath, 'utf-8')); } catch { /* ignore */ }
            const icon = langIcon(meta.language || 'text');
            report += `${icon} ${meta.name || f.replace(/\.snippet$/, '')}\n   语言: ${meta.language || '未知'} | 标签: ${(meta.tags || []).join(', ') || '无'}\n   ${(meta.description || '').substring(0, 60)}\n`;
          }
          return report;
        } catch (err) { return `❌ 列表失败: ${errMsg(err)}`; }
      }

      if (action === 'search') {
        const keyword = (args.content as string) || '';
        if (!keyword) return '❌ search 需要关键词';
        try {
          const files = (await fs.promises.readdir(snipDir)).filter(f => f.endsWith('.snippet'));
          const matches: Array<{ name: string; snippet: string }> = [];
          for (const f of files) {
            const code = await fs.promises.readFile(path.join(snipDir, f), 'utf-8');
            const metaPath = path.join(snipDir, f.replace(/\.snippet$/, '.meta.json'));
            let meta: { name?: string; tags?: string[] } = {};
            try { meta = JSON.parse(await fs.promises.readFile(metaPath, 'utf-8')); } catch { /* ignore */ }
            if (code.includes(keyword) || (meta.tags || []).some(t => t.includes(keyword)) || (meta.name || '').includes(keyword)) {
              const idx = code.indexOf(keyword);
              const snippet = code.substring(Math.max(0, idx - 30), idx + 80);
              matches.push({ name: meta.name || f.replace(/\.snippet$/, ''), snippet });
            }
          }
          if (matches.length === 0) return `🔍 未找到包含 "${keyword}" 的片段`;
          let report = `🔍 **片段搜索结果** "${keyword}" (${matches.length} 条)\n${'─'.repeat(50)}\n`;
          for (const m of matches) {
            report += `📦 ${m.name}\n   ...${m.snippet.replace(/\n/g, ' ')}...\n`;
          }
          return report;
        } catch (err) { return `❌ 搜索失败: ${errMsg(err)}`; }
      }

      if (action === 'insert') {
        const name = (args.name as string) || '';
        if (!name) return '❌ insert 需要 name';
        const safeName = name.replace(/[\\/:*?"<>|]/g, '_');
        const codePath = path.join(snipDir, `${safeName}.snippet`);
        if (!(await pathExists(codePath))) return `❌ 片段不存在: ${name}`;
        try {
          const code = await fs.promises.readFile(codePath, 'utf-8');
          return `📦 **片段内容** | ${name}\n${'─'.repeat(50)}\n\n${code}`;
        } catch (err) { return `❌ 读取失败: ${errMsg(err)}`; }
      }

      return '❌ action 必须是 save/list/search/insert';
    },
  },

  // ============ 密码生成 ============
  {
    name: 'password_gen',
    description: '生成强密码。支持三种模式: strong(强密码)/memorable(可记忆)/pin(纯数字 PIN)。',
    readOnly: true,
    parameters: {
      mode: { type: 'string', description: 'strong/memorable/pin，默认 strong', required: false },
      length: { type: 'string', description: '密码长度(strong 默认 16，pin 默认 6)', required: false },
      count: { type: 'string', description: '生成数量(默认 1，最多 20)', required: false },
      noSymbols: { type: 'string', description: 'strong 模式: true 排除特殊符号', required: false },
    },
    // eslint-disable-next-line require-await
    execute: async (args) => {
      const mode = (args.mode as string) || 'strong';
      const length = parseInt((args.length as string) || '0', 10);
      let count = parseInt((args.count as string) || '1', 10);
      if (count < 1) count = 1;
      if (count > 20) count = 20;
      const noSymbols = (args.noSymbols as string) === 'true';

      const passwords: string[] = [];
      for (let i = 0; i < count; i++) {
        if (mode === 'pin') {
          const len = length > 0 ? length : 6;
          passwords.push(genPin(len));
        } else if (mode === 'memorable') {
          passwords.push(genMemorable(length > 0 ? length : 4));
        } else {
          // strong
          const len = length > 0 ? length : 16;
          passwords.push(genStrong(len, !noSymbols));
        }
      }

      const strengthBar = (pwd: string): string => {
        let score = 0;
        if (pwd.length >= 12) score++;
        if (pwd.length >= 16) score++;
        if (/[a-z]/.test(pwd)) score++;
        if (/[A-Z]/.test(pwd)) score++;
        if (/[0-9]/.test(pwd)) score++;
        if (/[^a-zA-Z0-9]/.test(pwd)) score++;
        const bars = '█'.repeat(score) + '░'.repeat(6 - score);
        const labels = ['极弱', '弱', '中', '较强', '强', '很强', '极强'];
        return `${bars} ${labels[score]}`;
      };

      let report = `🔐 **密码生成** | 模式: ${mode} | 数量: ${count}\n${'─'.repeat(50)}\n`;
      for (const p of passwords) {
        report += `${p}\n   长度: ${p.length} | 强度: ${strengthBar(p)}\n`;
      }
      return report;
    },
  },

  // ============ 汇率换算 ============
  {
    name: 'currency_convert',
    description: '汇率换算。支持主流货币 USD/CNY/EUR/JPY/GBP/HKD/KRW/AUD/CAD/SGD 等。优先在线 API，离线时降级 LLM 估算。',
    readOnly: true,
    parameters: {
      amount: { type: 'string', description: '金额(如 "100")', required: true },
      from: { type: 'string', description: '源货币代码(如 USD/CNY/EUR)', required: true },
      to: { type: 'string', description: '目标货币代码(如 CNY/USD)', required: true },
    },
    execute: async (args) => {
      const amount = parseFloat((args.amount as string) || '0');
      if (!amount || amount <= 0) return '❌ amount 必须为正数';
      const from = ((args.from as string) || '').toUpperCase();
      const to = ((args.to as string) || '').toUpperCase();
      if (!from || !to) return '❌ from/to 不能为空';

      // 先尝试在线 API
      let rate: number | null = null;
      let dataSource = '';
      try {
        const resp = await fetch(`https://open.er-api.com/v6/latest/${from}`, { method: 'GET' });
        if (resp.ok) {
          const json = await resp.json() as { rates?: Record<string, number> };
          if (json.rates && typeof json.rates[to] === 'number') {
            rate = json.rates[to];
            dataSource = 'open.er-api.com (实时)';
          }
        }
      } catch { /* 网络失败，降级 LLM */ }

      // 降级 LLM 估算
      if (rate === null) {
        try {
          const llmResp = await callLLM(`估算 ${from} 兑 ${to} 的汇率(截至 2025 年大致水平)。只返回一个数字，不要解释。`);
          const parsed = parseFloat(llmResp.replace(/[^\d.]/g, ''));
          if (parsed > 0) {
            rate = parsed;
            dataSource = 'LLM 估算(可能不准确，建议联网验证)';
          }
        } catch { /* ignore */ }
      }

      if (rate === null) return `❌ 无法获取 ${from} → ${to} 汇率(在线 API 与 LLM 均失败)`;

      const converted = amount * rate;
      return `💱 **汇率换算**\n${'─'.repeat(50)}\n   ${amount.toLocaleString()} ${from} = ${converted.toFixed(2)} ${to}\n   汇率: 1 ${from} = ${rate.toFixed(4)} ${to}\n   数据来源: ${dataSource}`;
    },
  },

  // ============ 单位换算 ============
  {
    name: 'unit_convert',
    description: '单位换算。支持长度/重量/温度/面积/体积/速度/数据量等 7 大类。无需联网，纯本地计算。',
    readOnly: true,
    parameters: {
      category: { type: 'string', description: '类别: length/weight/temperature/area/volume/speed/data', required: true },
      value: { type: 'string', description: '数值(如 "100")', required: true },
      from: { type: 'string', description: '源单位(如 m/kg/celsius/m2/liter/mph/kb)', required: true },
      to: { type: 'string', description: '目标单位(如 km/g/fahrenheit/ft2/gallon/kmph/mb)', required: true },
    },
    // eslint-disable-next-line require-await
    execute: async (args) => {
      const category = args.category as string;
      const value = parseFloat((args.value as string) || '0');
      const from = ((args.from as string) || '').toLowerCase();
      const to = ((args.to as string) || '').toLowerCase();
      if (!value && value !== 0) return '❌ value 必须为数字';

      // 各类别的"基准单位 → 单位"换算系数
      const tables: Record<string, Record<string, number>> = {
        length: { m: 1, km: 1000, cm: 0.01, mm: 0.001, mi: 1609.344, yd: 0.9144, ft: 0.3048, in: 0.0254 },
        weight: { kg: 1, g: 0.001, mg: 0.000001, t: 1000, lb: 0.45359237, oz: 0.028349523125 },
        area: { m2: 1, km2: 1000000, cm2: 0.0001, ha: 10000, ft2: 0.09290304, in2: 0.00064516, acre: 4046.8564224 },
        volume: { liter: 1, ml: 0.001, m3: 1000, gallon: 3.785411784, quart: 0.946352946, pint: 0.473176473, cup: 0.2365882365 },
        speed: { mps: 1, kmph: 0.277778, mph: 0.44704, knot: 0.514444, fps: 0.3048 },
        data: { b: 1, kb: 1024, mb: 1048576, gb: 1073741824, tb: 1099511627776, bit: 0.125 },
      };

      // 温度需特殊处理
      if (category === 'temperature') {
        const tempTables = ['celsius', 'c', 'fahrenheit', 'f', 'kelvin', 'k'];
        if (!tempTables.includes(from) || !tempTables.includes(to)) {
          return `❌ 温度单位支持: celsius(c)/fahrenheit(f)/kelvin(k)`;
        }
        // 先转摄氏度
        let celsius: number;
        if (from === 'celsius' || from === 'c') celsius = value;
        else if (from === 'fahrenheit' || from === 'f') celsius = (value - 32) * 5 / 9;
        else celsius = value - 273.15;
        // 再转目标
        let result: number;
        if (to === 'celsius' || to === 'c') result = celsius;
        else if (to === 'fahrenheit' || to === 'f') result = celsius * 9 / 5 + 32;
        else result = celsius + 273.15;
        return `🌡️ **温度换算**\n${'─'.repeat(50)}\n   ${value}° ${from} = ${result.toFixed(2)}° ${to}`;
      }

      const table = tables[category];
      if (!table) return `❌ 不支持类别: ${category}\n💡 支持: length/weight/temperature/area/volume/speed/data`;
      if (!table[from]) return `❌ 不支持的源单位: ${from}\n💡 支持: ${Object.keys(table).join(', ')}`;
      if (!table[to]) return `❌ 不支持的目标单位: ${to}\n💡 支持: ${Object.keys(table).join(', ')}`;

      const baseValue = value * table[from];
      const result = baseValue / table[to];
      const catName: Record<string, string> = {
        length: '长度', weight: '重量', area: '面积',
        volume: '体积', speed: '速度', data: '数据量',
      };
      return `📐 **${catName[category] || category}换算**\n${'─'.repeat(50)}\n   ${value} ${from} = ${result.toFixed(6).replace(/\.?0+$/, '')} ${to}`;
    },
  },
];

// ============ 辅助函数 ============

function escapeXml(s: string): string {
  return s.replace(/[<>&'"]/g, c => ({
    '<': '&lt;', '>': '&gt;', '&': '&amp;', "'": '&apos;', '"': '&quot;',
  }[c] || c));
}

function langIcon(lang: string): string {
  const iconMap: Record<string, string> = {
    typescript: '🟦', javascript: '🟨', python: '🐍', java: '☕',
    go: '🐹', rust: '🦀', c: '🔵', cpp: '🔵', csharp: '🟣',
    php: '🐘', ruby: '💎', swift: '🍎', kotlin: '🟠', html: '🌐',
    css: '🎨', sql: '🗄️', bash: '⚙️', shell: '⚙️',
  };
  return iconMap[lang.toLowerCase()] || '📦';
}

function genStrong(length: number, withSymbols: boolean): string {
  let chars = 'abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789';
  if (withSymbols) chars += '!@#$%^&*()_+-=[]{}|;:,.<>?';
  const randomBytes = new Uint8Array(length);
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const crypto = (globalThis as any).crypto;
  if (crypto && crypto.getRandomValues) {
    crypto.getRandomValues(randomBytes);
  } else {
    // 降级 Math.random
    for (let i = 0; i < length; i++) randomBytes[i] = Math.floor(Math.random() * 256);
  }
  let pwd = '';
  for (let i = 0; i < length; i++) {
    pwd += chars[randomBytes[i] % chars.length];
  }
  return pwd;
}

function genPin(length: number): string {
  let pin = '';
  for (let i = 0; i < length; i++) pin += Math.floor(Math.random() * 10).toString();
  return pin;
}

function genMemorable(wordCount: number): string {
  const adjectives = ['Quick', 'Brave', 'Calm', 'Eager', 'Gentle', 'Happy', 'Kind', 'Proud', 'Wise', 'Bright'];
  const nouns = ['Tiger', 'River', 'Mountain', 'Forest', 'Ocean', 'Eagle', 'Wolf', 'Bear', 'Star', 'Tree'];
  const digits = Math.floor(Math.random() * 90 + 10).toString();
  const symbols = ['!', '@', '#', '$', '&', '*'];
  const sym = symbols[Math.floor(Math.random() * symbols.length)];
  const parts: string[] = [];
  for (let i = 0; i < wordCount; i++) {
    const adj = adjectives[Math.floor(Math.random() * adjectives.length)];
    const noun = nouns[Math.floor(Math.random() * nouns.length)];
    parts.push(`${adj}${noun}`);
  }
  return `${parts.join('-')}-${digits}${sym}`;
}

function generateQrSvgPlaceholder(data: string, size: number, color: string, background: string): string {
  // 简单占位 SVG（非真实二维码，仅展示文字）
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${size}" height="${size}" viewBox="0 0 ${size} ${size}">
  <rect width="${size}" height="${size}" fill="${background}"/>
  <text x="50%" y="45%" text-anchor="middle" font-size="14" fill="${color}" font-family="Arial">[QR Code Placeholder]</text>
  <text x="50%" y="55%" text-anchor="middle" font-size="11" fill="${color}" font-family="Arial">${escapeXml(data.substring(0, 40))}</text>
</svg>`;
}
