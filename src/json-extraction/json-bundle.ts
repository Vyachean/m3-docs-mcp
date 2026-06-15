import path from 'node:path';
import crypto from 'node:crypto';
import { mkdir, writeFile } from 'node:fs/promises';
import type { JsonResponseType } from '../types.js';
import { extractPageDataMetadata } from './extract-page-data.js';
import { firstString } from './schemas.js';

export type JsonCapturedResponse = {
  url: string;
  type: JsonResponseType;
  payload: unknown;
  resourceName?: string;
};

export type JsonSelectionContext = {
  requestedUrl?: string;
  finalUrl?: string;
  title?: string | null;
  slug?: string | null;
  documentId?: string | null;
  pageCanonId?: string | null;
  exportedCarbonFileId?: string | null;
  routeMetadata?: {
    slug?: string | null;
    documentId?: string | null;
    pageCanonId?: string | null;
    exportedCarbonFileId?: string | null;
  };
};

export type JsonPageBundle = {
  pageData: unknown | null;
  contentPage: unknown | null;
  pageCanonId: string | null;
  responses: JsonCapturedResponse[];
  fetchResource: (resourceName: string, resourceType?: string) => Promise<unknown | null>;
  selectionReasons: string[];
};

export function createJsonPageBundle({
  pageData,
  contentPage,
  pageCanonId,
  responses,
  selectionReasons
}: {
  pageData: unknown | null;
  contentPage: unknown | null;
  pageCanonId: string | null;
  responses?: JsonCapturedResponse[];
  selectionReasons?: string[];
}): JsonPageBundle {
  const normalizedResponses = responses ?? [];
  return {
    pageData,
    contentPage,
    pageCanonId,
    responses: normalizedResponses,
    selectionReasons: selectionReasons ?? [],
    fetchResource: async (resourceName: string, resourceType?: string) => {
      const matched = findCapturedResource(normalizedResponses, resourceName, resourceType);
      return matched?.payload ?? null;
    }
  };
}

export function countCapturedResponseTypes(responses: JsonCapturedResponse[]): Partial<Record<JsonResponseType, number>> {
  const counts: Partial<Record<JsonResponseType, number>> = {};
  for (const response of responses) {
    counts[response.type] = (counts[response.type] ?? 0) + 1;
  }
  return counts;
}

export async function writeRawJsonDebugFiles(
  cacheDir: string,
  pagePath: string,
  responses: JsonCapturedResponse[]
): Promise<number> {
  if (responses.length === 0) return 0;
  const rawDir = path.join(cacheDir, 'raw', pagePath.replace(/\.md$/i, ''));
  await mkdir(rawDir, { recursive: true });

  let written = 0;
  const perTypeCounts = new Map<string, number>();
  for (const response of responses) {
    const fileName = debugFileName(response, perTypeCounts);
    await writeFile(path.join(rawDir, fileName), `${JSON.stringify(sanitizeDebugResponse(response), null, 2)}\n`, 'utf8');
    written += 1;
  }
  return written;
}

export function buildJsonPageBundleFromResponses(
  responses: JsonCapturedResponse[],
  context?: JsonSelectionContext
): JsonPageBundle {
  const selectionReasons: string[] = [];
  const pageDataCandidate = selectBestCapturedResponse(responses, 'page-metadata', context, selectionReasons);
  const contentPageCandidate = selectBestCapturedResponse(responses, 'content-page', context, selectionReasons);
  const pageData = pageDataCandidate?.payload ?? null;
  const contentPage = contentPageCandidate?.payload ?? null;
  const pageCanonId = extractPageDataMetadata(pageData).pageCanonId
    ?? firstString(contentPage, [['pageCanonId'], ['pageCanonicalId'], ['documentId'], ['metadata', 'pageCanonId']])
    ?? context?.pageCanonId
    ?? context?.routeMetadata?.pageCanonId
    ?? context?.documentId
    ?? context?.routeMetadata?.documentId
    ?? null;

  return createJsonPageBundle({ pageData, contentPage, pageCanonId, responses, selectionReasons });
}

function debugFileName(response: JsonCapturedResponse, perTypeCounts: Map<string, number>): string {
  const typeLabel = response.type === 'page-metadata'
    ? 'page-data'
    : response.type === 'content-page'
      ? 'content'
      : response.type;
  const count = (perTypeCounts.get(typeLabel) ?? 0) + 1;
  perTypeCounts.set(typeLabel, count);
  const suffix = count > 1 ? `.${count}` : '';
  const resourceTail = response.resourceName
    ? `.${sanitizePathSegment(response.resourceName.split('/').filter(Boolean).at(-1) ?? 'resource')}`
    : '';
  return `${sanitizePathSegment(typeLabel)}${resourceTail}${suffix}.json`;
}

function sanitizeDebugResponse(response: JsonCapturedResponse): Record<string, unknown> {
  const normalizedPath = safePathname(response.url);
  return {
    url: response.url,
    normalizedPath,
    type: response.type,
    resourceName: response.resourceName ?? null,
    stableId: crypto.createHash('sha1').update(`${response.type}|${normalizedPath}|${response.resourceName ?? ''}`).digest('hex').slice(0, 12),
    payload: response.payload
  };
}

function selectBestCapturedResponse(
  responses: JsonCapturedResponse[],
  type: JsonResponseType,
  context: JsonSelectionContext | undefined,
  selectionReasons: string[]
): JsonCapturedResponse | null {
  const candidates = responses.filter((response) => response.type === type);
  if (candidates.length === 0) return null;

  const scored = candidates
    .map((response) => ({ response, score: scoreCapturedResponse(response, context) }))
    .sort((a, b) => b.score - a.score);

  const selected = scored[0]!;
  if (candidates.length > 1) {
    selectionReasons.push(`${type}:selected=${safePathname(selected.response.url)} score=${selected.score} candidates=${scored.map((entry) => `${safePathname(entry.response.url)}:${entry.score}`).join(',')}`);
  }
  return selected.response;
}

function scoreCapturedResponse(response: JsonCapturedResponse, context?: JsonSelectionContext): number {
  const pathname = safePathname(response.url);
  const routePaths = collectRoutePaths(context);
  const routeTokens = collectRouteTokens(context);
  let score = basePayloadQualityScore(response);

  if (routePaths.some((routePath) => pathname.includes(routePath))) score += 8;
  if (routeTokens.some((token) => pathname.includes(token))) score += 3;

  const pageDataMeta = extractPageDataMetadata(response.payload);
  const payloadTitle = firstString(response.payload, [['title'], ['name'], ['page', 'title'], ['content', 'title']]);
  const payloadPath = normalizeRoutePath(pageDataMeta.pathname);
  const payloadCanon = pageDataMeta.pageCanonId ?? firstString(response.payload, [['pageCanonId'], ['pageCanonicalId'], ['documentId']]);

  if (payloadPath && routePaths.includes(payloadPath)) score += 10;
  if (payloadCanon && routeTokens.includes(payloadCanon)) score += 8;
  const normalizedPayloadTitle = normalizeToken(payloadTitle);
  if (normalizedPayloadTitle && routeTokens.includes(normalizedPayloadTitle)) score += 2;

  if (response.type === 'content-page' && pathname.includes('/_dsm/content/m3/')) score += 1;
  if (response.type === 'page-metadata' && pathname.includes('/page-data/')) score += 1;
  return score;
}

function basePayloadQualityScore(response: JsonCapturedResponse): number {
  const payloadTitle = firstString(response.payload, [['title'], ['name'], ['page', 'title'], ['content', 'title']]);
  const pageMeta = extractPageDataMetadata(response.payload);
  let score = 0;
  if (payloadTitle) score += 2;
  if (pageMeta.title) score += 2;
  if (pageMeta.pathname) score += 2;
  if (pageMeta.pageCanonId) score += 2;
  if (Array.isArray((response.payload as { sections?: unknown })?.sections)) score += 3;
  return score;
}

function collectRoutePaths(context?: JsonSelectionContext): string[] {
  return uniqueStrings([
    normalizeRoutePath(context?.requestedUrl),
    normalizeRoutePath(context?.finalUrl),
    normalizeRoutePath(context?.slug),
    normalizeRoutePath(context?.routeMetadata?.slug)
  ]);
}

function collectRouteTokens(context?: JsonSelectionContext): string[] {
  return uniqueStrings([
    normalizeToken(context?.title),
    normalizeToken(context?.slug),
    normalizeToken(context?.documentId),
    normalizeToken(context?.pageCanonId),
    normalizeToken(context?.exportedCarbonFileId),
    normalizeToken(context?.routeMetadata?.slug),
    normalizeToken(context?.routeMetadata?.documentId),
    normalizeToken(context?.routeMetadata?.pageCanonId),
    normalizeToken(context?.routeMetadata?.exportedCarbonFileId)
  ]);
}

function normalizeRoutePath(value: string | null | undefined): string | null {
  if (!value) return null;
  try {
    const normalized = new URL(value, 'https://m3.material.io').pathname.replace(/^\/+|\/+$/g, '');
    return normalized || null;
  } catch {
    return value.replace(/^\/+|\/+$/g, '') || null;
  }
}

function normalizeToken(value: string | null | undefined): string | null {
  if (!value) return null;
  return value.replace(/\.json$/i, '').trim().toLowerCase() || null;
}

function safePathname(url: string): string {
  try {
    return new URL(url).pathname;
  } catch {
    return url;
  }
}

function uniqueStrings(values: Array<string | null | undefined>): string[] {
  return Array.from(new Set(values.filter((value): value is string => typeof value === 'string' && value.length > 0)));
}

function findCapturedResource(
  responses: JsonCapturedResponse[],
  resourceName: string,
  resourceType?: string
): JsonCapturedResponse | null {
  const normalizedName = resourceName.trim();
  const trailingId = normalizedName.split('/').filter(Boolean).at(-1) ?? normalizedName;

  const directMatch = responses.find((response) => {
    if (resourceType && !matchesResourceType(response.type, resourceType)) return false;
    return response.resourceName === normalizedName;
  });
  if (directMatch) return directMatch;

  const aliasMatch = responses.find((response) => {
    if (resourceType && !matchesResourceType(response.type, resourceType)) return false;
    if (!response.resourceName) return false;
    return response.resourceName === trailingId
      || response.resourceName.endsWith(`/${trailingId}`)
      || response.resourceName.includes(trailingId);
  });
  if (aliasMatch) return aliasMatch;

  if (resourceType === 'TOKEN_TABLE') {
    return responses.find((response) => response.type === 'token-table' && response.url.includes(`TOKEN_TABLE.${trailingId}.json`)) ?? null;
  }

  if (resourceType === 'STATUS_TABLE') {
    return responses.find((response) => response.type === 'status-table' && response.url.includes(trailingId)) ?? null;
  }

  return null;
}

function matchesResourceType(type: JsonResponseType, resourceType: string): boolean {
  if (resourceType === 'TOKEN_TABLE') return type === 'token-table';
  if (resourceType === 'STATUS_TABLE') return type === 'status-table';
  return type === 'dsdb-resource' || type === 'unknown-json-resource';
}

function sanitizePathSegment(value: string): string {
  return value.replace(/[^a-z0-9._-]+/gi, '-').replace(/^-+|-+$/g, '') || 'resource';
}
