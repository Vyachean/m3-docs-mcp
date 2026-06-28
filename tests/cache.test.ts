import { mkdir, mkdtemp, readFile, rm, stat, utimes, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { assertSafeCachePromotion, assertValidIndex, cacheAgeMs, cacheStatus, computeCoverageHealth, createStagingCacheDir, ensureCacheDirs, getCacheDiagnostics, getDefaultCacheDir, indexPath, isCacheFresh, pagesDir, promoteStagingCache, readIndex, readPage, writeIndex, writePage } from '../src/cache.js';
import { createEmptyExtractionDiagnostics, pushRouteDiagnostic } from '../src/json-extraction/diagnostics.js';
import type { CoverageDiagnostics, ExtractionRouteDiagnostic, MaterialIndex, MaterialPage, RoutePlanSummary } from '../src/types.js';

const REQUIRED_SAMPLE_SLUGS = ['components/buttons/specs', 'components/lists/specs', 'styles/color/roles', 'foundations/design-tokens/overview'];

function requiredSampleDiagnostic(slug: string, overrides: Partial<ExtractionRouteDiagnostic> = {}): ExtractionRouteDiagnostic {
  return {
    url: `https://m3.material.io/${slug}`,
    path: `${slug}.md`,
    sourceUsed: 'direct-json',
    finalMethod: 'json',
    jsonAttempted: true,
    jsonSucceeded: true,
    browserFallbackAttempted: false,
    browserFallbackSucceeded: false,
    directJsonAttempted: true,
    directJsonSucceeded: true,
    unknownChunkTypes: [],
    unknownResourceTypes: [],
    tokenTables: 0,
    tokenTablesRendered: 0,
    missingRequestedTokenSets: [],
    ...overrides
  };
}

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

// Appends valid (saved + succeeded) entries for all four required sample routes, without touching
// pageCount/attemptedPageCount/failedPageCount — those stay whatever the test set them to, since
// many tests assert on the exact ratio math those fields drive. This only exists so that tests
// unrelated to required-sample validation don't have to know about it; tests that explicitly pass
// their own `extractionDiagnostics` override are exercising that check directly and are left alone.
function withRequiredSamples(index: MaterialIndex): MaterialIndex {
  const diag = createEmptyExtractionDiagnostics();
  const extraPages: MaterialPage[] = [];
  for (const slug of REQUIRED_SAMPLE_SLUGS) {
    pushRouteDiagnostic(diag, requiredSampleDiagnostic(slug));
    extraPages.push({
      ...page,
      id: `required-${slug}`,
      path: `${slug}.md`,
      url: `https://m3.material.io/${slug}`
    });
  }
  return { ...index, pages: [...index.pages, ...extraPages], extractionDiagnostics: diag };
}

function materialIndex(pageCount: number, overrides: Partial<MaterialIndex> = {}): MaterialIndex {
  const pages = Array.from({ length: pageCount }, (_, i) => ({
    ...page,
    id: `page-${i}`,
    path: `components/page-${i}/overview.md`,
    url: `https://m3.material.io/components/page-${i}/overview`
  }));
  const built: MaterialIndex = {
    source: 'https://m3.material.io',
    capturedAt: '2026-05-18T00:00:00.000Z',
    pageCount,
    attemptedPageCount: pageCount,
    failedPageCount: 0,
    failedUrls: [],
    pages,
    ...overrides
  };
  return overrides.extractionDiagnostics === undefined ? withRequiredSamples(built) : built;
}

function requiredSamplePages(): MaterialPage[] {
  return REQUIRED_SAMPLE_SLUGS.map((slug, i) => ({
    ...page,
    id: `req-${i}`,
    path: `${slug}.md`,
    url: `https://m3.material.io/${slug}`
  }));
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
    await expect(readIndex(cacheDir)).resolves.toMatchObject({
      source: index.source,
      capturedAt: index.capturedAt,
      pageCount: index.pageCount,
      attemptedPageCount: index.attemptedPageCount,
      failedPageCount: index.failedPageCount,
      failedUrls: index.failedUrls,
      pages: [{
        id: page.path,
        title: page.title,
        url: page.url,
        path: page.path,
        section: page.section,
        headings: page.headings,
        capturedAt: index.capturedAt
      }]
    });
    const rawIndex = JSON.parse(await readFile(indexPath(cacheDir), 'utf8')) as Record<string, unknown>;
    expect(rawIndex.extractionDiagnostics).toBeUndefined();
    expect(rawIndex.coverageDiagnostics).toBeUndefined();
    expect(rawIndex.qualityReport).toBeUndefined();
    expect(rawIndex.pages).toEqual([{
      path: page.path,
      title: page.title,
      sourceUrl: page.url,
      section: page.section,
      headings: page.headings
    }]);
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
      source: index.source,
      capturedAt: index.capturedAt,
      pageCount: 1,
      attemptedPageCount: 1,
      failedPageCount: 0,
      failedUrls: [],
      ttlMs: 2 * 60 * 60 * 1000,
      isFresh: false
    });
  });

  it('reports missing cache status explicitly', async () => {
    await expect(cacheStatus(cacheDir, 2)).resolves.toMatchObject({
      cacheDir,
      hasCache: false,
      source: null,
      capturedAt: null,
      pageCount: 0,
      attemptedPageCount: 0,
      failedPageCount: 0,
      failedUrls: [],
      ageMs: null,
      ttlMs: 2 * 60 * 60 * 1000,
      isFresh: false
    });
  });

  it('keeps verbose diagnostics out of default cacheStatus', async () => {
    await writeIndex({
      ...index,
      extractionDiagnostics: createEmptyExtractionDiagnostics(),
      coverageDiagnostics: minimalCoverageDiagnostics({ isLimitedRun: false })
    }, cacheDir);

    const status = await cacheStatus(cacheDir);
    expect(status).not.toHaveProperty('extractionDiagnostics');
    expect(status).not.toHaveProperty('coverageDiagnostics');
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

    expect(await readIndex(cacheDir)).toMatchObject({
      capturedAt: nextIndex.capturedAt,
      pages: [{ id: page.path, url: page.url, path: page.path }]
    });
    await expect(readFile(indexPath(stagingDir), 'utf8')).rejects.toThrow();
    await expect(readFile(indexPath(`${cacheDir}.previous`), 'utf8')).rejects.toThrow();
  });

  it('promotes a staging cache when no existing cache is present', async () => {
    await rm(cacheDir, { recursive: true, force: true });
    const stagingDir = await createStagingCacheDir(cacheDir);
    await writeIndex(index, stagingDir);

    await promoteStagingCache(stagingDir, cacheDir);

    await expect(readIndex(cacheDir)).resolves.toMatchObject({
      capturedAt: index.capturedAt,
      pages: [{ id: page.path, url: page.url, path: page.path }]
    });
    await expect(readFile(indexPath(stagingDir), 'utf8')).rejects.toThrow();
  });

  it('reads verbose diagnostics only from diagnostics/latest-update.json', async () => {
    const diagDir = path.join(cacheDir, 'diagnostics');
    await ensureCacheDirs(cacheDir);
    await mkdir(diagDir, { recursive: true });
    await writeFile(path.join(diagDir, 'latest-update.json'), JSON.stringify({
      extractionDiagnostics: {
        routeDiagnostics: [{ path: 'components/buttons/specs.md', sourceUsed: 'failed' }]
      },
      coverageDiagnostics: {
        uncrawledDiscoveredUrls: ['/missing']
      },
      networkRecoveryFailureReason: 'boom'
    }), 'utf8');

    const diagnostics = await getCacheDiagnostics(cacheDir);
    expect(diagnostics.latestDiagnosticsFile).toBe(path.join(diagDir, 'latest-update.json'));
    expect(diagnostics.diagnostics).toMatchObject({
      extractionDiagnostics: {
        routeDiagnostics: [{ path: 'components/buttons/specs.md', sourceUsed: 'failed' }]
      }
    });
    expect(diagnostics.networkRecoveryFailureReason).toBe('boom');
  });

  it('latest-update.json can persist verbose diagnostics while index.json stays compact', async () => {
    const fullRoutePlanSummary: RoutePlanSummary = {
      acceptedRoutes: [{
        route: '/components/switches',
        canonicalRoute: '/components/switch',
        outputPath: 'components/switch.md',
        sources: ['site_meta', 'bundle'],
        publicDocsClassification: 'public-docs' as const,
        reconciliationStatus: 'normalizedSlugMatch' as const
      }],
      staleRoutes: [{
        route: '/components/orphan',
        sources: ['site_meta'],
        publicDocsClassification: 'public-docs' as const,
        reconciliationStatus: 'rejectedStale' as const
      }],
      removedRoutes: [],
      ambiguousRoutes: [{
        route: '/components/cards',
        sources: ['site_meta'],
        publicDocsClassification: 'public-docs' as const,
        reconciliationStatus: 'rejectedAmbiguous' as const
      }],
      nonPublicRoutes: [{
        route: '/develop/android/compose',
        sources: ['bundle'],
        publicDocsClassification: 'unsupported-platform-or-policy' as const,
        reconciliationStatus: 'rejectedNonPublic' as const
      }],
      extractionCandidates: []
    };
    const fullIndex = materialIndex(1, {
      qualitySummary: {
        suspiciousPageCount: 1,
        rejectedRouteCount: 1,
        duplicateContentGroupCount: 0,
        shortPageCount: 0,
        duplicateTitleGroupCount: 0
      },
      qualityReport: {
        suspiciousPages: [{ url: 'https://m3.material.io/components/page-0/overview', path: 'components/page-0/overview.md', title: 'Page 0', reason: 'short-markdown' }],
        rejectedRoutes: [{ url: 'https://m3.material.io/components/missing', path: 'components/missing.md', title: 'Missing', reason: 'missing-page-reference', classification: 'route-mismatch', status: 'failed' }],
        duplicateContent: [],
        shortPages: [],
        duplicateTitles: [],
        pagesBySection: {}
      },
      extractionDiagnostics: (() => {
        const diag = createEmptyExtractionDiagnostics();
        pushRouteDiagnostic(diag, requiredSampleDiagnostic('components/buttons/specs'));
        pushRouteDiagnostic(diag, requiredSampleDiagnostic('components/missing', {
          path: 'components/missing.md',
          sourceUsed: 'skipped',
          finalMethod: null,
          jsonSucceeded: false,
          skippedReason: 'missing-page-reference',
          sourceRoute: 'components/missing',
          virtualRoute: 'components/missing.md'
        }));
        return diag;
      })(),
      coverageDiagnostics: minimalCoverageDiagnostics({
        isLimitedRun: false,
        routePlanSummary: {
          acceptedRouteCount: 1,
          staleRouteCount: 1,
          ambiguousRouteCount: 1,
          nonPublicRouteCount: 1,
          extractionCandidateCount: 1,
          reconciliationStatusCounts: { normalizedSlugMatch: 1, rejectedStale: 1, rejectedAmbiguous: 1, rejectedNonPublic: 1 },
          publicDocsClassificationCounts: { 'public-docs': 3, 'unsupported-platform-or-policy': 1 },
          problematicExamples: {
            staleRoutes: [{ route: '/components/orphan', reconciliationStatus: 'rejectedStale', publicDocsClassification: 'public-docs' }],
            ambiguousRoutes: [{ route: '/components/cards', reconciliationStatus: 'rejectedAmbiguous', publicDocsClassification: 'public-docs' }],
            nonPublicRoutes: [{ route: '/develop/android/compose', reconciliationStatus: 'rejectedNonPublic', publicDocsClassification: 'unsupported-platform-or-policy' }],
            unresolvedAcceptedRoutes: []
          }
        },
        fullRoutePlanSummary
      })
    });
    await writeIndex(fullIndex, cacheDir);

    const diagDir = path.join(cacheDir, 'diagnostics');
    await mkdir(diagDir, { recursive: true });
    await writeFile(path.join(diagDir, 'latest-update.json'), JSON.stringify({
      runId: 'run-1',
      startedAt: '2026-06-18T00:00:00.000Z',
      finishedAt: '2026-06-18T00:00:05.000Z',
      elapsedMs: 5000,
      cacheDir,
      stagingDir: `${cacheDir}.staging`,
      commandSummary: { command: 'update', maxPages: 25, maxPagesExplicit: true, allowBrowserFallback: false },
      promotionDecision: 'promoted',
      hasPreviousCache: true,
      previousPageCount: 9,
      generatedPageCount: 5,
      attemptedPages: 6,
      savedPages: 5,
      failedPages: 1,
      failedRoutes: ['https://m3.material.io/components/missing'],
      qualitySummary: fullIndex.qualitySummary,
      coverageHealth: fullIndex.coverageDiagnostics?.coverageHealth ?? null,
      extractionDiagnostics: fullIndex.extractionDiagnostics,
      coverageDiagnostics: fullIndex.coverageDiagnostics,
      qualityReport: fullIndex.qualityReport
    }), 'utf8');

    const rawIndex = JSON.parse(await readFile(indexPath(cacheDir), 'utf8')) as Record<string, unknown>;
    expect(rawIndex.extractionDiagnostics).toBeUndefined();
    expect(rawIndex.qualityReport).toBeUndefined();
    expect(rawIndex.coverageDiagnostics).toMatchObject({
      coverageHealth: fullIndex.coverageDiagnostics?.coverageHealth
    });
    expect(JSON.stringify(rawIndex.coverageDiagnostics)).not.toContain('fullRoutePlanSummary');

    const diagnostics = await getCacheDiagnostics(cacheDir);
    expect(diagnostics.diagnostics).toMatchObject({
      extractionDiagnostics: {
        routeDiagnostics: expect.arrayContaining([
          expect.objectContaining({ path: 'components/missing.md', skippedReason: 'missing-page-reference' })
        ])
      },
      coverageDiagnostics: expect.any(Object),
      qualityReport: {
        rejectedRoutes: expect.arrayContaining([
          expect.objectContaining({ reason: 'missing-page-reference' })
        ])
      }
    });
    expect(diagnostics.diagnostics).toMatchObject({
      coverageDiagnostics: {
        fullRoutePlanSummary: {
          acceptedRoutes: expect.arrayContaining([expect.objectContaining({ route: '/components/switches' })]),
          staleRoutes: expect.arrayContaining([expect.objectContaining({ route: '/components/orphan' })]),
          ambiguousRoutes: expect.arrayContaining([expect.objectContaining({ route: '/components/cards' })]),
          nonPublicRoutes: expect.arrayContaining([expect.objectContaining({ route: '/develop/android/compose' })]),
        }
      }
    });
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

  it('falls back to the legacy attemptedPageCount/failedPageCount ratio for old indexes without extraction diagnostics', () => {
    // No extractionDiagnostics field at all (built by hand, bypassing the materialIndex helper,
    // which always attaches one) — this is the only shape that should still exercise the legacy,
    // unit-mixed fallback ratio check.
    const failedIndex: MaterialIndex = {
      source: 'https://m3.material.io',
      capturedAt: '2026-05-18T00:00:00.000Z',
      pageCount: 20,
      attemptedPageCount: 25,
      failedPageCount: 6,
      failedUrls: Array.from({ length: 6 }, (_, i) => `https://m3.material.io/failing-${i}`),
      pages: Array.from({ length: 20 }, (_, i) => ({
        ...page,
        id: `page-${i}`,
        path: `components/page-${i}/overview.md`,
        url: `https://m3.material.io/components/page-${i}/overview`
      }))
    };

    expect(() => assertSafeCachePromotion(failedIndex, null)).toThrow('above the allowed 20%');
    expect(() => assertSafeCachePromotion(failedIndex, null, { force: true })).not.toThrow();
  });

  it('promotes a full refresh whose source-route failures are zero but virtual-page failures are within the allowed ratio (CI regression: attempted=77, saved=222, failed=22)', () => {
    const diag = createEmptyExtractionDiagnostics();
    for (const slug of REQUIRED_SAMPLE_SLUGS) pushRouteDiagnostic(diag, requiredSampleDiagnostic(slug));
    diag.sourcePagesAttempted = 77;
    diag.sourcePagesFailed = 0;
    diag.virtualPagesPlanned = 244;
    diag.virtualPagesSaved = 222;
    diag.virtualPagesFailed = 22;

    const pages: MaterialPage[] = requiredSamplePages();

    const nextIndex = materialIndex(pages.length, {
      pages,
      extractionDiagnostics: diag,
      coverageDiagnostics: minimalCoverageDiagnostics({
        isLimitedRun: false,
        resolvableSourceRouteCount: 77,
        selectedSourceRouteCount: 77,
        attemptedSourceRouteCount: 77,
        plannedVirtualPageCount: 244,
        savedVirtualPageCount: 222,
        failedVirtualPageCount: 22,
        coverageWarnings: []
      })
    });

    // 22/244 ~= 9%, well under the 20% allowance — promotion must pass even though the old
    // failedPageCount/attemptedPageCount mix (22/77 = 29%) would have incorrectly rejected it.
    expect(() => assertSafeCachePromotion(nextIndex, null)).not.toThrow();
  });

  it('rejects a full refresh whose source-route failure ratio is above the allowed threshold', () => {
    const diag = createEmptyExtractionDiagnostics();
    for (const slug of REQUIRED_SAMPLE_SLUGS) pushRouteDiagnostic(diag, requiredSampleDiagnostic(slug));
    diag.sourcePagesAttempted = 50;
    diag.sourcePagesFailed = 15; // 30% — above the 20% allowance
    diag.virtualPagesPlanned = 50;
    diag.virtualPagesSaved = 35;
    diag.virtualPagesFailed = 15;

    const pages: MaterialPage[] = requiredSamplePages();

    const nextIndex = materialIndex(pages.length, {
      pages,
      extractionDiagnostics: diag,
      // isLimitedRun:true keeps this test isolated to the source-route ratio check by skipping
      // the full-refresh-only coverage-gap / resolvable-route-count checks.
      coverageDiagnostics: minimalCoverageDiagnostics({ isLimitedRun: true })
    });

    expect(() => assertSafeCachePromotion(nextIndex, null)).toThrow('above the allowed 20%');
    expect(() => assertSafeCachePromotion(nextIndex, null)).toThrow(/attempted source routes/);
    expect(() => assertSafeCachePromotion(nextIndex, null, { force: true })).not.toThrow();
  });

  it('rejects a full refresh whose virtual-page failure ratio is above the allowed threshold', () => {
    const diag = createEmptyExtractionDiagnostics();
    for (const slug of REQUIRED_SAMPLE_SLUGS) pushRouteDiagnostic(diag, requiredSampleDiagnostic(slug));
    diag.sourcePagesAttempted = 50;
    diag.sourcePagesFailed = 0; // source routes are fine — only some of their tab pages failed
    diag.virtualPagesPlanned = 100;
    diag.virtualPagesSaved = 70;
    diag.virtualPagesFailed = 30; // 30% — above the 20% allowance

    const pages: MaterialPage[] = REQUIRED_SAMPLE_SLUGS.map((slug, i) => ({
      ...page,
      id: `req-${i}`,
      path: `${slug}.md`,
      url: `https://m3.material.io/${slug}`
    }));

    const nextIndex = materialIndex(pages.length, {
      pages,
      extractionDiagnostics: diag,
      coverageDiagnostics: minimalCoverageDiagnostics({ isLimitedRun: true })
    });

    expect(() => assertSafeCachePromotion(nextIndex, null)).toThrow('above the allowed 20%');
    expect(() => assertSafeCachePromotion(nextIndex, null)).toThrow(/planned virtual pages/);
    expect(() => assertSafeCachePromotion(nextIndex, null, { force: true })).not.toThrow();
  });

  it('rejects promotion when modern extraction diagnostics are missing their source-route counters', () => {
    const diag = createEmptyExtractionDiagnostics();
    for (const slug of REQUIRED_SAMPLE_SLUGS) pushRouteDiagnostic(diag, requiredSampleDiagnostic(slug));
    // Simulate a malformed/partial diagnostics object: present, but missing the counters.
    delete (diag as Partial<typeof diag>).sourcePagesAttempted;

    const pages: MaterialPage[] = REQUIRED_SAMPLE_SLUGS.map((slug, i) => ({
      ...page,
      id: `req-${i}`,
      path: `${slug}.md`,
      url: `https://m3.material.io/${slug}`
    }));

    const nextIndex = materialIndex(pages.length, {
      pages,
      extractionDiagnostics: diag,
      coverageDiagnostics: minimalCoverageDiagnostics({ isLimitedRun: true })
    });

    expect(() => assertSafeCachePromotion(nextIndex, null)).toThrow('missing source-route failure counters');
    expect(() => assertSafeCachePromotion(nextIndex, null, { force: true })).not.toThrow();
  });

  it('rejects promotion when modern extraction diagnostics are missing their virtual-page counters', () => {
    const diag = createEmptyExtractionDiagnostics();
    for (const slug of REQUIRED_SAMPLE_SLUGS) pushRouteDiagnostic(diag, requiredSampleDiagnostic(slug));
    diag.sourcePagesAttempted = 50;
    diag.sourcePagesFailed = 0;
    delete (diag as Partial<typeof diag>).virtualPagesFailed;

    const pages: MaterialPage[] = REQUIRED_SAMPLE_SLUGS.map((slug, i) => ({
      ...page,
      id: `req-${i}`,
      path: `${slug}.md`,
      url: `https://m3.material.io/${slug}`
    }));

    const nextIndex = materialIndex(pages.length, {
      pages,
      extractionDiagnostics: diag,
      coverageDiagnostics: minimalCoverageDiagnostics({ isLimitedRun: true })
    });

    expect(() => assertSafeCachePromotion(nextIndex, null)).toThrow('virtualPagesPlanned=0 but virtualPagesSaved=0 + virtualPagesFailed=undefined does not match');
    expect(() => assertSafeCachePromotion(nextIndex, null, { force: true })).not.toThrow();
  });

  it('allows includeBlog:false promotion when a /blog route was only policy-skipped, not attempted', () => {
    const diag = createEmptyExtractionDiagnostics();
    for (const slug of REQUIRED_SAMPLE_SLUGS) pushRouteDiagnostic(diag, requiredSampleDiagnostic(slug));
    pushRouteDiagnostic(diag, {
      url: 'https://m3.material.io/blog',
      path: 'blog.md',
      sourceUsed: 'skipped',
      skippedReason: 'blog',
      finalMethod: null,
      jsonAttempted: false,
      jsonSucceeded: false,
      browserFallbackAttempted: false,
      browserFallbackSucceeded: false,
      directJsonAttempted: false,
      networkJsonAttempted: false,
      domFallbackAttempted: false,
      unknownChunkTypes: [],
      unknownResourceTypes: [],
      tokenTables: 0,
      tokenTablesRendered: 0,
      missingRequestedTokenSets: []
    });

    const nextIndex = materialIndex(REQUIRED_SAMPLE_SLUGS.length, {
      pages: REQUIRED_SAMPLE_SLUGS.map((slug) => ({ ...page, id: slug, path: `${slug}.md`, url: `https://m3.material.io/${slug}` })),
      extractionDiagnostics: diag,
      coverageDiagnostics: {
        discoveredPublicUrlCount: 4,
        sitemapUrlCount: 4,
        renderedNavUrlCount: 0,
        angularRouteHintCount: 0,
        previousCacheRouteHintCount: 0,
        acceptedPageCount: 4,
        uncrawledDiscoveredUrlCount: 0,
        uncrawledDiscoveredUrls: [],
        skippedBecauseMaxPagesCount: 0,
        skippedBecauseJsonCoveredCount: 0,
        skippedByPolicyCount: 1,
        skippedBlogCount: 1,
        skippedByPolicyUrls: ['/blog'],
        includeBlog: false,
        crawlPriorityPolicyVersion: '1',
        coverageVerified: true,
        coverageWarnings: [],
        coverageHealth: 'verified'
      } satisfies CoverageDiagnostics
    });

    expect(() => assertSafeCachePromotion(nextIndex, null)).not.toThrow();
  });

  it('rejects includeBlog:false promotion when a /blog route was actually attempted', () => {
    const diag = createEmptyExtractionDiagnostics();
    for (const slug of REQUIRED_SAMPLE_SLUGS) pushRouteDiagnostic(diag, requiredSampleDiagnostic(slug));
    pushRouteDiagnostic(diag, {
      url: 'https://m3.material.io/blog',
      path: 'blog.md',
      sourceUsed: 'direct-json',
      finalMethod: 'json',
      jsonAttempted: true,
      jsonSucceeded: true,
      browserFallbackAttempted: false,
      browserFallbackSucceeded: false,
      directJsonAttempted: true,
      directJsonSucceeded: true,
      unknownChunkTypes: [],
      unknownResourceTypes: [],
      tokenTables: 0,
      tokenTablesRendered: 0,
      missingRequestedTokenSets: []
    });

    const nextIndex = materialIndex(REQUIRED_SAMPLE_SLUGS.length + 1, {
      pages: [...REQUIRED_SAMPLE_SLUGS, 'blog'].map((slug) => ({ ...page, id: slug, path: `${slug}.md`, url: `https://m3.material.io/${slug}` })),
      extractionDiagnostics: diag,
      coverageDiagnostics: {
        discoveredPublicUrlCount: 5,
        sitemapUrlCount: 5,
        renderedNavUrlCount: 0,
        angularRouteHintCount: 0,
        previousCacheRouteHintCount: 0,
        acceptedPageCount: 5,
        uncrawledDiscoveredUrlCount: 0,
        uncrawledDiscoveredUrls: [],
        skippedBecauseMaxPagesCount: 0,
        skippedBecauseJsonCoveredCount: 0,
        skippedByPolicyCount: 0,
        skippedBlogCount: 0,
        skippedByPolicyUrls: [],
        includeBlog: false,
        crawlPriorityPolicyVersion: '1',
        coverageVerified: true,
        coverageWarnings: [],
        coverageHealth: 'verified'
      } satisfies CoverageDiagnostics
    });

    expect(() => assertSafeCachePromotion(nextIndex, null)).toThrow('includeBlog:false was set but a /blog route was attempted');
    expect(() => assertSafeCachePromotion(nextIndex, null, { force: true })).not.toThrow();
  });

  it.each([
    ['articles/foo.md', 'https://m3.material.io/articles/foo'],
    ['news/foo.md', 'https://m3.material.io/news/foo'],
    ['2026/foo.md', 'https://m3.material.io/2026/foo']
  ])('rejects includeBlog:false promotion when %s was actually attempted', (routePath, url) => {
    const diag = createEmptyExtractionDiagnostics();
    for (const slug of REQUIRED_SAMPLE_SLUGS) pushRouteDiagnostic(diag, requiredSampleDiagnostic(slug));
    pushRouteDiagnostic(diag, {
      url,
      path: routePath,
      sourceUsed: 'direct-json',
      finalMethod: 'json',
      jsonAttempted: true,
      jsonSucceeded: true,
      browserFallbackAttempted: false,
      browserFallbackSucceeded: false,
      directJsonAttempted: true,
      directJsonSucceeded: true,
      unknownChunkTypes: [],
      unknownResourceTypes: [],
      tokenTables: 0,
      tokenTablesRendered: 0,
      missingRequestedTokenSets: []
    });

    const nextIndex = materialIndex(REQUIRED_SAMPLE_SLUGS.length + 1, {
      pages: [...REQUIRED_SAMPLE_SLUGS, routePath.replace(/\.md$/, '')].map((slug) => ({ ...page, id: slug, path: `${slug}.md`, url: `https://m3.material.io/${slug}` })),
      extractionDiagnostics: diag,
      coverageDiagnostics: {
        discoveredPublicUrlCount: 5,
        sitemapUrlCount: 5,
        renderedNavUrlCount: 0,
        angularRouteHintCount: 0,
        previousCacheRouteHintCount: 0,
        acceptedPageCount: 5,
        uncrawledDiscoveredUrlCount: 0,
        uncrawledDiscoveredUrls: [],
        skippedBecauseMaxPagesCount: 0,
        skippedBecauseJsonCoveredCount: 0,
        skippedByPolicyCount: 0,
        skippedBlogCount: 0,
        skippedByPolicyUrls: [],
        includeBlog: false,
        crawlPriorityPolicyVersion: '1',
        coverageVerified: true,
        coverageWarnings: [],
        coverageHealth: 'verified'
      } satisfies CoverageDiagnostics
    });

    expect(() => assertSafeCachePromotion(nextIndex, null)).toThrow('includeBlog:false was set but a /blog route was attempted');
    expect(() => assertSafeCachePromotion(nextIndex, null, { force: true })).not.toThrow();
  });

  it.each([
    ['articles/foo.md', 'https://m3.material.io/articles/foo', '/articles/foo'],
    ['news/foo.md', 'https://m3.material.io/news/foo', '/news/foo'],
    ['2026/foo.md', 'https://m3.material.io/2026/foo', '/2026/foo']
  ])('allows includeBlog:false promotion when %s was only policy-skipped, not attempted', (routePath, url, policyUrl) => {
    const diag = createEmptyExtractionDiagnostics();
    for (const slug of REQUIRED_SAMPLE_SLUGS) pushRouteDiagnostic(diag, requiredSampleDiagnostic(slug));
    pushRouteDiagnostic(diag, {
      url,
      path: routePath,
      sourceUsed: 'skipped',
      skippedReason: 'blog',
      finalMethod: null,
      jsonAttempted: false,
      jsonSucceeded: false,
      browserFallbackAttempted: false,
      browserFallbackSucceeded: false,
      directJsonAttempted: false,
      networkJsonAttempted: false,
      domFallbackAttempted: false,
      unknownChunkTypes: [],
      unknownResourceTypes: [],
      tokenTables: 0,
      tokenTablesRendered: 0,
      missingRequestedTokenSets: []
    });

    const nextIndex = materialIndex(REQUIRED_SAMPLE_SLUGS.length, {
      pages: REQUIRED_SAMPLE_SLUGS.map((slug) => ({ ...page, id: slug, path: `${slug}.md`, url: `https://m3.material.io/${slug}` })),
      extractionDiagnostics: diag,
      coverageDiagnostics: {
        discoveredPublicUrlCount: 4,
        sitemapUrlCount: 4,
        renderedNavUrlCount: 0,
        angularRouteHintCount: 0,
        previousCacheRouteHintCount: 0,
        acceptedPageCount: 4,
        uncrawledDiscoveredUrlCount: 0,
        uncrawledDiscoveredUrls: [],
        skippedBecauseMaxPagesCount: 0,
        skippedBecauseJsonCoveredCount: 0,
        skippedByPolicyCount: 1,
        skippedBlogCount: 1,
        skippedByPolicyUrls: [policyUrl],
        includeBlog: false,
        crawlPriorityPolicyVersion: '1',
        coverageVerified: true,
        coverageWarnings: [],
        coverageHealth: 'verified'
      } satisfies CoverageDiagnostics
    });

    expect(() => assertSafeCachePromotion(nextIndex, null)).not.toThrow();
  });

  it('allows includeBlog:false promotion when a /blog route was only policy-skipped, not attempted', () => {
    const diag = createEmptyExtractionDiagnostics();
    for (const slug of REQUIRED_SAMPLE_SLUGS) pushRouteDiagnostic(diag, requiredSampleDiagnostic(slug));
    pushRouteDiagnostic(diag, {
      url: 'https://m3.material.io/blog',
      path: 'blog.md',
      sourceUsed: 'skipped',
      skippedReason: 'blog',
      finalMethod: null,
      jsonAttempted: false,
      jsonSucceeded: false,
      browserFallbackAttempted: false,
      browserFallbackSucceeded: false,
      directJsonAttempted: false,
      networkJsonAttempted: false,
      domFallbackAttempted: false,
      unknownChunkTypes: [],
      unknownResourceTypes: [],
      tokenTables: 0,
      tokenTablesRendered: 0,
      missingRequestedTokenSets: []
    });

    const nextIndex = materialIndex(REQUIRED_SAMPLE_SLUGS.length, {
      pages: REQUIRED_SAMPLE_SLUGS.map((slug) => ({ ...page, id: slug, path: `${slug}.md`, url: `https://m3.material.io/${slug}` })),
      extractionDiagnostics: diag,
      coverageDiagnostics: {
        discoveredPublicUrlCount: 4,
        sitemapUrlCount: 4,
        renderedNavUrlCount: 0,
        angularRouteHintCount: 0,
        previousCacheRouteHintCount: 0,
        acceptedPageCount: 4,
        uncrawledDiscoveredUrlCount: 0,
        uncrawledDiscoveredUrls: [],
        skippedBecauseMaxPagesCount: 0,
        skippedBecauseJsonCoveredCount: 0,
        skippedByPolicyCount: 1,
        skippedBlogCount: 1,
        skippedByPolicyUrls: ['/blog'],
        includeBlog: false,
        crawlPriorityPolicyVersion: '1',
        coverageVerified: true,
        coverageWarnings: [],
        coverageHealth: 'verified'
      } satisfies CoverageDiagnostics
    });

    expect(() => assertSafeCachePromotion(nextIndex, null)).not.toThrow();
  });

  it('rejects includeBlog:false promotion when a /blog route was actually attempted', () => {
    const diag = createEmptyExtractionDiagnostics();
    for (const slug of REQUIRED_SAMPLE_SLUGS) pushRouteDiagnostic(diag, requiredSampleDiagnostic(slug));
    pushRouteDiagnostic(diag, {
      url: 'https://m3.material.io/blog',
      path: 'blog.md',
      sourceUsed: 'direct-json',
      finalMethod: 'json',
      jsonAttempted: true,
      jsonSucceeded: true,
      browserFallbackAttempted: false,
      browserFallbackSucceeded: false,
      directJsonAttempted: true,
      directJsonSucceeded: true,
      unknownChunkTypes: [],
      unknownResourceTypes: [],
      tokenTables: 0,
      tokenTablesRendered: 0,
      missingRequestedTokenSets: []
    });

    const nextIndex = materialIndex(REQUIRED_SAMPLE_SLUGS.length + 1, {
      pages: [...REQUIRED_SAMPLE_SLUGS, 'blog'].map((slug) => ({ ...page, id: slug, path: `${slug}.md`, url: `https://m3.material.io/${slug}` })),
      extractionDiagnostics: diag,
      coverageDiagnostics: {
        discoveredPublicUrlCount: 5,
        sitemapUrlCount: 5,
        renderedNavUrlCount: 0,
        angularRouteHintCount: 0,
        previousCacheRouteHintCount: 0,
        acceptedPageCount: 5,
        uncrawledDiscoveredUrlCount: 0,
        uncrawledDiscoveredUrls: [],
        skippedBecauseMaxPagesCount: 0,
        skippedBecauseJsonCoveredCount: 0,
        skippedByPolicyCount: 0,
        skippedBlogCount: 0,
        skippedByPolicyUrls: [],
        includeBlog: false,
        crawlPriorityPolicyVersion: '1',
        coverageVerified: true,
        coverageWarnings: [],
        coverageHealth: 'verified'
      } satisfies CoverageDiagnostics
    });

    expect(() => assertSafeCachePromotion(nextIndex, null)).toThrow('includeBlog:false was set but a /blog route was attempted');
    expect(() => assertSafeCachePromotion(nextIndex, null, { force: true })).not.toThrow();
  });

  it.each([
    ['articles/foo.md', 'https://m3.material.io/articles/foo'],
    ['news/foo.md', 'https://m3.material.io/news/foo'],
    ['2026/foo.md', 'https://m3.material.io/2026/foo']
  ])('rejects includeBlog:false promotion when %s was actually attempted', (routePath, url) => {
    const diag = createEmptyExtractionDiagnostics();
    for (const slug of REQUIRED_SAMPLE_SLUGS) pushRouteDiagnostic(diag, requiredSampleDiagnostic(slug));
    pushRouteDiagnostic(diag, {
      url,
      path: routePath,
      sourceUsed: 'direct-json',
      finalMethod: 'json',
      jsonAttempted: true,
      jsonSucceeded: true,
      browserFallbackAttempted: false,
      browserFallbackSucceeded: false,
      directJsonAttempted: true,
      directJsonSucceeded: true,
      unknownChunkTypes: [],
      unknownResourceTypes: [],
      tokenTables: 0,
      tokenTablesRendered: 0,
      missingRequestedTokenSets: []
    });

    const nextIndex = materialIndex(REQUIRED_SAMPLE_SLUGS.length + 1, {
      pages: [...REQUIRED_SAMPLE_SLUGS, routePath.replace(/\.md$/, '')].map((slug) => ({ ...page, id: slug, path: `${slug}.md`, url: `https://m3.material.io/${slug}` })),
      extractionDiagnostics: diag,
      coverageDiagnostics: {
        discoveredPublicUrlCount: 5,
        sitemapUrlCount: 5,
        renderedNavUrlCount: 0,
        angularRouteHintCount: 0,
        previousCacheRouteHintCount: 0,
        acceptedPageCount: 5,
        uncrawledDiscoveredUrlCount: 0,
        uncrawledDiscoveredUrls: [],
        skippedBecauseMaxPagesCount: 0,
        skippedBecauseJsonCoveredCount: 0,
        skippedByPolicyCount: 0,
        skippedBlogCount: 0,
        skippedByPolicyUrls: [],
        includeBlog: false,
        crawlPriorityPolicyVersion: '1',
        coverageVerified: true,
        coverageWarnings: [],
        coverageHealth: 'verified'
      } satisfies CoverageDiagnostics
    });

    expect(() => assertSafeCachePromotion(nextIndex, null)).toThrow('includeBlog:false was set but a /blog route was attempted');
    expect(() => assertSafeCachePromotion(nextIndex, null, { force: true })).not.toThrow();
  });

  it.each([
    ['articles/foo.md', 'https://m3.material.io/articles/foo', '/articles/foo'],
    ['news/foo.md', 'https://m3.material.io/news/foo', '/news/foo'],
    ['2026/foo.md', 'https://m3.material.io/2026/foo', '/2026/foo']
  ])('allows includeBlog:false promotion when %s was only policy-skipped, not attempted', (routePath, url, policyUrl) => {
    const diag = createEmptyExtractionDiagnostics();
    for (const slug of REQUIRED_SAMPLE_SLUGS) pushRouteDiagnostic(diag, requiredSampleDiagnostic(slug));
    pushRouteDiagnostic(diag, {
      url,
      path: routePath,
      sourceUsed: 'skipped',
      skippedReason: 'blog',
      finalMethod: null,
      jsonAttempted: false,
      jsonSucceeded: false,
      browserFallbackAttempted: false,
      browserFallbackSucceeded: false,
      directJsonAttempted: false,
      networkJsonAttempted: false,
      domFallbackAttempted: false,
      unknownChunkTypes: [],
      unknownResourceTypes: [],
      tokenTables: 0,
      tokenTablesRendered: 0,
      missingRequestedTokenSets: []
    });

    const nextIndex = materialIndex(REQUIRED_SAMPLE_SLUGS.length, {
      pages: REQUIRED_SAMPLE_SLUGS.map((slug) => ({ ...page, id: slug, path: `${slug}.md`, url: `https://m3.material.io/${slug}` })),
      extractionDiagnostics: diag,
      coverageDiagnostics: {
        discoveredPublicUrlCount: 4,
        sitemapUrlCount: 4,
        renderedNavUrlCount: 0,
        angularRouteHintCount: 0,
        previousCacheRouteHintCount: 0,
        acceptedPageCount: 4,
        uncrawledDiscoveredUrlCount: 0,
        uncrawledDiscoveredUrls: [],
        skippedBecauseMaxPagesCount: 0,
        skippedBecauseJsonCoveredCount: 0,
        skippedByPolicyCount: 1,
        skippedBlogCount: 1,
        skippedByPolicyUrls: [policyUrl],
        includeBlog: false,
        crawlPriorityPolicyVersion: '1',
        coverageVerified: true,
        coverageWarnings: [],
        coverageHealth: 'verified'
      } satisfies CoverageDiagnostics
    });

    expect(() => assertSafeCachePromotion(nextIndex, null)).not.toThrow();
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

  it('rejects first cache with significant coverage gap (no max-pages explanation) unless forced', () => {
    const gapIndex = materialIndex(10, {
      coverageDiagnostics: {
        discoveredPublicUrlCount: 80,
        sitemapUrlCount: 80,
        renderedNavUrlCount: 0,
        angularRouteHintCount: 0,
        previousCacheRouteHintCount: 0,
        acceptedPageCount: 10,
        uncrawledDiscoveredUrlCount: 70,
        uncrawledDiscoveredUrls: [],
        skippedBecauseMaxPagesCount: 0,
        skippedBecauseJsonCoveredCount: 0,
        skippedByPolicyCount: 0,
        skippedBlogCount: 0,
        skippedByPolicyUrls: [],
        includeBlog: false,
        crawlPriorityPolicyVersion: '1',
        coverageVerified: false,
        coverageWarnings: ['coverage-gap:accepted=10:discovered=80'],
        coverageHealth: 'failed'
      } satisfies CoverageDiagnostics
    });

    expect(() => assertSafeCachePromotion(gapIndex, null)).toThrow('coverage gap');
    expect(() => assertSafeCachePromotion(gapIndex, null, { force: true })).not.toThrow();
  });

  it('allows first cache with max-pages coverage gap and marks it partial', () => {
    const partialIndex = materialIndex(10, {
      coverageDiagnostics: {
        discoveredPublicUrlCount: 80,
        sitemapUrlCount: 80,
        renderedNavUrlCount: 0,
        angularRouteHintCount: 0,
        previousCacheRouteHintCount: 0,
        acceptedPageCount: 10,
        uncrawledDiscoveredUrlCount: 70,
        uncrawledDiscoveredUrls: [],
        skippedBecauseMaxPagesCount: 70,
        skippedBecauseJsonCoveredCount: 0,
        skippedByPolicyCount: 0,
        skippedBlogCount: 0,
        skippedByPolicyUrls: [],
        includeBlog: false,
        crawlPriorityPolicyVersion: '1',
        coverageVerified: false,
        coverageWarnings: [
          'coverage-partial:max-pages-limited:70',
          'coverage-gap:accepted=10:discovered=80'
        ],
        coverageHealth: 'partial'
      } satisfies CoverageDiagnostics
    });

    expect(() => assertSafeCachePromotion(partialIndex, null)).not.toThrow();
  });

  it('allows a limited run (isLimitedRun:true) with a real discovered/accepted gap to promote', () => {
    const limitedIndex = materialIndex(11, {
      coverageDiagnostics: {
        discoveredPublicUrlCount: 1405,
        sitemapUrlCount: 1405,
        renderedNavUrlCount: 0,
        angularRouteHintCount: 0,
        previousCacheRouteHintCount: 0,
        acceptedPageCount: 11,
        uncrawledDiscoveredUrlCount: 1394,
        uncrawledDiscoveredUrls: [],
        skippedBecauseMaxPagesCount: 15,
        skippedBecauseJsonCoveredCount: 0,
        skippedByPolicyCount: 0,
        skippedBlogCount: 0,
        skippedByPolicyUrls: [],
        includeBlog: false,
        crawlPriorityPolicyVersion: '1',
        coverageVerified: false,
        isLimitedRun: true,
        maxPagesExplicit: true,
        // Note: no coverage-partial/coverage-gap warning pushed at all in limited mode — isLimitedRun
        // alone is enough for firstCacheCoveragePolicy to skip the full-site comparison.
        coverageWarnings: [],
        coverageHealth: 'partial'
      } satisfies CoverageDiagnostics
    });

    expect(() => assertSafeCachePromotion(limitedIndex, null)).not.toThrow();
  });

  it('still rejects a full run (isLimitedRun:false) with the same discovered/accepted gap', () => {
    const fullRunIndex = materialIndex(11, {
      coverageDiagnostics: {
        discoveredPublicUrlCount: 1405,
        sitemapUrlCount: 1405,
        renderedNavUrlCount: 0,
        angularRouteHintCount: 0,
        previousCacheRouteHintCount: 0,
        acceptedPageCount: 11,
        uncrawledDiscoveredUrlCount: 1394,
        uncrawledDiscoveredUrls: [],
        skippedBecauseMaxPagesCount: 0,
        skippedBecauseJsonCoveredCount: 0,
        skippedByPolicyCount: 0,
        skippedBlogCount: 0,
        skippedByPolicyUrls: [],
        includeBlog: false,
        crawlPriorityPolicyVersion: '1',
        coverageVerified: false,
        isLimitedRun: false,
        maxPagesExplicit: false,
        coverageWarnings: ['coverage-gap:accepted=11:discovered=1405'],
        coverageHealth: 'failed'
      } satisfies CoverageDiagnostics
    });

    expect(() => assertSafeCachePromotion(fullRunIndex, null)).toThrow('coverage gap');
  });

  it('promotes a full refresh with many discovered URLs but a smaller, fully-accounted plannedVirtualPageCount', () => {
    // Mirrors a real full-refresh shape: 1433 discovered public URLs (aliases, tab URLs, legacy
    // routes, platform-specific pages) but only 174 planned virtual pages from the 63 resolvable
    // source routes actually selected/attempted, 162 saved and 12 failed (within the 20% rate).
    const diag = createEmptyExtractionDiagnostics();
    for (const slug of REQUIRED_SAMPLE_SLUGS) {
      pushRouteDiagnostic(diag, requiredSampleDiagnostic(slug));
    }
    diag.virtualPagesPlanned = 174;
    diag.virtualPagesSaved = 162;
    diag.virtualPagesFailed = 12;
    diag.sourcePagesAttempted = 63;

    const pages: MaterialPage[] = requiredSamplePages();

    const nextIndex = materialIndex(pages.length, {
      pages,
      attemptedPageCount: 63,
      failedPageCount: 12,
      extractionDiagnostics: diag,
      coverageDiagnostics: minimalCoverageDiagnostics({
        discoveredPublicUrlCount: 1433,
        isLimitedRun: false,
        resolvableSourceRouteCount: 63,
        selectedSourceRouteCount: 63,
        attemptedSourceRouteCount: 63,
        plannedVirtualPageCount: 174,
        savedVirtualPageCount: 162,
        failedVirtualPageCount: 12,
        // No coverage-gap warning: a real run would not push one here since
        // hasSignificantCoverageGap(174, 162) is below the 20%/min-5 threshold.
        coverageWarnings: []
      })
    });

    expect(() => assertSafeCachePromotion(nextIndex, null)).not.toThrow();
  });

  it('still fails a full refresh when plannedVirtualPageCount has a real gap', () => {
    const diag = createEmptyExtractionDiagnostics();
    for (const slug of REQUIRED_SAMPLE_SLUGS) {
      pushRouteDiagnostic(diag, requiredSampleDiagnostic(slug));
    }
    // 174 planned, only 80 saved, 94 failed — a genuine ~54% failure rate, well above 20%.
    diag.virtualPagesPlanned = 174;
    diag.virtualPagesSaved = 80;
    diag.virtualPagesFailed = 94;
    diag.sourcePagesAttempted = 63;

    const pages: MaterialPage[] = REQUIRED_SAMPLE_SLUGS.map((slug, i) => ({
      ...page,
      id: `req-${i}`,
      path: `${slug}.md`,
      url: `https://m3.material.io/${slug}`
    }));

    const nextIndex = materialIndex(pages.length, {
      pages,
      // Below MIN_ATTEMPTS_FOR_FAILURE_RATIO_CHECK so the unrelated (and unit-mismatched —
      // attemptedPageCount is source-route-level while failedPageCount is virtual-page-level)
      // failedPageRatio check on MaterialIndex doesn't fire first; this test isolates the new
      // plannedVirtualPageCount-based coverage-gap check specifically.
      attemptedPageCount: 4,
      failedPageCount: 0,
      extractionDiagnostics: diag,
      coverageDiagnostics: minimalCoverageDiagnostics({
        discoveredPublicUrlCount: 1433,
        isLimitedRun: false,
        resolvableSourceRouteCount: 63,
        selectedSourceRouteCount: 63,
        attemptedSourceRouteCount: 63,
        plannedVirtualPageCount: 174,
        savedVirtualPageCount: 80,
        failedVirtualPageCount: 94,
        coverageWarnings: ['coverage-gap:planned=174:saved=80:failed=94']
      })
    });

    expect(() => assertSafeCachePromotion(nextIndex, null)).toThrow('coverage gap');
  });

  it('rejects full refresh diagnostics where virtualPagesSaved + virtualPagesFailed does not match virtualPagesPlanned', () => {
    const diag = createEmptyExtractionDiagnostics();
    for (const slug of REQUIRED_SAMPLE_SLUGS) {
      pushRouteDiagnostic(diag, requiredSampleDiagnostic(slug));
    }
    diag.virtualPagesPlanned = 174;
    diag.virtualPagesSaved = 162;
    diag.virtualPagesFailed = 5; // should be 12 — inconsistent accounting

    const pages: MaterialPage[] = REQUIRED_SAMPLE_SLUGS.map((slug, i) => ({
      ...page,
      id: `req-${i}`,
      path: `${slug}.md`,
      url: `https://m3.material.io/${slug}`
    }));

    const nextIndex = materialIndex(pages.length, {
      pages,
      extractionDiagnostics: diag,
      coverageDiagnostics: minimalCoverageDiagnostics({ isLimitedRun: false })
    });

    expect(() => assertSafeCachePromotion(nextIndex, null)).toThrow('diagnostics are inconsistent');
  });

  it('does not let aliases or tab URLs inflate the hard coverage denominator', () => {
    // discoveredPublicUrlCount includes hundreds of alias/tab URLs that are not separate source
    // routes at all; skippedAliasOnlyCount accounts for them, and they must not appear anywhere in
    // the planned/saved/failed virtual-page accounting that promotion actually validates against.
    const diag = createEmptyExtractionDiagnostics();
    for (const slug of REQUIRED_SAMPLE_SLUGS) {
      pushRouteDiagnostic(diag, requiredSampleDiagnostic(slug));
    }
    diag.virtualPagesPlanned = 4;
    diag.virtualPagesSaved = 4;
    diag.virtualPagesFailed = 0;

    const pages: MaterialPage[] = REQUIRED_SAMPLE_SLUGS.map((slug, i) => ({
      ...page,
      id: `req-${i}`,
      path: `${slug}.md`,
      url: `https://m3.material.io/${slug}`
    }));

    const nextIndex = materialIndex(pages.length, {
      pages,
      extractionDiagnostics: diag,
      coverageDiagnostics: minimalCoverageDiagnostics({
        discoveredPublicUrlCount: 500,
        isLimitedRun: false,
        aliasUrlCount: 400,
        skippedAliasOnlyCount: 400,
        resolvableSourceRouteCount: 4,
        selectedSourceRouteCount: 4,
        attemptedSourceRouteCount: 4,
        plannedVirtualPageCount: 4,
        savedVirtualPageCount: 4,
        failedVirtualPageCount: 0,
        coverageWarnings: []
      })
    });

    expect(() => assertSafeCachePromotion(nextIndex, null)).not.toThrow();
  });

  it('classifies a non-content index route as skipped, not failed, and excludes it from failedVirtualPageCount', () => {
    const diag = createEmptyExtractionDiagnostics();
    for (const slug of REQUIRED_SAMPLE_SLUGS) {
      pushRouteDiagnostic(diag, requiredSampleDiagnostic(slug));
    }
    // /components itself: page-data exists but is a navigation landing page, not real content.
    pushRouteDiagnostic(diag, requiredSampleDiagnostic('components', {
      sourceUsed: 'skipped',
      skippedReason: 'non-content-index',
      directJsonAttempted: true,
      directJsonSucceeded: false,
      jsonAttempted: true,
      jsonSucceeded: false,
      fallbackReasons: ['json-title-missing']
    }));

    const pages: MaterialPage[] = REQUIRED_SAMPLE_SLUGS.map((slug, i) => ({
      ...page,
      id: `req-${i}`,
      path: `${slug}.md`,
      url: `https://m3.material.io/${slug}`
    }));

    const nextIndex = materialIndex(pages.length, {
      pages,
      extractionDiagnostics: diag,
      coverageDiagnostics: minimalCoverageDiagnostics({ isLimitedRun: false, skippedNonContentIndexCount: 1 })
    });

    expect(() => assertSafeCachePromotion(nextIndex, null)).not.toThrow();
    const componentsDiag = diag.routeDiagnostics.find((d) => d.path === 'components.md');
    expect(componentsDiag?.sourceUsed).toBe('skipped');
    expect(componentsDiag?.skippedReason).toBe('non-content-index');
    expect(diag.pagesFailed).toBe(0);
  });

  function minimalCoverageDiagnostics(overrides: Partial<CoverageDiagnostics> = {}): CoverageDiagnostics {
    return {
      discoveredPublicUrlCount: 0,
      sitemapUrlCount: 0,
      renderedNavUrlCount: 0,
      angularRouteHintCount: 0,
      previousCacheRouteHintCount: 0,
      acceptedPageCount: 0,
      uncrawledDiscoveredUrlCount: 0,
      uncrawledDiscoveredUrls: [],
      skippedBecauseMaxPagesCount: 0,
      skippedBecauseJsonCoveredCount: 0,
      skippedByPolicyCount: 0,
      skippedBlogCount: 0,
      skippedByPolicyUrls: [],
      includeBlog: false,
      crawlPriorityPolicyVersion: '1',
      coverageVerified: false,
      coverageWarnings: [],
      coverageHealth: 'unverified',
      isLimitedRun: false,
      maxPagesExplicit: false,
      ...overrides
    };
  }

  it('fails full refresh promotion when a required sample is missing from index.pages', () => {
    const diag = createEmptyExtractionDiagnostics();
    pushRouteDiagnostic(diag, requiredSampleDiagnostic('components/buttons/specs', {
      sourceUsed: 'failed',
      directJsonSucceeded: false,
      jsonSucceeded: false,
      fallbackReasons: ['json-fetch-failed']
    }));
    for (const slug of REQUIRED_SAMPLE_SLUGS.slice(1)) {
      pushRouteDiagnostic(diag, requiredSampleDiagnostic(slug));
    }

    const pages: MaterialPage[] = REQUIRED_SAMPLE_SLUGS.slice(1).map((slug, i) => ({
      ...page,
      id: `req-${i}`,
      path: `${slug}.md`,
      url: `https://m3.material.io/${slug}`
    }));

    const nextIndex = materialIndex(pages.length, {
      pages,
      attemptedPageCount: 4,
      failedPageCount: 1,
      extractionDiagnostics: diag,
      coverageDiagnostics: minimalCoverageDiagnostics({ isLimitedRun: false })
    });

    expect(() => assertSafeCachePromotion(nextIndex, null)).toThrow('Required sample routes are missing or failed JSON extraction');
  });

  it('fails full refresh promotion when a required sample has no diagnostic and no page at all', () => {
    // components/buttons/specs never appears in routeDiagnostics or pages — not "failed", just
    // entirely absent. A missing diagnostic must not be treated as an automatic pass.
    const diag = createEmptyExtractionDiagnostics();
    for (const slug of REQUIRED_SAMPLE_SLUGS.slice(1)) {
      pushRouteDiagnostic(diag, requiredSampleDiagnostic(slug));
    }

    const pages: MaterialPage[] = REQUIRED_SAMPLE_SLUGS.slice(1).map((slug, i) => ({
      ...page,
      id: `req-${i}`,
      path: `${slug}.md`,
      url: `https://m3.material.io/${slug}`
    }));

    const nextIndex = materialIndex(pages.length, {
      pages,
      attemptedPageCount: 3,
      failedPageCount: 0,
      extractionDiagnostics: diag,
      coverageDiagnostics: minimalCoverageDiagnostics({ isLimitedRun: false })
    });

    expect(() => assertSafeCachePromotion(nextIndex, null)).toThrow('Required sample routes are missing or failed JSON extraction');
  });

  it('fails full refresh promotion when an accepted public route is missing from output', () => {
    const diag = createEmptyExtractionDiagnostics();
    pushRouteDiagnostic(diag, requiredSampleDiagnostic('components/buttons/specs'));
    pushRouteDiagnostic(diag, requiredSampleDiagnostic('components/lists/specs'));
    pushRouteDiagnostic(diag, requiredSampleDiagnostic('styles/color/roles'));
    pushRouteDiagnostic(diag, requiredSampleDiagnostic('foundations/design-tokens/overview'));

    const pages: MaterialPage[] = REQUIRED_SAMPLE_SLUGS.map((slug, i) => ({
      ...page,
      id: `req-${i}`,
      path: `${slug}.md`,
      url: `https://m3.material.io/${slug}`
    }));

    const nextIndex = materialIndex(pages.length, {
      pages,
      extractionDiagnostics: diag,
      coverageDiagnostics: {
        ...minimalCoverageDiagnostics({ isLimitedRun: false }),
        routePlanSummary: {
          acceptedRouteCount: 1,
          staleRouteCount: 0,
          ambiguousRouteCount: 0,
          nonPublicRouteCount: 0,
          extractionCandidateCount: 1,
          reconciliationStatusCounts: { normalizedSlugMatch: 1 },
          publicDocsClassificationCounts: { 'public-docs': 1 },
          problematicExamples: {
            staleRoutes: [],
            ambiguousRoutes: [],
            nonPublicRoutes: [],
            unresolvedAcceptedRoutes: [
              {
                route: '/components/switches',
                canonicalRoute: '/components/switch',
                outputPath: 'components/switch.md',
                publicDocsClassification: 'public-docs',
                reconciliationStatus: 'normalizedSlugMatch'
              }
            ]
          }
        }
      }
    });

    expect(() => assertSafeCachePromotion(nextIndex, null)).toThrow('Accepted public documentation routes are missing from cache output: /components/switch[diag=n,virtual=n]');
  });

  it('treats accepted /components/toolbars as covered when overview and specs virtual pages were saved', () => {
    const diag = createEmptyExtractionDiagnostics();
    for (const slug of REQUIRED_SAMPLE_SLUGS) pushRouteDiagnostic(diag, requiredSampleDiagnostic(slug));
    pushRouteDiagnostic(diag, requiredSampleDiagnostic('components/toolbars/overview', {
      sourceRoute: 'components/toolbars',
      virtualRoute: 'https://m3.material.io/components/toolbars/overview'
    }));
    pushRouteDiagnostic(diag, requiredSampleDiagnostic('components/toolbars/specs', {
      sourceRoute: 'components/toolbars',
      virtualRoute: 'https://m3.material.io/components/toolbars/specs'
    }));

    const nextIndex = materialIndex(2, {
      pages: [
        ...requiredSamplePages(),
        {
          ...page,
          id: 'toolbars-overview',
          path: 'components/toolbars/overview.md',
          url: 'https://m3.material.io/components/toolbars/overview'
        },
        {
          ...page,
          id: 'toolbars-specs',
          path: 'components/toolbars/specs.md',
          url: 'https://m3.material.io/components/toolbars/specs'
        }
      ],
      extractionDiagnostics: diag,
      coverageDiagnostics: {
        ...minimalCoverageDiagnostics({ isLimitedRun: false }),
        fullRoutePlanSummary: {
          acceptedRoutes: [],
          staleRoutes: [],
          removedRoutes: [],
          ambiguousRoutes: [],
          nonPublicRoutes: [],
          extractionCandidates: [{
            route: '/components/toolbars',
            canonicalRoute: '/components/toolbars',
            outputPath: 'components/toolbars.md',
            sources: ['site_meta', 'bundle'],
            publicDocsClassification: 'public-docs',
            reconciliationStatus: 'exact'
          }]
        }
      }
    });

    expect(() => assertSafeCachePromotion(nextIndex, null)).not.toThrow();
  });

  it('treats accepted /components/segmented-buttons as covered when generated virtual pages were saved', () => {
    const diag = createEmptyExtractionDiagnostics();
    for (const slug of REQUIRED_SAMPLE_SLUGS) pushRouteDiagnostic(diag, requiredSampleDiagnostic(slug));
    for (const slug of [
      'components/segmented-buttons/overview',
      'components/segmented-buttons/specs',
      'components/segmented-buttons/guidelines',
      'components/segmented-buttons/accessibility'
    ]) {
      pushRouteDiagnostic(diag, requiredSampleDiagnostic(slug, {
        sourceRoute: 'components/segmented-buttons',
        virtualRoute: `https://m3.material.io/${slug}`
      }));
    }

    const nextIndex = materialIndex(4, {
      pages: [
        ...requiredSamplePages(),
        {
          ...page,
          id: 'segmented-overview',
          path: 'components/segmented-buttons/overview.md',
          url: 'https://m3.material.io/components/segmented-buttons/overview'
        },
        {
          ...page,
          id: 'segmented-specs',
          path: 'components/segmented-buttons/specs.md',
          url: 'https://m3.material.io/components/segmented-buttons/specs'
        },
        {
          ...page,
          id: 'segmented-guidelines',
          path: 'components/segmented-buttons/guidelines.md',
          url: 'https://m3.material.io/components/segmented-buttons/guidelines'
        },
        {
          ...page,
          id: 'segmented-accessibility',
          path: 'components/segmented-buttons/accessibility.md',
          url: 'https://m3.material.io/components/segmented-buttons/accessibility'
        }
      ],
      extractionDiagnostics: diag,
      coverageDiagnostics: {
        ...minimalCoverageDiagnostics({ isLimitedRun: false }),
        fullRoutePlanSummary: {
          acceptedRoutes: [],
          staleRoutes: [],
          removedRoutes: [],
          ambiguousRoutes: [],
          nonPublicRoutes: [],
          extractionCandidates: [{
            route: '/components/segmented-buttons',
            canonicalRoute: '/components/segmented-buttons',
            outputPath: 'components/segmented-buttons.md',
            sources: ['site_meta', 'bundle'],
            publicDocsClassification: 'public-docs',
            reconciliationStatus: 'exact'
          }]
        }
      }
    });

    expect(() => assertSafeCachePromotion(nextIndex, null)).not.toThrow();
  });

  it('still fails when an accepted public route has diagnostics but no exact or virtual output', () => {
    const diag = createEmptyExtractionDiagnostics();
    for (const slug of REQUIRED_SAMPLE_SLUGS) pushRouteDiagnostic(diag, requiredSampleDiagnostic(slug));
    pushRouteDiagnostic(diag, requiredSampleDiagnostic('components/missing-component/specs', {
      path: 'components/missing-component/specs.md',
      sourceRoute: 'components/missing-component',
      sourceUsed: 'failed',
      finalMethod: null,
      jsonSucceeded: false,
      directJsonSucceeded: false,
      fallbackReasons: ['json-no-sections'],
      virtualRoute: 'https://m3.material.io/components/missing-component/specs'
    }));

    const nextIndex = materialIndex(0, {
      pages: requiredSamplePages(),
      extractionDiagnostics: diag,
      coverageDiagnostics: {
        ...minimalCoverageDiagnostics({ isLimitedRun: false }),
        fullRoutePlanSummary: {
          acceptedRoutes: [],
          staleRoutes: [],
          removedRoutes: [],
          ambiguousRoutes: [],
          nonPublicRoutes: [],
          extractionCandidates: [{
            route: '/components/missing-component',
            canonicalRoute: '/components/missing-component',
            outputPath: 'components/missing-component.md',
            sources: ['site_meta', 'bundle'],
            publicDocsClassification: 'public-docs',
            reconciliationStatus: 'exact'
          }]
        }
      }
    });

    expect(() => assertSafeCachePromotion(nextIndex, null)).toThrow(
      'Accepted public documentation routes are missing from cache output: /components/missing-component[diag=y,virtual=y]'
    );
  });

  it('does not let compact unresolved examples fail promotion when saved virtual pages cover the accepted route', () => {
    const diag = createEmptyExtractionDiagnostics();
    for (const slug of REQUIRED_SAMPLE_SLUGS) pushRouteDiagnostic(diag, requiredSampleDiagnostic(slug));
    pushRouteDiagnostic(diag, requiredSampleDiagnostic('components/toolbars/overview', {
      sourceRoute: 'components/toolbars',
      virtualRoute: 'https://m3.material.io/components/toolbars/overview'
    }));

    const nextIndex = materialIndex(1, {
      pages: [
        ...requiredSamplePages(),
        {
          ...page,
          id: 'toolbars-overview',
          path: 'components/toolbars/overview.md',
          url: 'https://m3.material.io/components/toolbars/overview'
        }
      ],
      extractionDiagnostics: diag,
      coverageDiagnostics: {
        ...minimalCoverageDiagnostics({
          isLimitedRun: false,
          routePlanSummary: {
            acceptedRouteCount: 1,
            staleRouteCount: 0,
            ambiguousRouteCount: 0,
            nonPublicRouteCount: 0,
            extractionCandidateCount: 1,
            reconciliationStatusCounts: { exact: 1 },
            publicDocsClassificationCounts: { 'public-docs': 1 },
            problematicExamples: {
              staleRoutes: [],
              ambiguousRoutes: [],
              nonPublicRoutes: [],
              unresolvedAcceptedRoutes: [{
                route: '/components/toolbars',
                canonicalRoute: '/components/toolbars',
                outputPath: 'components/toolbars.md',
                publicDocsClassification: 'public-docs',
                reconciliationStatus: 'exact'
              }]
            }
          }
        })
      }
    });

    expect(() => assertSafeCachePromotion(nextIndex, null)).not.toThrow();
  });

  it('serializes a compact route plan summary into index.json', async () => {
    const nextIndex = materialIndex(1, {
      coverageDiagnostics: minimalCoverageDiagnostics({
        coverageHealth: 'partial',
        routePlanSummary: {
          acceptedRouteCount: 3,
          staleRouteCount: 1,
          ambiguousRouteCount: 2,
          nonPublicRouteCount: 4,
          extractionCandidateCount: 3,
          reconciliationStatusCounts: {
            exact: 1,
            normalizedSlugMatch: 2,
            rejectedAmbiguous: 2,
            rejectedNonPublic: 4,
            rejectedStale: 1
          },
          publicDocsClassificationCounts: {
            'public-docs': 6,
            'unsupported-platform-or-policy': 2,
            'missing-extraction-metadata': 1,
            'outside-public-docs': 1
          },
          problematicExamples: {
            staleRoutes: [{ route: '/components/legacy', reconciliationStatus: 'rejectedStale', publicDocsClassification: 'public-docs' }],
            ambiguousRoutes: [{ route: '/components/cards', reconciliationStatus: 'rejectedAmbiguous', publicDocsClassification: 'public-docs' }],
            nonPublicRoutes: [{ route: '/develop/android/compose', reconciliationStatus: 'rejectedNonPublic', publicDocsClassification: 'unsupported-platform-or-policy' }],
            unresolvedAcceptedRoutes: [{ route: '/components/switches', canonicalRoute: '/components/switch', reconciliationStatus: 'normalizedSlugMatch', publicDocsClassification: 'public-docs' }]
          }
        },
        fullRoutePlanSummary: {
          acceptedRoutes: [{
            route: '/components/switches',
            canonicalRoute: '/components/switch',
            outputPath: 'components/switch.md',
            sources: ['site_meta', 'bundle'],
            publicDocsClassification: 'public-docs',
            reconciliationStatus: 'normalizedSlugMatch'
          }],
          staleRoutes: [],
          removedRoutes: [],
          ambiguousRoutes: [],
          nonPublicRoutes: [],
          extractionCandidates: []
        }
      })
    });

    await writeIndex(nextIndex, cacheDir);

    const rawIndex = JSON.parse(await readFile(indexPath(cacheDir), 'utf8')) as Record<string, unknown>;
    expect(rawIndex.coverageDiagnostics).toMatchObject({
      coverageHealth: 'partial',
      routePlanSummary: {
        acceptedRouteCount: 3,
        ambiguousRouteCount: 2,
        publicDocsClassificationCounts: expect.objectContaining({
          'unsupported-platform-or-policy': 2
        }),
        problematicExamples: {
          unresolvedAcceptedRoutes: [
            expect.objectContaining({ canonicalRoute: '/components/switch' })
          ]
        }
      }
    });
    expect(JSON.stringify(rawIndex.coverageDiagnostics)).not.toContain('acceptedRoutes');
    expect(JSON.stringify(rawIndex.coverageDiagnostics)).not.toContain('fullRoutePlanSummary');
  });

  it('fails a --max-pages 20 smoke promotion when a required sample is absent from both pages and routeDiagnostics', () => {
    const diag = createEmptyExtractionDiagnostics();
    for (const slug of REQUIRED_SAMPLE_SLUGS.slice(1)) {
      pushRouteDiagnostic(diag, requiredSampleDiagnostic(slug, { selectedBecause: 'required-validation' }));
    }

    const pages: MaterialPage[] = REQUIRED_SAMPLE_SLUGS.slice(1).map((slug, i) => ({
      ...page,
      id: `req-${i}`,
      path: `${slug}.md`,
      url: `https://m3.material.io/${slug}`
    }));

    const nextIndex = materialIndex(pages.length, {
      pages,
      attemptedPageCount: 3,
      failedPageCount: 0,
      extractionDiagnostics: diag,
      // isLimitedRun:true alone (e.g. --max-pages 20) does not exempt an absent required sample —
      // only an explicit skippedReason:"not-selected" diagnostic does (see the tiny-maxPages test
      // below). Force-inclusion means a real --max-pages 20 run should never hit this case in
      // practice, but the validation itself must still fail it.
      coverageDiagnostics: minimalCoverageDiagnostics({ isLimitedRun: true, maxPagesExplicit: true })
    });

    expect(() => assertSafeCachePromotion(nextIndex, null)).toThrow('Required sample routes are missing or failed JSON extraction');
  });

  it('allows a --max-pages 20 smoke run where all required samples are force-included and valid', () => {
    const diag = createEmptyExtractionDiagnostics();
    for (const slug of REQUIRED_SAMPLE_SLUGS) {
      pushRouteDiagnostic(diag, requiredSampleDiagnostic(slug, { selectedBecause: 'required-validation' }));
    }

    const pages: MaterialPage[] = REQUIRED_SAMPLE_SLUGS.map((slug, i) => ({
      ...page,
      id: `req-${i}`,
      path: `${slug}.md`,
      url: `https://m3.material.io/${slug}`
    }));

    const nextIndex = materialIndex(pages.length, {
      pages,
      attemptedPageCount: 4,
      failedPageCount: 0,
      extractionDiagnostics: diag,
      coverageDiagnostics: minimalCoverageDiagnostics({ isLimitedRun: true, maxPagesExplicit: true })
    });

    expect(() => assertSafeCachePromotion(nextIndex, null)).not.toThrow();
  });

  it('does not fail promotion when a required sample could not even be reserved under a tiny maxPages', () => {
    const diag = createEmptyExtractionDiagnostics();
    pushRouteDiagnostic(diag, requiredSampleDiagnostic('components/buttons/specs', {
      sourceUsed: 'skipped',
      skippedReason: 'not-selected',
      directJsonAttempted: false,
      directJsonSucceeded: false,
      jsonAttempted: false,
      jsonSucceeded: false
    }));
    for (const slug of REQUIRED_SAMPLE_SLUGS.slice(1)) {
      pushRouteDiagnostic(diag, requiredSampleDiagnostic(slug, { selectedBecause: 'required-validation' }));
    }

    const pages: MaterialPage[] = REQUIRED_SAMPLE_SLUGS.slice(1).map((slug, i) => ({
      ...page,
      id: `req-${i}`,
      path: `${slug}.md`,
      url: `https://m3.material.io/${slug}`
    }));

    const nextIndex = materialIndex(pages.length, {
      pages,
      attemptedPageCount: 3,
      failedPageCount: 0,
      extractionDiagnostics: diag,
      coverageDiagnostics: minimalCoverageDiagnostics({ isLimitedRun: true, maxPagesExplicit: true })
    });

    expect(() => assertSafeCachePromotion(nextIndex, null)).not.toThrow();
  });

  it('allows first cache with discovery empty (unverified) without rejecting', () => {
    const unverifiedIndex = materialIndex(15, {
      coverageDiagnostics: {
        discoveredPublicUrlCount: 0,
        sitemapUrlCount: 0,
        renderedNavUrlCount: 0,
        angularRouteHintCount: 0,
        previousCacheRouteHintCount: 0,
        acceptedPageCount: 15,
        uncrawledDiscoveredUrlCount: 0,
        uncrawledDiscoveredUrls: [],
        skippedBecauseMaxPagesCount: 0,
        skippedBecauseJsonCoveredCount: 0,
        skippedByPolicyCount: 0,
        skippedBlogCount: 0,
        skippedByPolicyUrls: [],
        includeBlog: false,
        crawlPriorityPolicyVersion: '1',
        coverageVerified: false,
        coverageWarnings: ['coverage-discovery-empty:no-baseline'],
        coverageHealth: 'unverified'
      } satisfies CoverageDiagnostics
    });

    expect(() => assertSafeCachePromotion(unverifiedIndex, null)).not.toThrow();
  });
});

describe('computeCoverageHealth', () => {
  const baseDiag: Omit<CoverageDiagnostics, 'coverageWarnings' | 'coverageVerified' | 'coverageHealth'> = {
    discoveredPublicUrlCount: 100,
    sitemapUrlCount: 100,
    renderedNavUrlCount: 0,
    angularRouteHintCount: 0,
    previousCacheRouteHintCount: 0,
    acceptedPageCount: 100,
    uncrawledDiscoveredUrlCount: 0,
    uncrawledDiscoveredUrls: [],
    skippedBecauseMaxPagesCount: 0,
    skippedBecauseJsonCoveredCount: 0,
    skippedByPolicyCount: 0,
    skippedBlogCount: 0,
    skippedByPolicyUrls: [],
    includeBlog: false,
    crawlPriorityPolicyVersion: '1'
  };

  it('returns verified when discovery succeeded and all URLs crawled', () => {
    expect(computeCoverageHealth({ ...baseDiag, coverageVerified: true, coverageWarnings: [], coverageHealth: 'verified' })).toBe('verified');
  });

  it('returns partial when max-pages limited the crawl', () => {
    expect(computeCoverageHealth({ ...baseDiag, coverageVerified: false, coverageWarnings: ['coverage-partial:max-pages-limited:30'], coverageHealth: 'partial' })).toBe('partial');
  });

  it('returns partial even when a gap warning accompanies the max-pages warning', () => {
    expect(computeCoverageHealth({ ...baseDiag, coverageVerified: false, coverageWarnings: ['coverage-partial:max-pages-limited:30', 'coverage-gap:accepted=70:discovered=100'], coverageHealth: 'partial' })).toBe('partial');
  });

  it('returns failed when an unexpected coverage gap exists without max-pages', () => {
    expect(computeCoverageHealth({ ...baseDiag, coverageVerified: false, coverageWarnings: ['coverage-gap:accepted=10:discovered=100'], coverageHealth: 'failed' })).toBe('failed');
  });

  it('returns failed when a coverage regression is detected', () => {
    expect(computeCoverageHealth({ ...baseDiag, coverageVerified: false, coverageWarnings: ['coverage-regression:previous=100:current=70'], coverageHealth: 'failed' })).toBe('failed');
  });

  it('returns failed for regression even alongside a max-pages partial warning', () => {
    expect(computeCoverageHealth({ ...baseDiag, coverageVerified: false, coverageWarnings: ['coverage-partial:max-pages-limited:10', 'coverage-regression:previous=100:current=70'], coverageHealth: 'failed' })).toBe('failed');
  });

  it('returns unverified when discovery was empty', () => {
    expect(computeCoverageHealth({ ...baseDiag, discoveredPublicUrlCount: 0, coverageVerified: false, coverageWarnings: ['coverage-discovery-empty:no-baseline'], coverageHealth: 'unverified' })).toBe('unverified');
  });

  it('returns unverified when playwright was unavailable', () => {
    expect(computeCoverageHealth({ ...baseDiag, coverageVerified: false, coverageWarnings: ['coverage-unverified:playwright-unavailable'], coverageHealth: 'unverified' })).toBe('unverified');
  });
});
