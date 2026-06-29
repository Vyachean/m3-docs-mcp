import type { ResourceNode } from '../graph/graph-types.js';
import type { GraphToolContext } from './context.js';

export type ExplainResourceResolutionResult = {
  available: boolean;
  message: string | null;
  found: boolean;
  resourceId: string;
  status: ResourceNode['status'] | null;
  unresolvedReason: string | null;
  routes: string[];
  chunkIds: string[];
  explanation: string;
};

/** Explains a resource's resolved/unresolved status and which routes/chunks reference it, from graph/resources.json. */
export function explainResourceResolution(context: GraphToolContext, resourceId: string): ExplainResourceResolutionResult {
  if (!context.resourceGraph) {
    return {
      available: false,
      message: 'Material 3 documentation graph (graph/resources.json) is not available yet. Run refresh_material_docs, then retry.',
      found: false,
      resourceId,
      status: null,
      unresolvedReason: null,
      routes: [],
      chunkIds: [],
      explanation: '',
    };
  }

  const resource = context.resourceGraph.resources.find((entry) => entry.resourceId === resourceId);
  if (!resource) {
    return {
      available: true,
      message: `Resource not found: ${resourceId}`,
      found: false,
      resourceId,
      status: null,
      unresolvedReason: null,
      routes: [],
      chunkIds: [],
      explanation: '',
    };
  }

  const explanation = resource.status === 'resolved'
    ? `Resource "${resourceId}" (${resource.kind}) resolved successfully across ${resource.routes.length} route(s).`
    : `Resource "${resourceId}" (${resource.kind}) is unresolved: ${resource.unresolvedReason ?? 'no reason recorded'}.`;

  return {
    available: true,
    message: null,
    found: true,
    resourceId: resource.resourceId,
    status: resource.status,
    unresolvedReason: resource.unresolvedReason,
    routes: resource.routes,
    chunkIds: resource.chunkIds,
    explanation,
  };
}
