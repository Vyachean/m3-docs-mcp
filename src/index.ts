#!/usr/bin/env node
import { Command } from 'commander';
import { cacheStatus, getDefaultCacheDir } from './cache.js';
import { DEFAULT_CACHE_MAX_AGE_HOURS, MAX_CRAWL_CONCURRENCY } from './constants.js';
import { crawlMaterialDocs, installPlaywrightChromium } from './crawler.js';
import { serveMcp } from './mcp-server.js';
import { parseBoundedPositiveIntegerOption, parsePositiveIntegerOption, parsePositiveNumberOption } from './options.js';
import { formatDurationMs } from './progress.js';
import type { CrawlProgress } from './types.js';

const program = new Command();

program
  .name('m3-docs-mcp')
  .description('MCP server that serves locally cached Material 3 documentation from m3.material.io')
  .version('0.1.0');

program.command('serve')
  .description('Start the MCP server over stdio')
  .option('--cache-dir <path>', 'Cache directory')
  .option('--max-age-hours <hours>', 'Mark cache as stale when it is older than this value', String(DEFAULT_CACHE_MAX_AGE_HOURS))
  .option('--startup-max-pages <number>', 'Maximum pages to crawl during automatic startup refresh', '250')
  .option('--startup-concurrency <number>', `Maximum concurrent Playwright pages during automatic startup refresh, up to ${MAX_CRAWL_CONCURRENCY}`, '1')
  .option('--no-auto-update', 'Disable automatic cache refresh on server startup')
  .action(async (options) => {
    await serveMcp({
      cacheDir: options.cacheDir,
      maxAgeHours: parsePositiveNumberOption('--max-age-hours', options.maxAgeHours),
      startupMaxPages: parsePositiveIntegerOption('--startup-max-pages', options.startupMaxPages),
      startupConcurrency: parseBoundedPositiveIntegerOption('--startup-concurrency', options.startupConcurrency, 1, MAX_CRAWL_CONCURRENCY),
      autoUpdate: options.autoUpdate
    });
  });

program.command('update')
  .description('Refresh the local Material 3 documentation cache')
  .option('--cache-dir <path>', 'Cache directory')
  .option('--max-pages <number>', 'Maximum pages to crawl', '250')
  .option('--min-pages <number>', 'Minimum accepted page count before replacing the existing cache', '10')
  .option('--concurrency <number>', `Maximum concurrent Playwright pages, up to ${MAX_CRAWL_CONCURRENCY}`, '1')
  .option('--force', 'Replace the existing cache even when the new crawl has fewer pages or many failures')
  .option('--headed', 'Run browser in headed mode')
  .option('--include-blog', 'Include blog, news, and article routes in the crawl (excluded by default)')
  .option('--log-dir <path>', 'Directory for update log files (default: <cache-dir>/logs)')
  .option('--verbose', 'Enable verbose/debug log output in the log file')
  .action(async (options) => {
    const maxPages = parsePositiveIntegerOption('--max-pages', options.maxPages);
    const minPageCount = parsePositiveIntegerOption('--min-pages', options.minPages);
    const concurrency = parseBoundedPositiveIntegerOption('--concurrency', options.concurrency, 1, MAX_CRAWL_CONCURRENCY);
    const cacheDir = options.cacheDir ?? getDefaultCacheDir();
    const abortController = new AbortController();
    const removeSignalHandlers = installAbortSignalHandlers(abortController);
    const { onProgress, onBeforeLog } = createCliProgressRenderer();
    let updateLogFile: string | null = null;
    let updateDiagnosticsFile: string | null = null;
    console.error(`Starting Material 3 docs cache refresh: cacheDir=${cacheDir} maxPages=${maxPages} minPages=${minPageCount} concurrency=${concurrency} includeBlog=${options.includeBlog ?? false}. Press Ctrl+C to stop safely.`);
    try {
      const index = await crawlMaterialDocs({
        cacheDir,
        maxPages,
        minPageCount,
        concurrency,
        headless: !options.headed,
        force: options.force,
        includeBlog: options.includeBlog ?? false,
        signal: abortController.signal,
        onProgress,
        onBeforeLog,
        onLoggerReady: (logFile, diagnosticsFile) => {
          updateLogFile = logFile;
          updateDiagnosticsFile = diagnosticsFile;
          console.error(`Update log: ${logFile}`);
          console.error(`Diagnostics: ${diagnosticsFile}`);
        },
        logDir: options.logDir,
        verbose: options.verbose ?? false
      });
      onProgress(null);
      console.error(`Material 3 docs cache refresh completed: saved ${index.pageCount} pages, failed ${index.failedPageCount} URLs.`);
      if (updateLogFile) console.error(`Update log: ${updateLogFile}`);
      if (updateDiagnosticsFile) console.error(`Diagnostics: ${updateDiagnosticsFile}`);
      console.log(JSON.stringify({
        cacheDir,
        capturedAt: index.capturedAt,
        pageCount: index.pageCount,
        attemptedPageCount: index.attemptedPageCount,
        failedPageCount: index.failedPageCount,
        failedUrls: index.failedUrls,
        extractionDiagnostics: index.extractionDiagnostics,
        coverageDiagnostics: index.coverageDiagnostics
      }, null, 2));
    } catch (error) {
      onProgress(null);
      if (abortController.signal.aborted) {
        console.error('Material 3 docs cache refresh interrupted. Existing cache was left unchanged. If this was the first refresh, status will still report hasCache=false.');
        process.exitCode = 130;
        return;
      }
      throw error;
    } finally {
      removeSignalHandlers();
    }
  });

program.command('install-browser')
  .description('Install the Playwright Chromium browser used by the crawler')
  .option('--with-deps', 'Also install Playwright system dependencies on supported Linux distributions')
  .action(async (options) => {
    await installPlaywrightChromium(options.withDeps);
    console.log(options.withDeps ? 'Playwright Chromium browser and system dependencies installed.' : 'Playwright Chromium browser installed.');
  });

program.command('status')
  .description('Print local cache status')
  .option('--cache-dir <path>', 'Cache directory')
  .option('--max-age-hours <hours>', 'Mark cache as stale when it is older than this value', String(DEFAULT_CACHE_MAX_AGE_HOURS))
  .action(async (options) => {
    const cacheDir = options.cacheDir ?? getDefaultCacheDir();
    console.log(JSON.stringify(await cacheStatus(cacheDir, parsePositiveNumberOption('--max-age-hours', options.maxAgeHours)), null, 2));
  });

program.parseAsync(process.argv).catch((error) => {
  console.error(error instanceof Error ? error.stack ?? error.message : String(error));
  process.exitCode = 1;
});

export function createCliProgressRenderer(): {
  onProgress: (progress: CrawlProgress | null) => void;
  onBeforeLog: () => void;
} {
  let previousLength = 0;
  let lastRenderMs = 0;
  const THROTTLE_MS = 1000;

  const onBeforeLog = (): void => {
    if (process.stderr.isTTY && previousLength > 0) {
      process.stderr.write('\n');
      previousLength = 0;
    }
  };

  const onProgress = (progress: CrawlProgress | null): void => {
    if (!progress) {
      if (process.stderr.isTTY && previousLength > 0) process.stderr.write('\n');
      previousLength = 0;
      lastRenderMs = 0;
      return;
    }

    const nowMs = Date.now();
    if (nowMs - lastRenderMs < THROTTLE_MS && progress.running) return;
    lastRenderMs = nowMs;

    const elapsed = formatDurationMs(progress.elapsedMs);
    const etaPrefix = (progress.phase === 'browser-dom-fallback' || progress.phase === 'browser-crawl') ? 'eta≈' : 'eta=';
    const etaStr = progress.estimatedRemainingMs !== null
      ? `${etaPrefix}${formatDurationMs(progress.estimatedRemainingMs)}`
      : 'eta=calculating';
    const rateStr = progress.ratePagesPerSecond !== null
      ? `rate=${progress.ratePagesPerSecond.toFixed(2)}/s`
      : 'rate=calculating';
    const current = progress.currentUrls[0] ? ` current=${progress.currentUrls[0]}` : '';
    const line = `Material 3 docs cache refresh: phase=${progress.phase} elapsed=${elapsed} ${etaStr} ${rateStr} saved=${progress.savedPageCount}/${progress.maxPages} failed=${progress.failedPageCount} attempted=${progress.attemptedPageCount} queued=${progress.queuedPageCount} active=${progress.activeWorkerCount}/${progress.concurrency}${current}`;
    if (process.stderr.isTTY) {
      const padding = previousLength > line.length ? ' '.repeat(previousLength - line.length) : '';
      process.stderr.write(`\r${line}${padding}`);
      previousLength = line.length;
    } else {
      process.stderr.write(`${line}\n`);
    }
  };

  return { onProgress, onBeforeLog };
}

function installAbortSignalHandlers(abortController: AbortController): () => void {
  const abortFromInt = () => abortWithName(abortController, 'SIGINT');
  const abortFromTerm = () => abortWithName(abortController, 'SIGTERM');
  process.once('SIGINT', abortFromInt);
  process.once('SIGTERM', abortFromTerm);
  return () => {
    process.off('SIGINT', abortFromInt);
    process.off('SIGTERM', abortFromTerm);
  };
}

function abortWithName(abortController: AbortController, signalName: string): void {
  if (!abortController.signal.aborted) abortController.abort(new Error(`Interrupted by ${signalName}.`));
}
