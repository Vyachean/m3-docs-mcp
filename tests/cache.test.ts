import { mkdtemp, readFile, rm, stat, utimes, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { assertSafeCachePromotion, assertValidIndex, cacheAgeMs, cacheStatus, createStagingCacheDir, ensureCacheDirs, getDefaultCacheDir, indexPath, isCacheFresh, pagesDir, promoteStagingCache, readIndex, readPage, writeIndex, writePage } from '../src/cache.js';
import type { MaterialIndex, MaterialPage } from '../src/types.js';

let cacheDir: string;
const originalCacheDir = process.env.M3_DOCS_CACHE_DIR;
const originalXdgCacheHome = process.env.XDG_CACHE_HOME;

const page: MaterialPage = {
  id: 'page-1',
  title: 'Dialogs',
  url: 'https://m3.material.io/components/dialogs/overview',
  path: 'components/dialogs/overview.md',
  section: 'components/dialogs',
  headings: ['Dialogs', 'Usage'],
  text: 'Dialogs display important information and actions.',
  markdown: '# Dialogs\n\nDialogs display important information and actions.\n',
  capturedAt: '2026-05-18T00:00:00.000Z'
};

const index: MaterialIndex = {
  source: 'https://m3.material.io',
  capturedAt: '2026-05-18T00:00:00.000Z',
  pageCount: 1,
  attemptedPageCount: 1,
  failedPageCount: 0,
  failedUrls: [],
  pages: [page]
};

function materialIndex(pageCount: number, overrides: Partial<MaterialIndex> = {}): MaterialIndex {
  const pages = Array.from({ length: pageCount }, (_, i) => ({
    ...page,
    id: `page-${i}`,
    path: `components/page-${i}/overview.md`,
    url: `https://m3.material.io/components/page-${i}/overview`
  }));
  return {
    source: 'https://m3.material.io',
    capturedAt: '2026-05-18T00:00:00.000Z',
    pageCount,
    attemptedPageCount: pageCount,
    failedPageCount: 0,
    failedUrls: [],
    pages,
    ...overrides
  };
}

describe('cache helpers', () => {
  beforeEach(async () => {
    cacheDir = await mkdtemp(path.join(tmpdir(), 'm3-docs-cache-test-'));
    delete process.env.M3_DOCS_CACHE_DIR;
    delete process.env.XDG_CACHE_HOME;
  });

  afterEach(async () => {
    await rm(cacheDir, { recursive: true, force: true });
    await rm(`${cacheDir}.previous`, { recursive: true, force: true });
    if (originalCacheDir === undefined) delete process.env.M3_DOCS_CACHE_DIR;
    else process.env.M3_DOCS_CACHE_DIR = originalCacheDir;
    if (originalXdgCacheHome === undefined) delete process.env.XDG_CACHE_HOME;
    else process.env.XDG_CACHE_HOME = originalXdgCacheHome;
  });

  it('uses explicit cache directory before platform defaults', () => {
    process.env.M3_DOCS_CACHE_DIR = path.join(cacheDir, 'explicit');
    process.env.XDG_CACHE_HOME = path.join(cacheDir, 'xdg');
    expect(getDefaultCacheDir()).toBe(path.join(cacheDir, 'explicit'));
  });

  it('uses XDG cache directory when no explicit cache directory is set', () => {
    process.env.XDG_CACHE_HOME = path.join(cacheDir, 'xdg');
    expect(getDefaultCacheDir()).toBe(path.join(cacheDir, 'xdg', 'm3-docs-mcp'));
  });

  it('resolves index and pages paths inside the supplied cache directory', () => {
    expect(indexPath(cacheDir)).toBe(path.join(cacheDir, 'index.json'));
    expect(pagesDir(cacheDir)).toBe(path.join(cacheDir, 'pages'));
  });

  it('creates cache directories', async () => {
    await ensureCacheDirs(cacheDir);
    expect((await stat(pagesDir(cacheDir))).isDirectory()).toBe(true);
    expect(await cacheAgeMs(cacheDir)).toBeNull();
  });

  it('returns null when the index is missing or invalid', async () => {
    expect(await readIndex(cacheDir)).toBeNull();
    await ensureCacheDirs(cacheDir);
    await writeFile(indexPath(cacheDir), '{not json', 'utf8');
    expect(await readIndex(cacheDir)).toBeNull();
  });

  it('normalizes legacy documentation indexes with missing optional fields', async () => {
    await ensureCacheDirs(cacheDir);
    await writeFile(indexPath(cacheDir), JSON.stringify({ pages: [page] }), 'utf8');
    await expect(readIndex(cacheDir)).resolves.toMatchObject({
      source: 'https://m3.material.io',
      pageCount: 1,
      attemptedPageCount: 1,
      failedPageCount: 0,
      failedUrls: []
    });
  });

  it('writes and reads the documentation index', async () => {
    await writeIndex(index, cacheDir);
    await expect(readIndex(cacheDir)).resolves.toEqual(index);
    const age = await cacheAgeMs(cacheDir);
    expect(age).toEqual(expect.any(Number));
    expect(age).toBeGreaterThanOrEqual(0);
    expect(age).toBeLessThan(60 * 1000);
  });

  it('clamps cache age to zero when filesystem mtime is slightly ahead of Date.now', async () => {
    await writeIndex(index, cacheDir);
    const futureDate = new Date(Date.now() + 1000);
    await utimes(indexPath(cacheDir), futureDate, futureDate);

    await expect(cacheAgeMs(cacheDir)).resolves.toBe(0);
  });

  it('writes nested markdown pages and reads them back as utf8', async () => {
    const unicodePage = { ...page, markdown: '# Dialogs\n\nПример с Unicode и эмодзи ✓\n' };
    await writePage(unicodePage, cacheDir);
    await expect(readPage(unicodePage.path, cacheDir)).resolves.toBe(unicodePage.markdown);
  });

  it('checks cache freshness from age in milliseconds', () => {
    expect(isCacheFresh(null, 24)).toBe(false);
    expect(isCacheFresh(60 * 60 * 1000, 2)).toBe(true);
    expect(isCacheFresh(2 * 60 * 60 * 1000, 2)).toBe(false);
    expect(isCacheFresh(3 * 60 * 60 * 1000, 2)).toBe(false);
  });

  it('reports cache status without mutating the cache', async () => {
    await writeIndex(index, cacheDir);
    const oldDate = new Date(Date.now() - 3 * 60 * 60 * 1000);
    await utimes(indexPath(cacheDir), oldDate, oldDate);

    await expect(cacheStatus(cacheDir, 2)).resolves.toMatchObject({
      cacheDir,
      hasCache: true,
      capturedAt: index.capturedAt,
      pageCount: 1,
      attemptedPageCount: 1,
      failedPageCount: 0,
      failedUrls: [],
      isFresh: false
    });
  });

  it('reports missing cache status explicitly', async () => {
    await expect(cacheStatus(cacheDir, 2)).resolves.toMatchObject({
      cacheDir,
      hasCache: false,
      capturedAt: null,
      pageCount: 0,
      attemptedPageCount: 0,
      failedPageCount: 0,
      failedUrls: [],
      ageMs: null,
      isFresh: false
    });
  });

  it('creates staging cache directories next to the target cache', async () => {
    const stagingDir = await createStagingCacheDir(cacheDir);
    expect(path.dirname(stagingDir)).toBe(path.dirname(cacheDir));
    expect(path.basename(stagingDir)).toMatch(/^\.m3-docs-mcp-staging-/);
    expect((await stat(stagingDir)).isDirectory()).toBe(true);
    await rm(stagingDir, { recursive: true, force: true });
  });

  it('promotes a staging cache over an existing cache', async () => {
    await writeIndex(index, cacheDir);
    const stagingDir = await createStagingCacheDir(cacheDir);
    const nextIndex = { ...index, capturedAt: '2026-05-19T00:00:00.000Z' };
    await writeIndex(nextIndex, stagingDir);

    await promoteStagingCache(stagingDir, cacheDir);

    expect(await readIndex(cacheDir)).toEqual(nextIndex);
    await expect(readFile(indexPath(stagingDir), 'utf8')).rejects.toThrow();
    await expect(readFile(indexPath(`${cacheDir}.previous`), 'utf8')).rejects.toThrow();
  });

  it('promotes a staging cache when no existing cache is present', async () => {
    await rm(cacheDir, { recursive: true, force: true });
    const stagingDir = await createStagingCacheDir(cacheDir);
    await writeIndex(index, stagingDir);

    await promoteStagingCache(stagingDir, cacheDir);

    await expect(readIndex(cacheDir)).resolves.toEqual(index);
    await expect(readFile(indexPath(stagingDir), 'utf8')).rejects.toThrow();
  });

  it('rejects suspicious crawl results before cache promotion', () => {
    expect(() => assertValidIndex({ ...index, pageCount: 0, pages: [] }, 1)).toThrow('below the required minimum');
    expect(() => assertValidIndex({ ...index, pageCount: 1 }, 1)).not.toThrow();
    expect(() => assertValidIndex({ ...index, pageCount: 2 }, 1)).toThrow('inconsistent index');
  });

  it('allows safe cache promotion when the new crawl is close to the previous cache size', () => {
    expect(() => assertSafeCachePromotion(materialIndex(160), materialIndex(200))).not.toThrow();
    expect(() => assertSafeCachePromotion(materialIndex(10), null)).not.toThrow();
  });

  it('rejects degraded cache promotion unless forced', () => {
    const previousIndex = materialIndex(200);
    const degradedIndex = materialIndex(20);

    expect(() => assertSafeCachePromotion(degradedIndex, previousIndex)).toThrow('below 80% of the previous cache');
    expect(() => assertSafeCachePromotion(degradedIndex, previousIndex, { force: true })).not.toThrow();
  });

  it('rejects crawls with too many failed pages unless forced', () => {
    const failedIndex = materialIndex(20, {
      attemptedPageCount: 25,
      failedPageCount: 6,
      failedUrls: Array.from({ length: 6 }, (_, i) => `https://m3.material.io/failing-${i}`)
    });

    expect(() => assertSafeCachePromotion(failedIndex, materialIndex(20))).toThrow('above the allowed 20%');
    expect(() => assertSafeCachePromotion(failedIndex, materialIndex(20), { force: true })).not.toThrow();
  });

  it('rejects duplicate crawled content unless forced', () => {
    const duplicatedIndex = materialIndex(2, {
      qualityReport: {
        rejectedRoutes: [],
        duplicateContent: [{ hash: 'same-body', title: 'Components', paths: ['components/buttons.md', 'components/dialogs.md'], urls: ['https://m3.material.io/components/buttons', 'https://m3.material.io/components/dialogs'] }],
        suspiciousPages: [],
        shortPages: [],
        duplicateTitles: [],
        pagesBySection: { components: 2 }
      }
    });

    expect(() => assertSafeCachePromotion(duplicatedIndex, null)).toThrow('duplicate page content');
    expect(() => assertSafeCachePromotion(duplicatedIndex, null, { force: true })).not.toThrow();
  });

  it('rejects suspicious crawled content unless forced', () => {
    const suspiciousIndex = materialIndex(1, {
      qualityReport: {
        rejectedRoutes: [{ url: 'https://m3.material.io/components/buttons', path: 'components/buttons.md', title: 'Components', reason: 'component route rendered the parent Components index instead of buttons', classification: 'route-mismatch', status: 'failed' }],
        duplicateContent: [],
        suspiciousPages: [{ url: 'https://m3.material.io/components/buttons', path: 'components/buttons.md', title: 'Components', reason: 'component route rendered the parent Components index instead of buttons' }],
        shortPages: [],
        duplicateTitles: [],
        pagesBySection: { components: 1 }
      }
    });

    expect(() => assertSafeCachePromotion(suspiciousIndex, null)).toThrow('suspicious page content');
    expect(() => assertSafeCachePromotion(suspiciousIndex, null, { force: true })).not.toThrow();
  });

  it('rejects not found candidate content before promotion unless forced', () => {
    const suspiciousIndex = materialIndex(1, {
      qualityReport: {
        rejectedRoutes: [{ url: 'https://m3.material.io/foundations/layout-overview/adaptive-design', path: 'foundations/layout-overview/adaptive-design.md', title: 'Page not found', reason: 'route rendered a not found page', classification: 'not-found', status: 'failed' }],
        duplicateContent: [],
        suspiciousPages: [{ url: 'https://m3.material.io/foundations/layout-overview/adaptive-design', path: 'foundations/layout-overview/adaptive-design.md', title: 'Page not found', reason: 'route rendered a not found page' }],
        shortPages: [],
        duplicateTitles: [],
        pagesBySection: { 'foundations/layout-overview': 1 }
      }
    });

    expect(() => assertSafeCachePromotion(suspiciousIndex, null)).toThrow('route rendered a not found page');
    expect(() => assertSafeCachePromotion(suspiciousIndex, null, { force: true })).not.toThrow();
  });

  it('does not reject small crawls by failure ratio alone', () => {
    const smallIndex = materialIndex(3, {
      attemptedPageCount: 4,
      failedPageCount: 1,
      failedUrls: ['https://m3.material.io/failing']
    });

    expect(() => assertSafeCachePromotion(smallIndex, null)).not.toThrow();
  });
});
