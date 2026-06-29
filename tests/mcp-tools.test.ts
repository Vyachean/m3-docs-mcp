import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { writeIndex } from '../src/cache.js';
import {
  writePageGraph,
  writeProvenanceGraph,
  writeResourceGraph,
  writeRouteGraph,
  writeTokenTableGraph,
} from '../src/graph/graph-store.js';
import type { PageGraph, ProvenanceGraph, ResourceGraph, RouteGraph, TokenTableGraph } from '../src/graph/graph-types.js';
import { upsertArtifactRecord } from '../src/raw-artifacts/artifact-index.js';
import { persistArtifact } from '../src/raw-artifacts/artifact-store.js';
import type { ArtifactRecord } from '../src/raw-artifacts/artifact-types.js';
import { loadGraphToolContext } from '../src/mcp-tools/context.js';
import { explainResourceResolution } from '../src/mcp-tools/explain-resource-resolution.js';
import { explainRouteCoverage } from '../src/mcp-tools/explain-route-coverage.js';
import { getComponentResources } from '../src/mcp-tools/get-component-resources.js';
import { getComponentTabs } from '../src/mcp-tools/get-component-tabs.js';
import { getComponentTokens } from '../src/mcp-tools/get-component-tokens.js';
import { getPage } from '../src/mcp-tools/get-page.js';
import { DEFAULT_PREVIEW_CHARS, FULL_CONTENT_MAX_BYTES, getRawArtifact } from '../src/mcp-tools/get-raw-artifact.js';
import { getRoute } from '../src/mcp-tools/get-route.js';
import { getRouteArtifacts } from '../src/mcp-tools/get-route-artifacts.js';
import { listRoutes } from '../src/mcp-tools/list-routes.js';
import { MaterialDocsStore } from '../src/store.js';
import type { MaterialIndex } from '../src/types.js';

let cacheDir: string;

beforeEach(async () => {
  cacheDir = await mkdtemp(path.join(tmpdir(), 'm3-docs-mcp-tools-'));
});

afterEach(async () => {
  await rm(cacheDir, { recursive: true, force: true });
});

function makeRouteGraph(overrides: Partial<RouteGraph> = {}): RouteGraph {
  return {
    schemaVersion: 1,
    generatedAt: '2026-06-01T00:00:00.000Z',
    baseUrl: 'https://m3.material.io',
    routes: [],
    ...overrides,
  };
}

function buttonsSwitchRoutes(): RouteGraph['routes'] {
  return [
    {
      route: '/components/buttons/overview',
      canonicalRoute: '/components/buttons/overview',
      aliases: ['/components/buttons'],
      title: 'Buttons',
      section: 'components',
      reference: { collectionId: 'col-1', documentId: 'doc-1', exportedCarbonFileId: 'carbon-1', pageCanonId: 'canon-1', carbonVersion: null },
      tabs: [],
      origins: ['site_meta'],
      sourceArtifacts: [{ artifactId: 'page-data:raw/page-data/col-1/doc-1.json', kind: 'page-data' }],
      expectedOutputPaths: ['components/buttons/overview.md'],
      generatedOutputPaths: ['components/buttons/overview.md'],
      coverage: {
        status: 'covered',
        reasons: [],
        originalStatus: 'covered',
        sharedCoverageGroup: 'group-buttons',
        sharedWithRoutes: ['/components/buttons'],
        expectedOutputPaths: ['components/buttons/overview.md'],
        savedOutputPaths: ['components/buttons/overview.md'],
        failedOutputPaths: [],
        skippedOutputPaths: [],
      },
    },
    {
      route: '/components/buttons',
      canonicalRoute: '/components/buttons/overview',
      aliases: [],
      title: 'Buttons',
      section: 'components',
      reference: { collectionId: null, documentId: null, exportedCarbonFileId: null, pageCanonId: null, carbonVersion: null },
      tabs: [],
      origins: ['nav_drawer'],
      sourceArtifacts: [],
      expectedOutputPaths: [],
      generatedOutputPaths: [],
      coverage: {
        status: 'covered',
        reasons: [],
        originalStatus: 'aliasOnly',
        sharedCoverageGroup: 'group-buttons',
        sharedWithRoutes: ['/components/buttons/overview'],
        expectedOutputPaths: [],
        savedOutputPaths: [],
        failedOutputPaths: [],
        skippedOutputPaths: [],
      },
    },
    {
      route: '/components/switch/specs',
      canonicalRoute: '/components/switch/specs',
      aliases: [],
      title: 'Switch specs',
      section: 'components',
      reference: { collectionId: 'col-2', documentId: 'doc-2', exportedCarbonFileId: null, pageCanonId: null, carbonVersion: null },
      tabs: [{ label: 'Specs', route: '/components/switch/specs/specs', slug: 'specs', matchedSectionId: null, matchReason: 'unmatched' }],
      origins: ['bundle'],
      sourceArtifacts: [],
      expectedOutputPaths: ['components/switch/specs.md'],
      generatedOutputPaths: [],
      coverage: {
        status: 'failed',
        reasons: ['json-fetch-failed'],
        originalStatus: 'failed',
        sharedCoverageGroup: null,
        sharedWithRoutes: [],
        expectedOutputPaths: ['components/switch/specs.md'],
        savedOutputPaths: [],
        failedOutputPaths: ['components/switch/specs.md'],
        skippedOutputPaths: [],
      },
    },
  ];
}

describe('list_routes (list-routes.ts)', () => {
  it('reports unavailable when graph/routes.json does not exist', async () => {
    const context = await loadGraphToolContext(cacheDir);
    const result = listRoutes(context, { limit: 10 });
    expect(result.available).toBe(false);
    expect(result.routes).toEqual([]);
    expect(result.message).toContain('not available');
  });

  it('returns a compact catalog with hasStructuredPage/hasMarkdown flags', async () => {
    await writeRouteGraph(makeRouteGraph({ routes: buttonsSwitchRoutes() }), cacheDir);
    const pageGraph: PageGraph = {
      schemaVersion: 1,
      generatedAt: '2026-06-01T00:00:00.000Z',
      pages: [
        {
          pageId: 'buttons-overview',
          route: '/components/buttons/overview',
          title: 'Buttons',
          section: 'components',
          tabs: [],
          headings: ['Buttons'],
          sections: [],
          chunks: [],
          resourceIds: [],
          tokenTableIds: [],
          unsupportedChunkTypes: [],
          provenance: { sourceArtifacts: [], sourceRoute: '/components/buttons/overview', canonicalRoute: '/components/buttons/overview', virtualRoute: null },
        },
      ],
    };
    await writePageGraph(pageGraph, cacheDir);

    const index: MaterialIndex = {
      source: 'https://m3.material.io',
      capturedAt: '2026-06-01T00:00:00.000Z',
      pageCount: 1,
      attemptedPageCount: 1,
      failedPageCount: 0,
      failedUrls: [],
      pages: [{
        id: 'buttons-overview',
        title: 'Buttons',
        url: 'https://m3.material.io/components/buttons/overview',
        path: 'components/buttons/overview.md',
        section: 'components',
        headings: ['Buttons'],
        capturedAt: '2026-06-01T00:00:00.000Z',
      }],
    };
    await writeIndex(index, cacheDir);

    const context = await loadGraphToolContext(cacheDir);
    const result = listRoutes(context, { limit: 10 });

    expect(result.available).toBe(true);
    expect(result.totalMatched).toBe(3);
    expect(result.routes).toHaveLength(3);
    const buttonsOverview = result.routes.find((r) => r.route === '/components/buttons/overview');
    expect(buttonsOverview).toMatchObject({ hasStructuredPage: true, hasMarkdown: true, coverageStatus: 'covered' });
    const switchSpecs = result.routes.find((r) => r.route === '/components/switch/specs');
    expect(switchSpecs).toMatchObject({ hasStructuredPage: false, hasMarkdown: false, coverageStatus: 'failed' });
  });

  it('filters by section/coverageStatus/search and truncates to limit', async () => {
    await writeRouteGraph(makeRouteGraph({ routes: buttonsSwitchRoutes() }), cacheDir);
    const context = await loadGraphToolContext(cacheDir);

    const byStatus = listRoutes(context, { coverageStatus: 'failed', limit: 10 });
    expect(byStatus.routes.map((r) => r.route)).toEqual(['/components/switch/specs']);

    const bySearch = listRoutes(context, { search: 'switch', limit: 10 });
    expect(bySearch.routes.map((r) => r.route)).toEqual(['/components/switch/specs']);

    const limited = listRoutes(context, { limit: 1 });
    expect(limited.returned).toBe(1);
    expect(limited.truncated).toBe(true);
    expect(limited.totalMatched).toBe(3);
  });
});

describe('get_route (get-route.ts)', () => {
  it('returns not-found for an unknown route without throwing', async () => {
    await writeRouteGraph(makeRouteGraph({ routes: buttonsSwitchRoutes() }), cacheDir);
    const context = await loadGraphToolContext(cacheDir);
    const result = getRoute(context, '/components/does-not-exist');
    expect(result.available).toBe(true);
    expect(result.found).toBe(false);
    expect(result.route).toBeNull();
  });

  it('finds a route by canonical route or alias and preserves status vs originalStatus nuance', async () => {
    await writeRouteGraph(makeRouteGraph({ routes: buttonsSwitchRoutes() }), cacheDir);
    const context = await loadGraphToolContext(cacheDir);

    const byAlias = getRoute(context, '/components/buttons');
    expect(byAlias.found).toBe(true);
    expect(byAlias.route?.coverage.status).toBe('covered');
    expect(byAlias.route?.coverage.originalStatus).toBe('aliasOnly');
    expect(byAlias.route?.coverage.sharedCoverageGroup).toBe('group-buttons');
  });

  it('reports unavailable when the graph is missing', async () => {
    const context = await loadGraphToolContext(cacheDir);
    const result = getRoute(context, '/components/buttons');
    expect(result.available).toBe(false);
    expect(result.found).toBe(false);
  });
});

describe('explain_route_coverage (explain-route-coverage.ts)', () => {
  it('explains aliasOnly vs covered nuance with shared group members', async () => {
    await writeRouteGraph(makeRouteGraph({ routes: buttonsSwitchRoutes() }), cacheDir);
    const context = await loadGraphToolContext(cacheDir);

    const result = explainRouteCoverage(context, '/components/buttons');
    expect(result.found).toBe(true);
    expect(result.status).toBe('covered');
    expect(result.originalStatus).toBe('aliasOnly');
    expect(result.sharedCoverageGroupMembers).toEqual([{ route: '/components/buttons/overview', originalStatus: 'covered' }]);
    expect(result.explanation).toContain('never independently produced');
  });

  it('explains a failed route with reasons', async () => {
    await writeRouteGraph(makeRouteGraph({ routes: buttonsSwitchRoutes() }), cacheDir);
    const context = await loadGraphToolContext(cacheDir);

    const result = explainRouteCoverage(context, '/components/switch/specs');
    expect(result.status).toBe('failed');
    expect(result.reasons).toEqual(['json-fetch-failed']);
    expect(result.explanation).toContain('failed');
  });

  it('returns not-found for unknown route', async () => {
    await writeRouteGraph(makeRouteGraph({ routes: buttonsSwitchRoutes() }), cacheDir);
    const context = await loadGraphToolContext(cacheDir);
    const result = explainRouteCoverage(context, '/components/unknown');
    expect(result.found).toBe(false);
  });
});

describe('get_page (get-page.ts)', () => {
  function makeStore(): MaterialDocsStore {
    return new MaterialDocsStore(cacheDir);
  }

  it('returns structured view from graph/pages.json', async () => {
    const pageGraph: PageGraph = {
      schemaVersion: 1,
      generatedAt: '2026-06-01T00:00:00.000Z',
      pages: [{
        pageId: 'switch-specs',
        route: '/components/switch/specs',
        title: 'Switch specs',
        section: 'components',
        tabs: [{ label: 'Specs', route: '/components/switch/specs', sectionIndex: 1 }],
        headings: ['Switch specs'],
        sections: [{ sectionId: 'section-0', title: 'Switch specs', headingLevel: 1, chunkIds: ['chunk-0-text'] }],
        chunks: [{ chunkId: 'chunk-0-text', chunkType: 'text', resourceId: null, textExcerpt: 'Switch specs' }],
        resourceIds: [],
        tokenTableIds: [],
        unsupportedChunkTypes: [],
        provenance: { sourceArtifacts: [], sourceRoute: '/components/switch/specs', canonicalRoute: '/components/switch/specs', virtualRoute: null },
      }],
    };
    await writePageGraph(pageGraph, cacheDir);

    const context = await loadGraphToolContext(cacheDir);
    const result = await getPage(context, makeStore(), { route: '/components/switch/specs', view: 'structured' });

    expect(result.found).toBe(true);
    expect(result.structured?.pageId).toBe('switch-specs');
    expect(result.structured?.sections).toHaveLength(1);
  });

  it('returns not-found for structured view when route is absent', async () => {
    await writePageGraph({ schemaVersion: 1, generatedAt: '2026-06-01T00:00:00.000Z', pages: [] }, cacheDir);
    const context = await loadGraphToolContext(cacheDir);
    const result = await getPage(context, makeStore(), { route: '/components/missing', view: 'structured' });
    expect(result.found).toBe(false);
    expect(result.message).toContain('not found');
  });

  it('reports unavailable for structured view when graph is missing entirely', async () => {
    const context = await loadGraphToolContext(cacheDir);
    const result = await getPage(context, makeStore(), { route: '/components/switch/specs', view: 'structured' });
    expect(result.available).toBe(false);
  });

  it('delegates markdown view to MaterialDocsStore.getPage', async () => {
    const index: MaterialIndex = {
      source: 'https://m3.material.io',
      capturedAt: '2026-06-01T00:00:00.000Z',
      pageCount: 1,
      attemptedPageCount: 1,
      failedPageCount: 0,
      failedUrls: [],
      pages: [{
        id: 'switch-specs',
        title: 'Switch specs',
        url: 'https://m3.material.io/components/switch/specs',
        path: 'components/switch/specs.md',
        section: 'components',
        headings: ['Switch specs'],
        capturedAt: '2026-06-01T00:00:00.000Z',
      }],
    };
    await writeIndex(index, cacheDir);
    const { writePage } = await import('../src/cache.js');
    await writePage({ ...index.pages[0]!, markdown: '# Switch specs\n\nBody text.', text: 'Switch specs Body text.' }, cacheDir);

    const context = await loadGraphToolContext(cacheDir);
    const result = await getPage(context, makeStore(), { route: 'components/switch/specs.md', view: 'markdown' });

    expect(result.found).toBe(true);
    expect(result.markdown?.markdown).toContain('Switch specs');
  });

  it('returns not-found for markdown view when page is missing', async () => {
    const context = await loadGraphToolContext(cacheDir);
    const result = await getPage(context, makeStore(), { route: 'components/missing.md', view: 'markdown' });
    expect(result.found).toBe(false);
  });

  it('returns raw-summary view with artifact metadata, not full content', async () => {
    const artifact = await persistArtifact({
      kind: 'page-data',
      pathParts: ['col-1', 'doc-1'],
      sourceUrl: 'https://m3.material.io/_dsm/page-data/col-1/doc-1',
      content: JSON.stringify({ huge: 'x'.repeat(5000) }),
      sourceRoute: '/components/switch/specs',
      sourceMethod: 'static-plan',
    }, cacheDir);
    await upsertArtifactRecord(artifact, cacheDir);

    const pageGraph: PageGraph = {
      schemaVersion: 1,
      generatedAt: '2026-06-01T00:00:00.000Z',
      pages: [{
        pageId: 'switch-specs',
        route: '/components/switch/specs',
        title: 'Switch specs',
        section: 'components',
        tabs: [],
        headings: [],
        sections: [],
        chunks: [],
        resourceIds: [],
        tokenTableIds: [],
        unsupportedChunkTypes: [],
        provenance: { sourceArtifacts: [{ artifactId: artifact.id, kind: 'page-data' }], sourceRoute: '/components/switch/specs', canonicalRoute: '/components/switch/specs', virtualRoute: null },
      }],
    };
    await writePageGraph(pageGraph, cacheDir);

    const context = await loadGraphToolContext(cacheDir);
    const result = await getPage(context, makeStore(), { route: '/components/switch/specs', view: 'raw-summary' });

    expect(result.found).toBe(true);
    expect(result.rawSummary?.artifacts).toEqual([{
      artifactId: artifact.id,
      kind: 'page-data',
      sourceUrl: artifact.sourceUrl,
      sha256: artifact.sha256,
      fetchedAt: artifact.fetchedAt,
      httpStatus: null,
    }]);
    expect(JSON.stringify(result)).not.toContain('"huge"');
  });
});

function makeTokenTableGraph(): TokenTableGraph {
  return {
    schemaVersion: 1,
    generatedAt: '2026-06-01T00:00:00.000Z',
    tokenTables: [{
      resourceId: 'dsdb-resource:switch-tokens',
      resourceName: 'switch-tokens',
      requestedTokenSets: ['md.comp.switch'],
      tokenSets: [{
        tokenSetName: 'md.comp.switch',
        displayName: 'Switch',
        tokens: [{
          tokenName: 'md.comp.switch.track.color',
          displayName: 'Track color',
          aliases: ['md.sys.color.surface-variant'],
          values: [{ role: 'light', value: '#E0E0E0', resolved: true }],
        }],
      }],
      routes: ['/components/switch/specs'],
      unresolvedTokenCount: 0,
    }],
  };
}

describe('get_component_tokens (get-component-tokens.ts)', () => {
  it('reports unavailable when token-tables.json is missing', async () => {
    const context = await loadGraphToolContext(cacheDir);
    const result = getComponentTokens(context, 'switch');
    expect(result.available).toBe(false);
  });

  it('returns matched token tables for a component', async () => {
    await writeTokenTableGraph(makeTokenTableGraph(), cacheDir);
    const context = await loadGraphToolContext(cacheDir);
    const result = getComponentTokens(context, 'switch');
    expect(result.found).toBe(true);
    expect(result.tokenTables).toHaveLength(1);
    expect(result.tokenTables[0]?.tokenSets[0]?.tokens[0]?.tokenName).toBe('md.comp.switch.track.color');
  });

  it('returns not-found (without throwing) for an unmatched component', async () => {
    await writeTokenTableGraph(makeTokenTableGraph(), cacheDir);
    const context = await loadGraphToolContext(cacheDir);
    const result = getComponentTokens(context, 'nonexistent-component');
    expect(result.found).toBe(false);
    expect(result.tokenTables).toEqual([]);
  });
});

describe('get_component_tabs (get-component-tabs.ts)', () => {
  it('returns tabs for a component route', async () => {
    await writeRouteGraph(makeRouteGraph({ routes: buttonsSwitchRoutes() }), cacheDir);
    const context = await loadGraphToolContext(cacheDir);
    const result = getComponentTabs(context, 'switch');
    expect(result.found).toBe(true);
    expect(result.routes).toEqual([{
      route: '/components/switch/specs',
      tabs: [{ label: 'Specs', route: '/components/switch/specs/specs', slug: 'specs', matchedSectionId: null, matchReason: 'unmatched' }],
    }]);
  });

  it('returns not-found when no tabbed routes match', async () => {
    await writeRouteGraph(makeRouteGraph({ routes: buttonsSwitchRoutes() }), cacheDir);
    const context = await loadGraphToolContext(cacheDir);
    const result = getComponentTabs(context, 'buttons');
    expect(result.found).toBe(false);
  });
});

describe('get_component_resources (get-component-resources.ts)', () => {
  it('returns resources for a component', async () => {
    const resourceGraph: ResourceGraph = {
      schemaVersion: 1,
      generatedAt: '2026-06-01T00:00:00.000Z',
      resources: [{
        resourceId: 'image:components/switch/specs.md:0',
        kind: 'image',
        resourceName: null,
        sourceArtifact: null,
        routes: ['/components/switch/specs'],
        pageIds: [],
        chunkIds: ['chunk-image-0'],
        status: 'resolved',
        unresolvedReason: null,
      }],
    };
    await writeResourceGraph(resourceGraph, cacheDir);
    const context = await loadGraphToolContext(cacheDir);
    const result = getComponentResources(context, 'switch');
    expect(result.found).toBe(true);
    expect(result.resources).toHaveLength(1);
  });
});

describe('explain_resource_resolution (explain-resource-resolution.ts)', () => {
  it('explains an unresolved resource', async () => {
    const resourceGraph: ResourceGraph = {
      schemaVersion: 1,
      generatedAt: '2026-06-01T00:00:00.000Z',
      resources: [{
        resourceId: 'token-table:components/switch/specs.md:placeholder:0',
        kind: 'token-table',
        resourceName: null,
        sourceArtifact: null,
        routes: ['/components/switch/specs'],
        pageIds: [],
        chunkIds: ['chunk-token-table-placeholder-0'],
        status: 'unresolved',
        unresolvedReason: 'missing-dsdb-resource',
      }],
    };
    await writeResourceGraph(resourceGraph, cacheDir);
    const context = await loadGraphToolContext(cacheDir);
    const result = explainResourceResolution(context, 'token-table:components/switch/specs.md:placeholder:0');
    expect(result.found).toBe(true);
    expect(result.status).toBe('unresolved');
    expect(result.explanation).toContain('missing-dsdb-resource');
  });

  it('returns not-found for unknown resource id', async () => {
    await writeResourceGraph({ schemaVersion: 1, generatedAt: '2026-06-01T00:00:00.000Z', resources: [] }, cacheDir);
    const context = await loadGraphToolContext(cacheDir);
    const result = explainResourceResolution(context, 'does-not-exist');
    expect(result.found).toBe(false);
  });
});

describe('get_route_artifacts (get-route-artifacts.ts)', () => {
  it('returns compact artifact metadata for a route', async () => {
    const artifact = await persistArtifact({
      kind: 'page-data',
      pathParts: ['col-1', 'doc-1'],
      sourceUrl: 'https://m3.material.io/_dsm/page-data/col-1/doc-1',
      content: '{"ok":true}',
      sourceRoute: '/components/buttons/overview',
      sourceMethod: 'static-plan',
    }, cacheDir);
    await upsertArtifactRecord(artifact, cacheDir);

    const routeGraph = makeRouteGraph({ routes: buttonsSwitchRoutes() });
    await writeRouteGraph(routeGraph, cacheDir);

    const context = await loadGraphToolContext(cacheDir);
    const result = getRouteArtifacts(context, '/components/buttons/overview');

    expect(result.found).toBe(true);
    expect(result.artifacts).toEqual([{
      artifactId: artifact.id,
      kind: 'page-data',
      sourceUrl: artifact.sourceUrl,
      sha256: artifact.sha256,
      fetchedAt: artifact.fetchedAt,
      httpStatus: null,
    }]);
  });

  it('returns not-found for unknown route', async () => {
    await writeRouteGraph(makeRouteGraph({ routes: buttonsSwitchRoutes() }), cacheDir);
    const context = await loadGraphToolContext(cacheDir);
    const result = getRouteArtifacts(context, '/components/unknown');
    expect(result.found).toBe(false);
  });
});

describe('get_raw_artifact (get-raw-artifact.ts)', () => {
  it('does not return full content by default, even for a small artifact', async () => {
    const content = 'x'.repeat(DEFAULT_PREVIEW_CHARS + 500);
    const artifact = await persistArtifact({
      kind: 'page-data',
      pathParts: ['col-1', 'doc-1'],
      sourceUrl: 'https://m3.material.io/_dsm/page-data/col-1/doc-1',
      content,
      sourceMethod: 'static-plan',
    }, cacheDir);
    await upsertArtifactRecord(artifact, cacheDir);

    const context = await loadGraphToolContext(cacheDir);
    const result = await getRawArtifact(context, { artifactId: artifact.id });

    expect(result.found).toBe(true);
    expect(result.truncated).toBe(true);
    expect(result.content?.length).toBe(DEFAULT_PREVIEW_CHARS);
    expect(result.artifact?.byteSize).toBe(content.length);
  });

  it('returns full content when fullContent:true and the artifact is below the size cap', async () => {
    const content = JSON.stringify({ small: true });
    const artifact = await persistArtifact({
      kind: 'page-data',
      pathParts: ['col-1', 'doc-2'],
      sourceUrl: 'https://m3.material.io/_dsm/page-data/col-1/doc-2',
      content,
      sourceMethod: 'static-plan',
    }, cacheDir);
    await upsertArtifactRecord(artifact, cacheDir);

    const context = await loadGraphToolContext(cacheDir);
    const result = await getRawArtifact(context, { artifactId: artifact.id, fullContent: true });

    expect(result.truncated).toBe(false);
    expect(result.content).toBe(content);
  });

  it('refuses full content even with fullContent:true when the artifact exceeds the size cap', async () => {
    const content: ArtifactRecord = await persistArtifact({
      kind: 'page-data',
      pathParts: ['col-1', 'doc-3'],
      sourceUrl: 'https://m3.material.io/_dsm/page-data/col-1/doc-3',
      content: 'y'.repeat(FULL_CONTENT_MAX_BYTES + 1),
      sourceMethod: 'static-plan',
    }, cacheDir);
    await upsertArtifactRecord(content, cacheDir);

    const context = await loadGraphToolContext(cacheDir);
    const result = await getRawArtifact(context, { artifactId: content.id, fullContent: true });

    expect(result.truncated).toBe(true);
    expect(result.content?.length).toBeLessThanOrEqual(DEFAULT_PREVIEW_CHARS);
    expect(result.message).toContain('exceeds');
  });

  it('returns not-found for an unknown artifact id', async () => {
    const context = await loadGraphToolContext(cacheDir);
    const result = await getRawArtifact(context, { artifactId: 'page-data:does/not/exist.json' });
    expect(result.found).toBe(false);
  });
});

describe('loadGraphToolContext / provenance round-trip', () => {
  it('re-validates persisted provenance graph through its zod schema on read', async () => {
    const provenanceGraph: ProvenanceGraph = {
      schemaVersion: 1,
      generatedAt: '2026-06-01T00:00:00.000Z',
      entries: [{ subject: 'route:/components/buttons/overview', sourceArtifacts: [{ artifactId: 'page-data:raw/page-data/col-1/doc-1.json', kind: 'page-data' }] }],
    };
    await writeProvenanceGraph(provenanceGraph, cacheDir);
    const context = await loadGraphToolContext(cacheDir);
    expect(context.provenanceGraph).toEqual(provenanceGraph);
  });
});
