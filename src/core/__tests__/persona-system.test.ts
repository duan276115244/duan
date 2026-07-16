/**
 * v20.0 §3.6 角色人格系统测试
 *
 * 测试 PersonaSystem 的核心功能：
 * - 7 个预设角色完整性
 * - 角色查询/创建/删除
 * - 角色间通信
 * - 协作链（上下游）
 * - 提示词生成
 * - 工具定义与执行
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';

// 在 import 之前设置 DUAN_DATA_DIR
const TEST_DATA_DIR = path.join(os.tmpdir(), `duan-persona-test-${Date.now()}-${process.pid}`);
process.env.DUAN_DATA_DIR = TEST_DATA_DIR;

import {
  PersonaSystem,
  getPersonaSystem,
  BUILTIN_PERSONAS,
  type Persona,
  type Skill,
} from '../persona-system.js';

describe('v20.0 §3.6: PersonaSystem', () => {
  let system: PersonaSystem;

  beforeEach(() => {
    system = new PersonaSystem();
    // 清理可能的自定义角色文件
    try {
      const customPath = path.join(TEST_DATA_DIR, 'personas.json');
      if (fs.existsSync(customPath)) fs.unlinkSync(customPath);
    } catch {
      // 忽略
    }
    system = new PersonaSystem(); // 重新加载
  });

  describe('预设角色', () => {
    it('包含 7 个内置角色', () => {
      expect(BUILTIN_PERSONAS.length).toBe(7);
    });

    it('每个内置角色有完整字段', () => {
      for (const p of BUILTIN_PERSONAS) {
        expect(p.name).toBeTruthy();
        expect(p.displayName).toBeTruthy();
        expect(p.description).toBeTruthy();
        expect(p.icon).toBeTruthy();
        expect(Array.isArray(p.skills)).toBe(true);
        expect(p.thinkingStyle).toBeTruthy();
        expect(p.outputStyle).toBeTruthy();
        expect(Array.isArray(p.knowledgeDomains)).toBe(true);
        expect(p.systemPromptSupplement).toBeTruthy();
        expect(p.builtin).toBe(true);
      }
    });

    it('角色名称唯一', () => {
      const names = BUILTIN_PERSONAS.map(p => p.name);
      const unique = new Set(names);
      expect(unique.size).toBe(names.length);
    });

    it('包含预期的 7 类角色', () => {
      const names = BUILTIN_PERSONAS.map(p => p.name);
      expect(names).toContain('product-manager');
      expect(names).toContain('architect');
      expect(names).toContain('frontend-engineer');
      expect(names).toContain('backend-engineer');
      expect(names).toContain('test-engineer');
      expect(names).toContain('devops');
      expect(names).toContain('tech-writer');
    });

    it('技能熟练度在 1-5 范围内', () => {
      for (const p of BUILTIN_PERSONAS) {
        for (const skill of p.skills) {
          expect(skill.level).toBeGreaterThanOrEqual(1);
          expect(skill.level).toBeLessThanOrEqual(5);
        }
      }
    });
  });

  describe('查询', () => {
    it('getAllPersonas 返回所有角色', () => {
      const all = system.getAllPersonas();
      expect(all.length).toBe(7);
    });

    it('getAllPersonas 返回副本', () => {
      const all = system.getAllPersonas();
      all[0].displayName = 'modified';
      expect(system.getPersona(all[0].name)?.displayName).not.toBe('modified');
    });

    it('listPersonaNames 返回所有名称', () => {
      const names = system.listPersonaNames();
      expect(names.length).toBe(7);
      expect(names).toContain('architect');
    });

    it('getPersona 按名称返回角色', () => {
      const p = system.getPersona('architect');
      expect(p).not.toBeNull();
      expect(p!.name).toBe('architect');
      expect(p!.displayName).toBe('架构师');
    });

    it('getPersona 未知名称返回 null', () => {
      expect(system.getPersona('nonexistent')).toBeNull();
    });

    it('getPersona 返回副本', () => {
      const p = system.getPersona('architect')!;
      p.displayName = 'modified';
      expect(system.getPersona('architect')?.displayName).toBe('架构师');
    });

    it('getBuiltinPersonas 返回内置角色', () => {
      const builtin = system.getBuiltinPersonas();
      expect(builtin.length).toBe(7);
      expect(builtin.every(p => p.builtin)).toBe(true);
    });

    it('getCustomPersonas 初始为空', () => {
      const custom = system.getCustomPersonas();
      expect(custom.length).toBe(0);
    });
  });

  describe('创建/删除', () => {
    it('createPersona 创建自定义角色', () => {
      const result = system.createPersona({
        name: 'data-scientist',
        displayName: '数据科学家',
        description: '数据分析和机器学习专家',
        icon: '📊',
        skills: [{ name: 'Python', level: 5, tools: ['pandas', 'scikit-learn'] }],
        thinkingStyle: '从数据出发',
        outputStyle: 'Jupyter notebook',
        knowledgeDomains: ['机器学习', '统计学'],
        systemPromptSupplement: '作为数据科学家，你必须用数据说话',
      });
      expect(result.success).toBe(true);
      expect(result.persona).toBeDefined();
      expect(result.persona!.name).toBe('data-scientist');
      expect(result.persona!.builtin).toBe(false);
      expect(result.persona!.createdAt).toBeGreaterThan(0);
    });

    it('createPersona 后可查询到', () => {
      system.createPersona({
        name: 'data-scientist',
        displayName: '数据科学家',
        description: '数据分析专家',
        icon: '📊',
        skills: [],
        thinkingStyle: '',
        outputStyle: '',
        knowledgeDomains: [],
        systemPromptSupplement: '行为约束',
      });
      const p = system.getPersona('data-scientist');
      expect(p).not.toBeNull();
      expect(p!.displayName).toBe('数据科学家');
      expect(p!.builtin).toBe(false);
    });

    it('createPersona 与内置角色名冲突返回错误', () => {
      const result = system.createPersona({
        name: 'architect',
        displayName: '架构师2',
        description: '冲突测试',
        icon: '🏗️',
        skills: [],
        thinkingStyle: '',
        outputStyle: '',
        knowledgeDomains: [],
        systemPromptSupplement: 'x',
      });
      expect(result.success).toBe(false);
      expect(result.error).toContain('冲突');
    });

    it('createPersona 缺少必填字段返回错误', () => {
      const result = system.createPersona({
        name: '',
        displayName: 'x',
        description: 'x',
        icon: '🤖',
        skills: [],
        thinkingStyle: '',
        outputStyle: '',
        knowledgeDomains: [],
        systemPromptSupplement: 'x',
      });
      expect(result.success).toBe(false);
      expect(result.error).toContain('必填字段');
    });

    it('createPersona systemPromptSupplement 为空返回错误', () => {
      const result = system.createPersona({
        name: 'test',
        displayName: 'x',
        description: 'x',
        icon: '🤖',
        skills: [],
        thinkingStyle: '',
        outputStyle: '',
        knowledgeDomains: [],
        systemPromptSupplement: '   ',
      });
      expect(result.success).toBe(false);
      expect(result.error).toContain('systemPromptSupplement');
    });

    it('deletePersona 删除自定义角色', () => {
      system.createPersona({
        name: 'temp-role',
        displayName: '临时角色',
        description: 'x',
        icon: '🤖',
        skills: [],
        thinkingStyle: '',
        outputStyle: '',
        knowledgeDomains: [],
        systemPromptSupplement: 'x',
      });
      expect(system.getPersona('temp-role')).not.toBeNull();
      const result = system.deletePersona('temp-role');
      expect(result.success).toBe(true);
      expect(system.getPersona('temp-role')).toBeNull();
    });

    it('deletePersona 不能删除内置角色', () => {
      const result = system.deletePersona('architect');
      expect(result.success).toBe(false);
      expect(result.error).toContain('内置');
      expect(system.getPersona('architect')).not.toBeNull();
    });

    it('deletePersona 不存在角色返回错误', () => {
      const result = system.deletePersona('nonexistent');
      expect(result.success).toBe(false);
      expect(result.error).toContain('不存在');
    });

    it('createPersona 持久化到文件', () => {
      system.createPersona({
        name: 'persisted-role',
        displayName: '持久化角色',
        description: 'x',
        icon: '🤖',
        skills: [],
        thinkingStyle: '',
        outputStyle: '',
        knowledgeDomains: [],
        systemPromptSupplement: 'x',
      });
      const customPath = path.join(TEST_DATA_DIR, 'personas.json');
      expect(fs.existsSync(customPath)).toBe(true);
      const data = JSON.parse(fs.readFileSync(customPath, 'utf-8'));
      expect(data.personas.length).toBe(1);
      expect(data.personas[0].name).toBe('persisted-role');
    });

    it('loadCustom 加载自定义角色', () => {
      // 先写入自定义角色文件
      const customPath = path.join(TEST_DATA_DIR, 'personas.json');
      fs.mkdirSync(path.dirname(customPath), { recursive: true });
      fs.writeFileSync(customPath, JSON.stringify({
        personas: [{
          name: 'loaded-role',
          displayName: '加载角色',
          description: 'x',
          icon: '🤖',
          skills: [],
          thinkingStyle: '',
          outputStyle: '',
          knowledgeDomains: [],
          systemPromptSupplement: 'x',
          builtin: false,
          createdAt: 12345,
        }],
      }));

      const newSystem = new PersonaSystem();
      newSystem.loadCustom();
      const p = newSystem.getPersona('loaded-role');
      expect(p).not.toBeNull();
      expect(p!.displayName).toBe('加载角色');
      expect(p!.builtin).toBe(false);
    });

    it('loadCustom 损坏文件不报错', () => {
      const customPath = path.join(TEST_DATA_DIR, 'personas.json');
      fs.mkdirSync(path.dirname(customPath), { recursive: true });
      fs.writeFileSync(customPath, '{ invalid json');
      const newSystem = new PersonaSystem();
      expect(() => newSystem.loadCustom()).not.toThrow();
      expect(newSystem.getCustomPersonas().length).toBe(0);
    });
  });

  describe('角色间通信', () => {
    it('sendMessage 成功发送', () => {
      const result = system.sendMessage('architect', 'backend-engineer', '请实现用户登录 API', 'task');
      expect(result.success).toBe(true);
    });

    it('sendMessage 来源角色不存在返回错误', () => {
      const result = system.sendMessage('nonexistent', 'architect', 'x');
      expect(result.success).toBe(false);
      expect(result.error).toContain('来源角色');
    });

    it('sendMessage 目标角色不存在返回错误', () => {
      const result = system.sendMessage('architect', 'nonexistent', 'x');
      expect(result.success).toBe(false);
      expect(result.error).toContain('目标角色');
    });

    it('getMessagesForPersona 返回接收的消息', () => {
      system.sendMessage('architect', 'backend-engineer', 'API 设计');
      system.sendMessage('architect', 'backend-engineer', '接口定义');
      const msgs = system.getMessagesForPersona('backend-engineer');
      expect(msgs.length).toBe(2);
      expect(msgs[0].from).toBe('architect');
      expect(msgs[0].to).toBe('backend-engineer');
    });

    it('getMessagesFromPersona 返回发送的消息', () => {
      system.sendMessage('architect', 'backend-engineer', 'API');
      const msgs = system.getMessagesFromPersona('architect');
      expect(msgs.length).toBe(1);
      expect(msgs[0].from).toBe('architect');
    });

    it('getMessagesForPersona 无消息返回空数组', () => {
      const msgs = system.getMessagesForPersona('tech-writer');
      expect(msgs.length).toBe(0);
    });

    it('clearMessages 清空消息队列', () => {
      system.sendMessage('architect', 'backend-engineer', 'x');
      system.clearMessages();
      expect(system.getMessagesForPersona('backend-engineer').length).toBe(0);
    });

    it('消息有唯一 id', () => {
      system.sendMessage('architect', 'backend-engineer', 'msg1');
      system.sendMessage('architect', 'backend-engineer', 'msg2');
      const msgs = system.getMessagesForPersona('backend-engineer');
      expect(msgs[0].id).not.toBe(msgs[1].id);
    });
  });

  describe('协作链', () => {
    it('getDownstreamChain 返回下游角色', () => {
      // 产品经理 → 架构师 → 工程师 → 测试 → DevOps
      const chain = system.getDownstreamChain('product-manager');
      expect(chain).toContain('architect');
      expect(chain).toContain('frontend-engineer');
      expect(chain).toContain('backend-engineer');
      expect(chain).toContain('test-engineer');
      expect(chain).toContain('devops');
    });

    it('getDownstreamChain 不包含自己', () => {
      const chain = system.getDownstreamChain('product-manager');
      expect(chain).not.toContain('product-manager');
    });

    it('getUpstreamChain 返回上游角色', () => {
      const chain = system.getUpstreamChain('devops');
      expect(chain).toContain('architect');
      expect(chain).toContain('test-engineer');
    });

    it('getUpstreamChain 不包含自己', () => {
      const chain = system.getUpstreamChain('devops');
      expect(chain).not.toContain('devops');
    });

    it('无下游角色返回空数组', () => {
      const chain = system.getDownstreamChain('devops');
      expect(chain.length).toBe(0);
    });

    it('无上游角色返回空数组', () => {
      const chain = system.getUpstreamChain('product-manager');
      expect(chain.length).toBe(0);
    });
  });

  describe('提示词生成', () => {
    it('generatePromptSupplement 返回完整提示词', () => {
      const prompt = system.generatePromptSupplement('architect');
      expect(prompt).toContain('架构师');
      expect(prompt).toContain('思维方式');
      expect(prompt).toContain('输出风格');
      expect(prompt).toContain('核心技能');
      expect(prompt).toContain('知识领域');
      expect(prompt).toContain('行为约束');
    });

    it('generatePromptSupplement 包含技能树', () => {
      const prompt = system.generatePromptSupplement('frontend-engineer');
      expect(prompt).toContain('React/Vue');
      expect(prompt).toContain('★'); // 熟练度星标
    });

    it('generatePromptSupplement 包含协作关系', () => {
      const prompt = system.generatePromptSupplement('architect');
      expect(prompt).toContain('上游协作');
      expect(prompt).toContain('下游协作');
    });

    it('generatePromptSupplement 未知角色返回空串', () => {
      expect(system.generatePromptSupplement('nonexistent')).toBe('');
    });

    it('generatePromptSupplement 包含行为约束', () => {
      const prompt = system.generatePromptSupplement('backend-engineer');
      expect(prompt).toContain('作为后端工程师，你必须');
    });
  });

  describe('概览', () => {
    it('getOverview 包含标题', () => {
      const overview = system.getOverview();
      expect(overview).toContain('角色人格系统');
    });

    it('getOverview 包含角色数量', () => {
      const overview = system.getOverview();
      expect(overview).toContain('共 7 个角色');
      expect(overview).toContain('内置 7');
      expect(overview).toContain('自定义 0');
    });

    it('getOverview 包含所有角色', () => {
      const overview = system.getOverview();
      expect(overview).toContain('架构师');
      expect(overview).toContain('前端工程师');
      expect(overview).toContain('后端工程师');
      expect(overview).toContain('DevOps');
      expect(overview).toContain('技术作家');
    });

    it('getOverview 包含用法说明', () => {
      const overview = system.getOverview();
      expect(overview).toContain('用法');
      expect(overview).toContain('persona_list');
      expect(overview).toContain('persona_create');
    });
  });

  describe('LLM 工具', () => {
    it('返回 5 个工具定义', () => {
      const tools = system.getToolDefinitions();
      expect(tools.length).toBe(5);
      const names = tools.map(t => t.name);
      expect(names).toContain('persona_list');
      expect(names).toContain('persona_info');
      expect(names).toContain('persona_create');
      expect(names).toContain('persona_delete');
      expect(names).toContain('persona_send_message');
    });

    it('每个工具有 execute 函数', () => {
      const tools = system.getToolDefinitions();
      tools.forEach(t => {
        expect(typeof t.execute).toBe('function');
      });
    });

    it('persona_list 返回概览', async () => {
      const tools = system.getToolDefinitions();
      const listTool = tools.find(t => t.name === 'persona_list');
      const result = await listTool!.execute({});
      expect(result).toContain('角色人格系统');
      expect(result).toContain('架构师');
    });

    it('persona_info 有效角色返回详情', async () => {
      const tools = system.getToolDefinitions();
      const infoTool = tools.find(t => t.name === 'persona_info');
      const result = await infoTool!.execute({ name: 'architect' });
      expect(result).toContain('架构师');
      expect(result).toContain('思维方式');
      expect(result).toContain('行为约束');
    });

    it('persona_info 未知角色返回错误', async () => {
      const tools = system.getToolDefinitions();
      const infoTool = tools.find(t => t.name === 'persona_info');
      const result = await infoTool!.execute({ name: 'nonexistent' });
      expect(result).toContain('❌');
      expect(result).toContain('不存在');
    });

    it('persona_info 缺少 name 返回错误', async () => {
      const tools = system.getToolDefinitions();
      const infoTool = tools.find(t => t.name === 'persona_info');
      const result = await infoTool!.execute({});
      expect(result).toContain('❌');
    });

    it('persona_create 有效参数返回成功', async () => {
      const tools = system.getToolDefinitions();
      const createTool = tools.find(t => t.name === 'persona_create');
      const result = await createTool!.execute({
        name: 'data-scientist',
        displayName: '数据科学家',
        description: '数据分析专家',
        systemPromptSupplement: '用数据说话',
      });
      expect(result).toContain('✅');
      expect(result).toContain('数据科学家');
      expect(system.getPersona('data-scientist')).not.toBeNull();
    });

    it('persona_create 缺少必填参数返回错误', async () => {
      const tools = system.getToolDefinitions();
      const createTool = tools.find(t => t.name === 'persona_create');
      const result = await createTool!.execute({ name: 'x' });
      expect(result).toContain('❌');
      expect(result).toContain('必填参数');
    });

    it('persona_create 与内置冲突返回错误', async () => {
      const tools = system.getToolDefinitions();
      const createTool = tools.find(t => t.name === 'persona_create');
      const result = await createTool!.execute({
        name: 'architect',
        displayName: 'x',
        description: 'x',
        systemPromptSupplement: 'x',
      });
      expect(result).toContain('❌');
      expect(result).toContain('冲突');
    });

    it('persona_delete 删除自定义角色', async () => {
      // 先创建
      system.createPersona({
        name: 'temp',
        displayName: '临时',
        description: 'x',
        icon: '🤖',
        skills: [],
        thinkingStyle: '',
        outputStyle: '',
        knowledgeDomains: [],
        systemPromptSupplement: 'x',
      });
      const tools = system.getToolDefinitions();
      const deleteTool = tools.find(t => t.name === 'persona_delete');
      const result = await deleteTool!.execute({ name: 'temp' });
      expect(result).toContain('✅');
      expect(system.getPersona('temp')).toBeNull();
    });

    it('persona_delete 内置角色返回错误', async () => {
      const tools = system.getToolDefinitions();
      const deleteTool = tools.find(t => t.name === 'persona_delete');
      const result = await deleteTool!.execute({ name: 'architect' });
      expect(result).toContain('❌');
      expect(result).toContain('内置');
    });

    it('persona_send_message 有效参数返回成功', async () => {
      const tools = system.getToolDefinitions();
      const sendTool = tools.find(t => t.name === 'persona_send_message');
      const result = await sendTool!.execute({
        from: 'architect',
        to: 'backend-engineer',
        content: '请实现登录 API',
      });
      expect(result).toContain('✅');
      expect(result).toContain('architect');
      expect(result).toContain('backend-engineer');
    });

    it('persona_send_message 缺少参数返回错误', async () => {
      const tools = system.getToolDefinitions();
      const sendTool = tools.find(t => t.name === 'persona_send_message');
      const result = await sendTool!.execute({ from: 'architect' });
      expect(result).toContain('❌');
    });

    it('persona_send_message 无效 type 返回错误', async () => {
      const tools = system.getToolDefinitions();
      const sendTool = tools.find(t => t.name === 'persona_send_message');
      const result = await sendTool!.execute({
        from: 'architect',
        to: 'backend-engineer',
        content: 'x',
        type: 'invalid',
      });
      expect(result).toContain('❌');
    });

    it('persona_send_message 支持不同类型', async () => {
      const tools = system.getToolDefinitions();
      const sendTool = tools.find(t => t.name === 'persona_send_message');
      for (const type of ['task', 'handoff', 'question', 'result']) {
        const result = await sendTool!.execute({
          from: 'architect',
          to: 'backend-engineer',
          content: 'x',
          type,
        });
        expect(result).toContain('✅');
        expect(result).toContain(type);
      }
    });
  });

  describe('单例', () => {
    it('getPersonaSystem 返回同一实例', () => {
      const a = getPersonaSystem();
      const b = getPersonaSystem();
      expect(a).toBe(b);
    });

    it('getPersonaSystem 返回有效实例', () => {
      const sys = getPersonaSystem();
      expect(sys).toBeInstanceOf(PersonaSystem);
      expect(typeof sys.getOverview).toBe('function');
    });
  });

  describe('端到端场景', () => {
    it('场景：产品经理 → 架构师 → 后端工程师 协作流', () => {
      // 产品经理发送需求
      expect(system.sendMessage('product-manager', 'architect', 'PRD: 用户登录功能', 'task').success).toBe(true);
      // 架构师收到消息
      const architectMsgs = system.getMessagesForPersona('architect');
      expect(architectMsgs.length).toBe(1);
      expect(architectMsgs[0].content).toContain('用户登录');
      // 架构师发送方案给后端
      expect(system.sendMessage('architect', 'backend-engineer', 'API: POST /login', 'handoff').success).toBe(true);
      // 后端收到消息
      const backendMsgs = system.getMessagesForPersona('backend-engineer');
      expect(backendMsgs.length).toBe(1);
      expect(backendMsgs[0].content).toContain('POST /login');
    });

    it('场景：创建自定义角色并集成到协作链', () => {
      // 创建数据科学家角色
      system.createPersona({
        name: 'data-scientist',
        displayName: '数据科学家',
        description: '数据分析专家',
        icon: '📊',
        skills: [{ name: 'Python', level: 5, tools: ['pandas'] }],
        thinkingStyle: '从数据出发',
        outputStyle: 'Jupyter notebook',
        knowledgeDomains: ['ML'],
        systemPromptSupplement: '用数据说话',
        receivesFrom: ['product-manager'],
        sendsTo: ['architect'],
      });
      // 产品经理发给数据科学家
      expect(system.sendMessage('product-manager', 'data-scientist', '分析用户行为数据').success).toBe(true);
      // 数据科学家发给架构师
      expect(system.sendMessage('data-scientist', 'architect', '推荐系统架构建议').success).toBe(true);
      // 上游链应包含产品经理（data-scientist.receivesFrom = ['product-manager']）
      const chain = system.getUpstreamChain('data-scientist');
      expect(chain).toContain('product-manager');
    });

    it('场景：生成完整系统提示词用于子代理', () => {
      const supplement = system.generatePromptSupplement('test-engineer');
      // 应包含完整的角色信息
      expect(supplement).toContain('测试工程师');
      expect(supplement).toContain('验收标准');
      expect(supplement).toContain('边界条件');
      expect(supplement).toContain('回归测试');
      expect(supplement).toContain('上游协作');
      expect(supplement).toContain('下游协作');
    });
  });
});
