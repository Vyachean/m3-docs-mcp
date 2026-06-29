import { readFile, mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { pagesDir } from '../src/cache.js';
import { buildGraphFromIndex } from '../src/graph/build-graph.js';

// No Playwright browser should be needed for this scenario (everything resolves via direct
// JSON), but mock it the same way every other crawler-flow test does so a real Chromium install
// in the sandbox can't cause this test to fall through to real network navigation.
vi.mock('playwright', () => ({
  chromium: {
    launch: vi.fn(async () => {
      throw new Error('missing browser');
    })
  }
}));

const { crawlMaterialDocs } = await import('../src/crawler.js');

// Exercises the live-verified deterministic pipeline end-to-end with real (trimmed) fixtures:
// site_meta drives the route list and covers /components/buttons and /components/lists, but has
// zero coverage under /styles or /foundations (bundle-supplement kicks in for those). The bundle
// route table resolves the real {collectionId, documentId, exportedCarbonFileId, tabs} for all
// four routes (site_meta's own `reference` field is deliberately wrong here too, mirroring the
// live 404 behavior found during inspection). components/buttons' tabs split the one fetched
// content payload into separate cached pages, including the required /components/buttons/specs.

describe('deterministic pipeline: bundle-supplement + tab-splitting (real fixtures)', () => {
  let cacheDir: string;
  let mainJs: string;
  let pageDataButtons: unknown;
  let contentButtons: unknown;

  beforeEach(async () => {
    cacheDir = await mkdtemp(path.join(tmpdir(), 'm3-tab-splitting-test-'));
    mainJs = await readFile(path.join(__dirname, 'fixtures/bundle/route-table-slice.js'), 'utf8');
    pageDataButtons = JSON.parse(await readFile(path.join(__dirname, 'fixtures/json-extraction/page-data-buttons-real.json'), 'utf8'));
    contentButtons = JSON.parse(await readFile(path.join(__dirname, 'fixtures/json-extraction/content-buttons-tabs-real.json'), 'utf8'));
  });

  afterEach(async () => {
    vi.unstubAllGlobals();
    await rm(cacheDir, { recursive: true, force: true });
  });

  it('splits tabs into virtual cache pages and supplements subtrees missing from site_meta', async () => {
    const html = '<html><body><script src="/static/angular/main.dea11ea1.js"></script></body></html>';
    const siteMeta = {
      routes: {
        '/components/buttons': {
          other_routes: [],
          public: true,
          redirect_external_url: null,
          // Deliberately wrong reference (mirrors live site_meta: it does not point at usable
          // page-data content) — the pipeline must resolve via the bundle table instead.
          reference: { collection_id: 'Components', document_id: 5992419119333376, repo_id: 'mio-example' }
        },
        '/components/lists': {
          other_routes: [],
          public: true,
          redirect_external_url: null,
          reference: { collection_id: 'Components', document_id: 5818407454900224 }
        }
      }
    };

    vi.stubGlobal('fetch', vi.fn(async (input: string | URL) => {
      const url = String(input);
      if (url === 'https://m3.material.io') return { ok: true, text: async () => html } as Response;
      if (url === 'https://m3.material.io/site_meta.js') return { ok: true, text: async () => `window.site_meta = ${JSON.stringify(siteMeta)};` } as Response;
      if (url === 'https://m3.material.io/static/angular/main.dea11ea1.js') return { ok: true, text: async () => mainJs } as Response;
      if (url === 'https://m3.material.io/page-data/ComponentsM3/5047690081337344.json') return { ok: true, json: async () => pageDataButtons } as Response;
      if (url === 'https://m3.material.io/_dsm/content/m3/2026-06-10_13-00-05/e31df68a-59d4-41dc-8743-8c48b476d4f8.json') return { ok: true, json: async () => contentButtons } as Response;
      return { ok: false, status: 404, text: async () => '', json: async () => ({}) } as Response;
    }));

    const index = await crawlMaterialDocs({ cacheDir, maxPages: 20, minPageCount: 0, force: true });

    const pagePaths = index.pages.map((p) => p.path).sort();
    // The single fetched content payload for components/buttons was split into one cache page
    // per tab, including the required validation page.
    expect(pagePaths).toContain('components/buttons/specs.md');
    expect(pagePaths).toContain('components/buttons/overview.md');
    expect(pagePaths).toContain('components/buttons/guidelines.md');
    expect(pagePaths).toContain('components/buttons/accessibility.md');
    // Only one page-data + one Carbon fetch happened for components/buttons (not one per tab).
    expect(pagePaths.filter((p) => p.startsWith('components/buttons/')).length).toBe(4);

    // savePage's writePage call must be awaited (not fire-and-forget) before crawlMaterialDocs
    // returns — every tab page must already be persisted to disk by the time the promise resolves.
    for (const tabPath of ['specs.md', 'overview.md', 'guidelines.md', 'accessibility.md']) {
      await expect(readFile(path.join(pagesDir(cacheDir), 'components/buttons', tabPath), 'utf8')).resolves.toContain('#');
    }

    const specsDiagnostic = index.extractionDiagnostics?.routeDiagnostics?.find((d) => d.path === 'components/buttons/specs.md');
    expect(specsDiagnostic).toMatchObject({
      sourceUsed: 'direct-json',
      navigationSource: 'site-meta',
      pageReferenceSource: 'bundle-table',
      virtualSource: 'tab',
      tabName: 'Specs',
      tabSlug: 'specs',
      pageDataFetchedOnce: true
    });

    // /styles and /foundations have zero site_meta coverage — the bundle-supplement diagnostics
    // must show they were the source of those routes' navigation, not site_meta.
    expect(index.coverageDiagnostics?.supplementedPrefixes?.sort()).toEqual(['foundations', 'styles']);
    expect(index.coverageDiagnostics?.bundleSupplementRouteCount).toBeGreaterThan(0);

    // Source-route counters (site routes attempted) must stay distinct from virtual/cache-page
    // counters (one source route, components/buttons, expands into 4 tab pages here) — they must
    // never be compared 1:1.
    const diag = index.extractionDiagnostics!;
    expect(diag.virtualPagesSaved).toBe(index.pageCount);
    expect(diag.cachePagesSaved).toBe(index.pageCount);
    expect(diag.sourcePagesAttempted).toBeGreaterThan(0);
    expect(diag.sourcePagesAttempted).toBeLessThan(diag.virtualPagesPlanned);
    // components/buttons (the route with mocked page-data + Carbon responses) must count as a
    // single succeeded source route despite expanding into 4 tab pages; other routes here (lists,
    // bundle-supplement styles/foundations routes) aren't mocked and are expected to fail, but that
    // must not be confused with "the succeeded route failed."
    expect(diag.sourcePagesSucceeded).toBeGreaterThanOrEqual(1);
    expect(diag.sourcePagesSucceeded + diag.sourcePagesFailed).toBe(diag.sourcePagesAttempted);

    // No route diagnostic should show tables rendered without resolved/decoded ever having been
    // tracked alongside it (the "tokenTablesRequested:2,resolved:0,decoded:0,rendered:2"-shaped bug):
    // whenever tokenTablesRendered > 0, resolved/decoded must be tracked (or the inline-render
    // counter must explain it) rather than silently defaulting to a contradictory 0.
    for (const routeDiag of index.extractionDiagnostics?.routeDiagnostics ?? []) {
      if (routeDiag.tokenTablesRendered > 0) {
        const explained = (routeDiag.tokenTablesResolved ?? 0) > 0
          || (routeDiag.tokenTablesDecoded ?? 0) > 0
          || (routeDiag.tokenTablesRenderedFromInline ?? 0) > 0;
        expect(explained).toBe(true);
      }
    }

    // Real tab/section matching (graph/route-graph.ts's backfillRouteTabMatches): the buttons
    // route's tabs were genuinely matched against decoded content-page sections at crawl time
    // (matchTabToSection), so the graph must not collapse them to the old hardcoded
    // null/'unmatched' placeholder.
    const graph = buildGraphFromIndex(index, [], []);
    const buttonsRoute = graph.routeGraph.routes.find((r) => r.route === '/components/buttons');
    expect(buttonsRoute?.tabs.length).toBeGreaterThan(0);
    for (const tab of buttonsRoute?.tabs ?? []) {
      expect(tab.matchReason).not.toBe('unmatched');
      expect(tab.matchedSectionId).toBeTruthy();
    }

    // Real resource cross-links (graph/page-graph.ts + resource-graph.ts sharing resource-identity.ts):
    // any page chunk that claims to reference a resource must point at a resource that actually
    // exists in the resource graph, and PageNode.resourceIds must include it. This fixture has no
    // token/status tables, so this just guards the invariant for whichever chunks do exist; a
    // richer fixture with real resource chunks is covered in tests/graph-page-resource-links.test.ts.
    const resourceIds = new Set(graph.resourceGraph.resources.map((r) => r.resourceId));
    for (const page of graph.pageGraph.pages) {
      for (const chunk of page.chunks) {
        if (chunk.chunkType !== 'resource') continue;
        expect(chunk.resourceId).toBeTruthy();
        expect(resourceIds.has(chunk.resourceId!)).toBe(true);
        expect(page.resourceIds).toContain(chunk.resourceId);
      }
    }

    // Route normalization (spec: route ids must be paths, never full URLs) — regression guard
    // for the bug this test caught: crawler.ts's tab-splitting loop was passing the full
    // `https://m3.material.io/...` tab URL as `virtualRoute` instead of its pathname, which
    // silently broke RouteNode.tabs[].route <-> PageNode.route matching (backfillRouteTabMatches
    // above would never find a match). Every route-shaped field across the graph must be a path.
    const routeLikeFields = [
      ...graph.routeGraph.routes.flatMap((r) => [r.route, r.canonicalRoute, ...r.aliases, ...r.tabs.map((t) => t.route)]),
      ...graph.pageGraph.pages.flatMap((p) => [
        p.route,
        ...p.tabs.map((t) => t.route),
        p.provenance.sourceRoute,
        p.provenance.canonicalRoute,
        p.provenance.virtualRoute,
      ]),
    ].filter((v): v is string => Boolean(v));
    for (const field of routeLikeFields) {
      expect(field).not.toContain('://');
    }
  }, 30_000);

  it('does not let a small maxPages (source-route limit) cap virtual tab pages from an already-attempted route', async () => {
    const html = '<html><body><script src="/static/angular/main.dea11ea1.js"></script></body></html>';
    const siteMeta = {
      routes: {
        '/components/buttons': {
          other_routes: [],
          public: true,
          redirect_external_url: null,
          reference: { collection_id: 'Components', document_id: 5992419119333376, repo_id: 'mio-example' }
        }
      }
    };

    vi.stubGlobal('fetch', vi.fn(async (input: string | URL) => {
      const url = String(input);
      if (url === 'https://m3.material.io') return { ok: true, text: async () => html } as Response;
      if (url === 'https://m3.material.io/site_meta.js') return { ok: true, text: async () => `window.site_meta = ${JSON.stringify(siteMeta)};` } as Response;
      if (url === 'https://m3.material.io/static/angular/main.dea11ea1.js') return { ok: true, text: async () => mainJs } as Response;
      if (url === 'https://m3.material.io/page-data/ComponentsM3/5047690081337344.json') return { ok: true, json: async () => pageDataButtons } as Response;
      if (url === 'https://m3.material.io/_dsm/content/m3/2026-06-10_13-00-05/e31df68a-59d4-41dc-8743-8c48b476d4f8.json') return { ok: true, json: async () => contentButtons } as Response;
      return { ok: false, status: 404, text: async () => '', json: async () => ({}) } as Response;
    }));

    // maxPages:1 is a source-route budget — components/buttons expands into 4 tab pages on its
    // own, well beyond the source-route count of 1. All 4 must still be saved.
    const index = await crawlMaterialDocs({ cacheDir, maxPages: 1, minPageCount: 0, force: true });

    const buttonsTabPaths = index.pages.map((p) => p.path).filter((p) => p.startsWith('components/buttons/')).sort();
    expect(buttonsTabPaths).toEqual([
      'components/buttons/accessibility.md',
      'components/buttons/guidelines.md',
      'components/buttons/overview.md',
      'components/buttons/specs.md',
    ]);
  }, 30_000);
});
