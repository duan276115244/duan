import { describe, it, expect, beforeEach } from 'vitest';
import { ToolMaskingEngine, type AgentPhase } from '../tool-masking.js';

// 全部合法阶段，用于遍历测试
const ALL_PHASES: AgentPhase[] = [
  'reasoning',
  'coding',
  'web',
  'desktop',
  'communication',
  'memory',
  'creative',
  'all',
];

describe('ToolMaskingEngine', () => {
  let engine: ToolMaskingEngine;

  beforeEach(() => {
    // 每个用例使用全新实例，避免历史记录互相污染
    engine = new ToolMaskingEngine();
  });

  describe('初始状态', () => {
    it('默认阶段为 all', () => {
      expect(engine.getPhase()).toBe('all');
    });

    it('初始历史记录为空', () => {
      expect(engine.getHistory()).toEqual([]);
      expect(engine.getHistory(10)).toEqual([]);
    });
  });

  describe('阶段转换 - transitionTo', () => {
    it('从 all 转换到 reasoning 后 getPhase 返回 reasoning', () => {
      engine.transitionTo('reasoning', '需要思考');
      expect(engine.getPhase()).toBe('reasoning');
    });

    it('转换会记录一条历史（含 from/to/reason/timestamp）', () => {
      const before = Date.now();
      engine.transitionTo('coding', '开始编码');
      const after = Date.now();
      const history = engine.getHistory(1);
      expect(history).toHaveLength(1);
      const t = history[0];
      expect(t.from).toBe('all');
      expect(t.to).toBe('coding');
      expect(t.reason).toBe('开始编码');
      // timestamp 应落在调用前后时间范围内
      expect(t.timestamp).toBeGreaterThanOrEqual(before);
      expect(t.timestamp).toBeLessThanOrEqual(after);
    });

    it('连续转换会按顺序追加到历史', () => {
      engine.transitionTo('reasoning', '第一步');
      engine.transitionTo('coding', '第二步');
      engine.transitionTo('web', '第三步');
      const history = engine.getHistory(10);
      expect(history).toHaveLength(3);
      expect(history[0]).toMatchObject({ from: 'all', to: 'reasoning', reason: '第一步' });
      expect(history[1]).toMatchObject({ from: 'reasoning', to: 'coding', reason: '第二步' });
      expect(history[2]).toMatchObject({ from: 'coding', to: 'web', reason: '第三步' });
    });

    it('转换后 from 字段反映上一次的阶段', () => {
      engine.transitionTo('desktop', '切到桌面');
      engine.transitionTo('communication', '切到通讯');
      const last = engine.getHistory(1)[0];
      expect(last.from).toBe('desktop');
      expect(last.to).toBe('communication');
    });
  });

  describe('合法与非法转换', () => {
    // 源码中 transitionTo 不做任何合法性校验，任意阶段之间均可互转，且不会抛错。
    // 这里验证“任意两阶段转换均被允许（合法）”这一行为契约。

    it('任意阶段之间均可互转（无校验、不抛异常）', () => {
      for (const from of ALL_PHASES) {
        for (const to of ALL_PHASES) {
          // 先强制到 from 阶段
          engine.transitionTo(from, `setup-${from}`);
          // 再转到 to，不应抛出异常
          expect(() => engine.transitionTo(to, `${from}->${to}`)).not.toThrow();
          expect(engine.getPhase()).toBe(to);
        }
      }
    });

    it('相同阶段的自环转换被允许', () => {
      engine.transitionTo('coding', '进入编码');
      engine.transitionTo('coding', '继续编码');
      const history = engine.getHistory(10);
      expect(history).toHaveLength(2);
      expect(history[1]).toMatchObject({ from: 'coding', to: 'coding', reason: '继续编码' });
    });

    it('“非法”路径（如 communication -> desktop）在当前实现下仍可执行', () => {
      // 当前实现未限制转换路径，业务上看似不合理的跳转也能成功
      engine.transitionTo('communication', '通讯中');
      expect(() => engine.transitionTo('desktop', '突然切桌面')).not.toThrow();
      expect(engine.getPhase()).toBe('desktop');
      const last = engine.getHistory(1)[0];
      expect(last.from).toBe('communication');
      expect(last.to).toBe('desktop');
    });

    it('转换 reason 支持任意字符串（含空串）', () => {
      engine.transitionTo('memory', '');
      const t = engine.getHistory(1)[0];
      expect(t.reason).toBe('');
    });
  });

  describe('工具掩码匹配 - filterTools', () => {
    it('all 阶段返回全部工具（不做过滤）', () => {
      const tools = ['file_read', 'web_search', 'screen_click', 'wechat_send', 'self_think'];
      expect(engine.filterTools(tools)).toEqual(tools);
    });

    it('空工具数组在任何阶段都返回空数组', () => {
      expect(engine.filterTools([])).toEqual([]);
      engine.transitionTo('coding', '编码');
      expect(engine.filterTools([])).toEqual([]);
    });

    it('reasoning 阶段仅保留匹配的工具', () => {
      engine.transitionTo('reasoning', '思考');
      const tools = [
        'self_think',       // 命中
        'current_time',     // 命中
        'user_profile',     // 命中
        'file_read',        // 不命中
        'web_search',       // 不命中
        'screen_click',     // 不命中
      ];
      const filtered = engine.filterTools(tools);
      expect(filtered).toEqual(['self_think', 'current_time', 'user_profile']);
    });

    it('coding 阶段仅保留文件/代码/Git/测试类工具', () => {
      engine.transitionTo('coding', '编码');
      const tools = [
        'file_read', 'file_write', 'shell_execute', 'self_git', 'self_test',
        'web_search',   // 不属于 coding
        'screen_click', // 不属于 coding
      ];
      const filtered = engine.filterTools(tools);
      expect(filtered).toEqual(['file_read', 'file_write', 'shell_execute', 'self_git', 'self_test']);
    });

    it('web 阶段仅保留搜索/抓取/浏览器工具', () => {
      engine.transitionTo('web', '搜索');
      const tools = ['web_search', 'web_fetch', 'http_request', 'browser_operate', 'current_time', 'file_read'];
      expect(engine.filterTools(tools)).toEqual(['web_search', 'web_fetch', 'http_request', 'browser_operate', 'current_time']);
    });

    it('desktop 阶段仅保留桌面操控工具', () => {
      engine.transitionTo('desktop', '桌面');
      const tools = ['screen_capture', 'screen_click', 'screen_key', 'desktop_open', 'computer_use', 'screen_size', 'file_read'];
      expect(engine.filterTools(tools)).toEqual(['screen_capture', 'screen_click', 'screen_key', 'desktop_open', 'computer_use', 'screen_size']);
    });

    it('communication 阶段仅保留微信/邮件工具', () => {
      engine.transitionTo('communication', '通讯');
      const tools = ['wechat_send', 'wechat_contact', 'wechat_group', 'email_send', 'email_read', 'web_search'];
      expect(engine.filterTools(tools)).toEqual(['wechat_send', 'wechat_contact', 'wechat_group', 'email_send', 'email_read']);
    });

    it('memory 阶段仅保留记忆/画像/触发器工具', () => {
      engine.transitionTo('memory', '记忆');
      const tools = ['self_memory', 'dreaming_query', 'dreaming_status', 'dreaming_record', 'user_profile', 'proactive_habits', 'file_read'];
      expect(engine.filterTools(tools)).toEqual(['self_memory', 'dreaming_query', 'dreaming_status', 'dreaming_record', 'user_profile', 'proactive_habits']);
    });

    it('creative 阶段保留跨域创意工具', () => {
      engine.transitionTo('creative', '创意');
      const tools = ['file_read', 'code_execute', 'browser_operate', 'screen_capture', 'web_search', 'wechat_send', 'self_think'];
      // creative 不包含 wechat_send / self_think
      expect(engine.filterTools(tools)).toEqual(['file_read', 'code_execute', 'browser_operate', 'screen_capture', 'web_search']);
    });

    it('前缀匹配：工具名以 pattern 开头也算命中', () => {
      engine.transitionTo('coding', '编码');
      const tools = [
        'file_read',          // 精确命中
        'file_read_v2',       // 前缀命中
        'file_reader',        // 前缀命中
        'shell_execute_x',    // 前缀命中
        'web_search',         // 不命中
      ];
      expect(engine.filterTools(tools)).toEqual(['file_read', 'file_read_v2', 'file_reader', 'shell_execute_x']);
    });

    it('前缀匹配不会反向命中（pattern 比工具名长时不命中）', () => {
      engine.transitionTo('reasoning', '思考');
      // pattern 为 self_think，工具名 self_thin 不应命中
      const filtered = engine.filterTools(['self_thin', 'self_thin']);
      expect(filtered).toEqual([]);
    });

    it('同一工具可被多个阶段允许（如 current_time 同时在 reasoning 与 web）', () => {
      engine.transitionTo('reasoning', '思考');
      expect(engine.filterTools(['current_time'])).toEqual(['current_time']);
      engine.transitionTo('web', '搜索');
      expect(engine.filterTools(['current_time'])).toEqual(['current_time']);
    });

    it('完全不匹配的工具被全部过滤掉', () => {
      engine.transitionTo('communication', '通讯');
      const tools = ['file_read', 'web_search', 'screen_click', 'self_think'];
      expect(engine.filterTools(tools)).toEqual([]);
    });

    it('保留工具的原始顺序', () => {
      engine.transitionTo('web', '搜索');
      const tools = ['web_fetch', 'web_search', 'http_request', 'browser_operate'];
      expect(engine.filterTools(tools)).toEqual(['web_fetch', 'web_search', 'http_request', 'browser_operate']);
    });
  });

  describe('历史记录 - getHistory', () => {
    it('默认 limit 为 5，返回最近 5 条', () => {
      for (let i = 0; i < 7; i++) {
        engine.transitionTo('coding', `r${i}`);
      }
      const history = engine.getHistory();
      expect(history).toHaveLength(5);
      // 应为最近 5 条（r2..r6）
      expect(history.map(h => h.reason)).toEqual(['r2', 'r3', 'r4', 'r5', 'r6']);
    });

    it('指定 limit 返回对应数量的最近记录', () => {
      for (let i = 0; i < 10; i++) {
        engine.transitionTo('web', `r${i}`);
      }
      expect(engine.getHistory(3)).toHaveLength(3);
      expect(engine.getHistory(3).map(h => h.reason)).toEqual(['r7', 'r8', 'r9']);
    });

    it('limit 大于历史总数时返回全部', () => {
      engine.transitionTo('coding', 'a');
      engine.transitionTo('web', 'b');
      expect(engine.getHistory(100)).toHaveLength(2);
    });

    it('历史为空时返回空数组', () => {
      expect(engine.getHistory(5)).toEqual([]);
    });

    it('limit=0 因 slice(-0) 等价 slice(0)，返回全部历史', () => {
      // 这是当前实现的一个边界行为：-0 === 0，slice(0) 返回整个数组
      for (let i = 0; i < 3; i++) {
        engine.transitionTo('coding', `r${i}`);
      }
      expect(engine.getHistory(0)).toHaveLength(3);
    });
  });

  describe('历史记录上限（100 条）', () => {
    it('超过 100 条时移除最旧的一条，保持长度为 100', () => {
      for (let i = 0; i < 101; i++) {
        engine.transitionTo('coding', `r${i}`);
      }
      const history = engine.getHistory(200);
      expect(history).toHaveLength(100);
      // 最旧的一条 r0 应已被 shift 掉，最早保留的是 r1
      expect(history[0].reason).toBe('r1');
      // 最新的一条是 r100
      expect(history[history.length - 1].reason).toBe('r100');
    });

    it('恰好 100 条时不触发 shift', () => {
      for (let i = 0; i < 100; i++) {
        engine.transitionTo('web', `r${i}`);
      }
      const history = engine.getHistory(200);
      expect(history).toHaveLength(100);
      expect(history[0].reason).toBe('r0');
    });

    it('大量转换后仍只保留最近 100 条', () => {
      for (let i = 0; i < 250; i++) {
        engine.transitionTo('desktop', `r${i}`);
      }
      const history = engine.getHistory(300);
      expect(history).toHaveLength(100);
      expect(history[0].reason).toBe('r150');
      expect(history[99].reason).toBe('r249');
    });
  });

  describe('reset', () => {
    it('reset 后阶段回到 all', () => {
      engine.transitionTo('coding', '编码');
      expect(engine.getPhase()).toBe('coding');
      engine.reset();
      expect(engine.getPhase()).toBe('all');
    });

    it('reset 会记录一条 reason 为 reset 的转换', () => {
      engine.transitionTo('web', '搜索');
      engine.reset();
      const last = engine.getHistory(1)[0];
      expect(last.to).toBe('all');
      expect(last.reason).toBe('reset');
      expect(last.from).toBe('web');
    });

    it('reset 后 filterTools 不再过滤', () => {
      engine.transitionTo('communication', '通讯');
      expect(engine.filterTools(['file_read'])).toEqual([]);
      engine.reset();
      expect(engine.filterTools(['file_read'])).toEqual(['file_read']);
    });

    it('从 all 调用 reset 也会记录一条到 all 的转换', () => {
      // 当前阶段即 all，reset 仍会追加历史
      engine.reset();
      const history = engine.getHistory(1);
      expect(history).toHaveLength(1);
      expect(history[0]).toMatchObject({ from: 'all', to: 'all', reason: 'reset' });
    });
  });

  describe('getPhaseDescription', () => {
    it('每个阶段均返回非空描述字符串', () => {
      for (const phase of ALL_PHASES) {
        const desc = engine.getPhaseDescription(phase);
        expect(typeof desc).toBe('string');
        expect(desc.length).toBeGreaterThan(0);
      }
    });

    it('reasoning 描述包含推理相关字样', () => {
      const desc = engine.getPhaseDescription('reasoning');
      expect(desc).toContain('推理');
    });

    it('coding 描述包含编码相关字样', () => {
      const desc = engine.getPhaseDescription('coding');
      expect(desc).toContain('编码');
    });

    it('web 描述包含网络相关字样', () => {
      const desc = engine.getPhaseDescription('web');
      expect(desc).toContain('网络');
    });

    it('desktop 描述包含桌面相关字样', () => {
      const desc = engine.getPhaseDescription('desktop');
      expect(desc).toContain('桌面');
    });

    it('communication 描述包含通讯相关字样', () => {
      const desc = engine.getPhaseDescription('communication');
      expect(desc).toContain('通讯');
    });

    it('memory 描述包含记忆相关字样', () => {
      const desc = engine.getPhaseDescription('memory');
      expect(desc).toContain('记忆');
    });

    it('creative 描述包含创意相关字样', () => {
      const desc = engine.getPhaseDescription('creative');
      expect(desc).toContain('创意');
    });

    it('all 描述表明无限制', () => {
      const desc = engine.getPhaseDescription('all');
      expect(desc).toContain('全部');
    });
  });

  describe('formatForPrompt', () => {
    it('all 阶段输出包含阶段名、描述与“所有工具均可用”', () => {
      const out = engine.formatForPrompt();
      expect(out).toContain('all');
      expect(out).toContain('所有工具均可用');
      expect(out).toContain('当前工具阶段');
    });

    it('具体阶段输出包含该阶段的可用工具列表', () => {
      engine.transitionTo('web', '搜索');
      const out = engine.formatForPrompt();
      expect(out).toContain('web');
      expect(out).toContain('可用工具');
      // web 阶段的工具应在输出中
      expect(out).toContain('web_search');
      expect(out).toContain('browser_operate');
    });

    it('输出为多行字符串（含换行）', () => {
      engine.transitionTo('coding', '编码');
      const out = engine.formatForPrompt();
      expect(out.split('\n').length).toBeGreaterThanOrEqual(3);
    });

    it('切换阶段后输出随之变化', () => {
      const outAll = engine.formatForPrompt();
      expect(outAll).toContain('所有工具均可用');
      engine.transitionTo('desktop', '桌面');
      const outDesktop = engine.formatForPrompt();
      expect(outDesktop).toContain('screen_capture');
      expect(outDesktop).not.toContain('所有工具均可用');
    });
  });

  describe('端到端流程', () => {
    it('完整阶段流转：all -> reasoning -> coding -> web -> reset', () => {
      // all 阶段：全部可用
      expect(engine.filterTools(['self_think', 'file_read', 'web_search'])).toEqual(['self_think', 'file_read', 'web_search']);

      // 进入推理
      engine.transitionTo('reasoning', '先思考');
      expect(engine.filterTools(['self_think', 'file_read', 'web_search'])).toEqual(['self_think']);

      // 进入编码
      engine.transitionTo('coding', '再编码');
      expect(engine.filterTools(['self_think', 'file_read', 'web_search'])).toEqual(['file_read']);

      // 进入网络
      engine.transitionTo('web', '查资料');
      expect(engine.filterTools(['self_think', 'file_read', 'web_search'])).toEqual(['web_search']);

      // 重置
      engine.reset();
      expect(engine.filterTools(['self_think', 'file_read', 'web_search'])).toEqual(['self_think', 'file_read', 'web_search']);

      // 历史应为 4 条：all->reasoning, reasoning->coding, coding->web, web->all(reset)
      const history = engine.getHistory(10);
      expect(history).toHaveLength(4);
      expect(history[0]).toMatchObject({ from: 'all', to: 'reasoning' });
      expect(history[1]).toMatchObject({ from: 'reasoning', to: 'coding' });
      expect(history[2]).toMatchObject({ from: 'coding', to: 'web' });
      expect(history[3]).toMatchObject({ from: 'web', to: 'all', reason: 'reset' });
    });
  });
});
