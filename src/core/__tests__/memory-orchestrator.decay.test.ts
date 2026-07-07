/**
 * MemoryOrchestrator 衰减与过期测试
 *
 * 验证 Hermes 三级记忆架构的时间相关机制：
 * - L1_TTL_MS（90天）：L1 持久级记忆自动设置 expiresAt
 * - DECAY_HALFLIFE_MS（30天）：重要性按指数衰减
 * - cleanExpiredMemories()：清理过期记忆
 * - applyImportanceDecay()：应用衰减算法
 *
 * 隔离策略：tmpDir + vi.useFakeTimers 控制时间流逝
 * 注意：applyImportanceDecay() 内部调 fileStore.save() 会向 cache 追加同一引用导致
 *       retrieveByTier 返回重复项，因此衰减验证改为直接从磁盘读取 JSON 文件。
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import * as fs from 'fs/promises';
import * as path from 'path';
import * as os from 'os';
import { MemoryOrchestrator, type MemoryEntry } from '../memory-orchestrator.js';

const DAY_MS = 24 * 60 * 60 * 1000;
const L1_TTL_DAYS = 90;
const DECAY_HALFLIFE_DAYS = 30;
const T0 = new Date('2025-01-01T00:00:00Z').getTime();

/** 直接从磁盘读取所有记忆 JSON（绕过 fileStore 缓存，避免 save 重复追加问题） */
async function readMemoriesFromDisk(tmpDir: string): Promise<MemoryEntry[]> {
  const memDir = path.join(tmpDir, '.duan', 'memories');
  try {
    const files = await fs.readdir(memDir);
    const entries: MemoryEntry[] = [];
    for (const f of files) {
      if (!f.endsWith('.json')) continue;
      try {
        const data = JSON.parse(await fs.readFile(path.join(memDir, f), 'utf-8'));
        entries.push(data);
      } catch { /* skip corrupt */ }
    }
    return entries;
  } catch {
    return [];
  }
}

describe('MemoryOrchestrator — 衰减与过期', () => {
  let tmpDir: string;
  let mo: MemoryOrchestrator;

  beforeEach(async () => {
    vi.useFakeTimers();
    vi.setSystemTime(T0);
    tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'jws-mo-decay-'));
    mo = new MemoryOrchestrator(tmpDir);
  });

  afterEach(async () => {
    vi.useRealTimers();
    await fs.rm(tmpDir, { recursive: true, force: true });
  });

  // ============ L1 TTL 过期机制 ============

  describe('L1 TTL 过期机制', () => {
    it('L1 记忆自动设置 expiresAt = now + 90天', async () => {
      await mo.store('L1 事实记忆', { type: 'fact', importance: 5 });
      const all = await readMemoriesFromDisk(tmpDir);
      expect(all.length).toBe(1);
      expect(all[0].expiresAt).toBeDefined();
      expect(all[0].expiresAt).toBe(T0 + L1_TTL_DAYS * DAY_MS);
    });

    it('L0 记忆不设置 expiresAt', async () => {
      await mo.store('L0 临时记忆', { type: 'interaction', importance: 3 });
      const all = await readMemoriesFromDisk(tmpDir);
      expect(all.length).toBe(1);
      expect(all[0].expiresAt).toBeUndefined();
    });

    it('L2 记忆不设置 expiresAt（永久保存）', async () => {
      await mo.store('L2 技能记忆', { type: 'best_practice', importance: 9 });
      const all = await readMemoriesFromDisk(tmpDir);
      expect(all.length).toBe(1);
      expect(all[0].expiresAt).toBeUndefined();
    });

    it('自定义 expiresAt 覆盖默认 90 天', async () => {
      const customExpiry = T0 + 7 * DAY_MS;
      await mo.store('自定义过期', { type: 'fact', importance: 5, expiresAt: customExpiry });
      const all = await readMemoriesFromDisk(tmpDir);
      expect(all[0].expiresAt).toBe(customExpiry);
    });

    it('L1_TTL_MS 常量 = 90 * 24 * 60 * 60 * 1000', async () => {
      // 通过 store 后的 expiresAt - timestamp 间接验证常量值
      await mo.store('L1 记忆', { type: 'fact', importance: 5 });
      const all = await readMemoriesFromDisk(tmpDir);
      const ttl = all[0].expiresAt! - all[0].timestamp;
      expect(ttl).toBe(90 * 24 * 60 * 60 * 1000);
    });
  });

  // ============ cleanExpiredMemories() ============

  describe('cleanExpiredMemories()', () => {
    it('无过期记忆时返回 0', async () => {
      await mo.store('L0 临时', { type: 'interaction', importance: 3 });
      const cleaned = mo.cleanExpiredMemories();
      expect(cleaned).toBe(0);
    });

    it('未过期的 L1 记忆不被清理', async () => {
      await mo.store('L1 记忆', { type: 'fact', importance: 5 });
      // 时间推进 89 天（差 1 天过期）
      vi.setSystemTime(T0 + 89 * DAY_MS);
      const cleaned = mo.cleanExpiredMemories();
      expect(cleaned).toBe(0);
    });

    it('过期的 L1 记忆被清理', async () => {
      await mo.store('L1 记忆', { type: 'fact', importance: 5 });
      // 时间推进 91 天（超过 90 天有效期）
      vi.setSystemTime(T0 + 91 * DAY_MS);
      const cleaned = mo.cleanExpiredMemories();
      expect(cleaned).toBe(1);

      // 验证文件已被删除
      const remaining = await readMemoriesFromDisk(tmpDir);
      expect(remaining.length).toBe(0);
    });

    it('正好过期边界（now == expiresAt）不清理', async () => {
      await mo.store('L1 记忆', { type: 'fact', importance: 5 });
      // expiresAt = T0 + 90天，now = T0 + 90天 → now > expiresAt 为 false
      vi.setSystemTime(T0 + 90 * DAY_MS);
      const cleaned = mo.cleanExpiredMemories();
      expect(cleaned).toBe(0);
    });

    it('混合场景：仅清理过期项', async () => {
      await mo.store('过期项', { type: 'fact', importance: 5 });
      await mo.store('L0 项', { type: 'interaction', importance: 3 });
      await mo.store('L2 项', { type: 'best_practice', importance: 9 });

      vi.setSystemTime(T0 + 91 * DAY_MS);
      const cleaned = mo.cleanExpiredMemories();
      expect(cleaned).toBe(1); // 仅 L1 过期项

      const remaining = await readMemoriesFromDisk(tmpDir);
      expect(remaining.length).toBe(2); // L0 + L2 保留
    });
  });

  // ============ applyImportanceDecay() ============

  describe('applyImportanceDecay()', () => {
    it('新记忆（近期）不衰减', async () => {
      await mo.store('L1 新记忆', { type: 'fact', importance: 8 });
      // 时间推进 1 小时（importance=8 时 ~13 小时才会超过 0.1 阈值）
      // decayFactor = exp(-ln2 * 1h / 30d) ≈ 0.99904
      // Δ = 8 * (1 - 0.99904) = 0.0077 < 0.1 → 不触发更新
      vi.setSystemTime(T0 + 1 * 60 * 60 * 1000);
      const decayed = mo.applyImportanceDecay();
      expect(decayed).toBe(0);
    });

    it('L1 记忆超过 1 个半衰期后重要性衰减', async () => {
      await mo.store('L1 旧记忆', { type: 'fact', importance: 10 });
      // 时间推进 30 天（1 个半衰期），importance 应减半
      vi.setSystemTime(T0 + 30 * DAY_MS);
      const decayed = mo.applyImportanceDecay();
      expect(decayed).toBeGreaterThanOrEqual(1);

      // 从磁盘读取验证（绕过缓存重复问题）
      const all = await readMemoriesFromDisk(tmpDir);
      expect(all.length).toBe(1);
      // 30 天衰减后 importance ≈ 10 * 0.5 = 5（半衰期）
      expect(all[0].importance).toBeLessThan(10);
      expect(all[0].importance).toBeLessThanOrEqual(6);
    });

    it('L0 记忆不参与衰减', async () => {
      await mo.store('L0 记忆', { type: 'interaction', importance: 5 });
      vi.setSystemTime(T0 + 60 * DAY_MS);
      const decayed = mo.applyImportanceDecay();
      expect(decayed).toBe(0); // L0 不参与衰减

      const all = await readMemoriesFromDisk(tmpDir);
      expect(all[0].importance).toBe(5); // 未变
    });

    it('L2 记忆也参与衰减', async () => {
      await mo.store('L2 技能', { type: 'best_practice', importance: 10 });
      vi.setSystemTime(T0 + 60 * DAY_MS); // 2 个半衰期
      const decayed = mo.applyImportanceDecay();
      expect(decayed).toBeGreaterThanOrEqual(1);

      const all = await readMemoriesFromDisk(tmpDir);
      // 60 天 = 2 个半衰期，importance ≈ 10 * 0.25 = 2.5
      expect(all[0].importance).toBeLessThan(10);
      expect(all[0].importance).toBeLessThanOrEqual(4);
    });

    it('衰减不低于 1（下限保护）', async () => {
      await mo.store('L1 低重要度', { type: 'fact', importance: 2 });
      vi.setSystemTime(T0 + 365 * DAY_MS); // 1 年后
      mo.applyImportanceDecay();

      const all = await readMemoriesFromDisk(tmpDir);
      expect(all[0].importance).toBeGreaterThanOrEqual(1);
    });

    it('长时间衰减后 importance 持续下降', async () => {
      await mo.store('L1 记忆', { type: 'fact', importance: 10 });

      // 30 天后衰减一次
      vi.setSystemTime(T0 + 30 * DAY_MS);
      mo.applyImportanceDecay();
      const mid = await readMemoriesFromDisk(tmpDir);
      const midImportance = mid[0].importance;
      expect(midImportance).toBeLessThan(10);

      // 90 天后再衰减
      vi.setSystemTime(T0 + 90 * DAY_MS);
      mo.applyImportanceDecay();
      const late = await readMemoriesFromDisk(tmpDir);
      // 90 天衰减比 30 天更严重
      expect(late[0].importance).toBeLessThanOrEqual(midImportance);
    });

    it('DECAY_HALFLIFE_MS 验证：30 天后 importance ≈ 原值的一半', async () => {
      await mo.store('L1 记忆', { type: 'fact', importance: 10 });
      vi.setSystemTime(T0 + DECAY_HALFLIFE_DAYS * DAY_MS);
      mo.applyImportanceDecay();

      const all = await readMemoriesFromDisk(tmpDir);
      // 半衰期后 importance ≈ 10 * 0.5 = 5
      // decayedImportance = max(1, 10 * max(0.1, exp(-ln2 * 30/30))) = max(1, 10 * 0.5) = 5
      expect(all[0].importance).toBeGreaterThanOrEqual(4);
      expect(all[0].importance).toBeLessThanOrEqual(6);
    });
  });

  // ============ 衰减与过期组合场景 ============

  describe('衰减与过期组合', () => {
    it('衰减不改变 expiresAt', async () => {
      await mo.store('L1 记忆', { type: 'fact', importance: 10 });
      const before = await readMemoriesFromDisk(tmpDir);
      const originalExpiry = before[0].expiresAt;

      vi.setSystemTime(T0 + 60 * DAY_MS);
      mo.applyImportanceDecay();

      const after = await readMemoriesFromDisk(tmpDir);
      expect(after[0].expiresAt).toBe(originalExpiry);
    });

    it('衰减后的记忆仍能被 cleanExpiredMemories 清理', async () => {
      await mo.store('L1 记忆', { type: 'fact', importance: 10 });

      // 60 天后衰减
      vi.setSystemTime(T0 + 60 * DAY_MS);
      mo.applyImportanceDecay();

      // 91 天后清理（过期）
      vi.setSystemTime(T0 + 91 * DAY_MS);
      const cleaned = mo.cleanExpiredMemories();
      expect(cleaned).toBe(1);

      const remaining = await readMemoriesFromDisk(tmpDir);
      expect(remaining.length).toBe(0);
    });
  });
});
