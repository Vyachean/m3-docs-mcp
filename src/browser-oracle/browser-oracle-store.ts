import { mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { getDefaultCacheDir } from '../cache.js';
import { RequiredRoutesCaptureReportSchema, type RequiredRoutesCaptureReport } from './browser-oracle-types.js';

/**
 * Persistence for the browser-oracle capture report, mirroring the read/write conventions of
 * manifest.ts / raw-artifacts/fetch-report.ts / graph/graph-store.ts: write the validated shape
 * with a trailing newline; read back through the same zod schema, returning null on any failure
 * (missing file, invalid JSON, schema mismatch) rather than throwing.
 *
 * Per the documented cache layout (raw-artifacts/artifact-store.ts's module doc), the capture
 * report itself lives under `raw/network/required-routes.capture.json` — it is the "network
 * capture" raw artifact this oracle produces, not a regular page-data/carbon-content/dsdb fetch.
 * The comparison report it feeds (compare-capture-to-snapshot.ts) is a diagnostic, not raw
 * provenance, so it is written under `diagnostics/` instead, alongside fetch-report.json and
 * renderer-report.json.
 */

export function requiredRoutesCapturePath(cacheDir = getDefaultCacheDir()): string {
  return path.join(cacheDir, 'raw', 'network', 'required-routes.capture.json');
}

export async function writeRequiredRoutesCapture(
  report: RequiredRoutesCaptureReport,
  cacheDir = getDefaultCacheDir()
): Promise<void> {
  const filePath = requiredRoutesCapturePath(cacheDir);
  await mkdir(path.dirname(filePath), { recursive: true });
  await writeFile(filePath, `${JSON.stringify(report, null, 2)}\n`, 'utf8');
}

export async function readRequiredRoutesCapture(cacheDir = getDefaultCacheDir()): Promise<RequiredRoutesCaptureReport | null> {
  try {
    const raw: unknown = JSON.parse(await readFile(requiredRoutesCapturePath(cacheDir), 'utf8'));
    const parsed = RequiredRoutesCaptureReportSchema.safeParse(raw);
    return parsed.success ? parsed.data : null;
  } catch {
    return null;
  }
}

export function browserOracleComparisonPath(cacheDir = getDefaultCacheDir()): string {
  return path.join(cacheDir, 'diagnostics', 'browser-oracle-comparison.json');
}

/** Writes the comparison report as a plain diagnostics JSON file. Not validated by a zod schema
 *  on write (it is produced entirely in-process by compare-capture-to-snapshot.ts from already
 *  validated inputs — there is no external/unknown payload at this boundary), but read back
 *  defensively (return null on any parse failure) for consistency with every other diagnostics
 *  reader in this codebase. */
export async function writeBrowserOracleComparison(
  report: unknown,
  cacheDir = getDefaultCacheDir()
): Promise<void> {
  const filePath = browserOracleComparisonPath(cacheDir);
  await mkdir(path.dirname(filePath), { recursive: true });
  await writeFile(filePath, `${JSON.stringify(report, null, 2)}\n`, 'utf8');
}

export async function readBrowserOracleComparison(cacheDir = getDefaultCacheDir()): Promise<unknown | null> {
  try {
    return JSON.parse(await readFile(browserOracleComparisonPath(cacheDir), 'utf8')) as unknown;
  } catch {
    return null;
  }
}
