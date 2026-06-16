import type { ExtractionDiagnostics, ExtractionPageDiagnostic, ExtractionRouteDiagnostic } from '../types.js';

export function createEmptyExtractionDiagnostics(): ExtractionDiagnostics {
  return {
    totalPages: 0,
    totalRoutes: 0,
    pagesExtractedThroughJson: 0,
    pagesExtractedThroughDomFallback: 0,
    pagesWhereJsonFailed: 0,
    jsonFallbackRoutes: 0,
    pagesAcceptedFromDirectJson: 0,
    pagesAcceptedFromNetworkJson: 0,
    pagesAcceptedFromDomFallback: 0,
    pagesFailed: 0,
    routesWhereDirectJsonFailed: 0,
    routesWhereNetworkJsonFailed: 0,
    routesWhereDomFallbackFailed: 0,
    pagesWithUnknownChunkTypes: 0,
    pagesWithUnknownResourceTypes: 0,
    unknownChunkCount: 0,
    unknownResourceTypeCount: 0,
    unknownJsonResourceCount: 0,
    pagesWithTokenTables: 0,
    tokenTablesRequested: 0,
    tokenTablesResolved: 0,
    tokenTablesDecoded: 0,
    tokenTablesSuccessfullyRendered: 0,
    tokenTablesRenderedAsPlaceholder: 0,
    tokenTablesUnsupportedSchema: 0,
    tokenTablesFailedToRender: 0,
    tokenTablesMissingRequestedTokenSets: 0,
    tokenContextDiagnosticsRecorded: 0,
    tokenTablesUsingFallbackContext: 0,
    tokenTablesWithMultipleContextVariants: 0,
    tokenTablesWithUnresolvedTokens: 0,
    statusTablesRequested: 0,
    statusTablesResolved: 0,
    statusTablesDecoded: 0,
    statusTablesRendered: 0,
    statusTablesRenderedAsPlaceholder: 0,
    unsupportedStatusTableSchemaCount: 0,
    resourceChunksRequested: 0,
    resourceChunksResolved: 0,
    resourceChunksDecoded: 0,
    resourceChunksRendered: 0,
    resourceChunksPlaceholder: 0,
    pagesWithSuspiciouslyShortMarkdown: 0,
    pagesWithNoSections: 0,
    pagesWithNoHeadings: 0,
    imageCount: 0,
    videoCount: 0,
    unresolvedResourceCount: 0,
    rawJsonDebugFilesWritten: 0,
    routeDiagnostics: [],
    pageDiagnostics: []
  };
}

export function pushPageDiagnostic(
  diagnostics: ExtractionDiagnostics,
  pageDiagnostic: ExtractionPageDiagnostic
): void {
  diagnostics.totalPages += 1;
  diagnostics.pageDiagnostics.push(pageDiagnostic);
  // Page-level content quality metrics — authoritative source is page diagnostics
  if (pageDiagnostic.markdownLength < 80) diagnostics.pagesWithSuspiciouslyShortMarkdown += 1;
  if (pageDiagnostic.noSections) diagnostics.pagesWithNoSections += 1;
  if (pageDiagnostic.noHeadings) diagnostics.pagesWithNoHeadings += 1;
  diagnostics.imageCount += pageDiagnostic.imageCount;
  diagnostics.videoCount += pageDiagnostic.videoCount;
  diagnostics.unresolvedResourceCount += pageDiagnostic.unresolvedResourceCount;
  // Route-level metrics (token tables, status tables, context diagnostics) are
  // intentionally NOT aggregated here — they are counted exclusively in
  // pushRouteDiagnostic to avoid double-counting for accepted pages.
}

export function pushRouteDiagnostic(
  diagnostics: ExtractionDiagnostics,
  routeDiagnostic: ExtractionRouteDiagnostic
): void {
  diagnostics.totalRoutes += 1;
  diagnostics.routeDiagnostics.push(routeDiagnostic);
  if (routeDiagnostic.finalMethod === 'json') diagnostics.pagesExtractedThroughJson += 1;
  if (routeDiagnostic.finalMethod === 'dom') diagnostics.pagesExtractedThroughDomFallback += 1;
  if (routeDiagnostic.sourceUsed === 'direct-json') diagnostics.pagesAcceptedFromDirectJson += 1;
  if (routeDiagnostic.sourceUsed === 'network-json') diagnostics.pagesAcceptedFromNetworkJson += 1;
  if (routeDiagnostic.sourceUsed === 'dom-fallback') diagnostics.pagesAcceptedFromDomFallback += 1;
  if (routeDiagnostic.sourceUsed === 'failed') diagnostics.pagesFailed += 1;
  if (routeDiagnostic.directJsonAttempted && !routeDiagnostic.directJsonSucceeded) diagnostics.routesWhereDirectJsonFailed += 1;
  if (routeDiagnostic.networkJsonAttempted && !routeDiagnostic.networkJsonSucceeded) diagnostics.routesWhereNetworkJsonFailed += 1;
  if (routeDiagnostic.domFallbackAttempted && !routeDiagnostic.domFallbackSucceeded) diagnostics.routesWhereDomFallbackFailed += 1;
  if (routeDiagnostic.directJsonAttempted && !routeDiagnostic.directJsonSucceeded) diagnostics.pagesWhereJsonFailed += 1;
  if (routeDiagnostic.directJsonAttempted && !routeDiagnostic.directJsonSucceeded) diagnostics.jsonFallbackRoutes += 1;
  if (routeDiagnostic.unknownChunkTypes.length > 0) diagnostics.pagesWithUnknownChunkTypes += 1;
  if (routeDiagnostic.unknownResourceTypes.length > 0) diagnostics.pagesWithUnknownResourceTypes += 1;
  diagnostics.unknownChunkCount += routeDiagnostic.unknownChunkTypes.length;
  diagnostics.unknownResourceTypeCount += routeDiagnostic.unknownResourceTypes.length;
  diagnostics.unknownJsonResourceCount += routeDiagnostic.unknownJsonResourceCount ?? 0;
  if (routeDiagnostic.tokenTables > 0) diagnostics.pagesWithTokenTables += 1;
  diagnostics.tokenTablesRequested += routeDiagnostic.tokenTablesRequested ?? routeDiagnostic.tokenTables;
  diagnostics.tokenTablesResolved += routeDiagnostic.tokenTablesResolved ?? 0;
  diagnostics.tokenTablesDecoded += routeDiagnostic.tokenTablesDecoded ?? 0;
  diagnostics.tokenTablesSuccessfullyRendered += routeDiagnostic.tokenTablesRendered;
  diagnostics.tokenTablesRenderedAsPlaceholder += routeDiagnostic.tokenTablesRenderedAsPlaceholder ?? 0;
  diagnostics.tokenTablesUnsupportedSchema += routeDiagnostic.tokenTablesUnsupportedSchema ?? 0;
  diagnostics.tokenTablesFailedToRender += Math.max(0, routeDiagnostic.tokenTables - routeDiagnostic.tokenTablesRendered);
  diagnostics.tokenTablesMissingRequestedTokenSets += routeDiagnostic.missingRequestedTokenSets.length;
  diagnostics.statusTablesRequested += routeDiagnostic.statusTablesRequested ?? 0;
  diagnostics.statusTablesResolved += routeDiagnostic.statusTablesResolved ?? 0;
  diagnostics.statusTablesDecoded += routeDiagnostic.statusTablesDecoded ?? 0;
  diagnostics.statusTablesRendered += routeDiagnostic.statusTablesRendered ?? 0;
  diagnostics.statusTablesRenderedAsPlaceholder += routeDiagnostic.statusTablesRenderedAsPlaceholder ?? 0;
  diagnostics.unsupportedStatusTableSchemaCount += routeDiagnostic.unsupportedStatusTableSchemaCount ?? 0;
  diagnostics.resourceChunksRequested += routeDiagnostic.resourceChunksRequested ?? 0;
  diagnostics.resourceChunksResolved += routeDiagnostic.resourceChunksResolved ?? 0;
  diagnostics.resourceChunksDecoded += routeDiagnostic.resourceChunksDecoded ?? 0;
  diagnostics.resourceChunksRendered += routeDiagnostic.resourceChunksRendered ?? 0;
  diagnostics.resourceChunksPlaceholder += routeDiagnostic.resourceChunksPlaceholder ?? 0;
  diagnostics.tokenContextDiagnosticsRecorded += routeDiagnostic.tokenContextDiagnostics?.length ?? 0;
  diagnostics.tokenTablesUsingFallbackContext += routeDiagnostic.tokenContextDiagnostics?.filter((entry) => entry.usedFallbackContext).length ?? 0;
  diagnostics.tokenTablesWithMultipleContextVariants += routeDiagnostic.tokenContextDiagnostics?.filter((entry) => entry.multipleContextVariantsAvailable).length ?? 0;
  diagnostics.tokenTablesWithUnresolvedTokens += routeDiagnostic.tokenContextDiagnostics?.filter((entry) => entry.unresolvedTokenCount > 0).length ?? 0;
  diagnostics.rawJsonDebugFilesWritten += routeDiagnostic.rawJsonDebugFilesWritten ?? 0;
}
