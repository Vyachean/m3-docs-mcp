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

/**
 * Regression for the m3-docs-cache production failure: /components/switch only has a public
 * site_meta route under the alias slug "/components/switches", while the Angular bundle's own
 * canonical slug is "/components/switch". crawler.ts's route-plan-entry lookup used to match a
 * candidate's plan entry by canonicalRoute alone, which could resolve the canonical candidate
 * "/components/switch" onto the alias's OWN plan entry (since the alias's canonicalRoute equals
 * the canonical candidate's own route) — corrupting sourceCoverageRoute and, downstream, the
 * raw-backed page graph this rebuild reads from. With the fix, the canonical route's own raw
 * artifacts are tagged with its own identity, so rebuildMarkdownFromRaw must produce
 * /components/switch/overview and /components/switch/specs (not /components/switches.md, and not
 * a single combined non-tab page).
 */

const SOURCE_ROUTE = '/components/switch';

const TABS = [
  { label: 'Overview', slug: 'overview', sectionIndex: 0 },
  { label: 'Specs', slug: 'specs', sectionIndex: 1 },
];

function tabPageMeta(tab: typeof TABS[number]): MaterialPageMeta {
  return {
    id: `switch-${tab.slug}`,
    title: `Switch ${tab.label}`,
    url: `https://m3.material.io/components/switch/${tab.slug}`,
    path: `components/switch/${tab.slug}.md`,
    section: 'components',
    headings: [`Switch ${tab.label}`],
    capturedAt: '2026-06-29T00:00:00.000Z',
  };
}

function tabRouteDiagnostic(tab: typeof TABS[number]): ExtractionRouteDiagnostic {
  return {
    url: `https://m3.material.io/components/switch/${tab.slug}`,
    path: `components/switch/${tab.slug}.md`,
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
    virtualRoute: `/components/switch/${tab.slug}`,
    tabName: tab.label,
    tabSlug: tab.slug,
    tabMatchedBy: 'label',
    tabMatchedSectionIndex: tab.sectionIndex,
  };
}

/** Models the real "alias-only" skip diagnostic crawler.ts records for "/components/switches"
 *  once the canonical "/components/switch" candidate has already claimed the resolved slug — no
 *  virtualRoute, no matching carbon-content artifact under this route. */
const aliasOnlySkipDiagnostic: ExtractionRouteDiagnostic = {
  url: 'https://m3.material.io/components/switches',
  path: 'components/switches.md',
  sourceUsed: 'skipped',
  skippedReason: 'alias-only',
  finalMethod: null,
  jsonAttempted: false,
  jsonSucceeded: false,
  browserFallbackAttempted: false,
  browserFallbackSucceeded: false,
  unknownChunkTypes: [],
  unknownResourceTypes: [],
  tokenTables: 0,
  tokenTablesRendered: 0,
  missingRequestedTokenSets: [],
  normalizedRoute: '/components/switches',
  bundleMatchedRoute: '/components/switch',
};

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
      routeDiagnostics: [...TABS.map(tabRouteDiagnostic), aliasOnlySkipDiagnostic],
    },
  };
}

let cacheDir: string;
beforeEach(async () => { cacheDir = await mkdtemp(path.join(tmpdir(), 'm3-docs-markdown-renderer-switch-alias-')); });
afterEach(async () => { await rm(cacheDir, { recursive: true, force: true }); });

async function seedRawSnapshotForSwitchTabs(): Promise<void> {
  const pageData = { result: { pageContext: { title: 'Switch', documentId: 'doc-switch', pageCanonId: 'page-canon-switch', slug: 'components/switch' } } };
  const contentPage = {
    pageId: 'switch-page-id',
    pageCanonId: 'page-canon-switch',
    title: 'Switch',
    slug: 'switch',
    sections: [
      { name: 'Overview', isVisible: true, contentBlocks: [{ title: 'Usage', contentChunks: [{ contentChunkType: 'TEXT', htmlValue: '<p>Switches toggle the state of a single item with enough text for validation.</p>' }] }] },
      { name: 'Specs', isVisible: true, contentBlocks: [{ title: 'Anatomy', contentChunks: [{ contentChunkType: 'TEXT', htmlValue: '<p>Switch anatomy content is present with enough text for validation.</p>' }] }] },
    ],
  };

  const artifactRecords: ArtifactRecord[] = [];
  artifactRecords.push(await persistArtifact({
    kind: 'page-data',
    pathParts: ['ComponentsM3', 'doc-switch'],
    sourceUrl: 'https://m3.material.io/page-data/ComponentsM3/doc-switch.json',
    content: JSON.stringify(pageData),
    httpStatus: 200,
    contentType: 'application/json',
    sourceRoute: SOURCE_ROUTE,
    sourceMethod: 'static-plan',
  }, cacheDir));
  artifactRecords.push(await persistArtifact({
    kind: 'carbon-content',
    pathParts: ['cv-123', 'switch'],
    sourceUrl: 'https://m3.material.io/_dsm/content/m3/cv-123/switch.json',
    content: JSON.stringify(contentPage),
    httpStatus: 200,
    contentType: 'application/json',
    sourceRoute: SOURCE_ROUTE,
    sourceMethod: 'static-plan',
  }, cacheDir));

  for (const record of artifactRecords) await upsertArtifactRecord(record, cacheDir);
  await buildAndWriteGraph(minimalIndex(), cacheDir, artifactRecords, []);
}

describe('rebuildMarkdownFromRaw: /components/switch canonical route vs /components/switches alias', () => {
  it('produces components/switch/overview.md and components/switch/specs.md, not the alias path', async () => {
    await seedRawSnapshotForSwitchTabs();

    const result = await rebuildMarkdownFromRaw(cacheDir);
    const paths = result.pages.map((p) => p.path).sort();

    expect(paths).toEqual(['components/switch/overview.md', 'components/switch/specs.md']);
    expect(paths).not.toContain('components/switches.md');

    const overview = result.pages.find((p) => p.path === 'components/switch/overview.md');
    const specs = result.pages.find((p) => p.path === 'components/switch/specs.md');
    expect(overview!.markdown).not.toEqual(specs!.markdown);
  });

  it('does not synthesize a combined non-tab page for the alias-only-skipped /components/switches diagnostic', async () => {
    await seedRawSnapshotForSwitchTabs();

    const result = await rebuildMarkdownFromRaw(cacheDir);

    expect(result.pages).toHaveLength(2);
    expect(result.report.routes.some((r) => r.route === '/components/switches')).toBe(false);
  });
});
