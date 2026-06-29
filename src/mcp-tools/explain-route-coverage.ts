import type { RouteCoverageInfo, RouteGraphCoverageStatus, RouteNode } from '../graph/graph-types.js';
import { normalizeRouteInput, routeGraphAvailability, type GraphToolContext } from './context.js';

/** Resolves a normalized route to its RouteNode, preferring an exact `route` match over a
 *  canonicalRoute/alias match — a route can legitimately be both another node's alias and its own
 *  independent node (see route-graph.ts's aliasOnly nuance), so exact identity must win. */
function findRouteNode(routes: RouteNode[], normalizedRoute: string): RouteNode | null {
  const exact = routes.find((entry) => entry.route === normalizedRoute);
  if (exact) return exact;
  return routes.find((entry) => entry.canonicalRoute === normalizedRoute || entry.aliases.includes(normalizedRoute)) ?? null;
}

export type SharedCoverageGroupMember = {
  route: string;
  originalStatus: RouteGraphCoverageStatus;
};

export type ExplainRouteCoverageResult = {
  available: boolean;
  message: string | null;
  found: boolean;
  route: string;
  canonicalRoute: string | null;
  status: RouteGraphCoverageStatus | null;
  originalStatus: RouteGraphCoverageStatus | null;
  reasons: string[];
  sharedCoverageGroup: string | null;
  sharedCoverageGroupMembers: SharedCoverageGroupMember[];
  expectedOutputPaths: string[];
  savedOutputPaths: string[];
  failedOutputPaths: string[];
  skippedOutputPaths: string[];
  explanation: string;
};

function buildExplanation(coverage: RouteCoverageInfo, route: string): string {
  if (coverage.status === coverage.originalStatus) {
    return `Route "${route}" has coverage status "${coverage.status}"${coverage.reasons.length > 0 ? `: ${coverage.reasons.join('; ')}` : '.'}`;
  }
  if (coverage.originalStatus === 'aliasOnly') {
    return (
      `Route "${route}" itself never independently produced saved output (originalStatus would be ` +
      `"unresolved" on its own), but it shares a coverage group with ${coverage.sharedWithRoutes.join(', ') || 'another route'} ` +
      `whose output was saved, so the shared/group status is "${coverage.status}".`
    );
  }
  return (
    `Route "${route}" has its own status "${coverage.originalStatus}" before shared-coverage-group reconciliation, ` +
    `but the reported/group status is "${coverage.status}" because it shares a coverage group with ` +
    `${coverage.sharedWithRoutes.join(', ') || 'another route'}.`
  );
}

/**
 * Explains why a route has its current coverage status: reasons, shared coverage group members,
 * original per-route status, and any policy-skip reason — without the caller needing to re-derive
 * this from raw diagnostics. See route-graph.ts's module doc for the status/originalStatus nuance
 * this surfaces directly (a shared/group status can differ from what this specific source route
 * achieved on its own).
 */
export function explainRouteCoverage(context: GraphToolContext, route: string): ExplainRouteCoverageResult {
  const availability = routeGraphAvailability(context);
  const normalizedRoute = normalizeRouteInput(route);
  if (!availability.available || !context.routeGraph) {
    return {
      available: false,
      message: availability.message,
      found: false,
      route: normalizedRoute,
      canonicalRoute: null,
      status: null,
      originalStatus: null,
      reasons: [],
      sharedCoverageGroup: null,
      sharedCoverageGroupMembers: [],
      expectedOutputPaths: [],
      savedOutputPaths: [],
      failedOutputPaths: [],
      skippedOutputPaths: [],
      explanation: '',
    };
  }

  const routeNode = findRouteNode(context.routeGraph.routes, normalizedRoute);
  if (!routeNode) {
    return {
      available: true,
      message: `Route not found: ${normalizedRoute}`,
      found: false,
      route: normalizedRoute,
      canonicalRoute: null,
      status: null,
      originalStatus: null,
      reasons: [],
      sharedCoverageGroup: null,
      sharedCoverageGroupMembers: [],
      expectedOutputPaths: [],
      savedOutputPaths: [],
      failedOutputPaths: [],
      skippedOutputPaths: [],
      explanation: '',
    };
  }

  const { coverage } = routeNode;
  const sharedCoverageGroupMembers: SharedCoverageGroupMember[] = coverage.sharedWithRoutes.map((sharedRoute) => {
    const sharedNode = context.routeGraph?.routes.find((entry) => entry.route === sharedRoute);
    return { route: sharedRoute, originalStatus: sharedNode?.coverage.originalStatus ?? coverage.status };
  });

  return {
    available: true,
    message: null,
    found: true,
    route: routeNode.route,
    canonicalRoute: routeNode.canonicalRoute,
    status: coverage.status,
    originalStatus: coverage.originalStatus,
    reasons: coverage.reasons,
    sharedCoverageGroup: coverage.sharedCoverageGroup,
    sharedCoverageGroupMembers,
    expectedOutputPaths: coverage.expectedOutputPaths,
    savedOutputPaths: coverage.savedOutputPaths,
    failedOutputPaths: coverage.failedOutputPaths,
    skippedOutputPaths: coverage.skippedOutputPaths,
    explanation: buildExplanation(coverage, routeNode.route),
  };
}
