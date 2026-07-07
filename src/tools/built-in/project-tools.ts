import * as fs from 'fs';
import * as path from 'path';
import { exec } from 'child_process';
import { promisify } from 'util';
import { errMsg, type UnifiedToolDef } from '../../core/unified-tool-def.js';
import { toolContext } from './tool-context.js';

const execAsync = promisify(exec);

export const projectTools: UnifiedToolDef[] = [
  {
    name: 'self_project',
    description: '分析项目结构和依赖关系。提供项目概述、文件结构、统计信息。',
    readOnly: true,
    parameters: { type: { type: 'string', description: '分析类型: overview/structure/stats/dependencies，默认overview', required: false } },
    execute: async (args) => {
      const type = (args.type as string) || 'overview';
      const root = process.cwd();
      try {
        if (type === 'overview' || type === 'structure') {
          const dirs: string[] = []; const files: string[] = [];
          const walk = async (dir: string, depth: number) => {
            if (depth > 3) return;
            try {
              for (const e of await fs.promises.readdir(dir, { withFileTypes: true })) {
                if (e.name === 'node_modules' || e.name.startsWith('.')) continue;
                const full = path.join(dir, e.name);
                if (e.isDirectory()) { dirs.push(full); await walk(full, depth + 1); }
                else files.push(full);
              }
            } catch {}
          };
          await walk(root, 0);
          let output = `📁 ${path.basename(root)}\n`;
          output += `  目录: ${dirs.length} | 文件: ${files.length}\n`;
          if (type === 'structure') {
            output += '\n主要目录:\n' + dirs.slice(0, 30).map(d => `  📂 ${path.relative(root, d)}`).join('\n');
            output += '\n\n源文件:\n' + files.filter(f => f.match(/\.(ts|js|tsx|jsx|json)$/)).slice(0, 30).map(f => `  📄 ${path.relative(root, f)}`).join('\n');
          }
          return output;
        }
        if (type === 'stats') {
          // P0 跨平台修复：之前用 'dir /s /b *.ts 2>nul || find ...' 混合 Win/Unix 命令，
          // Windows 的 find.exe 不识别 -name，Unix 无 dir，导致跨平台失败。
          // 现在按 process.platform 分支，并用 Node.js 原生 walk 作为兜底（无 shell 依赖）。
          const isWin = process.platform === 'win32';
          const collectByExt = async (ext: string): Promise<string[]> => {
            try {
              const cmd = isWin
                ? `cmd /c "dir /s /b *.${ext} 2>nul"`
                : `find . -name "*.${ext}" -type f 2>/dev/null`;
              const { stdout } = await execAsync(cmd, { cwd: root, encoding: 'utf-8', timeout: 10000 });
              return stdout.split('\n').map(s => s.trim()).filter(Boolean);
            } catch {
              // 兜底：Node.js 原生 walk（无 shell 依赖，跨平台保证）
              const collected: string[] = [];
              const walkDir = async (dir: string, depth: number) => {
                if (depth > 4) return;
                try {
                  for (const e of await fs.promises.readdir(dir, { withFileTypes: true })) {
                    if (e.name === 'node_modules' || e.name.startsWith('.')) continue;
                    const full = path.join(dir, e.name);
                    if (e.isDirectory()) await walkDir(full, depth + 1);
                    else if (full.endsWith(`.${ext}`)) collected.push(full);
                  }
                } catch {}
              };
              await walkDir(root, 0);
              return collected;
            }
          };
          const tsFiles = await collectByExt('ts');
          const jsFiles = await collectByExt('js');
          let totalLines = 0;
          for (const f of tsFiles.slice(0, 50)) { try { totalLines += (await fs.promises.readFile(f.trim(), 'utf-8')).split('\n').length; } catch {} }
          return `📊 项目统计:\n  TS文件: ${tsFiles.length}\n  JS文件: ${jsFiles.length}\n  代码行数(前50TS文件): ${totalLines}`;
        }
        if (type === 'dependencies') {
          const pkg = JSON.parse(await fs.promises.readFile(path.join(root, 'package.json'), 'utf-8'));
          const deps = Object.keys(pkg.dependencies || {}); const devDeps = Object.keys(pkg.devDependencies || {});
          return `📦 依赖:\n  运行时: ${deps.length}个\n  开发时: ${devDeps.length}个\n\n运行时:\n${deps.map(d => `  • ${d}`).join('\n')}\n\n开发时:\n${devDeps.map(d => `  • ${d}`).join('\n')}`;
        }
        return '用法: type=overview|structure|stats|dependencies';
      } catch (err: unknown) { return `分析失败: ${errMsg(err)}`; }
    },
  },
  {
    name: 'self_cost',
    description: '查看当前会话的Token消耗和成本统计',
    readOnly: true,
    parameters: { detail: { type: 'string', description: '详细程度: summary/detailed，默认summary', required: false } },
    execute: () => {
      if (!toolContext.evolutionMetrics) return Promise.resolve('错误: 指标系统未初始化');
      const report = (toolContext.evolutionMetrics as { generateReport: () => { categoryScores?: Record<string, number>; overallScore?: number } }).generateReport();
      if (!report) return Promise.resolve('指标系统未就绪');
      return Promise.resolve(`💰 Token消耗与成本统计\n  类别: ${report.categoryScores ? Object.keys(report.categoryScores).length : 0} | 综合评分: ${report.overallScore || 'N/A'}/100`);
    },
  },
  {
    name: 'self_metrics',
    description: '查看进化指标报告。包括智能、进化、功能、性能4大类指标的当前值和历史趋势。',
    readOnly: true,
    parameters: { format: { type: 'string', description: '报告格式: short/full，默认short', required: false } },
    execute: (args) => {
      const em = toolContext.evolutionMetrics;
      if (!em) return Promise.resolve('错误: 指标系统未初始化');
      try {
        const report = (em as { generateReport: () => { categoryScores: Record<string, number>; overallScore: number; criticalMetricsStatus: Array<{ status: string }>; comparisonWithLast: { overallDelta: number }; evolutionVelocity: number; timestamp: number } }).generateReport();
        if (args.format === 'full') return Promise.resolve((em as { formatReport: (report: unknown) => string }).formatReport(report));
        const catCount = Object.keys(report.categoryScores).length;
        const atRisk = report.criticalMetricsStatus.filter((s: { status: string }) => s.status !== 'on_track').length;
        const delta = report.comparisonWithLast.overallDelta;
        let trend: string;
        if (delta > 0) trend = '📈上升';
        else if (delta < 0) trend = '📉下降';
        else trend = '➡️平稳';
        return Promise.resolve(`📊 进化指标 (${new Date(report.timestamp).toLocaleString('zh-CN')})\n` +
          `  类别: ${catCount} | 异常指标: ${atRisk} | 综合评分: ${report.overallScore}/100\n` +
          `  趋势: ${trend} (${delta > 0 ? '+' : ''}${delta.toFixed(1)}) | 进化速度: ${report.evolutionVelocity.toFixed(1)}`);
      } catch (err: unknown) { return Promise.resolve(`指标查询失败: ${errMsg(err)}`); }
    },
  },
  {
    name: 'self_long_term_plan',
    description: '长期规划系统。创建项目、设定目标、里程碑和任务，追踪长期进度。',
    parameters: {
      action: { type: 'string', description: '操作: create_project/add_goal/add_milestone/add_task/status/list/upcoming/dashboard', required: true },
      title: { type: 'string', description: '标题 (create_project/add_goal/add_milestone/add_task时需要)', required: false },
      description: { type: 'string', description: '描述', required: false },
      parentId: { type: 'string', description: '父级ID (add_goal需要projectId, add_milestone需要goalId, add_task需要goalId)', required: false },
      priority: { type: 'string', description: '优先级: high/medium/low', required: false },
    },
    execute: async (args) => {
      if (!toolContext.longTermPlanner) return '错误: 长期规划系统未初始化';
      try {
        const action = args.action as string;
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const ltp = toolContext.longTermPlanner as any;
        if (action === 'dashboard') return await ltp.getDashboard();
        if (action === 'list') return await ltp.listProjects();
        if (action === 'upcoming') return await ltp.getUpcomingTasks(7);
        if (action === 'status' && args.parentId) return await ltp.getProjectStatus(args.parentId as string);
        if (action === 'create_project' && args.title) return await ltp.createProject(args.title as string, args.description as string || '');
        if (action === 'add_goal' && args.parentId && args.title) return await ltp.addGoal(args.parentId as string, args.title as string, args.description as string || '', args.priority as 'high' | 'medium' | 'low');
        if (action === 'add_milestone' && args.parentId && args.title) return await ltp.addMilestone(args.parentId as string, args.title as string);
        if (action === 'add_task' && args.parentId && args.title) return await ltp.addTask(args.parentId as string, args.title as string, args.description as string);
        return '用法: action=dashboard|list|upcoming|status|create_project|add_goal|add_milestone|add_task';
      } catch (err: unknown) { return `操作失败: ${errMsg(err)}`; }
    },
  },
];
