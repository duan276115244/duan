import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import { MetaLearningSystem } from '../meta-learning.js';

describe('MetaLearningSystem', () => {
  let tmpDir: string;
  let ml: MetaLearningSystem;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ml-test-'));
    ml = new MetaLearningSystem(tmpDir);
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  describe('任务管理', () => {
    it('registerTask 注册任务', () => {
      const task = ml.registerTask('XOR 学习', 'classification', '学习 XOR 运算');
      expect(task.id).toBeTruthy();
      expect(task.name).toBe('XOR 学习');
      expect(task.type).toBe('classification');
    });

    it('getTask 获取任务', () => {
      const created = ml.registerTask('T1', 'regression', '');
      const fetched = ml.getTask(created.id);
      expect(fetched).not.toBeNull();
      expect(fetched!.name).toBe('T1');
    });

    it('getTask 不存在返回 null', () => {
      expect(ml.getTask('nonexistent')).toBeNull();
    });

    it('getTasks 返回所有任务', () => {
      ml.registerTask('A', 'type1', '');
      ml.registerTask('B', 'type2', '');
      expect(ml.getTasks()).toHaveLength(2);
    });
  });

  describe('学习会话', () => {
    it('startSession 创建会话', () => {
      const task = ml.registerTask('T1', 'classification', '');
      const session = ml.startSession(task.id);
      expect(session.id).toBeTruthy();
      expect(session.taskId).toBe(task.id);
      expect(session.strategy).toBeTruthy();
      expect(session.hyperparams).toBeDefined();
      expect(session.progressLog).toHaveLength(0);
    });

    it('startSession 不存在的任务抛错', () => {
      expect(() => ml.startSession('nonexistent')).toThrow();
    });

    it('startSession 接受指定策略', () => {
      const task = ml.registerTask('T1', 'classification', '');
      const session = ml.startSession(task.id, 'curriculum');
      expect(session.strategy).toBe('curriculum');
    });

    it('recordProgress 记录进度', () => {
      const task = ml.registerTask('T1', 'classification', '');
      ml.startSession(task.id);
      ml.recordProgress('accuracy', 0.5);
      ml.recordProgress('accuracy', 0.7);
      // 进度被记录（无法直接访问，通过 endSession 间接验证）
      const exp = ml.endSession(true, 0.7);
      expect(exp).not.toBeNull();
    });

    it('recordProgress 无活跃会话时不抛错', () => {
      expect(() => ml.recordProgress('x', 1)).not.toThrow();
    });

    it('endSession 返回学习经验', () => {
      const task = ml.registerTask('T1', 'classification', '');
      ml.startSession(task.id);
      ml.recordProgress('acc', 0.3);
      ml.recordProgress('acc', 0.6);
      ml.recordProgress('acc', 0.9);
      const exp = ml.endSession(true, 0.9);
      expect(exp).not.toBeNull();
      expect(exp!.taskType).toBe('classification');
      expect(exp!.effectiveStrategies.length).toBeGreaterThan(0);
      expect(exp!.lessons).toBeDefined();
    });

    it('endSession 无活跃会话返回 null', () => {
      expect(ml.endSession(true, 0.5)).toBeNull();
    });
  });

  describe('策略推荐', () => {
    it('recommendStrategy 无历史返回默认策略', () => {
      const strategy = ml.recommendStrategy('unknown-type');
      expect(strategy).toBe('incremental');
    });

    it('recommendStrategy 有历史返回最优策略', () => {
      const task = ml.registerTask('T1', 'classification', '');
      ml.startSession(task.id, 'transfer');
      ml.recordProgress('acc', 0.9);
      ml.endSession(true, 0.9);

      const strategy = ml.recommendStrategy('classification');
      expect(strategy).toBeTruthy();
    });
  });

  describe('知识迁移', () => {
    it('transferKnowledge 记录迁移', () => {
      const record = ml.transferKnowledge('task1', 'task2', '特征提取技巧');
      expect(record.sourceTaskId).toBe('task1');
      expect(record.targetTaskId).toBe('task2');
      expect(record.knowledge).toBe('特征提取技巧');
      expect(record.effectiveness).toBe(0);
    });

    it('evaluateTransfer 评估迁移效果', () => {
      const record = ml.transferKnowledge('s', 't', 'k');
      ml.evaluateTransfer(record, 0.85);
      expect(record.effectiveness).toBe(0.85);
    });

    it('getTransferRecords 返回迁移记录', () => {
      ml.transferKnowledge('s1', 't1', 'k1');
      ml.transferKnowledge('s2', 't2', 'k2');
      expect(ml.getTransferRecords()).toHaveLength(2);
    });
  });

  describe('经验提取', () => {
    it('getExperiences 返回经验列表', () => {
      const task = ml.registerTask('T1', 'classification', '');
      ml.startSession(task.id);
      ml.recordProgress('acc', 0.5);
      ml.endSession(true, 0.5);
      const experiences = ml.getExperiences();
      expect(experiences.length).toBeGreaterThan(0);
    });
  });

  describe('统计', () => {
    it('getStats 返回完整统计', () => {
      ml.registerTask('T1', 'type1', '');
      const task = ml.registerTask('T2', 'type2', '');
      ml.startSession(task.id);
      ml.recordProgress('acc', 0.5);
      ml.endSession(true, 0.5);

      const stats = ml.getStats();
      expect(stats.totalTasks).toBe(2);
      expect(stats.totalSessions).toBeGreaterThanOrEqual(1);
      expect(stats.totalExperiences).toBeGreaterThanOrEqual(1);
      expect(Array.isArray(stats.strategyStats)).toBe(true);
    });
  });

  describe('持久化', () => {
    it('saveData 保存数据文件', () => {
      const task = ml.registerTask('T1', 'classification', '');
      ml.startSession(task.id);
      ml.recordProgress('acc', 0.5);
      ml.endSession(true, 0.5);
      ml.saveData();
      expect(fs.existsSync(path.join(tmpDir, 'meta-learning-data.json'))).toBe(true);
    });

    it('loadData 加载已保存数据', () => {
      const task = ml.registerTask('PersistTest', 'regression', '');
      ml.startSession(task.id);
      ml.recordProgress('acc', 0.5);
      ml.endSession(true, 0.5);
      ml.saveData();

      const ml2 = new MetaLearningSystem(tmpDir);
      const tasks = ml2.getTasks();
      expect(tasks.find((t) => t.name === 'PersistTest')).toBeDefined();
    });
  });
});
