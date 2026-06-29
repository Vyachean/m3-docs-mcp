import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { indexPath } from '../src/cache.js';
import { upsertArtifactRecord } from '../src/raw-artifacts/artifact-index.js';
import { persistArtifact } from '../src/raw-artifacts/artifact-store.js';
import { createCacheManifest, writeManifest } from '../src/manifest.js';
import { writeRouteGraph, writeResourceGraph, writeTokenTableGraph, writePageGraph } from '../src/graph/graph-store.js';
import type { RouteGraph, RouteNode } from '../src/graph/graph-types.js';
import { writeRendererReport } from '../src/rendered/renderer-report.js';
import { runFullVerification } from '../src/validation/run-full-verification.js';
import { REQUIRED_PAGE_PATHS } from '../src/validation/validate-rendered-output.js';

let cacheDir: string;

beforeEach(async () => {
  cacheDir = await mkdtemp(path.join(tmpdir(), 'm3-docs-mcp-run-full-verification-'));
});

afterEach(async () => {
  await rm(cacheDir, { recursive: true, force: true });
});

/** A browser-oracle capture with zero routes — trivially passes `compareCaptureToSnapshot`
 *  (nothing to compare) without launching a real browser. Used by tests that want stage 3 to pass
 *  so they can exercise later stages, without depending on the explicit-skip behavior (which now
 *  fails in full mode — see the dedicated test for that). */
const EMPTY_BROWSER_ORACLE_CAPTURE_FN = async () => ({
  schemaVersion: 1 as const,
  generatedAt: '2026-06-01T00:00:00.000Z',
  baseUrl: 'https://m3.material.io',
  routes: [],
});

const REQUIRED_ROUTES = [
  '/components/switch/overview',
  '/components/switch/specs',
  '/components/buttons/overview',
  '/components/buttons/specs',
  '/components/lists/overview',
  '/components/lists/specs',
  '/styles/color/roles',
  '/foundations/design-tokens/overview',
];

function makeRouteNode(route: string): RouteNode {
  const outputPath = `${route.replace(/^\//, '')}.md`;
  return {
    route,
    canonicalRoute: route,
    aliases: [],
    title: route,
    section: route.split('/')[1] ?? null,
    reference: { collectionId: 'c1', documentId: 'd1', exportedCarbonFileId: 'e1', pageCanonId: 'p1', carbonVersion: null },
    tabs: [],
    origins: ['site_meta'],
    sourceArtifacts: [{ artifactId: 'page-data:raw/page-data/c1/d1.json', kind: 'page-data' }],
    expectedOutputPaths: [outputPath],
    generatedOutputPaths: [outputPath],
    coverage: {
      status: 'covered',
      reasons: [],
      originalStatus: 'covered',
      sharedCoverageGroup: null,
      sharedWithRoutes: [],
      expectedOutputPaths: [outputPath],
      savedOutputPaths: [outputPath],
      failedOutputPaths: [],
      skippedOutputPaths: [],
    },
  };
}

async function writePassingFixtures(): Promise<void> {
  const shell = await persistArtifact({ kind: 'site-shell', pathParts: ['shell.html'], sourceUrl: 'https://m3.material.io/', content: '<html></html>', sourceMethod: 'static-plan' }, cacheDir);
  await upsertArtifactRecord(shell, cacheDir);
  const siteMeta = await persistArtifact({ kind: 'site-meta', pathParts: ['site_meta.js'], sourceUrl: 'https://m3.material.io/site_meta.js', content: 'window.site_meta = {};', sourceMethod: 'static-plan' }, cacheDir);
  await upsertArtifactRecord(siteMeta, cacheDir);
  const bundle = await persistArtifact({ kind: 'angular-bundle', pathParts: ['main.abc.js'], sourceUrl: 'https://m3.material.io/main.abc.js', content: 'carbonVersion', sourceMethod: 'static-plan' }, cacheDir);
  await upsertArtifactRecord(bundle, cacheDir);

  await writeManifest(createCacheManifest({
    baseUrl: 'https://m3.material.io',
    carbonVersion: 'v1',
    siteMetaHash: siteMeta.sha256,
    angularBundleHash: bundle.sha256,
  }), cacheDir);

  const routeGraph: RouteGraph = {
    schemaVersion: 1,
    generatedAt: '2026-06-01T00:00:00.000Z',
    baseUrl: 'https://m3.material.io',
    routes: REQUIRED_ROUTES.map(makeRouteNode),
  };
  await writeRouteGraph(routeGraph, cacheDir);

  await writeResourceGraph({ schemaVersion: 1, generatedAt: '2026-06-01T00:00:00.000Z', resources: [] }, cacheDir);
  await writeTokenTableGraph({ schemaVersion: 1, generatedAt: '2026-06-01T00:00:00.000Z', tokenTables: [] }, cacheDir);
  await writePageGraph({ schemaVersion: 1, generatedAt: '2026-06-01T00:00:00.000Z', pages: [] }, cacheDir);

  await writeRendererReport({ schemaVersion: 1, generatedAt: '2026-06-01T00:00:00.000Z', routes: [], requiredRouteFailures: [] }, cacheDir);

  for (const relativePath of REQUIRED_PAGE_PATHS) {
    const absolutePath = path.join(cacheDir, relativePath);
    await mkdir(path.dirname(absolutePath), { recursive: true });
    await writeFile(absolutePath, '# OK', 'utf8');
  }

  await writeFile(indexPath(cacheDir), JSON.stringify({
    pages: [],
    coverageDiagnostics: {
      coverageHealth: 'verified',
      routeCoverageSummary: { failedRoutes: 0, unresolvedRoutes: 0, partialRoutes: 0, problematicExamples: [] },
      routeCoverage: [],
    },
  }), 'utf8');
}

describe('runFullVerification', () => {
  it('runs all stages in order and passes when every stage is healthy', async () => {
    await writePassingFixtures();
    const verification = await runFullVerification({
      cacheDir,
      mode: 'full',
      browserOracleCaptureFn: EMPTY_BROWSER_ORACLE_CAPTURE_FN,
      // The real MaterialDocsStore-backed search path is exercised in validate-search-index.test.ts;
      // here we inject a fake store so this orchestration test only depends on stage ordering, not
      // on building a real search index from fixture pages.
      searchIndexStore: { searchDocs: async () => [{}] },
    });

    expect(verification.results.map((r) => r.stage)).toEqual([
      'raw-snapshot',
      'route-graph',
      'browser-oracle',
      'structured-graph',
      'rendered-output',
      'search-index',
      'coverage-summary',
    ]);
    expect(verification.results.find((r) => r.stage === 'browser-oracle')?.details?.skipped).toBe(false);
    expect(verification.allPassed).toBe(true);
  });

  it('fails at the browser-oracle stage when explicitly skipped in full mode (a skip must never be reported as a normal pass in full verification)', async () => {
    await writePassingFixtures();
    const verification = await runFullVerification({ cacheDir, mode: 'full', skipBrowserOracle: true });
    expect(verification.allPassed).toBe(false);
    expect(verification.firstFailedStage).toBe('browser-oracle');
    expect(verification.results.map((r) => r.stage)).toEqual(['raw-snapshot', 'route-graph', 'browser-oracle']);
    expect(verification.results.find((r) => r.stage === 'browser-oracle')?.details?.skipped).toBe(true);
  });

  it('allows skipping the browser oracle in smoke mode, clearly reported as skipped', async () => {
    await writePassingFixtures();
    const verification = await runFullVerification({
      cacheDir,
      mode: 'smoke',
      skipBrowserOracle: true,
      searchIndexStore: { searchDocs: async () => [{}] },
    });
    const oracleResult = verification.results.find((r) => r.stage === 'browser-oracle');
    expect(oracleResult?.passed).toBe(true);
    expect(oracleResult?.details?.skipped).toBe(true);
  });

  it('stops after stage 1 (raw-snapshot) when it fails, never reaching later stages', async () => {
    // No fixtures written at all -> manifest.json missing -> stage 1 fails immediately.
    const verification = await runFullVerification({ cacheDir, mode: 'full', browserOracleCaptureFn: EMPTY_BROWSER_ORACLE_CAPTURE_FN });
    expect(verification.allPassed).toBe(false);
    expect(verification.firstFailedStage).toBe('raw-snapshot');
    expect(verification.results.map((r) => r.stage)).toEqual(['raw-snapshot']);
  });

  it('stops after stage 2 (route-graph) when stage 1 passes but stage 2 fails', async () => {
    await writePassingFixtures();
    // Remove the route graph file so stage 2 fails after stage 1 passes.
    await rm(path.join(cacheDir, 'graph', 'routes.json'), { force: true });
    const verification = await runFullVerification({ cacheDir, mode: 'full', browserOracleCaptureFn: EMPTY_BROWSER_ORACLE_CAPTURE_FN });
    expect(verification.allPassed).toBe(false);
    expect(verification.firstFailedStage).toBe('route-graph');
    expect(verification.results.map((r) => r.stage)).toEqual(['raw-snapshot', 'route-graph']);
  });

  it('stops after stage 4 (structured-graph) when an unresolved required resource exists, without reaching rendered-output/search-index/coverage-summary', async () => {
    await writePassingFixtures();
    await writeResourceGraph({
      schemaVersion: 1,
      generatedAt: '2026-06-01T00:00:00.000Z',
      resources: [{
        resourceId: 'token-table:broken',
        kind: 'token-table',
        resourceName: 'broken',
        sourceArtifact: null,
        routes: ['/components/switch/overview'],
        pageIds: [],
        chunkIds: [],
        status: 'unresolved',
        unresolvedReason: 'missing-requested-token-sets',
      }],
    }, cacheDir);

    const verification = await runFullVerification({ cacheDir, mode: 'full', browserOracleCaptureFn: EMPTY_BROWSER_ORACLE_CAPTURE_FN });
    expect(verification.allPassed).toBe(false);
    expect(verification.firstFailedStage).toBe('structured-graph');
    expect(verification.results.map((r) => r.stage)).toEqual(['raw-snapshot', 'route-graph', 'browser-oracle', 'structured-graph']);
  });

  it('runs the injected browser-oracle capture function when skipBrowserOracle is not set', async () => {
    await writePassingFixtures();
    let called = false;
    const verification = await runFullVerification({
      cacheDir,
      mode: 'full',
      browserOracleCaptureFn: async () => {
        called = true;
        return {
          schemaVersion: 1,
          generatedAt: '2026-06-01T00:00:00.000Z',
          baseUrl: 'https://m3.material.io',
          routes: [],
        };
      },
    });
    expect(called).toBe(true);
    expect(verification.results.find((r) => r.stage === 'browser-oracle')?.details?.skipped).toBe(false);
  });
});
