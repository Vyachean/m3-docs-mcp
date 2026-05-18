import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { cacheAgeMs, ensureCacheDirs, indexPath, isCacheFresh, pagesDir, readIndex, readPage, writeIndex, writePage } from '../src/cache.js';
import type { MaterialIndex, MaterialPage } from '../src/types.js';

let cacheDir: string;

const page: MaterialPage = {
  id: 'page-1',
  title: 'Dialogs',
  url: 'https://m3.material.io/components/dialogs/overview',
  path: 'components/dialogs/overview.md',
  section: 'components/dialogs',
  headings: ['Dialogs', 'Usage'],
  text: 'Dialogs display important information and actions.',
  markdown: '# Dialogs\n\nDialogs display important information and actions.\n',
  capturedAt: '2026-05-18T00:00:00.000Z'
};

const index: MaterialIndex = {
  source: 'https://m3.material.io',
  capturedAt: '2026-05-18T00:00:00.000Z',
  pageCount: 1,
  pages: [page]
};

describe('cache helpers', () => {
  beforeEach(async () => {
    cacheDir = await mkdtemp(path.join(tmpdir(), 'm3-docs-cache-test-'));
  });

  afterEach(async () => {
    await rm(cacheDir, { recursive: true, force: true });
  });

  it('resolves index and pages paths inside the supplied cache directory', () => {
    expect(indexPath(cacheDir)).toBe(path.join(cacheDir, 'index.json'));
    expect(pagesDir(cacheDir)).toBe(path.join(cacheDir, 'pages'));
  });

  it('creates cache directories', async () => {
    await ensureCacheDirs(cacheDir);
    expect(await cacheAgeMs(cacheDir)).toBeNull();
  });

  it('returns null when the index is missing or invalid', async () => {
    expect(await readIndex(cacheDir)).toBeNull();
  });

  it('writes and reads the documentation index', async () => {
    await writeIndex(index, cacheDir);
    await expect(readIndex(cacheDir)).resolves.toEqual(index);
    expect(await cacheAgeMs(cacheDir)).toEqual(expect.any(Number));
  });

  it('writes nested markdown pages and reads them back', async () => {
    await writePage(page, cacheDir);
    await expect(readPage(page.path, cacheDir)).resolves.toBe(page.markdown);
  });

  it('checks cache freshness from age in milliseconds', () => {
    expect(isCacheFresh(null, 24)).toBe(false);
    expect(isCacheFresh(60 * 60 * 1000, 2)).toBe(true);
    expect(isCacheFresh(3 * 60 * 60 * 1000, 2)).toBe(false);
  });
});
