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
    routeCoverageSummary: RouteCoverageSummarySchema,
    routeCoverage: z.array(ProblematicExampleSchema.extend({
      expectedOutputPaths: z.array(z.string()).default([]),
      savedOutputPaths: z.array(z.string()).default([]),
      failedOutputPaths: z.array(z.string()).default([]),
      skippedOutputPaths: z.array(z.string()).default([])
    })).default([])
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
  if (mode === 'full') {
    await assertRequiredPages(tempCacheDir);
  }
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
  const failedStagingDir = `${tempCacheDir}.failed-staging`;
  const failedStagingIndexPath = path.join(failedStagingDir, 'index.json');

  await printFileTail(logPath, 100);
  await printDiagnosticsJson(diagnosticsPath);
  await printIndexCoverage(indexPath, 'temp cache index.json');
  await printIndexCoverage(failedStagingIndexPath, 'failed staging index.json');
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

async function printDiagnosticsJson(filePath) {
  try {
    const contents = await fs.readFile(filePath, 'utf8');
    const parsed = JSON.parse(contents);
    const summary = {
      promotionDecision: parsed.promotionDecision ?? null,
      reason: parsed.reason ?? null,
      lastPhase: parsed.lastPhase ?? null,
      isLimitedRun: parsed.isLimitedRun ?? null,
      discoveredPublicUrlCount: parsed.discoveredPublicUrlCount ?? null,
      resolvableSourceRouteCount: parsed.resolvableSourceRouteCount ?? null,
      selectedSourceRouteCount: parsed.selectedSourceRouteCount ?? null,
      attemptedSourceRouteCount: parsed.attemptedSourceRouteCount ?? null,
      plannedVirtualPageCount: parsed.plannedVirtualPageCount ?? null,
      savedVirtualPageCount: parsed.savedVirtualPageCount ?? null,
      failedVirtualPageCount: parsed.failedVirtualPageCount ?? null,
      directJsonAttemptedPageCount: parsed.directJsonAttemptedPageCount ?? null,
      browserAttemptedPageCount: parsed.browserAttemptedPageCount ?? null,
      latestProgress: parsed.latestProgress ?? null,
      dsdbConfigSource: parsed.dsdbConfigSource ?? null,
      directJsonEnabled: parsed.directJsonEnabled ?? null,
      browserOnlyFallback: parsed.browserOnlyFallback ?? null,
      networkRecoveryAttempted: parsed.networkRecoveryAttempted ?? null,
      networkRecoverySucceeded: parsed.networkRecoverySucceeded ?? null,
      networkRecoveryFailureReason: parsed.networkRecoveryFailureReason ?? null,
      coverageDiagnostics: parsed.coverageDiagnostics ? {
        coverageHealth: parsed.coverageDiagnostics.coverageHealth ?? null,
        coverageVerified: parsed.coverageDiagnostics.coverageVerified ?? null,
        coverageWarnings: parsed.coverageDiagnostics.coverageWarnings ?? [],
        discoveredPublicUrlCount: parsed.coverageDiagnostics.discoveredPublicUrlCount ?? null,
        uncrawledDiscoveredUrlCount: parsed.coverageDiagnostics.uncrawledDiscoveredUrlCount ?? null,
        skippedAliasOnlyCount: parsed.coverageDiagnostics.skippedAliasOnlyCount ?? null,
        skippedLegacyRouteCount: parsed.coverageDiagnostics.skippedLegacyRouteCount ?? null,
        skippedPlatformSpecificUnmappedCount: parsed.coverageDiagnostics.skippedPlatformSpecificUnmappedCount ?? null,
        skippedMissingPageReferenceCount: parsed.coverageDiagnostics.skippedMissingPageReferenceCount ?? null,
        skippedBlogCount: parsed.coverageDiagnostics.skippedBlogCount ?? null,
        resolvableSourceRouteCount: parsed.coverageDiagnostics.resolvableSourceRouteCount ?? null,
        unresolvedSourceRouteCount: parsed.coverageDiagnostics.unresolvedSourceRouteCount ?? null,
        selectedSourceRouteCount: parsed.coverageDiagnostics.selectedSourceRouteCount ?? null,
        attemptedSourceRouteCount: parsed.coverageDiagnostics.attemptedSourceRouteCount ?? null,
        plannedVirtualPageCount: parsed.coverageDiagnostics.plannedVirtualPageCount ?? null,
        savedVirtualPageCount: parsed.coverageDiagnostics.savedVirtualPageCount ?? null,
        failedVirtualPageCount: parsed.coverageDiagnostics.failedVirtualPageCount ?? null,
        routeCoverageSummary: parsed.coverageDiagnostics.routeCoverageSummary ?? null
      } : null,
      qualityReport: parsed.qualityReport ? {
        suspiciousPages: parsed.qualityReport.suspiciousPages ?? [],
        rejectedRoutes: parsed.qualityReport.rejectedRoutes ?? [],
        duplicateContent: parsed.qualityReport.duplicateContent ?? [],
        shortPages: parsed.qualityReport.shortPages ?? [],
        duplicateTitles: parsed.qualityReport.duplicateTitles ?? []
      } : null
    };
    console.error('diagnostics/latest-update.json summary:');
    console.error(JSON.stringify(summary, null, 2));
  } catch (error) {
    console.error(`No readable diagnostics/latest-update.json at ${filePath}: ${error instanceof Error ? error.message : String(error)}`);
  }
}

async function printIndexCoverage(indexPath, label) {
  try {
    const raw = await fs.readFile(indexPath, 'utf8');
    const parsed = JSON.parse(raw);
    const index = IndexSchema.parse(parsed);
    console.error(`${label} coverageDiagnostics.routeCoverageSummary:`);
    console.error(JSON.stringify(index.coverageDiagnostics.routeCoverageSummary, null, 2));
    if (index.coverageDiagnostics.routeCoverageSummary.problematicExamples.length > 0) {
      console.error(`${label} problematic route coverage examples:`);
      console.error(JSON.stringify(index.coverageDiagnostics.routeCoverageSummary.problematicExamples, null, 2));
    }
    const groupedFailureReasons = groupFailureReasons(index.coverageDiagnostics.routeCoverage ?? []);
    if (Object.keys(groupedFailureReasons).length > 0) {
      console.error(`${label} failed route diagnostics grouped by fallback reason:`);
      console.error(JSON.stringify(groupedFailureReasons, null, 2));
    }
  } catch (error) {
    console.error(`No readable ${label} coverage summary at ${indexPath}: ${error instanceof Error ? error.message : String(error)}`);
  }
}

function groupFailureReasons(routeCoverage) {
  const groups = {};
  for (const entry of routeCoverage) {
    if (entry.status === 'covered') continue;
    const reasons = Array.isArray(entry.failureReasons) && entry.failureReasons.length > 0
      ? entry.failureReasons
      : ['unknown'];
    for (const reason of reasons) {
      if (!groups[reason]) {
        groups[reason] = [];
      }
      if (groups[reason].length < 5) {
        groups[reason].push({
          sourceRoute: entry.sourceRoute,
          canonicalRoute: entry.canonicalRoute,
          status: entry.status,
          expectedOutputPaths: entry.expectedOutputPaths?.slice(0, 3) ?? [],
          savedOutputPaths: entry.savedOutputPaths?.slice(0, 3) ?? [],
          failedOutputPaths: entry.failedOutputPaths?.slice(0, 3) ?? [],
          skippedOutputPaths: entry.skippedOutputPaths?.slice(0, 3) ?? []
        });
      }
    }
  }
  return groups;
}

await main();
