import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { CognitiveState, type Mood } from '../cognitive-state.js';

describe('CognitiveState', () => {
  let cs: CognitiveState;
  let tmpDir: string;
  let persistPath: string;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'duan-cogstate-'));
    persistPath = path.join(tmpDir, 'cognitive-state.json');
    cs = new CognitiveState(persistPath);
  });

  afterEach(() => {
    // EPERM 重试：Windows 并发 I/O 下目录可能瞬时锁定
    for (let i = 0; i < 5; i++) {
      try {
        fs.rmSync(tmpDir, { recursive: true, force: true });
        break;
      } catch {
        const start = Date.now();
        while (Date.now() - start < 50) { /* busy-wait 50ms */ }
      }
    }
  });

  describe('初始状态', () => {
    it('默认状态: mood=focused, consciousness=active, focus=0.8, energy=1.0', () => {
      const s = cs.getState();
      expect(s.mood).toBe('focused');
      expect(s.consciousness).toBe('active');
      expect(s.focus).toBe(0.8);
      expect(s.curiosity).toBe(0.7);
      expect(s.energy).toBe(1.0);
      expect(s.confidence).toBe(0.6);
      expect(s.urgency).toBe(0);
      expect(s.creativity).toBe(0.5);
      expect(typeof s.timestamp).toBe('number');
    });

    it('getMood 返回 focused', () => {
      expect(cs.getMood()).toBe('focused');
    });
  });

  describe('setMood', () => {
    it('设置情绪并记录历史', () => {
      cs.setMood('curious', 'test_trigger');
      expect(cs.getMood()).toBe('curious');
      const history = cs.getMoodHistory();
      expect(history.length).toBe(1);
      expect(history[0].mood).toBe('curious');
      expect(history[0].trigger).toBe('test_trigger');
    });

    it('默认 trigger 为 internal', () => {
      cs.setMood('reflective');
      const history = cs.getMoodHistory();
      expect(history[0].trigger).toBe('internal');
    });

    it('情绪历史超过100条时移除最旧的', () => {
      for (let i = 0; i < 105; i++) {
        cs.setMood('creative', `t${i}`);
      }
      const history = cs.getMoodHistory(100);
      expect(history.length).toBe(100);
      // 最旧的5条被移除
      expect(history[0].trigger).toBe('t5');
    }, 60000); // 60s：105 次 setMood 各触发一次 writeFileSync，并行 I/O 下可能 > 30s

    it('setMood 持久化到文件', () => {
      cs.setMood('confident', 'persist_test');
      expect(fs.existsSync(persistPath)).toBe(true);
      const data = JSON.parse(fs.readFileSync(persistPath, 'utf-8'));
      expect(data.mood).toBe('confident');
    });
  });

  describe('think / getRecentThoughts', () => {
    it('记录思考流', () => {
      cs.think('思考A', 'inner');
      cs.think('思考B', 'analysis');
      const thoughts = cs.getRecentThoughts(10);
      expect(thoughts.length).toBe(2);
      expect(thoughts[0].content).toBe('思考A');
      expect(thoughts[1].content).toBe('思考B');
    });

    it('默认 type 为 inner', () => {
      cs.think('默认思考');
      const thoughts = cs.getRecentThoughts(1);
      expect(thoughts[0].type).toBe('inner');
    });

    it('getRecentThoughts 限制返回数量', () => {
      for (let i = 0; i < 10; i++) cs.think(`t${i}`);
      const thoughts = cs.getRecentThoughts(3);
      expect(thoughts.length).toBe(3);
      // 返回最近的3条
      expect(thoughts[0].content).toBe('t7');
      expect(thoughts[2].content).toBe('t9');
    });

    it('思考流超过200条时移除最旧的', () => {
      for (let i = 0; i < 205; i++) cs.think(`t${i}`);
      const thoughts = cs.getRecentThoughts(200);
      expect(thoughts.length).toBe(200);
      expect(thoughts[0].content).toBe('t5');
    });
  });

  describe('getDominantMood', () => {
    it('无历史时返回 focused, percentage=1', () => {
      const d = cs.getDominantMood();
      expect(d.mood).toBe('focused');
      expect(d.percentage).toBe(1);
    });

    it('返回最近20条中出现最多的情绪', () => {
      cs.setMood('curious');
      cs.setMood('curious');
      cs.setMood('confident');
      const d = cs.getDominantMood();
      expect(d.mood).toBe('curious');
      expect(d.percentage).toBeCloseTo(2 / 3, 5);
    });
  });

  describe('onTaskStart', () => {
    it('增加专注度和紧迫感，设置 mood=focused', () => {
      const before = cs.getState();
      cs.onTaskStart(0.8);
      const after = cs.getState();
      expect(after.focus).toBeGreaterThan(before.focus);
      expect(after.urgency).toBeCloseTo(0.24, 5); // 0.8 * 0.3
      expect(after.mood).toBe('focused');
      expect(after.energy).toBeLessThan(before.energy); // 消耗能量
    });

    it('focus 不超过 1', () => {
      cs.onTaskStart(1);
      cs.onTaskStart(1);
      cs.onTaskStart(1);
      expect(cs.getState().focus).toBeLessThanOrEqual(1);
    });
  });

  describe('onTaskComplete', () => {
    it('成功: 增加自信, mood=confident', () => {
      const before = cs.getState().confidence;
      cs.onTaskComplete(true);
      const after = cs.getState();
      expect(after.confidence).toBeGreaterThan(before);
      expect(after.mood).toBe('confident');
    });

    it('失败: 降低自信, mood=reflective', () => {
      const before = cs.getState().confidence;
      cs.onTaskComplete(false);
      const after = cs.getState();
      expect(after.confidence).toBeLessThan(before);
      expect(after.mood).toBe('reflective');
    });

    it('自信不低于 0.1', () => {
      for (let i = 0; i < 20; i++) cs.onTaskComplete(false);
      expect(cs.getState().confidence).toBeGreaterThanOrEqual(0.1);
    });

    it('完成后降低专注度和紧迫感', () => {
      cs.onTaskStart(1);
      const mid = cs.getState();
      cs.onTaskComplete(true);
      const after = cs.getState();
      expect(after.focus).toBeLessThan(mid.focus);
      expect(after.urgency).toBeLessThan(mid.urgency);
    });
  });

  describe('onDiscovery', () => {
    it('增加好奇心和创造力, mood=curious', () => {
      const before = cs.getState();
      cs.onDiscovery();
      const after = cs.getState();
      expect(after.curiosity).toBeGreaterThan(before.curiosity);
      expect(after.creativity).toBeGreaterThan(before.creativity);
      expect(after.mood).toBe('curious');
    });
  });

  describe('onError', () => {
    it('降低自信, 增加专注, mood=cautious', () => {
      const before = cs.getState();
      cs.onError(0.5);
      const after = cs.getState();
      expect(after.confidence).toBeLessThan(before.confidence);
      expect(after.focus).toBeGreaterThan(before.focus);
      expect(after.mood).toBe('cautious');
    });

    it('自信不低于 0.1', () => {
      for (let i = 0; i < 20; i++) cs.onError(1);
      expect(cs.getState().confidence).toBeGreaterThanOrEqual(0.1);
    });
  });

  describe('onNewInformation', () => {
    it('增加好奇心和创造力', () => {
      const before = cs.getState();
      cs.onNewInformation();
      const after = cs.getState();
      expect(after.curiosity).toBeGreaterThan(before.curiosity);
      expect(after.creativity).toBeGreaterThan(before.creativity);
    });
  });

  describe('consumeEnergy / restoreEnergy', () => {
    it('consumeEnergy 降低能量', () => {
      cs.consumeEnergy(0.3);
      expect(cs.getState().energy).toBeCloseTo(0.7, 5);
    });

    it('能量不低于 0', () => {
      cs.consumeEnergy(2);
      expect(cs.getState().energy).toBe(0);
    });

    it('能量低于0.2时 mood=tired, consciousness=light', () => {
      cs.consumeEnergy(0.85);
      const s = cs.getState();
      expect(s.energy).toBeLessThan(0.2);
      expect(s.mood).toBe('tired');
      expect(s.consciousness).toBe('light');
    });

    it('restoreEnergy 增加能量', () => {
      cs.consumeEnergy(0.5);
      cs.restoreEnergy(0.2);
      expect(cs.getState().energy).toBeCloseTo(0.7, 5);
    });

    it('能量不超过 1', () => {
      cs.restoreEnergy(2);
      expect(cs.getState().energy).toBeLessThanOrEqual(1);
    });

    it('restoreEnergy 超过0.5且非deep时 consciousness=active', () => {
      cs.consumeEnergy(0.8); // energy ~0.2, consciousness=light
      cs.restoreEnergy(0.4); // energy ~0.6
      expect(cs.getState().consciousness).toBe('active');
    });
  });

  describe('shouldThinkProactively', () => {
    it('默认状态 (curiosity>0.5, energy>0.3, active) 返回 true', () => {
      expect(cs.shouldThinkProactively()).toBe(true);
    });

    it('能量低于0.3时返回 false', () => {
      cs.consumeEnergy(0.8);
      expect(cs.shouldThinkProactively()).toBe(false);
    });

    it('好奇心低于0.5时返回 false', () => {
      // 通过大量失败降低好奇心? 不直接可降
      // 用反射设置
      (cs as any).curiosity = 0.3;
      expect(cs.shouldThinkProactively()).toBe(false);
    });
  });

  describe('getMoodDescription', () => {
    it('返回包含情绪描述的字符串', () => {
      cs.setMood('focused');
      const desc = cs.getMoodDescription();
      expect(typeof desc).toBe('string');
      expect(desc).toContain('专注');
    });

    it('不同情绪返回不同描述', () => {
      const descs = new Set<string>();
      const moods: Mood[] = ['focused', 'curious', 'reflective', 'creative', 'cautious', 'confident', 'tired'];
      for (const m of moods) {
        cs.setMood(m);
        descs.add(cs.getMoodDescription());
      }
      // 7种情绪应有不同的描述
      expect(descs.size).toBe(7);
    });
  });

  describe('serialize', () => {
    it('返回 JSON 字符串包含状态字段', () => {
      const str = cs.serialize();
      expect(typeof str).toBe('string');
      const obj = JSON.parse(str);
      expect(obj.mood).toBe('focused');
      expect(obj.focus).toBe(0.8);
      expect(obj.energy).toBe(1.0);
    });
  });

  describe('持久化加载', () => {
    it('从已有文件加载状态', () => {
      cs.setMood('creative');
      cs.consumeEnergy(0.3);
      cs.savePersistent(); // 手动持久化能量变化
      const savedEnergy = cs.getState().energy;

      // 创建新实例从同一文件加载
      const cs2 = new CognitiveState(persistPath);
      expect(cs2.getMood()).toBe('creative');
      expect(cs2.getState().energy).toBeCloseTo(savedEnergy, 5);
    });

    it('文件不存在时不报错，使用默认状态', () => {
      const noExistPath = path.join(tmpDir, 'nonexistent.json');
      const cs2 = new CognitiveState(noExistPath);
      expect(cs2.getMood()).toBe('focused');
    });
  });

  describe('savePersistent', () => {
    it('手动调用 savePersistent 写入文件', () => {
      cs.setMood('confident');
      cs.savePersistent();
      expect(fs.existsSync(persistPath)).toBe(true);
      const data = JSON.parse(fs.readFileSync(persistPath, 'utf-8'));
      expect(data.mood).toBe('confident');
    });

    it('持久化包含 moodHistory 和 thoughtStream', () => {
      cs.setMood('curious', 'test');
      cs.think('a thought', 'inner');
      cs.savePersistent();
      const data = JSON.parse(fs.readFileSync(persistPath, 'utf-8'));
      expect(Array.isArray(data.moodHistory)).toBe(true);
      expect(data.moodHistory.length).toBe(1);
      expect(Array.isArray(data.thoughtStream)).toBe(true);
      expect(data.thoughtStream.length).toBe(1);
    });
  });
});
