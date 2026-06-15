import { readFileSync } from 'node:fs';
import { mkdtemp, readFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { extractDsdbRoutesFromBundle } from '../src/crawler.js';
import { pushPageDiagnostic, createEmptyExtractionDiagnostics, pushRouteDiagnostic } from '../src/json-extraction/diagnostics.js';
import { buildBundleFromCapturedResponses, createNetworkJsonCapture } from '../src/json-extraction/capture-network-json.js';
import { classifyJsonResponse, classifyResponseType } from '../src/json-extraction/classify-json-response.js';
import { extractContentPageToMaterialPage } from '../src/json-extraction/extract-content-page.js';
import { deriveCollectionSegmentFromSlug, extractPageDataMetadata } from '../src/json-extraction/extract-page-data.js';
import { buildJsonPageBundleFromResponses, writeRawJsonDebugFiles } from '../src/json-extraction/json-bundle.js';
import { buildDsdbResourceCandidateUrls, buildPageDataCandidateUrls, fetchJsonPageBundle } from '../src/json-extraction/fetch-json-page.js';

const fixture = (name: string) => JSON.parse(readFileSync(path.join(process.cwd(), 'tests/fixtures/json-extraction', name), 'utf8'));

describe('JSON-first extraction', () => {
  it('extracts page metadata from page-data JSON', () => {
    const metadata = extractPageDataMetadata(fixture('page-data-componentsm3-document.json'));
    expect(metadata).toEqual({
      title: 'Lists',
      pageCanonId: 'page-canon-lists',
      pathname: '/components/lists/overview'
    });
  });

  it('builds page-data candidates from DSDB route metadata', () => {
    expect(deriveCollectionSegmentFromSlug('components/lists/overview')).toBe('ComponentsM3');
    expect(buildPageDataCandidateUrls('https://m3.material.io', {
      slug: 'components/lists/overview',
      documentId: 'a7f6d95d3e6b4f18',
      collectionName: 'ComponentsM3',
      collectionId: '20543ce18892f7d9',
      exportedCarbonFileId: 'page-canon-lists.json'
    })).toEqual([
      'https://m3.material.io/page-data/ComponentsM3/a7f6d95d3e6b4f18.json',
      'https://m3.material.io/page-data/ComponentsM3/page-canon-lists.json',
      'https://m3.material.io/page-data/20543ce18892f7d9/a7f6d95d3e6b4f18.json',
      'https://m3.material.io/page-data/20543ce18892f7d9/page-canon-lists.json',
      'https://m3.material.io/page-data/components/lists/overview/page-data.json'
    ]);
  });

  it('builds TOKEN_TABLE and DSDB component resource candidates from real resource names', () => {
    expect(buildDsdbResourceCandidateUrls(
      'https://m3.material.io',
      'cv-123',
      'designSystems/20543ce18892f7d9/components/6c818a16475113bd',
      'TOKEN_TABLE'
    )).toEqual([
      'https://m3.material.io/_dsm/data/dsdb-m3/cv-123/TOKEN_TABLE.6c818a16475113bd.json',
      'https://m3.material.io/_dsm/data/dsdb-m3/cv-123/designSystems_20543ce18892f7d9_components_6c818a16475113bd.json',
      'https://m3.material.io/_dsm/data/dsdb-m3/cv-123/designSystems/20543ce18892f7d9/components/6c818a16475113bd'
    ]);
  });

  it('renders text sections from structured content JSON', async () => {
    const result = await extractContentPageToMaterialPage({
      url: 'https://m3.material.io/components/lists/overview',
      pageData: fixture('page-data-componentsm3-document.json'),
      contentPage: fixture('content-overview.json'),
      fetchResource: async () => null
    });

    expect(result.fallbackReason).toBeNull();
    expect(result.page.markdown).toContain('# Lists');
    expect(result.page.markdown).toContain('## Overview');
    expect(result.page.markdown).toContain('### Usage');
    expect(result.page.markdown).toContain('Lists present multiple line items');
    expect(result.page.markdown).toContain('- One line');
  });

  it('renders images with normalized high-resolution URLs and captions', async () => {
    const result = await extractContentPageToMaterialPage({
      url: 'https://m3.material.io/foundations/images',
      pageData: null,
      contentPage: fixture('content-images.json'),
      fetchResource: async () => null
    });

    expect(result.page.markdown).toContain('![Material hero](https://example.com/material-hero=w1600)');
    expect(result.page.markdown).toContain('Hero caption');
    expect(result.pageDiagnostic.imageCount).toBe(1);
  });

  it('renders video chunks as stable markdown instead of dropping them', async () => {
    const result = await extractContentPageToMaterialPage({
      url: 'https://m3.material.io/foundations/motion',
      pageData: null,
      contentPage: fixture('content-video.json'),
      fetchResource: async () => null
    });

    expect(result.page.markdown).toContain('[Video: Component demo](https://example.com/demo.mp4)');
    expect(result.page.markdown).toContain('Short walkthrough');
    expect(result.pageDiagnostic.videoCount).toBe(1);
  });

  it('renders TOKEN_TABLE resources from DSDB JSON and does not fabricate unresolved values', async () => {
    const result = await extractContentPageToMaterialPage({
      url: 'https://m3.material.io/components/button/specs',
      pageData: null,
      contentPage: fixture('content-token-table.json'),
      fetchResource: async (resourceName, resourceType) => (
        resourceType === 'TOKEN_TABLE' && resourceName === 'designSystems/20543ce18892f7d9/components/6c818a16475113bd'
      ) ? fixture('token-table-resource.json') : null
    });

    expect(result.fallbackReason).toBeNull();
    expect(result.page.markdown).toContain('| Token | Name | sys alias | ref alias | Light | Dark |');
    expect(result.page.markdown).toContain('md.comp.button.container.color');
    expect(result.page.markdown).toContain('md.sys.color.primary');
    expect(result.page.markdown).toContain('md.ref.palette.primary40');
    expect(result.page.markdown).toContain('| md.comp.button.container.height | Container height | md.sys.shape.corner.full |  | [unresolved] | [unresolved] |');
    expect(result.page.markdown).not.toContain('0dp');
    expect(result.pageDiagnostic.tokenTables).toBe(1);
    expect(result.pageDiagnostic.tokenTablesRendered).toBe(1);
    expect(result.pageDiagnostic.tokenContextDiagnostics).toEqual([
      expect.objectContaining({
        resourceName: 'designSystems/20543ce18892f7d9/components/6c818a16475113bd',
        requestedTokenSets: expect.any(Array),
        renderedTokenSets: expect.any(Array),
        selectedContextKeys: expect.any(Array),
        availableContextKeys: expect.any(Array),
        multipleContextVariantsAvailable: true
      })
    ]);
  });

  it('renders missing token sets as explicit notes and records diagnostics', async () => {
    const result = await extractContentPageToMaterialPage({
      url: 'https://m3.material.io/components/lists/overview',
      pageData: fixture('page-data-componentsm3-document.json'),
      contentPage: fixture('content-dsdb-real.json'),
      fetchResource: async (resourceName, resourceType) => (
        resourceType === 'TOKEN_TABLE' && resourceName === 'designSystems/20543ce18892f7d9/components/6c818a16475113bd'
      ) ? fixture('token-table-resource.json') : null
    });

    expect(result.page.markdown).toContain('Requested token sets not found: Missing token set');
    expect(result.pageDiagnostic.missingRequestedTokenSets).toContain('Missing token set');
  });

  it('renders STATUS_TABLE resources when the schema is understood', async () => {
    const result = await extractContentPageToMaterialPage({
      url: 'https://m3.material.io/components/status/overview',
      pageData: null,
      contentPage: fixture('content-status-table.json'),
      fetchResource: async (_resourceName, resourceType) => resourceType === 'STATUS_TABLE' ? fixture('status-table-resource.json') : null
    });

    expect(result.page.markdown).toContain('| State | Description |');
    expect(result.page.markdown).toContain('| Enabled | Default interactive state |');
    expect(result.pageDiagnostic.statusTableDiagnostics).toEqual([
      expect.objectContaining({
        requested: true,
        resolved: true,
        rendered: true,
        renderedAsPlaceholder: false,
        unsupportedSchema: false
      })
    ]);
  });

  it('records placeholder diagnostics for unsupported STATUS_TABLE schemas', async () => {
    const result = await extractContentPageToMaterialPage({
      url: 'https://m3.material.io/components/status/overview',
      pageData: null,
      contentPage: fixture('content-status-table.json'),
      fetchResource: async () => ({ payload: { unsupported: true } })
    });

    expect(result.page.markdown).toContain('Material resource placeholder: STATUS_TABLE');
    expect(result.pageDiagnostic.statusTablesRenderedAsPlaceholder).toBe(1);
    expect(result.pageDiagnostic.unsupportedStatusTableSchemaCount).toBe(1);
    expect(result.pageDiagnostic.statusTableDiagnostics).toEqual([
      expect.objectContaining({
        requested: true,
        resolved: true,
        rendered: false,
        renderedAsPlaceholder: true,
        unsupportedSchema: true
      })
    ]);
  });

  it('preserves unknown chunk and resource types as explicit placeholders', async () => {
    const result = await extractContentPageToMaterialPage({
      url: 'https://m3.material.io/experimental',
      pageData: null,
      contentPage: fixture('content-unknown.json'),
      fetchResource: async () => null
    });

    expect(result.page.markdown).toContain('Unsupported Material chunk: CAROUSEL');
    expect(result.page.markdown).toContain('Material resource placeholder: EXPERIMENTAL_GRID');
    expect(result.pageDiagnostic.unknownChunkTypes).toContain('CAROUSEL');
    expect(result.pageDiagnostic.unknownResourceTypes).toContain('EXPERIMENTAL_GRID');
  });

  it('marks suspiciously incomplete JSON output for DOM fallback', async () => {
    const result = await extractContentPageToMaterialPage({
      url: 'https://m3.material.io/foundations/incomplete',
      pageData: null,
      contentPage: { title: 'Incomplete', sections: [] },
      fetchResource: async () => null
    });

    expect(result.fallbackReason).toBe('json-no-sections');
  });

  it('classifies network-captured JSON responses by payload and URL', () => {
    expect(classifyJsonResponse({
      url: 'https://m3.material.io/page-data/components/lists/overview/page-data.json',
      payload: fixture('network-page-data.json')
    }).type).toBe('page-metadata');
    expect(classifyJsonResponse({
      url: 'https://m3.material.io/_dsm/content/m3/cv-123/page-canon-lists.json',
      payload: fixture('network-content-page.json')
    }).type).toBe('content-page');
    expect(classifyJsonResponse({
      url: 'https://m3.material.io/_dsm/data/dsdb-m3/cv-123/TOKEN_TABLE.6c818a16475113bd.json',
      payload: fixture('network-token-table.json')
    }).type).toBe('token-table');
    expect(classifyJsonResponse({
      url: 'https://m3.material.io/_dsm/data/dsdb-m3/cv-123/STATUS_TABLE.states.json',
      payload: fixture('network-status-table.json')
    }).type).toBe('status-table');
    expect(classifyJsonResponse({
      url: 'https://m3.material.io/_dsm/data/dsdb-m3/cv-123/EXPERIMENTAL_GRID.sample.json',
      payload: fixture('network-unknown.json')
    }).type).toBe('dsdb-resource');
    expect(classifyJsonResponse({
      url: 'https://m3.material.io/page-data/components/lists/overview/page-data.json?cachebust=123',
      payload: fixture('network-page-data.json')
    }).type).toBe('page-metadata');
  });

  it('classifies a content page with nested TOKEN_TABLE resources as content-page', () => {
    expect(classifyResponseType(
      'https://m3.material.io/_dsm/content/m3/cv-123/page-canon-button-specs.json',
      fixture('content-token-table.json')
    )).toBe('content-page');
  });

  it('classifies a content page with nested STATUS_TABLE resources as content-page', () => {
    expect(classifyResponseType(
      'https://m3.material.io/_dsm/content/m3/cv-123/page-canon-status-docs.json',
      fixture('content-status-table.json')
    )).toBe('content-page');
  });

  it('classifies root-level JSON resource payloads without overclassifying title-only objects', () => {
    expect(classifyResponseType(
      'https://m3.material.io/_dsm/data/dsdb-m3/cv-123/TOKEN_TABLE.6c818a16475113bd.json',
      fixture('network-token-table.json')
    )).toBe('token-table');
    expect(classifyResponseType(
      'https://m3.material.io/_dsm/data/dsdb-m3/cv-123/STATUS_TABLE.states.json',
      fixture('network-status-table.json')
    )).toBe('status-table');
    expect(classifyResponseType(
      'https://m3.material.io/_dsm/data/dsdb-m3/cv-123/EXPERIMENTAL_GRID.sample.json',
      fixture('network-unknown.json')
    )).toBe('dsdb-resource');
    expect(classifyResponseType(
      'https://m3.material.io/_dsm/content/m3/cv-123/title-only.json',
      { title: 'Title only' }
    )).not.toBe('content-page');
  });

  it('builds a normalized JSON page bundle from captured responses', async () => {
    const bundle = buildBundleFromCapturedResponses([
      classifyJsonResponse({
        url: 'https://m3.material.io/page-data/components/lists/overview/page-data.json',
        payload: fixture('network-page-data.json')
      }),
      classifyJsonResponse({
        url: 'https://m3.material.io/_dsm/content/m3/cv-123/page-canon-lists.json',
        payload: fixture('network-content-page.json')
      }),
      classifyJsonResponse({
        url: 'https://m3.material.io/_dsm/data/dsdb-m3/cv-123/TOKEN_TABLE.6c818a16475113bd.json',
        payload: fixture('network-token-table.json')
      })
    ]);

    expect(bundle.pageCanonId).toBe('page-canon-lists');
    expect(bundle.pageData).toBeTruthy();
    expect(bundle.contentPage).toBeTruthy();
    await expect(bundle.fetchResource('designSystems/20543ce18892f7d9/components/6c818a16475113bd', 'TOKEN_TABLE')).resolves.toEqual(fixture('network-token-table.json'));
  });

  it('selects the content page when embedded resource chunks are present and still resolves captured resources', async () => {
    const contentPage = fixture('content-token-table.json');
    const bundle = buildJsonPageBundleFromResponses([
      classifyJsonResponse({
        url: 'https://m3.material.io/_dsm/content/m3/cv-123/page-canon-button-specs.json',
        payload: contentPage
      }),
      classifyJsonResponse({
        url: 'https://m3.material.io/_dsm/data/dsdb-m3/cv-123/TOKEN_TABLE.6c818a16475113bd.json',
        payload: fixture('network-token-table.json')
      })
    ], {
      finalUrl: 'https://m3.material.io/components/button/specs',
      slug: 'components/button/specs',
      pageCanonId: 'page-canon-button-specs'
    });

    expect(bundle.contentPage).toEqual(contentPage);
    await expect(bundle.fetchResource(
      'designSystems/20543ce18892f7d9/components/6c818a16475113bd',
      'TOKEN_TABLE'
    )).resolves.toEqual(fixture('network-token-table.json'));
  });

  it('selects captured JSON for the current route instead of the first matching response', () => {
    const bundle = buildBundleFromCapturedResponses([
      classifyJsonResponse({
        url: 'https://m3.material.io/page-data/components/lists/overview/page-data.json?cachebust=1',
        payload: fixture('network-page-data.json')
      }),
      classifyJsonResponse({
        url: 'https://m3.material.io/page-data/components/dialogs/overview/page-data.json?cachebust=2',
        payload: { result: { pageContext: { title: 'Dialogs', pageCanonId: 'page-canon-dialogs', slug: 'components/dialogs/overview' } } }
      }),
      classifyJsonResponse({
        url: 'https://m3.material.io/_dsm/content/m3/cv-123/page-canon-lists.json',
        payload: fixture('network-content-page.json')
      }),
      classifyJsonResponse({
        url: 'https://m3.material.io/_dsm/content/m3/cv-123/page-canon-dialogs.json',
        payload: { title: 'Dialogs', sections: [{ name: 'Overview', contentBlocks: [{ contentChunks: [{ contentChunkType: 'TEXT', htmlValue: '<p>Dialog content for the selected route.</p>' }] }] }] }
      })
    ], {
      finalUrl: 'https://m3.material.io/components/dialogs/overview',
      slug: 'components/dialogs/overview',
      pageCanonId: 'page-canon-dialogs'
    });

    expect(extractPageDataMetadata(bundle.pageData).title).toBe('Dialogs');
    expect(bundle.selectionReasons.join('\n')).toContain('/page-data/components/dialogs/overview/page-data.json');
  });

  it('drains pending network JSON parsing before building the bundle', async () => {
    let listener: ((response: { url: () => string; ok: () => boolean; json: () => Promise<unknown> }) => void | Promise<void>) | undefined;
    const page = {
      on: (_event: string, fn: typeof listener) => { listener = fn; },
      off: () => { listener = undefined; }
    } as unknown as Parameters<typeof createNetworkJsonCapture>[0];
    const capture = createNetworkJsonCapture(page);
    let resolveJson: ((value: unknown) => void) | undefined;
    const delayedJson = new Promise<unknown>((resolve) => {
      resolveJson = resolve;
    });

    void listener?.({
      url: () => 'https://m3.material.io/page-data/components/lists/overview/page-data.json',
      ok: () => true,
      json: () => delayedJson
    });

    const stopPromise = capture.stopAndDrain();
    resolveJson?.(fixture('network-page-data.json'));
    await stopPromise;

    expect(capture.getResponses()).toHaveLength(1);
    expect(extractPageDataMetadata(capture.buildBundle().pageData).title).toBe('Lists');
  });

  it('extracts routes from reordered route metadata objects', () => {
    const routes = extractDsdbRoutesFromBundle([
      '"carbonVersion":"cv-123"',
      '{"collectionId":"20543ce18892f7d9","slug":"components/dialogs/overview","exportedCarbonFileId":"page-canon-dialogs.json","pageCanonicalId":"page-canon-dialogs","documentId":"doc-dialogs","collectionName":"ComponentsM3"}'
    ].join(','));

    expect(routes).toEqual([
      expect.objectContaining({
        slug: 'components/dialogs/overview',
        documentId: 'doc-dialogs',
        collectionId: '20543ce18892f7d9',
        exportedCarbonFileId: 'page-canon-dialogs.json',
        pageCanonId: 'page-canon-dialogs'
      })
    ]);
  });

  it('preserves partial routes when optional metadata is missing', () => {
    const routes = extractDsdbRoutesFromBundle('{"slug":"foundations/layout/overview","pageCanonicalId":"page-canon-layout"}');

    expect(routes).toEqual([
      expect.objectContaining({
        slug: 'foundations/layout/overview',
        pageCanonId: 'page-canon-layout',
        metadataWarnings: expect.arrayContaining(['missing-collection-metadata', 'missing-exported-carbon-file-id'])
      })
    ]);
  });

  it('sanitizes raw JSON debug output while preserving useful payload context', async () => {
    const tempDir = await mkdtemp(path.join(os.tmpdir(), 'm3-json-debug-'));
    await writeRawJsonDebugFiles(tempDir, 'components/lists/overview.md', [
      classifyJsonResponse({
        url: 'https://m3.material.io/page-data/components/lists/overview/page-data.json?cachebust=123',
        payload: fixture('network-page-data.json')
      })
    ]);

    const written = await readFile(path.join(tempDir, 'raw/components/lists/overview/page-data.json'), 'utf8');
    expect(written).toContain('"normalizedPath": "/page-data/components/lists/overview/page-data.json"');
    expect(written).toContain('"stableId":');
    expect(written).not.toContain('"headers"');
    expect(written).not.toContain('"cookies"');
  });

  it('captures direct JSON resource payloads in raw debug output', async () => {
    const tempDir = await mkdtemp(path.join(os.tmpdir(), 'm3-json-direct-debug-'));
    const fetchImpl = async (input: string | URL) => {
      const url = String(input);
      if (url.includes('/page-data/')) return { ok: true, json: async () => fixture('page-data-componentsm3-document.json') } as Response;
      if (url.includes('/_dsm/content/')) return { ok: true, json: async () => fixture('content-token-table.json') } as Response;
      if (url.includes('TOKEN_TABLE.6c818a16475113bd.json')) return { ok: true, json: async () => fixture('token-table-resource.json') } as Response;
      return { ok: false, status: 404, json: async () => ({}) } as Response;
    };

    const bundle = await fetchJsonPageBundle('https://m3.material.io', 'cv-123', {
      slug: 'components/button/specs',
      documentId: 'doc-button',
      collectionName: 'ComponentsM3',
      pageCanonId: 'page-canon-button-specs'
    }, undefined, fetchImpl as typeof fetch);
    await bundle.fetchResource('designSystems/20543ce18892f7d9/components/6c818a16475113bd', 'TOKEN_TABLE');
    await writeRawJsonDebugFiles(tempDir, 'components/button/specs.md', bundle.responses);

    const written = await readFile(path.join(tempDir, 'raw/components/button/specs/token-table.6c818a16475113bd.json'), 'utf8');
    expect(written).toContain('"type": "token-table"');
    expect(written).toContain('"stableId":');
    expect(written).not.toContain('"headers"');
    expect(written).not.toContain('"cookies"');
  });

  it('rejects JSON output when requested token tables are missing', async () => {
    const result = await extractContentPageToMaterialPage({
      url: 'https://m3.material.io/components/button/specs',
      pageData: null,
      contentPage: fixture('content-token-table.json'),
      fetchResource: async () => null
    });

    expect(result.fallbackReason).toBe('json-missing-token-tables');
  });

  it('aggregates extraction diagnostics', () => {
    const diagnostics = createEmptyExtractionDiagnostics();
    pushPageDiagnostic(diagnostics, {
      url: 'https://m3.material.io/components/lists/overview',
      path: 'components/lists/overview.md',
      method: 'json',
      source: 'direct-json',
      unknownChunkTypes: ['CAROUSEL'],
      unknownResourceTypes: ['EXPERIMENTAL_GRID'],
      tokenTables: 1,
      tokenTablesRendered: 1,
      tokenContextDiagnostics: [],
      statusTablesRequested: 0,
      statusTablesResolved: 1,
      statusTablesRenderedAsPlaceholder: 0,
      unsupportedStatusTableSchemaCount: 0,
      statusTableDiagnostics: [],
      missingRequestedTokenSets: ['Missing set'],
      suspiciousReasons: [],
      imageCount: 2,
      videoCount: 1,
      unresolvedResourceCount: 1,
      noSections: false,
      noHeadings: false,
      markdownLength: 120,
      hasTitle: true,
      qualityScore: 6,
      routeTitlePathMismatch: false
    });
    pushRouteDiagnostic(diagnostics, {
      url: 'https://m3.material.io/components/lists/overview',
      path: 'components/lists/overview.md',
      sourceUsed: 'direct-json',
      finalMethod: 'json',
      jsonAttempted: true,
      jsonSucceeded: true,
      browserFallbackAttempted: false,
      browserFallbackSucceeded: false,
      directJsonAttempted: true,
      directJsonSucceeded: true,
      networkJsonAttempted: false,
      networkJsonSucceeded: false,
      domFallbackAttempted: false,
      domFallbackSucceeded: false,
      unknownChunkTypes: ['CAROUSEL'],
      unknownResourceTypes: ['EXPERIMENTAL_GRID'],
      tokenTables: 1,
      tokenTablesRendered: 1,
      tokenTablesRequested: 1,
      tokenContextDiagnostics: [],
      statusTablesRequested: 0,
      statusTablesResolved: 1,
      statusTablesRenderedAsPlaceholder: 0,
      unsupportedStatusTableSchemaCount: 0,
      statusTableDiagnostics: [],
      missingRequestedTokenSets: ['Missing set'],
      unknownJsonResourceCount: 1,
      capturedJsonResponseCounts: { 'page-metadata': 1, 'content-page': 1 },
      rawJsonDebugFilesWritten: 2
    });

    expect(diagnostics).toMatchObject({
      totalPages: 1,
      totalRoutes: 1,
      pagesExtractedThroughJson: 1,
      pagesAcceptedFromDirectJson: 1,
      jsonFallbackRoutes: 0,
      pagesWithUnknownChunkTypes: 1,
      pagesWithUnknownResourceTypes: 1,
      unknownChunkCount: 1,
      unknownResourceTypeCount: 1,
      unknownJsonResourceCount: 1,
      pagesWithTokenTables: 1,
      tokenTablesRequested: 1,
      tokenTablesSuccessfullyRendered: 1,
      tokenTablesFailedToRender: 0,
      tokenTablesMissingRequestedTokenSets: 1,
      statusTablesResolved: 1,
      imageCount: 2,
      videoCount: 1,
      unresolvedResourceCount: 1,
      rawJsonDebugFilesWritten: 2
    });
  });

  it('rejects placeholder-heavy JSON as low quality', async () => {
    const result = await extractContentPageToMaterialPage({
      url: 'https://m3.material.io/components/experimental/overview',
      pageData: null,
      contentPage: {
        title: 'Experimental',
        sections: [{
          name: 'Overview',
          contentBlocks: [{
            contentChunks: [
              { contentChunkType: 'RESOURCE', libraryModuleType: 'EXPERIMENTAL_GRID', resourceName: 'experimental/grid' },
              { contentChunkType: 'RESOURCE', libraryModuleType: 'UNKNOWN_RESOURCE', resourceName: 'experimental/unknown' },
              { contentChunkType: 'CAROUSEL', slides: [] }
            ]
          }]
        }]
      },
      fetchResource: async () => null
    });

    expect(result.fallbackReason).toBe('json-low-quality');
  });
});
