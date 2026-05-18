#!/usr/bin/env node
import { Command } from 'commander';
import { cacheAgeMs, getDefaultCacheDir, readIndex } from './cache.js';
import { crawlMaterialDocs } from './crawler.js';
import { serveMcp } from './mcp-server.js';

const program = new Command();

program
  .name('m3-docs-mcp')
  .description('MCP server that serves locally cached Material 3 documentation from m3.material.io')
  .version('0.1.0');

program.command('serve')
  .description('Start the MCP server over stdio')
  .option('--cache-dir <path>', 'Cache directory')
  .option('--max-age-hours <hours>', 'Refresh cache when it is older than this value', '24')
  .action(async (options) => {
    await serveMcp({ cacheDir: options.cacheDir, maxAgeHours: Number(options.maxAgeHours) });
  });

program.command('update')
  .description('Refresh the local Material 3 documentation cache')
  .option('--cache-dir <path>', 'Cache directory')
  .option('--max-pages <number>', 'Maximum pages to crawl', '250')
  .option('--headed', 'Run browser in headed mode')
  .action(async (options) => {
    const index = await crawlMaterialDocs({ cacheDir: options.cacheDir, maxPages: Number(options.maxPages), headless: !options.headed });
    console.log(JSON.stringify({ cacheDir: options.cacheDir ?? getDefaultCacheDir(), capturedAt: index.capturedAt, pageCount: index.pageCount }, null, 2));
  });

program.command('status')
  .description('Print local cache status')
  .option('--cache-dir <path>', 'Cache directory')
  .action(async (options) => {
    const cacheDir = options.cacheDir ?? getDefaultCacheDir();
    const index = await readIndex(cacheDir);
    const age = await cacheAgeMs(cacheDir);
    console.log(JSON.stringify({ cacheDir, hasCache: Boolean(index), capturedAt: index?.capturedAt ?? null, pageCount: index?.pageCount ?? 0, ageMs: age }, null, 2));
  });

program.parseAsync(process.argv).catch((error) => {
  console.error(error instanceof Error ? error.stack ?? error.message : String(error));
  process.exitCode = 1;
});
