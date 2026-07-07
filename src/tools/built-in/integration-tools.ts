import { errMsg, type UnifiedToolDef } from '../../core/unified-tool-def.js';
import { toolContext } from './tool-context.js';

export const integrationTools: UnifiedToolDef[] = [
  {
    name: 'notification_send',
    description: '发送系统通知。支持类型: info/warning/error/success。通知路由到控制台，可配置Slack/Webhook通道。',
    parameters: {
      type: { type: 'string', description: '类型: info/warning/error/success', required: true },
      title: { type: 'string', description: '通知标题', required: true },
      message: { type: 'string', description: '通知内容', required: true },
      source: { type: 'string', description: '来源模块名', required: false },
    },
    execute: async (args) => {
      if (!toolContext.notificationService) return '错误: 通知服务未初始化';
      try {
        const type = args.type as string;
        const title = args.title as string;
        const message = args.message as string;
        if (!['info', 'warning', 'error', 'success'].includes(type)) return '错误: type 必须是 info/warning/error/success';
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        const id = await toolContext.notificationService.notify(type as any, title, message, {
          source: args.source as string || 'user',
        });
        return `✅ 通知已发送 (id=${id})`;
      } catch (err: unknown) { return `发送通知失败: ${errMsg(err)}`; }
    },
  },
  {
    name: 'notification_history',
    description: '查看通知历史记录。可按类型和来源过滤。',
    readOnly: true,
    parameters: {
      type: { type: 'string', description: '过滤: info/warning/error/success，为空则全部', required: false },
      source: { type: 'string', description: '按来源过滤', required: false },
      limit: { type: 'string', description: '最多返回条数，默认20', required: false },
    },
    execute: (args) => {
      if (!toolContext.notificationService) return Promise.resolve('错误: 通知服务未初始化');
      try {
        const type = args.type;
        const source = args.source as string;
        const limit = parseInt(args.limit as string) || 20;
        const history = toolContext.notificationService.getHistory({ type, source, limit });
        if (history.length === 0) return Promise.resolve('暂无通知记录。');
        const stats = toolContext.notificationService.getStats();
        let output = `📋 **通知历史** (总计: ${stats.total})\n${'─'.repeat(40)}\n`;
        for (const n of history) {
          let icon: string;
          if (n.type === 'error') icon = '❌';
          else if (n.type === 'warning') icon = '⚠️';
          else if (n.type === 'success') icon = '✅';
          else icon = 'ℹ️';
          const time = new Date(n.timestamp).toLocaleTimeString();
          output += `${icon} [${time}] [${n.source}] **${n.title}**: ${n.message.substring(0, 120)}\n`;
        }
        return Promise.resolve(output);
      } catch (err: unknown) { return Promise.resolve(`查询失败: ${errMsg(err)}`); }
    },
  },
  {
    name: 'notification_configure',
    description: '配置通知通道。支持: channel=console/eventbus/webhook/slack，enabled=true/false。webhook需要webhookUrl，slack需要webhookUrl和可选的slackChannel。',
    parameters: {
      channel: { type: 'string', description: '通道: console/eventbus/webhook/slack', required: true },
      enabled: { type: 'string', description: 'true/false', required: true },
      webhookUrl: { type: 'string', description: 'Webhook/Slack URL', required: false },
      slackChannel: { type: 'string', description: 'Slack 频道名', required: false },
    },
    execute: (args) => {
      if (!toolContext.notificationService) return Promise.resolve('错误: 通知服务未初始化');
      try {
        const channel = args.channel as string;
        const enabled = args.enabled === 'true';
        const validChannels = ['console', 'eventbus', 'webhook', 'slack'];
        if (!validChannels.includes(channel)) return Promise.resolve(`错误: channel 必须是 ${validChannels.join('/')}`);
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        toolContext.notificationService.configureChannel(channel as any, {
          enabled,
          webhookUrl: args.webhookUrl as string,
          slackChannel: args.slackChannel as string,
        });
        return Promise.resolve(`✅ 通道 "${channel}" 已${enabled ? '启用' : '禁用'}`);
      } catch (err: unknown) { return Promise.resolve(`配置失败: ${errMsg(err)}`); }
    },
  },
  {
    name: 'webhook_trigger',
    description: '模拟触发一个 Webhook 事件。可用于测试 CI/CD、PR 等集成。类型: ci_complete/ci_failure/pr_opened/pr_merged/push',
    parameters: {
      type: { type: 'string', description: '事件类型: ci_complete/ci_failure/pr_opened/pr_merged/push', required: true },
      source: { type: 'string', description: '来源: github/gitlab/gitee', required: false },
      project: { type: 'string', description: '项目名称', required: false },
      details: { type: 'string', description: '详细描述', required: false },
    },
    execute: async (args) => {
      if (!toolContext.webhookService) return '错误: Webhook服务未初始化';
      try {
        const type = args.type as string;
        const source = args.source as string || 'github';
        const validTypes = ['ci_complete', 'ci_failure', 'pr_opened', 'pr_merged', 'push'];
        if (!validTypes.includes(type)) return `错误: type 必须是 ${validTypes.join('/')}`;
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        const result = await toolContext.webhookService.receiveEvent(type as any, source, {
          project: args.project || 'unknown',
          details: args.details || '',
          prNumber: args.project ? `#${Date.now() % 10000}` : undefined,
          title: args.details || '',
        });
        return result;
      } catch (err: unknown) { return `触发失败: ${errMsg(err)}`; }
    },
  },
  {
    name: 'webhook_configure',
    description: '配置 Webhook 服务。启用后可接收 CI/CD 和 PR 事件。',
    parameters: {
      enabled: { type: 'string', description: 'true/false', required: true },
      autoFixCI: { type: 'string', description: 'CI失败时自动修复: true/false', required: false },
      autoReviewPR: { type: 'string', description: 'PR自动审查: true/false', required: false },
    },
    execute: (args) => {
      if (!toolContext.webhookService) return Promise.resolve('错误: Webhook服务未初始化');
      try {
        toolContext.webhookService.configure({
          enabled: args.enabled === 'true',
          autoFixCI: args.autoFixCI === 'true',
          autoReviewPR: args.autoReviewPR === 'true',
        });
        return Promise.resolve(`✅ Webhook 服务已${args.enabled === 'true' ? '启用' : '禁用'}`);
      } catch (err: unknown) { return Promise.resolve(`配置失败: ${errMsg(err)}`); }
    },
  },
  {
    name: 'tool_audit',
    description: '审计所有已注册工具，分析使用频率、成功率、重叠度，推荐合并/保留/废弃决策。帮助精简工具集。',
    readOnly: true,
    parameters: {
      detail: { type: 'string', description: '设为 "true" 显示每个工具的详细审计', required: false },
      threshold: { type: 'string', description: '低质量工具阈值 0-1，默认0.5', required: false },
    },
    execute: (args) => {
      if (!toolContext.toolConsolidation || !toolContext.unifiedToolFramework) return Promise.resolve('错误: 工具审计系统未初始化');
      try {
        const detail = args.detail === 'true';
        // 获取所有工具 — P1-1 修复：getAllTools 不存在，应为 getActiveTools
        const tools: UnifiedToolDef[] = [];
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        if ((toolContext.unifiedToolFramework as any).getActiveTools) {
          // eslint-disable-next-line @typescript-eslint/no-explicit-any
          tools.push(...(toolContext.unifiedToolFramework as any).getActiveTools());
        }
        toolContext.toolConsolidation.audit(tools);
        const summary = toolContext.toolConsolidation.getSummary();
        let output = `📊 **工具审计报告**\n${'─'.repeat(40)}\n`;
        output += `总计: ${summary.total} | 保留: ${summary.toKeep} | 合并: ${summary.toMerge} | 废弃: ${summary.toDeprecate} | 移除: ${summary.toRemove}\n\n`;

        if (detail) {
          output += `**合并建议**:\n`;
          for (const s of summary.suggestions.slice(0, 10)) {
            output += `  • ${s.tools.join(' + ')} → ${s.targetTool} (${s.reason})\n`;
          }

          const lowQuality = toolContext.toolConsolidation.getLowQualityTools(parseFloat(args.threshold as string) || 0.5);
          if (lowQuality.length > 0) {
            output += `\n**低质量工具** (阈值 ${args.threshold || '0.5'}):\n`;
            for (const r of lowQuality.slice(0, 10)) {
              output += `  ❌ \`${r.name}\` 质量:${(r.qualityScore * 100).toFixed(0)} 使用:${r.usageCount}次 重叠:${(r.overlapScore * 100).toFixed(0)}%\n`;
            }
          }
        } else {
          output += `合并建议: ${summary.suggestions.length} 条\n`;
          output += `使用 detail=true 查看详情。`;
        }
        return Promise.resolve(output);
      } catch (err: unknown) { return Promise.resolve(`审计失败: ${errMsg(err)}`); }
    },
  },
  {
    name: 'cloud_execute',
    description: '在远程 VM 上执行命令。需要先通过 cloud_host_add 配置远程主机。',
    parameters: {
      command: { type: 'string', description: '要在远程主机上执行的命令', required: true },
      hostId: { type: 'string', description: '主机ID（不传使用默认主机）', required: false },
    },
    execute: async (args) => {
      if (!toolContext.cloudDeployment) return '错误: 云端部署系统未初始化';
      try {
        const command = args.command as string;
        if (!command) return '错误: 请提供 command';
        const hostId = args.hostId as string | undefined;
        const result = hostId
          ? await toolContext.cloudDeployment.executeOnHost(hostId, command)
          : await toolContext.cloudDeployment.execute(command);
        if (result.success) {
          return `✅ 执行成功\n${result.stdout.substring(0, 3000)}${result.stdout.length > 3000 ? '\n...(输出截断)' : ''}`;
        }
        return `❌ 执行失败\nstderr: ${result.stderr.substring(0, 1000)}`;
      } catch (err: unknown) { return `执行失败: ${errMsg(err)}`; }
    },
  },
  {
    name: 'cloud_host_add',
    description: '添加远程 VM 主机配置。支持 SSH 连接。添加后可用 cloud_execute 执行远程命令。',
    parameters: {
      id: { type: 'string', description: '主机唯一ID', required: true },
      name: { type: 'string', description: '主机显示名', required: true },
      host: { type: 'string', description: '主机地址 (IP或域名)', required: true },
      port: { type: 'string', description: 'SSH端口，默认22', required: false },
      username: { type: 'string', description: 'SSH用户名', required: false },
      keyPath: { type: 'string', description: 'SSH密钥路径', required: false },
      workDir: { type: 'string', description: '远程工作目录', required: false },
    },
    execute: (args) => {
      if (!toolContext.cloudDeployment) return Promise.resolve('错误: 云端部署系统未初始化');
      try {
        toolContext.cloudDeployment.addHost({
          id: args.id as string,
          name: args.name as string,
          type: 'ssh',
          host: args.host as string,
          port: parseInt(args.port as string) || 22,
          username: args.username as string,
          keyPath: args.keyPath as string,
          workDir: args.workDir as string || '/home',
          timeoutMs: 30000,
          enabled: true,
        });
        return Promise.resolve(`✅ 远程主机 "${args.name}" 已添加 (${args.host})`);
      } catch (err: unknown) { return Promise.resolve(`添加失败: ${errMsg(err)}`); }
    },
  },
  {
    name: 'cloud_host_list',
    description: '列出所有已配置的远程 VM 主机。',
    readOnly: true,
    parameters: {},
    execute: () => {
      if (!toolContext.cloudDeployment) return Promise.resolve('错误: 云端部署系统未初始化');
      try {
        const hosts = toolContext.cloudDeployment.listHosts();
        if (hosts.length === 0) return Promise.resolve('📭 未配置远程主机。使用 cloud_host_add 添加。');
        const stats = toolContext.cloudDeployment.getStats();
        let output = `🖥️ **远程主机** (${stats.hosts}台)\n${'─'.repeat(40)}\n`;
        for (const h of hosts) {
          const def = h.id === toolContext.cloudDeployment.getConfig().defaultHostId ? ' ⭐默认' : '';
          output += `**${h.name}**${def}\n`;
          output += `  ID: ${h.id} | ${h.host}:${h.port} | ${h.username || '无用户名'}\n`;
          output += `  工作目录: ${h.workDir}\n\n`;
        }
        output += `恢复点: ${stats.recoveryPoints} | 活跃执行: ${stats.activeExecutions}`;
        return Promise.resolve(output);
      } catch (err: unknown) { return Promise.resolve(`查询失败: ${errMsg(err)}`); }
    },
  },
];
