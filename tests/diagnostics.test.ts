import { describe, expect, it } from 'vitest';
import {
  computeSourceAndVirtualPageCounters,
  createEmptyExtractionDiagnostics,
  pushPageDiagnostic,
  pushRouteDiagnostic
} from '../src/json-extraction/diagnostics.js';
import type { ExtractionPageDiagnostic, ExtractionRouteDiagnostic } from '../src/types.js';

function routeDiagnostic(overrides: Partial<ExtractionRouteDiagnostic>): ExtractionRouteDiagnostic {
  return {
    url: 'https://m3.material.io/x',
    path: 'x.md',
    sourceUsed: 'direct-json',
    finalMethod: 'json',
    jsonAttempted: true,
    jsonSucceeded: true,
    browserFallbackAttempted: false,
    browserFallbackSucceeded: false,
    unknownChunkTypes: [],
    unknownResourceTypes: [],
    tokenTables: 0,
    tokenTablesRendered: 0,
    missingRequestedTokenSets: [],
    ...overrides
  };
}

function pageDiagnostic(overrides: Partial<ExtractionPageDiagnostic>): ExtractionPageDiagnostic {
  return {
    url: 'https://m3.material.io/components/buttons/overview',
    path: 'components/buttons/overview.md',
    method: 'json',
    source: 'direct-json',
    unknownChunkTypes: [],
    unknownResourceTypes: [],
    tokenTables: 0,
    tokenTablesRendered: 0,
    tokenContextDiagnostics: [],
    missingRequestedTokenSets: [],
    suspiciousReasons: [],
    imageCount: 0,
    videoCount: 0,
    unresolvedResourceCount: 0,
    noSections: false,
    noHeadings: false,
    markdownLength: 80,
    ...overrides
  };
}

describe('extraction diagnostic aggregation', () => {
  it('initializes every counter and diagnostic collection to its empty value', () => {
    const diagnostics = createEmptyExtractionDiagnostics();

    for (const value of Object.values(diagnostics)) {
      if (Array.isArray(value)) expect(value).toEqual([]);
      else expect(value).toBe(0);
    }
  });

  it('aggregates page quality counters and keeps the short-markdown boundary strict', () => {
    const diagnostics = createEmptyExtractionDiagnostics();
    const shortPage = pageDiagnostic({
      markdownLength: 79,
      noSections: true,
      noHeadings: true,
      imageCount: 2,
      videoCount: 3,
      unresolvedResourceCount: 4
    });
    const boundaryPage = pageDiagnostic({ markdownLength: 80, imageCount: 5, videoCount: 6, unresolvedResourceCount: 7 });

    pushPageDiagnostic(diagnostics, shortPage);
    pushPageDiagnostic(diagnostics, boundaryPage);

    expect(diagnostics.totalPages).toBe(2);
    expect(diagnostics.pagesWithSuspiciouslyShortMarkdown).toBe(1);
    expect(diagnostics.pagesWithNoSections).toBe(1);
    expect(diagnostics.pagesWithNoHeadings).toBe(1);
    expect(diagnostics.imageCount).toBe(7);
    expect(diagnostics.videoCount).toBe(9);
    expect(diagnostics.unresolvedResourceCount).toBe(11);
    expect(diagnostics.pageDiagnostics).toEqual([shortPage, boundaryPage]);
  });

  it('aggregates all route-level success, failure, resource, and token-context counters', () => {
    const diagnostics = createEmptyExtractionDiagnostics();
    const richRoute = routeDiagnostic({
      sourceUsed: 'network-json',
      finalMethod: 'dom',
      directJsonAttempted: true,
      directJsonSucceeded: false,
      networkJsonAttempted: true,
      networkJsonSucceeded: false,
      domFallbackAttempted: true,
      domFallbackSucceeded: false,
      unknownChunkTypes: ['a', 'b'],
      unknownResourceTypes: ['x'],
      unknownJsonResourceCount: 3,
      tokenTables: 4,
      tokenTablesRequested: 5,
      tokenTablesResolved: 3,
      tokenTablesDecoded: 2,
      tokenTablesRendered: 1,
      tokenTablesRenderedAsPlaceholder: 2,
      tokenTablesUnsupportedSchema: 1,
      tokenTablesRenderedFromInline: 1,
      missingRequestedTokenSets: ['set-a', 'set-b'],
      statusTablesRequested: 6,
      statusTablesResolved: 5,
      statusTablesDecoded: 4,
      statusTablesRendered: 3,
      statusTablesRenderedAsPlaceholder: 2,
      unsupportedStatusTableSchemaCount: 1,
      resourceChunksRequested: 7,
      resourceChunksResolved: 6,
      resourceChunksDecoded: 5,
      resourceChunksRendered: 4,
      resourceChunksPlaceholder: 3,
      tokenContextDiagnostics: [
        {
          resourceName: 'tokens-a',
          requestedTokenSets: [],
          renderedTokenSets: [],
          selectedContextKeys: [],
          skippedContextKeys: [],
          availableContextKeys: [],
          unresolvedTokenCount: 2,
          missingRequestedTokenSetCount: 0,
          usedFallbackContext: true,
          multipleContextVariantsAvailable: true
        },
        {
          resourceName: 'tokens-b',
          requestedTokenSets: [],
          renderedTokenSets: [],
          selectedContextKeys: [],
          skippedContextKeys: [],
          availableContextKeys: [],
          unresolvedTokenCount: 0,
          missingRequestedTokenSetCount: 0,
          usedFallbackContext: false,
          multipleContextVariantsAvailable: false
        }
      ],
      rawJsonDebugFilesWritten: 8
    });

    pushRouteDiagnostic(diagnostics, richRoute);
    pushRouteDiagnostic(diagnostics, routeDiagnostic({ sourceUsed: 'failed', finalMethod: 'json' }));
    pushRouteDiagnostic(diagnostics, routeDiagnostic({ sourceUsed: 'dom-fallback', finalMethod: 'json' }));
    pushRouteDiagnostic(diagnostics, routeDiagnostic({ sourceUsed: 'direct-json', finalMethod: 'json' }));

    expect(diagnostics).toMatchObject({
      totalRoutes: 4,
      pagesExtractedThroughJson: 3,
      pagesExtractedThroughDomFallback: 1,
      pagesAcceptedFromDirectJson: 1,
      pagesAcceptedFromNetworkJson: 1,
      pagesAcceptedFromDomFallback: 1,
      pagesFailed: 1,
      routesWhereDirectJsonFailed: 1,
      routesWhereNetworkJsonFailed: 1,
      routesWhereDomFallbackFailed: 1,
      pagesWhereJsonFailed: 1,
      jsonFallbackRoutes: 1,
      pagesWithUnknownChunkTypes: 1,
      pagesWithUnknownResourceTypes: 1,
      unknownChunkCount: 2,
      unknownResourceTypeCount: 1,
      unknownJsonResourceCount: 3,
      pagesWithTokenTables: 1,
      tokenTablesRequested: 5,
      tokenTablesResolved: 3,
      tokenTablesDecoded: 2,
      tokenTablesSuccessfullyRendered: 1,
      tokenTablesRenderedAsPlaceholder: 2,
      tokenTablesUnsupportedSchema: 1,
      tokenTablesFailedToRender: 3,
      tokenTablesRenderedFromInline: 1,
      tokenTablesMissingRequestedTokenSets: 2,
      statusTablesRequested: 6,
      statusTablesResolved: 5,
      statusTablesDecoded: 4,
      statusTablesRendered: 3,
      statusTablesRenderedAsPlaceholder: 2,
      unsupportedStatusTableSchemaCount: 1,
      resourceChunksRequested: 7,
      resourceChunksResolved: 6,
      resourceChunksDecoded: 5,
      resourceChunksRendered: 4,
      resourceChunksPlaceholder: 3,
      tokenContextDiagnosticsRecorded: 2,
      tokenTablesUsingFallbackContext: 1,
      tokenTablesWithMultipleContextVariants: 1,
      tokenTablesWithUnresolvedTokens: 1,
      rawJsonDebugFilesWritten: 8
    });
    expect(diagnostics.routeDiagnostics).toHaveLength(4);
    expect(diagnostics.routeDiagnostics[0]).toBe(richRoute);
  });
});

describe('computeSourceAndVirtualPageCounters', () => {
  it('treats one source route expanding into multiple tab pages as a single attempted source route', () => {
    const diagnostics: ExtractionRouteDiagnostic[] = [
      routeDiagnostic({ path: 'components/buttons/specs.md', sourceRoute: 'components/buttons.md', sourceUsed: 'direct-json' }),
      routeDiagnostic({ path: 'components/buttons/anatomy.md', sourceRoute: 'components/buttons.md', sourceUsed: 'direct-json' }),
      routeDiagnostic({ path: 'components/buttons/guidelines.md', sourceRoute: 'components/buttons.md', sourceUsed: 'direct-json' }),
      routeDiagnostic({ path: 'components/lists/specs.md', sourceRoute: 'components/lists.md', sourceUsed: 'direct-json' }),
      routeDiagnostic({ path: 'components/lists/anatomy.md', sourceRoute: 'components/lists.md', sourceUsed: 'direct-json' })
    ];

    const counters = computeSourceAndVirtualPageCounters(diagnostics);
    expect(counters.sourcePagesAttempted).toBe(2);
    expect(counters.sourcePagesSucceeded).toBe(2);
    expect(counters.sourcePagesFailed).toBe(0);
    expect(counters.virtualPagesPlanned).toBe(5);
    expect(counters.virtualPagesSaved).toBe(5);
    expect(counters.virtualPagesFailed).toBe(0);
    expect(counters.cachePagesSaved).toBe(5);
  });

  it('excludes skipped (never-attempted) routes from every counter', () => {
    const diagnostics: ExtractionRouteDiagnostic[] = [
      routeDiagnostic({ path: 'components/buttons/specs.md', sourceUsed: 'direct-json' }),
      routeDiagnostic({ path: 'legacy/app-bars-bottom.md', sourceUsed: 'skipped', skippedReason: 'not-selected' }),
      routeDiagnostic({ path: 'styles/color/roles.md', sourceUsed: 'skipped', skippedReason: 'missing-page-reference' })
    ];

    const counters = computeSourceAndVirtualPageCounters(diagnostics);
    expect(counters.sourcePagesAttempted).toBe(1);
    expect(counters.sourcePagesSucceeded).toBe(1);
    expect(counters.virtualPagesPlanned).toBe(1);
  });

  it('excludes policy-skipped blog routes from virtualPagesFailed/failedPageCount', () => {
    const diagnostics: ExtractionRouteDiagnostic[] = [
      routeDiagnostic({ path: 'components/buttons/specs.md', sourceUsed: 'direct-json' }),
      routeDiagnostic({
        path: 'blog.md',
        sourceUsed: 'skipped',
        skippedReason: 'blog',
        directJsonAttempted: false,
        networkJsonAttempted: false,
        domFallbackAttempted: false
      })
    ];

    const counters = computeSourceAndVirtualPageCounters(diagnostics);
    expect(counters.sourcePagesAttempted).toBe(1);
    expect(counters.virtualPagesPlanned).toBe(1);
    expect(counters.virtualPagesFailed).toBe(0);
    expect(counters.virtualPagesSaved).toBe(1);
  });

  it('counts a source route as failed only when none of its virtual pages saved', () => {
    const diagnostics: ExtractionRouteDiagnostic[] = [
      routeDiagnostic({ path: 'components/x/tab-a.md', sourceRoute: 'components/x.md', sourceUsed: 'failed' }),
      routeDiagnostic({ path: 'components/x/tab-b.md', sourceRoute: 'components/x.md', sourceUsed: 'failed' })
    ];

    const counters = computeSourceAndVirtualPageCounters(diagnostics);
    expect(counters.sourcePagesAttempted).toBe(1);
    expect(counters.sourcePagesFailed).toBe(1);
    expect(counters.sourcePagesSucceeded).toBe(0);
    expect(counters.virtualPagesFailed).toBe(2);
  });

  it('counts a source route as succeeded if at least one tab saved even if others failed', () => {
    const diagnostics: ExtractionRouteDiagnostic[] = [
      routeDiagnostic({ path: 'components/x/tab-a.md', sourceRoute: 'components/x.md', sourceUsed: 'direct-json' }),
      routeDiagnostic({ path: 'components/x/tab-b.md', sourceRoute: 'components/x.md', sourceUsed: 'failed' })
    ];

    const counters = computeSourceAndVirtualPageCounters(diagnostics);
    expect(counters.sourcePagesSucceeded).toBe(1);
    expect(counters.sourcePagesFailed).toBe(0);
    expect(counters.virtualPagesSaved).toBe(1);
    expect(counters.virtualPagesFailed).toBe(1);
  });
});
