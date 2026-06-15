import type { ExtractionPageDiagnostic } from '../types.js';
import { compactJson, getPath, readString, walkObjects } from './schemas.js';
import { normalizeTokenTableSystem, renderResourcePlaceholder, renderStatusTableMarkdown, renderTokenTableWithDiagnostics, type TokenTableSystem } from './render-markdown.js';

export type DsdbResourceFetcher = (resourceName: string, resourceType?: string) => Promise<unknown | null>;

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

  if (libraryModuleType === 'STATUS_TABLE') {
    const resourceName = extractResourceName(resourceChunk);
    pageDiagnostic.statusTablesRequested = (pageDiagnostic.statusTablesRequested ?? 0) + 1;
    const resource = resourceName ? await fetchResource(resourceName, libraryModuleType) : null;
    const rendered = renderStatusTableMarkdown(resource);
    const statusTableDiagnostics = pageDiagnostic.statusTableDiagnostics ?? (pageDiagnostic.statusTableDiagnostics = []);
    if (rendered) {
      pageDiagnostic.statusTablesResolved = (pageDiagnostic.statusTablesResolved ?? 0) + 1;
      statusTableDiagnostics.push({
        resourceName,
        requested: true,
        resolved: Boolean(resource),
        rendered: true,
        renderedAsPlaceholder: false,
        unsupportedSchema: false
      });
      return rendered;
    }

    const unsupportedSchema = Boolean(resource);
    pageDiagnostic.statusTablesRenderedAsPlaceholder = (pageDiagnostic.statusTablesRenderedAsPlaceholder ?? 0) + 1;
    if (unsupportedSchema) pageDiagnostic.unsupportedStatusTableSchemaCount = (pageDiagnostic.unsupportedStatusTableSchemaCount ?? 0) + 1;
    statusTableDiagnostics.push({
      resourceName,
      requested: true,
      resolved: Boolean(resource),
      rendered: false,
      renderedAsPlaceholder: true,
      unsupportedSchema
    });
    pageDiagnostic.unknownResourceTypes.push(libraryModuleType);
    pageDiagnostic.unresolvedResourceCount += 1;
    return renderResourcePlaceholder('STATUS_TABLE', {
      reason: resource ? 'unknown-status-table-schema' : 'missing-status-table-resource',
      resource: resourceName,
      chunk: compactJson(resourceChunk).slice(0, 280)
    });
  }

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

  const resource = await fetchResource(resourceName, libraryModuleType);
  const system = extractTokenTableSystem(resource);
  if (!system) {
    pageDiagnostic.missingRequestedTokenSets.push(...requestedTokenSets);
    pageDiagnostic.unresolvedResourceCount += 1;
    return renderResourcePlaceholder('TOKEN_TABLE', { reason: 'missing-token-system', resource: resourceName, tokenSets: requestedTokenSets });
  }

  let tokenRender: ReturnType<typeof renderTokenTableWithDiagnostics>;
  try {
    tokenRender = renderTokenTableWithDiagnostics(system, requestedTokenSets);
  } catch (error) {
    pageDiagnostic.unresolvedResourceCount += 1;
    return renderResourcePlaceholder('TOKEN_TABLE', {
      reason: 'render-error',
      phase: 'render-token-table',
      resource: resourceName,
      error: String(error)
    });
  }
  const rendered = tokenRender.markdown;
  const missingRequestedTokenSets = requestedTokenSets.filter((tokenSet) => !matchesRequestedTokenSet(system, tokenSet));
  if (missingRequestedTokenSets.length > 0) pageDiagnostic.missingRequestedTokenSets.push(...missingRequestedTokenSets);
  pageDiagnostic.tokenContextDiagnostics.push(...tokenRender.diagnostics.map((diagnostic) => ({
    ...diagnostic,
    resourceName
  })));
  const missingTokenSetNote = missingRequestedTokenSets.length > 0
    ? `> Requested token sets not found: ${missingRequestedTokenSets.join(', ')}`
    : '';
  if (!rendered.trim()) {
    if (missingTokenSetNote) {
      pageDiagnostic.tokenTablesRendered += 1;
      return missingTokenSetNote;
    }
    pageDiagnostic.unresolvedResourceCount += 1;
    return renderResourcePlaceholder('TOKEN_TABLE', { reason: 'missing-requested-token-sets', resource: resourceName, tokenSets: requestedTokenSets });
  }

  pageDiagnostic.tokenTablesRendered += 1;
  return `${rendered.replace(/^\n*## Design Tokens\n\n/, '')}${missingTokenSetNote ? `\n\n${missingTokenSetNote}` : ''}`;
}

function extractTokenTableSystem(resource: unknown): TokenTableSystem | null {
  const direct = getPath(resource, 'system');
  if (direct) return normalizeTokenTableSystem(direct);
  const nested = getPath(resource, 'payload', 'system');
  if (nested) return normalizeTokenTableSystem(nested);
  return null;
}

function matchesRequestedTokenSet(system: TokenTableSystem, requestedTokenSet: string): boolean {
  return system.tokenSets.some((tokenSet) => tokenSet.displayName === requestedTokenSet || tokenSet.tokenSetName === requestedTokenSet);
}
