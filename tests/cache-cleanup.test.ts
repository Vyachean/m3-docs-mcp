import { mkdir, mkdtemp, rm, stat, utimes, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { cleanupStaleCacheDirs } from '../src/cache-cleanup.js';
import type { OperationalLogger } from '../src/types.js';

let parentDir: string;
let cacheDir: string;

const STALE_TTL_MS = 100; // Very short TTL for testing
const FRESH_AGE_MS = 0; // Fresh: just created

function makeNullLogger(): OperationalLogger {
  const events: Array<{ level: string; event: string; message: string }> = [];
  return {
    info: (event, message) => { events.push({ level: 'info', event, message }); },
    warn: (event, message) => { events.push({ level: 'warn', event, message }); },
    error: (event, message) => { events.push({ level: 'error', event, message }); },
    debug: (event, message) => { events.push({ level: 'debug', event, message }); },
    logDir: '/dev/null/logs',
    currentLogFile: '/dev/null/logs/mcp.log.jsonl',
    close: async () => undefined,
    getEvents: () => events
  } as OperationalLogger & { getEvents(): typeof events };
}

function makeCaptureLogger() {
  const events: Array<{ level: string; event: string; message: string }> = [];
  const logger: OperationalLogger = {
    info: (event, message) => { events.push({ level: 'info', event, message }); },
    warn: (event, message) => { events.push({ level: 'warn', event, message }); },
    error: (event, message) => { events.push({ level: 'error', event, message }); },
    debug: (event, message) => { events.push({ level: 'debug', event, message }); },
    logDir: '/dev/null/logs',
    currentLogFile: '/dev/null/logs/mcp.log.jsonl',
    close: async () => undefined
  };
  return { logger, events };
}

async function setMtime(dirPath: string, ageMs: number): Promise<void> {
  const oldDate = new Date(Date.now() - ageMs);
  await utimes(dirPath, oldDate, oldDate);
}

beforeEach(async () => {
  parentDir = await mkdtemp(path.join(tmpdir(), 'm3-docs-cleanup-test-'));
  cacheDir = path.join(parentDir, 'm3-docs-mcp');
  await mkdir(cacheDir);
});

afterEach(async () => {
  await rm(parentDir, { recursive: true, force: true });
});

describe('cleanupStaleCacheDirs', () => {
  it('removes stale staging directories older than the TTL', async () => {
    const staleDir = path.join(parentDir, '.m3-docs-mcp-staging-stale');
    await mkdir(staleDir);
    await setMtime(staleDir, STALE_TTL_MS + 100);

    const result = await cleanupStaleCacheDirs(cacheDir, { staleTtlMs: STALE_TTL_MS });

    expect(result.staleStagingDirsFound).toBe(1);
    expect(result.staleStagingDirsRemoved).toBe(1);
    await expect(stat(staleDir)).rejects.toThrow();
  });

  it('preserves fresh staging directories newer than the TTL', async () => {
    const freshDir = path.join(parentDir, '.m3-docs-mcp-staging-fresh');
    await mkdir(freshDir);
    // mtime is very recent (just created), well within TTL

    const result = await cleanupStaleCacheDirs(cacheDir, { staleTtlMs: STALE_TTL_MS * 1000 });

    expect(result.staleStagingDirsFound).toBe(0);
    expect(result.staleStagingDirsRemoved).toBe(0);
    const s = await stat(freshDir);
    expect(s.isDirectory()).toBe(true);
  });

  it('preserves the current run staging directory even if it appears stale', async () => {
    const currentStaging = path.join(parentDir, '.m3-docs-mcp-staging-current');
    await mkdir(currentStaging);
    await setMtime(currentStaging, STALE_TTL_MS + 100);

    const result = await cleanupStaleCacheDirs(cacheDir, {
      staleTtlMs: STALE_TTL_MS,
      currentStagingDir: currentStaging
    });

    expect(result.staleStagingDirsRemoved).toBe(0);
    const s = await stat(currentStaging);
    expect(s.isDirectory()).toBe(true);
  });

  it('never removes the active cache directory', async () => {
    // The active cache dir doesn't start with .m3-docs-mcp-staging- so it shouldn't be touched,
    // but let's explicitly verify the safety check
    const result = await cleanupStaleCacheDirs(cacheDir, { staleTtlMs: STALE_TTL_MS });

    expect(result.staleStagingDirsRemoved).toBe(0);
    const s = await stat(cacheDir);
    expect(s.isDirectory()).toBe(true);
  });

  it('removes stale .previous backup when older than TTL', async () => {
    const previousDir = `${cacheDir}.previous`;
    await mkdir(previousDir);
    await setMtime(previousDir, STALE_TTL_MS + 100);

    const result = await cleanupStaleCacheDirs(cacheDir, { staleTtlMs: STALE_TTL_MS });

    expect(result.stalePreviousBackupsFound).toBe(1);
    expect(result.stalePreviousBackupsRemoved).toBe(1);
    await expect(stat(previousDir)).rejects.toThrow();
  });

  it('preserves fresh .previous backup newer than TTL', async () => {
    const previousDir = `${cacheDir}.previous`;
    await mkdir(previousDir);
    // Just created — within TTL

    const result = await cleanupStaleCacheDirs(cacheDir, { staleTtlMs: STALE_TTL_MS * 1000 });

    expect(result.stalePreviousBackupsFound).toBe(1);
    expect(result.stalePreviousBackupsRemoved).toBe(0);
    const s = await stat(previousDir);
    expect(s.isDirectory()).toBe(true);
  });

  it('returns zero counts when no stale directories exist', async () => {
    const result = await cleanupStaleCacheDirs(cacheDir, { staleTtlMs: STALE_TTL_MS });

    expect(result).toEqual({
      staleStagingDirsFound: 0,
      staleStagingDirsRemoved: 0,
      stalePreviousBackupsFound: 0,
      stalePreviousBackupsRemoved: 0,
      cleanupWarnings: []
    });
  });

  it('handles multiple stale staging directories', async () => {
    for (let i = 0; i < 3; i++) {
      const dir = path.join(parentDir, `.m3-docs-mcp-staging-${i}`);
      await mkdir(dir);
      await setMtime(dir, STALE_TTL_MS + 100);
    }

    const result = await cleanupStaleCacheDirs(cacheDir, { staleTtlMs: STALE_TTL_MS });

    expect(result.staleStagingDirsFound).toBe(3);
    expect(result.staleStagingDirsRemoved).toBe(3);
  });

  it('logs cleanup actions via the logger', async () => {
    const staleDir = path.join(parentDir, '.m3-docs-mcp-staging-logged');
    await mkdir(staleDir);
    await setMtime(staleDir, STALE_TTL_MS + 100);

    const { logger, events } = makeCaptureLogger();
    await cleanupStaleCacheDirs(cacheDir, { staleTtlMs: STALE_TTL_MS, logger });

    const removalEvent = events.find((e) => e.event === 'cleanup-staging-removed');
    expect(removalEvent).toBeDefined();
    expect(removalEvent?.level).toBe('info');
  });

  it('does not remove files that are not directories', async () => {
    const staleFile = path.join(parentDir, '.m3-docs-mcp-staging-file');
    await writeFile(staleFile, 'not a dir', 'utf8');
    await setMtime(staleFile, STALE_TTL_MS + 100);

    const result = await cleanupStaleCacheDirs(cacheDir, { staleTtlMs: STALE_TTL_MS });

    expect(result.staleStagingDirsRemoved).toBe(0);
  });

  it('collects warnings when the cache parent directory is not readable', async () => {
    // Point cleanup at a cacheDir whose parent doesn't exist at all
    const nonExistentParent = path.join(parentDir, 'does-not-exist', 'cache');
    const result = await cleanupStaleCacheDirs(nonExistentParent, { staleTtlMs: STALE_TTL_MS });
    // readdir should fail since the parent doesn't exist
    expect(result.cleanupWarnings.length).toBeGreaterThan(0);
    expect(result.staleStagingDirsRemoved).toBe(0);
  });
});
