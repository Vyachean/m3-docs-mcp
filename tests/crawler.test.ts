import { describe, expect, it } from 'vitest';
import { createCrawlQualityReport, discoverMaterialLinksFromHrefs, extractMaterialPageFromHtml, materialCrawlCandidates, normalizeMaterialCrawlUrl, validateCrawledPage } from '../src/crawler.js';

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

describe('Material crawl URL handling', () => {
  it('normalizes crawl URLs without inventing route structure', () => {
    expect(normalizeMaterialCrawlUrl('/components/buttons?tab=usage#actions', 'https://m3.material.io')).toBe('https://m3.material.io/components/buttons');
    expect(normalizeMaterialCrawlUrl('https://m3.material.io/components/dialogs/', 'https://m3.material.io')).toBe('https://m3.material.io/components/dialogs');
    expect(normalizeMaterialCrawlUrl('/components/button-groups/overview', 'https://m3.material.io')).toBe('https://m3.material.io/components/button-groups/overview');
  });

  it('adds component overview fallback candidates only for component landing links', () => {
    expect(materialCrawlCandidates('/components/buttons?tab=usage#actions', 'https://m3.material.io')).toEqual([
      'https://m3.material.io/components/buttons',
      'https://m3.material.io/components/buttons/overview'
    ]);
    expect(materialCrawlCandidates('/components/all-buttons', 'https://m3.material.io')).toEqual([
      'https://m3.material.io/components/all-buttons',
      'https://m3.material.io/components/all-buttons/overview'
    ]);
    expect(materialCrawlCandidates('/components/button-groups/overview', 'https://m3.material.io')).toEqual([
      'https://m3.material.io/components/button-groups/overview'
    ]);
  });
});

describe('discoverMaterialLinksFromHrefs', () => {
  it('normalizes, filters, deduplicates, and prioritizes crawl links', () => {
    expect(discoverMaterialLinksFromHrefs([
      'https://m3.material.io/components/dialogs?tab=usage#actions',
      '/components/dialogs/',
      '/components/buttons',
      '/foundations/layout/canonical-layouts',
      '/assets/logo.svg',
      'https://example.com/components/dialogs'
    ], 'https://m3.material.io')).toEqual([
      'https://m3.material.io/components/buttons',
      'https://m3.material.io/components/dialogs',
      'https://m3.material.io/foundations/layout/canonical-layouts'
    ]);
  });
});

describe('validateCrawledPage', () => {
  it('accepts component routes whose content matches the requested component', () => {
    const page = extractMaterialPageFromHtml(`
      <main>
        <h1>Buttons</h1>
        <p>Buttons prompt most actions in a UI.</p>
      </main>
    `, 'https://m3.material.io/components/buttons/overview', '2026-05-18T00:00:00.000Z');

    expect(validateCrawledPage(page)).toBeNull();
  });

  it('accepts non-component routes whose content matches the leaf slug', () => {
    const page = extractMaterialPageFromHtml(`
      <main>
        <h1>Canonical layouts</h1>
        <p>Canonical layouts help teams adapt applications across screen sizes.</p>
      </main>
    `, 'https://m3.material.io/foundations/layout/canonical-layouts', '2026-05-18T00:00:00.000Z');

    expect(validateCrawledPage(page)).toBeNull();
  });

  it('rejects component routes that render the parent Components index', () => {
    const page = extractMaterialPageFromHtml(`
      <main>
        <h1>Components</h1>
        <p>Components are interactive building blocks.</p>
        <h2>Buttons</h2>
        <p>Buttons prompt most actions in a UI.</p>
      </main>
    `, 'https://m3.material.io/components/buttons/overview', '2026-05-18T00:00:00.000Z');

    expect(validateCrawledPage(page)).toMatchObject({
      path: 'components/buttons/overview.md',
      title: 'Components',
      reason: 'component route rendered the parent Components index instead of buttons'
    });
  });

  it('rejects not found pages', () => {
    const page = extractMaterialPageFromHtml(`
      <main>
        <h1>This page cannot be found</h1>
        <p>Try a different destination or head back to the homepage.</p>
      </main>
    `, 'https://m3.material.io/components/fabs', '2026-05-18T00:00:00.000Z');

    expect(validateCrawledPage(page)).toMatchObject({
      path: 'components/fabs.md',
      reason: 'route rendered a not found page'
    });
  });

  it('rejects component routes that do not mention the expected component slug', () => {
    const page = extractMaterialPageFromHtml(`
      <main>
        <h1>Dialogs</h1>
        <p>Dialogs provide important prompts in a user flow.</p>
      </main>
    `, 'https://m3.material.io/components/buttons/overview', '2026-05-18T00:00:00.000Z');

    expect(validateCrawledPage(page)).toMatchObject({
      path: 'components/buttons/overview.md',
      reason: 'component route content does not mention expected component slug buttons'
    });
  });

  it('rejects non-component routes that render unrelated content', () => {
    const page = extractMaterialPageFromHtml(`
      <main>
        <h1>Components</h1>
        <p>Components are interactive building blocks.</p>
      </main>
    `, 'https://m3.material.io/foundations/layout/canonical-layouts', '2026-05-18T00:00:00.000Z');

    expect(validateCrawledPage(page)).toMatchObject({
      path: 'foundations/layout/canonical-layouts.md',
      reason: 'route content does not mention expected slug canonical-layouts'
    });
  });
});

describe('createCrawlQualityReport', () => {
  it('reports duplicate content, duplicate titles, short pages, and section counts', () => {
    const body = 'Buttons prompt most actions in a UI. Buttons are available in several variants and should communicate the action they perform. Use buttons for actions that affect the current screen, flow, or selected content. Button labels should be concise, specific, and easy to scan.';
    const first = extractMaterialPageFromHtml(`<main><h1>Buttons</h1><p>${body}</p></main>`, 'https://m3.material.io/components/buttons/overview', '2026-05-18T00:00:00.000Z');
    const duplicate = { ...first, id: 'duplicate', url: 'https://m3.material.io/components/icon-buttons/overview', path: 'components/icon-buttons/overview.md', section: 'components/icon-buttons' };
    const short = extractMaterialPageFromHtml('<main><h1>Short</h1><p>Brief.</p></main>', 'https://m3.material.io/get-started', '2026-05-18T00:00:00.000Z');

    const report = createCrawlQualityReport([first, duplicate, short]);

    expect(report.duplicateContent).toEqual([{ hash: expect.any(String), title: 'Buttons', paths: ['components/buttons/overview.md', 'components/icon-buttons/overview.md'], urls: ['https://m3.material.io/components/buttons/overview', 'https://m3.material.io/components/icon-buttons/overview'] }]);
    expect(report.duplicateTitles).toEqual([{ title: 'Buttons', count: 2, paths: ['components/buttons/overview.md', 'components/icon-buttons/overview.md'] }]);
    expect(report.shortPages).toContainEqual({ url: 'https://m3.material.io/get-started', path: 'get-started.md', title: 'Short', textLength: expect.any(Number) });
    expect(report.pagesBySection).toEqual({ 'components/buttons': 1, 'components/icon-buttons': 1, root: 1 });
  });
});
