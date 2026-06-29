import { getDefaultCacheDir } from '../cache.js';
import { readArtifactIndex, type ArtifactIndex } from '../raw-artifacts/artifact-index.js';
import type { ArtifactRecord } from '../raw-artifacts/artifact-types.js';
import { readPageGraph, readTokenTableGraph } from '../graph/graph-store.js';
import type { PageGraph, PageNode, TokenTableGraph, TokenTableNode } from '../graph/graph-types.js';
import { normalizeGraphRoute } from '../graph/route-identity.js';
import type { RequiredRouteCapture, RequiredRoutesCaptureReport } from './browser-oracle-types.js';

/**
 * Compares a browser-oracle capture (capture-required-routes.ts) against the persisted raw
 * snapshot (`raw/artifact-index.json`) and documentation graph (`graph/pages.json`,
 * `graph/token-tables.json`) for the same set of required routes.
 *
 * This module only *computes* the comparison; it does not decide pass/fail policy for cache
 * promotion — that is stage 8's verification gate. The three fields below
 * (`missingFromRawSnapshot`, `missingHeadings`, `unresolvedVisibleTables`) are exactly the three
 * failure conditions the spec calls out, so stage 8 can fail fast on any non-empty list without
 * re-deriving them.
 */

export type RequiredRouteComparison = {
  route: string;
  /** True when the browser capture itself failed (navigation error) — comparison fields below
   *  are best-effort / may be empty in this case, since there was nothing to compare against. */
  captureFailed: boolean;
  navigationError: string | null;
  /** Network resource URLs/ids the browser observed for this route that have no matching entry
   *  (by sourceUrl or by resourceId/pathname suffix of localPath) in raw/artifact-index.json. */
  missingFromRawSnapshot: string[];
  /** Heading text the browser rendered for this route that is absent from the page graph's
   *  PageNode.headings for the matching route (graph/pages.json, which the from-raw Markdown
   *  rebuild's renderer report is itself built from — see src/rendered/markdown-renderer.ts). */
  missingHeadings: string[];
  /** Visible token/status table labels scraped from the browser DOM that do not match any
   *  resolved TokenTableNode (graph/token-tables.json) routed to this route — i.e. tables the
   *  browser shows but the graph never resolved. Best-effort: label matching is substring/loose
   *  (see matchesAnyTokenName below), since the DOM label and the token system's displayName/
   *  tokenName are not guaranteed to be identical strings. */
  unresolvedVisibleTables: string[];
  /** True only when all three fields above are empty and the capture itself succeeded — i.e. this
   *  route is ready for stage 8 to treat as passing. */
  passed: boolean;
};

export type RequiredRoutesComparisonReport = {
  generatedAt: string;
  baseUrl: string;
  routes: RequiredRouteComparison[];
  /** Routes (by route string) with at least one non-empty failure-condition field, or a capture
   *  failure. Empty means every required route in the capture passed this comparison. */
  failedRoutes: string[];
  /** Overall pass/fail-ready summary: true only when failedRoutes is empty. */
  allPassed: boolean;
};

function artifactMatchKeys(artifact: ArtifactRecord): string[] {
  const keys: string[] = [artifact.sourceUrl];
  try {
    keys.push(new URL(artifact.sourceUrl).pathname);
  } catch {
    // sourceUrl wasn't a valid absolute URL; sourceUrl itself is still a usable match key.
  }
  keys.push(artifact.localPath);
  const trailingLocalSegment = artifact.localPath.split('/').filter(Boolean).at(-1);
  if (trailingLocalSegment) keys.push(trailingLocalSegment);
  return keys;
}

/** A captured network resource is considered present in the raw snapshot when its full URL, its
 *  pathname, or its trailing path segment matches any of an artifact's sourceUrl/pathname/
 *  localPath/trailing-local-segment. This loose matching mirrors the trailing-segment convention
 *  already used by raw-artifacts lookups elsewhere (e.g. rendered/markdown-renderer.ts's
 *  dsdbTrailingSegment / createFromRawDsdbResourceFetcher), since artifact ids/local paths are not
 *  guaranteed to be byte-identical to the live request URL. */
function isResourceInArtifactIndex(resourceUrl: string, resourceId: string, artifactIndex: ArtifactIndex): boolean {
  const trailingResourceSegment = resourceId.split('/').filter(Boolean).at(-1);
  return artifactIndex.artifacts.some((artifact) => {
    const keys = artifactMatchKeys(artifact);
    if (keys.includes(resourceUrl) || keys.includes(resourceId)) return true;
    if (trailingResourceSegment && keys.includes(trailingResourceSegment)) return true;
    return false;
  });
}

function findPageNodeForRoute(pageGraph: PageGraph | null, route: string): PageNode | null {
  if (!pageGraph) return null;
  const normalized = normalizeGraphRoute(route);
  return (
    pageGraph.pages.find((page) => normalizeGraphRoute(page.route) === normalized)
    ?? pageGraph.pages.find((page) => normalizeGraphRoute(page.provenance.sourceRoute ?? '') === normalized)
    ?? null
  );
}

function normalizeHeadingText(value: string): string {
  return value.replace(/\s+/g, ' ').trim().toLowerCase();
}

function computeMissingHeadings(capturedHeadings: string[], pageNode: PageNode | null): string[] {
  const graphHeadings = new Set((pageNode?.headings ?? []).map(normalizeHeadingText));
  return capturedHeadings.filter((heading) => !graphHeadings.has(normalizeHeadingText(heading)));
}

function tokenTableNodesForRoute(tokenTableGraph: TokenTableGraph | null, route: string): TokenTableNode[] {
  if (!tokenTableGraph) return [];
  const normalized = normalizeGraphRoute(route);
  return tokenTableGraph.tokenTables.filter((node) => node.routes.some((r) => normalizeGraphRoute(r) === normalized));
}

/** Loose label match: a visible DOM label is considered resolved when it equals, contains, or is
 *  contained by a token's displayName/tokenName, or a token set's displayName/tokenSetName,
 *  case-insensitively. Browser-rendered labels (e.g. "Enabled", "Primary container") and the
 *  decoded token system's identifiers (e.g. "md.sys.color.primary-container",
 *  "Primary container") are not guaranteed to be identical strings, so exact matching would
 *  produce false positives in the "unresolved" direction; substring matching is the documented
 *  best-effort tradeoff here, consistent with the DOM scrape's own documented limits in
 *  capture-required-routes.ts. */
function isLabelResolvedInTokenTables(label: string, tokenTableNodes: TokenTableNode[]): boolean {
  const normalizedLabel = normalizeHeadingText(label);
  if (!normalizedLabel) return true;
  for (const tableNode of tokenTableNodes) {
    for (const tokenSet of tableNode.tokenSets) {
      if (namesMatch(normalizedLabel, tokenSet.displayName) || namesMatch(normalizedLabel, tokenSet.tokenSetName)) return true;
      for (const token of tokenSet.tokens) {
        if (namesMatch(normalizedLabel, token.displayName) || namesMatch(normalizedLabel, token.tokenName)) return true;
        if (token.aliases.some((alias) => namesMatch(normalizedLabel, alias))) return true;
      }
    }
  }
  return false;
}

function namesMatch(normalizedLabel: string, candidate: string): boolean {
  const normalizedCandidate = normalizeHeadingText(candidate);
  if (!normalizedCandidate) return false;
  return normalizedLabel === normalizedCandidate
    || normalizedLabel.includes(normalizedCandidate)
    || normalizedCandidate.includes(normalizedLabel);
}

function compareOneRoute(
  capture: RequiredRouteCapture,
  artifactIndex: ArtifactIndex,
  pageGraph: PageGraph | null,
  tokenTableGraph: TokenTableGraph | null
): RequiredRouteComparison {
  const captureFailed = capture.navigationError !== null || capture.dom === null;

  const missingFromRawSnapshot = capture.networkResources
    .filter((resource) => !isResourceInArtifactIndex(resource.url, resource.resourceId, artifactIndex))
    .map((resource) => resource.url);

  const pageNode = findPageNodeForRoute(pageGraph, capture.route);
  const missingHeadings = capture.dom ? computeMissingHeadings(capture.dom.headings, pageNode) : [];

  const tokenTableNodes = tokenTableNodesForRoute(tokenTableGraph, capture.route);
  const unresolvedVisibleTables = capture.dom
    ? capture.dom.visibleTableLabels.filter((label) => !isLabelResolvedInTokenTables(label, tokenTableNodes))
    : [];

  const passed = !captureFailed
    && missingFromRawSnapshot.length === 0
    && missingHeadings.length === 0
    && unresolvedVisibleTables.length === 0;

  return {
    route: capture.route,
    captureFailed,
    navigationError: capture.navigationError,
    missingFromRawSnapshot,
    missingHeadings,
    unresolvedVisibleTables,
    passed,
  };
}

export type CompareCaptureToSnapshotInput = {
  capture: RequiredRoutesCaptureReport;
  cacheDir?: string;
};

/**
 * Computes the structured comparison report for every route in `capture.routes` against the
 * cache directory's persisted `raw/artifact-index.json` and `graph/{pages,token-tables}.json`.
 * Reads the cache directory fresh on each call (mirrors graph-store.ts / artifact-index.ts read
 * conventions: missing/invalid files degrade to null/empty rather than throwing).
 */
export async function compareCaptureToSnapshot(input: CompareCaptureToSnapshotInput): Promise<RequiredRoutesComparisonReport> {
  const cacheDir = input.cacheDir ?? getDefaultCacheDir();
  const [artifactIndex, pageGraph, tokenTableGraph] = await Promise.all([
    readArtifactIndex(cacheDir),
    readPageGraph(cacheDir),
    readTokenTableGraph(cacheDir),
  ]);

  const routes = input.capture.routes.map((routeCapture) =>
    compareOneRoute(routeCapture, artifactIndex, pageGraph, tokenTableGraph)
  );

  const failedRoutes = routes.filter((route) => !route.passed).map((route) => route.route);

  return {
    generatedAt: new Date().toISOString(),
    baseUrl: input.capture.baseUrl,
    routes,
    failedRoutes,
    allPassed: failedRoutes.length === 0,
  };
}
