import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { createCrawlQualityReport, discoverMaterialLinksFromHrefs, discoverPublicDocPathsFromHrefs, extractMaterialPageFromHtml, materialCrawlCandidates, normalizeMaterialCrawlUrl, resolvePlaywrightCliPath, validateCrawledPage } from '../src/crawler.js';

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

  it('derives fallback metadata from sanitized HTML', () => {
    const page = extractMaterialPageFromHtml(`
      <main>
        <script><h1>Script title</h1><h2>Script heading</h2></script>
        <style><h1>Style title</h1><h2>Style heading</h2></style>
        <h1>Safe title</h1>
        <h2>Safe heading</h2>
        <p>Safe content.</p>
      </main>
    `, 'https://m3.material.io/foundations/safe-metadata', '2026-05-18T00:00:00.000Z');

    expect(page.title).toBe('Safe title');
    expect(page.headings).toEqual(['Safe title', 'Safe heading']);
    expect(page.markdown).toContain('title: "Safe title"');
    expect(page.markdown).not.toContain('Script title');
    expect(page.markdown).not.toContain('Style title');
  });

  it('preserves legitimate JavaScript snippets while removing script tag contents', () => {
    const page = extractMaterialPageFromHtml(`
      <main>
        <h1>Implementation</h1>
        <p>Use the snippet below when wiring navigation.</p>
        <pre><code>window.location = nextUrl;
window.someConfig = { enabled: true };</code></pre>
        <script>window.noise = true;</script>
      </main>
    `, 'https://m3.material.io/develop/implementation', '2026-05-18T00:00:00.000Z');

    expect(page.markdown).toContain('window.location = nextUrl;');
    expect(page.markdown).toContain('window.someConfig = { enabled: true };');
    expect(page.text).toContain('window.location = nextUrl;');
    expect(page.markdown).not.toContain('window.noise');
  });

  it('removes repeated material UI chrome and preserves do/dont guidance text', () => {
    const page = extractMaterialPageFromHtml(`
      <main>
        <h1>App bars</h1>
        <p>App bars are placed at the top of the screen.</p>
        <p>Resourcesflutterandroid+3</p>
        <p>Close</p>
        <p>[infoOverview](components/app-bars/overview)[styleSpecs](components/app-bars/specs)</p>
        <p>On this page</p>
        <p>link</p>
        <p>Copy linkLink copied</p>
        <h2>Usage</h2>
        <p>Use an app bar to provide content and actions related to the current page.</p>
        <p>check Do</p>
        <p>Use a filled or tonal button for important actions</p>
        <p>close Don’t</p>
        <p>Don’t put multiple filled or tonal buttons in the app bar</p>
      </main>
    `, 'https://m3.material.io/components/app-bars/guidelines', '2026-05-18T00:00:00.000Z');

    expect(page.markdown).toContain('# App bars');
    expect(page.markdown).toContain('## Usage');
    expect(page.markdown).toContain('Do');
    expect(page.markdown).toContain(`Don't`);
    expect(page.markdown).toContain('Use a filled or tonal button for important actions');
    expect(page.markdown).not.toContain('Resourcesflutterandroid+3');
    expect(page.markdown).not.toContain('Copy linkLink copied');
    expect(page.markdown).not.toContain('On this page');
    expect(page.markdown).not.toContain('[infoOverview]');
    expect(page.text).toContain('Use an app bar to provide content and actions related to the current page.');
    expect(page.text).not.toContain('Copy linkLink copied');
  });

  it('drops token-browser chrome while preserving narrative specs content and measurements', () => {
    const page = extractMaterialPageFromHtml(`
      <main>
        <h1>Bottom sheets</h1>
        <p>Bottom sheets show secondary content anchored to the bottom of the screen.</p>
        <h2>Tokens and specs</h2>
        <p>Browse the component elements, attributes, tokens, and their values.</p>
        <p>Sheets - Bottom arrow_drop_down</p>
        <p>search</p>
        <p>visibilitygrid_viewexpand_all</p>
        <p>Token</p>
        <p>Default, Light arrow_drop_down</p>
        <p>folderEnabled</p>
        <p>keyboard_arrow_down</p>
        <h2>Measurements</h2>
        <p>Attribute</p>
        <p>Value</p>
        <p>Top margin</p>
        <p>72dp</p>
        <p>Width</p>
        <p>Full width, up to max-width 640dp</p>
      </main>
    `, 'https://m3.material.io/components/bottom-sheets/specs', '2026-05-18T00:00:00.000Z');

    expect(page.markdown).toContain('## Tokens and specs');
    expect(page.markdown).toContain('Browse the component elements, attributes, tokens, and their values.');
    expect(page.markdown).toContain('## Measurements');
    expect(page.markdown).toContain('Top margin');
    expect(page.markdown).toContain('72dp');
    expect(page.markdown).toContain('Full width, up to max-width 640dp');
    expect(page.markdown).not.toContain('arrow_drop_down');
    expect(page.markdown).not.toContain('folderEnabled');
    expect(page.markdown).not.toContain('visibilitygrid_viewexpand_all');
    expect(page.markdown).not.toContain('\nToken\n');
  });
});

describe('Material crawl URL handling', () => {
  it('resolves the Playwright CLI from the package bin entry', () => {
    const cliPath = resolvePlaywrightCliPath();

    expect(cliPath).toBe(path.join(path.dirname(require.resolve('playwright/package.json')), 'cli.js'));
  });

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

describe('discoverPublicDocPathsFromHrefs', () => {
  it('normalizes public documentation paths and filters assets and service URLs', () => {
    expect(discoverPublicDocPathsFromHrefs([
      'https://m3.material.io/components/dialogs?tab=usage#actions',
      '/components/dialogs/',
      '/styles/color',
      '/foundations/accessibility',
      '/assets/logo.svg',
      '/static/angular/main.abcdef12.js',
      'https://m3.material.io/_dsm/content/m3/cv-123/page.json',
      'https://example.com/components/dialogs'
    ], 'https://m3.material.io')).toEqual([
      '/components/dialogs',
      '/foundations/accessibility',
      '/styles/color'
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

  it('does not require non-component route titles to match their leaf slug', () => {
    const page = extractMaterialPageFromHtml(`
      <main>
        <h1>Material A-Z</h1>
        <p>Material terms and definitions with enough text for crawler validation.</p>
      </main>
    `, 'https://m3.material.io/foundations/glossary', '2026-05-18T00:00:00.000Z');

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

  it('rejects alternate not found page variants', () => {
    const page = extractMaterialPageFromHtml(`
      <main>
        <h1>Page not found</h1>
        <p>We could not find that page. Try a different destination.</p>
      </main>
    `, 'https://m3.material.io/foundations/layout-overview/adaptive-design', '2026-05-18T00:00:00.000Z');

    expect(validateCrawledPage(page)).toMatchObject({
      path: 'foundations/layout-overview/adaptive-design.md',
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

  it('accepts acronymized component names when the route content matches', () => {
    const page = extractMaterialPageFromHtml(`
      <main>
        <h1>FABs Specs</h1>
        <p>Use the FAB for the most important action on a screen.</p>
      </main>
    `, 'https://m3.material.io/components/floating-action-button/specs', '2026-06-28T00:00:00.000Z');

    expect(validateCrawledPage(page)).toBeNull();
  });
});

describe('createCrawlQualityReport', () => {
  it('reports duplicate content, duplicate titles, short pages, and section counts', () => {
    const body = 'Buttons prompt most actions in a UI. Buttons are available in several variants and should communicate the action they perform. Use buttons for actions that affect the current screen, flow, or selected content. Button labels should be concise, specific, and easy to scan.';
    const first = extractMaterialPageFromHtml(`<main><h1>Buttons</h1><p>${body}</p></main>`, 'https://m3.material.io/components/buttons/overview', '2026-05-18T00:00:00.000Z');
    const duplicate = { ...first, id: 'duplicate', url: 'https://m3.material.io/foundations/duplicate-buttons', path: 'foundations/duplicate-buttons.md', section: 'foundations' };
    const short = extractMaterialPageFromHtml('<main><h1>Short</h1><p>Brief.</p></main>', 'https://m3.material.io/get-started', '2026-05-18T00:00:00.000Z');

    const report = createCrawlQualityReport([first, duplicate, short], [{
      url: 'https://m3.material.io/foundations/layout-overview/adaptive-design',
      path: 'foundations/layout-overview/adaptive-design.md',
      title: 'Page not found',
      reason: 'route rendered a not found page'
    }]);

    expect(report.duplicateContent).toEqual([{ hash: expect.any(String), title: 'Buttons', paths: ['components/buttons/overview.md', 'foundations/duplicate-buttons.md'], urls: ['https://m3.material.io/components/buttons/overview', 'https://m3.material.io/foundations/duplicate-buttons'] }]);
    expect(report.duplicateTitles).toEqual([{ title: 'Buttons', count: 2, paths: ['components/buttons/overview.md', 'foundations/duplicate-buttons.md'] }]);
    expect(report.shortPages).toContainEqual({ url: 'https://m3.material.io/get-started', path: 'get-started.md', title: 'Short', textLength: expect.any(Number) });
    expect(report.rejectedRoutes).toEqual([{
      url: 'https://m3.material.io/foundations/layout-overview/adaptive-design',
      path: 'foundations/layout-overview/adaptive-design.md',
      title: 'Page not found',
      reason: 'route rendered a not found page',
      classification: 'not-found',
      status: 'failed'
    }]);
    expect(report.suspiciousPages).toEqual([]);
    expect(report.pagesBySection).toEqual({ 'components/buttons': 1, foundations: 1, root: 1 });
  });
});
