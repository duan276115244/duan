import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as path from 'path';
import * as os from 'os';
import * as fs from 'fs';
import { EmotionTracker } from '../emotion-tracker.js';

// 每个测试独立 tmpDir，避免共享状态污染；tracker 在 afterEach 中 dispose 避免 saveTimer 跨测试泄漏
describe('EmotionTracker', () => {
  let tracker: EmotionTracker | undefined;
  let tmpDir: string;

  beforeEach(() => {
    // 每个测试创建独立临时目录，避免历史状态污染断言
    tmpDir = path.join(os.tmpdir(), `emotion-test-${process.pid}-${Date.now()}-${Math.random().toString(36).slice(2)}`);
    fs.mkdirSync(tmpDir, { recursive: true });
  });

  afterEach(() => {
    // 清理 saveTimer，避免跨测试泄漏
    if (tracker) tracker.dispose();
    tracker = undefined;
    // 清理临时目录
    try {
      if (tmpDir && fs.existsSync(tmpDir)) {
        fs.rmSync(tmpDir, { recursive: true, force: true });
      }
    } catch {
      // 忽略清理错误
    }
  });

  it('starts in neutral state', () => {
    tracker = new EmotionTracker(tmpDir);
    const state = tracker.state;
    expect(state.primary).toBe('neutral');
    expect(state.intensity).toBeGreaterThanOrEqual(0);
  });

  it('detects happiness on greeting', () => {
    tracker = new EmotionTracker(tmpDir);
    tracker.process({ type: 'greeting', content: '你好' });
    expect(tracker.state.primary).toBe('happy');
  });

  it('detects gratitude on thanks', () => {
    tracker = new EmotionTracker(tmpDir);
    tracker.process({ type: 'thanks', content: '谢谢' });
    expect(tracker.state.primary).toBe('grateful');
  });

  it('detects frustration on error', () => {
    tracker = new EmotionTracker(tmpDir);
    tracker.process({ type: 'error', content: 'API调用失败' });
    expect(tracker.state.primary).toBe('frustrated');
  });

  it('detects curiosity on question', () => {
    tracker = new EmotionTracker(tmpDir);
    tracker.process({ type: 'user_input', content: '这是为什么？' });
    expect(tracker.state.primary).toBe('curious');
  });

  it('tracks emotion history', () => {
    tracker = new EmotionTracker(tmpDir);
    tracker.process({ type: 'greeting', content: '你好' });
    tracker.process({ type: 'error', content: '发生错误' });
    expect(tracker.history_.length).toBe(2);
    expect(tracker.history_[0].primary).toBe('happy');
    expect(tracker.history_[1].primary).toBe('frustrated');
  });

  it('decays emotion over time', () => {
    tracker = new EmotionTracker(tmpDir);
    tracker.process({ type: 'greeting', content: '你好' });
    expect(tracker.state.primary).toBe('happy');
    tracker.decay();
    expect(tracker.state.intensity).toBeLessThan(0.5);
  });

  it('returns emotional prompt string', () => {
    tracker = new EmotionTracker(tmpDir);
    tracker.process({ type: 'thanks', content: '非常感谢' });
    const prompt = tracker.getEmotionalPrompt();
    expect(prompt).toContain('感激');
    expect(prompt).toContain('能量');
  });

  it('detects pride on success', () => {
    tracker = new EmotionTracker(tmpDir);
    tracker.process({ type: 'success', content: '任务成功完成' });
    expect(tracker.state.primary).toBe('proud');
  });

  it('detects confusion on repetitive tasks', () => {
    tracker = new EmotionTracker(tmpDir);
    tracker.process({ type: 'repetitive', content: 'repeated call' });
    expect(tracker.state.primary).toBe('confused');
  });

  it('generates neutral prompt when no emotions processed', () => {
    tracker = new EmotionTracker(tmpDir);
    const prompt = tracker.getEmotionalPrompt();
    expect(prompt).toContain('平静');
  });
});
