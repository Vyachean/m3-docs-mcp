import { describe, expect, it, vi } from 'vitest';
import {
  SiteMetaParseError,
  buildSiteMetaRouteDescriptors,
  fetchSiteMeta,
  parseSiteMetaJs,
} from '../src/json-extraction/fetch-site-meta.js';

// ── parseSiteMetaJs ───────────────────────────────────────────────────────────

describe('parseSiteMetaJs', () => {
  // Real site shape: routes is an object map keyed by route path
  const validRoutesObject = {
    '/components/buttons/overview': {
      other_routes: ['/components/buttons'],
      public: true,
      redirect_external_url: null,
      reference: { collection_id: 'components', document_id: 'buttons-overview', repo_id: 'm3' }
    }
  };

  it('parses window.site_meta assignment with object-map routes (real site shape)', () => {
    const js = `window.site_meta = ${JSON.stringify({ routes: validRoutesObject })};`;
    const result = parseSiteMetaJs(js);
    expect(Object.keys(result.routes)).toHaveLength(1);
    expect(result.routes['/components/buttons/overview']).toBeDefined();
  });

  it('parses self.site_meta assignment', () => {
    const js = `self.site_meta=${JSON.stringify({ routes: validRoutesObject })}`;
    const result = parseSiteMetaJs(js);
    expect(Object.keys(result.routes)).toHaveLength(1);
  });

  it('parses bare site_meta assignment without window prefix', () => {
    const js = `var site_meta = ${JSON.stringify({ routes: validRoutesObject })};`;
    const result = parseSiteMetaJs(js);
    expect(Object.keys(result.routes)).toHaveLength(1);
  });

  it('throws SiteMetaParseError when assignment not found', () => {
    expect(() => parseSiteMetaJs('const foo = {};')).toThrow(SiteMetaParseError);
    expect(() => parseSiteMetaJs('const foo = {};')).toThrow(/assignment not found/);
  });

  it('throws SiteMetaParseError when JSON is malformed', () => {
    const js = `window.site_meta = {routes: [invalid json}`;
    expect(() => parseSiteMetaJs(js)).toThrow(SiteMetaParseError);
  });

  it('throws SiteMetaParseError (isFormatError=true) when routes is missing', () => {
    const js = `window.site_meta = ${JSON.stringify({ notRoutes: {} })};`;
    expect(() => parseSiteMetaJs(js)).toThrow(SiteMetaParseError);
    expect(() => parseSiteMetaJs(js)).toThrow(/schema validation failed/);
    let thrown: SiteMetaParseError | null = null;
    try { parseSiteMetaJs(js); } catch (e) { thrown = e as SiteMetaParseError; }
    expect(thrown?.isFormatError).toBe(true);
  });

  it('throws SiteMetaParseError (isFormatError=true) when routes is an array (old schema assumed)', () => {
    const js = `window.site_meta = ${JSON.stringify({ routes: [{ route: '/x', public: true }] })};`;
    expect(() => parseSiteMetaJs(js)).toThrow(SiteMetaParseError);
    expect(() => parseSiteMetaJs(js)).toThrow(/schema validation failed/);
    let thrown: SiteMetaParseError | null = null;
    try { parseSiteMetaJs(js); } catch (e) { thrown = e as SiteMetaParseError; }
    expect(thrown?.isFormatError).toBe(true);
  });

  it('throws SiteMetaParseError (isFormatError=true) when routes object is empty', () => {
    const js = `window.site_meta = ${JSON.stringify({ routes: {} })};`;
    expect(() => parseSiteMetaJs(js)).toThrow(SiteMetaParseError);
    expect(() => parseSiteMetaJs(js)).toThrow(/routes object is empty/);
    let thrown: SiteMetaParseError | null = null;
    try { parseSiteMetaJs(js); } catch (e) { thrown = e as SiteMetaParseError; }
    expect(thrown?.isFormatError).toBe(true);
  });

  it('isFormatError is false for network/assignment-not-found errors', () => {
    let thrown: SiteMetaParseError | null = null;
    try { parseSiteMetaJs('const foo = {};'); } catch (e) { thrown = e as SiteMetaParseError; }
    expect(thrown?.isFormatError).toBe(false);
  });

  it('preserves reference fields collection_id, document_id, repo_id', () => {
    const js = `window.site_meta = ${JSON.stringify({ routes: validRoutesObject })};`;
    const result = parseSiteMetaJs(js);
    const route = result.routes['/components/buttons/overview'];
    expect(route?.reference?.collection_id).toBe('components');
    expect(route?.reference?.document_id).toBe('buttons-overview');
    expect(route?.reference?.repo_id).toBe('m3');
  });

  it('preserves other_routes aliases', () => {
    const js = `window.site_meta = ${JSON.stringify({ routes: validRoutesObject })};`;
    const result = parseSiteMetaJs(js);
    expect(result.routes['/components/buttons/overview']?.other_routes).toEqual(['/components/buttons']);
  });

  it('handles routes with missing optional fields', () => {
    const js = `window.site_meta = ${JSON.stringify({ routes: { '/styles/color': {} } })};`;
    const result = parseSiteMetaJs(js);
    expect(result.routes['/styles/color']).toBeDefined();
    expect(result.routes['/styles/color']?.public).toBeUndefined();
  });

  it('handles deeply nested JSON objects inside route values', () => {
    const routes = {
      '/foundations/design-tokens/overview': {
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
    };
    const js = `window.site_meta = ${JSON.stringify({ routes })};`;
    const result = parseSiteMetaJs(js);
    expect(result.routes['/foundations/design-tokens/overview']).toBeDefined();
  });

  it('handles strings containing braces inside route values', () => {
    const routes = { '/test/{param}': { other_routes: [], public: true } };
    const js = `window.site_meta = ${JSON.stringify({ routes })};`;
    const result = parseSiteMetaJs(js);
    expect(result.routes['/test/{param}']).toBeDefined();
  });

  it('handles many routes — matches real site scale', () => {
    const routes: Record<string, { public: boolean; reference: { collection_id: string; document_id: string } }> = {};
    for (let i = 0; i < 400; i++) {
      routes[`/components/item-${i}/specs`] = {
        public: true,
        reference: { collection_id: 'components', document_id: `item-${i}-specs` }
      };
    }
    const js = `window.site_meta = ${JSON.stringify({ routes })};`;
    const result = parseSiteMetaJs(js);
    expect(Object.keys(result.routes)).toHaveLength(400);
  });
});

// ── buildSiteMetaRouteDescriptors ─────────────────────────────────────────────

describe('buildSiteMetaRouteDescriptors', () => {
  it('includes public non-redirect routes', () => {
    const siteMeta = {
      routes: {
        '/components/buttons/overview': { other_routes: [], public: true, redirect_external_url: null }
      }
    };
    const { routes, publicCount } = buildSiteMetaRouteDescriptors(siteMeta);
    expect(routes).toHaveLength(1);
    expect(routes[0]?.route).toBe('/components/buttons/overview');
    expect(publicCount).toBe(1);
  });

  it('excludes private routes', () => {
    const siteMeta = {
      routes: {
        '/internal/page': { other_routes: [], public: false }
      }
    };
    const { routes, privateCount } = buildSiteMetaRouteDescriptors(siteMeta);
    expect(routes).toHaveLength(0);
    expect(privateCount).toBe(1);
  });

  it('excludes routes with redirect_external_url set', () => {
    const siteMeta = {
      routes: {
        '/old-path': { other_routes: [], public: true, redirect_external_url: 'https://example.com' }
      }
    };
    const { routes, redirectCount } = buildSiteMetaRouteDescriptors(siteMeta);
    expect(routes).toHaveLength(0);
    expect(redirectCount).toBe(1);
  });

  it('treats routes with undefined public as public', () => {
    const siteMeta = {
      routes: {
        '/components/lists/overview': { other_routes: [] }
      }
    };
    const { routes } = buildSiteMetaRouteDescriptors(siteMeta);
    expect(routes).toHaveLength(1);
  });

  it('deduplicates routes with identical canonical route paths', () => {
    // Object keys are always unique, so duplication is not possible in the new format.
    // Verify that a single entry produces exactly one descriptor.
    const siteMeta = {
      routes: {
        '/styles/color': { other_routes: ['/styles/colour'], public: true }
      }
    };
    const { routes } = buildSiteMetaRouteDescriptors(siteMeta);
    expect(routes).toHaveLength(1);
    expect(routes[0]?.route).toBe('/styles/color');
  });

  it('collects other_routes as aliases (excluding canonical)', () => {
    const siteMeta = {
      routes: {
        '/components/buttons/overview': {
          other_routes: ['/components/buttons', '/components/buttons/overview'],
          public: true
        }
      }
    };
    const { routes, aliasCount } = buildSiteMetaRouteDescriptors(siteMeta);
    // other_routes that equal the canonical route are excluded
    expect(routes[0]?.otherRoutes).toEqual(['/components/buttons']);
    expect(aliasCount).toBe(1);
  });

  it('maps reference fields to descriptor properties', () => {
    const siteMeta = {
      routes: {
        '/components/dialogs/overview': {
          other_routes: [],
          public: true,
          reference: { collection_id: 'components', document_id: 'dialogs-overview', repo_id: 'm3' }
        }
      }
    };
    const { routes } = buildSiteMetaRouteDescriptors(siteMeta);
    expect(routes[0]?.collectionId).toBe('components');
    expect(routes[0]?.documentId).toBe('dialogs-overview');
    expect(routes[0]?.repoId).toBe('m3');
  });

  it('produces descriptor with undefined ids when reference is missing', () => {
    const siteMeta = {
      routes: {
        '/styles/color': { other_routes: [], public: true }
      }
    };
    const { routes } = buildSiteMetaRouteDescriptors(siteMeta);
    expect(routes[0]?.collectionId).toBeUndefined();
    expect(routes[0]?.documentId).toBeUndefined();
  });

  it('counts all fields correctly for a mixed set', () => {
    const siteMeta = {
      routes: {
        '/a': { other_routes: ['/a-alias'], public: true },
        '/b': { other_routes: [], public: false },
        '/c': { other_routes: [], public: true, redirect_external_url: 'https://external.com' },
        '/d': { other_routes: ['/d-alias1', '/d-alias2'], public: true }
      }
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
  const routesObject = {
    '/components/buttons/overview': { other_routes: [], public: true }
  };

  it('fetches and parses site_meta.js from baseUrl (object-map routes)', async () => {
    const mockFetch = vi.fn(async () => ({
      ok: true,
      text: async () => `window.site_meta = ${JSON.stringify({ routes: routesObject })};`
    }));

    const result = await fetchSiteMeta('https://m3.material.io', undefined, mockFetch as unknown as typeof fetch);
    expect(Object.keys(result.routes)).toHaveLength(1);
    expect(mockFetch).toHaveBeenCalledWith('https://m3.material.io/site_meta.js', expect.any(Object));
  });

  it('throws SiteMetaParseError on HTTP error', async () => {
    const mockFetch = vi.fn(async () => ({ ok: false, status: 404, statusText: 'Not Found' }));

    await expect(fetchSiteMeta('https://m3.material.io', undefined, mockFetch as unknown as typeof fetch))
      .rejects.toThrow(SiteMetaParseError);
    await expect(fetchSiteMeta('https://m3.material.io', undefined, mockFetch as unknown as typeof fetch))
      .rejects.toThrow(/HTTP 404/);
  });

  it('throws SiteMetaParseError (isFormatError=false) on HTTP error', async () => {
    const mockFetch = vi.fn(async () => ({ ok: false, status: 404, statusText: 'Not Found' }));
    let thrown: SiteMetaParseError | null = null;
    try {
      await fetchSiteMeta('https://m3.material.io', undefined, mockFetch as unknown as typeof fetch);
    } catch (e) {
      thrown = e as SiteMetaParseError;
    }
    expect(thrown?.isFormatError).toBe(false);
  });

  it('throws SiteMetaParseError when JS has invalid JSON', async () => {
    const mockFetch = vi.fn(async () => ({
      ok: true,
      text: async () => 'window.site_meta = {invalid json;'
    }));

    await expect(fetchSiteMeta('https://m3.material.io', undefined, mockFetch as unknown as typeof fetch))
      .rejects.toThrow(SiteMetaParseError);
  });

  it('throws SiteMetaParseError (isFormatError=true) when schema is wrong (e.g. routes is an array)', async () => {
    const mockFetch = vi.fn(async () => ({
      ok: true,
      text: async () => `window.site_meta = ${JSON.stringify({ routes: [{ route: '/x', public: true }] })};`
    }));
    let thrown: SiteMetaParseError | null = null;
    try {
      await fetchSiteMeta('https://m3.material.io', undefined, mockFetch as unknown as typeof fetch);
    } catch (e) {
      thrown = e as SiteMetaParseError;
    }
    expect(thrown).toBeInstanceOf(SiteMetaParseError);
    expect(thrown?.isFormatError).toBe(true);
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
      text: async () => `window.site_meta = ${JSON.stringify({ routes: { '/a': { other_routes: [], public: true } } })};`
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
        text: async () => `window.site_meta = ${JSON.stringify({ routes: { '/a': { other_routes: [], public: true } } })};`
      };
    });

    await fetchSiteMeta('https://m3.material.io', controller.signal, mockFetch as unknown as typeof fetch);
    expect(capturedOptions[0]?.signal).toBe(controller.signal);
  });
});
