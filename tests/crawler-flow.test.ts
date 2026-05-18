import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { indexPath, pagesDir, writeIndex } from '../src/cache.js';
import type { MaterialIndex } from '../src/types.js';

const playwrightMock = vi.hoisted(() => {
  let currentUrl = '';
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

  const normalize = (value: string) => value.toLowerCase().replace(/&/g, ' and ').replace(/[^a-z0-9]+/g, ' ').replace(/\s+/g, ' ').trim();
  const htmlText = (html: string) => html.replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim();
  const contentMatchesComponent = (componentSlug: string | null | undefined): boolean => {
    const current = pagesByUrl[currentUrl];
    if (!current) return false;
    if (!componentSlug) return htmlText(current.html).length > 80 && Boolean(current.title);

    const pathname = new URL(current.finalUrl ?? currentUrl).pathname.replace(/^\/+|\/+$/g, '');
    const title = normalize(current.title);
    const text = normalize(`${current.title} ${htmlText(current.html)}`);
    const componentWords = normalize(componentSlug.replace(/-/g, ' ')).split(' ').filter((word) => word.length > 1);
    const pathMatches = pathname === `components/${componentSlug}` || pathname === `components/${componentSlug}/overview` || pathname.startsWith(`components/${componentSlug}/`);
    return pathMatches && title !== 'components' && !title.includes('page cannot be found') && componentWords.every((word) => text.includes(word));
  };

  const page = {
    goto: vi.fn(async (url: string) => { currentUrl = url; }),
    url: vi.fn(() => pagesByUrl[currentUrl]?.finalUrl ?? currentUrl),
    waitForSelector: vi.fn(async () => undefined),
    waitForFunction: vi.fn(async (_fn: unknown, arg?: { componentSlug?: string | null }) => {
      if (!contentMatchesComponent(arg?.componentSlug)) throw new Error(`condition did not match for ${currentUrl}`);
    }),
    close: vi.fn(async () => undefined),
    evaluate: vi.fn(async (fn: () => unknown) => {
      const source = fn.toString();
      if (source.includes('details:not([open])')) {
        const current = pagesByUrl[currentUrl];
        if (current?.routeAfterExpansion) currentUrl = current.routeAfterExpansion;
        return undefined;
      }
      if (source.includes('querySelectorAll') && source.includes('a[href]')) return pagesByUrl[currentUrl]?.links ?? [];
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
    pagesByUrl
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
    playwrightMock.page.waitForSelector.mockClear();
    playwrightMock.page.waitForFunction.mockClear();
    playwrightMock.page.close.mockClear();
    playwrightMock.page.evaluate.mockClear();
    delete playwrightMock.pagesByUrl['https://m3.material.io/components/dialogs'];
    delete playwrightMock.pagesByUrl['https://m3.material.io/components/buttons'];
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
    const index = await crawlMaterialDocs({ cacheDir, maxPages: 5, minPageCount: 2 });

    expect(playwrightMock.chromium.launch).toHaveBeenCalledWith({ headless: true });
    expect(playwrightMock.page.goto).toHaveBeenCalledWith('https://m3.material.io', { waitUntil: 'domcontentloaded', timeout: 45000 });
    expect(playwrightMock.page.goto).toHaveBeenCalledWith('https://m3.material.io/components/dialogs', { waitUntil: 'domcontentloaded', timeout: 45000 });
    expect(playwrightMock.page.goto).toHaveBeenCalledWith('https://m3.material.io/components/dialogs/overview', { waitUntil: 'domcontentloaded', timeout: 45000 });
    expect(playwrightMock.page.goto).not.toHaveBeenCalledWith('https://example.com/external', expect.anything());
    expect(playwrightMock.page.waitForSelector).toHaveBeenCalled();
    expect(playwrightMock.page.waitForFunction).toHaveBeenCalled();
    expect(playwrightMock.page.close).toHaveBeenCalledTimes(2);
    expect(playwrightMock.browser.close).toHaveBeenCalledTimes(1);

    expect(index).toMatchObject({
      source: 'https://m3.material.io',
      pageCount: 2,
      attemptedPageCount: 3,
      failedPageCount: 0,
      failedUrls: [],
      qualityReport: {
        duplicateContent: [],
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

    const index = await crawlMaterialDocs({ cacheDir, maxPages: 2, minPageCount: 2 });

    expect(index.pages.map((page) => page.path).sort()).toEqual(['foundations/layout/canonical-layouts.md', 'index.md']);
    expect(playwrightMock.page.goto).not.toHaveBeenCalledWith('https://m3.material.io/blog/ignored', expect.anything());
  });

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

    const index = await crawlMaterialDocs({ cacheDir, maxPages: 2, minPageCount: 2 });

    expect(index.pages.map((page) => page.path).sort()).toEqual(['foundations/layout/canonical-layouts.md', 'index.md']);
    expect(playwrightMock.page.goto).not.toHaveBeenCalledWith('https://m3.material.io/blog/ignored', expect.anything());
  });

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

    await expect(crawlMaterialDocs({ cacheDir, maxPages: 5, minPageCount: 2 })).rejects.toThrow('below the required minimum');

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

    await expect(crawlMaterialDocs({ cacheDir, maxPages: 5, minPageCount: 2 })).rejects.toThrow('below the required minimum');

    await expect(readFile(path.join(pagesDir(cacheDir), 'components/buttons/overview.md'), 'utf8')).rejects.toThrow();
  });

  it('keeps the old cache when the crawl result is below the minimum accepted page count', async () => {
    await expect(crawlMaterialDocs({ cacheDir, maxPages: 1, minPageCount: 2 })).rejects.toThrow('below the required minimum');
    await expect(readFile(indexPath(cacheDir), 'utf8')).rejects.toThrow();
  });

  it('keeps the old cache when a new crawl would severely reduce page count', async () => {
    const oldIndex = existingIndex(5);
    await writeIndex(oldIndex, cacheDir);

    await expect(crawlMaterialDocs({ cacheDir, maxPages: 1, minPageCount: 1 })).rejects.toThrow('below 80% of the previous cache');

    const persistedIndex = JSON.parse(await readFile(indexPath(cacheDir), 'utf8')) as MaterialIndex;
    expect(persistedIndex).toEqual(oldIndex);
  });

  it('allows explicitly forced replacement of a larger old cache', async () => {
    const oldIndex = existingIndex(5);
    await writeIndex(oldIndex, cacheDir);

    const nextIndex = await crawlMaterialDocs({ cacheDir, maxPages: 1, minPageCount: 1, force: true });

    expect(nextIndex.pageCount).toBe(1);
    const persistedIndex = JSON.parse(await readFile(indexPath(cacheDir), 'utf8')) as MaterialIndex;
    expect(persistedIndex.pageCount).toBe(1);
    expect(persistedIndex.pages[0]?.path).toBe('index.md');
  });
});
