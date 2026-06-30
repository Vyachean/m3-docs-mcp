import { mkdtemp, rm, writeFile, mkdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { buildTokenResolutionSummary } from '../src/diagnostics/token-resolution-summary.js';
import { buildSpecPagesSummary } from '../src/diagnostics/spec-pages-summary.js';
import { buildRejectedRoutesSummary } from '../src/diagnostics/rejected-routes-summary.js';
import { writeCacheDiagnostics, readCacheDiagnosticsSummary } from '../src/diagnostics/write-cache-diagnostics.js';
import { validateCacheV2 } from '../src/validation/validate-cache-v2.js';
import { writeValidCacheV2Fixture } from './fixtures/cache-v2-fixture.js';
import { REQUIRED_PAGE_PATHS } from '../src/validation/validate-rendered-output.js';
import type { TokenTableGraph, PageGraph } from '../src/graph/graph-types.js';
import type { RoutePlanSummary, CoverageDiagnostics } from '../src/types.js';

const GENERATED_AT = '2026-06-30T00:00:00.000Z';

// ──────────────────────────────────────────────────────────────────────────────
// Helpers
// ──────────────────────────────────────────────────────────────────────────────

function makeTokenTableGraph(overrides: Partial<TokenTableGraph> = {}): TokenTableGraph {
  return { schemaVersion: 1, generatedAt: GENERATED_AT, tokenTables: [], ...overrides };
}

function makeResolvedTokenTable(): TokenTableGraph['tokenTables'][number] {
  return {
    resourceId: 'token-table:components/button',
    resourceName: 'md.comp.button',
    requestedTokenSets: ['md.comp.button'],
    routes: ['/components/buttons/specs'],
    unresolvedTokenCount: 0,
    tokenSets: [
      {
        tokenSetName: 'md.comp.button',
        displayName: 'Button - Common',
        tokens: [
          {
            tokenName: 'md.comp.button.container.color',
            displayName: 'Button container color',
            aliases: ['md.sys.color.primary'],
            values: [
              { role: 'light', value: '#6750A4', resolved: true },
              { role: 'dark', value: '#D0BCFF', resolved: true },
            ],
          },
        ],
      },
    ],
  };
}

function makeUnresolvedTokenTable(): TokenTableGraph['tokenTables'][number] {
  return {
    resourceId: 'token-table:components/switch',
    resourceName: 'md.comp.switch',
    requestedTokenSets: ['md.comp.switch'],
    routes: ['/components/switch/specs'],
    unresolvedTokenCount: 2,
    tokenSets: [
      {
        tokenSetName: 'md.comp.switch',
        displayName: 'Switch',
        tokens: [
          {
            tokenName: 'md.comp.switch.disabled.handle.elevation',
            displayName: 'Disabled handle elevation',
            aliases: [],
            values: [
              { role: 'light', value: null, resolved: false },
              { role: 'dark', value: null, resolved: false },
            ],
          },
          {
            tokenName: 'md.comp.switch.selected.handle.color',
            displayName: 'Selected handle color',
            aliases: ['md.sys.color.on-primary'],
            values: [
              { role: 'light', value: '#FFFFFF', resolved: true },
              { role: 'dark', value: '#381E72', resolved: true },
            ],
          },
        ],
      },
    ],
  };
}

function makePageGraph(pages: PageGraph['pages'] = []): PageGraph {
  return { schemaVersion: 1, generatedAt: GENERATED_AT, pages };
}

function makeSpecsPageNode(route: string, opts: { tokenTableIds?: string[]; sections?: PageGraph['pages'][number]['sections']; chunks?: PageGraph['pages'][number]['chunks']; resourceIds?: string[] } = {}): PageGraph['pages'][number] {
  return {
    pageId: `${route.replace(/^\//, '')}-id`,
    route,
    title: route,
    section: 'components',
    tabs: [],
    headings: [route],
    sections: opts.sections ?? [{ sectionId: 'sec-1', title: 'Specs', headingLevel: 1, chunkIds: ['chunk-1'] }],
    chunks: opts.chunks ?? [{ chunkId: 'chunk-1', chunkType: 'resource', resourceId: 'res-1', textExcerpt: null }],
    resourceIds: opts.resourceIds ?? ['res-1'],
    tokenTableIds: opts.tokenTableIds ?? ['token-table:components/switch'],
    unsupportedChunkTypes: [],
    provenance: { sourceArtifacts: [], sourceRoute: route, canonicalRoute: route, virtualRoute: null },
  };
}

const REBUILT_REQUIRED_PAGES = REQUIRED_PAGE_PATHS.map((pagePath) => ({
  id: pagePath,
  title: pagePath,
  url: `https://m3.material.io/${pagePath.replace(/^pages\//, '').replace(/\.md$/, '')}`,
  path: pagePath.replace(/^pages\//, ''),
  section: 'components',
  headings: ['OK'],
  text: 'OK',
  markdown: '# OK',
  capturedAt: GENERATED_AT,
}));

async function stubRebuild() {
  return {
    pages: REBUILT_REQUIRED_PAGES,
    report: { schemaVersion: 1 as const, generatedAt: GENERATED_AT, routes: [], requiredRouteFailures: [] },
  };
}

// ──────────────────────────────────────────────────────────────────────────────
// Token resolution summary tests
// ──────────────────────────────────────────────────────────────────────────────

describe('buildTokenResolutionSummary', () => {
  it('reports zero unresolved for a fully resolved token table graph', () => {
    const graph = makeTokenTableGraph({ tokenTables: [makeResolvedTokenTable()] });
    const summary = buildTokenResolutionSummary({ tokenTableGraph: graph, generatedAt: GENERATED_AT });

    expect(summary.schemaVersion).toBe(1);
    expect(summary.totalTokenTables).toBe(1);
    expect(summary.totalTokenRows).toBe(1);
    expect(summary.unresolvedTokenRows).toBe(0);
    expect(summary.unresolvedCellCount).toBe(0);
    expect(summary.unresolvedByRoute).toHaveLength(0);
    expect(summary.unresolvedByTokenTable).toHaveLength(0);
    expect(summary.unresolvedByReason.unclassified).toBe(0);
  });

  it('reports empty for an empty token table graph', () => {
    const summary = buildTokenResolutionSummary({ tokenTableGraph: makeTokenTableGraph(), generatedAt: GENERATED_AT });

    expect(summary.totalTokenTables).toBe(0);
    expect(summary.totalTokenRows).toBe(0);
    expect(summary.unresolvedTokenRows).toBe(0);
    expect(summary.unresolvedCellCount).toBe(0);
  });

  it('reports unresolved rows and cells with examples for [unresolved] tokens', () => {
    const graph = makeTokenTableGraph({ tokenTables: [makeUnresolvedTokenTable()] });
    const summary = buildTokenResolutionSummary({ tokenTableGraph: graph, generatedAt: GENERATED_AT });

    expect(summary.totalTokenRows).toBe(2);
    expect(summary.unresolvedTokenRows).toBe(1);
    expect(summary.unresolvedCellCount).toBe(2);
    expect(summary.unresolvedByReason.unclassified).toBe(1);

    expect(summary.unresolvedByRoute).toHaveLength(1);
    const routeEntry = summary.unresolvedByRoute[0]!;
    expect(routeEntry.route).toBe('/components/switch/specs');
    expect(routeEntry.unresolvedTokenRows).toBe(1);
    expect(routeEntry.unresolvedCellCount).toBe(2);
    expect(routeEntry.examples).toHaveLength(1);

    const example = routeEntry.examples[0]!;
    expect(example.token).toBe('md.comp.switch.disabled.handle.elevation');
    expect(example.tokenTableId).toBe('token-table:components/switch');
    expect(example.column).toBe('Light');
    expect(example.displayValue).toBe('[unresolved]');
    expect(example.unresolvedReason).toBe('unclassified');

    expect(summary.unresolvedByTokenTable).toHaveLength(1);
    const tableEntry = summary.unresolvedByTokenTable[0]!;
    expect(tableEntry.tokenTableId).toBe('token-table:components/switch');
    expect(tableEntry.unresolvedTokenRows).toBe(1);
    expect(tableEntry.unresolvedCellCount).toBe(2);
  });

  it('aggregates across multiple token tables and routes', () => {
    const graph = makeTokenTableGraph({ tokenTables: [makeResolvedTokenTable(), makeUnresolvedTokenTable()] });
    const summary = buildTokenResolutionSummary({ tokenTableGraph: graph, generatedAt: GENERATED_AT });

    expect(summary.totalTokenTables).toBe(2);
    expect(summary.totalTokenRows).toBe(3);
    expect(summary.unresolvedTokenRows).toBe(1);
    expect(summary.unresolvedByRoute).toHaveLength(1);
    expect(summary.unresolvedByTokenTable).toHaveLength(1);
  });

  it('does not hide [unresolved] — displayValue stays as literal string', () => {
    const graph = makeTokenTableGraph({ tokenTables: [makeUnresolvedTokenTable()] });
    const summary = buildTokenResolutionSummary({ tokenTableGraph: graph, generatedAt: GENERATED_AT });
    const example = summary.unresolvedByRoute[0]?.examples[0];
    expect(example?.displayValue).toBe('[unresolved]');
    expect(example?.displayValue).not.toBe('');
    expect(example?.displayValue).not.toBeNull();
  });

  it('does not throw and counts zero unresolved when token.values is missing (malformed graph entry)', () => {
    const malformedTable: TokenTableGraph['tokenTables'][number] = {
      resourceId: 'token-table:components/malformed',
      resourceName: 'md.comp.malformed',
      requestedTokenSets: [],
      routes: ['/components/malformed/specs'],
      unresolvedTokenCount: 0,
      tokenSets: [
        {
          tokenSetName: 'md.comp.malformed',
          displayName: 'Malformed',
          tokens: [
            {
              tokenName: 'md.comp.malformed.color',
              displayName: 'Malformed color',
              aliases: [],
              values: undefined as unknown as TokenTableGraph['tokenTables'][number]['tokenSets'][number]['tokens'][number]['values'],
            },
          ],
        },
      ],
    };
    const graph = makeTokenTableGraph({ tokenTables: [malformedTable] });

    expect(() => buildTokenResolutionSummary({ tokenTableGraph: graph, generatedAt: GENERATED_AT })).not.toThrow();
    const summary = buildTokenResolutionSummary({ tokenTableGraph: graph, generatedAt: GENERATED_AT });
    expect(summary.totalTokenRows).toBe(1);
    expect(summary.unresolvedTokenRows).toBe(0);
    expect(summary.unresolvedCellCount).toBe(0);
  });

  it('does not throw when tokenSets is missing on a token table (malformed graph entry)', () => {
    const malformedTable = {
      resourceId: 'token-table:components/no-sets',
      resourceName: 'md.comp.no-sets',
      requestedTokenSets: [],
      routes: ['/components/no-sets/specs'],
      unresolvedTokenCount: 0,
      tokenSets: undefined as unknown as TokenTableGraph['tokenTables'][number]['tokenSets'],
    };
    const graph = makeTokenTableGraph({ tokenTables: [malformedTable] });

    expect(() => buildTokenResolutionSummary({ tokenTableGraph: graph, generatedAt: GENERATED_AT })).not.toThrow();
    const summary = buildTokenResolutionSummary({ tokenTableGraph: graph, generatedAt: GENERATED_AT });
    expect(summary.totalTokenRows).toBe(0);
    expect(summary.unresolvedTokenRows).toBe(0);
  });

  it('does not throw when tokens is missing on a tokenSet (malformed graph entry)', () => {
    const malformedTable = {
      resourceId: 'token-table:components/no-tokens',
      resourceName: 'md.comp.no-tokens',
      requestedTokenSets: [],
      routes: ['/components/no-tokens/specs'],
      unresolvedTokenCount: 0,
      tokenSets: [
        {
          tokenSetName: 'md.comp.no-tokens',
          displayName: 'No Tokens',
          tokens: undefined as unknown as TokenTableGraph['tokenTables'][number]['tokenSets'][number]['tokens'],
        },
      ],
    };
    const graph = makeTokenTableGraph({ tokenTables: [malformedTable] });

    expect(() => buildTokenResolutionSummary({ tokenTableGraph: graph, generatedAt: GENERATED_AT })).not.toThrow();
    const summary = buildTokenResolutionSummary({ tokenTableGraph: graph, generatedAt: GENERATED_AT });
    expect(summary.totalTokenRows).toBe(0);
    expect(summary.unresolvedTokenRows).toBe(0);
  });

  it('does not throw when routes is missing on a token table (malformed graph entry)', () => {
    const malformedTable = {
      resourceId: 'token-table:components/no-routes',
      resourceName: 'md.comp.no-routes',
      requestedTokenSets: [],
      routes: undefined as unknown as TokenTableGraph['tokenTables'][number]['routes'],
      unresolvedTokenCount: 1,
      tokenSets: [
        {
          tokenSetName: 'md.comp.no-routes',
          displayName: 'No Routes',
          tokens: [
            {
              tokenName: 'md.comp.no-routes.color',
              displayName: 'No routes color',
              aliases: [],
              values: [{ role: 'light' as const, value: null, resolved: false }],
            },
          ],
        },
      ],
    };
    const graph = makeTokenTableGraph({ tokenTables: [malformedTable] });

    expect(() => buildTokenResolutionSummary({ tokenTableGraph: graph, generatedAt: GENERATED_AT })).not.toThrow();
    const summary = buildTokenResolutionSummary({ tokenTableGraph: graph, generatedAt: GENERATED_AT });
    expect(summary.totalTokenRows).toBe(1);
    expect(summary.unresolvedTokenRows).toBe(1);
    expect(summary.unresolvedByRoute).toHaveLength(0);
    expect(summary.unresolvedByTokenTable[0]?.routes).toEqual([]);
  });
});

// ──────────────────────────────────────────────────────────────────────────────
// Spec pages summary tests
// ──────────────────────────────────────────────────────────────────────────────

describe('buildSpecPagesSummary', () => {
  it('reports zero for empty inputs', () => {
    const summary = buildSpecPagesSummary({ pageGraph: makePageGraph(), markdownPagePaths: [], generatedAt: GENERATED_AT });

    expect(summary.schemaVersion).toBe(1);
    expect(summary.specPageCount).toBe(0);
    expect(summary.specPagesWithTokenTables).toBe(0);
    expect(summary.specPagesWithoutTokenTables).toHaveLength(0);
    expect(summary.specPagesMissingGraphPage).toHaveLength(0);
  });

  it('counts specs pages that have token table IDs', () => {
    const pageGraph = makePageGraph([
      makeSpecsPageNode('/components/switch/specs', { tokenTableIds: ['token-table:components/switch'] }),
      makeSpecsPageNode('/components/buttons/specs', { tokenTableIds: ['token-table:components/buttons'] }),
    ]);
    const summary = buildSpecPagesSummary({
      pageGraph,
      markdownPagePaths: ['components/switch/specs.md', 'components/buttons/specs.md'],
      generatedAt: GENERATED_AT,
    });

    expect(summary.specPageCount).toBe(2);
    expect(summary.specPagesWithTokenTables).toBe(2);
    expect(summary.specPagesWithoutTokenTables).toHaveLength(0);
  });

  it('reports missing token table IDs for a specs page', () => {
    const pageGraph = makePageGraph([
      makeSpecsPageNode('/components/switch/specs', { tokenTableIds: [] }),
    ]);
    const summary = buildSpecPagesSummary({
      pageGraph,
      markdownPagePaths: ['components/switch/specs.md'],
      generatedAt: GENERATED_AT,
    });

    expect(summary.specPagesWithTokenTables).toBe(0);
    expect(summary.specPagesWithoutTokenTables).toContain('/components/switch/specs');
  });

  it('reports missing graph page for a markdown specs path with no graph node', () => {
    const pageGraph = makePageGraph([]);
    const summary = buildSpecPagesSummary({
      pageGraph,
      markdownPagePaths: ['components/switch/specs.md', 'components/buttons/specs.md'],
      generatedAt: GENERATED_AT,
    });

    expect(summary.specPagesMissingGraphPage).toContain('/components/switch/specs');
    expect(summary.specPagesMissingGraphPage).toContain('/components/buttons/specs');
    expect(summary.specPageCount).toBe(2);
  });

  it('ignores non-specs markdown pages', () => {
    const pageGraph = makePageGraph([
      makeSpecsPageNode('/components/switch/specs', { tokenTableIds: ['token-table:components/switch'] }),
    ]);
    const summary = buildSpecPagesSummary({
      pageGraph,
      markdownPagePaths: ['components/switch/specs.md', 'components/switch/overview.md', 'styles/color/roles.md'],
      generatedAt: GENERATED_AT,
    });

    expect(summary.specPageCount).toBe(1);
    expect(summary.specPagesWithTokenTables).toBe(1);
  });

  it('reports specs pages with empty sections', () => {
    const pageGraph = makePageGraph([
      makeSpecsPageNode('/components/switch/specs', { sections: [], tokenTableIds: ['t'] }),
    ]);
    const summary = buildSpecPagesSummary({ pageGraph, markdownPagePaths: [], generatedAt: GENERATED_AT });
    expect(summary.specPagesWithEmptySections).toContain('/components/switch/specs');
  });

  it('reports specs pages with empty chunks', () => {
    const pageGraph = makePageGraph([
      makeSpecsPageNode('/components/switch/specs', { chunks: [], tokenTableIds: ['t'] }),
    ]);
    const summary = buildSpecPagesSummary({ pageGraph, markdownPagePaths: [], generatedAt: GENERATED_AT });
    expect(summary.specPagesWithEmptyChunks).toContain('/components/switch/specs');
  });

  it('reports specs pages with empty resource IDs', () => {
    const pageGraph = makePageGraph([
      makeSpecsPageNode('/components/switch/specs', { resourceIds: [], tokenTableIds: ['t'] }),
    ]);
    const summary = buildSpecPagesSummary({ pageGraph, markdownPagePaths: [], generatedAt: GENERATED_AT });
    expect(summary.specPagesWithEmptyResources).toContain('/components/switch/specs');
  });

  it('counts component-specific spec pages with and without token tables', () => {
    const pageGraph = makePageGraph([
      makeSpecsPageNode('/components/switch/specs', { tokenTableIds: ['token-table:components/switch'] }),
      makeSpecsPageNode('/components/buttons/specs', { tokenTableIds: [] }),
      // Non-component specs page — should not count in component-specific fields
      makeSpecsPageNode('/styles/motion/overview/specs', { tokenTableIds: [] }),
    ]);
    const summary = buildSpecPagesSummary({
      pageGraph,
      markdownPagePaths: [
        'components/switch/specs.md',
        'components/buttons/specs.md',
        'styles/motion/overview/specs.md',
      ],
      generatedAt: GENERATED_AT,
    });

    expect(summary.specPageCount).toBe(3);
    expect(summary.componentSpecPageCount).toBe(2);
    expect(summary.componentSpecPagesWithTokenTables).toBe(1);
    expect(summary.componentSpecPagesWithoutTokenTables).toContain('/components/buttons/specs');
    expect(summary.componentSpecPagesWithoutTokenTables).not.toContain('/styles/motion/overview/specs');
    // Non-component spec page still appears in the all-specs list
    expect(summary.specPagesWithoutTokenTables).toContain('/styles/motion/overview/specs');
  });

  it('reports zero component-specific counts when there are no /components/**/specs pages', () => {
    const pageGraph = makePageGraph([
      makeSpecsPageNode('/styles/motion/overview/specs', { tokenTableIds: [] }),
    ]);
    const summary = buildSpecPagesSummary({ pageGraph, markdownPagePaths: [], generatedAt: GENERATED_AT });

    expect(summary.componentSpecPageCount).toBe(0);
    expect(summary.componentSpecPagesWithTokenTables).toBe(0);
    expect(summary.componentSpecPagesWithoutTokenTables).toHaveLength(0);
  });

  it('does not throw when tokenTableIds is missing on a specs page (malformed graph entry)', () => {
    const malformedPage = {
      ...makeSpecsPageNode('/components/switch/specs'),
      tokenTableIds: undefined as unknown as string[],
    };
    const pageGraph = makePageGraph([malformedPage]);

    expect(() => buildSpecPagesSummary({ pageGraph, markdownPagePaths: [], generatedAt: GENERATED_AT })).not.toThrow();
    const summary = buildSpecPagesSummary({ pageGraph, markdownPagePaths: [], generatedAt: GENERATED_AT });
    expect(summary.specPagesWithTokenTables).toBe(0);
    expect(summary.specPagesWithoutTokenTables).toContain('/components/switch/specs');
  });

  it('does not throw when sections is missing on a specs page (malformed graph entry)', () => {
    const malformedPage = {
      ...makeSpecsPageNode('/components/switch/specs'),
      sections: undefined as unknown as PageGraph['pages'][number]['sections'],
    };
    const pageGraph = makePageGraph([malformedPage]);

    expect(() => buildSpecPagesSummary({ pageGraph, markdownPagePaths: [], generatedAt: GENERATED_AT })).not.toThrow();
    const summary = buildSpecPagesSummary({ pageGraph, markdownPagePaths: [], generatedAt: GENERATED_AT });
    expect(summary.specPagesWithEmptySections).toContain('/components/switch/specs');
  });

  it('does not throw when chunks is missing on a specs page (malformed graph entry)', () => {
    const malformedPage = {
      ...makeSpecsPageNode('/components/switch/specs'),
      chunks: undefined as unknown as PageGraph['pages'][number]['chunks'],
    };
    const pageGraph = makePageGraph([malformedPage]);

    expect(() => buildSpecPagesSummary({ pageGraph, markdownPagePaths: [], generatedAt: GENERATED_AT })).not.toThrow();
    const summary = buildSpecPagesSummary({ pageGraph, markdownPagePaths: [], generatedAt: GENERATED_AT });
    expect(summary.specPagesWithEmptyChunks).toContain('/components/switch/specs');
  });

  it('does not throw when resourceIds is missing on a specs page (malformed graph entry)', () => {
    const malformedPage = {
      ...makeSpecsPageNode('/components/switch/specs'),
      resourceIds: undefined as unknown as string[],
    };
    const pageGraph = makePageGraph([malformedPage]);

    expect(() => buildSpecPagesSummary({ pageGraph, markdownPagePaths: [], generatedAt: GENERATED_AT })).not.toThrow();
    const summary = buildSpecPagesSummary({ pageGraph, markdownPagePaths: [], generatedAt: GENERATED_AT });
    expect(summary.specPagesWithEmptyResources).toContain('/components/switch/specs');
  });
});

// ──────────────────────────────────────────────────────────────────────────────
// Rejected routes summary tests
// ──────────────────────────────────────────────────────────────────────────────

describe('buildRejectedRoutesSummary', () => {
  it('returns empty summary when no inputs are provided', () => {
    const summary = buildRejectedRoutesSummary({ generatedAt: GENERATED_AT });

    expect(summary.schemaVersion).toBe(1);
    expect(summary.stalePublicDocsRouteCount).toBe(0);
    expect(summary.policySkippedRouteCount).toBe(0);
    expect(summary.nonContentRouteCount).toBe(0);
    expect(summary.stalePublicDocsRoutes).toHaveLength(0);
  });

  it('includes stale public-docs routes and marks them unclassified', () => {
    const staleEntry = {
      route: '/components/banners',
      sources: ['site_meta' as const],
      publicDocsClassification: 'public-docs' as const,
      reconciliationStatus: 'rejectedStale' as const,
      navTitle: 'Banners',
      skippedReason: 'stale-content',
      failureReason: undefined,
    };
    const routePlanSummary: RoutePlanSummary = {
      acceptedRoutes: [],
      staleRoutes: [staleEntry],
      removedRoutes: [],
      ambiguousRoutes: [],
      nonPublicRoutes: [],
      extractionCandidates: [],
    };

    const summary = buildRejectedRoutesSummary({ routePlanSummary, generatedAt: GENERATED_AT });

    expect(summary.stalePublicDocsRouteCount).toBe(1);
    expect(summary.stalePublicDocsRoutes).toHaveLength(1);

    const entry = summary.stalePublicDocsRoutes[0]!;
    expect(entry.route).toBe('/components/banners');
    expect(entry.navTitle).toBe('Banners');
    expect(entry.reconciliationStatus).toBe('rejectedStale');
    expect(entry.publicDocsClassification).toBe('public-docs');
    expect(entry.disposition).toBe('unclassified');
  });

  it('excludes stale routes that are not public-docs classification', () => {
    const nonPublicStale = {
      route: '/components/internal-tool',
      sources: ['site_meta' as const],
      publicDocsClassification: 'outside-public-docs' as const,
      reconciliationStatus: 'rejectedStale' as const,
    };
    const routePlanSummary: RoutePlanSummary = {
      acceptedRoutes: [],
      staleRoutes: [nonPublicStale],
      removedRoutes: [],
      ambiguousRoutes: [],
      nonPublicRoutes: [],
      extractionCandidates: [],
    };

    const summary = buildRejectedRoutesSummary({ routePlanSummary, generatedAt: GENERATED_AT });

    expect(summary.stalePublicDocsRouteCount).toBe(0);
    expect(summary.stalePublicDocsRoutes).toHaveLength(0);
  });

  it('uses coverageDiagnostics for policySkippedRouteCount', () => {
    const coverageDiagnostics: Partial<CoverageDiagnostics> = {
      skippedByPolicyCount: 12,
    } as CoverageDiagnostics;

    const summary = buildRejectedRoutesSummary({ coverageDiagnostics: coverageDiagnostics as CoverageDiagnostics, generatedAt: GENERATED_AT });

    expect(summary.policySkippedRouteCount).toBe(12);
  });

  it('reports stalePublicDocsRouteSource as "unavailable" when no routePlanSummary is provided', () => {
    const summary = buildRejectedRoutesSummary({ generatedAt: GENERATED_AT });
    expect(summary.stalePublicDocsRouteSource).toBe('unavailable');
    expect(summary.stalePublicDocsRouteCount).toBe(0);
  });

  it('reports stalePublicDocsRouteSource as "routePlanSummary" when routePlanSummary is provided', () => {
    const routePlanSummary: RoutePlanSummary = {
      acceptedRoutes: [],
      staleRoutes: [],
      removedRoutes: [],
      ambiguousRoutes: [],
      nonPublicRoutes: [],
      extractionCandidates: [],
    };
    const summary = buildRejectedRoutesSummary({ routePlanSummary, generatedAt: GENERATED_AT });
    expect(summary.stalePublicDocsRouteSource).toBe('routePlanSummary');
  });

  it('falls back to coverageDiagnostics.fullRoutePlanSummary and reports correct source', () => {
    const staleEntry = {
      route: '/components/banners',
      sources: ['site_meta' as const],
      publicDocsClassification: 'public-docs' as const,
      reconciliationStatus: 'rejectedStale' as const,
      navTitle: 'Banners',
      skippedReason: 'stale-content',
      failureReason: undefined,
    };
    const coverageDiagnostics = {
      fullRoutePlanSummary: {
        acceptedRoutes: [],
        staleRoutes: [staleEntry],
        removedRoutes: [],
        ambiguousRoutes: [],
        nonPublicRoutes: [],
        extractionCandidates: [],
      },
    } as unknown as CoverageDiagnostics;

    const summary = buildRejectedRoutesSummary({ coverageDiagnostics, generatedAt: GENERATED_AT });

    expect(summary.stalePublicDocsRouteSource).toBe('coverageDiagnostics.fullRoutePlanSummary');
    expect(summary.stalePublicDocsRouteCount).toBe(1);
    expect(summary.stalePublicDocsRoutes[0]?.route).toBe('/components/banners');
  });

  it('does not throw when a route graph entry has no coverage field (malformed graph)', () => {
    // Simulate a partially malformed graph entry where coverage is missing at runtime.
    const malformedRoute = { route: '/components/button', coverage: undefined } as unknown as import('../src/graph/graph-types.js').RouteNode;
    const routeGraph = { schemaVersion: 1 as const, baseUrl: 'https://m3.material.io', generatedAt: GENERATED_AT, routes: [malformedRoute] } as import('../src/graph/graph-types.js').RouteGraph;

    expect(() => buildRejectedRoutesSummary({ routeGraph, generatedAt: GENERATED_AT })).not.toThrow();
    const summary = buildRejectedRoutesSummary({ routeGraph, generatedAt: GENERATED_AT });
    expect(summary.nonContentRouteCount).toBe(0);
  });
});

// ──────────────────────────────────────────────────────────────────────────────
// writeCacheDiagnostics + readCacheDiagnosticsSummary
// ──────────────────────────────────────────────────────────────────────────────

describe('writeCacheDiagnostics / readCacheDiagnosticsSummary', () => {
  let cacheDir: string;

  beforeEach(async () => {
    cacheDir = await mkdtemp(path.join(tmpdir(), 'm3-docs-mcp-diag-'));
  });

  afterEach(async () => {
    await rm(cacheDir, { recursive: true, force: true });
  });

  it('writes all three diagnostics files and returns summary counts', async () => {
    const tokenTableGraph: TokenTableGraph = makeTokenTableGraph({ tokenTables: [makeUnresolvedTokenTable()] });
    const pageGraph: PageGraph = makePageGraph([
      makeSpecsPageNode('/components/switch/specs', { tokenTableIds: ['token-table:components/switch'] }),
    ]);

    const summary = await writeCacheDiagnostics({
      cacheDir,
      tokenTableGraph,
      pageGraph,
      markdownPagePaths: ['components/switch/specs.md'],
      generatedAt: GENERATED_AT,
    });

    expect(summary.unresolvedTokenRows).toBe(1);
    expect(summary.unresolvedTokenCells).toBe(2);
    expect(summary.specPagesWithTokenTables).toBe(1);
    expect(summary.specPagesWithoutTokenTables).toBe(0);
    expect(summary.stalePublicDocsRoutes).toBe(0);
  });

  it('returns null from readCacheDiagnosticsSummary when files are absent', async () => {
    const result = await readCacheDiagnosticsSummary(cacheDir);
    expect(result).toBeNull();
  });

  it('reads back summary after writing', async () => {
    await writeCacheDiagnostics({
      cacheDir,
      tokenTableGraph: makeTokenTableGraph({ tokenTables: [makeUnresolvedTokenTable()] }),
      pageGraph: makePageGraph([makeSpecsPageNode('/components/switch/specs', { tokenTableIds: [] })]),
      markdownPagePaths: ['components/switch/specs.md'],
      generatedAt: GENERATED_AT,
    });

    const summary = await readCacheDiagnosticsSummary(cacheDir);
    expect(summary).not.toBeNull();
    expect(summary!.unresolvedTokenRows).toBe(1);
    expect(summary!.specPagesWithoutTokenTables).toBe(1);
    expect(summary!.specPagesWithTokenTables).toBe(0);
    expect(summary!.componentSpecPageCount).toBe(1);
    expect(summary!.componentSpecPagesWithoutTokenTables).toBe(1);
    expect(summary!.componentSpecPagesWithTokenTables).toBe(0);
    expect(summary!.stalePublicDocsRouteSource).toBe('unavailable');
  });

  it('quality diagnostics remain non-fatal — writeCacheDiagnostics throws when cacheDir is a file, not a directory', async () => {
    // Create a file where writeCacheDiagnostics would try to write a subdirectory.
    // This causes mkdir to fail because the path component is a file.
    const fileNotDir = path.join(cacheDir, 'block-diagnostics');
    await writeFile(fileNotDir, '{}');
    // writeCacheDiagnostics should reject because it cannot mkdir under a file path
    await expect(
      writeCacheDiagnostics({ cacheDir: fileNotDir, generatedAt: GENERATED_AT }),
    ).rejects.toThrow();
    // The crawler wraps writeCacheDiagnostics in runObservationalStep which swallows this error,
    // keeping promotion alive even in --strict-graph mode.
  });

  it('returns stalePublicDocsRouteSource from written files when routePlanSummary is available', async () => {
    const routePlanSummary: RoutePlanSummary = {
      acceptedRoutes: [],
      staleRoutes: [],
      removedRoutes: [],
      ambiguousRoutes: [],
      nonPublicRoutes: [],
      extractionCandidates: [],
    };
    await writeCacheDiagnostics({
      cacheDir,
      routePlanSummary,
      generatedAt: GENERATED_AT,
    });
    const summary = await readCacheDiagnosticsSummary(cacheDir);
    expect(summary).not.toBeNull();
    expect(summary!.stalePublicDocsRouteSource).toBe('routePlanSummary');
    expect(summary!.stalePublicDocsRoutes).toBe(0);
  });
});

// ──────────────────────────────────────────────────────────────────────────────
// validateCacheV2 quality extension
// ──────────────────────────────────────────────────────────────────────────────

describe('validateCacheV2 quality field', () => {
  let cacheDir: string;

  beforeEach(async () => {
    cacheDir = await mkdtemp(path.join(tmpdir(), 'm3-docs-mcp-validate-quality-'));
  });

  afterEach(async () => {
    await rm(cacheDir, { recursive: true, force: true });
  });

  it('passes and omits quality field when diagnostics files are absent', async () => {
    await writeValidCacheV2Fixture(cacheDir);
    const result = await validateCacheV2({ cacheDir, renderedOutputRebuildFn: stubRebuild });

    expect(result.allPassed).toBe(true);
    expect(result.quality).toBeUndefined();
  });

  it('passes and includes quality summary when diagnostics files exist with unresolved values', async () => {
    await writeValidCacheV2Fixture(cacheDir);
    await writeCacheDiagnostics({
      cacheDir,
      tokenTableGraph: makeTokenTableGraph({ tokenTables: [makeUnresolvedTokenTable()] }),
      pageGraph: makePageGraph([makeSpecsPageNode('/components/switch/specs', { tokenTableIds: ['token-table:components/switch'] })]),
      markdownPagePaths: ['components/switch/specs.md'],
      generatedAt: GENERATED_AT,
    });

    const result = await validateCacheV2({ cacheDir, renderedOutputRebuildFn: stubRebuild });

    expect(result.allPassed).toBe(true);
    expect(result.quality).toBeDefined();
    expect(result.quality!.unresolvedTokenRows).toBe(1);
    expect(result.quality!.unresolvedTokenCells).toBe(2);
    expect(result.quality!.specPagesWithTokenTables).toBe(1);
    expect(result.quality!.specPagesWithoutTokenTables).toBe(0);
    expect(result.quality!.componentSpecPageCount).toBe(1);
    expect(result.quality!.componentSpecPagesWithTokenTables).toBe(1);
    expect(result.quality!.componentSpecPagesWithoutTokenTables).toBe(0);
    expect(result.quality!.unclassifiedRejectedPublicDocsRoutes).toBe(0);
    expect(result.quality!.stalePublicDocsRouteSource).toBe('unavailable');
  });

  it('passes in default mode even when quality diagnostics contain unresolved values', async () => {
    await writeValidCacheV2Fixture(cacheDir);
    await writeCacheDiagnostics({
      cacheDir,
      tokenTableGraph: makeTokenTableGraph({ tokenTables: [makeUnresolvedTokenTable(), makeUnresolvedTokenTable()] }),
      pageGraph: makePageGraph([makeSpecsPageNode('/components/switch/specs', { tokenTableIds: [] })]),
      markdownPagePaths: ['components/switch/specs.md'],
      generatedAt: GENERATED_AT,
    });

    const result = await validateCacheV2({ cacheDir, renderedOutputRebuildFn: stubRebuild });

    expect(result.allPassed).toBe(true);
    expect(result.quality!.unresolvedTokenRows).toBe(2);
    expect(result.quality!.specPagesWithoutTokenTables).toBe(1);
  });
});
