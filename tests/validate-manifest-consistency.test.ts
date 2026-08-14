import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  manifestPath,
  readManifest,
  readPersistedManifestCounts,
  writeManifest,
  type ManifestCounts,
} from '../src/manifest.js';
import { readArtifactIndex, upsertArtifactRecords } from '../src/raw-artifacts/artifact-index.js';
import { validateManifestConsistency } from '../src/validation/validate-manifest-consistency.js';
import { writeValidCacheV2Fixture } from './fixtures/cache-v2-fixture.js';

let cacheDir: string;

beforeEach(async () => {
  cacheDir = await mkdtemp(path.join(tmpdir(), 'm3-docs-mcp-manifest-consistency-'));
});

afterEach(async () => {
  await rm(cacheDir, { recursive: true, force: true });
});

const COUNT_KEYS: readonly (keyof ManifestCounts)[] = [
  'rawArtifacts',
  'routes',
  'pages',
  'markdownPages',
  'dsdbResources',
  'tokenTables',
];

async function writeDriftedCount(key: keyof ManifestCounts): Promise<void> {
  const manifest = await readManifest(cacheDir);
  if (!manifest) throw new Error('Fixture manifest is missing.');
  const driftedManifest = {
    ...manifest,
    counts: {
      ...manifest.counts,
      [key]: manifest.counts[key] + 1,
    },
  };
  // Deliberately bypass writeManifest so this helper isolates validator behavior from writer
  // schema validation. The resulting JSON is still schema-valid; only the persisted count
  // invariant is wrong.
  await writeFile(manifestPath(cacheDir), `${JSON.stringify(driftedManifest, null, 2)}\n`, 'utf8');
}

describe('validateManifestConsistency', () => {
  it('passes when every manifest count matches its persisted owner', async () => {
    await writeValidCacheV2Fixture(cacheDir);
    const result = await validateManifestConsistency({ cacheDir });
    expect(result.passed).toBe(true);
    expect(result.reasons).toEqual([]);
  });

  for (const key of COUNT_KEYS) {
    it(`fails when manifest.counts.${key} drifts from the persisted snapshot`, async () => {
      await writeValidCacheV2Fixture(cacheDir);
      await writeDriftedCount(key);

      const result = await validateManifestConsistency({ cacheDir });
      expect(result.passed).toBe(false);
      expect(result.reasons.some((reason) => reason.includes(`manifest.counts.${key}=`))).toBe(true);
    });
  }

  it('keeps writeManifest explicit and detects caller-supplied count drift instead of silently repairing it', async () => {
    await writeValidCacheV2Fixture(cacheDir);
    const manifest = await readManifest(cacheDir);
    if (!manifest) throw new Error('Fixture manifest is missing.');

    await writeManifest({
      ...manifest,
      counts: {
        ...manifest.counts,
        rawArtifacts: manifest.counts.rawArtifacts + 100,
      },
    }, cacheDir);

    expect((await readManifest(cacheDir))?.counts.rawArtifacts).toBe(manifest.counts.rawArtifacts + 100);
    const result = await validateManifestConsistency({ cacheDir });
    expect(result.passed).toBe(false);
    expect(result.reasons.some((reason) => reason.includes('manifest.counts.rawArtifacts='))).toBe(true);
  });

  it('repeated upserts of the same DSDB artifact id do not inflate canonical persisted counts', async () => {
    await writeValidCacheV2Fixture(cacheDir);
    const before = await readPersistedManifestCounts(cacheDir);
    const artifactIndex = await readArtifactIndex(cacheDir);
    const dsdbArtifact = artifactIndex.artifacts.find((artifact) => artifact.kind === 'dsdb-resource');
    if (!dsdbArtifact) throw new Error('Fixture DSDB artifact is missing.');

    await upsertArtifactRecords([dsdbArtifact, dsdbArtifact], cacheDir);

    const after = await readPersistedManifestCounts(cacheDir);
    expect(after).toEqual(before);
  });
});
