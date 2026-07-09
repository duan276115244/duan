#!/usr/bin/env node
/**
 * Probe: 列出火山引擎 ARK 可用模型 + 尝试多个 endpoint/model 组合
 */
const OpenAI = require('openai');

const DOUBAO_KEY = process.env.DOUBAO_API_KEY;
if (!DOUBAO_KEY) {
  console.error('❌ 未设置 DOUBAO_API_KEY');
  process.exit(1);
}

async function tryListModels(baseURL) {
  console.log(`\n📋 列出模型: ${baseURL}/models`);
  const client = new OpenAI({ apiKey: DOUBAO_KEY, baseURL });
  try {
    const list = await client.models.list();
    const data = list?.data || list;
    if (Array.isArray(data) && data.length > 0) {
      console.log(`  ✅ ${data.length} 个模型可用:`);
      data.slice(0, 20).forEach(m => {
        console.log(`     - ${m.id || JSON.stringify(m).slice(0, 100)}`);
      });
      if (data.length > 20) console.log(`     ... (省略 ${data.length - 20} 个)`);
      return data.map(m => m.id);
    } else {
      console.log(`  ⚠️  返回空列表: ${JSON.stringify(list).slice(0, 200)}`);
      return [];
    }
  } catch (err) {
    console.log(`  ❌ ${err?.message || err}`);
    return [];
  }
}

async function tryChat({ baseURL, model, prompt = '你好' }) {
  console.log(`\n🧪 Chat: ${baseURL} | model=${model}`);
  const client = new OpenAI({ apiKey: DOUBAO_KEY, baseURL });
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
    console.log(`  ✅ 成功 (${elapsed}ms) — ${JSON.stringify(content).slice(0, 60)}`);
    return true;
  } catch (err) {
    const elapsed = Date.now() - t0;
    console.log(`  ❌ 失败 (${elapsed}ms) — ${err?.message || err}`);
    return false;
  }
}

(async () => {
  console.log('='.repeat(60));
  console.log('火山引擎 ARK API 探测');
  console.log('='.repeat(60));

  // 1. 列出标准 endpoint 可用模型
  const stdModels = await tryListModels('https://ark.cn-beijing.volces.com/api/v3');

  // 2. 列出 coding plan endpoint 可用模型
  const codingModels = await tryListModels('https://ark.cn-beijing.volces.com/api/coding/v3');

  // 3. 尝试常见公开模型名
  console.log('\n' + '='.repeat(60));
  console.log('尝试已知模型名');
  console.log('='.repeat(60));

  const candidates = [
    // 标准 endpoint 模型候选
    { baseURL: 'https://ark.cn-beijing.volces.com/api/v3', model: 'doubao-1-5-pro-32k-250115' },
    { baseURL: 'https://ark.cn-beijing.volces.com/api/v3', model: 'doubao-1-5-lite-32k-250115' },
    { baseURL: 'https://ark.cn-beijing.volces.com/api/v3', model: 'doubao-pro-32k' },
    { baseURL: 'https://ark.cn-beijing.volces.com/api/v3', model: 'doubao-lite-32k' },
    { baseURL: 'https://ark.cn-beijing.volces.com/api/v3', model: 'doubao-seed-1-6-250615' },
    // Coding plan endpoint
    { baseURL: 'https://ark.cn-beijing.volces.com/api/coding/v3', model: 'ark-code-latest' },
    { baseURL: 'https://ark.cn-beijing.volces.com/api/coding/v3', model: 'doubao-1-5-pro-32k-250115' },
    { baseURL: 'https://ark.cn-beijing.volces.com/api/coding/v3', model: 'doubao-coding-pro' },
  ];

  const results = [];
  for (const c of candidates) {
    const ok = await tryChat(c);
    results.push({ ...c, ok });
    if (ok) {
      // 第一个成功的就够，停止后续尝试
      console.log(`\n✨ 找到可用组合，停止探测`);
      break;
    }
  }

  console.log('\n' + '='.repeat(60));
  const success = results.find(r => r.ok);
  if (success) {
    console.log(`✅ 推荐配置: baseURL=${success.baseURL} model=${success.model}`);
  } else {
    console.log(`❌ 所有候选模型均失败。可能原因：`);
    console.log(`   1. Key 未开通任何模型访问权限`);
    console.log(`   2. Key 是 coding plan 订阅但 model 名不对`);
    console.log(`   3. 需要先在火山引擎控制台创建 endpoint（ep-xxx）`);
  }
})();
