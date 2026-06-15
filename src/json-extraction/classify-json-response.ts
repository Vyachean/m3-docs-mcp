import { extractPageDataMetadata } from './extract-page-data.js';
import { asObject, firstArray, firstString, getPath, walkObjects } from './schemas.js';
import type { JsonCapturedResponse } from './json-bundle.js';
import type { JsonResponseType } from '../types.js';

export function classifyJsonResponse({
  url,
  payload
}: {
  url: string;
  payload: unknown;
}): JsonCapturedResponse {
  const type = classifyResponseType(url, payload);
  return {
    url,
    type,
    payload,
    ...(deriveResourceName(url, payload, type) ? { resourceName: deriveResourceName(url, payload, type)! } : {})
  };
}

export function classifyResponseType(url: string, payload: unknown): JsonResponseType {
  if (isTokenTablePayload(payload)) return 'token-table';
  if (isStatusTablePayload(payload)) return 'status-table';
  if (isDsdbResourcePayload(payload)) return 'dsdb-resource';
  if (isContentPagePayload(payload)) return 'content-page';
  if (isPageDataPayload(payload)) return 'page-metadata';
  const pathname = getUrlPathname(url);
  if (/TOKEN_TABLE\.[^/]+\.json$/i.test(pathname)) return 'token-table';
  if (/STATUS_TABLE/i.test(pathname)) return 'status-table';
  if (/\/page-data\/.+\.json$/i.test(pathname)) return 'page-metadata';
  if (/\/_dsm\/content\/m3\/.+\.json$/i.test(pathname)) return 'content-page';
  if (/\/_dsm\/data\/dsdb-m3\/.+\.json$/i.test(pathname)) return 'dsdb-resource';
  return 'unknown-json-resource';
}

function deriveResourceName(url: string, payload: unknown, type: JsonResponseType): string | null {
  if (type === 'page-metadata' || type === 'content-page') return null;
  const direct = firstString(payload, [
    ['resourceName'],
    ['name'],
    ['id'],
    ['resource', 'name'],
    ['metadata', 'resourceName']
  ]);
  if (direct) return direct;

  if (type === 'token-table') {
    return getUrlPathname(url).match(/TOKEN_TABLE\.([^/.]+)\.json$/i)?.[1] ?? lastUrlSegment(url);
  }

  if (type === 'status-table') {
    return lastUrlSegment(url);
  }

  const discoveredResourceName = inferResourceNameFromPayload(payload);
  if (discoveredResourceName) return discoveredResourceName;

  return lastUrlSegment(url);
}

function isPageDataPayload(payload: unknown): boolean {
  const meta = extractPageDataMetadata(payload);
  return Boolean(meta.pageCanonId || meta.pathname || meta.title);
}

function isContentPagePayload(payload: unknown): boolean {
  const title = firstString(payload, [['title'], ['name'], ['page', 'title'], ['content', 'title']]);
  return firstArray(payload, [
    ['sections'],
    ['content', 'sections'],
    ['page', 'sections'],
    ['data', 'sections']
  ]).length > 0 || Boolean(title);
}

function isTokenTablePayload(payload: unknown): boolean {
  const system = getPath(payload, 'system');
  return typeof system === 'object' && system !== null && Array.isArray((system as { tokenSets?: unknown }).tokenSets);
}

function isStatusTablePayload(payload: unknown): boolean {
  const states = getPath(payload, 'states');
  const rows = getPath(payload, 'rows');
  return Array.isArray(states) || Array.isArray(rows);
}

function isDsdbResourcePayload(payload: unknown): boolean {
  const resourceLike = asObject(payload);
  if (!resourceLike) return false;
  if (typeof resourceLike.resourceName === 'string') return true;
  if (typeof resourceLike.libraryModuleType === 'string') return true;
  return walkHasResourceMarkers(payload);
}

function walkHasResourceMarkers(payload: unknown): boolean {
  let found = false;
  walkObjects(payload, (value) => {
    if (found) return;
    if (typeof value.resourceName === 'string' || typeof value.resourcePath === 'string' || typeof value.libraryModuleType === 'string') {
      found = true;
    }
  });
  return found;
}

function inferResourceNameFromPayload(payload: unknown): string | null {
  let discovered: string | null = null;
  walkObjects(payload, (value) => {
    if (discovered) return;
    for (const key of ['resourceName', 'resourcePath', 'resourceUrl']) {
      const candidate = value[key];
      if (typeof candidate === 'string' && candidate.trim()) {
        discovered = candidate;
        return;
      }
    }
  });
  return discovered;
}

function getUrlPathname(url: string): string {
  try {
    return new URL(url).pathname;
  } catch {
    return url;
  }
}

function lastUrlSegment(url: string): string {
  const pathname = getUrlPathname(url);
  return pathname.split('/').filter(Boolean).at(-1) ?? pathname;
}
