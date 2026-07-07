# 技能与工具

段先生拥有 25+ 内置工具和动态技能萃取系统，对标 ClawHub 的 Skill Registry 体系。

## 工具系统架构

```
                      UnifiedToolRegistry
                    (统一工具注册中心)
                           │
           ┌───────────────┼───────────────┐
           │               │               │
     Built-in Tools    Dynamic Tools    Skill Tools
     (25+ 内置)       (AI 运行时创建)   (技能封装)
```

## 内置工具参考

### 浏览器操作

| 工具 | 说明 | 只读 |
|---|---|---|
| `browser_operate` | 交互式浏览器操控 (goto/click/type/screenshot/evaluate) | 否 |

操作列表：
- `goto` — 导航到 URL
- `click` — 点击元素（支持 CSS 选择器、XPath、文本匹配）
- `type` — 输入文本
- `screenshot` — 页面截图
- `extract` — 提取页面文本
- `info` — 页面信息（标题、URL、Cookie 数）
- `wait` — 等待元素出现
- `wait_for_change` — 等待页面变化
- `press` — 按键
- `evaluate` — 执行 JS

> **v15.0 改进**：`click` 和 `type` 操作已修复中文文本作为选择器时的 XPath 错误。

### Shell 命令

| 工具 | 说明 | 只读 |
|---|---|---|
| `shell_execute` | 在指定目录执行 Shell/PowerShell 命令 | 否 |
| `current_time` | 获取当前时间 | 是 |

> **v15.0 改进**：Windows 下自动使用 `cmd.exe` 作为 shell，修复 ENOENT 错误。

### 文件操作

| 工具 | 说明 | 只读 |
|---|---|---|
| `file_read` | 读取文件内容 | 是 |
| `file_write` | 写入/覆盖文件 | 否 |
| `file_edit` | 编辑文件（精确替换） | 否 |
| `file_delete` | 删除文件 | 否 |
| `file_list` | 列出目录内容 | 是 |
| `file_search` | 搜索文件 | 是 |

### 网络工具

| 工具 | 说明 | 只读 |
|---|---|---|
| `web_search` | 网络搜索（DuckDuckGo） | 是 |
| `web_fetch` | 抓取网页内容 | 是 |

### 桌面控制

| 工具 | 说明 | 只读 |
|---|---|---|
| `screen_capture` | 截图 | 是 |
| `screen_analyze` | 视觉分析截图 | 是 |
| `screen_click` | 点击屏幕坐标 | 否 |
| `screen_type` | 键盘输入 | 否 |
| `screen_key` | 按键 | 否 |
| `screen_open` | 打开应用/文件/URL | 否 |
| `screen_scroll` | 滚动 | 否 |
| `screen_ocr` | 屏幕 OCR | 是 |
| `computer_use` | 自主桌面代理 | 否 |

### 代码工具

| 工具 | 说明 | 只读 |
|---|---|---|
| `code_generate` | 生成代码 | 否 |
| `code_review` | 审查代码 | 是 |
| `code_edit` | 编辑代码文件 | 否 |

### 计划管理

| 工具 | 说明 | 只读 |
|---|---|---|
| `create_plan` | 创建多步执行计划 | 否 |
| `update_plan_step` | 更新计划步骤状态 | 否 |
| `get_plan` | 查看计划进度 | 是 |
| `list_plans` | 查看所有计划 | 是 |
| `complete` | 标记任务完成 | 否 |

> **v15.0 改进**：`complete` 工具修复了无限循环问题，调用后立即终止执行轮次。

### 通知与集成

| 工具 | 说明 | 只读 |
|---|---|---|
| `notification_send` | 发送通知 | 否 |
| `notification_history` | 查看通知历史 | 是 |
| `notification_configure` | 配置通知通道 | 否 |
| `webhook_trigger` | 触发 Webhook | 否 |
| `webhook_configure` | 配置 Webhook | 否 |

### 第三方服务

| 工具 | 说明 |
|---|---|
| `service_slack` | Slack 消息 |
| `service_discord` | Discord 消息 |
| `service_github` | GitHub 操作 |
| `service_notion` | Notion 操作 |
| `service_feishu` | 飞书消息 |
| `service_wecom` | 企业微信消息 |
| `service_email` | 发送邮件 |
| `service_broadcast` | 全通道广播 |

### 技能与自省

| 工具 | 说明 |
|---|---|
| `self_skills` | 查看/萃取技能（list/stats/extract/context） |
| `self_tool_framework` | 统一工具框架管理 |
| `self_assessment` | 自我评估 |
| `think` | 深度思考推理 |

### Git 工具

| 工具 | 说明 |
|---|---|
| `git_status` | Git 状态 |
| `git_diff` | Git 差异 |
| `git_commit` | 创建提交 |
| `git_push` | 推送 |
| `git_log` | 提交历史 |

## 技能系统

### 内置技能

系统预注册 11+ 个技能，通过 `SkillRegistry` 管理：

| 技能 | 领域 | 说明 |
|---|---|---|
| `code_generate` | development | 代码生成 |
| `code_review` | development | 代码审查 |
| `code_refactor` | development | 代码重构 |
| `data_analyze` | data | 数据分析 |
| `security_scan` | security | 安全扫描 |
| `devops_deploy` | devops | 部署配置 |
| `research_analyze` | research | 研究分析 |
| `writing_doc` | writing | 文档编写 |
| `math_compute` | math | 数学计算 |
| `arch_design` | design | 架构设计 |

### 技能萃取

AI 在执行任务时可以自动萃取可复用的技能：

```
> 帮我重构这个模块

[系统自动萃取技能]
✅ 技能 "code_refactor" 已萃取，当前共 12 个技能
```

手动萃取：

```
> /self_skills extract name=my_skill description="..." category=development
```

查看技能：

```
> /self_skills list
  ✅ code_generate [development] (342次成功, 5次失败)
  ✅ code_review [development] (98次成功, 2次失败)
  ✅ data_analyze [data] (67次成功, 3次失败)
  ...
```

### 前端技能管理

打开 Web 控制台的"技能管理"页面，可以：
- 查看所有技能及其成功率和使用次数
- 查看技能详情和质量报告
- 回滚技能到历史版本
