import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { indexPath } from '../../src/cache.js';
import { readPersistedManifestCounts, writeManifest, type CacheManifest } from '../../src/manifest.js';
import { writeArtifactIndex, type ArtifactIndex } from '../../src/raw-artifacts/artifact-index.js';
import type { ArtifactRecord } from '../../src/raw-artifacts/artifact-types.js';
import {
  writePageGraph,
  writeProvenanceGraph,
  writeResourceGraph,
  writeRouteGraph,
  writeSectionGraph,
  writeTokenTableGraph,
} from '../../src/graph/graph-store.js';
import type { PageNode, ResourceNode, RouteNode, TokenTableNode } from '../../src/graph/graph-types.js';
import { writeRendererReport } from '../../src/rendered/renderer-report.js';
import { REQUIRED_PAGE_PATHS } from '../../src/validation/validate-rendered-output.js';
import { REQUIRED_CACHE_VALIDATION_ROUTES } from '../../src/validation/validate-cache-v2.js';

const GENERATED_AT = '2026-06-01T00:00:00.000Z';

function specRouteSlug(route: string): string {
  return route.replace(/^\/+/, '').replace(/\/specs$/, '');
}

function makeArtifactRecord(id: string, overrides: Partial<ArtifactRecord> = {}): ArtifactRecord {
  return {
    id,
    kind: 'page-data',
    sourceUrl: `https://m3.material.io/${id}`,
    localPath: `raw/${id}.json`,
    httpStatus: 200,
    contentType: 'application/json',
    sha256: 'a'.repeat(64),
    fetchedAt: GENERATED_AT,
    sourceRoute: null,
    sourceMethod: 'static-plan',
    error: null,
    diagnostics: null,
    ...overrides,
  };
}

function makeRouteNode(route: string, overrides: Partial<RouteNode> = {}): RouteNode {
  return {
    route,
    canonicalRoute: route,
    aliases: [],
    title: route,
    section: 'components',
    reference: { collectionId: null, documentId: null, exportedCarbonFileId: null, pageCanonId: null, carbonVersion: null },
    tabs: [],
    origins: ['site_meta'],
    sourceArtifacts: [{ artifactId: `page-data:${specRouteSlug(route)}`, kind: 'page-data' }],
    expectedOutputPaths: [`${specRouteSlug(route)}/specs.md`],
    generatedOutputPaths: [`${specRouteSlug(route)}/specs.md`],
    coverage: {
      status: 'covered',
      reasons: [],
      originalStatus: 'covered',
      sharedCoverageGroup: null,
      sharedWithRoutes: [],
      expectedOutputPaths: [`${specRouteSlug(route)}/specs.md`],
      savedOutputPaths: [`${specRouteSlug(route)}/specs.md`],
      failedOutputPaths: [],
      skippedOutputPaths: [],
    },
    ...overrides,
  };
}

function makePageNode(route: string, overrides: Partial<PageNode> = {}): PageNode {
  const slug = specRouteSlug(route);
  const resourceId = `token-table:${slug}`;
  return {
    pageId: `${slug}-specs`,
    route,
    title: route,
    section: 'components',
    tabs: [],
    headings: [route],
    sections: [{ sectionId: `${slug}-sec-1`, title: 'Specs', headingLevel: 1, chunkIds: [`${slug}-chunk-1`] }],
    chunks: [{ chunkId: `${slug}-chunk-1`, chunkType: 'resource', resourceId, textExcerpt: null }],
    resourceIds: [resourceId],
    tokenTableIds: [resourceId],
    unsupportedChunkTypes: [],
    provenance: {
      sourceArtifacts: [{ artifactId: `page-data:${slug}`, kind: 'page-data' }],
      sourceRoute: route,
      canonicalRoute: route,
      virtualRoute: null,
    },
    ...overrides,
  };
}

function makeResourceNode(route: string, overrides: Partial<ResourceNode> = {}): ResourceNode {
  const slug = specRouteSlug(route);
  return {
    resourceId: `token-table:${slug}`,
    kind: 'token-table',
    resourceName: `md.comp.${slug.split('/').pop()}`,
    sourceArtifact: { artifactId: `dsdb-resource:${slug}`, kind: 'dsdb-resource' },
    routes: [route],
    pageIds: [`${slug}-specs`],
    chunkIds: [`${slug}-chunk-1`],
    status: 'resolved',
    unresolvedReason: null,
    ...overrides,
  };
}

function makeTokenTableNode(route: string, overrides: Partial<TokenTableNode> = {}): TokenTableNode {
  const slug = specRouteSlug(route);
  return {
    resourceId: `token-table:${slug}`,
    resourceName: `md.comp.${slug.split('/').pop()}`,
    requestedTokenSets: [`md.comp.${slug.split('/').pop()}.selected`],
    tokenSets: [],
    routes: [route],
    unresolvedTokenCount: 0,
    ...overrides,
  };
}

export type CacheV2FixtureOptions = {
  /** When true, writes the artifact index as the current bare top-level array format. */
  artifactIndexAsBareArray?: boolean;
};

/** Builds a fully valid cache v2 fixture on disk: every required file, a verified manifest, and
 * graph entries for every REQUIRED_CACHE_VALIDATION_ROUTES route — enough for validateCacheV2 to
 * pass end to end (given a stubbed rendered-output rebuild function, since no real raw page-data
 * artifacts are decodable here). */
export async function writeValidCacheV2Fixture(cacheDir: string, options: CacheV2FixtureOptions = {}): Promise<void> {
  await mkdir(cacheDir, { recursive: true });

  const artifacts: ArtifactRecord[] = REQUIRED_CACHE_VALIDATION_ROUTES.flatMap((route) => {
    const slug = specRouteSlug(route);
    return [
      makeArtifactRecord(`page-data:${slug}`, { kind: 'page-data', sourceRoute: route }),
      makeArtifactRecord(`dsdb-resource:${slug}`, { kind: 'dsdb-resource', sourceRoute: route }),
    ];
  });
  if (options.artifactIndexAsBareArray) {
    await mkdir(path.dirname(path.join(cacheDir, 'raw', 'artifact-index.json')), { recursive: true });
    await writeFile(path.join(cacheDir, 'raw', 'artifact-index.json'), `${JSON.stringify(artifacts, null, 2)}\n`, 'utf8');
  } else {
    const index: ArtifactIndex = { artifacts };
    await writeArtifactIndex(index, cacheDir);
  }

  await writeRouteGraph({
    schemaVersion: 1,
    generatedAt: GENERATED_AT,
    baseUrl: 'https://m3.material.io/',
    routes: REQUIRED_CACHE_VALIDATION_ROUTES.map((route) => makeRouteNode(route)),
  }, cacheDir);

  await writePageGraph({
    schemaVersion: 1,
    generatedAt: GENERATED_AT,
    pages: REQUIRED_CACHE_VALIDATION_ROUTES.map((route) => makePageNode(route)),
  }, cacheDir);

  await writeResourceGraph({
    schemaVersion: 1,
    generatedAt: GENERATED_AT,
    resources: REQUIRED_CACHE_VALIDATION_ROUTES.map((route) => makeResourceNode(route)),
  }, cacheDir);

  await writeTokenTableGraph({
    schemaVersion: 1,
    generatedAt: GENERATED_AT,
    tokenTables: REQUIRED_CACHE_VALIDATION_ROUTES.map((route) => makeTokenTableNode(route)),
  }, cacheDir);

  await writeSectionGraph({ schemaVersion: 1, generatedAt: GENERATED_AT, sections: [] }, cacheDir);
  await writeProvenanceGraph({ schemaVersion: 1, generatedAt: GENERATED_AT, entries: [] }, cacheDir);

  await writeRendererReport({
    schemaVersion: 1,
    generatedAt: GENERATED_AT,
    routes: [],
    requiredRouteFailures: [],
  }, cacheDir);

  for (const relativePath of REQUIRED_PAGE_PATHS) {
    const absolutePath = path.join(cacheDir, relativePath);
    await mkdir(path.dirname(absolutePath), { recursive: true });
    await writeFile(absolutePath, '# OK\n\nNo placeholders here.', 'utf8');
  }

  const markdownPages = REQUIRED_PAGE_PATHS.map((relativePath) => {
    const pagePath = relativePath.replace(/^pages\//, '');
    return {
      id: pagePath,
      title: pagePath,
      url: `https://m3.material.io/${pagePath.replace(/\.md$/, '')}`,
      path: pagePath,
      section: 'components',
      headings: ['OK'],
      capturedAt: GENERATED_AT,
    };
  });
  await mkdir(path.dirname(indexPath(cacheDir)), { recursive: true });
  await writeFile(indexPath(cacheDir), JSON.stringify({
    source: 'https://m3.material.io/',
    capturedAt: GENERATED_AT,
    pageCount: markdownPages.length,
    pages: markdownPages,
    coverageDiagnostics: {
      coverageHealth: 'verified',
      routeCoverageSummary: { failedRoutes: 0, unresolvedRoutes: 0, partialRoutes: 0, problematicExamples: [] },
      routeCoverage: [],
    },
  }), 'utf8');

  await mkdir(path.join(cacheDir, 'diagnostics'), { recursive: true });
  await writeFile(path.join(cacheDir, 'diagnostics', 'latest-update.json'), JSON.stringify({ runId: 'fixture-run' }), 'utf8');

  const manifest: CacheManifest = {
    schemaVersion: 2,
    generatedAt: GENERATED_AT,
    baseUrl: 'https://m3.material.io/',
    carbonVersion: 'cv-1',
    siteMetaHash: 'a'.repeat(64),
    angularBundleHash: 'b'.repeat(64),
    sitemapHash: 'c'.repeat(64),
    counts: await readPersistedManifestCounts(cacheDir),
    health: { rawSnapshot: 'verified', graph: 'verified', markdown: 'verified', coverage: 'verified' },
  };
  await writeManifest(manifest, cacheDir);
}
