/**
 * Shared result shape for cache verification checks (stage 8 of the raw-snapshot-first cache
 * architecture). Each `src/validation/validate-*.ts` module exposes one or more pure functions
 * that take a cache directory (plus check-specific inputs) and return a `CheckResult` — never
 * throw for an expected validation failure, and never perform process-level side effects
 * (no `process.exit`, no console logging). `scripts/verify-full-cache-refresh.mjs` is the only
 * place that turns a `CheckResult` into console output / a process exit code, so these functions
 * stay easily unit-testable against fixture cache dirs.
 *
 * `reasons` is always populated when `passed` is false, with enough detail to point at the
 * specific missing artifact/route/resource — never a bare boolean with no explanation, per the
 * "fail fast, preserve diagnostics" requirement.
 */

export type CheckResult = {
  /** Stable identifier for this check stage, e.g. "raw-snapshot", "route-graph". Matches the
   *  ordered stage names documented in scripts/verify-full-cache-refresh.mjs. */
  stage: string;
  passed: boolean;
  /** Human-readable failure reasons. Empty when passed is true. */
  reasons: string[];
  /** Optional structured details for diagnostics printing (kept loose/unknown-shaped — callers
   *  treat this as opaque diagnostic payload, not a typed contract). */
  details?: Record<string, unknown>;
};

export function passedCheck(stage: string, details?: Record<string, unknown>): CheckResult {
  return { stage, passed: true, reasons: [], ...(details ? { details } : {}) };
}

export function failedCheck(stage: string, reasons: string[], details?: Record<string, unknown>): CheckResult {
  return { stage, passed: false, reasons, ...(details ? { details } : {}) };
}
