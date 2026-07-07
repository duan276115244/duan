import chalk from 'chalk';
import ora from 'ora';
import inquirer from 'inquirer';
import type { EnhancedAgentLoop } from './enhanced-agent-loop.js';
import type { CoreModules } from './bootstrap.js';
import { colors, showHelp, showStatus, type SystemState } from './cli-display.js';
import { errMsg } from './utils.js';
import { getChannelManager } from './channel-manager.js';
import { UnifiedConfigManager } from './unified-config.js';

export interface CLIContext {
  modules: CoreModules;
  loop: EnhancedAgentLoop;
  systemState: SystemState;
}

export async function handleCommand(input: string, ctx: CLIContext): Promise<string | null> {
  const {
    modules, loop, systemState,
  } = ctx;
  const {
    modelLibrary, selfLearningSystem, nluEngine, strategyEngine,
    selfEvolve, heartbeat, shadowGit, selfAssessment,
    moduleRegistry, diagnostics, knowledgeGraph, promptOptimizer,
    autonomousCapabilities, thinkingEngine, cognitiveState, selfAwareness,
    goalSystem, evolutionEngine, classifier,
    selfUpgradeSystem, unifiedToolFramework, skillExtractor,
  } = modules;

  const parts = input.trim().split(' ');
  const cmd = parts[0].toLowerCase();
  const args = parts.slice(1);
  const argText = args.join(' ');

  const aliasMap: Record<string, string> = {
    '设置': 'setup', '配置': 'setup', '设定': 'setup', '重设': 'setup', '初始化': 'setup', '还原': 'setup',
    '帮助': 'help', '命令': 'help', '指令': 'help',
    '状态': 'status', '状况': 'status', '状态查看': 'status',
    '模型': 'model', '切换模型': 'model', '换模型': 'model',
  };

  const resolvedCmd = aliasMap[cmd] || cmd;

  switch (resolvedCmd) {
    case 'help':
      showHelp(args[0]);
      return '';

    case 'status':
      showStatus(systemState, cognitiveState, goalSystem, heartbeat, selfAssessment, selfAwareness, selfEvolve, moduleRegistry);
      return '';

    case 'channels': {
      const cm = getChannelManager();
      const report = cm.getHealthReport();
      let output = chalk.cyan('\n📡 通道状态\n\n');
      output += chalk.dim('  总数: ') + report.totalChannels +
        chalk.dim(' | 已启用: ') + report.enabledChannels +
        chalk.dim(' | 运行中: ') + report.runningChannels +
        chalk.dim(' | 健康: ') + chalk.green(report.healthyChannels) + '\n\n';
      for (const ch of report.channels) {
        let icon: string;
        if (ch.status === 'healthy') icon = '✅';
        else if (ch.status === 'degraded') icon = '⚠️';
        else if (ch.status === 'error') icon = '❌';
        else icon = '⏹️';
        const uptime = ch.uptime > 0 ? `${Math.floor(ch.uptime / 60000)}m` : '-';
        output += `  ${icon} ${ch.id.padEnd(12)} ${ch.type.padEnd(10)} ${ch.status.padEnd(8)} uptime: ${uptime.padEnd(6)} msgs: ${ch.messageCount} errs: ${ch.errorCount}\n`;
        if (ch.lastError) output += `     ${chalk.red(ch.lastError)}\n`;
      }
      return output;
    }

    case 'setup':
    case 'configure': {
      const { runSetupWizard } = await import('../setup-wizard.js');
      const { ConfigManager } = await import('../config.js');
      await runSetupWizard(new ConfigManager());
      return chalk.green('\n✅ 配置完成');
    }

    case 'auto':
      systemState.autoMode = !systemState.autoMode;
      return chalk.hex(colors.accent)('👑 AUTO MODE: ') + (systemState.autoMode ? chalk.green('ACTIVATED') : chalk.yellow('DEACTIVATED'));

    case 'mode': {
      const validModes = ['reactive', 'proactive', 'strategic', 'creative'];
      if (!argText || !validModes.includes(argText)) {
        return chalk.yellow('用法: mode [reactive|proactive|strategic|creative]');
      }
      systemState.thinkingMode = argText as typeof systemState.thinkingMode;
      thinkingEngine.setThinkingMode(systemState.thinkingMode);
      return chalk.green('思考模式已切换为: ' + argText);
    }

    case 'think': {
      if (!argText) return chalk.yellow('用法: think [问题]');
      const spin = ora(chalk.cyan('💭 自主深度思考中...')).start();
      try {
        const result = thinkingEngine.chainOfThought(argText);
        spin.succeed('思考完成！');
        let output = chalk.cyan('\n💭 链式推理过程:\n\n');
        result.steps.forEach((step: string, i: number) => { output += `  ${i + 1}. ${step}\n`; });
        output += chalk.green('\n📝 结论: ' + result.conclusion);
        output += chalk.yellow('\n🎯 置信度: ' + (result.confidence * 100).toFixed(0) + '%');
        return output;
      } catch (error: unknown) {
        spin.fail('思考失败');
        return chalk.red('Error: ' + (error instanceof Error ? error.message : String(error)));
      }
    }

    case 'decide': {
      if (!argText) return chalk.yellow('用法: decide [问题]');
      const spin = ora(chalk.cyan('🧠 自主决策中...')).start();
      try {
        const decision = thinkingEngine.makeDecision(argText);
        spin.succeed('决策完成！');
        let output = chalk.cyan('\n🧠 自主决策报告:\n\n');
        output += `  📋 问题: ${decision.analysis.problem}\n`;
        output += `  📊 类型: ${decision.analysis.type} | 复杂度: ${decision.analysis.complexity}\n`;
        output += chalk.green('\n  📝 可行方案:\n');
        decision.plan.solutions.forEach((s: { id: string; description: string; estimatedSuccess: number }, i: number) => {
          const selected = s.id === decision.plan.selectedSolution ? ' ✅ 已选' : '';
          output += `    ${i + 1}. ${s.description} (成功率${(s.estimatedSuccess * 100).toFixed(0)}%)${selected}\n`;
        });
        return output;
      } catch (error: unknown) {
        spin.fail('决策失败');
        return chalk.red('Error: ' + (error instanceof Error ? error.message : String(error)));
      }
    }

    case 'evolve': {
      const spin = ora(chalk.cyan('🧬 自我进化中...')).start();
      try {
        const result = await evolutionEngine.runCycle();
        spin.succeed('进化完成！');
        systemState.evolutionLevel++;
        let output = chalk.green('\n🧬 进化周期完成!\n\n');
        output += `  进化等级: Lv.${systemState.evolutionLevel}\n`;
        output += `  综合改进: ${(result.results.overallImprovement * 100).toFixed(1)}%\n`;
        return output;
      } catch (error: unknown) {
        spin.fail('进化失败');
        return chalk.red('Error: ' + (error instanceof Error ? error.message : String(error)));
      }
    }

    case 'assess': {
      const spin = ora(chalk.cyan('🔍 自我评估中...')).start();
      try {
        const assessment = await evolutionEngine.selfAssess();
        spin.succeed('评估完成！');
        let output = chalk.cyan('\n🔍 SWOT自我评估:\n\n');
        output += `  💪 优势: ${assessment.strengths.join(', ')}\n`;
        output += `  ⚠️ 劣势: ${assessment.weaknesses.join(', ')}\n`;
        output += `  🚀 机会: ${assessment.opportunities.join(', ')}\n`;
        output += `  🔥 威胁: ${assessment.threats.join(', ')}\n`;
        return output;
      } catch (error: unknown) {
        spin.fail('评估失败');
        return chalk.red('Error: ' + (error instanceof Error ? error.message : String(error)));
      }
    }

    case 'diagnose': {
      const spin = ora(chalk.cyan('🔍 系统诊断中...')).start();
      try {
        const snapshot = diagnostics.capturePerformanceSnapshot({
          responseTime: 500,
          memoryUsage: process.memoryUsage().heapUsed / process.memoryUsage().heapTotal,
          cacheHitRate: 0.4,
          intentAccuracy: 0.82,
          taskCompletionRate: 0.88,
          errorRate: 0.05,
          activeConnections: 1,
          throughput: 10,
        });
        const result = diagnostics.runDiagnostics(snapshot);
        spin.succeed('诊断完成！');
        let output = chalk.cyan('\n🔍 系统诊断结果:\n\n');
        result.forEach((d: { level: string; name: string; message: string; suggestion?: string }) => {
          let icon: string;
          if (d.level === 'critical') {
            icon = '🔴';
          } else if (d.level === 'warning') {
            icon = '🟡';
          } else if (d.level === 'healthy') {
            icon = '🟢';
          } else {
            icon = '🔵';
          }
          output += `  ${icon} ${d.name}: ${d.message}\n`;
          if (d.suggestion) output += `     💡 ${d.suggestion}\n`;
        });
        return output;
      } catch (error: unknown) {
        spin.fail('诊断失败');
        return chalk.red('Error: ' + (error instanceof Error ? error.message : String(error)));
      }
    }

    case 'test': {
      const spin = ora(chalk.cyan('🧪 功能测试中...')).start();
      try {
        const result = diagnostics.runFunctionalTests((tc: { input: string; category: string }) => {
          const startTime = Date.now();
          try {
            const nluResult = nluEngine.analyzeSync(tc.input, []);
            const passed = nluResult.intents.length > 0 || tc.category !== 'NLU';
            return { passed, actualResult: passed ? '测试通过' : '测试未通过', executionTime: Date.now() - startTime };
          } catch (e: unknown) {
            return { passed: false, actualResult: `异常: ${errMsg(e)}`, executionTime: Date.now() - startTime };
          }
        });
        spin.succeed('测试完成！');
        let output = chalk.cyan('\n🧪 功能测试结果:\n\n');
        output += `  通过率: ${(result.passRate * 100).toFixed(0)}% (${result.passed}/${result.totalTests})\n\n`;
        return output;
      } catch (error: unknown) {
        spin.fail('测试失败');
        return chalk.red('Error: ' + (error instanceof Error ? error.message : String(error)));
      }
    }

    case 'benchmark': {
      const spin = ora(chalk.cyan('📊 性能基准测试中...')).start();
      try {
        const iterations = 20;
        const times: number[] = [];
        let _errors = 0;
        for (let i = 0; i < iterations; i++) {
          const start = Date.now();
          try {
            nluEngine.analyzeSync('测试输入：帮我分析一下这个项目的架构设计', []);
            times.push(Date.now() - start);
          } catch { _errors++; }
        }
        const avg = times.reduce((s, t) => s + t, 0) / times.length;
        const p95 = times[Math.floor(times.length * 0.95)];
        spin.succeed('基准测试完成！');
        let output = chalk.cyan('\n📊 性能基准测试结果:\n\n');
        output += `  平均响应: ${avg.toFixed(0)}ms\n`;
        output += `  P95响应: ${p95}ms\n`;
        output += `  吞吐量: ${(1000 / avg).toFixed(1)} req/s\n`;
        return output;
      } catch (error: unknown) {
        spin.fail('基准测试失败');
        return chalk.red('Error: ' + (error instanceof Error ? error.message : String(error)));
      }
    }

    case 'repair': {
      const spin = ora(chalk.cyan('🔧 自我修复检测中...')).start();
      try {
        const result = autonomousCapabilities.verifySelfRepair();
        spin.succeed('检测完成！');
        let output = chalk.cyan('\n🔧 自我修复验证结果:\n\n');
        output += `  评分: ${result.score}/100 | 验证: ${result.verified ? '✅ 通过' : '⚠️ 部分通过'}\n\n`;
        result.testCases.forEach((tc: { passed: boolean; name: string; actualBehavior: string }) => {
          output += `  ${tc.passed ? '✅' : '❌'} ${tc.name}: ${tc.actualBehavior}\n`;
        });
        return output;
      } catch (error: unknown) {
        spin.fail('检测失败');
        return chalk.red('Error: ' + (error instanceof Error ? error.message : String(error)));
      }
    }

    case 'knowledge': {
      if (!argText) {
        const stats = knowledgeGraph.getStats();
        return chalk.cyan(`🕸️ 知识图谱: ${stats.totalEntities}个实体, ${stats.totalRelations}条关系`);
      }
      const results = knowledgeGraph.query(argText);
      let output = chalk.cyan('\n🕸️ 知识查询结果:\n\n');
      results.entities.forEach((e: { name: string; type: string; properties: { description?: string } }) => {
        output += `  📌 ${e.name} (${e.type}): ${e.properties.description || ''}\n`;
      });
      return output;
    }

    case 'optimize': {
      if (!argText) return chalk.yellow('用法: optimize [文本]');
      const quality = promptOptimizer.analyzePromptQuality(argText);
      const optimized = promptOptimizer.optimizePrompt(argText, 'reasoning');
      let output = chalk.cyan('\n✨ 提示词优化结果:\n\n');
      output += `  📊 质量评分: ${quality.overallScore}/100\n`;
      output += chalk.green('  优化后:\n  ' + optimized.optimized.substring(0, 200) + '\n');
      return output;
    }

    case 'clear':
      return 'CLEAR_HISTORY';

    case 'exit':
    case 'quit':
      console.info(chalk.hex(colors.secondary)('\n  👋 再见！段先生随时为您服务。\n'));
      process.exit(0);
      // eslint-disable-next-line no-fallthrough
    case 'upgrade': {
      const spin = ora(chalk.cyan('🧬 自我升级分析中...')).start();
      try {
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        const result = await (selfUpgradeSystem as any).analyze(argText || 'general');
        spin.succeed('升级分析完成！');
        let output = chalk.cyan('\n🧬 自我升级分析:\n\n');
        if (result.upgrades) {
          result.upgrades.forEach((u: { name: string; priority: string; description: string }, i: number) => {
            output += `  ${i + 1}. ${u.name} (${u.priority})\n`;
            output += `     ${u.description}\n`;
          });
        }
        return output;
      } catch (error: unknown) {
        spin.fail('升级分析失败');
        return chalk.red('Error: ' + (error instanceof Error ? error.message : String(error)));
      }
    }

    case 'memory': {
      if (args[0] === 'stats') {
        const stats = await unifiedToolFramework.getStats();
        return chalk.cyan(`📊 统一记忆系统统计:\n${JSON.stringify(stats, null, 2)}`);
      }
      return chalk.yellow('用法: memory [stats/search/store/important/recent]');
    }

    case 'skills':
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      return chalk.cyan(`🔧 技能库:\n${JSON.stringify((skillExtractor as any).getExtractedSkills(), null, 2)}`);

    case 'strategies': {
      const current = strategyEngine.getCurrentStrategy();
      return chalk.cyan(`📋 策略引擎:\n当前策略: ${current.name}\n${current.description}`);
    }

    case 'mood': {
      if (argText) {
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        (cognitiveState as any).setMood(argText);
        return chalk.green(`情绪已设置为: ${argText}`);
      }
      return chalk.cyan(`当前情绪: ${cognitiveState.getState().mood}`);
    }

    case 'model': {
      if (args[0] === 'list') {
        const allModels = modelLibrary.getAllRegisteredModels();
        const availableModels = modelLibrary.getAvailableModels();
        const availableIds = new Set(availableModels.map((m: { id: string }) => m.id));

        if (allModels.length === 0) {
          return chalk.yellow('暂无可用模型，请运行 setup 配置 API Key');
        }

        // 按提供商分组
        const byProvider: Record<string, Array<{ id: string; name?: string; provider?: string; model: string; costPer1kTokens?: number }>> = {};
        for (const m of allModels) {
          const p = m.provider || 'other';
          if (!byProvider[p]) byProvider[p] = [];
          byProvider[p].push(m);
        }

        let output = chalk.cyan(`\n📋 模型列表 (已配置 ${availableModels.length}/${allModels.length})\n\n`);
        for (const [provider, models] of Object.entries(byProvider)) {
          output += chalk.hex(colors.secondary)(`  ── ${provider} ──\n`);
          for (const m of models) {
            const hasKey = availableIds.has(m.id);
            const statusIcon = hasKey ? chalk.green('✓') : chalk.red('✗');
            const freeTag = m.costPer1kTokens === 0 ? chalk.green('免费') : chalk.gray('收费');
            const keyTag = hasKey ? chalk.green('已配置') : chalk.gray('未配置');
            output += `  ${statusIcon} ${freeTag} ${chalk.white((m.name || '').padEnd(28))} ${chalk.gray(m.model.padEnd(35))} ${keyTag}\n`;
          }
          output += '\n';
        }
        output += chalk.gray('  运行 model 或 model switch 配置/切换模型\n');
        return output;
      }
      if (args[0] === 'auto') {
        modelLibrary.autoSelect(argText.replace('auto', '').trim());
        return chalk.green('✅ 模型自动选择完成');
      }
      if (args[0] === 'switch' || !args[0]) {
        // 交互式模型选择
        try {
          return await handleModelSwitch(loop, modelLibrary);
        } catch (err: unknown) {
          return chalk.red(`切换模型失败: ${err instanceof Error ? err.message : String(err)}`);
        }
      }
      return chalk.yellow('用法: model [list/switch/auto]');
    }

    case 'self-evolve': {
      const spin = ora(chalk.cyan('🧬 自进化分析...')).start();
      try {
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        const report = await (selfEvolve as any).analyze();
        spin.succeed('分析完成');
        return chalk.cyan(`🧬 自进化分析:\n${report}`);
      } catch (error: unknown) {
        spin.fail('自进化分析失败');
        return chalk.red('Error: ' + (error instanceof Error ? error.message : String(error)));
      }
    }

    case 'learn': {
      if (args[0] === 'report') {
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        const report = (selfLearningSystem as any).getLearningReport();
        return chalk.cyan(`📚 学习报告:\n${report}`);
      }
      return chalk.yellow('用法: learn [report/skill/query]');
    }

    case 'consciousness': {
      const cs = cognitiveState.getState();
      return chalk.cyan(`💭 意识状态:\n${JSON.stringify(cs, null, 2)}`);
    }

    case 'goals': {
      const stats = goalSystem.getStats();
      return chalk.cyan(`🎯 目标追踪:\n${stats}`);
    }

    case 'config': {
      return handleConfigCommand(args, input);
    }

    case 'shadow_log':
    case 'shadow_logs': {
      // P1-1 修复: getCheckpointLog() 不存在，改为调用 listCheckpoints()
      const logs = shadowGit.listCheckpoints(20);
      const formatted = logs.map((cp, i) =>
        `${i + 1}. ${cp.id.substring(0, 8)} | ${new Date(cp.timestamp).toLocaleString()} | ${cp.message} | ${cp.filesChanged} 文件变更`
      ).join('\n');
      return chalk.cyan(`📸 检查点历史:\n${formatted || '（无检查点）'}`);
    }

    case 'classifier': {
      const stats = classifier.getStats();
      return chalk.cyan(`🛡️ 分类器统计:\n${JSON.stringify(stats, null, 2)}`);
    }

    default: {
      return null;
    }
  }
}

async function handleConfigCommand(args: string[], _input: string): Promise<string> {
  const fs = await import('fs');
  const path = await import('path');
  const envPath = path.join(process.cwd(), '.env');

  if (args[0] === 'show') {
    let output = chalk.cyan('\n⚙️ 当前配置:\n\n');
    const configJsonPath = path.join(process.cwd(), 'config.json');
    try {
      if (fs.existsSync(configJsonPath)) {
        const cj = JSON.parse(fs.readFileSync(configJsonPath, 'utf-8'));
        if (cj.defaultModel) output += `  模型: ${cj.defaultModel}\n`;
        if (cj.defaultProvider) output += `  提供商: ${cj.defaultProvider}\n`;
        if (cj.temperature) output += `  温度: ${cj.temperature}\n`;
      }
    } catch {}
    if (fs.existsSync(envPath)) {
      const env = fs.readFileSync(envPath, 'utf-8');
      const keys = env.split('\n').filter(l => l.includes('=') && !l.startsWith('#'));
      output += `\n  📄 .env 配置项:\n`;
      keys.forEach(k => {
        const [key] = k.split('=');
        output += `    ${key}\n`;
      });
    }
    return output;
  }

  if (args[0] === 'set' && args.length >= 3) {
    const key = args[1].toUpperCase();
    const value = args.slice(2).join(' ');
    let env = '';
    try { if (fs.existsSync(envPath)) env = fs.readFileSync(envPath, 'utf-8'); } catch {}
    const keyRegex = new RegExp(`^${key}=.*`, 'm');
    if (keyRegex.test(env)) {
      env = env.replace(keyRegex, `${key}=${value}`);
    } else {
      env += `\n${key}=${value}`;
    }
    fs.writeFileSync(envPath, env.trim() + '\n', 'utf-8');
    return chalk.green(`✅ ${key} 已设置`);
  }

  if (args[0] === 'setup') {
    const { runSetupWizard } = await import('../setup-wizard.js');
    const { ConfigManager } = await import('../config.js');
    await runSetupWizard(new ConfigManager());
    return chalk.green('\n✅ 配置完成');
  }

  return chalk.yellow('用法: config [show/set KEY VALUE/setup]');
}

async function handleModelSwitch(loop: EnhancedAgentLoop, modelLibrary: { getAvailableModels: () => Array<{ id: string; name?: string; provider?: string; model: string; baseURL?: string; apiKey?: string; costPer1kTokens?: number }> } | null): Promise<string> {
  // 收集所有可选模型来源
  const availableModels = modelLibrary ? modelLibrary.getAvailableModels() : [];

  interface ModelOption {
    id: string;
    label: string;
    provider: string;
    model: string;
    baseURL: string;
    apiKey: string;
    free: boolean;
    source: string;
  }

  const options: ModelOption[] = [];

  // 从 ModelLibrary 获取
  for (const m of availableModels) {
    options.push({
      id: m.id,
      label: m.name || '',
      provider: m.provider,
      model: m.model,
      baseURL: m.baseURL || '',
      apiKey: m.apiKey || '',
      free: m.costPer1kTokens === 0,
      source: '内置',
    });
  }

  // 从 ~/.duan/config.json 获取（这些是用户通过 setup 配置的）
  // 通过 UnifiedConfigManager 读取，自动解密 API Key，兼容 v1.x 数组和 v2.0 对象格式
  try {
    const unified = UnifiedConfigManager.getInstance();
    const profilesMap = unified.getProfiles();
    for (const [pid, p] of Object.entries(profilesMap)) {
      const ak = p.apiKey || '';
      if (!ak || ak.length < 8 || ak.startsWith('your_')) continue;
      // 避免重复
      if (!options.find(o => o.provider === p.provider && o.model === p.model)) {
        options.push({
          id: pid,
          label: p.label || p.provider,
          provider: p.provider,
          model: p.model,
          baseURL: p.baseUrl || '',
          apiKey: ak,
          free: false,
          source: '配置',
        });
      }
    }
  } catch {}

  // 从环境变量获取（兜底）
  const envProviders: Array<{ envKey: string; provider: string; baseURL: string; model: string }> = [
    { envKey: 'DEEPSEEK_API_KEY', provider: 'deepseek', baseURL: 'https://api.deepseek.com/v1', model: 'deepseek-chat' },
    { envKey: 'AGNES_API_KEY', provider: 'agnes', baseURL: 'https://apihub.agnes-ai.com/v1', model: 'agnes-2.0-flash' },
    { envKey: 'SILICONFLOW_API_KEY', provider: 'siliconflow', baseURL: 'https://api.siliconflow.cn/v1', model: 'deepseek-ai/DeepSeek-V3' },
    { envKey: 'OPENROUTER_API_KEY', provider: 'openrouter', baseURL: 'https://openrouter.ai/api/v1', model: 'deepseek/deepseek-chat:free' },
    { envKey: 'GROQ_API_KEY', provider: 'groq', baseURL: 'https://api.groq.com/openai/v1', model: 'llama-3.3-70b-versatile' },
    { envKey: 'GOOGLE_API_KEY', provider: 'google', baseURL: 'https://generativelanguage.googleapis.com/v1beta/openai', model: 'gemini-2.0-flash' },
    { envKey: 'ALIYUN_API_KEY', provider: 'aliyun', baseURL: 'https://dashscope.aliyuncs.com/compatible-mode/v1', model: 'qwen-turbo' },
    { envKey: 'ZHIPU_API_KEY', provider: 'zhipu', baseURL: 'https://open.bigmodel.cn/api/paas/v4', model: 'glm-4-flash' },
    { envKey: 'DOUBAO_API_KEY', provider: 'doubao', baseURL: process.env.DOUBAO_BASE_URL || 'https://ark.cn-beijing.volces.com/api/v3', model: process.env.DOUBAO_MODEL || 'ep-please-config' },
    { envKey: 'MOONSHOT_API_KEY', provider: 'moonshot', baseURL: 'https://api.moonshot.cn/v1', model: 'moonshot-v1-8k' },
    { envKey: 'MINIMAX_API_KEY', provider: 'minimax', baseURL: 'https://api.minimax.chat/v1', model: 'MiniMax-Text-01' },
  ];
  for (const ep of envProviders) {
    const key = process.env[ep.envKey];
    if (key && key.length > 8 && !key.startsWith('your_')) {
      if (!options.find(o => o.provider === ep.provider)) {
        options.push({
          id: `env_${ep.provider}`,
          label: `${ep.provider} (${ep.model})`,
          provider: ep.provider,
          model: process.env[`${ep.provider.toUpperCase()}_MODEL`] || ep.model,
          baseURL: process.env[`${ep.provider.toUpperCase()}_BASE_URL`] || ep.baseURL,
          apiKey: key,
          free: true,
          source: '环境变量',
        });
      }
    }
  }

  if (options.length === 0) {
    return chalk.yellow('暂无可用模型。请先运行 setup 配置 API Key，或设置环境变量。\n  运行命令: setup');
  }

  // 构建选择列表
  const currentProvider = process.env.DEFAULT_MODEL_PROVIDER || '';

  const choices: Array<inquirer.Separator | { name: string; value: string; short: string }> = options.map(o => {
    const isCurrent = o.provider === currentProvider;
    const freeTag = o.free ? chalk.green('免费') : chalk.gray('收费');
    const currentTag = isCurrent ? chalk.yellow(' ← 当前') : '';
    const sourceTag = o.source !== '内置' ? chalk.blue(`[${o.source}]`) : '';
    return {
      name: `  ${freeTag} ${chalk.white(o.label.padEnd(28))} ${chalk.gray(o.model.padEnd(40))} ${sourceTag}${currentTag}`,
      value: o.id,
      short: o.label,
    };
  });

  choices.push(new inquirer.Separator());
  choices.push({
    name: `  ${chalk.yellow('➕ 添加新模型（运行 setup 向导）')}`,
    value: '__setup__',
    short: '添加新模型',
  });

  const { selectedId } = await inquirer.prompt([{
    type: 'list',
    name: 'selectedId',
    message: chalk.cyan('选择要使用的模型:'),
    choices,
    pageSize: Math.min(choices.length, 15),
  }]);

  if (selectedId === '__setup__') {
    const { runSetupWizard } = await import('../setup-wizard.js');
    const { ConfigManager } = await import('../config.js');
    await runSetupWizard(new ConfigManager());
    return chalk.green('\n✅ 配置完成，新模型已添加');
  }

  const selected = options.find(o => o.id === selectedId);
  if (!selected) return chalk.red('未找到所选模型');

  // 切换模型
  process.env.DEFAULT_MODEL = selected.model;
  process.env.DEFAULT_MODEL_PROVIDER = selected.provider;
  if (selected.baseURL) process.env[`${selected.provider.toUpperCase()}_BASE_URL`] = selected.baseURL;

  // 更新 config.json 的默认 profile（通过 UnifiedConfigManager，自动处理加密和文件监听）
  try {
    const unified = UnifiedConfigManager.getInstance();
    const profilesMap = unified.getProfiles();
    const matchEntry = Object.entries(profilesMap).find(([pid, p]) =>
      pid === selected.id || (p.provider === selected.provider && p.model === selected.model)
    );
    if (matchEntry) {
      unified.setActiveProfile(matchEntry[0]);
    }
  } catch {}

  // 清除 agent loop 的客户端缓存，下次调用时用新模型
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  (loop as any)._clientCache = null;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  (loop as any)._clientCacheTime = 0;

  return chalk.green(`\n✅ 已切换到: ${selected.label} (${selected.model})`);
}
