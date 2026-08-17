import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { writeIndex, writePage } from '../src/cache.js';
import { MaterialDocsStore } from '../src/store.js';
import type { CoverageDiagnostics, MaterialIndex, MaterialPage, RoutePlanEntry } from '../src/types.js';

const tempDirs: string[] = [];

function page(component: string, title = 'Overview'): MaterialPage {
  const pathName = `components/${component}/overview.md`;
  return {
    id: `${component}-overview`,
    title,
    url: `https://m3.material.io/components/${component}/overview`,
    path: pathName,
    section: `components/${component}`,
    headings: [title],
    text: `${title} content for ${component}.`,
    markdown: `# ${title}\n\nContent for ${component}.\n`,
    capturedAt: '2026-08-17T00:00:00.000Z'
  };
}

function route(entry: Pick<RoutePlanEntry, 'route'> & Partial<RoutePlanEntry>): RoutePlanEntry {
  return {
    sources: ['site_meta'],
    publicDocsClassification: 'public-docs',
    reconciliationStatus: 'exact',
    ...entry
  };
}

function coverageWithAcceptedRoutes(acceptedRoutes: RoutePlanEntry[]): CoverageDiagnostics {
  return {
    discoveredPublicUrlCount: acceptedRoutes.length,
    sitemapUrlCount: 0,
    renderedNavUrlCount: 0,
    angularRouteHintCount: 0,
    previousCacheRouteHintCount: 0,
    acceptedPageCount: acceptedRoutes.length,
    uncrawledDiscoveredUrlCount: 0,
    uncrawledDiscoveredUrls: [],
    skippedBecauseMaxPagesCount: 0,
    skippedBecauseJsonCoveredCount: 0,
    skippedByPolicyCount: 0,
    skippedBlogCount: 0,
    skippedByPolicyUrls: [],
    includeBlog: false,
    crawlPriorityPolicyVersion: 'test',
    coverageVerified: true,
    coverageWarnings: [],
    fullRoutePlanSummary: {
      acceptedRoutes,
      staleRoutes: [],
      removedRoutes: [],
      ambiguousRoutes: [],
      nonPublicRoutes: [],
      extractionCandidates: acceptedRoutes
    }
  };
}

async function seed(pages: MaterialPage[], acceptedRoutes: RoutePlanEntry[] = []): Promise<MaterialDocsStore> {
  const cacheDir = await mkdtemp(path.join(tmpdir(), 'm3-docs-store-route-contract-'));
  tempDirs.push(cacheDir);
  const index: MaterialIndex = {
    source: 'https://m3.material.io',
    capturedAt: '2026-08-17T00:00:00.000Z',
    pageCount: pages.length,
    attemptedPageCount: pages.length,
    failedPageCount: 0,
    failedUrls: [],
    coverageDiagnostics: coverageWithAcceptedRoutes(acceptedRoutes),
    pages: pages.map(({ text: _text, markdown: _markdown, ...meta }) => meta)
  };
  await writeIndex(index, cacheDir);
  await Promise.all(pages.map((entry) => writePage(entry, cacheDir)));
  return new MaterialDocsStore(cacheDir);
}

afterEach(async () => {
  await Promise.all(tempDirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

describe('MaterialDocsStore component route contracts', () => {
  it('uses canonical route identity and alternate slugs from the accepted route plan', async () => {
    const canonicalAliasPage = page('nav-bar');
    const unrelatedPage = page('non-component-alias', 'Unrelated');
    const store = await seed(
      [canonicalAliasPage, unrelatedPage],
      [
        route({
          route: '/components/navigation-bar',
          canonicalRoute: '/components/navigation-bars',
          alternateSlugs: ['/components/nav-bar'],
          reconciliationStatus: 'alternateSlug'
        }),
        route({
          route: '/styles/navigation-bar',
          canonicalRoute: '/styles/navigation-bar',
          alternateSlugs: ['/components/non-component-alias']
        })
      ]
    );

    await expect(store.getComponentDocs(' Navigation bar overview ')).resolves.toEqual([
      {
        path: canonicalAliasPage.path,
        title: canonicalAliasPage.title,
        url: canonicalAliasPage.url,
        section: canonicalAliasPage.section,
        headings: canonicalAliasPage.headings
      }
    ]);
  });

  it.each([
    ['Batteries', 'battery'],
    ['Boxes', 'box'],
    ['Buttons', 'button']
  ])('falls back from plural component lookup %s to the singular route %s', async (lookup, component) => {
    const singularPage = page(component);
    const store = await seed([singularPage]);

    await expect(store.getComponentDocs(lookup)).resolves.toEqual([
      {
        path: singularPage.path,
        title: singularPage.title,
        url: singularPage.url,
        section: singularPage.section,
        headings: singularPage.headings
      }
    ]);
  });

  it('keeps route matching segment-bound and does not confuse neighboring component names', async () => {
    const button = page('button');
    const buttonGroup = page('button-group');
    const store = await seed([button, buttonGroup]);

    await expect(store.getComponentDocs('Buttons')).resolves.toEqual([
      {
        path: button.path,
        title: button.title,
        url: button.url,
        section: button.section,
        headings: button.headings
      }
    ]);
  });
});
