import { describe, expect, it } from 'vitest';
import { buildRouteGraph } from '../src/graph/route-graph.js';
import type { ArtifactRecord } from '../src/raw-artifacts/artifact-types.js';
import type { RoutePlanEntry } from '../src/types.js';

function makeArtifact(overrides: Partial<ArtifactRecord> = {}): ArtifactRecord {
  return {
    id: 'page-data:raw/page-data/c1/d1.json',
    kind: 'page-data',
    sourceUrl: 'https://m3.material.io/components/switches',
    localPath: 'raw/page-data/c1/d1.json',
    httpStatus: 200,
    contentType: 'application/json',
    sha256: 'a'.repeat(64),
    fetchedAt: '2026-06-01T00:00:00.000Z',
    sourceRoute: '/components/switches',
    sourceMethod: 'static-plan',
    error: null,
    diagnostics: null,
    ...overrides,
  };
}

function makeRoutePlanEntry(overrides: Partial<RoutePlanEntry> = {}): RoutePlanEntry {
  return {
    route: '/components/switch',
    canonicalRoute: '/components/switch',
    sources: ['site_meta'],
    publicDocsClassification: 'public-docs',
    reconciliationStatus: 'exact',
    ...overrides,
  };
}

describe('buildRouteGraph source artifact matching', () => {
  it('finds artifacts recorded under an alias slug even when the route plan entry is keyed by the canonical route', () => {
    // Real-world shape: the route was actually fetched via the "/components/switches" alias slug,
    // but route reconciliation accepted the canonical "/components/switch" route. An artifact
    // lookup keyed only by planEntry.route would miss it.
    const artifact = makeArtifact({ sourceRoute: '/components/switches' });
    const graph = buildRouteGraph({
      baseUrl: 'https://m3.material.io',
      routePlanEntries: [makeRoutePlanEntry({ route: '/components/switch', canonicalRoute: '/components/switch', alternateSlugs: ['/components/switches'] })],
      routeCoverage: [],
      artifactRecords: [artifact],
    });
    expect(graph.routes).toHaveLength(1);
    expect(graph.routes[0]?.sourceArtifacts).toEqual([{ artifactId: artifact.id, kind: 'page-data' }]);
  });

  it('does not duplicate an artifact that matches under multiple keys (route, canonicalRoute, alias)', () => {
    const artifact = makeArtifact({ sourceRoute: '/components/switch' });
    const graph = buildRouteGraph({
      baseUrl: 'https://m3.material.io',
      routePlanEntries: [makeRoutePlanEntry({ route: '/components/switch', canonicalRoute: '/components/switch', alternateSlugs: ['/components/switch'] })],
      routeCoverage: [],
      artifactRecords: [artifact],
    });
    expect(graph.routes[0]?.sourceArtifacts).toHaveLength(1);
  });

  it('merges source artifacts across sibling entries that share a canonicalRoute, even when neither lists the other as an alternateSlug', () => {
    // Real-world shape: an accepted alias entry ("/components/switches") and the canonical entry
    // ("/components/switch") both reconcile to the same canonicalRoute, but neither one's own
    // alternateSlugs lists the other — so per-entry lookup alone leaves the canonical entry with
    // an empty sourceArtifacts list while the alias entry (the one actually fetched) has the real
    // artifacts. Both sibling nodes must end up seeing the full provenance.
    const artifact = makeArtifact({ sourceRoute: '/components/switches' });
    const graph = buildRouteGraph({
      baseUrl: 'https://m3.material.io',
      routePlanEntries: [
        makeRoutePlanEntry({ route: '/components/switches', canonicalRoute: '/components/switch', alternateSlugs: [] }),
        makeRoutePlanEntry({ route: '/components/switch', canonicalRoute: '/components/switch', alternateSlugs: [] }),
      ],
      routeCoverage: [],
      artifactRecords: [artifact],
    });
    const canonicalNode = graph.routes.find((node) => node.route === '/components/switch');
    const aliasNode = graph.routes.find((node) => node.route === '/components/switches');
    expect(canonicalNode?.sourceArtifacts).toEqual([{ artifactId: artifact.id, kind: 'page-data' }]);
    expect(aliasNode?.sourceArtifacts).toEqual([{ artifactId: artifact.id, kind: 'page-data' }]);
  });

  it('returns no source artifacts when nothing matches route, canonicalRoute, or any alias', () => {
    const artifact = makeArtifact({ sourceRoute: '/unrelated-route' });
    const graph = buildRouteGraph({
      baseUrl: 'https://m3.material.io',
      routePlanEntries: [makeRoutePlanEntry({ route: '/components/switch', canonicalRoute: '/components/switch', alternateSlugs: ['/components/switches'] })],
      routeCoverage: [],
      artifactRecords: [artifact],
    });
    expect(graph.routes[0]?.sourceArtifacts).toEqual([]);
  });
});
