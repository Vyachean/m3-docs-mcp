import { describe, expect, it } from 'vitest';
import { computeSourceAndVirtualPageCounters } from '../src/json-extraction/diagnostics.js';
import type { ExtractionRouteDiagnostic } from '../src/types.js';

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

describe('computeSourceAndVirtualPageCounters', () => {
  it('treats one source route expanding into multiple tab pages as a single attempted source route', () => {
    const diagnostics: ExtractionRouteDiagnostic[] = [
      routeDiagnostic({ path: 'components/buttons/specs.md', sourceRoute: 'components/buttons.md', sourceUsed: 'direct-json' }),
      routeDiagnostic({ path: 'components/buttons/anatomy.md', sourceRoute: 'components/buttons.md', sourceUsed: 'direct-json' }),
      routeDiagnostic({ path: 'components/buttons/guidelines.md', sourceRoute: 'components/buttons.md', sourceUsed: 'direct-json' }),
      routeDiagnostic({ path: 'components/lists/specs.md', sourceRoute: 'components/lists.md', sourceUsed: 'direct-json' }),
      routeDiagnostic({ path: 'components/lists/anatomy.md', sourceRoute: 'components/lists.md', sourceUsed: 'direct-json' }),
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
      routeDiagnostic({ path: 'styles/color/roles.md', sourceUsed: 'skipped', skippedReason: 'missing-page-reference' }),
    ];

    const counters = computeSourceAndVirtualPageCounters(diagnostics);
    expect(counters.sourcePagesAttempted).toBe(1);
    expect(counters.sourcePagesSucceeded).toBe(1);
    expect(counters.virtualPagesPlanned).toBe(1);
  });

  it('counts a source route as failed only when none of its virtual pages saved', () => {
    const diagnostics: ExtractionRouteDiagnostic[] = [
      routeDiagnostic({ path: 'components/x/tab-a.md', sourceRoute: 'components/x.md', sourceUsed: 'failed' }),
      routeDiagnostic({ path: 'components/x/tab-b.md', sourceRoute: 'components/x.md', sourceUsed: 'failed' }),
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
      routeDiagnostic({ path: 'components/x/tab-b.md', sourceRoute: 'components/x.md', sourceUsed: 'failed' }),
    ];

    const counters = computeSourceAndVirtualPageCounters(diagnostics);
    expect(counters.sourcePagesSucceeded).toBe(1);
    expect(counters.sourcePagesFailed).toBe(0);
    expect(counters.virtualPagesSaved).toBe(1);
    expect(counters.virtualPagesFailed).toBe(1);
  });
});
