import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { persistArtifact } from '../src/raw-artifacts/artifact-store.js';
import { upsertArtifactRecord } from '../src/raw-artifacts/artifact-index.js';
import { writePageGraph, writeTokenTableGraph } from '../src/graph/graph-store.js';
import type { PageGraph, TokenTableGraph } from '../src/graph/graph-types.js';
import { compareCaptureToSnapshot } from '../src/browser-oracle/compare-capture-to-snapshot.js';
import type { RequiredRoutesCaptureReport } from '../src/browser-oracle/browser-oracle-types.js';

let cacheDir: string;

beforeEach(async () => {
  cacheDir = await mkdtemp(path.join(tmpdir(), 'm3-docs-mcp-browser-oracle-'));
});

afterEach(async () => {
  await rm(cacheDir, { recursive: true, force: true });
});

function buildPageGraph(): PageGraph {
  return {
    schemaVersion: 1,
    generatedAt: '2026-06-01T00:00:00.000Z',
    pages: [
      {
        pageId: 'page-switch-overview',
        route: '/components/switch/overview',
        title: 'Switch',
        section: 'components',
        tabs: [],
        headings: ['Switch', 'Usage', 'Accessibility'],
        sections: [],
        chunks: [],
        resourceIds: [],
        tokenTableIds: [],
        unsupportedChunkTypes: [],
        provenance: { sourceArtifacts: [], sourceRoute: '/components/switch/overview', canonicalRoute: null, virtualRoute: null }
      }
    ]
  };
}

function buildTokenTableGraph(): TokenTableGraph {
  return {
    schemaVersion: 1,
    generatedAt: '2026-06-01T00:00:00.000Z',
    tokenTables: [
      {
        resourceId: 'resource-switch-tokens',
        resourceName: 'switch-tokens',
        requestedTokenSets: ['Switch'],
        tokenSets: [
          {
            tokenSetName: 'switch',
            displayName: 'Switch',
            tokens: [
              { tokenName: 'md.comp.switch.selected.track.color', displayName: 'Selected track color', aliases: [], values: [] },
              { tokenName: 'md.comp.switch.unselected.track.color', displayName: 'Unselected track color', aliases: [], values: [] }
            ]
          }
        ],
        routes: ['/components/switch/overview'],
        unresolvedTokenCount: 0
      }
    ]
  };
}

async function seedPageDataArtifact(): Promise<void> {
  const record = await persistArtifact(
    {
      kind: 'page-data',
      pathParts: ['switch-collection', 'switch-overview-doc'],
      sourceUrl: 'https://m3.material.io/page-data/components/switch/overview/page-data.json',
      content: JSON.stringify({ result: { pageContext: { title: 'Switch' } } }),
      httpStatus: 200,
      contentType: 'application/json',
      sourceRoute: '/components/switch/overview',
      sourceMethod: 'static-plan'
    },
    cacheDir
  );
  await upsertArtifactRecord(record, cacheDir);
}

function buildCapture(overrides: Partial<RequiredRoutesCaptureReport['routes'][number]> = {}): RequiredRoutesCaptureReport {
  return {
    schemaVersion: 1,
    generatedAt: '2026-06-01T00:00:00.000Z',
    baseUrl: 'https://m3.material.io',
    routes: [
      {
        route: '/components/switch/overview',
        requestedUrl: 'https://m3.material.io/components/switch/overview',
        finalUrl: 'https://m3.material.io/components/switch/overview',
        navigationError: null,
        networkResources: [
          {
            resourceId: '/page-data/components/switch/overview/page-data.json',
            url: 'https://m3.material.io/page-data/components/switch/overview/page-data.json',
            kind: 'page-data',
            httpStatus: 200
          }
        ],
        dom: {
          headings: ['Switch', 'Usage', 'Accessibility'],
          visibleTableLabels: ['Selected track color', 'Unselected track color']
        },
        ...overrides
      }
    ]
  };
}

describe('compareCaptureToSnapshot', () => {
  it('passes when every captured resource/heading/table is present in the raw snapshot and graph', async () => {
    await seedPageDataArtifact();
    await writePageGraph(buildPageGraph(), cacheDir);
    await writeTokenTableGraph(buildTokenTableGraph(), cacheDir);

    const result = await compareCaptureToSnapshot({ capture: buildCapture(), cacheDir });

    expect(result.allPassed).toBe(true);
    expect(result.failedRoutes).toEqual([]);
    const routeResult = result.routes[0]!;
    expect(routeResult.missingFromRawSnapshot).toEqual([]);
    expect(routeResult.missingHeadings).toEqual([]);
    expect(routeResult.unresolvedVisibleTables).toEqual([]);
    expect(routeResult.passed).toBe(true);
  });

  it('reports missingFromRawSnapshot when the browser saw a JSON resource absent from the artifact index', async () => {
    // No artifact persisted this time — the raw snapshot is empty.
    await writePageGraph(buildPageGraph(), cacheDir);
    await writeTokenTableGraph(buildTokenTableGraph(), cacheDir);

    const result = await compareCaptureToSnapshot({ capture: buildCapture(), cacheDir });

    expect(result.allPassed).toBe(false);
    expect(result.failedRoutes).toEqual(['/components/switch/overview']);
    expect(result.routes[0]!.missingFromRawSnapshot).toEqual([
      'https://m3.material.io/page-data/components/switch/overview/page-data.json'
    ]);
  });

  it('reports missingHeadings when the browser rendered a heading absent from the page graph', async () => {
    await seedPageDataArtifact();
    await writeTokenTableGraph(buildTokenTableGraph(), cacheDir);
    // Page graph only has "Switch" and "Usage" — missing "Accessibility" from the live DOM.
    const pageGraph = buildPageGraph();
    pageGraph.pages[0]!.headings = ['Switch', 'Usage'];
    await writePageGraph(pageGraph, cacheDir);

    const result = await compareCaptureToSnapshot({ capture: buildCapture(), cacheDir });

    expect(result.allPassed).toBe(false);
    expect(result.routes[0]!.missingHeadings).toEqual(['Accessibility']);
  });

  it('reports unresolvedVisibleTables when a visible table label has no matching resolved token', async () => {
    await seedPageDataArtifact();
    await writePageGraph(buildPageGraph(), cacheDir);
    await writeTokenTableGraph(buildTokenTableGraph(), cacheDir);

    const capture = buildCapture({
      dom: {
        headings: ['Switch', 'Usage', 'Accessibility'],
        visibleTableLabels: ['Selected track color', 'Some unrelated label never resolved']
      }
    });

    const result = await compareCaptureToSnapshot({ capture, cacheDir });

    expect(result.allPassed).toBe(false);
    expect(result.routes[0]!.unresolvedVisibleTables).toEqual(['Some unrelated label never resolved']);
  });

  it('marks a route as captureFailed (and failing) when navigation itself errored, without throwing', async () => {
    await writePageGraph(buildPageGraph(), cacheDir);
    await writeTokenTableGraph(buildTokenTableGraph(), cacheDir);

    const capture = buildCapture({ navigationError: 'simulated timeout', dom: null, finalUrl: null });

    const result = await compareCaptureToSnapshot({ capture, cacheDir });

    expect(result.allPassed).toBe(false);
    expect(result.routes[0]!.captureFailed).toBe(true);
    expect(result.routes[0]!.passed).toBe(false);
  });

  it('degrades gracefully (no throw) when no graph/artifact files exist yet for the cache dir', async () => {
    const result = await compareCaptureToSnapshot({ capture: buildCapture(), cacheDir });

    expect(result.allPassed).toBe(false);
    expect(result.routes[0]!.missingFromRawSnapshot.length).toBeGreaterThan(0);
    expect(result.routes[0]!.missingHeadings.length).toBeGreaterThan(0);
  });
});
