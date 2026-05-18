import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { indexPath, pagesDir, writeIndex } from '../src/cache.js';
import type { MaterialIndex } from '../src/types.js';

const playwrightMock = vi.hoisted(() => {
  let currentUrl = '';
  const pagesByUrl: Record<string, { html: string; title: string; headings: string[]; links: string[] }> = {
    'https://m3.material.io': {
      html: '<h1>Material 3</h1><p>Material 3 documentation landing page with enough text for crawler validation and indexing.</p>',
      title: 'Material 3',
      headings: ['Material 3'],
      links: [
        'https://m3.material.io/components/dialogs/overview?tab=usage#actions',
        'https://example.com/external',
        'https://m3.material.io/assets/logo.svg'
      ]
    },
    'https://m3.material.io/components/dialogs/overview': {
      html: '<h1>Dialogs</h1><p>Dialogs provide important prompts and decisions with enough body text for crawler validation.</p><h2>Usage</h2><p>Use dialogs for focused tasks.</p>',
      title: 'Dialogs',
      headings: ['Dialogs', 'Usage'],
      links: []
    }
  };

  const page = {
    goto: vi.fn(async (url: string) => { currentUrl = url; }),
    evaluate: vi.fn(async (fn: () => unknown) => {
      const source = fn.toString();
      if (source.includes('querySelectorAll') && source.includes('a[href]')) return pagesByUrl[currentUrl]?.links ?? [];
      if (source.includes('clone.innerHTML')) {
        const current = pagesByUrl[currentUrl];
        return current ? { html: current.html, title: current.title, headings: current.headings } : { html: '', title: '', headings: [] };
      }
      return undefined;
    })
  };
  const browser = {
    newContext: vi.fn(async () => ({ newPage: vi.fn(async () => page) })),
    close: vi.fn(async () => undefined)
  };

  return {
    chromium: { launch: vi.fn(async () => browser) },
    browser,
    page
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
    playwrightMock.chromium.launch.mockClear();
    playwrightMock.browser.close.mockClear();
    playwrightMock.page.goto.mockClear();
    playwrightMock.page.evaluate.mockClear();
  });

  afterEach(async () => {
    await rm(cacheDir, { recursive: true, force: true });
  });

  it('crawls discovered same-origin documentation pages into a promoted cache', async () => {
    const index = await crawlMaterialDocs({ cacheDir, maxPages: 5, minPageCount: 2 });

    expect(playwrightMock.chromium.launch).toHaveBeenCalledWith({ headless: true });
    expect(playwrightMock.page.goto).toHaveBeenCalledWith('https://m3.material.io', { waitUntil: 'networkidle', timeout: 45000 });
    expect(playwrightMock.page.goto).toHaveBeenCalledWith('https://m3.material.io/components/dialogs/overview', { waitUntil: 'networkidle', timeout: 45000 });
    expect(playwrightMock.page.goto).not.toHaveBeenCalledWith('https://example.com/external', expect.anything());
    expect(playwrightMock.browser.close).toHaveBeenCalledTimes(1);

    expect(index).toMatchObject({
      source: 'https://m3.material.io',
      pageCount: 2,
      attemptedPageCount: 2,
      failedPageCount: 0,
      failedUrls: []
    });
    expect(index.pages.map((page) => page.path).sort()).toEqual(['components/dialogs/overview.md', 'index.md']);
    expect(index.pages.find((page) => page.path === 'components/dialogs/overview.md')).toMatchObject({
      title: 'Dialogs',
      headings: ['Dialogs', 'Usage']
    });

    const persistedIndex = JSON.parse(await readFile(indexPath(cacheDir), 'utf8')) as MaterialIndex;
    expect(persistedIndex.pageCount).toBe(2);
    await expect(readFile(path.join(pagesDir(cacheDir), 'components/dialogs/overview.md'), 'utf8')).resolves.toContain('# Dialogs');
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
