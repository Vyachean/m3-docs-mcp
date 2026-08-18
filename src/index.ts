#!/usr/bin/env node
import { Command } from 'commander';
import { cacheStatus, getDefaultCacheDir } from './cache.js';
import { DEFAULT_CACHE_MAX_AGE_HOURS, MAX_CRAWL_CONCURRENCY } from './constants.js';
import { crawlMaterialDocs, installPlaywrightChromium } from './crawler.js';
import { serveMcp } from './mcp-server.js';
import { parseBoundedPositiveIntegerOption, parsePositiveIntegerOption, parsePositiveNumberOption } from './options.js';
import { formatDurationMs } from './progress.js';
import type { CrawlProgress } from './types.js';
import { validateCacheV2 } from './validation/validate-cache-v2.js';

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
  .option('--startup-concurrency <number>', `Maximum concurrent crawl workers during automatic startup refresh, up to ${MAX_CRAWL_CONCURRENCY}`, '1')
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
  .option('--max-pages <number>', 'Limit the crawl to this many source routes (smoke/limited run). Omit for a full refresh with no source-route limit.')
  .option('--min-pages <number>', 'Minimum accepted page count before replacing the existing cache', '10')
  .option('--concurrency <number>', `Maximum concurrent crawl workers, up to ${MAX_CRAWL_CONCURRENCY}`, '1')
  .option('--force', 'Replace the existing cache even when the new crawl has fewer pages or many failures')
  .option('--promote-partial', 'Promote a limited/partial crawl (e.g. with --max-pages) even when no previous cache exists or the previous cache was a full verified run. Off by default to avoid silently replacing a complete cache with a smoke-sized one.')
  .option('--strict-graph', 'Fail promotion if the documentation graph, renderer report, manifest, or no-network validation stages (raw-snapshot/structured-graph/rendered-output/coverage-summary) fail, instead of logging and continuing. Off by default; used by verify:cache:full for production promotion.')
  .option('--allow-browser-fallback', 'Enable Playwright browser network/DOM fallback when deterministic JSON extraction cannot cover a route')
  .option('--headed', 'Run the explicitly enabled browser fallback in headed mode')
  .option('--include-blog', 'Include blog, news, and article routes in the crawl (excluded by default)')
  .option('--log-dir <path>', 'Directory for update log files (default: <cache-dir>/logs)')
  .option('--verbose', 'Enable verbose/debug log output in the log file')
  .action(async (options) => {
    const maxPagesExplicit = options.maxPages !== undefined;
    const maxPages = maxPagesExplicit ? parsePositiveIntegerOption('--max-pages', options.maxPages) : null;
    const minPageCount = parsePositiveIntegerOption('--min-pages', options.minPages);
    const concurrency = parseBoundedPositiveIntegerOption('--concurrency', options.concurrency, 1, MAX_CRAWL_CONCURRENCY);
    const cacheDir = options.cacheDir ?? getDefaultCacheDir();
    const abortController = new AbortController();
    const removeSignalHandlers = installAbortSignalHandlers(abortController);
    const { onProgress, onBeforeLog } = createCliProgressRenderer();
    let updateLogFile: string | null = null;
    let updateDiagnosticsFile: string | null = null;
    console.error(`Starting Material 3 docs cache refresh: cacheDir=${cacheDir} maxPages=${maxPages ?? 'unlimited (full refresh)'} minPages=${minPageCount} concurrency=${concurrency} includeBlog=${options.includeBlog ?? false}. Press Ctrl+C to stop safely.`);
    try {
      const index = await crawlMaterialDocs({
        cacheDir,
        maxPages,
        maxPagesExplicit,
        minPageCount,
        concurrency,
        headless: !options.headed,
        allowBrowserFallback: options.allowBrowserFallback ?? false,
        force: options.force,
        promotePartial: options.promotePartial ?? false,
        strictGraph: options.strictGraph ?? false,
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
        source: index.source,
        pageCount: index.pageCount,
        attemptedPageCount: index.attemptedPageCount,
        failedPageCount: index.failedPageCount,
        failedUrls: index.failedUrls,
        coverageHealth: index.coverageDiagnostics?.coverageHealth ?? null,
        qualitySummary: index.qualitySummary ?? null,
        diagnosticsFile: updateDiagnosticsFile
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
  .description('Install Playwright Chromium for browser-oracle verification and optional fallback')
  .option('--with-deps', 'Also install Playwright system dependencies on supported Linux distributions')
  .action(async (options) => {
    await installPlaywrightChromium(options.withDeps);
    console.log(options.withDeps ? 'Playwright Chromium browser and system dependencies installed.' : 'Playwright Chromium browser installed.');
  });

program.command('validate-cache')
  .description('Validate a generated cache v2 snapshot (schema-aware; the only production validator m3-docs-cache should use)')
  .option('--cache-dir <path>', 'Cache directory')
  .action(async (options) => {
    const cacheDir = options.cacheDir ?? getDefaultCacheDir();
    const result = await validateCacheV2({ cacheDir });

    if (!result.allPassed) {
      console.error(`Cache validation FAILED for ${cacheDir}: ${result.failedStages.length} stage(s) failed (${result.failedStages.join(', ')}).`);
      for (const stage of result.results) {
        if (stage.passed) continue;
        console.error(`\n[${stage.stage}]`);
        for (const reason of stage.reasons) console.error(`  - ${reason}`);
      }
      console.log(JSON.stringify(result, null, 2));
      process.exitCode = 1;
      return;
    }

    console.error(`Cache validation PASSED for ${cacheDir}: pages=${result.counts.pages} routes=${result.counts.routes} resources=${result.counts.resources} tokenTables=${result.counts.tokenTables} rawArtifacts=${result.counts.rawArtifacts}`);
    if (result.health) {
      console.error(`Manifest health: rawSnapshot=${result.health.rawSnapshot} graph=${result.health.graph} markdown=${result.health.markdown} coverage=${result.health.coverage}`);
    }
    if (result.quality) {
      const q = result.quality;
      console.error(`Quality: unresolvedTokenRows=${q.unresolvedTokenRows} unresolvedTokenCells=${q.unresolvedTokenCells} specPagesWithTokenTables=${q.specPagesWithTokenTables} specPagesWithoutTokenTables=${q.specPagesWithoutTokenTables} stalePublicDocs=${q.unclassifiedRejectedPublicDocsRoutes}`);
    }
    console.log(JSON.stringify(result, null, 2));
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
    const maxPagesStr = progress.maxPages >= Number.MAX_SAFE_INTEGER ? 'unlimited' : String(progress.maxPages);
    const line = `Material 3 docs cache refresh: phase=${progress.phase} elapsed=${elapsed} ${etaStr} ${rateStr} saved=${progress.savedPageCount}/${maxPagesStr} failed=${progress.failedPageCount} attempted=${progress.attemptedPageCount} queued=${progress.queuedPageCount} active=${progress.activeWorkerCount}/${progress.concurrency}${current}`;
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
