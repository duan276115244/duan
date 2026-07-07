# 使用指南

## 启动方式

### CLI 模式（终端）

```bash
npm run dev
```

启动后显示交互式 TUI 界面，包含：
- 模型选择与状态
- 反应模式级别显示
- 工具调用实时日志
- 多轮对话

### Web 模式（浏览器）

```bash
npm run dev:web-server
# 浏览器打开 http://localhost:3001
```

Web 控制台提供：
- 聊天界面
- 配置管理
- 通道状态查看

### Electron 桌面模式

```bash
npm run dev:desktop
```

桌面应用提供：
- 原生窗口管理
- 系统托盘
- 快捷键支持

## 聊天命令

在对话中输入 `/` 前缀命令：

| 命令 | 别名 | 说明 |
|---|---|---|
| `/help` | `/帮助` | 显示帮助菜单 |
| `/status` | `/状态` | 系统状态概览 |
| `/channels` | - | 查看所有消息通道健康状态 |
| `/model` | `/模型` | 切换 AI 模型 |
| `/mode` | - | 切换模式: reactive / proactive / strategic / creative |
| `/setup` | `/配置` | 运行配置向导 |
| `/auto` | - | 切换自动模式 |
| `/think` | - | 触发深度思考 |
| `/clear` | - | 清除对话历史 |

### 示例

```
> /status
  🟢 系统状态
  模型: deepseek-chat | 提供商: deepseek
  模式: reactive | 自动: 开
  轮次: 0 | 运行时间: 5m

> /channels
  📡 通道状态
  总数: 4 | 已启用: 3 | 运行中: 2 | 健康: 2
  ✅ feishu      飞书       healthy   uptime: 15m   msgs: 23  errs: 0
  ✅ telegram   Telegram   healthy   uptime: 15m   msgs: 45  errs: 0
  ⚠️ wecom       企业微信   degraded uptime: 15m   msgs: 3   errs: 1
     最近错误: 回调验证失败
  ⏹️ discord   Discord    stopped   uptime: -     msgs: 0   errs: 0

> /model deepseek-chat
  ✅ 模型已切换为: deepseek-chat
```

## 核心交互模式

### 反应模式 (Reactive)
默认模式。AI 等待用户输入后响应，适用于日常对话式任务。

### 主动模式 (Proactive)
AI 会主动提出建议、检查状态、执行例行任务。
启用：`/mode proactive`

### 战略模式 (Strategic)
AI 会进行深度分析，制定多步计划后执行。
启用：`/mode strategic`

### 创意模式 (Creative)
AI 开启发散思维，适合头脑风暴、创意生成。
启用：`/mode creative`

## 任务执行

段先生的核心能力是自主执行复杂任务。你可以直接描述需求：

```
给我用豆包生成一个80年代的怀旧视频，自己想办法完成任务
```

系统会自动：
1. **分析任务** — 理解目标、识别约束
2. **制定计划** — 分解为可执行步骤
3. **执行工具** — 浏览器操作、API 调用、文件读写等
4. **验证结果** — 检查输出质量
5. **反思总结** — 提取经验存入记忆

### 执行计划审批

对于复杂任务，系统会生成执行计划供你审查：

```
📋 执行计划
◇ 1. 搜索80年代怀旧风格的视觉元素
◇ 2. 优化视频生成提示词
◇ 3. 打开豆包网页版
◇ 4. 检查登录状态
◇ 5. 输入提示词触发生成
◇ 6. 等待生成完成
◇ 7. 下载视频
◇ 8. 验证结果

? 是否批准此计划？ (Y/n)
```

## 内存系统

段先生具有多层记忆系统：

| 层级 | 范围 | 持久性 | 用途 |
|---|---|---|---|
| L1 工作记忆 | 当前会话 | 临时 | 对话上下文 |
| L2 短期记忆 | 最近任务 | 24h | 近期交互 |
| L3 长期记忆 | 跨会话 | 持久 | 用户偏好、关键事实 |
| L4 程序记忆 | 技能/SOP | 持久 | 可复用工作流 |

```
# 查看记忆
/memory search 关键词

# 查看技能库
/self_skills list
```

## 故障排除

### 浏览器操作失败

```
问题: browser_operate 报 XPath 语法错误
原因: 中文文本被直接作为 XPath 表达式
解决: v15.0 已修复，更新到最新版本即可
```

### 命令执行失败

```
问题: shell_execute 报 ENOENT
原因: Windows 缺少 shell 路径配置
解决: v15.0 已自动添加 cmd.exe 路径
```

### 死循环检测

当系统检测到同一工具连续失败 5 次，会自动切换策略：
```
⚠️ 检测到死循环: browser_operate 连续失败 5 次。
🔄 切换策略: 工具替代法
建议使用替代工具: screen_capture, screen_click
```

最多尝试 8 种策略后会自动终止。
