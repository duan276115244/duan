import type { UnifiedToolDef } from '../../core/unified-tool-def.js';

export const browserTools: UnifiedToolDef[] = [
  {
    name: 'browser_operate',
    description: '交互式浏览器操控。标准操作流程：1)goto打开页面 2)screenshot截图查看页面 3)extract提取页面文本 4)根据页面内容click/type操作 5)wait_for_change等待响应 6)screenshot验证结果。关键规则：1.每次goto后必须先screenshot+extract查看页面再操作 2.click/type后必须wait_for_change 3.selector优先用文本内容如"登录""搜索" 4.遇到登录页：先screenshot确认，然后click点击登录按钮，如果需要扫码则告知用户"请在弹出的浏览器窗口中扫码登录"，然后wait_for_change等待登录完成 5.不要用evaluate操作DOM，只用于读取信息 6.找不到元素时先extract查看页面结构再定位',
    readOnly: false,
    parameters: {
      action: { type: 'string', description: '操作: goto/click/type/screenshot/extract/info/wait/wait_for_change/press/evaluate', required: true },
      url: { type: 'string', description: 'goto时的URL', required: false },
      selector: { type: 'string', description: 'CSS选择器或文本内容(click/type/wait时使用)', required: false },
      text: { type: 'string', description: '输入文字(type)或JS代码(evaluate)', required: false },
      filepath: { type: 'string', description: '截图保存路径(可选)', required: false },
      key: { type: 'string', description: '按键: Enter/Tab/Escape/Control+a等', required: false },
      timeout: { type: 'number', description: '超时毫秒(默认30000)', required: false },
    },
    execute: async (rawArgs) => {
      let args = rawArgs;
      if (typeof args.action === 'string' && args.action.startsWith('{')) {
        try {
          const parsed = JSON.parse(args.action);
          if (parsed.action && typeof parsed.action === 'string') {
            args = { ...args, ...parsed };
          }
        } catch {}
      }
      if (typeof args.action === 'string' && args.action.includes(' ') && !args.url && !args.selector) {
        const parts = args.action.split(' ');
        const act = parts[0];
        const rest = parts.slice(1).join(' ');
        if (['goto', 'click', 'type', 'navigate', 'open'].includes(act)) {
          args = { ...args, action: act, url: rest };
        }
      }
      const { browserGoto, browserClick, browserType, browserScreenshot, browserExtract, browserInfo, browserWait, browserPress, browserEvaluate } = await import('../../utils/browser-operator.js');
      const action = args.action as string;
      const timeout = (args.timeout as number) || 30000;
      switch (action) {
        case 'goto': {
          if (!args.url) return '❌ 需要提供 url 参数';
          const r = await browserGoto(args.url as string, timeout);
          return r.success ? r.data! : `❌ ${r.error}`;
        }
        case 'click': {
          if (!args.selector) return '❌ 需要提供 selector 参数';
          const r = await browserClick(args.selector as string);
          return r.success ? r.data! : `❌ ${r.error}`;
        }
        case 'type': {
          if (!args.selector) return '❌ 需要提供 selector 参数';
          if (!args.text && args.text !== '') return '❌ 需要提供 text 参数';
          const r = await browserType(args.selector as string, args.text as string);
          return r.success ? r.data! : `❌ ${r.error}`;
        }
        case 'screenshot': {
          const r = await browserScreenshot(args.filepath as string);
          return r.success ? r.data! : `❌ ${r.error}`;
        }
        case 'extract': {
          const r = await browserExtract();
          return r.success ? r.data! : `❌ ${r.error}`;
        }
        case 'info': {
          const r = await browserInfo();
          return r.success ? r.data! : `❌ ${r.error}`;
        }
        case 'wait': {
          if (!args.selector) return '❌ 需要提供 selector 参数';
          const r = await browserWait(args.selector as string, timeout);
          return r.success ? r.data! : `❌ ${r.error}`;
        }
        case 'wait_for_change': {
          const { browserWaitForChange } = await import('../../utils/browser-operator.js');
          const waitMs = typeof args.timeout === 'number' ? args.timeout : 2000;
          const r = await browserWaitForChange(waitMs);
          return r.success ? r.data! : `❌ ${r.error}`;
        }
        case 'press': {
          if (!args.key) return '❌ 需要提供 key 参数';
          const r = await browserPress(args.key as string);
          return r.success ? r.data! : `❌ ${r.error}`;
        }
        case 'evaluate': {
          if (!args.text) return '❌ 需要提供 text 参数(JS代码)';
          const r = await browserEvaluate(args.text as string);
          return r.success ? r.data! : `❌ ${r.error}`;
        }
        default:
          return `❌ 未知操作: ${action}`;
      }
    },
  },
];
