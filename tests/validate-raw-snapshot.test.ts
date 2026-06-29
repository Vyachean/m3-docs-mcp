import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { upsertArtifactRecord } from '../src/raw-artifacts/artifact-index.js';
import { persistArtifact } from '../src/raw-artifacts/artifact-store.js';
import { createCacheManifest, writeManifest } from '../src/manifest.js';
import { validateRawSnapshot } from '../src/validation/validate-raw-snapshot.js';

let cacheDir: string;

beforeEach(async () => {
  cacheDir = await mkdtemp(path.join(tmpdir(), 'm3-docs-mcp-validate-raw-'));
});

afterEach(async () => {
  await rm(cacheDir, { recursive: true, force: true });
});

async function writeFullSnapshot(): Promise<void> {
  const shell = await persistArtifact({
    kind: 'site-shell',
    pathParts: ['shell.html'],
    sourceUrl: 'https://m3.material.io/',
    content: '<html></html>',
    sourceMethod: 'static-plan',
  }, cacheDir);
  await upsertArtifactRecord(shell, cacheDir);

  const siteMeta = await persistArtifact({
    kind: 'site-meta',
    pathParts: ['site_meta.js'],
    sourceUrl: 'https://m3.material.io/site_meta.js',
    content: 'window.site_meta = {};',
    sourceMethod: 'static-plan',
  }, cacheDir);
  await upsertArtifactRecord(siteMeta, cacheDir);

  const bundle = await persistArtifact({
    kind: 'angular-bundle',
    pathParts: ['main.abc123.js'],
    sourceUrl: 'https://m3.material.io/main.abc123.js',
    content: 'console.log("carbonVersion")',
    sourceMethod: 'static-plan',
  }, cacheDir);
  await upsertArtifactRecord(bundle, cacheDir);

  await writeManifest(createCacheManifest({
    baseUrl: 'https://m3.material.io',
    carbonVersion: 'v123',
    siteMetaHash: siteMeta.sha256,
    angularBundleHash: bundle.sha256,
    sitemapHash: null,
  }), cacheDir);
}

describe('validateRawSnapshot', () => {
  it('passes when manifest hashes and raw artifact-index entries are all present', async () => {
    await writeFullSnapshot();
    const result = await validateRawSnapshot({ cacheDir });
    expect(result.passed).toBe(true);
    expect(result.reasons).toEqual([]);
  });

  it('fails when manifest.json is missing', async () => {
    const result = await validateRawSnapshot({ cacheDir });
    expect(result.passed).toBe(false);
    expect(result.reasons[0]).toMatch(/manifest\.json is missing/);
  });

  it('fails when carbonVersion is missing from the manifest', async () => {
    await writeFullSnapshot();
    await writeManifest(createCacheManifest({
      baseUrl: 'https://m3.material.io',
      carbonVersion: null,
      siteMetaHash: 'a'.repeat(64),
      angularBundleHash: 'b'.repeat(64),
    }), cacheDir);
    const result = await validateRawSnapshot({ cacheDir });
    expect(result.passed).toBe(false);
    expect(result.reasons.some((r) => r.includes('carbonVersion'))).toBe(true);
  });

  it('fails when the site-shell artifact is missing from raw/artifact-index.json', async () => {
    await writeFullSnapshot();
    // Overwrite the index with the site-shell entry removed.
    const { readArtifactIndex, writeArtifactIndex } = await import('../src/raw-artifacts/artifact-index.js');
    const index = await readArtifactIndex(cacheDir);
    await writeArtifactIndex({ artifacts: index.artifacts.filter((a) => a.kind !== 'site-shell') }, cacheDir);

    const result = await validateRawSnapshot({ cacheDir });
    expect(result.passed).toBe(false);
    expect(result.reasons.some((r) => r.includes('site-shell'))).toBe(true);
  });

  it('fails when siteMetaHash is missing from the manifest', async () => {
    await writeFullSnapshot();
    await writeManifest(createCacheManifest({
      baseUrl: 'https://m3.material.io',
      carbonVersion: 'v123',
      siteMetaHash: null,
      angularBundleHash: 'b'.repeat(64),
    }), cacheDir);
    const result = await validateRawSnapshot({ cacheDir });
    expect(result.passed).toBe(false);
    expect(result.reasons.some((r) => r.includes('siteMetaHash'))).toBe(true);
  });

  it('fails when angularBundleHash is missing from the manifest', async () => {
    await writeFullSnapshot();
    await writeManifest(createCacheManifest({
      baseUrl: 'https://m3.material.io',
      carbonVersion: 'v123',
      siteMetaHash: 'a'.repeat(64),
      angularBundleHash: null,
    }), cacheDir);
    const result = await validateRawSnapshot({ cacheDir });
    expect(result.passed).toBe(false);
    expect(result.reasons.some((r) => r.includes('angularBundleHash'))).toBe(true);
  });
});
