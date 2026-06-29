import { readdir, stat } from 'node:fs/promises';
import path from 'node:path';
import { getDefaultCacheDir, indexPath, pagesDir } from '../cache.js';
import { manifestPath } from '../manifest.js';
import { artifactIndexPath } from '../raw-artifacts/artifact-index.js';
import {
  pageGraphPath,
  provenanceGraphPath,
  resourceGraphPath,
  routeGraphPath,
  sectionGraphPath,
  tokenTableGraphPath,
} from '../graph/graph-store.js';
import { failedCheck, passedCheck, type CheckResult } from './types.js';

/**
 * `validate-cache` file-existence gate: every file/directory the cache v2 schema is documented to
 * produce (AGENTS.md "Cache architecture (schema v2)") must exist on disk before any
 * schema-aware check below runs. Kept as its own stage so a missing file always reports a clear
 * relative path instead of surfacing only as a downstream schema-validation failure.
 */

async function fileExists(filePath: string): Promise<boolean> {
  try {
    await stat(filePath);
    return true;
  } catch {
    return false;
  }
}

async function pagesDirHasFiles(dir: string): Promise<boolean> {
  try {
    const entries = await readdir(dir, { withFileTypes: true, recursive: true });
    return entries.some((entry) => entry.isFile());
  } catch {
    return false;
  }
}

export type ValidateCacheFilesInput = {
  cacheDir?: string;
};

export async function validateCacheFiles(input: ValidateCacheFilesInput = {}): Promise<CheckResult> {
  const cacheDir = input.cacheDir ?? getDefaultCacheDir();
  const stage = 'cache-files';

  const requiredFiles: Array<{ label: string; absolutePath: string }> = [
    { label: 'index.json', absolutePath: indexPath(cacheDir) },
    { label: 'manifest.json', absolutePath: manifestPath(cacheDir) },
    { label: 'graph/routes.json', absolutePath: routeGraphPath(cacheDir) },
    { label: 'graph/pages.json', absolutePath: pageGraphPath(cacheDir) },
    { label: 'graph/resources.json', absolutePath: resourceGraphPath(cacheDir) },
    { label: 'graph/token-tables.json', absolutePath: tokenTableGraphPath(cacheDir) },
    { label: 'graph/sections.json', absolutePath: sectionGraphPath(cacheDir) },
    { label: 'graph/provenance.json', absolutePath: provenanceGraphPath(cacheDir) },
    { label: 'raw/artifact-index.json', absolutePath: artifactIndexPath(cacheDir) },
    { label: 'diagnostics/latest-update.json', absolutePath: path.join(cacheDir, 'diagnostics', 'latest-update.json') },
  ];

  const reasons: string[] = [];
  for (const file of requiredFiles) {
    if (!(await fileExists(file.absolutePath))) {
      reasons.push(`Required cache file is missing: ${file.label}`);
    }
  }

  if (!(await pagesDirHasFiles(pagesDir(cacheDir)))) {
    reasons.push('Required cache directory pages/** is missing or contains no files.');
  }

  if (reasons.length > 0) {
    return failedCheck(stage, reasons, { cacheDir });
  }
  return passedCheck(stage, { cacheDir });
}
