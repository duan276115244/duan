import { describe, it, expect } from 'vitest';
import * as path from 'path';
import * as os from 'os';
import { EmotionTracker } from '../emotion-tracker.js';

// P0 D4.3 修复：使用唯一临时目录避免持久化状态干扰测试
// EmotionTracker 构造函数会调用 load() 加载 ~/.duan/emotion/emotion-state.json，
// 如果之前运行过，history 会被预填充，导致 history_.length 断言失败
const tmpDir = path.join(os.tmpdir(), `emotion-test-${process.pid}-${Date.now()}`);

describe('EmotionTracker', () => {
  it('starts in neutral state', () => {
    const tracker = new EmotionTracker(tmpDir);
    const state = tracker.state;
    expect(state.primary).toBe('neutral');
    expect(state.intensity).toBeGreaterThanOrEqual(0);
  });

  it('detects happiness on greeting', () => {
    const tracker = new EmotionTracker(tmpDir);
    tracker.process({ type: 'greeting', content: '你好' });
    expect(tracker.state.primary).toBe('happy');
  });

  it('detects gratitude on thanks', () => {
    const tracker = new EmotionTracker(tmpDir);
    tracker.process({ type: 'thanks', content: '谢谢' });
    expect(tracker.state.primary).toBe('grateful');
  });

  it('detects frustration on error', () => {
    const tracker = new EmotionTracker(tmpDir);
    tracker.process({ type: 'error', content: 'API调用失败' });
    expect(tracker.state.primary).toBe('frustrated');
  });

  it('detects curiosity on question', () => {
    const tracker = new EmotionTracker(tmpDir);
    tracker.process({ type: 'user_input', content: '这是为什么？' });
    expect(tracker.state.primary).toBe('curious');
  });

  it('tracks emotion history', () => {
    const tracker = new EmotionTracker(tmpDir);
    tracker.process({ type: 'greeting', content: '你好' });
    tracker.process({ type: 'error', content: '发生错误' });
    expect(tracker.history_.length).toBe(2);
    expect(tracker.history_[0].primary).toBe('happy');
    expect(tracker.history_[1].primary).toBe('frustrated');
  });

  it('decays emotion over time', () => {
    const tracker = new EmotionTracker(tmpDir);
    tracker.process({ type: 'greeting', content: '你好' });
    expect(tracker.state.primary).toBe('happy');
    tracker.decay();
    expect(tracker.state.intensity).toBeLessThan(0.5);
  });

  it('returns emotional prompt string', () => {
    const tracker = new EmotionTracker(tmpDir);
    tracker.process({ type: 'thanks', content: '非常感谢' });
    const prompt = tracker.getEmotionalPrompt();
    expect(prompt).toContain('感激');
    expect(prompt).toContain('能量');
  });

  it('detects pride on success', () => {
    const tracker = new EmotionTracker(tmpDir);
    tracker.process({ type: 'success', content: '任务成功完成' });
    expect(tracker.state.primary).toBe('proud');
  });

  it('detects confusion on repetitive tasks', () => {
    const tracker = new EmotionTracker(tmpDir);
    tracker.process({ type: 'repetitive', content: 'repeated call' });
    expect(tracker.state.primary).toBe('confused');
  });

  it('generates neutral prompt when no emotions processed', () => {
    const tracker = new EmotionTracker(tmpDir);
    const prompt = tracker.getEmotionalPrompt();
    expect(prompt).toContain('平静');
  });
});
