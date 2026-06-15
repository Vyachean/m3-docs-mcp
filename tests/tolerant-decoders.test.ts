import { describe, expect, it } from 'vitest';
import { normalizeTokenTableSystem, renderTokenTableWithDiagnostics, renderStatusTableMarkdown } from '../src/json-extraction/render-markdown.js';
import { renderDsdbResourceChunk } from '../src/json-extraction/extract-dsdb-resource.js';
import { extractContentPageToMaterialPage } from '../src/json-extraction/extract-content-page.js';
import type { ExtractionPageDiagnostic } from '../src/types.js';

// ─── Helpers ──────────────────────────────────────────────────────────────────

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

// Minimal valid token system fixture
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
  tokenSets: [{ name: 'designSystems/ds/tokenSets/ts', displayName: 'Divider - Common', tokenSetName: 'md.comp.divider' }],
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
          referenceTree: { tokenName: 'md.comp.divider.thickness', childNodes: [{ tokenName: 'md.sys.shape.corner.none' }] },
          resolvedValue: { dimension: { value: 1, unit: 'DIPS' } }
        },
        {
          contextTags: ['ds/tags/dark'],
          referenceTree: { tokenName: 'md.comp.divider.thickness', childNodes: [{ tokenName: 'md.sys.shape.corner.none' }] },
          resolvedValue: { dimension: { value: 1, unit: 'DIPS' } }
        }
      ]
    }
  }
};

// ─── normalizeTokenTableSystem ────────────────────────────────────────────────

describe('normalizeTokenTableSystem – malformed inputs', () => {
  it('returns null for null/undefined/non-object', () => {
    expect(normalizeTokenTableSystem(null)).toBeNull();
    expect(normalizeTokenTableSystem(undefined)).toBeNull();
    expect(normalizeTokenTableSystem('string')).toBeNull();
    expect(normalizeTokenTableSystem(42)).toBeNull();
  });

  it('returns null when tokens and tokenSets are both empty', () => {
    expect(normalizeTokenTableSystem({ tokens: [], tokenSets: [] })).toBeNull();
    expect(normalizeTokenTableSystem({ tokens: 'bad', tokenSets: null })).toBeNull();
  });

  it('handles missing tokenSets field – normalizes to empty array', () => {
    const result = normalizeTokenTableSystem({ tokens: [{ name: 'ds/tok', tokenName: 'md.tok', displayName: 'Tok', tokenValueType: 'COLOR', state: 'ACTIVE' }] });
    expect(result).not.toBeNull();
    expect(result!.tokenSets).toEqual([]);
  });

  it('handles tokenSets not an array – normalizes to empty array', () => {
    const result = normalizeTokenTableSystem({ tokens: [{ name: 'ds/tok', tokenName: 'md.tok', displayName: 'Tok', tokenValueType: 'COLOR', state: 'ACTIVE' }], tokenSets: 'invalid' });
    expect(result).not.toBeNull();
    expect(result!.tokenSets).toEqual([]);
  });

  it('handles missing tokens field – normalizes to empty array', () => {
    const result = normalizeTokenTableSystem({ tokenSets: [{ name: 'ds/ts', displayName: 'Set', tokenSetName: 'md.set' }] });
    expect(result).not.toBeNull();
    expect(result!.tokens).toEqual([]);
  });

  it('drops token entries missing name field to avoid undefined.startsWith crashes', () => {
    const result = normalizeTokenTableSystem({
      tokens: [
        { tokenName: 'md.tok', displayName: 'Tok', tokenValueType: 'COLOR', state: 'ACTIVE' }, // missing name
        { name: 'ds/tok2', tokenName: 'md.tok2', displayName: 'Tok2', tokenValueType: 'COLOR', state: 'ACTIVE' }
      ],
      tokenSets: [{ name: 'ds/ts', displayName: 'Set', tokenSetName: 'md.set' }]
    });
    expect(result).not.toBeNull();
    expect(result!.tokens).toHaveLength(1);
    expect(result!.tokens[0]!.name).toBe('ds/tok2');
  });

  it('normalizes token entries with non-string fields to empty string fallbacks', () => {
    const result = normalizeTokenTableSystem({
      tokens: [{ name: 'ds/tok', tokenName: 42, displayName: null, tokenValueType: undefined, state: true }],
      tokenSets: [{ name: 'ds/ts', displayName: 'Set', tokenSetName: 'md.set' }]
    });
    expect(result).not.toBeNull();
    const token = result!.tokens[0]!;
    expect(token.name).toBe('ds/tok');
    expect(token.tokenName).toBe('');
    expect(token.displayName).toBe('');
    expect(token.tokenValueType).toBe('');
    expect(token.state).toBe('');
  });

  it('handles missing contextualReferenceTrees – normalizes to empty object', () => {
    const result = normalizeTokenTableSystem({
      tokens: [{ name: 'ds/tok', tokenName: 'md.tok', displayName: 'Tok', tokenValueType: 'COLOR', state: 'ACTIVE' }],
      tokenSets: [{ name: 'ds/ts', displayName: 'Set', tokenSetName: 'md.set' }]
    });
    expect(result).not.toBeNull();
    expect(result!.contextualReferenceTrees).toEqual({});
  });

  it('handles contextualReferenceTrees not an object – normalizes to empty object', () => {
    const result = normalizeTokenTableSystem({
      tokens: [{ name: 'ds/tok', tokenName: 'md.tok', displayName: 'Tok', tokenValueType: 'COLOR', state: 'ACTIVE' }],
      tokenSets: [{ name: 'ds/ts', displayName: 'Set', tokenSetName: 'md.set' }],
      contextualReferenceTrees: 'invalid'
    });
    expect(result).not.toBeNull();
    expect(result!.contextualReferenceTrees).toEqual({});
  });

  it('handles contextual tree entry missing childNodes – does not throw', () => {
    const result = normalizeTokenTableSystem({
      tokens: [{ name: 'ds/tok', tokenName: 'md.tok', displayName: 'Tok', tokenValueType: 'COLOR', state: 'ACTIVE' }],
      tokenSets: [{ name: 'ds/ts', displayName: 'Set', tokenSetName: 'md.set' }],
      contextualReferenceTrees: {
        'ds/tok': {
          contextualReferenceTree: [
            { contextTags: [], referenceTree: { tokenName: 'md.tok' /* no childNodes */ }, resolvedValue: {} }
          ]
        }
      }
    });
    expect(result).not.toBeNull();
    const treeEntry = result!.contextualReferenceTrees['ds/tok'];
    expect(treeEntry).toBeDefined();
    const refTree = treeEntry!.contextualReferenceTree[0]!.referenceTree;
    expect(refTree.tokenName).toBe('md.tok');
    expect(refTree.childNodes).toEqual([]);
  });

  it('normalizes nested reference tree recursively – handles deep missing childNodes', () => {
    const result = normalizeTokenTableSystem({
      tokens: [{ name: 'ds/tok', tokenName: 'md.tok', displayName: 'Tok', tokenValueType: 'COLOR', state: 'ACTIVE' }],
      tokenSets: [{ name: 'ds/ts', displayName: 'Set', tokenSetName: 'md.set' }],
      contextualReferenceTrees: {
        'ds/tok': {
          contextualReferenceTree: [
            {
              contextTags: [],
              referenceTree: {
                tokenName: 'md.tok',
                childNodes: [{ tokenName: 'md.sys.ref', childNodes: [{ tokenName: 'md.ref.deep' /* no further childNodes */ }] }]
              },
              resolvedValue: {}
            }
          ]
        }
      }
    });
    expect(result).not.toBeNull();
    const refTree = result!.contextualReferenceTrees['ds/tok']!.contextualReferenceTree[0]!.referenceTree;
    expect(refTree.childNodes![0]!.tokenName).toBe('md.sys.ref');
    expect(refTree.childNodes![0]!.childNodes![0]!.tokenName).toBe('md.ref.deep');
    expect(refTree.childNodes![0]!.childNodes![0]!.childNodes).toEqual([]);
  });

  it('handles referenceTree being null or non-object – returns safe fallback', () => {
    const result = normalizeTokenTableSystem({
      tokens: [{ name: 'ds/tok', tokenName: 'md.tok', displayName: 'Tok', tokenValueType: 'COLOR', state: 'ACTIVE' }],
      tokenSets: [{ name: 'ds/ts', displayName: 'Set', tokenSetName: 'md.set' }],
      contextualReferenceTrees: {
        'ds/tok': {
          contextualReferenceTree: [
            { contextTags: [], referenceTree: null, resolvedValue: {} }
          ]
        }
      }
    });
    expect(result).not.toBeNull();
    const refTree = result!.contextualReferenceTrees['ds/tok']!.contextualReferenceTree[0]!.referenceTree;
    expect(refTree.tokenName).toBe('');
    expect(refTree.childNodes).toEqual([]);
  });
});

// ─── renderTokenTableWithDiagnostics – robustness ─────────────────────────────

describe('renderTokenTableWithDiagnostics – malformed normalized systems', () => {
  it('does not throw when rendered on a valid system', () => {
    const system = normalizeTokenTableSystem(VALID_TOKEN_SYSTEM)!;
    expect(() => renderTokenTableWithDiagnostics(system, ['Divider - Common'])).not.toThrow();
  });

  it('returns empty markdown when displayTokenSets list is empty', () => {
    const system = normalizeTokenTableSystem(VALID_TOKEN_SYSTEM)!;
    const { markdown } = renderTokenTableWithDiagnostics(system, []);
    expect(markdown).toBe('');
  });

  it('returns empty markdown when no token names match the token set prefix', () => {
    const system = normalizeTokenTableSystem({
      ...VALID_TOKEN_SYSTEM,
      tokens: [{ name: 'other/prefix/tok', tokenName: 'md.other', displayName: 'Other', tokenValueType: 'COLOR', state: 'ACTIVE' }]
    })!;
    const { markdown } = renderTokenTableWithDiagnostics(system, ['Divider - Common']);
    expect(markdown).toBe('');
  });

  it('does not throw when token is INACTIVE', () => {
    const system = normalizeTokenTableSystem({
      ...VALID_TOKEN_SYSTEM,
      tokens: [{ name: 'designSystems/ds/tokenSets/ts/tokens/tok1', tokenName: 'md.tok', displayName: 'Tok', tokenValueType: 'COLOR', state: 'INACTIVE' }]
    })!;
    expect(() => renderTokenTableWithDiagnostics(system, ['Divider - Common'])).not.toThrow();
  });

  it('does not throw with entirely empty contextualReferenceTrees', () => {
    const system = normalizeTokenTableSystem({
      ...VALID_TOKEN_SYSTEM,
      contextualReferenceTrees: {}
    })!;
    expect(() => renderTokenTableWithDiagnostics(system, ['Divider - Common'])).not.toThrow();
    const { markdown } = renderTokenTableWithDiagnostics(system, ['Divider - Common']);
    expect(markdown).toBe('');
  });

  it('does not throw when contextTags array contains non-strings', () => {
    const system = normalizeTokenTableSystem({
      ...VALID_TOKEN_SYSTEM,
      contextualReferenceTrees: {
        'designSystems/ds/tokenSets/ts/tokens/tok1': {
          contextualReferenceTree: [
            { contextTags: [123, null, 'ds/tags/light'], referenceTree: { tokenName: 'md.tok' }, resolvedValue: { dimension: { value: 1, unit: 'DIPS' } } }
          ]
        }
      }
    })!;
    expect(() => renderTokenTableWithDiagnostics(system, ['Divider - Common'])).not.toThrow();
  });

  it('does not throw when token value shapes are unexpected', () => {
    const system = normalizeTokenTableSystem({
      ...VALID_TOKEN_SYSTEM,
      contextualReferenceTrees: {
        'designSystems/ds/tokenSets/ts/tokens/tok1': {
          contextualReferenceTree: [
            { contextTags: ['ds/tags/light'], referenceTree: { tokenName: 'md.tok' }, resolvedValue: { weirdKey: { deeply: { nested: true } } } },
            { contextTags: ['ds/tags/dark'], referenceTree: { tokenName: 'md.tok' }, resolvedValue: {} }
          ]
        }
      }
    })!;
    expect(() => renderTokenTableWithDiagnostics(system, ['Divider - Common'])).not.toThrow();
  });
});

// ─── renderStatusTableMarkdown ────────────────────────────────────────────────

describe('renderStatusTableMarkdown – malformed inputs', () => {
  it('returns empty string for null', () => {
    expect(renderStatusTableMarkdown(null)).toBe('');
  });

  it('returns empty string for non-object', () => {
    expect(renderStatusTableMarkdown('string')).toBe('');
    expect(renderStatusTableMarkdown(42)).toBe('');
  });

  it('returns empty string when rows/headers arrays are missing', () => {
    expect(renderStatusTableMarkdown({ somethingElse: true })).toBe('');
  });

  it('returns empty string when rows array exists but is empty', () => {
    expect(renderStatusTableMarkdown({ headers: ['Status', 'Description'], rows: [] })).toBe('');
  });

  it('returns empty string when headers array exists but is empty', () => {
    expect(renderStatusTableMarkdown({ headers: [], rows: [['Active', 'In use']] })).toBe('');
  });

  it('renders a table when headers and rows are valid', () => {
    const md = renderStatusTableMarkdown({ headers: ['Status', 'Description'], rows: [['Active', 'In use']] });
    expect(md).toContain('| Status | Description |');
    expect(md).toContain('| Active | In use |');
  });

  it('does not throw for rows with unexpected value shapes', () => {
    expect(() => renderStatusTableMarkdown({ headers: ['A', 'B'], rows: [[null, undefined], [{ obj: true }, [1, 2]]] })).not.toThrow();
  });
});

// ─── STATUS_TABLE resource diagnostic accounting ──────────────────────────────

describe('STATUS_TABLE resource diagnostic accounting', () => {
  async function renderChunk(resource: unknown) {
    const diag = emptyPageDiagnostic();
    const chunk = { libraryModuleType: 'STATUS_TABLE', resourceName: 'some/resource' };
    await renderDsdbResourceChunk(chunk, async () => resource, diag);
    return diag;
  }

  it('increments statusTablesRequested when status table is requested', async () => {
    const diag = await renderChunk(null);
    expect(diag.statusTablesRequested).toBe(1);
  });

  it('does NOT increment statusTablesResolved when resource is missing', async () => {
    const diag = await renderChunk(null);
    expect(diag.statusTablesResolved).toBe(0);
  });

  it('increments statusTablesResolved when resource exists, even if schema is unsupported', async () => {
    const diag = await renderChunk({ unsupportedShape: true });
    expect(diag.statusTablesResolved).toBe(1);
  });

  it('increments statusTablesRendered only when a markdown table is produced', async () => {
    const validResource = { headers: ['Status', 'Description'], rows: [['Active', 'In use']] };
    const diag = await renderChunk(validResource);
    expect(diag.statusTablesRendered).toBe(1);
    expect(diag.statusTablesRenderedAsPlaceholder).toBe(0);
  });

  it('does NOT increment statusTablesRendered when schema is unsupported', async () => {
    const diag = await renderChunk({ unsupportedShape: true });
    expect(diag.statusTablesRendered).toBe(0);
    expect(diag.statusTablesRenderedAsPlaceholder).toBe(1);
  });

  it('increments unsupportedStatusTableSchemaCount when resource exists but schema fails', async () => {
    const diag = await renderChunk({ unsupportedShape: true });
    expect(diag.unsupportedStatusTableSchemaCount).toBe(1);
  });

  it('does NOT increment unsupportedStatusTableSchemaCount when resource is missing', async () => {
    const diag = await renderChunk(null);
    expect(diag.unsupportedStatusTableSchemaCount).toBe(0);
  });

  it('renders a placeholder and diagnostic, not a raw TypeError, for missing resource', async () => {
    const chunk = { libraryModuleType: 'STATUS_TABLE', resourceName: 'some/resource' };
    const diag = emptyPageDiagnostic();
    const result = await renderDsdbResourceChunk(chunk, async () => null, diag);
    expect(result).toContain('Material resource placeholder');
    expect(result).toContain('STATUS_TABLE');
    expect(diag.statusTablesRenderedAsPlaceholder).toBe(1);
  });
});

// ─── TOKEN_TABLE resource robustness ─────────────────────────────────────────

describe('TOKEN_TABLE resource chunk – malformed resource payloads', () => {
  const tokenChunk = {
    libraryModuleType: 'TOKEN_TABLE',
    resourceName: 'designSystems/ds/components/cmp',
    moduleConfiguration: { tokenSets: ['Divider - Common'] }
  };

  async function renderTokenChunk(resource: unknown) {
    const diag = emptyPageDiagnostic();
    const result = await renderDsdbResourceChunk(tokenChunk, async () => resource, diag);
    return { result, diag };
  }

  it('produces a placeholder and diagnostic when resource is null (missing)', async () => {
    const { result, diag } = await renderTokenChunk(null);
    expect(result).toContain('Material resource placeholder');
    expect(diag.unresolvedResourceCount).toBeGreaterThan(0);
  });

  it('produces a placeholder when resource exists but has no system field', async () => {
    const { result } = await renderTokenChunk({ someOtherField: true });
    expect(result).toContain('Material resource placeholder');
  });

  it('produces a placeholder when system.tokenSets is missing', async () => {
    const { result } = await renderTokenChunk({ system: { tokens: [] } });
    expect(result).toContain('Material resource placeholder');
  });

  it('does not throw TypeError when system.tokenSets is not an array', async () => {
    const { result } = await renderTokenChunk({ system: { tokenSets: 'invalid', tokens: [] } });
    // Should produce a placeholder, not a thrown error
    expect(typeof result).toBe('string');
  });

  it('does not throw TypeError when system.tokens is missing', async () => {
    const { result } = await renderTokenChunk({ system: { tokenSets: [{ name: 'ds/ts', displayName: 'Divider - Common', tokenSetName: 'md.comp.divider' }] } });
    expect(typeof result).toBe('string');
  });

  it('does not throw TypeError when contextualReferenceTrees is missing', async () => {
    const { result } = await renderTokenChunk({
      system: {
        tokens: [{ name: 'ds/ts/tok', tokenName: 'md.tok', displayName: 'Tok', tokenValueType: 'COLOR', state: 'ACTIVE' }],
        tokenSets: [{ name: 'ds/ts', displayName: 'Divider - Common', tokenSetName: 'md.comp.divider' }]
        // no contextualReferenceTrees
      }
    });
    expect(typeof result).toBe('string');
  });

  it('does not throw TypeError when token name is undefined/null in tokens array', async () => {
    const resource = {
      system: {
        tokens: [
          { name: null, tokenName: 'md.tok', displayName: 'Tok', tokenValueType: 'COLOR', state: 'ACTIVE' },
          undefined,
          { name: 'ds/ts/tok2', tokenName: 'md.tok2', displayName: 'Tok2', tokenValueType: 'COLOR', state: 'ACTIVE' }
        ],
        tokenSets: [{ name: 'ds/ts', displayName: 'Divider - Common', tokenSetName: 'md.comp.divider' }],
        contextualReferenceTrees: {}
      }
    };
    const { result } = await renderTokenChunk(resource);
    expect(typeof result).toBe('string');
  });

  it('renders valid table for fully valid resource without throwing', async () => {
    const resource = { system: VALID_TOKEN_SYSTEM };
    const chunk = {
      libraryModuleType: 'TOKEN_TABLE',
      resourceName: 'designSystems/ds/components/cmp',
      moduleConfiguration: { tokenSets: ['Divider - Common'] }
    };
    const diag = emptyPageDiagnostic();
    const result = await renderDsdbResourceChunk(chunk, async () => resource, diag);
    expect(result).toContain('### Divider - Common');
    expect(diag.tokenTablesRendered).toBe(1);
    expect(typeof result).toBe('string');
  });

  it('aggregate counters are correct and not doubled for malformed resource', async () => {
    const { diag } = await renderTokenChunk({ system: { tokenSets: null, tokens: null } });
    expect(diag.tokenTables).toBe(1);
    expect(diag.tokenTablesRendered).toBe(0);
    expect(diag.unresolvedResourceCount).toBeGreaterThan(0);
  });
});

// ─── normalizeResolvedValue – non-object shapes ───────────────────────────────

describe('normalizeTokenTableSystem – non-object resolvedValue in contextual tree', () => {
  it('normalizes string resolvedValue to empty object – does not throw', () => {
    const result = normalizeTokenTableSystem({
      tokens: [{ name: 'ds/tok', tokenName: 'md.tok', displayName: 'Tok', tokenValueType: 'COLOR', state: 'ACTIVE' }],
      tokenSets: [{ name: 'ds/ts', displayName: 'Set', tokenSetName: 'md.set' }],
      contextualReferenceTrees: {
        'ds/tok': {
          contextualReferenceTree: [
            { contextTags: ['ds/tags/light'], referenceTree: { tokenName: 'md.tok' }, resolvedValue: 'not-an-object' },
            { contextTags: ['ds/tags/dark'], referenceTree: { tokenName: 'md.tok' }, resolvedValue: 42 }
          ]
        }
      }
    });
    expect(result).not.toBeNull();
    const entry = result!.contextualReferenceTrees['ds/tok']!.contextualReferenceTree[0]!;
    expect(typeof entry.resolvedValue).toBe('object');
    expect(entry.resolvedValue).toEqual({});
  });

  it('normalizes null resolvedValue to empty object', () => {
    const result = normalizeTokenTableSystem({
      tokens: [{ name: 'ds/tok', tokenName: 'md.tok', displayName: 'Tok', tokenValueType: 'COLOR', state: 'ACTIVE' }],
      tokenSets: [{ name: 'ds/ts', displayName: 'Set', tokenSetName: 'md.set' }],
      contextualReferenceTrees: {
        'ds/tok': {
          contextualReferenceTree: [
            { contextTags: ['ds/tags/light'], referenceTree: { tokenName: 'md.tok' }, resolvedValue: null }
          ]
        }
      }
    });
    expect(result).not.toBeNull();
    expect(result!.contextualReferenceTrees['ds/tok']!.contextualReferenceTree[0]!.resolvedValue).toEqual({});
  });

  it('does not throw when rendering token table with non-object resolvedValues', () => {
    const system = normalizeTokenTableSystem({
      ...VALID_TOKEN_SYSTEM,
      contextualReferenceTrees: {
        'designSystems/ds/tokenSets/ts/tokens/tok1': {
          contextualReferenceTree: [
            { contextTags: ['ds/tags/light'], referenceTree: { tokenName: 'md.tok' }, resolvedValue: 'bad' },
            { contextTags: ['ds/tags/dark'], referenceTree: { tokenName: 'md.tok' }, resolvedValue: [1, 2, 3] }
          ]
        }
      }
    })!;
    expect(() => renderTokenTableWithDiagnostics(system, ['Divider - Common'])).not.toThrow();
  });
});

// ─── STATUS_TABLE placeholder content ────────────────────────────────────────

describe('STATUS_TABLE placeholder content and diagnostic structure', () => {
  it('placeholder includes resource name and reason when resource is missing', async () => {
    const chunk = { libraryModuleType: 'STATUS_TABLE', resourceName: 'design/system/status/comp-123' };
    const diag = emptyPageDiagnostic();
    const result = await renderDsdbResourceChunk(chunk, async () => null, diag);
    expect(result).toContain('missing-status-table-resource');
    expect(result).toContain('design/system/status/comp-123');
  });

  it('placeholder includes resource name and reason when schema is unsupported', async () => {
    const chunk = { libraryModuleType: 'STATUS_TABLE', resourceName: 'design/system/status/comp-123' };
    const diag = emptyPageDiagnostic();
    const result = await renderDsdbResourceChunk(chunk, async () => ({ unknownShape: true }), diag);
    expect(result).toContain('unknown-status-table-schema');
    expect(result).toContain('design/system/status/comp-123');
  });

  it('statusTableDiagnostics contains structured entry with resource info for missing resource', async () => {
    const chunk = { libraryModuleType: 'STATUS_TABLE', resourceName: 'design/status/resource' };
    const diag = emptyPageDiagnostic();
    await renderDsdbResourceChunk(chunk, async () => null, diag);
    expect(diag.statusTableDiagnostics).toBeDefined();
    const entry = diag.statusTableDiagnostics![0]!;
    expect(entry.resourceName).toBe('design/status/resource');
    expect(entry.requested).toBe(true);
    expect(entry.resolved).toBe(false);
    expect(entry.rendered).toBe(false);
    expect(entry.renderedAsPlaceholder).toBe(true);
    expect(entry.unsupportedSchema).toBe(false);
  });

  it('statusTableDiagnostics contains structured entry for unsupported schema', async () => {
    const chunk = { libraryModuleType: 'STATUS_TABLE', resourceName: 'design/status/resource' };
    const diag = emptyPageDiagnostic();
    await renderDsdbResourceChunk(chunk, async () => ({ unknownShape: true }), diag);
    const entry = diag.statusTableDiagnostics![0]!;
    expect(entry.resolved).toBe(true);
    expect(entry.rendered).toBe(false);
    expect(entry.unsupportedSchema).toBe(true);
  });

  it('statusTableDiagnostics contains structured entry for successful render', async () => {
    const chunk = { libraryModuleType: 'STATUS_TABLE', resourceName: 'design/status/resource' };
    const diag = emptyPageDiagnostic();
    await renderDsdbResourceChunk(chunk, async () => ({ headers: ['Status', 'Notes'], rows: [['Active', 'OK']] }), diag);
    const entry = diag.statusTableDiagnostics![0]!;
    expect(entry.resolved).toBe(true);
    expect(entry.rendered).toBe(true);
    expect(entry.renderedAsPlaceholder).toBe(false);
    expect(entry.unsupportedSchema).toBe(false);
  });
});

// ─── Content page extraction with malformed resources ─────────────────────────

describe('extractContentPageToMaterialPage – malformed token/status resources', () => {
  const baseUrl = 'https://m3.material.io/components/divider/specs';

  it('produces placeholder markdown and correct diagnostics when TOKEN_TABLE resource has invalid system', async () => {
    const contentPage = {
      title: 'Divider specs',
      sections: [{
        name: 'Specifications',
        contentBlocks: [{
          contentChunks: [{
            contentChunkType: 'RESOURCE',
            libraryModuleType: 'TOKEN_TABLE',
            resourceName: 'designSystems/ds/components/divider',
            moduleConfiguration: { tokenSets: ['Divider - Common'] }
          }]
        }]
      }]
    };
    const result = await extractContentPageToMaterialPage({
      url: baseUrl,
      pageData: null,
      contentPage,
      fetchResource: async () => ({ system: { tokenSets: 'not-an-array', tokens: null } })
    });
    expect(result.page.markdown).toContain('Material resource placeholder');
    expect(result.pageDiagnostic.tokenTables).toBe(1);
    expect(result.pageDiagnostic.tokenTablesRendered).toBe(0);
    expect(result.pageDiagnostic.unresolvedResourceCount).toBeGreaterThan(0);
  });

  it('produces placeholder markdown when STATUS_TABLE resource is missing', async () => {
    const contentPage = {
      title: 'Divider specs',
      sections: [{
        name: 'Status',
        contentBlocks: [{
          contentChunks: [{
            contentChunkType: 'RESOURCE',
            libraryModuleType: 'STATUS_TABLE',
            resourceName: 'design/status/divider'
          }]
        }]
      }]
    };
    const result = await extractContentPageToMaterialPage({
      url: baseUrl,
      pageData: null,
      contentPage,
      fetchResource: async () => null
    });
    expect(result.page.markdown).toContain('Material resource placeholder');
    expect(result.pageDiagnostic.statusTablesRequested).toBe(1);
    expect(result.pageDiagnostic.statusTablesResolved).toBe(0);
    expect(result.pageDiagnostic.statusTablesRenderedAsPlaceholder).toBe(1);
  });

  it('does not throw TypeError and produces placeholder for mixed malformed resources', async () => {
    const contentPage = {
      title: 'Component specs',
      sections: [{
        name: 'Tokens',
        contentBlocks: [{
          contentChunks: [
            {
              contentChunkType: 'RESOURCE',
              libraryModuleType: 'TOKEN_TABLE',
              resourceName: 'designSystems/ds/components/cmp',
              moduleConfiguration: { tokenSets: ['Component - Common'] }
            },
            {
              contentChunkType: 'RESOURCE',
              libraryModuleType: 'STATUS_TABLE',
              resourceName: 'design/status/cmp'
            }
          ]
        }]
      }]
    };
    const result = await extractContentPageToMaterialPage({
      url: 'https://m3.material.io/components/button/specs',
      pageData: null,
      contentPage,
      fetchResource: async (_name: string, type?: string) => {
        if (type === 'TOKEN_TABLE') return { system: { tokens: undefined, tokenSets: undefined } };
        if (type === 'STATUS_TABLE') return { weirdShape: true };
        return null;
      }
    });
    expect(typeof result.page.markdown).toBe('string');
    expect(result.page.markdown).toContain('Material resource placeholder');
    expect(result.pageDiagnostic.tokenTables).toBe(1);
    expect(result.pageDiagnostic.statusTablesRequested).toBe(1);
    expect(result.pageDiagnostic.statusTablesResolved).toBe(1);
    expect(result.pageDiagnostic.unsupportedStatusTableSchemaCount).toBe(1);
  });
});
