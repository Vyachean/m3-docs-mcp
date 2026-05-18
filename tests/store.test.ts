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

const updatedDialogPage: MaterialPage = {
  ...dialogPage,
  title: 'Updated dialogs overview',
  markdown: '---\ntitle: "Updated dialogs overview"\n---\n\n# Dialogs\n\nUpdated dialogs include confirmation guidance.\n',
  text: 'Updated dialogs include confirmation guidance.',
  capturedAt: '2026-05-19T00:00:00.000Z'
};

function testIndex(pages: MaterialPage[] = [dialogPage, buttonPage], capturedAt = '2026-05-18T00:00:00.000Z'): MaterialIndex {
  return {
    source: 'https://m3.material.io',
    capturedAt,
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

    await expect(store.load()).resolves.toMatchObject({ pageCount: 2 });
    await expect(store.getStatus(24)).resolves.toMatchObject({ hasCache: true, isFresh: false, pageCount: 2 });
  });

  it('loads a page by cache path, source URL, extensionless path, and normalized URL variants', async () => {
    const store = await seedStore();
    await expect(store.getPage(dialogPage.path)).resolves.toMatchObject({ meta: expect.objectContaining({ title: 'Dialogs overview' }), markdown: dialogPage.markdown });
    await expect(store.getPage(dialogPage.url)).resolves.toMatchObject({ meta: expect.objectContaining({ path: dialogPage.path }) });
    await expect(store.getPage('components/dialogs/overview')).resolves.toMatchObject({ meta: expect.objectContaining({ url: dialogPage.url }) });
    await expect(store.getPage('/components/dialogs/overview.md')).resolves.toMatchObject({ meta: expect.objectContaining({ url: dialogPage.url }) });
    await expect(store.getPage(`  ${dialogPage.url}/?tab=usage#actions  `)).resolves.toMatchObject({ meta: expect.objectContaining({ url: dialogPage.url }) });
    await expect(store.getPage('components/dialogs/overview.md?tab=usage#actions')).resolves.toMatchObject({ meta: expect.objectContaining({ url: dialogPage.url }) });
  });

  it('loads component overview pages through landing aliases', async () => {
    const store = await seedStore();
    await expect(store.getPage('components/buttons')).resolves.toMatchObject({ meta: expect.objectContaining({ path: buttonPage.path }) });
    await expect(store.getPage('/components/buttons.md')).resolves.toMatchObject({ meta: expect.objectContaining({ path: buttonPage.path }) });
    await expect(store.getPage('https://m3.material.io/components/buttons')).resolves.toMatchObject({ meta: expect.objectContaining({ path: buttonPage.path }) });
  });

  it('reports unknown pages explicitly', async () => {
    const store = await seedStore();
    await expect(store.getPage('missing.md')).rejects.toThrow('Material 3 page not found: missing.md');
  });

  it('returns all docs for a component regardless of spaces and case', async () => {
    const store = await seedStore();
    await expect(store.getComponentDocs('DIALOGS')).resolves.toEqual([
      { path: dialogPage.path, title: dialogPage.title, url: dialogPage.url, markdown: dialogPage.markdown }
    ]);
    await expect(store.getComponentDocs(' Dialogs   overview ')).resolves.toEqual([
      { path: dialogPage.path, title: dialogPage.title, url: dialogPage.url, markdown: dialogPage.markdown }
    ]);
    await expect(store.getComponentDocs('   ')).resolves.toEqual([]);
  });

  it('matches component docs by section or path without relying on title', async () => {
    const iconButtonPage: MaterialPage = {
      ...buttonPage,
      id: 'icon-button-overview',
      title: 'Overview',
      url: 'https://m3.material.io/components/icon-buttons/overview',
      path: 'components/icon-buttons/overview.md',
      section: 'components/icon-buttons',
      headings: ['Icon buttons'],
      markdown: '# Icon buttons\n\nIcon buttons help people take icon-only actions.\n'
    };
    await writeIndex(testIndex([iconButtonPage]), cacheDir);
    await writePage(iconButtonPage, cacheDir);

    const store = new MaterialDocsStore(cacheDir);
    await expect(store.getComponentDocs('Icon  Buttons')).resolves.toEqual([
      { path: iconButtonPage.path, title: iconButtonPage.title, url: iconButtonPage.url, markdown: iconButtonPage.markdown }
    ]);
  });

  it('lists discovered component slugs and ignores non-component pages', async () => {
    const rootPage = { ...buttonPage, id: 'root', path: 'index.md', section: 'root', title: 'Material 3' };
    const nestedNonComponentPage = { ...buttonPage, id: 'styles-buttons', path: 'styles/components/buttons.md', section: 'styles/components', title: 'Buttons style' };
    await writeIndex(testIndex([dialogPage, buttonPage, rootPage, nestedNonComponentPage]), cacheDir);
    await writePage(dialogPage, cacheDir);
    await writePage(buttonPage, cacheDir);
    await writePage(rootPage, cacheDir);
    await writePage(nestedNonComponentPage, cacheDir);

    const store = new MaterialDocsStore(cacheDir);
    await expect(store.listComponents()).resolves.toEqual(['buttons', 'dialogs']);
  });

  it('searches cached markdown and returns useful result metadata', async () => {
    const store = await seedStore();
    const results = await store.searchDocs('important prompts', 5);
    expect(results[0]).toMatchObject({ title: 'Dialogs overview', path: dialogPage.path, section: 'components/dialogs' });
    expect(results[0]?.headings).toEqual(['Dialogs', 'Usage']);
    expect(results[0]?.excerpt).toContain('Dialogs provide important prompts');
    expect(results[0]?.excerpt).not.toContain('---');
    expect(results[0]?.excerpt).toBe(results[0]?.excerpt.trim());
  });

  it('uses prefix search and limits search results', async () => {
    const store = await seedStore();
    const results = await store.searchDocs('prom', 1);
    expect(results).toHaveLength(1);
    expect(results[0]?.title).toBe('Dialogs overview');
  });

  it('invalidates the search index when cache is externally updated', async () => {
    const store = await seedStore();
    expect(await store.searchDocs('important prompts', 5)).toHaveLength(1);

    await writeIndex(testIndex([updatedDialogPage], '2026-05-19T00:00:00.000Z'), cacheDir);
    await writePage(updatedDialogPage, cacheDir);

    const results = await store.searchDocs('confirmation guidance', 5);
    expect(results).toHaveLength(1);
    expect(results[0]).toMatchObject({ title: 'Updated dialogs overview', path: updatedDialogPage.path });
  });
});
