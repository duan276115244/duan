/**
 * CheckpointManager 测试 — 使用真实临时目录和真实文件 I/O
 *
 * 此模块不依赖 git，是纯文件操作，因此不 mock 文件系统。
 */

import { describe, it, expect, beforeEach, afterEach, beforeAll } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { CheckpointManager } from '../checkpoint-rewind.js';

describe('CheckpointManager', () => {
  let tmpDir: string;
  let storageDir: string;
  let manager: CheckpointManager;

  // 设置 DUAN_DATA_DIR 环境变量，避免默认构造函数污染用户数据目录
  // duan-paths 模块在首次调用 duanPath() 时缓存数据目录，
  // 此 beforeAll 在任何 CheckpointManager 实例化之前执行
  beforeAll(() => {
    process.env.DUAN_DATA_DIR = path.join(os.tmpdir(), 'cp-rewind-test-env');
  });

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cp-rewind-test-'));
    storageDir = path.join(tmpDir, 'storage');
    manager = new CheckpointManager(storageDir);
  });

  afterEach(() => {
    try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch {}
  });

  // ============ 构造函数 ============
  describe('constructor', () => {
    it('使用自定义 storageDir', () => {
      expect(fs.existsSync(storageDir)).toBe(true);
    });

    it('自动创建不存在的 storage 目录', () => {
      const newStorage = path.join(tmpDir, 'deep', 'nested', 'storage');
      expect(fs.existsSync(newStorage)).toBe(false);
      new CheckpointManager(newStorage);
      expect(fs.existsSync(newStorage)).toBe(true);
    });

    it('未提供 storageDir 时使用默认 duanPath', () => {
      const defaultManager = new CheckpointManager();
      expect(defaultManager).toBeDefined();
      // 默认目录应为 DUAN_DATA_DIR/checkpoints
      const expectedDir = path.join(process.env.DUAN_DATA_DIR!, 'checkpoints');
      expect(fs.existsSync(expectedDir)).toBe(true);
    });
  });

  // ============ createCheckpoint ============
  describe('createCheckpoint', () => {
    it('返回检查点 ID', async () => {
      const file = path.join(tmpDir, 'a.txt');
      fs.writeFileSync(file, 'content-a');
      const id = await manager.createCheckpoint('test', [file]);
      expect(id).toMatch(/^ckpt_/);
    });

    it('空文件列表也能创建检查点', async () => {
      const id = await manager.createCheckpoint('empty', []);
      expect(id).toMatch(/^ckpt_/);
      expect(manager.getTotalCheckpoints()).toBe(1);
    });

    it('存储多个文件', async () => {
      const f1 = path.join(tmpDir, 'a.txt');
      const f2 = path.join(tmpDir, 'b.txt');
      fs.writeFileSync(f1, 'content-a');
      fs.writeFileSync(f2, 'content-b');
      await manager.createCheckpoint('multi', [f1, f2]);
      const history = manager.getHistory();
      expect(history[0].fileCount).toBe(2);
    });

    it('存储 label', async () => {
      await manager.createCheckpoint('my-label', []);
      const history = manager.getHistory();
      expect(history[0].label).toBe('my-label');
    });

    it('存储 metadata', async () => {
      await manager.createCheckpoint('with-meta', [], { key: 'value', num: 42 });
      const cp = manager.getLatestCheckpoint();
      expect(cp?.metadata).toEqual({ key: 'value', num: 42 });
    });

    it('过滤 Windows 保留文件名', async () => {
      await manager.createCheckpoint('reserved', ['CON', 'PRN', 'AUX', 'NUL']);
      const history = manager.getHistory();
      expect(history[0].fileCount).toBe(0);
    });

    it('过滤 COM 和 LPT 保留名', async () => {
      await manager.createCheckpoint('reserved-com', ['COM1', 'LPT1', 'COM9']);
      const history = manager.getHistory();
      expect(history[0].fileCount).toBe(0);
    });

    it('跳过不存在的文件', async () => {
      const id = await manager.createCheckpoint('skip', [path.join(tmpDir, 'no-exist.txt')]);
      const history = manager.getHistory();
      expect(history[0].fileCount).toBe(0);
      expect(id).toMatch(/^ckpt_/);
    });

    it('创建后 currentIndex 指向最新', async () => {
      await manager.createCheckpoint('cp1', []);
      await manager.createCheckpoint('cp2', []);
      expect(manager.getCurrentIndex()).toBe(1);
    });
  });

  // ============ restore ============
  describe('restore', () => {
    it('恢复文件内容到之前的状态', async () => {
      const file = path.join(tmpDir, 'a.txt');
      fs.writeFileSync(file, 'original');
      const id = await manager.createCheckpoint('cp1', [file]);
      // 修改文件
      fs.writeFileSync(file, 'modified');
      expect(fs.readFileSync(file, 'utf-8')).toBe('modified');
      // 恢复
      const result = await manager.restore(id);
      expect(result).toBe(true);
      expect(fs.readFileSync(file, 'utf-8')).toBe('original');
    });

    it('不存在的 ID 返回 false', async () => {
      const result = await manager.restore('nonexistent-id');
      expect(result).toBe(false);
    });

    it('空检查点也能成功恢复', async () => {
      const id = await manager.createCheckpoint('empty', []);
      const result = await manager.restore(id);
      expect(result).toBe(true);
    });

    it('恢复后 currentIndex 更新', async () => {
      const file = path.join(tmpDir, 'a.txt');
      fs.writeFileSync(file, 'v1');
      const id1 = await manager.createCheckpoint('cp1', [file]);
      fs.writeFileSync(file, 'v2');
      await manager.createCheckpoint('cp2', [file]);
      expect(manager.getCurrentIndex()).toBe(1);
      await manager.restore(id1);
      expect(manager.getCurrentIndex()).toBe(0);
    });

    it('恢复多文件检查点', async () => {
      const f1 = path.join(tmpDir, 'a.txt');
      const f2 = path.join(tmpDir, 'b.txt');
      const f3 = path.join(tmpDir, 'c.txt');
      fs.writeFileSync(f1, 'content-1');
      fs.writeFileSync(f2, 'content-2');
      fs.writeFileSync(f3, 'content-3');
      const id = await manager.createCheckpoint('multi', [f1, f2, f3]);
      // 修改所有文件
      fs.writeFileSync(f1, 'modified-1');
      fs.writeFileSync(f2, 'modified-2');
      fs.writeFileSync(f3, 'modified-3');
      // 恢复
      const result = await manager.restore(id);
      expect(result).toBe(true);
      expect(fs.readFileSync(f1, 'utf-8')).toBe('content-1');
      expect(fs.readFileSync(f2, 'utf-8')).toBe('content-2');
      expect(fs.readFileSync(f3, 'utf-8')).toBe('content-3');
    });
  });

  // ============ rewind ============
  describe('rewind', () => {
    it('回退 1 步', async () => {
      const file = path.join(tmpDir, 'a.txt');
      fs.writeFileSync(file, 'v1');
      await manager.createCheckpoint('cp1', [file]);
      fs.writeFileSync(file, 'v2');
      await manager.createCheckpoint('cp2', [file]);
      expect(fs.readFileSync(file, 'utf-8')).toBe('v2');
      const result = await manager.rewind(1);
      expect(result).toBe(true);
      expect(fs.readFileSync(file, 'utf-8')).toBe('v1');
    });

    it('回退超过历史数时返回 false', async () => {
      await manager.createCheckpoint('cp1', []);
      const result = await manager.rewind(5);
      expect(result).toBe(false);
    });

    it('回退 0 步时恢复当前检查点', async () => {
      const file = path.join(tmpDir, 'a.txt');
      fs.writeFileSync(file, 'v1');
      await manager.createCheckpoint('cp1', [file]);
      const result = await manager.rewind(0);
      expect(result).toBe(true);
    });

    it('默认回退 1 步', async () => {
      const file = path.join(tmpDir, 'a.txt');
      fs.writeFileSync(file, 'v1');
      await manager.createCheckpoint('cp1', [file]);
      fs.writeFileSync(file, 'v2');
      await manager.createCheckpoint('cp2', [file]);
      const result = await manager.rewind();
      expect(result).toBe(true);
      expect(fs.readFileSync(file, 'utf-8')).toBe('v1');
    });

    it('回退后 currentIndex 正确更新', async () => {
      await manager.createCheckpoint('cp1', []);
      await manager.createCheckpoint('cp2', []);
      await manager.createCheckpoint('cp3', []);
      await manager.rewind(2);
      expect(manager.getCurrentIndex()).toBe(0);
    });
  });

  // ============ fastForward ============
  describe('fastForward', () => {
    it('前进 1 步', async () => {
      const file = path.join(tmpDir, 'a.txt');
      fs.writeFileSync(file, 'v1');
      await manager.createCheckpoint('cp1', [file]);
      fs.writeFileSync(file, 'v2');
      await manager.createCheckpoint('cp2', [file]);
      // 先回退
      await manager.rewind(1);
      expect(fs.readFileSync(file, 'utf-8')).toBe('v1');
      // 再前进
      const result = await manager.fastForward(1);
      expect(result).toBe(true);
      expect(fs.readFileSync(file, 'utf-8')).toBe('v2');
    });

    it('前进超过当前时返回 false', async () => {
      await manager.createCheckpoint('cp1', []);
      const result = await manager.fastForward(5);
      expect(result).toBe(false);
    });

    it('前进 0 步时恢复当前检查点', async () => {
      const file = path.join(tmpDir, 'a.txt');
      fs.writeFileSync(file, 'v1');
      await manager.createCheckpoint('cp1', [file]);
      const result = await manager.fastForward(0);
      expect(result).toBe(true);
    });

    it('前进后 currentIndex 正确更新', async () => {
      const file = path.join(tmpDir, 'a.txt');
      fs.writeFileSync(file, 'v1');
      await manager.createCheckpoint('cp1', [file]);
      fs.writeFileSync(file, 'v2');
      await manager.createCheckpoint('cp2', [file]);
      fs.writeFileSync(file, 'v3');
      await manager.createCheckpoint('cp3', [file]);
      await manager.rewind(2);
      expect(manager.getCurrentIndex()).toBe(0);
      await manager.fastForward(1);
      expect(manager.getCurrentIndex()).toBe(1);
    });
  });

  // ============ getLatestCheckpoint ============
  describe('getLatestCheckpoint', () => {
    it('无检查点时返回 undefined', () => {
      expect(manager.getLatestCheckpoint()).toBeUndefined();
    });

    it('有多个检查点时返回最新的', async () => {
      await manager.createCheckpoint('cp1', []);
      await manager.createCheckpoint('cp2', []);
      await manager.createCheckpoint('cp3', []);
      const latest = manager.getLatestCheckpoint();
      expect(latest?.label).toBe('cp3');
    });

    it('rewind 后返回当前指针所指检查点', async () => {
      await manager.createCheckpoint('cp1', []);
      await manager.createCheckpoint('cp2', []);
      await manager.rewind(1);
      const latest = manager.getLatestCheckpoint();
      expect(latest?.label).toBe('cp1');
    });
  });

  // ============ getHistory ============
  describe('getHistory', () => {
    it('初始时返回空数组', () => {
      expect(manager.getHistory()).toEqual([]);
    });

    it('返回所有检查点（按创建顺序）', async () => {
      await manager.createCheckpoint('cp1', []);
      await manager.createCheckpoint('cp2', []);
      await manager.createCheckpoint('cp3', []);
      const history = manager.getHistory();
      expect(history.length).toBe(3);
      expect(history[0].label).toBe('cp1');
      expect(history[1].label).toBe('cp2');
      expect(history[2].label).toBe('cp3');
    });

    it('包含文件数量', async () => {
      const f1 = path.join(tmpDir, 'a.txt');
      const f2 = path.join(tmpDir, 'b.txt');
      fs.writeFileSync(f1, 'a');
      fs.writeFileSync(f2, 'b');
      await manager.createCheckpoint('cp1', [f1, f2]);
      const history = manager.getHistory();
      expect(history[0].fileCount).toBe(2);
    });

    it('包含时间戳和 ID', async () => {
      const id = await manager.createCheckpoint('cp1', []);
      const history = manager.getHistory();
      expect(history[0].id).toBe(id);
      expect(history[0].timestamp).toBeGreaterThan(0);
    });
  });

  // ============ getCurrentIndex / getTotalCheckpoints ============
  describe('getCurrentIndex', () => {
    it('初始时为 -1', () => {
      expect(manager.getCurrentIndex()).toBe(-1);
    });

    it('第一个检查点后为 0', async () => {
      await manager.createCheckpoint('cp1', []);
      expect(manager.getCurrentIndex()).toBe(0);
    });

    it('rewind 后正确更新', async () => {
      await manager.createCheckpoint('cp1', []);
      await manager.createCheckpoint('cp2', []);
      await manager.createCheckpoint('cp3', []);
      await manager.rewind(1);
      expect(manager.getCurrentIndex()).toBe(1);
    });
  });

  describe('getTotalCheckpoints', () => {
    it('初始时为 0', () => {
      expect(manager.getTotalCheckpoints()).toBe(0);
    });

    it('创建后返回正确数量', async () => {
      await manager.createCheckpoint('cp1', []);
      await manager.createCheckpoint('cp2', []);
      expect(manager.getTotalCheckpoints()).toBe(2);
    });
  });

  // ============ diff ============
  describe('diff', () => {
    it('相同内容返回 no differences', async () => {
      const file = path.join(tmpDir, 'a.txt');
      fs.writeFileSync(file, 'same');
      const id1 = await manager.createCheckpoint('cp1', [file]);
      const id2 = await manager.createCheckpoint('cp2', [file]);
      const result = await manager.diff(id1, id2);
      expect(result).toBe('no differences');
    });

    it('不存在的 ID 返回 checkpoint not found', async () => {
      const result = await manager.diff('a', 'b');
      expect(result).toBe('checkpoint not found');
    });

    it('检测到文件变更', async () => {
      const file = path.join(tmpDir, 'a.txt');
      fs.writeFileSync(file, 'v1');
      const id1 = await manager.createCheckpoint('cp1', [file]);
      fs.writeFileSync(file, 'v2');
      const id2 = await manager.createCheckpoint('cp2', [file]);
      const result = await manager.diff(id1, id2);
      expect(result).toContain(file);
      expect(result).toContain('changed');
    });

    it('检测到新增文件', async () => {
      const f1 = path.join(tmpDir, 'a.txt');
      fs.writeFileSync(f1, 'a');
      const id1 = await manager.createCheckpoint('cp1', [f1]);
      const f2 = path.join(tmpDir, 'b.txt');
      fs.writeFileSync(f2, 'b');
      const id2 = await manager.createCheckpoint('cp2', [f1, f2]);
      const result = await manager.diff(id1, id2);
      expect(result).toContain(f2);
      expect(result).toContain('created');
    });

    it('检测到删除文件', async () => {
      const f1 = path.join(tmpDir, 'a.txt');
      const f2 = path.join(tmpDir, 'b.txt');
      fs.writeFileSync(f1, 'a');
      fs.writeFileSync(f2, 'b');
      const id1 = await manager.createCheckpoint('cp1', [f1, f2]);
      const id2 = await manager.createCheckpoint('cp2', [f1]);
      const result = await manager.diff(id1, id2);
      expect(result).toContain(f2);
      expect(result).toContain('deleted');
    });

    it('只有一个 ID 不存在时返回 not found', async () => {
      const file = path.join(tmpDir, 'a.txt');
      fs.writeFileSync(file, 'content');
      const id1 = await manager.createCheckpoint('cp1', [file]);
      const result = await manager.diff(id1, 'nonexistent');
      expect(result).toBe('checkpoint not found');
    });
  });

  // ============ 引用计数（内容去重） ============
  describe('引用计数（内容去重）', () => {
    it('相同内容文件不重复存储', async () => {
      const file = path.join(tmpDir, 'a.txt');
      fs.writeFileSync(file, 'same-content');
      const id1 = await manager.createCheckpoint('cp1', [file]);
      const id2 = await manager.createCheckpoint('cp2', [file]);
      // 两个检查点都应能正确恢复
      expect(await manager.restore(id1)).toBe(true);
      expect(fs.readFileSync(file, 'utf-8')).toBe('same-content');
      expect(await manager.restore(id2)).toBe(true);
      expect(fs.readFileSync(file, 'utf-8')).toBe('same-content');
    });

    it('大量检查点淘汰后仍能正确恢复', async () => {
      const file = path.join(tmpDir, 'a.txt');
      fs.writeFileSync(file, 'stable-content');
      // 创建超过 maxCheckpoints(50) 个检查点
      for (let i = 0; i < 55; i++) {
        await manager.createCheckpoint(`cp${i}`, [file]);
      }
      expect(manager.getTotalCheckpoints()).toBe(50);
      // 最新检查点仍能恢复
      const latest = manager.getLatestCheckpoint()!;
      expect(await manager.restore(latest.id)).toBe(true);
      expect(fs.readFileSync(file, 'utf-8')).toBe('stable-content');
    });
  });

  // ============ 持久化 ============
  describe('持久化', () => {
    it('检查点写入磁盘', async () => {
      const file = path.join(tmpDir, 'a.txt');
      fs.writeFileSync(file, 'content');
      await manager.createCheckpoint('cp1', [file]);
      const files = fs.readdirSync(storageDir).filter(f => f.endsWith('.json'));
      expect(files.length).toBe(1);
    });

    it('从磁盘加载已持久化的检查点', async () => {
      const file = path.join(tmpDir, 'a.txt');
      fs.writeFileSync(file, 'content');
      await manager.createCheckpoint('cp1', [file]);
      // 创建新 manager 加载同一存储目录
      const manager2 = new CheckpointManager(storageDir);
      expect(manager2.getTotalCheckpoints()).toBe(1);
      expect(manager2.getCurrentIndex()).toBe(0);
    });

    it('加载后可恢复文件内容', async () => {
      const file = path.join(tmpDir, 'a.txt');
      fs.writeFileSync(file, 'original');
      await manager.createCheckpoint('cp1', [file]);
      fs.writeFileSync(file, 'modified');
      // 新 manager 从磁盘加载
      const manager2 = new CheckpointManager(storageDir);
      const latest = manager2.getLatestCheckpoint()!;
      const result = await manager2.restore(latest.id);
      expect(result).toBe(true);
      expect(fs.readFileSync(file, 'utf-8')).toBe('original');
    });

    it('持久化文件包含正确内容', async () => {
      const file = path.join(tmpDir, 'a.txt');
      fs.writeFileSync(file, 'test-content');
      const id = await manager.createCheckpoint('test-label', [file], { meta: 'data' });
      const jsonFile = fs.readdirSync(storageDir).find(f => f.endsWith('.json'))!;
      const data = JSON.parse(fs.readFileSync(path.join(storageDir, jsonFile), 'utf-8'));
      expect(data.id).toBe(id);
      expect(data.label).toBe('test-label');
      expect(data.files.length).toBe(1);
      expect(data.files[0].content).toBe('test-content');
      expect(data.metadata).toEqual({ meta: 'data' });
    });
  });

  // ============ 截断（maxCheckpoints） ============
  describe('截断（maxCheckpoints）', () => {
    it('超过 50 个检查点时淘汰最旧的', async () => {
      for (let i = 0; i < 51; i++) {
        await manager.createCheckpoint(`cp${i}`, []);
      }
      expect(manager.getTotalCheckpoints()).toBe(50);
    });

    it('截断后 currentIndex 仍正确', async () => {
      for (let i = 0; i < 51; i++) {
        await manager.createCheckpoint(`cp${i}`, []);
      }
      // 最新检查点 index 应为 49（0-based）
      expect(manager.getCurrentIndex()).toBe(49);
    });

    it('创建新分支时截断未来检查点', async () => {
      const file = path.join(tmpDir, 'a.txt');
      fs.writeFileSync(file, 'v1');
      await manager.createCheckpoint('cp1', [file]);
      fs.writeFileSync(file, 'v2');
      await manager.createCheckpoint('cp2', [file]);
      fs.writeFileSync(file, 'v3');
      await manager.createCheckpoint('cp3', [file]);
      // 回退到 cp1
      await manager.rewind(2);
      expect(manager.getCurrentIndex()).toBe(0);
      // 创建新检查点 — 应截断 cp2 和 cp3
      fs.writeFileSync(file, 'v4');
      await manager.createCheckpoint('cp4', [file]);
      expect(manager.getTotalCheckpoints()).toBe(2);
      expect(manager.getCurrentIndex()).toBe(1);
    });
  });
});
