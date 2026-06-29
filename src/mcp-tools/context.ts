import { readIndex } from '../cache.js';
import {
  readPageGraph,
  readProvenanceGraph,
  readResourceGraph,
  readRouteGraph,
  readSectionGraph,
  readTokenTableGraph,
} from '../graph/graph-store.js';
import type { PageGraph, ProvenanceGraph, ResourceGraph, RouteGraph, SectionGraph, TokenTableGraph } from '../graph/graph-types.js';
import { readArtifactIndex, type ArtifactIndex } from '../raw-artifacts/artifact-index.js';
import type { MaterialIndex } from '../types.js';

/**
 * Shared read-only context for graph-oriented MCP tools (src/mcp-tools/*).
 *
 * Each tool's core logic function takes a `cacheDir` (or this context) and validated input, and
 * returns a JSON-able payload — `mcp-server.ts` only wires up `server.tool(...)` registration. All
 * graph/manifest/artifact-index files are re-validated through their zod schemas on every read
 * (graph-store.ts / artifact-index.ts already do this and return null/empty on failure), per
 * AGENTS.md: data written by our own zod-validated writers is still read back as unknown and
 * re-parsed, never blindly trusted or cast.
 */
export type GraphToolContext = {
  cacheDir: string;
  routeGraph: RouteGraph | null;
  pageGraph: PageGraph | null;
  resourceGraph: ResourceGraph | null;
  tokenTableGraph: TokenTableGraph | null;
  sectionGraph: SectionGraph | null;
  provenanceGraph: ProvenanceGraph | null;
  artifactIndex: ArtifactIndex;
  materialIndex: MaterialIndex | null;
};

export async function loadGraphToolContext(cacheDir: string): Promise<GraphToolContext> {
  const [routeGraph, pageGraph, resourceGraph, tokenTableGraph, sectionGraph, provenanceGraph, artifactIndex, materialIndex] = await Promise.all([
    readRouteGraph(cacheDir),
    readPageGraph(cacheDir),
    readResourceGraph(cacheDir),
    readTokenTableGraph(cacheDir),
    readSectionGraph(cacheDir),
    readProvenanceGraph(cacheDir),
    readArtifactIndex(cacheDir),
    readIndex(cacheDir),
  ]);
  return { cacheDir, routeGraph, pageGraph, resourceGraph, tokenTableGraph, sectionGraph, provenanceGraph, artifactIndex, materialIndex };
}

/** Standard "graph not built yet" status payload shared by all graph-oriented tools. */
export type GraphAvailability = {
  available: boolean;
  message: string | null;
};

export function routeGraphAvailability(context: GraphToolContext): GraphAvailability {
  if (context.routeGraph) return { available: true, message: null };
  return {
    available: false,
    message: 'Material 3 documentation graph (graph/routes.json) is not available yet. Run refresh_material_docs, then retry.',
  };
}

export function normalizeRouteInput(route: string): string {
  return `/${route.trim().replace(/^\/+|\/+$/g, '')}`;
}

export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
