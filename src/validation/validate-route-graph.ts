import { getDefaultCacheDir } from '../cache.js';
import { readRouteGraph } from '../graph/graph-store.js';
import type { RouteNode } from '../graph/graph-types.js';
import { REQUIRED_RENDERER_ROUTES } from '../rendered/renderer-report.js';
import { failedCheck, passedCheck, type CheckResult } from './types.js';

/**
 * Stage 2 of `verify:cache:full`: route/reference graph consistency.
 *
 * Reads `graph/routes.json` and checks, for each of the required routes (the same fixed set used
 * by the renderer report and browser oracle — `REQUIRED_RENDERER_ROUTES`):
 *  - the route resolves to exactly one RouteNode (not zero, not ambiguous/unresolved per
 *    `coverage.status`/`coverage.originalStatus`)
 *  - the resolved route node has at least one source artifact recorded (page-data or
 *    carbon-content), i.e. the route graph is not missing the raw artifact backing it.
 *
 * "Ambiguous"/"unresolved" here mirrors the RouteGraphCoverageStatus union in graph-types.ts:
 * `ambiguous` (reconciliation rejected the route as ambiguous against the bundle table) and
 * `unresolved` (no coverage entry / no expected output) are both hard failures for a required
 * route; `stale` is also treated as a hard failure since a required route must be live.
 */

function normalizeRouteKey(route: string): string {
  const trimmed = route.replace(/\.md$/i, '').trim();
  return `/${trimmed.replace(/^\/+/, '').replace(/\/+$/, '')}`;
}

/**
 * A required route like "/components/switch/specs" is usually a virtual tab page of a tabbed
 * parent route ("/components/switch"), represented in the graph as an entry in that parent
 * RouteNode's `tabs` array — not as its own first-class RouteNode with real coverage. Site_meta
 * route enumeration can *also* produce a separate, redundant literal RouteNode for that exact
 * path string with no reconciled identity (status "stale"), since it was never meant to be
 * resolved on its own. Tab matches take priority: they point at the node that actually carries
 * real coverage/source-artifact data for this required route, instead of an unrelated stale
 * duplicate that happens to share the same route string.
 */
/**
 * Multiple route-plan entries can legitimately share the same canonical identity and the same
 * (duplicated) tabs array — e.g. an accepted alias like "/components/switches" alongside the
 * canonical "/components/switch", both reconciling to the same content. That's the spec's "shared
 * alias coverage" pattern, not a real ambiguity, so collapse tab matches that share a
 * canonicalRoute down to one representative (preferring the node whose own .route IS that
 * canonicalRoute) before treating duplicate matches as a hard ambiguity failure.
 */
function dedupeBySharedCanonical(nodes: RouteNode[]): RouteNode[] {
  if (nodes.length <= 1) return nodes;
  const byCanonical = new Map<string, RouteNode[]>();
  for (const node of nodes) {
    const key = node.canonicalRoute ?? node.route;
    const group = byCanonical.get(key);
    if (group) group.push(node);
    else byCanonical.set(key, [node]);
  }
  return Array.from(byCanonical.values()).map((group) => {
    const base = group.find((node) => node.route === node.canonicalRoute) ?? group[0]!;
    if (group.length === 1) return base;
    // Raw artifacts for the same canonical content can be recorded under whichever alias/slug
    // was actually fetched (see lookupSourceArtifacts in graph/route-graph.ts) — a given node in
    // this group may legitimately carry the real provenance even when it isn't the one we picked
    // as the representative identity, so union sourceArtifacts across the whole group instead of
    // trusting only the representative node's own list.
    const seenArtifactIds = new Set<string>();
    const mergedSourceArtifacts = group.flatMap((node) => node.sourceArtifacts).filter((ref) => {
      if (seenArtifactIds.has(ref.artifactId)) return false;
      seenArtifactIds.add(ref.artifactId);
      return true;
    });
    return { ...base, sourceArtifacts: mergedSourceArtifacts };
  });
}

function findRouteNodes(routes: RouteNode[], required: string): RouteNode[] {
  const normalized = normalizeRouteKey(required);
  const tabMatches = routes.filter((node) => node.tabs.some((tab) => normalizeRouteKey(tab.route) === normalized));
  if (tabMatches.length > 0) return dedupeBySharedCanonical(tabMatches);
  return routes.filter((node) => {
    if (normalizeRouteKey(node.route) === normalized) return true;
    if (node.canonicalRoute && normalizeRouteKey(node.canonicalRoute) === normalized) return true;
    return node.aliases.some((alias) => normalizeRouteKey(alias) === normalized);
  });
}

const HARD_FAILURE_STATUSES = new Set(['ambiguous', 'unresolved', 'stale']);

export type ValidateRouteGraphInput = {
  cacheDir?: string;
  requiredRoutes?: readonly string[];
};

export async function validateRouteGraph(input: ValidateRouteGraphInput = {}): Promise<CheckResult> {
  const cacheDir = input.cacheDir ?? getDefaultCacheDir();
  const requiredRoutes = input.requiredRoutes ?? REQUIRED_RENDERER_ROUTES;
  const stage = 'route-graph';

  const routeGraph = await readRouteGraph(cacheDir);
  if (!routeGraph) {
    return failedCheck(stage, ['graph/routes.json is missing or failed schema validation.']);
  }

  const reasons: string[] = [];
  for (const required of requiredRoutes) {
    const matches = findRouteNodes(routeGraph.routes, required);
    if (matches.length === 0) {
      reasons.push(`Required route ${required} has no matching node in graph/routes.json.`);
      continue;
    }
    if (matches.length > 1) {
      reasons.push(`Required route ${required} matches ${matches.length} ambiguous nodes in graph/routes.json.`);
      continue;
    }
    const node = matches[0];
    if (HARD_FAILURE_STATUSES.has(node.coverage.status) || HARD_FAILURE_STATUSES.has(node.coverage.originalStatus)) {
      reasons.push(
        `Required route ${required} has coverage status "${node.coverage.status}" (originalStatus "${node.coverage.originalStatus}") in graph/routes.json.`
      );
      continue;
    }
    if (node.sourceArtifacts.length === 0) {
      reasons.push(`Required route ${required} has no source artifacts (missing page-data/carbon-content backing) in graph/routes.json.`);
    }
  }

  if (reasons.length > 0) {
    return failedCheck(stage, reasons, { routeCount: routeGraph.routes.length });
  }

  return passedCheck(stage, { routeCount: routeGraph.routes.length });
}
