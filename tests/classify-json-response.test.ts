import { describe, expect, it } from 'vitest';
import { classifyJsonResponse, classifyResponseType } from '../src/json-extraction/classify-json-response.js';

describe('classifyResponseType', () => {
  it('prefers payload structure over URL hints', () => {
    expect(classifyResponseType(
      'https://m3.material.io/_dsm/content/m3/page.json',
      { system: { tokenSets: [] } }
    )).toBe('token-table');

    expect(classifyResponseType(
      'https://m3.material.io/page-data/ComponentsM3/page.json',
      { rows: [] }
    )).toBe('status-table');
  });

  it('recognizes each structured content-page shape', () => {
    const url = 'https://m3.material.io/unclassified.json';
    expect(classifyResponseType(url, { sections: [] })).toBe('content-page');
    expect(classifyResponseType(url, { content: { sections: [] } })).toBe('content-page');
    expect(classifyResponseType(url, { page: { sections: [] } })).toBe('content-page');
    expect(classifyResponseType(url, { data: { sections: [] } })).toBe('content-page');
    expect(classifyResponseType(url, { title: 'Page', contentBlocks: [] })).toBe('content-page');
    expect(classifyResponseType(url, { title: 'Page', nested: { contentChunks: [] } })).toBe('content-page');
  });

  it('requires content structure or page identity before using the content URL hint', () => {
    const url = 'https://m3.material.io/_dsm/content/m3/page.json';
    expect(classifyResponseType(url, { title: 'Page', pageCanonId: 'page-id' })).toBe('content-page');
    expect(classifyResponseType(url, { title: 'Page', pageCanonicalId: 'page-id' })).toBe('content-page');
    expect(classifyResponseType(url, { title: 'Page', documentId: 'doc-id' })).toBe('content-page');
    expect(classifyResponseType(url, { title: 'Page', slug: 'components/buttons' })).toBe('content-page');
    expect(classifyResponseType(url, { title: 'Page', pathname: '/components/buttons' })).toBe('content-page');
    expect(classifyResponseType(url, { title: 'Page' })).toBe('content-page');
    expect(classifyResponseType('https://m3.material.io/unclassified.json', { title: 'Page' })).toBe('page-metadata');
  });

  it('recognizes page metadata from each public metadata field', () => {
    const url = 'https://m3.material.io/unclassified.json';
    expect(classifyResponseType(url, { pageCanonId: 'page-id' })).toBe('page-metadata');
    expect(classifyResponseType(url, { pathname: '/components/buttons' })).toBe('page-metadata');
    expect(classifyResponseType(url, { title: 'Buttons' })).toBe('page-metadata');
  });

  it('recognizes every DSDB structural marker', () => {
    const url = 'https://m3.material.io/unclassified.json';
    const payloads = [
      { resourceName: 'resource' },
      { resourcePath: 'path' },
      { libraryModuleType: 'COMPONENT' },
      { moduleConfigurationOverrides: {} },
      { resource: {} },
      { component: {} },
      { tokenSets: {} }
    ];

    for (const payload of payloads) {
      expect(classifyResponseType(url, payload)).toBe('dsdb-resource');
    }
  });

  it('recognizes URL-only fallbacks and requires the expected suffix shape', () => {
    expect(classifyResponseType('https://m3.material.io/_dsm/data/dsdb-m3/v/TOKEN_TABLE.buttons.json', null)).toBe('token-table');
    expect(classifyResponseType('https://m3.material.io/_dsm/data/dsdb-m3/v/status_table.buttons.json', null)).toBe('status-table');
    expect(classifyResponseType('https://m3.material.io/_dsm/content/m3/buttons.json', null)).toBe('content-page');
    expect(classifyResponseType('https://m3.material.io/page-data/ComponentsM3/buttons.json', null)).toBe('page-metadata');
    expect(classifyResponseType('https://m3.material.io/_dsm/data/dsdb-m3/v/component.json', null)).toBe('dsdb-resource');

    expect(classifyResponseType('https://m3.material.io/_dsm/data/dsdb-m3/v/TOKEN_TABLE.buttons.json/extra', null)).toBe('unknown-json-resource');
    expect(classifyResponseType('https://m3.material.io/_dsm/content/m3/.json', null)).toBe('unknown-json-resource');
    expect(classifyResponseType('https://m3.material.io/page-data/.json', null)).toBe('unknown-json-resource');
  });

  it('handles malformed URLs without throwing', () => {
    expect(classifyResponseType('not a valid URL/TOKEN_TABLE.buttons.json', null)).toBe('token-table');
    expect(classifyResponseType('not a valid URL/other.json', null)).toBe('unknown-json-resource');
  });
});

describe('classifyJsonResponse resource names', () => {
  it('does not attach resource names to page metadata or content pages', () => {
    expect(classifyJsonResponse({
      url: 'https://m3.material.io/page-data/ComponentsM3/buttons.json',
      payload: { title: 'Buttons', resourceName: 'ignored' }
    })).toEqual({
      url: 'https://m3.material.io/page-data/ComponentsM3/buttons.json',
      type: 'page-metadata',
      payload: { title: 'Buttons', resourceName: 'ignored' }
    });

    const content = { sections: [], resourceName: 'ignored' };
    expect(classifyJsonResponse({
      url: 'https://m3.material.io/_dsm/content/m3/buttons.json',
      payload: content
    })).toEqual({
      url: 'https://m3.material.io/_dsm/content/m3/buttons.json',
      type: 'content-page',
      payload: content
    });
  });

  it('uses direct resource-name fields in deterministic priority order', () => {
    const url = 'https://m3.material.io/_dsm/data/dsdb-m3/v/fallback.json';
    expect(classifyJsonResponse({
      url,
      payload: {
        resourceName: 'resource-name',
        name: 'name',
        id: 'id',
        resource: { name: 'resource.name' },
        metadata: { resourceName: 'metadata.resourceName' }
      }
    }).resourceName).toBe('resource-name');

    expect(classifyJsonResponse({ url, payload: { name: 'name', id: 'id' } }).resourceName).toBe('name');
    expect(classifyJsonResponse({ url, payload: { id: 'id' } }).resourceName).toBe('id');
    expect(classifyJsonResponse({ url, payload: { resource: { name: 'resource.name' } } }).resourceName).toBe('resource.name');
    expect(classifyJsonResponse({ url, payload: { metadata: { resourceName: 'metadata.resourceName' } } }).resourceName).toBe('metadata.resourceName');
  });

  it('derives token-table and status-table names from their URLs', () => {
    expect(classifyJsonResponse({
      url: 'https://m3.material.io/_dsm/data/dsdb-m3/v/TOKEN_TABLE.buttons.json',
      payload: { system: { tokenSets: [] } }
    }).resourceName).toBe('buttons');

    expect(classifyJsonResponse({
      url: 'https://m3.material.io/_dsm/data/dsdb-m3/v/STATUS_TABLE.buttons.json',
      payload: { rows: [] }
    }).resourceName).toBe('STATUS_TABLE.buttons.json');
  });

  it('discovers nested DSDB resource identifiers before falling back to the URL', () => {
    expect(classifyJsonResponse({
      url: 'https://m3.material.io/_dsm/data/dsdb-m3/v/fallback.json',
      payload: { component: {}, nested: { resourcePath: 'designSystems/123/components/456' } }
    }).resourceName).toBe('designSystems/123/components/456');

    expect(classifyJsonResponse({
      url: 'https://m3.material.io/_dsm/data/dsdb-m3/v/fallback.json',
      payload: { component: {} }
    }).resourceName).toBe('fallback.json');
  });

  it('walks cyclic payloads safely when discovering nested resource names', () => {
    const payload: Record<string, unknown> = { component: {} };
    payload.self = payload;
    payload.child = { resourceUrl: 'designSystems/123/resource' };

    expect(classifyJsonResponse({
      url: 'https://m3.material.io/_dsm/data/dsdb-m3/v/fallback.json',
      payload
    }).resourceName).toBe('designSystems/123/resource');
  });
});
