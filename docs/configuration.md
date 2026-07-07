# 配置指南

段先生使用 `~/.duan/config.json` 作为唯一配置源（v2.0 格式），
三端（CLI / Web / Desktop）配置互通，支持热加载。

## 配置结构

```json5
// ~/.duan/config.json
{
  "version": "2.0",
  "activeProfile": "default",
  "profiles": {
    "default": {
      "provider": "deepseek",
      "apiKey": "enc:...",           // AES-256-GCM 加密
      "model": "deepseek-chat",
      "baseUrl": "https://api.deepseek.com",
      "label": "主力模型"
    }
  },
  "preferences": {
    "theme": "dark",
    "language": "zh-CN",
    "autoApprove": ["read", "list", "web_search"]
  },
  "channels": {
    // ... 见下方通道配置
  },
  "sync": {
    "lastModified": 1718612345678,
    "deviceId": "a1b2c3d4e5f6g7h8"
  }
}
```

## 消息通道配置

段先生的消息通道系统对标 OpenClaw 的 `channels.*` 配置模式，
支持访问控制（dmPolicy/allowFrom）、健康监控、多账户等特性。

### 通用配置模式

所有通道共享以下配置字段：

| 字段 | 类型 | 默认值 | 说明 |
|---|---|---|---|
| `enabled` | boolean | `true` | 启用/禁用通道 |
| `dmPolicy` | string | `"pairing"` | DM 策略: `pairing` / `allowlist` / `open` / `disabled` |
| `allowFrom` | string[] | `[]` | 允许的用户列表（allowlist/open 模式需要） |
| `groupPolicy` | string | `"allowlist"` | 群组策略: `allowlist` / `open` / `disabled` |
| `groupAllowFrom` | string[] | `[]` | 群组允许列表 |
| `requireMention` | boolean | `true` | 群组中是否需要 @提及 |
| `groups` | object | `{}` | 群组级覆盖配置 |
| `heartbeat` | object | - | 心跳检测配置 |

### 飞书 / Lark

飞书通道通过飞书开放平台的自定义机器人接入，
支持 WebSocket（推荐）和 Webhook 两种事件接收模式。

#### 前置条件

1. 打开 [飞书开放平台](https://open.feishu.cn/app)
2. 创建企业自建应用 → 获取 **App ID** 和 **App Secret**
3. 开启"机器人"能力
4. 配置事件订阅：
   - 事件类型：`im.message.receive_v1`
   - 订阅方式：WebSocket（推荐）或 Webhook
5. 发布应用并授予权限：`im:message`

#### 配置

```json5
{
  "channels": {
    "feishu": {
      "enabled": true,
      "dmPolicy": "pairing",
      "connectionMode": "websocket",       // websocket | webhook
      "accounts": {
        "main": {
          "appId": "cli_xxxxxxxxxxxxx",
          "appSecret": "xxxxxxxxxxxxxxxxxxxxxxxxxx",
          "botName": "段先生助手"
        }
      },
      "textChunkLimit": 2000,
      "streaming": true,
      "typingIndicator": true
    }
  }
}
```

#### Webhook 模式（需额外配置）

```json5
{
  "channels": {
    "feishu": {
      "enabled": true,
      "connectionMode": "webhook",
      "verificationToken": "your_verification_token",
      "encryptKey": "your_encrypt_key",
      "webhookPath": "/feishu/events",
      "webhookPort": 3000,
      "accounts": {
        "main": {
          "appId": "cli_xxxxxxxxxxxxx",
          "appSecret": "xxxxxxxxxxxxxxxxxxxxxxxxxx"
        }
      }
    }
  }
}
```

#### Lark（国际版）

```json5
{
  "channels": {
    "feishu": {
      "domain": "lark",          // 国际版设为 "lark"
      "accounts": {
        "main": {
          "appId": "cli_xxxxxxxxxxxxx",
          "appSecret": "xxxxxxxxxxxxxxxxxxxxxxxxxx"
        }
      }
    }
  }
}
```

### 企业微信

```json5
{
  "channels": {
    "wecom": {
      "enabled": true,
      "dmPolicy": "pairing",
      "botToken": "your_webhook_key",
      "apiUrl": "https://qyapi.weixin.qq.com",
      "corpId": "your_corp_id",
      "agentId": "your_agent_id",
      "encodingAesKey": "your_aes_key"
    }
  }
}
```

**获取方式**：
1. 登录 [企业微信管理后台](https://work.weixin.qq.com/wework_admin)
2. 应用管理 → 自建 → 创建应用
3. 获取 CorpID、AgentID、Secret
4. 在"接收消息"中配置 URL `http://your-server:3001/api/bridge/webhook/wecom`

### 钉钉

```json5
{
  "channels": {
    "dingtalk": {
      "enabled": true,
      "webhookUrl": "https://oapi.dingtalk.com/robot/send?access_token=xxx",
      "secret": "your_secret",           // 可选：加签模式
      "dmPolicy": "open"
    }
  }
}
```

**获取方式**：
1. 打开钉钉开放平台 → 机器人开发
2. 创建 Outgoing Webhook 机器人
3. 获取 Webhook URL 和加签 Secret

### Telegram

```json5
{
  "channels": {
    "telegram": {
      "enabled": true,
      "botToken": "123456789:ABCdefGHIjklMNOpqrsTUVwxyz",
      "dmPolicy": "pairing",
      "allowFrom": ["tg:123456789"],
      "groups": {
        "*": { "requireMention": true }
      },
      "historyLimit": 50,
      "streaming": "partial",
      "reactionLevel": "minimal"
    }
  }
}
```

**获取方式**：
1. 在 Telegram 搜索 `@BotFather`
2. 发送 `/newbot` 创建机器人
3. 复制获得的 Bot Token

### Discord

```json5
{
  "channels": {
    "discord": {
      "enabled": true,
      "botToken": "your_discord_bot_token",
      "dmPolicy": "pairing",
      "guilds": {
        "123456789012345678": {
          "slug": "my-server",
          "requireMention": true,
          "channels": {
            "general": { "allow": true },
            "help": { "allow": true }
          }
        }
      }
    }
  }
}
```

### Slack

```json5
{
  "channels": {
    "slack": {
      "enabled": true,
      "botToken": "xoxb-your-bot-token",
      "appToken": "xapp-your-app-token",
      "dmPolicy": "pairing",
      "channels": {
        "#general": { "allow": true, "requireMention": true }
      },
      "slashCommand": {
        "enabled": true,
        "name": "duan",
        "ephemeral": true
      }
    }
  }
}
```

### 邮件 (Email)

```json5
{
  "channels": {
    "email": {
      "enabled": true,
      "smtpHost": "smtp.example.com",
      "smtpPort": 465,
      "smtpUser": "your_email@example.com",
      "smtpPass": "your_smtp_password",
      "smtpFrom": "bot@example.com",
      "dmPolicy": "allowlist",
      "allowFrom": ["trusted@example.com"]
    }
  }
}
```

### 通用 Webhook

```json5
{
  "channels": {
    "webhook": {
      "enabled": true,
      "webhookUrl": "https://hooks.example.com/endpoint",
      "webhookSecret": "shared_secret",
      "dmPolicy": "open"
    }
  }
}
```

### 个人微信桥接

```json5
{
  "channels": {
    "wechat": {
      "enabled": true,
      "webhookUrl": "http://wechat-bridge:8080/webhook",
      "dmPolicy": "pairing"
    }
  }
}
```

### WhatsApp

WhatsApp 通道基于 WhatsApp Business Cloud API，通过 Meta 平台收发消息。

#### 前置条件

1. 打开 [Meta for Developers](https://developers.facebook.com/apps)
2. 创建应用 → 添加 WhatsApp 产品
3. 在 WhatsApp → API Setup 获取 **Phone Number ID** 和 **Access Token**
4. 在 WhatsApp → Configuration 配置 Webhook：
   - 回调 URL：`http://your-server:3001/api/bridge/webhook/whatsapp`
   - Verify Token：自定义字符串（与配置一致）
   - 订阅字段：`messages`

#### 配置

```json5
{
  "channels": {
    "whatsapp": {
      "enabled": true,
      "phoneNumberId": "1234567890",
      "accessToken": "EAAG...",
      "verifyToken": "your_custom_verify_token",
      "dmPolicy": "pairing"
    }
  }
}
```

**环境变量（向后兼容）**：

```
WHATSAPP_PHONE_NUMBER_ID=1234567890
WHATSAPP_ACCESS_TOKEN=EAAG...
WHATSAPP_VERIFY_TOKEN=your_custom_verify_token
```

### Microsoft Teams

Teams 通道通过 Incoming Webhook 收发消息。

#### 前置条件

1. 在 Teams 频道中点击 "..." → 连接器
2. 添加 "Incoming Webhook" 连接器
3. 配置名称并获取 Webhook URL

#### 配置

```json5
{
  "channels": {
    "teams": {
      "enabled": true,
      "webhookUrl": "https://outlook.office.com/webhook/xxx",
      "botToken": "optional_bot_framework_token",
      "dmPolicy": "pairing"
    }
  }
}
```

**环境变量（向后兼容）**：

```
TEAMS_WEBHOOK_URL=https://outlook.office.com/webhook/xxx
TEAMS_BOT_TOKEN=optional_bot_framework_token
```

### SMS 短信

短信通道支持 Twilio（国际）和阿里云短信（国内）两种服务商。

#### Twilio 配置

```json5
{
  "channels": {
    "sms": {
      "enabled": true,
      "provider": "twilio",
      "accountSid": "ACxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx",
      "authToken": "your_auth_token",
      "fromNumber": "+12345678901",
      "dmPolicy": "open"
    }
  }
}
```

#### 阿里云短信配置

```json5
{
  "channels": {
    "sms": {
      "enabled": true,
      "provider": "aliyun",
      "accountSid": "LTAI5txxxxxxxxxxxxxxxx",   // AccessKey ID
      "authToken": "your_access_secret",          // AccessKey Secret
      "fromNumber": "段先生",                       // 短信签名名称
      "dmPolicy": "open"
    }
  }
}
```

**环境变量（向后兼容）**：

```
SMS_PROVIDER=twilio            # twilio | aliyun
TWILIO_ACCOUNT_SID=ACxxx
TWILIO_AUTH_TOKEN=xxx
TWILIO_FROM_NUMBER=+12345678901
ALIYUN_SMS_ACCESS_KEY=LTAI5txxxx
ALIYUN_SMS_SECRET=xxx
ALIYUN_SMS_SIGN_NAME=段先生
```

> 注：阿里云短信需配合 `@alicloud/dysmsapi20170525` SDK 进行签名，
> 当前实现为占位，生产环境建议补充 SDK 调用。

### QQ 机器人

QQ 通道基于 QQ 开放平台 Bot API，通过 Webhook 接收事件。

#### 前置条件

1. 打开 [QQ 开放平台](https://q.qq.com/)
2. 创建机器人 → 获取 **Bot Token**
3. 配置事件订阅 Webhook URL

#### 配置

```json5
{
  "channels": {
    "qq": {
      "enabled": true,
      "botToken": "your_qq_bot_token",
      "webhookUrl": "https://api.sgroup.qq.com/...",
      "dmPolicy": "pairing"
    }
  }
}
```

**环境变量（向后兼容）**：

```
QQ_BOT_TOKEN=your_qq_bot_token
QQ_WEBHOOK_URL=https://api.sgroup.qq.com/...
```

### 微信公众号

微信公众号通道通过服务器配置验证 + 客服消息接口收发消息。

#### 前置条件

1. 登录 [微信公众平台](https://mp.weixin.qq.com/)
2. 左侧菜单 → 开发 → 基本配置
3. 获取 **AppID** 和 **AppSecret**
4. 服务器配置：
   - URL：`http://your-server:3001/api/bridge/webhook/wechat_oa`
   - Token：自定义字符串（与配置一致）
   - EncodingAESKey：可选，消息加解密密钥
5. 确保公众号已通过认证（客服消息接口需认证服务号）

#### 配置

```json5
{
  "channels": {
    "wechat_oa": {
      "enabled": true,
      "appId": "wx1234567890abcdef",
      "appSecret": "your_app_secret",
      "token": "your_custom_token",
      "encodingAesKey": "optional_encoding_aes_key",
      "dmPolicy": "pairing"
    }
  }
}
```

**环境变量（向后兼容）**：

```
WECHAT_OA_APP_ID=wx1234567890abcdef
WECHAT_OA_APP_SECRET=your_app_secret
WECHAT_OA_TOKEN=your_custom_token
WECHAT_OA_ENCODING_AES_KEY=optional_encoding_aes_key
```

## 环境变量

系统从以下来源读取环境变量（优先级从高到低）：
1. 进程环境变量
2. `.env` 文件（项目根目录）
3. `~/.duan/.env`（全局回退）

### AI 模型 API Key

```
# 国内提供商
DEEPSEEK_API_KEY=sk-xxx               # DeepSeek（推荐）
ALIYUN_API_KEY=sk-xxx                  # 阿里通义千问
ZHIPU_API_KEY=xxx                      # 智谱 GLM
SILICONFLOW_API_KEY=sk-xxx             # SiliconFlow
DOUBAO_API_KEY=xxx                     # 字节豆包
MINIMAX_API_KEY=xxx                    # MiniMax

# 国际提供商
OPENAI_API_KEY=sk-xxx                  # OpenAI
ANTHROPIC_API_KEY=sk-ant-xxx           # Anthropic Claude
GOOGLE_API_KEY=xxx                     # Google Gemini

# 聚合平台
OPENROUTER_API_KEY=sk-xxx              # OpenRouter
GROQ_API_KEY=gsk_xxx                   # Groq

# 本地模型
OLLAMA_BASE_URL=http://localhost:11434  # Ollama
```

### 通道凭证（向后兼容）

```
SLACK_BOT_TOKEN=xoxb-xxx
DISCORD_WEBHOOK=https://discord.com/api/webhooks/xxx
TELEGRAM_BOT_TOKEN=123:abc
WECOM_KEY=xxx
FEISHU_WEBHOOK=https://open.feishu.cn/open-apis/bot/v2/hook/xxx
DINGTALK_WEBHOOK=https://oapi.dingtalk.com/robot/send?access_token=xxx
SMTP_HOST=smtp.example.com
SMTP_PORT=465
SMTP_USER=user@example.com
SMTP_PASS=xxx
SMTP_FROM=bot@example.com

# WhatsApp
WHATSAPP_PHONE_NUMBER_ID=1234567890
WHATSAPP_ACCESS_TOKEN=EAAG...
WHATSAPP_VERIFY_TOKEN=your_verify_token

# Microsoft Teams
TEAMS_WEBHOOK_URL=https://outlook.office.com/webhook/xxx
TEAMS_BOT_TOKEN=optional

# SMS 短信
SMS_PROVIDER=twilio            # twilio | aliyun
TWILIO_ACCOUNT_SID=ACxxx
TWILIO_AUTH_TOKEN=xxx
TWILIO_FROM_NUMBER=+12345678901
ALIYUN_SMS_ACCESS_KEY=LTAI5txxxx
ALIYUN_SMS_SECRET=xxx
ALIYUN_SMS_SIGN_NAME=段先生

# QQ 机器人
QQ_BOT_TOKEN=xxx
QQ_WEBHOOK_URL=https://api.sgroup.qq.com/...

# 微信公众号
WECHAT_OA_APP_ID=wx1234567890abcdef
WECHAT_OA_APP_SECRET=xxx
WECHAT_OA_TOKEN=xxx
WECHAT_OA_ENCODING_AES_KEY=optional
```

> 推荐使用 `~/.duan/config.json` 的 `channels.*` 结构配置通道，
> 环境变量仅作为向后兼容的备用方式。

## 安全配置

```json5
{
  "auth": {
    "enabled": true,
    "apiKeys": ["key1", "key2"],
    "rateLimit": {
      "maxRequests": 100,
      "windowMs": 60000
    }
  }
}
```

## 配置热加载

系统监控 `~/.duan/config.json` 的文件变化，自动应用配置更新。

```bash
# 查看当前配置
/channels           # 查看通道状态

# 通过 CLI 查看配置
/config             # 查看全部配置
```

## 迁移指南

### 从 v1.x 迁移

v2.0 自动迁移旧版配置：
- 读取 `config.json` / `duan-config.json`
- 迁移到 `~/.duan/config.json` 统一格式
- API Key 自动加密（AES-256-GCM）

```bash
# 强制重新迁移
npm run dev -- --migrate
```
