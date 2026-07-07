/**
 * 个性化引擎
 * 根据用户特征和历史交互提供定制化服务
 */

import * as fs from 'fs';
import * as path from 'path';
import { duanPath } from './duan-paths.js';
import { atomicWriteJsonSync, atomicWriteJson } from './atomic-write.js';

/**
 * P2-1 修复：持久化路径改为用户级 ~/.duan/personalization/users/
 *
 * 之前使用 <cwd>/.awareness/users/，从不同项目目录启动会得到不同画像，
 * 违背"用户偏好跨会话"设计意图。现在统一使用 duanPath 解析（默认 ~/.duan，
 * 可通过 DUAN_DATA_DIR 环境变量覆盖）。
 */
const DEFAULT_PERSIST_DIR = duanPath('personalization', 'users');

/** 用户画像 */
export interface UserProfile {
  userId: string;
  communicationStyle: 'formal' | 'casual' | 'technical' | 'friendly';
  expertiseLevel: 'beginner' | 'intermediate' | 'advanced' | 'expert';
  preferredLanguages: string[];
  interests: string[];
  interactionPatterns: {
    avgMessageLength: number;
    preferredDetailLevel: 'brief' | 'moderate' | 'detailed';
    prefersCodeExamples: boolean;
    prefersStepByStep: boolean;
  };
  feedbackHistory: Array<{
    positive: boolean;
    context: string;
    timestamp: number;
  }>;
  createdAt: number;
  updatedAt: number;
}

/** 适配后的响应 */
export interface AdaptedResponse {
  content: string;
  style: {
    formality: number; // 0-1
    verbosity: number; // 0-1
    technicalDepth: number; // 0-1
  };
  addedExamples: boolean;
  addedExplanations: boolean;
  suggestedFollowUps: string[];
}

export class PersonalizationEngine {
  private profiles: Map<string, UserProfile> = new Map();
  /** 持久化目录（支持依赖注入） */
  private readonly persistDir: string;

  constructor(options?: { dataDir?: string }) {
    this.persistDir = options?.dataDir
      ? path.join(options.dataDir, 'users')
      : DEFAULT_PERSIST_DIR;
    this.loadAllProfiles();
  }

  /** 创建默认用户画像（每次返回全新对象，避免共享引用） */
  private createDefaultProfile(userId: string): UserProfile {
    return {
      userId,
      communicationStyle: 'friendly',
      expertiseLevel: 'intermediate',
      preferredLanguages: ['TypeScript', 'Python'],
      interests: [],
      interactionPatterns: {
        avgMessageLength: 50,
        preferredDetailLevel: 'moderate',
        prefersCodeExamples: true,
        prefersStepByStep: false,
      },
      feedbackHistory: [],
      createdAt: Date.now(),
      updatedAt: Date.now(),
    };
  }

  private persistPath(userId: string): string {
    return path.join(this.persistDir, `${userId}.json`);
  }

  private saveProfile(userId: string): void {
    const profile = this.profiles.get(userId);
    if (!profile) return;
    try {
      fs.mkdirSync(this.persistDir, { recursive: true });
      atomicWriteJsonSync(this.persistPath(userId), profile);
    } catch {}
  }

  private loadProfile(userId: string): UserProfile | null {
    try {
      return JSON.parse(fs.readFileSync(this.persistPath(userId), 'utf-8'));
    } catch { return null; }
  }

  private loadAllProfiles(): void {
    try {
      if (!fs.existsSync(this.persistDir)) return;
      for (const f of fs.readdirSync(this.persistDir)) {
        if (f.endsWith('.json')) {
          const userId = f.replace('.json', '');
          const profile = this.loadProfile(userId);
          if (profile) this.profiles.set(userId, profile);
        }
      }
    } catch {}
  }

  /** 获取用户偏好摘要（用于注入system prompt） */
  getUserSummary(userId: string): string {
    const p = this.getProfile(userId);
    const detailMap = { brief: '简洁', moderate: '适中', detailed: '详细' };
    return `用户"${userId}"偏好:
  - 沟通风格: ${p.communicationStyle}
  - 专业水平: ${p.expertiseLevel}
  - 详细程度: ${detailMap[p.interactionPatterns.preferredDetailLevel]}
  - 偏好语言: ${p.preferredLanguages.join(', ')}
  - 兴趣领域: ${p.interests.join(', ') || '待发现'}
  - 交互次数: ${p.feedbackHistory.length}`;
  }

  /**
   * 获取用户画像
   */
  getProfile(userId: string): UserProfile {
    return this.profiles.get(userId) || this.createDefaultProfile(userId);
  }

  /**
   * 更新用户画像
   */
  updateProfile(userId: string, updates: Partial<UserProfile>): void {
    const profile = this.getProfile(userId);
    Object.assign(profile, updates, { updatedAt: Date.now() });

    this.profiles.set(userId, profile);
    this.saveProfile(userId);
  }

  /**
   * 从交互中学习用户特征
   */
  learnFromInteraction(userId: string, message: string, response: string, feedback?: 'positive' | 'negative'): void {
    const profile = this.getProfile(userId);

    // 1. 分析消息特征
    const msgLength = message.length;
    profile.interactionPatterns.avgMessageLength =
      (profile.interactionPatterns.avgMessageLength * 0.8) + (msgLength * 0.2);

    // 2. 检测技术深度
    const technicalTerms = this.countTechnicalTerms(message);
    if (technicalTerms > 5) {
      if (profile.expertiseLevel === 'beginner') profile.expertiseLevel = 'intermediate';
      else if (profile.expertiseLevel === 'intermediate') profile.expertiseLevel = 'advanced';
    }

    // 3. 检测偏好语言
    const languages = this.detectLanguages(message);
    for (const lang of languages) {
      if (!profile.preferredLanguages.includes(lang)) {
        profile.preferredLanguages.push(lang);
      }
    }

    // 4. 检测兴趣
    const interests = this.detectInterests(message);
    for (const interest of interests) {
      if (!profile.interests.includes(interest)) {
        profile.interests.push(interest);
      }
    }

    // 5. 记录反馈
    if (feedback) {
      this._applyFeedback(profile, feedback, message, response);
    }

    // 6. 检测沟通风格
    if (message.includes('请') || message.includes('麻烦') || message.includes('能否')) {
      profile.communicationStyle = 'formal';
    } else if (message.includes('帮我') || message.includes('搞一下')) {
      profile.communicationStyle = 'casual';
    }

    profile.updatedAt = Date.now();
    this.profiles.set(userId, profile);
    this.saveProfile(userId);
  }

  /**
   * P2-1: 显式反馈记录入口 — 供 HTTP 端点（/api/feedback）调用
   *
   * 之前 learnFromInteraction 虽接受 feedback 参数，但所有 4 处调用点均不传 feedback，
   * 且 HTTP /api/feedback 端点只路由到 continuousLearning，导致 feedbackHistory 始终为空。
   * 此方法提供独立入口，让反馈回流不再依赖 learnFromInteraction 的调用方。
   */
  recordFeedback(
    userId: string,
    feedback: 'positive' | 'negative',
    context?: string,
    response?: string,
  ): void {
    const profile = this.getProfile(userId);
    this._applyFeedback(profile, feedback, context ?? '', response ?? '');
    this.profiles.set(userId, profile);
    this.saveProfile(userId);
  }

  /**
   * P2-1: 反馈应用核心逻辑 — 提取自 learnFromInteraction，供 recordFeedback 复用
   *
   * 增强点（相比原逻辑）：
   * 1. 滚动截断 feedbackHistory 至 50 条，避免无限增长
   * 2. 基于近 10 条反馈的正负比例动态调整详细程度（非仅单次反馈触发）
   * 3. 连续 3 次负面反馈 → communicationStyle 降级为 'formal'（更稳妥）
   * 4. 连续 3 次正面反馈 → 提升详细程度（用户满意当前风格）
   */
  private _applyFeedback(
    profile: UserProfile,
    feedback: 'positive' | 'negative',
    context: string,
    response: string,
  ): void {
    profile.feedbackHistory.push({
      positive: feedback === 'positive',
      context: (context ?? '').substring(0, 100),
      timestamp: Date.now(),
    });

    // 滚动截断至最近 50 条，避免画像无限膨胀
    if (profile.feedbackHistory.length > 50) {
      profile.feedbackHistory = profile.feedbackHistory.slice(-50);
    }

    // 计算近 10 条反馈的正负比例
    const recent = profile.feedbackHistory.slice(-10);
    const positiveCount = recent.filter(f => f.positive).length;
    const negativeCount = recent.length - positiveCount;

    // 连续 3 次负面：降级详细程度 + 改用正式风格（更稳妥、更克制）
    const last3 = recent.slice(-3);
    if (last3.length === 3 && last3.every(f => !f.positive)) {
      if (profile.interactionPatterns.preferredDetailLevel !== 'brief') {
        profile.interactionPatterns.preferredDetailLevel = 'brief';
      }
      profile.communicationStyle = 'formal';
      return;
    }

    // 连续 3 次正面：提升详细程度（用户满意，可提供更多信息）
    if (last3.length === 3 && last3.every(f => f.positive)) {
      if (profile.interactionPatterns.preferredDetailLevel === 'brief') {
        profile.interactionPatterns.preferredDetailLevel = 'moderate';
      } else if (profile.interactionPatterns.preferredDetailLevel === 'moderate') {
        profile.interactionPatterns.preferredDetailLevel = 'detailed';
      }
      return;
    }

    // 单次反馈的即时调整（保留原逻辑作为快速反馈通道）
    if (feedback === 'negative' && response.length > 500) {
      profile.interactionPatterns.preferredDetailLevel = 'brief';
    } else if (feedback === 'positive' && negativeCount === 0 && positiveCount >= 5) {
      // 累计 5 次正面且无负面：用户对当前详细程度满意
    }
  }

  /**
   * 适配响应风格
   */
  adaptResponse(response: string, userId: string): AdaptedResponse {
    const profile = this.getProfile(userId);

    let adaptedContent = response;

    // 1. 根据专业水平调整
    const addedExplanations = profile.expertiseLevel === 'beginner' || profile.expertiseLevel === 'intermediate';
    if (addedExplanations && this.containsCode(response)) {
      adaptedContent = this.addExplanations(adaptedContent);
    }

    // 2. 根据详细程度偏好调整
    const addedExamples = profile.interactionPatterns.prefersCodeExamples && this.containsCode(response);
    if (profile.interactionPatterns.preferredDetailLevel === 'brief') {
      adaptedContent = this.makeBrief(adaptedContent);
    } else if (profile.interactionPatterns.preferredDetailLevel === 'detailed') {
      adaptedContent = this.addDetails(adaptedContent, profile.interests);
    }

    // 3. 生成后续建议
    const suggestedFollowUps = this.suggestFollowUps(adaptedContent, profile);

    return {
      content: adaptedContent,
      style: {
        formality: this.matchFormality(profile.communicationStyle),
        verbosity: this.matchVerbosity(profile.interactionPatterns.preferredDetailLevel),
        technicalDepth: this.matchDepth(profile.expertiseLevel),
      },
      addedExamples,
      addedExplanations,
      suggestedFollowUps,
    };
  }

  /**
   * 计数技术术语
   */
  private countTechnicalTerms(text: string): number {
    const techTerms = [
      'API', 'REST', 'GraphQL', 'Docker', 'Kubernetes', 'CI/CD', 'ORM',
      'MVC', 'MVVM', 'SSR', 'SSG', 'JWT', 'OAuth', 'WebSocket',
      '微服务', '容器化', '服务网格', '负载均衡', '消息队列',
      'async', 'await', 'Promise', '闭包', '原型链', '递归',
    ];
    return techTerms.filter(term => text.includes(term)).length;
  }

  /**
   * 检测编程语言
   */
  private detectLanguages(text: string): string[] {
    const languages: string[] = [];
    const langMap: Record<string, string[]> = {
      'TypeScript': ['typescript', 'ts', '.ts'],
      'JavaScript': ['javascript', 'js', '.js'],
      'Python': ['python', 'py', '.py'],
      'Go': ['golang', 'go', '.go'],
      'Rust': ['rust', '.rs'],
      'Java': ['java', '.java'],
      'C++': ['c++', 'cpp', '.cpp'],
    };

    const lower = text.toLowerCase();
    for (const [lang, keywords] of Object.entries(langMap)) {
      if (keywords.some(kw => lower.includes(kw))) {
        languages.push(lang);
      }
    }

    return languages;
  }

  /**
   * 检测兴趣
   */
  private detectInterests(text: string): string[] {
    const interests: string[] = [];
    const interestMap: Record<string, string[]> = {
      'Web开发': ['前端', '后端', 'fullstack', 'web'],
      'AI/ML': ['机器学习', '深度学习', 'AI', 'ML', '模型训练'],
      'DevOps': ['运维', '部署', 'CI/CD', 'Docker', 'K8s'],
      '移动开发': ['iOS', 'Android', 'React Native', 'Flutter'],
      '数据库': ['SQL', 'NoSQL', 'MongoDB', 'PostgreSQL', 'Redis'],
      '安全': ['安全', '加密', '认证', '漏洞', '渗透'],
    };

    const lower = text.toLowerCase();
    for (const [interest, keywords] of Object.entries(interestMap)) {
      if (keywords.some(kw => lower.includes(kw.toLowerCase()))) {
        interests.push(interest);
      }
    }

    return interests;
  }

  /**
   * 检查是否包含代码
   */
  private containsCode(text: string): boolean {
    return text.includes('```') || text.includes('function') || text.includes('const ') || text.includes('class ');
  }

  /**
   * 添加解释
   */
  private addExplanations(text: string): string {
    // 在代码块后添加简单解释
    return text.replace(/```(\w+)\n([\s\S]*?)```/g, (match, lang, code) => {
      return `${match}\n\n> 💡 这段${lang}代码的作用是：${this.summarizeCode(code, lang)}`;
    });
  }

  /**
   * 简要描述代码
   */
  private summarizeCode(code: string, lang: string): string {
    // 简单启发式
    if (code.includes('function') || code.includes('=>')) return '定义了一个函数';
    if (code.includes('class ')) return '定义了一个类';
    if (code.includes('import ')) return '导入模块并使用';
    if (code.includes('SELECT')) return '执行数据库查询';
    return `一段${lang}代码`;
  }

  /**
   * 精简内容
   */
  private makeBrief(text: string): string {
    // 保留关键信息，移除详细解释
    const lines = text.split('\n');
    const brief = lines.filter(line =>
      !line.startsWith('>') &&
      !line.startsWith('//') &&
      !line.startsWith('*') &&
      line.trim().length > 0
    );
    return brief.join('\n');
  }

  /**
   * 添加详细信息
   */
  private addDetails(text: string, interests: string[]): string {
    // 基于兴趣添加相关提示
    if (interests.includes('Web开发') && text.includes('React')) {
      return text + '\n\n> 📚 延伸阅读：React 官方文档提供了更多关于此主题的详细说明。';
    }
    return text;
  }

  /**
   * 生成后续建议
   */
  private suggestFollowUps(content: string, profile: UserProfile): string[] {
    const suggestions: string[] = [];

    if (this.containsCode(content)) {
      suggestions.push('需要我解释这段代码吗？');
    }

    if (profile.interests.includes('AI/ML')) {
      suggestions.push('想了解相关的AI应用吗？');
    }

    if (content.includes('错误') || content.includes('error')) {
      suggestions.push('需要帮助调试这个问题吗？');
    }

    return suggestions.slice(0, 3);
  }

  /**
   * 匹配正式程度
   */
  private matchFormality(style: string): number {
    const map: Record<string, number> = { formal: 0.8, casual: 0.3, technical: 0.6, friendly: 0.4 };
    return map[style] || 0.5;
  }

  /**
   * 匹配详细程度
   */
  private matchVerbosity(level: string): number {
    const map: Record<string, number> = { brief: 0.2, moderate: 0.5, detailed: 0.8 };
    return map[level] || 0.5;
  }

  /**
   * 匹配技术深度
   */
  private matchDepth(level: string): number {
    const map: Record<string, number> = { beginner: 0.2, intermediate: 0.4, advanced: 0.7, expert: 0.9 };
    return map[level] || 0.5;
  }

  /**
   * 获取所有用户画像
   */
  getAllProfiles(): UserProfile[] {
    return Array.from(this.profiles.values());
  }

  /**
   * 保存用户画像到文件
   */
  async saveToFile(filePath: string): Promise<void> {
    try {
      const fs = await import('fs/promises');
      const path = await import('path');
      await fs.mkdir(path.dirname(filePath), { recursive: true });
      const data = Array.from(this.profiles.entries());
      await atomicWriteJson(filePath, data);
    } catch (error: unknown) {
      console.error('保存用户画像失败:', error);
    }
  }

  /**
   * 从文件加载用户画像
   */
  async loadFromFile(filePath: string): Promise<void> {
    try {
      const fs = await import('fs/promises');
      const content = await fs.readFile(filePath, 'utf-8');
      const data = JSON.parse(content) as Array<[string, UserProfile]>;
      for (const [userId, profile] of data) {
        this.profiles.set(userId, profile);
      }
    } catch {
      // 文件不存在，忽略
    }
  }
}
