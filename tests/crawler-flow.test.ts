import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { indexPath, pagesDir, writePage, writeIndex } from '../src/cache.js';
import type { MaterialIndex, MaterialPage } from '../src/types.js';

/** Builds a minimal site_meta.js body declaring the given paths as public routes. */
function siteMetaJsText(paths: string[]): string {
  const routes: Record<string, { public: true }> = {};
  for (const p of paths) routes[`/${p.replace(/^\/+/, '')}`] = { public: true };
  return `window.site_meta = ${JSON.stringify({ routes })};`;
}

const playwrightMock = vi.hoisted(() => {
  let currentUrl = '';
  const responseListeners = new Set<(response: { url: () => string; ok: () => boolean; json: () => Promise<unknown> }) => void | Promise<void>>();
  const pagesByUrl: Record<string, { html: string; title: string; headings: string[]; links: string[]; finalUrl?: string; routeAfterExpansion?: string }> = {
    'https://m3.material.io': {
      html: '<h1>Material 3</h1><p>Material 3 documentation landing page with enough text for crawler validation and indexing.</p>',
      title: 'Material 3',
      headings: ['Material 3'],
      links: [
        'https://m3.material.io/components/dialogs?tab=usage#actions',
        'https://example.com/external',
        'https://m3.material.io/assets/logo.svg'
      ]
    },
    'https://m3.material.io/components/dialogs/overview': {
      html: '<h1>Dialogs</h1><p>Dialogs provide important prompts and decisions with enough body text for crawler validation.</p><h2>Usage</h2><p>Use dialogs for focused tasks.</p>',
      title: 'Dialogs',
      headings: ['Dialogs', 'Usage'],
      links: [],
      finalUrl: 'https://m3.material.io/components/dialogs/overview'
    }
  };
  const networkResponsesByUrl: Record<string, Array<{ url: string; payload: unknown }>> = {};

  const htmlText = (html: string) => html.replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim();
  const normalize = (value: string) => value.toLowerCase().replace(/&/g, ' and ').replace(/[^a-z0-9]+/g, ' ').replace(/\s+/g, ' ').trim();
  const readMaterialContentState = (
    componentSlug: string | null | undefined,
    notFoundTitlePatterns: Array<{ source: string; flags: string }> = [],
    notFoundBodyPatterns: Array<{ source: string; flags: string }> = []
  ) => {
    const current = pagesByUrl[currentUrl];
    if (!current) return null;

    const rawTitle = current.title;
    const rawText = htmlText(current.html);
    const title = normalize(rawTitle);
    const text = normalize(`${current.title} ${rawText}`);
    const pathname = new URL(current.finalUrl ?? currentUrl).pathname.replace(/^\/+|\/+$/g, '');
    const matchesAnyPattern = (value: string, patterns: Array<{ source: string; flags: string }>) =>
      patterns.some((pattern) => new RegExp(pattern.source, pattern.flags).test(value));
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

    const componentWords = normalize(componentSlug.replace(/-/g, ' ')).split(' ').filter((word) => word.length > 1);
    const pathMatches = pathname === `components/${componentSlug}` || pathname === `components/${componentSlug}/overview` || pathname.startsWith(`components/${componentSlug}/`);
    return {
      title: rawTitle,
      text: rawText,
      pathname,
      renderedNotFound,
      expectedComponentSlug: componentSlug,
      pathMatches,
      contentMatches: title !== 'components' && !renderedNotFound && componentWords.every((word) => text.includes(word))
    };
  };

  const page = {
    goto: vi.fn(async (url: string) => {
      currentUrl = url;
      const responses = networkResponsesByUrl[url] ?? networkResponsesByUrl[pagesByUrl[url]?.finalUrl ?? ''] ?? [];
      for (const entry of responses) {
        for (const listener of responseListeners) {
          await listener({
            url: () => entry.url,
            ok: () => true,
            json: async () => entry.payload
          });
        }
      }
    }),
    url: vi.fn(() => pagesByUrl[currentUrl]?.finalUrl ?? currentUrl),
    on: vi.fn((event: string, listener: (response: { url: () => string; ok: () => boolean; json: () => Promise<unknown> }) => void | Promise<void>) => {
      if (event === 'response') responseListeners.add(listener);
    }),
    off: vi.fn((event: string, listener: (response: { url: () => string; ok: () => boolean; json: () => Promise<unknown> }) => void | Promise<void>) => {
      if (event === 'response') responseListeners.delete(listener);
    }),
    waitForSelector: vi.fn(async () => undefined),
    waitForFunction: vi.fn(async (_fn: unknown, arg?: {
      minPageTextLength?: number;
      notFoundTitlePatterns?: Array<{ source: string; flags: string }>;
      notFoundBodyPatterns?: Array<{ source: string; flags: string }>;
    }) => {
      const current = pagesByUrl[currentUrl];
      const minPageTextLength = arg?.minPageTextLength ?? 0;
      if (!current) throw new Error(`condition did not match for ${currentUrl}`);
      const state = readMaterialContentState(null, arg?.notFoundTitlePatterns, arg?.notFoundBodyPatterns);
      if (!state) throw new Error(`condition did not match for ${currentUrl}`);
      if (!state.renderedNotFound && (htmlText(current.html).length < minPageTextLength || !current.title)) {
        throw new Error(`condition did not match for ${currentUrl}`);
      }
    }),
    close: vi.fn(async () => undefined),
    evaluate: vi.fn(async (fn: (...args: any[]) => unknown, arg?: any) => {
      const source = fn.toString();
      if (source.includes('details:not([open])')) {
        const current = pagesByUrl[currentUrl];
        if (current?.routeAfterExpansion) currentUrl = current.routeAfterExpansion;
        return undefined;
      }
      if (source.includes('querySelectorAll') && source.includes('a[href]')) return pagesByUrl[currentUrl]?.links ?? [];
      if (source.includes('expectedComponentSlug') || source.includes('contentMatches')) {
        return readMaterialContentState(arg?.componentSlug, arg?.notFoundTitlePatterns, arg?.notFoundBodyPatterns);
      }
      if (source.includes('window.location.href')) {
        const current = pagesByUrl[currentUrl];
        return {
          url: current?.finalUrl ?? currentUrl,
          title: current?.title ?? '',
          text: current ? htmlText(current.html) : ''
        };
      }
      if (source.includes('clone.innerHTML')) {
        const current = pagesByUrl[currentUrl];
        return current ? { html: current.html, title: current.title, headings: current.headings } : { html: '', title: '', headings: [] };
      }
      if (source.includes('blogListingCurrentYear')) {
        const current = pagesByUrl[currentUrl];
        if (!current) return [];
        const origin = typeof arg === 'string' ? arg : 'https://m3.material.io';
        const year = current.headings
          .map((h: string) => parseInt(h, 10))
          .find((n: number) => n >= 2000 && n <= 2100);
        if (!year) return [];
        return (current.links as string[])
          .filter((l: string) => { try { const u = new URL(l); return u.origin === origin && u.pathname.startsWith('/blog/') && u.pathname.length > '/blog/'.length; } catch { return false; } })
          .map((l: string) => [new URL(l).toString().replace(/\/$/, ''), year] as [string, number]);
      }
      return undefined;
    })
  };
  const browser = {
    newContext: vi.fn(async () => ({
      newPage: vi.fn(async () => page),
      close: vi.fn(async () => undefined)
    })),
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

vi.mock('playwright', () => ({
  chromium: playwrightMock.chromium
}));

const { crawlMaterialDocs } = await import('../src/crawler.js');

let cacheDir: string;

function existingIndex(pageCount: number): MaterialIndex {
  return {
    source: 'https://m3.material.io',
    capturedAt: '2026-05-17T00:00:00.000Z',
    pageCount,
    attemptedPageCount: pageCount,
    failedPageCount: 0,
    failedUrls: [],
    pages: Array.from({ length: pageCount }, (_, i) => ({
      id: `existing-${i}`,
      title: `Existing ${i}`,
      url: `https://m3.material.io/existing-${i}`,
      path: `existing-${i}.md`,
      section: 'root',
      headings: [`Existing ${i}`],
      capturedAt: '2026-05-17T00:00:00.000Z'
    }))
  };
}

describe('crawlMaterialDocs', () => {
  beforeEach(async () => {
    cacheDir = await mkdtemp(path.join(tmpdir(), 'm3-docs-crawler-flow-test-'));
    vi.stubGlobal('fetch', vi.fn(async () => ({ ok: true, text: async () => '' })));
    playwrightMock.chromium.launch.mockClear();
    playwrightMock.browser.close.mockClear();
    playwrightMock.page.goto.mockClear();
    playwrightMock.page.url.mockClear();
    playwrightMock.page.on.mockClear();
    playwrightMock.page.off.mockClear();
    playwrightMock.page.waitForSelector.mockClear();
    playwrightMock.page.waitForFunction.mockClear();
    playwrightMock.page.close.mockClear();
    playwrightMock.page.evaluate.mockClear();
    for (const url of Object.keys(playwrightMock.pagesByUrl)) {
      if (url.startsWith('https://m3.material.io/foundations/good-')) delete playwrightMock.pagesByUrl[url];
      if (url.startsWith('https://m3.material.io/blog')) delete playwrightMock.pagesByUrl[url];
    }
    delete playwrightMock.pagesByUrl['https://m3.material.io/foundations/layout-overview/adaptive-design'];
    delete playwrightMock.pagesByUrl['https://m3.material.io/components/dialogs'];
    delete playwrightMock.pagesByUrl['https://m3.material.io/components/buttons'];
    for (const key of Object.keys(playwrightMock.networkResponsesByUrl)) delete playwrightMock.networkResponsesByUrl[key];
    playwrightMock.responseListeners.clear();
    playwrightMock.pagesByUrl['https://m3.material.io'].links = [
      'https://m3.material.io/components/dialogs?tab=usage#actions',
      'https://example.com/external',
      'https://m3.material.io/assets/logo.svg'
    ];
    playwrightMock.pagesByUrl['https://m3.material.io/components/dialogs/overview'] = {
      html: '<h1>Dialogs</h1><p>Dialogs provide important prompts and decisions with enough body text for crawler validation.</p><h2>Usage</h2><p>Use dialogs for focused tasks.</p>',
      title: 'Dialogs',
      headings: ['Dialogs', 'Usage'],
      links: [],
      finalUrl: 'https://m3.material.io/components/dialogs/overview'
    };
  });

  afterEach(async () => {
    vi.unstubAllGlobals();
    await rm(cacheDir, { recursive: true, force: true });
  });

  it('crawls discovered same-origin documentation pages into a promoted cache', async () => {
    const index = await crawlMaterialDocs({ cacheDir, allowBrowserFallback: true, maxPages: 5, minPageCount: 2, force: true });

    expect(playwrightMock.chromium.launch).toHaveBeenCalledWith({ headless: true });
    expect(playwrightMock.page.goto).toHaveBeenCalledWith('https://m3.material.io', { waitUntil: 'domcontentloaded', timeout: 45000 });
    expect(playwrightMock.page.goto).toHaveBeenCalledWith('https://m3.material.io/components/dialogs', { waitUntil: 'domcontentloaded', timeout: 45000 });
    expect(playwrightMock.page.goto).toHaveBeenCalledWith('https://m3.material.io/components/dialogs/overview', { waitUntil: 'domcontentloaded', timeout: 45000 });
    expect(playwrightMock.page.goto).not.toHaveBeenCalledWith('https://example.com/external', expect.anything());
    expect(playwrightMock.page.waitForSelector).toHaveBeenCalled();
    expect(playwrightMock.page.waitForFunction).toHaveBeenCalled();
    // 2 real crawled pages + up to NETWORK_BOOTSTRAP_SEED_PATHS.length recovery seed pages
    expect(playwrightMock.page.close.mock.calls.length).toBeGreaterThanOrEqual(2);
    expect(playwrightMock.browser.close).toHaveBeenCalledTimes(1);

    expect(index).toMatchObject({
      source: 'https://m3.material.io',
      pageCount: 2,
      attemptedPageCount: 3,
      failedPageCount: 0,
      failedUrls: [],
      qualityReport: {
        duplicateContent: [],
        rejectedRoutes: [],
        suspiciousPages: [],
        pagesBySection: {
          root: 1,
          'components/dialogs': 1
        }
      }
    });
    expect(index.pages.map((page) => page.path).sort()).toEqual(['components/dialogs/overview.md', 'index.md']);
    expect(index.pages.find((page) => page.path === 'components/dialogs/overview.md')).toMatchObject({
      title: 'Dialogs',
      headings: ['Dialogs', 'Usage']
    });

    const persistedIndex = JSON.parse(await readFile(indexPath(cacheDir), 'utf8')) as MaterialIndex;
    expect(persistedIndex.pageCount).toBe(2);
    await expect(readFile(path.join(pagesDir(cacheDir), 'components/dialogs/overview.md'), 'utf8')).resolves.toContain('# Dialogs');
  }, 15_000);

  it('uses sitemap loc URLs as discovery seeds before crawling unrelated links', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => ({
      ok: true,
      text: async () => '<urlset><url><loc>https://m3.material.io/foundations/layout/canonical-layouts</loc></url><url><loc>https://m3.material.io/blog/ignored</loc></url></urlset>'
    })));
    playwrightMock.pagesByUrl['https://m3.material.io'].links = [];
    playwrightMock.pagesByUrl['https://m3.material.io/foundations/layout/canonical-layouts'] = {
      html: '<h1>Canonical layouts</h1><p>Canonical layouts help applications adapt across screen sizes with enough text for crawler validation.</p>',
      title: 'Canonical layouts',
      headings: ['Canonical layouts'],
      links: [],
      finalUrl: 'https://m3.material.io/foundations/layout/canonical-layouts'
    };

    const index = await crawlMaterialDocs({ cacheDir, allowBrowserFallback: true, maxPages: 2, minPageCount: 2, force: true });

    expect(index.pages.map((page) => page.path).sort()).toEqual(['foundations/layout/canonical-layouts.md', 'index.md']);
    expect(playwrightMock.page.goto).not.toHaveBeenCalledWith('https://m3.material.io/blog/ignored', expect.anything());
  }, 10_000);

  it('falls back to URL extraction when sitemap loc entries are unavailable', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => ({
      ok: true,
      text: async () => 'https://m3.material.io/foundations/layout/canonical-layouts 2026-02-16 https://m3.material.io/blog/ignored'
    })));
    playwrightMock.pagesByUrl['https://m3.material.io'].links = [];
    playwrightMock.pagesByUrl['https://m3.material.io/foundations/layout/canonical-layouts'] = {
      html: '<h1>Canonical layouts</h1><p>Canonical layouts help applications adapt across screen sizes with enough text for crawler validation.</p>',
      title: 'Canonical layouts',
      headings: ['Canonical layouts'],
      links: [],
      finalUrl: 'https://m3.material.io/foundations/layout/canonical-layouts'
    };

    const index = await crawlMaterialDocs({ cacheDir, allowBrowserFallback: true, maxPages: 2, minPageCount: 2, force: true });

    expect(index.pages.map((page) => page.path).sort()).toEqual(['foundations/layout/canonical-layouts.md', 'index.md']);
    expect(playwrightMock.page.goto).not.toHaveBeenCalledWith('https://m3.material.io/blog/ignored', expect.anything());
  }, 10_000);

  it('fails a page instead of writing content when expansion changes the route', async () => {
    playwrightMock.pagesByUrl['https://m3.material.io'].links = ['https://m3.material.io/components/buttons'];
    playwrightMock.pagesByUrl['https://m3.material.io/components/buttons/overview'] = {
      html: '<h1>Buttons</h1><p>Buttons prompt most actions in a UI with enough body text for crawler validation.</p>',
      title: 'Buttons',
      headings: ['Buttons'],
      links: [],
      finalUrl: 'https://m3.material.io/components/buttons/overview',
      routeAfterExpansion: 'https://m3.material.io/components'
    };
    playwrightMock.pagesByUrl['https://m3.material.io/components'] = {
      html: '<h1>Components</h1><p>Components are interactive building blocks.</p>',
      title: 'Components',
      headings: ['Components'],
      links: [],
      finalUrl: 'https://m3.material.io/components'
    };

    await expect(crawlMaterialDocs({ cacheDir, allowBrowserFallback: true, maxPages: 5, minPageCount: 2 })).rejects.toThrow('below the required minimum');

    await expect(readFile(path.join(pagesDir(cacheDir), 'components/buttons/overview.md'), 'utf8')).rejects.toThrow();
  });

  it('rejects component routes that render the parent Components page', async () => {
    playwrightMock.pagesByUrl['https://m3.material.io'].links = ['https://m3.material.io/components/buttons'];
    playwrightMock.pagesByUrl['https://m3.material.io/components/buttons/overview'] = {
      html: '<h1>Components</h1><p>Components are interactive building blocks.</p><h2>Buttons</h2><p>Buttons prompt most actions in a UI.</p>',
      title: 'Components',
      headings: ['Components', 'Buttons'],
      links: [],
      finalUrl: 'https://m3.material.io/components/buttons/overview'
    };

    await expect(crawlMaterialDocs({ cacheDir, allowBrowserFallback: true, maxPages: 5, minPageCount: 2 })).rejects.toThrow('below the required minimum');

    await expect(readFile(path.join(pagesDir(cacheDir), 'components/buttons/overview.md'), 'utf8')).rejects.toThrow();
  });

  it('falls back to a valid next candidate when the first component candidate renders not found', async () => {
    playwrightMock.pagesByUrl['https://m3.material.io'].links = ['https://m3.material.io/components/buttons'];
    playwrightMock.pagesByUrl['https://m3.material.io/components/buttons'] = {
      html: '<h1>Page not found</h1><p>We could not find that page.</p>',
      title: 'Page not found',
      headings: ['Page not found'],
      links: [],
      finalUrl: 'https://m3.material.io/components/buttons'
    };
    playwrightMock.pagesByUrl['https://m3.material.io/components/buttons/overview'] = {
      html: '<h1>Buttons</h1><p>Buttons prompt most actions in a UI with enough body text for crawler validation and cache promotion safeguards.</p>',
      title: 'Buttons',
      headings: ['Buttons'],
      links: [],
      finalUrl: 'https://m3.material.io/components/buttons/overview'
    };

    const index = await crawlMaterialDocs({ cacheDir, allowBrowserFallback: true, maxPages: 5, minPageCount: 2, force: true });

    expect(playwrightMock.page.goto).toHaveBeenCalledWith('https://m3.material.io/components/buttons', { waitUntil: 'domcontentloaded', timeout: 45000 });
    expect(playwrightMock.page.goto).toHaveBeenCalledWith('https://m3.material.io/components/buttons/overview', { waitUntil: 'domcontentloaded', timeout: 45000 });
    expect(index.pages.map((page) => page.path).sort()).toEqual(['components/buttons/overview.md', 'index.md']);
    expect(index.failedUrls).toEqual([]);
    expect(index.qualityReport?.rejectedRoutes).toEqual([]);
    await expect(readFile(path.join(pagesDir(cacheDir), 'components/buttons/overview.md'), 'utf8')).resolves.toContain('# Buttons');
  }, 10_000);

  it('falls back when a candidate hits a canonical body-pattern not found variant', async () => {
    playwrightMock.pagesByUrl['https://m3.material.io'].links = ['https://m3.material.io/components/cards'];
    playwrightMock.pagesByUrl['https://m3.material.io/components/cards'] = {
      html: '<h1>Missing docs</h1><p>Try a different destination or head back to the homepage for Material guidance.</p>',
      title: 'Missing docs',
      headings: ['Missing docs'],
      links: [],
      finalUrl: 'https://m3.material.io/components/cards'
    };
    playwrightMock.pagesByUrl['https://m3.material.io/components/cards/overview'] = {
      html: '<h1>Cards</h1><p>Cards group related content and actions with enough body text for crawler validation and cache promotion safeguards.</p>',
      title: 'Cards',
      headings: ['Cards'],
      links: [],
      finalUrl: 'https://m3.material.io/components/cards/overview'
    };

    const index = await crawlMaterialDocs({ cacheDir, allowBrowserFallback: true, maxPages: 5, minPageCount: 2, force: true });

    expect(playwrightMock.page.goto).toHaveBeenCalledWith('https://m3.material.io/components/cards', { waitUntil: 'domcontentloaded', timeout: 45000 });
    expect(playwrightMock.page.goto).toHaveBeenCalledWith('https://m3.material.io/components/cards/overview', { waitUntil: 'domcontentloaded', timeout: 45000 });
    expect(index.pages.map((page) => page.path).sort()).toEqual(['components/cards/overview.md', 'index.md']);
    expect(index.failedUrls).toEqual([]);
    expect(index.qualityReport?.rejectedRoutes).toEqual([]);
    await expect(readFile(path.join(pagesDir(cacheDir), 'components/cards/overview.md'), 'utf8')).resolves.toContain('# Cards');
  }, 15_000);

  it('rejects routes when all candidates render not found and does not write candidate files', async () => {
    playwrightMock.pagesByUrl['https://m3.material.io'].links = ['https://m3.material.io/components/buttons'];
    playwrightMock.pagesByUrl['https://m3.material.io/components/buttons'] = {
      html: '<h1>Page not found</h1><p>We could not find that page.</p>',
      title: 'Page not found',
      headings: ['Page not found'],
      links: [],
      finalUrl: 'https://m3.material.io/components/buttons'
    };
    playwrightMock.pagesByUrl['https://m3.material.io/components/buttons/overview'] = {
      html: '<h1>Page not found</h1><p>Requested page was not found.</p>',
      title: 'Page not found',
      headings: ['Page not found'],
      links: [],
      finalUrl: 'https://m3.material.io/components/buttons/overview'
    };

    const index = await crawlMaterialDocs({ cacheDir, allowBrowserFallback: true, maxPages: 5, minPageCount: 1, force: true });

    expect(index.pageCount).toBe(1);
    expect(index.failedUrls).toContain('https://m3.material.io/components/buttons');
    expect(index.qualityReport?.rejectedRoutes).toContainEqual({
      url: 'https://m3.material.io/components/buttons',
      path: 'components/buttons.md',
      title: 'Page not found',
      reason: 'route rendered a not found page',
      classification: 'not-found',
      status: 'failed'
    });
    await expect(readFile(path.join(pagesDir(cacheDir), 'components/buttons.md'), 'utf8')).rejects.toThrow();
    await expect(readFile(path.join(pagesDir(cacheDir), 'components/buttons/overview.md'), 'utf8')).rejects.toThrow();
  });

  it('stops processing rejected routes before link discovery', async () => {
    playwrightMock.pagesByUrl['https://m3.material.io'].links = ['https://m3.material.io/foundations/bad-route'];
    playwrightMock.pagesByUrl['https://m3.material.io/foundations/bad-route'] = {
      html: '<h1>Page not found</h1><p>We could not find that page. Try a different destination or head back to the homepage for Material guidance and browse another documentation section instead.</p>',
      title: 'Page not found',
      headings: ['Page not found'],
      links: ['https://m3.material.io/foundations/hidden-valid-route'],
      finalUrl: 'https://m3.material.io/foundations/bad-route'
    };
    playwrightMock.pagesByUrl['https://m3.material.io/foundations/hidden-valid-route'] = {
      html: '<h1>Hidden valid route</h1><p>Hidden valid route contains enough Material documentation body text to pass crawler validation and cache promotion safeguards.</p>',
      title: 'Hidden valid route',
      headings: ['Hidden valid route'],
      links: [],
      finalUrl: 'https://m3.material.io/foundations/hidden-valid-route'
    };

    const index = await crawlMaterialDocs({ cacheDir, allowBrowserFallback: true, maxPages: 5, minPageCount: 1, force: true });

    expect(index.failedUrls).toContain('https://m3.material.io/foundations/bad-route');
    expect(index.pages.map((page) => page.path)).toEqual(['index.md']);
    expect(playwrightMock.page.goto).not.toHaveBeenCalledWith('https://m3.material.io/foundations/hidden-valid-route', expect.anything());
  });

  it('skips not found routes, records them in quality data, and still promotes when failure ratio stays acceptable', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => ({
      ok: true,
      text: async () => `<urlset>${Array.from({ length: 8 }, (_, i) => `<url><loc>https://m3.material.io/foundations/good-${i}</loc></url>`).join('')}<url><loc>https://m3.material.io/foundations/layout-overview/adaptive-design</loc></url></urlset>`
    })));
    playwrightMock.pagesByUrl['https://m3.material.io'].links = [];
    for (let i = 0; i < 8; i += 1) {
      playwrightMock.pagesByUrl[`https://m3.material.io/foundations/good-${i}`] = {
        html: `<h1>Good ${i}</h1><p>Good ${i} contains enough Material documentation body text to pass crawler validation and cache promotion safeguards.</p>`,
        title: `Good ${i}`,
        headings: [`Good ${i}`],
        links: [],
        finalUrl: `https://m3.material.io/foundations/good-${i}`
      };
    }
    playwrightMock.pagesByUrl['https://m3.material.io/foundations/layout-overview/adaptive-design'] = {
      html: '<h1>Page not found</h1><p>We could not find that page. Try a different destination or head back to the homepage.</p>',
      title: 'Page not found',
      headings: ['Page not found'],
      links: [],
      finalUrl: 'https://m3.material.io/foundations/layout-overview/adaptive-design'
    };

    const index = await crawlMaterialDocs({ cacheDir, allowBrowserFallback: true, maxPages: 10, minPageCount: 2, force: true });

    expect(index.pageCount).toBe(9);
    expect(index.attemptedPageCount).toBe(10);
    expect(index.failedPageCount).toBe(1);
    expect(index.failedUrls).toContain('https://m3.material.io/foundations/layout-overview/adaptive-design');
    expect(index.qualityReport?.rejectedRoutes).toContainEqual({
      url: 'https://m3.material.io/foundations/layout-overview/adaptive-design',
      path: 'foundations/layout-overview/adaptive-design.md',
      title: 'Page not found',
      reason: 'route rendered a not found page',
      classification: 'not-found',
      status: 'failed'
    });
    expect(index.qualityReport?.suspiciousPages).toEqual([]);
    await expect(readFile(path.join(pagesDir(cacheDir), 'foundations/layout-overview/adaptive-design.md'), 'utf8')).rejects.toThrow();
    await expect(readFile(indexPath(cacheDir), 'utf8')).resolves.toContain('"pageCount": 9');
  }, 20_000);

  it('keeps the old cache when the crawl result is below the minimum accepted page count', async () => {
    await expect(crawlMaterialDocs({ cacheDir, allowBrowserFallback: true, maxPages: 1, minPageCount: 2 })).rejects.toThrow('below the required minimum');
    await expect(readFile(indexPath(cacheDir), 'utf8')).rejects.toThrow();
  });

  it('keeps the old cache when a new crawl would severely reduce page count', async () => {
    const oldIndex = existingIndex(5);
    await writeIndex(oldIndex, cacheDir);

    await expect(crawlMaterialDocs({ cacheDir, allowBrowserFallback: true, maxPages: 1, minPageCount: 1 })).rejects.toThrow('below 80% of the previous cache');

    const persistedIndex = JSON.parse(await readFile(indexPath(cacheDir), 'utf8')) as MaterialIndex;
    expect(persistedIndex).toMatchObject({
      source: oldIndex.source,
      capturedAt: oldIndex.capturedAt,
      pageCount: oldIndex.pageCount,
      attemptedPageCount: oldIndex.attemptedPageCount,
      failedPageCount: oldIndex.failedPageCount,
      failedUrls: oldIndex.failedUrls
    });
    expect(persistedIndex.pages).toEqual(oldIndex.pages.map((page) => ({
      path: page.path,
      title: page.title,
      sourceUrl: page.url,
      section: page.section,
      headings: page.headings
    })));
  });

  it('allows explicitly forced replacement of a larger old cache', async () => {
    const oldIndex = existingIndex(5);
    await writeIndex(oldIndex, cacheDir);

    const nextIndex = await crawlMaterialDocs({ cacheDir, allowBrowserFallback: true, maxPages: 1, minPageCount: 1, force: true });

    expect(nextIndex.pageCount).toBe(1);
    const persistedIndex = JSON.parse(await readFile(indexPath(cacheDir), 'utf8')) as MaterialIndex;
    expect(persistedIndex.pageCount).toBe(1);
    expect(persistedIndex.pages[0]?.path).toBe('index.md');
  });

  it('reuses cached blog posts with publishedYear older than last year without re-crawling', async () => {
    const oldYear = new Date().getFullYear() - 2;
    const capturedAt = new Date().toISOString();
    const blogUrl = 'https://m3.material.io/blog/old-post';
    const blogPath = 'blog/old-post.md';
    const blogMarkdown = `---\ntitle: "Old Blog Post"\nsourceUrl: ${blogUrl}\nsection: blog\ncapturedAt: ${capturedAt}\n---\n\n# Old Blog Post\n\nThis is an old blog post with enough text for crawler validation and incremental cache reuse.\n`;
    const blogPage: MaterialPage = {
      id: 'blog-old-post-id',
      title: 'Old Blog Post',
      url: blogUrl,
      path: blogPath,
      section: 'blog',
      headings: ['Old Blog Post'],
      text: 'This is an old blog post with enough text for crawler validation and incremental cache reuse.',
      markdown: blogMarkdown,
      capturedAt,
      publishedYear: oldYear
    };

    const oldIndex: MaterialIndex = {
      source: 'https://m3.material.io',
      capturedAt,
      pageCount: 1,
      attemptedPageCount: 1,
      failedPageCount: 0,
      failedUrls: [],
      pages: [{ id: blogPage.id, title: blogPage.title, url: blogPage.url, path: blogPage.path, section: blogPage.section, headings: blogPage.headings, capturedAt, publishedYear: oldYear }]
    };
    await writeIndex(oldIndex, cacheDir);
    await writePage(blogPage, cacheDir);

    playwrightMock.pagesByUrl['https://m3.material.io'].links = [blogUrl];

    const index = await crawlMaterialDocs({ cacheDir, allowBrowserFallback: true, maxPages: 5, minPageCount: 1, includeBlog: true, force: true });

    expect(playwrightMock.page.goto).not.toHaveBeenCalledWith(blogUrl, expect.anything());
    expect(index.pages.find((p) => p.url === blogUrl)).toMatchObject({ title: 'Old Blog Post', path: blogPath, publishedYear: oldYear });
    await expect(readFile(path.join(pagesDir(cacheDir), blogPath), 'utf8')).resolves.toContain('# Old Blog Post');
  });

  it('re-crawls blog posts with publishedYear from last year or later', async () => {
    const recentYear = new Date().getFullYear() - 1;
    const capturedAt = new Date().toISOString();
    const blogUrl = 'https://m3.material.io/blog/recent-post';
    const blogPath = 'blog/recent-post.md';
    const blogPage: MaterialPage = {
      id: 'blog-recent-id',
      title: 'Recent Blog Post',
      url: blogUrl,
      path: blogPath,
      section: 'blog',
      headings: ['Recent Blog Post'],
      text: 'Recent blog post text.',
      markdown: `---\ntitle: "Recent Blog Post"\nsourceUrl: ${blogUrl}\nsection: blog\ncapturedAt: ${capturedAt}\n---\n\n# Recent Blog Post\n\nRecent blog post text.\n`,
      capturedAt,
      publishedYear: recentYear
    };

    const oldIndex: MaterialIndex = {
      source: 'https://m3.material.io',
      capturedAt,
      pageCount: 1,
      attemptedPageCount: 1,
      failedPageCount: 0,
      failedUrls: [],
      pages: [{ id: blogPage.id, title: blogPage.title, url: blogPage.url, path: blogPage.path, section: blogPage.section, headings: blogPage.headings, capturedAt, publishedYear: recentYear }]
    };
    await writeIndex(oldIndex, cacheDir);
    await writePage(blogPage, cacheDir);

    playwrightMock.pagesByUrl['https://m3.material.io'].links = [blogUrl];
    playwrightMock.pagesByUrl[blogUrl] = {
      html: '<h1>Recent Blog Post</h1><p>Recent blog post with enough text for crawler validation and live re-crawl verification.</p>',
      title: 'Recent Blog Post',
      headings: ['Recent Blog Post'],
      links: [],
      finalUrl: blogUrl
    };

    await crawlMaterialDocs({ cacheDir, allowBrowserFallback: true, maxPages: 5, minPageCount: 1, includeBlog: true, force: true });

    expect(playwrightMock.page.goto).toHaveBeenCalledWith(blogUrl, expect.anything());
  }, 10_000);

  it('re-crawls blog posts with no publishedYear in the previous index', async () => {
    const capturedAt = new Date().toISOString();
    const blogUrl = 'https://m3.material.io/blog/unknown-year-post';
    const blogPath = 'blog/unknown-year-post.md';
    const blogPage: MaterialPage = {
      id: 'blog-unknown-id',
      title: 'Unknown Year Post',
      url: blogUrl,
      path: blogPath,
      section: 'blog',
      headings: ['Unknown Year Post'],
      text: 'Unknown year blog post text for testing.',
      markdown: `---\ntitle: "Unknown Year Post"\nsourceUrl: ${blogUrl}\nsection: blog\ncapturedAt: ${capturedAt}\n---\n\n# Unknown Year Post\n\nUnknown year blog post text for testing.\n`,
      capturedAt
    };

    const oldIndex: MaterialIndex = {
      source: 'https://m3.material.io',
      capturedAt,
      pageCount: 1,
      attemptedPageCount: 1,
      failedPageCount: 0,
      failedUrls: [],
      pages: [{ id: blogPage.id, title: blogPage.title, url: blogPage.url, path: blogPage.path, section: blogPage.section, headings: blogPage.headings, capturedAt }]
    };
    await writeIndex(oldIndex, cacheDir);
    await writePage(blogPage, cacheDir);

    playwrightMock.pagesByUrl['https://m3.material.io'].links = [blogUrl];
    playwrightMock.pagesByUrl[blogUrl] = {
      html: '<h1>Unknown Year Post</h1><p>Unknown year blog post with enough text for crawler validation and live re-crawl.</p>',
      title: 'Unknown Year Post',
      headings: ['Unknown Year Post'],
      links: [],
      finalUrl: blogUrl
    };

    await crawlMaterialDocs({ cacheDir, allowBrowserFallback: true, maxPages: 5, minPageCount: 1, includeBlog: true, force: true });

    expect(playwrightMock.page.goto).toHaveBeenCalledWith(blogUrl, expect.anything());
  }, 10_000);

  it('extracts publishedYear from the blog listing page and saves it with blog post pages', async () => {
    const currentYear = new Date().getFullYear();
    const blogListingUrl = 'https://m3.material.io/blog';
    const blogPostUrl = 'https://m3.material.io/blog/new-article';

    playwrightMock.pagesByUrl['https://m3.material.io'].links = [blogListingUrl];
    playwrightMock.pagesByUrl[blogListingUrl] = {
      html: `<h1>Blog</h1><p>The Material Design blog covers component updates, design guidance, and platform news for designers and developers working with Material 3.</p><h2>${currentYear}</h2><a href="${blogPostUrl}">New Article</a>`,
      title: 'Blog',
      headings: ['Blog', String(currentYear)],
      links: [blogPostUrl],
      finalUrl: blogListingUrl
    };
    playwrightMock.pagesByUrl[blogPostUrl] = {
      html: '<h1>New Article</h1><p>This is a new article with enough text for crawler validation and year extraction testing.</p>',
      title: 'New Article',
      headings: ['New Article'],
      links: [],
      finalUrl: blogPostUrl
    };

    const index = await crawlMaterialDocs({ cacheDir, allowBrowserFallback: true, maxPages: 5, minPageCount: 1, includeBlog: true, force: true });

    const blogEntry = index.pages.find((p) => p.url === blogPostUrl);
    expect(blogEntry?.publishedYear).toBe(currentYear);
  }, 15_000);

  it('runs first-cache coverage discovery even when direct JSON extraction succeeds', async () => {
    const html = '<html><body><script src="/static/angular/main.abcdef12.js"></script></body></html>';
    const mainJs = '"carbonVersion":"cv-123","slug":"components/lists/overview","documentId":"doc-lists","collectionId":"20543ce18892f7d9","collectionName":"ComponentsM3","pageCanonId":"page-canon-lists","exportedCarbonFileId":"page-canon-lists.json"';
    const pageData = { result: { pageContext: { title: 'Lists', documentId: 'doc-lists', pageCanonId: 'page-canon-lists', slug: 'components/lists/overview' } } };
    const contentPage = {
      title: 'Lists',
      sections: [{ name: 'Overview', contentBlocks: [{ title: 'Usage', contentChunks: [{ contentChunkType: 'TEXT', htmlValue: '<p>Lists present multiple line items in a compact column with enough text for validation.</p>' }] }] }]
    };

    vi.stubGlobal('fetch', vi.fn(async (input: string | URL) => {
      const url = String(input);
      if (url === 'https://m3.material.io') return { ok: true, text: async () => html } as Response;
      if (url === 'https://m3.material.io/static/angular/main.abcdef12.js') return { ok: true, text: async () => mainJs } as Response;
      if (url === 'https://m3.material.io/page-data/ComponentsM3/doc-lists.json') return { ok: true, json: async () => pageData } as Response;
      if (url === 'https://m3.material.io/_dsm/content/m3/cv-123/page-canon-lists.json') return { ok: true, json: async () => contentPage } as Response;
      return { ok: false, status: 404, text: async () => '', json: async () => ({}) } as Response;
    }));

    const index = await crawlMaterialDocs({ cacheDir, allowBrowserFallback: true, maxPages: 5, minPageCount: 1, force: true });

    expect(playwrightMock.chromium.launch).toHaveBeenCalledTimes(1);
    expect(playwrightMock.page.goto).toHaveBeenCalledWith('https://m3.material.io', { waitUntil: 'domcontentloaded', timeout: 45000 });
    expect(index.pages.map((page) => page.path).sort()).toEqual([
      'components/dialogs/overview.md',
      'components/lists/overview.md',
      'index.md'
    ]);
    expect(index.extractionDiagnostics).toMatchObject({
      pagesExtractedThroughJson: 1,
      pagesExtractedThroughDomFallback: 2,
      pagesWhereJsonFailed: 0,
      jsonFallbackRoutes: 0
    });
    expect(index.coverageDiagnostics).toMatchObject({
      renderedNavUrlCount: 1,
      angularRouteHintCount: 1,
      acceptedPageCount: 3,
      coverageVerified: false
    });
  }, 10_000);

  it('uses browser fallback only for routes that failed JSON extraction', async () => {
    const html = '<html><body><script src="/static/angular/main.abcdef12.js"></script></body></html>';
    const mainJs = [
      '"carbonVersion":"cv-123"',
      '"slug":"components/lists/overview","documentId":"doc-lists","collectionId":"20543ce18892f7d9","collectionName":"ComponentsM3","pageCanonId":"page-canon-lists","exportedCarbonFileId":"page-canon-lists.json"',
      '"slug":"components/dialogs/overview","documentId":"doc-dialogs","collectionId":"20543ce18892f7d9","collectionName":"ComponentsM3","pageCanonId":"page-canon-dialogs","exportedCarbonFileId":"page-canon-dialogs.json"'
    ].join(',');
    const pageData = { result: { pageContext: { title: 'Lists', documentId: 'doc-lists', pageCanonId: 'page-canon-lists', slug: 'components/lists/overview' } } };
    const contentPage = {
      title: 'Lists',
      sections: [{ name: 'Overview', contentBlocks: [{ title: 'Usage', contentChunks: [{ contentChunkType: 'TEXT', htmlValue: '<p>Lists present multiple line items in a compact column with enough text for validation.</p>' }] }] }]
    };

    vi.stubGlobal('fetch', vi.fn(async (input: string | URL) => {
      const url = String(input);
      if (url === 'https://m3.material.io') return { ok: true, text: async () => html } as Response;
      if (url === 'https://m3.material.io/static/angular/main.abcdef12.js') return { ok: true, text: async () => mainJs } as Response;
      if (url === 'https://m3.material.io/page-data/ComponentsM3/doc-lists.json') return { ok: true, json: async () => pageData } as Response;
      if (url === 'https://m3.material.io/_dsm/content/m3/cv-123/page-canon-lists.json') return { ok: true, json: async () => contentPage } as Response;
      if (url === 'https://m3.material.io/sitemap.xml') return { ok: true, text: async () => '' } as Response;
      return { ok: false, status: 404, text: async () => '', json: async () => ({}) } as Response;
    }));

    const index = await crawlMaterialDocs({ cacheDir, allowBrowserFallback: true, maxPages: 5, minPageCount: 3, force: true });

    expect(playwrightMock.chromium.launch).toHaveBeenCalledTimes(1);
    expect(playwrightMock.page.goto).toHaveBeenCalledWith('https://m3.material.io', { waitUntil: 'domcontentloaded', timeout: 45000 });
    expect(playwrightMock.page.goto).toHaveBeenCalledWith('https://m3.material.io/components/dialogs/overview', { waitUntil: 'domcontentloaded', timeout: 45000 });
    expect(playwrightMock.page.goto).not.toHaveBeenCalledWith('https://m3.material.io/components/lists/overview', expect.anything());
    expect(index.extractionDiagnostics).toMatchObject({
      pagesExtractedThroughJson: 1,
      pagesExtractedThroughDomFallback: 2,
      pagesWhereJsonFailed: 1,
      jsonFallbackRoutes: 1
    });
    expect(index.extractionDiagnostics?.routeDiagnostics).toContainEqual(expect.objectContaining({
      path: 'components/dialogs/overview.md',
      jsonAttempted: true,
      jsonSucceeded: false,
      fallbackReason: 'json-fetch-failed',
      browserFallbackAttempted: true,
      browserFallbackSucceeded: true,
      finalMethod: 'dom'
    }));
  }, 10_000);

  it('uses network-captured JSON when direct JSON fails', async () => {
    // timeout raised to 15_000 because this test spawns multiple async fetches and
    // runs slowly under Stryker's parallel instrumented workers
    const html = '<html><body><script src="/static/angular/main.abcdef12.js"></script></body></html>';
    const mainJs = [
      '"carbonVersion":"cv-123"',
      '"slug":"components/lists/overview","documentId":"doc-lists","collectionId":"20543ce18892f7d9","collectionName":"ComponentsM3","pageCanonId":"page-canon-lists","exportedCarbonFileId":"page-canon-lists.json"',
      '"slug":"components/dialogs/overview","documentId":"doc-dialogs","collectionId":"20543ce18892f7d9","collectionName":"ComponentsM3","pageCanonId":"page-canon-dialogs","exportedCarbonFileId":"page-canon-dialogs.json"'
    ].join(',');
    const listsPageData = { result: { pageContext: { title: 'Lists', documentId: 'doc-lists', pageCanonId: 'page-canon-lists', slug: 'components/lists/overview' } } };
    const listsContentPage = {
      title: 'Lists',
      sections: [{ name: 'Overview', contentBlocks: [{ title: 'Usage', contentChunks: [{ contentChunkType: 'TEXT', htmlValue: '<p>Lists present multiple line items in a compact column with enough text for validation.</p>' }] }] }]
    };
    const dialogsPageData = { result: { pageContext: { title: 'Dialogs', documentId: 'doc-dialogs', pageCanonId: 'page-canon-dialogs', slug: 'components/dialogs/overview' } } };
    const dialogsContentPage = {
      title: 'Dialogs',
      sections: [{ name: 'Overview', contentBlocks: [{ title: 'Usage', contentChunks: [{ contentChunkType: 'TEXT', htmlValue: '<p>Dialogs use modals to focus people on a decision with enough text for validation.</p>' }] }] }]
    };

    playwrightMock.networkResponsesByUrl['https://m3.material.io/components/dialogs/overview'] = [
      { url: 'https://m3.material.io/page-data/components/dialogs/overview/page-data.json', payload: dialogsPageData },
      { url: 'https://m3.material.io/_dsm/content/m3/cv-123/page-canon-dialogs.json', payload: dialogsContentPage }
    ];

    vi.stubGlobal('fetch', vi.fn(async (input: string | URL) => {
      const url = String(input);
      if (url === 'https://m3.material.io') return { ok: true, text: async () => html } as Response;
      if (url === 'https://m3.material.io/static/angular/main.abcdef12.js') return { ok: true, text: async () => mainJs } as Response;
      if (url === 'https://m3.material.io/page-data/ComponentsM3/doc-lists.json') return { ok: true, json: async () => listsPageData } as Response;
      if (url === 'https://m3.material.io/_dsm/content/m3/cv-123/page-canon-lists.json') return { ok: true, json: async () => listsContentPage } as Response;
      if (url === 'https://m3.material.io/sitemap.xml') return { ok: true, text: async () => '' } as Response;
      return { ok: false, status: 404, text: async () => '', json: async () => ({}) } as Response;
    }));

    const index = await crawlMaterialDocs({ cacheDir, allowBrowserFallback: true, maxPages: 5, minPageCount: 3, force: true });

    expect(index.extractionDiagnostics).toMatchObject({
      pagesAcceptedFromDirectJson: 1,
      pagesAcceptedFromNetworkJson: 1,
      pagesAcceptedFromDomFallback: 1
    });
    expect(index.extractionDiagnostics?.routeDiagnostics).toContainEqual(expect.objectContaining({
      path: 'components/dialogs/overview.md',
      sourceUsed: 'network-json',
      finalMethod: 'json',
      directJsonAttempted: true,
      directJsonSucceeded: false,
      networkJsonAttempted: true,
      networkJsonSucceeded: true
    }));
    await expect(readFile(path.join(cacheDir, 'raw/components/dialogs/overview/page-data.json'), 'utf8')).resolves.toContain('"type": "page-metadata"');
  }, 15_000);

  it('records fallback skip reasons when Playwright is unavailable but direct JSON already produced a valid cache', async () => {
    const html = '<html><body><script src="/static/angular/main.abcdef12.js"></script></body></html>';
    const mainJs = [
      '"carbonVersion":"cv-123"',
      '"slug":"components/lists/overview","documentId":"doc-lists","collectionId":"20543ce18892f7d9","collectionName":"ComponentsM3","pageCanonId":"page-canon-lists","exportedCarbonFileId":"page-canon-lists.json"',
      '"slug":"components/dialogs/overview","documentId":"doc-dialogs","collectionId":"20543ce18892f7d9","collectionName":"ComponentsM3","pageCanonId":"page-canon-dialogs","exportedCarbonFileId":"page-canon-dialogs.json"'
    ].join(',');
    const pageData = { result: { pageContext: { title: 'Lists', documentId: 'doc-lists', pageCanonId: 'page-canon-lists', slug: 'components/lists/overview' } } };
    const contentPage = {
      title: 'Lists',
      sections: [{ name: 'Overview', contentBlocks: [{ title: 'Usage', contentChunks: [{ contentChunkType: 'TEXT', htmlValue: '<p>Lists present multiple line items in a compact column with enough text for validation.</p>' }] }] }]
    };

    playwrightMock.chromium.launch.mockRejectedValueOnce(new Error('missing browser'));
    vi.stubGlobal('fetch', vi.fn(async (input: string | URL) => {
      const url = String(input);
      if (url === 'https://m3.material.io') return { ok: true, text: async () => html } as Response;
      if (url === 'https://m3.material.io/static/angular/main.abcdef12.js') return { ok: true, text: async () => mainJs } as Response;
      if (url === 'https://m3.material.io/page-data/ComponentsM3/doc-lists.json') return { ok: true, json: async () => pageData } as Response;
      if (url === 'https://m3.material.io/_dsm/content/m3/cv-123/page-canon-lists.json') return { ok: true, json: async () => contentPage } as Response;
      return { ok: false, status: 404, text: async () => '', json: async () => ({}) } as Response;
    }));

    const index = await crawlMaterialDocs({ cacheDir, allowBrowserFallback: true, maxPages: 5, minPageCount: 1, force: true });

    expect(index.pageCount).toBe(1);
    expect(index.coverageDiagnostics).toMatchObject({
      coverageVerified: false,
      coverageWarnings: expect.arrayContaining(['coverage-unverified:playwright-unavailable'])
    });
    expect(index.extractionDiagnostics?.routeDiagnostics).toEqual(expect.arrayContaining([
      expect.objectContaining({
        path: 'components/lists/overview.md',
        fallbackSkippedReasons: expect.arrayContaining(['json-quality-accepted', 'playwright-unavailable'])
      }),
      expect.objectContaining({
        path: 'components/dialogs/overview.md',
        fallbackSkippedReasons: expect.arrayContaining(['playwright-unavailable'])
      })
    ]));
  });

  it('allows max-pages partial crawls but marks coverage as partial', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => ({
      ok: true,
      text: async () => '<urlset><url><loc>https://m3.material.io/components/buttons</loc></url><url><loc>https://m3.material.io/components/dialogs</loc></url></urlset>'
    })));
    playwrightMock.pagesByUrl['https://m3.material.io'].links = ['https://m3.material.io/components/buttons', 'https://m3.material.io/components/dialogs'];
    playwrightMock.pagesByUrl['https://m3.material.io/components/buttons/overview'] = {
      html: '<h1>Buttons</h1><p>Buttons prompt actions with enough body text for crawler validation.</p>',
      title: 'Buttons',
      headings: ['Buttons'],
      links: [],
      finalUrl: 'https://m3.material.io/components/buttons/overview'
    };

    const index = await crawlMaterialDocs({ cacheDir, allowBrowserFallback: true, maxPages: 1, minPageCount: 1, force: true });

    expect(index.pageCount).toBe(1);
    expect(index.coverageDiagnostics).toMatchObject({
      acceptedPageCount: 1,
      coverageVerified: false
    });
    expect(index.coverageDiagnostics?.coverageWarnings).toEqual(expect.arrayContaining([
      expect.stringMatching(/^coverage-partial:max-pages-limited:/)
    ]));
  }, 10_000);

  it('includeBlog:false does not attempt /blog routes during direct JSON extraction', async () => {
    const html = '<html><body><script src="/static/angular/main.abcdef12.js"></script></body></html>';
    // Bundle has one real route and three blog routes
    const mainJs = [
      '"carbonVersion":"cv-123"',
      '"slug":"components/lists/overview","documentId":"doc-lists","collectionId":"20543ce18892f7d9","collectionName":"ComponentsM3","pageCanonId":"page-canon-lists","exportedCarbonFileId":"page-canon-lists.json"',
      '"slug":"blog/2025/some-post","documentId":"doc-blog-1","collectionId":"BlogM3","collectionName":"BlogM3","pageCanonId":"blog-post-1","exportedCarbonFileId":"blog-post-1.json"',
      '"slug":"blog/2025/another-post","documentId":"doc-blog-2","collectionId":"BlogM3","collectionName":"BlogM3","pageCanonId":"blog-post-2","exportedCarbonFileId":"blog-post-2.json"',
      '"slug":"blog/2024/old-post","documentId":"doc-blog-3","collectionId":"BlogM3","collectionName":"BlogM3","pageCanonId":"blog-post-3","exportedCarbonFileId":"blog-post-3.json"'
    ].join(',');
    const pageData = { result: { pageContext: { title: 'Lists', documentId: 'doc-lists', pageCanonId: 'page-canon-lists', slug: 'components/lists/overview' } } };
    const contentPage = {
      title: 'Lists',
      sections: [{ name: 'Overview', contentBlocks: [{ title: 'Usage', contentChunks: [{ contentChunkType: 'TEXT', htmlValue: '<p>Lists present multiple line items in a compact column with enough text for validation.</p>' }] }] }]
    };

    const siteMetaPaths = ['components/lists/overview', 'blog/2025/some-post', 'blog/2025/another-post', 'blog/2024/old-post'];
    vi.stubGlobal('fetch', vi.fn(async (input: string | URL) => {
      const url = String(input);
      if (url === 'https://m3.material.io') return { ok: true, text: async () => html } as Response;
      if (url === 'https://m3.material.io/site_meta.js') return { ok: true, text: async () => siteMetaJsText(siteMetaPaths) } as Response;
      if (url === 'https://m3.material.io/static/angular/main.abcdef12.js') return { ok: true, text: async () => mainJs } as Response;
      if (url === 'https://m3.material.io/page-data/ComponentsM3/doc-lists.json') return { ok: true, json: async () => pageData } as Response;
      if (url === 'https://m3.material.io/_dsm/content/m3/cv-123/page-canon-lists.json') return { ok: true, json: async () => contentPage } as Response;
      return { ok: false, status: 404, text: async () => '', json: async () => ({}) } as Response;
    }));

    const index = await crawlMaterialDocs({ cacheDir, maxPages: 10, minPageCount: 1, includeBlog: false, force: true });

    expect(playwrightMock.chromium.launch).not.toHaveBeenCalled();

    // No /blog routes should have been attempted via direct JSON
    const directJsonAttempted = index.extractionDiagnostics?.routeDiagnostics?.filter((d) => d.directJsonAttempted) ?? [];
    const blogAttempted = directJsonAttempted.filter((d) => d.path.startsWith('blog/'));
    expect(blogAttempted).toHaveLength(0);

    // Blog routes should be counted as policy-skipped
    expect(index.coverageDiagnostics?.skippedBlogCount).toBeGreaterThanOrEqual(3);
    expect(index.coverageDiagnostics?.includeBlog).toBe(false);

    // The real route should have been extracted
    expect(index.extractionDiagnostics?.pagesAcceptedFromDirectJson).toBeGreaterThanOrEqual(1);
  }, 10_000);

  it('maxPages limits the number of direct JSON extraction attempts', async () => {
    const html = '<html><body><script src="/static/angular/main.abcdef12.js"></script></body></html>';
    // Bundle has 10 routes — far more than maxPages:3
    const slugs = Array.from({ length: 10 }, (_, i) => `components/item-${i}/overview`);
    const mainJs = [
      '"carbonVersion":"cv-123"',
      ...slugs.map((slug, i) =>
        `"slug":"${slug}","documentId":"doc-${i}","collectionId":"ComponentsM3","collectionName":"ComponentsM3","pageCanonId":"canon-${i}","exportedCarbonFileId":"canon-${i}.json"`
      )
    ].join(',');

    // Only the first route gets page data (so it saves); others 404
    const pageData = { result: { pageContext: { title: 'Item 0', documentId: 'doc-0', pageCanonId: 'canon-0', slug: slugs[0] } } };
    const contentPage = {
      title: 'Item 0',
      sections: [{ name: 'Overview', contentBlocks: [{ title: 'Usage', contentChunks: [{ contentChunkType: 'TEXT', htmlValue: '<p>Item 0 provides useful information with enough text for crawler validation.</p>' }] }] }]
    };

    vi.stubGlobal('fetch', vi.fn(async (input: string | URL) => {
      const url = String(input);
      if (url === 'https://m3.material.io') return { ok: true, text: async () => html } as Response;
      if (url === 'https://m3.material.io/site_meta.js') return { ok: true, text: async () => siteMetaJsText(slugs) } as Response;
      if (url === 'https://m3.material.io/static/angular/main.abcdef12.js') return { ok: true, text: async () => mainJs } as Response;
      if (url === 'https://m3.material.io/page-data/ComponentsM3/doc-0.json') return { ok: true, json: async () => pageData } as Response;
      if (url === 'https://m3.material.io/_dsm/content/m3/cv-123/canon-0.json') return { ok: true, json: async () => contentPage } as Response;
      return { ok: false, status: 404, text: async () => '', json: async () => ({}) } as Response;
    }));

    const index = await crawlMaterialDocs({ cacheDir, maxPages: 3, minPageCount: 1, force: true });

    expect(playwrightMock.chromium.launch).not.toHaveBeenCalled();
    // With maxPages:3 and pre-limiting, at most 3 direct JSON routes should be attempted
    const directJsonAttempted = index.extractionDiagnostics?.routeDiagnostics?.filter((d) => d.directJsonAttempted) ?? [];
    expect(directJsonAttempted.length).toBeLessThanOrEqual(3);
  }, 10_000);

  it('runs the deterministic default path (site_meta -> bundle resolver -> page-data -> markdown) without launching a browser', async () => {
    const html = '<html><body><script src="/static/angular/main.abcdef12.js"></script></body></html>';
    const mainJs = '"carbonVersion":"cv-123","slug":"components/lists/overview","documentId":"doc-lists","collectionId":"20543ce18892f7d9","collectionName":"ComponentsM3","pageCanonId":"page-canon-lists","exportedCarbonFileId":"page-canon-lists.json"';
    const pageData = { result: { pageContext: { title: 'Lists', documentId: 'doc-lists', pageCanonId: 'page-canon-lists', slug: 'components/lists/overview' } } };
    const contentPage = {
      title: 'Lists',
      sections: [{ name: 'Overview', contentBlocks: [{ title: 'Usage', contentChunks: [{ contentChunkType: 'TEXT', htmlValue: '<p>Lists present multiple line items in a compact column with enough text for validation.</p>' }] }] }]
    };

    vi.stubGlobal('fetch', vi.fn(async (input: string | URL) => {
      const url = String(input);
      if (url === 'https://m3.material.io') return { ok: true, text: async () => html } as Response;
      if (url === 'https://m3.material.io/site_meta.js') return { ok: true, text: async () => siteMetaJsText(['components/lists/overview']) } as Response;
      if (url === 'https://m3.material.io/static/angular/main.abcdef12.js') return { ok: true, text: async () => mainJs } as Response;
      if (url === 'https://m3.material.io/page-data/ComponentsM3/doc-lists.json') return { ok: true, json: async () => pageData } as Response;
      if (url === 'https://m3.material.io/_dsm/content/m3/cv-123/page-canon-lists.json') return { ok: true, json: async () => contentPage } as Response;
      return { ok: false, status: 404, text: async () => '', json: async () => ({}) } as Response;
    }));

    const index = await crawlMaterialDocs({ cacheDir, maxPages: 5, minPageCount: 1, force: true });

    expect(playwrightMock.chromium.launch).not.toHaveBeenCalled();
    expect(index.pages.map((page) => page.path)).toEqual(['components/lists/overview.md']);
    expect(index.extractionDiagnostics?.pagesAcceptedFromDirectJson).toBe(1);
    for (const diagnostic of index.extractionDiagnostics?.routeDiagnostics ?? []) {
      expect(['site-meta', 'bundle-supplement']).toContain(diagnostic.navigationSource);
      expect(diagnostic.pageReferenceSource).toBe('bundle-table');
    }
  }, 10_000);

  it('classifies a selected site_meta route absent from the bundle table as skipped, not failed', async () => {
    const html = '<html><body><script src="/static/angular/main.abcdef12.js"></script></body></html>';
    const mainJs = '"carbonVersion":"cv-123","slug":"components/lists/overview","documentId":"doc-lists","collectionId":"20543ce18892f7d9","collectionName":"ComponentsM3","pageCanonId":"page-canon-lists","exportedCarbonFileId":"page-canon-lists.json"';
    const pageData = { result: { pageContext: { title: 'Lists', documentId: 'doc-lists', pageCanonId: 'page-canon-lists', slug: 'components/lists/overview' } } };
    const contentPage = {
      title: 'Lists',
      sections: [{ name: 'Overview', contentBlocks: [{ title: 'Usage', contentChunks: [{ contentChunkType: 'TEXT', htmlValue: '<p>Lists present multiple line items in a compact column with enough text for validation.</p>' }] }] }]
    };

    // /components/orphan exists in site_meta but has no entry in the bundle route table at all —
    // resolvePageReference returns pageReferenceSource:"missing" for it.
    vi.stubGlobal('fetch', vi.fn(async (input: string | URL) => {
      const url = String(input);
      if (url === 'https://m3.material.io') return { ok: true, text: async () => html } as Response;
      if (url === 'https://m3.material.io/site_meta.js') return { ok: true, text: async () => siteMetaJsText(['components/lists/overview', 'components/orphan']) } as Response;
      if (url === 'https://m3.material.io/static/angular/main.abcdef12.js') return { ok: true, text: async () => mainJs } as Response;
      if (url === 'https://m3.material.io/page-data/ComponentsM3/doc-lists.json') return { ok: true, json: async () => pageData } as Response;
      if (url === 'https://m3.material.io/_dsm/content/m3/cv-123/page-canon-lists.json') return { ok: true, json: async () => contentPage } as Response;
      return { ok: false, status: 404, text: async () => '', json: async () => ({}) } as Response;
    }));

    const index = await crawlMaterialDocs({ cacheDir, maxPages: 5, minPageCount: 1, force: true });

    const orphanDiagnostic = index.extractionDiagnostics?.routeDiagnostics?.find((d) => d.path === 'components/orphan.md');
    expect(orphanDiagnostic).toMatchObject({
      sourceUsed: 'skipped',
      skippedReason: 'missing-page-reference',
      pageReferenceSource: 'missing'
    });
    // Never attempted — must not count toward any failure counter.
    expect(index.failedPageCount).toBe(0);
    expect(index.extractionDiagnostics?.pagesFailed).toBe(0);
    expect(index.extractionDiagnostics?.sourcePagesFailed).toBe(0);
    // Unresolved routes are classified and counted separately from genuine extraction failures.
    expect(index.coverageDiagnostics?.unresolvedSourceRouteCount).toBe(1);
    expect(index.coverageDiagnostics?.skippedMissingPageReferenceCount).toBe(1);
  }, 10_000);

  it('classifies a bare top-level index route with no real content as skipped:non-content-index, not failed', async () => {
    const html = '<html><body><script src="/static/angular/main.abcdef12.js"></script></body></html>';
    const mainJs = [
      '"carbonVersion":"cv-123"',
      '"slug":"components/lists/overview","documentId":"doc-lists","collectionId":"20543ce18892f7d9","collectionName":"ComponentsM3","pageCanonId":"page-canon-lists","exportedCarbonFileId":"page-canon-lists.json"',
      '"slug":"components","documentId":"doc-components-index","collectionId":"20543ce18892f7d9","collectionName":"ComponentsM3","pageCanonId":"page-canon-components-index","exportedCarbonFileId":"page-canon-components-index.json"'
    ].join(',');
    const pageData = { result: { pageContext: { title: 'Lists', documentId: 'doc-lists', pageCanonId: 'page-canon-lists', slug: 'components/lists/overview' } } };
    const contentPage = {
      title: 'Lists',
      sections: [{ name: 'Overview', contentBlocks: [{ title: 'Usage', contentChunks: [{ contentChunkType: 'TEXT', htmlValue: '<p>Lists present multiple line items in a compact column with enough text for validation.</p>' }] }] }]
    };
    // /components: page-data exists but content-page has no title and no sections — a navigation
    // landing page, not a content page.
    const componentsPageData = { result: { pageContext: { documentId: 'doc-components-index', pageCanonId: 'page-canon-components-index', slug: 'components' } } };
    const componentsContentPage = { sections: [] };

    vi.stubGlobal('fetch', vi.fn(async (input: string | URL) => {
      const url = String(input);
      if (url === 'https://m3.material.io') return { ok: true, text: async () => html } as Response;
      if (url === 'https://m3.material.io/site_meta.js') return { ok: true, text: async () => siteMetaJsText(['components/lists/overview', 'components']) } as Response;
      if (url === 'https://m3.material.io/static/angular/main.abcdef12.js') return { ok: true, text: async () => mainJs } as Response;
      if (url === 'https://m3.material.io/page-data/ComponentsM3/doc-lists.json') return { ok: true, json: async () => pageData } as Response;
      if (url === 'https://m3.material.io/_dsm/content/m3/cv-123/page-canon-lists.json') return { ok: true, json: async () => contentPage } as Response;
      if (url === 'https://m3.material.io/page-data/ComponentsM3/doc-components-index.json') return { ok: true, json: async () => componentsPageData } as Response;
      if (url === 'https://m3.material.io/_dsm/content/m3/cv-123/page-canon-components-index.json') return { ok: true, json: async () => componentsContentPage } as Response;
      return { ok: false, status: 404, text: async () => '', json: async () => ({}) } as Response;
    }));

    const index = await crawlMaterialDocs({ cacheDir, maxPages: 5, minPageCount: 1, force: true });

    const componentsDiagnostic = index.extractionDiagnostics?.routeDiagnostics?.find((d) => d.path === 'components.md');
    expect(componentsDiagnostic).toMatchObject({
      sourceUsed: 'skipped',
      skippedReason: 'non-content-index'
    });
    // Not counted as a failed extraction — it was never expected to produce a content page.
    expect(index.extractionDiagnostics?.pagesFailed).toBe(0);
    expect(index.extractionDiagnostics?.sourcePagesFailed).toBe(0);
    expect(index.coverageDiagnostics?.skippedNonContentIndexCount).toBe(1);
  }, 10_000);

  it('rejects the update when site_meta.js fails instead of falling back to the bundle table as a full route source', async () => {
    const html = '<html><body><script src="/static/angular/main.abcdef12.js"></script></body></html>';
    const mainJs = '"carbonVersion":"cv-123","slug":"components/lists/overview","documentId":"doc-lists","collectionId":"20543ce18892f7d9","collectionName":"ComponentsM3","pageCanonId":"page-canon-lists","exportedCarbonFileId":"page-canon-lists.json"';

    vi.stubGlobal('fetch', vi.fn(async (input: string | URL) => {
      const url = String(input);
      if (url === 'https://m3.material.io') return { ok: true, text: async () => html } as Response;
      if (url === 'https://m3.material.io/site_meta.js') return { ok: false, status: 404, text: async () => '', json: async () => ({}) } as Response;
      if (url === 'https://m3.material.io/static/angular/main.abcdef12.js') return { ok: true, text: async () => mainJs } as Response;
      return { ok: false, status: 404, text: async () => '', json: async () => ({}) } as Response;
    }));

    await expect(crawlMaterialDocs({ cacheDir, maxPages: 5, minPageCount: 1 })).rejects.toThrow(/site_meta\.js/i);
    expect(playwrightMock.chromium.launch).not.toHaveBeenCalled();
    await expect(readFile(indexPath(cacheDir), 'utf8')).rejects.toThrow();
  });
});
