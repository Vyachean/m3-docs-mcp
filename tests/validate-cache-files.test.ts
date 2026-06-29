import { mkdir, mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { validateCacheFiles } from '../src/validation/validate-cache-files.js';
import { writeValidCacheV2Fixture } from './fixtures/cache-v2-fixture.js';

let cacheDir: string;

beforeEach(async () => {
  cacheDir = await mkdtemp(path.join(tmpdir(), 'm3-docs-mcp-validate-cache-files-'));
});

afterEach(async () => {
  await rm(cacheDir, { recursive: true, force: true });
});

describe('validateCacheFiles', () => {
  it('fails when the cache directory is empty', async () => {
    const result = await validateCacheFiles({ cacheDir });
    expect(result.passed).toBe(false);
    expect(result.reasons.length).toBeGreaterThan(0);
  });

  it('passes when every required file/directory exists', async () => {
    await writeValidCacheV2Fixture(cacheDir);
    const result = await validateCacheFiles({ cacheDir });
    expect(result.passed).toBe(true);
    expect(result.reasons).toEqual([]);
  });

  it('fails when pages/** exists but is empty', async () => {
    await writeValidCacheV2Fixture(cacheDir);
    await rm(path.join(cacheDir, 'pages'), { recursive: true, force: true });
    await mkdir(path.join(cacheDir, 'pages'), { recursive: true });
    const result = await validateCacheFiles({ cacheDir });
    expect(result.passed).toBe(false);
    expect(result.reasons.some((r) => r.includes('pages/**'))).toBe(true);
  });

  it('reports a specific missing file by relative label', async () => {
    await writeValidCacheV2Fixture(cacheDir);
    await rm(path.join(cacheDir, 'diagnostics', 'latest-update.json'), { force: true });
    const result = await validateCacheFiles({ cacheDir });
    expect(result.passed).toBe(false);
    expect(result.reasons.some((r) => r.includes('diagnostics/latest-update.json'))).toBe(true);
  });
});
