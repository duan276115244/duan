/**
 * 视频生成引擎
 * 提供流程图生成、分镜提示词生成、角色场景抽图和视频API集成
 */

/** 流程图节点 */
export interface FlowchartNode {
  id: string;
  type: 'start' | 'end' | 'process' | 'decision' | 'io' | 'subprocess';
  label: string;
  x: number;
  y: number;
  style?: { fill?: string; stroke?: string; textColor?: string };
}

/** 流程图连接 */
export interface FlowchartEdge {
  from: string;
  to: string;
  label?: string;
  type?: 'straight' | 'curved' | 'orthogonal';
}

/** 流程图定义 */
export interface Flowchart {
  id: string;
  title: string;
  nodes: FlowchartNode[];
  edges: FlowchartEdge[];
  width: number;
  height: number;
}

/** 分镜项 */
export interface StoryboardItem {
  id: string;
  shotNumber: number;
  duration: number;          // 秒
  description: string;       // 画面描述
  cameraAngle: string;        // 镜头角度
  cameraMovement: string;    // 镜头运动
  dialogue?: string;          // 对话/旁白
  emotion: string;            // 情绪氛围
  transition: string;         // 转场方式
  promptText: string;         // AI视频生成提示词
}

/** 分镜脚本 */
export interface Storyboard {
  id: string;
  title: string;
  description: string;
  totalDuration: number;
  items: StoryboardItem[];
  style: string;             // 视觉风格
  aspectRatio: string;       // 宽高比
  createdAt: number;
}

/** 角色/场景提取结果 */
export interface ExtractionResult {
  characters: {
    name: string;
    description: string;
    appearance: string;
    traits: string[];
    promptHint: string;       // 用于AI生成的提示词片段
  }[];
  scenes: {
    name: string;
    description: string;
    environment: string;
    lighting: string;
    mood: string;
    promptHint: string;
  }[];
  props: {
    name: string;
    description: string;
    promptHint: string;
  }[];
}

/** 视频生成请求 */
export interface VideoGenerationRequest {
  prompt: string;
  style?: string;
  duration?: number;
  aspectRatio?: string;
  model?: string;
}

/** 视频生成结果 */
export interface VideoGenerationResult {
  id: string;
  status: 'pending' | 'processing' | 'completed' | 'failed';
  prompt: string;
  videoUrl?: string;
  thumbnailUrl?: string;
  duration?: number;
  model: string;
  createdAt: number;
  completedAt?: number;
  error?: string;
}

/** 支持的视频AI平台 */
export interface VideoAIPlatform {
  id: string;
  name: string;
  apiEndpoint: string;
  supported: boolean;
  maxDuration: number;
  supportedRatios: string[];
  description: string;
}

export class VideoGenerationEngine {
  private flowcharts: Map<string, Flowchart> = new Map();
  private storyboards: Map<string, Storyboard> = new Map();
  private videoResults: Map<string, VideoGenerationResult> = new Map();
  private platforms: VideoAIPlatform[] = [];

  constructor() {
    this.initializePlatforms();
  }

  /** 初始化视频AI平台 */
  private initializePlatforms(): void {
    this.platforms = [
      {
        id: 'runway',
        name: 'Runway Gen-3',
        apiEndpoint: 'https://api.runwayml.com/v1/generate',
        supported: true,
        maxDuration: 10,
        supportedRatios: ['16:9', '9:16', '1:1'],
        description: 'Runway Gen-3 Alpha，高质量视频生成，支持文本到视频',
      },
      {
        id: 'pika',
        name: 'Pika Labs',
        apiEndpoint: 'https://api.pika.art/v1/generate',
        supported: true,
        maxDuration: 4,
        supportedRatios: ['16:9', '9:16', '1:1'],
        description: 'Pika 1.0，快速视频生成，支持图片驱动',
      },
      {
        id: 'kling',
        name: 'Kling AI (快手)',
        apiEndpoint: 'https://api.klingai.com/v1/videos/generations',
        supported: true,
        maxDuration: 10,
        supportedRatios: ['16:9', '9:16', '1:1'],
        description: 'Kling AI，国产视频生成，中文理解能力强',
      },
      {
        id: 'cogvideox',
        name: 'CogVideoX (智谱)',
        apiEndpoint: 'https://open.bigmodel.cn/api/paas/v4/videos/generations',
        supported: true,
        maxDuration: 6,
        supportedRatios: ['16:9', '9:16'],
        description: '智谱CogVideoX，开源视频生成模型',
      },
      {
        id: 'minimax',
        name: 'MiniMax Video-01',
        apiEndpoint: 'https://api.minimax.chat/v1/video_generation',
        supported: true,
        maxDuration: 6,
        supportedRatios: ['16:9', '9:16', '1:1'],
        description: 'MiniMax Video-01，高保真视频生成',
      },
    ];
  }

  /** 从文本描述生成流程图 */
  generateFlowchart(description: string): Flowchart {
    const nodes: FlowchartNode[] = [];
    const edges: FlowchartEdge[] = [];
    let nodeId = 0;
    const id = `fc_${Date.now()}`;

    // 解析文本中的步骤
    const steps = this.parseSteps(description);
    const startX = 100;
    const startY = 50;
    const verticalGap = 80;

    // 添加开始节点
    nodes.push({
      id: `node_${nodeId++}`,
      type: 'start',
      label: '开始',
      x: startX,
      y: startY,
      style: { fill: '#00ff88', stroke: '#00cc6a', textColor: '#000' },
    });

    // 为每个步骤添加节点
    for (let i = 0; i < steps.length; i++) {
      const step = steps[i];
      const y = startY + (i + 1) * verticalGap;
      const isDecision = step.includes('?') || step.includes('是否') || step.includes('判断');

      nodes.push({
        id: `node_${nodeId++}`,
        type: isDecision ? 'decision' : 'process',
        label: step,
        x: startX,
        y,
        style: isDecision
          ? { fill: '#ffaa00', stroke: '#cc8800', textColor: '#000' }
          : { fill: '#00d9ff', stroke: '#00a8cc', textColor: '#000' },
      });

      // 连接到上一个节点
      edges.push({
        from: nodes[nodes.length - 2].id,
        to: nodes[nodes.length - 1].id,
        type: 'orthogonal',
      });
    }

    // 添加结束节点
    nodes.push({
      id: `node_${nodeId++}`,
      type: 'end',
      label: '结束',
      x: startX,
      y: startY + (steps.length + 1) * verticalGap,
      style: { fill: '#ff6b6b', stroke: '#cc5555', textColor: '#fff' },
    });
    edges.push({
      from: nodes[nodes.length - 2].id,
      to: nodes[nodes.length - 1].id,
      type: 'orthogonal',
    });

    const flowchart: Flowchart = {
      id,
      title: `流程图: ${description.substring(0, 30)}...`,
      nodes,
      edges,
      width: 400,
      height: startY + (steps.length + 2) * verticalGap + 50,
    };

    this.flowcharts.set(id, flowchart);
    return flowchart;
  }

  /** 从文本解析步骤 */
  private parseSteps(text: string): string[] {
    // 按换行、序号、逗号等分割
    const lines = text
      .replace(/第[一二三四五六七八九十]+步[：:]/g, '\n')
      .replace(/\d+[.、）)]\s*/g, '\n')
      .replace(/[；;]/g, '\n')
      .split('\n')
      .map(s => s.trim())
      .filter(s => s.length > 0);

    if (lines.length === 0) {
      // 如果无法解析，按句号分割
      return text.split(/[。！？]/).map(s => s.trim()).filter(s => s.length > 0);
    }

    return lines;
  }

  /** 生成分镜脚本 */
  generateStoryboard(description: string, style: string = '电影感', aspectRatio: string = '16:9'): Storyboard {
    const id = `sb_${Date.now()}`;
    const items: StoryboardItem[] = [];

    // 解析场景
    const scenes = this.parseScenes(description);
    const cameraAngles = ['特写', '中景', '全景', '俯拍', '仰拍', '跟拍', '航拍'];
    const cameraMovements = ['固定', '缓慢推进', '横移', '环绕', '升降', '跟移', '拉远'];
    const transitions = ['硬切', '淡入淡出', '叠化', '划变', '缩放', '模糊'];
    const emotions = ['温馨', '紧张', '神秘', '欢快', '悲伤', '震撼', '平静'];

    let shotNumber = 1;
    for (const scene of scenes) {
      const angle = cameraAngles[shotNumber % cameraAngles.length];
      const movement = cameraMovements[shotNumber % cameraMovements.length];
      const transition = transitions[(shotNumber - 1) % transitions.length];
      const emotion = emotions[shotNumber % emotions.length];

      // 生成AI视频提示词
      const promptText = this.generateVideoPrompt(scene, style, angle, movement, emotion);

      items.push({
        id: `shot_${shotNumber}`,
        shotNumber,
        duration: 3 + Math.floor(Math.random() * 4), // 3-6秒
        description: scene,
        cameraAngle: angle,
        cameraMovement: movement,
        emotion,
        transition,
        promptText,
      });

      shotNumber++;
    }

    const totalDuration = items.reduce((sum, item) => sum + item.duration, 0);

    const storyboard: Storyboard = {
      id,
      title: `分镜脚本: ${description.substring(0, 20)}...`,
      description,
      totalDuration,
      items,
      style,
      aspectRatio,
      createdAt: Date.now(),
    };

    this.storyboards.set(id, storyboard);
    return storyboard;
  }

  /** 解析场景 */
  private parseScenes(text: string): string[] {
    // 按场景标记分割
    const sceneMarkers = ['场景', '镜头', '画面', '第', '幕', '段'];
    let scenes: string[] = [];

    for (const marker of sceneMarkers) {
      if (text.includes(marker)) {
        scenes = text.split(new RegExp(`(?=${marker})`, 'g'))
          .map(s => s.trim())
          .filter(s => s.length > 0);
        break;
      }
    }

    if (scenes.length === 0) {
      // 按句号分割
      scenes = text.split(/[。！？]/).map(s => s.trim()).filter(s => s.length > 0);
    }

    return scenes.length > 0 ? scenes : [text];
  }

  /** 生成AI视频提示词 */
  private generateVideoPrompt(scene: string, style: string, angle: string, movement: string, emotion: string): string {
    return `${style}风格, ${scene}, ${angle}镜头, ${movement}, ${emotion}氛围, 高质量, 4K, 电影级画面, 专业摄影`;
  }

  /** 从文本提取角色和场景 */
  extractCharactersAndScenes(text: string): ExtractionResult {
    const characters: ExtractionResult['characters'] = [];
    const scenes: ExtractionResult['scenes'] = [];
    const props: ExtractionResult['props'] = [];

    // 提取角色（简单启发式）
    const charPatterns = [
      /([\u4e00-\u9fa5]{2,4})(说|喊|问|答|笑|哭|走|跑|看|想)/g,
      /([\u4e00-\u9fa5]{2,4})(穿着|戴着|站在|坐在|拿着)/g,
    ];

    const charSet = new Set<string>();
    for (const pattern of charPatterns) {
      let match;
      while ((match = pattern.exec(text)) !== null) {
        const name = match[1];
        if (!charSet.has(name) && name.length >= 2 && !['他们', '她们', '我们', '你们', '它们', '自己', '大家', '这里', '那里'].includes(name)) {
          charSet.add(name);
          characters.push({
            name,
            description: `文本中提到的角色`,
            appearance: '根据文本描述',
            traits: ['需要进一步分析'],
            promptHint: `${name}, 人物角色, 详细面部特征, 电影级画质`,
          });
        }
      }
    }

    // 提取场景
    const scenePatterns = [
      /在([\u4e00-\u9fa5]{2,8})(里|中|上|下|前|后|旁|边)/g,
      /(森林|城市|海边|山顶|房间|街道|公园|学校|医院|办公室|餐厅|河边|沙漠|雪地|草原|天空|地下)/g,
    ];

    const sceneSet = new Set<string>();
    for (const pattern of scenePatterns) {
      let match;
      while ((match = pattern.exec(text)) !== null) {
        const sceneName = match[1] || match[0];
        if (!sceneSet.has(sceneName)) {
          sceneSet.add(sceneName);
          scenes.push({
            name: sceneName,
            description: `文本中提到的场景`,
            environment: '根据文本描述',
            lighting: '自然光',
            mood: '根据上下文',
            promptHint: `${sceneName}, 场景环境, 详细背景, 电影级画质, 4K`,
          });
        }
      }
    }

    // 提取道具
    const propPatterns = [
      /(剑|枪|书|手机|电脑|车|马|船|灯|钥匙|地图|信|花|树|石头|水|火)/g,
    ];

    const propSet = new Set<string>();
    for (const pattern of propPatterns) {
      let match;
      while ((match = pattern.exec(text)) !== null) {
        if (!propSet.has(match[1])) {
          propSet.add(match[1]);
          props.push({
            name: match[1],
            description: '文本中提到的物品',
            promptHint: `${match[1]}, 物品道具, 详细纹理, 电影级画质`,
          });
        }
      }
    }

    return { characters, scenes, props };
  }

  /** 获取支持的视频AI平台 */
  getPlatforms(): VideoAIPlatform[] {
    return this.platforms;
  }

  /** 生成视频（模拟API调用） */
  generateVideo(request: VideoGenerationRequest): Promise<VideoGenerationResult> {
    const platform = this.platforms.find(p => p.id === (request.model || 'kling')) || this.platforms[0];

    const result: VideoGenerationResult = {
      id: `vid_${Date.now()}`,
      status: 'processing',
      prompt: request.prompt,
      model: platform.name,
      createdAt: Date.now(),
    };

    this.videoResults.set(result.id, result);

    // 模拟视频生成过程
    // 实际生产中这里会调用真实的视频生成API
    setTimeout(() => {
      result.status = 'completed';
      result.videoUrl = `https://example.com/videos/${result.id}.mp4`;
      result.thumbnailUrl = `https://example.com/thumbnails/${result.id}.jpg`;
      result.duration = request.duration || 4;
      result.completedAt = Date.now();
    }, 2000);

    return Promise.resolve(result);
  }

  /** 获取视频生成状态 */
  getVideoStatus(videoId: string): VideoGenerationResult | undefined {
    return this.videoResults.get(videoId);
  }

  /** 获取流程图 */
  getFlowchart(id: string): Flowchart | undefined {
    return this.flowcharts.get(id);
  }

  /** 获取分镜脚本 */
  getStoryboard(id: string): Storyboard | undefined {
    return this.storyboards.get(id);
  }

  /** 获取所有流程图 */
  getAllFlowcharts(): Flowchart[] {
    return [...this.flowcharts.values()];
  }

  /** 获取所有分镜脚本 */
  getAllStoryboards(): Storyboard[] {
    return [...this.storyboards.values()];
  }
}
