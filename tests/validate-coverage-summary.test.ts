import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { indexPath } from '../src/cache.js';
import { validateCoverageSummary } from '../src/validation/validate-coverage-summary.js';

let cacheDir: string;

beforeEach(async () => {
  cacheDir = await mkdtemp(path.join(tmpdir(), 'm3-docs-mcp-validate-coverage-'));
});

afterEach(async () => {
  await rm(cacheDir, { recursive: true, force: true });
});

async function writeIndexJson(coverageDiagnostics: Record<string, unknown>): Promise<void> {
  await mkdir(cacheDir, { recursive: true });
  await writeFile(indexPath(cacheDir), JSON.stringify({ coverageDiagnostics }), 'utf8');
}

function baseRouteCoverageSummary(overrides: Record<string, unknown> = {}) {
  return {
    failedRoutes: 0,
    unresolvedRoutes: 0,
    partialRoutes: 0,
    problematicExamples: [],
    ...overrides,
  };
}

describe('validateCoverageSummary', () => {
  it('fails when index.json is missing', async () => {
    const result = await validateCoverageSummary({ cacheDir, mode: 'full' });
    expect(result.passed).toBe(false);
    expect(result.reasons[0]).toMatch(/index\.json is missing/);
  });

  it('passes on full mode when coverageHealth is "verified" and all route counts are zero', async () => {
    await writeIndexJson({ coverageHealth: 'verified', routeCoverageSummary: baseRouteCoverageSummary(), routeCoverage: [] });
    const result = await validateCoverageSummary({ cacheDir, mode: 'full' });
    expect(result.passed).toBe(true);
  });

  it('fails on full mode when coverageHealth is "partial"', async () => {
    await writeIndexJson({ coverageHealth: 'partial', routeCoverageSummary: baseRouteCoverageSummary(), routeCoverage: [] });
    const result = await validateCoverageSummary({ cacheDir, mode: 'full' });
    expect(result.passed).toBe(false);
    expect(result.reasons.some((r) => r.includes('coverageHealth'))).toBe(true);
  });

  it('fails on full mode when failedRoutes is non-zero', async () => {
    await writeIndexJson({ coverageHealth: 'verified', routeCoverageSummary: baseRouteCoverageSummary({ failedRoutes: 2 }), routeCoverage: [] });
    const result = await validateCoverageSummary({ cacheDir, mode: 'full' });
    expect(result.passed).toBe(false);
    expect(result.reasons.some((r) => r.includes('failedRoutes=2'))).toBe(true);
  });

  it('passes on smoke mode when coverageHealth is "partial"', async () => {
    await writeIndexJson({ coverageHealth: 'partial', routeCoverageSummary: baseRouteCoverageSummary({ failedRoutes: 3 }), routeCoverage: [] });
    const result = await validateCoverageSummary({ cacheDir, mode: 'smoke' });
    expect(result.passed).toBe(true);
  });

  it('fails on smoke mode when coverageHealth is "broken"', async () => {
    await writeIndexJson({ coverageHealth: 'broken', routeCoverageSummary: baseRouteCoverageSummary(), routeCoverage: [] });
    const result = await validateCoverageSummary({ cacheDir, mode: 'smoke' });
    expect(result.passed).toBe(false);
  });
});
