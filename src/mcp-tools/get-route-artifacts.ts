import type { ArtifactRecord } from '../raw-artifacts/artifact-types.js';
import { findArtifactById } from '../raw-artifacts/artifact-index.js';
import { normalizeRouteInput, routeGraphAvailability, type GraphToolContext } from './context.js';

export type RouteArtifactSummary = {
  artifactId: string;
  kind: ArtifactRecord['kind'];
  sourceUrl: string;
  sha256: string;
  fetchedAt: string;
  httpStatus: number | null;
};

export type GetRouteArtifactsResult = {
  available: boolean;
  message: string | null;
  found: boolean;
  route: string;
  artifacts: RouteArtifactSummary[];
};

/** Compact list of raw artifact ids/kinds/source URLs/hashes associated with a route — metadata only, never content. */
export function getRouteArtifacts(context: GraphToolContext, route: string): GetRouteArtifactsResult {
  const availability = routeGraphAvailability(context);
  if (!availability.available || !context.routeGraph) {
    return { available: false, message: availability.message, found: false, route: normalizeRouteInput(route), artifacts: [] };
  }

  const normalizedRoute = normalizeRouteInput(route);
  const routeNode = context.routeGraph.routes.find((entry) => entry.route === normalizedRoute)
    ?? context.routeGraph.routes.find((entry) => entry.canonicalRoute === normalizedRoute || entry.aliases.includes(normalizedRoute))
    ?? null;
  if (!routeNode) {
    return { available: true, message: `Route not found: ${normalizedRoute}`, found: false, route: normalizedRoute, artifacts: [] };
  }

  const artifacts: RouteArtifactSummary[] = routeNode.sourceArtifacts
    .map((ref) => findArtifactById(context.artifactIndex, ref.artifactId))
    .filter((record): record is ArtifactRecord => record !== null)
    .map((record) => ({
      artifactId: record.id,
      kind: record.kind,
      sourceUrl: record.sourceUrl,
      sha256: record.sha256,
      fetchedAt: record.fetchedAt,
      httpStatus: record.httpStatus,
    }));

  return { available: true, message: null, found: true, route: normalizedRoute, artifacts };
}
