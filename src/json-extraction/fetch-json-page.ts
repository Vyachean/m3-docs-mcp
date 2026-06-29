import { deriveCollectionSegmentFromSlug, fallbackPageCanonId, extractPageDataMetadata } from './extract-page-data.js';
import { classifyJsonResponse } from './classify-json-response.js';
import { createJsonPageBundle, type JsonPageBundle } from './json-bundle.js';
import type { JsonCapturedResponse } from './json-bundle.js';
import { createFetchDiagnostic, type FetchDiagnostic } from '../raw-artifacts/fetch-diagnostics.js';

export type JsonRouteDescriptor = {
  slug: string;
  documentId?: string;
  collectionId?: string;
  collectionName?: string;
  exportedCarbonFileId?: string;
  pageCanonId?: string;
};

type FetchLike = typeof fetch;

export async function fetchJsonPageBundle(
  baseUrl: string,
  carbonVersion: string,
  route: JsonRouteDescriptor,
  signal?: AbortSignal,
  fetchImpl: FetchLike = fetch,
  diagnostics: FetchDiagnostic[] = []
): Promise<JsonPageBundle> {
  const responses: JsonCapturedResponse[] = [];
  const sourceRoute = route.slug ? `/${route.slug.replace(/^\/+/, '')}` : null;
  const pageData = await fetchFirstJsonOrNull(
    buildPageDataCandidateUrls(baseUrl, route),
    signal,
    fetchImpl,
    responses,
    'page-data',
    sourceRoute,
    diagnostics
  );
  const metadata = extractPageDataMetadata(pageData);
  const pageCanonId = metadata.pageCanonId
    ?? fallbackPageCanonId(pageData)
    ?? route.pageCanonId
    ?? route.documentId
    ?? stripJsonExtension(route.exportedCarbonFileId)
    ?? null;
  const contentPage = await fetchFirstJsonOrNull(
    buildContentPageCandidateUrls(baseUrl, carbonVersion, [pageCanonId, route.documentId, stripJsonExtension(route.exportedCarbonFileId)]),
    signal,
    fetchImpl,
    responses,
    'carbon-content',
    sourceRoute,
    diagnostics
  );

  const fetchResource = createDsdbResourceFetcher(baseUrl, carbonVersion, responses, signal, fetchImpl, sourceRoute, diagnostics);

  return {
    ...createJsonPageBundle({ pageData, contentPage, pageCanonId, responses }),
    fetchResource
  };
}

/**
 * Builds a DSDB resource fetcher closure (token tables, status tables, component specs) bound to
 * a given carbonVersion. Shared by the legacy slug-guessing path and the dedicated
 * reference-based pipeline so both get the same enrichment behavior.
 */
export function createDsdbResourceFetcher(
  baseUrl: string,
  carbonVersion: string,
  responses: JsonCapturedResponse[] = [],
  signal?: AbortSignal,
  fetchImpl: FetchLike = fetch,
  sourceRoute: string | null = null,
  diagnostics: FetchDiagnostic[] = []
): (resourceName: string, resourceType?: string) => Promise<unknown | null> {
  return async (resourceName: string, resourceType?: string): Promise<unknown | null> => {
    const urls = buildDsdbResourceCandidateUrls(baseUrl, carbonVersion, resourceName, resourceType);
    return fetchFirstJsonOrNull(urls, signal, fetchImpl, responses, 'dsdb-resource', sourceRoute, diagnostics);
  };
}

export function buildPageDataCandidateUrls(baseUrl: string, route: JsonRouteDescriptor): string[] {
  const cleanedSlug = route.slug.replace(/^\/+|\/+$/g, '');
  const collectionSegment = route.collectionName ?? deriveCollectionSegmentFromSlug(cleanedSlug);
  const exportedId = stripJsonExtension(route.exportedCarbonFileId);
  const ids = [route.documentId, route.pageCanonId, exportedId].filter((value): value is string => Boolean(value));

  return unique([
    ...ids.flatMap((id) => collectionSegment ? [`${baseUrl}/page-data/${collectionSegment}/${id}.json`] : []),
    ...ids.flatMap((id) => route.collectionId ? [`${baseUrl}/page-data/${route.collectionId}/${id}.json`] : []),
    `${baseUrl}/page-data/${cleanedSlug}/page-data.json`
  ]);
}

function buildContentPageCandidateUrls(baseUrl: string, carbonVersion: string, ids: Array<string | undefined | null>): string[] {
  return unique(ids.filter((value): value is string => typeof value === 'string' && value.trim().length > 0)
    .map((id) => `${baseUrl}/_dsm/content/m3/${carbonVersion}/${id}.json`));
}

export function buildDsdbResourceCandidateUrls(
  baseUrl: string,
  carbonVersion: string,
  resourceName: string,
  resourceType?: string
): string[] {
  const normalized = resourceName.trim();
  const dsdbBase = `${baseUrl}/_dsm/data/dsdb-m3/${carbonVersion}`;
  const directPath = normalized.startsWith('/')
    ? `${baseUrl}${normalized}`
    : `${dsdbBase}/${normalized.replace(/^\/+/, '')}`;
  const lastSegment = normalized.split('/').filter(Boolean).at(-1) ?? '';
  const candidates = [
    normalized.startsWith('http://') || normalized.startsWith('https://') ? normalized : null,
    resourceType === 'TOKEN_TABLE' && lastSegment ? `${dsdbBase}/TOKEN_TABLE.${lastSegment}.json` : null,
    toGenericDsdbFilenameCandidate(dsdbBase, normalized),
    directPath
  ];
  return unique(candidates.filter((value): value is string => Boolean(value)));
}

function toGenericDsdbFilenameCandidate(dsdbBase: string, resourceName: string): string | null {
  const match = resourceName.match(/^designSystems\/([^/]+)\/components\/([^/]+)$/);
  if (!match) return null;
  const [, designSystemId, componentId] = match;
  return `${dsdbBase}/designSystems_${designSystemId}_components_${componentId}.json`;
}

async function fetchFirstJsonOrNull(
  urls: string[],
  signal: AbortSignal | undefined,
  fetchImpl: FetchLike,
  responses: JsonCapturedResponse[],
  expectedKind: FetchDiagnostic['expectedKind'] = 'network-capture',
  sourceRoute: string | null = null,
  diagnostics: FetchDiagnostic[] = []
): Promise<unknown | null> {
  for (let i = 0; i < urls.length; i += 1) {
    const url = urls[i]!;
    const isLastCandidate = i === urls.length - 1;
    const response = await fetchJsonOrNull(url, signal, fetchImpl, responses, expectedKind, sourceRoute, diagnostics, isLastCandidate);
    if (response) return response;
  }
  return null;
}

async function fetchJsonOrNull(
  url: string,
  signal: AbortSignal | undefined,
  fetchImpl: FetchLike,
  responses: JsonCapturedResponse[],
  expectedKind: FetchDiagnostic['expectedKind'],
  sourceRoute: string | null,
  diagnostics: FetchDiagnostic[],
  isLastCandidate: boolean
): Promise<unknown | null> {
  let response: Response;
  try {
    response = await fetchImpl(url, { signal });
  } catch (err) {
    diagnostics.push(createFetchDiagnostic({
      url,
      expectedKind,
      sourceRoute,
      outcome: 'network-error',
      networkError: err instanceof Error ? err.message : String(err),
      reason: 'rejected: candidate fetch threw a network error'
    }));
    return null;
  }
  if (!response.ok) {
    diagnostics.push(createFetchDiagnostic({
      url,
      expectedKind,
      sourceRoute,
      httpStatus: response.status,
      contentType: response.headers?.get?.('content-type') ?? null,
      outcome: 'http-error',
      reason: `rejected: candidate fetch returned HTTP ${response.status}`
    }));
    return null;
  }
  let payload: unknown;
  try {
    payload = await response.json() as unknown;
  } catch (err) {
    diagnostics.push(createFetchDiagnostic({
      url,
      expectedKind,
      sourceRoute,
      httpStatus: response.status,
      contentType: response.headers?.get?.('content-type') ?? null,
      outcome: 'parse-error',
      parseError: err instanceof Error ? err.message : String(err),
      reason: 'rejected: candidate response body failed JSON parsing'
    }));
    return null;
  }
  const classified = classifyJsonResponse({ url, payload });
  if (!responses.some((entry) => entry.url === classified.url && entry.type === classified.type && JSON.stringify(entry.payload) === JSON.stringify(classified.payload))) {
    responses.push(classified);
  }
  diagnostics.push(createFetchDiagnostic({
    url,
    expectedKind,
    sourceRoute,
    httpStatus: response.status,
    contentType: response.headers?.get?.('content-type') ?? null,
    outcome: 'success',
    reason: isLastCandidate ? 'accepted: candidate fetch returned a parsable JSON body' : 'accepted: candidate fetch returned a parsable JSON body (preferred over later, untried candidates)'
  }));
  return payload;
}

function stripJsonExtension(value: string | undefined): string | null {
  if (!value) return null;
  return value.replace(/\.json$/i, '');
}

function unique(values: Array<string | null | undefined>): string[] {
  return Array.from(new Set(values.filter((value): value is string => typeof value === 'string' && value.length > 0)));
}

// ── Dedicated reference-based fetchers (default pipeline; no slug-guessing, single URL each) ──

export type PageDataFetchResult =
  | { status: 'ok'; url: string; httpStatus: number; data: unknown }
  | { status: 'http-error'; url: string; httpStatus: number }
  | { status: 'fetch-error'; url: string; error: string };

/**
 * Fetches page-data for a route already resolved to {collectionId, documentId} (via
 * page-reference-resolver). Builds exactly one URL — no slug-only candidates, no fallback list.
 * Never report this as a slug-only / fallback fetch.
 */
export async function fetchPageDataByReference(
  baseUrl: string,
  reference: { collectionId: string; documentId: string },
  signal?: AbortSignal,
  fetchImpl: FetchLike = fetch,
  diagnostics: FetchDiagnostic[] = [],
  sourceRoute: string | null = null
): Promise<PageDataFetchResult> {
  const url = `${baseUrl}/page-data/${reference.collectionId}/${reference.documentId}.json`;
  let response: Response;
  try {
    response = await fetchImpl(url, { signal });
  } catch (err) {
    const networkError = err instanceof Error ? err.message : String(err);
    diagnostics.push(createFetchDiagnostic({
      url, expectedKind: 'page-data', sourceRoute, outcome: 'network-error', networkError,
      reason: 'rejected: dedicated reference-based page-data fetch threw a network error'
    }));
    return { status: 'fetch-error', url, error: networkError };
  }
  if (!response.ok) {
    diagnostics.push(createFetchDiagnostic({
      url, expectedKind: 'page-data', sourceRoute, httpStatus: response.status,
      contentType: response.headers?.get?.('content-type') ?? null, outcome: 'http-error',
      reason: `rejected: dedicated reference-based page-data fetch returned HTTP ${response.status}`
    }));
    return { status: 'http-error', url, httpStatus: response.status };
  }
  try {
    const data = (await response.json()) as unknown;
    diagnostics.push(createFetchDiagnostic({
      url, expectedKind: 'page-data', sourceRoute, httpStatus: response.status,
      contentType: response.headers?.get?.('content-type') ?? null, outcome: 'success',
      reason: 'accepted: dedicated reference-based page-data fetch (collectionId/documentId)'
    }));
    return { status: 'ok', url, httpStatus: response.status, data };
  } catch (err) {
    const parseError = err instanceof Error ? err.message : String(err);
    diagnostics.push(createFetchDiagnostic({
      url, expectedKind: 'page-data', sourceRoute, httpStatus: response.status,
      contentType: response.headers?.get?.('content-type') ?? null, outcome: 'parse-error', parseError,
      reason: 'rejected: dedicated reference-based page-data response failed JSON parsing'
    }));
    return { status: 'fetch-error', url, error: parseError };
  }
}

export type CarbonContentFetchResult =
  | { status: 'ok'; url: string; httpStatus: number; data: unknown }
  | { status: 'http-error'; url: string; httpStatus: number }
  | { status: 'fetch-error'; url: string; error: string }
  | { status: 'not-available' };

/** Fetches Carbon content JSON for a route with a known exportedCarbonFileId. Single URL, no guessing. */
export async function fetchCarbonContentByReference(
  baseUrl: string,
  carbonVersion: string,
  exportedCarbonFileId: string | undefined,
  signal?: AbortSignal,
  fetchImpl: FetchLike = fetch,
  diagnostics: FetchDiagnostic[] = [],
  sourceRoute: string | null = null
): Promise<CarbonContentFetchResult> {
  if (!exportedCarbonFileId) return { status: 'not-available' };
  const url = `${baseUrl}/_dsm/content/m3/${carbonVersion}/${exportedCarbonFileId}`;
  let response: Response;
  try {
    response = await fetchImpl(url, { signal });
  } catch (err) {
    const networkError = err instanceof Error ? err.message : String(err);
    diagnostics.push(createFetchDiagnostic({
      url, expectedKind: 'carbon-content', sourceRoute, outcome: 'network-error', networkError,
      reason: 'rejected: dedicated reference-based carbon-content fetch threw a network error'
    }));
    return { status: 'fetch-error', url, error: networkError };
  }
  if (!response.ok) {
    diagnostics.push(createFetchDiagnostic({
      url, expectedKind: 'carbon-content', sourceRoute, httpStatus: response.status,
      contentType: response.headers?.get?.('content-type') ?? null, outcome: 'http-error',
      reason: `rejected: dedicated reference-based carbon-content fetch returned HTTP ${response.status}`
    }));
    return { status: 'http-error', url, httpStatus: response.status };
  }
  try {
    const data = (await response.json()) as unknown;
    diagnostics.push(createFetchDiagnostic({
      url, expectedKind: 'carbon-content', sourceRoute, httpStatus: response.status,
      contentType: response.headers?.get?.('content-type') ?? null, outcome: 'success',
      reason: 'accepted: dedicated reference-based carbon-content fetch (exportedCarbonFileId)'
    }));
    return { status: 'ok', url, httpStatus: response.status, data };
  } catch (err) {
    const parseError = err instanceof Error ? err.message : String(err);
    diagnostics.push(createFetchDiagnostic({
      url, expectedKind: 'carbon-content', sourceRoute, httpStatus: response.status,
      contentType: response.headers?.get?.('content-type') ?? null, outcome: 'parse-error', parseError,
      reason: 'rejected: dedicated reference-based carbon-content response failed JSON parsing'
    }));
    return { status: 'fetch-error', url, error: parseError };
  }
}
