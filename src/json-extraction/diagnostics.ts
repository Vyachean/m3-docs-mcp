import type { ExtractionDiagnostics, ExtractionPageDiagnostic, ExtractionRouteDiagnostic } from '../types.js';

export function createEmptyExtractionDiagnostics(): ExtractionDiagnostics {
  return {
    totalPages: 0,
    totalRoutes: 0,
    pagesExtractedThroughJson: 0,
    pagesExtractedThroughDomFallback: 0,
    pagesWhereJsonFailed: 0,
    jsonFallbackRoutes: 0,
    pagesWithUnknownChunkTypes: 0,
    pagesWithUnknownResourceTypes: 0,
    unknownChunkCount: 0,
    unknownResourceTypeCount: 0,
    pagesWithTokenTables: 0,
    tokenTablesSuccessfullyRendered: 0,
    tokenTablesFailedToRender: 0,
    tokenTablesMissingRequestedTokenSets: 0,
    pagesWithSuspiciouslyShortMarkdown: 0,
    pagesWithNoSections: 0,
    pagesWithNoHeadings: 0,
    imageCount: 0,
    videoCount: 0,
    unresolvedResourceCount: 0,
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
  if (pageDiagnostic.markdownLength < 80) diagnostics.pagesWithSuspiciouslyShortMarkdown += 1;
  if (pageDiagnostic.noSections) diagnostics.pagesWithNoSections += 1;
  if (pageDiagnostic.noHeadings) diagnostics.pagesWithNoHeadings += 1;
  diagnostics.imageCount += pageDiagnostic.imageCount;
  diagnostics.videoCount += pageDiagnostic.videoCount;
  diagnostics.unresolvedResourceCount += pageDiagnostic.unresolvedResourceCount;
}

export function pushRouteDiagnostic(
  diagnostics: ExtractionDiagnostics,
  routeDiagnostic: ExtractionRouteDiagnostic
): void {
  diagnostics.totalRoutes += 1;
  diagnostics.routeDiagnostics.push(routeDiagnostic);
  if (routeDiagnostic.finalMethod === 'json') diagnostics.pagesExtractedThroughJson += 1;
  if (routeDiagnostic.finalMethod === 'dom') diagnostics.pagesExtractedThroughDomFallback += 1;
  if (routeDiagnostic.fallbackReason) diagnostics.pagesWhereJsonFailed += 1;
  if (routeDiagnostic.fallbackReason) diagnostics.jsonFallbackRoutes += 1;
  if (routeDiagnostic.unknownChunkTypes.length > 0) diagnostics.pagesWithUnknownChunkTypes += 1;
  if (routeDiagnostic.unknownResourceTypes.length > 0) diagnostics.pagesWithUnknownResourceTypes += 1;
  diagnostics.unknownChunkCount += routeDiagnostic.unknownChunkTypes.length;
  diagnostics.unknownResourceTypeCount += routeDiagnostic.unknownResourceTypes.length;
  if (routeDiagnostic.tokenTables > 0) diagnostics.pagesWithTokenTables += 1;
  diagnostics.tokenTablesSuccessfullyRendered += routeDiagnostic.tokenTablesRendered;
  diagnostics.tokenTablesFailedToRender += Math.max(0, routeDiagnostic.tokenTables - routeDiagnostic.tokenTablesRendered);
  diagnostics.tokenTablesMissingRequestedTokenSets += routeDiagnostic.missingRequestedTokenSets.length;
}
