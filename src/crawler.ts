import { execFile } from 'node:child_process';
import { createRequire } from 'node:module';
import { rm } from 'node:fs/promises';
import { promisify } from 'node:util';
import { chromium, type Browser, type Page } from 'playwright';
import TurndownService from 'turndown';
import { assertValidIndex, createStagingCacheDir, getDefaultCacheDir, promoteStagingCache, writeIndex, writePage } from './cache.js';
import { materialPageId, materialPagePath, normalizeMaterialUrl, sectionFromPagePath } from './crawler-utils.js';
import type { CrawlOptions, MaterialIndex, MaterialPage } from './types.js';

const require = createRequire(import.meta.url);
const execFileAsync = promisify(execFile);
const DEFAULT_BASE_URL = 'https://m3.material.io';
const DEFAULT_MIN_PAGE_COUNT = 10;

type ExtractedContent = {
  html: string;
  title: string;
  headings: string[];
};

export async function installPlaywrightChromium(): Promise<void> {
  const playwrightCli = require.resolve('playwright/cli');
  await execFileAsync(process.execPath, [playwrightCli, 'install', 'chromium']);
}

async function launchChromium(headless: boolean): Promise<Browser> {
  try {
    return await chromium.launch({ headless });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    if (!message.includes('Executable doesn\'t exist') && !message.includes('browserType.launch')) {
      throw error;
    }

    throw new Error('Playwright Chromium browser is missing. Run: npx -y m3-docs-mcp install-browser', { cause: error });
  }
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

export function extractMaterialPageFromHtml(html: string, url: string, capturedAt = new Date().toISOString(), metadata?: Partial<Pick<ExtractedContent, 'title' | 'headings'>>): MaterialPage {
  const turndown = new TurndownService({ headingStyle: 'atx', codeBlockStyle: 'fenced', bulletListMarker: '-' });
  const relPath = materialPagePath(url);
  const title = metadata?.title?.trim() || titleFromHtml(html) || 'Material 3 page';
  const headings = metadata?.headings?.map((heading) => heading.trim()).filter(Boolean) ?? headingsFromHtml(html);
  const body = turndown.turndown(html).replace(/\n{3,}/g, '\n\n').trim();
  const text = stripHtml(html).replace(/\s+/g, ' ').trim();
  const markdown = `---\ntitle: ${JSON.stringify(title)}\nsourceUrl: ${url}\nsection: ${sectionFromPagePath(relPath)}\ncapturedAt: ${capturedAt}\n---\n\n${body}\n`;
  return {
    id: materialPageId(url),
    title,
    url,
    path: relPath,
    section: sectionFromPagePath(relPath),
    headings,
    text,
    markdown,
    capturedAt
  };
}

async function extract(page: Page, url: string): Promise<MaterialPage> {
  const content = await page.evaluate(() => {
    const root = document.querySelector('main') ?? document.querySelector('[role="main"]') ?? document.body;
    const clone = root.cloneNode(true) as HTMLElement;
    for (const selector of ['script', 'style', 'noscript', 'svg[aria-hidden="true"]']) {
      for (const el of Array.from(clone.querySelectorAll(selector))) el.remove();
    }
    const textContent = (element: Element | null) => element?.textContent?.replace(/\s+/g, ' ').trim() ?? '';
    return {
      html: clone.innerHTML,
      title: textContent(clone.querySelector('h1')),
      headings: Array.from(clone.querySelectorAll('h1, h2, h3, h4')).map(textContent).filter(Boolean)
    };
  });
  return extractMaterialPageFromHtml(content.html, url, undefined, { title: content.title, headings: content.headings });
}

export function discoverMaterialLinksFromHrefs(hrefs: string[], baseUrl: string): string[] {
  return Array.from(new Set(hrefs.map((href) => normalizeMaterialUrl(href, baseUrl)).filter((value): value is string => Boolean(value))));
}

async function discoverLinks(page: Page, baseUrl: string): Promise<string[]> {
  const links = await page.evaluate(() => Array.from(document.querySelectorAll('a[href]')).map((a) => (a as HTMLAnchorElement).href));
  return discoverMaterialLinksFromHrefs(links, baseUrl);
}

export async function crawlMaterialDocs(options: CrawlOptions = {}): Promise<MaterialIndex> {
  const targetCacheDir = options.cacheDir ?? getDefaultCacheDir();
  const stagingCacheDir = await createStagingCacheDir(targetCacheDir);

  try {
    const index = await crawlIntoCache(stagingCacheDir, options);
    assertValidIndex(index, options.minPageCount ?? DEFAULT_MIN_PAGE_COUNT);
    await promoteStagingCache(stagingCacheDir, targetCacheDir);
    return index;
  } catch (error) {
    await rm(stagingCacheDir, { recursive: true, force: true });
    throw error;
  }
}

async function crawlIntoCache(cacheDir: string, options: CrawlOptions): Promise<MaterialIndex> {
  const baseUrl = options.baseUrl ?? DEFAULT_BASE_URL;
  const maxPages = options.maxPages ?? 250;
  const browser = await launchChromium(options.headless ?? true);
  const context = await browser.newContext({ viewport: { width: 1440, height: 1400 } });
  const page = await context.newPage();
  const queue: string[] = [baseUrl];
  const seen = new Set<string>();
  const pages: MaterialPage[] = [];
  const failedUrls: string[] = [];

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
        failedUrls.push(url);
        console.error(`Failed to crawl ${url}:`, error instanceof Error ? error.message : String(error));
      }
    }
  } finally {
    await browser.close();
  }

  const capturedAt = new Date().toISOString();
  const index: MaterialIndex = {
    source: baseUrl,
    capturedAt,
    pageCount: pages.length,
    attemptedPageCount: seen.size,
    failedPageCount: failedUrls.length,
    failedUrls,
    pages: pages.map(({ text: _text, markdown: _markdown, ...meta }) => meta)
  };
  await writeIndex(index, cacheDir);
  return index;
}

function titleFromHtml(html: string): string {
  const titleMatch = html.match(/<h1[^>]*>([\s\S]*?)<\/h1>/i);
  return stripHtml(titleMatch?.[1] ?? '').trim();
}

function headingsFromHtml(html: string): string[] {
  return Array.from(html.matchAll(/<h[1-4][^>]*>([\s\S]*?)<\/h[1-4]>/gi)).map((match) => stripHtml(match[1]).trim()).filter(Boolean);
}

function stripHtml(html: string): string {
  return html.replace(/<script[\s\S]*?<\/script>/gi, '').replace(/<style[\s\S]*?<\/style>/gi, '').replace(/<noscript[\s\S]*?<\/noscript>/gi, '').replace(/<[^>]+>/g, ' ').replace(/&nbsp;/g, ' ').replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&#39;/g, "'");
}
