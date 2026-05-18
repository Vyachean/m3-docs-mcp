import { execFile } from 'node:child_process';
import crypto from 'node:crypto';
import { rm } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { promisify } from 'node:util';
import { chromium, type Browser, type Page } from 'playwright';
import TurndownService from 'turndown';
import { assertSafeCachePromotion, assertValidIndex, createStagingCacheDir, getDefaultCacheDir, promoteStagingCache, readIndex, writeIndex, writePage } from './cache.js';
import { materialPageId, materialPagePath, normalizeMaterialUrl, sectionFromPagePath } from './crawler-utils.js';
import type { CrawlOptions, CrawlQualityReport, DuplicateContentGroup, DuplicateTitleGroup, MaterialIndex, MaterialPage, ShortCrawlPage, SuspiciousCrawlPage } from './types.js';

const require = createRequire(import.meta.url);
const execFileAsync = promisify(execFile);
const DEFAULT_BASE_URL = 'https://m3.material.io';
const DEFAULT_MIN_PAGE_COUNT = 10;
const SHORT_PAGE_TEXT_LENGTH = 160;

type ExtractedContent = {
  html: string;
  title: string;
  headings: string[];
};

export async function installPlaywrightChromium(withDependencies = false): Promise<void> {
  const playwrightCli = require.resolve('playwright/cli');
  await execFileAsync(process.execPath, [playwrightCli, 'install', ...(withDependencies ? ['--with-deps'] : []), 'chromium']);
}

async function launchChromium(headless: boolean): Promise<Browser> {
  try {
    return await chromium.launch({ headless });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    if (!message.includes('Executable doesn\'t exist') && !message.includes('browserType.launch')) {
      throw new Error(`Playwright Chromium failed to start. Run: npx -y m3-docs-mcp install-browser --with-deps. Original error: ${message}`, { cause: error });
    }

    throw new Error('Playwright Chromium browser is missing. Run: npx -y m3-docs-mcp install-browser. On Linux, use: npx -y m3-docs-mcp install-browser --with-deps', { cause: error });
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

async function waitForMaterialContent(page: Page): Promise<void> {
  await page.waitForSelector('main, [role="main"]', { timeout: 15_000 });
  await page.waitForFunction(() => {
    const root = document.querySelector('main') ?? document.querySelector('[role="main"]') ?? document.body;
    const text = root.textContent?.replace(/\s+/g, ' ').trim() ?? '';
    return text.length > 80 && Boolean(root.querySelector('h1, h2'));
  }, undefined, { timeout: 15_000 });
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

export function validateCrawledPage(page: MaterialPage): SuspiciousCrawlPage | null {
  const path = new URL(page.url).pathname.replace(/^\/+|\/+$/g, '');
  const segments = path.split('/').filter(Boolean);
  const title = normalizeText(page.title);
  const firstHeading = normalizeText(page.headings[0] ?? page.title);
  const contentPreview = normalizeText(`${page.title} ${page.headings.join(' ')} ${page.text.slice(0, 800)}`);

  if (segments[0] === 'components' && segments.length >= 2) {
    const componentSlug = segments[1] ?? '';
    const componentName = normalizeSlug(componentSlug);
    if (title === 'components' || firstHeading === 'components') {
      return suspiciousPage(page, `component route rendered the parent Components index instead of ${componentSlug}`);
    }
    if (!containsAllWords(contentPreview, componentName.split(' '))) {
      return suspiciousPage(page, `component route content does not mention expected component slug ${componentSlug}`);
    }
  }

  return null;
}

export function createCrawlQualityReport(pages: MaterialPage[]): CrawlQualityReport {
  const suspiciousPages = pages.map(validateCrawledPage).filter((page): page is SuspiciousCrawlPage => Boolean(page));
  const shortPages: ShortCrawlPage[] = pages
    .filter((page) => page.text.length < SHORT_PAGE_TEXT_LENGTH)
    .map((page) => ({ url: page.url, path: page.path, title: page.title, textLength: page.text.length }));
  const pagesBySection = countBy(pages.map((page) => page.section));
  return {
    suspiciousPages,
    duplicateContent: duplicateContentGroups(pages),
    shortPages,
    duplicateTitles: duplicateTitleGroups(pages),
    pagesBySection
  };
}

export async function crawlMaterialDocs(options: CrawlOptions = {}): Promise<MaterialIndex> {
  const targetCacheDir = options.cacheDir ?? getDefaultCacheDir();
  const previousIndex = await readIndex(targetCacheDir);
  const stagingCacheDir = await createStagingCacheDir(targetCacheDir);

  try {
    const index = await crawlIntoCache(stagingCacheDir, options);
    assertValidIndex(index, options.minPageCount ?? DEFAULT_MIN_PAGE_COUNT);
    assertSafeCachePromotion(index, previousIndex, { force: options.force });
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
  const queue: string[] = [baseUrl];
  const seen = new Set<string>();
  const pages: MaterialPage[] = [];
  const failedUrls: string[] = [];

  try {
    while (queue.length > 0 && pages.length < maxPages) {
      const url = queue.shift();
      if (!url || seen.has(url)) continue;
      seen.add(url);
      const page = await context.newPage();
      try {
        await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 45000 });
        await waitForMaterialContent(page);
        await scrollPage(page);
        await autoExpand(page);
        const materialPage = await extract(page, url);
        const suspiciousPage = validateCrawledPage(materialPage);
        if (suspiciousPage) {
          failedUrls.push(url);
          console.error(`Rejected crawled ${url}: ${suspiciousPage.reason}`);
        } else if (materialPage.text.length > 80) {
          pages.push(materialPage);
          await writePage(materialPage, cacheDir);
        }
        for (const link of await discoverLinks(page, baseUrl)) {
          if (!seen.has(link) && queue.length + seen.size < maxPages * 4) queue.push(link);
        }
      } catch (error) {
        failedUrls.push(url);
        console.error(`Failed to crawl ${url}:`, error instanceof Error ? error.message : String(error));
      } finally {
        await page.close();
      }
    }
  } finally {
    await browser.close();
  }

  const capturedAt = new Date().toISOString();
  const qualityReport = createCrawlQualityReport(pages);
  const index: MaterialIndex = {
    source: baseUrl,
    capturedAt,
    pageCount: pages.length,
    attemptedPageCount: seen.size,
    failedPageCount: failedUrls.length,
    failedUrls,
    qualityReport,
    pages: pages.map(({ text: _text, markdown: _markdown, ...meta }) => meta)
  };
  await writeIndex(index, cacheDir);
  return index;
}

function duplicateContentGroups(pages: MaterialPage[]): DuplicateContentGroup[] {
  const groups = new Map<string, MaterialPage[]>();
  for (const page of pages) {
    if (page.text.length < SHORT_PAGE_TEXT_LENGTH) continue;
    const hash = crypto.createHash('sha256').update(stripMarkdownFrontmatter(page.markdown).replace(/\s+/g, ' ').trim()).digest('hex').slice(0, 16);
    const group = groups.get(hash) ?? [];
    group.push(page);
    groups.set(hash, group);
  }
  return Array.from(groups.entries())
    .filter(([, group]) => group.length > 1)
    .map(([hash, group]) => ({
      hash,
      title: group[0]?.title ?? '',
      paths: group.map((page) => page.path).sort(),
      urls: group.map((page) => page.url).sort()
    }));
}

function duplicateTitleGroups(pages: MaterialPage[]): DuplicateTitleGroup[] {
  const groups = new Map<string, MaterialPage[]>();
  for (const page of pages) {
    const key = normalizeText(page.title);
    if (!key) continue;
    const group = groups.get(key) ?? [];
    group.push(page);
    groups.set(key, group);
  }
  return Array.from(groups.values())
    .filter((group) => group.length > 1)
    .map((group) => ({ title: group[0]?.title ?? '', count: group.length, paths: group.map((page) => page.path).sort() }));
}

function countBy(values: string[]): Record<string, number> {
  return values.reduce<Record<string, number>>((acc, value) => {
    acc[value] = (acc[value] ?? 0) + 1;
    return acc;
  }, {});
}

function suspiciousPage(page: MaterialPage, reason: string): SuspiciousCrawlPage {
  return { url: page.url, path: page.path, title: page.title, reason };
}

function normalizeSlug(value: string): string {
  return normalizeText(value.replace(/-/g, ' '));
}

function normalizeText(value: string): string {
  return value.toLowerCase().replace(/&/g, ' and ').replace(/[^a-z0-9]+/g, ' ').replace(/\s+/g, ' ').trim();
}

function containsAllWords(text: string, words: string[]): boolean {
  return words.filter((word) => word.length > 1).every((word) => text.includes(word));
}

function stripMarkdownFrontmatter(markdown: string): string {
  return markdown.replace(/^---[\s\S]*?---\s*/, '');
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
