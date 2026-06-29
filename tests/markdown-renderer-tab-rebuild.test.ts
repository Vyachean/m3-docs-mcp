import { readFileSync } from 'node:fs';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { buildAndWriteGraph } from '../src/graph/build-graph.js';
import { createEmptyExtractionDiagnostics } from '../src/json-extraction/diagnostics.js';
import { persistArtifact } from '../src/raw-artifacts/artifact-store.js';
import { upsertArtifactRecord } from '../src/raw-artifacts/artifact-index.js';
import type { ArtifactRecord } from '../src/raw-artifacts/artifact-types.js';
import { rebuildMarkdownFromRaw } from '../src/rendered/markdown-renderer.js';
import type { ExtractionRouteDiagnostic, MaterialIndex, MaterialPageMeta } from '../src/types.js';

const fixture = (name: string) => JSON.parse(readFileSync(path.join(process.cwd(), 'tests/fixtures/json-extraction', name), 'utf8'));

const SOURCE_ROUTE = '/components/buttons';

// Matches the real bundle's tab order/labels for /components/buttons (see
// tests/crawler-tab-splitting.test.ts, which exercises the live crawl path against the same
// fixtures and confirms matchTabToSection resolves these tabs by label at these section indices).
const TABS = [
  { label: 'Overview', slug: 'overview', sectionIndex: 0 },
  { label: 'Specs', slug: 'specs', sectionIndex: 1 },
  { label: 'Guidelines', slug: 'guidelines', sectionIndex: 2 },
  { label: 'Accessibility', slug: 'accessibility', sectionIndex: 3 },
];

function tabPageMeta(tab: typeof TABS[number]): MaterialPageMeta {
  return {
    id: `buttons-${tab.slug}`,
    title: `Buttons ${tab.label}`,
    url: `https://m3.material.io/components/buttons/${tab.slug}`,
    path: `components/buttons/${tab.slug}.md`,
    section: 'components',
    headings: [`Buttons ${tab.label}`],
    capturedAt: '2026-06-29T00:00:00.000Z',
  };
}

function tabRouteDiagnostic(tab: typeof TABS[number]): ExtractionRouteDiagnostic {
  return {
    url: `https://m3.material.io/components/buttons/${tab.slug}`,
    path: `components/buttons/${tab.slug}.md`,
    sourceUsed: 'direct-json',
    finalMethod: 'json',
    jsonAttempted: true,
    jsonSucceeded: true,
    browserFallbackAttempted: false,
    browserFallbackSucceeded: false,
    unknownChunkTypes: [],
    unknownResourceTypes: [],
    tokenTables: 0,
    tokenTablesRendered: 0,
    missingRequestedTokenSets: [],
    virtualSource: 'tab',
    sourceRoute: SOURCE_ROUTE,
    canonicalRoute: SOURCE_ROUTE,
    virtualRoute: `/components/buttons/${tab.slug}`,
    tabName: tab.label,
    tabSlug: tab.slug,
    tabMatchedBy: 'label',
    tabMatchedSectionIndex: tab.sectionIndex,
  };
}

function minimalIndex(): MaterialIndex {
  return {
    source: 'https://m3.material.io',
    capturedAt: '2026-06-29T00:00:00.000Z',
    pageCount: TABS.length,
    attemptedPageCount: 1,
    failedPageCount: 0,
    failedUrls: [],
    pages: TABS.map(tabPageMeta),
    extractionDiagnostics: {
      ...createEmptyExtractionDiagnostics(),
      pageDiagnostics: [],
      routeDiagnostics: TABS.map(tabRouteDiagnostic),
    },
  };
}

let cacheDir: string;
beforeEach(async () => { cacheDir = await mkdtemp(path.join(tmpdir(), 'm3-docs-markdown-renderer-tab-rebuild-')); });
afterEach(async () => { await rm(cacheDir, { recursive: true, force: true }); });

async function seedRawSnapshotForButtonsTabs(): Promise<void> {
  const pageData = fixture('page-data-buttons-real.json');
  const contentPage = fixture('content-buttons-tabs-real.json');

  const artifactRecords: ArtifactRecord[] = [];
  artifactRecords.push(await persistArtifact({
    kind: 'page-data',
    pathParts: ['ComponentsM3', '5047690081337344'],
    sourceUrl: 'https://m3.material.io/page-data/ComponentsM3/5047690081337344.json',
    content: JSON.stringify(pageData),
    httpStatus: 200,
    contentType: 'application/json',
    sourceRoute: SOURCE_ROUTE,
    sourceMethod: 'static-plan',
  }, cacheDir));
  artifactRecords.push(await persistArtifact({
    kind: 'carbon-content',
    pathParts: ['2026-06-10_13-00-05', 'e31df68a-59d4-41dc-8743-8c48b476d4f8'],
    sourceUrl: 'https://m3.material.io/_dsm/content/m3/2026-06-10_13-00-05/e31df68a-59d4-41dc-8743-8c48b476d4f8.json',
    content: JSON.stringify(contentPage),
    httpStatus: 200,
    contentType: 'application/json',
    sourceRoute: SOURCE_ROUTE,
    sourceMethod: 'static-plan',
  }, cacheDir));

  for (const record of artifactRecords) await upsertArtifactRecord(record, cacheDir);
  await buildAndWriteGraph(minimalIndex(), cacheDir, artifactRecords, []);
}

describe('rebuildMarkdownFromRaw: tab-split virtual pages', () => {
  it('reconstructs /components/buttons/overview and /components/buttons/specs as separate Markdown pages from one shared raw artifact, with no network', async () => {
    await seedRawSnapshotForButtonsTabs();

    const result = await rebuildMarkdownFromRaw(cacheDir);

    const overview = result.pages.find((p) => p.path === 'components/buttons/overview.md');
    const specs = result.pages.find((p) => p.path === 'components/buttons/specs.md');
    expect(overview).toBeDefined();
    expect(specs).toBeDefined();
    // Each tab page must carry its own distinct content (not the whole combined page repeated).
    expect(overview!.markdown).not.toEqual(specs!.markdown);
    expect(overview!.markdown.length).toBeGreaterThan(0);
    expect(specs!.markdown.length).toBeGreaterThan(0);

    const overviewReport = result.report.routes.find((r) => r.route === '/components/buttons/overview');
    const specsReport = result.report.routes.find((r) => r.route === '/components/buttons/specs');
    expect(overviewReport?.renderedMarkdownPath).not.toBeNull();
    expect(specsReport?.renderedMarkdownPath).not.toBeNull();
  });

  it('reconstructs all four buttons tabs (overview/specs/guidelines/accessibility)', async () => {
    await seedRawSnapshotForButtonsTabs();
    const result = await rebuildMarkdownFromRaw(cacheDir);
    const paths = result.pages.map((p) => p.path).sort();
    expect(paths).toEqual([
      'components/buttons/accessibility.md',
      'components/buttons/guidelines.md',
      'components/buttons/overview.md',
      'components/buttons/specs.md',
    ]);
  });
});
