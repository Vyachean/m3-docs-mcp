import { describe, expect, it } from 'vitest';
import { buildPageGraph } from '../src/graph/page-graph.js';
import type { ArtifactRecord } from '../src/raw-artifacts/artifact-types.js';
import type { ExtractionPageDiagnostic, ExtractionRouteDiagnostic, MaterialPageMeta } from '../src/types.js';

function routeDiagnostic(overrides: Partial<ExtractionRouteDiagnostic>): ExtractionRouteDiagnostic {
  return {
    url: 'https://m3.material.io/components/switch',
    path: 'components/switch/overview.md',
    sourceUsed: 'direct-json',
    finalMethod: 'json',
    jsonAttempted: true,
    jsonSucceeded: true,
    browserFallbackAttempted: false,
    browserFallbackSucceeded: false,
    unknownChunkTypes: [],
    unknownResourceTypes: [],
    tokenTables: 0,
    tokenTablesRendered: 0,
    missingRequestedTokenSets: [],
    ...overrides,
  };
}

function pageMeta(overrides: Partial<MaterialPageMeta>): MaterialPageMeta {
  return {
    id: overrides.path ?? 'p1',
    title: 'Switch',
    url: 'https://m3.material.io/components/switch',
    path: 'components/switch/overview.md',
    section: 'components',
    headings: [],
    capturedAt: '2026-06-01T00:00:00.000Z',
    ...overrides,
  };
}

function artifact(overrides: Partial<ArtifactRecord> = {}): ArtifactRecord {
  return {
    id: 'page-data:raw/page-data/c1/d1.json',
    kind: 'page-data',
    sourceUrl: 'https://m3.material.io/components/switches',
    localPath: 'raw/page-data/c1/d1.json',
    httpStatus: 200,
    contentType: 'application/json',
    sha256: 'a'.repeat(64),
    fetchedAt: '2026-06-01T00:00:00.000Z',
    sourceRoute: '/components/switches',
    sourceMethod: 'static-plan',
    error: null,
    diagnostics: null,
    ...overrides,
  };
}

function makePageDiagnostic(overrides: Partial<ExtractionPageDiagnostic> = {}): ExtractionPageDiagnostic {
  return {
    url: 'https://m3.material.io/components/switch',
    path: 'components/switch/overview.md',
    method: 'json',
    unknownChunkTypes: [],
    unknownResourceTypes: [],
    tokenTables: 0,
    tokenTablesRendered: 0,
    tokenContextDiagnostics: [],
    missingRequestedTokenSets: [],
    suspiciousReasons: [],
    imageCount: 0,
    videoCount: 0,
    unresolvedResourceCount: 0,
    noSections: false,
    noHeadings: false,
    markdownLength: 100,
    ...overrides,
  };
}

describe('buildPageGraph route identity per tab', () => {
  it('reports each tabbed page under its own virtual route, not the shared parent source route', () => {
    const pages: MaterialPageMeta[] = [
      pageMeta({ path: 'components/switch/overview.md' }),
      pageMeta({ path: 'components/switch/specs.md' }),
    ];
    const routeDiagnostics: ExtractionRouteDiagnostic[] = [
      routeDiagnostic({ path: 'components/switch/overview.md', sourceRoute: '/components/switches', virtualRoute: '/components/switch/overview', tabName: 'Overview' }),
      routeDiagnostic({ path: 'components/switch/specs.md', sourceRoute: '/components/switches', virtualRoute: '/components/switch/specs', tabName: 'Specs' }),
    ];
    const graph = buildPageGraph({
      pages,
      pageDiagnostics: [makePageDiagnostic(), makePageDiagnostic({ path: 'components/switch/specs.md' })],
      routeDiagnostics,
    });
    const routes = graph.pages.map((p) => p.route);
    expect(routes).toEqual(['/components/switch/overview', '/components/switch/specs']);
    // distinct per-tab identity, not collapsed onto the shared source route
    expect(new Set(routes).size).toBe(2);
  });

  it('still finds source artifacts recorded under the actually-fetched source route, even though the reported route is the per-tab virtual route', () => {
    const pages: MaterialPageMeta[] = [pageMeta({ path: 'components/switch/specs.md' })];
    const routeDiagnostics: ExtractionRouteDiagnostic[] = [
      routeDiagnostic({ path: 'components/switch/specs.md', sourceRoute: '/components/switches', virtualRoute: '/components/switch/specs', tabName: 'Specs' }),
    ];
    const graph = buildPageGraph({
      pages,
      pageDiagnostics: [makePageDiagnostic({ path: 'components/switch/specs.md' })],
      routeDiagnostics,
      artifactRecords: [artifact({ sourceRoute: '/components/switches' })],
    });
    expect(graph.pages[0]?.route).toBe('/components/switch/specs');
    expect(graph.pages[0]?.provenance.sourceArtifacts).toEqual([{ artifactId: 'page-data:raw/page-data/c1/d1.json', kind: 'page-data' }]);
  });
});
