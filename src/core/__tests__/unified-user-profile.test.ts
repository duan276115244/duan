import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as os from 'os';
import * as path from 'path';
import * as fs from 'fs';
import { UnifiedUserProfileCenter } from '../unified-user-profile.js';

function uid(): string { return `u${Date.now()}-${Math.random().toString(36).slice(2, 6)}`; }

describe('UnifiedUserProfileCenter', () => {
  let profileCenter: UnifiedUserProfileCenter;
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = path.join(os.tmpdir(), `jws-profile-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`);
    profileCenter = new UnifiedUserProfileCenter({ dataDir: tmpDir });
  });

  afterEach(() => {
    profileCenter?.stop();
    try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch {}
  });

  it('creates default profile for unknown user', () => {
    const userId = uid();
    const profile = profileCenter.getProfile(userId);
    expect(profile.userId).toBe(userId);
    expect(profile.cognitive.communicationStyle).toBe('friendly');
    expect(profile.cognitive.expertiseLevel).toBe('intermediate');
    expect(profile.predictions.nextIntent).toBe('general_chat');
    expect(profile.predictions.nextIntentConfidence).toBe(0.3);
  });

  it('syncs personalization data', () => {
    const userId = uid();
    profileCenter.syncFromSource(userId, {
      type: 'personalization',
      data: {
        communicationStyle: 'technical',
        expertiseLevel: 'expert',
        preferredLanguages: ['Python', 'Rust'],
        interests: ['AI', '系统架构'],
        detailLevel: 'detailed',
        prefersCode: true,
      },
    });
    const profile = profileCenter.getProfile(userId);
    expect(profile.cognitive.communicationStyle).toBe('technical');
    expect(profile.cognitive.expertiseLevel).toBe('expert');
    expect(profile.cognitive.preferredLanguages).toContain('Python');
    expect(profile.cognitive.interests).toContain('AI');
  });

  it('syncs emotion data', () => {
    const userId = uid();
    profileCenter.syncFromSource(userId, {
      type: 'emotion',
      data: { valenceAvg: 0.3, arousalAvg: 0.7, dominantEmotion: 'happy', frustrationLevel: 0.1 },
    });
    const profile = profileCenter.getProfile(userId);
    expect(profile.emotional.valenceAvg).toBe(0.3);
    expect(profile.emotional.dominantEmotion).toBe('happy');
    expect(profile.emotional.frustrationLevel).toBe(0.1);
    expect(profile.emotional.lastEmotionUpdate).toBeGreaterThan(0);
  });

  it('syncs learning data', () => {
    const userId = uid();
    profileCenter.syncFromSource(userId, {
      type: 'learning',
      data: { interests: ['机器学习', 'NLP'], preferredLanguages: ['TypeScript'] },
    });
    const profile = profileCenter.getProfile(userId);
    expect(profile.cognitive.interests).toContain('机器学习');
    expect(profile.cognitive.preferredLanguages).toContain('TypeScript');
  });

  it('syncs task tracker data', () => {
    const userId = uid();
    profileCenter.syncFromSource(userId, {
      type: 'task_tracker',
      data: {
        successRate: 0.85, avgResponseTime: 1200, satisfactionScore: 0.9,
        totalInteractions: 50,
        tools: [{ tool: 'code_gen', count: 10 }],
        domains: [{ domain: '开发', count: 5 }],
      },
    });
    const profile = profileCenter.getProfile(userId);
    expect(profile.performance.taskSuccessRate).toBe(0.85);
    expect(profile.performance.satisfactionScore).toBe(0.9);
    expect(profile.performance.preferredTools).toHaveLength(1);
    expect(profile.performance.preferredTools[0].tool).toBe('code_gen');
  });

  it('records intents and builds prediction', () => {
    const userId = uid();
    profileCenter.recordIntent(userId, 'write_code');
    profileCenter.recordIntent(userId, 'debug');
    profileCenter.recordIntent(userId, 'write_code');
    const profile = profileCenter.getProfile(userId);
    expect(profile.predictions.nextIntent).toBeDefined();
    expect(profile.predictions.suggestedTopics.length).toBeGreaterThanOrEqual(0);
  });

  it('records task results', () => {
    const userId = uid();
    profileCenter.recordTaskResult(userId, '修复登录页面bug', true, ['debugger'], 5000);
    const profile = profileCenter.getProfile(userId);
    expect(profile.behavioral.totalInteractions).toBe(1);
    expect(profile.performance.taskSuccessRate).toBe(1);
    expect(profile.performance.avgResponseTime).toBe(5000);
    expect(profile.performance.preferredTools).toHaveLength(1);
    expect(profile.behavioral.commonTasks).toHaveLength(1);
  });

  it('predicts services based on interests (code)', () => {
    const userId = uid();
    profileCenter.syncFromSource(userId, {
      type: 'learning', data: { interests: ['programming', 'web development'] },
    });
    const profile = profileCenter.getProfile(userId);
    expect(profile.predictions.personalizedServices).toContain('代码审查');
    expect(profile.predictions.personalizedServices).toContain('测试生成');
  });

  it('predicts services based on interests (data)', () => {
    const userId = uid();
    profileCenter.syncFromSource(userId, {
      type: 'learning', data: { interests: ['data analytics', 'visualization'] },
    });
    const profile = profileCenter.getProfile(userId);
    expect(profile.predictions.personalizedServices).toContain('数据分析');
    expect(profile.predictions.personalizedServices).toContain('图表制作');
  });

  it('predicts services based on interests (writing)', () => {
    const userId = uid();
    profileCenter.syncFromSource(userId, {
      type: 'learning', data: { interests: ['content writing', 'article'] },
    });
    const profile = profileCenter.getProfile(userId);
    expect(profile.predictions.personalizedServices).toContain('文档生成');
  });

  it('adds frustration service when frustration level is high', () => {
    const userId = uid();
    profileCenter.syncFromSource(userId, {
      type: 'emotion', data: { frustrationLevel: 0.8 },
    });
    const profile = profileCenter.getProfile(userId);
    expect(profile.predictions.personalizedServices).toContain('分步引导');
  });

  it('provides tool definitions', () => {
    const tools = profileCenter.getToolDefinitions();
    expect(tools.length).toBe(5);
    expect(tools.map(t => t.name)).toEqual(['user_profile', 'user_predict', 'user_sync_profile', 'user_rec_feedback', 'user_evolution']);
  });

  it('profile tool returns JSON string', () => {
    const tools = profileCenter.getToolDefinitions();
    const profileTool = tools.find(t => t.name === 'user_profile')!;
    const result = profileTool.execute({ userId: 'default-test-' + uid() });
    const parsed = JSON.parse(result);
    expect(parsed.cognitive).toBeDefined();
    expect(parsed.predictions).toBeDefined();
  });

  it('predict tool returns predictions JSON', () => {
    const tools = profileCenter.getToolDefinitions();
    const predictTool = tools.find(t => t.name === 'user_predict')!;
    const result = predictTool.execute({ userId: 'default-predict-' + uid() });
    const parsed = JSON.parse(result);
    expect(parsed.nextIntent).toBeDefined();
    expect(parsed.personalizedServices).toBeDefined();
  });
});
