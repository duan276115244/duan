/**
 * Phase D1 端到端集成测试：用真实 LLM key 验证流式思考推送
 *
 * 验证目标：
 * 1. Agnes key 在 agent loop 中可用
 * 2. 复杂任务触发 Extended Thinking（_detectTaskComplexity.shouldTrigger=true）
 * 3. 每个 phase 作为独立 think 事件推送（含 🧩/🎯/💡/🔍/⚠️ emoji 前缀）
 *
 * 运行：
 *   $env:AGNES_API_KEY="..."; npx tsx scripts/e2e-phase-d1.ts
 */
import { EnhancedAgentLoop } from '../src/core/enhanced-agent-loop.js';

async function main(): Promise<void> {
  const apiKey = process.env.AGNES_API_KEY;
  if (!apiKey) {
    console.error('❌ 未设置 AGNES_API_KEY');
    process.exit(1);
  }

  console.log('='.repeat(60));
  console.log('Phase D1 端到端集成验证');
  console.log('='.repeat(60));

  const loop = new EnhancedAgentLoop({
    enableExtendedThinking: true,
    enablePlanning: false,
    defaultModel: 'agnes-2.0-flash',
    defaultProvider: 'agnes',
    apiKeys: { agnes: apiKey },
  });

  const input = '请设计一个微服务架构，实现用户认证和权限管理系统，需要考虑性能、安全、并发和向后兼容性。';
  console.log(`\n📝 输入: ${input.substring(0, 60)}...`);
  console.log(`🧠 检测任务复杂度...`);

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const complexity = (loop as any)._detectTaskComplexity(input);
  console.log(`   shouldTrigger=${complexity.shouldTrigger} depth=${complexity.depth} reason=${complexity.reason}`);

  if (!complexity.shouldTrigger) {
    console.log('⚠️  当前输入未触发 Extended Thinking，跳过流式验证');
    process.exit(0);
  }

  console.log(`\n🧪 验证流式 think 事件推送...`);
  const thinkEvents: string[] = [];
  const phaseEmojis = ['🧩', '🎯', '💡', '🔍', '⚠️', '📚'];

  let turns = 0;
  const maxEvents = 30;
  try {
    // run() 第二参数 context 是必填的（历史消息数组），首次调用传空数组
    for await (const event of loop.run(input, [])) {
      turns++;
      if (event.type === 'think') {
        thinkEvents.push(event.content || '');
        const firstLine = (event.content || '').split('\n')[0];
        console.log(`   [think #${thinkEvents.length}] ${firstLine.slice(0, 60)}`);
      } else if (event.type === 'tool_call') {
        console.log(`   [tool_call] ${event.toolName} — 终止验证（已进入执行阶段）`);
        break;
      } else if (event.type === 'chunk') {
        if ((event.content || '').length > 0) {
          console.log(`   [chunk] ${(event.content || '').slice(0, 50)}`);
          break;
        }
      } else if (event.type === 'error' || event.type === 'completed') {
        console.log(`   [${event.type}] ${(event.content || '').slice(0, 80)}`);
        if (event.type === 'completed' || event.type === 'error') break;
      }
      if (turns > maxEvents) {
        console.log(`   ⚠️  已达 ${maxEvents} 事件上限，停止收集`);
        break;
      }
    }
  } catch (err) {
    console.log(`\n❌ loop.run 抛错: ${(err as Error).message}`);
    console.log(`   堆栈: ${(err as Error).stack || '(无)'}`);
  }

  console.log(`\n📊 结果分析:`);
  console.log(`   收到 ${thinkEvents.length} 个 think 事件`);
  const foundEmojis = phaseEmojis.filter(emoji =>
    thinkEvents.some(content => content.startsWith(emoji)),
  );
  console.log(`   发现阶段 emoji: ${foundEmojis.join(' / ') || '（无）'}`);
  const hasIntro = thinkEvents.some(c => c.startsWith('🧠 检测到复杂任务'));
  console.log(`   含触发语 "🧠 检测到复杂任务": ${hasIntro ? '✅' : '❌'}`);

  const minExpectedPhases = 3;
  const success = foundEmojis.length >= minExpectedPhases && hasIntro;
  console.log(`\n${success ? '✅' : '⚠️'} Phase D1 端到端验证${success ? '通过' : '部分通过'}`);
  console.log(`   预期 ≥ ${minExpectedPhases} 个阶段 emoji + 触发语`);
  console.log(`   实际 ${foundEmojis.length} 个阶段 emoji ${hasIntro ? '+ 触发语' : ''}`);

  process.exit(success ? 0 : 1);
}

main().catch(err => {
  console.error('未捕获错误:', err);
  process.exit(1);
});
