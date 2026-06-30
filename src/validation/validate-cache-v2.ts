import { getDefaultCacheDir } from '../cache.js';
import { readManifest, type ManifestHealthSummary } from '../manifest.js';
import { readArtifactIndex } from '../raw-artifacts/artifact-index.js';
import { readPageGraph, readResourceGraph, readRouteGraph, readTokenTableGraph } from '../graph/graph-store.js';
import { readCacheDiagnosticsSummary, type CacheDiagnosticsSummary } from '../diagnostics/write-cache-diagnostics.js';
import { validateCacheFiles } from './validate-cache-files.js';
import { validateManifestHealth } from './validate-manifest-health.js';
import { validateArtifactIndex } from './validate-artifact-index.js';
import { validateGraphFiles } from './validate-graph-files.js';
import { validateRouteGraph } from './validate-route-graph.js';
import { validateStructuredGraph } from './validate-structured-graph.js';
import { validateRenderedOutput, type ValidateRenderedOutputInput } from './validate-rendered-output.js';
import { validateCoverageSummary } from './validate-coverage-summary.js';
import { validateMcpSmoke } from './validate-mcp-smoke.js';
import type { CheckResult } from './types.js';

/**
 * The single official, schema-aware cache v2 validator (`m3-docs-mcp validate-cache`).
 *
 * Per AGENTS.md / the task this implements: `m3-docs-cache` must stop duplicating internal cache
 * schema assumptions in its own workflow (the cause of a real production incident — a verified,
 * `--strict-graph`-promoted cache was rejected downstream because the consuming repo's inline
 * validation assumed the wrong shape for `raw/artifact-index.json`). This module is the one place
 * that owns "what does a valid cache v2 snapshot look like" — it reuses the existing
 * graph-store/manifest/artifact-index readers and the existing `verify:cache:full` stage
 * functions (validate-route-graph.ts, validate-structured-graph.ts, validate-rendered-output.ts,
 * validate-coverage-summary.ts) rather than re-implementing any of their parsing/decoding logic.
 *
 * Unlike `runFullVerification` (run-full-verification.ts), which fails fast at the first failing
 * stage so an expensive live crawl can stop early, this validator runs every stage unconditionally
 * and collects every failure — each stage function already degrades gracefully (returns a
 * `failedCheck` instead of throwing) when its underlying file is missing/invalid, so there is no
 * risk of a crash cutting the report short, and a caller validating a possibly-broken cache wants
 * the full list of what's wrong in one pass, not just the first problem.
 */

export const REQUIRED_CACHE_VALIDATION_ROUTES: readonly string[] = [
  '/components/switch/specs',
  '/components/buttons/specs',
  '/components/lists/specs',
  '/components/segmented-buttons/specs',
];

export type ValidateCacheV2Input = {
  cacheDir?: string;
  requiredRoutes?: readonly string[];
  /** Forwarded to validateRenderedOutput. Lets tests inject a fake offline-rebuild function
   *  instead of running the real raw-snapshot-backed rebuild against fixture data. */
  renderedOutputRebuildFn?: ValidateRenderedOutputInput['rebuildFromRawFn'];
};

export type ValidateCacheV2Counts = {
  pages: number;
  routes: number;
  resources: number;
  tokenTables: number;
  rawArtifacts: number;
};

export type ValidateCacheV2Quality = {
  unresolvedTokenRows: number;
  unresolvedTokenCells: number;
  specPagesWithTokenTables: number;
  specPagesWithoutTokenTables: number;
  componentSpecPageCount: number;
  componentSpecPagesWithTokenTables: number;
  componentSpecPagesWithoutTokenTables: number;
  unclassifiedRejectedPublicDocsRoutes: number;
  stalePublicDocsRouteSource: import('../diagnostics/rejected-routes-summary.js').StalePublicDocsRouteSource;
};

export type ValidateCacheV2Result = {
  results: CheckResult[];
  allPassed: boolean;
  failedStages: string[];
  counts: ValidateCacheV2Counts;
  health: ManifestHealthSummary | null;
  quality?: ValidateCacheV2Quality;
};

export async function validateCacheV2(input: ValidateCacheV2Input = {}): Promise<ValidateCacheV2Result> {
  const cacheDir = input.cacheDir ?? getDefaultCacheDir();
  const requiredRoutes = input.requiredRoutes ?? REQUIRED_CACHE_VALIDATION_ROUTES;

  const results: CheckResult[] = await Promise.all([
    validateCacheFiles({ cacheDir }),
    validateManifestHealth({ cacheDir }),
    validateArtifactIndex({ cacheDir }),
    validateGraphFiles({ cacheDir }),
    validateRouteGraph({ cacheDir, requiredRoutes }),
    validateStructuredGraph({ cacheDir, requiredRoutes }),
    validateRenderedOutput({ cacheDir, mode: 'full', rebuildFromRawFn: input.renderedOutputRebuildFn }),
    validateCoverageSummary({ cacheDir, mode: 'full' }),
    validateMcpSmoke({ cacheDir, requiredRoutes }),
  ]);

  const [manifest, artifactIndex, routeGraph, pageGraph, resourceGraph, tokenTableGraph, diagSummary] = await Promise.all([
    readManifest(cacheDir),
    readArtifactIndex(cacheDir),
    readRouteGraph(cacheDir),
    readPageGraph(cacheDir),
    readResourceGraph(cacheDir),
    readTokenTableGraph(cacheDir),
    readCacheDiagnosticsSummary(cacheDir),
  ]);

  const failedStages = results.filter((result) => !result.passed).map((result) => result.stage);

  return {
    results,
    allPassed: failedStages.length === 0,
    failedStages,
    counts: {
      pages: pageGraph?.pages.length ?? 0,
      routes: routeGraph?.routes.length ?? 0,
      resources: resourceGraph?.resources.length ?? 0,
      tokenTables: tokenTableGraph?.tokenTables.length ?? 0,
      rawArtifacts: artifactIndex.artifacts.length,
    },
    health: manifest?.health ?? null,
    ...(diagSummary ? { quality: toQuality(diagSummary) } : {}),
  };
}

function toQuality(s: CacheDiagnosticsSummary): ValidateCacheV2Quality {
  return {
    unresolvedTokenRows: s.unresolvedTokenRows,
    unresolvedTokenCells: s.unresolvedTokenCells,
    specPagesWithTokenTables: s.specPagesWithTokenTables,
    specPagesWithoutTokenTables: s.specPagesWithoutTokenTables,
    componentSpecPageCount: s.componentSpecPageCount,
    componentSpecPagesWithTokenTables: s.componentSpecPagesWithTokenTables,
    componentSpecPagesWithoutTokenTables: s.componentSpecPagesWithoutTokenTables,
    unclassifiedRejectedPublicDocsRoutes: s.stalePublicDocsRoutes,
    stalePublicDocsRouteSource: s.stalePublicDocsRouteSource,
  };
}
