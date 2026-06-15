import type { ExtractionPageDiagnostic } from '../types.js';
import { compactJson, getPath, readString, walkObjects } from './schemas.js';
import { renderResourcePlaceholder, tokenTableToMarkdown, type TokenTableSystem } from './render-markdown.js';

export type DsdbResourceFetcher = (resourceName: string) => Promise<unknown | null>;

export function extractRequestedTokenSets(resourceChunk: Record<string, unknown>): string[] {
  const values = [
    getPath(resourceChunk, 'moduleConfigurationOverrides', 'tokenSets'),
    getPath(resourceChunk, 'moduleConfiguration', 'tokenSets'),
    getPath(resourceChunk, 'tokenSets')
  ];
  for (const value of values) {
    if (Array.isArray(value)) {
      const tokenSets = value.filter((entry): entry is string => typeof entry === 'string' && entry.trim().length > 0);
      if (tokenSets.length > 0) return tokenSets;
    }
  }
  return [];
}

export function extractResourceName(resourceChunk: Record<string, unknown>): string | null {
  const direct = [
    readString(resourceChunk.resourceName),
    readString(resourceChunk.resourcePath),
    readString(resourceChunk.resourceUrl),
    readString(getPath(resourceChunk, 'moduleConfigurationOverrides', 'resourceName')),
    readString(getPath(resourceChunk, 'moduleConfiguration', 'resourceName'))
  ].find(Boolean);
  if (direct) return direct;

  let discovered: string | null = null;
  walkObjects(resourceChunk, (value) => {
    if (discovered) return;
    for (const candidate of Object.values(value)) {
      if (typeof candidate === 'string' && candidate.includes('TOKEN_TABLE')) {
        discovered = candidate;
        return;
      }
    }
  });
  return discovered;
}

export async function renderDsdbResourceChunk(
  resourceChunk: Record<string, unknown>,
  fetchResource: DsdbResourceFetcher,
  pageDiagnostic: ExtractionPageDiagnostic
): Promise<string> {
  const libraryModuleType = readString(resourceChunk.libraryModuleType)
    ?? readString(resourceChunk.moduleType)
    ?? readString(resourceChunk.resourceType)
    ?? 'UNKNOWN_RESOURCE';

  if (libraryModuleType !== 'TOKEN_TABLE') {
    if (libraryModuleType !== 'UNKNOWN_RESOURCE') pageDiagnostic.unknownResourceTypes.push(libraryModuleType);
    pageDiagnostic.unresolvedResourceCount += 1;
    return renderResourcePlaceholder(libraryModuleType, {
      type: libraryModuleType,
      resource: extractResourceName(resourceChunk),
      chunk: compactJson(resourceChunk).slice(0, 280)
    });
  }

  pageDiagnostic.tokenTables += 1;
  const requestedTokenSets = extractRequestedTokenSets(resourceChunk);
  const resourceName = extractResourceName(resourceChunk);
  if (!resourceName) {
    pageDiagnostic.missingRequestedTokenSets.push(...requestedTokenSets);
    pageDiagnostic.unresolvedResourceCount += 1;
    return renderResourcePlaceholder('TOKEN_TABLE', { reason: 'missing-resource-name', tokenSets: requestedTokenSets });
  }

  const resource = await fetchResource(resourceName);
  const system = extractTokenTableSystem(resource);
  if (!system) {
    pageDiagnostic.missingRequestedTokenSets.push(...requestedTokenSets);
    pageDiagnostic.unresolvedResourceCount += 1;
    return renderResourcePlaceholder('TOKEN_TABLE', { reason: 'missing-token-system', resource: resourceName, tokenSets: requestedTokenSets });
  }

  const rendered = tokenTableToMarkdown(system, requestedTokenSets);
  if (!rendered.trim()) {
    pageDiagnostic.missingRequestedTokenSets.push(...requestedTokenSets);
    pageDiagnostic.unresolvedResourceCount += 1;
    return renderResourcePlaceholder('TOKEN_TABLE', { reason: 'missing-requested-token-sets', resource: resourceName, tokenSets: requestedTokenSets });
  }

  pageDiagnostic.tokenTablesRendered += 1;
  return rendered.replace(/^\n*## Design Tokens\n\n/, '');
}

function extractTokenTableSystem(resource: unknown): TokenTableSystem | null {
  const direct = getPath(resource, 'system');
  if (direct && typeof direct === 'object') return direct as TokenTableSystem;
  const nested = getPath(resource, 'payload', 'system');
  if (nested && typeof nested === 'object') return nested as TokenTableSystem;
  return null;
}
