import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { z } from 'zod';
import { diagnosticsDir } from '../cache.js';
import type { UnresolvedByReason } from '../diagnostics/token-resolution-summary.js';

/** Known upstream gap as of 2026-06-30 production baseline. */
export const ALLOWED_UPSTREAM_EMPTY_TOKENS: readonly string[] = [
  'md.comp.search-bar.contained.motion.spring',
];
export const ALLOWED_UPSTREAM_EMPTY_CELLS = 2;
export const ALLOWED_UNRESOLVED_TOKEN_ROWS = 1;
export const ALLOWED_UNRESOLVED_CELL_COUNT = 2;

const ExampleSchema = z.object({
  token: z.string(),
  tokenTableId: z.string(),
  column: z.string(),
  unresolvedReason: z.string(),
}).passthrough();

const ByRouteSchema = z.object({
  route: z.string(),
  unresolvedTokenRows: z.number(),
  unresolvedCellCount: z.number(),
  examples: z.array(ExampleSchema).default([]),
}).passthrough();

const ByReasonSchema = z.object({
  'missing-alias-target': z.number().default(0),
  'missing-context-entry': z.number().default(0),
  'unsupported-value-type': z.number().default(0),
  'upstream-empty': z.number().default(0),
  'parser-bug': z.number().default(0),
  unclassified: z.number().default(0),
});

const TokenResolutionSummarySchema = z.object({
  unresolvedTokenRows: z.number().default(0),
  unresolvedCellCount: z.number().default(0),
  unresolvedByRoute: z.array(ByRouteSchema).default([]),
  unresolvedByReason: ByReasonSchema.default({
    'missing-alias-target': 0,
    'missing-context-entry': 0,
    'unsupported-value-type': 0,
    'upstream-empty': 0,
    'parser-bug': 0,
    unclassified: 0,
  }),
}).passthrough();

export type QualityFailure = {
  dimension: string;
  current: number;
  allowed: number;
  affectedRoutes: string[];
  tokenExamples: string[];
  diagnosticsPath: string;
};

export type TokenQualitySummary = {
  unresolvedTokenRows: number;
  unresolvedCellCount: number;
  unresolvedByReason: UnresolvedByReason;
  /** Upstream-empty token names found in examples (capped at example limit per route). */
  upstreamEmptyTokens: string[];
};

export type TokenQualityGateResult = {
  qualityPassed: boolean;
  tokenQuality: TokenQualitySummary | null;
  qualityFailures: QualityFailure[];
};

export function tokenResolutionDiagnosticsPath(cacheDir: string): string {
  return path.join(diagnosticsDir(cacheDir), 'token-resolution-summary.json');
}

function routesAffectedByReason(
  byRoute: z.infer<typeof ByRouteSchema>[],
  reason: string,
): string[] {
  return byRoute
    .filter((r) => r.examples.some((e) => e.unresolvedReason === reason))
    .map((r) => r.route)
    .slice(0, 5);
}

function tokenExamplesForReason(
  byRoute: z.infer<typeof ByRouteSchema>[],
  reason: string,
): string[] {
  const seen = new Set<string>();
  for (const r of byRoute) {
    for (const e of r.examples) {
      if (e.unresolvedReason === reason) seen.add(e.token);
      if (seen.size >= 3) return Array.from(seen);
    }
  }
  return Array.from(seen);
}

/** Reads the token-resolution-summary.json and evaluates strict quality gates. Returns a result
 *  with qualityPassed=true and tokenQuality=null when the diagnostics file is absent or invalid
 *  (non-blocking — strict quality requires the file to exist; absence is reported as a separate
 *  failure in that caller's context). */
export async function checkTokenQuality(cacheDir: string): Promise<TokenQualityGateResult> {
  const filePath = tokenResolutionDiagnosticsPath(cacheDir);

  let raw: unknown;
  try {
    raw = JSON.parse(await readFile(filePath, 'utf8'));
  } catch {
    return { qualityPassed: true, tokenQuality: null, qualityFailures: [] };
  }

  const parsed = TokenResolutionSummarySchema.safeParse(raw);
  if (!parsed.success) {
    return { qualityPassed: true, tokenQuality: null, qualityFailures: [] };
  }

  const summary = parsed.data;
  const byReason = summary.unresolvedByReason as UnresolvedByReason;
  const byRoute = summary.unresolvedByRoute;

  const upstreamEmptyTokens = Array.from(
    new Set(
      byRoute.flatMap((r) =>
        r.examples
          .filter((e) => e.unresolvedReason === 'upstream-empty')
          .map((e) => e.token),
      ),
    ),
  );

  const tokenQuality: TokenQualitySummary = {
    unresolvedTokenRows: summary.unresolvedTokenRows,
    unresolvedCellCount: summary.unresolvedCellCount,
    unresolvedByReason: byReason,
    upstreamEmptyTokens,
  };

  const qualityFailures: QualityFailure[] = [];

  // Zero-tolerance reasons
  const zeroToleranceReasons: (keyof UnresolvedByReason)[] = [
    'unsupported-value-type',
    'unclassified',
    'parser-bug',
    'missing-alias-target',
    'missing-context-entry',
  ];

  for (const reason of zeroToleranceReasons) {
    const count = byReason[reason];
    if (count > 0) {
      qualityFailures.push({
        dimension: `unresolvedByReason.${reason}`,
        current: count,
        allowed: 0,
        affectedRoutes: routesAffectedByReason(byRoute, reason),
        tokenExamples: tokenExamplesForReason(byRoute, reason),
        diagnosticsPath: filePath,
      });
    }
  }

  // upstream-empty count gate
  if (byReason['upstream-empty'] > ALLOWED_UPSTREAM_EMPTY_CELLS) {
    qualityFailures.push({
      dimension: 'unresolvedByReason.upstream-empty',
      current: byReason['upstream-empty'],
      allowed: ALLOWED_UPSTREAM_EMPTY_CELLS,
      affectedRoutes: routesAffectedByReason(byRoute, 'upstream-empty'),
      tokenExamples: tokenExamplesForReason(byRoute, 'upstream-empty'),
      diagnosticsPath: filePath,
    });
  } else if (byReason['upstream-empty'] > 0) {
    // Count within limit — verify every token is in the known allowlist
    const unknownTokens = upstreamEmptyTokens.filter(
      (t) => !ALLOWED_UPSTREAM_EMPTY_TOKENS.includes(t),
    );
    if (unknownTokens.length > 0) {
      qualityFailures.push({
        dimension: 'unresolvedByReason.upstream-empty (unrecognized token)',
        current: unknownTokens.length,
        allowed: 0,
        affectedRoutes: routesAffectedByReason(byRoute, 'upstream-empty'),
        tokenExamples: unknownTokens.slice(0, 3),
        diagnosticsPath: filePath,
      });
    }
  }

  // Total unresolved row/cell gates
  if (summary.unresolvedTokenRows > ALLOWED_UNRESOLVED_TOKEN_ROWS) {
    const examples = byRoute.slice(0, 3).flatMap((r) => r.examples.map((e) => e.token)).slice(0, 3);
    qualityFailures.push({
      dimension: 'unresolvedTokenRows',
      current: summary.unresolvedTokenRows,
      allowed: ALLOWED_UNRESOLVED_TOKEN_ROWS,
      affectedRoutes: byRoute.slice(0, 5).map((r) => r.route),
      tokenExamples: examples,
      diagnosticsPath: filePath,
    });
  }

  if (summary.unresolvedCellCount > ALLOWED_UNRESOLVED_CELL_COUNT) {
    const examples = byRoute.slice(0, 3).flatMap((r) => r.examples.map((e) => e.token)).slice(0, 3);
    qualityFailures.push({
      dimension: 'unresolvedCellCount',
      current: summary.unresolvedCellCount,
      allowed: ALLOWED_UNRESOLVED_CELL_COUNT,
      affectedRoutes: byRoute.slice(0, 5).map((r) => r.route),
      tokenExamples: examples,
      diagnosticsPath: filePath,
    });
  }

  return {
    qualityPassed: qualityFailures.length === 0,
    tokenQuality,
    qualityFailures,
  };
}
