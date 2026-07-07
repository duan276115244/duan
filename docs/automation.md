# 自动化

段先生提供多层自动化能力，从简单的定时任务到复杂的自主进化系统。

## 自进化系统 (Self-Evolve)

系统能够自主分析代码质量、发现改进点并自动应用修复。

### 触发方式

```bash
# 手动触发
/evolve check          # 检查代码问题
/evolve apply          # 应用推荐的修复
/evolve status         # 查看进化状态
/evolve history        # 查看历史进化记录
```

### 质量门 (Quality Gates)

每次修改前自动检查：

| 门控 | 检查项 | 通过标准 |
|---|---|---|
| 类型检查 | `tsc --noEmit` | 无编译错误 |
| 无新 any | 统计 `any` 关键字 | ≤ 5 处 |
| 文件大小 | 文件长度 | < 50000 字符 |
| 无占位符 | TODO/FIXME | 无新增 |
| 括号平衡 | `{` 和 `}` 计数 | 数量相等 |

### 备份机制

每次修改前自动创建备份文件：
```
agent-loop.ts.evolve.backup.1718612345678
```

保留最近 5 个备份，旧备份自动清理。

```bash
# 查看进化报告
/evolve report
```

输出示例：
```
🧬 自进化报告

总周期: 12 | 动作: 32 | 成功率: 87.5% | 最后: 2分钟前

周期 #a1b2c3: 修复3个类型错误
  ✅ [fix_issue] 替换 any 类型为 unknown
  ✅ [fix_issue] 添加空 catch 错误日志
  🔧 [refactor] 提取公共函数

最近学习经验:
  - shell_execute 在 Windows 上需要 shell:true
  - browser_operate 中文选择器需转 XPath
```

### 自动进化流程

```
1. 代码扫描 → 发现改进点
2. 质量评估 → 通过质量门
3. 创建备份 → .evolve.backup.TIMESTAMP
4. 应用修改 → 写入文件
5. 运行测试 → 验证不破坏现有功能
6. 提交 Git → 创建快照分支
7. 记录日志 → 存入进化历史
```

## 定时任务 (Cron)

通过 Webhook 服务支持定时触发任务。

### Webhook 事件类型

| 事件 | 说明 | 用途 |
|---|---|---|
| `ci_complete` | CI 构建完成 | 自动部署 |
| `ci_failure` | CI 构建失败 | 通知开发 |
| `pr_opened` | PR 创建 | 自动审查 |
| `pr_updated` | PR 更新 | 重新审查 |
| `pr_merged` | PR 合并 | 清理分支 |
| `push` | 代码推送 | 触发工作流 |
| `deploy` | 部署事件 | 健康检查 |

### 配置 Webhook

```json5
// ~/.duan/config.json
{
  "webhook": {
    "enabled": true,
    "port": 3002,
    "token": "webhook_secret_token",
    "allowedSources": ["github.com", "gitlab.com"],
    "autoActions": {
      "ci_failure": "analyze_and_fix",
      "pr_opened": "auto_review"
    }
  }
}
```

### GitHub Webhook 配置

1. 仓库 → Settings → Webhooks → Add webhook
2. Payload URL: `http://your-server:3002/webhooks/github`
3. Content type: `application/json`
4. Secret: `webhook_secret_token`
5. Events: 按需选择（Pull requests, Pushes, CI 等）

## 自愈系统 (Self-Healing)

系统能够自动检测并修复常见运行错误。

### 自动修复模式

| 错误类型 | 自动修复策略 |
|---|---|
| API 余额不足 | 切换到备用 Provider |
| API Key 无效 | 提示重新配置 |
| 请求超时 | 减少输入、切换更快模型 |
| 文件不存在 | 检查路径、使用绝对路径 |
| 网络连接失败 | 检查防火墙、重试 |
| 死循环检测 | 强制切换策略（最多 8 次） |

## 记忆与学习

### 持续学习

系统从每次交互中学习，经验跨会话保留。

```bash
# 查看学习经验
/lessons list

# 查看长期记忆
/memory search 关键词

# 查看知识图谱
/knowledge status
```

### 会话记忆回放

系统会定期回顾过去的成功经验，在新任务中复用：

```
💭 从记忆中检索到相关策略：
  - 上次处理类似任务时使用了 web_search + browser_operate 组合
  - 成功率为 92%，推荐采用相同方案
```

## 通道健康监控

每个消息通道都有心跳检测机制：

```json5
{
  "channels": {
    "telegram": {
      "heartbeat": {
        "enabled": true,
        "intervalMs": 300000,    // 5 分钟
        "to": "owner_telegram_id",
        "prompt": "HEARTBEAT"
      }
    }
  }
}
```

查看所有通道健康状态：

```bash
/channels
```

输出：
```
📡 通道状态
总数: 4 | 已启用: 3 | 运行中: 2 | 健康: 2

✅ feishu      飞书       healthy   uptime: 15m   msgs: 23  errs: 0
✅ telegram   Telegram   healthy   uptime: 15m   msgs: 45  errs: 0
⚠️ wecom       企业微信   degraded uptime: 15m   msgs: 3   errs: 1
⏹️ discord   Discord    stopped   uptime: -     msgs: 0   errs: 0
```

## 代理团队协作

支持多智能体协作完成复杂任务：

```
/team create "开发新功能"
/team add task1 "设计数据库模型"
/team add task2 "实现 API 接口"
/team add task3 "编写前端页面"
/team status
```

每个子任务可以由独立 Agent 执行，结果汇总到主 Agent。
