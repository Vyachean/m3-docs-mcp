import { describe, expect, it } from 'vitest';
import { filterRoutes, normalizeSiteMetaRoutes } from '../src/json-extraction/normalize-routes.js';

describe('normalizeSiteMetaRoutes', () => {
  it('fails when site_meta is not an object', () => {
    const result = normalizeSiteMetaRoutes('not-an-object');
    expect(result.ok).toBe(false);
  });

  it('fails when site_meta.routes is not an object map', () => {
    const result = normalizeSiteMetaRoutes({ routes: ['array', 'not', 'map'] });
    expect(result.ok).toBe(false);
  });

  it('normalizes a real-shaped route with numeric reference ids', () => {
    const result = normalizeSiteMetaRoutes({
      routes: {
        '/': {
          other_routes: ['/index.html', '/homepage'],
          public: true,
          redirect_external_url: null,
          reference: { collection_id: 'Homepage', document_id: 5909068158074880, repo_id: 'mio-example' },
        },
      },
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.routes).toHaveLength(1);
    expect(result.routes[0]).toMatchObject({
      path: '/',
      documentId: '5909068158074880',
      collectionId: 'Homepage',
      repoId: 'mio-example',
      navigationSource: 'site-meta',
    });
    expect(result.routes[0]?.aliases).toEqual(['/index.html', '/homepage']);
  });

  it('skips an invalid individual route without failing the whole parse', () => {
    const result = normalizeSiteMetaRoutes({
      routes: {
        '/valid': { public: true },
        '/invalid': 'not-an-object',
      },
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.routes).toHaveLength(1);
    expect(result.invalidRouteCount).toBe(1);
  });

  it('treats missing reference as null ids, not fatal', () => {
    const result = normalizeSiteMetaRoutes({ routes: { '/styles/color': { public: true } } });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.routes[0]?.collectionId).toBeNull();
    expect(result.routes[0]?.documentId).toBeNull();
  });

  it('marks blog routes via isBlogPath', () => {
    const result = normalizeSiteMetaRoutes({ routes: { '/blog/foo': { public: true } } });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.routes[0]?.isBlog).toBe(true);
  });

  it('deduplicates aliases pointing at the same target across routes', () => {
    const result = normalizeSiteMetaRoutes({
      routes: {
        '/components/buttons/overview': { other_routes: ['/components/buttons', '/components/buttons'], public: true },
      },
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.routes[0]?.aliases).toEqual(['/components/buttons']);
    expect(result.deduplicatedAliasCount).toBe(1);
  });
});

describe('filterRoutes', () => {
  function route(path: string, overrides: Partial<Parameters<typeof normalizeSiteMetaRoutes>[0]> = {}) {
    const result = normalizeSiteMetaRoutes({ routes: { [path]: { public: true, ...overrides } } });
    if (!result.ok) throw new Error('bad fixture');
    return result.routes[0]!;
  }

  it('excludes private routes', () => {
    const result = normalizeSiteMetaRoutes({ routes: { '/secret': { public: false } } });
    if (!result.ok) throw new Error('bad fixture');
    const filtered = filterRoutes(result.routes, { includeBlog: false, maxPages: null });
    expect(filtered.selected).toHaveLength(0);
    expect(filtered.skippedPrivateCount).toBe(1);
  });

  it('excludes routes with redirect_external_url', () => {
    const result = normalizeSiteMetaRoutes({ routes: { '/old': { public: true, redirect_external_url: 'https://example.com' } } });
    if (!result.ok) throw new Error('bad fixture');
    const filtered = filterRoutes(result.routes, { includeBlog: false, maxPages: null });
    expect(filtered.selected).toHaveLength(0);
    expect(filtered.skippedRedirectCount).toBe(1);
  });

  it('excludes blog routes when includeBlog is false', () => {
    const result = normalizeSiteMetaRoutes({ routes: { '/blog/post': { public: true } } });
    if (!result.ok) throw new Error('bad fixture');
    const filtered = filterRoutes(result.routes, { includeBlog: false, maxPages: null });
    expect(filtered.selected).toHaveLength(0);
    expect(filtered.skippedBlogCount).toBe(1);
  });

  it('keeps blog routes when includeBlog is true', () => {
    const result = normalizeSiteMetaRoutes({ routes: { '/blog/post': { public: true } } });
    if (!result.ok) throw new Error('bad fixture');
    const filtered = filterRoutes(result.routes, { includeBlog: true, maxPages: null });
    expect(filtered.selected).toHaveLength(1);
  });

  it('limits selected routes to maxPages', () => {
    const routes = [route('/a'), route('/b'), route('/c')];
    const filtered = filterRoutes(routes, { includeBlog: false, maxPages: 2 });
    expect(filtered.selected).toHaveLength(2);
  });

  it('reserves slots for requiredPaths beyond maxPages and tags them required-validation', () => {
    const routes = [route('/a'), route('/b'), route('/c'), route('/required')];
    const filtered = filterRoutes(routes, { includeBlog: false, maxPages: 2, requiredPaths: ['/required'] });
    expect(filtered.selected.map((r) => r.path)).toContain('/required');
    expect(filtered.selected.find((r) => r.path === '/required')?.selectedBecause).toBe('required-validation');
    expect(filtered.selected).toHaveLength(2);
  });
});
