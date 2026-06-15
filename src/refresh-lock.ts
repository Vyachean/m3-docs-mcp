import { mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import type { OperationalLogger } from './types.js';

const STALE_LOCK_TTL_MS = 2 * 60 * 60 * 1000; // 2 hours

export type LockInfo = {
  runId: string;
  pid: number;
  startedAt: string;
  command: string;
  cacheDir: string;
};

export type LockHandle = {
  release(): Promise<void>;
};

export type AcquireResult =
  | { acquired: true; handle: LockHandle }
  | { acquired: false; existingLock: LockInfo };

function getLockPath(cacheDir: string): string {
  return `${cacheDir}.lock`;
}

async function readLock(lockPath: string): Promise<LockInfo | null> {
  try {
    return JSON.parse(await readFile(lockPath, 'utf8')) as LockInfo;
  } catch {
    return null;
  }
}

export async function acquireRefreshLock(
  cacheDir: string,
  info: LockInfo,
  opts?: { staleTtlMs?: number; logger?: OperationalLogger }
): Promise<AcquireResult> {
  const lockPath = getLockPath(cacheDir);
  const staleTtlMs = opts?.staleTtlMs ?? STALE_LOCK_TTL_MS;
  const logger = opts?.logger;

  const existing = await readLock(lockPath);
  if (existing) {
    const lockAge = Date.now() - Date.parse(existing.startedAt);
    if (lockAge < staleTtlMs) {
      logger?.warn('lock-conflict', `Refresh lock held by PID ${existing.pid} (runId=${existing.runId}), age=${Math.round(lockAge / 1000)}s`, {
        counters: { lockAgeMs: Math.round(lockAge) }
      });
      return { acquired: false, existingLock: existing };
    }
    logger?.warn('lock-stale', `Overwriting stale lock from PID ${existing.pid} (runId=${existing.runId}), age=${Math.round(lockAge / 1000)}s`, {
      counters: { lockAgeMs: Math.round(lockAge) }
    });
  }

  const tmpPath = `${lockPath}.tmp`;
  try {
    await mkdir(path.dirname(lockPath), { recursive: true });
    await writeFile(tmpPath, JSON.stringify(info), 'utf8');
    await rename(tmpPath, lockPath);
  } catch (error) {
    await rm(tmpPath, { force: true }).catch(() => undefined);
    throw error;
  }

  logger?.info('lock-acquired', `Refresh lock acquired (PID=${info.pid}, runId=${info.runId})`);

  return {
    acquired: true,
    handle: {
      release: async () => {
        await rm(lockPath, { force: true }).catch(() => undefined);
        logger?.info('lock-released', `Refresh lock released (PID=${info.pid}, runId=${info.runId})`);
      }
    }
  };
}
