import { mkdir, mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { acquireRefreshLock } from '../src/refresh-lock.js';
import type { LockInfo } from '../src/refresh-lock.js';
import type { OperationalLogger } from '../src/types.js';

let cacheDir: string;

function makeLockInfo(overrides: Partial<LockInfo> = {}): LockInfo {
  return {
    runId: 'test-run-1',
    pid: process.pid,
    startedAt: new Date().toISOString(),
    command: 'update',
    cacheDir,
    ...overrides
  };
}

function makeCaptureLogger() {
  const events: Array<{ level: string; event: string }> = [];
  const logger: OperationalLogger = {
    info: (event) => { events.push({ level: 'info', event }); },
    warn: (event) => { events.push({ level: 'warn', event }); },
    error: (event) => { events.push({ level: 'error', event }); },
    debug: (event) => { events.push({ level: 'debug', event }); },
    logDir: '/dev/null/logs',
    currentLogFile: '/dev/null/logs/mcp.log.jsonl',
    close: async () => undefined
  };
  return { logger, events };
}

beforeEach(async () => {
  cacheDir = await mkdtemp(path.join(tmpdir(), 'm3-docs-lock-test-'));
});

afterEach(async () => {
  await rm(cacheDir, { recursive: true, force: true });
  await rm(`${cacheDir}.lock`, { force: true });
  await rm(`${cacheDir}.lock.tmp`, { force: true });
});

describe('acquireRefreshLock', () => {
  it('acquires lock when no lock file exists', async () => {
    const result = await acquireRefreshLock(cacheDir, makeLockInfo());
    expect(result.acquired).toBe(true);
    if (result.acquired) await result.handle.release();
  });

  it('writes lock file with correct content', async () => {
    const info = makeLockInfo({ runId: 'my-run', command: 'update' });
    const result = await acquireRefreshLock(cacheDir, info);
    expect(result.acquired).toBe(true);

    const lockContent = JSON.parse(await readFile(`${cacheDir}.lock`, 'utf8')) as LockInfo;
    expect(lockContent).toMatchObject({
      runId: 'my-run',
      pid: process.pid,
      command: 'update',
      cacheDir
    });

    if (result.acquired) await result.handle.release();
  });

  it('deletes lock file on release', async () => {
    const result = await acquireRefreshLock(cacheDir, makeLockInfo());
    expect(result.acquired).toBe(true);
    if (!result.acquired) return;

    await result.handle.release();
    await expect(readFile(`${cacheDir}.lock`, 'utf8')).rejects.toThrow();
  });

  it('blocks acquisition when a fresh lock exists from another process', async () => {
    const firstInfo = makeLockInfo({ runId: 'first-run', pid: 99999 });
    const firstResult = await acquireRefreshLock(cacheDir, firstInfo, { staleTtlMs: 60_000 });
    expect(firstResult.acquired).toBe(true);
    // Don't release the first lock — simulate an active other process

    const secondResult = await acquireRefreshLock(
      cacheDir,
      makeLockInfo({ runId: 'second-run' }),
      { staleTtlMs: 60_000 }
    );
    expect(secondResult.acquired).toBe(false);
    if (!secondResult.acquired) {
      expect(secondResult.existingLock.runId).toBe('first-run');
    }

    // Cleanup
    if (firstResult.acquired) await firstResult.handle.release();
  });

  it('overwrites stale lock and acquires successfully', async () => {
    // Write a stale lock manually (started far in the past)
    const staleLockInfo: LockInfo = {
      runId: 'stale-run',
      pid: 1,
      startedAt: new Date(Date.now() - 3 * 60 * 60 * 1000).toISOString(), // 3 hours ago
      command: 'update',
      cacheDir
    };
    const lockPath = `${cacheDir}.lock`;
    await mkdir(path.dirname(lockPath), { recursive: true });
    // Create the parent directory
    const parentDir = path.dirname(cacheDir);
    await mkdir(parentDir, { recursive: true });
    await rm(lockPath, { force: true });

    // Write stale lock directly
    const { writeFile } = await import('node:fs/promises');
    await writeFile(lockPath, JSON.stringify(staleLockInfo), 'utf8');

    const result = await acquireRefreshLock(cacheDir, makeLockInfo({ runId: 'new-run' }), {
      staleTtlMs: 2 * 60 * 60 * 1000 // 2 hour TTL
    });

    expect(result.acquired).toBe(true);
    if (result.acquired) {
      const lockContent = JSON.parse(await readFile(lockPath, 'utf8')) as LockInfo;
      expect(lockContent.runId).toBe('new-run');
      await result.handle.release();
    }
  });

  it('logs lock-acquired and lock-released events', async () => {
    const { logger, events } = makeCaptureLogger();
    const result = await acquireRefreshLock(cacheDir, makeLockInfo(), { logger });

    expect(result.acquired).toBe(true);
    expect(events.some((e) => e.event === 'lock-acquired')).toBe(true);

    if (result.acquired) await result.handle.release();
    expect(events.some((e) => e.event === 'lock-released')).toBe(true);
  });

  it('logs lock-conflict when acquisition is blocked', async () => {
    const { logger, events } = makeCaptureLogger();

    // Acquire first lock without logger
    const first = await acquireRefreshLock(cacheDir, makeLockInfo({ runId: 'blocker' }), {
      staleTtlMs: 60_000
    });
    expect(first.acquired).toBe(true);

    // Try to acquire second lock with logger
    const second = await acquireRefreshLock(
      cacheDir,
      makeLockInfo({ runId: 'blocked' }),
      { staleTtlMs: 60_000, logger }
    );
    expect(second.acquired).toBe(false);
    expect(events.some((e) => e.event === 'lock-conflict')).toBe(true);
    expect(events.find((e) => e.event === 'lock-conflict')?.level).toBe('warn');

    if (first.acquired) await first.handle.release();
  });

  it('logs lock-stale event when overwriting stale lock', async () => {
    const { logger, events } = makeCaptureLogger();

    const lockPath = `${cacheDir}.lock`;
    const { writeFile } = await import('node:fs/promises');
    await writeFile(lockPath, JSON.stringify({
      runId: 'old-run',
      pid: 1,
      startedAt: new Date(Date.now() - 3 * 60 * 60 * 1000).toISOString(),
      command: 'update',
      cacheDir
    }), 'utf8');

    const result = await acquireRefreshLock(cacheDir, makeLockInfo(), {
      staleTtlMs: 2 * 60 * 60 * 1000,
      logger
    });

    expect(result.acquired).toBe(true);
    expect(events.some((e) => e.event === 'lock-stale')).toBe(true);
    expect(events.find((e) => e.event === 'lock-stale')?.level).toBe('warn');

    if (result.acquired) await result.handle.release();
  });

  it('release is idempotent (no error on double-release)', async () => {
    const result = await acquireRefreshLock(cacheDir, makeLockInfo());
    expect(result.acquired).toBe(true);
    if (!result.acquired) return;

    await result.handle.release();
    await expect(result.handle.release()).resolves.toBeUndefined();
  });
});
