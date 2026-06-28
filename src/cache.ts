import { mkdir, mkdtemp, readFile, rename, rm, stat, writeFile } from 'node:fs/promises';
import { homedir, tmpdir } from 'node:os';
import path from 'node:path';
import { z } from 'zod';
import { DEFAULT_CACHE_MAX_AGE_HOURS } from './constants.js';
import { isBlogPath } from './crawl-priority.js';
import { summarizeRouteCoverageFailure } from './route-coverage.js';
import type {
  CacheDiagnostics,
  CacheStatus,
  CompactRoutePlanBucketExample,
  CoverageHealth,
  CoverageDiagnostics,
  ExtractionRouteDiagnostic,
  MaterialIndex,
  MaterialPage,
  MaterialPublicIndex,
  MaterialPublicPageManifestEntry,
  RouteCoverageEntry,
  RoutePlanEntry,
  QualitySummary
} from './types.js';

const DiagnosticsDsdbFieldsSchema = z.object({
  directJsonEnabled: z.boolean().nullish(),
  browserOnlyFallback: z.boolean().nullish(),
  directJsonDisabledReason: z.string().nullish(),
  dsdbConfigSource: z.union([z.literal('site-meta'), z.literal('bundle'), z.literal('browser-network')]).nullish(),
  siteMetaFetched: z.boolean().nullish(),
  siteMetaFailed: z.boolean().nullish(),
  bundleDiscoveryFailed: z.boolean().nullish(),
  networkRecoveryAttempted: z.boolean().nullish(),
  networkRecoverySucceeded: z.boolean().nullish(),
  networkRecoveryFailureReason: z.string().nullish()
}).passthrough();

async function readDsdbFieldsFromDiagnostics(diagPath: string): Promise<z.output<typeof DiagnosticsDsdbFieldsSchema> | null> {
  try {
    const raw: unknown = JSON.parse(await readFile(diagPath, 'utf8'));
    const result = DiagnosticsDsdbFieldsSchema.safeParse(raw);
    return result.success ? result.data : null;
  } catch {
    return null;
  }
}

async function readDiagnosticsJson(diagPath: string): Promise<Record<string, unknown> | null> {
  try {
    const raw: unknown = JSON.parse(await readFile(diagPath, 'utf8'));
    return isRecord(raw) ? raw : null;
  } catch {
    return null;
  }
}

async function pathIfExists(filePath: string): Promise<string | null> {
  try {
    await stat(filePath);
    return filePath;
  } catch {
    return null;
  }
}

const DEFAULT_MIN_RETAINED_PAGE_RATIO = 0.8;
export const DEFAULT_MAX_FAILED_PAGE_RATIO = 0.2;
const MIN_ATTEMPTS_FOR_FAILURE_RATIO_CHECK = 10;

export function computeCoverageHealth(diag: CoverageDiagnostics): CoverageHealth {
  const warnings = diag.coverageWarnings;
  const routeCoverageSummary = diag.routeCoverageSummary;
  const hasRegression = warnings.some((w) => w.startsWith('coverage-regression:'));
  const hasGap = warnings.some((w) => w.startsWith('coverage-gap:'));
  const hasPartial = warnings.some((w) => w.startsWith('coverage-partial:max-pages-limited:'));
  const hasDirectJsonFailure = warnings.some((w) => w.startsWith('direct-json-failure:'));
  const hasRouteFailures = (routeCoverageSummary?.failedRoutes ?? 0) > 0 || (routeCoverageSummary?.unresolvedRoutes ?? 0) > 0;
  const hasUnexpectedPartialRoutes = (routeCoverageSummary?.partialRoutes ?? 0) > 0;
  // Regression always means failed regardless of partial flag
  if (hasRegression) return 'failed';
  // Every direct JSON attempt failing means the extraction pipeline is broken
  if (hasDirectJsonFailure) return 'broken';
  if (hasRouteFailures || hasUnexpectedPartialRoutes) return 'failed';
  // An unexpected coverage gap (no max-pages explanation) is a failure
  if (hasGap && !hasPartial) return 'failed';
  if (diag.coverageVerified) return 'verified';
  if (hasPartial) return 'partial';
  return 'unverified';
}

function firstCacheCoveragePolicy(nextIndex: MaterialIndex): void {
  const diag = nextIndex.coverageDiagnostics;
  if (!diag) return;
  // A limited run (explicit --max-pages, or maxPages truncated route selection) intentionally
  // scopes down extraction — comparing its accepted-page count against the full discovered site
  // is not a valid signal there. Only a full refresh enforces this gap strictly.
  if (diag.isLimitedRun) return;
  const warnings = diag.coverageWarnings;
  const hasPartial = warnings.some((w) => w.startsWith('coverage-partial:max-pages-limited:'));
  const hasGap = warnings.some((w) => w.startsWith('coverage-gap:'));
  if (hasGap && !hasPartial) {
    const gapWarning = warnings.find((w) => w.startsWith('coverage-gap:')) ?? 'coverage-gap';
    throw new Error(`Material 3 cache has a significant coverage gap (${gapWarning}) on a full refresh. Discovery found more public URLs than were accepted. Use --force to promote anyway.`);
  }
}

type CachePromotionSafetyOptions = {
  force?: boolean;
  minRetainedPageRatio?: number;
  maxFailedPageRatio?: number;
};

export function getDefaultCacheDir(): string {
  if (process.env.M3_DOCS_CACHE_DIR) return process.env.M3_DOCS_CACHE_DIR;
  if (process.env.XDG_CACHE_HOME) return path.join(process.env.XDG_CACHE_HOME, 'm3-docs-mcp');
  if (process.platform === 'darwin') return path.join(homedir(), 'Library', 'Caches', 'm3-docs-mcp');
  if (process.platform === 'win32' && process.env.LOCALAPPDATA) return path.join(process.env.LOCALAPPDATA, 'm3-docs-mcp');
  return path.join(homedir(), '.cache', 'm3-docs-mcp');
}

export function pagesDir(cacheDir = getDefaultCacheDir()): string {
  return path.join(cacheDir, 'pages');
}

export function logsDir(cacheDir = getDefaultCacheDir()): string {
  return path.join(cacheDir, 'logs');
}

export function diagnosticsDir(cacheDir = getDefaultCacheDir()): string {
  return path.join(cacheDir, 'diagnostics');
}

export function latestLogPath(cacheDir = getDefaultCacheDir()): string {
  return path.join(logsDir(cacheDir), 'latest.jsonl');
}

export function latestDiagnosticsPath(cacheDir = getDefaultCacheDir()): string {
  return path.join(diagnosticsDir(cacheDir), 'latest-update.json');
}

export function indexPath(cacheDir = getDefaultCacheDir()): string {
  return path.join(cacheDir, 'index.json');
}

export async function ensureCacheDirs(cacheDir = getDefaultCacheDir()): Promise<void> {
  await mkdir(pagesDir(cacheDir), { recursive: true });
}

export async function readIndex(cacheDir = getDefaultCacheDir()): Promise<MaterialIndex | null> {
  try {
    return normalizeIndex(JSON.parse(await readFile(indexPath(cacheDir), 'utf8')) as Partial<MaterialIndex> & { pages?: Array<Partial<MaterialPublicPageManifestEntry> & { url?: string }> });
  } catch {
    return null;
  }
}

export async function writeIndex(index: MaterialIndex, cacheDir = getDefaultCacheDir()): Promise<void> {
  await ensureCacheDirs(cacheDir);
  await writeFile(indexPath(cacheDir), `${JSON.stringify(toPublicIndex(index), null, 2)}\n`, 'utf8');
}

export async function writePage(page: MaterialPage, cacheDir = getDefaultCacheDir()): Promise<void> {
  await ensureCacheDirs(cacheDir);
  const file = path.join(pagesDir(cacheDir), page.path);
  await mkdir(path.dirname(file), { recursive: true });
  await writeFile(file, page.markdown, 'utf8');
}

export async function readPage(pagePath: string, cacheDir = getDefaultCacheDir()): Promise<string> {
  return readFile(path.join(pagesDir(cacheDir), pagePath), 'utf8');
}

export async function cacheAgeMs(cacheDir = getDefaultCacheDir()): Promise<number | null> {
  try {
    const s = await stat(indexPath(cacheDir));
    return Math.max(0, Date.now() - s.mtimeMs);
  } catch {
    return null;
  }
}

export function isCacheFresh(ageMs: number | null, maxAgeHours: number): boolean {
  if (ageMs === null) return false;
  return ageMs < maxAgeHours * 60 * 60 * 1000;
}

export async function cacheStatus(cacheDir = getDefaultCacheDir(), maxAgeHours = DEFAULT_CACHE_MAX_AGE_HOURS): Promise<CacheStatus> {
  const index = await readIndex(cacheDir);
  const ageMs = await cacheAgeMs(cacheDir);
  const coverageHealth = index?.coverageDiagnostics?.coverageHealth;
  return {
    cacheDir,
    hasCache: Boolean(index),
    source: index?.source ?? null,
    capturedAt: index?.capturedAt ?? null,
    pageCount: index?.pageCount ?? 0,
    attemptedPageCount: index?.attemptedPageCount ?? 0,
    failedPageCount: index?.failedPageCount ?? 0,
    failedUrls: index?.failedUrls ?? [],
    ageMs,
    ttlMs: maxAgeHours * 60 * 60 * 1000,
    isFresh: isCacheFresh(ageMs, maxAgeHours),
    ...(coverageHealth !== undefined ? { coverageHealth } : {}),
    ...(index?.coverageDiagnostics?.routeCoverageSummary ? { routeCoverageSummary: index.coverageDiagnostics.routeCoverageSummary } : {}),
    ...(index?.qualitySummary ? { qualitySummary: index.qualitySummary } : {})
  };
}

export async function getCacheDiagnostics(cacheDir = getDefaultCacheDir()): Promise<CacheDiagnostics> {
  const diagPath = latestDiagnosticsPath(cacheDir);
  const [latestLogFile, latestDiagnosticsFile, dsdbFields, diagnostics] = await Promise.all([
    pathIfExists(latestLogPath(cacheDir)),
    pathIfExists(diagPath),
    readDsdbFieldsFromDiagnostics(diagPath),
    readDiagnosticsJson(diagPath)
  ]);
  return {
    cacheDir,
    latestDiagnosticsFile,
    latestLogFile,
    diagnostics,
    ...(dsdbFields?.directJsonEnabled != null ? { directJsonEnabled: dsdbFields.directJsonEnabled } : {}),
    ...(dsdbFields?.browserOnlyFallback != null ? { browserOnlyFallback: dsdbFields.browserOnlyFallback } : {}),
    ...(dsdbFields?.directJsonDisabledReason != null ? { directJsonDisabledReason: dsdbFields.directJsonDisabledReason } : {}),
    ...(dsdbFields?.dsdbConfigSource != null ? { dsdbConfigSource: dsdbFields.dsdbConfigSource } : {}),
    ...(dsdbFields?.siteMetaFetched != null ? { siteMetaFetched: dsdbFields.siteMetaFetched } : {}),
    ...(dsdbFields?.siteMetaFailed != null ? { siteMetaFailed: dsdbFields.siteMetaFailed } : {}),
    ...(dsdbFields?.bundleDiscoveryFailed != null ? { bundleDiscoveryFailed: dsdbFields.bundleDiscoveryFailed } : {}),
    ...(dsdbFields?.networkRecoveryAttempted != null ? { networkRecoveryAttempted: dsdbFields.networkRecoveryAttempted } : {}),
    ...(dsdbFields?.networkRecoverySucceeded != null ? { networkRecoverySucceeded: dsdbFields.networkRecoverySucceeded } : {}),
    ...(dsdbFields?.networkRecoveryFailureReason != null ? { networkRecoveryFailureReason: dsdbFields.networkRecoveryFailureReason } : {})
  };
}

export async function createStagingCacheDir(targetCacheDir = getDefaultCacheDir()): Promise<string> {
  const parentDir = path.dirname(targetCacheDir);
  await mkdir(parentDir, { recursive: true });
  return mkdtemp(path.join(parentDir || tmpdir(), '.m3-docs-mcp-staging-'));
}

export async function promoteStagingCache(stagingDir: string, targetCacheDir = getDefaultCacheDir()): Promise<void> {
  const backupDir = `${targetCacheDir}.previous`;
  await rm(backupDir, { recursive: true, force: true });

  let movedExisting = false;
  try {
    await rename(targetCacheDir, backupDir);
    movedExisting = true;
  } catch (error) {
    if (!isMissingPathError(error)) throw error;
  }

  try {
    await rename(stagingDir, targetCacheDir);
  } catch (error) {
    if (movedExisting) await rename(backupDir, targetCacheDir);
    throw error;
  }

  await rm(backupDir, { recursive: true, force: true });
}

export function assertValidIndex(index: MaterialIndex, minPageCount: number): void {
  if (index.pageCount < minPageCount) {
    throw new Error(`Material 3 crawl produced ${index.pageCount} pages, below the required minimum of ${minPageCount}. Keeping the existing cache.`);
  }
  if (index.pages.length !== index.pageCount) {
    throw new Error(`Material 3 crawl produced an inconsistent index: pageCount=${index.pageCount}, pages=${index.pages.length}. Keeping the existing cache.`);
  }
}

const REQUIRED_SAMPLE_SLUGS = [
  'components/buttons/specs',
  'components/lists/specs',
  'styles/color/roles',
  'foundations/design-tokens/overview',
];

export function assertSafeCachePromotion(nextIndex: MaterialIndex, previousIndex: MaterialIndex | null, options: CachePromotionSafetyOptions = {}): void {
  if (options.force) return;

  // Fail if the direct JSON extraction pipeline is completely broken.
  const warnings = nextIndex.coverageDiagnostics?.coverageWarnings ?? [];
  if (warnings.some((w) => w.startsWith('direct-json-failure:'))) {
    throw new Error(
      'Direct JSON extraction was attempted but produced 0 accepted pages. ' +
      'The extraction pipeline appears broken. Keeping the existing cache. Use --force to promote anyway.'
    );
  }

  const routeDiagnostics = nextIndex.extractionDiagnostics?.routeDiagnostics ?? [];
  const coverageDiag = nextIndex.coverageDiagnostics;
  const extractionDiag = nextIndex.extractionDiagnostics;
  const routeCoverage = coverageDiag?.routeCoverage ?? [];

  // Accounting invariant: every attempted source route's virtual pages must be accounted for as
  // either saved or failed — never silently dropped. This should always hold by construction; a
  // mismatch indicates a real bug in the diagnostics pipeline, not a content/coverage problem.
  if (
    extractionDiag &&
    extractionDiag.virtualPagesPlanned !== extractionDiag.virtualPagesSaved + extractionDiag.virtualPagesFailed
  ) {
    throw new Error(
      `Material 3 crawl diagnostics are inconsistent: virtualPagesPlanned=${extractionDiag.virtualPagesPlanned} but ` +
      `virtualPagesSaved=${extractionDiag.virtualPagesSaved} + virtualPagesFailed=${extractionDiag.virtualPagesFailed} ` +
      `does not match. Keeping the existing cache. Use --force to promote anyway.`
    );
  }

  // Full refresh only: every selected/resolvable source route must actually have been attempted.
  // resolvableSourceRouteCount includes blog routes when includeBlog:false explicitly excludes them
  // before the fetch loop runs (a legitimate, intentional exclusion, not a coverage gap), so that
  // count is subtracted out before comparing.
  if (!coverageDiag?.isLimitedRun && coverageDiag?.resolvableSourceRouteCount !== undefined && coverageDiag.attemptedSourceRouteCount !== undefined) {
    const expectedAttempted = (coverageDiag.includeBlog ?? false)
      ? coverageDiag.resolvableSourceRouteCount
      : Math.max(0, coverageDiag.resolvableSourceRouteCount - (coverageDiag.blogRouteCount ?? 0));
    const unattempted = expectedAttempted - coverageDiag.attemptedSourceRouteCount;
    if (unattempted > 0 && unattempted >= Math.max(5, Math.ceil(expectedAttempted * DEFAULT_MAX_FAILED_PAGE_RATIO))) {
      throw new Error(
        `Material 3 crawl only attempted ${coverageDiag.attemptedSourceRouteCount} of ${expectedAttempted} ` +
        `selected/resolvable source routes on a full refresh. Keeping the existing cache. Use --force to promote anyway.`
      );
    }
  }

  // Fail if the deterministic page-data pipeline (routes resolved via the bundle-table page
  // reference resolver — the default path) was attempted at all but nothing was saved from it.
  // Scoped to pageReferenceSource:"bundle-table" so it doesn't penalize the legacy degraded
  // browser-network-recovery path, where direct JSON is attempted best-effort and DOM fallback
  // is the expected compensator.
  const deterministicAttempts = routeDiagnostics.filter((d) => d.pageReferenceSource === 'bundle-table' && d.directJsonAttempted);
  const deterministicSaved = deterministicAttempts.filter((d) => d.sourceUsed === 'direct-json').length;
  if (deterministicAttempts.length > 0 && deterministicSaved === 0) {
    throw new Error(
      `Direct JSON page-data was attempted for ${deterministicAttempts.length} route(s) but 0 were saved. ` +
      'Keeping the existing cache. Use --force to promote anyway.'
    );
  }

  // Fail if includeBlog:false was requested but a /blog route was nonetheless attempted. A
  // policy-skipped /blog or /blog/* route (sourceUsed:"skipped", skippedReason:"blog", and never
  // actually fetched via direct-json/network-json/DOM fallback) is the *expected* outcome of
  // includeBlog:false, not a violation of it — only a route that was actually attempted counts.
  const includeBlog = nextIndex.coverageDiagnostics?.includeBlog ?? false;
  if (!includeBlog) {
    const attemptedBlogRoute = routeDiagnostics.find((d) => {
      const routePath = d.path.replace(/\.md$/, '').replace(/^\/+/, '');
      if (!isBlogPath(routePath)) return false;
      const policySkipped = d.sourceUsed === 'skipped'
        && d.skippedReason === 'blog'
        && !d.directJsonAttempted
        && !d.networkJsonAttempted
        && !d.domFallbackAttempted;
      return !policySkipped;
    });
    if (attemptedBlogRoute) {
      throw new Error(
        `includeBlog:false was set but a /blog route was attempted (${attemptedBlogRoute.path}). ` +
        'Keeping the existing cache. Use --force to promote anyway.'
      );
    }
  }

  // Fail if token/spec tables were expected but none were rendered.
  const diag = nextIndex.extractionDiagnostics;
  if (diag && diag.tokenTablesRequested > 0 && diag.tokenTablesSuccessfullyRendered === 0) {
    throw new Error(
      `Token tables were requested (${diag.tokenTablesRequested}) but none rendered successfully. ` +
      'Keeping the existing cache. Use --force to promote anyway.'
    );
  }

  if (nextIndex.qualityReport?.duplicateContent.length) {
    const duplicate = nextIndex.qualityReport.duplicateContent[0];
    throw new Error(`Material 3 crawl produced duplicate page content for ${duplicate?.paths.join(', ') ?? 'multiple pages'}. Keeping the existing cache. Use --force to replace it anyway.`);
  }

  if (nextIndex.qualityReport?.suspiciousPages.length) {
    const suspicious = nextIndex.qualityReport.suspiciousPages[0];
    throw new Error(`Material 3 crawl produced suspicious page content for ${suspicious?.path ?? 'a page'}: ${suspicious?.reason ?? 'unknown reason'}. Keeping the existing cache. Use --force to replace it anyway.`);
  }

  // First-cache coverage policy: even without a previous index, an unexpected
  // coverage gap must not silently produce a cache that appears complete.
  firstCacheCoveragePolicy(nextIndex);

  const maxFailedPageRatio = options.maxFailedPageRatio ?? DEFAULT_MAX_FAILED_PAGE_RATIO;
  if (extractionDiag) {
    // Modern diagnostics separate source-route failures (a route counts as failed only if none of
    // its virtual/tab pages were saved) from virtual-page failures, instead of dividing
    // nextIndex.failedPageCount (virtual-page-level) by nextIndex.attemptedPageCount
    // (source-route-level) — two different units that produce a meaningless ratio.
    if (typeof extractionDiag.sourcePagesAttempted !== 'number' || typeof extractionDiag.sourcePagesFailed !== 'number') {
      throw new Error(
        'Material 3 crawl diagnostics are missing source-route failure counters (sourcePagesAttempted/sourcePagesFailed). ' +
        'Keeping the existing cache. Use --force to promote anyway.'
      );
    }
    if (extractionDiag.sourcePagesAttempted >= MIN_ATTEMPTS_FOR_FAILURE_RATIO_CHECK) {
      const sourceRouteFailureRatio = extractionDiag.sourcePagesFailed / extractionDiag.sourcePagesAttempted;
      if (sourceRouteFailureRatio > maxFailedPageRatio) {
        throw new Error(
          `Material 3 crawl failed ${extractionDiag.sourcePagesFailed} of ${extractionDiag.sourcePagesAttempted} attempted source routes ` +
          `(${formatPercent(sourceRouteFailureRatio)}; a source route counts as failed only when none of its pages were saved), ` +
          `above the allowed ${formatPercent(maxFailedPageRatio)}. Keeping the existing cache. Use --force to replace it anyway.`
        );
      }
    }

    // Missing virtualPagesPlanned/Saved/Failed counters are already caught above by the
    // accounting invariant check (planned !== saved + failed, which a missing/undefined field
    // always fails) before this point is reached.
    if (extractionDiag.virtualPagesPlanned >= MIN_ATTEMPTS_FOR_FAILURE_RATIO_CHECK) {
      const virtualPageFailureRatio = extractionDiag.virtualPagesFailed / extractionDiag.virtualPagesPlanned;
      if (virtualPageFailureRatio > maxFailedPageRatio) {
        throw new Error(
          `Material 3 crawl failed ${extractionDiag.virtualPagesFailed} of ${extractionDiag.virtualPagesPlanned} planned virtual pages ` +
          `(${formatPercent(virtualPageFailureRatio)}), above the allowed ${formatPercent(maxFailedPageRatio)}. ` +
          'Keeping the existing cache. Use --force to replace it anyway.'
        );
      }
    }
  } else if (nextIndex.attemptedPageCount >= MIN_ATTEMPTS_FOR_FAILURE_RATIO_CHECK) {
    // Legacy fallback for old indexes that predate extraction diagnostics — only the coarse,
    // unit-mixed attemptedPageCount/failedPageCount counters are available.
    const failedPageRatio = nextIndex.failedPageCount / nextIndex.attemptedPageCount;
    if (failedPageRatio > maxFailedPageRatio) {
      throw new Error(`Material 3 crawl failed ${nextIndex.failedPageCount} of ${nextIndex.attemptedPageCount} attempted pages (${formatPercent(failedPageRatio)}), above the allowed ${formatPercent(maxFailedPageRatio)}. Keeping the existing cache. Use --force to replace it anyway.`);
    }
  }

  if (previousIndex && previousIndex.pageCount > 0) {
    const previousDiscoveredCount = previousIndex.coverageDiagnostics?.discoveredPublicUrlCount ?? previousIndex.pageCount;
    const nextDiscoveredCount = nextIndex.coverageDiagnostics?.discoveredPublicUrlCount ?? nextIndex.pageCount;
    const intentionalPartial = nextIndex.coverageDiagnostics?.isLimitedRun
      ?? (nextIndex.coverageDiagnostics?.coverageWarnings.some((warning) => warning.startsWith('coverage-partial:max-pages-limited:')) ?? false);
    if (!intentionalPartial && previousDiscoveredCount > 0 && nextDiscoveredCount > 0) {
      const minDiscoveredPages = Math.ceil(previousDiscoveredCount * DEFAULT_MIN_RETAINED_PAGE_RATIO);
      if (nextDiscoveredCount < minDiscoveredPages) {
        throw new Error(`Material 3 crawl discovered only ${nextDiscoveredCount} public documentation URLs, below ${formatPercent(DEFAULT_MIN_RETAINED_PAGE_RATIO)} of the previous cache coverage (${previousDiscoveredCount}). Keeping the existing cache. Use --force to replace it anyway.`);
      }
    }

    const minRetainedPageRatio = options.minRetainedPageRatio ?? DEFAULT_MIN_RETAINED_PAGE_RATIO;
    const minAcceptedPages = Math.ceil(previousIndex.pageCount * minRetainedPageRatio);
    if (nextIndex.pageCount < minAcceptedPages) {
      throw new Error(`Material 3 crawl produced ${nextIndex.pageCount} pages, which is below ${formatPercent(minRetainedPageRatio)} of the previous cache (${previousIndex.pageCount} pages). Keeping the existing cache. Use --force to replace it anyway.`);
    }
  }

  // Fail if any required sample route is missing from the saved cache pages, failed JSON
  // extraction, or has no diagnostic at all. Route diagnostic / cache page paths are cache file
  // paths (always ".md"-suffixed, e.g. "components/buttons/specs.md"), including for virtual tab
  // pages — compare against that form, not the bare URL slug. The only exemption: a required path
  // that filterRoutes itself explicitly couldn't reserve a slot for (skippedReason:"not-selected",
  // i.e. maxPages is smaller than the required-route reservation) is a budget choice, not an
  // extraction failure — but the absence of any diagnostic at all is NOT that signal and must fail.
  // Checked last so a more specific, more actionable rejection reason (broken pipeline, coverage
  // gap, retention ratio, etc.) surfaces first when several problems exist simultaneously.
  const savedPagePaths = new Set(nextIndex.pages.map((p) => p.path));
  const failedRequired = REQUIRED_SAMPLE_SLUGS.filter((slug) => {
    const cachePath = `${slug}.md`;
    const diag = routeDiagnostics.find((d) => d.path === cachePath);
    if (diag?.skippedReason === 'not-selected') return false;
    return !savedPagePaths.has(cachePath);
  });
  if (failedRequired.length > 0) {
    throw new Error(
      `Required sample routes are missing or failed JSON extraction: ${failedRequired.join(', ')}. ` +
      'Keeping the existing cache. Use --force to promote anyway.'
    );
  }

  const routePlanSummary = nextIndex.coverageDiagnostics?.fullRoutePlanSummary;
  const compactRoutePlanSummary = nextIndex.coverageDiagnostics?.routePlanSummary;
  const fullRunRouteCoverage = !(nextIndex.coverageDiagnostics?.isLimitedRun ?? false)
    ? routeCoverage
    : [];
  if (!(nextIndex.coverageDiagnostics?.isLimitedRun ?? false) && fullRunRouteCoverage.length > 0) {
    const unresolvedAcceptedRoutes = fullRunRouteCoverage.filter((entry) => (
      entry.status === 'unresolved'
      || entry.status === 'failed'
      || entry.status === 'partial'
    ));
    if (unresolvedAcceptedRoutes.length > 0) {
      throw new Error(
        `Accepted public documentation routes are missing from cache output: ${unresolvedAcceptedRoutes.map(summarizeRouteCoverageFailure).join('; ')}. ` +
        'Keeping the existing cache. Use --force to promote anyway.'
      );
    }
  }
  if (!(nextIndex.coverageDiagnostics?.isLimitedRun ?? false) && routePlanSummary) {
    if (routePlanSummary.ambiguousRoutes.length > 0) {
      throw new Error(
        `Public documentation routes were ambiguous during reconciliation: ${routePlanSummary.ambiguousRoutes.map((entry) => entry.route).join(', ')}. ` +
        'Keeping the existing cache. Use --force to promote anyway.'
      );
    }
  } else if (!(nextIndex.coverageDiagnostics?.isLimitedRun ?? false) && compactRoutePlanSummary) {
    const ambiguousExamples = compactRoutePlanSummary.problematicExamples.ambiguousRoutes;
    if ((compactRoutePlanSummary.reconciliationStatusCounts.rejectedAmbiguous ?? 0) > 0) {
      throw new Error(
        `Public documentation routes were ambiguous during reconciliation: ${ambiguousExamples.map((entry) => entry.route).join(', ') || 'see diagnostics'}. ` +
        'Keeping the existing cache. Use --force to promote anyway.'
      );
    }
  }
}

function normalizeIndex(index: Partial<MaterialIndex>): MaterialIndex {
  const pages = (index.pages ?? []).map((page) => normalizePageMeta(page, index.capturedAt ?? ''));
  return {
    source: index.source ?? 'https://m3.material.io',
    capturedAt: index.capturedAt ?? '',
    pageCount: index.pageCount ?? pages.length,
    attemptedPageCount: index.attemptedPageCount ?? index.pageCount ?? pages.length,
    failedPageCount: index.failedPageCount ?? 0,
    failedUrls: index.failedUrls ?? [],
    ...(index.qualitySummary ? { qualitySummary: index.qualitySummary } : {}),
    ...(index.extractionDiagnostics ? { extractionDiagnostics: index.extractionDiagnostics } : {}),
    ...(index.coverageDiagnostics ? { coverageDiagnostics: index.coverageDiagnostics } : {}),
    ...(index.qualityReport ? { qualityReport: index.qualityReport } : {}),
    pages
  };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function normalizePageMeta(page: Partial<MaterialIndex['pages'][number]> & { sourceUrl?: string; url?: string }, capturedAt: string): MaterialIndex['pages'][number] {
  const pagePath = page.path ?? '';
  const sourceUrl = page.sourceUrl ?? page.url ?? '';
  return {
    id: page.id ?? pagePath,
    title: page.title ?? pagePath,
    url: sourceUrl,
    path: pagePath,
    section: page.section ?? '',
    headings: page.headings ?? [],
    capturedAt: page.capturedAt ?? capturedAt,
    ...(page.publishedYear !== undefined ? { publishedYear: page.publishedYear } : {})
  };
}

function summarizeQualityReport(report: MaterialIndex['qualityReport']): QualitySummary | undefined {
  if (!report) return undefined;
  return {
    suspiciousPageCount: report.suspiciousPages.length,
    rejectedRouteCount: report.rejectedRoutes.length,
    duplicateContentGroupCount: report.duplicateContent.length,
    shortPageCount: report.shortPages.length,
    duplicateTitleGroupCount: report.duplicateTitles.length
  };
}

function toCompactRoutePlanExample(entry: {
  route: string;
  canonicalRoute?: string;
  outputPath?: string;
  reconciliationStatus: string;
  publicDocsClassification: string;
  navTitle?: string;
  routeTitle?: string;
  skippedReason?: string;
  failureReason?: string;
}): CompactRoutePlanBucketExample {
  return {
    route: entry.route,
    ...(entry.canonicalRoute ? { canonicalRoute: entry.canonicalRoute } : {}),
    ...(entry.outputPath ? { outputPath: entry.outputPath } : {}),
    reconciliationStatus: entry.reconciliationStatus as CompactRoutePlanBucketExample['reconciliationStatus'],
    publicDocsClassification: entry.publicDocsClassification as CompactRoutePlanBucketExample['publicDocsClassification'],
    ...(entry.navTitle ? { navTitle: entry.navTitle } : {}),
    ...(entry.routeTitle ? { routeTitle: entry.routeTitle } : {}),
    ...(entry.skippedReason ? { skippedReason: entry.skippedReason } : {}),
    ...(entry.failureReason ? { failureReason: entry.failureReason } : {}),
  };
}

function toPublicIndex(index: MaterialIndex): MaterialPublicIndex {
  return {
    source: index.source,
    capturedAt: index.capturedAt,
    pageCount: index.pageCount,
    attemptedPageCount: index.attemptedPageCount,
    failedPageCount: index.failedPageCount,
    failedUrls: index.failedUrls,
    ...(index.qualitySummary || index.qualityReport ? { qualitySummary: index.qualitySummary ?? summarizeQualityReport(index.qualityReport) } : {}),
    ...(index.coverageDiagnostics ? {
      coverageDiagnostics: {
        ...(index.coverageDiagnostics.coverageHealth ? { coverageHealth: index.coverageDiagnostics.coverageHealth } : {}),
        ...(index.coverageDiagnostics.routePlanSummary ? { routePlanSummary: index.coverageDiagnostics.routePlanSummary } : {}),
        ...(index.coverageDiagnostics.routeCoverageSummary ? { routeCoverageSummary: index.coverageDiagnostics.routeCoverageSummary } : {}),
      }
    } : {}),
    pages: index.pages.map((page) => ({
      path: page.path,
      title: page.title,
      sourceUrl: page.url,
      section: page.section,
      headings: page.headings,
      ...(page.publishedYear !== undefined ? { publishedYear: page.publishedYear } : {})
    }))
  };
}

function isMissingPathError(error: unknown): boolean {
  return typeof error === 'object' && error !== null && 'code' in error && error.code === 'ENOENT';
}

function formatPercent(value: number): string {
  return `${Math.round(value * 100)}%`;
}
