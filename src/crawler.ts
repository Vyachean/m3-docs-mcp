import { execFile } from 'node:child_process';
import crypto from 'node:crypto';
import { rename, rm } from 'node:fs/promises';
import { createRequire } from 'node:module';
import path from 'node:path';
import { promisify } from 'node:util';
import { chromium, type Browser, type BrowserContext, type Page } from 'playwright';
import { DEFAULT_MAX_FAILED_PAGE_RATIO, assertSafeCachePromotion, assertValidIndex, computeCoverageHealth, createStagingCacheDir, diagnosticsDir, getDefaultCacheDir, logsDir, promoteStagingCache, readIndex, readPage, writeIndex, writePage } from './cache.js';
import { UpdateLogger } from './update-logger.js';
import { CRAWL_PRIORITY_POLICY_VERSION, compareMaterialCrawlUrlPriority, compareMaterialRoutePriority, isBlogPath } from './crawl-priority.js';
import { materialPagePath, normalizeMaterialPublicDocPath, normalizeMaterialUrl } from './crawler-utils.js';
import { buildBundleFromCapturedResponses, createNetworkJsonCapture } from './json-extraction/capture-network-json.js';
import { computeSourceAndVirtualPageCounters, createEmptyExtractionDiagnostics, pushPageDiagnostic, pushRouteDiagnostic } from './json-extraction/diagnostics.js';
import { extractContentPageToMaterialPage } from './json-extraction/extract-content-page.js';
import { extractPageDataMetadata } from './json-extraction/extract-page-data.js';
import { createDsdbResourceFetcher, fetchCarbonContentByReference, fetchJsonPageBundle, fetchPageDataByReference } from './json-extraction/fetch-json-page.js';
import { SiteMetaParseError, fetchSiteMeta } from './json-extraction/fetch-site-meta.js';
import { countCapturedResponseTypes, writeRawJsonDebugFiles, type JsonCapturedResponse, type JsonPageBundle } from './json-extraction/json-bundle.js';
import { filterRoutes, normalizeSiteMetaRoutes, type NormalizedRoute } from './json-extraction/normalize-routes.js';
import {
  bundleRoutesUnderPrefix,
  extractBundleRouteTable,
  extractCarbonVersion as extractCarbonVersionFromBundleText,
  fetchAngularBundleText,
  findSubtreesWithoutCoverage,
  matchTabToSection,
  resolvePageReference,
  type BundleRouteEntry,
  type BundleTabEntry,
} from './json-extraction/page-reference-resolver.js';
import { parseContentPage } from './json-extraction/schemas.js';
import { computeEta, formatDurationMs } from './progress.js';
import { extractMaterialPageFromHtml as extractMaterialPageFromHtmlFromModule, extractDisplayTokenSets, normalizeTokenTableSystem, stripMarkdown, tokenTableToMarkdown, type TokenTableSystem } from './json-extraction/render-markdown.js';
import type { CoverageDiagnostics, CrawlOptions, CrawlPhase, CrawlProgress, CrawlQualityReport, DuplicateContentGroup, DuplicateTitleGroup, ExtractionFallbackReason, ExtractionRouteDiagnostic, ExtractionSource, JsonResponseType, MaterialIndex, MaterialPage, RejectedCrawlRoute, ShortCrawlPage, SuspiciousCrawlPage } from './types.js';

const require = createRequire(import.meta.url);
const execFileAsync = promisify(execFile);

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}
const DEFAULT_BASE_URL = 'https://m3.material.io';
const DEFAULT_MIN_PAGE_COUNT = 10;
// site_meta.routes has zero coverage under these subtrees (verified live via
// scripts/inspect-site-data.mjs: /styles/color/roles and /foundations/design-tokens have no
// site_meta entry at all). The bundle route table supplements navigation only for these
// documented prefixes — never as a general route-discovery source.
const TRACKED_BUNDLE_SUPPLEMENT_PREFIXES = ['styles', 'foundations'];
// Representative validation routes (as real, non-tab parent routes) that must always have a
// chance to be selected, even under a tight maxPages budget. /components/buttons/specs and
// /components/lists/specs are tabs of their parent route, not separate site_meta/bundle routes —
// the parent is reserved here, and tab-splitting produces the actual required cache pages.
const REQUIRED_VALIDATION_PARENT_PATHS = ['/components/buttons', '/components/lists', '/styles/color/roles', '/foundations/design-tokens'];
// Re-crawl blog posts from the current year and the previous year; skip everything older.
const BLOG_POST_REUSE_YEAR_LAG = 1;
const DSDB_CONFIG_TIMEOUT_MS = 30_000;
const MIN_PAGE_TEXT_LENGTH = 80;
const SHORT_PAGE_TEXT_LENGTH = 160;
const CONTENT_PREVIEW_LENGTH = 800;
const COMPONENT_PATH_WITHOUT_OVERVIEW = /^\/components\/([^/]+)$/;
const MATERIAL_CONTENT_SELECTOR = 'main, [role="main"]';
const DEFAULT_CRAWL_CONCURRENCY = 1;
const MAX_DISCOVERED_LINK_FACTOR = 4;
const SITEMAP_FETCH_TIMEOUT_MS = 5_000;
const COVERAGE_REGRESSION_RATIO = 0.8;
const COVERAGE_WARNING_GAP_RATIO = 0.2;
const COVERAGE_WARNING_GAP_MIN = 5;
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
  documentId?: string;
  collectionId?: string;
  exportedCarbonFileId?: string;
  collectionName?: string;
  pageCanonId?: string;
  metadataWarnings?: string[];
  /** Resolved via the isolated page-reference-resolver against the bundle route table. */
  tabs?: BundleTabEntry[];
  navigationSource?: 'site-meta' | 'bundle-supplement';
  pageReferenceSource?: 'bundle-table' | 'missing';
  selectedBecause?: 'budget' | 'required-validation';
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

  const rawData: unknown = await page.evaluate(async (url) => {
    try {
      const resp = await fetch(url);
      return resp.ok ? (resp.json() as Promise<unknown>) : null;
    } catch {
      return null;
    }
  }, tokenTableUrl);

  const system: unknown = isRecord(rawData) ? rawData['system'] : undefined;
  return normalizeTokenTableSystem(system) ?? undefined;
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
      const sys: unknown = isRecord(parsed) ? parsed['system'] : undefined;
      tokenSystem = normalizeTokenTableSystem(sys) ?? undefined;
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
  return Array.from(new Set(hrefs.map((href) => normalizeMaterialCrawlUrl(href, baseUrl)).filter((value): value is string => Boolean(value)))).sort(compareMaterialCrawlUrlPriority);
}

export function discoverPublicDocPathsFromHrefs(hrefs: string[], baseUrl: string): string[] {
  return Array.from(new Set(hrefs.map((href) => normalizeMaterialPublicDocPath(href, baseUrl)).filter((value): value is string => Boolean(value)))).sort(compareMaterialRoutePriority);
}

async function discoverSitemapLinks(baseUrl: string): Promise<string[]> {
  return (await discoverSitemapDocPaths(baseUrl)).map((docPath) => new URL(docPath, baseUrl).toString().replace(/\/$/, ''));
}

async function discoverSitemapDocPaths(baseUrl: string): Promise<string[]> {
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
    return discoverPublicDocPathsFromHrefs(urls, baseUrl);
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

async function discoverRenderedNavDocPaths(page: Page, baseUrl: string): Promise<string[]> {
  const links = await page.evaluate(() => Array.from(document.querySelectorAll('a[href]')).map((a) => (a as HTMLAnchorElement).href));
  return discoverPublicDocPathsFromHrefs(links, baseUrl);
}

function discoverPublicDocPathsFromHtml(html: string, baseUrl: string): string[] {
  const hrefs = Array.from(html.matchAll(/href=(?:"([^"]+)"|'([^']+)')/gi)).map((match) => match[1] ?? match[2] ?? '').filter(Boolean);
  return discoverPublicDocPathsFromHrefs(hrefs, baseUrl);
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

    const routes = extractDsdbRoutesFromBundle(mainJs);

    if (routes.length === 0) throw new Error('No DSDB routes found in Angular bundle');
    return { carbonVersion, routes };
  } finally {
    clearTimeout(timer);
    signal?.removeEventListener('abort', onAbort);
  }
}

const DSDB_VERSION_URL_RE = /\/_dsm\/(?:content\/m3|data\/dsdb-m3)\/([^/?#]+)\//i;
const NETWORK_BOOTSTRAP_SEED_PATHS = [
  '/',
  '/components/buttons/specs',
  '/components/lists/specs',
  '/styles/color',
  '/foundations/design-tokens/overview'
];
const NETWORK_BOOTSTRAP_DRAIN_MS = 2_000;

function classifyNetworkCandidateType(url: string): 'content' | 'token-table' | 'dsdb-resource' | 'page-data' | 'unknown-dsm' {
  if (url.includes('/_dsm/content/m3/')) return 'content';
  if (url.includes('/_dsm/data/dsdb-m3/')) {
    if (/\/TOKEN_TABLE\./i.test(url)) return 'token-table';
    return 'dsdb-resource';
  }
  if (url.includes('/page-data/')) return 'page-data';
  return 'unknown-dsm';
}

/**
 * Extracts carbonVersion by observing `/_dsm/content/m3/{version}/` or
 * `/_dsm/data/dsdb-m3/{version}/` URLs captured from a set of browser-navigated
 * seed pages. Returns null if no match is found.
 *
 * Waits for Material content to render, then allows a short drain window for
 * deferred network requests (e.g. `_dsm` URLs that arrive after the initial
 * `/page-data` response). Only DSDB-version URLs are accepted as recovery
 * candidates; `/page-data` responses are logged but are not sufficient.
 */
export async function bootstrapCarbonVersionFromBrowser(
  browserContext: BrowserContext,
  baseUrl: string,
  seedPaths: string[],
  signal?: AbortSignal,
  logger?: UpdateLogger,
  drainMs = NETWORK_BOOTSTRAP_DRAIN_MS
): Promise<{ carbonVersion: string; observedUrls: string[] } | null> {
  const observedUrls: string[] = [];

  for (const seedPath of seedPaths) {
    if (signal?.aborted) return null;
    const seedUrl = new URL(seedPath, baseUrl).toString();
    logger?.log('info', 'dsdb-config:network-seed-started', { seedPath, seedUrl });
    let page: Page | null = null;
    const listener = (response: { url: () => string; ok: () => boolean }) => {
      const url = response.url();
      if (!url.includes('/_dsm/') && !url.includes('/page-data/')) return;
      if (!response.ok()) return;
      observedUrls.push(url);
      const candidateType = classifyNetworkCandidateType(url);
      const match = url.match(DSDB_VERSION_URL_RE);
      const sufficient = Boolean(match?.[1]);
      logger?.log('info', 'dsdb-config:network-candidate-detected', {
        url,
        candidateType,
        carbonVersion: match?.[1] ?? null,
        sufficient
      });
    };
    try {
      page = await browserContext.newPage();
      page.on('response', listener);
      // Navigate and wait for Material content shell to appear
      await page.goto(seedUrl, { waitUntil: 'domcontentloaded', timeout: 30_000 });
      await page.waitForSelector(MATERIAL_CONTENT_SELECTOR, { timeout: 15_000 }).catch(() => undefined);
      // Check for DSDB URL that arrived during navigation (common path — return immediately)
      for (const url of observedUrls) {
        const match = url.match(DSDB_VERSION_URL_RE);
        if (match?.[1]) {
          logger?.log('info', 'dsdb-config:network-drain-complete', { seedPath, observedUrlCount: observedUrls.length, drained: false });
          return { carbonVersion: match[1], observedUrls };
        }
      }
      // Drain only when relevant network activity was observed (page-data without _dsm),
      // indicating _dsm may still be in-flight. Skip drain if nothing relevant arrived.
      const hasRelevantActivity = observedUrls.length > 0;
      if (hasRelevantActivity && drainMs > 0) {
        await delay(drainMs, signal);
      }
      logger?.log('info', 'dsdb-config:network-drain-complete', {
        seedPath,
        observedUrlCount: observedUrls.length,
        drained: hasRelevantActivity && drainMs > 0
      });
      for (const url of observedUrls) {
        const match = url.match(DSDB_VERSION_URL_RE);
        if (match?.[1]) {
          return { carbonVersion: match[1], observedUrls };
        }
      }
    } catch (err) {
      if (signal?.aborted) return null;
      // log rejection and continue to next seed
      const reason = err instanceof Error ? err.message : String(err);
      logger?.log('info', 'dsdb-config:network-candidate-rejected', { seedPath, reason });
    } finally {
      if (page) page.off('response', listener);
      await page?.close().catch(() => undefined);
    }
  }

  return null;
}

/**
 * Builds slug-only DsdbRoute entries from a set of discovered public doc paths.
 * These have no documentId/pageCanonId, but fetchJsonPageBundle handles that via
 * the page-data/{slug}/page-data.json fallback URL which resolves pageCanonId dynamically.
 */
export function buildSlugOnlyRoutesFromDocPaths(docPaths: Iterable<string>): DsdbRoute[] {
  const routes: DsdbRoute[] = [];
  const seen = new Set<string>();
  for (const docPath of docPaths) {
    const slug = docPath.replace(/^\/+|\/+$/g, '');
    if (!slug || seen.has(slug)) continue;
    seen.add(slug);
    routes.push({ slug });
  }
  return routes;
}

export function extractCarbonVersionFromNetworkUrls(urls: string[]): string | null {
  for (const url of urls) {
    const match = url.match(DSDB_VERSION_URL_RE);
    if (match?.[1]) return match[1];
  }
  return null;
}

export function extractDsdbRoutesFromBundle(mainJs: string): DsdbRoute[] {
  const routes: DsdbRoute[] = [];
  const seen = new Set<string>();
  const fragments = findRouteObjectFragments(mainJs);
  const candidates = fragments.length > 0 ? fragments : findLooseRouteFragments(mainJs);

  for (const fragment of candidates) {
    const route = parseDsdbRouteFragment(fragment);
    if (!route?.slug) continue;
    const routeKey = [
      route.slug,
      route.documentId ?? '',
      route.pageCanonId ?? '',
      route.exportedCarbonFileId ?? ''
    ].join('|');
    if (seen.has(routeKey)) continue;
    seen.add(routeKey);
    routes.push(route);
  }

  return routes;
}

function findRouteObjectFragments(source: string): string[] {
  const fragments: string[] = [];
  const slugPattern = /"slug":"[^"]+"/g;
  let match: RegExpExecArray | null;
  while ((match = slugPattern.exec(source)) !== null) {
    const fragment = extractBalancedObject(source, match.index);
    if (fragment && fragment.includes('"slug"')) fragments.push(fragment);
  }
  return fragments;
}

function findLooseRouteFragments(source: string): string[] {
  const matches = Array.from(source.matchAll(/"slug":"[^"]+"/g));
  return matches.map((match, index) => {
    const start = match.index ?? 0;
    const end = matches[index + 1]?.index ?? source.length;
    return source.slice(start, end);
  });
}

function extractBalancedObject(source: string, slugIndex: number): string | null {
  let start = slugIndex;
  let depth = 0;
  let foundStart = false;
  for (let i = slugIndex; i >= 0; i -= 1) {
    const char = source[i];
    if (char === '}') depth += 1;
    if (char === '{') {
      if (depth === 0) {
        start = i;
        foundStart = true;
        break;
      }
      depth -= 1;
    }
  }
  if (!foundStart) return null;

  depth = 0;
  for (let i = start; i < source.length; i += 1) {
    const char = source[i];
    if (char === '{') depth += 1;
    if (char === '}') {
      depth -= 1;
      if (depth === 0) return source.slice(start, i + 1);
    }
  }
  return null;
}

function parseDsdbRouteFragment(fragment: string): DsdbRoute | null {
  const readField = (field: string): string | undefined => fragment.match(new RegExp(`"${field}":"([^"]+)"`))?.[1];
  const slug = readField('slug');
  if (!slug) return null;

  const route: DsdbRoute = {
    slug,
    documentId: readField('documentId'),
    collectionId: readField('collectionId'),
    collectionName: readField('collectionName'),
    exportedCarbonFileId: readField('exportedCarbonFileId'),
    pageCanonId: readField('pageCanonId') ?? readField('pageCanonicalId')
  };

  const warnings: string[] = [];
  if (!route.documentId && !route.pageCanonId && !route.exportedCarbonFileId) warnings.push('missing-document-identifiers');
  if (!route.collectionId && !route.collectionName) warnings.push('missing-collection-metadata');
  if (!route.exportedCarbonFileId) warnings.push('missing-exported-carbon-file-id');
  if (warnings.length > 0) route.metadataWarnings = warnings;
  return route;
}

function isDsdbCoveredPath(urlPath: string, dsdbSlugs: Set<string>): boolean {
  const path = urlPath.replace(/^\/+|\/+$/g, '');
  if (dsdbSlugs.has(path)) return true;
  const lastSlash = path.lastIndexOf('/');
  return lastSlash > 0 && dsdbSlugs.has(path.slice(0, lastSlash));
}

function publicDocPathFromPagePath(pagePath: string): string {
  const trimmed = `/${pagePath.replace(/\.md$/, '').replace(/^\/+/, '')}`;
  return trimmed === '/index' ? '/' : trimmed.replace(/\/+/g, '/');
}

function publicDocPathFromUrl(url: string, baseUrl: string): string | null {
  return normalizeMaterialPublicDocPath(url, baseUrl);
}

function hasSignificantCoverageGap(discoveredCount: number, acceptedCount: number): boolean {
  if (discoveredCount <= 0 || acceptedCount >= discoveredCount) return false;
  const missing = discoveredCount - acceptedCount;
  return missing >= Math.max(COVERAGE_WARNING_GAP_MIN, Math.ceil(discoveredCount * COVERAGE_WARNING_GAP_RATIO));
}

function shouldAttemptBrowserCoverageCheck(previousIndex: MaterialIndex | null, discoveredCount: number, acceptedCount: number): boolean {
  if (!previousIndex) return true;
  if (hasSignificantCoverageGap(discoveredCount, acceptedCount)) return true;
  const previousDiscovered = previousIndex.coverageDiagnostics?.discoveredPublicUrlCount ?? previousIndex.pageCount;
  return discoveredCount > 0 && discoveredCount < Math.floor(previousDiscovered * COVERAGE_REGRESSION_RATIO);
}

function createEmptyCoverageDiagnostics(): CoverageDiagnostics {
  return {
    discoveredPublicUrlCount: 0,
    sitemapUrlCount: 0,
    renderedNavUrlCount: 0,
    angularRouteHintCount: 0,
    previousCacheRouteHintCount: 0,
    acceptedPageCount: 0,
    uncrawledDiscoveredUrlCount: 0,
    uncrawledDiscoveredUrls: [],
    skippedBecauseMaxPagesCount: 0,
    skippedBecauseJsonCoveredCount: 0,
    skippedByPolicyCount: 0,
    skippedBlogCount: 0,
    skippedByPolicyUrls: [],
    includeBlog: false,
    crawlPriorityPolicyVersion: CRAWL_PRIORITY_POLICY_VERSION,
    coverageVerified: false,
    coverageWarnings: [],
    coverageHealth: 'unverified',
    isLimitedRun: false,
    maxPagesExplicit: false,
    skippedNotSelectedCount: 0
  };
}


export async function crawlMaterialDocs(options: CrawlOptions = {}): Promise<MaterialIndex> {
  const targetCacheDir = options.cacheDir ?? getDefaultCacheDir();
  const startedAt = new Date().toISOString();
  const logger = new UpdateLogger({
    cacheDir: targetCacheDir,
    logDir: options.logDir ?? logsDir(targetCacheDir),
    diagnosticsDir: diagnosticsDir(targetCacheDir),
    verbose: options.verbose ?? false
  });
  await logger.init();
  options.onLoggerReady?.(logger.logFile, logger.diagnosticsFile);
  logger.log('info', 'update:start', {
    phase: 'init',
    message: 'Material 3 docs cache refresh starting',
    maxPages: options.maxPages,
    concurrency: options.concurrency,
    includeBlog: options.includeBlog ?? false,
    force: options.force ?? false,
    logFile: logger.logFile,
    diagnosticsFile: logger.diagnosticsFile
  });

  const previousIndex = await readIndex(targetCacheDir);
  const stagingCacheDir = await createStagingCacheDir(targetCacheDir);
  let crawledIndex: MaterialIndex | null = null;
  let crawledDsdbState: DsdbDiscoveryState | null = null;
  let promotionDecision: 'promoted' | 'rejected' | 'error' | 'pending' = 'pending';
  let lastProgress: CrawlProgress | null = null;
  const originalOnProgress = options.onProgress;

  let lastProgressLogMs = 0;
  const PROGRESS_LOG_THROTTLE_MS = 5_000;

  const trackingOptions: CrawlOptions = {
    ...options,
    onProgress: (p) => {
      lastProgress = p;
      originalOnProgress?.(p);
      const nowMs = Date.now();
      if (nowMs - lastProgressLogMs >= PROGRESS_LOG_THROTTLE_MS) {
        lastProgressLogMs = nowMs;
        logger.log('info', 'update:progress', {
          phase: p.phase,
          elapsedMs: p.elapsedMs,
          estimatedRemainingMs: p.estimatedRemainingMs,
          ratePagesPerSecond: p.ratePagesPerSecond,
          savedPageCount: p.savedPageCount,
          failedPageCount: p.failedPageCount,
          attemptedPageCount: p.attemptedPageCount,
          directJsonAttemptedPageCount: p.directJsonAttemptedPageCount,
          browserAttemptedPageCount: p.browserAttemptedPageCount,
          queuedPageCount: p.queuedPageCount,
          activeWorkerCount: p.activeWorkerCount,
          concurrency: p.concurrency,
          currentUrls: p.currentUrls,
          targetPageCount: p.targetPageCount
        });
      }
    }
  };

  const emitFinalProgressSnapshot = (): void => {
    if (lastProgress) {
      logger.log('info', 'update:progress', {
        phase: lastProgress.phase,
        elapsedMs: lastProgress.elapsedMs,
        estimatedRemainingMs: lastProgress.estimatedRemainingMs,
        ratePagesPerSecond: lastProgress.ratePagesPerSecond,
        savedPageCount: lastProgress.savedPageCount,
        failedPageCount: lastProgress.failedPageCount,
        attemptedPageCount: lastProgress.attemptedPageCount,
        directJsonAttemptedPageCount: lastProgress.directJsonAttemptedPageCount,
        browserAttemptedPageCount: lastProgress.browserAttemptedPageCount,
        queuedPageCount: lastProgress.queuedPageCount,
        activeWorkerCount: lastProgress.activeWorkerCount,
        concurrency: lastProgress.concurrency,
        currentUrls: lastProgress.currentUrls,
        targetPageCount: lastProgress.targetPageCount,
        final: true
      });
    }
  };

  try {
    const crawlResult = await crawlIntoCache(stagingCacheDir, trackingOptions, previousIndex, targetCacheDir, logger);
    crawledIndex = crawlResult.index;
    crawledDsdbState = crawlResult.dsdbState;
    assertValidIndex(crawledIndex, options.minPageCount ?? DEFAULT_MIN_PAGE_COUNT);
    assertSafeCachePromotion(crawledIndex, previousIndex, { force: options.force });
    logger.log('info', 'update:promoting', {
      phase: 'promoting',
      message: 'Promoting staging cache to production',
      savedPages: crawledIndex.pageCount,
      failedPages: crawledIndex.failedPageCount
    });
    // Flush pending log writes, then move logs and diagnostics into the staging dir
    // before promotion. promoteStagingCache deletes .previous after swapping, so any
    // files still in targetCacheDir at promotion time are lost. By moving them into
    // staging first, they become part of the new targetCacheDir after the rename.
    await logger.flush();
    await rename(logsDir(targetCacheDir), logsDir(stagingCacheDir)).catch(() => undefined);
    await rename(diagnosticsDir(targetCacheDir), diagnosticsDir(stagingCacheDir)).catch(() => undefined);
    await promoteStagingCache(stagingCacheDir, targetCacheDir);
    promotionDecision = 'promoted';
    const diag = crawledIndex.extractionDiagnostics;
    emitRouteEvents(logger, crawledIndex);
    emitFinalProgressSnapshot();
    logger.log('info', 'update:complete', {
      phase: 'promoting',
      message: `Cache promoted: ${crawledIndex.pageCount} pages saved, ${crawledIndex.failedPageCount} failed`,
      savedPages: crawledIndex.pageCount,
      failedPages: crawledIndex.failedPageCount,
      attemptedPages: crawledIndex.attemptedPageCount,
      coverageHealth: crawledIndex.coverageDiagnostics?.coverageHealth ?? null,
      logFile: logger.logFile,
      diagnosticsFile: logger.diagnosticsFile,
      tokenTablesRequested: diag?.tokenTablesRequested ?? 0,
      tokenTablesResolved: diag?.tokenTablesResolved ?? 0,
      tokenTablesDecoded: diag?.tokenTablesDecoded ?? 0,
      tokenTablesRendered: diag?.tokenTablesSuccessfullyRendered ?? 0,
      tokenTablesRenderedAsPlaceholder: diag?.tokenTablesRenderedAsPlaceholder ?? 0
    });
    await logger.writeFinalDiagnostics(buildRunDiagnostics({
      logger, startedAt, targetCacheDir, stagingDir: stagingCacheDir,
      crawledIndex, previousIndex, promotionDecision, preservedFailedStagingPath: null,
      lastProgress, concurrency: trackingOptions.concurrency ?? 1, dsdbState: crawledDsdbState
    }));
    return crawledIndex;
  } catch (error) {
    promotionDecision = promotionDecision === 'pending' ? 'rejected' : 'error';
    const failedStagingDir = `${targetCacheDir}.failed-staging`;
    let preservedPath: string | null = null;
    try {
      await rm(failedStagingDir, { recursive: true, force: true });
      await rename(stagingCacheDir, failedStagingDir);
      preservedPath = failedStagingDir;
    } catch {
      await rm(stagingCacheDir, { recursive: true, force: true });
    }
    if (crawledIndex) emitRouteEvents(logger, crawledIndex);
    // Capture phase before emitFinalProgressSnapshot (which also closes over lastProgress).
    const failurePhase = (lastProgress as CrawlProgress | null)?.phase ?? 'unknown';
    emitFinalProgressSnapshot();
    logger.log('error', 'update:failed', {
      phase: failurePhase,
      message: error instanceof Error ? error.message : String(error),
      errorName: error instanceof Error ? error.name : undefined,
      promotionDecision,
      preservedFailedStagingPath: preservedPath,
      hasPreviousCache: previousIndex !== null,
      logFile: logger.logFile,
      diagnosticsFile: logger.diagnosticsFile
    });
    await logger.writeFinalDiagnostics(buildRunDiagnostics({
      logger, startedAt, targetCacheDir, stagingDir: stagingCacheDir,
      crawledIndex, previousIndex, promotionDecision, preservedFailedStagingPath: preservedPath,
      lastProgress, concurrency: trackingOptions.concurrency ?? 1, dsdbState: crawledDsdbState
    }));
    throw buildPromotionFailureError(error, crawledIndex, previousIndex, preservedPath, logger.logFile, logger.diagnosticsFile, lastProgress);
  }
}

function emitRouteEvents(logger: UpdateLogger, index: MaterialIndex): void {
  const routeDiagnostics = index.extractionDiagnostics?.routeDiagnostics ?? [];
  for (const route of routeDiagnostics) {
    const hasTokenActivity = (route.tokenTablesRequested ?? route.tokenTables) > 0;
    const hasStatusActivity = (route.statusTablesRequested ?? 0) > 0;
    const hasFailed = route.sourceUsed === 'failed';
    if (!hasTokenActivity && !hasStatusActivity && !hasFailed) continue;
    logger.log('info', 'update:route:diagnostics', {
      phase: 'extraction',
      route: route.url,
      path: route.path,
      source: route.sourceUsed,
      fallbackReasons: route.fallbackReasons ?? [],
      tokenTablesRequested: route.tokenTablesRequested ?? route.tokenTables,
      tokenTablesResolved: route.tokenTablesResolved ?? 0,
      tokenTablesDecoded: route.tokenTablesDecoded ?? 0,
      tokenTablesRendered: route.tokenTablesRendered,
      tokenTablesRenderedAsPlaceholder: route.tokenTablesRenderedAsPlaceholder ?? 0,
      tokenTablesUnsupportedSchema: route.tokenTablesUnsupportedSchema ?? 0,
      statusTablesRequested: route.statusTablesRequested ?? 0,
      statusTablesResolved: route.statusTablesResolved ?? 0,
      statusTablesDecoded: route.statusTablesDecoded ?? 0,
      statusTablesRendered: route.statusTablesRendered ?? 0,
      statusTablesRenderedAsPlaceholder: route.statusTablesRenderedAsPlaceholder ?? 0,
      resourceChunksRequested: route.resourceChunksRequested ?? 0,
      resourceChunksRendered: route.resourceChunksRendered ?? 0,
      resourceChunksPlaceholder: route.resourceChunksPlaceholder ?? 0,
      missingRequestedTokenSets: route.missingRequestedTokenSets
    });
  }
}

function buildRunDiagnostics({
  logger, startedAt, targetCacheDir, stagingDir, crawledIndex, previousIndex, promotionDecision, preservedFailedStagingPath, lastProgress, concurrency, dsdbState
}: {
  logger: UpdateLogger;
  startedAt: string;
  targetCacheDir: string;
  stagingDir: string | null;
  crawledIndex: MaterialIndex | null;
  previousIndex: MaterialIndex | null;
  promotionDecision: 'promoted' | 'rejected' | 'error' | 'pending';
  preservedFailedStagingPath: string | null;
  lastProgress: CrawlProgress | null;
  concurrency: number;
  dsdbState: DsdbDiscoveryState | null;
}) {
  const diag = crawledIndex?.extractionDiagnostics;
  const covDiag = crawledIndex?.coverageDiagnostics;
  const finishedAt = new Date().toISOString();
  const elapsedMs = Date.parse(finishedAt) - Date.parse(startedAt);
  return {
    runId: logger.runId,
    startedAt,
    finishedAt,
    elapsedMs,
    cacheDir: targetCacheDir,
    stagingDir,
    logFile: logger.logFile,
    attemptedPages: crawledIndex?.attemptedPageCount ?? 0,
    savedPages: crawledIndex?.pageCount ?? 0,
    failedPages: crawledIndex?.failedPageCount ?? 0,
    failedRoutes: crawledIndex?.failedUrls ?? [],
    skippedBlogCount: covDiag?.skippedBlogCount ?? 0,
    tokenTablesRequested: diag?.tokenTablesRequested ?? 0,
    tokenTablesResolved: diag?.tokenTablesResolved ?? 0,
    tokenTablesDecoded: diag?.tokenTablesDecoded ?? 0,
    tokenTablesRendered: diag?.tokenTablesSuccessfullyRendered ?? 0,
    tokenTablesRenderedAsPlaceholder: diag?.tokenTablesRenderedAsPlaceholder ?? 0,
    tokenTablesUnsupportedSchema: diag?.tokenTablesUnsupportedSchema ?? 0,
    statusTablesRequested: diag?.statusTablesRequested ?? 0,
    statusTablesResolved: diag?.statusTablesResolved ?? 0,
    statusTablesDecoded: diag?.statusTablesDecoded ?? 0,
    statusTablesRendered: diag?.statusTablesRendered ?? 0,
    statusTablesRenderedAsPlaceholder: diag?.statusTablesRenderedAsPlaceholder ?? 0,
    statusTablesUnsupportedSchema: diag?.unsupportedStatusTableSchemaCount ?? 0,
    resourceChunksRequested: diag?.resourceChunksRequested ?? 0,
    resourceChunksResolved: diag?.resourceChunksResolved ?? 0,
    resourceChunksDecoded: diag?.resourceChunksDecoded ?? 0,
    resourceChunksRendered: diag?.resourceChunksRendered ?? 0,
    resourceChunksPlaceholder: diag?.resourceChunksPlaceholder ?? 0,
    promotionDecision,
    hasPreviousCache: previousIndex !== null,
    preservedFailedStagingPath,
    coverageHealth: covDiag?.coverageHealth ?? null,
    lastPhase: lastProgress?.phase ?? null,
    concurrency,
    lastRatePagesPerSecond: lastProgress?.ratePagesPerSecond ?? null,
    lastEstimatedRemainingMs: lastProgress?.estimatedRemainingMs ?? null,
    lastActiveWorkerCount: lastProgress?.activeWorkerCount ?? null,
    lastQueuedPageCount: lastProgress?.queuedPageCount ?? null,
    directJsonAttemptedPageCount: lastProgress?.directJsonAttemptedPageCount ?? null,
    browserAttemptedPageCount: lastProgress?.browserAttemptedPageCount ?? null,
    lastCurrentUrls: lastProgress?.currentUrls ?? null,
    latestProgress: lastProgress ? {
      phase: lastProgress.phase,
      elapsedMs: lastProgress.elapsedMs,
      estimatedRemainingMs: lastProgress.estimatedRemainingMs,
      ratePagesPerSecond: lastProgress.ratePagesPerSecond,
      savedPageCount: lastProgress.savedPageCount,
      failedPageCount: lastProgress.failedPageCount,
      attemptedPageCount: lastProgress.attemptedPageCount,
      directJsonAttemptedPageCount: lastProgress.directJsonAttemptedPageCount,
      browserAttemptedPageCount: lastProgress.browserAttemptedPageCount,
      queuedPageCount: lastProgress.queuedPageCount,
      activeWorkerCount: lastProgress.activeWorkerCount,
      concurrency: lastProgress.concurrency,
      currentUrls: lastProgress.currentUrls,
      targetPageCount: lastProgress.targetPageCount
    } : null,
    dsdbConfigSource: dsdbState?.dsdbConfigSource ?? null,
    directJsonEnabled: dsdbState?.directJsonEnabled ?? null,
    browserOnlyFallback: dsdbState ? (!dsdbState.directJsonEnabled && dsdbState.bundleDiscoveryFailed) : null,
    directJsonDisabledReason: dsdbState?.directJsonDisabledReason ?? null,
    siteMetaFetched: dsdbState?.siteMetaFetched ?? null,
    siteMetaFailed: dsdbState?.siteMetaFailed ?? null,
    bundleDiscoveryFailed: dsdbState?.bundleDiscoveryFailed ?? null,
    networkRecoveryAttempted: dsdbState?.networkRecoveryAttempted ?? null,
    networkRecoverySucceeded: dsdbState?.networkRecoverySucceeded ?? null,
    networkRecoveryFailureReason: dsdbState?.networkRecoveryFailureReason ?? null
  };
}

function buildPromotionFailureError(
  originalError: unknown,
  index: MaterialIndex | null,
  previousIndex: MaterialIndex | null,
  preservedStagingPath: string | null,
  logFile?: string,
  diagnosticsFile?: string,
  lastProgress?: CrawlProgress | null
): Error {
  const base = originalError instanceof Error ? originalError.message : String(originalError);
  const hasPreviousCache = previousIndex !== null;
  const cacheStatus = hasPreviousCache
    ? 'The previous cache has been left unchanged.'
    : 'No previous cache exists; no cache is available.';

  let progressContext = '';
  if (lastProgress) {
    const elapsed = formatDurationMs(lastProgress.elapsedMs);
    const etaStr = lastProgress.estimatedRemainingMs !== null
      ? `eta=${formatDurationMs(lastProgress.estimatedRemainingMs)}`
      : 'eta=unknown';
    progressContext = `\nFailed at: phase=${lastProgress.phase} elapsed=${elapsed} ${etaStr} active=${lastProgress.activeWorkerCount} queued=${lastProgress.queuedPageCount}`;
  }

  let diagnostics = '';
  if (index !== null) {
    const failed = index.failedPageCount;
    const attempted = index.attemptedPageCount;
    const saved = index.pageCount;
    const failedPct = attempted > 0 ? ((failed / attempted) * 100).toFixed(1) : '0.0';
    const allowedPct = (DEFAULT_MAX_FAILED_PAGE_RATIO * 100).toFixed(0);
    const failedRoutes = index.failedUrls ?? [];
    const coreSpecsFailures = failedRoutes.filter((u) => u.includes('/specs')).length;
    const cacheKept = previousIndex !== null ? 'yes (previous cache unchanged)' : 'no (no previous cache existed)';

    const parts: string[] = [
      `Attempted: ${attempted} | Saved: ${saved} | Failed: ${failed} (${failedPct}%) | Allowed failure rate: ${allowedPct}%`,
      `Existing cache kept: ${cacheKept}`,
    ];
    if (coreSpecsFailures > 0) parts.push(`Core specs failures (*/specs routes): ${coreSpecsFailures}`);
    if (failedRoutes.length > 0 && failedRoutes.length <= 20) {
      parts.push(`Failed routes:\n  ${failedRoutes.join('\n  ')}`);
    } else if (failedRoutes.length > 20) {
      parts.push(`Failed routes (first 20 of ${failedRoutes.length}):\n  ${failedRoutes.slice(0, 20).join('\n  ')}`);
    }
    diagnostics = `\n${parts.join('\n')}`;
  }

  const stagingNote = preservedStagingPath
    ? `\nFailed staging output preserved at: ${preservedStagingPath}`
    : '';

  const logNote = logFile ? `\nUpdate log: ${logFile}` : '';
  const diagNote = diagnosticsFile ? `\nDiagnostics: ${diagnosticsFile}` : '';

  // Strip the generic "Keeping the existing cache." so we can append the correct message.
  const cleanedBase = base.replace(/\s*Keeping the existing cache\.\s*$/, '').trim();
  return new Error(`${cleanedBase}\n${cacheStatus}${progressContext}${diagnostics}${stagingNote}${logNote}${diagNote}`);
}

type DsdbDiscoveryState = {
  dsdbConfigSource: 'site-meta' | 'bundle' | 'browser-network' | null;
  directJsonEnabled: boolean;
  directJsonDisabledReason: string | null;
  siteMetaFetched: boolean;
  siteMetaFailed: boolean;
  bundleDiscoveryFailed: boolean;
  networkRecoveryAttempted: boolean;
  networkRecoverySucceeded: boolean;
  networkRecoveryFailureReason: string | null;
};

async function crawlIntoCache(cacheDir: string, options: CrawlOptions, previousIndex: MaterialIndex | null = null, previousCacheDir = cacheDir, logger?: UpdateLogger): Promise<{ index: MaterialIndex; dsdbState: DsdbDiscoveryState }> {
  const baseUrl = options.baseUrl ?? DEFAULT_BASE_URL;
  // No --max-pages means a full refresh: no source-route truncation. Number.MAX_SAFE_INTEGER (not
  // Infinity) keeps maxPages JSON-serializable in progress/diagnostics output.
  const maxPagesExplicit = options.maxPagesExplicit === true;
  const maxPages = options.maxPages ?? Number.MAX_SAFE_INTEGER;
  const concurrency = Math.min(options.concurrency ?? DEFAULT_CRAWL_CONCURRENCY, maxPages);
  const signal = options.signal;
  const includeBlog = options.includeBlog ?? false;
  const startedAt = new Date().toISOString();
  const currentUrls = new Map<number, string>();
  const directJsonActiveUrls = new Set<string>();
  let lastSavedUrl: string | null = null;
  let lastFailedUrl: string | null = null;
  let crawlPhase: CrawlPhase = 'fetch-shell';
  let knownTargetPageCount: number | null = null;
  throwIfAborted(signal);

  // DSDB discovery lifecycle state
  let dsdbConfigSource: 'site-meta' | 'bundle' | 'browser-network' | null = null;
  let directJsonEnabled = false;
  let directJsonDisabledReason: string | null = null;
  let siteMetaFetched = false;
  let siteMetaFailed = false;
  let bundleDiscoveryFailed = false;
  let networkRecoveryAttempted = false;
  let networkRecoverySucceeded = false;
  let networkRecoveryFailureReason: string | null = null;

  const reusableBlogPages = buildReusableBlogPageMap(previousIndex);
  const blogPostYears = new Map<string, number>();

  // Declared here so the nested worker() function can close over it
  let browserContext: BrowserContext | undefined;

  const extractionDiagnostics = createEmptyExtractionDiagnostics();
  const coverageDiagnostics = createEmptyCoverageDiagnostics();
  const queue: string[] = [];
  const queued = new Set<string>();
  const seen = new Set<string>();
  const writtenPaths = new Set<string>();
  const pages: MaterialPage[] = [];
  const failedUrls: string[] = [];
  const suspiciousPages: SuspiciousCrawlPage[] = [];
  const jsonFallbackRoutes = new Map<string, ExtractionFallbackReason>();
  const routeDiagnosticsByPath = new Map<string, ExtractionRouteDiagnostic>();
  const discoveredPublicDocPaths = new Set<string>();
  const sitemapPublicDocPaths = new Set<string>();
  const renderedNavPublicDocPaths = new Set<string>();
  const angularRoutePublicDocPaths = new Set<string>();
  const previousCacheRoutePublicDocPaths = new Set<string>();
  const acceptedPublicDocPaths = new Set<string>();
  const policySkippedDocPaths = new Set<string>();
  const waiters: Array<() => void> = [];
  let activeWorkers = 0;
  let aborted = false;
  let dsdbAttemptedCount = 0;
  let sourcePagesSelectedCount = 0;
  let skippedNotSelectedCount = 0;
  let truncatedByMaxPages = false;
  const minAcceptedPageCount = options.minPageCount ?? DEFAULT_MIN_PAGE_COUNT;
  const verbose = options.verbose ?? false;
  const logError = (msg: string): void => { options.onBeforeLog?.(); console.error(msg); };
  const logVerbose = (msg: string): void => { if (verbose) { options.onBeforeLog?.(); console.error(msg); } };

  const emitProgress = (running: boolean, error: string | null = null): void => {
    const nowMs = Date.now();
    const startMs = Date.parse(startedAt);
    const elapsedMs = Math.max(0, nowMs - startMs);
    const processedPageCount = pages.length + failedUrls.length;
    const eta = knownTargetPageCount !== null
      ? computeEta(processedPageCount, knownTargetPageCount, elapsedMs)
      : null;
    const completedAt = running ? null : new Date().toISOString();
    const isDirectJsonPhase = crawlPhase === 'fetch-page-data' || crawlPhase === 'direct-json';
    const activeCount = isDirectJsonPhase ? directJsonActiveUrls.size : activeWorkers;
    const activeUrlsList = isDirectJsonPhase
      ? Array.from(directJsonActiveUrls).sort()
      : Array.from(currentUrls.values()).sort();
    const progress: CrawlProgress = {
      phase: running ? crawlPhase : (error ? crawlPhase : 'complete'),
      startedAt,
      updatedAt: new Date().toISOString(),
      completedAt,
      running,
      maxPages,
      concurrency,
      elapsedMs,
      processedPageCount,
      targetPageCount: knownTargetPageCount,
      attemptedPageCount: dsdbAttemptedCount + seen.size,
      directJsonAttemptedPageCount: dsdbAttemptedCount,
      browserAttemptedPageCount: seen.size,
      savedPageCount: pages.length,
      failedPageCount: failedUrls.length,
      queuedPageCount: queue.length,
      activeWorkerCount: activeCount,
      ratePagesPerSecond: eta?.ratePagesPerSecond ?? null,
      estimatedRemainingMs: eta?.estimatedRemainingMs ?? null,
      currentUrls: activeUrlsList,
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
  const routeSlugFromPath = (pagePath: string): string => pagePath.replace(/\/overview\.md$/, '').replace(/\.md$/, '');
  const addDiscoveredPaths = (paths: Iterable<string>, bucket?: Set<string>): void => {
    for (const docPath of paths) {
      const normalized = docPath === '/' ? '/' : `/${docPath.replace(/^\/+/, '').replace(/\/$/, '')}`;
      discoveredPublicDocPaths.add(normalized);
      bucket?.add(normalized);
    }
  };
  const markAcceptedPage = (pagePath: string): void => {
    acceptedPublicDocPaths.add(publicDocPathFromPagePath(pagePath));
  };

  if (previousIndex) {
    addDiscoveredPaths(previousIndex.pages.map((page) => publicDocPathFromPagePath(page.path)), previousCacheRoutePublicDocPaths);
  }

  const createRouteDiagnostic = ({
    url,
    path,
    sourceUsed,
    finalMethod,
    directJsonAttempted = false,
    directJsonSucceeded = false,
    networkJsonAttempted = false,
    networkJsonSucceeded = false,
    domFallbackAttempted = false,
    domFallbackSucceeded = false,
    fallbackReasons = [],
    fallbackSkippedReasons = [],
    unknownChunkTypes = [],
    unknownResourceTypes = [],
    tokenTables = 0,
    tokenTablesRendered = 0,
    tokenTablesRequested = tokenTables,
    tokenContextDiagnostics = [],
    statusTablesRequested = 0,
    statusTablesResolved = 0,
    statusTablesRenderedAsPlaceholder = 0,
    unsupportedStatusTableSchemaCount = 0,
    statusTableDiagnostics = [],
    // No default: undefined means "not tracked at this call site" (distinct from "tracked as 0"),
    // see tokenTablesRenderedFromInline.
    tokenTablesResolved,
    tokenTablesDecoded,
    tokenTablesRenderedFromInline = 0,
    tokenTablesRenderedAsPlaceholder = 0,
    tokenTablesUnsupportedSchema = 0,
    statusTablesDecoded = 0,
    resourceChunksRequested = 0,
    resourceChunksResolved = 0,
    resourceChunksDecoded = 0,
    resourceChunksRendered = 0,
    resourceChunksPlaceholder = 0,
    missingRequestedTokenSets = [],
    unknownJsonResourceCount = 0,
    capturedJsonResponseCounts = {},
    rawJsonDebugFilesWritten = 0,
    routeMetadataWarnings = [],
    candidateSelectionReasons = [],
    navigationSource,
    pageReferenceSource,
    contentSource,
    virtualSource,
    sourceRoute,
    virtualRoute,
    tabName,
    tabSlug,
    pageDataFetchedOnce,
    pageDataUrl,
    pageDataStatus,
    carbonUrl,
    carbonStatus,
    selectedBecause,
    skippedReason
  }: {
    url: string;
    path: string;
    sourceUsed: ExtractionSource;
    skippedReason?: ExtractionRouteDiagnostic['skippedReason'];
    finalMethod: ExtractionRouteDiagnostic['finalMethod'];
    directJsonAttempted?: boolean;
    directJsonSucceeded?: boolean;
    networkJsonAttempted?: boolean;
    networkJsonSucceeded?: boolean;
    domFallbackAttempted?: boolean;
    domFallbackSucceeded?: boolean;
    fallbackReasons?: ExtractionFallbackReason[];
    fallbackSkippedReasons?: ExtractionFallbackReason[];
    unknownChunkTypes?: string[];
    unknownResourceTypes?: string[];
    tokenTables?: number;
    tokenTablesRendered?: number;
    tokenTablesRequested?: number;
    tokenTablesResolved?: number;
    tokenTablesDecoded?: number;
    tokenTablesRenderedFromInline?: number;
    tokenTablesRenderedAsPlaceholder?: number;
    tokenTablesUnsupportedSchema?: number;
    tokenContextDiagnostics?: ExtractionRouteDiagnostic['tokenContextDiagnostics'];
    statusTablesRequested?: number;
    statusTablesResolved?: number;
    statusTablesDecoded?: number;
    statusTablesRenderedAsPlaceholder?: number;
    unsupportedStatusTableSchemaCount?: number;
    statusTableDiagnostics?: ExtractionRouteDiagnostic['statusTableDiagnostics'];
    resourceChunksRequested?: number;
    resourceChunksResolved?: number;
    resourceChunksDecoded?: number;
    resourceChunksRendered?: number;
    resourceChunksPlaceholder?: number;
    missingRequestedTokenSets?: string[];
    unknownJsonResourceCount?: number;
    capturedJsonResponseCounts?: Partial<Record<JsonResponseType, number>>;
    rawJsonDebugFilesWritten?: number;
    routeMetadataWarnings?: string[];
    candidateSelectionReasons?: string[];
    navigationSource?: ExtractionRouteDiagnostic['navigationSource'];
    pageReferenceSource?: ExtractionRouteDiagnostic['pageReferenceSource'];
    contentSource?: ExtractionRouteDiagnostic['contentSource'];
    virtualSource?: ExtractionRouteDiagnostic['virtualSource'];
    sourceRoute?: string;
    virtualRoute?: string;
    tabName?: string;
    tabSlug?: string;
    pageDataFetchedOnce?: boolean;
    pageDataUrl?: string;
    pageDataStatus?: number | string;
    carbonUrl?: string;
    carbonStatus?: number | string;
    selectedBecause?: ExtractionRouteDiagnostic['selectedBecause'];
  }): ExtractionRouteDiagnostic => ({
    url,
    path,
    sourceUsed,
    ...(skippedReason ? { skippedReason } : {}),
    finalMethod,
    jsonAttempted: directJsonAttempted || networkJsonAttempted,
    jsonSucceeded: directJsonSucceeded || networkJsonSucceeded,
    ...(fallbackReasons[0] ? { fallbackReason: fallbackReasons[0] } : {}),
    ...(fallbackReasons.length > 0 ? { fallbackReasons } : {}),
    ...(fallbackSkippedReasons.length > 0 ? { fallbackSkippedReasons } : {}),
    browserFallbackAttempted: domFallbackAttempted,
    browserFallbackSucceeded: domFallbackSucceeded,
    directJsonAttempted,
    directJsonSucceeded,
    networkJsonAttempted,
    networkJsonSucceeded,
    domFallbackAttempted,
    domFallbackSucceeded,
    unknownChunkTypes,
    unknownResourceTypes,
    tokenTables,
    tokenTablesRendered,
    tokenTablesRequested,
    ...(tokenTablesResolved !== undefined ? { tokenTablesResolved } : {}),
    ...(tokenTablesDecoded !== undefined ? { tokenTablesDecoded } : {}),
    tokenTablesRenderedFromInline,
    tokenTablesRenderedAsPlaceholder,
    tokenTablesUnsupportedSchema,
    tokenContextDiagnostics,
    statusTablesRequested,
    statusTablesResolved,
    statusTablesDecoded,
    statusTablesRenderedAsPlaceholder,
    unsupportedStatusTableSchemaCount,
    statusTableDiagnostics,
    resourceChunksRequested,
    resourceChunksResolved,
    resourceChunksDecoded,
    resourceChunksRendered,
    resourceChunksPlaceholder,
    missingRequestedTokenSets,
    unknownJsonResourceCount,
    capturedJsonResponseCounts,
    rawJsonDebugFilesWritten,
    ...(routeMetadataWarnings.length > 0 ? { routeMetadataWarnings } : {}),
    ...(candidateSelectionReasons.length > 0 ? { candidateSelectionReasons } : {}),
    ...(navigationSource ? { navigationSource } : {}),
    ...(pageReferenceSource ? { pageReferenceSource } : {}),
    ...(contentSource ? { contentSource } : {}),
    ...(virtualSource !== undefined ? { virtualSource } : {}),
    ...(sourceRoute ? { sourceRoute } : {}),
    ...(virtualRoute ? { virtualRoute } : {}),
    ...(tabName ? { tabName } : {}),
    ...(tabSlug ? { tabSlug } : {}),
    ...(pageDataFetchedOnce !== undefined ? { pageDataFetchedOnce } : {}),
    ...(pageDataUrl ? { pageDataUrl } : {}),
    ...(pageDataStatus !== undefined ? { pageDataStatus } : {}),
    ...(carbonUrl ? { carbonUrl } : {}),
    ...(carbonStatus !== undefined ? { carbonStatus } : {}),
    ...(selectedBecause ? { selectedBecause } : {})
  });

  // ── Phase 1: fetch-shell + fetch-site-meta + enumerate-routes + fetch-page-data ──
  emitProgress(true);
  const jsonExtractedSlugs = new Set<string>();
  {
    // fetch-shell: fetch the HTML landing page for link discovery
    crawlPhase = 'fetch-shell';
    emitProgress(true);
    if (typeof fetch === 'function') {
      try {
        const shellResponse = await fetch(baseUrl, { signal });
        if (shellResponse.ok) addDiscoveredPaths(discoverPublicDocPathsFromHtml(await shellResponse.text(), baseUrl), renderedNavPublicDocPaths);
      } catch (err) {
        if (signal?.aborted) throw err;
      }
    }

    addDiscoveredPaths(await discoverSitemapDocPaths(baseUrl), sitemapPublicDocPaths);

    // fetch-site-meta: primary route source. site_meta.routes drives the route LIST (public/
    // private/redirect/blog/aliases). It does NOT carry a usable collectionId/documentId for
    // page-data (verified live: site_meta's reference fields 404 against /page-data/...). That
    // mapping — plus tabs[] for sub-routes like /components/buttons/specs — comes from the
    // isolated page-reference-resolver below, which parses the Angular bundle's route table.
    crawlPhase = 'fetch-site-meta';
    emitProgress(true);

    let normalizedSiteMetaRoutes: NormalizedRoute[] = [];

    if (typeof fetch === 'function') {
      try {
        throwIfAborted(signal);
        logger?.log('info', 'site-meta:fetch-started', { phase: 'fetch-site-meta', baseUrl });
        const siteMeta = await fetchSiteMeta(baseUrl, signal);
        siteMetaFetched = true;

        // normalize-routes
        crawlPhase = 'normalize-routes';
        emitProgress(true);

        const normalizeResult = normalizeSiteMetaRoutes(siteMeta);
        if (!normalizeResult.ok) {
          throw new SiteMetaParseError(`site_meta.js: ${normalizeResult.reason}`, { isFormatError: true });
        }
        normalizedSiteMetaRoutes = normalizeResult.routes;
        const publicRoutes = normalizedSiteMetaRoutes.filter((r) => r.public && !r.redirectExternalUrl);
        coverageDiagnostics.siteMetaRouteCount = normalizeResult.normalizedRouteCount;
        coverageDiagnostics.siteMetaPublicRouteCount = publicRoutes.length;
        coverageDiagnostics.siteMetaPrivateRouteCount = normalizedSiteMetaRoutes.filter((r) => !r.public).length;
        coverageDiagnostics.siteMetaRedirectRouteCount = normalizedSiteMetaRoutes.filter((r) => Boolean(r.redirectExternalUrl)).length;
        coverageDiagnostics.siteMetaAliasCount = normalizeResult.aliasCount;

        logger?.log('info', 'site-meta:routes-enumerated', {
          phase: 'normalize-routes',
          totalRoutes: normalizeResult.normalizedRouteCount,
          publicRoutes: publicRoutes.length,
          invalidRoutes: normalizeResult.invalidRouteCount,
          aliases: normalizeResult.aliasCount,
          deduplicatedAliases: normalizeResult.deduplicatedAliasCount
        });

        for (const route of normalizedSiteMetaRoutes) {
          addDiscoveredPaths([route.path], angularRoutePublicDocPaths);
          addDiscoveredPaths(route.aliases, angularRoutePublicDocPaths);
        }
      } catch (err) {
        if (signal?.aborted) throw err;
        const reason = err instanceof Error ? err.message : String(err);
        const isSiteMetaError = err instanceof SiteMetaParseError;
        // A SiteMetaParseError NOT raised by the fetch/HTTP step itself means site_meta.js was
        // fetched and a parse/schema attempt was made before it failed.
        const wasFetched = isSiteMetaError && !reason.startsWith('site_meta.js fetch failed');
        if (wasFetched) siteMetaFetched = true;
        siteMetaFailed = true;
        logger?.log('error', 'site-meta:fetch-failed', { phase: 'fetch-site-meta', reason, isSiteMetaError, siteMetaFetched });
        logError(`site_meta.js unusable (${reason}); the default update path requires site_meta as the route source.`);
      }
    }

    const siteMetaProvidedRoutes = normalizedSiteMetaRoutes.length > 0;
    const browserFallbackAllowed = options.allowBrowserFallback === true;

    if (!siteMetaProvidedRoutes && !browserFallbackAllowed) {
      // site_meta is the only accepted full route source for the default (deterministic) update
      // path. Never fall back to the bundle route table for whole-site route discovery there —
      // the bundle table may only resolve page references for routes already known from
      // site_meta, or supplement specific tracked subtrees. (Legacy callers that explicitly opt
      // into allowBrowserFallback keep the old degraded bundle/browser-network-recovery path.)
      siteMetaFailed = true;
      const reason = siteMetaFetched ? 'site_meta.js fetched but produced zero usable routes' : 'site_meta.js could not be fetched/parsed';
      logger?.log('error', 'site-meta:rejected', { phase: 'fetch-site-meta', reason, siteMetaFetched, siteMetaFailed });
      await logger?.writeIntermediateDiagnostics({
        promotionDecision: 'pending',
        startedAt,
        siteMetaFetched,
        siteMetaFailed: true,
        bundleDiscoveryFailed,
        directJsonEnabled: false,
        directJsonDisabledReason: reason,
        dsdbConfigSource: null,
        networkRecoveryAttempted: false,
        networkRecoverySucceeded: false
      });
      throw new Error(`site_meta.js did not provide a usable route list (${reason}); refusing to fall back to the bundle table as a full route source.`);
    }

    // page-reference-resolver: fetch the Angular bundle once for carbonVersion + the route table
    // used to resolve collectionId/documentId/exportedCarbonFileId/tabs. This is the only place
    // bundle text is parsed (isolated module), and it is never used to invent new top-level routes
    // except the documented subtree-supplement case below.
    let carbonVersion: string | null = null;
    let bundleRoutes: BundleRouteEntry[] = [];
    if (typeof fetch === 'function') {
      try {
        throwIfAborted(signal);
        logger?.log('info', 'dsdb-config:bundle-started', { phase: 'fetch-site-meta', baseUrl });
        const bundleText = await fetchAngularBundleText(baseUrl, signal);
        carbonVersion = extractCarbonVersionFromBundleText(bundleText);
        bundleRoutes = extractBundleRouteTable(bundleText);
        if (!carbonVersion) throw new Error('carbonVersion not found in Angular bundle');
        if (bundleRoutes.length === 0) throw new Error('No bundle routes found in Angular bundle');
        directJsonEnabled = true;
        if (!dsdbConfigSource) dsdbConfigSource = siteMetaProvidedRoutes ? 'site-meta' : 'bundle';
        logger?.log('info', 'dsdb-config:bundle-succeeded', {
          phase: 'fetch-site-meta',
          carbonVersion,
          routeCount: bundleRoutes.length
        });
      } catch (err) {
        if (signal?.aborted) throw err;
        const reason = err instanceof Error ? err.message : String(err);
        bundleDiscoveryFailed = true;
        directJsonEnabled = false;
        directJsonDisabledReason = reason;
        logError(`Angular bundle fetch failed${siteMetaProvidedRoutes ? ' (site_meta routes available, will recover carbonVersion via browser)' : ', will attempt browser-network recovery'}: ${reason}`);
        logger?.log('warn', 'dsdb-config:bundle-failed', { phase: 'fetch-site-meta', reason, siteMetaProvidedRoutes, networkRecoveryWillAttempt: browserFallbackAllowed });
        await logger?.writeIntermediateDiagnostics({
          promotionDecision: 'pending',
          startedAt,
          siteMetaFetched,
          siteMetaFailed,
          bundleDiscoveryFailed: true,
          directJsonEnabled: false,
          directJsonDisabledReason: reason,
          dsdbConfigSource: siteMetaProvidedRoutes ? 'site-meta' : null,
          networkRecoveryAttempted: false,
          networkRecoverySucceeded: false
        });
      }
    }

    // filter-routes + resolve page references, producing the DsdbRoute[] the existing
    // fetch-page-data batch consumes (extended with tabs/navigationSource/pageReferenceSource).
    let finalConfig: DsdbSiteConfig | null = null;
    if (carbonVersion) {
      let candidateRoutes: NormalizedRoute[];
      let uncoveredPrefixes: string[];

      if (!siteMetaProvidedRoutes) {
        // Legacy degraded mode only (allowBrowserFallback): site_meta failed entirely, so the
        // bundle route table is the only available route list. Never reachable in the default
        // update path — that path already failed fast above.
        candidateRoutes = bundleRoutes.map((entry): NormalizedRoute => {
          const path = `/${entry.slug}`;
          return {
            path,
            routeKey: path,
            aliases: entry.alternateSlugs ?? [],
            public: true,
            redirectExternalUrl: null,
            collectionId: entry.collectionId ?? null,
            documentId: entry.documentId ?? null,
            repoId: null,
            isBlog: isBlogPath(path),
            navigationSource: 'bundle-supplement',
            raw: entry
          };
        });
        uncoveredPrefixes = [];
        if (!dsdbConfigSource) dsdbConfigSource = 'bundle';
      } else {
        candidateRoutes = normalizedSiteMetaRoutes;

        // bundle-supplement: only for tracked subtrees with zero site_meta coverage.
        const siteMetaPaths = normalizedSiteMetaRoutes.map((r) => r.path);
        uncoveredPrefixes = findSubtreesWithoutCoverage(siteMetaPaths, TRACKED_BUNDLE_SUPPLEMENT_PREFIXES);
        const supplementRoutes: NormalizedRoute[] = [];
        for (const prefix of uncoveredPrefixes) {
          for (const entry of bundleRoutesUnderPrefix(bundleRoutes, prefix)) {
            const supplementPath = `/${entry.slug}`;
            supplementRoutes.push({
              path: supplementPath,
              routeKey: supplementPath,
              aliases: entry.alternateSlugs ?? [],
              public: true,
              redirectExternalUrl: null,
              collectionId: entry.collectionId ?? null,
              documentId: entry.documentId ?? null,
              repoId: null,
              isBlog: isBlogPath(supplementPath),
              navigationSource: 'bundle-supplement',
              raw: entry
            });
          }
        }
        if (supplementRoutes.length > 0) {
          logger?.log('info', 'bundle-supplement:routes-added', { phase: 'normalize-routes', prefixes: uncoveredPrefixes, count: supplementRoutes.length });
        }
        candidateRoutes = [...candidateRoutes, ...supplementRoutes];
      }
      coverageDiagnostics.bundleSupplementRouteCount = candidateRoutes.filter((r) => r.navigationSource === 'bundle-supplement').length;
      coverageDiagnostics.supplementedPrefixes = uncoveredPrefixes;

      crawlPhase = 'filter-routes';
      emitProgress(true);
      const filtered = filterRoutes(candidateRoutes, {
        includeBlog,
        maxPages,
        requiredPaths: REQUIRED_VALIDATION_PARENT_PATHS
      });
      for (const skip of filtered.skipped) {
        if (skip.reason === 'blog') policySkippedDocPaths.add(skip.path);
      }
      coverageDiagnostics.skippedBlogCount += filtered.skippedBlogCount;
      truncatedByMaxPages = filtered.truncatedByMaxPages;
      skippedNotSelectedCount = filtered.skippedNotSelectedCount;
      sourcePagesSelectedCount = filtered.selected.length;

      const resolvedRoutes: DsdbRoute[] = [];
      for (const route of filtered.selected) {
        const resolution = resolvePageReference(route.path, bundleRoutes);
        const slug = route.path.replace(/^\/+|\/+$/g, '');
        if (!slug) continue;
        if (resolution.pageReferenceSource === 'missing') {
          recordRouteDiagnostic(createRouteDiagnostic({
            url: new URL(route.path, baseUrl).toString(),
            path: routePathFromSlug(slug),
            sourceUsed: 'skipped',
            skippedReason: 'missing-page-reference',
            finalMethod: null,
            fallbackReasons: ['json-fetch-failed'],
            navigationSource: route.navigationSource,
            pageReferenceSource: 'missing',
            selectedBecause: route.selectedBecause
          }));
          continue;
        }
        resolvedRoutes.push({
          slug,
          documentId: resolution.entry.documentId,
          collectionId: resolution.entry.collectionId,
          exportedCarbonFileId: resolution.entry.exportedCarbonFileId,
          pageCanonId: undefined,
          collectionName: undefined,
          tabs: resolution.entry.tabs,
          navigationSource: route.navigationSource,
          pageReferenceSource: 'bundle-table',
          selectedBecause: route.selectedBecause
        });
      }
      finalConfig = { carbonVersion, routes: resolvedRoutes };
    } else if (siteMetaProvidedRoutes) {
      // Bundle fetch failed: site_meta routes exist, but no page-reference table is available
      // to resolve documentId/collectionId. Direct JSON cannot run; browser-network-recovery
      // (legacy fallback mode only) is the only way to obtain a carbonVersion in this case.
      if (!dsdbConfigSource) dsdbConfigSource = 'site-meta';
      directJsonEnabled = false;
      directJsonDisabledReason = directJsonDisabledReason ?? 'carbonVersion-unavailable';
      logger?.log('warn', 'direct-json:deferred', {
        phase: 'filter-routes',
        reason: 'carbonVersion-unavailable',
        siteMetaRouteCount: normalizedSiteMetaRoutes.length
      });
    }
    // else: both site_meta and the bundle failed — legacy browser-only fallback path (allowBrowserFallback only)

    // fetch-page-data: run direct JSON extraction with available config
    if (finalConfig) {
      crawlPhase = 'fetch-page-data';
      emitProgress(true);
      await runDirectJsonBatch(finalConfig);
    }
  }

  // ── Phase 2: Browser crawl for JSON misses and uncovered routes ───────────
  for (const routeDiagnostic of routeDiagnosticsByPath.values()) {
    if (routeDiagnostic.sourceUsed === 'direct-json') {
      routeDiagnostic.fallbackSkippedReasons = [...(routeDiagnostic.fallbackSkippedReasons ?? []), 'json-quality-accepted' as ExtractionFallbackReason];
    }
  }
  coverageDiagnostics.sitemapUrlCount = sitemapPublicDocPaths.size;
  coverageDiagnostics.renderedNavUrlCount = renderedNavPublicDocPaths.size;
  coverageDiagnostics.angularRouteHintCount = angularRoutePublicDocPaths.size;
  coverageDiagnostics.previousCacheRouteHintCount = previousCacheRoutePublicDocPaths.size;
  coverageDiagnostics.discoveredPublicUrlCount = discoveredPublicDocPaths.size;
  coverageDiagnostics.skippedBecauseJsonCoveredCount = Array.from(discoveredPublicDocPaths).filter((docPath) => acceptedPublicDocPaths.has(docPath)).length;

  const jsonExtractionSatisfiedMinimum = pages.length >= minAcceptedPageCount;
  const requiresBrowserFallback = jsonFallbackRoutes.size > 0;
  const requiresBrowserCoverageCheck = shouldAttemptBrowserCoverageCheck(previousIndex, discoveredPublicDocPaths.size, acceptedPublicDocPaths.size);
  // Browser-based DOM fallback and network recovery are opt-in only (options.allowBrowserFallback).
  // The default update path is deterministic direct-JSON extraction; if it cannot produce enough
  // valid pages, the update fails validation (assertValidIndex) instead of launching a browser.
  if (options.allowBrowserFallback !== true && (!jsonExtractionSatisfiedMinimum || requiresBrowserFallback || requiresBrowserCoverageCheck)) {
    coverageDiagnostics.coverageWarnings.push('coverage-unverified:browser-fallback-disabled');
  }
  if (options.allowBrowserFallback === true && pages.length < maxPages && !signal?.aborted && (!jsonExtractionSatisfiedMinimum || requiresBrowserFallback || requiresBrowserCoverageCheck)) {
    crawlPhase = 'browser-dom-fallback';
    knownTargetPageCount = maxPages;
    let browser: Browser | null = null;
    try {
      browser = await launchChromium(options.headless ?? true);
    } catch (error) {
      if (jsonExtractionSatisfiedMinimum) {
        emitProgress(true);
        const fallbackReason: ExtractionFallbackReason = 'playwright-unavailable';
        for (const routeDiagnostic of routeDiagnosticsByPath.values()) {
          routeDiagnostic.fallbackSkippedReasons = [...(routeDiagnostic.fallbackSkippedReasons ?? []), fallbackReason];
        }
        coverageDiagnostics.coverageWarnings.push('coverage-unverified:playwright-unavailable');
      } else {
        throw error;
      }
    }
    if (!browser) {
      // Direct JSON already produced an acceptable cache; keep it and record the skip.
    } else {
    browserContext = await browser.newContext({ viewport: { width: 1440, height: 1400 } });

    // ── browser-network-recovery: recover carbonVersion when bundle failed ────
    // Attempt recovery when: bundle failed AND (site_meta has no routes OR site_meta routes need carbonVersion)
    const needsCarbonVersionRecovery = bundleDiscoveryFailed && !directJsonEnabled;
    if (needsCarbonVersionRecovery && !signal?.aborted) {
      crawlPhase = 'browser-network-recovery';
      emitProgress(true);
      networkRecoveryAttempted = true;
      logger?.log('info', 'dsdb-config:network-bootstrap-started', {
        phase: 'browser-network-recovery',
        seedPaths: NETWORK_BOOTSTRAP_SEED_PATHS,
        bundleDiscoveryFailed,
        siteMetaFetched,
        hasSiteMetaRoutes: jsonExtractedSlugs.size === 0
      });
      await logger?.writeIntermediateDiagnostics({
        promotionDecision: 'pending',
        startedAt,
        siteMetaFetched,
        siteMetaFailed,
        bundleDiscoveryFailed: true,
        directJsonEnabled: false,
        directJsonDisabledReason,
        dsdbConfigSource: dsdbConfigSource ?? null,
        networkRecoveryAttempted: true,
        networkRecoverySucceeded: false
      });

      let recoveryResult: { carbonVersion: string; observedUrls: string[] } | null = null;
      try {
        recoveryResult = await bootstrapCarbonVersionFromBrowser(
          browserContext,
          baseUrl,
          NETWORK_BOOTSTRAP_SEED_PATHS,
          signal,
          logger
        );
      } catch (err) {
        if (signal?.aborted) throw err;
        networkRecoveryFailureReason = err instanceof Error ? err.message : String(err);
      }

      if (recoveryResult) {
        const recoveredVersion = recoveryResult.carbonVersion;
        // Use site_meta routes if available; otherwise fall back to slug-only routes from discovery.
        // Filter blog routes when includeBlog is false.
        const siteMetaRouteSet = Array.from(angularRoutePublicDocPaths)
          .map((p) => p.replace(/^\/+|\/+$/g, ''))
          .filter((slug) => {
            if (!slug) return false;
            if (!includeBlog && isBlogPath(`/${slug}`)) {
              policySkippedDocPaths.add(`/${slug}`);
              return false;
            }
            return true;
          });
        const recoveredRoutes = siteMetaRouteSet.length > 0
          ? siteMetaRouteSet.map((slug): DsdbRoute => ({ slug }))
          : buildSlugOnlyRoutesFromDocPaths(discoveredPublicDocPaths).filter((r) => includeBlog || !isBlogPath(`/${r.slug}`));
        const recoveredConfig: DsdbSiteConfig = { carbonVersion: recoveredVersion, routes: recoveredRoutes };
        dsdbConfigSource = 'browser-network';
        directJsonEnabled = true;
        directJsonDisabledReason = null;
        networkRecoverySucceeded = true;

        for (const url of recoveryResult.observedUrls) {
          logger?.log('debug', 'dsdb-config:network-url-observed', { url });
        }
        logger?.log('info', 'dsdb-config:network-succeeded', {
          phase: 'browser-network-recovery',
          carbonVersion: recoveredVersion,
          routeCount: recoveredRoutes.length,
          observedUrlCount: recoveryResult.observedUrls.length,
          routeSource: siteMetaRouteSet.length > 0 ? 'site-meta' : 'slug-only'
        });
        logger?.log('info', 'direct-json:enabled', {
          phase: 'browser-network-recovery',
          source: 'browser-network',
          carbonVersion: recoveredVersion
        });
        await logger?.writeIntermediateDiagnostics({
          promotionDecision: 'pending',
          startedAt,
          siteMetaFetched,
          siteMetaFailed,
          bundleDiscoveryFailed: true,
          directJsonEnabled: true,
          directJsonDisabledReason: null,
          dsdbConfigSource: 'browser-network',
          networkRecoveryAttempted: true,
          networkRecoverySucceeded: true
        });

        // Run direct JSON with the recovered config before browser DOM workers start
        crawlPhase = 'fetch-page-data';
        emitProgress(true);
        await runDirectJsonBatch(recoveredConfig);
        crawlPhase = 'browser-dom-fallback';
        knownTargetPageCount = maxPages;
        emitProgress(true);
      } else {
        const reason = networkRecoveryFailureReason ?? 'no-dsdb-urls-captured';
        networkRecoveryFailureReason = reason;
        directJsonEnabled = false;
        directJsonDisabledReason = reason;
        logError(`DSDB network recovery failed (${reason}); continuing with browser-only crawl`);
        logger?.log('warn', 'dsdb-config:network-failed', {
          phase: 'browser-network-recovery',
          reason,
          observedUrlCount: 0
        });
        logger?.log('warn', 'direct-json:disabled', {
          phase: 'browser-network-recovery',
          reason,
          directJsonEnabled: false
        });
        logger?.log('warn', 'browser-only-fallback:enabled', {
          phase: 'browser-network-recovery',
          bundleDiscoveryFailed,
          networkRecoveryAttempted,
          networkRecoverySucceeded: false,
          directJsonDisabledReason: reason
        });
        await logger?.writeIntermediateDiagnostics({
          promotionDecision: 'pending',
          startedAt,
          siteMetaFetched,
          siteMetaFailed,
          bundleDiscoveryFailed: true,
          directJsonEnabled: false,
          directJsonDisabledReason: reason,
          dsdbConfigSource: dsdbConfigSource ?? null,
          networkRecoveryAttempted: true,
          networkRecoverySucceeded: false,
          networkRecoveryFailureReason: reason,
          browserOnlyFallback: true
        });
      }
    } else if (!bundleDiscoveryFailed || directJsonEnabled) {
      logger?.log('info', 'direct-json:enabled', { phase: 'browser-dom-fallback', source: dsdbConfigSource });
    }

    const onAbort = () => {
      aborted = true;
      emitProgress(false, 'Material 3 crawl was interrupted.');
      wakeWorkers();
      void browserContext?.close().catch(() => undefined);
    };
    signal?.addEventListener('abort', onAbort, { once: true });
    enqueue(baseUrl);
    for (const slug of jsonFallbackRoutes.keys()) enqueue(new URL(`/${slug}`, baseUrl).toString());
    for (const docPath of discoveredPublicDocPaths) enqueue(new URL(docPath, baseUrl).toString());
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
  }

  crawlPhase = 'finalizing';
  const capturedAt = new Date().toISOString();
  for (const diagnostic of routeDiagnosticsByPath.values()) pushRouteDiagnostic(extractionDiagnostics, diagnostic);
  const qualityReport = createCrawlQualityReport(pages, suspiciousPages);
  coverageDiagnostics.acceptedPageCount = pages.length;
  coverageDiagnostics.discoveredPublicUrlCount = discoveredPublicDocPaths.size;
  coverageDiagnostics.sitemapUrlCount = sitemapPublicDocPaths.size;
  coverageDiagnostics.renderedNavUrlCount = renderedNavPublicDocPaths.size;
  coverageDiagnostics.angularRouteHintCount = angularRoutePublicDocPaths.size;
  coverageDiagnostics.previousCacheRouteHintCount = previousCacheRoutePublicDocPaths.size;
  coverageDiagnostics.includeBlog = includeBlog;
  coverageDiagnostics.crawlPriorityPolicyVersion = CRAWL_PRIORITY_POLICY_VERSION;
  const skippedByPolicyUrls = Array.from(policySkippedDocPaths).sort(compareMaterialRoutePriority);
  const skippedBlogCount = skippedByPolicyUrls.filter((p) => isBlogPath(p)).length;
  coverageDiagnostics.skippedByPolicyCount = policySkippedDocPaths.size;
  coverageDiagnostics.skippedBlogCount = skippedBlogCount;
  coverageDiagnostics.skippedByPolicyUrls = skippedByPolicyUrls;
  if (skippedBlogCount > 0) {
    logError(`[crawl-priority] Skipped ${skippedBlogCount} blog route(s) by policy (use --include-blog to include them).`);
  }
  // Uncrawled = discovered - accepted - intentionally skipped by policy
  const uncrawledDiscoveredUrls = Array.from(discoveredPublicDocPaths).filter((docPath) => !acceptedPublicDocPaths.has(docPath) && !policySkippedDocPaths.has(docPath)).sort();
  coverageDiagnostics.uncrawledDiscoveredUrls = uncrawledDiscoveredUrls;
  coverageDiagnostics.uncrawledDiscoveredUrlCount = uncrawledDiscoveredUrls.length;
  coverageDiagnostics.skippedBecauseJsonCoveredCount = Array.from(discoveredPublicDocPaths).filter((docPath) => acceptedPublicDocPaths.has(docPath) && isDsdbCoveredPath(docPath.replace(/^\/+/, ''), jsonExtractedSlugs)).length;
  // Limited-run detection is primarily whether maxPages actually truncated source-route selection
  // (or was explicitly requested) — not whether the cache-file count happened to reach the cap, since
  // a tight source-route budget can expand into fewer cache pages than maxPages via tab-splitting.
  // The legacy browser-only crawl path (no site_meta/bundle route list, so filterRoutes never runs)
  // has no source-route concept at all; for that path "pages.length reached maxPages" remains the
  // only available signal that the run was capped.
  const legacyMaxPagesHit = pages.length >= maxPages;
  const isLimitedRun = maxPagesExplicit || truncatedByMaxPages || legacyMaxPagesHit;
  const effectiveSkippedNotSelectedCount = truncatedByMaxPages ? skippedNotSelectedCount : (legacyMaxPagesHit ? uncrawledDiscoveredUrls.length : 0);
  coverageDiagnostics.isLimitedRun = isLimitedRun;
  coverageDiagnostics.maxPagesExplicit = maxPagesExplicit;
  coverageDiagnostics.skippedNotSelectedCount = skippedNotSelectedCount;
  coverageDiagnostics.skippedBecauseMaxPagesCount = effectiveSkippedNotSelectedCount;
  if (policySkippedDocPaths.size > 0) {
    coverageDiagnostics.coverageWarnings.push(`coverage-policy-skip:blog=${skippedBlogCount}:total=${policySkippedDocPaths.size}:includeBlog=${includeBlog}`);
  }
  // For gap/regression checks, treat policy-skipped routes as effectively covered
  const effectiveDiscovered = coverageDiagnostics.discoveredPublicUrlCount;
  const effectiveAccepted = coverageDiagnostics.acceptedPageCount + policySkippedDocPaths.size;
  if (coverageDiagnostics.discoveredPublicUrlCount === 0) {
    coverageDiagnostics.coverageWarnings.push(previousIndex ? 'coverage-discovery-empty:using-previous-cache-hints' : 'coverage-discovery-empty:no-baseline');
  }
  if (isLimitedRun) {
    coverageDiagnostics.coverageWarnings.push(`coverage-partial:max-pages-limited:${effectiveSkippedNotSelectedCount}`);
  }
  if (!isLimitedRun && hasSignificantCoverageGap(effectiveDiscovered, effectiveAccepted)) {
    coverageDiagnostics.coverageWarnings.push(`coverage-gap:accepted=${coverageDiagnostics.acceptedPageCount}:discovered=${coverageDiagnostics.discoveredPublicUrlCount}`);
  }
  const previousDiscoveredCount = previousIndex?.coverageDiagnostics?.discoveredPublicUrlCount ?? previousIndex?.pageCount ?? 0;
  if (previousDiscoveredCount > 0 && coverageDiagnostics.discoveredPublicUrlCount > 0 && coverageDiagnostics.discoveredPublicUrlCount < Math.floor(previousDiscoveredCount * COVERAGE_REGRESSION_RATIO)) {
    coverageDiagnostics.coverageWarnings.push(`coverage-regression:previous=${previousDiscoveredCount}:current=${coverageDiagnostics.discoveredPublicUrlCount}`);
  }
  coverageDiagnostics.coverageVerified = coverageDiagnostics.discoveredPublicUrlCount > 0
    && coverageDiagnostics.uncrawledDiscoveredUrlCount === 0
    && !coverageDiagnostics.coverageWarnings.some((warning) => warning.startsWith('coverage-regression:'))
    && !coverageDiagnostics.coverageWarnings.some((warning) => warning.startsWith('coverage-unverified:'))
    && !coverageDiagnostics.coverageWarnings.some((warning) => warning.startsWith('coverage-discovery-empty:'));
  // If a significant number of direct JSON attempts all failed, the extraction pipeline is broken.
  // Use a minimum threshold to avoid false positives in small crawls where browser DOM compensates.
  const MIN_DIRECT_JSON_ATTEMPTS_FOR_FAILURE_CHECK = 5;
  if (dsdbAttemptedCount >= MIN_DIRECT_JSON_ATTEMPTS_FOR_FAILURE_CHECK && extractionDiagnostics.pagesAcceptedFromDirectJson === 0) {
    coverageDiagnostics.coverageWarnings.push(
      `direct-json-failure:attempted=${dsdbAttemptedCount}:saved=0`
    );
    coverageDiagnostics.coverageVerified = false;
  }
  coverageDiagnostics.coverageHealth = computeCoverageHealth(coverageDiagnostics);

  // Source-route vs cache-page counters: one source route can expand into several tab-split cache
  // pages, so these must never be compared 1:1.
  const sourceVirtualCounters = computeSourceAndVirtualPageCounters(extractionDiagnostics.routeDiagnostics);
  extractionDiagnostics.sourcePagesSelected = sourcePagesSelectedCount;
  extractionDiagnostics.sourcePagesAttempted = sourceVirtualCounters.sourcePagesAttempted;
  extractionDiagnostics.sourcePagesSucceeded = sourceVirtualCounters.sourcePagesSucceeded;
  extractionDiagnostics.sourcePagesFailed = sourceVirtualCounters.sourcePagesFailed;
  extractionDiagnostics.virtualPagesPlanned = sourceVirtualCounters.virtualPagesPlanned;
  extractionDiagnostics.virtualPagesSaved = sourceVirtualCounters.virtualPagesSaved;
  extractionDiagnostics.virtualPagesFailed = sourceVirtualCounters.virtualPagesFailed;
  extractionDiagnostics.cachePagesSaved = sourceVirtualCounters.cachePagesSaved;

  // failedPageCount: virtualPagesFailed is the source of truth for direct-JSON/network-JSON/DOM
  // route-level failures (it excludes skipped-not-attempted entries); failedUrls is kept only for
  // the legacy browser-DOM-worker path, a disjoint URL space in default (non-browser-fallback) mode.
  const index: MaterialIndex = {
    source: baseUrl,
    capturedAt,
    pageCount: pages.length,
    attemptedPageCount: dsdbAttemptedCount + seen.size,
    failedPageCount: failedUrls.length + sourceVirtualCounters.virtualPagesFailed,
    failedUrls,
    qualityReport,
    extractionDiagnostics,
    coverageDiagnostics,
    pages: pages.map(({ text: _text, markdown: _markdown, ...meta }) => meta)
  };
  await writeIndex(index, cacheDir);
  crawlPhase = 'promoting';
  emitProgress(true);
  emitProgress(false);
  return {
    index,
    dsdbState: {
      dsdbConfigSource,
      directJsonEnabled,
      directJsonDisabledReason,
      siteMetaFetched,
      siteMetaFailed,
      bundleDiscoveryFailed,
      networkRecoveryAttempted,
      networkRecoverySucceeded,
      networkRecoveryFailureReason
    }
  };

  function tabUrlSlug(tab: BundleTabEntry): string {
    if (tab.slug) return tab.slug.replace(/^\/+|\/+$/g, '');
    return tab.label.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '');
  }

  /**
   * Deterministic fetch-page-data path for a route resolved via the page-reference-resolver
   * (collectionId/documentId/exportedCarbonFileId from the bundle table). No slug guessing: at
   * most one page-data URL and one Carbon content URL are attempted. Routes with tabs[] produce
   * one virtual cache page per tab from a single page-data + Carbon fetch.
   */
  async function runReferenceBasedRouteFetch(route: DsdbRoute, carbonVersion: string, routeUrl: string, capturedAt: string): Promise<void> {
    const routePath = routePathFromSlug(route.slug);
    const collectionId = route.collectionId!;
    const documentId = route.documentId!;

    const [pageDataResult, carbonResult] = await Promise.all([
      fetchPageDataByReference(baseUrl, { collectionId, documentId }, signal),
      fetchCarbonContentByReference(baseUrl, carbonVersion, route.exportedCarbonFileId, signal)
    ]);

    const pageDataOk = pageDataResult.status === 'ok';
    const carbonOk = carbonResult.status === 'ok';
    const contentSource: ExtractionRouteDiagnostic['contentSource'] = pageDataOk && carbonOk
      ? 'page-data+carbon'
      : carbonOk ? 'carbon' : 'page-data';
    const pageDataUrl = pageDataResult.url;
    const pageDataStatus = pageDataResult.status === 'ok' || pageDataResult.status === 'http-error' ? pageDataResult.httpStatus : pageDataResult.status;
    const carbonUrl = carbonResult.status === 'not-available' ? undefined : carbonResult.url;
    const carbonStatus = carbonResult.status === 'ok' || carbonResult.status === 'http-error' ? carbonResult.httpStatus : carbonResult.status === 'not-available' ? undefined : carbonResult.status;

    const sharedDiagnosticFields = {
      navigationSource: route.navigationSource,
      pageReferenceSource: 'bundle-table' as const,
      contentSource,
      sourceRoute: routePath,
      pageDataFetchedOnce: true,
      pageDataUrl,
      pageDataStatus,
      carbonUrl,
      carbonStatus,
      selectedBecause: route.selectedBecause
    };

    if (!pageDataOk && !carbonOk) {
      jsonFallbackRoutes.set(route.slug, 'json-fetch-failed');
      recordRouteDiagnostic(createRouteDiagnostic({
        url: routeUrl,
        path: routePath,
        sourceUsed: 'failed',
        finalMethod: null,
        directJsonAttempted: true,
        fallbackReasons: ['json-fetch-failed'],
        ...sharedDiagnosticFields
      }));
      return;
    }

    const pageDataJson = pageDataOk ? pageDataResult.data : null;
    const contentJson = carbonOk ? carbonResult.data : null;
    const fetchResource = createDsdbResourceFetcher(baseUrl, carbonVersion, [], signal);

    const savePage = (url: string, extraction: Awaited<ReturnType<typeof extractContentPageToMaterialPage>>, extra: Partial<Parameters<typeof createRouteDiagnostic>[0]>): void => {
      if (extraction.fallbackReason) {
        jsonFallbackRoutes.set(route.slug, extraction.fallbackReason);
        recordRouteDiagnostic(createRouteDiagnostic({
          url: extraction.page.url,
          path: extraction.page.path,
          sourceUsed: 'failed',
          finalMethod: null,
          directJsonAttempted: true,
          fallbackReasons: [extraction.fallbackReason],
          unknownChunkTypes: extraction.pageDiagnostic.unknownChunkTypes,
          unknownResourceTypes: extraction.pageDiagnostic.unknownResourceTypes,
          tokenTables: extraction.pageDiagnostic.tokenTables,
          tokenTablesRendered: extraction.pageDiagnostic.tokenTablesRendered,
          tokenTablesResolved: extraction.pageDiagnostic.tokenTablesResolved,
          tokenTablesDecoded: extraction.pageDiagnostic.tokenTablesDecoded,
          tokenTablesRenderedFromInline: extraction.pageDiagnostic.tokenTablesRenderedFromInline ?? 0,
          missingRequestedTokenSets: extraction.pageDiagnostic.missingRequestedTokenSets,
          routeMetadataWarnings: route.metadataWarnings ?? [],
          ...sharedDiagnosticFields,
          ...extra
        }));
        return;
      }
      const materialPage = extraction.page;
      if (materialPage.text.length <= MIN_PAGE_TEXT_LENGTH || pages.length >= maxPages || writtenPaths.has(materialPage.path)) return;
      pages.push(materialPage);
      markAcceptedPage(materialPage.path);
      pushPageDiagnostic(extractionDiagnostics, { ...extraction.pageDiagnostic, source: 'direct-json' });
      recordRouteDiagnostic(createRouteDiagnostic({
        url: materialPage.url,
        path: materialPage.path,
        sourceUsed: 'direct-json',
        finalMethod: 'json',
        directJsonAttempted: true,
        directJsonSucceeded: true,
        unknownChunkTypes: extraction.pageDiagnostic.unknownChunkTypes,
        unknownResourceTypes: extraction.pageDiagnostic.unknownResourceTypes,
        tokenTables: extraction.pageDiagnostic.tokenTables,
        tokenTablesRendered: extraction.pageDiagnostic.tokenTablesRendered,
        missingRequestedTokenSets: extraction.pageDiagnostic.missingRequestedTokenSets,
        routeMetadataWarnings: route.metadataWarnings ?? [],
        ...sharedDiagnosticFields,
        ...extra
      }));
      writtenPaths.add(materialPage.path);
      jsonExtractedSlugs.add(route.slug);
      lastSavedUrl = materialPage.url;
      void writePage(materialPage, cacheDir);
      emitProgress(true);
    };

    if (route.tabs && route.tabs.length > 0) {
      const decodedContentPage = contentJson ? parseContentPage(contentJson) : null;
      const decodedSections = decodedContentPage?.sections ?? [];
      const sectionRefs = decodedSections.map((s) => ({ name: s.title }));
      // hasRouteTitlePathMismatch() expects the page title to mention the route's component
      // name (segments[1] of the URL) — combine the parent page title with the tab label so a
      // tab page like /components/buttons/specs titled "Specs" doesn't trip that heuristic.
      const parentTitle = pageDataJson ? extractPageDataMetadata(pageDataJson).title : null;
      const effectiveParentTitle = parentTitle ?? decodedContentPage?.title ?? null;
      for (let tabIndex = 0; tabIndex < route.tabs.length; tabIndex += 1) {
        const tab = route.tabs[tabIndex]!;
        const slug = tabUrlSlug(tab);
        const tabUrl = `${routeUrl}/${slug}`;
        const matchResult = matchTabToSection(tab, tabIndex, sectionRefs, route.tabs.length);
        if (!matchResult.matched) {
          recordRouteDiagnostic(createRouteDiagnostic({
            url: tabUrl,
            path: routePathFromSlug(`${route.slug}/${slug}`),
            sourceUsed: 'failed',
            finalMethod: null,
            directJsonAttempted: true,
            fallbackReasons: ['json-no-sections'],
            ...sharedDiagnosticFields,
            virtualSource: 'tab',
            virtualRoute: tabUrl,
            tabName: tab.label,
            tabSlug: slug
          }));
          continue;
        }
        const extraction = await extractContentPageToMaterialPage({
          url: tabUrl,
          pageData: pageDataJson,
          contentPage: contentJson,
          capturedAt,
          fetchResource,
          sectionIndices: [matchResult.sectionIndex],
          titleOverride: effectiveParentTitle ? `${effectiveParentTitle} ${tab.label}` : tab.label
        });
        savePage(tabUrl, extraction, { virtualSource: 'tab', virtualRoute: tabUrl, tabName: tab.label, tabSlug: slug });
      }
      return;
    }

    const extraction = await extractContentPageToMaterialPage({
      url: routeUrl,
      pageData: pageDataJson,
      contentPage: contentJson,
      capturedAt,
      fetchResource
    });
    savePage(routeUrl, extraction, { virtualSource: null });
  }

  async function runDirectJsonBatch(config: DsdbSiteConfig): Promise<void> {
    addDiscoveredPaths(
      config.routes.map((route) => normalizeMaterialPublicDocPath(`/${route.slug}`, baseUrl))
        .filter((value): value is string => Boolean(value)),
      angularRoutePublicDocPaths
    );
    const capturedAt = new Date().toISOString();
    // Filter blog routes when includeBlog is false, recording them as policy-skipped.
    const eligibleRoutes = includeBlog
      ? config.routes
      : config.routes.filter((route) => {
          if (isBlogPath(`/${route.slug}`)) {
            policySkippedDocPaths.add(`/${route.slug}`);
            return false;
          }
          return true;
        });
    // Pre-limit to remaining page budget so we don't schedule hundreds of fetches
    // when maxPages is small and none have been saved yet.
    const remainingBudget = Math.max(0, maxPages - pages.length);
    const routes = eligibleRoutes.slice(0, remainingBudget);
    knownTargetPageCount = Math.min(maxPages, pages.length + routes.length);
    crawlPhase = 'fetch-page-data';
    emitProgress(true);
    for (let i = 0; i < routes.length && pages.length < maxPages && !signal?.aborted; i += concurrency) {
      throwIfAborted(signal);
      const batch = routes.slice(i, i + concurrency);
      await Promise.all(batch.map(async (route) => {
        if (pages.length >= maxPages || signal?.aborted) return;
        dsdbAttemptedCount += 1;
        const routeUrl = new URL(`/${route.slug}`, baseUrl).toString();
        directJsonActiveUrls.add(routeUrl);
        emitProgress(true);
        try {
          throwIfAborted(signal);

          if (route.pageReferenceSource === 'bundle-table' && route.collectionId && route.documentId) {
            await runReferenceBasedRouteFetch(route, config.carbonVersion, routeUrl, capturedAt);
            return;
          }

          // Legacy/degraded path (no resolved bundle-table reference — e.g. browser-network-
          // recovery slug-only routes). Kept as an explicit fallback; never reported as
          // bundle-table-resolved direct JSON.
          const bundle = await fetchJsonPageBundle(baseUrl, config.carbonVersion, {
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
            recordRouteDiagnostic(createRouteDiagnostic({
              url: routeUrl,
              path: routePath,
              sourceUsed: 'failed',
              finalMethod: null,
              directJsonAttempted: true,
              fallbackReasons: ['json-fetch-failed'],
              pageReferenceSource: route.pageReferenceSource
            }));
            return;
          }
          const extraction = await extractContentPageToMaterialPage({
            url: routeUrl,
            pageData: bundle.pageData,
            contentPage: bundle.contentPage,
            capturedAt,
            fetchResource: bundle.fetchResource
          });
          if (extraction.fallbackReason) {
            jsonFallbackRoutes.set(route.slug, extraction.fallbackReason);
            recordRouteDiagnostic(createRouteDiagnostic({
              url: extraction.page.url,
              path: extraction.page.path,
              sourceUsed: 'failed',
              finalMethod: null,
              directJsonAttempted: true,
              fallbackReasons: [extraction.fallbackReason],
              unknownChunkTypes: extraction.pageDiagnostic.unknownChunkTypes,
              unknownResourceTypes: extraction.pageDiagnostic.unknownResourceTypes,
              tokenTables: extraction.pageDiagnostic.tokenTables,
              tokenTablesRendered: extraction.pageDiagnostic.tokenTablesRendered,
              tokenTablesRequested: extraction.pageDiagnostic.tokenTables,
              tokenTablesResolved: extraction.pageDiagnostic.tokenTablesResolved,
              tokenTablesDecoded: extraction.pageDiagnostic.tokenTablesDecoded,
              tokenTablesRenderedFromInline: extraction.pageDiagnostic.tokenTablesRenderedFromInline ?? 0,
              tokenTablesRenderedAsPlaceholder: extraction.pageDiagnostic.tokenTablesRenderedAsPlaceholder ?? 0,
              tokenTablesUnsupportedSchema: extraction.pageDiagnostic.tokenTablesUnsupportedSchema ?? 0,
              tokenContextDiagnostics: extraction.pageDiagnostic.tokenContextDiagnostics,
              statusTablesRequested: extraction.pageDiagnostic.statusTablesRequested ?? 0,
              statusTablesResolved: extraction.pageDiagnostic.statusTablesResolved ?? 0,
              statusTablesDecoded: extraction.pageDiagnostic.statusTablesDecoded ?? 0,
              statusTablesRenderedAsPlaceholder: extraction.pageDiagnostic.statusTablesRenderedAsPlaceholder ?? 0,
              unsupportedStatusTableSchemaCount: extraction.pageDiagnostic.unsupportedStatusTableSchemaCount ?? 0,
              statusTableDiagnostics: extraction.pageDiagnostic.statusTableDiagnostics ?? [],
              resourceChunksRequested: extraction.pageDiagnostic.resourceChunksRequested ?? 0,
              resourceChunksResolved: extraction.pageDiagnostic.resourceChunksResolved ?? 0,
              resourceChunksDecoded: extraction.pageDiagnostic.resourceChunksDecoded ?? 0,
              resourceChunksRendered: extraction.pageDiagnostic.resourceChunksRendered ?? 0,
              resourceChunksPlaceholder: extraction.pageDiagnostic.resourceChunksPlaceholder ?? 0,
              missingRequestedTokenSets: extraction.pageDiagnostic.missingRequestedTokenSets,
              routeMetadataWarnings: route.metadataWarnings ?? []
            }));
            return;
          }
          const materialPage = extraction.page;
          if (materialPage.text.length > MIN_PAGE_TEXT_LENGTH && pages.length < maxPages && !writtenPaths.has(materialPage.path)) {
            const rawJsonDebugFilesWritten = await writeRawJsonDebugFiles(cacheDir, materialPage.path, bundle.responses);
            pages.push(materialPage);
            markAcceptedPage(materialPage.path);
            pushPageDiagnostic(extractionDiagnostics, { ...extraction.pageDiagnostic, source: 'direct-json' });
            recordRouteDiagnostic(createRouteDiagnostic({
              url: materialPage.url,
              path: materialPage.path,
              sourceUsed: 'direct-json',
              finalMethod: 'json',
              directJsonAttempted: true,
              directJsonSucceeded: true,
              unknownChunkTypes: extraction.pageDiagnostic.unknownChunkTypes,
              unknownResourceTypes: extraction.pageDiagnostic.unknownResourceTypes,
              tokenTables: extraction.pageDiagnostic.tokenTables,
              tokenTablesRendered: extraction.pageDiagnostic.tokenTablesRendered,
              tokenTablesRequested: extraction.pageDiagnostic.tokenTables,
              tokenTablesResolved: extraction.pageDiagnostic.tokenTablesResolved,
              tokenTablesDecoded: extraction.pageDiagnostic.tokenTablesDecoded,
              tokenTablesRenderedFromInline: extraction.pageDiagnostic.tokenTablesRenderedFromInline ?? 0,
              tokenTablesRenderedAsPlaceholder: extraction.pageDiagnostic.tokenTablesRenderedAsPlaceholder ?? 0,
              tokenTablesUnsupportedSchema: extraction.pageDiagnostic.tokenTablesUnsupportedSchema ?? 0,
              tokenContextDiagnostics: extraction.pageDiagnostic.tokenContextDiagnostics,
              statusTablesRequested: extraction.pageDiagnostic.statusTablesRequested ?? 0,
              statusTablesResolved: extraction.pageDiagnostic.statusTablesResolved ?? 0,
              statusTablesDecoded: extraction.pageDiagnostic.statusTablesDecoded ?? 0,
              statusTablesRenderedAsPlaceholder: extraction.pageDiagnostic.statusTablesRenderedAsPlaceholder ?? 0,
              unsupportedStatusTableSchemaCount: extraction.pageDiagnostic.unsupportedStatusTableSchemaCount ?? 0,
              statusTableDiagnostics: extraction.pageDiagnostic.statusTableDiagnostics ?? [],
              resourceChunksRequested: extraction.pageDiagnostic.resourceChunksRequested ?? 0,
              resourceChunksResolved: extraction.pageDiagnostic.resourceChunksResolved ?? 0,
              resourceChunksDecoded: extraction.pageDiagnostic.resourceChunksDecoded ?? 0,
              resourceChunksRendered: extraction.pageDiagnostic.resourceChunksRendered ?? 0,
              resourceChunksPlaceholder: extraction.pageDiagnostic.resourceChunksPlaceholder ?? 0,
              missingRequestedTokenSets: extraction.pageDiagnostic.missingRequestedTokenSets,
              rawJsonDebugFilesWritten,
              routeMetadataWarnings: route.metadataWarnings ?? [],
              candidateSelectionReasons: bundle.selectionReasons
            }));
            writtenPaths.add(materialPage.path);
            jsonExtractedSlugs.add(route.slug);
            lastSavedUrl = materialPage.url;
            await writePage(materialPage, cacheDir);
            emitProgress(true);
          }
        } catch (err) {
          if (signal?.aborted) return;
          jsonFallbackRoutes.set(route.slug, 'json-fetch-failed');
          recordRouteDiagnostic(createRouteDiagnostic({
            url: routeUrl,
            path: routePathFromSlug(route.slug),
            sourceUsed: 'failed',
            finalMethod: null,
            directJsonAttempted: true,
            fallbackReasons: ['json-fetch-failed']
          }));
          logVerbose(`JSON extraction failed for ${route.slug}: ${err instanceof Error ? err.message : String(err)}`);
        } finally {
          directJsonActiveUrls.delete(routeUrl);
          emitProgress(true);
        }
      }));
    }
    emitProgress(true);
  }

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
        logVerbose(`Failed to crawl ${url}: ${error instanceof Error ? error.message : String(error)}`);
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
            markAcceptedPage(materialPage.path);
            const fallbackReason = jsonFallbackRoutes.get(routeSlugFromPath(materialPage.path));
            pushPageDiagnostic(extractionDiagnostics, {
              url: materialPage.url,
              path: materialPage.path,
              method: 'dom',
              source: 'dom-fallback',
              ...(fallbackReason ? { fallbackReason } : {}),
              unknownChunkTypes: [],
              unknownResourceTypes: [],
              tokenTables: 0,
              tokenTablesRendered: 0,
              tokenContextDiagnostics: [],
              statusTablesRequested: 0,
              statusTablesResolved: 0,
              statusTablesRenderedAsPlaceholder: 0,
              unsupportedStatusTableSchemaCount: 0,
              statusTableDiagnostics: [],
              missingRequestedTokenSets: [],
              suspiciousReasons: [],
              imageCount: 0,
              videoCount: 0,
              unresolvedResourceCount: 0,
              noSections: false,
              noHeadings: materialPage.headings.length === 0,
              markdownLength: materialPage.markdown.length
            });
            const previousDiagnostic = routeDiagnosticsByPath.get(materialPage.path);
            recordRouteDiagnostic(createRouteDiagnostic({
              url: materialPage.url,
              path: materialPage.path,
              sourceUsed: 'dom-fallback',
              finalMethod: 'dom',
              directJsonAttempted: previousDiagnostic?.directJsonAttempted ?? Boolean(fallbackReason),
              directJsonSucceeded: previousDiagnostic?.directJsonSucceeded ?? false,
              networkJsonAttempted: previousDiagnostic?.networkJsonAttempted ?? false,
              networkJsonSucceeded: previousDiagnostic?.networkJsonSucceeded ?? false,
              domFallbackAttempted: false,
              domFallbackSucceeded: false,
              fallbackReasons: previousDiagnostic?.fallbackReasons ?? (fallbackReason ? [fallbackReason] : []),
              fallbackSkippedReasons: previousDiagnostic?.fallbackSkippedReasons ?? [],
              capturedJsonResponseCounts: previousDiagnostic?.capturedJsonResponseCounts ?? {},
              unknownChunkTypes: previousDiagnostic?.unknownChunkTypes ?? [],
              unknownResourceTypes: previousDiagnostic?.unknownResourceTypes ?? [],
              tokenTables: previousDiagnostic?.tokenTables ?? 0,
              tokenTablesRendered: previousDiagnostic?.tokenTablesRendered ?? 0,
              tokenTablesRequested: previousDiagnostic?.tokenTablesRequested ?? previousDiagnostic?.tokenTables ?? 0,
              tokenContextDiagnostics: previousDiagnostic?.tokenContextDiagnostics ?? [],
              statusTablesRequested: previousDiagnostic?.statusTablesRequested ?? 0,
              statusTablesResolved: previousDiagnostic?.statusTablesResolved ?? 0,
              statusTablesRenderedAsPlaceholder: previousDiagnostic?.statusTablesRenderedAsPlaceholder ?? 0,
              unsupportedStatusTableSchemaCount: previousDiagnostic?.unsupportedStatusTableSchemaCount ?? 0,
              statusTableDiagnostics: previousDiagnostic?.statusTableDiagnostics ?? [],
              missingRequestedTokenSets: previousDiagnostic?.missingRequestedTokenSets ?? [],
              unknownJsonResourceCount: previousDiagnostic?.unknownJsonResourceCount ?? 0,
              rawJsonDebugFilesWritten: previousDiagnostic?.rawJsonDebugFilesWritten ?? 0
            }));
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

    const networkCapture = createNetworkJsonCapture(page);
    let finalUrl: string;
    try {
      finalUrl = await navigateToStableMaterialPage(page, url, baseUrl, signal);
    } catch (error) {
      networkCapture.stop();
      if (error instanceof RequestedRouteRejectedError) {
        suspiciousPages.push(error.rejectedRoute);
        failedUrls.push(url);
        lastFailedUrl = url;
        emitProgress(true);
        logVerbose(`Rejected crawled ${url}: ${error.rejectedRoute.reason}`);
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
    await networkCapture.stopAndDrain();

    const capturedBundle = networkCapture.buildBundle({
      requestedUrl: url,
      finalUrl,
      slug: routeSlugFromPath(materialPagePath(finalUrl)),
      routeMetadata: {
        slug: routeSlugFromPath(materialPagePath(finalUrl))
      }
    });
    const capturedJsonResponseCounts = countCapturedResponseTypes(capturedBundle.responses);
    const unknownJsonResourceCount = capturedBundle.responses.filter((response) => response.type === 'unknown-json-resource').length;

    if (capturedBundle.pageData || capturedBundle.contentPage) {
      const networkExtraction = await extractContentPageToMaterialPage({
        url: finalUrl,
        pageData: capturedBundle.pageData,
        contentPage: capturedBundle.contentPage,
        fetchResource: capturedBundle.fetchResource
      });
      if (!networkExtraction.fallbackReason && networkExtraction.page.text.length > MIN_PAGE_TEXT_LENGTH && pages.length < maxPages && !writtenPaths.has(networkExtraction.page.path)) {
        const rawJsonDebugFilesWritten = await writeRawJsonDebugFiles(cacheDir, networkExtraction.page.path, capturedBundle.responses);
        pages.push(networkExtraction.page);
        markAcceptedPage(networkExtraction.page.path);
        pushPageDiagnostic(extractionDiagnostics, { ...networkExtraction.pageDiagnostic, source: 'network-json' });
        recordRouteDiagnostic(createRouteDiagnostic({
          url: networkExtraction.page.url,
          path: networkExtraction.page.path,
          sourceUsed: 'network-json',
          finalMethod: 'json',
          directJsonAttempted: routeDiagnosticsByPath.get(networkExtraction.page.path)?.directJsonAttempted ?? jsonFallbackRoutes.has(routeSlugFromPath(networkExtraction.page.path)),
          directJsonSucceeded: routeDiagnosticsByPath.get(networkExtraction.page.path)?.directJsonSucceeded ?? false,
          networkJsonAttempted: true,
          networkJsonSucceeded: true,
          fallbackReasons: routeDiagnosticsByPath.get(networkExtraction.page.path)?.fallbackReasons ?? [],
          fallbackSkippedReasons: routeDiagnosticsByPath.get(networkExtraction.page.path)?.fallbackSkippedReasons ?? [],
          unknownChunkTypes: networkExtraction.pageDiagnostic.unknownChunkTypes,
          unknownResourceTypes: networkExtraction.pageDiagnostic.unknownResourceTypes,
          tokenTables: networkExtraction.pageDiagnostic.tokenTables,
          tokenTablesRendered: networkExtraction.pageDiagnostic.tokenTablesRendered,
          tokenTablesRequested: networkExtraction.pageDiagnostic.tokenTables,
          tokenTablesResolved: networkExtraction.pageDiagnostic.tokenTablesResolved,
          tokenTablesDecoded: networkExtraction.pageDiagnostic.tokenTablesDecoded,
          tokenTablesRenderedFromInline: networkExtraction.pageDiagnostic.tokenTablesRenderedFromInline ?? 0,
          tokenTablesRenderedAsPlaceholder: networkExtraction.pageDiagnostic.tokenTablesRenderedAsPlaceholder ?? 0,
          tokenTablesUnsupportedSchema: networkExtraction.pageDiagnostic.tokenTablesUnsupportedSchema ?? 0,
          tokenContextDiagnostics: networkExtraction.pageDiagnostic.tokenContextDiagnostics,
          statusTablesRequested: networkExtraction.pageDiagnostic.statusTablesRequested ?? 0,
          statusTablesResolved: networkExtraction.pageDiagnostic.statusTablesResolved ?? 0,
          statusTablesDecoded: networkExtraction.pageDiagnostic.statusTablesDecoded ?? 0,
          statusTablesRenderedAsPlaceholder: networkExtraction.pageDiagnostic.statusTablesRenderedAsPlaceholder ?? 0,
          unsupportedStatusTableSchemaCount: networkExtraction.pageDiagnostic.unsupportedStatusTableSchemaCount ?? 0,
          statusTableDiagnostics: networkExtraction.pageDiagnostic.statusTableDiagnostics ?? [],
          resourceChunksRequested: networkExtraction.pageDiagnostic.resourceChunksRequested ?? 0,
          resourceChunksResolved: networkExtraction.pageDiagnostic.resourceChunksResolved ?? 0,
          resourceChunksDecoded: networkExtraction.pageDiagnostic.resourceChunksDecoded ?? 0,
          resourceChunksRendered: networkExtraction.pageDiagnostic.resourceChunksRendered ?? 0,
          resourceChunksPlaceholder: networkExtraction.pageDiagnostic.resourceChunksPlaceholder ?? 0,
          missingRequestedTokenSets: networkExtraction.pageDiagnostic.missingRequestedTokenSets,
          unknownJsonResourceCount,
          capturedJsonResponseCounts,
          rawJsonDebugFilesWritten,
          candidateSelectionReasons: capturedBundle.selectionReasons
        }));
        lastSavedUrl = finalUrl;
        writtenPaths.add(networkExtraction.page.path);
        await writePage(networkExtraction.page, cacheDir);
        emitProgress(true);
        await assertMaterialRouteUnchanged(page, finalUrl, baseUrl, 'link discovery');
        if (isBlogListingUrl(finalUrl, baseUrl)) {
          const pairs = await extractBlogListingYears(page, baseUrl).catch(() => [] as Array<[string, number]>);
          for (const [postUrl, year] of pairs) blogPostYears.set(postUrl, year);
        }
        const discoveredLinks = await discoverLinks(page, baseUrl);
        if (finalUrl === baseUrl) addDiscoveredPaths(await discoverRenderedNavDocPaths(page, baseUrl), renderedNavPublicDocPaths);
        for (const link of discoveredLinks) enqueue(link);
        emitProgress(true);
        return;
      }

      const previousDiagnostic = routeDiagnosticsByPath.get(networkExtraction.page.path);
      recordRouteDiagnostic(createRouteDiagnostic({
        url: networkExtraction.page.url,
        path: networkExtraction.page.path,
        sourceUsed: 'failed',
        finalMethod: null,
        directJsonAttempted: previousDiagnostic?.directJsonAttempted ?? jsonFallbackRoutes.has(routeSlugFromPath(networkExtraction.page.path)),
        directJsonSucceeded: previousDiagnostic?.directJsonSucceeded ?? false,
        networkJsonAttempted: true,
        networkJsonSucceeded: false,
        fallbackReasons: [...(previousDiagnostic?.fallbackReasons ?? []), networkExtraction.fallbackReason ?? 'network-json-failed'],
        fallbackSkippedReasons: previousDiagnostic?.fallbackSkippedReasons ?? [],
        unknownChunkTypes: networkExtraction.pageDiagnostic.unknownChunkTypes,
        unknownResourceTypes: networkExtraction.pageDiagnostic.unknownResourceTypes,
        tokenTables: networkExtraction.pageDiagnostic.tokenTables,
        tokenTablesRendered: networkExtraction.pageDiagnostic.tokenTablesRendered,
        tokenTablesRequested: networkExtraction.pageDiagnostic.tokenTables,
        tokenContextDiagnostics: networkExtraction.pageDiagnostic.tokenContextDiagnostics,
        statusTablesRequested: networkExtraction.pageDiagnostic.statusTablesRequested ?? 0,
        statusTablesResolved: networkExtraction.pageDiagnostic.statusTablesResolved ?? 0,
        statusTablesRenderedAsPlaceholder: networkExtraction.pageDiagnostic.statusTablesRenderedAsPlaceholder ?? 0,
        unsupportedStatusTableSchemaCount: networkExtraction.pageDiagnostic.unsupportedStatusTableSchemaCount ?? 0,
        statusTableDiagnostics: networkExtraction.pageDiagnostic.statusTableDiagnostics ?? [],
        missingRequestedTokenSets: networkExtraction.pageDiagnostic.missingRequestedTokenSets,
        unknownJsonResourceCount,
        capturedJsonResponseCounts,
        candidateSelectionReasons: capturedBundle.selectionReasons
      }));
    } else {
      recordRouteDiagnostic(createRouteDiagnostic({
        url: finalUrl,
        path: materialPagePath(finalUrl),
        sourceUsed: 'failed',
        finalMethod: null,
        directJsonAttempted: routeDiagnosticsByPath.get(materialPagePath(finalUrl))?.directJsonAttempted ?? jsonFallbackRoutes.has(routeSlugFromPath(materialPagePath(finalUrl))),
        directJsonSucceeded: routeDiagnosticsByPath.get(materialPagePath(finalUrl))?.directJsonSucceeded ?? false,
        networkJsonAttempted: true,
        networkJsonSucceeded: false,
        fallbackReasons: [...(routeDiagnosticsByPath.get(materialPagePath(finalUrl))?.fallbackReasons ?? []), 'network-json-failed'],
        fallbackSkippedReasons: routeDiagnosticsByPath.get(materialPagePath(finalUrl))?.fallbackSkippedReasons ?? [],
        unknownJsonResourceCount,
        capturedJsonResponseCounts,
        candidateSelectionReasons: capturedBundle.selectionReasons
      }));
    }

    const materialPage = await extract(page, finalUrl);
    const suspiciousResult = validateCrawledPage(materialPage);
    if (suspiciousResult) {
      const previousDiagnostic = routeDiagnosticsByPath.get(materialPage.path);
      recordRouteDiagnostic(createRouteDiagnostic({
        url: materialPage.url,
        path: materialPage.path,
        sourceUsed: 'failed',
        finalMethod: null,
        directJsonAttempted: previousDiagnostic?.directJsonAttempted ?? jsonFallbackRoutes.has(routeSlugFromPath(materialPage.path)),
        directJsonSucceeded: previousDiagnostic?.directJsonSucceeded ?? false,
        networkJsonAttempted: previousDiagnostic?.networkJsonAttempted ?? true,
        networkJsonSucceeded: previousDiagnostic?.networkJsonSucceeded ?? false,
        domFallbackAttempted: true,
        domFallbackSucceeded: false,
        fallbackReasons: previousDiagnostic?.fallbackReasons ?? ['dom-fallback-failed'],
        fallbackSkippedReasons: previousDiagnostic?.fallbackSkippedReasons ?? [],
        capturedJsonResponseCounts: previousDiagnostic?.capturedJsonResponseCounts ?? capturedJsonResponseCounts,
        unknownChunkTypes: previousDiagnostic?.unknownChunkTypes ?? [],
        unknownResourceTypes: previousDiagnostic?.unknownResourceTypes ?? [],
        tokenTables: previousDiagnostic?.tokenTables ?? 0,
        tokenTablesRendered: previousDiagnostic?.tokenTablesRendered ?? 0,
        tokenTablesRequested: previousDiagnostic?.tokenTablesRequested ?? previousDiagnostic?.tokenTables ?? 0,
        tokenContextDiagnostics: previousDiagnostic?.tokenContextDiagnostics ?? [],
        statusTablesRequested: previousDiagnostic?.statusTablesRequested ?? 0,
        statusTablesResolved: previousDiagnostic?.statusTablesResolved ?? 0,
        statusTablesRenderedAsPlaceholder: previousDiagnostic?.statusTablesRenderedAsPlaceholder ?? 0,
        unsupportedStatusTableSchemaCount: previousDiagnostic?.unsupportedStatusTableSchemaCount ?? 0,
        statusTableDiagnostics: previousDiagnostic?.statusTableDiagnostics ?? [],
        missingRequestedTokenSets: previousDiagnostic?.missingRequestedTokenSets ?? [],
        unknownJsonResourceCount: previousDiagnostic?.unknownJsonResourceCount ?? unknownJsonResourceCount,
        rawJsonDebugFilesWritten: previousDiagnostic?.rawJsonDebugFilesWritten ?? 0
      }));
      suspiciousPages.push(suspiciousResult);
      failedUrls.push(url);
      lastFailedUrl = url;
      emitProgress(true);
      logVerbose(`Rejected crawled ${url}: ${suspiciousResult.reason}`);
      return;
    }
    if (materialPage.text.length > MIN_PAGE_TEXT_LENGTH && pages.length < maxPages && !writtenPaths.has(materialPage.path)) {
      const publishedYear = materialPage.path.startsWith('blog/') ? blogPostYears.get(finalUrl) : undefined;
      const pageToSave = publishedYear ? { ...materialPage, publishedYear } : materialPage;
      pages.push(pageToSave);
      markAcceptedPage(pageToSave.path);
      const fallbackReason = jsonFallbackRoutes.get(routeSlugFromPath(pageToSave.path));
      pushPageDiagnostic(extractionDiagnostics, {
        url: pageToSave.url,
        path: pageToSave.path,
        method: 'dom',
        source: 'dom-fallback',
        ...(fallbackReason ? { fallbackReason } : {}),
        unknownChunkTypes: [],
        unknownResourceTypes: [],
        tokenTables: 0,
        tokenTablesRendered: 0,
        tokenContextDiagnostics: [],
        statusTablesRequested: 0,
        statusTablesResolved: 0,
        statusTablesRenderedAsPlaceholder: 0,
        unsupportedStatusTableSchemaCount: 0,
        statusTableDiagnostics: [],
        missingRequestedTokenSets: [],
        suspiciousReasons: [],
        imageCount: 0,
        videoCount: 0,
        unresolvedResourceCount: 0,
        noSections: false,
        noHeadings: pageToSave.headings.length === 0,
        markdownLength: pageToSave.markdown.length
      });
      const previousDiagnostic = routeDiagnosticsByPath.get(pageToSave.path);
      recordRouteDiagnostic(createRouteDiagnostic({
        url: pageToSave.url,
        path: pageToSave.path,
        sourceUsed: 'dom-fallback',
        finalMethod: 'dom',
        directJsonAttempted: previousDiagnostic?.directJsonAttempted ?? Boolean(fallbackReason),
        directJsonSucceeded: previousDiagnostic?.directJsonSucceeded ?? false,
        networkJsonAttempted: previousDiagnostic?.networkJsonAttempted ?? true,
        networkJsonSucceeded: previousDiagnostic?.networkJsonSucceeded ?? false,
        domFallbackAttempted: true,
        domFallbackSucceeded: true,
        fallbackReasons: previousDiagnostic?.fallbackReasons ?? (fallbackReason ? [fallbackReason] : ['network-json-failed']),
        fallbackSkippedReasons: previousDiagnostic?.fallbackSkippedReasons ?? [],
        capturedJsonResponseCounts: previousDiagnostic?.capturedJsonResponseCounts ?? capturedJsonResponseCounts,
        unknownChunkTypes: previousDiagnostic?.unknownChunkTypes ?? [],
        unknownResourceTypes: previousDiagnostic?.unknownResourceTypes ?? [],
        tokenTables: previousDiagnostic?.tokenTables ?? 0,
        tokenTablesRendered: previousDiagnostic?.tokenTablesRendered ?? 0,
        tokenTablesRequested: previousDiagnostic?.tokenTablesRequested ?? previousDiagnostic?.tokenTables ?? 0,
        tokenContextDiagnostics: previousDiagnostic?.tokenContextDiagnostics ?? [],
        statusTablesRequested: previousDiagnostic?.statusTablesRequested ?? 0,
        statusTablesResolved: previousDiagnostic?.statusTablesResolved ?? 0,
        statusTablesRenderedAsPlaceholder: previousDiagnostic?.statusTablesRenderedAsPlaceholder ?? 0,
        unsupportedStatusTableSchemaCount: previousDiagnostic?.unsupportedStatusTableSchemaCount ?? 0,
        statusTableDiagnostics: previousDiagnostic?.statusTableDiagnostics ?? [],
        missingRequestedTokenSets: previousDiagnostic?.missingRequestedTokenSets ?? [],
        unknownJsonResourceCount: previousDiagnostic?.unknownJsonResourceCount ?? unknownJsonResourceCount,
        rawJsonDebugFilesWritten: previousDiagnostic?.rawJsonDebugFilesWritten ?? 0
      }));
      lastSavedUrl = finalUrl;
      writtenPaths.add(pageToSave.path);
      await writePage(pageToSave, cacheDir);
      emitProgress(true);
    } else {
      const previousDiagnostic = routeDiagnosticsByPath.get(materialPage.path);
      recordRouteDiagnostic(createRouteDiagnostic({
        url: materialPage.url,
        path: materialPage.path,
        sourceUsed: 'failed',
        finalMethod: null,
        directJsonAttempted: previousDiagnostic?.directJsonAttempted ?? jsonFallbackRoutes.has(routeSlugFromPath(materialPage.path)),
        directJsonSucceeded: previousDiagnostic?.directJsonSucceeded ?? false,
        networkJsonAttempted: previousDiagnostic?.networkJsonAttempted ?? true,
        networkJsonSucceeded: previousDiagnostic?.networkJsonSucceeded ?? false,
        domFallbackAttempted: true,
        domFallbackSucceeded: false,
        fallbackReasons: [...(previousDiagnostic?.fallbackReasons ?? []), 'dom-fallback-failed'],
        fallbackSkippedReasons: previousDiagnostic?.fallbackSkippedReasons ?? [],
        capturedJsonResponseCounts: previousDiagnostic?.capturedJsonResponseCounts ?? capturedJsonResponseCounts,
        unknownChunkTypes: previousDiagnostic?.unknownChunkTypes ?? [],
        unknownResourceTypes: previousDiagnostic?.unknownResourceTypes ?? [],
        tokenTables: previousDiagnostic?.tokenTables ?? 0,
        tokenTablesRendered: previousDiagnostic?.tokenTablesRendered ?? 0,
        tokenTablesRequested: previousDiagnostic?.tokenTablesRequested ?? previousDiagnostic?.tokenTables ?? 0,
        tokenContextDiagnostics: previousDiagnostic?.tokenContextDiagnostics ?? [],
        statusTablesRequested: previousDiagnostic?.statusTablesRequested ?? 0,
        statusTablesResolved: previousDiagnostic?.statusTablesResolved ?? 0,
        statusTablesRenderedAsPlaceholder: previousDiagnostic?.statusTablesRenderedAsPlaceholder ?? 0,
        unsupportedStatusTableSchemaCount: previousDiagnostic?.unsupportedStatusTableSchemaCount ?? 0,
        statusTableDiagnostics: previousDiagnostic?.statusTableDiagnostics ?? [],
        missingRequestedTokenSets: previousDiagnostic?.missingRequestedTokenSets ?? [],
        unknownJsonResourceCount: previousDiagnostic?.unknownJsonResourceCount ?? unknownJsonResourceCount,
        rawJsonDebugFilesWritten: previousDiagnostic?.rawJsonDebugFilesWritten ?? 0
      }));
    }

    await assertMaterialRouteUnchanged(page, finalUrl, baseUrl, 'link discovery');
    if (isBlogListingUrl(finalUrl, baseUrl)) {
      const pairs = await extractBlogListingYears(page, baseUrl).catch(() => [] as Array<[string, number]>);
      for (const [postUrl, year] of pairs) blogPostYears.set(postUrl, year);
    }
    const discoveredLinks = await discoverLinks(page, baseUrl);
    if (finalUrl === baseUrl) addDiscoveredPaths(await discoverRenderedNavDocPaths(page, baseUrl), renderedNavPublicDocPaths);
    for (const link of discoveredLinks) enqueue(link);
    emitProgress(true);
  }

  function enqueue(raw: string): void {
    const link = normalizeMaterialCrawlUrl(raw, baseUrl);
    if (!link || seen.has(link) || queued.has(link)) return;
    const linkPathname = new URL(link).pathname;
    const linkPath = linkPathname.replace(/^\/+|\/+$/g, '');
    if (!includeBlog && isBlogPath(linkPathname)) {
      const docPath = `/${linkPath}`;
      policySkippedDocPaths.add(docPath);
      return;
    }
    if (isDsdbCoveredPath(linkPath, jsonExtractedSlugs)) return;
    if (queue.length + seen.size >= maxPages * MAX_DISCOVERED_LINK_FACTOR) return;
    queue.push(link);
    queue.sort(compareMaterialCrawlUrlPriority);
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
