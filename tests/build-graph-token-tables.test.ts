import { readFileSync } from 'node:fs';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { buildAndWriteGraph, buildGraphFromIndex } from '../src/graph/build-graph.js';
import { readTokenTableGraph } from '../src/graph/graph-store.js';
import { parseTokenTableSystem } from '../src/json-extraction/schemas.js';
import { persistArtifact } from '../src/raw-artifacts/artifact-store.js';
import { upsertArtifactRecord } from '../src/raw-artifacts/artifact-index.js';
import type { ArtifactRecord } from '../src/raw-artifacts/artifact-types.js';
import type { MaterialIndex } from '../src/types.js';

const fixture = (name: string) => JSON.parse(readFileSync(path.join(process.cwd(), 'tests/fixtures/json-extraction', name), 'utf8'));

function minimalIndex(): MaterialIndex {
  return {
    source: 'https://m3.material.io',
    capturedAt: '2026-06-29T00:00:00.000Z',
    pageCount: 1,
    attemptedPageCount: 1,
    failedPageCount: 0,
    failedUrls: [],
    pages: [{
      id: 'p1',
      title: 'Button',
      url: 'https://m3.material.io/components/button/specs',
      path: 'components/button/specs.md',
      section: 'components',
      headings: ['Button'],
      capturedAt: '2026-06-29T00:00:00.000Z'
    }]
  };
}

let cacheDir: string;
beforeEach(async () => { cacheDir = await mkdtemp(path.join(tmpdir(), 'm3-docs-build-graph-token-tables-')); });
afterEach(async () => { await rm(cacheDir, { recursive: true, force: true }); });

describe('buildGraphFromIndex / buildAndWriteGraph: token-table graph (Part C)', () => {
  it('builds real token-table nodes from collectedTokenTables instead of leaving the graph empty', () => {
    const system = parseTokenTableSystem(fixture('token-table-resource.json').system);
    expect(system).not.toBeNull();

    const graph = buildGraphFromIndex(minimalIndex(), [], [
      {
        resourceName: 'designSystems/20543ce18892f7d9/components/6c818a16475113bd',
        requestedTokenSets: [],
        system: system!,
        route: '/components/button/specs'
      }
    ]);

    expect(graph.tokenTableGraph.tokenTables).toHaveLength(1);
    const node = graph.tokenTableGraph.tokenTables[0]!;
    expect(node.resourceName).toBe('designSystems/20543ce18892f7d9/components/6c818a16475113bd');
    expect(node.routes).toEqual(['/components/button/specs']);
    const allTokens = node.tokenSets.flatMap((set) => set.tokens);
    expect(allTokens.some((token) => token.tokenName === 'md.comp.button.container.color')).toBe(true);
  });

  it('leaves the token-table graph empty when no collectedTokenTables are passed (back-compat with callers that have none)', () => {
    const graph = buildGraphFromIndex(minimalIndex());
    expect(graph.tokenTableGraph.tokenTables).toEqual([]);
  });

  it('persists real token-table data to graph/token-tables.json via buildAndWriteGraph', async () => {
    const system = parseTokenTableSystem(fixture('token-table-resource.json').system);
    expect(system).not.toBeNull();

    await buildAndWriteGraph(minimalIndex(), cacheDir, [], [
      {
        resourceName: 'designSystems/20543ce18892f7d9/components/6c818a16475113bd',
        requestedTokenSets: ['Button - Common'],
        system: system!,
        route: '/components/button/specs'
      }
    ]);

    const tokenTableGraph = await readTokenTableGraph(cacheDir);
    expect(tokenTableGraph?.tokenTables).toHaveLength(1);
    expect(tokenTableGraph?.tokenTables[0]?.requestedTokenSets).toEqual(['Button - Common']);

    const onDisk = JSON.parse(await readFile(path.join(cacheDir, 'graph', 'token-tables.json'), 'utf8'));
    expect(onDisk.tokenTables).toHaveLength(1);
  });

  it('builds token-table nodes from raw dsdb artifacts on the production raw-backed path', async () => {
    const artifactRecords: ArtifactRecord[] = [];
    const pageDataArtifact = await persistArtifact({
      kind: 'page-data',
      pathParts: ['ComponentsM3', 'document-1'],
      sourceUrl: 'https://m3.material.io/page-data/ComponentsM3/document-1.json',
      content: JSON.stringify(fixture('page-data-componentsm3-document.json')),
      httpStatus: 200,
      contentType: 'application/json',
      sourceRoute: '/components/button/specs',
      sourceMethod: 'static-plan'
    }, cacheDir);
    artifactRecords.push(pageDataArtifact);
    const carbonArtifact = await persistArtifact({
      kind: 'carbon-content',
      pathParts: ['carbon-v1', 'exported-file-1'],
      sourceUrl: 'https://m3.material.io/_dsm/content/m3/carbon-v1/exported-file-1.json',
      content: JSON.stringify(fixture('content-token-table.json')),
      httpStatus: 200,
      contentType: 'application/json',
      sourceRoute: '/components/button/specs',
      sourceMethod: 'static-plan'
    }, cacheDir);
    artifactRecords.push(carbonArtifact);
    const dsdbArtifact = await persistArtifact({
      kind: 'dsdb-resource',
      pathParts: ['carbon-v1', 'designSystems_20543ce18892f7d9_components_6c818a16475113bd'],
      sourceUrl: 'dsdb-resource:designSystems/20543ce18892f7d9/components/6c818a16475113bd',
      content: JSON.stringify(fixture('token-table-resource.json')),
      contentType: 'application/json',
      sourceRoute: '/components/button/specs',
      sourceMethod: 'static-plan'
    }, cacheDir);
    artifactRecords.push(dsdbArtifact);
    for (const artifact of artifactRecords) await upsertArtifactRecord(artifact, cacheDir);

    await buildAndWriteGraph({
      ...minimalIndex(),
      extractionDiagnostics: {
        totalPages: 0,
        totalRoutes: 0,
        pagesExtractedThroughJson: 0,
        pagesExtractedThroughDomFallback: 0,
        pagesWhereJsonFailed: 0,
        jsonFallbackRoutes: 0,
        pagesAcceptedFromDirectJson: 0,
        pagesAcceptedFromNetworkJson: 0,
        pagesAcceptedFromDomFallback: 0,
        pagesFailed: 0,
        routesWhereDirectJsonFailed: 0,
        routesWhereNetworkJsonFailed: 0,
        routesWhereDomFallbackFailed: 0,
        pagesWithUnknownChunkTypes: 0,
        pagesWithUnknownResourceTypes: 0,
        unknownChunkCount: 0,
        unknownResourceTypeCount: 0,
        unknownJsonResourceCount: 0,
        pagesWithTokenTables: 0,
        tokenTablesRequested: 0,
        tokenTablesResolved: 0,
        tokenTablesDecoded: 0,
        tokenTablesSuccessfullyRendered: 0,
        tokenTablesRenderedAsPlaceholder: 0,
        tokenTablesUnsupportedSchema: 0,
        tokenTablesFailedToRender: 0,
        tokenTablesRenderedFromInline: 0,
        tokenTablesMissingRequestedTokenSets: 0,
        tokenContextDiagnosticsRecorded: 0,
        tokenTablesUsingFallbackContext: 0,
        tokenTablesWithMultipleContextVariants: 0,
        tokenTablesWithUnresolvedTokens: 0,
        statusTablesRequested: 0,
        statusTablesResolved: 0,
        statusTablesDecoded: 0,
        statusTablesRendered: 0,
        statusTablesRenderedAsPlaceholder: 0,
        unsupportedStatusTableSchemaCount: 0,
        resourceChunksRequested: 0,
        resourceChunksResolved: 0,
        resourceChunksDecoded: 0,
        resourceChunksRendered: 0,
        resourceChunksPlaceholder: 0,
        pagesWithSuspiciouslyShortMarkdown: 0,
        pagesWithNoSections: 0,
        pagesWithNoHeadings: 0,
        imageCount: 0,
        videoCount: 0,
        unresolvedResourceCount: 0,
        rawJsonDebugFilesWritten: 0,
        sourcePagesSelected: 0,
        sourcePagesAttempted: 0,
        sourcePagesSucceeded: 0,
        sourcePagesFailed: 0,
        virtualPagesPlanned: 0,
        virtualPagesSaved: 0,
        virtualPagesFailed: 0,
        cachePagesSaved: 0,
        pageDiagnostics: [],
        routeDiagnostics: [{
          url: 'https://m3.material.io/components/button/specs',
          path: 'components/button/specs.md',
          sourceUsed: 'direct-json',
          finalMethod: 'json',
          jsonAttempted: true,
          jsonSucceeded: true,
          browserFallbackAttempted: false,
          browserFallbackSucceeded: false,
          unknownChunkTypes: [],
          unknownResourceTypes: [],
          tokenTables: 1,
          tokenTablesRendered: 1,
          missingRequestedTokenSets: [],
          sourceRoute: '/components/button/specs',
          canonicalRoute: '/components/button/specs',
          virtualRoute: '/components/button/specs'
        }]
      }
    }, cacheDir, artifactRecords, []);

    const tokenTableGraph = await readTokenTableGraph(cacheDir);
    expect(tokenTableGraph?.tokenTables).toHaveLength(1);
    expect(tokenTableGraph?.tokenTables[0]?.routes).toEqual(['/components/button/specs']);
    expect(tokenTableGraph?.tokenTables[0]?.tokenSets.flatMap((tokenSet) => tokenSet.tokens).some((token) => token.tokenName === 'md.comp.button.container.color')).toBe(true);
  });
});
