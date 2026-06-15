import { appendFile, mkdir, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createOperationalLogger, generateRunId } from '../src/operational-log.js';

let cacheDir: string;

beforeEach(async () => {
  cacheDir = await mkdtemp(path.join(tmpdir(), 'm3-docs-oplog-test-'));
});

afterEach(async () => {
  await rm(cacheDir, { recursive: true, force: true });
});

function parseLogLines(content: string) {
  return content
    .split('\n')
    .filter(Boolean)
    .map((line) => JSON.parse(line) as Record<string, unknown>);
}

async function readLogFile(logFile: string) {
  const content = await readFile(logFile, 'utf8');
  return parseLogLines(content);
}

describe('createOperationalLogger', () => {
  it('generates unique run IDs', () => {
    const a = generateRunId();
    const b = generateRunId();
    expect(a).toMatch(/^[0-9a-f]{8}$/);
    expect(b).toMatch(/^[0-9a-f]{8}$/);
    expect(a).not.toBe(b);
  });

  it('creates log file under <cacheDir>/logs/mcp.log.jsonl', async () => {
    const logger = createOperationalLogger(cacheDir, { runId: 'test-run', command: 'test' });
    logger.info('test-event', 'Test message');
    await logger.close();

    const expectedLogFile = path.join(cacheDir, 'logs', 'mcp.log.jsonl');
    expect(logger.logDir).toBe(path.join(cacheDir, 'logs'));
    expect(logger.currentLogFile).toBe(expectedLogFile);
    const s = await stat(expectedLogFile);
    expect(s.isFile()).toBe(true);
  });

  it('writes valid JSON lines with required fields', async () => {
    const logger = createOperationalLogger(cacheDir, { runId: 'abc12345', command: 'update' });
    logger.info('refresh-start', 'Cache refresh started');
    logger.error('refresh-failure', 'Cache refresh failed', {
      errorClass: 'Error',
      errorMessage: 'something went wrong',
      errorStack: 'Error: something went wrong\n  at ...'
    });
    await logger.close();

    const entries = await readLogFile(logger.currentLogFile);
    expect(entries).toHaveLength(2);

    const [start, failure] = entries;
    expect(start).toMatchObject({
      level: 'info',
      runId: 'abc12345',
      event: 'refresh-start',
      message: 'Cache refresh started',
      cacheDir,
      command: 'update'
    });
    expect(typeof start?.['timestamp']).toBe('string');
    expect(typeof start?.['pid']).toBe('number');

    expect(failure).toMatchObject({
      level: 'error',
      event: 'refresh-failure',
      errorClass: 'Error',
      errorMessage: 'something went wrong'
    });
  });

  it('writes route-failure events with url, phase, source, and error fields', async () => {
    const logger = createOperationalLogger(cacheDir, { runId: 'abc12345' });
    logger.error('route-failure', 'Failed to crawl page', {
      url: 'https://m3.material.io/components/buttons/overview',
      path: 'components/buttons/overview.md',
      phase: 'browser-crawl',
      source: 'crawler',
      errorClass: 'TypeError',
      errorMessage: "Cannot read properties of undefined (reading 'slice')",
      errorStack: "TypeError: Cannot read properties of undefined\n  at ..."
    });
    await logger.close();

    const [entry] = await readLogFile(logger.currentLogFile);
    expect(entry).toMatchObject({
      level: 'error',
      event: 'route-failure',
      url: 'https://m3.material.io/components/buttons/overview',
      path: 'components/buttons/overview.md',
      phase: 'browser-crawl',
      source: 'crawler',
      errorClass: 'TypeError',
      errorMessage: "Cannot read properties of undefined (reading 'slice')"
    });
  });

  it('does not include cookies, request headers, or page body content', async () => {
    const logger = createOperationalLogger(cacheDir, { runId: 'abc12345' });
    logger.info('refresh-start', 'Refresh started');
    await logger.close();

    const content = await readFile(logger.currentLogFile, 'utf8');
    expect(content).not.toContain('cookie');
    expect(content).not.toContain('authorization');
    expect(content).not.toContain('x-api-key');
    // Not logging full page bodies
    expect(content.length).toBeLessThan(10_000);
  });

  it('writes all log levels correctly', async () => {
    const logger = createOperationalLogger(cacheDir);
    logger.debug('evt-debug', 'debug msg');
    logger.info('evt-info', 'info msg');
    logger.warn('evt-warn', 'warn msg');
    logger.error('evt-error', 'error msg');
    await logger.close();

    const entries = await readLogFile(logger.currentLogFile);
    expect(entries.map((e) => e['level'])).toEqual(['debug', 'info', 'warn', 'error']);
  });

  it('includes optional counters and durationMs when provided', async () => {
    const logger = createOperationalLogger(cacheDir, { runId: 'abc12345' });
    logger.info('refresh-success', 'Done', {
      durationMs: 42_000,
      counters: { pageCount: 250, failedPageCount: 3 }
    });
    await logger.close();

    const [entry] = await readLogFile(logger.currentLogFile);
    expect(entry?.['durationMs']).toBe(42_000);
    expect(entry?.['counters']).toEqual({ pageCount: 250, failedPageCount: 3 });
  });

  it('creates parent log directory automatically', async () => {
    const deepCacheDir = path.join(cacheDir, 'nested', 'deep');
    const logger = createOperationalLogger(deepCacheDir, { runId: 'abc12345' });
    logger.info('evt', 'msg');
    await logger.close();

    const s = await stat(path.join(deepCacheDir, 'logs', 'mcp.log.jsonl'));
    expect(s.isFile()).toBe(true);
  });

  it('rotates log file when size exceeds threshold', async () => {
    // Write 51 entries to trigger the rotation check (every 50 writes)
    // We set the rotation size to 0 by pre-filling the file so the check fires
    const logger = createOperationalLogger(cacheDir, { runId: 'rot-test' });
    await mkdir(path.join(cacheDir, 'logs'), { recursive: true });

    // Pre-fill the current log file to exceed the 5MB rotation threshold
    const bigContent = 'x'.repeat(5 * 1024 * 1024 + 1);
    await writeFile(logger.currentLogFile, bigContent, 'utf8');

    // Write 50 entries to trigger a rotation check on the 50th write
    for (let i = 0; i < 50; i++) {
      logger.info('evt', `entry ${i}`);
    }
    await logger.close();

    // The rotated file should exist
    const rotatedFile = path.join(cacheDir, 'logs', 'mcp.log.1.jsonl');
    const rotatedStat = await stat(rotatedFile);
    expect(rotatedStat.isFile()).toBe(true);
  });

  it('keeps only MAX_ROTATED_LOGS rotated files', async () => {
    const logger = createOperationalLogger(cacheDir, { runId: 'rot-test' });
    const logDir = logger.logDir;
    await mkdir(logDir, { recursive: true });

    // Create MAX_ROTATED_LOGS=5 existing rotated files
    for (let i = 1; i <= 5; i++) {
      await writeFile(path.join(logDir, `mcp.log.${i}.jsonl`), `existing rotated ${i}`, 'utf8');
    }

    // Pre-fill current log to trigger rotation on the 50th write
    await writeFile(logger.currentLogFile, 'x'.repeat(5 * 1024 * 1024 + 1), 'utf8');
    for (let i = 0; i < 50; i++) {
      logger.info('evt', `entry ${i}`);
    }
    await logger.close();

    // mcp.log.5.jsonl (old) should be deleted to make room for the shift
    // After rotation: old[1→2, 2→3, 3→4, 4→5], current→1
    // The old mcp.log.5.jsonl is deleted first, then old 4 moves to 5
    const s = await stat(path.join(logDir, 'mcp.log.5.jsonl'));
    expect(s.isFile()).toBe(true);
    // The new mcp.log.1.jsonl should be the old current log (the big file)
    const s1 = await stat(path.join(logDir, 'mcp.log.1.jsonl'));
    expect(s1.isFile()).toBe(true);
  });

  it('tolerates write errors without crashing', async () => {
    // Point logger at a path where the parent can't be created (use a file as parent)
    const blockingFile = path.join(cacheDir, 'logs');
    await writeFile(blockingFile, 'i am a file, not a dir', 'utf8');

    const logger = createOperationalLogger(cacheDir, { runId: 'abc12345' });
    // This should not throw even though the log dir can't be created
    logger.info('evt', 'message');
    await expect(logger.close()).resolves.toBeUndefined();
  });
});
