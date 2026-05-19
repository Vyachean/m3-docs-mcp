import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { CacheStatus, SearchResult } from '../src/types.js';

const mocks = vi.hoisted(() => {
  const createdStores: MockStore[] = [];
  const nextStores: MockStore[] = [];

  type MockStore = {
    cacheDir?: string;
    getStatus: ReturnType<typeof vi.fn<(maxAgeHours?: number) => Promise<CacheStatus>>>;
    searchDocs: ReturnType<typeof vi.fn<(query: string, limit: number) => Promise<SearchResult[]>>>;
  };

  const makeStatus = (overrides: Partial<CacheStatus> = {}): CacheStatus => ({
    cacheDir: '/cache',
    hasCache: true,
    capturedAt: '2026-05-18T00:00:00.000Z',
    pageCount: 1,
    attemptedPageCount: 1,
    failedPageCount: 0,
    failedUrls: [],
    ageMs: 60_000,
    isFresh: true,
    ...overrides
  });

  const makeStore = (status: CacheStatus = makeStatus()): MockStore => ({
    getStatus: vi.fn(async () => status),
    searchDocs: vi.fn(async () => [{
      title: 'Dialogs',
      url: 'https://m3.material.io/components/dialogs/overview',
      path: 'components/dialogs/overview.md',
      section: 'components/dialogs',
      headings: ['Dialogs'],
      score: 1,
      excerpt: 'Dialog actions guidance'
    }])
  });

  return { createdStores, nextStores, makeStatus, makeStore };
});

vi.mock('../src/cache.js', () => ({
  getDefaultCacheDir: () => '/default-cache'
}));

vi.mock('../src/store.js', () => ({
  MaterialDocsStore: class {
    constructor(cacheDir: string) {
      const store = mocks.nextStores.shift() ?? mocks.makeStore();
      store.cacheDir = cacheDir;
      mocks.createdStores.push(store);
      Object.assign(this, store);
    }
  }
}));

const { CACHE_MISSING_UPDATE_COMMAND, readCachedResult } = await import('../src/cli-read.js');

describe('CLI cache read fallback', () => {
  beforeEach(() => {
    mocks.createdStores.length = 0;
    mocks.nextStores.length = 0;
  });

  it('returns JSON-ready results from the requested cache directory', async () => {
    const store = mocks.makeStore();
    mocks.nextStores.push(store);

    const result = await readCachedResult(
      { cacheDir: '/custom-cache', maxAgeHours: '24' },
      'results',
      [],
      (materialStore) => materialStore.searchDocs('dialogs actions', 5)
    );

    expect(result.exitCode).toBeUndefined();
    expect(store.cacheDir).toBe('/custom-cache');
    expect(store.getStatus).toHaveBeenCalledWith(24);
    expect(store.searchDocs).toHaveBeenCalledWith('dialogs actions', 5);
    expect(result.value).toMatchObject({
      status: { hasCache: true, isFresh: true },
      results: [{ title: 'Dialogs', path: 'components/dialogs/overview.md' }]
    });
  });

  it('returns exit code 2 and a GitHub npx update command when cache is missing', async () => {
    const store = mocks.makeStore(mocks.makeStatus({
      hasCache: false,
      capturedAt: null,
      pageCount: 0,
      attemptedPageCount: 0,
      ageMs: null,
      isFresh: false
    }));
    mocks.nextStores.push(store);

    const result = await readCachedResult(
      { maxAgeHours: '168' },
      'results',
      [],
      (materialStore) => materialStore.searchDocs('dialogs actions', 5)
    );

    expect(result.exitCode).toBe(2);
    expect(store.cacheDir).toBe('/default-cache');
    expect(store.searchDocs).not.toHaveBeenCalled();
    expect(result.value).toEqual({
      status: expect.objectContaining({ hasCache: false, pageCount: 0, isFresh: false }),
      message: `Material 3 docs cache is not available. Run: ${CACHE_MISSING_UPDATE_COMMAND}`,
      results: []
    });
  });
});
