import { extractPageDataMetadata } from './extract-page-data.js';
import { asObject, firstString, getPath, walkObjects } from './schemas.js';
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
  if (isContentPagePayload(url, payload)) return 'content-page';
  if (isPageDataPayload(payload)) return 'page-metadata';
  if (isDsdbResourcePayload(payload)) return 'dsdb-resource';
  const pathname = getUrlPathname(url);
  if (/TOKEN_TABLE\.[^/]+\.json$/i.test(pathname)) return 'token-table';
  if (/STATUS_TABLE/i.test(pathname)) return 'status-table';
  if (/\/_dsm\/content\/m3\/.+\.json$/i.test(pathname)) return 'content-page';
  if (/\/page-data\/.+\.json$/i.test(pathname)) return 'page-metadata';
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

function isContentPagePayload(url: string, payload: unknown): boolean {
  const root = asObject(payload);
  if (!root) return false;
  const title = firstString(payload, [['title'], ['name'], ['page', 'title'], ['content', 'title']]);
  const hasStructuredSections = hasArrayPath(payload, [
    ['sections'],
    ['content', 'sections'],
    ['page', 'sections'],
    ['data', 'sections']
  ]);
  const hasStructuredContent = hasContentStructure(root);
  const pathname = getUrlPathname(url);
  if (hasStructuredSections) return true;
  if (title && hasStructuredContent) return true;
  if (/\/_dsm\/content\/m3\/.+\.json$/i.test(pathname) && (hasStructuredContent || Boolean(title && hasPageIdentity(root)))) {
    return true;
  }
  return false;
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
  return typeof resourceLike.resourceName === 'string'
    || typeof resourceLike.resourcePath === 'string'
    || typeof resourceLike.libraryModuleType === 'string'
    || 'moduleConfigurationOverrides' in resourceLike
    || 'resource' in resourceLike
    || 'component' in resourceLike
    || 'tokenSets' in resourceLike;
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

function hasArrayPath(payload: unknown, paths: string[][]): boolean {
  return paths.some((path) => Array.isArray(getPath(payload, ...path)));
}

function hasContentStructure(root: unknown): boolean {
  const o = asObject(root);
  if (!o) return false;
  if (Array.isArray(o.contentBlocks) || Array.isArray(o.contentChunks)) return true;

  let found = false;
  walkObjects(root, (value) => {
    if (found) return;
    if (Array.isArray(value.contentBlocks) || Array.isArray(value.contentChunks) || Array.isArray(value.sections)) {
      found = true;
    }
  });
  return found;
}

function hasPageIdentity(root: unknown): boolean {
  const o = asObject(root);
  if (!o) return false;
  return typeof o.pageCanonId === 'string'
    || typeof o.pageCanonicalId === 'string'
    || typeof o.documentId === 'string'
    || typeof o.slug === 'string'
    || typeof o.pathname === 'string';
}
