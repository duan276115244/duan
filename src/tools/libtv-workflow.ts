import { callLLM } from './llm-caller.js';

interface VideoProject {
  id: string;
  title: string;
  description: string;
  status: 'planning' | 'scripting' | 'storyboard' | 'production' | 'editing' | 'completed';
  createdAt: Date;
  updatedAt: Date;
  script: Script;
  scenes: Scene[];
  assets: Asset[];
}

interface Script {
  title: string;
  synopsis: string;
  characters: Character[];
  acts: Act[];
}

interface Character {
  name: string;
  description: string;
  voice?: string;
}

interface Act {
  id: string;
  title: string;
  scenes: Scene[];
}

interface Scene {
  id: string;
  number: number;
  title: string;
  description: string;
  duration: number;
  cameraAngle?: string;
  background?: string;
  characters: string[];
  dialogues: Dialogue[];
  generated?: boolean;
  videoUrl?: string;
}

interface Dialogue {
  character: string;
  text: string;
  emotion?: string;
}

interface Asset {
  id: string;
  type: 'image' | 'video' | 'audio' | 'text';
  url: string;
  name: string;
}

const SCRIPT_SYSTEM = `你是专业的视频脚本创作专家。根据用户提供的主题，创作结构完整的视频脚本。
输出格式：
## 标题
### 故事梗概
（1-2段）
### 角色
- 角色名: 角色描述
### 第一幕
场景1: 场景描述
角色A：对话内容
角色B：对话内容
场景2: 场景描述
...`;

const STORYBOARD_SYSTEM = `你是专业的AI视频分镜师。根据场景描述生成高质量AI图像生成提示词。
要求：
- 用英文输出（主流AI图像模型对英文理解更好）
- 包含：镜头类型、光线、构图、色调、氛围
- 每个提示词控制在100-200字符
- 输出格式：场景X: 提示词内容`;

export class LibTVWorkFlow {
  private projects: VideoProject[] = [];
  // 项目清理配置：最多保留 50 个项目，超过 1 小时未访问的自动清理
  private readonly MAX_PROJECTS = 50;
  private readonly PROJECT_TTL_MS = 60 * 60 * 1000; // 1 小时

  constructor() {}

  // 清理过期和超量的项目（防止内存泄漏）
  private cleanupProjects(): void {
    const now = Date.now();
    // 1. 移除超过 TTL 未访问的项目（但保留未完成的项目）
    this.projects = this.projects.filter(p => {
      const age = now - (p.updatedAt ? new Date(p.updatedAt).getTime() : now);
      return age < this.PROJECT_TTL_MS || p.status !== 'completed';
    });
    // 2. 如果仍超过上限，移除最早的已完成项目
    if (this.projects.length > this.MAX_PROJECTS) {
      const completed = this.projects.filter(p => p.status === 'completed');
      const toRemove = completed.slice(0, this.projects.length - this.MAX_PROJECTS);
      const removeIds = new Set(toRemove.map(p => p.id));
      this.projects = this.projects.filter(p => !removeIds.has(p.id));
    }
  }

  createProject(title: string, description: string): Promise<VideoProject> {
    // 创建新项目前先清理过期项目
    this.cleanupProjects();
    const project: VideoProject = {
      id: `proj_${Date.now()}`,
      title,
      description,
      status: 'planning',
      createdAt: new Date(),
      updatedAt: new Date(),
      script: { title, synopsis: '', characters: [], acts: [] },
      scenes: [],
      assets: [],
    };
    this.projects.push(project);
    return Promise.resolve(project);
  }

  async generateScript(projectId: string, prompt: string): Promise<string> {
    const project = this.projects.find(p => p.id === projectId);
    if (!project) return `项目 ${projectId} 不存在`;

    const userPrompt = `请为主题"${prompt}"创作一个完整的视频脚本。
要求：
1. 故事梗概
2. 至少3个角色，每个角色有性格描述
3. 3-5幕，每幕2-4个场景
4. 每个场景有对话和动作描述
5. 总时长建议3-5分钟`;

    let script: string;
    try {
      script = await callLLM(SCRIPT_SYSTEM, userPrompt, { temperature: 0.8, maxTokens: 4096 });
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      return `❌ AI 调用失败: ${msg || '未知错误'}。请检查 API Key 配置和网络连接。`;
    }
    if (!script || !script.trim()) return '❌ AI 返回空内容，请重试';

    project.script = this.parseScript(script);
    project.status = 'scripting';
    project.updatedAt = new Date();
    return script;
  }

  private parseScript(scriptText: string): Script {
    const lines = scriptText.split('\n');
    const script: Script = { title: '', synopsis: '', characters: [], acts: [] };
    let currentAct: Act | null = null;
    let currentScene: Scene | null = null;

    // 修复：使用循环索引 i 替代 indexOf，避免重复行导致解析错乱
    for (let i = 0; i < lines.length; i++) {
      const line = lines[i];
      const trimmed = line.trim();
      if (!trimmed) continue;

      if (trimmed.startsWith('## ')) {
        script.title = trimmed.substring(3);
      } else if (trimmed.startsWith('### 故事梗概')) {
        const synopsisLines: string[] = [];
        for (let j = i + 1; j < lines.length; j++) {
          const l = lines[j].trim();
          if (l.startsWith('###') || l.startsWith('## ')) break;
          if (l) synopsisLines.push(l);
        }
        script.synopsis = synopsisLines.join(' ');
      } else if (trimmed.startsWith('### 角色')) {
        for (let j = i + 1; j < lines.length; j++) {
          const l = lines[j].trim();
          if (l.startsWith('###') || l.startsWith('## ')) break;
          if (!l) continue;
          const match = l.match(/^[-*]\s*(.+?)\s*[:：]\s*(.+)/);
          if (match) {
            script.characters.push({ name: match[1].trim(), description: match[2].trim() });
          }
        }
      } else if (/^第[一二三四五六七八九十]+幕/.test(trimmed) || /^Act\s+\d+/.test(trimmed)) {
        if (currentAct) script.acts.push(currentAct);
        currentAct = { id: `act_${script.acts.length + 1}`, title: trimmed, scenes: [] };
        currentScene = null;
      } else if (/^场景\d+[：:]/.test(trimmed) || /^Scene\s+\d+/.test(trimmed)) {
        if (currentScene && currentAct) currentAct.scenes.push(currentScene);
        const descMatch = trimmed.replace(/^场景\d+[：:]\s*/, '').replace(/^Scene\s+\d+[：:]\s*/i, '');
        currentScene = {
          id: `scene_${Date.now()}_${(currentAct?.scenes.length || 0) + 1}`,
          number: (currentAct?.scenes.length || 0) + 1,
          title: descMatch || trimmed,
          description: descMatch || '',
          duration: 5,
          characters: [],
          dialogues: [],
        };
      } else if (currentScene) {
        const dialogueMatch = trimmed.match(/^[-*]\s*(.+?)\s*[:：]\s*(.+)/);
        if (dialogueMatch) {
          const char = dialogueMatch[1].trim();
          const text = dialogueMatch[2].trim();
          currentScene.dialogues.push({ character: char, text });
          if (!currentScene.characters.includes(char)) currentScene.characters.push(char);
        } else {
          currentScene.description += (currentScene.description ? ' ' : '') + trimmed;
        }
      }
    }

    if (currentScene && currentAct) currentAct.scenes.push(currentScene);
    if (currentAct) script.acts.push(currentAct);

    return script;
  }

  async generateStoryboard(projectId: string): Promise<string> {
    const project = this.projects.find(p => p.id === projectId);
    if (!project) return `项目 ${projectId} 不存在`;

    // 优化：并行生成所有场景的图像提示词，大幅提升速度
    const allScenes: Array<{ act: Act; scene: Scene }> = [];
    for (const act of project.script.acts) {
      for (const scene of act.scenes) {
        allScenes.push({ act, scene });
      }
    }

    // 并行调用 LLM，限制并发数为 4 避免触发速率限制
    const CONCURRENCY = 4;
    const prompts: string[] = new Array(allScenes.length);

    for (let start = 0; start < allScenes.length; start += CONCURRENCY) {
      const batch = allScenes.slice(start, start + CONCURRENCY);
      const results = await Promise.allSettled(batch.map(async ({ scene }, _idx) => {
        const userPrompt = `根据以下场景信息生成AI图像提示词（英文）：
场景：${scene.title}
描述：${scene.description}
角色：${scene.characters.join(', ')}
对话：${scene.dialogues.map(d => `${d.character}: ${d.text}`).join('; ')}`;

        try {
          const imagePrompt = await callLLM(STORYBOARD_SYSTEM, userPrompt, { temperature: 0.7, maxTokens: 512 });
          return `场景${scene.number}: ${(imagePrompt || 'A cinematic shot of the scene').trim()}`;
        } catch (err: unknown) {
          const msg = err instanceof Error ? err.message : String(err);
          return `场景${scene.number}: [生成失败: ${msg || '未知错误'}] A cinematic shot of the scene`;
        }
      }));
      results.forEach((r, idx) => {
        const sceneIdx = start + idx;
        prompts[sceneIdx] = r.status === 'fulfilled' ? r.value : `场景${batch[idx].scene.number}: [生成失败] A cinematic shot of the scene`;
      });
    }

    project.status = 'storyboard';
    project.updatedAt = new Date();
    return prompts.join('\n\n');
  }

  generateScenes(projectId: string): Promise<string> {
    const project = this.projects.find(p => p.id === projectId);
    if (!project) return Promise.resolve(`项目 ${projectId} 不存在`);

    project.status = 'production';
    project.updatedAt = new Date();

    const results: string[] = [];
    for (const act of project.script.acts) {
      for (const scene of act.scenes) {
        scene.generated = true;
        scene.videoUrl = `https://libtv.example.com/scene/${scene.id}.mp4`;
        results.push(`场景${scene.number}: 已加入渲染队列`);
      }
    }
    return Promise.resolve(results.join('\n'));
  }

  editVideo(projectId: string, edits: string): Promise<string> {
    const project = this.projects.find(p => p.id === projectId);
    if (!project) return Promise.resolve(`项目 ${projectId} 不存在`);
    project.status = 'editing';
    project.updatedAt = new Date();
    return Promise.resolve(`已应用编辑：${edits}\n视频正在渲染中...`);
  }

  renderVideo(projectId: string): Promise<string> {
    const project = this.projects.find(p => p.id === projectId);
    if (!project) return Promise.resolve(`项目 ${projectId} 不存在`);
    project.status = 'completed';
    project.updatedAt = new Date();
    return Promise.resolve(`🎉 视频渲染完成！\n项目: ${project.title}\n输出: https://libtv.example.com/output/${project.id}.mp4`);
  }

  getProjectStatus(projectId: string): Promise<string> {
    const project = this.projects.find(p => p.id === projectId);
    if (!project) return Promise.resolve(`项目 ${projectId} 不存在`);
    const scenes = project.script.acts.flatMap(a => a.scenes);
    const generatedScenes = scenes.filter(s => s.generated).length;
    return Promise.resolve([
      `📊 项目状态: ${project.title}`,
      `状态: ${project.status}`,
      `📝 脚本: ${project.script.characters.length} 角色, ${project.script.acts.length} 幕`,
      `🎬 场景: ${scenes.length} 个 (已生成: ${generatedScenes})`,
      ...scenes.map(s => `  ${s.number}. ${s.title} ${s.generated ? '✓' : '○'}`),
    ].join('\n'));
  }

  listProjects(): string {
    if (this.projects.length === 0) return '暂无项目';
    return this.projects.map(p => {
      const scenes = p.script.acts.flatMap(a => a.scenes);
      return `📁 ${p.title} (${p.status})  场景: ${scenes.length}`;
    }).join('\n\n');
  }
}
