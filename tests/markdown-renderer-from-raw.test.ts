import { readFileSync } from 'node:fs';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { buildAndWriteGraph } from '../src/graph/build-graph.js';
import { extractContentPageToMaterialPage } from '../src/json-extraction/extract-content-page.js';
import { rebuildMarkdownFromRaw } from '../src/rendered/markdown-renderer.js';
import { readRendererReport, rendererReportPath } from '../src/rendered/renderer-report.js';
import { persistArtifact } from '../src/raw-artifacts/artifact-store.js';
import { upsertArtifactRecord } from '../src/raw-artifacts/artifact-index.js';
import type { ArtifactRecord } from '../src/raw-artifacts/artifact-types.js';
import { createEmptyExtractionDiagnostics } from '../src/json-extraction/diagnostics.js';
import type { MaterialIndex } from '../src/types.js';

const fixture = (name: string) => JSON.parse(readFileSync(path.join(process.cwd(), 'tests/fixtures/json-extraction', name), 'utf8'));

const SOURCE_ROUTE = '/components/button/specs';
const ROUTE_URL = 'https://m3.material.io/components/button/specs';

function minimalIndex(): MaterialIndex {
  return {
    source: 'https://m3.material.io',
    capturedAt: '2026-06-29T00:00:00.000Z',
    pageCount: 1,
    attemptedPageCount: 1,
    failedPageCount: 0,
    failedUrls: [],
    pages: [{
      id: 'p1',
      title: 'Button',
      url: ROUTE_URL,
      path: 'components/button/specs.md',
      section: 'components',
      headings: ['Button'],
      capturedAt: '2026-06-29T00:00:00.000Z'
    }],
    // buildPageGraph (src/graph/page-graph.ts) joins MaterialPageMeta with this route diagnostic
    // (matched by `path`) to populate PageNode.provenance.sourceRoute, which is in turn used to
    // match ArtifactRecord.sourceRoute — without it, the page node's route falls back to its own
    // path (no leading slash) and never lines up with the "/components/button/specs" sourceRoute
    // the seeded artifacts carry, exactly mirroring how a real crawl wires this up.
    extractionDiagnostics: {
      ...createEmptyExtractionDiagnostics(),
      pageDiagnostics: [],
      routeDiagnostics: [{
        url: ROUTE_URL,
        path: 'components/button/specs.md',
        sourceUsed: 'direct-json',
        finalMethod: 'json',
        jsonAttempted: true,
        jsonSucceeded: true,
        browserFallbackAttempted: false,
        browserFallbackSucceeded: false,
        unknownChunkTypes: [],
        unknownResourceTypes: [],
        tokenTables: 1,
        tokenTablesRendered: 1,
        missingRequestedTokenSets: [],
        sourceRoute: SOURCE_ROUTE,
        canonicalRoute: SOURCE_ROUTE
      }]
    }
  };
}

let cacheDir: string;
beforeEach(async () => { cacheDir = await mkdtemp(path.join(tmpdir(), 'm3-docs-markdown-renderer-from-raw-')); });
afterEach(async () => { await rm(cacheDir, { recursive: true, force: true }); });

/**
 * Simulates what crawler.ts's runReferenceBasedRouteFetch does for a single route: persist
 * page-data + carbon-content (+ dsdb-resource) raw artifacts, index them, then build & write the
 * documentation graph — all without ever running the real crawler/Playwright. Used to set up a
 * cache directory that rebuildMarkdownFromRaw() can be pointed at.
 */
async function seedRawSnapshotForButtonSpecsRoute(): Promise<{ artifactRecords: ArtifactRecord[] }> {
  const pageData = fixture('page-data-componentsm3-document.json');
  const contentPage = fixture('content-token-table.json');
  const tokenTableResource = fixture('token-table-resource.json');

  const artifactRecords: ArtifactRecord[] = [];
  const pageDataArtifact = await persistArtifact({
    kind: 'page-data',
    pathParts: ['collection-1', 'document-1'],
    sourceUrl: `${ROUTE_URL}/page-data.json`,
    content: JSON.stringify(pageData),
    httpStatus: 200,
    contentType: 'application/json',
    sourceRoute: SOURCE_ROUTE,
    sourceMethod: 'static-plan'
  }, cacheDir);
  artifactRecords.push(pageDataArtifact);

  const carbonArtifact = await persistArtifact({
    kind: 'carbon-content',
    pathParts: ['carbon-v1', 'exported-file-1'],
    sourceUrl: 'https://m3.material.io/_dsm/content/m3/carbon-v1/exported-file-1.json',
    content: JSON.stringify(contentPage),
    httpStatus: 200,
    contentType: 'application/json',
    sourceRoute: SOURCE_ROUTE,
    sourceMethod: 'static-plan'
  }, cacheDir);
  artifactRecords.push(carbonArtifact);

  // resourceName from content-token-table.json: designSystems/20543ce18892f7d9/components/6c818a16475113bd
  // crawler.ts's withArtifactPersistence names dsdb-resource artifacts via dsdbArtifactBaseName,
  // which folds the design system id into the basename for designSystems/<id>/components/<id>
  // resource names (so two design systems sharing a trailing component id can't collide on disk).
  const dsdbArtifact = await persistArtifact({
    kind: 'dsdb-resource',
    pathParts: ['carbon-v1', 'designSystems_20543ce18892f7d9_components_6c818a16475113bd'],
    sourceUrl: 'dsdb-resource:designSystems/20543ce18892f7d9/components/6c818a16475113bd',
    content: JSON.stringify(tokenTableResource),
    contentType: 'application/json',
    sourceRoute: SOURCE_ROUTE,
    sourceMethod: 'static-plan'
  }, cacheDir);
  artifactRecords.push(dsdbArtifact);

  for (const record of artifactRecords) await upsertArtifactRecord(record, cacheDir);

  await buildAndWriteGraph(minimalIndex(), cacheDir, artifactRecords, [
    {
      resourceName: 'designSystems/20543ce18892f7d9/components/6c818a16475113bd',
      requestedTokenSets: [],
      system: (await extractContentPageToMaterialPage({
        url: ROUTE_URL,
        pageData,
        contentPage,
        fetchResource: async () => tokenTableResource
      })).collectedTokenTables[0]!.system,
      route: SOURCE_ROUTE
    }
  ]);

  return { artifactRecords };
}

describe('rebuildMarkdownFromRaw', () => {
  it('rebuilds Markdown purely from raw/** artifacts + graph/pages.json, matching the live-extraction output', async () => {
    const pageData = fixture('page-data-componentsm3-document.json');
    const contentPage = fixture('content-token-table.json');
    const tokenTableResource = fixture('token-table-resource.json');

    // "Live" extraction: the same function the crawler's hot path calls, fed freshly-fetched JSON.
    const liveExtraction = await extractContentPageToMaterialPage({
      url: ROUTE_URL,
      pageData,
      contentPage,
      fetchResource: async (resourceName, resourceType) => (
        resourceType === 'TOKEN_TABLE' && resourceName === 'designSystems/20543ce18892f7d9/components/6c818a16475113bd'
      ) ? tokenTableResource : null
    });
    expect(liveExtraction.fallbackReason).toBeNull();

    await seedRawSnapshotForButtonSpecsRoute();

    // From-raw rebuild: reads raw/** + graph/pages.json off disk only, no network/browser.
    const rebuilt = await rebuildMarkdownFromRaw(cacheDir);

    expect(rebuilt.pages).toHaveLength(1);
    const rebuiltPage = rebuilt.pages[0]!;

    // Markdown is materially equivalent: same title, headings, and token-table content.
    expect(rebuiltPage.title).toBe(liveExtraction.page.title);
    expect(rebuiltPage.headings).toEqual(liveExtraction.page.headings);
    expect(rebuiltPage.markdown).toContain('md.comp.button.container.color');
    expect(rebuiltPage.markdown).toContain('md.sys.color.primary');
    // Markdown is identical except for the capturedAt timestamp embedded in the frontmatter
    // (each call defaults to `new Date().toISOString()` at its own invocation time).
    const stripCapturedAt = (markdown: string) => markdown.replace(/^capturedAt: .*$/m, 'capturedAt: <normalized>');
    expect(stripCapturedAt(rebuiltPage.markdown)).toBe(stripCapturedAt(liveExtraction.page.markdown));

    // Renderer report reflects the rebuilt route with provenance back to the persisted artifacts.
    const routeReport = rebuilt.report.routes.find((r) => r.route === SOURCE_ROUTE);
    expect(routeReport).toBeDefined();
    expect(routeReport?.renderedMarkdownPath).toBe(rebuiltPage.path);
    expect(routeReport?.sourceArtifactIds.length).toBeGreaterThan(0);
    expect(routeReport?.severity).toBe('warning'); // not a required route
    expect(rebuilt.report.requiredRouteFailures).toEqual([]);
  });

  it('reports (does not silently drop) routes with no persisted page-data/carbon-content artifact', async () => {
    await buildAndWriteGraph(minimalIndex(), cacheDir, [], []);

    const rebuilt = await rebuildMarkdownFromRaw(cacheDir);

    expect(rebuilt.pages).toHaveLength(0);
    expect(rebuilt.report.routes).toHaveLength(1);
    expect(rebuilt.report.routes[0]?.renderedMarkdownPath).toBeNull();
  });

  it('marks required routes with unresolved findings as error severity and lists them in requiredRouteFailures', async () => {
    const pageData = fixture('page-data-componentsm3-document.json');
    const contentPage = fixture('content-token-table.json');

    await persistArtifact({
      kind: 'page-data',
      pathParts: ['collection-1', 'document-1'],
      sourceUrl: `${ROUTE_URL}/page-data.json`,
      content: JSON.stringify(pageData),
      httpStatus: 200,
      contentType: 'application/json',
      sourceRoute: '/components/buttons/specs',
      sourceMethod: 'static-plan'
    }, cacheDir);
    const carbonArtifact = await persistArtifact({
      kind: 'carbon-content',
      pathParts: ['carbon-v1', 'exported-file-1'],
      sourceUrl: 'https://m3.material.io/_dsm/content/m3/carbon-v1/exported-file-1.json',
      content: JSON.stringify(contentPage),
      httpStatus: 200,
      contentType: 'application/json',
      sourceRoute: '/components/buttons/specs',
      sourceMethod: 'static-plan'
    }, cacheDir);
    await upsertArtifactRecord(carbonArtifact, cacheDir);

    const index: MaterialIndex = {
      ...minimalIndex(),
      pages: [{
        id: 'p1',
        title: 'Buttons',
        url: 'https://m3.material.io/components/buttons/specs',
        path: 'components/buttons/specs.md',
        section: 'components',
        headings: ['Buttons'],
        capturedAt: '2026-06-29T00:00:00.000Z'
      }]
    };
    await buildAndWriteGraph(index, cacheDir, [], []);

    // No fetchResource artifact persisted for the TOKEN_TABLE resource referenced in
    // content-token-table.json — the token table will be rendered as an unresolved placeholder.
    const rebuilt = await rebuildMarkdownFromRaw(cacheDir);

    const routeReport = rebuilt.report.routes.find((r) => r.route === '/components/buttons/specs');
    expect(routeReport?.isRequiredRoute).toBe(true);
    expect(routeReport?.severity).toBe('error');
    expect(rebuilt.report.requiredRouteFailures).toContain('/components/buttons/specs');
  });
});

describe('renderer-report.ts read/write round trip', () => {
  it('writes and reads back diagnostics/renderer-report.json', async () => {
    await seedRawSnapshotForButtonSpecsRoute();
    const rebuilt = await rebuildMarkdownFromRaw(cacheDir);

    const { writeRendererReport } = await import('../src/rendered/renderer-report.js');
    await writeRendererReport(rebuilt.report, cacheDir);

    const readBack = await readRendererReport(cacheDir);
    expect(readBack).not.toBeNull();
    expect(readBack?.routes.length).toBe(rebuilt.report.routes.length);
    expect(rendererReportPath(cacheDir)).toContain(path.join('diagnostics', 'renderer-report.json'));
  });

  it('returns null when no report has been written yet', async () => {
    const readBack = await readRendererReport(cacheDir);
    expect(readBack).toBeNull();
  });
});
