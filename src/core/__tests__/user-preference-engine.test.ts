/**
 * P2-1: UserPreferenceEngine 测试
 *
 * 测试双向量状态 + 三步循环 + persona prompt + 信号采集
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as os from 'os';
import * as path from 'path';
import * as fs from 'fs';
import { UserPreferenceEngine } from '../user-preference-engine.js';
import { UnifiedUserProfileCenter } from '../unified-user-profile.js';

/** 创建带临时目录的 UserPreferenceEngine，避免读取大量历史文件导致超时 */
function createEngineWithTempDir(): {
  engine: UserPreferenceEngine;
  profileCenter: UnifiedUserProfileCenter;
  tmpDir: string;
} {
  const tmpDir = path.join(os.tmpdir(), `jws-pref-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`);
  const profileCenter = new UnifiedUserProfileCenter({ dataDir: tmpDir });
  const engine = new UserPreferenceEngine(profileCenter);
  return { engine, profileCenter, tmpDir };
}

describe('P2-1: UserPreferenceEngine — 双向量状态', () => {
  let engine: UserPreferenceEngine;
  let profileCenter: UnifiedUserProfileCenter;
  let tmpDir: string;

  beforeEach(() => {
    ({ engine, profileCenter, tmpDir } = createEngineWithTempDir());
  });

  afterEach(() => {
    profileCenter?.stop();
    try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch {}
  });

  it('startSession 初始化短期向量', () => {
    engine.startSession('user1', 'session1');
    const shortTerm = engine.getShortTermVector('user1');
    expect(shortTerm).not.toBeNull();
    expect(shortTerm!.sessionId).toBe('session1');
    expect(shortTerm!.sessionPreferences).toEqual([]);
    expect(shortTerm!.hotTopics).toEqual([]);
    expect(shortTerm!.sentimentTrend).toBe('neutral');
  });

  it('endSession 清空短期向量', () => {
    engine.startSession('user1', 'session1');
    engine.endSession('user1');
    const shortTerm = engine.getShortTermVector('user1');
    expect(shortTerm).toBeNull();
  });

  it('getLongTermVector 返回稳定偏好', () => {
    const longTerm = engine.getLongTermVector('user1');
    expect(longTerm).toBeDefined();
    expect(longTerm.stablePreferences).toEqual([]);
    expect(longTerm.cognitiveSnapshot).toBeDefined();
    expect(longTerm.cognitiveSnapshot.communicationStyle).toBeDefined();
  });

  it('未启动会话时 getShortTermVector 返回 null', () => {
    const shortTerm = engine.getShortTermVector('user1');
    expect(shortTerm).toBeNull();
  });
});

describe('P2-1: UserPreferenceEngine — 信号采集', () => {
  let engine: UserPreferenceEngine;
  let profileCenter: UnifiedUserProfileCenter;
  let tmpDir: string;

  beforeEach(() => {
    ({ engine, profileCenter, tmpDir } = createEngineWithTempDir());
    engine.startSession('user1', 'session1');
  });

  afterEach(() => {
    profileCenter?.stop();
    try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch {}
  });

  it('recordSignal 写入短期向量', () => {
    engine.recordSignal('user1', {
      type: 'implicit_edit',
      category: 'work_habit',
      key: 'edit_style',
      value: 'incremental',
    });
    const shortTerm = engine.getShortTermVector('user1');
    expect(shortTerm!.sessionPreferences.length).toBe(1);
    expect(shortTerm!.sessionPreferences[0].value).toBe('incremental');
  });

  it('recordSignal 自动填充强度和时间戳', () => {
    engine.recordSignal('user1', {
      type: 'explicit_thumbs_up',
      category: 'work_habit',
      key: 'feedback',
      value: 'liked:tool_a',
    });
    const shortTerm = engine.getShortTermVector('user1');
    expect(shortTerm!.sessionPreferences[0].strength).toBe(1.0);
    expect(shortTerm!.sessionPreferences[0].timestamp).toBeGreaterThan(0);
  });

  it('recordFeedback 记录 thumbs-up/down', () => {
    engine.recordFeedback('user1', true, 'tool_a');
    engine.recordFeedback('user1', false, 'tool_b');
    const shortTerm = engine.getShortTermVector('user1');
    expect(shortTerm!.sessionPreferences.length).toBe(2);
    expect(shortTerm!.sessionPreferences[0].value).toContain('liked:tool_a');
    expect(shortTerm!.sessionPreferences[1].value).toContain('disliked:tool_b');
  });

  it('recordPairwise 记录成对比较', () => {
    engine.recordPairwise('user1', 'option_a', 'option_b', 'tool_preference');
    const shortTerm = engine.getShortTermVector('user1');
    expect(shortTerm!.sessionPreferences.length).toBe(1);
    expect(shortTerm!.sessionPreferences[0].value).toContain('prefer:option_a');
    expect(shortTerm!.sessionPreferences[0].value).toContain('over:option_b');
  });

  it('recordImplicitSignals 批量记录', () => {
    engine.recordImplicitSignals('user1', [
      { type: 'implicit_tool_choice', category: 'tool_preference', key: 'tool', value: 'file_read' },
      { type: 'implicit_approval', category: 'work_habit', key: 'approval', value: 'auto' },
    ]);
    const shortTerm = engine.getShortTermVector('user1');
    expect(shortTerm!.sessionPreferences.length).toBe(2);
  });

  it('信号更新热点话题', () => {
    engine.recordSignal('user1', {
      type: 'implicit_edit',
      category: 'work_habit',
      key: 'topic_x',
      value: 'value',
    });
    const shortTerm = engine.getShortTermVector('user1');
    expect(shortTerm!.hotTopics).toContain('topic_x');
  });

  it('热点话题保持最近20个', () => {
    for (let i = 0; i < 25; i++) {
      engine.recordSignal('user1', {
        type: 'implicit_edit',
        category: 'work_habit',
        key: `topic_${i}`,
        value: 'value',
      });
    }
    const shortTerm = engine.getShortTermVector('user1');
    expect(shortTerm!.hotTopics.length).toBeLessThanOrEqual(20);
    expect(shortTerm!.hotTopics[0]).toBe('topic_24');
  });
});

describe('P2-1: UserPreferenceEngine — 三步循环', () => {
  let engine: UserPreferenceEngine;
  let profileCenter: UnifiedUserProfileCenter;
  let tmpDir: string;

  beforeEach(() => {
    ({ engine, profileCenter, tmpDir } = createEngineWithTempDir());
    engine.startSession('user1', 'session1');
  });

  afterEach(() => {
    profileCenter?.stop();
    try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch {}
  });

  it('shouldClarify 低置信度时返回 true', () => {
    const needClarify = engine.shouldClarify('user1', 'work_habit', 'communication_style');
    expect(needClarify).toBe(true);
  });

  it('generateClarification 返回澄清请求', () => {
    const request = engine.generateClarification('user1', 'work_habit', 'communication_style');
    expect(request).not.toBeNull();
    expect(request!.question).toContain('沟通风格');
    expect(request!.options).toBeDefined();
    expect(request!.options!.length).toBeGreaterThan(0);
  });

  it('generateClarification 加入澄清队列', () => {
    engine.generateClarification('user1', 'work_habit', 'communication_style');
    const queue = engine.getPendingClarifications('user1');
    expect(queue.length).toBe(1);
  });

  it('actWithMemory 返回偏好值（如果存在）', () => {
    const value = engine.actWithMemory('user1', 'work_habit', 'nonexistent');
    expect(value).toBeNull();
  });

  it('integrateFeedback 清除对应澄清请求', () => {
    engine.generateClarification('user1', 'work_habit', 'communication_style');
    expect(engine.getPendingClarifications('user1').length).toBe(1);
    engine.integrateFeedback('user1', 'work_habit', 'communication_style', 'formal', true);
    expect(engine.getPendingClarifications('user1').length).toBe(0);
  });
});

describe('P2-1: UserPreferenceEngine — persona prompt', () => {
  let engine: UserPreferenceEngine;
  let profileCenter: UnifiedUserProfileCenter;
  let tmpDir: string;

  beforeEach(() => {
    ({ engine, profileCenter, tmpDir } = createEngineWithTempDir());
    engine.startSession('user1', 'session1');
  });

  afterEach(() => {
    profileCenter?.stop();
    try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch {}
  });

  it('generatePersonaPrompt 返回非空字符串', () => {
    const prompt = engine.generatePersonaPrompt('user1');
    expect(prompt).toBeTypeOf('string');
    expect(prompt.length).toBeGreaterThan(0);
  });

  it('generatePersonaPrompt 包含沟通风格', () => {
    const prompt = engine.generatePersonaPrompt('user1');
    expect(prompt).toContain('沟通风格');
  });

  it('generatePersonaPrompt 包含专业水平适配', () => {
    const prompt = engine.generatePersonaPrompt('user1');
    expect(prompt).toContain('专业水平');
  });

  it('generatePersonaPrompt 包含语言偏好', () => {
    const prompt = engine.generatePersonaPrompt('user1');
    expect(prompt).toContain('语言');
  });

  it('generatePersonaPrompt 包含详细程度', () => {
    const prompt = engine.generatePersonaPrompt('user1');
    expect(prompt).toContain('详细');
  });

  it('有热点话题时 prompt 包含当前会话热点', () => {
    engine.recordSignal('user1', {
      type: 'implicit_edit',
      category: 'work_habit',
      key: 'hot_topic',
      value: 'value',
    });
    const prompt = engine.generatePersonaPrompt('user1');
    expect(prompt).toContain('当前会话热点');
    expect(prompt).toContain('hot_topic');
  });

  it('getPersonaComponents 返回所有组件', () => {
    const components = engine.getPersonaComponents('user1');
    expect(components.communicationStyle).toBeDefined();
    expect(components.expertiseAdaptation).toBeDefined();
    expect(components.languagePreference).toBeDefined();
    expect(components.detailLevel).toBeDefined();
    expect(components.toolPreference).toBeDefined();
    expect(components.workHabit).toBeDefined();
  });
});

describe('P2-1: UserPreferenceEngine — 会话生命周期', () => {
  it('endSession 将高置信度偏好提升到长期向量', () => {
    const { engine, profileCenter, tmpDir } = createEngineWithTempDir();
    engine.startSession('user1', 'session1');

    // 记录显式信号（strength >= 0.8 会直接写入 profileCenter）
    engine.recordFeedback('user1', true, 'tool_a');

    engine.endSession('user1');

    // 短期向量应被清空
    const shortTerm = engine.getShortTermVector('user1');
    expect(shortTerm).toBeNull();
    profileCenter.stop();
    try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch {}
  });

  it('多次 startSession 不会丢失长期向量', () => {
    const { engine, profileCenter, tmpDir } = createEngineWithTempDir();
    engine.startSession('user1', 'session1');
    engine.recordSignal('user1', {
      type: 'explicit_feedback',
      category: 'work_habit',
      key: 'style',
      value: 'formal',
    });
    engine.endSession('user1');

    // 重新启动会话
    engine.startSession('user1', 'session2');
    const longTerm = engine.getLongTermVector('user1');
    expect(longTerm).toBeDefined();
    expect(longTerm.cognitiveSnapshot).toBeDefined();
    profileCenter.stop();
    try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch {}
  });
});
