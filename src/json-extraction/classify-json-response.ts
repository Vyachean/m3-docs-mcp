import { extractPageDataMetadata } from './extract-page-data.js';
import type { JsonCapturedResponse } from './json-bundle.js';
import type { JsonResponseType } from '../types.js';

// ── Local helpers (type-predicate approach, no 'as' casts) ───────────────────

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

function getLocal(root: unknown, ...path: string[]): unknown {
  let current: unknown = root;
  for (const key of path) {
    if (!isRecord(current)) return undefined;
    current = current[key];
  }
  return current;
}

function firstStringLocal(root: unknown, paths: string[][]): string | null {
  for (const path of paths) {
    const v = getLocal(root, ...path);
    if (typeof v === 'string' && v.trim()) return v;
  }
  return null;
}

function walkObjectsLocal(root: unknown, visitor: (value: Record<string, unknown>) => void): void {
  const seen = new Set<unknown>();
  const visit = (value: unknown): void => {
    if (!value || typeof value !== 'object' || seen.has(value)) return;
    seen.add(value);
    if (Array.isArray(value)) {
      for (const item of value) visit(item);
      return;
    }
    if (isRecord(value)) {
      visitor(value);
      for (const nested of Object.values(value)) visit(nested);
    }
  };
  visit(root);
}

// ── Public API ────────────────────────────────────────────────────────────────

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
  const direct = firstStringLocal(payload, [
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
  if (!isRecord(payload)) return false;
  const title = firstStringLocal(payload, [['title'], ['name'], ['page', 'title'], ['content', 'title']]);
  const hasStructuredSections = hasArrayPath(payload, [
    ['sections'],
    ['content', 'sections'],
    ['page', 'sections'],
    ['data', 'sections']
  ]);
  const hasStructuredContent = hasContentStructure(payload);
  const pathname = getUrlPathname(url);
  if (hasStructuredSections) return true;
  if (title && hasStructuredContent) return true;
  if (/\/_dsm\/content\/m3\/.+\.json$/i.test(pathname) && (hasStructuredContent || Boolean(title && hasPageIdentity(payload)))) {
    return true;
  }
  return false;
}

function isTokenTablePayload(payload: unknown): boolean {
  const system = getLocal(payload, 'system');
  return isRecord(system) && Array.isArray(system.tokenSets);
}

function isStatusTablePayload(payload: unknown): boolean {
  const states = getLocal(payload, 'states');
  const rows = getLocal(payload, 'rows');
  return Array.isArray(states) || Array.isArray(rows);
}

function isDsdbResourcePayload(payload: unknown): boolean {
  if (!isRecord(payload)) return false;
  return typeof payload.resourceName === 'string'
    || typeof payload.resourcePath === 'string'
    || typeof payload.libraryModuleType === 'string'
    || 'moduleConfigurationOverrides' in payload
    || 'resource' in payload
    || 'component' in payload
    || 'tokenSets' in payload;
}

function inferResourceNameFromPayload(payload: unknown): string | null {
  let discovered: string | null = null;
  walkObjectsLocal(payload, (value) => {
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
  return paths.some((path) => Array.isArray(getLocal(payload, ...path)));
}

function hasContentStructure(root: unknown): boolean {
  if (!isRecord(root)) return false;
  if (Array.isArray(root.contentBlocks) || Array.isArray(root.contentChunks)) return true;

  let found = false;
  walkObjectsLocal(root, (value) => {
    if (found) return;
    if (Array.isArray(value.contentBlocks) || Array.isArray(value.contentChunks) || Array.isArray(value.sections)) {
      found = true;
    }
  });
  return found;
}

function hasPageIdentity(root: unknown): boolean {
  if (!isRecord(root)) return false;
  return typeof root.pageCanonId === 'string'
    || typeof root.pageCanonicalId === 'string'
    || typeof root.documentId === 'string'
    || typeof root.slug === 'string'
    || typeof root.pathname === 'string';
}
