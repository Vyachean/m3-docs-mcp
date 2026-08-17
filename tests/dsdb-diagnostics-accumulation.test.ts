import { describe, expect, it } from 'vitest';
import { decodeResourceChunk, renderDsdbResourceChunk } from '../src/json-extraction/extract-dsdb-resource.js';
import type { ExtractionPageDiagnostic } from '../src/types.js';

describe('DSDB diagnostics accumulation', () => {
  it('increments existing STATUS_TABLE lifecycle counters and initializes diagnostics without resetting state', async () => {
    const diagnostic: ExtractionPageDiagnostic = {
      url: 'https://m3.material.io/components/button/specs',
      path: '/components/button/specs',
      method: 'json',
      source: 'direct-json',
      unknownChunkTypes: [],
      unknownResourceTypes: [],
      tokenTables: 0,
      tokenTablesRendered: 0,
      tokenContextDiagnostics: [],
      statusTablesRequested: 4,
      statusTablesResolved: 3,
      statusTablesDecoded: 2,
      statusTablesRendered: 1,
      statusTablesRenderedAsPlaceholder: 0,
      unsupportedStatusTableSchemaCount: 0,
      missingRequestedTokenSets: [],
      suspiciousReasons: [],
      imageCount: 0,
      videoCount: 0,
      unresolvedResourceCount: 0,
      resourceChunksRequested: 9,
      resourceChunksResolved: 7,
      resourceChunksDecoded: 6,
      resourceChunksRendered: 5,
      noSections: false,
      noHeadings: false,
      markdownLength: 0
    };

    const rendered = await renderDsdbResourceChunk(
      decodeResourceChunk({
        libraryModuleType: 'STATUS_TABLE',
        resourceName: 'design/status/button'
      }),
      async () => ({
        headers: ['Platform', 'Status'],
        rows: [['Android', 'Available']]
      }),
      diagnostic
    );

    expect(rendered).toContain('| Android | Available |');
    expect(diagnostic.statusTablesRequested).toBe(5);
    expect(diagnostic.statusTablesResolved).toBe(4);
    expect(diagnostic.statusTablesDecoded).toBe(3);
    expect(diagnostic.statusTablesRendered).toBe(2);
    expect(diagnostic.resourceChunksRequested).toBe(10);
    expect(diagnostic.resourceChunksResolved).toBe(8);
    expect(diagnostic.resourceChunksDecoded).toBe(7);
    expect(diagnostic.resourceChunksRendered).toBe(6);
    expect(diagnostic.statusTableDiagnostics).toEqual([
      {
        resourceName: 'design/status/button',
        requested: true,
        resolved: true,
        rendered: true,
        renderedAsPlaceholder: false,
        unsupportedSchema: false
      }
    ]);
  });
});
