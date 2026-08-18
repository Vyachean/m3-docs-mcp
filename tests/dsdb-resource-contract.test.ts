import { describe, expect, it, vi } from 'vitest';
import {
  decodeResourceChunk,
  extractRequestedTokenSets,
  extractResourceName,
  renderDsdbResourceChunk,
  type CollectedTokenTable
} from '../src/json-extraction/extract-dsdb-resource.js';
import type { ExtractionPageDiagnostic } from '../src/types.js';

function emptyPageDiagnostic(): ExtractionPageDiagnostic {
  return {
    url: 'https://m3.material.io/components/divider/specs',
    path: '/components/divider/specs',
    method: 'json',
    source: 'direct-json',
    unknownChunkTypes: [],
    unknownResourceTypes: [],
    tokenTables: 0,
    tokenTablesRendered: 0,
    tokenContextDiagnostics: [],
    statusTablesRequested: 0,
    statusTablesResolved: 0,
    statusTablesRendered: 0,
    statusTablesRenderedAsPlaceholder: 0,
    unsupportedStatusTableSchemaCount: 0,
    statusTableDiagnostics: [],
    missingRequestedTokenSets: [],
    suspiciousReasons: [],
    imageCount: 0,
    videoCount: 0,
    unresolvedResourceCount: 0,
    noSections: false,
    noHeadings: false,
    markdownLength: 0
  };
}

const VALID_TOKEN_SYSTEM = {
  tokens: [
    {
      name: 'designSystems/ds/tokenSets/ts/tokens/tok1',
      tokenName: 'md.comp.divider.thickness',
      displayName: 'Divider thickness',
      tokenValueType: 'DIMENSION',
      state: 'ACTIVE'
    }
  ],
  tokenSets: [
    {
      name: 'designSystems/ds/tokenSets/ts',
      displayName: 'Divider - Common',
      tokenSetName: 'md.comp.divider'
    }
  ],
  tags: [
    { name: 'ds/tags/light', displayName: 'Light', tagName: 'light' },
    { name: 'ds/tags/dark', displayName: 'Dark', tagName: 'dark' }
  ],
  contextTagGroups: [],
  contextualReferenceTrees: {
    'designSystems/ds/tokenSets/ts/tokens/tok1': {
      contextualReferenceTree: [
        {
          contextTags: ['ds/tags/light'],
          referenceTree: { tokenName: 'md.comp.divider.thickness', childNodes: [] },
          resolvedValue: { dimension: { value: 1, unit: 'DIPS' } }
        },
        {
          contextTags: ['ds/tags/dark'],
          referenceTree: { tokenName: 'md.comp.divider.thickness', childNodes: [] },
          resolvedValue: { dimension: { value: 1, unit: 'DIPS' } }
        }
      ]
    }
  }
};

describe('DSDB resource decoder boundary', () => {
  it('rejects malformed chunks and keeps wrapper extraction fail-closed', async () => {
    const malformed = { libraryModuleType: 42, resourceName: { invalid: true } };
    const decoded = decodeResourceChunk(malformed);

    expect(decoded).toEqual(expect.objectContaining({
      _unsupported: true,
      issues: expect.arrayContaining([expect.any(String)])
    }));
    expect(extractRequestedTokenSets(malformed)).toEqual([]);
    expect(extractResourceName(malformed)).toBeNull();

    const diagnostic = emptyPageDiagnostic();
    const fetchResource = vi.fn(async () => null);
    const rendered = await renderDsdbResourceChunk(decoded, fetchResource, diagnostic);

    expect(fetchResource).not.toHaveBeenCalled();
    expect(rendered).toContain('Material resource placeholder: UNKNOWN_RESOURCE');
    expect(rendered).toContain('malformed-resource-chunk');
    expect(diagnostic.resourceChunksRequested).toBe(1);
    expect(diagnostic.resourceChunksPlaceholder).toBe(1);
    expect(diagnostic.unresolvedResourceCount).toBe(1);
  });
});

describe('STATUS_TABLE rendering contract', () => {
  it('accounts a successfully resolved, decoded, and rendered table exactly once', async () => {
    const chunk = decodeResourceChunk({
      libraryModuleType: 'STATUS_TABLE',
      resourceName: 'design/status/buttons'
    });
    const diagnostic = emptyPageDiagnostic();
    const fetchResource = vi.fn(async () => ({
      headers: ['Platform', 'Status'],
      rows: [['Android', 'Available']]
    }));

    const rendered = await renderDsdbResourceChunk(chunk, fetchResource, diagnostic);

    expect(fetchResource).toHaveBeenCalledTimes(1);
    expect(fetchResource).toHaveBeenCalledWith('design/status/buttons', 'STATUS_TABLE');
    expect(rendered).toContain('| Platform | Status |');
    expect(rendered).toContain('| Android | Available |');
    expect(diagnostic.resourceChunksRequested).toBe(1);
    expect(diagnostic.resourceChunksResolved).toBe(1);
    expect(diagnostic.resourceChunksDecoded).toBe(1);
    expect(diagnostic.resourceChunksRendered).toBe(1);
    expect(diagnostic.statusTablesRequested).toBe(1);
    expect(diagnostic.statusTablesResolved).toBe(1);
    expect(diagnostic.statusTablesDecoded).toBe(1);
    expect(diagnostic.statusTablesRendered).toBe(1);
    expect(diagnostic.statusTablesRenderedAsPlaceholder).toBe(0);
    expect(diagnostic.unresolvedResourceCount).toBe(0);
    expect(diagnostic.statusTableDiagnostics).toEqual([
      {
        resourceName: 'design/status/buttons',
        requested: true,
        resolved: true,
        rendered: true,
        renderedAsPlaceholder: false,
        unsupportedSchema: false
      }
    ]);
  });

  it('does not fetch without a resource name and records a missing-resource placeholder', async () => {
    const chunk = decodeResourceChunk({ libraryModuleType: 'STATUS_TABLE' });
    const diagnostic = emptyPageDiagnostic();
    const fetchResource = vi.fn(async () => ({ headers: ['Ignored'], rows: [['Ignored']] }));

    const rendered = await renderDsdbResourceChunk(chunk, fetchResource, diagnostic);

    expect(fetchResource).not.toHaveBeenCalled();
    expect(rendered).toContain('missing-status-table-resource');
    expect(rendered).toContain('"resource":null');
    expect(diagnostic.resourceChunksRequested).toBe(1);
    expect(diagnostic.resourceChunksPlaceholder).toBe(1);
    expect(diagnostic.statusTablesRequested).toBe(1);
    expect(diagnostic.statusTablesResolved).toBe(0);
    expect(diagnostic.statusTablesRenderedAsPlaceholder).toBe(1);
    expect(diagnostic.unsupportedStatusTableSchemaCount).toBe(0);
    expect(diagnostic.unresolvedResourceCount).toBe(1);
    expect(diagnostic.unknownResourceTypes).toEqual(['STATUS_TABLE']);
    expect(diagnostic.statusTableDiagnostics).toEqual([
      {
        resourceName: null,
        requested: true,
        resolved: false,
        rendered: false,
        renderedAsPlaceholder: true,
        unsupportedSchema: false
      }
    ]);
  });

  it('distinguishes an unsupported resolved schema from a missing resource', async () => {
    const chunk = decodeResourceChunk({
      libraryModuleType: 'STATUS_TABLE',
      resourceName: 'design/status/buttons'
    });
    const diagnostic = emptyPageDiagnostic();

    const rendered = await renderDsdbResourceChunk(
      chunk,
      async () => ({ payload: { unsupported: true } }),
      diagnostic
    );

    expect(rendered).toContain('unknown-status-table-schema');
    expect(diagnostic.resourceChunksRequested).toBe(1);
    expect(diagnostic.resourceChunksResolved).toBe(1);
    expect(diagnostic.resourceChunksPlaceholder).toBe(1);
    expect(diagnostic.statusTablesRequested).toBe(1);
    expect(diagnostic.statusTablesResolved).toBe(1);
    expect(diagnostic.statusTablesRenderedAsPlaceholder).toBe(1);
    expect(diagnostic.unsupportedStatusTableSchemaCount).toBe(1);
    expect(diagnostic.unresolvedResourceCount).toBe(1);
    expect(diagnostic.statusTableDiagnostics).toEqual([
      {
        resourceName: 'design/status/buttons',
        requested: true,
        resolved: true,
        rendered: false,
        renderedAsPlaceholder: true,
        unsupportedSchema: true
      }
    ]);
  });
});

describe('unknown DSDB resource rendering', () => {
  it('preserves an explicit unknown module type without performing IO', async () => {
    const chunk = decodeResourceChunk({
      libraryModuleType: 'EXPERIMENTAL_GRID',
      resourceName: 'design/experimental/grid'
    });
    const diagnostic = emptyPageDiagnostic();
    const fetchResource = vi.fn(async () => null);

    const rendered = await renderDsdbResourceChunk(chunk, fetchResource, diagnostic);

    expect(fetchResource).not.toHaveBeenCalled();
    expect(rendered).toContain('Material resource placeholder: EXPERIMENTAL_GRID');
    expect(rendered).toContain('design/experimental/grid');
    expect(diagnostic.unknownResourceTypes).toEqual(['EXPERIMENTAL_GRID']);
    expect(diagnostic.resourceChunksRequested).toBe(1);
    expect(diagnostic.resourceChunksPlaceholder).toBe(1);
    expect(diagnostic.unresolvedResourceCount).toBe(1);
  });

  it('uses UNKNOWN_RESOURCE for an untyped chunk without inventing an upstream type', async () => {
    const chunk = decodeResourceChunk({ resourceName: 'design/unknown/resource' });
    const diagnostic = emptyPageDiagnostic();

    const rendered = await renderDsdbResourceChunk(chunk, async () => null, diagnostic);

    expect(rendered).toContain('Material resource placeholder: UNKNOWN_RESOURCE');
    expect(rendered).toContain('design/unknown/resource');
    expect(diagnostic.unknownResourceTypes).toEqual([]);
    expect(diagnostic.resourceChunksRequested).toBe(1);
    expect(diagnostic.resourceChunksPlaceholder).toBe(1);
    expect(diagnostic.unresolvedResourceCount).toBe(1);
  });
});

describe('TOKEN_TABLE and TYPOGRAPHY rendering contract', () => {
  it('fails before IO when a token-system resource has no resource name', async () => {
    const chunk = decodeResourceChunk({
      libraryModuleType: 'TYPOGRAPHY',
      moduleConfiguration: { tokenSets: ['Divider - Common'] }
    });
    const diagnostic = emptyPageDiagnostic();
    const fetchResource = vi.fn(async () => ({ system: VALID_TOKEN_SYSTEM }));

    const rendered = await renderDsdbResourceChunk(chunk, fetchResource, diagnostic);

    expect(fetchResource).not.toHaveBeenCalled();
    expect(rendered).toContain('missing-resource-name');
    expect(rendered).toContain('Divider - Common');
    expect(diagnostic.tokenTables).toBe(1);
    expect(diagnostic.missingRequestedTokenSets).toEqual(['Divider - Common']);
    expect(diagnostic.tokenTablesRenderedAsPlaceholder).toBe(1);
    expect(diagnostic.tokenTablePlaceholderReasons).toEqual(['missing-resource-name']);
    expect(diagnostic.resourceChunksRequested).toBe(1);
    expect(diagnostic.resourceChunksPlaceholder).toBe(1);
    expect(diagnostic.unresolvedResourceCount).toBe(1);
  });

  it('distinguishes a missing resource from a resolved unsupported token schema', async () => {
    const chunk = decodeResourceChunk({
      libraryModuleType: 'TOKEN_TABLE',
      resourceName: 'design/token/buttons',
      moduleConfiguration: { tokenSets: ['Divider - Common'] }
    });

    const missingDiagnostic = emptyPageDiagnostic();
    const missingRendered = await renderDsdbResourceChunk(chunk, async () => null, missingDiagnostic);
    expect(missingRendered).toContain('missing-token-system');
    expect(missingDiagnostic.tokenTables).toBe(1);
    expect(missingDiagnostic.tokenTablesResolved).toBeUndefined();
    expect(missingDiagnostic.tokenTablesUnsupportedSchema).toBeUndefined();
    expect(missingDiagnostic.tokenTablesRenderedAsPlaceholder).toBe(1);
    expect(missingDiagnostic.resourceChunksRequested).toBe(1);
    expect(missingDiagnostic.resourceChunksResolved).toBeUndefined();
    expect(missingDiagnostic.resourceChunksPlaceholder).toBe(1);
    expect(missingDiagnostic.unresolvedResourceCount).toBe(1);
    expect(missingDiagnostic.missingRequestedTokenSets).toEqual(['Divider - Common']);
    expect(missingDiagnostic.tokenTablePlaceholderReasons).toEqual(['missing-token-system']);

    const unsupportedDiagnostic = emptyPageDiagnostic();
    const unsupportedRendered = await renderDsdbResourceChunk(
      chunk,
      async () => ({ system: { tokens: [], tokenSets: [] } }),
      unsupportedDiagnostic
    );
    expect(unsupportedRendered).toContain('missing-token-system');
    expect(unsupportedDiagnostic.tokenTables).toBe(1);
    expect(unsupportedDiagnostic.tokenTablesResolved).toBe(1);
    expect(unsupportedDiagnostic.tokenTablesUnsupportedSchema).toBe(1);
    expect(unsupportedDiagnostic.tokenTablesRenderedAsPlaceholder).toBe(1);
    expect(unsupportedDiagnostic.resourceChunksRequested).toBe(1);
    expect(unsupportedDiagnostic.resourceChunksResolved).toBe(1);
    expect(unsupportedDiagnostic.resourceChunksPlaceholder).toBe(1);
    expect(unsupportedDiagnostic.unresolvedResourceCount).toBe(1);
    expect(unsupportedDiagnostic.missingRequestedTokenSets).toEqual(['Divider - Common']);
    expect(unsupportedDiagnostic.tokenTablePlaceholderReasons).toEqual(['missing-token-system']);
  });

  it('records a successful token-system lifecycle and collected graph input', async () => {
    const chunk = decodeResourceChunk({
      libraryModuleType: 'TOKEN_TABLE',
      resourceName: 'design/token/buttons',
      moduleConfiguration: { tokenSets: ['Divider - Common'] }
    });
    const diagnostic = emptyPageDiagnostic();
    const collected: CollectedTokenTable[] = [];
    const fetchResource = vi.fn(async () => ({ payload: { system: VALID_TOKEN_SYSTEM } }));

    const rendered = await renderDsdbResourceChunk(chunk, fetchResource, diagnostic, collected);

    expect(fetchResource).toHaveBeenCalledWith('design/token/buttons', 'TOKEN_TABLE');
    expect(rendered).toContain('### Divider - Common');
    expect(rendered).not.toContain('## Design Tokens');
    expect(diagnostic.tokenTables).toBe(1);
    expect(diagnostic.tokenTablesResolved).toBe(1);
    expect(diagnostic.tokenTablesDecoded).toBe(1);
    expect(diagnostic.tokenTablesRendered).toBe(1);
    expect(diagnostic.resourceChunksRequested).toBe(1);
    expect(diagnostic.resourceChunksResolved).toBe(1);
    expect(diagnostic.resourceChunksDecoded).toBe(1);
    expect(diagnostic.resourceChunksRendered).toBe(1);
    expect(diagnostic.unresolvedResourceCount).toBe(0);
    expect(diagnostic.missingRequestedTokenSets).toEqual([]);
    expect(diagnostic.tokenContextDiagnostics).toHaveLength(1);
    expect(diagnostic.tokenContextDiagnostics[0]).toEqual(
      expect.objectContaining({ resourceName: 'design/token/buttons' })
    );
    expect(collected).toHaveLength(1);
    expect(collected[0]).toEqual(
      expect.objectContaining({
        resourceName: 'design/token/buttons',
        requestedTokenSets: ['Divider - Common']
      })
    );
    expect(collected[0]?.system.tokenSets[0]?.displayName).toBe('Divider - Common');
  });

  it('renders valid sets and appends an explicit note for requested sets that are absent', async () => {
    const chunk = decodeResourceChunk({
      libraryModuleType: 'TOKEN_TABLE',
      resourceName: 'design/token/buttons',
      moduleConfiguration: { tokenSets: ['Divider - Common', 'Missing set'] }
    });
    const diagnostic = emptyPageDiagnostic();

    const rendered = await renderDsdbResourceChunk(
      chunk,
      async () => ({ system: VALID_TOKEN_SYSTEM }),
      diagnostic
    );

    expect(rendered).toContain('### Divider - Common');
    expect(rendered).toContain('Requested token sets not found: Missing set');
    expect(diagnostic.missingRequestedTokenSets).toEqual(['Missing set']);
    expect(diagnostic.tokenTablesRendered).toBe(1);
    expect(diagnostic.resourceChunksRendered).toBe(1);
    expect(diagnostic.unresolvedResourceCount).toBe(0);
  });

  it('returns the missing-set note as rendered output when no requested set can render', async () => {
    const chunk = decodeResourceChunk({
      libraryModuleType: 'TOKEN_TABLE',
      resourceName: 'design/token/buttons',
      moduleConfiguration: { tokenSets: ['Missing set'] }
    });
    const diagnostic = emptyPageDiagnostic();

    const rendered = await renderDsdbResourceChunk(
      chunk,
      async () => ({ system: VALID_TOKEN_SYSTEM }),
      diagnostic
    );

    expect(rendered).toBe('> Requested token sets not found: Missing set');
    expect(diagnostic.missingRequestedTokenSets).toEqual(['Missing set']);
    expect(diagnostic.tokenTablesRendered).toBe(1);
    expect(diagnostic.resourceChunksRendered).toBe(1);
    expect(diagnostic.tokenTablesRenderedAsPlaceholder).toBeUndefined();
    expect(diagnostic.resourceChunksPlaceholder).toBeUndefined();
    expect(diagnostic.unresolvedResourceCount).toBe(0);
  });

  it('uses a placeholder when a decoded system has nothing renderable and no missing-set note', async () => {
    const chunk = decodeResourceChunk({
      libraryModuleType: 'TOKEN_TABLE',
      resourceName: 'design/token/buttons'
    });
    const diagnostic = emptyPageDiagnostic();
    const systemWithoutSets = {
      ...VALID_TOKEN_SYSTEM,
      tokenSets: []
    };

    const rendered = await renderDsdbResourceChunk(
      chunk,
      async () => ({ system: systemWithoutSets }),
      diagnostic
    );

    expect(rendered).toContain('missing-requested-token-sets');
    expect(diagnostic.tokenTablesDecoded).toBe(1);
    expect(diagnostic.tokenTablesRendered).toBe(0);
    expect(diagnostic.tokenTablesRenderedAsPlaceholder).toBe(1);
    expect(diagnostic.tokenTablePlaceholderReasons).toEqual(['missing-requested-token-sets']);
    expect(diagnostic.resourceChunksDecoded).toBe(1);
    expect(diagnostic.resourceChunksPlaceholder).toBe(1);
    expect(diagnostic.unresolvedResourceCount).toBe(1);
  });

  it('routes TYPOGRAPHY through the token-system renderer rather than the unknown-resource fallback', async () => {
    const chunk = decodeResourceChunk({
      libraryModuleType: 'TYPOGRAPHY',
      resourceName: 'design/token/typography',
      moduleConfiguration: { tokenSets: ['Divider - Common'] }
    });
    const diagnostic = emptyPageDiagnostic();
    const fetchResource = vi.fn(async () => ({ system: VALID_TOKEN_SYSTEM }));

    const rendered = await renderDsdbResourceChunk(chunk, fetchResource, diagnostic);

    expect(fetchResource).toHaveBeenCalledWith('design/token/typography', 'TYPOGRAPHY');
    expect(rendered).toContain('### Divider - Common');
    expect(diagnostic.unknownResourceTypes).toEqual([]);
    expect(diagnostic.tokenTables).toBe(1);
    expect(diagnostic.tokenTablesDecoded).toBe(1);
    expect(diagnostic.tokenTablesRendered).toBe(1);
    expect(diagnostic.unresolvedResourceCount).toBe(0);
  });
});
