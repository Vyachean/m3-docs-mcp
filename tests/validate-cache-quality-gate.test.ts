import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  ALLOWED_UPSTREAM_EMPTY_CELLS,
  ALLOWED_UPSTREAM_EMPTY_ROUTES,
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

async function writeDiagnosticsRaw(cacheDir: string, content: string): Promise<void> {
  const dir = diagnosticsDir(cacheDir);
  await mkdir(dir, { recursive: true });
  await writeFile(path.join(dir, 'token-resolution-summary.json'), content, 'utf8');
}

// The full production baseline (2026-06-30):
//   unresolvedTokenRows: 1, unresolvedCellCount: 2, upstream-empty: 2
//   token: md.comp.search-bar.contained.motion.spring
//   routes: /components/search/specs, /components/app-bars/specs
const PRODUCTION_BASELINE_TOKEN = ALLOWED_UPSTREAM_EMPTY_TOKENS[0]!;
const PRODUCTION_BASELINE_ROUTES = [...ALLOWED_UPSTREAM_EMPTY_ROUTES];

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

describe('checkTokenQuality — file availability', () => {
  it('fails with token-resolution-summary.missing when diagnostics file is absent', async () => {
    const result = await checkTokenQuality(cacheDir);
    expect(result.qualityPassed).toBe(false);
    expect(result.tokenQuality).toBeNull();
    const failure = result.qualityFailures.find((f) => f.dimension === 'token-resolution-summary.missing');
    expect(failure).toBeDefined();
    expect(failure?.diagnosticsPath).toBe(tokenResolutionDiagnosticsPath(cacheDir));
  });

  it('fails with token-resolution-summary.invalid when the file is not valid JSON', async () => {
    await writeDiagnosticsRaw(cacheDir, 'not-json{{{');
    const result = await checkTokenQuality(cacheDir);
    expect(result.qualityPassed).toBe(false);
    expect(result.tokenQuality).toBeNull();
    const failure = result.qualityFailures.find((f) => f.dimension === 'token-resolution-summary.invalid');
    expect(failure).toBeDefined();
    expect(failure?.diagnosticsPath).toBe(tokenResolutionDiagnosticsPath(cacheDir));
  });

  it('fails with token-resolution-summary.invalid when the JSON does not match the expected schema', async () => {
    // Valid JSON but wrong shape (array instead of object)
    await writeDiagnosticsRaw(cacheDir, JSON.stringify([1, 2, 3]));
    const result = await checkTokenQuality(cacheDir);
    expect(result.qualityPassed).toBe(false);
    expect(result.tokenQuality).toBeNull();
    const failure = result.qualityFailures.find((f) => f.dimension === 'token-resolution-summary.invalid');
    expect(failure).toBeDefined();
  });
});

describe('checkTokenQuality — schema strictness', () => {
  it('fails with token-resolution-summary.invalid when JSON is an empty object', async () => {
    await writeDiagnosticsRaw(cacheDir, JSON.stringify({}));
    const result = await checkTokenQuality(cacheDir);
    expect(result.qualityPassed).toBe(false);
    const failure = result.qualityFailures.find((f) => f.dimension === 'token-resolution-summary.invalid');
    expect(failure).toBeDefined();
  });

  it('fails with token-resolution-summary.invalid when only unresolvedTokenRows is present', async () => {
    await writeDiagnosticsRaw(cacheDir, JSON.stringify({ unresolvedTokenRows: 0 }));
    const result = await checkTokenQuality(cacheDir);
    expect(result.qualityPassed).toBe(false);
    const failure = result.qualityFailures.find((f) => f.dimension === 'token-resolution-summary.invalid');
    expect(failure).toBeDefined();
  });

  it('fails with token-resolution-summary.invalid when unresolvedByReason is missing a required key', async () => {
    await writeDiagnosticsRaw(cacheDir, JSON.stringify({
      unresolvedTokenRows: 0,
      unresolvedCellCount: 0,
      unresolvedByRoute: [],
      unresolvedByReason: {
        'missing-alias-target': 0,
        'missing-context-entry': 0,
        'unsupported-value-type': 0,
        'upstream-empty': 0,
        // 'parser-bug' intentionally absent
        unclassified: 0,
      },
    }));
    const result = await checkTokenQuality(cacheDir);
    expect(result.qualityPassed).toBe(false);
    const failure = result.qualityFailures.find((f) => f.dimension === 'token-resolution-summary.invalid');
    expect(failure).toBeDefined();
  });

  it('passes with a valid complete production-shaped summary', async () => {
    await writeTokenSummary(cacheDir, {
      unresolvedTokenRows: 0,
      unresolvedCellCount: 0,
      byReason: makeByReason(),
    });
    const result = await checkTokenQuality(cacheDir);
    expect(result.qualityPassed).toBe(true);
    expect(result.qualityFailures).toEqual([]);
  });
});

describe('checkTokenQuality — zero-tolerance reasons', () => {
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

describe('checkTokenQuality — upstream-empty allowlist', () => {
  it('passes with the full production baseline (1 row, 2 cells, both allowed routes)', async () => {
    await writeTokenSummary(cacheDir, {
      unresolvedTokenRows: ALLOWED_UNRESOLVED_TOKEN_ROWS,
      unresolvedCellCount: ALLOWED_UNRESOLVED_CELL_COUNT,
      byReason: makeByReason({ 'upstream-empty': ALLOWED_UPSTREAM_EMPTY_CELLS }),
      byRoute: PRODUCTION_BASELINE_ROUTES.map((route) => ({
        route,
        unresolvedTokenRows: 1,
        unresolvedCellCount: 1,
        examples: [{ token: PRODUCTION_BASELINE_TOKEN, unresolvedReason: 'upstream-empty' }],
      })),
    });
    const result = await checkTokenQuality(cacheDir);
    expect(result.qualityPassed).toBe(true);
    expect(result.qualityFailures).toEqual([]);
    expect(result.tokenQuality?.upstreamEmptyTokens).toEqual([PRODUCTION_BASELINE_TOKEN]);
  });

  it('passes with the allowed token on a single allowed route when count is 1', async () => {
    await writeTokenSummary(cacheDir, {
      unresolvedTokenRows: ALLOWED_UNRESOLVED_TOKEN_ROWS,
      unresolvedCellCount: ALLOWED_UNRESOLVED_CELL_COUNT,
      byReason: makeByReason({ 'upstream-empty': 1 }),
      byRoute: [
        {
          route: ALLOWED_UPSTREAM_EMPTY_ROUTES[0]!,
          examples: [{ token: PRODUCTION_BASELINE_TOKEN, unresolvedReason: 'upstream-empty' }],
        },
      ],
    });
    const result = await checkTokenQuality(cacheDir);
    expect(result.qualityPassed).toBe(true);
    expect(result.qualityFailures).toEqual([]);
  });

  it('fails with upstream-empty.incomplete-evidence when count is 2 but only one example is provided', async () => {
    await writeTokenSummary(cacheDir, {
      unresolvedTokenRows: ALLOWED_UNRESOLVED_TOKEN_ROWS,
      unresolvedCellCount: ALLOWED_UNRESOLVED_CELL_COUNT,
      byReason: makeByReason({ 'upstream-empty': 2 }),
      byRoute: [
        {
          route: ALLOWED_UPSTREAM_EMPTY_ROUTES[0]!,
          examples: [{ token: PRODUCTION_BASELINE_TOKEN, unresolvedReason: 'upstream-empty' }],
        },
      ],
    });
    const result = await checkTokenQuality(cacheDir);
    expect(result.qualityPassed).toBe(false);
    const failure = result.qualityFailures.find((f) => f.dimension === 'upstream-empty.incomplete-evidence');
    expect(failure).toBeDefined();
    expect(failure?.current).toBe(1);
    expect(failure?.allowed).toBe(2);
    expect(failure?.diagnosticsPath).toBe(tokenResolutionDiagnosticsPath(cacheDir));
  });

  it('fails when upstream-empty > 0 but no upstream-empty examples exist', async () => {
    await writeTokenSummary(cacheDir, {
      unresolvedTokenRows: 1,
      unresolvedCellCount: 1,
      byReason: makeByReason({ 'upstream-empty': 1 }),
      byRoute: [
        { route: '/components/search/specs', examples: [] }, // no examples
      ],
    });
    const result = await checkTokenQuality(cacheDir);
    expect(result.qualityPassed).toBe(false);
    const failure = result.qualityFailures.find((f) => f.dimension === 'upstream-empty.no-evidence');
    expect(failure).toBeDefined();
    expect(failure?.diagnosticsPath).toBe(tokenResolutionDiagnosticsPath(cacheDir));
  });

  it('fails when upstream-empty > 0 with no byRoute entries at all', async () => {
    await writeTokenSummary(cacheDir, {
      unresolvedTokenRows: 1,
      unresolvedCellCount: 1,
      byReason: makeByReason({ 'upstream-empty': 1 }),
      byRoute: [], // no route entries
    });
    const result = await checkTokenQuality(cacheDir);
    expect(result.qualityPassed).toBe(false);
    const failure = result.qualityFailures.find((f) => f.dimension === 'upstream-empty.no-evidence');
    expect(failure).toBeDefined();
  });

  it('fails when upstream-empty token is not in the known allowlist (within count limit)', async () => {
    await writeTokenSummary(cacheDir, {
      unresolvedTokenRows: 1,
      unresolvedCellCount: 1,
      byReason: makeByReason({ 'upstream-empty': 1 }),
      byRoute: [
        {
          route: ALLOWED_UPSTREAM_EMPTY_ROUTES[0]!,
          examples: [{ token: 'md.comp.new-component.motion.spring', unresolvedReason: 'upstream-empty' }],
        },
      ],
    });
    const result = await checkTokenQuality(cacheDir);
    expect(result.qualityPassed).toBe(false);
    const failure = result.qualityFailures.find((f) =>
      f.dimension === 'unresolvedByReason.upstream-empty (unrecognized token)',
    );
    expect(failure).toBeDefined();
    expect(failure?.tokenExamples).toContain('md.comp.new-component.motion.spring');
    expect(failure?.diagnosticsPath).toBe(tokenResolutionDiagnosticsPath(cacheDir));
  });

  it('fails when upstream-empty uses the allowed token but on an unrecognized route', async () => {
    await writeTokenSummary(cacheDir, {
      unresolvedTokenRows: 1,
      unresolvedCellCount: 1,
      byReason: makeByReason({ 'upstream-empty': 1 }),
      byRoute: [
        {
          route: '/components/new-component/specs',
          examples: [{ token: PRODUCTION_BASELINE_TOKEN, unresolvedReason: 'upstream-empty' }],
        },
      ],
    });
    const result = await checkTokenQuality(cacheDir);
    expect(result.qualityPassed).toBe(false);
    const failure = result.qualityFailures.find((f) => f.dimension === 'upstream-empty.unrecognized-route');
    expect(failure).toBeDefined();
    expect(failure?.affectedRoutes).toContain('/components/new-component/specs');
    expect(failure?.diagnosticsPath).toBe(tokenResolutionDiagnosticsPath(cacheDir));
  });

  it('fails when upstream-empty cell count exceeds the allowed limit', async () => {
    await writeTokenSummary(cacheDir, {
      unresolvedTokenRows: 2,
      unresolvedCellCount: ALLOWED_UPSTREAM_EMPTY_CELLS + 1,
      byReason: makeByReason({ 'upstream-empty': ALLOWED_UPSTREAM_EMPTY_CELLS + 1 }),
      byRoute: [
        {
          route: ALLOWED_UPSTREAM_EMPTY_ROUTES[0]!,
          examples: [
            { token: PRODUCTION_BASELINE_TOKEN, unresolvedReason: 'upstream-empty' },
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
});

describe('checkTokenQuality — row/cell totals', () => {
  it('fails when unresolvedTokenRows exceeds the allowed baseline', async () => {
    await writeTokenSummary(cacheDir, {
      unresolvedTokenRows: ALLOWED_UNRESOLVED_TOKEN_ROWS + 1,
      unresolvedCellCount: ALLOWED_UNRESOLVED_CELL_COUNT,
      byReason: makeByReason({ 'upstream-empty': ALLOWED_UPSTREAM_EMPTY_CELLS }),
      byRoute: PRODUCTION_BASELINE_ROUTES.map((route) => ({
        route,
        unresolvedTokenRows: 1,
        unresolvedCellCount: 1,
        examples: [{ token: PRODUCTION_BASELINE_TOKEN, unresolvedReason: 'upstream-empty' }],
      })),
    });
    const result = await checkTokenQuality(cacheDir);
    expect(result.qualityPassed).toBe(false);
    const failure = result.qualityFailures.find((f) => f.dimension === 'unresolvedTokenRows');
    expect(failure).toBeDefined();
    expect(failure?.current).toBe(ALLOWED_UNRESOLVED_TOKEN_ROWS + 1);
    expect(failure?.allowed).toBe(ALLOWED_UNRESOLVED_TOKEN_ROWS);
  });

  it('fails when unresolvedCellCount exceeds the allowed baseline', async () => {
    await writeTokenSummary(cacheDir, {
      unresolvedTokenRows: ALLOWED_UNRESOLVED_TOKEN_ROWS,
      unresolvedCellCount: ALLOWED_UNRESOLVED_CELL_COUNT + 1,
      byReason: makeByReason({ 'upstream-empty': ALLOWED_UNRESOLVED_CELL_COUNT + 1 }),
      byRoute: [
        {
          route: ALLOWED_UPSTREAM_EMPTY_ROUTES[0]!,
          examples: [{ token: PRODUCTION_BASELINE_TOKEN, unresolvedReason: 'upstream-empty' }],
        },
      ],
    });
    const result = await checkTokenQuality(cacheDir);
    const cellFailure = result.qualityFailures.find((f) => f.dimension === 'unresolvedCellCount');
    expect(cellFailure).toBeDefined();
    expect(cellFailure?.current).toBe(ALLOWED_UNRESOLVED_CELL_COUNT + 1);
    expect(cellFailure?.allowed).toBe(ALLOWED_UNRESOLVED_CELL_COUNT);
  });
});

// ──────────────────────────────────────────────────────────────────────────────
// validateCacheV2 with strictQuality integration
// ──────────────────────────────────────────────────────────────────────────────

describe('validateCacheV2 strictQuality', () => {
  it('default mode does not fail when quality diagnostics would fail strict mode', async () => {
    await writeValidCacheV2Fixture(cacheDir);
    await writeTokenSummary(cacheDir, {
      unresolvedTokenRows: 5,
      unresolvedCellCount: 10,
      byReason: makeByReason({ 'unsupported-value-type': 3 }),
      byRoute: [{ route: '/components/switch/specs', examples: [{ token: 'md.comp.switch.foo', unresolvedReason: 'unsupported-value-type' }] }],
    });
    // strictQuality not passed → informational only
    const result = await validateCacheV2({ cacheDir, renderedOutputRebuildFn: stubRebuild });
    expect(result.allPassed).toBe(true);
    expect(result.strictQuality).toBeUndefined();
  });

  it('does not add strictQuality when strictQuality: false', async () => {
    await writeValidCacheV2Fixture(cacheDir);
    const result = await validateCacheV2({ cacheDir, renderedOutputRebuildFn: stubRebuild, strictQuality: false });
    expect(result.strictQuality).toBeUndefined();
  });

  it('fails strict quality when token-resolution-summary.json is missing', async () => {
    await writeValidCacheV2Fixture(cacheDir);
    // No diagnostics file written
    const result = await validateCacheV2({ cacheDir, renderedOutputRebuildFn: stubRebuild, strictQuality: true });
    expect(result.allPassed).toBe(true); // schema stages still pass
    expect(result.strictQuality?.strictQualityEnabled).toBe(true);
    expect(result.strictQuality?.qualityPassed).toBe(false);
    const failure = result.strictQuality?.qualityFailures.find((f) => f.dimension === 'token-resolution-summary.missing');
    expect(failure).toBeDefined();
    expect(failure?.diagnosticsPath).toContain('token-resolution-summary.json');
  });

  it('fails strict quality when token-resolution-summary.json is invalid JSON', async () => {
    await writeValidCacheV2Fixture(cacheDir);
    await writeDiagnosticsRaw(cacheDir, '{invalid json');
    const result = await validateCacheV2({ cacheDir, renderedOutputRebuildFn: stubRebuild, strictQuality: true });
    expect(result.strictQuality?.qualityPassed).toBe(false);
    const failure = result.strictQuality?.qualityFailures.find((f) => f.dimension === 'token-resolution-summary.invalid');
    expect(failure).toBeDefined();
  });

  it('fails strict quality when token-resolution-summary.json has invalid schema', async () => {
    await writeValidCacheV2Fixture(cacheDir);
    // An object missing required fields is now rejected (schema has no defaults).
    await writeDiagnosticsRaw(cacheDir, JSON.stringify({ wrong: 'shape', notAnObject: true }));
    const result = await validateCacheV2({ cacheDir, renderedOutputRebuildFn: stubRebuild, strictQuality: true });
    expect(result.strictQuality?.qualityPassed).toBe(false);
    const failure = result.strictQuality?.qualityFailures.find((f) => f.dimension === 'token-resolution-summary.invalid');
    expect(failure).toBeDefined();
  });

  it('passes strict quality with the full production baseline', async () => {
    await writeValidCacheV2Fixture(cacheDir);
    await writeTokenSummary(cacheDir, {
      unresolvedTokenRows: ALLOWED_UNRESOLVED_TOKEN_ROWS,
      unresolvedCellCount: ALLOWED_UNRESOLVED_CELL_COUNT,
      byReason: makeByReason({ 'upstream-empty': ALLOWED_UPSTREAM_EMPTY_CELLS }),
      byRoute: PRODUCTION_BASELINE_ROUTES.map((route) => ({
        route,
        unresolvedTokenRows: 1,
        unresolvedCellCount: 1,
        examples: [{ token: PRODUCTION_BASELINE_TOKEN, unresolvedReason: 'upstream-empty' }],
      })),
    });
    const result = await validateCacheV2({ cacheDir, renderedOutputRebuildFn: stubRebuild, strictQuality: true });
    expect(result.allPassed).toBe(true);
    expect(result.strictQuality?.strictQualityEnabled).toBe(true);
    expect(result.strictQuality?.qualityPassed).toBe(true);
    expect(result.strictQuality?.qualityFailures).toEqual([]);
  });

  it('fails strict quality when unsupported-value-type > 0, including diagnostics path in failure', async () => {
    await writeValidCacheV2Fixture(cacheDir);
    await writeTokenSummary(cacheDir, {
      unresolvedTokenRows: 1,
      unresolvedCellCount: 1,
      byReason: makeByReason({ 'unsupported-value-type': 1 }),
      byRoute: [{ route: '/components/button/specs', examples: [{ token: 'md.comp.button.foo', unresolvedReason: 'unsupported-value-type' }] }],
    });
    const result = await validateCacheV2({ cacheDir, renderedOutputRebuildFn: stubRebuild, strictQuality: true });
    expect(result.allPassed).toBe(true); // schema stages still pass
    expect(result.strictQuality?.qualityPassed).toBe(false);
    const failure = result.strictQuality?.qualityFailures.find((f) => f.dimension === 'unresolvedByReason.unsupported-value-type');
    expect(failure).toBeDefined();
    expect(failure?.diagnosticsPath).toContain('token-resolution-summary.json');
  });

  it('fails strict quality when unclassified > 0', async () => {
    await writeValidCacheV2Fixture(cacheDir);
    await writeTokenSummary(cacheDir, {
      unresolvedTokenRows: 1,
      unresolvedCellCount: 1,
      byReason: makeByReason({ unclassified: 1 }),
      byRoute: [{ route: '/components/list/specs', examples: [{ token: 'md.comp.list.foo', unresolvedReason: 'unclassified' }] }],
    });
    const result = await validateCacheV2({ cacheDir, renderedOutputRebuildFn: stubRebuild, strictQuality: true });
    expect(result.strictQuality?.qualityPassed).toBe(false);
    const failure = result.strictQuality?.qualityFailures.find((f) => f.dimension === 'unresolvedByReason.unclassified');
    expect(failure).toBeDefined();
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
    // allPassed and failedStages cover only schema/structure stages
    expect(result.allPassed).toBe(true);
    expect(result.failedStages).toEqual([]);
    // quality gate reported separately
    expect(result.strictQuality?.qualityPassed).toBe(false);
  });
});
