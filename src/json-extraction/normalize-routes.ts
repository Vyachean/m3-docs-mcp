import { compareMaterialRoutePriority, isBlogPath } from '../crawl-priority.js';

// ── Types ─────────────────────────────────────────────────────────────────────

export type NavigationSource = 'site-meta' | 'bundle-supplement';

export type NormalizedRoute = {
  path: string;
  routeKey: string;
  aliases: string[];
  public: boolean;
  redirectExternalUrl: string | null;
  collectionId: string | null;
  documentId: string | null;
  repoId: string | null;
  isBlog: boolean;
  navigationSource: NavigationSource;
  raw: unknown;
};

export type SkippedRoute = {
  path: string;
  reason: 'private' | 'redirect' | 'blog' | 'missing-reference';
};

export type SelectedRoute = NormalizedRoute & {
  selectedBecause: 'budget' | 'required-validation';
};

export type NormalizeRoutesResult = {
  routes: NormalizedRoute[];
  normalizedRouteCount: number;
  aliasCount: number;
  deduplicatedAliasCount: number;
  invalidRouteCount: number;
};

export type NormalizeRoutesError = { ok: false; reason: string };
export type NormalizeRoutesSuccess = { ok: true } & NormalizeRoutesResult;

export type FilterRoutesOptions = {
  includeBlog: boolean;
  maxPages: number | null;
  requiredPaths?: string[];
};

export type FilterRoutesResult = {
  selected: SelectedRoute[];
  skipped: SkippedRoute[];
  skippedPrivateCount: number;
  skippedRedirectCount: number;
  skippedBlogCount: number;
  skippedMissingReferenceCount: number;
};

// ── Helpers ───────────────────────────────────────────────────────────────────

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** Coerces a possibly-numeric id field to a normalized string, or null if missing/empty/unusable. */
function normalizeId(value: unknown): string | null {
  if (value === null || value === undefined) return null;
  if (typeof value !== 'string' && typeof value !== 'number') return null;
  const str = String(value).trim();
  return str.length > 0 ? str : null;
}

function normalizePath(path: string): string {
  if (path === '/' || path === '') return '/';
  return `/${path.replace(/^\/+/, '').replace(/\/+$/, '')}`;
}

// ── normalizeSiteMetaRoutes ──────────────────────────────────────────────────

/**
 * Top-level contract check only: site_meta must be an object, and site_meta.routes must be an
 * object map. Individual route records are parsed permissively — a malformed route is skipped
 * (counted in invalidRouteCount) rather than failing the whole normalization.
 */
export function normalizeSiteMetaRoutes(siteMeta: unknown): NormalizeRoutesSuccess | NormalizeRoutesError {
  if (!isRecord(siteMeta)) {
    return { ok: false, reason: 'site_meta is not an object' };
  }
  if (!isRecord(siteMeta.routes)) {
    return { ok: false, reason: 'site_meta.routes is not an object map' };
  }

  const routes: NormalizedRoute[] = [];
  let aliasCount = 0;
  let deduplicatedAliasCount = 0;
  let invalidRouteCount = 0;
  const seenAliasTargets = new Set<string>();

  for (const [routeKey, rawValue] of Object.entries(siteMeta.routes)) {
    if (!isRecord(rawValue)) {
      invalidRouteCount += 1;
      continue;
    }

    const path = normalizePath(routeKey);
    const isPublic = rawValue.public !== false;
    const redirectExternalUrl = typeof rawValue.redirect_external_url === 'string' && rawValue.redirect_external_url.length > 0
      ? rawValue.redirect_external_url
      : null;

    const rawAliases = Array.isArray(rawValue.other_routes)
      ? rawValue.other_routes.filter((a): a is string => typeof a === 'string')
      : [];
    const aliases: string[] = [];
    for (const alias of rawAliases) {
      const normalizedAlias = normalizePath(alias);
      if (normalizedAlias === path) continue;
      aliasCount += 1;
      if (seenAliasTargets.has(normalizedAlias)) {
        deduplicatedAliasCount += 1;
        continue;
      }
      seenAliasTargets.add(normalizedAlias);
      aliases.push(normalizedAlias);
    }

    const reference = isRecord(rawValue.reference) ? rawValue.reference : null;

    routes.push({
      path,
      routeKey,
      aliases,
      public: isPublic,
      redirectExternalUrl,
      collectionId: normalizeId(reference?.collection_id),
      documentId: normalizeId(reference?.document_id),
      repoId: normalizeId(reference?.repo_id),
      isBlog: isBlogPath(path),
      navigationSource: 'site-meta',
      raw: rawValue,
    });
  }

  return {
    ok: true,
    routes,
    normalizedRouteCount: routes.length,
    aliasCount,
    deduplicatedAliasCount,
    invalidRouteCount,
  };
}

// ── filterRoutes ──────────────────────────────────────────────────────────────

/**
 * Filters routes before any fetch work, in spec order: private, redirect, blog (when
 * !includeBlog), then alias dedup is already applied at normalization time. maxPages truncation
 * runs last and reserves slots for requiredPaths so smoke/limited runs still validate the
 * representative routes.
 */
export function filterRoutes(routes: NormalizedRoute[], options: FilterRoutesOptions): FilterRoutesResult {
  const skipped: SkippedRoute[] = [];
  let skippedPrivateCount = 0;
  let skippedRedirectCount = 0;
  let skippedBlogCount = 0;
  let skippedMissingReferenceCount = 0;

  const candidates: NormalizedRoute[] = [];
  for (const route of routes) {
    if (!route.public) {
      skippedPrivateCount += 1;
      skipped.push({ path: route.path, reason: 'private' });
      continue;
    }
    if (route.redirectExternalUrl) {
      skippedRedirectCount += 1;
      skipped.push({ path: route.path, reason: 'redirect' });
      continue;
    }
    if (route.isBlog && !options.includeBlog) {
      skippedBlogCount += 1;
      skipped.push({ path: route.path, reason: 'blog' });
      continue;
    }
    candidates.push(route);
  }

  const requiredPaths = new Set(options.requiredPaths ?? []);
  const required = candidates.filter((r) => requiredPaths.has(r.path));
  // Order the remaining candidates by crawl priority (components/styles/foundations first, then
  // develop/get-started, then resources, ...) so a tight maxPages budget spends its non-required
  // slots on modern app routes likely to resolve via the bundle table, not legacy static pages
  // (e.g. design/material-studies/*.html) that predate the Angular app and were never registered
  // in the bundle's route table.
  const rest = candidates
    .filter((r) => !requiredPaths.has(r.path))
    .sort((a, b) => compareMaterialRoutePriority(a.path, b.path));

  let selected: SelectedRoute[];
  if (options.maxPages === null || candidates.length <= options.maxPages) {
    selected = [
      ...required.map((r) => ({ ...r, selectedBecause: 'budget' as const })),
      ...rest.map((r) => ({ ...r, selectedBecause: 'budget' as const })),
    ];
  } else {
    const budgetForRest = Math.max(0, options.maxPages - required.length);
    selected = [
      ...required.map((r) => ({ ...r, selectedBecause: 'required-validation' as const })),
      ...rest.slice(0, budgetForRest).map((r) => ({ ...r, selectedBecause: 'budget' as const })),
    ];
  }

  // A route with no site_meta-supplied documentId is NOT removed from `selected` here — the
  // page-reference-resolver may still resolve collectionId/documentId via the bundle table.
  // This counter is diagnostic only; the authoritative "could not resolve at all" signal is the
  // pipeline-level pageReferenceSource:"missing" recorded after the resolver runs.
  for (const route of selected) {
    if (!route.documentId) {
      skippedMissingReferenceCount += 1;
    }
  }

  return { selected, skipped, skippedPrivateCount, skippedRedirectCount, skippedBlogCount, skippedMissingReferenceCount };
}
