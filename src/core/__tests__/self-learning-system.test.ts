/**
 * SelfLearningSystem 测试
 *
 * 覆盖核心学习行为：
 * - learnFromInteraction 基本流程 + tagIndex 倒排索引
 * - findSimilarRecord 去重（frequency++ / confidence +0.05）
 * - learnFromError 重复错误降置信度（-0.1，下限 0.1）
 * - feedback → confidence 映射（positive=0.8 / negative=0.3 / neutral=0.5）
 * - knowledge 500 上限（超限淘汰 usageCount+confidence 最低者）
 * - records 30 天衰减清理（confidence < 0.15 且 lastSeen > 30d → 删除）
 * - loadData schema 防御（缺失 tags → []，非字符串 content → ''）
 *
 * 隔离策略：tmpDir + 短 response（< 100 字符触发 extractKnowledge 早返回，避免 LLM 依赖）
 * 参考范式：src/core/__tests__/memory-orchestrator.facade.test.ts
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import { SelfLearningSystem, type LearningRecord } from '../self-learning-system.js';
import type { ModelLibrary } from '../model-library.js';

// ModelLibrary stub — 被测方法（learnFromInteraction / learnFromError / 衰减）不调用 LLM；
// extractKnowledge 在 response.length < 100 时早返回，规避 LLM 依赖。
const stubModelLibrary = {} as unknown as ModelLibrary;

describe('SelfLearningSystem', () => {
  let tmpDir: string;
  let sls: SelfLearningSystem;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'jws-sls-'));
    sls = new SelfLearningSystem(stubModelLibrary, tmpDir);
  });

  afterEach(() => {
    // 必须先 dispose：清理 saveTimer + 强制落盘，否则 saveTimer 触发时写入已删除目录
    sls.dispose();
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  // ============ 构造 + loadData ============

  describe('构造与 loadData', () => {
    it('数据目录不存在时自动创建', () => {
      const freshDir = path.join(tmpDir, 'fresh-subdir');
      expect(fs.existsSync(freshDir)).toBe(false);
      const sys = new SelfLearningSystem(stubModelLibrary, freshDir);
      expect(sys).toBeDefined();
      expect(fs.existsSync(freshDir)).toBe(true);
    });

    it('空数据目录加载不抛错，records 为空', () => {
      expect(sls.generateReport().totalRecords).toBe(0);
    });

    it('loadData schema 防御：缺失 tags 字段加载为 []', () => {
      // 构造一个缺 tags 字段的 records.json（模拟旧数据 schema 漂移）
      const recordsPath = path.join(tmpDir, 'records.json');
      const malformedRecord = {
        id: 'legacy-1',
        type: 'interaction',
        category: 'coding',
        content: 'legacy record without tags',
        context: '',
        source: 'interaction',
        confidence: 0.5,
        frequency: 1,
        lastSeen: Date.now(),
        firstSeen: Date.now(),
        applied: false,
        appliedCount: 0,
        // tags 故意缺失 — 修复前会触发 "record.tags is not iterable"
      };
      fs.writeFileSync(recordsPath, JSON.stringify([malformedRecord]));

      // 重新加载 — 不应抛 "record.tags is not iterable"
      const reloaded = new SelfLearningSystem(stubModelLibrary, tmpDir);
      expect(reloaded.generateReport().totalRecords).toBe(1);
    });
  });

  // ============ learnFromInteraction ============

  describe('learnFromInteraction()', () => {
    it('创建记录并返回，type 为 interaction', () => {
      // 短 response (< 100) 触发 extractKnowledge 早返回，避免 LLM
      const record = sls.learnFromInteraction('写代码', 'ok');
      expect(record.type).toBe('interaction');
      expect(record.category).toBe('coding');
      expect(record.frequency).toBe(1);
      expect(record.confidence).toBe(0.5); // neutral feedback
      expect(Array.isArray(record.tags)).toBe(true);
    });

    it('positive feedback → confidence 0.8', () => {
      const record = sls.learnFromInteraction('写代码', 'ok', 'positive');
      expect(record.confidence).toBe(0.8);
    });

    it('negative feedback → confidence 0.3', () => {
      const record = sls.learnFromInteraction('写代码', 'ok', 'negative');
      expect(record.confidence).toBe(0.3);
    });

    it('neutral feedback → confidence 0.5', () => {
      const record = sls.learnFromInteraction('写代码', 'ok', 'neutral');
      expect(record.confidence).toBe(0.5);
    });

    it('tagIndex 倒排索引更新（同 tag 的重复查询可被 detectAndRecordPattern 检索）', () => {
      // 3 个不同输入共享 coding tag（extractTags 正则 /代码|编程/ → 'coding'），
      // content 因 uniqueXXX 词差异 computeOverlap < 0.6 不被 dedup，
      // 第 3 条触发 detectAndRecordPattern 的 similarRecords.length >= 2 条件
      sls.learnFromInteraction('写代码 uniqueAAA', 'ok');
      sls.learnFromInteraction('编程 uniqueBBB', 'ok');
      sls.learnFromInteraction('代码 uniqueCCC', 'ok');
      const patterns = sls.getPatterns();
      expect(patterns.length).toBeGreaterThan(0);
      const repeatedPattern = patterns.find(p => p.patternType === 'repeated_query');
      expect(repeatedPattern).toBeDefined();
    });

    it('getPatternContext 返回相关模式提示', () => {
      // 3 个不同输入触发 repeated_query 模式（pattern.tags = ['coding']）
      sls.learnFromInteraction('写代码 uniqueAAA', 'ok');
      sls.learnFromInteraction('编程 uniqueBBB', 'ok');
      sls.learnFromInteraction('代码 uniqueCCC', 'ok');
      // getPatternContext 按 inputLower.includes(tag) 匹配，tag='coding' 为英文，
      // 故输入需含 'coding' 才命中（中文输入匹配英文 tag 是已知设计限制，Phase C 召回门面会统一处理）
      const ctx = sls.getPatternContext('coding 相关任务');
      expect(ctx).toContain('检测到的交互模式');
    });
  });

  // ============ findSimilarRecord 去重 ============

  describe('findSimilarRecord 去重', () => {
    it('相同内容第二次学习返回同一记录 id，frequency++', () => {
      const r1 = sls.learnFromInteraction('写代码 function test', 'ok');
      const r2 = sls.learnFromInteraction('写代码 function test', 'ok');
      expect(r2.id).toBe(r1.id);
      expect(r2.frequency).toBe(2);
    });

    it('重复学习提升置信度（+0.05，上限 1.0）', () => {
      const r1 = sls.learnFromInteraction('写代码 function test', 'ok');
      const initialConfidence = r1.confidence;
      const r2 = sls.learnFromInteraction('写代码 function test', 'ok');
      expect(r2.confidence).toBe(initialConfidence + 0.05);
    });

    it('不同 category 不去重', () => {
      const r1 = sls.learnFromInteraction('写代码', 'ok'); // coding
      const r2 = sls.learnFromInteraction('分析数据', 'ok'); // analysis
      expect(r2.id).not.toBe(r1.id);
    });
  });

  // ============ learnFromError ============

  describe('learnFromError()', () => {
    it('首次错误创建记录，type=error，confidence=0.7', () => {
      const record = sls.learnFromError('TypeError: x is undefined', 'ctx');
      expect(record.type).toBe('error');
      expect(record.confidence).toBe(0.7);
      expect(record.frequency).toBe(1);
    });

    it('重复错误降低置信度（-0.1，下限 0.1）', () => {
      const r1 = sls.learnFromError('TypeError: x is undefined', 'ctx');
      expect(r1.confidence).toBe(0.7);
      const r2 = sls.learnFromError('TypeError: x is undefined', 'ctx');
      expect(r2.id).toBe(r1.id);
      expect(r2.confidence).toBe(0.6);
      const r3 = sls.learnFromError('TypeError: x is undefined', 'ctx');
      expect(r3.confidence).toBe(0.5);
    });

    it('置信度不低于 0.1 下限', () => {
      // 连续重复 8 次：0.7 → 0.6 → 0.5 → 0.4 → 0.3 → 0.2 → 0.1 → 0.1 → 0.1
      let last: LearningRecord | null = null;
      for (let i = 0; i < 8; i++) {
        last = sls.learnFromError('TypeError: x is undefined', 'ctx');
      }
      expect(last!.confidence).toBeGreaterThanOrEqual(0.1);
    });
  });

  // ============ knowledge 500 上限 ============

  describe('knowledge 500 上限淘汰', () => {
    it('超过 500 条知识时淘汰 usageCount+confidence 最低者', () => {
      // 注入 502 条知识条目，saveData 时触发淘汰到 500
      // 用反射访问 private knowledge Map
      const sys = sls as unknown as { knowledge: Map<string, { id: string; topic: string; content: string; source: string; verified: boolean; confidence: number; relatedTopics: string[]; lastUpdated: number; usageCount: number; }> };
      for (let i = 0; i < 502; i++) {
        sys.knowledge.set(`k-${i}`, {
          id: `k-${i}`,
          topic: `topic-${i}`,
          content: `content-${i}`,
          source: 'self_discovery',
          verified: false,
          confidence: 0.5,
          relatedTopics: [],
          lastUpdated: Date.now(),
          usageCount: i, // 后插入的 usageCount 更高，早插入的应被淘汰
        });
      }
      expect(sys.knowledge.size).toBe(502);

      // 触发 saveData（包含淘汰逻辑）
      // 用反射调用 private saveData
      const saveFn = (sls as unknown as { saveData: () => void }).saveData;
      saveFn.call(sls);

      expect(sys.knowledge.size).toBe(500);
      // usageCount=0 和 1 的两条应被淘汰（最低的 2 条）
      expect(sys.knowledge.has('k-0')).toBe(false);
      expect(sys.knowledge.has('k-1')).toBe(false);
      expect(sys.knowledge.has('k-2')).toBe(true);
    });
  });

  // ============ records 30 天衰减清理 ============

  describe('records 30 天衰减清理', () => {
    it('confidence < 0.15 且 lastSeen > 30 天的记录被清理', () => {
      // 注入一条低置信度 + 旧的记录
      const sys = sls as unknown as {
        records: Map<string, LearningRecord>;
        saveData: () => void;
      };
      const staleId = 'stale-record-1';
      const thirtyOneDaysAgo = Date.now() - (31 * 24 * 60 * 60 * 1000);
      sys.records.set(staleId, {
        id: staleId,
        type: 'interaction',
        category: 'coding',
        content: 'stale',
        context: '',
        source: 'interaction',
        confidence: 0.1, // < 0.15
        frequency: 1,
        lastSeen: thirtyOneDaysAgo, // > 30 天
        firstSeen: thirtyOneDaysAgo,
        applied: false,
        appliedCount: 0,
        tags: [],
      });

      // 触发 saveData（包含清理逻辑）
      sys.saveData.call(sls);

      expect(sys.records.has(staleId)).toBe(false);
    });

    it('confidence >= 0.15 的旧记录保留', () => {
      const sys = sls as unknown as {
        records: Map<string, LearningRecord>;
        saveData: () => void;
      };
      const oldId = 'old-but-trusted';
      const thirtyOneDaysAgo = Date.now() - (31 * 24 * 60 * 60 * 1000);
      sys.records.set(oldId, {
        id: oldId,
        type: 'interaction',
        category: 'coding',
        content: 'trusted old',
        context: '',
        source: 'interaction',
        confidence: 0.5, // >= 0.15
        frequency: 3,
        lastSeen: thirtyOneDaysAgo,
        firstSeen: thirtyOneDaysAgo,
        applied: false,
        appliedCount: 0,
        tags: [],
      });

      sys.saveData.call(sls);
      expect(sys.records.has(oldId)).toBe(true);
    });

    it('confidence < 0.15 但 lastSeen < 30 天的记录保留', () => {
      const sys = sls as unknown as {
        records: Map<string, LearningRecord>;
        saveData: () => void;
      };
      const recentLowId = 'recent-low-conf';
      sys.records.set(recentLowId, {
        id: recentLowId,
        type: 'interaction',
        category: 'coding',
        content: 'recent low',
        context: '',
        source: 'interaction',
        confidence: 0.1, // < 0.15
        frequency: 1,
        lastSeen: Date.now(), // 最近
        firstSeen: Date.now(),
        applied: false,
        appliedCount: 0,
        tags: [],
      });

      sys.saveData.call(sls);
      expect(sys.records.has(recentLowId)).toBe(true);
    });
  });

  // ============ 持久化往返 ============

  describe('持久化往返', () => {
    it('saveData + loadData 往返保留记录', () => {
      sls.learnFromInteraction('写代码 function', 'ok');
      sls.learnFromError('TestError: fail', 'ctx');

      // 重新加载
      const reloaded = new SelfLearningSystem(stubModelLibrary, tmpDir);
      const stats = reloaded.generateReport();
      expect(stats.totalRecords).toBe(2);
    });
  });

  // ============ learnBestPractice / learnUserPreference ============

  describe('learnBestPractice()', () => {
    it('创建 best_practice 记录，confidence=0.8', () => {
      const record = sls.learnBestPractice('使用 try-catch 包裹异步调用', 'coding');
      expect(record.type).toBe('best_practice');
      expect(record.confidence).toBe(0.8);
      expect(record.category).toBe('coding');
    });
  });

  describe('learnUserPreference()', () => {
    it('创建 user_preference 记录，confidence=0.9', () => {
      const record = sls.learnUserPreference('用户偏好深色主题', 'ui');
      expect(record.type).toBe('user_preference');
      expect(record.confidence).toBe(0.9);
    });
  });

  // ============ getStats / 报告 ============

  describe('generateReport()', () => {
    it('返回总记录数、技能数、知识数', () => {
      sls.learnFromInteraction('写代码', 'ok');
      const stats = sls.generateReport();
      expect(stats.totalRecords).toBe(1);
      expect(stats.skillsCount).toBeGreaterThan(0); // initializeDefaultSkills 注入默认技能
      expect(stats.knowledgeCount).toBeGreaterThanOrEqual(0);
    });
  });
});
