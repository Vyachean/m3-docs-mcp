import { describe, expect, it, vi } from 'vitest';
import { fetchSiteMeta } from '../src/json-extraction/fetch-site-meta.js';
import type { FetchDiagnostic } from '../src/raw-artifacts/fetch-diagnostics.js';

describe('fetchSiteMeta sitemap fallback', () => {
  it('uses sitemap.xml as a deterministic public route list when site_meta.js is gone', async () => {
    const sitemap = `<?xml version="1.0" encoding="UTF-8"?>
      <urlset>
        <url><loc>https://m3.material.io/components/buttons</loc></url>
        <url><loc>https://m3.material.io/styles/color/roles</loc></url>
        <url><loc>https://example.com/not-material</loc></url>
      </urlset>`;
    const diagnostics: FetchDiagnostic[] = [];
    const onRawText = vi.fn();
    const mockFetch = vi.fn(async (input: string | URL | Request) => {
      const url = String(input);
      if (url.endsWith('/site_meta.js')) {
        return {
          ok: false,
          status: 404,
          statusText: 'Not Found',
          headers: { get: () => 'text/html' },
          text: async () => '',
        } as unknown as Response;
      }
      if (url.endsWith('/sitemap.xml')) {
        return {
          ok: true,
          status: 200,
          statusText: 'OK',
          headers: { get: () => 'application/xml' },
          text: async () => sitemap,
        } as unknown as Response;
      }
      throw new Error(`Unexpected URL: ${url}`);
    });

    const result = await fetchSiteMeta(
      'https://m3.material.io',
      undefined,
      mockFetch as unknown as typeof fetch,
      diagnostics,
      onRawText,
    );

    expect(Object.keys(result.routes).sort()).toEqual([
      '/components/buttons',
      '/styles/color/roles',
    ]);
    expect(result.routes['/components/buttons']).toMatchObject({ public: true, other_routes: [] });
    expect(onRawText).not.toHaveBeenCalled();
    expect(mockFetch).toHaveBeenCalledTimes(2);
    expect(diagnostics).toEqual(expect.arrayContaining([
      expect.objectContaining({ expectedKind: 'site-meta', outcome: 'http-error', httpStatus: 404 }),
      expect.objectContaining({ expectedKind: 'sitemap', outcome: 'success', httpStatus: 200 }),
    ]));
  });

  it('also falls back when site_meta.js is present but no longer parseable', async () => {
    const diagnostics: FetchDiagnostic[] = [];
    const mockFetch = vi.fn(async (input: string | URL | Request) => {
      const url = String(input);
      return {
        ok: true,
        status: 200,
        statusText: 'OK',
        headers: { get: () => url.endsWith('/sitemap.xml') ? 'application/xml' : 'application/javascript' },
        text: async () => url.endsWith('/sitemap.xml')
          ? '<urlset><url><loc>https://m3.material.io/foundations/design-tokens</loc></url></urlset>'
          : 'const siteMetadataMoved = true;',
      } as unknown as Response;
    });

    const result = await fetchSiteMeta(
      'https://m3.material.io',
      undefined,
      mockFetch as unknown as typeof fetch,
      diagnostics,
    );

    expect(Object.keys(result.routes)).toEqual(['/foundations/design-tokens']);
    expect(diagnostics).toEqual(expect.arrayContaining([
      expect.objectContaining({ expectedKind: 'site-meta', outcome: 'parse-error' }),
      expect.objectContaining({ expectedKind: 'sitemap', outcome: 'success' }),
    ]));
  });

  it('remains fail-closed when neither site_meta.js nor sitemap.xml is usable', async () => {
    const mockFetch = vi.fn(async (input: string | URL | Request) => ({
      ok: false,
      status: String(input).endsWith('/site_meta.js') ? 404 : 503,
      statusText: String(input).endsWith('/site_meta.js') ? 'Not Found' : 'Unavailable',
      headers: { get: () => 'text/plain' },
      text: async () => '',
    } as unknown as Response));

    await expect(fetchSiteMeta(
      'https://m3.material.io',
      undefined,
      mockFetch as unknown as typeof fetch,
    )).rejects.toThrow(/site_meta\.js fetch failed: HTTP 404.*sitemap route fallback failed: sitemap\.xml fetch failed: HTTP 503/s);
  });
});
