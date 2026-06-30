import { mkdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  ALLOWED_UPSTREAM_EMPTY_CELLS,
  ALLOWED_UPSTREAM_EMPTY_TOKENS,
  ALLOWED_UNRESOLVED_CELL_COUNT,
  ALLOWED_UNRESOLVED_TOKEN_ROWS,
  checkTokenQuality,
  tokenResolutionDiagnosticsPath,
} from '../src/validation/validate-token-quality.js';
import { validateCacheV2 } from '../src/validation/validate-cache-v2.js';
import { writeValidCacheV2Fixture } from './fixtures/cache-v2-fixture.js';
import { REQUIRED_PAGE_PATHS } from '../src/validation/validate-rendered-output.js';
import { diagnosticsDir } from '../src/cache.js';

const GENERATED_AT = '2026-06-30T00:00:00.000Z';

const REBUILT_REQUIRED_PAGES = REQUIRED_PAGE_PATHS.map((pagePath) => ({
  id: pagePath,
  title: pagePath,
  url: `https://m3.material.io/${pagePath.replace(/^pages\//, '').replace(/\.md$/, '')}`,
  path: pagePath.replace(/^pages\//, ''),
  section: 'components',
  headings: ['OK'],
  text: 'OK',
  markdown: '# OK',
  capturedAt: GENERATED_AT,
}));

async function stubRebuild() {
  return {
    pages: REBUILT_REQUIRED_PAGES,
    report: { schemaVersion: 1 as const, generatedAt: GENERATED_AT, routes: [], requiredRouteFailures: [] },
  };
}

type ByReason = {
  'missing-alias-target': number;
  'missing-context-entry': number;
  'unsupported-value-type': number;
  'upstream-empty': number;
  'parser-bug': number;
  unclassified: number;
};

function makeByReason(overrides: Partial<ByReason> = {}): ByReason {
  return {
    'missing-alias-target': 0,
    'missing-context-entry': 0,
    'unsupported-value-type': 0,
    'upstream-empty': 0,
    'parser-bug': 0,
    unclassified: 0,
    ...overrides,
  };
}

type SummaryOptions = {
  unresolvedTokenRows?: number;
  unresolvedCellCount?: number;
  byReason?: Partial<ByReason>;
  byRoute?: Array<{
    route: string;
    unresolvedTokenRows?: number;
    unresolvedCellCount?: number;
    examples?: Array<{ token: string; tokenTableId?: string; column?: string; unresolvedReason: string }>;
  }>;
};

function makeTokenResolutionSummary(opts: SummaryOptions = {}) {
  const unresolvedTokenRows = opts.unresolvedTokenRows ?? 0;
  const unresolvedCellCount = opts.unresolvedCellCount ?? 0;
  const byRoute = (opts.byRoute ?? []).map((r) => ({
    route: r.route,
    tokenTableIds: [],
    unresolvedTokenRows: r.unresolvedTokenRows ?? 1,
    unresolvedCellCount: r.unresolvedCellCount ?? 1,
    examples: (r.examples ?? []).map((e) => ({
      token: e.token,
      tokenTableId: e.tokenTableId ?? 'token-table:test',
      column: e.column ?? 'Light',
      displayValue: '[unresolved]',
      unresolvedReason: e.unresolvedReason,
    })),
  }));
  return {
    schemaVersion: 1,
    generatedAt: GENERATED_AT,
    totalTokenTables: 1,
    totalTokenRows: 10,
    unresolvedTokenRows,
    unresolvedCellCount,
    unresolvedByRoute: byRoute,
    unresolvedByTokenTable: [],
    unresolvedByReason: makeByReason(opts.byReason),
  };
}

async function writeTokenSummary(cacheDir: string, opts: SummaryOptions = {}): Promise<void> {
  const dir = diagnosticsDir(cacheDir);
  await mkdir(dir, { recursive: true });
  await writeFile(
    path.join(dir, 'token-resolution-summary.json'),
    JSON.stringify(makeTokenResolutionSummary(opts), null, 2),
    'utf8',
  );
}

// ──────────────────────────────────────────────────────────────────────────────
// checkTokenQuality unit tests
// ──────────────────────────────────────────────────────────────────────────────

let cacheDir: string;

beforeEach(async () => {
  cacheDir = await mkdtemp(path.join(tmpdir(), 'm3-docs-mcp-quality-gate-'));
});

afterEach(async () => {
  await rm(cacheDir, { recursive: true, force: true });
});

import { mkdtemp } from 'node:fs/promises';

describe('checkTokenQuality', () => {
  it('passes and returns null tokenQuality when diagnostics file is absent', async () => {
    const result = await checkTokenQuality(cacheDir);
    expect(result.qualityPassed).toBe(true);
    expect(result.tokenQuality).toBeNull();
    expect(result.qualityFailures).toEqual([]);
  });

  it('passes with zero unresolved values', async () => {
    await writeTokenSummary(cacheDir, {
      unresolvedTokenRows: 0,
      unresolvedCellCount: 0,
      byReason: makeByReason(),
    });
    const result = await checkTokenQuality(cacheDir);
    expect(result.qualityPassed).toBe(true);
    expect(result.qualityFailures).toEqual([]);
    expect(result.tokenQuality?.unresolvedTokenRows).toBe(0);
  });

  it('passes with the known upstream-empty baseline (1 row, 2 cells, allowed token)', async () => {
    const allowedToken = ALLOWED_UPSTREAM_EMPTY_TOKENS[0];
    await writeTokenSummary(cacheDir, {
      unresolvedTokenRows: ALLOWED_UNRESOLVED_TOKEN_ROWS,
      unresolvedCellCount: ALLOWED_UNRESOLVED_CELL_COUNT,
      byReason: makeByReason({ 'upstream-empty': ALLOWED_UPSTREAM_EMPTY_CELLS }),
      byRoute: [
        {
          route: '/components/search/specs',
          examples: [{ token: allowedToken!, unresolvedReason: 'upstream-empty' }],
        },
      ],
    });
    const result = await checkTokenQuality(cacheDir);
    expect(result.qualityPassed).toBe(true);
    expect(result.qualityFailures).toEqual([]);
  });

  it('fails when unsupported-value-type > 0', async () => {
    await writeTokenSummary(cacheDir, {
      unresolvedTokenRows: 1,
      unresolvedCellCount: 1,
      byReason: makeByReason({ 'unsupported-value-type': 1 }),
      byRoute: [{ route: '/components/button/specs', examples: [{ token: 'md.comp.button.color', unresolvedReason: 'unsupported-value-type' }] }],
    });
    const result = await checkTokenQuality(cacheDir);
    expect(result.qualityPassed).toBe(false);
    const failure = result.qualityFailures.find((f) => f.dimension === 'unresolvedByReason.unsupported-value-type');
    expect(failure).toBeDefined();
    expect(failure?.current).toBe(1);
    expect(failure?.allowed).toBe(0);
    expect(failure?.tokenExamples).toContain('md.comp.button.color');
    expect(failure?.diagnosticsPath).toBe(tokenResolutionDiagnosticsPath(cacheDir));
  });

  it('fails when unclassified > 0', async () => {
    await writeTokenSummary(cacheDir, {
      unresolvedTokenRows: 1,
      unresolvedCellCount: 1,
      byReason: makeByReason({ unclassified: 2 }),
      byRoute: [{ route: '/components/switch/specs', examples: [{ token: 'md.comp.switch.foo', unresolvedReason: 'unclassified' }] }],
    });
    const result = await checkTokenQuality(cacheDir);
    expect(result.qualityPassed).toBe(false);
    const failure = result.qualityFailures.find((f) => f.dimension === 'unresolvedByReason.unclassified');
    expect(failure).toBeDefined();
    expect(failure?.current).toBe(2);
    expect(failure?.allowed).toBe(0);
  });

  it('fails when parser-bug > 0', async () => {
    await writeTokenSummary(cacheDir, {
      unresolvedTokenRows: 1,
      unresolvedCellCount: 1,
      byReason: makeByReason({ 'parser-bug': 1 }),
      byRoute: [{ route: '/components/list/specs', examples: [{ token: 'md.comp.list.foo', unresolvedReason: 'parser-bug' }] }],
    });
    const result = await checkTokenQuality(cacheDir);
    expect(result.qualityPassed).toBe(false);
    const failure = result.qualityFailures.find((f) => f.dimension === 'unresolvedByReason.parser-bug');
    expect(failure).toBeDefined();
  });

  it('fails when missing-alias-target > 0', async () => {
    await writeTokenSummary(cacheDir, {
      unresolvedTokenRows: 1,
      unresolvedCellCount: 1,
      byReason: makeByReason({ 'missing-alias-target': 3 }),
      byRoute: [{ route: '/components/fab/specs', examples: [{ token: 'md.comp.fab.foo', unresolvedReason: 'missing-alias-target' }] }],
    });
    const result = await checkTokenQuality(cacheDir);
    expect(result.qualityPassed).toBe(false);
    const failure = result.qualityFailures.find((f) => f.dimension === 'unresolvedByReason.missing-alias-target');
    expect(failure).toBeDefined();
  });

  it('fails when missing-context-entry > 0', async () => {
    await writeTokenSummary(cacheDir, {
      unresolvedTokenRows: 1,
      unresolvedCellCount: 1,
      byReason: makeByReason({ 'missing-context-entry': 1 }),
      byRoute: [{ route: '/components/dialog/specs', examples: [{ token: 'md.comp.dialog.foo', unresolvedReason: 'missing-context-entry' }] }],
    });
    const result = await checkTokenQuality(cacheDir);
    expect(result.qualityPassed).toBe(false);
    const failure = result.qualityFailures.find((f) => f.dimension === 'unresolvedByReason.missing-context-entry');
    expect(failure).toBeDefined();
  });

  it('fails when upstream-empty exceeds the allowed cell count', async () => {
    const allowedToken = ALLOWED_UPSTREAM_EMPTY_TOKENS[0]!;
    await writeTokenSummary(cacheDir, {
      unresolvedTokenRows: 2,
      unresolvedCellCount: ALLOWED_UPSTREAM_EMPTY_CELLS + 1,
      byReason: makeByReason({ 'upstream-empty': ALLOWED_UPSTREAM_EMPTY_CELLS + 1 }),
      byRoute: [
        {
          route: '/components/search/specs',
          examples: [
            { token: allowedToken, unresolvedReason: 'upstream-empty' },
            { token: 'md.comp.search-bar.motion.other', unresolvedReason: 'upstream-empty' },
          ],
        },
      ],
    });
    const result = await checkTokenQuality(cacheDir);
    expect(result.qualityPassed).toBe(false);
    const failure = result.qualityFailures.find((f) => f.dimension === 'unresolvedByReason.upstream-empty');
    expect(failure).toBeDefined();
    expect(failure?.current).toBe(ALLOWED_UPSTREAM_EMPTY_CELLS + 1);
    expect(failure?.allowed).toBe(ALLOWED_UPSTREAM_EMPTY_CELLS);
    expect(failure?.diagnosticsPath).toBe(tokenResolutionDiagnosticsPath(cacheDir));
  });

  it('fails when upstream-empty token is not the known allowed token (even within cell count limit)', async () => {
    await writeTokenSummary(cacheDir, {
      unresolvedTokenRows: 1,
      unresolvedCellCount: 1,
      byReason: makeByReason({ 'upstream-empty': 1 }),
      byRoute: [
        {
          route: '/components/new-component/specs',
          examples: [{ token: 'md.comp.new-component.motion.spring', unresolvedReason: 'upstream-empty' }],
        },
      ],
    });
    const result = await checkTokenQuality(cacheDir);
    expect(result.qualityPassed).toBe(false);
    const failure = result.qualityFailures.find((f) => f.dimension.includes('upstream-empty'));
    expect(failure).toBeDefined();
    expect(failure?.tokenExamples).toContain('md.comp.new-component.motion.spring');
    expect(failure?.diagnosticsPath).toBe(tokenResolutionDiagnosticsPath(cacheDir));
  });

  it('fails when unresolvedTokenRows exceeds the allowed baseline', async () => {
    const allowedToken = ALLOWED_UPSTREAM_EMPTY_TOKENS[0]!;
    await writeTokenSummary(cacheDir, {
      unresolvedTokenRows: ALLOWED_UNRESOLVED_TOKEN_ROWS + 1,
      unresolvedCellCount: ALLOWED_UNRESOLVED_CELL_COUNT,
      byReason: makeByReason({ 'upstream-empty': ALLOWED_UPSTREAM_EMPTY_CELLS }),
      byRoute: [
        { route: '/components/search/specs', examples: [{ token: allowedToken, unresolvedReason: 'upstream-empty' }] },
        { route: '/components/app-bars/specs', examples: [{ token: allowedToken, unresolvedReason: 'upstream-empty' }] },
      ],
    });
    const result = await checkTokenQuality(cacheDir);
    expect(result.qualityPassed).toBe(false);
    const failure = result.qualityFailures.find((f) => f.dimension === 'unresolvedTokenRows');
    expect(failure).toBeDefined();
    expect(failure?.current).toBe(ALLOWED_UNRESOLVED_TOKEN_ROWS + 1);
    expect(failure?.allowed).toBe(ALLOWED_UNRESOLVED_TOKEN_ROWS);
  });

  it('fails when unresolvedCellCount exceeds the allowed baseline', async () => {
    const allowedToken = ALLOWED_UPSTREAM_EMPTY_TOKENS[0]!;
    await writeTokenSummary(cacheDir, {
      unresolvedTokenRows: ALLOWED_UNRESOLVED_TOKEN_ROWS,
      unresolvedCellCount: ALLOWED_UNRESOLVED_CELL_COUNT + 1,
      byReason: makeByReason({ 'upstream-empty': ALLOWED_UNRESOLVED_CELL_COUNT + 1 }),
      byRoute: [
        { route: '/components/search/specs', examples: [{ token: allowedToken, unresolvedReason: 'upstream-empty' }] },
      ],
    });
    const result = await checkTokenQuality(cacheDir);
    // upstream-empty count also exceeds limit → two failures
    const cellFailure = result.qualityFailures.find((f) => f.dimension === 'unresolvedCellCount');
    expect(cellFailure).toBeDefined();
    expect(cellFailure?.current).toBe(ALLOWED_UNRESOLVED_CELL_COUNT + 1);
    expect(cellFailure?.allowed).toBe(ALLOWED_UNRESOLVED_CELL_COUNT);
  });

  it('reports affectedRoutes and tokenExamples for failures', async () => {
    await writeTokenSummary(cacheDir, {
      unresolvedTokenRows: 1,
      unresolvedCellCount: 1,
      byReason: makeByReason({ 'unsupported-value-type': 1 }),
      byRoute: [
        {
          route: '/components/button/specs',
          examples: [{ token: 'md.comp.button.color', unresolvedReason: 'unsupported-value-type' }],
        },
      ],
    });
    const result = await checkTokenQuality(cacheDir);
    const failure = result.qualityFailures[0];
    expect(failure?.affectedRoutes).toContain('/components/button/specs');
    expect(failure?.tokenExamples).toContain('md.comp.button.color');
  });
});

// ──────────────────────────────────────────────────────────────────────────────
// validateCacheV2 with strictQuality integration
// ──────────────────────────────────────────────────────────────────────────────

describe('validateCacheV2 strictQuality', () => {
  it('default mode (no strictQuality option) does not fail with allowed unresolved values', async () => {
    await writeValidCacheV2Fixture(cacheDir);
    // Write diagnostics with values that would fail strict mode
    await writeTokenSummary(cacheDir, {
      unresolvedTokenRows: 5,
      unresolvedCellCount: 10,
      byReason: makeByReason({ 'unsupported-value-type': 3 }),
      byRoute: [{ route: '/components/switch/specs', examples: [{ token: 'md.comp.switch.foo', unresolvedReason: 'unsupported-value-type' }] }],
    });
    const result = await validateCacheV2({ cacheDir, renderedOutputRebuildFn: stubRebuild });
    // allPassed concerns schema/structure, not quality
    expect(result.allPassed).toBe(true);
    expect(result.strictQuality).toBeUndefined();
  });

  it('returns strictQuality absent when strictQuality option is false (default)', async () => {
    await writeValidCacheV2Fixture(cacheDir);
    const result = await validateCacheV2({ cacheDir, renderedOutputRebuildFn: stubRebuild, strictQuality: false });
    expect(result.strictQuality).toBeUndefined();
  });

  it('returns strictQuality with qualityPassed=true for the known baseline', async () => {
    await writeValidCacheV2Fixture(cacheDir);
    const allowedToken = ALLOWED_UPSTREAM_EMPTY_TOKENS[0]!;
    await writeTokenSummary(cacheDir, {
      unresolvedTokenRows: ALLOWED_UNRESOLVED_TOKEN_ROWS,
      unresolvedCellCount: ALLOWED_UNRESOLVED_CELL_COUNT,
      byReason: makeByReason({ 'upstream-empty': ALLOWED_UPSTREAM_EMPTY_CELLS }),
      byRoute: [
        { route: '/components/search/specs', examples: [{ token: allowedToken, unresolvedReason: 'upstream-empty' }] },
      ],
    });
    const result = await validateCacheV2({ cacheDir, renderedOutputRebuildFn: stubRebuild, strictQuality: true });
    expect(result.allPassed).toBe(true);
    expect(result.strictQuality).toBeDefined();
    expect(result.strictQuality?.strictQualityEnabled).toBe(true);
    expect(result.strictQuality?.qualityPassed).toBe(true);
    expect(result.strictQuality?.qualityFailures).toEqual([]);
  });

  it('returns strictQuality with qualityPassed=false when unsupported-value-type > 0', async () => {
    await writeValidCacheV2Fixture(cacheDir);
    await writeTokenSummary(cacheDir, {
      unresolvedTokenRows: 1,
      unresolvedCellCount: 1,
      byReason: makeByReason({ 'unsupported-value-type': 1 }),
      byRoute: [{ route: '/components/button/specs', examples: [{ token: 'md.comp.button.foo', unresolvedReason: 'unsupported-value-type' }] }],
    });
    const result = await validateCacheV2({ cacheDir, renderedOutputRebuildFn: stubRebuild, strictQuality: true });
    // Schema validation still passes; strict quality fails
    expect(result.allPassed).toBe(true);
    expect(result.strictQuality?.qualityPassed).toBe(false);
    const failure = result.strictQuality?.qualityFailures.find((f) => f.dimension === 'unresolvedByReason.unsupported-value-type');
    expect(failure).toBeDefined();
    expect(failure?.diagnosticsPath).toContain('token-resolution-summary.json');
  });

  it('returns strictQuality with qualityPassed=true and null tokenQuality when no diagnostics file exists', async () => {
    await writeValidCacheV2Fixture(cacheDir);
    // No diagnostics written → quality is treated as passed (non-blocking)
    const result = await validateCacheV2({ cacheDir, renderedOutputRebuildFn: stubRebuild, strictQuality: true });
    expect(result.strictQuality?.strictQualityEnabled).toBe(true);
    expect(result.strictQuality?.qualityPassed).toBe(true);
    expect(result.strictQuality?.tokenQuality).toBeNull();
  });

  it('allPassed is not affected by strict quality failures', async () => {
    await writeValidCacheV2Fixture(cacheDir);
    await writeTokenSummary(cacheDir, {
      unresolvedTokenRows: 1,
      unresolvedCellCount: 1,
      byReason: makeByReason({ unclassified: 1 }),
      byRoute: [{ route: '/components/list/specs', examples: [{ token: 'md.comp.list.foo', unresolvedReason: 'unclassified' }] }],
    });
    const result = await validateCacheV2({ cacheDir, renderedOutputRebuildFn: stubRebuild, strictQuality: true });
    // allPassed and failedStages only cover schema/structure stages
    expect(result.allPassed).toBe(true);
    expect(result.failedStages).toEqual([]);
    // quality gate result is reported separately
    expect(result.strictQuality?.qualityPassed).toBe(false);
  });
});
