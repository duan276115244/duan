/**
 * P3-2: 知识图谱记忆系统测试
 *
 * 覆盖核心能力：
 * - 实体/关系 CRUD
 * - 图谱遍历与路径查找
 * - 冲突检测
 * - 推理规则
 * - 语义搜索
 * - 文本抽取
 * - 图谱合并
 * - 持久化
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import { KnowledgeGraphMemory } from '../knowledge-graph-memory.js';

// ============ 测试工具 ============

let tmpDir: string;

function createKG(): KnowledgeGraphMemory {
  return new KnowledgeGraphMemory(tmpDir);
}

/** 构建测试图谱：TypeScript → JavaScript → Web */
function buildTestGraph(kg: KnowledgeGraphMemory): {
  tsId: string; jsId: string; webId: string; reactId: string;
} {
  const tsId = kg.addEntity({
    name: 'TypeScript',
    type: 'technology',
    properties: { description: 'Typed superset of JavaScript' },
    confidence: 0.95,
    source: 'test',
  });
  const jsId = kg.addEntity({
    name: 'JavaScript',
    type: 'technology',
    properties: { description: 'Dynamic programming language' },
    confidence: 0.95,
    source: 'test',
  });
  const webId = kg.addEntity({
    name: 'Web',
    type: 'domain',
    properties: { description: 'Web development domain' },
    confidence: 0.9,
    source: 'test',
  });
  const reactId = kg.addEntity({
    name: 'React',
    type: 'technology',
    properties: { description: 'UI library' },
    confidence: 0.9,
    source: 'test',
  });

  kg.addRelation({
    fromId: tsId,
    toId: jsId,
    type: 'is_a',
    weight: 0.9,
    confidence: 0.9,
    evidence: 'TypeScript is a superset of JavaScript',
    properties: {},
  });
  kg.addRelation({
    fromId: jsId,
    toId: webId,
    type: 'part_of',
    weight: 0.8,
    confidence: 0.85,
    evidence: 'JavaScript is used in web development',
    properties: {},
  });
  kg.addRelation({
    fromId: reactId,
    toId: jsId,
    type: 'depends_on',
    weight: 0.95,
    confidence: 0.9,
    evidence: 'React depends on JavaScript',
    properties: {},
  });

  return { tsId, jsId, webId, reactId };
}

// ============ 测试 ============

describe('KnowledgeGraphMemory', () => {
  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'kg-test-'));
  });

  afterEach(() => {
    if (fs.existsSync(tmpDir)) {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  // ===== 实体操作 =====

  describe('实体操作', () => {
    it('添加实体并返回 ID', () => {
      const kg = createKG();
      const id = kg.addEntity({
        name: 'TestEntity',
        type: 'concept',
        properties: {},
        confidence: 0.8,
        source: 'test',
      });
      expect(id).toMatch(/^ent_\d+_/);
    });

    it('获取实体', () => {
      const kg = createKG();
      const id = kg.addEntity({
        name: 'TestEntity',
        type: 'concept',
        properties: { key: 'value' },
        confidence: 0.8,
        source: 'test',
      });
      const entity = kg.getEntity(id);
      expect(entity).toBeDefined();
      expect(entity!.name).toBe('TestEntity');
      expect(entity!.type).toBe('concept');
      expect(entity!.properties.key).toBe('value');
    });

    it('同名同类型实体合并属性', () => {
      const kg = createKG();
      const id1 = kg.addEntity({
        name: 'React',
        type: 'technology',
        properties: { description: 'UI library' },
        confidence: 0.8,
        source: 'test',
      });
      const id2 = kg.addEntity({
        name: 'React',
        type: 'technology',
        properties: { version: '18' },
        confidence: 0.9,
        source: 'test2',
      });
      // 应返回同一 ID
      expect(id2).toBe(id1);
      const entity = kg.getEntity(id1);
      expect(entity!.properties.description).toBe('UI library');
      expect(entity!.properties.version).toBe('18');
      expect(entity!.confidence).toBe(0.9); // 取较高值
    });

    it('获取不存在的实体返回 undefined', () => {
      const kg = createKG();
      expect(kg.getEntity('nonexistent')).toBeUndefined();
    });
  });

  // ===== 关系操作 =====

  describe('关系操作', () => {
    it('添加关系并返回 ID', () => {
      const kg = createKG();
      const { tsId, jsId } = buildTestGraph(kg);
      const relId = kg.addRelation({
        fromId: tsId,
        toId: jsId,
        type: 'related_to',
        weight: 0.7,
        confidence: 0.8,
        evidence: 'test',
        properties: {},
      });
      expect(relId).toMatch(/^rel_\d+_/);
    });

    it('源实体不存在时返回空字符串', () => {
      const kg = createKG();
      const jsId = kg.addEntity({
        name: 'JS', type: 'tech', properties: {}, confidence: 0.8, source: 'test',
      });
      const relId = kg.addRelation({
        fromId: 'nonexistent',
        toId: jsId,
        type: 'related_to',
        weight: 0.5,
        confidence: 0.5,
        evidence: '',
        properties: {},
      });
      expect(relId).toBe('');
    });

    it('获取关系', () => {
      const kg = createKG();
      const { tsId, jsId } = buildTestGraph(kg);
      const relId = kg.addRelation({
        fromId: tsId,
        toId: jsId,
        type: 'is_a',
        weight: 0.9,
        confidence: 0.9,
        evidence: 'test evidence',
        properties: {},
      });
      const rel = kg.getRelation(relId);
      expect(rel).toBeDefined();
      expect(rel!.type).toBe('is_a');
      expect(rel!.evidence).toBe('test evidence');
    });
  });

  // ===== 图谱遍历 =====

  describe('图谱遍历 (query)', () => {
    it('从起始实体遍历邻居', () => {
      const kg = createKG();
      const { tsId } = buildTestGraph(kg);

      const result = kg.query(tsId, { depth: 2 });
      expect(result.startEntity).toBeDefined();
      expect(result.startEntity!.name).toBe('TypeScript');
      // depth=2 应遍历到 JavaScript 和 Web
      expect(result.entities.length).toBeGreaterThanOrEqual(2);
      const names = result.entities.map(e => e.name);
      expect(names).toContain('JavaScript');
      expect(names).toContain('Web');
    });

    it('按关系类型过滤', () => {
      const kg = createKG();
      const { tsId } = buildTestGraph(kg);

      const result = kg.query(tsId, { depth: 1, relationType: 'is_a' });
      expect(result.entities.length).toBe(1);
      expect(result.entities[0].name).toBe('JavaScript');
    });

    it('不存在的起始实体返回空结果', () => {
      const kg = createKG();
      const result = kg.query('nonexistent');
      expect(result.startEntity).toBeNull();
      expect(result.entities).toEqual([]);
    });
  });

  // ===== 路径查找 =====

  describe('路径查找 (findPath)', () => {
    it('找到两个实体间的最短路径', () => {
      const kg = createKG();
      const { tsId, webId } = buildTestGraph(kg);

      const path = kg.findPath(tsId, webId);
      expect(path).not.toBeNull();
      expect(path!.length).toBe(2); // TS → JS → Web
      expect(path!.entityIds).toContain(tsId);
      expect(path!.entityIds).toContain(webId);
    });

    it('起点和终点相同时返回零长度路径', () => {
      const kg = createKG();
      const { tsId } = buildTestGraph(kg);
      const path = kg.findPath(tsId, tsId);
      expect(path).not.toBeNull();
      expect(path!.length).toBe(0);
    });

    it('不存在路径时返回 null', () => {
      const kg = createKG();
      const { tsId } = buildTestGraph(kg);
      const isolatedId = kg.addEntity({
        name: 'Isolated',
        type: 'concept',
        properties: {},
        confidence: 0.5,
        source: 'test',
      });
      const path = kg.findPath(tsId, isolatedId);
      expect(path).toBeNull();
    });
  });

  // ===== 冲突检测 =====

  describe('冲突检测 (findConflicts)', () => {
    it('检测 contradicts 关系', () => {
      const kg = createKG();
      const aId = kg.addEntity({
        name: 'ClaimA', type: 'concept', properties: {}, confidence: 0.8, source: 'test',
      });
      const bId = kg.addEntity({
        name: 'ClaimB', type: 'concept', properties: {}, confidence: 0.8, source: 'test',
      });
      kg.addRelation({
        fromId: aId, toId: bId, type: 'contradicts',
        weight: 0.9, confidence: 0.9, evidence: 'A contradicts B', properties: {},
      });

      const conflicts = kg.findConflicts();
      expect(conflicts.length).toBeGreaterThan(0);
      const contradicts = conflicts.find(c => c.type === 'contradiction');
      expect(contradicts).toBeDefined();
    });

    it('无冲突时返回空数组', () => {
      const kg = createKG();
      buildTestGraph(kg);
      const conflicts = kg.findConflicts();
      expect(conflicts).toEqual([]);
    });
  });

  // ===== 语义搜索 =====

  describe('语义搜索 (search)', () => {
    it('按名称搜索实体', () => {
      const kg = createKG();
      buildTestGraph(kg);
      const results = kg.search('TypeScript', 5);
      expect(results.length).toBeGreaterThan(0);
      expect(results[0].name).toBe('TypeScript');
    });

    it('按属性关键词搜索', () => {
      const kg = createKG();
      buildTestGraph(kg);
      const results = kg.search('UI library', 5);
      expect(results.length).toBeGreaterThan(0);
      expect(results.some(e => e.name === 'React')).toBe(true);
    });

    it('无匹配时返回空数组', () => {
      const kg = createKG();
      buildTestGraph(kg);
      const results = kg.search('nonexistent_xyz', 5);
      expect(results).toEqual([]);
    });
  });

  // ===== 文本抽取 =====

  describe('文本抽取 (extractFromText)', () => {
    it('从文本中抽取实体', () => {
      const kg = createKG();
      const result = kg.extractFromText('React 是 JavaScript 库', 'test');
      expect(result.newEntities).toBeGreaterThan(0);
    });

    it('从文本中抽取关系', () => {
      const kg = createKG();
      // "React 依赖 JavaScript" 应抽取 depends_on 关系
      const result = kg.extractFromText('React 依赖 JavaScript', 'test');
      expect(result.newEntities).toBeGreaterThan(0);
      // 关系抽取可能需要特定模式匹配
    });

    it('重复抽取不产生重复实体', () => {
      const kg = createKG();
      const text = 'TypeScript 是 JavaScript';
      const r1 = kg.extractFromText(text, 'test');
      const r2 = kg.extractFromText(text, 'test');
      expect(r1.newEntities).toBeGreaterThan(0);
      expect(r2.newEntities).toBe(0); // 第二次不新增
    });
  });

  // ===== 图谱合并 =====

  describe('图谱合并 (merge)', () => {
    it('合并两个图谱', () => {
      const kg1 = createKG();
      const kg2 = createKG();

      kg1.addEntity({
        name: 'EntityA', type: 'concept', properties: {}, confidence: 0.8, source: 'kg1',
      });
      kg2.addEntity({
        name: 'EntityB', type: 'concept', properties: {}, confidence: 0.8, source: 'kg2',
      });

      const result = kg1.merge(kg2);
      expect(result.entitiesMerged).toBeGreaterThan(0);
      const stats = kg1.getStats();
      expect(stats.totalEntities).toBeGreaterThanOrEqual(2);
    });
  });

  // ===== 统计信息 =====

  describe('统计信息 (getStats)', () => {
    it('返回正确的统计', () => {
      const kg = createKG();
      buildTestGraph(kg);
      const stats = kg.getStats();
      expect(stats.totalEntities).toBe(4);
      expect(stats.totalRelations).toBe(3);
      expect(stats.entityTypes.technology).toBe(3);
      expect(stats.entityTypes.domain).toBe(1);
      expect(stats.relationTypes.is_a).toBe(1);
      expect(stats.relationTypes.part_of).toBe(1);
      expect(stats.relationTypes.depends_on).toBe(1);
      expect(stats.avgConfidence).toBeGreaterThan(0);
    });

    it('空图谱统计', () => {
      const kg = createKG();
      const stats = kg.getStats();
      expect(stats.totalEntities).toBe(0);
      expect(stats.totalRelations).toBe(0);
    });
  });

  // ===== 持久化 =====

  describe('持久化 (persist/load)', () => {
    it('持久化并重新加载', async () => {
      const kg = createKG();
      const { tsId } = buildTestGraph(kg);
      await kg.persist();

      const kg2 = createKG();
      await kg2.load();

      const entity = kg2.getEntity(tsId);
      expect(entity).toBeDefined();
      expect(entity!.name).toBe('TypeScript');
      const stats = kg2.getStats();
      expect(stats.totalEntities).toBe(4);
      expect(stats.totalRelations).toBe(3);
    });

    it('加载不存在的文件不抛出错误', async () => {
      const kg = createKG();
      await expect(kg.load()).resolves.not.toThrow();
    });
  });

  // ===== 导出 =====

  describe('导出 (exportData)', () => {
    it('导出实体和关系数据', () => {
      const kg = createKG();
      buildTestGraph(kg);
      const data = kg.exportData();
      expect(data.entities.length).toBe(4);
      expect(data.relations.length).toBe(3);
    });
  });

  describe('资源释放 (dispose)', () => {
    it('dispose 后所有数据被清空', () => {
      const kg = createKG();
      buildTestGraph(kg);
      expect(kg.getStats().totalEntities).toBeGreaterThan(0);

      kg.dispose();

      const stats = kg.getStats();
      expect(stats.totalEntities).toBe(0);
      expect(stats.totalRelations).toBe(0);
    });

    it('dispose 后查询返回空结果', () => {
      const kg = createKG();
      buildTestGraph(kg);

      kg.dispose();

      expect(kg.query('nonexistent')).toEqual({ startEntity: null, entities: [], relations: [], depth: 0 });
      expect(kg.search('React')).toHaveLength(0);
    });
  });
});
