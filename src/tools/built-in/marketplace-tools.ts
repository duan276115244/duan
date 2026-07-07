import { errMsg, type UnifiedToolDef } from '../../core/unified-tool-def.js';
import type { PluginType } from '../../core/mcp-marketplace.js';
import { toolContext } from './tool-context.js';

export const marketplaceTools: UnifiedToolDef[] = [
  {
    name: 'marketplace_search',
    description: '在 MCP 插件市场中搜索可用插件。支持按名称、描述和标签搜索。可过滤插件类型和标签。',
    readOnly: true,
    parameters: {
      query: { type: 'string', description: '搜索关键词', required: true },
      type: { type: 'string', description: '过滤: mcp-server / tool-bundle，为空则不限', required: false },
      tag: { type: 'string', description: '按标签过滤，如 browser / database / search', required: false },
    },
    execute: (args) => {
      if (!toolContext.mcpMarketplace) return Promise.resolve('错误: MCP 市场未初始化');
      try {
        const query = args.query as string;
        const type = args.type as PluginType | undefined;
        const tag = args.tag as string;
        if (!query) return Promise.resolve('错误: 请提供搜索关键词');
        const results = toolContext.mcpMarketplace.search(query, { type, tag });
        if (results.length === 0) return Promise.resolve(`未找到与 "${query}" 相关的插件。`);
        let output = `🔍 **搜索 "${query}" 结果** (${results.length} 项)\n\n`;
        for (const { plugin, relevance } of results.slice(0, 15)) {
          const typeIcon = plugin.type === 'mcp-server' ? '🔌' : '📦';
          const installed = plugin.installedAt ? ' ✅已安装' : '';
          output += `${typeIcon} **${plugin.name}** v${plugin.version}${installed}\n`;
          output += `   ID: \`${plugin.id}\` | 作者: ${plugin.author} | 来源: ${plugin.source}\n`;
          output += `   ${plugin.description}\n`;
          output += `   标签: ${plugin.tags.join(', ')} | 匹配度: ${relevance}%\n\n`;
        }
        if (results.length > 15) output += `...及其他 ${results.length - 15} 项\n`;
        output += '使用 `marketplace_install <id>` 安装插件。';
        return Promise.resolve(output);
      } catch (err: unknown) { return Promise.resolve(`搜索失败: ${errMsg(err)}`); }
    },
  },
  {
    name: 'marketplace_install',
    description: '从 MCP 插件市场安装插件。支持安装内置插件或通过 npm 包名安装自定义 MCP 服务器。安装后自动连接并注册工具。',
    parameters: {
      id: { type: 'string', description: '插件 ID（使用 marketplace_search 查找）或 npm 包名（如 @modelcontextprotocol/server-github）', required: true },
      type: { type: 'string', description: '安装类型: registry（内置市场）/ npm（自定义 npm 包），默认自动检测', required: false },
    },
    execute: async (args) => {
      if (!toolContext.mcpMarketplace) return '错误: MCP 市场未初始化';
      try {
        const id = args.id as string;
        const type = args.type as string;
        if (!id) return '错误: 请提供插件 ID 或 npm 包名';

        // 检查是否是内置插件
        const info = toolContext.mcpMarketplace.getInfo(id);
        if (info || type === 'registry') {
          const result = await toolContext.mcpMarketplace.install(id);
          return result.message;
        }

        // 按 npm 包名安装
        const result = await toolContext.mcpMarketplace.installFromNPMPackage(id);
        return result.message;
      } catch (err: unknown) { return `安装失败: ${errMsg(err)}`; }
    },
  },
  {
    name: 'marketplace_list',
    description: '列出所有已安装的 MCP 市场插件，显示启用状态、类型和统计信息。',
    readOnly: true,
    parameters: {
      verbose: { type: 'string', description: '设为 "true" 显示详细信息', required: false },
    },
    execute: (args) => {
      if (!toolContext.mcpMarketplace) return Promise.resolve('错误: MCP 市场未初始化');
      try {
        const verbose = args.verbose === 'true';
        const plugins = toolContext.mcpMarketplace.listInstalled();
        const stats = toolContext.mcpMarketplace.getStats();

        if (plugins.length === 0) return Promise.resolve('📭 尚未安装任何插件。使用 `marketplace_search` 发现插件。');

        let output = `📦 **已安装插件** (${stats.total})\n\n`;
        output += `🔌 MCP 服务器: ${stats.mcpServers} | 📦 工具包: ${stats.toolBundles} | ✅ 已启用: ${stats.enabled}\n\n`;

        for (const p of plugins) {
          const statusIcon = p.enabled ? '✅' : '⏸️';
          const typeIcon = p.type === 'mcp-server' ? '🔌' : '📦';
          output += `${statusIcon} ${typeIcon} **${p.name}** v${p.version}\n`;
          output += `   ID: \`${p.id}\` | ${p.source}\n`;
          if (verbose) {
            output += `   描述: ${p.description}\n`;
            output += `   标签: ${p.tags.join(', ')}\n`;
          }
          if (p.installedAt) output += `   安装于: ${new Date(p.installedAt).toLocaleString()}\n`;
          output += '\n';
        }
        return Promise.resolve(output);
      } catch (err: unknown) { return Promise.resolve(`列出插件失败: ${errMsg(err)}`); }
    },
  },
  {
    name: 'marketplace_remove',
    description: '移除已安装的 MCP 市场插件。如果是 MCP 服务器，会自动断开连接。',
    parameters: {
      id: { type: 'string', description: '要移除的插件 ID', required: true },
    },
    execute: async (args) => {
      if (!toolContext.mcpMarketplace) return '错误: MCP 市场未初始化';
      try {
        const id = args.id as string;
        if (!id) return '错误: 请提供插件 ID';
        const result = await toolContext.mcpMarketplace.remove(id);
        return result.message;
      } catch (err: unknown) { return `移除失败: ${errMsg(err)}`; }
    },
  },
  {
    name: 'marketplace_info',
    description: '查看 MCP 市场插件的详细信息，包括配置、版本、描述和安装状态。',
    readOnly: true,
    parameters: {
      id: { type: 'string', description: '插件 ID', required: true },
    },
    execute: (args) => {
      if (!toolContext.mcpMarketplace) return Promise.resolve('错误: MCP 市场未初始化');
      try {
        const id = args.id as string;
        if (!id) return Promise.resolve('错误: 请提供插件 ID');
        const plugin = toolContext.mcpMarketplace.getInfo(id);
        if (!plugin) return Promise.resolve(`❌ 未找到插件: ${id}`);

        let output = `📋 **${plugin.name}** v${plugin.version}\n`;
        output += `${'─'.repeat(40)}\n`;
        output += `ID: \`${plugin.id}\`\n`;
        output += `类型: ${plugin.type === 'mcp-server' ? '🔌 MCP 服务器' : '📦 工具包'}\n`;
        output += `作者: ${plugin.author}\n`;
        output += `来源: ${plugin.source}\n`;
        output += `描述: ${plugin.description}\n`;
        output += `标签: ${plugin.tags.join(', ')}\n`;
        if (plugin.homepage) output += `主页: ${plugin.homepage}\n`;
        if (plugin.license) output += `许可证: ${plugin.license}\n`;

        if (plugin.mcpConfig) {
          output += `\n⚙️ **连接配置**:\n`;
          output += `传输方式: ${plugin.mcpConfig.transport || 'stdio'}\n`;
          if (plugin.mcpConfig.command) output += `命令: ${plugin.mcpConfig.command} ${plugin.mcpConfig.args?.join(' ') || ''}\n`;
          if (plugin.mcpConfig.url) output += `URL: ${plugin.mcpConfig.url}\n`;
        }

        if (plugin.installedAt) {
          output += `\n✅ **已安装** (${new Date(plugin.installedAt).toLocaleString()})\n`;
          output += `状态: ${plugin.enabled ? '已启用' : '已禁用'}\n`;
        } else {
          output += `\n📥 **未安装** — 使用 \`marketplace_install ${id}\` 安装\n`;
        }

        return Promise.resolve(output);
      } catch (err: unknown) { return Promise.resolve(`获取信息失败: ${errMsg(err)}`); }
    },
  },
  {
    name: 'marketplace_toggle',
    description: '启用或禁用已安装的 MCP 市场插件。禁用不会卸载，可随时重新启用。',
    parameters: {
      id: { type: 'string', description: '插件 ID', required: true },
      enable: { type: 'string', description: '"true" 启用 / "false" 禁用', required: true },
    },
    execute: async (args) => {
      if (!toolContext.mcpMarketplace) return '错误: MCP 市场未初始化';
      try {
        const id = args.id as string;
        const enable = args.enable === 'true';
        if (!id) return '错误: 请提供插件 ID';
        const ok = await toolContext.mcpMarketplace.setEnabled(id, enable);
        if (!ok) return `❌ 未找到已安装的插件: ${id}`;
        return enable ? `✅ 插件已启用` : `⏸️ 插件已禁用`;
      } catch (err: unknown) { return `操作失败: ${errMsg(err)}`; }
    },
  },
];
