import { getDefaultCacheDir } from '../cache.js';
import { readManifest } from '../manifest.js';
import { failedCheck, passedCheck, type CheckResult } from './types.js';

/**
 * `validate-cache` manifest health gate: `manifest.json`'s `health` summary must report
 * `"verified"` for all four stages (rawSnapshot/graph/markdown/coverage) the crawler's
 * `--strict-graph` promotion is documented to set on a successful full run (AGENTS.md "Cache
 * promotion is strict..."). `"unverified"` always means "validation hasn't run" (never a stand-in
 * for verified), and `"partial"`/`"degraded"`/`"failed"` are real health regressions — none of
 * those are acceptable for a cache this command is meant to certify as production-ready.
 */

export type ValidateManifestHealthInput = {
  cacheDir?: string;
};

export async function validateManifestHealth(input: ValidateManifestHealthInput = {}): Promise<CheckResult> {
  const cacheDir = input.cacheDir ?? getDefaultCacheDir();
  const stage = 'manifest-health';

  const manifest = await readManifest(cacheDir);
  if (!manifest) {
    return failedCheck(stage, ['manifest.json is missing or failed schema validation.']);
  }

  const reasons: string[] = [];
  for (const [key, value] of Object.entries(manifest.health)) {
    if (value !== 'verified') {
      reasons.push(`manifest.health.${key} is "${value}" (expected "verified").`);
    }
  }

  if (reasons.length > 0) {
    return failedCheck(stage, reasons, { health: manifest.health });
  }
  return passedCheck(stage, { health: manifest.health });
}
