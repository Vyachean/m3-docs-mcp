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

export type RejectedRoutesSummary = {
  schemaVersion: 1;
  generatedAt: string;
  stalePublicDocsRouteCount: number;
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

  const stalePublicDocsRoutes: RejectedRouteEntry[] = (routePlanSummary?.staleRoutes ?? [])
    .filter((entry) => entry.publicDocsClassification === 'public-docs')
    .map(toRejectedRouteEntry);

  const policySkippedRouteCount = coverageDiagnostics?.skippedByPolicyCount ?? 0;

  let nonContentRouteCount = 0;
  if (routeGraph) {
    nonContentRouteCount = routeGraph.routes.filter((r) => r.coverage.status === 'nonContent').length;
  } else if (routePlanSummary) {
    nonContentRouteCount = [...routePlanSummary.staleRoutes, ...routePlanSummary.nonPublicRoutes].filter(
      (entry) => entry.publicDocsClassification === 'non-content-index',
    ).length;
  }

  return {
    schemaVersion: 1,
    generatedAt,
    stalePublicDocsRouteCount: stalePublicDocsRoutes.length,
    policySkippedRouteCount,
    nonContentRouteCount,
    stalePublicDocsRoutes,
  };
}
