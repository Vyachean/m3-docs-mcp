import type { RouteGraph } from '../graph/graph-types.js';
import type { CoverageDiagnostics, PublicDocsClassification, RouteReconciliationStatus, RoutePlanEntry, RoutePlanSummary } from '../types.js';

export type RejectedRouteEntry = {
  route: string;
  navTitle: string | null;
  reconciliationStatus: RouteReconciliationStatus;
  publicDocsClassification: PublicDocsClassification;
  skippedReason: string | null;
  failureReason: string | null;
  disposition: 'unclassified';
};

export type StalePublicDocsRouteSource = 'routePlanSummary' | 'coverageDiagnostics.fullRoutePlanSummary' | 'unavailable';

export type RejectedRoutesSummary = {
  schemaVersion: 1;
  generatedAt: string;
  stalePublicDocsRouteCount: number;
  /** Which data source was used to compute stalePublicDocsRouteCount.
   *  "unavailable" means neither routePlanSummary nor coverageDiagnostics.fullRoutePlanSummary
   *  was supplied — the count of 0 is not authoritative in that case. */
  stalePublicDocsRouteSource: StalePublicDocsRouteSource;
  policySkippedRouteCount: number;
  nonContentRouteCount: number;
  stalePublicDocsRoutes: RejectedRouteEntry[];
};

function toRejectedRouteEntry(entry: RoutePlanEntry): RejectedRouteEntry {
  return {
    route: entry.route,
    navTitle: entry.navTitle ?? null,
    reconciliationStatus: entry.reconciliationStatus,
    publicDocsClassification: entry.publicDocsClassification,
    skippedReason: entry.skippedReason ?? null,
    failureReason: entry.failureReason ?? null,
    disposition: 'unclassified',
  };
}

export function buildRejectedRoutesSummary(params: {
  routePlanSummary?: RoutePlanSummary | null;
  coverageDiagnostics?: CoverageDiagnostics | null;
  routeGraph?: RouteGraph | null;
  generatedAt?: string;
}): RejectedRoutesSummary {
  const { routePlanSummary, coverageDiagnostics, routeGraph, generatedAt = new Date().toISOString() } = params;

  // Prefer the explicit routePlanSummary; fall back to coverageDiagnostics.fullRoutePlanSummary
  // so callers that only pass coverageDiagnostics still get a non-zero stale count when available.
  let effectiveRoutePlanSummary: RoutePlanSummary | null = null;
  let stalePublicDocsRouteSource: StalePublicDocsRouteSource = 'unavailable';
  if (routePlanSummary != null) {
    effectiveRoutePlanSummary = routePlanSummary;
    stalePublicDocsRouteSource = 'routePlanSummary';
  } else if (coverageDiagnostics?.fullRoutePlanSummary != null) {
    effectiveRoutePlanSummary = coverageDiagnostics.fullRoutePlanSummary;
    stalePublicDocsRouteSource = 'coverageDiagnostics.fullRoutePlanSummary';
  }

  const stalePublicDocsRoutes: RejectedRouteEntry[] = (effectiveRoutePlanSummary?.staleRoutes ?? [])
    .filter((entry) => entry.publicDocsClassification === 'public-docs')
    .map(toRejectedRouteEntry);

  const policySkippedRouteCount = coverageDiagnostics?.skippedByPolicyCount ?? 0;

  let nonContentRouteCount = 0;
  if (routeGraph) {
    // Optional chaining guards against partially malformed graph entries that lack coverage.
    nonContentRouteCount = routeGraph.routes.filter((r) => r.coverage?.status === 'nonContent').length;
  } else if (effectiveRoutePlanSummary) {
    nonContentRouteCount = [...effectiveRoutePlanSummary.staleRoutes, ...effectiveRoutePlanSummary.nonPublicRoutes].filter(
      (entry) => entry.publicDocsClassification === 'non-content-index',
    ).length;
  }

  return {
    schemaVersion: 1,
    generatedAt,
    stalePublicDocsRouteCount: stalePublicDocsRoutes.length,
    stalePublicDocsRouteSource,
    policySkippedRouteCount,
    nonContentRouteCount,
    stalePublicDocsRoutes,
  };
}
