import { getDefaultCacheDir } from '../cache.js';
import { readArtifactIndex, findArtifactsByKind } from '../raw-artifacts/artifact-index.js';
import { readManifest } from '../manifest.js';
import { failedCheck, passedCheck, type CheckResult } from './types.js';

/**
 * Stage 1 of `verify:cache:full`: raw snapshot completeness.
 *
 * A valid deterministic snapshot always contains the site shell, Angular bundle and
 * carbonVersion. Route discovery must also be captured and hashed: current Material snapshots use
 * sitemap.xml, while older snapshots may still contain site_meta.js. When both are available both
 * are checked, so accepting the current format does not weaken the snapshot-integrity boundary.
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
  if (!manifest.siteMetaHash && !manifest.sitemapHash) {
    reasons.push('manifest has no hashed route-discovery source (siteMetaHash or sitemapHash).');
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
  if (siteMetaArtifacts.length === 0 && sitemapArtifacts.length === 0) {
    reasons.push('raw/artifact-index.json has no route-discovery artifact (site-meta or sitemap) recorded.');
  }
  if (manifest.siteMetaHash && siteMetaArtifacts.length === 0) {
    reasons.push('manifest.siteMetaHash is present but raw/artifact-index.json has no site-meta artifact recorded.');
  }
  if (manifest.sitemapHash && sitemapArtifacts.length === 0) {
    reasons.push('manifest.sitemapHash is present but raw/artifact-index.json has no sitemap artifact recorded.');
  }
  if (!manifest.siteMetaHash && siteMetaArtifacts.length > 0) {
    reasons.push('raw/artifact-index.json has a site-meta artifact but manifest.siteMetaHash is missing.');
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
  });
}
