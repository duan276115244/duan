import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import { atomicWriteJson, atomicWriteJsonSync } from '../atomic-write.js';

describe('atomic-write', () => {
  let tmpRoot: string;

  beforeEach(() => {
    tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'atomic-write-test-'));
  });

  afterEach(() => {
    try {
      const entries = fs.readdirSync(tmpRoot, { withFileTypes: true });
      for (const entry of entries) {
        const full = path.join(tmpRoot, entry.name);
        if (entry.isDirectory()) {
          fs.rmSync(full, { recursive: true, force: true });
        } else {
          fs.unlinkSync(full);
        }
      }
      fs.rmdirSync(tmpRoot);
    } catch {
      // 清理失败不阻断测试
    }
  });

  describe('atomicWriteJsonSync', () => {
    it('写入对象并读取一致', () => {
      const file = path.join(tmpRoot, 'data.json');
      const data = { name: '段先生', level: 90, nested: { a: [1, 2, 3] } };
      atomicWriteJsonSync(file, data);
      const read = JSON.parse(fs.readFileSync(file, 'utf-8'));
      expect(read).toEqual(data);
    });

    it('写入数组并读取一致', () => {
      const file = path.join(tmpRoot, 'arr.json');
      const data = [{ id: 1 }, { id: 2 }, { id: 3 }];
      atomicWriteJsonSync(file, data);
      const read = JSON.parse(fs.readFileSync(file, 'utf-8'));
      expect(read).toEqual(data);
    });

    it('接受预 stringify 的字符串', () => {
      const file = path.join(tmpRoot, 'str.json');
      const json = JSON.stringify({ custom: true }, null, 2);
      atomicWriteJsonSync(file, json);
      expect(fs.readFileSync(file, 'utf-8')).toBe(json);
    });

    it('不残留 temp 文件', () => {
      const file = path.join(tmpRoot, 'clean.json');
      atomicWriteJsonSync(file, { ok: true });
      const files = fs.readdirSync(tmpRoot);
      // 只有目标文件，不应有 .tmp 残留
      expect(files).toEqual(['clean.json']);
    });

    it('覆盖已有文件', () => {
      const file = path.join(tmpRoot, 'overwrite.json');
      atomicWriteJsonSync(file, { version: 1 });
      atomicWriteJsonSync(file, { version: 2 });
      const read = JSON.parse(fs.readFileSync(file, 'utf-8'));
      expect(read).toEqual({ version: 2 });
    });

    it('失败时清理 temp 文件', () => {
      // 目标目录不存在 → 写入 temp 失败 → 不应残留
      const file = path.join(tmpRoot, 'nonexistent-dir', 'fail.json');
      expect(() => atomicWriteJsonSync(file, { x: 1 })).toThrow();
      // tmpRoot 下不应有任何文件（temp 写入失败前不会创建）
      expect(fs.readdirSync(tmpRoot)).toHaveLength(0);
    });

    it('写入大对象（模拟向量库）', () => {
      const file = path.join(tmpRoot, 'vectors.json');
      const data = Array.from({ length: 1000 }, (_, i) => ({
        id: `vec-${i}`,
        embedding: Array.from({ length: 128 }, () => Math.random()),
      }));
      atomicWriteJsonSync(file, data);
      const read = JSON.parse(fs.readFileSync(file, 'utf-8'));
      expect(read).toHaveLength(1000);
      expect(read[0].embedding).toHaveLength(128);
    });
  });

  describe('atomicWriteJson (async)', () => {
    it('写入对象并读取一致', async () => {
      const file = path.join(tmpRoot, 'async-data.json');
      const data = { name: '段先生', values: [1, 2, 3] };
      await atomicWriteJson(file, data);
      const read = JSON.parse(fs.readFileSync(file, 'utf-8'));
      expect(read).toEqual(data);
    });

    it('不残留 temp 文件', async () => {
      const file = path.join(tmpRoot, 'async-clean.json');
      await atomicWriteJson(file, { ok: true });
      expect(fs.readdirSync(tmpRoot)).toEqual(['async-clean.json']);
    });

    it('失败时清理 temp 文件', async () => {
      const file = path.join(tmpRoot, 'nonexistent-dir', 'async-fail.json');
      await expect(atomicWriteJson(file, { x: 1 })).rejects.toThrow();
      expect(fs.readdirSync(tmpRoot)).toHaveLength(0);
    });

    it('并发写入不同文件不冲突', async () => {
      const files = Array.from({ length: 5 }, (_, i) =>
        path.join(tmpRoot, `concurrent-${i}.json`)
      );
      await Promise.all(files.map((f, i) => atomicWriteJson(f, { index: i })));
      for (let i = 0; i < files.length; i++) {
        const read = JSON.parse(fs.readFileSync(files[i], 'utf-8'));
        expect(read).toEqual({ index: i });
      }
    });
  });
});
