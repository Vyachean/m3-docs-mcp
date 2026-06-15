import { readFileSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { pushPageDiagnostic, createEmptyExtractionDiagnostics } from '../src/json-extraction/diagnostics.js';
import { extractContentPageToMaterialPage } from '../src/json-extraction/extract-content-page.js';
import { extractPageDataMetadata } from '../src/json-extraction/extract-page-data.js';

const fixture = (name: string) => JSON.parse(readFileSync(path.join(process.cwd(), 'tests/fixtures/json-extraction', name), 'utf8'));

describe('JSON-first extraction', () => {
  it('extracts page metadata from page-data JSON', () => {
    const metadata = extractPageDataMetadata(fixture('page-data-dialogs.json'));
    expect(metadata).toEqual({
      title: 'Lists',
      pageCanonId: 'page-canon-lists',
      pathname: 'components/lists/overview'
    });
  });

  it('renders text sections from structured content JSON', async () => {
    const result = await extractContentPageToMaterialPage({
      url: 'https://m3.material.io/components/lists/overview',
      pageData: fixture('page-data-dialogs.json'),
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
      fetchResource: async (resourceName) => resourceName === 'TOKEN_TABLE.components.button.json' ? fixture('token-table-resource.json') : null
    });

    expect(result.fallbackReason).toBeNull();
    expect(result.page.markdown).toContain('| Token | Name | sys alias | ref alias | Light | Dark |');
    expect(result.page.markdown).toContain('md.comp.button.container.color');
    expect(result.page.markdown).toContain('md.sys.color.primary');
    expect(result.page.markdown).toContain('md.ref.palette.primary40');
    expect(result.page.markdown).toContain('| md.comp.button.container.height | Container height | md.sys.shape.corner.full |  |  |  |');
    expect(result.page.markdown).not.toContain('0dp');
    expect(result.pageDiagnostic.tokenTables).toBe(1);
    expect(result.pageDiagnostic.tokenTablesRendered).toBe(1);
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

  it('aggregates extraction diagnostics', () => {
    const diagnostics = createEmptyExtractionDiagnostics();
    pushPageDiagnostic(diagnostics, {
      url: 'https://m3.material.io/components/lists/overview',
      path: 'components/lists/overview.md',
      method: 'json',
      unknownChunkTypes: ['CAROUSEL'],
      unknownResourceTypes: ['EXPERIMENTAL_GRID'],
      tokenTables: 1,
      tokenTablesRendered: 1,
      missingRequestedTokenSets: ['Missing set'],
      suspiciousReasons: [],
      imageCount: 2,
      videoCount: 1,
      unresolvedResourceCount: 1,
      noSections: false,
      noHeadings: false,
      markdownLength: 120
    });

    expect(diagnostics).toMatchObject({
      totalPages: 1,
      pagesExtractedThroughJson: 1,
      pagesWithUnknownChunkTypes: 1,
      pagesWithUnknownResourceTypes: 1,
      pagesWithTokenTables: 1,
      tokenTablesSuccessfullyRendered: 1,
      tokenTablesMissingRequestedTokenSets: 1,
      imageCount: 2,
      videoCount: 1,
      unresolvedResourceCount: 1
    });
  });
});
