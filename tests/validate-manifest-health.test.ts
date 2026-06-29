import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { writeManifest, type CacheManifest } from '../src/manifest.js';
import { validateManifestHealth } from '../src/validation/validate-manifest-health.js';

let cacheDir: string;

beforeEach(async () => {
  cacheDir = await mkdtemp(path.join(tmpdir(), 'm3-docs-mcp-validate-manifest-health-'));
});

afterEach(async () => {
  await rm(cacheDir, { recursive: true, force: true });
});

function makeManifest(overrides: Partial<CacheManifest['health']> = {}): CacheManifest {
  return {
    schemaVersion: 2,
    generatedAt: '2026-06-01T00:00:00.000Z',
    baseUrl: 'https://m3.material.io/',
    carbonVersion: 'cv-1',
    siteMetaHash: 'a'.repeat(64),
    angularBundleHash: 'b'.repeat(64),
    sitemapHash: 'c'.repeat(64),
    counts: { rawArtifacts: 1, routes: 1, pages: 1, markdownPages: 1, dsdbResources: 1, tokenTables: 1 },
    health: { rawSnapshot: 'verified', graph: 'verified', markdown: 'verified', coverage: 'verified', ...overrides },
  };
}

describe('validateManifestHealth', () => {
  it('fails when manifest.json is missing', async () => {
    const result = await validateManifestHealth({ cacheDir });
    expect(result.passed).toBe(false);
    expect(result.reasons[0]).toMatch(/manifest\.json is missing/);
  });

  it('passes when every health field is "verified"', async () => {
    await writeManifest(makeManifest(), cacheDir);
    const result = await validateManifestHealth({ cacheDir });
    expect(result.passed).toBe(true);
    expect(result.reasons).toEqual([]);
  });

  it('fails when any health field is not "verified"', async () => {
    await writeManifest(makeManifest({ coverage: 'partial' }), cacheDir);
    const result = await validateManifestHealth({ cacheDir });
    expect(result.passed).toBe(false);
    expect(result.reasons.some((r) => r.includes('manifest.health.coverage is "partial"'))).toBe(true);
  });

  it('fails when health is "unverified" (validation never ran)', async () => {
    await writeManifest(makeManifest({ graph: 'unverified' }), cacheDir);
    const result = await validateManifestHealth({ cacheDir });
    expect(result.passed).toBe(false);
    expect(result.reasons.some((r) => r.includes('manifest.health.graph is "unverified"'))).toBe(true);
  });
});
