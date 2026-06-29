import { readFileSync } from 'node:fs';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { buildAndWriteGraph, buildGraphFromIndex } from '../src/graph/build-graph.js';
import { readTokenTableGraph } from '../src/graph/graph-store.js';
import { parseTokenTableSystem } from '../src/json-extraction/schemas.js';
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
});
