import { createFetchDiagnostic, type FetchDiagnostic } from '../raw-artifacts/fetch-diagnostics.js';

// Isolated Carbon/page-reference resolver. The only module allowed to parse the Angular bundle.
//
// site_meta.js does not carry the {collectionId, documentId} pair needed to fetch
// /page-data/{collectionId}/{documentId}.json (verified live: site_meta's `reference` fields point
// to an unrelated Carbon document and 404 when used directly). The real mapping — along with the
// `tabs` that make up sub-routes like /components/buttons/specs — only exists in a route table
// embedded in the Angular bundle (main.<hash>.js), e.g.:
//   {"slug":"components/buttons","documentId":"5047690081337344","collectionId":"ComponentsM3",
//    "exportedCarbonFileId":"e31df68a-....json","tabs":[{"label":"Overview"},{"label":"Specs"},...]}
//
// This module only parses and resolves bundle route entries. Route discovery policy, bundle-only
// acceptance, and public-doc classification live in route-graph.ts.

export type BundleTabEntry = {
  label: string;
  slug?: string;
  alternateSlugs?: string[];
};

export type BundleRouteEntry = {
  slug: string;
  documentId?: string;
  collectionId?: string;
  exportedCarbonFileId?: string;
  pageCanonId?: string;
  carbonPath?: string;
  title?: string;
  alternateSlugs?: string[];
  tabs?: BundleTabEntry[];
};

export type RouteAliasMatchedBy = 'bundle-alternate-slug';

export type PageReferenceResolution =
  | {
    pageReferenceSource: 'bundle-table';
    entry: BundleRouteEntry;
    normalizedRoute: string;
    bundleMatchedRoute: string;
    aliasMatchedBy?: RouteAliasMatchedBy;
  }
  | {
    pageReferenceSource: 'missing';
    normalizedRoute: string;
  };

type FetchLike = typeof fetch;

// ── Bundle fetching ──────────────────────────────────────────────────────────

const MAIN_BUNDLE_SRC_RE = /src="(\/static\/angular\/main\.[a-f0-9]+\.js)"/;

export async function fetchAngularBundleText(
  baseUrl: string,
  signal?: AbortSignal,
  fetchImpl: FetchLike = fetch,
  diagnostics: FetchDiagnostic[] = []
): Promise<string> {
  let shellRes: Response;
  try {
    shellRes = await fetchImpl(baseUrl, { signal });
  } catch (err) {
    diagnostics.push(createFetchDiagnostic({
      url: baseUrl, expectedKind: 'site-shell', outcome: 'network-error',
      networkError: err instanceof Error ? err.message : String(err),
      reason: 'rejected: site shell fetch (for Angular bundle discovery) threw a network error'
    }));
    throw err;
  }
  if (!shellRes.ok) {
    diagnostics.push(createFetchDiagnostic({
      url: baseUrl, expectedKind: 'site-shell', httpStatus: shellRes.status, outcome: 'http-error',
      reason: `rejected: site shell fetch returned HTTP ${shellRes.status}`
    }));
    throw new Error(`Failed to fetch ${baseUrl}: HTTP ${shellRes.status}`);
  }
  const html = await shellRes.text();
  diagnostics.push(createFetchDiagnostic({
    url: baseUrl, expectedKind: 'site-shell', httpStatus: shellRes.status,
    contentType: shellRes.headers?.get?.('content-type') ?? null, outcome: 'success',
    reason: 'accepted: site shell fetched for Angular bundle URL discovery'
  }));

  const match = html.match(MAIN_BUNDLE_SRC_RE);
  if (!match?.[1]) {
    diagnostics.push(createFetchDiagnostic({
      url: baseUrl, expectedKind: 'angular-bundle', outcome: 'parse-error',
      parseError: 'Angular main bundle URL not found in page HTML',
      reason: 'rejected: site shell HTML did not contain a recognizable Angular main bundle <script src>'
    }));
    throw new Error('Angular main bundle URL not found in page HTML');
  }

  const bundleUrl = new URL(match[1], baseUrl).toString();
  let bundleRes: Response;
  try {
    bundleRes = await fetchImpl(bundleUrl, { signal });
  } catch (err) {
    diagnostics.push(createFetchDiagnostic({
      url: bundleUrl, expectedKind: 'angular-bundle', outcome: 'network-error',
      networkError: err instanceof Error ? err.message : String(err),
      reason: 'rejected: Angular bundle fetch threw a network error'
    }));
    throw err;
  }
  if (!bundleRes.ok) {
    diagnostics.push(createFetchDiagnostic({
      url: bundleUrl, expectedKind: 'angular-bundle', httpStatus: bundleRes.status, outcome: 'http-error',
      reason: `rejected: Angular bundle fetch returned HTTP ${bundleRes.status}`
    }));
    throw new Error(`Failed to fetch Angular bundle ${bundleUrl}: HTTP ${bundleRes.status}`);
  }
  const bundleText = await bundleRes.text();
  diagnostics.push(createFetchDiagnostic({
    url: bundleUrl, expectedKind: 'angular-bundle', httpStatus: bundleRes.status,
    contentType: bundleRes.headers?.get?.('content-type') ?? null, outcome: 'success',
    reason: 'accepted: Angular main bundle fetched'
  }));
  return bundleText;
}

// ── carbonVersion ────────────────────────────────────────────────────────────

// Real bundle text has an unquoted object key here (minified JS, not JSON): carbonVersion:"...".
const CARBON_VERSION_RE = /carbonVersion"?:"([^"]+)"/;

export function extractCarbonVersion(bundleText: string): string | null {
  return bundleText.match(CARBON_VERSION_RE)?.[1] ?? null;
}

// ── Route table parsing ──────────────────────────────────────────────────────

/**
 * Parses the bundle's embedded route table. Permissive: a malformed entry (no slug) is skipped,
 * not fatal to the whole parse.
 */
export function extractBundleRouteTable(bundleText: string): BundleRouteEntry[] {
  const entriesBySlug = new Map<string, BundleRouteEntry>();
  const slugOrder: string[] = [];
  const slugMatches = Array.from(bundleText.matchAll(/"slug":"[^"]*"/g));
  for (let i = 0; i < slugMatches.length; i += 1) {
    const match = slugMatches[i]!;
    const offset = match.index ?? 0;
    // Prefer the real balanced `{...}` object around this slug (matches production minified JS).
    // Fall back to the loose span up to the next "slug": occurrence — needed for fixtures/text
    // that isn't wrapped in braces, mirroring the permissive parsing the spec requires.
    const fragment = extractBalancedObjectAround(bundleText, offset)
      ?? bundleText.slice(offset, slugMatches[i + 1]?.index ?? bundleText.length);
    const entry = parseBundleRouteFragment(fragment);
    if (!entry) continue;
    const existing = entriesBySlug.get(entry.slug);
    if (!existing) {
      entriesBySlug.set(entry.slug, entry);
      slugOrder.push(entry.slug);
      continue;
    }
    entriesBySlug.set(entry.slug, mergeBundleRouteEntries(existing, entry));
  }
  return slugOrder.map((slug) => entriesBySlug.get(slug)!);
}

function mergeBundleRouteEntries(existing: BundleRouteEntry, incoming: BundleRouteEntry): BundleRouteEntry {
  if (existing.slug !== incoming.slug) {
    throw new Error(`Cannot merge Angular bundle routes with different slugs: ${existing.slug} vs ${incoming.slug}`);
  }
  return {
    slug: existing.slug,
    documentId: mergeBundleScalar(existing.slug, 'documentId', existing.documentId, incoming.documentId),
    collectionId: mergeBundleScalar(existing.slug, 'collectionId', existing.collectionId, incoming.collectionId),
    exportedCarbonFileId: mergeBundleScalar(existing.slug, 'exportedCarbonFileId', existing.exportedCarbonFileId, incoming.exportedCarbonFileId),
    pageCanonId: mergeBundleScalar(existing.slug, 'pageCanonId', existing.pageCanonId, incoming.pageCanonId),
    carbonPath: mergeBundleScalar(existing.slug, 'carbonPath', existing.carbonPath, incoming.carbonPath),
    title: mergeBundleScalar(existing.slug, 'title', existing.title, incoming.title),
    alternateSlugs: mergeStringArrays(existing.alternateSlugs, incoming.alternateSlugs),
    tabs: mergeBundleTabs(existing.slug, existing.tabs, incoming.tabs),
  };
}

function mergeBundleScalar(slug: string, field: string, existing: string | undefined, incoming: string | undefined): string | undefined {
  if (existing && incoming && existing !== incoming) {
    throw new Error(`Conflicting Angular bundle route metadata for ${slug}: ${field}=${JSON.stringify(existing)} vs ${JSON.stringify(incoming)}`);
  }
  return existing ?? incoming;
}

function mergeStringArrays(existing: string[] | undefined, incoming: string[] | undefined): string[] | undefined {
  if (!existing && !incoming) return undefined;
  return Array.from(new Set([...(existing ?? []), ...(incoming ?? [])]));
}

function mergeBundleTabs(slug: string, existing: BundleTabEntry[] | undefined, incoming: BundleTabEntry[] | undefined): BundleTabEntry[] | undefined {
  if (!existing) return incoming;
  if (!incoming) return existing;
  if (JSON.stringify(existing) !== JSON.stringify(incoming)) {
    throw new Error(`Conflicting Angular bundle tab metadata for ${slug}`);
  }
  return existing;
}

/** Finds the smallest balanced `{...}` object that contains the given offset. */
function extractBalancedObjectAround(source: string, offset: number): string | null {
  let start = offset;
  let depth = 0;
  let foundStart = false;
  for (let i = offset; i >= 0; i -= 1) {
    const ch = source[i];
    if (ch === '}') depth += 1;
    if (ch === '{') {
      if (depth === 0) {
        start = i;
        foundStart = true;
        break;
      }
      depth -= 1;
    }
  }
  if (!foundStart) return null;

  depth = 0;
  for (let i = start; i < source.length; i += 1) {
    const ch = source[i];
    if (ch === '{') depth += 1;
    if (ch === '}') {
      depth -= 1;
      if (depth === 0) return source.slice(start, i + 1);
    }
  }
  return null;
}

function readStringField(fragment: string, field: string): string | undefined {
  return fragment.match(new RegExp(`"${field}":"([^"]+)"`))?.[1];
}

function readStringArrayField(fragment: string, field: string): string[] | undefined {
  const arrayMatch = fragment.match(new RegExp(`"${field}":\\[([^\\]]*)\\]`));
  if (!arrayMatch?.[1]) return undefined;
  const values = Array.from(arrayMatch[1].matchAll(/"([^"]*)"/g)).map((m) => m[1] ?? '').filter(Boolean);
  return values.length > 0 ? values : undefined;
}

function readTabsField(fragment: string): BundleTabEntry[] | undefined {
  // Tabs are an array of objects (possibly with nested arrays like alternateSlugs), so a simple
  // non-nested regex can't capture them reliably — locate "tabs": and balance brackets manually.
  const tabsIndex = fragment.indexOf('"tabs":');
  if (tabsIndex === -1) return undefined;
  const arrayStart = fragment.indexOf('[', tabsIndex);
  if (arrayStart === -1) return undefined;
  const arrayText = extractBalancedArray(fragment, arrayStart);
  if (!arrayText) return undefined;

  const tabFragments = splitTopLevelObjects(arrayText);
  const tabs: BundleTabEntry[] = [];
  for (const tabFragment of tabFragments) {
    const label = readStringField(tabFragment, 'label');
    if (!label) continue;
    tabs.push({
      label,
      slug: readStringField(tabFragment, 'slug'),
      alternateSlugs: readStringArrayField(tabFragment, 'alternateSlugs'),
    });
  }
  return tabs.length > 0 ? tabs : undefined;
}

function extractBalancedArray(source: string, start: number): string | null {
  if (source[start] !== '[') return null;
  let depth = 0;
  let inString = false;
  let escapeNext = false;
  for (let i = start; i < source.length; i += 1) {
    const ch = source[i];
    if (escapeNext) { escapeNext = false; continue; }
    if (ch === '\\' && inString) { escapeNext = true; continue; }
    if (ch === '"') { inString = !inString; continue; }
    if (inString) continue;
    if (ch === '[') depth += 1;
    else if (ch === ']') {
      depth -= 1;
      if (depth === 0) return source.slice(start + 1, i);
    }
  }
  return null;
}

function splitTopLevelObjects(arrayInnerText: string): string[] {
  const fragments: string[] = [];
  let depth = 0;
  let start = -1;
  let inString = false;
  let escapeNext = false;
  for (let i = 0; i < arrayInnerText.length; i += 1) {
    const ch = arrayInnerText[i];
    if (escapeNext) { escapeNext = false; continue; }
    if (ch === '\\' && inString) { escapeNext = true; continue; }
    if (ch === '"') { inString = !inString; continue; }
    if (inString) continue;
    if (ch === '{') {
      if (depth === 0) start = i;
      depth += 1;
    } else if (ch === '}') {
      depth -= 1;
      if (depth === 0 && start >= 0) {
        fragments.push(arrayInnerText.slice(start, i + 1));
        start = -1;
      }
    }
  }
  return fragments;
}

function parseBundleRouteFragment(fragment: string): BundleRouteEntry | null {
  const slug = readStringField(fragment, 'slug');
  if (!slug) return null;
  return {
    slug,
    documentId: readStringField(fragment, 'documentId'),
    collectionId: readStringField(fragment, 'collectionId'),
    exportedCarbonFileId: readStringField(fragment, 'exportedCarbonFileId'),
    pageCanonId: readStringField(fragment, 'pageCanonId') ?? readStringField(fragment, 'pageCanonicalId'),
    carbonPath: readStringField(fragment, 'carbonPath'),
    title: readStringField(fragment, 'title'),
    alternateSlugs: readStringArrayField(fragment, 'alternateSlugs'),
    tabs: readTabsField(fragment),
  };
}

// ── Resolution ───────────────────────────────────────────────────────────────

function normalizeSlugForMatch(path: string): string {
  return path.replace(/^\/+|\/+$/g, '');
}

/**
 * Resolves a route path to its bundle route entry by exact slug match, falling back to
 * alternateSlugs. Does not invent new routes — returns "missing" when no entry matches.
 */
export function resolvePageReference(path: string, bundleRoutes: BundleRouteEntry[]): PageReferenceResolution {
  const target = normalizeSlugForMatch(path);
  const exact = bundleRoutes.find((entry) => entry.slug === target);
  if (exact) {
    return {
      pageReferenceSource: 'bundle-table',
      entry: exact,
      normalizedRoute: target,
      bundleMatchedRoute: exact.slug
    };
  }

  const viaAlias = bundleRoutes.find((entry) => entry.alternateSlugs?.includes(target));
  if (viaAlias) {
    return {
      pageReferenceSource: 'bundle-table',
      entry: viaAlias,
      normalizedRoute: target,
      bundleMatchedRoute: viaAlias.slug,
      aliasMatchedBy: 'bundle-alternate-slug'
    };
  }

  return { pageReferenceSource: 'missing', normalizedRoute: target };
}

function normalizeLabelForMatch(value: string): string {
  return value.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '');
}

export type TabMatchResult =
  | { matched: true; sectionIndex: number; matchedBy: 'slug' | 'label' | 'position' }
  | { matched: false; reason: 'tab-section-mismatch' };

/**
 * Matches a bundle tab entry to a content payload's section, in priority order:
 *   1. tab.slug / tab.alternateSlugs against a normalized section identifier (section.name, since
 *      the content payload does not expose a separate slug field for sections)
 *   2. normalized label equality (tab.label vs section name)
 *   3. positional fallback, only when tabs.length === sections.length
 * No match found is reported explicitly rather than silently mismatched.
 */
export function matchTabToSection(
  tab: BundleTabEntry,
  tabIndex: number,
  sections: { name?: string }[],
  totalTabs: number
): TabMatchResult {
  const tabSlugCandidates = [tab.slug, ...(tab.alternateSlugs ?? [])].filter((v): v is string => Boolean(v)).map(normalizeLabelForMatch);
  if (tabSlugCandidates.length > 0) {
    const bySlugIndex = sections.findIndex((s) => s.name && tabSlugCandidates.includes(normalizeLabelForMatch(s.name)));
    if (bySlugIndex !== -1) return { matched: true, sectionIndex: bySlugIndex, matchedBy: 'slug' };
  }

  const normalizedTabLabel = normalizeLabelForMatch(tab.label);
  const byLabelIndex = sections.findIndex((s) => s.name && normalizeLabelForMatch(s.name) === normalizedTabLabel);
  if (byLabelIndex !== -1) return { matched: true, sectionIndex: byLabelIndex, matchedBy: 'label' };

  if (totalTabs === sections.length && sections[tabIndex]) {
    return { matched: true, sectionIndex: tabIndex, matchedBy: 'position' };
  }

  return { matched: false, reason: 'tab-section-mismatch' };
}

// ── Subtree coverage ─────────────────────────────────────────────────────────

/**
 * Returns, among trackedPrefixes, the prefixes that have zero site_meta route coverage (so the
 * pipeline knows which subtrees are eligible for bundle-supplement navigation). Pure/synchronous —
 * the pipeline supplies the list of already-normalized site_meta paths.
 */
export function findSubtreesWithoutCoverage(siteMetaPaths: string[], trackedPrefixes: string[]): string[] {
  return trackedPrefixes.filter((prefix) => {
    const normalizedPrefix = `/${prefix.replace(/^\/+|\/+$/g, '')}`;
    return !siteMetaPaths.some((path) => path === normalizedPrefix || path.startsWith(`${normalizedPrefix}/`));
  });
}

/** Builds bundle-supplement route entries (slug-based, navigationSource:"bundle-supplement") for a subtree prefix. */
export function bundleRoutesUnderPrefix(bundleRoutes: BundleRouteEntry[], prefix: string): BundleRouteEntry[] {
  const normalizedPrefix = prefix.replace(/^\/+|\/+$/g, '');
  return bundleRoutes.filter((entry) => entry.slug === normalizedPrefix || entry.slug.startsWith(`${normalizedPrefix}/`));
}
