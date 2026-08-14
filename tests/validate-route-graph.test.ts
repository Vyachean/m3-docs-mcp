import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { writeRouteGraph } from '../src/graph/graph-store.js';
import type { RouteGraph, RouteNode } from '../src/graph/graph-types.js';
import { validateRouteGraph } from '../src/validation/validate-route-graph.js';

let cacheDir: string;

beforeEach(async () => {
  cacheDir = await mkdtemp(path.join(tmpdir(), 'm3-docs-mcp-validate-route-'));
});

afterEach(async () => {
  await rm(cacheDir, { recursive: true, force: true });
});

function makeRouteNode(overrides: Partial<RouteNode> = {}): RouteNode {
  return {
    route: '/components/switch/overview',
    canonicalRoute: '/components/switch/overview',
    aliases: [],
    title: 'Switch',
    section: 'components',
    reference: { collectionId: 'c1', documentId: 'd1', exportedCarbonFileId: 'e1', pageCanonId: 'p1', carbonVersion: null },
    tabs: [],
    origins: ['site_meta'],
    sourceArtifacts: [{ artifactId: 'page-data:raw/page-data/c1/d1.json', kind: 'page-data' }],
    expectedOutputPaths: ['components/switch/overview.md'],
    generatedOutputPaths: ['components/switch/overview.md'],
    coverage: {
      status: 'covered',
      reasons: [],
      originalStatus: 'covered',
      sharedCoverageGroup: null,
      sharedWithRoutes: [],
      expectedOutputPaths: ['components/switch/overview.md'],
      savedOutputPaths: ['components/switch/overview.md'],
      failedOutputPaths: [],
      skippedOutputPaths: [],
    },
    ...overrides,
  };
}

function makeGraph(routes: RouteNode[]): RouteGraph {
  return { schemaVersion: 1, generatedAt: '2026-06-01T00:00:00.000Z', baseUrl: 'https://m3.material.io', routes };
}

const ALL_COVERED_REQUIRED_ROUTES = [
  '/components/switch/overview',
  '/components/switch/specs',
  '/components/buttons/overview',
  '/components/buttons/specs',
  '/components/lists/overview',
  '/components/lists/specs',
  '/styles/color/roles',
  '/foundations/design-tokens/overview',
];

describe('validateRouteGraph', () => {
  it('fails when graph/routes.json is missing', async () => {
    const result = await validateRouteGraph({ cacheDir });
    expect(result.passed).toBe(false);
    expect(result.reasons[0]).toMatch(/graph\/routes\.json is missing/);
  });

  it('fails when a required route has no matching node', async () => {
    await writeRouteGraph(makeGraph([makeRouteNode()]), cacheDir);
    const result = await validateRouteGraph({ cacheDir, requiredRoutes: ['/components/switch/overview', '/components/buttons/overview'] });
    expect(result.passed).toBe(false);
    expect(result.reasons.some((r) => r.includes('/components/buttons/overview') && r.includes('no matching node'))).toBe(true);
  });

  it('fails when a required route has coverage status "ambiguous"', async () => {
    await writeRouteGraph(makeGraph([
      makeRouteNode({ coverage: { ...makeRouteNode().coverage, status: 'ambiguous', originalStatus: 'ambiguous' } }),
    ]), cacheDir);
    const result = await validateRouteGraph({ cacheDir, requiredRoutes: ['/components/switch/overview'] });
    expect(result.passed).toBe(false);
    expect(result.reasons.some((r) => r.includes('ambiguous'))).toBe(true);
  });

  it('fails when a required route has coverage status "unresolved"', async () => {
    await writeRouteGraph(makeGraph([
      makeRouteNode({ coverage: { ...makeRouteNode().coverage, status: 'unresolved', originalStatus: 'unresolved' } }),
    ]), cacheDir);
    const result = await validateRouteGraph({ cacheDir, requiredRoutes: ['/components/switch/overview'] });
    expect(result.passed).toBe(false);
    expect(result.reasons.some((r) => r.includes('unresolved'))).toBe(true);
  });

  it('fails when a required route has no source artifacts', async () => {
    await writeRouteGraph(makeGraph([makeRouteNode({ sourceArtifacts: [] })]), cacheDir);
    const result = await validateRouteGraph({ cacheDir, requiredRoutes: ['/components/switch/overview'] });
    expect(result.passed).toBe(false);
    expect(result.reasons.some((r) => r.includes('no source artifacts'))).toBe(true);
  });

  it('fails when a required route matches more than one node (ambiguous duplicates)', async () => {
    await writeRouteGraph(makeGraph([
      makeRouteNode(),
      makeRouteNode({ route: '/components/switch' /* alias maps to same canonical */, aliases: [], canonicalRoute: '/components/switch/overview' }),
    ]), cacheDir);
    const result = await validateRouteGraph({ cacheDir, requiredRoutes: ['/components/switch/overview'] });
    // Only the node whose own `route` field equals the normalized required route, or whose
    // canonicalRoute/aliases equal it, counts as a match — both nodes above have
    // canonicalRoute === '/components/switch/overview', so this is intentionally ambiguous.
    expect(result.passed).toBe(false);
    expect(result.reasons.some((r) => r.includes('ambiguous nodes'))).toBe(true);
  });

  it('resolves a required route via a tabbed parent node, even when a separate stale duplicate node shares the same literal route string', async () => {
    // Real-world shape: site_meta enumerates "/components/switch/specs" as its own route entry
    // with no reconciled identity (status "stale"), while the *actual* covered content for that
    // path lives on the "/components/switch" parent node's `tabs` array. The stale duplicate must
    // not shadow the tab match.
    const parent = makeRouteNode({
      route: '/components/switch',
      canonicalRoute: '/components/switch',
      tabs: [
        { label: 'Overview', route: '/components/switch/overview', slug: 'overview', matchedSectionId: null, matchReason: 'unmatched' },
        { label: 'Specs', route: '/components/switch/specs', slug: 'specs', matchedSectionId: null, matchReason: 'unmatched' },
      ],
      expectedOutputPaths: ['components/switch/overview.md', 'components/switch/specs.md'],
      generatedOutputPaths: ['components/switch/overview.md', 'components/switch/specs.md'],
      coverage: {
        status: 'covered',
        reasons: [],
        originalStatus: 'covered',
        sharedCoverageGroup: null,
        sharedWithRoutes: [],
        expectedOutputPaths: ['components/switch/overview.md', 'components/switch/specs.md'],
        savedOutputPaths: ['components/switch/overview.md', 'components/switch/specs.md'],
        failedOutputPaths: [],
        skippedOutputPaths: [],
      },
    });
    const staleDuplicate = makeRouteNode({
      route: '/components/switch/specs',
      canonicalRoute: null,
      tabs: [],
      sourceArtifacts: [],
      expectedOutputPaths: [],
      generatedOutputPaths: [],
      coverage: {
        status: 'stale',
        reasons: ['no verified identity or unambiguous component route match'],
        originalStatus: 'stale',
        sharedCoverageGroup: null,
        sharedWithRoutes: [],
        expectedOutputPaths: [],
        savedOutputPaths: [],
        failedOutputPaths: [],
        skippedOutputPaths: [],
      },
    });
    await writeRouteGraph(makeGraph([parent, staleDuplicate]), cacheDir);
    const result = await validateRouteGraph({ cacheDir, requiredRoutes: ['/components/switch/specs'] });
    expect(result.passed).toBe(true);
    expect(result.reasons).toEqual([]);
  });

  it('treats duplicate tab matches that share the same canonicalRoute as one node, not an ambiguity', async () => {
    // Real-world shape: both an accepted alias entry ("/components/switches") and the canonical
    // entry ("/components/switch") can independently carry the same tabs array, since both
    // reconcile to the same content. That's "shared alias coverage", not ambiguity.
    const sharedTabs = [
      { label: 'Overview', route: '/components/switch/overview', slug: 'overview', matchedSectionId: null, matchReason: 'unmatched' as const },
      { label: 'Specs', route: '/components/switch/specs', slug: 'specs', matchedSectionId: null, matchReason: 'unmatched' as const },
    ];
    const canonical = makeRouteNode({
      route: '/components/switch',
      canonicalRoute: '/components/switch',
      tabs: sharedTabs,
      expectedOutputPaths: ['components/switch/overview.md', 'components/switch/specs.md'],
      generatedOutputPaths: ['components/switch/overview.md', 'components/switch/specs.md'],
      coverage: { ...makeRouteNode().coverage, expectedOutputPaths: ['components/switch/overview.md', 'components/switch/specs.md'], savedOutputPaths: ['components/switch/overview.md', 'components/switch/specs.md'] },
    });
    const alias = makeRouteNode({
      route: '/components/switches',
      canonicalRoute: '/components/switch',
      tabs: sharedTabs,
      expectedOutputPaths: ['components/switch/overview.md', 'components/switch/specs.md'],
      generatedOutputPaths: ['components/switch/overview.md', 'components/switch/specs.md'],
      coverage: { ...makeRouteNode().coverage, expectedOutputPaths: ['components/switch/overview.md', 'components/switch/specs.md'], savedOutputPaths: ['components/switch/overview.md', 'components/switch/specs.md'] },
    });
    await writeRouteGraph(makeGraph([canonical, alias]), cacheDir);
    const result = await validateRouteGraph({ cacheDir, requiredRoutes: ['/components/switch/overview', '/components/switch/specs'] });
    expect(result.passed).toBe(true);
    expect(result.reasons).toEqual([]);
  });

  it('accepts a parent-owned tab family with first-class virtual leaf nodes', async () => {
    const parent = makeRouteNode({
      route: '/components/switch',
      canonicalRoute: '/components/switch',
      tabs: [
        { label: 'Overview', route: '/components/switch/overview', slug: 'overview', matchedSectionId: 'overview-section', matchReason: 'label' },
        { label: 'Specs', route: '/components/switch/specs', slug: 'specs', matchedSectionId: 'specs-section', matchReason: 'label' },
      ],
      expectedOutputPaths: ['components/switch/overview.md', 'components/switch/specs.md'],
      generatedOutputPaths: ['components/switch/overview.md', 'components/switch/specs.md'],
      coverage: {
        ...makeRouteNode().coverage,
        expectedOutputPaths: ['components/switch/overview.md', 'components/switch/specs.md'],
        savedOutputPaths: ['components/switch/overview.md', 'components/switch/specs.md'],
      },
    });
    const overviewLeaf = makeRouteNode({ route: '/components/switch/overview', canonicalRoute: '/components/switch/overview', tabs: [] });
    const specsLeaf = makeRouteNode({
      route: '/components/switch/specs',
      canonicalRoute: '/components/switch/specs',
      tabs: [],
      expectedOutputPaths: ['components/switch/specs.md'],
      generatedOutputPaths: ['components/switch/specs.md'],
      coverage: {
        ...makeRouteNode().coverage,
        expectedOutputPaths: ['components/switch/specs.md'],
        savedOutputPaths: ['components/switch/specs.md'],
      },
    });
    await writeRouteGraph(makeGraph([parent, overviewLeaf, specsLeaf]), cacheDir);
    const result = await validateRouteGraph({ cacheDir, requiredRoutes: ['/components/switch/overview', '/components/switch/specs'] });
    expect(result.passed).toBe(true);
    expect(result.reasons).toEqual([]);
  });

  it('passes when all required routes resolve to exactly one covered node with source artifacts', async () => {
    const routes = ALL_COVERED_REQUIRED_ROUTES.map((route) => makeRouteNode({
      route,
      canonicalRoute: route,
      expectedOutputPaths: [`${route.replace(/^\//, '')}.md`],
      generatedOutputPaths: [`${route.replace(/^\//, '')}.md`],
      coverage: {
        status: 'covered',
        reasons: [],
        originalStatus: 'covered',
        sharedCoverageGroup: null,
        sharedWithRoutes: [],
        expectedOutputPaths: [`${route.replace(/^\//, '')}.md`],
        savedOutputPaths: [`${route.replace(/^\//, '')}.md`],
        failedOutputPaths: [],
        skippedOutputPaths: [],
      },
    }));
    await writeRouteGraph(makeGraph(routes), cacheDir);
    const result = await validateRouteGraph({ cacheDir, requiredRoutes: ALL_COVERED_REQUIRED_ROUTES });
    expect(result.passed).toBe(true);
    expect(result.reasons).toEqual([]);
  });
});
