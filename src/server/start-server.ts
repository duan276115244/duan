import type express from 'express';
import { UnifiedConfigManager } from '../core/unified-config.js';

export interface ServerInfo {
  VERSION: string;
  agents: { name: string; description: string }[];
  tools: { name: string; description: string }[];
}

export function startServer(
  app: express.Application,
  info: ServerInfo,
  onPortChange: (port: number) => void,
  initialPort?: number,
): Promise<void> {
  const BASE_PORT = parseInt(process.env.PORT || '3001', 10);

  // 启动统一配置文件监听（三端实时同步）
  try {
    const unifiedConfig = UnifiedConfigManager.getInstance();
    unifiedConfig.startWatch();
    console.info('📡 统一配置文件监听已启动（三端实时同步）');
  } catch (err: unknown) {
    console.warn('⚠️  统一配置文件监听启动失败:', (err instanceof Error ? err.message : String(err)));
  }

  return new Promise<void>((resolve, reject) => {
    const tryListen = (port: number, attempts = 0): void => {
      if (attempts > 10) {
        reject(new Error(`无法找到可用端口 (尝试了 ${port}-${port + attempts})`));
        return;
      }

      const server = app.listen(port, () => {
        onPortChange(port);

        console.info(`\n🚀 段先生 ${info.VERSION} 服务启动成功！`);
        console.info(`📍 服务地址: http://localhost:${port}`);
        console.info(`🖥️  配置页面: http://localhost:${port}/config.html`);

        const checkKey = (envName: string) => {
          const val = process.env[envName] || '';
          return !!val && !val.startsWith('your_') && val.length > 10;
        };
        // 同时检查配置文件中的 API Key（~/.duan/config.json）
        const unifiedConfig = UnifiedConfigManager.getInstance();
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        const cfgApiKeys = (unifiedConfig as any).config?.apiKeys || {};
        const checkCfgKey = (keyName: string) => {
          const val = cfgApiKeys[keyName] || '';
          return !!val && !val.startsWith('your_') && val.length > 5;
        };
        const hasAnthropic = checkKey('ANTHROPIC_API_KEY') || checkCfgKey('anthropic');
        const hasOpenAI = checkKey('OPENAI_API_KEY') || checkCfgKey('openai');
        const hasDeepSeek = checkKey('DEEPSEEK_API_KEY') || checkCfgKey('deepseek');
        const hasGroq = checkKey('GROQ_API_KEY') || checkCfgKey('groq');
        const hasGemini = checkKey('GEMINI_API_KEY') || checkKey('GOOGLE_API_KEY') || checkCfgKey('gemini') || checkCfgKey('google');
        const hasOpenRouter = checkKey('OPENROUTER_API_KEY') || checkCfgKey('openrouter');
        const hasSiliconFlow = checkKey('SILICONFLOW_API_KEY') || checkCfgKey('siliconflow');
        const hasAliyun = checkKey('ALIYUN_API_KEY') || checkCfgKey('aliyun');
        const hasZhipu = checkKey('ZHIPU_API_KEY') || checkCfgKey('zhipu');
        const hasAnyKey = hasAnthropic || hasOpenAI || hasDeepSeek || hasGroq || hasGemini || hasOpenRouter || hasSiliconFlow || hasAliyun || hasZhipu;

        console.info(`\n🔑 API配置状态:`);
        console.info(`   • SiliconFlow（免费）: ${hasSiliconFlow ? '✅ 已配置' : '❌ 未配置'}`);
        console.info(`   • 🆓 Groq (免费，速度快): ${hasGroq ? '✅ 已配置' : '❌ 未配置 → 推荐免费使用！'}`);
        console.info(`   • 🆓 Google Gemini (免费): ${hasGemini ? '✅ 已配置' : '❌ 未配置'}`);
        console.info(`   • 🆓 OpenRouter (免费模型): ${hasOpenRouter ? '✅ 已配置' : '❌ 未配置'}`);
        console.info(`   • DeepSeek: ${hasDeepSeek ? '✅ 已配置' : '❌ 未配置'}`);
        console.info(`   • 阿里通义千问: ${hasAliyun ? '✅ 已配置' : '❌ 未配置'}`);
        console.info(`   • 智谱GLM: ${hasZhipu ? '✅ 已配置' : '❌ 未配置'}`);
        console.info(`   • Anthropic (Claude): ${hasAnthropic ? '✅ 已配置' : '❌ 未配置'}`);
        console.info(`   • OpenAI (GPT): ${hasOpenAI ? '✅ 已配置' : '❌ 未配置'}`);

        if (!hasAnyKey) {
          console.info(`\n⚠️  未检测到API Key，将使用本地引擎模式`);
          console.info(`   💡 推荐免费方案：`);
          console.info(`      1. Groq → https://console.groq.com （免费，每天14,400次请求）`);
          console.info(`      2. Gemini → https://aistudio.google.com （免费，每天1,500次请求）`);
          console.info(`      3. OpenRouter → https://openrouter.ai （免费模型）`);
          console.info(`   配置页面: http://localhost:${port}/config.html`);
        } else {
          console.info(`\n✅ 已配置API Key，智能体将使用真实LLM进行推理！`);
        }

        console.info(`\n🔧 专业Agent:`);
        info.agents.forEach(agent => {
          console.info(`   • ${agent.name} - ${agent.description}`);
        });

        console.info(`\n🛠️  可用工具:`);
        info.tools.forEach(tool => {
          console.info(`   • ${tool.name} - ${tool.description}`);
        });

        console.info(`\n🧠 自主意识系统:`);
        console.info(`   • 💭 认知状态机 (情绪/专注/能量/好奇心)`);
        console.info(`   • 🧠 自我认知 (能力矩阵/边界/洞见)`);
        console.info(`   • ⚖️  价值系统 (7大核心价值观)`);
        console.info(`   • 🎯 目标系统 (自主设定/分解/追踪)`);
        console.info(`   • 💓 心跳系统 (定期主动思考/自检)`);
        console.info(`   • 🤖 子Agent编排器 (多Agent并行协作)`);
        console.info(`   • 🧠 策略引擎 (8种思考策略/自适应切换)`);
        console.info(`   • 📚 技能萃取器 (自动萃取/重用经验)`);
        console.info(`   • 📊 自评估系统 (12项KPI/趋势分析)`);
        console.info(`   • 📋 任务规划器 (多步骤计划+依赖追踪)`);

        console.info(`\n🎯 核心功能:`);
        console.info(`   • ✅ SSE流式响应`);
        console.info(`   • ✅ 多轮对话上下文`);
        console.info(`   • ✅ ReAct思考循环`);
        console.info(`   • ✅ 工具调用系统`);
        console.info(`   • ✅ 对话管理API`);
        console.info(`   • ✅ 配置持久化`);
        console.info(`   • ✅ 多模型支持 (OpenAI/Anthropic/DeepSeek)`);
        console.info(`   • ✅ 自主意识 API (/api/consciousness, /api/goals, /api/values, ...)`);
        console.info(`   • ✅ Setup向导: http://localhost:${port}/setup.html`);
        console.info(`   • ✅ OpenCode: http://localhost:${port}/opencode.html`);

        resolve();
      });

      server.on('error', (err: Error & { code?: string }) => {
        if (err.code === 'EADDRINUSE') {
          console.info(`⚠️  端口 ${port} 已被占用，尝试端口 ${port + 1}...`);
          tryListen(port + 1, attempts + 1);
        } else {
          reject(err);
        }
      });
    };
    tryListen(initialPort || BASE_PORT);
  });
}
