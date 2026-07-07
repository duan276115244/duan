---
name: desktop-ops
id: desktop-ops
domain: automation
description: 桌面应用操作，支持打开应用、窗口管理、跨软件操作
keywords:
  - 桌面操作
  - 打开应用
  - 窗口管理
  - desktop
  - 应用操作
examples:
  - 打开 VSCode
  - 操作微信发送消息
  - 打开 Excel 处理表格
---

# 桌面操作技能

## 适用场景
- 打开和管理桌面应用
- 跨软件自动化操作
- 窗口管理

## 执行步骤
1. 使用 desktop_open 打开目标应用
2. 使用 desktop_operate 执行操作
3. 验证操作结果

## 支持的应用（24类）
- 浏览器：Chrome/Edge/Firefox
- 编辑器：VSCode/Notepad++/Sublime
- 终端：PowerShell/CMD/Windows Terminal
- 办公：Word/Excel/PowerPoint/Outlook
- 通讯：微信/钉钉/飞书
- 设计：Photoshop/Figma
- 媒体：VLC/Spotify
- 系统：Explorer/Git/Docker/Node.js
