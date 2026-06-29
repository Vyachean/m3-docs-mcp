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

  it('fails when a token table has unresolved tokens on a required route', async () => {
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
    expect(result.passed).toBe(false);
    expect(result.reasons.some((r) => r.includes('unresolved token'))).toBe(true);
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
