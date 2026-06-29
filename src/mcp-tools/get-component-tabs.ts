import type { RouteTabNode } from '../graph/graph-types.js';
import { routeBelongsToComponent } from './component-routes.js';
import { routeGraphAvailability, type GraphToolContext } from './context.js';

export type ComponentTabsEntry = {
  route: string;
  tabs: RouteTabNode[];
};

export type GetComponentTabsResult = {
  available: boolean;
  message: string | null;
  component: string;
  found: boolean;
  routes: ComponentTabsEntry[];
};

/** Compact tabs-per-route listing for a component's matched routes, from graph/routes.json. */
export function getComponentTabs(context: GraphToolContext, componentName: string): GetComponentTabsResult {
  const availability = routeGraphAvailability(context);
  if (!availability.available || !context.routeGraph) {
    return { available: false, message: availability.message, component: componentName, found: false, routes: [] };
  }

  const matched = context.routeGraph.routes
    .filter((route) => routeBelongsToComponent(route.route, componentName))
    .filter((route) => route.tabs.length > 0)
    .map((route) => ({ route: route.route, tabs: route.tabs }));

  if (matched.length === 0) {
    return { available: true, message: `No tabbed routes found for component: ${componentName}`, component: componentName, found: false, routes: [] };
  }

  return { available: true, message: null, component: componentName, found: true, routes: matched };
}
