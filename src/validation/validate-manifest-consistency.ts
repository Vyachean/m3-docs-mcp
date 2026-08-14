import { getDefaultCacheDir } from '../cache.js';
import { readManifest, readPersistedManifestCounts, type ManifestCounts } from '../manifest.js';
import { failedCheck, passedCheck, type CheckResult } from './types.js';

/**
 * Cross-layer cache invariant: manifest.counts must describe the final persisted cache owners,
 * not crawl-time persistence attempts or reference occurrences.
 *
 * Count derivation stays owned by manifest.ts (`readPersistedManifestCounts`) so generation and
 * validation cannot drift into two independent definitions of what each manifest count means.
 */
export type ValidateManifestConsistencyInput = {
  cacheDir?: string;
};

const COUNT_KEYS: readonly (keyof ManifestCounts)[] = [
  'rawArtifacts',
  'routes',
  'pages',
  'markdownPages',
  'dsdbResources',
  'tokenTables',
];

export async function validateManifestConsistency(
  input: ValidateManifestConsistencyInput = {}
): Promise<CheckResult> {
  const cacheDir = input.cacheDir ?? getDefaultCacheDir();
  const stage = 'manifest-consistency';
  const [manifest, persistedCounts] = await Promise.all([
    readManifest(cacheDir),
    readPersistedManifestCounts(cacheDir),
  ]);

  if (!manifest) {
    return failedCheck(stage, ['manifest.json is missing or failed schema validation.']);
  }
  if (!persistedCounts) {
    return failedCheck(stage, [
      'Cannot derive persisted manifest counts because index.json or one of the canonical graph files is missing or invalid.',
    ]);
  }

  const reasons: string[] = [];
  for (const key of COUNT_KEYS) {
    const declared = manifest.counts[key];
    const persisted = persistedCounts[key];
    if (declared !== persisted) {
      reasons.push(`manifest.counts.${key}=${declared} does not match persisted ${key}=${persisted}.`);
    }
  }

  if (reasons.length > 0) {
    return failedCheck(stage, reasons, {
      manifestCounts: manifest.counts,
      persistedCounts,
    });
  }

  return passedCheck(stage, { counts: persistedCounts });
}
