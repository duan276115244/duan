/**
 * Runtime 埋点值管理
 *
 * source='new' 的指标（如 on_time_completion_rate, quality_gate_pass_rate,
 * gap_probing_rate, improvement_velocity, regression_rate）由系统各模块在运行时
 * 通过 recordRuntimeValue() 写入持久化文件，CLI 评估时通过 loadRuntimeValues() 读取。
 *
 * 文件位置：~/.duan/capability-assessment/runtime-values.json
 * 格式：{ "<metricId>": <number>, ... }
 *
 * 线程安全：原子写（temp + rename）
 */

import * as fsSync from 'fs';
import * as path from 'path';
import { duanPath } from '../duan-paths.js';

const RUNTIME_VALUES_FILE = duanPath('capability-assessment', 'runtime-values.json');

/** 加载所有 runtime 埋点值 */
export function loadRuntimeValues(): Record<string, number> {
  try {
    if (!fsSync.existsSync(RUNTIME_VALUES_FILE)) return {};
    const data = JSON.parse(fsSync.readFileSync(RUNTIME_VALUES_FILE, 'utf-8'));
    if (typeof data !== 'object' || data === null) return {};
    // 过滤掉非数字值
    const result: Record<string, number> = {};
    for (const [k, v] of Object.entries(data)) {
      if (typeof v === 'number' && Number.isFinite(v)) {
        result[k] = v;
      }
    }
    return result;
  } catch {
    return {};
  }
}

/**
 * 记录单个 runtime 埋点值（原子写）
 *
 * 其他模块调用方式：
 *   import { recordRuntimeValue } from './capability-assessment/runtime-values.js';
 *   recordRuntimeValue('quality_gate_pass_rate', 0.92);
 */
export function recordRuntimeValue(metricId: string, value: number): void {
  try {
    const dir = path.dirname(RUNTIME_VALUES_FILE);
    fsSync.mkdirSync(dir, { recursive: true });
    const current = loadRuntimeValues();
    current[metricId] = value;
    // 原子写：temp + rename
    const tmp = `${RUNTIME_VALUES_FILE}.${process.pid}.tmp`;
    fsSync.writeFileSync(tmp, JSON.stringify(current, null, 2), 'utf-8');
    fsSync.renameSync(tmp, RUNTIME_VALUES_FILE);
  } catch {
    // 写入失败不阻断主流程
  }
}

/**
 * 批量记录（一次原子写）
 */
export function recordRuntimeValues(values: Record<string, number>): void {
  try {
    const dir = path.dirname(RUNTIME_VALUES_FILE);
    fsSync.mkdirSync(dir, { recursive: true });
    const current = loadRuntimeValues();
    for (const [k, v] of Object.entries(values)) {
      if (typeof v === 'number' && Number.isFinite(v)) {
        current[k] = v;
      }
    }
    const tmp = `${RUNTIME_VALUES_FILE}.${process.pid}.tmp`;
    fsSync.writeFileSync(tmp, JSON.stringify(current, null, 2), 'utf-8');
    fsSync.renameSync(tmp, RUNTIME_VALUES_FILE);
  } catch {
    // 忽略
  }
}

/** 清除所有 runtime 埋点值（用于重新采集） */
export function clearRuntimeValues(): void {
  try {
    if (fsSync.existsSync(RUNTIME_VALUES_FILE)) {
      fsSync.unlinkSync(RUNTIME_VALUES_FILE);
    }
  } catch {
    // 忽略
  }
}

export { RUNTIME_VALUES_FILE };
