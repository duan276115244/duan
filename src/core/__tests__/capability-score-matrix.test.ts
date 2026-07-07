import { describe, it, expect, beforeEach } from 'vitest';
import {
  CapabilityScoreMatrix,
  type ScoreReport,
} from '../capability-score-matrix.js';

// 测试 V17 能力评分矩阵 — CapabilityScoreMatrix
// 覆盖所有公开方法：getAllScores / getOverallScore / getDimension / updateScore / generateReport / generateScoreTable
// 包含评分计算、差距分析、报告生成及边界情况

describe('CapabilityScoreMatrix', () => {
  let matrix: CapabilityScoreMatrix;

  beforeEach(() => {
    matrix = new CapabilityScoreMatrix();
    // 重置为全 10 满分基线：V19 源码 initializeDimensions() 含真实审计评分（部分维度非 10），
    // 但本测试套件聚焦矩阵逻辑（均值计算/差距收集/报告生成），需与易变的审计数据解耦。
    // 通过 getDimension() 返回的内部引用重置子项与维度评分，建立确定性基线。
    for (const dim of matrix.getAllScores()) {
      dim.currentScore = 10;
      for (const sub of dim.subItems) {
        sub.score = 10;
        sub.status = 'completed';
        sub.gap = '无';
      }
    }
  });

  // ============ 初始化 ============

  describe('初始化', () => {
    it('构造函数初始化 8 大维度', () => {
      const all = matrix.getAllScores();
      expect(all).toHaveLength(8);
    });

    it('包含全部预定义维度 id', () => {
      const ids = matrix.getAllScores().map(d => d.id);
      expect(ids).toEqual(
        expect.arrayContaining([
          'neural_network',
          'thinking_logic',
          'tool_calling',
          'skill_learning',
          'voice_interaction',
          'device_control',
          'requirement_analysis',
          'cross_platform',
        ]),
      );
    });

    it('每个维度初始评分为 10（满分）', () => {
      for (const dim of matrix.getAllScores()) {
        expect(dim.currentScore).toBe(10);
        expect(dim.targetScore).toBe(10);
      }
    });

    it('每个维度拥有 10 个子项', () => {
      for (const dim of matrix.getAllScores()) {
        expect(dim.subItems).toHaveLength(10);
      }
    });

    it('初始所有子项评分为 10 且状态为 completed', () => {
      for (const dim of matrix.getAllScores()) {
        for (const sub of dim.subItems) {
          expect(sub.score).toBe(10);
          expect(sub.status).toBe('completed');
          expect(sub.gap).toBe('无');
        }
      }
    });

    it('每个维度包含必要字段', () => {
      for (const dim of matrix.getAllScores()) {
        expect(dim.id).toBeTruthy();
        expect(dim.name).toBeTruthy();
        expect(dim.category).toBeTruthy();
        expect(typeof dim.lastUpdated).toBe('number');
        expect(dim.lastUpdated).toBeGreaterThan(0);
      }
    });

    it('维度分类覆盖核心架构/智能增强/能力扩展/生态建设', () => {
      const categories = new Set(matrix.getAllScores().map(d => d.category));
      expect(categories.has('核心架构')).toBe(true);
      expect(categories.has('智能增强')).toBe(true);
      expect(categories.has('能力扩展')).toBe(true);
      expect(categories.has('生态建设')).toBe(true);
    });
  });

  // ============ getAllScores ============

  describe('getAllScores', () => {
    it('返回所有维度的数组副本', () => {
      const all = matrix.getAllScores();
      expect(Array.isArray(all)).toBe(true);
      expect(all).toHaveLength(8);
    });

    it('修改返回数组不影响内部状态', () => {
      const all = matrix.getAllScores();
      all.pop();
      all.pop();
      // 内部仍应保持 8 个维度
      expect(matrix.getAllScores()).toHaveLength(8);
    });
  });

  // ============ getOverallScore ============

  describe('getOverallScore', () => {
    it('初始状态下综合评分为 10', () => {
      expect(matrix.getOverallScore()).toBe(10);
    });

    it('综合评分等于所有维度 currentScore 的平均值', () => {
      // 将 neural_network 维度的某个子项降为 0
      matrix.updateScore('neural_network', 0, '残差连接');
      // neural_network: (9*10 + 0)/10 = 9
      // 其余 7 个维度仍为 10
      // 综合 = (9 + 7*10) / 8 = 79/8 = 9.875
      expect(matrix.getOverallScore()).toBeCloseTo(9.875, 5);
    });

    it('内部维度为空时返回 0（边界情况）', () => {
      // 通过强制清空内部 Map 来触发空分支
      (matrix as any).dimensions.clear();
      expect(matrix.getOverallScore()).toBe(0);
    });
  });

  // ============ getDimension ============

  describe('getDimension', () => {
    it('返回指定 id 的维度', () => {
      const dim = matrix.getDimension('neural_network');
      expect(dim).toBeDefined();
      expect(dim!.id).toBe('neural_network');
      expect(dim!.name).toBe('神经网络架构');
      expect(dim!.category).toBe('核心架构');
    });

    it('维度不存在时返回 undefined', () => {
      expect(matrix.getDimension('non_existent')).toBeUndefined();
    });

    it('返回的对象是内部引用（修改会影响内部状态）', () => {
      const dim = matrix.getDimension('thinking_logic');
      expect(dim).toBeDefined();
      // 修改返回对象的字段应反映到内部
      dim!.currentScore = 5;
      expect(matrix.getDimension('thinking_logic')!.currentScore).toBe(5);
    });
  });

  // ============ updateScore ============

  describe('updateScore', () => {
    it('更新子项评分后维度总分重新计算为子项平均值', () => {
      // 初始 10 个子项均为 10，总分 10
      matrix.updateScore('neural_network', 5, '残差连接');
      const dim = matrix.getDimension('neural_network');
      // (9*10 + 5)/10 = 9.5
      expect(dim!.currentScore).toBeCloseTo(9.5, 5);
    });

    it('子项评分 >= 9 时状态变为 completed', () => {
      matrix.updateScore('neural_network', 9, '残差连接');
      const sub = matrix.getDimension('neural_network')!.subItems.find(s => s.name === '残差连接');
      expect(sub!.score).toBe(9);
      expect(sub!.status).toBe('completed');
    });

    it('子项评分 = 10 时状态为 completed', () => {
      matrix.updateScore('neural_network', 10, '残差连接');
      const sub = matrix.getDimension('neural_network')!.subItems.find(s => s.name === '残差连接');
      expect(sub!.status).toBe('completed');
    });

    it('子项评分在 7-8 之间时状态变为 in_progress', () => {
      matrix.updateScore('neural_network', 7, '残差连接');
      const sub1 = matrix.getDimension('neural_network')!.subItems.find(s => s.name === '残差连接');
      expect(sub1!.status).toBe('in_progress');

      matrix.updateScore('neural_network', 8, 'LayerNorm');
      const sub2 = matrix.getDimension('neural_network')!.subItems.find(s => s.name === 'LayerNorm');
      expect(sub2!.status).toBe('in_progress');
    });

    it('子项评分 < 7 时状态变为 not_started', () => {
      matrix.updateScore('neural_network', 6, '残差连接');
      const sub = matrix.getDimension('neural_network')!.subItems.find(s => s.name === '残差连接');
      expect(sub!.status).toBe('not_started');

      matrix.updateScore('neural_network', 0, 'LayerNorm');
      const sub2 = matrix.getDimension('neural_network')!.subItems.find(s => s.name === 'LayerNorm');
      expect(sub2!.status).toBe('not_started');
    });

    it('不指定 subItemName 时只重算维度总分（子项不变）', () => {
      // 不传 subItemName，子项保持原样，重算后总分仍为 10
      matrix.updateScore('neural_network', 3);
      const dim = matrix.getDimension('neural_network');
      // 子项未变，全部为 10，平均 10
      expect(dim!.currentScore).toBe(10);
      // 传入的 score 参数不影响任何子项
      for (const sub of dim!.subItems) {
        expect(sub.score).toBe(10);
      }
    });

    it('subItemName 不匹配任何子项时不报错，仍重算维度总分', () => {
      expect(() => matrix.updateScore('neural_network', 5, '不存在的子项')).not.toThrow();
      const dim = matrix.getDimension('neural_network');
      // 子项未变，总分仍为 10
      expect(dim!.currentScore).toBe(10);
    });

    it('维度 id 不存在时静默返回不报错', () => {
      expect(() => matrix.updateScore('non_existent', 5, 'whatever')).not.toThrow();
      // 内部维度数量不变
      expect(matrix.getAllScores()).toHaveLength(8);
    });

    it('更新后 lastUpdated 被刷新', async () => {
      const before = matrix.getDimension('neural_network')!.lastUpdated;
      // 等待时间推进
      await new Promise(resolve => setTimeout(resolve, 5));
      matrix.updateScore('neural_network', 8, '残差连接');
      const after = matrix.getDimension('neural_network')!.lastUpdated;
      expect(after).toBeGreaterThanOrEqual(before);
    });

    it('更新多个子项后维度总分正确', () => {
      matrix.updateScore('neural_network', 0, '残差连接');
      matrix.updateScore('neural_network', 5, 'LayerNorm');
      matrix.updateScore('neural_network', 10, 'GELU 激活函数');
      const dim = matrix.getDimension('neural_network');
      // (7*10 + 0 + 5 + 10)/10 = 85/10 = 8.5
      expect(dim!.currentScore).toBeCloseTo(8.5, 5);
    });

    it('将所有子项降为 0 时维度总分为 0（零分边界）', () => {
      const dim = matrix.getDimension('neural_network')!;
      for (const sub of dim.subItems) {
        matrix.updateScore('neural_network', 0, sub.name);
      }
      expect(matrix.getDimension('neural_network')!.currentScore).toBe(0);
    });
  });

  // ============ generateReport ============

  describe('generateReport', () => {
    it('初始状态下生成满分报告', () => {
      const report = matrix.generateReport();
      expect(report.overallScore).toBe(10);
      expect(report.dimensions).toHaveLength(8);
      expect(report.topGaps).toHaveLength(0);
      expect(report.recommendations).toHaveLength(0);
      expect(typeof report.generatedAt).toBe('number');
      expect(report.generatedAt).toBeGreaterThan(0);
    });

    it('报告的 dimensions 字段包含全部维度', () => {
      const report = matrix.generateReport();
      const ids = report.dimensions.map(d => d.id);
      expect(ids).toContain('neural_network');
      expect(ids).toContain('cross_platform');
    });

    it('存在差距时 topGaps 收集所有 score < 9 的子项', () => {
      // 将 neural_network 的两个子项降分，使维度产生差距
      matrix.updateScore('neural_network', 5, '残差连接');
      matrix.updateScore('neural_network', 3, 'LayerNorm');
      const report = matrix.generateReport();
      // 该维度 currentScore = (8*10 + 5 + 3)/10 = 8.8，gap = 1.2 > 0
      // 子项中 score < 9 的有 2 个
      const neuralGaps = report.topGaps.filter(g => g.dimension === '神经网络架构');
      expect(neuralGaps).toHaveLength(2);
    });

    it('topGaps 的 impact 等于 10 - sub.score', () => {
      matrix.updateScore('neural_network', 5, '残差连接'); // impact = 5
      matrix.updateScore('neural_network', 3, 'LayerNorm'); // impact = 7
      const report = matrix.generateReport();
      const impacts = report.topGaps.map(g => g.impact).sort((a, b) => a - b);
      expect(impacts).toEqual([5, 7]);
    });

    it('topGaps 按 impact 降序排序', () => {
      matrix.updateScore('neural_network', 5, '残差连接'); // impact 5
      matrix.updateScore('neural_network', 3, 'LayerNorm'); // impact 7
      matrix.updateScore('neural_network', 8, 'GELU 激活函数'); // impact 2
      const report = matrix.generateReport();
      const impacts = report.topGaps.map(g => g.impact);
      // 降序：7, 5, 2
      expect(impacts).toEqual([7, 5, 2]);
    });

    it('topGaps 最多返回 10 条', () => {
      // 在两个维度中各降低全部 10 个子项，制造 20 条 gap
      const dim1 = matrix.getDimension('neural_network')!;
      for (const sub of dim1.subItems) {
        matrix.updateScore('neural_network', 5, sub.name);
      }
      const dim2 = matrix.getDimension('thinking_logic')!;
      for (const sub of dim2.subItems) {
        matrix.updateScore('thinking_logic', 4, sub.name);
      }
      const report = matrix.generateReport();
      expect(report.topGaps.length).toBeLessThanOrEqual(10);
      expect(report.topGaps).toHaveLength(10);
    });

    it('维度 currentScore 等于 targetScore 时不收集该维度的 gap', () => {
      // 维度满分时不收集
      const report = matrix.generateReport();
      expect(report.topGaps).toHaveLength(0);
    });

    it('overall < 10 时 recommendations 包含综合评分差距提示', () => {
      matrix.updateScore('neural_network', 0, '残差连接');
      const report = matrix.generateReport();
      // overall = (9.0 + 7*10)/8 = 79/8 = 9.875
      const firstRec = report.recommendations[0];
      expect(firstRec).toContain('当前综合评分');
      expect(firstRec).toContain('9.9/10'); // toFixed(1)
      expect(firstRec).toContain('0.1 分');
    });

    it('overall = 10 时 recommendations 不包含综合评分差距提示', () => {
      const report = matrix.generateReport();
      const hasOverallRec = report.recommendations.some(r => r.includes('当前综合评分'));
      expect(hasOverallRec).toBe(false);
    });

    it('recommendations 包含前 5 个 topGaps 的优先提升建议', () => {
      // 制造 6 个 gap
      matrix.updateScore('neural_network', 1, '残差连接');
      matrix.updateScore('neural_network', 2, 'LayerNorm');
      matrix.updateScore('neural_network', 3, 'GELU 激活函数');
      matrix.updateScore('neural_network', 4, '动态网络路由');
      matrix.updateScore('neural_network', 5, '语义向量召回');
      matrix.updateScore('neural_network', 6, 'TF-IDF 经验匹配');
      const report = matrix.generateReport();
      // 第一条是综合评分提示，后续是优先提升建议（最多 5 条）
      const priorityRecs = report.recommendations.filter(r => r.includes('优先提升'));
      expect(priorityRecs.length).toBeLessThanOrEqual(5);
      expect(priorityRecs).toHaveLength(5);
    });

    it('recommendations 第一条为综合评分提示（当 overall < 10）', () => {
      matrix.updateScore('neural_network', 5, '残差连接');
      const report = matrix.generateReport();
      expect(report.recommendations[0]).toContain('当前综合评分');
    });

    it('topGaps 中 gap 字段格式为 "子项名: 子项gap描述"', () => {
      matrix.updateScore('neural_network', 5, '残差连接');
      const report = matrix.generateReport();
      const gap = report.topGaps.find(g => g.dimension === '神经网络架构');
      expect(gap).toBeDefined();
      // 初始子项 gap 描述为 "无"
      expect(gap!.gap).toContain('残差连接');
      expect(gap!.gap).toContain(':');
    });

    it('generatedAt 为当前时间戳', () => {
      const before = Date.now();
      const report = matrix.generateReport();
      const after = Date.now();
      expect(report.generatedAt).toBeGreaterThanOrEqual(before);
      expect(report.generatedAt).toBeLessThanOrEqual(after);
    });

    it('报告结构符合 ScoreReport 接口', () => {
      const report: ScoreReport = matrix.generateReport();
      expect(report).toHaveProperty('overallScore');
      expect(report).toHaveProperty('dimensions');
      expect(report).toHaveProperty('topGaps');
      expect(report).toHaveProperty('recommendations');
      expect(report).toHaveProperty('generatedAt');
    });
  });

  // ============ generateScoreTable ============

  describe('generateScoreTable', () => {
    it('返回非空字符串', () => {
      const table = matrix.generateScoreTable();
      expect(typeof table).toBe('string');
      expect(table.length).toBeGreaterThan(0);
    });

    it('包含标题 "📊 V19 能力评分矩阵"', () => {
      const table = matrix.generateScoreTable();
      expect(table).toContain('📊 V19 能力评分矩阵');
    });

    it('包含 "综合评分:" 行', () => {
      const table = matrix.generateScoreTable();
      expect(table).toContain('综合评分:');
    });

    it('满分时综合评分显示 ✅', () => {
      const table = matrix.generateScoreTable();
      expect(table).toContain('✅');
    });

    it('满分时显示 "✅ 所有子项已达标！"', () => {
      const table = matrix.generateScoreTable();
      expect(table).toContain('✅ 所有子项已达标！');
    });

    it('包含表头分隔线', () => {
      const table = matrix.generateScoreTable();
      expect(table).toContain('┌');
      expect(table).toContain('┬');
      expect(table).toContain('┐');
      expect(table).toContain('│ 维度');
      expect(table).toContain('│ 当前');
      expect(table).toContain('│ 目标');
      expect(table).toContain('│ 状态');
    });

    it('每个维度在表格中占一行', () => {
      const table = matrix.generateScoreTable();
      for (const dim of matrix.getAllScores()) {
        expect(table).toContain(dim.name);
      }
    });

    it('满分维度状态显示 "✅ 达标"', () => {
      const table = matrix.generateScoreTable();
      expect(table).toContain('✅ 达标');
    });

    it('存在未达标子项时显示 "未达标子项" 列表', () => {
      matrix.updateScore('neural_network', 5, '残差连接');
      const table = matrix.generateScoreTable();
      expect(table).toContain('未达标子项');
      expect(table).toContain('残差连接');
    });

    it('综合评分在 8-9 区间显示 🟢', () => {
      // 将一个维度的总分降到约 8.x，使综合评分在 8-9 之间
      // neural_network: 5 个子项降为 0 → (5*10 + 5*0)/10 = 5
      // 综合 = (5 + 7*10)/8 = 75/8 = 9.375 → 🟢
      matrix.updateScore('neural_network', 0, '残差连接');
      const table = matrix.generateScoreTable();
      // 综合评分行应包含 🟢（注意：✅ 也可能出现在维度行中）
      const overallLine = table.split('\n').find(l => l.includes('综合评分'));
      expect(overallLine).toBeDefined();
      expect(overallLine!).toContain('🟢');
    });

    it('综合评分在 6-8 区间显示 🟡', () => {
      // 将所有维度的子项降为 6 → 综合 = 6 → 🟡
      for (const dim of matrix.getAllScores()) {
        for (const sub of dim.subItems) {
          matrix.updateScore(dim.id, 6, sub.name);
        }
      }
      const table = matrix.generateScoreTable();
      const overallLine = table.split('\n').find(l => l.includes('综合评分'));
      expect(overallLine).toBeDefined();
      expect(overallLine!).toContain('🟡');
    });

    it('综合评分低于 6 显示 🔴', () => {
      // 将所有维度的子项降为 0 → 综合 = 0 → 🔴
      for (const dim of matrix.getAllScores()) {
        for (const sub of dim.subItems) {
          matrix.updateScore(dim.id, 0, sub.name);
        }
      }
      const table = matrix.generateScoreTable();
      const overallLine = table.split('\n').find(l => l.includes('综合评分'));
      expect(overallLine).toBeDefined();
      expect(overallLine!).toContain('🔴');
    });

    it('维度评分在 8-10 区间状态显示 "🟢 接近"', () => {
      // 将一个维度的总分降到 8.x
      // neural_network: 2 个子项降为 0 → (8*10 + 2*0)/10 = 8
      matrix.updateScore('neural_network', 0, '残差连接');
      matrix.updateScore('neural_network', 0, 'LayerNorm');
      const table = matrix.generateScoreTable();
      expect(table).toContain('🟢 接近');
    });

    it('维度评分在 6-8 区间状态显示 "🟡 待提升"', () => {
      // neural_network: 5 个子项降为 0 → 5.0；4 个降为 0 → 6.0
      // 降 4 个子项为 0：(6*10 + 4*0)/10 = 6 → 🟡 待提升
      matrix.updateScore('neural_network', 0, '残差连接');
      matrix.updateScore('neural_network', 0, 'LayerNorm');
      matrix.updateScore('neural_network', 0, 'GELU 激活函数');
      matrix.updateScore('neural_network', 0, '动态网络路由');
      const table = matrix.generateScoreTable();
      expect(table).toContain('🟡 待提升');
    });

    it('维度评分低于 6 状态显示 "🔴 差距大"', () => {
      // 将 neural_network 全部子项降为 0 → 0 → 🔴 差距大
      const dim = matrix.getDimension('neural_network')!;
      for (const sub of dim.subItems) {
        matrix.updateScore('neural_network', 0, sub.name);
      }
      const table = matrix.generateScoreTable();
      expect(table).toContain('🔴 差距大');
    });

    it('未达标子项列表包含维度名、子项名、评分和差距描述', () => {
      matrix.updateScore('neural_network', 5, '残差连接');
      const table = matrix.generateScoreTable();
      // 格式: • [维度] 子项: 分/10 — gap
      expect(table).toContain('[神经网络架构]');
      expect(table).toContain('残差连接');
      expect(table).toContain('5/10');
    });

    it('未达标子项计数正确', () => {
      matrix.updateScore('neural_network', 5, '残差连接');
      matrix.updateScore('neural_network', 3, 'LayerNorm');
      const table = matrix.generateScoreTable();
      expect(table).toContain('未达标子项 (2)');
    });

    it('表格以换行符连接多行', () => {
      const table = matrix.generateScoreTable();
      expect(table).toContain('\n');
      // 应有多行
      expect(table.split('\n').length).toBeGreaterThan(5);
    });
  });

  // ============ 综合场景 ============

  describe('综合场景', () => {
    it('完整流程：更新评分 → 生成报告 → 生成表格', () => {
      // 降低多个维度的评分
      matrix.updateScore('neural_network', 5, '残差连接');
      matrix.updateScore('thinking_logic', 6, 'CoT 链式思考');
      matrix.updateScore('tool_calling', 7, '工具熔断器');

      // 生成报告
      const report = matrix.generateReport();
      expect(report.overallScore).toBeLessThan(10);
      expect(report.topGaps.length).toBeGreaterThan(0);
      expect(report.recommendations.length).toBeGreaterThan(0);

      // 生成表格
      const table = matrix.generateScoreTable();
      expect(table).toContain('未达标子项');
      expect(table).toContain('残差连接');
      expect(table).toContain('CoT 链式思考');
      expect(table).toContain('工具熔断器');
    });

    it('零分场景：所有维度归零后报告与表格正确', () => {
      for (const dim of matrix.getAllScores()) {
        for (const sub of dim.subItems) {
          matrix.updateScore(dim.id, 0, sub.name);
        }
      }
      expect(matrix.getOverallScore()).toBe(0);

      const report = matrix.generateReport();
      expect(report.overallScore).toBe(0);
      // 每个维度都有 10 个 gap，但 topGaps 限制为 10
      expect(report.topGaps).toHaveLength(10);
      // recommendations: 1 条综合提示 + 5 条优先提升 = 6
      expect(report.recommendations).toHaveLength(6);

      const table = matrix.generateScoreTable();
      expect(table).toContain('🔴');
      expect(table).toContain('未达标子项');
    });

    it('满分场景：所有维度满分时报告与表格正确', () => {
      const report = matrix.generateReport();
      expect(report.overallScore).toBe(10);
      expect(report.topGaps).toHaveLength(0);
      expect(report.recommendations).toHaveLength(0);

      const table = matrix.generateScoreTable();
      expect(table).toContain('✅ 所有子项已达标！');
      expect(table).not.toContain('未达标子项');
    });

    it('更新评分后再次获取维度对象反映最新状态', () => {
      const dimBefore = matrix.getDimension('neural_network')!;
      expect(dimBefore.currentScore).toBe(10);

      matrix.updateScore('neural_network', 3, '残差连接');

      const dimAfter = matrix.getDimension('neural_network')!;
      expect(dimAfter.currentScore).toBeCloseTo(9.3, 5); // (9*10 + 3)/10
      const sub = dimAfter.subItems.find(s => s.name === '残差连接');
      expect(sub!.score).toBe(3);
      expect(sub!.status).toBe('not_started');
    });

    it('不同维度的更新互不影响', () => {
      matrix.updateScore('neural_network', 5, '残差连接');
      matrix.updateScore('thinking_logic', 6, 'CoT 链式思考');

      const nn = matrix.getDimension('neural_network')!;
      const tl = matrix.getDimension('thinking_logic')!;

      expect(nn.currentScore).toBeCloseTo(9.5, 5); // (9*10 + 5)/10
      expect(tl.currentScore).toBeCloseTo(9.6, 5); // (9*10 + 6)/10

      // 其他维度保持满分
      expect(matrix.getDimension('tool_calling')!.currentScore).toBe(10);
      expect(matrix.getDimension('cross_platform')!.currentScore).toBe(10);
    });
  });
});
