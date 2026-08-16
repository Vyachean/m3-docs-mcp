import { mkdtemp, readFile, readdir } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  buildJsonPageBundleFromResponses,
  countCapturedResponseTypes,
  createJsonPageBundle,
  writeRawJsonDebugFiles,
  type JsonCapturedResponse
} from '../src/json-extraction/json-bundle.js';

const captured = (
  type: JsonCapturedResponse['type'],
  url: string,
  payload: unknown,
  resourceName?: string
): JsonCapturedResponse => ({ url, type, payload, ...(resourceName ? { resourceName } : {}) });

describe('createJsonPageBundle', () => {
  it('defaults optional collections and returns null for an unresolved resource', async () => {
    const bundle = createJsonPageBundle({
      pageData: null,
      contentPage: null,
      pageCanonId: null
    });

    expect(bundle.responses).toEqual([]);
    expect(bundle.selectionReasons).toEqual([]);
    await expect(bundle.fetchResource('missing')).resolves.toBeNull();
  });

  it('resolves direct, trailing-id, and typed URL resource aliases without crossing resource types', async () => {
    const tokenPayload = { token: true };
    const statusPayload = { status: true };
    const componentPayload = { component: true };
    const tokenUrlPayload = { tokenUrl: true };
    const statusUrlPayload = { statusUrl: true };
    const responses: JsonCapturedResponse[] = [
      captured(
        'token-table',
        'https://m3.material.io/_dsm/data/dsdb-m3/v/TOKEN_TABLE.primary.json',
        tokenPayload,
        'designSystems/123/components/primary'
      ),
      captured(
        'status-table',
        'https://m3.material.io/_dsm/data/dsdb-m3/v/STATUS_TABLE.states.json',
        statusPayload,
        'designSystems/123/status/states'
      ),
      captured(
        'dsdb-resource',
        'https://m3.material.io/_dsm/data/dsdb-m3/v/component.json',
        componentPayload,
        'designSystems/123/components/card'
      ),
      captured(
        'token-table',
        'https://m3.material.io/_dsm/data/dsdb-m3/v/TOKEN_TABLE.url-only.json',
        tokenUrlPayload
      ),
      captured(
        'status-table',
        'https://m3.material.io/_dsm/data/dsdb-m3/v/STATUS_TABLE.url-only.json',
        statusUrlPayload
      )
    ];
    const bundle = createJsonPageBundle({
      pageData: null,
      contentPage: null,
      pageCanonId: null,
      responses
    });

    await expect(bundle.fetchResource('designSystems/123/components/primary', 'TOKEN_TABLE')).resolves.toBe(tokenPayload);
    await expect(bundle.fetchResource('primary', 'TOKEN_TABLE')).resolves.toBe(tokenPayload);
    await expect(bundle.fetchResource('states', 'STATUS_TABLE')).resolves.toBe(statusPayload);
    await expect(bundle.fetchResource('card', 'COMPONENT')).resolves.toBe(componentPayload);
    await expect(bundle.fetchResource('url-only', 'TOKEN_TABLE')).resolves.toBe(tokenUrlPayload);
    await expect(bundle.fetchResource('url-only', 'STATUS_TABLE')).resolves.toBe(statusUrlPayload);
    await expect(bundle.fetchResource('primary', 'STATUS_TABLE')).resolves.toBeNull();
    await expect(bundle.fetchResource('states', 'TOKEN_TABLE')).resolves.toBeNull();
  });
});

describe('countCapturedResponseTypes', () => {
  it('counts each captured response type independently', () => {
    expect(countCapturedResponseTypes([
      captured('content-page', 'https://example.test/content-a', {}),
      captured('content-page', 'https://example.test/content-b', {}),
      captured('page-metadata', 'https://example.test/page-data', {}),
      captured('token-table', 'https://example.test/token', {})
    ])).toEqual({
      'content-page': 2,
      'page-metadata': 1,
      'token-table': 1
    });
    expect(countCapturedResponseTypes([])).toEqual({});
  });
});

describe('buildJsonPageBundleFromResponses', () => {
  it('uses canonical identity fallbacks in deterministic order', () => {
    const fromPageData = buildJsonPageBundleFromResponses([
      captured('page-metadata', 'https://m3.material.io/page-data/a.json', { pageCanonId: 'page-data-canon' }),
      captured('content-page', 'https://m3.material.io/_dsm/content/m3/a.json', { sections: [], pageCanonId: 'content-canon' })
    ], { pageCanonId: 'context-canon' });
    expect(fromPageData.pageCanonId).toBe('page-data-canon');

    const fromContent = buildJsonPageBundleFromResponses([
      captured('content-page', 'https://m3.material.io/_dsm/content/m3/a.json', {
        sections: [],
        metadata: { pageCanonId: 'content-metadata-canon' }
      })
    ], { pageCanonId: 'context-canon' });
    expect(fromContent.pageCanonId).toBe('content-metadata-canon');

    expect(buildJsonPageBundleFromResponses([], {
      pageCanonId: 'context-canon',
      routeMetadata: { pageCanonId: 'route-canon' },
      documentId: 'context-document',
      routeMetadata: { pageCanonId: 'route-canon', documentId: 'route-document' }
    }).pageCanonId).toBe('context-canon');

    expect(buildJsonPageBundleFromResponses([], {
      routeMetadata: { pageCanonId: 'route-canon', documentId: 'route-document' },
      documentId: 'context-document'
    }).pageCanonId).toBe('route-canon');

    expect(buildJsonPageBundleFromResponses([], {
      documentId: 'context-document',
      routeMetadata: { documentId: 'route-document' }
    }).pageCanonId).toBe('context-document');

    expect(buildJsonPageBundleFromResponses([], {
      routeMetadata: { documentId: 'route-document' }
    }).pageCanonId).toBe('route-document');

    expect(buildJsonPageBundleFromResponses([]).pageCanonId).toBeNull();
  });

  it('selects the route-matching candidate instead of relying on response order', () => {
    const lists = captured(
      'content-page',
      'https://m3.material.io/_dsm/content/m3/cv/page-canon-lists.json',
      { title: 'Lists', pageCanonId: 'page-canon-lists', sections: [] }
    );
    const dialogs = captured(
      'content-page',
      'https://m3.material.io/_dsm/content/m3/cv/page-canon-dialogs.json',
      { title: 'Dialogs', pageCanonId: 'page-canon-dialogs', sections: [] }
    );

    const bundle = buildJsonPageBundleFromResponses([lists, dialogs], {
      requestedUrl: 'https://m3.material.io/components/dialogs/overview',
      finalUrl: 'https://m3.material.io/components/dialogs/overview',
      title: 'Dialogs',
      slug: '/components/dialogs/overview/',
      pageCanonId: 'page-canon-dialogs.json'
    });

    expect(bundle.contentPage).toBe(dialogs.payload);
    expect(bundle.pageCanonId).toBe('page-canon-dialogs');
    expect(bundle.selectionReasons).toHaveLength(1);
    expect(bundle.selectionReasons[0]).toContain('page-canon-dialogs.json');
    expect(bundle.selectionReasons[0]).toContain('candidates=');
  });

  it('returns null page candidates when the captured responses contain other resource types only', () => {
    const bundle = buildJsonPageBundleFromResponses([
      captured('token-table', 'https://m3.material.io/TOKEN_TABLE.button.json', { token: true }, 'button')
    ]);

    expect(bundle.pageData).toBeNull();
    expect(bundle.contentPage).toBeNull();
    expect(bundle.pageCanonId).toBeNull();
    expect(bundle.selectionReasons).toEqual([]);
  });
});

describe('writeRawJsonDebugFiles', () => {
  it('does nothing when there are no captured responses', async () => {
    const tempDir = await mkdtemp(path.join(os.tmpdir(), 'm3-json-bundle-empty-'));
    await expect(writeRawJsonDebugFiles(tempDir, 'components/button/overview.md', [])).resolves.toBe(0);
  });

  it('uses stable sanitized resource filenames and collision suffixes', async () => {
    const tempDir = await mkdtemp(path.join(os.tmpdir(), 'm3-json-bundle-debug-'));
    const responses = [
      captured(
        'token-table',
        'https://m3.material.io/_dsm/data/dsdb-m3/v/TOKEN_TABLE.button.json?cache=1',
        { value: 1 },
        'designSystems/123/components/Button primary'
      ),
      captured(
        'token-table',
        'https://m3.material.io/_dsm/data/dsdb-m3/v/TOKEN_TABLE.button.json?cache=2',
        { value: 2 },
        'designSystems/456/components/Button primary'
      )
    ];

    await expect(writeRawJsonDebugFiles(tempDir, 'components/button/specs.md', responses)).resolves.toBe(2);
    const rawDir = path.join(tempDir, 'raw/components/button/specs');
    expect((await readdir(rawDir)).sort()).toEqual([
      'token-table.Button-primary.2.json',
      'token-table.Button-primary.json'
    ]);

    const first = JSON.parse(await readFile(path.join(rawDir, 'token-table.Button-primary.json'), 'utf8')) as Record<string, unknown>;
    expect(first).toMatchObject({
      normalizedPath: '/_dsm/data/dsdb-m3/v/TOKEN_TABLE.button.json',
      type: 'token-table',
      resourceName: 'designSystems/123/components/Button primary',
      payload: { value: 1 }
    });
    expect(first.stableId).toMatch(/^[a-f0-9]{12}$/);
  });
});
