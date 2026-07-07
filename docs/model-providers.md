# 模型供应商

段先生支持 30+ AI 模型供应商，涵盖国内、国际和本地部署方案。
模型路由由 `ModelRouter` 和 `ModelLibrary` 统一管理，支持自动故障转移。

## 国内供应商

### DeepSeek （推荐）

```
提供商: deepseek
基础 URL: https://api.deepseek.com
模型: deepseek-chat, deepseek-reasoner, deepseek-coder
```

**特点**：性价比最高，中文能力强，支持超长上下文。

配置：
```json5
{
  "profiles": {
    "deepseek": {
      "provider": "deepseek",
      "apiKey": "sk-xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx",
      "model": "deepseek-chat",
      "baseUrl": "https://api.deepseek.com"
    }
  }
}
```

### 阿里通义千问 (Qwen)

```
提供商: aliyun
基础 URL: https://dashscope.aliyuncs.com/compatible-mode/v1
模型: qwen-max, qwen-plus, qwen-turbo, qwen2.5-72b
```

### 字节豆包 (Doubao)

```
提供商: doubao
基础 URL: https://ark.cn-beijing.volces.com/api/v3
模型: doubao-pro-32k, doubao-pro-128k, doubao-lite-32k
```

编码计划 (Coding Plan)：
```
提供商: doubao-coding
模型: ark-code-latest, doubao-seed-2.0-code
```

### 智谱 (GLM)

```
提供商: zhipu
基础 URL: https://open.bigmodel.cn/api/paas/v4
模型: glm-4-plus, glm-4-0520, glm-4-air, glm-4-flash
```

### SiliconFlow （硅基流动）

```
提供商: siliconflow
基础 URL: https://api.siliconflow.cn/v1
模型: Qwen2.5-72B, DeepSeek-V3, 等开源模型
```

**特点**：注册送 2000 万 token，支持大量开源模型。

### MiniMax

```
提供商: minimax
基础 URL: https://api.minimax.chat/v1
模型: minimax-m2.7, minimax-m3
```

### Moonshot （月之暗面）

```
提供商: moonshot
基础 URL: https://api.moonshot.cn/v1
模型: moonshot-v1-8k, moonshot-v1-32k, moonshot-v1-128k
```

## 国际供应商

### OpenAI

```
提供商: openai
基础 URL: https://api.openai.com/v1
模型: gpt-4o, gpt-4o-mini, gpt-4-turbo, o1, o3
```

### Anthropic (Claude)

```
提供商: anthropic
基础 URL: https://api.anthropic.com/v1
模型: claude-sonnet-4-6, claude-opus-4-6, claude-3-5-sonnet, claude-3-opus
```

### Google (Gemini)

```
提供商: google
基础 URL: https://generativelanguage.googleapis.com/v1beta/openai/
模型: gemini-2.0-flash, gemini-2.0-pro, gemini-1.5-pro
```

## 聚合平台

### OpenRouter

```
提供商: openrouter
基础 URL: https://openrouter.ai/api/v1
模型: 200+ 模型 (anthropic/claude-sonnet-4-6, openai/gpt-4o, google/gemini-2.0-flash 等)
```

### Groq

```
提供商: groq
基础 URL: https://api.groq.com/openai/v1
模型: llama-3.3-70b, mixtral-8x7b, gemma2-9b（极速推理）
```

## 本地模型

### Ollama

```
提供商: ollama
基础 URL: http://localhost:11434/v1
模型: llama3, mistral, qwen2.5, deepseek-r1（本地运行，无需 API Key）
```

配置：
```json5
{
  "profiles": {
    "ollama": {
      "provider": "ollama",
      "apiKey": "ollama",
      "model": "qwen2.5:7b",
      "baseUrl": "http://localhost:11434/v1"
    }
  }
}
```

## 模型故障转移

系统支持自动故障转移：当主模型不可用时，自动切换到备用模型。

```json5
{
  "preferences": {
    "modelFallback": true,
    "fallbackOrder": ["deepseek", "openai", "ollama"]
  }
}
```

故障转移策略：
1. 主模型 API 超时 → 立即切到备用
2. 主模型返回 429/5xx → 递减权重，切到备用
3. 所有远程模型不可用 → 自动降级到 Ollama 本地模型

## 自定义供应商

支持任何兼容 OpenAI API 格式的自定义端点：

```json5
{
  "profiles": {
    "custom": {
      "provider": "custom",
      "apiKey": "your-key",
      "model": "custom-model",
      "baseUrl": "https://your-custom-endpoint.com/v1"
    }
  }
}
```

## 运行时切换

在对话中实时切换模型：

```
> /model deepseek-chat
✅ 模型已切换为: deepseek-chat

> /model gpt-4o
✅ 模型已切换为: gpt-4o

> /model ollama/qwen2.5:7b
✅ 模型已切换为: ollama/qwen2.5:7b
```
