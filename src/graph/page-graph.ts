import type { ExtractionPageDiagnostic, ExtractionRouteDiagnostic, MaterialPageMeta } from '../types.js';
import type { ArtifactRecord } from '../raw-artifacts/artifact-types.js';
import {
  PageGraphSchema,
  SectionGraphSchema,
  type PageChunkNode,
  type PageGraph,
  type PageNode,
  type PageSectionNode,
  type SectionGraph,
  type SourceArtifactRef,
} from './graph-types.js';
import {
  imageResourceId,
  statusTableResourceId,
  tokenTablePlaceholderResourceId,
  tokenTableResourceId,
  unknownResourceId,
  videoResourceId,
} from './resource-identity.js';

/** Maps an ArtifactRecord (page-data/carbon-content/dsdb-resource/network-capture) to a graph SourceArtifactRef. */
function toSourceArtifactRef(artifact: ArtifactRecord): SourceArtifactRef | null {
  if (artifact.kind === 'page-data' || artifact.kind === 'carbon-content' || artifact.kind === 'dsdb-resource' || artifact.kind === 'network-capture') {
    return { artifactId: artifact.id, kind: artifact.kind };
  }
  return null;
}

/**
 * Builds the page graph (`graph/pages.json`) from `MaterialPageMeta` (the per-page metadata
 * already written to `index.json` — id/title/url/path/section/headings) joined with the
 * matching `ExtractionPageDiagnostic` and `ExtractionRouteDiagnostic` entries recorded during
 * the same crawl (src/json-extraction/diagnostics.ts's pushPageDiagnostic/pushRouteDiagnostic).
 *
 * Resource chunks (token tables, status tables, images, videos, unknown resources) are derived
 * from the same `ExtractionPageDiagnostic` counters/diagnostics that `resource-graph.ts` reads,
 * using the *same* id construction (`./resource-identity.ts`) — so `PageNode.chunks[].resourceId`
 * always points at a real `ResourceNode.resourceId`, and `resourceIds`/`tokenTableIds` are real
 * cross-references rather than empty placeholders. `extract-content-page.ts` does not retain a
 * stable per-chunk id from the Carbon JSON itself (the decoded schema has none — see schemas.ts),
 * so chunk ids here are positional within a page (`chunk-token-table-0`, `chunk-image-1`, ...),
 * stable for a given artifact snapshot.
 */

function sectionsFromHeadings(headings: string[]): { sections: PageSectionNode[]; chunks: PageChunkNode[] } {
  const sections: PageSectionNode[] = [];
  const chunks: PageChunkNode[] = [];
  headings.forEach((title, index) => {
    const sectionId = `section-${index}`;
    const chunkId = `chunk-${index}-text`;
    sections.push({
      sectionId,
      title,
      headingLevel: index === 0 ? 1 : 2,
      chunkIds: [chunkId],
    });
    chunks.push({
      chunkId,
      chunkType: 'text',
      resourceId: null,
      textExcerpt: title,
    });
  });
  return { sections, chunks };
}

function resourceChunksFromDiagnostic(diagnostic: ExtractionPageDiagnostic | null): PageChunkNode[] {
  if (!diagnostic) return [];
  const chunks: PageChunkNode[] = [];

  diagnostic.tokenContextDiagnostics.forEach((tokenDiagnostic, index) => {
    const resourceId = tokenTableResourceId(diagnostic.path, index, tokenDiagnostic.resourceName ?? null);
    chunks.push({
      chunkId: `chunk-token-table-${index}`,
      chunkType: 'resource',
      resourceId,
      textExcerpt: tokenDiagnostic.resourceName ?? 'token table',
    });
  });
  (diagnostic.tokenTablePlaceholderReasons ?? []).forEach((reason, index) => {
    const resourceId = tokenTablePlaceholderResourceId(diagnostic.path, index);
    chunks.push({
      chunkId: `chunk-token-table-placeholder-${index}`,
      chunkType: 'resource',
      resourceId,
      textExcerpt: `token table (${reason})`,
    });
  });

  (diagnostic.statusTableDiagnostics ?? []).forEach((statusDiagnostic, index) => {
    const resourceId = statusTableResourceId(diagnostic.path, index, statusDiagnostic.resourceName ?? null);
    chunks.push({
      chunkId: `chunk-status-table-${index}`,
      chunkType: 'resource',
      resourceId,
      textExcerpt: statusDiagnostic.resourceName ?? 'status table',
    });
  });

  for (let i = 0; i < diagnostic.imageCount; i += 1) {
    chunks.push({ chunkId: `chunk-image-${i}`, chunkType: 'image', resourceId: imageResourceId(diagnostic.path, i), textExcerpt: null });
  }
  for (let i = 0; i < diagnostic.videoCount; i += 1) {
    chunks.push({ chunkId: `chunk-video-${i}`, chunkType: 'video', resourceId: videoResourceId(diagnostic.path, i), textExcerpt: null });
  }
  diagnostic.unknownChunkTypes.forEach((type, i) => {
    chunks.push({ chunkId: `chunk-unsupported-${i}`, chunkType: 'unsupported', resourceId: unknownResourceId(diagnostic.path, i), textExcerpt: type });
  });
  return chunks;
}

/** Real cross-references for `PageNode.resourceIds`/`tokenTableIds`, derived from the same chunk
 *  list (deduplicated — a token table with multiple resolved token diagnostics still produces
 *  one resourceId, matching how resource-graph.ts's `upsertResource` collapses them). */
function resourceCrossReferences(chunks: PageChunkNode[]): { resourceIds: string[]; tokenTableIds: string[] } {
  const resourceIds: string[] = [];
  const tokenTableIds: string[] = [];
  for (const chunk of chunks) {
    if (!chunk.resourceId) continue;
    if (!resourceIds.includes(chunk.resourceId)) resourceIds.push(chunk.resourceId);
    if (chunk.resourceId.startsWith('token-table:') && !tokenTableIds.includes(chunk.resourceId)) {
      tokenTableIds.push(chunk.resourceId);
    }
  }
  return { resourceIds, tokenTableIds };
}

function buildPageNode(
  page: MaterialPageMeta,
  pageDiagnostic: ExtractionPageDiagnostic | null,
  routeDiagnostic: ExtractionRouteDiagnostic | null,
  artifactsBySourceRoute: Map<string, ArtifactRecord[]>
): PageNode {
  const { sections, chunks: headingChunks } = sectionsFromHeadings(page.headings);
  const resourceChunks = resourceChunksFromDiagnostic(pageDiagnostic);
  const { resourceIds, tokenTableIds } = resourceCrossReferences(resourceChunks);
  // sourceRoute is the page actually fetched (e.g. "/components/switch"); virtualRoute is this
  // specific tab's own route (e.g. "/components/switch/specs"). artifactsBySourceRoute is keyed
  // by the fetched page, so artifact lookup must use sourceRoute — but the PageNode's own `route`
  // field must report the page's actual identity (virtualRoute when this page is a tab), otherwise
  // every tab of a tabbed component collapses onto the same reported route, which breaks anything
  // matching pages/routes 1:1 (e.g. validate-route-graph.ts's required-route lookup).
  const sourceRouteForArtifacts = routeDiagnostic?.sourceRoute ?? routeDiagnostic?.normalizedRoute ?? page.path.replace(/\.md$/i, '');
  const route = routeDiagnostic?.virtualRoute ?? sourceRouteForArtifacts;
  const sourceArtifacts = (artifactsBySourceRoute.get(sourceRouteForArtifacts) ?? [])
    .map(toSourceArtifactRef)
    .filter((ref): ref is SourceArtifactRef => ref !== null);

  return {
    pageId: page.id,
    route,
    title: page.title,
    section: page.section,
    tabs: routeDiagnostic?.tabName
      ? [{
          label: routeDiagnostic.tabName,
          route: routeDiagnostic.virtualRoute ?? route,
          sectionIndex: routeDiagnostic.tabMatchedSectionIndex ?? null,
        }]
      : [],
    headings: page.headings,
    sections,
    chunks: [...headingChunks, ...resourceChunks],
    resourceIds,
    tokenTableIds,
    unsupportedChunkTypes: pageDiagnostic?.unknownChunkTypes ?? [],
    provenance: {
      sourceArtifacts,
      sourceRoute: routeDiagnostic?.sourceRoute ?? null,
      canonicalRoute: routeDiagnostic?.canonicalRoute ?? null,
      virtualRoute: routeDiagnostic?.virtualRoute ?? null,
    },
  };
}

export type BuildPageGraphInput = {
  generatedAt?: string;
  pages: MaterialPageMeta[];
  pageDiagnostics: ExtractionPageDiagnostic[];
  routeDiagnostics: ExtractionRouteDiagnostic[];
  /** Raw artifacts persisted during the crawl, matched to pages by ArtifactRecord.sourceRoute. */
  artifactRecords?: ArtifactRecord[];
};

export function buildPageGraph(input: BuildPageGraphInput): PageGraph {
  const pageDiagnosticByPath = new Map<string, ExtractionPageDiagnostic>();
  for (const diagnostic of input.pageDiagnostics) pageDiagnosticByPath.set(diagnostic.path, diagnostic);

  const routeDiagnosticByPath = new Map<string, ExtractionRouteDiagnostic>();
  for (const diagnostic of input.routeDiagnostics) routeDiagnosticByPath.set(diagnostic.path, diagnostic);

  const artifactsBySourceRoute = new Map<string, ArtifactRecord[]>();
  for (const artifact of input.artifactRecords ?? []) {
    if (!artifact.sourceRoute) continue;
    const list = artifactsBySourceRoute.get(artifact.sourceRoute);
    if (list) list.push(artifact);
    else artifactsBySourceRoute.set(artifact.sourceRoute, [artifact]);
  }

  const pages = input.pages.map((page) =>
    buildPageNode(page, pageDiagnosticByPath.get(page.path) ?? null, routeDiagnosticByPath.get(page.path) ?? null, artifactsBySourceRoute)
  );

  const graph: PageGraph = {
    schemaVersion: 1,
    generatedAt: input.generatedAt ?? new Date().toISOString(),
    pages,
  };

  const parsed = PageGraphSchema.safeParse(graph);
  if (!parsed.success) {
    throw new Error(`Failed to build a valid page graph: ${parsed.error.message}`);
  }
  return parsed.data;
}

/**
 * Derives the section graph (`graph/sections.json`) as a flat, page-graph-independent
 * projection of `PageNode.sections` — convenient for consumers (e.g. a future "find the section
 * that documents X" MCP tool) that want to query sections directly without walking every page.
 * Pure derivation: no new data, just a different shape over PageGraph.
 */
export function deriveSectionGraph(pageGraph: PageGraph, generatedAt?: string): SectionGraph {
  const sections = pageGraph.pages.flatMap((page) =>
    page.sections.map((section) => ({
      sectionId: `${page.pageId}:${section.sectionId}`,
      pageId: page.pageId,
      route: page.route,
      title: section.title,
      headingLevel: section.headingLevel,
      chunkIds: section.chunkIds,
    }))
  );

  const graph: SectionGraph = {
    schemaVersion: 1,
    generatedAt: generatedAt ?? pageGraph.generatedAt,
    sections,
  };

  const parsed = SectionGraphSchema.safeParse(graph);
  if (!parsed.success) {
    throw new Error(`Failed to build a valid section graph: ${parsed.error.message}`);
  }
  return parsed.data;
}
