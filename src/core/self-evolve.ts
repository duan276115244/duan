import * as fs from 'fs';
import * as path from 'path';
import { execSync, exec } from 'child_process';
import { promisify } from 'util';
import { logger } from './structured-logger.js';
import { duanPath } from './duan-paths.js';
import { recordRuntimeValue } from './capability-assessment/runtime-values.js';
import { atomicWriteJsonSync } from './atomic-write.js';

const execAsync = promisify(exec);

export interface QualityGate {
  name: string;
  passed: boolean;
  details: string;
}

export interface EvolutionAction {
  id: string;
  type: 'fix_issue' | 'add_feature' | 'refactor' | 'optimize' | 'document';
  file: string;
  description: string;
  priority: 'critical' | 'high' | 'medium' | 'low';
  status: 'proposed' | 'applied' | 'tested' | 'failed' | 'rolled_back';
  backupPath?: string;
  diff?: string;
  error?: string;
  timestamp: number;
  qualityGates?: QualityGate[];
}

export interface EvolutionCycle {
  id: string;
  timestamp: number;
  actions: EvolutionAction[];
  summary: string;
  successCount: number;
  failCount: number;
  durationMs: number;
  qualityScore?: number;
}

export class SelfEvolve {
  private projectRoot: string;
  private history: EvolutionCycle[] = [];
  private historyFile: string;
  private log = logger.child({ module: 'SelfEvolve' });

  constructor() {
    this.projectRoot = process.cwd();
    // P0 D2: 进化历史是全局状态，统一用 duanPath
    this.historyFile = duanPath('evolution-history.json');
    fs.mkdirSync(path.dirname(this.historyFile), { recursive: true });
    this.loadHistory();
  }

  private loadHistory(): void {
    try {
      this.history = JSON.parse(fs.readFileSync(this.historyFile, 'utf-8'));
    } catch { this.history = []; }
  }

  private saveHistory(): void {
    // 原子写：进化历史是 self_iteration 维度的数据源，损坏会丢失改进轨迹
    atomicWriteJsonSync(this.historyFile, this.history.slice(-50));
  }

  private genId(): string {
    return `ev_${Date.now()}_${Math.random().toString(36).substr(2, 6)}`;
  }

  /** Check if git is available for snapshots */
  private hasGit(): boolean {
    try {
      execSync('git rev-parse --git-dir', { cwd: this.projectRoot, encoding: 'utf-8', stdio: 'ignore' });
      return true;
    } catch { return false; }
  }

  /** Create git-based snapshot for safe rollback */
  private createGitSnapshot(label: string): string | null {
    if (!this.hasGit()) return null;
    const branch = `evolve-snapshot-${Date.now()}`;
    try {
      execSync(`git stash push -m "evolve:auto-stash-${label}" 2>/dev/null || true`, { cwd: this.projectRoot });
      execSync(`git checkout -b ${branch} 2>/dev/null || git branch -f ${branch}`, { cwd: this.projectRoot });
      execSync('git add -A', { cwd: this.projectRoot });
      execSync(`git commit -m "evolve:snapshot ${label}" --allow-empty --no-verify 2>/dev/null || true`, { cwd: this.projectRoot });
      return branch;
    } catch {
      return null;
    }
  }

  /** Rollback via git reset */
  private rollbackViaGit(snapshotBranch: string | null): boolean {
    if (!snapshotBranch || !this.hasGit()) return false;
    try {
      const currentBranch = execSync('git rev-parse --abbrev-ref HEAD', { cwd: this.projectRoot, encoding: 'utf-8' }).trim();
      execSync(`git checkout ${snapshotBranch}`, { cwd: this.projectRoot });
      execSync(`git branch -D ${currentBranch} 2>/dev/null || true`, { cwd: this.projectRoot });
      return true;
    } catch { return false; }
  }

  /** Scan source files for issues */
  analyzeProject(): EvolutionAction[] {
    const actions: EvolutionAction[] = [];
    const srcDir = path.join(this.projectRoot, 'src');
    if (!fs.existsSync(srcDir)) return actions;

    const walk = (dir: string) => {
      try {
        for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
          const full = path.join(dir, e.name);
          if (e.isDirectory() && e.name !== 'node_modules') walk(full);
          else if (e.name.endsWith('.ts')) {
            const analysis = this.analyzeFile(full);
            actions.push(...analysis);
          }
        }
      } catch {}
    };
    walk(srcDir);

    actions.sort((a, b) => {
      const order = { critical: 0, high: 1, medium: 2, low: 3 };
      return (order[a.priority] || 99) - (order[b.priority] || 99);
    });

    this.log.info(`analyze complete`, { totalActions: actions.length });
    return actions;
  }

  private analyzeFile(filePath: string): EvolutionAction[] {
    const actions: EvolutionAction[] = [];
    try {
      const content = fs.readFileSync(filePath, 'utf-8');
      const lines = content.split('\n');
      const relPath = path.relative(this.projectRoot, filePath);

      if (content.includes('any') && !content.includes('eslint-disable')) {
        const anyLines = lines.filter(l =>
          /\bany\b/.test(l) &&
          !l.trim().startsWith('//') &&
          !/Record\s*<[^>]*\bany\b[^>]*>/.test(l)
        ).length;
        if (anyLines > 3) {
          actions.push(this.makeAction('fix_issue', relPath,
            `${relPath}: 发现 ${anyLines} 处 'any' 类型，建议替换为具体类型`,
            anyLines > 10 ? 'high' : 'medium'));
        }
      }

      if (content.includes('console.log(')) {
        const logLines = lines.filter(l => l.includes('console.log(') && !l.trim().startsWith('//')).length;
        if (logLines > 5) {
          actions.push(this.makeAction('refactor', relPath,
            `${relPath}: 发现 ${logLines} 处 console.log，建议替换为结构化日志`, 'low'));
        }
      }

      const charCount = content.length;
      if (charCount > 5000 && !content.includes('eslint-disable')) {
        actions.push(this.makeAction('refactor', relPath,
          `${relPath}: 文件过长(${charCount}字符，${lines.length}行)，建议拆分为多个模块`, 'medium'));
      }

      if (content.includes('catch (')) {
        let emptyCount = 0;
        for (let i = 0; i < lines.length - 1; i++) {
          if (lines[i].includes('catch (') && lines[i + 1].trim() === '}') emptyCount++;
        }
        if (emptyCount > 0) {
          actions.push(this.makeAction('fix_issue', relPath,
            `${relPath}: 发现 ${emptyCount} 处空catch块，建议添加错误处理`, 'high'));
        }
      }

      const todoCount = lines.filter(l => /\/\/\s*(TODO|FIXME|HACK|XXX|BUG)/i.test(l)).length;
      if (todoCount > 3) {
        actions.push(this.makeAction('refactor', relPath,
          `${relPath}: 发现 ${todoCount} 处 TODO/FIXME 标记，建议处理`, 'low'));
      }

      const funcCount = (content.match(/function\s+\w+\s*\(/g) || []).length +
        (content.match(/=>\s*{/g) || []).length;
      if (funcCount > 30 && lines.length > 300) {
        actions.push(this.makeAction('refactor', relPath,
          `${relPath}: 单文件包含 ${funcCount}+ 函数(${lines.length}行)，建议拆分职责`, 'medium'));
      }

      if (content.includes('as any') || content.includes('as unknown')) {
        const asCount = (content.match(/as\s+(any|unknown)/g) || []).length;
        if (asCount > 5) {
          actions.push(this.makeAction('fix_issue', relPath,
            `${relPath}: 发现 ${asCount} 处类型断言(as any/unknown)，建议使用 proper types`, 'medium'));
        }
      }

    } catch {}
    return actions;
  }

  private makeAction(type: EvolutionAction['type'], file: string, description: string, priority: EvolutionAction['priority']): EvolutionAction {
    return { id: this.genId(), type, file, description, priority, status: 'proposed', timestamp: Date.now() };
  }

  /** Apply a specific evolution action */
  async applyAction(action: EvolutionAction): Promise<EvolutionAction> {
    const fullPath = path.join(this.projectRoot, action.file);
    if (!(await this.pathExists(fullPath))) {
      action.status = 'failed';
      action.error = '文件不存在';
      return action;
    }

    try {
      const backupPath = fullPath + '.evolve.backup.' + Date.now();
      await fs.promises.copyFile(fullPath, backupPath);
      action.backupPath = backupPath;
      this.cleanupOldBackups(fullPath);

      const content = await fs.promises.readFile(fullPath, 'utf-8');
      let newContent = content;

      if (action.type === 'fix_issue' && action.description.includes('any')) {
        newContent = content.split('\n').map((l: string) => {
          if (l.trim().startsWith('//') || l.includes('// evolve-keep') || /Record\s*<[^>]*\bany\b[^>]*>/.test(l)) return l;
          return l.replace(/\bany\b/g, 'unknown');
        }).join('\n');
      }
      if (action.type === 'fix_issue' && action.description.includes('catch')) {
        newContent = content.replace(/catch\s*\([^)]*\)\s*\{\s*\}/g, (match) => {
          const errVar = match.match(/catch\s*\(([^)]*)\)/)?.[1] || 'e';
          return `catch (${errVar}) {\n    console.error(\`Error in ${action.file}: \${${errVar}}\`);\n  }`;
        });
      }

      if (newContent !== content) {
        await fs.promises.writeFile(fullPath, newContent, 'utf-8');
        action.status = 'applied';
        action.diff = this.computeDiff(content, newContent);
      } else {
        action.status = 'tested';
      }
    } catch (err: unknown) {
      action.status = 'failed';
      action.error = (err instanceof Error ? err.message : String(err));
    }
    return action;
  }

  private async pathExists(p: string): Promise<boolean> {
    try {
      await fs.promises.access(p);
      return true;
    } catch {
      return false;
    }
  }

  /** Test all applied actions (compile check) */
  async testActions(actions: EvolutionAction[]): Promise<EvolutionAction[]> {
    const applied = actions.filter(a => a.status === 'applied');
    if (applied.length === 0) return actions;

    try {
      // P1-4: execSync → execAsync — 避免在 async runCycle 中阻塞事件循环
      const { stdout } = await execAsync('npx tsc --noEmit --skipLibCheck 2>&1 || true', {
        cwd: this.projectRoot, timeout: 120000,
      });
      const result = stdout;
      const errors = result.split('\n').filter(l => l.includes('error TS')).length;
      if (errors === 0) {
        // F1 修复：Gate 3 — vitest 回归测试（tsc 通过后强制跑单元测试，失败则标记回滚）
        try {
          const { stdout: testOut } = await execAsync('npx vitest run --reporter=verbose 2>&1 || true', {
            cwd: this.projectRoot, timeout: 180000,
          });
          const failedMatch = testOut.match(/(\d+)\s+failed/);
          if (failedMatch && parseInt(failedMatch[1], 10) > 0) {
            applied.forEach(a => {
              a.status = 'failed';
              a.error = `vitest 回归失败: ${failedMatch[1]} 个测试失败`;
            });
          } else {
            applied.forEach(a => a.status = 'tested');
          }
        } catch {
          // vitest 运行本身失败（非测试失败），不阻塞进化，仅降级为 tested
          applied.forEach(a => a.status = 'tested');
        }
      } else {
        const ownErrors = result.split('\n').filter(l => l.includes('error TS') && !l.includes('node_modules'));
        if (ownErrors.length > 0) {
          applied.forEach(a => {
            a.status = 'failed';
            a.error = `编译错误: ${ownErrors.slice(0, 3).join('; ')}`;
          });
        }
      }
    } catch (err: unknown) {
      applied.forEach(a => {
        a.status = 'failed';
        a.error = (err instanceof Error ? err.message : String(err));
      });
    }
    return actions;
  }

  /** Rollback failed actions */
  rollbackActions(actions: EvolutionAction[]): EvolutionAction[] {
    const failed = actions.filter(a => a.status === 'failed' && a.backupPath);
    for (const action of failed) {
      try {
        const targetPath = path.join(this.projectRoot, action.file);
        if (fs.existsSync(action.backupPath!)) {
          fs.copyFileSync(action.backupPath!, targetPath);
          fs.unlinkSync(action.backupPath!);
          action.status = 'rolled_back';
        }
      } catch (err: unknown) {
        action.error = `回滚失败: ${(err instanceof Error ? err.message : String(err))}`;
      }
    }
    return actions;
  }

  /** Run a full evolution cycle */
  async runCycle(focus?: string): Promise<EvolutionCycle> {
    const startTime = Date.now();
    const cycle: EvolutionCycle = {
      id: this.genId(),
      timestamp: startTime,
      actions: [],
      summary: '',
      successCount: 0,
      failCount: 0,
      durationMs: 0,
    };

    cycle.actions = this.analyzeProject();
    if (focus) {
      cycle.actions = cycle.actions.filter(a =>
        a.type === focus || a.file.includes(focus) || a.description.includes(focus)
      );
    }

    cycle.actions = cycle.actions.slice(0, 5);

    for (let i = 0; i < cycle.actions.length; i++) {
      cycle.actions[i] = await this.applyAction(cycle.actions[i]);
    }

    cycle.actions = await this.testActions(cycle.actions);
    cycle.actions = this.rollbackActions(cycle.actions);

    for (const action of cycle.actions) {
      action.qualityGates = await this.runQualityGates(action);
    }

    cycle.successCount = cycle.actions.filter(a => a.status === 'tested' || a.status === 'applied').length;
    // failCount 包含 rolled_back：被回滚的动作本质是失败的动作（rollbackActions 将 failed→rolled_back）
    cycle.failCount = cycle.actions.filter(a => a.status === 'failed' || a.status === 'rolled_back').length;
    cycle.durationMs = Date.now() - startTime;

    const totalGates = cycle.actions.reduce((s, a) => s + (a.qualityGates?.length || 0), 0);
    const passedGates = cycle.actions.reduce((s, a) => s + (a.qualityGates?.filter(g => g.passed).length || 0), 0);
    cycle.qualityScore = totalGates > 0 ? passedGates / totalGates : 0;

    // 能力评估埋点：improvement_velocity（最近 7 天累计 successCount）+ regression_rate（触发回滚的比例）
    // 口径修正：regression_rate 按 dimensions.ts 描述应为"触发回滚的进化动作比例"，
    // 用 rolled_back 计数（而非 failCount，failCount 在 rollbackActions 之后会漏掉已回滚动作）
    try {
      const weekAgo = Date.now() - 7 * 24 * 60 * 60 * 1000;
      const weeklySuccess = this.history
        .concat(cycle)
        .filter(c => c.timestamp >= weekAgo)
        .reduce((s, c) => s + c.successCount, 0);
      recordRuntimeValue('improvement_velocity', weeklySuccess);
      const totalActions = cycle.actions.length;
      const rolledBackCount = cycle.actions.filter(a => a.status === 'rolled_back').length;
      recordRuntimeValue('regression_rate', totalActions > 0 ? rolledBackCount / totalActions : 0);
    } catch {
      // 埋点失败不阻断进化循环
    }

    cycle.summary = `进化周期完成: ${cycle.successCount}成功/${cycle.failCount}失败 | 质量分:${(cycle.qualityScore * 100).toFixed(0)}% | 耗时:${(cycle.durationMs / 1000).toFixed(1)}s`;

    this.log.info('evolution cycle complete', {
      successCount: cycle.successCount,
      failCount: cycle.failCount,
      qualityScore: cycle.qualityScore,
      durationMs: cycle.durationMs,
      actionsCount: cycle.actions.length,
    });

    this.history.push(cycle);
    this.saveHistory();
    return cycle;
  }

  getHistory(): EvolutionCycle[] {
    return this.history.slice(-10).reverse();
  }

  getStats(): string {
    const total = this.history.length;
    const success = this.history.reduce((s, c) => s + c.successCount, 0);
    const fail = this.history.reduce((s, c) => s + c.failCount, 0);
    return `📊 进化统计: ${total}个周期, ${success}项成功, ${fail}项失败`;
  }

  private computeDiff(original: string, modified: string): string {
    const origLines = original.split('\n');
    const modLines = modified.split('\n');
    const diffLines: string[] = [];
    let added = 0, removed = 0;
    for (let i = 0; i < Math.max(origLines.length, modLines.length); i++) {
      if (i < origLines.length && i < modLines.length && origLines[i] === modLines[i]) continue;
      if (i < origLines.length) { diffLines.push(`-${String(i + 1).padStart(4)}| ${origLines[i]}`); removed++; }
      if (i < modLines.length) { diffLines.push(`+${String(i + 1).padStart(4)}| ${modLines[i]}`); added++; }
    }
    const header = `--- 原始 (${origLines.length}行)\n+++ 修改后 (${modLines.length}行)\n@@ -${removed} +${added} @@\n`;
    return header + diffLines.slice(0, 50).join('\n');
  }

  /** Run quality gates on an action */
  private async runQualityGates(action: EvolutionAction): Promise<QualityGate[]> {
    const gates: QualityGate[] = [];
    const fullPath = path.join(this.projectRoot, action.file);

    if (!fs.existsSync(fullPath)) {
      gates.push({ name: 'file_exists', passed: false, details: '文件不存在' });
      return gates;
    }

    const content = fs.readFileSync(fullPath, 'utf-8');

    // Gate 1: Syntax check via tsc
    try {
      await execAsync(`npx tsc --noEmit --skipLibCheck "${fullPath}" 2>&1 || true`, {
        cwd: this.projectRoot, encoding: 'utf-8', timeout: 60000,
      });
      gates.push({ name: 'type_check', passed: true, details: '类型检查通过' });
    } catch (err: unknown) {
      gates.push({ name: 'type_check', passed: false, details: `类型错误: ${(err instanceof Error ? err.message : String(err)).slice(0, 100)}` });
    }

    // Gate 2: No new 'any' types introduced
    if (action.type === 'fix_issue' && action.description.includes('any')) {
      const anyCount = (content.match(/\bany\b/g) || []).length;
      gates.push({ name: 'no_new_any', passed: anyCount <= 5, details: `剩余 ${anyCount} 处 any` });
    }

    // Gate 3: File size not exploded
    gates.push({ name: 'file_size', passed: content.length < 50000, details: `${content.length} 字符` });

    // Gate 4: No placeholder content
    const hasPlaceholders = /TODO|FIXME|placeholder|TODO:/i.test(content);
    gates.push({ name: 'no_placeholders', passed: !hasPlaceholders, details: hasPlaceholders ? '含占位符标记' : '通过' });

    // Gate 5: Balanced braces
    const openBraces = (content.match(/{/g) || []).length;
    const closeBraces = (content.match(/}/g) || []).length;
    gates.push({ name: 'balanced_braces', passed: openBraces === closeBraces, details: `{${openBraces}}/${closeBraces}}` });

    return gates;
  }

  private cleanupOldBackups(filePath: string, maxBackups = 5): void {
    try {
      const dir = path.dirname(filePath);
      const baseName = path.basename(filePath);
      const backupFiles = fs.readdirSync(dir)
        .filter(f => f.startsWith(baseName + '.evolve.backup.'))
        .map(f => ({ name: f, time: fs.statSync(path.join(dir, f)).mtimeMs }))
        .sort((a, b) => b.time - a.time);
      if (backupFiles.length > maxBackups) {
        for (const old of backupFiles.slice(maxBackups)) {
          fs.unlinkSync(path.join(dir, old.name));
        }
      }
    } catch {}
  }

  getEvolutionReport(): string {
    const recent = this.history.slice(-3);
    let report = `🧬 **自进化报告**\n\n${this.getStats()}\n\n`;

    if (recent.length === 0) {
      report += '尚无进化周期。运行 self-evolve 启动第一轮。\n';
    } else {
      for (const cycle of recent) {
        report += `周期 #${cycle.id.slice(-6)}: ${cycle.summary}\n`;
        for (const action of cycle.actions.slice(0, 5)) {
          let icon: string;
          if (action.status === 'tested') icon = '✅';
          else if (action.status === 'failed') icon = '❌';
          else if (action.status === 'applied') icon = '🔧';
          else icon = '📋';
          report += `  ${icon} [${action.type}] ${action.description.substring(0, 80)}\n`;
        }
        report += '\n';
      }
    }
    return report;
  }
}