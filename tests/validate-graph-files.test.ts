import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  writePageGraph,
  writeProvenanceGraph,
  writeResourceGraph,
  writeRouteGraph,
  writeSectionGraph,
  writeTokenTableGraph,
} from '../src/graph/graph-store.js';
import { validateGraphFiles } from '../src/validation/validate-graph-files.js';

let cacheDir: string;

beforeEach(async () => {
  cacheDir = await mkdtemp(path.join(tmpdir(), 'm3-docs-mcp-validate-graph-files-'));
});

afterEach(async () => {
  await rm(cacheDir, { recursive: true, force: true });
});

const GENERATED_AT = '2026-06-01T00:00:00.000Z';

async function writeNonEmptyGraphs(): Promise<void> {
  await writeRouteGraph({ schemaVersion: 1, generatedAt: GENERATED_AT, baseUrl: 'https://m3.material.io/', routes: [{
    route: '/components/switch/specs', canonicalRoute: '/components/switch/specs', aliases: [], title: 'Switch', section: 'components',
    reference: { collectionId: null, documentId: null, exportedCarbonFileId: null, pageCanonId: null, carbonVersion: null },
    tabs: [], origins: ['site_meta'], sourceArtifacts: [], expectedOutputPaths: [], generatedOutputPaths: [],
    coverage: { status: 'covered', reasons: [], originalStatus: 'covered', sharedCoverageGroup: null, sharedWithRoutes: [], expectedOutputPaths: [], savedOutputPaths: [], failedOutputPaths: [], skippedOutputPaths: [] },
  }] }, cacheDir);
  await writePageGraph({ schemaVersion: 1, generatedAt: GENERATED_AT, pages: [{
    pageId: 'switch-specs', route: '/components/switch/specs', title: 'Switch', section: 'components', tabs: [], headings: [],
    sections: [], chunks: [], resourceIds: [], tokenTableIds: [], unsupportedChunkTypes: [],
    provenance: { sourceArtifacts: [], sourceRoute: '/components/switch/specs', canonicalRoute: '/components/switch/specs', virtualRoute: null },
  }] }, cacheDir);
  await writeResourceGraph({ schemaVersion: 1, generatedAt: GENERATED_AT, resources: [{
    resourceId: 'token-table:switch', kind: 'token-table', resourceName: 'md.comp.switch', sourceArtifact: null,
    routes: ['/components/switch/specs'], pageIds: ['switch-specs'], chunkIds: [], status: 'resolved', unresolvedReason: null,
  }] }, cacheDir);
  await writeTokenTableGraph({ schemaVersion: 1, generatedAt: GENERATED_AT, tokenTables: [{
    resourceId: 'token-table:switch', resourceName: 'md.comp.switch', requestedTokenSets: [], tokenSets: [],
    routes: ['/components/switch/specs'], unresolvedTokenCount: 0,
  }] }, cacheDir);
  await writeSectionGraph({ schemaVersion: 1, generatedAt: GENERATED_AT, sections: [] }, cacheDir);
  await writeProvenanceGraph({ schemaVersion: 1, generatedAt: GENERATED_AT, entries: [] }, cacheDir);
}

describe('validateGraphFiles', () => {
  it('fails when every graph file is missing', async () => {
    const result = await validateGraphFiles({ cacheDir });
    expect(result.passed).toBe(false);
    expect(result.reasons.length).toBeGreaterThanOrEqual(6);
  });

  it('passes when all graphs are present, with routes/pages/resources/tokenTables non-empty', async () => {
    await writeNonEmptyGraphs();
    const result = await validateGraphFiles({ cacheDir });
    expect(result.passed).toBe(true);
    expect(result.reasons).toEqual([]);
  });

  it('allows empty sections and provenance graphs', async () => {
    await writeNonEmptyGraphs();
    const result = await validateGraphFiles({ cacheDir });
    expect(result.passed).toBe(true);
  });

  it('fails when graph/resources.json contains zero resources', async () => {
    await writeNonEmptyGraphs();
    await writeResourceGraph({ schemaVersion: 1, generatedAt: GENERATED_AT, resources: [] }, cacheDir);
    const result = await validateGraphFiles({ cacheDir });
    expect(result.passed).toBe(false);
    expect(result.reasons.some((r) => r.includes('graph/resources.json contains zero resources'))).toBe(true);
  });

  it('fails when graph/token-tables.json is missing', async () => {
    await writeNonEmptyGraphs();
    await rm(path.join(cacheDir, 'graph', 'token-tables.json'), { force: true });
    const result = await validateGraphFiles({ cacheDir });
    expect(result.passed).toBe(false);
    expect(result.reasons.some((r) => r.includes('graph/token-tables.json is missing'))).toBe(true);
  });
});
