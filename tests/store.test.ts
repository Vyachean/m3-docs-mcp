import { mkdtemp, rm, utimes } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { indexPath, writeIndex, writePage } from '../src/cache.js';
import { MaterialDocsStore } from '../src/store.js';
import type { MaterialIndex, MaterialPage } from '../src/types.js';

let cacheDir: string;

const dialogPage: MaterialPage = {
  id: 'dialog-overview',
  title: 'Dialogs overview',
  url: 'https://m3.material.io/components/dialogs/overview',
  path: 'components/dialogs/overview.md',
  section: 'components/dialogs',
  headings: ['Dialogs', 'Usage'],
  text: 'Dialogs provide important prompts and decisions.',
  markdown: '---\ntitle: "Dialogs overview"\n---\n\n# Dialogs\n\nDialogs provide important prompts and decisions.\n',
  capturedAt: '2026-05-18T00:00:00.000Z'
};

const buttonPage: MaterialPage = {
  id: 'button-overview',
  title: 'Buttons overview',
  url: 'https://m3.material.io/components/buttons/overview',
  path: 'components/buttons/overview.md',
  section: 'components/buttons',
  headings: ['Buttons', 'Usage'],
  text: 'Buttons help people take action.',
  markdown: '---\ntitle: "Buttons overview"\n---\n\n# Buttons\n\nButtons help people take action.\n',
  capturedAt: '2026-05-18T00:00:00.000Z'
};

function testIndex(pages: MaterialPage[] = [dialogPage, buttonPage]): MaterialIndex {
  return {
    source: 'https://m3.material.io',
    capturedAt: '2026-05-18T00:00:00.000Z',
    pageCount: pages.length,
    attemptedPageCount: pages.length,
    failedPageCount: 0,
    failedUrls: [],
    pages: pages.map(({ text: _text, markdown: _markdown, ...meta }) => meta)
  };
}

async function seedStore(): Promise<MaterialDocsStore> {
  await writeIndex(testIndex(), cacheDir);
  await writePage(dialogPage, cacheDir);
  await writePage(buttonPage, cacheDir);
  return new MaterialDocsStore(cacheDir);
}

describe('MaterialDocsStore', () => {
  beforeEach(async () => {
    cacheDir = await mkdtemp(path.join(tmpdir(), 'm3-docs-store-test-'));
  });

  afterEach(async () => {
    await rm(cacheDir, { recursive: true, force: true });
  });

  it('throws a useful error when cache is missing', async () => {
    const store = new MaterialDocsStore(cacheDir);
    await expect(store.load()).rejects.toThrow('Material 3 docs cache not found');
  });

  it('serves stale cache without refreshing implicitly', async () => {
    const store = await seedStore();
    const oldDate = new Date(Date.now() - 48 * 60 * 60 * 1000);
    await utimes(indexPath(cacheDir), oldDate, oldDate);

    await expect(store.ensureFresh(24)).resolves.toMatchObject({ pageCount: 2 });
    await expect(store.getStatus(24)).resolves.toMatchObject({ hasCache: true, isFresh: false, pageCount: 2 });
  });

  it('loads a page by cache path, source URL, and extensionless path', async () => {
    const store = await seedStore();
    await expect(store.getPage(dialogPage.path)).resolves.toMatchObject({ meta: expect.objectContaining({ title: 'Dialogs overview' }), markdown: dialogPage.markdown });
    await expect(store.getPage(dialogPage.url)).resolves.toMatchObject({ meta: expect.objectContaining({ path: dialogPage.path }) });
    await expect(store.getPage('components/dialogs/overview')).resolves.toMatchObject({ meta: expect.objectContaining({ url: dialogPage.url }) });
  });

  it('reports unknown pages explicitly', async () => {
    const store = await seedStore();
    await expect(store.getPage('missing.md')).rejects.toThrow('Material 3 page not found: missing.md');
  });

  it('returns all docs for a component', async () => {
    const store = await seedStore();
    await expect(store.getComponentDocs('dialogs')).resolves.toEqual([
      { path: dialogPage.path, title: dialogPage.title, url: dialogPage.url, markdown: dialogPage.markdown }
    ]);
  });

  it('lists discovered component slugs', async () => {
    const store = await seedStore();
    await expect(store.listComponents()).resolves.toEqual(['buttons', 'dialogs']);
  });

  it('searches cached markdown and returns useful result metadata', async () => {
    const store = await seedStore();
    const results = await store.searchDocs('important prompts', 5);
    expect(results[0]).toMatchObject({ title: 'Dialogs overview', path: dialogPage.path, section: 'components/dialogs' });
    expect(results[0]?.excerpt).toContain('Dialogs provide important prompts');
  });

  it('limits search results', async () => {
    const store = await seedStore();
    const results = await store.searchDocs('overview', 1);
    expect(results).toHaveLength(1);
  });
});
