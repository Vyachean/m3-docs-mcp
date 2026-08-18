import type { ResourceKind, RouteGraphCoverageStatus } from '../graph/graph-types.js';
import { normalizeComponentSlug, routeBelongsToComponent } from './component-routes.js';
import { routeGraphAvailability, type GraphToolContext } from './context.js';

export type ComponentOverviewRoute = {
  route: string;
  title: string | null;
  coverageStatus: RouteGraphCoverageStatus;
  hasStructuredPage: boolean;
};

export type ComponentOverviewTab = {
  label: string;
  route: string;
};

export type ComponentOverviewTokenTable = {
  resourceId: string;
  resourceName: string | null;
  tokenSetCount: number;
  tokenCount: number;
  unresolvedTokenCount: number;
};

export type ComponentResourceCounts = Record<ResourceKind, number>;

export type GetComponentOverviewResult = {
  available: boolean;
  message: string | null;
  component: string;
  found: boolean;
  canonicalName: string | null;
  componentSlug: string | null;
  routes: ComponentOverviewRoute[];
  tabs: ComponentOverviewTab[];
  tokenTables: ComponentOverviewTokenTable[];
  resourceCounts: ComponentResourceCounts;
  recommendedRoutes: string[];
};

const RESOURCE_KINDS: ResourceKind[] = [
  'token-table',
  'status-table',
  'image',
  'video',
  'unknown-resource',
];

function emptyResourceCounts(): ComponentResourceCounts {
  return {
    'token-table': 0,
    'status-table': 0,
    image: 0,
    video: 0,
    'unknown-resource': 0,
  };
}

function routeComponentSlug(route: string): string | null {
  const segments = route.replace(/^\/+|\/+$/g, '').split('/');
  return segments[0] === 'components' && segments[1] ? segments[1] : null;
}

function routeRecommendationRank(route: string): number {
  if (route.endsWith('/specs')) return 0;
  if (route.endsWith('/overview')) return 1;
  if (route.replace(/^\/+|\/+$/g, '').split('/').length === 2) return 2;
  return 3;
}

/**
 * Compact agent entry point for a component. It deliberately summarizes the existing route,
 * page, resource, and token-table graphs instead of introducing another source of truth or
 * returning full token/resource payloads. Agents can use the returned routes and counts to choose
 * a focused follow-up tool such as get_page, get_component_tokens, or get_component_resources.
 */
export function getComponentOverview(context: GraphToolContext, componentName: string): GetComponentOverviewResult {
  const availability = routeGraphAvailability(context);
  if (!availability.available || !context.routeGraph) {
    return {
      available: false,
      message: availability.message,
      component: componentName,
      found: false,
      canonicalName: null,
      componentSlug: null,
      routes: [],
      tabs: [],
      tokenTables: [],
      resourceCounts: emptyResourceCounts(),
      recommendedRoutes: [],
    };
  }

  const matchedRoutes = context.routeGraph.routes.filter((route) => routeBelongsToComponent(route.route, componentName));
  if (matchedRoutes.length === 0) {
    return {
      available: true,
      message: `Component not found: ${componentName}`,
      component: componentName,
      found: false,
      canonicalName: null,
      componentSlug: normalizeComponentSlug(componentName) || null,
      routes: [],
      tabs: [],
      tokenTables: [],
      resourceCounts: emptyResourceCounts(),
      recommendedRoutes: [],
    };
  }

  const pageRoutes = new Set((context.pageGraph?.pages ?? []).map((page) => page.route));
  const sortedRouteNodes = [...matchedRoutes].sort((left, right) => {
    const rankDelta = routeRecommendationRank(left.route) - routeRecommendationRank(right.route);
    return rankDelta !== 0 ? rankDelta : left.route.localeCompare(right.route);
  });
  const componentSlug = sortedRouteNodes.map((route) => routeComponentSlug(route.route)).find((slug) => slug !== null) ?? null;
  const rootRoute = matchedRoutes.find((route) => route.route === `/components/${componentSlug}`) ?? matchedRoutes[0] ?? null;

  const routes: ComponentOverviewRoute[] = matchedRoutes
    .map((route) => ({
      route: route.route,
      title: route.title,
      coverageStatus: route.coverage.status,
      hasStructuredPage: pageRoutes.has(route.route),
    }))
    .sort((left, right) => left.route.localeCompare(right.route));

  const seenTabs = new Set<string>();
  const tabs: ComponentOverviewTab[] = [];
  for (const route of matchedRoutes) {
    for (const tab of route.tabs) {
      if (seenTabs.has(tab.route)) continue;
      seenTabs.add(tab.route);
      tabs.push({ label: tab.label, route: tab.route });
    }
  }
  tabs.sort((left, right) => left.route.localeCompare(right.route));

  const tokenTables = (context.tokenTableGraph?.tokenTables ?? [])
    .filter((table) => table.routes.some((route) => routeBelongsToComponent(route, componentName)))
    .map((table): ComponentOverviewTokenTable => ({
      resourceId: table.resourceId,
      resourceName: table.resourceName,
      tokenSetCount: table.tokenSets.length,
      tokenCount: table.tokenSets.reduce((total, tokenSet) => total + tokenSet.tokens.length, 0),
      unresolvedTokenCount: table.unresolvedTokenCount,
    }));

  const resourceCounts = emptyResourceCounts();
  for (const resource of context.resourceGraph?.resources ?? []) {
    if (!resource.routes.some((route) => routeBelongsToComponent(route, componentName))) continue;
    if (RESOURCE_KINDS.includes(resource.kind)) resourceCounts[resource.kind] += 1;
  }

  const recommendedRoutes = sortedRouteNodes
    .filter((route) => pageRoutes.has(route.route))
    .map((route) => route.route)
    .slice(0, 5);

  return {
    available: true,
    message: null,
    component: componentName,
    found: true,
    canonicalName: rootRoute?.title ?? componentSlug,
    componentSlug,
    routes,
    tabs,
    tokenTables,
    resourceCounts,
    recommendedRoutes,
  };
}
