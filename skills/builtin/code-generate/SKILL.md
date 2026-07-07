---
name: code-generate
id: code-generate
domain: coding
description: 根据需求描述生成高质量代码，支持多种编程语言和框架
keywords:
  - 生成代码
  - 写代码
  - 编程
  - 实现
  - 开发
  - code
  - generate
  - implement
examples:
  - 帮我写一个 Python 脚本读取 Excel 文件
  - 实现一个 React 登录表单组件
  - 用 Go 写一个 HTTP 服务器
---

# 代码生成技能

## 适用场景
- 根据自然语言描述生成代码
- 实现特定功能或算法
- 创建项目脚手架

## 执行步骤
1. 分析需求，确定语言和框架
2. 使用 file_write 工具创建代码文件
3. 使用 shell_execute 工具验证代码可运行
4. 如有错误，使用 fix-tools 自动修复

## 输出规范
- 代码文件保存到合适目录
- 包含必要的注释和文档
- 遵循语言最佳实践
