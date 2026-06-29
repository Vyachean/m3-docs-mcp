import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { artifactIndexPath, writeArtifactIndex } from '../src/raw-artifacts/artifact-index.js';
import type { ArtifactRecord } from '../src/raw-artifacts/artifact-types.js';
import { validateArtifactIndex } from '../src/validation/validate-artifact-index.js';

let cacheDir: string;

beforeEach(async () => {
  cacheDir = await mkdtemp(path.join(tmpdir(), 'm3-docs-mcp-validate-artifact-index-'));
});

afterEach(async () => {
  await rm(cacheDir, { recursive: true, force: true });
});

const RECORD: ArtifactRecord = {
  id: 'page-data:components/switch/specs',
  kind: 'page-data',
  sourceUrl: 'https://m3.material.io/components/switch/specs',
  localPath: 'raw/page-data/components/switch/specs.json',
  httpStatus: 200,
  contentType: 'application/json',
  sha256: 'a'.repeat(64),
  fetchedAt: '2026-06-01T00:00:00.000Z',
  sourceRoute: '/components/switch/specs',
  sourceMethod: 'static-plan',
  error: null,
  diagnostics: null,
};

describe('validateArtifactIndex', () => {
  it('fails when raw/artifact-index.json is missing', async () => {
    const result = await validateArtifactIndex({ cacheDir });
    expect(result.passed).toBe(false);
    expect(result.reasons[0]).toMatch(/no raw artifact records/);
  });

  it('fails when raw/artifact-index.json is an empty array', async () => {
    await writeArtifactIndex({ artifacts: [] }, cacheDir);
    const result = await validateArtifactIndex({ cacheDir });
    expect(result.passed).toBe(false);
  });

  it('passes when raw/artifact-index.json (written via writeArtifactIndex) has records', async () => {
    await writeArtifactIndex({ artifacts: [RECORD] }, cacheDir);
    const result = await validateArtifactIndex({ cacheDir });
    expect(result.passed).toBe(true);
  });

  it('passes for the current top-level array artifact index format read directly off disk', async () => {
    await mkdir(path.dirname(artifactIndexPath(cacheDir)), { recursive: true });
    await writeFile(artifactIndexPath(cacheDir), JSON.stringify([RECORD], null, 2), 'utf8');
    const result = await validateArtifactIndex({ cacheDir });
    expect(result.passed).toBe(true);
  });
});
