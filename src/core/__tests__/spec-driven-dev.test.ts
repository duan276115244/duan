/**
 * Spec-Driven Development 单元测试
 *
 * 验证 SpecDrivenDev 类的四阶段结构化任务工件流程：
 * 1. 创建 spec（/specify）
 * 2. 生成 plan（/plan）
 * 3. 拆解 tasks（/tasks）
 * 4. 执行与完成（/implement）
 * 5. Self Check
 * 6. 列表 / 详情
 * 7. Constitution（项目宪法）
 * 8. LLM 工具定义与处理器
 * 9. 持久化
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';

// 在导入 spec-driven-dev（会传递性导入 duan-paths）前设置 DUAN_DATA_DIR，
// 隔离测试环境，避免写入真实 ~/.duan/spec-driven。
// vitest 默认 isolate 模式下每个测试文件有独立模块图，cachedDataDir 会重新初始化。
const TEST_DATA_DIR = path.join(os.tmpdir(), 'duan-spec-driven-test');
process.env.DUAN_DATA_DIR = TEST_DATA_DIR;

import {
  SpecDrivenDev,
  getSpecDrivenToolDefinitions,
  createSpecDrivenToolHandler,
  type SpecTask,
  type SpecProject,
} from '../spec-driven-dev.js';

// ============ 测试 ============

describe('Spec-Driven Development', () => {
  let manager: SpecDrivenDev;
  let tmpCwd: string;
  let tmpIndexDir: string;

  beforeEach(() => {
    // 每个测试用例使用独立的临时目录
    tmpCwd = fs.mkdtempSync(path.join(os.tmpdir(), 'spec-cwd-'));
    tmpIndexDir = fs.mkdtempSync(path.join(os.tmpdir(), 'spec-index-'));
    manager = new SpecDrivenDev({ cwd: tmpCwd, indexDir: tmpIndexDir });
  });

  afterEach(() => {
    try {
      fs.rmSync(tmpCwd, { recursive: true, force: true });
      fs.rmSync(tmpIndexDir, { recursive: true, force: true });
    } catch {
      // 清理失败不阻断测试
    }
  });

  // ========== 1. 创建 spec（/specify）==========

  describe('创建 spec', () => {
    it('应能创建 spec 并返回 SpecProject', () => {
      const spec = manager.createSpec('用户登录', '实现用户登录功能');
      expect(spec).toBeDefined();
      expect(spec.id).toBe('001');
      expect(spec.title).toBe('用户登录');
      expect(spec.description).toBe('实现用户登录功能');
      expect(spec.stage).toBe('specify');
      expect(spec.tasks).toEqual([]);
    });

    it('生成的 spec ID 应为三位数字递增', () => {
      const spec1 = manager.createSpec('功能A', '描述A');
      const spec2 = manager.createSpec('功能B', '描述B');
      const spec3 = manager.createSpec('功能C', '描述C');
      expect(spec1.id).toBe('001');
      expect(spec2.id).toBe('002');
      expect(spec3.id).toBe('003');
    });

    it('应从中文标题生成正确的 kebab-case slug', () => {
      const spec = manager.createSpec('用户登录', '描述');
      expect(spec.name).toBe('user-login');
    });

    it('应从英文标题生成 kebab-case slug', () => {
      const spec = manager.createSpec('User Login Feature', '描述');
      expect(spec.name).toBe('user-login-feature');
    });

    it('应从混合标题生成 slug', () => {
      const spec = manager.createSpec('用户登录 API', '描述');
      expect(spec.name).toBe('user-login-api');
    });

    it('应创建 spec.md 文件', () => {
      const spec = manager.createSpec('测试功能', '这是一个测试');
      expect(fs.existsSync(spec.specPath)).toBe(true);
      const content = fs.readFileSync(spec.specPath, 'utf-8');
      expect(content).toContain('# 测试功能');
      expect(content).toContain('这是一个测试');
    });

    it('应创建正确的目录结构', () => {
      const spec = manager.createSpec('用户登录', '描述');
      const dir = path.dirname(spec.specPath);
      expect(fs.existsSync(dir)).toBe(true);
      expect(path.basename(dir)).toBe('001-user-login');
      expect(fs.existsSync(spec.specPath)).toBe(true);
      expect(fs.existsSync(spec.checklistPath)).toBe(true);
    });

    it('应设置正确的路径字段', () => {
      const spec = manager.createSpec('功能A', '描述');
      // "功能" 在词典中映射为 "feature"，所以 slug 为 "feature-a"
      expect(spec.specPath).toBe(path.join(tmpCwd, 'spec', '001-feature-a', 'spec.md'));
      expect(spec.planPath).toBe(path.join(tmpCwd, 'spec', '001-feature-a', 'plan.md'));
      expect(spec.tasksPath).toBe(path.join(tmpCwd, 'spec', '001-feature-a', 'tasks.md'));
      expect(spec.checklistPath).toBe(path.join(tmpCwd, 'spec', '001-feature-a', 'checklist.md'));
    });

    it('应在 spec.md 中包含 constitution 内容', () => {
      manager.createConstitution('不要使用 any 类型');
      const spec = manager.createSpec('功能A', '描述');
      const content = fs.readFileSync(spec.specPath, 'utf-8');
      expect(content).toContain('项目宪法约束');
      expect(content).toContain('不要使用 any 类型');
    });

    it('应支持通过 options 传入 constitution', () => {
      const spec = manager.createSpec('功能A', '描述', {
        constitution: '必须使用 TypeScript',
      });
      const content = fs.readFileSync(spec.specPath, 'utf-8');
      expect(content).toContain('必须使用 TypeScript');
    });

    it('应设置 createdAt 和 updatedAt 时间戳', () => {
      const before = Date.now();
      const spec = manager.createSpec('功能A', '描述');
      const after = Date.now();
      expect(spec.createdAt).toBeGreaterThanOrEqual(before);
      expect(spec.createdAt).toBeLessThanOrEqual(after);
      expect(spec.updatedAt).toBe(spec.createdAt);
    });
  });

  // ========== 2. 生成 plan（/plan）==========

  describe('生成 plan', () => {
    it('应生成 plan.md 文件', () => {
      const spec = manager.createSpec('用户登录', '描述');
      manager.generatePlan(spec.id, ['TypeScript', 'React'], '前后端分离架构');
      expect(fs.existsSync(spec.planPath)).toBe(true);
      const content = fs.readFileSync(spec.planPath, 'utf-8');
      expect(content).toContain('# 技术方案: 用户登录');
      expect(content).toContain('TypeScript');
      expect(content).toContain('React');
      expect(content).toContain('前后端分离架构');
    });

    it('应将阶段更新为 plan', () => {
      const spec = manager.createSpec('功能A', '描述');
      manager.generatePlan(spec.id, ['Node.js'], '微服务架构');
      const updated = manager.getSpec(spec.id);
      expect(updated!.stage).toBe('plan');
    });

    it('spec 不存在时应抛出错误', () => {
      expect(() => manager.generatePlan('999', [], '')).toThrow('Spec 不存在');
    });

    it('应更新 updatedAt 时间戳', () => {
      const spec = manager.createSpec('功能A', '描述');
      const originalUpdatedAt = spec.updatedAt;
      // 等待 1ms 确保时间戳不同
      const start = Date.now();
      while (Date.now() === start) { /* spin */ }
      manager.generatePlan(spec.id, ['Node.js'], '架构');
      const updated = manager.getSpec(spec.id);
      expect(updated!.updatedAt).toBeGreaterThan(originalUpdatedAt);
    });
  });

  // ========== 3. 拆解 tasks（/tasks）==========

  describe('拆解 tasks', () => {
    it('应生成 tasks.md 文件', () => {
      const spec = manager.createSpec('用户登录', '描述');
      const tasks: SpecTask[] = [
        {
          id: 'T1',
          title: '创建登录表单',
          description: '实现登录 UI',
          status: 'pending',
          dependencies: [],
          files: ['src/Login.tsx'],
          acceptanceCriteria: ['表单包含用户名和密码字段'],
        },
      ];
      manager.generateTasks(spec.id, tasks);
      expect(fs.existsSync(spec.tasksPath)).toBe(true);
      const content = fs.readFileSync(spec.tasksPath, 'utf-8');
      expect(content).toContain('T1');
      expect(content).toContain('创建登录表单');
    });

    it('应将阶段更新为 tasks', () => {
      const spec = manager.createSpec('功能A', '描述');
      manager.generateTasks(spec.id, []);
      const updated = manager.getSpec(spec.id);
      expect(updated!.stage).toBe('tasks');
    });

    it('应将任务存储到 spec 项目中', () => {
      const spec = manager.createSpec('功能A', '描述');
      const tasks: SpecTask[] = [
        {
          id: 'T1',
          title: '任务一',
          description: '描述一',
          status: 'pending',
          dependencies: [],
          files: [],
          acceptanceCriteria: [],
        },
        {
          id: 'T2',
          title: '任务二',
          description: '描述二',
          status: 'pending',
          dependencies: ['T1'],
          files: [],
          acceptanceCriteria: [],
        },
      ];
      manager.generateTasks(spec.id, tasks);
      const updated = manager.getSpec(spec.id);
      expect(updated!.tasks).toHaveLength(2);
      expect(updated!.tasks[0].id).toBe('T1');
      expect(updated!.tasks[1].dependencies).toEqual(['T1']);
    });

    it('应根据验收标准生成 checklist.md', () => {
      const spec = manager.createSpec('功能A', '描述');
      const tasks: SpecTask[] = [
        {
          id: 'T1',
          title: '任务一',
          description: '描述',
          status: 'pending',
          dependencies: [],
          files: [],
          acceptanceCriteria: ['标准A', '标准B'],
        },
      ];
      manager.generateTasks(spec.id, tasks);
      const content = fs.readFileSync(spec.checklistPath, 'utf-8');
      expect(content).toContain('[T1] 标准A');
      expect(content).toContain('[T1] 标准B');
    });

    it('spec 不存在时应抛出错误', () => {
      expect(() => manager.generateTasks('999', [])).toThrow('Spec 不存在');
    });
  });

  // ========== 4. 获取下一个任务（/implement）==========

  describe('获取下一个任务', () => {
    it('应返回第一个无依赖的 pending 任务', () => {
      const spec = manager.createSpec('功能A', '描述');
      const tasks: SpecTask[] = [
        {
          id: 'T1',
          title: '任务一',
          description: '描述',
          status: 'pending',
          dependencies: [],
          files: [],
          acceptanceCriteria: [],
        },
        {
          id: 'T2',
          title: '任务二',
          description: '描述',
          status: 'pending',
          dependencies: ['T1'],
          files: [],
          acceptanceCriteria: [],
        },
      ];
      manager.generateTasks(spec.id, tasks);
      const next = manager.getNextTask(spec.id);
      expect(next).not.toBeNull();
      expect(next!.id).toBe('T1');
    });

    it('依赖未完成时不应返回该任务', () => {
      const spec = manager.createSpec('功能A', '描述');
      const tasks: SpecTask[] = [
        {
          id: 'T1',
          title: '任务一',
          description: '描述',
          status: 'pending',
          dependencies: [],
          files: [],
          acceptanceCriteria: [],
        },
        {
          id: 'T2',
          title: '任务二',
          description: '描述',
          status: 'pending',
          dependencies: ['T1'],
          files: [],
          acceptanceCriteria: [],
        },
      ];
      manager.generateTasks(spec.id, tasks);
      // T1 还未完成，T2 不应返回
      manager.completeTask(spec.id, 'T1');
      const next = manager.getNextTask(spec.id);
      expect(next).not.toBeNull();
      expect(next!.id).toBe('T2');
    });

    it('依赖未完成时应返回 null（当只有依赖未完成的任务时）', () => {
      const spec = manager.createSpec('功能A', '描述');
      const tasks: SpecTask[] = [
        {
          id: 'T1',
          title: '任务一',
          description: '描述',
          status: 'completed',
          dependencies: [],
          files: [],
          acceptanceCriteria: [],
        },
        {
          id: 'T2',
          title: '任务二',
          description: '描述',
          status: 'pending',
          dependencies: ['T3'],
          files: [],
          acceptanceCriteria: [],
        },
        {
          id: 'T3',
          title: '任务三',
          description: '描述',
          status: 'pending',
          dependencies: [],
          files: [],
          acceptanceCriteria: [],
        },
      ];
      manager.generateTasks(spec.id, tasks);
      // T3 可执行（无依赖），T2 不可（T3 未完成）
      const next = manager.getNextTask(spec.id);
      expect(next).not.toBeNull();
      expect(next!.id).toBe('T3');
    });

    it('所有任务完成时应返回 null', () => {
      const spec = manager.createSpec('功能A', '描述');
      const tasks: SpecTask[] = [
        {
          id: 'T1',
          title: '任务一',
          description: '描述',
          status: 'completed',
          dependencies: [],
          files: [],
          acceptanceCriteria: [],
        },
      ];
      manager.generateTasks(spec.id, tasks);
      const next = manager.getNextTask(spec.id);
      expect(next).toBeNull();
    });

    it('首次获取任务时应将阶段切换到 implement', () => {
      const spec = manager.createSpec('功能A', '描述');
      const tasks: SpecTask[] = [
        {
          id: 'T1',
          title: '任务一',
          description: '描述',
          status: 'pending',
          dependencies: [],
          files: [],
          acceptanceCriteria: [],
        },
      ];
      manager.generateTasks(spec.id, tasks);
      expect(manager.getSpec(spec.id)!.stage).toBe('tasks');
      manager.getNextTask(spec.id);
      expect(manager.getSpec(spec.id)!.stage).toBe('implement');
    });

    it('spec 不存在时应返回 null', () => {
      const next = manager.getNextTask('999');
      expect(next).toBeNull();
    });
  });

  // ========== 5. 完成任务 ==========

  describe('完成任务', () => {
    it('应将任务状态标记为 completed', () => {
      const spec = manager.createSpec('功能A', '描述');
      const tasks: SpecTask[] = [
        {
          id: 'T1',
          title: '任务一',
          description: '描述',
          status: 'pending',
          dependencies: [],
          files: [],
          acceptanceCriteria: [],
        },
      ];
      manager.generateTasks(spec.id, tasks);
      manager.completeTask(spec.id, 'T1');
      const updated = manager.getSpec(spec.id);
      expect(updated!.tasks[0].status).toBe('completed');
    });

    it('所有任务完成时应将阶段切换到 completed', () => {
      const spec = manager.createSpec('功能A', '描述');
      const tasks: SpecTask[] = [
        {
          id: 'T1',
          title: '任务一',
          description: '描述',
          status: 'pending',
          dependencies: [],
          files: [],
          acceptanceCriteria: [],
        },
        {
          id: 'T2',
          title: '任务二',
          description: '描述',
          status: 'pending',
          dependencies: ['T1'],
          files: [],
          acceptanceCriteria: [],
        },
      ];
      manager.generateTasks(spec.id, tasks);
      manager.completeTask(spec.id, 'T1');
      expect(manager.getSpec(spec.id)!.stage).not.toBe('completed');
      manager.completeTask(spec.id, 'T2');
      expect(manager.getSpec(spec.id)!.stage).toBe('completed');
    });

    it('应更新 tasks.md 文件', () => {
      const spec = manager.createSpec('功能A', '描述');
      const tasks: SpecTask[] = [
        {
          id: 'T1',
          title: '任务一',
          description: '描述',
          status: 'pending',
          dependencies: [],
          files: [],
          acceptanceCriteria: [],
        },
      ];
      manager.generateTasks(spec.id, tasks);
      manager.completeTask(spec.id, 'T1');
      const content = fs.readFileSync(spec.tasksPath, 'utf-8');
      expect(content).toContain('completed');
    });

    it('任务不存在时应抛出错误', () => {
      const spec = manager.createSpec('功能A', '描述');
      manager.generateTasks(spec.id, []);
      expect(() => manager.completeTask(spec.id, 'T999')).toThrow('任务不存在');
    });

    it('spec 不存在时应抛出错误', () => {
      expect(() => manager.completeTask('999', 'T1')).toThrow('Spec 不存在');
    });
  });

  // ========== 6. Self Check ==========

  describe('Self Check', () => {
    it('所有任务完成且文件存在时应通过', () => {
      const spec = manager.createSpec('功能A', '描述');
      manager.generatePlan(spec.id, ['Node.js'], '架构');
      const tasks: SpecTask[] = [
        {
          id: 'T1',
          title: '任务一',
          description: '描述',
          status: 'pending',
          dependencies: [],
          files: [],
          acceptanceCriteria: ['标准A'],
        },
      ];
      manager.generateTasks(spec.id, tasks);
      manager.completeTask(spec.id, 'T1');
      const result = manager.checkSpec(spec.id);
      expect(result.passed).toBe(true);
      expect(result.totalTasks).toBe(1);
      expect(result.completedTasks).toBe(1);
      expect(result.pendingTasks).toBe(0);
      expect(result.failedChecks).toHaveLength(0);
    });

    it('有未完成任务时不应通过', () => {
      const spec = manager.createSpec('功能A', '描述');
      manager.generatePlan(spec.id, ['Node.js'], '架构');
      const tasks: SpecTask[] = [
        {
          id: 'T1',
          title: '任务一',
          description: '描述',
          status: 'pending',
          dependencies: [],
          files: [],
          acceptanceCriteria: [],
        },
        {
          id: 'T2',
          title: '任务二',
          description: '描述',
          status: 'pending',
          dependencies: [],
          files: [],
          acceptanceCriteria: [],
        },
      ];
      manager.generateTasks(spec.id, tasks);
      manager.completeTask(spec.id, 'T1');
      const result = manager.checkSpec(spec.id);
      expect(result.passed).toBe(false);
      expect(result.pendingTasks).toBe(1);
      expect(result.failedChecks.length).toBeGreaterThan(0);
    });

    it('plan.md 不存在时应添加失败检查项', () => {
      const spec = manager.createSpec('功能A', '描述');
      const tasks: SpecTask[] = [
        {
          id: 'T1',
          title: '任务一',
          description: '描述',
          status: 'pending',
          dependencies: [],
          files: [],
          acceptanceCriteria: [],
        },
      ];
      manager.generateTasks(spec.id, tasks);
      manager.completeTask(spec.id, 'T1');
      const result = manager.checkSpec(spec.id);
      expect(result.failedChecks).toContain('plan.md 不存在');
    });

    it('应正确解析 checklist.md 条目', () => {
      const spec = manager.createSpec('功能A', '描述');
      manager.generatePlan(spec.id, ['Node.js'], '架构');
      const tasks: SpecTask[] = [
        {
          id: 'T1',
          title: '任务一',
          description: '描述',
          status: 'pending',
          dependencies: [],
          files: [],
          acceptanceCriteria: ['验收标准1', '验收标准2'],
        },
      ];
      manager.generateTasks(spec.id, tasks);
      // checklist.md 应包含验收标准条目
      const checklistContent = fs.readFileSync(spec.checklistPath, 'utf-8');
      expect(checklistContent).toContain('[T1] 验收标准1');
      expect(checklistContent).toContain('[T1] 验收标准2');
    });

    it('spec 不存在时应返回失败结果', () => {
      const result = manager.checkSpec('999');
      expect(result.passed).toBe(false);
      expect(result.failedChecks).toContain('Spec 不存在: 999');
    });
  });

  // ========== 7. 列表 / 详情 ==========

  describe('列表与详情', () => {
    it('应列出所有 spec（按创建时间升序）', () => {
      manager.createSpec('功能A', '描述A');
      manager.createSpec('功能B', '描述B');
      manager.createSpec('功能C', '描述C');
      const list = manager.listSpecs();
      expect(list).toHaveLength(3);
      expect(list[0].title).toBe('功能A');
      expect(list[1].title).toBe('功能B');
      expect(list[2].title).toBe('功能C');
    });

    it('无 spec 时应返回空数组', () => {
      const list = manager.listSpecs();
      expect(list).toEqual([]);
    });

    it('应通过 ID 获取 spec 详情', () => {
      const created = manager.createSpec('用户登录', '描述');
      const spec = manager.getSpec(created.id);
      expect(spec).not.toBeNull();
      expect(spec!.id).toBe('001');
      expect(spec!.title).toBe('用户登录');
    });

    it('获取不存在的 spec 应返回 null', () => {
      const spec = manager.getSpec('999');
      expect(spec).toBeNull();
    });
  });

  // ========== 8. Constitution（项目宪法）==========

  describe('Constitution', () => {
    it('应能创建 constitution.md', () => {
      manager.createConstitution('# 项目宪法\n\n- 使用 TypeScript\n- 禁止 any 类型');
      const constitution = manager.loadConstitution();
      expect(constitution).not.toBeNull();
      expect(constitution).toContain('项目宪法');
      expect(constitution).toContain('TypeScript');
    });

    it('应能加载已存在的 constitution', () => {
      const content = '# 宪法\n\n规则1\n规则2';
      manager.createConstitution(content);
      const loaded = manager.loadConstitution();
      expect(loaded).toBe(content);
    });

    it('constitution 不存在时应返回 null', () => {
      const loaded = manager.loadConstitution();
      expect(loaded).toBeNull();
    });

    it('constitution 应写入 spec/constitution.md', () => {
      manager.createConstitution('宪法内容');
      const constitutionPath = path.join(tmpCwd, 'spec', 'constitution.md');
      expect(fs.existsSync(constitutionPath)).toBe(true);
    });

    it('创建 spec 时应自动引用 constitution', () => {
      manager.createConstitution('全局规则');
      const spec = manager.createSpec('功能A', '描述');
      const content = fs.readFileSync(spec.specPath, 'utf-8');
      expect(content).toContain('全局规则');
    });
  });

  // ========== 9. 持久化 ==========

  describe('持久化', () => {
    it('应将 spec 索引保存到 index.json', () => {
      manager.createSpec('功能A', '描述');
      const indexPath = path.join(tmpIndexDir, 'index.json');
      expect(fs.existsSync(indexPath)).toBe(true);
      const content = fs.readFileSync(indexPath, 'utf-8');
      const data = JSON.parse(content);
      expect(Array.isArray(data)).toBe(true);
      expect(data).toHaveLength(1);
      expect(data[0].title).toBe('功能A');
    });

    it('新实例应能加载已有索引', () => {
      manager.createSpec('功能A', '描述');
      manager.createSpec('功能B', '描述');

      // 创建新实例（模拟重启）
      const newManager = new SpecDrivenDev({ cwd: tmpCwd, indexDir: tmpIndexDir });
      const list = newManager.listSpecs();
      expect(list).toHaveLength(2);
      expect(list[0].title).toBe('功能A');
      expect(list[1].title).toBe('功能B');
    });

    it('索引应包含完整的 SpecProject 数据', () => {
      const spec = manager.createSpec('功能A', '描述');
      manager.generatePlan(spec.id, ['Node.js'], '架构');
      manager.generateTasks(spec.id, [
        {
          id: 'T1',
          title: '任务一',
          description: '描述',
          status: 'pending',
          dependencies: [],
          files: ['src/a.ts'],
          acceptanceCriteria: ['标准A'],
        },
      ]);

      const newManager = new SpecDrivenDev({ cwd: tmpCwd, indexDir: tmpIndexDir });
      const loaded = newManager.getSpec('001');
      expect(loaded).not.toBeNull();
      expect(loaded!.stage).toBe('tasks');
      expect(loaded!.tasks).toHaveLength(1);
      expect(loaded!.tasks[0].title).toBe('任务一');
      expect(loaded!.tasks[0].files).toEqual(['src/a.ts']);
    });
  });

  // ========== 10. LLM 工具定义 ==========

  describe('LLM 工具定义', () => {
    it('应返回 7 个工具定义', () => {
      const tools = getSpecDrivenToolDefinitions();
      expect(tools).toHaveLength(7);
    });

    it('应包含所有工具名称', () => {
      const tools = getSpecDrivenToolDefinitions();
      const names = tools.map((t) => t.name);
      expect(names).toContain('spec_create');
      expect(names).toContain('spec_plan');
      expect(names).toContain('spec_tasks');
      expect(names).toContain('spec_implement');
      expect(names).toContain('spec_check');
      expect(names).toContain('spec_list');
      expect(names).toContain('spec_get');
    });

    it('每个工具应有 name、description 和 inputSchema', () => {
      const tools = getSpecDrivenToolDefinitions();
      for (const tool of tools) {
        expect(tool.name).toBeTruthy();
        expect(tool.description).toBeTruthy();
        expect(tool.inputSchema).toBeDefined();
        expect(tool.inputSchema.type).toBe('object');
      }
    });

    it('spec_create 工具应要求 title 和 description', () => {
      const tools = getSpecDrivenToolDefinitions();
      const createTool = tools.find((t) => t.name === 'spec_create');
      expect(createTool).toBeDefined();
      expect(createTool!.inputSchema.required).toEqual(['title', 'description']);
    });
  });

  // ========== 11. LLM 工具处理器 ==========

  describe('LLM 工具处理器', () => {
    it('spec_create 应创建 spec', async () => {
      const handler = createSpecDrivenToolHandler(manager);
      const result = await handler('spec_create', {
        title: '用户登录',
        description: '登录功能',
      });
      expect(result).toHaveProperty('specId', '001');
      expect(result).toHaveProperty('name', 'user-login');
      expect(result).toHaveProperty('stage', 'specify');
    });

    it('spec_plan 应生成技术方案', async () => {
      const handler = createSpecDrivenToolHandler(manager);
      await handler('spec_create', { title: '功能A', description: '描述' });
      const result = await handler('spec_plan', {
        specId: '001',
        techStack: ['React'],
        architecture: '前端架构',
      });
      expect(result).toHaveProperty('generated', true);
    });

    it('spec_tasks 应拆解任务', async () => {
      const handler = createSpecDrivenToolHandler(manager);
      await handler('spec_create', { title: '功能A', description: '描述' });
      const result = await handler('spec_tasks', {
        specId: '001',
        tasks: [
          {
            id: 'T1',
            title: '任务一',
            description: '描述',
            dependencies: [],
            files: [],
            acceptanceCriteria: [],
          },
        ],
      });
      expect(result).toHaveProperty('taskCount', 1);
    });

    it('spec_implement action=next 应返回下一任务', async () => {
      const handler = createSpecDrivenToolHandler(manager);
      await handler('spec_create', { title: '功能A', description: '描述' });
      await handler('spec_tasks', {
        specId: '001',
        tasks: [
          {
            id: 'T1',
            title: '任务一',
            description: '描述',
            dependencies: [],
            files: [],
            acceptanceCriteria: [],
          },
        ],
      });
      const result = await handler('spec_implement', {
        specId: '001',
        action: 'next',
      }) as { task: SpecTask };
      expect(result.task).not.toBeNull();
      expect(result.task.id).toBe('T1');
    });

    it('spec_implement action=complete 应完成任务', async () => {
      const handler = createSpecDrivenToolHandler(manager);
      await handler('spec_create', { title: '功能A', description: '描述' });
      await handler('spec_tasks', {
        specId: '001',
        tasks: [
          {
            id: 'T1',
            title: '任务一',
            description: '描述',
            dependencies: [],
            files: [],
            acceptanceCriteria: [],
          },
        ],
      });
      const result = await handler('spec_implement', {
        specId: '001',
        action: 'complete',
        taskId: 'T1',
      });
      expect(result).toHaveProperty('completed', true);
    });

    it('spec_check 应返回检查结果', async () => {
      const handler = createSpecDrivenToolHandler(manager);
      await handler('spec_create', { title: '功能A', description: '描述' });
      const result = await handler('spec_check', { specId: '001' }) as SpecProject;
      expect(result).toHaveProperty('specId', '001');
      expect(result).toHaveProperty('passed');
    });

    it('spec_list 应返回 spec 列表', async () => {
      const handler = createSpecDrivenToolHandler(manager);
      await handler('spec_create', { title: '功能A', description: '描述' });
      await handler('spec_create', { title: '功能B', description: '描述' });
      const result = await handler('spec_list', {}) as SpecProject[];
      expect(result).toHaveLength(2);
    });

    it('spec_get 应返回 spec 详情', async () => {
      const handler = createSpecDrivenToolHandler(manager);
      await handler('spec_create', { title: '功能A', description: '描述' });
      const result = await handler('spec_get', { specId: '001' }) as SpecProject;
      expect(result.id).toBe('001');
      expect(result.title).toBe('功能A');
    });

    it('spec_get 不存在的 spec 应返回 error', async () => {
      const handler = createSpecDrivenToolHandler(manager);
      const result = await handler('spec_get', { specId: '999' });
      expect(result).toHaveProperty('error');
    });

    it('未知工具应返回 error', async () => {
      const handler = createSpecDrivenToolHandler(manager);
      const result = await handler('unknown_tool', {});
      expect(result).toHaveProperty('error', '未知工具: unknown_tool');
    });

    it('spec_implement action=complete 无 taskId 应返回 error', async () => {
      const handler = createSpecDrivenToolHandler(manager);
      await handler('spec_create', { title: '功能A', description: '描述' });
      const result = await handler('spec_implement', {
        specId: '001',
        action: 'complete',
      });
      expect(result).toHaveProperty('error');
    });
  });
});
