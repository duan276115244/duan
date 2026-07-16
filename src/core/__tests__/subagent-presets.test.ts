/**
 * v20.0 §2.3 专用子代理预设测试
 *
 * 测试 SubAgentPresetRegistry 的核心功能：
 * - 8 类预设定义完整性
 * - 意图识别准确性
 * - 工具定义与执行
 * - 配置转换
 */
import { describe, it, expect, beforeEach } from 'vitest';
import {
  SubAgentPresetRegistry,
  SUBAGENT_PRESETS,
  getSubAgentPresetRegistry,
  detectSubAgentPreset,
} from '../subagent-presets.js';

describe('v20.0 §2.3: SubAgentPresetRegistry', () => {
  let registry: SubAgentPresetRegistry;

  beforeEach(() => {
    registry = new SubAgentPresetRegistry();
  });

  describe('预设定义', () => {
    it('包含 8 个预设', () => {
      expect(SUBAGENT_PRESETS.length).toBe(8);
    });

    it('每个预设有完整字段', () => {
      for (const preset of SUBAGENT_PRESETS) {
        expect(preset.name).toBeTruthy();
        expect(preset.displayName).toBeTruthy();
        expect(preset.description).toBeTruthy();
        expect(preset.systemPrompt).toBeTruthy();
        expect(Array.isArray(preset.allowedTools)).toBe(true);
        expect(Array.isArray(preset.intentKeywords)).toBe(true);
        expect(preset.intentKeywords.length).toBeGreaterThan(0);
        expect(preset.icon).toBeTruthy();
      }
    });

    it('预设名称唯一', () => {
      const names = SUBAGENT_PRESETS.map(p => p.name);
      const unique = new Set(names);
      expect(unique.size).toBe(names.length);
    });

    it('包含预期的 8 类预设', () => {
      const names = SUBAGENT_PRESETS.map(p => p.name);
      expect(names).toContain('code-reviewer');
      expect(names).toContain('test-engineer');
      expect(names).toContain('architect');
      expect(names).toContain('debugger');
      expect(names).toContain('doc-writer');
      expect(names).toContain('security-auditor');
      expect(names).toContain('perf-optimizer');
      expect(names).toContain('researcher');
    });
  });

  describe('getAllPresets', () => {
    it('返回所有预设的副本', () => {
      const presets = registry.getAllPresets();
      expect(presets.length).toBe(8);
      // 修改返回值不影响原数组
      presets.push(presets[0]);
      expect(registry.getAllPresets().length).toBe(8);
    });
  });

  describe('getPreset', () => {
    it('按名称返回预设', () => {
      const preset = registry.getPreset('code-reviewer');
      expect(preset).not.toBeNull();
      expect(preset!.name).toBe('code-reviewer');
      expect(preset!.displayName).toBe('代码审查员');
    });

    it('未知名称返回 null', () => {
      expect(registry.getPreset('nonexistent')).toBeNull();
    });
  });

  describe('listPresetNames', () => {
    it('返回 8 个预设名', () => {
      const names = registry.listPresetNames();
      expect(names.length).toBe(8);
      expect(names).toContain('architect');
      expect(names).toContain('debugger');
    });
  });

  describe('detectPresetFromIntent — 意图识别', () => {
    it('空输入返回 null', () => {
      expect(registry.detectPresetFromIntent('')).toBeNull();
      expect(registry.detectPresetFromIntent('   ')).toBeNull();
    });

    it('审查关键词 → code-reviewer', () => {
      expect(registry.detectPresetFromIntent('请审查这段代码的安全性')).toBe('code-reviewer');
      expect(registry.detectPresetFromIntent('帮我做 code review')).toBe('code-reviewer');
      expect(registry.detectPresetFromIntent('检查代码质量')).toBe('code-reviewer');
    });

    it('测试关键词 → test-engineer', () => {
      expect(registry.detectPresetFromIntent('为这个函数写单元测试')).toBe('test-engineer');
      expect(registry.detectPresetFromIntent('write unit test for login')).toBe('test-engineer');
      expect(registry.detectPresetFromIntent('提高测试覆盖率')).toBe('test-engineer');
    });

    it('架构关键词 → architect', () => {
      expect(registry.detectPresetFromIntent('设计系统架构')).toBe('architect');
      expect(registry.detectPresetFromIntent('system design for e-commerce')).toBe('architect');
      expect(registry.detectPresetFromIntent('技术选型建议')).toBe('architect');
    });

    it('调试关键词 → debugger', () => {
      expect(registry.detectPresetFromIntent('帮我调试这个 bug')).toBe('debugger');
      expect(registry.detectPresetFromIntent('debug this error')).toBe('debugger');
      expect(registry.detectPresetFromIntent('定位问题根因')).toBe('debugger');
    });

    it('文档关键词 → doc-writer', () => {
      expect(registry.detectPresetFromIntent('写 README 文档')).toBe('doc-writer');
      expect(registry.detectPresetFromIntent('generate API documentation')).toBe('doc-writer');
      expect(registry.detectPresetFromIntent('更新变更日志')).toBe('doc-writer');
    });

    it('安全关键词 → security-auditor', () => {
      expect(registry.detectPresetFromIntent('做安全审计')).toBe('security-auditor');
      expect(registry.detectPresetFromIntent('扫描漏洞 vulnerability')).toBe('security-auditor');
      expect(registry.detectPresetFromIntent('OWASP 合规检查')).toBe('security-auditor');
    });

    it('性能关键词 → perf-optimizer', () => {
      expect(registry.detectPresetFromIntent('优化性能瓶颈')).toBe('perf-optimizer');
      expect(registry.detectPresetFromIntent('performance profiling')).toBe('perf-optimizer');
      expect(registry.detectPresetFromIntent('修复内存泄漏')).toBe('perf-optimizer');
    });

    it('调研关键词 → researcher', () => {
      expect(registry.detectPresetFromIntent('技术调研对比')).toBe('researcher');
      expect(registry.detectPresetFromIntent('research modern web frameworks')).toBe('researcher');
      expect(registry.detectPresetFromIntent('评估可行性')).toBe('researcher');
    });

    it('无匹配返回 null', () => {
      expect(registry.detectPresetFromIntent('你好')).toBeNull();
      expect(registry.detectPresetFromIntent('今天天气怎么样')).toBeNull();
    });

    it('多个关键词冲突时取最高分', () => {
      // "测试性能" 同时命中 test-engineer 和 perf-optimizer
      // "性能" 是 perf-optimizer 的关键词，长度 2，得分 1
      // "测试" 是 test-engineer 的关键词，长度 2，得分 1
      // 两者得分相同，应返回先遍历到的（数组顺序）
      const result = registry.detectPresetFromIntent('测试性能');
      expect(result).not.toBeNull();
      expect(['test-engineer', 'perf-optimizer']).toContain(result);
    });
  });

  describe('getOverview', () => {
    it('返回包含所有预设的概览文本', () => {
      const overview = registry.getOverview();
      expect(overview).toContain('专用子代理预设');
      expect(overview).toContain('共 8 个');
      expect(overview).toContain('code-reviewer');
      expect(overview).toContain('test-engineer');
      expect(overview).toContain('architect');
      expect(overview).toContain('debugger');
      expect(overview).toContain('doc-writer');
      expect(overview).toContain('security-auditor');
      expect(overview).toContain('perf-optimizer');
      expect(overview).toContain('researcher');
    });

    it('包含用法说明', () => {
      const overview = registry.getOverview();
      expect(overview).toContain('用法');
      expect(overview).toContain('/subagent');
    });
  });

  describe('toConfigV2', () => {
    it('转换为 V2 配置格式', () => {
      const preset = registry.getPreset('architect')!;
      const config = registry.toConfigV2(preset);
      expect(config.name).toBe('architect');
      expect(config.description).toBe(preset.description);
      expect(config.systemPrompt).toBe(preset.systemPrompt);
      expect(config.allowedTools).toEqual(preset.allowedTools);
      expect(config.model).toBe(preset.model);
      expect(config.maxTurns).toBe(preset.maxTurns);
    });
  });

  describe('getToolDefinitions', () => {
    it('返回 2 个工具定义', () => {
      const tools = registry.getToolDefinitions();
      expect(tools.length).toBe(2);
      const names = tools.map(t => t.name);
      expect(names).toContain('subagent_list');
      expect(names).toContain('subagent_dispatch');
    });

    it('每个工具有 execute 函数', () => {
      const tools = registry.getToolDefinitions();
      tools.forEach(t => {
        expect(typeof t.execute).toBe('function');
      });
    });

    it('subagent_list 返回概览', async () => {
      const tools = registry.getToolDefinitions();
      const listTool = tools.find(t => t.name === 'subagent_list');
      const result = await listTool!.execute({});
      expect(result).toContain('专用子代理预设');
      expect(result).toContain('code-reviewer');
    });

    it('subagent_dispatch 有效预设返回成功', async () => {
      const tools = registry.getToolDefinitions();
      const dispatchTool = tools.find(t => t.name === 'subagent_dispatch');
      const result = await dispatchTool!.execute({
        preset: 'debugger',
        task: '调试登录接口的 500 错误',
      });
      expect(result).toContain('✅');
      expect(result).toContain('调试专家');
      expect(result).toContain('调试登录接口');
    });

    it('subagent_dispatch 未知预设返回错误', async () => {
      const tools = registry.getToolDefinitions();
      const dispatchTool = tools.find(t => t.name === 'subagent_dispatch');
      const result = await dispatchTool!.execute({
        preset: 'nonexistent',
        task: 'test task',
      });
      expect(result).toContain('❌');
      expect(result).toContain('未知预设');
    });

    it('subagent_dispatch 缺少参数返回错误', async () => {
      const tools = registry.getToolDefinitions();
      const dispatchTool = tools.find(t => t.name === 'subagent_dispatch');
      const result1 = await dispatchTool!.execute({ task: 'test' });
      expect(result1).toContain('❌');
      expect(result1).toContain('preset');

      const result2 = await dispatchTool!.execute({ preset: 'debugger' });
      expect(result2).toContain('❌');
      expect(result2).toContain('task');
    });
  });

  describe('单例', () => {
    it('getSubAgentPresetRegistry 返回单例', () => {
      const r1 = getSubAgentPresetRegistry();
      const r2 = getSubAgentPresetRegistry();
      expect(r1).toBe(r2);
    });

    it('detectSubAgentPreset 便捷函数工作', () => {
      const result = detectSubAgentPreset('帮我写测试');
      expect(result).toBe('test-engineer');
    });
  });
});
