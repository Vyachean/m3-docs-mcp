import { fallbackPageCanonId, extractPageDataMetadata } from './extract-page-data.js';

export type JsonRouteDescriptor = {
  slug: string;
  documentId?: string;
};

export type JsonPageBundle = {
  pageData: unknown | null;
  contentPage: unknown | null;
  pageCanonId: string | null;
  fetchResource: (resourceName: string) => Promise<unknown | null>;
};

type FetchLike = typeof fetch;

export async function fetchJsonPageBundle(
  baseUrl: string,
  carbonVersion: string,
  route: JsonRouteDescriptor,
  signal?: AbortSignal,
  fetchImpl: FetchLike = fetch
): Promise<JsonPageBundle> {
  const pageData = await fetchJsonOrNull(buildPageDataUrl(baseUrl, route.slug), signal, fetchImpl);
  const metadata = extractPageDataMetadata(pageData);
  const pageCanonId = metadata.pageCanonId ?? fallbackPageCanonId(pageData) ?? route.documentId ?? null;
  const contentPage = pageCanonId
    ? await fetchJsonOrNull(`${baseUrl}/_dsm/content/m3/${carbonVersion}/${pageCanonId}.json`, signal, fetchImpl)
    : null;

  const fetchResource = async (resourceName: string): Promise<unknown | null> => {
    const normalizedName = resourceName.startsWith('http')
      ? resourceName
      : `${baseUrl}/_dsm/data/dsdb-m3/${carbonVersion}/${resourceName.replace(/^\/+/, '')}`;
    return fetchJsonOrNull(normalizedName, signal, fetchImpl);
  };

  return { pageData, contentPage, pageCanonId, fetchResource };
}

function buildPageDataUrl(baseUrl: string, slug: string): string {
  const cleaned = slug.replace(/^\/+|\/+$/g, '');
  return `${baseUrl}/page-data/${cleaned}/page-data.json`;
}

async function fetchJsonOrNull(url: string, signal: AbortSignal | undefined, fetchImpl: FetchLike): Promise<unknown | null> {
  try {
    const response = await fetchImpl(url, { signal });
    if (!response.ok) return null;
    return await response.json();
  } catch {
    return null;
  }
}
