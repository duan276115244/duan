---
name: shell-exec
id: shell-exec
domain: system
description: 执行 Shell 命令，支持系统管理、软件安装、进程管理
keywords:
  - 执行命令
  - shell
  - 命令行
  - 终端
  - terminal
  - cmd
  - powershell
examples:
  - 执行 npm install
  - 查看系统进程
  - 安装 Python 包
---

# Shell 执行技能

## 适用场景
- 系统管理操作
- 软件安装和配置
- 进程管理
- 脚本执行

## 执行步骤
1. 分析任务确定需要的命令
2. 使用 shell_execute 执行命令
3. 检查命令输出和退出码
4. 如有错误，分析原因并重试

## 安全规范
- 危险命令需要确认（rm -rf, format 等）
- 不执行未知来源的脚本
- 敏感操作先备份
