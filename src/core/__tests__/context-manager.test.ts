import { describe, it, expect, beforeEach } from 'vitest';
import { ContextManager, type ContextMessage } from '../context-manager.js';

describe('ContextManager', () => {
  let cm: ContextManager;

  beforeEach(() => {
    cm = new ContextManager();
  });

  describe('selectMessages 基础', () => {
    it('空数组返回空数组', () => {
      const result = cm.selectMessages([]);
      expect(result).toEqual([]);
    });

    it('未超预算时返回全部消息（同一引用）', () => {
      const messages: ContextMessage[] = [
        { role: 'user', content: 'hello' },
        { role: 'assistant', content: 'hi' },
      ];
      const result = cm.selectMessages(messages);
      expect(result).toBe(messages);
    });

    it('超预算时仍保留系统消息', () => {
      const tight = new ContextManager({ maxContextTokens: 50, minRecentMessages: 1 });
      const messages: ContextMessage[] = [
        { role: 'system', content: 'S'.repeat(100) },
        { role: 'user', content: 'A'.repeat(100) },
        { role: 'user', content: 'B'.repeat(100) },
      ];
      const result = tight.selectMessages(messages);
      expect(result.some(m => m.role === 'system')).toBe(true);
      expect(result[0].role).toBe('system');
    });

    it('保留最近 N 条消息', () => {
      const tight = new ContextManager({
        maxContextTokens: 50,
        minRecentMessages: 2,
        preserveSystemMessages: false,
      });
      const messages: ContextMessage[] = [
        { role: 'user', content: 'A'.repeat(100) },
        { role: 'user', content: 'B'.repeat(100) },
        { role: 'user', content: 'recent1' },
        { role: 'user', content: 'recent2' },
      ];
      const result = tight.selectMessages(messages);
      expect(result.some(m => m.content === 'recent1')).toBe(true);
      expect(result.some(m => m.content === 'recent2')).toBe(true);
    });

    it('超预算时返回更少消息', () => {
      const tight = new ContextManager({
        maxContextTokens: 50,
        minRecentMessages: 1,
        preserveSystemMessages: false,
      });
      const messages: ContextMessage[] = [];
      for (let i = 0; i < 10; i++) {
        messages.push({ role: 'user', content: 'X'.repeat(100) });
      }
      const result = tight.selectMessages(messages);
      expect(result.length).toBeLessThan(messages.length);
    });
  });

  describe('selectMessages 评分', () => {
    it('预算紧张时优先保留 user 消息而非 tool 消息', () => {
      const tight = new ContextManager({
        maxContextTokens: 80,
        minRecentMessages: 2,
        preserveSystemMessages: false,
        positionDecayFactor: 0,
      });
      const messages: ContextMessage[] = [
        { role: 'user', content: 'A'.repeat(50) },
        { role: 'tool', content: 'B'.repeat(50), toolName: 'read_file' },
        { role: 'user', content: 'C'.repeat(50) },
        { role: 'tool', content: 'D'.repeat(50), toolName: 'read_file' },
        { role: 'user', content: 'E'.repeat(50) },
        { role: 'user', content: 'F'.repeat(50) },
      ];
      const result = tight.selectMessages(messages);
      const userCount = result.filter(m => m.role === 'user').length;
      const toolCount = result.filter(m => m.role === 'tool').length;
      expect(userCount).toBeGreaterThan(toolCount);
    });

    it('重要工具调用（write_file, execute_shell）优先于非重要工具', () => {
      const tight = new ContextManager({
        maxContextTokens: 80,
        minRecentMessages: 2,
        preserveSystemMessages: false,
        positionDecayFactor: 0,
      });
      const messages: ContextMessage[] = [
        { role: 'tool', content: 'A'.repeat(50), toolName: 'read_file' },
        { role: 'tool', content: 'B'.repeat(50), toolName: 'write_file' },
        { role: 'tool', content: 'C'.repeat(50), toolName: 'read_file' },
        { role: 'tool', content: 'D'.repeat(50), toolName: 'execute_shell' },
        { role: 'user', content: 'E'.repeat(50) },
        { role: 'user', content: 'F'.repeat(50) },
      ];
      const result = tight.selectMessages(messages);
      const importantTools = result.filter(
        m => m.toolName === 'write_file' || m.toolName === 'execute_shell',
      );
      const normalTools = result.filter(m => m.toolName === 'read_file');
      expect(importantTools.length).toBeGreaterThan(normalTools.length);
    });

    it('失败的工具调用（toolSuccess=false）获得加分', () => {
      const tight = new ContextManager({
        maxContextTokens: 80,
        minRecentMessages: 2,
        preserveSystemMessages: false,
        positionDecayFactor: 0,
      });
      const messages: ContextMessage[] = [
        { role: 'tool', content: 'A'.repeat(50), toolName: 'read_file', toolSuccess: true },
        { role: 'tool', content: 'B'.repeat(50), toolName: 'read_file', toolSuccess: false },
        { role: 'tool', content: 'C'.repeat(50), toolName: 'read_file', toolSuccess: true },
        { role: 'tool', content: 'D'.repeat(50), toolName: 'read_file', toolSuccess: false },
        { role: 'user', content: 'E'.repeat(50) },
        { role: 'user', content: 'F'.repeat(50) },
      ];
      const result = tight.selectMessages(messages);
      const failedTools = result.filter(m => m.toolSuccess === false);
      const successTools = result.filter(m => m.toolSuccess === true);
      expect(failedTools.length).toBeGreaterThan(successTools.length);
    });

    it('过长消息被惩罚（>2000 字符降权）', () => {
      const tight = new ContextManager({
        maxContextTokens: 100,
        minRecentMessages: 1,
        preserveSystemMessages: false,
        positionDecayFactor: 0,
      });
      const messages: ContextMessage[] = [
        { role: 'user', content: 'A'.repeat(50) },
        { role: 'user', content: 'B'.repeat(2100) },
        { role: 'user', content: 'C'.repeat(50) },
        { role: 'user', content: 'D'.repeat(50) },
      ];
      const result = tight.selectMessages(messages);
      const longMsgIncluded = result.some(m => m.content.length > 2000);
      expect(longMsgIncluded).toBe(false);
    });

    it('包含 Error/失败 的消息轻微降权', () => {
      const tight = new ContextManager({
        maxContextTokens: 80,
        minRecentMessages: 2,
        preserveSystemMessages: false,
        positionDecayFactor: 0,
      });
      const messages: ContextMessage[] = [
        { role: 'user', content: 'A'.repeat(50) },
        { role: 'user', content: 'Error' + 'B'.repeat(50) },
        { role: 'user', content: 'C'.repeat(50) },
        { role: 'user', content: '失败' + 'D'.repeat(50) },
        { role: 'user', content: 'E'.repeat(50) },
        { role: 'user', content: 'F'.repeat(50) },
      ];
      const result = tight.selectMessages(messages);
      const errorMessages = result.filter(
        m => m.content.includes('Error') || m.content.includes('失败'),
      );
      expect(errorMessages.length).toBe(0);
    });

    it('结果保持原始消息顺序（非按分数排序）', () => {
      const tight = new ContextManager({
        maxContextTokens: 80,
        minRecentMessages: 2,
        preserveSystemMessages: false,
        positionDecayFactor: 0.85,
      });
      const messages: ContextMessage[] = [
        { role: 'user', content: 'A'.repeat(50) },
        { role: 'tool', content: 'B'.repeat(50), toolName: 'write_file' },
        { role: 'user', content: 'C'.repeat(50) },
        { role: 'user', content: 'D'.repeat(50) },
        { role: 'user', content: 'E'.repeat(50) },
      ];
      const result = tight.selectMessages(messages);
      const originalIndices = result.map(m => messages.indexOf(m));
      for (let i = 1; i < originalIndices.length; i++) {
        expect(originalIndices[i]).toBeGreaterThan(originalIndices[i - 1]);
      }
    });
  });

  describe('compressMessages', () => {
    it('短消息保持不变（同一引用）', () => {
      const msg: ContextMessage = { role: 'user', content: 'short message' };
      const result = cm.compressMessages([msg]);
      expect(result[0]).toBe(msg);
    });

    it('长消息被截断并包含"...[已压缩]..."标记', () => {
      const longContent = 'A'.repeat(2000);
      const msg: ContextMessage = { role: 'user', content: longContent };
      const result = cm.compressMessages([msg], 1000);
      expect(result[0].content).toContain('...[已压缩]...');
      expect(result[0].content.length).toBeLessThan(longContent.length);
    });

    it('支持自定义 maxCharsPerMessage 参数', () => {
      const longContent = 'A'.repeat(2000);
      const msg: ContextMessage = { role: 'user', content: longContent };
      const result = cm.compressMessages([msg], 500);
      // headLen = floor(500 * 0.6) = 300, tailLen = floor(500 * 0.3) = 150
      // marker '\n...[已压缩]...\n' = 13 字符
      expect(result[0].content.length).toBe(300 + 13 + 150);
    });

    it('压缩消息保留头部和尾部内容', () => {
      const content = 'HEAD' + 'X'.repeat(2000) + 'TAIL';
      const msg: ContextMessage = { role: 'user', content };
      const result = cm.compressMessages([msg], 1000);
      expect(result[0].content.startsWith('HEAD')).toBe(true);
      expect(result[0].content.endsWith('TAIL')).toBe(true);
    });
  });

  describe('estimateTotalTokens', () => {
    it('空数组返回 0', () => {
      expect(cm.estimateTotalTokens([])).toBe(0);
    });

    it('已知内容返回正确估算值（length / 2.5 向上取整）', () => {
      // 'hello' = 5 字符, 5 / 2.5 = 2
      expect(cm.estimateTotalTokens([{ role: 'user', content: 'hello' }])).toBe(2);
      // 'hello world' = 11 字符, 11 / 2.5 = 4.4 → 5
      expect(cm.estimateTotalTokens([{ role: 'user', content: 'hello world' }])).toBe(5);
    });

    it('多条消息返回总和', () => {
      const messages: ContextMessage[] = [
        { role: 'user', content: 'hello' }, // 2
        { role: 'assistant', content: 'hello world' }, // 5
      ];
      expect(cm.estimateTotalTokens(messages)).toBe(7);
    });
  });

  describe('配置管理', () => {
    it('默认配置值正确', () => {
      const config = cm.getConfig();
      expect(config.maxContextTokens).toBe(8000);
      expect(config.minRecentMessages).toBe(4);
      expect(config.preserveSystemMessages).toBe(true);
      expect(config.positionDecayFactor).toBe(0.85);
    });

    it('构造函数接受自定义配置', () => {
      const custom = new ContextManager({
        maxContextTokens: 4000,
        minRecentMessages: 10,
        preserveSystemMessages: false,
        positionDecayFactor: 0.5,
      });
      const config = custom.getConfig();
      expect(config.maxContextTokens).toBe(4000);
      expect(config.minRecentMessages).toBe(10);
      expect(config.preserveSystemMessages).toBe(false);
      expect(config.positionDecayFactor).toBe(0.5);
    });

    it('getConfig 返回副本而非引用', () => {
      const config1 = cm.getConfig();
      config1.maxContextTokens = 9999;
      const config2 = cm.getConfig();
      expect(config2.maxContextTokens).toBe(8000);
      expect(config1).not.toBe(config2);
    });

    it('updateConfig 合并部分配置', () => {
      cm.updateConfig({ maxContextTokens: 10000 });
      const config = cm.getConfig();
      expect(config.maxContextTokens).toBe(10000);
      expect(config.minRecentMessages).toBe(4);
      expect(config.preserveSystemMessages).toBe(true);
    });
  });

  describe('边界情况', () => {
    it('单条消息未超预算', () => {
      const messages: ContextMessage[] = [
        { role: 'user', content: 'single message' },
      ];
      const result = cm.selectMessages(messages);
      expect(result).toBe(messages);
    });

    it('全部为系统消息且超预算时全部保留', () => {
      const tight = new ContextManager({ maxContextTokens: 50, minRecentMessages: 1 });
      const messages: ContextMessage[] = [
        { role: 'system', content: 'S1'.repeat(50) },
        { role: 'system', content: 'S2'.repeat(50) },
        { role: 'system', content: 'S3'.repeat(50) },
      ];
      const result = tight.selectMessages(messages);
      expect(result.length).toBe(3);
    });

    it('minRecentMessages 大于非系统消息总数', () => {
      const tight = new ContextManager({
        maxContextTokens: 50,
        minRecentMessages: 10,
        preserveSystemMessages: false,
      });
      const messages: ContextMessage[] = [
        { role: 'user', content: 'A'.repeat(100) },
        { role: 'user', content: 'B'.repeat(100) },
      ];
      const result = tight.selectMessages(messages);
      expect(result.length).toBe(2);
    });
  });

  describe('语义召回（P0-4 注意力机制接入）', () => {
    it('未启用语义召回时，提供 query 不影响结果（向后兼容）', () => {
      const tight = new ContextManager({
        maxContextTokens: 80,
        minRecentMessages: 2,
        preserveSystemMessages: false,
        positionDecayFactor: 0,
      });
      const messages: ContextMessage[] = [
        { role: 'user', content: 'A'.repeat(50) },
        { role: 'user', content: 'B'.repeat(50) },
        { role: 'user', content: 'C'.repeat(50) },
        { role: 'user', content: 'D'.repeat(50) },
        { role: 'user', content: 'E'.repeat(50) },
        { role: 'user', content: 'F'.repeat(50) },
      ];
      const withoutQuery = tight.selectMessages(messages);
      const withQuery = tight.selectMessages(messages, 'some query');
      expect(withQuery.length).toBe(withoutQuery.length);
    });

    it('启用语义召回后，语义相关的旧消息获得优先保留', () => {
      const tight = new ContextManager({
        maxContextTokens: 120,
        minRecentMessages: 2,
        preserveSystemMessages: false,
        positionDecayFactor: 0, // 禁用位置加分，突出语义效果
        semanticWeight: 0.8,    // 高语义权重
      });
      tight.enableSemanticRecall();

      // 构造消息：其中一条与 query 语义相关（包含相同关键词）
      const messages: ContextMessage[] = [
        { role: 'user', content: '讨论天气情况如何'.repeat(10) },        // 与 query 相关
        { role: 'user', content: 'XXXXXXXXXX'.repeat(10) },              // 无关
        { role: 'user', content: 'YYYYYYYYYY'.repeat(10) },              // 无关
        { role: 'user', content: 'ZZZZZZZZZZ'.repeat(10) },              // 无关
        { role: 'user', content: 'recent1'.repeat(10) },
        { role: 'user', content: 'recent2'.repeat(10) },
      ];

      const result = tight.selectMessages(messages, '天气');
      // 语义相关的消息应被保留
      expect(result.some(m => m.content.includes('天气'))).toBe(true);
    });

    it('enableSemanticRecall 可重复调用不报错', () => {
      expect(() => {
        cm.enableSemanticRecall();
        cm.enableSemanticRecall(128);
      }).not.toThrow();
    });

    it('semanticWeight=0 时纯启发式（语义不影响结果）', () => {
      const tight = new ContextManager({
        maxContextTokens: 80,
        minRecentMessages: 2,
        preserveSystemMessages: false,
        positionDecayFactor: 0,
        semanticWeight: 0,
      });
      tight.enableSemanticRecall();

      const messages: ContextMessage[] = [
        { role: 'user', content: 'A'.repeat(50) },
        { role: 'user', content: 'B'.repeat(50) },
        { role: 'user', content: 'C'.repeat(50) },
        { role: 'user', content: 'D'.repeat(50) },
        { role: 'user', content: 'E'.repeat(50) },
        { role: 'user', content: 'F'.repeat(50) },
      ];

      const withoutQuery = tight.selectMessages(messages);
      const withQuery = tight.selectMessages(messages, 'A');
      // semanticWeight=0 时，query 不应影响结果
      expect(withQuery.length).toBe(withoutQuery.length);
    });

    it('语义召回失败时降级为纯启发式（不抛异常）', () => {
      const tight = new ContextManager({
        maxContextTokens: 80,
        minRecentMessages: 2,
        preserveSystemMessages: false,
      });
      tight.enableSemanticRecall();

      const messages: ContextMessage[] = [
        { role: 'user', content: 'A'.repeat(50) },
        { role: 'user', content: 'B'.repeat(50) },
        { role: 'user', content: 'C'.repeat(50) },
        { role: 'user', content: 'D'.repeat(50) },
        { role: 'user', content: 'E'.repeat(50) },
        { role: 'user', content: 'F'.repeat(50) },
      ];

      // 即使 query 很奇怪也不应抛异常
      expect(() => tight.selectMessages(messages, '')).not.toThrow();
      expect(() => tight.selectMessages(messages, '正常查询')).not.toThrow();
    });
  });
});
