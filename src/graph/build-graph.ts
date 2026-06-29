import type { MaterialIndex } from '../types.js';
import type { ArtifactRecord } from '../raw-artifacts/artifact-types.js';
import type { DecodedTokenTableSystem } from '../json-extraction/schemas.js';
import { buildPageGraph, deriveSectionGraph } from './page-graph.js';
import { buildProvenanceGraph } from './provenance.js';
import { buildResourceGraph } from './resource-graph.js';
import {
  writePageGraph,
  writeProvenanceGraph,
  writeResourceGraph,
  writeRouteGraph,
  writeSectionGraph,
  writeTokenTableGraph,
} from './graph-store.js';
import { buildRouteGraph } from './route-graph.js';
import { buildTokenTableGraph, buildTokenTableNode } from './token-table-graph.js';
import type { PageGraph, ProvenanceGraph, ResourceGraph, RouteGraph, SectionGraph, TokenTableGraph } from './graph-types.js';

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
 * (graph/{routes,pages,resources,token-tables,sections,provenance}.json) from a completed
 * crawl's `MaterialIndex`. Called once at the end of `crawlIntoCache` in src/crawler.ts (the
 * point where `index.coverageDiagnostics.{routePlanSummary,fullRoutePlanSummary,routeCoverage}`
 * and `index.extractionDiagnostics.{pageDiagnostics,routeDiagnostics}` are all populated).
 *
 * Token-table graph: built from `collectedTokenTables` (optional, defaults to `[]`) — the decoded
 * `DecodedTokenTableSystem` values captured at render time by extract-dsdb-resource.ts's
 * `renderDsdbResourceChunk` (via the `CollectedTokenTable` sink array), threaded through
 * extract-content-page.ts's `JsonExtractionResult.collectedTokenTables` and collected per saved
 * page by crawler.ts's `crawlIntoCache`. When the caller has no collected systems (e.g. an older
 * `MaterialIndex` built before this wiring), `tokenTables` is simply empty, matching the previous
 * behavior. One caveat remains for stage 5: chunk-level identity (tying a specific token table to
 * a specific page chunk) is still not threaded into PageNode.tokenTableIds — see page-graph.ts's
 * module doc.
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

  const resourceGraph = buildResourceGraph({
    generatedAt,
    pageDiagnostics: index.extractionDiagnostics?.pageDiagnostics ?? [],
    routeDiagnostics: index.extractionDiagnostics?.routeDiagnostics ?? [],
    artifactRecords,
  });

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

export async function buildAndWriteGraph(
  index: MaterialIndex,
  cacheDir: string,
  artifactRecords: ArtifactRecord[] = [],
  collectedTokenTables: CollectedTokenTableInput[] = []
): Promise<BuiltGraph> {
  const graph = buildGraphFromIndex(index, artifactRecords, collectedTokenTables);
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
