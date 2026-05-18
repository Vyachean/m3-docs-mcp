import { describe, expect, it } from 'vitest';
import { discoverMaterialLinksFromHrefs, extractMaterialPageFromHtml } from '../src/crawler.js';

describe('extractMaterialPageFromHtml', () => {
  it('extracts metadata, readable text, and markdown from a Material documentation fixture', () => {
    const page = extractMaterialPageFromHtml(`
      <main>
        <h1>Dialogs</h1>
        <p>Dialogs provide important prompts &amp; decisions.</p>
        <h2>Usage</h2>
        <p>Use dialogs for focused tasks.</p>
        <script>window.noise = true;</script>
      </main>
    `, 'https://m3.material.io/components/dialogs/overview', '2026-05-18T00:00:00.000Z');

    expect(page).toMatchObject({
      id: expect.stringMatching(/^[a-f0-9]{16}$/),
      title: 'Dialogs',
      url: 'https://m3.material.io/components/dialogs/overview',
      path: 'components/dialogs/overview.md',
      section: 'components/dialogs',
      headings: ['Dialogs', 'Usage'],
      capturedAt: '2026-05-18T00:00:00.000Z'
    });
    expect(page.text).toContain('Dialogs provide important prompts & decisions.');
    expect(page.text).not.toContain('window.noise');
    expect(page.markdown).toContain('title: "Dialogs"');
    expect(page.markdown).toContain('sourceUrl: https://m3.material.io/components/dialogs/overview');
    expect(page.markdown).toContain('# Dialogs');
    expect(page.markdown).toContain('## Usage');
  });

  it('falls back to a generic title when the fixture has no h1', () => {
    const page = extractMaterialPageFromHtml('<main><p>Only paragraph text.</p></main>', 'https://m3.material.io/foundations', '2026-05-18T00:00:00.000Z');

    expect(page.title).toBe('Material 3 page');
    expect(page.headings).toEqual([]);
    expect(page.path).toBe('foundations.md');
    expect(page.section).toBe('root');
  });
});

describe('discoverMaterialLinksFromHrefs', () => {
  it('normalizes, filters, and deduplicates crawl links', () => {
    expect(discoverMaterialLinksFromHrefs([
      'https://m3.material.io/components/dialogs/overview?tab=usage#actions',
      '/components/dialogs/overview/',
      '/components/buttons/overview',
      '/assets/logo.svg',
      'https://example.com/components/dialogs'
    ], 'https://m3.material.io')).toEqual([
      'https://m3.material.io/components/dialogs/overview',
      'https://m3.material.io/components/buttons/overview'
    ]);
  });
});
