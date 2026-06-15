import type { ExtractionDiagnostics, ExtractionPageDiagnostic } from '../types.js';

export function createEmptyExtractionDiagnostics(): ExtractionDiagnostics {
  return {
    totalPages: 0,
    pagesExtractedThroughJson: 0,
    pagesExtractedThroughDomFallback: 0,
    pagesWhereJsonFailed: 0,
    pagesWithUnknownChunkTypes: 0,
    pagesWithUnknownResourceTypes: 0,
    pagesWithTokenTables: 0,
    tokenTablesSuccessfullyRendered: 0,
    tokenTablesMissingRequestedTokenSets: 0,
    pagesWithSuspiciouslyShortMarkdown: 0,
    pagesWithNoSections: 0,
    pagesWithNoHeadings: 0,
    imageCount: 0,
    videoCount: 0,
    unresolvedResourceCount: 0,
    pageDiagnostics: []
  };
}

export function pushPageDiagnostic(
  diagnostics: ExtractionDiagnostics,
  pageDiagnostic: ExtractionPageDiagnostic
): void {
  diagnostics.totalPages += 1;
  diagnostics.pageDiagnostics.push(pageDiagnostic);
  if (pageDiagnostic.method === 'json') diagnostics.pagesExtractedThroughJson += 1;
  else diagnostics.pagesExtractedThroughDomFallback += 1;
  if (pageDiagnostic.fallbackReason) diagnostics.pagesWhereJsonFailed += 1;
  if (pageDiagnostic.unknownChunkTypes.length > 0) diagnostics.pagesWithUnknownChunkTypes += 1;
  if (pageDiagnostic.unknownResourceTypes.length > 0) diagnostics.pagesWithUnknownResourceTypes += 1;
  if (pageDiagnostic.tokenTables > 0) diagnostics.pagesWithTokenTables += 1;
  diagnostics.tokenTablesSuccessfullyRendered += pageDiagnostic.tokenTablesRendered;
  diagnostics.tokenTablesMissingRequestedTokenSets += pageDiagnostic.missingRequestedTokenSets.length;
  if (pageDiagnostic.markdownLength < 80) diagnostics.pagesWithSuspiciouslyShortMarkdown += 1;
  if (pageDiagnostic.noSections) diagnostics.pagesWithNoSections += 1;
  if (pageDiagnostic.noHeadings) diagnostics.pagesWithNoHeadings += 1;
  diagnostics.imageCount += pageDiagnostic.imageCount;
  diagnostics.videoCount += pageDiagnostic.videoCount;
  diagnostics.unresolvedResourceCount += pageDiagnostic.unresolvedResourceCount;
}
