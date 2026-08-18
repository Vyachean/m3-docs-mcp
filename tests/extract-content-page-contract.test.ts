import { describe, expect, it } from 'vitest';
import { extractContentPageToMaterialPage } from '../src/json-extraction/extract-content-page.js';

const LONG_TEXT = 'Material components use explicit structure, hierarchy, semantics, and interaction guidance so applications remain understandable and consistent across supported platforms.';

function contentPage(title = 'Buttons') {
  return {
    title,
    sections: [
      {
        title: 'Overview',
        blocks: [{ title: 'Usage', chunks: [{ htmlValue: `<p>${LONG_TEXT}</p>` }] }]
      }
    ]
  };
}

const noResource = async () => null;

describe('extractContentPageToMaterialPage page composition', () => {
  it('honors title overrides, selected section indices, and capturedAt', async () => {
    const capturedAt = '2026-08-17T00:00:00.000Z';
    const result = await extractContentPageToMaterialPage({
      url: 'https://m3.material.io/components/buttons/specs',
      pageData: { title: 'Page-data title' },
      contentPage: {
        title: 'Original title',
        sections: [
          { title: 'Overview', blocks: [{ chunks: [{ htmlValue: `<p>${LONG_TEXT}</p>` }] }] },
          { title: 'Specifications', blocks: [{ title: 'Sizing', chunks: [{ htmlValue: `<p>${LONG_TEXT} Specifications are selected for this tab.</p>` }] }] }
        ]
      },
      capturedAt,
      fetchResource: noResource,
      sectionIndices: [1, 99],
      titleOverride: 'Button specifications'
    });

    expect(result.fallbackReason).toBeNull();
    expect(result.page.title).toBe('Button specifications');
    expect(result.page.headings).toEqual(['Button specifications', 'Specifications']);
    expect(result.page.capturedAt).toBe(capturedAt);
    expect(result.page.path).toBe('components/buttons/specs.md');
    expect(result.page.markdown).toContain('# Button specifications');
    expect(result.page.markdown).toContain('## Specifications');
    expect(result.page.markdown).toContain('### Sizing');
    expect(result.page.markdown).not.toContain('## Overview');
    expect(result.pageDiagnostic.noSections).toBe(false);
    expect(result.pageDiagnostic.hasTitle).toBe(true);
  });

  it('renders fallback HTML but still reports that structured sections are missing', async () => {
    const result = await extractContentPageToMaterialPage({
      url: 'https://m3.material.io/foundations/fallback',
      pageData: null,
      contentPage: { title: 'Fallback page', htmlValue: `<p>${LONG_TEXT}</p>` },
      fetchResource: noResource
    });

    expect(result.page.markdown).toContain(LONG_TEXT);
    expect(result.pageDiagnostic.noSections).toBe(true);
    expect(result.fallbackReason).toBe('json-no-sections');
    expect(result.pageDiagnostic.suspiciousReasons).toContain('json-no-sections');
  });
});

describe('extractContentPageToMaterialPage route identity', () => {
  it('accepts source, canonical, and virtual routes supplied by the route plan', async () => {
    for (const pathname of ['/components/buttons', '/components/buttons/overview', '/components/buttons/specs']) {
      const result = await extractContentPageToMaterialPage({
        url: 'https://m3.material.io/components/buttons/specs',
        pageData: { title: 'Buttons', path: pathname },
        contentPage: contentPage(),
        fetchResource: noResource,
        routeValidation: {
          sourceRoute: '/components/buttons',
          canonicalRoute: '/components/buttons/overview',
          virtualRoute: '/components/buttons/specs'
        }
      });

      expect(result.pageDiagnostic.actualRoute).toBe(pathname);
      expect(result.pageDiagnostic.expectedRoute).toBe('/components/buttons/specs');
      expect(result.pageDiagnostic.routeTitlePathMismatch).toBe(false);
      expect(result.fallbackReason).toBeNull();
    }
  });

  it('reports a route mismatch when neither route nor page identity matches', async () => {
    const result = await extractContentPageToMaterialPage({
      url: 'https://m3.material.io/components/buttons/specs',
      pageData: { title: 'Dialogs', path: '/components/dialogs', pageCanonId: 'dialogs-canon' },
      contentPage: contentPage('Dialogs'),
      fetchResource: noResource,
      routeValidation: {
        sourceRoute: '/components/buttons',
        canonicalRoute: '/components/buttons/overview',
        virtualRoute: '/components/buttons/specs',
        expectedPageCanonId: 'buttons-canon'
      }
    });

    expect(result.pageDiagnostic.routeTitlePathMismatch).toBe(true);
    expect(result.pageDiagnostic.actualRoute).toBe('/components/dialogs');
    expect(result.pageDiagnostic.pageCanonId).toBe('dialogs-canon');
    expect(result.fallbackReason).toBe('json-route-mismatch');
  });

  it('accepts a mismatched route when the canonical page identity matches case-insensitively', async () => {
    const result = await extractContentPageToMaterialPage({
      url: 'https://m3.material.io/components/buttons/specs',
      pageData: { title: 'Dialogs', path: '/components/dialogs', pageCanonId: 'BUTTONS-CANON' },
      contentPage: contentPage('Dialogs'),
      fetchResource: noResource,
      routeValidation: { expectedPageCanonId: 'buttons-canon' }
    });

    expect(result.pageDiagnostic.routeTitlePathMismatch).toBe(false);
    expect(result.pageDiagnostic.pageCanonId).toBe('BUTTONS-CANON');
    expect(result.fallbackReason).toBeNull();
  });

  it('uses exportedCarbonFileId as the fallback expected page identity', async () => {
    const page = contentPage('Dialogs') as Record<string, unknown>;
    page.pageCanonicalId = 'BUTTONS-CANON';
    const result = await extractContentPageToMaterialPage({
      url: 'https://m3.material.io/components/buttons/specs',
      pageData: { title: 'Dialogs', path: '/components/dialogs' },
      contentPage: page,
      fetchResource: noResource,
      routeValidation: { exportedCarbonFileId: 'buttons-canon.json' }
    });

    expect(result.pageDiagnostic.pageCanonId).toBe('BUTTONS-CANON');
    expect(result.pageDiagnostic.exportedCarbonFileId).toBe('buttons-canon.json');
    expect(result.pageDiagnostic.routeTitlePathMismatch).toBe(false);
    expect(result.fallbackReason).toBeNull();
  });
});

describe('extractContentPageToMaterialPage fallback and inferred chunk contracts', () => {
  it('gives a missing title precedence over other quality failures', async () => {
    const result = await extractContentPageToMaterialPage({
      url: 'https://m3.material.io/foundations/untitled',
      pageData: null,
      contentPage: {
        sections: [{ title: 'Section', blocks: [{ chunks: [{ htmlValue: `<p>${LONG_TEXT}</p>` }] }] }]
      },
      fetchResource: noResource
    });

    expect(result.page.title).toBe('Material 3 page');
    expect(result.pageDiagnostic.hasTitle).toBe(false);
    expect(result.fallbackReason).toBe('json-title-missing');
  });

  it('reports short content before the general quality threshold', async () => {
    const result = await extractContentPageToMaterialPage({
      url: 'https://m3.material.io/foundations/short',
      pageData: null,
      contentPage: {
        title: 'Short page',
        sections: [{ title: 'Overview', blocks: [{ chunks: [{ htmlValue: '<p>Short.</p>' }] }] }]
      },
      fetchResource: noResource
    });

    expect(result.pageDiagnostic.hasTitle).toBe(true);
    expect(result.pageDiagnostic.noSections).toBe(false);
    expect(result.fallbackReason).toBe('json-suspicious-content');
  });

  it('infers text, image, video, resource, and unknown chunks when explicit type fields are absent', async () => {
    const result = await extractContentPageToMaterialPage({
      url: 'https://m3.material.io/foundations/inferred-content',
      pageData: null,
      contentPage: {
        title: 'Inferred content',
        sections: [{
          title: 'Media',
          blocks: [{
            chunks: [
              { htmlValue: `<p>${LONG_TEXT}</p>` },
              { src: 'https://example.test/image=w40', alt: 'Example image', caption: 'Image caption' },
              { embedUrl: 'https://example.test/video', title: 'Demo', description: 'Video footer' },
              { libraryModuleType: 'UNSUPPORTED_WIDGET', resourceName: 'resource-1' },
              { mystery: 'value' }
            ]
          }]
        }]
      },
      fetchResource: noResource
    });

    expect(result.page.markdown).toContain(LONG_TEXT);
    expect(result.page.markdown).toContain('![Example image](https://example.test/image=w1600)');
    expect(result.page.markdown).toContain('Image caption');
    expect(result.page.markdown).toContain('[Video: Demo](https://example.test/video)');
    expect(result.page.markdown).toContain('Video footer');
    expect(result.page.markdown).toContain('Material resource placeholder: UNSUPPORTED_WIDGET');
    expect(result.page.markdown).toContain('Unsupported Material chunk: UNKNOWN_CHUNK');
    expect(result.pageDiagnostic.imageCount).toBe(1);
    expect(result.pageDiagnostic.videoCount).toBe(1);
    expect(result.pageDiagnostic.unknownResourceTypes).toContain('UNSUPPORTED_WIDGET');
    expect(result.pageDiagnostic.unknownChunkTypes).toContain('UNKNOWN_CHUNK');
    expect(result.pageDiagnostic.unresolvedResourceCount).toBe(2);
  });
});
