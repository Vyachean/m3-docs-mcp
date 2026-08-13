import { getDefaultCacheDir } from '../cache.js';
import { readArtifactIndex, findArtifactsByKind } from '../raw-artifacts/artifact-index.js';
import { readManifest } from '../manifest.js';
import { failedCheck, passedCheck, type CheckResult } from './types.js';

/**
 * Stage 1 of `verify:cache:full`: raw snapshot completeness.
 *
 * Confirms the foundational raw snapshot is complete: site shell, Angular bundle,
 * carbonVersion, and at least one deterministic public route source (`site_meta.js` or
 * `sitemap.xml`). Everything else assumes the raw snapshot underneath it actually exists,
 * so a failure here stops the pipeline before later, more expensive checks run.
 *
 * `carbonVersion` itself is not a raw artifact kind — it is recorded directly on the manifest.
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
  if (!manifest.angularBundleHash) {
    reasons.push('manifest.angularBundleHash is missing (Angular main bundle was not hashed).');
  }

  const siteShellArtifacts = findArtifactsByKind(artifactIndex, 'site-shell');
  const siteMetaArtifacts = findArtifactsByKind(artifactIndex, 'site-meta');
  const sitemapArtifacts = findArtifactsByKind(artifactIndex, 'sitemap');
  const angularBundleArtifacts = findArtifactsByKind(artifactIndex, 'angular-bundle');

  if (siteShellArtifacts.length === 0) {
    reasons.push('raw/artifact-index.json has no site-shell artifact recorded.');
  }
  if (angularBundleArtifacts.length === 0) {
    reasons.push('raw/artifact-index.json has no angular-bundle artifact recorded.');
  }

  const siteMetaSourceComplete = Boolean(manifest.siteMetaHash) && siteMetaArtifacts.length > 0;
  const sitemapSourceComplete = Boolean(manifest.sitemapHash) && sitemapArtifacts.length > 0;
  if (!siteMetaSourceComplete && !sitemapSourceComplete) {
    reasons.push('No complete deterministic route-source snapshot is recorded: require site_meta.js or sitemap.xml with both manifest hash and raw artifact.');
  }

  if (manifest.siteMetaHash && siteMetaArtifacts.length === 0) {
    reasons.push('manifest.siteMetaHash is set but raw/artifact-index.json has no site-meta artifact recorded.');
  }
  if (!manifest.siteMetaHash && siteMetaArtifacts.length > 0) {
    reasons.push('raw/artifact-index.json has a site-meta artifact but manifest.siteMetaHash is missing.');
  }
  if (manifest.sitemapHash && sitemapArtifacts.length === 0) {
    reasons.push('manifest.sitemapHash is set but raw/artifact-index.json has no sitemap artifact recorded.');
  }
  if (!manifest.sitemapHash && sitemapArtifacts.length > 0) {
    reasons.push('raw/artifact-index.json has a sitemap artifact but manifest.sitemapHash is missing.');
  }

  for (const artifact of [...siteShellArtifacts, ...siteMetaArtifacts, ...sitemapArtifacts, ...angularBundleArtifacts]) {
    if (!artifact.sha256) {
      reasons.push(`Artifact ${artifact.id} (${artifact.kind}) is missing a sha256 hash.`);
    }
  }

  if (reasons.length > 0) {
    return failedCheck(stage, reasons, {
      carbonVersion: manifest.carbonVersion,
      siteShellArtifactCount: siteShellArtifacts.length,
      siteMetaArtifactCount: siteMetaArtifacts.length,
      sitemapArtifactCount: sitemapArtifacts.length,
      angularBundleArtifactCount: angularBundleArtifacts.length,
    });
  }

  return passedCheck(stage, {
    carbonVersion: manifest.carbonVersion,
    rawArtifactCount: artifactIndex.artifacts.length,
    routeSource: siteMetaSourceComplete ? 'site-meta' : 'sitemap',
  });
}
