import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { writePageGraph, writeResourceGraph, writeTokenTableGraph } from '../src/graph/graph-store.js';
import type { PageGraph, ResourceGraph, TokenTableGraph } from '../src/graph/graph-types.js';
import { validateStructuredGraph } from '../src/validation/validate-structured-graph.js';

let cacheDir: string;

beforeEach(async () => {
  cacheDir = await mkdtemp(path.join(tmpdir(), 'm3-docs-mcp-validate-structured-'));
});

afterEach(async () => {
  await rm(cacheDir, { recursive: true, force: true });
});

const REQUIRED_ROUTES = ['/components/switch/overview'];

function makeResourceGraph(overrides: Partial<ResourceGraph> = {}): ResourceGraph {
  return { schemaVersion: 1, generatedAt: '2026-06-01T00:00:00.000Z', resources: [], ...overrides };
}

function makeTokenTableGraph(overrides: Partial<TokenTableGraph> = {}): TokenTableGraph {
  return { schemaVersion: 1, generatedAt: '2026-06-01T00:00:00.000Z', tokenTables: [], ...overrides };
}

function makePageGraph(overrides: Partial<PageGraph> = {}): PageGraph {
  return { schemaVersion: 1, generatedAt: '2026-06-01T00:00:00.000Z', pages: [], ...overrides };
}

describe('validateStructuredGraph', () => {
  it('fails when graph/resources.json is missing', async () => {
    await writeTokenTableGraph(makeTokenTableGraph(), cacheDir);
    const result = await validateStructuredGraph({ cacheDir, requiredRoutes: REQUIRED_ROUTES });
    expect(result.passed).toBe(false);
    expect(result.reasons[0]).toMatch(/graph\/resources\.json is missing/);
  });

  it('fails when graph/token-tables.json is missing', async () => {
    await writeResourceGraph(makeResourceGraph(), cacheDir);
    const result = await validateStructuredGraph({ cacheDir, requiredRoutes: REQUIRED_ROUTES });
    expect(result.passed).toBe(false);
    expect(result.reasons[0]).toMatch(/graph\/token-tables\.json is missing/);
  });

  it('passes when nothing is unresolved/unsupported on required routes', async () => {
    await writeResourceGraph(makeResourceGraph(), cacheDir);
    await writeTokenTableGraph(makeTokenTableGraph(), cacheDir);
    const result = await validateStructuredGraph({ cacheDir, requiredRoutes: REQUIRED_ROUTES });
    expect(result.passed).toBe(true);
    expect(result.reasons).toEqual([]);
  });

  it('fails when an unresolved DSDB resource is routed to a required page', async () => {
    await writeResourceGraph(makeResourceGraph({
      resources: [{
        resourceId: 'token-table:md.comp.switch',
        kind: 'token-table',
        resourceName: 'md.comp.switch',
        sourceArtifact: null,
        routes: ['/components/switch/overview'],
        pageIds: [],
        chunkIds: ['chunk-token-table-0'],
        status: 'unresolved',
        unresolvedReason: 'missing-requested-token-sets',
      }],
    }), cacheDir);
    await writeTokenTableGraph(makeTokenTableGraph(), cacheDir);
    const result = await validateStructuredGraph({ cacheDir, requiredRoutes: REQUIRED_ROUTES });
    expect(result.passed).toBe(false);
    expect(result.reasons.some((r) => r.includes('Unresolved token-table resource'))).toBe(true);
  });

  it('does not fail for an unresolved resource routed only to a non-required page', async () => {
    await writeResourceGraph(makeResourceGraph({
      resources: [{
        resourceId: 'token-table:md.comp.unrelated',
        kind: 'token-table',
        resourceName: 'md.comp.unrelated',
        sourceArtifact: null,
        routes: ['/foundations/experimental'],
        pageIds: [],
        chunkIds: ['chunk-token-table-0'],
        status: 'unresolved',
        unresolvedReason: 'missing-requested-token-sets',
      }],
    }), cacheDir);
    await writeTokenTableGraph(makeTokenTableGraph(), cacheDir);
    const result = await validateStructuredGraph({ cacheDir, requiredRoutes: REQUIRED_ROUTES });
    expect(result.passed).toBe(true);
  });

  it('does not fail only because a token table reports unresolved token variants on a required route', async () => {
    await writeResourceGraph(makeResourceGraph(), cacheDir);
    await writeTokenTableGraph(makeTokenTableGraph({
      tokenTables: [{
        resourceId: 'token-table:md.comp.switch',
        resourceName: 'md.comp.switch',
        requestedTokenSets: ['md.comp.switch.selected'],
        tokenSets: [],
        routes: ['/components/switch/overview'],
        unresolvedTokenCount: 3,
      }],
    }), cacheDir);
    const result = await validateStructuredGraph({ cacheDir, requiredRoutes: REQUIRED_ROUTES });
    expect(result.passed).toBe(true);
    expect(result.reasons).toEqual([]);
  });

  // Regression: m3-docs-cache production failures — status-table resources for
  // /components/lists/overview, /components/switch/overview, and /components/buttons/overview
  // (designSystems/030656e0a1083ef1/components/<id>) were reported unresolved
  // ("missing-status-table-resource") because the live DSDB fetch was silently skipped for these
  // chunks. Strict validation must keep failing whenever a required status-table resource is
  // unresolved, and must pass once it resolves.
  it('fails when a required status-table resource is unresolved (designSystems/030656e0a1083ef1)', async () => {
    await writeResourceGraph(makeResourceGraph({
      resources: [{
        resourceId: 'status-table:designSystems/030656e0a1083ef1/components/0fe2e78f2f029241',
        kind: 'status-table',
        resourceName: 'designSystems/030656e0a1083ef1/components/0fe2e78f2f029241',
        sourceArtifact: null,
        routes: ['/components/switch/overview'],
        pageIds: [],
        chunkIds: ['chunk-status-table-0'],
        status: 'unresolved',
        unresolvedReason: 'missing-status-table-resource',
      }],
    }), cacheDir);
    await writeTokenTableGraph(makeTokenTableGraph(), cacheDir);
    const result = await validateStructuredGraph({ cacheDir, requiredRoutes: REQUIRED_ROUTES });
    expect(result.passed).toBe(false);
    expect(result.reasons.some((r) => r.includes('Unresolved status-table resource') && r.includes('designSystems/030656e0a1083ef1/components/0fe2e78f2f029241'))).toBe(true);
  });

  it('passes once the required status-table resource resolves to a DSDB artifact', async () => {
    await writeResourceGraph(makeResourceGraph({
      resources: [{
        resourceId: 'status-table:designSystems/030656e0a1083ef1/components/0fe2e78f2f029241',
        kind: 'status-table',
        resourceName: 'designSystems/030656e0a1083ef1/components/0fe2e78f2f029241',
        sourceArtifact: { artifactId: 'dsdb-resource:raw/dsdb/cv-1/designSystems_030656e0a1083ef1_components_0fe2e78f2f029241.json', kind: 'dsdb-resource' },
        routes: ['/components/switch/overview'],
        pageIds: [],
        chunkIds: ['chunk-status-table-0'],
        status: 'resolved',
        unresolvedReason: null,
      }],
    }), cacheDir);
    await writeTokenTableGraph(makeTokenTableGraph(), cacheDir);
    const result = await validateStructuredGraph({ cacheDir, requiredRoutes: REQUIRED_ROUTES });
    expect(result.passed).toBe(true);
    expect(result.reasons).toEqual([]);
  });

  it('passes for all three production-required status-table routes (lists, switch, buttons) once resolved', async () => {
    const requiredRoutes = ['/components/lists/overview', '/components/switch/overview', '/components/buttons/overview'];
    await writeResourceGraph(makeResourceGraph({
      resources: [
        {
          resourceId: 'status-table:designSystems/030656e0a1083ef1/components/11cb6b2ed0f6dee4',
          kind: 'status-table',
          resourceName: 'designSystems/030656e0a1083ef1/components/11cb6b2ed0f6dee4',
          sourceArtifact: { artifactId: 'dsdb-resource:raw/dsdb/cv-1/designSystems_030656e0a1083ef1_components_11cb6b2ed0f6dee4.json', kind: 'dsdb-resource' },
          routes: ['/components/lists/overview'],
          pageIds: [],
          chunkIds: ['chunk-status-table-0'],
          status: 'resolved',
          unresolvedReason: null,
        },
        {
          resourceId: 'status-table:designSystems/030656e0a1083ef1/components/0fe2e78f2f029241',
          kind: 'status-table',
          resourceName: 'designSystems/030656e0a1083ef1/components/0fe2e78f2f029241',
          sourceArtifact: { artifactId: 'dsdb-resource:raw/dsdb/cv-1/designSystems_030656e0a1083ef1_components_0fe2e78f2f029241.json', kind: 'dsdb-resource' },
          routes: ['/components/switch/overview'],
          pageIds: [],
          chunkIds: ['chunk-status-table-0'],
          status: 'resolved',
          unresolvedReason: null,
        },
        {
          resourceId: 'status-table:designSystems/030656e0a1083ef1/components/4c66f2c4b2f2cb18',
          kind: 'status-table',
          resourceName: 'designSystems/030656e0a1083ef1/components/4c66f2c4b2f2cb18',
          sourceArtifact: { artifactId: 'dsdb-resource:raw/dsdb/cv-1/designSystems_030656e0a1083ef1_components_4c66f2c4b2f2cb18.json', kind: 'dsdb-resource' },
          routes: ['/components/buttons/overview'],
          pageIds: [],
          chunkIds: ['chunk-status-table-0'],
          status: 'resolved',
          unresolvedReason: null,
        },
      ],
    }), cacheDir);
    await writeTokenTableGraph(makeTokenTableGraph(), cacheDir);
    const result = await validateStructuredGraph({ cacheDir, requiredRoutes });
    expect(result.passed).toBe(true);
    expect(result.reasons).toEqual([]);
  });

  it('fails when a required page has an unknown chunk/resource type', async () => {
    await writeResourceGraph(makeResourceGraph(), cacheDir);
    await writeTokenTableGraph(makeTokenTableGraph(), cacheDir);
    await writePageGraph(makePageGraph({
      pages: [{
        pageId: 'switch-overview',
        route: '/components/switch/overview',
        title: 'Switch',
        section: 'components',
        tabs: [],
        headings: ['Switch'],
        sections: [],
        chunks: [],
        resourceIds: [],
        tokenTableIds: [],
        unsupportedChunkTypes: ['EXPERIMENTAL_GRID'],
        provenance: { sourceArtifacts: [], sourceRoute: '/components/switch/overview', canonicalRoute: '/components/switch/overview', virtualRoute: null },
      }],
    }), cacheDir);
    const result = await validateStructuredGraph({ cacheDir, requiredRoutes: REQUIRED_ROUTES });
    expect(result.passed).toBe(false);
    expect(result.reasons.some((r) => r.includes('unknown chunk/resource type'))).toBe(true);
  });
});
