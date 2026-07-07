---
name: file-ops
id: file-ops
domain: system
description: 文件系统操作，包括读写、搜索、批量处理文件
keywords:
  - 文件操作
  - 读取文件
  - 写入文件
  - 搜索文件
  - file
  - 目录
examples:
  - 读取 config.json 文件
  - 搜索所有 .ts 文件
  - 批量重命名文件
---

# 文件操作技能

## 适用场景
- 文件读写
- 目录扫描
- 文件搜索和批量处理

## 执行步骤
1. 使用 list_directory 查看目录结构
2. 使用 file_read 读取文件内容
3. 使用 file_write 写入或修改文件
4. 使用 search_files 搜索文件内容

## 注意事项
- 操作前备份重要文件
- 大文件使用分块读取
- 遵循文件系统权限
