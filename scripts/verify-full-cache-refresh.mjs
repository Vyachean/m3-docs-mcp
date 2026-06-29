#!/usr/bin/env node
import { spawn } from 'node:child_process';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { runFullVerification } from '../dist/validation/run-full-verification.js';

/**
 * Runs the documented 1-7 ordered verification pipeline (src/validation/run-full-verification.ts)
 * against a freshly-crawled cache built by the built CLI's `update` command.
 *
 * Order (each stage implemented as an independently unit-tested src/validation/*.ts module):
 *   1. raw-snapshot      — site shell / site_meta / Angular bundle / carbonVersion present+hashed
 *   2. route-graph        — no missing artifacts / no ambiguous-unresolved required routes
 *   3. browser-oracle     — live Playwright capture vs. raw snapshot/graph (best-effort, logged)
 *   4. structured-graph   — no unresolved required DSDB/token/status resources, no unknown chunks
 *   5. rendered-output    — renderer-report requiredRouteFailures empty, no token placeholders,
 *                           required generated pages present on disk
 *   6. search-index       — MaterialDocsStore.searchDocs smoke proxy (no persisted index file
 *                           exists in this repo yet — see validate-search-index.ts module doc)
 *   7. coverage-summary   — coverageDiagnostics.coverageHealth + zero problematic route counts
 *
 * This script's job is solely to: run the built CLI into a fresh temp cache dir, call
 * runFullVerification in order, and turn the result into clear console diagnostics + a process
 * exit code. It deliberately does NOT promote the temp cache dir over any existing production
 * cache — `update`'s own internal promotion logic (assertSafeCachePromotion/promoteStagingCache
 * in src/cache.ts) already enforces "don't promote partial over good" at the CLI level, and this
 * script only ever targets a disposable --cache-dir tempCacheDir. Failed runs intentionally keep
 * the temp cache dir on disk for inspection (never deleted on failure).
 */

async function main() {
  const mode = process.argv.includes('--smoke') ? 'smoke' : 'full';
  const skipBrowserOracle = process.argv.includes('--skip-browser-oracle');
  const tempCacheDir = await fs.mkdtemp(path.join(os.tmpdir(), 'm3-docs-cache-verify-'));
  let keepTempDir = true;

  let cliExitCode = null;

  try {
    cliExitCode = await runBuiltCli(tempCacheDir, mode);
    if (cliExitCode !== 0) {
      throw new Error(`Built CLI exited with code ${cliExitCode}.`);
    }

    const verification = await runFullVerification({
      cacheDir: tempCacheDir,
      mode,
      skipBrowserOracle,
    });

    printStageResults(mode, verification.results);

    if (!verification.allPassed) {
      throw new Error(`Verification stage "${verification.firstFailedStage}" failed. See stage diagnostics above.`);
    }

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

function printStageResults(mode, results) {
  for (const result of results) {
    const skipped = result.details?.skipped === true;
    const label = skipped ? 'SKIPPED' : result.passed ? 'PASS' : 'FAIL';
    console.error(`[verify:cache:${mode}] [${label}] stage=${result.stage}`);
    for (const reason of result.reasons) {
      console.error(`[verify:cache:${mode}]   - ${reason}`);
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
    '6',
    // tempCacheDir is always brand new, so without this flag crawlMaterialDocs' first-cache
    // partial-promotion safeguard skips promotion entirely on a limited/smoke run (no
    // index.json/manifest.json/graph written at all), leaving nothing for the stages below to
    // validate. See src/crawler.ts shouldSkipInitialPartialPromotion.
    '--promote-partial'
  ];

  if (mode === 'smoke') {
    args.push('--max-pages', '40', '--min-pages', '20');
  } else {
    args.push('--min-pages', '150', '--strict-graph');
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
    const coverageDiagnostics = parsed.coverageDiagnostics ?? {};
    const routeCoverageSummary = coverageDiagnostics.routeCoverageSummary ?? {};
    console.error(`${label} coverageDiagnostics.routeCoverageSummary:`);
    console.error(JSON.stringify(routeCoverageSummary, null, 2));
    if ((routeCoverageSummary.problematicExamples ?? []).length > 0) {
      console.error(`${label} problematic route coverage examples:`);
      console.error(JSON.stringify(routeCoverageSummary.problematicExamples, null, 2));
    }
    const groupedFailureReasons = groupFailureReasons(coverageDiagnostics.routeCoverage ?? []);
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
