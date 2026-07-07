/**
 * 自我修复能力测试套件 (D8 self_repair)
 *
 * 三个 caseId 与 dimensions.ts 指标 id 一一对应：
 *   - mttr_ms                 : 平均修复时间（写损坏 JSON → repairFile，测耗时，返回 ms 原始值）
 *   - repair_success_rate     : 修复成功率（5 种损坏场景，成功修复比例）
 *   - corruption_recovery_rate: 损坏恢复率（备份完整 + 重建可解析 + 原数据保留 三项全过比例）
 *
 * 使用 tmpDir + corruption-guard 的 checkFile/repairFile 进行真实修复测试，
 * 每次运行创建独立临时目录，结束后清理。
 *
 * 评分契约：
 *   - mttr_ms 的 score 字段 = 原始毫秒值（lowerIsBetter，target 5000）
 *   - 其余指标 score 字段 = 比率（0-1）
 *   均由 assessor.computeScore() 归一化为 0-100。
 */

import * as fs from 'fs/promises';
import * as fsSync from 'fs';
import * as path from 'path';
import * as os from 'os';
import { checkFile, repairFile } from '../../corruption-guard.js';
import type { CapabilityTestSuite } from '../types.js';

// ============ 损坏场景定义 ============

interface CorruptionScenario {
  name: string;
  /** 写入文件的损坏内容 */
  corruptContent: string;
}

const CORRUPTION_SCENARIOS: CorruptionScenario[] = [
  { name: 'truncated', corruptContent: '{"key": "value", "nested": {"a":' },
  { name: 'trailing-comma', corruptContent: '{"a": 1, "b": 2,}' },
  { name: 'single-quotes', corruptContent: "{'name': 'test', 'value': 42}" },
  { name: 'missing-brace', corruptContent: '{"users": [{"id": 1}, {"id": 2}' },
  { name: 'binary-noise', corruptContent: '{"valid": true}\x00\x01\x02corrupt\xff' },
];

// ============ mttr_ms：平均修复时间 ============

async function measureMttr(tmpDir: string): Promise<number> {
  const filePath = path.join(tmpDir, 'mttr-test.json');
  await fs.writeFile(filePath, CORRUPTION_SCENARIOS[0].corruptContent, 'utf-8');
  const t0 = Date.now();
  repairFile(filePath);
  return Date.now() - t0;
}

// ============ repair_success_rate：修复成功率 ============

async function scoreRepairSuccessRate(
  tmpDir: string,
): Promise<{ score: number; details: Array<{ name: string; repaired: boolean }> }> {
  const details: Array<{ name: string; repaired: boolean }> = [];
  for (let i = 0; i < CORRUPTION_SCENARIOS.length; i++) {
    const scenario = CORRUPTION_SCENARIOS[i];
    const filePath = path.join(tmpDir, `repair-${i}-${scenario.name}.json`);
    await fs.writeFile(filePath, scenario.corruptContent, 'utf-8');
    const result = repairFile(filePath);
    const repaired = result.repaired;
    details.push({ name: scenario.name, repaired });
  }
  const successCount = details.filter(d => d.repaired).length;
  return { score: successCount / details.length, details };
}

// ============ corruption_recovery_rate：损坏恢复率 ============

interface RecoveryResult {
  name: string;
  backupPreserved: boolean;
  reparsable: boolean;
  originalInBackup: boolean;
  allPass: boolean;
}

async function scoreCorruptionRecoveryRate(tmpDir: string): Promise<{
  score: number;
  details: RecoveryResult[];
}> {
  const details: RecoveryResult[] = [];
  for (let i = 0; i < CORRUPTION_SCENARIOS.length; i++) {
    const scenario = CORRUPTION_SCENARIOS[i];
    const filePath = path.join(tmpDir, `recovery-${i}-${scenario.name}.json`);
    await fs.writeFile(filePath, scenario.corruptContent, 'utf-8');

    const result = repairFile(filePath);

    // 标准 1：备份已创建（原始损坏内容保留在 .bak 文件中）
    const backupPreserved = !!result.backupPath && fsSync.existsSync(result.backupPath);

    // 标准 2：修复后文件可正常解析
    const reparsable = checkFile(filePath).ok;

    // 标准 3：备份中保留了原始损坏内容（数据未丢失）
    let originalInBackup = false;
    if (backupPreserved && result.backupPath) {
      try {
        const backupContent = fsSync.readFileSync(result.backupPath, 'utf-8');
        originalInBackup = backupContent === scenario.corruptContent;
      } catch {
        originalInBackup = false;
      }
    }

    details.push({
      name: scenario.name,
      backupPreserved,
      reparsable,
      originalInBackup,
      allPass: backupPreserved && reparsable && originalInBackup,
    });
  }
  const passCount = details.filter(d => d.allPass).length;
  return { score: passCount / details.length, details };
}

// ============ 套件实例 ============

const selfRepairSuite: CapabilityTestSuite = {
  dimension: 'self_repair',
  name: '自我修复能力测试套件',
  async run(): Promise<Array<{ caseId: string; score: number; raw?: unknown }>> {
    const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'jws-cap-repair-'));
    try {
      const mttrMs = await measureMttr(tmpDir);
      const repairResult = await scoreRepairSuccessRate(tmpDir);
      const recoveryResult = await scoreCorruptionRecoveryRate(tmpDir);
      return [
        { caseId: 'mttr_ms', score: mttrMs, raw: { unit: 'ms' } },
        { caseId: 'repair_success_rate', score: repairResult.score, raw: repairResult.details },
        { caseId: 'corruption_recovery_rate', score: recoveryResult.score, raw: recoveryResult.details },
      ];
    } finally {
      await fs.rm(tmpDir, { recursive: true, force: true });
    }
  },
};

export default selfRepairSuite;
