import type { UnifiedToolDef } from '../../core/unified-tool-def.js';
import { errMsg } from '../../core/utils.js';
import { wrapExternalContent } from '../../core/security-utils.js';
import { browserFetch } from '../../utils/browser-fetch.js';

export const webTools: UnifiedToolDef[] = [
  {
    name: 'web_search',
    description: '网络搜索，返回搜索结果摘要。用于获取最新信息、查找资料。',
    readOnly: true,
    parameters: { query: { type: 'string', description: '搜索关键词', required: true } },
    execute: async (args) => {
      const query = args.query as string;
      try {
        const res = await fetch(`https://html.duckduckgo.com/html/?q=${encodeURIComponent(query)}`, {
          headers: {
            'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
          },
          signal: AbortSignal.timeout(15000),
        });
        const html = await res.text();
        const text = html.replace(/<[^>]*>/g, ' ').replace(/\s+/g, ' ').trim();
        const content = `🔍 搜索 "${query}" 结果:\n${text.substring(0, 3000)}`;
        return wrapExternalContent(content, `web_search: ${query}`);
      } catch (err: unknown) {
        try {
          const res = await fetch(`https://api.duckduckgo.com/?q=${encodeURIComponent(query)}&format=json&no_html=1`, { signal: AbortSignal.timeout(15000) });
          const data = await res.json() as {
            AbstractText?: string;
            AbstractURL?: string;
            Answer?: string;
            RelatedTopics?: Array<{ Text?: string }>;
          };
          const parts: string[] = [];
          if (data.AbstractText) parts.push(`📖 ${data.AbstractText}`);
          if (data.AbstractURL) parts.push(`🔗 ${data.AbstractURL}`);
          if (data.Answer) parts.push(`✅ ${data.Answer}`);
          if (data.RelatedTopics?.length > 0) {
            parts.push('\n📋 相关内容:');
            data.RelatedTopics.filter(t => t.Text).slice(0, 5).forEach(t => {
              parts.push(`  • ${t.Text}`);
            });
          }
          const content = parts.length > 0 ? parts.join('\n') : `搜索 "${query}" 完成，未找到直接结果。`;
          return wrapExternalContent(content, `web_search: ${query}`);
        } catch { return `搜索失败: ${errMsg(err)}`; }
      }
    },
  },
  {
    name: 'web_fetch',
    description: '抓取指定URL的网页内容并提取文本',
    readOnly: true,
    parameters: { url: { type: 'string', description: '要抓取的网页URL', required: true } },
    execute: async (args) => {
      let url = (args.url as string).trim();
      if (!url.startsWith('http://') && !url.startsWith('https://')) {
        url = 'https://' + url;
      }
      try {
        const controller = new AbortController();
        const timeout = setTimeout(() => controller.abort(), 15000);
        const res = await fetch(url, {
          headers: {
            'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
            'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
            'Accept-Language': 'zh-CN,zh;q=0.9,en;q=0.8',
          },
          signal: controller.signal,
        });
        clearTimeout(timeout);
        const html = await res.text();
        const title = html.match(/<title[^>]*>([\s\S]*?)<\/title>/i)?.[1]?.trim() || '';
        const metaDesc = html.match(/<meta[^>]+name=["']description["'][^>]+content=["']([^"']*)["']/i)?.[1]?.trim() || '';
        const metaKeywords = html.match(/<meta[^>]+name=["']keywords["'][^>]+content=["']([^"']*)["']/i)?.[1]?.trim() || '';
        const bodyText = html
          .replace(/<script[^>]*>[\s\S]*?<\/script>/gi, ' ')
          .replace(/<style[^>]*>[\s\S]*?<\/style>/gi, ' ')
          .replace(/<nav[^>]*>[\s\S]*?<\/nav>/gi, ' ')
          .replace(/<footer[^>]*>[\s\S]*?<\/footer>/gi, ' ')
          .replace(/<header[^>]*>[\s\S]*?<\/header>/gi, ' ')
          .replace(/<[^>]*>/g, ' ')
          .replace(/&[a-z]+;/gi, ' ')
          .replace(/\s+/g, ' ')
          .trim();
        let _usedBrowser = false;
        if (bodyText.length < 100) {
          try {
            const browserResult = await browserFetch(url);
            _usedBrowser = true;
            return wrapExternalContent(`📌 标题: ${browserResult.title}\n🖥️ 浏览器渲染模式\n\n${browserResult.content}`, `web_fetch: ${url}`);
          } catch {}
        }
        const parts: string[] = [];
        if (title) parts.push(`📌 标题: ${title}`);
        if (metaDesc) parts.push(`📝 描述: ${metaDesc}`);
        if (metaKeywords) parts.push(`🏷️ 关键词: ${metaKeywords}`);
        if (bodyText) parts.push(`\n${bodyText}`);
        const content = parts.join('\n').substring(0, 5000);
        const result = content || `⚠️ 页面 "${url}" 抓取成功但未提取到可见文本（可能为JS动态渲染页面）`;
        return wrapExternalContent(result, `web_fetch: ${url}`);
      } catch (err: unknown) {
        const errName = (err as { name?: string })?.name;
        if (errName === 'AbortError') {
          try {
            const browserResult = await browserFetch(url);
            return wrapExternalContent(`📌 标题: ${browserResult.title}\n🖥️ 浏览器渲染模式（直接抓取超时）\n\n${browserResult.content}`, `web_fetch: ${url}`);
          } catch {}
          return `⏱️ 抓取超时: ${url} (15秒)`;
        }
        return `抓取失败: ${errMsg(err)}`;
      }
    },
  },
  {
    name: 'http_request',
    description: '发送HTTP请求（GET/POST等）并返回响应',
    readOnly: true,
    parameters: { url: { type: 'string', description: '请求URL', required: true }, method: { type: 'string', description: 'HTTP方法，默认GET', required: false }, headers: { type: 'object', description: '请求头', required: false }, body: { type: 'string', description: '请求体', required: false } },
    execute: async (args) => {
      try {
        const res = await fetch(args.url as string, { method: ((args.method as string) || 'GET').toUpperCase(), headers: (args.headers as Record<string, string>) || {}, body: args.body as string | undefined, signal: AbortSignal.timeout(30000) });
        return `HTTP ${res.status} ${res.statusText}\n\n${(await res.text()).substring(0, 5000)}`;
      } catch (err: unknown) { return `HTTP请求失败: ${errMsg(err)}`; }
    },
  },
];
