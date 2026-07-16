import type { Browser } from 'puppeteer';
// v20.0 §4.2：国产系统使用系统 Chromium（替代 puppeteer 自带，支持 LoongArch）
import { getNativeDepsResolver } from '../core/native-deps.js';

let browserInstance: Browser | null = null;
let initPromise: Promise<Browser> | null = null;

export function getBrowser(): Promise<Browser> {
  if (browserInstance) return Promise.resolve(browserInstance);
  if (initPromise !== null) return initPromise;
  initPromise = (async () => {
    try {
      // 动态导入 puppeteer (ES Module) 兼容 CommonJS 环境
      const puppeteerModule = await import('puppeteer');
      const puppeteer = puppeteerModule.default;
      // v20.0 §4.2：通过 NativeDepsResolver 解析系统 Chromium 路径
      // 在国产系统（UOS/麒麟/LoongArch）上使用系统安装的 Chromium
      const launchOptions = getNativeDepsResolver().getPuppeteerLaunchOptions();
      const browser = await puppeteer.launch(launchOptions);
      browserInstance = browser;
      return browser;
    } finally {
      initPromise = null;
    }
  })();
  return initPromise;
}

process.on('exit', () => {
  void (async () => {
    if (browserInstance) {
      try { await browserInstance.close(); } catch {}
      browserInstance = null;
    }
  })();
});

export interface BrowserFetchResult {
  title: string;
  content: string;
  url: string;
}

export async function browserFetch(
  url: string,
  timeoutMs = 20000
): Promise<BrowserFetchResult> {
  const browser = await getBrowser();
  const page = await browser.newPage();

  try {
    await page.setUserAgent(
      'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36'
    );
    await page.setViewport({ width: 1280, height: 800 });
    await page.setDefaultNavigationTimeout(timeoutMs);

    await page.goto(url, {
      waitUntil: 'networkidle0',
      timeout: timeoutMs,
    });

    const title = await page.title();

    const content = (await page.evaluate(
      '(() => { const m = document.querySelector("main, article, .content, #content, .main, #main"); return m ? m.innerText : document.body.innerText; })()'
    )) as string;

    return {
      title: title || '',
      content: content.trim().substring(0, 8000),
      url: page.url(),
    };
  } finally {
    await page.close().catch(() => {});
  }
}