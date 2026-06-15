import { deriveCollectionSegmentFromSlug, fallbackPageCanonId, extractPageDataMetadata } from './extract-page-data.js';
import { classifyJsonResponse } from './classify-json-response.js';
import { createJsonPageBundle, type JsonPageBundle } from './json-bundle.js';
import type { JsonCapturedResponse } from './json-bundle.js';

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
  fetchImpl: FetchLike = fetch
): Promise<JsonPageBundle> {
  const responses: JsonCapturedResponse[] = [];
  const pageData = await fetchFirstJsonOrNull(buildPageDataCandidateUrls(baseUrl, route), signal, fetchImpl, responses);
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
    responses
  );

  const fetchResource = async (resourceName: string, resourceType?: string): Promise<unknown | null> => {
    const urls = buildDsdbResourceCandidateUrls(baseUrl, carbonVersion, resourceName, resourceType);
    return fetchFirstJsonOrNull(urls, signal, fetchImpl, responses);
  };

  return {
    ...createJsonPageBundle({ pageData, contentPage, pageCanonId, responses }),
    fetchResource
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
  responses: JsonCapturedResponse[]
): Promise<unknown | null> {
  for (const url of urls) {
    const response = await fetchJsonOrNull(url, signal, fetchImpl, responses);
    if (response) return response;
  }
  return null;
}

async function fetchJsonOrNull(
  url: string,
  signal: AbortSignal | undefined,
  fetchImpl: FetchLike,
  responses: JsonCapturedResponse[]
): Promise<unknown | null> {
  try {
    const response = await fetchImpl(url, { signal });
    if (!response.ok) return null;
    const payload = await response.json();
    const classified = classifyJsonResponse({ url, payload });
    if (!responses.some((entry) => entry.url === classified.url && entry.type === classified.type && JSON.stringify(entry.payload) === JSON.stringify(classified.payload))) {
      responses.push(classified);
    }
    return payload;
  } catch {
    return null;
  }
}

function stripJsonExtension(value: string | undefined): string | null {
  if (!value) return null;
  return value.replace(/\.json$/i, '');
}

function unique(values: Array<string | null | undefined>): string[] {
  return Array.from(new Set(values.filter((value): value is string => typeof value === 'string' && value.length > 0)));
}
