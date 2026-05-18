import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { MaterialIndex, RefreshOptions } from '../src/types.js';

const crawlerMock = vi.hoisted(() => ({
  crawlMaterialDocs: vi.fn<(options: RefreshOptions & { cacheDir?: string }) => Promise<MaterialIndex>>()
}));

vi.mock('../src/crawler.js', () => ({
  crawlMaterialDocs: crawlerMock.crawlMaterialDocs
}));

const { MaterialDocsStore } = await import('../src/store.js');

let cacheDir: string;

const index: MaterialIndex = {
  source: 'https://m3.material.io',
  capturedAt: '2026-05-18T00:00:00.000Z',
  pageCount: 1,
  attemptedPageCount: 1,
  failedPageCount: 0,
  failedUrls: [],
  pages: [{
    id: 'dialogs',
    title: 'Dialogs',
    url: 'https://m3.material.io/components/dialogs/overview',
    path: 'components/dialogs/overview.md',
    section: 'components/dialogs',
    headings: ['Dialogs'],
    capturedAt: '2026-05-18T00:00:00.000Z'
  }]
};

describe('MaterialDocsStore refresh concurrency', () => {
  beforeEach(async () => {
    cacheDir = await mkdtemp(path.join(tmpdir(), 'm3-docs-store-refresh-test-'));
    crawlerMock.crawlMaterialDocs.mockReset();
  });

  afterEach(async () => {
    await rm(cacheDir, { recursive: true, force: true });
  });

  it('deduplicates concurrent refresh calls and clears the lock after completion', async () => {
    let resolveFirstRefresh: (value: MaterialIndex) => void = () => undefined;
    crawlerMock.crawlMaterialDocs.mockImplementationOnce(() => new Promise<MaterialIndex>((resolve) => { resolveFirstRefresh = resolve; }));
    crawlerMock.crawlMaterialDocs.mockResolvedValue(index);

    const store = new MaterialDocsStore(cacheDir);
    const first = store.refresh({ maxPages: 250 });
    const second = store.refresh({ maxPages: 500 });

    expect(crawlerMock.crawlMaterialDocs).toHaveBeenCalledTimes(1);
    expect(crawlerMock.crawlMaterialDocs).toHaveBeenCalledWith({ cacheDir, maxPages: 250 });

    resolveFirstRefresh(index);
    await expect(Promise.all([first, second])).resolves.toEqual([index, index]);

    await expect(store.refresh({ maxPages: 10 })).resolves.toBe(index);
    expect(crawlerMock.crawlMaterialDocs).toHaveBeenCalledTimes(2);
    expect(crawlerMock.crawlMaterialDocs).toHaveBeenLastCalledWith({ cacheDir, maxPages: 10 });
  });

  it('passes forced refresh requests to the crawler', async () => {
    crawlerMock.crawlMaterialDocs.mockResolvedValue(index);
    const store = new MaterialDocsStore(cacheDir);

    await expect(store.refresh({ maxPages: 25, concurrency: 4, force: true })).resolves.toBe(index);

    expect(crawlerMock.crawlMaterialDocs).toHaveBeenCalledWith({ cacheDir, maxPages: 25, concurrency: 4, force: true });
  });

  it('clears the refresh lock after a failed refresh', async () => {
    crawlerMock.crawlMaterialDocs.mockRejectedValueOnce(new Error('crawl failed'));
    crawlerMock.crawlMaterialDocs.mockResolvedValue(index);

    const store = new MaterialDocsStore(cacheDir);

    await expect(store.refresh({ maxPages: 250 })).rejects.toThrow('crawl failed');
    await expect(store.refresh({ maxPages: 25 })).resolves.toBe(index);

    expect(crawlerMock.crawlMaterialDocs).toHaveBeenCalledTimes(2);
    expect(crawlerMock.crawlMaterialDocs).toHaveBeenLastCalledWith({ cacheDir, maxPages: 25 });
  });
});
