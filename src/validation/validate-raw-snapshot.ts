import { getDefaultCacheDir } from '../cache.js';
import { readArtifactIndex, findArtifactsByKind } from '../raw-artifacts/artifact-index.js';
import { readManifest } from '../manifest.js';
import { failedCheck, passedCheck, type CheckResult } from './types.js';

/**
 * Stage 1 of `verify:cache:full`: raw snapshot completeness.
 *
 * Confirms the four foundational raw artifacts (site shell, site_meta, Angular bundle,
 * carbonVersion) are present and hashed, both in `manifest.json` and in
 * `raw/artifact-index.json`. This is the first gate in the documented 1-7 verification order —
 * everything else (route graph, browser oracle parity, structured graph, rendered Markdown)
 * assumes the raw snapshot underneath it actually exists, so a failure here should stop the
 * pipeline before any later, more expensive check runs.
 *
 * `carbonVersion` itself is not a raw artifact kind (see raw-artifacts/artifact-types.ts's
 * ArtifactKindSchema) — it is a string recorded directly on the manifest — so its presence check
 * reads `manifest.carbonVersion` rather than looking for an artifact-index entry.
 */

export type ValidateRawSnapshotInput = {
  cacheDir?: string;
};

export async function validateRawSnapshot(input: ValidateRawSnapshotInput = {}): Promise<CheckResult> {
  const cacheDir = input.cacheDir ?? getDefaultCacheDir();
  const stage = 'raw-snapshot';

  const manifest = await readManifest(cacheDir);
  if (!manifest) {
    return failedCheck(stage, ['manifest.json is missing or failed schema validation.']);
  }

  const artifactIndex = await readArtifactIndex(cacheDir);
  const reasons: string[] = [];

  if (!manifest.carbonVersion) {
    reasons.push('manifest.carbonVersion is missing (Angular bundle carbonVersion was not recorded).');
  }
  if (!manifest.siteMetaHash) {
    reasons.push('manifest.siteMetaHash is missing (site_meta.js was not hashed).');
  }
  if (!manifest.angularBundleHash) {
    reasons.push('manifest.angularBundleHash is missing (Angular main bundle was not hashed).');
  }

  const siteShellArtifacts = findArtifactsByKind(artifactIndex, 'site-shell');
  if (siteShellArtifacts.length === 0) {
    reasons.push('raw/artifact-index.json has no site-shell artifact recorded.');
  }
  const siteMetaArtifacts = findArtifactsByKind(artifactIndex, 'site-meta');
  if (siteMetaArtifacts.length === 0) {
    reasons.push('raw/artifact-index.json has no site-meta artifact recorded.');
  }
  const angularBundleArtifacts = findArtifactsByKind(artifactIndex, 'angular-bundle');
  if (angularBundleArtifacts.length === 0) {
    reasons.push('raw/artifact-index.json has no angular-bundle artifact recorded.');
  }

  for (const artifact of [...siteShellArtifacts, ...siteMetaArtifacts, ...angularBundleArtifacts]) {
    if (!artifact.sha256) {
      reasons.push(`Artifact ${artifact.id} (${artifact.kind}) is missing a sha256 hash.`);
    }
  }

  if (reasons.length > 0) {
    return failedCheck(stage, reasons, {
      carbonVersion: manifest.carbonVersion,
      siteShellArtifactCount: siteShellArtifacts.length,
      siteMetaArtifactCount: siteMetaArtifacts.length,
      angularBundleArtifactCount: angularBundleArtifacts.length,
    });
  }

  return passedCheck(stage, {
    carbonVersion: manifest.carbonVersion,
    rawArtifactCount: artifactIndex.artifacts.length,
  });
}
