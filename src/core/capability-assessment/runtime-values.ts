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
 *
 * 测试隔离：通过 _setRuntimeValuesFileForTesting() 可覆盖文件路径，
 * 避免测试写入 ~/.duan/ 触发沙箱限制或污染真实数据。
 */

import * as fsSync from 'fs';
import * as path from 'path';
import { duanPath } from '../duan-paths.js';

/** 测试覆盖路径（非 null 时优先于默认路径） */
let _overrideFile: string | null = null;

/**
 * 获取当前 runtime 埋点值文件路径
 *
 * 优先级：
 * 1. _setRuntimeValuesFileForTesting() 设置的覆盖路径（测试用）
 * 2. duanPath('capability-assessment', 'runtime-values.json')（默认）
 */
export function getRuntimeValuesFile(): string {
  return _overrideFile ?? duanPath('capability-assessment', 'runtime-values.json');
}

/**
 * @internal 仅供测试使用：覆盖 runtime 埋点值文件路径
 *
 * 传入 null 恢复默认路径。生产代码不应调用此函数。
 */
export function _setRuntimeValuesFileForTesting(filePath: string | null): void {
  _overrideFile = filePath;
}

/**
 * @deprecated 使用 getRuntimeValuesFile() 替代。
 * 保留此导出仅为向后兼容；注意它仅在模块加载时计算一次，
 * 不会反映 _setRuntimeValuesFileForTesting() 的覆盖。
 */
export const RUNTIME_VALUES_FILE = duanPath('capability-assessment', 'runtime-values.json');

/** 加载所有 runtime 埋点值 */
export function loadRuntimeValues(): Record<string, number> {
  try {
    const file = getRuntimeValuesFile();
    if (!fsSync.existsSync(file)) return {};
    const data = JSON.parse(fsSync.readFileSync(file, 'utf-8'));
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
    const file = getRuntimeValuesFile();
    const dir = path.dirname(file);
    fsSync.mkdirSync(dir, { recursive: true });
    const current = loadRuntimeValues();
    current[metricId] = value;
    // 原子写：temp + rename
    const tmp = `${file}.${process.pid}.tmp`;
    fsSync.writeFileSync(tmp, JSON.stringify(current, null, 2), 'utf-8');
    fsSync.renameSync(tmp, file);
  } catch {
    // 写入失败不阻断主流程
  }
}

/**
 * 批量记录（一次原子写）
 */
export function recordRuntimeValues(values: Record<string, number>): void {
  try {
    const file = getRuntimeValuesFile();
    const dir = path.dirname(file);
    fsSync.mkdirSync(dir, { recursive: true });
    const current = loadRuntimeValues();
    for (const [k, v] of Object.entries(values)) {
      if (typeof v === 'number' && Number.isFinite(v)) {
        current[k] = v;
      }
    }
    const tmp = `${file}.${process.pid}.tmp`;
    fsSync.writeFileSync(tmp, JSON.stringify(current, null, 2), 'utf-8');
    fsSync.renameSync(tmp, file);
  } catch {
    // 忽略
  }
}

/** 清除所有 runtime 埋点值（用于重新采集） */
export function clearRuntimeValues(): void {
  try {
    const file = getRuntimeValuesFile();
    if (fsSync.existsSync(file)) {
      fsSync.unlinkSync(file);
    }
  } catch {
    // 忽略
  }
}
