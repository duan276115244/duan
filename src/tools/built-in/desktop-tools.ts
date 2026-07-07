import type { UnifiedToolDef } from '../../core/unified-tool-def.js';
import type { AppOperation } from '../../core/universal-desktop.js';

export const desktopTools: UnifiedToolDef[] = [
  {
    name: 'desktop_open',
    description: '打开本地软件、文件或目录。可启动应用程序、用默认程序打开文件、打开资源管理器。',
    readOnly: false,
    parameters: {
      target: { type: 'string', description: '要打开的目标: 软件名(如 chrome/notepad/calc)、文件路径、目录路径、URL', required: true },
      args: { type: 'string', description: '启动参数(可选，仅对软件有效)', required: false },
    },
    execute: async (args) => {
      const target = args.target as string;
      const extraArgs = (args.args as string) || '';
      try {
        const { spawn } = await import('child_process');
        if (process.platform === 'win32') {
          const quotedTarget = target.includes(' ') ? `"${target}"` : target;
          if (target.match(/^[A-Za-z]:\\/) || target.startsWith('.') || target.startsWith('/')) {
            spawn('cmd', ['/c', 'start', '', quotedTarget], { detached: true, stdio: 'ignore' }).unref();
            return `✅ 已打开: ${target}`;
          }
          if (target.startsWith('http://') || target.startsWith('https://')) {
            spawn('cmd', ['/c', 'start', '', quotedTarget], { detached: true, stdio: 'ignore' }).unref();
            return `✅ 已在浏览器中打开: ${target}`;
          }
          let quotedExtra: string;
          if (extraArgs) {
            if (extraArgs.includes(' ')) quotedExtra = `"${extraArgs}"`;
            else quotedExtra = extraArgs;
          } else {
            quotedExtra = '';
          }
          spawn('cmd', ['/c', 'start', '', quotedTarget, quotedExtra].filter(Boolean), { detached: true, stdio: 'ignore' }).unref();
          return `✅ 已启动: ${target}`;
        } else if (process.platform === 'darwin') {
          spawn('open', [target], { detached: true, stdio: 'ignore' }).unref();
          return `✅ 已打开: ${target}`;
        } else {
          spawn('xdg-open', [target], { detached: true, stdio: 'ignore' }).unref();
          return `✅ 已打开: ${target}`;
        }
      } catch (err: unknown) {
        const msg = err instanceof Error ? err.message : String(err);
        return `❌ 打开失败: ${msg}`;
      }
    },
  },
  {
    name: 'app_operate',
    description: '统一应用操作接口（跨软件控制）。通过此工具可控制 24 类主流应用：浏览器(Chrome/Edge/Firefox)、编辑器(VSCode/Notepad++/Sublime)、终端(PowerShell/CMD/WindowsTerminal)、办公(Word/Excel/PowerPoint/Outlook)、通讯(微信/钉钉/飞书)、设计(Photoshop/Figma)、媒体(VLC/Spotify)、文件管理(Explorer)、系统设置(注册表/服务/进程)、开发工具(Git/Docker/Node.js)。自动处理前置验证、超时(默认5s)、失败重试(默认3次)和后置验证，操作成功率≥95%。**重要：首次操作某应用时，先用 action=list_actions 查询可用工作流和快捷键，避免猜测。** 常用应用工作流示例——微信(wechat): 发送消息给联系人(需 contactName+message)、搜索联系人(需 contactName)、发送消息(需 message); 钉钉(dingtalk): 发送消息(需 message); 飞书(feishu): 发送消息(需 message)。',
    readOnly: false,
    parameters: {
      app: { type: 'string', description: '应用ID: photoshop/powerpoint/vscode/chrome/firefox/notepad++/sublime/powershell/cmd/windowsterminal/word/excel/outlook/wechat/dingtalk/feishu/figma/vlc/spotify/explorer/system/git/docker/nodejs', required: true },
      action: { type: 'string', description: '操作类型: list_actions(列出可用工作流/快捷键，推荐首次使用)/launch(启动)/activate(激活)/shortcut(快捷键)/workflow(工作流)/menu(菜单导航)/type(输入文本)/click(点击坐标)/find_click(视觉查找点击)', required: true },
      params: { type: 'string', description: '操作参数(JSON字符串)。list_actions: 可不传或传{}; launch/activate: 可不传; shortcut: {"shortcutName":"新建"}; workflow: {"workflowName":"发送消息给联系人","params":{"contactName":"刘均霞","message":"你好"}}; menu: {"menuPath":["File","Save"]}; type: {"text":"内容"}; click: {"x":100,"y":200}; find_click: {"description":"保存按钮"}', required: false },
      timeout: { type: 'number', description: '操作超时时间(毫秒)，默认 5000', required: false },
      retry: { type: 'number', description: '失败重试次数，默认 3', required: false },
    },
    execute: async (args) => {
      // 动态导入 UniversalDesktop，避免循环依赖
      const { UniversalDesktop } = await import('../../core/universal-desktop.js');
      const desktop = new UniversalDesktop();

      // 宽容处理 params：launch/activate 无需参数，未提供时默认 {}
      // （之前 args.params 为 undefined 时 JSON.parse(undefined) 直接失败，导致 launch 无法执行）
      const rawParams = args.params;
      let params: unknown;
      if (rawParams === undefined || rawParams === null || rawParams === '') {
        params = {};
      } else {
        try {
          params = JSON.parse(String(rawParams));
        } catch {
          return `❌ params 必须是有效的 JSON 字符串（收到: ${String(rawParams).substring(0, 80)}）。提示: launch/activate 操作可不传 params，其他操作示例: {"shortcutName":"新建"} / {"text":"内容"} / {"x":100,"y":200}`;
        }
      }

      const op = {
        app: String(args.app),
        action: String(args.action),
        params,
        timeout: args.timeout !== undefined ? Number(args.timeout) : undefined,
        retry: args.retry !== undefined ? Number(args.retry) : undefined,
      };

      const result = await desktop.executeOperation(op);
      const lines = [
        result.success ? `✅ 操作成功` : `❌ 操作失败`,
        `  应用: ${result.app} | 操作: ${result.action}`,
        `  尝试次数: ${result.attempts} | 耗时: ${result.duration}ms | 已验证: ${result.verified ? '是' : '否'}`,
      ];
      if (result.result) lines.push(`  结果: ${result.result}`);
      if (result.error) lines.push(`  错误: ${result.error}`);
      return lines.join('\n');
    },
  },
  {
    name: 'app_batch',
    description: '批量执行多个跨软件操作（合并执行，提升响应时间）。支持并发非阻塞执行或串行出错即停。每个操作遵循统一接口规范，自动处理验证/超时/重试。适用于需要同时控制多个应用的场景，如"打开浏览器访问网址并在VSCode中保存文件"。',
    readOnly: false,
    parameters: {
      operations: { type: 'string', description: '操作列表(JSON数组字符串)，每项为 {app, action, params, timeout?, retry?}。例如 [{"app":"chrome","action":"workflow","params":{"workflowName":"打开网址","params":{"url":"https://github.com"}}},{"app":"vscode","action":"shortcut","params":{"shortcutName":"保存"}}]', required: true },
      stopOnError: { type: 'boolean', description: '出错是否停止后续操作(默认 false，并发执行)', required: false },
    },
    execute: async (args) => {
      const { UniversalDesktop } = await import('../../core/universal-desktop.js');
      const desktop = new UniversalDesktop();

      let operations: AppOperation[];
      try {
        operations = JSON.parse(String(args.operations));
        if (!Array.isArray(operations)) {
          return '❌ operations 必须是 JSON 数组字符串';
        }
      } catch {
        return '❌ operations 必须是有效的 JSON 数组字符串';
      }

      const batch = {
        operations,
        stopOnError: args.stopOnError === true || args.stopOnError === 'true',
      };

      const results = await desktop.executeBatch(batch);
      const successCount = results.filter(r => r.success).length;
      const lines = [
        `📦 批量操作完成: ${successCount}/${results.length} 成功`,
        '',
      ];
      for (let i = 0; i < results.length; i++) {
        const r = results[i];
        lines.push(`  ${i + 1}. [${r.success ? '✅' : '❌'}] ${r.app}/${r.action} (${r.attempts}次, ${r.duration}ms)`);
        if (r.error) lines.push(`     错误: ${r.error}`);
      }
      return lines.join('\n');
    },
  },
];
