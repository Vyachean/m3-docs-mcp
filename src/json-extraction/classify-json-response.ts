import { extractPageDataMetadata } from './extract-page-data.js';
import { firstArray, firstString, getPath } from './schemas.js';
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
  if (/\/page-data\/.+\.json$/i.test(url)) return 'page-metadata';
  if (/\/_dsm\/content\/m3\/.+\.json$/i.test(url)) return 'content-page';
  if (/TOKEN_TABLE\.[^/]+\.json$/i.test(url)) return 'token-table';
  if (/STATUS_TABLE/i.test(url)) return 'status-table';
  if (isTokenTablePayload(payload)) return 'token-table';
  if (isStatusTablePayload(payload)) return 'status-table';
  if (isContentPagePayload(payload)) return 'content-page';
  if (isPageDataPayload(payload)) return 'page-metadata';
  if (/\/_dsm\/data\/dsdb-m3\/.+\.json$/i.test(url)) return 'dsdb-resource';
  return 'unknown-json-resource';
}

function deriveResourceName(url: string, payload: unknown, type: JsonResponseType): string | null {
  if (type === 'page-metadata' || type === 'content-page') return null;
  const direct = firstString(payload, [
    ['resourceName'],
    ['name'],
    ['id']
  ]);
  if (direct) return direct;

  if (type === 'token-table') {
    return url.match(/TOKEN_TABLE\.([^/.]+)\.json$/i)?.[1] ?? lastUrlSegment(url);
  }

  if (type === 'status-table') {
    return lastUrlSegment(url);
  }

  return lastUrlSegment(url);
}

function isPageDataPayload(payload: unknown): boolean {
  const meta = extractPageDataMetadata(payload);
  return Boolean(meta.pageCanonId || meta.pathname || meta.title);
}

function isContentPagePayload(payload: unknown): boolean {
  return firstArray(payload, [
    ['sections'],
    ['content', 'sections'],
    ['page', 'sections'],
    ['data', 'sections']
  ]).length > 0 || Boolean(firstString(payload, [['title'], ['name']]));
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

function lastUrlSegment(url: string): string {
  const pathname = new URL(url).pathname;
  return pathname.split('/').filter(Boolean).at(-1) ?? pathname;
}
