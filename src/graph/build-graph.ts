import type { MaterialIndex } from '../types.js';
import type { ArtifactRecord } from '../raw-artifacts/artifact-types.js';
import type { DecodedTokenTableSystem } from '../json-extraction/schemas.js';
import { buildPageGraph, deriveSectionGraph } from './page-graph.js';
import { buildProvenanceGraph } from './provenance.js';
import { buildResourceGraph } from './resource-graph.js';
import { buildRawBackedGraph } from './raw-graph-build.js';
import {
  writePageGraph,
  writeProvenanceGraph,
  writeResourceGraph,
  writeRouteGraph,
  writeSectionGraph,
  writeTokenTableGraph,
} from './graph-store.js';
import { backfillRouteTabMatches, buildRouteGraph } from './route-graph.js';
import { buildTokenTableGraph, buildTokenTableNode } from './token-table-graph.js';
import type { PageGraph, PageNode, ProvenanceGraph, ResourceGraph, RouteGraph, SectionGraph, TokenTableGraph } from './graph-types.js';

/** A decoded token-table system captured during page extraction (see CollectedTokenTable in
 *  src/json-extraction/extract-dsdb-resource.ts), associated with the route it was rendered on. */
export type CollectedTokenTableInput = {
  resourceName: string;
  requestedTokenSets: string[];
  system: DecodedTokenTableSystem;
  route: string | null;
};

/**
 * Orchestrates building and persisting the full documentation graph
 * (graph/{routes,pages,resources,token-tables,sections,provenance}.json). Called once at the end
 * of `crawlIntoCache` in src/crawler.ts (the point where `index.coverageDiagnostics.*` and
 * `index.extractionDiagnostics.*` are populated, and where the crawl's raw `artifactRecords` are
 * available).
 *
 * Production path: when raw artifacts are available (`artifactRecords.length > 0`),
 * `buildAndWriteGraph` builds the graph from the persisted raw snapshot via
 * `raw-graph-build.ts`'s `buildRawBackedGraph` — decoding page-data/Carbon-content/DSDB-resource
 * JSON read back from `raw/**` into routes/pages/resources/token-tables directly, not from
 * `MaterialIndex` summaries. This is what `verify:cache:full` (`strictGraph`/`--strict-graph`)
 * requires; see the `strict` parameter below.
 *
 * Fallback path: `buildGraphFromIndex` (legacy builder, reconstructs the same graph shapes from
 * `MaterialIndex` diagnostic/coverage summaries instead of raw JSON) always runs first and is kept
 * for two reasons: (1) it is still the only path for callers/fixtures with no raw artifacts at
 * all (e.g. older `MaterialIndex` snapshots, or unit tests that build a graph without persisting
 * `raw/**`), and (2) it independently establishes `routeGraph`/`pageGraph`/`resourceGraph` shapes
 * used as a structural baseline before the raw-backed result (when available) overwrites them.
 * It is compatibility/fallback support only — never the production path when raw artifacts exist.
 *
 * Token-table graph: built from `collectedTokenTables` (optional, defaults to `[]`) — the decoded
 * `DecodedTokenTableSystem` values captured at render time by extract-dsdb-resource.ts's
 * `renderDsdbResourceChunk` (via the `CollectedTokenTable` sink array), threaded through
 * extract-content-page.ts's `JsonExtractionResult.collectedTokenTables` and collected per saved
 * page by crawler.ts's `crawlIntoCache`. This only feeds the legacy (`buildGraphFromIndex`) path —
 * the raw-backed path decodes token tables directly from the `dsdb-resource` artifacts themselves
 * (see `buildTokenTableGraphFromRaw` in raw-graph-build.ts). When the caller has no collected
 * systems and no raw artifacts, `tokenTables` is simply empty, matching the previous behavior.
 * `PageNode.tokenTableIds`/`resourceIds` are populated directly by page-graph.ts (shared id scheme
 * with resource-graph.ts, see resource-identity.ts) — `ResourceNode.pageIds` is then backfilled
 * here (`backfillResourcePageIds`) once both graphs exist.
 *
 * Provenance: `artifactRecords` (optional, defaults to `[]`) is the list of raw artifacts
 * persisted during the crawl (src/raw-artifacts/artifact-store.ts's `persistArtifact`, collected
 * by crawler.ts's `crawlIntoCache`). When non-empty, route-graph.ts/page-graph.ts/resource-graph.ts
 * match artifacts to routes/pages/resources by `ArtifactRecord.sourceRoute` (and, for DSDB
 * resources, by the trailing path segment of the resource name), populating `sourceArtifacts` so
 * `graph/provenance.json` is no longer empty. Callers that don't pass `artifactRecords` (or pass
 * `[]`) get the same empty-provenance behavior as before.
 */
export type BuiltGraph = {
  routeGraph: RouteGraph;
  pageGraph: PageGraph;
  resourceGraph: ResourceGraph;
  tokenTableGraph: TokenTableGraph;
  sectionGraph: SectionGraph;
  provenanceGraph: ProvenanceGraph;
};

/** Backfills `ResourceNode.pageIds` from `PageNode.chunks[].resourceId` now that both graphs share
 *  the same resource-id scheme (`./resource-identity.ts`) — mechanical once both sides have real
 *  ids, no new data needed. Mutates `resourceGraph.resources` in place. */
export function backfillResourcePageIdsForTest(resourceGraph: ResourceGraph, pageGraph: PageGraph): void {
  backfillResourcePageIds(resourceGraph, pageGraph);
}

function backfillResourcePageIds(resourceGraph: ResourceGraph, pageGraph: PageGraph): void {
  const resourceById = new Map(resourceGraph.resources.map((resource) => [resource.resourceId, resource]));
  for (const page of pageGraph.pages) {
    for (const chunk of page.chunks) {
      if (!chunk.resourceId) continue;
      const resource = resourceById.get(chunk.resourceId);
      if (resource && !resource.pageIds.includes(page.pageId)) resource.pageIds.push(page.pageId);
    }
  }
}

export function buildGraphFromIndex(
  index: MaterialIndex,
  artifactRecords: ArtifactRecord[] = [],
  collectedTokenTables: CollectedTokenTableInput[] = []
): BuiltGraph {
  const generatedAt = index.capturedAt;
  const routePlanEntries = index.coverageDiagnostics?.fullRoutePlanSummary
    ? [
        ...index.coverageDiagnostics.fullRoutePlanSummary.acceptedRoutes,
        ...index.coverageDiagnostics.fullRoutePlanSummary.staleRoutes,
        ...index.coverageDiagnostics.fullRoutePlanSummary.ambiguousRoutes,
        ...index.coverageDiagnostics.fullRoutePlanSummary.nonPublicRoutes,
      ]
    : [];

  const routeGraph = buildRouteGraph({
    baseUrl: index.source,
    generatedAt,
    routePlanEntries,
    routeCoverage: index.coverageDiagnostics?.routeCoverage ?? [],
    artifactRecords,
  });

  const pageGraph = buildPageGraph({
    generatedAt,
    pages: index.pages,
    pageDiagnostics: index.extractionDiagnostics?.pageDiagnostics ?? [],
    routeDiagnostics: index.extractionDiagnostics?.routeDiagnostics ?? [],
    artifactRecords,
  });
  backfillRouteTabMatches(routeGraph.routes, index.extractionDiagnostics?.routeDiagnostics ?? [], pageGraph);

  const resourceGraph = buildResourceGraph({
    generatedAt,
    pageDiagnostics: index.extractionDiagnostics?.pageDiagnostics ?? [],
    routeDiagnostics: index.extractionDiagnostics?.routeDiagnostics ?? [],
    artifactRecords,
  });
  backfillResourcePageIds(resourceGraph, pageGraph);

  // Part C closure: build real token-table graph nodes from the decoded systems captured at
  // render time (CollectedTokenTable, threaded from extract-dsdb-resource.ts through
  // extract-content-page.ts and crawler.ts), instead of leaving tokenTables empty. Each captured
  // system becomes one TokenTableNode keyed by `dsdb-resource:<resourceName>`, matching the
  // resource-graph.ts id convention closely enough to be human-correlatable, though the two
  // graphs are not required to share exact ids.
  const tokenTableNodes = collectedTokenTables.map((collected) =>
    buildTokenTableNode({
      resourceId: `token-table:${collected.resourceName}`,
      resourceName: collected.resourceName,
      system: collected.system,
      requestedTokenSets: collected.requestedTokenSets,
      routes: collected.route ? [collected.route] : [],
    })
  );
  const tokenTableGraph: TokenTableGraph = buildTokenTableGraph({ generatedAt, tokenTables: tokenTableNodes });

  const sectionGraph = deriveSectionGraph(pageGraph, generatedAt);

  const provenanceGraph = buildProvenanceGraph({ generatedAt, routeGraph, pageGraph, resourceGraph });

  return { routeGraph, pageGraph, resourceGraph, tokenTableGraph, sectionGraph, provenanceGraph };
}

/**
 * `strict`: mirrors the crawler's `--strict-graph` / `strictGraph` option (see crawler.ts). When
 * `true` and no raw artifacts were captured (`artifactRecords.length === 0`), the legacy
 * `buildGraphFromIndex` fallback would otherwise be promoted silently as if it were the raw-backed
 * graph. Strict callers (`verify:cache:full`) must not accept that: this throws instead, so
 * `crawler.ts`'s `runPromotionStep('graph', ...)` aborts promotion with a clear reason rather than
 * letting a legacy-only graph pass downstream structured-graph validation by coincidence. Non-strict
 * callers (default dev/smoke runs, and all existing unit tests that build a graph from a bare
 * `MaterialIndex` with no raw artifacts) keep the previous legacy-fallback behavior unchanged.
 */
export type BuildAndWriteGraphOptions = {
  strict?: boolean;
};

/**
 * `buildRawBackedGraph` only produces a `PageNode` for routes it can match a persisted
 * `carbon-content` artifact to (see raw-graph-build.ts's `rawPagesByRoute`). A crawl that falls
 * back to legacy DOM/browser extraction for some routes (no JSON page-data/Carbon artifact
 * persisted for those routes, even though *other* artifacts like site-shell/sitemap exist and make
 * `artifactRecords.length > 0`) still has those pages in the legacy `buildGraphFromIndex` graph,
 * built from the persisted `MaterialIndex` pages directly. Without this merge, replacing the whole
 * `pageGraph` with the raw-backed one would silently drop those DOM-fallback pages instead of
 * filling the gap — the raw-backed graph is authoritative where it has data, the legacy graph only
 * fills in pages/resources/token-tables it has no raw counterpart for.
 */
function mergePageGraphs(rawBackedPages: PageGraph, legacyPages: PageGraph): PageGraph {
  const rawRoutes = new Set(rawBackedPages.pages.map((page) => page.route));
  const legacyOnlyPages = legacyPages.pages.filter((page) => !rawRoutes.has(page.route));
  if (legacyOnlyPages.length === 0) return rawBackedPages;
  return { ...rawBackedPages, pages: [...rawBackedPages.pages, ...legacyOnlyPages] };
}

function mergeResourceGraphs(rawBackedResources: ResourceGraph, legacyResources: ResourceGraph, legacyOnlyPages: PageNode[]): ResourceGraph {
  const legacyOnlyResourceIds = new Set(legacyOnlyPages.flatMap((page) => page.resourceIds));
  if (legacyOnlyResourceIds.size === 0) return rawBackedResources;
  const rawResourceIds = new Set(rawBackedResources.resources.map((resource) => resource.resourceId));
  const additional = legacyResources.resources.filter(
    (resource) => legacyOnlyResourceIds.has(resource.resourceId) && !rawResourceIds.has(resource.resourceId)
  );
  if (additional.length === 0) return rawBackedResources;
  return { ...rawBackedResources, resources: [...rawBackedResources.resources, ...additional] };
}

function mergeTokenTableGraphs(rawBackedTokenTables: TokenTableGraph, legacyTokenTables: TokenTableGraph, legacyOnlyPages: PageNode[]): TokenTableGraph {
  const legacyOnlyTokenTableIds = new Set(legacyOnlyPages.flatMap((page) => page.tokenTableIds));
  if (legacyOnlyTokenTableIds.size === 0) return rawBackedTokenTables;
  const rawTokenTableIds = new Set(rawBackedTokenTables.tokenTables.map((tokenTable) => tokenTable.resourceId));
  const additional = legacyTokenTables.tokenTables.filter(
    (tokenTable) => legacyOnlyTokenTableIds.has(tokenTable.resourceId) && !rawTokenTableIds.has(tokenTable.resourceId)
  );
  if (additional.length === 0) return rawBackedTokenTables;
  return { ...rawBackedTokenTables, tokenTables: [...rawBackedTokenTables.tokenTables, ...additional] };
}

export async function buildAndWriteGraph(
  index: MaterialIndex,
  cacheDir: string,
  artifactRecords: ArtifactRecord[] = [],
  collectedTokenTables: CollectedTokenTableInput[] = [],
  options: BuildAndWriteGraphOptions = {}
): Promise<BuiltGraph> {
  if (options.strict && artifactRecords.length === 0) {
    throw new Error(
      'buildAndWriteGraph: strict mode requires raw artifacts to build the production raw-backed ' +
      'graph, but artifactRecords is empty — refusing to promote a legacy-only graph.'
    );
  }
  const legacyGraph = buildGraphFromIndex(index, artifactRecords, collectedTokenTables);
  let graph = legacyGraph;
  if (artifactRecords.length > 0) {
    // Production path: the raw-backed graph (decoded directly from raw/**, see
    // buildRawBackedGraph in raw-graph-build.ts) wins over the legacy baseline above for every
    // route it has data for. The legacy graph is only consulted to fill in pages/resources/
    // token-tables for routes the raw-backed builder has no raw artifact to reconstruct from
    // (DOM/browser-fallback-only routes) — see mergePageGraphs above. It is never used to override
    // raw-backed data.
    const rawBacked = await buildRawBackedGraph({ cacheDir, artifactRecords, index });
    const pageGraph = mergePageGraphs(rawBacked.pageGraph, legacyGraph.pageGraph);
    const rawRoutes = new Set(rawBacked.pageGraph.pages.map((page) => page.route));
    const legacyOnlyPages = legacyGraph.pageGraph.pages.filter((page) => !rawRoutes.has(page.route));
    const resourceGraph = mergeResourceGraphs(rawBacked.resourceGraph, legacyGraph.resourceGraph, legacyOnlyPages);
    const tokenTableGraph = mergeTokenTableGraphs(rawBacked.tokenTableGraph, legacyGraph.tokenTableGraph, legacyOnlyPages);
    graph = {
      routeGraph: rawBacked.routeGraph,
      pageGraph,
      resourceGraph,
      tokenTableGraph,
      sectionGraph: deriveSectionGraph(pageGraph, index.capturedAt),
      provenanceGraph: buildProvenanceGraph({
        generatedAt: index.capturedAt,
        routeGraph: rawBacked.routeGraph,
        pageGraph,
        resourceGraph,
      }),
    };
  }
  backfillResourcePageIds(graph.resourceGraph, graph.pageGraph);
  await Promise.all([
    writeRouteGraph(graph.routeGraph, cacheDir),
    writePageGraph(graph.pageGraph, cacheDir),
    writeResourceGraph(graph.resourceGraph, cacheDir),
    writeTokenTableGraph(graph.tokenTableGraph, cacheDir),
    writeSectionGraph(graph.sectionGraph, cacheDir),
    writeProvenanceGraph(graph.provenanceGraph, cacheDir),
  ]);
  return graph;
}
