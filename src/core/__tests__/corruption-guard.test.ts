/**
 * CorruptionGuard 单元测试
 *
 * 验证：
 * 1. 完好的 JSON 文件不被修改
 * 2. 损坏的 JSON 文件被备份 + 重建
 * 3. 重建后的文件可正常解析
 * 4. 不存在的目录不报错
 * 5. .bak / .tmp 文件被跳过
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import { checkOnStartup, checkFile, repairFile } from '../corruption-guard.js';

describe('CorruptionGuard', () => {
  let tmpRoot: string;

  beforeEach(() => {
    tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'duan-corrupt-'));
  });

  afterEach(() => {
    fs.rmSync(tmpRoot, { recursive: true, force: true });
  });

  describe('checkFile', () => {
    it('完好 JSON 文件返回 ok=true', () => {
      const file = path.join(tmpRoot, 'good.json');
      fs.writeFileSync(file, JSON.stringify({ a: 1 }), 'utf-8');
      const result = checkFile(file);
      expect(result.ok).toBe(true);
      expect(result.error).toBeUndefined();
    });

    it('损坏 JSON 文件返回 ok=false 并附错误', () => {
      const file = path.join(tmpRoot, 'bad.json');
      fs.writeFileSync(file, '{ broken json ', 'utf-8');
      const result = checkFile(file);
      expect(result.ok).toBe(false);
      expect(result.error).toBeDefined();
    });

    it('不存在的文件返回 ok=false', () => {
      const result = checkFile(path.join(tmpRoot, 'nonexistent.json'));
      expect(result.ok).toBe(false);
    });
  });

  describe('repairFile', () => {
    it('损坏文件被备份 + 重建为可解析 JSON', () => {
      const file = path.join(tmpRoot, 'bad.json');
      const originalContent = '{ broken json ';
      fs.writeFileSync(file, originalContent, 'utf-8');

      const result = repairFile(file);
      expect(result.repaired).toBe(true);
      expect(result.backupPath).toBeDefined();
      expect(fs.existsSync(result.backupPath!)).toBe(true);
      // 备份保留原内容
      expect(fs.readFileSync(result.backupPath!, 'utf-8')).toBe(originalContent);
      // 重建后可解析
      const repaired = JSON.parse(fs.readFileSync(file, 'utf-8'));
      expect(repaired).toEqual({});
    });

    it('重建后文件可正常 checkFile', () => {
      const file = path.join(tmpRoot, 'bad.json');
      fs.writeFileSync(file, 'not json at all', 'utf-8');
      repairFile(file);
      expect(checkFile(file).ok).toBe(true);
    });

    it('完好文件不修改内容（非破坏性 no-op）', () => {
      // 修复前 bug：repairFile 总是重写为 {}，即使文件完好也会丢数据
      // 修复后契约：完好文件返回 { repaired: false }，内容原样保留
      const file = path.join(tmpRoot, 'good.json');
      const original = { keep: 'me', nested: { value: 42 } };
      fs.writeFileSync(file, JSON.stringify(original), 'utf-8');

      const result = repairFile(file);

      expect(result.repaired).toBe(false);
      expect(result.backupPath).toBeUndefined();
      // 内容必须原样保留
      const after = JSON.parse(fs.readFileSync(file, 'utf-8'));
      expect(after).toEqual(original);
    });
  });

  describe('repairFile 类型感知默认值', () => {
    it('数组文件损坏重建为 []（如 evolution-history.json）', () => {
      // 修复前 bug：所有文件都重建为 {}，数组文件后续 for...of 会抛 TypeError
      const file = path.join(tmpRoot, 'evolution-history.json');
      fs.writeFileSync(file, '{ broken', 'utf-8');
      repairFile(file);
      const after = JSON.parse(fs.readFileSync(file, 'utf-8'));
      expect(Array.isArray(after)).toBe(true);
      expect(after).toEqual([]);
    });

    it('对象文件损坏重建为 {}（如 config.json）', () => {
      const file = path.join(tmpRoot, 'config.json');
      fs.writeFileSync(file, '{ broken', 'utf-8');
      repairFile(file);
      const after = JSON.parse(fs.readFileSync(file, 'utf-8'));
      expect(after).toEqual({});
    });

    it('history.json 在 reasoning/ 目录重建为对象结构', () => {
      // basename 冲突：reasoning/history.json 期望 {history,learning,lastSaved}
      const dir = path.join(tmpRoot, 'reasoning');
      fs.mkdirSync(dir, { recursive: true });
      const file = path.join(dir, 'history.json');
      fs.writeFileSync(file, 'broken', 'utf-8');
      repairFile(file);
      const after = JSON.parse(fs.readFileSync(file, 'utf-8'));
      expect(Array.isArray(after)).toBe(false);
      expect(after).toHaveProperty('history');
      expect(after).toHaveProperty('learning');
      expect(after).toHaveProperty('lastSaved');
    });

    it('history.json 在 execution/ 目录重建为 []', () => {
      // basename 冲突：execution/history.json 期望 []
      const dir = path.join(tmpRoot, 'execution');
      fs.mkdirSync(dir, { recursive: true });
      const file = path.join(dir, 'history.json');
      fs.writeFileSync(file, 'broken', 'utf-8');
      repairFile(file);
      const after = JSON.parse(fs.readFileSync(file, 'utf-8'));
      expect(Array.isArray(after)).toBe(true);
      expect(after).toEqual([]);
    });

    it('index.json 在 cache/ 目录重建为 []', () => {
      // basename 冲突：cache/index.json 期望 []
      const dir = path.join(tmpRoot, 'cache');
      fs.mkdirSync(dir, { recursive: true });
      const file = path.join(dir, 'index.json');
      fs.writeFileSync(file, 'broken', 'utf-8');
      repairFile(file);
      const after = JSON.parse(fs.readFileSync(file, 'utf-8'));
      expect(Array.isArray(after)).toBe(true);
      expect(after).toEqual([]);
    });

    it('index.json 在 experience-packs/ 目录重建为对象结构', () => {
      // basename 冲突：experience-packs/index.json 期望 {version,savedAt,count,ids}
      const dir = path.join(tmpRoot, 'experience-packs');
      fs.mkdirSync(dir, { recursive: true });
      const file = path.join(dir, 'index.json');
      fs.writeFileSync(file, 'broken', 'utf-8');
      repairFile(file);
      const after = JSON.parse(fs.readFileSync(file, 'utf-8'));
      expect(Array.isArray(after)).toBe(false);
      expect(after).toHaveProperty('version');
      expect(after).toHaveProperty('count');
      expect(after).toHaveProperty('ids');
    });

    it('未登记的文件名回退到 {}', () => {
      const file = path.join(tmpRoot, 'unknown-format.json');
      fs.writeFileSync(file, 'broken', 'utf-8');
      repairFile(file);
      const after = JSON.parse(fs.readFileSync(file, 'utf-8'));
      expect(after).toEqual({});
    });
  });

  describe('checkOnStartup', () => {
    it('不存在的目录返回全零结果', () => {
      const result = checkOnStartup({
        extraDirs: [path.join(tmpRoot, 'nonexistent-dir')],
        scanAwareness: false,
        scanDuanPath: false,
      });
      expect(result.scanned).toBe(0);
      expect(result.corrupted).toBe(0);
      expect(result.repaired).toBe(0);
      expect(result.failed).toBe(0);
      expect(result.details).toHaveLength(0);
    });

    it('完好目录：scanned > 0, corrupted = 0', () => {
      const dir = path.join(tmpRoot, 'clean-dir');
      fs.mkdirSync(dir, { recursive: true });
      fs.writeFileSync(path.join(dir, 'a.json'), JSON.stringify({ a: 1 }), 'utf-8');
      fs.writeFileSync(path.join(dir, 'b.json'), JSON.stringify({ b: 2 }), 'utf-8');

      const result = checkOnStartup({
        extraDirs: [dir],
        scanAwareness: false,
        scanDuanPath: false,
      });
      expect(result.scanned).toBe(2);
      expect(result.corrupted).toBe(0);
      expect(result.repaired).toBe(0);
    });

    it('混合目录：检测损坏 + 修复 + 保留完好', () => {
      const dir = path.join(tmpRoot, 'mixed-dir');
      fs.mkdirSync(dir, { recursive: true });
      const goodFile = path.join(dir, 'good.json');
      const badFile = path.join(dir, 'bad.json');
      fs.writeFileSync(goodFile, JSON.stringify({ ok: true }), 'utf-8');
      fs.writeFileSync(badFile, '!!! broken !!!', 'utf-8');

      const result = checkOnStartup({
        extraDirs: [dir],
        scanAwareness: false,
        scanDuanPath: false,
      });
      expect(result.scanned).toBe(2);
      expect(result.corrupted).toBe(1);
      expect(result.repaired).toBe(1);
      expect(result.failed).toBe(0);
      // 完好文件未被修改
      expect(JSON.parse(fs.readFileSync(goodFile, 'utf-8'))).toEqual({ ok: true });
      // 损坏文件已修复
      expect(JSON.parse(fs.readFileSync(badFile, 'utf-8'))).toEqual({});
      // 备份存在
      const detail = result.details.find(d => d.file === badFile);
      expect(detail).toBeDefined();
      expect(detail!.status).toBe('repaired');
      expect(detail!.backupPath).toBeDefined();
      expect(fs.existsSync(detail!.backupPath!)).toBe(true);
    });

    it('跳过 .bak 和 .tmp 文件', () => {
      const dir = path.join(tmpRoot, 'skip-dir');
      fs.mkdirSync(dir, { recursive: true });
      fs.writeFileSync(path.join(dir, 'a.bak'), 'not json', 'utf-8');
      fs.writeFileSync(path.join(dir, 'b.tmp'), 'not json', 'utf-8');
      fs.writeFileSync(path.join(dir, 'c.json'), JSON.stringify({ c: 1 }), 'utf-8');

      const result = checkOnStartup({
        extraDirs: [dir],
        scanAwareness: false,
        scanDuanPath: false,
      });
      expect(result.scanned).toBe(1); // 只扫 c.json
      expect(result.corrupted).toBe(0);
    });

    it('递归扫描子目录', () => {
      const dir = path.join(tmpRoot, 'recursive-dir');
      const subDir = path.join(dir, 'sub');
      fs.mkdirSync(subDir, { recursive: true });
      fs.writeFileSync(path.join(dir, 'top.json'), JSON.stringify({ a: 1 }), 'utf-8');
      fs.writeFileSync(path.join(subDir, 'deep.json'), 'broken', 'utf-8');

      const result = checkOnStartup({
        extraDirs: [dir],
        scanAwareness: false,
        scanDuanPath: false,
      });
      expect(result.scanned).toBe(2);
      expect(result.corrupted).toBe(1);
      expect(result.repaired).toBe(1);
    });

    it('backupFailed 计数器正确记录备份失败的文件', () => {
      // 制造一个备份失败场景：源文件不可读（权限问题难模拟，改用目录不存在的情况）
      // 实际上 copyFileSync 在普通 tmpdir 下都会成功，这里验证 counter 字段存在且默认为 0
      const dir = path.join(tmpRoot, 'counter-dir');
      fs.mkdirSync(dir, { recursive: true });
      fs.writeFileSync(path.join(dir, 'bad.json'), 'broken', 'utf-8');

      const result = checkOnStartup({
        extraDirs: [dir],
        scanAwareness: false,
        scanDuanPath: false,
      });
      // 正常修复路径下 backupFailed 应为 0
      expect(result.backupFailed).toBe(0);
      expect(result.repaired).toBe(1);
    });
  });

  describe('备份清理机制 pruneBackups', () => {
    it('修复后只保留最近 N 个备份', () => {
      const file = path.join(tmpRoot, 'repeat-corrupt.json');
      // 模拟同一文件被多次损坏+修复（先手动创建 6 个旧备份，再修复一次，应保留最近 5 个）
      for (let i = 0; i < 6; i++) {
        const oldBackup = `${file}.corrupt.${1000000 + i}.bak`;
        fs.writeFileSync(oldBackup, 'old-corrupt-content', 'utf-8');
      }
      // 第 7 次损坏+修复
      fs.writeFileSync(file, 'newly-broken', 'utf-8');
      const result = repairFile(file);
      expect(result.repaired).toBe(true);

      // 统计剩余 .bak 文件
      const dir = path.dirname(file);
      const base = path.basename(file);
      const remaining = fs.readdirSync(dir).filter(name =>
        name.startsWith(`${base}.corrupt.`) && name.endsWith('.bak')
      );
      // MAX_BACKUPS_PER_FILE = 5，所以应保留 5 个（含本次新创建的）
      expect(remaining.length).toBe(5);
    });

    it('保留的是 timestamp 最大的 N 个（最近创建的，非最旧）', () => {
      // 防回归：若排序逻辑写反，会保留最旧的而删除最新的，数量断言仍会通过
      const file = path.join(tmpRoot, 'sort-check.json');
      // 创建 6 个旧备份，timestamp 各不同
      const timestamps = [1000000, 2000000, 3000000, 4000000, 5000000, 6000000];
      for (const ts of timestamps) {
        fs.writeFileSync(`${file}.corrupt.${ts}.bak`, `content-${ts}`, 'utf-8');
      }
      // 触发一次修复（创建第 7 个备份，timestamp = Date.now()，远大于上述值）
      fs.writeFileSync(file, 'broken', 'utf-8');
      repairFile(file);

      const dir = path.dirname(file);
      const base = path.basename(file);
      const remaining = fs.readdirSync(dir).filter(name =>
        name.startsWith(`${base}.corrupt.`) && name.endsWith('.bak')
      );
      expect(remaining.length).toBe(5);
      // 验证保留的包含 timestamp 最大的几个（6000000 应保留，1000000 应被删除）
      const keptTimestamps = remaining.map(name => {
        const tsStr = name.slice(`${base}.corrupt.`.length, -'.bak'.length);
        return parseInt(tsStr, 10);
      });
      expect(keptTimestamps).toContain(6000000); // 第二大应保留
      expect(keptTimestamps).not.toContain(1000000); // 最小应被删除
    });

    it('备份数不足 N 时不清理', () => {
      const file = path.join(tmpRoot, 'few-backups.json');
      fs.writeFileSync(file, 'broken', 'utf-8');
      const result = repairFile(file);
      expect(result.repaired).toBe(true);

      const dir = path.dirname(file);
      const base = path.basename(file);
      const remaining = fs.readdirSync(dir).filter(name =>
        name.startsWith(`${base}.corrupt.`) && name.endsWith('.bak')
      );
      // 只有 1 个备份，不触发清理
      expect(remaining.length).toBe(1);
    });
  });

  describe('动态文件名前缀匹配', () => {
    it('feedback-*.json 重建为 []', () => {
      const dir = path.join(tmpRoot, 'feedback');
      fs.mkdirSync(dir, { recursive: true });
      const file = path.join(dir, 'feedback-2026-07-04.json');
      fs.writeFileSync(file, 'broken', 'utf-8');
      repairFile(file);
      const after = JSON.parse(fs.readFileSync(file, 'utf-8'));
      expect(Array.isArray(after)).toBe(true);
      expect(after).toEqual([]);
    });

    it('reward-*.json 重建为 []', () => {
      const dir = path.join(tmpRoot, 'feedback');
      fs.mkdirSync(dir, { recursive: true });
      const file = path.join(dir, 'reward-abc123.json');
      fs.writeFileSync(file, 'broken', 'utf-8');
      repairFile(file);
      const after = JSON.parse(fs.readFileSync(file, 'utf-8'));
      expect(Array.isArray(after)).toBe(true);
      expect(after).toEqual([]);
    });

    it('未登记前缀的文件回退到 {}（如 other-*.json）', () => {
      // 防回归：前缀匹配逻辑不应误判未登记前缀为数组
      const dir = path.join(tmpRoot, 'misc');
      fs.mkdirSync(dir, { recursive: true });
      const file = path.join(dir, 'other-xyz.json');
      fs.writeFileSync(file, 'broken', 'utf-8');
      repairFile(file);
      const after = JSON.parse(fs.readFileSync(file, 'utf-8'));
      expect(Array.isArray(after)).toBe(false);
      expect(after).toEqual({});
    });
  });

  describe('PARENT_DIR_OVERRIDES 优先级', () => {
    it('reasoning/records.json 仍为 []（OVERRIDES 不命中 → 回退 basename 数组集合）', () => {
      // 防回归：OVERRIDES 只对 history.json/index.json 生效，不应影响 reasoning 下其他数组文件
      const dir = path.join(tmpRoot, 'reasoning');
      fs.mkdirSync(dir, { recursive: true });
      const file = path.join(dir, 'records.json');
      fs.writeFileSync(file, 'broken', 'utf-8');
      repairFile(file);
      const after = JSON.parse(fs.readFileSync(file, 'utf-8'));
      expect(Array.isArray(after)).toBe(true);
      expect(after).toEqual([]);
    });

    it('cache/history.json 为 []（cache 不在 OVERRIDES → 回退 basename 数组集合）', () => {
      // 防回归：OVERRIDES 只匹配 reasoning，cache/history.json 应走 basename 默认 []
      const dir = path.join(tmpRoot, 'cache');
      fs.mkdirSync(dir, { recursive: true });
      const file = path.join(dir, 'history.json');
      fs.writeFileSync(file, 'broken', 'utf-8');
      repairFile(file);
      const after = JSON.parse(fs.readFileSync(file, 'utf-8'));
      expect(Array.isArray(after)).toBe(true);
      expect(after).toEqual([]);
    });
  });

  describe('checkOnStartup 多目录与深度', () => {
    it('多个 extraDirs 合并扫描', () => {
      const dir1 = path.join(tmpRoot, 'dir1');
      const dir2 = path.join(tmpRoot, 'dir2');
      fs.mkdirSync(dir1, { recursive: true });
      fs.mkdirSync(dir2, { recursive: true });
      fs.writeFileSync(path.join(dir1, 'a.json'), JSON.stringify({ a: 1 }), 'utf-8');
      fs.writeFileSync(path.join(dir1, 'bad.json'), 'broken', 'utf-8');
      fs.writeFileSync(path.join(dir2, 'b.json'), JSON.stringify({ b: 2 }), 'utf-8');
      fs.writeFileSync(path.join(dir2, 'bad2.json'), 'broken', 'utf-8');

      const result = checkOnStartup({
        extraDirs: [dir1, dir2],
        scanAwareness: false,
        scanDuanPath: false,
      });
      expect(result.scanned).toBe(4);
      expect(result.corrupted).toBe(2);
      expect(result.repaired).toBe(2);
    });

    it('maxDepth 限制递归深度', () => {
      // 结构：dir/top.json (深度 0)
      //       dir/sub/level1.json (深度 1)
      //       dir/sub/deep/level2.json (深度 2)
      const dir = path.join(tmpRoot, 'depth-test');
      const sub = path.join(dir, 'sub');
      const deep = path.join(sub, 'deep');
      fs.mkdirSync(deep, { recursive: true });
      fs.writeFileSync(path.join(dir, 'top.json'), JSON.stringify({}), 'utf-8');
      fs.writeFileSync(path.join(sub, 'level1.json'), JSON.stringify({}), 'utf-8');
      fs.writeFileSync(path.join(deep, 'level2.json'), JSON.stringify({}), 'utf-8');

      // maxDepth=1：应扫到 top + level1，不扫 level2
      const result = checkOnStartup({
        extraDirs: [dir],
        scanAwareness: false,
        scanDuanPath: false,
        maxDepth: 1,
      });
      expect(result.scanned).toBe(2);
    });

    it('跳过 node_modules 和 .git 目录', () => {
      const dir = path.join(tmpRoot, 'project-root');
      const nm = path.join(dir, 'node_modules');
      const git = path.join(dir, '.git');
      fs.mkdirSync(nm, { recursive: true });
      fs.mkdirSync(git, { recursive: true });
      fs.writeFileSync(path.join(dir, 'main.json'), JSON.stringify({ ok: true }), 'utf-8');
      // node_modules 和 .git 下的损坏 JSON 应被跳过（不计入 scanned/corrupted）
      fs.writeFileSync(path.join(nm, 'broken-dep.json'), 'broken', 'utf-8');
      fs.writeFileSync(path.join(git, 'broken-config.json'), 'broken', 'utf-8');

      const result = checkOnStartup({
        extraDirs: [dir],
        scanAwareness: false,
        scanDuanPath: false,
      });
      expect(result.scanned).toBe(1); // 只扫 main.json
      expect(result.corrupted).toBe(0); // node_modules/.git 下的损坏被跳过
    });
  });
});
