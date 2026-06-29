import { mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { getDefaultCacheDir } from '../cache.js';
import { FetchDiagnosticListSchema, type FetchDiagnostic } from './fetch-diagnostics.js';

/**
 * Persists the accumulated `FetchDiagnostic[]` for a single crawl run to
 * `diagnostics/fetch-report.json` under the cache directory, mirroring the read/write
 * conventions of manifest.ts and artifact-index.ts (write validated shape + trailing newline;
 * read back through the same zod schema, returning an empty list on any failure).
 *
 * This is distinct from `raw/artifact-index.json`: the artifact index only has entries for
 * fetches that produced a persisted artifact, while the fetch report has one entry per fetch
 * *attempt* — including HTTP errors, network errors, JSON parse failures, and rejected
 * slug-guessing candidates that never produced an artifact.
 */

export function fetchReportPath(cacheDir = getDefaultCacheDir()): string {
  return path.join(cacheDir, 'diagnostics', 'fetch-report.json');
}

/** Writes the fetch diagnostics report to disk, replacing any existing report. */
export async function writeFetchReport(diagnostics: FetchDiagnostic[], cacheDir = getDefaultCacheDir()): Promise<void> {
  const filePath = fetchReportPath(cacheDir);
  await mkdir(path.dirname(filePath), { recursive: true });
  await writeFile(filePath, `${JSON.stringify(diagnostics, null, 2)}\n`, 'utf8');
}

/** Reads the persisted fetch diagnostics report, or an empty list if none exists yet / it is invalid. */
export async function readFetchReport(cacheDir = getDefaultCacheDir()): Promise<FetchDiagnostic[]> {
  try {
    const raw: unknown = JSON.parse(await readFile(fetchReportPath(cacheDir), 'utf8'));
    const parsed = FetchDiagnosticListSchema.safeParse(raw);
    return parsed.success ? parsed.data : [];
  } catch {
    return [];
  }
}
