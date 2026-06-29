import { getDefaultCacheDir } from '../cache.js';
import { captureRequiredRoutes, type CaptureRequiredRoutesLiveOptions } from '../browser-oracle/capture-required-routes.js';
import { compareCaptureToSnapshot } from '../browser-oracle/compare-capture-to-snapshot.js';
import { writeBrowserOracleComparison, writeRequiredRoutesCapture } from '../browser-oracle/browser-oracle-store.js';
import { failedCheck, passedCheck, type CheckResult } from './types.js';

/**
 * Stage 3 of `verify:cache:full`: required browser oracle parity.
 *
 * Unlike stages 1/2/4/5/7 (which only read already-persisted JSON from the cache dir and are
 * always enforced), this check genuinely requires a live browser + live network access against
 * the real site — it launches Playwright (`captureRequiredRoutes`) and navigates the 8 required
 * routes.
 *
 * `strict` controls what happens when the capture itself throws (no Chromium binary, no network):
 * - `strict: false` (smoke / explicit degraded mode): returns a passing-shaped result with
 *   `skipped: true` in `details` and a reason recorded in `reasons` — never silently skipped,
 *   but not a hard failure either. Callers must check `details.skipped` and log it distinctly
 *   from a genuine pass.
 * - `strict: true` (the default, and what `verify:cache:full` uses): a capture failure is a real
 *   failure (`passed: false`) reported as external-blocked/not-ready, not a skip-as-pass. Browser
 *   oracle is a validation oracle, not the production crawler, but full verification must not
 *   silently downgrade "we couldn't check" into "it's fine."
 *
 * When the capture *does* succeed, `compareCaptureToSnapshot`'s `allPassed` is the unconditional
 * pass/fail signal — a captured browser resource missing from the raw snapshot, a rendered
 * heading missing from the page graph, or a visible token/status table the graph never resolved
 * are all hard failures here, matching the spec's "browser-captured resources missing from raw
 * snapshot" / "required rendered headings missing" failure conditions.
 */

export type ValidateBrowserOracleInput = {
  cacheDir?: string;
  captureOptions?: CaptureRequiredRoutesLiveOptions;
  /** Injected for tests: bypasses the real captureRequiredRoutes (which launches a real browser). */
  captureRequiredRoutesFn?: typeof captureRequiredRoutes;
  /** When true (the default), a capture failure (no Chromium/network) fails this stage instead of
   *  being reported as a skipped pass. Set false only for smoke/explicit degraded runs. */
  strict?: boolean;
};

export async function validateBrowserOracle(input: ValidateBrowserOracleInput = {}): Promise<CheckResult> {
  const cacheDir = input.cacheDir ?? getDefaultCacheDir();
  const stage = 'browser-oracle';
  const captureFn = input.captureRequiredRoutesFn ?? captureRequiredRoutes;
  const strict = input.strict ?? true;

  let capture;
  try {
    capture = await captureFn(input.captureOptions);
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error);
    if (strict) {
      return failedCheck(
        stage,
        [`Browser oracle is external-blocked/not-ready: no live browser/network available (${reason}). Full verification requires a real browser-oracle pass.`],
        { skipped: true, skipReason: reason, strict: true }
      );
    }
    return {
      stage,
      passed: true,
      reasons: [`Browser oracle capture skipped: no live browser/network available (${reason}).`],
      details: { skipped: true, skipReason: reason, strict: false },
    };
  }

  await writeRequiredRoutesCapture(capture, cacheDir);
  const comparison = await compareCaptureToSnapshot({ capture, cacheDir });
  await writeBrowserOracleComparison(comparison, cacheDir);

  if (!comparison.allPassed) {
    const reasons = comparison.routes
      .filter((route) => !route.passed)
      .map((route) => {
        if (route.captureFailed) return `${route.route}: browser navigation failed (${route.navigationError ?? 'unknown error'}).`;
        const parts: string[] = [];
        if (route.missingFromRawSnapshot.length > 0) parts.push(`missing from raw snapshot: ${route.missingFromRawSnapshot.join(', ')}`);
        if (route.missingHeadings.length > 0) parts.push(`missing headings: ${route.missingHeadings.join(', ')}`);
        if (route.unresolvedVisibleTables.length > 0) parts.push(`unresolved visible tables: ${route.unresolvedVisibleTables.join(', ')}`);
        return `${route.route}: ${parts.join('; ')}`;
      });
    return failedCheck(stage, reasons, { skipped: false, failedRoutes: comparison.failedRoutes });
  }

  return passedCheck(stage, { skipped: false, routeCount: comparison.routes.length });
}
