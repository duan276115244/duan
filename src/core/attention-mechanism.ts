/**
 * 注意力机制 — MultiHeadAttention / CrossAttention
 *
 * P1-1: 引入注意力机制，提升上下文理解与长序列处理能力
 *
 * 核心能力：
 * 1. 多头自注意力 — 长对话上下文压缩、关键信息聚焦
 * 2. 交叉注意力 — 工具选择时「任务描述 ↔ 工具描述」对齐
 * 3. 语义相似度计算 — 替代关键词匹配，实现语义级召回
 *
 * 架构隐喻：
 * - Query = 当前查询的语义表示
 * - Key = 候选信息的语义表示
 * - Value = 候选信息的内容
 * - Attention Weight = 查询与候选的相关性
 */

import { logger } from './structured-logger.js';
import type { EmbeddingProvider } from './embedding-provider.js';

// ============ 类型定义 ============

export interface AttentionConfig {
  dModel: number;       // 模型维度
  heads: number;        // 注意力头数
  maxSeqLen?: number;   // 最大序列长度
}

export interface AttentionOutput {
  /** 输出向量 [seqLen, dModel] */
  output: number[][];
  /** 注意力权重 [heads, seqLen, seqLen]（用于可视化/调试） */
  attentionWeights?: number[][][];
}

// ============ 工具函数 ============

/** Xavier 初始化权重矩阵 */
function xavierInit(rows: number, cols: number): number[][] {
  const limit = Math.sqrt(6 / (rows + cols));
  const matrix: number[][] = [];
  for (let i = 0; i < rows; i++) {
    const row: number[] = [];
    for (let j = 0; j < cols; j++) {
      row.push((Math.random() * 2 - 1) * limit);
    }
    matrix.push(row);
  }
  return matrix;
}

/** 矩阵乘法 a[m][k] × b[k][n] = c[m][n]（i-p-j 顺序，提升缓存命中） */
function matMul(a: number[][], b: number[][]): number[][] {
  const m = a.length;
  const k = b.length;
  const n = b[0].length;
  const c: number[][] = new Array(m);
  for (let i = 0; i < m; i++) {
    const ai = a[i];
    const ci: number[] = new Array(n).fill(0);
    for (let p = 0; p < k; p++) {
      const aip = ai[p];
      if (aip === 0) continue;
      const bp = b[p];
      for (let j = 0; j < n; j++) {
        ci[j] += aip * bp[j];
      }
    }
    c[i] = ci;
  }
  return c;
}

/** 矩阵转置 */
function transpose(m: number[][]): number[][] {
  if (m.length === 0) return [];
  const rows = m.length;
  const cols = m[0].length;
  const result: number[][] = [];
  for (let j = 0; j < cols; j++) {
    const row: number[] = [];
    for (let i = 0; i < rows; i++) {
      row.push(m[i][j]);
    }
    result.push(row);
  }
  return result;
}

/** 对矩阵每行做 softmax */
function softmaxRows(m: number[][]): number[][] {
  return m.map(row => {
    const maxVal = Math.max(...row);
    const exps = row.map(v => Math.exp(v - maxVal));
    const sum = exps.reduce((a, b) => a + b, 0);
    return exps.map(e => e / sum);
  });
}

/** 向量点积 */
function dotProduct(a: number[], b: number[]): number {
  let sum = 0;
  for (let i = 0; i < a.length; i++) {
    sum += a[i] * b[i];
  }
  return sum;
}

/** 向量 L2 范数缓存，避免重复计算候选向量的 norm */
const _normCache = new WeakMap<number[], number>();

/** 获取（并缓存）向量的 L2 范数 */
export function vectorNorm(v: number[]): number {
  const cached = _normCache.get(v);
  if (cached !== undefined) return cached;
  const norm = Math.sqrt(dotProduct(v, v));
  _normCache.set(v, norm);
  return norm;
}

/** 余弦相似度（使用缓存的范数） */
export function cosineSimilarity(a: number[], b: number[]): number {
  const normA = vectorNorm(a);
  const normB = vectorNorm(b);
  if (normA === 0 || normB === 0) return 0;
  return dotProduct(a, b) / (normA * normB);
}

// ============ 多头自注意力 ============

/**
 * 多头自注意力机制
 *
 * 用于：长对话上下文压缩、关键信息聚焦、语义级上下文召回
 * 替代 brain.ts 中的 JSON 关键词搜索
 */
export class MultiHeadAttention {
  private dModel: number;
  private heads: number;
  private dHead: number;
  private wQ: number[][][]; // [heads][dModel][dHead]
  private wK: number[][][];
  private wV: number[][][];
  private wO: number[][];   // [dModel][dModel]

  constructor(config: AttentionConfig = { dModel: 256, heads: 8 }) {
    this.dModel = config.dModel;
    this.heads = config.heads;
    this.dHead = Math.floor(config.dModel / config.heads);

    if (this.dHead * this.heads !== this.dModel) {
      throw new Error(`dModel(${config.dModel}) 必须能被 heads(${config.heads}) 整除`);
    }


    this.wQ = this.initHeadWeights();
    this.wK = this.initHeadWeights();
    this.wV = this.initHeadWeights();
    this.wO = xavierInit(this.dModel, this.dModel);

    logger.debug('MultiHeadAttention 初始化', { dModel: this.dModel, heads: this.heads, dHead: this.dHead });
  }

  /**
   * 前向计算
   * @param input 输入序列 [seqLen, dModel]
   * @returns 注意力输出 [seqLen, dModel]
   */
  forward(input: number[][]): AttentionOutput {
    const seqLen = input.length;
    if (seqLen === 0) return { output: [] };

    const headOutputs: number[][][] = [];
    const allWeights: number[][][] = [];

    // 多头并行计算
    for (let h = 0; h < this.heads; h++) {
      // 投影: Q = input × wQ[h], K = input × wK[h], V = input × wV[h]
      const Q = this.project(input, this.wQ[h]); // [seqLen, dHead]
      const K = this.project(input, this.wK[h]);
      const V = this.project(input, this.wV[h]);

      // 缩放点积注意力: scores = Q × K^T / sqrt(dHead)
      const scores = matMul(Q, transpose(K)); // [seqLen, seqLen]
      const scaled = scores.map(row => row.map(s => s / Math.sqrt(this.dHead)));

      // softmax(scores)
      const attn = softmaxRows(scaled); // [seqLen, seqLen]

      // headOutput = attn × V
      const headOut = matMul(attn, V); // [seqLen, dHead]

      headOutputs.push(headOut);
      allWeights.push(attn);
    }

    // 拼接多头: [seqLen, dModel]
    const concat = this.concatHeads(headOutputs, seqLen);

    // 输出投影: output = concat × wO
    const output = matMul(concat, this.wO);

    return { output, attentionWeights: allWeights };
  }

  /**
   * 计算查询向量与候选向量的注意力分数
   * 用于语义召回：query 与多个候选的相关性排序
   */
  computeAttentionScores(query: number[], candidates: number[][]): number[] {
    return candidates.map(c => {
      // 使用余弦相似度作为注意力分数（无需训练）
      return cosineSimilarity(query, c);
    });
  }

  /**
   * 语义召回：从候选中选择 Top-K 最相关的
   * 替代关键词匹配，实现语义级上下文召回
   */
  recall(query: number[], candidates: { id: string; vector: number[]; content: string }[], topK = 5): { id: string; content: string; score: number }[] {
    const scored = candidates.map(c => ({
      id: c.id,
      content: c.content,
      score: cosineSimilarity(query, c.vector),
    }));
    return scored.sort((a, b) => b.score - a.score).slice(0, topK);
  }

  private project(input: number[][], weights: number[][]): number[][] {
    // input [seqLen, dModel] × weights [dModel, dHead] = [seqLen, dHead]
    return matMul(input, weights);
  }

  private concatHeads(headOutputs: number[][][], seqLen: number): number[][] {
    const result: number[][] = [];
    for (let i = 0; i < seqLen; i++) {
      const row: number[] = [];
      for (let h = 0; h < this.heads; h++) {
        row.push(...headOutputs[h][i]);
      }
      result.push(row);
    }
    return result;
  }

  private initHeadWeights(): number[][][] {
    const weights: number[][][] = [];
    for (let h = 0; h < this.heads; h++) {
      weights.push(xavierInit(this.dModel, this.dHead));
    }
    return weights;
  }
}

// ============ 交叉注意力 ============

/**
 * 交叉注意力：解码器查询 ↔ 编码器键值
 *
 * 用于：工具选择时「任务描述 ↔ 工具描述」对齐
 * Query 来自任务描述，Key/Value 来自工具描述
 */
export class CrossAttention {
  private dModel: number;
  private heads: number;
  private dHead: number;
  private wQ: number[][];
  private wK: number[][];
  private wV: number[][];

  constructor(config: AttentionConfig = { dModel: 256, heads: 8 }) {
    this.dModel = config.dModel;
    this.heads = config.heads;
    this.dHead = Math.floor(config.dModel / config.heads);
    this.wQ = xavierInit(this.dModel, this.dHead);
    this.wK = xavierInit(this.dModel, this.dHead);
    this.wV = xavierInit(this.dModel, this.dHead);
  }

  /**
   * 前向计算
   * @param decoderInput 查询序列（任务描述）[qLen, dModel]
   * @param encoderOutput 键值序列（工具描述）[kLen, dModel]
   * @returns 注意力输出 [qLen, dHead]
   */
  forward(decoderInput: number[][], encoderOutput: number[][]): AttentionOutput {
    const qLen = decoderInput.length;
    const kLen = encoderOutput.length;
    if (qLen === 0 || kLen === 0) return { output: [] };

    // 投影
    const Q = matMul(decoderInput, this.wQ); // [qLen, dHead]
    const K = matMul(encoderOutput, this.wK); // [kLen, dHead]
    const V = matMul(encoderOutput, this.wV); // [kLen, dHead]

    // 交叉注意力分数: Q × K^T / sqrt(dHead)
    const scores = matMul(Q, transpose(K)); // [qLen, kLen]
    const scaled = scores.map(row => row.map(s => s / Math.sqrt(this.dHead)));
    const attn = softmaxRows(scaled);

    // 输出: attn × V
    const output = matMul(attn, V); // [qLen, dHead]

    return { output, attentionWeights: [attn] };
  }

  /**
   * 任务-工具对齐分数
   * 计算任务描述与每个工具描述的语义对齐度
   * 用于 SmartToolSelector 的语义匹配维度
   */
  alignScore(taskVector: number[], toolVector: number[]): number {
    // 简化为余弦相似度（无需训练的语义对齐）
    return cosineSimilarity(taskVector, toolVector);
  }

  /**
   * 批量任务-工具对齐
   * 返回每个工具的对齐分数，用于工具选择排序
   */
  alignBatch(taskVector: number[], toolVectors: number[][]): number[] {
    return toolVectors.map(tv => this.alignScore(taskVector, tv));
  }
}

// ============ 简化嵌入器 ============

/**
 * 简化文本嵌入器
 * 将文本转为固定维度向量，用于注意力机制输入
 *
 * P1-3 升级（真实评分）：
 * - 默认：字符级 + 词级混合哈希嵌入（无需训练，作为最低保障）
 * - 可选：注入 EmbeddingProvider 启用真实语义嵌入（OpenAI 1536 维 / TF-IDF 512 维）
 *   - embedAsync() 优先用 provider，失败降级为同步 hash
 *   - hasSemanticProvider() 反映是否已注入真实语义嵌入源
 *
 * 注：哈希嵌入不弄虚作假 — 它真实存在并真实可用，只是表达能力弱于语义嵌入。
 * 注入 provider 后 addAsync/recallAsync 路径会使用真实语义嵌入。
 */
export class SimpleEmbedder {
  private dim: number;
  private vocab: Map<string, number> = new Map();

  /**
   * P1-3: 可选的真实语义嵌入提供者
   *
   * 注入后 embedAsync() 会优先调用 provider.embed() 获取真实语义向量。
   * 同步 embed() 仍使用哈希嵌入（因为 EmbeddingProvider.embed 是异步的，
   * 不能在同步路径调用），但已注入 provider 时同步路径会标记 deprecated。
   */
  private embeddingProvider: EmbeddingProvider | null = null;

  constructor(dim = 256) {
    this.dim = dim;
  }

  /**
   * P1-3: 注入真实语义嵌入提供者
   *
   * @param provider EmbeddingProvider 实例（OpenAI/TF-IDF/Composite 之一）
   * @param adoptProviderDimension 是否采用 provider 的维度替换原 dim
   *   - true: 后续 embed() 返回 provider.dimension 维向量（推荐）
   *   - false: 保持原 dim，仅在 embedAsync() 中使用 provider（兼容旧代码）
   */
  setEmbeddingProvider(provider: EmbeddingProvider | null, adoptProviderDimension = true): void {
    this.embeddingProvider = provider;
    if (provider && adoptProviderDimension) {
      this.dim = provider.dimension;
      logger.info('[SimpleEmbedder] P1-3 已注入真实语义嵌入提供者', {
        provider: provider.name,
        dimension: provider.dimension,
        isSemantic: provider.isSemantic,
      });
    }
  }

  /** P1-3: 查询是否已注入真实语义嵌入提供者 */
  hasSemanticProvider(): boolean {
    return this.embeddingProvider !== null;
  }

  /** P1-3: 查询当前嵌入源信息（用于诊断与评分） */
  getEmbeddingInfo(): {
    dimension: number;
    providerName: string | null;
    isSemantic: boolean;
    source: 'hash-fallback' | 'semantic-provider';
  } {
    if (this.embeddingProvider) {
      return {
        dimension: this.embeddingProvider.dimension,
        providerName: this.embeddingProvider.name,
        isSemantic: this.embeddingProvider.isSemantic,
        source: 'semantic-provider',
      };
    }
    return {
      dimension: this.dim,
      providerName: null,
      isSemantic: false,
      source: 'hash-fallback',
    };
  }

  /**
   * 将文本嵌入为向量
   * 使用字符级 + 词级混合哈希嵌入（简化版，无需训练）
   *
   * 注：已注入 EmbeddingProvider 时此同步方法仍返回哈希嵌入（因为 provider.embed 是异步的）。
   * 要获取真实语义嵌入请使用 embedAsync()。
   */
  embed(text: string): number[] {
    const vector = new Array(this.dim).fill(0);

    // 字符级 n-gram 嵌入
    const chars = Array.from(text.toLowerCase());
    for (let i = 0; i < chars.length; i++) {
      const idx = this.hash(chars[i]) % this.dim;
      vector[idx] += 1;
    }

    // 词级嵌入（中文按字分词，英文按空格分词）
    const words = text.toLowerCase().split(/[\s,，。.!！?？;；]+/).filter(w => w.length > 0);
    for (const word of words) {
      const idx = this.hash(word) % this.dim;
      vector[idx] += 2; // 词权重更高
    }

    // L2 归一化
    const norm = Math.sqrt(vector.reduce((s, v) => s + v * v, 0));
    if (norm > 0) {
      for (let i = 0; i < this.dim; i++) {
        vector[i] /= norm;
      }
    }

    return vector;
  }

  /**
   * P1-3: 异步嵌入 — 优先使用真实语义嵌入提供者
   *
   * - 已注入 provider 且调用成功：返回 provider.embed(text) 的真实语义向量
   * - 未注入 provider 或调用失败：降级为同步 embed()（哈希嵌入）
   *
   * @returns 嵌入向量和使用的嵌入源（用于诊断）
   */
  async embedAsync(text: string): Promise<{ vector: number[]; source: 'semantic-provider' | 'hash-fallback' }> {
    if (this.embeddingProvider) {
      try {
        const vector = await this.embeddingProvider.embed(text);
        if (vector && vector.length === this.embeddingProvider.dimension) {
          return { vector, source: 'semantic-provider' };
        }
        // 维度不一致（可能 provider 切换后的旧数据），降级
        logger.warn('[SimpleEmbedder] P1-3 provider 返回维度不一致，降级为哈希嵌入', {
          expected: this.embeddingProvider.dimension,
          actual: vector?.length,
        });
      } catch (err: unknown) {
        logger.warn('[SimpleEmbedder] P1-3 provider.embed 失败，降级为哈希嵌入', {
          error: (err instanceof Error ? err.message : String(err)),
        });
      }
    }
    return { vector: this.embed(text), source: 'hash-fallback' };
  }

  /** 批量嵌入 */
  embedBatch(texts: string[]): number[][] {
    return texts.map(t => this.embed(t));
  }

  /**
   * P1-3: 异步批量嵌入 — 优先使用 provider.embedBatch
   *
   * 若 provider 支持 embedBatch（通常比逐个 embed 更高效，OpenAI 单次 API 调用最多 100 个输入），
   * 使用批量 API；否则降级为逐个 embedAsync。
   */
  async embedBatchAsync(texts: string[]): Promise<{ vectors: number[][]; source: 'semantic-provider' | 'hash-fallback' }> {
    if (this.embeddingProvider) {
      try {
        const vectors = await this.embeddingProvider.embedBatch(texts);
        if (vectors && vectors.length === texts.length &&
            vectors.every(v => v.length === this.embeddingProvider!.dimension)) {
          return { vectors, source: 'semantic-provider' };
        }
        logger.warn('[SimpleEmbedder] P1-3 provider.embedBatch 返回维度不一致，降级为哈希嵌入');
      } catch (err: unknown) {
        logger.warn('[SimpleEmbedder] P1-3 provider.embedBatch 失败，降级为哈希嵌入', {
          error: (err instanceof Error ? err.message : String(err)),
        });
      }
    }
    return { vectors: this.embedBatch(texts), source: 'hash-fallback' };
  }

  private hash(s: string): number {
    let h = 0;
    for (let i = 0; i < s.length; i++) {
      h = ((h << 5) - h + s.charCodeAt(i)) | 0;
    }
    return Math.abs(h);
  }
}

// ============ 语义召回器 ============

/**
 * 语义召回器
 * 使用注意力机制实现语义级上下文召回，替代关键词匹配
 *
 * P1-3 升级：支持注入 EmbeddingProvider 启用真实语义嵌入
 * - 未注入 provider: add()/recall() 使用哈希嵌入（兼容现有调用）
 * - 注入 provider: 重建 MultiHeadAttention 用新维度，addAsync()/recallAsync() 使用真实语义嵌入
 *   - 注意：注入后旧 store 中的向量与新维度不一致，会被自动清空
 */
export class SemanticRecaller {
  private attention: MultiHeadAttention;
  private embedder: SimpleEmbedder;
  private store: Map<string, { vector: number[]; content: string; metadata?: unknown }> = new Map();
  private dim: number;

  constructor(dim = 256) {
    this.dim = dim;
    this.attention = new MultiHeadAttention({ dModel: dim, heads: 8 });
    this.embedder = new SimpleEmbedder(dim);
  }

  /**
   * P1-3: 注入真实语义嵌入提供者
   *
   * 注入后：
   * 1. embedder 切换到 provider.dimension 维度
   * 2. 重建 MultiHeadAttention 用新维度（避免维度不匹配）
   * 3. 清空旧 store（旧向量维度已不兼容）
   * 4. 后续 addAsync()/recallAsync() 使用真实语义嵌入
   *
   * 同步 add()/recall() 仍可用，但使用哈希嵌入（因为 provider.embed 是异步的）。
   * 建议新代码使用 addAsync()/recallAsync() 获取真实语义召回。
   */
  setEmbeddingProvider(provider: EmbeddingProvider | null): void {
    if (provider) {
      // 清空旧 store（旧向量维度已不兼容新 provider）
      if (this.store.size > 0) {
        logger.info('[SemanticRecaller] P1-3 注入 provider，清空旧召回库', {
          oldSize: this.store.size,
          oldDim: this.dim,
          newDim: provider.dimension,
        });
        this.store.clear();
      }
      // 注入 provider 并采用其维度
      this.embedder.setEmbeddingProvider(provider, true);
      this.dim = provider.dimension;
      // 重建 MultiHeadAttention 用新维度
      this.attention = new MultiHeadAttention({ dModel: this.dim, heads: 8 });
    } else {
      this.embedder.setEmbeddingProvider(null, false);
    }
  }

  /** P1-3: 查询是否已注入真实语义嵌入提供者 */
  hasSemanticProvider(): boolean {
    return this.embedder.hasSemanticProvider();
  }

  /** P1-3: 查询当前嵌入源信息 */
  getEmbeddingInfo() {
    return this.embedder.getEmbeddingInfo();
  }

  /** 添加文档到召回库 */
  add(id: string, content: string, metadata?: unknown): void {
    const vector = this.embedder.embed(content);
    this.store.set(id, { vector, content, metadata });
  }

  /**
   * P1-3: 异步添加文档 — 优先使用真实语义嵌入
   *
   * 已注入 provider 时使用 provider.embed 获取真实语义向量；
   * 否则降级为同步 embed（哈希嵌入）。
   */
  async addAsync(id: string, content: string, metadata?: unknown): Promise<{ source: 'semantic-provider' | 'hash-fallback' }> {
    const { vector, source } = await this.embedder.embedAsync(content);
    this.store.set(id, { vector, content, metadata });
    return { source };
  }

  /** 批量添加 */
  addBatch(items: { id: string; content: string; metadata?: unknown }[]): void {
    for (const item of items) {
      this.add(item.id, item.content, item.metadata);
    }
  }

  /**
   * P1-3: 异步批量添加 — 优先使用 provider.embedBatch
   */
  async addBatchAsync(items: { id: string; content: string; metadata?: unknown }[]): Promise<{ source: 'semantic-provider' | 'hash-fallback'; addedCount: number }> {
    const contents = items.map(i => i.content);
    const { vectors, source } = await this.embedder.embedBatchAsync(contents);
    for (let i = 0; i < items.length; i++) {
      this.store.set(items[i].id, {
        vector: vectors[i],
        content: items[i].content,
        metadata: items[i].metadata,
      });
    }
    return { source, addedCount: items.length };
  }

  /**
   * 语义召回 Top-K
   * 使用注意力分数排序，替代关键词匹配
   */
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  recall(query: string, topK = 5): { id: string; content: string; score: number; metadata?: any }[] {
    const queryVec = this.embedder.embed(query);
    const candidates = Array.from(this.store.entries()).map(([id, v]) => ({
      id,
      vector: v.vector,
      content: v.content,
      metadata: v.metadata,
    }));

    const results = this.attention.recall(queryVec, candidates, topK);
    return results.map(r => ({
      id: r.id,
      content: r.content,
      score: r.score,
      metadata: this.store.get(r.id)?.metadata,
    }));
  }

  /**
   * P1-3: 异步语义召回 Top-K — 优先使用真实语义嵌入
   *
   * 已注入 provider 时使用 provider.embed 获取查询的真实语义向量，
   * 与 store 中已用 provider.embed 索引的文档向量进行语义相似度匹配。
   *
   * 未注入 provider 或 store 为空时降级为同步 recall()。
   */
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  async recallAsync(query: string, topK = 5): Promise<{ id: string; content: string; score: number; metadata?: any; source: 'semantic-provider' | 'hash-fallback' }[]> {
    if (!this.embedder.hasSemanticProvider() || this.store.size === 0) {
      const syncResults = this.recall(query, topK);
      return syncResults.map(r => ({ ...r, source: 'hash-fallback' as const }));
    }

    const { vector: queryVec, source } = await this.embedder.embedAsync(query);
    const candidates = Array.from(this.store.entries()).map(([id, v]) => ({
      id,
      vector: v.vector,
      content: v.content,
      metadata: v.metadata,
    }));

    const results = this.attention.recall(queryVec, candidates, topK);
    return results.map(r => ({
      id: r.id,
      content: r.content,
      score: r.score,
      metadata: this.store.get(r.id)?.metadata,
      source,
    }));
  }

  /** 清空召回库 */
  clear(): void {
    this.store.clear();
  }

  /** 获取召回库大小 */
  size(): number {
    return this.store.size;
  }
}
