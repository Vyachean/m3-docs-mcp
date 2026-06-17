import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  bootstrapCarbonVersionFromBrowser,
  buildSlugOnlyRoutesFromDocPaths,
  extractCarbonVersionFromNetworkUrls
} from '../src/crawler.js';
import { cacheStatus } from '../src/cache.js';
import { normalizeMaterialPublicDocPath, normalizeMaterialUrl } from '../src/crawler-utils.js';
import type { CrawlProgress } from '../src/types.js';

// ────────────────────────────────────────────────────────────────────────────
// Unit tests: pure helper functions
// ────────────────────────────────────────────────────────────────────────────

describe('extractCarbonVersionFromNetworkUrls', () => {
  it('extracts carbonVersion from a /_dsm/content/m3/{version}/ URL', () => {
    expect(extractCarbonVersionFromNetworkUrls([
      'https://m3.material.io/_dsm/content/m3/1.2.3/abc.json'
    ])).toBe('1.2.3');
  });

  it('extracts carbonVersion from a /_dsm/data/dsdb-m3/{version}/ URL', () => {
    expect(extractCarbonVersionFromNetworkUrls([
      'https://m3.material.io/_dsm/data/dsdb-m3/4.5.6/TOKEN_TABLE.x.json'
    ])).toBe('4.5.6');
  });

  it('returns null when no /_dsm/ version URL is present', () => {
    expect(extractCarbonVersionFromNetworkUrls([
      'https://m3.material.io/page-data/components/buttons/page-data.json',
      'https://m3.material.io/static/angular/main.abc.js'
    ])).toBeNull();
  });

  it('returns the first match when multiple URLs match', () => {
    expect(extractCarbonVersionFromNetworkUrls([
      'https://m3.material.io/_dsm/content/m3/1.0.0/first.json',
      'https://m3.material.io/_dsm/data/dsdb-m3/2.0.0/second.json'
    ])).toBe('1.0.0');
  });

  it('returns null for an empty array', () => {
    expect(extractCarbonVersionFromNetworkUrls([])).toBeNull();
  });
});

describe('buildSlugOnlyRoutesFromDocPaths', () => {
  it('strips leading and trailing slashes from each path', () => {
    const routes = buildSlugOnlyRoutesFromDocPaths(['/components/buttons/', '/styles/color']);
    expect(routes).toEqual([
      { slug: 'components/buttons' },
      { slug: 'styles/color' }
    ]);
  });

  it('deduplicates identical slugs', () => {
    const routes = buildSlugOnlyRoutesFromDocPaths(['/a/b', '/a/b', 'a/b']);
    expect(routes).toHaveLength(1);
    expect(routes[0]?.slug).toBe('a/b');
  });

  it('skips empty paths', () => {
    const routes = buildSlugOnlyRoutesFromDocPaths(['', '/', '/components/buttons']);
    expect(routes).toHaveLength(1);
    expect(routes[0]?.slug).toBe('components/buttons');
  });

  it('returns an empty array for empty input', () => {
    expect(buildSlugOnlyRoutesFromDocPaths([])).toEqual([]);
  });
});

describe('normalizeMaterialUrl - /m3/pages/ alias', () => {
  const base = 'https://m3.material.io';

  it('does not strip /m3/pages/ prefix — preserves the path as-is', () => {
    expect(normalizeMaterialUrl('https://m3.material.io/m3/pages/components/buttons', base))
      .toBe('https://m3.material.io/m3/pages/components/buttons');
  });

  it('preserves /m3/pages/styles/color without modification', () => {
    expect(normalizeMaterialUrl('/m3/pages/styles/color', base))
      .toBe('https://m3.material.io/m3/pages/styles/color');
  });

  it('does not modify paths that do not start with /m3/pages/', () => {
    expect(normalizeMaterialUrl('/components/buttons', base))
      .toBe('https://m3.material.io/components/buttons');
  });

  it('does not modify /m3/ paths that are not /m3/pages/', () => {
    expect(normalizeMaterialUrl('/m3/other/path', base))
      .toBe('https://m3.material.io/m3/other/path');
  });
});

describe('normalizeMaterialPublicDocPath - /m3/pages/ filtering', () => {
  const base = 'https://m3.material.io';

  it('returns null for /m3/pages/app-bars/guidelines to prevent fake public routes', () => {
    expect(normalizeMaterialPublicDocPath('/m3/pages/app-bars/guidelines', base)).toBeNull();
  });

  it('returns null for /m3/pages/components/buttons so it cannot pollute cache keys', () => {
    expect(normalizeMaterialPublicDocPath('/m3/pages/components/buttons', base)).toBeNull();
  });

  it('returns null for /m3/pages/styles/color', () => {
    expect(normalizeMaterialPublicDocPath('/m3/pages/styles/color', base)).toBeNull();
  });

  it('does not filter normal component paths', () => {
    expect(normalizeMaterialPublicDocPath('/components/buttons', base)).toBe('/components/buttons');
  });

  it('does not filter normal style paths', () => {
    expect(normalizeMaterialPublicDocPath('/styles/color', base)).toBe('/styles/color');
  });
});

// ────────────────────────────────────────────────────────────────────────────
// Unit tests: bootstrapCarbonVersionFromBrowser
// ────────────────────────────────────────────────────────────────────────────

function makeMockPage(
  responseUrls: string[] = [],
  opts: { gotoThrows?: boolean } = {}
) {
  type RawListener = (r: { url: () => string; ok: () => boolean }) => void;
  const listeners = new Set<RawListener>();
  return {
    goto: vi.fn(async () => {
      if (opts.gotoThrows) throw new Error('nav failed');
      for (const rUrl of responseUrls) {
        for (const l of listeners) l({ url: () => rUrl, ok: () => true });
      }
    }),
    waitForSelector: vi.fn(async () => undefined),
    on: vi.fn((event: string, l: RawListener) => { if (event === 'response') listeners.add(l); }),
    off: vi.fn((event: string, l: RawListener) => { if (event === 'response') listeners.delete(l); }),
    waitForResponse: vi.fn(async () => ({})),
    close: vi.fn(async () => undefined)
  };
}

describe('bootstrapCarbonVersionFromBrowser', () => {
  it('returns carbonVersion when a seed page returns a /_dsm/content/m3/ URL', async () => {
    const page = makeMockPage(['https://m3.material.io/_dsm/content/m3/9.9.9/page.json']);
    const ctx = { newPage: vi.fn(async () => page), close: vi.fn(async () => undefined) } as unknown as Parameters<typeof bootstrapCarbonVersionFromBrowser>[0];

    const result = await bootstrapCarbonVersionFromBrowser(ctx, 'https://m3.material.io', ['/'], undefined, undefined, 0);

    expect(result?.carbonVersion).toBe('9.9.9');
    expect(result?.observedUrls).toContain('https://m3.material.io/_dsm/content/m3/9.9.9/page.json');
    expect(page.close).toHaveBeenCalled();
  });

  it('returns carbonVersion when a seed page returns a /_dsm/data/dsdb-m3/ URL', async () => {
    const page = makeMockPage(['https://m3.material.io/_dsm/data/dsdb-m3/3.1.4/TOKEN_TABLE.colors.json']);
    const ctx = { newPage: vi.fn(async () => page), close: vi.fn(async () => undefined) } as unknown as Parameters<typeof bootstrapCarbonVersionFromBrowser>[0];

    const result = await bootstrapCarbonVersionFromBrowser(ctx, 'https://m3.material.io', ['/'], undefined, undefined, 0);

    expect(result?.carbonVersion).toBe('3.1.4');
  });

  it('returns null when no seed page returns a matching URL', async () => {
    const page = makeMockPage([]);
    const ctx = { newPage: vi.fn(async () => page), close: vi.fn(async () => undefined) } as unknown as Parameters<typeof bootstrapCarbonVersionFromBrowser>[0];

    const result = await bootstrapCarbonVersionFromBrowser(ctx, 'https://m3.material.io', ['/seed1', '/seed2'], undefined, undefined, 0);

    expect(result).toBeNull();
    expect(page.close).toHaveBeenCalledTimes(2);
  });

  it('does not return early when only /page-data/ arrives — returns null and tries next seed', async () => {
    const page = makeMockPage(['https://m3.material.io/page-data/components/buttons/page-data.json']);
    const ctx = { newPage: vi.fn(async () => page) } as unknown as Parameters<typeof bootstrapCarbonVersionFromBrowser>[0];

    const result = await bootstrapCarbonVersionFromBrowser(ctx, 'https://m3.material.io', ['/'], undefined, undefined, 0);

    expect(result).toBeNull();
  });

  it('succeeds when a /_dsm URL arrives during the drain window after /page-data', async () => {
    vi.useFakeTimers();
    type RawListener = (r: { url: () => string; ok: () => boolean }) => void;
    const listeners = new Set<RawListener>();

    const mockPage = {
      goto: vi.fn(async () => {
        for (const l of listeners) l({ url: () => 'https://m3.material.io/page-data/components/buttons/page-data.json', ok: () => true });
        setTimeout(() => {
          for (const l of listeners) l({ url: () => 'https://m3.material.io/_dsm/data/dsdb-m3/4.2.0/TOKEN_TABLE.colors.json', ok: () => true });
        }, 500);
      }),
      waitForSelector: vi.fn(async () => undefined),
      on: vi.fn((event: string, l: RawListener) => { if (event === 'response') listeners.add(l); }),
      off: vi.fn((event: string, l: RawListener) => { if (event === 'response') listeners.delete(l); }),
      close: vi.fn(async () => undefined)
    };

    const ctx = { newPage: vi.fn(async () => mockPage) } as unknown as Parameters<typeof bootstrapCarbonVersionFromBrowser>[0];
    const resultPromise = bootstrapCarbonVersionFromBrowser(ctx, 'https://m3.material.io', ['/'], undefined, undefined, 2_000);
    await vi.runAllTimersAsync();
    const result = await resultPromise;

    vi.useRealTimers();

    expect(result?.carbonVersion).toBe('4.2.0');
    expect(result?.observedUrls).toContain('https://m3.material.io/page-data/components/buttons/page-data.json');
    expect(result?.observedUrls).toContain('https://m3.material.io/_dsm/data/dsdb-m3/4.2.0/TOKEN_TABLE.colors.json');
  });

  it('closes the page even when goto throws', async () => {
    const page = makeMockPage([], { gotoThrows: true });
    const ctx = { newPage: vi.fn(async () => page), close: vi.fn(async () => undefined) } as unknown as Parameters<typeof bootstrapCarbonVersionFromBrowser>[0];

    const result = await bootstrapCarbonVersionFromBrowser(ctx, 'https://m3.material.io', ['/fail'], undefined, undefined, 0);

    expect(result).toBeNull();
    expect(page.close).toHaveBeenCalled();
  });

  it('returns null immediately when signal is already aborted', async () => {
    const ctrl = new AbortController();
    ctrl.abort();
    const ctx = { newPage: vi.fn(), close: vi.fn(async () => undefined) } as unknown as Parameters<typeof bootstrapCarbonVersionFromBrowser>[0];

    const result = await bootstrapCarbonVersionFromBrowser(ctx, 'https://m3.material.io', ['/'], ctrl.signal, undefined, 0);

    expect(result).toBeNull();
    expect(ctx.newPage).not.toHaveBeenCalled();
  });

  it('calls waitForSelector on each seed page', async () => {
    const page = makeMockPage(['https://m3.material.io/_dsm/content/m3/1.0.0/x.json']);
    const ctx = { newPage: vi.fn(async () => page), close: vi.fn(async () => undefined) } as unknown as Parameters<typeof bootstrapCarbonVersionFromBrowser>[0];

    await bootstrapCarbonVersionFromBrowser(ctx, 'https://m3.material.io', ['/'], undefined, undefined, 0);

    expect(page.waitForSelector).toHaveBeenCalledTimes(1);
  });
});

// ────────────────────────────────────────────────────────────────────────────
// Integration tests: DSDB recovery in crawlMaterialDocs
// ────────────────────────────────────────────────────────────────────────────

const playwrightMock = vi.hoisted(() => {
  let currentUrl = '';
  type RawResponse = { url: () => string; ok: () => boolean; json: () => Promise<unknown> };
  const responseListeners = new Set<(response: RawResponse) => void | Promise<void>>();

  const pagesByUrl: Record<string, { html: string; title: string; headings: string[]; links: string[]; finalUrl?: string }> = {
    'https://m3.material.io': {
      html: '<h1>Material 3</h1><p>Material 3 documentation landing page with enough text for crawler validation.</p>',
      title: 'Material 3',
      headings: ['Material 3'],
      links: []
    },
    'https://m3.material.io/components/buttons/overview': {
      html: '<h1>Buttons</h1><p>Buttons prompt most actions in a UI with enough body text for crawler validation.</p>',
      title: 'Buttons',
      headings: ['Buttons'],
      links: [],
      finalUrl: 'https://m3.material.io/components/buttons/overview'
    }
  };
  const networkResponsesByUrl: Record<string, Array<{ url: string; payload: unknown }>> = {};

  const htmlText = (html: string) => html.replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim();
  const normalize = (v: string) => v.toLowerCase().replace(/&/g, ' and ').replace(/[^a-z0-9]+/g, ' ').replace(/\s+/g, ' ').trim();

  const page = {
    goto: vi.fn(async (url: string) => {
      currentUrl = url;
      const responses = networkResponsesByUrl[url] ?? [];
      for (const entry of responses) {
        for (const listener of responseListeners) {
          await listener({ url: () => entry.url, ok: () => true, json: async () => entry.payload });
        }
      }
    }),
    url: vi.fn(() => pagesByUrl[currentUrl]?.finalUrl ?? currentUrl),
    on: vi.fn((event: string, listener: (r: RawResponse) => void | Promise<void>) => {
      if (event === 'response') responseListeners.add(listener);
    }),
    off: vi.fn((event: string, listener: (r: RawResponse) => void | Promise<void>) => {
      if (event === 'response') responseListeners.delete(listener);
    }),
    waitForSelector: vi.fn(async () => undefined),
    waitForResponse: vi.fn(async () => ({})),
    waitForFunction: vi.fn(async (_fn: unknown, arg?: { minPageTextLength?: number; notFoundTitlePatterns?: unknown[]; notFoundBodyPatterns?: unknown[] }) => {
      const current = pagesByUrl[currentUrl];
      const minPageTextLength = arg?.minPageTextLength ?? 0;
      if (!current) throw new Error(`condition did not match for ${currentUrl}`);
      if (htmlText(current.html).length < minPageTextLength || !current.title) {
        throw new Error(`condition did not match for ${currentUrl}`);
      }
    }),
    close: vi.fn(async () => undefined),
    evaluate: vi.fn(async (fn: (...args: unknown[]) => unknown, arg?: unknown) => {
      const source = fn.toString();
      if (source.includes('details:not([open])')) return undefined;
      if (source.includes('querySelectorAll') && source.includes('a[href]')) return pagesByUrl[currentUrl]?.links ?? [];
      if (source.includes('expectedComponentSlug') || source.includes('contentMatches')) {
        const current = pagesByUrl[currentUrl];
        if (!current) return null;
        const rawTitle = current.title;
        const rawText = htmlText(current.html);
        const title = normalize(rawTitle);
        const text = normalize(`${rawTitle} ${rawText}`);
        const pathname = new URL(current.finalUrl ?? currentUrl).pathname.replace(/^\/+|\/+$/g, '');
        const componentSlug = (arg as { componentSlug?: string } | undefined)?.componentSlug;
        if (!componentSlug) return { title: rawTitle, text: rawText, pathname, renderedNotFound: false, expectedComponentSlug: null, pathMatches: true, contentMatches: true };
        const componentWords = normalize(componentSlug.replace(/-/g, ' ')).split(' ').filter((w) => w.length > 1);
        const pathMatches = pathname === `components/${componentSlug}` || pathname.startsWith(`components/${componentSlug}/`);
        return { title: rawTitle, text: rawText, pathname, renderedNotFound: false, expectedComponentSlug: componentSlug, pathMatches, contentMatches: title !== 'components' && componentWords.every((w) => text.includes(w)) };
      }
      if (source.includes('window.location.href')) {
        const current = pagesByUrl[currentUrl];
        return { url: current?.finalUrl ?? currentUrl, title: current?.title ?? '', text: current ? htmlText(current.html) : '' };
      }
      if (source.includes('clone.innerHTML')) {
        const current = pagesByUrl[currentUrl];
        return current ? { html: current.html, title: current.title, headings: current.headings } : { html: '', title: '', headings: [] };
      }
      if (source.includes('blogListingCurrentYear')) return [];
      return undefined;
    })
  };

  const browser = {
    newContext: vi.fn(async () => ({ newPage: vi.fn(async () => page), close: vi.fn(async () => undefined) })),
    close: vi.fn(async () => undefined)
  };

  return {
    chromium: { launch: vi.fn(async () => browser) },
    browser,
    page,
    pagesByUrl,
    networkResponsesByUrl,
    responseListeners
  };
});

vi.mock('playwright', () => ({ chromium: playwrightMock.chromium }));

const { crawlMaterialDocs } = await import('../src/crawler.js');

let cacheDir: string;

function makeFetchWithSitemap(sitemapContent: string) {
  return vi.fn(async (url: string | URL) => {
    if (String(url).includes('/sitemap')) {
      return { ok: true, text: async () => sitemapContent, status: 200 };
    }
    return { ok: false, status: 404, text: async () => '' };
  });
}

describe('DSDB recovery integration', () => {
  beforeEach(async () => {
    cacheDir = await mkdtemp(path.join(tmpdir(), 'm3-docs-dsdb-recovery-test-'));
    vi.stubGlobal('fetch', vi.fn(async () => ({ ok: false, status: 404, text: async () => '' })));
    playwrightMock.chromium.launch.mockClear();
    playwrightMock.browser.close.mockClear();
    playwrightMock.page.goto.mockClear();
    playwrightMock.page.url.mockClear();
    playwrightMock.page.on.mockClear();
    playwrightMock.page.off.mockClear();
    playwrightMock.page.close.mockClear();
    playwrightMock.page.evaluate.mockClear();
    playwrightMock.page.waitForSelector.mockClear();
    playwrightMock.page.waitForFunction.mockClear();
    playwrightMock.page.waitForResponse.mockClear();
    for (const key of Object.keys(playwrightMock.networkResponsesByUrl)) delete playwrightMock.networkResponsesByUrl[key];
    playwrightMock.responseListeners.clear();
    playwrightMock.pagesByUrl['https://m3.material.io'].links = [];
    playwrightMock.pagesByUrl['https://m3.material.io/components/buttons/overview'] = {
      html: '<h1>Buttons</h1><p>Buttons prompt most actions in a UI with enough body text for crawler validation.</p>',
      title: 'Buttons',
      headings: ['Buttons'],
      links: [],
      finalUrl: 'https://m3.material.io/components/buttons/overview'
    };
  });

  afterEach(async () => {
    vi.unstubAllGlobals();
    await rm(cacheDir, { recursive: true, force: true });
  });

  it('produces phase=direct-json and directJsonAttemptedPageCount > 0 after network recovery succeeds', async () => {
    // Sitemap populates discoveredPublicDocPaths so runDirectJsonBatch has routes to attempt
    vi.stubGlobal('fetch', makeFetchWithSitemap('<urlset><url><loc>https://m3.material.io/components/buttons</loc></url></urlset>'));
    // Seed page '/' emits a /_dsm/content/m3/ URL during browser navigation
    playwrightMock.networkResponsesByUrl['https://m3.material.io/'] = [
      { url: 'https://m3.material.io/_dsm/content/m3/5.0.0/recovered-page.json', payload: {} }
    ];
    playwrightMock.networkResponsesByUrl['https://m3.material.io'] = [
      { url: 'https://m3.material.io/_dsm/content/m3/5.0.0/recovered-page.json', payload: {} }
    ];

    const phases: string[] = [];
    const index = await crawlMaterialDocs({
      cacheDir,
      allowBrowserFallback: true,
      maxPages: 3,
      minPageCount: 1,
      force: true,
      onProgress: (p: CrawlProgress) => { phases.push(p.phase); }
    });

    expect(index.pageCount).toBeGreaterThanOrEqual(1);
    // fetch-page-data phase must have been entered when recovery succeeded
    expect(phases).toContain('fetch-page-data');

    const diagPath = path.join(cacheDir, 'diagnostics', 'latest-update.json');
    const raw = JSON.parse(await readFile(diagPath, 'utf8')) as Record<string, unknown>;
    expect(raw['directJsonAttemptedPageCount']).toBeGreaterThan(0);
    expect(raw['dsdbConfigSource']).toBe('browser-network');
    expect(raw['directJsonEnabled']).toBe(true);
    expect(raw['directJsonDisabledReason']).toBeNull();
  }, 20_000);

  it('extracts carbonVersion from /_dsm/data/dsdb-m3/ URLs during browser-network recovery', async () => {
    // Use the dsdb-m3 DATA path instead of the content path
    playwrightMock.networkResponsesByUrl['https://m3.material.io/'] = [
      { url: 'https://m3.material.io/_dsm/data/dsdb-m3/6.0.0/TOKEN_TABLE.colors.json', payload: {} }
    ];
    playwrightMock.networkResponsesByUrl['https://m3.material.io'] = [
      { url: 'https://m3.material.io/_dsm/data/dsdb-m3/6.0.0/TOKEN_TABLE.colors.json', payload: {} }
    ];

    await crawlMaterialDocs({ cacheDir, allowBrowserFallback: true, maxPages: 2, minPageCount: 1, force: true });

    const diagPath = path.join(cacheDir, 'diagnostics', 'latest-update.json');
    const raw = JSON.parse(await readFile(diagPath, 'utf8')) as Record<string, unknown>;
    expect(raw['dsdbConfigSource']).toBe('browser-network');
    expect(raw['networkRecoverySucceeded']).toBe(true);
  }, 20_000);

  it('completes a browser-only crawl when both bundle and network recovery fail', async () => {
    const index = await crawlMaterialDocs({ cacheDir, allowBrowserFallback: true, maxPages: 2, minPageCount: 1, force: true });

    expect(index.pageCount).toBeGreaterThanOrEqual(1);
    const rawIndex = JSON.parse(await readFile(path.join(cacheDir, 'index.json'), 'utf8')) as { pageCount: number };
    expect(rawIndex.pageCount).toBeGreaterThanOrEqual(1);
  }, 20_000);

  it('writes bundleDiscoveryFailed=true and promotionDecision=promoted when bundle fails but crawl completes', async () => {
    await crawlMaterialDocs({ cacheDir, allowBrowserFallback: true, maxPages: 2, minPageCount: 1, force: true });

    const raw = JSON.parse(await readFile(path.join(cacheDir, 'diagnostics', 'latest-update.json'), 'utf8')) as Record<string, unknown>;
    expect(raw['bundleDiscoveryFailed']).toBe(true);
    expect(raw['promotionDecision']).toBe('promoted');
  }, 20_000);

  it('writes dsdbConfigSource=browser-network when network recovery succeeds', async () => {
    playwrightMock.networkResponsesByUrl['https://m3.material.io/'] = [
      { url: 'https://m3.material.io/_dsm/content/m3/7.0.0/x.json', payload: {} }
    ];
    playwrightMock.networkResponsesByUrl['https://m3.material.io'] = [
      { url: 'https://m3.material.io/_dsm/content/m3/7.0.0/x.json', payload: {} }
    ];

    await crawlMaterialDocs({ cacheDir, allowBrowserFallback: true, maxPages: 2, minPageCount: 1, force: true });

    const raw = JSON.parse(await readFile(path.join(cacheDir, 'diagnostics', 'latest-update.json'), 'utf8')) as Record<string, unknown>;
    expect(raw['dsdbConfigSource']).toBe('browser-network');
    expect(raw['networkRecoverySucceeded']).toBe(true);
    expect(raw['directJsonEnabled']).toBe(true);
  }, 20_000);

  it('writes browserOnlyFallback=true and networkRecoveryFailureReason when both bundle and network recovery fail', async () => {
    await crawlMaterialDocs({ cacheDir, allowBrowserFallback: true, maxPages: 2, minPageCount: 1, force: true });

    const raw = JSON.parse(await readFile(path.join(cacheDir, 'diagnostics', 'latest-update.json'), 'utf8')) as Record<string, unknown>;
    expect(raw['bundleDiscoveryFailed']).toBe(true);
    expect(raw['networkRecoveryAttempted']).toBe(true);
    expect(raw['networkRecoverySucceeded']).toBe(false);
    expect(raw['browserOnlyFallback']).toBe(true);
    expect(typeof raw['networkRecoveryFailureReason']).toBe('string');
    expect(raw['networkRecoveryFailureReason']).toBeTruthy();
  }, 20_000);

  it('clears directJsonDisabledReason after successful network recovery', async () => {
    playwrightMock.networkResponsesByUrl['https://m3.material.io/'] = [
      { url: 'https://m3.material.io/_dsm/content/m3/8.0.0/x.json', payload: {} }
    ];
    playwrightMock.networkResponsesByUrl['https://m3.material.io'] = [
      { url: 'https://m3.material.io/_dsm/content/m3/8.0.0/x.json', payload: {} }
    ];

    await crawlMaterialDocs({ cacheDir, allowBrowserFallback: true, maxPages: 2, minPageCount: 1, force: true });

    const raw = JSON.parse(await readFile(path.join(cacheDir, 'diagnostics', 'latest-update.json'), 'utf8')) as Record<string, unknown>;
    expect(raw['directJsonDisabledReason']).toBeNull();
  }, 20_000);

  it('exposes networkRecoveryFailureReason in cacheStatus after failed recovery', async () => {
    // Write a diagnostics file simulating a failed network recovery
    const diagDir = path.join(cacheDir, 'diagnostics');
    await mkdir(diagDir, { recursive: true });
    await writeFile(path.join(diagDir, 'latest-update.json'), JSON.stringify({
      bundleDiscoveryFailed: true,
      networkRecoveryAttempted: true,
      networkRecoverySucceeded: false,
      networkRecoveryFailureReason: 'no-dsdb-urls-captured',
      directJsonEnabled: false,
      browserOnlyFallback: true,
      directJsonDisabledReason: 'no-dsdb-urls-captured'
    }));

    const status = await cacheStatus(cacheDir);
    expect(status.networkRecoveryFailureReason).toBe('no-dsdb-urls-captured');
    expect(status.browserOnlyFallback).toBe(true);
    expect(status.bundleDiscoveryFailed).toBe(true);
    expect(status.networkRecoveryAttempted).toBe(true);
    expect(status.networkRecoverySucceeded).toBe(false);
  });

  it('does not expose networkRecoveryFailureReason in cacheStatus when recovery succeeds', async () => {
    const diagDir = path.join(cacheDir, 'diagnostics');
    await mkdir(diagDir, { recursive: true });
    await writeFile(path.join(diagDir, 'latest-update.json'), JSON.stringify({
      bundleDiscoveryFailed: true,
      networkRecoveryAttempted: true,
      networkRecoverySucceeded: true,
      directJsonEnabled: true,
      dsdbConfigSource: 'browser-network',
      browserOnlyFallback: false
    }));

    const status = await cacheStatus(cacheDir);
    expect(status.networkRecoveryFailureReason).toBeUndefined();
    expect(status.directJsonEnabled).toBe(true);
    expect(status.dsdbConfigSource).toBe('browser-network');
    expect(status.browserOnlyFallback).toBe(false);
  });
});
