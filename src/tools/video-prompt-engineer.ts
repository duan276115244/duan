import { callLLM } from './llm-caller.js';

export interface ScenePrompt {
  sceneNumber: number;
  description: string;
  imagePrompt: string;
  videoPrompt: string;
  cameraAngle: string;
  cameraMovement: string;
  lighting: string;
  colorPalette: string;
  mood: string;
  transitions: string[];
}

export interface StoryboardScript {
  title: string;
  totalDuration: number;
  scenes: ScenePrompt[];
}

const IMAGE_PROMPT_OPTIMIZER = `你是顶级 AI 视觉提示词工程师，专精于为视频生成模型优化提示词。

优化规则：
1. 必须包含：镜头类型（wide/medium/close-up/aerial/POV）、光线（golden hour/neon/soft diffused/dramatic）、色调（warm/cool/monochrome/high contrast）
2. 使用专业摄影术语：bokeh、depth of field、rule of thirds、leading lines
3. 描述构图、主体位置、背景细节
4. 如果包含角色，描述其表情、姿势、服装
5. 输出纯英文，50-150词
6. 只输出优化后的提示词，不要解释`;

const VIDEO_PROMPT_OPTIMIZER = `你是视频生成提示词优化专家。优化后的提示词能让 Runway Gen-3、Pika、Kling、CogVideoX 等模型生成更高质量的视频。

优化规则：
1. 描述运动方式：camera pan/tilt/dolly/truck/boom/zoom
2. 描述动态变化：particles、weather effects、lighting changes、character movement
3. 指定时间跨度：slow motion、time-lapse、real-time
4. 保持风格一致性：cinematic、documentary、anime、vlog、music video
5. 输出纯英文，30-80词
6. 只输出优化后的提示词`;

const CAMERA_SUGGESTIONS: Record<string, { angles: string[]; movements: string[] }> = {
  '对话': { angles: ['medium shot', 'over-the-shoulder', 'close-up'], movements: ['static', 'subtle zoom'] },
  '动作': { angles: ['wide shot', 'low angle', 'tracking'], movements: ['dynamic pan', 'quick whip', 'handheld'] },
  '风景': { angles: ['wide shot', 'aerial', 'extreme wide'], movements: ['slow dolly', 'crane up', 'panoramic pan'] },
  '室内': { angles: ['medium shot', 'low angle', 'eye level'], movements: ['slight dolly', 'static'] },
  '情感': { angles: ['close-up', 'extreme close-up', 'medium shot'], movements: ['slow push-in', 'subtle handheld'] },
};

export class VideoPromptEngineer {
  async analyzeScript(script: string): Promise<StoryboardScript> {
    const systemPrompt = `你是一个专业视频分镜师。分析用户提供的剧本，生成详细的分镜表。

输出严格 JSON 格式：
{
  "title": "视频标题",
  "totalDuration": 总秒数,
  "scenes": [
    {
      "sceneNumber": 1,
      "description": "场景描述（中文）",
      "cameraAngle": "镜头角度（英文）",
      "cameraMovement": "镜头运动（英文）",
      "lighting": "光线描述（英文）",
      "colorPalette": "色调描述（英文）",
      "mood": "氛围（英文）"
    }
  ]
}

要求：
- 根据剧本内容智能分割场景（每个场景约5-15秒）
- 为每个场景推荐最佳的镜头角度和运动方式
- 至少3个场景，最多12个场景`;

    const result = await callLLM(systemPrompt, `请分析以下剧本并生成分镜表：\n\n${script}`, { temperature: 0.7, maxTokens: 4096 });

    try {
      if (result) {
        const jsonMatch = result.match(/\{[\s\S]*\}/);
        if (jsonMatch) {
          const parsed = JSON.parse(jsonMatch[0]);
          const scenes: ScenePrompt[] = await Promise.all(
            (parsed.scenes || []).map(async (s: { description?: string; cameraAngle?: string; cameraMovement?: string; lighting?: string; colorPalette?: string; mood?: string }, i: number) => {
              const description = s.description || `场景${i + 1}`;
              const cameraAngle = s.cameraAngle || 'medium shot';
              const cameraMovement = s.cameraMovement || 'static';
              const imagePrompt = await this.generateImagePrompt({
                description, cameraAngle, cameraMovement,
                lighting: s.lighting || 'natural', colorPalette: s.colorPalette || 'natural',
                mood: s.mood || 'neutral',
              });
              const videoPrompt = await this.generateVideoPrompt({
                description, cameraAngle, cameraMovement, mood: s.mood || 'neutral',
              });
              return {
                sceneNumber: i + 1,
                description,
                imagePrompt,
                videoPrompt,
                cameraAngle,
                cameraMovement,
                lighting: s.lighting || 'natural',
                colorPalette: s.colorPalette || 'natural',
                mood: s.mood || 'neutral',
                transitions: (() => {
                  if (i === 0) return ['fade-in'];
                  if (i === (parsed.scenes || []).length - 1) return ['fade-out'];
                  return ['dissolve'];
                })(),
              };
            }),
          );
          return { title: parsed.title || '未命名视频', totalDuration: parsed.totalDuration || scenes.length * 8, scenes };
        }
      }
    } catch {}

    return { title: '未命名视频', totalDuration: 30, scenes: this.generateFallbackScenes(3) };
  }

  async generateImagePrompt(scene: {
    description: string; cameraAngle: string; cameraMovement: string;
    lighting: string; colorPalette: string; mood: string;
  }): Promise<string> {
    const prompt = `Generate a detailed image prompt for the following scene:
Description: ${scene.description}
Camera: ${scene.cameraAngle}, ${scene.cameraMovement}
Lighting: ${scene.lighting}
Color: ${scene.colorPalette}
Mood: ${scene.mood}

Apply professional cinematography techniques. Include specific visual details.`;
    const result = await callLLM(IMAGE_PROMPT_OPTIMIZER, prompt, { temperature: 0.7, maxTokens: 256 });
    return result || `${scene.cameraAngle} shot of ${scene.description}, ${scene.lighting} lighting, ${scene.colorPalette} color palette, ${scene.mood} mood, cinematic, 4K`;
  }

  async generateVideoPrompt(scene: {
    description: string; cameraAngle: string; cameraMovement: string; mood: string;
  }): Promise<string> {
    const prompt = `Create a video generation prompt for:
Scene: ${scene.description}
Camera: ${scene.cameraAngle}, ${scene.cameraMovement}
Mood: ${scene.mood}

Describe motion, camera movement over time, and visual transitions.`;
    const result = await callLLM(VIDEO_PROMPT_OPTIMIZER, prompt, { temperature: 0.6, maxTokens: 200 });
    return result || `${scene.cameraMovement} camera, ${scene.description}, ${scene.mood} atmosphere, cinematic quality`;
  }

  async optimizePrompt(input: string, type: 'image' | 'video', style?: string): Promise<string> {
    const system = type === 'image' ? IMAGE_PROMPT_OPTIMIZER : VIDEO_PROMPT_OPTIMIZER;
    const prompt = `Original ${type} prompt: ${input}${style ? `\nStyle: ${style}` : ''}\n\nOptimize this prompt for professional AI ${type} generation.`;
    const result = await callLLM(system, prompt, { temperature: 0.7, maxTokens: 256 });
    return result || input;
  }

  suggestCameraSettings(sceneType: string): { angles: string[]; movements: string[] } {
    for (const [key, value] of Object.entries(CAMERA_SUGGESTIONS)) {
      if (sceneType.includes(key)) return value;
    }
    return { angles: ['medium shot', 'wide shot'], movements: ['static', 'slow pan'] };
  }

  private generateFallbackScenes(count: number): ScenePrompt[] {
    const fallbacks: ScenePrompt[] = [];
    for (let i = 0; i < count; i++) {
      fallbacks.push({
        sceneNumber: i + 1,
        description: `场景${i + 1}`,
        imagePrompt: `cinematic shot ${i + 1}, professional lighting, high detail, 4K`,
        videoPrompt: `smooth camera movement, cinematic atmosphere, scene ${i + 1}`,
        cameraAngle: 'medium shot',
        cameraMovement: 'static',
        lighting: 'natural',
        colorPalette: 'natural',
        mood: 'neutral',
        transitions: (() => {
          if (i === 0) return ['fade-in'];
          if (i === count - 1) return ['fade-out'];
          return ['dissolve'];
        })(),
      });
    }
    return fallbacks;
  }
}
