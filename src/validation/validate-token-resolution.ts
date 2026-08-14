import { getDefaultCacheDir } from '../cache.js';
import { readCacheDiagnosticsSummary, type CacheDiagnosticsSummary } from '../diagnostics/write-cache-diagnostics.js';
import { failedCheck, passedCheck, type CheckResult } from './types.js';

const BLOCKING_UNRESOLVED_REASONS = [
  'missing-alias-target',
  'missing-context-entry',
  'unsupported-value-type',
  'parser-bug',
  'unclassified',
] as const;

export function validateTokenResolutionSummary(summary: CacheDiagnosticsSummary | null): CheckResult {
  const stage = 'token-resolution';
  if (!summary?.unresolvedByReason) {
    return failedCheck(stage, ['Token-resolution diagnostics are missing or do not contain unresolvedByReason.']);
  }

  const blockingReasons = BLOCKING_UNRESOLVED_REASONS
    .map((reason) => ({ reason, cells: summary.unresolvedByReason?.[reason] ?? 0 }))
    .filter(({ cells }) => cells > 0);

  if (blockingReasons.length > 0) {
    return failedCheck(
      stage,
      blockingReasons.map(({ reason, cells }) => `${reason}: ${cells} unresolved token cell${cells === 1 ? '' : 's'}`),
      {
        unresolvedTokenRows: summary.unresolvedTokenRows,
        unresolvedTokenCells: summary.unresolvedTokenCells,
        unresolvedByReason: summary.unresolvedByReason,
      },
    );
  }

  return passedCheck(stage, {
    unresolvedTokenRows: summary.unresolvedTokenRows,
    unresolvedTokenCells: summary.unresolvedTokenCells,
    upstreamEmptyCells: summary.unresolvedByReason['upstream-empty'],
  });
}

export async function validateTokenResolution(input: { cacheDir?: string } = {}): Promise<CheckResult> {
  const cacheDir = input.cacheDir ?? getDefaultCacheDir();
  return validateTokenResolutionSummary(await readCacheDiagnosticsSummary(cacheDir));
}
