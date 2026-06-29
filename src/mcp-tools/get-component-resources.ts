import type { ResourceNode } from '../graph/graph-types.js';
import { routeBelongsToComponent } from './component-routes.js';
import type { GraphToolContext } from './context.js';

export type GetComponentResourcesResult = {
  available: boolean;
  message: string | null;
  component: string;
  found: boolean;
  resources: ResourceNode[];
};

/** Compact resource listing (images/videos/token-tables/status-tables) for a component's routes, from graph/resources.json. */
export function getComponentResources(context: GraphToolContext, componentName: string): GetComponentResourcesResult {
  if (!context.resourceGraph) {
    return {
      available: false,
      message: 'Material 3 documentation graph (graph/resources.json) is not available yet. Run refresh_material_docs, then retry.',
      component: componentName,
      found: false,
      resources: [],
    };
  }

  const matched = context.resourceGraph.resources.filter((resource) =>
    resource.routes.some((route) => routeBelongsToComponent(route, componentName))
  );

  if (matched.length === 0) {
    return { available: true, message: `No resources found for component: ${componentName}`, component: componentName, found: false, resources: [] };
  }

  return { available: true, message: null, component: componentName, found: true, resources: matched };
}
