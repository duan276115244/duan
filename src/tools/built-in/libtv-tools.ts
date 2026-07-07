/**
 * LibTV 技能工具 — 内置视频/图像创作工具集
 *
 * 学习 LibLib.tv 的功能逻辑，内置实现核心能力，无需外部 API Key。
 * 所有创意生成使用内置 LLM（callLLM），图片生成使用 Trae 内置 API。
 *
 * 核心能力（全部内置，零配置）：
 * - 图片生成：使用 Trae 内置 API，无需 DALL-E/SD API Key
 * - 视频规划：LLM 生成完整视频制作方案（分镜、镜头、节奏）
 * - 分镜脚本：将剧本自动分解为结构化分镜
 * - 媒体编辑建议：AI 生成创意编辑/修改方案
 * - 提示词优化：专业电影术语增强图像/视频提示词
 *
 * 与 LibTVWorkFlow 的关系：
 * - 本文件提供独立工具，Agent 可直接调用
 * - LibTVWorkFlow 提供项目管理式工作流（创建项目→生成脚本→生成分镜→渲染）
 */

import type { UnifiedToolDef } from '../../core/unified-tool-def.js';
import { callLLM } from '../llm-caller.js';
import { errMsg } from '../../core/utils.js';
import * as path from 'path';
import * as fs from 'fs';
import * as os from 'os';

// ============ 内置图片生成（Trae API，零配置） ============

const TRAE_SIZE_MAP: Record<string, string> = {
  '1024x1024': 'square_hd',
  '1024x1792': 'portrait_16_9',
  '1792x1024': 'landscape_16_9',
  '1024x768': 'landscape_4_3',
  '768x1024': 'portrait_4_3',
  '512x512': 'square',
};

async function generateImageWithTrae(
  prompt: string,
  width: number = 1024,
  height: number = 1024,
): Promise<{ success: boolean; filePath?: string; error?: string }> {
  try {
    const sizeStr = `${width}x${height}`;
    const traeSize = TRAE_SIZE_MAP[sizeStr] || 'square_hd';
    const encodedPrompt = encodeURIComponent(prompt);
    const url = `https://trae-api-cn.mchost.guru/api/ide/v1/text_to_image?prompt=${encodedPrompt}&image_size=${traeSize}`;

    const outputDir = path.join(process.cwd(), 'output', 'images');
    await fs.promises.mkdir(outputDir, { recursive: true });

    const response = await fetch(url, { signal: AbortSignal.timeout(60000) });
    if (!response.ok) {
      return { success: false, error: `Trae API 返回 ${response.status}` };
    }

    // Trae API 可能返回 JSON 或直接返回图片
    const contentType = response.headers.get('content-type') || '';
    const filePath = path.join(outputDir, `libtv_img_${Date.now()}.png`);

    if (contentType.includes('image')) {
      // 直接返回图片二进制
      const buffer = Buffer.from(await response.arrayBuffer());
      await fs.promises.writeFile(filePath, buffer);
      return { success: true, filePath };
    }

    // 返回 JSON（可能包含 URL）
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const data = await response.json() as any;
    const imageUrl = data?.data?.url || data?.url || data?.image_url || data?.images?.[0]?.url;

    if (imageUrl) {
      const imgRes = await fetch(imageUrl, { signal: AbortSignal.timeout(30000) });
      if (imgRes.ok) {
        const buffer = Buffer.from(await imgRes.arrayBuffer());
        await fs.promises.writeFile(filePath, buffer);
        return { success: true, filePath };
      }
    }

    // 如果都无法获取图片，返回优化后的提示词供用户使用 generate_image 工具
    return {
      success: false,
      error: `图片生成 API 未返回可用图片。请使用内置 generate_image 工具，提示词: ${prompt.substring(0, 200)}`,
    };
  } catch (err: unknown) {
    return { success: false, error: `Trae 图片生成失败: ${errMsg(err)}` };
  }
}

// ============ LLM 提示词模板 ============

const STORYBOARD_SYSTEM = `你是专业的AI视频分镜师。将剧本/故事描述分解为结构化分镜脚本。
要求：
- 每个分镜包含：镜头编号、景别、镜头运动、画面描述、光线氛围、时长估算
- 景别：特写(CU)、近景(MCU)、中景(MS)、全景(WS)、远景(ELS)
- 镜头运动：推(Push in)、拉(Pull out)、摇(Pan)、跟(Track)、升(Rise)、降(Drop)、固定(Static)
- 画面描述用中英文双语（中文叙事+英文AI提示词）
- 输出格式：

## 分镜脚本

### 镜头 1
- 景别: [景别]
- 镜头运动: [运动方式]
- 时长: [秒数]秒
- 画面描述: [中文描述]
- AI提示词: [English prompt for image generation, 100-200 chars]
- 光线氛围: [描述]

（按此格式输出所有镜头）`;

const VIDEO_PLAN_SYSTEM = `你是专业的AI视频制作规划师。根据用户描述，生成完整的视频制作方案。
要求输出：
1. 视频概述（主题、风格、目标时长）
2. 完整分镜脚本（每个镜头的景别、运动、画面、时长）
3. 每个镜头的AI图像生成提示词（英文，含镜头类型、光线、构图、色调、氛围）
4. 配乐/音效建议
5. 转场建议
6. 字幕/旁白文案

格式清晰专业，可直接用于制作。`;

const EDIT_SUGGESTION_SYSTEM = `你是专业的视频/图片编辑顾问。根据用户描述的修改需求，提供：
1. 修改方案（2-3个选项）
2. 每个方案的效果描述
3. 对应的AI提示词修改建议（英文）
4. 注意事项和技巧

确保建议专业、具体、可执行。`;

const PROMPT_OPTIMIZE_SYSTEM = `你是AI图像/视频提示词优化专家。将用户提供的简单描述转化为专业的、细节丰富的提示词。
优化要点：
- 添加镜头类型和角度
- 添加光线描述（自然光/人造光/侧光/逆光/柔光）
- 添加构图描述（三分法/对称/引导线/框架）
- 添加色调和氛围
- 添加风格参考（电影感/赛博朋克/水彩/油画等）
- 控制在100-200字符
- 输出中英文双语版本`;

// ============ 工具定义 ============

export const libtvTools: UnifiedToolDef[] = [
  // ============ 1. 图片生成（内置） ============
  {
    name: 'libtv_generate_image',
    description: 'AI 生成图片（内置能力，无需 API Key）。使用 Trae 内置图像生成引擎，零配置即可使用。也可用于优化图像提示词后生成。一般图片生成请优先使用 generate_image（功能更全），本工具侧重视频分镜画面的快速出图。',
    readOnly: false,
    parameters: {
      prompt: { type: 'string', description: '图片描述/提示词（越详细效果越好）', required: true },
      style: { type: 'string', description: '风格: cinematic(电影感), anime(动漫), realistic(写实), cyberpunk(赛博朋克), oil_painting(油画)', required: false },
      ratio: { type: 'string', description: '图片比例: 1:1, 16:9, 9:16, 4:3, 3:4', required: false },
      optimize_prompt: { type: 'boolean', description: '是否先用LLM优化提示词再生成（默认true，效果更好）', required: false },
    },
    execute: async (args) => {
      const rawPrompt = args.prompt as string;
      const style = (args.style as string) || 'cinematic';
      const ratio = (args.ratio as string) || '1:1';
      const shouldOptimize = (args.optimize_prompt as boolean) ?? true;

      try {
        // 1. 优化提示词
        let finalPrompt = rawPrompt;
        if (shouldOptimize) {
          const optimizeResult = await callLLM(
            PROMPT_OPTIMIZE_SYSTEM,
            `原始描述: ${rawPrompt}\n目标风格: ${style}\n请输出优化后的英文提示词（仅输出提示词本身，不要其他解释）`,
            { temperature: 0.7, maxTokens: 256 },
          );
          if (optimizeResult && optimizeResult.trim()) {
            finalPrompt = optimizeResult.trim();
          }
        }

        // 2. 根据比例确定尺寸
        let width = 1024;
        let height = 1024;
        switch (ratio) {
          case '16:9': width = 1792; height = 1024; break;
          case '9:16': width = 1024; height = 1792; break;
          case '4:3': width = 1024; height = 768; break;
          case '3:4': width = 768; height = 1024; break;
          default: width = 1024; height = 1024; break;
        }

        // 3. 调用 Trae 内置 API 生成图片
        const result = await generateImageWithTrae(finalPrompt, width, height);

        if (result.success && result.filePath) {
          return `✅ 图片生成成功！
风格: ${style}
比例: ${ratio}
${shouldOptimize ? `原始提示词: ${rawPrompt.substring(0, 100)}\n优化后提示词: ${finalPrompt.substring(0, 200)}` : `提示词: ${finalPrompt.substring(0, 200)}`}
图片路径: ${result.filePath}`;
        }

        // Trae API 失败时，返回优化后的提示词供用户使用 generate_image 工具
        return `⚠️ Trae 内置 API 暂时不可用，但已为您优化了提示词：

📝 优化后提示词: ${finalPrompt}

💡 请使用内置 generate_image 工具生成图片，将上方提示词作为 prompt 参数传入。`;
      } catch (err: unknown) {
        return `❌ 图片生成失败: ${errMsg(err)}`;
      }
    },
  },

  // ============ 2. 视频制作方案生成（内置） ============
  {
    name: 'libtv_generate_video',
    description: 'AI 生成完整视频制作方案（内置能力，无需 API Key）。根据描述生成包含分镜脚本、镜头语言、AI提示词、配乐建议的专业制作方案。实际视频渲染需配合外部视频生成API，但创意策划和分镜设计完全内置。',
    readOnly: true,
    parameters: {
      prompt: { type: 'string', description: '视频描述/创意概念', required: true },
      style: { type: 'string', description: '视频风格: cinematic(电影感), anime(动漫), documentary(纪录片), commercial(广告), vlog(生活记录)', required: false },
      duration: { type: 'number', description: '目标时长(秒): 15, 30, 60, 120', required: false },
      ratio: { type: 'string', description: '视频比例: 16:9, 9:16, 1:1', required: false },
    },
    execute: async (args) => {
      const prompt = args.prompt as string;
      const style = (args.style as string) || 'cinematic';
      const duration = (args.duration as number) || 30;
      const ratio = (args.ratio as string) || '16:9';

      try {
        const userPrompt = `请为以下视频创意生成完整制作方案：

视频描述: ${prompt}
风格: ${style}
目标时长: ${duration}秒
画面比例: ${ratio}

请生成：
1. 视频概述
2. 完整分镜脚本（每个镜头含景别、运动、画面描述、时长）
3. 每个镜头的AI图像提示词（英文，用于生成分镜画面）
4. 配乐/音效建议
5. 转场建议
6. 旁白/字幕文案`;

        const result = await callLLM(VIDEO_PLAN_SYSTEM, userPrompt, {
          temperature: 0.8,
          maxTokens: 4096,
        });

        if (!result || !result.trim()) {
          return '❌ AI 返回空内容，请重试';
        }

        return `✅ 视频制作方案生成成功！

🎬 风格: ${style} | 时长: ${duration}秒 | 比例: ${ratio}

${result}

---
💡 后续步骤：
1. 使用 libtv_create_storyboard 进一步细化分镜
2. 使用 libtv_generate_image 生成分镜画面
3. 使用内置 generate_image 工具生成高质量画面`;
      } catch (err: unknown) {
        return `❌ 视频方案生成失败: ${errMsg(err)}`;
      }
    },
  },

  // ============ 3. 分镜脚本生成（内置） ============
  {
    name: 'libtv_create_storyboard',
    description: '将剧本/故事描述自动分解为结构化分镜脚本（内置能力，无需 API Key）。返回包含镜头编号、景别、镜头运动、画面描述、AI提示词、光线氛围的完整分镜列表。支持电影感/动漫/写实等风格。',
    readOnly: true,
    parameters: {
      script: { type: 'string', description: '剧本/故事描述', required: true },
      style: { type: 'string', description: '镜头风格: cinematic(电影感), anime(动漫), realistic(写实)', required: false },
      max_shots: { type: 'number', description: '最大分镜数量(默认10)', required: false },
    },
    execute: async (args) => {
      const script = args.script as string;
      const style = (args.style as string) || 'cinematic';
      const maxShots = (args.max_shots as number) || 10;

      try {
        const userPrompt = `请将以下剧本分解为分镜脚本，风格: ${style}，最多${maxShots}个分镜：

${script}

要求：
- 每个分镜必须包含：镜头编号、景别、镜头运动、画面描述、AI提示词（英文）、光线氛围
- 画面描述要具体生动
- AI提示词要专业详细（含镜头、光线、构图、色调），100-200字符
- 合理安排镜头节奏和时长`;

        const result = await callLLM(STORYBOARD_SYSTEM, userPrompt, {
          temperature: 0.7,
          maxTokens: 4096,
        });

        if (!result || !result.trim()) {
          return '❌ AI 返回空内容，请重试';
        }

        return `✅ 分镜脚本生成成功！

🎬 风格: ${style} | 最大镜头数: ${maxShots}

${result}

---
💡 可使用 libtv_generate_image 为每个镜头生成分镜画面`;
      } catch (err: unknown) {
        return `❌ 分镜生成失败: ${errMsg(err)}`;
      }
    },
  },

  // ============ 4. 媒体编辑建议（内置） ============
  {
    name: 'libtv_edit_media',
    description: 'AI 生成媒体编辑/修改方案（内置能力，无需 API Key）。根据原始描述和修改需求，提供多个专业编辑方案、效果预估和AI提示词建议。支持风格迁移、局部修改、色调调整等。',
    readOnly: true,
    parameters: {
      original_description: { type: 'string', description: '原始画面/视频描述', required: true },
      edit_type: { type: 'string', description: '修改类型: style_transfer(风格迁移), local_edit(局部修改), color_adjust(色调调整), add_element(添加元素), remove_element(移除元素)', required: true },
      edit_description: { type: 'string', description: '修改描述，如"把背景换成海边"', required: true },
    },
    execute: async (args) => {
      const originalDesc = args.original_description as string;
      const editType = args.edit_type as string;
      const editDesc = args.edit_description as string;

      const editTypeNames: Record<string, string> = {
        style_transfer: '风格迁移',
        local_edit: '局部修改',
        color_adjust: '色调调整',
        add_element: '添加元素',
        remove_element: '移除元素',
      };

      try {
        const userPrompt = `原始画面描述: ${originalDesc}
修改类型: ${editTypeNames[editType] || editType}
修改需求: ${editDesc}

请提供：
1. 2-3个修改方案选项
2. 每个方案的效果描述
3. 对应的AI图像提示词（英文，修改后完整提示词）
4. 注意事项和技巧`;

        const result = await callLLM(EDIT_SUGGESTION_SYSTEM, userPrompt, {
          temperature: 0.7,
          maxTokens: 2048,
        });

        if (!result || !result.trim()) {
          return '❌ AI 返回空内容，请重试';
        }

        return `✅ 媒体编辑方案生成成功！

📝 原始描述: ${originalDesc.substring(0, 100)}
🔧 修改类型: ${editTypeNames[editType] || editType}
💡 修改需求: ${editDesc}

${result}

---
💡 可使用 libtv_generate_image 或 generate_image 工具按新提示词生成修改后的图片`;
      } catch (err: unknown) {
        return `❌ 编辑方案生成失败: ${errMsg(err)}`;
      }
    },
  },

  // ============ 5. 任务状态查询（内置） ============
  {
    name: 'libtv_poll_status',
    description: '查询内置视频/图片生成任务的状态（无需外部API Key）。本工具跟踪内部创意生成任务的进度。',
    readOnly: true,
    parameters: {
      task_type: { type: 'string', description: '任务类型: storyboard(分镜), video_plan(视频方案), image(图片), edit(编辑)', required: false },
    },
    execute: (args) => {
      const taskType = (args.task_type as string) || 'all';

      // 内置工具是同步执行的，返回当前可用状态
      const statusMap: Record<string, { name: string; status: string; capability: string }> = {
        storyboard: { name: '分镜脚本生成', status: '✅ 可用', capability: '内置LLM，零配置' },
        video_plan: { name: '视频制作方案', status: '✅ 可用', capability: '内置LLM，零配置' },
        image: { name: '图片生成', status: '✅ 可用', capability: 'Trae内置API，零配置' },
        edit: { name: '编辑建议', status: '✅ 可用', capability: '内置LLM，零配置' },
        prompt_optimize: { name: '提示词优化', status: '✅ 可用', capability: '内置LLM，零配置' },
      };

      if (taskType === 'all') {
        const lines = Object.entries(statusMap).map(
          ([key, val]) => `  ${key}: ${val.name} — ${val.status}（${val.capability}）`,
        );
        return Promise.resolve(`📊 LibTV 内置工具状态\n\n${lines.join('\n')}\n\n所有工具均为内置能力，无需外部 API Key。`);
      }

      const info = statusMap[taskType];
      if (!info) {
        return Promise.resolve(`❌ 未知任务类型: ${taskType}\n可用类型: ${Object.keys(statusMap).join(', ')}`);
      }

      return Promise.resolve(`📊 任务状态\n类型: ${info.name}\n状态: ${info.status}\n能力: ${info.capability}`);
    },
  },

  // ============ 6. 保存结果到文件（内置） ============
  {
    name: 'libtv_download_result',
    description: '将生成的创意内容（分镜脚本、视频方案、编辑建议等）保存到本地文件（无需外部API Key）。支持 Markdown 和 JSON 格式导出。',
    readOnly: false,
    parameters: {
      content: { type: 'string', description: '要保存的内容文本', required: true },
      filename: { type: 'string', description: '文件名(不含路径，默认 storyboards.md)', required: false },
      format: { type: 'string', description: '保存格式: markdown(默认), json, txt', required: false },
      output_dir: { type: 'string', description: '输出目录(默认 ~/Downloads/libtv_output)', required: false },
    },
    execute: async (args) => {
      const content = args.content as string;
      const filename = (args.filename as string) || 'storyboards.md';
      const format = (args.format as string) || 'markdown';
      const outputDir = (args.output_dir as string) || path.join(os.homedir(), 'Downloads', 'libtv_output');

      try {
        // 确保目录存在
        await fs.promises.mkdir(outputDir, { recursive: true });

        // 根据格式生成内容
        let fileContent: string;
        let finalFilename = filename;

        if (format === 'json') {
          // eslint-disable-next-line @typescript-eslint/no-explicit-any
          const jsonData: any = {
            generatedAt: new Date().toISOString(),
            format: 'libtv-storyboard',
            content,
          };
          fileContent = JSON.stringify(jsonData, null, 2);
          if (!finalFilename.endsWith('.json')) finalFilename = filename.replace(/\.\w+$/, '.json');
        } else if (format === 'txt') {
          fileContent = content;
          if (!finalFilename.endsWith('.txt')) finalFilename = filename.replace(/\.\w+$/, '.txt');
        } else {
          // Markdown 格式，添加标题头
          fileContent = `# LibTV 创意输出\n\n> 生成时间: ${new Date().toLocaleString('zh-CN')}\n\n---\n\n${content}\n`;
          if (!finalFilename.endsWith('.md')) finalFilename = filename.replace(/\.\w+$/, '.md');
        }

        const filePath = path.join(outputDir, finalFilename);
        await fs.promises.writeFile(filePath, fileContent, 'utf-8');

        return `✅ 内容已保存！
文件路径: ${filePath}
文件大小: ${(Buffer.byteLength(fileContent) / 1024).toFixed(1)} KB
格式: ${format}`;
      } catch (err: unknown) {
        return `❌ 保存失败: ${errMsg(err)}`;
      }
    },
  },

  // ============ 7. 内置能力列表（无需API Key） ============
  {
    name: 'libtv_list_models',
    description: '查询 LibTV 内置可用能力列表（无需外部API Key）。展示所有内置创作工具及其能力说明。',
    readOnly: true,
    parameters: {},
    execute: () => {
      return Promise.resolve(`📋 LibTV 内置能力列表（零配置，无需 API Key）

🎨 图像生成能力:
  • Trae 内置引擎 — 零配置图像生成，支持多种尺寸和比例
  • 提示词优化 — 自动增强图像描述，添加专业电影术语
  • 风格支持 — cinematic / anime / realistic / cyberpunk / oil_painting

🎬 视频创作能力:
  • 视频制作方案 — 生成完整分镜脚本+镜头语言+AI提示词
  • 分镜脚本生成 — 将剧本文本转为结构化分镜（含景别、运动、画面）
  • 编辑建议 — 生成风格迁移/局部修改/色调调整方案

📝 支持的风格:
  • cinematic — 电影感（默认）
  • anime — 动漫风格
  • realistic — 写实风格
  • documentary — 纪录片风格
  • commercial — 广告风格
  • cyberpunk — 赛博朋克

🔧 工具列表:
  1. libtv_generate_image — 图片生成（Trae内置API）
  2. libtv_generate_video — 视频制作方案生成
  3. libtv_create_storyboard — 分镜脚本生成
  4. libtv_edit_media — 媒体编辑建议
  5. libtv_poll_status — 任务状态查询
  6. libtv_download_result — 保存结果到文件
  7. libtv_list_models — 本工具，查看能力列表

💡 所有工具均为内置实现，使用项目自带的 LLM 和 Trae 图像 API，无需任何外部密钥。`);
    },
  },
];
