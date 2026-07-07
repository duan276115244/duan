import fs from 'fs';
import { atomicWriteJsonSync } from '../../core/atomic-write.js';

export interface KnowledgeEntry {
  id: string;
  topic: string;
  content: string;
  tags: string[];
  source: string;
  confidence: number;
  createdAt: string;
  updatedAt: string;
  accessCount: number;
}

export class KnowledgeBase {
  private entries: KnowledgeEntry[] = [];
  private filePath: string;
  private loaded = false;

  constructor(knowledgePath: string) {
    this.filePath = knowledgePath;
  }

  load(): void {
    if (this.loaded) return;
    try {
      if (fs.existsSync(this.filePath)) {
        const data = JSON.parse(fs.readFileSync(this.filePath, 'utf-8'));
        // P2 修复：校验 data 为数组后再展开，防止非数组数据损坏 entries
        if (Array.isArray(data)) {
          this.entries.push(...data);
        } else {
          console.warn('[KnowledgeBase] 知识库文件内容非数组，已跳过加载:', this.filePath);
        }
      }
      this.loaded = true; // P2 修复：仅加载成功时设置标志，允许失败后重试
    } catch (err) {
      console.warn('[KnowledgeBase] 知识库加载失败，下次将重试:', (err as Error).message);
      // 不设置 loaded = true，允许下次调用时重试
    }
  }

  private save(): void {
    try {
      atomicWriteJsonSync(this.filePath, this.entries);
    } catch { /* ignore */ }
  }

  add(topic: string, content: string, tags: string[], source: string, confidence: number = 0.7): KnowledgeEntry {
    this.load();
    const entry: KnowledgeEntry = {
      id: `kb_${Date.now()}_${Math.random().toString(36).substring(2, 6)}`,
      topic, content, tags, source, confidence,
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
      accessCount: 0,
    };
    this.entries.push(entry);
    this.save();
    return entry;
  }

  search(query: string, limit: number = 5): KnowledgeEntry[] {
    this.load();
    const lowerQuery = query.toLowerCase();
    const scored = this.entries.map(entry => {
      let score = 0;
      if (entry.topic.toLowerCase().includes(lowerQuery)) score += 3;
      if (entry.content.toLowerCase().includes(lowerQuery)) score += 2;
      entry.tags.forEach(tag => {
        if (tag.toLowerCase().includes(lowerQuery)) score += 1;
        if (lowerQuery.includes(tag.toLowerCase())) score += 1;
      });
      score += Math.min(entry.accessCount, 10) * 0.1;
      return { entry, score };
    });

    const results = scored.filter(s => s.score > 0).sort((a, b) => b.score - a.score).slice(0, limit);
    results.forEach(r => r.entry.accessCount++);
    return results.map(r => r.entry);
  }

  delete(id: string): boolean {
    const idx = this.entries.findIndex(e => e.id === id);
    if (idx === -1) return false;
    this.entries.splice(idx, 1);
    this.save();
    return true;
  }

  getAll(): KnowledgeEntry[] {
    this.load();
    return [...this.entries];
  }
}
