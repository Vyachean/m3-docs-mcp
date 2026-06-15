import type { ExtractionPageDiagnostic } from '../types.js';
import {
  asObject,
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
  raw: unknown,
  fetchResource: DsdbResourceFetcher,
  pageDiagnostic: ExtractionPageDiagnostic
): Promise<string> {
  const decoded: DecodedResourceChunk = ResourceChunkSchema.catch({} as DecodedResourceChunk).parse(raw);

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
      chunk: compactJson(raw).slice(0, 280)
    });
  }

  if (libraryModuleType !== 'TOKEN_TABLE') {
    if (libraryModuleType !== 'UNKNOWN_RESOURCE') pageDiagnostic.unknownResourceTypes.push(libraryModuleType);
    pageDiagnostic.unresolvedResourceCount += 1;
    return renderResourcePlaceholder(libraryModuleType, {
      type: libraryModuleType,
      resource: extractResourceNameFromChunk(decoded),
      chunk: compactJson(raw).slice(0, 280)
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
    const obj = asObject(current);
    if (!obj || !(key in obj)) return undefined;
    current = obj[key];
  }
  return current;
}

function matchesRequestedTokenSet(system: TokenTableSystem, requestedTokenSet: string): boolean {
  return system.tokenSets.some((tokenSet) => tokenSet.displayName === requestedTokenSet || tokenSet.tokenSetName === requestedTokenSet);
}
