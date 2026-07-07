/**
 * CorruptionGuard — 启动时损坏守卫
 *
 * 职责：
 * 1. 启动时扫描 ~/.duan/ 和 .awareness/ 下的 JSON 文件
 * 2. 对每个文件尝试 JSON.parse
 * 3. 不可解析的文件：备份（.corrupt.<timestamp>.bak）+ 重建为安全默认值
 * 4. 记录所有检测到 + 修复的损坏
 *
 * 设计原则：
 * - 非破坏性：原文件永远先备份再重建
 * - 原子写：temp + rename，避免半写状态
 * - 可恢复：备份文件保留原内容，可手动恢复
 * - 不阻断启动：单个文件修复失败不阻止其他文件或启动
 */

import * as fs from 'fs';
import * as path from 'path';
import { duanPath } from './duan-paths.js';
import { logger } from './structured-logger.js';

export interface CorruptionCheckResult {
  /** 扫描的文件总数 */
  scanned: number;
  /** 检测到的损坏文件数 */
  corrupted: number;
  /** 成功修复的文件数 */
  repaired: number;
  /** 修复失败的文件数 */
  failed: number;
  /** 备份失败但已重建的文件数（原内容永久丢失，需人工核查） */
  backupFailed: number;
  /** 检测到的损坏文件详情 */
  details: Array<{
    file: string;
    status: 'corrupted' | 'repaired' | 'failed';
    error?: string;
    backupPath?: string;
    /** 备份失败 = 原内容已丢失（重建仍成功，但无法回溯） */
    backupFailed?: boolean;
  }>;
}

/**
 * 安全默认值表：已知文件 → 默认内容
 *
 * 设计原则：
 * - 顶层为数组 [] 的文件必须显式声明，否则回退到 {} 会导致后续 for...of/.map/.filter 类型错误
 * - 顶层为对象 {} 的文件无需显式声明，回退到 DEFAULT_SAFE_VALUE 即可
 * - basename 冲突（同名文件在不同目录有不同类型）用 PARENT_DIR_OVERRIDES 按父目录区分
 *
 * 默认值来源：grep duanPath(...) 写入点 + 检查每个文件的 JSON.stringify 顶层结构。
 * 维护契约：新增 duanPath JSON 文件时，若顶层为数组，必须在此表登记。
 */
const DEFAULT_SAFE_VALUE: unknown = {};

/** 已知顶层为数组的文件（按 basename 查找）。对象类型文件无需登记，回退到 DEFAULT_SAFE_VALUE。 */
const ARRAY_DEFAULTS_BY_BASENAME = new Set<string>([
  // ~/.duan/ 根目录
  'conversation-history.json',   // duan-v19.0.ts:310
  'evolution-history.json',      // self-evolve.ts:63 (EvolutionCycle[])
  'mcp-config.json',             // mcp-integration.ts:1364 (MCPServerConfig[])
  'vectors.json',                // vector-store.ts:128
  // ~/.duan/persona/
  'user-profiles.json',          // duan-persona-engine.ts:736 (Array.from(entries()))
  // ~/.duan/learning/
  'records.json',                // self-learning-system.ts:1011
  'skills.json',                 // self-learning-system.ts:1015
  'knowledge.json',              // self-learning-system.ts:1019
  'patterns.json',               // self-learning-system.ts:1023
  'knowledge-graph.json',        // learning-engine.ts:762
  'learning-paths.json',         // learning-engine.ts:767
  'task-outcomes.json',          // learning-engine.ts:772
  // ~/.duan/skills/
  'discovered.json',             // skill-discovery.ts:852
  'sources.json',                // skill-discovery.ts:862
  // ~/.duan/evolution-metrics/
  'snapshots.json',              // evolution-metrics.ts:778
  // ~/.duan/dreaming/
  'chains.json',                 // dreaming-engine.ts:477
  'fragments.json',              // dreaming-engine.ts:482
  // ~/.duan/proactive/
  'triggers.json',               // proactive-engine.ts:335
  'habits.json',                 // proactive-engine.ts:336
  'timing.json',                 // proactive-engine.ts:337
  // ~/.duan/replays/
  'replays.json',                // session-memory-replay.ts:184
  // ~/.duan/decision/
  'mappings.json',               // intelligent-decision.ts:1701
  'learned.json',                // intelligent-decision.ts:1717
  // ~/.duan/visual/
  'templates.json',              // visual-intelligence.ts:268 (注：prompts/templates.json 也是 []，无冲突)
  // ~/.duan/execution/ + decision/ + visual/ — reasoning/ 例外见 PARENT_DIR_OVERRIDES
  'history.json',                // basename 冲突：execution/decision/visual 期望 []，reasoning 期望 {} (由 PARENT_DIR_OVERRIDES 优先匹配)
  // ~/.duan/metrics/
  'task-records.json',           // task-success-tracker.ts:529
  'failure-patterns.json',       // task-success-tracker.ts:533
  // ~/.duan/marketplace/
  'installed.json',              // mcp-marketplace.ts:982
  // ~/.duan/cache/
  'index.json',                  // smart-cache.ts:760 (注：experience-packs/index.json 是 {}，见 PARENT_DIR_OVERRIDES)
]);

/**
 * basename 冲突的父目录感知覆盖。
 *
 * 冲突 1：history.json
 *   - execution/decision/visual 期望 [] （已在 ARRAY_DEFAULTS_BY_BASENAME 隐式覆盖）
 *   - reasoning 期望 {history,learning,lastSaved}
 *
 * 冲突 2：index.json
 *   - cache 期望 [] （已在 ARRAY_DEFAULTS_BY_BASENAME 登记）
 *   - experience-packs 期望 {version,savedAt,count,ids}
 *
 * 查找规则：parentDir + basename 同时命中才返回该默认值；否则 basename 在 ARRAY_DEFAULTS_BY_BASENAME 中返回 []；
 * 否则返回 DEFAULT_SAFE_VALUE。
 *
 * 设计契约：覆盖规则必须同时匹配 parentDir 和 basename，避免误覆盖同目录下其他文件。
 * 例如 reasoning/ 目录下若将来新增 records.json（数组），不应被 reasoning 的 history.json 规则误判为对象。
 */
const PARENT_DIR_OVERRIDES: Array<{ parentDir: string; basename: string; value: unknown }> = [
  // history.json 冲突：reasoning 期望对象结构
  {
    parentDir: 'reasoning',
    basename: 'history.json',
    value: { history: [], learning: { patterns: [] }, lastSaved: 0 },
  },
  // index.json 冲突：experience-packs 期望对象结构
  {
    parentDir: 'experience-packs',
    basename: 'index.json',
    value: { version: 1, savedAt: 0, count: 0, ids: [] },
  },
];

/**
 * 动态命名的数组文件前缀（basename 以这些前缀开头的文件 → []）。
 *
 * 用于无法在 ARRAY_DEFAULTS_BY_BASENAME 中精确登记的动态文件名，如：
 * - `feedback-{date}.json` → StoredFeedback[]
 * - `reward-{id}.json` → StoredReward[]
 */
const ARRAY_DEFAULTS_BY_PREFIX: string[] = [
  'feedback-',   // feedback-reward.ts:952 (feedback/feedback-*.json)
  'reward-',     // feedback-reward.ts:974 (feedback/reward-*.json)
];

/**
 * 为给定文件路径选择安全默认值。
 *
 * 查找顺序：
 *   1. 父目录 + basename 联合感知覆盖（处理 basename 冲突，仅对特定组合生效）
 *   2. basename 在数组默认值集合中 → []
 *   3. basename 匹配数组前缀 → []
 *   4. 回退到 DEFAULT_SAFE_VALUE（{}）
 */
function pickSafeDefault(filePath: string): unknown {
  const parentDir = path.basename(path.dirname(filePath));
  const basename = path.basename(filePath);
  // 1. 父目录 + basename 联合查找（精确匹配，避免误覆盖同目录其他文件）
  for (const rule of PARENT_DIR_OVERRIDES) {
    if (parentDir === rule.parentDir && basename === rule.basename) {
      return rule.value;
    }
  }
  // 2. basename 在数组默认值集合中
  if (ARRAY_DEFAULTS_BY_BASENAME.has(basename)) {
    return [];
  }
  // 3. basename 匹配动态数组前缀（如 feedback-*.json / reward-*.json）
  for (const prefix of ARRAY_DEFAULTS_BY_PREFIX) {
    if (basename.startsWith(prefix)) {
      return [];
    }
  }
  // 4. 回退到对象
  return DEFAULT_SAFE_VALUE;
}

/**
 * 检测单个 JSON 文件是否可解析
 */
function isJsonFileParsable(filePath: string): { ok: boolean; error?: string } {
  try {
    const content = fs.readFileSync(filePath, 'utf-8');
    JSON.parse(content);
    return { ok: true };
  } catch (e: unknown) {
    return { ok: false, error: e instanceof Error ? e.message : String(e) };
  }
}

/** 每个文件保留的最大备份数（超出则清理最旧的） */
const MAX_BACKUPS_PER_FILE = 5;

/**
 * 清理同文件的旧备份，保留最近 maxKeep 个。
 *
 * 备份命名格式：`{filePath}.corrupt.{timestamp}.bak`
 * 按文件名中的 timestamp 降序排序，删除超出的最旧备份。
 *
 * 设计目的：长期运行的系统多次修复同一文件会累积大量 .bak，
 * 占用磁盘且无价值（只需保留最近几次用于回溯）。
 */
function pruneBackups(filePath: string, maxKeep: number = MAX_BACKUPS_PER_FILE): void {
  const dir = path.dirname(filePath);
  const base = path.basename(filePath);
  let entries: fs.Dirent[];
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true });
  } catch {
    return;
  }
  // 匹配 {base}.corrupt.{timestamp}.bak
  const prefix = `${base}.corrupt.`;
  const suffix = '.bak';
  const backups = entries
    .filter(e => e.isFile() && e.name.startsWith(prefix) && e.name.endsWith(suffix))
    .map(e => {
      // 提取 timestamp 部分用于排序
      const tsStr = e.name.slice(prefix.length, -suffix.length);
      const ts = parseInt(tsStr, 10);
      return { name: e.name, ts: Number.isNaN(ts) ? 0 : ts };
    })
    .sort((a, b) => b.ts - a.ts); // 降序（最新在前）

  if (backups.length <= maxKeep) return;

  const toDelete = backups.slice(maxKeep);
  const log = logger.child({ module: 'CorruptionGuard' });
  for (const b of toDelete) {
    try {
      fs.unlinkSync(path.join(dir, b.name));
    } catch {
      // 单个删除失败不阻断
    }
  }
  if (toDelete.length > 0) {
    log.debug('清理旧备份', { file: filePath, deleted: toDelete.length, kept: maxKeep });
  }
}

/**
 * 非破坏性修复：备份损坏文件 + 原子写重建 + 验证
 *
 * 设计契约：
 * - 完好文件（可解析）→ no-op，返回 { repaired: false }，**不修改文件内容**、不创建备份
 *   （这是公共 API 的安全保证：调用方误调 repairFile(goodFile) 不会丢数据）
 * - 损坏文件 → 备份原内容 + 重建为安全默认值 + 验证可解析 + 清理旧备份
 * - 备份失败 → 仍重建（文件已损坏不可用），但标记 backupFailed=true 并记 CRITICAL 日志
 *   （调用方据此决定是否升级告警；原内容此时已无法恢复，但至少新文件可用）
 * - 重建失败 → 返回 { repaired: false, error }，但备份仍保留
 */
function repairCorruptJson(filePath: string): {
  repaired: boolean;
  backupPath?: string;
  backupFailed?: boolean;
  error?: string;
} {
  const log = logger.child({ module: 'CorruptionGuard' });
  try {
    // 0. 先检查文件是否已损坏 —— 完好文件直接 no-op（防止误调破坏数据）
    const preCheck = isJsonFileParsable(filePath);
    if (preCheck.ok) {
      return { repaired: false };
    }

    // 1. 备份损坏文件（失败不阻断重建，但标记 + 记日志）
    const backupPath = `${filePath}.corrupt.${Date.now()}.bak`;
    let backupFailed = false;
    try {
      fs.copyFileSync(filePath, backupPath);
    } catch (e: unknown) {
      // 备份失败 = 原内容将永久丢失（重建会覆盖），必须记 CRITICAL
      backupFailed = true;
      log.error('备份损坏文件失败，原内容将永久丢失', {
        file: filePath,
        backupPath,
        error: e instanceof Error ? e.message : String(e),
      });
    }

    // 2. 选择安全默认值（类型感知：数组文件 → []，对象文件 → {}，冲突按父目录区分）
    const defaultValue = pickSafeDefault(filePath);
    const json = JSON.stringify(defaultValue, null, 2);

    // 3. 原子写：temp + rename
    const tmpPath = `${filePath}.${process.pid}.tmp`;
    fs.writeFileSync(tmpPath, json, 'utf-8');
    fs.renameSync(tmpPath, filePath);

    // 4. 验证重建后可解析
    const verify = isJsonFileParsable(filePath);
    if (!verify.ok) {
      return { repaired: false, backupPath: backupFailed ? undefined : backupPath, backupFailed, error: `重建后仍不可解析: ${verify.error}` };
    }

    // 5. 清理同文件的旧备份（保留最近 N 个），防止 .bak 无限累积
    if (!backupFailed) {
      try {
        pruneBackups(filePath, MAX_BACKUPS_PER_FILE);
      } catch {
        // 清理失败不阻断，旧备份留存不影响功能
      }
    }

    return { repaired: true, backupPath: backupFailed ? undefined : backupPath, backupFailed };
  } catch (e: unknown) {
    return { repaired: false, error: e instanceof Error ? e.message : String(e) };
  }
}

/**
 * 递归收集目录下所有 .json 文件
 */
function collectJsonFiles(dir: string, maxDepth: number = 3): string[] {
  const results: string[] = [];
  if (!fs.existsSync(dir)) return results;

  function walk(currentDir: string, depth: number): void {
    if (depth > maxDepth) return;
    let entries: fs.Dirent[];
    try {
      entries = fs.readdirSync(currentDir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      const fullPath = path.join(currentDir, entry.name);
      if (entry.isDirectory()) {
        // 跳过 node_modules 和 .git
        if (entry.name === 'node_modules' || entry.name === '.git') continue;
        walk(fullPath, depth + 1);
      } else if (entry.isFile() && entry.name.endsWith('.json')) {
        // 跳过 .bak / .tmp 文件
        if (entry.name.endsWith('.bak') || entry.name.endsWith('.tmp')) continue;
        results.push(fullPath);
      }
    }
  }

  walk(dir, 0);
  return results;
}

/**
 * 启动时损坏守卫：扫描 + 修复
 *
 * @param options 可选配置
 * @returns 检查结果
 */
export function checkOnStartup(options?: {
  /** 额外扫描的目录 */
  extraDirs?: string[];
  /** 是否扫描 .awareness/ 目录（默认 true） */
  scanAwareness?: boolean;
  /** 是否扫描 ~/.duan/ 目录（默认 true；测试时可设 false 隔离） */
  scanDuanPath?: boolean;
  /** 最大递归深度（默认 3） */
  maxDepth?: number;
}): CorruptionCheckResult {
  const log = logger.child({ module: 'CorruptionGuard' });
  const maxDepth = options?.maxDepth ?? 3;
  const dirs: string[] = [];

  if (options?.scanDuanPath !== false) {
    dirs.push(duanPath());
  }
  if (options?.scanAwareness !== false) {
    dirs.push(path.join(process.cwd(), '.awareness'));
  }
  if (options?.extraDirs) {
    dirs.push(...options.extraDirs);
  }

  const result: CorruptionCheckResult = {
    scanned: 0,
    corrupted: 0,
    repaired: 0,
    failed: 0,
    backupFailed: 0,
    details: [],
  };

  for (const dir of dirs) {
    const files = collectJsonFiles(dir, maxDepth);
    for (const file of files) {
      result.scanned++;
      const check = isJsonFileParsable(file);
      if (check.ok) continue;

      result.corrupted++;
      log.warn('检测到损坏的 JSON 文件，尝试修复', { file, error: check.error });

      const repair = repairCorruptJson(file);
      if (repair.repaired) {
        result.repaired++;
        if (repair.backupFailed) {
          result.backupFailed++;
        }
        result.details.push({
          file,
          status: 'repaired',
          backupPath: repair.backupPath,
          backupFailed: repair.backupFailed,
        });
        if (repair.backupFailed) {
          log.error('损坏文件已重建但备份失败，原内容永久丢失', { file });
        } else {
          log.info('损坏文件已修复', { file, backupPath: repair.backupPath });
        }
      } else {
        result.failed++;
        if (repair.backupFailed) {
          result.backupFailed++;
        }
        result.details.push({
          file,
          status: 'failed',
          error: repair.error,
          backupPath: repair.backupPath,
          backupFailed: repair.backupFailed,
        });
        log.error('损坏文件修复失败', { file, error: repair.error });
      }
    }
  }

  if (result.corrupted > 0) {
    log.warn('启动损坏守卫完成', {
      scanned: result.scanned,
      corrupted: result.corrupted,
      repaired: result.repaired,
      failed: result.failed,
      backupFailed: result.backupFailed,
    });
    if (result.backupFailed > 0) {
      log.error('有文件备份失败，原内容永久丢失，需人工核查', { count: result.backupFailed });
    }
  }

  return result;
}

/**
 * 检查单个文件是否损坏（不修复）
 */
export function checkFile(filePath: string): { ok: boolean; error?: string } {
  return isJsonFileParsable(filePath);
}

/**
 * 修复单个损坏文件（非破坏性）
 *
 * @returns 结果含 backupFailed 标志时表示原内容已永久丢失（备份创建失败但重建仍进行）
 */
export function repairFile(filePath: string): { repaired: boolean; backupPath?: string; backupFailed?: boolean; error?: string } {
  return repairCorruptJson(filePath);
}
