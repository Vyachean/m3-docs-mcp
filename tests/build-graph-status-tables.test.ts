import { readFileSync } from 'node:fs';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { buildAndWriteGraph } from '../src/graph/build-graph.js';
import { createEmptyExtractionDiagnostics } from '../src/json-extraction/diagnostics.js';
import { readResourceGraph } from '../src/graph/graph-store.js';
import { validateStructuredGraph } from '../src/validation/validate-structured-graph.js';
import { persistArtifact } from '../src/raw-artifacts/artifact-store.js';
import { upsertArtifactRecord } from '../src/raw-artifacts/artifact-index.js';
import type { ArtifactRecord } from '../src/raw-artifacts/artifact-types.js';
import type { ExtractionRouteDiagnostic, MaterialIndex } from '../src/types.js';

/**
 * Regression for the m3-docs-cache production failure: status-table resources under
 * designSystems/030656e0a1083ef1/components/<id> (the real DSDB design system for component
 * availability matrices, distinct from the token-table design system 20543ce18892f7d9) must
 * resolve to a persisted dsdb-resource artifact on the production raw-backed graph path —
 * crawler.ts's withArtifactPersistence and the graph builders must preserve and use the design
 * system id from the raw resourceName when fetching/storing/resolving DSDB resources, not just
 * the trailing component id (which is only unique within one design system).
 */

const fixture = (name: string) => JSON.parse(readFileSync(path.join(process.cwd(), 'tests/fixtures/json-extraction', name), 'utf8'));

const SOURCE_ROUTE = '/components/lists/overview';
const RESOURCE_NAME = 'designSystems/030656e0a1083ef1/components/11cb6b2ed0f6dee4';

function minimalIndex(): MaterialIndex {
  const routeDiagnostic: ExtractionRouteDiagnostic = {
    url: 'https://m3.material.io/components/lists/overview',
    path: 'components/lists/overview.md',
    sourceUsed: 'direct-json',
    finalMethod: 'json',
    jsonAttempted: true,
    jsonSucceeded: true,
    browserFallbackAttempted: false,
    browserFallbackSucceeded: false,
    unknownChunkTypes: [],
    unknownResourceTypes: [],
    tokenTables: 0,
    tokenTablesRendered: 0,
    missingRequestedTokenSets: [],
    sourceRoute: SOURCE_ROUTE,
    canonicalRoute: SOURCE_ROUTE,
    virtualRoute: SOURCE_ROUTE,
  };
  return {
    source: 'https://m3.material.io',
    capturedAt: '2026-06-29T00:00:00.000Z',
    pageCount: 1,
    attemptedPageCount: 1,
    failedPageCount: 0,
    failedUrls: [],
    pages: [{
      id: 'lists-overview',
      title: 'Lists',
      url: 'https://m3.material.io/components/lists/overview',
      path: 'components/lists/overview.md',
      section: 'components',
      headings: ['Lists'],
      capturedAt: '2026-06-29T00:00:00.000Z',
    }],
    extractionDiagnostics: {
      ...createEmptyExtractionDiagnostics(),
      pageDiagnostics: [],
      routeDiagnostics: [routeDiagnostic],
    },
  };
}

let cacheDir: string;
beforeEach(async () => { cacheDir = await mkdtemp(path.join(tmpdir(), 'm3-docs-build-graph-status-tables-')); });
afterEach(async () => { await rm(cacheDir, { recursive: true, force: true }); });

async function seedRawSnapshot(includeDsdbArtifact: boolean): Promise<ArtifactRecord[]> {
  const artifactRecords: ArtifactRecord[] = [];
  artifactRecords.push(await persistArtifact({
    kind: 'page-data',
    pathParts: ['ComponentsM3', 'document-1'],
    sourceUrl: 'https://m3.material.io/page-data/ComponentsM3/document-1.json',
    content: JSON.stringify(fixture('page-data-componentsm3-document.json')),
    httpStatus: 200,
    contentType: 'application/json',
    sourceRoute: SOURCE_ROUTE,
    sourceMethod: 'static-plan',
  }, cacheDir));
  artifactRecords.push(await persistArtifact({
    kind: 'carbon-content',
    pathParts: ['cv-1', 'exported-file-lists'],
    sourceUrl: 'https://m3.material.io/_dsm/content/m3/cv-1/exported-file-lists.json',
    content: JSON.stringify(fixture('content-status-table-connections.json')),
    httpStatus: 200,
    contentType: 'application/json',
    sourceRoute: SOURCE_ROUTE,
    sourceMethod: 'static-plan',
  }, cacheDir));
  if (includeDsdbArtifact) {
    // Basename matches dsdbArtifactBaseName(RESOURCE_NAME) — design-system-id-qualified, the
    // same convention crawler.ts's withArtifactPersistence uses, so resource-graph.ts and
    // raw-graph-build.ts can find it by resourceName alone.
    artifactRecords.push(await persistArtifact({
      kind: 'dsdb-resource',
      pathParts: ['cv-1', 'designSystems_030656e0a1083ef1_components_11cb6b2ed0f6dee4'],
      sourceUrl: `dsdb-resource:${RESOURCE_NAME}`,
      content: JSON.stringify(fixture('status-table-resource-connections.json')),
      contentType: 'application/json',
      sourceRoute: SOURCE_ROUTE,
      sourceMethod: 'static-plan',
    }, cacheDir));
  }
  for (const record of artifactRecords) await upsertArtifactRecord(record, cacheDir);
  return artifactRecords;
}

describe('buildAndWriteGraph: status-table resources (designSystems/030656e0a1083ef1)', () => {
  it('resolves the status-table resource to its DSDB artifact on the production raw-backed path', async () => {
    const artifactRecords = await seedRawSnapshot(true);
    await buildAndWriteGraph(minimalIndex(), cacheDir, artifactRecords, []);

    const resourceGraph = await readResourceGraph(cacheDir);
    const node = resourceGraph?.resources.find((r) => r.resourceName === RESOURCE_NAME);
    expect(node).toBeDefined();
    expect(node?.kind).toBe('status-table');
    expect(node?.status).toBe('resolved');
    expect(node?.unresolvedReason).toBeNull();
    expect(node?.sourceArtifact).not.toBeNull();
    expect(node?.sourceArtifact?.kind).toBe('dsdb-resource');
  });

  it('strict structured-graph validation fails when the status-table DSDB artifact is missing', async () => {
    const artifactRecords = await seedRawSnapshot(false);
    await buildAndWriteGraph(minimalIndex(), cacheDir, artifactRecords, []);

    const result = await validateStructuredGraph({ cacheDir, requiredRoutes: [SOURCE_ROUTE] });
    expect(result.passed).toBe(false);
    expect(result.reasons.some((r) => r.includes(RESOURCE_NAME) && r.includes('missing-status-table-resource'))).toBe(true);
  });
});
