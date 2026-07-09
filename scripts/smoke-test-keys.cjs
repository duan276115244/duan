#!/usr/bin/env node
/**
 * Smoke test: 验证用户提供的 Agnes + 火山引擎 API key 是否可用
 *
 * 运行：
 *   AGNES_API_KEY=xxx DOUBAO_API_KEY=xxx node scripts/smoke-test-keys.cjs
 *
 * 测试内容：
 * 1. 每个供应商发一条 max_tokens=20 的 chat completion
 * 2. 记录响应延迟 + 首字延迟
 * 3. 报告成功/失败
 */
const OpenAI = require('openai');

const AGNES_KEY = process.env.AGNES_API_KEY;
const DOUBAO_KEY = process.env.DOUBAO_API_KEY;

if (!AGNES_KEY && !DOUBAO_KEY) {
  console.error('❌ 未设置 AGNES_API_KEY / DOUBAO_API_KEY 环境变量');
  process.exit(1);
}

async function testProvider({ name, apiKey, baseURL, model, prompt }) {
  if (!apiKey) {
    console.log(`[${name}] ⏭  跳过（未提供 key）`);
    return { name, skipped: true };
  }
  console.log(`[${name}] 🧪 测试中... (model=${model}, baseURL=${baseURL})`);
  const client = new OpenAI({ apiKey, baseURL });
  const t0 = Date.now();
  try {
    const resp = await client.chat.completions.create({
      model,
      messages: [{ role: 'user', content: prompt }],
      max_tokens: 20,
      temperature: 0,
    });
    const elapsed = Date.now() - t0;
    const content = resp.choices?.[0]?.message?.content || '(empty)';
    console.log(`[${name}] ✅ 成功 (${elapsed}ms) — 回复: ${JSON.stringify(content).slice(0, 80)}`);
    return { name, ok: true, elapsed, content };
  } catch (err) {
    const elapsed = Date.now() - t0;
    const msg = err?.message || String(err);
    console.log(`[${name}] ❌ 失败 (${elapsed}ms) — ${msg}`);
    return { name, ok: false, elapsed, error: msg };
  }
}

(async () => {
  console.log('='.repeat(60));
  console.log('API Key Smoke Test');
  console.log('='.repeat(60));

  const results = [];

  if (AGNES_KEY) {
    results.push(await testProvider({
      name: 'Agnes',
      apiKey: AGNES_KEY,
      baseURL: 'https://apihub.agnes-ai.com/v1',
      model: 'agnes-2.0-flash',
      prompt: '你好，请用一句话回复确认你能正常工作。',
    }));
  }

  if (DOUBAO_KEY) {
    results.push(await testProvider({
      name: '火山引擎 Doubao',
      apiKey: DOUBAO_KEY,
      baseURL: 'https://ark.cn-beijing.volces.com/api/v3',
      model: 'doubao-seed-2.0-lite',
      prompt: '你好，请用一句话回复确认你能正常工作。',
    }));
    // 火山引擎可能需要指定具体 model id（doubao-seed-2.0-lite 是泛称）
    // 如果标准 endpoint 失败，尝试 coding plan endpoint
  }

  console.log('='.repeat(60));
  const passed = results.filter(r => r.ok).length;
  const failed = results.filter(r => r.ok === false).length;
  const skipped = results.filter(r => r.skipped).length;
  console.log(`总计：${passed} 通过 / ${failed} 失败 / ${skipped} 跳过`);
  process.exit(failed > 0 ? 1 : 0);
})();
