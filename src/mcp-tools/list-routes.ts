import type { RouteGraphCoverageStatus } from '../graph/graph-types.js';
import { routeGraphAvailability, type GraphToolContext } from './context.js';

export type ListRoutesInput = {
  section?: string;
  coverageStatus?: RouteGraphCoverageStatus;
  search?: string;
  limit: number;
};

export type ListRoutesEntry = {
  route: string;
  title: string | null;
  section: string | null;
  canonicalRoute: string | null;
  coverageStatus: RouteGraphCoverageStatus;
  hasStructuredPage: boolean;
  hasMarkdown: boolean;
};

export type ListRoutesResult = {
  available: boolean;
  message: string | null;
  totalMatched: number;
  returned: number;
  truncated: boolean;
  routes: ListRoutesEntry[];
};

/**
 * Compact route catalog: route, title, section, canonicalRoute, coverage status,
 * hasStructuredPage (graph/pages.json has a node for this route), hasMarkdown (a saved Markdown
 * output path exists, per RouteNode.generatedOutputPaths / the existing index.json page list).
 */
export function listRoutes(context: GraphToolContext, input: ListRoutesInput): ListRoutesResult {
  const availability = routeGraphAvailability(context);
  if (!availability.available || !context.routeGraph) {
    return { available: false, message: availability.message, totalMatched: 0, returned: 0, truncated: false, routes: [] };
  }

  const pageRoutesByRoute = new Set((context.pageGraph?.pages ?? []).map((page) => page.route));
  const markdownPaths = new Set((context.materialIndex?.pages ?? []).map((page) => page.path));

  const search = input.search?.trim().toLowerCase();
  const section = input.section?.trim().toLowerCase();

  const matched = context.routeGraph.routes
    .filter((route) => !section || route.section?.toLowerCase() === section)
    .filter((route) => !input.coverageStatus || route.coverage.status === input.coverageStatus)
    .filter((route) => {
      if (!search) return true;
      const haystack = `${route.route} ${route.title ?? ''}`.toLowerCase();
      return haystack.includes(search);
    });

  const limited = matched.slice(0, input.limit);

  const routes: ListRoutesEntry[] = limited.map((route) => ({
    route: route.route,
    title: route.title,
    section: route.section,
    canonicalRoute: route.canonicalRoute,
    coverageStatus: route.coverage.status,
    hasStructuredPage: pageRoutesByRoute.has(route.route),
    hasMarkdown: route.generatedOutputPaths.some((outputPath) => markdownPaths.has(outputPath)),
  }));

  return {
    available: true,
    message: null,
    totalMatched: matched.length,
    returned: routes.length,
    truncated: matched.length > routes.length,
    routes,
  };
}
