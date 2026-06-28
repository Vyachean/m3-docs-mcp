import { describe, expect, it } from 'vitest';
import { applySharedRouteCoverage, createRouteCoverageEntry } from '../src/route-coverage.js';

describe('applySharedRouteCoverage', () => {
  it('is not order-dependent when a skipped alias shares coverage with a covered route', () => {
    const skippedEntry = createRouteCoverageEntry({
      baseUrl: 'https://m3.material.io',
      sourceRoute: '/components/buttons',
      canonicalRoute: '/components/buttons/overview',
      status: 'policySkipped',
      failureReasons: ['alias-only-source-route']
    });
    const coveredEntry = createRouteCoverageEntry({
      baseUrl: 'https://m3.material.io',
      sourceRoute: '/components/buttons/overview',
      canonicalRoute: '/components/buttons/overview',
      status: 'covered'
    });
    coveredEntry.savedOutputPaths = [...coveredEntry.expectedOutputPaths];

    const result = applySharedRouteCoverage([skippedEntry, coveredEntry]);

    expect(result).toEqual([
      expect.objectContaining({
        sourceRoute: '/components/buttons',
        status: 'covered',
        failureReasons: [],
        coverageSharedWithSourceRoutes: ['/components/buttons', '/components/buttons/overview']
      }),
      expect.objectContaining({
        sourceRoute: '/components/buttons/overview',
        status: 'covered',
        failureReasons: [],
        coverageSharedWithSourceRoutes: ['/components/buttons', '/components/buttons/overview']
      })
    ]);
  });
});
