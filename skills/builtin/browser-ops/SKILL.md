---
name: browser-ops
id: browser-ops
domain: automation
description: 浏览器自动化操作，支持网页浏览、表单填写、数据抓取
keywords:
  - 浏览器
  - 网页
  - browser
  - chrome
  - 自动化
  - 爬虫
  - 抓取
examples:
  - 打开浏览器访问 GitHub
  - 自动填写登录表单
  - 抓取网页表格数据
---

# 浏览器操作技能

## 适用场景
- 网页自动化操作
- 数据抓取
- 表单自动填写
- 网页截图

## 执行步骤
1. 使用 browser_operate 打开目标 URL
2. 定位页面元素（CSS selector / XPath）
3. 执行操作（点击、输入、截图）
4. 提取页面数据

## 支持的操作
- navigate: 导航到 URL
- click: 点击元素
- type: 输入文本
- screenshot: 截图
- extract: 提取内容
- scroll: 滚动页面
