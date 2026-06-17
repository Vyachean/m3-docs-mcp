import { readFile, mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

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
  }, 30_000);
});
