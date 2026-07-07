/**
 * 段先生 - RAG向量检索系统
 *
 * 大厂级优化（Google/DocAI + Meta/FAISS pattern）：
 * 1. Embedding LRU 缓存：避免重复 API 调用
 * 2. 批量嵌入：合并多个文本为一次 API 调用
 * 3. 关键词预过滤：减少向量搜索范围
 * 4. 模糊搜索降级：API 不可用时用关键词匹配
 * 5. Overlap chunking：防止语义截断
 * 6. 增量保存：而非每次添加都写全量
 */

import { OpenAI } from 'openai';
import * as fs from 'fs/promises';
import * as path from 'path';
import { atomicWriteJson } from '../core/atomic-write.js';
import { LRUCache } from '../core/cache.js';
import { logger } from '../core/structured-logger.js';
import type { EmbeddingProvider } from '../core/embedding-provider.js';

interface VectorEntry {
  id: string;
  text: string;
  embedding: number[];
  metadata: Record<string, unknown>;
  keywords?: string[];
}

interface SearchResult {
  text: string;
  similarity: number;
  metadata: Record<string, unknown>;
}

export class VectorStore {
  private static embeddingsDisabledWarned = false;
  private entries: VectorEntry[] = [];
  private openai: OpenAI | null = null;
  private dbPath: string;
  private embeddingCache: LRUCache<number[]>;
  private pendingBatch: Array<{ text: string; resolve: (emb: number[]) => void; reject: (err: unknown) => void }> = [];
  private batchTimer: ReturnType<typeof setTimeout> | null = null;
  private batchIntervalMs = 100;
  private dirty = false;
  private saveTimer: ReturnType<typeof setTimeout> | null = null;
  private log = logger.child({ module: 'VectorStore' });
  private searchCount = 0;
  private cacheHitCount = 0;
  private batchCount = 0;
  /**
   * P0 真实修复：注入式 EmbeddingProvider — 替换硬编码 OpenAI 调用
   *
   * 之前直接 `import { OpenAI }` 并硬编码 `text-embedding-3-small`，
   * 无法享受 CompositeEmbeddingProvider 的 TF-IDF 自动降级。
   * 注入后：
   * - 优先使用注入的 provider（可能是 Composite，自动主备切换）
   * - 未注入时回退到原有 OpenAI 直连路径（保持向后兼容）
   */
  private embeddingProvider: EmbeddingProvider | null = null;

  /**
   * P0 真实修复：注入 EmbeddingProvider — 使 VectorStore 可使用任意 provider
   *
   * 推荐注入 CompositeEmbeddingProvider：OpenAI 主，TF-IDF 备，
   * 当 API 不可用或失败时自动降级到 TF-IDF，避免完全丢失向量检索能力。
   */
  setEmbeddingProvider(provider: EmbeddingProvider): void {
    this.embeddingProvider = provider;
    this.log.info('EmbeddingProvider 已注入', {
      provider: provider.name,
      dimension: provider.dimension,
      isSemantic: provider.isSemantic,
    });
  }

  /**
   * P0 真实修复：统一的嵌入获取入口 — 优先使用注入的 provider，否则回退到 OpenAI 直连
   */
  private embedText(text: string): Promise<number[]> {
    if (this.embeddingProvider) {
      return this.embeddingProvider.embed(text);
    }
    return this.getEmbeddingSingle(text);
  }

  /**
   * P0 真实修复：统一的批量嵌入入口 — 优先使用注入的 provider
   */
  private embedBatch(texts: string[]): Promise<number[][]> {
    if (this.embeddingProvider) {
      return this.embeddingProvider.embedBatch(texts);
    }
    // 回退：逐条调用 OpenAI 单条嵌入
    return Promise.all(texts.map(t => this.getEmbeddingSingle(t)));
  }

  constructor(dbPath: string = './data/vectors.json') {
    this.dbPath = dbPath;
    if (process.env.OPENAI_API_KEY) {
      this.openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });
    }
    this.embeddingCache = new LRUCache<number[]>({ maxSize: 200, defaultTTL: 3600000 });
    void this.load();
  }

  private async load(): Promise<void> {
    try {
      const data = await fs.readFile(this.dbPath, 'utf-8');
      this.entries = JSON.parse(data);
      this.log.info(`loaded ${this.entries.length} vectors`);
    } catch {
      this.entries = [];
    }
  }

  private scheduleSave(): void {
    this.dirty = true;
    if (this.saveTimer) return;
    this.saveTimer = setTimeout(() => void this.flushSave(), 5000);
  }

  private async flushSave(): Promise<void> {
    if (!this.dirty) return;
    this.dirty = false;
    this.saveTimer = null;
    try {
      const dir = path.dirname(this.dbPath);
      await fs.mkdir(dir, { recursive: true });
      // 原子写：防止向量库（可能极大）写入中途崩溃导致全量丢失
      await atomicWriteJson(this.dbPath, this.entries);
    } catch (error) {
      this.log.error('save vectors failed', { error });
    }
  }

  private extractKeywords(text: string): string[] {
    const words = text.toLowerCase().split(/[\s,，。.！？、；：()（）[\]{}]+/);
    const stopWords = new Set(['的', '了', '是', '在', '我', '有', '和', '就', '不', '人', '都', '一', '一个', '上', '也', '很', '到', '说', '要', '去', '你', '会', '着', '没有', '看', '好', '自己', '这', '他', '她', '它', '们', '那', '些', '之', '与', '及', '但', '而', '或', '被', '把', '对', '等', '从', '为', '以', '及', 'the', 'a', 'an', 'is', 'are', 'was', 'were', 'be', 'been', 'being', 'have', 'has', 'had', 'do', 'does', 'did', 'will', 'would', 'can', 'could', 'may', 'might', 'shall', 'should', 'to', 'of', 'in', 'for', 'on', 'with', 'at', 'by', 'from', 'as', 'into', 'through', 'during', 'before', 'after', 'above', 'below', 'between', 'out', 'off', 'over', 'under', 'again', 'further', 'then', 'once', 'this', 'that', 'these', 'those', 'i', 'me', 'my', 'myself', 'we', 'our', 'ours', 'ourselves', 'you', 'your', 'yours', 'yourself']);
    const freq = new Map<string, number>();
    for (const w of words) {
      if (w.length > 1 && !stopWords.has(w)) {
        freq.set(w, (freq.get(w) || 0) + 1);
      }
    }
    return [...freq.entries()]
      .sort((a, b) => b[1] - a[1])
      .slice(0, 10)
      .map(([w]) => w);
  }

  getEmbedding(text: string): Promise<number[]> {
    const cached = this.embeddingCache.get(text);
    if (cached) {
      this.cacheHitCount++;
      return Promise.resolve(cached);
    }

    if (!this.openai) {
      return Promise.reject(new Error('需要设置 OPENAI_API_KEY'));
    }

    return new Promise((resolve, reject) => {
      this.pendingBatch.push({ text, resolve, reject });
      if (!this.batchTimer) {
        this.batchTimer = setTimeout(() => void this.flushBatch(), this.batchIntervalMs);
      }
    });
  }

  private async flushBatch(): Promise<void> {
    this.batchTimer = null;
    const batch = this.pendingBatch.slice();
    this.pendingBatch = [];

    if (batch.length === 0) return;

    this.batchCount += batch.length;

    try {
      if (!this.openai) {
        for (const item of batch) item.reject(new Error('OPENAI_API_KEY not set'));
        return;
      }

      const response = await this.openai.embeddings.create({
        model: 'text-embedding-3-small',
        input: batch.map(b => b.text),
      });

      for (let i = 0; i < batch.length; i++) {
        const emb = response.data[i]?.embedding;
        if (emb) {
          this.embeddingCache.set(batch[i].text, emb);
          batch[i].resolve(emb);
        } else {
          batch[i].reject(new Error(`No embedding for item ${i}`));
        }
      }
    } catch (err) {
      for (const item of batch) item.reject(err);
    }
  }

  private async getEmbeddingSingle(text: string): Promise<number[]> {
    const cached = this.embeddingCache.get(text);
    if (cached) return cached;

    if (!this.openai) throw new Error('需要设置 OPENAI_API_KEY');

    const response = await this.openai.embeddings.create({
      model: 'text-embedding-3-small',
      input: text,
    });

    const emb = response.data[0].embedding;
    this.embeddingCache.set(text, emb);
    return emb;
  }

  async add(text: string, metadata: Record<string, unknown> = {}): Promise<string> {
    let embedding: number[] = [];
    try {
      // P0 真实修复：优先使用注入的 EmbeddingProvider（享受 TF-IDF 自动降级）
      embedding = await this.embedText(text);
    } catch {
      if (!VectorStore.embeddingsDisabledWarned) {
        VectorStore.embeddingsDisabledWarned = true;
        this.log.warn('embeddings disabled (no provider available), storing with keywords only');
      }
    }

    const entry: VectorEntry = {
      id: `vec_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`,
      text,
      embedding,
      metadata,
      keywords: this.extractKeywords(text),
    };

    this.entries.push(entry);
    this.scheduleSave();
    return entry.id;
  }

  async addBatch(items: Array<{ text: string; metadata?: Record<string, unknown> }>): Promise<string[]> {
    const texts = items.map(i => i.text);
    let embeddings: number[][];
    try {
      // P0 真实修复：优先使用注入的 EmbeddingProvider 的批量嵌入（一次 API 调用）
      embeddings = await this.embedBatch(texts);
    } catch {
      if (!VectorStore.embeddingsDisabledWarned) {
        VectorStore.embeddingsDisabledWarned = true;
        this.log.warn('embeddings disabled (no provider available), storing batch with keywords only');
      }
      embeddings = texts.map(() => []);
    }

    const ids: string[] = [];
    for (let i = 0; i < items.length; i++) {
      const entry: VectorEntry = {
        id: `vec_${Date.now()}_${Math.random().toString(36).substr(2, 9)}_${i}`,
        text: items[i].text,
        embedding: embeddings[i],
        metadata: items[i].metadata || {},
        keywords: this.extractKeywords(items[i].text),
      };
      this.entries.push(entry);
      ids.push(entry.id);
    }

    this.scheduleSave();
    return ids;
  }

  async addFile(filePath: string): Promise<string[]> {
    try {
      const content = await fs.readFile(filePath, 'utf-8');
      const chunks = this.chunkText(content, 500, 50);
      return this.addBatch(chunks.map(c => ({ text: c, metadata: { source: filePath } })));
    } catch (error: unknown) {
      const msg = error instanceof Error ? error.message : String(error);
      throw new Error(`添加文件失败: ${msg}`);
    }
  }

  private chunkText(text: string, chunkSize: number, overlap: number = 50): string[] {
    const chunks: string[] = [];
    const sentences = text.split(/(?<=[.!?。！？\n])\s*/);

    let currentChunk = '';
    for (const sentence of sentences) {
      if (currentChunk.length + sentence.length <= chunkSize) {
        currentChunk += sentence;
      } else {
        if (currentChunk) chunks.push(currentChunk.trim());
        const words = currentChunk.split(/\s+/);
        const overlapText = words.slice(-Math.min(overlap, words.length)).join(' ');
        currentChunk = overlapText + sentence;
      }
    }

    if (currentChunk) chunks.push(currentChunk.trim());

    return chunks;
  }

  async search(query: string, topK: number = 5): Promise<SearchResult[]> {
    this.searchCount++;

    if (this.entries.length === 0) return [];

    // Try embedding search first
    try {
      // P0 真实修复：优先使用注入的 EmbeddingProvider（享受 TF-IDF 自动降级）
      const queryEmbedding = await this.embedText(query);

      // Keyword pre-filter: only search entries with matching keywords
      const queryKeywords = this.extractKeywords(query);
      let candidates = this.entries;
      if (queryKeywords.length > 2) {
        const filtered = this.entries.filter(e =>
          e.keywords?.some(k => queryKeywords.includes(k))
        );
        if (filtered.length > 0) candidates = filtered;
      }

      const scores = candidates.map(entry => ({
        entry,
        score: this.cosineSimilarity(queryEmbedding, entry.embedding),
      }));

      scores.sort((a, b) => b.score - a.score);
      return scores.slice(0, topK).map(item => ({
        text: item.entry.text,
        similarity: item.score,
        metadata: item.entry.metadata,
      }));
    } catch {
      // Fallback: fuzzy keyword search
      return this.fallbackSearch(query, topK);
    }
  }

  private fallbackSearch(query: string, topK: number): SearchResult[] {
    const queryLower = query.toLowerCase();
    const queryKeywords = queryLower.split(/\s+/).filter(w => w.length > 1);

    const scored = this.entries.map(entry => {
      const textLower = entry.text.toLowerCase();
      let score = 0;

      for (const kw of queryKeywords) {
        if (textLower.includes(kw)) {
          score += kw.length / queryLower.length;
        }
      }

      if (entry.keywords) {
        const matchedKeywords = entry.keywords.filter(k => queryKeywords.includes(k));
        score += matchedKeywords.length * 0.2;
      }

      return { entry, score };
    });

    scored.sort((a, b) => b.score - a.score);
    return scored
      .filter(item => item.score > 0)
      .slice(0, topK)
      .map(item => ({
        text: item.entry.text,
        similarity: item.score,
        metadata: item.entry.metadata,
      }));
  }

  private cosineSimilarity(a: number[], b: number[]): number {
    let dotProduct = 0;
    let normA = 0;
    let normB = 0;

    for (let i = 0; i < a.length && i < b.length; i++) {
      dotProduct += a[i] * b[i];
      normA += a[i] * a[i];
      normB += b[i] * b[i];
    }

    const denom = Math.sqrt(normA) * Math.sqrt(normB);
    return denom === 0 ? 0 : dotProduct / denom;
  }

  async retrieve(query: string, topK: number = 3): Promise<string> {
    const results = await this.search(query, topK);

    if (results.length === 0) {
      return '知识库中没有相关信息';
    }

    return results
      .map((result, index) =>
        `${index + 1}. (相似度: ${(result.similarity * 100).toFixed(1)}%)\n${result.text}`
      )
      .join('\n\n');
  }

  async generateAnswer(query: string): Promise<string> {
    if (!this.openai) {
      return '需要设置 OPENAI_API_KEY';
    }

    const context = await this.search(query, 5);

    const prompt = `
根据以下上下文信息回答问题：

${context.map(c => c.text).join('\n\n')}

问题：${query}

请根据提供的上下文回答问题。如果上下文没有相关信息，请说明。
    `;

    const completion = await this.openai.chat.completions.create({
      model: 'gpt-4-turbo',
      messages: [
        { role: 'system', content: '你是一位知识助手，请根据提供的上下文回答问题。' },
        { role: 'user', content: prompt },
      ],
      max_tokens: 2048,
    });

    return completion.choices[0].message.content || '无法回答';
  }

  getStats() {
    return {
      totalEntries: this.entries.length,
      searchCount: this.searchCount,
      cacheHitRate: this.searchCount > 0 ? ((this.cacheHitCount / this.searchCount) * 100).toFixed(1) + '%' : '0%',
      batchEmbeddingCount: this.batchCount,
      embeddingCacheSize: this.embeddingCache.size,
    };
  }

  async clear(): Promise<void> {
    this.entries = [];
    this.embeddingCache.clear();
    if (this.saveTimer) clearTimeout(this.saveTimer);
    this.dirty = true;
    await this.flushSave();
  }

  async close(): Promise<void> {
    if (this.batchTimer) clearTimeout(this.batchTimer);
    if (this.pendingBatch.length > 0) await this.flushBatch();
    if (this.saveTimer) clearTimeout(this.saveTimer);
    await this.flushSave();
  }
}
