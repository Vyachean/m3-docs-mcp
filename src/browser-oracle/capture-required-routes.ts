import type { Browser, BrowserContext, Page, Response } from 'playwright';
import { launchChromium } from '../crawler.js';
import {
  RequiredRouteCaptureSchema,
  RequiredRoutesCaptureReportSchema,
  REQUIRED_BROWSER_ORACLE_ROUTES,
  type CapturedDomSnapshot,
  type CapturedNetworkResource,
  type CapturedNetworkResourceKind,
  type RequiredRouteCapture,
  type RequiredRoutesCaptureReport,
} from './browser-oracle-types.js';

/**
 * Live-browser capture of the fixed REQUIRED_BROWSER_ORACLE_ROUTES set, for cross-checking the
 * raw snapshot + structured graph (see compare-capture-to-snapshot.ts). This is NOT part of the
 * primary crawl path — crawler.ts's direct-JSON extraction and (legacy) DOM fallback are
 * untouched. The capture function below depends only on an injected Playwright-shaped
 * `BrowserContext` (`captureRequiredRoutesFromContext`), so tests can supply a minimal fake
 * context/page without launching a real browser. `captureRequiredRoutes` is the thin live-browser
 * wrapper: it owns `launchChromium`/`browser.newContext`/`browser.close` and delegates everything
 * else to `captureRequiredRoutesFromContext`.
 */

// ── Narrow Playwright surface this module actually calls ───────────────────────
//
// Declared structurally (not `import type { Page }` everywhere) so a minimal fake satisfying just
// these methods can stand in for a real Playwright Page/BrowserContext in tests, per AGENTS.md's
// "no `as any`" rule — the fake object must actually implement this shape, not be cast into it.

export type OracleResponseLike = {
  url: () => string;
  ok: () => boolean;
  status: () => number;
  json: () => Promise<unknown>;
};

export type OracleLocatorLike = {
  allTextContents: () => Promise<string[]>;
};

export type OraclePageLike = {
  goto: (url: string, options?: { waitUntil?: 'domcontentloaded'; timeout?: number }) => Promise<unknown>;
  url: () => string;
  on: (event: 'response', listener: (response: OracleResponseLike) => void | Promise<void>) => unknown;
  off: (event: 'response', listener: (response: OracleResponseLike) => void | Promise<void>) => unknown;
  locator: (selector: string) => OracleLocatorLike;
  waitForTimeout?: (ms: number) => Promise<void>;
  close: () => Promise<void>;
};

export type OracleBrowserContextLike = {
  newPage: () => Promise<OraclePageLike>;
};

/** Playwright's real `Response`/`Page`/`BrowserContext` already satisfy OracleResponseLike /
 *  OraclePageLike / OracleBrowserContextLike structurally — this just documents/enforces that at
 *  the call sites below without introducing an `as` cast on captured data. */
function toOraclePage(page: Page): OraclePageLike {
  return {
    goto: (url, options) => page.goto(url, options),
    url: () => page.url(),
    on: (event, listener) => page.on(event, (response: Response) => listener(response)),
    off: (event, listener) => page.off(event, (response: Response) => listener(response)),
    locator: (selector) => page.locator(selector),
    waitForTimeout: (ms) => page.waitForTimeout(ms),
    close: () => page.close(),
  };
}

function toOracleBrowserContext(context: BrowserContext): OracleBrowserContextLike {
  return {
    newPage: async () => toOraclePage(await context.newPage()),
  };
}

function classifyNetworkResourceKind(pathname: string): CapturedNetworkResourceKind | null {
  if (/\/page-data\/.+\.json$/i.test(pathname)) return 'page-data';
  if (/\/_dsm\/content\//i.test(pathname)) return 'dsm-content';
  if (/\/_dsm\/data\//i.test(pathname)) return 'dsm-data';
  if (/TOKEN_TABLE\.[^/]+\.json$/i.test(pathname)) return 'token-table';
  if (/STATUS_TABLE/i.test(pathname)) return 'status-table';
  if (pathname.endsWith('.json')) return 'other-json';
  return null;
}

function resourceIdFromUrl(url: string): string {
  try {
    return new URL(url).pathname;
  } catch {
    return url;
  }
}

/** Builds a response listener that records relevant JSON network resources for one route capture
 *  into the given mutable array. Mirrors json-extraction/capture-network-json.ts's relevance
 *  filter (page-data / _dsm/content / _dsm/data / token-table / status-table / *.json), reusing
 *  the same network-capture intent without importing its page-bundle-building machinery, which is
 *  specific to the crawler's content-page selection and not needed here. */
function createOracleResponseListener(
  resources: CapturedNetworkResource[]
): (response: OracleResponseLike) => void {
  const seen = new Set<string>();
  return (response: OracleResponseLike) => {
    const url = response.url();
    const pathname = resourceIdFromUrl(url);
    const kind = classifyNetworkResourceKind(pathname);
    if (!kind) return;
    if (seen.has(url)) return;
    seen.add(url);
    resources.push({
      resourceId: pathname,
      url,
      kind,
      httpStatus: typeof response.status === 'function' ? response.status() : null,
    });
  };
}

/** Best-effort heading scrape: h1-h4 text content within the main content region, in document
 *  order, deduplicated. Limits: relies on the live page rendering its headings into the DOM by
 *  the time this runs (no extra wait beyond navigation + a short settle); headings hidden behind
 *  unexpanded `<details>`/collapsed sections will not be captured (this oracle does not attempt
 *  the same expand-everything DOM manipulation crawler.ts's legacy fallback path performs, to
 *  keep this a lightweight read-only validation probe). */
async function scrapeHeadings(page: OraclePageLike): Promise<string[]> {
  const texts = await page.locator('main h1, main h2, main h3, main h4, [role="main"] h1, [role="main"] h2, [role="main"] h3, [role="main"] h4').allTextContents();
  const seen = new Set<string>();
  const headings: string[] = [];
  for (const raw of texts) {
    const trimmed = raw.replace(/\s+/g, ' ').trim();
    if (!trimmed || seen.has(trimmed)) continue;
    seen.add(trimmed);
    headings.push(trimmed);
  }
  return headings;
}

/** Best-effort visible token/status table label scrape. Limits (documented, not engineered
 *  around): this does not parse table structure (rows/columns/values) — it only scrapes the
 *  leading cell text of each table-like row, which is normally the token/state name. It is
 *  intended only to answer "did the browser show a table whose label the graph never resolved",
 *  not to extract values; value-level data should come from the captured network JSON instead. */
async function scrapeVisibleTableLabels(page: OraclePageLike): Promise<string[]> {
  const texts = await page.locator('table tr > :first-child, [role="table"] [role="row"] > :first-child, [role="rowheader"]').allTextContents();
  const seen = new Set<string>();
  const labels: string[] = [];
  for (const raw of texts) {
    const trimmed = raw.replace(/\s+/g, ' ').trim();
    if (!trimmed || seen.has(trimmed)) continue;
    seen.add(trimmed);
    labels.push(trimmed);
  }
  return labels;
}

async function captureOneRoute(
  context: OracleBrowserContextLike,
  baseUrl: string,
  route: string
): Promise<RequiredRouteCapture> {
  const requestedUrl = new URL(route.replace(/^\/+/, ''), `${baseUrl.replace(/\/+$/, '')}/`).toString();
  const resources: CapturedNetworkResource[] = [];
  const page = await context.newPage();
  const listener = createOracleResponseListener(resources);
  page.on('response', listener);

  let finalUrl: string | null = null;
  let navigationError: string | null = null;
  let dom: CapturedDomSnapshot | null = null;

  try {
    await page.goto(requestedUrl, { waitUntil: 'domcontentloaded', timeout: 45000 });
    if (page.waitForTimeout) await page.waitForTimeout(250);
    finalUrl = page.url();
    const [headings, visibleTableLabels] = await Promise.all([
      scrapeHeadings(page),
      scrapeVisibleTableLabels(page),
    ]);
    dom = { headings, visibleTableLabels };
  } catch (error) {
    navigationError = error instanceof Error ? error.message : String(error);
  } finally {
    page.off('response', listener);
    await page.close().catch(() => undefined);
  }

  const capture: RequiredRouteCapture = {
    route,
    requestedUrl,
    finalUrl,
    navigationError,
    networkResources: resources,
    dom,
  };

  const parsed = RequiredRouteCaptureSchema.safeParse(capture);
  if (!parsed.success) {
    throw new Error(`Failed to build a valid required-route capture for ${route}: ${parsed.error.message}`);
  }
  return parsed.data;
}

export type CaptureRequiredRoutesOptions = {
  baseUrl?: string;
  routes?: readonly string[];
};

/**
 * Captures network JSON + DOM headings/table labels for each required route using an
 * already-created Playwright-shaped `BrowserContext`. Pure with respect to browser lifecycle: the
 * caller owns launching/closing the browser and context. This is the function unit tests exercise
 * against a fake context (see tests/browser-oracle-capture.test.ts).
 */
export async function captureRequiredRoutesFromContext(
  context: OracleBrowserContextLike,
  options: CaptureRequiredRoutesOptions = {}
): Promise<RequiredRoutesCaptureReport> {
  const baseUrl = options.baseUrl ?? 'https://m3.material.io';
  const routes = options.routes ?? REQUIRED_BROWSER_ORACLE_ROUTES;

  const routeCaptures: RequiredRouteCapture[] = [];
  for (const route of routes) {
    routeCaptures.push(await captureOneRoute(context, baseUrl, route));
  }

  const report: RequiredRoutesCaptureReport = {
    schemaVersion: 1,
    generatedAt: new Date().toISOString(),
    baseUrl,
    routes: routeCaptures,
  };

  const parsed = RequiredRoutesCaptureReportSchema.safeParse(report);
  if (!parsed.success) {
    throw new Error(`Failed to build a valid required-routes capture report: ${parsed.error.message}`);
  }
  return parsed.data;
}

export type CaptureRequiredRoutesLiveOptions = CaptureRequiredRoutesOptions & {
  headless?: boolean;
};

/**
 * Thin live-browser wrapper around captureRequiredRoutesFromContext: launches a real headless
 * Chromium browser via crawler.ts's launchChromium, opens one BrowserContext, runs the capture,
 * and always closes the browser afterward. Not exercised by the unit test suite (a real browser
 * launch against the live site is out of scope for unit tests, per the dispatch); this is the
 * function a future live verification script (stage 8 / verify-full-cache-refresh.mjs) would
 * call.
 */
export async function captureRequiredRoutes(
  options: CaptureRequiredRoutesLiveOptions = {}
): Promise<RequiredRoutesCaptureReport> {
  let browser: Browser | null = null;
  try {
    browser = await launchChromium(options.headless ?? true);
    const context = await browser.newContext({ viewport: { width: 1440, height: 1400 } });
    try {
      return await captureRequiredRoutesFromContext(toOracleBrowserContext(context), options);
    } finally {
      await context.close().catch(() => undefined);
    }
  } finally {
    if (browser) await browser.close().catch(() => undefined);
  }
}
