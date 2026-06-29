import { getDefaultCacheDir } from '../cache.js';
import { readArtifactIndex, findArtifactsByKind, findArtifactsBySourceRoute, type ArtifactIndex } from '../raw-artifacts/artifact-index.js';
import { readArtifactText } from '../raw-artifacts/artifact-store.js';
import type { ArtifactRecord } from '../raw-artifacts/artifact-types.js';
import { readPageGraph, readProvenanceGraph } from '../graph/graph-store.js';
import type { PageGraph, PageNode, ProvenanceGraph } from '../graph/graph-types.js';
import { extractContentPageToMaterialPage, type JsonExtractionResult } from '../json-extraction/extract-content-page.js';
import type { DsdbResourceFetcher } from '../json-extraction/extract-dsdb-resource.js';
import type { MaterialPage } from '../types.js';
import { artifactIdsForSubject, buildRendererRouteReport, collectRequiredRouteFailures } from './build-renderer-report.js';
import { REQUIRED_RENDERER_ROUTES, type RendererReport, type RendererRouteReport } from './renderer-report.js';

/**
 * Rebuilds Markdown pages purely from the persisted raw snapshot (`raw/**`) and documentation
 * graph (`graph/*.json`) already written to a cache directory by a previous crawl — no network
 * access, no Playwright browser. This is the "from-raw" half of stage 5: it proves
 * `extractContentPageToMaterialPage` (the same function the live crawl's hot path calls) can be
 * re-invoked later from disk alone, by feeding it raw page-data/carbon-content/dsdb-resource JSON
 * read back off disk instead of freshly-fetched JSON.
 *
 * Scope/limitations (intentional, to keep this additive rather than a second crawler):
 * - Only routes resolved via the reference-based path (page-data + carbon-content artifacts
 *   tagged with a `sourceRoute`) can be rebuilt; routes that only ever had a DOM/browser
 *   extraction (no persisted page-data/carbon-content artifact) are skipped and reported as
 *   `renderedMarkdownPath: null` in the renderer report, not silently dropped.
 * - Tab-split virtual pages are not reconstructed individually — the rebuild renders one
 *   Markdown page per `PageNode.provenance.sourceRoute` group (the route the artifacts were
 *   fetched for), matching what `runReferenceBasedRouteFetch` does for non-tab routes. Tab
 *   splitting depends on the bundle's tab list, which is not part of the raw/graph snapshot;
 *   broadening this is a stage 6+ concern, not required for stage 5's "renderer doesn't need a
 *   live fetch" property.
 */

export type RebuildFromRawResult = {
  pages: MaterialPage[];
  report: RendererReport;
};

function dsdbTrailingSegment(resourceName: string): string {
  return resourceName.split('/').filter(Boolean).at(-1) ?? resourceName;
}

/** Builds a DsdbResourceFetcher backed entirely by already-persisted `dsdb-resource` artifacts —
 *  matched by the same trailing-path-segment convention crawler.ts's `withArtifactPersistence`
 *  uses to name them, so a resource fetched live and one read back from raw/** resolve the same
 *  way. Returns null (not a network error) when no matching artifact was persisted. */
function createFromRawDsdbResourceFetcher(
  artifactIndex: ArtifactIndex,
  cacheDir: string
): DsdbResourceFetcher {
  const dsdbArtifacts = findArtifactsByKind(artifactIndex, 'dsdb-resource');
  return async (resourceName: string): Promise<unknown | null> => {
    const trailing = dsdbTrailingSegment(resourceName);
    const match = dsdbArtifacts.find((artifact) => artifact.localPath.endsWith(`/${trailing}.json`) || artifact.localPath.endsWith(`/${trailing}`));
    if (!match) return null;
    try {
      const text = await readArtifactText(match.localPath, cacheDir);
      return JSON.parse(text) as unknown;
    } catch {
      return null;
    }
  };
}

async function readJsonArtifact(artifact: ArtifactRecord | undefined, cacheDir: string): Promise<unknown | null> {
  if (!artifact) return null;
  try {
    return JSON.parse(await readArtifactText(artifact.localPath, cacheDir)) as unknown;
  } catch {
    return null;
  }
}

function routeUrlFor(baseUrl: string, route: string): string {
  return new URL(route, baseUrl).toString().replace(/\/$/, '');
}

/** PageNode.route / PageNode.provenance.sourceRoute (graph-types.ts) are not guaranteed to carry
 *  a leading slash, while ArtifactRecord.sourceRoute (artifact-types.ts) is always written with
 *  one by crawler.ts's persistRawArtifact call sites (e.g. "/components/buttons/specs"). Routes
 *  read back from the two structures must be normalized to the same form before being used as a
 *  shared lookup key, or findArtifactsBySourceRoute silently returns nothing. */
function normalizeRouteKey(route: string): string {
  const trimmed = route.replace(/\.md$/i, '').trim();
  return `/${trimmed.replace(/^\/+/, '')}`;
}

/**
 * Rebuilds every renderable route's Markdown from the cache directory's persisted `raw/**`
 * artifacts and `graph/pages.json`, without touching the network. Returns both the rebuilt
 * `MaterialPage[]` and a `RendererReport` describing, per route, what could and could not be
 * reconstructed (mirrors the live-crawl renderer report built by build-renderer-report.ts).
 */
export async function rebuildMarkdownFromRaw(
  cacheDir = getDefaultCacheDir(),
  baseUrl = 'https://m3.material.io'
): Promise<RebuildFromRawResult> {
  const [artifactIndex, pageGraph, provenanceGraph] = await Promise.all([
    readArtifactIndex(cacheDir),
    readPageGraph(cacheDir),
    readProvenanceGraph(cacheDir),
  ]);

  const fetchResource = createFromRawDsdbResourceFetcher(artifactIndex, cacheDir);
  const pages: MaterialPage[] = [];
  const routeReports: RendererRouteReport[] = [];

  const routeGroups = groupPageNodesBySourceRoute(pageGraph);
  for (const [sourceRoute, pageNodes] of routeGroups) {
    const pageDataArtifacts = findArtifactsBySourceRoute(artifactIndex, sourceRoute).filter((a) => a.kind === 'page-data');
    const carbonArtifacts = findArtifactsBySourceRoute(artifactIndex, sourceRoute).filter((a) => a.kind === 'carbon-content');
    const pageDataJson = await readJsonArtifact(pageDataArtifacts[0], cacheDir);
    const contentJson = await readJsonArtifact(carbonArtifacts[0], cacheDir);

    if (pageDataJson === null && contentJson === null) {
      // No persisted page-data/carbon-content artifact for this route — nothing to rebuild from
      // raw alone (e.g. it was only ever extracted via DOM/browser fallback). Report it, don't
      // silently drop it, so stage 8 verification can see the gap.
      for (const pageNode of pageNodes) {
        routeReports.push(
          buildRendererRouteReport({
            route: pageNode.route,
            page: null,
            pageDiagnostic: null,
            contentPage: null,
            sourceArtifactIds: artifactIdsForSubject(provenanceGraph, `page:${pageNode.pageId}`),
          })
        );
      }
      continue;
    }

    const routeUrl = routeUrlFor(baseUrl, sourceRoute);
    const extraction: JsonExtractionResult = await extractContentPageToMaterialPage({
      url: routeUrl,
      pageData: pageDataJson,
      contentPage: contentJson,
      fetchResource,
      routeValidation: {
        sourceRoute,
        canonicalRoute: pageNodes[0]?.provenance.canonicalRoute ?? sourceRoute,
      },
    });

    if (!extraction.fallbackReason) pages.push(extraction.page);

    const matchedPageNode = pageNodes.find((node) => node.route === extraction.page.path.replace(/\.md$/i, '')) ?? pageNodes[0];
    const sourceArtifactIds = matchedPageNode
      ? artifactIdsForSubject(provenanceGraph, `page:${matchedPageNode.pageId}`)
      : [...pageDataArtifacts, ...carbonArtifacts].map((a) => a.id);

    routeReports.push(
      buildRendererRouteReport({
        route: sourceRoute,
        page: extraction.fallbackReason ? null : extraction.page,
        pageDiagnostic: extraction.pageDiagnostic,
        contentPage: contentJson,
        sourceArtifactIds,
      })
    );
  }

  const requiredRouteFailures = collectRequiredRouteFailures(routeReports);

  return {
    pages,
    report: {
      schemaVersion: 1,
      generatedAt: new Date().toISOString(),
      routes: routeReports,
      requiredRouteFailures,
    },
  };
}

/** Groups PageGraph nodes by their provenance source route (the route page-data/carbon-content
 *  artifacts were fetched for), falling back to the page's own route when no source route is
 *  recorded (older/partial graphs). Keys are normalized (see normalizeRouteKey) so they line up
 *  with ArtifactRecord.sourceRoute regardless of leading-slash/.md differences between the two
 *  structures. */
function groupPageNodesBySourceRoute(pageGraph: PageGraph | null): Map<string, PageNode[]> {
  const groups = new Map<string, PageNode[]>();
  for (const page of pageGraph?.pages ?? []) {
    const key = normalizeRouteKey(page.provenance.sourceRoute ?? page.route);
    const list = groups.get(key);
    if (list) list.push(page);
    else groups.set(key, [page]);
  }
  return groups;
}

export { REQUIRED_RENDERER_ROUTES };
export type { ProvenanceGraph };
