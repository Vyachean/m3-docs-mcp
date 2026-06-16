import { mkdir, mkdtemp, readFile, rename, rm, stat, writeFile } from 'node:fs/promises';
import { homedir, tmpdir } from 'node:os';
import path from 'node:path';
import { DEFAULT_CACHE_MAX_AGE_HOURS } from './constants.js';
import type { CacheStatus, CoverageHealth, CoverageDiagnostics, MaterialIndex, MaterialPage } from './types.js';

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
  const hasRegression = warnings.some((w) => w.startsWith('coverage-regression:'));
  const hasGap = warnings.some((w) => w.startsWith('coverage-gap:'));
  const hasPartial = warnings.some((w) => w.startsWith('coverage-partial:max-pages-limited:'));
  // Regression always means failed regardless of partial flag
  if (hasRegression) return 'failed';
  // An unexpected coverage gap (no max-pages explanation) is a failure
  if (hasGap && !hasPartial) return 'failed';
  if (diag.coverageVerified) return 'verified';
  if (hasPartial) return 'partial';
  return 'unverified';
}

function firstCacheCoveragePolicy(nextIndex: MaterialIndex): void {
  const diag = nextIndex.coverageDiagnostics;
  if (!diag) return;
  const warnings = diag.coverageWarnings;
  const hasPartial = warnings.some((w) => w.startsWith('coverage-partial:max-pages-limited:'));
  const hasGap = warnings.some((w) => w.startsWith('coverage-gap:'));
  if (hasGap && !hasPartial) {
    const gapWarning = warnings.find((w) => w.startsWith('coverage-gap:')) ?? 'coverage-gap';
    throw new Error(`Material 3 cache has a significant coverage gap (${gapWarning}) without an intentional --max-pages limit. Discovery found more public URLs than were accepted. Use --force to promote anyway.`);
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
    return normalizeIndex(JSON.parse(await readFile(indexPath(cacheDir), 'utf8')) as Partial<MaterialIndex>);
  } catch {
    return null;
  }
}

export async function writeIndex(index: MaterialIndex, cacheDir = getDefaultCacheDir()): Promise<void> {
  await ensureCacheDirs(cacheDir);
  await writeFile(indexPath(cacheDir), `${JSON.stringify(index, null, 2)}\n`, 'utf8');
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
  const [latestLogFile, latestDiagnosticsFile] = await Promise.all([
    pathIfExists(latestLogPath(cacheDir)),
    pathIfExists(latestDiagnosticsPath(cacheDir))
  ]);
  return {
    cacheDir,
    hasCache: Boolean(index),
    capturedAt: index?.capturedAt ?? null,
    pageCount: index?.pageCount ?? 0,
    attemptedPageCount: index?.attemptedPageCount ?? 0,
    failedPageCount: index?.failedPageCount ?? 0,
    failedUrls: index?.failedUrls ?? [],
    ageMs,
    isFresh: isCacheFresh(ageMs, maxAgeHours),
    ...(coverageHealth !== undefined ? { coverageHealth } : {}),
    ...(index?.extractionDiagnostics ? { extractionDiagnostics: index.extractionDiagnostics } : {}),
    ...(index?.coverageDiagnostics ? { coverageDiagnostics: index.coverageDiagnostics } : {}),
    latestLogFile,
    latestDiagnosticsFile
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

export function assertSafeCachePromotion(nextIndex: MaterialIndex, previousIndex: MaterialIndex | null, options: CachePromotionSafetyOptions = {}): void {
  if (options.force) return;

  if (nextIndex.qualityReport?.duplicateContent.length) {
    const duplicate = nextIndex.qualityReport.duplicateContent[0];
    throw new Error(`Material 3 crawl produced duplicate page content for ${duplicate?.paths.join(', ') ?? 'multiple pages'}. Keeping the existing cache. Use --force to replace it anyway.`);
  }

  if (nextIndex.qualityReport?.suspiciousPages.length) {
    const suspicious = nextIndex.qualityReport.suspiciousPages[0];
    throw new Error(`Material 3 crawl produced suspicious page content for ${suspicious?.path ?? 'a page'}: ${suspicious?.reason ?? 'unknown reason'}. Keeping the existing cache. Use --force to replace it anyway.`);
  }

  const maxFailedPageRatio = options.maxFailedPageRatio ?? DEFAULT_MAX_FAILED_PAGE_RATIO;
  if (nextIndex.attemptedPageCount >= MIN_ATTEMPTS_FOR_FAILURE_RATIO_CHECK) {
    const failedPageRatio = nextIndex.failedPageCount / nextIndex.attemptedPageCount;
    if (failedPageRatio > maxFailedPageRatio) {
      throw new Error(`Material 3 crawl failed ${nextIndex.failedPageCount} of ${nextIndex.attemptedPageCount} attempted pages (${formatPercent(failedPageRatio)}), above the allowed ${formatPercent(maxFailedPageRatio)}. Keeping the existing cache. Use --force to replace it anyway.`);
    }
  }

  // First-cache coverage policy: even without a previous index, an unexpected
  // coverage gap must not silently produce a cache that appears complete.
  firstCacheCoveragePolicy(nextIndex);

  if (!previousIndex || previousIndex.pageCount <= 0) return;

  const previousDiscoveredCount = previousIndex.coverageDiagnostics?.discoveredPublicUrlCount ?? previousIndex.pageCount;
  const nextDiscoveredCount = nextIndex.coverageDiagnostics?.discoveredPublicUrlCount ?? nextIndex.pageCount;
  const intentionalPartial = nextIndex.coverageDiagnostics?.coverageWarnings.some((warning) => warning.startsWith('coverage-partial:max-pages-limited:')) ?? false;
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

function normalizeIndex(index: Partial<MaterialIndex>): MaterialIndex {
  const pages = index.pages ?? [];
  return {
    source: index.source ?? 'https://m3.material.io',
    capturedAt: index.capturedAt ?? '',
    pageCount: index.pageCount ?? pages.length,
    attemptedPageCount: index.attemptedPageCount ?? index.pageCount ?? pages.length,
    failedPageCount: index.failedPageCount ?? 0,
    failedUrls: index.failedUrls ?? [],
    ...(index.extractionDiagnostics ? { extractionDiagnostics: index.extractionDiagnostics } : {}),
    ...(index.coverageDiagnostics ? { coverageDiagnostics: index.coverageDiagnostics } : {}),
    ...(index.qualityReport ? { qualityReport: index.qualityReport } : {}),
    pages
  };
}

function isMissingPathError(error: unknown): boolean {
  return typeof error === 'object' && error !== null && 'code' in error && error.code === 'ENOENT';
}

function formatPercent(value: number): string {
  return `${Math.round(value * 100)}%`;
}
