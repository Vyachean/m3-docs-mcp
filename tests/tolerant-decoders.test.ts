import { describe, expect, it } from 'vitest';
import { normalizeTokenTableSystem, renderTokenTableWithDiagnostics, renderStatusTableMarkdown } from '../src/json-extraction/render-markdown.js';
import { decodeResourceChunk, renderDsdbResourceChunk } from '../src/json-extraction/extract-dsdb-resource.js';
import { extractContentPageToMaterialPage } from '../src/json-extraction/extract-content-page.js';
import { parseStatusTable, decodeStatusTableResource } from '../src/json-extraction/schemas.js';
import type { ExtractionPageDiagnostic } from '../src/types.js';

// Routes observed failing in the wild with: Cannot read properties of undefined (reading 'slice')
const FAILING_SPECS_ROUTES = [
  'https://m3.material.io/components/app-bars/specs',
  'https://m3.material.io/components/badges/specs',
  'https://m3.material.io/components/bottom-sheets/specs',
  'https://m3.material.io/components/button-groups/specs',
  'https://m3.material.io/components/buttons/specs',
  'https://m3.material.io/components/cards/specs',
  'https://m3.material.io/components/carousel/specs',
];

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

  it('renders all available token sets when displayTokenSets list is empty', () => {
    const system = normalizeTokenTableSystem(VALID_TOKEN_SYSTEM)!;
    const { markdown } = renderTokenTableWithDiagnostics(system, []);
    expect(markdown).toContain('## Design Tokens');
    expect(markdown).toContain('### Divider - Common');
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
// Renderer only accepts DecodedStatusTable — decode first with parseStatusTable.

describe('renderStatusTableMarkdown – accepts only decoded status table', () => {
  it('renders a table for a valid decoded status table', () => {
    const decoded = parseStatusTable({ headers: ['Status', 'Description'], rows: [['Active', 'In use']] })!;
    expect(decoded).not.toBeNull();
    const md = renderStatusTableMarkdown(decoded);
    expect(md).toContain('| Status | Description |');
    expect(md).toContain('| Active | In use |');
  });

  it('renders multi-row tables correctly', () => {
    const decoded = parseStatusTable({
      headers: ['Component', 'Status', 'Notes'],
      rows: [['Button', 'Stable', 'OK'], ['Chip', 'Beta', 'WIP']]
    })!;
    const md = renderStatusTableMarkdown(decoded);
    expect(md).toContain('| Button |');
    expect(md).toContain('| Chip |');
  });
});

// ─── decodeStatusTableResource – decoder for raw status table resources ───────

describe('decodeStatusTableResource – decoder boundary', () => {
  it('returns UnsupportedStatusTable for null', () => {
    const result = decodeStatusTableResource(null);
    expect('_unsupported' in result && result._unsupported).toBe(true);
  });

  it('returns UnsupportedStatusTable for non-object', () => {
    const result = decodeStatusTableResource('string');
    expect('_unsupported' in result && result._unsupported).toBe(true);
  });

  it('returns UnsupportedStatusTable when rows/headers arrays are missing', () => {
    const result = decodeStatusTableResource({ somethingElse: true });
    expect('_unsupported' in result && result._unsupported).toBe(true);
  });

  it('returns UnsupportedStatusTable when rows array is empty', () => {
    const result = decodeStatusTableResource({ headers: ['Status', 'Description'], rows: [] });
    expect('_unsupported' in result && result._unsupported).toBe(true);
  });

  it('returns UnsupportedStatusTable when headers array is empty', () => {
    const result = decodeStatusTableResource({ headers: [], rows: [['Active', 'In use']] });
    expect('_unsupported' in result && result._unsupported).toBe(true);
  });

  it('returns DecodedStatusTable for valid input', () => {
    const result = decodeStatusTableResource({ headers: ['Status', 'Description'], rows: [['Active', 'In use']] });
    expect('_unsupported' in result).toBe(false);
    if (!('_unsupported' in result)) {
      expect(result.headers).toEqual(['Status', 'Description']);
      expect(result.rows).toEqual([['Active', 'In use']]);
    }
  });

  it('does not throw for rows with unexpected value shapes', () => {
    expect(() => decodeStatusTableResource({ headers: ['A', 'B'], rows: [[null, undefined], [{ obj: true }, [1, 2]]] })).not.toThrow();
  });
});

// ─── decodeResourceChunk – decoder for raw resource chunks ───────────────────

describe('decodeResourceChunk – malformed resource chunks', () => {
  it('returns DecodedResourceChunk for a valid chunk object', () => {
    const result = decodeResourceChunk({ libraryModuleType: 'TOKEN_TABLE', resourceName: 'some/resource' });
    expect('_unsupported' in result).toBe(false);
    if (!('_unsupported' in result)) {
      expect(result.libraryModuleType).toBe('TOKEN_TABLE');
    }
  });

  it('returns UnsupportedResourceChunk for a non-object (string)', () => {
    const result = decodeResourceChunk('not-an-object');
    expect('_unsupported' in result && result._unsupported).toBe(true);
  });

  it('returns UnsupportedResourceChunk for a non-object (null)', () => {
    const result = decodeResourceChunk(null);
    expect('_unsupported' in result && result._unsupported).toBe(true);
  });

  it('returns UnsupportedResourceChunk for a non-object (number)', () => {
    const result = decodeResourceChunk(42);
    expect('_unsupported' in result && result._unsupported).toBe(true);
  });

  it('includes issue messages in UnsupportedResourceChunk', () => {
    const result = decodeResourceChunk('bad');
    if ('_unsupported' in result && result._unsupported) {
      expect(Array.isArray(result.issues)).toBe(true);
    }
  });

  it('renderer cannot be called with raw unknown – decodeResourceChunk is the boundary', () => {
    // This test documents the boundary: callers must decode first, then render.
    // The type system enforces this; renderDsdbResourceChunk no longer accepts unknown.
    const decoded = decodeResourceChunk({ libraryModuleType: 'UNKNOWN_RESOURCE' });
    expect(decoded).toBeDefined();
  });
});

// ─── STATUS_TABLE resource diagnostic accounting ──────────────────────────────

describe('STATUS_TABLE resource diagnostic accounting', () => {
  async function renderChunk(resource: unknown) {
    const diag = emptyPageDiagnostic();
    const chunk = decodeResourceChunk({ libraryModuleType: 'STATUS_TABLE', resourceName: 'some/resource' });
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
    const chunk = decodeResourceChunk({ libraryModuleType: 'STATUS_TABLE', resourceName: 'some/resource' });
    const diag = emptyPageDiagnostic();
    const result = await renderDsdbResourceChunk(chunk, async () => null, diag);
    expect(result).toContain('Material resource placeholder');
    expect(result).toContain('STATUS_TABLE');
    expect(diag.statusTablesRenderedAsPlaceholder).toBe(1);
  });
});

// ─── TOKEN_TABLE resource robustness ─────────────────────────────────────────

describe('TOKEN_TABLE resource chunk – malformed resource payloads', () => {
  const tokenChunkDecoded = decodeResourceChunk({
    libraryModuleType: 'TOKEN_TABLE',
    resourceName: 'designSystems/ds/components/cmp',
    moduleConfiguration: { tokenSets: ['Divider - Common'] }
  });

  async function renderTokenChunk(resource: unknown) {
    const diag = emptyPageDiagnostic();
    const result = await renderDsdbResourceChunk(tokenChunkDecoded, async () => resource, diag);
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
    const chunk = decodeResourceChunk({
      libraryModuleType: 'TOKEN_TABLE',
      resourceName: 'designSystems/ds/components/cmp',
      moduleConfiguration: { tokenSets: ['Divider - Common'] }
    });
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
    const chunk = decodeResourceChunk({ libraryModuleType: 'STATUS_TABLE', resourceName: 'design/system/status/comp-123' });
    const diag = emptyPageDiagnostic();
    const result = await renderDsdbResourceChunk(chunk, async () => null, diag);
    expect(result).toContain('missing-status-table-resource');
    expect(result).toContain('design/system/status/comp-123');
  });

  it('placeholder includes resource name and reason when schema is unsupported', async () => {
    const chunk = decodeResourceChunk({ libraryModuleType: 'STATUS_TABLE', resourceName: 'design/system/status/comp-123' });
    const diag = emptyPageDiagnostic();
    const result = await renderDsdbResourceChunk(chunk, async () => ({ unknownShape: true }), diag);
    expect(result).toContain('unknown-status-table-schema');
    expect(result).toContain('design/system/status/comp-123');
  });

  it('statusTableDiagnostics contains structured entry with resource info for missing resource', async () => {
    const chunk = decodeResourceChunk({ libraryModuleType: 'STATUS_TABLE', resourceName: 'design/status/resource' });
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
    const chunk = decodeResourceChunk({ libraryModuleType: 'STATUS_TABLE', resourceName: 'design/status/resource' });
    const diag = emptyPageDiagnostic();
    await renderDsdbResourceChunk(chunk, async () => ({ unknownShape: true }), diag);
    const entry = diag.statusTableDiagnostics![0]!;
    expect(entry.resolved).toBe(true);
    expect(entry.rendered).toBe(false);
    expect(entry.unsupportedSchema).toBe(true);
  });

  it('statusTableDiagnostics contains structured entry for successful render', async () => {
    const chunk = decodeResourceChunk({ libraryModuleType: 'STATUS_TABLE', resourceName: 'design/status/resource' });
    const diag = emptyPageDiagnostic();
    await renderDsdbResourceChunk(chunk, async () => ({ headers: ['Status', 'Notes'], rows: [['Active', 'OK']] }), diag);
    const entry = diag.statusTableDiagnostics![0]!;
    expect(entry.resolved).toBe(true);
    expect(entry.rendered).toBe(true);
    expect(entry.renderedAsPlaceholder).toBe(false);
    expect(entry.unsupportedSchema).toBe(false);
  });
});

// ─── extractTokenTableSystem – nested payload.system fallback ─────────────────

describe('extractTokenTableSystem – nested payload.system fallback', () => {
  const tokenChunkDecoded2 = decodeResourceChunk({
    libraryModuleType: 'TOKEN_TABLE',
    resourceName: 'designSystems/ds/components/cmp',
    moduleConfiguration: { tokenSets: ['Divider - Common'] }
  });

  async function renderTokenChunk(resource: unknown) {
    const diag = emptyPageDiagnostic();
    const result = await renderDsdbResourceChunk(tokenChunkDecoded2, async () => resource, diag);
    return { result, diag };
  }

  it('uses nested payload.system when direct system is invalid (null tokens/tokenSets)', async () => {
    const resource = {
      system: { tokens: null, tokenSets: null },
      payload: { system: VALID_TOKEN_SYSTEM }
    };
    const { result, diag } = await renderTokenChunk(resource);
    expect(result).toContain('### Divider - Common');
    expect(diag.tokenTablesRendered).toBe(1);
  });

  it('uses nested payload.system when direct system is an empty object (no tokens/tokenSets)', async () => {
    const resource = {
      system: {},
      payload: { system: VALID_TOKEN_SYSTEM }
    };
    const { result, diag } = await renderTokenChunk(resource);
    expect(result).toContain('### Divider - Common');
    expect(diag.tokenTablesRendered).toBe(1);
  });

  it('prefers valid direct system over nested payload.system', async () => {
    const resource = {
      system: VALID_TOKEN_SYSTEM,
      payload: { system: { tokens: null, tokenSets: null } }
    };
    const { result, diag } = await renderTokenChunk(resource);
    expect(result).toContain('### Divider - Common');
    expect(diag.tokenTablesRendered).toBe(1);
  });

  it('returns placeholder when both direct and nested systems are invalid', async () => {
    const resource = {
      system: { tokens: null, tokenSets: null },
      payload: { system: { tokens: [], tokenSets: [] } }
    };
    const { result, diag } = await renderTokenChunk(resource);
    expect(result).toContain('Material resource placeholder');
    expect(diag.tokenTablesRendered).toBe(0);
    expect(diag.unresolvedResourceCount).toBeGreaterThan(0);
  });
});

// ─── normalizeTokenSetItem – reject empty/missing names ──────────────────────

describe('normalizeTokenSetItem – empty and missing names', () => {
  it('drops token set with missing name field', () => {
    const result = normalizeTokenTableSystem({
      tokens: [{ name: 'ds/ts/tok', tokenName: 'md.tok', displayName: 'Tok', tokenValueType: 'COLOR', state: 'ACTIVE' }],
      tokenSets: [{ displayName: 'Nameless Set', tokenSetName: 'md.nameless' }]
    });
    expect(result).not.toBeNull();
    expect(result!.tokenSets).toHaveLength(0);
  });

  it('drops token set with empty string name', () => {
    const result = normalizeTokenTableSystem({
      tokens: [{ name: 'ds/ts/tok', tokenName: 'md.tok', displayName: 'Tok', tokenValueType: 'COLOR', state: 'ACTIVE' }],
      tokenSets: [{ name: '', displayName: 'Empty Name', tokenSetName: 'md.empty' }]
    });
    expect(result).not.toBeNull();
    expect(result!.tokenSets).toHaveLength(0);
  });

  it('drops token set with whitespace-only name', () => {
    const result = normalizeTokenTableSystem({
      tokens: [{ name: 'ds/ts/tok', tokenName: 'md.tok', displayName: 'Tok', tokenValueType: 'COLOR', state: 'ACTIVE' }],
      tokenSets: [{ name: '   ', displayName: 'Whitespace Name', tokenSetName: 'md.ws' }]
    });
    expect(result).not.toBeNull();
    expect(result!.tokenSets).toHaveLength(0);
  });

  it('nameless token set must not match every token via startsWith("")', () => {
    const result = normalizeTokenTableSystem({
      tokens: [{ name: 'designSystems/ds/tok', tokenName: 'md.tok', displayName: 'Tok', tokenValueType: 'COLOR', state: 'ACTIVE' }],
      tokenSets: [
        { displayName: 'Nameless Set', tokenSetName: 'md.nameless' },
        { name: 'designSystems/ds/ts', displayName: 'Named Set', tokenSetName: 'md.named' }
      ]
    })!;
    expect(result).not.toBeNull();
    const { markdown } = renderTokenTableWithDiagnostics(result, ['Nameless Set']);
    expect(markdown).toBe('');
  });

  it('does not throw when rendering a system that had nameless token sets dropped', () => {
    const result = normalizeTokenTableSystem({
      tokens: [{ name: 'designSystems/ds/tokenSets/ts/tokens/tok1', tokenName: 'md.tok', displayName: 'Tok', tokenValueType: 'COLOR', state: 'ACTIVE' }],
      tokenSets: [
        { name: null, displayName: 'Null Name', tokenSetName: 'md.null' },
        { name: '  ', displayName: 'Whitespace', tokenSetName: 'md.ws' },
        { name: 'designSystems/ds/tokenSets/ts', displayName: 'Good Set', tokenSetName: 'md.good' }
      ],
      contextualReferenceTrees: {}
    })!;
    expect(result).not.toBeNull();
    expect(result.tokenSets).toHaveLength(1);
    expect(result.tokenSets[0]!.name).toBe('designSystems/ds/tokenSets/ts');
    expect(() => renderTokenTableWithDiagnostics(result, ['Good Set'])).not.toThrow();
  });
});

// ─── parseTokenTableSystem – zod boundary smoke tests ────────────────────────

import { parseTokenTableSystem, parseContentPage } from '../src/json-extraction/schemas.js';

describe('parseTokenTableSystem – zod boundary', () => {
  it('returns null for null/undefined', () => {
    expect(parseTokenTableSystem(null)).toBeNull();
    expect(parseTokenTableSystem(undefined)).toBeNull();
  });

  it('returns null for primitives', () => {
    expect(parseTokenTableSystem(42)).toBeNull();
    expect(parseTokenTableSystem('string')).toBeNull();
    expect(parseTokenTableSystem(true)).toBeNull();
  });

  it('returns null for arrays', () => {
    expect(parseTokenTableSystem([])).toBeNull();
  });

  it('returns null when both tokens and tokenSets are empty after normalization', () => {
    expect(parseTokenTableSystem({ tokens: [], tokenSets: [] })).toBeNull();
    expect(parseTokenTableSystem({ tokens: null, tokenSets: null })).toBeNull();
  });

  it('rejects token set with null name', () => {
    const result = parseTokenTableSystem({
      tokens: [{ name: 'ds/tok', tokenName: 'md.tok', displayName: 'Tok', tokenValueType: 'COLOR', state: 'ACTIVE' }],
      tokenSets: [{ name: null, displayName: 'Null Name', tokenSetName: 'md.null' }]
    });
    expect(result).not.toBeNull();
    expect(result!.tokenSets).toHaveLength(0);
  });

  it('rejects token set with empty-string name', () => {
    const result = parseTokenTableSystem({
      tokens: [{ name: 'ds/tok', tokenName: 'md.tok', displayName: 'Tok', tokenValueType: 'COLOR', state: 'ACTIVE' }],
      tokenSets: [{ name: '', displayName: 'Empty', tokenSetName: 'md.empty' }]
    });
    expect(result!.tokenSets).toHaveLength(0);
  });

  it('rejects token set with whitespace-only name', () => {
    const result = parseTokenTableSystem({
      tokens: [{ name: 'ds/tok', tokenName: 'md.tok', displayName: 'Tok', tokenValueType: 'COLOR', state: 'ACTIVE' }],
      tokenSets: [{ name: '   ', displayName: 'WS', tokenSetName: 'md.ws' }]
    });
    expect(result!.tokenSets).toHaveLength(0);
  });

  it('rejects token entry with null name – avoids undefined.startsWith crash', () => {
    const result = parseTokenTableSystem({
      tokens: [
        { name: null, tokenName: 'md.a', displayName: 'A', tokenValueType: 'COLOR', state: 'ACTIVE' },
        { name: 'ds/tok', tokenName: 'md.b', displayName: 'B', tokenValueType: 'COLOR', state: 'ACTIVE' }
      ],
      tokenSets: [{ name: 'ds/ts', displayName: 'Set', tokenSetName: 'md.set' }]
    });
    expect(result!.tokens).toHaveLength(1);
    expect(result!.tokens[0]!.name).toBe('ds/tok');
  });

  it('normalizes malformed tokens field (non-array) to empty array', () => {
    const result = parseTokenTableSystem({
      tokens: 'bad',
      tokenSets: [{ name: 'ds/ts', displayName: 'Set', tokenSetName: 'md.set' }]
    });
    expect(result).not.toBeNull();
    expect(result!.tokens).toEqual([]);
  });

  it('normalizes malformed tokenSets field (non-array) to empty array', () => {
    const result = parseTokenTableSystem({
      tokens: [{ name: 'ds/tok', tokenName: 'md.tok', displayName: 'Tok', tokenValueType: 'COLOR', state: 'ACTIVE' }],
      tokenSets: 42
    });
    expect(result!.tokenSets).toEqual([]);
  });

  it('normalizes malformed contextualReferenceTrees (non-object) to empty object', () => {
    const result = parseTokenTableSystem({
      tokens: [{ name: 'ds/tok', tokenName: 'md.tok', displayName: 'Tok', tokenValueType: 'COLOR', state: 'ACTIVE' }],
      tokenSets: [{ name: 'ds/ts', displayName: 'Set', tokenSetName: 'md.set' }],
      contextualReferenceTrees: 'invalid'
    });
    expect(result!.contextualReferenceTrees).toEqual({});
  });

  it('normalizes malformed contextual tree node children to empty array', () => {
    const result = parseTokenTableSystem({
      tokens: [{ name: 'ds/tok', tokenName: 'md.tok', displayName: 'Tok', tokenValueType: 'COLOR', state: 'ACTIVE' }],
      tokenSets: [{ name: 'ds/ts', displayName: 'Set', tokenSetName: 'md.set' }],
      contextualReferenceTrees: {
        'ds/tok': {
          contextualReferenceTree: [
            { contextTags: [], referenceTree: { tokenName: 'md.tok', childNodes: 'bad' }, resolvedValue: {} }
          ]
        }
      }
    });
    const refTree = result!.contextualReferenceTrees['ds/tok']!.contextualReferenceTree[0]!.referenceTree;
    expect(refTree.childNodes).toEqual([]);
  });

  it('does not expose undefined.slice class failure from referenceTree traversal', () => {
    const result = parseTokenTableSystem({
      tokens: [{ name: 'ds/ts/tok', tokenName: 'md.tok', displayName: 'Tok', tokenValueType: 'COLOR', state: 'ACTIVE' }],
      tokenSets: [{ name: 'ds/ts', displayName: 'Set', tokenSetName: 'md.set' }],
      contextualReferenceTrees: {
        'ds/ts/tok': {
          contextualReferenceTree: [
            {
              contextTags: [],
              referenceTree: null,  // would cause undefined.slice without normalization
              resolvedValue: {}
            }
          ]
        }
      }
    });
    expect(result).not.toBeNull();
    expect(() => {
      const tree = result!.contextualReferenceTrees['ds/ts/tok']!;
      const entry = tree.contextualReferenceTree[0]!;
      // This must not throw – childNodes must always be an array
      void entry.referenceTree.childNodes.slice();
    }).not.toThrow();
  });
});

// ─── parseStatusTable – zod boundary ─────────────────────────────────────────

describe('parseStatusTable – zod boundary', () => {
  it('returns null for null/non-object', () => {
    expect(parseStatusTable(null)).toBeNull();
    expect(parseStatusTable(42)).toBeNull();
    expect(parseStatusTable('string')).toBeNull();
  });

  it('returns null when headers and rows are missing', () => {
    expect(parseStatusTable({ other: true })).toBeNull();
  });

  it('returns null when rows are empty', () => {
    expect(parseStatusTable({ headers: ['A', 'B'], rows: [] })).toBeNull();
  });

  it('returns null when headers are empty', () => {
    expect(parseStatusTable({ headers: [], rows: [['a', 'b']] })).toBeNull();
  });

  it('returns decoded status table for valid shape', () => {
    const decoded = parseStatusTable({ headers: ['Status', 'Notes'], rows: [['Active', 'OK']] });
    expect(decoded).not.toBeNull();
    expect(decoded!.headers).toEqual(['Status', 'Notes']);
    expect(decoded!.rows).toEqual([['Active', 'OK']]);
  });

  it('reads headers from payload when missing at top level', () => {
    const decoded = parseStatusTable({
      payload: { headers: ['A', 'B'], rows: [['x', 'y']] }
    });
    expect(decoded).not.toBeNull();
    expect(decoded!.headers).toEqual(['A', 'B']);
  });

  it('handles rows with non-string values without throwing', () => {
    const decoded = parseStatusTable({
      headers: ['A', 'B'],
      rows: [[null, undefined], [{ obj: true }, [1, 2]]]
    });
    expect(decoded).not.toBeNull();
    expect(decoded!.rows.length).toBeGreaterThan(0);
  });

  it('inferred type has headers: string[] and rows: string[][]', () => {
    const decoded = parseStatusTable({ headers: ['H'], rows: [['v']] });
    // TypeScript compile-time check: access typed fields without assertion
    if (decoded) {
      const h: string[] = decoded.headers;
      const r: string[][] = decoded.rows;
      expect(h).toBeDefined();
      expect(r).toBeDefined();
    }
  });
});

// ─── parseContentPage – zod boundary ─────────────────────────────────────────

describe('parseContentPage – real-data regression: null optional chunk fields', () => {
  // Live m3.material.io content chunks set most optional string fields to explicit `null`
  // (footer: null, videoUrl: null, codeUrl: null, resourceName: null, ...) rather than omitting
  // them. ContentChunkSchema previously declared these as z.string().optional(), which rejects
  // `null` — causing every real chunk to fail safeParse and silently disappear, regardless of how
  // much real content the page had.
  it('parses a chunk whose unused optional fields are explicit null (real shape)', () => {
    const result = parseContentPage({
      title: 'Buttons',
      sections: [{
        name: 'Specs',
        contentBlocks: [{
          title: null,
          contentChunks: [{
            htmlValue: '<h2>Variants</h2>',
            footer: null,
            imageUrl: '',
            imageUrlFife: null,
            altText: '',
            videoUrl: null,
            codeUrl: null,
            prototypeUrl: null,
            resourceName: null,
            libraryModuleType: null,
            moduleConfigurationOverrides: null,
            contentChunkType: 'TEXT'
          }]
        }]
      }]
    });
    expect(result.sections[0]?.blocks[0]?.chunks).toHaveLength(1);
    expect(result.sections[0]?.blocks[0]?.chunks[0]?.htmlValue).toBe('<h2>Variants</h2>');
  });
});

describe('parseContentPage – zod boundary', () => {
  it('returns empty sections for null input', () => {
    const result = parseContentPage(null);
    expect(result.sections).toEqual([]);
    expect(result.title).toBeNull();
    expect(result.fallbackHtml).toBeNull();
  });

  it('exposes fallbackHtml from htmlValue field in decoded model', () => {
    const result = parseContentPage({ htmlValue: '<p>Hello from htmlValue</p>' });
    expect(result.fallbackHtml).toBe('<p>Hello from htmlValue</p>');
  });

  it('exposes fallbackHtml from body field when htmlValue is absent', () => {
    const result = parseContentPage({ body: '<p>Hello from body</p>' });
    expect(result.fallbackHtml).toBe('<p>Hello from body</p>');
  });

  it('exposes fallbackHtml from description field when htmlValue and body are absent', () => {
    const result = parseContentPage({ description: 'Some description text' });
    expect(result.fallbackHtml).toBe('Some description text');
  });

  it('prefers htmlValue over body and description', () => {
    const result = parseContentPage({ htmlValue: 'primary', body: 'secondary', description: 'tertiary' });
    expect(result.fallbackHtml).toBe('primary');
  });

  it('returns null fallbackHtml when none of the fallback fields are present', () => {
    const result = parseContentPage({ title: 'T', sections: [] });
    expect(result.fallbackHtml).toBeNull();
  });

  it('parses title from top-level title field', () => {
    const result = parseContentPage({ title: 'My Page', sections: [] });
    expect(result.title).toBe('My Page');
  });

  it('parses sections with contentBlocks and contentChunks', () => {
    const result = parseContentPage({
      title: 'Test',
      sections: [{
        name: 'Section 1',
        contentBlocks: [{
          contentChunks: [{ contentChunkType: 'TEXT', htmlValue: '<p>Hello</p>' }]
        }]
      }]
    });
    expect(result.sections).toHaveLength(1);
    expect(result.sections[0]!.title).toBe('Section 1');
    expect(result.sections[0]!.blocks[0]!.chunks[0]!.contentChunkType).toBe('TEXT');
    expect(result.sections[0]!.blocks[0]!.chunks[0]!.htmlValue).toBe('<p>Hello</p>');
  });

  it('drops hidden blocks', () => {
    const result = parseContentPage({
      title: 'Test',
      sections: [{
        name: 'S',
        contentBlocks: [
          { isHidden: true, contentChunks: [{ contentChunkType: 'TEXT', htmlValue: 'hidden' }] },
          { contentChunks: [{ contentChunkType: 'TEXT', htmlValue: 'visible' }] }
        ]
      }]
    });
    expect(result.sections[0]!.blocks).toHaveLength(1);
    expect(result.sections[0]!.blocks[0]!.chunks[0]!.htmlValue).toBe('visible');
  });

  it('drops invisible sections', () => {
    const result = parseContentPage({
      sections: [
        { name: 'Invisible', isVisible: false, contentBlocks: [] },
        { name: 'Visible', contentBlocks: [] }
      ]
    });
    expect(result.sections).toHaveLength(1);
    expect(result.sections[0]!.title).toBe('Visible');
  });

  it('returns empty sections for malformed sections field', () => {
    const result = parseContentPage({ title: 'T', sections: 'not-an-array' });
    expect(result.sections).toEqual([]);
  });

  it('handles malformed content chunk without throwing', () => {
    const result = parseContentPage({
      title: 'T',
      sections: [{
        name: 'S',
        contentBlocks: [{
          contentChunks: [null, undefined, 42, { contentChunkType: 'TEXT', htmlValue: 'ok' }]
        }]
      }]
    });
    // Only valid chunks make it through; null/undefined/42 are dropped
    const chunks = result.sections[0]!.blocks[0]!.chunks;
    expect(chunks.some((c) => c.contentChunkType === 'TEXT')).toBe(true);
  });

  it('decoded chunk fields have correct optional types (no raw external casts needed)', () => {
    const result = parseContentPage({
      title: 'T',
      sections: [{
        name: 'S',
        contentBlocks: [{
          contentChunks: [{
            contentChunkType: 'IMAGE',
            imageUrl: 'https://example.com/img.png',
            altText: 'An image',
            footer: 'Caption'
          }]
        }]
      }]
    });
    const chunk = result.sections[0]!.blocks[0]!.chunks[0]!;
    // TypeScript: these are typed as string | null | undefined, not unknown
    const url: string | null | undefined = chunk.imageUrl;
    const alt: string | null | undefined = chunk.altText;
    expect(url).toBe('https://example.com/img.png');
    expect(alt).toBe('An image');
  });
});

// ─── extractContentPageToMaterialPage – fallback text from decoded model ───────

describe('extractContentPageToMaterialPage – fallback text comes from decoded model', () => {
  const baseUrl = 'https://m3.material.io/foundations/overview';

  it('uses decoded fallbackHtml when there are no sections (htmlValue field)', async () => {
    const contentPage = { title: 'Overview', htmlValue: '<p>Decoded fallback content</p>' };
    const result = await extractContentPageToMaterialPage({
      url: baseUrl,
      pageData: null,
      contentPage,
      fetchResource: async () => null
    });
    expect(result.page.markdown).toContain('Decoded fallback content');
  });

  it('uses decoded fallbackHtml from body field when no sections', async () => {
    const contentPage = { title: 'Overview', body: '<p>Body fallback content</p>' };
    const result = await extractContentPageToMaterialPage({
      url: baseUrl,
      pageData: null,
      contentPage,
      fetchResource: async () => null
    });
    expect(result.page.markdown).toContain('Body fallback content');
  });

  it('does not use fallbackHtml when sections are present', async () => {
    const contentPage = {
      title: 'Overview',
      htmlValue: '<p>Should be ignored</p>',
      sections: [{
        name: 'Intro',
        contentBlocks: [{
          contentChunks: [{ contentChunkType: 'TEXT', htmlValue: '<p>Section content</p>' }]
        }]
      }]
    };
    const result = await extractContentPageToMaterialPage({
      url: baseUrl,
      pageData: null,
      contentPage,
      fetchResource: async () => null
    });
    expect(result.page.markdown).toContain('Section content');
    expect(result.page.markdown).not.toContain('Should be ignored');
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

// ─── Regression: specs page .slice crash ─────────────────────────────────────
//
// The crawler extracted the design-system-data attribute from token-viewer elements
// and passed raw JSON directly to renderTokenTableWithDiagnostics without zod
// normalization. Real-world specs pages can have contextTags: null inside
// contextualReferenceTree entries, causing `undefined.slice()` to throw.
//
// These tests verify that the extraction path is tolerant of those shapes and
// produces structured output (tokens or placeholders) instead of throwing.

describe('specs page regression – contextTags: null in raw design-system-data', () => {
  // Represents the shape of `design-system-data` attribute JSON from a specs page.
  // The `contextTags` field may be null instead of [] in real-world payloads.
  function makeSpecsSystemWithNullContextTags() {
    return {
      system: {
        tokens: [
          {
            name: 'designSystems/ds/tokenSets/ts/tokens/tok1',
            tokenName: 'md.comp.button.container.color',
            displayName: 'Container color',
            tokenValueType: 'COLOR',
            state: 'ACTIVE',
          },
        ],
        tokenSets: [{ name: 'designSystems/ds/tokenSets/ts', displayName: 'Button - Common', tokenSetName: 'md.comp.button' }],
        tags: [
          { name: 'ds/tags/light', displayName: 'Light', tagName: 'light' },
          { name: 'ds/tags/dark', displayName: 'Dark', tagName: 'dark' },
        ],
        contextTagGroups: [],
        contextualReferenceTrees: {
          'designSystems/ds/tokenSets/ts/tokens/tok1': {
            contextualReferenceTree: [
              // contextTags is null — the exact shape that caused the .slice crash
              {
                contextTags: null,
                referenceTree: { tokenName: 'md.comp.button.container.color', childNodes: [] },
                resolvedValue: { color: { red: 0.38, green: 0.0, blue: 0.93, alpha: 1 } },
              },
              {
                contextTags: null,
                referenceTree: { tokenName: 'md.comp.button.container.color', childNodes: [] },
                resolvedValue: { color: { red: 0.82, green: 0.68, blue: 1, alpha: 1 } },
              },
            ],
          },
        },
      },
    };
  }

  it('normalizeTokenTableSystem does not throw when contextTags is null', () => {
    const raw = makeSpecsSystemWithNullContextTags();
    expect(() => normalizeTokenTableSystem(raw.system)).not.toThrow();
  });

  it('normalizeTokenTableSystem normalizes null contextTags to empty array', () => {
    const raw = makeSpecsSystemWithNullContextTags();
    const system = normalizeTokenTableSystem(raw.system);
    expect(system).not.toBeNull();
    const tree = system!.contextualReferenceTrees['designSystems/ds/tokenSets/ts/tokens/tok1'];
    expect(tree).toBeDefined();
    // Each entry must have contextTags as [] after normalization, never null/undefined
    for (const entry of tree!.contextualReferenceTree) {
      expect(Array.isArray(entry.contextTags)).toBe(true);
    }
  });

  it('renderTokenTableWithDiagnostics does not throw when raw system had contextTags: null', () => {
    const raw = makeSpecsSystemWithNullContextTags();
    const system = normalizeTokenTableSystem(raw.system)!;
    expect(() => renderTokenTableWithDiagnostics(system, ['Button - Common'])).not.toThrow();
  });

  it('renderTokenTableWithDiagnostics returns string (not throws) – regression for undefined.slice', () => {
    const raw = makeSpecsSystemWithNullContextTags();
    const system = normalizeTokenTableSystem(raw.system)!;
    const { markdown } = renderTokenTableWithDiagnostics(system, ['Button - Common']);
    expect(typeof markdown).toBe('string');
  });

  it.each(FAILING_SPECS_ROUTES)(
    'extractContentPageToMaterialPage does not throw for %s with null contextTags in token resource',
    async (url) => {
      const rawSystem = makeSpecsSystemWithNullContextTags().system;
      const contentPage = {
        title: url.split('/').at(-2) ?? 'Component',
        sections: [
          {
            name: 'Specifications',
            contentBlocks: [
              {
                contentChunks: [
                  {
                    contentChunkType: 'RESOURCE',
                    libraryModuleType: 'TOKEN_TABLE',
                    resourceName: 'designSystems/ds/components/component',
                    moduleConfiguration: { tokenSets: ['Button - Common'] },
                  },
                ],
              },
            ],
          },
        ],
      };
      const result = await extractContentPageToMaterialPage({
        url,
        pageData: null,
        contentPage,
        fetchResource: async () => ({ system: rawSystem }),
      });
      expect(typeof result.page.markdown).toBe('string');
      // Must not throw; result is either tokens or a structured placeholder — never a raw TypeError
    }
  );
});

describe('specs page regression – contextTags: undefined in raw design-system-data', () => {
  function makeSpecsSystemWithUndefinedContextTags() {
    return {
      system: {
        tokens: [
          {
            name: 'designSystems/ds/tokenSets/ts/tokens/tok1',
            tokenName: 'md.comp.card.container.color',
            displayName: 'Card container color',
            tokenValueType: 'COLOR',
            state: 'ACTIVE',
          },
        ],
        tokenSets: [{ name: 'designSystems/ds/tokenSets/ts', displayName: 'Card - Common', tokenSetName: 'md.comp.card' }],
        tags: [],
        contextTagGroups: [],
        contextualReferenceTrees: {
          'designSystems/ds/tokenSets/ts/tokens/tok1': {
            // The whole contextualReferenceTree array is present but entries have no contextTags field
            contextualReferenceTree: [
              {
                referenceTree: { tokenName: 'md.comp.card.container.color', childNodes: [] },
                resolvedValue: { color: { red: 1, green: 1, blue: 1, alpha: 1 } },
              },
            ],
          },
        },
      },
    };
  }

  it('normalizeTokenTableSystem handles missing contextTags field (normalizes to [])', () => {
    const raw = makeSpecsSystemWithUndefinedContextTags();
    const system = normalizeTokenTableSystem(raw.system);
    expect(system).not.toBeNull();
    const tree = system!.contextualReferenceTrees['designSystems/ds/tokenSets/ts/tokens/tok1'];
    const entry = tree!.contextualReferenceTree[0]!;
    expect(Array.isArray(entry.contextTags)).toBe(true);
  });

  it('renderTokenTableWithDiagnostics does not throw when contextTags field was absent', () => {
    const raw = makeSpecsSystemWithUndefinedContextTags();
    const system = normalizeTokenTableSystem(raw.system)!;
    expect(() => renderTokenTableWithDiagnostics(system, ['Card - Common'])).not.toThrow();
  });
});

describe('specs page regression – passing raw (un-normalized) system to normalizeTokenTableSystem', () => {
  it('normalizeTokenTableSystem(raw.system) is safe for all real-world shapes with null contextTags', () => {
    const shapes = [
      // All entries have null contextTags
      {
        tokens: [{ name: 'ds/ts/tok', tokenName: 'md.tok', displayName: 'T', tokenValueType: 'COLOR', state: 'ACTIVE' }],
        tokenSets: [{ name: 'ds/ts', displayName: 'Set', tokenSetName: 'md.set' }],
        contextualReferenceTrees: {
          'ds/ts/tok': {
            contextualReferenceTree: [{ contextTags: null, referenceTree: { tokenName: 'md.tok' }, resolvedValue: {} }],
          },
        },
      },
      // Mixed null and valid contextTags in same tree
      {
        tokens: [{ name: 'ds/ts/tok', tokenName: 'md.tok', displayName: 'T', tokenValueType: 'COLOR', state: 'ACTIVE' }],
        tokenSets: [{ name: 'ds/ts', displayName: 'Set', tokenSetName: 'md.set' }],
        contextualReferenceTrees: {
          'ds/ts/tok': {
            contextualReferenceTree: [
              { contextTags: null, referenceTree: { tokenName: 'md.tok' }, resolvedValue: {} },
              { contextTags: ['ds/tags/light'], referenceTree: { tokenName: 'md.tok' }, resolvedValue: { v: 1 } },
            ],
          },
        },
      },
    ];
    for (const shape of shapes) {
      expect(() => normalizeTokenTableSystem(shape)).not.toThrow();
      const system = normalizeTokenTableSystem(shape);
      if (system) {
        expect(() => renderTokenTableWithDiagnostics(system, ['Set'])).not.toThrow();
      }
    }
  });
});
