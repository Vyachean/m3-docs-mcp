import type { ExtractionPageDiagnostic } from '../types.js';
import {
  compactJson,
  extractRequestedTokenSetsFromChunk,
  extractResourceNameFromChunk,
  parseTokenTableSystem,
  ResourceChunkSchema,
  type DecodedResourceChunk,
} from './schemas.js';
import {
  normalizeTokenTableSystem,
  renderResourcePlaceholder,
  renderStatusTableMarkdown,
  renderTokenTableWithDiagnostics,
  type TokenTableSystem,
} from './render-markdown.js';

export type DsdbResourceFetcher = (resourceName: string, resourceType?: string) => Promise<unknown | null>;

export function extractRequestedTokenSets(resourceChunk: Record<string, unknown>): string[] {
  const decoded = ResourceChunkSchema.safeParse(resourceChunk);
  if (decoded.success) return extractRequestedTokenSetsFromChunk(decoded.data);
  // Fallback for callers passing plain objects before schema decode
  const values = [
    resourceChunk['moduleConfigurationOverrides'],
    resourceChunk['moduleConfiguration'],
    resourceChunk['tokenSets'],
  ];
  for (const container of values) {
    const arr = Array.isArray(container)
      ? container
      : (container && typeof container === 'object' && Array.isArray((container as Record<string, unknown>)['tokenSets']))
        ? (container as Record<string, unknown>)['tokenSets'] as unknown[]
        : null;
    if (Array.isArray(arr)) {
      const tokenSets = arr.filter(
        (entry): entry is string => typeof entry === 'string' && entry.trim().length > 0
      );
      if (tokenSets.length > 0) return tokenSets;
    }
  }
  return [];
}

export function extractResourceName(resourceChunk: Record<string, unknown>): string | null {
  const decoded = ResourceChunkSchema.safeParse(resourceChunk);
  if (decoded.success) return extractResourceNameFromChunk(decoded.data);
  return null;
}

export async function renderDsdbResourceChunk(
  resourceChunk: Record<string, unknown>,
  fetchResource: DsdbResourceFetcher,
  pageDiagnostic: ExtractionPageDiagnostic
): Promise<string> {
  const decoded: DecodedResourceChunk = ResourceChunkSchema.catch({} as DecodedResourceChunk).parse(resourceChunk);

  const libraryModuleType =
    decoded.libraryModuleType ??
    decoded.moduleType ??
    decoded.resourceType ??
    'UNKNOWN_RESOURCE';

  if (libraryModuleType === 'STATUS_TABLE') {
    const resourceName = extractResourceNameFromChunk(decoded);
    pageDiagnostic.statusTablesRequested = (pageDiagnostic.statusTablesRequested ?? 0) + 1;
    const resource = resourceName ? await fetchResource(resourceName, libraryModuleType) : null;
    const resourceFound = Boolean(resource);
    if (resourceFound) pageDiagnostic.statusTablesResolved = (pageDiagnostic.statusTablesResolved ?? 0) + 1;
    const rendered = renderStatusTableMarkdown(resource);
    const statusTableDiagnostics = pageDiagnostic.statusTableDiagnostics ?? (pageDiagnostic.statusTableDiagnostics = []);
    if (rendered) {
      pageDiagnostic.statusTablesRendered = (pageDiagnostic.statusTablesRendered ?? 0) + 1;
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

    const unsupportedSchema = resourceFound;
    pageDiagnostic.statusTablesRenderedAsPlaceholder = (pageDiagnostic.statusTablesRenderedAsPlaceholder ?? 0) + 1;
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
      chunk: compactJson(resourceChunk).slice(0, 280)
    });
  }

  if (libraryModuleType !== 'TOKEN_TABLE') {
    if (libraryModuleType !== 'UNKNOWN_RESOURCE') pageDiagnostic.unknownResourceTypes.push(libraryModuleType);
    pageDiagnostic.unresolvedResourceCount += 1;
    return renderResourcePlaceholder(libraryModuleType, {
      type: libraryModuleType,
      resource: extractResourceNameFromChunk(decoded),
      chunk: compactJson(resourceChunk).slice(0, 280)
    });
  }

  pageDiagnostic.tokenTables += 1;
  const requestedTokenSets = extractRequestedTokenSetsFromChunk(decoded);
  const resourceName = extractResourceNameFromChunk(decoded);
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

function getPath(root: unknown, ...path: string[]): unknown {
  let current: unknown = root;
  for (const key of path) {
    if (!current || typeof current !== 'object' || Array.isArray(current)) return undefined;
    const obj = current as Record<string, unknown>;
    if (!(key in obj)) return undefined;
    current = obj[key];
  }
  return current;
}

function matchesRequestedTokenSet(system: TokenTableSystem, requestedTokenSet: string): boolean {
  return system.tokenSets.some((tokenSet) => tokenSet.displayName === requestedTokenSet || tokenSet.tokenSetName === requestedTokenSet);
}
