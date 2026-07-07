/**
 * 记忆能力测试套件 (D6 memory)
 *
 * 两个 caseId 与 dimensions.ts 指标 id 一一对应：
 *   - recall_precision_at_5 : 召回精确率@5（存 10 条，检索 top5 中相关比例）
 *   - association_coverage  : 关联覆盖率（仅靠 tag 关联可检索的查询比例）
 *
 * 使用 tmpDir + MemoryOrchestrator 实例进行真实存储/检索测试，
 * 每次运行创建独立临时目录，结束后清理，不污染全局记忆。
 *
 * 评分契约：suite 返回的 score 字段 = 比率（0-1），由 assessor.computeScore() 归一化。
 */

import * as fs from 'fs/promises';
import * as path from 'path';
import * as os from 'os';
import { MemoryOrchestrator } from '../../memory-orchestrator.js';
import type { CapabilityTestSuite } from '../types.js';

// ============ recall_precision_at_5：召回精确率@5 ============

/**
 * 构造场景：存 10 条记忆，5 条与"数据库优化"相关、5 条与"前端布局"相关。
 * 用 "数据库索引优化" 检索 top5，统计 top5 中属于"数据库"主题的比例。
 */
async function scoreRecallPrecisionAt5(tmpDir: string): Promise<number> {
  const mo = new MemoryOrchestrator(tmpDir);

  const dbItems = [
    '数据库索引优化：联合索引遵循最左前缀原则',
    '慢查询分析：用 EXPLAIN 查看执行计划定位全表扫描',
    'MySQL 主从复制延迟排查：检查 binlog 写入速度与网络',
    '数据库连接池配置：max_connections 与连接超时调优',
    'SQL 注入防护：参数化查询与预编译语句',
  ];
  const feItems = [
    '前端布局：Flexbox 与 Grid 的适用场景对比',
    'React 渲染优化：useMemo 与 useCallback 避免不必要重渲染',
    'CSS 动画性能：transform 与 opacity 触发合成层',
    '前端路由：React Router 懒加载与代码分割',
    '响应式设计：媒体查询与 rem 单位适配',
  ];

  for (const content of dbItems) {
    await mo.store(content, { tags: ['数据库', '优化'], importance: 7 });
  }
  for (const content of feItems) {
    await mo.store(content, { tags: ['前端', '布局'], importance: 5 });
  }

  const results = await mo.search('数据库索引优化', { topK: 5, useVector: false });

  const dbKeywords = ['数据库', '索引', '查询', 'SQL', 'MySQL', '连接池', '慢查询'];
  let relevant = 0;
  for (const r of results.slice(0, 5)) {
    if (dbKeywords.some(kw => r.content.includes(kw))) relevant++;
  }
  return relevant / 5;
}

// ============ association_coverage：关联覆盖率 ============

/**
 * 构造场景：存若干条记忆，其中查询词仅出现在 tags 中、不在 content 中。
 * 若检索仍能召回这些条目，说明 tag 关联生效。
 *
 * 三条查询，每条对应一个仅在 tag 中出现的关键词：
 *   "缓存"  → item content 不含"缓存"但 tag 含"缓存"
 *   "数据库" → item content 不含"数据库"但 tag 含"数据库"
 *   "高性能" → item content 不含"高性能"但 tag 含"高性能"
 */
async function scoreAssociationCoverage(tmpDir: string): Promise<number> {
  const mo = new MemoryOrchestrator(tmpDir);

  // content 刻意不含查询关键词，仅靠 tag 关联
  await mo.store('Redis 持久化 RDB 与 AOF 配置对比', { tags: ['redis', '缓存'], importance: 7 });
  await mo.store('MySQL 主从复制架构部署文档', { tags: ['复制', '数据库'], importance: 7 });
  await mo.store('Nginx 负载均衡 upstream 配置', { tags: ['运维', '高性能'], importance: 7 });
  // 干扰项
  await mo.store('前端 React 组件库选型', { tags: ['前端', 'UI'], importance: 4 });
  await mo.store('Git 分支管理策略', { tags: ['工具', '协作'], importance: 4 });

  const queries = ['缓存', '数据库', '高性能'];
  let found = 0;
  for (const q of queries) {
    const results = await mo.search(q, { topK: 5, useVector: false });
    // 检查结果中是否有通过 tag 关联召回的条目（content 不含查询词但被召回）
    const associated = results.some(r => !r.content.includes(q));
    if (associated) found++;
  }
  return found / queries.length;
}

// ============ 套件实例 ============

const memorySuite: CapabilityTestSuite = {
  dimension: 'memory',
  name: '记忆能力测试套件',
  async run(): Promise<Array<{ caseId: string; score: number; raw?: unknown }>> {
    const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'jws-cap-mem-'));
    try {
      const precision = await scoreRecallPrecisionAt5(tmpDir);
      const coverage = await scoreAssociationCoverage(tmpDir);
      return [
        { caseId: 'recall_precision_at_5', score: precision, raw: { stored: 10, topK: 5 } },
        { caseId: 'association_coverage', score: coverage, raw: { queries: 3 } },
      ];
    } finally {
      await fs.rm(tmpDir, { recursive: true, force: true });
    }
  },
};

export default memorySuite;
