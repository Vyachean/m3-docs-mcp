import { execFile } from 'node:child_process';
import crypto from 'node:crypto';
import { rm } from 'node:fs/promises';
import { createRequire } from 'node:module';
import path from 'node:path';
import { promisify } from 'node:util';
import { chromium, type Browser, type BrowserContext, type Page } from 'playwright';
import { assertSafeCachePromotion, assertValidIndex, createStagingCacheDir, getDefaultCacheDir, promoteStagingCache, readIndex, readPage, writeIndex, writePage } from './cache.js';
import { materialPagePath, normalizeMaterialUrl } from './crawler-utils.js';
import { createEmptyExtractionDiagnostics, pushPageDiagnostic, pushRouteDiagnostic } from './json-extraction/diagnostics.js';
import { extractContentPageToMaterialPage } from './json-extraction/extract-content-page.js';
import { fetchJsonPageBundle } from './json-extraction/fetch-json-page.js';
import { extractMaterialPageFromHtml as extractMaterialPageFromHtmlFromModule, extractDisplayTokenSets, stripMarkdown, tokenTableToMarkdown, type TokenTableSystem } from './json-extraction/render-markdown.js';
import type { CrawlOptions, CrawlProgress, CrawlQualityReport, DuplicateContentGroup, DuplicateTitleGroup, ExtractionFallbackReason, ExtractionRouteDiagnostic, MaterialIndex, MaterialPage, RejectedCrawlRoute, ShortCrawlPage, SuspiciousCrawlPage } from './types.js';

const require = createRequire(import.meta.url);
const execFileAsync = promisify(execFile);
const DEFAULT_BASE_URL = 'https://m3.material.io';
const DEFAULT_MIN_PAGE_COUNT = 10;
// Re-crawl blog posts from the current year and the previous year; skip everything older.
const BLOG_POST_REUSE_YEAR_LAG = 1;
const DSDB_CONFIG_TIMEOUT_MS = 30_000;
const DSDB_DEFAULT_CONCURRENCY = 8;
const MIN_PAGE_TEXT_LENGTH = 80;
const SHORT_PAGE_TEXT_LENGTH = 160;
const CONTENT_PREVIEW_LENGTH = 800;
const COMPONENT_PATH_WITHOUT_OVERVIEW = /^\/components\/([^/]+)$/;
const MATERIAL_CONTENT_SELECTOR = 'main, [role="main"]';
const DEFAULT_CRAWL_CONCURRENCY = 1;
const MAX_DISCOVERED_LINK_FACTOR = 4;
const SITEMAP_FETCH_TIMEOUT_MS = 5_000;
const NOT_FOUND_TITLE_PATTERNS = [
  /\bpage cannot be found\b/i,
  /\bthis page cannot be found\b/i,
  /\bpage not found\b/i,
  /\b404\b/i
];
const NOT_FOUND_BODY_PATTERNS = [
  /\bthis page cannot be found\b/i,
  /\bpage cannot be found\b/i,
  /\bpage not found\b/i,
  /\brequested page was not found\b/i,
  /\bcould not find (that|this) page\b/i,
  /\btry a different destination\b/i,
  /\bhead back to the homepage\b/i
];

type DsdbRoute = {
  slug: string;
  documentId: string;
  collectionId: string;
  exportedCarbonFileId: string;
  collectionName?: string;
  pageCanonId?: string;
};

type DsdbSiteConfig = {
  carbonVersion: string;
  routes: DsdbRoute[];
};

type ExtractedContent = {
  html: string;
  title: string;
  headings: string[];
};

type StableSnapshot = {
  url: string;
  title: string;
  text: string;
};

type MaterialContentState = {
  title: string;
  text: string;
  pathname: string;
  renderedNotFound: boolean;
  expectedComponentSlug: string | null;
  pathMatches: boolean;
  contentMatches: boolean;
};

type SerializedPattern = {
  source: string;
  flags: string;
};

class CandidateRejectedError extends Error {
  readonly state: MaterialContentState;
  readonly classification: RejectedCrawlRoute['classification'];

  constructor(message: string, state: MaterialContentState, classification: RejectedCrawlRoute['classification']) {
    super(message);
    this.name = 'CandidateRejectedError';
    this.state = state;
    this.classification = classification;
  }
}

class RequestedRouteRejectedError extends Error {
  readonly rejectedRoute: RejectedCrawlRoute;

  constructor(rejectedRoute: RejectedCrawlRoute, details: string) {
    super(details);
    this.name = 'RequestedRouteRejectedError';
    this.rejectedRoute = rejectedRoute;
  }
}

export async function installPlaywrightChromium(withDependencies = false): Promise<void> {
  const playwrightCli = resolvePlaywrightCliPath();
  await execFileAsync(process.execPath, [playwrightCli, 'install', ...(withDependencies ? ['--with-deps'] : []), 'chromium']);
}

export function resolvePlaywrightCliPath(): string {
  const playwrightPackageJson = require.resolve('playwright/package.json');
  const playwrightPackage = require(playwrightPackageJson) as { bin?: string | Record<string, string> };
  const relativeCliPath = typeof playwrightPackage.bin === 'string'
    ? playwrightPackage.bin
    : playwrightPackage.bin?.playwright;

  if (!relativeCliPath) {
    throw new Error('Could not resolve the Playwright CLI entrypoint from playwright/package.json.');
  }

  return path.join(path.dirname(playwrightPackageJson), relativeCliPath);
}

async function launchChromium(headless: boolean): Promise<Browser> {
  try {
    return await chromium.launch({ headless });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    if (!message.includes('Executable doesn\'t exist') && !message.includes('browserType.launch')) {
      throw new Error(`Playwright Chromium failed to start. Run: npx -y github:Vyachean/m3-docs-mcp install-browser --with-deps. Original error: ${message}`, { cause: error });
    }

    throw new Error('Playwright Chromium browser is missing. Run: npx -y github:Vyachean/m3-docs-mcp install-browser. On Linux, use: npx -y github:Vyachean/m3-docs-mcp install-browser --with-deps', { cause: error });
  }
}

async function expandMainContent(page: Page): Promise<void> {
  await page.evaluate(async () => {
    const wait = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
    const root = document.querySelector('main') ?? document.querySelector('[role="main"]');
    if (!root) return;

    for (const details of Array.from(root.querySelectorAll('details:not([open])'))) {
      details.setAttribute('open', 'true');
    }

    const isSafeContentExpander = (el: Element): el is HTMLElement => {
      if (!(el instanceof HTMLElement)) return false;
      if (!el.closest('main, [role="main"]')) return false;
      if (el.closest('nav, aside, header, footer, [role="navigation"]')) return false;
      if (el.closest('a')) return false;
      if (el.matches('[href], [role="link"], [role="tab"], [role="menuitem"]')) return false;
      const tag = el.tagName.toLowerCase();
      return tag === 'button' || el.getAttribute('role') === 'button';
    };

    for (let pass = 0; pass < 4; pass += 1) {
      const expandable = Array.from(root.querySelectorAll('[aria-expanded="false"]')).filter(isSafeContentExpander);
      if (expandable.length === 0) break;
      for (const el of expandable) {
        el.click();
        await wait(25);
      }
    }
    await wait(200);
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

async function navigateToStableMaterialPage(page: Page, requestedUrl: string, baseUrl: string, signal?: AbortSignal): Promise<string> {
  const candidates = materialCrawlCandidates(requestedUrl, baseUrl);
  if (candidates.length === 0) throw new Error(`Unsupported Material URL: ${requestedUrl}`);

  let lastError: unknown;
  let lastRejectedCandidate: CandidateRejectedError | null = null;
  for (const loadUrl of candidates) {
    throwIfAborted(signal);
    try {
      await page.goto(loadUrl, { waitUntil: 'domcontentloaded', timeout: 45000 });
      await page.waitForSelector(MATERIAL_CONTENT_SELECTOR, { timeout: 15_000 });
      await waitForMaterialContent(page, loadUrl);
      await waitForStableMaterialSnapshot(page, signal);
      return normalizeMaterialUrl(page.url(), baseUrl) ?? loadUrl;
    } catch (error) {
      if (signal?.aborted) throw error;
      if (error instanceof CandidateRejectedError) lastRejectedCandidate = error;
      lastError = error;
    }
  }

  if (lastRejectedCandidate) {
    const normalizedRequestedUrl = normalizeMaterialUrl(requestedUrl, baseUrl) ?? requestedUrl;
    throw new RequestedRouteRejectedError({
      url: normalizedRequestedUrl,
      path: materialPagePath(normalizedRequestedUrl),
      title: lastRejectedCandidate.state.title || 'Untitled',
      reason: lastRejectedCandidate.message,
      classification: lastRejectedCandidate.classification,
      status: 'failed'
    }, `Material page rejected for ${requestedUrl}. Tried: ${candidates.join(', ')}. Last rejection: ${lastRejectedCandidate.message}`);
  }

  const details = lastError instanceof Error ? lastError.message : String(lastError);
  throw new Error(`Material page did not render stable content for ${requestedUrl}. Tried: ${candidates.join(', ')}. Last error: ${details}`);
}

async function waitForMaterialContent(page: Page, requestedUrl: string): Promise<void> {
  const state = await readMaterialContentState(page, requestedUrl);
  if (state.renderedNotFound) {
    throw new CandidateRejectedError('route rendered a not found page', state, 'not-found');
  }
  if (state.expectedComponentSlug && (!state.pathMatches || !state.contentMatches)) {
    throw new CandidateRejectedError(`component route content did not match expected component slug ${state.expectedComponentSlug}`, state, 'route-mismatch');
  }
}

async function readMaterialContentState(page: Page, requestedUrl: string): Promise<MaterialContentState> {
  const expectedComponentSlug = componentSlugFromUrl(requestedUrl);
  const notFoundTitlePatterns = serializePatterns(NOT_FOUND_TITLE_PATTERNS);
  const notFoundBodyPatterns = serializePatterns(NOT_FOUND_BODY_PATTERNS);
  await page.waitForFunction(({ minPageTextLength, notFoundTitlePatterns, notFoundBodyPatterns }) => {
    const normalize = (value: string) => value.toLowerCase().replace(/&/g, ' and ').replace(/[^a-z0-9]+/g, ' ').replace(/\s+/g, ' ').trim();
    const matchesAnyPattern = (value: string, patterns: SerializedPattern[]) => patterns.some((pattern) => new RegExp(pattern.source, pattern.flags).test(value));
    const root = document.querySelector('main') ?? document.querySelector('[role="main"]') ?? document.body;
    const rawTitle = root.querySelector('h1')?.textContent?.replace(/\s+/g, ' ').trim() ?? '';
    const rawText = root.textContent?.replace(/\s+/g, ' ').trim() ?? '';
    const title = normalize(rawTitle);
    const text = normalize(rawText);
    const renderedNotFound = matchesAnyPattern(title, notFoundTitlePatterns)
      || matchesAnyPattern(text, notFoundBodyPatterns);

    return renderedNotFound || (rawText.length >= minPageTextLength && Boolean(rawTitle));
  }, {
    minPageTextLength: MIN_PAGE_TEXT_LENGTH,
    notFoundTitlePatterns,
    notFoundBodyPatterns
  }, { timeout: 20_000 });

  return page.evaluate(({ componentSlug, notFoundTitlePatterns, notFoundBodyPatterns }) => {
    const normalize = (value: string) => value.toLowerCase().replace(/&/g, ' and ').replace(/[^a-z0-9]+/g, ' ').replace(/\s+/g, ' ').trim();
    const matchesAnyPattern = (value: string, patterns: SerializedPattern[]) => patterns.some((pattern) => new RegExp(pattern.source, pattern.flags).test(value));
    const root = document.querySelector('main') ?? document.querySelector('[role="main"]') ?? document.body;
    const rawTitle = root.querySelector('h1')?.textContent?.replace(/\s+/g, ' ').trim() ?? '';
    const rawText = root.textContent?.replace(/\s+/g, ' ').trim() ?? '';
    const title = normalize(rawTitle);
    const text = normalize(rawText);
    const pathname = window.location.pathname.replace(/^\/+|\/+$/g, '');
    const renderedNotFound = matchesAnyPattern(title, notFoundTitlePatterns)
      || matchesAnyPattern(text, notFoundBodyPatterns);
    if (!componentSlug) {
      return {
        title: rawTitle,
        text: rawText,
        pathname,
        renderedNotFound,
        expectedComponentSlug: null,
        pathMatches: true,
        contentMatches: true
      };
    }

    const componentName = normalize(componentSlug.replace(/-/g, ' '));
    const componentWords = componentName.split(' ').filter((word) => word.length > 1);
    const pathMatches = pathname === `components/${componentSlug}` || pathname === `components/${componentSlug}/overview` || pathname.startsWith(`components/${componentSlug}/`);
    const contentMatches = title !== 'components' && !renderedNotFound && componentWords.every((word) => text.includes(word));
    return {
      title: rawTitle,
      text: rawText,
      pathname,
      renderedNotFound,
      expectedComponentSlug: componentSlug,
      pathMatches,
      contentMatches
    };
  }, {
    componentSlug: expectedComponentSlug,
    notFoundTitlePatterns,
    notFoundBodyPatterns
  });
}

async function waitForStableMaterialSnapshot(page: Page, signal?: AbortSignal): Promise<void> {
  let previous: StableSnapshot | null = null;
  let stableReads = 0;
  for (let attempt = 0; attempt < 12; attempt += 1) {
    throwIfAborted(signal);
    const current = await materialSnapshot(page);
    if (previous && current.url === previous.url && current.title === previous.title && current.text === previous.text) {
      stableReads += 1;
      if (stableReads >= 2) return;
    } else {
      stableReads = 0;
    }
    previous = current;
    await delay(250, signal);
  }
  throw new Error('Material page content did not stabilize before extraction.');
}

async function materialSnapshot(page: Page): Promise<StableSnapshot> {
  return page.evaluate(() => {
    const root = document.querySelector('main') ?? document.querySelector('[role="main"]') ?? document.body;
    return {
      url: window.location.href,
      title: root.querySelector('h1')?.textContent?.replace(/\s+/g, ' ').trim() ?? '',
      text: root.textContent?.replace(/\s+/g, ' ').trim().slice(0, 5000) ?? ''
    };
  });
}

function delay(ms: number, signal?: AbortSignal): Promise<void> {
  if (!signal) return new Promise((resolve) => setTimeout(resolve, ms));
  throwIfAborted(signal);
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      signal.removeEventListener('abort', onAbort);
      resolve();
    }, ms);
    const onAbort = () => {
      clearTimeout(timer);
      reject(abortError(signal));
    };
    signal.addEventListener('abort', onAbort, { once: true });
  });
}

function throwIfAborted(signal?: AbortSignal): void {
  if (signal?.aborted) throw abortError(signal);
}

function abortError(signal: AbortSignal): Error {
  if (signal.reason instanceof Error) return signal.reason;
  return new Error(signal.reason ? String(signal.reason) : 'Material 3 crawl was interrupted.');
}

export function extractMaterialPageFromHtml(html: string, url: string, capturedAt = new Date().toISOString(), metadata?: Partial<Pick<ExtractedContent, 'title' | 'headings'>>, tokenSystem?: TokenTableSystem): MaterialPage {
  return extractMaterialPageFromHtmlFromModule(html, url, capturedAt, metadata, tokenSystem);
}

export { extractDisplayTokenSets, tokenTableToMarkdown };

async function extractTokenSystem(page: Page, html: string): Promise<TokenTableSystem | undefined> {
  if (!html.includes('token-viewer') && !html.includes('TOKEN-VIEWER')) return undefined;

  const tokenTableUrl = await page.evaluate(() => {
    const entries = performance.getEntriesByType('resource') as PerformanceResourceTiming[];
    return entries.find((e) => e.name.includes('TOKEN_TABLE'))?.name ?? null;
  });
  if (!tokenTableUrl) return undefined;

  const rawData = await page.evaluate(async (url) => {
    try {
      const resp = await fetch(url);
      return resp.ok ? (resp.json() as Promise<unknown>) : null;
    } catch {
      return null;
    }
  }, tokenTableUrl);
  if (!rawData || typeof rawData !== 'object') return undefined;

  const system = (rawData as { system?: unknown }).system;
  if (!system || typeof system !== 'object') return undefined;
  return system as TokenTableSystem;
}

async function extract(page: Page, url: string): Promise<MaterialPage> {
  // Angular loads token-viewer elements asynchronously; wait for them before capturing HTML.
  // The selector fails quickly on pages with no token-viewers and succeeds early on others.
  await page.waitForSelector('token-viewer', { timeout: 10000 }).catch(() => undefined);

  const content = await page.evaluate(() => {
    const root = document.querySelector('main') ?? document.querySelector('[role="main"]') ?? document.body;
    const clone = root.cloneNode(true) as HTMLElement;

    // Extract the token system JSON before stripping it — it can be 10-20 MB of embedded JSON.
    const tokenSystemJson: string | null =
      clone.querySelector('token-viewer[design-system-data]')?.getAttribute('design-system-data') ?? null;
    for (const el of Array.from(clone.querySelectorAll<Element>('[design-system-data]'))) {
      el.removeAttribute('design-system-data');
    }

    for (const selector of ['script', 'style', 'noscript', 'svg[aria-hidden="true"]']) {
      for (const el of Array.from(clone.querySelectorAll(selector))) el.remove();
    }
    for (const selector of ['nav', '[role="navigation"]', '[role="tablist"]', 'button', '[role="button"]', 'input', 'select']) {
      for (const el of Array.from(clone.querySelectorAll(selector))) {
        const text = el.textContent?.replace(/\s+/g, ' ').trim().toLowerCase() ?? '';
        if (!text || text === 'copy link' || text === 'close' || text === 'search') el.remove();
      }
    }
    const normalize = (value: string) => value.toLowerCase().replace(/\s+/g, ' ').trim();
    const isNoiseOnlyText = (value: string) => {
      const text = normalize(value);
      if (!text) return false;
      if (text === 'on this page' || text === 'copy link' || text === 'link copied') return true;
      if (/^resources[a-z0-9+]+$/i.test(text)) return true;
      if (/^(link|pause|search|close)$/i.test(text)) return true;
      if (/^(infooverview|stylespecs|design_servicesguidelines|head_mounted_devicexr|accessibility_newaccessibility)$/i.test(text.replace(/[^a-z_]/g, ''))) return true;
      return false;
    };
    for (const el of Array.from(clone.querySelectorAll<HTMLElement>('p, div, span, li, a'))) {
      if (el.children.length > 0) continue;
      if (isNoiseOnlyText(el.textContent ?? '')) el.remove();
    }
    for (const el of Array.from(clone.querySelectorAll<HTMLElement>('[style*="background-image"]'))) {
      const backgroundImage = el.style.backgroundImage;
      const match = backgroundImage.match(/url\(["']?([^"')]+)["']?\)/i);
      if (match?.[1]) el.setAttribute('data-background-image', match[1]);
    }
    const textContent = (element: Element | null) => element?.textContent?.replace(/\s+/g, ' ').trim() ?? '';
    return {
      html: clone.innerHTML,
      title: textContent(clone.querySelector('h1')),
      headings: Array.from(clone.querySelectorAll('h1, h2, h3, h4')).map(textContent).filter(Boolean),
      tokenSystemJson,
    };
  });

  let tokenSystem: TokenTableSystem | undefined;
  if (content.tokenSystemJson) {
    try {
      const parsed: unknown = JSON.parse(content.tokenSystemJson);
      const sys = (parsed as { system?: unknown })?.system;
      if (sys && typeof sys === 'object') tokenSystem = sys as TokenTableSystem;
    } catch { /* ignore */ }
  }
  if (!tokenSystem) {
    tokenSystem = await extractTokenSystem(page, content.html).catch(() => undefined as undefined);
  }

  return extractMaterialPageFromHtml(content.html, url, undefined, { title: content.title, headings: content.headings }, tokenSystem);
}

export function normalizeMaterialCrawlUrl(raw: string, baseUrl: string): string | null {
  return normalizeMaterialUrl(raw, baseUrl);
}

export function materialCrawlCandidates(raw: string, baseUrl: string): string[] {
  const normalized = normalizeMaterialCrawlUrl(raw, baseUrl);
  if (!normalized) return [];
  const candidates = [normalized];
  const url = new URL(normalized);
  const componentMatch = url.pathname.match(COMPONENT_PATH_WITHOUT_OVERVIEW);
  const slug = componentMatch?.[1];
  if (slug) {
    url.pathname = `/components/${slug}/overview`;
    const overviewUrl = url.toString().replace(/\/$/, '');
    if (!candidates.includes(overviewUrl)) candidates.push(overviewUrl);
  }
  return candidates;
}

export function discoverMaterialLinksFromHrefs(hrefs: string[], baseUrl: string): string[] {
  return Array.from(new Set(hrefs.map((href) => normalizeMaterialCrawlUrl(href, baseUrl)).filter((value): value is string => Boolean(value)))).sort(compareMaterialCrawlPriority);
}

async function discoverSitemapLinks(baseUrl: string): Promise<string[]> {
  if (typeof fetch !== 'function') return [];
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), SITEMAP_FETCH_TIMEOUT_MS);
  try {
    const sitemapUrl = new URL('/sitemap.xml', baseUrl).toString();
    const response = await fetch(sitemapUrl, { signal: controller.signal });
    if (!response.ok) return [];
    const body = await response.text();
    const locUrls = Array.from(body.matchAll(/<loc>(https?:\/\/[^<]+)<\/loc>/g)).map((match) => match[1]).filter((url): url is string => Boolean(url));
    const urls = locUrls.length > 0 ? locUrls : Array.from(body.matchAll(/https?:\/\/[^\s<]+/g)).map((match) => match[0]);
    return discoverMaterialLinksFromHrefs(urls, baseUrl);
  } catch {
    return [];
  } finally {
    clearTimeout(timer);
  }
}

async function discoverLinks(page: Page, baseUrl: string): Promise<string[]> {
  const links = await page.evaluate(() => Array.from(document.querySelectorAll('a[href]')).map((a) => (a as HTMLAnchorElement).href));
  return discoverMaterialLinksFromHrefs(links, baseUrl);
}

async function assertMaterialRouteUnchanged(page: Page, expectedUrl: string, baseUrl: string, phase: string): Promise<void> {
  const currentUrl = normalizeMaterialUrl(page.url(), baseUrl);
  if (currentUrl !== expectedUrl) {
    throw new Error(`Material page route changed during ${phase}: expected ${expectedUrl}, got ${currentUrl ?? page.url()}`);
  }
}

export function validateCrawledPage(page: MaterialPage): SuspiciousCrawlPage | null {
  const path = new URL(page.url).pathname.replace(/^\/+|\/+$/g, '');
  const segments = path.split('/').filter(Boolean);
  const title = normalizeText(page.title);
  const firstHeading = normalizeText(page.headings[0] ?? page.title);
  const contentPreview = normalizeText(`${page.title} ${page.headings.join(' ')} ${page.text.slice(0, CONTENT_PREVIEW_LENGTH)}`);

  if (isNotFoundPage(page)) {
    return rejectedRoute(page, 'route rendered a not found page', 'not-found');
  }

  if (segments[0] === 'components' && segments.length >= 2) {
    const componentSlug = segments[1] ?? '';
    const componentName = normalizeSlug(componentSlug);
    if (title === 'components' || firstHeading === 'components') {
      return rejectedRoute(page, `component route rendered the parent Components index instead of ${componentSlug}`, 'route-mismatch');
    }
    if (!containsAllWords(contentPreview, componentName.split(' '))) {
      return rejectedRoute(page, `component route content does not mention expected component slug ${componentSlug}`, 'route-mismatch');
    }
  }

  return null;
}

export function createCrawlQualityReport(pages: MaterialPage[], rejectedSuspiciousPages: SuspiciousCrawlPage[] = []): CrawlQualityReport {
  const rejectedRoutes = rejectedSuspiciousPages.map(toRejectedRoute);
  const suspiciousPages = pages.map(validateCrawledPage).filter((page): page is SuspiciousCrawlPage => Boolean(page));
  const shortPages: ShortCrawlPage[] = pages
    .filter((page) => page.text.length < SHORT_PAGE_TEXT_LENGTH)
    .map((page) => ({ url: page.url, path: page.path, title: page.title, textLength: page.text.length }));
  const pagesBySection = countBy(pages.map((page) => page.section));
  return {
    suspiciousPages,
    rejectedRoutes,
    duplicateContent: duplicateContentGroups(pages),
    shortPages,
    duplicateTitles: duplicateTitleGroups(pages),
    pagesBySection
  };
}

export async function fetchDsdbSiteConfig(baseUrl: string, signal?: AbortSignal): Promise<DsdbSiteConfig> {
  throwIfAborted(signal);
  const configController = new AbortController();
  const timer = setTimeout(() => configController.abort(), DSDB_CONFIG_TIMEOUT_MS);
  const onAbort = () => configController.abort();
  signal?.addEventListener('abort', onAbort, { once: true });

  try {
    const htmlRes = await fetch(baseUrl, { signal: configController.signal });
    if (!htmlRes.ok) throw new Error(`Failed to fetch ${baseUrl}: ${htmlRes.status}`);
    const html = await htmlRes.text();

    throwIfAborted(signal);

    const mainJsMatch = html.match(/src="(\/static\/angular\/main\.[a-f0-9]+\.js)"/);
    if (!mainJsMatch?.[1]) throw new Error('Angular main bundle URL not found in page HTML');

    const mainJsUrl = new URL(mainJsMatch[1], baseUrl).toString();
    const jsRes = await fetch(mainJsUrl, { signal: configController.signal });
    if (!jsRes.ok) throw new Error(`Failed to fetch Angular bundle: ${jsRes.status}`);
    const mainJs = await jsRes.text();

    throwIfAborted(signal);

    const cvMatch = mainJs.match(/"carbonVersion":"([^"]+)"/);
    if (!cvMatch?.[1]) throw new Error('carbonVersion not found in Angular bundle');
    const carbonVersion = cvMatch[1];

    const routePattern = /"slug":"([^"]+)","documentId":"([^"]+)","collectionId":"([^"]+)"([^]*?)"exportedCarbonFileId":"([^"]+\.json)"/g;
    const routes: DsdbRoute[] = [];
    let m;
    while ((m = routePattern.exec(mainJs)) !== null) {
      const extraFields = m[4] ?? '';
      routes.push({
        slug: m[1],
        documentId: m[2],
        collectionId: m[3],
        exportedCarbonFileId: m[5],
        collectionName: extraFields.match(/"collectionName":"([^"]+)"/)?.[1],
        pageCanonId: extraFields.match(/"pageCanon(?:ical)?Id":"([^"]+)"/)?.[1]
      });
    }

    if (routes.length === 0) throw new Error('No DSDB routes found in Angular bundle');
    return { carbonVersion, routes };
  } finally {
    clearTimeout(timer);
    signal?.removeEventListener('abort', onAbort);
  }
}

function isDsdbCoveredPath(urlPath: string, dsdbSlugs: Set<string>): boolean {
  const path = urlPath.replace(/^\/+|\/+$/g, '');
  if (dsdbSlugs.has(path)) return true;
  const lastSlash = path.lastIndexOf('/');
  return lastSlash > 0 && dsdbSlugs.has(path.slice(0, lastSlash));
}

export async function crawlMaterialDocs(options: CrawlOptions = {}): Promise<MaterialIndex> {
  const targetCacheDir = options.cacheDir ?? getDefaultCacheDir();
  const previousIndex = await readIndex(targetCacheDir);
  const stagingCacheDir = await createStagingCacheDir(targetCacheDir);

  try {
    const index = await crawlIntoCache(stagingCacheDir, options, previousIndex, targetCacheDir);
    assertValidIndex(index, options.minPageCount ?? DEFAULT_MIN_PAGE_COUNT);
    assertSafeCachePromotion(index, previousIndex, { force: options.force });
    await promoteStagingCache(stagingCacheDir, targetCacheDir);
    return index;
  } catch (error) {
    await rm(stagingCacheDir, { recursive: true, force: true });
    throw error;
  }
}

async function crawlIntoCache(cacheDir: string, options: CrawlOptions, previousIndex: MaterialIndex | null = null, previousCacheDir = cacheDir): Promise<MaterialIndex> {
  const baseUrl = options.baseUrl ?? DEFAULT_BASE_URL;
  const maxPages = options.maxPages ?? 250;
  const concurrency = Math.min(options.concurrency ?? DEFAULT_CRAWL_CONCURRENCY, maxPages);
  const signal = options.signal;
  const startedAt = new Date().toISOString();
  const currentUrls = new Map<number, string>();
  let lastSavedUrl: string | null = null;
  let lastFailedUrl: string | null = null;
  throwIfAborted(signal);

  const reusableBlogPages = buildReusableBlogPageMap(previousIndex);
  const blogPostYears = new Map<string, number>();

  // Declared here so the nested worker() function can close over it
  let browserContext: BrowserContext | undefined;

  const extractionDiagnostics = createEmptyExtractionDiagnostics();
  const queue: string[] = [];
  const queued = new Set<string>();
  const seen = new Set<string>();
  const writtenPaths = new Set<string>();
  const pages: MaterialPage[] = [];
  const failedUrls: string[] = [];
  const suspiciousPages: SuspiciousCrawlPage[] = [];
  const jsonFallbackRoutes = new Map<string, ExtractionFallbackReason>();
  const routeDiagnosticsByPath = new Map<string, ExtractionRouteDiagnostic>();
  const waiters: Array<() => void> = [];
  let activeWorkers = 0;
  let aborted = false;
  let dsdbAttemptedCount = 0;
  const minAcceptedPageCount = options.minPageCount ?? DEFAULT_MIN_PAGE_COUNT;

  const emitProgress = (running: boolean, error: string | null = null): void => {
    const completedAt = running ? null : new Date().toISOString();
    const progress: CrawlProgress = {
      startedAt,
      updatedAt: new Date().toISOString(),
      completedAt,
      running,
      maxPages,
      concurrency,
      attemptedPageCount: dsdbAttemptedCount + seen.size,
      savedPageCount: pages.length,
      failedPageCount: failedUrls.length,
      queuedPageCount: queue.length,
      activeWorkerCount: activeWorkers,
      currentUrls: Array.from(currentUrls.values()).sort(),
      lastSavedUrl,
      lastFailedUrl,
      error
    };
    options.onProgress?.(progress);
  };

  const recordRouteDiagnostic = (diagnostic: ExtractionRouteDiagnostic): void => {
    routeDiagnosticsByPath.set(diagnostic.path, diagnostic);
  };

  const routePathFromSlug = (slug: string): string => materialPagePath(new URL(`/${slug}`, baseUrl).toString());

  // ── Phase 1: DSDB direct JSON fetch (no browser) ──────────────────────────
  const jsonExtractedSlugs = new Set<string>();
  {
    let dsdbConfig: DsdbSiteConfig | null = null;
    try {
      throwIfAborted(signal);
      dsdbConfig = await fetchDsdbSiteConfig(baseUrl, signal);
    } catch (err) {
      if (signal?.aborted) throw err;
      console.error(`DSDB config fetch failed, falling back to browser-only crawl: ${err instanceof Error ? err.message : String(err)}`);
    }

    if (dsdbConfig) {
      const capturedAt = new Date().toISOString();
      const dsdbBatchSize = DSDB_DEFAULT_CONCURRENCY;
      const routes = dsdbConfig.routes;
      for (let i = 0; i < routes.length && pages.length < maxPages && !signal?.aborted; i += dsdbBatchSize) {
        throwIfAborted(signal);
        const batch = routes.slice(i, i + dsdbBatchSize);
        await Promise.all(batch.map(async (route) => {
          if (pages.length >= maxPages || signal?.aborted) return;
          dsdbAttemptedCount += 1;
          try {
            throwIfAborted(signal);
            const bundle = await fetchJsonPageBundle(baseUrl, dsdbConfig!.carbonVersion, {
              slug: route.slug,
              documentId: route.documentId,
              collectionId: route.collectionId,
              collectionName: route.collectionName,
              exportedCarbonFileId: route.exportedCarbonFileId,
              pageCanonId: route.pageCanonId
            }, signal);
            const routePath = routePathFromSlug(route.slug);
            if (!bundle.pageData && !bundle.contentPage) {
              jsonFallbackRoutes.set(route.slug, 'json-fetch-failed');
              recordRouteDiagnostic({
                url: new URL(`/${route.slug}`, baseUrl).toString(),
                path: routePath,
                finalMethod: null,
                jsonAttempted: true,
                jsonSucceeded: false,
                fallbackReason: 'json-fetch-failed',
                browserFallbackAttempted: false,
                browserFallbackSucceeded: false,
                unknownChunkTypes: [],
                unknownResourceTypes: [],
                tokenTables: 0,
                tokenTablesRendered: 0,
                missingRequestedTokenSets: []
              });
              return;
            }
            const extraction = await extractContentPageToMaterialPage({
              url: new URL(`/${route.slug}`, baseUrl).toString(),
              pageData: bundle.pageData,
              contentPage: bundle.contentPage,
              capturedAt,
              fetchResource: bundle.fetchResource
            });
            if (extraction.fallbackReason) {
              jsonFallbackRoutes.set(route.slug, extraction.fallbackReason);
              recordRouteDiagnostic({
                url: extraction.page.url,
                path: extraction.page.path,
                finalMethod: null,
                jsonAttempted: true,
                jsonSucceeded: false,
                fallbackReason: extraction.fallbackReason,
                browserFallbackAttempted: false,
                browserFallbackSucceeded: false,
                unknownChunkTypes: extraction.pageDiagnostic.unknownChunkTypes,
                unknownResourceTypes: extraction.pageDiagnostic.unknownResourceTypes,
                tokenTables: extraction.pageDiagnostic.tokenTables,
                tokenTablesRendered: extraction.pageDiagnostic.tokenTablesRendered,
                missingRequestedTokenSets: extraction.pageDiagnostic.missingRequestedTokenSets
              });
              return;
            }
            const materialPage = extraction.page;
            if (materialPage.text.length > MIN_PAGE_TEXT_LENGTH && pages.length < maxPages && !writtenPaths.has(materialPage.path)) {
              pages.push(materialPage);
              pushPageDiagnostic(extractionDiagnostics, extraction.pageDiagnostic);
              recordRouteDiagnostic({
                url: materialPage.url,
                path: materialPage.path,
                finalMethod: 'json',
                jsonAttempted: true,
                jsonSucceeded: true,
                browserFallbackAttempted: false,
                browserFallbackSucceeded: false,
                unknownChunkTypes: extraction.pageDiagnostic.unknownChunkTypes,
                unknownResourceTypes: extraction.pageDiagnostic.unknownResourceTypes,
                tokenTables: extraction.pageDiagnostic.tokenTables,
                tokenTablesRendered: extraction.pageDiagnostic.tokenTablesRendered,
                missingRequestedTokenSets: extraction.pageDiagnostic.missingRequestedTokenSets
              });
              writtenPaths.add(materialPage.path);
              jsonExtractedSlugs.add(route.slug);
              lastSavedUrl = materialPage.url;
              await writePage(materialPage, cacheDir);
              emitProgress(true);
            }
          } catch (err) {
            if (signal?.aborted) return;
            jsonFallbackRoutes.set(route.slug, 'json-fetch-failed');
            recordRouteDiagnostic({
              url: new URL(`/${route.slug}`, baseUrl).toString(),
              path: routePathFromSlug(route.slug),
              finalMethod: null,
              jsonAttempted: true,
              jsonSucceeded: false,
              fallbackReason: 'json-fetch-failed',
              browserFallbackAttempted: false,
              browserFallbackSucceeded: false,
              unknownChunkTypes: [],
              unknownResourceTypes: [],
              tokenTables: 0,
              tokenTablesRendered: 0,
              missingRequestedTokenSets: []
            });
            console.error(`JSON extraction failed for ${route.slug}: ${err instanceof Error ? err.message : String(err)}`);
          }
        }));
      }
      emitProgress(true);
    }
  }

  // ── Phase 2: Browser crawl for JSON misses and uncovered routes ───────────
  const jsonExtractionSatisfiedMinimum = pages.length >= minAcceptedPageCount;
  if (pages.length < maxPages && !signal?.aborted && !jsonExtractionSatisfiedMinimum) {
    const browser = await launchChromium(options.headless ?? true);
    browserContext = await browser.newContext({ viewport: { width: 1440, height: 1400 } });

    const onAbort = () => {
      aborted = true;
      emitProgress(false, 'Material 3 crawl was interrupted.');
      wakeWorkers();
      void browserContext?.close().catch(() => undefined);
    };
    signal?.addEventListener('abort', onAbort, { once: true });
    enqueue(baseUrl);
    for (const slug of jsonFallbackRoutes.keys()) enqueue(new URL(`/${slug}`, baseUrl).toString());
    for (const link of await discoverSitemapLinks(baseUrl)) enqueue(link);
    emitProgress(true);

    try {
      await Promise.all(Array.from({ length: concurrency }, (_, workerIndex) => worker(workerIndex)));
    } catch (error) {
      emitProgress(false, error instanceof Error ? error.message : String(error));
      throw error;
    } finally {
      signal?.removeEventListener('abort', onAbort);
      wakeWorkers();
      await browser.close();
    }

    throwIfAborted(signal);
  }

  const capturedAt = new Date().toISOString();
  for (const diagnostic of routeDiagnosticsByPath.values()) pushRouteDiagnostic(extractionDiagnostics, diagnostic);
  const qualityReport = createCrawlQualityReport(pages, suspiciousPages);
  const index: MaterialIndex = {
    source: baseUrl,
    capturedAt,
    pageCount: pages.length,
    attemptedPageCount: dsdbAttemptedCount + seen.size,
    failedPageCount: failedUrls.length,
    failedUrls,
    qualityReport,
    extractionDiagnostics,
    pages: pages.map(({ text: _text, markdown: _markdown, ...meta }) => meta)
  };
  await writeIndex(index, cacheDir);
  emitProgress(false);
  return index;

  async function worker(workerIndex: number): Promise<void> {
    while (!aborted) {
      throwIfAborted(signal);
      if (pages.length >= maxPages) return;

      let url = takeUrl();
      while (!url && activeWorkers > 0 && pages.length < maxPages && !aborted) {
        await waitForQueuedUrl();
        throwIfAborted(signal);
        url = takeUrl();
      }
      if (!url) return;

      let page: Page | null = null;
      activeWorkers += 1;
      currentUrls.set(workerIndex, url);
      emitProgress(true);
      try {
        page = await browserContext!.newPage();
        throwIfAborted(signal);
        await crawlPage(page, url);
      } catch (error) {
        if (signal?.aborted) throw error;
        failedUrls.push(url);
        lastFailedUrl = url;
        emitProgress(true);
        console.error(`Failed to crawl ${url}:`, error instanceof Error ? error.message : String(error));
      } finally {
        activeWorkers -= 1;
        currentUrls.delete(workerIndex);
        emitProgress(true);
        await page?.close().catch(() => undefined);
        wakeWorkers();
      }
    }
  }

  function takeUrl(): string | null {
    while (queue.length > 0) {
      const queuedUrl = queue.shift();
      if (!queuedUrl) continue;
      queued.delete(queuedUrl);
      if (seen.has(queuedUrl)) continue;
      seen.add(queuedUrl);
      emitProgress(true);
      return queuedUrl;
    }
    return null;
  }

  async function crawlPage(page: Page, url: string): Promise<void> {
    if (reusableBlogPages.size > 0) {
      const cached = reusableBlogPages.get(url);
      if (cached && !writtenPaths.has(cached.path)) {
        try {
          const markdown = await readPage(cached.path, previousCacheDir);
          const text = stripMarkdown(stripMarkdownFrontmatter(markdown)).replace(/\s+/g, ' ').trim();
          if (text.length > MIN_PAGE_TEXT_LENGTH && pages.length < maxPages) {
            const materialPage: MaterialPage = { ...cached, text, markdown };
            pages.push(materialPage);
            const fallbackReason = jsonFallbackRoutes.get(materialPage.path.replace(/\/overview\.md$/, '').replace(/\.md$/, ''));
            pushPageDiagnostic(extractionDiagnostics, {
              url: materialPage.url,
              path: materialPage.path,
              method: 'dom',
              ...(fallbackReason ? { fallbackReason } : {}),
              unknownChunkTypes: [],
              unknownResourceTypes: [],
              tokenTables: 0,
              tokenTablesRendered: 0,
              missingRequestedTokenSets: [],
              suspiciousReasons: [],
              imageCount: 0,
              videoCount: 0,
              unresolvedResourceCount: 0,
              noSections: false,
              noHeadings: materialPage.headings.length === 0,
              markdownLength: materialPage.markdown.length
            });
            recordRouteDiagnostic({
              ...(routeDiagnosticsByPath.get(materialPage.path) ?? {
                url: materialPage.url,
                path: materialPage.path,
                jsonAttempted: Boolean(fallbackReason),
                jsonSucceeded: false,
                unknownChunkTypes: [],
                unknownResourceTypes: [],
                tokenTables: 0,
                tokenTablesRendered: 0,
                missingRequestedTokenSets: []
              }),
              finalMethod: 'dom',
              ...(fallbackReason ? { fallbackReason } : {}),
              browserFallbackAttempted: false,
              browserFallbackSucceeded: false
            });
            writtenPaths.add(materialPage.path);
            lastSavedUrl = url;
            await writePage(materialPage, cacheDir);
            emitProgress(true);
          }
          return;
        } catch {
          // cache read failed — fall through to live crawl
        }
      }
    }

    let finalUrl: string;
    try {
      finalUrl = await navigateToStableMaterialPage(page, url, baseUrl, signal);
    } catch (error) {
      if (error instanceof RequestedRouteRejectedError) {
        suspiciousPages.push(error.rejectedRoute);
        failedUrls.push(url);
        lastFailedUrl = url;
        emitProgress(true);
        console.error(`Rejected crawled ${url}: ${error.rejectedRoute.reason}`);
        return;
      }
      throw error;
    }
    if (finalUrl !== url) seen.add(finalUrl);
    currentUrls.set(currentUrls.get(0) === url ? 0 : Array.from(currentUrls.entries()).find(([, current]) => current === url)?.[0] ?? 0, finalUrl);
    emitProgress(true);
    await expandMainContent(page);
    await assertMaterialRouteUnchanged(page, finalUrl, baseUrl, 'content expansion');
    await scrollPage(page);
    await assertMaterialRouteUnchanged(page, finalUrl, baseUrl, 'lazy-load scrolling');
    await waitForStableMaterialSnapshot(page, signal);
    await assertMaterialRouteUnchanged(page, finalUrl, baseUrl, 'stabilization');
    const materialPage = await extract(page, finalUrl);
    const suspiciousResult = validateCrawledPage(materialPage);
    if (suspiciousResult) {
      suspiciousPages.push(suspiciousResult);
      failedUrls.push(url);
      lastFailedUrl = url;
      emitProgress(true);
      console.error(`Rejected crawled ${url}: ${suspiciousResult.reason}`);
      return;
    }
    if (materialPage.text.length > MIN_PAGE_TEXT_LENGTH && pages.length < maxPages && !writtenPaths.has(materialPage.path)) {
      const publishedYear = materialPage.path.startsWith('blog/') ? blogPostYears.get(finalUrl) : undefined;
      const pageToSave = publishedYear ? { ...materialPage, publishedYear } : materialPage;
      pages.push(pageToSave);
      const fallbackReason = jsonFallbackRoutes.get(pageToSave.path.replace(/\/overview\.md$/, '').replace(/\.md$/, ''));
      pushPageDiagnostic(extractionDiagnostics, {
        url: pageToSave.url,
        path: pageToSave.path,
        method: 'dom',
        ...(fallbackReason ? { fallbackReason } : {}),
        unknownChunkTypes: [],
        unknownResourceTypes: [],
        tokenTables: 0,
        tokenTablesRendered: 0,
        missingRequestedTokenSets: [],
        suspiciousReasons: [],
        imageCount: 0,
        videoCount: 0,
        unresolvedResourceCount: 0,
        noSections: false,
        noHeadings: pageToSave.headings.length === 0,
        markdownLength: pageToSave.markdown.length
      });
      recordRouteDiagnostic({
        ...(routeDiagnosticsByPath.get(pageToSave.path) ?? {
          url: pageToSave.url,
          path: pageToSave.path,
          jsonAttempted: Boolean(fallbackReason),
          jsonSucceeded: false,
          unknownChunkTypes: [],
          unknownResourceTypes: [],
          tokenTables: 0,
          tokenTablesRendered: 0,
          missingRequestedTokenSets: []
        }),
        finalMethod: 'dom',
        ...(fallbackReason ? { fallbackReason } : {}),
        browserFallbackAttempted: true,
        browserFallbackSucceeded: true
      });
      lastSavedUrl = finalUrl;
      writtenPaths.add(pageToSave.path);
      await writePage(pageToSave, cacheDir);
      emitProgress(true);
    }

    await assertMaterialRouteUnchanged(page, finalUrl, baseUrl, 'link discovery');
    if (isBlogListingUrl(finalUrl, baseUrl)) {
      const pairs = await extractBlogListingYears(page, baseUrl).catch(() => [] as Array<[string, number]>);
      for (const [postUrl, year] of pairs) blogPostYears.set(postUrl, year);
    }
    for (const link of await discoverLinks(page, baseUrl)) enqueue(link);
    emitProgress(true);
  }

  function enqueue(raw: string): void {
    const link = normalizeMaterialCrawlUrl(raw, baseUrl);
    if (!link || seen.has(link) || queued.has(link)) return;
    const linkPath = new URL(link).pathname.replace(/^\/+|\/+$/g, '');
    if (isDsdbCoveredPath(linkPath, jsonExtractedSlugs)) return;
    if (queue.length + seen.size >= maxPages * MAX_DISCOVERED_LINK_FACTOR) return;
    queue.push(link);
    queue.sort(compareMaterialCrawlPriority);
    queued.add(link);
    emitProgress(true);
    wakeWorkers();
  }

  function waitForQueuedUrl(): Promise<void> {
    return new Promise((resolve) => {
      waiters.push(resolve);
    });
  }

  function wakeWorkers(): void {
    for (const resolve of waiters.splice(0)) resolve();
  }
}

function buildReusableBlogPageMap(previousIndex: MaterialIndex | null): Map<string, Omit<MaterialPage, 'text' | 'markdown'>> {
  const map = new Map<string, Omit<MaterialPage, 'text' | 'markdown'>>();
  if (!previousIndex) return map;
  const oldestAllowedYear = new Date().getFullYear() - BLOG_POST_REUSE_YEAR_LAG;
  for (const page of previousIndex.pages) {
    if (!page.path.startsWith('blog/')) continue;
    if (page.publishedYear && page.publishedYear < oldestAllowedYear) map.set(page.url, page);
  }
  return map;
}

function isBlogListingUrl(url: string, baseUrl: string): boolean {
  return new URL(url).pathname.replace(/^\/+|\/+$/g, '') === 'blog';
}

async function extractBlogListingYears(page: Page, baseUrl: string): Promise<Array<[string, number]>> {
  const origin = new URL(baseUrl).origin;
  return page.evaluate((origin) => {
    const result: Array<[string, number]> = [];
    const root = document.querySelector('main') ?? document.querySelector('[role="main"]') ?? document.body;
    let blogListingCurrentYear = 0;

    function walk(node: Element): void {
      const tag = node.nodeName.toLowerCase();
      if (/^h[1-6]$/.test(tag)) {
        const text = node.textContent?.replace(/\s+/g, ' ').trim() ?? '';
        const m = text.match(/^(20\d\d)$/);
        if (m) { blogListingCurrentYear = parseInt(m[1], 10); return; }
      }
      if (tag === 'a' && blogListingCurrentYear > 0) {
        const href = (node as HTMLAnchorElement).href;
        try {
          const url = new URL(href);
          if (url.origin === origin && url.pathname.startsWith('/blog/') && url.pathname.length > '/blog/'.length) {
            url.hash = '';
            url.search = '';
            result.push([url.toString().replace(/\/$/, ''), blogListingCurrentYear]);
          }
        } catch { /* ignore */ }
      }
      for (const child of Array.from(node.children)) walk(child);
    }
    walk(root);
    return result;
  }, origin);
}

function compareMaterialCrawlPriority(a: string, b: string): number {
  return materialCrawlPriority(a) - materialCrawlPriority(b) || a.localeCompare(b);
}

function materialCrawlPriority(url: string): number {
  const path = new URL(url).pathname;
  if (path === '/') return 0;
  if (path.startsWith('/get-started')) return 1;
  if (path.startsWith('/components')) return 2;
  if (path.startsWith('/foundations')) return 3;
  if (path.startsWith('/styles')) return 4;
  if (path.startsWith('/develop')) return 5;
  if (path.startsWith('/blog')) return 6;
  return 7;
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

function componentSlugFromUrl(url: string): string | null {
  const pathname = new URL(url).pathname.replace(/^\/+|\/+$/g, '');
  const segments = pathname.split('/').filter(Boolean);
  return segments[0] === 'components' && segments.length >= 2 ? segments[1] ?? null : null;
}

function countBy(values: string[]): Record<string, number> {
  return values.reduce<Record<string, number>>((acc, value) => {
    acc[value] = (acc[value] ?? 0) + 1;
    return acc;
  }, {});
}

function rejectedRoute(page: MaterialPage, reason: string, classification: RejectedCrawlRoute['classification']): RejectedCrawlRoute {
  return { url: page.url, path: page.path, title: page.title, reason, classification, status: 'failed' };
}

function toRejectedRoute(page: SuspiciousCrawlPage): RejectedCrawlRoute {
  if ('classification' in page && 'status' in page) return page as RejectedCrawlRoute;
  const classification = page.reason === 'route rendered a not found page' ? 'not-found' : 'route-mismatch';
  return { ...page, classification, status: 'failed' };
}

function isNotFoundPage(page: Pick<MaterialPage, 'title' | 'headings' | 'text'>): boolean {
  const title = page.title.trim();
  const firstHeading = (page.headings[0] ?? '').trim();
  const preview = `${page.title}\n${page.headings.join('\n')}\n${page.text.slice(0, CONTENT_PREVIEW_LENGTH)}`;
  return matchesAnyPattern(title, NOT_FOUND_TITLE_PATTERNS)
    || matchesAnyPattern(firstHeading, NOT_FOUND_TITLE_PATTERNS)
    || matchesAnyPattern(preview, NOT_FOUND_BODY_PATTERNS);
}

function matchesAnyPattern(value: string, patterns: RegExp[]): boolean {
  return patterns.some((pattern) => pattern.test(value));
}

function serializePatterns(patterns: RegExp[]): SerializedPattern[] {
  return patterns.map((pattern) => ({ source: pattern.source, flags: pattern.flags }));
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
