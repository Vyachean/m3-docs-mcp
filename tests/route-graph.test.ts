import { describe, expect, it } from 'vitest';
import { buildRoutePlan } from '../src/json-extraction/route-graph.js';
import type { SiteMeta } from '../src/json-extraction/fetch-site-meta.js';
import type { NormalizedRoute } from '../src/json-extraction/normalize-routes.js';
import type { BundleRouteEntry } from '../src/json-extraction/page-reference-resolver.js';

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
    ...extras,
  };
}

describe('buildRoutePlan', () => {
  const siteMeta: SiteMeta = {
    routes: {},
    nav_drawers: [{ href: '/components/nav-only', label: 'Nav only label' }]
  } as SiteMeta;

  it('reconciles plural site_meta routes to singular bundle routes without component dictionaries', () => {
    const plan = buildRoutePlan({
      baseUrl: 'https://m3.material.io',
      includeBlog: false,
      siteMeta,
      normalizedSiteMetaRoutes: [route('/components/switches')],
      bundleRoutes: [{
        slug: 'components/switch',
        documentId: 'doc-switch',
        collectionId: 'ComponentsM3',
        tabs: [{ label: 'Overview' }, { label: 'Specs', slug: '/specs/' }]
      }],
      sitemapPaths: []
    });

    expect(plan.acceptedRoutes).toContainEqual(expect.objectContaining({
      route: '/components/switches',
      canonicalRoute: '/components/switch',
      reconciliationStatus: 'normalizedSlugMatch',
      identityFieldsUsed: ['normalizedComponentSlug'],
      tabs: ['Overview', 'Specs'],
      tabSlugs: ['overview', 'specs']
    }));
  });

  it('collapses current sitemap tab URLs to their bundle parent route', () => {
    const bundleRoutes: BundleRouteEntry[] = [{
      slug: 'components/buttons',
      documentId: 'doc-buttons',
      collectionId: 'ComponentsM3',
      tabs: [
        { label: 'Overview' },
        { label: 'Specs' },
        { label: 'Guidelines' },
        { label: 'Accessibility' }
      ]
    }];
    const plan = buildRoutePlan({
      baseUrl: 'https://m3.material.io',
      includeBlog: false,
      siteMeta: null,
      normalizedSiteMetaRoutes: [],
      bundleRoutes,
      sitemapPaths: [
        '/components/buttons/overview',
        '/components/buttons/specs',
        '/components/buttons/guidelines',
        '/components/buttons/accessibility'
      ]
    });

    expect(plan.acceptedRoutes).toEqual([
      expect.objectContaining({
        route: '/components/buttons',
        canonicalRoute: '/components/buttons',
        sources: ['bundle', 'sitemap'],
        reconciliationStatus: 'exact',
        tabs: ['Overview', 'Specs', 'Guidelines', 'Accessibility'],
        tabSlugs: ['overview', 'specs', 'guidelines', 'accessibility']
      })
    ]);
    expect(plan.staleRoutes).toEqual([]);
  });

  it('does not publish uncorroborated bundle-only routes', () => {
    const plan = buildRoutePlan({
      baseUrl: 'https://m3.material.io',
      includeBlog: false,
      siteMeta: null,
      normalizedSiteMetaRoutes: [],
      bundleRoutes: [{ slug: 'components/internal-only', documentId: 'doc-internal', collectionId: 'ComponentsM3' }],
      sitemapPaths: []
    });

    expect(plan.acceptedRoutes).toEqual([]);
    expect(plan.nonPublicRoutes).toContainEqual(expect.objectContaining({
      route: '/components/internal-only',
      publicDocsClassification: 'outside-public-docs'
    }));
  });

  it('uses parsed pageCanonId identity before normalized slug matching', () => {
    const plan = buildRoutePlan({
      baseUrl: 'https://m3.material.io',
      includeBlog: false,
      siteMeta: null,
      normalizedSiteMetaRoutes: [route('/components/selection-controls', { pageCanonId: 'page-canon-radio' })],
      bundleRoutes: [{ slug: 'components/radio-button', documentId: 'doc-radio', collectionId: 'ComponentsM3', exportedCarbonFileId: 'radio.json', pageCanonId: 'page-canon-radio' }],
      sitemapPaths: []
    });

    expect(plan.acceptedRoutes).toContainEqual(expect.objectContaining({
      route: '/components/selection-controls',
      canonicalRoute: '/components/radio-button',
      reconciliationStatus: 'contentIdentityMatch',
      identityFieldsUsed: ['pageCanonId']
    }));
  });

  it('includes nav drawer labels in diagnostics', () => {
    const bundleRoutes: BundleRouteEntry[] = [
      { slug: 'components/nav-only', documentId: 'doc-nav', collectionId: 'ComponentsM3' }
    ];

    const plan = buildRoutePlan({
      baseUrl: 'https://m3.material.io',
      includeBlog: false,
      siteMeta,
      normalizedSiteMetaRoutes: [],
      bundleRoutes,
      sitemapPaths: []
    });

    expect(plan.acceptedRoutes).toEqual(expect.arrayContaining([
      expect.objectContaining({ route: '/components/nav-only', canonicalRoute: '/components/nav-only', navTitle: 'Nav only label' })
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

  it('rejects public sitemap routes whose matched bundle entry lacks extraction metadata', () => {
    const plan = buildRoutePlan({
      baseUrl: 'https://m3.material.io',
      includeBlog: false,
      siteMeta: null,
      normalizedSiteMetaRoutes: [],
      bundleRoutes: [{ slug: 'components/missing-meta' }],
      sitemapPaths: ['/components/missing-meta']
    });

    expect(plan.nonPublicRoutes).toContainEqual(expect.objectContaining({
      route: '/components/missing-meta',
      publicDocsClassification: 'missing-extraction-metadata',
      failureReason: 'matched bundle route lacks collectionId/documentId'
    }));
    expect(plan.acceptedRoutes).toEqual([]);
  });

  it('does not singularize styles routes', () => {
    const plan = buildRoutePlan({
      baseUrl: 'https://m3.material.io',
      includeBlog: false,
      siteMeta: null,
      normalizedSiteMetaRoutes: [route('/styles/color/roles')],
      bundleRoutes: [{ slug: 'styles/color/role', documentId: 'doc-role', collectionId: 'GuidelinesM3' }],
      sitemapPaths: []
    });

    expect(plan.acceptedRoutes).not.toContainEqual(expect.objectContaining({
      route: '/styles/color/roles'
    }));
    expect(plan.staleRoutes).toContainEqual(expect.objectContaining({
      route: '/styles/color/roles',
      reconciliationStatus: 'rejectedStale'
    }));
  });

  it('does not singularize foundations routes', () => {
    const plan = buildRoutePlan({
      baseUrl: 'https://m3.material.io',
      includeBlog: false,
      siteMeta: null,
      normalizedSiteMetaRoutes: [route('/foundations/design-tokens')],
      bundleRoutes: [{ slug: 'foundations/design-token', documentId: 'doc-token', collectionId: 'GuidelinesM3' }],
      sitemapPaths: []
    });

    expect(plan.acceptedRoutes).not.toContainEqual(expect.objectContaining({
      route: '/foundations/design-tokens'
    }));
    expect(plan.staleRoutes).toContainEqual(expect.objectContaining({
      route: '/foundations/design-tokens',
      reconciliationStatus: 'rejectedStale'
    }));
  });

  it('classifies develop routes only by explicit policy', () => {
    const plan = buildRoutePlan({
      baseUrl: 'https://m3.material.io',
      includeBlog: false,
      siteMeta: null,
      normalizedSiteMetaRoutes: [route('/develop/overview')],
      bundleRoutes: [
        { slug: 'develop/overview', documentId: 'doc-dev', collectionId: 'DevelopM3' },
        { slug: 'develop/android/compose', documentId: 'doc-compose', collectionId: 'DevelopM3' }
      ],
      sitemapPaths: ['/develop/android/compose']
    });

    expect(plan.acceptedRoutes).toContainEqual(expect.objectContaining({
      route: '/develop/overview',
      publicDocsClassification: 'public-docs'
    }));
    expect(plan.nonPublicRoutes).toContainEqual(expect.objectContaining({
      route: '/develop/android/compose',
      publicDocsClassification: 'unsupported-platform-or-policy'
    }));
  });

  it('does not blindly trust conflicting site_meta collection/document identity when the exact bundle route is known', () => {
    const plan = buildRoutePlan({
      baseUrl: 'https://m3.material.io',
      includeBlog: false,
      siteMeta: null,
      normalizedSiteMetaRoutes: [
        route('/components/switch', { collectionId: 'WrongCollection', documentId: 'wrong-doc' })
      ],
      bundleRoutes: [
        { slug: 'components/switch', documentId: 'doc-switch', collectionId: 'ComponentsM3', pageCanonId: 'page-canon-switch', exportedCarbonFileId: 'switch.json' }
      ],
      sitemapPaths: []
    });

    expect(plan.acceptedRoutes).toContainEqual(expect.objectContaining({
      route: '/components/switch',
      canonicalRoute: '/components/switch',
      reconciliationStatus: 'exact',
      identityFieldsUsed: ['slug'],
      collectionId: 'ComponentsM3',
      documentId: 'doc-switch'
    }));
  });

  it('does not reconcile a legacy site_meta id pair to an unrelated bundle route', () => {
    const plan = buildRoutePlan({
      baseUrl: 'https://m3.material.io',
      includeBlog: false,
      siteMeta: null,
      normalizedSiteMetaRoutes: [
        route('/components/switches', { collectionId: 'ComponentsM3', documentId: 'doc-checkbox' })
      ],
      bundleRoutes: [
        { slug: 'components/switch', documentId: 'doc-switch', collectionId: 'ComponentsM3' },
        { slug: 'components/checkbox', documentId: 'doc-checkbox', collectionId: 'ComponentsM3' }
      ],
      sitemapPaths: []
    });

    expect(plan.acceptedRoutes).toContainEqual(expect.objectContaining({
      route: '/components/switches',
      canonicalRoute: '/components/switch',
      reconciliationStatus: 'normalizedSlugMatch'
    }));
    expect(plan.acceptedRoutes).not.toContainEqual(expect.objectContaining({
      route: '/components/switches',
      canonicalRoute: '/components/checkbox',
      reconciliationStatus: 'contentIdentityMatch'
    }));
  });
});
