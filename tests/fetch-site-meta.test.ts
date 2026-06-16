import { describe, expect, it, vi } from 'vitest';
import {
  SiteMetaParseError,
  buildSiteMetaRouteDescriptors,
  fetchSiteMeta,
  parseSiteMetaJs,
} from '../src/json-extraction/fetch-site-meta.js';

// ── parseSiteMetaJs ───────────────────────────────────────────────────────────

describe('parseSiteMetaJs', () => {
  const validRoutes = [
    {
      route: '/components/buttons/overview',
      other_routes: ['/components/buttons'],
      public: true,
      redirect_external_url: null,
      reference: { collection_id: 'components', document_id: 'buttons-overview', repo_id: 'm3' }
    }
  ];

  it('parses window.site_meta assignment', () => {
    const js = `window.site_meta = ${JSON.stringify({ routes: validRoutes })};`;
    const result = parseSiteMetaJs(js);
    expect(result.routes).toHaveLength(1);
    expect(result.routes[0]?.route).toBe('/components/buttons/overview');
  });

  it('parses self.site_meta assignment', () => {
    const js = `self.site_meta=${JSON.stringify({ routes: validRoutes })}`;
    const result = parseSiteMetaJs(js);
    expect(result.routes).toHaveLength(1);
  });

  it('parses bare site_meta assignment without window prefix', () => {
    const js = `var site_meta = ${JSON.stringify({ routes: validRoutes })};`;
    const result = parseSiteMetaJs(js);
    expect(result.routes).toHaveLength(1);
  });

  it('throws SiteMetaParseError when assignment not found', () => {
    expect(() => parseSiteMetaJs('const foo = {};')).toThrow(SiteMetaParseError);
    expect(() => parseSiteMetaJs('const foo = {};')).toThrow(/assignment not found/);
  });

  it('throws SiteMetaParseError when JSON is malformed', () => {
    const js = `window.site_meta = {routes: [invalid json}`;
    expect(() => parseSiteMetaJs(js)).toThrow(SiteMetaParseError);
  });

  it('throws SiteMetaParseError when routes array is missing', () => {
    const js = `window.site_meta = ${JSON.stringify({ notRoutes: [] })};`;
    expect(() => parseSiteMetaJs(js)).toThrow(SiteMetaParseError);
    expect(() => parseSiteMetaJs(js)).toThrow(/schema validation failed/);
  });

  it('throws SiteMetaParseError when routes array is empty', () => {
    const js = `window.site_meta = ${JSON.stringify({ routes: [] })};`;
    expect(() => parseSiteMetaJs(js)).toThrow(SiteMetaParseError);
    expect(() => parseSiteMetaJs(js)).toThrow(/routes array is empty/);
  });

  it('preserves reference fields collection_id, document_id, repo_id', () => {
    const js = `window.site_meta = ${JSON.stringify({ routes: validRoutes })};`;
    const result = parseSiteMetaJs(js);
    expect(result.routes[0]?.reference?.collection_id).toBe('components');
    expect(result.routes[0]?.reference?.document_id).toBe('buttons-overview');
    expect(result.routes[0]?.reference?.repo_id).toBe('m3');
  });

  it('preserves other_routes aliases', () => {
    const js = `window.site_meta = ${JSON.stringify({ routes: validRoutes })};`;
    const result = parseSiteMetaJs(js);
    expect(result.routes[0]?.other_routes).toEqual(['/components/buttons']);
  });

  it('handles routes with missing optional fields', () => {
    const minimalRoute = { route: '/styles/color' };
    const js = `window.site_meta = ${JSON.stringify({ routes: [minimalRoute] })};`;
    const result = parseSiteMetaJs(js);
    expect(result.routes[0]?.route).toBe('/styles/color');
    expect(result.routes[0]?.public).toBeUndefined();
  });

  it('handles deeply nested JSON objects inside routes', () => {
    const complexRoutes = [
      {
        route: '/foundations/design-tokens/overview',
        other_routes: [],
        public: true,
        redirect_external_url: null,
        reference: {
          collection_id: 'foundations',
          document_id: 'design-tokens-overview',
          repo_id: 'm3',
          extra: { nested: { deep: true } }
        }
      }
    ];
    const js = `window.site_meta = ${JSON.stringify({ routes: complexRoutes })};`;
    const result = parseSiteMetaJs(js);
    expect(result.routes[0]?.route).toBe('/foundations/design-tokens/overview');
  });

  it('handles strings containing braces inside route values', () => {
    const routes = [
      { route: '/test/{param}', other_routes: [], public: true }
    ];
    const js = `window.site_meta = ${JSON.stringify({ routes })};`;
    const result = parseSiteMetaJs(js);
    expect(result.routes[0]?.route).toBe('/test/{param}');
  });
});

// ── buildSiteMetaRouteDescriptors ─────────────────────────────────────────────

describe('buildSiteMetaRouteDescriptors', () => {
  it('includes public non-redirect routes', () => {
    const siteMeta = {
      routes: [
        { route: '/components/buttons/overview', other_routes: [], public: true, redirect_external_url: null }
      ]
    };
    const { routes, publicCount } = buildSiteMetaRouteDescriptors(siteMeta);
    expect(routes).toHaveLength(1);
    expect(routes[0]?.route).toBe('/components/buttons/overview');
    expect(publicCount).toBe(1);
  });

  it('excludes private routes', () => {
    const siteMeta = {
      routes: [
        { route: '/internal/page', other_routes: [], public: false }
      ]
    };
    const { routes, privateCount } = buildSiteMetaRouteDescriptors(siteMeta);
    expect(routes).toHaveLength(0);
    expect(privateCount).toBe(1);
  });

  it('excludes routes with redirect_external_url set', () => {
    const siteMeta = {
      routes: [
        { route: '/old-path', other_routes: [], public: true, redirect_external_url: 'https://example.com' }
      ]
    };
    const { routes, redirectCount } = buildSiteMetaRouteDescriptors(siteMeta);
    expect(routes).toHaveLength(0);
    expect(redirectCount).toBe(1);
  });

  it('treats routes with undefined public as public', () => {
    const siteMeta = {
      routes: [
        { route: '/components/lists/overview', other_routes: [] }
      ]
    };
    const { routes } = buildSiteMetaRouteDescriptors(siteMeta);
    expect(routes).toHaveLength(1);
  });

  it('deduplicates routes with identical canonical route paths', () => {
    const siteMeta = {
      routes: [
        { route: '/styles/color', other_routes: [], public: true },
        { route: '/styles/color', other_routes: ['/styles/colour'], public: true }
      ]
    };
    const { routes } = buildSiteMetaRouteDescriptors(siteMeta);
    expect(routes).toHaveLength(1);
  });

  it('collects other_routes as aliases (excluding canonical)', () => {
    const siteMeta = {
      routes: [
        {
          route: '/components/buttons/overview',
          other_routes: ['/components/buttons', '/components/buttons/overview'],
          public: true
        }
      ]
    };
    const { routes, aliasCount } = buildSiteMetaRouteDescriptors(siteMeta);
    // other_routes that equal the canonical route are excluded
    expect(routes[0]?.otherRoutes).toEqual(['/components/buttons']);
    expect(aliasCount).toBe(1);
  });

  it('maps reference fields to descriptor properties', () => {
    const siteMeta = {
      routes: [
        {
          route: '/components/dialogs/overview',
          other_routes: [],
          public: true,
          reference: { collection_id: 'components', document_id: 'dialogs-overview', repo_id: 'm3' }
        }
      ]
    };
    const { routes } = buildSiteMetaRouteDescriptors(siteMeta);
    expect(routes[0]?.collectionId).toBe('components');
    expect(routes[0]?.documentId).toBe('dialogs-overview');
    expect(routes[0]?.repoId).toBe('m3');
  });

  it('produces descriptor with undefined ids when reference is missing', () => {
    const siteMeta = {
      routes: [
        { route: '/styles/color', other_routes: [], public: true }
      ]
    };
    const { routes } = buildSiteMetaRouteDescriptors(siteMeta);
    expect(routes[0]?.collectionId).toBeUndefined();
    expect(routes[0]?.documentId).toBeUndefined();
  });

  it('counts all fields correctly for a mixed set', () => {
    const siteMeta = {
      routes: [
        { route: '/a', other_routes: ['/a-alias'], public: true },
        { route: '/b', other_routes: [], public: false },
        { route: '/c', other_routes: [], public: true, redirect_external_url: 'https://external.com' },
        { route: '/d', other_routes: ['/d-alias1', '/d-alias2'], public: true }
      ]
    };
    const { routes, publicCount, privateCount, redirectCount, aliasCount } = buildSiteMetaRouteDescriptors(siteMeta);
    expect(routes).toHaveLength(2); // /a and /d
    expect(publicCount).toBe(2);
    expect(privateCount).toBe(1);
    expect(redirectCount).toBe(1);
    expect(aliasCount).toBe(3); // /a-alias + /d-alias1 + /d-alias2
  });
});

// ── fetchSiteMeta ─────────────────────────────────────────────────────────────

describe('fetchSiteMeta', () => {
  it('fetches and parses site_meta.js from baseUrl', async () => {
    const routes = [
      { route: '/components/buttons/overview', other_routes: [], public: true }
    ];
    const mockFetch = vi.fn(async () => ({
      ok: true,
      text: async () => `window.site_meta = ${JSON.stringify({ routes })};`
    }));

    const result = await fetchSiteMeta('https://m3.material.io', undefined, mockFetch as unknown as typeof fetch);
    expect(result.routes).toHaveLength(1);
    expect(mockFetch).toHaveBeenCalledWith('https://m3.material.io/site_meta.js', expect.any(Object));
  });

  it('throws SiteMetaParseError on HTTP error', async () => {
    const mockFetch = vi.fn(async () => ({ ok: false, status: 404, statusText: 'Not Found' }));

    await expect(fetchSiteMeta('https://m3.material.io', undefined, mockFetch as unknown as typeof fetch))
      .rejects.toThrow(SiteMetaParseError);
    await expect(fetchSiteMeta('https://m3.material.io', undefined, mockFetch as unknown as typeof fetch))
      .rejects.toThrow(/HTTP 404/);
  });

  it('throws SiteMetaParseError when JS has invalid JSON', async () => {
    const mockFetch = vi.fn(async () => ({
      ok: true,
      text: async () => 'window.site_meta = {invalid json;'
    }));

    await expect(fetchSiteMeta('https://m3.material.io', undefined, mockFetch as unknown as typeof fetch))
      .rejects.toThrow(SiteMetaParseError);
  });

  it('throws SiteMetaParseError when network throws', async () => {
    const mockFetch = vi.fn(async () => { throw new Error('network error'); });

    await expect(fetchSiteMeta('https://m3.material.io', undefined, mockFetch as unknown as typeof fetch))
      .rejects.toThrow(SiteMetaParseError);
    await expect(fetchSiteMeta('https://m3.material.io', undefined, mockFetch as unknown as typeof fetch))
      .rejects.toThrow(/network error/);
  });

  it('constructs the correct URL from baseUrl', async () => {
    const mockFetch = vi.fn(async () => ({
      ok: true,
      text: async () => `window.site_meta = ${JSON.stringify({ routes: [{ route: '/a', other_routes: [], public: true }] })};`
    }));

    await fetchSiteMeta('https://m3.material.io', undefined, mockFetch as unknown as typeof fetch);
    expect(mockFetch).toHaveBeenCalledWith('https://m3.material.io/site_meta.js', expect.any(Object));
  });

  it('passes the AbortSignal to fetch', async () => {
    const controller = new AbortController();
    const capturedOptions: RequestInit[] = [];
    const mockFetch = vi.fn(async (_url: unknown, opts: RequestInit) => {
      capturedOptions.push(opts);
      return {
        ok: true,
        text: async () => `window.site_meta = ${JSON.stringify({ routes: [{ route: '/a', other_routes: [], public: true }] })};`
      };
    });

    await fetchSiteMeta('https://m3.material.io', controller.signal, mockFetch as unknown as typeof fetch);
    expect(capturedOptions[0]?.signal).toBe(controller.signal);
  });
});
