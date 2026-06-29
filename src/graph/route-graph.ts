import type { RouteCoverageEntry, RouteCoverageStatus, RoutePlanEntry } from '../types.js';
import type { ArtifactRecord } from '../raw-artifacts/artifact-types.js';
import {
  RouteGraphSchema,
  type RouteCoverageInfo,
  type RouteGraph,
  type RouteGraphCoverageStatus,
  type RouteNode,
  type RouteOrigin,
  type SourceArtifactRef,
} from './graph-types.js';

/**
 * Builds the route/reference graph (`graph/routes.json`) from the existing extraction
 * pipeline's *output* structures — `RoutePlanEntry[]` (src/json-extraction/route-graph.ts's
 * buildRoutePlan, all buckets: accepted/stale/ambiguous/non-public) and `RouteCoverageEntry[]`
 * (src/route-coverage.ts) — rather than re-deriving route discovery from raw payloads.
 *
 * This module is deliberately NOT a duplicate of src/json-extraction/route-graph.ts:
 * - json-extraction/route-graph.ts is route discovery/reconciliation policy (candidate sources,
 *   public-docs classification, identity matching against the bundle table). It decides which
 *   routes exist and how they map to canonical/bundle routes.
 * - this module is a graph *projection* of that already-reconciled output, joined with the
 *   coverage tracking that happens during the actual fetch loop (RouteCoverageEntry), persisted
 *   as a stable on-disk node shape for downstream consumers (MCP tools, stage 6) that should
 *   not need to re-run route reconciliation themselves.
 *
 * Important nuance (see AGENTS.md / task spec): `applySharedRouteCoverage` in route-coverage.ts
 * intentionally collapses a *shared* coverage status across all source routes in the same
 * coverage group (e.g. "/components/buttons" alias and "/components/buttons/overview" canonical
 * route share one group once either has saved output) — that shared status is the operationally
 * useful one (did the user-visible content get produced at all). But collapsing silently away
 * the route's own original status would hide the fact that "/components/buttons" itself was
 * alias-only and never independently fetched. This builder preserves both: `coverage.status` is
 * the shared/group status (matching applySharedRouteCoverage's output), and
 * `coverage.originalStatus` is recomputed independently per source route from its own
 * savedOutputPaths/failedOutputPaths/skippedOutputPaths *before* group-sharing, so an alias-only
 * route still reports e.g. originalStatus:"unresolved" even though status:"covered" once its
 * sibling canonical route is covered.
 */

function toRouteOrigin(source: RoutePlanEntry['sources'][number]): RouteOrigin {
  return source;
}

/** Recomputes this entry's own coverage status from its own output-path buckets, ignoring any
 *  shared-group widening that applySharedRouteCoverage may have already applied to the entry. */
function originalCoverageStatus(entry: RouteCoverageEntry): RouteCoverageStatus {
  if (entry.status === 'policySkipped' || entry.status === 'nonContent') return entry.status;
  if (entry.expectedOutputPaths.length === 0) return 'unresolved';
  const allSaved = entry.expectedOutputPaths.every((p) => entry.savedOutputPaths.includes(p));
  const allFailed = entry.expectedOutputPaths.every((p) => entry.failedOutputPaths.includes(p));
  const allSkipped = entry.expectedOutputPaths.every((p) => entry.skippedOutputPaths.includes(p));
  if (allSaved) return 'covered';
  if (entry.savedOutputPaths.length > 0) return 'partial';
  if (allFailed) return 'failed';
  if (allSkipped) return 'skipped';
  return 'unresolved';
}

function toGraphCoverageStatus(
  status: RouteCoverageStatus,
  reconciliationStatus: RoutePlanEntry['reconciliationStatus'] | undefined
): RouteGraphCoverageStatus {
  if (reconciliationStatus === 'rejectedAmbiguous') return 'ambiguous';
  if (reconciliationStatus === 'rejectedStale') return 'stale';
  return status;
}

function buildCoverageInfo(
  planEntry: RoutePlanEntry,
  coverageEntry: RouteCoverageEntry | null
): RouteCoverageInfo {
  if (!coverageEntry) {
    return {
      status: toGraphCoverageStatus('unresolved', planEntry.reconciliationStatus),
      reasons: planEntry.failureReason ? [planEntry.failureReason] : planEntry.skippedReason ? [planEntry.skippedReason] : [],
      originalStatus: toGraphCoverageStatus('unresolved', planEntry.reconciliationStatus),
      sharedCoverageGroup: null,
      sharedWithRoutes: [],
      expectedOutputPaths: [],
      savedOutputPaths: [],
      failedOutputPaths: [],
      skippedOutputPaths: [],
    };
  }

  const original = originalCoverageStatus(coverageEntry);
  const sharedWithRoutes = (coverageEntry.coverageSharedWithSourceRoutes ?? []).filter(
    (route) => route !== coverageEntry.sourceRoute
  );
  // aliasOnly: this specific route never independently produced output, but is part of a shared
  // group whose canonical sibling did — surfaced distinctly from a genuinely "unresolved" route.
  const isAliasOnly = original !== 'covered'
    && original !== 'partial'
    && coverageEntry.status === 'covered'
    && sharedWithRoutes.length > 0;

  return {
    status: toGraphCoverageStatus(coverageEntry.status, planEntry.reconciliationStatus),
    reasons: coverageEntry.failureReasons,
    originalStatus: isAliasOnly ? 'aliasOnly' : toGraphCoverageStatus(original, planEntry.reconciliationStatus),
    sharedCoverageGroup: coverageEntry.coverageGroupKey ?? null,
    sharedWithRoutes,
    expectedOutputPaths: coverageEntry.expectedOutputPaths,
    savedOutputPaths: coverageEntry.savedOutputPaths,
    failedOutputPaths: coverageEntry.failedOutputPaths,
    skippedOutputPaths: coverageEntry.skippedOutputPaths,
  };
}

/** Maps an ArtifactRecord (page-data/carbon-content/dsdb-resource/network-capture) to a graph SourceArtifactRef. */
function toSourceArtifactRef(artifact: ArtifactRecord): SourceArtifactRef | null {
  if (artifact.kind === 'page-data' || artifact.kind === 'carbon-content' || artifact.kind === 'dsdb-resource' || artifact.kind === 'network-capture') {
    return { artifactId: artifact.id, kind: artifact.kind };
  }
  return null;
}

/**
 * Raw artifacts are recorded under the literal alias/slug that was actually fetched (e.g.
 * "/components/switches"), which can differ from the route's reconciled canonical form (e.g.
 * "/components/switch") that this RouteNode is keyed by. Look up artifacts under the route, its
 * canonicalRoute, and every alternate slug so canonical routes don't end up with an empty
 * sourceArtifacts list just because the fetch happened to use an alias.
 */
function lookupSourceArtifacts(
  planEntry: RoutePlanEntry,
  artifactsBySourceRoute: Map<string, ArtifactRecord[]>
): ArtifactRecord[] {
  const keys = new Set<string>([planEntry.route]);
  if (planEntry.canonicalRoute) keys.add(planEntry.canonicalRoute);
  for (const alias of planEntry.alternateSlugs ?? []) keys.add(alias);

  const seenIds = new Set<string>();
  const records: ArtifactRecord[] = [];
  for (const key of keys) {
    for (const artifact of artifactsBySourceRoute.get(key) ?? []) {
      if (seenIds.has(artifact.id)) continue;
      seenIds.add(artifact.id);
      records.push(artifact);
    }
  }
  return records;
}

/**
 * Two distinct accepted route-plan entries can share the same canonicalRoute (e.g. an alias entry
 * "/components/switches" alongside the canonical "/components/switch" entry) without either one's
 * own `alternateSlugs` listing the other — alternateSlugs is populated by whichever entry's own
 * identity resolution discovered slug variants, not necessarily bidirectionally. lookupSourceArtifacts
 * already widens the per-entry lookup to route/canonicalRoute/alternateSlugs, but that alone can
 * still leave one sibling in the group with the real artifacts and the other with none, since each
 * node is built independently. This pass unions sourceArtifacts across every node that shares a
 * non-null canonicalRoute, mutating the nodes in place so every sibling — and any MCP tool reading
 * RouteNode.sourceArtifacts for any of them — sees the full provenance.
 */
function mergeSourceArtifactsAcrossSharedCanonicalRoutes(routes: RouteNode[]): void {
  const groups = new Map<string, RouteNode[]>();
  for (const node of routes) {
    if (!node.canonicalRoute) continue;
    const group = groups.get(node.canonicalRoute);
    if (group) group.push(node);
    else groups.set(node.canonicalRoute, [node]);
  }
  for (const group of groups.values()) {
    if (group.length <= 1) continue;
    const seenIds = new Set<string>();
    const merged: RouteNode['sourceArtifacts'] = [];
    for (const node of group) {
      for (const ref of node.sourceArtifacts) {
        if (seenIds.has(ref.artifactId)) continue;
        seenIds.add(ref.artifactId);
        merged.push(ref);
      }
    }
    for (const node of group) node.sourceArtifacts = merged;
  }
}

function buildRouteNode(
  planEntry: RoutePlanEntry,
  coverageEntry: RouteCoverageEntry | null,
  artifactsBySourceRoute: Map<string, ArtifactRecord[]>
): RouteNode {
  const tabs = (planEntry.tabSlugs ?? planEntry.tabs ?? []).map((slugOrLabel, index) => {
    const label = planEntry.tabs?.[index] ?? slugOrLabel;
    const slug = planEntry.tabSlugs?.[index] ?? slugOrLabel;
    const base = planEntry.canonicalRoute ?? planEntry.route;
    return {
      label,
      route: `${base}/${slug}`,
      slug,
      matchedSectionId: null,
      matchReason: 'unmatched' as const,
    };
  });

  return {
    route: planEntry.route,
    canonicalRoute: planEntry.canonicalRoute ?? null,
    aliases: planEntry.alternateSlugs ?? [],
    title: planEntry.routeTitle ?? planEntry.navTitle ?? null,
    section: planEntry.route.replace(/^\/+/, '').split('/')[0] ?? null,
    reference: {
      collectionId: planEntry.collectionId ?? null,
      documentId: planEntry.documentId ?? null,
      exportedCarbonFileId: planEntry.exportedCarbonFileId ?? null,
      pageCanonId: planEntry.pageCanonId ?? null,
      carbonVersion: null,
    },
    tabs,
    origins: planEntry.sources.map(toRouteOrigin),
    sourceArtifacts: lookupSourceArtifacts(planEntry, artifactsBySourceRoute)
      .map(toSourceArtifactRef)
      .filter((ref): ref is SourceArtifactRef => ref !== null),
    expectedOutputPaths: coverageEntry?.expectedOutputPaths ?? (planEntry.outputPath ? [planEntry.outputPath] : []),
    generatedOutputPaths: coverageEntry?.savedOutputPaths ?? [],
    coverage: buildCoverageInfo(planEntry, coverageEntry),
  };
}

export type BuildRouteGraphInput = {
  baseUrl: string;
  generatedAt?: string;
  /** All route plan buckets — accepted, stale, ambiguous, non-public — so the graph preserves
   *  unsupported/policy-skipped/stale/ambiguous routes per the spec, not just accepted ones. */
  routePlanEntries: RoutePlanEntry[];
  routeCoverage: RouteCoverageEntry[];
  /** Raw artifacts persisted during the crawl (raw-artifacts/artifact-index.ts), used to populate
   *  RouteNode.sourceArtifacts by matching ArtifactRecord.sourceRoute to the route path. Defaults
   *  to empty when the caller hasn't wired raw artifact persistence into the crawl. */
  artifactRecords?: ArtifactRecord[];
};

export function buildRouteGraph(input: BuildRouteGraphInput): RouteGraph {
  const coverageByRoute = new Map<string, RouteCoverageEntry>();
  for (const entry of input.routeCoverage) coverageByRoute.set(entry.sourceRoute, entry);

  const artifactsBySourceRoute = new Map<string, ArtifactRecord[]>();
  for (const artifact of input.artifactRecords ?? []) {
    if (!artifact.sourceRoute) continue;
    const list = artifactsBySourceRoute.get(artifact.sourceRoute);
    if (list) list.push(artifact);
    else artifactsBySourceRoute.set(artifact.sourceRoute, [artifact]);
  }

  const seen = new Set<string>();
  const routes: RouteNode[] = [];
  for (const planEntry of input.routePlanEntries) {
    if (seen.has(planEntry.route)) continue;
    seen.add(planEntry.route);
    routes.push(buildRouteNode(planEntry, coverageByRoute.get(planEntry.route) ?? null, artifactsBySourceRoute));
  }

  mergeSourceArtifactsAcrossSharedCanonicalRoutes(routes);

  const graph: RouteGraph = {
    schemaVersion: 1,
    generatedAt: input.generatedAt ?? new Date().toISOString(),
    baseUrl: input.baseUrl,
    routes,
  };

  const parsed = RouteGraphSchema.safeParse(graph);
  if (!parsed.success) {
    throw new Error(`Failed to build a valid route graph: ${parsed.error.message}`);
  }
  return parsed.data;
}
