import { describe, expect, it, vi } from 'vitest';
import { fetchCarbonContentByReference, fetchPageDataByReference } from '../src/json-extraction/fetch-json-page.js';

function jsonResponse(body: unknown, init: { ok?: boolean; status?: number } = {}) {
  return {
    ok: init.ok ?? true,
    status: init.status ?? 200,
    json: async () => body,
  } as Response;
}

describe('fetchPageDataByReference', () => {
  it('builds exactly one URL from collectionId/documentId, no slug guessing', async () => {
    const fetchImpl = vi.fn().mockResolvedValue(jsonResponse({ title: 'Buttons' }));
    const result = await fetchPageDataByReference(
      'https://m3.material.io',
      { collectionId: 'ComponentsM3', documentId: '5047690081337344' },
      undefined,
      fetchImpl as unknown as typeof fetch
    );
    expect(fetchImpl).toHaveBeenCalledTimes(1);
    expect(fetchImpl).toHaveBeenCalledWith('https://m3.material.io/page-data/ComponentsM3/5047690081337344.json', expect.anything());
    expect(result).toMatchObject({ status: 'ok', httpStatus: 200 });
  });

  it('handles numeric-looking documentId from site_meta without throwing', async () => {
    const fetchImpl = vi.fn().mockResolvedValue(jsonResponse({}, { ok: false, status: 404 }));
    const result = await fetchPageDataByReference(
      'https://m3.material.io',
      { collectionId: 'Homepage', documentId: '5909068158074880' },
      undefined,
      fetchImpl as unknown as typeof fetch
    );
    expect(result.status).toBe('http-error');
  });

  it('reports fetch-error on network failure without throwing', async () => {
    const fetchImpl = vi.fn().mockRejectedValue(new Error('network down'));
    const result = await fetchPageDataByReference(
      'https://m3.material.io',
      { collectionId: 'ComponentsM3', documentId: '123' },
      undefined,
      fetchImpl as unknown as typeof fetch
    );
    expect(result).toMatchObject({ status: 'fetch-error' });
  });
});

describe('fetchCarbonContentByReference', () => {
  it('builds the carbon content URL from carbonVersion + exportedCarbonFileId', async () => {
    const fetchImpl = vi.fn().mockResolvedValue(jsonResponse({ sections: [] }));
    const result = await fetchCarbonContentByReference(
      'https://m3.material.io',
      '2026-06-10_13-00-05',
      'e31df68a-59d4-41dc-8743-8c48b476d4f8.json',
      undefined,
      fetchImpl as unknown as typeof fetch
    );
    expect(fetchImpl).toHaveBeenCalledWith(
      'https://m3.material.io/_dsm/content/m3/2026-06-10_13-00-05/e31df68a-59d4-41dc-8743-8c48b476d4f8.json',
      expect.anything()
    );
    expect(result).toMatchObject({ status: 'ok' });
  });

  it('returns not-available when exportedCarbonFileId is missing, without fetching', async () => {
    const fetchImpl = vi.fn();
    const result = await fetchCarbonContentByReference(
      'https://m3.material.io',
      '2026-06-10_13-00-05',
      undefined,
      undefined,
      fetchImpl as unknown as typeof fetch
    );
    expect(result).toEqual({ status: 'not-available' });
    expect(fetchImpl).not.toHaveBeenCalled();
  });
});


describe('fetchPageDataByReference missing exact reference', () => {
  it('returns not-available without guessing or fetching', async () => {
    const fetchImpl = vi.fn();
    const result = await fetchPageDataByReference(
      'https://m3.material.io',
      {},
      undefined,
      fetchImpl as unknown as typeof fetch
    );
    expect(result).toEqual({ status: 'not-available' });
    expect(fetchImpl).not.toHaveBeenCalled();
  });
});
