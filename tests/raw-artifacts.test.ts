import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  artifactId,
  artifactLocalPath,
  persistArtifact,
  readArtifactContent,
  readArtifactText,
} from '../src/raw-artifacts/artifact-store.js';
import {
  findArtifactById,
  findArtifactsByKind,
  findArtifactsBySourceRoute,
  readArtifactIndex,
  upsertArtifactRecord,
} from '../src/raw-artifacts/artifact-index.js';
import { sha256Hex } from '../src/raw-artifacts/hash.js';
import { createCacheManifest, readManifest, writeManifest } from '../src/manifest.js';

let cacheDir: string;

beforeEach(async () => {
  cacheDir = await mkdtemp(path.join(tmpdir(), 'm3-docs-mcp-raw-artifacts-'));
});

afterEach(async () => {
  await rm(cacheDir, { recursive: true, force: true });
});

describe('hash.ts', () => {
  it('computes a stable lowercase hex sha-256 digest for strings and buffers', () => {
    const text = 'hello world';
    const fromString = sha256Hex(text);
    const fromBuffer = sha256Hex(Buffer.from(text, 'utf8'));
    expect(fromString).toMatch(/^[a-f0-9]{64}$/);
    expect(fromString).toBe(fromBuffer);
  });
});

describe('artifact-store.ts + artifact-index.ts + manifest.ts round trip', () => {
  it('persists a synthetic page-data artifact, indexes it, and reads it back', async () => {
    const sourceUrl = 'https://m3.material.io/page-data/components/buttons/specs/page-data.json';
    const content = JSON.stringify({ result: { pageContext: { title: 'Buttons' } } });

    const record = await persistArtifact(
      {
        kind: 'page-data',
        pathParts: ['collection-1', 'document-1'],
        sourceUrl,
        content,
        httpStatus: 200,
        contentType: 'application/json',
        sourceRoute: 'components/buttons/specs',
        sourceMethod: 'static-plan',
      },
      cacheDir
    );

    expect(record.kind).toBe('page-data');
    expect(record.localPath).toBe(artifactLocalPath('page-data', ['collection-1', 'document-1']));
    expect(record.id).toBe(artifactId('page-data', record.localPath));
    expect(record.sha256).toBe(sha256Hex(content));
    expect(record.sourceRoute).toBe('components/buttons/specs');
    expect(record.sourceMethod).toBe('static-plan');
    expect(record.error).toBeNull();

    // Round-trip the raw content back from disk.
    const readBackText = await readArtifactText(record.localPath, cacheDir);
    expect(readBackText).toBe(content);
    const readBackBuffer = await readArtifactContent(record.localPath, cacheDir);
    expect(readBackBuffer.toString('utf8')).toBe(content);

    // The file actually exists at the documented raw/** layout path.
    const onDisk = await readFile(path.join(cacheDir, 'raw', 'page-data', 'collection-1', 'document-1.json'), 'utf8');
    expect(onDisk).toBe(content);

    // Index the record and verify it is queryable by id, kind, and source route.
    const index = await upsertArtifactRecord(record, cacheDir);
    expect(index.artifacts).toHaveLength(1);
    expect(findArtifactById(index, record.id)).toEqual(record);
    expect(findArtifactsByKind(index, 'page-data')).toEqual([record]);
    expect(findArtifactsBySourceRoute(index, 'components/buttons/specs')).toEqual([record]);
    expect(findArtifactsByKind(index, 'dsdb-resource')).toEqual([]);

    // The index also round-trips through disk independently of upsert's return value.
    const reloadedIndex = await readArtifactIndex(cacheDir);
    expect(reloadedIndex.artifacts).toEqual([record]);

    // A second artifact persists alongside the first without clobbering it.
    const secondRecord = await persistArtifact(
      {
        kind: 'dsdb-resource',
        pathParts: ['carbon-v1', 'resource-42'],
        sourceUrl: 'https://m3.material.io/_dsm/content/m3/carbon-v1/resource-42',
        content: Buffer.from('{"resource":true}', 'utf8'),
        sourceMethod: 'browser-capture',
      },
      cacheDir
    );
    const indexWithTwo = await upsertArtifactRecord(secondRecord, cacheDir);
    expect(indexWithTwo.artifacts).toHaveLength(2);
    expect(findArtifactsByKind(indexWithTwo, 'dsdb-resource')).toEqual([secondRecord]);

    // Re-persisting + upserting the same id (kind+localPath) replaces rather than duplicates.
    const updatedFirstRecord = await persistArtifact(
      {
        kind: 'page-data',
        pathParts: ['collection-1', 'document-1'],
        sourceUrl,
        content: `${content} `,
        sourceMethod: 'static-plan',
      },
      cacheDir
    );
    const finalIndex = await upsertArtifactRecord(updatedFirstRecord, cacheDir);
    expect(finalIndex.artifacts).toHaveLength(2);
    expect(findArtifactById(finalIndex, updatedFirstRecord.id)?.sha256).toBe(updatedFirstRecord.sha256);
  });

  it('writes and reads back a cache schema v2 manifest with placeholder health/counts', async () => {
    const manifest = createCacheManifest({
      baseUrl: 'https://m3.material.io',
      carbonVersion: 'carbon-v1',
      siteMetaHash: sha256Hex('site_meta'),
      angularBundleHash: sha256Hex('bundle'),
      counts: { rawArtifacts: 2 },
    });

    expect(manifest.schemaVersion).toBe(2);
    expect(manifest.counts.rawArtifacts).toBe(2);
    expect(manifest.counts.routes).toBe(0);
    expect(manifest.health.graph).toBe('unverified');

    await writeManifest(manifest, cacheDir);
    const reread = await readManifest(cacheDir);
    expect(reread).toEqual(manifest);

    const onDisk = JSON.parse(await readFile(path.join(cacheDir, 'manifest.json'), 'utf8'));
    expect(onDisk.schemaVersion).toBe(2);
  });

  it('readManifest returns null when no manifest exists yet', async () => {
    expect(await readManifest(cacheDir)).toBeNull();
  });
});
