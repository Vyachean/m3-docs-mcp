import { normalizeMaterialPublicDocPath } from '../crawler-utils.js';
import type { RouteCandidateSource, RoutePlanEntry, RoutePlanSummary } from '../types.js';
import type { SiteMeta } from './fetch-site-meta.js';
import type { NormalizedRoute } from './normalize-routes.js';
import type { BundleRouteEntry } from './page-reference-resolver.js';

type RouteCandidate = {
  route: string;
  sources: Set<RouteCandidateSource>;
  title?: string;
  public?: boolean;
  redirectExternalUrl?: string | null;
  collectionId?: string | null;
  documentId?: string | null;
  exportedCarbonFileId?: string | null;
  carbonPath?: string | null;
  pageCanonId?: string | null;
  tabs?: string[];
  alternateSlugs?: string[];
};

type ReconciledRoute = RoutePlanEntry & {
  bundleEntry?: BundleRouteEntry;
};

function normalizeRoute(path: string): string {
  if (path === '/' || path === '') return '/';
  return `/${path.replace(/^\/+|\/+$/g, '')}`;
}

function normalizeFinalToken(token: string): string {
  if (token.endsWith('ies') && token.length > 3) return `${token.slice(0, -3)}y`;
  if (token.endsWith('es') && token.length > 3) return token.slice(0, -2);
  if (token.endsWith('s') && token.length > 2) return token.slice(0, -1);
  return token;
}

function normalizeComparableRoute(path: string): string {
  const tokens = normalizeRoute(path).replace(/^\/+/, '').split('/').filter(Boolean);
  if (tokens[tokens.length - 1] === 'overview') tokens.pop();
  if (tokens.length > 0) tokens[tokens.length - 1] = normalizeFinalToken(tokens[tokens.length - 1]!);
  return tokens.join('/');
}

function isDocsPath(path: string, includeBlog: boolean): boolean {
  const normalized = normalizeRoute(path);
  if (normalized.startsWith('/go/')) return false;
  if (normalized === '/components' || normalized === '/styles' || normalized === '/foundations') return true;
  if (normalized.startsWith('/components/')) return true;
  if (normalized.startsWith('/styles/')) return true;
  if (normalized.startsWith('/foundations/')) return true;
  if (normalized.startsWith('/develop/')) return true;
  if (normalized.startsWith('/blog/')) return includeBlog;
  return false;
}

function addCandidate(map: Map<string, RouteCandidate>, route: string, source: RouteCandidateSource, patch: Partial<RouteCandidate> = {}): void {
  const normalized = normalizeRoute(route);
  const current = map.get(normalized) ?? { route: normalized, sources: new Set<RouteCandidateSource>() };
  current.sources.add(source);
  if (patch.title && !current.title) current.title = patch.title;
  if (patch.public !== undefined) current.public = patch.public;
  if (patch.redirectExternalUrl !== undefined) current.redirectExternalUrl = patch.redirectExternalUrl;
  if (patch.collectionId && !current.collectionId) current.collectionId = patch.collectionId;
  if (patch.documentId && !current.documentId) current.documentId = patch.documentId;
  if (patch.exportedCarbonFileId && !current.exportedCarbonFileId) current.exportedCarbonFileId = patch.exportedCarbonFileId;
  if (patch.carbonPath && !current.carbonPath) current.carbonPath = patch.carbonPath;
  if (patch.pageCanonId && !current.pageCanonId) current.pageCanonId = patch.pageCanonId;
  if (patch.tabs && !current.tabs) current.tabs = patch.tabs;
  if (patch.alternateSlugs) {
    current.alternateSlugs = Array.from(new Set([...(current.alternateSlugs ?? []), ...patch.alternateSlugs]));
  }
  map.set(normalized, current);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function extractNavDrawerRoutes(siteMeta: SiteMeta, baseUrl: string): string[] {
  const navDrawers = isRecord(siteMeta) && 'nav_drawers' in siteMeta ? (siteMeta as Record<string, unknown>).nav_drawers : undefined;
  const found = new Set<string>();
  const visit = (value: unknown): void => {
    if (Array.isArray(value)) {
      for (const item of value) visit(item);
      return;
    }
    if (!isRecord(value)) return;
    for (const [key, inner] of Object.entries(value)) {
      if (key === 'href' && typeof inner === 'string') {
        const path = normalizeMaterialPublicDocPath(inner, baseUrl);
        if (path) found.add(path);
      } else {
        visit(inner);
      }
    }
  };
  visit(navDrawers);
  return Array.from(found).sort();
}

function toPlanEntry(
  candidate: RouteCandidate,
  overrides: Partial<RoutePlanEntry> & Pick<RoutePlanEntry, 'reconciliationStatus'>
): RoutePlanEntry {
  return {
    route: candidate.route,
    sources: Array.from(candidate.sources).sort(),
    ...(candidate.title ? { title: candidate.title } : {}),
    ...(candidate.public !== undefined ? { public: candidate.public } : {}),
    ...(candidate.redirectExternalUrl !== undefined ? { redirectExternalUrl: candidate.redirectExternalUrl } : {}),
    ...(candidate.collectionId ? { collectionId: candidate.collectionId } : {}),
    ...(candidate.documentId ? { documentId: candidate.documentId } : {}),
    ...(candidate.exportedCarbonFileId ? { exportedCarbonFileId: candidate.exportedCarbonFileId } : {}),
    ...(candidate.carbonPath ? { carbonPath: candidate.carbonPath } : {}),
    ...(candidate.pageCanonId ? { pageCanonId: candidate.pageCanonId } : {}),
    ...(candidate.tabs ? { tabs: candidate.tabs } : {}),
    ...(candidate.alternateSlugs ? { alternateSlugs: candidate.alternateSlugs } : {}),
    ...overrides,
  };
}

function reconcileCandidate(candidate: RouteCandidate, bundleRoutes: BundleRouteEntry[]): ReconciledRoute {
  const exact = bundleRoutes.find((entry) => normalizeRoute(entry.slug) === candidate.route);
  if (exact) {
    return { ...toPlanEntry(candidate, { canonicalRoute: normalizeRoute(exact.slug), outputPath: `${exact.slug}.md`, reconciliationStatus: 'exact' }), bundleEntry: exact };
  }

  const viaAlternate = bundleRoutes.find((entry) => entry.alternateSlugs?.some((slug) => normalizeRoute(slug) === candidate.route));
  if (viaAlternate) {
    return { ...toPlanEntry(candidate, { canonicalRoute: normalizeRoute(viaAlternate.slug), outputPath: `${viaAlternate.slug}.md`, reconciliationStatus: 'alternateSlug' }), bundleEntry: viaAlternate };
  }

  const identityMatches = bundleRoutes.filter((entry) => {
    if (candidate.collectionId && candidate.documentId) return entry.collectionId === candidate.collectionId && entry.documentId === candidate.documentId;
    if (candidate.exportedCarbonFileId) return entry.exportedCarbonFileId === candidate.exportedCarbonFileId;
    return false;
  });
  if (identityMatches.length === 1) {
    const matched = identityMatches[0]!;
    return { ...toPlanEntry(candidate, { canonicalRoute: normalizeRoute(matched.slug), outputPath: `${matched.slug}.md`, reconciliationStatus: 'contentIdentityMatch' }), bundleEntry: matched };
  }
  if (identityMatches.length > 1) {
    return toPlanEntry(candidate, { reconciliationStatus: 'rejectedAmbiguous', skippedReason: 'multiple bundle entries share content identity' });
  }

  const normalizedCandidate = normalizeComparableRoute(candidate.route);
  const normalizedMatches = bundleRoutes.filter((entry) => normalizeComparableRoute(entry.slug) === normalizedCandidate);
  if (normalizedMatches.length === 1) {
    const matched = normalizedMatches[0]!;
    return { ...toPlanEntry(candidate, { canonicalRoute: normalizeRoute(matched.slug), outputPath: `${matched.slug}.md`, reconciliationStatus: 'normalizedSlugMatch' }), bundleEntry: matched };
  }
  if (normalizedMatches.length > 1) {
    return toPlanEntry(candidate, { reconciliationStatus: 'rejectedAmbiguous', skippedReason: 'normalized slug matched multiple bundle routes' });
  }

  return toPlanEntry(candidate, { reconciliationStatus: 'rejectedStale', skippedReason: 'no bundle route or stable content identity match' });
}

export function buildRoutePlan(params: {
  baseUrl: string;
  includeBlog: boolean;
  siteMeta: SiteMeta | null;
  normalizedSiteMetaRoutes: NormalizedRoute[];
  bundleRoutes: BundleRouteEntry[];
  sitemapPaths: string[];
  renderedNavPaths?: string[];
}): RoutePlanSummary {
  const { baseUrl, includeBlog, siteMeta, normalizedSiteMetaRoutes, bundleRoutes, sitemapPaths, renderedNavPaths = [] } = params;
  const candidates = new Map<string, RouteCandidate>();

  for (const route of normalizedSiteMetaRoutes) {
    addCandidate(candidates, route.path, 'site_meta', {
      public: route.public,
      redirectExternalUrl: route.redirectExternalUrl,
      collectionId: route.collectionId,
      documentId: route.documentId,
    });
    for (const alias of route.aliases) {
      addCandidate(candidates, alias, 'site_meta', { public: route.public, redirectExternalUrl: route.redirectExternalUrl });
    }
  }

  if (siteMeta) {
    for (const navRoute of extractNavDrawerRoutes(siteMeta, baseUrl)) {
      addCandidate(candidates, navRoute, 'nav_drawer');
    }
  }

  for (const entry of bundleRoutes) {
    addCandidate(candidates, entry.slug, 'bundle', {
      collectionId: entry.collectionId ?? null,
      documentId: entry.documentId ?? null,
      exportedCarbonFileId: entry.exportedCarbonFileId ?? null,
      carbonPath: entry.carbonPath ?? null,
      tabs: entry.tabs?.map((tab) => tab.label),
      alternateSlugs: entry.alternateSlugs,
    });
  }

  for (const path of sitemapPaths) addCandidate(candidates, path, 'sitemap');
  for (const path of renderedNavPaths) addCandidate(candidates, path, 'rendered_nav');

  const acceptedRoutes: RoutePlanEntry[] = [];
  const staleRoutes: RoutePlanEntry[] = [];
  const removedRoutes: RoutePlanEntry[] = [];
  const ambiguousRoutes: RoutePlanEntry[] = [];
  const nonPublicRoutes: RoutePlanEntry[] = [];
  const extractionCandidates: RoutePlanEntry[] = [];

  const candidatePriority = (candidate: RouteCandidate): number => {
    if (candidate.sources.has('site_meta')) return 0;
    if (candidate.sources.has('nav_drawer')) return 1;
    if (candidate.sources.has('sitemap')) return 2;
    if (candidate.sources.has('rendered_nav')) return 3;
    return 4;
  };

  for (const candidate of Array.from(candidates.values()).sort((a, b) => {
    const priorityDiff = candidatePriority(a) - candidatePriority(b);
    if (priorityDiff !== 0) return priorityDiff;
    const lengthDiff = a.route.length - b.route.length;
    if (lengthDiff !== 0) return lengthDiff;
    return a.route.localeCompare(b.route);
  })) {
    const docsPath = isDocsPath(candidate.route, includeBlog);
    const isPublic = candidate.public !== false && !candidate.redirectExternalUrl && docsPath;
    if (!isPublic) {
      nonPublicRoutes.push(toPlanEntry(candidate, { reconciliationStatus: 'rejectedNonPublic', skippedReason: 'route is not a public documentation page' }));
      continue;
    }

    const reconciled = reconcileCandidate(candidate, bundleRoutes);
    if (reconciled.reconciliationStatus === 'rejectedAmbiguous') {
      ambiguousRoutes.push(reconciled);
      continue;
    }
    if (reconciled.reconciliationStatus === 'rejectedStale') {
      staleRoutes.push(reconciled);
      removedRoutes.push(reconciled);
      continue;
    }

    acceptedRoutes.push(reconciled);
    extractionCandidates.push(reconciled);
  }

  return {
    acceptedRoutes,
    staleRoutes,
    removedRoutes,
    ambiguousRoutes,
    nonPublicRoutes,
    extractionCandidates,
  };
}
