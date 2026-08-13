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
  cacheDir = await mkdtemp(path.join(tmpdir(), 'm3-docs-mcp-validate-sitemap-'));
});

afterEach(async () => {
  await rm(cacheDir, { recursive: true, force: true });
});

describe('validateRawSnapshot sitemap route source', () => {
  it('passes without site_meta when sitemap, shell and Angular bundle are complete', async () => {
    const shell = await persistArtifact({
      kind: 'site-shell',
      pathParts: ['shell.html'],
      sourceUrl: 'https://m3.material.io/',
      content: '<html></html>',
      sourceMethod: 'static-plan',
    }, cacheDir);
    await upsertArtifactRecord(shell, cacheDir);

    const sitemap = await persistArtifact({
      kind: 'sitemap',
      pathParts: ['sitemap.xml'],
      sourceUrl: 'https://m3.material.io/sitemap.xml',
      content: '<urlset><url><loc>https://m3.material.io/components/buttons</loc></url></urlset>',
      sourceMethod: 'static-plan',
    }, cacheDir);
    await upsertArtifactRecord(sitemap, cacheDir);

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
      siteMetaHash: null,
      angularBundleHash: bundle.sha256,
      sitemapHash: sitemap.sha256,
    }), cacheDir);

    const result = await validateRawSnapshot({ cacheDir });
    expect(result.passed).toBe(true);
    expect(result.reasons).toEqual([]);
  });

  it('fails when the manifest claims a sitemap route source but its raw artifact is absent', async () => {
    const shell = await persistArtifact({
      kind: 'site-shell',
      pathParts: ['shell.html'],
      sourceUrl: 'https://m3.material.io/',
      content: '<html></html>',
      sourceMethod: 'static-plan',
    }, cacheDir);
    await upsertArtifactRecord(shell, cacheDir);

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
      siteMetaHash: null,
      angularBundleHash: bundle.sha256,
      sitemapHash: 'a'.repeat(64),
    }), cacheDir);

    const result = await validateRawSnapshot({ cacheDir });
    expect(result.passed).toBe(false);
    expect(result.reasons.join('\n')).toMatch(/no sitemap artifact/i);
  });
});
