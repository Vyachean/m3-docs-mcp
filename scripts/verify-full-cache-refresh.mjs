#!/usr/bin/env node
import { spawn } from 'node:child_process';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { z } from 'zod';

const REQUIRED_PAGE_PATHS = [
  'pages/components/switch/overview.md',
  'pages/components/switch/specs.md',
  'pages/components/toolbars/overview.md',
  'pages/components/toolbars/specs.md',
  'pages/components/segmented-buttons/overview.md',
  'pages/components/segmented-buttons/specs.md'
];

const PLACEHOLDER_PATTERNS = [
  '[TOKEN_TABLE placeholder',
  'missing-requested-token-sets',
  'missing-token-system',
  'missing-resource-name'
];

const ProblematicExampleSchema = z.object({
  sourceRoute: z.string(),
  canonicalRoute: z.string(),
  status: z.string(),
  failureReasons: z.array(z.string()).default([])
}).passthrough();

const RouteCoverageSummarySchema = z.object({
  failedRoutes: z.number().int().nonnegative(),
  unresolvedRoutes: z.number().int().nonnegative(),
  partialRoutes: z.number().int().nonnegative(),
  problematicExamples: z.array(ProblematicExampleSchema).default([])
}).passthrough();

const IndexSchema = z.object({
  coverageDiagnostics: z.object({
    coverageHealth: z.string(),
    routeCoverageSummary: RouteCoverageSummarySchema
  }).passthrough()
}).passthrough();

async function main() {
  const mode = process.argv.includes('--smoke') ? 'smoke' : 'full';
  const tempCacheDir = await fs.mkdtemp(path.join(os.tmpdir(), 'm3-docs-cache-verify-'));
  let keepTempDir = true;
  let cliExitCode = null;

  try {
    cliExitCode = await runBuiltCli(tempCacheDir, mode);
    if (cliExitCode !== 0) {
      throw new Error(`Built CLI exited with code ${cliExitCode}.`);
    }

    const index = await readVerifiedIndex(tempCacheDir);
    const routeCoverageSummary = index.coverageDiagnostics.routeCoverageSummary;

    assertCoverage(index.coverageDiagnostics.coverageHealth, routeCoverageSummary, mode);
    await assertRequiredPages(tempCacheDir);
    await assertNoTokenTablePlaceholders(tempCacheDir, mode);

    console.error(`[verify:cache:${mode}] Success. cacheDir=${tempCacheDir}`);
    await fs.rm(tempCacheDir, { recursive: true, force: true });
    keepTempDir = false;
  } catch (error) {
    await printFailureDiagnostics({
      tempCacheDir,
      cliExitCode,
      mode,
      error
    });
    process.exitCode = 1;
  } finally {
    if (keepTempDir) {
      console.error(`[verify:cache:${mode}] Preserved temp cache dir: ${tempCacheDir}`);
    }
  }
}

function runBuiltCli(tempCacheDir, mode) {
  const args = [
    'dist/index.js',
    'update',
    '--cache-dir',
    tempCacheDir,
    '--concurrency',
    '6'
  ];

  if (mode === 'smoke') {
    args.push('--max-pages', '40', '--min-pages', '20');
  } else {
    args.push('--min-pages', '150');
  }

  console.error(`[verify:cache:${mode}] Running: node ${args.join(' ')}`);

  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, args, {
      stdio: 'inherit',
      env: process.env
    });

    child.on('error', reject);
    child.on('exit', (code, signal) => {
      if (signal) {
        reject(new Error(`Built CLI exited from signal ${signal}.`));
        return;
      }
      resolve(code ?? 1);
    });
  });
}

async function readVerifiedIndex(tempCacheDir) {
  const indexPath = path.join(tempCacheDir, 'index.json');
  const raw = await fs.readFile(indexPath, 'utf8');
  const parsed = JSON.parse(raw);
  return IndexSchema.parse(parsed);
}

function assertCoverage(coverageHealth, routeCoverageSummary, mode) {
  if (mode === 'smoke') {
    if (coverageHealth !== 'partial' && coverageHealth !== 'verified') {
      throw new Error(`Expected coverageDiagnostics.coverageHealth to be "partial" or "verified" for smoke, received ${JSON.stringify(coverageHealth)}.`);
    }
    return;
  }
  if (coverageHealth !== 'verified') {
    throw new Error(`Expected coverageDiagnostics.coverageHealth to be "verified" for ${mode}, received ${JSON.stringify(coverageHealth)}.`);
  }
  const failures = [
    ['failedRoutes', routeCoverageSummary.failedRoutes],
    ['unresolvedRoutes', routeCoverageSummary.unresolvedRoutes],
    ['partialRoutes', routeCoverageSummary.partialRoutes]
  ].filter(([, value]) => value !== 0);

  if (failures.length > 0) {
    const summary = failures.map(([key, value]) => `${key}=${value}`).join(', ');
    throw new Error(`Expected zero problematic route counts for ${mode}, received ${summary}.`);
  }
}

async function assertRequiredPages(tempCacheDir) {
  const missingPaths = [];
  for (const relativePath of REQUIRED_PAGE_PATHS) {
    const absolutePath = path.join(tempCacheDir, relativePath);
    try {
      await fs.access(absolutePath);
    } catch {
      missingPaths.push(relativePath);
    }
  }

  if (missingPaths.length > 0) {
    throw new Error(`Missing required generated page(s): ${missingPaths.join(', ')}.`);
  }
}

async function assertNoTokenTablePlaceholders(tempCacheDir, mode) {
  const pagesDir = path.join(tempCacheDir, 'pages');
  const specFiles = await collectSpecMarkdownFiles(pagesDir);
  if (mode === 'smoke' && specFiles.length === 0) return;
  const failures = [];

  for (const filePath of specFiles) {
    const markdown = await fs.readFile(filePath, 'utf8');
    const matchedPattern = PLACEHOLDER_PATTERNS.find((pattern) => markdown.includes(pattern));
    if (!matchedPattern) continue;
    failures.push({
      path: path.relative(tempCacheDir, filePath),
      pattern: matchedPattern
    });
  }

  if (failures.length > 0) {
    const summary = failures.slice(0, 10).map((failure) => `${failure.path} -> ${failure.pattern}`).join('; ');
    throw new Error(`Found unresolved token table placeholders in generated specs pages during ${mode}: ${summary}${failures.length > 10 ? `; and ${failures.length - 10} more` : ''}.`);
  }
}

async function collectSpecMarkdownFiles(rootDir) {
  const results = [];
  await walk(rootDir, results);
  return results.filter((filePath) => filePath.endsWith('/specs.md'));
}

async function walk(currentDir, results) {
  const entries = await fs.readdir(currentDir, { withFileTypes: true });
  for (const entry of entries) {
    const entryPath = path.join(currentDir, entry.name);
    if (entry.isDirectory()) {
      await walk(entryPath, results);
      continue;
    }
    if (entry.isFile()) results.push(entryPath);
  }
}

async function printFailureDiagnostics({ tempCacheDir, cliExitCode, mode, error }) {
  console.error(`[verify:cache:${mode}] Failed: ${error instanceof Error ? error.message : String(error)}`);
  console.error(`[verify:cache:${mode}] CLI exit code: ${cliExitCode === null ? 'not available' : cliExitCode}`);
  console.error(`[verify:cache:${mode}] Temp cache dir: ${tempCacheDir}`);

  const logPath = path.join(tempCacheDir, 'logs', 'latest.jsonl');
  const diagnosticsPath = path.join(tempCacheDir, 'diagnostics', 'latest-update.json');
  const indexPath = path.join(tempCacheDir, 'index.json');

  await printFileTail(logPath, 100);
  await printJsonFile(diagnosticsPath, 'diagnostics/latest-update.json');
  await printIndexCoverage(indexPath);
}

async function printFileTail(filePath, lineCount) {
  try {
    const contents = await fs.readFile(filePath, 'utf8');
    const lines = contents.trimEnd().split('\n');
    const tail = lines.slice(-lineCount).join('\n');
    console.error(`Last ${Math.min(lines.length, lineCount)} lines of ${filePath}:`);
    console.error(tail);
  } catch (error) {
    console.error(`No readable log tail at ${filePath}: ${error instanceof Error ? error.message : String(error)}`);
  }
}

async function printJsonFile(filePath, label) {
  try {
    const contents = await fs.readFile(filePath, 'utf8');
    const parsed = JSON.parse(contents);
    console.error(`${label}:`);
    console.error(JSON.stringify(parsed, null, 2));
  } catch (error) {
    console.error(`No readable ${label} at ${filePath}: ${error instanceof Error ? error.message : String(error)}`);
  }
}

async function printIndexCoverage(indexPath) {
  try {
    const raw = await fs.readFile(indexPath, 'utf8');
    const parsed = JSON.parse(raw);
    const index = IndexSchema.parse(parsed);
    console.error('coverageDiagnostics.routeCoverageSummary:');
    console.error(JSON.stringify(index.coverageDiagnostics.routeCoverageSummary, null, 2));
    if (index.coverageDiagnostics.routeCoverageSummary.problematicExamples.length > 0) {
      console.error('Problematic route coverage examples:');
      console.error(JSON.stringify(index.coverageDiagnostics.routeCoverageSummary.problematicExamples, null, 2));
    }
  } catch (error) {
    console.error(`No readable index coverage summary at ${indexPath}: ${error instanceof Error ? error.message : String(error)}`);
  }
}

await main();
