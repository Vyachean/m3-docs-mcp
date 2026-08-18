import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { writeIndex, writePage } from '../src/cache.js';
import type { MaterialIndex, MaterialPage } from '../src/types.js';

const mocks = vi.hoisted(() => ({
  crawlMaterialDocs: vi.fn()
}));

vi.mock('../src/crawler.js', () => ({
  crawlMaterialDocs: mocks.crawlMaterialDocs
}));

const { MaterialDocsStore } = await import('../src/store.js');

let cacheDir: string;

const buttonsOverview: MaterialPage = {
  id: 'buttons-overview',
  title: 'Overview',
  url: 'https://m3.material.io/components/buttons/overview',
  path: 'components/buttons/overview.md',
  section: 'components/buttons',
  headings: ['Buttons'],
  text: 'Buttons overview content.',
  markdown: '# Buttons\n\nButtons overview content that is long enough to truncate.',
  capturedAt: '2026-08-18T00:00:00.000Z'
};

const buttonsSpecs: MaterialPage = {
  ...buttonsOverview,
  id: 'buttons-specs',
  url: 'https://m3.material.io/components/buttons/specs',
  path: 'components/buttons/specs.md',
  headings: ['Buttons', 'Specs'],
  text: 'Buttons specification content.',
  markdown: '# Buttons specs\n\nButtons specification content.'
};

const checkboxesOverview: MaterialPage = {
  ...buttonsOverview,
  id: 'checkboxes-overview',
  url: 'https://m3.material.io/components/checkboxes/overview',
  path: 'components/checkboxes/overview.md',
  section: 'components/checkboxes',
  headings: ['Checkboxes'],
  text: 'Checkboxes overview content.',
  markdown: '# Checkboxes\n\nCheckboxes overview content.'
};

function indexFor(pages: MaterialPage[]): MaterialIndex {
  return {
    source: 'https://m3.material.io',
    capturedAt: '2026-08-18T00:00:00.000Z',
    pageCount: pages.length,
    attemptedPageCount: pages.length,
    failedPageCount: 0,
    failedUrls: [],
    pages: pages.map(({ text: _text, markdown: _markdown, ...meta }) => meta)
  };
}

async function seed(pages: MaterialPage[]): Promise<InstanceType<typeof MaterialDocsStore>> {
  await writeIndex(indexFor(pages), cacheDir);
  for (const page of pages) await writePage(page, cacheDir);
  return new MaterialDocsStore(cacheDir);
}

describe('MaterialDocsStore public behavior contracts', () => {
  beforeEach(async () => {
    cacheDir = await mkdtemp(path.join(tmpdir(), 'm3-docs-store-contracts-'));
    mocks.crawlMaterialDocs.mockReset();
  });

  afterEach(async () => {
    await rm(cacheDir, { recursive: true, force: true });
  });

  it('applies component result and markdown limits at the store boundary', async () => {
    const store = await seed([buttonsOverview, buttonsSpecs]);

    const result = await store.getComponentDocs('Buttons', {
      includeMarkdown: true,
      maxPages: 1,
      maxMarkdownChars: 18
    });

    expect(result).toEqual([{
      path: buttonsOverview.path,
      title: buttonsOverview.title,
      url: buttonsOverview.url,
      section: buttonsOverview.section,
      headings: buttonsOverview.headings,
      markdown: buttonsOverview.markdown.slice(0, 18)
    }]);
  });

  it('resolves common singular component names to plural cache routes without title matching', async () => {
    const store = await seed([buttonsOverview, checkboxesOverview]);

    await expect(store.getComponentDocs('button')).resolves.toEqual([{
      path: buttonsOverview.path,
      title: buttonsOverview.title,
      url: buttonsOverview.url,
      section: buttonsOverview.section,
      headings: buttonsOverview.headings
    }]);
    await expect(store.getComponentDocs('checkbox')).resolves.toEqual([{
      path: checkboxesOverview.path,
      title: checkboxesOverview.title,
      url: checkboxesOverview.url,
      section: checkboxesOverview.section,
      headings: checkboxesOverview.headings
    }]);
  });

  it('returns explicit empty diagnostics metadata when no diagnostics files exist', async () => {
    const store = new MaterialDocsStore(cacheDir);

    await expect(store.getDiagnostics()).resolves.toEqual({
      cacheDir,
      latestDiagnosticsFile: null,
      latestLogFile: null,
      diagnostics: null
    });
  });

  it('deduplicates concurrent refreshes and uses the first refresh contract', async () => {
    let resolveRefresh: (index: MaterialIndex) => void = () => undefined;
    const refreshResult = indexFor([buttonsOverview]);
    mocks.crawlMaterialDocs.mockImplementationOnce(() => new Promise<MaterialIndex>((resolve) => {
      resolveRefresh = resolve;
    }));
    const store = new MaterialDocsStore(cacheDir);

    const first = store.refresh({ maxPages: 5 });
    const second = store.refresh({ maxPages: 10, promotePartial: true });

    expect(mocks.crawlMaterialDocs).toHaveBeenCalledTimes(1);
    expect(mocks.crawlMaterialDocs).toHaveBeenCalledWith({
      cacheDir,
      maxPages: 5,
      promotePartial: false
    });

    resolveRefresh(refreshResult);
    await expect(Promise.all([first, second])).resolves.toEqual([refreshResult, refreshResult]);
  });

  it('derives promotePartial from refresh scope while preserving an explicit override', async () => {
    const refreshResult = indexFor([buttonsOverview]);
    mocks.crawlMaterialDocs.mockResolvedValue(refreshResult);
    const store = new MaterialDocsStore(cacheDir);

    await store.refresh();
    await store.refresh({ maxPages: 5 });
    await store.refresh({ maxPages: 5, promotePartial: true });

    expect(mocks.crawlMaterialDocs).toHaveBeenNthCalledWith(1, { cacheDir, promotePartial: true });
    expect(mocks.crawlMaterialDocs).toHaveBeenNthCalledWith(2, { cacheDir, maxPages: 5, promotePartial: false });
    expect(mocks.crawlMaterialDocs).toHaveBeenNthCalledWith(3, { cacheDir, maxPages: 5, promotePartial: true });
  });

  it('clears failed refresh ownership so a later explicit retry can run', async () => {
    const refreshResult = indexFor([buttonsOverview]);
    mocks.crawlMaterialDocs
      .mockRejectedValueOnce(new Error('refresh failed'))
      .mockResolvedValueOnce(refreshResult);
    const store = new MaterialDocsStore(cacheDir);

    await expect(store.refresh()).rejects.toThrow('refresh failed');
    await expect(store.refresh()).resolves.toBe(refreshResult);
    expect(mocks.crawlMaterialDocs).toHaveBeenCalledTimes(2);
  });
});
