import { normalizeMaterialPublicDocPath } from '../crawler-utils.js';
import type { CompactRoutePlanSummary, PublicDocsClassification, RouteCandidateSource, RoutePlanEntry, RoutePlanSummary, RouteReconciliationStatus } from '../types.js';
import type { SiteMeta } from './fetch-site-meta.js';
import type { NormalizedRoute } from './normalize-routes.js';
import type { BundleRouteEntry } from './page-reference-resolver.js';

type RouteCandidate = {
  route: string;
  sources: Set<RouteCandidateSource>;
  navTitle?: string;
  routeTitle?: string;
  public?: boolean;
  redirectExternalUrl?: string | null;
  collectionId?: string | null;
  documentId?: string | null;
  exportedCarbonFileId?: string | null;
  carbonPath?: string | null;
  pageCanonId?: string | null;
  verifiedIdentity?: boolean;
  tabs?: string[];
  alternateSlugs?: string[];
};

type ReconciledRoute = RoutePlanEntry & {
  bundleEntry?: BundleRouteEntry;
};

const COMPACT_ROUTE_PLAN_EXAMPLE_LIMIT = 5;

function normalizeRoute(path: string): string {
  if (path === '/' || path === '') return '/';
  return `/${path.replace(/^\/+|\/+$/g, '')}`;
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
  if (patch.navTitle && !current.navTitle) current.navTitle = patch.navTitle;
  if (patch.routeTitle && !current.routeTitle) current.routeTitle = patch.routeTitle;
  if (patch.public !== undefined) current.public = patch.public;
  if (patch.redirectExternalUrl !== undefined) current.redirectExternalUrl = patch.redirectExternalUrl;
  if (patch.collectionId && !current.collectionId) current.collectionId = patch.collectionId;
  if (patch.documentId && !current.documentId) current.documentId = patch.documentId;
  if (patch.exportedCarbonFileId && !current.exportedCarbonFileId) current.exportedCarbonFileId = patch.exportedCarbonFileId;
  if (patch.carbonPath && !current.carbonPath) current.carbonPath = patch.carbonPath;
  if (patch.pageCanonId && !current.pageCanonId) current.pageCanonId = patch.pageCanonId;
  if (patch.verifiedIdentity !== undefined) current.verifiedIdentity = patch.verifiedIdentity;
  if (patch.tabs && !current.tabs) current.tabs = patch.tabs;
  if (patch.alternateSlugs) {
    current.alternateSlugs = Array.from(new Set([...(current.alternateSlugs ?? []), ...patch.alternateSlugs]));
  }
  map.set(normalized, current);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function firstString(value: Record<string, unknown>, keys: string[]): string | undefined {
  for (const key of keys) {
    const inner = value[key];
    if (typeof inner === 'string' && inner.trim().length > 0) return inner.trim();
  }
  return undefined;
}

function extractNavDrawerRoutes(siteMeta: SiteMeta, baseUrl: string): Array<{ route: string; navTitle?: string }> {
  const navDrawers = isRecord(siteMeta) ? siteMeta.nav_drawers : undefined;
  const found = new Map<string, string | undefined>();
  const visit = (value: unknown): void => {
    if (Array.isArray(value)) {
      for (const item of value) visit(item);
      return;
    }
    if (!isRecord(value)) return;
    const href = typeof value.href === 'string' ? value.href : undefined;
    if (href) {
      const path = normalizeMaterialPublicDocPath(href, baseUrl);
      if (path && !found.has(path)) found.set(path, firstString(value, ['label', 'title', 'name']));
    }
    for (const inner of Object.values(value)) visit(inner);
  };
  visit(navDrawers);
  return Array.from(found.entries())
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([route, navTitle]) => ({ route, navTitle }));
}

function classifyPublicDocsRoute(
  route: string,
  includeBlog: boolean,
  candidate: RouteCandidate,
  bundleEntry?: BundleRouteEntry
): PublicDocsClassification {
  const normalized = normalizeRoute(route);
  const isBundleOnlyCandidate = candidate.sources.has('bundle') && !candidate.sources.has('site_meta') && !candidate.sources.has('nav_drawer');
  if (candidate.redirectExternalUrl) return 'redirect';
  if (normalized.startsWith('/go/')) return 'go-link';
  if (/\.(png|jpg|jpeg|gif|svg|webp|css|js|xml|txt|json)$/i.test(normalized)) return 'asset';
  if (isBundleOnlyCandidate && (normalized === '/components' || normalized === '/styles' || normalized === '/foundations')) {
    return 'non-content-index';
  }
  if (normalized.startsWith('/develop/android')
    || normalized.startsWith('/develop/web')
    || normalized.startsWith('/develop/ios')
    || normalized.startsWith('/develop/flutter')
    || normalized.startsWith('/develop/compose')
    || normalized.startsWith('/develop/views')
    || normalized.startsWith('/develop/figma')
    || normalized.startsWith('/policies/')
    || normalized.startsWith('/platform/')) {
    return 'unsupported-platform-or-policy';
  }
  if (!isDocsPath(normalized, includeBlog)) return 'outside-public-docs';
  const metadataSource = bundleEntry ?? candidate;
  if (isBundleOnlyCandidate && (!metadataSource.collectionId || !metadataSource.documentId)) return 'missing-extraction-metadata';
  return 'public-docs';
}

function normalizeComponentToken(token: string): string[] {
  const normalized = token.toLowerCase();
  const variants = new Set<string>([normalized]);
  if (normalized.endsWith('ies') && normalized.length > 3) variants.add(`${normalized.slice(0, -3)}y`);
  if (normalized.endsWith('es') && normalized.length > 3) variants.add(normalized.slice(0, -2));
  if (normalized.endsWith('s') && normalized.length > 2) variants.add(normalized.slice(0, -1));
  return Array.from(variants);
}

function getSafeComponentComparableRoutes(path: string): string[] {
  const normalized = normalizeRoute(path).replace(/^\/+/, '');
  const tokens = normalized.split('/').filter(Boolean);
  if (tokens[0] !== 'components') return [];
  if (tokens.length !== 2 && !(tokens.length === 3 && tokens[2] === 'overview')) return [];
  const target = tokens[1];
  if (!target) return [];
  const suffixes = tokens.length === 3 ? ['/overview'] : ['', '/overview'];
  return Array.from(new Set(
    normalizeComponentToken(target).flatMap((variant) => suffixes.map((suffix) => `components/${variant}${suffix}`))
  ));
}

function normalizeIdentityToken(value: string | null | undefined): string | null {
  if (!value) return null;
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed.toLowerCase() : null;
}

function collectVerifiedIdentityMatches(candidate: RouteCandidate, bundleRoutes: BundleRouteEntry[]): { matches: BundleRouteEntry[]; identityFieldsUsed: string[] } {
  const matches = new Set<BundleRouteEntry>();
  const identityFieldsUsed: string[] = [];
  const exportedId = normalizeIdentityToken(candidate.exportedCarbonFileId);
  if (exportedId) {
    const byExported = bundleRoutes.filter((entry) => normalizeIdentityToken(entry.exportedCarbonFileId) === exportedId);
    if (byExported.length > 0) {
      identityFieldsUsed.push('exportedCarbonFileId');
      for (const entry of byExported) matches.add(entry);
    }
  }
  const pageCanonId = normalizeIdentityToken(candidate.pageCanonId);
  if (pageCanonId) {
    const byCanon = bundleRoutes.filter((entry) => normalizeIdentityToken(entry.pageCanonId) === pageCanonId);
    if (byCanon.length > 0) {
      identityFieldsUsed.push('pageCanonId');
      for (const entry of byCanon) matches.add(entry);
    }
  }
  if (candidate.collectionId && candidate.documentId) {
    if (candidate.verifiedIdentity) {
      const byVerifiedPair = bundleRoutes.filter(
        (entry) => entry.collectionId === candidate.collectionId && entry.documentId === candidate.documentId
      );
      if (byVerifiedPair.length > 0) {
        identityFieldsUsed.push('collectionId+documentId');
        for (const entry of byVerifiedPair) matches.add(entry);
      }
    }
  }
  return { matches: Array.from(matches), identityFieldsUsed };
}

function toPlanEntry(
  candidate: RouteCandidate,
  overrides: Partial<RoutePlanEntry> & Pick<RoutePlanEntry, 'reconciliationStatus' | 'publicDocsClassification'>
): RoutePlanEntry {
  return {
    route: candidate.route,
    sources: Array.from(candidate.sources).sort(),
    ...(candidate.navTitle ? { navTitle: candidate.navTitle } : {}),
    ...(candidate.routeTitle ? { routeTitle: candidate.routeTitle } : {}),
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

function reconcileCandidate(candidate: RouteCandidate, bundleRoutes: BundleRouteEntry[], includeBlog: boolean): ReconciledRoute {
  const exact = bundleRoutes.find((entry) => normalizeRoute(entry.slug) === candidate.route);
  if (exact) {
    return {
      ...toPlanEntry(candidate, {
        canonicalRoute: normalizeRoute(exact.slug),
        outputPath: `${exact.slug}.md`,
        routeTitle: candidate.routeTitle ?? exact.title,
        collectionId: exact.collectionId ?? candidate.collectionId,
        documentId: exact.documentId ?? candidate.documentId,
        exportedCarbonFileId: exact.exportedCarbonFileId ?? candidate.exportedCarbonFileId,
        carbonPath: exact.carbonPath ?? candidate.carbonPath,
        pageCanonId: exact.pageCanonId ?? candidate.pageCanonId,
        publicDocsClassification: classifyPublicDocsRoute(candidate.route, includeBlog, candidate, exact),
        identityFieldsUsed: ['slug'],
        reconciliationStatus: 'exact'
      }),
      bundleEntry: exact
    };
  }

  const viaAlternate = bundleRoutes.find((entry) => entry.alternateSlugs?.some((slug) => normalizeRoute(slug) === candidate.route));
  if (viaAlternate) {
    return {
      ...toPlanEntry(candidate, {
        canonicalRoute: normalizeRoute(viaAlternate.slug),
        outputPath: `${viaAlternate.slug}.md`,
        routeTitle: candidate.routeTitle ?? viaAlternate.title,
        collectionId: viaAlternate.collectionId ?? candidate.collectionId,
        documentId: viaAlternate.documentId ?? candidate.documentId,
        exportedCarbonFileId: viaAlternate.exportedCarbonFileId ?? candidate.exportedCarbonFileId,
        carbonPath: viaAlternate.carbonPath ?? candidate.carbonPath,
        pageCanonId: viaAlternate.pageCanonId ?? candidate.pageCanonId,
        publicDocsClassification: classifyPublicDocsRoute(candidate.route, includeBlog, candidate, viaAlternate),
        identityFieldsUsed: ['alternateSlug'],
        reconciliationStatus: 'alternateSlug'
      }),
      bundleEntry: viaAlternate
    };
  }

  const { matches: identityMatches, identityFieldsUsed } = collectVerifiedIdentityMatches(candidate, bundleRoutes);
  if (identityMatches.length === 1) {
    const matched = identityMatches[0]!;
    return {
      ...toPlanEntry(candidate, {
        canonicalRoute: normalizeRoute(matched.slug),
        outputPath: `${matched.slug}.md`,
        routeTitle: candidate.routeTitle ?? matched.title,
        collectionId: matched.collectionId ?? candidate.collectionId,
        documentId: matched.documentId ?? candidate.documentId,
        exportedCarbonFileId: matched.exportedCarbonFileId ?? candidate.exportedCarbonFileId,
        carbonPath: matched.carbonPath ?? candidate.carbonPath,
        pageCanonId: matched.pageCanonId ?? candidate.pageCanonId,
        publicDocsClassification: classifyPublicDocsRoute(candidate.route, includeBlog, candidate, matched),
        identityFieldsUsed,
        reconciliationStatus: 'contentIdentityMatch'
      }),
      bundleEntry: matched
    };
  }
  if (identityMatches.length > 1) {
    return toPlanEntry(candidate, {
      publicDocsClassification: 'public-docs',
      identityFieldsUsed,
      reconciliationStatus: 'rejectedAmbiguous',
      skippedReason: 'multiple bundle entries share content identity',
      failureReason: 'multiple bundle entries share verified content identity'
    });
  }

  const comparableCandidates = getSafeComponentComparableRoutes(candidate.route);
  const normalizedMatches = comparableCandidates.length === 0
    ? []
    : bundleRoutes.filter((entry) => comparableCandidates.includes(entry.slug));
  if (normalizedMatches.length === 1) {
    const matched = normalizedMatches[0]!;
    return {
      ...toPlanEntry(candidate, {
        canonicalRoute: normalizeRoute(matched.slug),
        outputPath: `${matched.slug}.md`,
        routeTitle: candidate.routeTitle ?? matched.title,
        collectionId: matched.collectionId ?? candidate.collectionId,
        documentId: matched.documentId ?? candidate.documentId,
        exportedCarbonFileId: matched.exportedCarbonFileId ?? candidate.exportedCarbonFileId,
        carbonPath: matched.carbonPath ?? candidate.carbonPath,
        pageCanonId: matched.pageCanonId ?? candidate.pageCanonId,
        publicDocsClassification: classifyPublicDocsRoute(candidate.route, includeBlog, candidate, matched),
        identityFieldsUsed: ['normalizedComponentSlug'],
        reconciliationStatus: 'normalizedSlugMatch'
      }),
      bundleEntry: matched
    };
  }
  if (normalizedMatches.length > 1) {
    return toPlanEntry(candidate, {
      publicDocsClassification: 'public-docs',
      identityFieldsUsed: ['normalizedComponentSlug'],
      reconciliationStatus: 'rejectedAmbiguous',
      skippedReason: 'normalized slug matched multiple bundle routes',
      failureReason: 'normalized component slug matched multiple bundle routes'
    });
  }

  return toPlanEntry(candidate, {
    publicDocsClassification: 'public-docs',
    reconciliationStatus: 'rejectedStale',
    skippedReason: 'no bundle route or stable content identity match',
    failureReason: 'no verified identity or unambiguous component route match'
  });
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
    const routeRecord = route as NormalizedRoute & {
      exportedCarbonFileId?: string | null;
      pageCanonId?: string | null;
      routeTitle?: string;
      navTitle?: string;
    };
    addCandidate(candidates, route.path, 'site_meta', {
      public: route.public,
      redirectExternalUrl: route.redirectExternalUrl,
      collectionId: route.collectionId,
      documentId: route.documentId,
      exportedCarbonFileId: routeRecord.exportedCarbonFileId ?? null,
      pageCanonId: routeRecord.pageCanonId ?? null,
      verifiedIdentity: false,
      routeTitle: routeRecord.routeTitle,
      navTitle: routeRecord.navTitle,
    });
    for (const alias of route.aliases) {
      addCandidate(candidates, alias, 'site_meta', { public: route.public, redirectExternalUrl: route.redirectExternalUrl });
    }
  }

  if (siteMeta) {
    for (const navRoute of extractNavDrawerRoutes(siteMeta, baseUrl)) {
      addCandidate(candidates, navRoute.route, 'nav_drawer', { navTitle: navRoute.navTitle });
    }
  }

  for (const entry of bundleRoutes) {
    addCandidate(candidates, entry.slug, 'bundle', {
      collectionId: entry.collectionId ?? null,
      documentId: entry.documentId ?? null,
      exportedCarbonFileId: entry.exportedCarbonFileId ?? null,
      carbonPath: entry.carbonPath ?? null,
      pageCanonId: entry.pageCanonId ?? null,
      verifiedIdentity: true,
      routeTitle: entry.title,
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
    const tentativeExact = bundleRoutes.find((entry) => normalizeRoute(entry.slug) === candidate.route);
    const publicDocsClassification = classifyPublicDocsRoute(candidate.route, includeBlog, candidate, tentativeExact);
    if (candidate.public === false || publicDocsClassification !== 'public-docs') {
      nonPublicRoutes.push(toPlanEntry(candidate, {
        publicDocsClassification,
        reconciliationStatus: publicDocsClassification === 'missing-extraction-metadata' ? 'rejectedStale' : 'rejectedNonPublic',
        skippedReason: publicDocsClassification === 'missing-extraction-metadata'
          ? 'bundle route lacks extraction metadata'
          : 'route is not a public documentation page',
        failureReason: publicDocsClassification === 'missing-extraction-metadata'
          ? 'bundle discovery candidate lacks collectionId/documentId'
          : undefined
      }));
      continue;
    }

    const reconciled = reconcileCandidate(candidate, bundleRoutes, includeBlog);
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

function summarizeEntry(entry: RoutePlanEntry): CompactRoutePlanSummary['problematicExamples']['staleRoutes'][number] {
  return {
    route: entry.route,
    ...(entry.canonicalRoute ? { canonicalRoute: entry.canonicalRoute } : {}),
    ...(entry.outputPath ? { outputPath: entry.outputPath } : {}),
    reconciliationStatus: entry.reconciliationStatus,
    publicDocsClassification: entry.publicDocsClassification,
    ...(entry.navTitle ? { navTitle: entry.navTitle } : {}),
    ...(entry.routeTitle ? { routeTitle: entry.routeTitle } : {}),
    ...(entry.skippedReason ? { skippedReason: entry.skippedReason } : {}),
    ...(entry.failureReason ? { failureReason: entry.failureReason } : {}),
  };
}

export function buildCompactRoutePlanSummary(params: {
  routePlanSummary: RoutePlanSummary;
  unresolvedAcceptedRoutes?: RoutePlanEntry[];
}): CompactRoutePlanSummary {
  const { routePlanSummary, unresolvedAcceptedRoutes = [] } = params;
  const statusCounts: Partial<Record<RouteReconciliationStatus, number>> = {};
  const classificationCounts: Partial<Record<PublicDocsClassification, number>> = {};
  const allEntries = [
    ...routePlanSummary.acceptedRoutes,
    ...routePlanSummary.staleRoutes,
    ...routePlanSummary.ambiguousRoutes,
    ...routePlanSummary.nonPublicRoutes,
  ];
  for (const entry of allEntries) {
    statusCounts[entry.reconciliationStatus] = (statusCounts[entry.reconciliationStatus] ?? 0) + 1;
    classificationCounts[entry.publicDocsClassification] = (classificationCounts[entry.publicDocsClassification] ?? 0) + 1;
  }

  return {
    acceptedRouteCount: routePlanSummary.acceptedRoutes.length,
    staleRouteCount: routePlanSummary.staleRoutes.length,
    ambiguousRouteCount: routePlanSummary.ambiguousRoutes.length,
    nonPublicRouteCount: routePlanSummary.nonPublicRoutes.length,
    extractionCandidateCount: routePlanSummary.extractionCandidates.length,
    reconciliationStatusCounts: statusCounts,
    publicDocsClassificationCounts: classificationCounts,
    problematicExamples: {
      staleRoutes: routePlanSummary.staleRoutes.slice(0, COMPACT_ROUTE_PLAN_EXAMPLE_LIMIT).map(summarizeEntry),
      ambiguousRoutes: routePlanSummary.ambiguousRoutes.slice(0, COMPACT_ROUTE_PLAN_EXAMPLE_LIMIT).map(summarizeEntry),
      nonPublicRoutes: routePlanSummary.nonPublicRoutes.slice(0, COMPACT_ROUTE_PLAN_EXAMPLE_LIMIT).map(summarizeEntry),
      unresolvedAcceptedRoutes: unresolvedAcceptedRoutes.slice(0, COMPACT_ROUTE_PLAN_EXAMPLE_LIMIT).map(summarizeEntry),
    }
  };
}
