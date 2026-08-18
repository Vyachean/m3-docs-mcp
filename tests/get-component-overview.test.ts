import { describe, expect, it } from 'vitest';
import {
  PageGraphSchema,
  ResourceGraphSchema,
  RouteGraphSchema,
  TokenTableGraphSchema,
} from '../src/graph/graph-types.js';
import { getComponentOverview } from '../src/mcp-tools/get-component-overview.js';
import type { GraphToolContext } from '../src/mcp-tools/context.js';

function coverage() {
  return {
    status: 'covered' as const,
    reasons: [],
    originalStatus: 'covered' as const,
    sharedCoverageGroup: null,
    sharedWithRoutes: [],
    expectedOutputPaths: [],
    savedOutputPaths: [],
    failedOutputPaths: [],
    skippedOutputPaths: [],
  };
}

function route(routeValue: string, title: string, tabs: Array<{ label: string; route: string }> = []) {
  return {
    route: routeValue,
    canonicalRoute: null,
    aliases: [],
    title,
    section: 'components',
    reference: {
      collectionId: null,
      documentId: null,
      exportedCarbonFileId: null,
      pageCanonId: null,
      carbonVersion: null,
    },
    tabs: tabs.map((tab) => ({
      ...tab,
      slug: tab.route.split('/').at(-1) ?? '',
      matchedSectionId: null,
      matchReason: 'unmatched' as const,
    })),
    origins: ['site_meta' as const],
    sourceArtifacts: [],
    expectedOutputPaths: [],
    generatedOutputPaths: [],
    coverage: coverage(),
  };
}

function page(pageRoute: string, pageId: string) {
  return {
    pageId,
    route: pageRoute,
    title: 'Buttons',
    section: 'components',
    tabs: [],
    headings: ['Buttons'],
    sections: [],
    chunks: [],
    resourceIds: [],
    tokenTableIds: [],
    unsupportedChunkTypes: [],
    provenance: {
      sourceArtifacts: [],
      sourceRoute: pageRoute,
      canonicalRoute: pageRoute,
      virtualRoute: null,
    },
  };
}

function makeContext(): GraphToolContext {
  return {
    cacheDir: '/cache',
    routeGraph: RouteGraphSchema.parse({
      schemaVersion: 1,
      generatedAt: '2026-08-18T00:00:00.000Z',
      baseUrl: 'https://m3.material.io',
      routes: [
        route('/components/buttons', 'Buttons', [
          { label: 'Overview', route: '/components/buttons/overview' },
          { label: 'Specs', route: '/components/buttons/specs' },
        ]),
        route('/components/buttons/overview', 'Buttons overview'),
        route('/components/buttons/specs', 'Buttons specs'),
        route('/components/checkbox', 'Checkbox'),
      ],
    }),
    pageGraph: PageGraphSchema.parse({
      schemaVersion: 1,
      generatedAt: '2026-08-18T00:00:00.000Z',
      pages: [
        page('/components/buttons/overview', 'buttons-overview'),
        page('/components/buttons/specs', 'buttons-specs'),
      ],
    }),
    resourceGraph: ResourceGraphSchema.parse({
      schemaVersion: 1,
      generatedAt: '2026-08-18T00:00:00.000Z',
      resources: [
        {
          resourceId: 'button-tokens',
          kind: 'token-table',
          resourceName: 'Button tokens',
          sourceArtifact: null,
          routes: ['/components/buttons/specs'],
          pageIds: ['buttons-specs'],
          chunkIds: [],
          status: 'resolved',
          unresolvedReason: null,
        },
        {
          resourceId: 'button-image',
          kind: 'image',
          resourceName: 'Button anatomy',
          sourceArtifact: null,
          routes: ['/components/buttons/overview'],
          pageIds: ['buttons-overview'],
          chunkIds: [],
          status: 'resolved',
          unresolvedReason: null,
        },
      ],
    }),
    tokenTableGraph: TokenTableGraphSchema.parse({
      schemaVersion: 1,
      generatedAt: '2026-08-18T00:00:00.000Z',
      tokenTables: [{
        resourceId: 'button-tokens',
        resourceName: 'Button tokens',
        requestedTokenSets: ['md.comp.button'],
        tokenSets: [{
          tokenSetName: 'md.comp.button',
          displayName: 'Button',
          tokens: [{
            tokenName: 'md.comp.button.container.color',
            displayName: 'Container color',
            aliases: [],
            values: [{ role: 'light', value: '#6750A4', resolved: true }],
          }],
        }],
        routes: ['/components/buttons/specs'],
        unresolvedTokenCount: 0,
      }],
    }),
    sectionGraph: null,
    provenanceGraph: null,
    artifactIndex: { artifacts: [] },
    materialIndex: null,
  };
}

describe('getComponentOverview', () => {
  it('summarizes component graph data and recommends focused page routes', () => {
    const result = getComponentOverview(makeContext(), 'button');

    expect(result).toEqual({
      available: true,
      message: null,
      component: 'button',
      found: true,
      canonicalName: 'Buttons',
      componentSlug: 'buttons',
      routes: [
        { route: '/components/buttons', title: 'Buttons', coverageStatus: 'covered', hasStructuredPage: false },
        { route: '/components/buttons/overview', title: 'Buttons overview', coverageStatus: 'covered', hasStructuredPage: true },
        { route: '/components/buttons/specs', title: 'Buttons specs', coverageStatus: 'covered', hasStructuredPage: true },
      ],
      tabs: [
        { label: 'Overview', route: '/components/buttons/overview' },
        { label: 'Specs', route: '/components/buttons/specs' },
      ],
      tokenTables: [{
        resourceId: 'button-tokens',
        resourceName: 'Button tokens',
        tokenSetCount: 1,
        tokenCount: 1,
        unresolvedTokenCount: 0,
      }],
      resourceCounts: {
        'token-table': 1,
        'status-table': 0,
        image: 1,
        video: 0,
        'unknown-resource': 0,
      },
      recommendedRoutes: [
        '/components/buttons/specs',
        '/components/buttons/overview',
      ],
    });
  });

  it('returns an explicit not-found result without borrowing another component', () => {
    const result = getComponentOverview(makeContext(), 'slider');

    expect(result).toMatchObject({
      available: true,
      found: false,
      component: 'slider',
      componentSlug: 'slider',
      routes: [],
      tabs: [],
      tokenTables: [],
      recommendedRoutes: [],
    });
  });

  it('reports graph unavailability instead of guessing', () => {
    const context = makeContext();
    context.routeGraph = null;

    const result = getComponentOverview(context, 'button');

    expect(result).toMatchObject({
      available: false,
      found: false,
      canonicalName: null,
      routes: [],
    });
    expect(result.message).toContain('graph/routes.json');
  });
});
