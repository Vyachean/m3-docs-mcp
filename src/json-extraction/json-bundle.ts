import path from 'node:path';
import { mkdir, writeFile } from 'node:fs/promises';
import type { JsonResponseType } from '../types.js';

export type JsonCapturedResponse = {
  url: string;
  type: JsonResponseType;
  payload: unknown;
  resourceName?: string;
};

export type JsonPageBundle = {
  pageData: unknown | null;
  contentPage: unknown | null;
  pageCanonId: string | null;
  responses: JsonCapturedResponse[];
  fetchResource: (resourceName: string, resourceType?: string) => Promise<unknown | null>;
};

export function createJsonPageBundle({
  pageData,
  contentPage,
  pageCanonId,
  responses
}: {
  pageData: unknown | null;
  contentPage: unknown | null;
  pageCanonId: string | null;
  responses?: JsonCapturedResponse[];
}): JsonPageBundle {
  const normalizedResponses = responses ?? [];
  return {
    pageData,
    contentPage,
    pageCanonId,
    responses: normalizedResponses,
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
    await writeFile(path.join(rawDir, fileName), `${JSON.stringify({
      url: response.url,
      type: response.type,
      payload: response.payload
    }, null, 2)}\n`, 'utf8');
    written += 1;
  }
  return written;
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
