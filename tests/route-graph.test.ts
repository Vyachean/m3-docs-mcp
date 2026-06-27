import { describe, expect, it } from 'vitest';
import { buildRoutePlan } from '../src/json-extraction/route-graph.js';
import type { SiteMeta } from '../src/json-extraction/fetch-site-meta.js';
import type { NormalizedRoute } from '../src/json-extraction/normalize-routes.js';
import type { BundleRouteEntry } from '../src/json-extraction/page-reference-resolver.js';

function route(path: string, extras: Partial<NormalizedRoute> = {}): NormalizedRoute {
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
    ...extras,
  };
}

describe('buildRoutePlan', () => {
  const siteMeta: SiteMeta = {
    routes: {},
    nav_drawers: [{ href: '/components/nav-only' }]
  } as SiteMeta;

  it('reconciles plural site_meta routes to singular bundle routes without component dictionaries', () => {
    const plan = buildRoutePlan({
      baseUrl: 'https://m3.material.io',
      includeBlog: false,
      siteMeta,
      normalizedSiteMetaRoutes: [route('/components/switches')],
      bundleRoutes: [{ slug: 'components/switch', documentId: 'doc-switch', collectionId: 'ComponentsM3' }],
      sitemapPaths: []
    });

    expect(plan.acceptedRoutes).toContainEqual(expect.objectContaining({
      route: '/components/switches',
      canonicalRoute: '/components/switch',
      reconciliationStatus: 'normalizedSlugMatch'
    }));
  });

  it('uses stable content identity before normalized slug matching', () => {
    const plan = buildRoutePlan({
      baseUrl: 'https://m3.material.io',
      includeBlog: false,
      siteMeta: null,
      normalizedSiteMetaRoutes: [route('/components/selection-controls', { collectionId: 'ComponentsM3', documentId: 'doc-radio' })],
      bundleRoutes: [{ slug: 'components/radio-button', documentId: 'doc-radio', collectionId: 'ComponentsM3' }],
      sitemapPaths: []
    });

    expect(plan.acceptedRoutes).toContainEqual(expect.objectContaining({
      route: '/components/selection-controls',
      canonicalRoute: '/components/radio-button',
      reconciliationStatus: 'contentIdentityMatch'
    }));
  });

  it('includes nav drawer and bundle-only docs candidates without unbounded crawling', () => {
    const bundleRoutes: BundleRouteEntry[] = [
      { slug: 'components/nav-only', documentId: 'doc-nav', collectionId: 'ComponentsM3' },
      { slug: 'styles/color/roles', documentId: 'doc-roles', collectionId: 'GuidelinesM3' }
    ];

    const plan = buildRoutePlan({
      baseUrl: 'https://m3.material.io',
      includeBlog: false,
      siteMeta,
      normalizedSiteMetaRoutes: [],
      bundleRoutes,
      sitemapPaths: ['/styles/color/roles']
    });

    expect(plan.acceptedRoutes).toEqual(expect.arrayContaining([
      expect.objectContaining({ route: '/components/nav-only', canonicalRoute: '/components/nav-only' }),
      expect.objectContaining({ route: '/styles/color/roles', canonicalRoute: '/styles/color/roles' })
    ]));
  });

  it('marks stale routes when no canonical bundle match or identity exists', () => {
    const plan = buildRoutePlan({
      baseUrl: 'https://m3.material.io',
      includeBlog: false,
      siteMeta: null,
      normalizedSiteMetaRoutes: [route('/components/removed-widget')],
      bundleRoutes: [],
      sitemapPaths: []
    });

    expect(plan.staleRoutes).toContainEqual(expect.objectContaining({
      route: '/components/removed-widget',
      reconciliationStatus: 'rejectedStale'
    }));
    expect(plan.removedRoutes).toContainEqual(expect.objectContaining({
      route: '/components/removed-widget'
    }));
  });

  it('rejects ambiguous normalized matches instead of guessing', () => {
    const plan = buildRoutePlan({
      baseUrl: 'https://m3.material.io',
      includeBlog: false,
      siteMeta: null,
      normalizedSiteMetaRoutes: [route('/components/cards')],
      bundleRoutes: [
        { slug: 'components/card' },
        { slug: 'components/cards/overview' }
      ],
      sitemapPaths: []
    });

    expect(plan.ambiguousRoutes).toContainEqual(expect.objectContaining({
      route: '/components/cards',
      reconciliationStatus: 'rejectedAmbiguous'
    }));
  });
});
