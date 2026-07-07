/**
 * 知识图谱记忆系统 — KnowledgeGraphMemory
 *
 * 结构化知识存储与关系推理引擎，填补竞品无法覆盖的空白：
 * - 实体节点：带类型、属性、置信度的知识实体
 * - 关系边：实体间带权重的类型化关系，附带证据溯源
 * - 推理能力：传递推理、冲突检测、时序推理
 * - 图操作：遍历、路径查找、合并、语义搜索
 *
 * 持久化：.duan/knowledge-graph-memory.json
 * 集成：与 MemoryOrchestrator 协同工作
 */

import * as fs from 'fs';
import * as path from 'path';
import { logger } from './structured-logger.js';
import { EventBus } from './event-bus.js';
import type { ToolDef } from './unified-tool-def.js';
import { atomicWriteJson } from './atomic-write.js';
import type { EmbeddingProvider } from './embedding-provider.js';
import { duanPath } from './duan-paths.js';

// ============ 类型定义 ============

/** 知识图谱实体 */
export interface KGEntity {
  /** 实体唯一ID */
  id: string;
  /** 实体名称 */
  name: string;
  /** 实体类型（concept/technology/person/organization/event/domain等） */
  type: string;
  /** 实体属性 */
  properties: Record<string, string>;
  /** 置信度（0-1） */
  confidence: number;
  /** 来源标识 */
  source: string;
  /** 创建时间 */
  createdAt: number;
  /** 更新时间 */
  updatedAt: number;
  /** 访问次数 */
  accessCount: number;
}

/** 知识图谱关系 */
export interface KGRelation {
  /** 关系唯一ID */
  id: string;
  /** 起始实体ID */
  fromId: string;
  /** 目标实体ID */
  toId: string;
  /** 关系类型（is_a/part_of/depends_on/enables/related_to/contradicts等） */
  type: string;
  /** 关系权重（0-1，表示强度） */
  weight: number;
  /** 置信度（0-1） */
  confidence: number;
  /** 证据/来源描述 */
  evidence: string;
  /** 关系属性 */
  properties: Record<string, string>;
  /** 创建时间 */
  createdAt: number;
}

/** 查询选项 */
export interface KGQueryOptions {
  /** 关系类型过滤 */
  relationType?: string;
  /** 遍历深度，默认1 */
  depth?: number;
  /** 最大结果数 */
  limit?: number;
  /** 方向：outgoing/incoming/both，默认both */
  direction?: 'outgoing' | 'incoming' | 'both';
  /** 最小置信度过滤 */
  minConfidence?: number;
  /** 最小权重过滤 */
  minWeight?: number;
}

/** 查询结果 */
export interface KGQueryResult {
  /** 起始实体 */
  startEntity: KGEntity | null;
  /** 遍历到的实体 */
  entities: KGEntity[];
  /** 遍历到的关系 */
  relations: KGRelation[];
  /** 遍历深度 */
  depth: number;
}

/** 路径结果 */
export interface KGPath {
  /** 路径上的实体ID序列 */
  entityIds: string[];
  /** 路径上的关系序列 */
  relations: KGRelation[];
  /** 路径总权重 */
  totalWeight: number;
  /** 路径长度（跳数） */
  length: number;
}

/** 冲突检测结果 */
export interface KGConflict {
  /** 冲突类型 */
  type: 'contradiction' | 'inconsistency' | 'temporal_conflict';
  /** 冲突描述 */
  description: string;
  /** 涉及的关系 */
  relations: KGRelation[];
  /** 涉及的实体 */
  entities: KGEntity[];
  /** 冲突严重程度（0-1） */
  severity: number;
  /** 建议的解决方案 */
  resolution: string;
}

/** 推理规则 */
export interface InferenceRule {
  /** 规则名称 */
  name: string;
  /** 前提关系类型序列 */
  premise: string[];
  /** 推导出的关系类型 */
  conclusion: string;
  /** 推理置信度衰减因子（0-1） */
  confidenceDecay: number;
  /** 规则描述 */
  description: string;
}

/** 知识图谱统计 */
export interface KGStats {
  /** 实体总数 */
  totalEntities: number;
  /** 关系总数 */
  totalRelations: number;
  /** 按类型统计实体数 */
  entityTypes: Record<string, number>;
  /** 按类型统计关系数 */
  relationTypes: Record<string, number>;
  /** 平均连通度 */
  avgConnectivity: number;
  /** 最大连通度 */
  maxConnectivity: number;
  /** 平均置信度 */
  avgConfidence: number;
  /** 最后更新时间 */
  lastUpdated: number;
}

/** 持久化数据结构 */
interface KGPersistence {
  entities: KGEntity[];
  relations: KGRelation[];
  lastUpdated: number;
  /** P3-2: 嵌入索引（持久化以避免重启重算） */
  embeddings?: Array<{ entityId: string; vector: number[] }>;
}

// ============ 知识图谱记忆主类 ============

export class KnowledgeGraphMemory {
  private entities: Map<string, KGEntity> = new Map();
  private relations: Map<string, KGRelation> = new Map();

  /** 名称→ID索引，加速按名称查找 */
  private nameIndex: Map<string, string> = new Map();

  /** 正向邻接表：entityId → Set<relationId> */
  private outgoingIndex: Map<string, Set<string>> = new Map();

  /** 反向邻接表：entityId → Set<relationId> */
  private incomingIndex: Map<string, Set<string>> = new Map();

  /** 持久化路径 */
  private filePath: string;

  private log = logger.child({ module: 'KnowledgeGraphMemory' });

  /** P3-2: 向量嵌入索引（entityId → embedding）用于向量检索 */
  private embeddingIndex: Map<string, number[]> = new Map();

  /**
   * P3-2: 嵌入提供者 — 真实语义向量生成
   *
   * 若注入此 provider，则 indexEntityEmbeddingAsync / hybridRecallAsync 会使用真实嵌入
   * （OpenAI 1536 维语义向量 / TF-IDF 512 维统计向量）。
   * 若未注入，则降级为 computeSimpleEmbedding 的 128 维词袋哈希（保持向后兼容）。
   */
  private embeddingProvider: EmbeddingProvider | null = null;

  /** P3-2: 抽取规则配置 */
  private extractionConfig: ExtractionConfig = {
    entityPatterns: [
      // 编程语言
      { type: 'language', pattern: /\b(TypeScript|JavaScript|Python|Rust|Go|Java|C\+\+|Ruby|Swift|Kotlin)\b/g },
      // 框架/库
      { type: 'framework', pattern: /\b(React|Vue|Angular|Express|Next\.js|Django|Flask|Spring|Fastify)\b/g },
      // 工具
      { type: 'tool', pattern: /\b(Git|Docker|Kubernetes|Webpack|Vite|ESLint|Prettier|Vitest|Jest)\b/g },
      // 文件路径
      { type: 'file', pattern: /\b([\w-]+\.(ts|js|py|rs|go|java|json|md))\b/g },
      // 概念
      { type: 'concept', pattern: /\b(API|REST|GraphQL|gRPC|WebSocket|OAuth|JWT|CI\/CD)\b/g },
    ],
    relationPatterns: [
      // "A 使用 B"
      { type: 'uses', pattern: /(\w+)\s+(?:使用|用|uses?|using)\s+(\w+)/g },
      // "A 依赖 B"
      { type: 'depends_on', pattern: /(\w+)\s+(?:依赖|depends?\s+on)\s+(\w+)/g },
      // "A 是 B"
      { type: 'is_a', pattern: /(\w+)\s+(?:是|is\s+(?:a|an))\s+(\w+)/g },
      // "A 包含 B"
      { type: 'contains', pattern: /(\w+)\s+(?:包含|contains?)\s+(\w+)/g },
    ],
  };

  constructor(baseDir?: string) {
    const dir = baseDir || duanPath();
    this.filePath = path.join(dir, 'knowledge-graph-memory.json');
  }

  // ========== 实体操作 ==========

  /**
   * 添加实体，返回实体ID
   */
  addEntity(entity: Omit<KGEntity, 'id' | 'createdAt' | 'updatedAt' | 'accessCount'> & { id?: string }): string {
    const id = entity.id ?? `ent_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
    const now = Date.now();

    // 如果已存在同名同类型实体，合并属性
    const existingByName = this.findEntityByName(entity.name, entity.type);
    if (existingByName && !entity.id) {
      // 合并属性
      const merged = { ...existingByName.properties, ...entity.properties };
      existingByName.properties = merged;
      existingByName.confidence = Math.max(existingByName.confidence, entity.confidence);
      existingByName.updatedAt = now;
      this.nameIndex.set(`${entity.name.toLowerCase()}:${entity.type}`, existingByName.id);
      return existingByName.id;
    }

    // 如果指定了ID且已存在，更新
    if (entity.id && this.entities.has(entity.id)) {
      const existing = this.entities.get(entity.id)!;
      existing.name = entity.name;
      existing.type = entity.type;
      existing.properties = { ...existing.properties, ...entity.properties };
      existing.confidence = Math.max(existing.confidence, entity.confidence);
      existing.source = entity.source;
      existing.updatedAt = now;
      return existing.id;
    }

    const kgEntity: KGEntity = {
      id,
      name: entity.name,
      type: entity.type,
      properties: entity.properties,
      confidence: entity.confidence,
      source: entity.source,
      createdAt: now,
      updatedAt: now,
      accessCount: 0,
    };

    this.entities.set(id, kgEntity);
    this.nameIndex.set(`${entity.name.toLowerCase()}:${entity.type}`, id);

    // 初始化邻接表
    if (!this.outgoingIndex.has(id)) this.outgoingIndex.set(id, new Set());
    if (!this.incomingIndex.has(id)) this.incomingIndex.set(id, new Set());

    return id;
  }

  /**
   * 获取实体
   */
  getEntity(id: string): KGEntity | undefined {
    const entity = this.entities.get(id);
    if (entity) {
      entity.accessCount++;
    }
    return entity;
  }

  /**
   * 按名称和类型查找实体
   */
  private findEntityByName(name: string, type: string): KGEntity | undefined {
    const id = this.nameIndex.get(`${name.toLowerCase()}:${type}`);
    return id ? this.entities.get(id) : undefined;
  }

  // ========== 关系操作 ==========

  /**
   * 添加关系，返回关系ID
   */
  addRelation(relation: Omit<KGRelation, 'id' | 'createdAt'> & { id?: string }): string {
    const id = relation.id ?? `rel_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;

    // 验证实体存在
    if (!this.entities.has(relation.fromId)) {
      this.log.warn('关系起始实体不存在', { fromId: relation.fromId });
      return '';
    }
    if (!this.entities.has(relation.toId)) {
      this.log.warn('关系目标实体不存在', { toId: relation.toId });
      return '';
    }

    // 如果指定了ID且已存在，更新
    if (relation.id && this.relations.has(relation.id)) {
      const existing = this.relations.get(relation.id)!;
      existing.type = relation.type;
      existing.weight = relation.weight;
      existing.confidence = relation.confidence;
      existing.evidence = relation.evidence;
      existing.properties = { ...existing.properties, ...relation.properties };
      return existing.id;
    }

    const kgRelation: KGRelation = {
      id,
      fromId: relation.fromId,
      toId: relation.toId,
      type: relation.type,
      weight: relation.weight,
      confidence: relation.confidence,
      evidence: relation.evidence,
      properties: relation.properties,
      createdAt: Date.now(),
    };

    this.relations.set(id, kgRelation);

    // 更新邻接表
    if (!this.outgoingIndex.has(relation.fromId)) {
      this.outgoingIndex.set(relation.fromId, new Set());
    }
    this.outgoingIndex.get(relation.fromId)!.add(id);

    if (!this.incomingIndex.has(relation.toId)) {
      this.incomingIndex.set(relation.toId, new Set());
    }
    this.incomingIndex.get(relation.toId)!.add(id);

    return id;
  }

  /**
   * 获取关系
   */
  getRelation(id: string): KGRelation | undefined {
    return this.relations.get(id);
  }

  // ========== 查询操作 ==========

  /**
   * 从指定实体出发遍历图谱
   */
  query(startId: string, options?: KGQueryOptions): KGQueryResult {
    const startEntity = this.entities.get(startId) ?? null;
    if (!startEntity) {
      return { startEntity: null, entities: [], relations: [], depth: 0 };
    }

    const depth = options?.depth ?? 1;
    const limit = options?.limit ?? 50;
    const direction = options?.direction ?? 'both';
    const minConfidence = options?.minConfidence ?? 0;
    const minWeight = options?.minWeight ?? 0;
    const relationType = options?.relationType;

    const visitedEntities = new Set<string>([startId]);
    const collectedRelations: KGRelation[] = [];
    const collectedEntities: KGEntity[] = [];

    // BFS遍历
    let currentLevel = new Set<string>([startId]);

    for (let d = 0; d < depth; d++) {
      const nextLevel = new Set<string>();

      for (const entityId of Array.from(currentLevel)) {
        const neighborRelations = this.getNeighborRelations(entityId, direction);

        for (const rel of neighborRelations) {
          // 过滤
          if (relationType && rel.type !== relationType) continue;
          if (rel.confidence < minConfidence) continue;
          if (rel.weight < minWeight) continue;

          collectedRelations.push(rel);

          const neighborId = rel.fromId === entityId ? rel.toId : rel.fromId;
          if (!visitedEntities.has(neighborId)) {
            visitedEntities.add(neighborId);
            const neighbor = this.entities.get(neighborId);
            if (neighbor) {
              collectedEntities.push(neighbor);
              nextLevel.add(neighborId);
            }
          }
        }
      }

      currentLevel = nextLevel;
      if (currentLevel.size === 0) break;
    }

    return {
      startEntity,
      entities: collectedEntities.slice(0, limit),
      relations: collectedRelations.slice(0, limit),
      depth,
    };
  }

  /**
   * 获取实体的邻居关系
   */
  private getNeighborRelations(entityId: string, direction: 'outgoing' | 'incoming' | 'both'): KGRelation[] {
    const relations: KGRelation[] = [];

    if (direction === 'outgoing' || direction === 'both') {
      const outgoing = this.outgoingIndex.get(entityId);
      if (outgoing) {
        for (const relId of Array.from(outgoing)) {
          const rel = this.relations.get(relId);
          if (rel) relations.push(rel);
        }
      }
    }

    if (direction === 'incoming' || direction === 'both') {
      const incoming = this.incomingIndex.get(entityId);
      if (incoming) {
        for (const relId of Array.from(incoming)) {
          const rel = this.relations.get(relId);
          if (rel) relations.push(rel);
        }
      }
    }

    return relations;
  }

  // ========== 路径查找 ==========

  /**
   * 查找两个实体之间的最短路径（Dijkstra，按权重）
   */
  findPath(fromId: string, toId: string, maxDepth: number = 6): KGPath | null {
    if (!this.entities.has(fromId) || !this.entities.has(toId)) return null;
    if (fromId === toId) {
      return {
        entityIds: [fromId],
        relations: [],
        totalWeight: 0,
        length: 0,
      };
    }

    // Dijkstra最短路径
    const distances = new Map<string, number>();
    const previous = new Map<string, { entityId: string; relationId: string }>();
    const visited = new Set<string>();

    distances.set(fromId, 0);
    const queue: Array<{ id: string; dist: number }> = [{ id: fromId, dist: 0 }];

    while (queue.length > 0) {
      // 取距离最小的节点
      queue.sort((a, b) => a.dist - b.dist);
      const current = queue.shift()!;

      if (visited.has(current.id)) continue;
      visited.add(current.id);

      if (current.id === toId) break;

      if (distances.get(current.id)! > maxDepth) continue;

      // 遍历邻居
      const neighborRels = this.getNeighborRelations(current.id, 'both');

      for (const rel of neighborRels) {
        const neighborId = rel.fromId === current.id ? rel.toId : rel.fromId;
        if (visited.has(neighborId)) continue;

        // 权重越小越好（使用 1 - weight 作为距离，因为高权重表示强关系）
        const edgeDist = 1 - rel.weight + 0.1; // 加0.1避免0距离
        const newDist = current.dist + edgeDist;

        const existingDist = distances.get(neighborId) ?? Infinity;
        if (newDist < existingDist) {
          distances.set(neighborId, newDist);
          previous.set(neighborId, { entityId: current.id, relationId: rel.id });
          queue.push({ id: neighborId, dist: newDist });
        }
      }
    }

    // 回溯路径
    if (!previous.has(toId)) return null;

    const entityIds: string[] = [toId];
    const pathRelations: KGRelation[] = [];
    let current = toId;

    while (current !== fromId) {
      const prev = previous.get(current);
      if (!prev) return null;
      entityIds.unshift(prev.entityId);
      const rel = this.relations.get(prev.relationId);
      if (rel) pathRelations.unshift(rel);
      current = prev.entityId;
    }

    return {
      entityIds,
      relations: pathRelations,
      totalWeight: distances.get(toId) ?? 0,
      length: pathRelations.length,
    };
  }

  // ========== 冲突检测 ==========

  /**
   * 检测知识图谱中的冲突
   */
  findConflicts(): KGConflict[] {
    const conflicts: KGConflict[] = [];

    // 1. 检测矛盾关系（contradicts类型）
    for (const rel of Array.from(this.relations.values())) {
      if (rel.type === 'contradicts') {
        const fromEntity = this.entities.get(rel.fromId);
        const toEntity = this.entities.get(rel.toId);
        if (fromEntity && toEntity) {
          conflicts.push({
            type: 'contradiction',
            description: `"${fromEntity.name}" 与 "${toEntity.name}" 存在矛盾关系`,
            relations: [rel],
            entities: [fromEntity, toEntity],
            severity: rel.weight,
            resolution: '检查矛盾双方的可信度，保留置信度更高的一方，或标记需要人工审核',
          });
        }
      }
    }

    // 2. 检测传递性不一致（A is_a B, B is_a C, 但 A contradicts C）
    const isARelations = Array.from(this.relations.values()).filter(r => r.type === 'is_a');
    for (const relA of isARelations) {
      for (const relB of isARelations) {
        if (relA.toId === relB.fromId) {
          // A is_a B, B is_a C → 检查 A 和 C 之间是否有矛盾
          const contradictRel = Array.from(this.relations.values()).find(
            r => r.type === 'contradicts' &&
              ((r.fromId === relA.fromId && r.toId === relB.toId) ||
               (r.toId === relA.fromId && r.fromId === relB.toId)),
          );
          if (contradictRel) {
            const entityA = this.entities.get(relA.fromId);
            const entityB = this.entities.get(relA.toId);
            const entityC = this.entities.get(relB.toId);
            if (entityA && entityB && entityC) {
              conflicts.push({
                type: 'inconsistency',
                description: `传递性不一致："${entityA.name}" is_a "${entityB.name}"，"${entityB.name}" is_a "${entityC.name}"，但 "${entityA.name}" 与 "${entityC.name}" 矛盾`,
                relations: [relA, relB, contradictRel],
                entities: [entityA, entityB, entityC],
                severity: 0.8,
                resolution: '检查is_a关系的正确性，可能存在分类错误',
              });
            }
          }
        }
      }
    }

    // 3. 检测时序冲突（同一实体对之间存在多个互斥关系）
    const relationPairs = new Map<string, KGRelation[]>();
    for (const rel of Array.from(this.relations.values())) {
      const pairKey = [rel.fromId, rel.toId].sort().join(':');
      if (!relationPairs.has(pairKey)) {
        relationPairs.set(pairKey, []);
      }
      relationPairs.get(pairKey)!.push(rel);
    }

    // 互斥关系类型对
    const mutuallyExclusive: Array<[string, string]> = [
      ['is_a', 'contradicts'],
      ['enables', 'prevents'],
      ['part_of', 'excludes'],
    ];

    for (const rels of Array.from(relationPairs.values())) {
      if (rels.length < 2) continue;

      for (const [typeA, typeB] of mutuallyExclusive) {
        const hasA = rels.find(r => r.type === typeA);
        const hasB = rels.find(r => r.type === typeB);
        if (hasA && hasB) {
          const fromEntity = this.entities.get(hasA.fromId);
          const toEntity = this.entities.get(hasA.toId);
          if (fromEntity && toEntity) {
            conflicts.push({
              type: 'temporal_conflict',
              description: `"${fromEntity.name}" 和 "${toEntity.name}" 之间同时存在 "${typeA}" 和 "${typeB}" 关系`,
              relations: [hasA, hasB],
              entities: [fromEntity, toEntity],
              severity: 0.6,
              resolution: '检查两种关系的上下文，可能需要添加时间戳或条件限定',
            });
          }
        }
      }
    }

    return conflicts;
  }

  // ========== 推理 ==========

  /**
   * 应用推理规则推导新知识
   */
  infer(rules?: InferenceRule[]): KGRelation[] {
    const defaultRules: InferenceRule[] = [
      {
        name: 'is_a传递性',
        premise: ['is_a', 'is_a'],
        conclusion: 'is_a',
        confidenceDecay: 0.8,
        description: 'A is_a B, B is_a C → A is_a C',
      },
      {
        name: 'part_of传递性',
        premise: ['part_of', 'part_of'],
        conclusion: 'part_of',
        confidenceDecay: 0.8,
        description: 'A part_of B, B part_of C → A part_of C',
      },
      {
        name: 'depends_on传递性',
        premise: ['depends_on', 'depends_on'],
        conclusion: 'depends_on',
        confidenceDecay: 0.75,
        description: 'A depends_on B, B depends_on C → A depends_on C',
      },
      {
        name: 'is_a继承enables',
        premise: ['is_a', 'enables'],
        conclusion: 'enables',
        confidenceDecay: 0.7,
        description: 'A is_a B, B enables C → A enables C',
      },
    ];

    const effectiveRules = rules ?? defaultRules;
    const inferred: KGRelation[] = [];

    for (const rule of effectiveRules) {
      if (rule.premise.length !== 2) continue;

      const [premiseA, premiseB] = rule.premise;
      const relsA = Array.from(this.relations.values()).filter(r => r.type === premiseA);
      const relsB = Array.from(this.relations.values()).filter(r => r.type === premiseB);

      for (const ra of relsA) {
        for (const rb of relsB) {
          // ra: X → Y, rb: Y → Z → 推导 X → Z
          if (ra.toId === rb.fromId) {
            // 检查是否已存在相同关系
            const exists = Array.from(this.relations.values()).some(
              r => r.fromId === ra.fromId && r.toId === rb.toId && r.type === rule.conclusion,
            );
            if (exists) continue;
            // 不自引用
            if (ra.fromId === rb.toId) continue;

            const confidence = Math.min(ra.confidence, rb.confidence) * rule.confidenceDecay;
            const weight = Math.min(ra.weight, rb.weight) * rule.confidenceDecay;

            const inferredRel: KGRelation = {
              id: `inferred_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`,
              fromId: ra.fromId,
              toId: rb.toId,
              type: rule.conclusion,
              weight,
              confidence,
              evidence: `推理规则[${rule.name}]: ${ra.id} + ${rb.id}`,
              properties: {
                inferred: 'true',
                rule: rule.name,
                premiseA: ra.id,
                premiseB: rb.id,
              },
              createdAt: Date.now(),
            };

            // 添加到图谱
            this.relations.set(inferredRel.id, inferredRel);
            if (!this.outgoingIndex.has(inferredRel.fromId)) {
              this.outgoingIndex.set(inferredRel.fromId, new Set());
            }
            this.outgoingIndex.get(inferredRel.fromId)!.add(inferredRel.id);
            if (!this.incomingIndex.has(inferredRel.toId)) {
              this.incomingIndex.set(inferredRel.toId, new Set());
            }
            this.incomingIndex.get(inferredRel.toId)!.add(inferredRel.id);

            inferred.push(inferredRel);
          }
        }
      }
    }

    return inferred;
  }

  // ========== 搜索 ==========

  /**
   * 语义+关键词搜索实体
   */
  search(query: string, limit: number = 10): KGEntity[] {
    const keywords = query.toLowerCase().split(/\s+/).filter(kw => kw.length >= 2);
    if (keywords.length === 0) return [];

    const scored: Array<{ entity: KGEntity; score: number }> = [];

    for (const entity of Array.from(this.entities.values())) {
      let score = 0;

      // 名称匹配（权重最高）
      const nameLower = entity.name.toLowerCase();
      for (const kw of keywords) {
        if (nameLower === kw) {
          score += 3.0; // 完全匹配
        } else if (nameLower.includes(kw)) {
          score += 2.0; // 部分匹配
        }
      }

      // 类型匹配
      const typeLower = entity.type.toLowerCase();
      for (const kw of keywords) {
        if (typeLower.includes(kw)) score += 1.0;
      }

      // 属性匹配
      for (const value of Object.values(entity.properties)) {
        const valueStr = String(value).toLowerCase();
        for (const kw of keywords) {
          if (valueStr.includes(kw)) score += 0.5;
        }
      }

      // 置信度加权
      score *= (0.5 + entity.confidence * 0.5);

      // 访问频率加权
      score += Math.min(entity.accessCount / 100, 0.5);

      if (score > 0) {
        scored.push({ entity, score });
      }
    }

    scored.sort((a, b) => b.score - a.score);
    return scored.slice(0, limit).map(s => s.entity);
  }

  // ========== 合并 ==========

  /**
   * 合并另一个知识图谱
   */
  merge(other: KnowledgeGraphMemory): { entitiesMerged: number; relationsMerged: number } {
    let entitiesMerged = 0;
    let relationsMerged = 0;

    // 合并实体
    for (const entity of Array.from(other.entities.values())) {
      const existing = this.entities.get(entity.id);
      if (existing) {
        // 合并属性，保留更高置信度
        existing.properties = { ...existing.properties, ...entity.properties };
        existing.confidence = Math.max(existing.confidence, entity.confidence);
        existing.updatedAt = Date.now();
      } else {
        this.entities.set(entity.id, { ...entity });
        this.nameIndex.set(`${entity.name.toLowerCase()}:${entity.type}`, entity.id);
        if (!this.outgoingIndex.has(entity.id)) this.outgoingIndex.set(entity.id, new Set());
        if (!this.incomingIndex.has(entity.id)) this.incomingIndex.set(entity.id, new Set());
        entitiesMerged++;
      }
    }

    // 合并关系
    for (const relation of Array.from(other.relations.values())) {
      const existing = this.relations.get(relation.id);
      if (existing) {
        // 保留更高置信度
        if (relation.confidence > existing.confidence) {
          existing.confidence = relation.confidence;
          existing.weight = relation.weight;
          existing.evidence = relation.evidence;
        }
      } else {
        // 验证实体存在
        if (this.entities.has(relation.fromId) && this.entities.has(relation.toId)) {
          this.relations.set(relation.id, { ...relation });
          this.outgoingIndex.get(relation.fromId)?.add(relation.id);
          this.incomingIndex.get(relation.toId)?.add(relation.id);
          relationsMerged++;
        }
      }
    }

    return { entitiesMerged, relationsMerged };
  }

  // ========== 统计 ==========

  /**
   * 获取知识图谱统计信息
   */
  getStats(): KGStats {
    const entityTypes: Record<string, number> = {};
    const relationTypes: Record<string, number> = {};
    let totalConnectivity = 0;
    let maxConnectivity = 0;
    let totalConfidence = 0;

    for (const entity of Array.from(this.entities.values())) {
      entityTypes[entity.type] = (entityTypes[entity.type] || 0) + 1;
      const connectivity = (this.outgoingIndex.get(entity.id)?.size ?? 0) +
        (this.incomingIndex.get(entity.id)?.size ?? 0);
      totalConnectivity += connectivity;
      maxConnectivity = Math.max(maxConnectivity, connectivity);
      totalConfidence += entity.confidence;
    }

    for (const relation of Array.from(this.relations.values())) {
      relationTypes[relation.type] = (relationTypes[relation.type] || 0) + 1;
    }

    return {
      totalEntities: this.entities.size,
      totalRelations: this.relations.size,
      entityTypes,
      relationTypes,
      avgConnectivity: this.entities.size > 0 ? totalConnectivity / this.entities.size : 0,
      maxConnectivity,
      avgConfidence: this.entities.size > 0 ? totalConfidence / this.entities.size : 0,
      lastUpdated: Date.now(),
    };
  }

  // ========== 持久化 ==========

  /**
   * 异步判断路径是否存在（替代 fs.existsSync 的异步版本）
   */
  private async pathExists(target: string): Promise<boolean> {
    try {
      await fs.promises.access(target);
      return true;
    } catch {
      return false;
    }
  }

  /**
   * 持久化到 .duan/knowledge-graph-memory.json
   */
  async persist(): Promise<void> {
    try {
      const dir = path.dirname(this.filePath);
      if (!(await this.pathExists(dir))) {
        await fs.promises.mkdir(dir, { recursive: true });
      }

      const data: KGPersistence = {
        entities: Array.from(this.entities.values()),
        relations: Array.from(this.relations.values()),
        lastUpdated: Date.now(),
        // P3-2: 持久化嵌入索引
        embeddings: Array.from(this.embeddingIndex.entries()).map(
          ([entityId, vector]) => ({ entityId, vector }),
        ),
      };

      // 原子写：知识图谱可能很大，半写会导致关联查询全断
      await atomicWriteJson(this.filePath, data);
      this.log.debug('知识图谱持久化成功', {
        entities: data.entities.length,
        relations: data.relations.length,
        embeddings: data.embeddings.length,
      });
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      this.log.warn('知识图谱持久化失败', { error: msg });
    }
  }

  /**
   * 从 .duan/knowledge-graph-memory.json 加载
   */
  async load(): Promise<void> {
    try {
      if (!(await this.pathExists(this.filePath))) {
        this.log.debug('知识图谱文件不存在，跳过加载');
        return;
      }

      const raw = await fs.promises.readFile(this.filePath, 'utf-8');
      const data: KGPersistence = JSON.parse(raw);

      // 重建索引
      this.entities.clear();
      this.relations.clear();
      this.nameIndex.clear();
      this.outgoingIndex.clear();
      this.incomingIndex.clear();
      this.embeddingIndex.clear();

      for (const entity of data.entities) {
        this.entities.set(entity.id, entity);
        this.nameIndex.set(`${entity.name.toLowerCase()}:${entity.type}`, entity.id);
        if (!this.outgoingIndex.has(entity.id)) this.outgoingIndex.set(entity.id, new Set());
        if (!this.incomingIndex.has(entity.id)) this.incomingIndex.set(entity.id, new Set());
      }

      for (const relation of data.relations) {
        this.relations.set(relation.id, relation);
        if (!this.outgoingIndex.has(relation.fromId)) {
          this.outgoingIndex.set(relation.fromId, new Set());
        }
        this.outgoingIndex.get(relation.fromId)!.add(relation.id);
        if (!this.incomingIndex.has(relation.toId)) {
          this.incomingIndex.set(relation.toId, new Set());
        }
        this.incomingIndex.get(relation.toId)!.add(relation.id);
      }

      // P3-2: 加载嵌入索引
      if (data.embeddings) {
        for (const { entityId, vector } of data.embeddings) {
          this.embeddingIndex.set(entityId, vector);
        }
      }

      this.log.info('知识图谱加载成功', {
        entities: this.entities.size,
        relations: this.relations.size,
        embeddings: this.embeddingIndex.size,
      });
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      this.log.warn('知识图谱加载失败', { error: msg });
    }
  }

  // ========== 导出 ==========

  /**
   * 导出全部数据
   */
  exportData(): { entities: KGEntity[]; relations: KGRelation[] } {
    return {
      entities: Array.from(this.entities.values()),
      relations: Array.from(this.relations.values()),
    };
  }

  // ========== P3-2: 自动抽取、混合召回、多跳推理 ==========

  /**
   * P3-2: 从用户交互文本中自动抽取实体与关系
   *
   * 基于正则模式的轻量 NLP 管道，识别编程语言、框架、工具、文件、概念等实体，
   * 以及"使用/依赖/是/包含"等关系，自动构建知识图谱。
   *
   * @param text 用户交互文本
   * @param source 来源标记（如 conversation/document/code_comment）
   * @returns 抽取结果（新增实体数、新增关系数）
   */
  extractFromText(text: string, source: string = 'conversation'): {
    newEntities: number;
    newRelations: number;
    entityIds: string[];
  } {
    const extractedEntities: Array<{ name: string; type: string }> = [];
    const extractedRelations: Array<{ from: string; to: string; type: string }> = [];

    // 1. 实体抽取（NER）
    for (const { type, pattern } of this.extractionConfig.entityPatterns) {
      const globalPattern = new RegExp(pattern.source, pattern.flags);
      let match;
      while ((match = globalPattern.exec(text)) !== null) {
        extractedEntities.push({ name: match[0], type });
      }
    }

    // 2. 关系抽取（RE）
    for (const { type, pattern } of this.extractionConfig.relationPatterns) {
      const globalPattern = new RegExp(pattern.source, pattern.flags);
      let match;
      while ((match = globalPattern.exec(text)) !== null) {
        if (match[1] && match[2]) {
          extractedRelations.push({ from: match[1], to: match[2], type });
        }
      }
    }

    // 3. 将抽取的实体添加到图谱
    const entityNameToId: Map<string, string> = new Map();
    let newEntities = 0;
    for (const ent of extractedEntities) {
      // 检查是否已存在同名同类型实体
      const existingId = this.findEntityByNameAndType(ent.name, ent.type);
      if (existingId) {
        entityNameToId.set(ent.name, existingId);
      } else {
        const id = this.addEntity({
          name: ent.name,
          type: ent.type,
          properties: { source, extractedAt: new Date().toISOString() },
          confidence: 0.7,
          source,
        });
        entityNameToId.set(ent.name, id);
        newEntities++;
      }
    }

    // 4. 将抽取的关系添加到图谱
    let newRelations = 0;
    for (const rel of extractedRelations) {
      const fromId = entityNameToId.get(rel.from);
      const toId = entityNameToId.get(rel.to);
      if (fromId && toId) {
        // 检查是否已存在相同关系
        if (!this.relationExists(fromId, toId, rel.type)) {
          this.addRelation({
            fromId,
            toId,
            type: rel.type,
            weight: 0.7,
            confidence: 0.6,
            evidence: source,
            properties: { extractedFrom: source },
          });
          newRelations++;
        }
      }
    }

    if (newEntities > 0 || newRelations > 0) {
      this.log.info('知识图谱自动抽取完成', {
        newEntities, newRelations, source,
      });
      EventBus.getInstance().emitSync('kg.extracted', { newEntities, newRelations, source });
    }

    return {
      newEntities,
      newRelations,
      entityIds: Array.from(entityNameToId.values()),
    };
  }

  /**
   * P3-2: 图谱查询与向量检索混合召回
   *
   * 结合图谱遍历（精确关联）和向量相似度（语义近似），
   * 提供比单一检索方式更全面的召回结果。
   *
   * @param queryText 查询文本
   * @param options 查询选项
   * @returns 混合召回结果
   */
  hybridRecall(queryText: string, options?: {
    graphDepth?: number;
    graphLimit?: number;
    vectorLimit?: number;
    minConfidence?: number;
  }): HybridRecallResult {
    const graphDepth = options?.graphDepth ?? 2;
    const graphLimit = options?.graphLimit ?? 20;
    const vectorLimit = options?.vectorLimit ?? 20;
    const minConfidence = options?.minConfidence ?? 0.3;

    // 1. 图谱查询：关键词匹配 + 多跳遍历
    const graphEntities = this.search(queryText, graphLimit);
    const graphResults: HybridRecallItem[] = [];

    for (const entity of graphEntities) {
      if (entity.confidence < minConfidence) continue;

      // 从匹配实体出发做多跳遍历，扩展关联实体
      const traversalResult = this.query(entity.id, {
        depth: graphDepth,
        limit: graphLimit,
        minConfidence,
      });

      graphResults.push({
        entity,
        source: 'graph',
        score: entity.confidence,
        relatedEntities: traversalResult.entities.map(e => e.id),
        pathLength: 0,
      });

      // 添加遍历到的关联实体
      for (const related of traversalResult.entities) {
        if (related.id !== entity.id && !graphResults.some(r => r.entity.id === related.id)) {
          graphResults.push({
            entity: related,
            source: 'graph_traversal',
            score: related.confidence * 0.7, // 遍历到的实体分数衰减
            relatedEntities: [entity.id],
            pathLength: 1,
          });
        }
      }
    }

    // 2. 向量检索：基于嵌入相似度
    const vectorResults: HybridRecallItem[] = [];
    const queryEmbedding = this.computeSimpleEmbedding(queryText);

    for (const [entityId, embedding] of this.embeddingIndex) {
      const entity = this.entities.get(entityId);
      if (!entity || entity.confidence < minConfidence) continue;

      const similarity = this.cosineSimilarity(queryEmbedding, embedding);
      if (similarity > 0.3) {
        vectorResults.push({
          entity,
          source: 'vector',
          score: similarity,
          relatedEntities: [],
          pathLength: 0,
        });
      }
    }

    // 如果没有嵌入索引，使用关键词匹配作为降级
    if (vectorResults.length === 0 && this.embeddingIndex.size === 0) {
      for (const entity of this.entities.values()) {
        if (entity.confidence < minConfidence) continue;
        const textMatch = this.computeTextSimilarity(queryText, entity.name);
        if (textMatch > 0.3) {
          vectorResults.push({
            entity,
            source: 'vector_fallback',
            score: textMatch,
            relatedEntities: [],
            pathLength: 0,
          });
        }
      }
    }

    // 3. 融合去重与排序
    const merged: Map<string, HybridRecallItem> = new Map();
    for (const item of [...graphResults, ...vectorResults]) {
      const existing = merged.get(item.entity.id);
      if (existing) {
        // 取最高分，合并来源
        existing.score = Math.max(existing.score, item.score);
        existing.source = `${existing.source}+${item.source}`;
        existing.relatedEntities = Array.from(new Set([...existing.relatedEntities, ...item.relatedEntities]));
      } else {
        merged.set(item.entity.id, { ...item });
      }
    }

    const results = Array.from(merged.values())
      .sort((a, b) => b.score - a.score)
      .slice(0, graphLimit + vectorLimit);

    return {
      query: queryText,
      totalResults: results.length,
      graphResults: results.filter(r => r.source.includes('graph')).length,
      vectorResults: results.filter(r => r.source.includes('vector')).length,
      items: results,
    };
  }

  /**
   * P3-2: 异步混合召回 — 使用真实语义向量嵌入
   *
   * 与 sync hybridRecall 的区别：
   * - 若注入了 EmbeddingProvider，查询向量通过真实嵌入生成（OpenAI / TF-IDF）
   * - 嵌入索引也是通过 indexEntityEmbeddingAsync 预生成的真实语义向量
   * - 相同语义的查询（即使措辞不同）能匹配到相关实体
   *
   * 若未注入 provider，自动降级为 sync hybridRecall（保持向后兼容）。
   *
   * @returns 召回结果 + 是否使用了真实语义嵌入
   */
  async hybridRecallAsync(queryText: string, options?: {
    graphDepth?: number;
    graphLimit?: number;
    vectorLimit?: number;
    minConfidence?: number;
  }): Promise<HybridRecallResult & { usedSemanticEmbedding: boolean }> {
    // 无 provider 时降级为 sync 版本
    if (!this.embeddingProvider) {
      const result = this.hybridRecall(queryText, options);
      return { ...result, usedSemanticEmbedding: false };
    }

    const graphDepth = options?.graphDepth ?? 2;
    const graphLimit = options?.graphLimit ?? 20;
    const vectorLimit = options?.vectorLimit ?? 20;
    const minConfidence = options?.minConfidence ?? 0.3;

    // 1. 图谱查询：关键词匹配 + 多跳遍历（保持 sync）
    const graphEntities = this.search(queryText, graphLimit);
    const graphResults: HybridRecallItem[] = [];
    for (const entity of graphEntities) {
      graphResults.push({
        entity,
        source: 'graph',
        score: entity.confidence,
        relatedEntities: [],
        pathLength: 0,
      });
      // 遍历实体关联
      const related = this.query(entity.id, { depth: graphDepth, limit: graphLimit });
      for (const item of related.entities) {
        if (item.id === entity.id) continue;
        if (graphResults.find(r => r.entity.id === item.id)) continue;
        graphResults.push({
          entity: item,
          source: 'graph_traverse',
          score: related.entities.length > 0 ? 0.5 : 0.3,
          relatedEntities: [entity.id],
          pathLength: 1,
        });
      }
    }

    // 2. 向量检索：使用真实语义嵌入
    const vectorResults: HybridRecallItem[] = [];
    let queryEmbedding: number[];

    try {
      queryEmbedding = await this.embeddingProvider!.embed(queryText);
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      this.log.warn('P3-2 查询嵌入失败，降级为词袋哈希', {
        error: msg,
        provider: this.embeddingProvider!.name,
      });
      const syncResult = this.hybridRecall(queryText, options);
      return { ...syncResult, usedSemanticEmbedding: false };
    }

    for (const [entityId, embedding] of this.embeddingIndex) {
      const entity = this.entities.get(entityId);
      if (!entity || entity.confidence < minConfidence) continue;

      // 维度不一致时跳过（防止 provider 切换后的旧索引）
      if (embedding.length !== queryEmbedding.length) continue;

      const similarity = this.cosineSimilarity(queryEmbedding, embedding);
      if (similarity > 0.3) {
        vectorResults.push({
          entity,
          source: 'vector_semantic',
          score: similarity,
          relatedEntities: [],
          pathLength: 0,
        });
      }
    }

    // 3. 融合去重与排序
    const merged: Map<string, HybridRecallItem> = new Map();
    for (const item of [...graphResults, ...vectorResults]) {
      const existing = merged.get(item.entity.id);
      if (existing) {
        existing.score = Math.max(existing.score, item.score);
        existing.source = `${existing.source}+${item.source}`;
        existing.relatedEntities = Array.from(new Set([...existing.relatedEntities, ...item.relatedEntities]));
      } else {
        merged.set(item.entity.id, { ...item });
      }
    }

    const results = Array.from(merged.values())
      .sort((a, b) => b.score - a.score)
      .slice(0, graphLimit + vectorLimit);

    return {
      query: queryText,
      totalResults: results.length,
      graphResults: results.filter(r => r.source.includes('graph')).length,
      vectorResults: results.filter(r => r.source.includes('vector')).length,
      items: results,
      usedSemanticEmbedding: true,
    };
  }

  /**
   * P3-2: 多跳复杂关联推理
   *
   * 支持超过 2 跳的链式推理，沿关系路径探索实体间的深层关联。
   *
   * @param startId 起始实体 ID
   * @param relationPath 关系类型路径（如 ['depends_on', 'uses']）
   * @param maxDepth 最大推理深度
   * @returns 推理路径列表
   */
  multiHopInference(startId: string, relationPath: string[], maxDepth: number = 5): MultiHopInferenceResult[] {
    const results: MultiHopInferenceResult[] = [];
    const visited = new Set<string>([startId]);

    this.dfsInference(startId, [], relationPath, 0, maxDepth, visited, results);

    return results.sort((a, b) => b.confidence - a.confidence);
  }

  /**
   * P3-2: 为实体生成并存储向量嵌入
   *
   * 使用简化的词袋嵌入（实际生产环境应使用预训练模型）。
   *
   * P3-2 升级：若注入了 EmbeddingProvider，请改用 indexEntityEmbeddingAsync()
   * 获取真实语义向量。此同步方法保留作为无 provider 时的降级路径。
   */
  indexEntityEmbedding(entityId: string): void {
    const entity = this.entities.get(entityId);
    if (!entity) return;

    const text = `${entity.name} ${entity.type} ${Object.values(entity.properties).join(' ')}`;
    const embedding = this.computeSimpleEmbedding(text);
    this.embeddingIndex.set(entityId, embedding);
  }

  /**
   * P3-2: 异步为实体生成并存储真实语义向量嵌入
   *
   * 使用注入的 EmbeddingProvider 生成真实语义向量：
   * - OpenAIEmbeddingProvider: 真实 1536 维神经网络语义向量
   * - TfidfEmbeddingProvider: 真实 512 维 TF-IDF 统计向量
   * - 未注入 provider 时降级为同步 computeSimpleEmbedding
   *
   * @returns 是否使用了真实语义嵌入（vs 降级的词袋哈希）
   */
  async indexEntityEmbeddingAsync(entityId: string): Promise<boolean> {
    const entity = this.entities.get(entityId);
    if (!entity) return false;

    const text = `${entity.name} ${entity.type} ${Object.values(entity.properties).join(' ')}`;

    if (this.embeddingProvider) {
      try {
        const embedding = await this.embeddingProvider.embed(text);
        this.embeddingIndex.set(entityId, embedding);
        return true;
      } catch (err: unknown) {
        const msg = err instanceof Error ? err.message : String(err);
        this.log.warn('P3-2 嵌入提供者失败，降级为词袋哈希', {
          entityId,
          error: msg,
          provider: this.embeddingProvider.name,
        });
      }
    }

    // 降级：使用同步词袋哈希
    const embedding = this.computeSimpleEmbedding(text);
    this.embeddingIndex.set(entityId, embedding);
    return false;
  }

  /**
   * P3-2: 批量异步索引所有实体的嵌入（使用真实语义向量）
   * @returns 使用真实语义嵌入的实体数量
   */
  async indexAllEmbeddingsAsync(): Promise<number> {
    let semanticCount = 0;
    const entityIds = Array.from(this.entities.keys());

    // 若有 provider，优先批量嵌入（更高效）
    if (this.embeddingProvider) {
      const texts = entityIds.map(id => {
        const e = this.entities.get(id)!;
        return `${e.name} ${e.type} ${Object.values(e.properties).join(' ')}`;
      });

      try {
        const embeddings = await this.embeddingProvider.embedBatch(texts);
        for (let i = 0; i < entityIds.length; i++) {
          this.embeddingIndex.set(entityIds[i], embeddings[i]);
          semanticCount++;
        }
        this.log.info('P3-2 批量真实语义嵌入索引完成', {
          count: semanticCount,
          provider: this.embeddingProvider.name,
          dimension: this.embeddingProvider.dimension,
        });
        return semanticCount;
      } catch (err: unknown) {
        const msg = err instanceof Error ? err.message : String(err);
        this.log.warn('P3-2 批量嵌入失败，降级为逐个嵌入', {
          error: msg,
          provider: this.embeddingProvider.name,
        });
      }
    }

    // 降级：逐个嵌入（使用同步方法）
    for (const entityId of entityIds) {
      this.indexEntityEmbedding(entityId);
    }
    return 0;
  }

  /**
   * P1-3/P3-2: 注入嵌入提供者 — 启用真实语义向量
   *
   * 注入后，调用方应使用 indexEntityEmbeddingAsync / hybridRecallAsync
   * 以获取真实语义嵌入的优势。
   */
  setEmbeddingProvider(provider: EmbeddingProvider | null): void {
    this.embeddingProvider = provider;
    if (provider) {
      this.log.info('P3-2 嵌入提供者已注入', {
        provider: provider.name,
        dimension: provider.dimension,
        isSemantic: provider.isSemantic,
      });
    } else {
      this.log.info('P3-2 嵌入提供者已移除，降级为词袋哈希');
    }
  }

  /** P3-2: 查询当前是否已注入真实嵌入提供者 */
  hasEmbeddingProvider(): boolean {
    return this.embeddingProvider !== null;
  }

  /** P3-2: 获取当前嵌入提供者信息（用于诊断） */
  getEmbeddingProviderInfo(): { name: string; dimension: number; isSemantic: boolean } | null {
    if (!this.embeddingProvider) return null;
    return {
      name: this.embeddingProvider.name,
      dimension: this.embeddingProvider.dimension,
      isSemantic: this.embeddingProvider.isSemantic,
    };
  }

  /**
   * P3-2: 批量索引所有实体的嵌入
   */
  indexAllEmbeddings(): number {
    let count = 0;
    for (const entityId of this.entities.keys()) {
      this.indexEntityEmbedding(entityId);
      count++;
    }
    this.log.info('批量嵌入索引完成', { count });
    return count;
  }

  // ========== P3-2: 私有辅助方法 ==========

  /** 按名称和类型查找实体 — P3-2: 使用 nameIndex 加速 O(1) 查找 */
  private findEntityByNameAndType(name: string, type: string): string | null {
    const key = `${name.toLowerCase()}:${type}`;
    return this.nameIndex.get(key) ?? null;
  }

  /** 检查关系是否已存在 — P3-2: 使用邻接表索引加速查找 */
  private relationExists(fromId: string, toId: string, type: string): boolean {
    const outgoing = this.outgoingIndex.get(fromId);
    if (!outgoing) return false;
    for (const relationId of outgoing) {
      const relation = this.relations.get(relationId);
      if (relation && relation.toId === toId && relation.type === type) {
        return true;
      }
    }
    return false;
  }

  /** DFS 多跳推理 */
  private dfsInference(
    currentId: string,
    path: string[],
    relationPath: string[],
    depth: number,
    maxDepth: number,
    visited: Set<string>,
    results: MultiHopInferenceResult[],
  ): void {
    if (depth >= maxDepth || depth >= relationPath.length) {
      if (path.length > 1) {
        // 计算路径置信度（衰减）
        const confidence = Math.pow(0.8, path.length - 1);
        results.push({
          path: [...path],
          relationPath: relationPath.slice(0, depth),
          confidence,
          pathLength: path.length - 1,
        });
      }
      return;
    }

    const expectedRelation = relationPath[depth];
    const outgoing = this.outgoingIndex.get(currentId);
    if (!outgoing) return;

    for (const relationId of outgoing) {
      const relation = this.relations.get(relationId);
      if (!relation || relation.type !== expectedRelation) continue;

      const nextId = relation.toId;
      if (visited.has(nextId)) continue;

      visited.add(nextId);
      path.push(nextId);

      this.dfsInference(nextId, path, relationPath, depth + 1, maxDepth, visited, results);

      path.pop();
      visited.delete(nextId);
    }
  }

  /** 计算简单的词袋嵌入（128 维） */
  private computeSimpleEmbedding(text: string): number[] {
    const dimension = 128;
    const embedding = new Array(dimension).fill(0);
    const words = text.toLowerCase().split(/\s+/).filter(w => w.length > 0);

    for (const word of words) {
      // 简单哈希到固定维度
      let hash = 0;
      for (let i = 0; i < word.length; i++) {
        hash = ((hash << 5) - hash + word.charCodeAt(i)) | 0;
      }
      const index = Math.abs(hash) % dimension;
      embedding[index] += 1;
    }

    // 归一化
    const magnitude = Math.sqrt(embedding.reduce((s, v) => s + v * v, 0));
    if (magnitude > 0) {
      for (let i = 0; i < dimension; i++) {
        embedding[i] /= magnitude;
      }
    }

    return embedding;
  }

  /** 计算余弦相似度 */
  private cosineSimilarity(a: number[], b: number[]): number {
    if (a.length !== b.length) return 0;
    let dotProduct = 0;
    let normA = 0;
    let normB = 0;
    for (let i = 0; i < a.length; i++) {
      dotProduct += a[i] * b[i];
      normA += a[i] * a[i];
      normB += b[i] * b[i];
    }
    const denominator = Math.sqrt(normA) * Math.sqrt(normB);
    return denominator > 0 ? dotProduct / denominator : 0;
  }

  /** 计算文本相似度（降级方案） */
  private computeTextSimilarity(query: string, target: string): number {
    const queryLower = query.toLowerCase();
    const targetLower = target.toLowerCase();
    if (queryLower.includes(targetLower) || targetLower.includes(queryLower)) {
      return 0.8;
    }
    // 字符级 Jaccard 相似度
    const setA = new Set(queryLower.split(/\s+/));
    const setB = new Set(targetLower.split(/\s+/));
    const intersection = new Set([...setA].filter(x => setB.has(x)));
    const union = new Set([...setA, ...setB]);
    return union.size > 0 ? intersection.size / union.size : 0;
  }

  // ========== 资源清理 ==========

  /** 释放所有内存与索引 */
  dispose(): void {
    this.entities.clear();
    this.relations.clear();
    this.nameIndex.clear();
    this.outgoingIndex.clear();
    this.incomingIndex.clear();
    this.embeddingIndex.clear();
    this.log.debug('知识图谱记忆已释放');
  }

  // ========== P3-2: 验收度量方法 ==========

  /**
   * P3-2: 验证抽取质量
   *
   * 对最近的三元组抽取结果进行质量评估。
   *
   * 验收标准：三元组抽取
   *
   * @param sampleTexts 测试文本数组
   * @returns 抽取质量评估结果
   */
  validateExtractionQuality(sampleTexts: string[]): Promise<{
    totalTexts: number;
    totalEntitiesExtracted: number;
    totalRelationsExtracted: number;
    avgEntitiesPerText: number;
    avgRelationsPerText: number;
    extractionRate: number;
    meetsTarget: boolean;
    details: Array<{ text: string; entities: number; relations: number }>;
  }> {
    const details: Array<{ text: string; entities: number; relations: number }> = [];
    let totalEntities = 0;
    let totalRelations = 0;
    let successCount = 0;

    for (const text of sampleTexts) {
      const beforeEntities = this.entities.size;
      const beforeRelations = this.relations.size;

      try {
        this.extractFromText(text, 'quality-validation');
        const extractedEntities = this.entities.size - beforeEntities;
        const extractedRelations = this.relations.size - beforeRelations;

        totalEntities += extractedEntities;
        totalRelations += extractedRelations;

        if (extractedEntities > 0 || extractedRelations > 0) {
          successCount++;
        }

        details.push({
          text: text.substring(0, 50) + (text.length > 50 ? '...' : ''),
          entities: extractedEntities,
          relations: extractedRelations,
        });
      } catch {
        details.push({ text: text.substring(0, 50), entities: 0, relations: 0 });
      }
    }

    const avgEntities = sampleTexts.length > 0 ? totalEntities / sampleTexts.length : 0;
    const avgRelations = sampleTexts.length > 0 ? totalRelations / sampleTexts.length : 0;
    const extractionRate = sampleTexts.length > 0 ? successCount / sampleTexts.length : 0;

    return Promise.resolve({
      totalTexts: sampleTexts.length,
      totalEntitiesExtracted: totalEntities,
      totalRelationsExtracted: totalRelations,
      avgEntitiesPerText: Math.round(avgEntities * 100) / 100,
      avgRelationsPerText: Math.round(avgRelations * 100) / 100,
      extractionRate: Math.round(extractionRate * 100) / 100,
      meetsTarget: extractionRate >= 0.7,
      details,
    });
  }

  /**
   * P3-2: 混合召回基准测试
   *
   * 对图谱+向量混合召回进行性能和质量基准测试。
   *
   * 验收标准：图谱+向量混合召回
   *
   * @param queries 测试查询数组
   * @param iterations 每个查询的迭代次数
   * @returns 基准测试结果
   */
  benchmarkHybridRecall(
    queries: string[],
    iterations = 3,
  ): Promise<{
    totalQueries: number;
    totalIterations: number;
    avgLatencyMs: number;
    minLatencyMs: number;
    maxLatencyMs: number;
    avgResultCount: number;
    avgGraphScore: number;
    avgVectorScore: number;
    recallRate: number;
    meetsTarget: boolean;
  }> {
    const latencies: number[] = [];
    const resultCounts: number[] = [];
    const graphScores: number[] = [];
    const vectorScores: number[] = [];
    let successCount = 0;
    let totalRuns = 0;

    for (const query of queries) {
      for (let i = 0; i < iterations; i++) {
        const start = Date.now();
        try {
          const result = this.hybridRecall(query, { graphLimit: 10, vectorLimit: 10 });
          const latency = Date.now() - start;
          latencies.push(latency);
          resultCounts.push(result.items.length);

          if (result.items.length > 0) {
            // HybridRecallItem 只有单一 score 字段；按 source 标记区分图谱/向量来源
            const graphItems = result.items.filter(it => it.source.includes('graph'));
            const vectorItems = result.items.filter(it => it.source.includes('vector'));
            const avgGraph = graphItems.length > 0
              ? graphItems.reduce((s, item) => s + item.score, 0) / graphItems.length
              : 0;
            const avgVector = vectorItems.length > 0
              ? vectorItems.reduce((s, item) => s + item.score, 0) / vectorItems.length
              : 0;
            graphScores.push(avgGraph);
            vectorScores.push(avgVector);
            successCount++;
          }
          totalRuns++;
        } catch {
          totalRuns++;
        }
      }
    }

    const avgLatency = latencies.length > 0
      ? latencies.reduce((s, l) => s + l, 0) / latencies.length
      : 0;
    const avgResultCount = resultCounts.length > 0
      ? resultCounts.reduce((s, c) => s + c, 0) / resultCounts.length
      : 0;
    const avgGraph = graphScores.length > 0
      ? graphScores.reduce((s, g) => s + g, 0) / graphScores.length
      : 0;
    const avgVector = vectorScores.length > 0
      ? vectorScores.reduce((s, v) => s + v, 0) / vectorScores.length
      : 0;
    const recallRate = totalRuns > 0 ? successCount / totalRuns : 0;

    return Promise.resolve({
      totalQueries: queries.length,
      totalIterations: totalRuns,
      avgLatencyMs: Math.round(avgLatency * 100) / 100,
      minLatencyMs: latencies.length > 0 ? Math.min(...latencies) : 0,
      maxLatencyMs: latencies.length > 0 ? Math.max(...latencies) : 0,
      avgResultCount: Math.round(avgResultCount * 100) / 100,
      avgGraphScore: Math.round(avgGraph * 1000) / 1000,
      avgVectorScore: Math.round(avgVector * 1000) / 1000,
      recallRate: Math.round(recallRate * 100) / 100,
      meetsTarget: recallRate >= 0.6 && avgLatency < 100,
    });
  }

  /**
   * P3-2: 获取知识图谱综合质量评分
   *
   * @returns 质量评分报告
   */
  getQualityScore(): {
    overallScore: number;
    dimensions: {
      coverage: number;
      connectivity: number;
      confidence: number;
      freshness: number;
    };
    details: {
      entityCount: number;
      relationCount: number;
      entityTypeCount: number;
      relationTypeCount: number;
      avgConfidence: number;
      lastUpdated: number;
    };
  } {
    const stats = this.getStats();

    // 覆盖度：实体类型多样性
    const entityTypeCount = Object.keys(stats.entityTypes).length;
    const relationTypeCount = Object.keys(stats.relationTypes).length;
    const coverage = Math.min(10, entityTypeCount * 1.5);

    // 连通度：关系数/实体数比例（越高越连通）
    const connectivity = stats.totalEntities > 0
      ? Math.min(10, (stats.totalRelations / stats.totalEntities) * 5)
      : 0;

    // 置信度：平均置信度 * 10
    const confidence = stats.avgConfidence * 10;

    // 新鲜度：基于最后更新时间（1天内=10分，7天内=8分，30天内=5分，更久=2分）
    const ageHours = (Date.now() - stats.lastUpdated) / (1000 * 60 * 60);
    let freshness: number;
    if (ageHours < 24) {
      freshness = 10;
    } else if (ageHours < 168) {
      freshness = 8;
    } else if (ageHours < 720) {
      freshness = 5;
    } else {
      freshness = 2;
    }

    const overallScore = Math.round(
      (coverage * 0.25 + connectivity * 0.25 + confidence * 0.3 + freshness * 0.2) * 10
    ) / 10;

    return {
      overallScore,
      dimensions: {
        coverage: Math.round(coverage * 10) / 10,
        connectivity: Math.round(connectivity * 10) / 10,
        confidence: Math.round(confidence * 10) / 10,
        freshness,
      },
      details: {
        entityCount: stats.totalEntities,
        relationCount: stats.totalRelations,
        entityTypeCount,
        relationTypeCount,
        avgConfidence: stats.avgConfidence,
        lastUpdated: stats.lastUpdated,
      },
    };
  }

  /**
   * P3: 暴露知识图谱操作为工具 — 让 agent 能查询和构建知识图谱
   *
   * 修复前: 只有 search 和 extractFromText 在 run 中被调用，图遍历/路径查找等高级功能不可达
   * 修复后: agent 可通过工具搜索实体、查找关系路径、从文本提取知识
   */
  getToolDefinitions(): ToolDef[] {
    // eslint-disable-next-line @typescript-eslint/no-this-alias
    const kg = this;

    return [
      {
        name: 'kg_search',
        description: '搜索知识图谱中的实体。返回匹配的实体及其关系。',
        parameters: {
          query: { type: 'string', description: '搜索关键词', required: true },
          limit: { type: 'string', description: '返回结果数（默认10）', required: false },
        },
        readOnly: true,
        execute: (args) => {
          try {
            const limit = parseInt(String(args.limit || '10'), 10);
            const entities = kg.search(String(args.query), limit);
            if (entities.length === 0) return Promise.resolve('未找到匹配的实体');
            const lines = [`找到 ${entities.length} 个实体:`];
            entities.forEach((e, i) => {
              lines.push(`\n${i + 1}. [${e.type}] ${e.name} (置信度: ${e.confidence.toFixed(2)})`);
              if (e.properties && Object.keys(e.properties).length > 0) {
                lines.push(`   属性: ${JSON.stringify(e.properties).substring(0, 200)}`);
              }
            });
            return Promise.resolve(lines.join('\n'));
          } catch (e: unknown) {
            const msg = e instanceof Error ? e.message : String(e);
            return Promise.resolve(`❌ 搜索失败: ${msg}`);
          }
        },
      },
      {
        name: 'kg_find_path',
        description: '查找两个实体之间的关系路径。用于发现概念之间的隐藏联系。',
        parameters: {
          fromEntity: { type: 'string', description: '起始实体名称', required: true },
          toEntity: { type: 'string', description: '目标实体名称', required: true },
        },
        readOnly: true,
        execute: (args) => {
          try {
            const fromResults = kg.search(String(args.fromEntity), 1);
            const toResults = kg.search(String(args.toEntity), 1);
            if (fromResults.length === 0) return Promise.resolve(`未找到实体: ${args.fromEntity}`);
            if (toResults.length === 0) return Promise.resolve(`未找到实体: ${args.toEntity}`);
            const path = kg.findPath(fromResults[0].id, toResults[0].id, 6);
            if (!path) return Promise.resolve(`未找到从 ${args.fromEntity} 到 ${args.toEntity} 的路径`);
            const lines = [`路径长度: ${path.length} 跳`, '路径:'];
            path.entityIds.forEach((entityId, i) => {
              const entity = kg.getEntity(entityId);
              const rel = path.relations[i];
              const entityName = entity ? entity.name : entityId.substring(0, 8);
              lines.push(`  ${i + 1}. ${entityName}${rel ? ` →(${rel.type})→ ` : ''}`);
            });
            return Promise.resolve(lines.join('\n'));
          } catch (e: unknown) {
            const msg = e instanceof Error ? e.message : String(e);
            return Promise.resolve(`❌ 路径查找失败: ${msg}`);
          }
        },
      },
      {
        name: 'kg_extract',
        description: '从文本中提取知识并添加到图谱。自动识别实体和关系。',
        parameters: {
          text: { type: 'string', description: '要提取知识的文本', required: true },
          source: { type: 'string', description: '知识来源（如：对话/文档/代码）', required: false },
        },
        execute: (args) => {
          try {
            const result = kg.extractFromText(String(args.text), String(args.source || 'tool'));
            return Promise.resolve(`✅ 提取完成\n新增实体: ${result.newEntities}\n新增关系: ${result.newRelations}`);
          } catch (e: unknown) {
            const msg = e instanceof Error ? e.message : String(e);
            return Promise.resolve(`❌ 提取失败: ${msg}`);
          }
        },
      },
      {
        name: 'kg_stats',
        description: '查看知识图谱统计信息。',
        parameters: {},
        readOnly: true,
        execute: () => {
          try {
            const stats = kg.getStats();
            return Promise.resolve(`知识图谱统计:\n实体总数: ${stats.totalEntities}\n关系总数: ${stats.totalRelations}\n平均置信度: ${stats.avgConfidence.toFixed(2)}\n最后更新: ${stats.lastUpdated}`);
          } catch (e: unknown) {
            const msg = e instanceof Error ? e.message : String(e);
            return Promise.resolve(`❌ 统计失败: ${msg}`);
          }
        },
      },
    ];
  }
}

// ============ P3-2: 类型定义 ============

/** 抽取规则配置 */
interface ExtractionConfig {
  entityPatterns: Array<{ type: string; pattern: RegExp }>;
  relationPatterns: Array<{ type: string; pattern: RegExp }>;
}

/** 混合召回单项结果 */
export interface HybridRecallItem {
  entity: KGEntity;
  source: string;
  score: number;
  relatedEntities: string[];
  pathLength: number;
}

/** 混合召回结果 */
export interface HybridRecallResult {
  query: string;
  totalResults: number;
  graphResults: number;
  vectorResults: number;
  items: HybridRecallItem[];
}

/** 多跳推理结果 */
export interface MultiHopInferenceResult {
  /** 实体路径（ID 序列） */
  path: string[];
  /** 关系路径（关系类型序列） */
  relationPath: string[];
  /** 路径置信度（随跳数衰减） */
  confidence: number;
  /** 路径长度（跳数） */
  pathLength: number;
}
