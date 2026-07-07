import * as path from 'path';
import { type ToolDef } from './agent-loop-types.js';
import type { CoreModules } from './bootstrap.js';

// ============ 类型化参数解析层 ============
// 替代大量的 `args.x as string` 强转，提供 schema 校验 + 类型推断

type RawArgs = Record<string, unknown>;

interface ArgReader {
  string(key: string): string;
  stringOpt(key: string): string | undefined;
  stringOr(key: string, fallback: string): string;
  number(key: string): number;
  numberOpt(key: string): number | undefined;
  enumOpt<T extends string>(key: string, allowed: readonly T[]): T | undefined;
  enumOr<T extends string>(key: string, allowed: readonly T[], fallback: T): T;
}

function readArgs(args: RawArgs): ArgReader {
  const reader: ArgReader = {
    string(key) {
      const v = args[key];
      if (typeof v !== 'string') {
        throw new Error(`参数 "${key}" 应为 string 类型，实际为 ${typeof v}`);
      }
      return v;
    },
    stringOpt(key) {
      const v = args[key];
      if (v === undefined || v === null) return undefined;
      if (typeof v !== 'string') {
        throw new Error(`参数 "${key}" 应为 string 类型，实际为 ${typeof v}`);
      }
      return v;
    },
    stringOr(key, fallback) {
      return reader.stringOpt(key) ?? fallback;
    },
    number(key) {
      const v = args[key];
      if (typeof v !== 'number' || Number.isNaN(v)) {
        throw new Error(`参数 "${key}" 应为 number 类型，实际为 ${typeof v}`);
      }
      return v;
    },
    numberOpt(key) {
      const v = args[key];
      if (v === undefined || v === null) return undefined;
      if (typeof v !== 'number' || Number.isNaN(v)) {
        throw new Error(`参数 "${key}" 应为 number 类型，实际为 ${typeof v}`);
      }
      return v;
    },
    enumOpt(key, allowed) {
      const v = reader.stringOpt(key);
      if (v === undefined) return undefined;
      if (!allowed.includes(v as never)) {
        throw new Error(`参数 "${key}" 应为 ${allowed.join('/')} 之一，实际为 "${v}"`);
      }
      return v as never;
    },
    enumOr(key, allowed, fallback) {
      return reader.enumOpt(key, allowed) ?? fallback;
    },
  };
  return reader;
}

// ============ 视频工具定义 ============

export function createVideoToolDefs(modules: CoreModules): ToolDef[] {
  return [
    {
      name: 'generate_flowchart',
      description: '根据文本描述生成流程图',
      parameters: {
        description: { type: 'string', description: '流程图描述', required: true },
      },
      readOnly: true,
      execute: (args) => {
        const a = readArgs(args);
        const result = modules.videoEngine.generateFlowchart(a.string('description'));
        return Promise.resolve(JSON.stringify(result, null, 2));
      },
    },
    {
      name: 'generate_storyboard',
      description: '根据脚本生成视频分镜',
      parameters: {
        description: { type: 'string', description: '视频脚本描述', required: true },
        style: { type: 'string', description: '风格 (默认: 电影感)', required: false },
      },
      readOnly: true,
      execute: (args) => {
        const a = readArgs(args);
        const result = modules.videoEngine.generateStoryboard(a.string('description'), a.stringOpt('style'));
        return Promise.resolve(JSON.stringify(result, null, 2));
      },
    },
    {
      name: 'generate_video',
      description: '根据描述生成视频（真实调用 Pika/Runway/Kling/CogVideo/MiniMax/Luma API）',
      parameters: {
        description: { type: 'string', description: '视频描述', required: true },
        platform: { type: 'string', description: '目标平台 (runway/pika/kling/cogvideo/minimax/luma)', required: false },
      },
      readOnly: true,
      execute: async (args) => {
        const a = readArgs(args);
        // P0 真实修复：原先调用 stub videoEngine.generateVideo（返回假 URL https://example.com/video.mp4）
        // 现在真实调用 videoGenReal.generateVideo() 调用真实视频生成 API
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        const options: any = {};
        const platform = a.stringOpt('platform');
        if (platform) options.provider = platform;
        const result = await modules.videoGenReal.generateVideo(
          a.string('description'),
          options,
        );
        return JSON.stringify(result, null, 2);
      },
    },
    {
      name: 'create_video_project',
      description: '创建一个新的视频项目',
      parameters: {
        title: { type: 'string', description: '项目标题', required: true },
        description: { type: 'string', description: '项目描述', required: true },
      },
      readOnly: true,
      execute: async (args) => {
        const a = readArgs(args);
        const project = await modules.libtvWorkflow.createProject(a.string('title'), a.string('description'));
        return JSON.stringify({ id: project.id, title: project.title, status: project.status }, null, 2);
      },
    },
    {
      name: 'generate_video_script',
      description: '使用LLM根据剧情生成完整的视频剧本（含角色、对话、分场）',
      parameters: {
        projectId: { type: 'string', description: '项目ID (先创建项目)', required: true },
        plot: { type: 'string', description: '剧情描述', required: true },
      },
      readOnly: true,
      execute: (args) => {
        const a = readArgs(args);
        return modules.libtvWorkflow.generateScript(a.string('projectId'), a.string('plot'));
      },
    },
    {
      name: 'generate_video_storyboard',
      description: '根据剧本生成带AI图像提示词的分镜脚本',
      parameters: {
        projectId: { type: 'string', description: '项目ID', required: true },
      },
      readOnly: true,
      execute: (args) => {
        const a = readArgs(args);
        return modules.libtvWorkflow.generateStoryboard(a.string('projectId'));
      },
    },
    {
      name: 'get_video_project_status',
      description: '查看视频项目的状态和进度',
      parameters: {
        projectId: { type: 'string', description: '项目ID', required: true },
      },
      readOnly: true,
      execute: (args) => {
        const a = readArgs(args);
        return modules.libtvWorkflow.getProjectStatus(a.string('projectId'));
      },
    },
    {
      name: 'optimize_image_prompt',
      description: '优化AI图像生成提示词（添加镜头类型、光线、构图、色调等专业电影术语）',
      parameters: {
        prompt: { type: 'string', description: '原始提示词', required: true },
        style: { type: 'string', description: '目标风格 (cinematic/anime/realistic等)', required: false },
      },
      readOnly: true,
      execute: (args) => {
        const a = readArgs(args);
        return modules.promptEngineer.optimizePrompt(a.string('prompt'), 'image', a.stringOpt('style'));
      },
    },
    {
      name: 'optimize_video_prompt',
      description: '优化AI视频生成提示词（添加镜头运动、动态变化、过渡效果等专业描述）',
      parameters: {
        prompt: { type: 'string', description: '原始视频提示词', required: true },
        model: { type: 'string', description: '目标模型 (runway/pika/kling等)', required: false },
      },
      readOnly: true,
      execute: (args) => {
        const a = readArgs(args);
        return modules.promptEngineer.optimizePrompt(a.string('prompt'), 'video', a.stringOpt('model'));
      },
    },
    {
      name: 'analyze_video_script',
      description: '分析剧本并自动生成完整的分镜表（含镜头角度、运动方式、光线、色调、氛围推荐及AI提示词）',
      parameters: {
        script: { type: 'string', description: '剧本内容', required: true },
      },
      readOnly: true,
      execute: async (args) => {
        const a = readArgs(args);
        const result = await modules.promptEngineer.analyzeScript(a.string('script'));
        return JSON.stringify(result, null, 2);
      },
    },
    {
      name: 'suggest_camera_settings',
      description: '根据场景类型推荐镜头角度和运动方式',
      parameters: {
        sceneType: { type: 'string', description: '场景类型 (对话/动作/风景/室内/情感)', required: true },
      },
      readOnly: true,
      execute: (args) => {
        const a = readArgs(args);
        const result = modules.promptEngineer.suggestCameraSettings(a.string('sceneType'));
        return Promise.resolve(JSON.stringify(result, null, 2));
      },
    },
  ];
}

// ============ 测试生成工具定义 ============

export function createTestToolDefs(modules: CoreModules): ToolDef[] {
  return [
    {
      name: 'analyze_code_tests',
      description: '分析源代码文件，生成全面的测试方案（含函数分析、边界条件、Mock点）',
      parameters: {
        filePath: { type: 'string', description: '源代码文件路径', required: true },
      },
      readOnly: true,
      execute: (args) => {
        const a = readArgs(args);
        return modules.testGenerator.analyzeFile(a.string('filePath'));
      },
    },
    {
      name: 'generate_tests',
      description: '为源代码文件生成可运行的测试代码（支持vitest/jest/mocha，unit/integration/e2e）',
      parameters: {
        filePath: { type: 'string', description: '源代码文件路径', required: true },
        framework: { type: 'string', description: '测试框架 (vitest/jest/mocha，默认vitest)', required: false },
        type: { type: 'string', description: '测试类型 (unit/integration/e2e，默认unit)', required: false },
        outputPath: { type: 'string', description: '输出路径（可选）', required: false },
      },
      readOnly: true,
      execute: async (args) => {
        const a = readArgs(args);
        const result = await modules.testGenerator.generateTests(a.string('filePath'), {
          framework: a.enumOr('framework', ['vitest', 'jest', 'mocha'] as const, 'vitest'),
          type: a.enumOr('type', ['unit', 'integration', 'e2e'] as const, 'unit'),
          outputPath: a.stringOpt('outputPath'),
        });
        try {
          const outputDir = path.dirname(result.testPath);
          const fs = await import('fs');
          await fs.promises.mkdir(outputDir, { recursive: true });
          await fs.promises.writeFile(result.testPath, result.testCode, 'utf-8');
          return `${result.summary}\n✅ 测试文件已写入: ${result.testPath}`;
        } catch (err: unknown) {
          const msg = err instanceof Error ? err.message : String(err);
          return `${result.summary}\n⚠️ 测试文件写入失败: ${msg}\n\n--- 测试代码 ---\n${result.testCode}`;
        }
      },
    },
    {
      name: 'generate_project_test_plan',
      description: '扫描项目目录，为所有源文件生成测试方案概览',
      parameters: {
        projectDir: { type: 'string', description: '项目目录路径', required: false },
      },
      readOnly: true,
      execute: (args) => {
        const a = readArgs(args);
        const dir = a.stringOr('projectDir', process.cwd());
        return modules.testGenerator.generateTestsForProject(dir);
      },
    },
  ];
}

// ============ 文档生成工具定义 ============

export function createDocToolDefs(modules: CoreModules): ToolDef[] {
  return [
    {
      name: 'generate_readme',
      description: '为项目生成 README.md 文档（分析 package.json 和源码结构，用 LLM 生成专业的 README）',
      parameters: {
        projectDir: { type: 'string', description: '项目目录（默认当前目录）', required: false },
      },
      readOnly: true,
      execute: async (args) => {
        const a = readArgs(args);
        const dir = a.stringOr('projectDir', process.cwd());
        const fs = await import('fs');
        const content = await modules.docGenerator.generateREADME(dir);
        const outputPath = path.join(dir, 'README.md');
        await fs.promises.writeFile(outputPath, content, 'utf-8');
        return `✅ README.md 已生成 (${content.length} 字符)\n\n---\n${content.substring(0, 500)}...`;
      },
    },
    {
      name: 'generate_api_docs',
      description: '为指定的源文件生成 API 文档（分析 exports 并生成函数/类/接口文档）',
      parameters: {
        filePath: { type: 'string', description: '源文件路径', required: true },
      },
      readOnly: true,
      execute: (args) => {
        const a = readArgs(args);
        return modules.docGenerator.generateAPIDoc(a.string('filePath'));
      },
    },
    {
      name: 'generate_changelog',
      description: '从 Git 提交记录生成 CHANGELOG.md 变更日志',
      parameters: {
        projectDir: { type: 'string', description: '项目目录（默认当前目录）', required: false },
      },
      readOnly: true,
      execute: async (args) => {
        const a = readArgs(args);
        const dir = a.stringOr('projectDir', process.cwd());
        const fs = await import('fs');
        const content = await modules.docGenerator.generateChangelog(dir);
        const outputPath = path.join(dir, 'CHANGELOG.md');
        await fs.promises.writeFile(outputPath, content, 'utf-8');
        return `✅ CHANGELOG.md 已生成 (${content.length} 字符)`;
      },
    },
    {
      name: 'generate_full_docs',
      description: '一键生成项目完整文档（README + CHANGELOG + API 文档）',
      parameters: {
        projectDir: { type: 'string', description: '项目目录（默认当前目录）', required: false },
      },
      readOnly: true,
      execute: (args) => {
        const a = readArgs(args);
        const dir = a.stringOr('projectDir', process.cwd());
        return modules.docGenerator.writeDocs({ type: 'full' }, dir);
      },
    },
  ];
}

// ============ 图像生成工具定义 ============

export function createImageToolDefs(modules: CoreModules): ToolDef[] {
  return [
    {
      name: 'generate_image',
      description: 'AI 生成图像（内置能力，无需配置 API Key）。根据文本描述生成高质量图像，支持多种风格和尺寸。自动降级策略：DALL-E 3（有 key 时）→ Stable Diffusion（有 key 时）→ Trae 内置（零配置兜底，始终可用）。优先使用此工具而非 libtv_generate_image。',
      parameters: {
        prompt: { type: 'string', description: '图像描述提示词（越详细效果越好）', required: true },
        provider: { type: 'string', description: '生成引擎: dall-e / stable-diffusion / trae（不填则自动选择最佳可用引擎）', required: false },
        width: { type: 'number', description: '图像宽度（默认 1024）', required: false },
        height: { type: 'number', description: '图像高度（默认 1024）', required: false },
        style: { type: 'string', description: '风格: natural（默认）或 vivid', required: false },
      },
      readOnly: true,
      execute: async (args) => {
        const a = readArgs(args);
        const prompt = a.string('prompt');
        const result = await modules.imageGenerator.generate({
          prompt,
          width: a.numberOpt('width'),
          height: a.numberOpt('height'),
          style: a.stringOpt('style'),
        }, a.enumOpt('provider', ['dall-e', 'stable-diffusion', 'trae'] as const));
        if (result.success && result.images.length > 0) {
          return `✅ 图像生成成功！\n\n图像路径:\n${result.images.map((url: string, i: number) => `  ${i + 1}. ${url}`).join('\n')}\n\n提示词: ${prompt.substring(0, 100)}`;
        }
        return `❌ 图像生成失败: ${result.error || '未知错误'}`;
      },
    },
    {
      name: 'generate_image_variations',
      description: '使用 DALL-E 3 生成同一提示词的多个变体',
      parameters: {
        prompt: { type: 'string', description: '图像描述提示词', required: true },
        count: { type: 'number', description: '生成数量（1-4，默认 2）', required: false },
      },
      readOnly: true,
      execute: async (args) => {
        const a = readArgs(args);
        const prompt = a.string('prompt');
        const count = Math.min(Math.max(a.numberOpt('count') ?? 2, 1), 4);
        const results: string[] = [];
        for (let i = 0; i < count; i++) {
          const result = await modules.imageGenerator.generate({ prompt }, 'dall-e');
          if (result.success) results.push(...result.images);
        }
        if (results.length > 0) {
          return `✅ ${results.length} 张图像生成成功！\n\n${results.map((url, i) => `  ${i + 1}. ${url}`).join('\n')}`;
        }
        return '❌ 图像生成失败';
      },
    },
  ];
}
