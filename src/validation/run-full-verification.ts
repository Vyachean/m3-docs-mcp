import { getDefaultCacheDir } from '../cache.js';
import type { CaptureRequiredRoutesLiveOptions, captureRequiredRoutes } from '../browser-oracle/capture-required-routes.js';
import { validateRawSnapshot } from './validate-raw-snapshot.js';
import { validateRouteGraph } from './validate-route-graph.js';
import { validateBrowserOracle } from './validate-browser-oracle.js';
import { validateStructuredGraph } from './validate-structured-graph.js';
import { validateRenderedOutput } from './validate-rendered-output.js';
import { validateSearchIndex } from './validate-search-index.js';
import { validateCoverageSummary, type CoverageMode } from './validate-coverage-summary.js';
import type { CheckResult } from './types.js';

/**
 * Orchestrates the documented stage 1-7 `verify:cache:full` / `verify:cache:smoke` check pipeline
 * in the exact required order, stopping at the first hard failure (fail fast, preserve
 * diagnostics — see AGENTS.md / the stage 8 dispatch). Each stage is implemented as an
 * independently unit-testable `validate-*.ts` module; this module only sequences them and decides
 * when to stop early.
 *
 * Order (matches scripts/verify-full-cache-refresh.mjs's documented stage list):
 *   1. raw-snapshot       (validate-raw-snapshot.ts)
 *   2. route-graph        (validate-route-graph.ts)
 *   3. browser-oracle     (validate-browser-oracle.ts) — best-effort; see module doc
 *   4. structured-graph   (validate-structured-graph.ts)
 *   5. rendered-output    (validate-rendered-output.ts)
 *   6. search-index       (validate-search-index.ts)
 *   7. coverage-summary   (validate-coverage-summary.ts)
 *
 * Stage 3 (browser-oracle) is the one stage that may legitimately report `passed: true` with
 * `details.skipped: true` when no live browser/network is available. Stages 2 and 4's
 * fixed-required-route checks are full-mode only (smoke intentionally crawls a small page-budget
 * subset not guaranteed to include every required route); every other check in every stage is
 * enforced unconditionally regardless of mode. See `RunFullVerificationOptions.mode`.
 */

export type RunFullVerificationOptions = {
  cacheDir?: string;
  mode?: CoverageMode;
  /** Forwarded to validateBrowserOracle. Set `skipBrowserOracle: true` to bypass stage 3 entirely
   *  (still recorded as a `skipped` pass, not silently omitted from `results`) — useful for CI
   *  environments that intentionally never run a live browser. */
  skipBrowserOracle?: boolean;
  browserOracleCaptureOptions?: CaptureRequiredRoutesLiveOptions;
  browserOracleCaptureFn?: typeof captureRequiredRoutes;
  /** Forwarded to validateSearchIndex. Lets tests/CI inject a fake store or a reduced query list
   *  instead of building a real MaterialDocsStore against the cache dir. */
  searchIndexQueries?: readonly string[];
  searchIndexStore?: { searchDocs: (query: string, limit?: number) => Promise<unknown[]> };
};

export type RunFullVerificationResult = {
  /** All stage results in execution order, including the stage that ultimately failed (if any) —
   *  later stages that were never reached are simply absent, not present with a placeholder. */
  results: CheckResult[];
  /** True only when every executed stage passed. */
  allPassed: boolean;
  /** The stage name of the first failure, or null when allPassed is true. */
  firstFailedStage: string | null;
};

export async function runFullVerification(options: RunFullVerificationOptions = {}): Promise<RunFullVerificationResult> {
  const cacheDir = options.cacheDir ?? getDefaultCacheDir();
  const mode = options.mode ?? 'full';
  const results: CheckResult[] = [];

  const stage1 = await validateRawSnapshot({ cacheDir });
  results.push(stage1);
  if (!stage1.passed) return finish(results);

  // Smoke runs intentionally crawl a small page-budget subset (e.g. --max-pages 40) that is not
  // guaranteed to include every fixed required route, so the required-route checks in stages 2
  // and 4 are full-mode only (mirrors the pre-existing script's assertRequiredPages, which was
  // already gated to `mode === 'full'`). Schema/structural validity of the graph itself is still
  // checked unconditionally via the empty requiredRoutes list.
  const requiredRoutesForMode = mode === 'full' ? undefined : [];

  const stage2 = await validateRouteGraph({ cacheDir, requiredRoutes: requiredRoutesForMode });
  results.push(stage2);
  if (!stage2.passed) return finish(results);

  if (options.skipBrowserOracle) {
    results.push({
      stage: 'browser-oracle',
      passed: true,
      reasons: ['Browser oracle explicitly skipped via skipBrowserOracle option.'],
      details: { skipped: true, skipReason: 'explicitly-skipped' },
    });
  } else {
    const stage3 = await validateBrowserOracle({
      cacheDir,
      captureOptions: options.browserOracleCaptureOptions,
      captureRequiredRoutesFn: options.browserOracleCaptureFn,
    });
    results.push(stage3);
    if (!stage3.passed) return finish(results);
  }

  const stage4 = await validateStructuredGraph({ cacheDir, requiredRoutes: requiredRoutesForMode });
  results.push(stage4);
  if (!stage4.passed) return finish(results);

  const stage5 = await validateRenderedOutput({ cacheDir, mode });
  results.push(stage5);
  if (!stage5.passed) return finish(results);

  const stage6 = await validateSearchIndex({
    cacheDir,
    queries: options.searchIndexQueries,
    store: options.searchIndexStore,
  });
  results.push(stage6);
  if (!stage6.passed) return finish(results);

  const stage7 = await validateCoverageSummary({ cacheDir, mode });
  results.push(stage7);
  return finish(results);
}

function finish(results: CheckResult[]): RunFullVerificationResult {
  const firstFailed = results.find((result) => !result.passed) ?? null;
  return {
    results,
    allPassed: firstFailed === null,
    firstFailedStage: firstFailed?.stage ?? null,
  };
}
