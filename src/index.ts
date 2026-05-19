#!/usr/bin/env node
import { Command } from 'commander';
import { cacheStatus, getDefaultCacheDir } from './cache.js';
import { DEFAULT_CACHE_MAX_AGE_HOURS, MAX_CRAWL_CONCURRENCY } from './constants.js';
import { crawlMaterialDocs, installPlaywrightChromium } from './crawler.js';
import { serveMcp } from './mcp-server.js';
import { parseBoundedPositiveIntegerOption, parsePositiveIntegerOption, parsePositiveNumberOption } from './options.js';
import { MaterialDocsStore } from './store.js';
import type { CrawlProgress } from './types.js';

const program = new Command();

type ReadCommandOptions = {
  cacheDir?: string;
  maxAgeHours: string;
};

type SearchCommandOptions = ReadCommandOptions & {
  limit: string;
};

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
    const renderProgress = createCliProgressRenderer();
    console.error(`Starting Material 3 docs cache refresh: maxPages=${maxPages}, minPages=${minPageCount}, concurrency=${concurrency}. Press Ctrl+C to stop safely.`);
    try {
      const index = await crawlMaterialDocs({
        cacheDir,
        maxPages,
        minPageCount,
        concurrency,
        headless: !options.headed,
        force: options.force,
        signal: abortController.signal,
        onProgress: renderProgress
      });
      renderProgress(null);
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
      renderProgress(null);
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

program.command('search')
  .description('Search the local Material 3 documentation cache from the CLI')
  .argument('<query...>', 'Search query')
  .option('--cache-dir <path>', 'Cache directory')
  .option('--max-age-hours <hours>', 'Mark cache as stale when it is older than this value', String(DEFAULT_CACHE_MAX_AGE_HOURS))
  .option('--limit <number>', 'Maximum search results, up to 25', '10')
  .action(async (queryParts: string[], options: SearchCommandOptions) => {
    const limit = parseBoundedPositiveIntegerOption('--limit', options.limit, 1, 25);
    const query = queryParts.join(' ').trim();
    await printCachedResult(options, 'results', [], (store) => store.searchDocs(query, limit));
  });

program.command('page')
  .description('Print one cached Material 3 documentation page by cache path or source URL')
  .argument('<path-or-url>', 'Cache path, Material page path, or source URL')
  .option('--cache-dir <path>', 'Cache directory')
  .option('--max-age-hours <hours>', 'Mark cache as stale when it is older than this value', String(DEFAULT_CACHE_MAX_AGE_HOURS))
  .action(async (pathOrUrl: string, options: ReadCommandOptions) => {
    await printCachedResult(options, 'page', null, (store) => store.getPage(pathOrUrl));
  });

program.command('component')
  .description('Print cached Material 3 documentation pages matching a component name')
  .argument('<component-name...>', 'Component name or slug')
  .option('--cache-dir <path>', 'Cache directory')
  .option('--max-age-hours <hours>', 'Mark cache as stale when it is older than this value', String(DEFAULT_CACHE_MAX_AGE_HOURS))
  .action(async (componentNameParts: string[], options: ReadCommandOptions) => {
    const componentName = componentNameParts.join(' ').trim();
    await printCachedResult(options, 'pages', [], (store) => store.getComponentDocs(componentName));
  });

program.command('components')
  .description('List component slugs discovered in the local Material 3 documentation cache')
  .option('--cache-dir <path>', 'Cache directory')
  .option('--max-age-hours <hours>', 'Mark cache as stale when it is older than this value', String(DEFAULT_CACHE_MAX_AGE_HOURS))
  .action(async (options: ReadCommandOptions) => {
    await printCachedResult(options, 'components', [], (store) => store.listComponents());
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

async function printCachedResult(
  options: ReadCommandOptions,
  resultKey: string,
  unavailableFallback: unknown,
  read: (store: MaterialDocsStore) => Promise<unknown>
): Promise<void> {
  const cacheDir = options.cacheDir ?? getDefaultCacheDir();
  const maxAgeHours = parsePositiveNumberOption('--max-age-hours', options.maxAgeHours);
  const store = new MaterialDocsStore(cacheDir);
  const status = await store.getStatus(maxAgeHours);

  if (!status.hasCache) {
    printJson({
      status,
      message: 'Material 3 docs cache is not available. Run: m3-docs-mcp update',
      [resultKey]: unavailableFallback
    });
    process.exitCode = 2;
    return;
  }

  printJson({
    status,
    [resultKey]: await read(store)
  });
}

function printJson(value: unknown): void {
  console.log(JSON.stringify(value, null, 2));
}

function createCliProgressRenderer(): (progress: CrawlProgress | null) => void {
  let previousLength = 0;

  return (progress) => {
    if (!progress) {
      if (process.stderr.isTTY && previousLength > 0) process.stderr.write('\n');
      previousLength = 0;
      return;
    }

    const elapsedSeconds = Math.floor((Date.parse(progress.updatedAt) - Date.parse(progress.startedAt)) / 1000);
    const current = progress.currentUrls[0] ? ` current=${progress.currentUrls[0]}` : '';
    const line = `Material 3 docs cache refresh: elapsed=${elapsedSeconds}s saved=${progress.savedPageCount}/${progress.maxPages} failed=${progress.failedPageCount} attempted=${progress.attemptedPageCount} queued=${progress.queuedPageCount} active=${progress.activeWorkerCount} concurrency=${progress.concurrency}${current}`;
    if (process.stderr.isTTY) {
      const padding = previousLength > line.length ? ' '.repeat(previousLength - line.length) : '';
      process.stderr.write(`\r${line}${padding}`);
      previousLength = line.length;
    } else {
      console.error(line);
    }
  };
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
