import type { TokenTableNode } from '../graph/graph-types.js';
import { routeBelongsToComponent } from './component-routes.js';
import type { GraphToolContext } from './context.js';

export type GetComponentTokensResult = {
  available: boolean;
  message: string | null;
  component: string;
  found: boolean;
  tokenTables: TokenTableNode[];
};

/**
 * Token/status tables for a component's routes — token names, values, roles, source artifact
 * ids/source URLs (via routes -> sourceArtifacts) for the component's matched routes in
 * graph/token-tables.json. Component matching reuses a minimal local prefix matcher
 * (component-routes.ts) rather than importing MaterialDocsStore's private alias resolution.
 */
export function getComponentTokens(context: GraphToolContext, componentName: string): GetComponentTokensResult {
  if (!context.tokenTableGraph) {
    return {
      available: false,
      message: 'Material 3 documentation graph (graph/token-tables.json) is not available yet. Run refresh_material_docs, then retry.',
      component: componentName,
      found: false,
      tokenTables: [],
    };
  }

  const matched = context.tokenTableGraph.tokenTables.filter((table) =>
    table.routes.some((route) => routeBelongsToComponent(route, componentName))
  );

  if (matched.length === 0) {
    return {
      available: true,
      message: `No token tables found for component: ${componentName}`,
      component: componentName,
      found: false,
      tokenTables: [],
    };
  }

  return { available: true, message: null, component: componentName, found: true, tokenTables: matched };
}
