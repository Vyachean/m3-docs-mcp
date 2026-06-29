import { describe, expect, it } from 'vitest';
import { buildPageGraph } from '../src/graph/page-graph.js';
import { buildResourceGraph } from '../src/graph/resource-graph.js';
import { backfillResourcePageIdsForTest } from '../src/graph/build-graph.js';
import type { ExtractionPageDiagnostic, ExtractionRouteDiagnostic, MaterialPageMeta } from '../src/types.js';

function makePageDiagnostic(overrides: Partial<ExtractionPageDiagnostic> = {}): ExtractionPageDiagnostic {
  return {
    url: 'https://m3.material.io/components/switch/specs',
    path: 'components/switch/specs.md',
    method: 'json',
    unknownChunkTypes: [],
    unknownResourceTypes: [],
    tokenTables: 1,
    tokenTablesRendered: 1,
    tokenContextDiagnostics: [{
      resourceName: 'md.comp.switch',
      requestedTokenSets: ['Selected'],
      renderedTokenSets: ['Selected'],
      selectedContextKeys: [],
      skippedContextKeys: [],
      availableContextKeys: [],
      unresolvedTokenCount: 0,
      missingRequestedTokenSetCount: 0,
      usedFallbackContext: false,
      multipleContextVariantsAvailable: false,
    }],
    statusTableDiagnostics: [],
    missingRequestedTokenSets: [],
    suspiciousReasons: [],
    imageCount: 1,
    videoCount: 0,
    unresolvedResourceCount: 0,
    noSections: false,
    noHeadings: false,
    markdownLength: 500,
    ...overrides,
  };
}

function makeRouteDiagnostic(overrides: Partial<ExtractionRouteDiagnostic> = {}): ExtractionRouteDiagnostic {
  return {
    url: 'https://m3.material.io/components/switch/specs',
    path: 'components/switch/specs.md',
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
    tokenContextDiagnostics: [],
    statusTablesRequested: 0,
    statusTablesResolved: 0,
    statusTablesDecoded: 0,
    statusTablesRendered: 0,
    statusTablesRenderedAsPlaceholder: 0,
    unsupportedStatusTableSchemaCount: 0,
    resourceChunksRequested: 0,
    resourceChunksResolved: 0,
    resourceChunksDecoded: 0,
    resourceChunksRendered: 0,
    resourceChunksPlaceholder: 0,
    missingRequestedTokenSets: [],
    sourceRoute: '/components/switch',
    canonicalRoute: '/components/switch',
    virtualRoute: '/components/switch/specs',
    ...overrides,
  };
}

function makePageMeta(overrides: Partial<MaterialPageMeta> = {}): MaterialPageMeta {
  return {
    id: 'switch-specs',
    title: 'Switch specs',
    url: 'https://m3.material.io/components/switch/specs',
    path: 'components/switch/specs.md',
    section: 'components',
    headings: ['Switch specs'],
    capturedAt: '2026-06-01T00:00:00.000Z',
    ...overrides,
  };
}

describe('PageGraph <-> ResourceGraph real cross-links (resource-identity.ts)', () => {
  it('populates PageNode.resourceIds/tokenTableIds and chunks[].resourceId with real ResourceGraph ids', () => {
    const pageDiagnostic = makePageDiagnostic();
    const routeDiagnostic = makeRouteDiagnostic();
    const pageGraph = buildPageGraph({
      pages: [makePageMeta()],
      pageDiagnostics: [pageDiagnostic],
      routeDiagnostics: [routeDiagnostic],
    });
    const resourceGraph = buildResourceGraph({
      pageDiagnostics: [pageDiagnostic],
      routeDiagnostics: [routeDiagnostic],
    });

    const page = pageGraph.pages[0]!;
    // Real cross-references, not the old empty placeholders.
    expect(page.resourceIds.length).toBeGreaterThan(0);
    expect(page.tokenTableIds).toEqual(['token-table:md.comp.switch']);

    const resourceIds = new Set(resourceGraph.resources.map((r) => r.resourceId));
    const resourceChunks = page.chunks.filter((c) => c.chunkType === 'resource' || c.chunkType === 'image');
    expect(resourceChunks.length).toBeGreaterThan(0);
    for (const chunk of resourceChunks) {
      expect(chunk.resourceId).toBeTruthy();
      // Every chunk resourceId must point at a real node that actually exists in the resource graph.
      expect(resourceIds.has(chunk.resourceId!)).toBe(true);
    }

    const tokenTableResource = resourceGraph.resources.find((r) => r.resourceId === 'token-table:md.comp.switch');
    expect(tokenTableResource).toBeDefined();
    expect(tokenTableResource?.kind).toBe('token-table');
    expect(tokenTableResource?.resourceName).toBe('md.comp.switch');

    backfillResourcePageIdsForTest(resourceGraph, pageGraph);
    expect(tokenTableResource?.pageIds).toContain('switch-specs');
  });
});
