import { mkdir, mkdtemp, readFile, rename, rm, stat, writeFile } from 'node:fs/promises';
import { homedir, tmpdir } from 'node:os';
import path from 'node:path';
import type { CacheStatus, MaterialIndex, MaterialPage } from './types.js';

const DEFAULT_MIN_RETAINED_PAGE_RATIO = 0.8;
const DEFAULT_MAX_FAILED_PAGE_RATIO = 0.2;
const MIN_ATTEMPTS_FOR_FAILURE_RATIO_CHECK = 10;

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

export async function cacheStatus(cacheDir = getDefaultCacheDir(), maxAgeHours = 24): Promise<CacheStatus> {
  const index = await readIndex(cacheDir);
  const ageMs = await cacheAgeMs(cacheDir);
  return {
    cacheDir,
    hasCache: Boolean(index),
    capturedAt: index?.capturedAt ?? null,
    pageCount: index?.pageCount ?? 0,
    attemptedPageCount: index?.attemptedPageCount ?? 0,
    failedPageCount: index?.failedPageCount ?? 0,
    failedUrls: index?.failedUrls ?? [],
    ageMs,
    isFresh: isCacheFresh(ageMs, maxAgeHours)
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

  if (!previousIndex || previousIndex.pageCount <= 0) return;

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
