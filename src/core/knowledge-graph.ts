/**
 * 知识图谱引擎
 * 构建和管理结构化知识网络，支持实体关系推理和知识检索
 */

/** 知识实体 */
export interface KnowledgeEntity {
  id: string;
  name: string;
  type: string;           // 概念、技术、人物、组织、事件等
  properties: Record<string, string>;
  confidence: number;
  source: string;
  createdAt: number;
  updatedAt: number;
}

/** 知识关系 */
export interface KnowledgeRelation {
  id: string;
  sourceId: string;       // 起始实体ID
  targetId: string;       // 目标实体ID
  relationType: string;   // 关系类型：is_a, part_of, related_to, depends_on, enables等
  properties: Record<string, string>;
  confidence: number;
  weight: number;         // 关系强度 0~1
  createdAt: number;
}

/** 知识查询结果 */
export interface KnowledgeQueryResult {
  entities: KnowledgeEntity[];
  relations: KnowledgeRelation[];
  paths: string[][];       // 实体间的路径
  confidence: number;
}

/** 知识图谱统计 */
export interface KnowledgeGraphStats {
  totalEntities: number;
  totalRelations: number;
  entityTypes: Record<string, number>;
  relationTypes: Record<string, number>;
  avgConnectivity: number;
  lastUpdated: number;
}

export class KnowledgeGraph {
  private entities: Map<string, KnowledgeEntity> = new Map();
  private relations: Map<string, KnowledgeRelation> = new Map();
  private entityNameIndex: Map<string, string> = new Map(); // 名称→ID索引
  private adjacencyList: Map<string, Set<string>> = new Map(); // 邻接表
  private entityRelationIndex: Map<string, KnowledgeRelation[]> = new Map(); // 实体→关系双向索引

  constructor() {
    this.initializeCoreKnowledge();
  }

  /** 初始化核心知识 */
  private initializeCoreKnowledge(): void {
    // 编程领域核心知识
    this.addEntity('programming', '编程', 'concept', { description: '计算机程序设计与开发' });
    this.addEntity('javascript', 'JavaScript', 'technology', { description: 'Web前端编程语言', paradigm: '多范式' });
    this.addEntity('typescript', 'TypeScript', 'technology', { description: 'JavaScript的类型化超集', paradigm: '面向对象+函数式' });
    this.addEntity('python', 'Python', 'technology', { description: '通用编程语言，AI/数据科学首选', paradigm: '多范式' });
    this.addEntity('react', 'React', 'framework', { description: 'Facebook开发的UI框架', type: '前端' });
    this.addEntity('nodejs', 'Node.js', 'technology', { description: '服务器端JavaScript运行时', type: '后端' });

    // AI领域核心知识
    this.addEntity('ai', '人工智能', 'concept', { description: '模拟人类智能的技术领域' });
    this.addEntity('nlp', '自然语言处理', 'concept', { description: '让计算机理解和生成人类语言' });
    this.addEntity('llm', '大语言模型', 'technology', { description: '基于Transformer的大规模预训练模型' });
    this.addEntity('agent', '智能体', 'concept', { description: '能感知环境并采取行动的自主系统' });

    // 关系
    this.addRelation('typescript', 'javascript', 'extends', { description: 'TypeScript是JavaScript的超集' }, 0.95);
    this.addRelation('react', 'javascript', 'uses', { description: 'React使用JavaScript' }, 0.9);
    this.addRelation('nodejs', 'javascript', 'runs', { description: 'Node.js运行JavaScript' }, 0.9);
    this.addRelation('llm', 'nlp', 'is_a', { description: '大语言模型是NLP的子领域' }, 0.85);
    this.addRelation('nlp', 'ai', 'is_a', { description: 'NLP是AI的子领域' }, 0.9);
    this.addRelation('agent', 'ai', 'is_a', { description: '智能体是AI的应用' }, 0.85);
    this.addRelation('llm', 'agent', 'enables', { description: 'LLM使智能体成为可能' }, 0.8);

    // 金融领域
    this.addEntity('stock_market', '股票市场', 'domain', { description: '证券交易和投资领域' });
    this.addEntity('investment', '投资', 'concept', { description: '资金配置以获取收益的行为' });
    this.addEntity('risk_management', '风险管理', 'concept', { description: '识别、评估和控制风险的过程' });

    // 医疗领域
    this.addEntity('healthcare', '医疗健康', 'domain', { description: '疾病预防、诊断和治疗的领域' });
    this.addEntity('diagnosis', '诊断', 'concept', { description: '通过症状和检查确定疾病的过程' });
    this.addEntity('treatment', '治疗', 'concept', { description: '消除疾病或缓解症状的医疗措施' });

    // 法律领域
    this.addEntity('law', '法律', 'domain', { description: '规范社会行为的规则体系' });
    this.addEntity('contract', '合同', 'concept', { description: '双方或多方之间的法律协议' });

    // 教育领域
    this.addEntity('education', '教育', 'domain', { description: '知识传授和能力培养的系统过程' });
    this.addEntity('examination', '考试', 'concept', { description: '评估学习成果的标准化测试' });

    // 新增关系
    this.addRelation('investment', 'stock_market', 'part_of', { description: '投资是股票市场的活动' }, 0.85);
    this.addRelation('risk_management', 'investment', 'enables', { description: '风险管理保障投资安全' }, 0.8);
    this.addRelation('diagnosis', 'healthcare', 'part_of', { description: '诊断是医疗的核心环节' }, 0.9);
    this.addRelation('treatment', 'diagnosis', 'depends_on', { description: '治疗依赖诊断结果' }, 0.9);
    this.addRelation('contract', 'law', 'governed_by', { description: '合同受法律约束' }, 0.9);
    this.addRelation('examination', 'education', 'part_of', { description: '考试是教育评估的方式' }, 0.85);
    this.addRelation('nlp', 'ai', 'is_a', { description: 'NLP是AI的子领域' }, 0.9);
  }

  /** 添加实体 */
  addEntity(id: string, name: string, type: string, properties: Record<string, string> = {}, confidence: number = 0.8, source: string = 'system'): KnowledgeEntity {
    const now = Date.now();
    const entity: KnowledgeEntity = {
      id, name, type, properties, confidence, source,
      createdAt: now, updatedAt: now,
    };
    this.entities.set(id, entity);
    this.entityNameIndex.set(name.toLowerCase(), id);
    if (!this.adjacencyList.has(id)) this.adjacencyList.set(id, new Set());
    return entity;
  }

  /** 添加关系 */
  addRelation(sourceId: string, targetId: string, relationType: string, properties: Record<string, string> = {}, confidence: number = 0.8, weight: number = 0.5): KnowledgeRelation {
    const id = `rel_${sourceId}_${relationType}_${targetId}`;
    const relation: KnowledgeRelation = {
      id, sourceId, targetId, relationType, properties, confidence, weight,
      createdAt: Date.now(),
    };
    this.relations.set(id, relation);

    // 更新邻接表
    if (!this.adjacencyList.has(sourceId)) this.adjacencyList.set(sourceId, new Set());
    this.adjacencyList.get(sourceId)!.add(targetId);
    if (!this.adjacencyList.has(targetId)) this.adjacencyList.set(targetId, new Set());
    this.adjacencyList.get(targetId)!.add(sourceId);

    // 同步更新实体→关系双向索引
    if (!this.entityRelationIndex.has(sourceId)) this.entityRelationIndex.set(sourceId, []);
    this.entityRelationIndex.get(sourceId)!.push(relation);
    if (targetId !== sourceId) {
      if (!this.entityRelationIndex.has(targetId)) this.entityRelationIndex.set(targetId, []);
      this.entityRelationIndex.get(targetId)!.push(relation);
    }

    return relation;
  }

  /** 通过名称查找实体 */
  findEntityByName(name: string): KnowledgeEntity | undefined {
    const id = this.entityNameIndex.get(name.toLowerCase());
    return id ? this.entities.get(id) : undefined;
  }

  /** 查询实体的所有关系 */
  getEntityRelations(entityId: string): KnowledgeRelation[] {
    return this.entityRelationIndex.get(entityId) || [];
  }

  /** 查找两个实体之间的路径（BFS） */
  findPath(fromId: string, toId: string, maxDepth: number = 5): string[][] {
    const paths: string[][] = [];
    const queue: { node: string; path: string[] }[] = [{ node: fromId, path: [fromId] }];
    const visited = new Set<string>();

    while (queue.length > 0 && paths.length < 3) {
      const { node, path } = queue.shift()!;

      if (node === toId) {
        paths.push(path);
        continue;
      }

      if (path.length > maxDepth) continue;
      if (visited.has(node)) continue;
      visited.add(node);

      const neighbors = this.adjacencyList.get(node);
      if (neighbors) {
        for (const neighbor of neighbors) {
          if (!visited.has(neighbor)) {
            queue.push({ node: neighbor, path: [...path, neighbor] });
          }
        }
      }
    }

    return paths;
  }

  /** 知识查询 */
  query(keyword: string): KnowledgeQueryResult {
    const matchedEntities: KnowledgeEntity[] = [];
    const keywordLower = keyword.toLowerCase();

    // 模糊匹配实体
    for (const entity of this.entities.values()) {
      if (entity.name.toLowerCase().includes(keywordLower) ||
          entity.id.includes(keywordLower) ||
          Object.values(entity.properties).some(v => v.toLowerCase().includes(keywordLower))) {
        matchedEntities.push(entity);
      }
    }

    // 收集相关关系（基于实体→关系索引，去重）
    const matchedEntityIds = new Set(matchedEntities.map(e => e.id));
    const matchedRelationsMap = new Map<string, KnowledgeRelation>();
    for (const entityId of matchedEntityIds) {
      for (const rel of this.entityRelationIndex.get(entityId) || []) {
        matchedRelationsMap.set(rel.id, rel);
      }
    }
    const matchedRelations = [...matchedRelationsMap.values()];

    // 查找路径
    const paths: string[][] = [];
    if (matchedEntities.length >= 2) {
      paths.push(...this.findPath(matchedEntities[0].id, matchedEntities[1].id));
    }

    return {
      entities: matchedEntities,
      relations: matchedRelations,
      paths,
      confidence: matchedEntities.length > 0 ? matchedEntities[0].confidence : 0,
    };
  }

  /** 从文本中提取知识并添加到图谱 */
  extractAndAddKnowledge(text: string, source: string = 'user_input'): { entitiesAdded: number; relationsAdded: number } {
    let entitiesAdded = 0;
    const relationsAdded = 0;

    // 简单的实体提取：识别已知实体的提及
    for (const entity of this.entities.values()) {
      if (text.includes(entity.name)) {
        // 实体被提及，增加其置信度
        entity.confidence = Math.min(1, entity.confidence + 0.02);
        entity.updatedAt = Date.now();
      }
    }

    // 提取新的技术术语（简单启发式）
    const techPatterns = [
      /(?:学习|使用|掌握|了解)([\u4e00-\u9fa5a-zA-Z0-9+.#]+)/g,
      /([\u4e00-\u9fa5a-zA-Z0-9+.#]+)(?:技术|框架|语言|工具|平台|系统)/g,
    ];

    for (const pattern of techPatterns) {
      let match;
      while ((match = pattern.exec(text)) !== null) {
        const term = match[1].trim();
        if (term.length >= 2 && !this.entityNameIndex.has(term.toLowerCase())) {
          this.addEntity(
            `extracted_${Date.now()}_${entitiesAdded}`,
            term,
            'extracted',
            { context: text.substring(0, 100) },
            0.5,
            source
          );
          entitiesAdded++;
        }
      }
    }

    return { entitiesAdded, relationsAdded };
  }

  /** 获取图谱统计 */
  getStats(): KnowledgeGraphStats {
    const entityTypes: Record<string, number> = {};
    const relationTypes: Record<string, number> = {};
    let totalConnections = 0;

    for (const entity of this.entities.values()) {
      entityTypes[entity.type] = (entityTypes[entity.type] || 0) + 1;
      totalConnections += (this.adjacencyList.get(entity.id)?.size || 0);
    }

    for (const relation of this.relations.values()) {
      relationTypes[relation.relationType] = (relationTypes[relation.relationType] || 0) + 1;
    }

    return {
      totalEntities: this.entities.size,
      totalRelations: this.relations.size,
      entityTypes,
      relationTypes,
      avgConnectivity: this.entities.size > 0 ? totalConnections / this.entities.size : 0,
      lastUpdated: Date.now(),
    };
  }

  /** 导出图谱数据 */
  exportData(): { entities: KnowledgeEntity[]; relations: KnowledgeRelation[] } {
    return {
      entities: [...this.entities.values()],
      relations: [...this.relations.values()],
    };
  }

  /** 知识推理 - 基于已有关系推断新关系 */
  inferRelations(entityId: string, depth: number = 2): { inferred: KnowledgeRelation[]; confidence: number } {
    const inferred: KnowledgeRelation[] = [];
    const visited = new Set<string>();
    const queue: { id: string; currentDepth: number; path: string[] }[] = [{ id: entityId, currentDepth: 0, path: [entityId] }];

    while (queue.length > 0) {
      const { id, currentDepth, path } = queue.shift()!;

      if (currentDepth >= depth || visited.has(id)) continue;
      visited.add(id);

      const relations = this.getEntityRelations(id);
      for (const rel of relations) {
        const nextId = rel.sourceId === id ? rel.targetId : rel.sourceId;
        if (!visited.has(nextId)) {
          // 推断传递关系
          if (path.length >= 2) {
            const transitiveRelation = this.computeTransitiveRelation(path, rel);
            if (transitiveRelation) {
              inferred.push({
                ...transitiveRelation,
                confidence: transitiveRelation.confidence * 0.8, // 传递推理置信度衰减
              });
            }
          }
          queue.push({ id: nextId, currentDepth: currentDepth + 1, path: [...path, nextId] });
        }
      }
    }

    return { inferred, confidence: inferred.length > 0 ? inferred.reduce((s, r) => s + r.confidence, 0) / inferred.length : 0 };
  }

  /** 计算传递关系 */
  private computeTransitiveRelation(path: string[], lastRelation: KnowledgeRelation): KnowledgeRelation | null {
    // 简单的传递规则
    // is_a + is_a => is_a (传递性)
    // part_of + part_of => part_of (传递性)
    // depends_on + depends_on => depends_on (传递性)

    const relations: KnowledgeRelation[] = [];
    for (let i = 0; i < path.length - 1; i++) {
      const rel = (this.entityRelationIndex.get(path[i]) || []).find(r =>
        (r.sourceId === path[i] && r.targetId === path[i + 1]) ||
        (r.targetId === path[i] && r.sourceId === path[i + 1])
      );
      if (rel) relations.push(rel);
    }
    relations.push(lastRelation);

    // 检查是否所有关系类型相同且具有传递性
    const transitiveTypes = ['is_a', 'part_of', 'depends_on'];
    const relationTypes = [...new Set(relations.map(r => r.relationType))];

    if (relationTypes.length === 1 && transitiveTypes.includes(relationTypes[0])) {
      return {
        id: `inferred_${path[0]}_${relationTypes[0]}_${path[path.length - 1]}`,
        sourceId: path[0],
        targetId: path[path.length - 1],
        relationType: relationTypes[0],
        properties: { description: '通过传递推理得出', inferred: 'true' },
        confidence: relations.reduce((min, r) => Math.min(min, r.confidence), 1) * 0.8,
        weight: relations.reduce((prod, r) => prod * r.weight, 1),
        createdAt: Date.now(),
      };
    }

    return null;
  }
}

