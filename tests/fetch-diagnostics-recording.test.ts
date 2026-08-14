import { describe, expect, it, vi } from 'vitest';
import {
  createDsdbResourceFetcher,
  fetchCarbonContentByReference,
  fetchJsonPageBundle,
  fetchPageDataByReference,
} from '../src/json-extraction/fetch-json-page.js';
import { fetchSiteMeta } from '../src/json-extraction/fetch-site-meta.js';
import type { FetchDiagnostic } from '../src/raw-artifacts/fetch-diagnostics.js';

function jsonResponse(body: unknown, init: { ok?: boolean; status?: number; contentType?: string } = {}) {
  return {
    ok: init.ok ?? true,
    status: init.status ?? 200,
    headers: { get: () => init.contentType ?? 'application/json' },
    json: async () => body,
    text: async () => JSON.stringify(body),
  } as unknown as Response;
}

function badJsonResponse(init: { status?: number } = {}) {
  return {
    ok: true,
    status: init.status ?? 200,
    headers: { get: () => 'application/json' },
    json: async () => { throw new SyntaxError('Unexpected token in JSON'); },
    text: async () => 'not json',
  } as unknown as Response;
}

/** Builds a minimal site_meta.js body declaring the given paths as public routes. */
function siteMetaJsText(paths: string[]): string {
  const routes: Record<string, { public: true }> = {};
  for (const p of paths) routes[`/${p.replace(/^\/+/, '')}`] = { public: true };
  return `window.site_meta = ${JSON.stringify({ routes })};`;
}

describe('bounded transient JSON retries', () => {
  it('retries a transient page-data network error and succeeds', async () => {
    const diagnostics: FetchDiagnostic[] = [];
    const fetchImpl = vi.fn()
      .mockRejectedValueOnce(new Error('connection reset'))
      .mockResolvedValueOnce(jsonResponse({ title: 'Buttons' }));

    const result = await fetchPageDataByReference(
      'https://m3.material.io',
      { collectionId: 'ComponentsM3', documentId: '123' },
      undefined,
      fetchImpl as unknown as typeof fetch,
      diagnostics,
      '/components/buttons'
    );

    expect(result.status).toBe('ok');
    expect(fetchImpl).toHaveBeenCalledTimes(2);
    expect(diagnostics.some((entry) => entry.outcome === 'network-error' && entry.reason?.includes('retrying transient'))).toBe(true);
    expect(diagnostics.at(-1)?.outcome).toBe('success');
  });

  it('retries a transient 503 DSDB resource response and succeeds', async () => {
    const diagnostics: FetchDiagnostic[] = [];
    const fetchImpl = vi.fn()
      .mockResolvedValueOnce(jsonResponse({}, { ok: false, status: 503 }))
      .mockResolvedValueOnce(jsonResponse({ system: { tokenSets: [] } }));
    const fetchResource = createDsdbResourceFetcher(
      'https://m3.material.io',
      'cv-1',
      [],
      undefined,
      fetchImpl as unknown as typeof fetch,
      '/components/text-fields',
      diagnostics
    );

    const result = await fetchResource('designSystems/ds/components/text-fields', 'TOKEN_TABLE');

    expect(result).toEqual({ system: { tokenSets: [] } });
    expect(fetchImpl).toHaveBeenCalledTimes(2);
    expect(diagnostics[0]).toMatchObject({ outcome: 'http-error', httpStatus: 503 });
    expect(diagnostics.at(-1)?.outcome).toBe('success');
  });

  it('retries a transient 429 Carbon response and succeeds', async () => {
    const diagnostics: FetchDiagnostic[] = [];
    const fetchImpl = vi.fn()
      .mockResolvedValueOnce(jsonResponse({}, { ok: false, status: 429 }))
      .mockResolvedValueOnce(jsonResponse({ sections: [] }));

    const result = await fetchCarbonContentByReference(
      'https://m3.material.io',
      'cv-1',
      'resource.json',
      undefined,
      fetchImpl as unknown as typeof fetch,
      diagnostics
    );

    expect(result.status).toBe('ok');
    expect(fetchImpl).toHaveBeenCalledTimes(2);
    expect(diagnostics[0]).toMatchObject({ outcome: 'http-error', httpStatus: 429 });
  });

  it('does not retry a permanent 404 response', async () => {
    const diagnostics: FetchDiagnostic[] = [];
    const fetchImpl = vi.fn().mockResolvedValue(jsonResponse({}, { ok: false, status: 404 }));

    const result = await fetchPageDataByReference(
      'https://m3.material.io',
      { collectionId: 'ComponentsM3', documentId: 'missing' },
      undefined,
      fetchImpl as unknown as typeof fetch,
      diagnostics
    );

    expect(result.status).toBe('http-error');
    expect(fetchImpl).toHaveBeenCalledTimes(1);
    expect(diagnostics).toHaveLength(1);
    expect(diagnostics[0]).toMatchObject({ outcome: 'http-error', httpStatus: 404 });
  });
});

describe('FetchDiagnostic recording: fetchPageDataByReference', () => {
  it('records a success diagnostic for an ok JSON response', async () => {
    const diagnostics: FetchDiagnostic[] = [];
    const fetchImpl = vi.fn().mockResolvedValue(jsonResponse({ title: 'Buttons' }));
    await fetchPageDataByReference(
      'https://m3.material.io',
      { collectionId: 'ComponentsM3', documentId: '123' },
      undefined,
      fetchImpl as unknown as typeof fetch,
      diagnostics,
      '/components/buttons'
    );
    expect(diagnostics).toHaveLength(1);
    expect(diagnostics[0]).toMatchObject({
      outcome: 'success',
      expectedKind: 'page-data',
      httpStatus: 200,
      sourceRoute: '/components/buttons',
    });
  });

  it('records an http-error diagnostic for a non-ok response', async () => {
    const diagnostics: FetchDiagnostic[] = [];
    const fetchImpl = vi.fn().mockResolvedValue(jsonResponse({}, { ok: false, status: 404 }));
    await fetchPageDataByReference(
      'https://m3.material.io',
      { collectionId: 'ComponentsM3', documentId: '123' },
      undefined,
      fetchImpl as unknown as typeof fetch,
      diagnostics
    );
    expect(diagnostics).toHaveLength(1);
    expect(diagnostics[0]).toMatchObject({ outcome: 'http-error', httpStatus: 404, expectedKind: 'page-data' });
    expect(diagnostics[0]?.reason).toMatch(/404/);
  });

  it('records a network-error diagnostic when the fetch throws', async () => {
    const diagnostics: FetchDiagnostic[] = [];
    const fetchImpl = vi.fn().mockRejectedValue(new Error('network down'));
    await fetchPageDataByReference(
      'https://m3.material.io',
      { collectionId: 'ComponentsM3', documentId: '123' },
      undefined,
      fetchImpl as unknown as typeof fetch,
      diagnostics
    );
    expect(diagnostics).toHaveLength(3);
    expect(diagnostics.every((entry) => entry.outcome === 'network-error' && entry.networkError === 'network down')).toBe(true);
    expect(diagnostics.at(-1)?.reason).toBe('rejected: candidate fetch threw a network error');
  });

  it('records a parse-error diagnostic when the response body is not valid JSON', async () => {
    const diagnostics: FetchDiagnostic[] = [];
    const fetchImpl = vi.fn().mockResolvedValue(badJsonResponse());
    await fetchPageDataByReference(
      'https://m3.material.io',
      { collectionId: 'ComponentsM3', documentId: '123' },
      undefined,
      fetchImpl as unknown as typeof fetch,
      diagnostics
    );
    expect(diagnostics).toHaveLength(1);
    expect(diagnostics[0]).toMatchObject({ outcome: 'parse-error' });
    expect(diagnostics[0]?.parseError).toBeTruthy();
  });
});

describe('FetchDiagnostic recording: fetchCarbonContentByReference', () => {
  it('records a success diagnostic', async () => {
    const diagnostics: FetchDiagnostic[] = [];
    const fetchImpl = vi.fn().mockResolvedValue(jsonResponse({ sections: [] }));
    await fetchCarbonContentByReference(
      'https://m3.material.io',
      'cv-1',
      'resource.json',
      undefined,
      fetchImpl as unknown as typeof fetch,
      diagnostics,
      '/components/buttons'
    );
    expect(diagnostics).toHaveLength(1);
    expect(diagnostics[0]).toMatchObject({ outcome: 'success', expectedKind: 'carbon-content', sourceRoute: '/components/buttons' });
  });

  it('does not record a diagnostic when exportedCarbonFileId is missing (never fetched)', async () => {
    const diagnostics: FetchDiagnostic[] = [];
    const fetchImpl = vi.fn();
    await fetchCarbonContentByReference('https://m3.material.io', 'cv-1', undefined, undefined, fetchImpl as unknown as typeof fetch, diagnostics);
    expect(diagnostics).toHaveLength(0);
    expect(fetchImpl).not.toHaveBeenCalled();
  });
});

describe('FetchDiagnostic recording: fetchSiteMeta', () => {
  it('records a success diagnostic for a valid site_meta.js', async () => {
    const diagnostics: FetchDiagnostic[] = [];
    const fetchImpl = vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      headers: { get: () => 'text/javascript' },
      text: async () => siteMetaJsText(['components/buttons']),
    } as unknown as Response);
    await fetchSiteMeta('https://m3.material.io', undefined, fetchImpl as unknown as typeof fetch, diagnostics);
    expect(diagnostics).toHaveLength(1);
    expect(diagnostics[0]).toMatchObject({ outcome: 'success', expectedKind: 'site-meta' });
  });

  it('records an http-error diagnostic and throws when site_meta.js 404s', async () => {
    const diagnostics: FetchDiagnostic[] = [];
    const fetchImpl = vi.fn().mockResolvedValue({ ok: false, status: 404, statusText: 'Not Found' } as unknown as Response);
    await expect(fetchSiteMeta('https://m3.material.io', undefined, fetchImpl as unknown as typeof fetch, diagnostics)).rejects.toThrow();
    expect(diagnostics).toHaveLength(1);
    expect(diagnostics[0]).toMatchObject({ outcome: 'http-error', httpStatus: 404 });
  });

  it('records a network-error diagnostic and throws when the fetch itself fails', async () => {
    const diagnostics: FetchDiagnostic[] = [];
    const fetchImpl = vi.fn().mockRejectedValue(new Error('dns failure'));
    await expect(fetchSiteMeta('https://m3.material.io', undefined, fetchImpl as unknown as typeof fetch, diagnostics)).rejects.toThrow();
    expect(diagnostics).toHaveLength(1);
    expect(diagnostics[0]).toMatchObject({ outcome: 'network-error', networkError: 'dns failure' });
  });

  it('records a parse-error diagnostic and throws when the body has no window.site_meta assignment', async () => {
    const diagnostics: FetchDiagnostic[] = [];
    const fetchImpl = vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      headers: { get: () => 'text/javascript' },
      text: async () => 'not a site meta payload at all',
    } as unknown as Response);
    await expect(fetchSiteMeta('https://m3.material.io', undefined, fetchImpl as unknown as typeof fetch, diagnostics)).rejects.toThrow();
    expect(diagnostics).toHaveLength(1);
    expect(diagnostics[0]).toMatchObject({ outcome: 'parse-error' });
  });
});

describe('FetchDiagnostic recording: legacy candidate-guessing fetchJsonPageBundle', () => {
  it('records a rejected (http-error) diagnostic for each failing candidate URL and an accepted diagnostic for the winning one', async () => {
    const diagnostics: FetchDiagnostic[] = [];
    const fetchImpl = vi.fn(async (input: string | URL) => {
      const url = String(input);
      if (url.endsWith('/page-data/components/widgets/page-data.json')) {
        return jsonResponse({ result: { pageContext: { title: 'Widgets' } } });
      }
      return { ok: false, status: 404, headers: { get: () => null }, json: async () => ({}) } as unknown as Response;
    });

    await fetchJsonPageBundle(
      'https://m3.material.io',
      'cv-1',
      { slug: 'components/widgets' },
      undefined,
      fetchImpl as unknown as typeof fetch,
      diagnostics
    );

    const pageDataDiagnostics = diagnostics.filter((d) => d.expectedKind === 'page-data');
    expect(pageDataDiagnostics.length).toBeGreaterThan(0);
    expect(pageDataDiagnostics.some((d) => d.outcome === 'success')).toBe(true);
    expect(pageDataDiagnostics.some((d) => d.outcome === 'success' && d.reason?.startsWith('accepted'))).toBe(true);
  });

  it('records a network-error diagnostic when every legacy candidate URL throws', async () => {
    const diagnostics: FetchDiagnostic[] = [];
    const fetchImpl = vi.fn().mockRejectedValue(new Error('connection reset'));

    await fetchJsonPageBundle(
      'https://m3.material.io',
      'cv-1',
      { slug: 'components/widgets' },
      undefined,
      fetchImpl as unknown as typeof fetch,
      diagnostics
    );

    expect(diagnostics.length).toBeGreaterThan(0);
    expect(diagnostics.every((d) => d.outcome === 'network-error')).toBe(true);
    expect(diagnostics.every((d) => d.networkError === 'connection reset')).toBe(true);
  });
});
