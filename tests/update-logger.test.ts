import { mkdtemp, readFile, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { UpdateLogger, type UpdateRunDiagnostics } from '../src/update-logger.js';
import { diagnosticsDir, latestDiagnosticsPath, latestLogPath, logsDir } from '../src/cache.js';

let tmpDir: string;

beforeEach(async () => {
  tmpDir = await mkdtemp(path.join(tmpdir(), 'm3-update-logger-test-'));
});

afterEach(async () => {
  await rm(tmpDir, { recursive: true, force: true });
});

function makeLogger(overrides: Partial<ConstructorParameters<typeof UpdateLogger>[0]> = {}): UpdateLogger {
  return new UpdateLogger({
    cacheDir: tmpDir,
    logDir: path.join(tmpDir, 'logs'),
    diagnosticsDir: path.join(tmpDir, 'diagnostics'),
    ...overrides
  });
}

function makeRunDiagnostics(overrides: Partial<UpdateRunDiagnostics> = {}): UpdateRunDiagnostics {
  return {
    runId: 'test-run-id',
    startedAt: new Date().toISOString(),
    finishedAt: new Date().toISOString(),
    cacheDir: tmpDir,
    stagingDir: null,
    logFile: '',
    attemptedPages: 5,
    savedPages: 4,
    failedPages: 1,
    failedRoutes: ['/some/route'],
    skippedBlogCount: 0,
    tokenTablesRequested: 2,
    tokenTablesResolved: 2,
    tokenTablesDecoded: 2,
    tokenTablesRendered: 2,
    tokenTablesRenderedAsPlaceholder: 0,
    tokenTablesUnsupportedSchema: 0,
    statusTablesRequested: 1,
    statusTablesResolved: 1,
    statusTablesDecoded: 1,
    statusTablesRendered: 1,
    statusTablesRenderedAsPlaceholder: 0,
    statusTablesUnsupportedSchema: 0,
    resourceChunksRequested: 3,
    resourceChunksResolved: 3,
    resourceChunksDecoded: 3,
    resourceChunksRendered: 3,
    resourceChunksPlaceholder: 0,
    promotionDecision: 'promoted',
    hasPreviousCache: false,
    preservedFailedStagingPath: null,
    coverageHealth: 'partial',
    ...overrides
  };
}

describe('UpdateLogger', () => {
  it('generates a unique runId', () => {
    const a = makeLogger();
    const b = makeLogger();
    expect(a.runId).toMatch(/^[0-9a-f]{16}$/);
    expect(a.runId).not.toBe(b.runId);
  });

  it('places log file in the given logDir with update- prefix', () => {
    const logger = makeLogger();
    expect(logger.logFile).toContain(path.join(tmpDir, 'logs', 'update-'));
    expect(logger.logFile).toMatch(/\.jsonl$/);
  });

  it('places diagnostics file in the given diagnosticsDir', () => {
    const logger = makeLogger();
    expect(logger.diagnosticsFile).toBe(path.join(tmpDir, 'diagnostics', 'latest-update.json'));
  });

  it('creates log and diagnostics directories on init()', async () => {
    const logger = makeLogger();
    await logger.init();
    expect((await stat(path.join(tmpDir, 'logs'))).isDirectory()).toBe(true);
    expect((await stat(path.join(tmpDir, 'diagnostics'))).isDirectory()).toBe(true);
  });

  it('writes a JSONL line per log() call', async () => {
    const logger = makeLogger();
    await logger.init();
    logger.log('info', 'test:event', { message: 'hello', route: '/components/buttons/overview' });
    logger.log('warn', 'test:warn', { message: 'uh oh' });
    await logger.flush();

    const content = await readFile(logger.logFile, 'utf8');
    const lines = content.trim().split('\n').filter(Boolean);
    expect(lines).toHaveLength(2);

    const first = JSON.parse(lines[0]!) as Record<string, unknown>;
    expect(first.event).toBe('test:event');
    expect(first.level).toBe('info');
    expect(first.route).toBe('/components/buttons/overview');
    expect(first.runId).toBe(logger.runId);
    expect(first.command).toBe('update');
    expect(first.cacheDir).toBe(tmpDir);
    expect(typeof first.timestamp).toBe('string');

    const second = JSON.parse(lines[1]!) as Record<string, unknown>;
    expect(second.event).toBe('test:warn');
    expect(second.level).toBe('warn');
  });

  it('suppresses debug events when verbose is false (default)', async () => {
    const logger = makeLogger({ verbose: false });
    await logger.init();
    logger.log('debug', 'test:debug', { message: 'should be suppressed' });
    logger.log('info', 'test:info', { message: 'should appear' });
    await logger.flush();

    const content = await readFile(logger.logFile, 'utf8');
    const lines = content.trim().split('\n').filter(Boolean);
    expect(lines).toHaveLength(1);
    expect(JSON.parse(lines[0]!).event).toBe('test:info');
  });

  it('includes debug events when verbose is true', async () => {
    const logger = makeLogger({ verbose: true });
    await logger.init();
    logger.log('debug', 'test:debug', { message: 'verbose debug line' });
    await logger.flush();

    const content = await readFile(logger.logFile, 'utf8');
    const lines = content.trim().split('\n').filter(Boolean);
    expect(lines).toHaveLength(1);
    expect(JSON.parse(lines[0]!).level).toBe('debug');
  });

  it('truncates long string values', async () => {
    const logger = makeLogger();
    await logger.init();
    const longStr = 'x'.repeat(1000);
    logger.log('info', 'test:long', { message: longStr });
    await logger.flush();

    const content = await readFile(logger.logFile, 'utf8');
    const entry = JSON.parse(content.trim()) as Record<string, unknown>;
    expect(typeof entry.message).toBe('string');
    expect((entry.message as string).length).toBeLessThan(600);
  });

  it('writeFinalDiagnostics writes the JSON summary and copies latest.jsonl', async () => {
    const logger = makeLogger();
    await logger.init();
    logger.log('info', 'test:event', { message: 'before final' });
    const diag = makeRunDiagnostics();
    await logger.writeFinalDiagnostics(diag);

    const diagContent = JSON.parse(await readFile(logger.diagnosticsFile, 'utf8')) as Record<string, unknown>;
    expect(diagContent.runId).toBe('test-run-id');
    expect(diagContent.savedPages).toBe(4);
    expect(diagContent.tokenTablesRequested).toBe(2);
    expect(diagContent.logFile).toBe(logger.logFile);

    const latestContent = await readFile(path.join(path.dirname(logger.logFile), 'latest.jsonl'), 'utf8');
    expect(latestContent).toBeTruthy();
  });

  it('writeFinalDiagnostics works even after a simulated failed run (no crawled index)', async () => {
    const logger = makeLogger();
    await logger.init();
    logger.log('error', 'update:failed', { message: 'crawl failed before any pages were saved' });
    const diag = makeRunDiagnostics({
      promotionDecision: 'error',
      savedPages: 0,
      attemptedPages: 0,
      failedPages: 0,
      failedRoutes: []
    });
    await expect(logger.writeFinalDiagnostics(diag)).resolves.not.toThrow();

    const diagContent = JSON.parse(await readFile(logger.diagnosticsFile, 'utf8')) as Record<string, unknown>;
    expect(diagContent.promotionDecision).toBe('error');
    expect(diagContent.savedPages).toBe(0);
  });

  it('log file stays in cacheDir/logs, not in any staging directory', () => {
    const logger = makeLogger();
    expect(logger.logFile.startsWith(path.join(tmpDir, 'logs'))).toBe(true);
    expect(logger.logFile).not.toContain('staging');
  });
});

describe('cache path helpers for logs and diagnostics', () => {
  it('logsDir returns <cacheDir>/logs', () => {
    expect(logsDir(tmpDir)).toBe(path.join(tmpDir, 'logs'));
  });

  it('diagnosticsDir returns <cacheDir>/diagnostics', () => {
    expect(diagnosticsDir(tmpDir)).toBe(path.join(tmpDir, 'diagnostics'));
  });

  it('latestLogPath returns <cacheDir>/logs/latest.jsonl', () => {
    expect(latestLogPath(tmpDir)).toBe(path.join(tmpDir, 'logs', 'latest.jsonl'));
  });

  it('latestDiagnosticsPath returns <cacheDir>/diagnostics/latest-update.json', () => {
    expect(latestDiagnosticsPath(tmpDir)).toBe(path.join(tmpDir, 'diagnostics', 'latest-update.json'));
  });
});

describe('cacheStatus includes log and diagnostics paths', () => {
  it('returns null for both when no files exist', async () => {
    const { cacheStatus } = await import('../src/cache.js');
    const status = await cacheStatus(tmpDir);
    expect(status.latestLogFile).toBeNull();
    expect(status.latestDiagnosticsFile).toBeNull();
  });

  it('returns file paths when log and diagnostics files exist', async () => {
    const logger = makeLogger({
      logDir: logsDir(tmpDir),
      diagnosticsDir: diagnosticsDir(tmpDir)
    });
    await logger.init();
    logger.log('info', 'test', { message: 'hello' });
    await logger.writeFinalDiagnostics(makeRunDiagnostics());

    const { cacheStatus } = await import('../src/cache.js');
    const status = await cacheStatus(tmpDir);
    expect(status.latestLogFile).toBe(latestLogPath(tmpDir));
    expect(status.latestDiagnosticsFile).toBe(latestDiagnosticsPath(tmpDir));
  });
});
