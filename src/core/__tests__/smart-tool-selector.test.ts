/**
 * SmartToolSelector 命中率测试套件
 *
 * 验证两个核心环节的命中率：
 * 1. inferIntent — 用户输入能否被正确分类到 7 个意图之一
 *    （错误分类会导致下游 selectTools 过滤掉正确工具类别）
 * 2. selectTools — 给定意图后，对应类别的关键工具是否被保留
 *    （essentialsByIntent 中的死引用会导致 LLM 看不到关键工具）
 *
 * 命中率口径：
 * - 单条用例：inferIntent(input) === expected
 * - 整体命中率 = 命中数 / 总用例数，阈值 ≥ 80%
 * - 未命中清单会通过 console.log 输出，便于定位关键词缺口
 */

import { describe, it, expect } from 'vitest';
import { SmartToolSelector, type TaskIntent, type ToolDefinition } from '../smart-tool-selector.js';

// ============ 命中率用例集 ============

interface IntentCase {
  input: string;
  expected: TaskIntent;
  category: string;
  note?: string; // 已知缺陷标注，便于跟踪
}

/**
 * 33 个用例覆盖 7 个意图类别
 *
 * 设计原则：
 * - 每个意图至少 3 个用例
 * - 包含 project_memory 中已修复的 P0 场景（社交通讯 → desktop）
 * - 包含已知同义词缺口场景（截屏/录音/办公应用名）
 * - 包含混合意图边界场景（"打开 Excel" 同时含 browse 的"打开"和 file 的"excel"）
 */
const INTENT_CASES: IntentCase[] = [
  // ---- code (5) ----
  { input: '写一个 Python 函数计算斐波那契', expected: 'code', category: 'code' },
  { input: '调试这段代码的 bug', expected: 'code', category: 'code' },
  { input: '运行 main.py', expected: 'code', category: 'code' },
  { input: '重构这个类提取接口', expected: 'code', category: 'code' },
  { input: '修复登录失败的 bug', expected: 'code', category: 'code' },

  // ---- browse (5) ----
  { input: '打开浏览器访问 github.com', expected: 'browse', category: 'browse' },
  { input: '浏览网页 https://example.com', expected: 'browse', category: 'browse' },
  { input: '抓取这个 URL 的内容', expected: 'browse', category: 'browse' },
  { input: '在浏览器打开 google 搜索', expected: 'browse', category: 'browse' },
  { input: '把网页转成 markdown', expected: 'browse', category: 'browse' },

  // ---- desktop (10) — 社交通讯 + 桌面操作 + 系统设置 ----
  { input: '打开微信', expected: 'desktop', category: 'desktop-social' },
  { input: '发朋友圈', expected: 'desktop', category: 'desktop-social' },
  { input: '用钉钉发消息给张三', expected: 'desktop', category: 'desktop-social' },
  { input: '打开飞书开会', expected: 'desktop', category: 'desktop-social' },
  { input: '打开 QQ 聊天', expected: 'desktop', category: 'desktop-social' },
  { input: '截屏当前屏幕', expected: 'desktop', category: 'desktop-ops', note: '同义词缺口：仅有"截图"' },
  { input: '结束占用 CPU 的进程', expected: 'desktop', category: 'desktop-ops' },
  { input: '开启免打扰模式', expected: 'desktop', category: 'desktop-ops', note: '系统设置词缺口' },
  { input: '用 PS 修图加滤镜', expected: 'desktop', category: 'desktop-ops' },
  { input: '录音 5 秒', expected: 'desktop', category: 'desktop-ops', note: '语音类词缺口' },

  // ---- search (3) ----
  { input: '搜索人工智能最新进展', expected: 'search', category: 'search' },
  { input: 'google 一下 Vue 3 文档', expected: 'search', category: 'search' },
  { input: '百度搜索今天天气', expected: 'search', category: 'search' },

  // ---- file (5) ----
  { input: '读取 config.json 文件', expected: 'file', category: 'file' },
  { input: '创建新文件 notes.md', expected: 'file', category: 'file' },
  { input: '合并多个 PDF', expected: 'file', category: 'file' },
  { input: 'OCR 识别图片中的文字', expected: 'file', category: 'file' },
  { input: '打开 Excel 分析数据', expected: 'file', category: 'file', note: '混合边界：browse的"打开"会竞争' },

  // ---- chat (3) ----
  { input: '你好', expected: 'chat', category: 'chat' },
  { input: '翻译这段话成英文', expected: 'chat', category: 'chat' },
  { input: '帮我写个简历', expected: 'chat', category: 'chat' },

  // ---- self_modify (2) ----
  { input: '自我进化提升能力', expected: 'self_modify', category: 'self_modify' },
  { input: '自我修复这个错误', expected: 'self_modify', category: 'self_modify' },
];

// ============ 测试 ============

describe('SmartToolSelector', () => {
  const selector = new SmartToolSelector();

  describe('inferIntent 单用例可见性', () => {
    for (const c of INTENT_CASES) {
      it(`[${c.category}] "${c.input}" → ${c.expected}${c.note ? ` (已知: ${c.note})` : ''}`, () => {
        const actual = selector.inferIntent(c.input);
        expect(actual).toBe(c.expected);
      });
    }
  });

  describe('inferIntent 整体命中率', () => {
    it('命中率 ≥ 80%（输出未命中清单辅助定位）', () => {
      const results = INTENT_CASES.map(c => {
        const actual = selector.inferIntent(c.input);
        return { input: c.input, expected: c.expected, actual, hit: actual === c.expected };
      });

      const hits = results.filter(r => r.hit).length;
      const hitRate = hits / results.length;
      const misses = results.filter(r => !r.hit);

      if (misses.length > 0) {
        // eslint-disable-next-line no-console
        console.log(
          '\n[命中率诊断] 命中 %d/%d (%.1f%%)\n未命中清单:\n%s',
          hits,
          results.length,
          hitRate * 100,
          misses.map(m => `  ✗ "${m.input}" 期望=${m.expected} 实际=${m.actual}`).join('\n'),
        );
      }

      expect(hitRate).toBeGreaterThanOrEqual(0.80);
    });

    it('社交通讯 5 个用例 100% 命中 desktop（project_memory P0 契约）', () => {
      const socialCases = INTENT_CASES.filter(c => c.category === 'desktop-social');
      const hits = socialCases.filter(c => selector.inferIntent(c.input) === 'desktop').length;
      // 社交通讯是 P0 修复点，不允许回退
      expect(hits).toBe(socialCases.length);
    });
  });

  describe('selectTools 关键工具覆盖', () => {
    /**
     * 构造一个包含 BUILTIN_TOOL_METAS 全部工具名的 allTools 数组
     * 用 description 模拟真实场景，让 computeRelevanceScore 也能工作
     */
    function buildAllTools(names: string[]): ToolDefinition[] {
      return names.map(name => ({
        name,
        description: `${name} tool for ${name.split('_').join(' ')}`,
        parameters: {},
      }));
    }

    // 关键工具名（与 smart-tool-selector.ts 内置元信息一致）
    // 注意：故意不含 app_operate —— 它在 essentialsByIntent.desktop 中被声明但不在
    // BUILTIN_TOOL_METAS，是死引用。下方有专门测试覆盖此契约。
    const KEY_TOOL_NAMES = [
      'file_read', 'file_write', 'list_directory', 'search_files',
      'browser_operate', 'web_fetch', 'web_search', 'http_request',
      'desktop_open', 'screen_capture', 'screen_click', 'screen_type', 'screen_key',
      'app_launch', 'app_click', 'app_type', 'app_smart',
      'wechat_open', 'wechat_send_message', 'wechat_post_moments',
      'code_execute', 'shell_execute',
      'memory_search', 'memory_store',
      'create_plan', 'complete',
      'self_read', 'self_evolve',
    ];

    const allTools = buildAllTools(KEY_TOOL_NAMES);

    it('desktop 意图必须暴露 screen_capture（不能误开 browser_operate）', () => {
      const selected = selector.selectTools('desktop', allTools);
      const names = selected.map(t => t.name);
      expect(names).toContain('screen_capture');
    });

    it('desktop 意图必须暴露 wechat_* 系列工具', () => {
      const selected = selector.selectTools('desktop', allTools);
      const names = selected.map(t => t.name);
      // 至少一个微信工具应被保留（desktop 类别）
      const wechatTools = names.filter(n => n.startsWith('wechat_'));
      expect(wechatTools.length).toBeGreaterThan(0);
    });

    it('browse 意图必须暴露 browser_operate', () => {
      const selected = selector.selectTools('browse', allTools);
      const names = selected.map(t => t.name);
      expect(names).toContain('browser_operate');
    });

    it('code 意图必须暴露 file_read 和 code_execute', () => {
      const selected = selector.selectTools('code', allTools);
      const names = selected.map(t => t.name);
      expect(names).toContain('file_read');
      expect(names).toContain('code_execute');
    });

    it('search 意图必须暴露 web_search', () => {
      const selected = selector.selectTools('search', allTools);
      const names = selected.map(t => t.name);
      expect(names).toContain('web_search');
    });

    it('essentialsByIntent.desktop 不应含死引用 app_operate（不在 BUILTIN_TOOL_METAS）', () => {
      // app_operate 在 essentialsByIntent.desktop 中被声明但不在 BUILTIN_TOOL_METAS
      // 即使 allTools 不含 app_operate，selectTools 也会因 find() 返回 undefined 而静默跳过
      // —— 但这是隐性 bug：essentials 列表声明了不存在的工具，浪费一次查找且容易误导维护者
      // 此处通过"allTools 不含 app_operate 时结果也不应含"做正向验证
      const selected = selector.selectTools('desktop', allTools);
      const names = selected.map(t => t.name);
      expect(names).not.toContain('app_operate');
      // 同时验证 desktop 意图确实有合理工具暴露（避免空结果误判通过）
      expect(names.length).toBeGreaterThan(0);
      expect(names).toContain('complete'); // 必备工具
    });

    it('当 allTools 含 app_operate 时不应被 essentials 强制塞回（死引用应被修复）', () => {
      // 这是真正的死引用 bug 检测：
      // 现状：essentialsByIntent.desktop 含 'app_operate'，selectTools 的 essentials 循环会
      //   把 allTools 中的 app_operate 推回 filtered，绕过元信息过滤
      // 修复后契约：essentialsByIntent.desktop 不应再声明 app_operate，因此即使 allTools
      //   含 app_operate，它也不应出现在结果中（因无元信息在 desktop 意图下被过滤）
      const allToolsWithDeadRef = buildAllTools([...KEY_TOOL_NAMES, 'app_operate']);
      const selected = selector.selectTools('desktop', allToolsWithDeadRef);
      const names = selected.map(t => t.name);
      expect(names).not.toContain('app_operate');
    });
  });

  describe('失败追踪与替代建议', () => {
    it('markFailed 累计 3 次后工具被排除（除非 includeFailed=true）', () => {
      const sel = new SmartToolSelector();
      const allTools: ToolDefinition[] = [
        { name: 'browser_operate', description: 'browse', parameters: {} },
        { name: 'web_search', description: 'search', parameters: {} },
      ];
      // 累计失败 3 次
      sel.markFailed('browser_operate');
      sel.markFailed('browser_operate');
      sel.markFailed('browser_operate');
      const filtered = sel.selectTools('browse', allTools);
      expect(filtered.map(t => t.name)).not.toContain('browser_operate');

      // includeFailed=true 仍然保留
      const withFailed = sel.selectTools('browse', allTools, { includeFailed: true });
      expect(withFailed.map(t => t.name)).toContain('browser_operate');
    });

    it('markSuccess 清除失败计数', () => {
      const sel = new SmartToolSelector();
      const allTools: ToolDefinition[] = [
        { name: 'browser_operate', description: 'browse', parameters: {} },
      ];
      sel.markFailed('browser_operate');
      sel.markFailed('browser_operate');
      sel.markSuccess('browser_operate');
      const filtered = sel.selectTools('browse', allTools);
      expect(filtered.map(t => t.name)).toContain('browser_operate');
    });
  });
});
