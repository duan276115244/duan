import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import {
  Scratchpad,
  type ChatMessage,
} from '../scratchpad.js';

describe('Scratchpad', () => {
  let pad: Scratchpad;

  beforeEach(() => {
    vi.useRealTimers();
    pad = new Scratchpad();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  // ============ set/get 基本操作 ============

  describe('set/get 基本操作', () => {
    it('新增条目后可通过 get 获取', () => {
      pad.set('name', 'duan');
      const entry = pad.get('name');
      expect(entry).toBeDefined();
      expect(entry?.key).toBe('name');
      expect(entry?.value).toBe('duan');
    });

    it('未传 options 时使用默认值 source/importance/tags', () => {
      pad.set('k', 'v');
      const entry = pad.get('k');
      expect(entry?.source).toBe('unknown');
      expect(entry?.importance).toBe(0.5);
      expect(entry?.tags).toEqual([]);
    });

    it('传入 options 时正确设置字段', () => {
      pad.set('k', 'v', {
        source: 'agent-1',
        importance: 0.9,
        tags: ['cred', 'hot'],
      });
      const entry = pad.get('k');
      expect(entry?.source).toBe('agent-1');
      expect(entry?.importance).toBe(0.9);
      expect(entry?.tags).toEqual(['cred', 'hot']);
    });

    it('createdAt 与 updatedAt 在新增时相同', () => {
      vi.useFakeTimers();
      vi.setSystemTime(1000000);
      pad.set('k', 'v');
      const entry = pad.get('k');
      expect(entry?.createdAt).toBe(1000000);
      expect(entry?.updatedAt).toBe(1000000);
    });

    it('更新已有条目时保留 key 和 createdAt', () => {
      vi.useFakeTimers();
      vi.setSystemTime(1000000);
      pad.set('k', 'v1', { source: 's1', importance: 0.3, tags: ['t1'] });

      vi.setSystemTime(2000000);
      pad.set('k', 'v2', { source: 's2', importance: 0.8, tags: ['t2'] });

      const entry = pad.get('k');
      expect(entry?.value).toBe('v2');
      expect(entry?.source).toBe('s2');
      expect(entry?.importance).toBe(0.8);
      expect(entry?.createdAt).toBe(1000000);
      expect(entry?.updatedAt).toBe(2000000);
    });

    it('更新条目时 tags 追加并去重', () => {
      pad.set('k', 'v', { tags: ['a', 'b'] });
      pad.set('k', 'v2', { tags: ['b', 'c'] });
      const entry = pad.get('k');
      expect(entry?.tags.sort()).toEqual(['a', 'b', 'c']);
    });

    it('更新条目时不传 tags 保留原有标签', () => {
      pad.set('k', 'v', { tags: ['a', 'b'] });
      pad.set('k', 'v2');
      const entry = pad.get('k');
      expect(entry?.tags).toEqual(['a', 'b']);
    });

    it('更新条目时不传 source/importance 保留原值', () => {
      pad.set('k', 'v', { source: 'src', importance: 0.7 });
      pad.set('k', 'v2');
      const entry = pad.get('k');
      expect(entry?.source).toBe('src');
      expect(entry?.importance).toBe(0.7);
    });

    it('get 不存在的 key 返回 undefined', () => {
      expect(pad.get('nope')).toBeUndefined();
    });
  });

  // ============ has 检查存在性 ============

  describe('has 检查存在性', () => {
    it('存在的 key 返回 true', () => {
      pad.set('k', 'v');
      expect(pad.has('k')).toBe(true);
    });

    it('不存在的 key 返回 false', () => {
      expect(pad.has('nope')).toBe(false);
    });

    it('删除后返回 false', () => {
      pad.set('k', 'v');
      pad.delete('k');
      expect(pad.has('k')).toBe(false);
    });
  });

  // ============ delete 删除条目 ============

  describe('delete 删除条目', () => {
    it('删除存在的条目返回 true', () => {
      pad.set('k', 'v');
      expect(pad.delete('k')).toBe(true);
      expect(pad.get('k')).toBeUndefined();
    });

    it('删除不存在的条目返回 false', () => {
      expect(pad.delete('nope')).toBe(false);
    });
  });

  // ============ getAll 获取所有 ============

  describe('getAll 获取所有', () => {
    it('空 scratchpad 返回空数组', () => {
      expect(pad.getAll()).toEqual([]);
    });

    it('返回所有条目', () => {
      pad.set('k1', 'v1');
      pad.set('k2', 'v2');
      const all = pad.getAll();
      expect(all).toHaveLength(2);
      const keys = all.map(e => e.key).sort();
      expect(keys).toEqual(['k1', 'k2']);
    });
  });

  // ============ getByTag 标签过滤 ============

  describe('getByTag 标签过滤', () => {
    beforeEach(() => {
      pad.set('k1', 'v1', { tags: ['credential', 'hot'] });
      pad.set('k2', 'v2', { tags: ['endpoint'] });
      pad.set('k3', 'v3', { tags: ['credential', 'cold'] });
    });

    it('返回匹配标签的条目', () => {
      const result = pad.getByTag('credential');
      expect(result).toHaveLength(2);
      const keys = result.map(e => e.key).sort();
      expect(keys).toEqual(['k1', 'k3']);
    });

    it('标签匹配不区分大小写', () => {
      const result = pad.getByTag('CREDENTIAL');
      expect(result).toHaveLength(2);
    });

    it('查询不存在的标签返回空数组', () => {
      expect(pad.getByTag('nope')).toEqual([]);
    });

    it('一个条目有多个标签时均可匹配', () => {
      expect(pad.getByTag('hot')).toHaveLength(1);
      expect(pad.getByTag('hot')[0].key).toBe('k1');
    });
  });

  // ============ search 模糊搜索 ============

  describe('search 模糊搜索', () => {
    beforeEach(() => {
      pad.set('db_host', 'localhost', { tags: ['endpoint'] });
      pad.set('api_key', 'sk-12345', { tags: ['credential'] });
      pad.set('version', '1.2.3', { tags: ['version'] });
    });

    it('按 key 部分匹配', () => {
      const result = pad.search('db');
      expect(result).toHaveLength(1);
      expect(result[0].key).toBe('db_host');
    });

    it('按 value 部分匹配', () => {
      const result = pad.search('sk-');
      expect(result).toHaveLength(1);
      expect(result[0].key).toBe('api_key');
    });

    it('按 tag 部分匹配', () => {
      const result = pad.search('cred');
      expect(result).toHaveLength(1);
      expect(result[0].key).toBe('api_key');
    });

    it('不区分大小写', () => {
      const result = pad.search('API_KEY');
      expect(result).toHaveLength(1);
      expect(result[0].key).toBe('api_key');
    });

    it('无匹配时返回空数组', () => {
      expect(pad.search('zzz')).toEqual([]);
    });

    it('空查询匹配所有', () => {
      expect(pad.search('')).toHaveLength(3);
    });
  });

  // ============ formatForPrompt 格式化输出 ============

  describe('formatForPrompt 格式化输出', () => {
    it('空 scratchpad 返回空字符串', () => {
      expect(pad.formatForPrompt()).toBe('');
    });

    it('输出以 [已知事实] 开头', () => {
      pad.set('k', 'v');
      const out = pad.formatForPrompt();
      expect(out.startsWith('[已知事实]')).toBe(true);
    });

    it('按重要性降序输出', () => {
      pad.set('low', 'v-low', { importance: 0.1 });
      pad.set('high', 'v-high', { importance: 0.9 });
      pad.set('mid', 'v-mid', { importance: 0.5 });
      const out = pad.formatForPrompt(10000);
      const lines = out.split('\n');
      // 第一行是 header，后续按重要性降序
      expect(lines[1]).toContain('high');
      expect(lines[2]).toContain('mid');
      expect(lines[3]).toContain('low');
    });

    it('输出包含 key 和 value', () => {
      pad.set('name', 'duan');
      const out = pad.formatForPrompt();
      expect(out).toContain('name: duan');
    });

    it('条目有标签时输出标签', () => {
      pad.set('k', 'v', { tags: ['tag1', 'tag2'] });
      const out = pad.formatForPrompt();
      expect(out).toContain('[tag1,tag2]');
    });

    it('条目无标签时不输出方括号', () => {
      pad.set('k', 'v');
      const out = pad.formatForPrompt();
      expect(out).not.toContain('[]');
    });

    it('token 预算不足时返回空字符串', () => {
      pad.set('k', 'v');
      // maxTokens 极小，连 header 都放不下任何条目
      expect(pad.formatForPrompt(1)).toBe('');
    });

    it('token 预算限制输出条目数', () => {
      // 每行 "- kN: vN" 约 2 token，header "[已知事实]" 约 4 token
      pad.set('k1', 'v1', { importance: 0.9 });
      pad.set('k2', 'v2', { importance: 0.5 });
      // maxTokens=7：header(4) + 一行(2) = 6，第二条 6+2=8 > 7 放不下
      const out = pad.formatForPrompt(7);
      const lines = out.split('\n');
      expect(lines.length).toBe(2); // header + 1 条目
      expect(lines[1]).toContain('k1');
    });
  });

  // ============ extractFromMessages 从消息提取事实 ============

  describe('extractFromMessages 从消息提取事实', () => {
    it('提取项目工具（中文）', () => {
      pad.extractFromMessages([
        { role: 'user', content: '项目使用pnpm 管理依赖' },
      ]);
      const all = pad.getAll();
      expect(all.length).toBeGreaterThanOrEqual(1);
      const entry = all.find(e => e.value === 'pnpm');
      expect(entry).toBeDefined();
      expect(entry?.source).toBe('auto_extract');
      expect(entry?.importance).toBe(0.7);
      expect(entry?.tags).toContain('project_tool');
    });

    it('提取项目工具（英文）', () => {
      pad.extractFromMessages([
        { role: 'user', content: 'The project uses cargo for building' },
      ]);
      const entry = pad.getAll().find(e => e.value === 'cargo');
      expect(entry).toBeDefined();
      expect(entry?.tags).toContain('project_tool');
    });

    it('提取凭证', () => {
      pad.extractFromMessages([
        { role: 'user', content: '密码是 abc123secret' },
      ]);
      const entry = pad.getAll().find(e => e.value === 'abc123secret');
      expect(entry).toBeDefined();
      expect(entry?.importance).toBe(0.9);
      expect(entry?.tags).toContain('credential');
    });

    it('提取端点', () => {
      pad.extractFromMessages([
        { role: 'user', content: '端口: 8080' },
      ]);
      const entry = pad.getAll().find(e => e.value === '8080');
      expect(entry).toBeDefined();
      expect(entry?.importance).toBe(0.8);
      expect(entry?.tags).toContain('endpoint');
    });

    it('提取版本号', () => {
      pad.extractFromMessages([
        { role: 'user', content: '版本: 1.2.3' },
      ]);
      const entry = pad.getAll().find(e => e.value === '1.2.3');
      expect(entry).toBeDefined();
      expect(entry?.importance).toBe(0.6);
      expect(entry?.tags).toContain('version');
    });

    it('提取路径', () => {
      pad.extractFromMessages([
        { role: 'user', content: '路径: /home/user/project' },
      ]);
      const entry = pad.getAll().find(e => e.value === '/home/user/project');
      expect(entry).toBeDefined();
      expect(entry?.tags).toContain('path');
    });

    it('提取配置', () => {
      pad.extractFromMessages([
        { role: 'user', content: '配置 timeout: 30' },
      ]);
      // config 模式有两个捕获组，value 取 match[1]
      const all = pad.getAll();
      expect(all.length).toBeGreaterThanOrEqual(1);
      const entry = all.find(e => e.tags.includes('config'));
      expect(entry).toBeDefined();
      expect(entry?.importance).toBe(0.7);
    });

    it('提取错误事实', () => {
      pad.extractFromMessages([
        { role: 'assistant', content: '错误: something went wrong here' },
      ]);
      const entry = pad.getAll().find(e => e.tags.includes('error_fact'));
      expect(entry).toBeDefined();
      expect(entry?.importance).toBe(0.8);
    });

    it('提取技术栈', () => {
      pad.extractFromMessages([
        { role: 'user', content: '框架: React' },
      ]);
      const entry = pad.getAll().find(e => e.tags.includes('tech_stack'));
      expect(entry).toBeDefined();
      expect(entry?.importance).toBe(0.7);
    });

    it('提取环境信息', () => {
      pad.extractFromMessages([
        { role: 'user', content: '环境: Linux' },
      ]);
      const entry = pad.getAll().find(e => e.tags.includes('environment'));
      expect(entry).toBeDefined();
      expect(entry?.importance).toBe(0.6);
    });

    it('只处理 user 和 assistant 消息', () => {
      pad.extractFromMessages([
        { role: 'system', content: '密码是 secret123' },
        { role: 'tool', content: '密码是 secret456' },
      ]);
      expect(pad.getAll()).toEqual([]);
    });

    it('避免重复提取相同事实', () => {
      const msg: ChatMessage = { role: 'user', content: '端口: 8080' };
      pad.extractFromMessages([msg, msg, msg]);
      const endpoints = pad.getByTag('endpoint');
      expect(endpoints).toHaveLength(1);
    });

    it('一条消息可匹配多个模式', () => {
      pad.extractFromMessages([
        {
          role: 'user',
          content: '项目使用pnpm，端口: 3000，版本: 2.0.0',
        },
      ]);
      const all = pad.getAll();
      expect(all.length).toBeGreaterThanOrEqual(2);
    });

    it('空消息数组不报错', () => {
      expect(() => pad.extractFromMessages([])).not.toThrow();
      expect(pad.getAll()).toEqual([]);
    });

    it('无匹配内容时不提取', () => {
      pad.extractFromMessages([
        { role: 'user', content: '今天天气不错' },
      ]);
      expect(pad.getAll()).toEqual([]);
    });
  });

  // ============ clearExpired 清除过期 ============

  describe('clearExpired 清除过期', () => {
    it('清除超过默认 24 小时的条目', () => {
      vi.useFakeTimers();
      const now = 1000000000000; // 固定基准时间
      vi.setSystemTime(now);
      pad.set('old', 'v1');

      // 推进 25 小时
      vi.setSystemTime(now + 25 * 60 * 60 * 1000);
      pad.set('new', 'v2');

      const removed = pad.clearExpired();
      expect(removed).toBe(1);
      expect(pad.has('old')).toBe(false);
      expect(pad.has('new')).toBe(true);
    });

    it('自定义 maxAge', () => {
      vi.useFakeTimers();
      const now = 1000000000000;
      vi.setSystemTime(now);
      pad.set('old', 'v1');

      // 推进 5 秒
      vi.setSystemTime(now + 5000);
      pad.set('new', 'v2');

      // maxAge = 3 秒，old 条目已过期
      const removed = pad.clearExpired(3000);
      expect(removed).toBe(1);
      expect(pad.has('old')).toBe(false);
      expect(pad.has('new')).toBe(true);
    });

    it('无过期条目时返回 0', () => {
      vi.useFakeTimers();
      const now = 1000000000000;
      vi.setSystemTime(now);
      pad.set('k', 'v');
      vi.setSystemTime(now + 1000);
      expect(pad.clearExpired()).toBe(0);
      expect(pad.has('k')).toBe(true);
    });

    it('空 scratchpad 返回 0', () => {
      expect(pad.clearExpired()).toBe(0);
    });

    it('更新条目后 updatedAt 刷新，过期时间重新计算', () => {
      vi.useFakeTimers();
      const now = 1000000000000;
      vi.setSystemTime(now);
      pad.set('k', 'v1');

      // 推进 10 秒后更新
      vi.setSystemTime(now + 10000);
      pad.set('k', 'v2');

      // 再推进 10 秒，总时间 20 秒，但 updatedAt 是 10 秒前
      vi.setSystemTime(now + 20000);
      // maxAge = 15 秒：createdAt 距今 20 秒，但 updatedAt 距今 10 秒，未过期
      expect(pad.clearExpired(15000)).toBe(0);
      expect(pad.has('k')).toBe(true);
    });
  });

  // ============ toJSON / fromJSON 序列化 ============

  describe('toJSON / fromJSON 序列化', () => {
    it('toJSON 返回包含 version 和 entries 的对象', () => {
      pad.set('k1', 'v1', { tags: ['t1'] });
      const json = pad.toJSON() as any;
      expect(json.version).toBe(1);
      expect(Array.isArray(json.entries)).toBe(true);
      expect(json.entries).toHaveLength(1);
      expect(json.entries[0].key).toBe('k1');
      expect(json.entries[0].value).toBe('v1');
      expect(json.entries[0].tags).toEqual(['t1']);
    });

    it('fromJSON 恢复条目', () => {
      const data = {
        version: 1,
        entries: [
          {
            key: 'k1',
            value: 'v1',
            source: 'src',
            importance: 0.8,
            createdAt: 1000,
            updatedAt: 2000,
            tags: ['t1', 't2'],
          },
        ],
      };
      pad.fromJSON(data);
      const entry = pad.get('k1');
      expect(entry).toBeDefined();
      expect(entry?.value).toBe('v1');
      expect(entry?.source).toBe('src');
      expect(entry?.importance).toBe(0.8);
      expect(entry?.createdAt).toBe(1000);
      expect(entry?.updatedAt).toBe(2000);
      expect(entry?.tags).toEqual(['t1', 't2']);
    });

    it('fromJSON 后再 toJSON 数据一致', () => {
      pad.set('k1', 'v1', { source: 's1', importance: 0.7, tags: ['a'] });
      pad.set('k2', 'v2', { source: 's2', importance: 0.3, tags: ['b'] });
      const json1 = pad.toJSON();

      const pad2 = new Scratchpad();
      pad2.fromJSON(json1);
      const json2 = pad2.toJSON();

      expect(json2).toEqual(json1);
    });

    it('fromJSON 清除原有条目', () => {
      pad.set('old', 'v');
      pad.fromJSON({ version: 1, entries: [{ key: 'new', value: 'v' }] });
      expect(pad.has('old')).toBe(false);
      expect(pad.has('new')).toBe(true);
    });

    it('fromJSON 传入 null/undefined 不报错', () => {
      expect(() => pad.fromJSON(null)).not.toThrow();
      expect(() => pad.fromJSON(undefined)).not.toThrow();
      expect(pad.getAll()).toEqual([]);
    });

    it('fromJSON 传入无 entries 数组的对象不报错', () => {
      expect(() => pad.fromJSON({ version: 1 })).not.toThrow();
      expect(() => pad.fromJSON({})).not.toThrow();
    });

    it('fromJSON 跳过无 key 的条目', () => {
      pad.fromJSON({
        version: 1,
        entries: [
          { value: 'no-key' },
          { key: 'valid', value: 'has-key' },
        ],
      });
      expect(pad.getAll()).toHaveLength(1);
      expect(pad.has('valid')).toBe(true);
    });

    it('fromJSON 缺失 value 时默认空字符串', () => {
      pad.fromJSON({
        version: 1,
        entries: [{ key: 'k', source: 's' }],
      });
      expect(pad.get('k')?.value).toBe('');
    });

    it('fromJSON 缺失 source 时默认 unknown', () => {
      pad.fromJSON({
        version: 1,
        entries: [{ key: 'k', value: 'v' }],
      });
      expect(pad.get('k')?.source).toBe('unknown');
    });

    it('fromJSON 缺失 importance 时默认 0.5', () => {
      pad.fromJSON({
        version: 1,
        entries: [{ key: 'k', value: 'v' }],
      });
      expect(pad.get('k')?.importance).toBe(0.5);
    });

    it('fromJSON importance 超出 [0,1] 时被截断', () => {
      pad.fromJSON({
        version: 1,
        entries: [
          { key: 'high', value: 'v', importance: 5 },
          { key: 'low', value: 'v', importance: -3 },
        ],
      });
      expect(pad.get('high')?.importance).toBe(1);
      expect(pad.get('low')?.importance).toBe(0);
    });

    it('fromJSON importance 非数字时使用默认值', () => {
      pad.fromJSON({
        version: 1,
        entries: [{ key: 'k', value: 'v', importance: 'abc' }],
      });
      expect(pad.get('k')?.importance).toBe(0.5);
    });

    it('fromJSON 缺失 tags 时默认空数组', () => {
      pad.fromJSON({
        version: 1,
        entries: [{ key: 'k', value: 'v' }],
      });
      expect(pad.get('k')?.tags).toEqual([]);
    });

    it('fromJSON tags 非数组时默认空数组', () => {
      pad.fromJSON({
        version: 1,
        entries: [{ key: 'k', value: 'v', tags: 'not-array' }],
      });
      expect(pad.get('k')?.tags).toEqual([]);
    });

    it('fromJSON 缺失时间戳时使用当前时间', () => {
      vi.useFakeTimers();
      vi.setSystemTime(1234567890);
      pad.fromJSON({
        version: 1,
        entries: [{ key: 'k', value: 'v' }],
      });
      const entry = pad.get('k');
      expect(entry?.createdAt).toBe(1234567890);
      expect(entry?.updatedAt).toBe(1234567890);
    });
  });

  // ============ estimateTokens 估算 token ============

  describe('estimateTokens 估算 token', () => {
    it('空 scratchpad 返回 0', () => {
      expect(pad.estimateTokens()).toBe(0);
    });

    it('有条目时返回正数', () => {
      pad.set('k', 'v');
      expect(pad.estimateTokens()).toBeGreaterThan(0);
    });

    it('条目越多 token 越多', () => {
      pad.set('k1', 'v1');
      const t1 = pad.estimateTokens();
      pad.set('k2', 'v2', { tags: ['tag1'] });
      const t2 = pad.estimateTokens();
      expect(t2).toBeGreaterThan(t1);
    });
  });

  // ============ 容量上限淘汰 ============

  describe('容量上限淘汰', () => {
    it('达到 100 条后新增触发淘汰，总数仍为 100', () => {
      // 填满 100 条
      for (let i = 0; i < 100; i++) {
        pad.set(`k${i}`, `v${i}`, { importance: 0.5 });
      }
      expect(pad.getAll()).toHaveLength(100);

      // 新增第 101 条
      pad.set('k100', 'v100', { importance: 0.6 });
      expect(pad.getAll()).toHaveLength(100);
      // 新条目存在
      expect(pad.has('k100')).toBe(true);
    });

    it('淘汰最低重要性的条目', () => {
      // 99 条高重要性
      for (let i = 0; i < 99; i++) {
        pad.set(`high${i}`, `v${i}`, { importance: 0.9 });
      }
      // 1 条低重要性
      pad.set('low', 'v', { importance: 0.1 });

      // 新增一条中等重要性
      pad.set('mid', 'v', { importance: 0.5 });

      // 低重要性条目被淘汰
      expect(pad.has('low')).toBe(false);
      expect(pad.has('mid')).toBe(true);
      expect(pad.getAll()).toHaveLength(100);
    });

    it('重要性相同时淘汰最旧的', () => {
      vi.useFakeTimers();
      const base = 1000000000000;

      // 第一条（最旧）
      vi.setSystemTime(base);
      pad.set('oldest', 'v', { importance: 0.5 });

      // 中间 98 条
      vi.setSystemTime(base + 1000);
      for (let i = 0; i < 98; i++) {
        pad.set(`mid${i}`, 'v', { importance: 0.5 });
      }

      // 最后一条（最新）
      vi.setSystemTime(base + 2000);
      pad.set('newest', 'v', { importance: 0.5 });

      // 现在 100 条，新增第 101 条触发淘汰
      vi.setSystemTime(base + 3000);
      pad.set('trigger', 'v', { importance: 0.5 });

      // 最旧的条目被淘汰
      expect(pad.has('oldest')).toBe(false);
      expect(pad.has('trigger')).toBe(true);
      expect(pad.getAll()).toHaveLength(100);
    });

    it('淘汰后高重要性条目保留', () => {
      for (let i = 0; i < 100; i++) {
        pad.set(`k${i}`, `v${i}`, { importance: 0.5 });
      }
      // 新增高重要性条目
      pad.set('important', 'v', { importance: 1.0 });
      expect(pad.has('important')).toBe(true);
      // 总数仍为 100
      expect(pad.getAll()).toHaveLength(100);
    });
  });

  // ============ 边界情况 ============

  describe('边界情况', () => {
    it('空字符串作为 key', () => {
      pad.set('', 'empty-key');
      expect(pad.get('')?.value).toBe('empty-key');
    });

    it('空字符串作为 value', () => {
      pad.set('k', '');
      expect(pad.get('k')?.value).toBe('');
    });

    it('importance 为 0', () => {
      pad.set('k', 'v', { importance: 0 });
      expect(pad.get('k')?.importance).toBe(0);
    });

    it('importance 为 1', () => {
      pad.set('k', 'v', { importance: 1 });
      expect(pad.get('k')?.importance).toBe(1);
    });

    it('空 tags 数组', () => {
      pad.set('k', 'v', { tags: [] });
      expect(pad.get('k')?.tags).toEqual([]);
    });

    it('重复 set 同一 key 不增加条目数', () => {
      pad.set('k', 'v1');
      pad.set('k', 'v2');
      pad.set('k', 'v3');
      expect(pad.getAll()).toHaveLength(1);
      expect(pad.get('k')?.value).toBe('v3');
    });

    it('delete 后可重新 set', () => {
      pad.set('k', 'v1', { importance: 0.9 });
      pad.delete('k');
      pad.set('k', 'v2', { importance: 0.1 });
      const entry = pad.get('k');
      expect(entry?.value).toBe('v2');
      expect(entry?.importance).toBe(0.1);
    });

    it('getByTag 空字符串标签', () => {
      pad.set('k', 'v', { tags: [''] });
      expect(pad.getByTag('')).toHaveLength(1);
    });

    it('search 特殊字符查询不报错', () => {
      pad.set('k', 'v');
      expect(() => pad.search('[')).not.toThrow();
      expect(() => pad.search('(')).not.toThrow();
      expect(() => pad.search('*')).not.toThrow();
    });

    it('formatForPrompt 默认 maxTokens=800', () => {
      // 验证默认参数不报错
      pad.set('k', 'v');
      const out = pad.formatForPrompt();
      expect(out).toContain('k: v');
    });

    it('多条目 formatForPrompt 输出完整', () => {
      for (let i = 0; i < 10; i++) {
        pad.set(`k${i}`, `v${i}`, { importance: 0.5 });
      }
      const out = pad.formatForPrompt(10000);
      const lines = out.split('\n');
      // 1 header + 10 条目
      expect(lines).toHaveLength(11);
    });

    it('fromJSON 后可继续 set 操作', () => {
      pad.fromJSON({
        version: 1,
        entries: [{ key: 'old', value: 'v' }],
      });
      pad.set('new', 'v2');
      expect(pad.has('old')).toBe(true);
      expect(pad.has('new')).toBe(true);
    });

    it('fromJSON 后可继续 extractFromMessages', () => {
      pad.fromJSON({
        version: 1,
        entries: [{ key: 'old', value: 'v' }],
      });
      pad.extractFromMessages([{ role: 'user', content: '端口: 8080' }]);
      expect(pad.has('old')).toBe(true);
      expect(pad.getByTag('endpoint')).toHaveLength(1);
    });
  });
});
