import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { indexPath, pagesDir } from '../src/cache.js';
import type { MaterialIndex } from '../src/types.js';

const playwrightMock = vi.hoisted(() => {
  let currentUrl = '';
  const pagesByUrl: Record<string, { html: string; links: string[] }> = {
    'https://m3.material.io': {
      html: '<main><h1>Material 3</h1><p>Material 3 documentation landing page with enough text for crawler validation and indexing.</p></main>',
      links: [
        'https://m3.material.io/components/dialogs/overview?tab=usage#actions',
        'https://example.com/external',
        'https://m3.material.io/assets/logo.svg'
      ]
    },
    'https://m3.material.io/components/dialogs/overview': {
      html: '<main><h1>Dialogs</h1><p>Dialogs provide important prompts and decisions with enough body text for crawler validation.</p><h2>Usage</h2><p>Use dialogs for focused tasks.</p></main>',
      links: []
    }
  };

  const page = {
    goto: vi.fn(async (url: string) => { currentUrl = url; }),
    evaluate: vi.fn(async (fn: () => unknown) => {
      const source = fn.toString();
      if (source.includes('querySelectorAll') && source.includes('a[href]')) return pagesByUrl[currentUrl]?.links ?? [];
      if (source.includes('clone.innerHTML')) return pagesByUrl[currentUrl]?.html ?? '<main></main>';
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

    const persistedIndex = JSON.parse(await readFile(indexPath(cacheDir), 'utf8')) as MaterialIndex;
    expect(persistedIndex.pageCount).toBe(2);
    await expect(readFile(path.join(pagesDir(cacheDir), 'components/dialogs/overview.md'), 'utf8')).resolves.toContain('# Dialogs');
  });

  it('keeps the old cache when the crawl result is below the minimum accepted page count', async () => {
    await expect(crawlMaterialDocs({ cacheDir, maxPages: 1, minPageCount: 2 })).rejects.toThrow('below the required minimum');
    await expect(readFile(indexPath(cacheDir), 'utf8')).rejects.toThrow();
  });
});
