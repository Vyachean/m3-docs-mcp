import { getDefaultCacheDir } from '../cache.js';
import { readArtifactIndex } from '../raw-artifacts/artifact-index.js';
import { failedCheck, passedCheck, type CheckResult } from './types.js';

/**
 * `validate-cache` raw artifact index gate: reads `raw/artifact-index.json` through the
 * MCP-owned `readArtifactIndex`/`ArtifactRecordListSchema` (raw-artifacts/artifact-index.ts,
 * artifact-types.ts) rather than re-implementing a parser, per the task's "do not duplicate
 * assumptions from m3-docs-cache" requirement. `readArtifactIndex` already accepts the actual
 * current top-level-array MCP format and returns an empty list on any read/parse failure, so an
 * empty list here covers both "file missing/invalid" and "file valid but recorded zero artifacts"
 * — both are real failures for a cache meant to be promoted to production.
 */

export type ValidateArtifactIndexInput = {
  cacheDir?: string;
};

export async function validateArtifactIndex(input: ValidateArtifactIndexInput = {}): Promise<CheckResult> {
  const cacheDir = input.cacheDir ?? getDefaultCacheDir();
  const stage = 'artifact-index';

  const index = await readArtifactIndex(cacheDir);
  if (index.artifacts.length === 0) {
    return failedCheck(stage, ['raw/artifact-index.json has no raw artifact records (missing, invalid, or empty).']);
  }
  return passedCheck(stage, { rawArtifactCount: index.artifacts.length });
}
