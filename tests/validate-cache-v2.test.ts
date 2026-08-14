import { mkdtemp, rm, unlink } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { manifestPath, readManifest, writeManifest } from '../src/manifest.js';
import { resourceGraphPath, writePageGraph, writeResourceGraph, writeTokenTableGraph } from '../src/graph/graph-store.js';
import { writeArtifactIndex } from '../src/raw-artifacts/artifact-index.js';
import { REQUIRED_PAGE_PATHS } from '../src/validation/validate-rendered-output.js';
import { REQUIRED_CACHE_VALIDATION_ROUTES, validateCacheV2 } from '../src/validation/validate-cache-v2.js';
import { writeValidCacheV2Fixture } from './fixtures/cache-v2-fixture.js';

let cacheDir: string;

beforeEach(async () => {
  cacheDir = await mkdtemp(path.join(tmpdir(), 'm3-docs-mcp-validate-cache-v2-'));
});

afterEach(async () => {
  await rm(cacheDir, { recursive: true, force: true });
});

const REBUILT_REQUIRED_PAGES = REQUIRED_PAGE_PATHS.map((pagePath) => ({
  id: pagePath,
  title: pagePath,
  url: `https://m3.material.io/${pagePath.replace(/^pages\//, '').replace(/\.md$/, '')}`,
  path: pagePath.replace(/^pages\//, ''),
  section: 'components',
  headings: ['OK'],
  text: 'OK',
  markdown: '# OK',
  capturedAt: '2026-06-01T00:00:00.000Z',
}));

async function stubRebuild() {
  return {
    pages: REBUILT_REQUIRED_PAGES,
    report: { schemaVersion: 1 as const, generatedAt: '2026-06-01T00:00:00.000Z', routes: [], requiredRouteFailures: [] },
  };
}

describe('validateCacheV2', () => {
  it('passes for a fully valid cache v2 fixture', async () => {
    await writeValidCacheV2Fixture(cacheDir);
    const result = await validateCacheV2({ cacheDir, renderedOutputRebuildFn: stubRebuild });
    expect(result.allPassed).toBe(true);
    expect(result.failedStages).toEqual([]);
    expect(result.counts.routes).toBe(REQUIRED_CACHE_VALIDATION_ROUTES.length);
    expect(result.counts.pages).toBe(REQUIRED_CACHE_VALIDATION_ROUTES.length);
    expect(result.counts.resources).toBe(REQUIRED_CACHE_VALIDATION_ROUTES.length);
    expect(result.counts.tokenTables).toBe(REQUIRED_CACHE_VALIDATION_ROUTES.length);
    expect(result.health).toEqual({ rawSnapshot: 'verified', graph: 'verified', markdown: 'verified', coverage: 'verified' });
  });

  it('passes when the artifact index is the current top-level array format', async () => {
    await writeValidCacheV2Fixture(cacheDir, { artifactIndexAsBareArray: true });
    const result = await validateCacheV2({ cacheDir, renderedOutputRebuildFn: stubRebuild });
    expect(result.allPassed).toBe(true);
  });

  it('fails when manifest.json is missing', async () => {
    await writeValidCacheV2Fixture(cacheDir);
    await unlink(manifestPath(cacheDir));
    const result = await validateCacheV2({ cacheDir, renderedOutputRebuildFn: stubRebuild });
    expect(result.allPassed).toBe(false);
    expect(result.failedStages).toContain('manifest-health');
    expect(result.failedStages).toContain('cache-files');
  });

  it('fails when manifest counts disagree with the persisted snapshot', async () => {
    await writeValidCacheV2Fixture(cacheDir);
    const manifest = await readManifest(cacheDir);
    if (!manifest) throw new Error('Fixture manifest is missing.');
    await writeManifest({
      ...manifest,
      counts: {
        ...manifest.counts,
        routes: manifest.counts.routes + 1,
      },
    }, cacheDir);

    const result = await validateCacheV2({ cacheDir, renderedOutputRebuildFn: stubRebuild });
    expect(result.allPassed).toBe(false);
    expect(result.failedStages).toContain('manifest-consistency');
    const consistencyResult = result.results.find((entry) => entry.stage === 'manifest-consistency');
    expect(consistencyResult?.reasons.some((reason) => reason.includes('manifest.counts.routes='))).toBe(true);
  });

  it('fails when a graph file is missing', async () => {
    await writeValidCacheV2Fixture(cacheDir);
    await unlink(resourceGraphPath(cacheDir));
    const result = await validateCacheV2({ cacheDir, renderedOutputRebuildFn: stubRebuild });
    expect(result.allPassed).toBe(false);
    expect(result.failedStages).toContain('graph-files');
    expect(result.failedStages).toContain('cache-files');
  });

  it('fails when the raw artifact index is empty', async () => {
    await writeValidCacheV2Fixture(cacheDir);
    await writeArtifactIndex({ artifacts: [] }, cacheDir);
    const result = await validateCacheV2({ cacheDir, renderedOutputRebuildFn: stubRebuild });
    expect(result.allPassed).toBe(false);
    expect(result.failedStages).toContain('artifact-index');
  });

  it('fails when a required resource is unresolved', async () => {
    await writeValidCacheV2Fixture(cacheDir);
    await writeResourceGraph({
      schemaVersion: 1,
      generatedAt: '2026-06-01T00:00:00.000Z',
      resources: [{
        resourceId: 'token-table:components/switch',
        kind: 'token-table',
        resourceName: 'md.comp.switch',
        sourceArtifact: null,
        routes: ['/components/switch/specs'],
        pageIds: ['components/switch-specs'],
        chunkIds: ['components/switch-chunk-1'],
        status: 'unresolved',
        unresolvedReason: 'missing-requested-token-sets',
      }],
    }, cacheDir);
    const result = await validateCacheV2({ cacheDir, renderedOutputRebuildFn: stubRebuild });
    expect(result.allPassed).toBe(false);
    expect(result.failedStages).toContain('structured-graph');
  });

  it('fails when a required route is missing from graph/routes.json', async () => {
    await writeValidCacheV2Fixture(cacheDir);
    const result = await validateCacheV2({
      cacheDir,
      requiredRoutes: [...REQUIRED_CACHE_VALIDATION_ROUTES, '/components/missing-component/specs'],
      renderedOutputRebuildFn: stubRebuild,
    });
    expect(result.allPassed).toBe(false);
    expect(result.failedStages).toContain('route-graph');
    const routeGraphResult = result.results.find((r) => r.stage === 'route-graph');
    expect(routeGraphResult?.reasons.some((r) => r.includes('/components/missing-component/specs'))).toBe(true);
  });

  it('fails when a required token table is missing from graph/token-tables.json', async () => {
    await writeValidCacheV2Fixture(cacheDir);
    await writeTokenTableGraph({ schemaVersion: 1, generatedAt: '2026-06-01T00:00:00.000Z', tokenTables: [] }, cacheDir);
    const result = await validateCacheV2({ cacheDir, renderedOutputRebuildFn: stubRebuild });
    expect(result.allPassed).toBe(false);
    expect(result.failedStages).toContain('structured-graph');
    const structuredResult = result.results.find((r) => r.stage === 'structured-graph');
    expect(structuredResult?.reasons.some((r) => r.includes('missing token table'))).toBe(true);
  });

  it('fails mcp-smoke when a required page has no sections/chunks/resources', async () => {
    await writeValidCacheV2Fixture(cacheDir);
    await writePageGraph({
      schemaVersion: 1,
      generatedAt: '2026-06-01T00:00:00.000Z',
      pages: REQUIRED_CACHE_VALIDATION_ROUTES.map((route) => ({
        pageId: `${route}-page`,
        route,
        title: route,
        section: 'components',
        tabs: [],
        headings: [],
        sections: [],
        chunks: [],
        resourceIds: [],
        tokenTableIds: [],
        unsupportedChunkTypes: [],
        provenance: { sourceArtifacts: [], sourceRoute: route, canonicalRoute: route, virtualRoute: null },
      })),
    }, cacheDir);
    const result = await validateCacheV2({ cacheDir, renderedOutputRebuildFn: stubRebuild });
    expect(result.allPassed).toBe(false);
    expect(result.failedStages).toContain('mcp-smoke');
    expect(result.failedStages).toContain('structured-graph');
  });
});
