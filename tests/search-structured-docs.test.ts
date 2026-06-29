import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { writePageGraph, writeResourceGraph, writeRouteGraph, writeTokenTableGraph } from '../src/graph/graph-store.js';
import type { PageGraph, ResourceGraph, RouteGraph, TokenTableGraph } from '../src/graph/graph-types.js';
import { loadGraphToolContext } from '../src/mcp-tools/context.js';
import { searchStructuredDocs } from '../src/mcp-tools/search-structured-docs.js';

let cacheDir: string;

beforeEach(async () => {
  cacheDir = await mkdtemp(path.join(tmpdir(), 'm3-docs-mcp-search-structured-'));
});

afterEach(async () => {
  await rm(cacheDir, { recursive: true, force: true });
});

const routeGraph: RouteGraph = {
  schemaVersion: 1,
  generatedAt: '2026-06-01T00:00:00.000Z',
  baseUrl: 'https://m3.material.io',
  routes: [
    {
      route: '/components/switch/specs',
      canonicalRoute: '/components/switch/specs',
      aliases: [],
      title: 'Switch specs',
      section: 'components',
      reference: { collectionId: null, documentId: null, exportedCarbonFileId: null, pageCanonId: null, carbonVersion: null },
      tabs: [],
      origins: ['site_meta'],
      sourceArtifacts: [],
      expectedOutputPaths: [],
      generatedOutputPaths: [],
      coverage: { status: 'covered', reasons: [], originalStatus: 'covered', sharedCoverageGroup: null, sharedWithRoutes: [], expectedOutputPaths: [], savedOutputPaths: [], failedOutputPaths: [], skippedOutputPaths: [] },
    },
    {
      route: '/components/segmented-buttons/overview',
      canonicalRoute: '/components/segmented-buttons/overview',
      aliases: [],
      title: 'Segmented buttons',
      section: 'components',
      reference: { collectionId: null, documentId: null, exportedCarbonFileId: null, pageCanonId: null, carbonVersion: null },
      tabs: [],
      origins: ['site_meta'],
      sourceArtifacts: [],
      expectedOutputPaths: [],
      generatedOutputPaths: [],
      coverage: { status: 'covered', reasons: [], originalStatus: 'covered', sharedCoverageGroup: null, sharedWithRoutes: [], expectedOutputPaths: [], savedOutputPaths: [], failedOutputPaths: [], skippedOutputPaths: [] },
    },
  ],
};

const pageGraph: PageGraph = {
  schemaVersion: 1,
  generatedAt: '2026-06-01T00:00:00.000Z',
  pages: [{
    pageId: 'segmented-buttons-overview',
    route: '/components/segmented-buttons/overview',
    title: 'Segmented buttons',
    section: 'components',
    tabs: [],
    headings: ['Segmented buttons', 'Outline'],
    sections: [{ sectionId: 'section-1', title: 'Outline', headingLevel: 2, chunkIds: ['chunk-1-text'] }],
    chunks: [{ chunkId: 'chunk-1-text', chunkType: 'text', resourceId: null, textExcerpt: 'The outline of a segmented button uses the outline-variant color role.' }],
    resourceIds: [],
    tokenTableIds: [],
    unsupportedChunkTypes: [],
    provenance: { sourceArtifacts: [], sourceRoute: '/components/segmented-buttons/overview', canonicalRoute: '/components/segmented-buttons/overview', virtualRoute: null },
  }],
};

const resourceGraph: ResourceGraph = {
  schemaVersion: 1,
  generatedAt: '2026-06-01T00:00:00.000Z',
  resources: [{
    resourceId: 'token-table:md.comp.switch',
    kind: 'token-table',
    resourceName: 'md.comp.switch',
    sourceArtifact: null,
    routes: ['/components/switch/specs'],
    pageIds: [],
    chunkIds: [],
    status: 'resolved',
    unresolvedReason: null,
  }],
};

const tokenTableGraph: TokenTableGraph = {
  schemaVersion: 1,
  generatedAt: '2026-06-01T00:00:00.000Z',
  tokenTables: [{
    resourceId: 'token-table:md.comp.switch',
    resourceName: 'md.comp.switch',
    requestedTokenSets: ['Selected'],
    tokenSets: [{
      tokenSetName: 'Selected',
      displayName: 'Selected',
      tokens: [{
        tokenName: 'md.comp.switch.selected.track.color',
        displayName: 'Selected track color',
        aliases: ['md.sys.color.primary'],
        values: [{ role: 'light', value: '#6750A4', resolved: true }],
      }],
    }],
    routes: ['/components/switch/specs'],
    unresolvedTokenCount: 0,
  }],
};

async function writeFixtures(): Promise<void> {
  await writeRouteGraph(routeGraph, cacheDir);
  await writePageGraph(pageGraph, cacheDir);
  await writeResourceGraph(resourceGraph, cacheDir);
  await writeTokenTableGraph(tokenTableGraph, cacheDir);
}

describe('search_structured_docs (search-structured-docs.ts)', () => {
  it('finds switch token tables by token name words ("switch selected track color")', async () => {
    await writeFixtures();
    const context = await loadGraphToolContext(cacheDir);
    const result = searchStructuredDocs(context, 'switch selected track color');
    expect(result.available).toBe(true);
    expect(result.results.some((r) => r.kind === 'token' && r.route === '/components/switch/specs')).toBe(true);
  });

  it('finds the Switch token table by resource name ("md.comp.switch")', async () => {
    await writeFixtures();
    const context = await loadGraphToolContext(cacheDir);
    const result = searchStructuredDocs(context, 'md.comp.switch');
    expect(result.results.some((r) => r.kind === 'resource' && r.resourceId === 'token-table:md.comp.switch')).toBe(true);
    expect(result.results.some((r) => r.kind === 'token' && r.tokenSetName === 'Selected')).toBe(true);
  });

  it('finds segmented button docs/sections ("segmented button outline")', async () => {
    await writeFixtures();
    const context = await loadGraphToolContext(cacheDir);
    const result = searchStructuredDocs(context, 'segmented button outline');
    expect(result.results.some((r) => r.kind === 'section' && r.route === '/components/segmented-buttons/overview' && r.title === 'Outline')).toBe(true);
  });

  it('finds the owning token table and route by a token alias', async () => {
    await writeFixtures();
    const context = await loadGraphToolContext(cacheDir);
    const result = searchStructuredDocs(context, 'md.sys.color.primary');
    expect(result.results.some((r) => r.kind === 'token' && r.tokenName === 'md.comp.switch.selected.track.color' && r.route === '/components/switch/specs')).toBe(true);
  });

  it('reports unavailable when no graph exists yet', async () => {
    const context = await loadGraphToolContext(cacheDir);
    const result = searchStructuredDocs(context, 'switch');
    expect(result.available).toBe(false);
    expect(result.results).toEqual([]);
  });
});
