import type { PageGraph, ProvenanceEntry, ProvenanceGraph, ResourceGraph, RouteGraph } from './graph-types.js';
import { ProvenanceGraphSchema } from './graph-types.js';

/**
 * Builds the provenance graph (`graph/provenance.json`): a flat index from each
 * route/page/resource subject to the raw artifacts it was derived from, aggregated from the
 * `sourceArtifacts` fields already present on RouteNode/PageNode/ResourceNode.
 *
 * Currently a pass-through aggregator: route-graph.ts/page-graph.ts/resource-graph.ts populate
 * `sourceArtifacts: []` because the crawler does not yet persist raw artifacts during a live
 * crawl (raw-artifacts/* lands unwired per the stage 1/2 handoff — see report). Once the crawler
 * is wired to call `persistArtifact`/`upsertArtifactRecord` for page-data/carbon-content/dsdb
 * fetches and thread the resulting `ArtifactRecord.id` through to route/page/resource graph
 * builders, this function requires no changes — it already reads whatever `sourceArtifacts`
 * each node carries.
 */
export function buildProvenanceGraph(input: {
  generatedAt?: string;
  routeGraph: RouteGraph;
  pageGraph: PageGraph;
  resourceGraph: ResourceGraph;
}): ProvenanceGraph {
  const entries: ProvenanceEntry[] = [
    ...input.routeGraph.routes
      .filter((route) => route.sourceArtifacts.length > 0)
      .map((route) => ({ subject: `route:${route.route}`, sourceArtifacts: route.sourceArtifacts })),
    ...input.pageGraph.pages
      .filter((page) => page.provenance.sourceArtifacts.length > 0)
      .map((page) => ({ subject: `page:${page.pageId}`, sourceArtifacts: page.provenance.sourceArtifacts })),
    ...input.resourceGraph.resources
      .filter((resource) => resource.sourceArtifact !== null)
      .map((resource) => ({
        subject: `resource:${resource.resourceId}`,
        sourceArtifacts: resource.sourceArtifact ? [resource.sourceArtifact] : [],
      })),
  ];

  const graph: ProvenanceGraph = {
    schemaVersion: 1,
    generatedAt: input.generatedAt ?? new Date().toISOString(),
    entries,
  };

  const parsed = ProvenanceGraphSchema.safeParse(graph);
  if (!parsed.success) {
    throw new Error(`Failed to build a valid provenance graph: ${parsed.error.message}`);
  }
  return parsed.data;
}
