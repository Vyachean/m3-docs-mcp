import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { z } from 'zod';
import { getDefaultCacheDir, indexPath } from '../cache.js';
import { failedCheck, passedCheck, type CheckResult } from './types.js';

/**
 * Stage 7 of `verify:cache:full`: coverage summary.
 *
 * Reuses the coverage-health gate the original verify-full-cache-refresh.mjs already enforced
 * (read `index.json`, require `coverageDiagnostics.coverageHealth` to be "verified" for a full
 * run / "partial" or "verified" for a smoke run, and require zero failed/unresolved/partial route
 * counts on a full run) — this module doesn't weaken that existing check, just makes it
 * independently unit-testable and runnable in the documented stage order (last, after the raw
 * snapshot/graph/oracle/rendered-output checks have already passed).
 *
 * `index.json` is read here as `unknown` and validated through `IndexSchema` (zod), per AGENTS.md
 * — this mirrors the schema already used inline in the previous script version.
 */

const ProblematicExampleSchema = z.object({
  sourceRoute: z.string(),
  canonicalRoute: z.string(),
  status: z.string(),
  failureReasons: z.array(z.string()).default([]),
}).passthrough();

const RouteCoverageSummarySchema = z.object({
  failedRoutes: z.number().int().nonnegative(),
  unresolvedRoutes: z.number().int().nonnegative(),
  partialRoutes: z.number().int().nonnegative(),
  problematicExamples: z.array(ProblematicExampleSchema).default([]),
}).passthrough();

const IndexSchema = z.object({
  coverageDiagnostics: z.object({
    coverageHealth: z.string(),
    routeCoverageSummary: RouteCoverageSummarySchema,
    routeCoverage: z.array(ProblematicExampleSchema.extend({
      expectedOutputPaths: z.array(z.string()).default([]),
      savedOutputPaths: z.array(z.string()).default([]),
      failedOutputPaths: z.array(z.string()).default([]),
      skippedOutputPaths: z.array(z.string()).default([]),
    })).default([]),
  }).passthrough(),
}).passthrough();

export type CoverageMode = 'smoke' | 'full';

export type ValidateCoverageSummaryInput = {
  cacheDir?: string;
  mode?: CoverageMode;
};

export async function readVerifiedIndex(cacheDir: string): Promise<z.infer<typeof IndexSchema> | null> {
  try {
    const raw: unknown = JSON.parse(await readFile(indexPath(cacheDir), 'utf8'));
    const parsed = IndexSchema.safeParse(raw);
    return parsed.success ? parsed.data : null;
  } catch {
    return null;
  }
}

export async function validateCoverageSummary(input: ValidateCoverageSummaryInput = {}): Promise<CheckResult> {
  const cacheDir = input.cacheDir ?? getDefaultCacheDir();
  const mode = input.mode ?? 'full';
  const stage = 'coverage-summary';

  const index = await readVerifiedIndex(cacheDir);
  if (!index) {
    return failedCheck(stage, [`${path.join(cacheDir, 'index.json')} is missing or failed schema validation.`]);
  }

  const { coverageHealth, routeCoverageSummary } = index.coverageDiagnostics;
  const reasons: string[] = [];

  if (mode === 'smoke') {
    if (coverageHealth !== 'partial' && coverageHealth !== 'verified') {
      reasons.push(`Expected coverageDiagnostics.coverageHealth to be "partial" or "verified" for smoke, received ${JSON.stringify(coverageHealth)}.`);
    }
  } else {
    if (coverageHealth !== 'verified') {
      reasons.push(`Expected coverageDiagnostics.coverageHealth to be "verified" for full, received ${JSON.stringify(coverageHealth)}.`);
    }
    const failures = [
      ['failedRoutes', routeCoverageSummary.failedRoutes],
      ['unresolvedRoutes', routeCoverageSummary.unresolvedRoutes],
      ['partialRoutes', routeCoverageSummary.partialRoutes],
    ].filter(([, value]) => value !== 0);
    if (failures.length > 0) {
      const summary = failures.map(([key, value]) => `${key}=${value}`).join(', ');
      reasons.push(`Expected zero problematic route counts for full, received ${summary}.`);
    }
  }

  if (reasons.length > 0) {
    return failedCheck(stage, reasons, { coverageHealth, routeCoverageSummary });
  }

  return passedCheck(stage, { coverageHealth, routeCoverageSummary });
}
