import { describe, expect, it } from 'vitest';
import { buildCompactRoutePlanSummary, buildRoutePlan } from '../src/json-extraction/route-graph.js';
import type { NormalizedRoute } from '../src/json-extraction/normalize-routes.js';

function route(path: string, extras: Partial<NormalizedRoute> & Record<string, unknown> = {}): NormalizedRoute {
  return {
    path,
    routeKey: path,
    aliases: [],
    public: true,
    redirectExternalUrl: null,
    collectionId: null,
    documentId: null,
    repoId: null,
    isBlog: false,
    navigationSource: 'site-meta',
    raw: {},
    ...extras
  };
}

describe('route plan reconciliation contracts', () => {
  it('reconciles an explicit alternate slug to its canonical bundle route', () => {
    const plan = buildRoutePlan({
      baseUrl: 'https://m3.material.io',
      includeBlog: false,
      siteMeta: null,
      normalizedSiteMetaRoutes: [route('/components/legacy-button')],
      bundleRoutes: [{
        slug: 'components/button',
        alternateSlugs: ['components/legacy-button'],
        collectionId: 'ComponentsM3',
        documentId: 'doc-button',
        exportedCarbonFileId: 'button.json'
      }],
      sitemapPaths: []
    });

    expect(plan.acceptedRoutes).toContainEqual(expect.objectContaining({
      route: '/components/legacy-button',
      canonicalRoute: '/components/button',
      outputPath: 'components/button.md',
      reconciliationStatus: 'alternateSlug',
      identityFieldsUsed: ['alternateSlug']
    }));
  });

  it('uses exported content identity when the public slug changed', () => {
    const plan = buildRoutePlan({
      baseUrl: 'https://m3.material.io',
      includeBlog: false,
      siteMeta: null,
      normalizedSiteMetaRoutes: [route('/components/renamed-control', {
        exportedCarbonFileId: 'stable-control.json'
      })],
      bundleRoutes: [{
        slug: 'components/control',
        exportedCarbonFileId: 'stable-control.json',
        collectionId: 'ComponentsM3',
        documentId: 'doc-control'
      }],
      sitemapPaths: []
    });

    expect(plan.acceptedRoutes).toContainEqual(expect.objectContaining({
      route: '/components/renamed-control',
      canonicalRoute: '/components/control',
      reconciliationStatus: 'contentIdentityMatch',
      identityFieldsUsed: ['exportedCarbonFileId']
    }));
  });

  it('classifies redirects, go links, assets, indexes, outside routes, and disabled blog routes as non-public', () => {
    const plan = buildRoutePlan({
      baseUrl: 'https://m3.material.io',
      includeBlog: false,
      siteMeta: null,
      normalizedSiteMetaRoutes: [
        route('/components/redirected', { redirectExternalUrl: 'https://example.com' }),
        route('/blog/release-notes')
      ],
      bundleRoutes: [{
        slug: 'components',
        collectionId: 'ComponentsM3',
        documentId: 'components-index'
      }],
      sitemapPaths: [
        '/go/material-guidance',
        '/components/button/hero.svg',
        '/unrelated/page'
      ]
    });

    expect(plan.nonPublicRoutes).toEqual(expect.arrayContaining([
      expect.objectContaining({ route: '/components/redirected', publicDocsClassification: 'redirect' }),
      expect.objectContaining({ route: '/go/material-guidance', publicDocsClassification: 'go-link' }),
      expect.objectContaining({ route: '/components/button/hero.svg', publicDocsClassification: 'asset' }),
      expect.objectContaining({ route: '/components', publicDocsClassification: 'non-content-index' }),
      expect.objectContaining({ route: '/unrelated/page', publicDocsClassification: 'outside-public-docs' }),
      expect.objectContaining({ route: '/blog/release-notes', publicDocsClassification: 'outside-public-docs' })
    ]));
    expect(plan.extractionCandidates).toEqual([]);
  });

  it('accepts a blog route only when blog crawling is enabled and the bundle identity is available', () => {
    const params = {
      baseUrl: 'https://m3.material.io',
      siteMeta: null,
      normalizedSiteMetaRoutes: [route('/blog/material-update')],
      bundleRoutes: [{
        slug: 'blog/material-update',
        collectionId: 'BlogM3',
        documentId: 'doc-blog'
      }],
      sitemapPaths: []
    };

    const disabled = buildRoutePlan({ ...params, includeBlog: false });
    expect(disabled.nonPublicRoutes).toContainEqual(expect.objectContaining({
      route: '/blog/material-update',
      publicDocsClassification: 'outside-public-docs'
    }));

    const enabled = buildRoutePlan({ ...params, includeBlog: true });
    expect(enabled.acceptedRoutes).toContainEqual(expect.objectContaining({
      route: '/blog/material-update',
      reconciliationStatus: 'exact',
      publicDocsClassification: 'public-docs'
    }));
  });
});

describe('buildCompactRoutePlanSummary', () => {
  it('preserves totals and bounded diagnostic examples without duplicating removed routes', () => {
    const routePlanSummary = buildRoutePlan({
      baseUrl: 'https://m3.material.io',
      includeBlog: false,
      siteMeta: null,
      normalizedSiteMetaRoutes: [
        route('/components/button'),
        route('/components/removed'),
        route('/go/external')
      ],
      bundleRoutes: [{
        slug: 'components/button',
        collectionId: 'ComponentsM3',
        documentId: 'doc-button'
      }],
      sitemapPaths: []
    });
    const accepted = routePlanSummary.acceptedRoutes[0]!;
    const summary = buildCompactRoutePlanSummary({
      routePlanSummary,
      unresolvedAcceptedRoutes: [accepted]
    });

    expect(summary).toMatchObject({
      acceptedRouteCount: 1,
      staleRouteCount: 1,
      ambiguousRouteCount: 0,
      nonPublicRouteCount: 1,
      extractionCandidateCount: 1,
      reconciliationStatusCounts: {
        exact: 1,
        rejectedStale: 1,
        rejectedNonPublic: 1
      },
      publicDocsClassificationCounts: {
        'public-docs': 2,
        'go-link': 1
      }
    });
    expect(summary.problematicExamples.staleRoutes).toHaveLength(1);
    expect(summary.problematicExamples.nonPublicRoutes).toHaveLength(1);
    expect(summary.problematicExamples.unresolvedAcceptedRoutes).toEqual([
      expect.objectContaining({ route: '/components/button', reconciliationStatus: 'exact' })
    ]);
  });
});
