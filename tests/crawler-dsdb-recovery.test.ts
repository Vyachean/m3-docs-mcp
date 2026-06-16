import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  bootstrapCarbonVersionFromBrowser,
  buildSlugOnlyRoutesFromDocPaths,
  extractCarbonVersionFromNetworkUrls
} from '../src/crawler.js';
import { normalizeMaterialUrl } from '../src/crawler-utils.js';

// ────────────────────────────────────────────────────────────────────────────
// Unit tests: pure helper functions
// ────────────────────────────────────────────────────────────────────────────

describe('extractCarbonVersionFromNetworkUrls', () => {
  it('extracts carbonVersion from a /_dsm/content/m3/{version}/ URL', () => {
    expect(extractCarbonVersionFromNetworkUrls([
      'https://m3.material.io/_dsm/content/m3/1.2.3/abc.json'
    ])).toBe('1.2.3');
  });

  it('returns null when no matching URL is present', () => {
    expect(extractCarbonVersionFromNetworkUrls([
      'https://m3.material.io/page-data/components/buttons/page-data.json',
      'https://m3.material.io/_dsm/data/dsdb-m3/1.2.3/TOKEN_TABLE.x.json'
    ])).toBeNull();
  });

  it('returns the first match when multiple URLs match', () => {
    expect(extractCarbonVersionFromNetworkUrls([
      'https://m3.material.io/_dsm/content/m3/1.0.0/first.json',
      'https://m3.material.io/_dsm/content/m3/2.0.0/second.json'
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

  it('canonicalizes /m3/pages/components/buttons to /components/buttons', () => {
    const result = normalizeMaterialUrl('https://m3.material.io/m3/pages/components/buttons', base);
    expect(result).toBe('https://m3.material.io/components/buttons');
  });

  it('canonicalizes /m3/pages/styles/color to /styles/color', () => {
    const result = normalizeMaterialUrl('/m3/pages/styles/color', base);
    expect(result).toBe('https://m3.material.io/styles/color');
  });

  it('does not modify paths that do not start with /m3/pages/', () => {
    const result = normalizeMaterialUrl('/components/buttons', base);
    expect(result).toBe('https://m3.material.io/components/buttons');
  });

  it('does not modify /m3/ paths that are not /m3/pages/', () => {
    const result = normalizeMaterialUrl('/m3/other/path', base);
    expect(result).toBe('https://m3.material.io/m3/other/path');
  });
});

// ────────────────────────────────────────────────────────────────────────────
// Unit tests: bootstrapCarbonVersionFromBrowser
// ────────────────────────────────────────────────────────────────────────────

function makeBrowserContext(responseUrlsByPageUrl: Record<string, string[]>) {
  type RawListener = (r: { url: () => string; ok: () => boolean }) => void;
  const listeners = new Set<RawListener>();

  const makePage = (pageUrl: string) => ({
    goto: vi.fn(async () => {
      const responseUrls = responseUrlsByPageUrl[pageUrl] ?? [];
      for (const rUrl of responseUrls) {
        for (const l of listeners) l({ url: () => rUrl, ok: () => true });
      }
    }),
    on: vi.fn((event: string, listener: RawListener) => {
      if (event === 'response') listeners.add(listener);
    }),
    off: vi.fn((event: string, listener: RawListener) => {
      if (event === 'response') listeners.delete(listener);
    }),
    close: vi.fn(async () => undefined)
  });

  return {
    newPage: vi.fn(async () => makePage(/* filled per-call below */ '')),
    _makePage: makePage,
    _listeners: listeners,
    close: vi.fn(async () => undefined)
  };
}

describe('bootstrapCarbonVersionFromBrowser', () => {
  it('returns carbonVersion when a seed page returns a matching /_dsm/content URL', async () => {
    type RawListener = (r: { url: () => string; ok: () => boolean }) => void;
    const listeners = new Set<RawListener>();
    const page = {
      goto: vi.fn(async () => {
        for (const l of listeners) {
          l({ url: () => 'https://m3.material.io/_dsm/content/m3/9.9.9/page.json', ok: () => true });
        }
      }),
      on: vi.fn((event: string, l: RawListener) => { if (event === 'response') listeners.add(l); }),
      off: vi.fn((event: string, l: RawListener) => { if (event === 'response') listeners.delete(l); }),
      close: vi.fn(async () => undefined)
    };
    const ctx = { newPage: vi.fn(async () => page), close: vi.fn(async () => undefined) } as unknown as Parameters<typeof bootstrapCarbonVersionFromBrowser>[0];

    const result = await bootstrapCarbonVersionFromBrowser(ctx, 'https://m3.material.io', ['/'], undefined);

    expect(result).not.toBeNull();
    expect(result?.carbonVersion).toBe('9.9.9');
    expect(result?.observedUrls).toContain('https://m3.material.io/_dsm/content/m3/9.9.9/page.json');
    expect(page.close).toHaveBeenCalled();
  });

  it('returns null when no seed page returns a matching URL', async () => {
    const page = {
      goto: vi.fn(async () => undefined),
      on: vi.fn(),
      off: vi.fn(),
      close: vi.fn(async () => undefined)
    };
    const ctx = { newPage: vi.fn(async () => page), close: vi.fn(async () => undefined) } as unknown as Parameters<typeof bootstrapCarbonVersionFromBrowser>[0];

    const result = await bootstrapCarbonVersionFromBrowser(ctx, 'https://m3.material.io', ['/seed1', '/seed2'], undefined);

    expect(result).toBeNull();
    expect(page.close).toHaveBeenCalledTimes(2);
  });

  it('closes the page even when goto throws', async () => {
    const page = {
      goto: vi.fn(async () => { throw new Error('nav failed'); }),
      on: vi.fn(),
      off: vi.fn(),
      close: vi.fn(async () => undefined)
    };
    const ctx = { newPage: vi.fn(async () => page), close: vi.fn(async () => undefined) } as unknown as Parameters<typeof bootstrapCarbonVersionFromBrowser>[0];

    const result = await bootstrapCarbonVersionFromBrowser(ctx, 'https://m3.material.io', ['/fail'], undefined);

    expect(result).toBeNull();
    expect(page.close).toHaveBeenCalled();
  });

  it('returns null immediately when signal is already aborted', async () => {
    const ctrl = new AbortController();
    ctrl.abort();
    const ctx = { newPage: vi.fn(), close: vi.fn(async () => undefined) } as unknown as Parameters<typeof bootstrapCarbonVersionFromBrowser>[0];

    const result = await bootstrapCarbonVersionFromBrowser(ctx, 'https://m3.material.io', ['/'], ctrl.signal);

    expect(result).toBeNull();
    expect(ctx.newPage).not.toHaveBeenCalled();
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

describe('DSDB recovery integration', () => {
  beforeEach(async () => {
    cacheDir = await mkdtemp(path.join(tmpdir(), 'm3-docs-dsdb-recovery-test-'));
    // Default: fetch fails (no Angular bundle → no carbonVersion)
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

  it('recovers carbonVersion from browser network when bundle discovery fails', async () => {
    // Arrange: seed page emits a /_dsm/content/m3/ URL
    playwrightMock.networkResponsesByUrl['https://m3.material.io/'] = [
      { url: 'https://m3.material.io/_dsm/content/m3/5.0.0/recovered-page.json', payload: {} }
    ];
    playwrightMock.networkResponsesByUrl['https://m3.material.io'] = [
      { url: 'https://m3.material.io/_dsm/content/m3/5.0.0/recovered-page.json', payload: {} }
    ];

    const index = await crawlMaterialDocs({ cacheDir, maxPages: 2, minPageCount: 1 });

    expect(index.pageCount).toBeGreaterThanOrEqual(1);
    // directJsonAttemptedPageCount > 0 is the key regression guard
    const rawIndex = JSON.parse(await readFile(path.join(cacheDir, 'index.json'), 'utf8')) as { attemptedPageCount: number };
    expect(rawIndex.attemptedPageCount).toBeGreaterThan(0);
  }, 20_000);

  it('completes a browser-only crawl when both bundle and network recovery fail', async () => {
    // Arrange: no network responses match /_dsm/content/m3/
    const index = await crawlMaterialDocs({ cacheDir, maxPages: 2, minPageCount: 1 });

    expect(index.pageCount).toBeGreaterThanOrEqual(1);
    // Should still produce pages via browser crawl
    const rawIndex = JSON.parse(await readFile(path.join(cacheDir, 'index.json'), 'utf8')) as { pageCount: number };
    expect(rawIndex.pageCount).toBeGreaterThanOrEqual(1);
  }, 20_000);

  it('writes intermediate diagnostics with bundleDiscoveryFailed=true when bundle fetch fails', async () => {
    await crawlMaterialDocs({ cacheDir, maxPages: 2, minPageCount: 1 });

    const diagPath = path.join(cacheDir, 'diagnostics', 'latest-update.json');
    const raw = JSON.parse(await readFile(diagPath, 'utf8')) as Record<string, unknown>;
    expect(raw['bundleDiscoveryFailed']).toBe(true);
    expect(raw['promotionDecision']).toBe('promoted');
  }, 20_000);

  it('writes dsdbConfigSource=browser-network in diagnostics when network recovery succeeds', async () => {
    playwrightMock.networkResponsesByUrl['https://m3.material.io/'] = [
      { url: 'https://m3.material.io/_dsm/content/m3/7.0.0/x.json', payload: {} }
    ];
    playwrightMock.networkResponsesByUrl['https://m3.material.io'] = [
      { url: 'https://m3.material.io/_dsm/content/m3/7.0.0/x.json', payload: {} }
    ];

    await crawlMaterialDocs({ cacheDir, maxPages: 2, minPageCount: 1 });

    const diagPath = path.join(cacheDir, 'diagnostics', 'latest-update.json');
    const raw = JSON.parse(await readFile(diagPath, 'utf8')) as Record<string, unknown>;
    expect(raw['dsdbConfigSource']).toBe('browser-network');
    expect(raw['networkRecoverySucceeded']).toBe(true);
    expect(raw['directJsonEnabled']).toBe(true);
  }, 20_000);

  it('writes dsdbConfigSource=null and browserOnlyFallback=true when both paths fail', async () => {
    await crawlMaterialDocs({ cacheDir, maxPages: 2, minPageCount: 1 });

    const diagPath = path.join(cacheDir, 'diagnostics', 'latest-update.json');
    const raw = JSON.parse(await readFile(diagPath, 'utf8')) as Record<string, unknown>;
    expect(raw['bundleDiscoveryFailed']).toBe(true);
    expect(raw['networkRecoveryAttempted']).toBe(true);
    expect(raw['networkRecoverySucceeded']).toBe(false);
    expect(raw['browserOnlyFallback']).toBe(true);
  }, 20_000);
});
