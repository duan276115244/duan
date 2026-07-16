/**
 * OfflineCoordinator 测试 — §5.2 离线能力增强
 *
 * 覆盖：初始化 / 网络探测 / 本地模型检测 / 离线模式 / 知识库 / 持久化 / LLM 工具 / 单例 / 边缘情况
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import { OfflineCoordinator, getOfflineCoordinator } from '../offline-coordinator.js';
import type { OfflineKnowledgeEntry } from '../offline-coordinator.js';

// ============ 测试工具 ============

let tmpDir: string;

function createTmpDir(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'offline-coord-test-'));
}

function newCoordinator(): OfflineCoordinator {
  const dir = path.join(tmpDir, 'offline');
  const c = new OfflineCoordinator(dir);
  c.initialize();
  return c;
}

// ============ 测试用例 ============

describe('OfflineCoordinator', () => {
  beforeEach(() => {
    tmpDir = createTmpDir();
    OfflineCoordinator._resetInstance();
  });

  afterEach(() => {
    OfflineCoordinator._resetInstance();
    if (fs.existsSync(tmpDir)) {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  // ========== 初始化 ==========

  describe('初始化', () => {
    it('应创建数据目录并加载空数据', () => {
      const dir = path.join(tmpDir, 'offline');
      const c = new OfflineCoordinator(dir);
      c.initialize();
      expect(fs.existsSync(dir)).toBe(true);
      expect(c.getNetworkState()).toBe('unknown');
      expect(c.isOfflineMode()).toBe(false);
    });

    it('应注入 10 个内置知识条目', () => {
      const c = newCoordinator();
      const stats = c.getStats();
      expect(stats.knowledgeEntryCount).toBe(10);
    });

    it('重复初始化不应重复注入内置知识', () => {
      const dir = path.join(tmpDir, 'offline');
      const c = new OfflineCoordinator(dir);
      c.initialize();
      c.initialize();
      expect(c.getStats().knowledgeEntryCount).toBe(10);
    });

    it('应加载已持久化的状态', async () => {
      const dir = path.join(tmpDir, 'offline');
      const c1 = new OfflineCoordinator(dir);
      c1.initialize();
      c1.enableOfflineMode('manual');
      c1.addOfflineKnowledge({
        topic: '测试主题',
        content: '测试内容',
        tags: ['test'],
        category: 'custom',
        source: 'user',
      });

      const c2 = new OfflineCoordinator(dir);
      c2.initialize();
      expect(c2.isOfflineMode()).toBe(true);
      expect(c2.getStats().knowledgeEntryCount).toBe(11); // 10 内置 + 1 自定义
    });
  });

  // ========== 网络探测 ==========

  describe('网络探测', () => {
    it('probe() 应返回 NetworkStatusRecord', async () => {
      const c = newCoordinator();
      const record = await c.probe();
      expect(record).toBeDefined();
      expect(record.checkedAt).toBeGreaterThan(0);
      expect(['online', 'offline', 'unknown']).toContain(record.state);
      // 状态应为 online 或 offline（探测后不再 unknown）
      expect(record.state).not.toBe('unknown');
    });

    it('probe() 应更新内部网络状态', async () => {
      const c = newCoordinator();
      await c.probe();
      const state = c.getNetworkState();
      expect(['online', 'offline']).toContain(state);
    });

    it('probe() 应记录检查次数', async () => {
      const c = newCoordinator();
      const before = c.getStats().onlineCheckCount + c.getStats().offlineCheckCount;
      await c.probe();
      const after = c.getStats().onlineCheckCount + c.getStats().offlineCheckCount;
      expect(after).toBe(before + 1);
    });

    it('probe() 应更新 lastCheckedAt', async () => {
      const c = newCoordinator();
      expect(c.getStats().lastCheckedAt).toBeNull();
      await c.probe();
      expect(c.getStats().lastCheckedAt).not.toBeNull();
    });

    it('isOnline() 应反映网络状态', async () => {
      const c = newCoordinator();
      await c.probe();
      const state = c.getNetworkState();
      expect(c.isOnline()).toBe(state === 'online');
    });

    it('getLastCheck() 应返回最近一条记录', async () => {
      const c = newCoordinator();
      expect(c.getLastCheck()).toBeNull();
      await c.probe();
      const last = c.getLastCheck();
      expect(last).not.toBeNull();
      expect(last?.checkedAt).toBeGreaterThan(0);
    });

    it('startMonitoring/stopMonitoring 应启停监测', () => {
      const c = newCoordinator();
      expect(c.isMonitoring()).toBe(false);
      c.startMonitoring(1000);
      expect(c.isMonitoring()).toBe(true);
      c.stopMonitoring();
      expect(c.isMonitoring()).toBe(false);
    });

    it('重复 startMonitoring 应被忽略', () => {
      const c = newCoordinator();
      c.startMonitoring(60000);
      c.startMonitoring(60000); // 应忽略
      expect(c.isMonitoring()).toBe(true);
      c.stopMonitoring();
    });
  });

  // ========== 本地模型检测 ==========

  describe('本地模型检测', () => {
    it('detectLocalModels() 应返回数组', async () => {
      const c = newCoordinator();
      const models = await c.detectLocalModels();
      expect(Array.isArray(models)).toBe(true);
    });

    it('detectLocalModels() 后 getLocalModels() 应一致', async () => {
      const c = newCoordinator();
      const models = await c.detectLocalModels();
      expect(c.getLocalModels().length).toBe(models.length);
    });

    it('hasLocalModel() 应反映检测结果', async () => {
      const c = newCoordinator();
      await c.detectLocalModels();
      expect(c.hasLocalModel()).toBe(c.getLocalModels().length > 0);
    });

    it('getBestLocalModel() 无模型时应返回 null', () => {
      const c = newCoordinator();
      // 未检测时无模型
      expect(c.getBestLocalModel()).toBeNull();
    });

    it('getOllamaModels/getLlamaCppModels 应按类型过滤', async () => {
      const c = newCoordinator();
      await c.detectLocalModels();
      const ollama = c.getOllamaModels();
      const llama = c.getLlamaCppModels();
      expect(ollama.every(m => m.type === 'ollama')).toBe(true);
      expect(llama.every(m => m.type === 'llama_cpp')).toBe(true);
    });

    it('检测结果应持久化', async () => {
      const dir = path.join(tmpDir, 'offline');
      const c1 = new OfflineCoordinator(dir);
      c1.initialize();
      await c1.detectLocalModels();
      const count1 = c1.getLocalModels().length;

      const c2 = new OfflineCoordinator(dir);
      c2.initialize();
      expect(c2.getLocalModels().length).toBe(count1);
    });
  });

  // ========== 离线模式 ==========

  describe('离线模式', () => {
    it('enableOfflineMode 应启用并记录来源', () => {
      const c = newCoordinator();
      expect(c.isOfflineMode()).toBe(false);
      c.enableOfflineMode('manual');
      expect(c.isOfflineMode()).toBe(true);
      expect(c.getOfflineModeSource()).toBe('manual');
    });

    it('disableOfflineMode 应禁用', () => {
      const c = newCoordinator();
      c.enableOfflineMode('auto');
      c.disableOfflineMode();
      expect(c.isOfflineMode()).toBe(false);
      expect(c.getOfflineModeSource()).toBeNull();
    });

    it('toggleOfflineMode 应切换状态', () => {
      const c = newCoordinator();
      const after1 = c.toggleOfflineMode();
      expect(after1).toBe(true);
      const after2 = c.toggleOfflineMode();
      expect(after2).toBe(false);
    });

    it('相同 source 重复 enable 应被忽略', () => {
      const c = newCoordinator();
      c.enableOfflineMode('manual');
      c.enableOfflineMode('manual'); // 应忽略
      expect(c.getOfflineModeSource()).toBe('manual');
    });

    it('未启用时 disable 应无操作', () => {
      const c = newCoordinator();
      c.disableOfflineMode(); // 无操作
      expect(c.isOfflineMode()).toBe(false);
    });

    it('离线模式状态应持久化', () => {
      const dir = path.join(tmpDir, 'offline');
      const c1 = new OfflineCoordinator(dir);
      c1.initialize();
      c1.enableOfflineMode('startup');

      const c2 = new OfflineCoordinator(dir);
      c2.initialize();
      expect(c2.isOfflineMode()).toBe(true);
      expect(c2.getOfflineModeSource()).toBe('startup');
    });
  });

  // ========== 离线知识库 ==========

  describe('离线知识库', () => {
    it('queryOfflineKnowledge 应返回相关结果', () => {
      const c = newCoordinator();
      const results = c.queryOfflineKnowledge('typescript 类型');
      expect(results.length).toBeGreaterThan(0);
      expect(results[0].score).toBeGreaterThan(0);
      expect(results[0].entry.topic).toContain('TypeScript');
    });

    it('queryOfflineKnowledge 应按分数排序', () => {
      const c = newCoordinator();
      const results = c.queryOfflineKnowledge('git', 5);
      for (let i = 1; i < results.length; i++) {
        expect(results[i - 1].score).toBeGreaterThanOrEqual(results[i].score);
      }
    });

    it('queryOfflineKnowledge 应遵守 limit', () => {
      const c = newCoordinator();
      const results = c.queryOfflineKnowledge('命令', 2);
      expect(results.length).toBeLessThanOrEqual(2);
    });

    it('queryOfflineKnowledge 空查询应返回空数组', () => {
      const c = newCoordinator();
      const results = c.queryOfflineKnowledge('  ');
      expect(results.length).toBe(0);
    });

    it('queryOfflineKnowledge 无匹配应返回空数组', () => {
      const c = newCoordinator();
      const results = c.queryOfflineKnowledge('zzzznomatchxyz');
      expect(results.length).toBe(0);
    });

    it('addOfflineKnowledge 应添加条目', () => {
      const c = newCoordinator();
      const before = c.getStats().knowledgeEntryCount;
      const result = c.addOfflineKnowledge({
        topic: '自定义主题',
        content: '自定义内容',
        tags: ['custom'],
        category: 'custom',
        source: 'user',
      });
      expect(result.success).toBe(true);
      expect(result.id).toBeDefined();
      expect(c.getStats().knowledgeEntryCount).toBe(before + 1);
    });

    it('addOfflineKnowledge 空内容应失败', () => {
      const c = newCoordinator();
      const result = c.addOfflineKnowledge({
        topic: '',
        content: '',
        tags: [],
        category: 'custom',
        source: 'user',
      });
      expect(result.success).toBe(false);
      expect(result.error).toBeDefined();
    });

    it('addOfflineKnowledge 支持自定义 id', () => {
      const c = newCoordinator();
      const result = c.addOfflineKnowledge({
        id: 'my-id',
        topic: '主题',
        content: '内容',
        tags: [],
        category: 'custom',
        source: 'user',
      });
      expect(result.success).toBe(true);
      expect(result.id).toBe('my-id');
    });

    it('removeOfflineKnowledge 应删除条目', () => {
      const c = newCoordinator();
      const addResult = c.addOfflineKnowledge({
        topic: '待删除',
        content: '内容',
        tags: [],
        category: 'custom',
        source: 'user',
      });
      const id = addResult.id!;
      const before = c.getStats().knowledgeEntryCount;
      const result = c.removeOfflineKnowledge(id);
      expect(result.success).toBe(true);
      expect(c.getStats().knowledgeEntryCount).toBe(before - 1);
    });

    it('removeOfflineKnowledge 不存在的 id 应失败', () => {
      const c = newCoordinator();
      const result = c.removeOfflineKnowledge('non-existent-id');
      expect(result.success).toBe(false);
    });

    it('getAllKnowledge 应返回所有条目', () => {
      const c = newCoordinator();
      const all = c.getAllKnowledge();
      expect(all.length).toBe(10);
    });

    it('getKnowledgeByCategory 应按分类过滤', () => {
      const c = newCoordinator();
      const programming = c.getKnowledgeByCategory('programming');
      expect(programming.length).toBeGreaterThan(0);
      expect(programming.every(e => e.category === 'programming')).toBe(true);
    });

    it('知识库应持久化', () => {
      const dir = path.join(tmpDir, 'offline');
      const c1 = new OfflineCoordinator(dir);
      c1.initialize();
      c1.addOfflineKnowledge({
        topic: '持久化测试',
        content: '内容',
        tags: ['persist'],
        category: 'custom',
        source: 'user',
      });

      const c2 = new OfflineCoordinator(dir);
      c2.initialize();
      // 10 内置 + 1 自定义（注意：loadKnowledge 加载自定义后 injectBuiltinKnowledge 不会重复）
      expect(c2.getStats().knowledgeEntryCount).toBe(11);
      const all = c2.getAllKnowledge();
      expect(all.some(e => e.topic === '持久化测试')).toBe(true);
    });
  });

  // ========== 统计 ==========

  describe('getStats', () => {
    it('应返回完整统计信息', () => {
      const c = newCoordinator();
      const stats = c.getStats();
      expect(stats).toHaveProperty('networkState');
      expect(stats).toHaveProperty('offlineMode');
      expect(stats).toHaveProperty('offlineModeSource');
      expect(stats).toHaveProperty('lastCheckedAt');
      expect(stats).toHaveProperty('onlineCheckCount');
      expect(stats).toHaveProperty('offlineCheckCount');
      expect(stats).toHaveProperty('localModelCount');
      expect(stats).toHaveProperty('knowledgeEntryCount');
      expect(stats).toHaveProperty('uptime');
      expect(stats.uptime).toBeGreaterThanOrEqual(0);
    });
  });

  // ========== LLM 工具 ==========

  describe('LLM 工具', () => {
    it('应返回 8 个工具', () => {
      const c = newCoordinator();
      const tools = c.getToolDefinitions();
      expect(tools.length).toBe(8);
      const names = tools.map(t => t.name);
      expect(names).toContain('offline_status');
      expect(names).toContain('offline_probe');
      expect(names).toContain('offline_mode_toggle');
      expect(names).toContain('offline_models_detect');
      expect(names).toContain('offline_models_list');
      expect(names).toContain('offline_knowledge_query');
      expect(names).toContain('offline_knowledge_add');
      expect(names).toContain('offline_knowledge_list');
    });

    it('offline_status 工具应返回 JSON 统计', async () => {
      const c = newCoordinator();
      const tool = c.getToolDefinitions().find(t => t.name === 'offline_status')!;
      const result = await tool.execute!({} as never);
      const parsed = JSON.parse(result as string);
      expect(parsed).toHaveProperty('networkState');
      expect(parsed).toHaveProperty('knowledgeEntryCount');
    });

    it('offline_mode_toggle enable/disable/toggle', async () => {
      const c = newCoordinator();
      const tool = c.getToolDefinitions().find(t => t.name === 'offline_mode_toggle')!;

      const enableResult = JSON.parse(await tool.execute!({ action: 'enable' } as never) as string);
      expect(enableResult.success).toBe(true);
      expect(enableResult.offlineMode).toBe(true);

      const disableResult = JSON.parse(await tool.execute!({ action: 'disable' } as never) as string);
      expect(disableResult.success).toBe(true);
      expect(disableResult.offlineMode).toBe(false);

      const toggleResult = JSON.parse(await tool.execute!({ action: 'toggle' } as never) as string);
      expect(toggleResult.success).toBe(true);
      expect(toggleResult.offlineMode).toBe(true);
    });

    it('offline_mode_toggle 非法 action 应返回错误', async () => {
      const c = newCoordinator();
      const tool = c.getToolDefinitions().find(t => t.name === 'offline_mode_toggle')!;
      const result = JSON.parse(await tool.execute!({ action: 'invalid' } as never) as string);
      expect(result.success).toBe(false);
      expect(result.error).toBeDefined();
    });

    it('offline_models_list 工具应返回模型列表', async () => {
      const c = newCoordinator();
      const tool = c.getToolDefinitions().find(t => t.name === 'offline_models_list')!;
      const result = JSON.parse(await tool.execute!({} as never) as string);
      expect(result).toHaveProperty('count');
      expect(result).toHaveProperty('models');
      expect(Array.isArray(result.models)).toBe(true);
    });

    it('offline_knowledge_query 工具应返回查询结果', async () => {
      const c = newCoordinator();
      const tool = c.getToolDefinitions().find(t => t.name === 'offline_knowledge_query')!;
      const result = JSON.parse(await tool.execute!({ query: 'python' } as never) as string);
      expect(result.count).toBeGreaterThan(0);
      expect(result.results[0]).toHaveProperty('topic');
      expect(result.results[0]).toHaveProperty('score');
    });

    it('offline_knowledge_add 工具应添加条目', async () => {
      const c = newCoordinator();
      const tool = c.getToolDefinitions().find(t => t.name === 'offline_knowledge_add')!;
      const result = JSON.parse(await tool.execute!({
        topic: '工具添加',
        content: '内容',
      } as never) as string);
      expect(result.success).toBe(true);
      expect(result.id).toBeDefined();
    });

    it('offline_knowledge_add 工具支持 tags_json', async () => {
      const c = newCoordinator();
      const tool = c.getToolDefinitions().find(t => t.name === 'offline_knowledge_add')!;
      const result = JSON.parse(await tool.execute!({
        topic: '带标签',
        content: '内容',
        tags_json: '["a","b"]',
      } as never) as string);
      expect(result.success).toBe(true);
    });

    it('offline_knowledge_add 工具非法 tags_json 应失败', async () => {
      const c = newCoordinator();
      const tool = c.getToolDefinitions().find(t => t.name === 'offline_knowledge_add')!;
      const result = JSON.parse(await tool.execute!({
        topic: '主题',
        content: '内容',
        tags_json: 'not-json',
      } as never) as string);
      expect(result.success).toBe(false);
    });

    it('offline_knowledge_list 工具应返回列表', async () => {
      const c = newCoordinator();
      const tool = c.getToolDefinitions().find(t => t.name === 'offline_knowledge_list')!;
      const result = JSON.parse(await tool.execute!({} as never) as string);
      expect(result.count).toBe(10);
      expect(Array.isArray(result.entries)).toBe(true);
    });

    it('offline_knowledge_list 工具支持分类过滤', async () => {
      const c = newCoordinator();
      const tool = c.getToolDefinitions().find(t => t.name === 'offline_knowledge_list')!;
      const result = JSON.parse(await tool.execute!({ category: 'programming' } as never) as string);
      expect(result.count).toBeGreaterThan(0);
      expect(result.entries.every((e: OfflineKnowledgeEntry) => e.category === 'programming')).toBe(true);
    });
  });

  // ========== 单例 ==========

  describe('单例', () => {
    it('getInstance 应返回同一实例', () => {
      const a = OfflineCoordinator.getInstance();
      const b = OfflineCoordinator.getInstance();
      expect(a).toBe(b);
    });

    it('getOfflineCoordinator 应返回单例', () => {
      const a = getOfflineCoordinator();
      const b = getOfflineCoordinator();
      expect(a).toBe(b);
    });

    it('_resetInstance 应重置单例', () => {
      const a = OfflineCoordinator.getInstance();
      OfflineCoordinator._resetInstance();
      const b = OfflineCoordinator.getInstance();
      expect(a).not.toBe(b);
    });
  });

  // ========== 边缘情况 ==========

  describe('边缘情况', () => {
    it('损坏的 status.json 应降级为默认值', () => {
      const dir = path.join(tmpDir, 'offline');
      fs.mkdirSync(dir, { recursive: true });
      fs.writeFileSync(path.join(dir, 'status.json'), '{invalid json');
      const c = new OfflineCoordinator(dir);
      c.initialize();
      expect(c.getNetworkState()).toBe('unknown');
    });

    it('损坏的 knowledge.json 应降级为内置', () => {
      const dir = path.join(tmpDir, 'offline');
      fs.mkdirSync(dir, { recursive: true });
      fs.writeFileSync(path.join(dir, 'knowledge.json'), '{invalid json');
      const c = new OfflineCoordinator(dir);
      c.initialize();
      // 加载失败后 injectBuiltinKnowledge 仍注入 10 条
      expect(c.getStats().knowledgeEntryCount).toBe(10);
    });

    it('损坏的 mode.json 应降级为关闭', () => {
      const dir = path.join(tmpDir, 'offline');
      fs.mkdirSync(dir, { recursive: true });
      fs.writeFileSync(path.join(dir, 'mode.json'), '{invalid json');
      const c = new OfflineCoordinator(dir);
      c.initialize();
      expect(c.isOfflineMode()).toBe(false);
    });

    it('损坏的 models.json 应降级为空', () => {
      const dir = path.join(tmpDir, 'offline');
      fs.mkdirSync(dir, { recursive: true });
      fs.writeFileSync(path.join(dir, 'models.json'), '{invalid json');
      const c = new OfflineCoordinator(dir);
      c.initialize();
      expect(c.getLocalModels().length).toBe(0);
    });

    it('extractKeywords 应正确分词中英文', () => {
      const c = newCoordinator();
      // 通过 queryOfflineKnowledge 间接验证
      const enResults = c.queryOfflineKnowledge('docker');
      expect(enResults.length).toBeGreaterThan(0);
      expect(enResults[0].entry.topic).toContain('Docker');

      const cnResults = c.queryOfflineKnowledge('正则表达式');
      expect(cnResults.length).toBeGreaterThan(0);
    });
  });
});
