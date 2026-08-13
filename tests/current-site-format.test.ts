import { readFileSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { extractContentPageToMaterialPage } from '../src/json-extraction/extract-content-page.js';
import { buildDsdbResourceCandidateUrls } from '../src/json-extraction/fetch-json-page.js';

const tokenTableResource = JSON.parse(readFileSync(path.join(process.cwd(), 'tests/fixtures/json-extraction/token-table-resource.json'), 'utf8')) as unknown;

describe('current Material site formats', () => {
  it('builds the current TYPOGRAPHY DSDB resource URL', () => {
    expect(buildDsdbResourceCandidateUrls('https://m3.material.io', '2026-08-12_10-00-15', 'designSystems/20543ce18892f7d9', 'TYPOGRAPHY')[0]).toBe('https://m3.material.io/_dsm/data/dsdb-m3/2026-08-12_10-00-15/TYPOGRAPHY.20543ce18892f7d9.json');
  });

  it('treats EMPTY content chunks as intentional no-op content', async () => {
    const result = await extractContentPageToMaterialPage({
      url: 'https://m3.material.io/components',
      pageData: null,
      contentPage: {
        title: 'Components',
        sections: [{ title: 'Catalog', contentBlocks: [{ title: 'Buttons', contentChunks: [
          { contentChunkType: 'TEXT', htmlValue: '<p>Material components are interactive building blocks for creating a user interface. Browse the catalog to choose controls and patterns for product experiences.</p>' },
          { contentChunkType: 'EMPTY' }
        ] }] }]
      },
      fetchResource: async () => null
    });
    expect(result.fallbackReason).toBeNull();
    expect(result.pageDiagnostic.unknownChunkTypes).toEqual([]);
    expect(result.pageDiagnostic.unresolvedResourceCount).toBe(0);
    expect(result.page.markdown).not.toContain('Unsupported Material chunk: EMPTY');
  });

  it('renders TYPOGRAPHY resources through the token-system pipeline', async () => {
    const result = await extractContentPageToMaterialPage({
      url: 'https://m3.material.io/styles/typography/type-scale-tokens',
      pageData: null,
      contentPage: {
        title: 'Type scale & tokens',
        sections: [{ title: 'Type scale & tokens', contentBlocks: [{ title: 'Baseline type style tokens', contentChunks: [{
          contentChunkType: 'RESOURCE',
          libraryModuleType: 'TYPOGRAPHY',
          resourceName: 'designSystems/20543ce18892f7d9',
          moduleConfigurationOverrides: { tokenSets: ['Button - Common'] }
        }] }] }]
      },
      fetchResource: async (resourceName, resourceType) => resourceType === 'TYPOGRAPHY' && resourceName === 'designSystems/20543ce18892f7d9' ? tokenTableResource : null
    });
    expect(result.fallbackReason).toBeNull();
    expect(result.page.markdown).toContain('md.comp.button.container.color');
    expect(result.pageDiagnostic.unknownResourceTypes).toEqual([]);
    expect(result.pageDiagnostic.unresolvedResourceCount).toBe(0);
    expect(result.pageDiagnostic.tokenTablesRendered).toBe(1);
  });
});
