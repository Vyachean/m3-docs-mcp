import type { ExtractionPageDiagnostic } from '../types.js';
import {
  compactJson,
  decodeStatusTableResource,
  extractRequestedTokenSetsFromChunk,
  extractResourceNameFromChunk,
  parseTokenTableSystem,
  ResourceChunkSchema,
  type DecodedResourceChunk,
  type DecodedStatusTable,
  type UnsupportedStatusTable,
} from './schemas.js';
import {
  renderResourcePlaceholder,
  renderStatusTableMarkdown,
  renderTokenTableWithDiagnostics,
  type TokenTableSystem,
} from './render-markdown.js';

export type DsdbResourceFetcher = (resourceName: string, resourceType?: string) => Promise<unknown | null>;

export type UnsupportedResourceChunk = {
  readonly _unsupported: true;
  readonly issues: readonly string[];
};

export function decodeResourceChunk(raw: unknown): DecodedResourceChunk | UnsupportedResourceChunk {
  const result = ResourceChunkSchema.safeParse(raw);
  if (!result.success) {
    return { _unsupported: true, issues: result.error.issues.map((i) => i.message) };
  }
  return result.data;
}

function isUnsupportedResourceChunk(
  chunk: DecodedResourceChunk | UnsupportedResourceChunk
): chunk is UnsupportedResourceChunk {
  return '_unsupported' in chunk && chunk._unsupported === true;
}

export function extractRequestedTokenSets(raw: unknown): string[] {
  const decoded = ResourceChunkSchema.safeParse(raw);
  if (decoded.success) return extractRequestedTokenSetsFromChunk(decoded.data);
  return [];
}

export function extractResourceName(raw: unknown): string | null {
  const decoded = ResourceChunkSchema.safeParse(raw);
  if (decoded.success) return extractResourceNameFromChunk(decoded.data);
  return null;
}

export async function renderDsdbResourceChunk(
  chunk: DecodedResourceChunk | UnsupportedResourceChunk,
  fetchResource: DsdbResourceFetcher,
  pageDiagnostic: ExtractionPageDiagnostic
): Promise<string> {
  pageDiagnostic.resourceChunksRequested = (pageDiagnostic.resourceChunksRequested ?? 0) + 1;

  if (isUnsupportedResourceChunk(chunk)) {
    pageDiagnostic.unresolvedResourceCount += 1;
    pageDiagnostic.resourceChunksPlaceholder = (pageDiagnostic.resourceChunksPlaceholder ?? 0) + 1;
    return renderResourcePlaceholder('UNKNOWN_RESOURCE', {
      reason: 'malformed-resource-chunk',
      issues: chunk.issues
    });
  }

  const libraryModuleType =
    chunk.libraryModuleType ??
    chunk.moduleType ??
    chunk.resourceType ??
    'UNKNOWN_RESOURCE';

  if (libraryModuleType === 'STATUS_TABLE') {
    const resourceName = extractResourceNameFromChunk(chunk);
    pageDiagnostic.statusTablesRequested = (pageDiagnostic.statusTablesRequested ?? 0) + 1;
    const resource = resourceName ? await fetchResource(resourceName, libraryModuleType) : null;
    const resourceFound = Boolean(resource);
    if (resourceFound) {
      pageDiagnostic.statusTablesResolved = (pageDiagnostic.statusTablesResolved ?? 0) + 1;
      pageDiagnostic.resourceChunksResolved = (pageDiagnostic.resourceChunksResolved ?? 0) + 1;
    }

    const statusDecoded = decodeStatusTableResource(resource);
    const statusTableDiagnostics = pageDiagnostic.statusTableDiagnostics ?? (pageDiagnostic.statusTableDiagnostics = []);

    if (!isUnsupportedStatusTable(statusDecoded)) {
      pageDiagnostic.statusTablesDecoded = (pageDiagnostic.statusTablesDecoded ?? 0) + 1;
      pageDiagnostic.resourceChunksDecoded = (pageDiagnostic.resourceChunksDecoded ?? 0) + 1;
      const rendered = renderStatusTableMarkdown(statusDecoded);
      if (rendered) {
        pageDiagnostic.statusTablesRendered = (pageDiagnostic.statusTablesRendered ?? 0) + 1;
        pageDiagnostic.resourceChunksRendered = (pageDiagnostic.resourceChunksRendered ?? 0) + 1;
        statusTableDiagnostics.push({
          resourceName,
          requested: true,
          resolved: resourceFound,
          rendered: true,
          renderedAsPlaceholder: false,
          unsupportedSchema: false
        });
        return rendered;
      }
    }

    const unsupportedSchema = resourceFound;
    pageDiagnostic.statusTablesRenderedAsPlaceholder = (pageDiagnostic.statusTablesRenderedAsPlaceholder ?? 0) + 1;
    pageDiagnostic.resourceChunksPlaceholder = (pageDiagnostic.resourceChunksPlaceholder ?? 0) + 1;
    if (unsupportedSchema) pageDiagnostic.unsupportedStatusTableSchemaCount = (pageDiagnostic.unsupportedStatusTableSchemaCount ?? 0) + 1;
    statusTableDiagnostics.push({
      resourceName,
      requested: true,
      resolved: resourceFound,
      rendered: false,
      renderedAsPlaceholder: true,
      unsupportedSchema
    });
    pageDiagnostic.unknownResourceTypes.push(libraryModuleType);
    pageDiagnostic.unresolvedResourceCount += 1;
    return renderResourcePlaceholder('STATUS_TABLE', {
      reason: resource ? 'unknown-status-table-schema' : 'missing-status-table-resource',
      resource: resourceName,
      chunk: compactJson(chunk).slice(0, 280)
    });
  }

  if (libraryModuleType !== 'TOKEN_TABLE') {
    if (libraryModuleType !== 'UNKNOWN_RESOURCE') pageDiagnostic.unknownResourceTypes.push(libraryModuleType);
    pageDiagnostic.unresolvedResourceCount += 1;
    pageDiagnostic.resourceChunksPlaceholder = (pageDiagnostic.resourceChunksPlaceholder ?? 0) + 1;
    return renderResourcePlaceholder(libraryModuleType, {
      type: libraryModuleType,
      resource: extractResourceNameFromChunk(chunk),
      chunk: compactJson(chunk).slice(0, 280)
    });
  }

  pageDiagnostic.tokenTables += 1;
  const requestedTokenSets = extractRequestedTokenSetsFromChunk(chunk);
  const resourceName = extractResourceNameFromChunk(chunk);
  if (!resourceName) {
    pageDiagnostic.missingRequestedTokenSets.push(...requestedTokenSets);
    pageDiagnostic.unresolvedResourceCount += 1;
    pageDiagnostic.tokenTablesRenderedAsPlaceholder = (pageDiagnostic.tokenTablesRenderedAsPlaceholder ?? 0) + 1;
    pageDiagnostic.resourceChunksPlaceholder = (pageDiagnostic.resourceChunksPlaceholder ?? 0) + 1;
    return renderResourcePlaceholder('TOKEN_TABLE', { reason: 'missing-resource-name', tokenSets: requestedTokenSets });
  }

  const resource = await fetchResource(resourceName, libraryModuleType);
  if (resource !== null && resource !== undefined) {
    pageDiagnostic.tokenTablesResolved = (pageDiagnostic.tokenTablesResolved ?? 0) + 1;
    pageDiagnostic.resourceChunksResolved = (pageDiagnostic.resourceChunksResolved ?? 0) + 1;
  }
  const system = extractTokenTableSystem(resource);
  if (!system) {
    if (resource !== null && resource !== undefined) {
      pageDiagnostic.tokenTablesUnsupportedSchema = (pageDiagnostic.tokenTablesUnsupportedSchema ?? 0) + 1;
    }
    pageDiagnostic.missingRequestedTokenSets.push(...requestedTokenSets);
    pageDiagnostic.unresolvedResourceCount += 1;
    pageDiagnostic.tokenTablesRenderedAsPlaceholder = (pageDiagnostic.tokenTablesRenderedAsPlaceholder ?? 0) + 1;
    pageDiagnostic.resourceChunksPlaceholder = (pageDiagnostic.resourceChunksPlaceholder ?? 0) + 1;
    return renderResourcePlaceholder('TOKEN_TABLE', { reason: 'missing-token-system', resource: resourceName, tokenSets: requestedTokenSets });
  }

  pageDiagnostic.tokenTablesDecoded = (pageDiagnostic.tokenTablesDecoded ?? 0) + 1;
  pageDiagnostic.resourceChunksDecoded = (pageDiagnostic.resourceChunksDecoded ?? 0) + 1;

  let tokenRender: ReturnType<typeof renderTokenTableWithDiagnostics>;
  try {
    tokenRender = renderTokenTableWithDiagnostics(system, requestedTokenSets);
  } catch (error) {
    pageDiagnostic.unresolvedResourceCount += 1;
    pageDiagnostic.tokenTablesRenderedAsPlaceholder = (pageDiagnostic.tokenTablesRenderedAsPlaceholder ?? 0) + 1;
    pageDiagnostic.resourceChunksPlaceholder = (pageDiagnostic.resourceChunksPlaceholder ?? 0) + 1;
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
      pageDiagnostic.resourceChunksRendered = (pageDiagnostic.resourceChunksRendered ?? 0) + 1;
      return missingTokenSetNote;
    }
    pageDiagnostic.unresolvedResourceCount += 1;
    pageDiagnostic.tokenTablesRenderedAsPlaceholder = (pageDiagnostic.tokenTablesRenderedAsPlaceholder ?? 0) + 1;
    pageDiagnostic.resourceChunksPlaceholder = (pageDiagnostic.resourceChunksPlaceholder ?? 0) + 1;
    return renderResourcePlaceholder('TOKEN_TABLE', { reason: 'missing-requested-token-sets', resource: resourceName, tokenSets: requestedTokenSets });
  }

  pageDiagnostic.tokenTablesRendered += 1;
  pageDiagnostic.resourceChunksRendered = (pageDiagnostic.resourceChunksRendered ?? 0) + 1;
  return `${rendered.replace(/^\n*## Design Tokens\n\n/, '')}${missingTokenSetNote ? `\n\n${missingTokenSetNote}` : ''}`;
}

function isUnsupportedStatusTable(
  decoded: DecodedStatusTable | UnsupportedStatusTable
): decoded is UnsupportedStatusTable {
  return '_unsupported' in decoded && decoded._unsupported === true;
}

function extractTokenTableSystem(resource: unknown): TokenTableSystem | null {
  const direct = getPath(resource, 'system');
  if (direct) {
    const system = parseTokenTableSystem(direct);
    if (system) return system;
  }
  const nested = getPath(resource, 'payload', 'system');
  if (nested) {
    const system = parseTokenTableSystem(nested);
    if (system) return system;
  }
  return null;
}

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

function getPath(root: unknown, ...path: string[]): unknown {
  let current: unknown = root;
  for (const key of path) {
    if (!isRecord(current)) return undefined;
    if (!(key in current)) return undefined;
    current = current[key];
  }
  return current;
}

function matchesRequestedTokenSet(system: TokenTableSystem, requestedTokenSet: string): boolean {
  return system.tokenSets.some((tokenSet) => tokenSet.displayName === requestedTokenSet || tokenSet.tokenSetName === requestedTokenSet);
}
