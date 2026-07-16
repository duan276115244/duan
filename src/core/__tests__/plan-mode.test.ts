/**
 * Plan Mode 单元测试
 *
 * 验证 PlanMode 类的可编辑计划流程：
 * 1. 创建计划
 * 2. 状态机流转（所有合法 + 非法流转）
 * 3. 步骤更新
 * 4. 下一步骤获取
 * 5. Markdown 生成
 * 6. Markdown 导入
 * 7. 持久化
 * 8. 列表过滤
 * 9. LLM 工具
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';

// 在导入 plan-mode（会传递性导入 duan-paths）前设置 DUAN_DATA_DIR，
// 隔离测试环境，避免写入真实 ~/.duan/plans。
const TEST_DATA_DIR = path.join(os.tmpdir(), 'duan-plan-mode-test');
process.env.DUAN_DATA_DIR = TEST_DATA_DIR;

import {
  PlanMode,
  getPlanModeToolDefinitions,
  createPlanModeToolHandler,
  type PlanStep,
  type Plan,
  type PlanStatus,
  type StepStatus,
} from '../plan-mode.js';

// ============ 测试辅助 ============

/** 构造一组标准步骤 */
function makeSteps(count: number): PlanStep[] {
  return Array.from({ length: count }, (_, i) => ({
    id: `step-${i + 1}`,
    title: `步骤 ${i + 1}`,
    description: `步骤 ${i + 1} 描述`,
    status: 'pending' as StepStatus,
    dependencies: i > 0 ? [`step-${i}`] : [],
  }));
}

// ============ 测试 ============

describe('PlanMode', () => {
  let manager: PlanMode;
  let tmpDataDir: string;

  beforeEach(() => {
    // 每个测试用例使用独立的临时目录
    tmpDataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'plan-mode-data-'));
    manager = new PlanMode({ dataDir: tmpDataDir });
  });

  afterEach(() => {
    try {
      fs.rmSync(tmpDataDir, { recursive: true, force: true });
    } catch {
      // 清理失败不阻断测试
    }
  });

  // ========== 1. 创建计划 ==========

  describe('创建计划', () => {
    it('应能创建计划并返回 Plan', () => {
      const plan = manager.createPlan('实现登录', '实现用户登录', makeSteps(2));
      expect(plan).toBeDefined();
      expect(plan.title).toBe('实现登录');
      expect(plan.goal).toBe('实现用户登录');
      expect(plan.status).toBe('draft');
      expect(plan.steps).toHaveLength(2);
    });

    it('初始状态应为 draft', () => {
      const plan = manager.createPlan('标题', '目标', makeSteps(1));
      expect(plan.status).toBe('draft');
    });

    it('计划 ID 应符合 plan-<timestamp36>-<random> 格式', () => {
      const plan = manager.createPlan('标题', '目标', makeSteps(1));
      expect(plan.id).toMatch(/^plan-[a-z0-9]+-[a-z0-9]+$/);
    });

    it('步骤 ID 应自动生成为 step-1, step-2, ...', () => {
      const plan = manager.createPlan('标题', '目标', makeSteps(3));
      expect(plan.steps[0].id).toBe('step-1');
      expect(plan.steps[1].id).toBe('step-2');
      expect(plan.steps[2].id).toBe('step-3');
    });

    it('步骤依赖引用应自动重映射到新 ID', () => {
      const plan = manager.createPlan('标题', '目标', [
        {
          id: 'a',
          title: 'A',
          description: '',
          status: 'pending',
          dependencies: [],
        },
        {
          id: 'b',
          title: 'B',
          description: '',
          status: 'pending',
          dependencies: ['a'],
        },
      ]);
      expect(plan.steps[0].id).toBe('step-1');
      expect(plan.steps[1].id).toBe('step-2');
      expect(plan.steps[1].dependencies).toEqual(['step-1']);
    });

    it('应支持 files / risks / acceptanceCriteria 选项', () => {
      const plan = manager.createPlan('标题', '目标', makeSteps(1), {
        files: ['src/a.ts', 'src/b.ts'],
        risks: ['密钥管理风险'],
        acceptanceCriteria: ['可以登录', 'token 可刷新'],
      });
      expect(plan.files).toEqual(['src/a.ts', 'src/b.ts']);
      expect(plan.risks).toEqual(['密钥管理风险']);
      expect(plan.acceptanceCriteria).toEqual(['可以登录', 'token 可刷新']);
    });

    it('未提供选项时 files/risks/acceptanceCriteria 应为空数组', () => {
      const plan = manager.createPlan('标题', '目标', makeSteps(1));
      expect(plan.files).toEqual([]);
      expect(plan.risks).toEqual([]);
      expect(plan.acceptanceCriteria).toEqual([]);
    });

    it('初始进度应为 0（无已完成步骤）', () => {
      const plan = manager.createPlan('标题', '目标', makeSteps(3));
      expect(plan.progress).toBe(0);
    });

    it('应设置 createdAt 和 updatedAt 时间戳', () => {
      const before = Date.now();
      const plan = manager.createPlan('标题', '目标', makeSteps(1));
      const after = Date.now();
      expect(plan.createdAt).toBeGreaterThanOrEqual(before);
      expect(plan.createdAt).toBeLessThanOrEqual(after);
      expect(plan.updatedAt).toBe(plan.createdAt);
    });

    it('步骤无 dependencies 字段时应默认为空数组', () => {
      const plan = manager.createPlan('标题', '目标', [
        { id: '', title: 'A', description: '', status: 'pending', dependencies: [] },
      ]);
      expect(plan.steps[0].dependencies).toEqual([]);
    });
  });

  // ========== 2. 状态机 - 合法流转 ==========

  describe('状态机 - 合法流转', () => {
    it('draft → reviewing 应成功', () => {
      const plan = manager.createPlan('标题', '目标', makeSteps(1));
      const updated = manager.updatePlan(plan.id, { status: 'reviewing' });
      expect(updated!.status).toBe('reviewing');
    });

    it('reviewing → approved 应成功并设置 approvedAt', () => {
      const plan = manager.createPlan('标题', '目标', makeSteps(1));
      manager.updatePlan(plan.id, { status: 'reviewing' });
      const updated = manager.updatePlan(plan.id, { status: 'approved' });
      expect(updated!.status).toBe('approved');
      expect(updated!.approvedAt).toBeDefined();
    });

    it('reviewing → rejected 应成功', () => {
      const plan = manager.createPlan('标题', '目标', makeSteps(1));
      manager.updatePlan(plan.id, { status: 'reviewing' });
      const updated = manager.updatePlan(plan.id, { status: 'rejected' });
      expect(updated!.status).toBe('rejected');
    });

    it('rejected → draft 应成功（重新编辑）', () => {
      const plan = manager.createPlan('标题', '目标', makeSteps(1));
      manager.updatePlan(plan.id, { status: 'reviewing' });
      manager.updatePlan(plan.id, { status: 'rejected' });
      const updated = manager.updatePlan(plan.id, { status: 'draft' });
      expect(updated!.status).toBe('draft');
    });

    it('approved → executing 应成功', () => {
      const plan = manager.createPlan('标题', '目标', makeSteps(1));
      manager.updatePlan(plan.id, { status: 'reviewing' });
      manager.updatePlan(plan.id, { status: 'approved' });
      const updated = manager.updatePlan(plan.id, { status: 'executing' });
      expect(updated!.status).toBe('executing');
    });

    it('executing → completed 应成功并设置 completedAt', () => {
      const plan = manager.createPlan('标题', '目标', makeSteps(1));
      manager.updatePlan(plan.id, { status: 'reviewing' });
      manager.updatePlan(plan.id, { status: 'approved' });
      manager.updatePlan(plan.id, { status: 'executing' });
      const updated = manager.updatePlan(plan.id, { status: 'completed' });
      expect(updated!.status).toBe('completed');
      expect(updated!.completedAt).toBeDefined();
    });

    it('executing → cancelled 应成功', () => {
      const plan = manager.createPlan('标题', '目标', makeSteps(1));
      manager.updatePlan(plan.id, { status: 'reviewing' });
      manager.updatePlan(plan.id, { status: 'approved' });
      manager.updatePlan(plan.id, { status: 'executing' });
      const updated = manager.updatePlan(plan.id, { status: 'cancelled' });
      expect(updated!.status).toBe('cancelled');
    });

    it('draft → cancelled 应成功（草稿也可取消）', () => {
      const plan = manager.createPlan('标题', '目标', makeSteps(1));
      const updated = manager.updatePlan(plan.id, { status: 'cancelled' });
      expect(updated!.status).toBe('cancelled');
    });

    it('confirmPlan 应将 reviewing 直接转为 executing', () => {
      const plan = manager.createPlan('标题', '目标', makeSteps(1));
      manager.updatePlan(plan.id, { status: 'reviewing' });
      const confirmed = manager.confirmPlan(plan.id);
      expect(confirmed!.status).toBe('executing');
    });

    it('confirmPlan 应设置 approvedAt', () => {
      const plan = manager.createPlan('标题', '目标', makeSteps(1));
      manager.updatePlan(plan.id, { status: 'reviewing' });
      const confirmed = manager.confirmPlan(plan.id);
      expect(confirmed!.approvedAt).toBeDefined();
    });

    it('cancelPlan 应将 draft 转为 cancelled', () => {
      const plan = manager.createPlan('标题', '目标', makeSteps(1));
      const cancelled = manager.cancelPlan(plan.id);
      expect(cancelled!.status).toBe('cancelled');
    });

    it('cancelPlan 应将 executing 转为 cancelled', () => {
      const plan = manager.createPlan('标题', '目标', makeSteps(1));
      manager.updatePlan(plan.id, { status: 'reviewing' });
      manager.confirmPlan(plan.id);
      const cancelled = manager.cancelPlan(plan.id);
      expect(cancelled!.status).toBe('cancelled');
    });
  });

  // ========== 3. 状态机 - 非法流转 ==========

  describe('状态机 - 非法流转', () => {
    it('draft → approved 应抛出错误', () => {
      const plan = manager.createPlan('标题', '目标', makeSteps(1));
      expect(() => manager.updatePlan(plan.id, { status: 'approved' })).toThrow(
        '非法状态流转',
      );
    });

    it('draft → executing 应抛出错误', () => {
      const plan = manager.createPlan('标题', '目标', makeSteps(1));
      expect(() => manager.updatePlan(plan.id, { status: 'executing' })).toThrow(
        '非法状态流转',
      );
    });

    it('reviewing → executing 应抛出错误（需经 approved）', () => {
      const plan = manager.createPlan('标题', '目标', makeSteps(1));
      manager.updatePlan(plan.id, { status: 'reviewing' });
      expect(() => manager.updatePlan(plan.id, { status: 'executing' })).toThrow(
        '非法状态流转',
      );
    });

    it('approved → completed 应抛出错误（需先执行）', () => {
      const plan = manager.createPlan('标题', '目标', makeSteps(1));
      manager.updatePlan(plan.id, { status: 'reviewing' });
      manager.updatePlan(plan.id, { status: 'approved' });
      expect(() => manager.updatePlan(plan.id, { status: 'completed' })).toThrow(
        '非法状态流转',
      );
    });

    it('approved → cancelled 应抛出错误', () => {
      const plan = manager.createPlan('标题', '目标', makeSteps(1));
      manager.updatePlan(plan.id, { status: 'reviewing' });
      manager.updatePlan(plan.id, { status: 'approved' });
      expect(() => manager.updatePlan(plan.id, { status: 'cancelled' })).toThrow(
        '非法状态流转',
      );
    });

    it('rejected → reviewing 应抛出错误（需先回 draft）', () => {
      const plan = manager.createPlan('标题', '目标', makeSteps(1));
      manager.updatePlan(plan.id, { status: 'reviewing' });
      manager.updatePlan(plan.id, { status: 'rejected' });
      expect(() => manager.updatePlan(plan.id, { status: 'reviewing' })).toThrow(
        '非法状态流转',
      );
    });

    it('completed → draft 应抛出错误（终态不可流转）', () => {
      const plan = manager.createPlan('标题', '目标', makeSteps(1));
      manager.updatePlan(plan.id, { status: 'reviewing' });
      manager.updatePlan(plan.id, { status: 'approved' });
      manager.updatePlan(plan.id, { status: 'executing' });
      manager.updatePlan(plan.id, { status: 'completed' });
      expect(() => manager.updatePlan(plan.id, { status: 'draft' })).toThrow(
        '非法状态流转',
      );
    });

    it('cancelled → draft 应抛出错误（终态不可流转）', () => {
      const plan = manager.createPlan('标题', '目标', makeSteps(1));
      manager.updatePlan(plan.id, { status: 'cancelled' });
      expect(() => manager.updatePlan(plan.id, { status: 'draft' })).toThrow(
        '非法状态流转',
      );
    });

    it('executing → reviewing 应抛出错误', () => {
      const plan = manager.createPlan('标题', '目标', makeSteps(1));
      manager.updatePlan(plan.id, { status: 'reviewing' });
      manager.updatePlan(plan.id, { status: 'approved' });
      manager.updatePlan(plan.id, { status: 'executing' });
      expect(() => manager.updatePlan(plan.id, { status: 'reviewing' })).toThrow(
        '非法状态流转',
      );
    });

    it('confirmPlan 非 reviewing 状态应抛出错误', () => {
      const plan = manager.createPlan('标题', '目标', makeSteps(1));
      expect(() => manager.confirmPlan(plan.id)).toThrow('reviewing');
    });

    it('cancelPlan 在 reviewing 状态应抛出错误', () => {
      const plan = manager.createPlan('标题', '目标', makeSteps(1));
      manager.updatePlan(plan.id, { status: 'reviewing' });
      expect(() => manager.cancelPlan(plan.id)).toThrow('非法状态流转');
    });

    it('cancelPlan 在 completed 状态应抛出错误', () => {
      const plan = manager.createPlan('标题', '目标', makeSteps(1));
      manager.updatePlan(plan.id, { status: 'reviewing' });
      manager.updatePlan(plan.id, { status: 'approved' });
      manager.updatePlan(plan.id, { status: 'executing' });
      manager.updatePlan(plan.id, { status: 'completed' });
      expect(() => manager.cancelPlan(plan.id)).toThrow('非法状态流转');
    });
  });

  // ========== 4. 不存在的计划 ==========

  describe('不存在的计划', () => {
    it('updatePlan 不存在的计划应返回 null', () => {
      expect(manager.updatePlan('plan-not-exist', { title: 'x' })).toBeNull();
    });

    it('confirmPlan 不存在的计划应返回 null', () => {
      expect(manager.confirmPlan('plan-not-exist')).toBeNull();
    });

    it('cancelPlan 不存在的计划应返回 null', () => {
      expect(manager.cancelPlan('plan-not-exist')).toBeNull();
    });

    it('getPlan 不存在的计划应返回 null', () => {
      expect(manager.getPlan('plan-not-exist')).toBeNull();
    });

    it('updateStep 不存在的计划应返回 null', () => {
      expect(manager.updateStep('plan-not-exist', 'step-1', 'completed')).toBeNull();
    });

    it('getNextStep 不存在的计划应返回 null', () => {
      expect(manager.getNextStep('plan-not-exist')).toBeNull();
    });
  });

  // ========== 5. 步骤更新 ==========

  describe('步骤更新', () => {
    it('应能更新步骤状态为 in_progress 并设置 startedAt', () => {
      const plan = manager.createPlan('标题', '目标', makeSteps(2));
      const updated = manager.updateStep(plan.id, 'step-1', 'in_progress');
      const step = updated!.steps[0];
      expect(step.status).toBe('in_progress');
      expect(step.startedAt).toBeDefined();
    });

    it('应能更新步骤状态为 completed 并设置 completedAt', () => {
      const plan = manager.createPlan('标题', '目标', makeSteps(2));
      const updated = manager.updateStep(plan.id, 'step-1', 'completed');
      const step = updated!.steps[0];
      expect(step.status).toBe('completed');
      expect(step.completedAt).toBeDefined();
    });

    it('应能记录步骤执行结果', () => {
      const plan = manager.createPlan('标题', '目标', makeSteps(1));
      const updated = manager.updateStep(
        plan.id,
        'step-1',
        'completed',
        '执行成功，已创建文件',
      );
      expect(updated!.steps[0].result).toBe('执行成功，已创建文件');
    });

    it('更新步骤后应重新计算进度', () => {
      const plan = manager.createPlan('标题', '目标', makeSteps(4));
      expect(plan.progress).toBe(0);
      manager.updateStep(plan.id, 'step-1', 'completed');
      const updated = manager.getPlan(plan.id);
      expect(updated!.progress).toBe(25); // 1/4 = 25%
    });

    it('所有步骤完成后计划应自动转为 completed', () => {
      const plan = manager.createPlan('标题', '目标', makeSteps(2));
      manager.updatePlan(plan.id, { status: 'reviewing' });
      manager.confirmPlan(plan.id);
      manager.updateStep(plan.id, 'step-1', 'completed');
      expect(manager.getPlan(plan.id)!.status).toBe('executing');
      manager.updateStep(plan.id, 'step-2', 'completed');
      const updated = manager.getPlan(plan.id);
      expect(updated!.status).toBe('completed');
      expect(updated!.completedAt).toBeDefined();
    });

    it('skipped 步骤也视为完成（自动完成计划）', () => {
      const plan = manager.createPlan('标题', '目标', makeSteps(2));
      manager.updatePlan(plan.id, { status: 'reviewing' });
      manager.confirmPlan(plan.id);
      manager.updateStep(plan.id, 'step-1', 'completed');
      manager.updateStep(plan.id, 'step-2', 'skipped');
      expect(manager.getPlan(plan.id)!.status).toBe('completed');
    });

    it('步骤不存在时 updateStep 应返回 null', () => {
      const plan = manager.createPlan('标题', '目标', makeSteps(1));
      expect(manager.updateStep(plan.id, 'step-999', 'completed')).toBeNull();
    });

    it('所有步骤完成但计划不在 executing 时不应自动完成', () => {
      const plan = manager.createPlan('标题', '目标', makeSteps(1));
      // 计划仍处于 draft，标记步骤完成不应触发自动完成
      manager.updateStep(plan.id, 'step-1', 'completed');
      expect(manager.getPlan(plan.id)!.status).toBe('draft');
    });
  });

  // ========== 6. 下一步骤获取 ==========

  describe('下一步骤获取', () => {
    it('应返回第一个无依赖的 pending 步骤', () => {
      const plan = manager.createPlan('标题', '目标', makeSteps(2));
      const next = manager.getNextStep(plan.id);
      expect(next).not.toBeNull();
      expect(next!.id).toBe('step-1');
    });

    it('应优先返回 in_progress 步骤', () => {
      const plan = manager.createPlan('标题', '目标', makeSteps(3));
      manager.updateStep(plan.id, 'step-2', 'in_progress');
      const next = manager.getNextStep(plan.id);
      expect(next!.id).toBe('step-2');
    });

    it('依赖未完成时应跳过该步骤', () => {
      const plan = manager.createPlan('标题', '目标', [
        { id: 'a', title: 'A', description: '', status: 'pending', dependencies: [] },
        { id: 'b', title: 'B', description: '', status: 'pending', dependencies: ['a'] },
      ]);
      // step-1 未完成，step-2 依赖 step-1，应返回 step-1
      const next = manager.getNextStep(plan.id);
      expect(next!.id).toBe('step-1');
    });

    it('依赖完成后应返回依赖步骤', () => {
      const plan = manager.createPlan('标题', '目标', [
        { id: 'a', title: 'A', description: '', status: 'pending', dependencies: [] },
        { id: 'b', title: 'B', description: '', status: 'pending', dependencies: ['a'] },
      ]);
      manager.updateStep(plan.id, 'step-1', 'completed');
      const next = manager.getNextStep(plan.id);
      expect(next!.id).toBe('step-2');
    });

    it('所有步骤完成时应返回 null', () => {
      const plan = manager.createPlan('标题', '目标', makeSteps(2));
      manager.updateStep(plan.id, 'step-1', 'completed');
      manager.updateStep(plan.id, 'step-2', 'completed');
      expect(manager.getNextStep(plan.id)).toBeNull();
    });

    it('无步骤的计划应返回 null', () => {
      const plan = manager.createPlan('标题', '目标', []);
      expect(manager.getNextStep(plan.id)).toBeNull();
    });
  });

  // ========== 7. Markdown 生成 ==========

  describe('Markdown 生成', () => {
    it('应包含标题、目标和状态', () => {
      const plan = manager.createPlan(
        '实现用户登录功能',
        '实现基于 JWT 的用户登录功能',
        makeSteps(2),
      );
      const md = manager.generateMarkdown(plan.id);
      expect(md).toContain('# 计划：实现用户登录功能');
      expect(md).toContain('## 目标');
      expect(md).toContain('实现基于 JWT 的用户登录功能');
      expect(md).toContain('## 状态');
      expect(md).toContain('draft (进度: 0%)');
    });

    it('应包含步骤列表及状态', () => {
      const plan = manager.createPlan('标题', '目标', makeSteps(2));
      const md = manager.generateMarkdown(plan.id);
      expect(md).toContain('1. [pending] 步骤 1');
      expect(md).toContain('2. [pending] 步骤 2');
    });

    it('应包含涉及文件', () => {
      const plan = manager.createPlan('标题', '目标', makeSteps(1), {
        files: ['src/models/User.ts', 'src/auth/jwt.ts'],
      });
      const md = manager.generateMarkdown(plan.id);
      expect(md).toContain('## 涉及文件');
      expect(md).toContain('- src/models/User.ts');
      expect(md).toContain('- src/auth/jwt.ts');
    });

    it('应包含风险', () => {
      const plan = manager.createPlan('标题', '目标', makeSteps(1), {
        risks: ['JWT 密钥管理需要安全存储'],
      });
      const md = manager.generateMarkdown(plan.id);
      expect(md).toContain('## 风险');
      expect(md).toContain('- JWT 密钥管理需要安全存储');
    });

    it('应包含验收标准', () => {
      const plan = manager.createPlan('标题', '目标', makeSteps(1), {
        acceptanceCriteria: ['用户可以登录并获取 token', 'token 过期后自动刷新'],
      });
      const md = manager.generateMarkdown(plan.id);
      expect(md).toContain('## 验收标准');
      expect(md).toContain('- [ ] 用户可以登录并获取 token');
      expect(md).toContain('- [ ] token 过期后自动刷新');
    });

    it('进度变化时 Markdown 应反映新进度', () => {
      const plan = manager.createPlan('标题', '目标', makeSteps(4));
      manager.updateStep(plan.id, 'step-1', 'completed');
      const md = manager.generateMarkdown(plan.id);
      expect(md).toContain('(进度: 25%)');
    });

    it('计划不存在时应返回空字符串', () => {
      expect(manager.generateMarkdown('plan-not-exist')).toBe('');
    });
  });

  // ========== 8. Markdown 导入 ==========

  describe('Markdown 导入', () => {
    const sampleMarkdown = `# 计划：实现用户登录功能

## 目标
实现基于 JWT 的用户登录功能

## 状态
executing (进度: 25%)

## 步骤
1. [completed] 创建 User 模型
2. [in_progress] 实现 JWT 认证
3. [pending] 编写登录 API
4. [pending] 添加测试用例

## 涉及文件
- src/models/User.ts
- src/auth/jwt.ts
- src/routes/auth.ts

## 风险
- JWT 密钥管理需要安全存储

## 验收标准
- [ ] 用户可以登录并获取 token
- [ ] token 过期后自动刷新
- [ ] 密码使用 bcrypt 加密
`;

    it('应能导入完整 Markdown 并返回 Plan', () => {
      const plan = manager.importFromMarkdown(sampleMarkdown);
      expect(plan).toBeDefined();
      expect(plan.title).toBe('实现用户登录功能');
    });

    it('应正确解析目标', () => {
      const plan = manager.importFromMarkdown(sampleMarkdown);
      expect(plan.goal).toBe('实现基于 JWT 的用户登录功能');
    });

    it('应正确解析状态和进度', () => {
      const plan = manager.importFromMarkdown(sampleMarkdown);
      expect(plan.status).toBe('executing');
      expect(plan.progress).toBe(25); // 1/4 completed
    });

    it('应正确解析步骤及状态', () => {
      const plan = manager.importFromMarkdown(sampleMarkdown);
      expect(plan.steps).toHaveLength(4);
      expect(plan.steps[0].id).toBe('step-1');
      expect(plan.steps[0].title).toBe('创建 User 模型');
      expect(plan.steps[0].status).toBe('completed');
      expect(plan.steps[1].status).toBe('in_progress');
      expect(plan.steps[2].status).toBe('pending');
    });

    it('应正确解析涉及文件、风险和验收标准', () => {
      const plan = manager.importFromMarkdown(sampleMarkdown);
      expect(plan.files).toEqual([
        'src/models/User.ts',
        'src/auth/jwt.ts',
        'src/routes/auth.ts',
      ]);
      expect(plan.risks).toEqual(['JWT 密钥管理需要安全存储']);
      expect(plan.acceptanceCriteria).toEqual([
        '用户可以登录并获取 token',
        'token 过期后自动刷新',
        '密码使用 bcrypt 加密',
      ]);
    });

    it('导入后应能通过 listPlans 查到', () => {
      manager.importFromMarkdown(sampleMarkdown);
      expect(manager.listPlans()).toHaveLength(1);
    });

    it('往返：生成 → 导入 → 字段一致', () => {
      const original = manager.createPlan('往返测试', '往返目标', makeSteps(2), {
        files: ['a.ts'],
        risks: ['风险A'],
        acceptanceCriteria: ['标准A'],
      });
      manager.updateStep(original.id, 'step-1', 'completed');
      manager.updatePlan(original.id, { status: 'reviewing' });
      manager.confirmPlan(original.id);

      const md = manager.generateMarkdown(original.id);
      const imported = manager.importFromMarkdown(md);

      expect(imported.title).toBe('往返测试');
      expect(imported.goal).toBe('往返目标');
      expect(imported.status).toBe('executing');
      expect(imported.files).toEqual(['a.ts']);
      expect(imported.risks).toEqual(['风险A']);
      expect(imported.acceptanceCriteria).toEqual(['标准A']);
      expect(imported.steps).toHaveLength(2);
      expect(imported.steps[0].title).toBe('步骤 1');
      expect(imported.steps[0].status).toBe('completed');
      expect(imported.steps[1].status).toBe('pending');
      expect(imported.progress).toBe(50); // 1/2
    });
  });

  // ========== 9. 持久化 ==========

  describe('持久化', () => {
    it('应将计划写入 <dataDir>/<plan-id>.json', () => {
      const plan = manager.createPlan('标题', '目标', makeSteps(1));
      const filePath = path.join(tmpDataDir, `${plan.id}.json`);
      expect(fs.existsSync(filePath)).toBe(true);
      const content = JSON.parse(fs.readFileSync(filePath, 'utf-8')) as Plan;
      expect(content.id).toBe(plan.id);
      expect(content.title).toBe('标题');
    });

    it('新实例应能加载已有计划', () => {
      const plan = manager.createPlan('标题', '目标', makeSteps(1));
      manager.updatePlan(plan.id, { status: 'reviewing' });

      // 创建新实例（模拟重启）
      const newManager = new PlanMode({ dataDir: tmpDataDir });
      const loaded = newManager.getPlan(plan.id);
      expect(loaded).not.toBeNull();
      expect(loaded!.title).toBe('标题');
      expect(loaded!.status).toBe('reviewing');
    });

    it('load() 应清空内存并重新加载所有计划', () => {
      const plan1 = manager.createPlan('计划A', '目标A', makeSteps(1));
      const plan2 = manager.createPlan('计划B', '目标B', makeSteps(1));

      // 内存中应有 2 个
      expect(manager.listPlans()).toHaveLength(2);

      // 重新加载
      manager.load();
      const list = manager.listPlans();
      expect(list).toHaveLength(2);
      const titles = list.map((p) => p.title).sort();
      expect(titles).toEqual(['计划A', '计划B']);
    });

    it('save() 应将所有计划写入磁盘', () => {
      const plan1 = manager.createPlan('计划A', '目标A', makeSteps(1));
      const plan2 = manager.createPlan('计划B', '目标B', makeSteps(1));

      // 清空磁盘文件模拟未保存（实际上 createPlan 已保存，这里删除后用 save 重建）
      const files = fs.readdirSync(tmpDataDir).filter((f) => f.endsWith('.json'));
      for (const f of files) {
        fs.unlinkSync(path.join(tmpDataDir, f));
      }
      // 磁盘已空
      expect(fs.readdirSync(tmpDataDir).filter((f) => f.endsWith('.json'))).toHaveLength(0);

      // save 写入所有计划
      manager.save();
      const restored = fs.readdirSync(tmpDataDir).filter((f) => f.endsWith('.json'));
      expect(restored).toHaveLength(2);
      expect(restored).toContain(`${plan1.id}.json`);
      expect(restored).toContain(`${plan2.id}.json`);
    });

    it('加载的步骤数据应完整', () => {
      const plan = manager.createPlan('标题', '目标', [
        {
          id: 'a',
          title: 'A',
          description: '描述A',
          status: 'pending',
          dependencies: [],
        },
        {
          id: 'b',
          title: 'B',
          description: '描述B',
          status: 'pending',
          dependencies: ['a'],
        },
      ]);

      const newManager = new PlanMode({ dataDir: tmpDataDir });
      const loaded = newManager.getPlan(plan.id);
      expect(loaded!.steps).toHaveLength(2);
      expect(loaded!.steps[0].description).toBe('描述A');
      expect(loaded!.steps[1].dependencies).toEqual(['step-1']);
    });
  });

  // ========== 10. 列表过滤 ==========

  describe('列表过滤', () => {
    it('应按创建时间升序列出所有计划', () => {
      const p1 = manager.createPlan('计划A', '目标', makeSteps(1));
      const p2 = manager.createPlan('计划B', '目标', makeSteps(1));
      const p3 = manager.createPlan('计划C', '目标', makeSteps(1));
      const list = manager.listPlans();
      expect(list).toHaveLength(3);
      expect(list[0].id).toBe(p1.id);
      expect(list[1].id).toBe(p2.id);
      expect(list[2].id).toBe(p3.id);
    });

    it('应支持按状态过滤', () => {
      manager.createPlan('计划A', '目标', makeSteps(1));
      const p2 = manager.createPlan('计划B', '目标', makeSteps(1));
      manager.updatePlan(p2.id, { status: 'reviewing' });

      const drafts = manager.listPlans({ status: 'draft' });
      expect(drafts).toHaveLength(1);
      expect(drafts[0].title).toBe('计划A');

      const reviewing = manager.listPlans({ status: 'reviewing' });
      expect(reviewing).toHaveLength(1);
      expect(reviewing[0].title).toBe('计划B');
    });

    it('无计划时应返回空数组', () => {
      expect(manager.listPlans()).toEqual([]);
    });

    it('过滤无匹配状态时应返回空数组', () => {
      manager.createPlan('计划A', '目标', makeSteps(1));
      const completed = manager.listPlans({ status: 'completed' });
      expect(completed).toEqual([]);
    });
  });

  // ========== 11. 更新计划内容 ==========

  describe('更新计划内容', () => {
    it('应能更新标题和目标', () => {
      const plan = manager.createPlan('原标题', '原目标', makeSteps(1));
      const updated = manager.updatePlan(plan.id, {
        title: '新标题',
        goal: '新目标',
      });
      expect(updated!.title).toBe('新标题');
      expect(updated!.goal).toBe('新目标');
    });

    it('应能更新步骤列表', () => {
      const plan = manager.createPlan('标题', '目标', makeSteps(1));
      const updated = manager.updatePlan(plan.id, {
        steps: [
          {
            id: 'step-1',
            title: '新步骤',
            description: '新描述',
            status: 'completed',
            dependencies: [],
          },
        ],
      });
      expect(updated!.steps).toHaveLength(1);
      expect(updated!.steps[0].title).toBe('新步骤');
      expect(updated!.progress).toBe(100);
    });

    it('应能更新 files/risks/acceptanceCriteria', () => {
      const plan = manager.createPlan('标题', '目标', makeSteps(1));
      const updated = manager.updatePlan(plan.id, {
        files: ['x.ts'],
        risks: ['新风险'],
        acceptanceCriteria: ['新标准'],
      });
      expect(updated!.files).toEqual(['x.ts']);
      expect(updated!.risks).toEqual(['新风险']);
      expect(updated!.acceptanceCriteria).toEqual(['新标准']);
    });

    it('同状态更新不应抛出错误', () => {
      const plan = manager.createPlan('标题', '目标', makeSteps(1));
      expect(() => manager.updatePlan(plan.id, { status: 'draft' })).not.toThrow();
      expect(manager.getPlan(plan.id)!.status).toBe('draft');
    });

    it('应更新 updatedAt 时间戳', () => {
      const plan = manager.createPlan('标题', '目标', makeSteps(1));
      const originalUpdatedAt = plan.updatedAt;
      const start = Date.now();
      while (Date.now() === start) {
        /* spin 确保时间戳推进 */
      }
      manager.updatePlan(plan.id, { title: '新标题' });
      expect(manager.getPlan(plan.id)!.updatedAt).toBeGreaterThan(originalUpdatedAt);
    });
  });

  // ========== 12. LLM 工具定义 ==========

  describe('LLM 工具定义', () => {
    it('应返回 5 个工具定义', () => {
      const tools = getPlanModeToolDefinitions();
      expect(tools).toHaveLength(5);
    });

    it('应包含所有工具名称', () => {
      const tools = getPlanModeToolDefinitions();
      const names = tools.map((t) => t.name);
      expect(names).toContain('plan_create');
      expect(names).toContain('plan_update');
      expect(names).toContain('plan_confirm');
      expect(names).toContain('plan_cancel');
      expect(names).toContain('plan_list');
    });

    it('每个工具应有 name、description 和 inputSchema', () => {
      const tools = getPlanModeToolDefinitions();
      for (const tool of tools) {
        expect(tool.name).toBeTruthy();
        expect(tool.description).toBeTruthy();
        expect(tool.inputSchema).toBeDefined();
        expect(tool.inputSchema.type).toBe('object');
      }
    });

    it('plan_create 工具应要求 title、goal、steps', () => {
      const tools = getPlanModeToolDefinitions();
      const createTool = tools.find((t) => t.name === 'plan_create');
      expect(createTool).toBeDefined();
      expect(createTool!.inputSchema.required).toEqual(['title', 'goal', 'steps']);
    });

    it('plan_confirm / plan_cancel 应要求 planId', () => {
      const tools = getPlanModeToolDefinitions();
      const confirmTool = tools.find((t) => t.name === 'plan_confirm');
      const cancelTool = tools.find((t) => t.name === 'plan_cancel');
      expect(confirmTool!.inputSchema.required).toEqual(['planId']);
      expect(cancelTool!.inputSchema.required).toEqual(['planId']);
    });
  });

  // ========== 13. LLM 工具处理器 ==========

  describe('LLM 工具处理器', () => {
    it('plan_create 应创建计划', async () => {
      const handler = createPlanModeToolHandler(manager);
      const result = (await handler('plan_create', {
        title: '用户登录',
        goal: '实现登录',
        steps: [
          { title: '步骤一', description: '描述一', dependencies: [] },
          { title: '步骤二', description: '描述二', dependencies: ['step-1'] },
        ],
        files: ['src/a.ts'],
        risks: ['风险A'],
        acceptanceCriteria: ['标准A'],
      })) as { planId: string; title: string; status: string; stepCount: number };
      expect(result.title).toBe('用户登录');
      expect(result.status).toBe('draft');
      expect(result.stepCount).toBe(2);
      // 验证已写入内存
      const plan = manager.getPlan(result.planId);
      expect(plan).not.toBeNull();
      expect(plan!.files).toEqual(['src/a.ts']);
    });

    it('plan_update 应更新计划', async () => {
      const handler = createPlanModeToolHandler(manager);
      const created = (await handler('plan_create', {
        title: '原标题',
        goal: '原目标',
        steps: [{ title: '步骤一' }],
      })) as { planId: string };
      const result = (await handler('plan_update', {
        planId: created.planId,
        title: '新标题',
        status: 'reviewing',
      })) as { title: string; status: string };
      expect(result.title).toBe('新标题');
      expect(result.status).toBe('reviewing');
    });

    it('plan_update 非法流转应返回 error', async () => {
      const handler = createPlanModeToolHandler(manager);
      const created = (await handler('plan_create', {
        title: '标题',
        goal: '目标',
        steps: [{ title: '步骤一' }],
      })) as { planId: string };
      const result = (await handler('plan_update', {
        planId: created.planId,
        status: 'executing',
      })) as { error: string };
      expect(result.error).toContain('非法状态流转');
    });

    it('plan_update 不存在的计划应返回 error', async () => {
      const handler = createPlanModeToolHandler(manager);
      const result = (await handler('plan_update', {
        planId: 'plan-not-exist',
        title: 'x',
      })) as { error: string };
      expect(result.error).toContain('计划不存在');
    });

    it('plan_confirm 应确认计划（reviewing → executing）', async () => {
      const handler = createPlanModeToolHandler(manager);
      const created = (await handler('plan_create', {
        title: '标题',
        goal: '目标',
        steps: [{ title: '步骤一' }],
      })) as { planId: string };
      await handler('plan_update', { planId: created.planId, status: 'reviewing' });
      const result = (await handler('plan_confirm', {
        planId: created.planId,
      })) as { status: string };
      expect(result.status).toBe('executing');
    });

    it('plan_confirm 非 reviewing 状态应返回 error', async () => {
      const handler = createPlanModeToolHandler(manager);
      const created = (await handler('plan_create', {
        title: '标题',
        goal: '目标',
        steps: [{ title: '步骤一' }],
      })) as { planId: string };
      const result = (await handler('plan_confirm', {
        planId: created.planId,
      })) as { error: string };
      expect(result.error).toContain('reviewing');
    });

    it('plan_cancel 应取消计划', async () => {
      const handler = createPlanModeToolHandler(manager);
      const created = (await handler('plan_create', {
        title: '标题',
        goal: '目标',
        steps: [{ title: '步骤一' }],
      })) as { planId: string };
      const result = (await handler('plan_cancel', {
        planId: created.planId,
      })) as { status: string };
      expect(result.status).toBe('cancelled');
    });

    it('plan_cancel 非法状态应返回 error', async () => {
      const handler = createPlanModeToolHandler(manager);
      const created = (await handler('plan_create', {
        title: '标题',
        goal: '目标',
        steps: [{ title: '步骤一' }],
      })) as { planId: string };
      await handler('plan_update', { planId: created.planId, status: 'reviewing' });
      const result = (await handler('plan_cancel', {
        planId: created.planId,
      })) as { error: string };
      expect(result.error).toContain('非法状态流转');
    });

    it('plan_list 应列出计划', async () => {
      const handler = createPlanModeToolHandler(manager);
      await handler('plan_create', { title: 'A', goal: 'g', steps: [{ title: 's' }] });
      await handler('plan_create', { title: 'B', goal: 'g', steps: [{ title: 's' }] });
      const result = (await handler('plan_list', {})) as Array<{
        title: string;
        status: PlanStatus;
      }>;
      expect(result).toHaveLength(2);
      expect(result.map((r) => r.title)).toEqual(['A', 'B']);
    });

    it('plan_list 应支持状态过滤', async () => {
      const handler = createPlanModeToolHandler(manager);
      await handler('plan_create', { title: 'A', goal: 'g', steps: [{ title: 's' }] });
      const b = (await handler('plan_create', {
        title: 'B',
        goal: 'g',
        steps: [{ title: 's' }],
      })) as { planId: string };
      await handler('plan_update', { planId: b.planId, status: 'reviewing' });

      const drafts = (await handler('plan_list', { status: 'draft' })) as Array<{
        title: string;
      }>;
      expect(drafts).toHaveLength(1);
      expect(drafts[0].title).toBe('A');
    });

    it('未知工具应返回 error', async () => {
      const handler = createPlanModeToolHandler(manager);
      const result = (await handler('unknown_tool', {})) as { error: string };
      expect(result.error).toBe('未知工具: unknown_tool');
    });
  });
});
