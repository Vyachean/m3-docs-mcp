import { readdir, rm, stat } from 'node:fs/promises';
import path from 'node:path';
import type { CleanupDiagnostics, OperationalLogger } from './types.js';

const STAGING_DIR_PREFIX = '.m3-docs-mcp-staging-';
const PREVIOUS_BACKUP_SUFFIX = '.previous';
const DEFAULT_STALE_TTL_MS = 6 * 60 * 60 * 1000; // 6 hours

export type { CleanupDiagnostics };

type CleanupOptions = {
  currentStagingDir?: string;
  staleTtlMs?: number;
  logger?: OperationalLogger;
};

export async function cleanupStaleCacheDirs(cacheDir: string, opts: CleanupOptions = {}): Promise<CleanupDiagnostics> {
  const staleTtlMs = opts.staleTtlMs ?? DEFAULT_STALE_TTL_MS;
  const parentDir = path.dirname(cacheDir);
  const result: CleanupDiagnostics = {
    staleStagingDirsFound: 0,
    staleStagingDirsRemoved: 0,
    stalePreviousBackupsFound: 0,
    stalePreviousBackupsRemoved: 0,
    cleanupWarnings: []
  };

  opts.logger?.debug('cleanup-start', 'Starting stale cache directory cleanup', { path: parentDir });

  try {
    const entries = await readdir(parentDir);
    for (const entry of entries) {
      if (!entry.startsWith(STAGING_DIR_PREFIX)) continue;
      const fullPath = path.join(parentDir, entry);

      // Never remove the current run's staging directory
      if (opts.currentStagingDir && path.resolve(fullPath) === path.resolve(opts.currentStagingDir)) continue;

      // Never remove the active cache directory
      if (path.resolve(fullPath) === path.resolve(cacheDir)) continue;

      try {
        const s = await stat(fullPath);
        if (!s.isDirectory()) continue;
        const ageMs = Date.now() - s.mtimeMs;
        if (ageMs < staleTtlMs) continue;

        result.staleStagingDirsFound++;
        await rm(fullPath, { recursive: true, force: true });
        result.staleStagingDirsRemoved++;
        opts.logger?.info('cleanup-staging-removed', `Removed stale staging directory: ${entry}`, {
          path: fullPath,
          durationMs: Math.round(ageMs)
        });
      } catch (error) {
        const msg = `Failed to remove stale staging directory ${entry}: ${error instanceof Error ? error.message : String(error)}`;
        result.cleanupWarnings.push(msg);
        opts.logger?.warn('cleanup-staging-failed', msg, {
          path: fullPath,
          errorClass: error instanceof Error ? error.constructor.name : 'Error',
          errorMessage: error instanceof Error ? error.message : String(error)
        });
      }
    }
  } catch (error) {
    const msg = `Failed to list cache parent directory for cleanup: ${error instanceof Error ? error.message : String(error)}`;
    result.cleanupWarnings.push(msg);
    opts.logger?.warn('cleanup-readdir-failed', msg, {
      path: parentDir,
      errorMessage: error instanceof Error ? error.message : String(error)
    });
  }

  const previousDir = `${cacheDir}${PREVIOUS_BACKUP_SUFFIX}`;
  try {
    const s = await stat(previousDir);
    if (s.isDirectory()) {
      result.stalePreviousBackupsFound++;
      const ageMs = Date.now() - s.mtimeMs;
      if (ageMs >= staleTtlMs) {
        await rm(previousDir, { recursive: true, force: true });
        result.stalePreviousBackupsRemoved++;
        opts.logger?.info('cleanup-previous-removed', 'Removed stale .previous backup', {
          path: previousDir,
          durationMs: Math.round(ageMs)
        });
      } else {
        opts.logger?.debug('cleanup-previous-retained', `Retaining recent .previous backup (ageMs=${Math.round(ageMs)})`, {
          path: previousDir
        });
      }
    }
  } catch {
    // .previous doesn't exist — nothing to do
  }

  opts.logger?.debug('cleanup-complete', 'Cache cleanup complete', {
    counters: {
      staleStagingDirsFound: result.staleStagingDirsFound,
      staleStagingDirsRemoved: result.staleStagingDirsRemoved,
      stalePreviousBackupsFound: result.stalePreviousBackupsFound,
      stalePreviousBackupsRemoved: result.stalePreviousBackupsRemoved
    }
  });

  return result;
}
