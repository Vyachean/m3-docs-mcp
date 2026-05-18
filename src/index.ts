#!/usr/bin/env node
import { Command } from 'commander';
import { cacheStatus, getDefaultCacheDir } from './cache.js';
import { crawlMaterialDocs, installPlaywrightChromium } from './crawler.js';
import { serveMcp } from './mcp-server.js';
import { parsePositiveIntegerOption, parsePositiveNumberOption } from './options.js';

const program = new Command();

program
  .name('m3-docs-mcp')
  .description('MCP server that serves locally cached Material 3 documentation from m3.material.io')
  .version('0.1.0');

program.command('serve')
  .description('Start the MCP server over stdio')
  .option('--cache-dir <path>', 'Cache directory')
  .option('--max-age-hours <hours>', 'Mark cache as stale when it is older than this value', '24')
  .option('--startup-max-pages <number>', 'Maximum pages to crawl during automatic startup refresh', '250')
  .option('--no-auto-update', 'Disable automatic cache refresh on server startup')
  .action(async (options) => {
    await serveMcp({
      cacheDir: options.cacheDir,
      maxAgeHours: parsePositiveNumberOption('--max-age-hours', options.maxAgeHours),
      startupMaxPages: parsePositiveIntegerOption('--startup-max-pages', options.startupMaxPages),
      autoUpdate: options.autoUpdate
    });
  });

program.command('update')
  .description('Refresh the local Material 3 documentation cache')
  .option('--cache-dir <path>', 'Cache directory')
  .option('--max-pages <number>', 'Maximum pages to crawl', '250')
  .option('--min-pages <number>', 'Minimum accepted page count before replacing the existing cache', '10')
  .option('--force', 'Replace the existing cache even when the new crawl has fewer pages or many failures')
  .option('--headed', 'Run browser in headed mode')
  .action(async (options) => {
    const index = await crawlMaterialDocs({
      cacheDir: options.cacheDir,
      maxPages: parsePositiveIntegerOption('--max-pages', options.maxPages),
      minPageCount: parsePositiveIntegerOption('--min-pages', options.minPages),
      headless: !options.headed,
      force: options.force
    });
    console.log(JSON.stringify({
      cacheDir: options.cacheDir ?? getDefaultCacheDir(),
      capturedAt: index.capturedAt,
      pageCount: index.pageCount,
      attemptedPageCount: index.attemptedPageCount,
      failedPageCount: index.failedPageCount,
      failedUrls: index.failedUrls
    }, null, 2));
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
  .option('--max-age-hours <hours>', 'Mark cache as stale when it is older than this value', '24')
  .action(async (options) => {
    const cacheDir = options.cacheDir ?? getDefaultCacheDir();
    console.log(JSON.stringify(await cacheStatus(cacheDir, parsePositiveNumberOption('--max-age-hours', options.maxAgeHours)), null, 2));
  });

program.parseAsync(process.argv).catch((error) => {
  console.error(error instanceof Error ? error.stack ?? error.message : String(error));
  process.exitCode = 1;
});
