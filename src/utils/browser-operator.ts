import type { Page } from 'puppeteer';
import * as fs from 'fs';
import * as path from 'path';
import { getBrowser } from './browser-fetch.js';

let currentPage: Page | null = null;

async function getPage(): Promise<Page> {
  if (currentPage && !currentPage.isClosed()) return currentPage;
  const browser = await getBrowser();
  currentPage = await browser.newPage();
  await currentPage.setUserAgent(
    'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36'
  );
  await currentPage.setViewport({ width: 1280, height: 800 });
  return currentPage;
}

export interface BrowserActionResult {
  success: boolean;
  data?: string;
  error?: string;
}

export async function browserGoto(url: string, timeoutMs = 30000): Promise<BrowserActionResult> {
  try {
    const page = await getPage();
    await page.goto(url, { waitUntil: 'networkidle2', timeout: timeoutMs });
    const title = await page.title();
    return { success: true, data: `✅ 已打开: ${title}\nURL: ${page.url()}` };
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err);
    return { success: false, error: `导航失败: ${msg}` };
  }
}

export async function browserClick(selector: string): Promise<BrowserActionResult> {
  try {
    const page = await getPage();

    let cssSelector = selector;
    let xpathSelector = '';

    const hasTextMatch = selector.match(/^(.+?):has-text\(\s*["'](.+?)["']\s*\)$/);
    if (hasTextMatch) {
      const tag = hasTextMatch[1] || '*';
      const text = hasTextMatch[2];
      xpathSelector = `//${tag}[contains(text(),${JSON.stringify(text)})]`;
      cssSelector = '';
    }

    const textEqMatch = selector.match(/^text=["'](.+?)["']$/);
    if (textEqMatch) {
      xpathSelector = `//*[contains(text(),${JSON.stringify(textEqMatch[1])})]`;
      cssSelector = '';
    }

    const textEqMatch2 = selector.match(/^text=(.+)$/);
    if (textEqMatch2) {
      xpathSelector = `//*[contains(text(),${JSON.stringify(textEqMatch2[1])})]`;
      cssSelector = '';
    }

    if (cssSelector && (cssSelector.includes(':has-text') || cssSelector.includes(':text') || cssSelector.includes(':visible'))) {
      const tagMatch = cssSelector.match(/^(\w+)/);
      const tag = tagMatch ? tagMatch[1] : '*';
      const textInSelector = cssSelector.match(/["']([^"']+)["']/);
      if (textInSelector) {
        xpathSelector = `//${tag}[contains(text(),${JSON.stringify(textInSelector[1])})]`;
      } else {
        xpathSelector = `//${tag}`;
      }
      cssSelector = '';
    }

    if (cssSelector) {
      try {
        await page.waitForSelector(cssSelector, { timeout: 3000 });
        await page.click(cssSelector);
        return { success: true, data: `✅ 已点击: ${selector}` };
      } catch {}
    }

    if (xpathSelector) {
      try {
        const xpathResult = await page.evaluate(`(() => {
          const el = document.evaluate(${JSON.stringify(xpathSelector)}, document, null, 1, null).singleNodeValue;
          if (el) { el.click(); return true; }
          return false;
        })()`);
        if (xpathResult) return { success: true, data: `✅ 已点击(XPath): ${xpathSelector}` };
      } catch {}
    }

    const text = selector.replace(/[:[].*$/, '').trim() || selector;
    if (!text) return { success: false, error: `选择器为空: ${selector}` };
    
    try {
      const clicked = await page.evaluate(`(() => {
        const txt = ${JSON.stringify(text)};
        const els = document.querySelectorAll('a, button, span, div, [role=button], input[type=submit], input[type=button], li, p, h1, h2, h3, h4, label');
        for (const el of els) {
          const elText = el.textContent?.trim() || '';
          const ariaLabel = el.getAttribute('aria-label') || '';
          const title = el.getAttribute('title') || '';
          if (elText === txt || elText.includes(txt) || ariaLabel === txt || ariaLabel.includes(txt) || title === txt || title.includes(txt)) {
            el.click(); return true;
          }
        }
        return false;
      })()`);
      if (clicked) return { success: true, data: `✅ 已点击(文本): ${text}` };
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      return { success: false, error: `点击失败: ${msg}` };
    }

    return { success: false, error: `未找到可点击元素: ${selector}` };
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err);
    return { success: false, error: `点击失败: ${msg}` };
  }
}

export async function browserType(selector: string, text: string): Promise<BrowserActionResult> {
  try {
    const page = await getPage();
    
    let focused = false;
    
    try {
      await page.waitForSelector(selector, { timeout: 5000 });
      await page.click(selector);
      focused = true;
    } catch {}
    
    if (!focused && (selector.startsWith('/') || selector.startsWith('(') || selector.startsWith('.'))) {
      try {
        const xpathFocused = await page.evaluate(`(() => {
          const el = document.evaluate(${JSON.stringify(selector)}, document, null, 1, null).singleNodeValue;
          if (el) { el.focus(); return true; }
          return false;
        })()`);
        focused = !!xpathFocused;
      } catch {}
    }
    
    if (!focused) {
      try {
        const textFocused = await page.evaluate(`(() => {
          const txt = ${JSON.stringify(selector)};
          const inputs = document.querySelectorAll('input, textarea, [contenteditable="true"], [contenteditable=""]');
          for (const el of inputs) {
            const elText = el.textContent?.trim() || '';
            const placeholder = el.placeholder || '';
            const ariaLabel = el.getAttribute('aria-label') || '';
            const label = el.getAttribute('label') || '';
            if (elText.includes(txt) || placeholder.includes(txt) || ariaLabel.includes(txt) || label.includes(txt)) {
              el.focus(); return true;
            }
          }
          const firstInput = document.querySelector('input[type="text"], textarea, [contenteditable]');
          if (firstInput) { firstInput.focus(); return true; }
          return false;
        })()`);
        focused = !!textFocused;
      } catch {}
    }
    
    await page.keyboard.down('Control');
    await page.keyboard.press('a');
    await page.keyboard.up('Control');
    await page.keyboard.type(text, { delay: 30 });
    return { success: true, data: `✅ 已输入: ${text.substring(0, 50)}${text.length > 50 ? '...' : ''}` };
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err);
    return { success: false, error: `输入失败: ${msg}` };
  }
}

export async function browserScreenshot(filepath?: string): Promise<BrowserActionResult> {
  try {
    const page = await getPage();
    const savePath = filepath || path.join(process.cwd(), `screenshot_${Date.now()}.png`);
    const dir = path.dirname(savePath);
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
    await page.screenshot({ path: savePath, fullPage: false });
    return { success: true, data: `📸 截图已保存: ${savePath}` };
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err);
    return { success: false, error: `截图失败: ${msg}` };
  }
}

export async function browserExtract(): Promise<BrowserActionResult> {
  try {
    const page = await getPage();
    const title = await page.title();
    const url = page.url();
    const content = (await page.evaluate(
      '(() => { const m = document.querySelector("main, article, .content, #content, .main, #main"); return m ? m.innerText : document.body.innerText; })()'
    )) as string;
    return {
      success: true,
      data: `📄 ${title}\n${url}\n\n${content.trim().substring(0, 8000)}`,
    };
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err);
    return { success: false, error: `提取失败: ${msg}` };
  }
}

export async function browserWait(selector: string, timeoutMs = 15000): Promise<BrowserActionResult> {
  try {
    const page = await getPage();
    try {
      await page.waitForSelector(selector, { timeout: timeoutMs });
      return { success: true, data: `✅ 元素已出现: ${selector}` };
    } catch {
      if (selector.startsWith('/') || selector.startsWith('(') || selector.startsWith('.')) {
        const found = await page.evaluate(`(() => {
          return new Promise(resolve => {
            const start = Date.now();
            const check = () => {
              const el = document.evaluate(${JSON.stringify(selector)}, document, null, 1, null).singleNodeValue;
              if (el) resolve(true);
              else if (Date.now() - start > ${timeoutMs}) resolve(false);
              else setTimeout(check, 200);
            };
            check();
          });
        })()`);
        if (found) return { success: true, data: `✅ XPath 元素已出现: ${selector}` };
      }
      return { success: false, error: `等待超时: ${selector}` };
    }
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err);
    return { success: false, error: `等待失败: ${msg}` };
  }
}

export async function browserWaitForChange(waitMs = 2000): Promise<BrowserActionResult> {
  try {
    const page = await getPage();
    const startTime = Date.now();
    const networkTimeout = Math.max(Math.floor(waitMs * 0.8), 1000);
    try {
      await page.waitForNetworkIdle({ timeout: networkTimeout });
    } catch {}
    const elapsed = Date.now() - startTime;
    const remaining = Math.max(waitMs - elapsed, 200);
    if (remaining > 0) {
      await new Promise(resolve => setTimeout(resolve, remaining));
    }
    return { success: true, data: `✅ 已等待 ${waitMs}ms，页面应已更新` };
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err);
    return { success: false, error: `等待失败: ${msg}` };
  }
}

export async function browserInfo(): Promise<BrowserActionResult> {
  try {
    const page = await getPage();
    const title = await page.title();
    const url = page.url();
    const cookies = (await page.cookies()).length;
    return { success: true, data: `📌 标题: ${title}\n🔗 URL: ${url}\n🍪 Cookies: ${cookies}` };
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err);
    return { success: false, error: `获取信息失败: ${msg}` };
  }
}

let _evalCounter = 0;

export async function browserEvaluate(script: string): Promise<BrowserActionResult> {
  try {
    const page = await getPage();
    _evalCounter++;
    const prefix = `_e${_evalCounter}_`;

    let processedScript = script.trim();

    processedScript = processedScript.replace(
      /\b(const|let|var)\s+(\w+)/g,
      (_, keyword, varName) => `${keyword} ${prefix}${varName}`
    );

    processedScript = processedScript.replace(
      /\b(const|let|var)\s*\{([^}]+)\}/g,
      (_, keyword, destructureContent) => {
        const renamed = destructureContent.split(',').map((part: string) => {
          const trimmed = part.trim();
          if (trimmed.includes(':')) return trimmed;
          if (trimmed.includes('=')) {
            const eqIdx = trimmed.indexOf('=');
            const name = trimmed.substring(0, eqIdx).trim();
            const def = trimmed.substring(eqIdx);
            return `${name}: ${prefix}${name}${def}`;
          }
          return `${trimmed}: ${prefix}${trimmed}`;
        }).join(', ');
        return `${keyword} { ${renamed} }`;
      }
    );

    processedScript = processedScript.replace(
      /\b(const|let|var)\s*\[([^\]]+)\]/g,
      (_, keyword, destructureContent) => {
        const renamed = destructureContent.split(',').map((part: string) => {
          const trimmed = part.trim();
          if (trimmed === '' || trimmed === '...') return trimmed;
          if (trimmed.startsWith('...')) {
            const name = trimmed.substring(3).trim();
            return `...${prefix}${name}`;
          }
          if (trimmed.includes('=')) {
            const eqIdx = trimmed.indexOf('=');
            const name = trimmed.substring(0, eqIdx).trim();
            const def = trimmed.substring(eqIdx);
            return `${prefix}${name}${def}`;
          }
          return `${prefix}${trimmed}`;
        }).join(', ');
        return `${keyword} [ ${renamed} ]`;
      }
    );

    const declaredVars = script.match(/\b(?:const|let|var)\s+(\w+)/g) || [];
    for (const decl of declaredVars) {
      const varName = decl.replace(/\b(?:const|let|var)\s+/, '');
      if (varName.length <= 1) continue;
      processedScript = processedScript.replace(
        new RegExp(`(?<!\\.)\\b${varName}\\b(?!\\s*[=:])`, 'g'),
        `${prefix}${varName}`
      );
      processedScript = processedScript.replace(
        new RegExp(`${prefix}${prefix}${varName}`, 'g'),
        `${prefix}${varName}`
      );
    }

    const wrappedScript = `(async () => { ${processedScript} })()`;
    const result = await page.evaluate(wrappedScript);
    if (result === undefined || result === null) {
      return { success: true, data: '(无返回值)' };
    }
    const str = typeof result === 'string' ? result : JSON.stringify(result, null, 2);
    return { success: true, data: (str || '').substring(0, 3000) };
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err);
    return { success: false, error: `执行失败: ${msg}` };
  }
}

export async function browserPress(key: string): Promise<BrowserActionResult> {
  try {
    const page = await getPage();
    const parts = key.split('+').map(k => k.trim());
    if (parts.length > 1) {
      const modifiers = parts.slice(0, -1).map(k => {
        const normalized = k.charAt(0).toUpperCase() + k.slice(1).toLowerCase();
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        return (normalized === 'Ctrl' ? 'Control' : normalized) as any;
      });
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const mainKey = parts[parts.length - 1] as any;
      for (const mod of modifiers) {
        await page.keyboard.down(mod);
      }
      await page.keyboard.press(mainKey);
      for (const mod of [...modifiers].reverse()) {
        await page.keyboard.up(mod);
      }
    } else {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      await page.keyboard.press(key as any);
    }
    return { success: true, data: `✅ 按键: ${key}` };
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err);
    return { success: false, error: `按键失败: ${msg}` };
  }
}
