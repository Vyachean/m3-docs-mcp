import crypto from 'node:crypto';
import { chromium, type Browser, type Page } from 'playwright';
import TurndownService from 'turndown';
import { writeIndex, writePage, getDefaultCacheDir } from './cache.js';
import type { CrawlOptions, MaterialIndex, MaterialPage } from './types.js';

const DEFAULT_BASE_URL = 'https://m3.material.io';
const SKIP_EXTENSIONS = /\.(png|jpg|jpeg|gif|webp|svg|ico|pdf|zip|xml|json|txt)$/i;

function normalizeUrl(raw: string, baseUrl: string): string | null {
  try {
    const url = new URL(raw, baseUrl);
    const base = new URL(baseUrl);
    if (url.origin !== base.origin) return null;
    url.hash = '';
    url.search = '';
    if (SKIP_EXTENSIONS.test(url.pathname)) return null;
    return url.toString().replace(/\/$/, '');
  } catch {
    return null;
  }
}

function pagePath(url: string): string {
  const pathname = new URL(url).pathname.replace(/^\/+|\/+$/g, '');
  return `${pathname || 'index'}.md`;
}

function sectionFromPath(filePath: string): string {
  const parts = filePath.replace(/\.md$/, '').split('/');
  return parts.length > 1 ? parts.slice(0, -1).join('/') : 'root';
}

function makeId(url: string): string {
  return crypto.createHash('sha256').update(url).digest('hex').slice(0, 16);
}

async function autoExpand(page: Page): Promise<void> {
  await page.evaluate(async () => {
    for (const details of Array.from(document.querySelectorAll('details:not([open])'))) {
      details.setAttribute('open', 'true');
    }
    for (const el of Array.from(document.querySelectorAll('[aria-expanded="false"]'))) {
      if (el instanceof HTMLElement) el.click();
    }
    await new Promise((resolve) => setTimeout(resolve, 200));
  });
}

async function scrollPage(page: Page): Promise<void> {
  await page.evaluate(async () => {
    await new Promise<void>((resolve) => {
      let y = 0;
      const step = Math.max(500, Math.floor(window.innerHeight * 0.8));
      const timer = setInterval(() => {
        y += step;
        window.scrollTo(0, y);
        if (y >= document.body.scrollHeight) {
          clearInterval(timer);
          resolve();
        }
      }, 50);
    });
  });
}

async function extract(page: Page, url: string): Promise<MaterialPage> {
  const data = await page.evaluate(() => {
    const root = document.querySelector('main') ?? document.querySelector('[role="main"]') ?? document.body;
    const clone = root.cloneNode(true) as HTMLElement;
    for (const selector of ['script', 'style', 'noscript', 'svg[aria-hidden="true"]']) {
      for (const el of Array.from(clone.querySelectorAll(selector))) el.remove();
    }
    const title = document.querySelector('h1')?.textContent?.trim() || document.title.replace(/\s*[-|].*$/, '').trim() || 'Material 3 page';
    const headings = Array.from(clone.querySelectorAll('h1,h2,h3,h4')).map((h) => h.textContent?.trim()).filter(Boolean) as string[];
    return {
      title,
      headings,
      html: clone.innerHTML,
      text: clone.textContent?.replace(/\s+/g, ' ').trim() ?? ''
    };
  });

  const turndown = new TurndownService({ headingStyle: 'atx', codeBlockStyle: 'fenced', bulletListMarker: '-' });
  const capturedAt = new Date().toISOString();
  const relPath = pagePath(url);
  const body = turndown.turndown(data.html).replace(/\n{3,}/g, '\n\n').trim();
  const markdown = `---\ntitle: ${JSON.stringify(data.title)}\nsourceUrl: ${url}\nsection: ${sectionFromPath(relPath)}\ncapturedAt: ${capturedAt}\n---\n\n${body}\n`;
  return {
    id: makeId(url),
    title: data.title,
    url,
    path: relPath,
    section: sectionFromPath(relPath),
    headings: data.headings,
    text: data.text,
    markdown,
    capturedAt
  };
}

async function discoverLinks(page: Page, baseUrl: string): Promise<string[]> {
  const links = await page.evaluate(() => Array.from(document.querySelectorAll('a[href]')).map((a) => (a as HTMLAnchorElement).href));
  return Array.from(new Set(links.map((href) => normalizeUrl(href, baseUrl)).filter((v): v is string => Boolean(v))));
}

export async function crawlMaterialDocs(options: CrawlOptions = {}): Promise<MaterialIndex> {
  const baseUrl = options.baseUrl ?? DEFAULT_BASE_URL;
  const cacheDir = options.cacheDir ?? getDefaultCacheDir();
  const maxPages = options.maxPages ?? 250;
  const browser: Browser = await chromium.launch({ headless: options.headless ?? true });
  const context = await browser.newContext({ viewport: { width: 1440, height: 1400 } });
  const page = await context.newPage();
  const queue: string[] = [baseUrl];
  const seen = new Set<string>();
  const pages: MaterialPage[] = [];

  try {
    while (queue.length > 0 && pages.length < maxPages) {
      const url = queue.shift();
      if (!url || seen.has(url)) continue;
      seen.add(url);
      try {
        await page.goto(url, { waitUntil: 'networkidle', timeout: 45000 });
        await scrollPage(page);
        await autoExpand(page);
        const materialPage = await extract(page, url);
        if (materialPage.text.length > 80) {
          pages.push(materialPage);
          await writePage(materialPage, cacheDir);
        }
        for (const link of await discoverLinks(page, baseUrl)) {
          if (!seen.has(link) && queue.length + seen.size < maxPages * 4) queue.push(link);
        }
      } catch (error) {
        console.error(`Failed to crawl ${url}:`, error instanceof Error ? error.message : String(error));
      }
    }
  } finally {
    await browser.close();
  }

  const capturedAt = new Date().toISOString();
  const index: MaterialIndex = {
    source: DEFAULT_BASE_URL,
    capturedAt,
    pageCount: pages.length,
    pages: pages.map(({ text: _text, markdown: _markdown, ...meta }) => meta)
  };
  await writeIndex(index, cacheDir);
  return index;
}
