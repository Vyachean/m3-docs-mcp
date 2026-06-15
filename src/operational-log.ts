import { appendFile, mkdir, rename, rm, stat } from 'node:fs/promises';
import crypto from 'node:crypto';
import path from 'node:path';
import type { LogFields, LogLevel, OperationalLogger } from './types.js';

const LOG_ROTATION_SIZE_BYTES = 5 * 1024 * 1024; // 5 MB
const MAX_ROTATED_LOGS = 5;
const ROTATION_CHECK_INTERVAL = 50; // Check every 50 writes

export function generateRunId(): string {
  return crypto.randomBytes(4).toString('hex');
}

function rotatedLogFile(logDir: string, n: number): string {
  return path.join(logDir, `mcp.log.${n}.jsonl`);
}

async function rotateIfNeeded(logDir: string, currentLogFile: string): Promise<void> {
  try {
    const { size } = await stat(currentLogFile);
    if (size < LOG_ROTATION_SIZE_BYTES) return;
  } catch {
    return;
  }
  try {
    await rm(rotatedLogFile(logDir, MAX_ROTATED_LOGS), { force: true });
    for (let i = MAX_ROTATED_LOGS - 1; i >= 1; i--) {
      await rename(rotatedLogFile(logDir, i), rotatedLogFile(logDir, i + 1)).catch(() => undefined);
    }
    await rename(currentLogFile, rotatedLogFile(logDir, 1)).catch(() => undefined);
  } catch {
    // Rotation failed (race with another process) — continue writing to current file
  }
}

export function createOperationalLogger(
  cacheDir: string,
  defaults: { runId?: string; command?: string; pid?: number } = {}
): OperationalLogger {
  const runId = defaults.runId ?? generateRunId();
  const pid = defaults.pid ?? process.pid;
  const command = defaults.command;
  const logDir = path.join(cacheDir, 'logs');
  const currentLogFile = path.join(logDir, 'mcp.log.jsonl');

  let writeChain: Promise<void> = Promise.resolve();
  let writesSinceRotationCheck = 0;

  async function doWrite(level: LogLevel, event: string, message: string, fields?: LogFields): Promise<void> {
    writesSinceRotationCheck++;
    if (writesSinceRotationCheck >= ROTATION_CHECK_INTERVAL) {
      writesSinceRotationCheck = 0;
      await rotateIfNeeded(logDir, currentLogFile);
    }
    const entry: Record<string, unknown> = {
      timestamp: new Date().toISOString(),
      level,
      runId,
      pid,
      event,
      message,
      cacheDir,
      ...(command !== undefined ? { command } : {}),
      ...fields
    };
    await mkdir(logDir, { recursive: true });
    await appendFile(currentLogFile, `${JSON.stringify(entry)}\n`, 'utf8');
  }

  function log(level: LogLevel, event: string, message: string, fields?: LogFields): void {
    writeChain = writeChain.then(() => doWrite(level, event, message, fields)).catch(() => undefined);
  }

  return {
    info: (event, message, fields) => log('info', event, message, fields),
    warn: (event, message, fields) => log('warn', event, message, fields),
    error: (event, message, fields) => log('error', event, message, fields),
    debug: (event, message, fields) => log('debug', event, message, fields),
    logDir,
    currentLogFile,
    close: () => writeChain
  };
}
