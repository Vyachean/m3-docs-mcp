import { describe, expect, it } from 'vitest';
import {
  compactJson,
  decodeStatusTableResource,
  extractRequestedTokenSetsFromChunk,
  extractResourceNameFromChunk,
  parseContentPage,
  parseStatusTable,
  parseTokenTableSystem,
  type DecodedResourceChunk
} from '../src/json-extraction/schemas.js';

describe('compactJson', () => {
  it('serializes JSON values and fails safely for circular objects', () => {
    expect(compactJson({ b: 2, a: 1 })).toBe('{"b":2,"a":1}');

    const circular: Record<string, unknown> = {};
    circular.self = circular;
    expect(compactJson(circular)).toBe('[object Object]');
  });
});

describe('parseTokenTableSystem', () => {
  it('rejects non-object and empty systems', () => {
    expect(parseTokenTableSystem(null)).toBeNull();
    expect(parseTokenTableSystem([])).toBeNull();
    expect(parseTokenTableSystem('tokens')).toBeNull();
    expect(parseTokenTableSystem({})).toBeNull();
    expect(parseTokenTableSystem({ tokens: [], tokenSets: [] })).toBeNull();
  });

  it('keeps valid items, drops invalid named items, and defaults tolerant fields', () => {
    const decoded = parseTokenTableSystem({
      tokens: [
        { name: ' token-id ', tokenName: 'md.comp.test', displayName: 'Test', tokenValueType: 'COLOR', state: 'ACTIVE' },
        { name: '', tokenName: 'invalid' },
        { name: 'fallback-token', tokenName: 42, displayName: null, tokenValueType: {}, state: [] }
      ],
      tokenSets: [
        { name: ' set-id ', displayName: 'Set', tokenSetName: 'md.comp' },
        { name: '' }
      ],
      tags: [{ name: 42, displayName: 'ignored input type', tagName: null }],
      contextTagGroups: 'not-an-array',
      contextualReferenceTrees: null
    });

    expect(decoded).not.toBeNull();
    expect(decoded?.tokens).toEqual([
      { name: 'token-id', tokenName: 'md.comp.test', displayName: 'Test', tokenValueType: 'COLOR', state: 'ACTIVE' },
      { name: 'fallback-token', tokenName: '', displayName: '', tokenValueType: '', state: '' }
    ]);
    expect(decoded?.tokenSets).toEqual([
      { name: 'set-id', displayName: 'Set', tokenSetName: 'md.comp' }
    ]);
    expect(decoded?.tags).toEqual([{ name: '', displayName: 'ignored input type', tagName: '' }]);
    expect(decoded?.contextTagGroups).toEqual([]);
    expect(decoded?.contextualReferenceTrees).toEqual({});
  });
});

describe('parseStatusTable', () => {
  it('decodes headers/columns and rows/statuses through nested payloads', () => {
    expect(parseStatusTable({
      payload: {
        columns: ['Platform', { label: 'Status' }, { unrelated: true }],
        statuses: [
          ['Android', { b: 2, a: 1 }],
          { platform: 'Web', details: { z: 1, a: 2 } },
          7,
          null
        ]
      }
    })).toEqual({
      headers: ['Platform', 'Status'],
      rows: [
        ['Android', '{"a":1,"b":2}'],
        ['Web', '{"a":2,"z":1}'],
        ['7']
      ]
    });
  });

  it('decodes and orders live DSDB connection matrices', () => {
    expect(parseStatusTable({
      connections: [
        { displayName: 'Web', status: 'NOT_AVAILABLE', orderInComponent: 20 },
        { displayName: 'Android', status: 'AVAILABLE', resourceUrl: 'https://example.test/android', orderInComponent: 10 },
        { displayName: 'Ignored without status', orderInComponent: 0 },
        null
      ]
    })).toEqual({
      headers: ['Platform', 'Status'],
      rows: [
        ['[Android](https://example.test/android)', 'Available'],
        ['Web', 'Not available']
      ]
    });
  });

  it('returns null for incomplete shapes and exposes the unsupported sentinel', () => {
    expect(parseStatusTable({ headers: ['Only header'] })).toBeNull();
    expect(parseStatusTable({ rows: [['Only row']] })).toBeNull();
    expect(parseStatusTable({ connections: [{ displayName: 'Android' }] })).toBeNull();
    expect(decodeStatusTableResource({ unknown: true })).toEqual({ _unsupported: true });
  });
});

describe('parseContentPage', () => {
  it('uses title and fallback HTML precedence', () => {
    expect(parseContentPage({
      title: 'Title',
      name: 'Name',
      htmlValue: '<p>HTML value</p>',
      body: '<p>Body</p>',
      description: 'Description'
    })).toEqual({
      title: 'Title',
      fallbackHtml: '<p>HTML value</p>',
      sections: []
    });

    expect(parseContentPage({ name: 'Name', body: '<p>Body</p>' })).toEqual({
      title: 'Name',
      fallbackHtml: '<p>Body</p>',
      sections: []
    });
  });

  it('decodes section/block aliases and removes explicitly hidden content', () => {
    const decoded = parseContentPage({
      content: {
        sections: [
          {
            name: 'Visible section',
            contentBlocks: [
              {
                name: 'Visible block',
                contentChunks: [
                  { htmlValue: '<p>One</p>' },
                  { contentChunkType: 'IMAGE', src: 'https://example.test/image' }
                ]
              },
              { title: 'Hidden block', hidden: true, chunks: [{ value: 'hidden' }] }
            ]
          },
          { title: 'Hidden section', isVisible: false, blocks: [] }
        ]
      }
    });

    expect(decoded.sections).toHaveLength(1);
    expect(decoded.sections[0]).toMatchObject({
      title: 'Visible section',
      blocks: [{ title: 'Visible block' }]
    });
    expect(decoded.sections[0]?.blocks[0]?.chunks).toHaveLength(2);
  });

  it('discovers a nested section-like array when no canonical sections path exists', () => {
    const decoded = parseContentPage({
      wrapper: {
        arbitrary: [
          {
            heading: 'Nested section',
            blocks: [{ heading: 'Nested block', items: [{ body: '<p>Nested text</p>' }] }]
          }
        ]
      }
    });

    expect(decoded.sections).toEqual([
      {
        title: 'Nested section',
        blocks: [
          { title: 'Nested block', chunks: [expect.objectContaining({ body: '<p>Nested text</p>' })] }
        ]
      }
    ]);
  });

  it('walks cyclic unknown payloads safely', () => {
    const raw: Record<string, unknown> = { title: 'Cyclic' };
    raw.self = raw;
    expect(parseContentPage(raw)).toEqual({ title: 'Cyclic', fallbackHtml: null, sections: [] });
  });
});

describe('resource chunk helpers', () => {
  it('uses token-set sources in override, configuration, then direct priority', () => {
    expect(extractRequestedTokenSetsFromChunk({
      moduleConfigurationOverrides: { tokenSets: [' Override ', '', 42] },
      moduleConfiguration: { tokenSets: ['Configuration'] },
      tokenSets: ['Direct']
    })).toEqual([' Override ']);

    expect(extractRequestedTokenSetsFromChunk({
      moduleConfigurationOverrides: { tokenSets: ['', 42] },
      moduleConfiguration: { tokenSets: ['Configuration'] },
      tokenSets: ['Direct']
    })).toEqual(['Configuration']);

    expect(extractRequestedTokenSetsFromChunk({ tokenSets: ['Direct'] })).toEqual(['Direct']);
    expect(extractRequestedTokenSetsFromChunk({ tokenSets: [null, '', 42] })).toEqual([]);
  });

  it('uses direct resource identifiers in deterministic priority order', () => {
    expect(extractResourceNameFromChunk({
      resourceName: 'resource-name',
      resourcePath: 'resource-path',
      resourceUrl: 'resource-url',
      moduleConfigurationOverrides: { resourceName: 'override-name' },
      moduleConfiguration: { resourceName: 'configuration-name' }
    })).toBe('resource-name');

    expect(extractResourceNameFromChunk({ resourcePath: 'resource-path', resourceUrl: 'resource-url' })).toBe('resource-path');
    expect(extractResourceNameFromChunk({ resourceUrl: 'resource-url' })).toBe('resource-url');
    expect(extractResourceNameFromChunk({ moduleConfigurationOverrides: { resourceName: 'override-name' } })).toBe('override-name');
    expect(extractResourceNameFromChunk({ moduleConfiguration: { resourceName: 'configuration-name' } })).toBe('configuration-name');
  });

  it('discovers nested TOKEN_TABLE identifiers and handles cycles', () => {
    const chunk: DecodedResourceChunk = { nested: { value: 'prefix/TOKEN_TABLE.button.json' } };
    (chunk as Record<string, unknown>).self = chunk;
    expect(extractResourceNameFromChunk(chunk)).toBe('prefix/TOKEN_TABLE.button.json');
    expect(extractResourceNameFromChunk({ nested: { value: 'ordinary-resource' } })).toBeNull();
  });
});
