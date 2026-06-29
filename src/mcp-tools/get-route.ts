import type { RouteNode } from '../graph/graph-types.js';
import { normalizeRouteInput, routeGraphAvailability, type GraphToolContext } from './context.js';

export type GetRouteResult = {
  available: boolean;
  message: string | null;
  found: boolean;
  route: RouteNode | null;
};

function findRoute(routes: RouteNode[], normalizedRoute: string): RouteNode | null {
  const exact = routes.find((route) => route.route === normalizedRoute);
  if (exact) return exact;
  return routes.find((route) => route.canonicalRoute === normalizedRoute || route.aliases.includes(normalizedRoute)) ?? null;
}

/**
 * Route metadata: canonicalRoute, aliases, references (collectionId/documentId/
 * exportedCarbonFileId/pageCanonId/carbonVersion), tabs, source artifact ids, and coverage
 * (status + originalStatus + sharedCoverageGroup). Deliberately returns the full RouteNode shape
 * as-is — see route-graph.ts's doc comment on why `status` (shared/group coverage) and
 * `originalStatus` (this route's own pre-group-sharing status) must both be surfaced rather than
 * collapsed into one field.
 */
export function getRoute(context: GraphToolContext, route: string): GetRouteResult {
  const availability = routeGraphAvailability(context);
  if (!availability.available || !context.routeGraph) {
    return { available: false, message: availability.message, found: false, route: null };
  }

  const normalizedRoute = normalizeRouteInput(route);
  const found = findRoute(context.routeGraph.routes, normalizedRoute);
  if (!found) {
    return { available: true, message: `Route not found: ${normalizedRoute}`, found: false, route: null };
  }
  return { available: true, message: null, found: true, route: found };
}
