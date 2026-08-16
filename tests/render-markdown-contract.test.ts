import { describe, expect, it } from 'vitest';
import {
  createMaterialPageFromBody,
  extractMaterialPageFromHtml,
  markdownTable,
  preferLargeImageUrl,
  renderDecodedSections,
  renderHtmlToMarkdown,
  renderImageMarkdown,
  renderResourcePlaceholder,
  renderStatusTableMarkdown,
  renderVideoMarkdown,
  stripMarkdown
} from '../src/json-extraction/render-markdown.js';
import type { DecodedContentSection } from '../src/json-extraction/schemas.js';

describe('createMaterialPageFromBody', () => {
  it('builds stable page metadata, frontmatter, path, section, and plain text', () => {
    const page = createMaterialPageFromBody({
      url: 'https://m3.material.io/components/buttons/specs',
      capturedAt: '2026-08-17T00:00:00.000Z',
      title: 'Buttons "specs"',
      headings: ['Buttons', 'Sizing'],
      body: '  # Buttons\n\nUse **strong** [guidance](https://example.test) and ![diagram](https://example.test/image).  '
    });

    expect(page).toMatchObject({
      title: 'Buttons "specs"',
      url: 'https://m3.material.io/components/buttons/specs',
      path: 'components/buttons/specs.md',
      section: 'components/buttons',
      headings: ['Buttons', 'Sizing'],
      text: 'Buttons Use strong guidance and diagram.',
      capturedAt: '2026-08-17T00:00:00.000Z'
    });
    expect(page.id).toMatch(/^[a-f0-9]{16}$/);
    expect(page.markdown).toContain('title: "Buttons \\"specs\\""');
    expect(page.markdown).toContain('sourceUrl: https://m3.material.io/components/buttons/specs');
    expect(page.markdown).toContain('section: components/buttons');
    expect(page.markdown).toContain('capturedAt: 2026-08-17T00:00:00.000Z');
    expect(page.markdown).toContain('\n\n# Buttons\n');
  });
});

describe('standalone media and placeholder rendering', () => {
  it('renders images with preferred sizing, captions, and empty-url handling', () => {
    expect(renderImageMarkdown(' https://example.test/image=w40 ', 'Diagram', ' Caption ')).toBe(
      '![Diagram](https://example.test/image=w1600)\n\nCaption'
    );
    expect(renderImageMarkdown('https://example.test/image=w1200', null, null)).toBe(
      '![](https://example.test/image=w1200)'
    );
    expect(renderImageMarkdown('   ', 'Ignored')).toBe('');
    expect(renderImageMarkdown(null)).toBe('');
  });

  it('renders linked and unlinked videos using title/alt fallback order', () => {
    expect(renderVideoMarkdown({
      url: ' https://example.test/demo.mp4 ',
      title: ' Demo ',
      altText: 'Alternative',
      footer: ' Footer '
    })).toBe('[Video: Demo](https://example.test/demo.mp4)\n\nFooter');

    expect(renderVideoMarkdown({ title: ' ', altText: ' Alternative ' })).toBe('Video: Alternative');
    expect(renderVideoMarkdown({})).toBe('Video: Video');
  });

  it('renders resource placeholders with an explicit label and compact details', () => {
    expect(renderResourcePlaceholder('UNKNOWN_RESOURCE', { resource: 'button', reason: 'missing' })).toBe(
      '> Material resource placeholder: UNKNOWN_RESOURCE\n> {"resource":"button","reason":"missing"}'
    );
  });
});

describe('markdown tables', () => {
  it('returns empty output for empty/zero-width tables and pads ragged rows', () => {
    expect(markdownTable([])).toBe('');
    expect(markdownTable([[]])).toBe('');
    expect(markdownTable([
      ['', 'Value'],
      ['Android'],
      ['Web', 'Available']
    ])).toBe(
      '\n\n| Column 1 | Value |\n| --- | --- |\n| Android |  |\n| Web | Available |\n\n'
    );
  });

  it('renders decoded status tables through the same table contract', () => {
    expect(renderStatusTableMarkdown({
      headers: ['Platform', 'Status'],
      rows: [['Android', 'Available']]
    })).toContain('| Android | Available |');
  });
});

describe('renderDecodedSections', () => {
  it('preserves section/block/chunk order and trims rendered chunks', async () => {
    const sections: DecodedContentSection[] = [{
      title: ' Overview ',
      blocks: [{
        title: ' Usage ',
        chunks: [
          { value: 'first' },
          { value: 'second' }
        ]
      }]
    }, {
      title: ' ',
      blocks: [{ title: null, chunks: [{ value: 'third' }] }]
    }];

    await expect(renderDecodedSections(sections, async (chunk) => `  ${chunk.value ?? ''}  `)).resolves.toEqual([
      '## Overview',
      '### Usage',
      'first',
      'second',
      'third'
    ]);
  });
});

describe('Markdown normalization utilities', () => {
  it('only enlarges undersized Material image parameters', () => {
    expect(preferLargeImageUrl('https://example.test/a=w40')).toBe('https://example.test/a=w1600');
    expect(preferLargeImageUrl('https://example.test/a=w799-c')).toBe('https://example.test/a=w1600-c');
    expect(preferLargeImageUrl('https://example.test/a=w800')).toBe('https://example.test/a=w800');
    expect(preferLargeImageUrl('https://example.test/a=s0')).toBe('https://example.test/a=w1600');
  });

  it('strips Markdown presentation while retaining human-readable labels', () => {
    expect(stripMarkdown(
      '# Heading\n\nUse **bold**, `code`, [guidance](https://example.test), and ![diagram](https://example.test/image).'
    )).toBe('Heading\nUse bold, code, guidance, and diagram.');
  });

  it('normalizes known UI text and punctuation after HTML conversion', () => {
    const markdown = renderHtmlToMarkdown('<p>check do</p><p>close don\'t</p><p>Hello  ,  world !</p>');
    expect(markdown).toContain('Do');
    expect(markdown).toContain("Don't");
    expect(markdown).toContain('Hello, world!');
    expect(markdown).not.toContain('check do');
    expect(markdown).not.toContain('close don');
  });

  it('sanitizes unsafe HTML and honors trimmed metadata overrides', () => {
    const page = extractMaterialPageFromHtml(
      '<main><h1>Original</h1><script>danger()</script><style>.bad{}</style><noscript>noise</noscript><p>Safe text.</p></main>',
      'https://m3.material.io/foundations/safe',
      '2026-08-17T00:00:00.000Z',
      { title: ' Override ', headings: [' One ', ' ', 'Two '] }
    );

    expect(page.title).toBe('Override');
    expect(page.headings).toEqual(['One', 'Two']);
    expect(page.markdown).toContain('Safe text.');
    expect(page.markdown).not.toContain('danger');
    expect(page.markdown).not.toContain('.bad');
    expect(page.markdown).not.toContain('noise');
  });
});
