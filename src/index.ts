#!/usr/bin/env node
import { readdir, stat } from 'node:fs/promises';
import path from 'node:path';
import { Command } from 'commander';
import { cacheStatus, getDefaultCacheDir } from './cache.js';
import { crawlMaterialDocs, installPlaywrightChromium } from './crawler.js';
import { serveMcp } from './mcp-server.js';
import { parseBoundedPositiveIntegerOption, parsePositiveIntegerOption, parsePositiveNumberOption } from './options.js';

const program = new Command();
const MAX_CRAWL_CONCURRENCY = 8;
const DEFAULT_CACHE_MAX_AGE_HOURS = 168;
const CLI_PROGRESS_INTERVAL_MS = 1_000;

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
  .action(async (options) => {
    const maxPages = parsePositiveIntegerOption('--max-pages', options.maxPages);
    const minPageCount = parsePositiveIntegerOption('--min-pages', options.minPages);
    const concurrency = parseBoundedPositiveIntegerOption('--concurrency', options.concurrency, 1, MAX_CRAWL_CONCURRENCY);
    const cacheDir = options.cacheDir ?? getDefaultCacheDir();
    const abortController = new AbortController();
    const removeSignalHandlers = installAbortSignalHandlers(abortController);
    console.error(`Starting Material 3 docs cache refresh: maxPages=${maxPages}, minPages=${minPageCount}, concurrency=${concurrency}. Press Ctrl+C to stop safely.`);
    const stopProgressReporter = startCliProgressReporter({ cacheDir, maxPages, minPageCount, concurrency });
    try {
      const index = await crawlMaterialDocs({
        cacheDir,
        maxPages,
        minPageCount,
        concurrency,
        headless: !options.headed,
        force: options.force,
        signal: abortController.signal
      });
      console.error(`Material 3 docs cache refresh completed: saved ${index.pageCount} pages, failed ${index.failedPageCount} URLs.`);
      console.log(JSON.stringify({
        cacheDir,
        capturedAt: index.capturedAt,
        pageCount: index.pageCount,
        attemptedPageCount: index.attemptedPageCount,
        failedPageCount: index.failedPageCount,
        failedUrls: index.failedUrls
      }, null, 2));
    } catch (error) {
      if (abortController.signal.aborted) {
        console.error('Material 3 docs cache refresh interrupted. Existing cache was left unchanged. If this was the first refresh, status will still report hasCache=false.');
        process.exitCode = 130;
        return;
      }
      throw error;
    } finally {
      stopProgressReporter();
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

function startCliProgressReporter(options: { cacheDir: string; maxPages: number; minPageCount: number; concurrency: number }): () => void {
  const startedAt = Date.now();
  let previousLength = 0;
  let stopped = false;
  let tickRunning = false;

  const render = async () => {
    if (stopped || tickRunning) return;
    tickRunning = true;
    try {
      const elapsedSeconds = Math.floor((Date.now() - startedAt) / 1000);
      const savedPages = await countStagedMarkdownPages(options.cacheDir);
      const line = `Material 3 docs cache refresh: elapsed=${elapsedSeconds}s saved=${savedPages}/${options.maxPages} min=${options.minPageCount} concurrency=${options.concurrency}`;
      if (process.stderr.isTTY) {
        const padding = previousLength > line.length ? ' '.repeat(previousLength - line.length) : '';
        process.stderr.write(`\r${line}${padding}`);
        previousLength = line.length;
      } else {
        console.error(line);
      }
    } finally {
      tickRunning = false;
    }
  };

  void render();
  const timer = setInterval(() => void render(), CLI_PROGRESS_INTERVAL_MS);
  return () => {
    stopped = true;
    clearInterval(timer);
    if (process.stderr.isTTY && previousLength > 0) process.stderr.write('\n');
  };
}

async function countStagedMarkdownPages(cacheDir: string): Promise<number> {
  const stagingDir = await newestStagingCacheDir(cacheDir);
  if (!stagingDir) return 0;
  return countMarkdownFiles(path.join(stagingDir, 'pages'));
}

async function newestStagingCacheDir(cacheDir: string): Promise<string | null> {
  const parentDir = path.dirname(cacheDir);
  let entries: string[];
  try {
    entries = await readdir(parentDir);
  } catch {
    return null;
  }

  let newest: { dir: string; mtimeMs: number } | null = null;
  for (const entry of entries) {
    if (!entry.startsWith('.m3-docs-mcp-staging-')) continue;
    const dir = path.join(parentDir, entry);
    try {
      const stats = await stat(dir);
      if (!stats.isDirectory()) continue;
      if (!newest || stats.mtimeMs > newest.mtimeMs) newest = { dir, mtimeMs: stats.mtimeMs };
    } catch {
      // Ignore staging directories deleted between readdir and stat.
    }
  }
  return newest?.dir ?? null;
}

async function countMarkdownFiles(dir: string): Promise<number> {
  let entries;
  try {
    entries = await readdir(dir, { withFileTypes: true });
  } catch {
    return 0;
  }

  let count = 0;
  for (const entry of entries) {
    const fullPath = path.join(dir, entry.name);
    if (entry.isDirectory()) count += await countMarkdownFiles(fullPath);
    else if (entry.isFile() && entry.name.endsWith('.md')) count += 1;
  }
  return count;
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
