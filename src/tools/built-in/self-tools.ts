import * as fs from 'fs';
import * as path from 'path';
import { exec } from 'child_process';
import { promisify } from 'util';
const execAsync = promisify(exec);
import { errMsg, type UnifiedToolDef } from '../../core/unified-tool-def.js';
import { toolContext } from './tool-context.js';
import { rewindToCheckpoint, rewindSteps, getCheckpointHistory } from '../../core/checkpoint-singleton.js';

async function pathExists(p: string): Promise<boolean> {
  try {
    await fs.promises.access(p);
    return true;
  } catch {
    return false;
  }
}

export const selfTools: UnifiedToolDef[] = [
  {
    name: 'self_read',
    description: '读取本项目自身的源代码文件。用于自我分析和改进。',
    readOnly: true,
    parameters: { path: { type: 'string', description: '相对于项目根目录的文件路径', required: true } },
    execute: async (args) => {
      const projectRoot = process.cwd();
      const target = path.resolve(projectRoot, args.path as string);
      if (!target.startsWith(projectRoot)) return '❌ 不允许读取项目外的文件';
      try {
        return (await fs.promises.readFile(target, 'utf-8')).substring(0, 8000);
      } catch (err: unknown) { return `读取失败: ${errMsg(err)}`; }
    },
  },
  {
    name: 'self_write',
    description: '修改本项目自身的源代码文件。用于自我改进和升级。会自动创建备份。',
    parameters: { path: { type: 'string', description: '相对于项目根目录的文件路径', required: true }, content: { type: 'string', description: '新的文件内容', required: true } },
    execute: async (args) => {
      const projectRoot = process.cwd();
      const target = path.resolve(projectRoot, args.path as string);
      if (!target.startsWith(projectRoot)) return '❌ 不允许修改项目外的文件';
      try {
        if (await pathExists(target)) {
          const backupPath = target + '.backup.' + Date.now();
          await fs.promises.copyFile(target, backupPath);
        }
        await fs.promises.mkdir(path.dirname(target), { recursive: true });
        await fs.promises.writeFile(target, args.content as string, 'utf-8');
        return '✅ 已修改并创建备份';
      } catch (err: unknown) { return `写入失败: ${errMsg(err)}`; }
    },
  },
  {
    name: 'self_test',
    description: '运行TypeScript编译检查，验证代码修改是否正确',
    readOnly: true,
    parameters: { scope: { type: 'string', description: '检查范围: all(全部) / file(单个文件)', required: false }, file: { type: 'string', description: '当scope=file时指定文件路径', required: false } },
    execute: async (args) => {
      try {
        if ((args.scope as string) === 'file' && args.file) {
          const { stdout: result } = await execAsync(`npx tsc --noEmit --skipLibCheck "${args.file}" 2>&1 || true`, { cwd: process.cwd(), encoding: 'utf-8', timeout: 60000 });
          return result.substring(0, 3000) || '✅ 编译检查通过';
        }
        const { stdout: result } = await execAsync('npx tsc --noEmit --skipLibCheck 2>&1 || true', { cwd: process.cwd(), encoding: 'utf-8', timeout: 120000 });
        const lines = result.split('\n');
        const ownErrors = lines.filter(l => !l.includes('node_modules') && l.includes('error TS'));
        if (ownErrors.length === 0) return '✅ 全部编译检查通过';
        return `⚠️ ${ownErrors.length} 个错误:\n${ownErrors.slice(0, 10).join('\n')}`;
      } catch (err: unknown) { const msg = err instanceof Error ? err.message : String(err); return `检查失败: ${msg}`; }
    },
  },
  {
    name: 'self_rollback',
    description: '回滚对自身代码的修改。使用备份文件恢复。',
    parameters: { file: { type: 'string', description: '要回滚的文件路径', required: true } },
    execute: async (args) => {
      const projectRoot = process.cwd();
      const target = path.resolve(projectRoot, args.file as string);
      if (!target.startsWith(projectRoot)) return '❌ 不允许操作项目外的文件';
      const backupDir = path.dirname(target);
      const baseName = path.basename(target);
      const backups = (await fs.promises.readdir(backupDir)).filter(f => f.startsWith(baseName + '.backup.')).sort().reverse();
      if (backups.length === 0) return '❌ 未找到备份文件';
      try {
        await fs.promises.copyFile(path.join(backupDir, backups[0]), target);
        return `✅ 已回滚到备份: ${backups[0]}`;
      } catch (err: unknown) { return `回滚失败: ${errMsg(err)}`; }
    },
  },
  {
    name: 'rewind_files',
    description: 'P0-3: 回滚文件到指定 Checkpoint。对标 Claude Code 的 rewind_files(checkpoint_id)。文件修改前会自动创建 Checkpoint，可使用此工具回滚到任意中间状态。支持按 checkpoint_id 回滚或按步数回滚。',
    parameters: {
      checkpoint_id: { type: 'string', description: '目标 Checkpoint ID（与 steps 二选一）', required: false },
      steps: { type: 'number', description: '回滚步数（默认 1，与 checkpoint_id 二选一）', required: false },
      list: { type: 'boolean', description: '设为 true 则列出所有可用 Checkpoint，不执行回滚', required: false },
    },
    execute: async (args) => {
      try {
        // 列出 Checkpoint 历史
        if (args.list) {
          const history = getCheckpointHistory();
          if (history.length === 0) return '📭 暂无 Checkpoint 记录';
          const lines = history.slice(-20).map((h, i) =>
            `${i + 1}. [${h.id}] ${new Date(h.timestamp).toLocaleString()} — ${h.label} (${h.fileCount} 文件)`,
          );
          return `📋 Checkpoint 历史（最近 ${lines.length} 条）:\n${lines.join('\n')}`;
        }

        // 按 checkpoint_id 回滚
        if (args.checkpoint_id) {
          const success = await rewindToCheckpoint(args.checkpoint_id as string);
          return success
            ? `✅ 已回滚到 Checkpoint: ${args.checkpoint_id}`
            : `❌ 回滚失败 — Checkpoint ${args.checkpoint_id} 不存在`;
        }

        // 按步数回滚
        const steps = (args.steps as number) || 1;
        const success = await rewindSteps(steps);
        return success
          ? `✅ 已回滚 ${steps} 步`
          : `❌ 回滚失败 — 无法回滚 ${steps} 步（可能已到最早 Checkpoint）`;
      } catch (err: unknown) { return `❌ 回滚失败: ${errMsg(err)}`; }
    },
  },
  {
    name: 'self_learn',
    description: '记录一条学习经验。用于自我改进：记录错误、更好的方法、用户偏好等。',
    parameters: { category: { type: 'string', description: '分类: correction/best_practice/knowledge_gap/user_preference/insight', required: true }, content: { type: 'string', description: '学习内容', required: true }, source: { type: 'string', description: '来源描述', required: false } },
    execute: async (args) => {
      try {
        const learnDir = path.join(process.cwd(), '.learnings');
        await fs.promises.mkdir(learnDir, { recursive: true });
        const file = path.join(learnDir, 'LEARNINGS.md');
        const entry = `\n## ${new Date().toISOString()}\n- **分类**: ${args.category}\n- **内容**: ${args.content}\n- **来源**: ${args.source || '自我学习'}\n- **状态**: pending\n`;
        await fs.promises.appendFile(file, entry, 'utf-8');
        return '✅ 学习经验已记录';
      } catch (err: unknown) { return `记录失败: ${errMsg(err)}`; }
    },
  },
  {
    name: 'self_evolve',
    description: '触发自我进化流程：分析项目源代码中的质量问题，自动修复并验证。可指定改进方向。',
    parameters: { focus: { type: 'string', description: '改进方向: fix_issue/refactor/optimize/performance/reliability', required: false } },
    execute: async (args) => {
      if (!toolContext.selfEvolve) return '错误: 自我进化系统未初始化';
      try {
        const cycle = await toolContext.selfEvolve.runCycle(args.focus as string);
        return toolContext.selfEvolve.getEvolutionReport() + `\n\n本次周期: ${cycle.summary}`;
      } catch (err: unknown) { return `进化失败: ${errMsg(err)}`; }
    },
  },
  {
    name: 'self_upgrade',
    description: 'LLM驱动的代码升级：分析核心文件，生成改进计划，自动执行并验证。比 self_evolve 更智能。auto_execute默认true会自动执行，设为false仅查看计划。',
    parameters: {
      focus: { type: 'string', description: '改进方向: bug_fix/performance/feature/refactor/security/reliability', required: false },
      auto_execute: { type: 'boolean', description: '是否自动执行升级计划，默认true', required: false },
    },
    execute: async (args) => {
      if (!toolContext.selfUpgradeSystem) return '错误: 自我升级系统未初始化';
      try {
        const plan = await toolContext.selfUpgradeSystem.createUpgradePlan(args.focus);
        if (plan.operations.length === 0) return '✅ 代码状态良好，暂无需要升级的部分';
        let output = `📋 升级计划: ${plan.operations.length}项改进 (风险: ${plan.riskLevel})\n`;
        for (const op of plan.operations.slice(0, 10)) {
          output += `  [${op.type}] ${op.description} (${op.targetFile})\n`;
        }
        const autoExec = args.auto_execute !== false;
        if (!autoExec) {
          output += '\n💡 设置 auto_execute=true 可自动执行此计划';
          return output;
        }
        output += '\n⚡ 自动执行升级计划...\n';
        const result = await toolContext.selfUpgradeSystem.executeUpgrade(plan);
        output += `\n${result.summary}\n`;
        for (const op of result.operations) {
          let icon: string;
          if (op.status === 'tested') icon = '✅';
          else if (op.status === 'rolled_back') icon = '🔄';
          else icon = '❌';
          output += `  ${icon} [${op.type}] ${op.description} → ${op.status}\n`;
        }
        if (result.testResults.length > 0) {
          output += '\n测试结果:\n';
          for (const tr of result.testResults.slice(0, 5)) {
            output += `  ${tr}\n`;
          }
        }
        return output;
      } catch (err: unknown) { return `升级分析失败: ${errMsg(err)}`; }
    },
  },
  {
    name: 'self_test_suite',
    description: '运行功能完整性测试套件。验证所有模块是否达到设计规格要求。P0必须100%通过，P1≥90%，P2≥80%。',
    parameters: { category: { type: 'string', description: '可选: 按类别筛选测试，如 agent-loop / brain / nlu', required: false } },
    execute: async (args) => {
      if (!toolContext.functionalTestSuite) return '错误: 测试套件未初始化';
      try {
        const report = args.category
          ? await toolContext.functionalTestSuite.runByCategory(args.category as string)
          : await toolContext.functionalTestSuite.runAll();
        return toolContext.functionalTestSuite.formatReport(report);
      } catch (err: unknown) { return `测试执行失败: ${errMsg(err)}`; }
    },
  },
  {
    name: 'self_heal',
    description: '触发自我修复循环：健康检测→异常诊断→自动修复→验证确认。修复模块数据损坏、配置错误等问题。',
    parameters: {},
    execute: async () => {
      if (!toolContext.selfHealingEngine) return '错误: 自我修复引擎未初始化';
      try {
        const records = await toolContext.selfHealingEngine.run();
        const stats = toolContext.selfHealingEngine.getStats();
        if (records.length === 0) return '✅ 系统健康，无需修复';
        let output = `🩺 自愈完成: ${records.length}项\n`;
        for (const r of records) {
          output += `  ${r.success ? '✅' : '❌'} ${r.diagnosis.moduleName}: ${r.result}\n`;
        }
        output += `\n总修复: ${stats.totalRepairs} | 成功率: ${(stats.successRate * 100).toFixed(0)}%`;
        return output;
      } catch (err: unknown) { return `自愈失败: ${errMsg(err)}`; }
    },
  },
  {
    name: 'self_compress',
    description: '对当前对话上下文进行智能压缩，保留关键信息。使用主题分段、重要性评分、实体提取等技术。',
    parameters: {},
    execute: () => {
      if (!toolContext.contextCompressor) return Promise.resolve('错误: 压缩器未初始化');
      return Promise.resolve('✅ 上下文压缩器已就绪。系统将在token预算超80%时自动使用智能压缩。');
    },
  },
];
