import type { ExtractionPageDiagnostic, ExtractionRouteDiagnostic, StatusTableDiagnostic, TokenContextDiagnostic } from '../types.js';
import type { ArtifactRecord } from '../raw-artifacts/artifact-types.js';
import { ResourceGraphSchema, type ResourceGraph, type ResourceNode, type SourceArtifactRef } from './graph-types.js';
import { normalizeGraphRoute } from './route-identity.js';
import {
  dsdbArtifactBaseName,
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

/** Finds a raw artifact persisted under this resourceName's basename — dsdb-resource artifacts
 *  are persisted by crawler.ts's withArtifactPersistence under `dsdbArtifactBaseName(resourceName)`
 *  (design-system-id-qualified for `designSystems/<id>/components/<id>` resources, so two design
 *  systems sharing a trailing component id don't collide), which this must match exactly. */
function findArtifactForResourceName(artifactsByTrailingSegment: Map<string, ArtifactRecord[]>, resourceName: string): ArtifactRecord | null {
  return artifactsByTrailingSegment.get(dsdbArtifactBaseName(resourceName))?.[0] ?? null;
}

/**
 * Builds the resource graph (`graph/resources.json`) from the diagnostic counters already
 * recorded per page during extraction (`ExtractionPageDiagnostic.tokenContextDiagnostics`,
 * `.statusTableDiagnostics`, `.imageCount`, `.videoCount`, `.unknownResourceTypes`).
 *
 * Same caveat as page-graph.ts: the raw resource chunk objects are not retained after
 * rendering, so resource identity here is keyed by `resourceName` (the DSDB resource name
 * recorded in TokenContextDiagnostic/StatusTableDiagnostic) rather than a chunk-level id. Two
 * pages referencing the same resourceName correctly collapse into one resource node with
 * multiple `routes`/`chunkIds`; resources with no recoverable name become synthetic
 * `unknown-resource` nodes scoped to a single page (can't be deduplicated across pages without
 * a name).
 */

function pushRoute(routes: string[], route: string | undefined): void {
  if (route && !routes.includes(route)) routes.push(route);
}

function upsertResource(
  resources: Map<string, ResourceNode>,
  id: string,
  init: () => ResourceNode,
  route: string | undefined,
  chunkId: string
): void {
  const existing = resources.get(id);
  if (existing) {
    pushRoute(existing.routes, route);
    if (!existing.chunkIds.includes(chunkId)) existing.chunkIds.push(chunkId);
    return;
  }
  const node = init();
  pushRoute(node.routes, route);
  if (!node.chunkIds.includes(chunkId)) node.chunkIds.push(chunkId);
  resources.set(id, node);
}

function tokenTableResources(
  resources: Map<string, ResourceNode>,
  diagnostic: ExtractionPageDiagnostic,
  route: string | undefined,
  artifactsByTrailingSegment: Map<string, ArtifactRecord[]>
): void {
  diagnostic.tokenContextDiagnostics.forEach((tokenDiagnostic: TokenContextDiagnostic, index: number) => {
    const resourceName = tokenDiagnostic.resourceName;
    const id = tokenTableResourceId(diagnostic.path, index, resourceName ?? null);
    const matchedArtifact = resourceName ? findArtifactForResourceName(artifactsByTrailingSegment, resourceName) : null;
    upsertResource(
      resources,
      id,
      () => ({
        resourceId: id,
        kind: 'token-table',
        resourceName,
        sourceArtifact: matchedArtifact ? toSourceArtifactRef(matchedArtifact) : null,
        routes: [],
        pageIds: [],
        chunkIds: [],
        // A token table resource is resolved once the DSDB artifact was fetched and decoded
        // enough to emit tokenContextDiagnostics. Missing token variants remain visible on the
        // token-table graph without turning the resource itself into an unresolved fetch.
        status: 'resolved',
        unresolvedReason: null,
      }),
      route,
      `chunk-token-table-${index}`
    );
  });

  (diagnostic.tokenTablePlaceholderReasons ?? []).forEach((reason: string, index: number) => {
    const id = tokenTablePlaceholderResourceId(diagnostic.path, index);
    upsertResource(
      resources,
      id,
      () => ({
        resourceId: id,
        kind: 'token-table',
        resourceName: null,
        sourceArtifact: null,
        routes: [],
        pageIds: [],
        chunkIds: [],
        status: 'unresolved',
        unresolvedReason: reason,
      }),
      route,
      `chunk-token-table-placeholder-${index}`
    );
  });
}

function statusTableResources(
  resources: Map<string, ResourceNode>,
  diagnostic: ExtractionPageDiagnostic,
  route: string | undefined,
  artifactsByTrailingSegment: Map<string, ArtifactRecord[]>
): void {
  (diagnostic.statusTableDiagnostics ?? []).forEach((statusDiagnostic: StatusTableDiagnostic, index: number) => {
    const resourceName = statusDiagnostic.resourceName;
    const id = statusTableResourceId(diagnostic.path, index, resourceName ?? null);
    const unresolved = !statusDiagnostic.rendered;
    const matchedArtifact = resourceName ? findArtifactForResourceName(artifactsByTrailingSegment, resourceName) : null;
    upsertResource(
      resources,
      id,
      () => ({
        resourceId: id,
        kind: 'status-table',
        resourceName,
        sourceArtifact: matchedArtifact ? toSourceArtifactRef(matchedArtifact) : null,
        routes: [],
        pageIds: [],
        chunkIds: [],
        status: unresolved ? 'unresolved' : 'resolved',
        unresolvedReason: unresolved
          ? statusDiagnostic.unsupportedSchema
            ? 'unsupported-status-table-schema'
            : 'missing-status-table-resource'
          : null,
      }),
      route,
      `chunk-status-table-${index}`
    );
  });
}

function mediaResources(
  resources: Map<string, ResourceNode>,
  diagnostic: ExtractionPageDiagnostic,
  route: string | undefined
): void {
  for (let i = 0; i < diagnostic.imageCount; i += 1) {
    const id = imageResourceId(diagnostic.path, i);
    upsertResource(
      resources,
      id,
      () => ({
        resourceId: id,
        kind: 'image',
        resourceName: null,
        sourceArtifact: null,
        routes: [],
        pageIds: [],
        chunkIds: [],
        status: 'resolved',
        unresolvedReason: null,
      }),
      route,
      `chunk-image-${i}`
    );
  }
  for (let i = 0; i < diagnostic.videoCount; i += 1) {
    const id = videoResourceId(diagnostic.path, i);
    upsertResource(
      resources,
      id,
      () => ({
        resourceId: id,
        kind: 'video',
        resourceName: null,
        sourceArtifact: null,
        routes: [],
        pageIds: [],
        chunkIds: [],
        status: 'resolved',
        unresolvedReason: null,
      }),
      route,
      `chunk-video-${i}`
    );
  }
}

function unknownResources(
  resources: Map<string, ResourceNode>,
  diagnostic: ExtractionPageDiagnostic,
  route: string | undefined
): void {
  diagnostic.unknownResourceTypes.forEach((resourceType: string, index: number) => {
    const id = unknownResourceId(diagnostic.path, index);
    upsertResource(
      resources,
      id,
      () => ({
        resourceId: id,
        kind: 'unknown-resource',
        resourceName: resourceType,
        sourceArtifact: null,
        routes: [],
        pageIds: [],
        chunkIds: [],
        status: 'unresolved',
        unresolvedReason: `unknown-resource-type:${resourceType}`,
      }),
      route,
      `chunk-unknown-resource-${index}`
    );
  });
}

export type BuildResourceGraphInput = {
  generatedAt?: string;
  pageDiagnostics: ExtractionPageDiagnostic[];
  routeDiagnostics: ExtractionRouteDiagnostic[];
  /** Raw artifacts persisted during the crawl, matched to token-table/status-table resources by
   *  the trailing path segment of the resource name vs. the artifact's source URL/local path. */
  artifactRecords?: ArtifactRecord[];
};

export function buildResourceGraph(input: BuildResourceGraphInput): ResourceGraph {
  const routeByPath = new Map<string, string | undefined>();
  for (const routeDiagnostic of input.routeDiagnostics) {
    const route = routeDiagnostic.virtualRoute
      ?? routeDiagnostic.canonicalRoute
      ?? routeDiagnostic.sourceRoute
      ?? routeDiagnostic.normalizedRoute;
    routeByPath.set(routeDiagnostic.path, route ? normalizeGraphRoute(route) : undefined);
  }

  const artifactsByTrailingSegment = new Map<string, ArtifactRecord[]>();
  for (const artifact of input.artifactRecords ?? []) {
    if (artifact.kind !== 'dsdb-resource') continue;
    const trailingSegment = artifact.localPath.replace(/\.json$/i, '').split('/').filter(Boolean).at(-1) ?? artifact.localPath;
    const list = artifactsByTrailingSegment.get(trailingSegment);
    if (list) list.push(artifact);
    else artifactsByTrailingSegment.set(trailingSegment, [artifact]);
  }

  const resources = new Map<string, ResourceNode>();
  for (const diagnostic of input.pageDiagnostics) {
    const route = routeByPath.get(diagnostic.path);
    tokenTableResources(resources, diagnostic, route, artifactsByTrailingSegment);
    statusTableResources(resources, diagnostic, route, artifactsByTrailingSegment);
    mediaResources(resources, diagnostic, route);
    unknownResources(resources, diagnostic, route);
  }

  const graph: ResourceGraph = {
    schemaVersion: 1,
    generatedAt: input.generatedAt ?? new Date().toISOString(),
    resources: Array.from(resources.values()),
  };

  const parsed = ResourceGraphSchema.safeParse(graph);
  if (!parsed.success) {
    throw new Error(`Failed to build a valid resource graph: ${parsed.error.message}`);
  }
  return parsed.data;
}
